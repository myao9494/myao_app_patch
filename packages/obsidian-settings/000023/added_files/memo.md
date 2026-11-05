---
title: OpenCode × 社内LLM 導入手順(CLI / Desktop / Obsidian Claudian)
created: 2026-11-05
tags:
  - opencode
  - llm
  - obsidian
  - claudian
  - 手順書
---

# OpenCode × 社内LLM 導入手順

オフライン環境(セキュアウェブ経由でのダウンロードのみ可)で、OpenCode CLI / OpenCode Desktop / Obsidian の Claudian プラグインを、社内の OpenAI 互換 LLM につなぐための手順書です。

> [!info] この手順書の流れ
> 1. OpenCode CLI / Desktop のインストール(コマンドライン不使用)
> 2. VS Code の設定から、社内LLMの接続情報を取得
> 3. OpenCode CLI / Desktop に社内LLMを設定
> 4. Obsidian の Claudian から OpenCode CLI を使う設定
> 5. どこまで使えるかの機能テスト

> [!warning] 前提と注意
> - OS は **Windows 10/11(x64)** を想定しています。Mac / Linux の場合はファイル名と保存先を読み替えてください。
> - OpenCode と Claudian はどちらも更新が速く、画面の表記や設定項目が変わっている場合があります。**ここに書いた内容と画面が違うときは、画面側を優先**してください。
> - ソフトの持ち込みは、社内のソフトウェア導入ルール(申請・審査)に従ってください。
> - API キーは、ノート・メール・チャットに貼らないでください。このノートにも書かないこと。

---

## 0. 事前チェック

- [ ] セキュアウェブからダウンロードできるサイトを確認した(`opencode.ai`、`github.com` など)
- [ ] ダウンロードしたファイルを PC に保存・実行する権限がある(管理者権限が要るか確認)
- [ ] 環境変数を「ユーザー」単位で設定できる
- [ ] VS Code の Copilot Chat で社内LLMがすでに使えている
- [ ] Obsidian のコミュニティプラグインが有効にできる(制限モードをオフにできる)

---

## 1. OpenCode のインストール(オフライン環境)

`npm install` や `curl ... | bash` のようなコマンドは使いません。**セキュアウェブでファイルをダウンロードして手で配置**します。

### 1-1. ダウンロードするもの

| 対象 | 入手先 | 選ぶファイル(Windows) |
|---|---|---|
| OpenCode CLI | 公式サイト `https://opencode.ai/download` から GitHub Releases へ | `windows-x64` と書かれた CLI の zip または exe |
| OpenCode Desktop | 同上 | `desktop` と `windows-x64` を含む `.exe` または `.msi` |

- GitHub のリリースページは `https://github.com/anomalyco/opencode/releases` です(旧 `sst/opencode`。リダイレクトされる場合があります)。**公式サイトのリンクから辿るのが確実**です。
- ファイル名はバージョンで変わります。上の表の「キーワード」で探してください。
- `baseline` と付いたものは、古い CPU 向けです。通常は付いていない方を選びます。

> [!important] バージョンを揃える
> CLI と Desktop は、データベース(`~/.local/share/opencode/opencode.db`)を共有します。Desktop 側で新しいバージョンがデータベースを更新すると、古い CLI が起動しなくなる事例が報告されています。
> **CLI と Desktop は、同じリリース(同じバージョン番号)からダウンロードしてください。** オフラインなので自動更新は動きませんが、後から片方だけ更新しないよう注意します。

### 1-2. CLI を置く

