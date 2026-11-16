# Obsidian Terminal プラグイン設定修正

## 概要
Obsidianのターミナルプラグインから起動したターミナルで `code` コマンドが見つからない問題を解決しました。

## 原因
Obsidian内のターミナルがログインシェルとして起動されていなかったため、`~/.zshenv` や `~/.zprofile`, `~/.zshrc` などで設定されているPATH（`/usr/local/bin`など）が読み込まれていませんでした。

## 対応内容
ターミナルプラグインの設定ファイル `.obsidian/plugins/terminal/data.json` を変更し、Mac環境での統合シェルの起動引数に `-l` を追加しました。これによりログインシェルとして起動され、`.zshrc` などが正しく読み込まれるようになります。

### 変更ファイル
- `/.obsidian/plugins/terminal/data.json`
  - `darwinIntegratedDefault` の `"args": []` を `"args": ["-l"]` に変更。

# サイドバーエクスプローラタグ プラグイン修正 (macOSのlocalhostリンク書き換え)

## 概要
複数のMac端末で同じvaultを使用する際、`http://localhost:3001/?filepath=/Users/mine/...` や `http://localhost:8001/api/open-path?path=...` のようなローカルパスを含むリンクで `mine` の部分が端末ごとに変わるため、リンクが機能しなくなる問題に対応しました。

## 対応内容
プラグイン `obsidian-sidebar-explorer-tag` 内で、Mac環境に限り、クリックされた localhost (3001または8001) の filepath リンクに含まれるユーザー名の部分を、現在のマシンのユーザー名にリアルタイムで書き換えて開く処理を追加しました。
- macOS判定: `process.platform === 'darwin'`
- ユーザー名取得: `os.userInfo().username`
- URLの書き換えテスト: `utils.test.ts` に追加 (TDD)
- クリックのインターセプト: `main.ts` にて、DOMクリックではなく `window.open` および `electron.shell.openExternal` をグローバルにモンキーパッチ(monkey-around)することで、Live Preview等からのリンククリックも確実にフックして書き換える。
- 2026-11-17 以降、From Clipboard とドロップで作るファイルのリンクはパスの `file:///` になった。こちらのユーザー名の書き換えは、`file:` のリンクをファイルマネージャーの URL に変えるとき（`18_file_manager_and_editor_menu.js` の `fileUrlToOpenPathUrl`）に行う（[file_path_links_spec.md](file_path_links_spec.md)）。

# サイドバーエクスプローラー ショートカットキー追加

## 概要
サイドバーエクスプローラーでファイルを選択した状態で、特定のキーボードショートカットを利用できるようにしました。

## 対応内容
- **リネーム機能 (Rキー)**: 
    - アイテムを選択した状態で `R` キー（または `r`）を押すと、Obsidian標準のリネームダイアログが表示されます。
    - 修飾キー（Cmd, Ctrl等）がない場合のみ動作します。
    - 検索ボックスなどの入力フィールドにフォーカスがある場合は、通常の文字入力が優先されます。
- **実装箇所**: `plugins/obsidian-sidebar-explorer/view.ts` の `handleKeyDown` メソッド。
