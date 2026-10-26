<!--
/**
 * 仕様: draw.io の図を Excalidraw の図（図形ごとに編集できる .excalidraw.md）へ変換する
 *
 * 1. 方式の選定理由（他の方法との比較）
 * 2. 呼び出し方
 * 3. 読み込める形式
 * 4. 図形・文字・矢印の対応
 * 5. 出力先
 * 6. 確認した図
 * 7. 実装・テスト
 **/
-->
# draw.io → Excalidraw 変換

draw.io プラグインで作った図（`.drawio` / `.drawio.svg` / `.dio.svg` / `.drawio.png`）を、Excalidraw プラグインで図形ごとに編集できる `.excalidraw.md` に作り直し、ノート内の元の図のすぐ下に埋め込む。元の draw.io ファイルと、元の図の埋め込みリンクは変更しない。

## 1. 方式の選定理由

draw.io から Excalidraw への公式の変換は無い（Excalidraw 本家 issue #7982 は「SVG にして貼る」で閉じられている）。

| 方法 | 結果 |
| :--- | :--- |
| SVG を画像として貼る | 1枚の画像になり、図形を編集できない |
| SVG を Excalidraw の要素に変換（`ea.importSVG` / svg-to-excalidraw） | 図形は取れるが文字を変換しない。draw.io の SVG は文字を `foreignObject`（HTML）で描くため、文字がほぼ消える |
| Mermaid 経由（`ea.addMermaid`） | フローチャートだけ。配置が作り直される |
| **元データ（mxGraphModel の XML）を読み、Excalidraw Automate で作り直す（採用）** | 位置・大きさ・文字・色・矢印のつながりを保てる |

## 2. 呼び出し方

- 右クリックメニュー「Excalidrawに変換」: ファイルエクスプローラーの draw.io ファイル、ノート内の draw.io 埋め込み（`addClipboardImageMenuItems`）。
- コマンド `custom:convert-drawio-to-excalidraw`（drawioの図をExcalidrawに変換）: 開いているファイルが draw.io ならそれを、Markdown ノートならノートが埋め込み・リンクしている draw.io の図を変換する（複数ある場合は選択）。
- Excalidraw プラグインが無効の場合は通知して何もしない。

## 3. 読み込める形式

- `.drawio.svg` / `.dio.svg`: `<svg>` の `content` 属性に入っている mxfile の XML。
- `.drawio.png`: PNG の `tEXt` チャンク（キーワード `mxfile`、URL エンコード）。図のデータの無い PNG（ただの画像）は通知して中止する。
- `.drawio` / `.dio`: ファイル全体（先頭の HTML コメントや XML 宣言は読み飛ばす）。
- `<diagram>` の本文が圧縮されている場合は「base64 → raw deflate の展開（`DecompressionStream("deflate-raw")`）→ URL デコード」で戻す。
- `<object>` / `<UserObject>` で包まれたセル（ラベルは `label` 属性、リンクは `link` 属性）も読む。
- 複数ページの図は、ページごとに Excalidraw のフレーム（ページ名付き）に入れて横に並べる。

## 4. 図形・文字・矢印の対応

