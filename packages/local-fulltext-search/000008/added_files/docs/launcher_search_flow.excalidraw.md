<!--
/**
 * ランチャー検索ルーティング（既存DB高速検索 vs 更新チェック連動）フロー図
 * 
 * 1. ランチャー検索入力（Windows WPF / 他OS）
 * 2. 「更新」チェック判定:
 *    - OFF: POST /api/search/indexed ➔ インデックス作成を待たず、既存DBだけで即座に高速検索
 *    - ON: POST /api/search (search_all_enabled: false, skip_refresh: false) ➔ 差分更新・ベクトル作成を待ってから検索
 * 3. バックエンド処理:
 *    - IndexedSearchRequest: search_existing_index() ➔ 再走査なし、既存FTS＋既存ベクトル類似度RRF融合
 *    - SearchRequest (更新ON): ensure_fresh_target() ➔ 差分同期＋ベクトルsync_index完了後に検索
 **/
-->
---

excalidraw-plugin: parsed
tags: [excalidraw]

---
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==

# Excalidraw Data

## Text Elements
ランチャー検索ルーティング（既存DB高速検索 vs 更新チェック連動）フロー ^title
① ランチャー入力 (WPF / Flet) ^step1
ユーザーが検索キーワード・拡張子を入力
（検索方式: ハイブリッド [既定] / ベクトル / 通常） ^step1-desc
② 「更新」チェックボックス判定 ^step2
OFF: 高速検索（インデックス作成待機なし）
ON: 最新化検索（インデックス作成・更新を待機） ^step2-desc
③-A 更新チェック OFF の場合 ^path-a
POST /api/search/indexed
・search_type: "hybrid" / "vector" / "keyword"
・インデックス差分走査を完全スキップ
・既存 SQLite DB + 既存ベクトルインデックスから即座に取得・融合 ^path-a-desc
③-B 更新チェック ON の場合 ^path-b
POST /api/search
・search_all_enabled: false, skip_refresh: false
・登録済みフォルダの差分インデックス作成・更新を実行
・ベクトルインデックスの差分同期 (sync_index) も完了を待機
・最新化されたインデックスに対して検索を実行 ^path-b-desc
④ 検索結果をランチャーへ即時表示 ^result
更新OFF: 待たずに一瞬でレスポンス
更新ON: 最新ファイルを反映した結果を表示 ^result-desc

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
			"strokeColor": "#3b82f6",
			"backgroundColor": "#1e293b",
			"width": 780,
			"height": 50,
			"seed": 1,
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
			"y": 52,
			"strokeColor": "#f8fafc",
			"backgroundColor": "transparent",
			"width": 740,
			"height": 25,
			"seed": 2,
			"groupIds": [],
			"fontSize": 18,
			"fontFamily": 1,
			"text": "ランチャー検索ルーティング（既存DB高速検索 vs 更新チェック連動）フロー",
			"rawText": "ランチャー検索ルーティング（既存DB高速検索 vs 更新チェック連動）フロー",
			"textAlign": "center",
			"verticalAlign": "middle"
		}
	],
	"appState": {
		"viewBackgroundColor": "#0f172a",
		"gridSize": null
	}
}
```
