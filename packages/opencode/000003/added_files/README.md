# opencode ハーネス

会社の PC の `C:\Users\<ユーザー>\.config\opencode\` にそのまま反映する、OpenCode(CLI / Desktop / Obsidian の Claudian)用のハーネスです。このリポジトリのルートが、`.config\opencode\` の中身に対応します。会社へは、myao-patch-bridge で運びます。

- 変更履歴と、会社で手で行うこと: [CHANGELOG.md](CHANGELOG.md)
- 会社での導入と確認の手順: [docs/company-checklist.md](docs/company-checklist.md)

## 1. コンセプト

**サブエージェントが、メインエージェントのコンテキストのトークンをできるだけ節約しながら、最善の回答を得る。**

- 節約の本体は、**子セッションが分離されていること**です。子が読んだファイルや検索結果は、メインに入りません。メインに入るのは、子の返答だけです。
- 子の返答は、「結論・根拠(パス:行)・確信度・未確認」を必ず含めます。短くしすぎて質が落ちるのを防ぎ、メインが根拠を開いて確かめられるようにするためです。長い結果だけ、`.handoff/` のファイルに書きます。
- 子の起動には固定のコストがあります。5 つ以上のファイルを読む調査や、メールなど文章量の多いものは子に任せ、1〜2 ファイルの読み取りはメインが自分でやります。
- 常に読み込まれるもの(共通 `AGENTS.md`、各部品の説明文)は、小さく保ちます。上限は整合性テストが検査します。
- MCP やスキルは、使うエージェントを絞ります。MCP のツール定義は、使えるエージェントのコンテキストに常に入るためです。

```
        ユーザー
           │
      メイン (AGENTS.md、判断、確認)
           │ 任せる             ▲ 結論・根拠・確信度・未確認 (長いときは .handoff/ のファイル)
   ┌───────┼────────┬──────────┬──────────┐
 researcher  outlook   browser    finder    obsidian  diagram  reviewer   ← 子セッション (読んだ量はメインに入らない)
   │           │         │          │
 スキル     スキル      MCP       スキル
 doc-convert outlook-mail playwright file-finder
   │           │                    │
 Word/Excel/  クラシック版      Local-fulltext-search
 PowerPoint/PDF  Outlook        / Everything
