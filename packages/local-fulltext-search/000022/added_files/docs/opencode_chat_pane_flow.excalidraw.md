<!--
/**
 * OpenCode ペイン（Obsidian の Claudian プラグイン風チャット）の処理の流れ
 *
 * 1. 指示欄: Enter で送信、Shift+Enter で改行、↑↓ で過去の指示を呼び出す
 * 2. 実行中の送信は待ち行列へ入れ、終わったら順に送る。送信ボタンは実行中「停止」になり、待ち行列も捨てる
 * 3. opencode run --format json --thinking（モデル・Plan・自動承認を反映、--session で会話を続ける）
 * 4. ChatTranscript が NDJSON を吹き出し・思考・ツールカード・お知らせへ変換し、使用量を集計する
 * 5. 画面は差分だけ描き直し、下端に作業状況（経過時間・待ち行列）と使用量を出す
 * 会話履歴は session list / session export で過去の会話を読み込み、その会話 ID で続ける
 **/
-->
---

excalidraw-plugin: parsed
tags: [excalidraw]

---
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==

# Excalidraw Data

## Text Elements
OpenCode ペイン（Claudian 風チャット）の処理の流れ ^title

① 指示欄
Enter=送信 / Shift+Enter=改行
↑↓=過去の指示（PromptHistory） ^input

② 実行中なら待ち行列へ
（送信ボタンは「停止」）
停止で待ち行列も捨てる ^queue

モデル / Plan / 自動承認
→ --model / --agent plan / --auto
常に --thinking ^opts

③ opencode run --format json --thinking [...] [--session ID | --continue] -- 指示
（作業フォルダで実行。標準出力・標準エラーを並行して読み、15 分で打ち切り） ^run

④ ChatTranscript（opencode_chat.py / OpenCodeChat.cs）
text・reasoning・tool_use を part ID ごとの表示項目へ。
step_finish → コンテキスト使用量、error → お知らせ ^model

会話履歴
session list --format json
↓ 選ぶ
session export <ID>
↓
ChatTranscript.FromExport
（その会話 ID で続ける） ^history

⑤ 描画（差分だけ描き直す）
自分の指示=右寄せの吹き出し / 応答=「opencode」見出し＋Markdown＋コピー
思考・ツール=折りたたみ（▸ 思考（1.2秒） / ▸ ✓ bash  npm test）
macOS: opencode_view.py → NSTextView、WPF: OpenCodeChatView.cs ^view

