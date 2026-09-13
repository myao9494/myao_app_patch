<!--
マークダウン編集時の右クリックメニュー「フォルダを開く」「VS Codeで開く」仕様書
エディタコンテキストメニュー（editor-menu）およびファイルメニュー（file-menu）から、
現在編集中のノートが存在する親フォルダのオープン、およびVS Codeによる外部起動を可能にする機能仕様。
-->

# 仕様書: マークダウン編集時右クリックメニューへの「フォルダを開く」「VS Codeで開く」追加

## 1. 概要
ObsidianでMarkdownノートを執筆・編集している際、エディタ画面内で右クリックしたときのコンテキストメニュー（`editor-menu`）に、「フォルダを開く」および「VS Codeで開く」の2つのメニュー項目を追加する。

従来はタブヘッダーまでマウスカーソルを移動して右クリックする必要があったが、本機能によりエディタ上のどこからでも1クリックで該当フォルダやVS Codeを開くことができる。

---

## 2. ユーザーインターフェース仕様

### 2.1 メニュー項目
1. **1つ目**: 「フォルダを開く」
   - **アイコン**: `folder`
   - **アクション**: 対象ファイルが存在する親フォルダをOSのファイルマネージャー（Finder / エクスプローラー）で開く。
2. **2つ目**: 「VS Codeで開く」
   - **アイコン**: `code`
   - **アクション**: 対象ファイルを Visual Studio Code で開く。

### 2.2 メニュー内での配置順序
エディタ右クリックメニュー（`editor-menu`）が表示された際、DOM操作（`prepend`）により以下の順序で最上部付近に並び替えられる。
1. （存在する場合）「添付ファイルを削除」
2. （存在する場合）「コピーして同一フォルダーに保存」
3. **「フォルダを開く」**
4. **「VS Codeで開く」**
5. 「サマリーを作成」
6. 「PDFで出力(人間用)」
7. 「HTMLで出力(AIコンテキスト用)」
8. 「HTMLで出力(人間用)」

---

## 3. 機能・処理ロジック仕様

### 3.1 フォルダオープン処理 (`openContainingFolder`)
- **対象ファイル特定**: 引数 `file` または `app.workspace.getActiveFile()` を参照。
- **絶対パス計算**:
  - `targetFile.parent.path` から親フォルダのVault内相対パスを取得。
  - `app.vault.adapter.basePath` と結合して親フォルダの絶対パス（`folderFullPath`）を生成。
- **実行優先度**:
  1. **Electron `shell.openPath`**:
     - フォルダそのものをOS規定のファイルマネージャーで直接開く。
  2. **`child_process.execFile`**:
     - macOS (`darwin`): `open "<folderFullPath>"`
     - Windows (`win32`): `explorer "<folderFullPath>"`
     - Linux (`linux`): `xdg-open "<folderFullPath>"`
  3. **Obsidian標準 `app.showInFolder`**:
     - 該当ファイルがハイライトされた状態でフォルダを開く。
- **フィードバック**: 成功時は「フォルダを開きました」、失敗時はエラーNoticeを表示。

### 3.2 VS Code起動処理 (`openInVsCode`)
- **対象ファイル特定**: 引数 `file` または `app.workspace.getActiveFile()` を参照。
- **絶対パス計算**: `getAbsoluteVaultPath(targetFile)` によりファイル自体の絶対パスを取得。
- **実行優先度**:
  1. **Sidebar Explorer設定の指定パス**:
     - `app.plugins.plugins["obsidian-sidebar-explorer"]?.settings?.vscodeExecutablePath` に有効な実行ファイルパスが設定されていればそれを優先実行。
  2. **プラットフォーム別起動コマンド**:
     - **macOS (`darwin`)**:
       1. `open -a "Visual Studio Code" "<fileFullPath>"`
       2. `open -b com.microsoft.VSCode "<fileFullPath>"`
       3. `/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code "<fileFullPath>"`
       4. `code "<fileFullPath>"`
     - **Windows (`win32`)**:
       1. 既定インストールパスの探索（`LOCALAPPDATA`、`ProgramFiles` 等の `Code.exe` / `code.cmd`）
       2. `code "<fileFullPath>"`
     - **Linux (`linux`)**:
       1. `code "<fileFullPath>"`
  3. **カスタムURLスキームによるフォールバック**:
     - `vscode://file/<エンコードされた絶対パス>` を生成。
     - `electron.shell.openExternal` または `window.open` を実行して外部起動。
- **フィードバック**: 成功時は「VS Codeで開きました」、失敗時はエラーNoticeを表示。

---

## 4. コマンドパレット・ショートカット対応

以下のコマンドIDでコマンドパレットに登録されており、ホットキー設定から任意のショートカットキーを割り当て可能。
- `custom:open-containing-folder`: 「フォルダを開く (Finder/Explorer)」
- `custom:open-in-vscode`: 「VS Codeで開く」

---

## 5. 対象ファイルおよび構成
- スクリプト実装: [RegisterCustomCommands.md](file:///Users/mine/000_work/obsidian-dagnetz/00_templates/RegisterCustomCommands.md)
- 仕様書: [open_folder_and_vscode_menu_spec.md](file:///Users/mine/000_work/obsidian-dagnetz/docs/open_folder_and_vscode_menu_spec.md)
- 構成図: [open_folder_and_vscode_menu_diagram.excalidraw.md](file:///Users/mine/000_work/obsidian-dagnetz/docs/open_folder_and_vscode_menu_diagram.excalidraw.md)
- テストコード: [test_open_folder_and_vscode_menu.js](file:///Users/mine/000_work/obsidian-dagnetz/scratch/test_open_folder_and_vscode_menu.js)
