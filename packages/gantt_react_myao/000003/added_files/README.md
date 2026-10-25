# Gantt Chart Application

React + FastAPI + SQLite で構築した、個人用のガントチャートアプリケーション。

[myao9494/gantt_chart_myao](https://github.com/myao9494/gantt_chart_myao)（DHTMLX Gantt + Node.js）をベースに再実装したものです。

## 主な機能

- **ガントチャート**: タスクの階層表示、依存関係（リンク）、進捗、ドラッグでの日程変更・並び替え、Undo/Redo
- **右クリックメニューとキーボードショートカット**: 追加・複製・進捗・色・オーナー・固定などを素早く操作
- **スケジュール**: タスクのバー上に日付付きのメモ（📌）を置く
- **検索・フィルター**: タスク名/ID検索（同義語対応）、プロジェクト、完了、期間、種別、オーナー、固定
- **グリッド編集**: Excel風の表でまとめて編集し、差分を確認してから反映
- **Obsidian連携**: タスクからノートを作成してリンク、VaultへのCSV定期保存
- **CSVインポート/エクスポート**、過去のエクスポートとの差分比較
- **休日・出張日の表示**、ダークモード、印刷モード、PWA

詳しくは [docs/SPECIFICATION.md](docs/SPECIFICATION.md) を参照してください。

## 技術スタック

| 層 | 技術 |
| --- | --- |
| Frontend | React 19, TypeScript, Vite, DHTMLX Gantt, Univer |
| Backend | FastAPI, SQLAlchemy, SQLite |
| Package Manager | npm (Frontend), uv (Backend) |

## セットアップと起動

前提: Node.js 20以上、Python 3.12以上、[uv](https://docs.astral.sh/uv/)

### 普段使い（ビルドして1つのサーバーで動かす）

```bash
./start_app.sh
```

フロントエンドをビルドし、バックエンドが http://localhost:8000 で配信します。
Windows では `start_app.bat` を使います（コミット済みのビルド結果 `frontend/dist` を配信します）。

### 開発（ホットリロード）

```bash
./start_dev.sh
```

- フロントエンド: http://localhost:5172
- バックエンド: http://localhost:8000（APIドキュメント: http://localhost:8000/docs）

初回起動時に `backend/gantt.db` が自動で作成されます。

## ディレクトリ構成

```
gantt_react_myao/
├── frontend/          React アプリケーション（src/ がソース、dist/ がビルド結果）
├── backend/           FastAPI アプリケーション（routers/ がAPI、services/ が処理、tests/ がテスト）
├── docs/
│   └── SPECIFICATION.md   仕様書
└── CLAUDE.md          開発ガイド（テスト、データ保護、コードの場所）
```

## テスト

```bash
cd backend && uv run pytest
cd frontend && npx vitest run
```

バックエンドのテストは一時DBを使うので、実データ（`backend/gantt.db`）には触れません。
開発時のルールは [CLAUDE.md](CLAUDE.md) を参照してください。

## ライセンス

個人利用を目的としています。DHTMLX Gantt のライセンス規定に従ってください。
