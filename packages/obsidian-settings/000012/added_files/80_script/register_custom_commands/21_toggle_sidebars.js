// =============================================================================
// 左右両サイドバーの表示・非表示一括切り替え（Option + B）
// =============================================================================

/**
 * 左右両サイドバーの表示・非表示を一括切り替え（トグル）する
 * 左右どちらか一方でも開いている場合は両方閉じ（全画面化）、両方閉じている場合は両方開く
 **/
const toggleBothSidebars = () => {
    const leftSplit = app.workspace?.leftSplit;
    const rightSplit = app.workspace?.rightSplit;

    // サイドバーが開いているかを判定（APIの collapsed プロパティおよび要素の表示幅に基づく正確な判定）
    const isSidebarOpen = (split, selector) => {
        if (split && typeof split.collapsed === "boolean") {
            return !split.collapsed;
        }
        if (split?.containerEl && typeof split.containerEl.offsetWidth === "number") {
            return split.containerEl.offsetWidth > 0;
        }
        if (selector) {
            const el = document.querySelector(selector);
            if (el && typeof el.offsetWidth === "number") {
                return el.offsetWidth > 0;
            }
        }
        return false;
    };

    const isLeftOpen = isSidebarOpen(leftSplit, ".workspace-split.mod-left-split");
    const isRightOpen = isSidebarOpen(rightSplit, ".workspace-split.mod-right-split");

    if (isLeftOpen || isRightOpen) {
        // どちらか一方でも開いているなら両方閉じる
        if (leftSplit && typeof leftSplit.collapse === "function") {
            leftSplit.collapse();
        } else if (isLeftOpen) {
            app.commands?.executeCommandById?.("app:toggle-left-sidebar");
        }

        if (rightSplit && typeof rightSplit.collapse === "function") {
            rightSplit.collapse();
        } else if (isRightOpen) {
            app.commands?.executeCommandById?.("app:toggle-right-sidebar");
        }
    } else {
        // 両方閉じているなら両方開く
        if (leftSplit && typeof leftSplit.expand === "function") {
            leftSplit.expand();
        } else {
            app.commands?.executeCommandById?.("app:toggle-left-sidebar");
        }

        if (rightSplit && typeof rightSplit.expand === "function") {
            rightSplit.expand();
        } else {
            app.commands?.executeCommandById?.("app:toggle-right-sidebar");
        }
    }
};

window.toggleBothSidebars = toggleBothSidebars;

// コマンド登録
if (app.commands && typeof app.commands.addCommand === "function") {
    app.commands.addCommand({
        id: "custom:toggle-both-sidebars",
        name: "左右両方のサイドバー表示/非表示を切り替え",
        callback: toggleBothSidebars,
        hotkeys: [
            {
                modifiers: ["Alt"],
                key: "b"
            }
        ]
    });
}

/**
 * Option + B (Win/Linux: Alt + B) のキーイベントハンドラー
 * どの要素（エディタ、サイドバー、マインドマップ、余白等）がアクティブであっても確実にフックする
 **/
const handleToggleSidebarsShortcut = (e) => {
    // Option (Mac) または Alt (Win/Linux) + B
    // metaKey (Cmd) や ctrlKey は押されていないこと（エディタの太字等の標準ショートカットを妨害しない）
    if (e.altKey && !e.metaKey && !e.ctrlKey) {
        // MacのOption+B入力値 (∫ など) や e.code === "KeyB"、e.key === "b" / "B" に対応
        const isB = e.code === "KeyB" || (e.key && e.key.toLowerCase() === "b") || e.key === "∫";
        if (isB) {
            e.preventDefault();
            e.stopPropagation();
            if (typeof e.stopImmediatePropagation === "function") {
                e.stopImmediatePropagation();
            }
            toggleBothSidebars();
        }
    }
};

registerDocumentListener("_customToggleSidebarsShortcutListener", "keydown", handleToggleSidebarsShortcut);
console.log("Global Toggle Both Sidebars shortcut registered (Option+B on Mac, Alt+B on others)");
