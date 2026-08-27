# Obsidian Excalidraw 互換機能仕様書

## 概要
Obsidian Vault 内に保存される Excalidraw ファイル (`.excalidraw.md` または移行対象の `.excalidraw`) を、本アプリケーションで直接閲覧・編集・保存できるようにするための仕様です。
ファイルパスに `obsidian` が含まれる場合、自動的に Obsidian 互換モードとして動作します。

## 対象ファイル
以下の条件のいずれかを満たすファイルを対象とします。
1. **パス**: `obsidian` を含み、拡張子が `.excalidraw.md`。
2. **パス**: `obsidian` を含み、拡張子が `.excalidraw` (移行対象)。

## 実装方針 (Backend)

`backend/main.py` 内の `load_file` および `save_file` を改修し、パスによる条件分岐を導入します。

### 0. 依存ライブラリの追加
- `lzstring`: Obsidian プラグイン互換の圧縮・解凍に使用。
- `requirements.txt` に追加。

### 1. 読み込み処理 (`load_file`)

**フロー:**
1. ファイルパスと拡張子をチェック。
2. **Obsidianフォルダ内の `.excalidraw` リクエストの場合**:
    - 同名の `.excalidraw.md` が存在するか確認する。
    - **存在する場合**: リクエストされたパスを `.excalidraw.md` に読み替えて、以下の Obsidian 読み込みフローを実行する（移行済みファイルの優先）。
    - **存在しない場合**: 通常の JSON ロード処理 (`load_json_file`) を実行。
3. **Obsidian対象 (.excalidraw.md)** の場合:
    - ファイルをテキストとして読み込む。
    - 正規表現を用いて、Markdown 内の JSON ブロックを抽出する。
        - 検索パターン: ``` ```json\n(.*?)\n``` ``` (最短マッチ、複数行対応)
    - **圧縮判定と解凍**:
        - 抽出した文字列が JSON としてパースできない場合、`lzstring` で解凍を試みる。
        - 解凍後も不正な場合は 400 を返す。
    - `## Embedded Files` セクションがある場合は、同一ディレクトリ、Vaultルート、親ディレクトリを探索して画像ファイルを復元し、フロントエンドには `dataURL` を含む `files` を返す。
    - パースしたデータ (`elements`, `appState` 等) をフロントエンドに返す。

### 2. 保存処理 (`save_file`)

**フロー:**
1. ファイルパスと拡張子をチェック。
2. **Obsidian対象** の場合:
    - **保存パスの決定**:
        - バックエンド単体では、リクエストで指定された拡張子をそのまま使用する。
        - `obsidian` フォルダ内の `.excalidraw` を `.excalidraw.md` に移行する処理は、フロントエンド (`ExampleApp.tsx`) 側で初回読み込み時に行う。
    - **バックアップ**: `create_backup` を**実行しない**。
    - **保存データの準備**:
        - フロントエンドから送られてきた JSON データを文字列化する。
        - **圧縮処理**: `lzstring` を使用してデータを圧縮する。
    - **ファイル書き込み**:
        - **既存ファイル (.excalidraw.md) がある場合**:
            - 元の Markdown ファイルを読み込む。
            - 既存の JSON ブロック (```json ... ```) を特定し、コンテンツを**圧縮済みの文字列**で置換する。
            - YAML Frontmatter や `# Text Elements` など、他の部分は維持する。
        - **新規ファイル (または移行) の場合**:
            - 以下のテンプレートを使用してファイルを生成する（JSON部分は圧縮文字列を埋め込む）。
            - フロントエンド移行時は元の `.excalidraw` を `backup/` にアーカイブし、その後 `.excalidraw.md` を使用する。

**新規作成用テンプレート:**
```markdown
---
tags: [excalidraw]
excalidraw-plugin: parsed
excalidraw-plugin-version: 2.0.0
---

# Text Elements


# Drawing
```json
{COMPRESSED_DATA}
```
```

### 3. 画像の扱い
- 保存時は `files` 内の `dataURL` を外部画像ファイルとして保存し、`## Embedded Files` に Wikilink を出力する。
- 読み込み時は `## Embedded Files` と `files` を突き合わせて `dataURL` を補完する。
  - **インデックス辞書探索**: Vaultのルート配下にある自動生成インデックス辞書 `.obsidian/plugins/obsidian-sidebar-explorer/image_paths.json` を優先して使用する。
  - **Obsidian外移動・ローカル探索**:
    - フォルダごとVault外に移動した場合など、インデックス辞書で解決できない場合は以下の順で探索する:
      1. 同一ディレクトリ直下（`file_path.parent`）
      2. 同一ディレクトリ直下の添付サブフォルダ（`attachments`, `assets`, `images`, `img`, `files`, `resources`, `_resources`, `.attachments`）
      3. Vaultルート（存在する場合）およびその添付サブフォルダ
      4. 親ディレクトリ（`file_path.parent.parent`）
    - **リンク形式・表記ゆれ対応**:
      - パス付きリンク（例: `[[attachments/image.png]]`）であっても、同一フォルダ直下に `image.png` があれば自動解決。
      - パイプ・サイズ指定（例: `[[image.png|200]]`）やアンカー（`#`）の自動除去。
      - URLエンコードされたファイル名（例: `[[My%20Image.png]]`）の自動デコード。
      - 拡張子省略リンク（例: `[[image]]`）に対する画像拡張子（`.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.webp`, `.bmp`, `.ico`, `.md`）の自動補完。
      - 大文字小文字の違い（例: `image.PNG` と `image.png`）の自動吸収（Case-insensitive探索）。

## 技術詳細

### Python ライブラリ
- `re`: 正規表現によるブロック抽出。
- `lzstring`: `pip install lzstring`。
    - 注意: JSの `lz-string` と互換性のある Python 実装を選定する必要がある (通常 `lzstring` パッケージで可)。

## テスト計画
1. **通常ファイルテスト**: 既存の `.excalidraw` ファイルが問題なく読み書きできること。
2. **Obsidian 新規保存**: `obsidian` フォルダ配下に新規保存し、Obsidian アプリで開けること。
3. **Obsidian 既存編集**: Obsidian で作成したファイルを編集し、保存しても他の Markdown 要素（Frontmatter等）が消えないこと。
4. **バックアップなし**: Obsidian モード時に `backup` フォルダが作成されないこと。

## 参考資料
- [obsidian-excalidraw-plugin GitHub](https://github.com/zsviczian/obsidian-excalidraw-plugin)
- [Compression logic (LZ-String)](https://github.com/pieroxy/lz-string/)
