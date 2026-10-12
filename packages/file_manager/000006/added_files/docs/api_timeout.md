# APIリクエスト タイムアウト設定・フリーズ防止機能 仕様書

本ドキュメントは、ネットワークドライブが遅い環境におけるAPIリクエストおよびバックエンドのタイムアウト動作、ならびにハング防止（フリーズ回避）設計について説明します。

---

## 1. 概要
社内NASなどの遅延が大きいネットワーク共有フォルダにアクセスする際、以下の要因でシステム全体がフリーズするのを防ぎます。
1. **フロントエンドからの切断**: 応答がないリクエストを一定時間（デフォルト10秒）で強制的に打ち切り、トースト通知でユーザーへ知らせる。
2. **バックエンドのハング防止**:
   - `normalize_path` でのファイル実在チェック（`Path.resolve()`）はI/Oハングを引き起こすため、文字列計算のみの高速な判定に変更。
   - 主要なファイルI/Oアクセス（存在チェック、走査、開く、読み込み）をバックグラウンドスレッドで実行し、指定されたタイムアウト（秒）経過時に `504 Gateway Timeout` エラーとしてリクエストを打ち切る。

タイムアウト時間のデフォルトは **10秒** ですが、ハンバーガーメニューから任意の時間（1〜300秒）にカスタマイズし、バックエンドの設定ファイル（`backend/settings.local.json`）へ保存して動的に同期されます。

---

## 2. アーキテクチャと処理フロー

### 2.1. 設定の保存と流れ
タイムアウト設定値は、バックエンドの `settings.local.json` に保存され、起動時にフロントエンドが取得・適用します（読み込みは更新日時でキャッシュされます）。

```mermaid
sequenceDiagram
    participant FE as フロントエンド (React)
    participant BE as バックエンド (FastAPI)
    participant File as settings.local.json

    %% 起動時
    Note over FE, File: 【アプリ起動時】
    FE->>BE: GET /api/config
    BE->>File: 読み込み (apiTimeout)
    File-->>BE: 設定データ
    BE-->>FE: レスポンス (apiTimeout: 10)
    Note over FE: グローバルな fetch に<br/>タイムアウト値を適用

    %% 設定変更時
    Note over FE, File: 【ハンバーガーメニューでタイムアウト時間を変更】
    FE->>BE: POST /api/config/preferences (apiTimeout: 20)
    BE->>File: 保存書き込み (apiTimeout: 20)
    BE-->>FE: 成功レスポンス (apiTimeout: 20)
    Note over FE: 即座に変更後のタイムアウト値が<br/>次のAPI通信から適用される
```

### 2.2. バックエンド側のフリーズ・タイムアウト対策 (I/O制限)
ネットワークドライブの接続切断時、`Path.exists()` や `open()` などを直接呼び出すと、OSレベルのタイムアウト（数分間）が発生するまでスレッドがハングします。
これを回避するため、バックエンド側で以下の対策を講じています。

```mermaid
graph TD
    API[APIリクエスト受信] --> Norm[normalize_path]
    Norm -->|ファイルI/Oなし| Check{I/O操作の実行}
    Check -->|スレッドプールへ委譲| Thread[run_in_executor]
    Thread --> Wait[asyncio.wait_for]
    Wait -->|タイムアウト値超過| Err[504 Gateway Timeout を返却]
    Wait -->|時間内に完了| Success[通常レスポンスを返却]
```

- **I/Oフリーなパス正規化 (`normalize_path`)**:
  シンボリックリンク解決を行わず、文字列操作（`os.path.normpath`ベース）のみでパス正規化とパストラバーサル防止チェックを行うことで、パス解決時のI/Oハングを完全に防止します。
- **タイムアウト制限付き実行 (`run_with_timeout`)**:
  同期的なファイル操作処理をファイルAPI専用スレッドプールに委譲し、`asyncio.wait_for` を使って設定時間（`apiTimeout`）で監視・打ち切ります。ワーカー数は `FILE_MANAGER_FILE_IO_WORKERS`（既定16、4〜64に制限）で調整できます。
- **Server Terminalとの分離**:
  POSIXのPTY読み取りはイベントループのFD監視、Windowsのブロッキング読み取りは接続ごとの専用ワーカーを使用します。端末接続が残った場合でもファイルAPI用ワーカーを消費しません。
- **注意**:
  OS内で既に開始した同期I/OそのものはPythonから強制停止できません。タイムアウト時はHTTP応答を504で終了し、専用プールによって他機能への波及を限定します。

### 2.3. 対象の主要API
ファイルI/Oを伴うエンドポイントはすべてスレッドプールで実行され、NASが応答しなくてもイベントループ（他のAPIやターミナル）は止まりません。
そのうち以下の読み取り系APIが `run_with_timeout` によるタイムアウト保護（504）の対象です：
- `/api/files` (`get_files`): ファイル一覧取得・走査・実在確認
- `/api/path-info` (`get_path_info`): パス実在確認
- `/api/search` (`search_files`): Live検索の再帰走査
- `/api/count-files` (`count_files`): フォルダ内の再帰集計
- `/api/unzip` (`unzip_file`): ZIP検証・展開
- `/api/open/smart` (`open_smart`): パス実在確認およびファイル読み込み
- `/api/file-content` (`get_file_content`): ファイル実在確認およびテキスト読み込み
- `/api/open-path` (`open_path`): パス実在確認およびOSアプリ起動
- `/api/folder-latest-modified`, `/api/git-folder-statuses`: フォルダ走査・Git確認
- `/api/fullpath`: フォルダ判定・開き方の判定

### 2.4. タイムアウトさせないAPI（書き込み系）
次のAPIは、フロントエンド（`frontend/src/utils/fetchTimeout.ts` の `isTimeoutExempt`）・バックエンドの両方でタイムアウトを適用しません。
途中で通信だけ切ると、サーバー側では処理が続いているのに画面では「失敗」と表示され、再実行による二重操作などの原因になるためです。
大量の項目は非同期モード（進捗モーダル）で実行されます。

- `/api/upload`（アップロード）
- `/api/move`, `/api/move/batch`, `/api/copy/batch`（移動・コピー）
- `/api/delete`, `/api/delete/batch`（削除）
- `/api/update-file`（ファイル保存）
- `/api/unzip`（解凍。フロントエンド側のみ除外。バックエンドは apiTimeout で 504 を返す）

---

## 3. 設定UI (ハンバーガーメニュー)
ヘッダー右上のハンバーガーメニューを開き、**「Network Settings」** の下にある **「API Timeout (sec)」** に秒数を直接入力します。フォーカスを外すか値を変更した時点で、設定は自動的にバックエンドに保存されます。

---

## 4. タイムアウト発生時の挙動
APIリクエストが設定したタイムアウト時間に達すると、通信が強制的に中断され、フロントエンド上に以下のエラーメッセージがトーストとして通知されます。

> ⚠️ **エラー通知例**
> `リクエストがタイムアウトしました（設定値: 10秒）。ネットワークドライブが遅いか、サーバーが応答していません。`
> または
> `処理がタイムアウトしました（設定値: 10秒）。ネットワークが遅い可能性があります。`
