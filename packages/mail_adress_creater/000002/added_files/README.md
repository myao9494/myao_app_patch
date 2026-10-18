# Outlook宛先作成アプリ

Outlookの送信履歴CSVから宛先(To)とCCを効率的に作成するツールです。

## 機能

- スペース・カンマ・読点区切りのキーワードでOR検索
- 宛先(To)とCCを独立して管理
- チェックした名前をセミコロン区切りでクリップボードにコピー
- フォントサイズの調整機能
- Outlookからのアドレス再取得（バックエンド使用時）
- 職アド通知のキーワードチェック（除外キーワード対応）と、確認するまで消えない強調表示
- 宛先(To)とCCをセットで保存するお気に入り（右クリックで登録・適用）
- 自然文の予定解析と、リッチテキスト本文付きのOutlook予定表への追加
- メール・電話・住所・部署・家アドのワンクリックコピー
- SQLiteの内容確認と一部テーブルの選択削除
- PWA対応（バックエンド配信時にブラウザからインストール可能）

---

## 会社での利用方法

### 必要なもの

- Python 3.12
- Node.js / npm（初回ビルドまたは再ビルド用）
- WindowsでOutlook連携を使う場合: デスクトップ版Outlook、pywin32
- 配布ファイル一式（`backend`、`dist`、`public`、起動用ファイルを含むリポジトリルート）

### 手順

#### 1. ファイルの配置

以下のフォルダ構成で配置してください。バックエンドが`dist`を配信します。

```
outlook-address-maker/
├── backend/
│   ├── server.py（ほか config.py, db.py, outlook.py, services.py, scheduler.py, event_parser.py）
│   └── requirements.txt
├── dist/
│   ├── index.html
│   ├── manifest.webmanifest
│   ├── sw.js
│   ├── send_mail-ranking_tabulator.csv
│   └── assets/
├── public/
│   └── send_mail-ranking_tabulator.csv
├── start_windows.bat
└── start_mac.command
```

#### 2. CSVファイルの準備

初期データを手動で用意する場合は、`public/send_mail-ranking_tabulator.csv`に配置してからビルドします。
バックエンドの「アドレス再取得」は`public/send_mail-ranking_tabulator.csv`と`dist/send_mail-ranking_tabulator.csv`を更新します。

**CSVフォーマット：**
```csv
名前,回数
山田 太郎,120
佐藤 一郎,200
鈴木 恒一,150
```

- 1行目はヘッダー（`名前,回数`）
- 名前：Outlookに貼り付ける表示名
- 回数：送信回数（並び替えに使用）。整数として読めない行は読み込み対象外
- 名前にカンマを含む場合はCSVの標準形式どおりダブルクォートで囲めます

#### 3. サーバーの起動

起動用ファイルを使う場合:

- Windows: `start_windows.bat`
- Mac: `start_mac.command`

起動用ファイルは`dist/index.html`がない場合に`npm ci`と`npm run build`を実行し、その後バックエンドを起動します。
Windows用の`start_windows.bat`は、起動前に指定ポート（既定: 8765）を使用中の既存プロセス停止を試みます。その後、バックエンドを別プロセスで起動し、ヘルスチェック成功後にブラウザを開きます。
Mac用の`start_mac.command`は、ポート8765が使用中の場合に既存プロセスの停止を試み、8765番以降の空きポートで起動します。

手動で起動する場合:

Outlook連携を使う場合は、コマンドプロンプトまたはPowerShellでリポジトリのルートに移動してバックエンドサーバーを起動します。
Outlook連携には Windows、Outlook、pywin32 が必要です。

**コマンドプロンプトの場合：**
```cmd
cd C:\path\to\outlook-address-maker
python backend\server.py
```

**PowerShellの場合：**
```powershell
cd C:\path\to\outlook-address-maker
python backend\server.py
```

**Mac / zshの場合：**
```bash
cd /path/to/outlook-address-maker
python3 backend/server.py
```

#### 4. ブラウザでアクセス

サーバー起動後、ブラウザで以下のURLを開きます。フロントエンドはバックエンドから配信されます。

```
http://localhost:8765
```

