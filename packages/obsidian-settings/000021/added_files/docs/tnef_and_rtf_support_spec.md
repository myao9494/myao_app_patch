<!--
 * 仕様書: リッチテキスト（RTF）メールおよびTNEF（winmail.dat）のサマリー展開対応
 * Outlookのリッチテキスト（RTF）メールや、Exchange/Outlook経由で生成されるTNEF（winmail.dat）から
 * 本文（日本語Shift-JIS/Unicode対応）、件名、送信者、送信日時、および添付ファイルを抽出し、
 * サマリー作成時に文字化けや欠落なくAPPENDIXに正常展開する仕様。
-->

# リッチテキスト（RTF）メールおよびTNEF（winmail.dat）サマリー展開 仕様書

## 1. 背景と課題

Outlookから送信されるメール形式には、大きく「HTML形式」「プレーンテキスト形式」「リッチテキスト（RTF）形式」の3種類が存在します。
特にリッチテキスト（RTF）形式のメールでは、以下の課題がありました：

1. **純粋RTFの本文脱落**:
   - 従来の処理系は、`\fromhtml` 制御語を含むカプセル化HTML（RTF-encapsulated HTML）のみを抽出対象としていたため、`\fromhtml` を持たない純粋なRTFメールの場合に本文が空文字となり、サマリー作成時に本文が欠落していた。
2. **Shift-JIS・制御語による文字化け**:
   - RTF内のフォントテーブル（`fonttbl`）やカラーテーブル（`colortbl`）などのメタグループが本文に混入したり、`\'82\'a8` などのShift-JIS（CP932）16進バイト表記が正しくデコードされず文字化けを引き起こしていた。
3. **TNEF（winmail.dat）のカプセル化**:
   - Outlook/Exchangeからリッチテキスト形式で外部に送信される際、メール本文や添付ファイルが `application/ms-tnef`（`winmail.dat`）として1つのバイナリにカプセル化される。
   - この `winmail.dat` を直接リンクしたノートからサマリーを作成する場合や、MSG添付内の `winmail.dat` の展開に対応していなかった。

---

## 2. システム構成と処理フロー

```
[Markdownノート / サマリー作成実行]
        │
        ├── リンク解析（.msg, .dat, winmail.dat）
        │
        ▼
[parseMsgFile / parseTnefFile]
        │
   ┌────┴──────────────────────────┐
   ▼                               ▼
【.msg ファイル】              【winmail.dat / .dat】
   │                               │
   ├─ MsgReader                     │
   ├─ compressedRtf 解凍            │
   │    │                          │
   │    ├─ \fromhtml あり ──> extractHtmlFromRtf（タグと本文をつないで HTML に戻す）
   │    └─ \fromhtml なし ──> extractPlainTextFromRtf（SJIS/Unicodeデコード）
   │                               │
   ├─ 添付ファイル検査              │
   │    └─ winmail.dat 検知 ───┐   │
   │                           ▼   ▼
   └───────────────────> 【tnefParser (MS-OXTNEF)】
                               │
                               ├─ シグネチャ検証 (0x223E9F78)
                               ├─ 属性パース (Subject, From, Date, Body)
                               ├─ MAPIプロパティ (PR_BODY, PR_HTML, PR_RTF)
                               └─ 添付ファイル抽出 (画像/文書)
                               │
                               ▼
                    【サマリー APPENDIX へ統合】
                    - 件名 / 送信者 / 送信日時
                    - クリーンなMarkdown本文
                    - 添付画像（msg-assets/）の展開・リンク
```

---

## 3. 機能仕様詳細

### 3.1 純粋RTFプレーンテキスト抽出 (`extractPlainTextFromRtf`)
- **対象**: `\fromhtml` を含まない純粋なRTFテキストおよびバイナリ。
- **文字コード自動判別**（`getRtfEncoding`）:
  - `\ansicpg` のコードページを使う。指定が無ければ RTF の既定の `windows-1252`。
  - `\ansicpg1252` または指定なしでも、日本語フォント（`\fcharset128`）か `\lang1041` があれば `shift-jis`（CP932）としてデコード。
