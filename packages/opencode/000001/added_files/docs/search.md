# ローカルのファイル検索(サブエージェント `finder` + スキル `file-finder`)

ローカルのファイルを、中身(全文)と名前で探す。検索してよい場所を決めて、その外は探せないようにする。

## 構成

```
agents/finder.md                      サブエージェント。スキルを読み込んで、場所と根拠の抜粋だけを返す
skills/file-finder/
├─ SKILL.md                           使い方と守ること(サブエージェントが読む)
├─ run.bat                            ハーネスの .venv の Python で本体を動かす入口(ASCII のみ)
├─ config.sample.json                 設定のひな形
├─ config.local.json                  会社側だけの設定(リポジトリには入れない。.gitignore の *.local.json で除外済み)
├─ scripts/search_core.py             2 つのサーバーを呼ぶ部分と、対象の検査
├─ scripts/finder_cli.py              コマンドライン(content / names / read / targets / check)
└─ tests/test_finder.py               偽のサーバーを使うテスト
```

外部のパッケージは使わない(Python の標準ライブラリだけ)。

## 役割分担

| 探したいもの | コマンド | 使うもの | 対象 |
|---|---|---|---|
| 中身(全文) | `content` | Local-fulltext-search の `POST /api/search/indexed` | インデックス済みのフォルダ。再インデックスはしない(読み取りだけ) |
| ファイル名・フォルダ名 | `names` | Everything の HTTP サーバー(JSON) | 設定の `roots` の全体 |
| 見つけたテキストを読む | `read` | ファイルを直接開く(読み取りだけ) | `roots` の中のテキストのファイル |
| 対象フォルダの確認 | `targets` | Local-fulltext-search の `GET /api/index/search-targets` | - |
| 設定と接続の確認 | `check` | 両方 | - |

- 使い分け: よく使うフォルダは Local-fulltext-search に入れて、`content` で中身まで探す。あまり使わないフォルダは、Everything の `names` で名前だけ探す。
- **調査は、1 回の依頼で答えまで出す(0.21.0)。** `finder` は、探して、資料の 1〜3 件を読めば答えられる問いなら、`read` で読んで答えまで返す。「〜について調べて」のように、多くの資料を読む調査は、`researcher` が、探すところから行う(`researcher` も `file-finder` を使える)。以前は、`finder` が場所だけを返し、メインが「読んでよいか」と聞いて止まっていた。

## 対象を決める仕組み

設定の `roots` に書いたフォルダだけが対象。これを検索ツールの中で強制する。

- `roots` の外は、検索もできず、結果にも出ない(Everything は全ドライブを索引しているため、結果から捨てる)。
- `--folder` で `roots` の外を指定すると、サーバーに何も送らずに拒否する。`..` での抜け道も塞ぐ。
- 全文検索に、空の `folder_path`(インデックス全体の検索)を、決して送らない。必ず `roots` の中のフォルダを指定する。
- `fulltext.folders` を設定すると、全文検索はそのフォルダだけを対象にする(省略時は `roots`)。`roots` の外のフォルダを書くと、設定エラー。
- `exclude` のパターン(`.git`、`.handoff`、`~$*`、`*.tmp` など)に当たるものは、結果に出ない。`.handoff` は、ハーネスの下書きとバックアップの置き場。下書きには AI の印(frontmatter)が無く、人のノートに見えてしまうため、雛形で除外している(0.15.1)。
- ローカル以外の結果(Web、ガント)は、出さない。
- 呼ぶ API は、読み取りの 3 つだけ(`/api/search/indexed`、`/api/health`、`/api/index/search-targets`)。テスト(`SafetyTests`)が、ソースにこれ以外の API が無いことを検査する。
- 検索のパスの検査は文字列だけで行う。結果のパスは、サーバーが返したインデックス上のパスで、利用者が与えたものではないため。

### 見つけたファイルを読むには

作業フォルダの外のファイルを `read` の道具で開くと、OpenCode の `external_directory` の確認で止まる。止まらずに読む方法は、2 つある。

1. **スキルのスクリプトで読む(設定は要らない)。** テキストのファイルは `file-finder` の `read`、Word・Excel・PowerPoint・PDF は `doc-convert`。どちらも、`roots` の中だけを読む。`finder` と `researcher` は、こちらを使う。
   - `read` は、`roots` の外、除外のパターン、認証情報らしい名前(`.env`、`*.pem`、`*.key` など)、テキストでないファイル、リンクの先が `roots` の外のものを拒否する(このコマンドだけは、ファイルを開くので、リンクを解いた後の場所でも確かめる)。5 個まで、1 ファイル 12,000 文字まで(続きは `--from-line`)。
