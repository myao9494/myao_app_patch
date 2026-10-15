"""
Excalidraw の図面データの取り出しと SVG への描画。
仕様:
- `.excalidraw.md` / `.excalidraw` の本文から、圧縮 JSON（compressed-json）・JSON コードブロック・素の JSON の順に図面データを取り出す。
- 図形・線・文字・貼り付け画像を SVG として描く。貼り付け画像は、インライン Data URL、`## Embedded Files` の WikiLink、
  `{fileId}.png` 等のハッシュファイル名の順に解決して埋め込む。
- Markdown 出力向けに、`# Excalidraw Data` 以降（描画データ・圧縮 JSON）を取り除く。
"""

import html
import json
import logging
import lzstring
import math
import re
from pathlib import Path
from typing import Any, Dict, Optional, Union

from app.vector.file_name_index import find_file_by_names
from app.vector.image_data_url import file_to_base64_data_url

logger = logging.getLogger(__name__)


def _merge_surrogate_pairs(text: str) -> str:
    """
    UTF-16 の符号単位のまま並んでいるサロゲートの対を、1 文字へ戻す。
    Excalidraw（JavaScript）が圧縮した文字列を展開すると、絵文字などが上位・下位の 2 文字に分かれて出てくる。
    そのままでは UTF-8 へ変換できず、図面を SVG として埋め込めない。対になっていないものは置換文字にする。
    """
    return text.encode("utf-16", "surrogatepass").decode("utf-16", "replace")


def extract_excalidraw_data(markdown_or_json_text: str) -> Optional[Dict[str, Any]]:
    """MarkdownテキストまたはJSON文字列からExcalidrawのdata辞書を抽出する（## Embedded Files のマッピングも抽出）"""
    data = None
    lines = markdown_or_json_text.splitlines()

    # 1. ```compressed-json ... ```
    in_block = False
    block_lines = []
    for line in lines:
        if "```compressed-json" in line:
            in_block = True
        elif in_block and "```" in line:
            break
        elif in_block:
            block_lines.append(line.strip())
    if block_lines:
        b64 = "".join(block_lines)
        lz = lzstring.LZString()
        decomp = lz.decompressFromBase64(b64)
        if decomp:
            try:
                parsed = json.loads(_merge_surrogate_pairs(decomp))
                if isinstance(parsed, dict) and "elements" in parsed:
                    data = parsed
            except (TypeError, ValueError):
                # 展開結果が JSON でなければ、次の形式を試す
                pass

    # 2. ```json ... ```
    if not data:
        in_json = False
        json_lines = []
        for line in lines:
            if "```json" in line:
                in_json = True
            elif in_json and "```" in line:
                break
            elif in_json:
                json_lines.append(line)
        if json_lines:
            try:
                parsed = json.loads("\n".join(json_lines))
                if isinstance(parsed, dict) and "elements" in parsed:
                    data = parsed
            except (TypeError, ValueError):
                # コードブロックが JSON でなければ、次の形式を試す
                pass

    # 3. Direct JSON
    if not data:
        try:
            parsed = json.loads(markdown_or_json_text)
            if isinstance(parsed, dict) and "elements" in parsed:
                data = parsed
        except (TypeError, ValueError):
            # JSON でなければ Excalidraw データではないので、次の形式を試す
            pass

    if not data:
        return None

    # 4. ## Embedded Files セクションの抽出 (例: {fileId}: [[filename.png]])
    embedded_files: Dict[str, str] = {}
    in_embedded_files = False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("## Embedded Files"):
            in_embedded_files = True
            continue
        elif in_embedded_files:
            if stripped.startswith("#") or stripped.startswith("```"):
                in_embedded_files = False
            else:
                m = re.match(r"^([a-zA-Z0-9_-]+)\s*:\s*!?\[\[([^\]|]+)(?:\|[^\]]*)?\]\]", stripped)
                if m:
                    fid = m.group(1).strip()
                    link_target = m.group(2).strip()
                    embedded_files[fid] = link_target

    data["embedded_files"] = embedded_files
    return data


