<!--
 * Spoonfeeder2 開発仕様書（開発者向け）
 * 構成・API・セキュリティ・ターミナル・テスト方針をコードに合わせてまとめたもの。
 * 機能の振る舞い（利用者向けの詳細）は docs/仕様.md、運用手順は 運用ルール.md、起動方法は README.md を参照する。
 * コードと食い違った場合はコードを正とし、このファイルを直す。
 -->

# Spoonfeeder2 開発仕様書

## 1. システム概要
ローカルのリポジトリ構造とテキストファイルを解析し、LLM向けの構造化XMLコンテキストを自動生成する。
また、AIが出力したコードの差分反映（関数・クラス単位の置換、複数ファイル変更、Markdown反映）、ローカルテスト実行、ブラウザ上の対話型ターミナル（xterm.js + PTY）、MkDocsリポジトリ向けの「統合マークダウン＋結合画像」出力を提供する、ローカル専用の補助ツール。

## 2. アーキテクチャ
- **バックエンド**: Python 3.10+ / FastAPI / Uvicorn / Pillow / PyYAML / resvg-py（SVG描画）/ pywinpty（Windowsのみ）。POSIXは標準 `pty`。
- **フロントエンド**: React 19 (Vite) / xterm.js / d3 / lucide-react / 素のCSS（`frontend/src/styles.css`。Tailwindは使用しない）。PWA（vite-plugin-pwa）。
- **配信**: ビルド済み `frontend/dist` をFastAPIが静的配信する（Node.jsは開発・ビルド時のみ必要。`frontend/dist` はGit管理しており、変更後は `npm run build --prefix frontend` で更新してコミットする）。
- **環境変数**:

| 変数 | 既定 | 意味 |
| --- | --- | --- |
| `SPOONFEEDER_PORT` | `8077` | 待受ポート（起動スクリプトが参照） |
| `SPOONFEEDER_HOST` | `127.0.0.1` | 待受アドレス（起動スクリプトとバックエンドの両方が参照）。ローカルホスト以外はLAN公開扱い |
| `SPOONFEEDER_ALLOWED_HOSTS` | なし | ローカルホスト待受時に追加で許可するHostヘッダー（カンマ区切り） |
| `SPOONFEEDER_ALLOWED_ORIGINS` | なし | ターミナルWebSocketで追加で許可するOrigin（カンマ区切り） |
| `SPOONFEEDER_CONFIGS_FILE` | `spoonfeeder_configs.json` | 履歴・選択状態・保存先設定のJSON。テストでは一時ファイルへ切り替える |
| `SPOONFEEDER_TERMINAL_SHELL` | なし | Windowsで `powershell` / `pwsh` を指定するとPowerShellを起動（既定 `cmd.exe /Q`） |

## 3. ディレクトリ構成

### backend/
| モジュール | 責務 |
| --- | --- |
| `main.py` | アプリ生成、Hostガード、ルーター登録、静的配信（`/map` 含む） |
| `api/` | REST ルーター。`repositories` / `ignore` / `references` / `mkdocs` / `patch` / `tools`、リクエストモデル `schemas`、入力検証 `deps` |
| `security.py` | Gitコマンド検証（読み取り専用サブコマンドのみ）、WebSocket Origin検証、Hostヘッダー検証ミドルウェア |
| `settings_store.py` | 設定ファイルの読み書き（`settings_transaction`、破損ファイルの退避） |
| `repository.py` | 走査（Git/独自無視）、文字コード判定、コンテキストXML生成、無視設定、文字列リテラル改行の正規化 |
| `patch_parser.py` | AI出力の解析（`<file_changes>`、パス付きフェンス、言語タグなし、見出し形式）。ネストしたフェンスの追跡 |
| `patch_paths.py` | `safe_target`（書き込み先検証）、反映先の推測 `infer_changes` |
| `csharp_symbols.py` | C#の型・メソッド範囲の走査（解析と置換で共通利用） |
| `patcher.py` | 差分プレビュー生成 `prepare_preview`、トランザクション反映 `apply_preview`（失敗時ロールバック） |
| `external_roots.py` | 反映を許可する外部ライブラリルート（`PYTHONPATH`・手動対応付け・コード内 `sys.path`） |
| `references.py` | 参照リポジトリ解決（Python/C#）、同一リポジトリ内モジュールの再帰検出 |
| `mkdocs_support.py` | MkDocs判定、リンク先MD探索、画像抽出と結合画像（容量超過時は分割 `build_image_parts`）、統合マークダウン生成 |
| `output_limits.py` | 出力上限（テキスト20万文字・画像4.5MB）への分割・パート別ファイル書き出し・読み直し検証 |
| `analysis.py` | 依存関係マップ（`/map`）用の解析 |
| `pyenv.py` / `runner.py` | 仮想環境・Embedded Pythonの検出、テストコマンド解決、プロセスグループ単位で終了できるコマンド実行 |
| `terminal.py` | WebSocketターミナル（POSIX PTY / Windows ConPTY / パイプ）、環境変数の構成 |

