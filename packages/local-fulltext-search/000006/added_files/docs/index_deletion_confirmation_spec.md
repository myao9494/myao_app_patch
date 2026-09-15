# インデックス削除確認（削除通知）& フォルダ追加・拡張子変更時のインデックス保持仕様書

## 概要
検索対象フォルダの新規追加時や検索対象拡張子の変更時に既存のインデックスが勝手に削除されてしまう問題を解決し、不用意なデータ消失を防止する。
また、インデックスデータを削除する操作（拡張子除外時のクリーンアップ、フォルダインデックス削除、DB初期化等）の前にユーザーへ確認ダイアログを表示する「削除通知」設定を導入し、ハンバーガーメニュー（設定ドロワー）から有効/無効を切り替え・永続化可能とする。

---

## 主な仕様

### 1. 検索対象フォルダ追加時のインデックス保護 & 設定引き継ぎ
- **原因と改善**:
  - これまで `set_search_target_enabled` が未登録パスを `index_depth=1`, `selected_extensions=""` で新規ターゲットとして作成していたため、直後の走査で階層外の既存ファイルが削除対象になっていた。
  - `add_search_target` および `set_search_target_enabled` において、アプリのグローバル設定（`exclude_keywords`, `index_selected_extensions`）および指定された階層数（未指定時は上限なし `99999`）を確実に引き継ぐよう改修。
  - 新規フォルダを追加しても、既存フォルダのインデックス済みファイル群（`files`, `file_segments`）が一切削除されず安全に保持される。

### 2. 拡張子変更時のインデックス保持 & 選択的クリーンアップ
- **原因と改善**:
  - これまで「検索ルール管理」で拡張子を変更・保存する際、`update_app_settings` がサイレントに `_cleanup_excluded_extension_files` を実行し、DBから対象外ファイルを即時 DELETE していた。
  - `AppSettingsUpdateRequest` に `clean_excluded_files: bool = False` を追加し、API 呼び出し側から明示的に `clean_excluded_files: true` が指定された場合のみ削除を実行するように変更（既定値 `False` では削除しない）。
  - さらに `_cleanup_excluded_extension_files` のクエリに `WHERE source_type = 'local'` を追加し、Webページ等の別リソースが誤って巻き込まれて削除されるのを完全に防止。

### 3. ハンバーガーメニュー内の「削除通知」チェックボックス
- **設定項目**:
  - ハンバーガーメニュー（設定ドロワー）内の「データベースを初期化」パネル直前に「インデックス削除時に確認する（削除通知）」チェックボックスを設置。
  - 設定値: `confirm_index_deletion: bool`（既定値: `true` [ON]）。
  - 設定の永続化: `backend/data/confirm_index_deletion.txt` へ保存され、アプリ起動時や再読み込み時にも前回の状態を確実に復元。
- **動作フロー**:
  - **有効 (ON)**:
    - 検索ルール管理で拡張子のチェックを外して保存した際、除外された拡張子を検知。
    - `window.confirm` で確認ダイアログを表示:
      > 以下の拡張子がインデックス対象から外れました:
      > .json, ...
      > 
      > これら除外された拡張子の既存インデックスデータを削除しますか？
      > （「キャンセル」を選択した場合は既存インデックスを保持し、設定のみ更新します）
    - **「OK」**: `clean_excluded_files: true` で保存し、既存インデックスから除外拡張子ファイルをクリーンアップ。
    - **「キャンセル」**: `clean_excluded_files: false` で保存し、既存インデックスは保持したまま今後の走査設定のみ更新。
  - **無効 (OFF)**:
### 4. ベクトル差分インデックス更新時の削除確認 & 許可なき削除の完全抑止
- **背景**:
  - 会社の低スペックPC環境では、ベクトルインデックスの再構築に半日以上かかる。
  - 差分インデックス更新時に、走査から外れたファイル（ネットワークドライブの接続断、フォルダ移動等）がユーザー確認なくサイレントに削除されてしまうと業務に重大な支障をきたす。