| draw.io | Excalidraw |
| :--- | :--- |
| 四角（既定）、`label`、`mxgraph.flowchart.process` | 四角（`rounded=1` は角丸） |
| `ellipse`、`mxgraph.flowchart.start_1/start_2/on-page_reference/or/summing_function` | 楕円 |
| `rhombus`、`mxgraph.flowchart.decision/sort`、ひし形の輪郭（`perimeter=rhombusPerimeter`。BPMN のゲートウェイなど） | ひし形 |
| `mxgraph.flowchart.terminator`（端子） | 角丸の四角（Excalidraw では半円の両端にできないため） |
| `process`、`mxgraph.flowchart.predefined_process` | 四角＋左右の縦線（グループ） |
| `swimlane` | 本体の四角（`swimlaneFillColor`）＋見出しの帯（`fillColor`、幅は `startSize`、既定 23）＋見出しの文字をグループにする。`horizontal=0` は見出しが左端の縦の帯で、文字を 270°（下から上へ読む向き）に回す。中の図形はレーンとグループにしない |
| 多角形・曲線の図形: `parallelogram`/`mxgraph.flowchart.data`、`trapezoid`、`mxgraph.flowchart.manual_operation`、`hexagon`/`mxgraph.flowchart.preparation`、`triangle`、`mxgraph.flowchart.extract_or_measurement/merge_or_storage`、`document`/`mxgraph.flowchart.document/multi-document`、`tape`/`mxgraph.flowchart.paper_tape`、`mxgraph.flowchart.manual_input`、`cylinder3`/`mxgraph.flowchart.database`、`step`、`offPageConnector`、`card`、`note`、`mxgraph.flowchart.delay/display/stored_data/loop_limit/annotation_1` | 輪郭を閉じた線（塗りつぶし）で描き、同じ大きさの透明な四角にラベルと矢印を結び付けて、グループにする（Excalidraw の線には文字・矢印を結び付けられないため）。`direction`（south など）と `flipH` / `flipV` も反映する |
| `text`、枠も塗りも無い図形 | 文字だけの要素 |
| `shape=umlActor` | 頭（円）と線の人型＋透明な四角（矢印の結び付け先）。ラベルは下に置き、まとめてグループ |
| `group`（見えない入れ物） | 中の図形をグループにする |
| その他の図形（`mxgraph.aws4.*` など） | 四角で代用し、変換後の通知に図形名を出す |

- **位置**: 親の図形（スイムレーンなど）の中にある図形は、親の位置を足した絶対位置にする。
- **回転**: `rotation` は図形の角度にする（部品を組み合わせた図形を除く）。
- **色・線**: `fillColor`（`none` は透明、指定なしは白）、`strokeColor`、`strokeWidth`、`dashed`、`opacity` を写す。グラデーション・影は使わない。手書き風のゆらぎ（roughness）は 0。
- **文字**: ラベルの HTML（`<b>`、`<br>`、`<div>`、`&nbsp;` など）は改行を保ったプレーンテキストにする。末尾の改行（`Project<br>` など。draw.io で文字を上へ寄せるために使われる）は残す。フォントは Excalidraw の Nunito（6）、文字サイズ・色は draw.io の `fontSize` / `fontColor`。太字は表現できない。
- **図形のラベル**: 図形に結び付けた文字（図形を動かすと一緒に動く）にし、`align` / `verticalAlign` を引き継ぐ。ただし次の場合は、draw.io と同じく図形の幅で折り返した文字を図形の中央に置き、図形とグループにする（`doesDrawioLabelFitContainer`）。
  - Excalidraw は図形の内側（ひし形は幅の半分、楕円は約 0.7 倍）で折り返すため、draw.io より改行が増える場合（細いひし形の「在庫あり？」など）。
  - 英単語が途中で切れる場合（「obscu / rities?」など）、または高さからはみ出す場合。
- **縦書きのラベル**: `horizontal=0` の図形のラベルは、270° 回した文字にして図形とグループにする（図形に結び付けた文字は回せないため）。
- **外側のラベル**: `verticalLabelPosition=bottom` などで図形の外に置くラベルは、独立した文字にして図形とグループにする。
- **リンク**: 図形のリンクは Excalidraw の要素のリンクにする（URL はそのまま、それ以外は `[[ファイル]]`）。
- **矢印**: 始点・終点の図形に結び付ける（図形を動かすと矢印が追従する）。結び付け位置（fixedPoint）は draw.io の `exitX/exitY`・`entryX/entryY` と同じ位置になる。
  - 直交の矢印（`orthogonalEdgeStyle`、`elbowEdgeStyle`、`segmentEdgeStyle` など）は Excalidraw の折れ線矢印（elbow arrow）にする。draw.io は自動で引いた経路をモデルに保存しないため、`.drawio.svg` では SVG に描かれた経路（`data-cell-id` のグループの最初の `path`）を使い、縦横にそろえる。
  - SVG の経路が無い場合（`.drawio`、古い形式の SVG）は経路を作る（`routeDrawioElbowEdgeFallback`）: ポート（`exitX` / `entryX`）があればその辺から、無ければ相手の図形に向いた辺の中央から出入りする。`elbowEdgeStyle` は `elbow`（horizontal / vertical）の向きに、それ以外は図形の間の隙間が大きい向きに進み、L 字・Z 字にする。`elbowEdgeStyle` の中継点1つは折れ曲がる位置を表す。
  - 直線の矢印で始点・終点の位置の指定が無い場合は、図形の中心から相手へ向かう線と輪郭（楕円・ひし形は曲線・斜辺）の交点から出入りする。
  - 中継点（`mxPoint`）はそのまま通る。図形に結び付いていない矢印は `sourcePoint` / `targetPoint` を使う。
  - `rounded=1` と `curved=1` の直線の矢印は、Excalidraw の曲線の矢印にする。
  - 先端: `classic` / `block`（draw.io の既定、塗りつぶした三角形）→ triangle、`open` → arrow、`oval` → circle、`diamond` → diamond、ER 記法 → crowfoot など。`endFill=0` は中抜き。
  - 矢印のラベル（`value` と `edgeLabel` のセル）は、矢印に結び付けた文字にして経路の中間に置く。