### frontend/src/
| 場所 | 責務 |
| --- | --- |
| `App.jsx` | ルート。`/map` はマップ画面、それ以外はメイン画面 |
| `pages/` | `MainPage`（画面の組み立て）、`DependencyMap`（d3の依存関係グラフ） |
| `components/` | 画面部品（ツリー、各モーダル、設定ドロワー、ターミナル、パッチパネル、コンテキスト作成パネル 等） |
| `hooks/` | 状態と副作用（`usePersistentState`、`useReferences`、`usePreview`、`useGlobalShortcuts`、`useMkdocsBundle`） |
| `lib/` | 純粋ロジック（`selection`、`ignoreHistory`、`download`、`charCount`） |
| `api.js` / `gitDiff.js` | APIクライアント、Git差分コマンドの既定値と通知文 |

## 4. セキュリティ仕様
このツールは「ブラウザからシェル実行・ファイル書き換えができるもの」なので、既定でローカルのみに閉じる。認証はない。
- **待受**: 既定 `127.0.0.1`。`SPOONFEEDER_HOST` にローカルホスト以外を指定した場合のみLAN公開扱いになる（信頼できるネットワークでのみ使うこと）。
- **Hostヘッダー検証**（`HostGuardMiddleware`、HTTP/WebSocket共通）: DNSリバインディング対策。ローカルホスト待受では `localhost` / `127.0.0.1` / `[::1]` と `SPOONFEEDER_ALLOWED_HOSTS` のみ許可し、他は403（WebSocketは1008で切断）。LAN公開時は任意のHostを許可する。
- **WebSocket Origin検証**: 別サイトのページからのターミナル接続（CSWSH）を拒否する。Originなし（非ブラウザ）とローカルホストは許可。LAN公開時は同一Hostに加え `SPOONFEEDER_ALLOWED_ORIGINS` に列挙したものだけを許可する。
- **`POST /api/git_diff`**: シェルを介さず引数リストで実行する。許可するのは `diff` / `log` / `show` / `status` / `ls-files` / `rev-parse` / `blame` / `describe` / `shortlog` のみで、`--output` など出力や外部コマンド実行につながるオプションと `git -c ...` は拒否する。`diff`/`log`/`show` には `--no-ext-diff` を付与する。パス指定（`*.py` など）はシェルではなくgitのpathspecとして解釈される。
- **書き込み先**: `safe_target` がメインリポジトリと許可された外部ルート（`external_roots.py`）の外を拒否する。リポジトリ直下に同名の実体がある場合、リポジトリ名の接頭辞とは解釈しない。
- **意図的に許可している機能**: `POST /api/test` のテストコマンドと、ターミナルは任意のコマンドを実行できる（ローカル利用が前提）。

## 5. ターミナル仕様
- **WebSocket**: `/api/terminal/ws?cwd={cwd}&mode={normal|embedded}&embedded_python_dir={dir}`
  - サーバー→クライアント: `{"type":"ready","cwd":"...","shell":"...","localEcho":bool}` / `{"type":"output","data":"..."}` / `{"type":"error","data":"..."}`
  - クライアント→サーバー: `{"type":"input","data":"..."}` / `{"type":"resize","cols":int,"rows":int}`。JSONでない文字列は入力として扱う。
  - `cwd` が存在しない場合はサーバーの現在のフォルダで起動する。
