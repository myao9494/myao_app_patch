# Excalidraw 図の変更をノート内の埋め込みへ即時反映 仕様書

## 概要
ノートに埋め込んだ Excalidraw 図（例: `![[図_3D_veiwテスト.excalidraw|1475]]`）を編集したら、ノートへ戻ったときに埋め込みの表示が新しい図になっているようにする。

## 課題と原因
- Excalidraw プラグインが埋め込みを描き直すのは、プラグイン自身の描画画面で保存したとき・その画面を離れたとき（`triggerEmbedUpdates`）だけ。
- Web アプリ（`http://localhost:3001/?filepath=…`。「Webアプリで開く / 編集」）は図のファイルを直接書き換えるため、プラグインは描き直さず、ノート内の埋め込みが古い図のまま残っていた。

## 仕様詳細
1. **契機**: 保管庫の `modify` イベント（`registerVaultEvent("_customExcalidrawEmbedModifyListener", "modify", handleExcalidrawFileModify)`）。Obsidian の外でのファイル書き換えも、Obsidian がファイルの変更を検知した時点でこのイベントになる。
2. **対象ファイル** (`isExcalidrawDrawingFile`): `.excalidraw` と、Excalidraw のデータを持つ Markdown（`.excalidraw.md`、フロントマターに `excalidraw-plugin` があるノートなど。`isExcalidrawBackedMarkdown`）。
3. **描き直し** (`rerenderExcalidrawEmbeds`): 開いている全ウィンドウ（メインとポップアウト）の `.excalidraw-embedded-img` のうち、`fileSource`（`#` より前）が変更されたファイルのパスと一致するものへ、プラグインと同じ再描画イベント `excalidraw-embed-rerender` を送る。描画はプラグインが行う（画像キャッシュはファイルの更新日時で無効になるため、新しい図が描かれる）。
4. **まとめて1回**: 保存が続いた場合は、最後の変更から 300ms 後に1回だけ描き直す（ファイルごと）。
5. **図が変わっていない保存では描き直さない**: 図のデータ（`# Excalidraw Data` 以降。見出しが無ければファイル全体）を前回と比べ、同じなら描き直さない。Excalidraw のデータを持つノートで本文だけを書いている間に、図がちらつかないようにするため。
6. 描き直しで埋め込みの中身が差し替わると、図名キャプションとリサイズハンドルは図の埋め込みの DOM 監視（`applyFigureEmbedDisplayNames`）が付け直す。

## 実装対象
- [80_script/register_custom_commands/03_figure_embeds.js](../80_script/register_custom_commands/03_figure_embeds.js)（`handleExcalidrawFileModify` ほか）
- [80_script/register_custom_commands/01_common_helpers.js](../80_script/register_custom_commands/01_common_helpers.js)（`registerVaultEvent`）
- [80_script/register_custom_commands/15_image_rename_compress_move.js](../80_script/register_custom_commands/15_image_rename_compress_move.js)（登録）

## テスト
- [scratch/test_excalidraw_embed_refresh.js](../scratch/test_excalidraw_embed_refresh.js)
