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
   │    ├─ \fromhtml あり ──> HTML抽出
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
- **文字コード自動判別**:
  - `\ansicpg932` または `\lang1041` が検出された場合は `shift-jis`（CP932）としてデコード。
  - `\ansicpg1252` は `windows-1252`、その他各言語コードページに対応。
- **グループ・メタデータスキップ**:
  - `{` と `}` のネスト深度をスタック（`skipStack`）で追跡。
  - `fonttbl`, `colortbl`, `stylesheet`, `info`, `*\datastore`, `*\xmlnstbl`, `*\themedata`, `pict`, `object` 等のメタグループは子グループを含めて完全に無視。
- **文字・制御語デコード**:
  - `\'xx` 形式の16進エスケープが連続する場合、バイト列をバッファリングして指定エンコーディングで一括デコード（マルチバイト文字が途中で壊れるのを防止）。
  - `\uN` 形式のUnicodeエスケープ（負数を含む）を `String.fromCharCode` で復元。
  - `\par`, `\line` を改行に置換。

### 3.2 TNEF（winmail.dat）パーサー (`tnefParser.ts`)
- **仕様準拠**: Microsoft MS-OXTNEF（Transport Neutral Encapsulation Format）仕様準拠のピュア TypeScript 実装。外部CLIやネイティブバイナリに依存せず、Obsidian（Node.js / Electron）内で完全動作。
- **ヘッダー検証**: 先頭4バイトのシグネチャが `0x223E9F78` であることを検証。異常時は安全に `null` を返却。
- **属性（TNEF Attributes）の読み取り**:
  - `attSUBJECT` (0x8004): メールの件名
  - `attFROM` (0x8000): 送信者名・アドレス
  - `attDATESENT` (0x8008): 送信日時
  - `attBODY` (0x800C): プレーンテキスト本文
  - `attMAPIPROPS` (0x9005): MAPI拡張プロパティバッファ
  - `attATTACHTITLE` (0x8010), `attATTACHDATA` (0x800F), `attATTACHMAPIPROPS` (0x9006): 添付ファイル名、バイナリデータ、MAPI添付プロパティ
- **MAPIプロパティ解析**:
  - `PR_BODY` (0x1000): プレーンテキスト
  - `PR_RTF_COMPRESSED` (0x1009): 圧縮RTF（`decompressRTF` および `extractPlainTextFromRtf` により展開）
  - `PR_HTML` (0x1013): HTML本文
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
- **MSG添付内の `winmail.dat` 自動マージ**:
  - MSGの添付ファイル一覧に `winmail.dat` が含まれる場合、バックグラウンドで自動的に TNEF デコードを行い、本文および添付ファイル（画像・ドキュメント）を親MSGのサマリー情報へシームレスにマージ。

---

## 4. テストと検証

1. **単体テスト (`tnefParser.test.ts`)**:
   - TNEFバイナリから件名・送信者・本文・添付ファイル（PNG）が正確に抽出されること。
   - 純粋RTF（Shift-JIS制御語・フォント定義含む）から日本語「お疲れ様です。よろしくお願いいたします。」が欠落なく抽出されること。
   - 無効シグネチャバイナリに対する安全な null 返却（異常系）。
2. **全体結合テスト (`scratch/test_create_summary.js`)**:
   - テスト29: 純粋RTF形式メールがサマリー作成時に文字化けやRTF制御記号を残さずAPPENDIXに展開されること。
   - テスト30: `winmail.dat` がリンクされている場合にAPPENDIXとしてメール件名・本文が正常展開されること。
