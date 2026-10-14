"""
Obsidian Excalidraw プラグイン形式（.excalidraw.md）の読み書き

Markdown ノートの構成:
    ---  (Front Matter: excalidraw-plugin: parsed)
    # Excalidraw Data
    ## Text Elements      テキスト要素の本文と ^要素ID（Obsidian の検索用）
    ## Embedded Files     fileId: [[画像ファイル名]]
    %%
    ## Drawing
    ```compressed-json    LZString(Base64) 圧縮した Excalidraw JSON（旧形式は ```json）
    ```
    %%
"""
import json
import logging
import re
from pathlib import Path
from typing import Dict, Optional

from lzstring import LZString

logger = logging.getLogger("excalidraw.obsidian_markdown")


def find_vault_root(start_path: Path) -> Optional[Path]:
    """
    指定されたパスから上向きに探索して、Obsidian Vaultのルート（.obsidianフォルダがある場所）を見つける
    """
    try:
        current = start_path
        if current.is_file():
            current = current.parent
        
        while current != current.parent:
            if (current / ".obsidian").is_dir():
                return current
            current = current.parent
            
        return None
    except Exception:
        return None

def is_obsidian_path(filepath: str) -> bool:
    """
    パスがObsidian管理下にあるか判定する。
    - .excalidraw.md は場所を問わずObsidian形式として扱う
    - .excalidraw は .obsidian を祖先に持つ場合に移行対象として扱う
    - 既存互換のためパスに 'obsidian' を含む場合も移行対象とする
    """
    path_str = str(filepath).lower()
    if path_str.endswith('.excalidraw.md'):
        return True
    if not path_str.endswith('.excalidraw'):
        return False

    path = Path(filepath).expanduser()
    search_start = path if path.exists() else path.parent
    return find_vault_root(search_start) is not None or 'obsidian' in path_str

EXCALIDRAW_JSON_BLOCK_PATTERN = re.compile(
    r"```(?:compressed-json|json)[ \t]*\r?\n(.*?)\r?\n```",
    re.DOTALL,
)
EXCALIDRAW_PLUGIN_PARSED_PATTERN = re.compile(
    r"^[ \t]*excalidraw-plugin[ \t]*:[ \t]*['\"]?parsed['\"]?[ \t]*$",
    re.MULTILINE | re.IGNORECASE,
)
DRAWING_HEADING_PATTERN = re.compile(
    r"^#{1,6}[ \t]+Drawing[ \t]*$",
    re.MULTILINE | re.IGNORECASE,
)
EXCALIDRAW_DATA_HEADING_PATTERN = re.compile(
    r"^#{1,6}[ \t]+Excalidraw Data[ \t]*$",
    re.MULTILINE | re.IGNORECASE,
)
MARKDOWN_SECTION_BOUNDARY_PATTERN = re.compile(
    r"^(?:#{1,6}[ \t]+\S.*|%%[ \t]*)$",
    re.MULTILINE,
)


def find_excalidraw_json_block(content: str) -> Optional[re.Match[str]]:
    """Drawingセクション内のデータブロックを優先し、見出しのない旧形式にも対応する。"""
    drawing_heading_found = False
    for drawing_heading in DRAWING_HEADING_PATTERN.finditer(content):
        drawing_heading_found = True
        next_heading = MARKDOWN_SECTION_BOUNDARY_PATTERN.search(content, drawing_heading.end())
        section_end = next_heading.start() if next_heading else len(content)
        drawing_block = EXCALIDRAW_JSON_BLOCK_PATTERN.search(
            content,
            drawing_heading.end(),
            section_end,
        )
        if drawing_block:
            return drawing_block

    # Drawing見出しがあるのにブロックがない場合、後続メモのJSONを図面と誤認しない。
    if drawing_heading_found:
        return None

    return EXCALIDRAW_JSON_BLOCK_PATTERN.search(content)


def has_excalidraw_plugin_marker(content: str) -> bool:
    """Obsidian Excalidrawプラグインのparsedノートか判定する。"""
    return EXCALIDRAW_PLUGIN_PARSED_PATTERN.search(content) is not None


def is_excalidraw_markdown_file(file_path: Path, content: Optional[str] = None) -> bool:
    """拡張子またはFront MatterでExcalidraw Markdownか判定する。"""
    path_lower = str(file_path).lower()
    if path_lower.endswith('.excalidraw.md'):
        return True
    if file_path.suffix.lower() != '.md':
        return False
    if content is None:
        try:
            content = file_path.read_text(encoding='utf-8')
        except (OSError, UnicodeError):
            return False
    return has_excalidraw_plugin_marker(content)


