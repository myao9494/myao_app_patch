<%*
/**
 * カスタムコマンドおよびグローバルイベントハンドラーを登録するスクリプト（読み込み役）
 *
 * Templater の起動時テンプレートとして Obsidian 起動時に1回実行される。
 * 処理の本体は 80_script/register_custom_commands/ にセクションごとのファイルとして置いてあり、
 * このテンプレートはそれらを下記の順に連結して、1つのスクリプトとして実行する
 * （連結して実行するため、ファイルをまたいで関数・定数を参照できる。同じ名前は2回宣言できない）。
 * 再実行しても登録が二重にならないよう、登録済みのリスナーは window._custom… に保持し、登録前に前回分を解除する。
 *
 * 登録している全機能の一覧（コマンド・メニュー・常駐リスナー・連携先）: docs/custom_commands_reference.md
 * テスト方法（scratch/lib/templateHarness.js で宣言単位に読み込む）: docs/testing.md
 *
 * 構成（80_script/register_custom_commands/ のファイル。下の CUSTOM_COMMAND_SCRIPT_FILES と同じ順）:
 *   01_common_helpers.js                共通ヘルパー（Obsidianモジュール取得、リスナー登録、メニュー項目の並べ替え）
 *   02_external_apps.js                 外部アプリ連携（Excalidraw Webアプリ、フォルダを開く、VS Code、差分表示）
 *   03_figure_embeds.js                 図の埋め込み（キャプション、幅の追従、右下ドラッグのリサイズ、DOM監視の判定）
 *   04_clipboard_image_compare.js       クリップボード画像との比較・差し替え、表示中の画像の更新
 *   05_attachment_delete.js             添付ファイルの削除と、ノート内リンクの自動クリーンアップ
 *   06_note_list_links.js               ノート一覧のリンクを右ペインで開く
 *   07_image_copy_menu.js               画像のクリップボードコピーと、画像向けメニュー項目
 *   08_modals.js                        モーダル（サマリーの設定、HTML出力の設定、タグの一括変換）
 *   09_mail_parsing.js                  メール解析（MSG / TNEF）
 *   10_summary.js                       サマリー作成（ノート・メール・画像の収集と統合）
 *   11_from_clipboard.js                From Clipboard（クリップボードの内容をMarkdownへ変換）
 *   12_moc_and_reload.js                MOCファイルの移動、表示中のMarkdownとサイドバーの再読み込み
 *   13_commands.js                      コマンドの定義と登録（custom:…）
 *   14_embed_click_actions.js           ノート内の画像・埋め込みのクリック操作（選択、ダブルクリック編集、右クリックメニュー）
 *   15_image_rename_compress_move.js    画像のリネーム・容量縮小・移動（モーダル）と、Rキーのショートカット
 *   16_command_guards_delete_key.js     Excalidraw / MarkMind 編集中のコマンド抑止と、Deleteキーによるノート削除
 *   17_file_menu.js                     ファイルメニュー（file-menu）
 *   18_file_manager_and_editor_menu.js  ファイルマネージャー連携（リンク生成、コピーして同一フォルダーに保存）と、エディタメニュー（editor-menu）
 *   19_pdf_export_extension.js          PDFエクスポートの拡張（保存先、モーダルの追加項目、Excalidrawデータを持つノートの出力）
 *   20_quote_shortcut.js                引用ショートカット（Cmd+. / Ctrl+.）
 *   21_toggle_sidebars.js               左右両サイドバーの表示・非表示一括切り替え（Option + B）
 *   22_markmind.js                      MarkMind プラグイン連携機能（非侵襲拡張）
 *   23_tags.js                          タグ（MOC作成、一括変換、ノート一覧）
 *   24_html_pdf_export.js               HTML / PDF 出力（画像のインライン化、ExcalidrawのPNG化、出力用HTMLの生成）
 *   25_tag_menu_top_notes_drop.js       タグメニュー、topタグ付きノートの自動更新、ファイルマネージャーからのドロップ
 *   26_gantt_task.js                    ganttに追加（ノートを gantt のタスクにし、ファイル名へタスクIDを付ける）
 *   27_drawio_to_excalidraw.js          draw.io の図を Excalidraw の図（図形ごとに編集できる .excalidraw.md）へ変換
 *
 * 主な機能:
 * - From Clipboard: クリップボードの内容をMarkdownへ変換（表変換、コードブロック化、リンク貼り付け）
 *   ※URL/パスの貼り付け時には、tp.system.promptにより表示テキストの編集を促します。
 * - 画像の右クリックメニューに「保管庫からのパスをコピー」を追加: 画像・drawioファイルを右クリックした際に、保管庫からの相対パスをクリップボードへコピーできるようにします。（旧 data_cards.base の画像カード向け機能。Bases ビューは画像一覧プラグインへ置き換え済み）
 * - 画像の右クリックメニューに「削除」を追加: 画像ファイルを右クリックした際に、確認ダイアログを経てシステムゴミ箱へ移動できるようにします。
 * - 画像の右クリックメニューに「drawioで編集」を追加: drawio関連の画像ファイル名の場合に、コンテキストメニューから直接編集ビューを開けるようにします。
 * - Excalidraw埋め込みダブルクリックでビュー切り替え: ノート自身と同名のExcalidraw埋め込み（excalidraw-plugin: parsed）をダブルクリックした際に、Excalidrawビューへ切り替えます。
 * - MarkMindアクティブ時のDeleteキー制御: マインドマップ操作中にDeleteキーを押してもノート削除を実行せず、MarkMind内部のノード削除処理へ渡します。
 * - CAD Viewer フォーカス時のDeleteキー制御: CAD Viewer の注記・寸法を選択中にDeleteキーを押してもノート削除を実行せず、CAD Viewer 側の削除処理へ渡します。
 * - MarkMind表示時のExcalidrawセクション除外と保護: Excalidrawデータを持つノートをマインドマップ表示する際、描画時にExcalidrawの内部データを除外し、保存時には元のExcalidrawデータを安全に維持・復元します。
 * - 左右両サイドバーの表示非表示トグル (Option + B): 左右両方のサイドバーをOption+B (Win/Linux: Alt+B) で一括開閉し、エディタやサイドバーなどアクティブな状態を問わず確実に画面を最大化・復元します。
 * - ファイルマネージャー連携（ドラッグ＆ドロップと同一フォルダ保存）: ファイルマネージャーWebアプリからのドロップを検知し、localhost:8001 の open-path リンクを自動生成します。また、リンク右クリックから「コピーして同一フォルダーに保存」を実行すると、リンク先のファイルを現在開いているノートと同じフォルダーにコピーし、リンクをObsidianリンクへ自動変換します。
 * - サマリー作成時のOutlookメール（MSG）クリーン展開 & 文字化け防止・表（テーブル）展開: Outlook特有のOfficeメタデータや条件付きコメント（<!--[if ...]>、<xml>、<o:p>等）を完全除去し、文字化けや「< >」タグの露出を防ぎます。コードページ未指定・cp1252誤認の日本語MSGをCP932/Windows-31J優先のベストエフォートで復元し、ネストされたテーブルやセル内改行（<p>、<br>）を含む表構造を破壊せずMarkdownテーブルとして正確に展開します。また、画像なしメールでは整ったプレーンテキスト本文を優先します。
 *   メール（MSG / winmail.dat）の解析と、表のMarkdown変換・RTF抽出は obsidian-sidebar-explorer-tag プラグインの実装を使います（このファイルには解析処理を持ちません。プラグインが無効の場合、メールは展開されません）。
 * - 添付ファイル削除時のノート内リンク自動クリーンアップ: 添付ファイル削除時（ノート内コンテキストメニュー、エディタメニュー、ファイルエクスプローラー等）、通常Wikilink（[[...]]）、埋め込み（![[...]]）、Markdownリンク（[...](...)）を問わず該当ファイルへの参照リンクを自動削除します。単独行や箇条書きリスト項目は行ごとクリーンに消去し、ファイルエクスプローラーからの削除時もアクティブノートおよび参照元ノートのリンクを一括自動更新します。
 * - マークダウン編集時の右クリックメニュー（フォルダを開く / VS Codeで開く）: エディタ内で右クリックした際、現在編集中のファイルが存在するフォルダをOSのファイルマネージャー（Finder/エクスプローラー）で直接開く「フォルダを開く」、および対象ファイルをVS Codeで開く「VS Codeで開く」を追加します。
 * - 画像埋め込みの表示幅追従とリサイズ最適化: 画像（img）のドラッグリサイズやマウスホイールズーム（mousewheel-image-zoom）による拡大・縮小時に、幅属性やスタイルの変化を検知してキャプション幅やコンテナの幅スタイルを自動追従させます。
 * - 画像選択時のショートカットRによるリネーム & モーダルドラッグ移動: マークダウン内で画像を選択してRキーを押すことで、エディタ編集モードでも確実にリネームモーダルを起動可能にしました。また、リネームモーダルはタイトルバーをマウスで掴んでドラッグ移動可能とし、画像を見ながら名前を変更できるようにしました。
 * - 画像右クリックメニュー「画像の容量を縮小」: 画像を右クリックした際に「画像の容量を縮小」メニューを表示し、指定した目標容量（KB）になるよう画像を縮小（リサイズ・品質調整）してプレビュー表示・確認の上で安全に置き換え保存できるようにしました。モーダルはドラッグ移動可能で、背後の画像やノートを確認しながら操作できます。
 * - 画像およびExcalidraw埋め込み図の右下ドラッグによる拡大縮小（リサイズハンドル）: Markdownノート内の画像やExcalidraw埋め込み図（拡張子省略リンク含む）の右下にドラッグハンドルを表示し、マウスドラッグによる直感的なサイズ変更およびノート本文（![[image.png|サイズ]]、![[diagram|サイズ]]）の自動更新・保存を可能にします。ダブルクリックで元のサイズにリセットできます。
 *   サイズは画像を表示しているノートへ保存し、同じ画像を複数回埋め込んでいる場合は操作した埋め込みだけを更新します。標準Markdown記法（![alt](path)）ではリンク先パスを保ちます。
 *   図の再走査は、図の表示に関係するDOM変更のときだけ行います（isFigureRelevantMutation）。
 */

