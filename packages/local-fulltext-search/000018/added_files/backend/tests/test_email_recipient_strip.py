"""
メール本文から宛先（To）・Cc・Bcc の行を除く strip_email_recipient_lines のテスト。

仕様:
- 見出しは日本語（宛先 / CC / BCC）と英語（To / Cc / Bcc）の両方。全角の「ＣＣ」「：」も対象。
- 差出人・送信日時・件名などの他のヘッダー行と本文は残す。
- プレーンテキスト:
  - 行頭の見出し（引用の「>」が付いていてもよい）で始まる行を除く。
  - 続く折り返し行は、インデントされた行か、直前の宛先行が「,」「;」で終わる行だけを除く。
- HTML:
  - <br>・</p>・</div>・</tr> で区切った 1 行の表示文字が見出しで始まるとき、その行の文字だけを除く（タグは残す）。
  - Outlook の「<b>宛先<span>:</span></b>」のように見出しとコロンの間にタグがあっても対象にする。
  - 文中の「mailto:」や「Go to: ...」のように行頭でない見出しは消さない。
- 長い本文でも、本文の長さに対して線形に近い時間で終わる。
"""

from __future__ import annotations

import time

from app.vector.email_recipients import strip_email_recipient_lines


def _tables(n: int) -> str:
    return "".join(
        f'<table><tr><td><p class="MsoNormal">本文{i} テキスト <b>太字</b></p></td><td>x</td></tr></table>'
        for i in range(n)
    )


# ---------- プレーンテキスト ----------


def test_plain_removes_to_cc_bcc_and_keeps_other_headers() -> None:
    body = (
        "お疲れ様です。\n"
        "\n"
        "-----Original Message-----\n"
        "From: satou@example.com\n"
        "Sent: Monday, October 20, 2026 10:00 AM\n"
        "To: yamada@example.com; kato@example.com\n"
        "Cc: suzuki@example.com\n"
        "Bcc: hidden@example.com\n"
        "Subject: 進捗確認\n"
        "\n"
        "進捗の件、了解しました。\n"
    )
    cleaned = strip_email_recipient_lines(body)
    for address in ("yamada@example.com", "kato@example.com", "suzuki@example.com", "hidden@example.com"):
        assert address not in cleaned
    assert "From: satou@example.com" in cleaned
    assert "Sent: Monday" in cleaned
    assert "Subject: 進捗確認" in cleaned
    assert "進捗の件、了解しました。" in cleaned


def test_plain_removes_japanese_and_fullwidth_headings() -> None:
    body = "差出人: 佐藤\n宛先: 山田 <yamada@example.com>\nＣＣ：鈴木 <suzuki@example.com>\nBCC: 隠し <h@example.com>\n件名: 会議\n本文です。\n"
    cleaned = strip_email_recipient_lines(body)
    assert "yamada@example.com" not in cleaned
    assert "suzuki@example.com" not in cleaned
    assert "h@example.com" not in cleaned
    assert "差出人: 佐藤" in cleaned
    assert "件名: 会議" in cleaned
    assert "本文です。" in cleaned


def test_plain_removes_quoted_reply_headers() -> None:
    body = "了解です。\n\n> From: a@example.com\n> To: b@example.com\n> Subject: 件名\n> 元の本文\n"
    cleaned = strip_email_recipient_lines(body)
    assert "b@example.com" not in cleaned
    assert "> From: a@example.com" in cleaned
    assert "> 元の本文" in cleaned


def test_plain_removes_continuation_lines() -> None:
    body = (
        "To: a@example.com, b@example.com,\n"
        "    c@example.com\n"
        "Cc: d@example.com;\n"
        "e@example.com\n"
        "Subject: 件名\n"
    )
    cleaned = strip_email_recipient_lines(body)
    for address in ("a@example.com", "c@example.com", "d@example.com", "e@example.com"):
        assert address not in cleaned
    assert "Subject: 件名" in cleaned


def test_plain_keeps_body_line_right_after_recipient_line() -> None:
    """宛先行が区切り文字で終わっていなければ、次の行は本文として残す（カンマを含んでいても消さない）"""
    body = "To: a@example.com\nHi John, thanks for the update.\n"
    cleaned = strip_email_recipient_lines(body)
    assert "a@example.com" not in cleaned
    assert "Hi John, thanks for the update." in cleaned


