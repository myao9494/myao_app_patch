<!--
仕様: Image Converter プラグイン（貼り付け・ドロップした画像を WebP 75 へ変換）と、自作のカスタムコマンド・プラグインの共存仕様
-->

# Image Converter との共存 仕様書

## 1. 概要

[Image Converter](https://github.com/xRyul/obsidian-image-converter)（ID: `image-converter`）は、ノートへ貼り付け・ドロップした画像を変換して保管庫へ保存するプラグイン。既定のプリセット「WebP 75」では次のように動く。

- 形式: WebP（品質 75、拡張子 `.webp`）。縮小はしない
- ファイル名: `ノート名-タイムスタンプ.webp`
- リンク: Wikilink の最短形式（`![[ノート名-タイムスタンプ.webp]]`）

「WebP 75」は形式名ではなくプリセット名で、ファイルは通常の `.webp` である。

## 2. 共存のための仕様

### 2.1 画像の右クリックメニュー
Image Converter はノート内の画像の右クリックに自分のメニューを出す。自作のメニューも開くと2つ重なるため、1つにまとめる（`14_embed_click_actions.js`）。

- Image Converter が扱う画像では、自作のメニューは開かず、Image Converter のメニューへ自作の項目を足す（`patchImageConverterContextMenu`。`contextMenu.createContextMenuItems` を包む）。自作の項目は最上部に並ぶ。
- 判定は Image Converter の判定と同じ条件にする（`isImageConverterMenuTarget`）。ノートの中の画像で、Excalidraw の図ではなく、キャンバスの上でもないこと。
- 次の場合は、これまでどおり自作のメニューを開く: Image Converter が無効、設定 `enableContextMenu` がオフ、内部の構造が変わって関数が見つからない、画像ファイルを直接開いた画面、Excalidraw の図。
- 適用は起動時（遅れて読み込まれる場合に備えて1秒後、3秒後にも）と右クリックのたびに行う。何度適用しても項目は1回だけ足す。

### 2.2 サイズ変更
両方のハンドルが使える。どちらも `![[名前|幅]]` の形で保存するため、結果は同じ形式になる。

- 自作: 埋め込みの右下のハンドル（Image Converter が画像を `.image-wrapper` で包んでいても動く）。
- Image Converter: 画像をクリックすると表示される8つのハンドルと、Shift + ホイール。`![[名前|幅x高さ]]` で保存する。自作のハンドルで変えると `|幅` に置き換わる。

### 2.2.1 画像の整列
Image Converter の中央揃え・右揃えは、図の名前を表示する自作 CSS の `display: inline-flex !important` に負けて効かなかった。`excalidraw-embed-width.css` で整列中の画像だけ `display: flex` にし、枠の幅を画像に合わせたまま枠ごと寄せる（リサイズハンドルと図の名前が画像に付いたまま動く）。

### 2.3 画像比較アプリへの送信
比較アプリ（`127.0.0.1:8078`）が WebP を読めなくても比較できるよう、WebP は PNG にして送る（`compareWithClipboardImage`）。保管庫のファイルは変わらない。

### 2.4 HTML / PDF 出力
- 人間用 HTML と PDF: WebP のまま埋め込む（ブラウザで表示できる）。
- AI用 HTML: PNG に変換して埋め込む（`convertWebpImagesToPng`）。pandoc で Word へ変換すると、Word の版によっては WebP を表示できないため。変換できない画像はそのまま残す。ファイルサイズは大きくなる。

### 2.5 draw.io の図を変換しない
`.drawio.png` / `.drawio.svg` は画像の中に図のデータを持つため、WebP にすると図を編集できなくなる。Image Converter の設定 `neverProcessFilenames` に次を登録してある（保存先は `.obsidian/plugins/image-converter/data.json`）。

```
*.drawio.png, *.drawio.svg, *.dio.png, *.dio.svg
```

## 3. WebP に対応済みの自作機能

| 機能 | 実装 |
| :--- | :--- |
| 図の名前の表示、サイズの保存 | `03_figure_embeds.js` の `FIGURE_EMBED_EXTENSIONS` |
| 画像の判定（右クリック、R キーのリネーム、削除など） | `02_external_apps.js` の `IMAGE_EXTENSIONS` |
| 画像の容量を縮小 | `COMPRESSIBLE_IMAGE_EXTENSIONS`（WebP のまま書き出す） |
| クリップボードの画像と差し替え | `canvasConvertibleMimeTypes`（WebP へ変換して書き込む） |
| 画像をクリップボードにコピー | PNG に変換してコピーする |
| サマリー | `10_summary.js` |
| コピーして同一フォルダーに保存 | `18_file_manager_and_editor_menu.js` |
| Sidebar Explorer、Sidebar Explorer Tag | `utils.ts`、`iconMap.ts`、`main.ts` |
| 画像一覧 | `obsidian-excalidraw-cards/utils.ts` の `IMAGE_EXTENSIONS` |

`AVIF` / `HEIC` は対象外。Image Converter で出力形式を AVIF にする場合は、`IMAGE_EXTENSIONS` などへの追加が必要になる。

## 4. テストと確認

- 自動テスト: [scratch/test_image_converter_compat.js](../scratch/test_image_converter_compat.js)
- 実機で確認した項目: 貼り付けとドロップでの WebP への変換、draw.io の図を変換しないこと、右クリックのメニューが1つになること（編集モード、閲覧モード）、画像ビューの自作メニュー、R キー、両方のハンドルと Shift + ホイールのサイズ変更、左・中央・右の整列、コピー、差し替え、縮小、共通画像フォルダへ移動、削除とリンクの除去、HTML / PDF 出力、サマリーの表示、サイドバー、画像一覧
- 未確認: 画像比較アプリとの実際の通信（アプリが起動していなかったため）、pandoc での Word への変換
