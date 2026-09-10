<!-- 仕様: サマリー作成時のOutlookメール（MSG）本文サニタイズおよび文字化け・タグ露出防止の仕様書 -->
# 仕様書: サマリー作成時のOutlookメール（MSG）本文サニタイズ（文字化け・タグ露出防止）

## 概要
Obsidianの「サマリーを作る」機能（`createSummary`）において、ノート内にリンク・埋め込まれたOutlookメッセージファイル（`.msg`）を展開する際、Word/Outlook特有のOfficeメタデータや条件付きコメント（`<!--[if ...]>`、`<xml>`、`<o:p>` 等）がサマリー内に残骸として漏れ出し、「`< >`」タグの大量出現や文字化けが発生する不具合を根本から解消するための仕様です。

## 課題と原因分析
1. **Word/Outlook特有のMSOメタデータ**:
   - OutlookのHTMLメールはWordのHTMLレンダリングエンジンによって生成されるため、通常のWeb HTMLと異なり以下の要素が大量に埋め込まれています：
     - 条件付きコメント: `<!--[if gte mso 9]><xml>...</xml><![endif]-->`
     - Office/Word名前空間タグ: `<o:p></o:p>`, `<w:WordDocument>...</w:WordDocument>`, `<v:shape>...`
     - 埋め込みスタイル/フォント定義: `<style><!-- /* Font Definitions */ @font-face ... --></style>`
     - Officeクラス名: `class="MsoNormal"`, `class="WordSection1"`
2. **簡易正規表現によるパース漏れ**:
   - 従来の簡易的な正規表現（`replace(/<[^>]+>/g, "")`）では、複数行にわたる条件付きコメントや内部に属性値 `>` を含む特殊構文を除去しきれず、タグの断片が残存していました。
3. **過剰な再エスケープ処理**:
   - 残存したタグ断片に対して `.replace(/</g, "&lt;").replace(/>/g, "&gt;")` が適用されることで、消しきれなかったタグがMarkdownテキストとして固定化され、閲覧時に「`<o:p>`」などのタグが画面いっぱいに表示されていました。
4. **プレーンテキスト本文（Body）の無視**:
   - メール内に整ったプレーンテキスト本文（`parsed.Body`）が存在しているにもかかわらず、汚れたHTML本文（`parsed.HtmlBody`）を無条件で優先していたため、不必要なタグ汚染が発生していました。

## 改善仕様

### 1. `sanitizeOutlookHtml` による徹底的な事前クリーニング
HTML本文を解析・変換する前に、以下の順序でOfficeメタデータおよび不要ブロックを完全に除去します：
1. **コメントの一括除去**:
   `clean.replace(/<!--[\s\S]*?-->/g, "")`
   条件付きコメント（`<!--[if ...]>...<![endif]-->`）を内部コンテンツごと完全に消去。
2. **ヘッダー・スタイル・XMLブロックの完全除去**:
   `clean.replace(/<(head|style|script|xml|title)\b[^>]*>[\s\S]*?<\/\1>/gi, "")`
   `<head>`, `<style>`, `<script>`, `<xml>`, `<title>` の各タグとその内部テキストを一括消去。
3. **独立したDOCTYPEおよびXML/名前空間タグの消去**:
   `clean.replace(/<!DOCTYPE\b[^>]*>/gi, "")`
   `clean.replace(/<\/?xml\b[^>]*>/gi, "")`
   `clean.replace(/<\/?\w+:[^>]*>/gi, "")`（`<o:p>`, `</o:p>`, `<v:...>` などのコロンを含む名前空間タグをすべて消去）。

### 2. プレーンテキスト本文（Body）の優先利用
- 添付画像（cid画像など）が存在しない場合、かつプレーンテキスト本文（`parsed.Body`）が存在する場合は、**HTMLパース処理を行わず、クリーンなプレーンテキスト本文（`parsed.Body`）を最優先でサマリーに採用**します。
- これにより、HTML装飾の誤パースや文字化けの可能性を根本的に回避します。

### 3. 画像配置と安全なMarkdown出力
- メール内に添付画像が存在し、HTML本文内に `cid:` による配置情報がある場合は、HTML本文から画像を `![alt](relativeUrl)` のMarkdown画像リンクへ置換します。
- その後、段落（`</p>`, `</div>`）を改行に変換し、残余タグを安全に除去した上で、本文中の実体参照（`&nbsp;`, `&amp;`, `&quot;`, `&#39;`）を展開します。
- 本文中の残余山括弧（`<`, `>`）は安全にエスケープされ、Obsidian上でのスクリプト再実行やHTMLタグの誤解釈を防止します。

### 4. プラグイン（`obsidian-sidebar-explorer-tag`）側の連携強化
- `msgParser.ts` 内の `htmlToPlainText` においても同様の `sanitizeOutlookHtml` 相当の事前クリーニングを適用し、プラグイン経由で取得される `parsed.Body` のフォールバック時にもタグ残骸が混入しないように保護します。

## 対象ファイル
- [RegisterCustomCommands.md](file:///Users/mine/000_work/obsidian-dagnetz/00_templates/RegisterCustomCommands.md)
- [msgParser.ts](file:///Users/mine/000_work/obsidian-dagnetz/.obsidian/plugins/obsidian-sidebar-explorer-tag/msgParser.ts)
- [main.js](file:///Users/mine/000_work/obsidian-dagnetz/.obsidian/plugins/obsidian-sidebar-explorer-tag/main.js)

## テスト検証
- [test_create_summary.js](file:///Users/mine/000_work/obsidian-dagnetz/scratch/test_create_summary.js)
  - テスト26: Outlook特有タグ（`<!--[if ...]>`、`<xml>`、`<o:p>` 等）を含むMSGファイルのクリーン展開
  - テスト27: 画像なしメールでのプレーンテキスト本文（Body）優先利用
  - テスト28: 画像付きHTMLメールでのメタデータ除去と画像配置
