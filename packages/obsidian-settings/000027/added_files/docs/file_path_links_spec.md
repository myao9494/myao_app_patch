# 仕様書: ファイルのリンクにパスを入れる（file:///）

## 1. 概要
From Clipboard（スラッシュコマンド）とファイルマネージャーからのドロップで作るファイル・フォルダのリンクは、リンク先にパスそのものを `file:///` の URL として入れる。
以前はファイルマネージャーで開く URL（`http://localhost:8001/api/open-path?path=<エンコードしたパス>`）を入れていたが、パスがエンコードされて URL の中に埋もれるため、Claudian などの AI がリンクからパスを読み取りにくかった。

リンクをクリックしたときは、今までどおりファイルマネージャー（localhost:8001）で開く。

## 2. リンクの形
| パス | リンク |
| --- | --- |
| `/Users/mine/作業 1/資料(最新).pdf` | `[資料(最新).pdf](file:///Users/mine/作業%201/資料%28最新%29.pdf)` |
| `C:\work\資料.xlsx` | `[資料.xlsx](file:///C:/work/資料.xlsx)` |
| `\\ghi1111.aaa.co.jp@80\PA_Doc\001_日程`（UNC） | `[001_日程](file:////ghi1111.aaa.co.jp@80/PA_Doc/001_日程)` |

- エンコードするのは、Markdown のリンクを切る文字（空白（全角を含む）・半角括弧・`<` `>`）、URL の区切りになる `#` `?`、エンコードの印の `%` だけ。日本語はそのまま残す（`localPathToFileUrl`）。
- UNC パスはスラッシュ4本にする。`file://ghi1111.aaa.co.jp@80/…` は `@80` があるため URL として読めず、Obsidian が「開けない」と通知してリンクを開かない。
- 絶対パスでないもの（`共有/資料` など）は `file:///` にできないため、従来どおりファイルマネージャーの URL にする。
- From Clipboard に以前の形のリンク（`localhost:8001/api/open-path?path=…`）や `file:` の URL を貼った場合も、パスに戻して `file:///` のリンクにする。

## 3. クリックしたとき
- **クリックを先に受け取る**（`handleFileLinkClick`。document の click をキャプチャで受け取る）: Obsidian は外部リンクを開く前に `new URL()` でリンクを確かめ、読めなければ「開けません」と通知して何もしない。Windows の Chromium は `file:////host/…` をネットワークのパスとして読み、ホスト名を確かめるため、SharePoint の `\\host@80\…` のように `@` を含むホスト名はそこで止まる（Mac では止まらない）。そのため、Obsidian より先にクリックを受け取って開く。
  - 閲覧モード: `a.external-link` の `href` が `file:` のもの。
  - 編集画面: `.cm-underline` / `.cm-link` / `.cm-url` をクリックしたとき、クリックした位置の行から `[名前](file:…)` を探す（`findClickedEditorFileLinkUrl` / `findFileLinkUrlAt`）。Obsidian と同じく、ソースモードは Ctrl / Cmd を押したときだけ開き、ライブプレビューは Alt / Shift だけを押したとき、文字を選択しているときは開かない。
  - 左クリックだけが対象。中クリックや「リンクを開く」コマンド（Ctrl / Cmd + Enter）は、`window.open` の差し替え（`installFileUrlOpenPatch`）で受け取る。こちらは Obsidian の確認を通ったあとなので、Windows の `@` を含むホスト名では届かないことがある。
- どちらで受け取っても、次の順に開く（`openFileLinkPath`）。
  1. ファイルマネージャーにパスの種類を聞く（`GET http://localhost:8001/api/path-info?path=<パス>`。`askFileManagerPathType`）。ブラウザの `fetch` はファイルマネージャーの CORS で止まるため、Obsidian の `requestUrl` を使う。
  2. ファイルかフォルダとして見つかれば、今までどおりファイルマネージャーで開く（`http://localhost:8001/api/open-path?path=<パス>` をブラウザで開く）。
  3. 見つからない（`not_found`）、ファイルマネージャーが起動していない、応答しない（設定 `apiTimeout`、既定10秒で 504）ときは、既定の方法で開く（Electron の `shell.openPath`。ファイルは関連付けられたアプリ、フォルダは Explorer / Finder。`openPathWithSystemDefault`）。Windows のネットワークのパス（`\\vsv12\…`）や SharePoint の WebDAV のパス（`\\host@80\…`）は、ファイルマネージャーからは見えなくても Explorer では開けることがあるため。
  4. それでも開けなければ、パスと理由を通知する（10秒）。
