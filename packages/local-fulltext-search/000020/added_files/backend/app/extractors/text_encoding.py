"""
利用者のテキストファイルの文字コードの判定と読み取り。

Windows の日本語環境には Shift-JIS や UTF-16 のテキストが多く、UTF-8 だけで読むと文字化けして検索できない。
全文インデックス・ベクトルインデックス・AIインプットは、ここを通してファイルを読む。

仕様:
- BOM があれば BOM の文字コードで読み、BOM は本文に残さない。
- BOM が無ければ UTF-8 で読み、読めなければ cp932（Shift-JIS）で読む。
- 改行は LF へ揃える。
- ほぼ UTF-8 で一部だけ壊れたファイルは、壊れた箇所を除いて UTF-8 として読む。
  cp932 として読むと全体が文字化けするため。
"""

from __future__ import annotations

import codecs
from pathlib import Path

# UTF-32 LE の BOM は UTF-16 LE の BOM を含むので、先に調べる
_BOM_ENCODINGS = (
    (codecs.BOM_UTF8, "utf-8-sig"),
    (codecs.BOM_UTF32_LE, "utf-32"),
    (codecs.BOM_UTF32_BE, "utf-32"),
    (codecs.BOM_UTF16_LE, "utf-16"),
    (codecs.BOM_UTF16_BE, "utf-16"),
)
_REPLACEMENT_CHARACTER = "�"
# UTF-8 として壊れている文字の割合がこれ未満なら、一部が壊れた UTF-8 とみなす
_BROKEN_UTF8_RATIO = 0.01


def decode_text(raw: bytes) -> str:
    """バイト列の文字コードを判定して文字列にする。"""
    for bom, encoding in _BOM_ENCODINGS:
        if raw.startswith(bom):
            return raw.decode(encoding, errors="replace")
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        pass
    lenient = raw.decode("utf-8", errors="replace")
    if lenient.count(_REPLACEMENT_CHARACTER) < len(lenient) * _BROKEN_UTF8_RATIO:
        return lenient.replace(_REPLACEMENT_CHARACTER, "")
    return raw.decode("cp932", errors="replace")


def read_text_file(path: Path) -> str:
    """
    テキストファイルを文字コードを判定して読む。読めなければ OSError を送出する。
    改行は LF へ揃える（テキストモードで読んだときと同じ。行単位の解析が CRLF で壊れないようにする）。
    """
    return decode_text(path.read_bytes()).replace("\r\n", "\n").replace("\r", "\n")