2. **`external_directory` で許可する。** メインが `read` の道具で直接読むときにも、確認が出なくなる。会社側の `opencode.json` に、`roots` と同じフォルダを書く。

```json
"permissions": [
  {"action": "external_directory", "resource": "*", "effect": "ask"},
  {"action": "external_directory", "resource": "C:/Users/<ユーザー名>/Documents/*", "effect": "allow"},
  {"action": "external_directory", "resource": "D:/共有フォルダ/*", "effect": "allow"}
]
```

(OpenCode V2 の書き方。後ろに書いたルールが優先されるので、許可を `ask` の後ろに置く。`*` は `/` を含む任意の文字列に一致する。)

`roots` と二重管理になるので、変えるときは両方を直す。

## 会社での設定

1. `skills\file-finder\config.sample.json` を、同じフォルダに `config.local.json` という名前でコピーする。
2. 次を書き換える。
   - `roots`: 検索してよいフォルダ(絶対パス。`<ユーザー名>` のままだと、エラーになる)
   - `everything.url`: Everything の HTTP サーバーの URL とポート(Everything の設定 → HTTP サーバー)
   - `everything.user`: ユーザー名を設定しているときだけ。パスワードは、環境変数(`everything.password_env` の名前)に設定する
   - `fulltext.url`: Local-fulltext-search の URL(既定は `http://127.0.0.1:8079`)
3. 確認する(Everything と Local-fulltext-search を起動した状態で)。

   ```
   skills\file-finder\run.bat check
   skills\file-finder\run.bat targets
   skills\file-finder\run.bat names 見積
   skills\file-finder\run.bat content 見積
   ```

4. OpenCode から: 「`finder` を使って、〇〇について書かれたファイルを探して」。

Everything の HTTP サーバーは、そのPCの全ファイル名を localhost から見えるようにする。ユーザー名とパスワードを設定し、`127.0.0.1` だけで受け付けるようにしておく。

## 未確認のこと(会社で確認)

偽のサーバーのテストは、呼び出しの組み立て、対象の検査、整形を確認している。実物との接続は、会社で確認が要る。

| 項目 | 確認すること | 直す場所 |
|---|---|---|
| Everything の JSON | `json=1`、`path_column`、`size_column`、`date_modified_column` が使えるか。結果が `results` の配列で、`type`、`name`、`path`、`size`、`date_modified` を持つか | `everything_search` |
| Everything の日時 | `date_modified` が FILETIME の数値で返るか(画面の更新日時と一致するか)。タイムゾーンのずれ | `filetime_to_text` |
| Everything の検索語 | `"C:\フォルダ\" 語` で、そのフォルダの下に絞れるか。`file:`、`folder:`、`ext:xlsx;docx` が効くか | `everything_search` |
| Everything の並び | `sort=date_modified&ascending=0` で、新しい順になるか | `everything_search` |
| Everything の認証 | ユーザー名を設定したときの Basic 認証が通るか | `everything_search` |
| 全文検索の API | `POST /api/search/indexed` の結果の `full_path` が、ファイルの絶対パスか。`extensions` の形式(`md,txt` でよいか、`.md` か)。`search_type` が `keyword` で動くか | `fulltext_search` |
| 全文検索の対象 | インデックスされていないフォルダを指定したときの挙動(0 件か、エラーか) | `fulltext_search` |
| 文字コード | 日本語の出力が文字化けしないか(標準出力を UTF-8 にしている) | `finder_cli.main` |
| 権限 | `agents/finder.md` の `shell` のパターンが、実際のコマンドに一致するか(パスにスペースがある場合など) | `agents/finder.md` |
| サブエージェント | `finder` が呼ばれ、スキルを読み込み、返答の形で返すか | `agents/finder.md` |

## 開発メモ

- テストの実行(リポジトリのルートから):

  ```
  python -m unittest discover -s skills/file-finder/tests -v
  ```

- 実物と違うところが見つかったら、偽のサーバー(`tests/test_finder.py` の `FakeBackends`)に同じ形の応答を足して、テストで再現してから直す。
- 検索の本体は `search_core.py` に分けてある。将来、MCP サーバーに包み直すときは、この部分をそのまま使える。
