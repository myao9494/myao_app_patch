#!/usr/bin/env python3
"""
仕様: ノートにある、ファイルマネージャーで開くリンク（http://localhost:8001/api/open-path?path=…）を、
      パスそのものの file:/// のリンクへまとめて書き換える。

convert_open_path_links.js の Python 版（Node が使えない環境のため）。書き換えの内容と表示は JS 版と同じ。
変換のきまりを変えるときは、両方と、From Clipboard（11_from_clipboard.js の localPathToFileUrl）をそろえる。
詳細は docs/file_path_links_spec.md の 5章。

書き換え:
  [名前](http://localhost:8001/api/open-path?path=%2FUsers%2Fa%2F資料.pdf) → [名前](file:///Users/a/資料.pdf)
  <http://localhost:8001/api/open-path?path=…> と、本文にそのまま書いた URL      → [資料.pdf](file:///Users/a/資料.pdf)
  UNC パス \\\\server@80\\share\\… は file:////server@80/share/… にする。

書き換えないもの:
  - コードブロック（``` / ~~~）とインラインコード（`…`）の中
  - 絶対パスでないもの（一覧に出す）
  - Excalidraw の図のデータ（# Excalidraw Data 以降）
  - 隠しフォルダ、node_modules、docs、scratch、00_templates、80_script、保管庫の直下のファイル
  - localhost:3001/?filepath=…（Excalidraw の Web アプリで開くリンク）

使い方（保管庫のフォルダで実行する）:
  python3 80_script/convert_open_path_links.py            # 確認だけ（書き換える箇所を表示する）
  python3 80_script/convert_open_path_links.py --write    # 書き換える
  python3 80_script/convert_open_path_links.py --write 01_data/2026   # フォルダやファイルを指定する
"""

import os
import re
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

VAULT_ROOT = Path(__file__).resolve().parent.parent
EXCLUDED_DIRECTORIES = {"node_modules", "docs", "scratch", "00_templates", "80_script"}

# file:/// の URL でエンコードする文字（11_from_clipboard.js の FILE_URL_ESCAPE_CHARS と同じ）
FILE_URL_ESCAPE_CHARS = re.compile(r"[%\s()<>#?]")
# open-path の URL 部分。古いリンクには半角括弧がエンコードされずに残っているので、対応の取れた括弧は URL に含める
OPEN_PATH_URL = r"http://localhost:8001/api/open-path\?path=(?:[^()\s<>\]]|\([^()\s]*\))+"
MARKDOWN_LINK_TEXT = r"\[(?:\\.|[^\]\\])*\]"
OPEN_PATH_PATTERN = re.compile(
    rf"({MARKDOWN_LINK_TEXT})\(({OPEN_PATH_URL})\)|<({OPEN_PATH_URL})>|({OPEN_PATH_URL})"
)
# コードブロックとインラインコード。この中は書き換えない
CODE_PATTERN = re.compile(
    r"(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[^\n]*(?=\n|\Z)|\Z)|`[^`\n]+`"
)
EXCALIDRAW_DATA_PATTERN = re.compile(r"^(?:%%\s*\n)?# Excalidraw Data\s*$", re.MULTILINE)


def decode_uri_safely(value: str) -> str:
    """%XX の並びごとにデコードする。デコードできない部分（名前の % など）だけを残す。"""

    def decode(match: re.Match) -> str:
        encoded = match.group(0)
        try:
            return bytes.fromhex(encoded.replace("%", "")).decode("utf-8")
        except UnicodeDecodeError:
            return encoded

    return re.sub(r"(?:%[0-9a-fA-F]{2})+", decode, value)


def encode_file_url_char(match: re.Match) -> str:
    return "".join(f"%{byte:02X}" for byte in match.group(0).encode("utf-8"))


def local_path_to_file_url(local_path: str):
    """ローカルの絶対パスを file:/// の URL にする。絶対パスでなければ None。"""
    slashed = str(local_path or "").strip().replace("\\", "/")
    if re.match(r"^//[^/]", slashed):
        url_path = slashed
    elif re.match(r"^[A-Za-z]:(?:/|$)", slashed):
        url_path = f"/{slashed}"
    elif slashed.startswith("/"):
        url_path = re.sub(r"^/+", "/", slashed)
    else:
        return None
    return "file://" + FILE_URL_ESCAPE_CHARS.sub(encode_file_url_char, url_path)


