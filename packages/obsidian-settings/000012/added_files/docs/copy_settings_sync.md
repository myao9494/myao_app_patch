# 設定同期スクリプト（copy_settings.py）完全ミラー同期 仕様書

Obsidianの設定、プラグイン、テンプレート、ドキュメント等をバックアップ・設定リポジトリ（`obsidian_setting_myao`）へ完全に同一（ミラー状態）で同期するためのスクリプト仕様書です。

## 対象スクリプト
[copy_settings.py](file:///Users/mine/000_work/obsidian-dagnetz/80_script/copy_settings.py)

## 課題と解決策

### 課題（以前の動作）
- 従来の `shutil.copytree(source, dest, dirs_exist_ok=True)` では、ファイルの「追加・上書き」のみが行われていました。
- コピー元でプラグインを削除したり、古いCSSスニペットやファイルを削除しても、コピー先には残ったままになってしまい、不整合（ゾンビファイル）が発生していました。

### 解決策（完全ミラー同期）
- コピー先の該当ディレクトリを丸ごと置き換えます。コピー元で削除されたファイルやプラグインがコピー先からも確実に削除され、完全なクローン（ミラー）状態が維持されます。
- 置き換えは次の順で行い、コピーが途中で失敗しても既存のバックアップが失われないようにしています。
  1. コピー先の隣の一時フォルダ（`<フォルダ名>.sync_tmp`）へ `shutil.copytree` でクリーンコピーする。
  2. コピーが完了してから、既存のコピー先を `shutil.rmtree` で削除する。
  3. 一時フォルダをコピー先の名前へリネームする。
- コピーに失敗した場合は一時フォルダを片付けて処理を中断し、既存のコピー先はそのまま残ります。前回の実行が途中で止まって一時フォルダが残っている場合は、次回の実行時に削除してからコピーします。
- コピー元フォルダが存在しない場合は警告を表示してスキップします（コピー先は変更しません）。

## 同期対象ディレクトリ一覧

| フォルダ名 | 内容 |
| :--- | :--- |
| `.obsidian` | 設定、プラグイン、テーマ、CSSスニペット |
| `00_templates` | テンプレートファイル |
| `80_script/register_custom_commands` | 起動時テンプレート（`RegisterCustomCommands.md`）が読み込む、カスタムコマンドのスクリプト本体 |
| `02_view` | 各種ビュー設定（現在の保管庫には存在しないため、実行時は警告を出してスキップされる） |
| `90_batch` | バッチスクリプト群 |
| `01_data/common_image` | 共通画像ファイル |
| `03_Dataview` | Dataviewクエリ・スクリプト |
| `04_pptx` | PPTXプレゼン資料 |
| `Excalidraw` | Excalidraw描画ファイル |
| `docs` | 仕様ドキュメント群 |

## 関連図解
- [copy_settings_sync_diagram.excalidraw.md](file:///Users/mine/000_work/obsidian-dagnetz/docs/copy_settings_sync_diagram.excalidraw.md)
