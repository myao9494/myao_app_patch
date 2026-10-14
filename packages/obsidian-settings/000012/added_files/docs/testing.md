<!--
/**
 * 仕様: この保管庫の自作コード（プラグイン・テンプレート・スクリプト）のテスト方法
 *
 * 1. テストの場所と実行コマンド
 * 2. カスタムコマンドのスクリプト（RegisterCustomCommands.md と 80_script/register_custom_commands/）をテストする共通ハーネスの使い方
 * 3. テストを書くときの方針
 **/
-->
# テストガイド

## 1. テストの場所と実行方法

| 対象 | 場所 | 実行コマンド（各フォルダで実行） | 件数（2026-10-11 時点） |
| :--- | :--- | :--- | :--- |
| CAD Viewer | `.obsidian/plugins/cad-viewer/src/**/*.test.ts` | `npm test` | 50 |
| Sidebar Explorer | `.obsidian/plugins/obsidian-sidebar-explorer/utils.test.ts` | `npm test` | 44 |
| Sidebar Explorer Tag | `.obsidian/plugins/obsidian-sidebar-explorer-tag/`（`utils.test.ts`、`view.test.js`、`msgParser.test.ts`、`tnefParser.test.ts`、`mailGlobals.test.ts`、`noteListSection.test.ts`） | `npm test` | 67 |
| 画像一覧（Excalidraw Cards） | `.obsidian/plugins/obsidian-excalidraw-cards/utils.test.ts` | `npm test` | 21 |
| カスタムコマンドのスクリプト（`RegisterCustomCommands.md` と `80_script/register_custom_commands/`）、CSS スニペットほか | `scratch/test_*.js` | `npm test`（`node --test test_*.js`） | 327 |

- いずれも Node.js 標準のテストランナー（`node:test`）を使う。TypeScript のテストは `tsx` 経由で実行する。
- プラグインの依存パッケージ（`node_modules`）は Git 管理外。初回や取得し直した後は、各プラグインのフォルダで `npm install` を実行する。
- プラグインのソース（`.ts`）を変更したら `npm run build` で `main.js` を作り直す。`main.js` は Git 管理対象で、Obsidian が読み込む実体。
- `scratch/` には Python のテスト（`test_flow_chart.py` など）や、実データや外部アプリを使う調査用スクリプト（`debug_*.js`、`run_actual_summary.js` など）も置いてある。これらは `npm test` の対象外（ファイル名を `test_` で始めると `npm test` で実行されるため、調査用スクリプトには付けない）。

## 2. テンプレートのテスト用ハーネス

カスタムコマンドのスクリプトは、`80_script/register_custom_commands/` のファイルを連結して1つのスクリプトとして実行する作りのため、そのままでは関数を個別に読み込めない。`scratch/lib/templateHarness.js` が、実行時と同じ順にファイルを連結したうえで、行頭（インデントなし）で宣言された関数・定数を宣言単位で取り出して評価する。テストは必ずこのハーネスを通してスクリプトを読む（ファイルの場所や分け方を変えても、テストを直さずに済む）。

```js
const { loadTemplateFunctions } = require("./lib/templateHarness.js");

// 第1引数: 評価する宣言名（テスト対象と、それが依存する宣言）
// 第2引数: スクリプトが参照する外部の値（app, Notice, document など）のモック
const { handleDeleteKey } = loadTemplateFunctions(
    ["isExcalidrawActive", "isMarkMindActive", "isCadViewerFocused", "handleDeleteKey"],
    { document: { activeElement }, app: fakeApp },
);
```

| 関数 | 用途 |
| :--- | :--- |
| `loadTemplateFunctions(names, globals)` | 指定した宣言だけを評価し、同名の値をまとめて返す |
| `extractDeclarations(names)` | 指定した宣言のソースを、ファイル内の出現順で連結して返す |
| `listTopLevelDeclarations()` | 行頭の宣言の名前と行範囲の一覧を返す |
| `readTemplateScript()` | 本体のファイルを連結したスクリプト全体を返す（実行時に評価されるものと同じ） |
| `readLoaderScript()` | 読み込み役（`RegisterCustomCommands.md` の `<%* … %>` の中身）を返す |
| `listScriptFiles()` | 本体のファイル（名前、パス、連結後の開始行）を、読み込む順に返す |
| `locateScriptLine(line)` | 連結後の行番号から、ファイルとその中の行番号を求める |

