# バックエンド API 仕様

FastAPI（`backend/main.py`）が提供する API。本番は port 3001 で dist/ と同じオリジン、
開発時は port 8008 で起動し、Vite（port 3001）が `/api` と `/save-library` を proxy する。

パスはすべて **サーバーが動いている PC のローカルパス**。クエリパラメーターの `filepath` は
URL エンコードして渡す（サーバー側で二重にデコードしない）。

## 図面ファイル

### `GET /api/load-file?filepath=...`

図面を読み込む。

| 対象 | 動作 |
| --- | --- |
| `.excalidraw` | JSON として読み込む |
| `.excalidraw.md` / Front Matter に `excalidraw-plugin: parsed` を持つ `.md` | Obsidian 形式として `## Drawing` の JSON（LZString 圧縮）を取り出す。Embedded Files の画像を `files` に補完する |
| `.excalidraw` で、同名の `.excalidraw.md` がある | 移行済みとみなし `.excalidraw.md` を読む（`resolvedPath` で通知） |
| 空ファイル（空白のみを含む） | 要素なしの空の図面を返す |

レスポンス（200）:

```json
{
  "data": { "type": "excalidraw", "version": 2, "elements": [], "appState": {}, "files": {} },
  "modified": 1791597203.70,
  "resolvedPath": "/path/to/file.excalidraw",
  "shouldMigrateToMarkdown": false,
  "embeddedFilePaths": { "fileId": "/path/to/image.png" },
  "embeddedMarkdownCandidates": ["/path/to/note.md"]
}
```

- `modified`: ファイルの更新日時（UNIX 秒）。フロントエンドの外部更新検知の基準になる
- `shouldMigrateToMarkdown`: Obsidian Vault 内（祖先に `.obsidian/` がある）またはパスに `obsidian` を含む `.excalidraw` のとき `true`。フロントエンドが `.excalidraw.md` に変換する
- `embeddedFilePaths` / `embeddedMarkdownCandidates`: Obsidian 形式のときだけ。埋め込みノートの表示に使う（[obsidian.md](obsidian.md)）

エラー:

| ステータス | 内容 |
| --- | --- |
| 404 | ファイルが存在しない |
| 400 | JSON が不正。`detail` に `error_type`（`json_syntax` / `validation` / `schema`）、`message`、行・列・前後の行（`context`）、検証エラーの詳細（最大5件）を含む |
| 500 | その他のエラー |

検証内容: JSON 構文、ルートがオブジェクトで `elements` を持つこと、`line` / `draw` / `freedraw` 要素の `points` が `[x, y]` の配列であること。

### `GET /api/file-info?filepath=...`

```json
{ "modified": 1791597203.70, "exists": true, "isExcalidraw": false }
```

外部更新の検知（編集中は最短5秒ごと、保存前は毎回）に使うため、ファイルの中身は読まない軽量な処理。
`isExcalidraw` は Excalidraw Markdown（`.excalidraw.md` または parsed な `.md`）なら `true`。
ファイルがない・エラー時は `{ "modified": 0, "exists": false }`。

### `POST /api/save-file`

```json
{ "filepath": "/path/to/file.excalidraw", "data": { ...Excalidraw JSON... }, "force_backup": false }
```

- 内容を一時ファイルに書いてから置き換える（保存途中の中断・容量不足でも既存ファイルを壊さない）。
  既存ファイルの権限と拡張属性（Finder タグなど）は引き継ぐ
- ファイルがロックされている場合は 0.2 秒間隔で最大10回リトライする
- `data` の未知のトップレベル項目もそのまま保存する

| 保存先 | 形式 | バックアップ |
| --- | --- | --- |
| `.md`（`.excalidraw.md`、または既存の parsed ノート） | Obsidian 形式。本文・Front Matter は維持し、Drawing・Text Elements・Embedded Files だけを更新。画像は外部ファイルに書き出す | 作らない |
| それ以外（Vault 内の `.excalidraw` を含む） | 整形した JSON | 作る（下記） |

バックアップ（`backup/<名前>_backup_YYYYMMDD_HHMMSS[_連番]<拡張子>`、図面と同じフォルダ）:

- `force_backup: false`（自動保存）: 直近10分以内にバックアップがあれば作らない
- `force_backup: true`（手動保存・外部更新の取り込み時）: 必ず作る
- 2週間より古いものは削除し、今日以外の日はその日の最新1件だけを残す
- バックアップに失敗しても保存は続ける

