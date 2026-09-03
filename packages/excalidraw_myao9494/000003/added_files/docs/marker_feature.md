<!--
  ショートカットキー「M」によるマーカー機能仕様書
  
  作成日: 2026-09-04
  機能: 選択テキストに対する手書き風マーカーの自動付与（下半分）・トグル解除、および未選択時のフリーハンドマーカーツール起動
-->

# マーカー（テキストハイライト）機能仕様書

## 1. 概要
ショートカットキー **「M」** を押下することで、テキスト要素に対して文字の下半分にフィットする淡い黄色のマーカー（テキストハイライト）を自動生成、または手描きマーカーツールを起動する機能です。

図解ファイル: [`marker_feature.excalidraw`](file:///Users/mine/000_work/app/excalidraw_myao9494/docs/marker_feature.excalidraw)

---

## 2. 動作仕様

### 2.1 テキスト要素選択時（自動ハイライト & トグル）
- **トリガー**: 1つ以上のテキスト要素を選択した状態で `M` キーを押下。
- **マーカーの仕様**:
  - **形状**: `rectangle`（長方形）
  - **位置**: テキストのY座標から `y + height * 0.55` 付近（文字の下半分〜ベースライン付近）
  - **サイズ**: 幅は `width + 12px`（左右パディング各6px）、高さは `height * 0.45`
  - **スタイル**:
    - 背景色: `#fef08a`（淡い蛍光イエロー）
    - 枠線色: `transparent`（枠なし）
    - 塗りつぶし: `solid`
    - 粗さ (`roughness`): `1`（手書き風のラフさ・エッジの揺らぎ）
    - 角丸 (`roundness`): `{ type: 3 }`（適度な角丸）
    - 不透明度: `50%`
  - **レイヤー配置**: 対象テキスト要素の直前（配列上で手前＝描画上は背面）に配置。文字の黒色がマーカーの上に鮮明に重なります。
  - **グループ化**: テキスト要素と生成されたマーカー要素に同一の `groupId` を付与し、テキストをドラッグ移動した際にマーカーも自動追従します。
  - **トグル解除**: すでにマーカーが付与されているテキスト要素を選択して再度 `M` キーを押下すると、マーカーが削除されグループが解除されます。

### 2.2 未選択時（手動マーカー矩形描画ツール起動 & 背面自動配置）
- **トリガー**: テキスト要素が選択されていない状態で `M` キーを押下。
- **挙動**:
  - Excalidrawのツールを `rectangle`（矩形描画ツール）に切り替え。
  - 描画スタイルをマーカー用（背景色 `#fef08a`、枠線 `transparent`、塗りつぶし `solid`、粗さ `1`、角丸 `round`、不透明度 `50%`）に設定。
  - キャンバス上でドラッグすることにより、淡い黄色の半透明マーカー矩形（長方形ハイライト帯）を直接描画できます。
  - **テキスト背面への自動配置**: 描画したマーカー矩形がテキスト要素と重なっている場合、描画完了時（ポインターアップ時）に自動的にテキストの直前（背面）に移動し、テキストと同一の `groupId` でグループ化されます。これにより文字がマーカーの上にクッキリ浮き出ます。
  - **描画スタイルの自動復元**: マーカーを描き終えた瞬間（マウスボタンを離した時）に、Mキーを押す前の描画スタイル（枠線色、背景色、塗りつぶし、粗さ、不透明度など）が自動的に復元されます。

---

## 3. ファイル構成

| ファイル | 役割 |
|---|---|
| [`utils/markerUtils.ts`](file:///Users/mine/000_work/app/excalidraw_myao9494/utils/markerUtils.ts) | マーカー要素の生成・判定・トグル処理ロジック |
| [`utils/markerUtils.test.ts`](file:///Users/mine/000_work/app/excalidraw_myao9494/utils/markerUtils.test.ts) | マーカーユーティリティのユニットテスト |
| [`hooks/useKeyboardShortcuts.ts`](file:///Users/mine/000_work/app/excalidraw_myao9494/hooks/useKeyboardShortcuts.ts) | Mキー押下イベントのハンドリングとExcalidraw API呼び出し |
| [`hooks/useKeyboardShortcuts.test.ts`](file:///Users/mine/000_work/app/excalidraw_myao9494/hooks/useKeyboardShortcuts.test.ts) | ショートカットフックのユニットテスト |
| [`docs/marker_feature.excalidraw`](file:///Users/mine/000_work/app/excalidraw_myao9494/docs/marker_feature.excalidraw) | マーカー機能の構造・動作図解 |
