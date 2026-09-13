/**
 * 仕様: Sidebar Explorer 各フォルダヘッダータイトルの右クリックメニュー（「web アプリで開く」「codeで開く」）
 **/
# 仕様: Sidebar Explorer 各フォルダヘッダータイトルの右クリックメニュー

## 1. 概要
Sidebar Explorerの4つのフォルダ関連セクションにおいて、左クリックでFinder/Explorerを開くヘッダータイトル部分に右クリックメニュー（コンテキストメニュー）を追加します。
右クリックメニューから、以下の2つのアクションを直接実行できます：
1. **「web アプリで開く」**: ローカルWebアプリ（`http://localhost:8001/`）で対象フォルダを開く。
2. **「codeで開く」**: 対象フォルダを Visual Studio Code で開く。

## 2. 対象セクション
以下の4つのセクションのタイトル要素（`titleWrapper`）が対象となります：
1. **今日のフォルダ** (`01_data/YYYY/MM/DD`)
2. **開いているファイルのフォルダ** (現在開いているファイルの親フォルダ)
3. **データビュー** (`03_Dataview`)
4. **common prompt** (`11_common_prompt`)

## 3. 動作仕様

### 3.1 左クリックと右クリックの分離
- **左クリック (click)**:
  - 従来通り、OS規定のファイルマネージャー（macOS: Finder、Windows: Explorer）で対象フォルダを開く。
- **右クリック (contextmenu)**:
  - デフォルトのブラウザメニューやObsidian全体メニューを抑止（`preventDefault()`, `stopPropagation()`）。
  - Obsidian標準の `Menu` APIにより、カスタムコンテキストメニューを表示。

### 3.2 メニュー項目
1. **「web アプリで開く」**
   - **アイコン**: `globe`
   - **URL形式**: `http://localhost:8001/?path=${encodeURIComponent(folderFullPath)}`
   - **動作**: `window.open(url, "_blank")` により、デフォルトブラウザで指定フォルダを開いた状態でWebアプリを起動。
2. **「codeで開く」**
   - **アイコン**: `code`
   - **動作**: `openInVsCode(folderFullPath, vscodeExecutable)` を実行。
     - プラグイン設定のVS Code実行パス（`vscodeExecutablePath`）が指定されていれば最優先起動。
     - 未指定時はOS別コマンド（macOS: `open -a "Visual Studio Code"`, Windows: `Code.exe`候補または`code`, Linux: `code`）で起動。
     - 起動失敗時は Notice で警告を表示。

### 3.3 エラーハンドリング
- 今日のフォルダが未作成の場合: 「今日のフォルダがまだ作成されていません。」
- 開いているファイルがない場合: 「現在開いているファイルがありません。」
- フォルダが存在しない場合: 「フォルダが見つかりません。」

## 4. 技術的実装詳細
- **対象プラグイン**: `obsidian-sidebar-explorer`
- **モジュール構成**:
  - `utils.ts`:
    - `buildFileManagerWebUrl(folderFullPath: string): string`: URL生成。
    - `openInVsCode(targetPath: string, customExecutable?: string): Promise<boolean>`: VS Code非同期起動。
  - `view.ts`:
    - `showFolderHeaderContextMenu`: メニュー生成・表示共通メソッド。
    - 4セクションの `titleWrapper.oncontextmenu` へのバインド。

## 5. テスト・検証
```bash
# ユニットテスト実行
npm --prefix .obsidian/plugins/obsidian-sidebar-explorer test

# 結合テスト実行
node --test scratch/test_folder_header_context_menu.js

# プラグインビルド
npm --prefix .obsidian/plugins/obsidian-sidebar-explorer run build
```
