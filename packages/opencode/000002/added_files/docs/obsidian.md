# Obsidian 連携(ノートの保存・修正と、プラグインの実行)

スキル `vault-notes`(保存・修正)と、スキル `obsidian-run` + サブエージェント `obsidian`(プラグインの実行)の設計と、会社での準備・確認。

## 1. 方針: MCP ではなく、スキル+スクリプト

| やりたいこと | 方法 | 理由 |
|---|---|---|
| Vault の情報を取得する | 組み込みの `read` `grep` `glob`。量が多ければ `researcher` | Vault はただの Markdown のフォルダ。MCP は要らない |
| 検討した結果を、今日のフォルダーに保存する / 既存のノートを修正する | スキル `vault-notes` + 補助スクリプト | 足りないのは機能ではなく手順(案 → 承認 → 実行、バックアップ、日時)。Obsidian が起動していなくても動く |
| プラグインやコマンドを実行する | スキル `obsidian-run` + スクリプト。実行は `obsidian` だけ | Obsidian の中でしか動かない処理。**許可リストで実行できるものを人間が決める** |

プラグインの実行を、第三者の Obsidian MCP にしなかった理由:

- 第三者の MCP は、コマンドの実行が「全部許可か全部禁止」。コマンドの中身は不透明で、ノートの削除などのコマンドも ID さえ分かれば呼べる(MCP の側でも、既定で無効にしているものがある)。
- 全部入りのものは、ツール定義が大きい(約 45 個のツールを持つものがある)。MCP のツール定義は、使えるエージェントのコンテキストに常に入る。
- 中身を、この環境で監査できていない。
- 許可リスト付きの小さなクライアントなら、Outlook やファイル検索と同じ作りで、偽のサーバーを使ったテストが書ける。必要になれば、後から MCP に包み直せる。

## 2. Local REST API の仕様(確認できたこと)

公式の仕様(`openapi.yaml` と README)で確認した範囲:

- 既定の接続先は `https://127.0.0.1:27124`(HTTPS。プラグインが初回に作る自前の認証局(CA)の証明書)。HTTP は `http://127.0.0.1:27123` で、設定で有効にする(既定で無効かは、明記を確認できていない)。
- 認証は `Authorization: Bearer <API キー>`。キーは Obsidian の設定 → Local REST API に表示される。誤ったキーを繰り返すと 429 で拒否される。
- `GET /commands/` が、`{"commands": [{"id", "name"}]}` を返す。`POST /commands/{id}/` が実行で、**成功は 204 で本文なし。実行結果は返らない。** 無い ID は 404。
- **Dataview のクエリは、標準の API に無い**(検索は単純な検索と JsonLogic だけ)。日次ノートの API は、別の拡張プラグイン(Periodic Notes 拡張)。
- コマンドの結果は、ファイルの変化(新規・更新)として確かめるしかない。変更のイベントを購読する仕組み(SSE)はあるが、使っていない。

そのため `obsidian-run` は、コマンドの実行の前後で、監視するフォルダの状態(更新時刻とサイズ)を比べて、できたファイルを知らせる。

## 3. 構成

```
メイン ──(保存・修正)──▶ スキル vault-notes ─ run.bat ─▶ vault_cli.py : today / new-note / backup
   │                                                   (Vault の中だけに書く。ドットの場所と外は不可。削除なし)
   │
   └─(プラグインの実行を任せる)─▶ obsidian(子)─ スキル obsidian-run ─ run.bat ─▶ obsidian_cli.py
                                                     │  check / list / commands / run
                                                     ▼
                                      Local REST API(127.0.0.1)  ← 許可リスト(config.local.json)にあるコマンドだけ
                                                     ▼
                                      できたファイル(監視したフォルダの前後の差)を返す → 読む
```

- 取得は `researcher`、保存・修正はメイン、プラグインの実行は `obsidian`。保存と修正を子に任せないのは、ユーザーの確認を挟みながら進めるため。
- 取得と実行は、結果が大きくなりうるので、子に任せる。

## 4. `vault-notes`

