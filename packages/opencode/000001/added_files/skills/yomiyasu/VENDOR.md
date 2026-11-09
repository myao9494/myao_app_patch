# yomiyasu(同梱)

AI が書いた日本語を、意味を変えずに自然な日本語へ推敲するスキル。**スクリプトと資料(`references/`)は手を加えずに同梱し、手順書(`SKILL.md`)だけを、ハーネスのために短い要約版に書き直した**(元の手順書は `references/upstream-SKILL.md` に、そのまま残している)。

- 出所: https://github.com/nanaism/yomiyasu の `skills/yomiyasu/`(タグ `v2.4.0`、2026-10-25 公開。公開から 2 週間たった版を選んだ)
- ライセンス: MIT(`LICENSE`)。Unicode のデータの条項は `UNICODE-LICENSE.txt`
- 動き: 標準ライブラリだけ。外へ通信しない。モデルを呼ばない。子プロセスで動かすのは、同梱の `yomiyasu_lint.py` と `yomiyasu_diff.py` だけ(2026-11-08 に読んで確かめた)

## ハーネスでの使い方

- **手順書は要約版。** 元の手順書は約 4.3 万文字で、社内 LLM の窓(約 13 万トークン)の 3〜4 割になり、OpenCode が読み込みの結果を途中で切った(Mac の試験)。要約版は約 4,500 文字。規則の要点(意味の 4 点、足さない、言い直しテスト、直す型と直さないもの、Step 1〜5、返す形)を残し、細部は元の手順書の同じ名前の節と `references/` を、必要なときだけ読む。
- **短い文はメインで、長い文書やファイルはサブエージェント `polish` で使う。** 長い文書では、スクリプトの出力や資料を読むのも子のコンテキストに閉じる。メインは `polish` に下書きのパスを渡し、推敲した最終稿のパスと、変えたところ・確かめたい点を受け取る。
- スクリプトは `run.bat lint|check|diff …`(Mac・Linux は `run.sh`)で動かす。元の手順書の `python3 <スキル配置ディレクトリ>/scripts/yomiyasu_check.py run …` は、`run.bat check run …` にあたる。
- 記録の置き場(`YOMIYASU_STATE_DIR`)は、決まっていなければ作業フォルダの `.handoff/yomiyasu`(yomiyasu の既定は、Git の最上位の `.yomiyasu/`。Vault やプロジェクトを汚さないため)。

## ハーネスが足したもの

- `SKILL.md`(要約版。元は `references/upstream-SKILL.md`)
- `run.bat`、`run.sh`、`scripts/run_yomiyasu.py`(入口と、記録の置き場の既定)
- `VENDOR.md`(このファイル)、`tests/`(同梱のファイルが元のままかと、入口の動きのテスト)

## 更新のしかた

1. 新しいタグのうち、公開から 2 週間以上たったものを選ぶ。変更点(リポジトリの `CHANGELOG.md`)を読む。
2. `skills/yomiyasu/` の中で、上の「ハーネスが足したもの」以外を、そのタグの `skills/yomiyasu/` で置き換える(元の `SKILL.md` は `references/upstream-SKILL.md` に置く)。スクリプトに、通信・削除・外部コマンドの追加がないかを読んで確かめる。元の手順書の変更点を、要約版の `SKILL.md` に写す(規則が増えたら、表に 1 行か、元の節を指す 1 文で)。
3. 下の一覧を作り直し(`python3 skills/yomiyasu/tests/test_vendor.py --manifest`)、ハーネスのテストを通す。`CHANGELOG.md` に書く。

## 同梱のファイルの一覧(SHA-256)

テストが、この一覧と実際のファイルを照らす(うっかりの編集を見つけるため)。

