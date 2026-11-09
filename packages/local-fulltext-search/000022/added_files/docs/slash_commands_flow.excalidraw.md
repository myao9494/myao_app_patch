<!--
/**
 * スラッシュコマンド（このアプリ独自の定型作業）の流れ
 *
 * 1. OpenCode ペインの「/ コマンド」で、コマンド名・説明・プロンプトを登録する（$ARGUMENTS で引数を差し込める）
 * 2. 一覧はバックエンドの launcher_slash_commands.json へ保存し（PUT）、ランチャーが起動時と表示のたびに読む（GET）
 * 3. 指示欄で / を打つと候補を出し、↑↓で選び Tab / Enter で確定、Esc で閉じる（Obsidian と同じ）
 * 4. 送信時に /名前 引数 をプロンプトへ展開して opencode へ送る。吹き出しと履歴には打った文字を残す
 **/
-->
---

excalidraw-plugin: parsed
tags: [excalidraw]

---
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==

# Excalidraw Data

## Text Elements
スラッシュコマンド（このアプリ独自の定型作業）の流れ ^title

① 「/ コマンド」で登録
コマンド名・説明・プロンプト
（$ARGUMENTS で引数を差し込む） ^register

② バックエンドへ保存
PUT /api/index/settings/
launcher-slash-commands
→ launcher_slash_commands.json ^store

③ ランチャーが読む
GET（起動時・表示のたび）
Windows / macOS で共有 ^load

④ 指示欄で / を打つ
候補（/名前  説明）を表示
↑↓で選択・Tab/Enterで確定
Esc で閉じる
（/p + Tab → /pass） ^type

⑤ 送信: /pass gmail
$ARGUMENTS → gmail に展開
登録の無い /… はそのまま ^expand

⑥ opencode run へ
展開後のプロンプトを送る
吹き出し・履歴は /pass gmail ^run

