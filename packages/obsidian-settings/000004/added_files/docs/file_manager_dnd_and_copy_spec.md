/**
 * ファイルマネージャーからのドラッグ＆ドロップ連携および
 * 「コピーして同一フォルダーに保存」機能の仕様詳細ドキュメント
 **/

# 仕様書: ファイルマネージャー連携（ドラッグ＆ドロップと同一フォルダー保存）

## 1. 概要
ファイルマネージャーのウェブアプリ（ポート8001で動作するローカルファイル管理ツール）からObsidianエディタへファイルをドラッグ＆ドロップした際、これまでのRAWなJSON文字列ではなく、`http://localhost:8001/api/open-path?path=...` を用いたMarkdownリンクを自動生成・挿入します。

さらに、挿入されたリンクに対して右クリックメニュー「コピーして同一フォルダーに保存」を提供し、リンク先のファイルを現在開いているMarkdownファイルと同じフォルダーにコピーし、リンクをObsidianリンク（画像は埋め込みプレビュー形式 `![[...]]`、通常ファイルは拡張子付きリンク `[[...]]`）に自動変換します。

## 2. 背景と課題
- **従来の挙動**: ファイルマネージャーWebアプリからドラッグ＆ドロップすると、`[{"name":"aaa.md","type":"file","path":"/Users/.../aaa.md", ...}]` のようなJSON文字列がエディタに直接貼り付けられていた。
- **課題**:
  1. リンクとして機能せず、手動でURLを組み立てる必要があった。
  2. 外部フォルダにある参照ファイルをVault内に取り込みたい場合、Finderやファイルマネージャーで手動コピーし、Obsidian内でリンクを書き換える多段階の手間が発生していた。

## 3. 詳細仕様

### 3.1. ドラッグ＆ドロップ時のリンク自動生成
- **トリガー**: ファイルマネージャーWebアプリからObsidianエディタへのドロップイベント（`drop`）。
- **データ判定**:
  - `e.dataTransfer.getData("text/plain")` を取得。
  - JSONパースを行い、アイテム配列または単一オブジェクトであり、各要素に `path` 文字列プロパティが存在するか判定（`parseFileManagerData`）。
- **URLおよびMarkdown生成**:
  - URL形式: `http://localhost:8001/api/open-path?path=${encodeURIComponent(filePath)}`
  - 表示名: 各アイテムの `name`、なければファイルパスの末尾ファイル名。
  - 単一ファイル: `[ファイル名](URL)`
  - 複数ファイル: 各行 `- [ファイル名](URL)` の箇条書きリスト形式。
  - テンポを重視し、プロンプト・入力ダイアログは表示せず即座にエディタへ挿入。
- **挿入位置**:
  - ドロップされたマウス座標（`posAtCoords`）にカーソルを合わせ、テキストを置換・挿入。

### 3.2. 右クリックメニュー「コピーして同一フォルダーに保存」
- **対象コンテキスト**:
  1. **編集モード（Live Preview / ソースモード）**: `editor-menu` イベント。
     - カーソル位置または行内の `http://localhost:8001/api/open-path` リンクを検出し、メニュー項目を最上部に配置。
  2. **閲覧モード（Reading View）**: `contextmenu` イベント。
     - `a[href*='localhost:8001/api/open-path']` を右クリックした際に専用メニューを表示。
- **処理フロー (`executeCopyAndConvertLink`)**:
  1. **コピー元ファイルの確認**: リンク内の `path` パラメータから絶対パスを抽出し、`fs.existsSync` で存在を確認。存在しない場合は `Notice` を表示して処理を中断。
  2. **保存先フォルダーの決定**: 現在開いているMarkdownファイル（`app.workspace.getActiveFile()`）の親フォルダー（`activeFile.parent`）を保存先ディレクトリとする。
  3. **関連ファイル（画像・添付ファイル・相対リンク先）の自動抽出 (`extractMarkdownLinkedFiles`)**:
     - 対象がMarkdownファイル（`.md`）の場合、ファイル本文から以下を抽出：
       - Wikilink形式: `![[...]]`、`[[...]]`
       - Markdownリンク形式: `![...](...)`、`[...](...)`
     - 外部URLやアンカーを除外し、コピー元ディレクトリ内に実在するファイルを特定。
  4. **同名ファイルの存在確認ダイアログ**: 保存先に同名のファイル（メインファイルまたは関連ファイル）が既に存在する場合、`window.confirm` で対象ファイル一覧を表示して上書き可否を確認。キャンセルされた場合は処理を中断。
  5. **ファイルの一括コピー**:
     - メインファイルを `fs.copyFileSync` で保存先にコピー。
     - 関連ファイルもサブフォルダー構造（相対パス）を維持して一括コピー（必要なフォルダーは `mkdirSync({ recursive: true })` で自動生成）。
  6. **Obsidianリンク生成 (`buildObsidianLink`)**:
     - 画像拡張子（`.png`, `.jpg`, `.jpeg`, `.gif`, `.bmp`, `.svg`, `.webp`, `.avif`）の場合: `![[ファイル名]]`（埋め込みプレビュー形式）
     - その他（`.md`, `.pdf`, `.txt`, `.csv` 等）の場合: `[[ファイル名]]`（拡張子付きWikilink形式）
  7. **リンクの自動置換**:
     - エディタの場合: `editor.replaceRange` で該当リンク範囲を新しいObsidianリンクに置換。
     - 閲覧モードの場合: `app.vault.read` でファイル内容を取得し、該当リンクを置換して `app.vault.modify` で保存。

## 4. 構成・アーキテクチャ図
- 設計図: [file_manager_dnd_and_copy_diagram.excalidraw.md](file:///Users/mine/000_work/obsidian-dagnetz/docs/file_manager_dnd_and_copy_diagram.excalidraw.md)

## 5. テスト・検証
- テストファイル: [test_file_manager_dnd_and_copy.js](file:///Users/mine/000_work/obsidian-dagnetz/scratch/test_file_manager_dnd_and_copy.js)
  - `parseFileManagerData`（JSON判定・抽出）
  - `generateFileManagerMarkdown`（単一・複数リンク生成）
  - `extractOpenPathFromLink`（URL/リンクからのパス抽出）
  - `buildObsidianLink`（画像埋め込み・拡張子付きリンク振り分け）
  - `extractMarkdownLinkedFiles`（Markdown内からの実在関連ファイル抽出）
  - `executeCopyAndConvertLink`（存在確認、関連ファイル含む上書き確認、一括コピー、リンク置換）