- スクリプト全体は実行しないため、リスナー登録などの副作用は走らない。
- 宣言名が見つからない場合や、依存する宣言・モックが足りない場合は、テスト実行時にエラーになる（実装の整理に追従できていないことに気付ける）。
- 利用例: `test_figure_embed_observer.js`、`test_delete_key_guard.js`、`test_template_helpers.js`、`test_shortcut_and_markmind_behavior.js`、`test_image_compress.js`、`test_note_list_helper.js`。
- スクリプト全体を、モックした `app` / `document` などの上で実行するテストもある（`readTemplateScript()` の結果を評価する。例: `test_create_summary.js`、`test_pdf_export.js`）。登録処理まで含めて確認したい場合に使う。
- モーダルやイベントリスナーのテストには、擬似DOM（`scratch/lib/fakeDom.js` の `FakeElement` / `FakeModal` / `FakeSetting` / `createFakeEvent`）を使う。利用例: `test_image_rename_draggable.js`、`test_image_compress.js`、`test_quote.js`。
- スクリプトの構成（読み込み役の一覧とフォルダの一致、各ファイルの構文、読み込み役の動作）は `test_template_structure.js` で確認する。
- プラグインの TypeScript モジュールは、`scratch/lib/pluginLoader.js` の `loadPluginModule(プラグイン名, import文)` で読み込める（そのプラグインの esbuild でその場でバンドルするため、対象プラグインで `npm install` 済みであること）。
  - テンプレートがプラグインへ委譲している処理（メール本文の表変換・RTF抽出）は、`loadPluginMailHelpers()`（`scratch/lib/pluginMailHelpers.js`）でプラグインの実装そのものを使って検証する。利用例: `test_create_summary.js`、`test_template_helpers.js`。
  - テンプレートとプラグインの両方に実装がある小さな共通処理（`shouldMoveToMoc`、`isExcalidrawBackedMarkdown`、`replaceNoteListSection`）は、`test_template_plugin_parity.js` で同じ結果を返すことを確認する。

## 3. テストを書くときの方針

- **実装そのものを読み込んで動作を検証する。** テスト内に同じ処理を書き写したり、「ソースに特定の文字列が含まれるか」だけを確認したりするテストは、実装が壊れても気付けず、実装を整理しただけで失敗する。
- **保管庫の実データに依存させない。** 実在するノートや画像の有無で結果が変わらないよう、入力はテスト内で用意する。
- **不具合を直すときは、先に失敗するテストを書く。** 修正後に成功することを確認し、同じ不具合の再発を防ぐ。
- **ファイル冒頭に、何を検証するテストかを日本語で書く。**

`scratch/` のテストは、スクリプトを共通ハーネス経由で読み込む形に統一してある。次のテストだけは、対象の性質上、ソースや設定ファイルの内容を文字列として確認している。

- CSS スニペットの内容（`test_table_style.js`、`test_image_zoom_and_resize.js` と `test_image_drag_resize_handle.js` の一部）
- Sidebar Explorer の `view.ts` の構成（`test_active_folder_section.js`、`test_folder_header_context_menu.js`、`test_sidebar_folders.js`）と、Sidebar Explorer Tag のメニュー文言（`test_note_list.js` の一部）。ビューは Obsidian の画面部品に強く依存するため、判定ロジックは各プラグインの `utils.ts` へ切り出して、プラグイン側の `npm test` で検証している。

## 4. 実行中の Obsidian での確認（実機確認）

単体テストでは確認できない動作（実際の描画、メニュー、保存、他プラグインとの連携）は、実行中の Obsidian に接続して確認できる。

1. Obsidian を終了し、デバッグポート付きで起動する: `open -a Obsidian --args --remote-debugging-port=9222`
2. `http://127.0.0.1:9222/json/list` から `app://obsidian.md` のページを探し、Chrome DevTools Protocol（WebSocket）で接続する。
3. `Runtime.evaluate` でページ内のコード（`app`、`window`、DOM）を実行し、`Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` で本物の入力を送る。

確認時の注意:
- Obsidian のウィンドウが他のウィンドウの後ろや別のデスクトップにあると、描画（`requestAnimationFrame`）が止まり、プレビューの再描画が進まない。`Page.bringToFront` と `Emulation.setFocusEmulationEnabled` を使う。
- macOS の既定ではメニューがネイティブ（OS標準）で表示され、DOM には現れない。`@electron/remote` の `Menu.buildFromTemplate` を一時的に差し替えると、表示される項目の並びと各項目のクリック処理を取得できる。
- `window.confirm` と保存ダイアログ（`dialog.showSaveDialog`）は処理を止めるため、確認のあいだだけ差し替える。
- 編集モードのエディタの内容は `view.editor.getValue()` で読む（ファイルへの保存は約2秒遅れる）。閲覧モードでは非表示のエディタを書き換えても保存されない。
- カスタムコマンドのスクリプトの再読み込みは `app.plugins.plugins["templater-obsidian"].templater.execute_startup_scripts()`（`80_script/register_custom_commands/` のファイルを編集した後も、これで読み直せる）、プラグインの再読み込みは `app.plugins.disablePlugin(id)` → `enablePlugin(id)`。
- 確認用のノートは専用のフォルダに作り、終わったらゴミ箱へ移動する。