```

## 2. 構成

| パス | 役割 | OpenCode が読むか |
|---|---|---|
| `AGENTS.md` | 全セッションに効く共通ルール(約 2,500 文字。すべての作業に共通することだけ。使い分けの表などはプロジェクトの `AGENTS.md`) | 読む |
| `sample_opencode.json` | 設定のひな形。会社の `opencode.json` と見比べて、人間が反映する | 読まない(名前が違う) |
| `agents/` | サブエージェント(下の表) | 読む |
| `commands/` | スラッシュコマンド(下の表) | 読む |
| `skills/<名前>/` | 手順つきスキル(下の表)。入口は `run.bat`(Windows)と `run.sh`(Mac・Linux) | 読む |
| `mcp/` | MCP サーバーのコードと、同梱した依存(Playwright MCP の `node_modules` を含む。約 18 MB) | 読まない(設定で起動する) |
| `templates/project/coding/AGENTS.md`、`templates/project/csharp/AGENTS.md`、`templates/project/document/AGENTS.md` | プロジェクト用のひな形(coding: Python のプログラム・設計計算・CAE、csharp: C# (.NET) のプログラム、document: 手順書・報告書などの一般資料。Git 前提)。`/init-project` が各プロジェクトのルートへ置く(手でコピーしてもよい) | 読まない(置いた先で読まれる) |
| `templates/obsidian/AGENTS.md` | Obsidian 用のひな形。Vault のルートへコピーして書き換える | 読まない(コピー先で読まれる) |
| `templates/ai_work/` | ランチャー(Local-fulltext-search)の作業フォルダ AI_work のひな形。`AGENTS.md`、自動化一覧、ランチャーのコマンドの例、自動化を作るスキル `automation-builder`、見本の `env-check`。人が AI_work へコピーする。手順はその中の `README.md` | 読まない(コピー先で読まれる) |
| `templates/memory/profile.md` | 利用者のプロフィール(環境・立場・好み)のひな形。会社の PC の `memory\profile.md` へコピーして書く。`memory/` は Git に入れない | 読まない(コピー先が `instructions` で毎回読まれる) |
| `requirements.in` / `requirements.lock` | スクリプトが使う Python パッケージ(pywin32、pypdf。ハッシュ付き)。ハーネスの `.venv` に入れる | 読まない |
| `tests/`、`run_tests.py` | 整合性テストと、全テストの入口 | 読まない |
| `docs/` | 運用メモ(下の一覧) | 読まない |
| `CHANGELOG.md` | 変更履歴と、会社で手で行うこと | 読まない |
| `.gitignore` / `.gitattributes` | 会社ごとの設定と自動生成物を管理から外す / 改行コード | - |

### サブエージェント(`agents/`)

| 名前 | 役割 | 使うもの |
|---|---|---|
| `researcher` | 資料を探し、大量のファイルや文書を読んで、問いに根拠つきで答える(探す → 読む → 答えるを 1 回で)。節約効果が最も大きい。Word・Excel・PowerPoint・PDF は変換して、図(Excalidraw・draw.io)は文章にして読む | `read`、`grep`、`glob`、スキル `doc-convert`、`diagram-reader`、`file-finder` |
| `reviewer` | 読み取り専用のレビュー。範囲が書かれていなければ、Git の未コミットの変更を自分で読む | `read`、`git status`・`diff`・`log`・`show`(読み取りだけ) |
| `outlook` | Outlook のメール・予定・フォルダ。読み取り(受信と送信のキャッシュから)、返信の下書き、予定の作成、メールの整理(案 → 承認 → 実行) | スキル `outlook-mail` |
| `browser` | ブラウザで社内の Web ページを読む | MCP `playwright` |
| `finder` | ローカルのファイルを探して、パスと抜粋を返す。1〜3 件を読めば答えられる問いは、読んで答えまで返す(多くを読む調査は `researcher`) | スキル `file-finder` |
| `obsidian` | Obsidian のプラグインやコマンドを、**許可リストにあるものだけ**実行し、できたファイルを知らせる(印刷用 HTML の書き出しなど) | スキル `obsidian-run` |
| `diagram` | Excalidraw の図(フロー図・スイムレーン・ツリー・マインドマップ)を、仕様から作り、読み戻して確かめる | スキル `excalidraw-diagram`、`diagram-reader` |
| `polish` | **AI が書いた日本語の文書を、意味を変えずに推敲する**(同梱の yomiyasu)。下書きのパスを受け取り、最終稿を `.handoff/polish_<名前>.md` に書き、変えたところと確かめたい点だけを返す。スクリプトの出力や資料を、子セッションの中で読む | スキル `yomiyasu` |

どのサブエージェントも、書いてよいのは `.handoff/` の中だけで、返し方の約束(原本は `skills/create-subagent/handoff-block.md`)を本文に持っています。

### スキル(`skills/`)

| 名前 | 内容 |
|---|---|
| `create-subagent` | サブエージェントを作る手順(要否の判断、権限の雛形、動作確認)と、返し方の原本 |
| `python-env` | `.venv` と `pip` の手順。ハーネス自身のスクリプトが使う `.venv` の作り方 |
| `meeting-notes` | 会議のメモを議事録に整理する |
| `outlook-mail` | Outlook の操作(スクリプト)。受信と送信のメールのキャッシュ(SQLite)。**送信と削除はできない** |
| `file-finder` | ファイル検索と、見つけたテキストの読み取り(スクリプト)。**読み取り専用。対象は設定のフォルダだけ** |
| `doc-convert` | Word・Excel・PowerPoint・PDF・CSV を Markdown に変換する(スクリプト)。**読み取り専用。書くのは `.handoff/converted/` だけ** |
| `vault-notes` | Obsidian のノートの保存(今日のフォルダーに新規作成)と修正(バックアップ → 変更案の承認 → 最小の変更 → **`mark-edit` で「AI が直した・未レビュー」の印**)。日付・時刻は `today` で取る。人のレビューが済んでいない AI のノートと、印の付け忘れの疑いの一覧(`unreviewed`)。**削除はしない。Vault の中だけに書く** |
| `obsidian-run` | Obsidian のコマンドの実行(Local REST API)。**許可リストにあるものだけ。** 実行結果は返らないので、前後のフォルダの差でできたファイルを知らせる。**ノートを開く `open`**(実在するノートだけ。無いノートは作らない。許可リストは要らず、メインから直接) |
| `excalidraw-diagram` | Excalidraw の図を、**仕様から作る**(`build`。フロー図・スイムレーン・ツリー・マインドマップ)、点検する(`check`)。LLM は仕様だけを書き、座標・矢印・日本語の幅はスクリプトが計算する |
| `diagram-reader` | **図(Excalidraw・draw.io)を、画像を見なくても分かる文章(または Mermaid)にして読む**(`describe`。圧縮された図、複数ページも可)。ノートに埋め込まれた図の場所を探す(`links`)。読み取り専用。会社の LLM は画像を認識できないため |
| `project-init` | **プロジェクトのフォルダの初期設定**(`check` / `draft` / `plan` / `apply`)。中身を見てテンプレート(coding / csharp / 一般資料)を選び、中身とインタビューの答えで `AGENTS.md` を埋めて置く。`.handoff/` と `.gitignore` の行も。上書き・削除はしない |
| `python-coding` | **Python のコードを書く・直す・レビューする前に必ず読む**(テスト駆動、型ヒント、標準ライブラリ優先、具体的な例外、`encoding="utf-8"`、Windows の注意、確かめ方)。公開の Python スキルの共通点を、会社の環境(`.venv` と pip、オフライン)に合わせて書いた。coding のテンプレートが「必ず読む」と指示する |
| `calc-check` | **設計計算・判断のロジックを、暗算せずに確かめる**(`check`)。計算書(JSON)に、出典つきの入力と式を書く。値を SI に直して計算し、**単位の矛盾**(足し算・比較・各ステップの単位)、**原典の例での検算**(合わなければ不合格)、**場合分けの網羅**、出典の無い入力・係数、換算に見える数を検査する。式は自前で解釈し、Python のコードとしては実行しない |
| `doc-writing` | **マニュアル・長い資料を節ごとに書く。** 目次と用語の表を先に決めて承認を得る(`init`)。節ごとに根拠つきで書き、**出典の無い節、使わない言い方、用語の値との食い違い、手順の番号の飛び、文体の混ざり、無いリンク、未レビューの AI のノートの出典**を検査し(`check`)、問題が 0 件ならつなぐ(`join`)。書くのは `.handoff/` の中だけ |
| `browser-session` | **Edge・Chrome を開いたまま、同じタブにつなぎ直して、Python のスクリプトで Web の操作を自動化する**(`start` / `open` / `snapshot` / `run` …)。自動化の専用のプロファイルで起動し、作業中のタブの ID を `.handoff/browser/session.json` に残すので、ログインや画面の状態が続く。スクリプトの中では `page`(`click`・`fill`・`wait_for`・`tables` など)が使える。**送信・削除・申請などのボタンと POST の送信は、`--allow-submit`(人の承認)の無い実行では機械的に止める。パスワードは書かない。** 標準ライブラリだけで動く(DevTools Protocol に自前でつなぐ)。**Playwright(Python)があれば、同じタブを Playwright でも操作できる**(`page.playwright()`)。送信・パスワードは、ページの中の見張りが、Playwright からの操作も止める。つなぐのは 127.0.0.1 だけ |
| `interview` | **計画・設計・依頼を、質問で詰めるインタビュー**(grill-me)。聞く前に調べる。事実は自分で調べ、決定だけをユーザーに聞く。前提の決まった質問を、回ごとにおすすめの答えつきで聞く。分かった部分から言い返す。記録(`.handoff/interview_<話題>.md`)の `check` が、未決・AI が決めたこと・出典の無い事実・確かめていない仮定・最後の確認の無いものを見つけ、終わってよいかを決める |
| `yomiyasu` | **同梱(スクリプトと資料は手を加えていない。手順書は約 4,500 文字の要約版で、元は `references/upstream-SKILL.md`)**。[nanaism/yomiyasu](https://github.com/nanaism/yomiyasu) の v2.4.0(MIT)。AI が書いた日本語の、不自然な比喩・曖昧な主述・装飾・コピー調を、意味と条件を保って直し、lint と差分の検査で、意味が変わる恐れのある変更・足した情報を確かめる。標準ライブラリだけで、外へ通信しない。**短い文はメインで、長い文書やファイルは `polish` で使う**。入口は `run.bat lint|check|diff`(記録は `.handoff/yomiyasu/`)。出所・一覧・更新のしかたは `skills/yomiyasu/VENDOR.md` |
| `handoff-clean` | `.handoff/` の古いファイルを整理する(スクリプト)。**削除はせず、`_trash` へ移動する。** 実行は人間の承認の後 |
| `app-ecosystem` | **自作の Web アプリ**(ガント・ファイルマネージャー・差分・Excalidraw・全文検索)を API で使う(スクリプト)。起動の確認、タスクの検索・追加・更新(`--dry-run` → 承認)、**タスクと Obsidian のノートをつなぐ**(`task-add --with-note` でタスクとノートを 1 回で作り、ノートのパスを得る。`task-note` は既存のタスク用。`task-link` は、自分で作ったノートをつなぐ。ノートの名前は `名前【ID】.md`)、**資料を更新した後の差分**(`review`。前回のコミットからの変更と、差分ツールで人が見る URL)、**画像・PDF・図面の差分を数値と位置で読む**(画像が見られない LLM 向け)、人が開く URL。**削除・コマンドの実行・OS のアプリ起動はできない。呼ぶ先はこの PC だけ** |
| `people` | **登場人物(自分も)を覚える**(スクリプト)。人が判断する情報は Vault の人物ノート(`05_people/`、1 人 1 ノート)、メールから分かる事実(件数、最後の連絡、よく一緒の人、最近の件)は保存せず、`outlook-mail` のキャッシュを読み取り専用で集計する。`who`(名前・アドレス、`--mail ID` でそのメールの全員、`--self`)、`candidates`(未登録でやり取りの多い人)、`new` / `set` / `memo`(承認の後)、`check`。**書くのは業務の事実だけ。電話番号・住所は機械的に止める。AI が作ったノートは未レビュー** |
| `memory` | **利用者の環境・立場・好みを覚える・忘れる**(手順だけ。スクリプトなし)。プロフィール `memory/profile.md` は設定の `instructions` で毎回読まれる。1 行 1 事実、2,000 文字以内。**利用者が言ったことだけを、案を示して承認の後に書く。** 他人のことは `people` へ |

スキルは、スラッシュコマンドでは呼び出せません。モデルが、名前と説明を見て読み込みます。人が呼び出したいスキルには、同名のコマンドを置いています。

### コマンド(`commands/`)

| コマンド | 内容 |
|---|---|
| `/summarize` ファイル名 | 子セッションで読んで要約する。メインには要約だけが返る |
| `/meeting-notes` ファイル名 | スキル `meeting-notes` で議事録を作る |
| `/create-subagent` 目的 | スキル `create-subagent` で、サブエージェントを作る(先に、要否を判断する) |
| `/convert-doc` ファイル名 | 子セッションで Markdown に変換する。メインには保存先と目次だけが返る |
| `/save-note` 題名や内容 | 検討した内容を、Obsidian の今日のフォルダーにノートとして保存する |
| `/fix-note` ノート名 修正の内容 | 既存のノートを、バックアップ → 変更案の承認 → 最小の変更で直す |
| `/obsidian-run` 名前 | 許可済みの Obsidian コマンドを、子セッション(`obsidian`)で実行する |
| `/diagram` 内容 | Excalidraw の図を、子セッション(`diagram`)で作る。図のパスが返る |
| `/read-diagram` ファイル名 | 図(Excalidraw・draw.io)を、文章にして説明する。画像が見られなくても理解できる |
| `/init-project` フォルダ | プロジェクトのフォルダを初期設定する。中身を見てテンプレート(coding / csharp / 一般資料)を選び、中身から分かることで `AGENTS.md` の下書きを埋め、分からないことだけを質問する。`plan` で下書きを見せて承認を得てから `apply`(`AGENTS.md`・`.handoff/`・`.gitignore` の行)。`.git` が無ければ、承認の後に `git init` |
| `/grill-me` 話題 | スキル `interview` で、計画や考えを質問で詰める。共通の理解になったと確かめるまで、作業を始めない |
| `/polish` ファイル | 下書きを、子セッション(`polish`)で yomiyasu で推敲する。最終稿のパスと、変えたところ・確かめたい点が返る |
| `/handoff-clean` [日数] | `.handoff/` の状況を見せ、承認の後に、古いファイルを `_trash` へ退避する |
| `/apps` 依頼 | スキル `app-ecosystem` で、自作の Web アプリを使う(タスク、差分、開く URL)。最初に起動を確かめる |
| `/people` [名前・自分] | スキル `people` で、登場人物をインタビューして人物ノートを作る・直す。省略すると、自分のノートが無ければ自分から、あればやり取りが多いのに未登録の人から。メールの集計を先に調べ、おすすめの答えつきで聞き、まとめの承認の後に保存する |
| `/remember` 内容 | スキル `memory` で、環境・立場・好みをプロフィールに覚える(「忘れて」なら消す)。省略すると、この会話で何度も伝えた前提から候補を挙げる。書く内容の承認の後に保存する |

### MCP(`mcp/`)

| 名前 | 内容 |
|---|---|
| `playwright` | Playwright MCP 0.0.83 を、`node_modules` ごと同梱。会社の Edge を使う。ツール定義が大きい(25 個、約 2.1 万文字)ので、メインでは無効にして、`browser` だけが使う |

### ドキュメント(`docs/`)

| ファイル | 内容 |
|---|---|
| [docs/operations.md](docs/operations.md) | 持ち込みの運用、会社の環境の前提と部品の方針、pip の扱い、サブエージェントの設計、AGENTS.md の分け方、OpenCode の仕様メモ |
| [docs/outlook.md](docs/outlook.md) | Outlook 連携の設計、できること、安全の設計、整理の運用、会社での確認 |
| [docs/mcp.md](docs/mcp.md) | MCP の置き場所の方針、Playwright MCP の構成・権限・更新手順 |
| [docs/search.md](docs/search.md) | ファイル検索の設計、対象の決め方、会社での設定 |
| [docs/diagram-reader.md](docs/diagram-reader.md) | 図の読み込みの設計(Excalidraw・draw.io)、読み取りの工夫、draw.io の形式、確認できたこと(実際の図 169 個)、限界 |
| [docs/excalidraw.md](docs/excalidraw.md) | Excalidraw の図を作る設計(仕様 → 図)、配置のしくみ、点検、確認の方法、限界 |
| [docs/obsidian.md](docs/obsidian.md) | Obsidian 連携の方針(MCP にしなかった理由)、Local REST API の仕様、保存・修正・実行の設計、会社での準備、安全の設計 |
| [docs/project-init.md](docs/project-init.md) | プロジェクトの初期設定の設計、置くもの、汎用テンプレートの中身、安全の設計、確認の方法 |
| [docs/convert.md](docs/convert.md) | 文書の変換の設計、方式、変換されないもの、安全の設計、確認できていないこと |
| [docs/apps.md](docs/apps.md) | 自作の Web アプリのエコシステム(アプリと場所、各アプリに足した共通の API「エコシステム API 1」、ハーネス側の使い方、安全の設計、確認できたこと) |
| [docs/people.md](docs/people.md) | 登場人物を覚える仕組み(人物ノートの形、メールの集計、照合の問題、インタビュー、書かないこと、段階) |
| [docs/memory.md](docs/memory.md) | 利用者のプロフィールを毎回読ませる仕組み(置き場所、`instructions`、`/remember`、opencode-mem を採らなかった理由) |
| [docs/company-checklist.md](docs/company-checklist.md) | 会社で、上から順に確認するチェックリスト |

## 3. 会社の環境の前提

| 項目 | 内容 |
|---|---|
| OS | 64bit Windows。ソフトの持ち込みは、セキュアウェブ経由のダウンロードのみ |
| ネットワーク | インターネットには直接つながらない。社内LLM(OpenAI 互換)につなげる |
| 社内LLM(想定モデル) | **Inkling-Small**(Thinking Machines Lab の公開モデル。Apache 2.0、2026-07-30 公開、総 276B・アクティブ 12B の MoE)。このハーネスは、このモデルを想定している。会社の配備には**制限がある(利用者の申告。2026-11-07)**: **ビジョンは切られている**(モデル自体は画像・音声の入力に対応)、**コンテキストは約 13 万トークン**(公式の「最大 1M」とは別)、出力は約 8 万トークン(利用者の記憶。要確認)。詳しくは下の「想定モデルについて」 |
| Python | 使える(PATH が通っている)。`pip install` も使える(接続先は PyPI に直接。ミラーにするよう勧められているが、まだ) |
| Node.js | 最新版が入っている。ただし `npm install` / `npx` でパッケージを取得できない |
| Outlook | クラシック版。メール本文を社内LLMに渡すことは許可されている(外には出ない) |
| ファイル検索 | Everything(HTTP サーバー有効)と、Local-fulltext-search が動いている。よく使うフォルダは後者にインデックス済み |
| 持ち込み | myao-patch-bridge。会社側は独自の Git 履歴を持つ。削除も運ばれる |
| 自作の Web アプリ | 全文検索(8079)、ガント(8000)、ファイルマネージャー(8001)、差分(8078)、Excalidraw(3001)。人が起動する。ハーネスからは `app-ecosystem` で使う([docs/apps.md](docs/apps.md)) |

### 想定モデルについて(Inkling-Small)

公式の資料(Hugging Face のモデルカード、Thinking Machines Lab の発表記事。2026-11-07 に確認)で分かったことと、このハーネスとの関係。数値はベンダーが公表した値で、このハーネスでの結果ではない。

| 公式の資料にあること | このハーネスの設計との関係 |
|---|---|
| コーディングとツール利用に強い(SWE-bench Verified 80.2%、MCP Atlas 79.6%、Terminal Bench 2.1 64.7%)。ハーネスを選ばず動くとされる | 部品を、スキルとスクリプトの入口(`run.bat`)に集めている形と相性がよい |
| 事実の想起が弱い(SimpleQA Verified 20.6%)。ハルシネーションが既知の弱点 | 「根拠のパスを開いて自分で確認する」「未確認と書く」「変換の注意を返答に反映する」を、規則にしてある |
| 長い多ターンの会話で、性能が落ちることがある | 中間の作業を子セッションに隔離し、メインを短く保つ。長い結果は `.handoff/` に置く。会話が長くなったら、要点をファイルに残して、新しいセッションで続ける |
| 指示に正確に従えないことが、時々ある | 守らせたいことは、指示文だけにせず、許可ルール、スクリプトの制限、テストでも守らせている |
| コンテキストは最大 1M トークン(発表記事)。画像・音声を入力できる。思考の深さ(effort)を変えられる | **会社の配備は、コンテキスト約 13 万に制限されている**。窓が小さいので、長い文書は変換して部分的に読む(`doc-convert` の目次と `offset`/`limit`)、中間の作業は子セッションに隔離する、圧縮(コンパクション)が働くようにプロバイダーの `limit` を書く([docs/operations.md](docs/operations.md) の 5.4)。思考の深さの切り替え方は、未確認 |

**モデルに合わせた変更は、まだしていない。** 上の弱点は、一般のベンチマークの結果で、このハーネスで起きた失敗ではない。規則は、実際の失敗に基づいて足す方針([docs/operations.md](docs/operations.md) の 5.1)なので、会社で試して、失敗を見てから直す。Anthropic も、スキルや指示の細かさは、使うモデルごとに試して調整するよう書いている。会社のモデルを変えたときは、同じ依頼でもう一度測る([docs/operations.md](docs/operations.md) の 5.2)。

会社でビジョンが有効になれば、モデルは画像を読める。そのときは、図の見た目の最終確認(いまは人が行う)に使える可能性がある。それまでは、`diagram-reader` の `describe` で読む。

## 4. 会社への持ち込みと反映

人が行うこと(ファイルの置き方、`opencode.json`、`config.local.json`、環境変数、ひな形のコピー)だけを短くまとめたものは [クイックスタート.md](クイックスタート.md)。

1. 自宅で `python3 run_tests.py` を通し、myao-patch-bridge の公開前検証とリハーサルを通して、パッチを公開する。
2. 会社で、ZIP を検証・適用する。`.config\opencode` を `company_repo_paths` で対応付けてある。
3. `sample_opencode.json` と、会社側の `opencode.json` を見比べて、人間が反映する(**OpenCode V2 の書き方。V1 では動かない**。モデルの `limit` も書く: [docs/operations.md](docs/operations.md) の 5.4)。**会社側の `opencode.json`(社内LLMの設定)はリポジトリに入れず、パッチでも上書きされない。**
4. ハーネスのフォルダに `.venv` を作り、`requirements.lock` を入れる。
5. `skills\file-finder\config.local.json` を作る。Playwright MCP を有効にする。Obsidian 連携を使うなら、Local REST API を入れて、`skills\obsidian-run\config.local.json` を作る([docs/obsidian.md](docs/obsidian.md) の 6)。
6. [docs/company-checklist.md](docs/company-checklist.md) の順に確認する。

社内の情報(URL、モデル ID、社名、業務の内容)は、このリポジトリに入れません。個人の GitHub を経由するためです。会社固有の値は、会社側の `opencode.json` と `config.local.json`(`.gitignore` の `*.local.json` で除外済み)にだけ置きます。

### 会社の Windows PC でのセットアップ手順(PowerShell・CLI 導入済み前提)

会社 PC に OpenCode CLI(V2)が入っている状態で、今回実施したセットアップと動作確認をそのまま再現する手順です。1 項目ずつの確認と、うまくいかないときの直し方は [docs/company-checklist.md](docs/company-checklist.md) にあります。ここのコマンドは、その確認をまとめて流すためのものです。

#### 手順 1: `.config\opencode` への配置(A・B のどちらか)

- **A. myao-patch-bridge で `C:\Users\<ユーザー名>\.config\opencode` に直接展開している場合:**
  そのまま手順 2 へ進みます。
- **B. 別の作業フォルダにこのリポジトリがあり、`.config\opencode` へ部品ごとにリンクを張る場合:**
  リポジトリ全体をリンクせず、部品ごとにジャンクション(フォルダ)とリンク(ファイル)を作ります。

```powershell
$repo = (Get-Location).Path  # このリポジトリのルートで実行
$dst  = "$env:USERPROFILE\.config\opencode"
New-Item -ItemType Directory -Path $dst -Force | Out-Null

