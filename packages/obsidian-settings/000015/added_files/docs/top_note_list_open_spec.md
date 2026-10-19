# 仕様書: topタグ付きノートの開いた時のノート一覧自動更新

## 概要
タグに `top` が含まれているノート（マークダウンファイル）を開いたとき、そのノートのプロパティ（フロントマター）に `Search Query`（または `SearchQuery`）が設定されている場合に、そのクエリ値（タグ）に一致するノート一覧テーブルを自動的に更新（最新化）する。

## 動作詳細
1. **トリガー**:
   - Obsidianでファイルがアクティブ化されたとき（`file-open` イベント）。

2. **対象条件**:
   - 開かれたファイルがマークダウンファイル（`.md` 拡張子で `.excalidraw.md` でないもの）であること。
   - ファイルのタグ（フロントマターの `tags` または本文中のインラインタグ）に `top` が含まれていること。
   - ファイルのプロパティ（フロントマター）に `Search Query` または `SearchQuery`（大文字小文字、スペースを問わない）が存在し、空でない値（タグ名）が設定されていること。

3. **処理内容**:
   - サイドバーの「ノート一覧を追加」と同じ処理（`obsidian-sidebar-explorer-tag` が公開する `window._sidebarExplorerTagUpdateNoteList`）で、`Search Query` に合うノート一覧を作り直す。対象ノートの選び方・一覧の内容は [tag_note_list_spec.md](tag_note_list_spec.md) のとおり。
     - プラグインの設定「タグの対象フォルダ」（既定: `01_data`, `02_MOC`）内のノートだけを一覧に入れる。`10_summary` のサマリーなどは入れない。
   - 開かれたノート本文中の `<!-- custom-note-list:start -->` から `<!-- custom-note-list:end -->` の範囲（または `# note一覧` セクション）を新しい一覧で上書き。内容に差分が無ければ書き込まない。
   - 書き込む前に、まだそのノートがアクティブかを確認し、別のノートへ移動していれば書き込まない。
   - **通知の制御**:
     - 手動での「ノート一覧を追加」実行時は `new Notice` による通知を表示するが、ファイルオープン時の自動最新化の際は、ユーザーの作業の邪魔にならないように通知を表示しない（サイレント実行）。
     - `obsidian-sidebar-explorer-tag` が無効な場合は、何もしない。

## 技術的要件
- `80_script/register_custom_commands/25_tag_menu_top_notes_drop.js` の `handleFileOpen` が `app.workspace.on("file-open", ...)` を監視し、重複登録防止のために `window._customFileOpenListener` でハンドラを管理する。
- 一覧の更新は `23_tags.js` の `updateNoteListForFile(file, tag, silent, shouldContinue)` から、プラグインの `updateNoteList`（`noteListUpdater.ts`）へ委ねる。手動と自動の双方が同じ実装を使う。
