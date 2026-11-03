/**
 * Excalidrawカードビューのユーティリティ関数（utils.ts）に対するテストコード。
 * 簡易ハッシュ生成、キャッシュファイル名解決、古いキャッシュの自動クリーンアップ処理、
 * および「画像一覧」統合ビューのタブごとのファイルフィルタリングについて
 * 期待される動作と入出力アサーションをテストします。
 *
 * キャッシュ保存先: Vaultルート直下の `.excalidraw-cache/` ディレクトリ
 * （Obsidian Vault Adapter API が確実に読み書きできるパス）
 **/
import { test } from "node:test";
import assert from "node:assert/strict";
import { getStringHash, getCacheFilePath, CACHE_DIR, cleanOldCaches, filterFilesByTab, getDragText, deduplicateFilesByPath, isDioFile, buildBacklinkPathMap, filterExcalidrawFiles, removeFileByPath } from "./utils";

test("CACHE_DIR - Vaultルート直下の隠しフォルダであること", () => {
    assert.equal(CACHE_DIR, ".excalidraw-cache");
});

test("getStringHash - 文字列から一意なハッシュが生成されること", () => {
    const path1 = "01_data/2026/05/29/test.excalidraw.md";
    const path2 = "01_data/2026/05/29/test.excalidraw.md";
    const path3 = "01_data/2026/05/29/other.excalidraw.md";

    const hash1 = getStringHash(path1);
    const hash2 = getStringHash(path2);
    const hash3 = getStringHash(path3);

    // 同じパスなら同じハッシュになること
    assert.equal(hash1, hash2);
    
    // 異なるパスなら異なるハッシュになること
    assert.notEqual(hash1, hash3);
    
    // 英数字のみで構成されていること（ファイル名に安全に使えること）
    assert.match(hash1, /^[a-f0-9]+$/);
});

test("getCacheFilePath - .excalidraw-cache/ 配下にキャッシュパスが組み立てられること", () => {
    const filePath = "01_data/図1.excalidraw.md";
    const mtime = 1716948000000;

    const cachePath = getCacheFilePath(filePath, mtime);
    
    const hash = getStringHash(filePath);
    const expected = `.excalidraw-cache/${hash}_${mtime}_preview.png`;
    
    assert.equal(cachePath, expected);
});

test("getCacheFilePath - manifestDir引数を受け取らず、常にCACHE_DIRを使うこと", () => {
    const filePath = "01_data/test.excalidraw.md";
    const mtime = 12345;

    const cachePath = getCacheFilePath(filePath, mtime);
    
    // パスが必ず .excalidraw-cache/ で始まること
    assert.ok(cachePath.startsWith(".excalidraw-cache/"));
});

// 古いキャッシュ削除処理のモックテスト
test("cleanOldCaches - 指定されたハッシュを持つ古いキャッシュファイルが正しく削除されること", async () => {
    const targetHash = getStringHash("01_data/test.excalidraw.md");
    const currentMtime = 2000;
    
    // ダミーのファイル構造
    const existingFiles = [
        `${CACHE_DIR}/${targetHash}_1000.png`,         // 旧高解像度キャッシュ（削除対象）
        `${CACHE_DIR}/${targetHash}_1000_thumb.png`,   // 旧サムネイル（削除対象）
        `${CACHE_DIR}/${targetHash}_1000.svg`,         // 旧SVG fallback（削除対象）
        `${CACHE_DIR}/${targetHash}_2000.png`,         // 同mtimeでも旧高解像度キャッシュ（削除対象）
        `${CACHE_DIR}/${targetHash}_2000_thumb.png`,   // 同mtimeでも旧サムネイル（削除対象）
        `${CACHE_DIR}/${targetHash}_2000_preview.png`, // 現行の一覧キャッシュ（残す）
        `${CACHE_DIR}/anotherhash_1000.png`            // 他のファイルのキャッシュ（残す）
    ];
    
    const deletedFiles: string[] = [];
    
    // Obsidian Vault Adapter のダミーモック
    const mockAdapter = {
        async exists(path: string): Promise<boolean> {
            return path === CACHE_DIR;
        },
        async list(path: string): Promise<{ files: string[] }> {
            return { files: existingFiles };
        },
        async remove(path: string): Promise<void> {
            deletedFiles.push(path);
        }
    };

    await cleanOldCaches(mockAdapter, targetHash, currentMtime);

    // 現行の一覧キャッシュ以外が削除されること
    assert.deepEqual(deletedFiles.sort(), [
        `${CACHE_DIR}/${targetHash}_1000.png`,
        `${CACHE_DIR}/${targetHash}_1000_thumb.png`,
        `${CACHE_DIR}/${targetHash}_1000.svg`,
        `${CACHE_DIR}/${targetHash}_2000.png`,
        `${CACHE_DIR}/${targetHash}_2000_thumb.png`
    ].sort());
});

