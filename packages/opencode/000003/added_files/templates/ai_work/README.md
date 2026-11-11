# AI_work のテンプレート

Local-fulltext-search のランチャー(OpenCode ペイン)から、日本語の指示で自動化を動かすためのフォルダ `AI_work` のひな形。自動化(Outlook の予定の作成、Web の勤怠入力など)は、ここで AI と一緒に作り、`/コマンド 指示` で動かす。

- 1 つの自動化 = `.opencode/skills/<名前>/` のスキル 1 つ(手順の `SKILL.md` + Python のスクリプト + テスト)
- Web の操作はハーネスの `browser-session`、Outlook は `outlook-mail` を通す(送信・申請などは、見張りが止め、人の返事の後に実行する)
- ランチャーのコマンドは、プロンプトの定型。中身は「このスキルを読み込んで、その手順で実行して。指示: …」

## 入っているもの

| ファイル | 役割 |
|---|---|
| `AGENTS.md` | AI_work で AI が守ること(使う・作るの見分け、取り消せない操作の前で止まる、など) |
| `自動化一覧.md` | 自動化の目次と、作りたいものの候補 |
| `launcher_slash_commands.sample.json` | ランチャーに登録するコマンド 5 つ(`/auto`、`/auto-new`、`/auto-fix`、`/auto-list`、`/env-check`) |
| `.opencode/skills/automation-builder/` | 自動化を作る・直す手順と、ひな形を置くスクリプト(`new`・`list`・`slash`) |
| `.opencode/skills/env-check/` | 動作確認と今日の日付。自動化の見本 |
| `.opencode/commands/` | OpenCode の画面(TUI)で使う `/auto`・`/auto-new`・`/auto-fix` |
| `.gitignore` | `config.local.json`、`.venv/`、`.handoff/`、`output/` を Git に入れない |
| `requirements.in` | 自動化で使う Python のパッケージ(最初は空) |
| `README.md` | このファイル |

## 置き方(会社の Windows。人が行う)

1. AI_work の場所を確かめる。ランチャーの OpenCode ペインの ☰ メニュー、または設定の「opencode 実行フォルダ」。既定は `%USERPROFILE%\000_work\AI_work`。
2. テンプレートを写す。**既にあるファイルは上書きしない**ように、robocopy で新しいファイルだけを写す(終了コード 0〜3 は成功)。

   ```powershell
   $src = "$env:USERPROFILE\.config\opencode\templates\ai_work"
   $dst = "$env:USERPROFILE\000_work\AI_work"
   robocopy $src $dst /E /XC /XN /XO
   ```

   AI_work に `AGENTS.md` が既にあるときは写されない。中身を見比べて、手で足す。
3. `AGENTS.md` の先頭のコメント(`<!-- … -->`)を消す(残しても動く)。
4. ランチャーにコマンドを登録する。どちらか。
   - 画面で: OpenCode ペインの「/ コマンド」で、`launcher_slash_commands.sample.json` の 1 件ずつ(名前・説明・プロンプト)を登録する。
   - ファイルで: Local-fulltext-search の `backend\data\launcher_slash_commands.json` が**無いときだけ**、sample をその名前で写す(あると、登録済みのコマンド(`/pass` など)が消える)。ランチャーは、表示のたびに読み直す。
5. ランチャーで `/env-check` を送る。今日の日付と、`AGENTS.md あり`、`browser-session: あり`、`outlook-mail: あり` が出れば、流れが通っている。
6. (勧める)AI_work を Git で管理する。自動化を直したときに、前の形へ戻せる。

   ```powershell
   cd $dst
   git init
   git add .
   git commit -m "AI_work のテンプレートを置いた"
   ```

## 使い方

| したいこと | ランチャーで |
|---|---|
| 新しい自動化を作る | `/auto-new 勤怠システムに出勤と退勤を入れたい`(聞き取り → 案 → 承認 → ひな形 → 中身 → 確認) |
| 自動化を動かす | `/auto 明日 10 時から設計レビューを予定に入れて`、または作った自動化のコマンド(`/kintai 今日 9:00-18:00`) |
| 直す | `/auto-fix kintai-input 申請の画面で止まる` |
| 一覧 | `/auto-list` |

- 自動化を作り終えると、AI がランチャーに登録するコマンド(名前・説明・プロンプト)を示す。**登録は人が「/ コマンド」で行う。**
- 自動化ごとの個人の設定(URL、社員番号など)は、`.opencode\skills\<名前>\config.local.json` に人が書く(`config.sample.json` を写す)。パスワードは書かない。ログインは、自動化用のブラウザで人が行う。
- 送信・申請・予定の作成の前で、AI は止まって内容を示す。「実行して」と返事をすると進む。

## 前提と、確かめていないこと

- ハーネス(`%USERPROFILE%\.config\opencode`)が置かれ、`browser-session`・`outlook-mail` が動くこと。
- OpenCode は、作業フォルダの `.opencode/skills/` と `.opencode/commands/` を読む(公式の説明による)。**会社の Windows で、ランチャーから `.opencode/skills/` のスキルが読まれるかは、確かめていない**(`/env-check` で確かめる)。
- ランチャーの「自動承認」を切っているとき、`opencode run` で許可が要る操作(`outlook-mail` の `cal-create` など)がどう扱われるかは、確かめていない。止まるなら、AI の確認(「実行して」の返事)の後に、自動承認を入れて送り直す。