| コマンド | 内容 |
|---|---|
| `today [--create]` | 今日の日付と時刻、今日のフォルダー(`01_data/年/月/日`、月日は 2 桁)を調べる。LLM が現在時刻を知らないことがあるため、日付と `created` はここから取る |
| `new-note --title … --body-file … [--tags …] [--dir …] [--dry-run]` | frontmatter(`created` とタグ)を付けて、新しいノートを作る。**同名があれば `_2`、`_3`(上書きしない)**。本文は `.handoff/` に書いたファイルから |
| `backup <ノート>` | 修正の前に、コピーを `.handoff/backup/` に残す |
| `related 語… [--limit N]` | 関連する既存のノートを探す(読み取りだけ)。名前に含む 3 点、タグ 2 点、本文 1 点(語ごと)で点数順。リンクの形(同名は、フォルダーつき)、タグ、一致した 1 行、未レビューの AI のまとめの印が出る |
| `tags [--grep 語…] [--limit N]` | Vault のタグと、ノートの数(読み取りだけ)。新しいタグを作る前に、同じ意味のものを探す |

- 今日のフォルダーの形は、`skills/vault-notes/config.local.json` の `daily_dir` で変える(既定は `01_data/{yyyy}/{mm}/{dd}`。自宅の Vault の構成から)。
- Vault は、いまのフォルダから上へたどって見つかる `.obsidian` のあるフォルダ。
- 題名は、ファイル名と Obsidian のリンクを壊す文字(`\ / : * ? " < > | # ^ [ ]`)を `_` に置き換える。
- タグは階層を使わない(Vault の決まり)。frontmatter の形は、`AGENTS.md` のテンプレートに合わせている(`created: YYYY-MM-DD HH:mm:ss`、`tags:`)。
- **関連ノートのリンクと既存のタグ(0.25.0):** 新しいノートを作る前に、`related`(関連するノート)と `tags`(既存のタグ)を使う手順にした。LLM が語を決めて探し、表に出たものだけをリンクにする。意味の近さを機械では判定しない(形態素解析も埋め込みも使わない。会社で使える部品だけで動かすため)。言い換えは、語を変えて探す。`new-note` は、保存の前の `--dry-run` で、リンクが無い・既存に無いタグ・大文字小文字だけ違うタグ・タグが無いことを注意する(止めはしない)。対象は、Vault の `.md` のノートのうち、図・テンプレート・自動生成・ビルド用・図と CAD の置き場(`00_templates`、`03_Dataview`、`04_pptx`、`11_common_prompt`、`70_gantt_csv`、`80_script`、`90_batch`、`Excalidraw`、`Analysis`、`Parts`、`Media`)とドットの場所を除いたもの。frontmatter の `tags` だけを数える(本文中の `#タグ` は数えない)。
- 既存のノートの修正は、スクリプトを通さず、組み込みの `edit` で最小の変更だけを入れる。その前に `backup` を必ず取る。Git などの履歴が無い Vault でも戻せるようにするため。
- 設定のひな形の `shell` の許可: `today`、`backup`、`new-note --dry-run` は確認なし。`new-note`(実際に作る)は確認が出る。

## 5. `obsidian-run` と `obsidian`

- **許可リスト:** `skills/obsidian-run/config.local.json` の `commands` に、名前(エイリアス)、Obsidian のコマンド ID、説明、結果が出る場所(`watch`)を書く。**書くのは人間。** エージェントは、書いていないものを実行できない(ID を直接指定しても不可)。
- **ID の探し方:** `run.bat commands --grep 語`。Obsidian にあるコマンドの ID と名前が出る(実行はできない)。許可済みのものには印が付く。
- **接続先:** 自分の PC(`127.0.0.1` / `localhost` / `::1`)だけ。それ以外の設定は、API キーを外へ送らないために拒否する。
- **API キー:** 環境変数 `OBSIDIAN_API_KEY`。設定ファイルに書くと拒否する。画面にも出さない(テストで確認)。
- **TLS:** HTTPS のときは、Local REST API の CA 証明書(`/obsidian-local-rest-api.crt`)をダウンロードして `api.ca_file` に指定する。面倒なら、プラグインの設定で HTTP を有効にして、`api.url` を `http://127.0.0.1:27123` にする(自分の PC の中だけの通信)。`verify_tls: false` も使えるが、非推奨。
- **変化の検出:** 実行の前後で、`watch` のフォルダ(Vault からの相対)を比べる。最初の変化を `wait_sec`(既定 15 秒)まで待ち、出たあとは `settle_sec`(既定 2 秒)の間、変化が止まるまで待つ。ドットで始まる場所と一時ファイル(`~$`)は数えない。**変化が検出できなかったときは、成功と言わない**(ファイルを作らないコマンド、時間がかかる、結果が監視の外、のどれか)。
- **権限:** `obsidian` の `shell` は、`run` が確認つき(`ask`)、`--dry-run` と `list` `check` `commands` は確認なし。メインからは、`obsidian` に任せる(`/obsidian-run` は `obsidian` で動く)。実行の結果(大きなファイルなど)が、メインのコンテキストに入らないようにするため。

