# テキストファイルビューアー / コードエディタ仕様書 (Code & Text Editor)

## 概要
テキストファイルおよび各種ソースコード（`.py`, `.ts`, `.js`, `.json`, `.sh`, `.css`, `.html`, `.yaml`, `.toml`, `.sql` 等）の閲覧・編集を行う内蔵モーダル（`FileEditorModal`）です。
作業領域（コードエディタ領域）を画面いっぱいに広く使うため、**すべての操作系コントロール（タイトル、検索バー、言語バッジ、行数・保存状態、保存/キャンセルボタン）を最上部ヘッダーの横1行に完全集約**したスリム設計と、**VS Code Dark+ テーマに準拠した高度なシンタックスハイライト**を採用しています。

---

## 主な特徴とレイアウト

### 1. 最上部ヘッダー1行への全機能集約
複数段あったツールバーやフッター・ステータスバーを撤去し、最上部ヘッダー1行（`fe-modal-header-row`）にすべてを整理・配置しました。

- **タイトル**: `編集: {fileName}`（長いファイル名は省略表示）
- **コンパクト検索バー**:
  - `Search` アイコン + 入力欄（Cmd/Ctrl+F で即時フォーカス＆全選択）
  - クリアボタン `×`
  - リアルタイム位置・件数バッジ（`1 / 5` または `0件`）
  - 前へ `▲` / 次へ `▼` ボタン（Enter / Shift+Enter 連動）
  - 正規表現トグルボタン `.*`
- **言語バッジ**:
  - ファイル拡張子から自動判定した言語名（`Python`, `TypeScript`, `JSON` 等）を上品なバッジで表示
- **ステータス表示**:
  - 行数表示（`{lineCount}行`）
  - 保存状態バッジ（`未保存` / `保存済`）
- **アクションボタン**:
  - `キャンセル` ボタン
  - `保存` ボタン（Cmd/Ctrl+S でも保存可能）
- **閉じるボタン**:
  - 右端の `×` ボタン（Escape キーでも安全に操作可能）

### 2. VS Code Dark+ 準拠のシンタックスハイライト
自前の軽量高速ハイライター（`codeEditorHighlight.ts`）を大幅拡張し、VS Code Dark+ テーマと同一のカラーパレット・トークン分類を適用しています。

- **Python 対応の強化**:
  - **キーワード**: `def`, `class`, `import`, `return`, `if`, `for`, `async`, `await` 等（ピンク/紫 `#c586c0` / `#569cd6`）
  - **関数名**: `def function_name(...):` や呼び出し箇所の関数名（イエロー `#dcdcaa`）
  - **クラス名**: `class MyClass:` 等の型・クラス宣言（青緑/ミントグリーン `#4ec9b0`）
  - **組み込み関数・型**: `print`, `len`, `range`, `int`, `str`, `dict`, `list`, `True`, `False`, `None` 等（青緑・水色）
  - **特殊変数**: `self`, `cls`（水色 `#9cdcfe` / 変数識別）
  - **デコレータ**: `@property`, `@staticmethod` 等（イエロー）
  - **文字列・複数行docstring**: 単一行 `'...'`, `"..."`、f-string、および複数行にわたる `"""..."""`, `'''...'''` を途切れず正確に文字列ハイライト（オレンジ `#ce9178`）
  - **コメント**: `# コメント`（グリーン `#6a9955`）
  - **数値・演算子**: `123`, `0.5`, `+`, `-`, `*`, `/` 等

- **その他の言語**:
  - TypeScript / JavaScript, JSON, HTML, CSS, Shell スクリプト, YAML, TOML, SQL, Markdown 等もそれぞれの文法規則に従ってハイライト。

### 3. 本文検索とハイライトの完全連動
- `Cmd/Ctrl + F` で検索バーに即時フォーカスし、クエリを入力するとリアルタイムに本文中の一致箇所を `<mark class="md-search-highlight">` で強調表示。
- **構文ハイライトとの共存**: トークンの境界と検索マッチの境界を正確にスライスして重ね合わせるため、コードの色付けを壊さずに検索ヒットをハイライト。
- `Enter` で次のマッチへ、`Shift + Enter` で前のマッチへ循環移動。
- エディタ側の textarea のカーソル位置・スクロール（`scrollToMatch`）が検索結果と完全連動。

### 4. 作業領域（コードエディタ）の最大化
- **フッター・余白の完全排除**:
  - モーダル下部のフッターを撤廃し、画面下端までエディタが広がります。
  - モーダル内部の余白（パディング）を最小化し、エディタ枠の高さを最大化。
  - 行番号と連動したスムーズスクロール。

### 5. キーボードショートカット

| ショートカット | 機能 |
|---|---|
| **Cmd/Ctrl + F** | 本文検索バーに即座にフォーカスしテキスト全選択 |
| **Enter** / **▼** | 次の検索ヒットへ移動（末尾達時は先頭へラップ） |
| **Shift + Enter** / **▲** | 前の検索ヒットへ戻る（先頭時は末尾へラップ） |
| **Escape** | 検索欄ではクエリ消去・エディタ復帰 / エディタではモーダル閉じる |
| **Cmd/Ctrl + S** | ファイル保存 |
| **Tab** | 2スペースのインデント挿入 |
| **Shift + Tab** | 2スペースのアウトデント（インデント解除） |

---

## UI構成図（Excalidraw形式）

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "https://excalidraw.com",
  "elements": [
    {
      "type": "rectangle",
      "id": "fe-modal-window",
      "x": 40,
      "y": 40,
      "width": 800,
      "height": 480,
      "strokeColor": "#569cd6",
      "backgroundColor": "#1e1e1e",
      "fillStyle": "solid",
      "strokeWidth": 2
    },
    {
      "type": "rectangle",
      "id": "fe-single-header",
      "x": 40,
      "y": 40,
      "width": 800,
      "height": 46,
      "strokeColor": "#333333",
      "backgroundColor": "#252526",
      "fillStyle": "solid",
      "strokeWidth": 1
    },
    {
      "type": "text",
      "id": "fe-header-content",
      "x": 52,
      "y": 55,
      "text": "編集: app.py  [🔍 検索...  1/3 ▲ ▼ .*]  [Python]  85行 保存済  [キャンセル] [保存]  [×]",
      "fontSize": 12
    },
    {
      "type": "rectangle",
      "id": "fe-editor-area",
      "x": 40,
      "y": 86,
      "width": 800,
      "height": 434,
      "strokeColor": "#2d2d2d",
      "backgroundColor": "#1e1e1e",
      "fillStyle": "solid",
      "strokeWidth": 1
    },
    {
      "type": "text",
      "id": "fe-code-text",
      "x": 55,
      "y": 105,
      "text": " 1 |  \"\"\"\n 2 |  FastAPI メインエントリーポイント\n 3 |  \"\"\"\n 4 |  from fastapi import FastAPI, Depends\n 5 |  from pydantic import BaseModel\n 6 |  \n 7 |  app = FastAPI(title=\"File Manager API\")\n 8 |  \n 9 |  @app.get(\"/api/health\")\n10 |  async def health_check() -> dict[str, str]:\n11 |      return {\"status\": \"ok\"}\n12 |  \n13 |  class SafeMoveRequest(BaseModel):\n14 |      source: str\n15 |      destination: str",
      "fontSize": 13
    }
  ]
}
```
