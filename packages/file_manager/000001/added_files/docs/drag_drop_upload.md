# エクスプローラー / ファインダーからのフォルダードラッグ＆ドロップ仕様

## 概要
Windows ExplorerやmacOS FinderなどのOSネイティブのファイルマネージャーから、単一・複数ファイルだけでなく、**フォルダ（サブフォルダやファイルを含む階層構造、空フォルダ含む）**をブラウザのファイルマネージャー画面に直接ドラッグ＆ドロップしてアップロードできる機能の仕様です。

---

## 仕組みとアーキテクチャ

### 1. フロントエンド（再帰スキャンと送信）
- ブラウザ標準の File and Directory Entries API (`DataTransferItem.webkitGetAsEntry()`) を使用。
- ドロップされたエントリがファイル（`isFile`）の場合は通常ファイルとして登録。
- ディレクトリ（`isDirectory`）の場合は `createReader().readEntries()` をバッチ読み取り完了（空配列が返るまで）ループ処理し、階層構造を再帰的にトラバース。
- 中身のない空フォルダは `emptyDirectories` として記録。
- マルチパートフォームデータ (`FormData`) として以下の構造でバックエンドへ送信：
  - `files`: 各ファイルの Blob/File
  - `relative_paths`: 各ファイルに対応する相対パス（例: `my_folder/sub/sample.txt`）
  - `empty_directories`: 空フォルダの相対パス一覧（例: `my_folder/empty_sub`）

### 2. バックエンド（`/api/upload`）
- `relative_paths` および `empty_directories` を受信。
- **セキュリティ・パストラバーサル防止**:
  - `..` や絶対パス、ドライブレターなどの不正なパスを厳密にバリデーション・拒否。
  - 解決後の実パスが指定されたアップロード先ディレクトリ配下に存在すること（`is_relative_to`）を検証。
- **階層自動生成**:
  - 親ディレクトリが存在しない場合、`destination.parent.mkdir(parents=True, exist_ok=True)` で自動作成した上でファイルをストリーム保存。
  - 空フォルダも同様に `mkdir -p` で作成。

---

## データフロー図（Excalidraw形式）

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "https://excalidraw.com",
  "elements": [
    {
      "type": "rectangle",
      "id": "os-box",
      "x": 60,
      "y": 100,
      "width": 200,
      "height": 160,
      "strokeColor": "#2b6cb0",
      "backgroundColor": "#ebf8ff",
      "fillStyle": "solid",
      "strokeWidth": 2
    },
    {
      "type": "text",
      "id": "os-text",
      "x": 75,
      "y": 115,
      "text": "OS (Explorer / Finder)\n\n📁 MyProject/\n  📄 memo.txt\n  📁 subfolder/\n    📄 code.py\n  📁 empty_dir/",
      "fontSize": 12
    },
    {
      "type": "arrow",
      "id": "drag-arrow",
      "x": 260,
      "y": 180,
      "points": [[0, 0], [90, 0]],
      "strokeColor": "#3182ce",
      "strokeWidth": 2
    },
    {
      "type": "text",
      "id": "drag-label",
      "x": 270,
      "y": 155,
      "text": "Drag & Drop",
      "fontSize": 12
    },
    {
      "type": "rectangle",
      "id": "frontend-box",
      "x": 350,
      "y": 100,
      "width": 240,
      "height": 160,
      "strokeColor": "#38a169",
      "backgroundColor": "#f0fff4",
      "fillStyle": "solid",
      "strokeWidth": 2
    },
    {
      "type": "text",
      "id": "frontend-text",
      "x": 360,
      "y": 115,
      "text": "Frontend (FileList.tsx)\n\nwebkitGetAsEntry() で走査\n- files: [memo.txt, code.py]\n- relative_paths:\n  [MyProject/memo.txt,\n   MyProject/subfolder/code.py]\n- empty_directories:\n  [MyProject/empty_dir]",
      "fontSize": 11
    },
    {
      "type": "arrow",
      "id": "http-arrow",
      "x": 590,
      "y": 180,
      "points": [[0, 0], [90, 0]],
      "strokeColor": "#d69e2e",
      "strokeWidth": 2
    },
    {
      "type": "text",
      "id": "http-label",
      "x": 600,
      "y": 155,
      "text": "POST /api/upload",
      "fontSize": 12
    },
    {
      "type": "rectangle",
      "id": "backend-box",
      "x": 680,
      "y": 100,
      "width": 230,
      "height": 160,
      "strokeColor": "#d69e2e",
      "backgroundColor": "#fffaf0",
      "fillStyle": "solid",
      "strokeWidth": 2
    },
    {
      "type": "text",
      "id": "backend-text",
      "x": 690,
      "y": 115,
      "text": "Backend (FastAPI)\n\n- パストラバーサル防止検証\n- 親階層 mkdir -p 自動作成\n- ファイル保存\n- 空ディレクトリ作成\n- 成功レスポンス返却",
      "fontSize": 11
    }
  ]
}
```