- **POSIX (macOS / Linux)**: `pty.openpty()` のPTYを、小さなランチャー（`setsid` + `TIOCSCTTY`）経由でシェルの**制御端末**にして `zsh -il`（なければ `$SHELL` / `bash` / `sh`）を起動する。これにより Ctrl+C のSIGINT配送とジョブ制御が機能する。読み取りはイベントループの `add_reader`（キャンセルしても出力を取りこぼさない）。
- **終了処理**: 対話シェルはSIGTERMを無視するため、プロセスグループへ **SIGHUP** → マスターFDを閉じる → 2秒待つ → 未終了なら **SIGKILL**。終了前に控えた子孫プロセス（ジョブ制御で別グループになったバックグラウンドジョブ）も停止し、処理がキャンセルされても必ず停止する。
- **Windows**: `pywinpty`（ConPTY/WinPTY）の非同期セッション。通常は `cmd.exe /Q`（`SPOONFEEDER_TERMINAL_SHELL=powershell` でPowerShell）。PTYを使えない場合はパイプセッション（ローカルエコー）へフォールバック。
- **仮想環境**: リポジトリ直下の `.venv` / `venv` / `env`（この順、`pyenv.find_venv_python`）を検出し、`PATH` 先頭追加と `VIRTUAL_ENV` を適用する。
- **Embedded Pythonモード**: 指定ディレクトリまたは親の `setenv.bat`（Windows）/ `setenv.sh`（POSIX）を一時実行して差分環境変数を取り込む（POSIXはパスをシェル文字列へ埋め込まず位置引数で渡す）。`python_console.bat` があれば `cmd.exe /K python_console.bat` で起動し、Embedded版Pythonが最優先になるよう `PATH` を構成する。

## 6. テスト実行の環境解決
- `resolve_test_command(root, command, mode, embedded_python_dir)`: `python` / `python3` / `pytest` で始まるコマンドだけを、選択中の環境のPythonへ書き換える（それ以外のコマンドはそのまま）。
- **通常モード**: `.venv` / `venv` / `env` のPython。なければコマンドを変更しない。**Embeddedモード**: `embedded_python_dir` 直下または1階層下のPython。
- 実行は `run_shell_command`。タイムアウト（`timeout_sec`、既定300秒、1〜3600）時はプロセスグループ（Windowsは `taskkill /T`）ごと終了するため、孫プロセスがパイプを握っても戻る。