- **グループ・メタデータスキップ**:
  - `{` と `}` のネスト深度をスタック（`skipStack`）で追跡。
  - `fonttbl`, `colortbl`, `stylesheet`, `info`, `filetbl`, `pict`, `object` と、`{\*\...}` のグループは子グループを含めて完全に無視。中のエスケープした括弧（`\}`）ではグループを終わらせない。
  - `\ucN` と `\htmlrtf` の状態はグループごとに持ち、グループを閉じると元に戻す。
- **文字・制御語デコード**:
  - `\'xx` 形式の16進エスケープが連続する場合、バイト列をバッファリングして指定エンコーディングで一括デコード（マルチバイト文字が途中で壊れるのを防止）。Shift-JIS の2バイト目が文字のまま書かれた形（`\'83e`、`\'83\\`）も1文字として読む。
  - `\uN` 形式のUnicodeエスケープ（負数を含む）を `String.fromCharCode` で復元し、直後の代わりの文字（`\ucN` の個数。既定は1）を読み飛ばす。
  - `\par`, `\line` を改行に置換。`\lquote`, `\rquote`, `\ldblquote`, `\rdblquote`, `\bullet`, `\emdash`, `\endash` などは文字として出力する。
  - `\htmlrtf` で抑止された部分は出力しない。
- **表**:
  - `\intbl` / `\trowd` / `\cell` で表に入り、`\pard` で出る。行の先頭の `\pard\intbl` では出ないため、複数の行が1つの表になる。
  - セルの中の `\par` は改行にせず空白にする。

### 3.1.1 HTML から作られた RTF の復元 (`extractHtmlFromRtf`)
- Outlook は HTML メールを、`PR_HTML` を持たず `\fromhtml1` の RTF としてだけ保存することがある（MS-OXRTFEX）。
- `{\*\htmltagN ...}` の中はタグ、タグの外は本文で、`\htmlrtf` で抑止された部分は RTF 用の書式。タグの中と、抑止されていない本文を順につないで HTML に戻す。本文はタグの外にあるため、タグだけを読むと文字が消える。
- `{\*\mhtmltag...}` は読み飛ばす。`\par`, `\line` は改行に戻す。

### 3.2 TNEF（winmail.dat）パーサー (`tnefParser.ts`)
- **仕様準拠**: Microsoft MS-OXTNEF（Transport Neutral Encapsulation Format）仕様準拠のピュア TypeScript 実装。外部CLIやネイティブバイナリに依存せず、Obsidian（Node.js / Electron）内で完全動作。実際の `winmail.dat` での確認はしていない（保管庫に実ファイルが無いため、単体テストは仕様どおりに組み立てたバイナリで行う）。
- **ヘッダー検証**: 先頭4バイトのシグネチャが `0x223E9F78` であることを検証。異常時は安全に `null` を返却。
- **属性（TNEF Attributes）の読み取り**:
  - `attOemCodepage` (0x9007): 属性の文字列の文字コード（無ければ UTF-8、読めなければ Shift-JIS）
  - `attSubject` (0x8004): メールの件名
  - `attFrom` (0x8000): 送信者（TRP 構造。8バイトの見出しのあとに名前とアドレス）
  - `attDateSent` (0x8005): 送信日時
  - `attBody` (0x800C): プレーンテキスト本文
  - `attMsgProps` (0x9003): メッセージの MAPI プロパティ
  - `attAttachRendData` (0x9002): 添付の始まり
  - `attAttachTitle` (0x8010), `attAttachData` (0x800F), `attAttachment` (0x9005): 添付ファイル名、バイナリデータ、添付の MAPI プロパティ
