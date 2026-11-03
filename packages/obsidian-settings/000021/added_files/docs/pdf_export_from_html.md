<!--
仕様: 「PDFで出力(人間用)」機能のアーキテクチャ、処理フロー、および設定詳細をまとめたドキュメント
-->
# PDFで出力 (人間用) 機能仕様書

## 概要
Markdownノート（`りんご.md` などのExcalidraw埋め込みや画像、MathJax数式を含むファイル）の右クリックメニューから、直接高品質なPDFを出力する機能です。
既存の「HTMLで出力(人間用)」で確立されたレンダリングパイプライン（Excalidraw埋め込みのPNGラスタライズ置換、画像のBase64インライン埋め込み、見出し番号付け、印刷用CSSの適用）をベースとし、生成されたHTMLをPDFに直接変換して保存します。

```
                    ┌───────────────────────────────┐
                    │      Markdownファイル         │
                    │   (Excalidraw埋め込み含む)     │
                    └──────────────┬────────────────┘
                                   │
                                   ▼
                    ┌───────────────────────────────┐
                    │     generateExportHtml        │
                    │ ・Excalidraw埋め込み -> PNG   │
                    │ ・画像 -> Base64 Data URL     │
                    │ ・印刷用CSS / @page A4適用     │
                    └──────────────┬────────────────┘
                                   │
                                   ▼
                    ┌───────────────────────────────┐
                    │      convertHtmlToPdf         │
                    │ 1. Chrome/Edge headless (優先)│
                    │ 2. Electron printToPDF (代替) │
                    └──────────────┬────────────────┘
                                   │
                                   ▼
                    ┌───────────────────────────────┐
                    │     PDFファイル保存・通知     │
                    │ ・保存ダイアログ (temp/*.pdf) │
                    │ ・フルパスをクリップボードコピー │
                    └───────────────────────────────┘
```

## 1. トリガーとUI
- **ファイルエクスプローラー（サイドバー）**: ファイルを右クリック -> 「PDFで出力(人間用)」
- **エディター画面**: ノート本文を右クリック -> 「PDFで出力(人間用)」

## 2. 変換・出力処理の流れ
1. **設定モーダル**:
   - `askHtmlExportOptions()` を呼び出し、見出し番号（`1.1`, `1.2` 等）を付与するかを選択。
2. **HTML生成 (`generateExportHtml`)**:
   - ノート本文から `# Excalidraw Data` などの内部データセクションを除去。
   - WebP の画像は人間用 HTML と PDF ではそのまま埋め込み、AI用 HTML では PNG にする（`convertWebpImagesToPng`。pandoc で Word へ変換するため）。
   - `replaceExcalidrawEmbedsForHtmlExport` により、同名Excalidraw埋め込み（`![[りんご|75]]`）等をPNG画像として置換。図を読めない、リンク先が無いなどで出力できない図は、その位置に「図を出力できませんでした」の案内を残し、通知を出して出力を続ける（図1枚のために出力全体を止めない）。
   - `replaceCadCodeBlocksForHtmlExport` により、CAD Viewer のコードブロック（` ```step ` / ` ```cad `）を白背景のPNG画像へ置き換え（注記、座標軸を含む。[cad_viewer_spec.md](cad_viewer_spec.md) の 2.19）。
   - 一時DOM（`tempDiv`）に `MarkdownRenderer.render` で描画し、非同期レンダリング完了を待機。
   - `convertPreviewHtmlForPandoc` で画像をBase64 Data URLへ変換し、MathJax数式をパース。
   - 人間用印刷CSS（`getHumanHtmlExportCss`）と `@page { size: A4; margin: 15mm; }` スタイルを適用。
3. **PDF変換 (`convertHtmlToPdf`)**:
   - **最優先方式**: システム内の Google Chrome / Chromium / Edge のヘッドレス実行（`--headless --disable-gpu --no-pdf-header-footer --print-to-pdf=...`）を実行。独立したレンダリングエンジンにより、白紙化や画像の欠落なく100%確実に高品質なPDFを出力。
     - **探す場所**: macOS の各ブラウザ、Windows の Chrome（`Program Files`、`Program Files (x86)`、`%LOCALAPPDATA%`）と Edge（`Program Files (x86)`、`Program Files`）、`PATH` 上の `google-chrome` / `chromium`。
     - **一時ファイルへ出力**: 保存先の隣の一時ファイルへ出力し、確認してから保存先へ置き換える。保存先へ直接出力すると、ブラウザが何も出力しなかったときに前回の PDF を成功と誤認するため。失敗しても前回の PDF は残る。
     - **専用のプロファイル**: `--user-data-dir` に、出力ごとに別の OS の一時フォルダ（`obsidian-html-pdf-export-…`）を指定し、終わったら消す。同じプロファイルを同時に使うと、既存のプロセスへ処理が渡って PDF が出力されないため（起動中のブラウザや、同時に実行した出力）。
     - **時間制限**: 120秒で打ち切り、フォールバック方式へ進む。
   - **フォールバック方式**: Electron の非表示 `BrowserWindow` を作成し、ロード完了・フォント/画像の完了待機を行った上で `win.webContents.printToPDF` を実行。
   - **白紙防止ガード**: 一時ファイルのサイズが 1,000 bytes 以下の場合は空出力と判定し、自動的にフォールバックを実行。
4. **保存とクリップボード連携**:
   - OS標準のファイル保存ダイアログ（デフォルト: `temp/[ノート名].pdf`）を表示。
   - PDFファイルを出力先に保存。
   - 絶対パスをクリップボードにコピーし、`Notice` 通知を表示。

## 3. 関連ファイル
- [RegisterCustomCommands.md](file:///Users/mine/000_work/obsidian-dagnetz/00_templates/RegisterCustomCommands.md)
- [claude.md](file:///Users/mine/000_work/obsidian-dagnetz/claude.md)
- [AGENTS.md](file:///Users/mine/000_work/obsidian-dagnetz/AGENTS.md)
- [scratch/test_pdf_export.js](file:///Users/mine/000_work/obsidian-dagnetz/scratch/test_pdf_export.js)
