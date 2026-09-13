<!--
/**
 * 添付ファイル削除時のノート内リンク自動クリーンアップ処理フロー図
 * 
 * 1. トリガー: ノート内リンク/埋め込み右クリック、またはエクスプローラーから「添付ファイルを削除」
 * 2. 参照元ノート特定: アクティブノートおよびバックリンク元ノートを抽出
 * 3. リンクのクリーン削除: 通常Wikilink/埋め込み/Markdownリンクを行ごと綺麗に削除
 * 4. ファイルゴミ箱移動 & タブ更新: 安全にゴミ箱へ移動し、開いているノートを再描画
 **/
-->
---

excalidraw-plugin: parsed
tags: [excalidraw]

---
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. For more info check in plugin settings under 'Saving'

# Excalidraw Data

## Text Elements
添付ファイル削除時のノート内リンク自動クリーンアップ 処理フロー ^title
① 削除トリガー ^step1-title
- エディタ/閲覧画面でリンク・埋め込みを右クリック -> 「添付ファイルを削除」
- ファイルエクスプローラーで添付ファイルを右クリック -> 「添付ファイルを削除」 ^step1-desc
② 参照元ノートの自動特定 ^step2-title
- sourceFile があればそのノートを対象
- 未指定時は activeFile ＋ getBacklinks(file) から全参照元ノートを収集
- 確認ダイアログに「ノート内のリンクも同時に削除」を表示 ^step2-desc
③ 高精度リンククリーンアップ ^step3-title
- [[test.pdf]]、[[aaa.md]] などの通常リンクも対象
- - [[test.pdf]] や単独行は行ごと改行含め完全削除（記号や空行の残留防止）
- インラインリンクは該当箇所のみ削除して周囲の文章を維持 ^step3-desc
④ ファイル削除 ＆ タブ自動更新 ^step4-title
- 対象ファイルをシステムのゴミ箱（trash）へ移動
- 変更されたノートを保存（失敗時は自動ロールバック）
- 開かれているノートタブを再読込してリンク切れ表示を解消！ ^step4-desc

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
			"strokeColor": "#c92a2a",
			"backgroundColor": "#ffe3e3",
			"width": 900,
			"height": 60,
			"seed": 101,
			"groupIds": [],
			"roundness": {
				"type": 3
			}
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "title",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 60,
			"y": 45,
			"strokeColor": "#c92a2a",
			"backgroundColor": "transparent",
			"width": 860,
			"height": 30,
			"seed": 102,
			"groupIds": [],
			"fontSize": 20,
			"fontFamily": 1,
			"text": "添付ファイル削除時のノート内リンク自動クリーンアップ 処理フロー",
			"baseline": 22,
			"textAlign": "center",
			"verticalAlign": "middle"
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
			"y": 120,
			"strokeColor": "#2b8a3e",
			"backgroundColor": "#ebfbee",
			"width": 430,
			"height": 130,
			"seed": 103,
			"groupIds": [],
			"roundness": {
				"type": 3
			}
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "step1-title",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 60,
			"y": 135,
			"strokeColor": "#2b8a3e",
			"backgroundColor": "transparent",
			"width": 390,
			"height": 24,
			"seed": 104,
			"groupIds": [],
			"fontSize": 16,
			"fontFamily": 1,
			"text": "① 削除トリガー",
			"baseline": 18,
			"textAlign": "left",
			"verticalAlign": "top"
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "step1-desc",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 60,
			"y": 165,
			"strokeColor": "#2b8a3e",
			"backgroundColor": "transparent",
			"width": 390,
			"height": 70,
			"seed": 105,
			"groupIds": [],
			"fontSize": 14,
			"fontFamily": 1,
			"text": "- エディタ/閲覧画面でリンク・埋め込みを右クリック -> 「添付ファイルを削除」\n- ファイルエクスプローラーで添付ファイルを右クリック -> 「添付ファイルを削除」",
			"baseline": 15,
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
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 510,
			"y": 120,
			"strokeColor": "#1971c2",
			"backgroundColor": "#e7f5ff",
			"width": 430,
			"height": 130,
			"seed": 106,
			"groupIds": [],
			"roundness": {
				"type": 3
			}
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 1,
			"id": "step2-title",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 530,
			"y": 135,
			"strokeColor": "#1971c2",
			"backgroundColor": "transparent",
			"width": 390,
			"height": 24,
			"seed": 107,
			"groupIds": [],
			"fontSize": 16,
			"fontFamily": 1,
			"text": "② 参照元ノートの自動特定",
			"baseline": 18,
			"textAlign": "left",
			"verticalAlign": "top"
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 1,
			"id": "step2-desc",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 530,
			"y": 165,
			"strokeColor": "#1971c2",
			"backgroundColor": "transparent",
			"width": 390,
			"height": 70,
			"seed": 108,
			"groupIds": [],
			"fontSize": 14,
			"fontFamily": 1,
			"text": "- sourceFile があればそのノートを対象\n- 未指定時は activeFile ＋ getBacklinks(file) から全参照元ノートを収集\n- 確認ダイアログに「ノート内のリンクも同時に削除」を表示",
			"baseline": 15,
			"textAlign": "left",
			"verticalAlign": "top"
		},
		{
			"type": "rectangle",
			"version": 1,
			"versionNonce": 1,
			"id": "box-step3",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 40,
			"y": 280,
			"strokeColor": "#e67700",
			"backgroundColor": "#fff9db",
			"width": 430,
			"height": 130,
			"seed": 109,
			"groupIds": [],
			"roundness": {
				"type": 3
			}
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 1,
			"id": "step3-title",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 60,
			"y": 295,
			"strokeColor": "#e67700",
			"backgroundColor": "transparent",
			"width": 390,
			"height": 24,
			"seed": 110,
			"groupIds": [],
			"fontSize": 16,
			"fontFamily": 1,
			"text": "③ 高精度リンククリーンアップ",
			"baseline": 18,
			"textAlign": "left",
			"verticalAlign": "top"
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 1,
			"id": "step3-desc",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 60,
			"y": 325,
			"strokeColor": "#e67700",
			"backgroundColor": "transparent",
			"width": 390,
			"height": 70,
			"seed": 111,
			"groupIds": [],
			"fontSize": 14,
			"fontFamily": 1,
			"text": "- [[test.pdf]]、[[aaa.md]] などの通常リンクも対象\n- - [[test.pdf]] や単独行は行ごと改行含め完全削除（記号や空行の残留防止）\n- インラインリンクは該当箇所のみ削除して周囲の文章を維持",
			"baseline": 15,
			"textAlign": "left",
			"verticalAlign": "top"
		},
		{
			"type": "rectangle",
			"version": 1,
			"versionNonce": 1,
			"id": "box-step4",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 510,
			"y": 280,
			"strokeColor": "#5f3dc4",
			"backgroundColor": "#f3f0ff",
			"width": 430,
			"height": 130,
			"seed": 112,
			"groupIds": [],
			"roundness": {
				"type": 3
			}
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 1,
			"id": "step4-title",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 530,
			"y": 295,
			"strokeColor": "#5f3dc4",
			"backgroundColor": "transparent",
			"width": 390,
			"height": 24,
			"seed": 113,
			"groupIds": [],
			"fontSize": 16,
			"fontFamily": 1,
			"text": "④ ファイル削除 ＆ タブ自動更新",
			"baseline": 18,
			"textAlign": "left",
			"verticalAlign": "top"
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 1,
			"id": "step4-desc",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 530,
			"y": 325,
			"strokeColor": "#5f3dc4",
			"backgroundColor": "transparent",
			"width": 390,
			"height": 70,
			"seed": 114,
			"groupIds": [],
			"fontSize": 14,
			"fontFamily": 1,
			"text": "- 対象ファイルをシステムのゴミ箱（trash）へ移動\n- 変更されたノートを保存（失敗時は自動ロールバック）\n- 開かれているノートタブを再読込してリンク切れ表示を解消！",
			"baseline": 15,
			"textAlign": "left",
			"verticalAlign": "top"
		}
	],
	"appState": {
		"viewBackgroundColor": "#ffffff",
		"gridSize": 20
	}
}
```
%%
