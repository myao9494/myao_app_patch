# テストの実行方法と隔離の仕組み

## 実行方法

```bash
# バックエンド（backend/.venv を使用）
cd backend && .venv/bin/python -m pytest

# フロントエンド（テストと型検査）
cd frontend && npm test
cd frontend && npm run typecheck

# Python ランチャー
cd launcher && PYTHONPATH=src ../backend/.venv/bin/python -m pytest tests

# Windows WPF ランチャー（.NET 8 SDK が必要）
dotnet run --project launcher/windows/LocalSearchLauncher.Tests
```

バックエンドのテストは、どのファイルも単独で実行できる（`pytest tests/test_xxx.py`）。

## バックエンドのテストが実環境に触れない仕組み

バックエンドは稼働中に `backend/data/` の検索DB・設定ファイル・ベクトルDBを使う。
テストがここを読み書きすると、利用者の設定が書き換わったり、テスト結果が利用者の設定に左右されたりする。
これを防ぐため `backend/tests/conftest.py` が次のことを行う。

| fixture | 範囲 | 内容 |
|---|---|---|
| `isolate_app_data_for_tests` | 全テスト（自動適用） | `settings.data_dir` と `vector_state` のデータ保存先を、テストごとの一時フォルダ（`tmp_path/app_data`）へ差し替える。テスト終了時に元へ戻す |
| 同上 | 同上 | `backend.log` の出力先（`app.main.BACKEND_DIR`）を一時フォルダへ差し替える。起動処理（lifespan）を通すテストが実環境のログへ書き込んだり、ローテーションを起こしたりしないため |
| 同上 | 同上 | テスト終了前に、検索が起動したバックグラウンド処理（再インデックス、Obsidian 同期）の完了を待つ。隔離を解除したあとで実環境のDBへ接続させないため |
| `guard_real_data_dir` | セッション全体（自動適用） | 実環境の設定ファイル（`*.txt`、`config.json`）の更新時刻とサイズを開始時に記録し、終了時に変化していたらテストを失敗させる。実環境の `backend.log` が別ファイルへ置き換えられた（ローテーションされた）場合も失敗させる |

`guard_real_data_dir` が失敗した場合は、次のどちらかが起きている。

- 隔離を経由しない書き込みがある（モジュール読み込み時やモジュールスコープの fixture での書き込みなど）。
- テストの実行中に、稼働中のアプリの画面から設定を保存した。

### テストを書くときの注意

- DB が必要なテストは、`tmp_path` に SQLite を作って `initialize_schema` を呼び、その接続をサービスへ渡す。
- API をまるごと試すテストで DB が必要な場合は、`app.dependency_overrides[get_db_connection]` で差し替えるか、
  `get_connection()` で隔離済みの DB（`settings.database_path`）を開いて `initialize_schema` を呼ぶ。
- 実在チェックなど環境に依存する処理は、引数で差し替える（例: `dispatch_search(..., file_exists=lambda path: True)`）。
  本番コード側でクラス名や `mock` の有無を見て挙動を変えない。
- ベクトルモデルが必要なテストは `MockEmbedder`（または `vector_state.load_model(use_mock=True)`）を使う。
  モック用モデルの選択は `config.json` に保存されない。

## torch / faiss を使うテスト

torch と faiss はそれぞれ OpenMP ランタイムを同梱しており、macOS では両方を読み込むとプロセスが異常終了することがある。
`app` パッケージを import した時点で `app/runtime_env.py` が必要な環境変数（`KMP_DUPLICATE_LIB_OK` など）を設定するため、
テストでは torch や faiss を直接 import する前に `app.*` を import していれば問題ない。

## フロントエンドのテストと型検査

`npm run typecheck`（`tsc --noEmit`）で、ソースとテストの型を検査する。API のレスポンス項目名の取り違え（例: 一致バッジの `match_source`）のような不整合はここで検出できるため、フロントを変更したら必ず実行する。
未使用の変数・import もエラーになる（`noUnusedLocals`）。`node_modules` が古く `@types/node` が無い場合は `npm ci` で入れ直す。

`node --test` で `frontend/src/*.test.ts` を実行する。次の 3 種類がある。

- **純粋関数・API クライアントのテスト**: 入出力を確かめるもの（並び替え、拡張子フィルタ、一覧の絞り込み、設定値の正規化など）と、
  `fetch` を差し替えて API クライアントの送信内容を確かめるもの。
- **操作のテスト**（`*Interaction.test.ts`）: 画面を DOM（jsdom）へ描画し、クリックや入力のあとの表示と API 呼び出しを確かめるもの。
  画面の挙動は、原則としてこの形で検証する。
