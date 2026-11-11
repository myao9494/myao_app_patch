# 会社での導入・確認チェックリスト

自宅では、本物の Outlook、Everything、Edge、会社の OpenCode を動かせない。このファイルは、会社で、上から順に確認するための一覧。結果は、各行の `[ ]` に ○ / △ / × と、メモを書いて残す。うまくいかなかったときの直し方は、「だめなとき」の列のドキュメントにある。確認のコマンドをまとめて流す手順は、[README.md](../README.md) の「会社の Windows PC でのセットアップ手順」にある。

## 0. 前提

| 確認 | 期待する結果 | だめなとき |
|---|---|---|
| [ ] OpenCode のバージョンを記録する(CLI と Desktop) | 同じバージョン | 片方だけ更新しない([operations.md](operations.md) の 4) |
| [ ] 社内LLMの**モデル名とバージョン**を記録する(このハーネスは Inkling-Small を想定している)。記録: ______ | 想定どおり | 違うモデルなら、[operations.md](operations.md) の 5.2 の測定をもう一度行う |
| [ ] 社内LLMの**コンテキスト長と出力の上限**(配備の設定)を記録する。記録: ______(申告は、コンテキスト約 13 万、出力約 8 万。出力は記憶なので要確認) | 分かる | 公式は「最大 1M」だが、配備の設定は別 |
| [ ] 会社側の `opencode.json` の、モデルの定義に **`limit`(`context`、`output`)が書かれている** | 書かれている | 省略すると 20 万・3.2 万と仮定され、圧縮が遅れて窓を超える。[operations.md](operations.md) の 5.4 |
| [ ] 思考の深さ(effort)を切り替えられるか。切り替え方: ______ | 記録する | 公式に記載がない。切り替えられなくても動く設計 |
| [ ] `python --version`、`node --version` | 両方、バージョンが出る | PATH を確認する |
| [ ] Microsoft Edge、クラシック版 Outlook がある | あり | Outlook は新しい版では動かない |
| [ ] Everything の HTTP サーバー、Local-fulltext-search が起動している | 起動している | [search.md](search.md) |

## 1. 持ち込み(myao-patch-bridge)

| 確認 | 期待する結果 | だめなとき |
|---|---|---|
| [ ] 自宅で、`python3 run_tests.py` が全部通る | 全テスト成功 | 運ばずに直す |
| [ ] 自宅で、公開前の検証とリハーサルが通る | 通る | [operations.md](operations.md) の 1 |
| [ ] 会社で、ZIP を検証・適用する。`company_repo_paths` に `.config\opencode` を対応付けてある | 適用に成功する | 失敗したアプリは、適用前に戻る |
| [ ] `.config\opencode\` に、`AGENTS.md`、`agents\`、`skills\`、`commands\`、`mcp\playwright\node_modules\` が届いている | 届いている | 名前やパスの制約([operations.md](operations.md) の 1) |
| [ ] `skills\*\run.bat` が、改行コード CRLF で届いている | 動く | `.gitattributes` を確認する |

## 2. 設定の反映

| 確認 | 期待する結果 | だめなとき |
|---|---|---|
| [ ] `sample_opencode.json` と会社側の `opencode.json` を見比べて反映する(プロバイダの設定は残す) | JSON が正しい | [CHANGELOG.md](../CHANGELOG.md) |
| [ ] OpenCode が **V2** であることを確認する(版を記録した欄に書く) | V2 | このハーネスの設定・エージェント・コマンドは V2 の書き方。V1 では動かない |
| [ ] `opencode debug config`(Mac の V2.2.6 では動いた。会社の版で確認) と `opencode debug agents` | 反映した `permissions` と `mcp.servers` が出る。自作のエージェント 8 つ(browser、diagram、finder、obsidian、outlook、polish、researcher、reviewer)が `subagent` として出る(内蔵の Explore と General も出る) | キーが読まれない場合は、版を確認する。出ないコマンドなら、5(スキルとコマンド)の動作確認で代える |
| [ ] Desktop と Obsidian を完全に終了して、起動し直す | 起動する | 設定の書き間違いを疑う |
| [ ] OpenCode が使うシェルを確かめる(メインで、`echo %ComSpec%` と `$PSVersionTable.PSVersion` を、1 つずつ実行してもらう。cmd なら前者がパスを返し、PowerShell なら後者が版を返す) | cmd / PowerShell / Git Bash のどれかを記録する | 公式に記載がない。スキルの手順書の `run.bat …` は、cmd と PowerShell のどちらでもそのまま動く書き方 |
| [ ] メインで `dir > .handoff\t.txt` を頼む | 確認なしで動く(0.16.0 で `*>*` の確認を外した。Git で戻せる) | 確認が出たら、会社側の `opencode.json` に古い `*>*` の行が残っていないかを見る |
| [ ] `outlook` に「件名が folder-list の予定を作って」と頼む(0.9.0 で直した順序) | `cal-create` で**確認の画面が出る** | `agents/outlook.md` の順序(読み取りの許可 → 書き込みの確認)を見る |
| [ ] (0.22.0)メインで `skills\outlook-mail\run.bat folder-create テスト --dry-run`、続けて `--dry-run` なし | 前者は確認なし、後者は**確認が出る** | `opencode.json` に、雛形の `outlook-mail` の 8 行があるか |
| [ ] (0.22.0)メインで `type .env`(ダミーの `.env` を置いて)、`git commit --amend`、`git rebase -i HEAD~1` を頼む | どれも**確認が出る** | 雛形の該当の行。シェルが PowerShell のときの判定(`Get-Content .env` も確認になる) |
| [ ] (0.22.0)メインで `curl.exe http://example.com`、`powershell -c "Invoke-WebRequest http://example.com"` を頼む | **拒否される** | 雛形の拒否の行 |
| [ ] (0.22.0)`researcher` に「`outlook` を呼んで、今日のメールを調べて」と頼む | **子から子は呼べない**(拒否され、そのことを返答する) | V2 の action 名が `subagent` で合っているか(公式の移行表から取った。違えば、正しい名前に直す) |
| [ ] (0.22.0)`reviewer` に「変更をレビューして」と頼む | 聞き返さずに、`git status` と `git diff` を読んで指摘を返す。`git commit` などは拒否される | `agents/reviewer.md` の `shell` |

