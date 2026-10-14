"""pytest共通設定: プロジェクトルートを import パスに追加し、backend パッケージを読み込めるようにする。"""
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))
