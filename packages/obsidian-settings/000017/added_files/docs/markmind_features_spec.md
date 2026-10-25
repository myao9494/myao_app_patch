<!--
/**
 * MarkMind プラグイン機能拡張・不具合修正 技術仕様書
 * 
 * 1. Option (Alt) + M による mindmap-plugin: basic 自動付与とマインドマップ画面切り替え
 * 2. マインドマップ編集中における Delete キーによるノート誤削除の防止
 * 3. マウスホイール中ボタン押し込みによる掴んで移動 (パン操作)
 * 4. Excalidraw ファイル埋め込み時の MarkMind レンダリング抑止 (二重描画防止)
 * 5. Excalidraw データのマインドマップ非表示 (描画時除外) と保存時保護 (末尾復元)
 **/
-->

# MarkMind プラグイン機能拡張・不具合修正 技術仕様書（非侵襲実装）

## 1. 概要
Obsidian におけるマインドマッププラグイン「MarkMind」本体は、アップデート時にコードが上書きされるため直接変更を加えません。
すべて「RegisterCustomCommands.md」内に集約し、グローバルイベントリスナー・コマンド登録・モンキーパッチによる非侵襲な方式で機能拡張と不具合解消を実現しています。

---

## 2. 実装詳細仕様

### 機能 1: Option (Alt) + M による有効化とトグル切り替え
- **トリガー**: `Alt + M`（Mac: `Option + M` / Win: `Alt + M`）
- **コマンドID**: `custom:toggle-mindmap-basic`
- **キーリスナー**: `window._customMindmapShortcutListener`
  - `e.altKey && !e.metaKey && !e.ctrlKey && (e.code === "KeyM" || e.key.toLowerCase() === "m" || e.key === "µ")`
- **対象の画面**: Markdown 画面（`markdown`）とマインドマップ画面（`mindmapview`）だけ（`canToggleMindmapInActiveLeaf`）。Excalidraw・PDF・画像などの画面ではキー操作を消費せずその画面へ渡し、コマンドを実行しても何もしない（Excalidraw の図のノートに `mindmap-plugin` を付けてしまうのを防ぐ）。
- **動作フロー**:
  1. アクティブなリーフを取得。
  2. **マインドマップ画面（`mindmapview`）の場合**:
     - ビューを Markdown 画面（`markdown`）に切り替え（トグル）。
  3. **Markdown 画面等の場合**:
     - 対象ノートのフロントマターをスキャン。
     - `mindmap-plugin` プロパティが存在しない、または空の場合、`mindmap-plugin: basic` を自動付与（`app.fileManager.processFrontMatter`）。
     - 既に `basic` や `rich` が設定されている場合は上書きせず既存設定を維持。
     - ビューをマインドマップ画面（`mindmapview`）に切り替え。

### 機能 2: マインドマップアクティブ時の Delete キー制御
- **課題**: `RegisterCustomCommands.md` のグローバル `keydown` キャプチャリスナー（`handleDeleteKey`）が Delete キー入力を奪い、ノート全体を削除するダイアログ（`custom:delete-active-file`）を起動してしまっていた。
- **改修内容**:
  1. `isMarkMindActive()` ヘルパー関数を `RegisterCustomCommands.md` に追加。
     - アクティブリーフのビュータイプが `mindmapview` であるか、またはフォーカス中要素が `.mindmapview`、`.cm-mindmap`、`.markmind-container`、`.mm-app-container` 内にあるかを判定。
  2. `handleDeleteKey` の先頭で `isMarkMindActive()` を判定し、`true` の場合は処理を中断（`return`）してキーイベントを通過させる。
  3. `patchCommandForExcalidraw` 内のコマンドガード（`file-explorer:delete-file`, `app:delete-file`, `custom:delete-active-file`）にも `isMarkMindActive()` を追加。
  4. これにより、マインドマップ編集中に Delete キーを押した際はノード削除のみが安全に実行される。

### 機能 3: マウスホイール中ボタンによる掴んで移動（パン操作）
- **トリガー**: マウスホイールの中ボタン（中央ボタン、`button === 1`）押し込みドラッグ
- **マウスリスナー**: `window._customMiddleButtonPanListener`
- **対応モード**: Basic モード（SVGレンダリング）および Rich モード（HTMLレンダリング）
- **動作フロー**:
  1. `mousedown` で `e.button === 1` を検知。
  2. マインドマップコンテナ（`.mm-app-container` 等）内である場合、ブラウザ標準のオートスクロールアイコンを `preventDefault()` および `stopPropagation()` で抑止。
  3. `mindmap.event.transform()`（Basicモード）またはコンテナスクロール（Richモード）をフックし、ドラッグ移動量を座標に反映。
  4. `mouseup` で移動完了。

### 機能 4: Excalidraw 埋め込み時の表示競合解消
- **課題**: `![[りんご|75]]` などのノート埋め込みにおいて、対象ノートが Excalidraw ファイルである場合、Excalidraw プラグインと MarkMind の MarkdownPostProcessor の双方が `.internal-embed` を描画しようとして多重描画・表示崩れ（バグ）が発生していた。
- **改修内容**:
  1. `patchMarkMindPostProcessor()` 関数により、Obsidian の `MarkdownPreviewRenderer.postProcessors` に登録されている MarkMind のプロセッサを特定してラップ。
  2. 埋め込み対象ノートのフロントマターに `excalidraw-plugin` が含まれる場合、またはファイルパスが `.excalidraw.md` で終わる場合、MarkMind 側の処理を早期リターン（`return`）。
  3. Excalidraw プラグイン側のみにレンダリングを任せることで、綺麗な単一描画を実現。

