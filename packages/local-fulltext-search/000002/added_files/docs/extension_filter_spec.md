# インデックス対象拡張子の除外 & クリーンアップ技術仕様書

## 1. 目的
「検索ルール管理」画面の「インデックス対象拡張子」にてチェックを外した（除外した）拡張子（例: `.json`）のファイルが、全文検索インデックス作成（`IndexService`）およびベクトルインデックス同期（`VectorState` / `VectorIndexManager`）の走査・テキスト抽出・DB登録から完全にスキップされ、既存のインデックスデータからも即座にクリーンアップされることを保証する。

```
[検索ルール管理 UI]
       │
       ▼ (PUT /api/index/settings)
[index_selected_extensions.txt]
       │
  ┌────┴─────────────────────────────┐
  ▼                                  ▼
[IndexService (全文インデックス)]     [VectorState (ベクトルインデックス)]
 - ensure_fresh_target              - sync_index
   * types 未指定時フォールバック      * settings から自動ロード
   * グローバル交差フィルタ            * scan_files で除外判定
 - _cleanup_excluded_extension_files - delete_document で不要データ削除
   * files / file_segments 削除
   * failed_files 削除
   * targets.selected_extensions 同期
```

## 2. 背景・発生していた問題
1. **フォールバックの欠落**:
   - `ensure_fresh_target` にて `types` 引数が `None` または空文字 `""` で渡された場合（「インデックス取得」ボタン押下時やバックグラウンド更新時）、`_normalize_selected_extensions` 経由で `normalize_extension_filter` が呼ばれていた。
   - `normalize_extension_filter` は値が未指定の場合に `get_supported_extensions()`（全対応拡張子：`.md`, `.json`, `.txt`, `.pdf` 等すべて）を返していたため、ユーザー設定 `app_settings.index_selected_extensions` が完全に無視されていた。
2. **既存ターゲット設定の不整合**:
   - フォルダ登録時に `selected_extensions=""` で保存され、再インデックス時に空文字が `types` として渡されて全拡張子走査に陥っていた。
3. **ベクトルインデックス側の呼び出しミス**:
   - `VectorState.sync_index` にて `idx_svc = IndexService(settings)` と呼び出しており、コンストラクタの第1引数 `connection` に `settings` が渡されて例外が発生、`except Exception:` で捕捉されて `effective_selected` が `None` になり、ベクトル側も全拡張子を走査していた。
4. **除外拡張子の既存データ残留**:
   - 拡張子設定から除外された既存ファイル（既に登録済みの `.json` レコード等）が DB（FTS5 およびベクトルDB）からクリーンアップされず、検索結果に残り続けていた。

## 3. 実装仕様

### 3.1 全文インデックス走査時のフォールバック & フィルタリング (`IndexService.ensure_fresh_target`)
- `types` 引数が `None` または空文字の場合、`app_settings.index_selected_extensions` をフォールバックとして採用。
- `types` に値が渡されている場合でも、グローバル設定 `app_settings.index_selected_extensions` との積集合（交差フィルタリング）を取り、ユーザーがチェックを外した拡張子が紛れ込むのを完全に遮断。

```python
effective_types = types if types is not None and types.strip() else app_settings.index_selected_extensions
normalized_extensions = self._normalize_selected_extensions(
    effective_types,
    custom_content_extensions=app_settings.custom_content_extensions,
    custom_filename_extensions=app_settings.custom_filename_extensions,
)
allowed_global_extensions = set(self._parse_extension_entries(app_settings.index_selected_extensions))
if allowed_global_extensions:
    current_req_extensions = set(self._parse_extension_entries(normalized_extensions))
    filtered_extensions = current_req_extensions & allowed_global_extensions
    if filtered_extensions:
        normalized_extensions = "\n".join(sorted(filtered_extensions))
    else:
        normalized_extensions = "\n".join(sorted(allowed_global_extensions))
```

### 3.2 targets テーブルの selected_extensions 同期 (`IndexService._sync_local_target_selected_extensions`)
- 検索ルール管理で拡張子設定が更新された際、全ターゲットの `selected_extensions` を新設定と同期し、除外された拡張子を除去する。

### 3.3 除外拡張子ファイルの即時クリーンアップ (`IndexService._cleanup_excluded_extension_files`)
- 設定保存時（`PUT /api/index/settings`）に、新設定で除外された拡張子を持つファイルを検知。
- `file_segments` を先に明示的に DELETE して FTS5 の AFTER DELETE トリガーを発火させた後、`files` からレコードを削除。
- `failed_files` からも該当するエラー履歴を削除。
- ベクトルDBのドキュメントメタデータ（`existing_meta`）からも除外拡張子のドキュメントを即時削除。

### 3.4 ベクトルインデックス同期の確実な連動 (`VectorState.sync_index`)
- `IndexService` インスタンス化の修正および `settings.index_selected_extensions_path` からのフォールバック読み込みにより、アプリ設定の `index_selected_extensions` を確実に取得。
- `VectorIndexManager.scan_files` にて `self.selected_set` による厳格な拡張子照合を実施し、除外拡張子のファイルを走査対象からスキップ。

## 4. テスト検証
- **全文インデックス**:
  - `test_index_skips_extensions_excluded_in_app_settings`: `ensure_fresh_target` で除外拡張子がインデックスされないこと。
  - `test_reindex_search_targets_respects_app_settings_excluded_extensions`: `reindex_search_targets` で除外拡張子がインデックスされないこと。
  - `test_update_app_settings_cleans_up_newly_excluded_extension_files`: 設定更新時に既存の除外拡張子ファイルがクリーンアップされること。
- **ベクトルインデックス**:
  - `test_vector_state_sync_index_respects_app_settings_excluded_extensions`: `VectorState.sync_index` が設定の除外拡張子をスキップすること。
- 全338件のバックエンドテストおよび80件のフロントエンドテストがすべて通過。
