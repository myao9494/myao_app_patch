# gantt_react_myao 開発ガイド

React + DHTMLX Gantt + Univer（フロントエンド）と FastAPI + SQLite（バックエンド）で作った、個人用のガントチャートアプリ。

- **仕様**（画面の動き・API・データ形式）: [docs/SPECIFICATION.md](docs/SPECIFICATION.md)
- **このファイル**: 開発するときのルールと、コードの場所

機能を追加・変更したら、同じ変更の中で `docs/SPECIFICATION.md` も直すこと（コードが正）。

## 起動

| スクリプト | 内容 |
| --- | --- |
| `./start_app.sh` | フロントエンドをビルドし、バックエンド（ポート8000）がそれを配信する。普段使い用 |
| `./start_dev.sh` | 開発用。Vite（ポート5172）とバックエンド（ポート8000）を同時に起動する |
| `start_app.bat` / `start_dev.bat` | Windows用。`start_app.bat` はビルドをせず、コミット済みの `frontend/dist` を配信する |

- Windows では pull するだけで動かせるよう、`frontend/dist` をコミットしている。フロントエンドを変更したら `npm run build` して `dist` も一緒にコミットすること。
- バックエンドは `--reload` 付きで起動するので、稼働中に `backend/` のファイルを書き換えると再読み込みされる。稼働中のアプリに影響させたくない作業は、git worktree など別の作業コピーで行う。

## テストとチェック

```bash
# バックエンド（backend ディレクトリで）
uv run pytest
uv run pytest --cov=. --cov-report=term-missing   # カバレッジ

# フロントエンド（frontend ディレクトリで）
npx vitest run     # テスト
npx tsc -b         # 型チェック
npx eslint .       # lint
npm run coverage   # カバレッジ
npm run build      # 本番ビルド（型チェック込み）
```

- バックエンドのテストは、`tests/conftest.py` が接続先を一時DBへ差し替えるので、本番DB（`backend/gantt.db`）には触れない。新しいテストでも `conftest.py` の `client` / `db` フィクスチャを使い、DBファイルやデータファイルのパスを直接書かないこと。
- フロントエンドのガント関連テストは、モックではなく実物の DHTMLX Gantt を jsdom 上で動かしている（`components/GanttChart/__tests__/ganttTestHarness.ts`）。
- フロントエンドのフック・コンポーネントのテストは、APIモジュール（`services/api`）を `vi.mock` で差し替えて書く。タイマーを使うものは `vi.useFakeTimers()` を使う。
- 画面の動作確認を稼働中のアプリと分けたいときは、環境変数で別のDB・別のポートを使う:
  - バックエンド: `GANTT_DATABASE_URL=sqlite:////tmp/verify.db uv run python -m uvicorn main:app --port 8010`
  - フロントエンド: `GANTT_DEV_PORT=5180 GANTT_API_TARGET=http://localhost:8010 npm run dev`

## 本番データの保護（最重要）

`backend/gantt.db` は実際に使っているデータ。次のスクリプトは**本番DBを直接書き換える**ので、実行前に必ず `backend/gantt.db` を別名でコピーして退避し、終わったら書き戻すこと。

| スクリプト | 動作 |
| --- | --- |
| `backend/generate_load_test_data.py` | 負荷テスト用に、プロジェクト10件を含む3000件のタスクを**追加**する（既存データは消さない） |
| `backend/sample_data.py` | 既存のタスク・リンクを**全削除**してサンプルデータを入れる |
| `backend/restore_from_csv.py [obsidian_home]` | Obsidian Vault の `70_gantt_csv/` にあるCSVで、タスク・リンクを**丸ごと置き換える**（退避ファイルから戻せないときの最終手段） |

別のDBで試す場合は、`GANTT_DATABASE_URL` を指定して実行する。

## コードの場所

```
backend/
├── main.py              アプリの組み立て（ルーター登録、フロントエンドの静的配信）
├── config.py            パスと環境変数
├── database.py          SQLite接続。DBは backend/gantt.db（GANTT_DATABASE_URL で変更可）
├── models.py            テーブル定義（tasks, links, grid_tasks, grid_links）
├── schemas.py           APIの入出力の型
├── routers/             APIのエンドポイント
│   ├── tasks.py           タスクのCRUD・複製・並び替え・Obsidianノート
│   ├── open_input.py      外部からの入力画面オープン要求
│   ├── links.py           リンク
│   ├── grid.py            グリッド編集のステージング
│   ├── calendar.py        休日・出張
│   ├── csv_io.py          CSVエクスポート/インポート、VaultへのCSV保存
│   └── synonyms.py        同義語（外部APIの中継）
├── services/            ルーターから使う処理
│   ├── update_sequence.py  自動更新用の更新シーケンス
│   ├── task_text.py        タスク名の整形、期間計算
│   ├── csv_io.py           CSVの生成・パース・テーブル置き換え
│   ├── obsidian_export.py  VaultへのCSV保存と差分サマリ
│   ├── calendar_files.py   休日・出張ファイルの読み書き
│   └── browser_window.py   ブラウザを前面に出す処理
├── data/                休日・出張のテキストファイル
└── tests/

frontend/src/
├── App.tsx              画面の組み立てとルーティング
├── hooks/               データ取得・保存
│   ├── useGanttData.ts       タスク・リンクの取得、自動更新、保存
│   ├── useGridStaging.ts     グリッドの差分管理
│   ├── useOpenInputRequests.ts  外部からの入力画面オープン要求
│   └── useAppSettings.ts     休日・出張・同義語・VaultへのCSV保存
├── components/
│   ├── GanttChart/          ガントチャート（下記）
│   ├── UniverSheet/         グリッド（UniverSheet.tsx が Univer の初期化、gridCells.ts がセル値の生成と編集値の変換、列定義、タスク名の装飾）
│   ├── GridDiffPanel/       グリッドの差分パネル
│   ├── DiffViewer/          過去のエクスポートとの差分比較
│   ├── Header/              ツールバー（Header.tsx、DayRangeInput、OptionButtonGroup、矢印キー移動の toolbarNavigation）、ハンバーガーメニュー、休日・出張の追加モーダル、差分サマリ
│   └── ApiGuide/            APIガイド画面
├── services/api.ts      バックエンドAPIの呼び出し
├── utils/               フィルター、スケジュール、差分（diffUtils、diffActions）、日数入力（numberInput）、アイコンなどの純粋な処理
├── constants/gantt.ts   オーナー・種別・色・ズームの定義
└── types/               型定義
```