## 3. AGENTS.md の読み込み

| 確認 | 期待する結果 | だめなとき |
|---|---|---|
| [ ] 目立つ指示を書いた `AGENTS.md` を、テスト用フォルダに置いて質問する | グローバルとフォルダ別の、両方が守られる | [operations.md](operations.md) の 2.5 |
| [ ] 共通 `AGENTS.md` の内容(日本語、結論から)が効いている | 効いている | ファイルの場所を確認する |
| [ ] 以前 Claude Code で開発したリポジトリ(`CLAUDE.md` がある。`AGENTS.md` がある場合と無い場合の両方)で、「このリポジトリの決まりを教えて」と尋ねる | `CLAUDE.md` の内容に基づいて答える | 読まれないなら、共通 `AGENTS.md` の「基本」の該当行を確認する。文字数の上限(2,500)にも注意 |

## 4. Python の環境

ハーネスのフォルダ(`C:\Users\<ユーザー>\.config\opencode\`)で行う。

| 確認 | 期待する結果 | だめなとき |
|---|---|---|
| [ ] `python -m venv .venv` | `.venv` ができる | 作れない事情は、報告する |
| [ ] `.venv\Scripts\python -m pip install --require-hashes -r requirements.lock` | 成功する | PyPI に届かない、ハッシュが合わない([operations.md](operations.md) の pip の扱い) |
| [ ] `.venv\Scripts\python -c "import win32com.client"` | エラーなし | pywin32 を入れ直す |
| [ ] `.venv\Scripts\python -c "import pypdf"` | エラーなし(PDF の変換に使う) | `requirements.lock` を入れ直す。無くても PDF 以外は動く |

## 5. スキルとコマンド

| 確認 | 期待する結果 | だめなとき |
|---|---|---|
| [ ] `/meeting-notes` にメモを渡す | スキルが読み込まれ、手順どおりの議事録ができる | [operations.md](operations.md) の「スキルとスラッシュコマンド」 |
| [ ] `/create-subagent` | 先に、サブエージェントが必要かの判断を返す | 同上 |
| [ ] 「Python のパッケージを入れたい」と頼む | `python-env` に沿って、確認を求める | AGENTS.md の Python の節 |

## 6. サブエージェントの共通の動作

| 確認 | 期待する結果 | だめなとき |
|---|---|---|
| [ ] `researcher` に、複数のファイルを読む質問をする | 子が動き、返答が「結論・根拠・確信度・未確認」の形 | [operations.md](operations.md) の 2.3 |
| [ ] 長い結果のとき | `.handoff/` にファイルができ、返答に `詳細:` のパスがある | `edit` の権限のパターン |
| [ ] 短い結果のとき | ファイルは作られず、返答に直接書かれる | `handoff-block.md` |
| [ ] 子の返答だけが、メインのコンテキストに入る | メインのトークン数が、子の読んだ量の分だけは増えない | 画面のトークン数で比べる |
| [ ] 子が共通 `AGENTS.md` を読むか | 記録する(読む / 読まない) | どちらでも動く設計 |
| [ ] 返答が不足しているとき、メインが補いに行く | 詳細ファイルを読むか、子に続きを依頼する | `AGENTS.md` のサブエージェントの節 |
| [ ] `/summarize ファイル名` | 子セッションで実行され、要約だけが返る | `subagent: true` |

## 7. Outlook(`outlook` / `outlook-mail`)

Outlook を起動してから行う。詳細は [outlook.md](outlook.md)。

| 確認 | 期待する結果 | だめなとき |
|---|---|---|
| [ ] `skills\outlook-mail\run.bat check` | 「接続OK」 | クラシック版か、Outlook が起動しているか |
| [ ] `run.bat mail-list --limit 5` | 件名・差出人・日時が、画面と一致する | 時刻がずれる場合は `naive` |
| [ ] `run.bat mail-get <ID> --no-quote` | 本文、添付の名前 | 文字化けは `outlook_cli.main` |
| [ ] `run.bat reply-draft <ID> --body-file … --dry-run`、続けて保存 | 下書きフォルダに 1 通できる。**送信されていない** | HTML 形式の書式 |
| [ ] `run.bat cal-list` | 期間の予定が出る。繰り返しも展開される | `OPENCODE_OUTLOOK_DATE_FORMAT` |
| [ ] `run.bat cal-create … --dry-run`、続けて保存 | 予定が 1 件できる。**招待は送られていない** | - |
| [ ] `run.bat folder-list`、`folder-create "テスト/確認"` | フォルダが見える・できる | `--root mailbox` |
| [ ] テスト用のメール 1 通で、`mail-move` → 新ID → `mail-undo` | 移動して、戻せる。削除済み・迷惑メールへは拒否される | `move_mails`、`undo_moves` |
| [ ] `run.bat cache-sync`(人がターミナルで。「途中です」が出なくなるまで繰り返す)、`cache-status` | 直近 90 日の受信と送信が入る。**かかった秒数と通数を控える** | [outlook.md](outlook.md) の「メールのキャッシュ」 |
| [ ] `run.bat cache-search 見積 --since 2026-11-01`、`cache-show <ID> <ID>` | 受信も送信も出る。抜粋と本文が、Outlook の画面と一致する。2 回目の `cache-search` は数秒で終わる | 並べ替え(`CACHE_SORT_FIELDS`) |
| [ ] 新着のメールが 1 通届いた後で `cache-search --since today` | 新着が出る(差分の取り込み) | `outlook_cache.sync` |
| [ ] `outlook` に「今日届いたメールから、自分の作業を挙げて」と頼む | 期間などを聞き返さず、キャッシュから読んで、1 回で答える | `agents/outlook.md` の手順 2〜4 |
| [ ] `outlook` に「整理して」と頼む | まず案だけが出て止まる。承認後に実行する | [outlook.md](outlook.md) の運用 |
| [ ] 権限の `ask` が、書き込み系のコマンドで出る。`--dry-run` では出ない | 出る / 出ない | `agents/outlook.md` の `shell` |

## 8. ブラウザ(`browser` / Playwright MCP)

詳細は [mcp.md](mcp.md)。

| 確認 | 期待する結果 | だめなとき |
|---|---|---|
| [ ] `.venv\Scripts\python mcp\playwright\smoke_test.py msedge` | 「スナップショットに見出しが出る: OK」 | Edge のパス(`--executable-path`)、セキュリティソフト |
| [ ] `opencode.json` に `mcp.servers` と `playwright_*` の `deny` を反映し、`"disabled": false` にする | 起動時にエラーが出ない | パス、`timeout`、設定の書き方の版 |
| [ ] **メインに Playwright のツールが見えない** | 見えない(トークンの確認: 有効化の前後で比べる) | 消えない場合の対処は未確認(V1 の `tools` 設定は V2 の一覧に見当たらない)。報告して方針を決める([mcp.md](mcp.md)) |
| [ ] `browser` に、社内ページの内容を尋ねる | ページを開いて、要点を返す | ツール名、権限 |
| [ ] 入力・アップロード・スクリプトの実行で、確認が出る。`run_code_unsafe` は拒否される | そうなる | `agents/browser.md` の `permissions` |
| [ ] ログインが必要なページ | 入力せずに止まり、人間にログインを促す | - |
| [ ] 作業フォルダに `.handoff/playwright/` ができる | できる(プロジェクトを汚さない) | `--output-dir` |

## 9. ファイル検索(`finder` / `file-finder`)

詳細は [search.md](search.md)。

| 確認 | 期待する結果 | だめなとき |
|---|---|---|
| [ ] `config.sample.json` を `config.local.json` にコピーして、`roots` などを書く | - | - |
| [ ] `skills\file-finder\run.bat check` | 設定 OK、2 つのサーバーが接続OK | URL とポート、パスワードの環境変数 |
| [ ] `run.bat targets` | 全文検索の対象フォルダが出る | - |
| [ ] `run.bat names 見積` | `roots` の中だけが出る。新しい順。日時とサイズが正しい | FILETIME、`json=1`、並び |
| [ ] `run.bat content 見積` | `roots` の中のインデックス済みのファイルだけ。抜粋つき | `extensions` の形式 |
| [ ] `--folder` に `roots` の外を指定する | 拒否される | - |
| [ ] `run.bat read <roots の中の .md のパス>`、続けて `roots` の外のパス | 中は行番号つきで読める。外は拒否される | `search_core.read_text` |
| [ ] `finder` に「〇〇の連絡先は」と聞く | 探して、読んで、答えまで返す。**「読んでよいか」と聞かれない。許可の確認も出ない** | `agents/finder.md` |
| [ ] メインに「〇〇について調べて」と頼む(作業フォルダの外に資料がある) | `researcher` が、探す → 読む → 答える、を 1 回で行う。許可の確認が出ない | `agents/researcher.md`、[search.md](search.md) |

## 10. 文書の変換(`researcher` / `doc-convert`)

詳細は [convert.md](convert.md)。実際に使っている社内の文書(Word、Excel、PowerPoint、PDF)を、作業フォルダにコピーして試す。

| 確認 | 期待する結果 | だめなとき |
|---|---|---|
| [ ] `skills\doc-convert\run.bat check` | 作業フォルダ、`pypdf: あり` | `pypdf` が無ければ、`requirements.lock` を入れ直す([operations.md](operations.md) の pip) |
| [ ] `run.bat info 見積.xlsx`(実際のファイル) | シート名が画面と一致する | - |
| [ ] `run.bat convert 報告書.docx` | `.handoff\converted\報告書.docx.md` ができる。画面には保存先と目次だけ。見出し・表・箇条書きが期待どおり | 見出しが出ないときは、Word のスタイルを使っているか(直接指定した書式は見出しにならない) |
| [ ] Excel で、日付・数式・非表示のシート | 日付が日付で出る。数式の結果が出る。非表示は「注意」に出る | 書式の判定(`convert_core.py` の `_is_date_format`) |
| [ ] PowerPoint で、題名・箇条書き・表・ノート | スライド順に出る | - |
| [ ] 日本語の PDF | 文字化けしない。順序が大きく崩れない | 崩れる場合は、PDF の作り方に依存する。報告する |
| [ ] 大きなファイル(数十 MB、数百ページ) | 許容できる時間で終わる | `--pages`、`--max-rows` で分ける |
| [ ] 作業フォルダの外のファイルを指定する | 拒否される。`config.local.json`(無ければ `file-finder` の `roots`)に書いたフォルダは読める | - |
| [ ] `researcher` に「この Excel と PDF を読んで〇〇を教えて」と頼む | 子が `doc-convert` を読み込み、変換して読む。根拠に元のファイル名とシート名・ページ番号が書かれる。「注意」が「未確認」に反映される | `agents/researcher.md` の `skill` と `shell` の許可 |
| [ ] 変換の「注意」(画像、切り詰めた表など) | 返答の「未確認」に出る | `skills/doc-convert/SKILL.md` |
| [ ] `/convert-doc 報告書.docx` | 子セッションで変換され、保存先と目次だけが返る | - |

## 11. `.handoff/` の掃除(`handoff-clean`)

| 確認 | 期待する結果 | だめなとき |
|---|---|---|
| [ ] `skills\handoff-clean\run.bat list` | 件数、古さ、場所が出る。何も変わらない | `.venv` が無くても、PATH の `python` で動く |
| [ ] `/handoff-clean` | `list` の結果を見せて、承認を待つ。承認前に `sweep` を実行しない | `commands/handoff-clean.md` |
| [ ] `list` の許可 | `list` も `sweep`(退避するだけ)も確認なしで動く(0.16.0) | `sample_opencode.json` の `shell` のパターン |
| [ ] `sweep --older-than-days 7 --dry-run` の後、実行 | 古いものが `.handoff\_trash\<日時>\` に移る。削除されない。`manifest.txt` ができる | - |
| [ ] 移動したファイルを元の場所へ戻せる | 戻せる | - |
| [ ] `_trash` を、人間がエクスプローラーで削除できる | できる | - |

## 12. Obsidian 連携(`vault-notes` / `obsidian-run` / `obsidian`)

詳細は [obsidian.md](obsidian.md)。準備(プラグインの導入、環境変数、設定ファイル)は、そちらの 6。

| 確認 | 期待する結果 | だめなとき |
|---|---|---|
| [ ] Vault の中で `skills\vault-notes\run.bat today` | 日付(曜日)と時刻がPCの時計と合う。今日のフォルダーが `01_data/年/月/日`(2 桁) | `daily_dir` の設定。Vault が見つからないときは、実行する場所 |
| [ ] `/save-note` で、検討した内容を保存する | 今日のフォルダーに、`created` とタグつきのノートができる。同名は `_2`。Obsidian で開ける | frontmatter の形を Vault に合わせる(`vault_cli.py` の `build_note`) |
| [ ] 保存したノートの frontmatter、タグ、リンクの形 | Vault の決まり(階層なしのタグ、`[[ノート名]]`)と合う | `templates/obsidian/AGENTS.md` |
| [ ] 会社の Vault で `skills\vault-notes\run.bat tags --grep 〇〇` と `run.bat related 〇〇 △△` | 既存のタグ(件数つき)と、関連するノート(`[[ノート名]]`、タグ、一致した 1 行)が出る。図・テンプレートは出ない。時間が長くかかる(数十秒以上)なら、Vault の大きさと、ウイルス対策の影響を見る | `skills/vault-notes/scripts/vault_cli.py` の `NON_NOTE_DIRS`(会社の Vault のフォルダー構成が違うとき) |
| [ ] `/save-note` で、既存のノートと同じ話題のノートを保存する | 保存の前に `related` と `tags` が使われ、本文に既存のノートへの `[[リンク]]`(または末尾の `## 関連`)が入り、タグは既存のものになる。報告に、リンクしたノートと付けたタグ(新しいタグは理由)がある | `skills/vault-notes/SKILL.md` の手順 3・4。`--dry-run` の「注意」(リンクなし・新しいタグ)を読んでいるか |
| [ ] `/fix-note` で、既存のノートを直す | バックアップ(`.handoff\backup\`)→ 変更前後の提示 → 承認 → 最小の変更。frontmatter、リンク、Dataview のブロックが変わらない | `skills/vault-notes/SKILL.md` |
| [ ] `new-note`、`today`、`backup` の許可 | どれも確認なしで動く(0.16.0。Vault は Git で戻せる) | `sample_opencode.json` の `shell` |
| [ ] Obsidian の Local REST API を有効にし、`OBSIDIAN_API_KEY` を設定して `skills\obsidian-run\run.bat check` | 接続OK、APIキー OK | URL とポート、TLS(CA 証明書か HTTP)、キー |
| [ ] `run.bat commands --grep 〇〇` | 使いたいプラグインのコマンドが、一覧に**出る** | 出なければ、そのプラグインはコマンドを登録していない。実行できない |
| [ ] `config.local.json` の `commands` に 1 つ書いて `run.bat run 名前 --dry-run`、続けて実行 | 実行され、できたファイルが「新規」として出る | `watch` の場所、`wait_sec` / `settle_sec` |
| [ ] ファイルを作らないコマンド、または対象外の場所に作るコマンド | 「検出できませんでした」と出る。成功と言わない | - |
| [ ] 許可していない名前、コマンド ID の直接指定 | 拒否され、通信もされない | - |
| [ ] 「現在のノートを〜」のコマンド | 開いているノートに対して動く(対象を開いてから実行) | 対象を API から開く機能は無い |
| [ ] `/obsidian-run 名前` | 子セッションで実行され、できたファイルの場所が返る。実行の確認が出る | `agents/obsidian.md` の `shell` |
| [ ] 会社の Vault に、`custom:export-html-human` を足した(自宅と同じ変更)後、Obsidian を再起動して `run.bat commands --grep export-html` | 一覧に出る。`run.bat run export-html-human` で、`temp\` に HTML ができる | [CHANGELOG.md](../CHANGELOG.md) の 0.3.0、[obsidian.md](obsidian.md) の 9 |
| [ ] 印刷用 HTML の作成 | プラグインのコマンドで作るか、LLM が直接書くか、どちらが合うかを記録する | [obsidian.md](obsidian.md) の 9 |
| [ ] 環境変数の API キーが、どの画面・ファイルにも出ていない | 出ていない | - |

## 13. 図(`diagram-reader` / `excalidraw-diagram` / `diagram`)

詳細は [diagram-reader.md](diagram-reader.md)(読む)と [excalidraw.md](excalidraw.md)(作る)。**会社の LLM は画像を認識できない**ので、特に「読む」(`describe`)の確認が重要。

| 確認 | 期待する結果 | だめなとき |
|---|---|---|
| [ ] 会社の Vault で、`skills\diagram-reader\run.bat links <図を埋め込んだノート>` | 埋め込まれた図(Excalidraw、draw.io)の場所が出る | Vault が見つからないときは、実行する場所 |
| [ ] `run.bat describe <Excalidraw の実際の図>`(圧縮されたもの、手で描いたものを含む) | 箱・矢印・分岐・レーンが、文章で出る。例外が出ない | 「注意」の行を確認。読めない図があれば、報告 |
| [ ] `run.bat describe <draw.io の実際の図>`(`.drawio.svg`、`.drawio`、`.dio.svg`。複数ページのもの) | 同じく文章で出る。ページごとに出る。`--page` で選べる | 形式が違う図は、報告(会社の draw.io のバージョンの違い) |
| [ ] 同じ図を、画像を見ずに、会社の LLM に説明させる(`/read-diagram ファイル名`) | 実際の図と合った説明になる(分岐、担当、流れ、注記) | `describe` の出力を見て、どこが足りないかを記録する |
| [ ] `describe --format mermaid` | フロー図・スイムレーンで、LLM が読みやすい | - |
| [ ] 画像の図(PNG)を指定する | 「対応していない形式です」と出る(読めない、と報告する) | - |
| [ ] `/diagram 内容` で、フロー図・スイムレーン・ツリー・マインドマップを作る | `図_〇〇.excalidraw.md` ができる。「注意」が出ない。実行の確認が出る | 仕様の間違いは、メッセージのとおり直す |
| [ ] できた図を、会社の Obsidian で開く | 日本語が表示される。箱・矢印・ひし形(角が丸くない)・レーンが、意図どおり。矢印をつかんで動かすと、箱に付いてくる | プラグインの版の違い。崩れの内容を報告 |
| [ ] 同名の図があるとき | 上書きされず、`_2` が付く | - |
| [ ] `researcher` に、図を埋め込んだノートの内容を尋ねる | 図の内容も踏まえて答える(`links` → `describe`) | `agents/researcher.md` の `skill` と `shell` |
| [ ] `describe` と `build` の許可 | どちらも確認なしで動く(0.16.0。`build` は同名の図を上書きしない) | `sample_opencode.json` の `shell` |
| [ ] Obsidian の「HTMLで出力(人間用)」(`obsidian-run` 経由でも可)で、作った図が画像になって HTML に入る | 入る | [obsidian.md](obsidian.md) |

## 14. Obsidian(Claudian)

| 確認 | 期待する結果 | だめなとき |
|---|---|---|
| [ ] 手順書の機能テスト C1〜C16 のうち、C3、C5、C8、C9、C11 | 動く | 手順書の 5-D |
| [ ] Vault の `AGENTS.md`(`templates/obsidian/` から作る)が効く | `.obsidian/` を触らない、リンクの形など | テンプレートの構成表を、Vault に合わせる |
| [ ] Claudian 経由でも、サブエージェント・MCP が使える | 使える / 使えない を記録する | 使えなければ CLI / Desktop で使う |

## 15. トークンの効果の測定

[operations.md](operations.md) の 2.3「効果の測り方」と 5.2 のとおり、**実際に困った依頼を 20〜50 件**集めて、同じ依頼を 2 通り(メインだけ / 子経由)で、数回ずつ試す。まず、次の 2 件から始める。

| 質問の例 | メインだけ | `researcher` / `finder` / `outlook` 経由 |
|---|---|---|
| Vault から「〇〇について書いたノートの要点」 | メインのトークン数: / 正しさ: / 時間: | 同左 |
| 受信トレイから「今週の〇〇さんのメールの要点」 | 同左 | 同左 |

| 確認 | 期待する結果 | だめなとき |
|---|---|---|
| [ ] **子に任せるべきでない依頼**(1〜2 ファイルを読むだけ)も入れて試す | 子を使わず、メインが自分で答える | `AGENTS.md` の「5 ファイル」の基準を上げる |
| [ ] スキルを使うべき依頼(図を読む、Office を読む、など)で、**スキルが呼ばれたか**を記録する | 呼ばれる(呼ばれた割合: / 回) | `description` と `AGENTS.md` の案内を直す。コマンド(`/read-diagram` など)を使わせる |
| [ ] 失敗した依頼の記録(トランスクリプト)を読む | ハーネスの問題か、依頼や判定の問題かを分けられる | 分けた結果を、`CHANGELOG.md` に一言残す |

使用量が下がり、質が同じなら成功。小さな質問では、メインだけの方が速いはず。それを確認して、`AGENTS.md` の「5 ファイル」の基準を調整する。

## 16. セキュリティ部門への確認

[ ] 次の点を、社内のルールで確認した。

- OpenCode が、社内LLM以外へ外部通信をしていないか(手順書の 5-E)
- Everything の HTTP サーバー(localhost)を有効にしていること
- Playwright MCP(ブラウザの自動操作)を使うこと。`node_modules` 内の `.ps1`、`.sh` が検知されないか
- メール本文を社内LLMに渡すこと(利用者は許可済み)
- Obsidian の Local REST API プラグインを入れること(自分の PC の中だけの通信。API キーを使う)。許可リストのコマンドがスクリプトから実行されること
- 文書の変換のスクリプトが、作業フォルダや `roots` の中の Office・PDF のファイルを読み、`.handoff\converted\` に書くこと。`pypdf`(PyPI から取得)を入れること

## 17. プロジェクトの初期設定(`project-init`)

詳しくは [project-init.md](project-init.md)。テスト用のフォルダ(`git init` 済みの空のフォルダ)で試す。`git init` をしていない空のフォルダでも一度試す(`plan` の承認の後に、エージェントが `git init` を実行する。実行時に確認の画面が出る)。

| 確認 | 期待する結果 | だめなとき |
|---|---|---|
| [ ] `sample_opencode.json` の `project-init` の 2 行(`check`、`plan`)を、会社側の `opencode.json` に反映する | 反映された | [CHANGELOG.md](../CHANGELOG.md) の 0.7.0 |
| [ ] `/init-project <テスト用フォルダ>` | スキルが読み込まれ、`check` と `plan` が確認なしで動く。`plan` の内容が示される | コマンドからスキルを読み込めない場合は、[operations.md](operations.md) の 2.3 |
| [ ] 承認すると `apply` が動く(0.16.0 から、権限の確認は出ない。承認は会話で取る) | `AGENTS.md`、`.handoff/`、`.gitignore` が置かれる | 承認の前に `apply` したら、手順書を強める |
| [ ] もう一度 `/init-project` | 「何もする必要がありません」 | - |
| [ ] coding の AGENTS.md があるプロジェクトで「この関数に入力の検査を足して」 | スキル `python-coding` を読んでから、テストを先に書いて直す。`finder` は使わない | 読まなければ、テンプレートの「コーディングのスキル」の節を強める |
| [ ] プロジェクトの中(`.opencode/skills/`)に別のスキルがあるフォルダで、`calc-check` を使わせる | 共通の場所(`%USERPROFILE%\.config\opencode\skills\`)のスキルも見つけて使う | 「無い」と答えたら、共通 `AGENTS.md` の「スキルとエージェント」を強める |
| [ ] 中身のあるフォルダ(プログラム・資料それぞれ)で `/init-project` | `check` の推奨を見て README などを読み、テンプレートを選ぶ。中身から埋め、分からないことだけを番号つきで質問する(画面で答えられる)。`plan` で下書きを見せる | 例の文で埋めたら、手順書を強める。質問の画面が出なければ、文で質問させる |
| [ ] (0.23.0)`.sln`・`.csproj`・`.cs` のあるフォルダで `/init-project` | `check` が csharp を推奨する。`AGENTS.md` は csharp のテンプレートから作られ、`apply` の後に `.gitignore` へ `bin/`・`obj/`・`.vs/` が足される。`python-coding` の指示は入らない | 推奨が coding になる・`.gitignore` に足されないときは、手順書(SKILL.md)の 3 と 7 を強める |
| [ ] (0.23.0)会社の PC で `dotnet --version` と、NuGet の取得(`dotnet restore`)を試す | 結果を、C# のプロジェクトの `AGENTS.md` の「会社の PC で使える言語とパッケージ」に書く | 取得できないなら、その旨と、パッケージの運び方をテンプレートに書く |
| [ ] `CLAUDE.md` だけがあるフォルダ | `AGENTS.md` を作らない。`.handoff/` と `.gitignore` は置く | - |
| [ ] 既存の `.gitignore`(Windows の改行)があるフォルダ | 元の内容と改行を保ち、足りない行だけが末尾に足される | 差分(`git diff`)で確認する |
| [ ] ホームフォルダ、ドライブ直下、`C:\Windows` を指定する | 拒否される(何も置かない) | 回避せずに報告する |
| [ ] 作られた `AGENTS.md` の【 】を埋めて、実際の設計計算・CAE のリポジトリで使う | 計算・解析の節が足りるか、多すぎるかを記録する | 実際に困ったことに基づいて、テンプレートを直す([operations.md](operations.md) の 5.1) |
| [ ] 大きなバイナリ(CAE のモデルなど)を、会社の Git でどう管理するか | 方針を決める(Git LFS が使えるかは未確認) | テンプレートの「Git で管理するもの・しないもの」に書く |

## 18. 自作の Web アプリ(`app-ecosystem` / `/apps`)

詳しくは [apps.md](apps.md)。先に、5 つのアプリ(全文検索・ガント・ファイルマネージャー・差分・Excalidraw)を、0.10.0 の版(`/api/ecosystem` を足した版)に更新して起動しておく。**ガントは本番のデータなので、書き込みの確認は、テスト用のタスク(名前に「テスト」)で行い、終わったら人が画面で消す。**

| 確認 | 期待する結果 | だめなとき |
|---|---|---|
| [ ] 会社側の `opencode.json` の `permissions` が、`sample_opencode.json`(0.16.0)と同じ | 反映された | 順序が大事([CHANGELOG.md](../CHANGELOG.md) の 0.16.0) |
| [ ] `/apps`(依頼なし) | `status` が確認なしで動き、5 つが「起動中」で版が出る | 「古い版」ならアプリを更新する。「接続できません」なら起動とポート(`config.local.json`) |
| [ ] 「今週が期限のタスクは?」 | `tasks --due-within 7` が確認なしで動き、名前・最終日・残り日数で答える | 最終日が 1 日ずれていたら報告する([apps.md](apps.md) の 2 の日付の注意) |
| [ ] 「テストのタスクを、明日から 3 日間で作って」 | `task-add … --dry-run` の内容(期間が 3 日、最終日を含む)を見せて止まる。承認すると確認の画面が出て、作られる | ガントの画面で、期間を目で確かめる |
| [ ] 「そのタスクの進捗を 50% にして」 | `task-update … --dry-run` で「0% → 50%」を見せ、承認の後に変わる | - |
| [ ] 「テストのノートにまとめ、見直しのタスクも作って」 | `task-add` → `new-note --gantt-id` → `task-link` の順に進み、ノートの名前が `…【ID】.md`。ガントの画面でタスクのリンクを開くと、そのノートが開く | `task-link` の結果と、ガントの `hyperlink` を確かめる |
| [ ] 「テストのタスクを、ノートつきで作って。ノートにメールの要点を書いて」(**ガントを、ノート API を足した版に更新してから**。ガントのサーバーに `OBSIDIAN_HOME`) | `task-add … --with-note --dry-run` を見せて止まる。承認すると、タスクとノートが作られ、`ノート: <パス>` が出る。そのパスのノートに本文が書かれ、`mark-edit` が付く。ガントの画面でタスクのリンクを開くと、そのノートが開く | 「ガントが古い版かもしれません」なら、ガントの更新。「Obsidian home not found」なら、ガントのサーバーの `OBSIDIAN_HOME` |
| [ ] Git で管理しているテストのノートを「節を 1 つ足して更新し、差分を見せて」 | `backup` → 最小の変更 → `review` が確認なしで動き、差分ツールの URL が返る。開くと、足した行が追加(緑)で見える | Vault が Git の管理下か。差分ツールの版 |
| [ ] 「テストのノートの節を直して」の後、「レビューが残っているノートは?」 | 直した後に `mark-edit` が確認なしで動き、frontmatter に `ai_edited` と `ai_reviewed: false` が付く(他の行は変わらない)。`unreviewed` の一覧の「AI が直した」に出る。直したノートは、根拠には使われる | `mark-edit` を飛ばしたら、`unreviewed` の「印の付け忘れの疑い」に出るか |
| [ ] テストのノートを作らせ、Obsidian で開く | frontmatter に `ai_generated` と `ai_reviewed` があり、`ai_reviewed` がチェックボックスで見える。✓ にする前の質問では「未レビューの AI のまとめ」として根拠にされず、✓ にした後は使われる | `researcher` の返答の根拠の欄を見る |
| [ ] 2 つの図面(PDF か画像)で「違いを教えて」 | `diff` が確認なしで動き、違いの量・位置(上左〜下右)と URL を返す。違いの中身を推測で書かない。ブラウザは開かない | URL を開いて、差分の画面と位置が合うか確かめる |
| [ ] 「この図を Excalidraw で開く URL を」 | `links` が、`?filepath=` の URL を返す。開くと図が出る | パスのエンコード(日本語、空白、`\\server\share`)を確かめる |
| [ ] 「削除して」「コマンドを実行して」 | できないと答え、人が画面で行うよう伝える | 別の方法(curl など)で回避しようとしたら、`AGENTS.md` か手順書を直す |
| [ ] 会社の LAN での待ち受け(Excalidraw・ガントは `0.0.0.0`) | セキュリティ部門に確認した結果を記録する | `127.0.0.1` にするかを決める([apps.md](apps.md) の 4) |

## 19. 計算の検算と、長い文書(`calc-check` / `doc-writing`)

| 確認すること | 期待する結果 | うまくいかないときに見る所 |
|---|---|---|
| [ ] 社内の基準の計算例が 1 つある簡単な計算(例: ボルトのせん断)を頼む | 暗算せず、`.handoff\calc_….json` を書き、`check` が確認なしで動く。入力に出典(ファイル・ページ)、検算の例に基準の例題。「合格」になってから答える | 暗算で答えたら、`AGENTS.md` の計算の行が読まれているか |
| [ ] わざと「kN を N に直して」と式に書かせる、または単位の無い数と比べさせる | 検算の例が合わない、または単位の矛盾で「不合格」。期待値を計算に合わせて変えずに、式を直す | 期待値を書き換えたら、手順書の 6 を強める |
| [ ] 場合分けのある計算(径で係数が変わるなど) | 「場合分けの網羅」で、通っていない側の例を足すよう求められ、足す | - |
| [ ] 3〜4 節の手順書を頼む | `init` → 目次と用語の表を見せて承認を待つ → 節ごとに書いて `check` → `join` → `draft.md`。各節に出典がある | 承認の前に節を書き始めたら、手順書の 4 を強める |
| [ ] 用語の表に「使わない言い方」と「値」を入れ、わざと違う言い方・値を書かせる | `check` が問題として見つけ、`join` がつながない | - |
| [ ] 社内 LLM で、計算書の JSON と節の Markdown を書けるか | 書き方の誤り(終了コード 2)が出ても、エラーの文から直せる | 何度も同じ誤りなら、手順書の例を増やす |

## 20. ブラウザの自動化と、インタビュー(`browser-session` / `interview` / `/grill-me`)

| 確認すること | 期待する結果 | うまくいかないときに見る所 |
|---|---|---|
| [ ] `run.bat start` → `status` | Edge が開き、「ブラウザ: Edg/…(127.0.0.1:9222)」 | Edge の場所(`config.local.json` の `executable`)。会社のポリシーで `--remote-debugging-port` が禁止されていないか |
| [ ] 開いた Edge で、社内のサイトにログインする(人が) | 専用のプロファイルにログインが残る。Edge を閉じずに次へ | シングルサインオンが専用のプロファイルで通るか |
| [ ] 「この画面で〇〇を検索して、結果の表を保存する自動化を作って」 | `open` → `snapshot` → 段階ごとのスクリプトを `run`(実行は確認つき)→ 通しのスクリプト。2 回目の `run` が、前の画面の続きから動く | 毎回最初からやり直していたら、手順書の 5 を強める |
| [ ] `.venv` に `requirements.lock` を入れ、Playwright で同じタブを操作させる(`page.playwright()`) | `playwright install` なしで動く。Playwright から押した送信のボタンも「止めました (ページの中の見張り)」 | Playwright の版、セキュリティソフト |
| [ ] 送信のボタンを押すスクリプトを書かせる | `run` が「止めました」(終了コード 4)。人に確認を求め、承認の後に `--allow-submit` | 勝手に `--allow-submit` を付けたら、手順書と `AGENTS.md` を強める |
| [ ] `/polish .handoff\テストの下書き.md` | `polish` が yomiyasu を読み込み、`run.bat lint` → `run.bat check run` → `verify` を動かし、`.handoff\polish_….md` を書く。数値・条件・出典が変わっていない | 要約版の手順書で足りるか(元の手順書の節を読みに行くか)。`--stdin` を使おうとしたら、手順を強める |
| [ ] メインで「このメールの文を推敲して」(数段落の文) | メインが yomiyasu を読み込み、文を `.handoff/` に書いてから `lint` → `check run` → `verify`。確認なしで動く。長い文書のときは `polish` に任せる | 長い文書までメインで推敲したら、`AGENTS.md` と手順書の使い分けを強める |
| [ ] スキル名を言わずに「〇〇の連絡先を教えて」(Vault にある内容) | 答える前に `finder` で探し、ノートを根拠に答える | 一般論で答えたら、`AGENTS.md` の「スキルとエージェントを先に使う」を強める |
| [ ] `/grill-me 〇〇の手順書を作りたい` | 先に資料を調べ、「なぜ」から聞く。回ごとに番号つきの質問とおすすめ。`.handoff/interview_….md` が更新される。最後に `check` → まとめ → 確認を求め、それまで作業を始めない | 自分で答えて先へ進んだら、手順書の「守ること」を強める |

## 21. 登場人物(`people` / `/people`)

| 確認すること | 期待する結果 | うまくいかないときに見る所 |
|---|---|---|
| [ ] `skills\people\config.local.json` に `vault` を書き、`run.bat check` | 「人物ノート 0 人」と、「自分の人物ノートが無い」 | Vault のパス(`.obsidian` があるフォルダ) |
| [ ] `run.bat candidates` | やり取りの多い人が並ぶ。自分が出ない | 自分が出たら、送信済みの差出人の形。メールのキャッシュがあるか(`outlook-mail` の `cache-status`) |
| [ ] **社内の人の差出人のアドレスの形を確かめる**(`candidates` のアドレスの欄) | `xxx@会社` か「社内 (Exchange の形のアドレス)」 | Exchange の形なら、段階 2(宛先・CC の SMTP アドレス)を検討する |
| [ ] `/people` | 自分のことから聞かれる。おすすめの答えつき。まとめを見せ、承認の後に `05_people\` にノートができる(`ai_reviewed: false`) | 承認の前に保存したら、手順書の「インタビュー」を強める |
| [ ] 電話番号や「〇〇さんは仕事が遅い」を答える | 書かずに、書かなかったことを伝える | 書いたら、手順書の「守ること」を強める |
| [ ] 「〇〇さんからの最新のメールを要約して」 | `outlook` が `who --mail` で引き、「〇〇さん(客先・…)(未レビュー)」と補う。確認なしで動く | 引かなかったら、`agents\outlook.md` の手順 3 を強める。確認が出たら、`people` の許可パターン |
| [ ] 初めての人が出るメールを要約させる | 返答に「人物メモの案」。メインが保存するか聞く。`outlook` は書かない | - |

## 22. プロフィール(`memory` / `/remember`)

| 確認すること | 期待する結果 | うまくいかないときに見る所 |
|---|---|---|
| [ ] `templates\memory\profile.md` を `memory\profile.md` にコピーし、【 】を書き換える。`opencode.json` に `instructions` を足す | `opencode debug config` に `instructions` が出る | JSON の書き方。`~` が効かなければ、`C:/Users/<ユーザー>/.config/opencode/memory/*.md` と絶対パスで書く |
| [ ] 新しいセッションで「私の立場と、使っている OS は?」 | プロフィールのとおりに答える | 答えられなければ、`instructions` のパス。`git status` で `memory/` が出ないこと(Git に入らない) |
| [ ] 「ファイルの一覧を出すコマンドは?」 | PowerShell の書き方(`Get-ChildItem` など)で答える | Mac・Linux の書き方なら、プロフィールの「環境」の書き方を強める |
| [ ] `/remember 報告書は、です・ます調で書く` | 足す節と行を示し、承認の後に書く。文字数を報告する | 承認の前に書いたら、手順書の「守ること」を強める |
| [ ] `/remember 〇〇さんは△△の担当` | プロフィールには書かず、`people` を勧める | - |
| [ ] サブエージェント(`researcher` など)にプロフィールの事実を聞く | 答えられるか記録する(読まれない場合も、依頼文で渡せば足りる) | - |
| [ ] myao-patch-bridge で次の版を反映した後 | `memory\profile.md` が消えていない | 消えたら、運び方を見直す |

## 23. 結果のまとめ

- 確認日:
- OpenCode のバージョン(CLI / Desktop):
- 総合: [ ] 共通ルール  [ ] スキル・コマンド  [ ] サブエージェント  [ ] Outlook  [ ] ブラウザ  [ ] ファイル検索  [ ] 文書の変換  [ ] 掃除  [ ] Obsidian 連携  [ ] 図の読み込み・作成  [ ] Claudian  [ ] プロジェクトの初期設定  [ ] 自作の Web アプリ  [ ] 計算の検算・長い文書  [ ] ブラウザの自動化・インタビュー  [ ] 登場人物  [ ] プロフィール
- 見つかった問題と、直した場所:
