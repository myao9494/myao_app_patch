---
name: create-subagent
description: サブエージェント(agents/)を作る・直す手順(要否の判断、最小の権限、返し方の定型)。作成や改修を頼まれたときに使う
---

## 前提

- サブエージェントのファイルは `agents/エージェント名.md` に置く。ファイル名がエージェント名になる。名前は英小文字とハイフンにする(例: `doc-checker`)。
- 結果の返し方の約束の原本は、同じフォルダの `handoff-block.md` にある。各エージェントのファイルには、その写しを入れる。
- 目的は、メインエージェントのコンテキストを節約しながら、良い答えを得ること。子セッションの中間の読み取りや検索の結果は、メインに入らない。メインに入るのは、返答だけ。

## 手順

1. **本当にサブエージェントが必要かを判断する。** 子セッションの起動には固定のコスト(システムプロンプトなどの読み込み)がかかる。次のどれかに当てはまるときだけ作る。
   - 5 つ以上のファイルや、長い文書を読む作業で、結果が要約で足りる
   - 互いに独立していて、並行して進められる調査
   - 権限を絞って、安全に任せたい作業

   1〜2 ファイルを読むだけの作業や、ユーザーと確認しながら進める作業は、メインが自分でやる。すでにあるエージェント(`researcher`: 調査、`reviewer`: レビュー、`outlook`: メール・予定、`browser`: Web ページ、`finder`: ファイル検索)で足りないかも、先に確認する。
2. **目的を 1 つに絞る。** 「何を調べて、何を返すか」を 1 文で書く。2 つ以上あるなら、エージェントを分ける。
3. **frontmatter を書く。**
   - `description`: 必須。「どんなときにメインがこのエージェントを呼ぶか」と「何を返すか」を書く。メインは、これを見て呼ぶかどうかを決める。
   - `mode: subagent`
   - `steps`: 繰り返しの上限。20〜25 を目安にする。上限に達すると、ツールが使えなくなり、まとめを書いて終わる。社内LLMが同じ操作を繰り返して、トークンを使い続けるのを防ぐ。
   - `permissions`: 必要最小限にする(下の「権限の雛形」を使う)。OpenCode V2 の書き方で、`action`・`resource`・`effect` の配列。**最後に一致したルールが勝つ**ので、広いルール(`"*"` の拒否)を先に、例外を後に書く。`permission:`・`bash:` は V1 の旧名なので使わない(1 つのファイルに新旧を混ぜない)。
4. **本文を書く。** 次の順にする。
   - 役割(1〜2 行)
   - 手順(番号つき。調べる順序、見る範囲)
   - 守ること(やってはいけないこと、確認できなかったときの扱い)
5. **返し方の約束を入れる。** `handoff-block.md` の中身を、本文の最後に、そのまま写す。
6. **動作を確認する。** 次のテストを順に行い、結果を報告する。確認できなかったものは、そう書く。
   - メインから呼ぶと、サブエージェントが動く。
   - 短い結果のとき、返答に直接書かれ、ファイルが作られない。
   - 長い結果のとき、`.handoff/` に指定の形のファイルができ、返答が「結論・根拠・確信度・未確認・詳細」の形になっている。
   - 禁止した操作(許可していないファイルの書き換えなど)が、拒否される。

## 権限の雛形

読み取り専用(調べて報告するだけのエージェント):

```
permissions:
  - action: edit
    resource: "*"
    effect: deny
  - action: edit
    resource: ".handoff/**"
    effect: allow
  - action: shell
    resource: "*"
    effect: deny
```

読み取り専用で、読み取りのコマンドだけ使う:

```
permissions:
  - action: edit
    resource: "*"
    effect: deny
  - action: edit
    resource: ".handoff/**"
    effect: allow
  - action: shell
    resource: "*"
    effect: deny
  - action: shell
    resource: "git status*"
    effect: allow
  - action: shell
    resource: "git diff*"
    effect: allow
  - action: shell
    resource: "git log*"
    effect: allow
```

スクリプトを使うエージェント(スキルと `run.bat` を入口にする。`outlook`、`finder` が例):

```
permissions:
  - action: edit
    resource: "*"
    effect: deny
  - action: edit
    resource: ".handoff/**"
    effect: allow
  - action: skill
    resource: "*"
    effect: deny
  - action: skill
    resource: "スキル名"
    effect: allow
  - action: shell
    resource: "*"
    effect: deny
  - action: shell
    resource: "*スキル名*run.bat*"
    effect: allow
  - action: shell
    resource: "*>*"
    effect: deny
```

`ask` にするのは、Git で戻せない・外に影響する書き込み(Outlook、本番のデータベース)だけ。Git で管理するファイルへの書き込み(図やノートを作る)は `allow` でよい。`ask` があるときは、順序を「読み取りの `allow` → 書き込みの `ask` → 試行の ` --dry-run` の `allow` → リダイレクト `*>*` の `deny`」にする(最後に一致したものが勝つ。例は `agents/outlook.md`)。理由:

- パターンは、コマンド全体のどこに一致してもよい。`ask` を先に書くと、後ろの `allow`(`*mail-list*` など)が、引数の値(件名やファイル名)に一致して、確認を打ち消す。
- ` --dry-run` は、前に空白を入れる。`*--dry-run*` だと、`案件--dry-run` のような値にも一致する。
- リダイレクト(`> ファイル`)は、許可したコマンドでも、どこにでも書けてしまう。子は `--out`(`.handoff/` の中だけ)で書く。
- 作ったら、`tests/test_harness.py` の `PermissionBehaviorTests` に、許可・確認・拒否になるべきコマンドを足す(判定を再現して確かめる)。

MCP を使うエージェント(`browser` が例): メインでは `action: "MCP名_*"`、`resource: "*"`、`effect: deny` にして、このエージェントだけが使えるようにする。このエージェントでは、先頭に同じ `action` の `effect: ask` を置き、そのあとに、読み取りのツールだけを `allow`、危険なツールを `deny` で書く(ツール名は `MCP名_ツール名`)。

ファイルを書き換えるエージェントは、原則として作らない。必要なときは、書き換える範囲を明確にして、人間に確認する。

## 守ること

- 返し方の約束の原本(`handoff-block.md`)を変えたときは、`agents/` の全ファイルの該当ブロックも同じ内容に直す。`結果の返し方` で検索して探す。
- 1 つのエージェントに、広い権限を与えない。
- 機密情報(キー、パスワード、個人情報)を、`.handoff/` に書かせない。