- ファイルマネージャーで開いたあとの結果（ブラウザで開いたページでの失敗）は Obsidian に返ってこない。`open-path` をブラウザで開くと、ファイルマネージャーは見つからないパスを「パスが見つかりません」のページ（404）で知らせるだけで、Obsidian からは分からない。そのため、開く前に `path-info` で確かめている。
- `file:` の URL をパスに戻す（`fileUrlToLocalPath`）。`file:///C:/…` は `C:\…`、`file:////host/…` と `file://host/…` は `\\host\…`、`file://localhost/…` と `file:/…` はそのままのパスにする。
- Mac では、別の Mac で作ったリンクも開けるよう、パスの `/Users/<ユーザー名>` を今のユーザーに置き換える（`/Users/Shared` は置き換えない）。以前の形のリンクでは Sidebar Explorer Tag の `rewriteLocalhostLinkForMac` が同じことをしている。
- テンプレートを読み直したときは、前回の差し替えを外してから付け直す（二重にしない）。

## 4. 右クリックメニュー「コピーして同一フォルダーに保存」
- `file:///` のリンクでも、以前の形のリンクでも使える（`findOpenPathLinks` / `extractOpenPathFromLink`、閲覧モードは `a[href^='file:' i]`）。
- 閲覧モードの `href` はエンコードし直されていて本文の文字と一致しないことがあるため、一致しなければリンク先のパスが同じリンクを書き換える（`replaceOpenPathLink`）。

## 5. 以前のリンクの一括変換
[80_script/convert_open_path_links.js](../80_script/convert_open_path_links.js) で、ノートにある以前の形のリンクを `file:///` のリンクへ書き換える。Node が使えない環境では、同じ内容の Python 版 [80_script/convert_open_path_links.py](../80_script/convert_open_path_links.py) を使う（引数と表示は同じ。`python3 80_script/convert_open_path_links.py --write`）。

```bash
node 80_script/convert_open_path_links.js            # 確認だけ（書き換える箇所を表示する）
node 80_script/convert_open_path_links.js --write    # 書き換える
node 80_script/convert_open_path_links.js --write 01_data/2026   # フォルダやファイルを指定する
```

- `[名前](URL)` はリンク先だけを、`<URL>` と本文にそのまま書いた URL は `[パスの最後の名前](file:///…)` に書き換える。パスへの変換は From Clipboard と同じ関数を使う。
- 改行コード（CRLF）は変えない。
- 変換のきまりを変えるときは、JS 版・Python 版・From Clipboard（`localPathToFileUrl`）の3か所をそろえる。
- 2026-11-17 に、この保管庫の 14 ファイル・16 件を変換済み。残りは絶対パスでない 1 件（`01_data/2026/08/21/mtejhia.excalidraw.md`。リンク先に文章が入っている）。
- 書き換えないもの: コードブロックとインラインコードの中、絶対パスでないもの（一覧に出す）、Excalidraw の図のデータ（`# Excalidraw Data` 以降）、隠しフォルダ・`node_modules`・`docs`・`scratch`・`00_templates`・`80_script`・保管庫の直下のファイル、`localhost:3001/?filepath=…`（Excalidraw の Web アプリで開くリンク）。

## 6. 実装対象
- [80_script/register_custom_commands/11_from_clipboard.js](../80_script/register_custom_commands/11_from_clipboard.js)（`localPathToFileUrl` / `fileUrlToLocalPath` / `buildOpenPathUrl`、From Clipboard のリンク）と [00_templates/From Clipboard.md](../00_templates/From%20Clipboard.md)（同じ実装）
- [80_script/register_custom_commands/18_file_manager_and_editor_menu.js](../80_script/register_custom_commands/18_file_manager_and_editor_menu.js)（ドロップのリンク、リンクの検出、クリックしたときの差し替え）
- [80_script/register_custom_commands/25_tag_menu_top_notes_drop.js](../80_script/register_custom_commands/25_tag_menu_top_notes_drop.js)（閲覧モードの右クリックメニュー）
- [80_script/convert_open_path_links.js](../80_script/convert_open_path_links.js)（一括変換）と [80_script/convert_open_path_links.py](../80_script/convert_open_path_links.py)（Python 版）

## 7. テスト
- [scratch/test_from_clipboard.js](../scratch/test_from_clipboard.js)（From Clipboard のリンク、パスと URL の行き来）
- [scratch/test_file_manager_links.js](../scratch/test_file_manager_links.js)（ドロップのリンク、検出、置き換え、クリックしたときの URL、`window.open` の差し替え）
- [scratch/test_file_manager_dnd_and_copy.js](../scratch/test_file_manager_dnd_and_copy.js)
- [scratch/test_convert_open_path_links.js](../scratch/test_convert_open_path_links.js)（一括変換）
- [scratch/test_convert_open_path_links.py](../scratch/test_convert_open_path_links.py)（Python 版。`python3 scratch/test_convert_open_path_links.py`。Node があれば JS 版と結果が同じことも確かめる）

## 8. 変更履歴
- **2026-11-17**: 新規作成。リンク先をファイルマネージャーの URL からパス（`file:///`）に変更し、クリック時の差し替えと一括変換スクリプトを追加。
