<!--
/**
 * 検索ボックスおよび拡張子フィルタのマイナス除外（-.png 等）フロー図
 * 
 * 1. 検索ボックス入力: "alpha -.png" または単独 "-.png" を解析
 * 2. 拡張子フィルタ入力: "-png", "-.png", "md -png" を解析
 * 3. バックエンドSQL生成: files.file_ext NOT IN (...) で高速除外
 * 4. FTS/全件走査 & 除外判定: _matches_excluded_search_terms でファイル名・本文・パスから除外
 * 5. ベクトル・ハイブリッド検索連携: ベクトルクエリから除外語を除き、候補からも確実にパージ
 * 6. UI即時反映: Web UI およびデスクトップランチャー（macOS/Win/Flet）で即時フィルタリング
 **/
-->
---

excalidraw-plugin: parsed
tags: [excalidraw]

---
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==

# Excalidraw Data

## Text Elements
検索ボックスおよび拡張子フィルタのマイナス除外（-.png 等）フロー ^title
① 入力解析 (UI / Launcher) ^step1
検索ボックス: "alpha -.png" ➔ include: ["alpha"], exclude: [".png"]
拡張子フィルタ: "md -png" ➔ include: [".md"], exclude: [".png"] ^step1-desc
② バックエンド SQL 構築 (search_service) ^step2
include_exts ➔ files.file_ext IN ('.md')
exclude_exts ➔ files.file_ext NOT IN ('.png')
除外語のみの場合 ➔ scoped_files 全件を走査 ^step2-desc
③ 全文・正規表現・フォルダ除外判定 ^step3
_matches_excluded_search_terms: ファイル名・本文・フォルダパスに ".png" を含む候補を除外
フォルダ検索は include_terms が空の場合は除外 ^step3-desc
④ ベクトル・ハイブリッド検索連携 (api.search) ^step4
ベクトル検索クエリにはポジティブ語のみ渡す
ベクトル検索結果・ハイブリッド融合結果からも exclude_terms / exclude_exts をパージ ^step4-desc
⑤ UI・ランチャー表示 (Web / macOS / Win / Flet) ^step5
Web UI: filterSearchResultsByExtensions でリアルタイム即時反映
ランチャー: バックエンド連携により最新結果を表示 ^step5-desc

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
			"strokeColor": "#0284c7",
			"backgroundColor": "#f0f9ff",
			"width": 860,
			"height": 60,
			"seed": 101,
			"groupIds": [],
			"frameId": null,
			"roundness": { "type": 3 },
			"boundElements": [],
			"updated": 1,
			"link": null,
			"locked": false
		}
	],
	"appState": {
		"viewBackgroundColor": "#ffffff",
		"gridSize": null
	},
	"files": {}
}
```