def get_last_path_segment(path_value: str):
    normalized = re.sub(r"/+$", "", path_value.replace("\\", "/"))
    segments = [segment for segment in normalized.split("/") if segment]
    return segments[-1] if segments else None


def escape_markdown_link_text(text: str) -> str:
    return re.sub(r"(?<!\\)[\[\]]", lambda match: "\\" + match.group(0), text)


def open_path_url_to_local_path(url: str):
    """open-path の URL からパスを取り出す。"""
    values = parse_qs(urlsplit(url).query, keep_blank_values=True).get("path")
    if values and values[0]:
        return values[0]
    match = re.search(r"[?&]path=([^&]+)", url)
    return decode_uri_safely(match.group(1).replace("+", " ")) if match else None


def convert_open_path_links_in_text(text: str):
    """テキストの中の open-path のリンクを file:/// のリンクにする。(書き換えた文字列, 書き換えた箇所, 書き換えなかった箇所)"""
    changes = []
    skipped = []

    def replace(match: re.Match) -> str:
        whole, link_text, link_url, angle_url, bare_url = match.group(0), *match.groups()
        url = link_url or angle_url or bare_url
        local_path = open_path_url_to_local_path(url)
        file_url = local_path_to_file_url(local_path) if local_path else None
        if not file_url:
            skipped.append(whole)
            return whole
        name = link_text or f"[{escape_markdown_link_text(get_last_path_segment(local_path) or local_path)}]"
        replacement = f"{name}({file_url})"
        changes.append({"from": whole, "to": replacement})
        return replacement

    result = []
    last_index = 0
    for code in CODE_PATTERN.finditer(text):
        result.append(OPEN_PATH_PATTERN.sub(replace, text[last_index:code.start()]))
        result.append(code.group(0))
        last_index = code.end()
    result.append(OPEN_PATH_PATTERN.sub(replace, text[last_index:]))
    return "".join(result), changes, skipped


def convert_open_path_links_in_note(content: str):
    """ノート全体を書き換える。Excalidraw の図のデータ（# Excalidraw Data 以降）は変えない。"""
    data_start = EXCALIDRAW_DATA_PATTERN.search(content)
    head = content[: data_start.start()] if data_start else content
    tail = content[data_start.start():] if data_start else ""
    text, changes, skipped = convert_open_path_links_in_text(head)
    return text + tail, changes, skipped


def list_markdown_files(target: Path):
    if target.is_file():
        return [target] if target.suffix == ".md" else []
    files = []
    for entry in sorted(target.iterdir(), key=lambda item: item.name):
        if entry.is_dir():
            if entry.name.startswith(".") or entry.name in EXCLUDED_DIRECTORIES:
                continue
            files.extend(list_markdown_files(entry))
        elif entry.is_file() and entry.suffix == ".md":
            # 保管庫の直下のファイル（CLAUDE.md などの説明）は対象外
            if target == VAULT_ROOT:
                continue
            files.append(entry)
    return files


def main(argv):
    write = "--write" in argv
    targets = [(VAULT_ROOT / arg).resolve() for arg in argv if arg != "--write"]
    files = [file for target in (targets or [VAULT_ROOT]) for file in list_markdown_files(target)]

    changed_files = 0
    changed_links = 0
    for file in files:
        # 改行コード（CRLF）を変えないよう、改行の変換をせずに読み書きする
        with open(file, encoding="utf-8", newline="") as handle:
            content = handle.read()
        if "localhost:8001/api/open-path" not in content:
            continue
        text, changes, skipped = convert_open_path_links_in_note(content)
        relative_path = Path(os.path.relpath(file, VAULT_ROOT)).as_posix()
        for item in skipped:
            print(f"[変換しない] {relative_path}: {item}")
        if not changes:
            continue
        changed_files += 1
        changed_links += len(changes)
        print(f"\n{relative_path}（{len(changes)}件）")
        for change in changes:
            print(f"  {change['from']}\n  → {change['to']}")
        if write:
            with open(file, "w", encoding="utf-8", newline="") as handle:
                handle.write(text)
    suffix = "を書き換えました。" if write else "を書き換えます（確認だけ。書き換えるには --write を付ける）。"
    print(f"\n{changed_files}ファイル、{changed_links}件{suffix}")


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    main(sys.argv[1:])
