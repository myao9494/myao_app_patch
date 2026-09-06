<!--
仕様書: 名古屋市ハンバーグ名店マップ（Map View × Obsidian Bases）システム仕様＆利用ガイド
概要: 愛知県名古屋市内の食べログ3.5以上の名店7店舗を厳選し、Map Viewによる地理的可視化とObsidian Basesによる多角的データビューを統合した情報管理システム。
-->

# 名古屋市ハンバーグ名店マップ 仕様書＆利用ガイド

## 1. 概要

本ドキュメントは、愛知県名古屋市内の食べログ評価3.5以上を誇るハンバーグ名店（洋食百名店選出店を中心とする厳選7店舗）を対象に、**Map View プラグイン** と **Obsidian Bases** を連携させた店舗マップシステムの構成・仕様・利用方法をまとめたものです。

---

## 2. システム構成図

![[nagoya_hamburg_map_diagram.excalidraw|800]]

---

## 3. 厳選店舗データ一覧

| 店名 | 評価 | エリア・最寄り駅 | 予算（昼/夜） | 特徴・名物 | 位置情報（座標） |
| :--- | :---: | :--- | :--- | :--- | :--- |
| [kitchen俊貴](file:///Users/mine/000_work/obsidian-dagnetz/01_data/gourmet/nagoya_hamburg/kitchen%E4%BF%8A%E8%B2%B4.md) | **3.90** | 新栄町駅 徒歩3分 | ¥2,500 / ¥7,000 | 黒毛和牛100%ハンバーグ、究極のデミグラスソース | `[35.169987, 136.924470]` |
| [ハンバーグ食堂 榎本よしひろ商店](file:///Users/mine/000_work/obsidian-dagnetz/01_data/gourmet/nagoya_hamburg/%E3%83%8F%E3%83%B3%E3%83%90%E3%83%BC%E3%82%B0%E9%A3%9F%E5%A0%82%20%E6%A6%8E%E6%9C%AC%E3%82%88%E3%81%97%E3%81%B2%E3%82%8D%E5%95%86%E5%BA%97.md) | **3.65** | 高岳駅 徒歩9分 | ¥1,800 / ¥2,800 | 粗挽き牛肉「にこやかハンバーグ」、豚100%パティ | `[35.177201, 136.921890]` |
| [キッチン千代田](file:///Users/mine/000_work/obsidian-dagnetz/01_data/gourmet/nagoya_hamburg/%E3%82%AD%E3%83%83%E3%83%81%E3%83%B3%E5%8D%83%E4%BB%A3%E7%94%B0.md) | **3.68** | 鶴舞駅 徒歩6分 | ¥2,500 / ¥10,000 | 創業半世紀の老舗、和牛ハンバーグ、名物オムライス | `[35.155798, 136.913261]` |
| [すゞ家 赤門店](file:///Users/mine/000_work/obsidian-dagnetz/01_data/gourmet/nagoya_hamburg/%E3%81%99%E3%82%9E%E5%AE%B6%20%E8%B5%A4%E9%96%80%E5%BA%97.md) | **3.66** | 上前津駅 徒歩5分 | ¥2,500 / ¥4,000 | 1947年創業、ビブグルマン選出、伝統のデミグラス | `[35.160692, 136.905083]` |
| [キッチン兆](file:///Users/mine/000_work/obsidian-dagnetz/01_data/gourmet/nagoya_hamburg/%E3%82%AD%E3%83%83%E3%83%81%E3%83%B3%E5%85%86.md) | **3.65** | 池下駅 徒歩3分 | ¥2,500 / ¥4,000 | 「キッチン雅木」正統継承、和牛ハンバーグ＆カニコロ | `[35.167586, 136.942289]` |
| [文化洋食店 本店](file:///Users/mine/000_work/obsidian-dagnetz/01_data/gourmet/nagoya_hamburg/%E6%96%87%E5%8C%96%E6%B4%8B%E9%A3%9F%E5%BA%97%20%E6%9C%AC%E5%BA%97.md) | **3.58** | 池下駅 徒歩10分 | ¥2,000 / ¥3,500 | モダン洋食の草分け、肉厚俵型ハンバーグ | `[35.176465, 136.936688]` |
| [キッチンミルポワ](file:///Users/mine/000_work/obsidian-dagnetz/01_data/gourmet/nagoya_hamburg/%E3%82%AD%E3%83%83%E3%83%81%E3%83%B3%E3%83%9F%E3%83%AB%E3%83%9D%E3%83%AF.md) | **3.55** | 国際センター駅 徒歩5分 | ¥1,800 / ¥4,000 | 名駅至近、鉄板デミグラス、本格フォンドボー | `[35.169266, 136.890810]` |

---

## 4. データ構造とファイル仕様

### 4.1. 店舗ノート (Frontmatter)

各店舗ノートは以下の共通スキーマで構成されています：

```yaml
---
name: "店舗名"
location: [緯度, 経度]      # Map View認識用座標
rating: 3.xx               # 食べログ評価値 (>= 3.5)
address: "愛知県名古屋市..."
station: "最寄り駅および徒歩分数"
budget: "昼 ¥... / 夜 ¥..."
phone: "電話番号"
url: "食べログURL"
website: "公式Web/SNS URL"
category: "洋食・ハンバーグ"
cover: "画像URL"
tags:
  - gourmet
  - hamburg
  - map-view
  - nagoya
  - hyakumeiten
---
```

### 4.2. Obsidian Bases 設定 ([`nagoya_hamburg.base`](file:///Users/mine/000_work/obsidian-dagnetz/01_data/gourmet/nagoya_hamburg/nagoya_hamburg.base))

3つのビューを用途に応じて切り替えて利用できます：

1. **名古屋ハンバーグマップ (`type: map`)**:
   - Map View プラグインがネイティブに描画。
   - 名古屋市内の各店舗がピン留めされ、現在地からの距離確認やルート検索が可能。
2. **評価順ランキング一覧 (`type: table`)**:
   - 店名、食べログ評価、最寄り駅、予算、電話番号、住所を一覧比較。
   - 下部サマリーで平均評価（`rating: Average`）を自動算出。
3. **店舗カードギャラリー (`type: cards`)**:
   - カバー写真、店名、★評価（`formula.rating_display`）、最寄り駅をカード形式でグラフィカルに表示。

---

## 5. Map View CLI コマンドとの連携

Obsidian CLI および Map View コマンドを利用して、ターミナルやAIエージェントから直接スポット操作が可能です：

```bash
# 1. 位置情報の検索・確認
obsidian mv-geosearch name="kitchen俊貴"

# 2. 2点間の直線距離計算（例: 名古屋駅〜kitchen俊貴）
obsidian mv-calc-distance from="35.1709,136.8815" to="35.169987,136.924470"

# 3. 指定したノートをMap View上でフォーカス
obsidian mv-focus-note file="kitchen俊貴"

# 4. 特定タグのスポットをクエリ検索
obsidian mv-query query="tag:#hamburg"
```

---

## 6. テスト駆動開発（TDD）検証結果

本システムは以下の自動テストスクリプトにより品質が保証されています：
- テストファイル: [`scratch/test_nagoya_hamburg_map.py`](file:///Users/mine/000_work/obsidian-dagnetz/scratch/test_nagoya_hamburg_map.py)
- 検証項目:
  1. ディレクトリ存在検証 (`test_01_directory_exists`)
  2. 厳選7店舗のノート存在検証 (`test_02_all_shop_notes_exist`)
  3. 各ノート冒頭の日本語仕様コメント検証 (`test_03_shop_notes_have_spec_comment`)
  4. Frontmatter（位置情報フォーマット、座標範囲、評価>=3.5等）の検証 (`test_04_shop_notes_frontmatter`)
  5. Basesファイル構文・ビュー定義検証 (`test_05_base_file_validity`)
- 実行結果: **5 tests passed (OK)**