1. 任意のフォルダを作る。例: `C:\Users\<あなたのユーザー名>\tools\opencode\`
2. ダウンロードした zip を展開し、`opencode.exe` をそのフォルダに置く(exe 単体で配布されている場合はそのまま置く)
3. **PATH に追加**する
   1. スタートメニューで「環境変数」と検索 →「アカウントの環境変数を編集」
   2. 「ユーザー環境変数」の `Path` を選び「編集」→「新規」
   3. 手順 1 のフォルダのパスを追加して OK
4. **新しいターミナル**(PowerShell)を開いて確認する

```powershell
opencode --version
```

バージョン番号が表示されれば完了です。

> [!tip] うまくいかないとき
> - `認識されません` と出る → ターミナルを開き直す。それでもだめなら PATH のパスが正しいか確認
> - 起動時に実行がブロックされる → ダウンロードしたファイルのプロパティで「ブロックの解除」にチェック、またはセキュリティソフトの隔離を確認

### 1-3. Desktop を入れる

1. ダウンロードした `.exe`(または `.msi`)をダブルクリックして、画面の指示に従う
2. スタートメニューから OpenCode を起動して、画面が開くことを確認する
3. Windows の場合、画面表示に **WebView2 Runtime** が必要になることがあります。起動しない場合は、社内で配布されている WebView2 を確認してください(Windows 11 は通常入っています)

> [!note] Desktop の初回起動
> この時点では、まだモデルが設定されていません。「モデルがない」「プロバイダーが未設定」と出ても正常です。手順 3 で設定します。

---

## 2. VS Code から社内LLMの接続情報を取得する

VS Code の Copilot Chat で社内LLMを使えているなら、接続情報はどこかに設定されています。まず、次の **5 項目** を集めます。

| # | 項目 | 例 | メモ欄(キー以外) |
|---|---|---|---|
| ① | ベース URL | `https://llm.example.co.jp/v1` | |
| ② | API キー | (控えない・貼らない) | 発行元: |
| ③ | モデル ID | `gpt-oss-120b` など | |
| ④ | ツール呼び出しの可否(toolCalling) | あり / なし | |
| ⑤ | コンテキスト長・最大出力トークン | 128000 / 16384 など | |

追加で、**API の種類**(Chat Completions / Responses / Messages)と、**追加ヘッダーの有無**も確認します。

### 2-1. VS Code のどこを見るか(上から順に試す)

VS Code のバージョンや社内の導入方法により、設定場所が異なります。

**(A) 言語モデルの管理画面から見る**

1. `Ctrl + Shift + P` でコマンドパレットを開く
2. `Chat: Manage Language Models` を実行する
3. 社内LLMのグループ(プロバイダー)を選び、モデルの設定を開く
4. 新しい VS Code では「Custom Endpoint」という方式があり、設定は `chatLanguageModels.json` というファイルに保存されます。画面から該当ファイルを開けます

**(B) settings.json を見る(旧方式)**

1. `Ctrl + Shift + P` →「Preferences: Open User Settings (JSON)」
2. 次のキーを検索する
   - `github.copilot.chat.customOAIModels`(旧方式。現在は非推奨だが、既存環境では使われていることがある)
   - `oaicopilot.baseUrl` / `oaicopilot.models`(拡張機能「OAI Compatible Provider for Copilot」を使っている場合)
3. プロジェクトに `.vscode/settings.json` がある場合は、そちらも確認する

旧方式の例(読み取るポイントに注目):

```jsonc
"github.copilot.chat.customOAIModels": {
  "モデルID": {
    "name": "表示名",
    "url": "https://llm.example.co.jp/v1/chat/completions",  // ← ここからベースURLを取る
    "toolCalling": true,                                      // ← ④
    "vision": false,
    "maxInputTokens": 65536,                                  // ← ⑤
    "maxOutputTokens": 32768                                  // ← ⑤
  }
}
```

> [!important] ベース URL の取り方
> `url` が `.../v1/chat/completions` のように **エンドポイントまで書かれている場合**、OpenCode には **`/chat/completions` を除いた `.../v1`** を設定します。

**(C) 社内の案内・配布設定を確認する**

- 社内ポータルの LLM 利用ガイド、導入時の配布資料
- 管理者が配布した設定(設定の同期、ワークスペース設定、拡張機能の設定)

### 2-2. API キーについて

- VS Code は、API キーを設定ファイルではなく **安全な保管領域(シークレットストレージ)** に保存することが多く、**画面から読み出せない場合があります**。
- その場合は、**キーの発行元(LLM の管理部署・ポータル)から、自分用のキーを再発行・確認**してください。
- 共有キーを使い回していないか、利用規約(1人1キーかどうか)も確認します。

### 2-3. 取得した情報が正しいか、VS Code とは別に確認する(推奨)

OpenCode に設定する前に、PowerShell でエンドポイントが応答するか確認します。**キーは画面に残らないよう、環境変数経由**にします。

```powershell
# キーは一時的に環境変数へ(入力時に履歴へ残したくない場合は Read-Host を使う)
$env:COMPANY_LLM_API_KEY = Read-Host "API Key"
$base = "https://llm.example.co.jp/v1"   # ← ①に置き換える

# 1) モデル一覧
Invoke-RestMethod -Uri "$base/models" -Headers @{ Authorization = "Bearer $env:COMPANY_LLM_API_KEY" }

# 2) チャット
$body = @{
  model = "モデルID"                       # ← ③に置き換える
  messages = @(@{ role = "user"; content = "こんにちは。1+1は?" })
} | ConvertTo-Json -Depth 5
Invoke-RestMethod -Uri "$base/chat/completions" -Method Post `
  -Headers @{ Authorization = "Bearer $env:COMPANY_LLM_API_KEY" } `
  -ContentType "application/json; charset=utf-8" `
  -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
