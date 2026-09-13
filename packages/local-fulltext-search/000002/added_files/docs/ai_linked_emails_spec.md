<!-- 仕様: AIインプットエクスポート時の呼び出されたメール展開およびBase64画像埋め込み仕様書 -->
# AIインプット: 呼び出されたメール展開 & Base64画像埋め込み仕様書

## 1. 概要
AIインプット画面（Chat AI Context Export）において、Markdownファイルからリンクされているメールファイル（`.msg`, `.eml`, `winmail.dat` 等）を自動抽出し、生成される単一の自己完結型HTMLの末尾に「**📎 APPENDIX: 呼び出されたメール (Linked Emails)**」として展開する機能です。
さらに、「**🖼️ 画像・図面をBase64埋め込み**」が有効な場合、メール内のインライン画像（CID画像）および添付画像も自動的に Base64 Data URL として HTML 内へインライン埋め込みします。

---

## 2. 背景と課題
1. **Obsidian ノートとメールの連携**:
   - 業務ノート（Markdown）では、顧客や社内からの連絡メール（`.msg` / `.eml`）を `[[meeting.msg]]` や `[打ち合わせ案内](sub/report.eml)` のようにリンク参照しているケースが非常に多い。
2. **AIコンテキスト投入時の情報欠落**:
   - これまでのエクスポート機能では、Markdownファイル本体と画像・図面（Excalidraw, Drawio）のみをHTML化していたため、リンク先のメール本文がAIのインプットから脱落し、文脈が伝わらない問題があった。
3. **Office/Outlook 特有のゴミタグ・文字化け**:
   - OutlookのHTML本文にはWordエンジン由来の条件付きコメント（`<!--[if ...]>`）や名前空間タグ（`<o:p>`, `<w:WordDocument>` 等）、スタイルタグ（`<style>`）が大量に含まれ、安易にHTML化するとタグの残骸が露出して可読性が著しく低下する。

---

## 3. 仕様詳細

### 3.1 メールファイル参照の検出 (`extract_linked_email_paths`)
- **対象記法**:
  - Obsidian Wikilink: `[[mail.msg]]`, `![[mail.msg]]`, `[[path/to/mail.eml|表示名]]`
  - 標準 Markdown リンク: `[メール](mail.msg)`, `![添付](path/to/mail.eml)`
- **対象拡張子**:
  - `.msg`, `.eml`, `.dat` (`winmail.dat`)
- **パス解決順序**:
  1. 絶対パス
  2. Markdownファイルの親ディレクトリ相対（`target_file.parent / target`）
  3. ファイル名での同ディレクトリ探索
  4. Vaultルート相対（`vault_path / target`）
  5. Vault配下の同名ファイル再帰探索
- 重複するメールファイルは解決済み絶対パスで一意化し、1回のみ出力。

### 3.2 Outlook/Office HTMLサニタイズ (`sanitize_outlook_html`)
- `obsidian-dagnetz` の仕様に準拠し、以下の順序で徹底的に事前クリーニング：
  1. 条件付きコメントおよび全コメントの完全除去: `<!--[\s\S]*?-->`
  2. 不要ブロックタグの完全除去: `<(head|style|script|xml|title)\b[^>]*>[\s\S]*?<\/\1>`
  3. 独立した `<!DOCTYPE>`, `<?xml>`, `</?xml...>`, および名前空間タグ `</?\w+:[^>]*>`（`<o:p>`, `</o:p>`, `<w:...>`, `<v:...>` 等）の完全除去。

### 3.3 メール本文と画像のレンダリング (`render_email_to_html`)
- **プレーンテキスト本文の優先判定**:
  - `include_images=False` の場合、または（添付画像なし かつ HTML内に `<table>` なし かつ プレーンテキスト本文が存在する場合）:
    - タグ混入の恐れが一切ないクリーンなプレーンテキスト本文（`body_plain`）を最優先で整形出力。
- **画像埋め込み (`include_images=True`)**:
  - メールの添付画像（PNG, JPEG, GIF, WebP, BMP）を検出。
  - CID参照（`<img src="cid:xxx" ...>`）を Base64 Data URL（`data:image/png;base64,...`）へインライン置換。
  - 本文中に配置されなかった画像は、メール末尾に「📎 メール内の画像」セクションとして `<img>` タグを一覧展開。

### 3.4 HTML構造と目次（TOC）連携
- **目次 (TOC)**:
  - 目次末尾に「**📎 APPENDIX: 呼び出されたメール ({N} 件)**」と各メールへのアンカーリンク（`#linked-email-{idx}`）を追加。
- **APPENDIX セクション**:
  - 各メールを `<article class="document-article linked-email-article" id="linked-email-{idx}">` としてレンダリング。
  - メタデータ枠（件名、差出人、宛先、送信日時、ファイルパス）を表示。
  - レンダリング済みメール本文を表示。

---

## 4. フロントエンド UI
- **「✉️ アウトプットに呼び出されるメールを追加する」チェックボックス**:
  - 初期値: `true`（ON）
  - 「🖼️ 画像・図面をBase64埋め込み」「📝 マークダウン元データを含める」と並列配置。
- **生成完了情報**:
  - メール件数（`| メール: N 件`）および埋め込み画像数（`| 埋め込み画像: M 枚`）を完了バナーに明示。

---

## 5. テスト検証
- `backend/tests/test_ai_html_linked_emails.py`:
  - `test_sanitize_outlook_html`: Outlookタグ・条件付きコメントの完全除去。
  - `test_extract_linked_email_paths`: Wikilink/Markdownリンクからのメール検出。
  - `test_export_documents_to_html_with_linked_eml`: EML展開とTOC追加、OFF時の除外。
  - `test_export_documents_to_html_with_linked_eml_and_base64_images`: CID画像のBase64埋め込み。
  - `test_export_documents_to_html_with_linked_msg`: MSG（extract_msg）のOfficeサニタイズと展開。
- `frontend/src/vectorSearchUi.test.ts`:
  - AiInputPage UI および APIクライアントのオプション連携テスト。
