<!--
/**
 * 仕様: iframe 埋め込みのドラッグリサイズと Option + ホイール拡大縮小の仕様ドキュメント
 *
 * 1. 概要: ノートに書いた <iframe> の枠を右下ドラッグで自由に変え、Option + ホイールで中身（画像）または枠を拡大縮小し、<iframe> タグへ保存する
 * 2. 背景: iframe の中ではマウスもホイールも iframe が受け取り、ノート側へ届かない。src が画像のとき、ブラウザの画像表示は倍率を変えられない
 * 3. 実装: 画像の iframe は srcdoc の自前の文書に差し替えて中でホイールを受け取る。地図などは Option を押している間だけ iframe のマウス操作を無効にして外側で受け取る
 **/
-->
# 仕様書: iframe 埋め込みのドラッグリサイズと Option + ホイール拡大縮小

## 1. 概要
スラッシュコマンド `iframe (from clipboard)`（[iframe_from_clipboard.md](iframe_from_clipboard.md)）などでノートに書いた `<iframe>` について、
- **枠の大きさ**を、右下のハンドルのドラッグで自由に変える（`height="600"` は上限ではない）。
- **Option + ホイール**で、`src` が画像の iframe は**画像**を、それ以外（地図など）は**枠**を拡大縮小する。

操作した結果は、ノート本文の `<iframe>` の属性へ保存する。

## 2. 操作
| 操作 | 画像の iframe（`src` が png / jpg / gif / webp / bmp / avif / svg） | それ以外の iframe（地図など） |
| :--- | :--- | :--- |
| 右下のハンドルをドラッグ | 枠の幅・高さを自由に変える（`Shift` を押している間は縦横比を保つ）。`width` / `height` へ保存 | 同左 |
| `Option`（Windows は `Alt`）+ ホイール | **画像の倍率**を変える。枠は変えない。`data-zoom` へ保存 | **枠**を縦横比を保って拡大縮小。`width` / `height` へ保存 |
| ハンドルをダブルクリック | 枠を初期状態（`width="100%"` `height="600"`）へ戻す（画像の倍率は変えない） | 同左 |

### 枠のドラッグ
- ハンドルは iframe にマウスを乗せると右下隅に表示される（Markdown の編集・閲覧ビュー）。ドラッグ中は大きさ（例: `800 × 1200px`）をマウスの近くに表示し、離したときに保存する。
- 幅と高さは別々に変わる（`computeFreeIframeSize`）。高さに上限は無く、最小は100px。幅は最小200px、最大は親の幅。親の幅いっぱいまで広げたときは、幅を `100%` として保存し、ペインの幅に追従させる。
- `Shift` を押している間は、対角方向の移動量（`(dx + dy × 比) / 2`）を幅の増減にして、操作を始めた時点の縦横比を保つ（`computeIframeSize`）。
- 動かさずに離した場合（3px 未満）は保存しない。保存すると iframe が読み込み直されるため。

### 画像の拡大縮小（画像の iframe）
- 画像の倍率は実寸が 1。範囲は 0.05〜8。ホイール1回（`deltaY` 100）で約14%変わる。縮小して画像の全体を枠に収めたり、拡大して細部を見たりできる。
- ポインターの下の画像上の点が動かないよう、スクロール位置も合わせる（`zoomIframeImage`）。
- 倍率は `<iframe … data-zoom="0.5">` のように保存する。属性が無ければ実寸（1）。ホイールが止まって0.6秒後に保存する。
- `Option` を押していないホイールは、通常のスクロール（枠より画像が大きいとき）。

### 地図などの枠の拡大縮小
- 縦横比は、操作を始めた時点の表示の幅 ÷ 高さ。幅は最小200px、最大は親の幅（`computeIframeSize`）。ホイールが止まって0.6秒後に保存する。

- 別のノートの埋め込み（`.internal-embed` / `.markdown-embed`）、ホバープレビュー、Canvas、CAD Viewer、Excalidraw の画面にある iframe は対象外。