- **描画のテスト**（`*Render.test.ts`）: フックの戻り値を上書きした状態でコンポーネントを描画し、表示内容を確かめるもの。
  通信の途中など、操作では作りにくい状態の表示を確かめるときに使う。

ソースコードを文字列として読み、特定の記述が含まれるかを確かめるテスト（構造のテスト）は書かない。
画面の挙動を保証せず、関数名や書き方を変えるだけで失敗するため。

### 操作のテストの仕組み

`src/testing/dom.ts` が jsdom のウィンドウを用意し、React を実際に動かす。`useEffect`・状態の更新・通信まで実行される。
通信は `fetch` の代用品が受け、送られた要求を記録する。開発用の依存は `jsdom` だけで、ブラウザーは使わない。

```ts
test("無視ボタンは、フルパスを除外キーワードへ追記して保存し、結果一覧から外す", async () => {
  await withApp({ routes: { "POST /api/search": searchResponse([alpha]), "PUT /api/index/settings": echo } }, async (app) => {
    await app.runSearch("alpha");
    await click(findBySelector(card(app, "alpha.md"), "button.result-ignore-button"));

    assert.deepEqual(app.lastBody("PUT /api/index/settings"), { exclude_keywords: ".git\nnode_modules\n/docs/alpha.md" });
    assert.match(app.notice(), /無視リストへ追加しました/);
  });
});
```

| ファイル | 内容 |
|---|---|
| `testing/dom.ts` | DOM の準備（`installDom`）、`fetch` の代用品（`installFetchStub`）、描画（`mount`）、操作（`click`・`typeInto`・`selectOption`・`pressKey`・`doubleClick`・`rightClick`・`dragAndDrop`・`wait` など）、要素の検索（`findByText`・`findBySelector`） |
| `testing/apiFixtures.ts` | API の応答のひな形（設定・状態・検索結果）と、起動時の API へ既定の応答を返す `installAppApi` |
| `testing/appHarness.ts` | アプリ全体を開く `withApp`（ページの切り替え、検索の実行、通知・エラーの読み取りなど、よく使う操作つき） |

書くときの注意:

- 応答は「メソッド パス」ごとに登録する。関数を登録すると、送られた要求を見て応答を変えられる（保存した値をそのまま返す、など）。
  登録の無い経路への要求は 404 になる。
- 入力から少し遅れて動く処理（自動保存、作り直し）は、`wait(ミリ秒)` で進めてから確かめる。
- `window.confirm` / `alert` の文言は `app.dom.dialogs` に記録される。`setConfirmAnswer(false)` で「キャンセル」を再現できる。
- クリップボード（`clipboardWrites`、`denyClipboard()`）、`window.open`（`openedUrls`）、ダウンロード（`downloads`）、
  一覧の末尾への到達（`triggerIntersection()`）も記録・再現できる。
- **assert へ DOM の要素そのものを渡さない**。失敗時の差分表示が要素全体をたどり、テストが止まったように見えるほど遅くなる。
  有無は `hasElement()`、内容は `normalizeText(element.textContent)` で比べる。
- jsdom はレイアウトを計算しない。要素の大きさに依存する処理は `setElementSize()` で値を与える。
  スタイルは `withApp({ withStyles: true })` で `app.css` を読み込むと、`styleOf(要素, プロパティ)` で適用される値を確かめられる
  （`stylesInteraction.test.ts`）。位置・重なり・はみ出しは確かめられないので、ブラウザーで確認する。

### 描画のテストの仕組み

`src/testing/render.ts` が、Vite でソース（TSX）を読み込み、React のサーバー描画で HTML 文字列にする。

- 画面は「フックの戻り値」を受け取って表示するだけなので、テストでは実物のフックを呼び、検証したい状態を上書きして渡す。

  ```ts
  createElement(SchedulerPage, {
    onToggleMenu: noop,
    scheduler: { ...useScheduler({ pageView: "scheduler", ...messages }), schedulerPaths: ["/docs/a"] },
  });
  ```

- 検証できるのは**最初に表示される内容だけ**（`useEffect`、操作、通信は実行されない）。
- `window.location`・`localStorage`・`navigator` が必要な場合は `installBrowserStubs()` で代用品を用意する。
- 上書きする項目名は型検査で確かめられる（フックが返さない名前を書くと `npm run typecheck` が失敗する）。

状態から表示内容を決める計算（一覧の絞り込みなど）は、フックの中に書かずに純粋関数へ切り出し、その関数をテストする
（例: `indexedTargetFilter.ts`）。

## Python ランチャーのテスト

`launcher/tests/conftest.py` が、各テストの終了時に残っている `threading.Timer`（検索入力のデバウンス）を取り消す。
テスト終了後にタイマーが発火して、閉じられた出力へログを書こうとするエラーを防ぐため。
