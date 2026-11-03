"""
フォルダ配下の「インデックス対象ファイル」の走査。

全文インデックスとベクトルインデックスが同じ関数を使い、対象範囲（除外キーワード・階層数・拡張子）を一致させる。
- 除外フォルダへは再帰しない。エントリ名だけで除外判定する（親フォルダは再帰の途中で判定済み）。
- 階層数は対象フォルダ直下を 0 と数え、max_depth より深いフォルダへは入らない。
- シンボリックリンクとジャンクションはたどらない（ループで同じファイルを何度も処理しないため）。
  フォルダへのリンクは skipped_links へ記録する。呼び出し元が利用者へ案内する。
  元のフォルダが無いリンク、除外されたリンク、階層の上限より深いリンクは記録しない。
- 開けなかったフォルダは unreadable_paths へ記録する。中のファイルが消えたとは言えないので、呼び出し元は削除の対象にしない。
- 配下のフォルダを開けない（走査中に消えた・開けない名前など。WinError 3 を含む）ときは、そのフォルダだけ読み飛ばして続ける。
  除外設定へは追加しない。対象フォルダ自体の失敗は例外にする。
"""

from __future__ import annotations

import logging
import os
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

from app.services import exclude_rules

logger = logging.getLogger(__name__)

# Windows のジャンクションとボリュームのマウントポイントの種別
IO_REPARSE_TAG_MOUNT_POINT = 0xA0000003


@dataclass(frozen=True)
class SkippedLink:
    """走査でたどらなかったフォルダのリンク。"""

    link_path: str
    target_path: str
    link_type: str  # "junction" または "symlink"


def walk_indexable_files(
    root: Path,
    keyword_set: frozenset[str],
    substring_keywords: list[str],
    *,
    excluded_path_prefixes: tuple[str, ...],
    auto_excluded_paths: set[str],
    allowed_extensions: frozenset[str],
    sorted_allowed_extensions: tuple[str, ...],
    max_depth: int,
    unreadable_paths: set[str] | None = None,
    skipped_links: dict[str, SkippedLink] | None = None,
) -> Iterator[Path]:
    """
    root 配下で、除外条件・階層・拡張子の条件を満たすファイルを順に返す。
    到達不能な共有先（Windows の WinError 59）は auto_excluded_paths へ追加して走査を続ける。
    """
    yield from _walk_files(
        root,
        keyword_set,
        substring_keywords,
        excluded_path_prefixes=excluded_path_prefixes,
        auto_excluded_paths=auto_excluded_paths,
        allowed_extensions=allowed_extensions,
        sorted_allowed_extensions=sorted_allowed_extensions,
        max_depth=max_depth,
        unreadable_paths=unreadable_paths if unreadable_paths is not None else set(),
        skipped_links=skipped_links if skipped_links is not None else {},
    )


def _folder_link_type(entry: os.DirEntry[str]) -> str | None:
    """
    エントリがフォルダへのリンクなら種類を返す。
    DirEntry.is_junction は Python 3.12 以降にしかないので、リパースポイントの種別で判定する。
    """
    if entry.is_symlink():
        return "symlink" if entry.is_dir() else None
    if os.name != "nt" or not entry.is_dir(follow_symlinks=False):
        return None
    is_junction = getattr(entry.stat(follow_symlinks=False), "st_reparse_tag", 0) == IO_REPARSE_TAG_MOUNT_POINT
    return "junction" if is_junction else None


def _record_skipped_link(entry: os.DirEntry[str], link_type: str, skipped_links: dict[str, SkippedLink]) -> None:
    """元のフォルダがあるリンクを記録する。"""
    target_path = os.path.realpath(entry.path)
    if not os.path.isdir(target_path):
        return
    link_path = Path(entry.path).as_posix()
    skipped_links[link_path] = SkippedLink(link_path, Path(target_path).as_posix(), link_type)


def _walk_files(
    root: Path,
    keyword_set: frozenset[str],
    substring_keywords: list[str],
    *,
    excluded_path_prefixes: tuple[str, ...],
    auto_excluded_paths: set[str],
    allowed_extensions: frozenset[str],
    sorted_allowed_extensions: tuple[str, ...],
    max_depth: int,
    unreadable_paths: set[str],
    skipped_links: dict[str, SkippedLink],
    current_depth: int = 0,
):
    """
    os.scandir ベースの高速ファイル走査。
    除外ディレクトリには再帰せず、深さと拡張子の条件を満たすファイルだけを返す。
    """
    normalized_root = exclude_rules.normalize_excluded_path_prefix(root)
    if normalized_root is not None and exclude_rules.is_excluded_path_prefix(normalized_root, excluded_path_prefixes):
        return

    try:
        with os.scandir(root) as entries:
            for entry in entries:
                # 再帰走査なので親パーツは既にチェック済み。現在のエントリ名だけで判定する
                if exclude_rules.is_excluded_name(entry.name, keyword_set, substring_keywords):
                    continue

                normalized_entry_path = exclude_rules.normalize_excluded_path_prefix(entry.path)
                if normalized_entry_path is not None and exclude_rules.is_excluded_path_prefix(
                    normalized_entry_path,
                    excluded_path_prefixes,
                ):
                    continue

                try:
                    is_directory = entry.is_dir(follow_symlinks=False)
                    is_file = False if is_directory else entry.is_file(follow_symlinks=False)
                    link_type = _folder_link_type(entry)
                except OSError:
                    if normalized_entry_path is not None:
                        unreadable_paths.add(normalized_entry_path)
                    # 種別を判定できないエントリ 1 件のために、同じフォルダの残りの走査を止めない。
                    continue

                if link_type is not None:
                    if current_depth < max_depth:
                        _record_skipped_link(entry, link_type, skipped_links)
                    continue

                if is_directory:
                    if current_depth < max_depth:
                        yield from _walk_files(
                            Path(entry.path),
                            keyword_set,
                            substring_keywords,
                            excluded_path_prefixes=excluded_path_prefixes,
                            auto_excluded_paths=auto_excluded_paths,
                            allowed_extensions=allowed_extensions,
                            sorted_allowed_extensions=sorted_allowed_extensions,
                            max_depth=max_depth,
                            unreadable_paths=unreadable_paths,
                            skipped_links=skipped_links,
                            current_depth=current_depth + 1,
                        )
                    continue

                if is_file:
                    resolved_extension = next(
                        (extension for extension in sorted_allowed_extensions if entry.name.lower().endswith(extension)),
                        None,
                    )
                    if resolved_extension in allowed_extensions:
                        yield Path(entry.path)
    except PermissionError:
        if normalized_root is not None:
            unreadable_paths.add(normalized_root)
    except OSError as error:
        if is_unexpected_network_error(error):
            if normalized_root is not None:
                auto_excluded_paths.add(normalized_root)
            return
        if normalized_root is not None:
            unreadable_paths.add(normalized_root)
        # 対象フォルダ自体の失敗は設定ミスなので、握りつぶさず呼び出し元へ伝える。
        if current_depth == 0:
            raise
        # 配下のフォルダが走査中に消えた / 開けない名前だった（Windows の WinError 3 など）。
        # そのフォルダだけ読み飛ばし、走査全体は続ける。一時的な事象なので除外設定へは追加しない。
        logger.warning("走査できないフォルダを読み飛ばしました: %s (%s)", root, error)


def is_unexpected_network_error(error: OSError) -> bool:
    """
    Windows の WinError 59 はアクセス不能な共有先として扱い、以降の走査対象から外す。
    """
    return getattr(error, "winerror", None) == 59