## 7. コード・ドキュメント反映仕様
- 単一入力欄で次を自動判定する: 関数・メソッド・クラス全体 / ファイルパス付きコードブロック / `<file_changes>` / `# ===== [ファイル X/Y] path =====` 見出し。判定順は `<file_changes>` → フェンス → 見出し → 素の貼り付け。
- **ネストしたフェンス**: Markdownを出力するフェンス（`markdown` / `md` またはパスが `.md`）では、内部の ```` ```bash ```` 等の開閉を追跡して全文を保持する。
- **文字列リテラルの物理改行**: AI出力のシングル/ダブルクォート文字列内の改行を `\n` へ正規化してから `ast.parse` する。トリプルクォート（docstring等）内は維持する。
- **言語未指定**: Python（関数・クラス）を最優先し、該当しなければC#（`class`/`interface`/`struct`/`record`/メソッド）。
- **反映先の推測**: パスがなければ、同名シンボルを持つ一意なファイルを採用する。複数候補・候補なしは候補一覧を返す。
- **置換規則**: トップレベルの一致を優先し、同名が複数あれば最後の定義を置換する。新規Pythonシンボルは `if __name__ == "__main__":` の直前、なければ末尾に追加する。
- **外部ライブラリ**: メインリポジトリに加え、`PYTHONPATH`・手動対応付け・コード内の `sys.path.append/insert` で指定された外部ルート配下も反映先として許可する（`external_roots.py`。Git管理ファイルだけを走査する）。
- **書き込み**: 事前に全変更を構築し、直列化して一時ファイルから原子的に置換する。失敗時は全ファイルを変更前のバイト列へ戻す。既存ファイルの文字コード・BOM・改行（CRLF/LF）を維持する。

## 8. MkDocsドキュメントリポジトリ対応
- `mkdocs.yml` / `mkdocs.yaml`（`!!python/name:` 等のタグを含んでも可）から `site_name` / `docs_dir` / `nav` を解析してMkDocsリポジトリを判定する（`POST /api/repository_structure` の `is_mkdocs_repository`・`mkdocs_config`）。UIで手動切り替えもできる。
- **リンク先MDの自動チェック**（`POST /api/auto_select_modules`）: `[text](a.md)`、`[[wiki]]`、`nav` を再帰的にたどる（コードブロック内・外部URLは除外、`index.md` や拡張子省略も解決）。
- **2ファイル出力**（分割時は複数ファイル。「出力の上限」参照）: 選択したMarkdown内の画像（`![alt](p)` / `![[img]]` / `<img src>` / `[[x.excalidraw]]`）を解決し、各図の上に `【図X】 所属 | リンク記法` の帯を付けて縦1枚に連結する（`*_images.png`。4.5MBを超える場合は「出力の上限」の規則で圧縮・分割）。統合マークダウン（`*_context.md`）は画像リンクを保持し、画像照合ルールと出力形式の指示を付与する。同一文書内の同じ画像は1枚だけ収録する。
- **インラインSVG**: `.md` 本文に直接書かれた `<svg>…</svg>`（フェンス付きコードブロック内の例示は除く。入れ子は最外殻1件）を画像として結合画像へ収録し、統合マークダウンでは `[インラインSVG → 結合画像の【図N】に収録]` に置き換えて肥大化を防ぐ。描画できない（変換器なし・不正なSVG）場合は本文にそのまま残す。同一文書内の同一SVGは1枚だけ収録する。変換には `resvg-py`（なければ `cairosvg`）を使う。

### 出力の上限（コードモード・MkDocsモード共通）
社内AIの添付制限に合わせ、出力は次の上限に収める（`output_limits.py`、MBは1,000,000バイト）。
- **テキスト**: 1ファイル20万文字以内（Pythonの `len`、LF改行で数える）。超える場合は、ファイル境界（`<file path=`・`# ===== [ファイル` 見出し）→空行→改行の順に分割する。予算の25%未満しか使えない候補は採用しない。各パートの先頭に「分割ファイル n/m」、末尾に「続きあり（次は n+1/m）」または「ここまでで最後」を記載する。ファイル名は `*_context_part{n}of{m}.txt|md`（分割なしは従来どおり `*_context.txt|md`）。
- **画像**: 各4.5MB以下。まず全図を連結した無圧縮PNGを作り、4.5MB以下ならそのまま出力、6MB以下なら縮小・JPEG化で圧縮して1枚、6MBを超えるなら図の境界で2分割して各々に同じ規則を適用する（1枚の図は分割できないため圧縮のみ）。ファイル名は `*_images_part{n}of{m}.png|jpg`。統合マークダウンの対応一覧に「結合画像 n/m」と収録する図の範囲を記載する。
- **確認とやり直し**: 保存後にディスクから読み直して文字数・容量・画像として開けることを検証する。NGなら文字数上限を1万文字、画像上限を10%ずつ下げて最大3回やり直し、それでも収まらなければ500で失敗する。保存前に、同じ名前規則の過去の出力（古いパート）を削除する。
- **API**: `repository_context` / `mkdocs/context` は `chars`（合計文字数）と `text_parts`（`index` / `total` / `chars` / `text`）を返し、`mkdocs/context` / `mkdocs/save_bundle` は `image_parts`（`size` / `figures` / `data_url`）も返す。`save_context` / `mkdocs/save_bundle` は書き出した `files` / `markdown_files` / `image_files` と `verified` を返す。出力が5ファイルを超える場合は `warning` で知らせる。
- **画面**: コンテキスト出力パネルに「合計 12.35万文字（実数 / 上限）」を表示し（超過時は警告色）、分割時はパートのタブとパートごとのコピー・全パート保存を提供する。ファイルプレビューのモーダルにもそのファイルの文字数を表示する。

## 9. フロントエンド画面・UI
- 画面の組み立ては `pages/MainPage.jsx`。設定（`showIgnored` / `pythonMode` / `embeddedDir` / `gitDiffCommand` / `includeExternalModules`）はブラウザのlocalStorageへ自動保存する（使えない環境ではメモリ上で動作）。
- 主な機能: リポジトリ選択・履歴（検索・IME対応・削除）、ファイルツリー（キーボード操作・右クリックメニュー・プレビュー検索）、ライブラリ/リンク先MDの自動チェック、外部モジュールを含めるトグル、Git差分コピー、パッチ反映とテスト実行、ターミナル、依存関係マップ（`/map`）。
- 詳細な操作仕様は `docs/仕様.md`。

## 10. API一覧
すべて `Content-Type: application/json`。パスは `/api` 配下（`/map` を除く）。

