"""
ノートからリンクされているメールファイル（MSG / EML / winmail.dat）の抽出。
Markdown 内の WikiLink / Markdown リンクから、実在するメールファイルへの参照を重複なく取り出す。
リンク先は、ノートと同じフォルダ、Vault 直下、Vault 内のファイル名検索の順に探す。
"""

import logging
import re
import urllib.parse
from pathlib import Path
from typing import List, Optional, Set, Union

from app.vector.file_name_index import find_file_by_names

logger = logging.getLogger(__name__)


EMAIL_EXTENSIONS = {".msg", ".eml", ".dat"}


def _resolve_email_file_path(
    path_str: str,
    base_dir: Optional[Union[str, Path]] = None,
    vault_path: Optional[Union[str, Path]] = None,
) -> Optional[Path]:
    """
    指定されたメールパス文字列から実在するPathを解決する。
    base_dir や vault_path が文字列で渡された場合でも安全に Path 化して解決する。
    """
    p = Path(path_str)
    if p.is_absolute() and p.exists() and p.is_file():
        return p.resolve()

    b_dir = Path(base_dir).resolve() if base_dir else None
    v_path = Path(vault_path).resolve() if vault_path else None

    if b_dir:
        cand1 = (b_dir / p).resolve()
        if cand1.exists() and cand1.is_file():
            return cand1
        cand2 = (b_dir / p.name).resolve()
        if cand2.exists() and cand2.is_file():
            return cand2

    if v_path:
        cand3 = (v_path / p).resolve()
        if cand3.exists() and cand3.is_file():
            return cand3
        cand4 = (v_path / p.name).resolve()
        if cand4.exists() and cand4.is_file():
            return cand4
        try:
            if v_path.is_dir():
                found = find_file_by_names(v_path, [p.name], hidden="none")
                if found is not None:
                    return found.resolve()
        except Exception:
            logger.debug("Failed to search a vault folder for a linked email file.", exc_info=True)

    return None


def extract_linked_email_paths(
    content: str,
    base_dir: Optional[Union[str, Path]] = None,
    vault_path: Optional[Union[str, Path]] = None,
) -> List[Path]:
    """
    Markdownテキスト内のリンク（WikilinkおよびMarkdownリンク）から
    メールファイル（.msg, .eml, winmail.dat）を検出し、実在するPathのリストを返す。
    """
    found_paths: List[Path] = []
    seen: Set[str] = set()

    def check_and_add(raw_target: str) -> None:
        unquoted = urllib.parse.unquote(raw_target.strip())
        cleaned = unquoted.split("?")[0].split("#")[0].strip()
        if not cleaned:
            return
        suffix = Path(cleaned).suffix.lower()
        name = Path(cleaned).name.lower()
        if suffix not in EMAIL_EXTENSIONS and name != "winmail.dat":
            return
        resolved = _resolve_email_file_path(cleaned, base_dir, vault_path)
        if resolved and resolved.exists() and resolved.is_file():
            abs_str = str(resolved.resolve())
            if abs_str not in seen:
                seen.add(abs_str)
                found_paths.append(resolved.resolve())

    # 1. Wikilinks: !?[[path/to/file.ext|alias]] or !?[[path/to/file.ext]]
    for m in re.finditer(r"!?\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]", content):
        check_and_add(m.group(1))

    # 2. Markdown links: !?[text](path/to/file.ext)
    for m in re.finditer(r"!?\[([^\]]*)\]\(([^)#]+)\)", content):
        check_and_add(m.group(2))

    return found_paths
