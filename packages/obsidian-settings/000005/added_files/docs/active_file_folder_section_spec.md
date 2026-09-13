/**
 * 仕様: Sidebar Explorerにおける「開いているファイルのフォルダ」セクション追加と「重要度TOP8」非表示
 **/
# 仕様: Sidebar Explorerにおける「開いているファイルのフォルダ」セクション追加と「重要度TOP8」非表示

## 概要
Obsidianの「Sidebar Explorer」プラグインにおいて、現在アクティブなファイル（ノートや画像、PDFなど）が属している親フォルダ内のすべてのファイルを一覧表示する「開いているファイルのフォルダ」セクションを追加します。
また、セクションタイトルをクリックすることで、macOSならFinder、WindowsならExplorerで該当フォルダを開く機能を提供します。
さらに、画面領域を有効活用するため、不要となった「重要度TOP8」セクションは非表示（除外）にします。

## セクション配置
現在のサイドバーの並び順は以下の通りとなります：
1. **今日のフォルダ** (`01_data/YYYY/MM/DD`)
2. **開いている関連ファイル** (Links to / Backlinks)
3. **開いているファイルのフォルダ** 【新規追加】
4. **データビュー** (`03_Dataview`)
5. **common prompt** (`11_common_prompt`)
6. **最近開いたファイル** (直近開いた履歴)
※「重要度TOP8」はサイドバーから除外されます。

## 動作仕様

### 1. 「開いているファイルのフォルダ」セクション
- **タイトル**: `開いているファイルのフォルダ`（アイコン: `📁`）
- **表示内容**:
  - 現在アクティブなファイル（`app.workspace.getActiveFile()`）の親フォルダ（`file.parent`）を取得。
  - 親フォルダのパス（例: `Folder: 01_data/2026/09/13`）をリスト上部に小さく表示。
  - 親フォルダ直下に存在する**すべてのファイル**（Markdown、画像、PDF、Canvas、Excelなど、拡張子を問わず全 `TFile`）を更新日時（`stat.mtime`）の降順で一覧表示。
  - 各ファイル項目は既存の `createFileItem` を使用して描画され、ファイルアイコンの表示、クリックでのエディタ表示、ドラッグ＆ドロップ、キーボードショートカット等の全機能に対応。
  - アクティブなファイルが存在しない場合は「ファイルが開かれていません」と表示。
  - フォルダ内に該当ファイルがない場合は「ファイルがありません」と表示。

### 2. タイトルクリックによるOSファイルマネージャー起動
- タイトル部分（`sidebar-header-title`）にマウスを乗せるとカーソルがポインターとなり、ツールチップ「クリックでフォルダをOSで開く」が表示されます。
- タイトルをクリックすると、セクションの折りたたみイベントを抑止（`e.stopPropagation()`）し、アクティブファイルの親フォルダのOS絶対パスを取得して起動します：
  - **macOS**: `open "<フォルダパス>"`
  - **Windows**: `explorer.exe "<フォルダパス>"`
- フォルダが存在しない場合や未選択の場合は Notice で通知します。

### 3. 検索ボックスによるキーワード絞り込み
- セクションヘッダーの右側に検索入力ボックス（テキストボックス）を設置。
- キーワード（全角・半角スペース区切りのAND検索）を入力すると、フォルダ内のファイル名をリアルタイムに絞り込み表示します。

### 4. 自動リフレッシュ（リアクティビティ）
- **アクティブタブ変更**: `active-leaf-change` イベント検知時に `refreshActiveFolderFiles()` を呼び出し、開いているファイルのフォルダに即座に追従。
- **ファイル変更**: `vault.on('create')`、`vault.on('delete')`、`vault.on('rename')` 検知時、変更されたファイルパスが開いている親フォルダ直下のものであれば自動的に一覧を再描画。

### 5. 「重要度TOP8」の非表示
- `renderAll` での `topAccessSectionContent` のDOM生成を削除し、サイドバーUI上に表示しないようにします。

## 技術的要件
- **対象プラグイン**: `obsidian-sidebar-explorer`
- **実装ファイル**:
  - `view.ts`:
    - `activeFolderSectionContent`, `activeFolderSearchQuery` プロパティの追加。
    - `renderAll` 内でのセクション生成、OS起動ハンドラおよび検索入力の登録。
    - `refreshActiveFolderFiles()` メソッドの実装。
    - `active-leaf-change` および `refreshFolderSectionsForFileChange` での再描画呼び出し。
    - `topAccessSectionContent` の生成除外。
  - `utils.ts`:
    - `filterFolderFiles<T>` 関数の追加（mtime降順ソートおよびAND検索フィルタ）。
  - `utils.test.ts`:
    - `filterFolderFiles` の単体テスト。

## テスト方法
```bash
# ユニットテスト実行
npm --prefix .obsidian/plugins/obsidian-sidebar-explorer test

# 結合テスト実行
node --test scratch/test_active_folder_section.js

# プラグインビルド
npm --prefix .obsidian/plugins/obsidian-sidebar-explorer run build
```
