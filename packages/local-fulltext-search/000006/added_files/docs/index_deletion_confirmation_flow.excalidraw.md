<!--
/**
 * インデックス削除確認（削除通知）& フォルダ追加・拡張子変更時のインデックス保護フロー図
 * 
 * 1. 検索対象フォルダ追加時: グローバル設定と階層数を引き継ぎ、既存インデックスを保護
 * 2. 拡張子変更時: 削除通知 (confirm_index_deletion) が ON の場合、除外拡張子の削除確認ダイアログを表示
 * 3. ユーザーの選択（OK / キャンセル）に応じて clean_excluded_files を制御し、安全に保存
 **/
-->
---

excalidraw-plugin: parsed
tags: [excalidraw]

---
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==

# Excalidraw Data

## Text Elements
インデックス削除確認（削除通知）& フォルダ・拡張子変更時の保護フロー ^title
① 検索対象フォルダの追加 (add_search_target) ^step1
グローバル除外設定・拡張子・指定階層数を正しく適用。既存の files は保持 ^step1-desc
② 検索ルール管理: インデックス対象拡張子の変更 ^step2
対象から外れた拡張子（例: .json）が存在するか判定 ^step2-desc
③ 削除通知設定 (confirm_index_deletion) の判定 ^step3
削除通知チェックボックスは ON か？ ^step3-cond
【分岐A】削除通知 ON: 確認ダイアログ表示 ^branch-a-title
「除外された拡張子の既存インデックスを削除しますか？」 ^branch-a-desc
【分岐A-1】ユーザーが「OK」を選択 ^sub-a1-title
clean_excluded_files: true で保存し、除外拡張子のレコードのみを安全にパージ ^sub-a1-desc
【分岐A-2】ユーザーが「キャンセル」を選択 ^sub-a2-title
clean_excluded_files: false で保存。既存インデックスは削除せず維持 ^sub-a2-desc
【分岐B】削除通知 OFF ^branch-b-title
ダイアログは出さず、既存インデックスも勝手に削除しない (clean_excluded_files: false) ^branch-b-desc
④ ベクトル差分インデックス同期 (⚡ 差分更新) ^step4
pending-deletions で走査外の削除候補ファイルを事前照合。既定は削除完全抑止 (clean_deleted_files: false) ^step4-desc
【ベクトル判定】削除通知 ON かつ 削除候補あり ^step4-cond
ファイル名プレビュー付きで削除確認ダイアログを表示 ^step4-dialog
・OK: clean_deleted_files: true で対象ファイルをパージ ^step4-ok
・キャンセル: clean_deleted_files: false で削除をスキップし新規・更新のみ安全に学習（インデックス保持） ^step4-cancel