レスポンス: `{ "success": true, "message": "...", "modified": 1791597300.12 }`

### `POST /api/archive-file`

`{ "filepath": "..." }` のファイルを `backup/<名前>_YYYYMMDD_HHMMSS<拡張子>` に移動する。
`.excalidraw` → `.excalidraw.md` 変換後の元ファイルの退避に使う。
レスポンス: `{ "success": true, "archivedPath": "...", "message": "..." }`（失敗時は `success: false, error`）

### `POST /api/save-svg`

`{ "filepath": "...", "svg_content": "<svg ...>" }` を保存する。

### `POST /save-library`

`{ "file_path": "public/excalidraw_lib/my_lib.excalidrawlib", "data": {...} }`。
共有ライブラリファイル以外のパスは 403。

### `POST /api/list-directory`

`{ "path": "/dir", "show_hidden": false }` のサブフォルダと図面ファイル（`.excalidraw`、`.excalidraw.md`、parsed な `.md`）を、
フォルダ優先・名前順で返す。現在のフロントエンドからは使っていない。

## ドラッグ&ドロップ

保存先は図面と同じフォルダの `uploads/<種類>/`（localStorage モードではプロジェクト直下の `upload_local/<種類>/`）。
ファイル名は `<元の名前>_<UNIX時刻><拡張子>`。同じ名前が既にあれば `_1`, `_2` … を付ける。
返すパスは図面ファイルのフォルダからの相対パス（`/` 区切り。別ドライブなど相対にできない場合は絶対パス）。

| API | 入力 | 保存先 |
| --- | --- | --- |
| `POST /api/upload-files` | multipart: `files`, `current_path`, `file_type`（`general` / `email`） | `uploads/files/` / `uploads/emails/` |
| `POST /api/create-folder-shortcut` | form: `folder_path`, `current_path` | `uploads/folders/<フォルダ名>_<時刻>.txt`（パスを書いたテキスト） |
| `POST /api/save-email` | JSON: `emailData`, `subject`, `currentPath` | `uploads/emails/<件名>_<時刻>.eml` |
| `GET /api/file/{uploads or upload_local}/...` | — | プロジェクト直下の `uploads/`・`upload_local/` のファイルを配信（それ以外は 403） |

## OS 連携

| API | 動作 |
| --- | --- |
| `POST /api/open-file` `{ "filepath" }` | ファイル・フォルダを OS の既定アプリで開く（前後のクォート除去、`~`・環境変数を展開）。なければ 404 |
| `GET /api/open-file?filepath=` | 同上。開いた後に自動で閉じる HTML を返す（ブラウザのタブから開く用） |
| `GET /api/open-url?url=` | URL を OS の既定ハンドラーで開く。許可スキーム: `http` `https` `mailto` `obsidian`（それ以外は 400） |
| `POST /api/open-folder` `{ "path" }` | フォルダをファイルマネージャーで開く（ファイルならその親） |
| `POST /api/open-in-editor` `{ "path" }` | フォルダを VS Code（`code` コマンド、macOS は標準のアプリ配置も探す）で開く。なければファイルマネージャーで開き `fallbackUsed: true` |
| `POST /api/run-command` `{ "command", "working_directory" }` | シェルでコマンドを起動する（終了を待たない）。先頭の `cmd ` を除去し、HTML エンティティ・全角ダブルクォートを戻し、Windows では円記号を `\` にする。作業フォルダがなければ 400。Windows は新しいコンソール、macOS/Linux は `$SHELL`（既定 zsh / bash） |

> ⚠️ これらの API には認証がない。サーバーは `0.0.0.0` で待ち受けるため、同じ LAN・Tailscale から
> ファイルの読み書きやコマンド実行ができる。信頼できるネットワークでのみ使うこと
> （[external_dependencies.md](external_dependencies.md)）。

## フロントエンド配信（PWA）

- API 以外のパスは `dist/` の静的ファイルを返す（`/` は `dist/index.html`）
- キャッシュヘッダー: `index.html`・`sw.js`・`manifest.json` は `no-cache`、
  ハッシュ付きアセット（`*-xxxxxx.js/css/mjs`）は1年 `immutable`、その他は1時間
- `sw.js` には `Service-Worker-Allowed: /` を付ける
- CORS: localhost / 127.0.0.1 と、プライベート IP（10.x / 172.16–31.x / 192.168.x）・Tailscale（100.x）の任意ポートを許可
