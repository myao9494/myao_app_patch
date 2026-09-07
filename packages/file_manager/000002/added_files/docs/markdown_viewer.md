# Markdownビューワ / エディタ仕様書 (Markdown Viewer & Editor)

## 概要
Markdownファイル（`.md`）の閲覧・編集を行う内蔵モーダル（`MarkdownEditorModal`）です。
作業領域（エディタおよびプレビュー）を画面いっぱいに広く使うため、**すべての操作系コントロール（タイトル、検索バー、モード切替、ステータス、保存/キャンセルボタン）を最上部ヘッダーの横1行に完全集約**したウルトラスリム設計を採用しています。

---

## 主な特徴とレイアウト

### 1. 最上部ヘッダー1行への全機能集約
複数段あったバー（トップバー、ツールバー、検索バー、ステータスバー、フッター）を撤去し、最上部ヘッダー1行（`md-modal-header-row`）にすべてを整理・配置しました。

- **タイトル**: `Markdown編集: {fileName}`（長いファイル名は自動で省略表示）
- **コンパクト検索バー**:
  - `Search` アイコン + 入力欄（Cmd/Ctrl+F で即時フォーカス＆全選択）
  - クリアボタン `×`
  - リアルタイム位置・件数バッジ（`1 / 5`）
  - 前へ `▲` / 次へ `▼` ボタン（Enter / Shift+Enter 連動）
  - 正規表現トグルボタン `.*`
- **モード切替**:
  - アイコンを排したミニマルなテキストセグメントボタン（`Edit` / `Split` / `Preview`）
- **ステータス表示**:
  - 行数表示（`{lineCount}行`）
  - 保存状態バッジ（`未保存` / `保存済`）
- **アクションボタン**:
  - `キャンセル` ボタン
  - `保存` ボタン（Cmd/Ctrl+S でも保存可能）
- **閉じるボタン**:
  - 右端の `×` ボタン（Escape キーでも安全に操作可能）

### 2. 作業領域（テキストエリア & プレビュー）の最大化
- **フッター・余白の完全排除**:
  - モーダル下部のフッター領域を完全に無くし、ウィンドウの最下端までエディタとプレビューが広がります。
  - ペイン内の「Editor」「Preview」といった見出しヘッダーも撤去し、縦方向の高さ約 95% 以上がテキスト編集・閲覧に充てられます。
- **3つの表示モード**:
  - **Split**: 左半分エディタ、右半分プレビュー
  - **Edit**: 全幅エディタ
  - **Preview**: 全幅プレビュー

### 3. キーボードショートカット
装飾用アイコンボタンを無くしても、以下のショートカットキーによりキーボードのみで快適にすべての操作が可能です。

| ショートカット | 機能 |
|---|---|
| **Cmd/Ctrl + F** | 本文検索バーに即座にフォーカスしテキスト全選択 |
| **Enter** / **▼** | 次の検索ヒットへ移動（末尾達時は先頭へラップ） |
| **Shift + Enter** / **▲** | 前の検索ヒットへ戻る（先頭時は末尾へラップ） |
| **Escape** | 検索欄ではクエリ消去・エディタ復帰 / エディタではモーダル閉じる |
| **Cmd/Ctrl + S** | ファイル保存 |
| **Cmd/Ctrl + B** | 太字 (`**text**`) |
| **Cmd/Ctrl + I** | 斜体 (`*text*`) |
| **Cmd/Ctrl + L** | チェックリスト (`- [ ]`) |
| **Cmd/Ctrl + Shift + [** | 見出しレベルを上げる (`#` を減らす) |
| **Cmd/Ctrl + Shift + ]** | 見出しレベルを下げる (`#` を増やす) |
| **Cmd/Ctrl + :** | 箇条書き (`- text`) |
| **Tab** / **Shift + Tab** | インデント / アウトデント |
| **Enter** | リストアイテム継続入力 |

### 4. 画像プレビュー表示（相対パス・絶対パス・Obsidian構文対応）
Markdown内の画像指定を自動解決し、プレビュー画面内でインライン画像として美しく描画します。

- **標準Markdown画像構文**:
  - `![alt](image.png)`: 同一階層の画像を自動解決（`/api/view-image?path=...` を経由して安全に配信）。
  - `![alt](./sub/photo.jpg)`: サブフォルダ内の相対パス画像を自動解決。
  - `![alt](../images/banner.png)`: 親フォルダや別フォルダへの相対パスを解決。
  - `![alt](/absolute/path/to/img.png)`: ローカル絶対パスも解決。
  - `![alt](https://example.com/pic.png)`: 外部Web画像をそのまま表示。
  - `![alt](data:image/png;base64,...)`: Data URI画像を表示。
  - `![alt](image.png "タイトル")`: ツールチップタイトル対応。
- **Obsidianスタイルの埋め込み構文**:
  - `![[image.png]]`: 同階層または指定パスの画像をインライン展開。
  - `![[image.png|300]]`: 横幅300pxに自動リサイズ。
  - `![[image.png|300x200]]`: 横幅300px・高さ200pxにリサイズ。
  - `![[image.png|キャプション]]`: alt属性として適用。
- **UI表示スタイリング**:
  - `max-width: 100%`, `height: auto` による画面はみ出し防止。
  - 角丸（`border-radius: 6px`）、シャドウ、およびホバー時のネオングリーン光彩効果。

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
      "id": "md-modal-window",
      "x": 40,
      "y": 40,
      "width": 780,
      "height": 460,
      "strokeColor": "#66ff69",
      "backgroundColor": "#0d0d0d",
      "fillStyle": "solid",
      "strokeWidth": 2
    },
    {
      "type": "rectangle",
      "id": "md-single-header",
      "x": 40,
      "y": 40,
      "width": 780,
      "height": 46,
      "strokeColor": "#66ff69",
      "backgroundColor": "#141414",
      "fillStyle": "solid",
      "strokeWidth": 1
    },
    {
      "type": "text",
      "id": "md-header-content",
      "x": 52,
      "y": 55,
      "text": "Markdown編集: aaa.md  [🔍 検索...  1/5 ▲ ▼ .*]  [Edit|Split|Preview]  52行 保存済  [キャンセル] [保存]  [×]",
      "fontSize": 12
    },
    {
      "type": "rectangle",
      "id": "md-editor-area",
      "x": 52,
      "y": 94,
      "width": 372,
      "height": 394,
      "strokeColor": "#66ff69",
      "backgroundColor": "#111111",
      "fillStyle": "solid",
      "strokeWidth": 1
    },
    {
      "type": "text",
      "id": "md-editor-text",
      "x": 65,
      "y": 110,
      "text": "# 最大化されたテキストエリア\n\n![alt text](image.png)\n\n![[diagram.png|300]]\n\n画面の最上部から最下部まで\n目一杯テキスト編集が行えます。",
      "fontSize": 12
    },
    {
      "type": "rectangle",
      "id": "md-preview-area",
      "x": 436,
      "y": 94,
      "width": 372,
      "height": 394,
      "strokeColor": "#66ff69",
      "backgroundColor": "#111111",
      "fillStyle": "solid",
      "strokeWidth": 1
    },
    {
      "type": "text",
      "id": "md-preview-text",
      "x": 450,
      "y": 110,
      "text": "最大化されたプレビューエリア\n\n[🖼️ 相対パス画像: image.png 表示中]\n\n[🖼️ Obsidian画像: diagram.png (幅300px)]\n\nリアルタイムHTMLレンダリング＆画像インライン描画",
      "fontSize": 12
    }
  ]
}
```

