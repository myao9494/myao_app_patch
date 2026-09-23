/**
 * サイドバーエクスプローラータグプラグインのメインエントリーポイント
 * 
 * 仕様:
 * - ビュータイプ `VIEW_TYPE_SIDEBAR_EXPLORER_TAG` を登録し、サイドバーに表示する。
 * - Markdown本文中のタグやプロパティのタグがクリックされた際、タグ検索欄を更新して表示を絞り込む。
 *   - Ctrl/Cmdクリックでアペンド（AND検索）
 *   - Optionクリックで除外記号 `-` 付きでアペンド（NOT検索）
 * - 特定のlocalhost（3001/8001）URLに対し、Mac環境に限りユーザー名を置換して開く。
 * - 設定「本文のタグを有効にする」のオン・オフ切り替えに対応（オフ時はフロントマターのタグのみが検索・ノート一覧対象となる）。
 **/
import { App, MarkdownView, Menu, Notice, Plugin, TFile, WorkspaceLeaf, Workspace, PluginSettingTab, Setting } from 'obsidian';
import { SidebarExplorerTagView, VIEW_TYPE_SIDEBAR_EXPLORER_TAG } from './view';
import { rewriteLocalhostLinkForMac } from './utils';
import { around } from 'monkey-around';
import * as os from 'os';
import { parseMsgFileWithLibrary } from './msgParser';

export interface SidebarExplorerTagSettings {
    tagTargetFolders: string[];
    enableBodyTags: boolean;
}

const DEFAULT_SETTINGS: SidebarExplorerTagSettings = {
    tagTargetFolders: ["01_data", "02_MOC"],
    enableBodyTags: false
};

export default class SidebarExplorerTagPlugin extends Plugin {
    settings!: SidebarExplorerTagSettings;
    private selectedNoteTags = new Set<HTMLElement>();
    private noteTagAnchor: HTMLElement | null = null;
    private noteTagFocus: HTMLElement | null = null;
    private globalMsgParser: ((file: TFile) => ReturnType<typeof parseMsgFileWithLibrary>) | null = null;

