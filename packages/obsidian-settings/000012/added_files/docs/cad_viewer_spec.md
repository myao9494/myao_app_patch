<!--
/**
 * CAD Viewer プラグイン詳細仕様書
 * 
 * 1. プラグイン名: CAD Viewer (ID: cad-viewer)
 * 2. 視点・断面・注記の固定・保存とロックフリーズ機能（🔒 / 🔓）
 * 3. CADファイルドロップ時のコードブロック自動挿入（キャプチャフェーズ）
 * 4. 注記（アノテーション）の確実なテキストエリア編集・IME保護・保存ボタン
 * 5. 擬似ソリッド断面＋斜線ハッチング表示
 **/
-->

# 仕様書: CAD Viewer（3D CADビューア）

## 1. 概要
本仕様書は、3D CADモデル（`.step`, `.stp`, `.fcstd`, `.obj`, `.stl`）を閲覧・操作・編集記録するObsidian独自プラグイン「**CAD Viewer**」（ID: `cad-viewer`）の設計・実装仕様を定義する。

## 2. 実装機能と詳細仕様

### 2.1 視点固定（ロック）トグル機能（最上部に常時配置）
- **UI**: ツールバーの**最上部（先頭グループの一番上）**に「視点固定 / ロック解除（🔒 `lock` / 🔓 `unlock`）」トグルボタンを配置。ビューアの表示サイズを小さくした場合でも隠れることなく、常に最上部で視認・操作可能。
- **動作**:
  1. **ロック状態への遷移**:
     - 現在のカメラ姿勢（位置・ターゲット・ズーム）、断面、注記、および `locked: true` をコードブロックに保存。
     - 3Dモデルの操作（マウスドラッグによる回転、ホイールによるズーム、パン、ViewCubeクリック、Roll、パーツクリック選択）を**完全にフリーズ（無効化）**。
     - **注記（アノテーション）の編集だけはロック中であっても自由に操作可能**。
     - Notice: `CAD Viewer: 視点を固定しました（ロック中。3Dモデルの操作は停止され、注記の編集のみ可能です）` を表示。
  2. **ロック解除への遷移**:
     - もう一度ボタンをクリックするとロック解除（`locked: false`）。
     - カメラ回転・ズーム・移動が再度自由に行える状態へ復帰。
     - Notice: `CAD Viewer: ロックを解除しました（3Dモデルの操作が可能です）` を表示。
  3. **自動復元**:
     - コードブロック内に `locked: true` がある場合、次回ファイルを開いた際も最初からロック状態（フリーズ）で起動する。

### 2.2 CADファイルドロップ連携（キャプチャフェーズ）
- **対象拡張子**: `.step`, `.stp`, `.fcstd`, `.obj`, `.stl`
- **動作**:
  - `document.addEventListener("drop", handleDrop, true)`（DOMキャプチャフェーズ）により、Obsidian標準（CodeMirror）の `[[ファイル名]]` 挿入イベントより前にドロップを横取りし、`e.preventDefault()`, `e.stopImmediatePropagation()` を実行。
  - OSからのファイルドロップ時は、Obsidianの添付ファイル設定（`getAvailablePathForAttachment`）に従ってVaultへ自動保存。
  - Obsidianファイルツリーからのドラッグ＆ドロップ時は、対象ファイルのVault相対パスを自動解決。
  - ドロップ位置（`posAtCoords`）に以下のコードブロックを直接挿入：
    ```step
    path: 01_data/2026/10/06/CBES (50kg to 2000kg).step
    height: 800
    view: iso
    ```
  - 安全策（フォールバック）として、万が一エディタ内に `[[...step]]` が挿入された場合も `editor-change` で検知し、即座にコードブロックへ自動置換する。

### 2.3 注記（アノテーション）編集機能
- **UI**: 注記カード上部に編集アイコン（鉛筆）を配置。カード本文（Markdown表示部分）の直接クリックでも編集開始。
- **ドラッグとクリックの競合解消**:
  - 本文領域（`renderEl`）および編集コントロールはドラッグハンドルから除外。
  - クリック時にドラッグ用の pointer capture がかからないため、スムーズに編集モードへ移行。