```

| 結果 | 意味 |
|---|---|
| 応答が返る | ①②③が正しい。手順 3 へ進む |
| 401 / 403 | API キーが違う、または権限がない |
| 404 | ベース URL の `/v1` の有無が違う可能性 |
| 証明書エラー | 社内の認証局(CA)の証明書が必要。管理者に確認 |
| `/models` だけ 404 | 一覧 API がない構成。OpenCode ではモデルを手で書くので問題なし |

> [!warning] 注意
> VS Code の Copilot 側は、モデル ID に `/` を含むものを受け付けない場合があります。OpenCode は `プロバイダー名/モデルID` という形式で指定するため、モデル ID 自体に `/` があっても動く場合がありますが、うまくいかないときは管理者に正しい ID を確認してください。

---

## 3. OpenCode CLI / Desktop に社内LLMを設定する

CLI と Desktop は **同じグローバル設定ファイルを共有**します。1 回書けば両方に反映されます。

### 3-1. API キーを環境変数に登録する

設定ファイルにキーを直接書かず、環境変数を参照させます。

PowerShell で実行(ユーザー環境変数として保存されます):

```powershell
setx COMPANY_LLM_API_KEY "ここにAPIキー"
```

> [!important] 反映のタイミング
> `setx` は **新しく開いたターミナル・アプリから** 有効になります。
> **Desktop と Obsidian は、いったん完全に終了して起動し直して**ください(スタートメニューや Obsidian がすでに動いている場合は、そのプロセスは古い環境変数のままです)。
> 心配なら、一度サインアウト/サインインすると確実です。

PowerShell の履歴にキーが残るのが気になる場合は、「システムのプロパティ → 環境変数」の画面から手で登録しても構いません。

### 3-2. 設定ファイルを作る

保存場所(Windows):

```
C:\Users\<あなたのユーザー名>\.config\opencode\opencode.json
```

(`opencode.jsonc` も使えます。両方ある場合は混乱するので、どちらか一方にします)

フォルダがなければ作成します。エクスプローラーで作るか、PowerShell なら次のとおり。

```powershell
mkdir "$HOME\.config\opencode" -Force
notepad "$HOME\.config\opencode\opencode.json"
```

内容(**①③⑤を手順 2 で集めた値に置き換える**):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "company-llm/モデルID",
  "small_model": "company-llm/モデルID",
  "autoupdate": false,
  "share": "disabled",
  "provider": {
    "company-llm": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "社内LLM",
      "options": {
        "baseURL": "https://llm.example.co.jp/v1",
        "apiKey": "{env:COMPANY_LLM_API_KEY}"
      },
      "models": {
        "モデルID": {
          "name": "社内LLM (表示名)",
          "limit": {
            "context": 128000,
            "output": 16384
          }
        }
      }
    }
  }
}
```

設定の意味:

| キー | 役割 |
|---|---|
| `provider.company-llm` | 社内LLMの登録名。ここで付けた名前が、モデル指定の前半になる(`company-llm/モデルID`) |
| `npm` | OpenAI 互換 API を使うための部品。`@ai-sdk/openai-compatible` を指定する |
| `options.baseURL` | ①のベース URL |
| `options.apiKey` | `{env:変数名}` で環境変数から読む |
| `models` | 使うモデルの一覧。モデル ID は③。`limit` は⑤ |
| `model` | 起動時の標準モデル |
| `small_model` | タイトル生成などの軽い処理に使うモデル。**未指定だと外部のモデルを使おうとする場合があるため、同じ社内LLMを指定**しておく |
| `autoupdate` | オフラインなので自動更新を止める |
| `share` | セッション共有機能を無効化(外部へ送らないため) |

> [!note] その他の補足
> - 追加ヘッダーが必要な場合は、`options` の中に `"headers": { "ヘッダー名": "値" }` を追加します。
> - 社内 CA の証明書が必要で証明書エラーが出る場合は、管理者から CA 証明書(.pem)をもらい、環境変数 `NODE_EXTRA_CA_CERTS` にそのファイルのパスを設定します(OpenCode が Node 系のランタイムで動く前提の一般的な方法。効かない場合は管理者に相談)。
> - LLM が Responses API のみで Chat Completions を持たない場合は、設定方法が変わります。その場合は一度相談してください。

