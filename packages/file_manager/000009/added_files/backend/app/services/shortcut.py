"""
Windows ショートカット（.lnk）の参照先解決
- MS-SHLLINK 形式のバイナリを読み、参照先のパス文字列を取り出す（読み取り専用。Windows 以外でも動く）
- 参照先の優先順位: LinkInfo のローカルパス（Unicode 版があればそれ）→ ネットワーク共有 → 相対パス
- ID リストだけを持つショートカット（コントロールパネルなど特殊フォルダ）は解決できず None を返す
- 壊れたデータでも例外は出さず None を返す
- resolve_shortcut: .lnk ファイルを読み、参照先と種別（directory / file / not_found / unknown）を返す
"""
from __future__ import annotations

import ntpath
import posixpath
import struct
from pathlib import Path
from typing import Optional, Tuple

from fastapi import HTTPException

from app.services.paths import normalize_path

HEADER_SIZE = 0x4C
LNK_HEADER_MAGIC = struct.pack("<I", HEADER_SIZE)

FLAG_HAS_LINK_TARGET_ID_LIST = 0x01
FLAG_HAS_LINK_INFO = 0x02
FLAG_HAS_NAME = 0x04
FLAG_HAS_RELATIVE_PATH = 0x08
FLAG_IS_UNICODE = 0x80

LINK_INFO_VOLUME_ID_AND_LOCAL_BASE_PATH = 0x01
LINK_INFO_COMMON_NETWORK_RELATIVE_LINK = 0x02

# 想定外に大きなファイルを読み込まないための上限（通常の .lnk は数 KB）
MAX_SHORTCUT_BYTES = 1024 * 1024


