# アンダーライン（赤色下線）機能仕様書

ショートカットキー **「U」**（Underline）を押下することで、テキスト要素の下に赤色の直線下線を引く機能です。

---

## 1. 概要

- **ショートカットキー**: `U`（大文字・小文字両対応、Ctrl/Cmd等の修飾キーなし）
- **目的**: テキストの重要箇所を赤色下線で強調表示する。
- **入力中の保護**: `<input>` や `<textarea>`、`contenteditable` 要素にフォーカスがある場合はショートカットが無効化され、通常の文字入力が妨げられません。

---

## 2. 動作仕様

### 2.1 テキスト要素選択時（自動アンダーライン生成 & トグル解除）
- **トリガー**: 1つ以上のテキスト要素を選択した状態で `U` キーを押下。
- **挙動**:
  - 選択されたテキスト要素の下端直下に、赤色の直線要素（`line`）を自動生成。
  - **スタイル**:
    - 線の色 (`strokeColor`): `#e03131`（Excalidraw標準レッド）
    - 線の太さ (`strokeWidth`): `2px`
    - 線の種類 (`strokeStyle`): `solid`
    - 粗さ (`roughness`): `1`（手書き風の自然なエッジ）
    - 不透明度 (`opacity`): `100%`
    - 矢印ヘッド: なし（`startArrowhead = null`, `endArrowhead = null`）
  - **位置**: テキストのX座標から幅分（`x` 〜 `x + width`）、Y座標はテキスト下端直下（`y + height + 2px`）。
  - **グループ化**: テキスト要素と生成された下線要素に同一の `groupId` を付与し、テキストを移動した際に下線も自動追従します。
  - **トグル解除**: すでにアンダーラインが付与されているテキスト要素を選択して再度 `U` キーを押下すると、下線が削除されグループが解除されます。

### 2.2 未選択時（手動直線下線ツール起動 & スタイル自動復元）
- **トリガー**: テキスト要素が選択されていない状態で `U` キーを押下。
- **挙動**:
  - Excalidrawのツールを `line`（直線ツール）に切り替え。
  - 描画スタイルをアンダーライン用（線の色 `#e03131`、線の太さ `2px`、粗さ `1`）に設定。
  - キャンバス上でドラッグすることにより、赤色の直線下線を自由に引くことができます。
  - **テキストとの自動グループ化**: 描画した下線がテキスト要素の下端付近と重なっている/近接している場合、描画完了時（ポインターアップ時）に自動的にテキストと同一の `groupId` でグループ化されます。
  - **描画スタイルの自動復元**: 下線を描き終えた瞬間（マウスボタンを離した時）に、Uキーを押す前の描画スタイル（文字色、枠線色、線の太さ、不透明度等）が自動的に元通り復元されます。

---

## 3. ファイル構成

| ファイル | 役割 |
|---|---|
| [`utils/underlineUtils.ts`](file:///Users/mine/000_work/app/excalidraw_myao9494/utils/underlineUtils.ts) | アンダーライン要素の生成、トグル判定、近接テキストとのグループ化ロジック |
| [`utils/underlineUtils.test.ts`](file:///Users/mine/000_work/app/excalidraw_myao9494/utils/underlineUtils.test.ts) | アンダーライン生成・トグル・グループ化の単体テスト |
| [`hooks/useKeyboardShortcuts.ts`](file:///Users/mine/000_work/app/excalidraw_myao9494/hooks/useKeyboardShortcuts.ts) | ショートカットキー `U` のハンドラ、ツール切り替え、スタイル退避・自動復元 |
| [`hooks/useKeyboardShortcuts.test.ts`](file:///Users/mine/000_work/app/excalidraw_myao9494/hooks/useKeyboardShortcuts.test.ts) | Uキー押下時のツール起動、下線生成、スタイル復元の連携テスト |
| [`docs/underline_feature.excalidraw`](file:///Users/mine/000_work/app/excalidraw_myao9494/docs/underline_feature.excalidraw) | アンダーライン機能の図解 |
