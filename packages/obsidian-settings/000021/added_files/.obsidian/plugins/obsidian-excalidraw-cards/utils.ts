/**
 * Excalidraw Cards プラグインのユーティリティ関数群を提供するモジュール。
 * キャッシュ生成・管理処理（ハッシュ値の算出、ファイル名特定、古いキャッシュの自動クリーンアップ）のほか、
 * Excalidrawファイルに対するタグ抽出、キーワードおよびタグでのフィルタリング、
 * ドラッグ＆ドロップ用のエディタ挿入用リンクテキストの生成、
 * 統合ビュー用のタブごとのファイルフィルタリング処理（filterFilesByTab）、
 * およびファイル削除時のリスト除外処理（removeFileByPath）などを含みます。
 **/

/**
 * キャッシュ保存用ディレクトリ（Vaultルート直下の隠しフォルダ）
 * Obsidian Vault Adapter API が確実に読み書きできるパス
 **/
export const CACHE_DIR = ".excalidraw-cache";
export const CACHE_INDEX_PATH = `${CACHE_DIR}/index.json`;

/**
 * 文字列から高速に一意な16進数ハッシュを計算する (FNV-1aアルゴリズムの適用)
 **/
export function getStringHash(str: string): string {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
}

/**
 * キャッシュフォルダ内の特定のファイルパスに対するキャッシュ画像パス（Vault相対パス）を返す
 **/
export function getCacheFilePath(filePath: string, mtime: number): string {
    const hash = getStringHash(filePath);
    return `${CACHE_DIR}/${hash}_${mtime}_preview.png`;
}

/**
 * 同一ハッシュを持ちながら、現在の更新日時と異なる古いキャッシュファイルを削除してディスクをクリーンにする
 * Vault Adapter APIを使用（CACHE_DIRはVault管轄内なので確実に動作する）
 **/
export async function cleanOldCaches(
    adapter: any,
    targetHash: string,
    currentMtime: number
): Promise<void> {
    if (!await adapter.exists(CACHE_DIR)) {
        return;
    }

    try {
        const listResult = await adapter.list(CACHE_DIR);
        const files = listResult.files || [];

        for (const filePath of files) {
            // パス区切り文字からファイル名のみを抽出
            const fileName = filePath.split("/").pop() || "";
            // 一覧キャッシュは [hash]_[mtime]_preview.png のみ残し、旧SVG/高解像度PNG/サムネイルは削除する
            if (fileName.startsWith(targetHash + "_") && (fileName.endsWith(".png") || fileName.endsWith(".svg"))) {
                const expectedFileName = `${targetHash}_${currentMtime}_preview.png`;
                if (fileName !== expectedFileName) {
                    try {
                        await adapter.remove(filePath);
                    } catch (e) {
                        console.error("Failed to remove old cache file:", filePath, e);
                    }
                }
            }
        }
    } catch (e) {
        console.error("Failed to list or clean old caches:", e);
    }
}

// -------------------------------------------------------------
// 以下は obsidian-sidebar-explorer から切り出された Excalidraw 関連関数
// -------------------------------------------------------------

export interface DragFileInfo {
    extension: string;
    name: string;
    basename: string;
    path?: string;
}

