"""
バックエンドサーバーの起動スクリプト。
OpenMP 関連の環境変数は `app` パッケージの import 時（app.runtime_env）に設定される。
"""

import os

os.environ.setdefault("SEARCH_APP_LAUNCHER_AUTOSTART", "1")

import uvicorn

from app.config import settings
from app.runtime_env import apply_torch_thread_limit


if __name__ == "__main__":
    apply_torch_thread_limit()
    uvicorn.run("app.main:app", host=settings.bind_host, port=settings.bind_port, reload=False)