test("cleanOldCaches - キャッシュディレクトリが存在しない場合はエラーなく終了すること", async () => {
    const targetHash = getStringHash("01_data/nonexistent.excalidraw.md");
    
    const mockAdapter = {
        async exists(_path: string): Promise<boolean> {
            return false;
        },
        async list(_path: string): Promise<{ files: string[] }> {
            throw new Error("should not be called");
        },
        async remove(_path: string): Promise<void> {
            throw new Error("should not be called");
        }
    };

    // エラーが発生しないこと
    await cleanOldCaches(mockAdapter, targetHash, 1000);
});

test("filterFilesByTab - 各タブに応じたフィルタリングが正しく機能すること", () => {
    const mockFiles = [
        { path: "01_data/design1.excalidraw.md", name: "design1.excalidraw.md" },
        { path: "01_data/edinet_excalidraw.md", name: "edinet_excalidraw.md" }, // _excalidraw.md 形式
        { path: "01_data/photo.png", name: "photo.png" },
        { path: "01_data/common_image/shared.jpg", name: "shared.jpg" },
        { path: "01_data/common_image/diagram.excalidraw.md", name: "diagram.excalidraw.md" },
        { path: "01_data/flow.dio", name: "flow.dio" },
        { path: "01_data/flow2.dio.svg", name: "flow2.dio.svg" },
        { path: "01_data/diagram.drawio", name: "diagram.drawio" },
        { path: "01_data/diagram2.drawio.svg", name: "diagram2.drawio.svg" },
        { path: "other_folder/outside.png", name: "outside.png" },
    ];

    // 「すべて」タブ: 01_data配下の画像、excalidraw、dioすべて
    const allResult = filterFilesByTab(mockFiles, "all");
    assert.deepEqual(allResult.map(f => f.name), [
        "design1.excalidraw.md",
        "edinet_excalidraw.md",
        "photo.png",
        "shared.jpg",
        "diagram.excalidraw.md",
        "flow.dio",
        "flow2.dio.svg",
        "diagram.drawio",
        "diagram2.drawio.svg"
    ]);

    // 「Excalidraw」タブ: .excalidraw.md または _excalidraw.md のみ
    const excalidrawResult = filterFilesByTab(mockFiles, "excalidraw");
    assert.deepEqual(excalidrawResult.map(f => f.name), [
        "design1.excalidraw.md",
        "edinet_excalidraw.md",
        "diagram.excalidraw.md"
    ]);

    // 「共有画像」タブ: 01_data/common_image配下の画像とexcalidrawすべて
    const commonResult = filterFilesByTab(mockFiles, "common");
    assert.deepEqual(commonResult.map(f => f.name), [
        "shared.jpg",
        "diagram.excalidraw.md"
    ]);

    // 「画像」タブ: 01_data配下の画像のみ（excalidrawおよびdio関連ファイルは除く）
    const imageResult = filterFilesByTab(mockFiles, "image");
    assert.deepEqual(imageResult.map(f => f.name), [
        "photo.png",
        "shared.jpg"
    ]);

    // 「dio」タブ: .dio, .dio.svg, .drawio, .drawio.svg のみ
    const dioResult = filterFilesByTab(mockFiles, "dio");
    assert.deepEqual(dioResult.map(f => f.name), [
        "flow.dio",
        "flow2.dio.svg",
        "diagram.drawio",
        "diagram2.drawio.svg"
    ]);

    // 「紐づきのない画像」タブ: 01_data配下の画像とexcalidrawのうち、他からリンクされていないもの
    const mockMetadataCache = {
        resolvedLinks: {
            "note1.md": {
                "01_data/photo.png": 1,
                "01_data/common_image/diagram.excalidraw.md": 1
            }
        },
        unresolvedLinks: {}
    };
    const unlinkedResult = filterFilesByTab(mockFiles, "unlinked", mockMetadataCache);
    assert.deepEqual(unlinkedResult.map(f => f.name), [
        "design1.excalidraw.md",
        "edinet_excalidraw.md",
        "flow.dio",
        "flow2.dio.svg",
        "diagram.drawio",
        "diagram2.drawio.svg"
    ]);
});

