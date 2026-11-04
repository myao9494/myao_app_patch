# 仕様書: http(s) リンクの右クリック「chrome で開く」

## 概要
ノート内の http / https リンクを右クリックしたメニューに「chrome で開く」（アイコン: `globe`）を追加する。既定のブラウザに関係なく Google Chrome で開く。Mac と Windows の両方に対応する。

## 仕様詳細
1. **対象**: Obsidian の `url-menu` イベント（閲覧モードと編集モード〈ライブプレビュー〉の外部リンク）。`http://` / `https://` のリンクだけに追加する。
   - ファイルマネージャーのリンク（`http://localhost:8001/api/open-path`）は、開くとファイルを開く操作になるため対象外（右クリックは「コピーして同一フォルダーに保存」を使う）。
   - `?path=` を含むだけの普通の URL には追加する。
2. **起動方法（`openUrlInChrome`、`02_external_apps.js`）**: URL は引数として渡す（シェルを通さない）。
   - macOS: `open -a "Google Chrome" <url>`。失敗したら `open -b com.google.Chrome <url>`。
   - Windows: `Program Files` / `Program Files (x86)` / `LOCALAPPDATA` 配下の `Google\Chrome\Application\chrome.exe` のうち存在するもの。無ければ `chrome` コマンド。
   - Linux: `google-chrome` → `google-chrome-stable` → `chromium` → `chromium-browser` の順。
   - http(s) 以外の URL は起動せず通知する。起動できなければ「Chrome を起動できませんでした」を通知する。
3. **実装対象**:
   - [80_script/register_custom_commands/02_external_apps.js](../80_script/register_custom_commands/02_external_apps.js)（`openUrlInChrome`）
   - [80_script/register_custom_commands/18_file_manager_and_editor_menu.js](../80_script/register_custom_commands/18_file_manager_and_editor_menu.js)（`handleUrlMenu`）
4. **テスト**: [scratch/test_open_url_in_chrome.js](../scratch/test_open_url_in_chrome.js)（起動コマンドの組み立てと、メニュー項目の追加条件）。実機（Mac / Windows の Obsidian）での右クリック確認は未実施。