#### 5. サーバーの停止

コマンドプロンプト/PowerShellで `Ctrl + C` を押すとサーバーが停止します。

### バックエンド機能

- 「アドレス再取得」: Outlookの送信済みアイテム（直近150件）から宛先を再集計し、CSVまたはDBにあって今回見つからなかった名前は回数0で残します。CSVは一時ファイル経由で置き換えるため、途中で失敗しても元のCSVは壊れません。
- 「職アドキーワードチェック」: 件名に「職アドからのお知らせ」を含む受信メール（直近500件）から、登録キーワードに一致する本文行を保存します。未確認の一致は画面上部に目立つ表示で出続け、「確認」ボタンを押すと消えます（アプリを開き直しても未確認分は復元されます）。キーワードの先頭に`-`を付けると除外キーワードになります（例: `RPA, -RPAG受付`）。
- 「予定解析」/「Outlook追加」: 自然文の予定入力から件名、日時、場所、終日予定を抽出し、必要に応じて本文も含めて編集し、Outlook予定表へ追加します。本文にHTMLタグがあればリッチテキストとして、なければ平文として登録します。
- ヘッダー: 「アドレス再取得」「職アドキーワードチェック」「DB表示」「お気に入り」のボタンと、プロフィールのコピーボタン（メール・電話・住所・部署・家アド）があります。
- ハンバーガーメニュー: キーワード、アドレス再取得とキーワードチェックの自動実行頻度、プロフィール（メール・電話・住所・部署・家アド）を設定して「設定保存」します。「ダミーデータ投入」もここにあります。
- お気に入り: 宛先(To)とCCをセットで名前付き保存できます。画面の何もない所を右クリックすると、現在の選択をお気に入りに追加したり、お気に入りを宛先・CCへまとめて適用できます。検索結果では`★`付きで表示され、コピー時は登録済み宛先へ展開されます。
- DB表示: `keyword_matches`、`recipients`、`favorites`、`job_runs`、`settings`を閲覧できます。`settings`以外は選択削除でき、`recipients`削除時はCSVも同期更新します。
- ダミーデータ投入: Outlookが無い環境での画面確認用です。**宛先一覧（DBとCSV）をダミーで上書きし、元に戻せません**。確認ダイアログでOKした場合のみ実行されます。
- 既定値: アドレス再取得は43200分（約1ヶ月）、キーワードチェックは60分（1時間）です。自動実行が失敗した場合は、実行間隔に関わらず最大60分後に再試行します。
- 新規一致はチェック実行時のレスポンスで返ります。保存済み履歴の取得では既存一致として扱われ、`new_only=1`は互換性のため空配列を返します。
- 自動実行はジョブ単位で多重起動を抑止します。同じジョブが実行中の場合、次の同一ジョブはスキップされます。
- APIは同一Originからのブラウザリクエストのみ許可します。別OriginからのGET/POST/PUT/OPTIONSは403で拒否され、別Originに対する`Access-Control-Allow-Origin`は返しません。ループバック（既定）で待ち受けている間は、Hostヘッダーが`localhost` / `127.0.0.1` / `[::1]`以外のリクエストも拒否します。

### データとログの保存場所

- SQLite: `backend/data/app.sqlite3`（初回起動時に自動作成。git管理外）
- ログ: `backend/logs/app.log`（1MBでローテーション、4世代）
- 送信履歴CSV: `public/send_mail-ranking_tabulator.csv`と`dist/send_mail-ranking_tabulator.csv`

### 環境変数

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `OUTLOOK_ADDRESS_HOST` | `127.0.0.1` | 待ち受けアドレス。ループバック以外を指定するとHostヘッダー検証は行いません |
| `OUTLOOK_ADDRESS_PORT` | `8765` | 待ち受けポート |
| `OUTLOOK_ADDRESS_DISABLE_SCHEDULER` | （未設定） | `1`にすると自動実行を止めます |
| `OUTLOOK_ADDRESS_OPEN_BROWSER` | （未設定） | `0`にすると`start_windows.bat`がブラウザを自動で開きません |

### PWA

