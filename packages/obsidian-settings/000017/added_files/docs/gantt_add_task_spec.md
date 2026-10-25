<!--
/**
 * 仕様: ノートのタブ・ファイルメニューの「ganttに追加」
 *
 * 1. 概要と動作
 * 2. 設定（親タスクID）
 * 3. 実装対象とテスト
 **/
-->
# ganttに追加

## 1. 概要と動作

Markdown ノートを gantt アプリ（`/Users/mine/000_work/app/gantt_react_myao`）のタスクにし、gantt からそのノートを開けるようにする。ファイルメニュー（`file-menu`。タブの右クリックを含む）の「ganttに追加」、またはコマンド `custom:add-to-gantt` で実行する。対象は Markdown（非 Excalidraw）。

1. ノートのファイル名（拡張子なし）をタスク名にして、`POST http://localhost:8000/api/tasks` でタスクを作る。payload はランチャー（Local-fulltext-search）の「ganttに追加」と同じ: 開始日は今日、終了日は明日、進捗 0.1、`kind_task: 1`、メモは空（`buildGanttTaskPayload`）。
2. 返ってきたタスクIDで、ノートを `名前【ID】.md` へリネームする（`app.fileManager.renameFile`。他ノートのリンクも Obsidian が更新する）。gantt の「O」で作るノート（`{タスク名}【{id}】.md`）と同じ命名で、gantt はリネーム・移動されたノートを【ID】で探し直せる。
3. `PUT /api/tasks/{id}` で `hyperlink` にノートの絶対パスを設定する。gantt の「O」と同じ形式なので、gantt でクリックすると Obsidian でノートが開く。

- すでにファイル名の末尾が `【数字】` のノートは、追加済みとして「すでにganttに追加済みです」と通知し、何もしない。
- gantt アプリに繋がらないなど、タスクの作成に失敗した場合は通知（Notice）を出し、リネームもしない。
- タスクを作った後にリネームやリンク設定が失敗した場合は、作成済みのタスクIDを通知する。

## 2. 設定（親タスクID）

コマンド `custom:set-gantt-parent`（ganttの親タスクIDを設定）で、追加するタスクの親タスクIDを設定する。0 以上の整数で、0（既定）はルート直下。値は `localStorage`（`customGanttParentId`）に保存する。

## 3. 実装対象とテスト

- [80_script/register_custom_commands/26_gantt_task.js](../80_script/register_custom_commands/26_gantt_task.js)（本体）、`17_file_menu.js`（メニュー項目）、`13_commands.js`（コマンド）
- テスト: [scratch/test_gantt_add_task.js](../scratch/test_gantt_add_task.js)
