<!--
/**
 * 仕様: 00_templates/RegisterCustomCommands.md が登録する機能の一覧（コードから起こしたリファレンス）
 *
 * 1. 起動方法と再実行時の扱い
 * 2. コマンド、ショートカット、右クリックメニュー、常駐リスナーの一覧
 * 3. 連携している外部サービス・他プラグイン・グローバル公開値
 * 4. 個別仕様書への対応
 **/
-->
# RegisterCustomCommands.md 機能リファレンス

`00_templates/RegisterCustomCommands.md` が登録している機能を、コードを正として一覧にしたもの。
個々の機能の背景や詳細は、各行の「仕様書」を参照する。全ドキュメントの索引は [README.md](README.md)。

## 1. 起動と再実行

- **起動**: Templater の起動時テンプレート（`startup_templates`）として、Obsidian の起動時に1回実行される。`00_templates/RegisterCustomCommands.md` は読み込み役で、`80_script/register_custom_commands/` のファイルを番号順に読み込み、連結して1つのスクリプトとして実行する（「1.1 ファイルの構成」を参照）。
- **再実行に対する安全性**: コマンドパレットなどからテンプレートを再実行しても登録が二重にならないよう、登録は次の共通関数で行う。登録したハンドラは `window._custom…` に保持し、登録前に前回分を解除する。
  - `registerDocumentListener(key, types, handler)`: `document` のキャプチャ段階へ登録する（複数のイベント名を指定可）。登録順がそのまま実行順になる。
  - `registerWorkspaceEvent(key, name, handler)`: Obsidian のワークスペースイベント（`file-menu`、`editor-menu`、`file-open`、`tag-menu`）へ登録する。
  - `MutationObserver` / `ResizeObserver`: `disconnect()` → 再生成
  - MarkMind 用の `layout-change` / `active-leaf-change`: `offref` で前回分を解除してから登録
  - 他プラグイン・コマンドへのパッチ: パッチ済みフラグ（`_excalidrawPatched` など）で二重適用を防止
- **Obsidian モジュールの取得**: `getObsidianModule()` を使う。`require("obsidian")` を試し、失敗した場合は Templater が保持するモジュール（`app.plugins.plugins["templater-obsidian"].obsidian`）、`tp.obsidian`、`window.obsidian` の順に探す。
- **メニュー項目の並べ替え**: `reorderMenuItemsLater(menu, delay, { prepend: [...], afterRename: [...] })` で予約する。`prepend` は先頭へ（配列の後ろに書いた項目ほど上）、`afterRename` は「名前を変更」の直後へ移動する。メニューの種類によって実行方法が異なる。
  - DOM で描画されるメニュー（Windows / Linux、macOS でネイティブメニューを無効にした場合）: 描画を待って `delay` ミリ秒後に、表示文言で項目を探して DOM を並べ替える（`prependMenuItemsByText` / `insertAfterRenameOrPrepend`）。
  - ネイティブメニュー（macOS の既定）: 表示と同時に項目が確定し DOM の並べ替えは反映されないため、`menu.items` の順とセクションを直接書き換える（`reorderNativeMenuItems`）。予約はイベントハンドラの終了時（`withNativeMenuReorder`）または自前のメニューを表示する直前（`flushNativeMenuReorders`）に、`delay` の小さい順でまとめて実行する。表示前に `menu.sort()` を呼ぶと Obsidian 標準の項目の並びが変わるため、呼ばない。
  - どちらの方式でも、追加した項目の並びは同じになる。

### 1.1 ファイルの構成

処理の本体は、機能のまとまりごとに `80_script/register_custom_commands/` のファイルへ分けてある。