### 3-2 の補足:JSON の書き間違いを防ぐ

- 最後の項目の後ろにカンマを付けない
- 日本語(モデルIDなど)は半角ダブルクォートで囲む。全角の `“ ”` は使わない
- 保存時の文字コードは UTF-8

### 3-3. CLI で動作確認する

**新しい PowerShell** を開きます。

```powershell
# 登録されたモデルの確認
opencode models

# 1回だけ質問して終了(プロジェクトのフォルダで実行)
opencode run --model company-llm/モデルID "こんにちは。あなたは何というモデルですか?"
```

対話画面で使う場合:

```powershell
cd C:\作業用フォルダ
opencode
```

画面内で `/models` と入力し、`社内LLM` のモデルが選べればOKです。

### 3-4. Desktop で動作確認する

1. Desktop を **完全に終了** → 起動し直す(設定の自動再読み込みはありません)
2. 任意のフォルダ(プロジェクト)を開く
3. モデル選択で `社内LLM` を選び、簡単な質問を送る

> [!tip] Desktop だけ動かない場合
> - 環境変数が Desktop に伝わっていない可能性が高い → サインアウト/サインインしてから再起動
> - CLI で動くのに Desktop だけ出ない場合、バージョン不一致(1-1 の注意)も疑う

### 3-5. よくあるエラー

| 症状 | 原因と対処 |
|---|---|
| モデルが一覧に出ない | JSON の書式エラー、保存場所違い、再起動していない |
| 401 | `COMPANY_LLM_API_KEY` が読めていない(新しいターミナル/再起動)、キー違い |
| 404 / 接続できない | `baseURL` の `/v1` の有無、社内ネットワークの接続条件(VPN など) |
| 応答が空 | カスタム OpenAI 互換エンドポイントで、応答形式が異なる場合がある。VS Code では動くのに空になる場合は、API の種類を再確認 |
| ツールを使う操作で失敗 | LLM が tool calling に未対応の可能性(手順 5 のテストで切り分け) |
| 起動が遅い/外部通信のエラー | オフラインで外部取得に失敗している可能性。`autoupdate: false`、`share: "disabled"` を確認 |

---

## 4. Obsidian の Claudian から OpenCode CLI を使う

Claudian は、Claude Code、Codex、OpenCode などのコーディングエージェントを、Obsidian のサイドバーで使えるようにするプラグインです。**Vault が作業フォルダ**になり、ファイルの読み書きや検索、コマンド実行ができます。OpenCode は任意のプロバイダーとして対応しています。

> [!warning] 対応状況
> 開発元の説明では、Codex / OpenCode / Pi の対応は「動作するが、機能が不完全な場合があり、環境・インストール方法ごとの検証が続いている」とされています。**動かない・一部機能が使えないことがあり得る**前提で、手順 5 のテストで確認します。

### 4-1. Claudian をオフラインでインストールする

通常は Obsidian 内のコミュニティプラグイン検索からインストールしますが、オフラインでは使えない可能性があるため、**手動インストール**を用意します。

1. セキュアウェブで、Claudian の GitHub リリースページ(`https://github.com/YishenTu/claudian/releases`)を開く
2. 最新リリースから、次の **3 ファイル** をダウンロードする
   - `main.js`
   - `manifest.json`
   - `styles.css`
3. Vault の中に、プラグイン用フォルダを作る

   ```
   <Vaultのフォルダ>\.obsidian\plugins\claudian\
   ```

   (`.obsidian` は隠しフォルダ。エクスプローラーの「表示 → 隠しファイル」をオンにする)
4. 3 ファイルをそのフォルダに入れる
5. Obsidian を再起動(または「設定 → コミュニティプラグイン」で再読み込み)
6. 「設定 → コミュニティプラグイン」で、**制限モードをオフ**にし、Claudian を **有効化**する

> [!tip] 確認
> プラグイン一覧に Claudian が表示され、トグルを ON にできれば成功です。Obsidian のバージョンは **1.4.5 以上**が必要です。

### 4-2. Claudian を OpenCode に切り替える