def find_excalidraw_markdown_section(
    content: str,
    title: str,
) -> Optional[tuple[int, int]]:
    """Excalidraw Data配下の指定セクションについて、本文の開始・終了位置を返す。"""
    data_heading = EXCALIDRAW_DATA_HEADING_PATTERN.search(content)
    if not data_heading:
        # 非標準の旧Markdownに同名の手書き見出しがあっても変更しない。
        return None
    search_start = data_heading.end()
    heading_pattern = re.compile(
        rf"^#{{1,6}}[ \t]+{re.escape(title)}[ \t]*$",
        re.MULTILINE | re.IGNORECASE,
    )
    heading = heading_pattern.search(content, search_start)
    if not heading:
        return None

    newline_index = content.find("\n", heading.end())
    body_start = len(content) if newline_index == -1 else newline_index + 1
    boundary = MARKDOWN_SECTION_BOUNDARY_PATTERN.search(content, body_start)
    body_end = boundary.start() if boundary else len(content)
    return body_start, body_end


def extract_json_from_markdown(content: str) -> str:
    """
    MarkdownからExcalidraw JSONを抽出する。
    圧縮されている場合は解凍する。
    """
    # Drawing配下の ```compressed-json ... ``` または旧 ```json ... ``` を探す
    match = find_excalidraw_json_block(content)
    if not match:
        raise ValueError("No JSON block found in Markdown")

    # 改行を含む可能性があるので、すべての空白文字（改行含む）を除去
    json_content = match.group(1).strip()

    # JSONとしてパースできるか試みる (非圧縮)
    try:
        json.loads(json_content)
        return json_content
    except json.JSONDecodeError:
        pass

    # パースできなければ圧縮されているとみなして解凍を試みる
    # 圧縮データから改行を除去（Obsidianは複数行に分割して保存する）
    try:
        lz = LZString()
        # すべての改行と空白を除去
        compressed_clean = ''.join(json_content.split())
        decompressed = lz.decompressFromBase64(compressed_clean)
        if not decompressed:
             # 解凍結果が空、または失敗した場合
            raise ValueError("Failed to decompress JSON content")
        
        # サロゲートペアを結合して正しいUnicode文字にする
        # LZString（JS実装）はUTF-16コードユニットを文字として返すため、Pythonではサロゲートペアが分割された状態になることがある
        try:
            decompressed = decompressed.encode('utf-16', 'surrogatepass').decode('utf-16')
        except Exception:
            # 変換に失敗した場合はそのまま進む（あるいはログ出力）
            pass

        # 解凍結果が正当なJSONかチェック
        json.loads(decompressed)
        return decompressed
    except Exception as e:
        raise ValueError(f"Failed to extract/decompress JSON: {e}")

def convert_to_utf16_surrogates(text: str) -> str:
    """
    Python文字列をJSのようなUTF-16サロゲートペアを含む文字列に変換する
    LZStringが32bit文字（絵文字など）を正しく圧縮できない問題を回避するため
    """
    utf16_bytes = text.encode('utf-16le')
    # 2バイトごとに読み込んで文字にする
    chars = []
    for i in range(0, len(utf16_bytes), 2):
        code_unit = int.from_bytes(utf16_bytes[i:i+2], byteorder='little')
        chars.append(chr(code_unit))
    return "".join(chars)


def parse_embedded_files_section(content: str) -> Dict[str, str]:
    """Obsidian markdown の Embedded Files セクションを解析する。パイプやアンカーを除去してリンク先を取得。"""
    embedded_files: Dict[str, str] = {}
    embedded_match = re.search(r"## Embedded Files\n(.*?)\n(?=##|%%|\Z)", content, re.DOTALL)
    if not embedded_match:
        return embedded_files

    for line in embedded_match.group(1).splitlines():
        if ":" not in line or "[[" not in line:
            continue
        file_id, _, remainder = line.partition(":")
        filename_match = re.search(r"\[\[(.*?)\]\]", remainder)
        if filename_match:
            raw_target = filename_match.group(1)
            # パイプ（表示名/サイズ指定）やアンカー（#見出し）を除去
            clean_target = raw_target.split("|")[0].split("#")[0].strip()
            embedded_files[file_id.strip()] = clean_target

    return embedded_files