- **入力・保存の確実化**:
  - 編集モード時は `<textarea>` と「保存」「取消」ボタンを表示。
  - 不意のフォーカス外れ（`blur`）による自動コミットを廃止し、入力中の内容が勝手に失われる現象を防止。
  - 日本語IME入力保護（`compositionstart` / `compositionend`）により、漢字変換確定のEnterキーで保存されないよう制御。
  - `Ctrl+Enter` / `Cmd+Enter` または「保存」ボタン押下でテキストを保存し、Markdownプレビューへ復帰。
  - `Escape` または「取消」ボタンで編集をキャンセル。
  - 注記カードの横幅を320pxに広げ、見やすく操作しやすいUIを提供。

### 2.4 擬似ソリッド断面とハッチング表示
- **断面キャッピング**:
  - 平面とメッシュの交点から生成されたポリゴン（Cap Geometry）を幾何計算で生成。
  - 斜線ハッチングテクスチャ（CanvasTexture）を貼り付けたマテリアルを適用。
  - 中空のオープンシェルであってもソリッド断面として塞がれた美しいCAD図面風のハッチング表示を実現。

### 2.5 枠ドラッグによる幅・高さ変更（リサイズ）機能
- **構造設計**:
  - 埋め込み要素を外側のラッパー（`.step-viewer-embed-wrapper`）と描画ホスト（`.step-viewer-embed-host`）の二重構造に分離。
  - 3Dモデル読み込みやエラー表示時の `this.host.empty()` による再構築の影響を受けないよう、リサイズハンドルをラッパー直下に常駐化。
- **UI**:
  - 埋め込みビューア（```step）枠の右端（`mod-right`、幅10px、カーソル: `ew-resize`）
  - 下端（`mod-bottom`、高さ10px、カーソル: `ns-resize`）
  - 右下隅（`mod-corner`、18×18px、カーソル: `nwse-resize`、対角スジ入りグリップ）
- **動作**:
  - マウスで枠をドラッグすることで、幅（width）および高さ（height）をインタラクティブに変更。
  - ドラッグ中はホストに `pointer-events: none` を適用し、Three.js のキャンバスやツールバーの誤動作を防止しスムーズな追従を実現。
  - 最小幅250px、最小高さ200px、およびエディタ親幅の境界チェック（`clampEmbedSize`）を適用。
  - `ResizeObserver` により Three.js のカメラアスペクト比とレンダラーサイズがリアルタイムに滑らかに追従。
  - ドラッグ完了時に、確定したサイズを Markdown ノート内の ```step コードブロック（`width`, `height`）へ自動保存。

### 2.6 複数配置時の個別特定・独立更新機能（同期防止）
- **概要**:
  - 同一ノート内に同一STEPファイルまたは異なるSTEPファイルが複数配置されている場合、一方の枠ドラッグや視点固定を実行しても他方に影響を与えず、各ブロックを個別に独立してサイズ・視点設定できる。
- **特定ロジック**:
  1. **行番号特定**: Obsidianの `ctx.getSectionInfo(containerEl)` から取得した行範囲（`lineStart` 〜 `lineEnd`）が有効な場合、その行にあるコードブロックのみをピンポイントで置換。
  2. **オリジナル文字列照合**: 行番号が取得できない場合、自分自身がロード時に保持する `originalSource` と完全一致するブロックを検索し、「1箇所のみ」置換（全置換 `g` を防止）。
  3. **フォールバック**: パス一致時も最初の1箇所のみを置換し、ノート内の全ブロックが一斉に同期して書き換わる事故を100%防止。

### 2.7 注記（アノテーション）の通常時テキスト表示＆オンデマンド編集ボックス展開
- **通常時（非編集時）のクリーン表示**:
  - 枠線、影、背景、ヘッダーツールバー、保存/取消ボタン等を非表示とし、引出線の先に**テキストのみ**をスッキリと配置。
  - テキストにカーソルを合わせるとホバー枠（破線）が表示され、クリック可能であることを直感的に提示。
- **編集モード（オンデマンド展開）**:
  - テキストをクリックすると、カード枠（`.is-editing`）、ツールバー、テキストエリア（`<textarea>`）、保存/取消ボタンがポップアップ展開。
  - 保存（`Ctrl+Enter` / 「保存」ボタン）または取消（`Esc` / 「取消」ボタン）で編集ボックスが閉じ、通常時のテキスト表示にスマートに戻る。
  - 新規作成時（モデルクリック時）は、最初から編集ボックスが開いた状態で即座に入力開始可能。