### 機能 5: Excalidraw データのマインドマップ非表示と保護
- **課題**: Excalidraw データを含むノート（例: `りんご.md`）をマインドマップ表示した際、内部データ（`# Excalidraw Data`、`## Drawing`、圧縮文字列データ）がマインドマップの見出しノードとして展開・表示されてしまう。また、マインドマップ側で保存（`mindMapChange`）を行うと、Excalidraw 内部データが破損または消失するリスクがあった。
- **改修内容**:
  1. `stripExcalidrawSection(mdText)` 関数により、`# Excalidraw Data` 以降のセクション、警告バナー（`==⚠...⚠==`）、コメントブロック（`%%...%%`）を正確に除去するフィルタリングロジックを実装。
  2. `patchMarkMindViewForExcalidraw` 関数により、MarkMind の View クラス（`nN` / `mindmapview`）のプロトタイプを非侵襲にモンキーパッチ：
     - **表示時フィルタリング (`getMdText`)**: マインドマップ描画用 Markdown を生成する際、`stripExcalidrawSection` を通して Excalidraw データを完全に除外したテキストをパーサー（`mdToData`）に渡す。
     - **ファイル読込時退避 (`setViewData`)**: ファイルオープン時に元の Markdown から `# Excalidraw Data` セクションを抽出し、`this._excalidrawBackup` に安全に退避。
     - **編集保存時復元 (`mindMapChange`)**: マインドマップ側でノードが追加・編集されて保存が走った際、`this.data` の末尾に退避していた `this._excalidrawBackup` を自動復元して書き込む。
  3. これにより、Excalidraw ノートをマインドマップで快適に閲覧・編集でき、Excalidraw 側の作図データも一切破損しない。

---

### 機能 6: `mindmap-plugin` 付きノートを Markdown で開く
- `mindmap-plugin: basic` などのプロパティがあるノートを開いたとき、マインドマップではなく Markdown ノートで開く。マインドマップへの切り替えは Option+M などでユーザーが手動で行う。
- MarkMind は leaf ごとの表示モード（`mindmapFileModes`）が `"markdown"` 以外だとマインドマップで開く。`defaultMarkMindToMarkdown`（`80_script/register_custom_commands/22_markmind.js`）が `mindmapFileModes` を Proxy に置き換え、未設定のキーは `"markdown"` を返す。手動で切り替えたときは明示的に値が入るのでそちらが優先される。
- プラグイン本体は変更しない。起動直後の再描画やプラグイン再読込に備え、起動時・1秒後・3秒後・`layout-change` で再適用する。

### 機能 7: 日本語IMEの確定 Enter でノート編集を終えない
- 症状（Mac）: ノードに日本語を入力して Return で確定すると、編集が終わり、続けて入力した文字が画面左上の変換候補ウィンドウにしか出ず、ノードへ入らない。
- 原因: MarkMind は Enter の `keydown` と `keyup` の両方で「編集を終えて次の兄弟ノードを作る」。IME の確定の Enter も `key === "Enter"` で届くため、変換の途中でノードが入れ替わり、IME の入力先が失われる。
- 対応: `handleMindmapImeEnter`（`80_script/register_custom_commands/22_markmind.js`）が document のキャプチャ段階で、マインドマップ内の編集中ノード（`contenteditable="true"`）への Enter を見る。
  - `isComposing` または `keyCode === 229` の `keydown`、変換終了（`compositionend`）の直後（50ms 以内）の `keydown` は `stopImmediatePropagation()` で MarkMind へ渡さない（`preventDefault()` はしないので IME の確定は通常どおり）。
  - 止めた `keydown` に対応する `keyup` も MarkMind へ渡さない。
  - IME を使わない Enter、変換が終わった後の Enter は従来どおり MarkMind に渡る（編集を終えて次の兄弟ノードを作る）。
- 操作: 日本語は「変換して Enter（確定）→ もう一度 Enter（編集を終えて次のノードを作る）」。
- プラグイン本体は変更しない。

## 3. 影響ファイル
1. [RegisterCustomCommands.md](file:///Users/mine/000_work/obsidian-dagnetz/00_templates/RegisterCustomCommands.md)（全ての機能を集約）
2. [claude.md](file:///Users/mine/000_work/obsidian-dagnetz/claude.md)
3. [AGENTS.md](file:///Users/mine/000_work/obsidian-dagnetz/AGENTS.md)
4. [scratch/test_markmind_features.js](file:///Users/mine/000_work/obsidian-dagnetz/scratch/test_markmind_features.js)
5. [scratch/test_markmind_ime_enter.js](file:///Users/mine/000_work/obsidian-dagnetz/scratch/test_markmind_ime_enter.js)（IME 確定の Enter）
※ `.obsidian/plugins/obsidian-markmind/main.js` は一切変更していません。
