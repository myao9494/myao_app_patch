"""
Windows ショートカット（.lnk）の参照先解決のテスト
- services/shortcut.py: MS-SHLLINK 形式のバイナリから参照先パスを取り出す
- GET /api/shortcut-target: 参照先と種別（directory / file / not_found / unknown）を返す
テスト用の .lnk は make_lnk() でバイト列から組み立てる（Windows 以外でも実行できる）
"""
import struct
from pathlib import Path
from typing import Optional

import pytest

from app.services.shortcut import parse_shortcut_target

HAS_LINK_TARGET_ID_LIST = 0x01
HAS_LINK_INFO = 0x02
HAS_RELATIVE_PATH = 0x08
IS_UNICODE = 0x80


def make_lnk(
    local_base: Optional[str] = None,
    suffix: str = "",
    net_name: Optional[str] = None,
    relative_path: Optional[str] = None,
    unicode_strings: bool = True,
    encoding: str = "cp932",
    with_id_list: bool = True,
    link_info_unicode: bool = False,
) -> bytes:
    """最小限の .lnk バイト列を作る（LinkInfo の参照先 / ネットワーク共有 / 相対パス）"""
    flags = 0
    if with_id_list:
        flags |= HAS_LINK_TARGET_ID_LIST
    has_link_info = local_base is not None or net_name is not None
    if has_link_info:
        flags |= HAS_LINK_INFO
    if relative_path is not None:
        flags |= HAS_RELATIVE_PATH
    if unicode_strings:
        flags |= IS_UNICODE

    header = struct.pack("<I16sIIQQQIIIH10s", 0x4C, b"\x01\x14\x02" + b"\x00" * 13, flags, 0x10, 0, 0, 0, 0, 0, 1, 0, b"\x00" * 10)
    assert len(header) == 0x4C
    body = header

    if with_id_list:
        body += struct.pack("<H", 2) + b"\x00\x00"  # IDListSize=2 の空の ID リスト（終端のみ）

    if has_link_info:
        body += _make_link_info(local_base, suffix, net_name, link_info_unicode)

    if relative_path is not None:
        body += _string_data(relative_path, unicode_strings, encoding)
    return body


def _string_data(text: str, unicode_strings: bool, encoding: str) -> bytes:
    if unicode_strings:
        return struct.pack("<H", len(text)) + text.encode("utf-16-le")
    raw = text.encode(encoding)
    return struct.pack("<H", len(raw)) + raw


def _make_link_info(local_base: Optional[str], suffix: str, net_name: Optional[str], unicode_offsets: bool) -> bytes:
    header_size = 0x24 if unicode_offsets else 0x1C
    link_info_flags = 0x01 if local_base is not None else 0x02
    data = b""

    def add(blob: bytes) -> int:
        nonlocal data
        offset = header_size + len(data)
        data += blob
        return offset

    local_offset = cnrl_offset = 0
    local_unicode_offset = suffix_unicode_offset = 0
    if local_base is not None:
        local_offset = add(local_base.encode("cp932") + b"\x00")
    if net_name is not None:
        net_blob = net_name.encode("cp932") + b"\x00"
        cnrl_header_size = 0x14
        cnrl = struct.pack("<IIIII", cnrl_header_size + len(net_blob), 0, cnrl_header_size, 0, 0) + net_blob
        cnrl_offset = add(cnrl)
    suffix_offset = add(suffix.encode("cp932") + b"\x00")
    if unicode_offsets:
        if local_base is not None:
            local_unicode_offset = add(local_base.encode("utf-16-le") + b"\x00\x00")
        suffix_unicode_offset = add(suffix.encode("utf-16-le") + b"\x00\x00")

    # LinkInfoSize, LinkInfoHeaderSize, LinkInfoFlags, VolumeIDOffset, LocalBasePathOffset,
    # CommonNetworkRelativeLinkOffset, CommonPathSuffixOffset
    head = struct.pack(
        "<IIIIIII",
        header_size + len(data),
        header_size,
        link_info_flags,
        0,
        local_offset,
        cnrl_offset,
        suffix_offset,
    )
    if unicode_offsets:
        head += struct.pack("<II", local_unicode_offset, suffix_unicode_offset)
    assert len(head) == header_size
    return head + data