### 2.8 注記テキストの文字色・文字サイズ変更機能
- **文字サイズ変更 (`fontSize`)**:
  - 編集ボックスツールバーの「文字の大きさ（`T`）」ボタンから、S（12px: 小）、M（14px: 中）、L（18px: 大）、XL（24px: 特大）を選択可能。
  - 選択したサイズは即座に通常時テキストおよびテキストエリアに反映。
- **文字色変更 (`textColor`)**:
  - ツールバーの「文字色（パレット）」ボタンから、視認性の高いプリセットカラー（黒、白、赤、緑、青、橙、黄）およびカスタムカラーピッカー（`<input type="color">`）で自由に設定可能。
- **データ永続化**:
  - 設定された `textColor` および `fontSize` はコードブロック（YAML）に自動保存され、ノート再読込時にも完全復元。

### 2.9 ボタン・UIアイコンの視認性保証
- **保存ボタン（黄色背景の黒文字化）**:
  - 保存ボタン（`.step-viewer-annot-action-btn.mod-save`）およびアクティブアイコンにおいて、アクセントカラー（黄色系）背景時に文字が白になって見えなくなる問題を解消し、`color: #000000 !important; font-weight: 600;` で明瞭な黒文字表示を保証。
- **取消（キャンセル）ボタンの視認性**:
  - ダークテーマ環境下で取消ボタンが黒背景に黒文字化して見えなくなる現象を解消。ダークテーマ時は明るい文字色（`var(--text-normal)`）、適切な枠線とフォームフィールド背景により、常にハッキリと読めるよう視認性を確保。
- **削除ボタン（×）のアイコン化と視認性**:
  - 右上の削除ボタン（`.step-viewer-annot-del`）をObsidian標準のクリーンなSVGアイコン（`x`）化し、背景透明・ホバー時赤色で確実に視認可能。

### 2.10 Delete / Backspace キーによる注記・寸法の直感的削除
- **注記の削除**:
  - 通常時（テキストのみ表示時）に注記をクリックして選択（フォーカス）した状態で `Delete` または `Backspace` キーを押すと、確認なしで即座に注記を削除。
  - ※テキストエリア入力中（文字編集中）は、文字消去操作を妨げないようイベント伝播を保護し、注記自体の削除は行われない。
- **寸法の削除**:
  - ピン留めされた寸法バッジ（`.step-viewer-mpinned`）をクリックしてフォーカスした状態で `Delete` または `Backspace` キーを押すと、寸法線・マーカー・バッジを一括削除。
- **グローバル Delete キー（ノート削除）との共存**:
  - `00_templates/RegisterCustomCommands.md` は `Delete` キーでアクティブなノートを削除するグローバルハンドラ（`handleDeleteKey`）を document のキャプチャ段階に登録している。
  - CAD Viewer 内の要素（`.step-viewer-embed` または `[data-type='step-viewer-view']` の配下）にフォーカスがある間は、このハンドラは `Delete` を横取りせず、注記・寸法の削除処理へキー操作を渡す。詳細は [delete_command_spec.md](delete_command_spec.md)。

### 2.11 線（直線エッジ）および円（穴・円筒リム）のワンクリック寸法測定
- **直線エッジの自動検出**:
  - 計測モード（距離 `distance`）時、3Dモデル上の直線エッジ近傍をクリックすると、2点クリック不要で直線の両端点・長さ（mm）をワンクリックで自動計測。
- **円形エッジ（穴・円筒リム）の自動検出と直径表示**:
  - 計測モード時、円形エッジ（ボルト穴や円筒パーツのリム）の近傍をクリックすると、3点クリック不要で円の中心、直径（`⌀ 〇〇mm`）、半径（`R 〇〇mm`）をワンクリックで自動計測。
- **永続ピン留め（Keep）**:
  - 計測結果をピン留め（Keep）する際、円の場合は `⌀ 〇〇mm` の直径ラベルとしてモデル上に永続配置・保存。