def resolve_excalidraw_image_data_url(
    file_id: str,
    file_entry: Dict[str, Any],
    embedded_files: Dict[str, str],
    vault_dir: Optional[Path] = None,
    current_dir: Optional[Path] = None,
) -> Optional[str]:
    """
    Excalidraw内の画像要素（fileId）に対応するBase64 Data URLを解決する。
    1. file_entry内のインライン dataURL
    2. ## Embedded Files でマッピングされたリンクパス（WikiLink形式）
    3. カレントディレクトリまたはVault内の {file_id}.* ファイル
    4. Vault全体の再帰探索
    """
    # 1. インライン dataURL
    if file_entry and isinstance(file_entry, dict):
        durl = file_entry.get("dataURL")
        if durl and isinstance(durl, str) and durl.startswith("data:image/"):
            return durl

    # 2. ## Embedded Files のWikiLink解決
    link_target = embedded_files.get(file_id)
    search_names = []
    if link_target:
        clean_link = link_target.split("|")[0].strip()
        search_names.append(clean_link)

    # 3. {file_id}.* も候補に追加
    if file_id:
        for ext in [".png", ".jpg", ".jpeg", ".svg", ".webp", ".gif", ".bmp"]:
            search_names.append(f"{file_id}{ext}")

    # 探索先ディレクトリ候補
    search_dirs = []
    if current_dir and current_dir.exists():
        search_dirs.append(current_dir)
    if vault_dir and vault_dir.exists():
        search_dirs.append(vault_dir)
        if vault_dir.parent.exists() and vault_dir.parent != vault_dir:
            search_dirs.append(vault_dir.parent)
        for sub in ["01_data/common_image", "common_image", "attachments", "assets", "images"]:
            sub_p = vault_dir / sub
            if sub_p.exists() and sub_p.is_dir():
                search_dirs.append(sub_p)

    # 各探索先で候補名をチェック
    for name in search_names:
        for s_dir in search_dirs:
            p = (s_dir / name).resolve()
            if p.exists() and p.is_file():
                durl = file_to_base64_data_url(p)
                if durl:
                    return durl

    # Vault全体の再帰探索
    if vault_dir and vault_dir.exists():
        target_basenames = list(dict.fromkeys(Path(n).name for n in search_names))
        found_file = find_file_by_names(vault_dir, target_basenames, hidden="skip_files")
        if found_file is not None:
            durl = file_to_base64_data_url(found_file)
            if durl:
                return durl

    return None


def excalidraw_to_svg(
    data: Dict[str, Any],
    vault_path: Optional[Union[str, Path]] = None,
    current_file_path: Optional[Union[str, Path]] = None,
) -> str:
    """ExcalidrawのJSON辞書から自己完結型の高解像度ベクターSVGを動的生成する"""
    elements = [e for e in data.get("elements", []) if not e.get("isDeleted", False)]
    if not elements:
        return '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100" style="background-color: #ffffff; color-scheme: light;"></svg>'

    v_dir = Path(vault_path).resolve() if vault_path else None
    cur_dir = None
    if current_file_path:
        p = Path(current_file_path)
        cur_dir = p.parent.resolve() if (p.is_file() or p.suffix) else p.resolve()
    elif v_dir:
        cur_dir = v_dir

    embedded_files = data.get("embedded_files", {})

    # バウンディングボックスの計算
    min_x = float("inf")
    min_y = float("inf")
    max_x = float("-inf")
    max_y = float("-inf")

    for elem in elements:
        ex = elem.get("x", 0)
        ey = elem.get("y", 0)
        ew = elem.get("width", 0)
        eh = elem.get("height", 0)
        points = elem.get("points")

        if points:
            for pt in points:
                px = ex + pt[0]
                py = ey + pt[1]
                min_x = min(min_x, px)
                min_y = min(min_y, py)
                max_x = max(max_x, px)
                max_y = max(max_y, py)
        else:
            min_x = min(min_x, ex)
            min_y = min(min_y, ey)
            max_x = max(max_x, ex + ew)
            max_y = max(max_y, ey + eh)

    padding = 24
    if math.isinf(min_x) or math.isinf(max_x):
        min_x, min_y, max_x, max_y = 0, 0, 400, 300

    view_x = min_x - padding
    view_y = min_y - padding
    view_w = max(max_x - min_x + padding * 2, 10)
    view_h = max(max_y - min_y + padding * 2, 10)

    bg_color = data.get("appState", {}).get("viewBackgroundColor", "#ffffff")
    if bg_color == "transparent" or not bg_color:
        bg_color = "#ffffff"

    svg_parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
        f'version="1.1" width="{view_w}" height="{view_h}" viewBox="{view_x} {view_y} {view_w} {view_h}" '
        f'style="background-color: {bg_color}; color-scheme: light;">',
        f'<rect x="{view_x}" y="{view_y}" width="{view_w}" height="{view_h}" fill="{bg_color}" />'
    ]

    files = data.get("files", {})

    for elem in elements:
        etype = elem.get("type")
        x = elem.get("x", 0)
        y = elem.get("y", 0)
        w = elem.get("width", 0)
        h = elem.get("height", 0)
        stroke = elem.get("strokeColor", "#000000")
        fill = elem.get("backgroundColor", "transparent")
        if fill == "transparent" or elem.get("fillStyle") == "transparent":
            fill = "none"
        stroke_w = elem.get("strokeWidth", 1)
        opacity = elem.get("opacity", 100) / 100.0
        angle = elem.get("angle", 0)

        dash_attr = ""
        if elem.get("strokeStyle") == "dashed":
            dash_attr = ' stroke-dasharray="8,6"'
        elif elem.get("strokeStyle") == "dotted":
            dash_attr = ' stroke-dasharray="2,4"'

        transform_attr = ""
        if angle != 0:
            cx = x + w / 2
            cy = y + h / 2
            deg = math.degrees(angle)
            transform_attr = f' transform="rotate({deg} {cx} {cy})"'

        roundness = elem.get("roundness")
        rx = 8 if roundness else 0

        common_style = f'fill="{fill}" stroke="{stroke}" stroke-width="{stroke_w}" opacity="{opacity}"{dash_attr}{transform_attr}'

        if etype == "rectangle":
            svg_parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" {common_style} />')
        elif etype == "ellipse":
            cx = x + w / 2
            cy = y + h / 2
            rx_val = abs(w) / 2
            ry_val = abs(h) / 2
            svg_parts.append(f'<ellipse cx="{cx}" cy="{cy}" rx="{rx_val}" ry="{ry_val}" {common_style} />')
        elif etype == "diamond":
            p1 = f"{x + w/2},{y}"
            p2 = f"{x + w},{y + h/2}"
            p3 = f"{x + w/2},{y + h}"
            p4 = f"{x},{y + h/2}"
            svg_parts.append(f'<polygon points="{p1} {p2} {p3} {p4}" {common_style} />')
        elif etype in ("line", "arrow", "freedraw"):
            points = elem.get("points", [])
            if points:
                pts_str = " ".join([f"{x + pt[0]},{y + pt[1]}" for pt in points])
                line_fill = fill if elem.get("polygon") else "none"
                svg_parts.append(f'<polyline points="{pts_str}" fill="{line_fill}" stroke="{stroke}" stroke-width="{stroke_w}" stroke-linecap="round" stroke-linejoin="round" opacity="{opacity}"{dash_attr}{transform_attr} />')

                # 矢印先端の描画
                if etype == "arrow" and len(points) >= 2 and elem.get("endArrowhead") == "arrow":
                    p_end = points[-1]
                    p_prev = points[-2]
                    dx = p_end[0] - p_prev[0]
                    dy = p_end[1] - p_prev[1]
                    line_len = math.hypot(dx, dy)
                    if line_len > 0:
                        ux = dx / line_len
                        uy = dy / line_len
                        arrow_size = min(stroke_w * 8 + 4, 20)
                        tip_x = x + p_end[0]
                        tip_y = y + p_end[1]
                        left_x = tip_x - arrow_size * ux + (arrow_size / 2) * uy
                        left_y = tip_y - arrow_size * uy - (arrow_size / 2) * ux
                        right_x = tip_x - arrow_size * ux - (arrow_size / 2) * uy
                        right_y = tip_y - arrow_size * uy + (arrow_size / 2) * ux
                        svg_parts.append(f'<polygon points="{tip_x},{tip_y} {left_x},{left_y} {right_x},{right_y}" fill="{stroke}" opacity="{opacity}" />')

        elif etype == "text":
            raw_text = elem.get("text", "")
            font_size = elem.get("fontSize", 20)
            font_family = "sans-serif, -apple-system, BlinkMacSystemFont"
            text_lines = raw_text.splitlines()
            line_height = font_size * 1.25
            for idx, tl in enumerate(text_lines):
                t_y = y + font_size + idx * line_height
                escaped = html.escape(tl)
                svg_parts.append(f'<text x="{x}" y="{t_y}" font-size="{font_size}" font-family="{font_family}" fill="{stroke}" opacity="{opacity}"{transform_attr}>{escaped}</text>')
        elif etype == "image":
            file_id = elem.get("fileId") or ""
            file_entry = files.get(file_id, {})
            data_url = resolve_excalidraw_image_data_url(
                file_id=file_id,
                file_entry=file_entry,
                embedded_files=embedded_files,
                vault_dir=v_dir,
                current_dir=cur_dir,
            )
            if data_url:
                svg_parts.append(
                    f'<image href="{data_url}" xlink:href="{data_url}" '
                    f'x="{x}" y="{y}" width="{w}" height="{h}" '
                    f'opacity="{opacity}"{transform_attr} preserveAspectRatio="none" />'
                )

    svg_parts.append("</svg>")
    return "\n".join(svg_parts)