1. 「設定 → Claudian」を開く
2. プロバイダーを **OpenCode** にする(プロバイダーごとのタブがあります)
3. **OpenCode CLI のパス**を確認する
   - 自動検出されることが多い
   - 検出されない場合は、PowerShell で場所を調べて設定欄に入力する

   ```powershell
   where.exe opencode
   ```

   (出力されたパスをそのまま設定欄へ。`.cmd` ではなく `opencode.exe` を指す方が安全です)
4. サイドバーの Claudian チャットを開き、モデルの選択肢に **社内LLM** が出るか確認する

### 4-3. 環境変数と設定の引き継ぎ

- Claudian が起動する OpenCode は、**Obsidian が持っている環境変数**を引き継ぎます。したがって、`COMPANY_LLM_API_KEY` を `setx` した後は、**Obsidian を完全に終了して起動し直す**必要があります。
- 引き継がれない場合の代わりの方法として、Claudian の設定にある「Environment(環境変数)」欄に、`COMPANY_LLM_API_KEY` を登録することもできます(キーのような値は、Claudian が安全な保管領域に移す仕様です)。
- OpenCode の設定は、手順 3 の `opencode.json`(グローバル)が使われます。**Vault のフォルダに `opencode.json` を置けば、その Vault だけの設定**にもできます。Vault 内に置く場合、キーは書かず `{env:...}` のままにしてください(Vault を同期・共有する場合に漏れるため)。
- PATH が通っていない旨のエラーが出る場合は、OpenCode の保存フォルダのパスを Claudian の環境変数 `PATH` に追加します。

### 4-4. 安全に試すために

> [!warning] 最初は、テスト用の Vault で
> エージェントは **ノートの作成・編集・削除、コマンド実行**ができます。最初は、本番の Vault ではなく **コピーしたテスト用 Vault** で試してください。本番 Vault で使う場合は、事前にバックアップを取ります。

---

## 5. 機能テスト(どこまで使えるか)

### 5-0. 進め方

- A(CLI 単体)→ B(Desktop)→ C(Claudian)の順に進めます。前の段階で失敗したら、そこで原因を切り分けます。
- 結果は **○(問題なし)/ △(一部のみ)/ × (不可)** で記録します。
- テスト用の作業フォルダ(CLI/Desktop 用)と、テスト用 Vault(Claudian 用)に、次のファイルを用意します。
  - `memo.md`:数行の日本語テキスト(内容は何でも可。機密情報は入れない)
  - `data.csv`:数行のダミーデータ

### 5-A. OpenCode CLI(テスト用フォルダで実行)

| # | テスト | 入力例 | 期待する結果 | 結果 | メモ |
|---|---|---|---|---|---|
| A1 | 起動 | `opencode --version` | バージョン表示 | | |
| A2 | モデル一覧 | `opencode models` | `company-llm/...` が表示される | | |
| A3 | 単発の質問 | `opencode run --model company-llm/モデルID "1+1は?"` | 応答が返る | | |
| A4 | 日本語 | 「日本語で3行の自己紹介をして」 | 文字化けなしの日本語 | | |
| A5 | ファイル読み取り | 「memo.md を読んで要約して」 | ファイルを読んで要約する(ツール使用) | | |
| A6 | ファイル作成 | 「hello.txt に『テスト』と書いて作成して」 | ファイルが作られる | | |
| A7 | ファイル編集 | 「memo.md の末尾に1行追記して」 | 差分が出て、追記される | | |
| A8 | 複数ファイル検索 | 「フォルダ内で『〇〇』を含むファイルを探して」 | grep/検索ツールを使って回答 | | |
| A9 | コマンド実行 | 「`dir` を実行して結果を教えて」 | 実行前に許可を求められ、結果が返る | | |
| A10 | 複数手順 | 「data.csv を読んで、集計結果を summary.md に書いて」 | 読み取り→計算→書き込みを連続して実行 | | |
| A11 | 長文 | 数千字のテキストを貼って要約 | 途中で切れずに完了(コンテキスト上限の確認) | | |
| A12 | 中断 | 長い回答中に中断(Esc など) | 止まる | | |

### 5-B. OpenCode Desktop

| # | テスト | 期待する結果 | 結果 | メモ |
|---|---|---|---|---|
| B1 | 起動・フォルダを開く | プロジェクトを開ける | | |
| B2 | モデル選択 | 社内LLMが選べる | | |
| B3 | 質問と応答(日本語) | 応答が表示される | | |
| B4 | ファイル読み取り・編集 | A5〜A7 と同じ動作 | | |
| B5 | コマンド実行の許可 | 許可ダイアログが出る | | |
| B6 | セッションの再開 | 前の会話を開ける | | |
| B7 | CLI との共存 | CLI を使った後も Desktop が起動する(バージョン不一致がない) | | |

