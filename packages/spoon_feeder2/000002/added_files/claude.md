<!--
 * Spoonfeeder2 開発仕様書
 * システム概要、API定義、ターミナル機能、Embedded版Python連携、フロントエンド画面構成、および運用仕様をシンプルにまとめた統合仕様書です。
 -->

# Spoonfeeder2 開発仕様書

## 1. システム概要
ローカルのリポジトリ構造とテキストファイルを解析し、LLM向けの構造化XMLコンテキストを自動生成する。
また、AIが出力したコードの差分自動反映（オートマージ・関数単位置換）、ローカルテスト実行、およびブラウザ上で操作可能な対話型ターミナル（xterm.js + ConPTY / WinPTY / POSIX PTY）を提供する補助ツール。

## 2. アーキテクチャ
- **バックエンド**: Python 3.10+ / FastAPI / Uvicorn / winpty (Windows) / pty (POSIX)
- **フロントエンド**: React (Vite) / xterm.js / Tailwind CSS / Vanilla CSS
- **ポート**: デフォルト `8077`（環境変数 `SPOONFEEDER_PORT` で変更可能）
- **ホスト**: デフォルト `0.0.0.0`（環境変数 `SPOONFEEDER_HOST` で変更可能）

## 3. ターミナル仕様
- **Windows環境**:
  - `winpty` (ConPTY / WinPTY) による高速・低レイテンシな非同期PTYセッション。
  - 通常モード: `cmd.exe /Q`（環境変数 `SPOONFEEDER_TERMINAL_SHELL=powershell` でPowerShell切替可能）。
  - リポジトリ直下の仮想環境（`.venv` / `venv`）を自動検出し、`PATH` 先頭追加および `VIRTUAL_ENV` を適用。
- **Embedded Pythonモード**:
  - `embedded_python_dir`（例: `C:\Users\kabu_server\000_work\py3123`）が指定された場合、同ディレクトリまたは親ディレクトリの `setenv.bat` (Windows) / `setenv.sh` (POSIX) を一時実行し、差分環境変数をキャプチャしてマージ。
  - `python_console.bat` が存在する場合は `cmd.exe /K python_console.bat` として対話型ターミナルを起動。
  - Embedded版 Python（Python 3.12.3等）が最優先で実行されるように `PATH` を構成。
- **POSIX環境 (macOS / Linux)**:
  - `pty.openpty()` を用いて `zsh -il`（または `bash` / `/bin/sh`）を起動。
- **WebSocket API**:
  - エンドポイント: `/api/terminal/ws?cwd={cwd}&mode={mode}&embedded_python_dir={dir}`
  - メッセージ形式:
    - サーバー -> クライアント: `{"type": "ready", "cwd": "...", "shell": "...", "localEcho": bool}`
    - サーバー -> クライアント: `{"type": "output", "data": "..."}`
    - クライアント -> サーバー: `{"type": "input", "data": "..."}`
    - クライアント -> サーバー: `{"type": "resize", "cols": int, "rows": int}`

## 4. テスト実行の環境解決
- **通常モード (normal)**: リポジトリ直下の `.venv` / `venv` / `env` を自動検出し、そのPythonでテストを実行。
- **Embedded Pythonモード (embedded)**: `embedded_python_dir` 内のPythonバイナリを優先使用。`setenv.bat` / `setenv.sh` の差分環境変数を適用してテストプロセスを起動。
- **POSIX通常モード**: `.venv` / `venv` / `env` を検出し、`bin/python` でテストを実行。
- `resolve_test_command(root, command, mode, embedded_python_dir)` が各環境に応じたPythonパスを解決。

