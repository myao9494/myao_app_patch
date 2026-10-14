# Obsidian 互換

[Obsidian Excalidraw プラグイン](https://github.com/zsviczian/obsidian-excalidraw-plugin) の
`.excalidraw.md` を、このアプリと Obsidian の両方で開いて編集できるようにする。
実装: `backend/obsidian_markdown.py`（形式）、`backend/obsidian_files.py`（画像）、
`utils/embeddedMarkdown.ts`（埋め込みノート）。

## 対象ファイル

| ファイル | 扱い |
| --- | --- |
| `*.excalidraw.md` | 常に Obsidian 形式 |
| Front Matter に `excalidraw-plugin: parsed` を持つ `*.md` | Obsidian 形式（通常の名前のノートも可） |
| Vault 内、またはパスに `obsidian` を含む `*.excalidraw` | 開いたときに `*.excalidraw.md` へ変換（下記） |

Vault は、ファイルから親フォルダをたどって `.obsidian/` フォルダがある場所。

## ファイル形式

```markdown
---

excalidraw-plugin: parsed
tags: [excalidraw]

---
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== ...


# Excalidraw Data

## Text Elements
テキストの内容 ^要素ID

## Embedded Files
fileId: [[画像ファイル名.png]]

%%
## Drawing
```compressed-json
（Excalidraw JSON を LZString の Base64 で圧縮し、256 文字ごとに空行を挟んで改行）
```
%%
```

### 読み込み

- `## Drawing` 見出しの下の ```` ```compressed-json ```` を優先して取り出す（旧形式の ```` ```json ```` も可）。
  見出しがない旧形式では最初のブロックを使う。`## Drawing` があるのにブロックがなければ、
  後ろのメモにある JSON を図面と誤認しない
- 圧縮されていなければそのまま、圧縮されていれば改行・空白を除いて解凍する
- JS の LZString は UTF-16 コードユニット単位で扱うため、解凍後にサロゲートペアを結合する（絵文字の文字化け対策）

### 保存

- 新規: 上のテンプレートで作る
- 既存: **図面ブロック・`## Text Elements` 本文・`## Embedded Files` 本文だけ** を置き換える。
  Front Matter・本文のメモ・その他の見出しはそのまま残す。旧形式の ```` ```json ```` は ```` ```compressed-json ```` に正規化する
- Text Elements: 削除されていないテキスト要素を `<本文（改行維持、末尾の空白除去）> ^<要素ID>` の形で並べる
- 圧縮前に UTF-16 サロゲートペアへ分解する（JS 版と同じ結果にするため）
- バックアップは作らない（Obsidian 側の履歴・同期に任せる）

## 画像（Embedded Files）

### 保存時

- `files` の画像（dataURL）を外部ファイルとして書き出し、Markdown には `[[リンク]]` だけを残す（dataURL は Markdown に入れない）
- 既にリンクがある画像は、**リンクの文字列を変えずに** そのリンク先を上書きする
  （図面からの相対パス → Vault ルートからの相対パス → 見つからなければ図面と同じフォルダに同名で保存）
- 新しい画像は図面と同じフォルダに `<fileId>.<拡張子>` で保存する
- 埋め込みノートの表示用 SVG（`isEmbeddedMarkdownSnapshot`）は書き出さない

### 読み込み時

`[[リンク]]` を次の順で探し、見つかった画像を dataURL として `files` に補完する。

1. Vault の `.obsidian/plugins/obsidian-sidebar-explorer/image_paths.json`（あれば）
2. 図面と同じフォルダ
3. 同じフォルダの添付用サブフォルダ（`attachments` `assets` `images` `img` `files` `resources` `_resources` `.attachments`）
4. Vault ルートとその添付用サブフォルダ
5. 1つ上のフォルダ

`[[a.png|200]]` のサイズ指定・`#` アンカーは除き、URL エンコードは戻し、拡張子のないリンクは
画像拡張子（と `.md`）を補い、大文字・小文字の違いも吸収する。
フォルダごと Vault の外へ移動しても、同じフォルダ・サブフォルダにある画像なら表示できる。

## ノートの埋め込み

Obsidian では別の Excalidraw ノートを `[[ノート名]]` で画像として埋め込める。

- リンク先が `.md` のノートなら、フロントエンドがそのノートを読み込んで SVG に描画して表示する（入れ子・循環にも対応）
- Obsidian が書き出した `.svg` スナップショットしかない場合は、同じフォルダの Excalidraw ノートを候補にし、
  候補が1つならそれ、複数なら描画した形状が一致するものを元ノートとみなす
- 埋め込み画像を右クリックすると「webアプリで編集」「obsidianで表示」を選べる

## `.excalidraw` → `.excalidraw.md` の変換

Vault 内（またはパスに `obsidian` を含む）の `.excalidraw` を開くと:

1. 同じ内容で `<名前>.excalidraw.md` を作る
2. 画面とURLを `.excalidraw.md` に切り替える
3. 元の `.excalidraw` を `backup/<名前>_<日時>.excalidraw` に移動する

判定はバックエンドが行い、`/api/load-file` の `shouldMigrateToMarkdown` で通知する。
変換に失敗した場合は `.excalidraw` のまま JSON 形式で編集を続ける
（Vault 内でも `.excalidraw` に Markdown を書き込むことはない）。

## 外部更新

Obsidian で同じノートを編集・保存すると、このアプリは次の編集時（最短5秒ごと）または保存前に更新を検知し、
最新の内容を読み込んで画面を置き換え、保存し直す（[features.md](features.md#3-外部更新別タブobsidian他の人による更新)）。

## Obsidian を開く

- 図形リンク `obsidian://open?vault=<Vault名>&file=<Vault内のパス>` をクリックすると、
  バックエンドの `/api/open-url` が OS の URL ハンドラー（macOS `open`、Windows `os.startfile`、Linux `xdg-open`）で開く
- 埋め込みノートの「obsidianで表示」は、port 8001 のリダイレクトサービスが Vault 内のパスを
  `obsidian://` URL に変換して開く（[external_dependencies.md](external_dependencies.md)）

## 互換性が崩れたとき

Obsidian プラグインの更新で形式がずれた場合は、[MAINTENANCE_PROMPT.md](MAINTENANCE_PROMPT.md) を参考に修正し、
`tests/obsidian_test/` の実ノート（Obsidian で作成）を使った往復テスト `tests/test_api_integration.py` で確認する。
