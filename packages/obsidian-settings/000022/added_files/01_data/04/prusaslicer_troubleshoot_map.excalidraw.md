---

excalidraw-plugin: parsed
tags: [excalidraw]

---
<!--
/**
 * 困ったときの症状別ガイド（マニュアル 11章）
 * 
 * 1. 6つの症状（1層目・反り・糸引き・ずれ・サポート・設定読込）と主な対処
 **/
-->
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. For more info check in plugin settings under 'Saving'

# Excalidraw Data

## Text Elements
困ったときの症状別ガイド（11章） ^t_title
番号は 11-1 〜 11-6 の節に対応している ^t_sub
困ったとき ^xc0
① 1層目がつかない ^xsL1
テーブルの糊を確認
部屋を 20℃ 以上に
ブリムを付ける ^fL1
② 角が反って浮く ^xsL2
ブリムを付ける
囲い・風よけを使う
ファン速度の調整 ^fL2
③ 糸を引く ^xsL3
温度を 5〜10℃ 下げる
リトラクションの調整 ^fL3
④ 途中で位置がずれる ^xsR1
ベルトの張り
プーリーの止めネジ
（機械側の問題） ^fR1
⑤ サポートが出ない
外れない ^xsR2
Supports が None のまま？
Overhang threshold
Contact Z distance ^fR2
⑥ 設定が読めない ^xsR3
Config と Bundle の取り違え
2.9 系と 3.0 系の違い ^fR3

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
			"width": 560,
			"height": 35,
			"text": "困ったときの症状別ガイド（11章）",
			"originalText": "困ったときの症状別ガイド（11章）",
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
			"seed": 104001,
			"version": 1,
			"versionNonce": 204001,
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
			"id": "t_sub",
			"x": 40,
			"y": 62,
			"width": 520,
			"height": 20,
			"text": "番号は 11-1 〜 11-6 の節に対応している",
			"originalText": "番号は 11-1 〜 11-6 の節に対応している",
			"fontSize": 16,
			"fontFamily": 3,
			"textAlign": "left",
			"verticalAlign": "top",
			"strokeColor": "#64748b",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 104002,
			"version": 1,
			"versionNonce": 204002,
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
			"type": "ellipse",
			"id": "c0",
			"x": 640,
			"y": 330,
			"width": 240,
			"height": 110,
			"strokeColor": "#dc2626",
			"backgroundColor": "#fee2e2",
			"fillStyle": "solid",
			"strokeWidth": 3,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 104003,
			"version": 1,
			"versionNonce": 204003,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": [
				{
					"id": "xc0",
					"type": "text"
				},
				{
					"id": "aL1",
					"type": "arrow"
				},
				{
					"id": "aL2",
					"type": "arrow"
				},
				{
					"id": "aL3",
					"type": "arrow"
				},
				{
					"id": "aR1",
					"type": "arrow"
				},
				{
					"id": "aR2",
					"type": "arrow"
				},
				{
					"id": "aR3",
					"type": "arrow"
				}
			],
			"link": null,
			"locked": false
		},
		{
			"type": "text",
			"id": "xc0",
			"x": 710,
			"y": 372,
			"width": 100,
			"height": 25,
			"text": "困ったとき",
			"originalText": "困ったとき",
			"fontSize": 20,
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
			"seed": 104004,
			"version": 1,
			"versionNonce": 204004,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": null,
			"link": null,
			"locked": false,
			"containerId": "c0",
			"lineHeight": 1.25
		},
		{
			"type": "rectangle",
			"id": "sL1",
			"x": 300,
			"y": 100,
			"width": 250,
			"height": 70,
			"strokeColor": "#c2410c",
			"backgroundColor": "#fed7aa",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 104005,
			"version": 1,
			"versionNonce": 204005,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": [
				{
					"id": "xsL1",
					"type": "text"
				},
				{
					"id": "aL1",
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
			"id": "xsL1",
			"x": 345,
			"y": 124,
			"width": 160,
			"height": 23,
			"text": "① 1層目がつかない",
			"originalText": "① 1層目がつかない",
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
			"seed": 104006,
			"version": 1,
			"versionNonce": 204006,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": null,
			"link": null,
			"locked": false,
			"containerId": "sL1",
			"lineHeight": 1.25
		},
		{
			"type": "text",
			"id": "fL1",
			"x": 20,
			"y": 107,
			"width": 260,
			"height": 57,
			"text": "テーブルの糊を確認\n部屋を 20℃ 以上に\nブリムを付ける",
			"originalText": "テーブルの糊を確認\n部屋を 20℃ 以上に\nブリムを付ける",
			"fontSize": 15,
			"fontFamily": 3,
			"textAlign": "right",
			"verticalAlign": "top",
			"strokeColor": "#374151",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 104007,
			"version": 1,
			"versionNonce": 204007,
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
			"id": "sL2",
			"x": 300,
			"y": 350,
			"width": 250,
			"height": 70,
			"strokeColor": "#c2410c",
			"backgroundColor": "#fed7aa",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 104008,
			"version": 1,
			"versionNonce": 204008,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": [
				{
					"id": "xsL2",
					"type": "text"
				},
				{
					"id": "aL2",
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
			"id": "xsL2",
			"x": 341,
			"y": 374,
			"width": 167,
			"height": 23,
			"text": "② 角が反って浮く",
			"originalText": "② 角が反って浮く",
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
			"seed": 104009,
			"version": 1,
			"versionNonce": 204009,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": null,
			"link": null,
			"locked": false,
			"containerId": "sL2",
			"lineHeight": 1.25
		},
		{
			"type": "text",
			"id": "fL2",
			"x": 20,
			"y": 357,
			"width": 260,
			"height": 57,
			"text": "ブリムを付ける\n囲い・風よけを使う\nファン速度の調整",
			"originalText": "ブリムを付ける\n囲い・風よけを使う\nファン速度の調整",
			"fontSize": 15,
			"fontFamily": 3,
			"textAlign": "right",
			"verticalAlign": "top",
			"strokeColor": "#374151",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 104010,
			"version": 1,
			"versionNonce": 204010,
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
			"id": "sL3",
			"x": 300,
			"y": 600,
			"width": 250,
			"height": 70,
			"strokeColor": "#c2410c",
			"backgroundColor": "#fed7aa",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 104011,
			"version": 1,
			"versionNonce": 204011,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": [
				{
					"id": "xsL3",
					"type": "text"
				},
				{
					"id": "aL3",
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
			"id": "xsL3",
			"x": 368,
			"y": 624,
			"width": 113,
			"height": 23,
			"text": "③ 糸を引く",
			"originalText": "③ 糸を引く",
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
			"seed": 104012,
			"version": 1,
			"versionNonce": 204012,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": null,
			"link": null,
			"locked": false,
			"containerId": "sL3",
			"lineHeight": 1.25
		},
		{
			"type": "text",
			"id": "fL3",
			"x": 20,
			"y": 616,
			"width": 260,
			"height": 38,
			"text": "温度を 5〜10℃ 下げる\nリトラクションの調整",
			"originalText": "温度を 5〜10℃ 下げる\nリトラクションの調整",
			"fontSize": 15,
			"fontFamily": 3,
			"textAlign": "right",
			"verticalAlign": "top",
			"strokeColor": "#374151",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 104013,
			"version": 1,
			"versionNonce": 204013,
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
			"id": "sR1",
			"x": 970,
			"y": 100,
			"width": 250,
			"height": 70,
			"strokeColor": "#c2410c",
			"backgroundColor": "#fed7aa",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 104014,
			"version": 1,
			"versionNonce": 204014,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": [
				{
					"id": "xsR1",
					"type": "text"
				},
				{
					"id": "aR1",
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
			"id": "xsR1",
			"x": 1002,
			"y": 124,
			"width": 185,
			"height": 23,
			"text": "④ 途中で位置がずれる",
			"originalText": "④ 途中で位置がずれる",
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
			"seed": 104015,
			"version": 1,
			"versionNonce": 204015,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": null,
			"link": null,
			"locked": false,
			"containerId": "sR1",
			"lineHeight": 1.25
		},
		{
			"type": "text",
			"id": "fR1",
			"x": 1240,
			"y": 107,
			"width": 300,
			"height": 57,
			"text": "ベルトの張り\nプーリーの止めネジ\n（機械側の問題）",
			"originalText": "ベルトの張り\nプーリーの止めネジ\n（機械側の問題）",
			"fontSize": 15,
			"fontFamily": 3,
			"textAlign": "left",
			"verticalAlign": "top",
			"strokeColor": "#374151",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 104016,
			"version": 1,
			"versionNonce": 204016,
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
			"id": "sR2",
			"x": 970,
			"y": 350,
			"width": 250,
			"height": 70,
			"strokeColor": "#c2410c",
			"backgroundColor": "#fed7aa",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 104017,
			"version": 1,
			"versionNonce": 204017,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": [
				{
					"id": "xsR2",
					"type": "text"
				},
				{
					"id": "aR2",
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
			"id": "xsR2",
			"x": 1011,
			"y": 363,
			"width": 167,
			"height": 45,
			"text": "⑤ サポートが出ない\n外れない",
			"originalText": "⑤ サポートが出ない\n外れない",
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
			"seed": 104018,
			"version": 1,
			"versionNonce": 204018,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": null,
			"link": null,
			"locked": false,
			"containerId": "sR2",
			"lineHeight": 1.25
		},
		{
			"type": "text",
			"id": "fR2",
			"x": 1240,
			"y": 357,
			"width": 300,
			"height": 57,
			"text": "Supports が None のまま？\nOverhang threshold\nContact Z distance",
			"originalText": "Supports が None のまま？\nOverhang threshold\nContact Z distance",
			"fontSize": 15,
			"fontFamily": 3,
			"textAlign": "left",
			"verticalAlign": "top",
			"strokeColor": "#374151",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 104019,
			"version": 1,
			"versionNonce": 204019,
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
			"id": "sR3",
			"x": 970,
			"y": 600,
			"width": 250,
			"height": 70,
			"strokeColor": "#c2410c",
			"backgroundColor": "#fed7aa",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 104020,
			"version": 1,
			"versionNonce": 204020,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": [
				{
					"id": "xsR3",
					"type": "text"
				},
				{
					"id": "aR3",
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
			"id": "xsR3",
			"x": 1020,
			"y": 624,
			"width": 149,
			"height": 23,
			"text": "⑥ 設定が読めない",
			"originalText": "⑥ 設定が読めない",
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
			"seed": 104021,
			"version": 1,
			"versionNonce": 204021,
			"isDeleted": false,
			"groupIds": [],
			"frameId": null,
			"boundElements": null,
			"link": null,
			"locked": false,
			"containerId": "sR3",
			"lineHeight": 1.25
		},
		{
			"type": "text",
			"id": "fR3",
			"x": 1240,
			"y": 616,
			"width": 300,
			"height": 38,
			"text": "Config と Bundle の取り違え\n2.9 系と 3.0 系の違い",
			"originalText": "Config と Bundle の取り違え\n2.9 系と 3.0 系の違い",
			"fontSize": 15,
			"fontFamily": 3,
			"textAlign": "left",
			"verticalAlign": "top",
			"strokeColor": "#374151",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 104022,
			"version": 1,
			"versionNonce": 204022,
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
			"type": "arrow",
			"id": "aL1",
			"x": 668,
			"y": 350,
			"width": 116,
			"height": 215,
			"strokeColor": "#c2410c",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 104023,
			"version": 1,
			"versionNonce": 204023,
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
					-116,
					-215
				]
			],
			"startBinding": {
				"elementId": "c0",
				"focus": 0,
				"gap": 2
			},
			"endBinding": {
				"elementId": "sL1",
				"focus": 0,
				"gap": 2
			},
			"startArrowhead": null,
			"endArrowhead": "arrow",
			"roundness": null
		},
		{
			"type": "arrow",
			"id": "aL2",
			"x": 638,
			"y": 385,
			"width": 86,
			"height": 0,
			"strokeColor": "#c2410c",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 104024,
			"version": 1,
			"versionNonce": 204024,
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
					-86,
					0
				]
			],
			"startBinding": {
				"elementId": "c0",
				"focus": 0,
				"gap": 2
			},
			"endBinding": {
				"elementId": "sL2",
				"focus": 0,
				"gap": 2
			},
			"startArrowhead": null,
			"endArrowhead": "arrow",
			"roundness": null
		},
		{
			"type": "arrow",
			"id": "aL3",
			"x": 668,
			"y": 420,
			"width": 116,
			"height": 215,
			"strokeColor": "#c2410c",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 104025,
			"version": 1,
			"versionNonce": 204025,
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
					-116,
					215
				]
			],
			"startBinding": {
				"elementId": "c0",
				"focus": 0,
				"gap": 2
			},
			"endBinding": {
				"elementId": "sL3",
				"focus": 0,
				"gap": 2
			},
			"startArrowhead": null,
			"endArrowhead": "arrow",
			"roundness": null
		},
		{
			"type": "arrow",
			"id": "aR1",
			"x": 852,
			"y": 350,
			"width": 116,
			"height": 215,
			"strokeColor": "#c2410c",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 104026,
			"version": 1,
			"versionNonce": 204026,
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
					116,
					-215
				]
			],
			"startBinding": {
				"elementId": "c0",
				"focus": 0,
				"gap": 2
			},
			"endBinding": {
				"elementId": "sR1",
				"focus": 0,
				"gap": 2
			},
			"startArrowhead": null,
			"endArrowhead": "arrow",
			"roundness": null
		},
		{
			"type": "arrow",
			"id": "aR2",
			"x": 882,
			"y": 385,
			"width": 86,
			"height": 0,
			"strokeColor": "#c2410c",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 104027,
			"version": 1,
			"versionNonce": 204027,
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
					86,
					0
				]
			],
			"startBinding": {
				"elementId": "c0",
				"focus": 0,
				"gap": 2
			},
			"endBinding": {
				"elementId": "sR2",
				"focus": 0,
				"gap": 2
			},
			"startArrowhead": null,
			"endArrowhead": "arrow",
			"roundness": null
		},
		{
			"type": "arrow",
			"id": "aR3",
			"x": 852,
			"y": 420,
			"width": 116,
			"height": 215,
			"strokeColor": "#c2410c",
			"backgroundColor": "transparent",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 0,
			"opacity": 100,
			"angle": 0,
			"seed": 104028,
			"version": 1,
			"versionNonce": 204028,
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
					116,
					215
				]
			],
			"startBinding": {
				"elementId": "c0",
				"focus": 0,
				"gap": 2
			},
			"endBinding": {
				"elementId": "sR3",
				"focus": 0,
				"gap": 2
			},
			"startArrowhead": null,
			"endArrowhead": "arrow",
			"roundness": null
		}
	],
	"appState": {
		"viewBackgroundColor": "#ffffff",
		"gridSize": null
	}
}
```
%%