"""
Ganttデータの更新シーケンス（インメモリの整数カウンタ）。

タスク・リンクの作成/更新/削除、CSVインポート、グリッドコミットのたびに increment() し、
フロントエンドは GET /api/tasks/update-sequence をポーリングして値の変化で再取得する。
プロセス再起動で 0 に戻るため、フロントエンドは大小ではなく「値が変わったか」で判定する。
"""
import threading

_lock = threading.Lock()
_sequence = 0


def increment() -> int:
    """データ変更時に呼び出し、シーケンス番号を1つ進める。"""
    global _sequence
    with _lock:
        _sequence += 1
        return _sequence


def current() -> int:
    """現在のシーケンス番号を返す。"""
    return _sequence


def reset() -> None:
    """シーケンス番号を初期値に戻す（テスト用）。"""
    global _sequence
    with _lock:
        _sequence = 0