    async loadSettings() {
        const loaded = await this.loadData() as Partial<SidebarExplorerTagSettings> | null;
        const tagTargetFolders = Array.isArray(loaded?.tagTargetFolders)
            ? loaded.tagTargetFolders.filter((folder): folder is string => typeof folder === 'string')
            : DEFAULT_SETTINGS.tagTargetFolders;
        const enableBodyTags = typeof loaded?.enableBodyTags === 'boolean'
            ? loaded.enableBodyTags
            : DEFAULT_SETTINGS.enableBodyTags;

        // 現行スキーマの値だけを保持し、廃止済み設定を data.json から取り除く。
        this.settings = { tagTargetFolders, enableBodyTags };
        await this.saveData(this.settings);
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    refreshTagViews() {
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SIDEBAR_EXPLORER_TAG)) {
            const view = leaf.view as SidebarExplorerTagView;
            view.refreshConfiguredScope();
        }
    }

    async onload() {
        const plugin = this;
        await this.loadSettings();
        this.globalMsgParser = (file: TFile) => parseMsgFileWithLibrary(this.app, file);
        (window as any)._sidebarExplorerParseMsgFile = this.globalMsgParser;
        (window as any).parseMsgFile = this.globalMsgParser;
        this.addSettingTab(new SidebarExplorerTagSettingTab(this.app, this));

        // Register View
        this.registerView(
            VIEW_TYPE_SIDEBAR_EXPLORER_TAG,
            (leaf) => new SidebarExplorerTagView(leaf, this)
        );

        // Add Ribbon Icon to open view
        this.addRibbonIcon('tags', 'Open Sidebar Explorer Tag', () => {
            this.activateView();
        });

        // Add Command: Open Sidebar
        this.addCommand({
            id: 'open-sidebar-explorer-tag',
            name: 'Open Sidebar Explorer Tag',
            callback: () => {
                this.activateView();
            }
        });

        this.patchGlobalSearchForGraphTags();

        this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
            this.clearNoteTagSelection();
            this.noteTagAnchor = null;
            this.noteTagFocus = null;
        }));

        // click より前に選択を確定し、Obsidian側のpill再描画との競合を避ける。
        this.registerDomEvent(document, 'pointerdown', (e: PointerEvent) => {
            const target = e.target as HTMLElement | null;
            const pill = target?.closest('.metadata-property[data-property-key="tags"] .multi-select-pill') as HTMLElement | null;
            if (!pill || target?.closest('.multi-select-pill-remove-button')) return;
            // Option+クリックは従来どおり除外タグ検索へ渡す。
            if (e.altKey) return;
            this.selectNoteTag(pill, e);
            e.preventDefault();
            e.stopImmediatePropagation();
        }, { capture: true });

        this.registerDomEvent(document, 'keydown', (e: KeyboardEvent) => {
            if (this.handleNoteTagKeydown(e)) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
            }
        }, { capture: true });

        this.registerDomEvent(document, 'paste', (e: ClipboardEvent) => {
            const target = e.target as HTMLElement | null;
            if (!this.isTagPropertyTarget(target)) return;
            const text = e.clipboardData?.getData('text/plain') ?? '';
            if (!text.trim()) {
                new Notice('クリップボードにテキストがありません');
                return;
            }
            e.preventDefault();
            e.stopImmediatePropagation();
            const tags = this.parseClipboardTags(text);
            if (tags.length === 0) {
                new Notice('クリップボードに有効なタグがありません');
                return;
            }
            this.clearTagPropertyInput(target);
            void this.pasteNoteTags(tags.map(tag => `#${tag}`).join(', '), true);
        }, { capture: true });

        // Search Query プロパティの値を右クリックすると、現在の値でtag_keyを上書きする。
        this.registerDomEvent(document, 'contextmenu', (e: MouseEvent) => {
            const target = e.target as HTMLElement | null;
            if (!this.isSearchQueryPropertyValueTarget(target)) return;

            e.preventDefault();
            e.stopImmediatePropagation();

            const menu = new Menu();
            menu.addItem((item) => {
                item
                    .setTitle('Search Queryをtag_keyへ送る')
                    .setIcon('search')
                    .onClick(() => {
                        const query = this.getActiveSearchQuery();
                        if (!query) {
                            new Notice('Search Queryが空です。');
                            return;
                        }
                        void this.updateTagSearch(query, false);
                        new Notice(`Search Query「${query}」をtag_keyへ読み込みました`);
                    });
            });
            menu.showAtMouseEvent(e);
        }, { capture: true });

        // ノート上部の tags プロパティでは、現在設定されているタグをまとめて扱えるようにする。
        this.registerDomEvent(document, 'contextmenu', (e: MouseEvent) => {
            const target = e.target as HTMLElement | null;
            const property = target?.closest('.metadata-property') as HTMLElement | null;
            if (!property || !this.isTagPropertyTarget(target)) return;

            const tags = this.getNotePropertyTagNames(property);
            if (tags.length === 0) return;

            e.preventDefault();
            e.stopImmediatePropagation();

            const tagText = tags.map(tag => `#${tag}`).join(', ');
            const menu = new Menu();
            menu.addItem((item) => {
                item
                    .setTitle('すべてのタグをコピー')
                    .setIcon('copy')
                    .onClick(() => {
                        void navigator.clipboard.writeText(tagText)
                            .then(() => new Notice(`${tags.length}個のタグをコピーしました`))
                            .catch((error) => {
                                console.error('タグのコピーに失敗しました', error);
                                new Notice('タグのコピーに失敗しました');
                            });
                    });
            });
            menu.addItem((item) => {
                item
                    .setTitle('すべてのタグをサイドバーエクスプローラーへ送る')
                    .setIcon('send')
                    .onClick(() => {
                        void this.updateTagSearch(tags.join(' '), false);
                        new Notice(`${tags.length}個のタグをサイドバーエクスプローラーへ送りました`);
                    });
            });
            menu.showAtMouseEvent(e);
        }, { capture: true });

        // 4. URLをグローバルにフックしてlocalhostリンクをMac用に書き換え
        // (MarkdownのプレビューやLive Previewでクリックされた場合、必ずどちらかが呼ばれる)
        const platform = process.platform;
        
        // window.open のパッチ
        this.register(
            // @ts-ignore
            around(window as any, {
                // @ts-ignore
                open: (next) => function (url?: string | URL, target?: string, features?: string) {
                    let finalUrl = url;
                    if (typeof finalUrl === 'string') {
                        // LocalhostリンクのMac用ユーザー名書き換え
                        if (platform === 'darwin' && (finalUrl.startsWith('http://localhost:3001/?filepath=') || finalUrl.startsWith('http://localhost:8001/api/open-path?path='))) {
                            try {
                                const username = os.userInfo().username;
                                finalUrl = rewriteLocalhostLinkForMac(finalUrl, platform, username);
                            } catch (err) {
                                console.error("Failed to rewrite localhost link", err);
                            }
                        }
                    }
                    return next.call(window, finalUrl, target, features);
                }
            })
        );

        // electron.shell.openExternal のパッチ
        try {
            // @ts-ignore
            const electron = require('electron');
            if (electron && electron.shell) {
                this.register(
                    // @ts-ignore
                    around(electron.shell as any, {
                        openExternal: (next: any) => function (url: string, options?: any) {
                            let finalUrl = url;
                            if (typeof finalUrl === 'string') {
                                // LocalhostリンクのMac用ユーザー名書き換え
                                if (platform === 'darwin' && (finalUrl.startsWith('http://localhost:3001/?filepath=') || finalUrl.startsWith('http://localhost:8001/api/open-path?path='))) {
                                    try {
                                        const username = os.userInfo().username;
                                        finalUrl = rewriteLocalhostLinkForMac(finalUrl, platform, username);
                                    } catch (err) {
                                        console.error("Failed to rewrite localhost link", err);
                                    }
                                }
                            }
                            return next.call(electron.shell, finalUrl, options);
                        }
                    })
                );
            }
        } catch (e) {
            console.warn("Could not patch electron.shell", e);
        }




        // ワークスペース上のクリックをリッスンし、Markdown内のタグやプロパティのタグがクリックされたか検知する
        this.registerDomEvent(document, 'click', (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (!target) return;

            // タグチップの × は Obsidian 標準の削除ボタン。ここでタグ検索用の
            // capture ハンドラーが preventDefault すると削除クリックまで止まるため、
            // この操作には一切介入しない。
            if (target.closest('.multi-select-pill-remove-button')) return;

            const isOption = e.altKey;
            const isExclude = isOption && e.shiftKey;
            const append = e.ctrlKey || e.metaKey || isOption;

            // 1. 本文中のタグ (.tag)
            if (target.matches('.tag')) {
                const tagText = target.innerText || target.textContent || "";
                if (tagText.startsWith('#')) {
                    let keyword = tagText.slice(1);
                    if (isExclude) {
                        keyword = "-" + keyword;
                    }
                    this.updateTagSearch(keyword, append);
                    e.preventDefault();
                    e.stopPropagation();
                }
            }
            // 2. プロパティビューのタグ (.multi-select-pill またはその内部要素)
            else {
                const pill = target.closest('.multi-select-pill') as HTMLElement;
                if (pill) {
                    if (!isOption) {
                        e.preventDefault();
                        e.stopImmediatePropagation();
                        return;
                    }
                    // content要素からテキストを取得
                    const contentTarget = pill.querySelector('.multi-select-pill-content') as HTMLElement;
                    if (contentTarget) {
                        const tagText = contentTarget.innerText || contentTarget.textContent || "";
                        if (tagText) {
                            // プロパティのタグは '#' が付いていないことが多い
                            let keyword = tagText.startsWith('#') ? tagText.slice(1) : tagText;
                            if (isExclude) {
                                keyword = "-" + keyword;
                            }
                            this.updateTagSearch(keyword, append);
                            e.preventDefault();
                            e.stopPropagation();
                        }
                    }
                }
            }
        }, { capture: true });
    }

    onunload() {
        if ((window as any)._sidebarExplorerParseMsgFile === this.globalMsgParser) {
            delete (window as any)._sidebarExplorerParseMsgFile;
        }
        if ((window as any).parseMsgFile === this.globalMsgParser) {
            delete (window as any).parseMsgFile;
        }
        this.globalMsgParser = null;
    }

    private getActiveNoteTagPills(): HTMLElement[] {
        const activeLeaf = document.querySelector('.workspace-leaf.mod-active');
        if (!activeLeaf) return [];
        return Array.from(activeLeaf.querySelectorAll('.metadata-property[data-property-key="tags"] .multi-select-pill')) as HTMLElement[];
    }

    private getNotePropertyTagNames(property: HTMLElement): string[] {
        const seen = new Set<string>();
        const tags: string[] = [];
        for (const pill of Array.from(property.querySelectorAll('.multi-select-pill'))) {
            const tag = (pill.querySelector('.multi-select-pill-content')?.textContent ?? '')
                .trim()
                .replace(/^#/, '');
            if (!tag || seen.has(tag.toLowerCase())) continue;
            seen.add(tag.toLowerCase());
            tags.push(tag);
        }
        return tags;
    }

    private isTagPropertyTarget(target: HTMLElement | null): boolean {
        if (!target) return false;
        const property = target.closest('.metadata-property');
        const key = property?.getAttribute('data-property-key')?.toLowerCase();
        if (key === 'tags' || key === 'tag') return true;
        return !!target.closest('.metadata-property-value[data-property-key="tags"], .multi-select-container[data-property-key="tags"]');
    }

    private isSearchQueryPropertyValueTarget(target: HTMLElement | null): boolean {
        if (!target) return false;
        const property = target.closest('.metadata-property') as HTMLElement | null;
        if (!property || !this.isSearchQueryProperty(property)) return false;
        if (target.closest('.metadata-property-key')) return false;

        return Boolean(target.closest(
            '.metadata-property-value, .metadata-input-longtext, .metadata-input-text, input, textarea, [contenteditable="true"]'
        ));
    }

    private isSearchQueryProperty(property: HTMLElement): boolean {
        const dataKey = property.getAttribute('data-property-key') || '';
        const label = property.querySelector('.metadata-property-key')?.textContent || '';
        return [dataKey, label].some(value =>
            value.toLowerCase().replace(/[^a-z0-9]/g, '') === 'searchquery'
        );
    }

    private getActiveSearchQuery(): string | null {
        const file = this.app.workspace.getActiveFile();
        if (!file) return null;

        const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
        if (!frontmatter) return null;

        const key = Object.keys(frontmatter).find(candidate =>
            candidate.toLowerCase().replace(/[^a-z0-9]/g, '') === 'searchquery'
        );
        if (!key) return null;

        const query = String(frontmatter[key] ?? '').trim();
        return query || null;
    }

    private clearTagPropertyInput(target: HTMLElement | null) {
        const input = target?.closest('input, textarea, [contenteditable="true"]') as HTMLInputElement | HTMLTextAreaElement | HTMLElement | null;
        if (!input) return;
        if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
            input.value = '';
        } else {
            input.textContent = '';
        }
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    private setNativeInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
        const prototype = input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        setter?.call(input, value);
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    }

    private async pasteTagsThroughPropertyInput(target: HTMLElement | null, tags: string[]) {
        const input = target?.closest('input, textarea') as HTMLInputElement | HTMLTextAreaElement | null;
        if (!input) {
            await this.pasteNoteTags(tags.map(tag => `#${tag}`).join(', '));
            return;
        }

        try {
            input.focus();
            for (const tag of tags) {
                this.setNativeInputValue(input, tag);
                input.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'Enter',
                    code: 'Enter',
                    keyCode: 13,
                    which: 13,
                    bubbles: true,
                    cancelable: true
                }));
                input.dispatchEvent(new KeyboardEvent('keyup', {
                    key: 'Enter',
                    code: 'Enter',
                    keyCode: 13,
                    which: 13,
                    bubbles: true
                }));
                await new Promise(resolve => window.setTimeout(resolve, 30));
            }
            this.setNativeInputValue(input, '');
            new Notice(`${tags.length}個のタグを貼り付けました`);
        } catch (error) {
            console.error('タグ入力UIへの貼り付けに失敗しました', error);
            // UI APIが変わった場合にも、Markdownへの保存自体は継続する。
            await this.pasteNoteTags(tags.map(tag => `#${tag}`).join(', '));
        }
    }

    private clearNoteTagSelection() {
        for (const pill of this.selectedNoteTags) pill.classList.remove('is-note-tag-selected');
        this.selectedNoteTags.clear();
    }

    private pruneNoteTagSelection() {
        const activePills = new Set(this.getActiveNoteTagPills());
        for (const pill of Array.from(this.selectedNoteTags)) {
            if (!pill.isConnected || !activePills.has(pill)) {
                pill.classList.remove('is-note-tag-selected');
                this.selectedNoteTags.delete(pill);
            }
        }
        if (this.noteTagAnchor && !activePills.has(this.noteTagAnchor)) this.noteTagAnchor = null;
        if (this.noteTagFocus && !activePills.has(this.noteTagFocus)) this.noteTagFocus = null;
    }

    private selectNoteTag(pill: HTMLElement, e: MouseEvent | PointerEvent) {
        this.pruneNoteTagSelection();
        const pills = this.getActiveNoteTagPills();
        if (e.shiftKey && this.noteTagAnchor) {
            const startIndex = pills.indexOf(this.noteTagAnchor);
            const endIndex = pills.indexOf(pill);
            if (startIndex >= 0 && endIndex >= 0) {
                this.clearNoteTagSelection();
                const [start, end] = startIndex < endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
                for (const selected of pills.slice(start, end + 1)) {
                    selected.classList.add('is-note-tag-selected');
                    this.selectedNoteTags.add(selected);
                }
                this.noteTagFocus = pill;
                return;
            }
        }

        if (e.metaKey || e.ctrlKey || e.shiftKey) {
            if (this.selectedNoteTags.has(pill)) {
                pill.classList.remove('is-note-tag-selected');
                this.selectedNoteTags.delete(pill);
            } else {
                pill.classList.add('is-note-tag-selected');
                this.selectedNoteTags.add(pill);
                this.noteTagAnchor = pill;
            }
            this.noteTagFocus = pill;
            return;
        }

        this.clearNoteTagSelection();
        pill.classList.add('is-note-tag-selected');
        this.selectedNoteTags.add(pill);
        this.noteTagAnchor = pill;
        this.noteTagFocus = pill;
    }

    private getSelectedNoteTagNames(): string[] {
        return Array.from(this.selectedNoteTags)
            .filter(pill => pill.isConnected)
            .map(pill => (pill.querySelector('.multi-select-pill-content')?.textContent ?? '').trim().replace(/^#/, ''))
            .filter(Boolean);
    }

    private handleNoteTagKeydown(e: KeyboardEvent): boolean {
        const target = e.target instanceof HTMLElement ? e.target : null;
        // Grimoire のノートブックを含む通常のエディタ入力では、DOM探索やタグ一覧取得を行わない。
        if (target?.isContentEditable || target?.matches('input, textarea')) return false;

        const inTagProperty = this.isTagPropertyTarget(target);
        if (this.selectedNoteTags.size === 0 && !inTagProperty) return false;

        const commandKey = e.metaKey || e.ctrlKey;
        const key = e.key.toLowerCase();
        this.pruneNoteTagSelection();
        const pills = this.getActiveNoteTagPills();
        if (pills.length === 0 && !(inTagProperty && commandKey && key === 'v')) return false;

        if (commandKey && key === 'a') {
            if (this.selectedNoteTags.size > 0) {
                this.clearNoteTagSelection();
                this.noteTagAnchor = null;
                this.noteTagFocus = null;
                return true;
            }
            this.clearNoteTagSelection();
            for (const pill of pills) {
                pill.classList.add('is-note-tag-selected');
                this.selectedNoteTags.add(pill);
            }
            this.noteTagAnchor = pills[0] ?? null;
            this.noteTagFocus = pills[pills.length - 1] ?? null;
            return true;
        }
        if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
            const direction = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
            const focusIndex = Math.max(0, pills.indexOf(this.noteTagFocus ?? this.noteTagAnchor ?? pills[0]));
            const nextIndex = Math.max(0, Math.min(pills.length - 1, focusIndex + direction));
            const anchor = this.noteTagAnchor ?? pills[focusIndex];
            const anchorIndex = pills.indexOf(anchor);
            this.clearNoteTagSelection();
            const [start, end] = anchorIndex < nextIndex ? [anchorIndex, nextIndex] : [nextIndex, anchorIndex];
            for (const pill of pills.slice(start, end + 1)) {
                pill.classList.add('is-note-tag-selected');
                this.selectedNoteTags.add(pill);
            }
            this.noteTagAnchor = anchor;
            this.noteTagFocus = pills[nextIndex];
            return true;
        }
        if (commandKey && key === 'c' && this.selectedNoteTags.size > 0) {
            const tags = this.getSelectedNoteTagNames();
            void navigator.clipboard.writeText(tags.map(tag => `#${tag}`).join(', '));
            new Notice(`${tags.length}個のタグをコピーしました`);
            return true;
        }
        if (commandKey && key === 'v') {
            void this.pasteNoteTags(undefined, true);
            return true;
        }
        if ((e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)) && this.selectedNoteTags.size > 0) {
            void this.deleteSelectedNoteTags();
            return true;
        }
        return false;
    }

    private parseClipboardTags(text: string): string[] {
        const hashTags = text.match(/#[^\s,\[\]]+/g);
        const values = hashTags ?? text.replace(/^\s*tags\s*:/i, '').split(/[\s,\[\]]+/);
        return Array.from(new Set(values.map(value => value.replace(/^#/, '').trim()).filter(Boolean)));
    }

    private async pasteNoteTags(clipboardText?: string, reloadAfterPaste: boolean = false) {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
            new Notice('貼り付け先のノートが見つかりません');
            return;
        }
        try {
            const text = clipboardText ?? await navigator.clipboard.readText();
            const tags = this.parseClipboardTags(text);
            if (tags.length === 0) {
                new Notice('クリップボードに有効なタグがありません');
                return;
            }
            await this.app.fileManager.processFrontMatter(file, frontmatter => {
                const current = Array.isArray(frontmatter.tags) ? frontmatter.tags : frontmatter.tags ? [frontmatter.tags] : [];
                const merged = new Map<string, string>();
                for (const value of [...current, ...tags]) {
                    const tag = String(value).replace(/^#/, '');
                    merged.set(tag.toLowerCase(), tag);
                }
                frontmatter.tags = Array.from(merged.values());
            });
            if (reloadAfterPaste) {
                await this.reloadActiveNote(file);
            } else {
                await this.refreshActiveMetadataEditor(file);
            }
            new Notice(`${tags.length}個のタグを「${file.basename}」へ貼り付けました`);
        } catch (error) {
            console.error('タグの貼り付けに失敗しました', error);
            new Notice(`タグの貼り付けに失敗しました: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async reloadActiveNote(file: TFile) {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || view.file?.path !== file.path) return;
        const leaf = view.leaf;
        const viewState = leaf.getViewState();
        await leaf.setViewState({ type: 'empty', active: true });
        await leaf.setViewState(viewState, { focus: true });
    }

    private async refreshActiveMetadataEditor(file: TFile) {
        // 入力中のプロパティ部品は外部更新を保留するため、まず編集を確定させる。
        const activeElement = document.activeElement as HTMLElement | null;
        if (this.isTagPropertyTarget(activeElement)) {
            this.clearTagPropertyInput(activeElement);
            activeElement?.blur();
        }

        // metadata cache の更新はファイル書き込みより少し遅れて届く。
        await new Promise<void>(resolve => {
            let finished = false;
            const ref = this.app.metadataCache.on('changed', changedFile => {
                if (changedFile.path !== file.path || finished) return;
                finished = true;
                this.app.metadataCache.offref(ref);
                resolve();
            });
            window.setTimeout(() => {
                if (finished) return;
                finished = true;
                this.app.metadataCache.offref(ref);
                resolve();
            }, 300);
        });

        const view = this.app.workspace.getActiveViewOfType(MarkdownView) as (MarkdownView & {
            metadataEditor?: { synchronize?: () => void; render?: () => void };
            requestUpdate?: () => void;
        }) | null;
        if (view?.file?.path !== file.path) return;
        try { view.metadataEditor?.synchronize?.(); } catch (error) { console.debug('metadata synchronize skipped', error); }
        try { view.metadataEditor?.render?.(); } catch (error) { console.debug('metadata render skipped', error); }
        try { view.requestUpdate?.(); } catch (error) { console.debug('view update skipped', error); }
        this.app.workspace.trigger('layout-change');
    }

    private async deleteSelectedNoteTags() {
        const file = this.app.workspace.getActiveFile();
        const tags = this.getSelectedNoteTagNames();
        if (!file || tags.length === 0) return;
        const removing = new Set(tags.map(tag => tag.toLowerCase()));
        await this.app.fileManager.processFrontMatter(file, frontmatter => {
            const current = Array.isArray(frontmatter.tags) ? frontmatter.tags : frontmatter.tags ? [frontmatter.tags] : [];
            frontmatter.tags = current.filter((value: unknown) => !removing.has(String(value).replace(/^#/, '').toLowerCase()));
        });
        this.clearNoteTagSelection();
        new Notice(`${tags.length}個のタグを削除しました`);
    }

    async activateView() {
        const { workspace } = this.app;

        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType(VIEW_TYPE_SIDEBAR_EXPLORER_TAG);

        if (leaves.length > 0) {
            leaf = leaves[0];
        } else {
            leaf = workspace.getRightLeaf(false);
            if (leaf) await leaf.setViewState({ type: VIEW_TYPE_SIDEBAR_EXPLORER_TAG, active: true });
        }

        if (leaf) workspace.revealLeaf(leaf);
    }

    private patchGlobalSearchForGraphTags() {
        const plugin = this;
        const installPatch = () => {
            const globalSearch = (this.app as App & {
                internalPlugins?: { getEnabledPluginById?: (id: string) => any };
            }).internalPlugins?.getEnabledPluginById?.('global-search');

            if (!globalSearch || typeof globalSearch.openGlobalSearch !== 'function') {
                return;
            }

            const target = globalSearch as { openGlobalSearch: (query: string) => unknown };
            if ((target.openGlobalSearch as { __sidebarExplorerTagPatched?: boolean }).__sidebarExplorerTagPatched) {
                return;
            }

            this.register(
                around(target, {
                    openGlobalSearch: (next: (query: string) => unknown) => (query: string) => {
                        const keyword = plugin.extractGraphTagKeywordFromQuery(query);
                        if (keyword && plugin.isGraphViewActive()) {
                            void plugin.updateTagSearch(keyword, false);
                            return;
                        }

                        return next.call(target, query);
                    }
                })
            );

            (target.openGlobalSearch as { __sidebarExplorerTagPatched?: boolean }).__sidebarExplorerTagPatched = true;
        };

        installPatch();
        this.app.workspace.onLayoutReady(() => {
            installPatch();
        });
    }

    private isGraphViewActive(): boolean {
        const workspaceAny = this.app.workspace as Workspace & { activeLeaf?: WorkspaceLeaf | null };
        const activeLeaf = workspaceAny.activeLeaf ?? this.app.workspace.getMostRecentLeaf();
        const viewType = activeLeaf?.view?.getViewType?.();
        return viewType === 'graph' || viewType === 'localgraph';
    }

    private extractTagKeywordFromQuery(query: unknown): string | null {
        if (typeof query !== 'string') return null;

        const trimmed = query.trim();
        if (!trimmed) return null;

        const directTagMatch = trimmed.match(/^#(.+)$/);
        if (directTagMatch) {
            return directTagMatch[1].trim() || null;
        }

        const searchTagMatch = trimmed.match(/^tag:\s*"?#?(.+?)"?$/i);
        if (searchTagMatch) {
            return searchTagMatch[1].trim() || null;
        }

        return null;
    }

    private extractGraphTagKeywordFromQuery(query: unknown): string | null {
        return this.extractTagKeywordFromQuery(query);
    }

    // タグ検索欄を更新するメソッド
    async updateTagSearch(keyword: string, append: boolean = false) {
        // ビューがなければ開く
        const { workspace } = this.app;
        let leaves = workspace.getLeavesOfType(VIEW_TYPE_SIDEBAR_EXPLORER_TAG);
        if (leaves.length === 0) {
            await this.activateView();
            leaves = workspace.getLeavesOfType(VIEW_TYPE_SIDEBAR_EXPLORER_TAG);
        }

        if (leaves.length > 0) {
            const view = leaves[0].view as SidebarExplorerTagView;
            if (view) {
                // Workspaceにアクティブにして前面に出す
                workspace.revealLeaf(leaves[0]);
                // ビュー側の検索キューに追加して更新
                view.setFileSearchQuery(keyword, append);
            }
        }
    }
}

class SidebarExplorerTagSettingTab extends PluginSettingTab {
    plugin: SidebarExplorerTagPlugin;

    constructor(app: App, plugin: SidebarExplorerTagPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Sidebar Explorer Tag 設定' });

        new Setting(containerEl)
            .setName('タグ管理対象フォルダ')
            .setDesc('Vaultルートからの相対パスを1行ずつ入力します。空欄の場合はVault全体を対象にします。')
            .addTextArea(text => text
                .setPlaceholder('01_data\n02_MOC')
                .setValue(this.plugin.settings.tagTargetFolders.join('\n'))
                .onChange(async (value) => {
                    this.plugin.settings.tagTargetFolders = value
                        .split(/\r?\n/)
                        .map(path => path.trim().replace(/^\/+|\/+$/g, ''))
                        .filter((path, index, paths) => path.length > 0 && paths.indexOf(path) === index);
                    await this.plugin.saveSettings();
                    this.plugin.refreshTagViews();
                }));

        new Setting(containerEl)
            .setName('本文のタグを有効にする')
            .setDesc('オンにすると、Markdown本文中に書かれたタグ（#tag）も検索やノート一覧の対象にします。オフにすると、フロントマター（YAML）の tags: に書かれたタグのみを対象にします。')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableBodyTags)
                .onChange(async (value) => {
                    this.plugin.settings.enableBodyTags = value;
                    await this.plugin.saveSettings();
                    this.plugin.refreshTagViews();
                }));

    }
}
