# Frontend (React + TypeScript + Vite)

ガントチャートアプリケーションのフロントエンドです。
画面の仕様は [../docs/SPECIFICATION.md](../docs/SPECIFICATION.md)、コードの構成は [../CLAUDE.md](../CLAUDE.md) を参照してください。

## コマンド

```bash
npm install        # 依存関係のインストール
npm run dev        # 開発サーバー（http://localhost:5172、/api は http://localhost:8000 へ転送）
npm run build      # 型チェック + 本番ビルド（dist/ に出力）
npx vitest run     # テスト
npx eslint .       # lint
```

- 開発サーバーのポートと `/api` の転送先は、環境変数 `GANTT_DEV_PORT` / `GANTT_API_TARGET` で変更できます。
- `dist/` はコミット対象です（Windows でビルドせずに起動できるようにするため）。ソースを変更したら `npm run build` して `dist/` も一緒にコミットしてください。
- PWA（Service Worker）は本番ビルドでのみ有効です。
