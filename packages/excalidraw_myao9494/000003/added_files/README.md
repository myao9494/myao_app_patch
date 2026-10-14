# excalidraw_myao9494

ローカルのファイルを直接読み書きできる Excalidraw（PWA）。
独自のキーボードショートカット・付箋・ドラッグ&ドロップ・Obsidian の `.excalidraw.md` 互換を備える。

- 図面は URL の `?filepath=` で指定したファイルに **10 秒ごとに自動保存**（`.excalidraw` は `backup/` に世代バックアップ）
- Obsidian の Excalidraw ノート（`.excalidraw.md`）をそのまま編集でき、Obsidian 側の更新も自動で取り込む
- 付箋のリンクから、ファイル・フォルダ・コマンド・Obsidian・URL を開ける
- 1 台の FastAPI がアプリと API を配信する。LAN・Tailscale の別端末からも使える

## ドキュメント

| 文書 | 内容 |
| --- | --- |
| [docs/features.md](docs/features.md) | 機能仕様（保存・外部更新・ショートカット・リンク・ドロップ・ヘッダー） |
| [docs/shortcuts.md](docs/shortcuts.md) | ショートカット一覧（`.` キーのヘルプ） |
| [docs/marker_feature.md](docs/marker_feature.md) / [docs/underline_feature.md](docs/underline_feature.md) / [docs/annotation_settings.md](docs/annotation_settings.md) | マーカー（M）・アンダーライン（U）・設定（,） |
| [docs/obsidian.md](docs/obsidian.md) | Obsidian 互換（形式・画像・ノート埋め込み・変換） |
| [docs/api.md](docs/api.md) | バックエンド API |
| [docs/architecture.md](docs/architecture.md) | 構成・モジュール・保存の流れ |
| [docs/external_dependencies.md](docs/external_dependencies.md) | 外部アプリ・サービス（port 8001 など）とセキュリティ |
| [docs/debug_guide.md](docs/debug_guide.md) | トラブルシューティング・テスト |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | 変更履歴 |
| [AGENTS.md](AGENTS.md) | 仕様の要約と開発ルール（AI エージェント向け） |

## セットアップ

必要なもの: Python 3.10 以上、（ビルドする場合）Node.js 18 以上。

```bash
# バックエンド
python -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt

# フロントエンド（ビルドする PC だけ）
npm ci
```

`dist/`（ビルド済みフロントエンド）は git 管理しているので、**ビルドできない PC では npm は不要**。

## 起動

### 普段使い（本番）

```bash
./start_servers.sh       # macOS / Linux
start_servers.bat        # Windows
```

- `http://localhost:3001` を開く（ブラウザの「アプリをインストール」で PWA にできる）
- npm と `node_modules` がある PC では毎回ビルドしてから起動する。ない PC では git 管理の `dist/` をそのまま使う
- port 3001 で動いている古いサーバーは止めてから起動し、HTTP 応答を確認してから「起動完了」と表示する
- Python は `backend/.venv` → `backend/venv` →（Windows は `.venv` / `venv` も）→ システムの `python` の順に探す

### 開発

```bash
./start_dev.sh
```

Vite（port 3001, HMR）と FastAPI（port 8008, 自動リロード）を起動し、`/api` は Vite から FastAPI へ proxy する。
個別に起動する場合は `npm start` と `backend/start_server.sh`。

### 別の端末から使う（LAN・Tailscale）

サーバーは `0.0.0.0:3001` で待ち受ける。`http://<サーバーの IP>:3001/?filepath=...` で開ける。
ファイルの読み書きや「OS で開く」は **サーバーの PC で** 行われる。
API に認証はないので、信頼できるネットワークだけで使うこと。

## 使い方

1. `http://localhost:3001/?filepath=/path/to/drawing.excalidraw` を開く（`filepath` を省くとブラウザ内に保存）
2. 描くと 10 秒後に自動保存される。`Cmd/Ctrl + S` で即時保存（バックアップ付き）
3. `.` キーでショートカット一覧、`,` キーでマーカー・下線の設定

主なショートカット: `N` 付箋 / `W` クリップボードのパスからリンク付箋 / `M` マーカー / `U` 下線 /
`C` 矢印なしの線 / `Option/Alt + C` チェックモード（`M`・`U` の連続描画と `C` のチェックマーク） / `Tab` 図形の形を変える / `Cmd/Ctrl + M`・`B` 最前面・最背面。
ファイルやフォルダをドロップすると、図面のフォルダの `uploads/` に保存してリンク付き付箋を作る（Web ページのリンクは保存せず、URL をそのままリンクにした付箋）。
詳しくは [docs/features.md](docs/features.md)。

## テスト

```bash
npm test                  # フロントエンド（vitest）
npm run typecheck         # 型チェック（tsc --noEmit）

backend/.venv/bin/pip install -r backend/requirements-dev.txt
backend/.venv/bin/python -m pytest tests   # バックエンド（pytest）
```

## フォルダ構成

```
components/   画面（App.tsx・ヘッダー・モーダル・右クリックメニュー）
hooks/        読み込み・保存同期、ショートカット、ドラッグ&ドロップ など
utils/        API 呼び出し、パス、リンク、SVG、Obsidian 埋め込み など
backend/      FastAPI（main.py と機能別モジュール）
public/       静的ファイル（フォント、共有ライブラリ、manifest.json、sw.js）
dist/         ビルド済みフロントエンド（git 管理。ビルドできない PC 用）
tests/        バックエンドのテストと Obsidian のサンプル Vault
docs/         ドキュメント
shoki.excalidraw  新規作成時のテンプレート
```
