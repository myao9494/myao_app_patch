// =============================================================================
// 共通ヘルパー（Obsidianモジュール取得、リスナー登録、メニュー項目の並べ替え）
// =============================================================================

/**
 * Obsidian のモジュール（Modal, Notice, TFile, MarkdownView などのクラス）を取得する。
 * require("obsidian") を使えない環境では、Templater が保持するモジュール、tp.obsidian、
 * window.obsidian の順に探す。見つからない場合は null / undefined を返すため、呼び出し側で確認する。
 **/
const getObsidianModule = () => {
    try {
        return require("obsidian");
    } catch {
        return app.plugins?.plugins?.["templater-obsidian"]?.obsidian
            || (typeof tp !== "undefined" ? tp.obsidian : null)
            || (typeof window !== "undefined" ? window.obsidian : null);
    }
};

// Obsidianモジュールから、このスクリプト全体で使うクラスを取得
const obsidianLib = getObsidianModule();
const Modal = obsidianLib?.Modal || class {};
const Setting = obsidianLib?.Setting;
const Notice = obsidianLib?.Notice || (typeof window !== 'undefined' && window.Notice) || (typeof global !== 'undefined' && global.Notice) || class {};

/**
 * document へグローバルリスナーを登録する（キャプチャ段階）。
 * 登録したハンドラを window[key] に保持し、このスクリプトを再実行したときは前回のハンドラを
 * 解除してから登録し直すため、同じ処理が二重に動かない。
 * @param {string} key ハンドラを保持する window のプロパティ名（_custom… で始める）
 * @param {string|string[]} types イベント名（複数指定可）
 * @param {(event: Event) => void} handler
 **/
const registerDocumentListener = (key, types, handler) => {
    const eventTypes = Array.isArray(types) ? types : [types];
    const previous = window[key];
    if (previous) eventTypes.forEach((type) => document.removeEventListener(type, previous, true));
    window[key] = handler;
    eventTypes.forEach((type) => document.addEventListener(type, handler, true));
};

/**
 * Obsidian のワークスペースイベント（file-menu, editor-menu, file-open, tag-menu など）へ登録する。
 * registerDocumentListener と同じく、再実行時は前回のハンドラを解除してから登録し直す。
 **/
const registerWorkspaceEvent = (key, name, handler) => {
    if (window[key]) app.workspace.off(name, window[key]);
    window[key] = handler;
    app.workspace.on(name, handler);
};

/**
 * Obsidian の保管庫イベント（modify, rename など）へ登録する。
 * registerWorkspaceEvent と同じく、再実行時は前回のハンドラを解除してから登録し直す。
 **/
const registerVaultEvent = (key, name, handler) => {
    if (window[key]) app.vault.off(name, window[key]);
    window[key] = handler;
    app.vault.on(name, handler);
};

/**
 * メニューの描画後に、指定した文言を含む項目をメニューの先頭へ移動する。
 * 配列の順に1つずつ先頭へ移動するため、配列の後ろに書いた項目ほど上に並ぶ。
 * 項目の検索は移動を始める前の並びに対して行い、同じ文言を含む項目が複数ある場合は最初のものを対象にする。
 * （Obsidian の Menu には項目の位置を指定するAPIが無いため、表示文言でDOM要素を探している）
 **/
const prependMenuItemsByText = (menu, titles) => {
    if (!menu.dom) return;
    const items = Array.from(menu.dom.querySelectorAll(".menu-item"));
    titles.forEach((title) => {
        const item = items.find((el) => el.textContent.includes(title));
        if (item) menu.dom.prepend(item);
    });
};

/**
 * ネイティブメニュー（macOS 標準のメニュー）向けに、メニュー項目の並びを書き換える。
 * ネイティブメニューは表示時に menu.items から作られ、DOM の並べ替えは反映されないため、
 * 項目の配列とセクションを直接並べ替える。結果の並びは DOM 版（prependMenuItemsByText /
 * insertAfterRenameOrPrepend）と同じになる。
 * @param {object} menu Obsidian の Menu
 * @param {{prepend?: string[], afterRename?: string[]}} operation
 *   prepend: 先頭へ移動する項目の文言（後ろに書いた項目ほど上に並ぶ）
 *   afterRename: 「名前を変更」の直後へ移動する項目の文言（無ければ先頭へ移動）
 **/
