<!--
/**
 * Outlook MSG エンコーディング対応 & CP932ベストエフォートデコードフロー図
 * 
 * 1. MSGファイル解析開始 (parse_msg_file)
 * 2. openMsg 通常オープン試行 -> UnicodeDecodeError時は overrideEncoding='cp932' 再試行
 * 3. プロパティ安全取得 (_safe_read_msg_prop): 属性エラーまたは文字化け時に生ストリーム (getStream) から取得
 * 4. ストリーム別デコード:
 *    - 001F (Unicode): utf-16le
 *    - 001E (ANSI): decode_best_effort_text (CP932/Shift_JIS最優先)
 *    - 1013 (HTML本文): meta charset検出 + ベストエフォートデコード
 * 5. mojibake_score による自然な日本語の選択と本文相互フォールバック
 **/
-->
---

excalidraw-plugin: parsed
tags: [excalidraw]

---
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==

# Excalidraw Data

## Text Elements
Outlook MSG CP932ベストエフォートデコード & 文字化け防止フロー ^title
① MSGオープン & 再試行 (openMsg) ^step1
通常オープンでUnicodeDecodeError(cp1252)発生？
→ overrideEncoding='cp932' で自動再オープン ^step1-desc
② プロパティ取得 & 文字化け検知 (_safe_read_msg_prop) ^step2
件名・差出人・宛先・本文の属性アクセスで例外または文字化け(mojibake_score > 40)？ ^step2-desc
③ 生ストリーム直接抽出 (_safe_get_msg_stream_text) ^step3
・001F (Unicode) → utf-16le でデコード
・001E (ANSI) → decode_best_effort_text (CP932最優先) ^step3-desc
④ HTML本文デコード & 相互フォールバック ^step4
・<meta charset="..."> を検出して優先デコード
・本文が空の場合はHTMLからテキストを自動生成 ^step4-desc
⑤ 安全な自己完結HTML出力 / 検索インデックス登録 ^step5
エラー中断ゼロで、日本語メールを完全レンダリング ^step5-desc

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
			"strokeColor": "#1e40af",
			"backgroundColor": "#eff6ff",
			"width": 640,
			"height": 55,
			"seed": 101,
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
			"strokeColor": "#1e3a8a",
			"backgroundColor": "transparent",
			"width": 600,
			"height": 25,
			"seed": 102,
			"groupIds": [],
			"fontSize": 18,
			"fontFamily": 1,
			"text": "Outlook MSG CP932ベストエフォートデコード & 文字化け防止フロー",
			"baseline": 18,
			"textAlign": "left",
			"verticalAlign": "top",
			"containerId": null,
			"originalText": "Outlook MSG CP932ベストエフォートデコード & 文字化け防止フロー"
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
			"y": 125,
			"strokeColor": "#2563eb",
			"backgroundColor": "#ffffff",
			"width": 640,
			"height": 75,
			"seed": 201,
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
			"strokeColor": "#1e293b",
			"backgroundColor": "transparent",
			"width": 600,
			"height": 55,
			"seed": 202,
			"groupIds": [],
			"fontSize": 14,
			"fontFamily": 1,
			"text": "① MSGオープン & 再試行 (openMsg)\n通常オープンでUnicodeDecodeError(cp1252)発生？\n→ overrideEncoding='cp932' で自動再オープン",
			"baseline": 14,
			"textAlign": "left",
			"verticalAlign": "top",
			"containerId": null,
			"originalText": "① MSGオープン & 再試行 (openMsg)\n通常オープンでUnicodeDecodeError(cp1252)発生？\n→ overrideEncoding='cp932' で自動再オープン"
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
			"strokeColor": "#d97706",
			"backgroundColor": "#fffbeb",
			"width": 640,
			"height": 65,
			"seed": 301,
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
			"y": 240,
			"strokeColor": "#78350f",
			"backgroundColor": "transparent",
			"width": 600,
			"height": 45,
			"seed": 302,
			"groupIds": [],
			"fontSize": 14,
			"fontFamily": 1,
			"text": "② プロパティ取得 & 文字化け検知 (_safe_read_msg_prop)\n件名・差出人・宛先・本文の属性アクセスで例外または文字化け(mojibake_score > 40)？",
			"baseline": 14,
			"textAlign": "left",
			"verticalAlign": "top",
			"containerId": null,
			"originalText": "② プロパティ取得 & 文字化け検知 (_safe_read_msg_prop)\n件名・差出人・宛先・本文の属性アクセスで例外または文字化け(mojibake_score > 40)？"
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
			"y": 325,
			"strokeColor": "#059669",
			"backgroundColor": "#ecfdf5",
			"width": 640,
			"height": 75,
			"seed": 401,
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
			"y": 335,
			"strokeColor": "#064e3b",
			"backgroundColor": "transparent",
			"width": 600,
			"height": 55,
			"seed": 402,
			"groupIds": [],
			"fontSize": 14,
			"fontFamily": 1,
			"text": "③ 生ストリーム直接抽出 (_safe_get_msg_stream_text)\n・001F (Unicode) → utf-16le でデコード\n・001E (ANSI) → decode_best_effort_text (CP932最優先)",
			"baseline": 14,
			"textAlign": "left",
			"verticalAlign": "top",
			"containerId": null,
			"originalText": "③ 生ストリーム直接抽出 (_safe_get_msg_stream_text)\n・001F (Unicode) → utf-16le でデコード\n・001E (ANSI) → decode_best_effort_text (CP932最優先)"
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
			"y": 430,
			"strokeColor": "#4f46e5",
			"backgroundColor": "#eef2ff",
			"width": 640,
			"height": 75,
			"seed": 501,
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
			"y": 440,
			"strokeColor": "#312e81",
			"backgroundColor": "transparent",
			"width": 600,
			"height": 55,
			"seed": 502,
			"groupIds": [],
			"fontSize": 14,
			"fontFamily": 1,
			"text": "④ HTML本文デコード & 相互フォールバック\n・<meta charset=\"...\"> を検出して優先デコード\n・本文が空の場合はHTMLからテキストを自動生成",
			"baseline": 14,
			"textAlign": "left",
			"verticalAlign": "top",
			"containerId": null,
			"originalText": "④ HTML本文デコード & 相互フォールバック\n・<meta charset=\"...\"> を検出して優先デコード\n・本文が空の場合はHTMLからテキストを自動生成"
		},
		{
			"type": "rectangle",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "box-step5",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 40,
			"y": 535,
			"strokeColor": "#16a34a",
			"backgroundColor": "#dcfce7",
			"width": 640,
			"height": 60,
			"seed": 601,
			"groupIds": [],
			"roundness": { "type": 3 }
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "text-step5",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 60,
			"y": 545,
			"strokeColor": "#14532d",
			"backgroundColor": "transparent",
			"width": 600,
			"height": 40,
			"seed": 602,
			"groupIds": [],
			"fontSize": 14,
			"fontFamily": 1,
			"text": "⑤ 安全な自己完結HTML出力 / 検索インデックス登録\nエラー中断ゼロで、日本語メールを完全レンダリング",
			"baseline": 14,
			"textAlign": "left",
			"verticalAlign": "top",
			"containerId": null,
			"originalText": "⑤ 安全な自己完結HTML出力 / 検索インデックス登録\nエラー中断ゼロで、日本語メールを完全レンダリング"
		}
	],
	"appState": {
		"viewBackgroundColor": "#ffffff",
		"gridSize": null
	},
	"files": {}
}
```
