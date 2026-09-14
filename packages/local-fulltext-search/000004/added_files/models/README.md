# ベクトル検索用モデル配置ディレクトリ

ここにダウンロードした Hugging Face 形式のモデルフォルダ（例: `ruri-v3-30m`, `ruri-v3-310m`, `ruri-v3-70m` 等）を配置してください。

## フォルダ構成の例
```
models/
  ├── README.md
  └── ruri-v3-30m/
        ├── config.json
        ├── model.safetensors
        ├── tokenizer.json
        └── ...
```

※ `backend/models/` 配下に配置した場合でも、アプリが自動検知して認識します。
※ モデルが配置されていない状態でもアプリは起動し、通常のキーワード検索（FTS5）がご利用いただけます。
