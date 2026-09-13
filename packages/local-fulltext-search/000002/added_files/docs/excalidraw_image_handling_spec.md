# 仕様書: .excalidraw.md の画像ファイル（図面アセット）取り扱い

## 1. 概要
Obsidian Vault 内において、`明和高校.excalidraw.md` のような `.excalidraw.md` ファイルは拡張子こそ `.md` であるものの、実態は図面・画像アセットです。
`obsidian-dagnetz` の仕様・実装に準拠し、本システムにおいても `.excalidraw.md` を「文書」ではなく「画像・図面ファイル」として取り扱います。

これにより、AIインプットやサマリー生成時に大量の Excalidraw JSON や内部メタデータが文書本文として生展開されるのを防ぎ、Markdown 文書から参照されるプレビュー画像（Base64 Data URL）として自動埋め込みを行います。

---

## 2. コア仕様

### 2.1 AIインプット用 HTML エクスポート (`html_exporter.py`)
- **文書収集からの完全除外**:
  - `export_documents_to_html` に渡されたファイルリストに `.excalidraw.md` や Excalidraw 図面データを含むノート（`is_excalidraw_backed_markdown`）が含まれている場合、文書記事（`<article>`）としての出力をスキップします。
  - `obsidian-dagnetz` の `linkedFile.extension === "md" && !linkedFile.name.endsWith(".excalidraw.md")` に準拠。
- **リンク記法の画像・図面自動置換 (`replace_obsidian_image_embeds`)**:
  - **埋め込み記法**: `![[明和高校.excalidraw.md]]`, `![[明和高校.excalidraw.md|300]]`
  - **通常リンク記法**: `[[明和高校.excalidraw.md]]`, `[[明和高校.excalidraw.md|300]]`, `[[明和高校.excalidraw.md|別名]]`
  - `!` の有無に関わらず、`.excalidraw.md` へのリンクは画像・図面として検出し、`.excalidraw-cache/` 配下のプレビュー画像（PNG/SVG）またはノート内 JSON から動的生成したベクター SVG を Base64 Data URL 化して `<img src="data:image/...;base64,...">` タグへ置換します。
  - 幅指定（例: `|300`）がある場合は `width="300"` 属性を付与します。

### 2.2 AIインプット画面の候補選定 (`AiInputPage.tsx` / `aiInputCandidate.ts`)
- 「ステップ 2: AIにインプットするノートを選択」の候補一覧において、`isAiInputDocumentCandidate` を適用します。
- `.excalidraw.md`、`.excalidraw`、`.dio.svg`、`.drawio.svg`、および一般的な画像ファイル（PNG, JPG, WebP, SVG 等）は「画像・図面アセット」として文書候補から除外されます。
- これらアセットは、選択された各 Markdown 文書から参照されることで、HTML 内へ自動的にインライン埋め込みされます。

### 2.3 ファイル種別 & Catppuccin アイコン判定
- 複合拡張子 `.excalidraw.md` を `.md` と明確に分離し、Catppuccin の `excalidraw.svg` アイコンを割り当てます。
  - Web UI: `frontend/src/fileIcon.ts`
  - macOS / Flet ランチャー: `launcher/src/launcher_app/file_icons.py`
  - Windows WPF ランチャー: `launcher/windows/LocalSearchLauncher/SearchModels.cs`
- 同様に `.drawio.svg` および `.dio.svg` も `drawio.svg` アイコンを割り当てます。

---

## 3. 設計図
[excalidraw_image_flow.excalidraw.md](file:///Users/mine/000_work/app/Local-fulltext-search/docs/excalidraw_image_flow.excalidraw.md) を参照。
