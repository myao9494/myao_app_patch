# AIインプットにおけるExcalidraw貼り付け画像（PNG等）のHTML表示・復元 仕様書

## 概要
AIインプット機能（自己完結HTMLエクスポート）において、Excalidraw図面（`.excalidraw.md` / `.excalidraw`）内に貼り付けられているPNGなどの画像がHTML上で正しく解決・描画されるようにする仕様。
Obsidian Excalidrawプラグイン（`obsidian-dagnetz`）の仕様に準拠し、インラインBase64、Markdownの `## Embedded Files` セクション、およびハッシュファイル名（`{fileId}.png` 等）の3系統すべての画像形式をサポートする。

---

## 背景と課題
従来のバックエンド実装（`html_exporter.py`）では、Excalidrawの動的ベクターSVG生成（`excalidraw_to_svg`）時に `Drawing` JSON内の `files[fileId].dataURL` のみをインライン参照していた。
しかし、Obsidian環境のExcalidrawノートでは以下の画像管理パターンが存在する：
1. **インライン Base64 形式**: `files[fileId].dataURL` に画像データが直接保持されている形式。
2. **`## Embedded Files` WikiLink マッピング形式**: Markdownテキスト内の `## Embedded Files` セクションに `{fileId}: [[画像.png]]` としてWikiLinkが記述され、実際の画像ファイルは同フォルダやVault内（例: `01_data/common_image/` 等）に別ファイルとして管理される形式。
3. **同名ハッシュファイル形式**: `{fileId}.png`（例: `0fd5abb9830e51ddaf1d5b4f9e3b493519bb6318.png`）としてノートと同じフォルダまたはVault内に配置される形式。

従来は2と3の解決ロジックが存在せず、また `excalidraw_to_svg` にVaultパスやノートパスが渡されていなかったため、動的SVG生成時に `<image>` 要素が0件となり、貼り付け画像が抜け落ちていた。

---

## 実装仕様

### 1. `extract_excalidraw_data` による `## Embedded Files` の抽出
- Markdownテキスト内の `# Excalidraw Data` 下にある `## Embedded Files` セクションをパース。
- 正規表現 `^([a-zA-Z0-9_-]+)\s*:\s*!?\[\[([^\]|]+)(?:\|[^\]]*)?\]\]` により、`fileId` と WikiLink のマッピングを抽出。
- 抽出結果を返却データ辞書 `data["embedded_files"]` に格納。

### 2. 多段階画像解決ヘルパー `resolve_excalidraw_image_data_url`
画像要素（`elem.get("fileId")`）に対し、以下の優先順位でBase64 Data URLを解決：
1. **インライン Data URL**: `file_entry.get("dataURL")` が `data:image/` で始まっていればそれを採用。
2. **`## Embedded Files` のWikiLink探索**:
   - カレントディレクトリ（ノートの親フォルダ）
   - Vaultルートディレクトリ
   - Vault親ディレクトリ
   - 共通画像フォルダ（`01_data/common_image`, `attachments`, `images` 等）
   - Vault全体の再帰探索
3. **ハッシュファイル名探索**:
   - `{file_id}.png`, `{file_id}.jpg`, `{file_id}.jpeg`, `{file_id}.svg`, `{file_id}.webp`, `{file_id}.bmp` をカレントフォルダおよびVault全体から探索。

### 3. `excalidraw_to_svg` の画像埋め込み
- シグネチャに `vault_path: Optional[Union[str, Path]] = None`, `current_file_path: Optional[Union[str, Path]] = None` を追加。
- `resolve_excalidraw_image_data_url` で解決したBase64 Data URLを用いて、SVGに `<image href="{data_url}" xlink:href="{data_url}" x="{x}" y="{y}" width="{w}" height="{h}" opacity="{opacity}" preserveAspectRatio="none" />` を確実に出力。

### 4. `export_documents_to_html` における Excalidraw ノート直接指定対応
- ユーザーがAIインプットの対象ファイルとして Excalidraw ノート（`.excalidraw.md` 等）を直接指定した場合、スキップせず図面（SVGまたはキャッシュPNG）をドキュメント本文（`<article>`）に美しい画像としてレンダリング。

---

## 変更対象ファイル
- `backend/app/vector/html_exporter.py`
- `backend/tests/test_ai_html_excalidraw_image.py`
- `claude.md`
- `AGENTS.md`
- `docs/ai_html_excalidraw_image_spec.md`
- `docs/excalidraw_image_flow.excalidraw.md`