const CUSTOM_COMMAND_SCRIPT_DIR = "80_script/register_custom_commands";
const CUSTOM_COMMAND_SCRIPT_FILES = [
    "01_common_helpers.js",
    "02_external_apps.js",
    "03_figure_embeds.js",
    "04_clipboard_image_compare.js",
    "05_attachment_delete.js",
    "06_note_list_links.js",
    "07_image_copy_menu.js",
    "08_modals.js",
    "09_mail_parsing.js",
    "10_summary.js",
    "11_from_clipboard.js",
    "12_moc_and_reload.js",
    "13_commands.js",
    "14_embed_click_actions.js",
    "15_image_rename_compress_move.js",
    "16_command_guards_delete_key.js",
    "17_file_menu.js",
    "18_file_manager_and_editor_menu.js",
    "19_pdf_export_extension.js",
    "20_quote_shortcut.js",
    "21_toggle_sidebars.js",
    "22_markmind.js",
    "23_tags.js",
    "24_html_pdf_export.js",
    "25_tag_menu_top_notes_drop.js",
    "26_gantt_task.js",
    "27_drawio_to_excalidraw.js",
];

// セクションのファイルを読み込み、上の一覧の順に連結して返す。
const readCustomCommandScript = async () => {
    const sources = await Promise.all(CUSTOM_COMMAND_SCRIPT_FILES.map(async (fileName) => {
        const filePath = `${CUSTOM_COMMAND_SCRIPT_DIR}/${fileName}`;
        try {
            return await app.vault.adapter.read(filePath);
        } catch (error) {
            throw new Error(`${filePath} を読み込めません（${error.message}）`);
        }
    }));
    return sources.join("\n");
};

try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const source = await readCustomCommandScript();
    // sourceURL を付けておくと、開発者ツールでエラーの発生箇所を RegisterCustomCommands.js の行番号で確認できる
    // （その行がどのファイルの何行目かは、node scratch/lib/templateHarness.js <行番号> で調べられる）。
    await new AsyncFunction("tp", `${source}\n//# sourceURL=RegisterCustomCommands.js`)(tp);
} catch (error) {
    console.error("RegisterCustomCommands: カスタムコマンドの読み込みに失敗しました", error);
    const NoticeClass = tp?.obsidian?.Notice || (typeof Notice !== "undefined" ? Notice : null);
    if (NoticeClass) new NoticeClass(`カスタムコマンドの読み込みに失敗しました: ${error.message}`, 15000);
    throw error;
}
%>