test("buildBacklinkPathMap - resolvedLinks と unresolvedLinks を一括で逆引きできること", () => {
    const mockMetadataCache = {
        resolvedLinks: {
            "note1.md": {
                "01_data/a.excalidraw.md": 1
            }
        },
        unresolvedLinks: {
            "note2.md": {
                "b.excalidraw": 1
            }
        },
        getFirstLinkpathDest(linkpath: string, _sourcePath: string) {
            if (linkpath === "b.excalidraw") {
                return { path: "01_data/b.excalidraw.md" };
            }
            return null;
        }
    };

    const backlinkMap = buildBacklinkPathMap(mockMetadataCache, [
        "01_data/a.excalidraw.md",
        "01_data/b.excalidraw.md"
    ]);

    assert.deepEqual(backlinkMap.get("01_data/a.excalidraw.md"), ["note1.md"]);
    assert.deepEqual(backlinkMap.get("01_data/b.excalidraw.md"), ["note2.md"]);
});

test("buildBacklinkPathMap - 対象外の未解決リンクでは解決処理を呼ばないこと", () => {
    let resolveCallCount = 0;
    const mockMetadataCache = {
        resolvedLinks: {},
        unresolvedLinks: {
            "note1.md": {
                "unrelated-link": 1,
                "another-unrelated-link": 1
            }
        },
        getFirstLinkpathDest(_linkpath: string, _sourcePath: string) {
            resolveCallCount += 1;
            return null;
        }
    };

    const backlinkMap = buildBacklinkPathMap(mockMetadataCache, ["01_data/a.excalidraw.md"]);
    assert.equal(backlinkMap.size, 0);
    assert.equal(resolveCallCount, 0);
});

test("filterExcalidrawFiles - 渡されたバックリンクMapを使ってタグフィルターできること", () => {
    const files = [
        { path: "01_data/a.excalidraw.md", name: "a.excalidraw.md" },
        { path: "01_data/b.excalidraw.md", name: "b.excalidraw.md" }
    ];
    const mockMetadataCache = {
        getFileCache(file: { path: string }) {
            if (file.path === "note-parent.md") {
                return { tags: [{ tag: "#project" }] };
            }
            return {};
        }
    };
    const backlinkMap = new Map<string, string[]>([
        ["01_data/a.excalidraw.md", ["note-parent.md"]]
    ]);

    const result = filterExcalidrawFiles(files, mockMetadataCache, "", "#project", backlinkMap);
    assert.deepEqual(result.map(file => file.path), ["01_data/a.excalidraw.md"]);
});

test("getDragText - Excalidrawファイルの場合はWebアプリへのリンク付きの埋め込みマークダウンを返すこと", () => {
    const file = {
        extension: "md",
        name: "test.excalidraw.md",
        basename: "test.excalidraw",
        path: "01_data/test.excalidraw.md"
    };
    const basePath = "/Users/test/vault";
    const result = getDragText(file, basePath);
    
    assert.ok(result.includes("http://localhost:3001/?filepath="));
    assert.ok(result.includes("![[test.excalidraw|1475]]"));
});

test("getDragText - WindowsスタイルのbasePathでもWebアプリへのリンクが正しいスラッシュ区切りでエンコードされること", () => {
    const file = {
        extension: "md",
        name: "test.excalidraw.md",
        basename: "test.excalidraw",
        path: "01_data/test.excalidraw.md"
    };
    const basePath = "C:\\Users\\test\\vault";
    const result = getDragText(file, basePath);
    
    // スラッシュ区切りに統一されてエンコードされていることを確認
    // C:\Users\test\vault/01_data/test.excalidraw.md が C:/Users/test/vault/01_data/test.excalidraw.md になり、
    // セグメントごとにエンコードされるため、以下のようになるはず
    // C%3A / Users / test / vault / 01_data / test.excalidraw.md
    assert.ok(result.includes("http://localhost:3001/?filepath=C%3A/Users/test/vault/01_data/test.excalidraw.md"));
});

test("getDragText - _excalidraw.md形式の場合もWebアプリへのリンク付きの埋め込みマークダウンを返すこと", () => {
    const file = {
        extension: "md",
        name: "edinet_excalidraw.md",
        basename: "edinet_excalidraw",
        path: "01_data/edinet_excalidraw.md"
    };
    const basePath = "/Users/test/vault";
    const result = getDragText(file, basePath);
    
    assert.ok(result.includes("http://localhost:3001/?filepath="));
    assert.ok(result.includes("![[edinet_excalidraw|1475]]"));
});

test("getDragText - 画像ファイルの場合は単純な埋め込みマークダウンのみを返すこと", () => {
    const file = {
        extension: "png",
        name: "photo.png",
        basename: "photo",
        path: "01_data/photo.png"
    };
    const basePath = "/Users/test/vault";
    const result = getDragText(file, basePath);
    
    assert.equal(result, "![[photo.png]]");
});

