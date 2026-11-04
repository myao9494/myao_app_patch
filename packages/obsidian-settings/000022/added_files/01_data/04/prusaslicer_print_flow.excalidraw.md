---

excalidraw-plugin: parsed
tags: [excalidraw]

---
<!--
/**
 * Printrun で造形する流れ（マニュアル 8章）
 * 
 * 1. G-code 保存 → Printrun 起動・USB 接続 → 読込 → 加熱 → 印刷開始
 * 2. 1層目を確認してから席に戻る（NG なら停止して原因を確認）
 * 3. 完了後は冷却してから取り外す
 **/
-->
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. For more info check in plugin settings under 'Saving'

# Excalidraw Data

## Text Elements
Printrun で造形する流れ（8章） ^t_title
① G-code を
保存する ^x1
② Printrun 起動
USB 接続 ^x2
③ G-code を
読み込む ^x3
④ ノズル・ベッド
を加熱する ^x4
⑤ 印刷開始 ^x5
⑥ 1層目は
OK？ ^x6
⑦ 席に戻って
印刷を続ける ^x7
⑧ 完了・冷却
取り外す ^x8
OK ^l_ok
NG → 停止して原因を確認し、やり直す（11章） ^l_ng
席に戻る前に必ず確認 ^w1

## Drawing
```json
{
	"type": "excalidraw",
	"version": 2,
	"source": "https://excalidraw.com",
	"elements": [
		{
			"type": "text",
			"id": "t_title",
			"x": 40,
			"y": 20,
			"width": 520,
			"height": 35,
			"text": "Printrun で造形する流れ（8章）",
			"originalText": "Printrun で造形する流れ（8章）",
			"fontSize": 28,
			"fontFamily": 3,
			"textAlign": "left",
			"verticalAlign": "top",
			"strokeColor": "#1e40af",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 101001,
			"version": 1,
			"versionNonce": 201001,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": null,
			"link": null,
			"locked": false,
			"containerId": null,
			"lineHeight": 1.25
		},
		{
			"type": "rectangle",
			"id": "b1",
			"x": 40,
			"y": 140,
			"width": 180,
			"height": 90,
			"strokeColor": "#c2410c",
			"backgroundColor": "#fed7aa",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 101002,
			"version": 1,
			"versionNonce": 201002,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": [
				{
					"id": "x1",
					"type": "text"
				},
				{
					"id": "a12",
					"type": "arrow"
				}
			],
			"link": null,
			"locked": false,
			"roundness": {
				"type": 3
			}
		},
		{
			"type": "text",
			"id": "x1",
			"x": 48,
			"y": 162,
			"width": 164,
			"height": 45,
			"text": "① G-code を\n保存する",
			"originalText": "① G-code を\n保存する",
			"fontSize": 18,
			"fontFamily": 3,
			"textAlign": "center",
			"verticalAlign": "middle",
			"strokeColor": "#374151",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 101003,
			"version": 1,
			"versionNonce": 201003,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": null,
			"link": null,
			"locked": false,
			"containerId": "b1",
			"lineHeight": 1.25
		},
		{
			"type": "rectangle",
			"id": "b2",
			"x": 280,
			"y": 140,
			"width": 180,
			"height": 90,
			"strokeColor": "#1e3a5f",
			"backgroundColor": "#93c5fd",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 101004,
			"version": 1,
			"versionNonce": 201004,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": [
				{
					"id": "x2",
					"type": "text"
				},
				{
					"id": "a12",
					"type": "arrow"
				},
				{
					"id": "a23",
					"type": "arrow"
				}
			],
			"link": null,
			"locked": false,
			"roundness": {
				"type": 3
			}
		},
		{
			"type": "text",
			"id": "x2",
			"x": 298,
			"y": 162,
			"width": 144,
			"height": 45,
			"text": "② Printrun 起動\nUSB 接続",
			"originalText": "② Printrun 起動\nUSB 接続",
			"fontSize": 18,
			"fontFamily": 3,
			"textAlign": "center",
			"verticalAlign": "middle",
			"strokeColor": "#374151",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 101005,
			"version": 1,
			"versionNonce": 201005,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": null,
			"link": null,
			"locked": false,
			"containerId": "b2",
			"lineHeight": 1.25
		},
		{
			"type": "rectangle",
			"id": "b3",
			"x": 520,
			"y": 140,
			"width": 180,
			"height": 90,
			"strokeColor": "#1e3a5f",
			"backgroundColor": "#93c5fd",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 101006,
			"version": 1,
			"versionNonce": 201006,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": [
				{
					"id": "x3",
					"type": "text"
				},
				{
					"id": "a23",
					"type": "arrow"
				},
				{
					"id": "a34",
					"type": "arrow"
				},
				{
					"id": "aloop",
					"type": "arrow"
				}
			],
			"link": null,
			"locked": false,
			"roundness": {
				"type": 3
			}
		},
		{
			"type": "text",
			"id": "x3",
			"x": 538,
			"y": 162,
			"width": 144,
			"height": 45,
			"text": "③ G-code を\n読み込む",
			"originalText": "③ G-code を\n読み込む",
			"fontSize": 18,
			"fontFamily": 3,
			"textAlign": "center",
			"verticalAlign": "middle",
			"strokeColor": "#374151",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 101007,
			"version": 1,
			"versionNonce": 201007,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": null,
			"link": null,
			"locked": false,
			"containerId": "b3",
			"lineHeight": 1.25
		},
		{
			"type": "rectangle",
			"id": "b4",
			"x": 760,
			"y": 140,
			"width": 180,
			"height": 90,
			"strokeColor": "#1e3a5f",
			"backgroundColor": "#93c5fd",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 101008,
			"version": 1,
			"versionNonce": 201008,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": [
				{
					"id": "x4",
					"type": "text"
				},
				{
					"id": "a34",
					"type": "arrow"
				},
				{
					"id": "a45",
					"type": "arrow"
				}
			],
			"link": null,
			"locked": false,
			"roundness": {
				"type": 3
			}
		},
		{
			"type": "text",
			"id": "x4",
			"x": 770,
			"y": 162,
			"width": 160,
			"height": 45,
			"text": "④ ノズル・ベッド\nを加熱する",
			"originalText": "④ ノズル・ベッド\nを加熱する",
			"fontSize": 18,
			"fontFamily": 3,
			"textAlign": "center",
			"verticalAlign": "middle",
			"strokeColor": "#374151",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 101009,
			"version": 1,
			"versionNonce": 201009,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": null,
			"link": null,
			"locked": false,
			"containerId": "b4",
			"lineHeight": 1.25
		},
		{
			"type": "rectangle",
			"id": "b5",
			"x": 1000,
			"y": 140,
			"width": 180,
			"height": 90,
			"strokeColor": "#1e3a5f",
			"backgroundColor": "#93c5fd",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 101010,
			"version": 1,
			"versionNonce": 201010,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": [
				{
					"id": "x5",
					"type": "text"
				},
				{
					"id": "a45",
					"type": "arrow"
				},
				{
					"id": "a5d",
					"type": "arrow"
				}
			],
			"link": null,
			"locked": false,
			"roundness": {
				"type": 3
			}
		},
		{
			"type": "text",
			"id": "x5",
			"x": 1036,
			"y": 173,
			"width": 108,
			"height": 23,
			"text": "⑤ 印刷開始",
			"originalText": "⑤ 印刷開始",
			"fontSize": 18,
			"fontFamily": 3,
			"textAlign": "center",
			"verticalAlign": "middle",
			"strokeColor": "#374151",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 101011,
			"version": 1,
			"versionNonce": 201011,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": null,
			"link": null,
			"locked": false,
			"containerId": "b5",
			"lineHeight": 1.25
		},
		{
			"type": "diamond",
			"id": "d6",
			"x": 1000,
			"y": 350,
			"width": 180,
			"height": 130,
			"strokeColor": "#dc2626",
			"backgroundColor": "#fee2e2",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 101012,
			"version": 1,
			"versionNonce": 201012,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": [
				{
					"id": "x6",
					"type": "text"
				},
				{
					"id": "a5d",
					"type": "arrow"
				},
				{
					"id": "ad7",
					"type": "arrow"
				},
				{
					"id": "aloop",
					"type": "arrow"
				}
			],
			"link": null,
			"locked": false,
			"roundness": {
				"type": 2
			}
		},
		{
			"type": "text",
			"id": "x6",
			"x": 1027,
			"y": 393,
			"width": 126,
			"height": 45,
			"text": "⑥ 1層目は\nOK？",
			"originalText": "⑥ 1層目は\nOK？",
			"fontSize": 18,
			"fontFamily": 3,
			"textAlign": "center",
			"verticalAlign": "middle",
			"strokeColor": "#374151",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 101013,
			"version": 1,
			"versionNonce": 201013,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": null,
			"link": null,
			"locked": false,
			"containerId": "d6",
			"lineHeight": 1.25
		},
		{
			"type": "rectangle",
			"id": "b7",
			"x": 760,
			"y": 370,
			"width": 180,
			"height": 90,
			"strokeColor": "#1e3a5f",
			"backgroundColor": "#93c5fd",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 101014,
			"version": 1,
			"versionNonce": 201014,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": [
				{
					"id": "x7",
					"type": "text"
				},
				{
					"id": "ad7",
					"type": "arrow"
				},
				{
					"id": "a78",
					"type": "arrow"
				}
			],
			"link": null,
			"locked": false,
			"roundness": {
				"type": 3
			}
		},
		{
			"type": "text",
			"id": "x7",
			"x": 772,
			"y": 392,
			"width": 156,
			"height": 45,
			"text": "⑦ 席に戻って\n印刷を続ける",
			"originalText": "⑦ 席に戻って\n印刷を続ける",
			"fontSize": 18,
			"fontFamily": 3,
			"textAlign": "center",
			"verticalAlign": "middle",
			"strokeColor": "#374151",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 101015,
			"version": 1,
			"versionNonce": 201015,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": null,
			"link": null,
			"locked": false,
			"containerId": "b7",
			"lineHeight": 1.25
		},
		{
			"type": "rectangle",
			"id": "b8",
			"x": 520,
			"y": 370,
			"width": 180,
			"height": 90,
			"strokeColor": "#047857",
			"backgroundColor": "#a7f3d0",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 101016,
			"version": 1,
			"versionNonce": 201016,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": [
				{
					"id": "x8",
					"type": "text"
				},
				{
					"id": "a78",
					"type": "arrow"
				}
			],
			"link": null,
			"locked": false,
			"roundness": {
				"type": 3
			}
		},
		{
			"type": "text",
			"id": "x8",
			"x": 550,
			"y": 392,
			"width": 120,
			"height": 45,
			"text": "⑧ 完了・冷却\n取り外す",
			"originalText": "⑧ 完了・冷却\n取り外す",
			"fontSize": 18,
			"fontFamily": 3,
			"textAlign": "center",
			"verticalAlign": "middle",
			"strokeColor": "#374151",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 101017,
			"version": 1,
			"versionNonce": 201017,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": null,
			"link": null,
			"locked": false,
			"containerId": "b8",
			"lineHeight": 1.25
		},
		{
			"type": "arrow",
			"id": "a12",
			"x": 222,
			"y": 185,
			"width": 56,
			"height": 0,
			"strokeColor": "#1e3a5f",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 101018,
			"version": 1,
			"versionNonce": 201018,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": null,
			"link": null,
			"locked": false,
			"points": [
				[
					0,
					0
				],
				[
					56,
					0
				]
			],
			"startBinding": {
				"elementId": "b1",
				"focus": 0,
				"gap": 2
			},
			"endBinding": {
				"elementId": "b2",
				"focus": 0,
				"gap": 2
			},
			"startArrowhead": null,
			"endArrowhead": "arrow",
			"roundness": null
		},
		{
			"type": "arrow",
			"id": "a23",
			"x": 462,
			"y": 185,
			"width": 56,
			"height": 0,
			"strokeColor": "#1e3a5f",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 101019,
			"version": 1,
			"versionNonce": 201019,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": null,
			"link": null,
			"locked": false,
			"points": [
				[
					0,
					0
				],
				[
					56,
					0
				]
			],
			"startBinding": {
				"elementId": "b2",
				"focus": 0,
				"gap": 2
			},
			"endBinding": {
				"elementId": "b3",
				"focus": 0,
				"gap": 2
			},
			"startArrowhead": null,
			"endArrowhead": "arrow",
			"roundness": null
		},
		{
			"type": "arrow",
			"id": "a34",
			"x": 702,
			"y": 185,
			"width": 56,
			"height": 0,
			"strokeColor": "#1e3a5f",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 101020,
			"version": 1,
			"versionNonce": 201020,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": null,
			"link": null,
			"locked": false,
			"points": [
				[
					0,
					0
				],
				[
					56,
					0
				]
			],
			"startBinding": {
				"elementId": "b3",
				"focus": 0,
				"gap": 2
			},
			"endBinding": {
				"elementId": "b4",
				"focus": 0,
				"gap": 2
			},
			"startArrowhead": null,
			"endArrowhead": "arrow",
			"roundness": null
		},
		{
			"type": "arrow",
			"id": "a45",
			"x": 942,
			"y": 185,
			"width": 56,
			"height": 0,
			"strokeColor": "#1e3a5f",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 101021,
			"version": 1,
			"versionNonce": 201021,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": null,
			"link": null,
			"locked": false,
			"points": [
				[
					0,
					0
				],
				[
					56,
					0
				]
			],
			"startBinding": {
				"elementId": "b4",
				"focus": 0,
				"gap": 2
			},
			"endBinding": {
				"elementId": "b5",
				"focus": 0,
				"gap": 2
			},
			"startArrowhead": null,
			"endArrowhead": "arrow",
			"roundness": null
		},
		{
			"type": "arrow",
			"id": "a5d",
			"x": 1090,
			"y": 232,
			"width": 0,
			"height": 116,
			"strokeColor": "#1e3a5f",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 101022,
			"version": 1,
			"versionNonce": 201022,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": null,
			"link": null,
			"locked": false,
			"points": [
				[
					0,
					0
				],
				[
					0,
					116
				]
			],
			"startBinding": {
				"elementId": "b5",
				"focus": 0,
				"gap": 2
			},
			"endBinding": {
				"elementId": "d6",
				"focus": 0,
				"gap": 2
			},
			"startArrowhead": null,
			"endArrowhead": "arrow",
			"roundness": null
		},
		{
			"type": "arrow",
			"id": "ad7",
			"x": 998,
			"y": 415,
			"width": 56,
			"height": 0,
			"strokeColor": "#047857",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 101023,
			"version": 1,
			"versionNonce": 201023,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": null,
			"link": null,
			"locked": false,
			"points": [
				[
					0,
					0
				],
				[
					-56,
					0
				]
			],
			"startBinding": {
				"elementId": "d6",
				"focus": 0,
				"gap": 2
			},
			"endBinding": {
				"elementId": "b7",
				"focus": 0,
				"gap": 2
			},
			"startArrowhead": null,
			"endArrowhead": "arrow",
			"roundness": null
		},
		{
			"type": "arrow",
			"id": "a78",
			"x": 758,
			"y": 415,
			"width": 56,
			"height": 0,
			"strokeColor": "#1e3a5f",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 101024,
			"version": 1,
			"versionNonce": 201024,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": null,
			"link": null,
			"locked": false,
			"points": [
				[
					0,
					0
				],
				[
					-56,
					0
				]
			],
			"startBinding": {
				"elementId": "b7",
				"focus": 0,
				"gap": 2
			},
			"endBinding": {
				"elementId": "b8",
				"focus": 0,
				"gap": 2
			},
			"startArrowhead": null,
			"endArrowhead": "arrow",
			"roundness": null
		},
		{
			"type": "arrow",
			"id": "aloop",
			"x": 1182,
			"y": 415,
			"width": 640,
			"height": 315,
			"strokeColor": "#dc2626",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "dashed",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 101025,
			"version": 1,
			"versionNonce": 201025,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": null,
			"link": null,
			"locked": false,
			"points": [
				[
					0,
					0
				],
				[
					70,
					0
				],
				[
					70,
					-315
				],
				[
					-570,
					-315
				],
				[
					-570,
					-275
				]
			],
			"startBinding": {
				"elementId": "d6",
				"focus": 0,
				"gap": 2
			},
			"endBinding": {
				"elementId": "b3",
				"focus": 0,
				"gap": 2
			},
			"startArrowhead": null,
			"endArrowhead": "arrow",
			"roundness": null
		},
		{
			"type": "text",
			"id": "l_ok",
			"x": 960,
			"y": 383,
			"width": 28,
			"height": 20,
			"text": "OK",
			"originalText": "OK",
			"fontSize": 16,
			"fontFamily": 3,
			"textAlign": "left",
			"verticalAlign": "top",
			"strokeColor": "#047857",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 101026,
			"version": 1,
			"versionNonce": 201026,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": null,
			"link": null,
			"locked": false,
			"containerId": null,
			"lineHeight": 1.25
		},
		{
			"type": "text",
			"id": "l_ng",
			"x": 700,
			"y": 68,
			"width": 480,
			"height": 20,
			"text": "NG → 停止して原因を確認し、やり直す（11章）",
			"originalText": "NG → 停止して原因を確認し、やり直す（11章）",
			"fontSize": 16,
			"fontFamily": 3,
			"textAlign": "left",
			"verticalAlign": "top",
			"strokeColor": "#dc2626",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 101027,
			"version": 1,
			"versionNonce": 201027,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": null,
			"link": null,
			"locked": false,
			"containerId": null,
			"lineHeight": 1.25
		},
		{
			"type": "text",
			"id": "w1",
			"x": 960,
			"y": 490,
			"width": 260,
			"height": 20,
			"text": "席に戻る前に必ず確認",
			"originalText": "席に戻る前に必ず確認",
			"fontSize": 18,
			"fontFamily": 3,
			"textAlign": "left",
			"verticalAlign": "top",
			"strokeColor": "#dc2626",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 105001,
			"version": 1,
			"versionNonce": 205001,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": null,
			"link": null,
			"locked": false,
			"containerId": null,
			"lineHeight": 1.25
		}
	],
	"appState": {
		"viewBackgroundColor": "#ffffff",
		"gridSize": null
	}
}
```
%%