## 5. コード反映仕様
- 単一の入力欄で「関数・メソッド・クラス全体」「ファイルパス付きコードブロック」「`<file_changes>` 複数ファイル変更」を自動判定。
- **外部ライブラリ反映の拡張**: メインリポジトリに加え、`PYTHONPATH` やコード内 `sys.path.append` / `sys.path.insert` で指定されたGit管理下の外部ライブラリフォルダ（`common_lib`等）配下のファイルも安全な反映先として認識・差分生成・トランザクション適用。
- **クラス・型単位の反映**: Pythonの `class`（デコレータ付き含む）およびC#の `class` / `interface` / `struct` / `record` を自動抽出し、ファイル内の同名クラス/型を置換。
- **AI出力の改行正規化**: AI出力コード内の文字列リテラル（シングル/ダブルクォート）に含まれる物理改行（`\n`, `\r\n`）を `\n` へ自動エスケープし、`ast.parse` の構文エラーを防ぎつつ関数・クラスを抽出。トリプルクォート（docstring等）内の改行は維持。
- **言語未指定ブロック・素貼り付け時の優先順位**: 言語タグが省略されたコードブロック（` ``` `）や素のテキスト貼り付け時はPython（関数・クラス）を最優先で解釈し、該当しない場合にC#を試行。C#の場合は ````csharp ```` コードブロック指定を推奨。
- ファイル名指定がない場合でも、一意なPython関数/クラスまたはC#メソッド/クラスなら自動特定。複数候補時は候補一覧を返却。
- **`if __name__ == "__main__":` 直前への新シンボル挿入**: Pythonファイルに新規関数・クラスを追加する際、ファイル内に `if __name__ == "__main__":`（シングルクォート含む）ブロックが存在する場合は、実行エントリポイントを破壊しないようその直前（上）に挿入。存在しない場合はファイル末尾に追加。
- **同名シンボルの優先置換と重複防止**: クラス内メソッドと同名のトップレベル関数が存在する場合や、過去の反映で同名シンボルが既に複数存在している場合でも、トップレベルの一致や最後の定義を優先して置換し、末尾への多重追加・重複増殖を防止。

## 6. フロントエンド画面・UI仕様
- **ライブラリ自動チェック機能**:
  - 「ファイルを選択」見出し横に「ライブラリを自動チェック」ボタンを配置。
  - 現在選択中のファイルから呼び出されている同一リポジトリ内のモジュールを再帰的（推移的）にAST解析し、チェックを自動付与（`POST /api/auto_select_modules`）。
- **外部モジュールコンテキスト制御**:
  - 「コンテキストを作成」ボタン左横に「呼び出されているモジュールを含む」チェックボックスを配置（デフォルト: ON）。
  - ONの場合、`PYTHONPATH` やコード内 `sys.path` から検出された外部ライブラリ（pip除外）をコンテキストに含め、AIプロンプトでも外部ライブラリを編集対象として指示。OFF時はメインリポジトリのみを収録。
- **リポジトリ選択・履歴 (RepositorySelector)**:
  - 入力欄にパスが入力されている状態でも、ドロップダウントグルボタン（`▼`）を押すことで全リポジトリ履歴を表示・選択可能。
  - ドロップダウン最上部に検索ボックスを配置し、入力キーワードでリアルタイムに履歴をスクリーニング。開いた際に自動フォーカス。
  - 日本語IME入力の変換確定リターン（Enter）による誤決定を防止（`isComposing`判定）。確定後に上下キー（`↑`/`↓`）で候補を選択し、Enterキーで決定・自動ロード。
  - 各履歴アイテムに削除ボタン（ゴミ箱アイコン）を配置し、不要な履歴（一時フォルダ等）を個別に除外可能（`POST /api/remove_repository`）。
- **Git差分コピー機能**:
  - リポジトリ選択バー（path-bar）に「Git差分コピー」ボタンを配置。
  - 現在開いているリポジトリを対象にGitコマンドを実行し、差分をクリップボードに格納。
  - 差分コマンドはハンバーガーメニュー（SettingsDrawer）からカスタマイズ可能（デフォルト: `git diff HEAD -- *.py`）。空欄時はデフォルトが適用される。
- **ファイルツリー**:
  - キーボード操作（↑/↓でフォーカス移動、Enterでチェック反転/フォルダ開閉、Shift+Enterでプレビュー表示）。
  - 右クリックメニューで無視リスト追加・除外、手動参照リポジトリ対応付け。
- **ファイルプレビュー (PreviewModal)**:
  - 自動フォーカス検索バー（大文字小文字・単語単位・正規表現・Enter/Shift+Enterでの一致移動）。
- **コード反映パネル (PatchPanel)**:
  - 単一入力欄で差分プレビュー生成、自動反映、テスト実行。
- **対話型ターミナル (TerminalPanel)**:
  - xterm.js による対話型端末。

## 7. API一覧
- `GET /api/health`: ヘルスチェック
- `GET /api/repositories`: 登録済みリポジトリ一覧
- `POST /api/remove_repository`: リポジトリ履歴の削除
- `POST /api/repository_structure`: リポジトリツリー取得（ignored項目含む）
- `POST /api/repository_context`: コンテキストXML生成
- `POST /api/auto_select_modules`: 同一リポジトリ内呼び出しモジュールの再帰的自動選択
- `POST /api/reference_modules`: 参照モジュール解析（Python/C#、sys.path動的抽出含む）
- `POST /api/file_content`: ファイルプレビュー取得
- `POST /api/patch_preview`: コード反映プレビュー生成（外部ライブラリ対応）
- `POST /api/apply_patch`: コード反映実行（外部ライブラリ対応）
- `POST /api/test`: テスト実行（`python_mode`, `embedded_python_dir` パラメータで環境切替）
- `POST /api/git_diff`: Git差分取得（コマンド指定対応、デフォルト: `git diff HEAD -- *.py`）
- `WS /api/terminal/ws`: WebSocket対話型ターミナル

## 8. 起動と配布
- `start.bat`: Windows向け起動スクリプト（UTF-8設定、既存ポート切断、Uvicorn起動）
- `start.sh`: macOS/Linux向け起動スクリプト