## Drawing
```json
{
	"type": "excalidraw",
	"version": 2,
	"source": "https://excalidraw.com",
	"elements": [
		{
			"type": "rectangle",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "box-title",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 40,
			"y": 40,
			"strokeColor": "#1e66f5",
			"backgroundColor": "#1e1e2e",
			"width": 760,
			"height": 60,
			"seed": 100,
			"groupIds": [],
			"frameId": null,
			"roundness": { "type": 3 },
			"boundElements": []
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "text-title",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 60,
			"y": 55,
			"strokeColor": "#89b4fa",
			"backgroundColor": "transparent",
			"width": 720,
			"height": 30,
			"seed": 101,
			"groupIds": [],
			"frameId": null,
			"roundness": null,
			"boundElements": [],
			"text": "インデックス削除確認（削除通知）& フォルダ・拡張子変更時の保護フロー",
			"fontSize": 20,
			"fontFamily": 1,
			"textAlign": "left",
			"verticalAlign": "top",
			"rawText": "インデックス削除確認（削除通知）& フォルダ・拡張子変更時の保護フロー"
		},
		{
			"type": "rectangle",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "box-step1",
			"fillStyle": "solid",
			"strokeWidth": 1.5,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 40,
			"y": 130,
			"strokeColor": "#a6adc8",
			"backgroundColor": "#181825",
			"width": 760,
			"height": 70,
			"seed": 102,
			"groupIds": [],
			"frameId": null,
			"roundness": { "type": 3 },
			"boundElements": []
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "text-step1",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 60,
			"y": 140,
			"strokeColor": "#cdd6f4",
			"backgroundColor": "transparent",
			"width": 720,
			"height": 50,
			"seed": 103,
			"groupIds": [],
			"frameId": null,
			"roundness": null,
			"boundElements": [],
			"text": "① 検索対象フォルダの追加 (add_search_target)\nグローバル除外設定・拡張子・指定階層数を正しく適用。既存の files は保持",
			"fontSize": 15,
			"fontFamily": 1,
			"textAlign": "left",
			"verticalAlign": "top",
			"rawText": "① 検索対象フォルダの追加 (add_search_target)\nグローバル除外設定・拡張子・指定階層数を正しく適用。既存の files は保持"
		},
		{
			"type": "rectangle",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "box-step2",
			"fillStyle": "solid",
			"strokeWidth": 1.5,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 40,
			"y": 230,
			"strokeColor": "#a6adc8",
			"backgroundColor": "#181825",
			"width": 760,
			"height": 70,
			"seed": 104,
			"groupIds": [],
			"frameId": null,
			"roundness": { "type": 3 },
			"boundElements": []
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "text-step2",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 60,
			"y": 240,
			"strokeColor": "#cdd6f4",
			"backgroundColor": "transparent",
			"width": 720,
			"height": 50,
			"seed": 105,
			"groupIds": [],
			"frameId": null,
			"roundness": null,
			"boundElements": [],
			"text": "② 検索ルール管理: インデックス対象拡張子の変更\n対象から外れた拡張子（例: .json）が存在するか判定",
			"fontSize": 15,
			"fontFamily": 1,
			"textAlign": "left",
			"verticalAlign": "top",
			"rawText": "② 検索ルール管理: インデックス対象拡張子の変更\n対象から外れた拡張子（例: .json）が存在するか判定"
		},
		{
			"type": "diamond",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "diamond-step3",
			"fillStyle": "solid",
			"strokeWidth": 1.5,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 240,
			"y": 330,
			"strokeColor": "#f9e2af",
			"backgroundColor": "#1e1e2e",
			"width": 360,
			"height": 80,
			"seed": 106,
			"groupIds": [],
			"frameId": null,
			"roundness": { "type": 2 },
			"boundElements": []
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "text-step3",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 280,
			"y": 355,
			"strokeColor": "#f9e2af",
			"backgroundColor": "transparent",
			"width": 280,
			"height": 30,
			"seed": 107,
			"groupIds": [],
			"frameId": null,
			"roundness": null,
			"boundElements": [],
			"text": "削除通知チェックボックスは ON か？",
			"fontSize": 15,
			"fontFamily": 1,
			"textAlign": "center",
			"verticalAlign": "middle",
			"rawText": "削除通知チェックボックスは ON か？"
		},
		{
			"type": "rectangle",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "box-branch-a",
			"fillStyle": "solid",
			"strokeWidth": 1.5,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 40,
			"y": 450,
			"strokeColor": "#a6e3a1",
			"backgroundColor": "#181825",
			"width": 460,
			"height": 210,
			"seed": 108,
			"groupIds": [],
			"frameId": null,
			"roundness": { "type": 3 },
			"boundElements": []
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "text-branch-a",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 60,
			"y": 460,
			"strokeColor": "#a6e3a1",
			"backgroundColor": "transparent",
			"width": 420,
			"height": 190,
			"seed": 109,
			"groupIds": [],
			"frameId": null,
			"roundness": null,
			"boundElements": [],
			"text": "【有効 (ON)】確認ダイアログ表示\n「除外された拡張子の既存インデックスを削除しますか？」\n\n▶「OK」選択:\n   clean_excluded_files: true で保存\n   除外拡張子のレコードのみを安全にパージ\n\n▶「キャンセル」選択:\n   clean_excluded_files: false で保存\n   既存インデックスは削除せず維持",
			"fontSize": 14,
			"fontFamily": 1,
			"textAlign": "left",
			"verticalAlign": "top",
			"rawText": "【有効 (ON)】確認ダイアログ表示\n「除外された拡張子の既存インデックスを削除しますか？」\n\n▶「OK」選択:\n   clean_excluded_files: true で保存\n   除外拡張子のレコードのみを安全にパージ\n\n▶「キャンセル」選択:\n   clean_excluded_files: false で保存\n   既存インデックスは削除せず維持"
		},
		{
			"type": "rectangle",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "box-branch-b",
			"fillStyle": "solid",
			"strokeWidth": 1.5,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 520,
			"y": 450,
			"strokeColor": "#eba0ac",
			"backgroundColor": "#181825",
			"width": 280,
			"height": 210,
			"seed": 110,
			"groupIds": [],
			"frameId": null,
			"roundness": { "type": 3 },
			"boundElements": []
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "text-branch-b",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 540,
			"y": 460,
			"strokeColor": "#eba0ac",
			"backgroundColor": "transparent",
			"width": 240,
			"height": 190,
			"seed": 111,
			"groupIds": [],
			"frameId": null,
			"roundness": null,
			"boundElements": [],
			"text": "【無効 (OFF)】\n\nダイアログは出さず、\n既存インデックスも勝手に削除しない\n\n(clean_excluded_files: false で安全に保存)",
			"fontSize": 14,
			"fontFamily": 1,
			"textAlign": "left",
			"verticalAlign": "top",
			"rawText": "【無効 (OFF)】\n\nダイアログは出さず、\n既存インデックスも勝手に削除しない\n\n(clean_excluded_files: false で安全に保存)"
		}
	],
	"appState": {
		"viewBackgroundColor": "#0f172a",
		"gridSize": 20
	},
	"files": {}
}
```
