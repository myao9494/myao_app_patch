<!-- 仕様: AIインプット用高精度PDFエクスポート仕様書 -->
# AIインプット: 高精度PDFエクスポート仕様書

## 1. 目的と背景
社内AI（Azure OpenAIラッパーや社内専用チャットAI等）において、自己完結型HTMLファイル内にBase64形式で埋め込まれた画像（`data:image/...;base64,...`）がファイルパーサーによってプレーンテキストとして扱われ、マルチモーダルVision機能（視覚認識）へ画像として渡されない問題がある。
一方、多くの社内AIやマルチモーダルLLMは、**PDFファイル**であれば各ページを画像としてレンダリングし、埋め込まれた図面や画像を高精度に視覚認識できる。

本機能は、AIインプット画面で生成された自己完結ドキュメント（テキスト、Markdown、Excalidraw/draw.io図面、添付画像、メール）を、**端末内蔵ブラウザ（Chrome / Edge）のレンダリングエンジンを活用して直接A4 PDFとして出力・保存・ダウンロード**できるようにする。

---

## 2. システム構成・変換方式

### 2.1 端末内蔵ブラウザによるヘッドレス変換 (`pdf_converter.py`)
- **外部ダウンロード完全不要**: 会社のセキュリティポリシーやプロキシ環境下でも動作するよう、Playwright同梱の追加ブラウザダウンロード（`playwright install`）は使用しない。
- **端末ブラウザの自動検出**:
  1. `chrome`（Google Chrome）
  2. `msedge`（Microsoft Edge）
  3. `chromium`（Chromium）
  の優先順位で使用可能なブラウザチャンネルを自動検出し、ヘッドレスモードで起動する。
- **Blinkエンジンによる完全忠実なレンダリング**:
  - Base64 Data URL画像（PNG, JPG, SVG）
  - Excalidrawの動的ベクターSVG
  - テーブル、コードブロック、バッジ、インラインスタイル
  をブラウザで表示した通りの完全なレイアウトでPDF化する。

### 2.2 印刷・PDF用CSS最適化 (`@media print`)
生成されるHTMLのスタイルシートに印刷用CSSを追加：
- `@page { size: A4 portrait; margin: 12mm 15mm; }`
- `-webkit-print-color-adjust: exact; print-color-adjust: exact;`（背景色・境界線・バッジ色をPDFに保持）
- 改ページ制御:
  - `.document-article`, `.email-appendix-item`: `break-inside: avoid; margin-bottom: 24px;`
  - `.ai-prompt-section`, `.document-toc`: `break-inside: avoid;`
  - `img`, `svg`, `figure`: `break-inside: avoid; max-width: 100%;`
  - 見出し（`h1`, `h2`, `h3`）の直後での改ページ防止（`break-after: avoid;`）

---

## 3. APIエンドポイント仕様

### 3.1 `POST /api/export/ai-pdf/download`
- **概要**: 選択されたドキュメントまたはHTML文字列からPDFを生成し、ブラウザダウンロード用レスポンスとして返却する。
- **リクエスト**: `AiPdfExportRequest`（`html_content` または `file_paths`, `title`, `prompt` 等）
- **レスポンス**: `application/pdf`（バイナリ）
  - ヘッダー: `Content-Disposition: attachment; filename="{title}.pdf"`

### 3.2 `POST /api/export/ai-pdf/save`
- **概要**: 生成したPDFをローカルディスク（Downloadsフォルダまたは指定ディレクトリ）に直接保存し、絶対パスを返却する。
- **リクエスト**: `SaveAiPdfRequest`（`html_content` またはドキュメント指定、`file_name`, `target_dir`）
- **レスポンス**:
  ```json
  {
    "success": true,
    "saved_path": "/Users/xxx/Downloads/AI_Context_Document.pdf",
    "file_name": "AI_Context_Document.pdf",
    "size_bytes": 123456
  }
  ```

---

## 4. UI（AIインプット画面）連携

### 4.1 アクションボタンの配置
ステップ4の結果パネルおよび特大プレビューモーダルの上部アクションバーに以下を配置：
1. **📕 PDFダウンロード (.pdf)**: ブラウザ経由で即時PDFをダウンロード。
2. **💾 PDFを保存（パスをコピー）**: バックエンド経由でローカルに保存し、絶対ファイルパスをクリップボードに自動コピー。社内AIへのドラッグ＆ドロップやファイル選択ダイアログでパス貼り付けが可能。
3. **🖨️ 印刷 (PDF)**: プレビューiframeの `window.print()` を起動するブラウザ標準フォールバック。

---

## 5. テスト計画 (TDD)
1. **`test_pdf_converter.py`**:
   - 端末ブラウザ検出の正常動作
   - HTML文字列から有効なPDFバイナリ（`%PDF-` マジックナンバーで始まるバイト列）の生成確認
   - Base64画像を含むHTMLが正常にPDF化されることの検証
2. **`test_api_export_pdf.py`**:
   - `/api/export/ai-pdf/download` の正常動作
   - `/api/export/ai-pdf/save` のローカル保存と絶対パス返却の検証
3. **フロントエンドテスト**:
   - AiInputPage にPDFダウンロード・保存・印刷ボタンが存在し、APIと連動することの検証
