# ペイン背景・テーブルヘッダーの右クリックメニュー仕様

## 概要
ファイルマネージャーの余白領域、およびファイル一覧のテーブルヘッダー（Name, Size, Date, Git）上で右クリックした際に表示されるメニュー（`PaneContextMenu`）の仕様書です。

ファイルやフォルダーが多数存在する場合でもメニューを呼び出しやすいよう、ヘッダー領域の右クリックでも同一のメニューが表示されます。

## 機能一覧

| メニュー項目 | 説明 | 動作 |
|---|---|---|
| **リスト取得(check_box)** | 表示中のファイル・フォルダ一覧をMarkdownチェックボックス形式でクリップボードにコピー | `- [ ] {名前}`（フォルダも末尾スラッシュなし） |
| **リスト取得(箇条書き)** | 表示中のファイル・フォルダ一覧をMarkdown箇条書き形式でクリップボードにコピー | `- {名前}`（フォルダも末尾スラッシュなし） |
| **隣のペインで開く** | 現在開いているフォルダを隣のペインで開く | 左ペイン操作時: 中央ペインで開く<br>中央ペイン操作時: 左ペインで開く<br>（操作元ペインのフォーカスは維持） |

※「隣のペインで開く」は左右ペイン（`FileList`）のみで表示され、検索ペイン（`FileSearch`）では非表示となります。

## UI構造とクリック判定ロジック

ファイル行（`tbody tr`）を右クリックした場合は各ファイル・フォルダ用の操作メニュー（名前変更、削除、開く等）が表示されます。
それ以外の余白領域やテーブルヘッダー（`thead` / `th` / `thead tr`）を右クリックした場合は `PaneContextMenu` が表示されます。

```
+-----------------------------------------------------------+
| ツールバー / パスバー                                     |
+-----------------------------------------------------------+
| [Name ^]    [Size]       [Date]         [Git]   <-- ★右クリックでメニュー表示
+-----------------------------------------------------------+
| [ ] folder1                                     <-- 通常のファイル操作メニュー
| [ ] folder2                                     <-- 通常のファイル操作メニュー
| [ ] memo.txt                                    <-- 通常のファイル操作メニュー
|                                                           |
| (余白領域)                                      <-- ★右クリックでメニュー表示
+-----------------------------------------------------------+
```

## Excalidraw 図解形式データ

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "https://excalidraw.com",
  "elements": [
    {
      "type": "rectangle",
      "id": "pane-left",
      "x": 100,
      "y": 100,
      "width": 260,
      "height": 260,
      "strokeColor": "#1e1e1e",
      "backgroundColor": "#f8f9fa",
      "fillStyle": "solid",
      "strokeWidth": 2,
      "roughness": 1
    },
    {
      "type": "text",
      "id": "text-left-title",
      "x": 120,
      "y": 110,
      "text": "左ペイン (FileList)",
      "fontSize": 16
    },
    {
      "type": "rectangle",
      "id": "header-left",
      "x": 110,
      "y": 140,
      "width": 240,
      "height": 30,
      "strokeColor": "#4a5568",
      "backgroundColor": "#e2e8f0",
      "fillStyle": "solid"
    },
    {
      "type": "text",
      "id": "text-header",
      "x": 120,
      "y": 146,
      "text": "Header: Name | Size | Date",
      "fontSize": 12
    },
    {
      "type": "rectangle",
      "id": "menu-box",
      "x": 200,
      "y": 180,
      "width": 180,
      "height": 110,
      "strokeColor": "#3182ce",
      "backgroundColor": "#ffffff",
      "fillStyle": "solid",
      "strokeWidth": 2
    },
    {
      "type": "text",
      "id": "text-menu",
      "x": 210,
      "y": 190,
      "text": "[✓] リスト取得(check_box)\n[•] リスト取得(箇条書き)\n---------------------\n[⇄] 隣のペインで開く",
      "fontSize": 12
    },
    {
      "type": "arrow",
      "id": "arrow-sync",
      "x": 380,
      "y": 255,
      "points": [[0, 0], [90, 0]],
      "strokeColor": "#3182ce",
      "strokeWidth": 2
    },
    {
      "type": "rectangle",
      "id": "pane-center",
      "x": 490,
      "y": 100,
      "width": 260,
      "height": 260,
      "strokeColor": "#1e1e1e",
      "backgroundColor": "#f8f9fa",
      "fillStyle": "solid",
      "strokeWidth": 2,
      "roughness": 1
    },
    {
      "type": "text",
      "id": "text-center-title",
      "x": 510,
      "y": 110,
      "text": "中央ペイン (FileList)",
      "fontSize": 16
    }
  ]
}
```