foreach ($d in 'agents','commands','skills','templates','mcp') {
    if (-not (Test-Path "$dst\$d")) {
        New-Item -ItemType Junction -Path "$dst\$d" -Target "$repo\$d" | Out-Null
    }
}
if (-not (Test-Path "$dst\AGENTS.md")) {
    try {
        New-Item -ItemType SymbolicLink -Path "$dst\AGENTS.md" -Target "$repo\AGENTS.md" -ErrorAction Stop | Out-Null
    } catch {
        New-Item -ItemType HardLink -Path "$dst\AGENTS.md" -Target "$repo\AGENTS.md" | Out-Null
    }
}
```

#### 手順 2: Python 仮想環境(`.venv`)の作成と `requirements.lock` の導入

`doc-convert`、`file-finder`、`obsidian-run`、`outlook-mail` の `run.bat` は `.venv\Scripts\python.exe` を使います。

```powershell
# リポジトリのルート(A の場合は $env:USERPROFILE\.config\opencode)で実行
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --require-hashes -r requirements.lock

# B(別フォルダからリンク配置)の場合のみ、.venv のジャンクションも .config\opencode に作る
$dst = "$env:USERPROFILE\.config\opencode"
if (-not (Test-Path "$dst\.venv")) {
    New-Item -ItemType Junction -Path "$dst\.venv" -Target "$((Get-Location).Path)\.venv" | Out-Null
}

# パッケージのインポート確認
.\.venv\Scripts\python.exe -c "import win32com.client, pypdf, playwright; print('OK')"
```

#### 手順 3: `opencode.json` と `config.local.json` の反映

1. `C:\Users\<ユーザー名>\.config\opencode\opencode.json`(実ファイル)を開く。
   - **すでに会社側の `opencode.json`(社内 LLM の `providers` / `model` 設定)がある場合:** その設定を残したまま、`sample_opencode.json` の `update`、`share`、`permissions`、`mcp` を反映する(`mcp.servers.playwright.command` 内の `<ユーザー名>` を実際の Windows ユーザー名に書き換え、使うときは `"disabled": false` にする。モデルの `limit` も確認する)。
2. スキルのローカル設定ファイルを作る(`.gitignore` で除外済み)。
   - `skills\file-finder\config.sample.json` → `skills\file-finder\config.local.json` にコピーし、検索対象の `roots` や URL を書く。
   - Obsidian 連携を使う場合は、`skills\obsidian-run\config.sample.json` → `skills\obsidian-run\config.local.json` にコピーして書く。

#### 手順 4: 認識と動作の一括確認

```powershell
# 1. CLI のバージョンと設定パスの確認
opencode --version
opencode debug paths
opencode debug config

# 2. サブエージェントの認識確認
#    自作の 8 個 (browser, diagram, finder, obsidian, outlook, polish, researcher, reviewer) が "mode": "subagent" で出ること。
#    内蔵の Explore と General も subagent として出るので、subagent は全部で 10 個に見える
# ※ 初回実行時に "ServiceUnavailableError: Location plugins did not finish activating" が出た場合は、
#    内蔵プラグインの初期化中なので 10〜15 秒待ってからもう一度実行する
opencode debug agents

# 3. run.bat がある 15 スキルの起動確認 (すべて exit=0 になること)
#    スキルは全部で 18 個。create-subagent、meeting-notes、python-env の 3 個には run.bat がない
$cfg = "$env:USERPROFILE\.config\opencode"
foreach ($bat in Get-ChildItem "$cfg\skills\*\run.bat") {
    $out = & $bat.FullName --help 2>&1
    "{0,-20} exit={1}" -f $bat.Directory.Name, $LASTEXITCODE
}

# 4. 各スキルの状態確認と Edge の Playwright MCP スモークテスト
& "$cfg\skills\doc-convert\run.bat" check
& "$cfg\skills\handoff-clean\run.bat" list
& "$cfg\skills\calc-check\run.bat" units
& "$cfg\skills\outlook-mail\run.bat" check
& "$cfg\skills\file-finder\run.bat" check
& "$cfg\skills\obsidian-run\run.bat" check
& "$cfg\skills\app-ecosystem\run.bat" status
& "$cfg\.venv\Scripts\python.exe" "$cfg\mcp\playwright\smoke_test.py" msedge