### 2.12 Ctrl+Z / Cmd+Z によるUndo / Redo履歴管理
- **テキストエリアの入力Undo / Redo**:
  - macOS環境の `Cmd+Z` / `Cmd+Shift+Z` だけでなく、Windows準拠の `Ctrl+Z` / `Ctrl+Y` にも完全対応。
  - `TextHistory` スタックにより、タイピング途中の取り消し（Undo）ややり直し（Redo）がスムーズに動作。
- **注記削除の復元Undo**:
  - 通常表示時やフォーカス時に `Ctrl+Z` / `Cmd+Z` を押すことで、直前に誤って削除した注記を即座に元の位置・設定のまま完全復元。

### 2.13 データの保存先
注記・寸法・設定は次の2か所に保存される。

| 保存先 | 内容 | 書き込みの契機 |
| :--- | :--- | :--- |
| ノート内の ```step / ```cad コードブロック（YAML） | 埋め込みごとの `width` / `height`、`locked`、`camera`、`section`、`annotations` | 固定（🔒 / 🔓）ボタンの操作時、枠ドラッグによるリサイズ完了時、注記の変更時（下記の自動保存） |
| プラグインの `data.json` | 設定（`profile` / `tiers` / `cacheEnabled` / `cacheMaxMB` / `healFaces`）、CADファイルのパスをキーにした `annotations`（注記）と `measurements`（ピン留め寸法） | 設定変更時、注記・寸法の変更から約0.4秒後 |

- **注記の読み込み元**: コードブロックに `annotations` がある埋め込みはコードブロックの注記を表示し、無い場合は `data.json` の注記を読み込む。ピン留め寸法は常に `data.json` から読み込む。
- **注記の相互変換**: コードブロックの注記（`AnnotationConfig`）とビューアの注記（`StoredAnnotation`）は `annotationConfigToStored` / `storedAnnotationToConfig`（`StepCodeBlockUtils.ts`）で変換し、文字色（`textColor`）・文字サイズ（`fontSize`）・引出線・リンクを含む全項目を引き継ぐ。`hoverOnly` はコードブロックへ保存しない。
- **設定の保存**: `data.json` は設定と注記・寸法が同居するため、設定の読み込みは設定のキーだけを取り出し（`pickStoredSettings`）、保存は最新の `data.json` を読み直して設定のキーだけを書き戻す（`writeSettingsToPluginData`、`updatePluginData` の直列化キュー経由）。設定を変更しても注記・寸法は上書きされない。
- **注記の自動保存（コードブロックへの反映）**: コードブロックが注記の保存先になっている埋め込み（ロック中、またはコードブロックに `annotations` がある）では、注記を追加・編集・移動・削除・色変更するたびに、現在の視点・断面・ロック状態・注記をコードブロックへ自動保存する（`annotationAutoSave.ts`）。
  - 対象外: 固定も注記の保存もしていない埋め込み（コードブロックを書き換えず、従来どおり `data.json` のみに保存）、CADファイルを直接開いたビュー。
  - 最後の変更から 0.6 秒後に1回だけ保存する（連続した変更はまとめる）。
  - 注記のテキスト編集中（編集ボックス展開中）は保存を保留し、編集を終えてから保存する。コードブロックを書き換えると埋め込みが再描画されるため、入力中の編集ボックスを閉じないようにしている。
  - ビューアの破棄時（ノートを閉じる、スクロールで画面外へ出る等）に保留中の変更があれば、その場で保存する。
  - 固定ボタンの操作時は、固定ボタンの保存に注記も含まれるため、保留中の自動保存を取り消す。
  - 保存のたびに埋め込みは再描画される（固定ボタンやリサイズの保存と同じ動作）。
- **保存時に引き継ぐ設定**: ビューアが作る設定（視点・断面・注記）に含まれない `width` / `height` / `quality` は、保存時に現在のコードブロックの値を引き継ぐ（`carryOverEmbedSettings`）。

## 3. ソース構成
`.obsidian/plugins/cad-viewer/src/` 配下。ビルド成果物は `main.js`（`npm run build` で生成）。