- **MAPIプロパティ解析**（可変長の値は、1個でも「値の個数」のあとに「長さ」「値」が続き、4バイト境界まで埋まる）:
  - `PR_BODY` (0x1000): プレーンテキスト
  - `PR_RTF_COMPRESSED` (0x1009): 圧縮RTF（`decompressRTF` で展開し、`extractHtmlFromRtf` / `extractPlainTextFromRtf` で読む）
  - `PR_HTML` (0x1013): HTML本文。文字コードは `PR_INTERNET_CPID` (0x3FDE)、HTML の charset、`attOemCodepage` の順で決める
  - `PR_ATTACH_LONG_FILENAME` (0x3707): 長い添付ファイル名
  - `PR_ATTACH_MIME_TAG` (0x370E): MIMEタイプ
  - `PR_ATTACH_CONTENT_ID` (0x3712): 本文画像用 Content-ID

### 3.3 サマリー作成（`RegisterCustomCommands.md`）との連携
- **ファイル収集 (`collectMarkdownContents`)**:
  - `.md` ファイルに加え、リンクされた `.msg`、`.dat`、`winmail.dat` を再帰収集対象として自動抽出。
- **本文フォールバック順序**:
  1. クリーンなプレーンテキスト本文（`parsed.Body`）
  2. HTML本文（`parsed.HtmlBody`）のサニタイズ変換
  3. リッチテキスト本文（`parsed.RtfBody`）の `extractPlainTextFromRtf` 抽出テキスト
- **解析関数の受け渡し**:
  - プラグイン（`obsidian-sidebar-explorer-tag`）は起動時に、MSG 用の `window._sidebarExplorerParseMsgFile`、TNEF 用の `window._sidebarExplorerParseTnefFile`、本文の変換ヘルパー `window._sidebarExplorerMailHelpers`（表のMarkdown変換、RTF抽出）を公開する（`mailGlobals.ts` の `installMailParserGlobals`。プラグインの無効化時に解除する）。
  - テンプレートはメール解析の処理を持たない。プラグインが動いていない場合、メールは展開されず、通知と「解析に失敗」の案内だけがサマリーに入る。
  - テンプレートの `parseMsgFile` は、`.dat` / `winmail.dat` を TNEF 用の関数で、それ以外を MSG 用の関数で解析する。
  - TNEF の `RtfBody` は生のRTF、MSG の `RtfBody` は抽出済みのプレーンテキストで渡される。テンプレートの `extractPlainTextFromRtf` は、RTFであればプラグインの実装で抽出し、RTFでなければそのまま返す。
- **RTF抽出の細部**（`tnefParser.ts` の `extractPlainTextFromRtf`。テンプレートはこの実装を `window._sidebarExplorerMailHelpers` 経由で使う）:
  - `\emdash` / `\endash` を「—」「–」として出力する。
  - `\uN` の直後の区切りの空白と、代替文字（`\ucN` の個数）を読み飛ばす。
  - RTFソース内の生の改行（書式上の折り返し）は本文の改行として扱わない。
- **MSG添付内の `winmail.dat` 自動マージ**:
  - MSGの添付ファイル一覧に `winmail.dat` が含まれる場合、バックグラウンドで自動的に TNEF デコードを行い、本文および添付ファイル（画像・ドキュメント）を親MSGのサマリー情報へシームレスにマージ。

---

## 4. テストと検証

1. **単体テスト (`tnefParser.test.ts`)**:
   - TNEFバイナリから件名・送信者・本文・添付ファイル（PNG）が正確に抽出されること。
   - 純粋RTF（Shift-JIS制御語・フォント定義含む）から日本語「お疲れ様です。よろしくお願いいたします。」が欠落なく抽出されること。
   - 無効シグネチャバイナリに対する安全な null 返却（異常系）。
   - `attOemCodepage` の文字コード、`attMsgProps` の本文、`attAttachment` の添付情報、表、`\ucN`、Shift-JIS の2バイト目、`extractHtmlFromRtf`。
2. **全体結合テスト (`scratch/test_create_summary.js`)**:
   - テスト29: 純粋RTF形式メールがサマリー作成時に文字化けやRTF制御記号を残さずAPPENDIXに展開されること。
   - テスト30: `winmail.dat` がリンクされている場合にAPPENDIXとしてメール件名・本文が正常展開されること。
