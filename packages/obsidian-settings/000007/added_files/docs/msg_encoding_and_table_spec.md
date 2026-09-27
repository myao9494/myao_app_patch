<!--
 * 仕様書: メール読み込み文字化け防止 & 表（テーブル）Markdown展開
 * Outlook MSGファイルのCP932ベストエフォート復元と、
 * ネストテーブル・セル内改行を保持したMarkdownテーブル変換の仕様。
-->

# メール読み込み文字化け防止 & 表（テーブル）Markdown展開 仕様書

## 1. 背景と課題

### 課題の概要
ObsidianにおけるOutlookメール（`.msg`）の読み込み時やサマリー作成（`createSummary`）時において、以下の問題が発生していました：
1. **文字化け**:
   - Windows日本語環境のOutlookで作成されたMSGファイルの一部は、コードページプロパティが未指定または `cp1252`（西欧言語）として記録されている。
   - その結果、日本語のANSI文字列ストリーム（件名、送信者、本文）がASCII/Latin1で誤読され、文字化け（`ÃÂ...` や `縺...` 等）が発生していた。
   - またHTML本文のデコード時にも、`TextDecoder("utf-8")` が例外を投げないため、Shift-JISのHTMLが不正文字（`\ufffd`）のまま通過していた。
2. **表（テーブル）の崩壊**:
   - OutlookのHTMLメールにはネスト（入れ子）されたテーブル（外枠レイアウトテーブルの中にデータテーブルがある構造）が多用されている。
   - 単純な非貪欲正規表現 `/<table\b[\s\S]*?<\/table>/` を適用すると外側と内側の境界が壊れ、外側の閉じタグ残骸が露出したりセルが異常結合していた。
   - セル内の複数行要素（`<p>`, `<br>`）が生の `\n` としてセル内に残るか、あるいはテーブル変換後に段落正規表現によりセルの途中に `\n\n` が差し込まれ、Markdownテーブルが分断・破壊されていた。
   - 単なる1行1セルの装飾枠用テーブルまで無意味に表化されていた。

---

## 2. 解決アーキテクチャ（Local-fulltext-search 準拠）

多層防御と文字化けスコアリング、およびボトムアップ型テーブル変換アーキテクチャを導入しました。

```
[MSGバイナリ / HTMLメール本文]
           │
           ├── 【文字化け防止・多層デコード】
           │    ├─ MsgReader parserConfig: { ansiEncoding: "windows-31j" }
           │    ├─ mojibakeScore（\ufffd ペナルティ20, 化け文字ペナルティ5, 日本語ボーナス-1）
           │    ├─ decodeBestEffortText（CP932/Windows-31J 最優先候補）
           │    ├─ recoverStringIfGarbled（Latin1誤読文字列を生バイトから再デコード）
           │    └─ HTML本文とプレーンテキストの品質比較 & 相互フォールバック
           │
           └── 【堅牢な表（テーブル）Markdown展開】
                ├─ convertHtmlTablesToMarkdown
                │    ├─ 最深部テーブルから順に変換（ボトムアップ処理）
                │    ├─ 1行1セルのレイアウト枠は表化せず中身を展開（アンラップ）
                │    ├─ セル内ブロック（<p>, <br>等）を改行・空白正規化（生の \n 排除）
                │    ├─ セル内のパイプ文字 | を \| にエスケープ
                │    └─ 変換済みMarkdownテーブルをプレースホルダーへ一時退避
                │
                └─ サマリー本文生成時の保護
                     ├─ Markdownテーブル全体を __MD_TABLE_HOLDER__ に退避
                     ├─ 周囲テキストのタグ除去・段落改行正規化を実施
                     └─ プレースホルダーを元のMarkdownテーブルへ安全に差し戻し
```

---

## 3. 実装詳細

### 3.1 文字化けスコア判定 (`mojibakeScore`)
```typescript
export function mojibakeScore(text: string): number {
    if (!text) return Number.MAX_SAFE_INTEGER;
    const badChars = (text.match(/[\ufffd\uFFFD]/g) || []).length * 20;
    const mojibakeMatches = (text.match(/[ÃÂã¢縺繧譁謚ｭｱ]/g) || []).length * 5;
    const japaneseChars = (text.match(/[\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
    return badChars + mojibakeMatches - japaneseChars;
}
```

### 3.2 ベストエフォートデコード (`decodeBestEffortText`)
- 文字列が渡された場合はLatin1生バイトへ復元してデコード。
- `windows-31j` / `shift-jis` を最優先候補とし、`utf-8`, `euc-jp`, `iso-2022-jp`, `windows-1252`, `latin1` を順次評価。
- `mojibakeScore` が最も低い（自然な日本語）結果を採用。

### 3.3 テーブル変換の多層保護
1. **ボトムアップ変換**:
   `/<table\b(?:(?!<table\b)[\s\S])*?<\/table>/gi` により、内側に他の `table` を含まないテーブルから順に変換。
2. **プレースホルダー退避**:
   変換された `| 列1 | 列2 |` テーブルは `__NESTED_TABLE_PLACEHOLDER__` に退避し、外側セルのパイプエスケープ（`replace(/\|/g, "\\|")`）から隔離。
3. **本文サニタイズとの完全分離**:
   サマリー本文生成時に `__MD_TABLE_HOLDER__` に退避し、外側の `<p>` や `<br>` 置換がテーブル内の行を破壊することを物理的に防止。

---

## 4. テストと検証結果

1. **プラグイン単体テスト (`msgParser.test.ts`)**:
   - `mojibakeScore`: 日本語と文字化け文字列の判定（PASS）
   - `decodeBestEffortText`: CP932およびUTF-8のデコード（PASS）
   - `convertHtmlTablesToMarkdown`: 基本表、複数行セル、パイプエスケープ、ネスト表、レイアウト枠展開（PASS）
2. **サマリー結合テスト (`scratch/test_create_summary.js`)**:
   - テスト31: 基本HTMLテーブルのMarkdown変換（PASS）
   - テスト32: プレーンテキストあり時のHTMLテーブル優先（PASS）
   - テスト33: ネストされたテーブルのMarkdown展開 & タグ残骸なし（PASS）
   - テスト34: CP932文字化けプロパティの自動復旧（PASS）
