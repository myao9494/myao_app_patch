---

excalidraw-plugin: parsed
tags: [excalidraw]

---
<!--
/**
 * サポートの要否と種類の選び方（マニュアル 6章）
 * 
 * 1. 45°より寝た部分の有無 → 向きの見直し → 下のモデル面の有無で設定を選ぶ
 * 2. None / On build plate only / Everywhere
 * 3. 必要ならペイントで微調整
 **/
-->
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. For more info check in plugin settings under 'Saving'

# Excalidraw Data

## Text Elements
サポートの要否と種類の選び方（6章） ^t_title
45°より寝た
部分がある？ ^xq1
向きを変えて
減らせる？ ^xq2
下にモデルの
面がある？ ^xq3
一部だけ手で
調整したい？ ^xq4
サポートなし
Supports: None ^xN
向きを変えて
再確認 ^xR
ベッドからのみ
On build plate only ^xP
すべての面に
Everywhere ^xE
ペイントで微調整
(6-4) ^xM
そのままスライスへ ^xK
ある ^l1
いいえ ^l2
ない ^l3
はい ^l4
ない ^l5
ある ^l6
はい ^l7
いいえ ^l8

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
			"y": 0,
			"width": 520,
			"height": 35,
			"text": "サポートの要否と種類の選び方（6章）",
			"originalText": "サポートの要否と種類の選び方（6章）",
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
			"seed": 103001,
			"version": 1,
			"versionNonce": 203001,
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
			"type": "diamond",
			"id": "q1",
			"x": 40,
			"y": 175,
			"width": 240,
			"height": 150,
			"strokeColor": "#b45309",
			"backgroundColor": "#fef3c7",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 103002,
			"version": 1,
			"versionNonce": 203002,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": [
				{
					"id": "xq1",
					"type": "text"
				},
				{
					"id": "aQ12",
					"type": "arrow"
				},
				{
					"id": "aQ1N",
					"type": "arrow"
				},
				{
					"id": "aRQ1",
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
			"id": "xq1",
			"x": 97,
			"y": 228,
			"width": 126,
			"height": 45,
			"text": "45°より寝た\n部分がある？",
			"originalText": "45°より寝た\n部分がある？",
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
			"seed": 103003,
			"version": 1,
			"versionNonce": 203003,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": null,
			"link": null,
			"locked": false,
			"containerId": "q1",
			"lineHeight": 1.25
		},
		{
			"type": "diamond",
			"id": "q2",
			"x": 380,
			"y": 175,
			"width": 240,
			"height": 150,
			"strokeColor": "#b45309",
			"backgroundColor": "#fef3c7",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 103004,
			"version": 1,
			"versionNonce": 203004,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": [
				{
					"id": "xq2",
					"type": "text"
				},
				{
					"id": "aQ12",
					"type": "arrow"
				},
				{
					"id": "aQ23",
					"type": "arrow"
				},
				{
					"id": "aQ2R",
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
			"id": "xq2",
			"x": 446,
			"y": 228,
			"width": 108,
			"height": 45,
			"text": "向きを変えて\n減らせる？",
			"originalText": "向きを変えて\n減らせる？",
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
			"seed": 103005,
			"version": 1,
			"versionNonce": 203005,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": null,
			"link": null,
			"locked": false,
			"containerId": "q2",
			"lineHeight": 1.25
		},
		{
			"type": "diamond",
			"id": "q3",
			"x": 720,
			"y": 175,
			"width": 240,
			"height": 150,
			"strokeColor": "#b45309",
			"backgroundColor": "#fef3c7",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 103006,
			"version": 1,
			"versionNonce": 203006,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": [
				{
					"id": "xq3",
					"type": "text"
				},
				{
					"id": "aQ23",
					"type": "arrow"
				},
				{
					"id": "aQ3P",
					"type": "arrow"
				},
				{
					"id": "aQ3E",
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
			"id": "xq3",
			"x": 786,
			"y": 228,
			"width": 108,
			"height": 45,
			"text": "下にモデルの\n面がある？",
			"originalText": "下にモデルの\n面がある？",
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
			"seed": 103007,
			"version": 1,
			"versionNonce": 203007,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": null,
			"link": null,
			"locked": false,
			"containerId": "q3",
			"lineHeight": 1.25
		},
		{
			"type": "diamond",
			"id": "q4",
			"x": 1060,
			"y": 175,
			"width": 240,
			"height": 150,
			"strokeColor": "#b45309",
			"backgroundColor": "#fef3c7",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 103008,
			"version": 1,
			"versionNonce": 203008,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": [
				{
					"id": "xq4",
					"type": "text"
				},
				{
					"id": "aPQ4",
					"type": "arrow"
				},
				{
					"id": "aEQ4",
					"type": "arrow"
				},
				{
					"id": "aQ4M",
					"type": "arrow"
				},
				{
					"id": "aQ4K",
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
			"id": "xq4",
			"x": 1126,
			"y": 228,
			"width": 108,
			"height": 45,
			"text": "一部だけ手で\n調整したい？",
			"originalText": "一部だけ手で\n調整したい？",
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
			"seed": 103009,
			"version": 1,
			"versionNonce": 203009,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": null,
			"link": null,
			"locked": false,
			"containerId": "q4",
			"lineHeight": 1.25
		},
		{
			"type": "rectangle",
			"id": "bN",
			"x": 50,
			"y": 420,
			"width": 220,
			"height": 90,
			"strokeColor": "#047857",
			"backgroundColor": "#a7f3d0",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 103010,
			"version": 1,
			"versionNonce": 203010,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": [
				{
					"id": "xN",
					"type": "text"
				},
				{
					"id": "aQ1N",
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
			"id": "xN",
			"x": 85,
			"y": 442,
			"width": 151,
			"height": 45,
			"text": "サポートなし\nSupports: None",
			"originalText": "サポートなし\nSupports: None",
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
			"seed": 103011,
			"version": 1,
			"versionNonce": 203011,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": null,
			"link": null,
			"locked": false,
			"containerId": "bN",
			"lineHeight": 1.25
		},
		{
			"type": "rectangle",
			"id": "bR",
			"x": 390,
			"y": 40,
			"width": 220,
			"height": 80,
			"strokeColor": "#dc2626",
			"backgroundColor": "#fee2e2",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 103012,
			"version": 1,
			"versionNonce": 203012,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": [
				{
					"id": "xR",
					"type": "text"
				},
				{
					"id": "aQ2R",
					"type": "arrow"
				},
				{
					"id": "aRQ1",
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
			"id": "xR",
			"x": 446,
			"y": 58,
			"width": 108,
			"height": 45,
			"text": "向きを変えて\n再確認",
			"originalText": "向きを変えて\n再確認",
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
			"seed": 103013,
			"version": 1,
			"versionNonce": 203013,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": null,
			"link": null,
			"locked": false,
			"containerId": "bR",
			"lineHeight": 1.25
		},
		{
			"type": "rectangle",
			"id": "bP",
			"x": 730,
			"y": 40,
			"width": 220,
			"height": 90,
			"strokeColor": "#1e3a5f",
			"backgroundColor": "#93c5fd",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 103014,
			"version": 1,
			"versionNonce": 203014,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": [
				{
					"id": "xP",
					"type": "text"
				},
				{
					"id": "aQ3P",
					"type": "arrow"
				},
				{
					"id": "aPQ4",
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
			"id": "xP",
			"x": 743,
			"y": 62,
			"width": 194,
			"height": 45,
			"text": "ベッドからのみ\nOn build plate only",
			"originalText": "ベッドからのみ\nOn build plate only",
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
			"seed": 103015,
			"version": 1,
			"versionNonce": 203015,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": null,
			"link": null,
			"locked": false,
			"containerId": "bP",
			"lineHeight": 1.25
		},
		{
			"type": "rectangle",
			"id": "bE",
			"x": 730,
			"y": 420,
			"width": 220,
			"height": 90,
			"strokeColor": "#1e3a5f",
			"backgroundColor": "#93c5fd",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 103016,
			"version": 1,
			"versionNonce": 203016,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": [
				{
					"id": "xE",
					"type": "text"
				},
				{
					"id": "aQ3E",
					"type": "arrow"
				},
				{
					"id": "aEQ4",
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
			"id": "xE",
			"x": 786,
			"y": 442,
			"width": 108,
			"height": 45,
			"text": "すべての面に\nEverywhere",
			"originalText": "すべての面に\nEverywhere",
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
			"seed": 103017,
			"version": 1,
			"versionNonce": 203017,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": null,
			"link": null,
			"locked": false,
			"containerId": "bE",
			"lineHeight": 1.25
		},
		{
			"type": "rectangle",
			"id": "bM",
			"x": 1400,
			"y": 120,
			"width": 240,
			"height": 90,
			"strokeColor": "#c2410c",
			"backgroundColor": "#fed7aa",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 103018,
			"version": 1,
			"versionNonce": 203018,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": [
				{
					"id": "xM",
					"type": "text"
				},
				{
					"id": "aQ4M",
					"type": "arrow"
				},
				{
					"id": "aMK",
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
			"id": "xM",
			"x": 1448,
			"y": 142,
			"width": 144,
			"height": 45,
			"text": "ペイントで微調整\n(6-4)",
			"originalText": "ペイントで微調整\n(6-4)",
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
			"seed": 103019,
			"version": 1,
			"versionNonce": 203019,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": null,
			"link": null,
			"locked": false,
			"containerId": "bM",
			"lineHeight": 1.25
		},
		{
			"type": "rectangle",
			"id": "bK",
			"x": 1400,
			"y": 290,
			"width": 240,
			"height": 90,
			"strokeColor": "#047857",
			"backgroundColor": "#a7f3d0",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 103020,
			"version": 1,
			"versionNonce": 203020,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": [
				{
					"id": "xK",
					"type": "text"
				},
				{
					"id": "aQ4K",
					"type": "arrow"
				},
				{
					"id": "aMK",
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
			"id": "xK",
			"x": 1439,
			"y": 324,
			"width": 162,
			"height": 23,
			"text": "そのままスライスへ",
			"originalText": "そのままスライスへ",
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
			"seed": 103021,
			"version": 1,
			"versionNonce": 203021,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": null,
			"link": null,
			"locked": false,
			"containerId": "bK",
			"lineHeight": 1.25
		},
		{
			"type": "arrow",
			"id": "aQ12",
			"x": 282,
			"y": 250,
			"width": 96,
			"height": 0,
			"strokeColor": "#b45309",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 103022,
			"version": 1,
			"versionNonce": 203022,
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
					96,
					0
				]
			],
			"startBinding": {
				"elementId": "q1",
				"focus": 0,
				"gap": 2
			},
			"endBinding": {
				"elementId": "q2",
				"focus": 0,
				"gap": 2
			},
			"startArrowhead": null,
			"endArrowhead": "arrow",
			"roundness": null
		},
		{
			"type": "arrow",
			"id": "aQ23",
			"x": 622,
			"y": 250,
			"width": 96,
			"height": 0,
			"strokeColor": "#b45309",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 103023,
			"version": 1,
			"versionNonce": 203023,
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
					96,
					0
				]
			],
			"startBinding": {
				"elementId": "q2",
				"focus": 0,
				"gap": 2
			},
			"endBinding": {
				"elementId": "q3",
				"focus": 0,
				"gap": 2
			},
			"startArrowhead": null,
			"endArrowhead": "arrow",
			"roundness": null
		},
		{
			"type": "arrow",
			"id": "aQ1N",
			"x": 160,
			"y": 327,
			"width": 0,
			"height": 91,
			"strokeColor": "#047857",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 103024,
			"version": 1,
			"versionNonce": 203024,
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
					91
				]
			],
			"startBinding": {
				"elementId": "q1",
				"focus": 0,
				"gap": 2
			},
			"endBinding": {
				"elementId": "bN",
				"focus": 0,
				"gap": 2
			},
			"startArrowhead": null,
			"endArrowhead": "arrow",
			"roundness": null
		},
		{
			"type": "arrow",
			"id": "aQ2R",
			"x": 500,
			"y": 173,
			"width": 0,
			"height": 51,
			"strokeColor": "#dc2626",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "dashed",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 103025,
			"version": 1,
			"versionNonce": 203025,
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
					-51
				]
			],
			"startBinding": {
				"elementId": "q2",
				"focus": 0,
				"gap": 2
			},
			"endBinding": {
				"elementId": "bR",
				"focus": 0,
				"gap": 2
			},
			"startArrowhead": null,
			"endArrowhead": "arrow",
			"roundness": null
		},
		{
			"type": "arrow",
			"id": "aRQ1",
			"x": 388,
			"y": 80,
			"width": 228,
			"height": 93,
			"strokeColor": "#dc2626",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "dashed",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 103026,
			"version": 1,
			"versionNonce": 203026,
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
					-228,
					0
				],
				[
					-228,
					93
				]
			],
			"startBinding": {
				"elementId": "bR",
				"focus": 0,
				"gap": 2
			},
			"endBinding": {
				"elementId": "q1",
				"focus": 0,
				"gap": 2
			},
			"startArrowhead": null,
			"endArrowhead": "arrow",
			"roundness": null
		},
		{
			"type": "arrow",
			"id": "aQ3P",
			"x": 840,
			"y": 173,
			"width": 0,
			"height": 41,
			"strokeColor": "#1e3a5f",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 103027,
			"version": 1,
			"versionNonce": 203027,
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
					-41
				]
			],
			"startBinding": {
				"elementId": "q3",
				"focus": 0,
				"gap": 2
			},
			"endBinding": {
				"elementId": "bP",
				"focus": 0,
				"gap": 2
			},
			"startArrowhead": null,
			"endArrowhead": "arrow",
			"roundness": null
		},
		{
			"type": "arrow",
			"id": "aQ3E",
			"x": 840,
			"y": 327,
			"width": 0,
			"height": 91,
			"strokeColor": "#1e3a5f",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 103028,
			"version": 1,
			"versionNonce": 203028,
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
					91
				]
			],
			"startBinding": {
				"elementId": "q3",
				"focus": 0,
				"gap": 2
			},
			"endBinding": {
				"elementId": "bE",
				"focus": 0,
				"gap": 2
			},
			"startArrowhead": null,
			"endArrowhead": "arrow",
			"roundness": null
		},
		{
			"type": "arrow",
			"id": "aPQ4",
			"x": 952,
			"y": 85,
			"width": 228,
			"height": 88,
			"strokeColor": "#1e3a5f",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 103029,
			"version": 1,
			"versionNonce": 203029,
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
					228,
					0
				],
				[
					228,
					88
				]
			],
			"startBinding": {
				"elementId": "bP",
				"focus": 0,
				"gap": 2
			},
			"endBinding": {
				"elementId": "q4",
				"focus": 0,
				"gap": 2
			},
			"startArrowhead": null,
			"endArrowhead": "arrow",
			"roundness": null
		},
		{
			"type": "arrow",
			"id": "aEQ4",
			"x": 952,
			"y": 465,
			"width": 228,
			"height": 138,
			"strokeColor": "#1e3a5f",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 103030,
			"version": 1,
			"versionNonce": 203030,
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
					228,
					0
				],
				[
					228,
					-138
				]
			],
			"startBinding": {
				"elementId": "bE",
				"focus": 0,
				"gap": 2
			},
			"endBinding": {
				"elementId": "q4",
				"focus": 0,
				"gap": 2
			},
			"startArrowhead": null,
			"endArrowhead": "arrow",
			"roundness": null
		},
		{
			"type": "arrow",
			"id": "aQ4M",
			"x": 1302,
			"y": 250,
			"width": 96,
			"height": 85,
			"strokeColor": "#c2410c",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 103031,
			"version": 1,
			"versionNonce": 203031,
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
					48,
					0
				],
				[
					48,
					-85
				],
				[
					96,
					-85
				]
			],
			"startBinding": {
				"elementId": "q4",
				"focus": 0,
				"gap": 2
			},
			"endBinding": {
				"elementId": "bM",
				"focus": 0,
				"gap": 2
			},
			"startArrowhead": null,
			"endArrowhead": "arrow",
			"roundness": null
		},
		{
			"type": "arrow",
			"id": "aQ4K",
			"x": 1302,
			"y": 250,
			"width": 96,
			"height": 85,
			"strokeColor": "#047857",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 103032,
			"version": 1,
			"versionNonce": 203032,
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
					48,
					0
				],
				[
					48,
					85
				],
				[
					96,
					85
				]
			],
			"startBinding": {
				"elementId": "q4",
				"focus": 0,
				"gap": 2
			},
			"endBinding": {
				"elementId": "bK",
				"focus": 0,
				"gap": 2
			},
			"startArrowhead": null,
			"endArrowhead": "arrow",
			"roundness": null
		},
		{
			"type": "arrow",
			"id": "aMK",
			"x": 1520,
			"y": 212,
			"width": 0,
			"height": 76,
			"strokeColor": "#c2410c",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 103033,
			"version": 1,
			"versionNonce": 203033,
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
					76
				]
			],
			"startBinding": {
				"elementId": "bM",
				"focus": 0,
				"gap": 2
			},
			"endBinding": {
				"elementId": "bK",
				"focus": 0,
				"gap": 2
			},
			"startArrowhead": null,
			"endArrowhead": "arrow",
			"roundness": null
		},
		{
			"type": "text",
			"id": "l1",
			"x": 298,
			"y": 224,
			"width": 36,
			"height": 20,
			"text": "ある",
			"originalText": "ある",
			"fontSize": 16,
			"fontFamily": 3,
			"textAlign": "left",
			"verticalAlign": "top",
			"strokeColor": "#b45309",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 103034,
			"version": 1,
			"versionNonce": 203034,
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
			"id": "l2",
			"x": 634,
			"y": 224,
			"width": 54,
			"height": 20,
			"text": "いいえ",
			"originalText": "いいえ",
			"fontSize": 16,
			"fontFamily": 3,
			"textAlign": "left",
			"verticalAlign": "top",
			"strokeColor": "#b45309",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 103035,
			"version": 1,
			"versionNonce": 203035,
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
			"id": "l3",
			"x": 172,
			"y": 362,
			"width": 36,
			"height": 20,
			"text": "ない",
			"originalText": "ない",
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
			"seed": 103036,
			"version": 1,
			"versionNonce": 203036,
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
			"id": "l4",
			"x": 512,
			"y": 135,
			"width": 36,
			"height": 20,
			"text": "はい",
			"originalText": "はい",
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
			"seed": 103037,
			"version": 1,
			"versionNonce": 203037,
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
			"id": "l5",
			"x": 852,
			"y": 140,
			"width": 36,
			"height": 20,
			"text": "ない",
			"originalText": "ない",
			"fontSize": 16,
			"fontFamily": 3,
			"textAlign": "left",
			"verticalAlign": "top",
			"strokeColor": "#1e3a5f",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 103038,
			"version": 1,
			"versionNonce": 203038,
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
			"id": "l6",
			"x": 852,
			"y": 362,
			"width": 36,
			"height": 20,
			"text": "ある",
			"originalText": "ある",
			"fontSize": 16,
			"fontFamily": 3,
			"textAlign": "left",
			"verticalAlign": "top",
			"strokeColor": "#1e3a5f",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 103039,
			"version": 1,
			"versionNonce": 203039,
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
			"id": "l7",
			"x": 1296,
			"y": 205,
			"width": 36,
			"height": 20,
			"text": "はい",
			"originalText": "はい",
			"fontSize": 16,
			"fontFamily": 3,
			"textAlign": "left",
			"verticalAlign": "top",
			"strokeColor": "#c2410c",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 103040,
			"version": 1,
			"versionNonce": 203040,
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
			"id": "l8",
			"x": 1290,
			"y": 290,
			"width": 54,
			"height": 20,
			"text": "いいえ",
			"originalText": "いいえ",
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
			"seed": 103041,
			"version": 1,
			"versionNonce": 203041,
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