def embed_json_into_markdown(original_content: Optional[str], json_str: str, image_files: Optional[dict] = None) -> str:
    """
    MarkdownにJSONを埋め込む。
    - JSONはLZStringで圧縮する。
    - original_contentがある場合は、既存のJSONブロックを置換する。
    - ない場合は新規テンプレートを作成する。
    - image_filesがある場合、## Embedded Filesセクションを追加
    - JSONからテキスト要素を抽出して ## Text Elements セクションに記載
    """
    lz = LZString()
    # 32bit文字（絵文字）対応: サロゲートペアに分解してから圧縮
    safe_json_str = convert_to_utf16_surrogates(json_str)
    compressed = lz.compressToBase64(safe_json_str)
    # Obsidianプラグインの動作に合わせて、256文字ごとに改行+空行を挿入
    lines = [compressed[i:i+256] for i in range(0, len(compressed), 256)]
    compressed = '\n\n'.join(lines)

    # JSONデータからテキスト要素を抽出
    text_elements_section = ""
    try:
        data = json.loads(json_str)
        elements = data.get("elements", [])
        text_elements = [el for el in elements if el.get("type") == "text" and not el.get("isDeleted", False)]

        if text_elements:
            for el in text_elements:
                text_content = el.get("text", "")
                element_id = el.get("id", "")
                if text_content and element_id:
                    # Obsidianプラグインに合わせて、改行を維持し、IDを末尾に付与する
                    # 末尾の空白を除去
                    text_content = text_content.rstrip()
                    text_elements_section += f"{text_content} ^{element_id}\n\n"
            # 最後の余分な改行を削除
            text_elements_section = text_elements_section.rstrip('\n') + '\n'
    except Exception as e:
        logger.warning("Failed to extract text elements: %s", e)

    # Embedded Filesセクション（fileId: [[ファイル名]]）
    embedded_body = "".join(
        f"{file_id}: [[{filename}]]\n" for file_id, filename in (image_files or {}).items()
    )
    embedded_files_section = f"## Embedded Files\n{embedded_body}\n" if image_files else ""

    template = """---

excalidraw-plugin: parsed
tags: [excalidraw]

---
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. For more info check in plugin settings under 'Saving'


# Excalidraw Data

## Text Elements
{TEXT_ELEMENTS}{EMBEDDED_FILES}%%
## Drawing
```compressed-json
{COMPRESSED_DATA}
```
%%"""

    if not original_content:
        content = template.replace("{COMPRESSED_DATA}", compressed)
        content = content.replace("{TEXT_ELEMENTS}", text_elements_section)
        content = content.replace("{EMBEDDED_FILES}", embedded_files_section)
        return content

    # 既存コンテンツがある場合、JSONブロック、Text Elements、Embedded Filesセクションを更新

    # 1. Drawingデータブロックだけを置換し、旧 ```json``` も正式な
    #    ```compressed-json``` へ正規化する。Markdown中の別のJSON例は保持する。
    json_block_match = find_excalidraw_json_block(original_content)

    if not json_block_match:
        # 構造が壊れているか、まだブロックがない場合、末尾に追加
        content = original_content + f"\n\n%%\n## Drawing\n```compressed-json\n{compressed}\n```\n%%\n"
    else:
        canonical_block = f"```compressed-json\n{compressed}\n```"
        content = (
            original_content[:json_block_match.start()]
            + canonical_block
            + original_content[json_block_match.end():]
        )

    # 2. Excalidraw Data配下のText Elements本文だけを更新する。
    text_section = find_excalidraw_markdown_section(content, "Text Elements")
    if text_section:
        body_start, body_end = text_section
        content = content[:body_start] + text_elements_section + content[body_end:]

    # 3. Embedded Filesセクションを更新
    if image_files:
        # 既存のEmbedded Filesセクション本文だけを置換
        embedded_section = find_excalidraw_markdown_section(content, "Embedded Files")
        if embedded_section:
            body_start, body_end = embedded_section
            content = content[:body_start] + embedded_body + content[body_end:]
        else:
            # Text Elements本文の後、次のセクション（%%またはDrawing）の前に挿入
            text_section = find_excalidraw_markdown_section(content, "Text Elements")
            if text_section:
                _, body_end = text_section
                content = content[:body_end] + embedded_files_section + content[body_end:]
            else:
                # Text Elementsもない場合、%%の前に挿入
                content = content.replace(
                    "%%\n## Drawing",
                    f"{embedded_files_section}%%\n## Drawing",
                    1,
                )

    return content
