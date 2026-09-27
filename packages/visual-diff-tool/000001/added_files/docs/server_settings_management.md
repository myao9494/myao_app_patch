<!--
サーバー設定ファイル（.visual-diff-settings.json）管理および会社環境整合性保証仕様書。
会社環境検証（ファイル不在・整合性チェック）のパス要件、.gitignoreからの除外解除、
安全なデフォルト値の永続化、および不在防止の仕組みについて定義する。
-->

# サーバー設定ファイル管理・会社環境整合性仕様

## 1. 概要と背景
本画像差分ツール（Visual Diff Tool）のバックエンドでは、Obsidian Vaultフォルダーやレポート保存先を永続化するために `backend/.visual-diff-settings.json` を使用します。

### 検出された問題
会社環境検証（ファイル不在・整合性チェック）において以下のエラーが検知され、パッチ公開が中断されました。
> **重要設定ファイル 'backend/.visual-diff-settings.json' がローカルに存在しますが、.gitignoreまたは未コミットのためGit管理に含まれていません。会社環境でファイル不在エラーが発生します。**

従来の `.gitignore` に `backend/.visual-diff-settings.json` が登録されていたため、会社環境（CI/CDや新規クローン環境）において当該ファイルが存在せず、整合性検証ツールによってファイル不在エラーとしてブロックされていました。

---

## 2. 解決方針と設計仕様

### (1) Git管理対象への登録と `.gitignore` の修正
- `.gitignore` から `backend/.visual-diff-settings.json` の除外設定を削除。
- リポジトリに `backend/.visual-diff-settings.json` を追跡対象ファイルとして正式に含める。

### (2) 安全な初期値（デフォルト設定）のコミット
- 開発者個人のローカル絶対パス（`/Users/...` など）をコミットしない。
- 会社環境や他の開発者環境で直ちに利用できるよう、安全な初期設定値として以下を登録・永続化する。

```json
{
  "obsidian_folder": "",
  "obsidian_report_folder": ""
}
```

### (3) ファイル不在・破損時のフォールバック堅牢性
- バックエンドの読み込み関数 `_load_server_settings()` は、万一設定ファイルが存在しない場合や破損している場合でも `FileNotFoundError` / `JSONDecodeError` を安全にハンドリングし、空の辞書 `{}` を返すことでサーバークラッシュを防止。
- 設定更新時（`_save_server_settings()`）は一時ファイル（`.tmp`）を経由してアトミックに書き込みを行い、ファイル破損を防ぐ。

---

## 3. テスト駆動開発（TDD）による保証

`tests/test_server_settings.py` により、以下の整合性を継続的にテスト・保証します。

1. **ファイル存在・JSON有効性**: `backend/.visual-diff-settings.json` がリポジトリ内に存在し、正しいJSON形式であること。
2. **安全な初期値検証**: 必須キー（`obsidian_folder`, `obsidian_report_folder`）が含まれ、環境固有の絶対パス（`/Users/` 等）が残っていないこと。
3. **Git管理検証**: `.gitignore` に当該ファイルが指定されておらず、常にGit追跡対象となっていること。
4. **設定取得API正常性**: `/api/settings/obsidian` エンドポイントが正常に設定を返却すること。

---

## 4. 構成図
詳細なフローは [server_settings_management.excalidraw](file:///Users/mine/000_work/app/visual-diff-tool/docs/server_settings_management.excalidraw) を参照。
