# 仕様書: drawio図のダブルクリック/右クリックメニュー編集

## 概要
マークダウン内のdrawio図、画像ファイルプレビュー画面、またはファイルメニューにおいて、対象ファイル名が `.drawio.svg`、`.dio.svg`、または `.drawio` の場合に drawio エディタビューで編集を開始できるようにする。

## 詳細
- **対象**: ファイル名が `.drawio.svg`、`.dio.svg`、または `.drawio` で終わるファイル。
  - 判定は大文字小文字を区別しない。
  - `.drawio` は Obsidian 上では画像拡張子として扱われない場合があるため、ファイルメニューでは画像判定とは別に対象判定する。
- **UI**:
  - マークダウン内のdrawio図をダブルクリック。
  - 画像ファイルプレビュー画面のdrawio図をダブルクリック。
  - 画像の右クリックメニューおよびファイルエクスプローラー等の右クリックメニュー（`addClipboardImageMenuItems` 経由）。
- **メニュー項目**: 「drawioで編集」
- **動作**: ダブルクリックまたはメニュー選択時に、`app.workspace.trigger("drawio:edit-diagram", file)` を発火させ、drawio エディタで対象ファイルを開く。
- **配置**: 他のカスタムメニュー項目と同様に、右クリックメニューの最上部付近に prepend して移動させる。

## 技術的要件
- `00_templates/RegisterCustomCommands.md` 内の `addClipboardImageMenuItems(menu, file)` に実装。
- drawio対象判定は `isDrawioEditableFile(file)` に集約し、Markdown画像メニューと `file-menu` の双方から利用する。
- ダブルクリックの編集は `handleMarkdownImageDblClick` で対象ファイルを解決し、drawio対象の場合のみ `drawio:edit-diagram` を発火する（`editDrawioFile`）。
- ダブルクリック対象のファイル解決は、`img` 要素、`.internal-embed` / `span[src]` / `div[src]`、画像プレビュー画面のアクティブファイルを順に確認する。
- メニュー項目の追加後、DOM操作を行い項目を最上部に移動させるロジックを `handleMarkdownImageContextMenu` および `handleFileMenu` 内に追記。
