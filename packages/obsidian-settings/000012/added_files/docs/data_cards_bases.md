# 仕様: コアプラグインBasesを用いたアセットカードビューの設計メモ
# 対象: 01_data内の画像・ExcalidrawファイルをBasesでカード表示していた旧方式

# コアプラグインBasesによる画像・Excalidrawカードビュー

> **現状（2026-10-10 時点）**: `02_view/data_cards.base` と `02_view/common_image_cards.base` は削除済みで、画像・Excalidrawのカード表示は画像一覧プラグイン（`obsidian-excalidraw-cards`、[excalidraw_cards.md](excalidraw_cards.md)）へ置き換えた。以下は旧方式の設計メモ。対応するテスト（`scratch/test_data_cards_duplicate.js`、`scratch/test_common_image_cards.js`）も削除済み。

## 1. 概要
`01_data` ディレクトリ配下に保存されている画像アセット（PNG、JPG等の各種画像）および `.excalidraw.md` イラストファイルを、Obsidianの公式コアプラグイン「Bases（データベース機能）」を使用して、グリッドカード形式（ギャラリー表示）で一覧表示する旧方式の設計メモです。

不要なMarkdownのテキストメモやPDF/ZIP等のファイルは自動フィルターにより完全に除外されます。また、新規に追加または更新されたファイルが常に先頭に表示されるよう、更新日時（`file.mtime`）の降順で一括ソートされます。

現在の推奨実装は、自作プラグイン `obsidian-excalidraw-cards` の「画像一覧の表示」ビューです。Bases方式は過去の検討・比較用として残し、通常利用では `obsidian-excalidraw-cards:excalidraw_open_close` コマンドを使用します。

---

## 2. 実装されたファイル
- **ベース定義ファイル**: `02_view/data_cards.base`
  - このファイルはYAMLフォーマットで記述されたBasesプラグインの設定ファイルです。

---

## 3. 設定の詳細 (YAMLスキーマ)

```yaml
filters:
  and:
    - file.path.startsWith("01_data")
    - or:
        - file.name.endsWith(".png")
        - file.name.endsWith(".jpg")
        - file.name.endsWith(".jpeg")
        - file.name.endsWith(".gif")
        - file.name.endsWith(".bmp")
        - file.name.endsWith(".svg")
        - file.name.endsWith(".webp")
        - file.name.endsWith(".excalidraw.md")

views:
  - type: cards
    name: "アセットカード一覧"
    search: ""
    sorts:
      - property: file.mtime
        direction: DESC
```

### フィルタリングの詳細
- `file.path.startsWith("01_data")`: 検索範囲を `01_data` ディレクトリに限定します。
  - **重複防止の仕組み**: 従来の `file.inFolder("01_data")` はディレクトリを再帰的に走査する設計になっており、Basesプラグインがスキャンする過程で同一のファイルを重複して結果に push してしまうバグを誘発していました。再帰走査を行わず文字列としてパスを判定する `file.path.startsWith` に切り替えることで、画像の重複表示問題を完全に排除します。
- `or` 条件: 画像拡張子（`.png`〜`.webp`）、またはファイル名の末尾が `.excalidraw.md` であるファイルに合致するもののみを抽出します。これによって通常のテキストメモなどが除外されます。

### ビューとソートの詳細
- `type: cards`: グリッド状にカバー画像付きでファイルを並べる「カードビュー」を指定しています。
- `property: file.mtime`, `direction: DESC`: 更新日時の新しい順（降順）でソートします。
- `search: ""`: 検索・フィルタリング用のキーワードを格納するフィールドです（初期値は空）。

---

## 4. 使用方法とカスタマイズ
1. **ビューの閲覧**:
   - 旧方式では、Obsidian上で `02_view/data_cards.base`（全体画像）または `02_view/common_image_cards.base`（共通画像）を開くと、ネイティブのグリッドカード形式でプレビューが自動レンダリングされます。
   - 現行方式では、リボンアイコンまたはコマンド `obsidian-excalidraw-cards:excalidraw_open_close` から「画像一覧の表示」を開きます。
2. **GUIによるカスタマイズ**:
   - カラムの並び順の変更や、新しいソートキーの追加、日付やプロパティでの追加のフィルタリングは、ObsidianのBases画面上のGUIメニューから直感的に行うことができます。

---

## 5. 共通画像カードビュー (common_image_cards.base)

### 概要
共通の画像アセット（`01_data/common_image`）のみを表示対象とする専用のカードビューです。
保管庫内のすべての画像を表示する全体用カードビュー（`data_cards.base`）とは目的が異なり、執筆時によく使う共通の枠組み・素材画像を素早く探して再利用することを目的としています。

### 設定 (YAML)
```yaml
filters:
  and:
    - file.path.startsWith("01_data/common_image")
    - or:
        - file.name.endsWith(".png")
        - file.name.endsWith(".jpg")
        - file.name.endsWith(".jpeg")
        - file.name.endsWith(".gif")
        - file.name.endsWith(".bmp")
        - file.name.endsWith(".svg")
        - file.name.endsWith(".webp")
        - file.name.endsWith(".excalidraw.md")
views:
  - type: cards
    name: ビュー
    cardSize: 130
    image: file.file
    imageAspectRatio: 1
    search: ""
    sorts:
      - property: file.mtime
        direction: DESC
```

---

## 6. エディタフォーカス自動復帰 (UX設計)
- コマンド `obsidian-excalidraw-cards:excalidraw_open_close` やサイドバーボタンを使用してビューを「起動（開く）」および「閉じる（トグル解除でタブをdetachする）」際、**自動的に元のアクティブなエディタ（編集中のマークダウンファイル）へカーソルフォーカスを戻す、あるいはフォーカスを維持します**。
- これにより、表示された画像を横目に確認しながら、あるいはビューを閉じて画面を広くしながら、ユーザーはマウス操作を挟むことなく、そのままマークダウンの執筆（文字入力）を流れるように継続できます。
- 元のアクティブなエディタLeafの取得は `workspace.getActiveLeaf()` を標準としつつ、APIバージョンやプロキシ環境下での仕様差に対応するため、`workspace.getMostRecentLeaf()` および `workspace.activeLeaf` への三重のフォールバックチェーンを実装し、いかなる場合もエラーで起動・終了プロセスが妨げられないように堅牢化しています。
