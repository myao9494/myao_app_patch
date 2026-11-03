@echo off
rem 日本語のコメントで止まらないよう、文字コードを UTF-8 にする
chcp 65001 > nul
rem /**
rem  * リモート（origin/main）の内容を強制的にローカルに反映させるスクリプト（Windows用）
rem  * 
rem  * 仕様:
rem  * 1. リモートから最新情報を取得する (git fetch)
rem  * 2. ローカルのメインブランチをリモートの状態に強制リセットする (git reset --hard)
rem  * 3. 追跡されていないファイルを強制的に削除する (git clean -fd)
rem  */

rem スクリプトのディレクトリに移動（プロジェクトのルートに配置されていることを想定）
cd /d "%~dp0.."

echo Fetching from remote...
git fetch origin

echo Resetting to origin/main...
git reset --hard origin/main

echo Cleaning untracked files...
git clean -fd

echo Sync completed successfully.
pause