## Drawing
```json
{
	"type": "excalidraw",
	"version": 2,
	"source": "https://excalidraw.com",
	"elements": [
		{
			"version": 1,
			"isDeleted": false,
			"fillStyle": "solid",
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"groupIds": [],
			"frameId": null,
			"updated": 1,
			"link": null,
			"locked": false,
			"type": "rectangle",
			"id": "box-title",
			"versionNonce": 502,
			"seed": 502,
			"strokeWidth": 2,
			"x": 40,
			"y": 0,
			"width": 880,
			"height": 50,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "#fff3bf",
			"roundness": {
				"type": 3
			},
			"boundElements": [
				{
					"type": "text",
					"id": "title"
				}
			]
		},
		{
			"version": 1,
			"isDeleted": false,
			"fillStyle": "solid",
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"groupIds": [],
			"frameId": null,
			"updated": 1,
			"link": null,
			"locked": false,
			"type": "text",
			"id": "title",
			"versionNonce": 503,
			"seed": 503,
			"strokeWidth": 1,
			"x": 50,
			"y": 15.0,
			"width": 860,
			"height": 20,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "transparent",
			"roundness": null,
			"boundElements": [],
			"fontSize": 14,
			"fontFamily": 1,
			"text": "スラッシュコマンド（このアプリ独自の定型作業）の流れ",
			"rawText": "スラッシュコマンド（このアプリ独自の定型作業）の流れ",
			"originalText": "スラッシュコマンド（このアプリ独自の定型作業）の流れ",
			"textAlign": "center",
			"verticalAlign": "middle",
			"containerId": "box-title",
			"lineHeight": 1.25,
			"baseline": 12
		},
		{
			"version": 1,
			"isDeleted": false,
			"fillStyle": "solid",
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"groupIds": [],
			"frameId": null,
			"updated": 1,
			"link": null,
			"locked": false,
			"type": "rectangle",
			"id": "box-register",
			"versionNonce": 504,
			"seed": 504,
			"strokeWidth": 2,
			"x": 40,
			"y": 90,
			"width": 260,
			"height": 130,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "#e7f5ff",
			"roundness": {
				"type": 3
			},
			"boundElements": [
				{
					"type": "text",
					"id": "register"
				}
			]
		},
		{
			"version": 1,
			"isDeleted": false,
			"fillStyle": "solid",
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"groupIds": [],
			"frameId": null,
			"updated": 1,
			"link": null,
			"locked": false,
			"type": "text",
			"id": "register",
			"versionNonce": 505,
			"seed": 505,
			"strokeWidth": 1,
			"x": 50,
			"y": 125.0,
			"width": 240,
			"height": 60,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "transparent",
			"roundness": null,
			"boundElements": [],
			"fontSize": 14,
			"fontFamily": 1,
			"text": "① 「/ コマンド」で登録\nコマンド名・説明・プロンプト\n（$ARGUMENTS で引数を差し込む）",
			"rawText": "① 「/ コマンド」で登録\nコマンド名・説明・プロンプト\n（$ARGUMENTS で引数を差し込む）",
			"originalText": "① 「/ コマンド」で登録\nコマンド名・説明・プロンプト\n（$ARGUMENTS で引数を差し込む）",
			"textAlign": "center",
			"verticalAlign": "middle",
			"containerId": "box-register",
			"lineHeight": 1.25,
			"baseline": 12
		},
		{
			"version": 1,
			"isDeleted": false,
			"fillStyle": "solid",
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"groupIds": [],
			"frameId": null,
			"updated": 1,
			"link": null,
			"locked": false,
			"type": "rectangle",
			"id": "box-store",
			"versionNonce": 506,
			"seed": 506,
			"strokeWidth": 2,
			"x": 360,
			"y": 90,
			"width": 260,
			"height": 130,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "#ebfbee",
			"roundness": {
				"type": 3
			},
			"boundElements": [
				{
					"type": "text",
					"id": "store"
				}
			]
		},
		{
			"version": 1,
			"isDeleted": false,
			"fillStyle": "solid",
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"groupIds": [],
			"frameId": null,
			"updated": 1,
			"link": null,
			"locked": false,
			"type": "text",
			"id": "store",
			"versionNonce": 507,
			"seed": 507,
			"strokeWidth": 1,
			"x": 370,
			"y": 115.0,
			"width": 240,
			"height": 80,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "transparent",
			"roundness": null,
			"boundElements": [],
			"fontSize": 14,
			"fontFamily": 1,
			"text": "② バックエンドへ保存\nPUT /api/index/settings/\nlauncher-slash-commands\n→ launcher_slash_commands.json",
			"rawText": "② バックエンドへ保存\nPUT /api/index/settings/\nlauncher-slash-commands\n→ launcher_slash_commands.json",
			"originalText": "② バックエンドへ保存\nPUT /api/index/settings/\nlauncher-slash-commands\n→ launcher_slash_commands.json",
			"textAlign": "center",
			"verticalAlign": "middle",
			"containerId": "box-store",
			"lineHeight": 1.25,
			"baseline": 12
		},
		{
			"version": 1,
			"isDeleted": false,
			"fillStyle": "solid",
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"groupIds": [],
			"frameId": null,
			"updated": 1,
			"link": null,
			"locked": false,
			"type": "rectangle",
			"id": "box-load",
			"versionNonce": 508,
			"seed": 508,
			"strokeWidth": 2,
			"x": 680,
			"y": 90,
			"width": 240,
			"height": 130,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "#ebfbee",
			"roundness": {
				"type": 3
			},
			"boundElements": [
				{
					"type": "text",
					"id": "load"
				}
			]
		},
		{
			"version": 1,
			"isDeleted": false,
			"fillStyle": "solid",
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"groupIds": [],
			"frameId": null,
			"updated": 1,
			"link": null,
			"locked": false,
			"type": "text",
			"id": "load",
			"versionNonce": 509,
			"seed": 509,
			"strokeWidth": 1,
			"x": 690,
			"y": 125.0,
			"width": 220,
			"height": 60,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "transparent",
			"roundness": null,
			"boundElements": [],
			"fontSize": 14,
			"fontFamily": 1,
			"text": "③ ランチャーが読む\nGET（起動時・表示のたび）\nWindows / macOS で共有",
			"rawText": "③ ランチャーが読む\nGET（起動時・表示のたび）\nWindows / macOS で共有",
			"originalText": "③ ランチャーが読む\nGET（起動時・表示のたび）\nWindows / macOS で共有",
			"textAlign": "center",
			"verticalAlign": "middle",
			"containerId": "box-load",
			"lineHeight": 1.25,
			"baseline": 12
		},
		{
			"version": 1,
			"isDeleted": false,
			"fillStyle": "solid",
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"groupIds": [],
			"frameId": null,
			"updated": 1,
			"link": null,
			"locked": false,
			"type": "rectangle",
			"id": "box-type",
			"versionNonce": 510,
			"seed": 510,
			"strokeWidth": 2,
			"x": 40,
			"y": 280,
			"width": 260,
			"height": 150,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "#f3f0ff",
			"roundness": {
				"type": 3
			},
			"boundElements": [
				{
					"type": "text",
					"id": "type"
				}
			]
		},
		{
			"version": 1,
			"isDeleted": false,
			"fillStyle": "solid",
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"groupIds": [],
			"frameId": null,
			"updated": 1,
			"link": null,
			"locked": false,
			"type": "text",
			"id": "type",
			"versionNonce": 511,
			"seed": 511,
			"strokeWidth": 1,
			"x": 50,
			"y": 305.0,
			"width": 240,
			"height": 100,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "transparent",
			"roundness": null,
			"boundElements": [],
			"fontSize": 14,
			"fontFamily": 1,
			"text": "④ 指示欄で / を打つ\n候補（/名前  説明）を表示\n↑↓で選択・Tab/Enterで確定\nEsc で閉じる\n（/p + Tab → /pass）",
			"rawText": "④ 指示欄で / を打つ\n候補（/名前  説明）を表示\n↑↓で選択・Tab/Enterで確定\nEsc で閉じる\n（/p + Tab → /pass）",
			"originalText": "④ 指示欄で / を打つ\n候補（/名前  説明）を表示\n↑↓で選択・Tab/Enterで確定\nEsc で閉じる\n（/p + Tab → /pass）",
			"textAlign": "center",
			"verticalAlign": "middle",
			"containerId": "box-type",
			"lineHeight": 1.25,
			"baseline": 12
		},
		{
			"version": 1,
			"isDeleted": false,
			"fillStyle": "solid",
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"groupIds": [],
			"frameId": null,
			"updated": 1,
			"link": null,
			"locked": false,
			"type": "rectangle",
			"id": "box-expand",
			"versionNonce": 512,
			"seed": 512,
			"strokeWidth": 2,
			"x": 360,
			"y": 280,
			"width": 260,
			"height": 150,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "#ffe8cc",
			"roundness": {
				"type": 3
			},
			"boundElements": [
				{
					"type": "text",
					"id": "expand"
				}
			]
		},
		{
			"version": 1,
			"isDeleted": false,
			"fillStyle": "solid",
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"groupIds": [],
			"frameId": null,
			"updated": 1,
			"link": null,
			"locked": false,
			"type": "text",
			"id": "expand",
			"versionNonce": 513,
			"seed": 513,
			"strokeWidth": 1,
			"x": 370,
			"y": 325.0,
			"width": 240,
			"height": 60,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "transparent",
			"roundness": null,
			"boundElements": [],
			"fontSize": 14,
			"fontFamily": 1,
			"text": "⑤ 送信: /pass gmail\n$ARGUMENTS → gmail に展開\n登録の無い /… はそのまま",
			"rawText": "⑤ 送信: /pass gmail\n$ARGUMENTS → gmail に展開\n登録の無い /… はそのまま",
			"originalText": "⑤ 送信: /pass gmail\n$ARGUMENTS → gmail に展開\n登録の無い /… はそのまま",
			"textAlign": "center",
			"verticalAlign": "middle",
			"containerId": "box-expand",
			"lineHeight": 1.25,
			"baseline": 12
		},
		{
			"version": 1,
			"isDeleted": false,
			"fillStyle": "solid",
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"groupIds": [],
			"frameId": null,
			"updated": 1,
			"link": null,
			"locked": false,
			"type": "rectangle",
			"id": "box-run",
			"versionNonce": 514,
			"seed": 514,
			"strokeWidth": 2,
			"x": 680,
			"y": 280,
			"width": 240,
			"height": 150,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "#e7f5ff",
			"roundness": {
				"type": 3
			},
			"boundElements": [
				{
					"type": "text",
					"id": "run"
				}
			]
		},
		{
			"version": 1,
			"isDeleted": false,
			"fillStyle": "solid",
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"groupIds": [],
			"frameId": null,
			"updated": 1,
			"link": null,
			"locked": false,
			"type": "text",
			"id": "run",
			"versionNonce": 515,
			"seed": 515,
			"strokeWidth": 1,
			"x": 690,
			"y": 325.0,
			"width": 220,
			"height": 60,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "transparent",
			"roundness": null,
			"boundElements": [],
			"fontSize": 14,
			"fontFamily": 1,
			"text": "⑥ opencode run へ\n展開後のプロンプトを送る\n吹き出し・履歴は /pass gmail",
			"rawText": "⑥ opencode run へ\n展開後のプロンプトを送る\n吹き出し・履歴は /pass gmail",
			"originalText": "⑥ opencode run へ\n展開後のプロンプトを送る\n吹き出し・履歴は /pass gmail",
			"textAlign": "center",
			"verticalAlign": "middle",
			"containerId": "box-run",
			"lineHeight": 1.25,
			"baseline": 12
		},
		{
			"type": "arrow",
			"version": 1,
			"versionNonce": 515,
			"isDeleted": false,
			"id": "arrow-515",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"x": 300,
			"y": 155.0,
			"strokeColor": "#495057",
			"backgroundColor": "transparent",
			"width": 60,
			"height": 0.0,
			"seed": 515,
			"groupIds": [],
			"frameId": null,
			"roundness": {
				"type": 2
			},
			"boundElements": [],
			"updated": 1,
			"link": null,
			"locked": false,
			"startBinding": {
				"elementId": "box-register",
				"focus": 0,
				"gap": 4
			},
			"endBinding": {
				"elementId": "box-store",
				"focus": 0,
				"gap": 4
			},
			"lastCommittedPoint": null,
			"startArrowhead": null,
			"endArrowhead": "arrow",
			"points": [
				[
					0,
					0
				],
				[
					60,
					0.0
				]
			]
		},
		{
			"type": "arrow",
			"version": 1,
			"versionNonce": 516,
			"isDeleted": false,
			"id": "arrow-516",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"x": 620,
			"y": 155.0,
			"strokeColor": "#495057",
			"backgroundColor": "transparent",
			"width": 60,
			"height": 0.0,
			"seed": 516,
			"groupIds": [],
			"frameId": null,
			"roundness": {
				"type": 2
			},
			"boundElements": [],
			"updated": 1,
			"link": null,
			"locked": false,
			"startBinding": {
				"elementId": "box-store",
				"focus": 0,
				"gap": 4
			},
			"endBinding": {
				"elementId": "box-load",
				"focus": 0,
				"gap": 4
			},
			"lastCommittedPoint": null,
			"startArrowhead": null,
			"endArrowhead": "arrow",
			"points": [
				[
					0,
					0
				],
				[
					60,
					0.0
				]
			]
		},
		{
			"type": "arrow",
			"version": 1,
			"versionNonce": 517,
			"isDeleted": false,
			"id": "arrow-517",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"x": 800.0,
			"y": 220,
			"strokeColor": "#495057",
			"backgroundColor": "transparent",
			"width": 0.0,
			"height": 60,
			"seed": 517,
			"groupIds": [],
			"frameId": null,
			"roundness": {
				"type": 2
			},
			"boundElements": [],
			"updated": 1,
			"link": null,
			"locked": false,
			"startBinding": {
				"elementId": "box-load",
				"focus": 0,
				"gap": 4
			},
			"endBinding": {
				"elementId": "box-run",
				"focus": 0,
				"gap": 4
			},
			"lastCommittedPoint": null,
			"startArrowhead": null,
			"endArrowhead": "arrow",
			"points": [
				[
					0,
					0
				],
				[
					0.0,
					60
				]
			]
		},
		{
			"type": "arrow",
			"version": 1,
			"versionNonce": 518,
			"isDeleted": false,
			"id": "arrow-518",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"x": 300,
			"y": 355.0,
			"strokeColor": "#495057",
			"backgroundColor": "transparent",
			"width": 60,
			"height": 0.0,
			"seed": 518,
			"groupIds": [],
			"frameId": null,
			"roundness": {
				"type": 2
			},
			"boundElements": [],
			"updated": 1,
			"link": null,
			"locked": false,
			"startBinding": {
				"elementId": "box-type",
				"focus": 0,
				"gap": 4
			},
			"endBinding": {
				"elementId": "box-expand",
				"focus": 0,
				"gap": 4
			},
			"lastCommittedPoint": null,
			"startArrowhead": null,
			"endArrowhead": "arrow",
			"points": [
				[
					0,
					0
				],
				[
					60,
					0.0
				]
			]
		},
		{
			"type": "arrow",
			"version": 1,
			"versionNonce": 519,
			"isDeleted": false,
			"id": "arrow-519",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"x": 620,
			"y": 355.0,
			"strokeColor": "#495057",
			"backgroundColor": "transparent",
			"width": 60,
			"height": 0.0,
			"seed": 519,
			"groupIds": [],
			"frameId": null,
			"roundness": {
				"type": 2
			},
			"boundElements": [],
			"updated": 1,
			"link": null,
			"locked": false,
			"startBinding": {
				"elementId": "box-expand",
				"focus": 0,
				"gap": 4
			},
			"endBinding": {
				"elementId": "box-run",
				"focus": 0,
				"gap": 4
			},
			"lastCommittedPoint": null,
			"startArrowhead": null,
			"endArrowhead": "arrow",
			"points": [
				[
					0,
					0
				],
				[
					60,
					0.0
				]
			]
		}
	],
	"appState": {
		"gridSize": null,
		"viewBackgroundColor": "#ffffff"
	},
	"files": {}
}
```
