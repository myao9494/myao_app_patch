# ノートのタブの右クリックメニュー「印刷」仕様書

## 概要
ノートのタブを右クリックして「印刷」を選ぶと、人間用HTMLを作って temp フォルダへ保存し、既定のブラウザで開く。印刷そのものは、開いたブラウザの印刷画面（Cmd/Ctrl+P）でユーザーが行う。

## 仕様詳細
1. **メニュー**: ファイルメニュー（`file-menu`）のうち `source === "tab-header"`（タブの右クリック）のときだけ、Markdown（非 `.excalidraw.md`）に「印刷」（アイコン `printer`）を追加する。ファイルエクスプローラーなど他のメニューには出さない（`handleFileMenu`）。
2. **HTMLの作成**: 「HTMLで出力(人間用)」と同じ設定画面（見出し番号）と `generateExportHtml(file, "human", …)` を使う。設定画面をキャンセルしたら何もしない。
3. **保存先**: 保存ダイアログは出さず、`temp/[ノート名].html` へ上書き保存する（`temp` が無ければ作る）。
4. **ブラウザで開く** (`openHtmlFileInDefaultBrowser`): Electron `shell.openExternal`（`file://` URL）→ `shell.openPath` → OS のコマンド（`open` / `cmd /c start` / `xdg-open`）の順に試す。開けなかった場合は、保存先のパスを Notice で知らせる。
5. 並び順は「PDFで出力(人間用)」の次（`reorderMenuItemsLater` の `afterRename` に「印刷」を追加）。

## 実装対象
- [80_script/register_custom_commands/24_html_pdf_export.js](../80_script/register_custom_commands/24_html_pdf_export.js)（`printHtml`、`openHtmlFileInDefaultBrowser`）
- [80_script/register_custom_commands/17_file_menu.js](../80_script/register_custom_commands/17_file_menu.js)（メニュー項目）

## テスト
- [scratch/test_print_html_tab_menu.js](../scratch/test_print_html_tab_menu.js)
