# ファイル一覧テーブル Name列の縦ズレ・下線浮き上がり防止の修正

## 1. 概要
ファイル一覧テーブルにおいて、更新日時（Date列）が `2026/08/29\n15:01` のように2行に折り返されて行の高さ（`tr`）が拡張された際、**Name列だけ行の下線（`border-bottom`）が上部に浮き上がり、行全体の垂直揃え（アライメント）が崩れる**という不具合を解消しました。

## 2. 原因のメカニズム

### 発生していた現象
- 通常時（1行の高さが約35px）は目立たないが、日付列の改行などで行の高さが約80pxに拡張されると、
- チェックボックス列、Size列、Date列の下線（`border-bottom`）は正しく行の最下端（例: y=144px）に配置される。
- 一方で、**Name列（ファイル名・アイコン・コピーボタン列）の下線だけがコンテンツの高さ（例: y=130px）で途切れて上に浮き上がり、垂直方向の位置も不整合を起こしていた**。

### 原因の特定
`FileSearch.css` において、グローバルスコープで以下のように宣言されていました：
```css
/* 修正前: FileSearch.css */
.name-cell {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: 6px;
}
```
ViteによるCSSバンドル時、この `.name-cell` が `FileList.tsx` の `<td className="name-cell">` にも適用されていました。

HTML/CSSの仕様上、`<td>` 要素の本来の表示形式は `display: table-cell` です。
これを `display: flex` に上書きしてしまうと、そのセルは**ブラウザのテーブルレイアウトアルゴリズムから外れます**。
- `display: flex` になった `td` はテーブル行（`tr`）の高さ伸長やテーブルセルの垂直揃え（`vertical-align: middle`）が無効化される。
- `td` の下線（`border-bottom`）が行全体の最下端ではなく、`display: flex` のボックス自身の下端に描画される。
- これにより、Name列だけ下線が上にずれ、縦位置も他の列と不揃いになる現象が発生していました。

