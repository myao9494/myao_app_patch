# AGENTS.md - Outlook宛先作成アプリ

> このファイルがAIエージェント向けガイドの正本です。`CLAUDE.md` はこのファイルを読み込むだけにしています（二重管理を避けるため）。

## プロジェクト概要

Outlookの送信履歴CSVから宛先(To)とCCを効率的に作成し、バックエンドからOutlook連携・PWA配信も行う軽量アプリ。人間が最終確認する補助ツールで、自動送信は行わない。

## 技術スタック

- **フレームワーク**: React 18 + TypeScript
- **ビルドツール**: Vite 6
- **スタイル**: Tailwind CSS
- **テスト**: Vitest + Testing Library（フロント）、unittest（バックエンド）
- **バックエンド**: Python 3.12 標準ライブラリ + SQLite
- **Outlook連携**: Windows + pywin32（COM）

## コマンド

```bash
npm run dev           # 開発サーバー起動（/api は 127.0.0.1:8765 へプロキシ）
npm run backend       # バックエンド起動（dist配信/API）
npm run build         # プロダクションビルド（dist/ を更新。dist/ はgit管理しているのでコミットする）
npm run test:run      # フロントエンドテストを1回実行（npm test は watch）
npm run test:backend  # バックエンドテスト（python -B -m unittest discover -s backend -t . -p 'test_*.py'）
npm run test:all      # 両方
npx vitest --run --coverage  # カバレッジ
npm run lint          # ESLint
npm run lint:backend  # ruff + mypy（要 pip install -r backend/requirements-dev.txt。設定は pyproject.toml）
```

## ディレクトリ構造

```
backend/
├── server.py        # HTTPサーバー: ルーティング表、Origin/Host検証、エラーコード、キャッシュヘッダー、起動
├── services.py      # ユースケース: アドレス再取得、キーワードチェック、予定解析/追加、ダミーデータ
├── db.py            # SQLite/CSV: スキーマ作成・移行、設定、お気に入り、宛先、職アド一致、ジョブ履歴
├── outlook.py       # Outlook COM: 接続と復旧、送信済み取得、予定登録(本文HTML/平文)、職アド検索
├── scheduler.py     # 自動実行: 実行間隔判定、失敗時の再試行、ジョブごとの多重起動防止
├── config.py        # パス、既定設定、ログ設定、LOGGER
├── event_parser.py  # 自然文の予定解析
├── testing.py       # テスト共通ヘルパー(TempEnvironmentTestCase, Outlookの偽物)
├── test_*.py        # テスト(機能別)
└── requirements.txt

src/
├── App.tsx            # 組み立てのみ(hooksとコンポーネントを接続)
├── components/        # UI(AppHeader, SettingsPanel, ScheduleSection, KeywordMatchBanner,
│                      #    RecipientPane, DatabaseModal, FavoriteModal, GlobalContextMenu,
│                      #    ProfileCopyButtons, HtmlEditor, Toast, styles.ts)
├── hooks/             # 状態管理(useOperation, useToast, useSettings, useKeywordMatches,
│                      #    useFavorites, useScheduleDraft, useDatabaseViewer, useRecipients, useSearch)
├── utils/             # 純粋関数・通信(api, csvParser, search, clipboard, dateTime, favorites,
│                      #    keywords, databaseRows, dom, htmlSanitizer)
├── types/index.ts     # 共通の型
├── test/              # テスト設定とヘルパー
└── main.tsx           # エントリーポイント(Service Worker登録)

public/                # manifest.webmanifest, sw.js, icons/, send_mail-ranking_tabulator.csv(入力データ)
dist/                  # ビルド成果物。バックエンドが配信するためgit管理する
docs/                  # 機能別の仕様書
backend/data/          # 実行時SQLite(git管理外)   backend/logs/  # 実行時ログ(git管理外)
```

## 主要機能