def _decode_ansi(raw: bytes) -> str:
    """システムコードページの文字列を読む（日本語 Windows の cp932 を想定）"""
    for encoding in ("cp932", "utf-8"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("latin-1")


def _read_cstring(data: bytes, offset: int, unicode_string: bool) -> Optional[str]:
    """NUL 終端の文字列を読む。範囲外や終端なしは None"""
    if offset <= 0 or offset >= len(data):
        return None
    if unicode_string:
        end = offset
        while end + 1 < len(data):
            if data[end : end + 2] == b"\x00\x00":
                return data[offset:end].decode("utf-16-le", errors="replace")
            end += 2
        return None
    end = data.find(b"\x00", offset)
    if end < 0:
        return None
    return _decode_ansi(data[offset:end])


def _join_windows_path(base: str, suffix: str) -> str:
    """参照先の基準パスと接尾辞を連結する（区切り文字は基準パスに合わせる）"""
    if not suffix:
        return base
    if base.endswith(("\\", "/")):
        return base + suffix
    return base + ("\\" if "\\" in base else "/") + suffix


def _resolve_relative(link_dir: str, relative: str) -> str:
    """ショートカットのあるフォルダを基準に相対パスを解決する（Windows 形式のパスなら ntpath で）"""
    if "\\" in link_dir or ntpath.splitdrive(link_dir)[0]:
        return ntpath.normpath(ntpath.join(link_dir, relative))
    return posixpath.normpath(posixpath.join(link_dir, relative.replace("\\", "/")))


def _parse_link_info(link_info: bytes) -> Optional[str]:
    """LinkInfo 構造体から参照先パスを組み立てる"""
    if len(link_info) < 0x1C:
        return None
    header_size, flags = struct.unpack_from("<II", link_info, 4)
    local_base_offset, network_offset, suffix_offset = struct.unpack_from("<III", link_info, 16)

    local_base_unicode_offset = suffix_unicode_offset = 0
    if header_size >= 0x24 and len(link_info) >= 0x24:
        local_base_unicode_offset, suffix_unicode_offset = struct.unpack_from("<II", link_info, 0x1C)

    suffix = (
        _read_cstring(link_info, suffix_unicode_offset, True)
        if suffix_unicode_offset
        else _read_cstring(link_info, suffix_offset, False)
    ) or ""

    if flags & LINK_INFO_VOLUME_ID_AND_LOCAL_BASE_PATH:
        base = (
            _read_cstring(link_info, local_base_unicode_offset, True)
            if local_base_unicode_offset
            else _read_cstring(link_info, local_base_offset, False)
        )
        if base:
            return _join_windows_path(base, suffix)

    if flags & LINK_INFO_COMMON_NETWORK_RELATIVE_LINK and network_offset:
        net_name = _parse_network_name(link_info[network_offset:])
        if net_name:
            return _join_windows_path(net_name, suffix)
    return None


def _parse_network_name(cnrl: bytes) -> Optional[str]:
    """CommonNetworkRelativeLink から共有名（\\\\server\\share）を読む"""
    if len(cnrl) < 0x14:
        return None
    net_name_offset = struct.unpack_from("<I", cnrl, 8)[0]
    net_name_unicode_offset = 0
    if net_name_offset > 0x14 and len(cnrl) >= 0x1C:
        net_name_unicode_offset = struct.unpack_from("<I", cnrl, 0x14)[0]
    if net_name_unicode_offset:
        return _read_cstring(cnrl, net_name_unicode_offset, True)
    return _read_cstring(cnrl, net_name_offset, False)


def _read_string_data(data: bytes, offset: int, unicode_string: bool) -> tuple[Optional[str], int]:
    """StringData（文字数 + 文字列）を1つ読み、次の位置を返す"""
    if offset + 2 > len(data):
        return None, offset
    (count,) = struct.unpack_from("<H", data, offset)
    offset += 2
    length = count * 2 if unicode_string else count
    if offset + length > len(data):
        return None, len(data)
    raw = data[offset : offset + length]
    text = raw.decode("utf-16-le", errors="replace") if unicode_string else _decode_ansi(raw)
    return text, offset + length


def parse_shortcut_target(data: bytes, link_dir: Optional[str] = None) -> Optional[str]:
    """
    .lnk のバイト列から参照先のパスを返す。読み取れなければ None。

    link_dir: ショートカットのあるフォルダ。LinkInfo がなく相対パスだけのショートカットを解決するときに使う。
    """
    try:
        if len(data) < HEADER_SIZE or data[:4] != LNK_HEADER_MAGIC:
            return None
        (flags,) = struct.unpack_from("<I", data, 0x14)
        offset = HEADER_SIZE

        if flags & FLAG_HAS_LINK_TARGET_ID_LIST:
            if offset + 2 > len(data):
                return None
            (id_list_size,) = struct.unpack_from("<H", data, offset)
            offset += 2 + id_list_size

        if flags & FLAG_HAS_LINK_INFO:
            if offset + 4 > len(data):
                return None
            (link_info_size,) = struct.unpack_from("<I", data, offset)
            link_info = data[offset : offset + link_info_size]
            offset += link_info_size
            target = _parse_link_info(link_info)
            if target:
                return target

        if flags & FLAG_HAS_RELATIVE_PATH and link_dir:
            unicode_string = bool(flags & FLAG_IS_UNICODE)
            if flags & FLAG_HAS_NAME:
                _, offset = _read_string_data(data, offset, unicode_string)
            relative, _ = _read_string_data(data, offset, unicode_string)
            if relative:
                return _resolve_relative(link_dir, relative)
        return None
    except (struct.error, ValueError, IndexError):
        return None


def resolve_shortcut(lnk_path: Path) -> Tuple[Optional[str], str]:
    """
    .lnk ファイルを読んで (参照先パス, 種別) を返す。ショートカット自体は変更しない。

    種別: directory / file / not_found（参照先が存在しない・アクセスできない）/ unknown（参照先を読み取れない）
    """
    try:
        with open(lnk_path, "rb") as f:
            data = f.read(MAX_SHORTCUT_BYTES + 1)
    except OSError:
        return None, "unknown"
    if len(data) > MAX_SHORTCUT_BYTES:
        return None, "unknown"

    target = parse_shortcut_target(data, link_dir=str(lnk_path.parent))
    if not target:
        return None, "unknown"

    try:
        target_path = normalize_path(target)
    except HTTPException:
        return target, "not_found"
    try:
        if target_path.is_dir():
            return target_path.as_posix(), "directory"
        if target_path.exists():
            return target_path.as_posix(), "file"
    except OSError:
        pass
    return target_path.as_posix(), "not_found"
