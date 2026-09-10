# OR検索（OR / or）機能仕様書

## 概要
検索キーワードを `OR` または `or` で繋いだ場合に、指定したいずれかのキーワードを含むドキュメントを抽出する OR 検索機能を提供する。API および Web UI、ランチャーからの検索で共通して利用可能。

## 仕様
1. **演算子**:
   - `OR` および `or`（大文字・小文字不問）を OR 演算子として扱う。
   - 例: `apple OR banana`, `apple or banana` -> `apple` または `banana` を含むファイルがヒット。
2. **AND / OR の複合結合 (AND of ORs)**:
   - `OR` で接続された連続するキーワード群をひとつの「ORグループ（いずれか1つに一致）」とする。
   - 空白で区切られた ORグループ同士は「AND（すべてに一致）」として扱う。
   - 例: `report 2025 OR 2026` -> `report` AND (`2025` OR `2026`)
   - 例: `apple OR banana orange OR grape` -> (`apple` OR `banana`) AND (`orange` OR `grape`)
3. **除外語 (`-keyword`) との組み合わせ**:
   - `-keyword` は除外対象として抽出され、ORグループの条件を満たしつつ除外語を含まないファイルを返す。
   - 例: `alpha OR beta -archived` -> `alpha` または `beta` を含み、`archived` を含まないファイル。
4. **エスケープおよびフォールバック**:
   - `\OR` や `\or` は演算子ではなく通常の検索単語 `"OR"`, `"or"` として扱う。
   - `q="OR"` のように OR のみ入力された場合は、通常単語 `"OR"` として安全に検索する。
5. **他検索ターゲットとの連携**:
   - **同義語展開**: OR グループ内の各単語について同義語を展開し、グループ内の OR 候補に追加。
   - **フォルダ検索**: SQL WHERE 句でグループごとに `(lower(folder) LIKE ? OR ...)` を生成。
   - **gantt タスク検索**: タスク本文に対して全 OR グループのいずれかに一致するか判定。
   - **Web ページ検索**: ローカルファイルと同様に FTS5 / DB クエリエンジンで OR 検索可能。
   - **ハイライト**: スニペット生成時に全 OR キーワードをハイライト対象とする。

## 変更対象ファイル
- `backend/app/services/search_service.py`
- `backend/tests/test_search_service.py`
- `backend/tests/test_search_api.py`
- `AGENTS.md`
- `docs/or_search_spec.md`

---

# MSG / メールファイルアイコン仕様書

## 概要
`.msg`（Outlook メッセージファイル）および `.eml` の検索結果に対し、視認性の高い専用の Catppuccin スタイル封筒（メール）アイコン（`email.svg` / `email.png`）を表示する。

## 仕様
1. **デザイン & スタイル**:
   - Catppuccin スタイル準拠の線画封筒アイコン（16x16 viewBox、1px線幅、角丸）。
   - カラー: Outlook やメールを象徴する Catppuccin Blue（`#1E66F5`）。
   - 封筒の外枠角丸長方形と上部フラップの折れ線で構成。
2. **対象拡張子**:
   - `.msg`（Outlookメッセージ）
   - `.eml`（RFC 822 / MIMEメール）
3. **反映範囲**:
   - Web クライアント（React / Vite）: `frontend/src/fileIcon.ts`
   - デスクトップランチャー（macOS PyObjC / Python Flet）: `launcher/src/launcher_app/file_icons.py`
   - Windows WPF ランチャー（C#）: `launcher/windows/LocalSearchLauncher/SearchModels.cs`
4. **同梱アセット**:
   - SVG: `frontend/public/icons/catppuccin/email.svg`, `frontend/dist/icons/catppuccin/email.svg`, `launcher/src/launcher_app/assets/catppuccin/email.svg`
   - PNG (32x32): `launcher/windows/LocalSearchLauncher/Assets/catppuccin/email.png`, `launcher/windows/publish/folder/Assets/catppuccin/email.png`, `launcher/windows/publish/single-file/Assets/catppuccin/email.png`

