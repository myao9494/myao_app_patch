# デバッグガイド

## まず確認すること

| 症状 | 確認先 |
| --- | --- |
| 画面が開かない・古い画面のまま | ブラウザの DevTools → Application → Service Workers で `Update on reload`、または Unregister して再読み込み |
| 保存されない | 右上の通知（赤）、DevTools の Console（`File saved successfully` / `Error saving file`）、サーバーのログ |
| 「ファイルを読み込めませんでした」 | 通知に行・列と前後の行が出る。そのタブでは上書き防止のため保存しない。ファイルを直して開き直す |
| 外部更新が取り込まれない / 勝手に戻る | `/api/file-info` の `modified` と、保存レスポンスの `modified` を Network タブで比較する |
| 画像が表示されない（Obsidian） | サーバーのログの `Image file not found: ...`。探索順は [obsidian.md](obsidian.md#読み込み時) |
| 付箋のリンク・コマンドが動かない | サーバーのログの `[run-command] ...`、port 8001 の有無（[external_dependencies.md](external_dependencies.md)） |

## 開発サーバー

```bash
./start_dev.sh   # Vite(3001) + FastAPI(8008, --reload)
```

- フロントエンドは Vite の HMR で即時反映。React は StrictMode のため、開発時は effect が2回実行される
- バックエンドのログは `uvicorn` の出力（日時付き）。アプリのログは `excalidraw` ロガー

## 保存同期の流れを追う

保存・外部更新の処理は `hooks/useFileSync.ts` に集約されている（流れは [architecture.md](architecture.md#読み込みと保存hooksusefilesyncts)）。

- 自動保存は「最後に要素が変わってから」ではなく「最初の変更から」10 秒後。タブを非表示にすると即時保存
- 保存されないときは、内容の要約（`utils/sceneSummary.ts` の `buildElementSummary`）が保存済みと同じになっていないか確認する
- 外部更新は「更新日時が前回の読み込み・保存より新しいか」だけで判定する。
  ファイル同期ソフトなどが更新日時だけを変えた場合も外部更新として扱われる

## API を直接呼ぶ

```bash
curl "http://localhost:3001/api/file-info?filepath=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' /path/to/a.excalidraw)"
```

API の一覧は [api.md](api.md)。FastAPI の自動ドキュメントは `http://localhost:3001/docs`（開発時は 8008）。

## テスト

```bash
npm test              # フロントエンド（vitest）
npm run typecheck     # 型チェック
cd backend && .venv/bin/python -m pytest ../tests   # バックエンド（pytest。requirements-dev.txt が必要）
```

不具合を直すときは、先に再現テストを書いてから修正する。
保存同期は `hooks/useFileSync.test.ts`、Obsidian 形式は `tests/test_api_integration.py`（実ノートの往復）を参考にする。
