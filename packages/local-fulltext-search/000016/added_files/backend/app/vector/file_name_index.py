"""
ファイル名による再帰探索（同名ファイル探索）と、その走査結果の索引キャッシュ。

仕様:
- 画像・図面・リンク先ノート・メールの探索は、見つからないとき根フォルダ配下を丸ごと走査する。
  1 回の書き出しでリンクが数百あると、同じフォルダを何百回も走査して遅い（特にネットワークドライブ）。
- `file_name_index_scope()` の中では、根フォルダごとの走査を 1 回だけ行い、ファイル名 → 最初に現れたパスの索引を共有する。
  スコープの外では従来どおり、見つかった時点で打ち切る走査をする（結果は同じ）。
- 複数の候補名を渡したときは、走査順で先に現れるフォルダを優先し、同じフォルダ内では候補の並び順を優先する。
- 隠しフォルダ（`.` で始まる名前）の扱いは hidden で従来の各探索に合わせる:
  - "skip_files": そのフォルダ直下のファイルは対象外（配下のフォルダへは降りる）
  - "prune": そのフォルダ配下をすべて対象外
  - "none": 隠しフォルダも対象。ただし `.` で始まるファイル名は対象外
- 索引はスコープの終了で破棄する。ファイルの追加・削除を長く引きずらない。
- 書き出しの時間制限（app.vector.export_guard）で打ち切られた走査は、裏で続いたままになる。その間に同じフォルダを
  探す呼び出しは、走査を重ねて始めず、待たずに「見つからない」として返し、フォルダの走査が終わっていないことを
  1 度だけ記録する（ネットワークドライブで同じ重い走査が何本も走るのを防ぐ）。走査が終われば以降は索引を使う。
"""

from __future__ import annotations

import contextvars
import functools
import os
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Iterator, List, Optional, Tuple, TypeVar, Union

from app.vector.export_guard import SKIP_TIMEOUT, record_skip
from app.vector.export_timing import stage  # noqa: E402

# 索引: ファイル名 -> (走査順でのフォルダ番号, パス)。最初に現れたものだけを持つ
_Index = Dict[str, Tuple[int, Path]]

# 走査中を表す印。索引の代わりにキャッシュへ置く
_BUILDING: _Index = {}
_build_lock = threading.Lock()

_active_cache: contextvars.ContextVar[Optional[Dict[Tuple[str, str], _Index]]] = contextvars.ContextVar(
    "file_name_index_cache", default=None
)


@contextmanager
def file_name_index_scope() -> Iterator[None]:
    """このブロックの間、根フォルダごとの走査結果を共有する。入れ子のときは外側の索引を使う。"""
    if _active_cache.get() is not None:
        yield
        return
    token = _active_cache.set({})
    try:
        yield
    finally:
        _active_cache.reset(token)


_F = TypeVar("_F", bound=Callable[..., Any])


def uses_file_name_index(func: _F) -> _F:
    """関数の実行全体を file_name_index_scope() の中で行うデコレーター。"""

    @functools.wraps(func)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        with file_name_index_scope():
            return func(*args, **kwargs)

    return wrapper  # type: ignore[return-value]


def _walk(root: Path, hidden: str) -> Iterator[Tuple[int, str, List[str]]]:
    """(フォルダ番号, フォルダパス, 対象ファイル名一覧) を走査順に返す。"""
    order = 0
    for dirpath, dirnames, filenames in os.walk(root):
        if hidden == "prune":
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        if hidden == "skip_files" and Path(dirpath).name.startswith("."):
            order += 1
            continue
        if hidden == "none":
            filenames = [f for f in filenames if not f.startswith(".")]
        yield order, dirpath, filenames
        order += 1


def _build_index(root: Path, hidden: str) -> _Index:
    index: _Index = {}
    for order, dirpath, filenames in _walk(root, hidden):
        for name in filenames:
            if name not in index:
                index[name] = (order, Path(dirpath) / name)
    return index


def find_file_by_names(
    root: Union[str, Path],
    names: Iterable[str],
    hidden: str = "skip_files",
) -> Optional[Path]:
    """root 配下から、候補名のいずれかに一致する最初のファイルを返す。無ければ None。"""
    root_path = Path(root)
    candidates = list(names)
    if not candidates or not root_path.is_dir():
        return None

    cache = _active_cache.get()
    if cache is not None:
        key = (str(root_path), hidden)
        with _build_lock:
            index = cache.get(key)
            if index is None:
                cache[key] = _BUILDING
        if index is _BUILDING:
            # 前の走査が時間切れのまま続いている。重ねて走査せず、見つからないものとして返す
            record_skip("folder_scan", str(root_path), SKIP_TIMEOUT, detail="フォルダの走査が終わっていないため、探索を省略")
            return None
        if index is None:
            try:
                with stage("フォルダ走査(索引作成)", str(root_path)):
                    index = _build_index(root_path, hidden)
            except BaseException:
                with _build_lock:
                    cache.pop(key, None)
                raise
            with _build_lock:
                cache[key] = index
        best: Optional[Tuple[int, int, Path]] = None
        for priority, name in enumerate(candidates):
            hit = index.get(name)
            if hit is None:
                continue
            rank = (hit[0], priority)
            if best is None or rank < (best[0], best[1]):
                best = (hit[0], priority, hit[1])
        if best is not None and best[2].is_file():
            return best[2]
        return None

    with stage("フォルダ走査(早期終了)", f"{root_path} <- {candidates[0]}"):
        for _order, dirpath, filenames in _walk(root_path, hidden):
            present = set(filenames)
            for name in candidates:
                if name in present:
                    found = Path(dirpath) / name
                    if found.is_file():
                        return found
    return None
