---
name: automation-builder
description: AI_work に自動化(スキル + Python)を作る・直す・一覧にする手順。「〜を自動化したい」「自動化が動かない」と頼まれたとき、どの自動化を使うか迷うときに使う
---

## 前提

- 自動化 1 つ = スキル 1 つ(`.opencode/skills/<名前>/`)。ひな形を置くのと一覧は、このスキルのスクリプトで行う。作業フォルダ(AI_work)で実行する。
  - 実行用: `<このスキルのフォルダ>\run.bat`(Mac・Linux は `run.sh`。引数は同じ)
  - 本体: `<このスキルのフォルダ>\scripts\new_automation.py`(標準ライブラリだけ。上書き・削除をしない)
- 種類は 3 つ。迷ったら、画面を操作するなら `browser`、Outlook なら `outlook`、それ以外は `python`。

| 種類 | 向いているもの | 置かれるもの |
|---|---|---|
| `python` | ファイル・表の処理、計算、文書や報告の作成 | `scripts/main.py`、`tests/test_main.py` |
| `browser` | Web の画面の操作(勤怠、社内システムへの入力・取り込み) | `scripts/flow.py`(スキル `browser-session` の `run` の中で動く) |
| `outlook` | Outlook の予定の作成、メールからの取り出し | `scripts/main.py`(予定の案を作る)。作成はスキル `outlook-mail` |

どれにも `SKILL.md`、`run.bat`、`run.sh`、`config.sample.json` が付く。

## 使う(どの自動化か迷うとき)

1. `run.bat list` で、自動化の一覧と説明を見る。
2. 合うものを `skill` で読み込み、その「手順」どおりに動かす。
3. 合うものが無ければ「自動化はまだ無い」と答え、今回だけ手で行うか、自動化を作るかを聞く。

## 作る

1. **聞き取る。** 何を(入力 → 結果)、どこで(サイト・アプリ・ファイル)、どれくらいの頻度で、**取り消せない操作はどれか**、うまくいったことをどう確かめるか、入力が無いときの既定値。人に、いまの手作業を 1 回、順に説明してもらうのが早い。決まらないときは、スキル `interview`。
2. **案を示して、承認を得る。** 名前(英小文字・数字・ハイフン。例: `kintai-input`)、種類、入力の表、手順、取り消せない操作、ランチャーのコマンド名(短い英字。例: `kintai`)。
3. **ひな形を置く。**

   ```
   run.bat new kintai-input --title 勤怠入力 --kind browser --dry-run
   run.bat new kintai-input --title 勤怠入力 --kind browser
   ```

4. **中身を書く。**
   - `python`・`outlook`: Python を書く前に、スキル `python-coding` を読み込む。`build_plan`(何をするかを返すだけで、何も変えない)のテストを先に書き、実装する。日付は `date.today()` で取り、引数で渡す(テストで固定できるように)。テストは AI_work で `python -m unittest discover -s .opencode\skills\<名前>\tests`。
   - `browser`: スキル `browser-session` を読み込み、その手順で、`.handoff/browser/` に段階ごとのスクリプトを書いて試す(`start` → `open` → `snapshot` → 段階を `run`)。通しで動いたら `scripts/flow.py` にまとめる。**flow.py は、送信の直前まで進めて、何を送るかを print して終わる形にする**(送信のボタンは、承認の後に `--allow-submit` で押す)。
   - 取り消せない操作(送信、申請、予定の作成)を、自分のスクリプトで直接行わない(Outlook の COM、`requests` の POST、`sync_playwright()`)。ハーネスのスキルの道具を通す。
   - 設定が要るなら、`config.sample.json` に項目を足し、人に `config.local.json` を作ってもらう。パスワードは項目にしない。
5. **`SKILL.md` の【 】を埋める。** `description` は「いつ使うか」が分かる 1 文にする(モデルは、これを見て自動化を選ぶ)。入力の表の「無いとき」を必ず埋める(ランチャーから 1 回で動かすため)。
6. **通しで確かめる。** dry-run(browser は送信の直前まで)→ 人の承認 → 本番を 1 回。結果を `SKILL.md` の「確かめたこと」に書く。確かめられなかったことは「未確認」と書く。
7. **一覧を直す。** `自動化一覧.md` に 1 行足す。`run.bat list` で「要確認」が残っていないかを見る(`config.local.json` が無いのは、人が作るまで残ってよい)。
8. **ランチャーのコマンドを示す。** 出た JSON の名前・説明・プロンプトを、人がランチャーの「/ コマンド」で登録する(自分では登録しない)。

   ```
   run.bat slash kintai-input --command kintai --description 勤怠を入力
   ```

9. **報告する。** 置いたファイル、確かめたこと、確かめていないこと、人に頼むこと(`config.local.json`、ランチャーへの登録、ログイン)。Git で管理していれば、コミットを提案する。

## 直す

1. 症状を確かめる: どのコマンドで、どんなエラーが、どこまで進んで出たか。dry-run で再現する。
2. `browser` なら、`snapshot` で、画面が変わっていないか(ボタンの文字、入力欄の名前)を先に見る。社内システムの画面の変更が、止まる原因として多い。
3. 直す前に、何をどう変えるかを示す。テストがあれば、症状を再現するテストを先に足す。
4. 直したら、dry-run → 必要なら本番を 1 回。`SKILL.md` の「確かめたこと」と、`自動化一覧.md` の「最後に確かめた日」を直す。

## 守ること

- `new` は既存のフォルダに書かない。直すときは、ファイルを直接直す。
- 自動化を消すのは、人が行う(消したいと言われたら、消すフォルダと `自動化一覧.md` の行を示す)。
- ランチャーへの登録、`config.local.json` の作成、ログインは、人が行う。
- `.bat` には日本語を書かない(ASCII だけ)。