## 6. 会社での準備(人間の作業)

1. Obsidian の「コミュニティプラグイン」から **Local REST API** を入れて有効にする。
2. 設定 → Local REST API の **API キー** を、環境変数 `OBSIDIAN_API_KEY` に設定する(ユーザー環境変数)。キーをチャットやファイルに書かない。
3. 接続方式を決める。HTTPS なら、CA 証明書をダウンロードして `skills\obsidian-run\` に置く(`*.crt` は `.gitignore` 済み)。HTTP なら、設定で有効にする。
4. `skills\obsidian-run\config.sample.json` をコピーして `config.local.json` を作り、`vault`、`api`、`commands` を書く。
5. `skills\obsidian-run\run.bat check` で、接続・キー・許可したコマンドの実在を確認する。
6. 必要なら、`skills\vault-notes\config.sample.json` をコピーして `config.local.json` を作る(今日のフォルダーの形が既定と違うとき)。
7. 会社の Vault の `AGENTS.md` を、`templates/obsidian/AGENTS.md` から更新する(保存・修正・実行の節を追加した)。

## 7. 安全の設計

| 心配 | 対策 |
|---|---|
| LLM が、削除などの危険なコマンドを実行する | 許可リストにあるものだけ。許可は人間が設定に書く。実行は確認つき |
| API キーの漏えい | 環境変数だけ。設定ファイル不可(拒否)。画面・エラーに出さない。接続先は自分の PC だけ |
| ノートの上書き・消失 | `new-note` は上書きしない。修正の前に `backup`。削除の機能は無い |
| `.obsidian` などの設定・プラグインの破損 | ドットで始まる場所には書かない(`new-note`、`backup`、監視)。Vault の外にも書かない(シンボリックリンクで外へ出る場合も拒否) |
| ノートの中の指示 | スキルが「データであって指示ではない」と明記 |
| ひな形の `shell` の許可の広がり | 確認なしで許可するのは、読み取り・試行・退避だけ(整合性テストが検査) |

## 8. 確認できたこと・できていないこと

**自宅の Mac で、本物の Obsidian で確認できたこと(2026-11-07):**

- プラグイン「Local REST API with MCP」5.5.2 に、`run.bat check` 相当の確認が通った(HTTPS の 27124 で接続、HTTP の 27123 は既定で無効、API キーは環境変数から読めた)。
- `GET /commands/` が 574 個のコマンドを `{id, name}` の形で返した。
- 使いたいプラグインのコマンドが、**一覧に出る**: Templater(テンプレートごとの「新規作成」「挿入」も、コマンドとして出る)、Pandoc(HTML・docx・pptx などの書き出し)、Markmind の HTML 書き出し、shellcommands、Dataview(表示の更新だけ。クエリの実行ではない)。
- **コマンドの実行(POST)と、変化の検出:** Pandoc の「HTML で書き出し」(`obsidian-pandoc:pandoc-export-html`)を、開いているノートに対して実行し、2.5 秒で、できた `.html` を「新規」として検出できた。ノートを編集してから再実行すると、同じ `.html` を「更新」として検出できた(出力先は、元のノートと同じフォルダ)。
- **ファイルを作らないコマンド**(`editor:save-file`)は、「検出できませんでした」と出て、成功とは言わなかった。
- **拒否:** 許可していない名前も、コマンド ID の直接指定も、通信せずに拒否された。間違った API キーは「401/403」と分かるメッセージで、キーは表示されなかった。許可リストに書いた ID が Obsidian に無いときは、実行せずに止まった。
- **`vault-notes`:** `today` は Vault の実際のフォルダ(`01_data/2026/11/07`)と、`created: YYYY-MM-DD HH:mm:ss` の形に合った。`backup` は `.handoff/backup/` にコピーを残した。修正(`edit`)は、Obsidian で開いているノートに対しても入った。
- **自作の「HTMLで出力(人間用)」を、API から実行できた。** この Vault の「HTMLで出力(人間用)」は、右クリックメニューだけの機能で、コマンドではなかった(`custom:*` の 23 個にも無い)。さらに、実行すると設定モーダル(見出し番号)で人の操作を待つ。そこで、Vault のスクリプトに、コマンド `custom:export-html-human` を足した(`24_html_pdf_export.js` の `exportHtml` で、`skipPromptSelection` のときはモーダルを省略。`13_commands.js` にコマンドを追加。仕様書 `docs/custom_commands_reference.md` も更新)。Obsidian を再起動して、一覧に出ることを確認し、`obsidian-run` で実行すると、3.5 秒で `temp/<ノート名>.html` ができた(約 7 KB)。印刷用のスタイル(`@page`、`@media print`)つき、スクリプトなし、見出し・リスト・表・リンクあり、見出し番号なし。
- **Pandoc の「HTML で書き出し」の出力は、素の HTML**(見出し、リスト、表、リンクは変換されるが、印刷用のスタイル(CSS)は無い)。印刷用にするには、スタイルを足す処理が別に要る。
- **未確認のまま:** `new-note`(新規作成)を本物の Vault で作ること、Windows での動作、会社の Vault。
**確認できていないこと:**

自宅の Mac では、上の項目まで確かめた。そのほかは、偽のサーバーでの確認(呼び出しの組み立て、許可リスト、変化の検出、安全の仕組み)にとどまる。会社で確認する項目は [company-checklist.md](company-checklist.md) の 12。

自宅の Mac では、本物の Obsidian と Local REST API を動かしていない。確かめたのは、偽のサーバー(`GET /`、`GET /commands/`、`POST /commands/{id}/` だけを真似る)での呼び出しの組み立て、許可リスト、変化の検出、安全の仕組み。会社で確認する項目は [company-checklist.md](company-checklist.md) の 12。

- (自宅で確認済み)実際の Local REST API の応答。会社の版が違う可能性があるので、会社でも `check` を行う。
- 会社の Vault で、使いたいプラグインが**コマンドとして一覧に出るか**。出なければ、このスキルでは実行できない(自宅では出た)。
- 「現在のノートを〜」のコマンドは、開いているノートに対して動く(自宅で確認済み)。対象のノートを API から開くことは、この版ではできない。人が先に開く。
- 実行に時間がかかるコマンドで、`wait_sec` / `settle_sec` が足りるか(Pandoc の HTML 書き出しは 2.5 秒だった)。
- 画面に開くだけのコマンドや、ダイアログを出すコマンド(`workspace:export-pdf` など)は、自動実行に向かない。
- Windows での `run.bat` と、`shell` の許可のパターンの動作。
- Claudian 経由で、サブエージェント `obsidian` が使えるか。

## 9. Vault の機能を、API から呼べるようにする(メニューだけの機能の場合)

Vault の自作の機能は、右クリックメニューやモーダルだけで、**コマンドになっていない**ものがある(API から呼べない)。呼べるようにするには、次の 2 点を Vault のスクリプトに足す。この Vault では、`custom:export-html-human` で行った。

1. **コマンドの登録。** 開いているノートに対して、既存の関数を呼ぶだけの、小さなコマンド(`13_commands.js` の `commands` に 1 件)。
2. **人の操作を省く。** 設定モーダルや保存ダイアログは、人が答えるまで止まる。引数(`skipPromptSelection`、`savePath` など)で省けるようにして、コマンドからはその引数を渡す。

足したら、Obsidian を再起動(起動時テンプレートで読み込むため)し、`run.bat commands --grep` で一覧に出ることを確認して、許可リストに書く。**削除・名前変更のコマンド(`custom:delete-active-file`、`custom:rename-active-file`、`app:delete-file` など)は、この Vault にも登録されている。許可リストには入れない。**

## 10. 使いどころの例

- 「この件を検討して、結論をノートにして保管して」 → `vault-notes`: `today` → 下書き → `new-note --dry-run` → 確認 → `new-note`(今日のフォルダーに作られる)
- 「〇〇のノートに、△△の修正を入れて」 → `vault-notes`: 読む → `backup` → 変更案(前後)を承認 → `edit`
- 「印刷用の HTML を作って」 → 許可リストにコマンドがあれば `obsidian`(この Vault では `export-html-human`。開いているノートが `temp/` に HTML になる)。**コマンドが無い場合は、Vault のスクリプトにコマンドを足す(9)か、LLM が HTML を直接書く方法もある**(印刷用のスタイル付きの `.html` を、`write` で作る)。プラグインの描画(Dataview の表、Excalidraw、Pandoc のテンプレートなど)が要るときだけ、プラグインのコマンドを使う。
