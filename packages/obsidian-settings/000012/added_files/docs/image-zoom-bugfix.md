<!-- 仕様: Option+ホイールでの画像ズーム機能のバグ修正に関する技術ドキュメント -->
# 技術仕様ドキュメント: 画像ズーム機能のバグ修正

> **現状（2026-10-10 時点）**: この文書が対象とするローカル改造版 `mousewheel-image-zoom-local` は、コミュニティ版 `mousewheel-image-zoom` へ置き換え済みで、保管庫には存在しない。以下は当時の修正内容の記録であり、現在のプラグインには適用されていない。対応するテスト（`scratch/test_mousewheel_image_zoom.js`）も削除済み。

## 概要
Obsidian Vault 上で動作する画像ズームプラグイン（`mousewheel-image-zoom-local`）において、Excalidraw 以外の画像（PNGやDraw.ioの図など）にカーソルがある状態でも、ファイル内に Excalidraw が1つだけ存在する場合に Excalidraw 自体がズームされてしまうバグ、およびインラインSVGで記述された Draw.io がズームできないバグを解決するための修正内容をまとめます。

## 背景・不具合原因
1. **Excalidrawの過剰検知**:
   `replaceExcalidrawEmbedSize` メソッドにおいて、ズーム対象要素（`target`）が真に Excalidraw 関連要素（`.excalidraw-svg` クラスなど）であるかの厳密なチェックが欠落していました。
   そのため、ファイル内に Excalidraw 埋め込みが1つだけ存在する場合、PNG画像など非Excalidraw要素のホイール操作時でもフォールバックロジック（`matches.length === 1`）が真となり、誤ってExcalidrawのサイズを書き換えてしまっていました。
2. **非IMG要素（インラインSVG等）の非対応**:
   Draw.io などがインラインSVGとして配置されている場合、`zoomTarget` 決定ロジック（`eventTarget.closest`）のセレクタに対象が含まれておらず、ターゲットとして認識されていませんでした。
3. **ローカル相対パスでのクラッシュ**:
   `getZoomParams` において、画像URIに `app://` もしくは `data:image/` のスキームが含まれていないローカルファイルパス（例: `test.drawio.svg`）が与えられた場合に、「Image is not zoomable」エラーがスローされていました。また、JavaScript標準の文字列メソッドに存在しない `contains` メソッドが使用されており、Node.js 等の標準環境でクラッシュする要因となっていました。

## 修正内容

### 1. Excalidrawの誤検知のガード
`replaceExcalidrawEmbedSize` メソッドの先頭に以下のガード処理を配置しました：
```javascript
const isExcalidraw = target.classList?.contains("excalidraw")
    || target.closest?.(".excalidraw-embedded-img, .excalidraw-svg, .internal-embed[src*='excalidraw'], span[src*='excalidraw'], div[src*='excalidraw']") !== null;
if (!isExcalidraw) {
    return null;
}
```
これにより、カーソル下が Excalidraw に関連しない要素（通常のPNGやDraw.io）である場合は即座に `null` を返して終了し、誤検出による Excalidraw へのサイズ変更の適用を防止します。

### 2. ズームターゲット判定の拡張
`registerEvents` メソッドにおける `zoomTarget` 抽出の `closest` セレクタを以下のように拡張しました：
- **修正前**: `img, .excalidraw-embedded-img, .excalidraw-svg, .internal-embed[src*='excalidraw'], span[src*='excalidraw'], div[src*='excalidraw']`
- **修正後**: `img, .excalidraw-embedded-img, .excalidraw-svg, .internal-embed, span[src], div[src]`

これにより、インラインSVGなどの構造をとる Draw.io 埋め込みなども `zoomTarget` として抽出されるようになります。

### 3. 相対ローカルパスの対応および文字列メソッドの安全化
`getZoomParams` メソッドにおいて：
- 標準の `includes` にフォールバックするヘルパー関数 `hasSubstring` を導入し、`contains` 不在環境でのクラッシュを防止しました。
- 画像URIが `app://` や `data:` などのスキームを持たない単純な相対ローカルパス（例：`test.drawio.svg`）の場合でも、クエリパラメータ等を正規化した上で `getLocalImageZoomParams` に引き渡して正常にズーム可能にしました。

### 4. ホイールズーム方向の反転設定の追加
- 設定画面に「Reverse scroll direction」のトグルスイッチを追加し、`DEFAULT_SETTINGS` に `reverseWheelDirection: false` を追加しました。
- この設定値を参照し、ズームイン/ズームアウトの方向判定（`deltaY` の正負）を反転させるロジックを `handleZoom`, `replaceExcalidrawEmbedSize`, `handleZoomForCanvas` のそれぞれに適用しました。
  - トグルオフ（デフォルト）：上スクロール（`deltaY < 0`）で拡大、下スクロール（`deltaY > 0`）で縮小。
  - トグルオン：下スクロール（`deltaY > 0`）で拡大、上スクロール（`deltaY < 0`）で縮小。

## 検証方法
- ユニットテスト `scratch/test_mousewheel_image_zoom.js` による動作保証。
  `reverseWheelDirection: true` 時のサイズ変更方向が正しく反転することをテストケースとして追加しています。
- テストコマンド:
  ```bash
  node --test scratch/test_mousewheel_image_zoom.js
  ```
