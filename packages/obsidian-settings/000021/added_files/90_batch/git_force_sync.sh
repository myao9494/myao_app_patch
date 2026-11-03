#!/bin/zsh
# リモート（origin/main）の内容を強制的にローカルに反映させるスクリプト（Mac/Linux用）
#
# 仕様:
# 1. リモートから最新情報を取得する (git fetch)
# 2. ローカルのメインブランチをリモートの状態に強制リセットする (git reset --hard)
# 3. 追跡されていないファイルを強制的に削除する (git clean -fd)

# スクリプトのディレクトリに移動（プロジェクトのルートに配置されていることを想定）
# もしバッチフォルダ内にある場合は、一つ上のディレクトリ（ルート）に移動する
cd "$(dirname "$0")/.."

echo "Fetching from remote..."
git fetch origin

echo "Resetting to origin/main..."
git reset --hard origin/main

echo "Cleaning untracked files..."
git clean -fd

echo "Sync completed successfully."
