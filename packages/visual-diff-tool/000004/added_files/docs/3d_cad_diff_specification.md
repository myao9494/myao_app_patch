# 3D CAD差分（STEP比較）技術仕様書

## 1. 概要
本機能は、CADデータ（STEP形式）の2つのバージョンを3D空間上で視覚的に比較する機能である。
単品部品（ソリッド）を中心に、新旧形状の幾何学的差異を高速かつ正確に検出し、ブラウザ上のThree.jsキャンバスに表示する。
完全オフライン環境で動作し、外部ネットワークへのリクエストやCDN依存は一切存在しない。

- **差分表示イメージ**:
  - 変更なし箇所: グレー（`#94a3b8`）
  - 旧版のみ（削除）: 赤（`#ef4444`）
  - 新版のみ（追加）: 緑（`#22c55e`）
- **表示モード**:
  - **重ね表示 (Overlay)**: 新版をベースに、旧版の削除部分を重ねて配置。変更なし部分はフラグメントシェーダーで discard することで Z-fighting（重なりのチラつき）を解消。
  - **左右並べ表示 (Side-by-Side)**: 左に旧版、右に新版を並べ、OrbitControls の視点移動・回転・ズームを左右画面で完全に双方向同期。

## 2. 処理パイプラインとアーキテクチャ
図面: [three_diff_pipeline.excalidraw](file:///Users/mine/000_work/app/visual-diff-tool/docs/three_diff_pipeline.excalidraw)

```
[UI: React / Three.js] 
       │ 1. STEP A/B アップロード (またはプリセット選択)
       ▼
[FastAPI: POST /api/3d/jobs] 
       │ 2. 202 Accepted (job_id 即時返却)
       ▼
[子プロセス: multiprocessing.Process]
       │ 3. OCP による STEP 読込 & mm 換算 & 単位検出 (mm/inch/m)
       │ 4. 新旧最大バウンディングボックスから共通線形許容差を決定しメッシュ化
       │ 5. 元STEPファイルを即時削除 (ストレージ削減 & 機密保持)
       │ 6. 自動位置合わせ (元座標判定 → 面積重心＋慣性主軸24候補 → トリム付きICP)
       │ 7. メッシュ細分化 & 相手面への最近傍最短距離 (diffDistance) 計算
       │ 8. VDM1 バイナリ出力 & status.json 更新 (完了)
       ▼
[UI: ポーリング完了検知 & VDM1 取得]
       │ 9. Float32Array 展開 & BufferGeometry 構築
       │ 10. カスタムシェーダーでリアルタイム色分け (60fps)
```

## 3. 主要ロジック

### 3.1 STEP→メッシュ変換 (`backend/app/step_mesh.py`)
- **ライブラリ選定**: `cadquery-ocp-novtk`（OpenCASCADE Technology 7.8〜8.0 バインディング）。
  - VTK や CasADi（LGPL-3.0）等の巨大依存を含まない novtk 版を採用。
  - 同梱される OpenCASCADE 本体は LGPL-2.1（追加例外条項付き）。
- **共通精度テッセレーション**:
  新旧2つのモデルでテッセレーション精度が異なると、同一形状であっても離散化誤差による擬似差分が発生する。
  そのため、新旧双方のバウンディングボックス対角長 `max(diag_old, diag_new)` から線形許容差 `linear_deflection` を1つ算出し、新旧両モデルの `BRepMesh_IncrementalMesh` に同一値を適用する。
- **単位検出と正規化**:
  STEPヘッダーの `SI_UNIT` および `CONVERSION_BASED_UNIT` から元の長さ単位（mm, inch, m 等）を検出。
  OCCTの `xstep.cascade.unit = "MM"` 設定により内部形状はすべて mm に統一換算され、新旧で単位が異なる場合は警告を発行する。

### 3.2 位置合わせ (`backend/app/mesh_diff.py`)
1. **元座標優先評価**:
   CADモデルの版違いは同一座標系で設計されるケースが多い。元座標での双方向一致率（相手面までの距離が許容誤差以下のサンプルの割合）が 60% 以上であれば、恒等変換（動かさない）を採用する。これにより、ボスを追加しただけで重心が動き、全体が意図せずズレてしまう事故を防止する。
2. **粗合わせ（面積重心＋慣性主軸）**:
   水密でないメッシュにも対応するため、三角形の面積重み付け重心を計算。さらに分散共分散行列の固有ベクトルから慣性主軸を算出。主軸の符号・順序の曖昧性（24通りの回転群）を全探索し、粗い距離評価で最良姿勢を選択。
3. **トリム付きICP (Trimmed ICP)**:
   最近傍点の距離上位 15%（変更箇所・追加形状）を除外して最小二乗剛体変換（Kabschアルゴリズム）を反復適用。形状変更部分に引っ張られずに共通形状部分で精密に密着させる。

### 3.3 相手面最短距離の算出とVDM1バイナリ
- **距離計算**: `trimesh.proximity.closest_point`（R木空間インデックス利用）により、各頂点から相手メッシュ三角形表面までの幾何学的最短距離を算出。
- **VDM1バイナリフォーマット**:
  - `0..3` : マジック `VDM1` (ASCII)
  - `4..7` : JSONヘッダ長 `json_len` (UInt32 LE)
  - `8..8+json_len` : メタデータJSON (UTF-8, 頂点数・面数・単位など)
  - パディング (4バイト境界アラインメント)
  - `positions` : Float32Array (`vertex_count * 3 * 4` バイト)
  - `indices` : Uint32Array (`face_count * 3 * 4` バイト)
  - `distances` : Float32Array (`vertex_count * 4` バイト)

### 3.4 リアルタイム色分けシェーダー (`frontend/src/three-diff/materials.js`)
- `MeshStandardMaterial` の `onBeforeCompile` を拡張。
- 頂点シェーダーで `diffDistance` 属性を Varying `vDiffDistance` へ転送。
- **サブピクセル・アンチエイリアシング (`fwidth` & `smoothstep`)**:
  従来のハードな二値ステップ関数（`>`）から、スクリーン空間ピクセル変化量 `fwidth` を用いた `smoothstep` 補間へ刷新。差分の輪郭エッジがピクセル単位で滑らかにアンチエイリアスされ、ノコギリ状のジャギーを抑制。
- スライダー操作時は `material.userData.uniforms.uThreshold.value = newThreshold` を更新するのみで、GPUへのバッファ転送なしに即座に表示が切り替わる。

### 3.5 高品質CADレンダリング（STEP-viewer準拠）
CADモデル特有の平面の美しさとシャープな稜線を忠実に再現するため、以下のレンダリング最適化を適用。
- **法線の折り目分離 (`toCreasedNormals`, 30°)**:
  単純な頂点法線平均（`computeVertexNormals`）では、平面と側面が交差する直角エッジ近傍で法線が45度傾き、平面上に三角形分割の対角線に沿ったガタガタ・ウネウネの陰影歪みが発生する。
  `toCreasedNormals(geometry, 30°)` により、30度以上の折り目（ハードエッジ）で法線を直交分離。平面部分は完全に均一なフラットシェーディングとなり、円筒面・曲面は滑らかなスムースシェーディングを維持する。
- **CAD輪郭線・エッジ描画 (`THREE.EdgesGeometry`, 30°)**:
  `THREE.EdgesGeometry` により、30度以上の鋭角エッジを `LineSegments`（カラー `#1e293b`）としてオーバーレイ描画。CAD図面のようなシャープで精密な外観を実現し、UIツールバーからワンクリックでON/OFF切り替え可能。
- **差分境界の高解像度細分化 (`refine_mesh`)**:
  メッシュ細分化の目標辺長 `target_max_edge` を品質設定（quality）に連動させ、従来の対角長5%から **1.5%（`standard`: 0.015, `fine`: 0.008）** へ高解像度化。ボスの接合面や穴周囲のサンプリング解像度が3倍〜6倍きめ細かくなり、差分領域のカクカクした多角形化を解消して真円に近い滑らかな輪郭を実現。
- **マット質感とCADマルチライティング**:
  粗さ（roughness）を0.65、金属度（metalness）を0.08に設定してテカリを抑え、環境光（0.85）＋主光（1.05）＋補助光（0.45）＋正面フィルライト（0.35）の4灯構成で影の黒潰れやチラつきを防止。背景色を落ち着いたスレートダーク（`#0f172a`）に統一。
- **テッセレーション角度精度の向上**:
  `DEFAULT_ANGULAR_DEFLECTION` を 0.35rad（約20°）から 0.26rad（約15°）へ精密化し、穴やボスの円弧を滑らかに分割。
- **DOM保護と仮想DOM分離（`removeChild` エラー完全防止）**:
  Three.js の `WebGLRenderer.domElement` は専用の独立したコンテナ要素（`.three-canvas-host`）にマウント。React が管理するラベル要素やアノテーション・SVG計測層（`MeasureAnnotationLayer`）と同じ親要素に対して `innerHTML = ""` や直接 `appendChild` を行わない設計に隔離。ビューモード切り替えやコンポーネント破棄時に React の仮想DOMツリー（reconciliation）が不整合を起こして `Failed to execute 'removeChild' on 'Node'` でクラッシュする問題を根本から解消。

### 3.6 3Dスマート寸法測定および注記・メモ機能（STEP-viewer準拠）
構成図: [three_diff_section_and_smart_dimension.excalidraw](file:///Users/mine/000_work/app/visual-diff-tool/docs/three_diff_section_and_smart_dimension.excalidraw)

CADモデル上の幾何寸法計測および差分箇所のレビュー記録を直感的に行うため、以下の機能を実装。
- **頂点スナップ (Snap to Vertex)**:
  Raycasterで交差した面の三角形頂点群から、交差点に最も近い頂点座標を自動探索・吸着（`findNearestVertex`）。CADモデルの正確なコーナー（角）や穴端点をブレなく指定可能。ホバー時には緑色の二重丸マーカーでスナップ位置をフィードバック。
- **スマート自動認識＆手動切替ピル (Smart Dimension)**:
  - **穴径 ($\phi$) / 半径 ($R$)**: 3点円弧指定時、空間3点の平面外接円（`fitCircleFrom3Points`）から中心・半径・直径を自動算出。
  - **面取り ($C$)**: 45度傾斜面・斜め2点指定時、面取り寸法（$C$）を自動認識。
  - **直線距離**: 2点指定時、直線距離 $L$ [mm] および各軸成分（$dX, dY, dZ$ [mm]）を算出。
  - **手動切替ピル**: 寸法バッジをクリックすることで、`φ` / `R` / `直線` / `C` の手動切替ピルを展開し、ワンクリックで任意の幾何タイプへ切り替え可能。
- **ドラッグ位置調整と引き出し線 (Leader Line)**:
  - 寸法バッジをマウスでドラッグして任意の画面位置へ自由にレイアウト可能。
  - 計測対象の中心点からバッジの現在位置へ、破線の引き出し線（Leader Line）がリアルタイムに追従描画され、密集箇所でも数値が重ならず見やすく整理できる。
- **3D注記メモ (Annotation)**:
  - モデル表面をクリックして注記ピンを打設。ピンから引出線（Leader line）が伸びるメモカードを配置。
  - メモカードヘッダーのドラッグ移動に対応し、引き出し線が自動追従。
  - テキスト入力、4色のカテゴリカラー分類（青: 通常メモ、緑: 変更/追加確認、黄: 要確認/課題、赤: 削除/不具合）、最小化（ピンのみ表示 ↔ カード展開）に対応。
- **スクリーン射影オーバーレイ方式**:
  `Vector3.project(camera)` により3D座標を毎フレーム画面座標に射影変換し、HTML/SVGオーバーレイ層（`MeasureAnnotationLayer.jsx`）で描画。
  - テキストが常にシャープで読みやすく、視点回転時に文字が裏返る・歪むことがない。
  - テキスト入力（textarea）やボタン操作がネイティブのReactイベントとして軽快に動作。
  - 重ね表示（Overlay）および左右並べ表示（Side-by-Side）の両方において、新旧両モデルの同一3D位置に完全同期して描画。

### 3.7 CAD中実ハッチング断面表示 (Solid Section Plane)
CADレビューにおいて、内部構造や肉厚、穴の内部の差分を正確に目視確認するため、中実断面表示機能を実装。
- **擬似中実断面 (Stencil Buffer Cap)**:
  - 通常のクリッピング平面のみでは、モデルの内部が「空洞の薄皮（シェル）」に見えてしまい、ソリッドの肉厚や充填状態が認識しづらい。
  - Three.js の Stencil Buffer（`stencil: true`）を活用し、以下の3パス構成で切断面を動的に塞ぐ中実キャップ平面を生成：
    1. **裏面パス (BackSide)**: `depthTest: false`, `IncrementWrapStencilOp` により、クリッピング奥の裏面ピクセル数をカウントアップ。
    2. **表面パス (FrontSide)**: `depthTest: false`, `DecrementWrapStencilOp` により、クリッピング奥の表面ピクセル数をカウントダウン。
    3. **キャップ描画パス**: モデル中心を切断面へ垂直射影した位置にキャップ平面（`PlaneGeometry`）を配置し、`NotEqualStencilFunc`（ステンシル値 $\neq 0$、即ちソリッドの内部領域のみ）で描画。
  - 外部ライブラリ（CSG等）による高負荷なメッシュ再計算を一切行わず、GPUハードウェアバッファ上で60fpsで滑らかに動作。
- **CAD標準45度斜線ハッチング**:
  - `createHatchTexture()` により、64x64 Canvas 上に45度傾斜ストライプ（背景 `#1e293b`、線色 `#64748b`）を完全オフラインで動的描画し、`RepeatWrapping` のテクスチャとしてキャップ面に適用。
  - 日本のJIS/機械製図規格に準拠した自然な断面ハッチング表現を実現。
- **断面コントロールUI**:
  - **切断軸切替**: X軸 / Y軸 / Z軸をワンクリックで切替。
  - **位置スライダー**: モデルのバウンディングボックス範囲に応じた位置（0.5mm刻み）のリアルタイム連続スライド。
  - **切断方向反転 (Flip)**: クリッピング法線を反転させ、手前側と奥側の表示を瞬時に切り替え。
  - 左右並べ表示（Side-by-Side）においても左右両方のシーンに同一切断面・ハッチングキャップを完全同期適用。

### 3.8 マルチコア並列計算・高速化アーキテクチャ (`backend/app/mesh_diff.py`, `backend/app/step_mesh.py`)
図面: [three_diff_parallel_acceleration.excalidraw](file:///Users/mine/000_work/app/visual-diff-tool/docs/three_diff_parallel_acceleration.excalidraw)

Windows等における高解像度CADメッシュ差分計算（数万〜数十万頂点×数十万面）の処理時間を劇的に短縮するため、パイプラインの各段階で並列計算を導入：
1. **新旧STEP並行読み込み・並行テッセレーション**:
   - `load_step_pair_as_meshes` 内で、新旧STEPファイルの読み込み（`_read_step`）およびOpenCASCADEテッセレーション（`_tessellate`）を `ThreadPoolExecutor(max_workers=2)` で並行実行。
   - `Interface_Static.SetCVal_s("xstep.cascade.unit", "MM")` は事前設定し、独立した `STEPControl_Reader` と `TopoDS_Shape` をスレッドごとに処理。
2. **新旧メッシュ細分化（`refine_mesh`）の並行実行**:
   - `compute_mesh_diff` において、旧メッシュおよび新メッシュの三角形分割・細分化を2スレッドで同時実行。
3. **頂点チャンク分割マルチコア距離計算 (`parallel_closest_point`)**:
   - 相手メッシュ表面への最短距離・最近傍点計算（`trimesh.proximity.closest_point`）において、クエリ頂点群を CPU コア数（最大8コア）に応じて均等なブロック（チャンク）に分割し、`ThreadPoolExecutor` で並列実行。
   - 計算完了後に結果配列を元の順序通りにスタック結合（`np.vstack` / `np.concatenate`）。
4. **新旧メッシュ距離計算の同時実行**:
   - 旧メッシュ頂点から新メッシュへの距離計算と、新メッシュ頂点から旧メッシュへの距離計算を `ThreadPoolExecutor(max_workers=2)` で同時に発火。
5. **C++拡張ライブラリ（libspatialindex）スレッドセーフ保護**:
   - `trimesh.proximity.closest_point` は内部で `rtree.Rtree`（`libspatialindex` の C/C++ バインディング）を使用し、初回クエリ時に空間インデックスのネイティブポインタをメッシュオブジェクトにキャッシュする。
   - 同一のメッシュインスタンスを複数スレッドから同時に参照してクエリを実行すると、C++内部のインデックスハンドル競合によりポインタが不正解放（SIGABRT: `malloc: pointer being freed was not allocated`）されクラッシュする。
   - これを完全に防止するため、ワーカーごとに独立した軽量メッシュインスタンス（`mesh_copies = [trimesh.Trimesh(mesh.vertices, mesh.faces, process=False) for ...]`）を割り当ててクエリを実行。スレッド間競合をゼロにし、安定したマルチスレッド高速化を実現。

### 3.7 Git 3D差分連携（HEAD vs 作業ツリーの3D比較）
アーキテクチャ図: [git_3d_diff_pipeline.excalidraw](file:///Users/mine/000_work/app/visual-diff-tool/docs/git_3d_diff_pipeline.excalidraw)

Git管理下にある 3D CADファイル（`.step`, `.stp`）のバージョン差分を、2D画像やテキストと同様にシームレスに差分比較可能とする統合機能。
- **自動検出**:
  `POST /api/git/files` において、拡張子が `.step` または `.stp` の変更ファイルを `kind: "3d"` として列挙。
  Gitドロップダウンおよびファイル送りにおいて `[通し番号]. [パス] / 3D CAD` として表示。
- **HEADバイナリ抽出とジョブ投入 (`POST /api/git/3d/jobs`)**:
  旧版バイナリは `git show HEAD:<head_path>` により抽出し、新版バイナリはローカル作業ツリーの実ファイルから読み取り。
  既存の `mesh_job_manager.create_job` パイプラインへ投入し、非同期で子プロセス差分計算を開始（202 Accepted）。
- **シームレスなUI表示 (`ThreeDiffViewer`)**:
  Git差分タブ上で `ThreeDiffViewer`（`gitMode={true}`）が起動。
  ツールバーに `Git 3D: HEAD:<head_path> ↔ <path>` バッジを表示。
  メッシュ精度設定、位置合わせモード、重ね表示／左右並べ表示、リアルタイムしきい値スライダー、スマート寸法（φ/R/直線/C）、注記メモ、中実ハッチング断面表示などの全3D機能が完全に利用可能。
- **Git新規追加・削除時の単体3Dモデルプレビュー (`single_mode`)**:
  - 新規追加ファイル（HEADに履歴がない `has_head=False`, 未追跡 `??` や追加 `A`）または削除ファイル（作業ツリーにない `has_current=False`）の場合、`POST /api/git/3d/jobs` は単体プレビュー用ジョブを発行。
  - バックエンド（`step_mesh.load_step_single_as_mesh`）で片側のSTEPバイナリのみをOCPでメッシュ化し、距離データ（`distances`）をゼロ埋めした単一VDM1（`new_mesh.vdm1` または `old_mesh.vdm1`）を生成。
  - フロントエンド（`ThreeDiffViewer`）は `status.single_mode`（`"new"` または `"old"`）を検出し、片側のメッシュのみを取得・展開してシーンを初期化。
  - UIヘッダーに「Git 3D 新規: 新規追加 (<path>)」バッジを表示し、表示モードを新版プレビューに固定した上で、回転・ズーム・ワイヤーフレーム・寸法測定・注記・中実ハッチング断面などの全CAD機能を完全提供。

## 4. APIエンドポイント仕様
| メソッド | パス | 説明 |
|---|---|---|
| `GET` | `/api/3d/status` | 3D依存ライブラリのインストール状況と導入コマンド例 |
| `GET` | `/api/3d/samples` | 検証用STEPサンプルペア一覧 |
| `POST` | `/api/3d/samples/load` | サンプルペアの差分ジョブ作成 (202 Accepted) |
| `POST` | `/api/3d/jobs` | STEP新旧アップロード差分ジョブ作成 (202 Accepted) |
| `POST` | `/api/git/3d/jobs` | Git管理下の変更STEPファイル比較（HEAD vs 作業ツリー）差分ジョブ作成 (202 Accepted) |
| `GET` | `/api/3d/jobs/{job_id}` | ジョブ状態、進捗率、警告、統計情報 |
| `GET` | `/api/3d/jobs/{job_id}/mesh/{side}` | 位置合わせ済みVDM1バイナリ (`side`: old / new) |
| `DELETE` | `/api/3d/jobs/{job_id}` | ジョブファイルおよびキャッシュの即時破棄 |

## 5. ライセンス確認結果
- `cadquery-ocp-novtk`: Apache-2.0（同梱 OpenCASCADE 本体: **LGPL-2.1 with Exception**）
- `trimesh`: MIT
- `rtree`: MIT（同梱 libspatialindex: MIT）
- `scipy`: BSD-3-Clause
- `three`: MIT
- **留意事項**: 官公庁案件・商用配布時において、動的リンクでの利用であるためアプリ本体のソース開示義務は生じないが、OpenCASCADEのLGPL-2.1ライセンス文の添付およびソースコード入手先の明記が必要。GPLやAGPL等の感染性ライセンスは含まれない。

## 6. 実機STEPデータによるWeb画面検証実績
実務データであるロードセル/圧力センサーのSTEPファイルを用い、Web画面上で同一データ比較の完全一致検証を実施。
- **対象ファイル**: `/Users/mine/000_work/obsidian-dagnetz/01_data/2026/10/06/CBES (50kg to 2000kg).step` (853 KB)
- **ジオメトリ諸元**:
  - ソリッド数: 1（単品部品）
  - 単位: `mm`（STEPヘッダー SI_UNIT 由来）
  - 頂点数: 15,021、三角面数: 29,255
  - テッセレーション精度 (線形許容差): 0.1261 mm
  - 警告: 微小面/退化面 17面のエラーを安全にスキップ（全体形状の破損なし）
- **位置合わせ・差分判定**:
  - 位置合わせ方式: `identity`（恒等変換、回転 0.0°、移動 0.0 mm）
  - RMS 誤差: `5.05e-13 mm`
  - 旧/新 最大表面間距離: `7.15e-12 mm`
- **Web画面での表示結果**:
  - 差分割合: `+追加 0.0% (0 / 15021 頂点)`、`-削除 0.0% (0 / 15021 頂点)`
  - Three.js レンダリング: 赤（削除）や緑（追加）の差分色は一切発生せず、全面均一なグレー（一致）として正確に描画されることを確認。
- **Git新規追加（Untracked）実機検証実績**:
  - **対象ノート**: `/Users/mine/000_work/obsidian-dagnetz/01_data/2026/10/06/無題のファイル 1 2.md`
  - **参照STEP**: `01_data/2026/10/06/CBES (50kg to 2000kg).step`（Git未追跡の新規追加ファイル）
  - **検証結果**:
    - Git差分画面からノートを指定して読み込み、未追跡のSTEPファイルが「新版のみ（has_current=True, has_head=False）」として自動検出。
    - `POST /api/git/3d/jobs` により `single_mode: "new"` のジョブが発行され、約2秒でメッシュ化完了（18,534頂点, 35,989面）。
    - Web画面のThree.jsビューアー上でエラーなく単体CADモデルが描画され、「Git 3D 新規: 新規追加 (01_data/2026/10/06/CBES (50kg to 2000kg).step)」、モデル寸法 120.0×120.0×30.0 mm、全CAD機能（スマート寸法・注記・中実ハッチング断面等）が即座に利用可能であることを実証。

## 7. 検証用サンプルSTEPペア一覧
| ID | サンプル名称 | 旧版 (A) | 新版 (B) | 期待される検証結果 |
|---|---|---|---|---|
| `hole_position` | 穴位置変更 | 基本L字ブラケット (穴中心 x=28) | 穴位置移動 (穴中心 x=40) | 穴の移動に伴い、移動元が赤（削除）、移動先が緑（追加）で検出 |
| `dimension` | 寸法変更 | 基本L字ブラケット (幅 80mm) | 幅拡張 (幅 105mm) | 延長された先端面および側面が緑（追加）で検出 |
| `added_boss` | ボス追加 | 基本L字ブラケット | 天面に円柱ボス(φ16, h=15)追加 | 追加ボス部分が緑（追加）で検出。滑らかな円筒エッジ描画 |
| `moved_rotated` | 位置・向きズレ (同一形状) | 基本L字ブラケット | Z軸35°/X軸15°回転＋平行移動 | 自動位置合わせが100%成功し、**差分0.0%（全面グレー）** となる（同一モデルの姿勢差補正検証用） |
| `moved_rotated_diff` | 位置ズレ＋形状変更 | 基本L字ブラケット | 回転35°/15°補正＋**縦壁にφ12貫通穴追加** | 自動位置合わせ（回転38.0°/移動補正）が適用された上で、**縦壁の穴追加部分（緑）と旧版面（赤）が鮮やかに検出** |
| `unit_inch` | 単位不一致 (inch vs mm) | 基本L字ブラケット (mm) | インチ単位系STEP (寸法×1/25.4) | 単位不一致警告バナーが表示され、内部mm換算により幾何形状は一致（差分0.0%） |


