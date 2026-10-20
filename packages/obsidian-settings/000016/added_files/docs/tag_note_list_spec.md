# 仕様書: タグの右クリックメニューからの「ノート一覧を追加」

## 概要
タグの右クリックメニュー（`tag-menu`）に「ノート一覧を追加」を追加する。選択すると、現在開いているノート（マークダウン）の先頭（プロパティが存在する場合はその直後）に、そのタグを含むノート一覧テーブルを上書きまたは追加し、ノートのプロパティ（フロントマター）に `Search Query` として現在のタグの状態を記録する。

## 動作詳細
1. **対象コンテキスト**:
   - タグペインやノート内でタグを右クリックした際のメニュー（`tag-menu` イベント）。
2. **メニュー項目**:
   - 表示名：「ノート一覧を追加」
   - アイコン：`bullet-list`
3. **処理フロー**:
   - **アクティブノートチェック**:
     - 現在アクティブなファイル（`app.workspace.getActiveFile()`）を取得。
     - ファイルが存在しない場合、または Markdown ファイルでない場合、または `.excalidraw.md` の場合は「開いているノートがありません」等の通知を表示して終了。
   - **一覧の作成・書き込み**: `obsidian-sidebar-explorer-tag` プラグインが公開する `window._sidebarExplorerTagUpdateNoteList` を呼び出す（テンプレートは一覧の生成処理を持たない）。サイドバーの `tag_key` の「ノート一覧を追加」と同じ処理なので、どちらから追加しても同じ一覧になる。プラグインが無効な場合は通知だけを表示して何もしない。
   - **該当ファイルの抽出**（プラグインの `noteListUpdater.ts`）:
     - プラグインの設定「タグの対象フォルダ」（既定: `01_data`, `02_MOC`）内のノートだけを対象にする。`10_summary` のサマリーなど、対象フォルダ外のノートはタグが合っていても一覧に入れない。
     - タグの判定は `tag_key` の検索と同じ（設定「本文のタグを有効にする」がオフならプロパティのタグだけ）。タグの右クリックメニューから渡る `#todo` の先頭の `#` は判定のときだけ取り除く。
     - `top` タグ付きノートは除外条件（`-tag`）を免除する。一覧を書き込むノート自身は入れない。並び順は更新日時の降順。
   - **ノート一覧コンテンツの生成**（プラグインの `noteListSection.ts` の `buildNoteListContent`）:
     - `# note一覧` 見出しの下に、`<!-- custom-note-list:start -->` 〜 `<!-- custom-note-list:end -->` で囲んだ DataviewJS ブロックを出力する。ブロックは検索ボックス付きの表（`名称` / `タグ` / `冒頭` / `作成日` / `編集日`）を描画する。
     - 検索ボックスは、名称・タグ・冒頭を対象に絞り込む。スペース（全角も可）区切りの AND 検索で、大文字小文字は区別しない。冒頭に保存した `\#` は `#` として探す。
     - `タグ` 列はプロパティのタグだけを、大文字小文字の違いだけの重複をまとめて表示する。
     - `冒頭` 列はフロントマター、一覧自身、画像埋め込み、HTMLタグ、リンク記法を除去し、100文字に切り詰める。
   - **プロパティ（フロントマター）の追加/更新**:
     - プロパティ `Search Query` に渡された検索条件（例: `#todo`）を記録する。値が同じなら書き戻さない。
   - **本文の更新（上書きまたは挿入）**:
     - `<!-- custom-note-list:start -->` と `<!-- custom-note-list:end -->` のマーカーがある場合は、その範囲のみを置換する。
     - マーカーがない旧形式の場合は、`# note一覧` 直下の表行または箇条書き行のみを置換し、次の通常本文まで不用意に削除しない。
     - 存在しない場合は、フロントマターブロックの直後、またはファイルの先頭に挿入する。
     - 内容に差分があるときだけ `app.vault.modify` で保存する。

## 技術的要件
- メニューの登録は `80_script/register_custom_commands/25_tag_menu_top_notes_drop.js`（`window._customTagMenuListener`）、呼び出しは `23_tags.js` の `addNoteListFromTag` / `updateNoteListForFile`。
- 一覧の作成は `.obsidian/plugins/obsidian-sidebar-explorer-tag/noteListUpdater.ts` と `noteListSection.ts`。公開は `main.ts` の `updateNoteList`。
- テスト: プラグインの `noteListSection.test.ts` / `noteListUpdater.test.ts`、`scratch/test_note_list.js`（テンプレートとプラグインを合わせた動作）、`scratch/test_note_list_helper.js`（テンプレートからの委譲）。
