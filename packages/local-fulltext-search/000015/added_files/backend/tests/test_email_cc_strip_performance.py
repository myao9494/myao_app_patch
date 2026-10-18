"""
メール本文の Cc 行除去（strip_email_cc_lines）の速度と範囲のテスト。

仕様:
- Cc 行が無い、表だらけの長い HTML メールでも、本文の長さに対して線形に近い時間で終わる
  （以前は <tr> ごとに文書末尾まで探して 3 乗で遅くなり、数十 KB で数十秒かかった）。
- 表の Cc 行の除去は、その行（<tr>）の中だけに限る。手前の行・後ろの行の内容は消さない。
"""

from __future__ import annotations

import time

from app.vector.email_html import strip_email_cc_lines


def _tables(n: int) -> str:
    return "".join(
        f'<table><tr><td><p class="MsoNormal">本文{i} テキスト <b>太字</b></p></td><td>x</td></tr></table>'
        for i in range(n)
    )


def test_html_without_cc_is_fast() -> None:
    html_text = _tables(600)
    started = time.perf_counter()
    result = strip_email_cc_lines(html_text, is_html=True)
    assert time.perf_counter() - started < 1.0
    assert "本文0 " in result and "本文599 " in result


def test_html_with_cc_at_end_is_fast_and_keeps_earlier_rows() -> None:
    html_text = _tables(600) + "<table><tr><th>Cc:</th><td>a@example.com</td></tr><tr><th>件名:</th><td>x</td></tr></table>"
    started = time.perf_counter()
    result = strip_email_cc_lines(html_text, is_html=True)
    assert time.perf_counter() - started < 1.0
    assert "本文0 " in result and "本文599 " in result
    assert "a@example.com" not in result
    assert "件名:" in result


def test_table_cc_row_removal_is_limited_to_that_row() -> None:
    html_text = (
        "<table>"
        "<tr><th>差出人:</th><td>alice</td></tr>"
        "<tr><th>Cc:</th><td>bob@example.com</td></tr>"
        "<tr><th>件名:</th><td>subject</td></tr>"
        "</table>"
    )
    result = strip_email_cc_lines(html_text, is_html=True)
    assert "bob@example.com" not in result
    assert "alice" in result and "subject" in result


def test_inline_forms_still_removed() -> None:
    assert "x@y.z" not in strip_email_cc_lines("<p><b>Cc:</b> x@y.z</p><p>本文</p>", is_html=True)
    assert "x@y.z" not in strip_email_cc_lines("<b>Cc:</b> x@y.z<br>本文<br>", is_html=True)
    assert "本文" in strip_email_cc_lines("<b>Cc:</b> x@y.z<br>本文<br>", is_html=True)