バックエンド配信時に`manifest.webmanifest`と`sw.js`が配信されます。Chrome / EdgeのインストールメニューからPWAとしてインストールできます。
Service Workerはアプリ本体をキャッシュしますが、`/api`とCSVはキャッシュしません。

---

## 使い方

1. 検索ボックスにキーワードを入力（スペース・カンマ・読点区切りで複数指定可）
2. Enterキーで検索実行（ヒットした人がチェックONになります。Shift+Enterなら結果リストへ移動）
3. 検索結果から不要な人のチェックを外す
4. 「宛先作成」または「CC作成」ボタンをクリック
5. Outlookの宛先/CC欄に貼り付け（Ctrl+V）

名前をクリックするとその名前だけをコピーできます。左右矢印キーで宛先/CCペインを切り替えます。

---

## 開発者向け情報

### 開発環境のセットアップ

```bash
# 依存関係のインストール
npm install

# 開発サーバーの起動
npm run dev

# バックエンドの起動（別ターミナル）
npm run backend
```

開発サーバーでは`/api`が`http://127.0.0.1:8765`へプロキシされます。

### ビルド

```bash
npm run build
```

ビルド後、`dist`フォルダが生成されます。`dist`はバックエンドが配信するためgit管理しており、フロントエンドを変更したら`npm run build`して結果もコミットします。実行時は`dist`だけでなく、`backend`や起動用ファイルを含むリポジトリルート一式を配置してください。

### テスト

```bash
npm run test:run       # フロントエンド（1回実行。npm test は監視モード）
npm run test:backend   # バックエンド
npm run test:all       # 両方
npx vitest --run --coverage  # カバレッジ
```

バックエンドのテストはDB・CSVを一時領域へ差し替えて実行するため、実データには触れません。

### ソース構成

構成の詳細は`docs/README.md`と`AGENTS.md`を参照してください。画面の状態管理は`src/hooks/`、表示は`src/components/`、副作用のない処理は`src/utils/`に分かれています。

### Lint

```bash
npm run lint           # フロントエンド（ESLint）と型チェックは npm run build でも実行されます

# バックエンド（ruff / mypy。設定は pyproject.toml）
pip install -r backend/requirements-dev.txt
npm run lint:backend
```

---

## トラブルシューティング

### Outlook連携が動かない

- Windows環境で実行しているか確認
- デスクトップ版Outlookが利用できる状態か確認
- pywin32をインストールしているか確認

```cmd
pip install -r backend\requirements.txt
```

MacではOutlook COM連携が使えないため、「アドレス再取得」「職アドキーワードチェック」「Outlook追加」はエラー表示になります。

Outlookの型情報キャッシュ（`%TEMP%\gen_py`）が壊れている場合は、自動で削除して再試行します。それでも接続できない場合は、クラシック版Outlookが同じWindowsユーザーで起動できる状態か確認してください（新しいOutlookのみの環境では使えません）。

自動実行や各操作のエラーは`backend/logs/app.log`に記録されます。

### CSVが読み込まれない

- `send_mail-ranking_tabulator.csv`が`public`または`dist`の中にあるか確認
- ファイル名が正確か確認（スペルミス注意）
- CSVの文字コードがUTF-8か確認

### ポート8765が使用中の場合

`start_windows.bat`を使う場合は、起動前に8765番ポートを使用中の既存プロセス停止を試みます。そのため、前回のバックエンドが残っている場合も再起動できます。

手動起動で別のポート番号を指定する場合:

```cmd
set OUTLOOK_ADDRESS_PORT=3000
python backend\server.py
```

この場合、`http://localhost:3000` でアクセスします。

`start_windows.bat`で別ポートを使う場合:

```cmd
set OUTLOOK_ADDRESS_PORT=3000
start_windows.bat
```

ブラウザの自動起動を抑止する場合は、`OUTLOOK_ADDRESS_OPEN_BROWSER=0`を指定できます。

### Pythonが見つからない場合

Pythonのパスが通っているか確認してください：

```cmd
python --version
```

バージョンが表示されない場合は、Pythonのインストールパスを確認し、環境変数PATHに追加してください。