| ファイル | 内容 |
| :--- | :--- |
| `01_common_helpers.js` | 共通ヘルパー（Obsidianモジュール取得、リスナー登録、メニュー項目の並べ替え） |
| `02_external_apps.js` | 外部アプリ連携（Excalidraw Webアプリ、フォルダを開く、VS Code、差分表示） |
| `03_figure_embeds.js` | 図の埋め込み（キャプション、幅の追従、右下ドラッグのリサイズ、PDF埋め込みの端ドラッグのリサイズ、DOM監視の判定） |
| `04_clipboard_image_compare.js` | クリップボード画像との比較・差し替え、表示中の画像の更新 |
| `05_attachment_delete.js` | 添付ファイルの削除と、ノート内リンクの自動クリーンアップ |
| `06_note_list_links.js` | ノート一覧のリンクを右ペインで開く |
| `07_image_copy_menu.js` | 画像のクリップボードコピーと、画像向けメニュー項目 |
| `08_modals.js` | モーダル（サマリーの設定、HTML出力の設定、タグの一括変換） |
| `09_mail_parsing.js` | メール解析（MSG / TNEF） |
| `10_summary.js` | サマリー作成（ノート・メール・画像の収集と統合） |
| `11_from_clipboard.js` | From Clipboard（クリップボードの内容をMarkdownへ変換） |
| `12_moc_and_reload.js` | MOCファイルの移動、表示中のMarkdownとサイドバーの再読み込み |
| `13_commands.js` | コマンドの定義と登録（custom:…） |
| `14_embed_click_actions.js` | ノート内の画像・埋め込みのクリック操作（選択、ダブルクリック編集、右クリックメニュー） |
| `15_image_rename_compress_move.js` | 画像のリネーム・容量縮小・移動（モーダル）と、Rキーのショートカット |
| `16_command_guards_delete_key.js` | Excalidraw / MarkMind 編集中のコマンド抑止と、Deleteキーによるノート削除 |
| `17_file_menu.js` | ファイルメニュー（file-menu） |
| `18_file_manager_and_editor_menu.js` | ファイルマネージャー連携（リンク生成、コピーして同一フォルダーに保存）と、エディタメニュー（editor-menu） |
| `19_pdf_export_extension.js` | PDFエクスポートの拡張（保存先、モーダルの追加項目、Excalidrawデータを持つノートの出力） |
| `20_quote_shortcut.js` | 引用ショートカット（Cmd+. / Ctrl+.） |
| `21_toggle_sidebars.js` | 左右両サイドバーの表示・非表示一括切り替え（Option + B） |
| `22_markmind.js` | MarkMind プラグイン連携機能（非侵襲拡張） |
| `23_tags.js` | タグ（MOC作成、一括変換、ノート一覧） |
| `24_html_pdf_export.js` | HTML / PDF 出力（画像のインライン化、ExcalidrawのPNG化、出力用HTMLの生成） |
| `25_tag_menu_top_notes_drop.js` | タグメニュー、topタグ付きノートの自動更新、ファイルマネージャーからのドロップ |

- **連結して実行する**: 読み込み役が `CUSTOM_COMMAND_SCRIPT_FILES` の順に全ファイルを読み、改行でつないで1つの関数として実行する。そのため、ファイルをまたいで関数・定数をそのまま参照できる（`import` / `export` は書かない）。同じ名前を2つのファイルで宣言すると、スクリプト全体が構文エラーになり何も登録されない。
- **宣言の順序**: 行頭で実行される処理（リスナーの登録、クラスの `extends` など）は、参照する宣言より後ろのファイル・行に置く。関数の中から参照するだけなら順序は問わない。
- **新しい機能を追加するとき**: 該当するファイルへ追加する。ファイルを追加・改名した場合は、読み込み役の `CUSTOM_COMMAND_SCRIPT_FILES` と冒頭コメントの一覧も直す（一覧とフォルダの内容が食い違うと `scratch/test_template_structure.js` が失敗する）。
- **Templater のテンプレートフォルダに置かない理由**: `00_templates/` に置いたファイルは、種類を問わず Templater のテンプレート選択に表示されるため。
- **読み込みに失敗した場合**: どのファイルを読めなかったか（または実行時のエラー内容）を通知に表示し、何も登録せずに終了する。
- **エラーの行番号**: 開発者ツールには、連結後のスクリプト `RegisterCustomCommands.js` の行番号で表示される。`node scratch/lib/templateHarness.js <行番号>` で、どのファイルの何行目かを調べられる。
- **構文の確認**: `node scratch/check_syntax.js`。
- **設定の同期**: `80_script/register_custom_commands` は [copy_settings.py の同期対象](copy_settings_sync.md) に含めてある。

## 2. コマンド

コマンドパレットに `Templater: <名前>` として登録される（ID は `custom:…`）。ショートカットは `.obsidian/hotkeys.json` の設定（`Mod` は Mac の Cmd / Windows の Ctrl）。

