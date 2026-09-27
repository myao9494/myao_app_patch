# Obsidian Markdown 起点のリンク画像差分検出 仕様書

## 概要
ObsidianのMarkdownファイル（例: `scratch/test_convert.md`）を起点としてGit差分を取得する際、そのMarkdown内で呼び出されている画像（Excalidraw, SVG, PNG等）に変更がある場合、自動的に関連ファイルとして解決し差分一覧に表示する仕組みの仕様です。

## 課題と原因分析
以前の実装では以下の問題により、Markdown内で呼び出されている画像が差分として検出されないケースがありました：

1. **Vaultルート依存のショートリンク解決失敗**:
   - Obsidianではフォルダ階層に関わらず、ファイル名のみで画像や図面を参照する「ショートリンク（最短パス）」記法（例: `![[図_test_convert.excalidraw|525]]`, `![[test_convert.drawio.svg]]`）が標準です。
   - バックエンド設定（`backend/.visual-diff-settings.json`）の `obsidian_folder` が未設定または別フォルダを指している場合、`vault_root` が `None` となり、別サブフォルダ（例: `01_data/2026/08/05/`）にある画像が解決されず `related_paths` から漏れていました。
2. **Git追跡ファイルの活用不足**:
   - 作業ツリーで画像が削除された場合（HEADにのみ存在）、ファイルシステム上の走査では見つからないため検出できませんでした。
3. **日本語ファイル名のエスケープ**:
   - Gitの標準設定では非ASCII文字が8進数エスケープされるため、Python文字列との照合で不一致を起こす懸念がありました。

## 解決策・新仕様

### 1. Obsidian Vaultルートの多階層自動検出 (`_find_vault_root`)
- **優先度1**: バックエンド設定 `obsidian_folder` が指定されており、対象Gitリポジトリ（`repo`）と親子または同一である場合はそれを優先。
- **優先度2**: 対象Markdownファイルから上位フォルダへ順に遡り、`.obsidian` ディレクトリが存在するフォルダを自動的にVaultルートとして検出。
- **優先度3**: リポジトリルート自身に `.obsidian` があるか確認。
- **フォールバック**: 設定や `.obsidian` がない場合でも、対象Gitリポジトリ（`repo`）自身をVaultルートとして探索。

### 2. Git管理下ファイル優先探索による高速化と削除画像対応
- `_git(["ls-files"], repo)` を `-c core.quotepath=false` を指定して呼び出し、日本語ファイル名をUTF-8のまま高速取得。
- ショートリンクのファイル名（例: `図_test_convert.excalidraw.md`, `test_convert.drawio.svg`）をGit追跡ファイルリストから即座にマッチング（O(1)〜O(N)）。
- 作業ツリーで削除された画像ファイル（HEADのみに存在）もGit追跡情報から捕捉し、差分（`change_type: deleted`）として確実に検出。

### 3. 画像拡張子の自動補完
- `![[image_name]]` のように拡張子が省略されているリンクに対し、`.md` のみならず主要な画像拡張子（`.png`, `.svg`, `.jpg`, `.jpeg`, `.webp`, `.excalidraw`, `.excalidraw.md`, `.pdf` 等）を候補として順次解決。

### 4. URL形式リンク内のローカルファイルパス抽出
- `[図](http://localhost:3001/?filepath=/absolute/or/relative/path/to/diagram.svg)` のように、URLクエリパラメータ（`filepath=`, `path=`, `file=`）にローカルファイルパスが含まれている場合、URLデコードしてリポジトリ内相対パスとして解決。

## 関連図面
- `docs/obsidian_link_resolution.excalidraw`: Vault自動検出およびリンク画像解決フロー図
