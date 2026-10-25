# AGENTS.md

このリポジトリの開発仕様の正本は [CLAUDE.md](claude.md)（`docs/claude.md` へのシンボリックリンク）です。作業前に必ず読んでください。

- 使い方・API一覧: [README.md](README.md)
- 機能別の詳細設計と図: [docs/](docs/)（画像処理・UI: `docs/specification.md`、3D差分: `docs/3d_cad_diff_specification.md`、Obsidianリンク解決: `docs/obsidian_link_resolution.md`、サーバー設定: `docs/server_settings_management.md`）

## 守ること

- `frontend/dist` はコミット対象です。フロントエンドを変更したら `cd frontend && npm run build` を実行し、`dist` もコミットします。
- `backend/.visual-diff-settings.json` はGit管理のまま（空の初期値）にします。`.gitignore` に入れたり保存先を未追跡ファイルへ移したりしないでください（会社環境の整合性チェックで止まります）。
- テスト: `.venv/bin/python -m unittest discover -s tests` と `cd frontend && npm test`
