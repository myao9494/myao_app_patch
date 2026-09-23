<!--
ランチャー検索におけるインデックス作成待機抑止と更新チェック連動仕様書
Windows環境等でベクトルのインデックス作成がボトルネックとなるのを防ぎ、更新チェックOFF時は既存DB専用API (/api/search/indexed) で即座に検索し、更新チェックON時のみインデックス作成・更新を待って検索する仕様。
-->

# ランチャー検索における既存DB高速検索・更新チェック連動仕様書

## 1. 目的と背景
Windows 環境（特に CPU 推論環境）では、ベクトルの埋め込み計算（Embedding 生成）を含むインデックス作成処理に時間がかかります。
従来のランチャーでは、ハイブリッド検索が有効な場合に更新チェックが OFF であっても統合検索 API（`/api/search`）にリクエストが送信され、インデックス差分走査や更新待ちが発生してユーザー体験を損ねていました。
本仕様では、ランチャーからの検索においてインデックス作成を待たずに既存データベース（DB）だけで高速に検索できるようにし、「更新」チェックボックスが ON の場合のみ最新のインデックス作成・更新を待って検索するように動作を制御します。

## 2. 検索ルーティング仕様

| 条件 | エンドポイント | ペイロード主要フラグ | 動作 |
| :--- | :--- | :--- | :--- |
| **通常時（更新チェック OFF、gantt 未選択）** | `POST /api/search/indexed` | `search_type: "hybrid"` (または `vector`/`keyword`), `folder_path: ""` | インデックス作成・差分走査を一切行わず、既存の SQLite DB および既存ベクトルインデックスのみで即座に高速検索 |
| **「更新」チェック ON** | `POST /api/search` | `search_all_enabled: false`, `skip_refresh: false`, `search_type: "hybrid"` | 登録済み検索対象フォルダのインデックス作成・差分更新（ベクトルインデックス同期を含む）を完了させてから最新結果を検索 |
| **gantt チェック ON（更新チェック OFF）** | `POST /api/search` | `search_all_enabled: true`, `skip_refresh: true`, `include_gantt_tasks: true` | インデックス作成を行わず、既存 DB と gantt タスクを統合検索 |

## 3. コンポーネント別の変更内容

### 3.1 Windows WPF ランチャー (`launcher/windows/LocalSearchLauncher`)
- **`IndexedLauncherSearchRequest`**:
  - `SearchType`（既定値 `"hybrid"`）フィールドを追加し、既存インデックス専用 API に検索方式を伝達可能に拡張。
- **`LauncherSearchRequestBuilder.Build`**:
  - `updateIndexOnSearch == false && !includeGanttTasks` のとき、選択中の `searchType`（`hybrid` / `vector` / `keyword`）に関わらず `api/search/indexed` を使用。
  - `updateIndexOnSearch == true` のとき、`SearchAllEnabled: false`, `SkipRefresh: false` を設定した `LauncherSearchRequest` で `api/search` を呼び出し、バックエンドの再インデックスフローを起動。

### 3.2 Python ランチャー (`launcher/src/launcher_app`)
- **`LauncherApiClient.search`**:
  - macOS 以外のプラットフォーム（Windows / Linux）において、gantt 未選択時は `search_type` に関わらず既存インデックス専用 API `/api/search/indexed` を呼び出し、`search_type` を送信。

### 3.3 バックエンド (`backend/app/services/search_service.py`)
- **`SearchService.search`**:
  - フォルダ未指定かつ全 DB 検索 OFF の再インデックス判定に `and not params.skip_refresh` のガードを追加。
  - `skip_refresh: true` が指定されているリクエストでは、絶対に同期再インデックス処理（`_refresh_search_targets_for_search_without_path`）に入らないよう安全性を保証。

## 4. フロー図
詳細な処理フローは `docs/launcher_search_flow.excalidraw.md` を参照。
