# 仕様書: 独立型 Excalidraw Cards プラグインおよび画像キャッシュ最適化

---
## 概要
`01_data` 配下にあるすべての `.excalidraw.md` および `_excalidraw.md` ファイルを、Vaultのデータフォルダを一切汚すことなく、プレビュー付きの美麗なカード形式で一覧表示し、更新日時の降順でソートする独立したプラグイン `obsidian-excalidraw-cards` の仕様書です。

表示速度の極限化とちらつき（フリッカー）の排除、およびHTML/Word出力互換性のために、Vaultルート直下の隠しフォルダ `.excalidraw-cache/` にプレビューPNG画像を自動的にキャッシュする機構を備えています。

さらに、キャッシュ時の「図形の周囲の余白」を徹底的に排除し、カードサイズに合わせて枠（アスペクト比 `16/10`）いっぱいにプレビュー画像が表示されるように最適化されています。

---

## 詳細仕様

### 1. 独立プラグイン（`obsidian-excalidraw-cards`）
- **ID**: `obsidian-excalidraw-cards`
- **対象ファイル**: `01_data` 配下にある `.excalidraw.md` または `_excalidraw.md` で終わるファイル。
- **表示形式**: 
  - CSSグリッドを用いたプレミアムなカードレイアウト（アスペクト比 `16/10` の画像コンテナ）。
  - タイトルには図面名（ファイル名から `.excalidraw.md` または `_excalidraw.md` を除いたもの）を表示。
- **ソート条件**: 更新日時（`file.stat.mtime`）の降順（最新のものが上）。
- **ドラッグ＆ドロップ**: カードをエディタにドラッグ＆ドロップすると、リンクおよびWebアプリ開閉用のMarkdown表記が自動挿入されます。

### 2. 高精細・余白なしの画像キャッシュシステム
プレビューの高速化とレイアウトの美しさの両立のため、以下のキャッシュシステムを実装します。

1. **キャッシュ保存先**:
   - Vaultルート直下の隠しフォルダ `.excalidraw-cache/` に保存。
   - `.obsidian/` 配下ではVault APIが正常動作しないため、Vault API管轄内のパスを使用。
   - Obsidianファイルエクスプローラーでは `.` 始まりのフォルダはデフォルト非表示。
   - パス定数 `CACHE_DIR` で一元管理（`utils.ts`）。

2. **キャッシュキー判定**:
   - 各ファイルのパスの文字列ハッシュ値（`[hash]`）と最終更新日時（`[mtime]`）を組み合わせて、キャッシュファイル名 `.excalidraw-cache/[hash]_[mtime].png` を判定します。
   - キャッシュ生成時に `.excalidraw-cache/index.json` へ `{ "path/to/file.excalidraw.md": { "hash": "[hash]", "cachefile": "[hash]_[mtime].png", "format": "png", "mtime": 1234567890 } }` 形式で索引を書き込みます。HTML出力側はこの索引を優先して参照し、パス正規化差によるハッシュ不一致を避けます。
   - 索引の更新（読む → 1件足す → 書く）は1件ずつ順番に行う（`utils.ts` の `updateCacheIndex`）。プレビューは複数枚を同時に作るため、同時に更新すると後から書いた方が先の記録を消してしまう。
   - キャッシュが存在する場合は、`app.vault.adapter.getResourcePath` からWebURLを生成し、`<img>` タグの `src` に指定して即時描画します（ちらつきゼロ、表示負荷ほぼゼロ）。
   - Canvas制約などでPNG変換できない図面のみ、同じ `[hash]_[mtime].svg` の旧形式キャッシュへフォールバックし、indexには `fallbackCachefile` と `format: "svg"` を記録します。このSVGキャッシュも有効なキャッシュとして扱い、ファイル更新がない限り再生成しません。
   - ファイルが編集されると `mtime` が更新されるため、古いキャッシュは自動的に削除され、新しいキャッシュが自動生成されます。

3. **可視範囲ベースの非同期レンダリング**:
   - カード一覧描画時、キャッシュ済みカードは即時描画し、キャッシュ未作成カードはローディング表示にします。
   - キャッシュ未作成カードは全件一括生成せず、`IntersectionObserver` により画面付近へ入ったカードから非同期生成します。
   - 検索・タブ切替・ファイル更新で再描画が発生した場合は描画リビジョンを確認し、古い非同期生成結果が新しい一覧へ反映されないようにします。
   - UIブロックを回避し、通常のノート編集やスクロールへの応答性を維持。

4. **ExcalidrawAutomate API を用いた余白なしSVG生成とPNG保存**:
   - `window.ExcalidrawAutomate` APIが利用可能な場合、隠しDOM（オフスクリーン）へのMarkdownRenderer描画をバイパスし、バックグラウンドでExcalidrawファイルから直接SVG要素を生成します。
   - `ea.createSVG` の第6引数（`padding`）に `5` を指定することで、図形要素のバウンディングボックスぎりぎりまで余白をトリミングした高精細なSVGを取得します。
   - 取得したSVGはCanvasで3倍スケールのPNGへ変換してからキャッシュに保存します。これにより、Pandoc経由のWord変換でも画像が安定して表示されます。

5. **SVGアスペクト比の維持 (フォールバック用)**:
   - `ExcalidrawAutomate` が不在の際に使用する `MarkdownRenderer` のオフスクリーン方式においても、生成された `svg` の `width` / `height` 属性は**削除するのみ**とし、`100%` を強制上書きすることを廃止します。
   - これにより、SVG内の `viewBox` 属性が持つ固有の縦横アスペクト比がそのまま維持された状態でキャッシュファイルに書き込まれます。

6. **CSS `object-fit: cover` によるカード全域のカバー**:
   - `.excalidraw-card-image img` および `.excalidraw-card-image svg` のCSS表示スタイルを `object-fit: cover;` に設定します。
   - これにより、元の図形のアスペクト比を完璧に維持したまま、カードのプレビュー表示枠を一切の空白を残さずに完全に敷き詰めて（カバーして）表示します。

---

## 技術的要件
- **キャッシュディレクトリ**: `.excalidraw-cache/`（Vaultルート直下、`CACHE_DIR` 定数で管理）
- **API**: Obsidian Vault Adapter API のみ使用（Node.js `fs` への依存は完全排除）
- **ExcalidrawAutomate**: グローバルな `ExcalidrawAutomate` オブジェクトを呼び出し、`ea.reset()`, `ea.loadFromFile(file)`, `ea.createSVG(...)` による非同期画像生成を実行。
- **自動クリーンアップ**: 新しいキャッシュ生成時に、同一ハッシュを持つ古い `mtime` のキャッシュファイル（PNGおよび旧SVG）を自動走査して削除（`utils.ts` の `cleanOldCaches` 内に実装）。
- **TDD (テスト駆動開発)**: キャッシュパス組み立て、ハッシュ生成、古いキャッシュ削除等の処理は `utils.test.ts` でテストを実施し、アサーションに合格すること。
