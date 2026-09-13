<!--
/**
 * リッチテキスト（RTF）メールおよびTNEF（winmail.dat）デコーダー処理フロー図
 * 
 * 1. ノートの再帰リンク収集で .msg、.dat、winmail.dat を検出
 * 2. MSG内の compressedRtf を判定（\fromhtml なしの場合は extractPlainTextFromRtf で純粋RTF日本語抽出）
 * 3. 添付の winmail.dat または直接リンクの .dat を parseTnefBinary (MS-OXTNEF) でデコード
 * 4. サマリーの APPENDIX に本文および添付ファイルを欠落・文字化けなく展開
 **/
-->
---

excalidraw-plugin: parsed
tags: [excalidraw]

---
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. For more info check in plugin settings under 'Saving'

# Excalidraw Data

## Text Elements
RTFメール＆TNEF（winmail.dat）展開処理フロー ^title
① サマリー対象のリンク収集 ^step1-title
.msg / .dat / winmail.dat を自動検出 ^step1-desc
② メール形式の解析と分岐 ^step2-title
リッチテキスト（RTF）本文の抽出 ^branch-rtf-title
compressedRtf を解凍
\fromhtml なし（純粋RTF）の場合:
extractPlainTextFromRtf() で
Shift-JIS/Unicode制御語を除去＆デコード ^branch-rtf-desc
TNEF（winmail.dat）のデコード ^branch-tnef-title
MS-OXTNEF仕様に準拠した parseTnefBinary()
・シグネチャ検証 (0x223E9F78)
・MAPIプロパティ (PR_BODY, PR_RTF)
・添付ファイル（画像/文書）の抽出 ^branch-tnef-desc
③ サマリー（APPENDIX）への展開 ^step3-title
文字化けのないプレーン本文 ＋ 添付ファイルを完全展開！ ^step3-desc

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
			"id": "box-header",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 40,
			"y": 30,
			"strokeColor": "#2b8a3e",
			"backgroundColor": "#ebfbee",
			"width": 780,
			"height": 60,
			"seed": 1001,
			"groupIds": [],
			"frameId": null,
			"roundness": { "type": 3 },
			"boundElements": [{ "type": "text", "id": "title" }]
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "title",
			"x": 60,
			"y": 48,
			"strokeColor": "#2b8a3e",
			"backgroundColor": "transparent",
			"width": 740,
			"height": 24,
			"angle": 0,
			"text": "RTFメール＆TNEF（winmail.dat）展開処理フロー",
			"fontSize": 20,
			"fontFamily": 1,
			"textAlign": "center",
			"verticalAlign": "middle",
			"containerId": "box-header"
		},
		{
			"type": "rectangle",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "box-step1",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 40,
			"y": 130,
			"strokeColor": "#1971c2",
			"backgroundColor": "#e7f5ff",
			"width": 780,
			"height": 80,
			"seed": 1002,
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
			"id": "step1-title",
			"x": 60,
			"y": 145,
			"strokeColor": "#1971c2",
			"backgroundColor": "transparent",
			"width": 400,
			"height": 22,
			"angle": 0,
			"text": "① サマリー対象のリンク収集",
			"fontSize": 18,
			"fontFamily": 1,
			"textAlign": "left",
			"verticalAlign": "top"
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "step1-desc",
			"x": 60,
			"y": 175,
			"strokeColor": "#495057",
			"backgroundColor": "transparent",
			"width": 700,
			"height": 20,
			"angle": 0,
			"text": ".msg / .dat / winmail.dat を自動検出",
			"fontSize": 14,
			"fontFamily": 1,
			"textAlign": "left",
			"verticalAlign": "top"
		},
		{
			"type": "arrow",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "arrow-1-to-2",
			"strokeColor": "#1971c2",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 430,
			"y": 210,
			"width": 0,
			"height": 30,
			"points": [[0, 0], [0, 30]],
			"startBinding": { "elementId": "box-step1" },
			"endBinding": null,
			"startArrowhead": null,
			"endArrowhead": "arrow"
		},
		{
			"type": "rectangle",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "box-rtf",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 40,
			"y": 250,
			"strokeColor": "#e8590c",
			"backgroundColor": "#fff4e6",
			"width": 370,
			"height": 170,
			"seed": 1003,
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
			"id": "branch-rtf-title",
			"x": 55,
			"y": 265,
			"strokeColor": "#e8590c",
			"backgroundColor": "transparent",
			"width": 340,
			"height": 22,
			"angle": 0,
			"text": "リッチテキスト（RTF）本文の抽出",
			"fontSize": 16,
			"fontFamily": 1,
			"textAlign": "left",
			"verticalAlign": "top"
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "branch-rtf-desc",
			"x": 55,
			"y": 295,
			"strokeColor": "#495057",
			"backgroundColor": "transparent",
			"width": 340,
			"height": 100,
			"angle": 0,
			"text": "compressedRtf を解凍\n\\fromhtml なし（純粋RTF）の場合:\nextractPlainTextFromRtf() で\nShift-JIS/Unicode制御語を除去＆デコード",
			"fontSize": 13,
			"fontFamily": 1,
			"textAlign": "left",
			"verticalAlign": "top"
		},
		{
			"type": "rectangle",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "box-tnef",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 450,
			"y": 250,
			"strokeColor": "#7048e8",
			"backgroundColor": "#f3f0ff",
			"width": 370,
			"height": 170,
			"seed": 1004,
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
			"id": "branch-tnef-title",
			"x": 465,
			"y": 265,
			"strokeColor": "#7048e8",
			"backgroundColor": "transparent",
			"width": 340,
			"height": 22,
			"angle": 0,
			"text": "TNEF（winmail.dat）のデコード",
			"fontSize": 16,
			"fontFamily": 1,
			"textAlign": "left",
			"verticalAlign": "top"
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "branch-tnef-desc",
			"x": 465,
			"y": 295,
			"strokeColor": "#495057",
			"backgroundColor": "transparent",
			"width": 340,
			"height": 100,
			"angle": 0,
			"text": "MS-OXTNEF仕様に準拠した parseTnefBinary()\n・シグネチャ検証 (0x223E9F78)\n・MAPIプロパティ (PR_BODY, PR_RTF)\n・添付ファイル（画像/文書）の抽出",
			"fontSize": 13,
			"fontFamily": 1,
			"textAlign": "left",
			"verticalAlign": "top"
		},
		{
			"type": "arrow",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "arrow-rtf-to-step3",
			"strokeColor": "#2b8a3e",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 225,
			"y": 420,
			"width": 140,
			"height": 40,
			"points": [[0, 0], [140, 40]],
			"startBinding": { "elementId": "box-rtf" },
			"endBinding": { "elementId": "box-step3" },
			"startArrowhead": null,
			"endArrowhead": "arrow"
		},
		{
			"type": "arrow",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "arrow-tnef-to-step3",
			"strokeColor": "#2b8a3e",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 635,
			"y": 420,
			"width": -140,
			"height": 40,
			"points": [[0, 0], [-140, 40]],
			"startBinding": { "elementId": "box-tnef" },
			"endBinding": { "elementId": "box-step3" },
			"startArrowhead": null,
			"endArrowhead": "arrow"
		},
		{
			"type": "rectangle",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "box-step3",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 40,
			"y": 470,
			"strokeColor": "#2b8a3e",
			"backgroundColor": "#ebfbee",
			"width": 780,
			"height": 80,
			"seed": 1005,
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
			"id": "step3-title",
			"x": 60,
			"y": 485,
			"strokeColor": "#2b8a3e",
			"backgroundColor": "transparent",
			"width": 400,
			"height": 22,
			"angle": 0,
			"text": "③ サマリー（APPENDIX）への展開",
			"fontSize": 18,
			"fontFamily": 1,
			"textAlign": "left",
			"verticalAlign": "top"
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "step3-desc",
			"x": 60,
			"y": 515,
			"strokeColor": "#495057",
			"backgroundColor": "transparent",
			"width": 700,
			"height": 20,
			"angle": 0,
			"text": "文字化けのないプレーン本文 ＋ 添付ファイルを完全展開！",
			"fontSize": 14,
			"fontFamily": 1,
			"textAlign": "left",
			"verticalAlign": "top"
		}
	],
	"appState": {
		"viewBackgroundColor": "#ffffff",
		"gridSize": null
	}
}
```