## 5. 出力先とノートへの埋め込み

- 元のファイルと同じフォルダに `<元の名前>.excalidraw.md` を作る（`ea.create`）。同名がある場合は `_1`, `_2` … を付ける。
- ノート内の元の図の埋め込み（`![[図.drawio.svg|558]]`、`![説明|300](図.drawio.svg)`）の次の行に、変換した図の埋め込み `![[図.excalidraw|558]]` を追加する（`addExcalidrawEmbedBelowDrawio` / `findDrawioExcalidrawEmbedInsertions`）。
  - サイズの指定（`|558`、`|600x400`）は引き継ぐ。箇条書きの中の埋め込みは、本文の位置に字下げする。
  - 次の行に同じ埋め込みが既にある場合は追加しない。
  - 対象のノート: ノート内の埋め込みの右クリック、またはノートからのコマンドでは、そのノートだけ。ファイルエクスプローラーや draw.io の画面からでは、元の図を埋め込んでいる全ノート（`metadataCache.resolvedLinks`）。
  - 編集モードで開いているノートはエディタへ挿入し（`cm.dispatch`。表示位置を変えない）、それ以外はファイルを書き換える（`app.vault.process`）。
- 埋め込んだノートがある場合は変換した図を開かない（ノートに表示される）。埋め込むノートが無い場合は新しいタブで開く。
- 元の draw.io ファイルと、元の図の埋め込みリンクは変更しない。

## 6. 確認した図

スイムレーンとフローチャートは、次の図を draw.io（draw.io プラグインに同梱の Web アプリ、プラグインと同じ埋め込みモード）で `.drawio.svg` に書き出し、変換結果を Excalidraw プラグインと同じ描画部品（`@zsviczian/excalidraw` の Obsidian 用ビルド）で描いて、元の図と見比べた（2026-10-26）。

- 自作の4つ（`scratch/fixtures/drawio/`。保管庫の `01_data/2026/10/26/drawio変換テスト.md` に同じ図を埋め込んである）: 横スイムレーン（プール＋3レーン）、縦スイムレーン（列ごとの色）、フローチャート図形パレットのフローチャート、一般図形のフローチャート
- draw.io のテンプレート6つ: `flowcharts/flowchart_1`・`flowchart_2`・`cross_functional_flowchart_1`・`cross_functional_flowchart_2`・`workflow_1`、`business/swimlane`

違いとして残るもの: 端子が角丸の四角になる、太字にならない、矢印のラベルは経路の中間に置く（Excalidraw の決まり）、BPMN のゲートウェイの記号（＋など）は描かない。

## 7. 実装・テスト

- 実装: [27_drawio_to_excalidraw.js](../80_script/register_custom_commands/27_drawio_to_excalidraw.js)（メニュー項目は `07_image_copy_menu.js`、コマンドは `13_commands.js`）
- テスト: [scratch/test_drawio_to_excalidraw.js](../scratch/test_drawio_to_excalidraw.js)（XML の取り出し・展開、図形と矢印の対応、スイムレーン・フローチャートの図形・ラベルの置き方・直交の矢印の経路、EA の要素の作成、ファイル名、元の図の下への埋め込み）。draw.io で書き出した実際の図（`scratch/fixtures/drawio/*.drawio.svg`）も変換し、すべての図形・ラベル・矢印ができて矢印が図形に結び付くことを確かめる。メニュー項目は `scratch/test_drawio_edit_menu.js`。