| ID | 名前 | 動作 | ショートカット | 仕様書 |
| :--- | :--- | :--- | :--- | :--- |
| `custom:from-clipboard` | From Clipboard | クリップボードの内容を Markdown へ変換して挿入（表・コードブロック・リンク） | （スラッシュコマンド） | [from_clipboard_custom_text.md](from_clipboard_custom_text.md) |
| `custom:callout-important` / `-warning` / `-danger` / `-note` | Callout … | コールアウトの雛形を挿入し、本文部分を選択 | （スラッシュコマンド） | [callout_and_quote_shortcuts.md](callout_and_quote_shortcuts.md) |
| `custom:add-drawio-diagram` | drawioの図の追加 | drawio の図を新規作成して埋め込む | （スラッシュコマンド） | [add_drawio_diagram.md](add_drawio_diagram.md) |
| `custom:new-note-with-current-tags` | 現在のタグで新しいノートを追加 | 開いているノートのタグ（topは除く）を付けた新規ノートを今日のフォルダに作り、右の分割に開く | `Mod+Shift+N` | 本書 |
| `custom:insert-datetime` | Insert Date and Time | 現在日時を `YYYY-MM-DD HH:mm:ss` 形式で挿入 | なし | 本書 6章 |
| `custom:rename-active-file` | Rename Active File | アクティブなファイルのリネームモーダルを開く | `Mod+R` | [image_rename_spec.md](image_rename_spec.md) |
| `custom:delete-active-file` | Delete Active File | アクティブなファイルと関連添付を確認のうえゴミ箱へ移動 | `Delete`（グローバルリスナー） | [delete_command_spec.md](delete_command_spec.md) |
| `custom:smart-focus-right` / `-left` | Smart Focus Right / Left | ペインが1つなら縦分割し、2つ以上なら右 / 左のペインへフォーカスを移動 | `Mod+Shift+→` / `Mod+Shift+←` | 本書 6章 |
| `custom:open-containing-folder` | フォルダを開く (Finder/Explorer) | アクティブなファイルの親フォルダを OS のファイルマネージャーで開く | なし | [open_folder_and_vscode_menu_spec.md](open_folder_and_vscode_menu_spec.md) |
| `custom:open-in-vscode` | VS Codeで開く | アクティブなファイルを VS Code で開く | なし | 同上 |
| `custom:open-folder-in-browser` | Open Folder in Browser | アクティブなファイルの親フォルダを `http://localhost:5001/view/obsidian-dagnetz/<フォルダ>` で開く（保管庫名は固定値） | `Mod+Shift+L` | 本書 6章 |
| `custom:reload-displayed-markdown-and-sidebars` | 表示中のMarkdownとサイドバーを再読み込み | アクティブな Markdown を表示中の全ペインで開き直し、Sidebar Explorer の重要度・画像パスの索引とサイドバー表示を更新 | `Mod+Shift+R` | 本書 6章 |
| `custom:move-moc-files` | MOCファイルを移動 | MOC ファイルを所定のフォルダへ移動 | なし | [move_moc_files.md](move_moc_files.md) |
| `custom:toggle-mindmap-basic` | Toggle Mindmap (Basic) | `mindmap-plugin: basic` を付与してマインドマップ表示と Markdown 表示を切り替え | `Option+M` / `Alt+M`（グローバルリスナー） | [markmind_features_spec.md](markmind_features_spec.md) |
| `custom:toggle-both-sidebars` | 左右両方のサイドバー表示/非表示を切り替え | 左右のサイドバーを一括で開閉 | `Option+B` / `Alt+B`（グローバルリスナー） | [toggle_both_sidebars_spec.md](toggle_both_sidebars_spec.md) |

Excalidraw / MarkMind の編集中は、次のコマンドを実行しないようコールバックをパッチしている（[excalidraw_key_intercept_spec.md](excalidraw_key_intercept_spec.md)）:
`workspace:previous-tab`、`workspace:next-tab`、`file-explorer:delete-file`、`app:delete-file`、`custom:delete-active-file`、`custom:smart-focus-right`、`custom:smart-focus-left`、`custom:rename-active-file`。

## 3. 右クリックメニュー

