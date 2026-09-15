<!--
/**
 * ベクトル検索モデル起動時自動ロード & ライフサイクル管理フロー図
 * 
 * 1. サーバー起動 (FastAPI lifespan): 起動時に config.json のモデル記録有無を判定
 * 2. 初回/未記録時: モデルを自動ロードせず未ロード状態 (is_loaded=False) のまま安全に待機
 * 3. 記録あり時: 前回使用していたモデル (ruri-v3-30m 等) を自動検知・ロードし即時検索可能化
 * 4. モデル選択/ロード時: config.json に永続化 (mock_model などのテストモデルは保存抑止)
 **/
-->
---

excalidraw-plugin: parsed
tags: [excalidraw]

---
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==

# Excalidraw Data

## Text Elements
サーバー起動時 ベクトルモデル自動ロード & ライフサイクル ^title
① サーバー起動 (FastAPI lifespan) ^step1
バックエンド起動時に vector_state.get_saved_model_path() を確認 ^step1-desc
② 記録有無の判定 (分岐) ^step2
config.json に selected_model / model_path の記録が存在するか確認 ^step2-desc
③-A 記録なし (初回起動・未選択) ➔ ロードをスキップ ^step3a
モデルを自動ロードせず未ロード状態で待機。勝手なデフォルトロードを抑止 ^step3a-desc
③-B 記録あり ➔ 前回使用モデルを自動ロード ^step3b
models/ 配下からパス解決し、SentenceTransformer と DB を即座に初期化 ^step3b-desc
④ 即時ハイブリッド検索が可能 ^step4
再起動後もユーザーが手動でリロードすることなく、直前のモデルで即座に検索有効 ^step4-desc
⑤ テスト/ダミーモデル保存抑止 ^step5
mock_model などのダミーは config.json に保存せず、本番環境の汚染を完全防止 ^step5-desc

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
			"roundness": { "type": 3 }
		}
	],
	"appState": {
		"viewBackgroundColor": "#ffffff",
		"gridSize": null
	},
	"files": {}
}
```