- **改善仕様**:
  - **インデクサーの安全既定値**: `VectorIndexManager.index_all(clean_deleted_files: bool = False)` とし、明示指定がない限り既存レコードを一切削除しない（フェイルセーフ設計）。
  - **削除候補の事前算出エンドポイント**:
    - `POST /api/vector/index/pending-deletions` を新設。
    - 現在の走査結果とDBメタデータを照合し、走査責任範囲外となった削除候補ファイルパス一覧（`pending_deletions: list[str]`）を事前に算出。
  - **フロントエンド差分同期フロー (`VectorManagementPage.tsx`)**:
    - 差分同期（`handleStartIndex(false)`）開始時、`confirmIndexDeletion` が有効（既定 `true`）なら `fetchVectorPendingDeletions` を呼び出し。
    - 削除候補が存在する場合、ファイル名一覧（最大5件プレビュー + 合計件数）を含む確認ダイアログを表示:
      > 以下のファイルがインデックス対象から外れています:
      > • path/to/file1.md
      > • path/to/file2.md
      > ... (他 1 件)
      > 
      > これらのファイルのベクトルインデックスを削除しますか？
      > （「キャンセル」を選択した場合でも、新規・変更ファイルの更新は安全に続行されます）
    - **「OK」**: `clean_deleted_files: true` を送信し、走査対象外ファイルを削除して差分同期。
    - **「キャンセル」**: `clean_deleted_files: false` を送信し、削除処理のみスキップして新規・変更ファイルの学習・同期を安全に実行（インデックスデータを完全保持）。
    - 削除通知設定が OFF の場合: 確認ダイアログを出さず、勝手な削除も行わない（`clean_deleted_files: false`）。

---

## 変更ファイル一覧
- `backend/app/config.py`: `confirm_index_deletion_name` / `confirm_index_deletion_path`
- `backend/app/models/indexing.py`: `AppSettingsResponse.confirm_index_deletion`, `AppSettingsUpdateRequest.confirm_index_deletion`, `clean_excluded_files`
- `backend/app/services/index_service.py`: `_read_persisted_confirm_index_deletion`, `_write_persisted_confirm_index_deletion`, `set_search_target_enabled`, `add_search_target`, `update_app_settings`, `_cleanup_excluded_extension_files`
- `backend/app/api/index.py`: PUT `/api/index/settings` の受け渡し
- `backend/app/vector/indexer.py`: `get_pending_deletions()`, `index_all(clean_deleted_files=False)`
- `backend/app/vector/state.py`: `sync_index(clean_deleted_files=False)`, `get_pending_deletions()`
- `backend/app/api/vector.py`: `POST /api/vector/index/pending-deletions`, `IndexStartRequest.clean_deleted_files`
- `backend/tests/test_index_service.py`: フォルダ追加時インデックス保持、拡張子変更時クリーンアップ制御、削除通知設定テスト
- `backend/tests/test_index_api.py`: StubIndexService の引数対応
- `backend/tests/test_vector_indexer.py`: デフォルトで走査外ファイルを削除せず保持するテスト
- `backend/tests/test_vector_api.py`: pending-deletions API と clean_deleted_files 受け渡しのテスト
- `backend/tests/test_vector_exclude_keywords.py`: 除外キーワード時の clean_deleted_files 制御テスト
- `frontend/src/types.ts`: `AppSettings.confirm_index_deletion`, `VectorPendingDeletionsResponse`
- `frontend/src/api/client.ts`: `updateAppSettings`, `fetchVectorPendingDeletions`, `startVectorIndex(..., cleanDeletedFiles)`
- `frontend/src/App.tsx`: `confirmIndexDeletion` state, `handleChangeConfirmIndexDeletion`, ハンバーガーメニュー UI, `VectorManagementPage` への props 伝達
- `frontend/src/components/VectorManagementPage.tsx`: 差分同期前の削除確認ダイアログおよび `cleanDeletedFiles` 制御
- `frontend/src/appSettingsStructure.test.ts`: UI・クライアント・設定連携の自動テスト
- `frontend/src/vectorSearchUi.test.ts`: pending-deletions 照合と cleanDeletedFiles の自動テスト