```
b26d6af9532a22e6ca8d825196a4816fee3ca0a06458419f5427d5252a856318  .codex-plugin/plugin.json
79d802f15bc8caf67f1a83c1bdbe214ccb41a0a0275f9046b329b89c65ee1fca  LICENSE
e7a93b009565cfce55919a381437ac4db883e9da2126fa28b91d12732bc53d96  UNICODE-LICENSE.txt
57c7c204d43d0e2873e3b61221db3ac4ba75a7ce29271a6deaeb3bd09f26fdec  assets/algo-artis.png
48f0295fddc9cd878166ca5c3a6f7e9c33f0a4e07a2d37620b97d6fb6a212e3c  references/audience.md
0f4cd78823f40685fd56517bcda3cb671e7962c698f40285b218ed3108c7f454  references/calques.md
e5009c496b4b4ac8974c16f2f15b0f8ce93620863dfe721803b01138db845716  references/doc-types/article.md
9b164c2916544e417fb42454e199f5c790cbfcd233879c59f563a1942329d9bb  references/doc-types/essay.md
6b4121d4e57d52fb60fb428770a4504c53e1fb06c3fa20e57a1fcd56ce933141  references/doc-types/formal.md
d25282690b220e5d4fa2595228d282d65f7b03d8d4b325c30bf251b58a474b77  references/doc-types/incident.md
43c84865368c6e1e61c0ac1645583933092ddcaabb49b6ed4b6c4621e9ba2d4f  references/doc-types/mail.md
37971c4b7cf8159656a2435b30444a05692fbdffdd7dc3dd8e8f4ada90e8ef8f  references/doc-types/manual.md
7869c10e72e0e4ce6ecb94833e84452beba7f8b676230908fe623deddc49b140  references/doc-types/minutes.md
39a7ff9aca340a003c637153c374f0dc1d668cda3520aab99923bffbc1c37f94  references/doc-types/paper.md
d7bb8a4ac7f5344abf66bb7dfe893480c67ea8d635078c5a8d2582264a21506b  references/doc-types/pr.md
06f8f3a39547985fc74a70c3717596070401b9d3db5fc93e3b10f76f9b6656e4  references/doc-types/promo.md
2a8d8a557b33f2df51aedeed02ba5bb8ed623fcde55f6a42ff4b477920853731  references/doc-types/proposal.md
41bc1c8ebb9f5fea7c18b70b18a3e8ee86073e38f85d62d4ad00ae0719acb49a  references/doc-types/script.md
a4e9f08113fc7efeaa523d67fb6125c33c7e179886698f1d76f72bf049ad1e51  references/doc-types/slides.md
416d0752959ae43cd030f2cbcee76425d457ae37f153164db64f7884f7df7685  references/domains/business.md
aeeeb9f9c842d68fa0fcf2e956bd2f87c5f450bc820df931f3f94b903a8a8c7a  references/domains/essay.md
faeaf3ea41d93e11ef3f679263df23b02a6156da6baecb4eb4dd03f58aa41dd1  references/domains/tech.md
37ad635a1180d0a1c4fbe1e3eacbb79131b47cc51a5066b74d9881dbbeaaf8c3  references/fact-recovery-details.md
64786a3f8639e7bc6d20a7c37789983697d3623f5878b47a4a9ae526e12b472f  references/fact-recovery.md
bb4a212402f63e9144d221feb9992dfe9db69527e71ad74b497c3d97e7453585  references/gemini-syntax.md
c78da500dcddc76978fecd1a7a9f3318d9feabf0db78387a41662a4545e6964f  references/lists/fact-gaps.txt
37b6779b3ef8cf91260379b21d6b721bda362542a5702affd99d550879539e82  references/lists/feelings.txt
ed666036f63f4705d2c129d3fd30e971018d50732bbef2c18081412a61ccd771  references/lists/hedges.txt
65d9189ebebaf8f9cb2aad2c04be3d0ccf53c4d6782affe16bcd8078054d3c83  references/lists/intensifiers.txt
47c686e6a7a94590a97fa9e052b3dee9171dfc8a5f25da727111428cda978e2d  references/lists/katakana-terms.txt
cfe31060efc6d165c30b1619ab574ec405312a80bfb00387efc6557911614be0  references/lists/nominalization.txt
0642b6ba40e4707af4715463d7433c0215087a8e068b00e7894b73e89365997a  references/lists/renyo-nouns.txt
b2cf6a8e1fc424d1bcac15e2aa2045a98ec77a002e2830692922a8f97ee406e4  references/lists/thin-evaluation.txt
a805b2a8946a423a011d2cd66a33bf1be784d0dacdad32a5c5d3b4fed7bc0976  references/persona.md
a3531b41aaefe987726e928b09d59dbb312a35594b8dc6ce6a85dae10c2cc1b7  references/rephrase-test.md
8fcdc5eda87b7b301aaed1eb813bc9b9693bfce5f2b35e572754321edeed5411  references/review-points.md
8d0cf87d501c44710639050ea72d70608e4ca3443a8bc7ccf2a49a99c1b30213  references/slop-catalog.md
9b4b64f067894698be35287225b388b72368c40784fc091bd340202a2e35f471  references/upstream-SKILL.md
5e6064d75d243ea15340efe515f2467f690bfc1c5efb4032238adf261ba1ac18  scripts/markdown_visibility.py
e8c8b47b5a520efed25aebeda7cc25777a90960176f861a4fc104354efd7f8b7  scripts/yomiyasu_check.py
31c46a98bcd987c0a2dda7d9712fb830f3a70b1e0636b6a034ae191530d51ab5  scripts/yomiyasu_diff.py
689ffbeecbaf0380ac99e37b6093f136364b7c7bbf014ada961c8e0781e8ab8b  scripts/yomiyasu_hook.py
b02c21464353b726a8c4e366f89bdfd2f341613f7bf75f779e83cc4dfbc54c9e  scripts/yomiyasu_lint.py
```
