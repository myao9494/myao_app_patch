# AGENTS.md - File Manager プロジェクト

このリポジトリの開発ガイドライン（開発方針・コード規約・構成・テスト方法・ドキュメント更新ルール）は
**[CLAUDE.md](CLAUDE.md)** に一本化しています。AIエージェント（Codex / Gemini など）も CLAUDE.md に従ってください。

特に次の2点は必ず確認してください。

- **ファイル操作の安全ルール**（CLAUDE.md「ファイル操作の安全ルール」、`docs/file_safety.md`）:
  ファイルが勝手に消えないことを最優先にする。削除はゴミ箱へ、衝突時は変更しない、検証してから移動元を削除する。
- **テスト**: 変更後は `cd backend && pytest -q`、`cd frontend && npm test && npx tsc -b && npm run lint` がすべて通ること。
