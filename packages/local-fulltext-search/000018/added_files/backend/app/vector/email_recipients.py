"""
メール本文から宛先（To）・Cc・Bcc の行を除く部品（AIインプット書き出しのトークン削減用）。

仕様:
- 見出しは日本語（宛先 / CC / BCC）と英語（To / Cc / Bcc）。大文字小文字・全角（ＣＣ・：）を問わない。
- 差出人・送信日時・件名などの他のヘッダー行と本文は残す。
- 見出しは「行頭」にあるときだけ対象にする。文中の「mailto:」「Go to:」などは消さない。
- プレーンテキスト:
  - 行頭（引用の「>」は読み飛ばす）が見出しで始まる行を除く。
  - 続く折り返し行は、インデントされた行か、直前の宛先行が「,」「;」で終わるときの行だけを除く
    （区切り文字で終わっていなければ次の行は本文として残す）。
- HTML:
  - <br>・</p>・</div>・</tr>・</li> で区切った 1 行の表示文字が見出しで始まるとき、その行の文字とリンク（<a>）を除く。
    それ以外のタグは残すので、開始タグだけが消えて表示が崩れることはない。行末の <br> も除いて空行を作らない。
  - Outlook の「<b>宛先<span>:</span></b>」のように、見出しとコロンの間にタグがあっても対象にする。
  - 1 回の分割と行ごとの先頭一致だけで判定するので、長い本文でも本文の長さに対して線形の時間で終わる。
- 宛先を含めるかの切り替えは呼び出し側（html_exporter / markdown_image_exporter）が持つ。
"""

from __future__ import annotations

import re

# 宛先系の見出し（To / Cc / Bcc と日本語の「宛先」）。全角の ｃｃ / ｂｃｃ は IGNORECASE で大文字にも一致する
_HEADING = r"(?:宛先|to|cc|bcc|ｃｃ|ｂｃｃ)"

# プレーンテキストの宛先行: 行頭の空白と引用記号（> / ＞）の後に見出しとコロン
_PLAIN_RECIPIENT_LINE = re.compile(rf"^[ \t]*(?:[>＞][ \t]*)*{_HEADING}[ \t]*[:：]", re.IGNORECASE)
_PLAIN_QUOTE_PREFIX = re.compile(r"^[ \t]*(?:[>＞][ \t]*)*")
_LIST_SEPARATORS = (",", ";", "，", "；", "、")

# HTML の行区切り（区切り自体も残すため、分割時に取り出す）
_HTML_LINE_BREAK = re.compile(r"(<br\s*/?>|</(?:p|div|tr|li)\s*>)", re.IGNORECASE)
# 行頭の空白・&nbsp;・タグ（見出しとコロンの間にも同じものを許す）
_HTML_GAP = r"(?:\s|&nbsp;|&#160;|<[^>]*>)*"
_HTML_RECIPIENT_LINE = re.compile(rf"{_HTML_GAP}{_HEADING}{_HTML_GAP}[:：]", re.IGNORECASE)
# 宛先行の中身: タグか文字の塊
_HTML_TOKEN = re.compile(r"<[^>]*>|[^<]+|<")
_HTML_ANCHOR_TAG = re.compile(r"</?a\b", re.IGNORECASE)


def strip_email_recipient_lines(text: str, is_html: bool = False) -> str:
    """メール本文（プレーンテキストまたは HTML）から To・Cc・Bcc の行を除いて返す。"""
    if not text:
        return ""
    if is_html:
        return _strip_html(text)
    return _strip_plain(text)


def _strip_plain(text: str) -> str:
    """プレーンテキストの宛先行と、その折り返し行を除く。"""
    kept: list[str] = []
    in_recipients = False
    previous_continues = False
    for line in text.splitlines(keepends=True):
        content = line.rstrip("\r\n")
        if _PLAIN_RECIPIENT_LINE.match(content):
            in_recipients = True
        elif in_recipients and content.strip() and (content[:1] in (" ", "\t") or previous_continues):
            pass  # 宛先の折り返し行
        else:
            in_recipients = False
            kept.append(line)
            continue
        previous_continues = _PLAIN_QUOTE_PREFIX.sub("", content).rstrip().endswith(_LIST_SEPARATORS)
    return "".join(kept)


def _strip_html(text: str) -> str:
    """HTML の宛先行の文字とリンクを除く（タグは残す）。"""
    parts = _HTML_LINE_BREAK.split(text)
    # parts は [行, 区切り, 行, 区切り, ..., 行] の並び
    output: list[str] = []
    drop_next_break = False
    for index, part in enumerate(parts):
        if index % 2 == 1:
            if drop_next_break and part.lower().startswith("<br"):
                drop_next_break = False
                continue
            drop_next_break = False
            output.append(part)
            continue
        if _HTML_RECIPIENT_LINE.match(part):
            output.append(_remove_line_text(part))
            drop_next_break = True
        else:
            output.append(part)
    return "".join(output)


def _remove_line_text(line: str) -> str:
    """1 行から文字とリンクタグを除き、その他のタグだけを残す。"""
    return "".join(
        token
        for token in _HTML_TOKEN.findall(line)
        if token.startswith("<") and len(token) > 1 and not _HTML_ANCHOR_TAG.match(token)
    )