def strip_excalidraw_data(text: str) -> str:
    """
    Excalidrawの描画バイナリ・JSONデータ（# Excalidraw Data 以降）を除去する。
    AIインプット等において意味不明な圧縮JSON（compressed-json）やテキスト要素が
    出力されるのを防ぎ、トークンを節約する。
    """
    if not text:
        return ""
    cleaned = re.sub(r"(?im)(?:^|\r?\n)#+\s*Excalidraw(?:\s+Data)?\b[^\n]*(?:\r?\n[\s\S]*)?$", "", text)
    return cleaned.rstrip() + "\n"


def is_excalidraw_backed_markdown(file_path: Path) -> bool:
    """MarkdownノートがExcalidraw図面データを含むか判定する"""
    name_lower = file_path.name.lower()
    if name_lower.endswith(".excalidraw.md") or name_lower.endswith(".excalidraw"):
        return True

    if not file_path.exists() or not file_path.is_file() or file_path.suffix.lower() != ".md":
        return False

    try:
        content = file_path.read_text(encoding="utf-8", errors="replace")[:3000]
        if "excalidraw-plugin:" in content:
            return True
        if re.search(r"tags:\s*\n(?:\s*-\s*.*\n)*\s*-\s*excalidraw\b", content, re.IGNORECASE):
            return True
        if "# Excalidraw" in content:
            return True
    except OSError:
        logger.debug("Failed to read a file while checking whether it is an Excalidraw note.", exc_info=True)
    return False