# 5. ハーネス全体のテスト実行 (全 19 スイート・680 テスト。AI_work のひな形のスキルを含む)
#    相対パスで動かすので、ハーネスのフォルダに移ってから実行する (B の場合は、$cfg ではなくリポジトリのルートへ移る)
Set-Location $cfg
.\.venv\Scripts\python.exe run_tests.py
```

### 自宅の Mac で試すとき

会社の PC に運ぶ前に、自宅の Mac で OpenCode を入れて試すときの注意。**Mac では、動かない部品と、そのままでは動かない手順がある。**

- **インストール(実施済み: 2026-11-07):** OpenCode **V2** を、公式の導入ページにある Homebrew の方法で入れた(`brew install anomalyco/tap/opencode-v2` → `opencode v2.2.6`)。ほかの方法は、`curl -fsSL https://opencode.ai/v2/install | bash`、`npm install -g @opencode/cli`。このハーネスは V2 の書き方(V1 では動かない)。
- **置き場所:** 実際のフォルダ `~/.config/opencode` を作り、中に**部品ごとのリンク**を置く(`AGENTS.md`、`agents`、`commands`、`skills`、`templates` を、このリポジトリへ)。**リポジトリ全体を `~/.config/opencode` にリンクしない。** OpenCode が自動生成するファイルや、会社ごとの `opencode.json` が、リポジトリに混ざるため(整合性テストが、`opencode.json` がリポジトリにないことを検査する)。`opencode.json` は、リンクではなく、`~/.config/opencode/` に置く実ファイル。
- **確認の方法(V2.2.6 で動作を確認):** `opencode debug config`(設定の読み込み元と内容)、`opencode debug agents`(認識されたエージェントと、マージ後の権限)、`opencode debug paths`(データ・設定・ログの場所)、`opencode auth list`(認証の状態)。**7 つのエージェントすべてが、V2 のサブエージェントとして認識され、`steps` と `run.sh` の許可パターンも読まれた。** スキルとコマンドの認識(呼び出し)は、実際に使って確かめる。
- **認証(Claude):** **Claude のサブスクリプション(Pro/Max)でのログインは、使わない。** Anthropic の規約が、サブスクリプションの OAuth トークンをサードパーティのツールで使うことを許可していない(2026-02 の更新。検索で確認: [The Register](https://www.theregister.com/software/2026/02/20/anthropic-clarifies-ban-on-third-party-tool-access-to-claude/5014546) ほか)。OpenCode の公式ドキュメントにも、Anthropic のサブスクリプションでのログインの記載はない。Claude を使うなら、**Anthropic の API キー**(従量課金)を使う。`opencode auth login anthropic --method key`(対話式。キーは自分で入力する。リポジトリや設定ファイルには書かない)。モデルは `provider/model` の形(例: `anthropic/claude-sonnet-5-5`)で、`opencode.json` の `model` に書く。
- **無料で試す(設定済み): `opencode/inkling-2-small-free`。** OpenCode 自体が提供する無料モデルで、認証なしで `opencode models` に出る(2026-11-07 に 11 個)。OpenCode から使う前提の提供で、ツール呼び出しに対応。会社の想定モデル(Inkling-Small)と同系統かは、公式の説明に記載がなく**未確認**。注意: **無料期間中は、送った内容が保持され、モデルの改善・学習に使われる可能性がある**(公式の記載)。EU など一部の国・地域では使えない。無料期間の終了日と、利用の上限は、記載なし。**試すときは、ダミーのデータだけを使い、会社の情報や実際の Vault のノートを送らない。** ほかの無料モデルは、提供元と学習の扱いが違う(例: NVIDIA のモデルは「試用のみ。個人情報・機密を送らない」)。
- **Google の AI Pro などのサブスクリプションでのログインも、使わない。** OpenCode のプラグインでログインして、有料契約者のアカウントが停止された報告がある([Google AI Developers Forum](https://discuss.ai.google.dev/t/paid-pro-subscriber-banned-instantly-for-testing-opencode-oauth/124403) ほか。Google の規約の原文は未確認)。Gemini を使うなら、AI Studio の API キー(無料枠あり)。ただし無料枠は、Google の製品改善に使われ、人が読む場合がある。制限の数値は、資料ごとに食い違うので、AI Studio の画面で確認する。
- **`opencode.json`:** `sample_opencode.json` を見比べて作る。LLM の設定(`providers`、`model`)は、自分で書く(リポジトリには入れない)。`mcp` の `playwright` は、無効のままでよい(Windows のパスと Edge の設定のため)。モデルの `limit` は、使う LLM の実際の値を書く([docs/operations.md](docs/operations.md) の 5.4)。
- **起動スクリプト:** Windows は `run.bat`、**Mac・Linux は `run.sh`**(引数は同じ。標準ライブラリだけ。ハーネスの `.venv/bin/python` があればそれを、なければ `python3` を使う)。各スキルの手順書は、両方を案内している。許可のパターンも、`run.bat` と `run.sh` の両方がある(`sample_opencode.json` と、`researcher`・`diagram`・`obsidian`)。実行権限(`chmod +x`)は付けてある。付いていなければ、`sh skills/<スキル>/run.sh …` でよい。
- **`run.sh` があるスキル(9 つ):** `doc-convert`、`vault-notes`、`diagram-reader`、`excalidraw-diagram`、`project-init`、`handoff-clean`、`obsidian-run`(Obsidian と Local REST API が要る)、`app-ecosystem`、`file-finder`(**Mac では全文検索の `content` だけ**。Everything の `names` は Windows 専用)。**`run.sh` が無いのは、Windows 専用の `outlook-mail`(COM)。** 整合性テストが、`run.sh` の形(ASCII、LF、`exec`、実行権限)、`run.bat` と同じスクリプトを呼ぶこと、許可パターンが `run.bat` と同じ効果であること、実際に動くこと(リンク経由も)を検査する。
- **共通ルールの Windows 前提:** 共通 `AGENTS.md` の `.venv\Scripts\python` と「画像は見られない」は、会社の環境(Windows、ビジョンなし)に合わせた書き方。Mac では `.venv/bin/python` で、モデルによっては画像も見られる。試すときは、この違いを頭に置く(スキル `python-env` と `templates/project/AGENTS.md` には、Mac の書き方もある)。
- **Mac では試せないもの:** Outlook(`outlook-mail`。COM は Windows 専用)、ファイル名の検索(`file-finder` の `names`。Everything は Windows 専用)、Edge の Playwright。**この 3 つは、会社の Windows でだけ確認する。** 全文検索(`file-finder` の `content`)は、Mac でも Local-fulltext-search で試せる(`skills/file-finder/config.local.json` を作る)。
- **Mac で試せるもの:** 共通ルールと `CLAUDE.md` の読み込み、サブエージェントの分離(`researcher` など)、コマンド(`/summarize`、`/init-project` など)、`run.sh` のあるスキル。**会社の LLM とは別のモデルでの結果になる**ので、結果は会社の結果の代わりにならない(想定モデルは Inkling-Small)。

## 5. 使い方の例

- 「`researcher` を使って、Vault から〇〇について書いたノートの要点を教えて」
- 「今週届いた山田さんからのメールの要点を教えて」(`outlook`)
- 「受信トレイを案件ごとに整理して」(`outlook`: まず案だけを出して止まる。承認すると、フォルダを作ってメールを移動する。結果は `mail-undo` で戻せる。不要なメールの削除は、人間が行う)
- 「〇〇(社内ページの URL)の内容を教えて」(`browser`)
- 「見積について書かれたファイルを探して」(`finder`: 中身は Local-fulltext-search、名前は Everything)
- 「この見積.xlsx と仕様書.pdf を読んで、金額の食い違いを教えて」(`researcher`: 変換して読み、元のファイルのシート名・ページ番号を根拠に返す)
- 「この件を検討して、結論をノートにして保管して」(`vault-notes`: 今日の日付と時刻を取り、今日のフォルダーに、`created` とタグつきで作る)
- 「〇〇のノートに、△△の修正を入れて」(`vault-notes`: バックアップを取り、変更前後を見せて承認を得てから、最小の変更だけを入れる)
- 「この手順を、スイムレーンのフローチャートにして」(`diagram`: 仕様を書き、`図_〇〇.excalidraw.md` を作る。見た目の最終確認は、Obsidian で人が行う)
- 「このノートの図の内容を説明して」(`diagram-reader` の `links` → `describe`: Excalidraw でも draw.io でも、画像が見られなくても、箱・矢印・分岐・レーンを文章で読む)
- 「〇〇のノートを開いて」(`obsidian-run` の `open`: Obsidian の画面に開く。返答には `[[〇〇]]` を書くので、Claudian のチャットからもクリックで開ける)
- 「印刷用の HTML を書き出して」(`obsidian`: 許可リストにあるコマンドだけ。できたファイルの場所が返る)
- 「今週が期限のタスクを教えて。期限切れは来週の金曜まで延ばして」(`/apps`: `tasks --due-within 7` → 新しい最終日を確かめ → `task-update … --dry-run` → 承認 → 実行)
- 「この 2 つの図面(PDF)の違いを教えて」(`app-ecosystem` の `diff`: 違いの量と位置(上左〜下右)を数値で返す。中身は人が画面で確かめる URL が返る)
- 「このフォルダを、このハーネスで使えるようにして」(`/init-project C:\Work\橋梁計算`: `AGENTS.md`・`.handoff/`・`.gitignore` の行を、足りないものだけ置く。既存のファイルは上書きしない。`plan` を見て承認すると `apply`。`.git` が無いフォルダは、承認の後に `git init` も行う。リポジトリの途中のフォルダでは行わない)
- 「このボルトのせん断を、設計基準で確かめて」(`calc-check`: 入力の出典と、基準の例題での検算つきの計算書を書き、`check` が「合格」になってから答える)
- 「この作業の手順書を作って」(`doc-writing`: 目次と用語の表を見せて承認を得てから、節ごとに根拠つきで書き、検査してつなぐ。Vault に置くなら `vault-notes`)
- 「レビューが残っている AI のノートは?」(`vault-notes` の `unreviewed`: AI が作った・直した、未レビューのノートと、印の付け忘れの疑い)
- 「部品の検索画面で、ボルトを検索して、結果の表を JSON にする自動化を作って」(`browser-session`: ブラウザを開いたまま、`snapshot` で画面を調べ、段階ごとのスクリプトを `run` で試し、通しのスクリプトにまとめる。送信のボタンは、承認の後だけ)
- `/grill-me 来月の締付作業の手順書を作りたい`(`interview`: 資料を先に調べ、目的・成功の条件・やらないことから聞き、おすすめの答えつきで回を重ねる。共通の理解になったら、`doc-writing` へ)
- `/apps` 今日のタスク、`/summarize` 議事録.md、`/meeting-notes` メモ.md、`/convert-doc` 報告書.docx、`/save-note`、`/fix-note`、`/obsidian-run`、`/diagram`、`/read-diagram`、`/init-project`、`/handoff-clean`

## 6. 設計判断の経緯

この環境を作るまでに決めたことと、その理由です。

### 6.1 共通ルールとファイル名

- 共通ルールは **`AGENTS.md`(複数形)**。`~/.config/opencode/AGENTS.md` は全フォルダに効き、各フォルダの `AGENTS.md` と**連結**されて LLM に渡される(設定のようなマージではない)。同じ種類の中では、作業フォルダから上にたどって最初に見つかった 1 つだけが使われる。矛盾する指示を書かず、フォルダ別には「書き足し」だけを書く。
- **作業フォルダに `CLAUDE.md` があれば、最初に読む**(以前 Claude Code で開発したリポジトリのため。OpenCode は、プロジェクトに `AGENTS.md` があると `CLAUDE.md` を読み込まない)。共通ルールと食い違うときは、共通ルールを優先する。
- 毎回読み込まれるので小さく保つ。詳細な手順は、使うときだけ読み込まれるスキルに移した(`python-env`)。安全のルールは常に効かせたいので残した。
- コーディング用と Obsidian 用は、`templates/` のひな形を人間がコピーして書き換える。Obsidian 用は、自宅の Vault を調べて作った(`.obsidian/` と `.excalidraw.md` は触らない、リンクの形、frontmatter、である調、など)。会社の Vault が同じ構成かは未検証。

### 6.2 持ち込みと設定

- `install` スクリプトは作らない。myao-patch-bridge で運び、人間が反映する。
- `opencode.json` は会社側だけのファイル(社内LLMの設定を含む)。配るのは `sample_opencode.json` で、想定外のキーを入れない(テストが検査する。増やすときは公式ドキュメントで確かめる)。
- **設定・エージェント・コマンドは、OpenCode V2 の書き方に統一した**(2026-11-07。利用者が V2 を使っているため)。`permissions` の配列、`shell`、`subagent`、`mcp.servers` など。V1 の旧名は V2 でも読まれるが、1 つのファイルに新旧を混ぜると旧名が無視されるので、混ぜない(テストが検査する)。V1 の OpenCode には使えない。会社の版は記録する。対応表は [docs/operations.md](docs/operations.md) の 4。

### 6.3 Python と pip

- Python はプロジェクトごとに `.venv`。システムの Python に入れない。ハーネス自身のスクリプトの `.venv` は、ハーネスのフォルダに 1 つ。
- PyPI へ直接つなぐ間は、LLM が実在しない名前や似た名前のパッケージを入れる危険がある。入れてよいのは、`requirements` にあるか、人間が名前を指定したものだけ。バージョンとハッシュを固定し、接続先はリポジトリに書かない(ミラーに替わっても、設定だけで済む)。

### 6.4 サブエージェント

- 最初は「サブエージェントは結果を `.handoff/` に書き、メインに短く返す」案だった。見直して、**節約の本体は子セッションの分離であり、ファイルは長いときだけ**に直した(短い結果までファイルに書くと、書く・読むの手間で逆効果)。
- 見直しで、委任の基準(5 ファイル以上など)、`steps` の上限(社内LLMの暴走を防ぐ)、返答の必須項目(質を守る)、返答が不足しているときにメインが補う規則、`researcher` を足した。
- `.handoff/` は作業フォルダ直下の隠しフォルダ。ハーネスのリポジトリには置かない(myao-patch-bridge の自動コミットに入るため)。各プロジェクトの `.gitignore` に入れる。ファイル名に日時を入れないのは、サブエージェントが現在時刻を知らないことがあるため。
- 効果は測らないと分からない。会社で、「メインだけ」と「子に任せる」を比べる(チェックリストの 15)。

### 6.5 スキルとスラッシュコマンド

スキルはスラッシュコマンドでは呼べない(モデルが説明を見て読み込む)。人が呼びたいスキルには、同名のコマンドを置き、本文で「スキルを読み込め」と指示する。この方法が実際に動くかは、会社で確認する。

### 6.6 Outlook

- MCP ではなく**スキル+スクリプト**。使わないときは名前と説明だけで済み、常駐する処理もない。重いので、サブエージェント `outlook` に任せる。
- クラシック版 Outlook の COM(pywin32)を使う。`mail_adress_creater` の接続とキャッシュ復旧の書き方、偽の Outlook を使うテストの方式を参考にした。
- できること: メールの一覧・本文、返信の下書き(保存だけ)、予定の一覧・作成(保存だけ)、フォルダの一覧・作成、メールの移動と元に戻す。**送信と削除は実装しない。** 削除済みアイテムと迷惑メールへは移動できない。
- 「AI が整理し、人間が確認して削除する」運用のため、整理は「案 → 承認 → 実行」。移動は記録され、戻せる。1 回 50 通まで。
- メール本文は指示として扱わない(外から届く文章に紛れた指示への対策)。EntryID は長くトークンを食うので、短い ID を使う。

### 6.7 MCP と Playwright

- MCP のコードと同梱は `mcp/`、接続の設定は会社側の `opencode.json`、使うのは特定のサブエージェントだけ。
- 会社では `npx` が使えないので、Playwright MCP は自宅で `node_modules` ごと取得して同梱し、`node` で直接動かす。公開直後の最新版ではなく、約 6 週間経った 0.0.83 を採用した。ブラウザは会社の Edge(`--browser msedge`)。
- 危険なツール(`browser_run_code_unsafe`)は禁止、入力・アップロード・スクリプトの実行は確認付き。

### 6.8 ファイル検索

- 全文は Local-fulltext-search、名前は Everything。どちらも、すでに動いているサーバーを呼ぶだけなので、**MCP ではなくスキル+スクリプト**(標準ライブラリだけ)にした。PyPI へ直接つなぐ間は、依存を増やしたくないため。検索の本体は `search_core.py` に分けてあり、後で MCP に包み直せる。
- 対象は、設定の `roots` に限る。ツールの中で強制する(外は検索も結果も不可、空の `folder_path` は送らない)。当初は、`finder` は探すだけで、読んで答えるのは `researcher` とした(0.21.0 で、1 回で答えまで出すように変えた。6.29)。

### 6.9 採用しなかったもの

| もの | 理由 |
|---|---|
| Filesystem MCP、Git MCP | OpenCode の組み込みの機能と重複する |
| Memory(知識グラフ)MCP | Vault が記憶の役割をする |
| Web 検索系の MCP | オフラインで使えない |
| `npx` で起動する MCP | 会社でパッケージを取得できない |
| OpenCode のカスタムツール・プラグイン | OpenCode 用のパッケージの取得が要る可能性がある。会社では使わない前提 |
| 組み込みの `explore` と同名のエージェント | 上書きか統合かが、ドキュメントに書かれていない |
| Obsidian 用の第三者の MCP(コマンドの実行、Dataview、Templater) | コマンドの実行が「全部許可か全部禁止」で、削除のコマンドも呼べてしまう。ツール定義が大きいものがある。中身を監査できていない。代わりに、許可リストつきの小さなクライアント(`obsidian-run`)を作った |
| 第三者の MCP サーバーの追加 | 中身の確認ができない。あなたの権限で動くプロセスになる |

### 6.10 文書の変換と `.handoff/` の掃除

- **文書の変換:** Word・Excel・PowerPoint・PDF は `read` で読めない。変換するスクリプトをスキル `doc-convert` にし、`researcher` に持たせた。変換と読む作業を同じ子セッションで行うので、読んだ量はメインに入らない。画面に出すのは保存先と目次(行番号つき)だけで、必要な部分だけを `read` の `offset` と `limit` で読ませる。
- **方式:** Office の 3 形式は、標準ライブラリだけで読む(zip と XML)。PDF だけ `pypdf`(ハッシュ固定)。依存を増やさない方針と、PyPI へ直接つなぐ間の安全のため。MarkItDown などは採用しなかった。
- **根拠の書き方:** 変換した文書の根拠には、変換後の行番号ではなく、元のファイルのパスと、シート名・スライド番号・ページ番号・見出しを書かせる(メインは変換後のファイルを持っていない)。
- **安全:** 読んでよい場所をスクリプトの中で強制する(`read` の権限を経由しないため)。DTD の拒否、展開後の大きさの上限、書き込みは `.handoff/converted/` だけ。変換した文章は、データであって指示ではない。詳しくは [docs/convert.md](docs/convert.md)。
- **掃除:** 当初は「古いものは人間が消す」だった。「`.handoff/` が溜まる」ので、スキル `handoff-clean` を作った。ただし、共通ルール(削除・移動は確認する。削除は退避を先に考える)に従い、**削除はせず、`_trash` へ移動するだけ**にした(削除する機能そのものが無い。テストが検査する)。実行は、一覧を見せて承認を得た後だけ。`sweep` はサブエージェントに持たせず、メインが行う。
- **新しい依存:** `pypdf` だけ。`requirements.in` に足し、`requirements.lock` をハッシュつきで作り直した(pypdf 7.0.0 と typing-extensions 4.16.0 が増えた)。

### 6.11 Obsidian(MCP にするか、スキルにするか)

- **取得・保存・修正は、MCP にしない。** Vault はただの Markdown のフォルダで、組み込みの `read` `grep` `edit` `write` で足りる。足りないのは手順(案 → 承認 → 実行、バックアップ、日時の取得)なので、スキル `vault-notes` と小さなスクリプトにした。
- **プラグインの実行は、Local REST API を使う。** 当初は、会社で MCP を入れにくいことが理由だった。その制約は無いと分かった後も、第三者の MCP は採用しなかった(コマンドの実行が全部許可か全部禁止、中身を監査できていない、ツール定義が大きい)。代わりに、**許可リストにあるコマンドだけ**を実行する小さなクライアント(`obsidian-run`)を作った。後から MCP に包み直せる。
- **仕様の制約:** Local REST API は、コマンドの実行結果を返さない(成功のみ)。標準では Dataview のクエリにも対応していない。そこで、実行の前後で Vault のフォルダを比べて、できたファイルを知らせ、中身はファイルとして読む作りにした。
- **保存と修正は、子に任せない。** ユーザーの確認を挟みながら進める作業だから。取得(量が多いとき)は `researcher`、プラグインの実行は `obsidian`。
- **今日のフォルダー:** 自宅の Vault の実際の構成(`01_data/年/月/日`、月日は 2 桁)に合わせた。変更は設定で行う。
- **印刷用 HTML:** プラグインのコマンドで作る方法と、LLM が直接 HTML を書く方法がある。描画にプラグインが必要なときだけ、前者を使う。詳しくは [docs/obsidian.md](docs/obsidian.md)。

### 6.12 Excalidraw の図(画像が見られない前提)

- **前提の発見:** 会社の LLM は、ビジョン(画像の認識)が切られている。図を「見る」ことができない。そこで、**図を文章にして読む**機能(`describe`)を、作る機能と同じ重さで作った。Excalidraw は、中身が構造化されたデータ(箱・文字・矢印の座標と結合)なので、これができる。PNG の図には、できない。
- **既存のスキルの調査:** axtonliu 版(MIT。Obsidian の `.excalidraw.md`。依存なし。ただし更新が止まり、LLM が座標を手計算)、awesome-copilot 版(標準ライブラリ。`.excalidraw` のみ)、coleam00 版(描画に Playwright と esm.sh が要り、会社では動かない。自宅の Vault には入れてあった)。**axtonliu 版を土台に、他を参考にして、自作の生成スクリプトにした**(ユーザーの選択)。
- **作る側の方針:** LLM に座標を書かせず、仕様(ノードと矢印)だけを書かせる。配置・日本語の幅・矢印の経路と結合は、スクリプトが計算する(出力が約 10 分の 1、矢印は必ず結合、機械で点検できる)。最初の版は、フロー図・スイムレーン・ツリー・マインドマップ(ユーザーの選択。スイムレーンは、後から追加の依頼があった)。ひし形(分岐)は、角を丸めない(ユーザーの依頼)。
- **確認の方法:** 見た目は、この Vault の「HTMLで出力(人間用)」(Excalidraw の埋め込みを PNG にする)を API から実行して、PNG を取り出して、目で確認した。それで、ラベルが頂点に重なる、戻る矢印が箱を横切る、という問題を見つけて直した。
- **読む機能は、別のスキルに分けた**(次の 6.13)。詳しくは [docs/excalidraw.md](docs/excalidraw.md)。

### 6.13 図を読むスキル `diagram-reader`(draw.io 対応と、スキルの分け方)

- **draw.io も読めるようにした**(ユーザーの依頼)。この Vault にも、draw.io の図が 21 個ある(ほとんどが `.drawio.svg`。中身は、すべて圧縮されていた)。
- **スキルの分け方:** 当初は「draw.io 用のスキルを分けて」だったが、ユーザーと相談して、**形式ではなく目的で分ける**ことにした。「読む」(Excalidraw・draw.io の両方。入口は `describe` 1 つで、形式は自動判断)と、「作る」(Excalidraw 専用)。理由は、(1) 利用者は「この図を説明して」と言うだけで、形式を気にしない、(2) 読むスキルは、メインや `researcher` が使う。作る側の長い説明(仕様の書き方、配色の意味)を、読むたびに読み込むのは無駄、(3) 読み取りの本体は、形式に依存しない(共通の中間形式を読む)。
- **方式:** draw.io の図を、Excalidraw の要素に似た「共通の中間形式」に変換してから読む。同じ図なら、どちらの形式でも、ほぼ同じ文章になる。
- **検証:** この Vault の図 169 個(Excalidraw 148、draw.io 21)をすべて読めた。実物のスイムレーン、フローチャートで、箱・矢印・分岐・ループ・レーンを正しく読めた。詳しくは [docs/diagram-reader.md](docs/diagram-reader.md)。

### 6.14 世の中の定石との照合と、V2 への統一(2026-11-07)

- **依頼:** 「ハーネスエンジニアリングとして、世の中一般のやり方と照らして、今の構成がベストプラクティスか」(使っているツールは独自でよい。構成の話)。
- **調べたもの:** Anthropic の公式記事(コンテキスト設計、ツール設計、マルチエージェント、エージェントの構築、スキルの作り方・設計、MCP のコード実行、長時間タスクのハーネス、エージェントの評価、メモリ)、OpenCode の公式ドキュメント(rules、skills、agents、permissions、commands、MCP、V1 からの移行)、実務者の記事(Addy Osmani、Software Mansion、nyosegawa)、研究(ETH の AGENTS.md の評価)、Vercel の評価。OpenAI の「Harness engineering」は、公式サイトが読めなかった(検索結果の要約のみ)。
- **結論:** 構成は定石とおおむね一致していた。一致した点: 常時の指示は短く(約 64 行。定石は 50〜100 行)、知識はスキルで段階的に読む、処理はスクリプトにして中身を読ませない、サブエージェントは文脈の分離のために使い、長い結果はファイルで渡す(Anthropic も同じ方法)、許可は狭い許可リスト、失敗のたびにテストを足す。
- **足りなかった点(→ [docs/operations.md](docs/operations.md) の 5):** (1) サブエージェントの節約効果を、まだ測っていない(Anthropic は、マルチエージェントはチャットの約 15 倍のトークンを使うと書いている。価値が高い作業でだけ採算が合う)。(2) 指示の各行が、実際の失敗に結び付いているとは限らない(複数の資料が「失敗に応じて足す。先に大量に書かない」と勧めている)。ETH の研究は、指示ファイルが成功率をほとんど上げず、費用を約 20% 増やすと報告している(有効なのは、標準的でないやり方を伝えるとき)。(3) スキルが呼ばれるかを、測っていない(Vercel の評価では、スキルが呼ばれない例が 56% あった。二次資料で確認)。今の構成は、コマンドがスキルを必ず呼び、`AGENTS.md` が名前を明記するので、その対策になっている。(4) モデルの更新で不要になる足場を、見直す仕組みがない(Anthropic は、新モデルのたびに、部品を 1 つずつ外して影響を測るよう書いている)。(5) 規則の一部は指示文だけで、フックのような決定的な強制がない。OpenCode V2 には、フック(プラグイン)と、宣言的な `policies` がある(公式で確認。詳細と判断は [docs/operations.md](docs/operations.md) の 5.6)。いまは、許可ルールとスクリプトの制限で代えていて、フックは入れていない。
- **V2 への統一:** 利用者の希望で、設定・エージェント・コマンドを V2 の書き方にした。変換は、機械的に行い(許可ルールの順序を変えない)、テストで新旧の混在と順序の誤りを検査する。V2 で既定が変わった点(`external_directory` は既定で許可、`.env` の確認が `read` の許可で打ち消される)は、雛形で明示した。

### 6.15 プロジェクトの初期設定 `project-init`(2026-11-07)

- **依頼:** ローカルでこのエージェントを使うときの設定を、フォルダを指定して自動で配置するスキル。**コードだけでなく、設計計算や構造計算、CAE のモデルを扱うリポジトリも作る**ので汎用に。ただし Python のコードはほとんどの場合に出てくるので残す。**Git で管理する前提**。Obsidian は、人間が配置するので対象外。
- **決めたこと(ユーザーの「おすすめで」):** `CLAUDE.md` だけがあるリポジトリには `AGENTS.md` を作らない(指示を 1 か所にする)。既存の `AGENTS.md` には、節を足さない(触らない)。
- **方式:** 置く内容はスクリプトが決める(LLM に判断させない)。`check`(状態)、`plan`(置く内容)、`apply`(置く)。`apply` は、`plan` を見せて承認を得てから。上書き・削除はしない。詳しくは [docs/project-init.md](docs/project-init.md)。
- **汎用テンプレート:** `templates/coding/AGENTS.md` を、`templates/project/AGENTS.md` に作り直した。Git の作法、計算・解析の節(単位系、出典、入力・モデル・結果の分離、照合、「未検証」「未実行」の明記、最終判断は人間)、Git で管理するもの・しないもの(大きな結果ファイル、バイナリのモデル)を足した。Python と会社の PC の決まりは残した。
- **検証(自宅の Mac):** テスト 37 件、実装を 17 通りに壊して全部検出。一時フォルダで実行し、新規(3 つ置く、2 回目は何もしない)、`CLAUDE.md` あり(`AGENTS.md` を作らない。CRLF の `.gitignore` に、改行を保って追記)、`.git` なし(警告)、ホーム・ハーネス・ルート(拒否)を確認した。会社の Windows は未確認。

### 6.16 レビューと、許可の判定の検証(2026-11-07)

- **依頼:** リポジトリ全体のレビュー(世の中の事例との照合を含む)。
- **方法:** 全ファイルを読み、OpenCode V2 の公式の permissions ページと、Mac の v2.2.6 のバイナリの中のコード(許可の判定とシェルの解析)を読んで、許可ルールが実際にどう判定されるかを確かめた。その判定を Python に写し、各エージェントのルールに実際のコマンドを当てた。
- **見つけた問題と直したこと:**
  1. **`--out` で `.handoff/` の外に書けた**(`diagram-reader`・`file-finder`・`outlook-mail`)。パスに `.handoff` が含まれるかだけを見ていたため、`.handoff/../../x.md` が通った。`outlook` の `mail-get --out` は確認なしで動くので、外から届くメールの本文を、作業フォルダの外に書けた。→ `..` とリンクを解いた後で、作業フォルダ直下の `.handoff/` の中かを判定する(`excalidraw-diagram` と同じ方式)。
  2. **許可したコマンドのリダイレクトで、確認なしにファイルに書けた**(`type nul > main.py` など)。→ 雛形に `*>*` の `ask`、サブエージェントに `*>*` の `deny`。`git … --output` も `ask`。
  3. **`outlook` の確認が、引数の値で打ち消された**(`cal-create --subject "folder-list の確認"` が確認なしに)。書き込みの `ask` が、読み取りの `allow` より前にあったため。→ 順序を直した。` --dry-run` の許可は、前に空白を入れた(`案件--dry-run` のような値に一致しない)。
- **再発の防止:** 整合性テストに `PermissionBehaviorTests` を足した。判定を写した関数で、「このコマンドは許可・確認・拒否のどれか」を、エージェントごとに確かめる。元のルールに戻すと失敗することを確かめた。
- **構成そのもの:** 6.14 の結論(定石とおおむね一致)を変える材料は無かった。

### 6.17 自作の Web アプリのエコシステム(2026-11-07)

- **依頼:** 自作の Web アプリ 5 つ(全文検索、ガント、ファイルマネージャー、差分、Excalidraw)の API を調べ、エコシステムとして調整し、ハーネスから最大限に使えるようにする。
- **決めたこと(ユーザーの選択。すべて推奨案):** (1) API は**足すだけ**(既存の API と画面は壊さない)、(2) 書き込みは**確認つき**、**削除は持たせない**、(3) ハーネス側は**スキル 1 つ+共通の CLI**(アプリごとのスキルにすると、常に見える説明文が増える)、(4) Obsidian の Vault(独自プラグイン)は**対象外**。
- **調べたこと:** 5 つのアプリの全エンドポイント(約 200)を、コードから一覧にした。すでにアプリ同士の連携がある(ファイルマネージャー → 全文検索・Excalidraw、全文検索 → ガント)。危険な API がある(Excalidraw の `run-command`、ファイルマネージャーの `open/execute`・端末・削除、全文検索の索引の初期化)。ポートは重ならない。
- **アプリ側に足したもの:** 全アプリに共通の名乗り `GET /api/ecosystem`(版、人が開く URL のひな形、外から使ってよい操作。危険な操作は載せない)。ガントに、LLM 向けの小さなタスク検索 `GET /api/ecosystem/tasks`(最終日 `last_day` つき。ガントの終了日は「最終日の翌日」で保存されているため)。差分に、パスで受けて数値と位置だけを返す `POST /api/ecosystem/diff`(画像を見られない LLM 向け。数 MB → 約 700 バイト。ブラウザを開かない)。各アプリの決まり(テストを先に書く、仕様書を同じ変更で直す)に従った。
- **ハーネス側:** スキル `app-ecosystem`(`status`・`links`・`recent`・`tasks`・`task`・`task-add`・`task-update`・`diff`)、コマンド `/apps`、許可パターン、整合性テストの判定の例。常に見える説明文の上限(2,500 文字)を守るため、`create-subagent`・`handoff-clean`・`obsidian-run` の説明を、意味を変えずに短くした。
- **見つけたが変えなかったこと:** Excalidraw とガントは `0.0.0.0` で待ち受け、認証が無い(Excalidraw は Tailscale での利用を意図)。各アプリの既存のテストに、足す前から失敗しているものがある。詳しくは [docs/apps.md](docs/apps.md)。

### 6.18 実際の依頼での通しの試験(2026-11-07)

- **依頼:** 「OpenCode で、ある個人のテーマを Obsidian にまとめる。エコシステムで検索し、タスクを追加し、図解入りで Obsidian に入れるまでできるか。だめならハーネスを直す」。本物の Vault と本番のガント、無料モデル(利用者の選択。送った内容が保持・学習に使われる可能性がある)。
- **結果:** **できた。** モデルは、スキルを自分で選び、手順書どおりに `--dry-run` → 本番の順で進め、ノート・図・タスクを作り、図を読み戻して確かめた。ただし、(1) ハーネスの決まりどおりの操作(`.handoff/` への下書き、`--help`、スキルの手順の読み取り)で確認が出ていた、(2) 存在しないノートへのリンクを 1 つ作った、(3) Vault の `.gitignore` に `.handoff/` が無いことに気づかなかった。(1) は許可ルール、(2)(3) は `vault-notes` のスクリプトの注意で直した(指示文ではなく、決まった処理で)。直した後の試験で、モデルが注意を読んで正しい直し方を答えた。
- **分かった制約:** `opencode run`(対話なし)は、確認が要る操作をすべて拒否する。書き込みは、対話の画面で人が確認する前提。詳しくは [CHANGELOG.md](CHANGELOG.md) の 0.10.1。

### 6.20 成果物の精度のレビューと、AI のノートのレビューの状態(2026-11-08)

- **依頼:** 試験で作ったノート・図・差分を見て、変な情報が入り込んでいないか確かめる。特に、ローカルの全文検索が関係の無いところまで出すので、それがふるい落とされているか。
- **確かめ方:** 成果物 4 つの数値・ポート・固有名詞(約 150 語)を出典と Vault 全体に照らし、「」の引用 39 個を原文に照らし、OpenCode の記録から子が読んだノートを出した。全文検索を直接呼んで、関係の無い結果がどれだけ混ざるかも測った。
- **結果:** 作り話は無く、関係の無いノート(職務経歴に関わるノートなど)の中身も入っていなかった。ただし、(1) 言い換えに「」が付いていた(28 個中 18 個)、(2) AI のまとめを元に資料を更新して、まとめの不正確さが広がった、(3) 全文検索の「意味だけ」の一致に、関係の無いノートが 3〜4 割混ざり、ハーネスはそれを区別できなかった、(4) AI のまとめと図が、検索の上位に来て、根拠として使われた。
- **直したこと(0.12.0):** `file-finder` が一致の種類(語と意味 / 語 / 意味だけ)と点数、AI のまとめの印を出す。ハーネスが作るノートと図に `ai_generated: opencode` と `ai_reviewed: false`(**人が確かめて ✓ にしたら、根拠として使ってよい**。利用者の要望)。印の無い既存のノートは、人のノートとしてこれまでどおり使う。`vault-notes` が原文に無い引用と、未レビューの AI のまとめを出典にしたことを知らせる。`diagram-reader` が AI の図を知らせる。図の矢印の文字を英単語の途中で折り返さない。
- **直した後の試験:** 同じ質問で、未レビューの AI のまとめと図を根拠にせず、AI のまとめから派生した既存ノートの節も見分けて除き、(2) の不正確さを原典に基づいて正した。

### 6.21 資料・ロジック・マニュアルを作る力の底上げ(2026-11-08)

- **依頼:** 忖度なしの採点(65 点前後)で挙げた弱点を直す。Word・Excel・PowerPoint での出力は不要(会社はデータで承認できる)。図面の読み取りは、将来ビジョンが付くので、決まりは作らない(必要なら人が書く)。AI が直したノートは、根拠に使ってよいが、人のレビュー漏れが無いことを確かめたいので、状態を管理する(利用者の要望)。
- **ロジック(`calc-check`):** 小さいモデルが誤る単位の換算・桁・場合分けを、文章の注意ではなく、機械の検査で捕まえる。計算は計算書(JSON)に書かせ、値を SI に直して計算する(kN と mm と MPa を混ぜても正しい)。次元の矛盾、原典の例との不一致、出典の無い入力は「不合格」。通っていない場合分けは「注意」。式は自前で解釈し、Python のコードとしては実行しないので、確認なしで動かせる。検算の例は、モデルが作った数でなく原典から取らせる(作った数では、誤りを同じ誤りで確かめるだけになる)。
- **マニュアル(`doc-writing`):** 長い文書は、目次と用語の表を先に決めて人の承認を得てから、節ごとに書かせる。節をまたぐずれ(用語、数値、文体、手順の番号)と、出典の無い節は、検査で見つける。
- **AI が直したノート:** `mark-edit` が frontmatter に `ai_edited`(日時)と `ai_reviewed: false` を付ける(他の行は変えない。`true` にはしない)。直したノートは根拠に使ってよい(作ったノートとは扱いを分けた)。直した箇所に印を埋め込む案は、表やリストの描画を崩すので採らず、箇所はバックアップと差分ツールで確かめる。`unreviewed` が、レビュー待ちの一覧と、**印の付け忘れの疑い**(バックアップの後に中身が変わったのに、その後の `ai_edited` が無い)を出す。バックアップの元のノートは `.handoff/backup/index.tsv` に記録する(同名のノートを見分けるため)。
- **Mac での通しの試験(無料モデル、ダミーの資料):** 計算は、例題での検算つきで正しく答え、例題が無いときは検算の例を作らずに「未検算」と答えた。手順書は、質問が取り消されると手順を飛ばす、原典に無い指示を黙って足す、の 2 つが見つかり、手順書を直して再試験で直ったことを確かめた。ノートの修正は、印と差分の URL まで手順どおり。詳しくは [CHANGELOG.md](CHANGELOG.md) の 0.13.0。
- **検索のふるい分け:** `file-finder` は「意味だけ」の一致を、後ろの別の欄にまとめる。`finder` と `researcher` は、除いた結果の件数と理由を返す(関係の判断は LLM のままだが、人が確かめられるようにした)。

### 6.22 ブラウザの自動化と、インタビューのスキル(2026-11-08)

- **依頼:** (1) Chrome を開いたまま、ブラウザのセッションを再利用して、自動化の Python コードを書いていくスキル。(2) GrillMe のようなインタビューのスキル。いろいろなものを参考に、いいとこ取りで。
- **調べたもの(ブラウザ):** browser-use の [browser-harness](https://github.com/browser-use/browser-harness)(CDP で本物の Chrome に 1 つの接続を保ち、エージェントが Python を書いて実行する。今回の依頼に最も近い)、[dev-browser](https://github.com/SawyerHood/dev-browser)(名前つきのページが、実行をまたいで残る)、OpenAI の [playwright-interactive](https://github.com/openai/skills/tree/main/skills/.curated/playwright-interactive)(同じハンドルを使い回して、繰り返し試す)、Anthropic の [webapp-testing](https://github.com/anthropics/skills/tree/main/skills/webapp-testing)(先に画面を調べてから、見つけたセレクタで操作する)。
- **取り入れたこと(ブラウザ):** ブラウザを閉じず、作業中のタブにつなぎ直す(browser-harness・dev-browser)。調べてから操作する(webapp-testing)。小さなスクリプトで試し、最後に通しのスクリプトにまとめる。要素は画像でなく、要素の一覧(見出し・入力欄・ボタン・表と、セレクタ)で知る(この LLM は画像を見られない)。
- **変えたこと(会社の制約):** pip も npm も使わず、標準ライブラリだけで DevTools Protocol につなぐ(WebSocket を自前で実装)。常駐のプロセス(デーモン)は置かず、毎回タブにつなぎ直す(専用のプロファイルとデバッグの口で起動するので、Chrome の許可の画面が毎回出ることが無い)。既定は Edge。人の普段のプロファイルは使わない。**送信・削除などのボタン、POST の送信、パスワード欄への入力は、スクリプトの中でも機械的に止める**(他の例は、手順書の注意だけ)。
- **調べたもの(インタビュー):** Matt Pocock の [grilling / grill-me](https://github.com/mattpocock/skills)(決定の木、前提の決まった質問だけを 1 回にまとめて聞く、各質問におすすめの答え、事実は調べて決定は聞く、共通の理解を確かめるまで作業しない)、obra の [superpowers の brainstorming](https://github.com/obra/superpowers)(聞く前に調べる、まず「なぜ」を選択肢なしで聞く、分かった部分から言い返す、作り方の案を 2〜3 個出す、答えで作るものが変わる質問だけ)。
- **足したこと(インタビュー):** 小さいモデルが長い会話で迷わないよう、記録のファイル(目的・成功の条件・やらないこと・決まったこと・未決・仮定・調べた事実・最後の確認)を正本にし、`check` で終わってよいかを機械で決める(grilling の作者が、弱いモデルは確認の前に作り始める、自分の質問に自分で答える、と書いている点への対策)。1 回の質問は多くても 5 問。
- **Mac での試験:** 本物の Chrome(画面なし)で、つなぎ直しても前の入力が残ること、検索 → 表の読み取り、止める仕組みを、テストで確かめた。OpenCode(無料モデル)では、ブラウザは画面を調べてから段階のスクリプト → 通しのスクリプトまで、インタビューは 5 回のやり取りで確認の前に止まるまで、手順書どおりに動いた(CHANGELOG の 0.14.0)。

### 6.23 文書の推敲 yomiyasu の同梱(2026-11-08)

- **依頼:** [nanaism/yomiyasu](https://github.com/nanaism/yomiyasu)(AI が書いた日本語を、自然な日本語へ推敲するスキル)を入れる。文書のアウトプットで使う。
- **決めたこと:** 手を加えずに同梱した(版の更新を楽にし、作者の検査の前提を崩さないため)。版は、公開から 2 週間たった v2.4.0(更新がほぼ毎日あるため)。スクリプトを読み、標準ライブラリだけで、通信も外部コマンドもないことを確かめた。
- **手順書は要約版にした:** yomiyasu の手順書は約 4.3 万文字(社内 LLM の窓の 3〜4 割)で、Mac の試験では OpenCode が読み込みの結果を途中で切った。利用者の依頼で、規則の要点(意味の 4 点、足さない、言い直しテスト、直す型と直さないもの、Step 1〜5、返す形)を約 4,500 文字の要約版にし、元の手順書は `references/upstream-SKILL.md` にそのまま残して、細部は必要な節だけを読む形にした。同じ下書きで比べて、推敲の質は落ちなかった(1 件での比較)。
- **長い文書は子セッションで使う:** スクリプトの出力や資料を読むのも、子のコンテキストに閉じる。推敲担当の `polish` が読み込み、メインには、最終稿のパスと要点だけが戻る。初めはメインで拒否したが、手順書を要約版にしてからは、短い文(チャットの返答、メール、1 つの節)はメインでも推敲する(利用者の指摘。子を起こす固定のコストの方が大きいため)。
- **つなぎ方:** `doc-writing` の `join` の後に `polish` で推敲し、もう一度 `check` で、用語・値・出典が変わっていないかを確かめる。記録は、Vault やプロジェクトを汚さないよう `.handoff/yomiyasu/` に置く(yomiyasu の既定は Git の最上位の `.yomiyasu/`)。

### 6.24 確認を「本当に危険なもの」に絞る(2026-11-10)

- **依頼:** 許可が煩雑で使いにくい。本当に危険なものに絞る。作業はほぼ Git で管理しているので、大抵のものは大丈夫。Claude Code と同じ使用感にする。
- **決めたこと:** 基準を「Git で戻せるか、外に影響するか」にした。メインは `shell`・`edit`・`skill` を既定で許可し、確認は、Git で戻せない操作(削除、未コミットの変更を捨てる、push)・パッケージの導入・本番のデータベース(ガント)への書き込み・送信を許すブラウザの実行・作業フォルダの外だけ。外への通信・`npm`・強制の push・ディスクの操作は拒否のまま。詳細は CHANGELOG の 0.16.0、判定の細部は [docs/operations.md](docs/operations.md)。
- **サブエージェントは絞ったまま:** 子は、役割の外のコマンドを使えないよう `shell` を既定で拒否する(確認ではなく拒否なので、確認の画面は増えない)。子の確認は、Outlook のメールの移動・予定の作成など、Git で戻せないものだけにした。
- **言葉の決まりも合わせた:** `AGENTS.md` の「削除・上書きは必ず確認」を、「Git で管理するファイルは確認なしに変えてよい。管理外のファイルは確認」にした。権限の確認と、モデルが会話で聞く確認が二重にならないようにするため。
- **残る穴:** `python -c "…"` の中での削除のように、コマンドの文字列から分からない操作は、確認にならない(Claude Code と同じ)。Git で管理していないフォルダで作業するときは、注意が要る。

### 6.37 ランチャーの AI_work のひな形 `templates/ai_work/`(2026-11-12)

- **依頼:** Local-fulltext-search のランチャー(OpenCode ペイン)の作業フォルダ `AI_work` に、自動化(Outlook の予定の作成、Web の勤怠入力など)を集め、スキルと Python を組み合わせて、ランチャー独自のスラッシュコマンドから日本語の指示で動かしたい。AI と一緒に自動化を作れるように、Obsidian と同じく、人がコピーするひな形がほしい。
- **分かったこと:** ① ランチャーのスラッシュコマンドは、プロンプトの定型(`$ARGUMENTS` を置き換えて `opencode run` に渡す。保存は `backend/data/launcher_slash_commands.json` の配列)。② `opencode run` には許可の確認画面が無く、ランチャーは「自動承認」で代えている。③ `browser-session` の `run` は、作業フォルダの中のスクリプトだけを動かす。④ ハーネスの許可の決まりは、外から見えるコマンドの文字列で判定する(自作の `run.bat` の中で `--allow-submit` を付けると、決まりをすり抜ける)。
- **決めたこと:** ① 自動化 1 つ = AI_work の `.opencode/skills/<名前>/` のスキル 1 つ(`SKILL.md` + `scripts/` + `tests/` + `config.sample.json`)。② 処理は Python、画面の操作と取り消せない操作は、ハーネスの `browser-session`・`outlook-mail` を通す。`browser` のひな形の `run.bat` は `--allow-submit` を拒み、送信は承認の後に `browser-session` を直接呼ぶ。③ ランチャーには確認画面が無いので、AI_work の `AGENTS.md` で「取り消せない操作の前で止まり、返事を待つ」を決まりにした。④ ひな形はスクリプト(`automation-builder` の `new`)で置く(社内LLMに、名前の決まり・ASCII の `.bat`・テストの形を毎回書かせないため)。⑤ ランチャーのコマンドは、汎用の 5 つ(`/auto`・`/auto-new`・`/auto-fix`・`/auto-list`・`/env-check`)を例に入れ、自動化ごとのものは `slash` で示して人が登録する。
- **試験:** ひな形のスキルのテスト(`run_tests.py` に足した)、ハーネスの整合性テスト、Mac で写したフォルダでの `new`・`list`・`slash`・`env-check`。**確かめていない:** 会社の Windows・ランチャーから `.opencode/skills/` のスキルが読まれるか(自宅の v2.2.6 では、読まれたスキルの一覧を出す方法が見つからなかった)、自動承認を切ったときの許可の扱い、実際のモデルが聞き取り → 承認 → ひな形の順を守るか。

### 6.36 利用者のプロフィールを覚える `memory`(2026-11-12)

- **依頼:** Windows であることや自分の立場を、毎回入力し直すのは非効率。memory を入れたい。opencode-mem はどうか。
- **分かったこと:** ① OpenCode V2 に組み込みの memory は無い。② 設定の `instructions`(追加の指示ファイル)で、任意のファイルを毎回読ませられる。v2.2.6 で、`~` と `*` が展開されることを、ダミーのプロフィールで確かめた。③ 環境の欄に `Platform:` は入るが、シェル(PowerShell)やパスの書き方は伝わらない。
- **決めたこと:** ① プロフィール `memory/profile.md` を、会社の PC にだけ置き(Git に入れない)、`instructions` で毎回読ませる。② 書くのは `/remember`(スキル `memory`)で、案を示して承認の後だけ。AI が自分の判断では書かない。③ 2,000 文字以内(窓が約 13 万のため)。④ opencode-mem は採らなかった(npm での導入、Hugging Face からの埋め込みモデルの取得、裏で LLM を呼ぶ自動の記録、Windows で複数のセッションが同じ DB を使えない、など。[docs/memory.md](docs/memory.md))。
- **試験:** ハーネスの全テスト、Mac での読み込み。**確かめていない:** 会社の Windows での読み込み、子セッションにも読まれるか、`/remember` を実際のモデルが手順どおりに使うか。

### 6.35 ノートを開く `open` と、Claudian のチャットのリンク(2026-11-12)

- **依頼:** Obsidian のスキルに、ノートを開くものが無いので足す。Claudian のチャットに、ノートのリンクを載せられないか。
- **分かったこと:** ① Local REST API(5.5.2)に `POST /open/<パス>` がある。中身は `workspace.openLinkText` で、**無いパスを渡すと新しいノートを作る**。② Claudian(2.3.39)は、返答の `[[ノート名]]` を、先が Vault に実在すれば**クリックで開けるリンクに置き換える作りが既にある**(コードブロックの中とパスだけの表記は対象外)。足りないのは、モデルがパスだけで返答していたこと。
- **決めたこと:** ① 新しいスキルにせず、`obsidian-run` に `open` を足した(接続・API キー・TLS の設定を共有するため。説明文の合計の上限も、新しいスキルを足す余裕が無い)。② 実在を確かめたファイルが 1 つに決まったときだけ API に渡す(無い・同名が複数なら通信しない)。ドットの場所、Vault の外、`# ^ | [ ]` を含む名前、表示できない種類は開かない。③ ファイルを変えないので許可リストは要らず、メインから直接使う。④ 返答でノートを示すときは `[[ノート名]]`(同名があればフォルダつき)を決まりにした(ひな形の「作業のしかた」、`vault-notes` の報告、`open` の出力)。
- **試験:** 偽のサーバーで `open` の 12 件(名前・パス・`[[ ]]`・絶対パス、同名、無いノート、危ない指定、Mac の濁点、キー)。**確かめていない:** 本物の Obsidian での `open`、Claudian の画面でリンクを押して開くこと、Windows。

### 6.34 登場人物を覚える `people`(2026-11-11)

- **依頼:** AI にメールを読ませるとき、登場人物の補足が要る。自分も含めて、登場人物を覚えていくようにしたい。インタビューで覚えさせたい。
- **決めたこと:** ① 人が判断する情報(役割、関係、業務の決まり)は、Vault の人物ノート(Markdown)に置く。人が読んで直せて、`ai_reviewed` の ✓ でレビューできるため。② メールから分かる事実は、新しく保存しない。メールのキャッシュはすでに SQLite なので、そこからそのつど集計する(LLM が書かないので誤りが入らない)。全部を SQLite にする案は、人が見て直せない・レビューの仕組みが使えない・数百人なら Markdown で十分、のため採らなかった。③ 毎回全員を読み込まず、`who --mail ID` でそのメールの人だけを引く(窓が狭いモデルのため)。④ 書き込みは、インタビュー(`/people`)か、`outlook` の「人物メモの案」をユーザーが承認したときだけ。`outlook` には書かせない(許可で拒否)。⑤ AI が作ったノートは未レビュー(利用者の決定)。⑥ 書かないこと(電話番号、住所、私生活、人物の評価)を決め、電話番号・郵便番号はスクリプトで止める。共通 `AGENTS.md` の個人情報の行に、人物ノートの業務の項目を例外として足した。
- **分かったこと:** キャッシュの宛先・CC は表示名だけで、アドレスが入っていない。社内の差出人のアドレスは Exchange の形のことがある。照合は、表示名(括弧・`/` の後ろを除いた言い換え)とアドレスの両方で行い、同じ表示名の人が 2 人いれば「判別できない」と返す。宛先のアドレスをキャッシュに足すのは、会社で値を確かめてから(段階 2)。
- **試験:** `skills/people/tests`(本物の `outlook_cache` でキャッシュを作る)、ハーネスの全テスト。**確かめていない:** 会社のメールでの照合の精度、実際のモデルがインタビューの手順を守るか。

### 6.33 関連ノートのリンクと、既存のタグ(2026-11-11)

- **依頼:** Obsidian のノートを AI が作るときに、関連するノートを検索してリンクを入れる。タグも、いまあるタグをできるだけ使う。
- **分かったこと:** ノートを作る道具は `vault-notes` の `new-note` だけ(ガントの `--with-note` で作ったノートに本文を書く場合も、そのあと AI が書く)。`new-note` は、リンク先が**存在するか**は確かめていたが、関連するノートを**探す**手段が無く、タグも手順書の「既存のタグを使う」の一言だけで、既存のタグを調べる道具が無かった。自宅の Vault では、タグが 294 種類(1 回だけのものが多い)あり、手で思い出せる量ではない。
- **決めたこと:** ① 探す道具を足す: `related`(語を名前・タグ・本文で照合して点数順)と `tags`(タグと件数)。いずれも読み取りだけ。② 語は LLM が決める。日本語の形態素解析や埋め込みは、会社で使えず(npm 不可、オフライン)、1 回のノート作成の道具としては重いので使わない。意味の近さは見ず、言い換えは語を変えて探す。③ 手順書に、保存の前の手順 3(関連ノートを探してリンク)と 4(既存のタグを探す)を足した。④ 守らなかったときは、`--dry-run` の注意で気づけるようにした(リンクなし、既存に無いタグ、大文字小文字だけ違うタグ、タグなし)。注意だけで、保存は止めない(止めると、新しい話題のノートを保存できない)。⑤ 未レビューの AI のまとめは、`related` の結果でも「リンクしない」と示す(根拠にしない決まりと合わせた)。
- **分かっていないこと:** 実際のモデルが手順を守るか、語を適切に選ぶか、薄い関連を入れすぎないか。会社の Vault での速度(自宅は 462 ノートで、全部読んでも一瞬)。
- **試験:** ハーネスの全テスト、自宅の Vault での `tags` と `related`(読み取りだけ)。

### 6.32 ガントのノート作成を API にして、メールからタスクとノートを作る(2026-11-11)

- **依頼:** ガントの「タスクを選んで、ショートカットで Obsidian のノートを作る」を API にして、AI がタスクを作ったときに使えるようにする。AI は、作られたノートのパスを受け取り、そのノートに内容(例: メールの内容)を書き続ける。
- **分かったこと:** ガントには、画面の「O」用の `POST /api/tasks/{id}/obsidian` が既にあった(タスクの `hyperlink` に絶対パスが入る)。足りなかったのは、AI が使える操作として公開されていないこと、返り値がタスク全体でパスが分かりにくいこと、ノートを作っても他のタブの自動更新が走らないことだった。
- **決めたこと(利用者に確かめた):** ① 本文は、AI が返ったパスのファイルに直接書く(追記の API は作らない)。② タスクとノートを **1 回で作る** API(`POST /api/tasks/with-note`)と、既存のタスク用(`POST /api/tasks/{id}/note`)の 2 つを足す。③ Vault の場所は、ガントのサーバーの環境変数 `OBSIDIAN_HOME` のまま(呼び出しでは指定しない)。④ ガントとハーネスの両方を直す。
- **ガント側(gantt_react_myao):** 上の 2 つの API(`{task_id, note_path, created}` を返す)、エコシステムの `operations` への追加、ノートを作る・つなぐたびに更新シーケンスを進める(他のタブに反映)。**Vault のフォルダーが無いときは、作らずに 400**(環境変数の未設定で、意図しない場所にフォルダーを作らないため。画面の「O」も同じ)。`with-note` は、Vault が無ければタスクも作らない。
- **ハーネス側:** `app-ecosystem` に `task-add --with-note` と `task-note`、手順書(ノートに書く手順と、メールからの例)、`sample_opencode.json`(`task-note` は確認、`--dry-run` は許可)。書き込みを数えるテストに、新しい 2 つの API を足した。従来の 3 手順(`new-note --gantt-id` → `task-link`)は残した(題名・フォルダー・タグを自分で決めたいとき、ガントが古いとき)。
- **分かっていないこと:** 会社のガントが、この版に更新されているか(古いと「ガントが古い版かもしれません」と出る)。会社の PC のガントのサーバーに `OBSIDIAN_HOME` が設定されているか。モデルが実際に「メール → タスク → ノートに書く」を、手順どおり行うか。
- **試験:** ガントのテスト 167 件、ハーネスの全テスト(`python run_tests.py`)。別のポート・一時の DB・一時の Vault で、ガントを起動して、CLI を実際に動かした(作成、再利用、存在しないタスク)。

### 6.31 C# のテンプレート(2026-11-11)

- **依頼:** テンプレートに C# の開発も追加する。
- **決めたこと:** `coding` に混ぜず、**別のテンプレート `csharp`** にした(`coding` は Python 前提。混ぜると使わない指示が残る)。計算・解析の節、Git の作法、Windows の注意は `coding` と同じ。C# 用に、コーディングの決まり、`dotnet` のコマンド、`bin/`・`obj/` を Git に入れないこと、NuGet・SDK の確認を書いた。`check` が、`.sln`・`.csproj`・`.cs` などを見て csharp を推奨する(`obj/` は数えない)。詳細は [docs/project-init.md](docs/project-init.md) の 4.1.1。
- **`.gitignore`:** スクリプトは `bin/`・`obj/` を足さない。`csharp` のときだけ、手順書が、`apply` の後にエージェントが追記すると決めた。
- **分かっていないこと(作り上げていない):** 会社の PC に .NET SDK が入っているか、NuGet が取得できるか。テンプレートでは、確認した結果を書く欄にした。C# 専用のスキルは作っていない。
- **試験:** テスト(`python run_tests.py`)と、ダミーの C# フォルダでの `check`・`draft`・`plan`。実際のモデルでの `/init-project` は未確認。

### 6.30 体験と安全の釣り合いの点検(2026-11-10)

- **依頼:** エージェント、スキル、設定も見て、ユーザー体験とセキュリティの釣り合いが取れていること、抜け・漏れが無いことを確かめて直す(大きく変えてよい)。
- **考え方:** 確認は、「取り消せない」「外へ出る」「秘密に触れる」ものに集め、それ以外は聞かない。指示文だけで守らせていたものは、設定(許可ルール)でも守らせる。逆に、設定の確認がすでに出る操作で、文章でも承認を求めていた二重の確認は、やめる。
- **見つけた抜け(安全側。許可の判定を写したテストで確かめた):**
  1. **メインが Outlook のスクリプトを直接呼ぶと、移動・フォルダの作成・予定の作成が確認なしで動いた。** 確認は `outlook` の子の中にしか無かった。→ 雛形に、同じ 4 つの確認を足した。
  2. **`git push origin main --force` が、拒否ではなく確認になっていた**(拒否のパターンが、`push` の直後の `--force` だけだった)。`+main` の形も同じ。→ どの位置でも拒否。
  3. **履歴の書き換え(`rebase`、`commit --amend`、`filter-branch`)と、`git checkout HEAD -- ファイル`、`find -delete` が、確認なしだった。** 共通 `AGENTS.md` は「先に確認する」と書いているが、設定が守らせていなかった。
  4. **`.env` は、`read` の道具では確認だが、`type .env`・`cat .env` では確認なしだった。編集も確認なしだった。** 秘密鍵らしいファイル(`*.pem`、`*.key`、`id_rsa` など)の読み取りも、確認なしだった。
  5. **外への通信の拒否に、抜け道が多かった**(`curl.exe`、`powershell -c "Invoke-WebRequest …"`、`certutil -urlcache`、`Start-BitsTransfer`、`Net.WebClient`、`-EncodedCommand`)。
  6. **`reviewer` と `browser` は、スキルの拒否が無く、メインの「すべて許可」を引き継いでいた。子から別の子を呼ぶことも、どの子でもできた**(読んだ文書やメールの中の指示が、別の子へ広がり得た)。
  7. **移動の記録(`mail-undo` の元)が一時フォルダにあった。** ディスクの掃除で消えると、戻せなくなる。
  8. このリポジトリの `.gitignore` に `.handoff/` が無かった。
- **見つけた引っかかり(体験側):** `reviewer` はシェルが使えず、「変更をレビューして」でも差分を読めなかった(メインが差分を用意する必要があった)。図の種類と保存先、ノートの題名とタグ、議事録の保存先、`.handoff` の掃除、タスクの書き込み(ダイアログと文章の二重の確認)で、聞き返していた。→ 既定を決めて進め、決めたことを報告する形にした。
- **残る限界(直していない):** 許可のパターンは文字列の一致で、厳密ではない(`python -c` の中の通信や削除、値の中に ` --dry-run` を含めた書き込みは、捕まえられない)。主な守りは、スクリプトの側(送信と削除が無い、`roots` の外を読まない、上書きしない)。`browser` のクリックは、確認なしのまま(リンクをたどるのに要る。送信や承認のボタンを押さないのは指示文だけ。入力は確認が出るので、フォームは埋められない)。開く先を社内に絞るなら、[docs/mcp.md](docs/mcp.md) の `--allowed-origins`。
- **未確認:** V2 の `subagent` という action 名で、子からの呼び出しが実際に止まるか(公式の移行表の名前に合わせた。会社で確かめる)。実際のモデルでの挙動。

### 6.29 調査を 1 回で終わらせる、Outlook のキャッシュ(2026-11-10)

- **依頼:** 全体のレビュー。ストレスなく作業したい。検索して、ファイルだけ出して、「このファイルを読んでいいか」と聞かれたくない。調査は、できるだけ 1 回で終わらせる。Outlook を毎日読み出すのは手間なので、送信と受信のキャッシュを取り、キャッシュと最新から作業する。添付ファイルは不要。
- **聞き返しの原因(レビューで分かったこと):** (1) `finder` は「探すだけ。中身は `researcher` に」と決めていたので、メインが場所を受け取って「読みますか」と聞いた。(2) 作業フォルダの外のファイルを `read` の道具で開くと、`external_directory` の確認が出る(`roots` を `opencode.json` にも書く二重管理が要った)。(3) 共通 `AGENTS.md` と各エージェントが、「曖昧なら、調べずに質問」と書いていた。
- **決めたこと:** (1) `researcher` に `file-finder` を持たせ、探すところから任せる。`finder` は、1〜3 件を読めば答えられる問いなら、読んで答えまで返す。(2) `file-finder` に `read` を足した(`roots` の中のテキストだけ。リンクの先も確かめる。認証情報らしい名前は拒否)。設定を足さなくても、確認なしで読める。(3) 「質問で止まる」のは、結果が大きく変わる曖昧さと、書き込みの中身が決まらないときだけにした。読み取りは、前提を置いて進め、置いた前提を「未確認」に書く。
- **残した確認(意図して):** Outlook を変える操作(予定の作成、フォルダの作成、移動、元に戻す)、Git で戻せない操作、`pip install`、本番のデータへの書き込み、ノートの保存先。
- **Outlook のキャッシュ:** SQLite(標準ライブラリ)。最初は直近 90 日、受信トレイの下のフォルダも含める(利用者と決めた)。新しい順にたどって、キャッシュに無いメールだけ本文を読む。`cache-search` が、10 分より古ければ自動で差分を取り込むので、エージェントは取り込みを意識しない。Outlook につながらなくても、キャッシュで答える。全文検索の仕組み(FTS)は使わず、部分一致にした(日本語の分かち書きに依存しない。数万通なら十分に速い見込み。未計測)。設計は [docs/outlook.md](docs/outlook.md)。
- **未確認:** COM での取り込みの速さ、並べ替え、Exchange での ID の変わり方、OpenCode のシェルの時間切れ。Mac では、偽の Outlook でしか確かめていない。実際のモデルでの「聞き返さない」の確認も、していない(指示とスクリプトのテストだけ)。

### 6.28 共通 AGENTS.md の分け直しと、コーディングのスキル(2026-11-10)

- **依頼:** 共通(コンフィグ側)の `AGENTS.md` とプロジェクトのテンプレートの `AGENTS.md` を整理する。コーディングでは社内のローカル検索を使わなくてよいので、スキルを優先して使うのは Obsidian とコーディング以外だけにする。コーディングにはコーディングのスキルを使わせる(無ければ調べて入れる)。共通の `AGENTS.md` は大きくしすぎない。会社で、プロジェクトの中のスキルだけを探し、共通の場所を見なかったので、探し方も書く。
- **調べたこと:** 共通・ルートの `AGENTS.md` は毎回読み込まれるので、すべての作業に関わることだけにし、細部はプロジェクトのファイルやスキルへ分ける、という意見が多い([aihero.dev](https://aihero.dev/a-complete-guide-to-agents-md)、[Thoughtworks](https://www.thoughtworks.com/radar/techniques/agent-instruction-bloat))。公開の Python スキルは、`uv`・`ruff`・`mypy`・`pytest`、型ヒント、標準ライブラリ優先、具体的な例外でおおむね一致していた。OpenCode は、プロジェクトの `.opencode/skills` と共通の `~/.config/opencode/skills` の両方を読む([公式](https://opencode.ai/v2/docs/skills/))。
- **決めたこと(利用者と):** 共通には、探し方と「答える前に `finder`」の 1 行だけを残す(`AGENTS.md` の無いフォルダのため)。対応表は、一般資料と Obsidian のテンプレートへ。Python のスキルは、公開のものを同梱せず、共通点を会社の環境に合わせて書き直した `python-coding`。既に置いた `AGENTS.md` は、手順だけを書く(自動では書き換えない)。
- **試験:** コーディングで `python-coding` を読んでテストから直す、共通の場所のスキルを見つける、`AGENTS.md` の無いフォルダで `finder` を使う、の 3 つを確かめた(Mac、無料モデル、ダミー)。

### 6.27 project-init のインタビューと、2 つのテンプレート(2026-11-10)

- **依頼:** `/init-project` でインタビューし、適切なテンプレートを選んで、`AGENTS.md` の中身を変える。今は coding と一般資料の 2 つ。すでに中身があるフォルダは、中身を見てテンプレートを選び、必要に応じてインタビューする。Obsidian は人間が配置するので対象外。
- **決めたこと:** 中身の調査とテンプレートの推奨はスクリプト(名前と拡張子だけ。ファイルは開かない)、選ぶのと【 】を埋めるのはエージェント。下書きは `.handoff/` に書き、`plan` で見せて承認を得てから置く(上書きしない作りはそのまま)。質問は、中身から分からないことだけ(1 回に 5 問まで、おすすめの答えつき)。根拠の無い値・例の文は入れず、「(未定)」か行ごと消す。
- **試験:** プログラム・資料・空の 3 つのダミーのフォルダで、テンプレートの選択、中身からの埋め方、質問、承認、`git init` → `apply` まで通した(Mac、無料モデル。対話の画面での質問は未確認)。詳細は [docs/project-init.md](docs/project-init.md) の 4 と 6。

### 6.26 フォルダー・ファイルの Git の差分(2026-11-10)

- **依頼:** ファイルマネージャーの右クリック(ファイル・フォルダ・開いているフォルダの余白)から、Git の差分を差分アプリで見たい。OpenCode のスキルにも差分の表示を。
- **決めたこと:** 差分アプリにすでにある「ノートを起点にした Git 差分」の画面を広げ、`?git_path=` でフォルダー・ファイル 1 つも開けるようにした。ファイルマネージャーは、その URL を新しいタブで開くだけ(Git を自分では読まない)。OpenCode は、同じ範囲の一覧を `review` で読み、人が見る URL を渡す。3 つが同じ画面と同じ範囲を使う。
- **確かめたこと:** ダミーのリポジトリで、右クリック → URL、新しい差分アプリでの表示、`review`。起動中の差分アプリは古い版で、右クリックから実際に開くには再起動が要る。

### 6.25 会話でもスキルとエージェントを使わせる(2026-11-10)

- **依頼:** 会話をしていて、エージェントやスキルを使ってくれない。もっと積極的に使ってほしい。
- **見つけたこと:** Mac の実際の会話で、学校への欠席の連絡方法を聞かれたモデルが、ローカルの資料を探さずに答えようとした(「ローカル検索して」と言われてから探した)。`AGENTS.md` に「答える前に探す」決まりが無く、サブエージェントの節が「固定のコストがかかる」から始まって、自分でやる方に寄せていた。
- **決めたこと:** `AGENTS.md` に「スキルとエージェントを先に使う」の節と、依頼 → 道具の対応表を置いた。小さいモデルは、説明文の一覧から自分で選ぶより、短い表の方が当てやすいため。`AGENTS.md` の上限は 3,000 文字に上げた。
- **試験:** スキル名を言わない 4 つの依頼(連絡方法、単位の換算、手順書、文の推敲)で、4 つとも `finder`・`calc-check`・`interview`・`yomiyasu` を頼まれずに使った(Mac、無料モデル、ダミーの資料)。

### 6.19 タスクとノートのつながり、ほかのテーマでの試験(2026-11-07)

- **依頼:** ガントのタスクと Obsidian のノートを、リンクでつないでおいてほしい。ほかのテーマでも試す。
- **決めたこと:** 新しい形を作らず、この Vault の既存の決まり(ノートの名前の【ID】、タスクの `hyperlink` にノートの絶対パス。ガントの「O」と Vault の「ganttに追加」が使っている)に合わせた。つなぐのは、スクリプト(`new-note --gantt-id`、`task-link`)で行う。
- **試験:** 3 つのテーマと日付の質問で、モデルが手順書どおりに、タスク → 名前に【ID】のノート → つなぐ、を行った。試験で見つかった曜日の計算は、`today` に曜日つきの日付を出させて直した。詳しくは [CHANGELOG.md](CHANGELOG.md) の 0.11.0。

## 7. 今後の候補

- 図: Excalidraw の、関係図・比較表・シーケンス図、入れ子の枠(サブグラフ)、既存の図の編集。draw.io の図を作ること。`.drawio.png` の読み取り。
- スキャンした画像の PDF の文字認識(OCR)。会社で、そういう PDF が多いと分かったら。
- 古い形式(`.doc` `.xls` `.ppt`)の変換(Office の COM で新しい形式に保存し直す案)。会社で試してから。
- pip のミラーへの切り替え(設定だけで済む作りにしてある)。
- ファイル検索の MCP 化(`search_core.py` を包むだけ)。
- Outlook の機能の追加(会社でのテストの結果次第)。
- `project-init`: 既存の `AGENTS.md` へ、テンプレートの節を確認つきで追記する(元のファイルを退避してから)。`.venv` の作成まで含める。会社で使ってみて、必要になったら。
- 評価用の依頼集(20〜50 件)で、成功率・トークン・スキルが呼ばれたかを測る。モデルや版を変えたときの比べる基準にする。
- 会社の `opencode.json` と `sample_opencode.json` の差を出すスクリプト(許可の行の手作業の反映を減らす)。
- 図を作る子と、点検する子を分ける(Anthropic は、生成と評価を別のエージェントにすると、自己評価の甘さを避けられると書いている。今の `diagram` は、作って読み戻すまでを 1 つの子が行う)。効果の測定の結果次第。

## 8. 未確認のこと

自宅の Mac では、本物の Outlook、Edge、Everything、会社の OpenCode を動かせません。偽の相手を使うテストで確かめたのは、呼び出しの組み立て、対象の検査、整形、安全の仕組みです。会社で確認する項目は、すべて [docs/company-checklist.md](docs/company-checklist.md) にあります。特に次の点です。

- 子の返答だけがメインに戻るか。子が共通 `AGENTS.md` を読むか。
- `playwright_*` を `deny` にして、メインからツール定義が消えるか。サブエージェントの権限が、メインの `deny` を上書きするか。
- コマンドの本文でスキルを読み込ませる方法が動くか。
- Outlook の COM の細部(時刻、予定の絞り込みの日時形式、移動後の ID)。
- Everything の JSON 出力と、Local-fulltext-search の `extensions` の形式。
- Claudian 経由で、サブエージェントと MCP が使えるか。
- 本物の Word / Excel / PowerPoint / PDF での変換の品質(見出し、表、日付、日本語の PDF)。Mac では、手で組み立てた最小のファイルで試した([docs/convert.md](docs/convert.md))。
- 図(Excalidraw・draw.io): 会社の Windows での動作、会社の Obsidian・プラグインの版の違い、**会社の LLM が `describe` の出力から、図を正しく説明できるか**([docs/diagram-reader.md](docs/diagram-reader.md) の 6、[docs/excalidraw.md](docs/excalidraw.md) の 6)。
- Obsidian: 実際の Local REST API の応答、使いたいプラグインが**コマンドとして一覧に出るか**、ファイルを作るコマンドか、開いているノートに対するコマンドの動作([docs/obsidian.md](docs/obsidian.md) の 8)。
- `researcher` から、`doc-convert` の `run.bat` が `shell` の許可のパターンで動くか。
- 自作の Web アプリ: 会社の Windows でのアプリの版(古いと `/api/ecosystem` が無い)、`app-ecosystem` の動作、会社の LAN での待ち受けの扱い([docs/apps.md](docs/apps.md) の 4・5)。
- 会社の Windows で、OpenCode がどのシェル(cmd / PowerShell / Git Bash)を使うか。公式に記載がない。許可の判定(`PermissionBehaviorTests`)は、Mac の v2.2.6 のコードを写したもので、Windows の版では確かめていない。
- `/init-project`: 会社の Windows での動作。Mac の OpenCode v2.2.6 と無料モデルでは、コマンド → スキル → `run.sh` の `check`・`plan` が確認なしで動き、`apply` の前で承認待ちになることを確認した。`apply` の確認の画面(対話式)は未確認([docs/project-init.md](docs/project-init.md) の 7)。
- `calc-check`・`doc-writing`: 社内 LLM が、計算書の JSON と、節ごとの Markdown を、手順書どおりに書けるか。検算の例を、自分で作らずに原典から取るか(Mac の無料モデルでは、手順書どおりに書けた。CHANGELOG の 0.13.0)。
- `browser-session`: 会社の Edge で、デバッグの口と専用のプロファイルで起動できるか(会社のポリシーで、リモートデバッグが禁止されていないか)。社内のサイトのログイン(シングルサインオン)が、専用のプロファイルで通るか。
- 想定モデル(Inkling-Small)について: 会社の配備での**コンテキスト長(約 13 万と申告。実測していない)と出力の上限(約 8 万は記憶)**、会社側の設定に**モデルの `limit` が書かれているか**、**思考の深さ(effort)の切り替え方**(公式に記載なし)、ツール呼び出しの形式(公式に記載なし。OpenCode は動作確認済み)、**長い会話での性能低下の程度**、複数回のやり取りで承認を挟む作業(`outlook` の案 → 承認 → 実行、`/fix-note`)が最後まで正しく進むか。

## 9. 開発

```
python3 run_tests.py
```

- `tests/`: 整合性テスト(エージェントの形、返し方のブロックが原本と一致、スキルとコマンドの参照、設定の雛形、`AGENTS.md` の大きさの上限、Windows の名前・パスの制約、ドキュメントのリンク、README に全部品が載っていること、など)
- `skills/*/tests/`: Outlook(偽の Outlook)、ファイル検索(偽のサーバー)、文書の変換(テストの中で組み立てた最小の docx / xlsx / pptx / PDF)、`.handoff/` の掃除、Obsidian の保存・修正(一時的な Vault)、Obsidian のコマンド実行(Local REST API を真似た偽のサーバー)、Excalidraw の図の生成・点検、プロジェクトの初期設定(一時フォルダ。上書き・削除・範囲外への書き込みをしないことの検査)、図の読み込み(Excalidraw と draw.io。実際の圧縮データ、手で描いた図の例、圧縮・SVG・複数ページの draw.io を含む)のテスト。PDF のテストは `pypdf` があるときだけ動く
- 部品を足したら、README の表と `CHANGELOG.md` を直す(テストが、載っていないものを見つける)。
- Playwright MCP の更新は [docs/mcp.md](docs/mcp.md)。Windows と myao-patch-bridge の制約の検査は `mcp/scan_vendor.py`。
- エージェントの返し方の約束(`skills/create-subagent/handoff-block.md`)を変えたら、`agents/` の全ファイルに写す。テストが食い違いを検出する。
