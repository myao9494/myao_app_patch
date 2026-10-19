<!--
/**
 * 仕様: docs フォルダの索引
 *
 * 1. 自作コードの所在（プラグイン・テンプレート・CSS・スクリプト）
 * 2. 機能別の仕様書一覧
 * 3. 現在は使っていない機能の文書
 **/
-->
# ドキュメント索引

この保管庫の Obsidian カスタマイズ（自作プラグイン、Templater スクリプト、CSS スニペット、補助スクリプト）の仕様書の一覧。
仕様書と実装が食い違っている場合は実装を正とし、仕様書を修正する。

- 各仕様書と同名の `*.excalidraw.md` は、その仕様の構成図・フロー図。
- テストの実行方法は [testing.md](testing.md)。

## 1. 自作コードの所在

| 種別 | 場所 | 概要 |
| :--- | :--- | :--- |
| Templater 起動スクリプト | `00_templates/RegisterCustomCommands.md`（読み込み役）<br>`80_script/register_custom_commands/NN_*.js`（処理の本体） | コマンド、右クリックメニュー、ショートカット、常駐リスナーをまとめて登録する。一覧と構成は [custom_commands_reference.md](custom_commands_reference.md) |
| プラグイン CAD Viewer | `.obsidian/plugins/cad-viewer/` | STEP / FreeCAD / OBJ / STL の3Dビューア（公開プラグイン STEP Viewer の独自改造版） |
| プラグイン Sidebar Explorer | `.obsidian/plugins/obsidian-sidebar-explorer/` | 今日のフォルダ、関連ファイル、最近開いたファイルなどを表示するサイドバー |
| プラグイン Sidebar Explorer Tag | `.obsidian/plugins/obsidian-sidebar-explorer-tag/` | タグ検索・MOC・サマリー用のサイドバー、MSG / TNEF メールの解析 |
| プラグイン 画像一覧（Excalidraw Cards） | `.obsidian/plugins/obsidian-excalidraw-cards/` | 画像・Excalidraw・drawio のカード一覧 |
| プラグイン（ソースなし・`main.js` のみ） | `.obsidian/plugins/touchpad-swipe-nav/`、`.obsidian/plugins/excalidraw-convert-template/` | タッチパッドのスワイプによるタブ移動、Excalidraw 変換テンプレート |
| CSS スニペット | `.obsidian/snippets/` | 図の幅・表・ボタン・見出しなどの見た目 |
| 補助スクリプト | `80_script/`、`90_batch/` | 設定の同期、Git の強制同期、変換バッチ |
| テスト | 各プラグインのフォルダ、`scratch/test_*.js` | [testing.md](testing.md) |

上記以外の `.obsidian/plugins/` 配下はコミュニティプラグインで、本体は変更しない（MarkMind などへの拡張はテンプレート側のパッチで行う）。

## 2. 機能別の仕様書

### テンプレート全体
- [custom_commands_reference.md](custom_commands_reference.md) — 登録している全機能の一覧（コマンド・メニュー・リスナー・連携先）
- [startup_performance_optimization.md](startup_performance_optimization.md) — 起動速度の改善
- [slash_commands_order.md](slash_commands_order.md) — スラッシュコマンドの並び順
- [path_compatibility.md](path_compatibility.md) / [path_replacement_spec.md](path_replacement_spec.md) — Windows / macOS のパス互換、パス・サーバー名の自動置換
- [code_review_custom_plugins_2026-06-25.md](code_review_custom_plugins_2026-06-25.md) — 2026-06-25 のコードレビュー記録