下端の表示
作業中… 12秒 · 待機 1件
完了（2.0秒）
コンテキスト 10.1k トークン ^status

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
			"versionNonce": 100,
			"isDeleted": false,
			"id": "box-title",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"x": 40,
			"y": 0,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "#fff3bf",
			"width": 900,
			"height": 50,
			"seed": 100,
			"groupIds": [],
			"frameId": null,
			"roundness": {
				"type": 3
			},
			"boundElements": [
				{
					"type": "text",
					"id": "title"
				}
			],
			"updated": 1,
			"link": null,
			"locked": false
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 101,
			"isDeleted": false,
			"id": "title",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"x": 50,
			"y": 15.0,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "transparent",
			"width": 880,
			"height": 20,
			"seed": 101,
			"groupIds": [],
			"frameId": null,
			"roundness": null,
			"boundElements": [],
			"updated": 1,
			"link": null,
			"locked": false,
			"fontSize": 14,
			"fontFamily": 1,
			"text": "OpenCode ペイン（Claudian 風チャット）の処理の流れ",
			"rawText": "OpenCode ペイン（Claudian 風チャット）の処理の流れ",
			"textAlign": "center",
			"verticalAlign": "middle",
			"containerId": "box-title",
			"originalText": "OpenCode ペイン（Claudian 風チャット）の処理の流れ",
			"lineHeight": 1.25,
			"baseline": 12
		},
		{
			"type": "rectangle",
			"version": 1,
			"versionNonce": 102,
			"isDeleted": false,
			"id": "box-input",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"x": 40,
			"y": 90,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "#e7f5ff",
			"width": 280,
			"height": 110,
			"seed": 102,
			"groupIds": [],
			"frameId": null,
			"roundness": {
				"type": 3
			},
			"boundElements": [
				{
					"type": "text",
					"id": "input"
				}
			],
			"updated": 1,
			"link": null,
			"locked": false
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 103,
			"isDeleted": false,
			"id": "input",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"x": 50,
			"y": 115.0,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "transparent",
			"width": 260,
			"height": 60,
			"seed": 103,
			"groupIds": [],
			"frameId": null,
			"roundness": null,
			"boundElements": [],
			"updated": 1,
			"link": null,
			"locked": false,
			"fontSize": 14,
			"fontFamily": 1,
			"text": "① 指示欄\nEnter=送信 / Shift+Enter=改行\n↑↓=過去の指示（PromptHistory）",
			"rawText": "① 指示欄\nEnter=送信 / Shift+Enter=改行\n↑↓=過去の指示（PromptHistory）",
			"textAlign": "center",
			"verticalAlign": "middle",
			"containerId": "box-input",
			"originalText": "① 指示欄\nEnter=送信 / Shift+Enter=改行\n↑↓=過去の指示（PromptHistory）",
			"lineHeight": 1.25,
			"baseline": 12
		},
		{
			"type": "rectangle",
			"version": 1,
			"versionNonce": 104,
			"isDeleted": false,
			"id": "box-queue",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"x": 380,
			"y": 90,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "#ffe8cc",
			"width": 260,
			"height": 110,
			"seed": 104,
			"groupIds": [],
			"frameId": null,
			"roundness": {
				"type": 3
			},
			"boundElements": [
				{
					"type": "text",
					"id": "queue"
				}
			],
			"updated": 1,
			"link": null,
			"locked": false
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 105,
			"isDeleted": false,
			"id": "queue",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"x": 390,
			"y": 115.0,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "transparent",
			"width": 240,
			"height": 60,
			"seed": 105,
			"groupIds": [],
			"frameId": null,
			"roundness": null,
			"boundElements": [],
			"updated": 1,
			"link": null,
			"locked": false,
			"fontSize": 14,
			"fontFamily": 1,
			"text": "② 実行中なら待ち行列へ\n（送信ボタンは「停止」）\n停止で待ち行列も捨てる",
			"rawText": "② 実行中なら待ち行列へ\n（送信ボタンは「停止」）\n停止で待ち行列も捨てる",
			"textAlign": "center",
			"verticalAlign": "middle",
			"containerId": "box-queue",
			"originalText": "② 実行中なら待ち行列へ\n（送信ボタンは「停止」）\n停止で待ち行列も捨てる",
			"lineHeight": 1.25,
			"baseline": 12
		},
		{
			"type": "rectangle",
			"version": 1,
			"versionNonce": 106,
			"isDeleted": false,
			"id": "box-opts",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"x": 700,
			"y": 90,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "#f3f0ff",
			"width": 240,
			"height": 110,
			"seed": 106,
			"groupIds": [],
			"frameId": null,
			"roundness": {
				"type": 3
			},
			"boundElements": [
				{
					"type": "text",
					"id": "opts"
				}
			],
			"updated": 1,
			"link": null,
			"locked": false
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 107,
			"isDeleted": false,
			"id": "opts",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"x": 710,
			"y": 115.0,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "transparent",
			"width": 220,
			"height": 60,
			"seed": 107,
			"groupIds": [],
			"frameId": null,
			"roundness": null,
			"boundElements": [],
			"updated": 1,
			"link": null,
			"locked": false,
			"fontSize": 14,
			"fontFamily": 1,
			"text": "モデル / Plan / 自動承認\n→ --model / --agent plan / --auto\n常に --thinking",
			"rawText": "モデル / Plan / 自動承認\n→ --model / --agent plan / --auto\n常に --thinking",
			"textAlign": "center",
			"verticalAlign": "middle",
			"containerId": "box-opts",
			"originalText": "モデル / Plan / 自動承認\n→ --model / --agent plan / --auto\n常に --thinking",
			"lineHeight": 1.25,
			"baseline": 12
		},
		{
			"type": "rectangle",
			"version": 1,
			"versionNonce": 108,
			"isDeleted": false,
			"id": "box-run",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"x": 40,
			"y": 250,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "#e7f5ff",
			"width": 600,
			"height": 90,
			"seed": 108,
			"groupIds": [],
			"frameId": null,
			"roundness": {
				"type": 3
			},
			"boundElements": [
				{
					"type": "text",
					"id": "run"
				}
			],
			"updated": 1,
			"link": null,
			"locked": false
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 109,
			"isDeleted": false,
			"id": "run",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"x": 50,
			"y": 275.0,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "transparent",
			"width": 580,
			"height": 40,
			"seed": 109,
			"groupIds": [],
			"frameId": null,
			"roundness": null,
			"boundElements": [],
			"updated": 1,
			"link": null,
			"locked": false,
			"fontSize": 14,
			"fontFamily": 1,
			"text": "③ opencode run --format json --thinking [...] [--session ID | --continue] -- 指示\n（作業フォルダで実行。標準出力・標準エラーを並行して読み、15 分で打ち切り）",
			"rawText": "③ opencode run --format json --thinking [...] [--session ID | --continue] -- 指示\n（作業フォルダで実行。標準出力・標準エラーを並行して読み、15 分で打ち切り）",
			"textAlign": "center",
			"verticalAlign": "middle",
			"containerId": "box-run",
			"originalText": "③ opencode run --format json --thinking [...] [--session ID | --continue] -- 指示\n（作業フォルダで実行。標準出力・標準エラーを並行して読み、15 分で打ち切り）",
			"lineHeight": 1.25,
			"baseline": 12
		},
		{
			"type": "rectangle",
			"version": 1,
			"versionNonce": 110,
			"isDeleted": false,
			"id": "box-model",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"x": 40,
			"y": 390,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "#e7f5ff",
			"width": 600,
			"height": 110,
			"seed": 110,
			"groupIds": [],
			"frameId": null,
			"roundness": {
				"type": 3
			},
			"boundElements": [
				{
					"type": "text",
					"id": "model"
				}
			],
			"updated": 1,
			"link": null,
			"locked": false
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 111,
			"isDeleted": false,
			"id": "model",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"x": 50,
			"y": 415.0,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "transparent",
			"width": 580,
			"height": 60,
			"seed": 111,
			"groupIds": [],
			"frameId": null,
			"roundness": null,
			"boundElements": [],
			"updated": 1,
			"link": null,
			"locked": false,
			"fontSize": 14,
			"fontFamily": 1,
			"text": "④ ChatTranscript（opencode_chat.py / OpenCodeChat.cs）\ntext・reasoning・tool_use を part ID ごとの表示項目へ。\nstep_finish → コンテキスト使用量、error → お知らせ",
			"rawText": "④ ChatTranscript（opencode_chat.py / OpenCodeChat.cs）\ntext・reasoning・tool_use を part ID ごとの表示項目へ。\nstep_finish → コンテキスト使用量、error → お知らせ",
			"textAlign": "center",
			"verticalAlign": "middle",
			"containerId": "box-model",
			"originalText": "④ ChatTranscript（opencode_chat.py / OpenCodeChat.cs）\ntext・reasoning・tool_use を part ID ごとの表示項目へ。\nstep_finish → コンテキスト使用量、error → お知らせ",
			"lineHeight": 1.25,
			"baseline": 12
		},
		{
			"type": "rectangle",
			"version": 1,
			"versionNonce": 112,
			"isDeleted": false,
			"id": "box-history",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"x": 700,
			"y": 250,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "#ebfbee",
			"width": 240,
			"height": 250,
			"seed": 112,
			"groupIds": [],
			"frameId": null,
			"roundness": {
				"type": 3
			},
			"boundElements": [
				{
					"type": "text",
					"id": "history"
				}
			],
			"updated": 1,
			"link": null,
			"locked": false
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 113,
			"isDeleted": false,
			"id": "history",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"x": 710,
			"y": 305.0,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "transparent",
			"width": 220,
			"height": 140,
			"seed": 113,
			"groupIds": [],
			"frameId": null,
			"roundness": null,
			"boundElements": [],
			"updated": 1,
			"link": null,
			"locked": false,
			"fontSize": 14,
			"fontFamily": 1,
			"text": "会話履歴\nsession list --format json\n↓ 選ぶ\nsession export <ID>\n↓\nChatTranscript.FromExport\n（その会話 ID で続ける）",
			"rawText": "会話履歴\nsession list --format json\n↓ 選ぶ\nsession export <ID>\n↓\nChatTranscript.FromExport\n（その会話 ID で続ける）",
			"textAlign": "center",
			"verticalAlign": "middle",
			"containerId": "box-history",
			"originalText": "会話履歴\nsession list --format json\n↓ 選ぶ\nsession export <ID>\n↓\nChatTranscript.FromExport\n（その会話 ID で続ける）",
			"lineHeight": 1.25,
			"baseline": 12
		},
		{
			"type": "rectangle",
			"version": 1,
			"versionNonce": 114,
			"isDeleted": false,
			"id": "box-view",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"x": 40,
			"y": 550,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "#e7f5ff",
			"width": 600,
			"height": 130,
			"seed": 114,
			"groupIds": [],
			"frameId": null,
			"roundness": {
				"type": 3
			},
			"boundElements": [
				{
					"type": "text",
					"id": "view"
				}
			],
			"updated": 1,
			"link": null,
			"locked": false
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 115,
			"isDeleted": false,
			"id": "view",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"x": 50,
			"y": 575.0,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "transparent",
			"width": 580,
			"height": 80,
			"seed": 115,
			"groupIds": [],
			"frameId": null,
			"roundness": null,
			"boundElements": [],
			"updated": 1,
			"link": null,
			"locked": false,
			"fontSize": 14,
			"fontFamily": 1,
			"text": "⑤ 描画（差分だけ描き直す）\n自分の指示=右寄せの吹き出し / 応答=「opencode」見出し＋Markdown＋コピー\n思考・ツール=折りたたみ（▸ 思考（1.2秒） / ▸ ✓ bash  npm test）\nmacOS: opencode_view.py → NSTextView、WPF: OpenCodeChatView.cs",
			"rawText": "⑤ 描画（差分だけ描き直す）\n自分の指示=右寄せの吹き出し / 応答=「opencode」見出し＋Markdown＋コピー\n思考・ツール=折りたたみ（▸ 思考（1.2秒） / ▸ ✓ bash  npm test）\nmacOS: opencode_view.py → NSTextView、WPF: OpenCodeChatView.cs",
			"textAlign": "center",
			"verticalAlign": "middle",
			"containerId": "box-view",
			"originalText": "⑤ 描画（差分だけ描き直す）\n自分の指示=右寄せの吹き出し / 応答=「opencode」見出し＋Markdown＋コピー\n思考・ツール=折りたたみ（▸ 思考（1.2秒） / ▸ ✓ bash  npm test）\nmacOS: opencode_view.py → NSTextView、WPF: OpenCodeChatView.cs",
			"lineHeight": 1.25,
			"baseline": 12
		},
		{
			"type": "rectangle",
			"version": 1,
			"versionNonce": 116,
			"isDeleted": false,
			"id": "box-status",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"x": 700,
			"y": 550,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "#f8f9fa",
			"width": 240,
			"height": 130,
			"seed": 116,
			"groupIds": [],
			"frameId": null,
			"roundness": {
				"type": 3
			},
			"boundElements": [
				{
					"type": "text",
					"id": "status"
				}
			],
			"updated": 1,
			"link": null,
			"locked": false
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 117,
			"isDeleted": false,
			"id": "status",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"x": 710,
			"y": 575.0,
			"strokeColor": "#1e1e1e",
			"backgroundColor": "transparent",
			"width": 220,
			"height": 80,
			"seed": 117,
			"groupIds": [],
			"frameId": null,
			"roundness": null,
			"boundElements": [],
			"updated": 1,
			"link": null,
			"locked": false,
			"fontSize": 14,
			"fontFamily": 1,
			"text": "下端の表示\n作業中… 12秒 · 待機 1件\n完了（2.0秒）\nコンテキスト 10.1k トークン",
			"rawText": "下端の表示\n作業中… 12秒 · 待機 1件\n完了（2.0秒）\nコンテキスト 10.1k トークン",
			"textAlign": "center",
			"verticalAlign": "middle",
			"containerId": "box-status",
			"originalText": "下端の表示\n作業中… 12秒 · 待機 1件\n完了（2.0秒）\nコンテキスト 10.1k トークン",
			"lineHeight": 1.25,
			"baseline": 12
		},
		{
			"type": "arrow",
			"version": 1,
			"versionNonce": 118,
			"isDeleted": false,
			"id": "arrow-119",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"x": 320,
			"y": 145.0,
			"strokeColor": "#495057",
			"backgroundColor": "transparent",
			"width": 60,
			"height": 0.0,
			"seed": 119,
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
				"elementId": "box-input",
				"focus": 0,
				"gap": 4
			},
			"endBinding": {
				"elementId": "box-queue",
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
			"versionNonce": 120,
			"isDeleted": false,
			"id": "arrow-121",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"x": 640,
			"y": 145.0,
			"strokeColor": "#495057",
			"backgroundColor": "transparent",
			"width": 60,
			"height": 0.0,
			"seed": 121,
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
				"elementId": "box-queue",
				"focus": 0,
				"gap": 4
			},
			"endBinding": {
				"elementId": "box-opts",
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
			"versionNonce": 122,
			"isDeleted": false,
			"id": "arrow-123",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"x": 180.0,
			"y": 200,
			"strokeColor": "#495057",
			"backgroundColor": "transparent",
			"width": 160.0,
			"height": 50,
			"seed": 123,
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
				"elementId": "box-input",
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
					160.0,
					50
				]
			]
		},
		{
			"type": "arrow",
			"version": 1,
			"versionNonce": 124,
			"isDeleted": false,
			"id": "arrow-125",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"x": 340.0,
			"y": 340,
			"strokeColor": "#495057",
			"backgroundColor": "transparent",
			"width": 0.0,
			"height": 50,
			"seed": 125,
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
				"elementId": "box-run",
				"focus": 0,
				"gap": 4
			},
			"endBinding": {
				"elementId": "box-model",
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
					50
				]
			]
		},
		{
			"type": "arrow",
			"version": 1,
			"versionNonce": 126,
			"isDeleted": false,
			"id": "arrow-127",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"x": 340.0,
			"y": 500,
			"strokeColor": "#495057",
			"backgroundColor": "transparent",
			"width": 0.0,
			"height": 50,
			"seed": 127,
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
				"elementId": "box-model",
				"focus": 0,
				"gap": 4
			},
			"endBinding": {
				"elementId": "box-view",
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
					50
				]
			]
		},
		{
			"type": "arrow",
			"version": 1,
			"versionNonce": 128,
			"isDeleted": false,
			"id": "arrow-129",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"x": 820.0,
			"y": 500,
			"strokeColor": "#495057",
			"backgroundColor": "transparent",
			"width": -480.0,
			"height": -110,
			"seed": 129,
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
				"elementId": "box-history",
				"focus": 0,
				"gap": 4
			},
			"endBinding": {
				"elementId": "box-model",
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
					-480.0,
					-110
				]
			]
		},
		{
			"type": "arrow",
			"version": 1,
			"versionNonce": 130,
			"isDeleted": false,
			"id": "arrow-131",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"x": 340.0,
			"y": 500,
			"strokeColor": "#495057",
			"backgroundColor": "transparent",
			"width": 480.0,
			"height": 50,
			"seed": 131,
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
				"elementId": "box-model",
				"focus": 0,
				"gap": 4
			},
			"endBinding": {
				"elementId": "box-status",
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
					480.0,
					50
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
