/**
 * Sidebar Explorerのユーティリティ関数群を提供するモジュール。
 * 各種ファイル判定、ドラッグテキスト生成、重要度計算、分割タブ起動、
 * フォルダファイルのフィルタリング・ソート、WebアプリURL生成、VS Code起動、
 * および画像・Excalidrawカードビューのトグル開閉処理などを扱います。
 **/

/**
 * OSに応じてフォルダを開くためのコマンド文字列を生成する
 **/
export function getOpenFolderCommand(platform: string, fullPath: string): string {
    if (platform === 'darwin') {
        return `open "${fullPath}"`;
    } else if (platform === 'win32') {
        return `explorer "${fullPath.replace(/\//g, '\\')}"`;
    }
    return '';
}

export function getOpenFolderCommandArgs(platform: string, fullPath: string): { command: string; args: string[] } | null {
    if (platform === 'darwin') {
        return { command: 'open', args: [fullPath] };
    } else if (platform === 'win32') {
        return { command: 'explorer', args: [fullPath.replace(/\//g, '\\')] };
    }
    return null;
}

export interface DragFileInfo {
    extension: string;
    name: string;
    basename: string;
    path?: string;
}

const ATTACHMENT_EXTENSIONS = new Set([
    'canvas',
    'excalidraw',
    'png',
    'jpg',
    'jpeg',
    'gif',
    'bmp',
    'svg',
    'webp',
    'msg',
    'pdf',
    'zip',
    'rar',
    '7z',
    'xlsx',
    'xls',
    'pptx',
    'ppt',
    'docx',
    'doc',
    'eml',
]);

const IMAGE_EXTENSIONS = new Set([
    'png',
    'jpg',
    'jpeg',
    'gif',
    'bmp',
    'svg',
    'webp',
    'tif',
    'tiff',
]);

export function encodePathPreservingSlashes(path: string): string {
    return path.replace(/\\/g, '/').split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

export function buildExcalidrawWebUrl(fullPath: string): string {
    return `http://localhost:3001/?filepath=${encodePathPreservingSlashes(fullPath)}`;
}

/**
 * Excalidrawが管理しているMarkdownファイルかどうかを判定する。
 * ファイル名だけでなく、通常の `memo.md` に付いた
 * `excalidraw-plugin: parsed` も対象にする。
 */
export function isExcalidrawBackedMarkdown(app: any, file: any): boolean {
    if (!file || file.extension?.toLowerCase() !== 'md') return false;
    if (file.name?.toLowerCase().endsWith('.excalidraw.md')) return true;

    try {
        const plugin = app?.plugins?.plugins?.['obsidian-excalidraw-plugin'];
        if (typeof plugin?.isExcalidrawFile === 'function' && plugin.isExcalidrawFile(file)) {
            return true;
        }
    } catch (error) {
        console.warn('Failed to detect Excalidraw-backed Markdown:', error);
    }

    const frontmatter = app?.metadataCache?.getFileCache?.(file)?.frontmatter;
    return Boolean(frontmatter && Object.prototype.hasOwnProperty.call(frontmatter, 'excalidraw-plugin'));
}

/**
 * Excalidrawビューで開かれたファイルを、同じファイルのMarkdownビューへ切り替える。
 * Excalidrawプラグインの公開APIを優先し、利用できない場合はObsidian標準APIへ
 * フォールバックする。
 */
export async function switchToMarkdownViewIfExcalidraw(app: any, leaf: any, file: any): Promise<boolean> {
    // 判定イベントの時点ではmetadataCache/frontmatterがまだ更新途中のことがある。
    // ここでは「mdファイルが実際にExcalidrawビューになっている」ことを最終条件に
    // して、通常のMarkdownファイルを開くすべての入口から確実に戻せるようにする。
    // `.excalidraw.md` は図そのものなので、ダブルクリック等では
    // Excalidrawプラグインのキャンバスを開く。Markdownへ戻すのは、
    // `りんご.md` のような通常のMarkdownメモだけに限定する。
    if (!leaf || !isExcalidrawBackedMarkdown(app, file) || file.name?.toLowerCase().endsWith('.excalidraw.md')) return false;
    if (leaf.view?.getViewType?.() !== 'excalidraw') return false;
    if (leaf.__sidebarMarkdownViewSwitching) return false;
    leaf.__sidebarMarkdownViewSwitching = true;

    try {
        // ExcalidrawView自身のAPIは、ビュー切り替えだけでなく
        // ファイルごとの表示モードも「markdown」に更新する。
        // プラグイン本体のsetMarkdownViewだけを呼ぶと、setViewState後に
        // Excalidraw側のmonkey patchが再びExcalidrawビューへ戻してしまう。
        if (typeof leaf.view?.setMarkdownView === 'function') {
            await leaf.view.setMarkdownView();
            if (leaf.view?.getViewType?.() !== 'excalidraw') return true;
        }

        const excalidrawPlugin = app?.plugins?.plugins?.['obsidian-excalidraw-plugin'];
        if (typeof excalidrawPlugin?.setMarkdownView === 'function') {
            await excalidrawPlugin.setMarkdownView(leaf);
            if (leaf.view?.getViewType?.() !== 'excalidraw') return true;
        }

        if (typeof leaf.setViewState === 'function') {
            await leaf.setViewState({
                type: 'markdown',
                state: { file: file.path, mode: 'preview' },
                popstate: true,
            }, { focus: true });
            return true;
        }

        return false;
    } finally {
        delete leaf.__sidebarMarkdownViewSwitching;
    }
}

/**
 * Sidebar等からファイルを開く共通処理。Excalidraw-backed Markdownだけは
 * 一度通常どおり開いた後、Markdownビューへ切り替える。
 */
export async function openFileInMarkdownView(app: any, leaf: any, file: any): Promise<void> {
    if (!leaf || !file) return;
    await leaf.openFile(file);

    // 通常のMarkdownまで再試行対象にすると、ユーザーが明示的に選んだ
    // Excalidrawビューを上書きしてしまうため、裏面データを持つファイルだけに限定する。
    if (!isExcalidrawBackedMarkdown(app, file) || file.name?.toLowerCase().endsWith('.excalidraw.md')) return;

    // Excalidraw側のfile-open処理が後からビューを戻すことがあるため、
    // 初回だけでなく、ビュー確定後にも再確認する。
    for (const delay of [0, 100, 300, 700, 1500]) {
        if (delay > 0) await new Promise((resolve) => globalThis.setTimeout(resolve, delay));
        await switchToMarkdownViewIfExcalidraw(app, leaf, file);
        if (leaf.view?.getViewType?.() !== 'excalidraw') return;
    }
}

export function isAttachmentFile(file: { extension: string }): boolean {
    return file.extension.toLowerCase() !== 'md' && ATTACHMENT_EXTENSIONS.has(file.extension.toLowerCase());
}

export function isImageFile(file: { extension: string }): boolean {
    return IMAGE_EXTENSIONS.has(file.extension.toLowerCase());
}

type BacklinkCacheEntry = {
    revision: number;
    paths: string[];
};

const backlinkCache = new WeakMap<object, Map<string, BacklinkCacheEntry>>();

export interface FileImportanceMetrics {
    accessCount?: number;
    backlinkCount?: number;
    lastOpenedAt?: number;
    modifiedAt?: number;
    outgoingLinkCount?: number;
    attachmentCount?: number;
    headingCount?: number;
    tagCount?: number;
    titleOrPathBoost?: number;
}

export function getRecencyScore(timestamp?: number, now = Date.now(), halfLifeDays = 30): number {
    if (!timestamp || timestamp > now) {
        return 0;
    }

    const ageDays = (now - timestamp) / (1000 * 60 * 60 * 24);
    return Math.pow(0.5, ageDays / halfLifeDays);
}

export function calculateFileImportanceScore(metrics: FileImportanceMetrics, now = Date.now()): number {
    const backlinkScore = Math.log1p(metrics.backlinkCount ?? 0);
    const accessScore = Math.log1p(metrics.accessCount ?? 0);
    const lastOpenedScore = getRecencyScore(metrics.lastOpenedAt, now);
    const modifiedScore = getRecencyScore(metrics.modifiedAt, now, 60);
    const outgoingScore = Math.log1p(metrics.outgoingLinkCount ?? 0);
    const attachmentScore = Math.log1p(metrics.attachmentCount ?? 0);
    const headingScore = Math.log1p(metrics.headingCount ?? 0);
    const tagScore = Math.log1p(metrics.tagCount ?? 0);

    return (
        0.35 * backlinkScore +
        0.2 * accessScore +
        0.1 * lastOpenedScore +
        0.08 * modifiedScore +
        0.06 * outgoingScore +
        0.04 * attachmentScore +
        0.04 * headingScore +
        0.03 * tagScore +
        0.15 * (metrics.titleOrPathBoost ?? 0)
    );
}

export function collectLinkedFiles(
    metadataCache: any,
    file: { path: string },
    references: Array<{ link: string }> = [],
): { markdownFiles: string[]; attachmentFiles: string[] } {
    const markdownFiles: string[] = [];
    const attachmentFiles: string[] = [];
    const seenPaths = new Set<string>();

    for (const reference of references) {
        const linkedFile = metadataCache.getFirstLinkpathDest?.(reference.link, file.path);
        if (!linkedFile || seenPaths.has(linkedFile.path)) {
            continue;
        }

        seenPaths.add(linkedFile.path);

        if (linkedFile.extension?.toLowerCase() === 'md') {
            markdownFiles.push(linkedFile.path);
        } else if (isAttachmentFile(linkedFile)) {
            attachmentFiles.push(linkedFile.path);
        }
    }

    return { markdownFiles, attachmentFiles };
}

/**
 * ファイルの拡張子や名前に応じて、ドラッグ＆ドロップ用（エディタ挿入用）のテキストを生成する
 */
export function getDragText(file: DragFileInfo, basePath?: string): string {
    const isImagePdf = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'pdf'].includes(file.extension.toLowerCase());

    if (isImagePdf) {
        return `![[${file.name}]]`;
    }

    return file.extension === 'md' ? `[[${file.basename}]]` : `[[${file.name}]]`;
}

/**
 * Obsidian標準のファイルドラッグとして登録する。
 * ExcalidrawはShift+ドロップ時、このdragManagerのファイル情報を使って
 * Markdownファイルを画像として挿入するため、text/plainだけでは不十分。
 */
export function setupObsidianFileDrag(app: any, event: DragEvent, file: any): boolean {
    patchExcalidrawImageDrop();

    const dragManager = app?.dragManager;
    if (!dragManager?.dragFile || !dragManager?.onDragStart) {
        return false;
    }

    const dragData = dragManager.dragFile(event, file);
    dragManager.onDragStart(event, dragData);
    return true;
}

/**
 * Shift+ドロップされたExcalidraw Markdownを選択ダイアログを介さず画像として挿入する。
 * Excalidraw 2.26系ではShiftは画像ボタンを強調するだけで自動確定しないため、
 * カスタムサイドバーからのドラッグ時だけ、アクティブビューの処理を補完する。
 */
function patchExcalidrawImageDrop(): void {
    const automate = (globalThis as any).ExcalidrawAutomate;
    const plugin = automate?.plugin;
    const view = plugin?.activeExcalidrawView;
    const dropManager = view?.dropManager;

    if (!dropManager?.openDroppedMarkdownFile || dropManager.__sidebarExplorerImageDropPatched) {
        return;
    }

    const originalOpenDroppedMarkdownFile = dropManager.openDroppedMarkdownFile;
    dropManager.openDroppedMarkdownFile = function (
        droppedFile: any,
        position: { x: number; y: number },
        preferredAction: string,
    ) {
        if (preferredAction !== 'image' || !plugin.isExcalidrawFile?.(droppedFile)) {
            return originalOpenDroppedMarkdownFile.call(this, droppedFile, position, preferredAction);
        }

        void (async () => {
            const ea = automate.getAPI(view);
            try {
                ea.clear();
                ea.setStyle({ backgroundColor: 'transparent', strokeColor: 'transparent' });
                const imageId = await ea.addImage(position.x, position.y, droppedFile, true);
                await ea.addElementsToView(false, true, true);
                ea.selectElementsInView([imageId]);
            } finally {
                ea.destroy();
            }
        })();
    };
    dropManager.__sidebarExplorerImageDropPatched = true;
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

export function buildBacklinkCountMap(metadataCache: any): Record<string, number> {
    const backlinkSourcesByTarget: Map<string, Set<string>> = new Map();

    const addBacklink = (targetPath: string | undefined, sourcePath: string) => {
        if (!targetPath) return;

        let sources = backlinkSourcesByTarget.get(targetPath);
        if (!sources) {
            sources = new Set<string>();
            backlinkSourcesByTarget.set(targetPath, sources);
        }
        sources.add(sourcePath);
    };

    const resolvedLinks = metadataCache?.resolvedLinks || {};
    for (const sourcePath in resolvedLinks) {
        for (const targetPath in resolvedLinks[sourcePath]) {
            addBacklink(targetPath, sourcePath);
        }
    }

    const unresolvedLinks = metadataCache?.unresolvedLinks || {};
    for (const sourcePath in unresolvedLinks) {
        const linksFromSource = unresolvedLinks[sourcePath];
        for (const linkpath in linksFromSource) {
            const destFile = metadataCache?.getFirstLinkpathDest?.(linkpath, sourcePath);
            addBacklink(destFile?.path, sourcePath);
        }
    }

    const counts: Record<string, number> = {};
    for (const [targetPath, sources] of backlinkSourcesByTarget) {
        counts[targetPath] = sources.size;
    }

    return counts;
}

/**
 * アクティブなタブを上下分割（水平分割）した新しいタブを作成し、指定されたファイルを開く
 **/
export async function openFileInSplitTab(app: any, file: any): Promise<void> {
    const leaf = app.workspace.getLeaf('split', 'horizontal');
    if (leaf) {
        await leaf.openFile(file);
    }
}

/**
 * 指定されたファイルがすでに開かれている場合はそのタブを閉じ、
 * 開かれていない場合はアクティブタブの下（水平分割）に新しく開く（トグル動作）
 **/
let Notice: any;
try {
    Notice = require("obsidian").Notice;
} catch (e) {
    Notice = class DummyNotice {
        constructor(text: string) {
            console.log("Notice:", text);
        }
    };
}


export async function toggleFileView(app: any, filePath: string): Promise<void> {
    try {
        if (!app) {
            throw new Error("app object is undefined");
        }
        const { workspace } = app;
        if (!workspace) {
            throw new Error("workspace object is undefined");
        }

        let targetLeaf: any = null;

        workspace.iterateAllLeaves((leaf: any) => {
            if (leaf.view && leaf.view.file && leaf.view.file.path === filePath) {
                targetLeaf = leaf;
            }
        });

        if (targetLeaf) {
            // 閉じる前の元のアクティブなLeafを取得
            const activeLeaf = typeof workspace.getActiveLeaf === "function"
                ? workspace.getActiveLeaf()
                : (typeof workspace.getMostRecentLeaf === "function"
                    ? workspace.getMostRecentLeaf()
                    : workspace.activeLeaf);

            targetLeaf.detach();

            // 閉じた後、元のアクティブなエディタ（Leaf）にフォーカスを戻す
            if (activeLeaf && activeLeaf !== targetLeaf) {
                setTimeout(() => {
                    try {
                        workspace.setActiveLeaf(activeLeaf, { focus: true });
                    } catch (e) {
                        console.warn("Failed to restore focus after detach:", e);
                    }
                }, 50);
            } else {
                // もし閉じられた対象にフォーカスがあった場合は、直近のアクティブLeafを探してフォーカスを戻す
                setTimeout(() => {
                    try {
                        const nextActiveLeaf = typeof workspace.getMostRecentLeaf === "function"
                            ? workspace.getMostRecentLeaf()
                            : workspace.activeLeaf;
                        if (nextActiveLeaf && nextActiveLeaf !== targetLeaf) {
                            workspace.setActiveLeaf(nextActiveLeaf, { focus: true });
                        }
                    } catch (e) {
                        console.warn("Failed to restore focus to next active leaf after detach:", e);
                    }
                }, 50);
            }
        } else {
            const file = app.vault.getAbstractFileByPath(filePath);
            if (!file) {
                throw new Error(`File not found in vault: ${filePath}`);
            }

            // トグルを開く前の元のアクティブLeaf（マークダウンエディタなど）を取得
            const activeLeaf = typeof workspace.getActiveLeaf === "function"
                ? workspace.getActiveLeaf()
                : (typeof workspace.getMostRecentLeaf === "function"
                    ? workspace.getMostRecentLeaf()
                    : workspace.activeLeaf);

            const newLeaf = workspace.getLeaf('split', 'horizontal');
            if (newLeaf) {
                await newLeaf.openFile(file);

                // 元のアクティブLeafが存在すれば、Basesの初期化処理との競合を避けるため非同期でフォーカスを戻す
                if (activeLeaf) {
                    setTimeout(() => {
                        try {
                            workspace.setActiveLeaf(activeLeaf, { focus: true });
                        } catch (e) {
                            console.warn("Failed to restore focus to active leaf:", e);
                        }
                    }, 50);
                }
            } else {
                throw new Error("Failed to create split leaf");
            }
        }
    } catch (error: any) {
        new Notice(`toggleFileView Error: ${error?.message || error}`);
        console.error("toggleFileView failed:", error);
    }
}

/**
 * ファイルが MOC 移動対象（タグに MOC が含まれる）であるかを判定する
 * 
 * @param file 判定対象のファイル情報 (TFile のサブセット)
 * @param fileCache メタデータキャッシュ (CachedMetadata のサブセット)
 * @returns 移動対象であれば true、そうでなければ false
 */
export function shouldMoveToMoc(file: { path: string; extension: string; name: string }, fileCache: any): boolean {
    if (!file || !fileCache) {
        return false;
    }

    const ext = file.extension?.toLowerCase();
    if (ext !== 'md') {
        return false;
    }

    if (file.name?.endsWith('.excalidraw.md')) {
        return false;
    }

    if (file.path?.startsWith('00_templates/')) {
        return false;
    }

    if (file.path?.startsWith('02_MOC/')) {
        return false;
    }

    const tags: string[] = [];

    // 本文中のインラインタグを収集
    if (fileCache.tags) {
        for (const t of fileCache.tags) {
            if (t && typeof t.tag === 'string') {
                tags.push(t.tag.toLowerCase());
            }
        }
    }

    // フロントマターのタグを収集
    if (fileCache.frontmatter && fileCache.frontmatter.tags) {
        const fmTags = fileCache.frontmatter.tags;
        if (Array.isArray(fmTags)) {
            for (const t of fmTags) {
                if (typeof t === 'string') {
                    tags.push(t.toLowerCase());
                }
            }
        } else if (typeof fmTags === 'string') {
            // カンマ区切りの文字列を想定
            const splitTags = fmTags.split(/,\s*/);
            for (const t of splitTags) {
                tags.push(t.trim().toLowerCase());
            }
        }
    }

    // "moc" または "#moc" が含まれているか判定
    return tags.some((t) => t === 'moc' || t === '#moc');
}

/**
 * 指定された日付（デフォルトは現在時刻）に応じた今日のフォルダパスを返す
 * 
 * @param now 基準日時
 * @returns '01_data/YYYY/MM/DD' 形式のパス
 **/
export function getTodayFolderPath(now: Date = new Date()): string {
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return `01_data/${yyyy}/${mm}/${dd}`;
}

/**
 * フォルダ内のファイル一覧を更新日時（mtime）の降順でソートし、
 * 検索キーワード（全角・半角スペース区切り）で絞り込む
 * 
 * @param files ファイル一覧配列
 * @param query 検索クエリ文字列
 * @returns ソートおよび絞り込み後のファイル配列
 **/
export function filterFolderFiles<T extends { name: string; stat?: { mtime: number } }>(
    files: T[],
    query?: string
): T[] {
    const sorted = [...files].sort((a, b) => (b.stat?.mtime ?? 0) - (a.stat?.mtime ?? 0));
    if (!query) {
        return sorted;
    }

    const keywords = query
        .trim()
        .split(/[\s\u3000]+/)
        .filter((k) => k.length > 0)
        .map((k) => k.toLowerCase());

    if (keywords.length === 0) {
        return sorted;
    }

    return sorted.filter((file) => {
        const filename = file.name.toLowerCase();
        return keywords.every((keyword) => filename.includes(keyword));
    });
}

/**
 * フォルダのフルパスを受け取り、Webアプリ（http://localhost:8001/）を開くURLを生成する
 * 
 * @param folderFullPath フォルダのOS絶対パス
 * @returns 'http://localhost:8001/?path=...' 形式のURL
 **/
export function buildFileManagerWebUrl(folderFullPath: string): string {
    return `http://localhost:8001/?path=${encodeURIComponent(folderFullPath)}`;
}

/**
 * 指定されたフォルダまたはファイルを Visual Studio Code で開く
 * 
 * @param targetPath 対象のOS絶対パス
 * @param customExecutable ユーザー指定のVS Code実行ファイルパス（省略可能）
 * @returns 起動に成功したかどうか
 **/
export async function openInVsCode(targetPath: string, customExecutable?: string): Promise<boolean> {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const { execFile } = require("child_process");

    const run = (command: string, args: string[]) => new Promise<boolean>(resolve => {
        execFile(command, args, (error: any) => resolve(!error));
    });

    const platform = os.platform();
    let opened = false;
    const vscodeExecutable = customExecutable?.trim();

    // 1. ユーザー指定パスの実行
    if (vscodeExecutable && fs.existsSync(vscodeExecutable)) {
        opened = await run(vscodeExecutable, [targetPath]);
        if (opened) return true;
    }

    // 2. プラットフォーム別既定起動
    if (platform === "darwin") {
        opened = await run("open", ["-a", "Visual Studio Code", targetPath]);
        if (!opened) {
            opened = await run("code", [targetPath]);
        }
    } else if (platform === "win32") {
        const env = process.env;
        const codeCandidates = [
            path.join(env.LOCALAPPDATA || "", "Programs", "Microsoft VS Code", "Code.exe"),
            path.join(env.ProgramFiles || "", "Microsoft VS Code", "Code.exe"),
            path.join(env["ProgramFiles(x86)"] || "", "Microsoft VS Code", "Code.exe")
        ].filter((candidate: string) => fs.existsSync(candidate));

        opened = codeCandidates.length > 0
            ? await run(codeCandidates[0], [targetPath])
            : await run("code", [targetPath]);
    } else {
        opened = await run("code", [targetPath]);
    }

    return opened;
}