| メニュー | 項目 | 対象 | 仕様書 |
| :--- | :--- | :--- | :--- |
| ファイルメニュー（`file-menu`） | 今日のフォルダに移動 | すべてのファイル | [move_to_today_folder_spec.md](move_to_today_folder_spec.md) |
| | Webアプリで開く | `.excalidraw.md`（`http://localhost:3001/?filepath=…`） | [../AGENTS.md](../AGENTS.md) |
| | Webアプリで編集 | Excalidraw のデータを持つ通常の `.md` | 本書 6章 |
| | フォルダを開く / VS Codeで開く | Markdown | [open_folder_and_vscode_menu_spec.md](open_folder_and_vscode_menu_spec.md) |
| | 差分を表示 | Markdown（差分表示アプリ `127.0.0.1:8078` で Git 差分を開く） | 本書 6章 |
| | HTMLで出力(AIコンテキスト用) / HTMLで出力(人間用) / PDFで出力(人間用) | Markdown | [pdf_export_from_html.md](pdf_export_from_html.md)、[export_path_temp.md](export_path_temp.md) |
| | サマリーを作成 | Markdown | [create_summary.md](create_summary.md) |
| | 添付ファイルを削除 | 画像・drawio 以外の非 Markdown ファイル | [attachment_delete_link_cleanup_spec.md](attachment_delete_link_cleanup_spec.md) |
| | 保管庫からのパスをコピー | 画像、drawio | [base_card_contextmenu_spec.md](base_card_contextmenu_spec.md) |
| | 画像をクリップボードにコピー / 画像の容量を縮小 / 削除 / 共通画像フォルダへ移動 / クリップボードの画像との比較 / クリップボードの画像と差し替え / drawioで編集 | 画像、drawio | [image_compress_spec.md](image_compress_spec.md)、[image_delete_menu.md](image_delete_menu.md)、[move_to_common_image_spec.md](move_to_common_image_spec.md)、[drawio_edit_menu.md](drawio_edit_menu.md) |
| エディタメニュー（`editor-menu`） | フォルダを開く / VS Codeで開く / HTML・PDF出力 / サマリーを作成 | 編集中の Markdown | 上記と同じ |
| | 添付ファイルを削除 | カーソル位置が内部リンク上にある場合 | [attachment_delete_link_cleanup_spec.md](attachment_delete_link_cleanup_spec.md) |
| | コピーして同一フォルダーに保存 | カーソル位置がファイルマネージャーのリンク（`localhost:8001/api/open-path`）上にある場合 | [file_manager_dnd_and_copy_spec.md](file_manager_dnd_and_copy_spec.md) |
| ノート内の画像（`contextmenu`） | 画像向けの項目一式 | 編集・閲覧ビューの画像 | [image_delete_menu.md](image_delete_menu.md) |
| ノート内の内部リンク（`contextmenu`） | 添付ファイルを削除 | 編集・閲覧ビューの内部リンク | [attachment_delete_link_cleanup_spec.md](attachment_delete_link_cleanup_spec.md) |
| ノート内のファイルマネージャーリンク（`contextmenu`） | コピーして同一フォルダーに保存 | 閲覧ビューのリンク | [file_manager_dnd_and_copy_spec.md](file_manager_dnd_and_copy_spec.md) |
| タグメニュー（`tag-menu`） | MOCを作成 / ノート一覧を追加 / 一括変換 | タグ | [tag_moc_spec.md](tag_moc_spec.md)、[tag_note_list_spec.md](tag_note_list_spec.md)、[tag_bulk_rename.md](tag_bulk_rename.md) |

追加した項目は、表示文言で探して上部（または「名前を変更」の直後）へ並べ替えている。macOS のネイティブメニューと DOM のメニューの両方に対応している（1章「メニュー項目の並べ替え」）。Obsidian の文言変更の影響を受けやすい点に注意する。

## 4. 常駐リスナー

いずれも `document` のキャプチャ段階、または Obsidian のイベントに登録される。