### 5-C. Obsidian Claudian(テスト用 Vault)

| # | テスト | 入力例 | 期待する結果 | 結果 | メモ |
|---|---|---|---|---|---|
| C1 | プラグイン有効化 | - | サイドバーが開く | | |
| C2 | プロバイダー・モデル | OpenCode と社内LLMを選択 | 選べる | | |
| C3 | 単純な質問 | 「こんにちは」 | 応答が返る | | |
| C4 | 日本語・Markdown 表示 | 「表を作って」 | 表や箇条書きが崩れず表示される | | |
| C5 | ノート読み取り | 「`memo.md` を要約して」 | ノートの内容を読んで回答 | | |
| C6 | 現在のノートの参照 | ノートを開いた状態で「このノートを要約して」 | 開いているノートを参照できる | | |
| C7 | ファイルのドラッグ/添付 | ノートをチャットに追加して質問 | コンテキストとして使われる | | |
| C8 | ノート作成 | 「`test/新規.md` を作って見出しを3つ書いて」 | Vault 内にノートが作られる | | |
| C9 | ノート編集 | 「`memo.md` の誤字を直して」 | 編集される(差分・許可の確認) | | |
| C10 | Vault 内の検索 | 「〇〇について書いたノートを探して」 | 検索して結果を返す | | |
| C11 | 複数ノートの整理 | 「`test/` のノートを一覧にして目次を作って」 | 複数ファイルを読んでまとめる | | |
| C12 | コマンド実行 | 「`dir` を実行して」 | 許可確認→実行 | | |
| C13 | 中断 | 長い回答中に停止 | 止まる | | |
| C14 | セッションの継続 | Obsidian 再起動後に履歴を開く | 前の会話が残る/再開できる | | |
| C15 | インライン編集 | ノート内で選択範囲を編集依頼(機能がある場合) | 選択範囲が書き換わる | | |
| C16 | 長文ノート | 長いノートを読ませる | 途中で切れず処理 | | |

### 5-D. 切り分けの目安

| 症状 | 考えられる原因 | 次の手 |
|---|---|---|
| A3 は動くが A5〜A7(ツール使用)が失敗 | LLM が tool calling に未対応、または応答形式が異なる | 社内LLMの管理者に、tool calling(function calling)対応の有無とモデルを確認。未対応なら「会話・要約のみ」の用途に絞る |
| CLI では動くが Claudian だけ失敗 | CLI のパス・環境変数・Claudian 側の対応状況 | 手順 4-3 を再確認。`where.exe opencode` のパスを手で設定。Obsidian を再起動 |
| モデルが Claudian に出ない | `opencode.json` が読まれていない | CLI の `opencode models` と同じ設定が効いているか確認。Vault 内の `opencode.json` が優先されていないか確認 |
| 会話が途中で止まる/切れる | `limit.context` / `limit.output` が実際の上限より大きい | ⑤の値を見直して小さくする |
| 日本語が文字化け | 設定ファイルが UTF-8 でない | UTF-8 で保存し直す |
| Desktop だけ失敗 | 環境変数が未反映、バージョン不一致 | サインアウト/サインイン、CLI と Desktop のバージョンを揃える |

### 5-E. 結果のまとめ(記録用)

- テスト日: 
- OpenCode バージョン(CLI / Desktop): 
- Claudian バージョン: 
- 社内LLMのモデル: 
- 総合評価:
  - [ ] CLI:会話のみ可 / ファイル操作まで可 / 不可
  - [ ] Desktop:会話のみ可 / ファイル操作まで可 / 不可
  - [ ] Claudian:会話のみ可 / ノート操作まで可 / 不可
- 通信確認(任意):テスト中、社内LLM以外に外部へ通信していないか、社内のセキュリティ部門に確認を依頼した
- 課題・次の対応:

---

## 参考リンク

- OpenCode ダウンロード: https://opencode.ai/download
- OpenCode リリース: https://github.com/anomalyco/opencode/releases
- OpenCode プロバイダー設定: https://opencode.ai/docs/providers/
- Claudian(GitHub): https://github.com/YishenTu/claudian
- Claudian(Obsidian コミュニティ): https://community.obsidian.md/plugins/realclaudian
- VS Code の言語モデル設定(Custom Endpoint): https://code.visualstudio.com/docs/agent-customization/language-models