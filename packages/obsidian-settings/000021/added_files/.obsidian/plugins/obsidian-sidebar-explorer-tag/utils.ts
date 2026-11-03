/**
 * サイドバーエクスプローラータグ用のユーティリティ関数群
 * 
 * 仕様:
 * - ドラッグ＆ドロップ用マークダウンテキスト生成
 * - Mac用localhostリンクのユーザー名置換
 * - タグ検索クエリによるファイルフィルタリング（クエリ空時はタグなしファイルを抽出）
 **/
export interface DragFileInfo {
    extension: string;
    name: string;
    basename: string;
    path?: string;
}

/**
 * ファイルの拡張子や名前に応じて、ドラッグ＆ドロップ用（エディタ挿入用）のテキストを生成する
 */
export function getDragText(file: DragFileInfo, basePath?: string): string {
    const isExcalidraw = file.extension === 'excalidraw' || file.name.endsWith('.excalidraw.md');
    const isImagePdf = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'pdf'].includes(file.extension.toLowerCase());

    if (isExcalidraw) {
        // [ファイル名](http://localhost:3001/?filepath=エンコードされた絶対パス) + \n + ![[ファイル名.excalidraw|1475]]
        // Note: For display name, we want to strip both .md and .excalidraw
        const fileNameToDisplay = file.name.replace(/\.md$/, '').replace(/\.excalidraw$/, '');
        const embedName = file.name.replace(/\.md$/, '');
        const embedText = `![[${embedName}|1475]]`;

        if (basePath && file.path) {
            // パス区切り文字 `/` は維持しつつ、各パスセグメントを `encodeURIComponent` でエンコードする
            const fullPath = `${basePath}/${file.path}`;
            const encodedPath = fullPath.split('/').map(p => encodeURIComponent(p)).join('/');
            const url = `http://localhost:3001/?filepath=${encodedPath}`;
            return `[${fileNameToDisplay}](${url})\n${embedText}`;
        }

        return embedText;
    } else if (isImagePdf) {
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
 * macOSの場合に、localhost:3001/?filepath= リンク内のユーザー名を現在のユーザー名に置換する
 */
export function rewriteLocalhostLinkForMac(href: string, platform: string, currentUsername: string): string {
    if (platform === 'darwin') {
        const encodedUsername = encodeURIComponent(currentUsername);
        if (href.startsWith('http://localhost:3001/?filepath=')) {
            return href.replace(/([?&]filepath=\/Users\/)[^/]+(\/)/, `$1${encodedUsername}$2`);
        } else if (href.startsWith('http://localhost:8001/api/open-path?path=')) {
            return href.replace(/([?&]path=\/Users\/)[^/]+(\/)/, `$1${encodedUsername}$2`);
        }
    }
    return href;
}

/** Excalidrawが管理しているMarkdownファイルかどうかを判定する。 */
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

/** Excalidrawビューで開かれたファイルをMarkdownビューへ切り替える。 */
export async function switchToMarkdownViewIfExcalidraw(app: any, leaf: any, file: any): Promise<boolean> {
    // metadataCache/frontmatterの判定はビュー確定より遅れる場合があるため、
    // 実際のビューがExcalidrawかどうかを最終条件にする。
    // `.excalidraw.md` は図そのものなので、Excalidrawプラグインへ渡す。
    if (!leaf || !isExcalidrawBackedMarkdown(app, file) || file.name?.toLowerCase().endsWith('.excalidraw.md')) return false;
    if (leaf.view?.getViewType?.() !== 'excalidraw') return false;
    if (leaf.__sidebarMarkdownViewSwitching) return false;
    leaf.__sidebarMarkdownViewSwitching = true;

    try {
        // ExcalidrawView自身のAPIでファイルごとの表示モードもMarkdownにする。
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

/** Sidebar Explorer Tagからファイルを開く共通処理。 */
export async function openFileInMarkdownView(app: any, leaf: any, file: any): Promise<void> {
    if (!leaf || !file) return;
    await leaf.openFile(file);

    // 通常のMarkdownをユーザーが明示的にExcalidraw表示した場合は尊重する。
    if (!isExcalidrawBackedMarkdown(app, file) || file.name?.toLowerCase().endsWith('.excalidraw.md')) return;

    // Excalidraw側のfile-open処理が後からビューを戻すことがあるため、
    // 初回だけでなく、ビュー確定後にも再確認する。
    for (const delay of [0, 100, 300, 700, 1500]) {
        if (delay > 0) await new Promise((resolve) => globalThis.setTimeout(resolve, delay));
        await switchToMarkdownViewIfExcalidraw(app, leaf, file);
        if (leaf.view?.getViewType?.() !== 'excalidraw') return;
    }
}

/** 文字を入力できる要素（検索欄など）か。ここでのキー操作はサイドバーのショートカットにしない。 */
export function isTextEditingTarget(target: { tagName?: string; isContentEditable?: boolean } | null | undefined): boolean {
    if (!target) return false;
    return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable === true;
}

/**
 * 検索クエリに基づいてファイルをフィルタリングし、更新日時の降順でソートする。
 * クエリが空の場合は、タグが設定されていないファイルのみを抽出する。
 **/
export function filterFilesByTagQuery<T extends { stat: { mtime: number } }>(
    files: T[],
    query: string,
    getFileTags: (file: T) => string[] | null,
    options: { includeTopTaggedExcluded?: boolean } = {}
): T[] {
    const trimmedQuery = query.trim();
    const matches: T[] = [];

    if (!trimmedQuery) {
        // クエリが空のときは、タグが何も入っていないファイルを抽出する
        for (const file of files) {
            const tags = getFileTags(file);
            if (!tags || tags.length === 0) {
                matches.push(file);
            }
        }
    } else {
        const keywords = trimmedQuery.split(/[\s\u3000]+/).filter(k => k.length > 0).map(k => k.toLowerCase());
        
        // 通常のキーワードと除外キーワードを分類
        const includeKeywords: string[] = [];
        const excludeKeywords: string[] = [];
        for (const kw of keywords) {
            if (kw.startsWith('-') && kw.length > 1) {
                excludeKeywords.push(kw.slice(1));
            } else if (kw !== '-') {
                includeKeywords.push(kw);
            }
        }

        for (const file of files) {
            const tags = getFileTags(file) || [];
            
            // 1. 通常キーワード（AND検索）: すべての通常キーワードがタグに含まれていること
            const matchesAllInclude = includeKeywords.every(incKw => {
                return tags.some(tag => tag.toLowerCase().includes(incKw));
            });
            if (!matchesAllInclude) continue;

            // 2. 除外キーワード（NOT検索）: すべての除外キーワードがどのタグにも含まれていないこと
            const isTopTagged = options.includeTopTaggedExcluded && tags.some(tag =>
                tag.replace(/^#/, '').toLowerCase() === 'top'
            );
            const matchesNoExclude = isTopTagged || excludeKeywords.every(excKw => {
                return !tags.some(tag => tag.toLowerCase().includes(excKw));
            });
            if (!matchesNoExclude) continue;

            matches.push(file);
        }
    }

    // 更新日時の降順でソート
    return matches.sort((a, b) => b.stat.mtime - a.stat.mtime);
}

/**
 * クエリに基づいてMOCのファイル名を生成する。
 * 通常キーワードはアンダースコア（_）で連結し、除外キーワードは（中黒連結＋除く）の形式にする。
 **/
export function getMocFilename(query: string): string {
    const trimmed = query.trim();
    if (!trimmed) {
        return "タグなしファイル";
    }

    const keywords = trimmed.split(/[\s\u3000]+/).filter(k => k.length > 0);
    const includeKeywords: string[] = [];
    const excludeKeywords: string[] = [];

    for (const kw of keywords) {
        if (kw.startsWith('-') && kw.length > 1) {
            excludeKeywords.push(kw.slice(1));
        } else if (kw !== '-') {
            includeKeywords.push(kw);
        }
    }

    let name = "";
    if (includeKeywords.length > 0) {
        name += includeKeywords.join("_");
    }

    if (excludeKeywords.length > 0) {
        name += `(${excludeKeywords.join("・")}除く)`;
    }

    // ファイル名として無効な文字を置換する処理
    name = name.replace(/[\\/:*?"<>|]/g, "_");

    return name || "MOC";
}

export interface CachedMetadata {
    frontmatter?: {
        tags?: any;
        tag?: any;
        [key: string]: any;
    };
    tags?: {
        tag: string;
    }[];
}

export function extractTagsFromMetadata(
    cache: CachedMetadata | null | undefined,
    includeBodyTags: boolean
): string[] {
    if (!cache) return [];
    
    // フロントマターのタグを抽出
    const fmTags: string[] = [];
    if (cache.frontmatter) {
        // tags または tag プロパティをチェック
        const rawFmTags = cache.frontmatter.tags ?? cache.frontmatter.tag;
        if (rawFmTags) {
            if (Array.isArray(rawFmTags)) {
                for (const t of rawFmTags) {
                    if (typeof t === 'string' || typeof t === 'number') {
                        fmTags.push(String(t).trim());
                    }
                }
            } else if (typeof rawFmTags === 'string') {
                // `tags: a, b` の書き方は、カンマごとに別のタグとして扱う
                fmTags.push(...rawFmTags.split(',').map(t => t.trim()));
            } else if (typeof rawFmTags === 'number') {
                fmTags.push(String(rawFmTags));
            }
        }
    }

    // 重複を排除しつつ、先頭の '#' を除外する
    const cleanFmTags = fmTags
        .map(t => t.startsWith('#') ? t.slice(1) : t)
        .filter(Boolean);

    // 重複排除のための Set (ただし元のケース維持)
    const seen = new Set<string>();
    const resultTags: string[] = [];

    for (const tag of cleanFmTags) {
        const lower = tag.toLowerCase();
        if (!seen.has(lower)) {
            seen.add(lower);
            resultTags.push(tag);
        }
    }

    if (!includeBodyTags) {
        return resultTags;
    }

    // 本文内のタグ（cache.tags）も含める
    if (cache.tags) {
        for (const t of cache.tags) {
            if (t.tag) {
                const clean = t.tag.startsWith('#') ? t.tag.slice(1) : t.tag;
                const trimmed = clean.trim();
                if (trimmed) {
                    const lower = trimmed.toLowerCase();
                    if (!seen.has(lower)) {
                        seen.add(lower);
                        resultTags.push(trimmed);
                    }
                }
            }
        }
    }

    return resultTags;
}
