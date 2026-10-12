<!--
/**
 * 仕様: 画像ドラッグリサイズおよびホイール拡大の最適化仕様ドキュメント
 * 
 * 1. 概要: 画像埋め込みのドラッグリサイズおよびホイールズームによる拡大・縮小を正常化
 * 2. 課題: CSSスニペットの width: var(--figure-width) !important による親要素の幅固定と img の max-width: 100% の衝突
 * 3. 解決策: 親要素の幅固定を解除し、画像の自然な幅に追従。キャプションの幅最適化および属性変更監視の強化
 **/
-->
# 仕様書: 画像ドラッグリサイズおよびホイール拡大の最適化

## 1. 概要
Markdownノート内の画像埋め込み（`![[画像ファイル名|サイズ]]`）において、画像のドラッグリサイズ（Obsidian標準機能）およびマウスホイールズーム（`mousewheel-image-zoom` プラグイン等での Option+ホイール操作）による拡大・縮小が正常に動作するようスタイルおよびスクリプトを最適化しました。

## 2. 発生していた課題と根本原因

### 症状
- 画像の端をドラッグして広げようとしても、画像表示サイズが大きくならない。
- `mousewheel-image-zoom` プラグインで Option + ホイール操作を行った際、縮小はできるが拡大が一切できない。

### 根本原因
1. **CSSスニペットによる親要素の強制幅固定**:
   - `.obsidian/snippets/excalidraw-embed-width.css` 内の `.media-embed[data-figure-name]:not([data-figure-kind="excalidraw"])` 等に対して、`width: var(--figure-width, fit-content) !important;` が指定されていました。
   - 初回レンダリング時（例: 幅 200px）、親要素に `--figure-width: 200px` がインラインスタイルとして付与され、親要素の幅が `200px !important` に固定されます。
   - ObsidianおよびブラウザのCSSでは画像要素（`img`）に `max-width: 100%` が適用されるため、ドラッグやプラグインで画像幅を大きくしようとしても、親要素の幅（200px）によってクランプされ、200px を超えて表示拡大できない状態となっていました。
2. **縮小のみが成功するトラップ**:
   - 一方で縮小操作（例: 200px → 175px）は親要素の幅（200px）以下への縮小であるため適用され、ResizeObserver が 175px を検知して `--figure-width: 175px` とさらに親要素を縮小固定してしまい、「縮小はできるが拡大は二度とできない」状態に陥っていました。
3. **属性変更の監視漏れ**:
   - `00_templates/RegisterCustomCommands.md` の `MutationObserver` の `attributeFilter` に `"width"`, `"alt"`, `"style"` が含まれていなかったため、リサイズによる画像属性の変更が即座に反映されない場合がありました。

## 3. 解決策と実装詳細

### (1) CSSスニペットの幅固定解除 (`excalidraw-embed-width.css`)
- `.media-embed[data-figure-name]:not([data-figure-kind="excalidraw"])` などの親要素から `width: var(--figure-width, fit-content) !important;` を削除。
- Excalidraw側と同様に親要素の幅を固定せず、内部の画像の本来のサイズに応じて自然に伸縮可能にしました。
- キャプション（`.custom-figure-caption`）は `width: 100%; max-width: 100%;` とし、画像のサイズに合わせて中央揃えで追従します。

### (2) 幅追従および属性変更の検知強化 (`RegisterCustomCommands.md`)
- `updateFigureEmbedWidth` において、`getBoundingClientRect().width` に加え `visual.getAttribute("width")` などの指定幅もフォールバックとして考慮。
- `MutationObserver` の `attributeFilter` に `"width"`, `"alt"`, `"style"` を追加し、リサイズによる画像属性の更新を即座に検知して追従。

### (3) 監視対象の絞り込み (`isFigureRelevantMutation`)
監視は `document.body` 全体に対して行うため、図の表示に関係するDOM変更のときだけ再走査（`applyFigureEmbedDisplayNames`、50ms デバウンス）を実行する。

| DOM変更 | 再走査 |
| :--- | :--- |
| Markdownの編集・閲覧ビュー、埋め込み、ホバープレビュー内の要素の追加・削除（本文編集、図の非同期差し替え） | する |
| 上記以外の領域（Canvas 等）への図の埋め込み（`.internal-embed` / `.media-embed` 等）の追加 | する |
| `src` / `filesource` / `width` / `alt` などの属性変更 | する |
| 図（`img` / `svg` / `canvas`）または図コンテナ自身の `style` 変更 | する |
| 図以外の要素の `style` 変更（エディタのスクロール、他プラグインの描画など） | しない |
| サイドバー、ステータスバーなど図と無関係な領域の更新 | しない |
| このスクリプト自身が追加・移動したキャプション、リサイズハンドル、HUD | しない |
| CAD Viewer の埋め込み（`.step-viewer-embed-wrapper`）内部の更新 | しない |

## 4. 関連ファイル
- [.obsidian/snippets/excalidraw-embed-width.css](file:///Users/mine/000_work/obsidian-dagnetz/.obsidian/snippets/excalidraw-embed-width.css)
- [00_templates/RegisterCustomCommands.md](file:///Users/mine/000_work/obsidian-dagnetz/00_templates/RegisterCustomCommands.md)
- [scratch/test_image_zoom_and_resize.js](file:///Users/mine/000_work/obsidian-dagnetz/scratch/test_image_zoom_and_resize.js)
- [scratch/test_figure_embed_observer.js](file:///Users/mine/000_work/obsidian-dagnetz/scratch/test_figure_embed_observer.js)
