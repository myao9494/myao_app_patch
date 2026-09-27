<!--
/**
 * メール読み込み文字化け防止 & 表（テーブル）展開処理フロー図
 * 
 * 1. MSGバイナリ解析（MsgReader windows-31j指定 + mojibakeScoreによる自動復旧）
 * 2. decodeBestEffortText によるCP932/Shift_JIS最優先デコード
 * 3. 最深部テーブルからのボトムアップ変換（ネストテーブル・レイアウト枠展開）
 * 4. Markdownテーブルのプレースホルダー保護とサマリー展開
 **/
-->
---

excalidraw-plugin: parsed
tags: [excalidraw]

---
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. For more info check in plugin settings under 'Saving'

# Excalidraw Data

## Text Elements
メール読み込み文字化け防止 & 表（テーブル）展開フロー ^title
① MSGバイナリ読み込み & 多層デコード ^step1-title
・MsgReader(ansiEncoding: windows-31j)
・mojibakeScoreによる文字化け判定
・decodeBestEffortText（CP932/UTF-8最優先）
・Latin1誤認文字列の生バイト復元 ^step1-desc
② HTMLテーブルのボトムアップ解析 ^step2-title
【convertHtmlTablesToMarkdown】
・最深部の内側テーブルから順に変換
・1行1セルのレイアウト枠は中身を展開
・セル内ブロック（<p>, <br>）の改行正規化
・パイプ文字（|）のエスケープ ^step2-desc
③ プレースホルダーによる多段保護 ^step3-title
・内側テーブルを __NESTED_TABLE_PLACEHOLDER__ へ退避
・外側セルのパイプエスケープから完全隔離
・完成したMarkdownテーブルを __MD_TABLE_HOLDER__ へ退避
・周囲テキストの段落改行正規化による破壊を防止 ^step3-desc
④ サマリー（APPENDIX）への美麗展開 ^step4-title
文字化けせず、入れ子表や複数行セルも崩れない
正確で美麗なMarkdownテーブルとして展開！ ^step4-desc

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
			"strokeColor": "#1971c2",
			"backgroundColor": "#e7f5ff",
			"width": 840,
			"height": 60,
			"seed": 101,
			"groupIds": [],
			"roundness": { "type": 3 },
			"boundElements": [{ "type": "text", "id": "title" }]
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "title",
			"text": "メール読み込み文字化け防止 & 表（テーブル）展開フロー",
			"fontSize": 20,
			"fontFamily": 1,
			"textAlign": "center",
			"verticalAlign": "middle",
			"x": 60,
			"y": 45,
			"width": 800,
			"height": 30,
			"strokeColor": "#1971c2",
			"backgroundColor": "transparent",
			"containerId": "box-header"
		},
		{
			"type": "rectangle",
			"version": 1,
			"versionNonce": 2,
			"isDeleted": false,
			"id": "box-step1",
			"fillStyle": "solid",
			"strokeWidth": 1.5,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 40,
			"y": 120,
			"strokeColor": "#2f9e44",
			"backgroundColor": "#ebfbee",
			"width": 380,
			"height": 180,
			"seed": 102,
			"groupIds": [],
			"roundness": { "type": 3 }
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 2,
			"isDeleted": false,
			"id": "step1-title",
			"text": "① MSGバイナリ読み込み & 多層デコード",
			"fontSize": 15,
			"fontFamily": 1,
			"textAlign": "left",
			"verticalAlign": "top",
			"x": 55,
			"y": 135,
			"width": 350,
			"height": 24,
			"strokeColor": "#2b8a3e"
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 2,
			"isDeleted": false,
			"id": "step1-desc",
			"text": "・MsgReader(ansiEncoding: windows-31j)\n・mojibakeScoreによる文字化け判定\n・decodeBestEffortText（CP932/UTF-8最優先）\n・Latin1誤認文字列の生バイト復元",
			"fontSize": 12.5,
			"fontFamily": 1,
			"textAlign": "left",
			"verticalAlign": "top",
			"x": 55,
			"y": 175,
			"width": 350,
			"height": 110,
			"strokeColor": "#212529"
		},
		{
			"type": "rectangle",
			"version": 1,
			"versionNonce": 3,
			"isDeleted": false,
			"id": "box-step2",
			"fillStyle": "solid",
			"strokeWidth": 1.5,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 500,
			"y": 120,
			"strokeColor": "#e8590c",
			"backgroundColor": "#fff4e6",
			"width": 380,
			"height": 180,
			"seed": 103,
			"groupIds": [],
			"roundness": { "type": 3 }
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 3,
			"isDeleted": false,
			"id": "step2-title",
			"text": "② HTMLテーブルのボトムアップ解析",
			"fontSize": 15,
			"fontFamily": 1,
			"textAlign": "left",
			"verticalAlign": "top",
			"x": 515,
			"y": 135,
			"width": 350,
			"height": 24,
			"strokeColor": "#d9480f"
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 3,
			"isDeleted": false,
			"id": "step2-desc",
			"text": "【convertHtmlTablesToMarkdown】\n・最深部の内側テーブルから順に変換\n・1行1セルのレイアウト枠は中身を展開\n・セル内ブロック（<p>, <br>）の改行正規化\n・パイプ文字（|）のエスケープ",
			"fontSize": 12.5,
			"fontFamily": 1,
			"textAlign": "left",
			"verticalAlign": "top",
			"x": 515,
			"y": 175,
			"width": 350,
			"height": 110,
			"strokeColor": "#212529"
		},
		{
			"type": "rectangle",
			"version": 1,
			"versionNonce": 4,
			"isDeleted": false,
			"id": "box-step3",
			"fillStyle": "solid",
			"strokeWidth": 1.5,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 40,
			"y": 340,
			"strokeColor": "#7048e8",
			"backgroundColor": "#f3f0ff",
			"width": 380,
			"height": 180,
			"seed": 104,
			"groupIds": [],
			"roundness": { "type": 3 }
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 4,
			"isDeleted": false,
			"id": "step3-title",
			"text": "③ プレースホルダーによる多段保護",
			"fontSize": 15,
			"fontFamily": 1,
			"textAlign": "left",
			"verticalAlign": "top",
			"x": 55,
			"y": 355,
			"width": 350,
			"height": 24,
			"strokeColor": "#5f3dc4"
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 4,
			"isDeleted": false,
			"id": "step3-desc",
			"text": "・内側テーブルを __NESTED_TABLE_PLACEHOLDER__ へ退避\n・外側セルのパイプエスケープから完全隔離\n・完成したMarkdownテーブルを __MD_TABLE_HOLDER__ へ退避\n・周囲テキストの段落改行正規化による破壊を防止",
			"fontSize": 12,
			"fontFamily": 1,
			"textAlign": "left",
			"verticalAlign": "top",
			"x": 55,
			"y": 395,
			"width": 350,
			"height": 110,
			"strokeColor": "#212529"
		},
		{
			"type": "rectangle",
			"version": 1,
			"versionNonce": 5,
			"isDeleted": false,
			"id": "box-step4",
			"fillStyle": "solid",
			"strokeWidth": 1.5,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 500,
			"y": 340,
			"strokeColor": "#0c8599",
			"backgroundColor": "#e3fafc",
			"width": 380,
			"height": 180,
			"seed": 105,
			"groupIds": [],
			"roundness": { "type": 3 }
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 5,
			"isDeleted": false,
			"id": "step4-title",
			"text": "④ サマリー（APPENDIX）への美麗展開",
			"fontSize": 15,
			"fontFamily": 1,
			"textAlign": "left",
			"verticalAlign": "top",
			"x": 515,
			"y": 355,
			"width": 350,
			"height": 24,
			"strokeColor": "#0b7285"
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 5,
			"isDeleted": false,
			"id": "step4-desc",
			"text": "文字化けせず、入れ子表や複数行セルも崩れない\n正確で美麗なMarkdownテーブルとして展開！",
			"fontSize": 13,
			"fontFamily": 1,
			"textAlign": "left",
			"verticalAlign": "top",
			"x": 515,
			"y": 415,
			"width": 350,
			"height": 60,
			"strokeColor": "#212529"
		},
		{
			"type": "arrow",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "arrow-1-to-2",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 420,
			"y": 210,
			"strokeColor": "#495057",
			"points": [[0, 0], [80, 0]],
			"endArrowhead": "arrow"
		},
		{
			"type": "arrow",
			"version": 1,
			"versionNonce": 2,
			"isDeleted": false,
			"id": "arrow-2-to-3",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 690,
			"y": 300,
			"strokeColor": "#495057",
			"points": [[0, 0], [-460, 40]],
			"endArrowhead": "arrow"
		},
		{
			"type": "arrow",
			"version": 1,
			"versionNonce": 3,
			"isDeleted": false,
			"id": "arrow-3-to-4",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 420,
			"y": 430,
			"strokeColor": "#495057",
			"points": [[0, 0], [80, 0]],
			"endArrowhead": "arrow"
		}
	],
	"appState": {
		"viewBackgroundColor": "#ffffff",
		"gridSize": null
	}
}
```
