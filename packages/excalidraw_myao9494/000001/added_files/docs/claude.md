# Excalidraw PWA (myao9494) 仕様・変更履歴

## 概要
ExcalidrawをベースにしたPWAアプリケーション。

## Service Worker仕様

- **キャッシュ戦略**:
  - 静的アセット（JS, CSS, フォントなど）: キャッシュファースト
  - APIリクエストなど（`/api/`）: ネットワークファースト
  - HTMLなどのその他リソース: ネットワークファースト（フォールバックでキャッシュ）

- **制約**:
  - Cache API（`caches.put`など）はGETリクエストのみをサポートしています。
  - POST / PUT / DELETE 等のリクエストはキャッシュ対象外とし、Fetch APIのレスポンスをそのまま返却します。

## 変更履歴

- **2026/03/09**: 
  - `sw.js`: キャッシュ戦略を修正し、POSTリクエスト時に `caches.put` を実行しないように制限しました。
  - `index.html`: `<meta name="apple-mobile-web-app-capable" content="yes">` の非推奨警告（Deprecated warning）を解消するため、標準の `<meta name="mobile-web-app-capable" content="yes" />` を追加しました。

- **2026/06/03**:
  - `@excalidraw/excalidraw` を 0.18.1 にアップデートしました。
  - フロントエンド・バックエンドの依存ライブラリ（React, Vite, FastAPI, Pydantic, Uvicorn等）を新バージョンに更新し、ビルドおよびテストが正常に通ることを検証しました。

- **2026/08/28**:
  - Obsidian外に移動したフォルダ内の `.excalidraw.md` ファイルにおいて、画像リンク（`[[attachments/xxx.png]]` 等）が切れてしまう問題を解決しました。
  - バックエンドの画像解決処理（`resolve_embedded_file_path` / `parse_embedded_files_section`）を強化し、同一フォルダ直下およびサブフォルダ内の画像自動検出、URLデコード、拡張子補完、パイプ除去、Case-insensitive探索をサポートしました。