### 画像・図の埋め込み
- [image_drag_resize_spec.md](image_drag_resize_spec.md) — 右下ドラッグによる拡大縮小と本文への保存
- [pdf_embed_resize_spec.md](pdf_embed_resize_spec.md) — PDF埋め込みの端をドラッグして幅・高さを変え、リンクへ保存
- [image_zoom_and_resize_spec.md](image_zoom_and_resize_spec.md) — ホイール拡大との共存、幅の追従、DOM 監視の条件
- [image_rename_spec.md](image_rename_spec.md) — `R` キーによるリネームとモーダルのドラッグ移動
- [image_compress_spec.md](image_compress_spec.md) — 画像の容量を縮小
- [image_delete_menu.md](image_delete_menu.md) — 画像の右クリックメニュー「削除」
- [base_card_contextmenu_spec.md](base_card_contextmenu_spec.md) — 画像の右クリックメニュー「保管庫からのパスをコピー」
- [move_to_common_image_spec.md](move_to_common_image_spec.md) / [move_to_today_folder_spec.md](move_to_today_folder_spec.md) — 共通画像フォルダ・今日のフォルダへの移動

### Excalidraw・drawio・MarkMind
- [excalidraw_embed_dblclick.md](excalidraw_embed_dblclick.md) — 埋め込みのダブルクリックでビュー切り替え
- [excalidraw_key_intercept_spec.md](excalidraw_key_intercept_spec.md) — 編集中の Obsidian コマンド無効化
- [excalidraw_repair.md](excalidraw_repair.md) — 破損した Excalidraw ファイルの修復
- [add_drawio_diagram.md](add_drawio_diagram.md) / [drawio_edit_menu.md](drawio_edit_menu.md) / [drawio_double_click.md](drawio_double_click.md) / [drawio_setup.md](drawio_setup.md) — drawio の図の追加・編集・セットアップ
- [markmind_features_spec.md](markmind_features_spec.md) — MarkMind の拡張（Option+M、Delete 制御、パン操作、Excalidraw との共存）

### ファイル操作・出力
- [delete_command_spec.md](delete_command_spec.md) — Delete キーによるノート削除と関連添付の一括削除
- [attachment_delete_link_cleanup_spec.md](attachment_delete_link_cleanup_spec.md) — 添付ファイル削除時のリンク自動削除
- [open_folder_and_vscode_menu_spec.md](open_folder_and_vscode_menu_spec.md) — フォルダを開く / VS Codeで開く
- [file_manager_dnd_and_copy_spec.md](file_manager_dnd_and_copy_spec.md) — ファイルマネージャーからのドロップ、コピーして同一フォルダーに保存
- [from_clipboard_custom_text.md](from_clipboard_custom_text.md) — クリップボードからの貼り付け
- [callout_and_quote_shortcuts.md](callout_and_quote_shortcuts.md) — コールアウト、引用ショートカット
- [toggle_both_sidebars_spec.md](toggle_both_sidebars_spec.md) — 左右サイドバーの一括開閉（Option+B）
- [pdf_export_from_html.md](pdf_export_from_html.md) / [export_path_temp.md](export_path_temp.md) / [pandoc_docx_conversion.md](pandoc_docx_conversion.md) — PDF・HTML・Word への出力

### サマリー・メール
- [create_summary.md](create_summary.md) — 複数ノートのサマリー作成
- [msg_summary_sanitization_spec.md](msg_summary_sanitization_spec.md) — Outlook メール（MSG）本文のサニタイズ
- [msg_encoding_and_table_spec.md](msg_encoding_and_table_spec.md) / [email_table_to_markdown_spec.md](email_table_to_markdown_spec.md) — 文字化け防止、表の Markdown 変換
- [tnef_and_rtf_support_spec.md](tnef_and_rtf_support_spec.md) — RTF メール、TNEF（winmail.dat）

### タグ・MOC・ノート一覧
- [tag_moc_spec.md](tag_moc_spec.md) / [tag_note_list_spec.md](tag_note_list_spec.md) / [tag_bulk_rename.md](tag_bulk_rename.md) / [tag_copypaste.md](tag_copypaste.md) — タグからの MOC 作成、ノート一覧、一括置換、コピペ
- [move_moc_files.md](move_moc_files.md) — MOC ファイルの自動移動
- [top_notes_list_spec.md](top_notes_list_spec.md) / [top_note_list_open_spec.md](top_note_list_open_spec.md) — top タグ付きノート一覧
- [management_note_cleanup_spec.md](management_note_cleanup_spec.md) / [management_note_cleanup_diagram.excalidraw.md](management_note_cleanup_diagram.excalidraw.md) — マネジメントメモの改行クリーンアップ、可読性向上およびタグ最適化

