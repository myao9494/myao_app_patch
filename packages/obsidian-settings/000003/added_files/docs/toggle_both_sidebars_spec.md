<!--
/**
 * 左右両サイドバーの表示非表示トグル（Option + B）技術仕様書
 * 
 * 1. 左右どちらか一方でも開いている場合は両方閉じて作業画面を最大化
 * 2. 両方閉じている場合は両方開いて作業状態を復元
 * 3. Option + B (Mac) / Alt + B (Win/Linux) による確実なショートカット制御
 * 4. エディタの太字装飾（Cmd+B）と衝突せず、どこがアクティブでも確実に動作
 * 5. custom:toggle-both-sidebars コマンドの登録
 **/
-->

# 左右両サイドバー表示非表示トグル（Option + B）技術仕様書

## 1. 概要
マインドマップの描画、Excalidrawの作図、Markdownの執筆作業において、画面領域を最大限に活用できるよう、`Option + B`（Windows/Linuxでは `Alt + B`）を押下することで、左右両方のサイドバーを一括で開閉（トグル）できるようにします。

---

## 2. 背景と意図
- マインドマップや大規模な図を描く際、画面左右のエクスプローラーやアウトライン、バックリンクなどのサイドバーが表示されていると、描画キャンバスの横幅が狭まり作業性が低下します。
- 当初 `Command + B` を採用した際、サイドバーにフォーカスがある時は閉じられたものの、閉じた後にエディタ等へフォーカスが移ると Obsidian 組み込みの太字装飾（Bold）コマンドと衝突し、再度開く（再表示）動作が行えない課題が発生しました。
- そこで、エディタの既存機能と一切競合しない `Option + B`（Win/Linux: `Alt + B`）に変更し、エディタ、サイドバー、マインドマップ、余白など、どのような要素がアクティブな状態であっても確実に一括トグルできるように設計を改良しました。

---

## 3. 実装詳細仕様

### 3.1 開閉トグル判定ロジック (`toggleBothSidebars`)
Obsidianの Workspace API（`app.workspace.leftSplit`、`app.workspace.rightSplit`）の `collapsed` プロパティおよび DOM 要素の表示幅（`offsetWidth > 0`）を参照し、クラス名の有無による誤判定を完全排除した高精度な開閉判定を行います。

1. **左右の状態取得 (`isSidebarOpen`)**:
   - `split && typeof split.collapsed === "boolean"` の場合は `!split.collapsed` を最優先判定。
   - API が利用できない、または判定不能な場合は、コンテナ要素（`split.containerEl`）または DOM セレクタ（`.workspace-split.mod-left-split` / `.workspace-split.mod-right-split`）の `offsetWidth > 0`（閉じている時は幅が 0）で判定。
   - これにより、閉じた後に「開いている」と誤判定されて再表示できなくなる不具合を根本的に防止。
2. **分岐処理**:
   - **いずれか一方でも開いている場合（`isLeftOpen || isRightOpen`）**:
     - 左が開いていれば `leftSplit.collapse()`（またはフォールバックとして `app:toggle-left-sidebar`）で閉じる。
     - 右が開いていれば `rightSplit.collapse()`（またはフォールバックとして `app:toggle-right-sidebar`）で閉じる。
   - **両方とも閉じている場合**:
     - `leftSplit.expand()`（またはフォールバックとして `app:toggle-left-sidebar`）で開く。
     - `rightSplit.expand()`（またはフォールバックとして `app:toggle-right-sidebar`）で開く。

### 3.2 キーボードショートカット検知 (`handleToggleSidebarsShortcut`)
- **対象キー**:
  - Mac: `Option + B`（`e.altKey && !e.metaKey && !e.ctrlKey`）
    - Mac特有の特殊文字入力（`key === "∫"`）および `e.code === "KeyB"`、`e.key.toLowerCase() === "b"` を検知。
  - Win/Linux: `Alt + B`（`e.altKey && !e.metaKey && !e.ctrlKey && e.code === "KeyB"`）
- **イベントキャプチャ**:
  - `document.addEventListener("keydown", window._customToggleSidebarsShortcutListener, true)` により、キャプチャフェーズで最優先検知。
  - `e.preventDefault()`, `e.stopPropagation()`, `e.stopImmediatePropagation()` を呼び出し、確実にトグルを実行。

### 3.3 カスタムコマンド登録
- **コマンドID**: `custom:toggle-both-sidebars`
- **名前**: `左右両方のサイドバー表示/非表示を切り替え`
- **ホットキー定義**: `Alt + B`
- これにより、コマンドパレット（Cmd+P / Ctrl+P）からも手動実行が可能。

---

## 4. 影響ファイル
1. [RegisterCustomCommands.md](file:///Users/mine/000_work/obsidian-dagnetz/00_templates/RegisterCustomCommands.md)
2. [claude.md](file:///Users/mine/000_work/obsidian-dagnetz/claude.md)
3. [AGENTS.md](file:///Users/mine/000_work/obsidian-dagnetz/AGENTS.md)
4. [scratch/test_toggle_both_sidebars.js](file:///Users/mine/000_work/obsidian-dagnetz/scratch/test_toggle_both_sidebars.js)