test("getDragText - dioファイルの場合は単純な埋め込みマークダウンのみを返すこと", () => {
    const file = {
        extension: "dio",
        name: "flow.dio",
        basename: "flow",
        path: "01_data/flow.dio"
    };
    const basePath = "/Users/test/vault";
    const result = getDragText(file, basePath);
    
    assert.equal(result, "![[flow.dio]]");
});


test("deduplicateFilesByPath - パスが重複する要素を除外し、最初の要素を優先して順序を維持すること", () => {
    const input = [
        { path: "01_data/image1.png", name: "image1.png" },
        { path: "01_data/image2.png", name: "image2.png" },
        { path: "01_data/image1.png", name: "image1.png (duplicate)" },
        { path: "01_data/image3.png", name: "image3.png" },
        { path: "01_data/image2.png", name: "image2.png (duplicate)" }
    ];

    const result = deduplicateFilesByPath(input);

    assert.deepEqual(result, [
        { path: "01_data/image1.png", name: "image1.png" },
        { path: "01_data/image2.png", name: "image2.png" },
        { path: "01_data/image3.png", name: "image3.png" }
    ]);
});

test("isDioFile - .dio, .dio.svg, .drawio, .drawio.svg を正しく判定すること", () => {
    assert.equal(isDioFile("test.dio"), true);
    assert.equal(isDioFile("test.dio.svg"), true);
    assert.equal(isDioFile("test.drawio"), true);
    assert.equal(isDioFile("test.drawio.svg"), true);
    assert.equal(isDioFile("test.png"), false);
    assert.equal(isDioFile("test.excalidraw.md"), false);
});

test("filterFilesByTab - Windowsのパス区切り（バックスラッシュ）でも正しく機能すること", () => {
    const mockFiles = [
        { path: "01_data\\photo.png", name: "photo.png" },
        { path: "01_data\\common_image\\shared.jpg", name: "shared.jpg" },
        { path: "01_data\\design1.excalidraw.md", name: "design1.excalidraw.md" },
    ];

    const imageResult = filterFilesByTab(mockFiles, "image");
    assert.deepEqual(imageResult.map(f => f.name), [
        "photo.png",
        "shared.jpg"
    ]);

    const commonResult = filterFilesByTab(mockFiles, "common");
    assert.deepEqual(commonResult.map(f => f.name), [
        "shared.jpg"
    ]);
});

test("removeFileByPath - 指定したパスのファイルをリストから正しく除外すること", () => {
    const files = [
        { path: "01_data/2026/08/24/img1.png", name: "img1.png" },
        { path: "01_data/2026/08/24/img2.png", name: "img2.png" },
        { path: "01_data/common_image/shared.png", name: "shared.png" },
    ];

    const result = removeFileByPath(files, "01_data/2026/08/24/img2.png");
    assert.equal(result.length, 2);
    assert.deepEqual(result.map(f => f.name), ["img1.png", "shared.png"]);
});

test("removeFileByPath - Windows形式のパス区切り（バックスラッシュ）でも正しく除外されること", () => {
    const files = [
        { path: "01_data/2026/08/24/img1.png", name: "img1.png" },
        { path: "01_data\\2026\\08\\24\\img2.png", name: "img2.png" },
    ];

    // スラッシュ区切りで削除指定
    const result1 = removeFileByPath(files, "01_data/2026/08/24/img2.png");
    assert.equal(result1.length, 1);
    assert.equal(result1[0].name, "img1.png");

    // バックスラッシュ区切りで削除指定
    const result2 = removeFileByPath(files, "01_data\\2026\\08\\24\\img1.png");
    assert.equal(result2.length, 1);
    assert.equal(result2[0].name, "img2.png");
});

test("removeFileByPath - 存在しないパスを指定した場合はリストがそのまま返ること", () => {
    const files = [
        { path: "01_data/img1.png", name: "img1.png" },
    ];

    const result = removeFileByPath(files, "01_data/nonexistent.png");
    assert.equal(result.length, 1);
    assert.deepEqual(result, files);
});

import { chooseCardOpenLeaf } from "./utils";

test("chooseCardOpenLeaf: 画像一覧自身のタブへは開かない", () => {
    const own = { id: "own" };
    const other = { id: "other" };
    assert.equal(chooseCardOpenLeaf(other, own, [own, other]), other);
    assert.equal(chooseCardOpenLeaf(own, own, [own, other]), other);
    assert.equal(chooseCardOpenLeaf(own, own, [own]), null);
});