| 種類 | 契機 | 動作 | 仕様書 |
| :--- | :--- | :--- | :--- |
| キー | `Delete` | ノート削除コマンドを実行（入力中、モーダル、タグペイン、ファイルエクスプローラー、Excalidraw / MarkMind 編集中、CAD Viewer へのフォーカス時は横取りしない） | [delete_command_spec.md](delete_command_spec.md) |
| キー | `R`（修飾キーなし） | 選択中の画像のリネームモーダルを開く | [image_rename_spec.md](image_rename_spec.md) |
| キー | `Cmd+.` / `Ctrl+.` | Markdown エディタで引用（`>`）を切り替え | [callout_and_quote_shortcuts.md](callout_and_quote_shortcuts.md) |
| キー | `Option+B` / `Alt+B` | 左右のサイドバーを一括開閉 | [toggle_both_sidebars_spec.md](toggle_both_sidebars_spec.md) |
| キー | `Option+M` / `Alt+M` | マインドマップ表示の切り替え | [markmind_features_spec.md](markmind_features_spec.md) |
| マウス | 画像のクリック / ダブルクリック / 押下 | 画像の選択枠表示、drawio・Excalidraw 埋め込みのダブルクリック編集 | [drawio_double_click.md](drawio_double_click.md)、[excalidraw_embed_dblclick.md](excalidraw_embed_dblclick.md) |
| マウス | Excalidraw 埋め込み上の押下 | 意図しない編集・遷移を防ぐ（リサイズハンドル上は対象外） | [image_drag_resize_spec.md](image_drag_resize_spec.md) |
| マウス | 中ボタンの押下 | マインドマップを掴んで移動 | [markmind_features_spec.md](markmind_features_spec.md) |
| マウス | クリック | `03_Dataview/topタグ付きノート一覧.md` の内部リンクを右ペインで開く | [top_notes_list_spec.md](top_notes_list_spec.md) |
| ドロップ | ファイルマネージャーからのドロップ | `localhost:8001` の open-path リンクを挿入 | [file_manager_dnd_and_copy_spec.md](file_manager_dnd_and_copy_spec.md) |
| DOM監視 | 図の埋め込みの追加・変更 | 図名キャプション、幅の追従、リサイズハンドルの付与（PDF埋め込みは右端・下端・右下隅）、図の後ろの余白調整 | [image_drag_resize_spec.md](image_drag_resize_spec.md)、[image_zoom_and_resize_spec.md](image_zoom_and_resize_spec.md)、[pdf_embed_resize_spec.md](pdf_embed_resize_spec.md) |
| DOM監視 | PDF エクスポートのモーダル表示 | 「コードブロックの背景」「保存先パスをクリップボードへコピー」の切り替えを追加 | [export_path_temp.md](export_path_temp.md)、本書 6章 |
| Obsidian | `file-open` | `top` タグ付きノートのノート一覧を自動更新 | [top_note_list_open_spec.md](top_note_list_open_spec.md) |
| Obsidian | `layout-change` / `active-leaf-change` | MarkMind のビューへ Excalidraw データ保護のパッチを適用 | [markmind_features_spec.md](markmind_features_spec.md) |

## 5. 連携先

### 外部サービス（ローカルで別途起動しているもの）

| 接続先 | 用途 |
| :--- | :--- |
| `http://localhost:3001/?filepath=…` | Excalidraw の Web アプリ（Webアプリで開く / 編集） |
| `http://localhost:5001/view/obsidian-dagnetz/…` | フォルダのブラウザ表示（Open Folder in Browser） |
| `http://localhost:8001/api/open-path?path=…` | ファイルマネージャー Web アプリ（ドロップ連携、From Clipboard のパス貼り付け） |
| `http://127.0.0.1:8078/` と `/api` | 画像比較・差分表示アプリ（クリップボード画像との比較、Markdown の差分表示） |

### 他プラグインへの依存

| プラグイン | 連携内容 |
| :--- | :--- |
| `templater-obsidian` | スクリプトの実行、Obsidian モジュールの取得 |
| `obsidian-excalidraw-plugin` | Excalidraw ファイルの判定、図の PNG 出力 |
| `obsidian-markmind` | ビューとポストプロセッサへのパッチ（プラグイン本体は変更しない） |
| `obsidian-sidebar-explorer` | VS Code の実行ファイルパス設定、索引の再生成 |
| `obsidian-sidebar-explorer-tag` | MSG パーサーの共有（後述） |

### グローバル公開（`window`）

