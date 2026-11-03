"""
requirements の文字コード宣言のテスト。

Python 付属の古い pip は、文字コード宣言の無い requirements を OS の既定（日本語版 Windows は cp932）で読む。
日本語のコメントがあると UnicodeDecodeError で導入が止まるため、先頭 2 行に UTF-8 の宣言を置く。
pip と同じ規則（先頭 2 行の `coding[:=]`）で確かめる。
"""

import re
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
ENCODING_DECLARATION = re.compile(rb"coding[:=]\s*([-\w.]+)")


@pytest.mark.parametrize("name", ["requirements.txt", "requirements-cuda.txt"])
def test_requirements_declare_utf8_in_the_first_two_lines(name: str) -> None:
    raw = (BACKEND_DIR / name).read_bytes()
    head_lines = raw.splitlines()[:2]

    declared = [match.group(1) for line in head_lines if line.startswith(b"#") and (match := ENCODING_DECLARATION.search(line))]

    assert declared == [b"utf-8"]
    raw.decode("utf-8")