| メソッド | パス | 概要 |
| --- | --- | --- |
| GET | `/health` | ヘルスチェック |
| GET | `/repositories` | 登録済みリポジトリ一覧（存在するフォルダのみ） |
| POST | `/remove_repository` | リポジトリ履歴の削除 |
| POST | `/repository_structure` | ツリー取得（`selected_files`・ignored・`is_mkdocs_repository`・`mkdocs_config` 含む） |
| POST | `/repository_context` | コンテキストXML生成（`reference_files` で外部リポジトリを同梱） |
| POST | `/save_context` | 生成済みコンテキストを共通の保存先フォルダへ `*_context.txt` として保存 |
| POST | `/save_settings` | 選択ファイル・ignored表示の保存 |
| POST | `/file_content` | ファイルプレビュー（リポジトリ外は400、2MB超は省略） |
| POST | `/dependency_map` | 依存関係マップ用のノード・辺 |
| POST | `/auto_select_modules` | 呼び出しモジュール・リンク先MDの再帰的自動選択 |
| POST | `/ignore_patterns` | 無視リストの取得 |
| POST | `/save_ignore_patterns` | 無視リストの保存（正規化・重複排除） |
| POST | `/remove_ignore_pattern` | 無視リストから1件除外 |
| POST | `/reference_modules` | 参照モジュール解析（Python/C#、`sys.path` 含む） |
| POST | `/save_reference_mapping` | 未解決モジュールと外部リポジトリの手動対応付けを保存 |
| POST | `/remove_reference_mapping` | 手動対応付けの解除 |
| POST | `/patch/preview` | 反映プレビュー（差分と反映先候補） |
| POST | `/patch/apply` | 反映実行（外部ライブラリ・Markdown対応、失敗時ロールバック） |
| POST | `/test` | テスト実行（`python_mode`・`embedded_python_dir`・`timeout_sec`） |
| POST | `/feedback_context` | テスト結果をLLMへ戻す文面を生成 |
| POST | `/git_diff` | Git差分取得（読み取り専用サブコマンドのみ、既定 `git diff HEAD -- *.py`） |
| POST | `/git_init` | Gitリポジトリ初期化 |
| POST | `/open_in_code` | VS Codeで開く |
| GET / POST | `/mkdocs/export_config` | 出力の保存先フォルダ設定の取得 / 保存（MkDocs・コードモード共通） |
| POST | `/mkdocs/context` | 統合マークダウンと結合画像（Data URL）の生成 |
| POST | `/mkdocs/save_bundle` | `*_context.md` と `*_images.png/.jpg` の保存 |
| POST | `/mkdocs/open_folder` | 保存先フォルダをFinder / Explorerで開く |
| WS | `/terminal/ws` | 対話型ターミナル |
| GET | `/map`（`/api` なし） | 依存関係マップ画面（`frontend/dist` がある場合） |

## 11. 起動と配布
- `start.sh`（macOS/Linux）/ `start.bat`（Windows）: 指定ポートの既存リスナーを終了 → `frontend/dist` がなければNode.jsでビルド → Uvicorn起動（既定 `127.0.0.1:8077`）。配布物に `frontend/dist` を含めればNode.js不要。
- 設定ファイル `spoonfeeder_configs.json` は `.gitignore` 対象。JSONが壊れていた場合は `*.corrupt[.N]` へ退避してから空の設定で始める（履歴が上書きで消えない）。

## 12. 開発ルール
- **テスト**: バックエンドは `.venv/bin/pytest -q`（Windowsは `.venv\Scripts\pytest.exe -q`）、フロントエンドは `npm test --prefix frontend`。変更前後で必ず通す。
- **テストの方針**: モックを使わない統合テスト。実ファイル・実Git・実プロセス・実HTTPサーバーを使い、OS/外部コマンド依存には `pytest.mark.skipif` を付ける。配置は `pytest/{モジュール名}_test.py`、テスト名は日本語で「何を確認するか」、1テスト1確認。個人環境のパスに依存しない（`tmp_path` に作る）。環境変数の切り替えだけは `monkeypatch.setenv` を使う。
- **バグ修正**: 再現テストを先に書いて失敗を確認してから直す。
- **リファクタリング**: 出力が変わらないことを、旧実装との突き合わせや既存テストで確認してから置き換える。
- **フロントエンドの確認**: コンポーネントは `react-dom/server` の描画テスト、ロジックは純粋関数のテスト。実操作はビルド後に実ブラウザ・実バックエンドで確認する。
- **ドキュメント**: 振る舞いを変えたら `claude.md`（構成・API）と `docs/仕様.md`（機能仕様）、必要なら `README.md` / `運用ルール.md` / `docs/*.excalidraw` を同じコミットで更新する。
