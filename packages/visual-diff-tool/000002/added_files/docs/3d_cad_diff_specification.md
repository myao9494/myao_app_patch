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
- フラグメントシェーダーで `vDiffDistance > uThreshold` をピクセル単位で判定。
- スライダー操作時は `material.userData.uniforms.uThreshold.value = newThreshold` を更新するのみで、GPUへのバッファ転送なしに即座に表示が切り替わる。

## 4. APIエンドポイント仕様
| メソッド | パス | 説明 |
|---|---|---|
| `GET` | `/api/3d/status` | 3D依存ライブラリのインストール状況と導入コマンド例 |
| `GET` | `/api/3d/samples` | 検証用STEPサンプルペア一覧 |
| `POST` | `/api/3d/samples/load` | サンプルペアの差分ジョブ作成 (202 Accepted) |
| `POST` | `/api/3d/jobs` | STEP新旧アップロード差分ジョブ作成 (202 Accepted) |
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