```excalidraw
{
  "type": "excalidraw",
  "version": 2,
  "source": "https://excalidraw.com",
  "elements": [
    {
      "type": "rectangle",
      "id": "box-tr-bad",
      "x": 40,
      "y": 40,
      "width": 640,
      "height": 90,
      "strokeColor": "#e03131",
      "backgroundColor": "transparent",
      "fillStyle": "hachure",
      "strokeWidth": 2,
      "strokeStyle": "dashed",
      "roughness": 1
    },
    {
      "type": "text",
      "id": "text-tr-bad-label",
      "x": 50,
      "y": 15,
      "text": "【修正前】行 (tr) 全体: 高さ 90px",
      "fontSize": 14,
      "strokeColor": "#e03131"
    },
    {
      "type": "rectangle",
      "id": "cell-chk-bad",
      "x": 40,
      "y": 40,
      "width": 60,
      "height": 90,
      "strokeColor": "#868e96",
      "backgroundColor": "#f8f9fa",
      "fillStyle": "solid"
    },
    {
      "type": "text",
      "id": "txt-chk-bad",
      "x": 55,
      "y": 75,
      "text": "[✓]",
      "fontSize": 14,
      "strokeColor": "#495057"
    },
    {
      "type": "rectangle",
      "id": "cell-name-bad",
      "x": 100,
      "y": 40,
      "width": 300,
      "height": 60,
      "strokeColor": "#e03131",
      "backgroundColor": "#ffe3e3",
      "fillStyle": "solid",
      "strokeWidth": 2
    },
    {
      "type": "text",
      "id": "txt-name-bad",
      "x": 110,
      "y": 60,
      "text": "Name列 (display: flex により\n高さ60pxで下線が浮き上がる！)",
      "fontSize": 13,
      "strokeColor": "#c92a2a"
    },
    {
      "type": "rectangle",
      "id": "cell-size-bad",
      "x": 400,
      "y": 40,
      "width": 100,
      "height": 90,
      "strokeColor": "#868e96",
      "backgroundColor": "#f8f9fa",
      "fillStyle": "solid"
    },
    {
      "type": "text",
      "id": "txt-size-bad",
      "x": 420,
      "y": 75,
      "text": "6.0 KB",
      "fontSize": 14,
      "strokeColor": "#495057"
    },
    {
      "type": "rectangle",
      "id": "cell-date-bad",
      "x": 500,
      "y": 40,
      "width": 180,
      "height": 90,
      "strokeColor": "#868e96",
      "backgroundColor": "#f8f9fa",
      "fillStyle": "solid"
    },
    {
      "type": "text",
      "id": "txt-date-bad",
      "x": 520,
      "y": 65,
      "text": "2026/08/29\n15:01 (2行)",
      "fontSize": 14,
      "strokeColor": "#495057"
    },
    {
      "type": "line",
      "id": "arrow-down",
      "x": 360,
      "y": 150,
      "width": 0,
      "height": 40,
      "strokeColor": "#228be6",
      "strokeWidth": 3
    },
    {
      "type": "rectangle",
      "id": "box-tr-good",
      "x": 40,
      "y": 210,
      "width": 640,
      "height": 90,
      "strokeColor": "#2f9e44",
      "backgroundColor": "transparent",
      "fillStyle": "hachure",
      "strokeWidth": 2,
      "strokeStyle": "solid",
      "roughness": 1
    },
    {
      "type": "text",
      "id": "text-tr-good-label",
      "x": 50,
      "y": 185,
      "text": "【修正後】全セルが table-cell として行高90px・下線・中央揃えに完全一致",
      "fontSize": 14,
      "strokeColor": "#2f9e44"
    },
    {
      "type": "rectangle",
      "id": "cell-chk-good",
      "x": 40,
      "y": 210,
      "width": 60,
      "height": 90,
      "strokeColor": "#868e96",
      "backgroundColor": "#f8f9fa",
      "fillStyle": "solid"
    },
    {
      "type": "text",
      "id": "txt-chk-good",
      "x": 55,
      "y": 245,
      "text": "[✓]",
      "fontSize": 14,
      "strokeColor": "#495057"
    },
    {
      "type": "rectangle",
      "id": "cell-name-good",
      "x": 100,
      "y": 210,
      "width": 300,
      "height": 90,
      "strokeColor": "#2f9e44",
      "backgroundColor": "#ebfbee",
      "fillStyle": "solid",
      "strokeWidth": 2
    },
    {
      "type": "text",
      "id": "txt-name-good",
      "x": 110,
      "y": 245,
      "text": "Name列: td は table-cell (高さ90px)\n内部 .name-cell-content で中央揃え",
      "fontSize": 13,
      "strokeColor": "#2b8a3e"
    },
    {
      "type": "rectangle",
      "id": "cell-size-good",
      "x": 400,
      "y": 210,
      "width": 100,
      "height": 90,
      "strokeColor": "#868e96",
      "backgroundColor": "#f8f9fa",
      "fillStyle": "solid"
    },
    {
      "type": "text",
      "id": "txt-size-good",
      "x": 420,
      "y": 245,
      "text": "6.0 KB",
      "fontSize": 14,
      "strokeColor": "#495057"
    },
    {
      "type": "rectangle",
      "id": "cell-date-good",
      "x": 500,
      "y": 210,
      "width": 180,
      "height": 90,
      "strokeColor": "#868e96",
      "backgroundColor": "#f8f9fa",
      "fillStyle": "solid"
    },
    {
      "type": "text",
      "id": "txt-date-good",
      "x": 520,
      "y": 235,
      "text": "2026/08/29\n15:01 (2行)",
      "fontSize": 14,
      "strokeColor": "#495057"
    }
  ]
}
```

## 3. 実施した修正

1. **`FileSearch.css` のセレクタを `.results-table` 配下に限定**:
   `.name-cell`, `.name-info` などのスタイルを `.results-table .name-cell` に変更し、他のコンポーネント（特に `FileList`）にスタイルが漏洩しないようにしました。

2. **`FileList.css` でテーブルセルとしての配置を保護**:
   ```css
   .file-table td.name-cell {
     display: table-cell !important;
     vertical-align: middle !important;
   }
   ```
   を定義し、将来的な他のCSSからの干渉を防ぎます。
   また、チェックボックス列についても固定の `margin-top` を撤廃し、`vertical-align: middle; text-align: center;` で行高変化時も常に上下左右の中央に安定配置されるように統一しました。

3. **`FileList.tsx` のチェックボックス列マークアップ改善**:
   フォルダ行およびファイル行のチェックボックスセルに明示的に `className="checkbox-col"` を付与しました。

## 4. 検証結果
- `frontend/src/components/TableLayout.test.ts` を追加し、CSSセレクタのスコープ化とテーブルセル配置の整合性を自動テスト。
- 単体テスト全210件、バックエンドテスト全138件がすべて合格。
- 本番ビルド（`npm run build`）も警告なく成功することを確認。
