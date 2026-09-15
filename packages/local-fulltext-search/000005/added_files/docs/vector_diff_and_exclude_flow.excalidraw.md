<!--
/**
 * ベクトルインデックス差分検知 & 除外キーワード完全連動フロー図
 * 
 * 1. 設定自動解決: Web差分同期(⚡)時にAppSettingsから除外キーワードを自動ロード
 * 2. 厳格除外走査: 絶対パス・フォルダ名・単語境界(誤爆防止)でscan_filesから確実に除外
 * 3. 2段階差分判定: mtime/size一致 ➔ sha256一致で不要なEmbedding計算を完全スキップ
 * 4. 登録・パージ: 変更ファイルのみEmbedding計算、除外・削除ファイルは全DBからパージ
 **/
-->
---

excalidraw-plugin: parsed
tags: [excalidraw]

---
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==

# Excalidraw Data

## Text Elements
ベクトルインデックス差分検知 & 除外キーワード完全連動フロー ^title
① 設定自動解決 (VectorState.sync_index) ^step1
Web UIの差分同期(⚡)やAPI呼び出し時、AppSettings(exclude_keywords.txt)から除外キーワードを自動ロード ^step1-desc
② 厳格除外走査 (VectorIndexManager.scan_files) ^step2
絶対パス、フォルダ名、単語境界(secretary≠secret)、隠し要素を厳格に照合し走査から除外 ^step2-desc
③ 2段階の超高速差分判定 (mtime/size ➔ sha256) ^step3
mtime/sizeが一致なら即スキップ。相違時はsha256ハッシュを比較し、内容同一ならEmbeddingをスキップ ^step3-desc
④ ベクトル化 & DB反映 (upsert_document / insert_chunks) ^step4
新規ファイルまたはsha256が変更されたファイルのみテキスト抽出・チャンキング・Embedding計算を実行 ^step4-desc
⑤ 除外・削除ファイルの即時パージ (delete_document / _cleanup_excluded_keyword_files) ^step5
走査対象外となったファイルや、除外キーワード変更時の既存登録ファイルを全ベクトルDBから即座に削除 ^step5-desc

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
			"roundness": { "type": 3 },
			"boundElements": []
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 2,
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
			"strokeColor": "#0369a1",
			"backgroundColor": "transparent",
			"width": 650,
			"height": 30,
			"seed": 102,
			"groupIds": [],
			"roundness": null,
			"boundElements": [],
			"fontSize": 20,
			"fontFamily": 1,
			"text": "ベクトルインデックス差分検知 & 除外キーワード完全連動フロー",
			"rawText": "ベクトルインデックス差分検知 & 除外キーワード完全連動フロー",
			"textAlign": "left",
			"verticalAlign": "top",
			"containerId": null,
			"originalText": "ベクトルインデックス差分検知 & 除外キーワード完全連動フロー"
		}
	],
	"appState": {
		"gridSize": null,
		"viewBackgroundColor": "#ffffff"
	},
	"files": {}
}
```
