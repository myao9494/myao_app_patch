"""
インデックスの走査範囲（階層・拡張子・除外）とフォルダの包含関係を判定する純粋関数。

走査後の後始末で「今回の走査が責任を持つ範囲か」を決めるために使う。
範囲外の行（より深い階層、対象外の拡張子、除外されたパス）は、別条件の走査結果かもしれないので消さない。
"""

from __future__ import annotations

from pathlib import Path

from app.services import exclude_rules


def relative_directory_depth(root_path: str, descendant_path: str) -> int:
    """
    ルートから子孫フォルダまでの相対ディレクトリ階層数を返す。
    大文字小文字の差異や末尾スラッシュの二重化を防ぐため正規化して比較する。
    """
    r_path = root_path.replace("\\", "/").rstrip("/")
    d_path = descendant_path.replace("\\", "/").rstrip("/")

    if not r_path:
        r_path = "/"
    if not d_path:
        d_path = "/"

    if r_path.lower() == d_path.lower():
        return 0

    root_prefix = r_path if r_path.endswith("/") else f"{r_path}/"
    if not d_path.lower().startswith(root_prefix.lower()):
        return 0
    relative_path = d_path[len(root_prefix):]
    return len([part for part in relative_path.split("/") if part])


def is_path_within_index_depth(normalized_path: str, *, root_path: str, index_depth: int | None) -> bool:
    """
    指定パスが今回の index_depth で走査責任を持つ階層内か判定する。
    """
    if index_depth is None:
        return True
    if index_depth < 0:
        return False

    if root_path == "/":
        relative_path = normalized_path.lstrip("/")
    elif normalized_path == root_path:
        relative_path = ""
    elif normalized_path.startswith(f"{root_path}/"):
        relative_path = normalized_path[len(root_path) + 1:]
    else:
        return False

    if not relative_path:
        return True
    relative_parts = [part for part in relative_path.split("/") if part]
    file_depth = max(len(relative_parts) - 1, 0)
    return file_depth <= index_depth


def is_path_within_extension_scope(
    normalized_path: str,
    *,
    file_ext: str | None = None,
    allowed_extensions: frozenset[str] | None,
) -> bool:
    """
    指定パスが今回の拡張子フィルタで走査責任を持つ対象か判定する。
    """
    if allowed_extensions is None:
        return True
    normalized_file_ext = str(file_ext or "").lower()
    if normalized_file_ext in allowed_extensions:
        return True
    lower_path = normalized_path.lower()
    return any(lower_path.endswith(extension) for extension in sorted(allowed_extensions, key=len, reverse=True))


def is_path_excluded_from_current_scope(
    normalized_path: str,
    *,
    keyword_set: frozenset[str] | None,
    substring_keywords: list[str] | None,
    excluded_path_prefixes: tuple[str, ...] | None,
) -> bool:
    """
    今回の除外条件で走査しなかったパスか判定する。
    """
    if excluded_path_prefixes and exclude_rules.is_excluded_path_prefix(normalized_path, excluded_path_prefixes):
        return True
    if not keyword_set and not substring_keywords:
        return False

    path_parts = [part for part in normalized_path.replace("\\", "/").split("/") if part]
    return any(
        exclude_rules.is_excluded_name(part, keyword_set or frozenset(), substring_keywords or [])
        for part in path_parts
    )


def paths_overlap(left: str, right: str) -> bool:
    """
    フォルダどうしが同一または祖先・子孫関係にあるかを判定する。
    """
    return left == right or left.startswith(f"{right}/") or right.startswith(f"{left}/")


def find_nearest_target_root(file_path: str, target_roots: list[str]) -> str:
    """
    指定ファイルを含む最も深い target ルートを返す。
    """
    for root_path in target_roots:
        if file_path == root_path or file_path.startswith(f"{root_path}/"):
            return root_path
    return Path(file_path).parent.as_posix()


def expand_indexed_folder_paths(file_path: Path, target_roots: list[str]) -> list[str]:
    """
    ファイルから、最も近い target までの祖先フォルダを展開する。
    """
    file_path_str = file_path.as_posix()
    limit_path = find_nearest_target_root(file_path_str, target_roots)
    folders: list[str] = []
    current = file_path.parent
    while True:
        folders.append(current.as_posix())
        if current.as_posix() == limit_path or current.parent == current:
            break
        current = current.parent
    return folders
