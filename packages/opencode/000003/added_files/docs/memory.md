# 利用者のプロフィールを覚える仕組み(`memory`)

0.28.0 で入れた。

## 結論

- 「Windows である」「自分の立場」のような、**毎回前提にしたい短い事実**を、プロフィール `memory/profile.md` に書く。
- 設定の `instructions` で、プロフィールを**すべてのセッションの最初に読み込ませる**。検索して思い出す方式ではないので、必ず効く。
- 書き足し・削除は `/remember`(スキル `memory`)で行う。AI は案を示し、**利用者の承認の後に**書く。AI が自分の判断では書かない。人が手で直してもよい。
- 他人のことは、人物ノート(スキル `people`、[people.md](people.md))へ。プロフィールには書かない。

## 置き場所と設定

| もの | 場所 | Git |
|---|---|---|
| プロフィール | `%USERPROFILE%\.config\opencode\memory\profile.md`(会社の PC だけ) | 入れない(`.gitignore` の `/memory/`。会社の情報を個人の GitHub に入れないため) |
| ひな形 | `templates/memory/profile.md` | 入れる |
| 読み込みの設定 | 会社の `opencode.json` の `"instructions": ["~/.config/opencode/memory/*.md"]`(雛形は `sample_opencode.json`) | 雛形だけ |

- `instructions` は、OpenCode の設定のキー(「追加の指示ファイル」)。V1 からある。
- **v2.2.6(Mac)で、`~` と `*` が展開されることを確かめた**(2026-11-12。一時的なホームにダミーのプロフィールを置き、無料モデルに合言葉を答えさせた)。会社の Windows で `~` が効かなければ、`C:/Users/<ユーザー>/.config/opencode/memory/*.md` と書く。
- `memory/` に置いた `.md` は全部読まれる。分けたいときは、ファイルを足してよい(合計の大きさに注意)。

## 大きさ

- **2,000 文字以内**(毎回読まれるため。窓は約 13 万トークン)。スキル `memory` は、超えるときに消す・まとめる案も出す。雛形の大きさはテストが検査する(会社のプロフィールは Git の外なので検査しない)。
- 1 行 1 事実。経歴などの詳しいことは、`people` の自分の人物ノートに置く。

## 書くこと・書かないこと

- 書く: 環境(Windows 11、PowerShell、パスの形、ネット不可、`.venv`)、立場(所属、役割、担当、決められる範囲)、書き方の好み、よく使う場所。
- 書かない: パスワード・API キー・トークン、私的な連絡先・住所、私生活のこと、他人のこと。

## opencode-mem を採らなかった理由(2026-11-12)

[opencode-mem](https://github.com/tickernelz/opencode-mem)(v2.42.0、MIT。OpenCode のプラグイン。V2・Windows 対応)を、README と package.json で調べた。よくできているが、会社の環境と次の点がぶつかる。

1. 導入は npm 経由(`"plugins": ["opencode-mem@latest"]`)。会社は npm で取得できない。同梱するなら、ネイティブの部品(`onnxruntime-node`、`@tursodatabase/database`)の Windows 用を自宅で揃える必要がある。
2. 埋め込みモデルを、初回に Hugging Face から取得する(オフラインでは動かない)。メモリを 0.5〜2 GB 使う。社内に埋め込みの API があるかは不明。
3. 自動の記録(既定で有効)が、裏で LLM を呼び、構造化出力を要る。社内のモデルが対応するかは未確認。誤った記憶が、確認なしに溜まる。
4. Web UI(127.0.0.1:4747)と自動更新がある。Windows では、複数のセッション(CLI・Desktop・Claudian)が同じデータベースを共有できない。
5. 検索で関係しそうな記憶を出す方式なので、「いつも効かせたい事実」には、毎回読まれるファイルのほうが確実。

**見直す条件:** 「過去の作業や会話を、大量に検索して思い出させたい」需要が出たとき。そのときは、オフラインで揃うか(埋め込みを社内の API にできるか)、自動の記録を止められるか、から確かめる。

## 確かめていないこと

- 会社の Windows で `instructions` が読まれるか(`~` の展開を含む)。
- 子セッション(サブエージェント)にもプロフィールが読まれるか。読まれなくても、子への依頼文に要る事実を書く決まり(共通 `AGENTS.md`)で足りる。
- myao-patch-bridge で反映したときに、Git の外の `memory/` が消えないか(`opencode.json` と同じ扱いのはず)。
- 実際のモデルが、`/remember` で承認の前に書かないか。

会社での確認は [company-checklist.md](company-checklist.md) の 22。