## 3. 画像の iframe の仕組み（`applyImageIframeViewer`）
ブラウザが画像 URL を iframe で開くと、枠に合わせて縮小して表示するだけで、倍率を変えられない。また iframe の中はマウスイベントもホイールも中の文書が受け取り、ノート側へ届かない。そこで、`src` が画像の iframe は、描画後に次のように差し替える。
- iframe の `srcdoc` に、画像だけを実寸で置いた文書を設定する（`buildImageViewerSrcdoc`）。ノート本文の `src` は変えない。`srcdoc` の文書は親と同じオリジンのため、ノート側から中の文書のホイールを受け取り（`load` 後に登録）、画像の CSS `zoom` を変えられる。
- 画像の読み込みには `referrerpolicy="no-referrer"` を付ける（配信元が外部サイトからの表示を拒否する場合に備える）。
- 差し替えた iframe には `custom-iframe-image-viewer` クラスが付く。ノート側のホイール処理（下記）はこの iframe の枠を変えない。
- iframe が読み込み直されるたび（保存後を含む）、同じ処理で `data-zoom` の倍率を当て直す。

## 4. 地図などの枠のホイール操作（iframe の中でホイールが効かない問題への対策）
iframe の上ではマウスイベントもホイールも iframe の中の文書が受け取り、ノート側のリスナーへ届かない。そのため次の間だけ、iframe に `pointer-events: none` を当てて外側の要素が受け取るようにする（`excalidraw-embed-width.css`）。
- `Option` を押している間（`body.custom-iframe-alt-held`）。`keydown` / `keyup` と、マウスの動きに付く `altKey` で切り替え、ウィンドウが非アクティブになったら外す。画像の iframe は中の文書が自分で受け取るため対象外。
- ハンドルのドラッグ中（`body.custom-iframe-dragging`）。マウスが iframe の上へ出ても操作を奪われない。

ホイールのリスナーは `document` のキャプチャ段階（`passive: false`）。ポインターの位置にある iframe を座標で探す（`findIframeAtPoint`）。

**制約**: 地図などの iframe の中をクリックしてフォーカスが iframe に移ると、`Option` のキー操作がノートへ届かない。その場合は、マウスを少し動かす（`altKey` が付くマウスの動きで切り替わる）か、iframe の外をクリックしてから操作する。

## 5. 保存（`findIframeSizeEdit` / `saveIframeSize`）
- 画像・PDF と同じ `rewriteEmbedLinkInNote` で、表示しているノートの該当 `<iframe>` タグだけを書き換える（編集モードは `cm.dispatch`、閲覧モードはファイルを直接書き換え。表示位置は保つ）。
- 対象は `src` が一致する `<iframe>`。同じ `src` が複数ある場合は、操作した埋め込みの本文中の位置（`pickEmbedMatchNearOffset`）に近いものだけを書き換える。`&amp;` などは展開して比較する。
- `width` / `height` / `data-zoom` 属性だけを書き換え、無ければ `<iframe` の直後に足す。`style="max-width:…"` や `data-width` など、名前の一部が同じ別の属性とは取り違えない。`src` や `style`、改行・インデントは残す。
- 保存すると iframe は読み込み直される（地図などは再読み込み）。ホイール操作は止まってから1回だけ保存する。
- ノート本文に該当の `<iframe>` が無い場合（プラグインが挿入した iframe など）は、保存できない旨を通知する。
- `data-zoom` が Obsidian の HTML の読み込みで取り除かれる場合、倍率は保存されず、ノートを開き直すと実寸に戻る。

## 6. 実装対象
- [80_script/register_custom_commands/03_figure_embeds.js](../80_script/register_custom_commands/03_figure_embeds.js)（`findIframeSizeEdit`、`computeIframeSize`、`computeFreeIframeSize`、`setupIframeResizeHandle`、`applyImageIframeViewer`、`zoomIframeImage`、`applyIframeEmbeds`、`handleIframeWheelZoom`。`applyFigureEmbedDisplayNames` から呼ぶ）
- [80_script/register_custom_commands/15_image_rename_compress_move.js](../80_script/register_custom_commands/15_image_rename_compress_move.js)（ホイール・キーのリスナー登録、スクリプト再実行時のハンドルの付け直し）
- [.obsidian/snippets/excalidraw-embed-width.css](../.obsidian/snippets/excalidraw-embed-width.css)（ハンドルの見た目、`pointer-events`、`max-width`）

## 7. テスト
[scratch/test_iframe_embed_resize.js](../scratch/test_iframe_embed_resize.js)（属性の書き換え、枠の大きさの計算、枠のホイール操作、画像の iframe の差し替えと倍率、再走査の抑止）
