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
   - **リンクの扱い（`adjustHtmlExportLinks`。人間用 HTML・PDF・印刷。AI用 HTML は変えない）**: 見出し番号を付ける前に行う。
     - 同じノートの見出しへのリンク（`[[#見出し]]`、`[[自分のノート#見出し]]`、`[[#親#子]]`）: 見出しに `id`（`html-export-heading-N`。既にあればそれ）を付け、そこへ飛ぶリンクにする。見出しの文字は `# | ^ : % [ ] \` を除き、空白をまとめ、大文字小文字を区別せずに比べる。同じ名前の見出しが複数あれば最初の見出しへ飛ぶ。
     - リンクを外して文字だけ残すもの: 他のノートへのリンク、Obsidian リンクのファイル（`[[資料.pdf]]`）、未作成のノート、飛び先の見出しが無いリンク、ブロックへのリンク（`#^id`）、ファイルのリンク（`file:`、ファイルマネージャーの `http://localhost:8001/api/open-path`、`obsidian:`、`app:`）、タグ。`href` を取り除き、`html-export-unlinked` を付けて本文と同じ色で表示する。
     - そのまま残すもの: URL（`https://`、`mailto:` など）と、ページ内の飛び先（脚注）。
   - **目次と検索窓（人間用 HTML。MkDocs に似た画面）**: 本文を、上の帯（題名と検索窓）・左の目次・本文に分けて並べる（`buildHumanHtmlExportBody`）。PDF と印刷では帯と目次を隠し（`@media print`）、今までと同じ見た目にする。
     - **左の目次**（`buildHtmlExportTocHtml`）: 見出しの `id` へ飛ぶ。最上位の見出しから3階層まで。埋め込んだ別のノートの見出しは入れない。スクロールに合わせて、読んでいる章を強調する（`setupHtmlExportTocHighlight`）。画面の幅が 900px 以下なら隠す。
     - **右上の検索窓**（`setupHtmlExportSearch`）: そのページの中だけを探す。日本語を単語に分けず、文字の並びをそのまま探す（単語の途中の文字でも見つかる）。全角と半角・大文字と小文字・ひらがなとカタカナをそろえて比べる（`htmlExportSearchNormalizeWithMap`）。空白で区切った語は、すべて同じ章（見出しから次の見出しまで）にあるものだけを出し、見出しに語がある章を先に並べる（`htmlExportSearchSections`）。結果は章ごとに見出しと抜粋を出し、クリックか Enter でその章へ飛ぶ。本文の一致した箇所も色付けする（CSS Custom Highlight API。DOM は変えない）。`/` か `Ctrl/Cmd+K` で検索窓へ、`↑` `↓` で結果を選び、`Esc` で閉じる（2回で消す）。打ち間違いの許容、言い換え、関連度の順位付けはしない。
     - **スクリプト**: ノートに書かれた `<script>` は今までどおり取り除き（`sanitizeHtmlExportForHuman`）、その後に出力の仕組みが用意した検索・目次の処理だけを `</body>` の前へ入れる（`appendHtmlExportPageScript`）。処理は関数のソースをそのまま書き出す（`buildHtmlExportPageScript`）ため、その関数は外側の変数を使わない。外部のファイルを読まないので、オフラインでも `file://` で開いても動く。スクリプトを止める環境では検索窓を出さない（目次は動く）。
   - 人間用印刷CSS（`getHumanHtmlExportCss`）と `@page { size: A4; margin: 15mm; }` スタイルを適用。
   - **保存後に開く（「HTMLで出力(人間用)」）**: 保存ダイアログで保存したら、そのまま既定のブラウザで開く（`openHtmlFileInDefaultBrowser`。「印刷」と同じ）。開けなければパスを添えて通知する。AI用と、保存先を指定した無人の実行（`custom:export-html-human`）では開かない。
   - **コールアウトの色**: 種類（Obsidian の `data-callout`）ごとに、MkDocs Material と同じ配色で色を分ける。note（と知らない種類）は青、abstract は水色、info は青緑、tip は緑がかった青緑、success は緑、question は黄緑、warning はオレンジ、failure は薄い赤、danger は赤、bug は赤紫、example は紫、quote は灰色。別名（`caution` → warning、`error` → danger、`important` → tip など）も同じ色にする。色は `--callout-rgb` の1か所で決め、左の線・枠・背景・見出しの帯・アイコンがその色を使う（見出しの文字は読みやすいよう濃い灰色のまま）。PDF と印刷でも同じ色。
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
- [scratch/test_html_export_links.js](file:///Users/mine/000_work/obsidian-dagnetz/scratch/test_html_export_links.js)（リンクの扱い）
- [scratch/test_html_export_toc_search.js](file:///Users/mine/000_work/obsidian-dagnetz/scratch/test_html_export_toc_search.js)（目次と検索窓）
- [scratch/test_html_export_callout_colors.js](file:///Users/mine/000_work/obsidian-dagnetz/scratch/test_html_export_callout_colors.js)（コールアウトの色）
- [scratch/test_html_export_open_browser.js](file:///Users/mine/000_work/obsidian-dagnetz/scratch/test_html_export_open_browser.js)（保存後にブラウザで開く）
