<!-- 仕様: AIコンテキスト用トークン最適化（メールCC & DataviewJSコード除外）仕様書 -->
# AIコンテキスト用トークン最適化（メールCC & DataviewJSコード除外）仕様書

## 1. 目的と背景
社内AI（LLM）にAIインプットから出力したドキュメント（HTML / PDF）を投入した際、以下の2点がコンテキストとして冗長であり、AIのコンテキスト長・トークンを不必要に大量消費しているという課題が判明した：
1. **メールのCC（Cc）情報**:
   - 転送・返信メールの引用ヘッダーやメタデータに含まれる数十人のメールアドレス一覧。
   - 会話やドキュメントの文脈理解に寄与しないにもかかわらず、大量のトークンを浪費する。
2. **DataviewJS (`dataviewjs`) のコードブロック**:
   - ObsidianのDataviewJSプラグインによる動的スクリプトコード（JavaScriptコード）。
   - 静的テーブルとしてレンダリングできないコードブロックが生のまま出力されたり、マークダウン元データ（`doc-raw-markdown`）内に数百行の生JSコードが含まれてしまい、トークンを消費する。

本機能では、AIインプット生成時にこれらを自動的にサニタイズ・除去・省略し、AIが真に必要な本文と図面情報だけに集中できる**クリーンで軽量なコンテキスト**を生成する。

---

## 2. 仕様詳細

### 2.1 Dataview / DataviewJS コードの除去・省略 (`strip_dataview_code`)
- **レンダリング本文**:
  - 静的配列（`noteListRows = [...]` や `dv.table(...)` リテラル）は従来どおり視覚的なHTMLテーブルに変換。
  - 静的テーブルに展開できない生スクリプトコード（`dv.pages()`, `dv.current()` 等）は、生コードブロックを出力せず、簡潔なプレースホルダー `<!-- [DataviewJSコード省略] -->` または `<p class="dataview-omitted-note"><em>📊 [DataviewJS クエリ省略 (トークン最適化)]</em></p>` に置換。
- **マークダウン元データ (`details.doc-raw-markdown`)**:
  - `strip_frontmatter` および `strip_excalidraw_data` に加え、すべての ````dataviewjs ... ```` および ````dataview ... ```` ブロックを自動除去。
  - AIが元データを参照する際にも無駄なスクリプトコードが一切含まれないようにする。

### 2.2 メールのCC（Cc）情報の除去・サニタイズ (`strip_email_cc_lines`)
- **プレーンテキスト本文 (`body_plain`)**:
  - 転送・返信引用ヘッダー（例: `Cc: user1@example.com, user2@example.com...`、`CC: ...`、`ＣＣ：...`）を正規表現で検出。
  - 複数行にわたるカンマ区切りのメールアドレス一覧を検出し、完全除去または `[Cc: 省略]` に置換。
- **HTML本文 (`body_html`)**:
  - Outlook等で挿入される `<p><b>Cc:</b> ...</p>` や `<tr><th...>Cc:</th><td>...</td></tr>` などのCCブロックを正規表現・DOM置換で除去。
- **メタデータ**:
  - ヘッダー表示（`linked-email-meta`）にCCを含めず、件名・差出人・宛先・日時のみに限定。

### 2.3 マークダウン元データ（生ファイル）のデフォルト除外 (`include_raw_markdown = False`)
- **課題**: HTML本文に見出し・段落・リスト・テーブル・画像等が完全にレンダリングされているにもかかわらず、末尾に「📝 マークダウンファイルの元データ」として全く同一のテキストが重複添付されており、トークンを実質2倍消費していた。
- **改善**:
  - バックエンドAPI (`export_documents_to_html`, `AiHtmlExportRequest`, `SaveAiPdfRequest`, `AiPdfExportRequest`) において `include_raw_markdown: bool = False` を既定値に変更。
  - フロントエンド画面 (`AiInputPage`) において、初期ステートを `includeRawMarkdown: false` に変更し、ラベルに `(非推奨: トークン重複)` を明記。
  - ユーザーが明示的にチェックを入れない限り、マークダウン生データは一切出力されず、トークン消費量が大幅に削減される。

### 2.4 オプション制御 (`optimize_tokens: bool = True`)
- デフォルトで `optimize_tokens=True`（有効）として動作。
- AIインプット画面（`AiInputPage`）のステップ3に「🧹 トークン最適化（メールCC & DataviewJSコード除外）」トグル（既定: ON）を設置。

---

## 3. テスト計画 (TDD)
1. `strip_dataview_code_from_markdown`:
   - 複雑なDataviewJSコードが生コードとして残らず省略されること。
   - 静的テーブル形式は維持されること。
   - 元データマークダウンからDataviewJSが完全に除去されること。
2. `strip_email_cc`:
   - プレーンテキスト本文中の長大なCcヘッダー行が除去されること。
   - 複数行のCc行が除去されること。
   - HTML本文中のCcテーブル/パラグラフが除去されること。
3. `export_documents_to_html`:
   - `optimize_tokens=True` 時にメールCCとDataviewJSがクリーンアップされ、生成サイズおよびトークン数が削減されること。
   - `include_raw_markdown` 未指定（既定呼び出し）時に、マークダウン元データ（`doc-raw-markdown`）が出力されず、二重化が抑止されること。
   - 明示的に `include_raw_markdown=True` を指定した場合のみ元データが出力されること。