### CAD Viewer
- [cad_viewer_spec.md](cad_viewer_spec.md) — 機能仕様、データの保存先、ソース構成、テスト

### Sidebar Explorer / Sidebar Explorer Tag
- [Sidebar_Explorer.md](Sidebar_Explorer.md) — 現行の構成メモ
- [active_file_folder_section_spec.md](active_file_folder_section_spec.md) / [sidebar_new_sections.md](sidebar_new_sections.md) — 「開いているファイルのフォルダ」「データビュー」「common prompt」セクション
- [folder_header_context_menu_spec.md](folder_header_context_menu_spec.md) — フォルダヘッダーの右クリックメニュー
- [sidebar_trash_spec.md](sidebar_trash_spec.md) — ゴミ箱を開くボタン
- [sidebar_explorer_tag.md](sidebar_explorer_tag.md) — Sidebar Explorer Tag

### 画像一覧（Excalidraw Cards）
- [excalidraw_cards.md](excalidraw_cards.md) — プラグインの構成と画像キャッシュ
- [image_excalidraw_integration.md](image_excalidraw_integration.md) — Excalidraw と画像のカードビュー統合
- [excalidraw_filter_and_size.md](excalidraw_filter_and_size.md) — フィルターとカードサイズ
- [image_gallery_delete_and_style_fix.md](image_gallery_delete_and_style_fix.md) — 削除の即時反映、タブの視認性

### 見た目（CSS スニペット・表示設定）
- [table_header_style.md](table_header_style.md) — 表のヘッダー、リスト配下の表
- [button_accent_style.md](button_accent_style.md) — ボタンの「黄色座布団＋黒文字」
- [bold_styling.md](bold_styling.md) / [heading_spacing.md](heading_spacing.md) / [strict_line_breaks.md](strict_line_breaks.md) — 太字、見出しの余白、改行の維持

### 補助スクリプト・環境
- [copy_settings_sync.md](copy_settings_sync.md) — 設定の完全ミラー同期（`80_script/copy_settings.py`）
- [git_sync_scripts.md](git_sync_scripts.md) — Git の強制同期（`90_batch/`）
- [view_maintenance_tools.md](view_maintenance_tools.md) — 重複ファイル・空フォルダーの管理
- [claude.md](claude.md) — ターミナルプラグインの設定、macOS の localhost リンク書き換え、サイドバーのショートカットに関するメモ
- [twohop_links_plus_fix.md](twohop_links_plus_fix.md) — 2hop-links-plus の自動非表示バグの修正
- [windows_boot_troubleshooting.md](windows_boot_troubleshooting.md) — Windows の起動遅延の調査手順

### AI エージェント・スキル
- [ai_skills_setup.md](ai_skills_setup.md) / [skill_request_template.md](skill_request_template.md) — AI エージェント用の初期設定、スキル依頼テンプレート
- [note-structurer_skill.md](note-structurer_skill.md) / [tag_organizer_skill.md](tag_organizer_skill.md) — スキルの説明

### ノート内容に関する文書（カスタマイズの仕様ではないもの）
- [money_game_prompt_update.md](money_game_prompt_update.md)、[warrant_explanation.md](warrant_explanation.md)

## 3. 現在は使っていない機能の文書

| 文書 | 状態 |
| :--- | :--- |
| [data_cards_bases.md](data_cards_bases.md) | Bases によるカードビュー。`02_view/*.base` は削除済みで、画像一覧プラグインへ置き換えた |
| [image-zoom-bugfix.md](image-zoom-bugfix.md) | ローカル改造版 `mousewheel-image-zoom-local` の修正記録。コミュニティ版 `mousewheel-image-zoom` へ置き換え済み |
