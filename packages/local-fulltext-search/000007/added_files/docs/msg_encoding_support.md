# Outlook MSG エンコーディング対応 & 文字化け防止仕様書

## 1. 背景と課題

### 課題の概要
AIインプット用HTMLエクスポート機能（`export_documents_to_html` / `parse_msg_file`）において、Markdownファイルから参照されているOutlookメールファイル（`.msg`）を展開する際、以下のようなエラーが発生しHTML生成処理全体が中断（500エラー）する問題がありました。

```text
UnicodeDecodeError: 'charmap' codec can't decode byte 0x8d in position 4: character maps to <undefined>
```

### 原因の特定
1. **Outlookファイル仕様とコードページの誤認**:
   - 日本語Windows環境のOutlook等で作成・保存された一部のMSGファイルでは、メッセージのコードページプロパティ `3FFD0003`（`PR_MESSAGE_CODEPAGE`）が `1252`（`windows-1252` / 西欧言語）として記録されている、またはプロパティ未設定により `iso-8859-15` / `windows-1252` がデフォルト適用されます。
   - しかし実際のANSI文字列ストリーム（`__substg1.0_0037001E` 件名、`__substg1.0_1000001E` 本文、`__substg1.0_0C1A001E` 送信者 等）には、日本語（`CP932` / `Shift_JIS` / `Windows-31J`）でエンコードされたバイト列が書き込まれています。
2. **cp1252 未定義文字でのクラッシュ**:
   - `CP932` の日本語バイト（特に全角記号の `0x81` や、漢字の第1バイト `0x8d`, `0x8f`, `0x90`, `0x9d` など）は `cp1252` では未定義コードです。
   - `extract_msg` が `windows-1252` デコーダでこれをデコードしようとした瞬間に `UnicodeDecodeError` が発生し、プロパティ取得処理が中断していました。

---

## 2. 解決アーキテクチャ（Obsidian RegisterCustomCommands.md 準拠）

Obsidian側（`RegisterCustomCommands.md` の `decodeStream`, `decodeBestEffortText`, `mojibakeScore`）の実績あるアプローチを採用し、多層防御・ベストエフォート復旧アーキテクチャを構築しました。

```mermaid
flowchart TD
    A[MSGファイル解析開始] --> B{openMsg通常オープン}
    B -- 成功 --> D[各プロパティ取得]
    B -- UnicodeDecodeError --> C[openMsg overrideEncoding='cp932' で再試行]
    C -- 成功 --> D
    C -- 失敗 --> Err[安全にNone返却 / インデックス時は空文字]

    D --> E{属性アクセス (subject, body等)}
    E -- 正常取得 --> F{mojibake_score 判定}
    F -- 良好 (<= 40) --> H[採用]
    F -- 文字化け疑い (> 40) --> G[生ストリーム getStream 直接読み込み]
    E -- UnicodeDecodeError --> G

    G --> I{ストリーム種別の判定}
    I -- 001F (Unicode) --> J[utf-16le デコード]
    I -- 001E (ANSI) --> K[decode_best_effort_text CP932最優先]
    I -- 1013 (HTML) --> L[meta charset検出 + ベストエフォートデコード]

    J --> H
    K --> H
    L --> H
    H --> M[プレーン本文とHTML本文の相互フォールバック]
    M --> N[添付画像のBase64抽出]
    N --> O[HTML APPENDIX / 検索テキストへ正常出力]
```

---

## 3. 実装の詳細

### 3.1 文字化けスコア判定 (`mojibake_score`)
```python
def mojibake_score(text: str) -> float:
    # 不正文字 \ufffd はペナルティ 20
    bad_chars = text.count("\ufffd") * 20
    # 典型的な文字化け文字（Ã, Â, ã, ¢, 縺, 繧, 譁, 謚, ｭ, ｱ 等）はペナルティ 5
    mojibake_matches = len(re.findall(r"[ÃÂã¢縺繧譁謚ｭｱ]", text)) * 5
    # 日本語文字（ひらがな・カタカナ・漢字）は正しさの証拠としてボーナス -1
    japanese_chars = len(re.findall(r"[\u3040-\u30ff\u3400-\u9fff]", text))
    return float(bad_chars + mojibake_matches - japanese_chars)
```

### 3.2 ベストエフォートデコード (`decode_best_effort_text`)
バイト列に対し、以下の優先順位でデコードを試行し、`mojibake_score` が最も低い（自然な日本語）結果を採用します。
1. `preferred_encodings`（指定時、またはHTMLメタタグのcharset）
2. `cp932`（Windows-31J / Shift_JIS）
3. `shift_jis`
4. `utf-8`
5. `euc_jp`
6. `iso2022_jp`
7. `cp1252`
8. `latin1`

### 3.3 プロパティの安全取得 & 生ストリーム復旧 (`_safe_read_msg_prop`)
- 通常のプロパティ参照（`msg.subject` など）が `UnicodeDecodeError` を投げた場合、直ちに生ストリーム（`__substg1.0_0037001F` または `001E`）からバイト列を直接取得してデコードします。
- これにより、コードページが 1252 に固定された状態でも、中身の日本語バイト列を 100% 確実に復元できます。

### 3.4 HTML本文・プレーンテキスト相互補完
- HTML本文（`htmlBody`）は `<meta charset="...">` を解析して正確にデコード。
- プレーンテキスト本文が空でもHTML本文がある場合は、HTMLタグを除去・テーブルをMarkdown化してプレーンテキストを自動補完（Obsidian同様）。
- 逆にHTML本文が空でもプレーンテキストがある場合は改行を `<br>` に変換してHTML表示用に補完。

### 3.5 検索テキスト抽出（`_extract_msg_text`）との完全連動
- `backend/app/extractors/text_extractor.py` においても、`openMsg` での `UnicodeDecodeError` 発生時に `overrideEncoding="cp932"` でリトライする処理を同期適用。
- AIインプットだけでなく、ローカル全文検索のインデックス作成時にも日本語メールが確実に抽出されます。
