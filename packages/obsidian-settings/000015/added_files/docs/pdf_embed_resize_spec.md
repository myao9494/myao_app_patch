<!--
/**
 * 仕様: PDF埋め込みの端をドラッグして大きさを変える機能の仕様ドキュメント
 *
 * 1. 概要: PDF埋め込みの右端・下端・右下隅にハンドルを付け、ドラッグで幅・高さを変えてノートのリンクへ保存する
 * 2. Obsidian 標準の表示: 幅100%・高さ1ページ分。幅の指定（|600）は表示に使われず、高さは #height= で指定できる
 * 3. 実装: 幅はスクリプトが width 属性を当て、高さは Obsidian 標準の #height= に任せる
 **/
-->
# 仕様書: PDF埋め込みのドラッグリサイズ

## 1. 概要
Markdown ノートに埋め込んだ PDF（`![[資料.pdf]]`）の右端・下端・右下隅をドラッグして、表示の大きさを変えられるようにする。ドラッグを終えると、ノート本文のリンクへ大きさを保存する（画像の右下ドラッグリサイズ [image_drag_resize_spec.md](image_drag_resize_spec.md) と同じ考え方）。

## 2. Obsidian 標準の PDF 埋め込みの表示（Obsidian 1.14 で確認）
- 埋め込み要素は `.internal-embed.pdf-embed`。既定の大きさは **幅100%・高さ1ページ分**（ページを幅いっぱいに表示したときの1ページの高さ＋ツールバー）。このためノート上では非常に大きく表示される。
- 高さはリンクの `#height=数値` で指定できる（ツールバーを除いたページ表示部分の高さ）。指定が無い場合、Obsidian は枠の大きさが変わるたびに高さを1ページ分へ合わせ直す。
- リンクの `|600` は、埋め込み要素の `width` 属性になる（編集モード・閲覧モードとも）。ただし PDF の表示幅には使われない。
- PDF の表示部品は枠の大きさの変化を監視しており、枠の幅を変えるとページを幅に合わせて描き直す。

## 3. 操作
| ハンドル | 変わるもの | 保存されるリンク |
| :--- | :--- | :--- |
| 右端（`mod-right`） | 幅。高さの指定が無い場合、高さは幅に合わせて1ページ分へ自動で追従する | `![[資料.pdf\|600]]` |
| 下端（`mod-bottom`） | 高さ | `![[資料.pdf#height=400]]` |
| 右下隅（`mod-corner`） | 幅と高さ | `![[資料.pdf#height=400\|600]]` |

- ハンドルは PDF 埋め込みにマウスを乗せると薄く表示される。ドラッグ中は大きさ（例: `幅 600px × 高さ 400px`）をマウスの近くに表示する。
- 最小サイズは幅 200px、高さ（ページ表示部分）150px。幅は親要素（本文の幅）までに抑え、本文の幅いっぱいまで広げた場合は幅の指定を取り除く（既定の100%表示に戻す）。
- いずれかのハンドルをダブルクリックすると、幅と高さの指定を取り除いて既定の大きさに戻す。
- ハンドルを動かさずに離した場合（3px 未満）は保存しない。保存すると埋め込みが描画し直され、ダブルクリックの2回目が別の要素に当たってリセットできなくなるため。
- 高さの保存値が操作のたびにずれないよう、ツールバーの高さは小数まで測り、保存する高さを整数に丸める。
- 右端のハンドルは、ツールバーのボタンと右下隅のハンドルに重ならないよう、上端から 44px・下端から 16px 空けて配置する。
- ホバープレビュー（`.popover`）と Canvas の PDF は、それぞれの枠の大きさに従うため対象外。

## 4. リンクの書き換えルール（`findPdfEmbedSizeEdit`）
- 幅・高さは、数値で指定、`null` で指定を取り除く、省略で現状維持。
- 高さは `#` 以降の指定のうち `height=` だけを差し替え、`page=3` などの他の指定は残す（`![[資料.pdf#page=3&height=400|600]]`）。
- 幅のリセットでは、サイズ指定（`|600`、`|600x400`）だけを取り除き、表示名としての別名（`|資料`）は残す。
- Wikilink（`![[...]]`）を優先し、見つからない場合のみ標準 Markdown 記法（`![alt|600](資料.pdf#height=400)`。パーセントエンコードされたパスを含む）を対象にする。
- 名前の一部だけが一致する別の PDF（`xa.pdf`）は対象にしない。
- 同じ PDF を複数回埋め込んだノートでは、操作した埋め込みのリンクだけを書き換える。
- 保存先のノートの特定、書き換え範囲（該当リンクだけを `editor.replaceRange` で置換）、閲覧モードでのファイルの直接書き換えは、画像のリサイズと同じ処理（`rewriteEmbedLinkInNote`）を使う。

## 5. 表示への反映（`applyPdfEmbedSizes`）
- 図の埋め込みの DOM 監視（`applyFigureEmbedDisplayNames`）のたびに、Markdown ビュー内の PDF 埋め込みの `width` 属性を表示幅（`style.width`）として当て、ハンドルを1組だけ付ける。属性が無くなった場合は幅の指定を外す。
- 狭いペインでもはみ出さないよう、CSS で `max-width: 100%` を指定する。
- 高さだけを変えるドラッグ中は、高さの指定が無い PDF だと Obsidian が高さを1ページ分へ戻してしまうため、`min-height` / `max-height` で固定する。保存後に埋め込みが描画し直されると、リンクの `#height=` に置き換わる。高さの指定が無い PDF の幅だけを変える場合は、この固定を外して1ページ分の高さへ追従させる。
- 画像用のリサイズハンドル（`.custom-image-resizer-handle`）は PDF 埋め込みには付けない。PDF のハンドル（`.custom-pdf-resizer-handle`）の追加は、図の再走査のきっかけにしない。

## 6. 関連ファイル
- [80_script/register_custom_commands/03_figure_embeds.js](../80_script/register_custom_commands/03_figure_embeds.js)（`findPdfEmbedSizeEdit`、`savePdfEmbedSize`、`setupPdfResizeHandles`、`applyPdfEmbedSizes`）
- [80_script/register_custom_commands/15_image_rename_compress_move.js](../80_script/register_custom_commands/15_image_rename_compress_move.js)（スクリプト再実行時のハンドルの付け直し）
- [.obsidian/snippets/excalidraw-embed-width.css](../.obsidian/snippets/excalidraw-embed-width.css)（ハンドルの見た目、`max-width`）
- テスト: [scratch/test_pdf_embed_resize.js](../scratch/test_pdf_embed_resize.js)
