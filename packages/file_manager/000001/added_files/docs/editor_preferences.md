# エディタ起動設定仕様 (Editor Preferences)

## 概要

ハンバーガーメニューおよび設定ファイル（`backend/settings.json`）で管理されるエディタ起動設定の仕様です。
ファイルマネージャー一覧画面、検索画面、および `/api/fullpath` 経由でのファイルオープン時の挙動を制御します。

## 設定項目

### 1. Text Files (`textFileOpenMode`)

| モード名 | 設定値 | 挙動 |
|---|---|---|
| Web App Editor | `"web"` | アプリ内コードエディタモーダル（構文ハイライト付き）で開く |
| Visual Studio Code | `"vscode"` | VS Code で対象ファイルを開く |

### 2. Markdown (`markdownOpenMode`)

| モード名 | 設定値 | Obsidian Vault内 (`obsidian`含むパス) | Vault外のMarkdownファイル |
|---|---|---|---|
| Web App Editor | `"web"` | Web App Editor モーダル | Web App Editor モーダル |
| **Obsidian or Web App Editor** | **`"obsidian_or_web"`** | **Obsidian (obsidian:// URL)** | **Web App Editor モーダル** |
| Obsidian or Visual Studio Code | `"external"` | Obsidian (obsidian:// URL) | Visual Studio Code |

※ `.excalidraw.md` などの Excalidraw ファイルは Markdown 設定に関わらず Excalidraw アプリで開かれます。

## FullPath API (`/api/fullpath`) との連携

ブラウザから直接 `/api/fullpath?path=...` を開いた場合や、外部ツールから呼び出した場合も本設定が反映されます。

- **`"web"` または `"obsidian_or_web"` でVault外の場合**:
  - `/?path={親ディレクトリ}&open_file={ファイルパス}&open_mode=web` へリダイレクトされ、Web App Editor でファイルが開かれます。
- **Obsidian起動 または VSCode起動の場合**:
  - 対応するアプリを起動し、ブラウザタブを自動的に閉じるHTMLレスポンスを返します。