class TestParseShortcutTarget:
    def test_ローカルパスの参照先を取り出す(self):
        lnk = make_lnk(local_base="C:\\Users\\mine\\Documents")
        assert parse_shortcut_target(lnk) == "C:\\Users\\mine\\Documents"

    def test_共通パス接尾辞は区切り文字を挟んで連結する(self):
        lnk = make_lnk(local_base="C:\\Users\\mine", suffix="Documents\\work")
        assert parse_shortcut_target(lnk) == "C:\\Users\\mine\\Documents\\work"

    def test_ドライブ直下の参照先は区切り文字を重ねない(self):
        lnk = make_lnk(local_base="C:\\", suffix="work")
        assert parse_shortcut_target(lnk) == "C:\\work"

    def test_日本語パスをcp932で読む(self):
        lnk = make_lnk(local_base="C:\\ユーザー\\資料")
        assert parse_shortcut_target(lnk) == "C:\\ユーザー\\資料"

    def test_Unicode版のパスがあればそれを優先する(self):
        lnk = make_lnk(local_base="C:\\Users\\絵文字", link_info_unicode=True)
        assert parse_shortcut_target(lnk) == "C:\\Users\\絵文字"

    def test_ネットワーク共有の参照先を取り出す(self):
        lnk = make_lnk(net_name="\\\\server\\share", suffix="folder\\sub")
        assert parse_shortcut_target(lnk) == "\\\\server\\share\\folder\\sub"

    def test_LinkInfoがなければ相対パスで返す(self):
        lnk = make_lnk(relative_path="..\\other\\folder")
        assert parse_shortcut_target(lnk, link_dir="C:\\base\\here") == "C:\\base\\other\\folder"

    def test_ANSI文字列の相対パスも読める(self):
        lnk = make_lnk(relative_path=".\\資料", unicode_strings=False)
        assert parse_shortcut_target(lnk, link_dir="C:\\base") == "C:\\base\\資料"

    def test_参照先が読めないときはNone(self):
        assert parse_shortcut_target(make_lnk()) is None

    @pytest.mark.parametrize("data", [b"", b"not a shortcut", b"\x4c\x00\x00\x00" + b"\x00" * 10])
    def test_壊れたデータはNone(self, data: bytes):
        assert parse_shortcut_target(data) is None

    def test_切り詰められたLinkInfoでも例外にならない(self):
        lnk = make_lnk(local_base="C:\\Users\\mine")
        result = parse_shortcut_target(lnk[:-8])
        assert result is None or isinstance(result, str)


class TestShortcutTargetApi:
    def _write_lnk(self, directory: Path, name: str, **kwargs) -> Path:
        lnk_path = directory / name
        lnk_path.write_bytes(make_lnk(**kwargs))
        return lnk_path

    def test_フォルダへのショートカットはdirectoryを返す(self, client, tmp_path):
        target = tmp_path / "target"
        target.mkdir()
        lnk = self._write_lnk(tmp_path, "link.lnk", local_base=str(target))

        response = client.get("/api/shortcut-target", params={"path": str(lnk)})

        assert response.status_code == 200
        body = response.json()
        assert body["type"] == "directory"
        assert body["target"] == target.as_posix()

    def test_ファイルへのショートカットはfileを返す(self, client, tmp_path):
        target = tmp_path / "note.txt"
        target.write_text("x")
        lnk = self._write_lnk(tmp_path, "link.lnk", local_base=str(target))

        body = client.get("/api/shortcut-target", params={"path": str(lnk)}).json()

        assert body["type"] == "file"
        assert body["target"] == target.as_posix()

    def test_参照先が存在しなければnot_found(self, client, tmp_path):
        lnk = self._write_lnk(tmp_path, "link.lnk", local_base=str(tmp_path / "missing"))

        body = client.get("/api/shortcut-target", params={"path": str(lnk)}).json()

        assert body["type"] == "not_found"
        assert body["target"] == (tmp_path / "missing").as_posix()

    def test_参照先が読めなければunknown(self, client, tmp_path):
        lnk = self._write_lnk(tmp_path, "link.lnk")

        body = client.get("/api/shortcut-target", params={"path": str(lnk)}).json()

        assert body == {"path": lnk.as_posix(), "target": None, "type": "unknown"}

    def test_相対パスのショートカットはlnkの場所から解決する(self, client, tmp_path):
        (tmp_path / "dest").mkdir()
        (tmp_path / "links").mkdir()
        lnk = self._write_lnk(tmp_path / "links", "link.lnk", relative_path="../dest")

        body = client.get("/api/shortcut-target", params={"path": str(lnk)}).json()

        assert body["type"] == "directory"
        assert body["target"] == (tmp_path / "dest").as_posix()

    def test_lnk以外は400(self, client, tmp_path):
        other = tmp_path / "a.txt"
        other.write_text("x")

        assert client.get("/api/shortcut-target", params={"path": str(other)}).status_code == 400

    def test_存在しないlnkは404(self, client, tmp_path):
        response = client.get("/api/shortcut-target", params={"path": str(tmp_path / "none.lnk")})

        assert response.status_code == 404

    def test_ショートカットの参照先は読み取るだけで何も変更しない(self, client, tmp_path):
        target = tmp_path / "target"
        target.mkdir()
        lnk = self._write_lnk(tmp_path, "link.lnk", local_base=str(target))
        before = lnk.read_bytes()

        client.get("/api/shortcut-target", params={"path": str(lnk)})

        assert lnk.read_bytes() == before
        assert target.is_dir()
