<!-- 仕様: AIコンテキスト用トークン最適化（メール宛先 & DataviewJSコード除外）仕様書 -->
# AIコンテキスト用トークン最適化（メール宛先 & DataviewJSコード除外）仕様書

## 1. 目的と背景
社内AI（LLM）にAIインプットから出力したドキュメント（HTML / PDF）を投入した際、以下の2点がコンテキストとして冗長であり、AIのコンテキスト長・トークンを不必要に大量消費しているという課題が判明した：
1. **メールの宛先（To・CC・BCC）情報**:
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

### 2.2 メールの宛先（To・CC・BCC）の除去 (`strip_email_recipient_lines`)
- 除去の規則は `app/vector/email_recipients.py` の `strip_email_recipient_lines` 1 か所に置き、HTML 書き出し（`email_html.render_email_to_html`）と
  Markdown＋画像の書き出し（`markdown_image_exporter`）で共用する。
- 含めるかは `include_email_recipients`（既定 `False` = 含めない）で切り替える。`optimize_tokens` とは独立（2.5 を参照）。
- 見出しは `宛先` / `To` / `Cc` / `Bcc`（大文字小文字・全角 `ＣＣ`・全角コロン `：` を問わない）。差出人・送信日時・件名と本文は残す。
- 見出しが**行頭にあるときだけ**対象にする。文中の `mailto:` や `Go to:` は消さない。
- **プレーンテキスト本文 (`body_plain`)**:
  - 行頭（引用の `>` は読み飛ばす）が見出しで始まる行を除く。
  - 続く折り返し行は、インデントされた行か、直前の宛先行が `,` `;`（全角・`、` を含む）で終わるときの行だけを除く。
    区切り文字で終わっていなければ、次の行は本文として残す。
- **HTML本文 (`body_html`)**:
  - `<br>`・`</p>`・`</div>`・`</tr>`・`</li>` で区切った 1 行の表示文字が見出しで始まるとき、その行の文字とリンク（`<a>`）を除く。
    その他のタグは残すので、開始タグだけが消えて表示が崩れることはない。行末の `<br>` も除いて空行を作らない。
  - Outlook 日本語版の `<b>宛先<span lang="EN-US">:</span></b>` のように、見出しとコロンの間にタグがあっても対象にする。
  - 1 回の分割と行ごとの先頭一致だけで判定するので、本文の長さに対して線形の時間で終わる（1 MB の表だらけの本文で約 0.02 秒）。
- **メタデータ**:
  - ヘッダー表示（`linked-email-meta`）は件名・差出人・送信日時・パス。宛先は `include_email_recipients=True` のときだけ出す。CC は出さない。

### 2.3 マークダウン元データ（生ファイル）のデフォルト除外 (`include_raw_markdown = False`)
- **課題**: HTML本文に見出し・段落・リスト・テーブル・画像等が完全にレンダリングされているにもかかわらず、末尾に「📝 マークダウンファイルの元データ」として全く同一のテキストが重複添付されており、トークンを実質2倍消費していた。
- **改善**:
  - バックエンドAPI (`export_documents_to_html`, `AiHtmlExportRequest`, `SaveAiPdfRequest`, `AiPdfExportRequest`) において `include_raw_markdown: bool = False` を既定値に変更。
  - フロントエンド画面 (`AiInputPage`) において、初期ステートを `includeRawMarkdown: false` に変更し、ラベルに `(非推奨: トークン重複)` を明記。
  - ユーザーが明示的にチェックを入れない限り、マークダウン生データは一切出力されず、トークン消費量が大幅に削減される。

### 2.4 オプション制御 (`optimize_tokens: bool = True`)
- デフォルトで `optimize_tokens=True`（有効）として動作。
- AIインプット画面のプレビュー（対象ファイル選択の上）に「🧹 トークン最適化」のチェックボックス（既定: ON）を置く。
  切り替えると、切り替えた値でプレビューを作り直す。
- メールの宛先の除去は `optimize_tokens` ではなく `include_email_recipients` で切り替える（2.5）。

### 2.5 メールの宛先を含めるか (`include_email_recipients: bool = False`)
- API: `POST /api/export/ai-html`・`/ai-html/download`・`/ai-bundle/save`・`/ai-bundle/generate` の要求に `include_email_recipients` を持つ。省略時は `False`。
- AIインプット画面のプレビューで「🧹 トークン最適化」の隣に「✉️ メールの宛先を含める」のチェックボックス（既定: OFF）を置く。
  切り替えると、切り替えた値でプレビューを作り直す。「2ファイルを保存」にも同じ値を送る。
- `False`: HTML の見出し枠に宛先を出さず、本文の To・CC・BCC 行を除く。Markdown の付録も宛先を出さず、本文の宛先行を除く。
- `True`: HTML の見出し枠に宛先を出し、本文の宛先行も残す。Markdown の付録は `- **宛先**: ...` を出し、本文の宛先行を残す。

---

## 3. テスト計画 (TDD)
1. `strip_dataview_code_from_markdown`:
   - 複雑なDataviewJSコードが生コードとして残らず省略されること。
   - 静的テーブル形式は維持されること。
   - 元データマークダウンからDataviewJSが完全に除去されること。
2. `strip_email_recipient_lines`（`tests/test_email_recipient_strip.py`）:
   - プレーンテキストの To・CC・BCC 行（日本語・全角・引用 `>`・折り返し行）が除去され、他のヘッダーと本文が残ること。
   - HTML の表・段落・`<b>To:</b>` 形式・Outlook 日本語版の形式で宛先が除去され、`mailto:` リンクや文中の見出しは残ること。
   - 長い本文でも 1 秒以内に終わること。
3. `include_email_recipients`（`tests/test_ai_email_recipients_option.py`）:
   - 既定では HTML・Markdown とも宛先が出ず、`True` のときは出ること。`optimize_tokens` と独立に効くこと。API から渡せること。
4. `export_documents_to_html`:
   - `optimize_tokens=True` 時にDataviewJSがクリーンアップされ、既定ではメールCCも除去されること。
   - `include_raw_markdown` 未指定（既定呼び出し）時に、マークダウン元データ（`doc-raw-markdown`）が出力されず、二重化が抑止されること。
   - 明示的に `include_raw_markdown=True` を指定した場合のみ元データが出力されること。