const reorderNativeMenuItems = (menu, operation) => {
    if (!Array.isArray(menu?.items)) return;
    // ※ ここで menu.sort() は呼ばない。表示前に呼ぶと、Obsidian 標準の項目（サブメニュー化される
    //    セクションなど）の並びが変わってしまう（実機で確認）。
    const isMenuItem = (item) => Boolean(item?.titleEl);
    const getTitle = (item) => item.titleEl.textContent || "";
    // 文言が完全に一致する項目を優先し、無ければ文言を含む最初の項目を対象にする。
    const findItem = (items, title) =>
        items.find((item) => getTitle(item) === title) || items.find((item) => getTitle(item).includes(title));
    // 表示時は「セクションの並び順 → 配列内の順」で並ぶ（セクションなしの項目は末尾）。
    // 最初に表示されるセクションへ入れ、配列の先頭へ動かすと、メニューの一番上に並ぶ。
    const getTopSection = () => {
        if (Array.isArray(menu.sections) && menu.sections.length > 0) return menu.sections[0];
        return menu.items.find((item) => isMenuItem(item) && item.section)?.section || "";
    };
    const moveToTop = (target) => {
        const index = menu.items.indexOf(target);
        if (index < 0) return;
        const topSection = getTopSection();
        menu.items.splice(index, 1);
        menu.items.unshift(target);
        target.section = topSection;
    };

    if (Array.isArray(operation.prepend)) {
        const snapshot = menu.items.filter(isMenuItem);
        operation.prepend
            .map((title) => findItem(snapshot, title))
            .filter(Boolean)
            .forEach(moveToTop);
    }

    (operation.afterRename || []).forEach((title) => {
        const snapshot = menu.items.filter(isMenuItem);
        const target = findItem(snapshot, title);
        if (!target) return;
        const rename = snapshot.find((item) => getTitle(item).includes("Rename") || getTitle(item).includes("名前を変更"));
        if (!rename || rename === target) {
            moveToTop(target);
            return;
        }
        menu.items.splice(menu.items.indexOf(target), 1);
        menu.items.splice(menu.items.indexOf(rename) + 1, 0, target);
        target.section = rename.section;
    });
};

// ネイティブメニュー向けの並べ替えを、メニューが表示される直前まで貯めておく場所
const pendingNativeMenuReorders = new WeakMap();

/**
 * 追加したメニュー項目の並べ替えを予約する。
 * - DOM で描画されるメニュー: 描画を待つため delay ミリ秒後に DOM を並べ替える。
 * - ネイティブメニュー: 表示と同時に項目が確定するため、flushNativeMenuReorders が呼ばれた時点で
 *   delay の小さい順（DOM 版でタイマーが発火する順）にまとめて並べ替える。
 **/
const reorderMenuItemsLater = (menu, delay, operation) => {
    if (menu?.useNativeMenu && Array.isArray(menu.items)) {
        const queue = pendingNativeMenuReorders.get(menu) || [];
        queue.push({ delay, operation });
        pendingNativeMenuReorders.set(menu, queue);
        return;
    }
    setTimeout(() => {
        if (Array.isArray(operation.prepend)) prependMenuItemsByText(menu, operation.prepend);
        (operation.afterRename || []).forEach((title) => insertAfterRenameOrPrepend(menu, title));
    }, delay);
};

/**
 * 予約済みのネイティブメニュー向けの並べ替えを実行する。メニューを表示する直前（イベントハンドラの最後）に呼ぶ。
 **/
const flushNativeMenuReorders = (menu) => {
    const queue = menu ? pendingNativeMenuReorders.get(menu) : null;
    if (!queue) return;
    pendingNativeMenuReorders.delete(menu);
    try {
        // Array.prototype.sort は安定ソートのため、同じ delay の予約は登録順のまま実行される。
        queue.slice().sort((a, b) => a.delay - b.delay).forEach(({ operation }) => reorderNativeMenuItems(menu, operation));
    } catch (error) {
        console.warn("Failed to reorder native menu items:", error);
    }
};

/**
 * メニューへ項目を追加するイベントハンドラ（file-menu / editor-menu / tag-menu）を包み、
 * ハンドラの終了時にネイティブメニュー向けの並べ替えを実行する。
 **/
const withNativeMenuReorder = (handler) => (menu, ...args) => {
    try {
        return handler(menu, ...args);
    } finally {
        flushNativeMenuReorders(menu);
    }
};