1. **検索**: スペース(全角含む)、カンマ(,)、読点(、､)区切りのOR検索、部分一致、大文字小文字無視。Enterで実行、Shift+Enterで実行して結果へフォーカス
2. **選択**: 検索を実行すると、ヒットした宛先が(既存のチェックを保ったまま)チェックONになる。検索前は一覧を表示しない
3. **コピー**: チェック済みをセミコロン区切りでクリップボードへ。名前クリックでその名前だけコピー
4. **フォントサイズ**: 各ペインで個別に調整可能(8-20px)
5. **アドレス再取得**: Outlook送信済みアイテム(既定150件)から再集計。今回存在しない既存アドレス(CSV・DBのどちらにあるものも)は0回で残す。CSVは一時ファイル経由で原子的に置換する
6. **職アドチェック**: 件名に「職アドからのお知らせ」を含む受信メール(既定500件)の本文行から、登録キーワードに一致する行をSQLiteへ保存。未確認の一致をバナーで強調表示し、ユーザーが「確認」ボタンを押すまで消えない(起動時も未確認を復元)。`keyword_matches.confirmed` と `POST /api/keyword-matches/confirm` で管理。キーワードの先頭に `-` を付けると除外キーワード(件名または該当行に含まれる場合は除外)。詳細は `docs/exclude_keywords_spec.md`
7. **お気に入り**: 宛先(To)とCCをセットで名前付き保存。画面の右クリックメニューから、現在の選択を登録/お気に入りを適用。編集モーダルは常に2カラム(左:一覧、右:To/CCの上下分割編集)。旧データ(`cc_addresses`列なし)は起動時に自動移行。詳細は `docs/favorites_spec.md`
8. **予定解析**: 自然文からOutlook予定を作成(日付・時間範囲・時間帯修飾・場所表記のゆらぎに対応)。本文はリッチテキスト貼り付けに対応し、フロントでOffice HTMLをサニタイズ、バックエンドはHTMLタグを含む本文を `WordEditor.Range.InsertFile` で取り込む(タグを含まない本文は平文として設定し、HTMLエンティティを復元)。詳細は `docs/event_parser.md`, `docs/html_body_spec.md`
9. **DB表示/削除**: SQLiteの主要テーブルを閲覧し、settings以外を選択削除(recipients削除時はCSVも同期)
10. **ダミーデータ投入**: Outlookが無い環境での画面確認用。**宛先一覧(DBとCSV)を上書きする**ため、確認ダイアログでOKした場合のみ実行
11. **PWA**: バックエンド配信時にインストール可能。APIとCSVはキャッシュしない
12. **COMキャッシュ復旧**: `EnsureDispatch` 失敗時に `%TEMP%/gen_py/<Pythonのバージョン>` と `sys.modules` の `win32com` を消去して再試行し、最後は `Dispatch` にフォールバック。サーバー再起動なしで復旧する
13. **プロフィールかんたんコピー**: 設定メニューで保存したメール・電話・住所・部署・家アドを、ヘッダーのボタンでクリップボードへコピー。詳細は `docs/my_profile_spec.md`
14. **自動実行**: アドレス再取得(既定43200分)・キーワードチェック(既定60分)を定期実行。失敗したジョブは最大60分後に再試行する

## バックエンドの規約

- HTTPエラー: 入力不備(`ValueError`/`TypeError`/`KeyError`/不正JSON)は **400**、ボディ上限(1MB)超過は **413**、不明なAPIは **404**、Origin/Host不一致は **403**、それ以外の例外は **500**(メッセージをUIへ表示)
- 同一Originのみ許可。ループバックで待ち受けている間はHostヘッダーもローカル名のみ許可(DNSリバインディング対策)
- DBは `db.ensure_db()` がDBファイルごとに初回のみスキーマ作成・移行する。書き込み系の関数は単体でも `ensure_db()` を呼ぶ
- 環境変数: `OUTLOOK_ADDRESS_HOST`(既定127.0.0.1), `OUTLOOK_ADDRESS_PORT`(既定8765), `OUTLOOK_ADDRESS_DISABLE_SCHEDULER=1`(自動実行を止める)
- テストでは `backend.testing.TempEnvironmentTestCase` でDB・CSVのパスを一時領域へ差し替える。実データに触れないこと

## CSVフォーマット

```csv
名前,回数
山田 太郎,120
佐藤 一郎,200
```

- 名前にカンマを含む場合はダブルクォートで囲む
- 回数が整数として読めない行は読み込み対象外
- フロントは読み込み時に、同じ名前の行は回数を合計し、回数の降順に並べる

## 開発方針

- TDD(テスト駆動開発)で進める。不具合修正は、先に失敗するテストを書く
- コンポーネント・フックの冒頭に日本語で仕様コメントを記述
- 宛先とCCは完全に独立した状態管理(`RecipientPane` ごとに `useSearch`)
- 機能ごとの状態は `hooks/`、表示は `components/`、副作用のない処理は `utils/` に置き、`App.tsx` は接続だけにする
- ダークモードをデフォルトで使用
- フロントを変更したら `npm run build` で `dist/` を更新してコミットする
