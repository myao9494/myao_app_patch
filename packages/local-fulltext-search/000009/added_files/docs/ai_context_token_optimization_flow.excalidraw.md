<!--
/**
 * AIコンテキスト: トークン最適化（メールCC & DataviewJS除外）処理フロー図
 * 
 * 1. ドキュメント収集（Markdown & 呼び出されたメール）
 * 2. DataviewJSのサニタイズ:
 *    - 静的テーブルはHTMLテーブルに変換
 *    - 展開不能な生JSスクリプトコードは除去・省略
 *    - 元データMarkdownからもDataviewJSブロックを除去
 * 3. メールのCCサニタイズ:
 *    - プレーンテキスト本文の Cc: 行（複数行アドレス）を除去
 *    - HTML本文の Cc: テーブル/ブロックを除去
 *    - メタデータからCcを除外
 * 4. クリーンでトークン効率の高い自己完結HTML/PDFを出力
 **/
-->
---

excalidraw-plugin: parsed
tags: [excalidraw]

---
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==

# Excalidraw Data

## Text Elements
AIコンテキスト: トークン最適化（メールCC & DataviewJS除外）フロー ^title
① 対象ドキュメント入力 (Markdown & メールファイル) ^step1
Obsidianノート内のDataviewJSスクリプトやメール本文を読み込み ^step1-desc
② DataviewJS コードのトークン最適化 ^step2
・静的テーブル形式: 美しいHTML <table> に展開
・複雑な生JSコード: 除去・簡潔なプレースホルダー化
・元データMarkdown (details): DataviewJSブロックを完全除去 ^step2-desc
③ メールCC（Cc）情報の自動サニタイズ ^step3
・本文中の引用/転送ヘッダーにある長大な Cc: アドレス一覧を除去
・HTML本文内の Cc: テーブル行・段落を除去
・ヘッダーメタデータからCcを除外してトークン浪費を防止 ^step3-desc
④ クリーンなコンテキスト出力 (HTML / PDF) ^step4
AIが理解しやすい本文・図面だけに特化し、大幅なトークン節約を実現！ ^step4-desc

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
			"strokeColor": "#10b981",
			"backgroundColor": "#064e3b",
			"width": 780,
			"height": 55,
			"seed": 20001,
			"groupIds": [],
			"roundness": { "type": 3 }
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
			"strokeColor": "#a7f3d0",
			"backgroundColor": "transparent",
			"width": 700,
			"height": 26,
			"seed": 20002,
			"groupIds": [],
			"roundness": null,
			"fontSize": 20,
			"fontFamily": 1,
			"text": "AIコンテキスト: トークン最適化（メールCC & DataviewJS除外）フロー",
			"textAlign": "left",
			"verticalAlign": "middle"
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
			"y": 120,
			"strokeColor": "#3b82f6",
			"backgroundColor": "#172554",
			"width": 780,
			"height": 80,
			"seed": 20003,
			"groupIds": [],
			"roundness": { "type": 3 }
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
			"y": 135,
			"strokeColor": "#93c5fd",
			"backgroundColor": "transparent",
			"width": 740,
			"height": 48,
			"seed": 20004,
			"groupIds": [],
			"roundness": null,
			"fontSize": 15,
			"fontFamily": 1,
			"text": "① 対象ドキュメント入力 (Markdown & メールファイル)\nObsidianノート内のDataviewJSスクリプトやメール本文を読み込み",
			"textAlign": "left",
			"verticalAlign": "top"
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
			"y": 220,
			"strokeColor": "#f59e0b",
			"backgroundColor": "#451a03",
			"width": 780,
			"height": 95,
			"seed": 20005,
			"groupIds": [],
			"roundness": { "type": 3 }
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
			"y": 235,
			"strokeColor": "#fcd34d",
			"backgroundColor": "transparent",
			"width": 740,
			"height": 65,
			"seed": 20006,
			"groupIds": [],
			"roundness": null,
			"fontSize": 14,
			"fontFamily": 1,
			"text": "② DataviewJS コードのトークン最適化\n・静的テーブル形式: 美しいHTML <table> に展開\n・複雑な生JSコード: 除去・簡潔なプレースホルダー化\n・元データMarkdown (details): DataviewJSブロックを完全除去",
			"textAlign": "left",
			"verticalAlign": "top"
		},
		{
			"type": "rectangle",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "box-step3",
			"fillStyle": "solid",
			"strokeWidth": 1.5,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 40,
			"y": 335,
			"strokeColor": "#ec4899",
			"backgroundColor": "#500724",
			"width": 780,
			"height": 95,
			"seed": 20007,
			"groupIds": [],
			"roundness": { "type": 3 }
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
			"x": 60,
			"y": 350,
			"strokeColor": "#fbcfe8",
			"backgroundColor": "transparent",
			"width": 740,
			"height": 65,
			"seed": 20008,
			"groupIds": [],
			"roundness": null,
			"fontSize": 14,
			"fontFamily": 1,
			"text": "③ メールCC（Cc）情報の自動サニタイズ\n・本文中の引用/転送ヘッダーにある長大な Cc: アドレス一覧を除去\n・HTML本文内の Cc: テーブル行・段落を除去\n・ヘッダーメタデータからCcを除外してトークン浪費を防止",
			"textAlign": "left",
			"verticalAlign": "top"
		},
		{
			"type": "rectangle",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "box-step4",
			"fillStyle": "solid",
			"strokeWidth": 1.5,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 40,
			"y": 450,
			"strokeColor": "#10b981",
			"backgroundColor": "#022c22",
			"width": 780,
			"height": 80,
			"seed": 20009,
			"groupIds": [],
			"roundness": { "type": 3 }
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "text-step4",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 60,
			"y": 465,
			"strokeColor": "#6ee7b7",
			"backgroundColor": "transparent",
			"width": 740,
			"height": 48,
			"seed": 20010,
			"groupIds": [],
			"roundness": null,
			"fontSize": 15,
			"fontFamily": 1,
			"text": "④ クリーンなコンテキスト出力 (HTML / PDF)\nAIが理解しやすい本文・図面だけに特化し、大幅なトークン節約を実現！",
			"textAlign": "left",
			"verticalAlign": "top"
		}
	],
	"appState": {
		"viewBackgroundColor": "#0f172a",
		"gridSize": 20
	},
	"files": {}
}
```