| 名前 | 用途 | 利用側 |
| :--- | :--- | :--- |
| `window.createSummary` / `window.SummaryDepthModal` | サマリー作成 | `obsidian-sidebar-explorer-tag` |
| `window.parseMsgFile` | MSG ファイルの解析。`obsidian-sidebar-explorer-tag` が公開する `window._sidebarExplorerParseMsgFile` と同じ関数（未公開の場合はテンプレートの `parseMsgFile`） | サマリー作成 |
| `window._sidebarExplorerParseMsgFile` / `window._sidebarExplorerParseTnefFile` / `window._sidebarExplorerMailHelpers` | `obsidian-sidebar-explorer-tag` が公開する MSG / TNEF（winmail.dat）の解析関数と、本文の変換ヘルパー（表のMarkdown変換、RTF抽出）（`mailGlobals.ts` / `mailHelpers.ts`）。テンプレートはメール解析を自前で持たず、これらを呼び出す。プラグインが動いていない場合、メールは展開されず、通知と「解析に失敗」の案内だけがサマリーに入る | テンプレート（サマリー作成） |
| `window._customPromptForFileRename` | リネームモーダル | `obsidian-sidebar-explorer`、`obsidian-sidebar-explorer-tag` |
| `window._openNoteListLinkInRightPane` | ノート一覧のリンクを右ペインで開く | `obsidian-sidebar-explorer-tag` |
| `window._sidebarExplorerTagUpdateNoteList` | `obsidian-sidebar-explorer-tag` が公開する「# note一覧」の追加・更新（`noteListUpdater.ts`）。テンプレートは一覧の生成を持たず、タグの右クリックメニューと `top` ノートを開いたときの自動更新からこれを呼ぶ。プラグインが無効な場合、一覧は更新されない | テンプレート（ノート一覧） |
| `window.toggleBothSidebars` / `window.toggleMindmapBasic` / `window.stripExcalidrawSection` / `window.patchMarkMindViewForExcalidraw` | 各機能の外部呼び出し・テスト用 | — |

### 設定の保存（`localStorage`）

| キー | 内容 |
| :--- | :--- |
| `customPdfCodeBlockBackgroundEnabled` | PDF 出力時にコードブロックの背景を付けるか（既定: 有効） |
| `customPdfExportPathToClipboardEnabled` | PDF 出力後に保存先パスをクリップボードへコピーするか（既定: 有効） |

## 6. 個別の仕様書が無い機能

以下は専用の仕様書が無いため、ここに動作をまとめる。

### Insert Date and Time（`custom:insert-datetime`）
選択範囲（またはカーソル位置）を、現在日時の文字列 `YYYY-MM-DD HH:mm:ss`（ローカル時刻、各桁ゼロ埋め）で置き換える。

### Smart Focus Right / Left（`custom:smart-focus-right` / `-left`）
- ルート分割内のタブグループ（ペイン）の数を数える。
- 1つ以下の場合は `workspace:split-vertical` を実行して縦に分割する。
- 2つ以上の場合は `editor:focus-right` / `editor:focus-left` を実行して隣のペインへ移動する。

### Open Folder in Browser（`custom:open-folder-in-browser`）
アクティブなファイルの親フォルダ（保管庫からの相対パス）を `http://localhost:5001/view/obsidian-dagnetz/<フォルダ>` として既定のブラウザで開く。URL 内の保管庫名 `obsidian-dagnetz` は固定値。アクティブなファイルが無い場合は Notice を表示する。

### 表示中のMarkdownとサイドバーを再読み込み（`custom:reload-displayed-markdown-and-sidebars`）
1. アクティブなファイルが Markdown の場合、そのファイルを表示している全ペインで開き直し、表示内容を揃える。
2. Sidebar Explorer の重要度データと画像パスの索引（`image_paths.json`）を再生成する。
3. サイドバーの各ビューを再描画する。

### Webアプリで編集（ファイルメニュー）
ファイル名は `.excalidraw.md` ではないが、Excalidraw のデータを持つ Markdown（フロントマターに `excalidraw-plugin` がある、または Excalidraw プラグインが Excalidraw ファイルと判定するもの）に表示する。「Webアプリで開く」と同じ URL（`http://localhost:3001/?filepath=<絶対パス>`）を開く。

### 差分を表示（ファイルメニュー）
Markdown（`.excalidraw.md` を除く）の絶対パスを差分表示アプリへ送り（`POST http://127.0.0.1:8078/api/git/markdown`、未対応の旧バージョンには `GET …?path=` で再試行）、返ってきた差分画面の URL をブラウザで開く。失敗時は Notice を表示する。