| ファイル | 役割 |
| :--- | :--- |
| `main.ts` | プラグインのエントリーポイント。ビュー・コードブロック（`step` / `cad`）・ドロップ連携・設定タブの登録 |
| `settings.ts` | 設定の定義と `data.json` との読み書き |
| `dropHandler.ts` | CADファイルのドロップ判定とコードブロック文字列の生成 |
| `embed/StepEmbed.ts` | コードブロック埋め込みの描画、枠ドラッグリサイズ、コードブロックへの保存 |
| `embed/StepCodeBlockUtils.ts` | コードブロックYAMLの解析・生成・本文置換、注記の相互変換、保存時の設定の引き継ぎ |
| `embed/annotationAutoSave.ts` | 注記の変更をコードブロックへ自動保存する制御（対象判定、まとめ書き、編集中の保留） |
| `view/StepView.ts` | CADファイルを直接開いたときの全画面ビュー |
| `viewer/mountViewer.ts` | ビューアのDOM構築と、ツールバー・注記・寸法・ツリーの組み立て |
| `viewer/ViewerController.ts` | Three.js のシーン・カメラ・選択・断面・計測・ロックの制御 |
| `viewer/PseudoSolidSection.ts` / `viewer/SectionCaps.ts` | 断面キャップと擬似ソリッドのハッチング |
| `viewer/edgeMeasurement.ts` | 直線エッジ・円形エッジのワンクリック寸法測定 |
| `viewer/OcctLoader.ts` / `viewer/occt.worker.ts` / `viewer/StepToThree.ts` | STEPの解析（occt-import-js、Web Worker）とThree.jsメッシュへの変換 |
| `viewer/FreeCadLoader.ts` / `viewer/MeshLoaders.ts` | FreeCAD（`.fcstd`）、OBJ、STLの読み込み |
| `viewer/GeometryCache.ts` / `viewer/params.ts` / `viewer/mobileGuard.ts` | 解析結果のキャッシュ、ファイルサイズに応じたメッシュ品質、モバイル向けのメモリ保護 |
| `viewer/HealFaces.ts` / `viewer/StepMeta.ts` / `viewer/fitCamera.ts` | 欠損面の補修、STEPメタデータの抽出、カメラの自動フィット |
| `ui/AnnotationLayer.ts` / `ui/AnnotationsPanel.ts` / `annotations/AnnotationStore.ts` / `annotations/annotationOptions.ts` | 注記の表示・編集・一覧・保存、文字色と文字サイズの選択肢 |
| `ui/MeasurementLayer.ts` / `annotations/MeasurementStore.ts` | ピン留め寸法の表示・削除・保存 |
| `ui/Toolbar.ts` / `ui/ViewCube.ts` / `ui/ViewControls.ts` / `ui/TreePanel.ts` / `ui/PartInfoPanel.ts` / `ui/LabelLayer.ts` / `ui/resizable.ts` | ツールバー、ViewCube、断面・分解コントロール、構造ツリー、パーツ情報、ラベル描画、パネルのリサイズ |
| `ui/textHistory.ts` | 注記テキストエリアのUndo / Redo履歴 |
| `annotations/pluginData.ts` | `data.json` への書き込みを直列化する共通処理 |

## 4. テスト
`.obsidian/plugins/cad-viewer` で `npm test`（`tsx --test "src/**/*.test.ts"`）を実行する。全50件。

| テストファイル | 件数 | 対象 |
| :--- | :--- | :--- |
| `src/embed/StepCodeBlockUtils.test.ts` | 17 | コードブロックの解析・生成・個別更新、注記の相互変換、保存時の設定の引き継ぎ |
| `src/embed/annotationAutoSave.test.ts` | 11 | 注記の自動保存の対象判定、まとめ書き、編集中の保留、破棄時の保存 |
| `src/ui/textHistory.test.ts` | 5 | Undo / Redo履歴 |
| `src/annotations/annotationOptions.test.ts` | 4 | 文字サイズ・文字色の選択肢 |
| `src/settings.test.ts` | 4 | 設定と `data.json` の読み書き |
| `src/viewer/edgeMeasurement.test.ts` | 4 | 直線・円の寸法測定 |
| `src/dropHandler.test.ts` | 3 | ドロップ判定とコードブロック生成 |
| `src/viewer/PseudoSolidSection.test.ts` | 2 | 断面キャップの生成 |

描画・操作（`ViewerController`、各UI）は自動テストの対象外で、Obsidian上での動作確認が必要。
