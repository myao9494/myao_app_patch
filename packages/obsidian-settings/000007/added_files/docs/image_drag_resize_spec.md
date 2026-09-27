<!--
/**
 * 仕様: 画像およびExcalidraw埋め込み図の右下ドラッグによる拡大縮小（リサイズハンドル）仕様ドキュメント
 * 
 * 1. 概要: Markdown画像およびExcalidraw埋め込み図の右下にリサイズハンドルを表示し、マウスドラッグによる自由な拡大縮小とノート本文へのサイズ自動保存を実現
 * 2. 課題: Obsidian標準にはドラッグリサイズUIがなく、Excalidraw埋め込みでは拡張子省略リンクやSVGの描画構造によりリサイズが阻害されていた
 * 3. 解決策: コンテナの右下にリサイズハンドルを配置し、拡張子省略名マッピング、SVGアスペクト比維持、HUD表示、本文リンク自動更新を実装
 **/
-->
# 仕様書: 画像およびExcalidraw埋め込み図の右下ドラッグによる拡大縮小（リサイズハンドル）

## 1. 概要
Markdownノート内（Live Preview / 読込画面）に配置された通常の画像埋め込み（`![[画像名]]`）およびExcalidraw埋め込み図（`![[diagram.excalidraw]]`、拡張子省略記法 `![[diagram|350]]` 等）の右下にリサイズハンドルを表示し、マウスドラッグ操作によって直感的に拡大・縮小できる機能を実装しました。
ドラッグ完了時には、ノート本文のMarkdown記法（`![[名前|新サイズ]]`）が自動的に更新・保存されます。

## 2. 課題と背景
- **ドラッグ操作UIの欠如**: Obsidian標準では画像の右下を掴んでドラッグリサイズするUIハンドルが存在せず、マウスホイール（Option+ホイール）やマークダウンの直接編集に頼る必要がありました。
- **直感的操作への要望**: 一般的な画像編集ツールやワードプロセッサのように、「図や画像の右下をドラッグしてサイズを合わせる」という自然な操作が求められていました。
- **Excalidraw埋め込み固有の課題**:
  1. **コンテナ制限**: `applyFigureEmbedDisplayNames` やCSSセレクタが `data-figure-kind === "image"` に限定されていたため、Excalidraw埋め込みコンテナにリサイズハンドルが付与されなかったり表示されなかったりしていました。
  2. **拡張子省略リンクとの不整合**: Excalidrawでは、ファイル名が `ノート名.md`（または `.excalidraw.md`）であっても、ノート本文中では拡張子省略で `![[ノート名|1125]]` と記述されることが標準です。完全一致のファイル名探索ではリンクの置換に失敗し、本文にサイズが保存されませんでした。
  3. **SVGアスペクト比の維持**: Excalidrawは内部がインラインSVGやcanvasでレンダリングされるため、コンテナの幅変更に合わせて `width: 100%; height: auto;` を明示しないと図が歪んだり追従しなかったりする問題がありました。

## 3. 実装詳細

### (1) 右下リサイズハンドル (`.custom-image-resizer-handle`)
- **配置**:
  - 画像コンテナ（`.image-embed, .media-embed`）
  - Excalidraw埋め込みコンテナ（`.media-embed[data-figure-kind="excalidraw"]`, `.internal-embed[data-figure-kind="excalidraw"]`, `.excalidraw-svg[data-figure-name]`）
  - 各要素の右下角（`bottom: 4px; right: 4px;`）に絶対配置。
- **外観**: 通常時は邪魔にならないよう非表示または控えめに表示され、要素にマウスホバーした時や要素を選択した時（`.custom-selected-markdown-image`）にアクセントカラーで明瞭に表示されます。
- **カーソル**: 斜めリサイズを示す `cursor: nwse-resize` を設定。

### (2) マウスドラッグ操作とHUDツールチップ
- **ドラッグ開始 (`mousedown`)**:
  - 左ボタンでハンドルを押し込んだ際、エディタのテキスト選択や要素のドラッグ＆ドロップ動作をキャンセル（`preventDefault`, `stopPropagation`）。
  - 初期座標と初期幅を保持し、ドラッグモードに突入。
- **ドラッグ中 (`mousemove`)**:
  - マウスの水平移動量（`deltaX`）を元に、最小幅 50px から滑らかにサイズをリアルタイム伸縮。
  - マウスカーソルの直上に現在のピクセル幅を示すツールチップ（HUD、例: `350px`）を表示。
  - キャプション幅（`--figure-width`）や内部SVG/canvas要素（`width: 100%; height: auto;`）も自動追従。
- **ドラッグ完了 (`mouseup`)**:
  - ツールチップを消去し、ドラッグを終了。
  - アクティブなMarkdownエディタまたはファイルの本文を自動更新。
    - `![[画像名.png]]` → `![[画像名.png|350]]`
    - `![[diagram]]` → `![[diagram|350]]`
    - `![[diagram|200]]` → `![[diagram|350]]`
  - Notice通知で変更完了をフィードバック。

### (3) ダブルクリックによるサイズリセット (`dblclick`)
- ハンドルをダブルクリックすると、サイズ指定を解除（`![[名前]]` に戻す）し、画像やExcalidraw本来のサイズ（100%）にワンクリックで復元します。

### (4) イベントガードの最適化
- `blockExcalidrawPointerDown` において、クリック対象がリサイズハンドル（`.custom-image-resizer-handle`）である場合は早期リターンし、イベントの伝播停止によるドラッグ阻害を防止。

## 4. 関連ファイル
- [.obsidian/snippets/excalidraw-embed-width.css](file:///Users/mine/000_work/obsidian-dagnetz/.obsidian/snippets/excalidraw-embed-width.css)
- [00_templates/RegisterCustomCommands.md](file:///Users/mine/000_work/obsidian-dagnetz/00_templates/RegisterCustomCommands.md)
- [scratch/test_image_drag_resize_handle.js](file:///Users/mine/000_work/obsidian-dagnetz/scratch/test_image_drag_resize_handle.js)
- [scratch/test_excalidraw_drag_resize.js](file:///Users/mine/000_work/obsidian-dagnetz/scratch/test_excalidraw_drag_resize.js)
- [docs/image_drag_resize_flow.excalidraw.md](file:///Users/mine/000_work/obsidian-dagnetz/docs/image_drag_resize_flow.excalidraw.md)