def test_plain_keeps_words_containing_to_or_cc() -> None:
    body = "Go to: the shared folder\nmailto:a@example.com\nAccount: 123\n"
    assert strip_email_recipient_lines(body) == body


# ---------- HTML ----------


def test_html_outlook_japanese_header_with_tags_between_heading_and_colon() -> None:
    html_text = (
        '<p class="MsoNormal"><b><span lang="JA">差出人</span><span lang="EN-US">:</span></b>'
        '<span lang="EN-US"> 佐藤 &lt;sato@example.com&gt;<br></span>'
        '<b>送信日時<span lang="EN-US">:</span></b><span lang="EN-US"> 2026年10月20日<br>'
        '<b>宛先<span lang="EN-US">:</span></b><span lang="EN-US"> 山田 &lt;yamada@example.com&gt;<br>'
        '<b>CC</b><b><span lang="EN-US">:</span></b> 鈴木 &lt;suzuki@example.com&gt;<br>'
        '<b>件名<span lang="EN-US">:</span></b> 会議の件</span></p>'
        "<p>明日のアジェンダです。</p>"
    )
    cleaned = strip_email_recipient_lines(html_text, is_html=True)
    assert "yamada@example.com" not in cleaned
    assert "suzuki@example.com" not in cleaned
    assert "sato@example.com" in cleaned
    assert "2026年10月20日" in cleaned
    assert "会議の件" in cleaned
    assert "明日のアジェンダです。" in cleaned


def test_html_inline_bold_removes_addresses_not_only_heading() -> None:
    cleaned = strip_email_recipient_lines(
        "<b>From:</b> a@example.com<br><b>To:</b> b@example.com; c@example.com<br><b>Subject:</b> s<br>本文<br>",
        is_html=True,
    )
    assert "b@example.com" not in cleaned
    assert "c@example.com" not in cleaned
    assert "a@example.com" in cleaned
    assert "<b>Subject:</b> s" in cleaned
    assert "本文" in cleaned


def test_html_paragraph_and_table_row_forms() -> None:
    assert "x@y.z" not in strip_email_recipient_lines("<p><b>Cc:</b> x@y.z</p><p>本文</p>", is_html=True)
    table = (
        "<table>"
        "<tr><th>差出人:</th><td>alice</td></tr>"
        "<tr><th>To:</th><td>bob@example.com</td></tr>"
        "<tr><th>件名:</th><td>subject</td></tr>"
        "</table>"
    )
    cleaned = strip_email_recipient_lines(table, is_html=True)
    assert "bob@example.com" not in cleaned
    assert "alice" in cleaned and "subject" in cleaned


def test_html_keeps_mailto_links_and_mid_sentence_headings() -> None:
    html_text = (
        '<table><tr><td>問い合わせ: <a href="mailto:help@example.com">help@example.com</a></td></tr></table>'
        "<p>Please go to: the portal</p>"
    )
    cleaned = strip_email_recipient_lines(html_text, is_html=True)
    assert "help@example.com" in cleaned
    assert "Please go to: the portal" in cleaned


def test_html_keeps_tags_balanced() -> None:
    """消すのは文字だけで、タグは残す（開始タグだけ消えて表示が崩れることがない）"""
    html_text = '<div><span style="x"><b>To:</b> a@example.com<br></span><b>Subject:</b> s</div>'
    cleaned = strip_email_recipient_lines(html_text, is_html=True)
    assert cleaned.count("<span") == cleaned.count("</span>")
    assert cleaned.count("<div") == cleaned.count("</div>")


def test_html_without_recipients_is_fast() -> None:
    html_text = _tables(3000)
    started = time.perf_counter()
    result = strip_email_recipient_lines(html_text, is_html=True)
    assert time.perf_counter() - started < 1.0
    assert result == html_text


def test_html_with_recipient_at_end_is_fast_and_keeps_earlier_rows() -> None:
    html_text = _tables(3000) + "<table><tr><th>Cc:</th><td>a@example.com</td></tr><tr><th>件名:</th><td>x</td></tr></table>"
    started = time.perf_counter()
    result = strip_email_recipient_lines(html_text, is_html=True)
    assert time.perf_counter() - started < 1.0
    assert "本文0 " in result and "本文2999 " in result
    assert "a@example.com" not in result
    assert "件名:" in result


def test_empty_input() -> None:
    assert strip_email_recipient_lines("") == ""
    assert strip_email_recipient_lines("", is_html=True) == ""