### 画像をクリップボードにコピー / クリップボードの画像との比較 / クリップボードの画像と差し替え
- **画像をクリップボードにコピー**: 画像（Excalidraw は PNG に変換）を PNG としてクリップボードへコピーする。
- **クリップボードの画像との比較**: 対象の画像とクリップボードの画像を画像比較アプリ（`POST http://127.0.0.1:8078/api/diff`、カテゴリ「汎用」、差分しきい値 0.1）へ送り、結果画面をブラウザで開く。アプリが起動していない場合は Notice を表示して中断する。
- **クリップボードの画像と差し替え**: 確認ダイアログの後、クリップボードの画像を対象ファイルの形式へ変換して上書きし、表示中の画像を更新する。`.excalidraw.md` には表示しない。

### PDF エクスポートのモーダルへの追加項目
Obsidian 標準の「PDFにエクスポート」モーダルに、次の2つの切り替えを追加する。設定は `localStorage` に保存する。
- **コードブロックの背景**: 無効にすると `body` に `pdf-code-block-bg-disabled` クラスを付け、`pdf-export-fix.css` がコードブロックの背景を消す。
- **保存先パスをクリップボードへコピー**: 有効な場合、出力後に PDF の保存先パスをクリップボードへコピーする。

モーダルの検出は `document.body` の `MutationObserver` で行い、モーダルが追加された場合だけ処理する（通常の DOM 変更では祖先探索を行わない）。

### 図のキャプションと余白
- 画像・Excalidraw の埋め込みに、拡張子を除いた図の名前をキャプション（`.custom-figure-caption`）として表示する。同じ図に重複したキャプションは1つにまとめる。
- 図の後ろに続く空行の数（1〜8行）に応じて、図の下の余白（`--figure-after-gap`）を調整する。
- 図の幅（`--figure-width`）を `ResizeObserver` と `MutationObserver` で追従する。再走査の条件は [image_zoom_and_resize_spec.md](image_zoom_and_resize_spec.md) を参照。
- 図の幅を変えたとき（ドラッグ・Option+ホイール）に図が幅0へ潰れて消えないよう、SVG の幅は `%` ではなく px で指定し、表示幅が0になった図は `width` 属性の値で復旧する（Windows で発生）。
- ノート内の内部リンクを Cmd（Windows/Linux は Ctrl）+ クリックすると、隣のペインで開く（`handleLinkModifierClick`、右ペインが無ければ縦分割して作る）。
- ノート内の Excalidraw 図（`.excalidraw.md` と Excalidraw データを持つ通常の `.md`）の右クリックメニューに「Webアプリで編集」を追加する。

## 7. 既知の構造上の課題

- スクリプトは25ファイルに分けてあるが、連結して1つのスコープで実行する作りのため、ファイル間の依存は宣言名だけで結び付いている（モジュールとしての `import` / `export` は無い）。テストは共通ハーネス（[testing.md](testing.md)）で宣言単位に取り出して実行する。
- 150行前後の関数がまだ残っている（`createSummary`、`handleFileMenu`、`convertHtmlToPdf`、`handleEditorMenu` など）。変更するときに、手順ごとの関数へ分けていく。
- クリップボードの内容をリンクへ変換する処理（`buildMarkdownLink`）は、ホットキー用のテンプレート `00_templates/From Clipboard.md` にも同じ実装がある。変更するときは両方を直し、`scratch/test_from_clipboard.js` を通すこと。
- メール（MSG / TNEF）の解析と本文の変換は `obsidian-sidebar-explorer-tag` に一本化してあり、テンプレートは公開された関数を呼び出すだけ（以前はテンプレートにも互換パーサーと同じ変換処理があった）。サマリー作成でメールを展開するには、このプラグインが有効である必要がある。
- メニュー項目の並べ替えは、表示文言の一致に依存している。
- 「# note一覧」の作成は `obsidian-sidebar-explorer-tag` に一本化してあり、テンプレートは公開された関数を呼び出すだけ（以前はテンプレートにも同じ処理があり、対象フォルダの制限が無かったため `10_summary` のサマリーまで一覧に入っていた）。
- `shouldMoveToMoc`、`isExcalidrawBackedMarkdown` は、テンプレートとサイドバー系プラグインの両方に実装がある。変更するときは両方を直し、`scratch/test_template_plugin_parity.js` を通すこと。
