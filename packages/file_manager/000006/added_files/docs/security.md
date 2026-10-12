# セキュリティ設計

本アプリはファイル操作・プログラム実行・ターミナル（シェル）を提供するため、
**利用者がブラウザで開いた別のWebサイトから本アプリを操作されないこと**を重視しています。
認証機能はないため、信頼できるネットワーク（自宅・Tailscale・VPN）での利用を前提とします。

実装: `backend/app/security.py`、テスト: `backend/tests/test_security.py`

## 1. Origin 検証（CSRF / WebSocket 乗っ取り対策）

書き込み系メソッド（POST / PUT / PATCH / DELETE）と WebSocket（ターミナル）が対象です。
ブラウザが付ける `Origin` ヘッダーが次のいずれかでなければ 403（WebSocket はコード 1008 で切断）にします。

- 同一オリジン（`Origin` のホスト:ポートが `Host` ヘッダーと一致）
- `localhost` / `127.0.0.1` / `[::1]`（任意のポート。Vite 開発サーバー等）
- 環境変数 `FILE_MANAGER_ALLOWED_ORIGINS`（カンマ区切り）に列挙したオリジン

`Origin` ヘッダーのないリクエスト（curl・スクリプトなどブラウザ以外）は従来どおり許可します。
外部ツールからの `GET /api/fullpath` などのリンク遷移は対象外のため影響しません。

**追加が必要な例**: LAN の IP アドレスで開いた Quick アプリから Tailscale 名のサーバーを呼ぶ場合
```env
FILE_MANAGER_ALLOWED_ORIGINS=http://192.168.1.20:8001
```

## 2. Host 検証（DNS リバインディング対策）

すべてのリクエストが対象です。`Host` ヘッダーが次のいずれかでなければ 403 にします。

- `localhost`、IP アドレス（LAN・Tailscale の IP を含む）
- `*.ts.net`（Tailscale MagicDNS）
- この PC のホスト名（`hostname` / FQDN / `hostname.local`）
- 環境変数 `FILE_MANAGER_ALLOWED_HOSTS`（カンマ区切り。`*` で検証を無効化）

社内 DNS 名でアクセスする場合は `FILE_MANAGER_ALLOWED_HOSTS=fileserver.corp.example` のように追加します。

## 3. CORS

`localhost` と `FILE_MANAGER_ALLOWED_ORIGINS` のオリジンにだけ CORS ヘッダーを返します。
本体・Quick アプリは同一オリジン（ポート 8001）から配信されるため CORS は不要です。

## 4. パス

- API は絶対パスをそのまま受け付けます（ファイルマネージャーとしてPC内の任意の場所を扱うため）。
- 相対パスはベースディレクトリ（`FILE_MANAGER_BASE_DIR`）基準で解決し、`..` でベースの外へ出るものは 403 にします。
- 静的配信（`/` と `/quick/`）は配信フォルダの外のファイルを返しません。
- ZIP 解凍は展開先の外へ書き込むエントリ（Zip Slip）を拒否します。
- アップロードは `..`・絶対パス・ドライブ指定を含む相対パスを拒否します。
- Excalidraw の代替 SVG に埋め込むファイル名はエスケープします。

## 5. 待ち受けアドレス

- `./start.sh` と `start_windows_prod.bat` は `0.0.0.0`（全インターフェース）で待ち受けます。
  同じネットワーク上の端末からアクセスできるため、会社の LAN などでは利用範囲に注意してください。
- `./start_dev.sh` は `127.0.0.1` で待ち受けます。