`components/GanttChart/` の役割分担:

| ファイル | 役割 |
| --- | --- |
| `GanttChart.tsx` | gantt の初期化と破棄、props の反映、モーダルやメニューの表示 |
| `ganttSetup.ts` | プラグイン・Lightbox・列・ズームなどの設定 |
| `ganttTemplates.ts` | バーやセルの表示テンプレート |
| `ganttEvents.ts` | Gantt上の操作をバックエンドへ保存するイベントハンドラ |
| `ganttSync.ts` | サーバーのデータを gantt へ差分反映 |
| `useGanttKeyboard.ts` | キーボードショートカット |
| `useGanttDisplaySettings.ts` | タイムスケール・休日/出張・左グリッド・印刷モード・表示倍率・全展開/全折りたたみを gantt へ反映 |
| `useGanttFilter.ts` | フィルター結果（表示対象のタスクID）の計算と、変わったときだけの再描画 |
| `useTaskHyperlinks.ts` | Obsidianノートの作成と、ハイパーリンクを開く処理 |
| `useSchedulePins.ts` | スケジュールのピンの右クリック・ドラッグ |
| `useTimelineScroll.ts` / `timelinePointer.ts` | ドラッグ/ホイールでのスクロール、マウス位置の追跡 |
| `contextMenuItems.ts` / `ContextMenu.tsx` | 右クリックメニュー |

## 実装上の注意

- **gantt はシングルトン**。`gantt.attachEvent` で登録したハンドラは、アンマウント時に必ず `detachEvent` する。解除しないと、ガント⇔グリッドを行き来するたびにハンドラが増え、保存APIが多重に呼ばれる。
- **gantt の初期化は1度だけ**。初期化の `useEffect` が再実行されると全体が作り直される。イベントハンドラから最新の props やコールバックを使いたいときは、依存配列に入れずに `useLatestRef` 経由で参照する。`useLocalStorage` の `setValue` は参照が変わらないよう関数型更新で実装してある。
- **gantt に設定を反映するフック**（`useGanttDisplaySettings` / `useGanttFilter`）は、`GanttChart` の初期化の `useEffect` より**後**に呼ぶ。先に呼ぶと、初回に gantt が未初期化のまま反映が空振りする。
- **更新シーケンスの扱い**: バックエンドは全API応答に `X-Update-Sequence` ヘッダーを付ける。`useGanttData` は、自分の変更でちょうど1つ進んだときだけ再取得を省く。変更系APIが1回の操作で更新シーケンスを2つ以上進める作りにすると、この省略が効かなくなる（再取得が増えるだけで、データは壊れない）。
- **gantt への反映は `ganttSync.ts` に任せる**。サーバーのデータを反映するときに `gantt.silent()` でタスクを追加すると、DHTMLX 内部の並び順が更新されず行が表示されなくなる。追加・更新・削除の使い分けと、Undo履歴・保存APIへの影響を防ぐ処理はこのファイルにまとめてある。
- **テンプレートはHTML文字列を返す**。タスク名などを埋め込むときは必ず `escapeHtml` を通す。
- **タスク名の整形**（先頭のインデント・アイコンの除去）は、フロントエンドは `utils/taskText.ts`、バックエンドは `services/task_text.py` に1か所ずつ。対象の文字を変えるときは両方を合わせる。
- **日付文字列**（`YYYY-MM-DD HH:mm:ss`）を `Date` にするときは、空白を `T` に置き換える（Safari対策）。`toGanttTask` / `parseTaskDate` を使う。
- **CSVをファイルに書くとき**は `newline=""` を指定する（Windowsで改行が二重に変換されるのを防ぐ）。
- Python のパッケージ管理は `uv`、フロントエンドは `npm`。`backend/.venv/bin/` の実行ファイルは、プロジェクトを移動した場合に古いパスを指すことがある。その場合は `uv run python -m uvicorn ...` で起動するか、`.venv` を作り直す。
