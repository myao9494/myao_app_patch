# Spoonfeeder2

Python/C#リポジトリを会社環境のAIチャットへ渡し、安全に変更を戻すためのローカルPWAです。

## 起動

Python 3.10以上で仮想環境を作り、依存関係を導入します。

```sh
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
./start.sh
```

Windowsでは同じ依存関係を導入後、`start.bat` を実行します。配布物には `frontend/dist` を含むため、会社PCにNode.jsは不要です。既定URLは `http://127.0.0.1:8077` です。

```bat
py -3 -m venv .venv
.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
start.bat
```

ソース配布時に`frontend/dist`を省く場合だけ、初回起動時のビルド用にNode.jsが必要です。起動スクリプトは配布物がなくビルドもできない状態をエラーとして明示します。

起動時に既存のポートリスナーを終了してからサーバーを起動します。ポートは`SPOONFEEDER_PORT`、待受アドレスは`SPOONFEEDER_HOST`で変更できます。

## セキュリティ

このツールはブラウザからシェル実行・ファイル書き換え・テスト実行ができるため、既定ではローカルのみで待ち受けます（`SPOONFEEDER_HOST` 既定 `127.0.0.1`）。

- `0.0.0.0` などでLAN公開する場合は `SPOONFEEDER_HOST` を設定してください（認証はありません。信頼できるネットワークでのみ使用してください）。
- ターミナルWebSocketは、別サイトのページからの接続（Originがローカルホスト以外）を拒否します。LAN公開時は同一Hostからの接続のみ追加で許可され、他のOriginは `SPOONFEEDER_ALLOWED_ORIGINS`（カンマ区切り）で明示できます。
- 「Git差分コピー」はシェルを介さず、読み取り専用のgitサブコマンド（diff / log / show / status / ls-files / rev-parse / blame / describe / shortlog）だけを実行します。`--output` などファイル出力や外部コマンド実行につながるオプションは拒否されます。

詳細は [docs/仕様.md](docs/仕様.md)（機能仕様）、[運用ルール.md](運用ルール.md)（運用手順）、[claude.md](claude.md)（開発者向けの構成・API）を参照してください。

通常Pythonモードでは、選択コードが実際に利用する外部Python/C#ソースを環境変数、venv、`ProjectReference`などから自動検出します。参照側はコンテキスト専用の読み取り専用ツリーで、反映・テスト・ターミナルは常にメインリポジトリが対象です。Embedded Pythonモードでは参照リポジトリ機能を無効にします。

## 開発

```text
backend/    FastAPI（api/ ルーター、patch_* 反映、terminal、mkdocs_support、security ほか）
frontend/   React + Vite（pages / components / hooks / lib）。ビルド済みの dist をバックエンドが配信
pytest/     バックエンドの統合テスト（pytest/{モジュール名}_test.py）
docs/       機能仕様（仕様.md）と構成図（*.excalidraw）
```

- バックエンドのテスト: `.venv/bin/pytest -q`（Windowsは `.venv\Scripts\pytest.exe -q`）。実ファイル・実Git・実プロセスを使う統合テストで、モックは使いません。
- フロントエンドのテスト: `npm test --prefix frontend`
- フロントエンドのビルド: `npm run build --prefix frontend`（`frontend/dist` を更新してコミットします）
- フロントエンドの開発サーバー: バックエンドを起動した状態で `npm run dev --prefix frontend`（`/api` は `127.0.0.1:8077` へ、WebSocketも含めて中継されます）
- 開発ルールの詳細は [claude.md](claude.md) の「開発ルール」を参照してください。

日本語ファイル名、`/`と`\`の相互入力、UTF-8（BOM付き含む）・UTF-16・CP932の読み込みに対応します。AI変更の反映時は、既存ファイルの文字コード、BOM、CRLF/LFを維持します。

主なショートカットは `I`（無視リスト編集）、`H`（説明表示）、編集モーダル内の `Ctrl/Cmd+S`（保存終了）、`Esc`（破棄終了）、`Ctrl/Cmd+Z`・`Ctrl/Cmd+Shift+Z`（Undo/Redo）です。