export function encodePathPreservingSlashes(path: string): string {
    const normalizedPath = path.replace(/\\/g, '/');
    return normalizedPath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

export function buildExcalidrawWebUrl(fullPath: string): string {
    return `http://localhost:3001/?filepath=${encodePathPreservingSlashes(fullPath)}`;
}

type BacklinkCacheEntry = {
    revision: number;
    paths: string[];
};

export type BacklinkPathMap = Map<string, string[]>;

const backlinkCache = new WeakMap<object, Map<string, BacklinkCacheEntry>>();

function getPotentialLinkpathsForTarget(targetPath: string): string[] {
    const normalized = targetPath.replace(/\\/g, "/");
    const fileName = normalized.split("/").pop() || normalized;
    const withoutMd = normalized.replace(/\.md$/i, "");
    const fileNameWithoutMd = fileName.replace(/\.md$/i, "");
    const withoutExcalidrawSuffix = fileNameWithoutMd.replace(/\.excalidraw$/i, "");
    return Array.from(new Set([
        normalized,
        withoutMd,
        fileName,
        fileNameWithoutMd,
        withoutExcalidrawSuffix,
    ]));
}

function pushBacklink(backlinks: Map<string, Set<string>>, targetPath: string, sourcePath: string) {
    let sources = backlinks.get(targetPath);
    if (!sources) {
        sources = new Set<string>();
        backlinks.set(targetPath, sources);
    }
    sources.add(sourcePath);
}

/**
 * resolvedLinks/unresolvedLinks を一度だけ走査し、対象ファイルごとのバックリンク逆引きMapを作る。
 * 多数の Excalidraw を一覧表示するときに getBacklinkPaths をファイルごとに呼ぶと、
 * Vault全体のリンク表を何度も走査してしまうため、一覧側ではこのMapを共有する。
 */
export function buildBacklinkPathMap(
    metadataCache: any,
    targetFilePaths?: Iterable<string>
): BacklinkPathMap {
    const targetSet = targetFilePaths ? new Set(Array.from(targetFilePaths)) : null;
    const potentialLinkpaths = new Set<string>();
    if (targetSet) {
        for (const targetPath of targetSet) {
            for (const linkpath of getPotentialLinkpathsForTarget(targetPath)) {
                potentialLinkpaths.add(linkpath);
            }
        }
    }
    const backlinkSets = new Map<string, Set<string>>();

    const resolvedLinks = metadataCache?.resolvedLinks || {};
    for (const sourcePath in resolvedLinks) {
        const linksFromSource = resolvedLinks[sourcePath] || {};
        for (const targetPath in linksFromSource) {
            if (!targetSet || targetSet.has(targetPath)) {
                pushBacklink(backlinkSets, targetPath, sourcePath);
            }
        }
    }

    const unresolvedLinks = metadataCache?.unresolvedLinks || {};
    for (const sourcePath in unresolvedLinks) {
        const linksFromSource = unresolvedLinks[sourcePath] || {};
        for (const linkpath in linksFromSource) {
            if (targetSet && !potentialLinkpaths.has(linkpath)) {
                continue;
            }
            const destFile = metadataCache?.getFirstLinkpathDest?.(linkpath, sourcePath);
            if (destFile?.path && (!targetSet || targetSet.has(destFile.path))) {
                pushBacklink(backlinkSets, destFile.path, sourcePath);
            }
        }
    }

    const result: BacklinkPathMap = new Map();
    for (const [targetPath, sources] of backlinkSets) {
        result.set(targetPath, Array.from(sources));
    }
    return result;
}

/**
 * 解決済み・未解決のリンク(resolvedLinks/unresolvedLinks)を調べ、
 * 指定されたファイルへのバックリンクとなっているファイルのパス一覧を取得する関数
 */
export function getBacklinkPaths(metadataCache: any, targetFilePath: string, revision = 0): string[] {
    if (metadataCache && typeof metadataCache === 'object') {
        let cacheForMetadata = backlinkCache.get(metadataCache);
        if (!cacheForMetadata) {
            cacheForMetadata = new Map<string, BacklinkCacheEntry>();
            backlinkCache.set(metadataCache, cacheForMetadata);
        }

        const cached = cacheForMetadata.get(targetFilePath);
        if (cached && cached.revision === revision) {
            return cached.paths;
        }
    }

    const backlinkPaths = new Set<string>();

    // 1. resolvedLinks (解決済みリンク) の走査
    const resolvedLinks = metadataCache.resolvedLinks || {};
    for (const sourcePath in resolvedLinks) {
        if (resolvedLinks[sourcePath][targetFilePath]) {
            backlinkPaths.add(sourcePath);
        }
    }

    // 2. unresolvedLinks (未解決リンク) の走査
    const unresolvedLinks = metadataCache.unresolvedLinks || {};
    for (const sourcePath in unresolvedLinks) {
        const linksFromSource = unresolvedLinks[sourcePath];
        for (const linkpath in linksFromSource) {
            // 未解決リンクであっても、getFirstLinkpathDest が対象ファイルを返すかチェック
            if (metadataCache.getFirstLinkpathDest) {
                const destFile = metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
                if (destFile && destFile.path === targetFilePath) {
                    backlinkPaths.add(sourcePath);
                }
            }
        }
    }

    const paths = Array.from(backlinkPaths);

    if (metadataCache && typeof metadataCache === 'object') {
        let cacheForMetadata = backlinkCache.get(metadataCache);
        if (!cacheForMetadata) {
            cacheForMetadata = new Map<string, BacklinkCacheEntry>();
            backlinkCache.set(metadataCache, cacheForMetadata);
        }
        cacheForMetadata.set(targetFilePath, { revision, paths });
    }

    return paths;
}

/**
 * Excalidrawファイルの配列からユニークなタグの一覧を抽出してソートして返す
 * 各Excalidrawファイル自身に設定されているタグだけでなく、それを呼び出している（リンク/埋め込み）
 * 親マークダウンファイルのタグも収集してマージします。
 **/
export function extractUniqueTags(
    files: { path: string }[],
    metadataCache: any,
    backlinkMap?: BacklinkPathMap,
    options: { includeParentTags?: boolean } = {}
): string[] {
    const tagsSet = new Set<string>();
    const includeParentTags = options.includeParentTags !== false;

    for (const file of files) {
        // 1. Excalidrawファイル自身に設定されているタグを抽出
        const cache = metadataCache.getFileCache(file);
        if (cache) {
            if (cache.tags) {
                for (const t of cache.tags) {
                    if (t && typeof t.tag === 'string') {
                        const tag = t.tag.trim();
                        if (tag) {
                            tagsSet.add(tag.startsWith('#') ? tag : '#' + tag);
                        }
                    }
                }
            }
            if (cache.frontmatter && cache.frontmatter.tags) {
                const fmTags = cache.frontmatter.tags;
                if (typeof fmTags === 'string') {
                    for (const t of fmTags.split(',')) {
                        const trimmed = t.trim();
                        if (trimmed) {
                            tagsSet.add(trimmed.startsWith('#') ? trimmed : '#' + trimmed);
                        }
                    }
                } else if (Array.isArray(fmTags)) {
                    for (const t of fmTags) {
                        const trimmed = String(t).trim();
                        if (trimmed) {
                            tagsSet.add(trimmed.startsWith('#') ? trimmed : '#' + trimmed);
                        }
                    }
                }
            }
        }

        if (includeParentTags) {
            // 2. このExcalidrawファイルを呼び出している（リンク/埋め込み）親マークダウンファイルのタグを抽出
            const parentPaths = backlinkMap?.get(file.path) || getBacklinkPaths(metadataCache, file.path);
            for (const parentPath of parentPaths) {
                const parentCache = metadataCache.getFileCache({ path: parentPath });
                if (parentCache) {
                    if (parentCache.tags) {
                        for (const t of parentCache.tags) {
                            if (t && typeof t.tag === 'string') {
                                const tag = t.tag.trim();
                                if (tag) {
                                    tagsSet.add(tag.startsWith('#') ? tag : '#' + tag);
                                }
                            }
                        }
                    }
                    if (parentCache.frontmatter && parentCache.frontmatter.tags) {
                        const fmTags = parentCache.frontmatter.tags;
                        if (typeof fmTags === 'string') {
                            for (const t of fmTags.split(',')) {
                                const trimmed = t.trim();
                                if (trimmed) {
                                    tagsSet.add(trimmed.startsWith('#') ? trimmed : '#' + trimmed);
                                }
                            }
                        } else if (Array.isArray(fmTags)) {
                            for (const t of fmTags) {
                                const trimmed = String(t).trim();
                                if (trimmed) {
                                    tagsSet.add(trimmed.startsWith('#') ? trimmed : '#' + trimmed);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    return Array.from(tagsSet).sort((a, b) => a.localeCompare(b));
}

/**
 * Excalidrawファイルをキーワードとタグでフィルタリングする
 * タグの判定には、Excalidrawファイル自身のタグに加えて、
 * それを呼び出している（リンク/埋め込み）親マークダウンファイルのタグもマッチング対象とします。
 **/
export function filterExcalidrawFiles(
    files: { path: string; name: string }[],
    metadataCache: any,
    searchQuery: string,
    selectedTag: string,
    backlinkMap?: BacklinkPathMap
): { path: string; name: string }[] {
    const query = searchQuery.trim().toLowerCase();

    return files.filter(file => {
        // キーワードフィルター
        if (query) {
            let displayName = file.name.toLowerCase();
            if (displayName.endsWith(".excalidraw.md")) {
                displayName = displayName.slice(0, -14);
            } else if (displayName.endsWith("_excalidraw.md")) {
                displayName = displayName.slice(0, -14);
            } else {
                const dotIdx = displayName.lastIndexOf('.');
                if (dotIdx !== -1) {
                    displayName = displayName.substring(0, dotIdx);
                }
            }
            if (!displayName.includes(query)) {
                return false;
            }
        }

        // タグフィルター
        if (selectedTag) {
            let fileTags: string[] = [];

            // 1. Excalidrawファイル自身に設定されているタグを抽出
            const cache = metadataCache.getFileCache(file);
            if (cache) {
                if (cache.tags) {
                    fileTags.push(...cache.tags.map((t: any) => t.tag));
                }
                if (cache.frontmatter && cache.frontmatter.tags) {
                    const fmTags = cache.frontmatter.tags;
                    if (typeof fmTags === 'string') {
                        fileTags.push(...fmTags.split(',').map((t: string) => t.trim()));
                    } else if (Array.isArray(fmTags)) {
                        fileTags.push(...fmTags.map((t: any) => String(t).trim()));
                    }
                }
            }

            // 2. このExcalidrawファイルを呼び出している（リンク/埋め込み）親マークダウンファイルのタグを抽出
            const parentPaths = backlinkMap?.get(file.path) || getBacklinkPaths(metadataCache, file.path);
            for (const parentPath of parentPaths) {
                const parentCache = metadataCache.getFileCache({ path: parentPath });
                if (parentCache) {
                    if (parentCache.tags) {
                        fileTags.push(...parentCache.tags.map((t: any) => t.tag));
                    }
                    if (parentCache.frontmatter && parentCache.frontmatter.tags) {
                        const fmTags = parentCache.frontmatter.tags;
                        if (typeof fmTags === 'string') {
                            fileTags.push(...fmTags.split(',').map((t: string) => t.trim()));
                        } else if (Array.isArray(fmTags)) {
                            fileTags.push(...fmTags.map((t: any) => String(t).trim()));
                        }
                    }
                }
            }

            const normalizedSelected = selectedTag.startsWith('#') ? selectedTag : '#' + selectedTag;
            const hasTag = fileTags.some(tag => {
                const normalizedTag = tag.startsWith('#') ? tag : '#' + tag;
                return normalizedTag.toLowerCase() === normalizedSelected.toLowerCase();
            });

            if (!hasTag) {
                return false;
            }
        }

        return true;
    });
}

/**
 * Excalidrawファイルのドラッグ＆ドロップ用（エディタ挿入用）リンクマークダウンテキストを生成する
 **/
export function getDragText(file: DragFileInfo, basePath?: string): string {
    const isImage = IMAGE_EXTENSIONS.includes(file.extension.toLowerCase());
    const isDio = isDioFile(file.name);

    if (isImage || isDio) {
        return `![[${file.name}]]`;
    }

    const fileNameToDisplay = file.name.replace(/\.md$/, '').replace(/\.excalidraw$/, '').replace(/_excalidraw$/, '');
    const embedName = file.name.replace(/\.md$/, '');
    const embedText = `![[${embedName}|1475]]`;

    if (basePath && file.path) {
        const fullPath = `${basePath}/${file.path}`;
        const url = buildExcalidrawWebUrl(fullPath);
        return `[${fileNameToDisplay}](${url})\n${embedText}`;
    }

    return embedText;
}

/**
 * 画像として認識する拡張子リスト
 **/
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "bmp", "svg", "webp"];

/**
 * 選択されたタブに応じて、01_data配下のファイルをフィルタリングする。
 * "unlinked" タブの場合は他ファイルからのリンクがない（バックリンク0）ファイルのみに絞り込みます。
 **/
export function filterFilesByTab(
    files: { path: string; name: string }[],
    activeTab: "all" | "excalidraw" | "common" | "image" | "unlinked" | "dio",
    metadataCache?: any,
    backlinkMap?: BacklinkPathMap
): { path: string; name: string }[] {
    return files.filter(file => {
        // パス区切り文字をスラッシュに正規化して判定
        const normalizedPath = file.path.replace(/\\/g, "/");
        if (!normalizedPath.startsWith("01_data")) {
            return false;
        }

        const lowerName = file.name.toLowerCase();
        const isExcalidraw = lowerName.endsWith(".excalidraw.md") || lowerName.endsWith("_excalidraw.md");
        const isImage = IMAGE_EXTENSIONS.some(ext => lowerName.endsWith("." + ext));
        const isDio = isDioFile(file.name);

        // 画像でもExcalidrawでもdioでもないものは除外
        if (!isExcalidraw && !isImage && !isDio) {
            return false;
        }

        switch (activeTab) {
            case "all":
                return true;
            case "excalidraw":
                return isExcalidraw;
            case "common":
                return normalizedPath.startsWith("01_data/common_image");
            case "image":
                return isImage && !isDio;
            case "dio":
                return isDio;
            case "unlinked":
                if (normalizedPath.startsWith("01_data/common_image")) {
                    return false;
                }
                if (!metadataCache) {
                    return false;
                }
                return (backlinkMap?.get(file.path) || getBacklinkPaths(metadataCache, file.path)).length === 0;
            default:
                return false;
        }
    });
}

/**
 * ファイルリストから同じファイルパス（path）を持つ重複した要素を除外する。
 * 配列の順序は維持され、最初に出現した要素が優先して残されます。
 **/
export function deduplicateFilesByPath<T extends { path: string }>(files: T[]): T[] {
    const seen = new Set<string>();
    return files.filter(file => {
        if (seen.has(file.path)) {
            return false;
        }
        seen.add(file.path);
        return true;
    });
}

/**
 * 指定されたファイル名が dio 関連ファイル (.dio, .dio.svg, .drawio, .drawio.svg) であるかを判定する。
 **/
export function isDioFile(fileName: string): boolean {
    const lowerName = fileName.toLowerCase();
    return lowerName.endsWith(".dio") ||
           lowerName.endsWith(".dio.svg") ||
           lowerName.endsWith(".drawio") ||
           lowerName.endsWith(".drawio.svg");
}

/**
 * カードをクリックしたときにファイルを開くペインを選ぶ。
 * 画像一覧がアクティブなときは getLeaf が画像一覧自身を返すため、画像一覧を残して別のペインを使う。
 * 別のペインが無ければ null を返す（呼び出し側が分割して作る）。
 **/
export function chooseCardOpenLeaf<T>(candidate: T, ownLeaf: T, rootLeaves: T[]): T | null {
    if (candidate !== ownLeaf) return candidate;
    return rootLeaves.find(leaf => leaf !== ownLeaf) ?? null;
}

/**
 * ファイルリストから指定されたパスを持つファイルを除外する。
 * Windows形式のパス区切り（\）とPOSIX形式（/）の違いを吸収して正確に一致判定を行います。
 **/
export function removeFileByPath<T extends { path: string }>(files: T[], targetPath: string): T[] {
    const normalizedTarget = targetPath.replace(/\\/g, "/");
    return files.filter(file => file.path.replace(/\\/g, "/") !== normalizedTarget);
}
