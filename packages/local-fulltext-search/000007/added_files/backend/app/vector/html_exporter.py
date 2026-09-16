"""
AIコンテキスト用HTMLエクスポートモジュール (HtmlExporter)
仕様:
- Obsidian Markdownファイルを解析し、チャット型AI（会社AI）にインプット可能な単一の自己完結型HTMLを生成する。
- ローカル画像（PNG, JPG, WebP, GIF, SVG, Drawio等）およびExcalidraw図面キャッシュ (.excalidraw-cache) をBase64 Data URLとしてインライン埋め込み。
- Markdownからリンクされているメールファイル（.msg / .eml / winmail.dat）を検出し、APPENDIXとしてHTML末尾に展開。
- include_images=True の場合、メール内のインライン画像（CID画像）および添付画像もBase64 Data URLとして埋め込む。
- Outlook特有のOfficeメタデータ（<!--[if ...]>、<xml>、<o:p> 等）をサニタイズして文字化けやタグ露出を防止。
- AIへの共通プロンプト、ドキュメント目次、レンダリング本文、マークダウン元データ（Raw Markdown）を統合。
- 外部依存のない軽量・高可読なライトテーマCSSを適用。
"""

import base64
import email
import email.policy
import html
import json
import math
import mimetypes
import os
import re
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

import lzstring
from markdown_it import MarkdownIt

# Markdownパーサーの初期化
md_parser = MarkdownIt("commonmark", {"breaks": True, "html": True}).enable("table")

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".svg", ".webp", ".ico"}
FIGURE_EXTENSIONS = {".drawio.svg", ".dio.svg", ".excalidraw.md", ".excalidraw"}
EMAIL_EXTENSIONS = {".msg", ".eml", ".dat"}


def sanitize_svg_for_light_theme(svg_text: str) -> str:
    """
    Drawio や一般の SVG に含まれるダークモード設定 (color-scheme: light dark, light-dark(...))
    を除去・正規化し、常に白背景・黒線（ライトモード）で正常描画されるように変換する。
    """
    # 1. color-scheme: light dark -> color-scheme: light
    cleaned = re.sub(r"color-scheme\s*:\s*light\s+dark\s*;?", "color-scheme: light;", svg_text, flags=re.IGNORECASE)

    # 2. light-dark(valLight, valDark) -> valLight
    cleaned = re.sub(r"light-dark\s*\(\s*([^,\(\)]+)\s*,\s*[^,\(\)]+\s*\)", r"\1", cleaned, flags=re.IGNORECASE)

    # 3. background: transparent -> background-color: #ffffff (または light)
    # <svg ...> タグ内に style 属性がある場合は color-scheme: light を保証
    def ensure_svg_root_style(match: re.Match) -> str:
        tag = match.group(0)
        if "style=" in tag:
            tag = re.sub(r'style="([^"]*)"', lambda m: f'style="{m.group(1).replace("color-scheme: light dark", "color-scheme: light")}; color-scheme: light; background-color: #ffffff;"', tag)
        else:
            tag = tag[:-1] + ' style="color-scheme: light; background-color: #ffffff;">'
        return tag

    cleaned = re.sub(r"<svg\b[^>]*>", ensure_svg_root_style, cleaned, count=1, flags=re.IGNORECASE)
    return cleaned


def sanitize_outlook_html(html_text: str) -> str:
    """
    Outlook/Word特有のHTMLタグやコメント、Officeメタデータを除去して安全なHTMLへ変換する。
    - 条件付きコメント (<!--[if ...]>...<![endif]--> を含む) を一括完全除去
    - <head>, <style>, <script>, <xml>, <title> タグおよび内部コンテンツを完全除去
    - 独立した <!DOCTYPE>, <?xml>, </?xml...>, および <o:p>, <w:...>, <v:...> 等の名前空間タグを完全除去
    """
    if not html_text:
        return ""
    clean = str(html_text)
    # 1. コメント（条件付きコメント <!--[if ...]>...<![endif]--> を含む）を一括完全除去
    clean = re.sub(r"<!--[\s\S]*?-->", "", clean)
    # 2. <head>...</head>, <style>...</style>, <script>...</script>, <xml>...</xml>, <title>...</title> の完全除去
    clean = re.sub(r"<(head|style|script|xml|title)\b[^>]*>[\s\S]*?<\/\1>", "", clean, flags=re.IGNORECASE)
    # 3. 独立したDOCTYPEやXMLタグ、名前空間タグの除去
    clean = re.sub(r"<!DOCTYPE\b[^>]*>", "", clean, flags=re.IGNORECASE)
    clean = re.sub(r"<\/?xml\b[^>]*>", "", clean, flags=re.IGNORECASE)
    clean = re.sub(r"<\/?\w+:[^>]*>", "", clean, flags=re.IGNORECASE)
    return clean.strip()


def extract_excalidraw_data(markdown_or_json_text: str) -> Optional[Dict[str, Any]]:
    """MarkdownテキストまたはJSON文字列からExcalidrawのdata辞書を抽出する"""
    # 1. ```compressed-json ... ```
    lines = markdown_or_json_text.splitlines()
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
                data = json.loads(decomp)
                if isinstance(data, dict) and "elements" in data:
                    return data
            except Exception:
                pass

    # 2. ```json ... ```
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
            data = json.loads("\n".join(json_lines))
            if isinstance(data, dict) and "elements" in data:
                return data
        except Exception:
            pass

    # 3. Direct JSON
    try:
        data = json.loads(markdown_or_json_text)
        if isinstance(data, dict) and "elements" in data:
            return data
    except Exception:
        pass

    return None


def excalidraw_to_svg(data: Dict[str, Any]) -> str:
    """ExcalidrawのJSON辞書から自己完結型の高解像度ベクターSVGを動的生成する"""
    elements = [e for e in data.get("elements", []) if not e.get("isDeleted", False)]
    if not elements:
        return '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100" style="background-color: #ffffff; color-scheme: light;"></svg>'

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
            file_id = elem.get("fileId")
            file_entry = files.get(file_id, {})
            data_url = file_entry.get("dataURL", "")
            if data_url:
                svg_parts.append(f'<image href="{data_url}" x="{x}" y="{y}" width="{w}" height="{h}" opacity="{opacity}"{transform_attr} />')

    svg_parts.append("</svg>")
    return "\n".join(svg_parts)


def strip_frontmatter(text: str) -> str:
    """YAML Frontmatterを除去する"""
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) >= 3:
            return parts[2].lstrip()
    return text


def strip_excalidraw_data(text: str) -> str:
    """Excalidrawの描画バイナリ・JSONデータ（# Excalidraw Data 以降）を除去する"""
    return re.sub(r"(?:^|\r?\n)#\s*Excalidraw(?:\s+Data)?\s*\r?\n[\s\S]*$", "\n", text, flags=re.IGNORECASE)


def expand_wikilinks(text: str) -> str:
    """Obsidianの内部リンク ([[リンク先|表示名]] または [[リンク先]]) を表示名に展開する"""
    # リンク記法 [[target|alias]] -> alias
    text = re.sub(r"\[\[(?:[^\]\|]+\|)([^\]]+)\]\]", r"\1", text)
    # リンク記法 [[target]] -> target (ファイル名のみ表示)
    text = re.sub(r"\[\[([^\]]+)\]\]", r"\1", text)
    return text


def get_fnv1a_hash(val: str) -> str:
    """Obsidian Excalidrawプラグイン互換のFNV-1aハッシュ計算 (32-bit unsigned hex)"""
    normalized = val.replace("\\", "/").strip("/")
    h = 2166136261
    for c in normalized:
        h = ((h ^ ord(c)) * 16777619) & 0xFFFFFFFF
    return hex(h)[2:]


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
    except Exception:
        pass
    return False


def find_excalidraw_cache_dirs(vault_path: Path) -> List[Path]:
    """.excalidraw-cache ディレクトリをVaultおよび祖先ディレクトリから探索する"""
    cache_dirs = []
    current = vault_path.resolve()
    # 最大4階層上まで探索
    for _ in range(5):
        c = current / ".excalidraw-cache"
        if c.exists() and c.is_dir():
            cache_dirs.append(c)
        if current.parent == current:
            break
        current = current.parent
    return cache_dirs


def load_excalidraw_cache_indices(cache_dirs: List[Path]) -> Dict[str, Any]:
    """.excalidraw-cache/index.json からインデックスデータを読み込む"""
    index_map = {}
    for c_dir in cache_dirs:
        idx_file = c_dir / "index.json"
        if idx_file.exists():
            try:
                data = json.loads(idx_file.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    index_map.update(data)
            except Exception:
                pass
    return index_map


def find_excalidraw_cache_image(
    target_file: Path,
    vault_path: Path,
    cache_dirs: List[Path],
    index_data: Dict[str, Any],
) -> Optional[Path]:
    """対象のExcalidrawノートに対応するPNG/SVGプレビューキャッシュを探索する"""
    if not cache_dirs:
        return None

    # 相対パス候補
    path_candidates = []
    try:
        path_candidates.append(str(target_file.relative_to(vault_path)).replace("\\", "/"))
    except ValueError:
        pass

    # 祖先ディレクトリからの相対パス
    current_v = vault_path
    for _ in range(3):
        try:
            path_candidates.append(str(target_file.relative_to(current_v)).replace("\\", "/"))
        except ValueError:
            pass
        current_v = current_v.parent

    path_candidates.append(target_file.name)
    if target_file.name.endswith(".md"):
        path_candidates.append(target_file.name[:-3])

    # 1. index.json によるマッチング
    for cand in path_candidates:
        norm_cand = cand.strip("/")
        entry = index_data.get(norm_cand) or index_data.get(cand)
        if entry and isinstance(entry, dict):
            cachefile_name = entry.get("cachefile") or entry.get("fallbackCachefile")
            if cachefile_name:
                for c_dir in cache_dirs:
                    cf = c_dir / Path(cachefile_name).name
                    if cf.exists() and cf.is_file():
                        return cf

    # 2. FNV-1a ハッシュ値によるキャッシュファイル名マッチング ({hash}_*.png, {hash}_*.svg)
    for cand in path_candidates:
        h = get_fnv1a_hash(cand)
        for c_dir in cache_dirs:
            try:
                for cf in c_dir.iterdir():
                    if cf.is_file() and cf.name.startswith(f"{h}_") and (cf.name.endswith(".png") or cf.name.endswith(".svg")):
                        return cf
            except Exception:
                pass

    return None


def file_to_base64_data_url(file_path: Path) -> Optional[str]:
    """画像ファイルをBase64 Data URL (data:image/...;base64,...) に変換する（SVGはライトモード正規化を適用）"""
    try:
        suffix = file_path.suffix.lower()
        name_lower = file_path.name.lower()

        if name_lower.endswith((".svg", ".drawio.svg", ".dio.svg")) or suffix == ".svg":
            mime_type = "image/svg+xml"
            raw_text = file_path.read_text(encoding="utf-8", errors="replace")
            sanitized_svg = sanitize_svg_for_light_theme(raw_text)
            b64 = base64.b64encode(sanitized_svg.encode("utf-8")).decode("ascii")
            return f"data:{mime_type};base64,{b64}"
        elif suffix == ".webp":
            mime_type = "image/webp"
        elif suffix in (".jpg", ".jpeg"):
            mime_type = "image/jpeg"
        elif suffix == ".png":
            mime_type = "image/png"
        elif suffix == ".gif":
            mime_type = "image/gif"
        elif suffix == ".bmp":
            mime_type = "image/bmp"
        else:
            mime_type, _ = mimetypes.guess_type(str(file_path))
            if not mime_type or not mime_type.startswith("image/"):
                return None

        data = file_path.read_bytes()
        b64 = base64.b64encode(data).decode("ascii")
        return f"data:{mime_type};base64,{b64}"
    except Exception:
        return None


def svg_text_to_base64_data_url(svg_text: str) -> str:
    """SVGテキストを Base64 Data URL に変換する"""
    sanitized = sanitize_svg_for_light_theme(svg_text)
    b64 = base64.b64encode(sanitized.encode("utf-8")).decode("ascii")
    return f"data:image/svg+xml;base64,{b64}"


def resolve_image_or_figure_data_url(
    vault_path_str: str,
    raw_link: str,
    current_file_path: str = "",
) -> Tuple[Optional[str], bool]:
    """
    Markdown内の埋め込みリンク (raw_link) を解決し、Base64 Data URL と is_excalidraw フラグを返す。
    Excalidrawプレビューキャッシュが存在しない場合でも、ノート内の compressed-json / JSON から
    高品質なベクターSVGを自動生成して Data URL 化する。
    戻り値: (Base64_Data_URL, is_excalidraw)
    """
    vault_dir = Path(vault_path_str).resolve()
    # URLデコード (例: Pasted%20image.png -> Pasted image.png)
    decoded_name = urllib.parse.unquote(raw_link.split("?")[0].split("#")[0].strip())
    clean_name = decoded_name

    cache_dirs = find_excalidraw_cache_dirs(vault_dir)
    index_data = load_excalidraw_cache_indices(cache_dirs)

    # current_dir を安全に特定
    current_dir = vault_dir
    current_file_obj = None
    if current_file_path:
        cur_p = Path(current_file_path)
        if cur_p.is_absolute() and cur_p.exists():
            current_dir = cur_p.parent
            current_file_obj = cur_p
        else:
            cand_f, _ = resolve_document_file(vault_dir, current_file_path)
            if cand_f and cand_f.exists():
                current_dir = cand_f.parent
                current_file_obj = cand_f
            else:
                current_dir = (vault_dir / current_file_path).parent

    # 1. カレントディレクトリおよびVaultからの探索候補
    search_candidates = [
        clean_name,
        clean_name + ".png",
        clean_name + ".jpg",
        clean_name + ".jpeg",
        clean_name + ".svg",
        clean_name + ".drawio.svg",
        clean_name + ".dio.svg",
        clean_name + ".excalidraw.md",
        clean_name + ".excalidraw",
        clean_name + ".md",
    ]

    target_file = None

    # 1-0. 自己参照リンクの判定 (![[りんご|75]] が りんご.md 内にある場合)
    if current_file_obj and (clean_name == current_file_obj.stem or clean_name == current_file_obj.name):
        target_file = current_file_obj

    # 1-1. カレントディレクトリ内を探索
    if not target_file:
        for cand in search_candidates:
            p = (current_dir / cand).resolve()
            if p.exists() and p.is_file():
                target_file = p
                break

    # 1-2. Vaultルート直下・直接パスを探索
    if not target_file:
        for cand in search_candidates:
            p = (vault_dir / cand).resolve()
            if p.exists() and p.is_file():
                target_file = p
                break

    # 1-3. Vault親ディレクトリ直下を探索 (01_data等のプレフィックスがある場合)
    if not target_file:
        for cand in search_candidates:
            p = (vault_dir.parent / cand).resolve()
            if p.exists() and p.is_file():
                target_file = p
                break

    # 1-4. Vault内の再帰探索（同名ファイル）
    if not target_file:
        file_basename = Path(clean_name).name
        for root, dirs, files in os.walk(vault_dir):
            if Path(root).name.startswith("."):
                continue
            for cand in [file_basename, file_basename + ".png", file_basename + ".svg", file_basename + ".drawio.svg", file_basename + ".excalidraw.md", file_basename + ".md"]:
                if cand in files:
                    p = Path(root) / cand
                    if p.is_file():
                        target_file = p
                        break
            if target_file:
                break

    # 1-5. Vault親ディレクトリの再帰探索（同名ファイル）
    if not target_file:
        file_basename = Path(clean_name).name
        for root, dirs, files in os.walk(vault_dir.parent):
            if Path(root).name.startswith("."):
                continue
            for cand in [file_basename, file_basename + ".png", file_basename + ".svg", file_basename + ".drawio.svg", file_basename + ".excalidraw.md", file_basename + ".md"]:
                if cand in files:
                    p = Path(root) / cand
                    if p.is_file():
                        target_file = p
                        break
            if target_file:
                break

    if not target_file:
        return None, False

    # 2. 対象ファイルが Excalidraw-backed markdown または .excalidraw の場合
    if is_excalidraw_backed_markdown(target_file):
        # 2-1. まず .excalidraw-cache からキャッシュ画像を探す
        cache_img = find_excalidraw_cache_image(target_file, vault_dir, cache_dirs, index_data)
        if cache_img and cache_img.exists():
            data_url = file_to_base64_data_url(cache_img)
            if data_url:
                return data_url, True

        # 2-2. 同名PNGが同フォルダにあるか確認
        png_cand = target_file.with_suffix(".png")
        if png_cand.exists() and png_cand.is_file():
            data_url = file_to_base64_data_url(png_cand)
            if data_url:
                return data_url, True

        # 2-3. キャッシュ未生成の場合: ノート内の compressed-json / JSON から SVG を自動動的生成
        try:
            note_text = target_file.read_text(encoding="utf-8", errors="replace")
            excalidraw_dict = extract_excalidraw_data(note_text)
            if excalidraw_dict:
                gen_svg = excalidraw_to_svg(excalidraw_dict)
                data_url = svg_text_to_base64_data_url(gen_svg)
                return data_url, True
        except Exception:
            pass

        return None, True

    # 3. 通常画像またはSVG/Drawioファイルの場合
    ext = target_file.suffix.lower()
    if ext in IMAGE_EXTENSIONS or target_file.name.lower().endswith((".drawio.svg", ".dio.svg")):
        data_url = file_to_base64_data_url(target_file)
        return data_url, False

    return None, False


def replace_obsidian_image_embeds(
    content: str,
    vault_path: str,
    current_file_path: str = "",
) -> Tuple[str, int]:
    """
    Markdownテキスト内の画像・図面埋め込み記法
    - `![[image.png]]`
    - `![[image.png|300]]`
    - `![[りんご|75]]` (自身または別ノートのExcalidraw埋め込み)
    - `![[あは.excalidraw.md|275]]`
    - `![[いいい.drawio.svg|221]]`
    - `![alt](image.png)`
    を検出し、Base64 Data URL付きの <img> タグに置換する。
    """
    embedded_count = 0

    # 1. ![[filename|size]] 形式の置換
    def replace_wikilink_embed(match: re.Match) -> str:
        nonlocal embedded_count
        raw_link = match.group(1).strip()
        size_spec = match.group(2).strip() if match.group(2) else None

        data_url, is_excalidraw = resolve_image_or_figure_data_url(vault_path, raw_link, current_file_path)
        if not data_url:
            if is_excalidraw:
                # Excalidrawだがデータ抽出不可の場合はフォールバック表示
                alt_text = html.escape(raw_link)
                return f'\n\n<p class="embedded-excalidraw-fallback" style="padding: 10px 14px; background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 6px; font-size: 13px; color: #64748b;">🎨 <strong>Excalidraw 図面:</strong> {alt_text} <span style="font-size: 11px;">(プレビューキャッシュ未生成)</span></p>\n\n'
            return match.group(0)

        embedded_count += 1
        alt_text = html.escape(raw_link)
        width_attr = ""
        if size_spec:
            width_match = re.match(r"^(\d+)", size_spec)
            if width_match:
                width_attr = f' width="{width_match.group(1)}"'

        excalidraw_class = ' excalidraw-export-embed' if is_excalidraw else ''
        return f'\n\n<p class="embedded-image-container{excalidraw_class}"><img src="{data_url}" alt="{alt_text}"{width_attr} style="max-width: 100%; height: auto; border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.15); background-color: #ffffff; color-scheme: light;" /></p>\n\n'

    # ![[link|size]] or ![[link]]
    content = re.sub(r"!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]", replace_wikilink_embed, content)

    # 2. ![alt](path) 形式の置換
    def replace_md_embed(match: re.Match) -> str:
        nonlocal embedded_count
        alt_text = match.group(1) or ""
        raw_link = match.group(2).strip()

        if raw_link.startswith(("http://", "https://", "data:")):
            return match.group(0)

        data_url, is_excalidraw = resolve_image_or_figure_data_url(vault_path, raw_link, current_file_path)
        if not data_url:
            return match.group(0)

        embedded_count += 1
        alt_escaped = html.escape(alt_text or raw_link)
        return f'\n\n<p class="embedded-image-container"><img src="{data_url}" alt="{alt_escaped}" style="max-width: 100%; height: auto; border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.15); background-color: #ffffff; color-scheme: light;" /></p>\n\n'

    content = re.sub(r"!\[([^\]]*)\]\(([^)]+)\)", replace_md_embed, content)

    # 3. [[filename|alias_or_size]] 形式（! なしの Wikilink 記法）の画像・図面置換
    def replace_wikilink_image_link(match: re.Match) -> str:
        nonlocal embedded_count
        raw_link = match.group(1).strip()
        alias_or_size = match.group(2).strip() if match.group(2) else None

        # リンク先が画像・Excalidrawであるか判定
        name_lower = raw_link.lower()
        is_known_media = (
            name_lower.endswith((".excalidraw.md", ".excalidraw", ".drawio.svg", ".dio.svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"))
        )

        data_url, is_excalidraw = resolve_image_or_figure_data_url(vault_path, raw_link, current_file_path)
        if not data_url:
            # メディアファイルと推測されるがキャッシュ未生成の場合のフォールバック
            if is_excalidraw or name_lower.endswith((".excalidraw.md", ".excalidraw")):
                alt_text = html.escape(alias_or_size or raw_link)
                return f'\n\n<p class="embedded-excalidraw-fallback" style="padding: 10px 14px; background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 6px; font-size: 13px; color: #64748b;">🎨 <strong>Excalidraw 図面:</strong> {alt_text} <span style="font-size: 11px;">(プレビューキャッシュ未生成)</span></p>\n\n'
            return match.group(0)

        # 画像として解決できた場合のみ置換（通常の文書へのリンクはそのまま維持）
        if not (is_known_media or is_excalidraw):
            return match.group(0)

        embedded_count += 1
        alt_text = html.escape(alias_or_size or raw_link)
        width_attr = ""
        if alias_or_size:
            width_match = re.match(r"^(\d+)", alias_or_size)
            if width_match:
                width_attr = f' width="{width_match.group(1)}"'

        excalidraw_class = ' excalidraw-export-embed' if is_excalidraw else ''
        return f'\n\n<p class="embedded-image-container{excalidraw_class}"><img src="{data_url}" alt="{alt_text}"{width_attr} style="max-width: 100%; height: auto; border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.15); background-color: #ffffff; color-scheme: light;" /></p>\n\n'

    content = re.sub(r"(?<!\!)\[\[([^\]|]+)(?:\|([^\]]+))?\]\]", replace_wikilink_image_link, content)

    return content, embedded_count






def parse_js_array_or_json(js_code_str: str) -> Optional[List[Dict[str, Any]]]:
    """
    JavaScriptコード内の JSON配列 / オブジェクト配列（例: noteListRows = [...]）を安全にパースする
    """
    clean_str = js_code_str.strip()
    try:
        if clean_str.startswith("[") and clean_str.endswith("]"):
            return json.loads(clean_str)
    except Exception:
        pass

    try:
        # 末尾カンマの除去
        norm = re.sub(r",\s*([\]}])", r"\1", clean_str)
        # キーにクォートがない場合 {"key": ...} に補正
        norm = re.sub(r'([{,]\s*)([a-zA-Z0-9_$]+)\s*:', r'\1"\2":', norm)
        return json.loads(norm)
    except Exception:
        pass

    return None


def convert_dataview_blocks_to_html(markdown_text: str) -> str:
    """
    Markdownテキスト内の Dataview / DataviewJS テーブル定義ブロックを検出し、
    Obsidian の表示と同様の美しい HTML テーブル (<table>) に変換する。
    """
    # 1. ```dataviewjs ... ``` ブロックの置換
    def replace_dataviewjs_block(match: re.Match) -> str:
        block_code = match.group(1).strip()

        # 1-1. custom-note-list 形式 (const noteListRows = [...])
        note_rows_match = re.search(r'(?:const|let|var)\s+(?:noteListRows|rows|data|notes)\s*=\s*(\[[\s\S]*?\]);', block_code)
        if note_rows_match:
            raw_array_str = note_rows_match.group(1)
            rows = parse_js_array_or_json(raw_array_str)
            if rows and isinstance(rows, list):
                html_table = [
                    '\n\n<div class="dataview-table-container" style="overflow-x: auto; margin: 16px 0 24px 0; border: 1px solid #e2e8f0; border-radius: 8px; background: #ffffff; box-shadow: 0 1px 4px rgba(0,0,0,0.04);">',
                    '  <table class="dataview table-view-table" style="width: 100%; border-collapse: collapse; font-size: 13.5px; text-align: left;">',
                    '    <thead>',
                    '      <tr style="background: #f8fafc; border-bottom: 2px solid #e2e8f0;">',
                    '        <th style="padding: 10px 14px; font-weight: 600; color: #475569; min-width: 140px; text-align: left;">名称</th>',
                    '        <th style="padding: 10px 14px; font-weight: 600; color: #475569; min-width: 100px; text-align: left;">タグ</th>',
                    '        <th style="padding: 10px 14px; font-weight: 600; color: #475569; text-align: left;">冒頭 / 抜粋</th>',
                    '        <th style="padding: 10px 14px; font-weight: 600; color: #475569; min-width: 90px; text-align: center;">作成日</th>',
                    '        <th style="padding: 10px 14px; font-weight: 600; color: #475569; min-width: 90px; text-align: center;">編集日</th>',
                    '      </tr>',
                    '    </thead>',
                    '    <tbody>',
                ]

                for row in rows:
                    name = html.escape(str(row.get("name") or row.get("title") or row.get("file") or ""))
                    raw_tags = row.get("tags") or []
                    if isinstance(raw_tags, str):
                        tag_list = [t.strip() for t in raw_tags.split() if t.strip()]
                    elif isinstance(raw_tags, list):
                        tag_list = [str(t).strip() for t in raw_tags if str(t).strip()]
                    else:
                        tag_list = []

                    tags_html = "".join([
                        f'<span class="dataview-tag" style="display: inline-block; padding: 1px 7px; margin: 2px 4px 2px 0; background: rgba(99, 102, 241, 0.12); color: #4f46e5; border-radius: 4px; font-size: 11px; font-weight: 500;">#{html.escape(t.lstrip("#"))}</span>'
                        for t in tag_list
                    ])

                    excerpt = html.escape(str(row.get("excerpt") or row.get("preview") or ""))
                    ctime = html.escape(str(row.get("ctime") or row.get("created") or ""))
                    mtime = html.escape(str(row.get("mtime") or row.get("modified") or ""))

                    html_table.append('      <tr style="border-bottom: 1px solid #e2e8f0;">')
                    html_table.append(f'        <td class="dataview-name-cell" style="padding: 10px 14px; font-weight: 600; color: #1e293b;">{name}</td>')
                    html_table.append(f'        <td class="dataview-tag-cell" style="padding: 10px 14px;">{tags_html}</td>')
                    html_table.append(f'        <td class="dataview-excerpt-cell" style="padding: 10px 14px; font-size: 12.5px; color: #475569; line-height: 1.45;">{excerpt}</td>')
                    html_table.append(f'        <td class="dataview-date-cell" style="padding: 10px 14px; font-family: monospace; font-size: 11.5px; color: #64748b; text-align: center; white-space: nowrap;">{ctime}</td>')
                    html_table.append(f'        <td class="dataview-date-cell" style="padding: 10px 14px; font-family: monospace; font-size: 11.5px; color: #64748b; text-align: center; white-space: nowrap;">{mtime}</td>')
                    html_table.append('      </tr>')

                html_table.append('    </tbody>')
                html_table.append('  </table>')
                html_table.append('</div>\n\n')

                return "\n".join(html_table)

        # 1-2. dv.table(["ヘッダー1", ...], [ [...], ... ]) 形式
        dv_table_match = re.search(r'dv\.table\s*\(\s*(\[[\s\S]*?\])\s*,\s*(\[[\s\S]*?\])\s*\)', block_code)
        if dv_table_match:
            try:
                headers = json.loads(re.sub(r",\s*([\]}])", r"\1", dv_table_match.group(1)))
                rows = json.loads(re.sub(r",\s*([\]}])", r"\1", dv_table_match.group(2)))
                if isinstance(headers, list) and isinstance(rows, list):
                    html_table = [
                        '\n\n<div class="dataview-table-container" style="overflow-x: auto; margin: 16px 0 24px 0; border: 1px solid #e2e8f0; border-radius: 8px; background: #ffffff;">',
                        '  <table class="dataview table-view-table" style="width: 100%; border-collapse: collapse; font-size: 13.5px;">',
                        '    <thead><tr style="background: #f8fafc; border-bottom: 2px solid #e2e8f0;">',
                    ]
                    for h in headers:
                        html_table.append(f'      <th style="padding: 10px 14px; font-weight: 600; color: #475569;">{html.escape(str(h))}</th>')
                    html_table.append('    </tr></thead><tbody>')
                    for row in rows:
                        html_table.append('      <tr style="border-bottom: 1px solid #e2e8f0;">')
                        for cell in (row if isinstance(row, list) else [row]):
                            html_table.append(f'        <td style="padding: 10px 14px;">{html.escape(str(cell))}</td>')
                        html_table.append('      </tr>')
                    html_table.append('    </tbody></table></div>\n\n')
                    return "\n".join(html_table)
            except Exception:
                pass

        return match.group(0)

    text = re.sub(r"```dataviewjs\s*\n([\s\S]*?)\n```", replace_dataviewjs_block, markdown_text)

    # 2. ```dataview\nTABLE ... ``` 標準DQLテーブルブロックの処理
    def replace_dataview_dql_block(match: re.Match) -> str:
        dql_code = match.group(1).strip()
        lines = [line.strip() for line in dql_code.splitlines() if line.strip()]
        if lines and lines[0].upper().startswith("TABLE"):
            from_clause = ""
            for line in lines[1:]:
                if line.upper().startswith("FROM"):
                    from_clause = line.strip()
                    break

            return f'\n\n<div class="dataview-dql-placeholder" style="padding: 12px 16px; background: #f8fafc; border: 1px solid #e2e8f0; border-left: 4px solid #6366f1; border-radius: 6px; margin: 12px 0;">' \
                   f'<div style="font-weight: 600; font-size: 13px; color: #4f46e5; margin-bottom: 4px;">📊 Dataview Table Query: {html.escape(lines[0])}</div>' \
                   f'<div style="font-size: 12px; color: #64748b;">{html.escape(from_clause or "Vault全体から抽出")}</div>' \
                   f'</div>\n\n'

        return match.group(0)

    text = re.sub(r"```dataview\s*\n([\s\S]*?)\n```", replace_dataview_dql_block, text)

    return text


def render_markdown_to_clean_html(markdown_text: str) -> str:
    """MarkdownテキストをパースしてHTMLに変換する"""
    text = strip_frontmatter(markdown_text)
    text = strip_excalidraw_data(text)
    text = convert_dataview_blocks_to_html(text)
    text = expand_wikilinks(text)
    rendered = md_parser.render(text)
    return rendered


def get_ai_export_css() -> str:
    """AI読み取りおよび人間表示に適したクリーンなCSSスタイルを返す"""
    return """
/* === AI Context Export Reset & Clean Theme === */
:root {
    --text-primary: #1e293b;

    --text-secondary: #475569;
    --text-muted: #64748b;
    --bg-main: #ffffff;
    --bg-card: #f8fafc;
    --border-color: #e2e8f0;
    --accent-blue: #2563eb;
    --accent-indigo: #4f46e5;
    --accent-green: #059669;
    --code-bg: #f1f5f9;
}

html, body {
    margin: 0;
    padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    color: var(--text-primary);
    background-color: var(--bg-main);
    line-height: 1.6;
    font-size: 15px;
}

.ai-document-container {
    max-width: 960px;
    margin: 0 auto;
    padding: 32px 24px;
}

/* ヘッダー */
.ai-header {
    border-bottom: 2px solid var(--accent-indigo);
    padding-bottom: 16px;
    margin-bottom: 24px;
}

.ai-header h1 {
    font-size: 24px;
    margin: 0 0 8px 0;
    color: var(--accent-indigo);
}

.ai-meta-info {
    font-size: 13px;
    color: var(--text-muted);
}

/* AI プロンプトセクション */
.ai-prompt-section {
    background: #eff6ff;
    border: 1px solid #bfdbfe;
    border-left: 5px solid var(--accent-blue);
    border-radius: 6px;
    padding: 16px 20px;
    margin-bottom: 28px;
}

.ai-prompt-section h2 {
    font-size: 16px;
    margin: 0 0 10px 0;
    color: #1e40af;
}

.ai-prompt-content {
    font-size: 14.5px;
    color: #1e3a8a;
    white-space: pre-wrap;
    font-weight: 500;
}

/* 目次 */
.document-toc {
    background: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 16px 20px;
    margin-bottom: 32px;
}

.document-toc h2 {
    font-size: 15px;
    margin: 0 0 10px 0;
    color: var(--text-secondary);
}

.document-toc ul {
    margin: 0;
    padding-left: 20px;
}

.document-toc li {
    margin-bottom: 4px;
    font-size: 13.5px;
}

.document-toc a {
    color: var(--accent-blue);
    text-decoration: none;
}

.document-toc a:hover {
    text-decoration: underline;
}

/* ドキュメント記事 */
.document-article {
    background: #ffffff;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 24px 28px;
    margin-bottom: 36px;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.04);
}

.document-article-header {
    border-bottom: 1px solid var(--border-color);
    padding-bottom: 12px;
    margin-bottom: 18px;
}

.document-article-header h2 {
    font-size: 20px;
    margin: 0 0 6px 0;
    color: var(--text-primary);
}

.document-path-badge {
    display: inline-block;
    font-size: 12px;
    font-family: monospace;
    background: #f1f5f9;
    padding: 2px 8px;
    border-radius: 4px;
    color: var(--text-muted);
}

/* 本文タイポグラフィ */
.document-body h1, .document-body h2, .document-body h3, .document-body h4 {
    color: var(--text-primary);
    margin-top: 1.4em;
    margin-bottom: 0.6em;
}

.document-body p {
    margin: 0.8em 0;
}

.document-body table {
    border-collapse: collapse;
    width: 100%;
    margin: 1.2em 0;
}

.document-body th, .document-body td {
    border: 1px solid var(--border-color);
    padding: 8px 12px;
    text-align: left;
}

.document-body th {
    background-color: var(--bg-card);
    font-weight: 600;
}

.document-body pre {
    background: var(--code-bg);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 12px 16px;
    overflow-x: auto;
    font-size: 13px;
    line-height: 1.5;
}

.document-body code {
    background: var(--code-bg);
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 0.9em;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.document-body pre code {
    background: transparent;
    padding: 0;
}

.document-body blockquote {
    border-left: 4px solid var(--accent-indigo);
    margin: 1em 0;
    padding-left: 14px;
    color: var(--text-secondary);
}

.document-body img {
    max-width: 100%;
    height: auto;
    display: block;
    margin: 16px auto;
}

/* マークダウン元データセクション */
.doc-raw-markdown {
    margin-top: 24px;
    border-top: 1px dashed var(--border-color);
    padding-top: 14px;
}

.doc-raw-markdown summary {
    font-size: 12.5px;
    color: var(--text-muted);
    cursor: pointer;
    font-weight: 500;
}

.doc-raw-markdown pre {
    background: #fafafa;
    border: 1px solid #e5e5e5;
    border-radius: 4px;
    padding: 10px 14px;
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-all;
}

/* APPENDIX 呼び出されたメールセクション */
.ai-linked-emails-section {
    margin-top: 48px;
    border-top: 2px solid var(--accent-blue);
    padding-top: 24px;
}

.ai-linked-emails-section > h2 {
    font-size: 20px;
    color: var(--accent-blue);
    margin-bottom: 20px;
    display: flex;
    align-items: center;
    gap: 8px;
}

.linked-email-article {
    border-left: 4px solid var(--accent-blue) !important;
}

.linked-email-meta {
    background: #f8fafc;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 10px 14px;
    margin-bottom: 16px;
    font-size: 12.5px;
    line-height: 1.6;
}

.linked-email-meta dt {
    font-weight: 600;
    color: var(--text-secondary);
    display: inline;
}

.linked-email-meta dd {
    display: inline;
    margin-left: 4px;
    margin-right: 16px;
    color: var(--text-primary);
}

.email-plain-body pre {
    font-family: inherit;
    font-size: 14px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-all;
    margin: 0;
}
"""


def resolve_document_file(vault_path: Path, path_str: str) -> Tuple[Optional[Path], str]:
    """
    指定されたパス文字列（絶対パス、Vault相対パス、親ディレクトリ基準相対パス、ファイル名）
    から、実在するファイルを確実に特定し、(絶対Path, 表示用相対パス) を返す。
    """
    raw_p = Path(path_str)

    # 1. すでに絶対パスとして実在する場合
    if raw_p.is_absolute() and raw_p.exists() and raw_p.is_file():
        try:
            rel = str(raw_p.relative_to(vault_path))
        except ValueError:
            rel = raw_p.name
        return raw_p, rel

    # 2. vault_path / path_str で実在する場合
    cand = (vault_path / path_str).resolve()
    if cand.exists() and cand.is_file():
        return cand, path_str

    # 3. vault_path の親ディレクトリ基準 (vault_path.parent / path_str) で実在する場合
    # 例: vault_path が .../01_data で path_str が 01_data/... の場合
    cand_parent = (vault_path.parent / path_str).resolve()
    if cand_parent.exists() and cand_parent.is_file():
        try:
            rel = str(cand_parent.relative_to(vault_path))
        except ValueError:
            rel = str(cand_parent.relative_to(vault_path.parent))
        return cand_parent, rel

    # 4. path_str が vault_path の末尾ディレクトリ名で始まっている場合のプレフィックス除去
    vault_folder_name = vault_path.name
    if path_str.startswith(f"{vault_folder_name}/") or path_str.startswith(f"{vault_folder_name}\\"):
        stripped = path_str[len(vault_folder_name) + 1:]
        cand_strip = (vault_path / stripped).resolve()
        if cand_strip.exists() and cand_strip.is_file():
            return cand_strip, stripped

    # 5. 再帰探索（同名ファイル）
    file_basename = raw_p.name
    for root, _, files in os.walk(vault_path):
        if Path(root).name.startswith("."):
            continue
        if file_basename in files:
            found = Path(root) / file_basename
            if found.is_file():
                try:
                    rel = str(found.relative_to(vault_path))
                except ValueError:
                    rel = file_basename
                return found, rel

    # 6. 親ディレクトリの再帰探索
    for root, _, files in os.walk(vault_path.parent):
        if Path(root).name.startswith("."):
            continue
        if file_basename in files:
            found = Path(root) / file_basename
            if found.is_file():
                try:
                    rel = str(found.relative_to(vault_path))
                except ValueError:
                    rel = str(found.relative_to(vault_path.parent))
                return found, rel

    return None, path_str


def _resolve_email_file_path(
    path_str: str,
    base_dir: Optional[Path],
    vault_path: Optional[Path],
) -> Optional[Path]:
    """
    指定されたメールパス文字列から実在するPathを解決する。
    """
    p = Path(path_str)
    if p.is_absolute() and p.exists() and p.is_file():
        return p.resolve()

    if base_dir:
        cand1 = (base_dir / p).resolve()
        if cand1.exists() and cand1.is_file():
            return cand1
        cand2 = (base_dir / p.name).resolve()
        if cand2.exists() and cand2.is_file():
            return cand2

    if vault_path:
        cand3 = (vault_path / p).resolve()
        if cand3.exists() and cand3.is_file():
            return cand3
        cand4 = (vault_path / p.name).resolve()
        if cand4.exists() and cand4.is_file():
            return cand4
        try:
            for found in vault_path.rglob(p.name):
                if found.is_file() and not found.name.startswith("."):
                    return found.resolve()
        except Exception:
            pass

    return None


def extract_linked_email_paths(
    content: str,
    base_dir: Optional[Path] = None,
    vault_path: Optional[Path] = None,
) -> List[Path]:
    """
    Markdownテキスト内のリンク（WikilinkおよびMarkdownリンク）から
    メールファイル（.msg, .eml, winmail.dat）を検出し、実在するPathのリストを返す。
    """
    found_paths: List[Path] = []
    seen: Set[str] = set()

    def check_and_add(raw_target: str) -> None:
        unquoted = urllib.parse.unquote(raw_target.strip())
        cleaned = unquoted.split("?")[0].split("#")[0].strip()
        if not cleaned:
            return
        suffix = Path(cleaned).suffix.lower()
        name = Path(cleaned).name.lower()
        if suffix not in EMAIL_EXTENSIONS and name != "winmail.dat":
            return
        resolved = _resolve_email_file_path(cleaned, base_dir, vault_path)
        if resolved and resolved.exists() and resolved.is_file():
            abs_str = str(resolved.resolve())
            if abs_str not in seen:
                seen.add(abs_str)
                found_paths.append(resolved.resolve())

    # 1. Wikilinks: !?[[path/to/file.ext|alias]] or !?[[path/to/file.ext]]
    for m in re.finditer(r"!?\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]", content):
        check_and_add(m.group(1))

    # 2. Markdown links: !?[text](path/to/file.ext)
    for m in re.finditer(r"!?\[([^\]]*)\]\(([^)#]+)\)", content):
        check_and_add(m.group(2))

    return found_paths


def parse_eml_file(path: Path) -> Optional[Dict[str, Any]]:
    """
    Python標準emailモジュールを使用して .eml ファイルを解析する。
    """
    try:
        raw_bytes = path.read_bytes()
        msg = email.message_from_bytes(raw_bytes, policy=email.policy.default)
    except Exception:
        return None

    subject = str(msg.get("subject", "") or "").strip()
    sender = str(msg.get("from", "") or "").strip()
    to = str(msg.get("to", "") or "").strip()
    date = str(msg.get("date", "") or "").strip()

    body_plain = ""
    body_html = ""
    attachments = []

    for part in msg.walk():
        content_type = part.get_content_type().lower()
        if content_type == "text/html" and not body_html:
            try:
                payload = part.get_payload(decode=True)
                charset = part.get_content_charset() or "utf-8"
                body_html = payload.decode(charset, errors="replace")
            except Exception:
                pass
        elif content_type == "text/plain" and not body_plain:
            try:
                payload = part.get_payload(decode=True)
                charset = part.get_content_charset() or "utf-8"
                body_plain = payload.decode(charset, errors="replace")
            except Exception:
                pass
        elif content_type.startswith("image/"):
            try:
                payload = part.get_payload(decode=True)
                if payload:
                    cid = str(part.get("Content-ID", "") or "").strip("<>")
                    filename = part.get_filename() or f"image_{len(attachments)+1}"
                    attachments.append({
                        "data": payload,
                        "mime": content_type,
                        "cid": cid,
                        "filename": filename,
                        "is_image": True,
                    })
            except Exception:
                pass

    return {
        "file_name": path.name,
        "file_path": str(path),
        "subject": subject,
        "sender": sender,
        "to": to,
        "date": date,
        "body_plain": body_plain,
        "body_html": body_html,
        "attachments": attachments,
    }


def mojibake_score(text: str) -> float:
    """
    文字列の文字化け度合いをスコア付けする（値が低いほど自然で良質）。
    Obsidian (RegisterCustomCommands.md) の mojibakeScore アルゴリズムに準拠。
    - 不正文字 (\\ufffd) は重いペナルティ
    - UTF-8やShift_JISのバイト列を誤ったエンコーディング（cp1252/latin1等）でデコードした際に出現する
      典型的な文字化け文字（Ã, Â, ã, ¢, 縺, 繧, 譁, 謚, ｭ, ｱ 等）をペナルティ化
    - ひらがな・カタカナ・漢字は日本語文字列としての確からしさを示すためボーナス減点（高評価）
    """
    if not text:
        return float("inf")
    bad_chars = text.count("\ufffd") * 20
    mojibake_matches = len(re.findall(r"[ÃÂã¢縺繧譁謚ｭｱ]", text)) * 5
    japanese_chars = len(re.findall(r"[\u3040-\u30ff\u3400-\u9fff]", text))
    return float(bad_chars + mojibake_matches - japanese_chars)


def decode_best_effort_text(
    data: bytes,
    preferred_encodings: Optional[List[str]] = None,
) -> str:
    """
    バイト列を最も自然（文字化けが最小）な文字列へベストエフォートでデコードする。
    Obsidianの decodeBestEffortText に準拠し、CP932 / Windows-31J を最優先候補として扱う。
    """
    if not data:
        return ""

    encodings_to_try: List[str] = []
    if preferred_encodings:
        for enc in preferred_encodings:
            if enc and enc not in encodings_to_try:
                encodings_to_try.append(enc)

    standard_candidates = [
        "cp932",
        "shift_jis",
        "utf-8",
        "windows-31j",
        "euc_jp",
        "iso2022_jp",
        "cp1252",
        "latin1",
    ]
    for cand in standard_candidates:
        if cand not in encodings_to_try:
            encodings_to_try.append(cand)

    candidates: List[Tuple[str, float]] = []
    for enc in encodings_to_try:
        try:
            decoded = data.decode(enc)
            score = mojibake_score(decoded)
            candidates.append((decoded, score))
        except UnicodeDecodeError:
            try:
                decoded = data.decode(enc, errors="replace")
                score = mojibake_score(decoded)
                candidates.append((decoded, score))
            except Exception:
                continue
        except Exception:
            continue

    if not candidates:
        try:
            decoded = data.decode("utf-8", errors="replace")
        except Exception:
            decoded = str(data)
    else:
        candidates.sort(key=lambda x: x[1])
        decoded = candidates[0][0]

    # null文字（\x00）があれば切り詰める（OutlookのC文字列仕様）
    null_idx = decoded.find("\x00")
    if null_idx != -1:
        decoded = decoded[:null_idx]

    return decoded.strip()


def _safe_get_msg_stream_text(msg: Any, prop_id: str, preferred_encodings: Optional[List[str]] = None) -> str:
    """
    extract_msgのメッセージオブジェクトからプロパティIDに対応する生ストリームを直接取得・デコードする。
    Unicode (001F) が存在すれば utf-16le でデコードし、
    ANSI (001E) の場合は CP932 を最優先としたベストエフォートデコードを行う。
    """
    get_stream = getattr(msg, "getStream", None)
    if not callable(get_stream):
        return ""

    # 1. Unicode stream (001F)
    try:
        u_data = get_stream(f"__substg1.0_{prop_id}001F", prefix=False)
        if not u_data:
            u_data = get_stream(f"__substg1.0_{prop_id}001F")
        if u_data:
            text = u_data.decode("utf-16le", errors="replace")
            null_idx = text.find("\x00")
            if null_idx != -1:
                text = text[:null_idx]
            return text.strip()
    except Exception:
        pass

    # 2. ANSI stream (001E)
    try:
        a_data = get_stream(f"__substg1.0_{prop_id}001E", prefix=False)
        if not a_data:
            a_data = get_stream(f"__substg1.0_{prop_id}001E")
        if a_data:
            return decode_best_effort_text(a_data, preferred_encodings or ["cp932", "shift_jis"])
    except Exception:
        pass

    return ""


def _safe_read_msg_prop(msg: Any, prop_name: str, prop_id: str, preferred_encodings: Optional[List[str]] = None) -> str:
    """
    extract_msgの属性（subject, sender, to, bodyなど）を安全に読み取る。
    UnicodeDecodeError（cp1252など）が発生した場合は生ストリームからCP932等で復旧する。
    また、取得値が明らかな文字化けを起こしている場合もストリームからの復旧を試みる。
    """
    try:
        val = getattr(msg, prop_name, None)
        if val is not None:
            text = str(val).strip()
            score = mojibake_score(text)
            if score > 40:  # 明らかな文字化けの疑いがある場合
                stream_text = _safe_get_msg_stream_text(msg, prop_id, preferred_encodings)
                if stream_text and mojibake_score(stream_text) < score:
                    return stream_text
            return text
    except (UnicodeDecodeError, Exception):
        pass

    return _safe_get_msg_stream_text(msg, prop_id, preferred_encodings)


def parse_msg_file(path: Path) -> Optional[Dict[str, Any]]:
    """
    extract_msg モジュールを使用して .msg ファイルを解析する。
    仕様:
    - プロパティコードページがcp1252と指定されているか未指定のMSGファイルにおいて、
      日本語CP932文字列が含まれるケースでUnicodeDecodeErrorが発生した場合は
      overrideEncoding='cp932'での再試行および生ストリームからのベストエフォートデコードを行う。
    - HTML本文（htmlBody）内のcharsetメタタグを検出し、最適なエンコーディングでデコード。
    - プレーンテキスト本文が空でもHTML本文がある場合はタグを除去してプレーンテキストを自動補完。
    - 添付画像（インライン画像および添付ファイル）を抽出してBase64埋め込み用に提供。
    """
    try:
        import extract_msg
    except ImportError:
        return None

    msg = None
    # 1. オープン試行（通常オープン -> UnicodeDecodeError時は overrideEncoding="cp932" で再試行）
    for override_enc in (None, "cp932"):
        try:
            kwargs: Dict[str, Any] = {}
            if override_enc:
                kwargs["overrideEncoding"] = override_enc
            if hasattr(extract_msg, "openMsg"):
                msg = extract_msg.openMsg(str(path), **kwargs)
            elif hasattr(extract_msg, "Message"):
                msg = extract_msg.Message(str(path), **kwargs)
            if msg is not None:
                break
        except UnicodeDecodeError:
            continue
        except Exception:
            continue

    if msg is None:
        return None

    try:
        subject = _safe_read_msg_prop(msg, "subject", "0037")
        sender = _safe_read_msg_prop(msg, "sender", "0C1A")
        to = _safe_read_msg_prop(msg, "to", "0E04")
        if not to:
            to = _safe_read_msg_prop(msg, "to", "0E03")
        date = ""
        try:
            date = str(getattr(msg, "date", "") or "").strip()
        except Exception:
            pass
        body_plain = _safe_read_msg_prop(msg, "body", "1000")

        # HTML本文の取得
        raw_html = None
        try:
            raw_html = getattr(msg, "htmlBody", None)
        except Exception:
            pass

        if not raw_html:
            get_stream = getattr(msg, "getStream", None)
            if callable(get_stream):
                try:
                    raw_html = get_stream("__substg1.0_10130102", prefix=False) or get_stream("__substg1.0_10130102")
                except Exception:
                    pass

        body_html = ""
        if isinstance(raw_html, bytes):
            preview = raw_html[:2048].decode("latin1", errors="ignore")
            charset_match = re.search(r'charset=["\']?([a-zA-Z0-9_-]+)', preview, re.IGNORECASE)
            preferred = [charset_match.group(1).lower()] if charset_match else ["cp932", "shift_jis"]
            body_html = decode_best_effort_text(raw_html, preferred)
        elif isinstance(raw_html, str):
            body_html = raw_html

        # フォールバック: HTML本文があり、プレーンテキストが空の場合はHTMLからプレーンテキストを生成
        if not body_plain and body_html:
            cleaned_html = sanitize_outlook_html(body_html)
            text = re.sub(r"<br\s*\/?>", "\n", cleaned_html, flags=re.IGNORECASE)
            text = re.sub(r"<\/(p|div|section|article|header|footer|h[1-6]|tr)>\s*", "\n\n", text, flags=re.IGNORECASE)
            text = re.sub(r"<\/(li)>\s*", "\n", text, flags=re.IGNORECASE)
            text = re.sub(r"<li\b[^>]*>", "- ", text, flags=re.IGNORECASE)
            text = re.sub(r"<[^>]+>", "", text)
            text = html.unescape(text)
            body_plain = re.sub(r"\n{3,}", "\n\n", text).strip()

        # 添付画像の抽出
        attachments = []
        raw_attachments = []
        try:
            raw_attachments = getattr(msg, "attachments", []) or []
        except Exception:
            raw_attachments = []

        for att in raw_attachments:
            try:
                data = getattr(att, "data", None)
                if not data:
                    continue
                filename = (
                    getattr(att, "longFilename", None)
                    or getattr(att, "shortFilename", None)
                    or getattr(att, "filename", "")
                    or ""
                )
                cid = getattr(att, "cid", None) or getattr(att, "content_id", None) or ""
                if cid:
                    cid = str(cid).strip("<>")
                mimetype = getattr(att, "mimetype", "") or ""
                if not mimetype and filename:
                    mimetype = mimetypes.guess_type(filename)[0] or ""

                is_img = False
                if mimetype.startswith("image/"):
                    is_img = True
                elif len(data) >= 4:
                    if data[:4] == b"\x89PNG" or data[:2] == b"\xff\xd8" or data[:3] == b"GIF" or data[:2] == b"BM":
                        is_img = True
                        if not mimetype:
                            if data[:4] == b"\x89PNG":
                                mimetype = "image/png"
                            elif data[:2] == b"\xff\xd8":
                                mimetype = "image/jpeg"
                            elif data[:3] == b"GIF":
                                mimetype = "image/gif"
                            elif data[:2] == b"BM":
                                mimetype = "image/bmp"

                if is_img:
                    attachments.append({
                        "data": data,
                        "mime": mimetype or "image/png",
                        "cid": cid,
                        "filename": filename or f"image_{len(attachments)+1}.png",
                        "is_image": True,
                    })
            except Exception:
                continue

        return {
            "file_name": path.name,
            "file_path": str(path),
            "subject": subject,
            "sender": sender,
            "to": to,
            "date": date,
            "body_plain": body_plain,
            "body_html": body_html,
            "attachments": attachments,
        }
    finally:
        close_fn = getattr(msg, "close", None)
        if callable(close_fn):
            try:
                close_fn()
            except Exception:
                pass


def parse_email_file(path: Path) -> Optional[Dict[str, Any]]:
    """
    拡張子に応じて .eml または .msg ファイルを解析する。
    """
    suffix = path.suffix.lower()
    if suffix == ".eml":
        return parse_eml_file(path)
    elif suffix in (".msg", ".dat"):
        res = parse_msg_file(path)
        if res is not None:
            return res
        return parse_eml_file(path)
    return None


def render_email_to_html(parsed: Dict[str, Any], include_images: bool = True) -> Tuple[str, int]:
    """
    解析済みメール情報から安全で美麗なHTML本文を生成する。
    - include_images=True の場合、CID参照画像および添付画像をBase64 Data URLにインライン置換。
    - 未配置画像は「メール内の画像」として末尾に展開。
    - include_images=False の場合、または画像なし&表なしの場合はプレーンテキスト本文を優先。
    """
    body_html = parsed.get("body_html", "") or ""
    body_plain = parsed.get("body_plain", "") or ""
    attachments = parsed.get("attachments", []) or []
    image_attachments = [a for a in attachments if a.get("is_image") and a.get("data")]

    embedded_count = 0
    has_table = "<table" in body_html.lower()

    # 画像埋め込みなし、または（画像なし & 表なし & プレーン本文あり）の場合: プレーンテキスト本文を優先
    if not include_images or (len(image_attachments) == 0 and not has_table and body_plain.strip()):
        if body_plain.strip():
            escaped = html.escape(body_plain)
            return f'<div class="email-plain-body"><pre>{escaped}</pre></div>', 0
        elif body_html:
            sanitized = sanitize_outlook_html(body_html)
            # 画像タグは除去
            sanitized = re.sub(r"<img\b[^>]*>", "", sanitized, flags=re.IGNORECASE)
            return sanitized, 0
        return '<p class="text-muted">（本文なし）</p>', 0

    # include_images=True で HTML本文がある場合
    if body_html:
        sanitized = sanitize_outlook_html(body_html)
        by_cid: Dict[str, Dict[str, Any]] = {}
        for img in image_attachments:
            cid = (img.get("cid") or "").strip().lower()
            if cid:
                by_cid[cid] = img
            fname = (img.get("filename") or "").strip().lower()
            if fname:
                by_cid[fname] = img

        used_cids: Set[str] = set()

        def replace_img_tag(match: re.Match) -> str:
            nonlocal embedded_count
            tag = match.group(0)
            src_m = re.search(r'\bsrc\s*=\s*["\']?([^"\'\s>]+)', tag, flags=re.IGNORECASE)
            if not src_m:
                return ""
            src = src_m.group(1).strip()
            lookup_key = src.lower()
            if lookup_key.startswith("cid:"):
                lookup_key = lookup_key[4:].strip("<>")

            target_img = by_cid.get(lookup_key)
            if not target_img and image_attachments:
                # cidが一致しない場合、未利用の最初の画像とマッチング
                for cand in image_attachments:
                    cand_cid = (cand.get("cid") or cand.get("filename") or "").lower()
                    if cand_cid not in used_cids:
                        target_img = cand
                        break

            if target_img:
                cid_key = (target_img.get("cid") or target_img.get("filename") or "").lower()
                used_cids.add(cid_key)
                embedded_count += 1
                b64_data = base64.b64encode(target_img["data"]).decode("ascii")
                data_url = f"data:{target_img['mime']};base64,{b64_data}"
                alt = html.escape(target_img.get("filename") or "メール内画像")
                return f'<img src="{data_url}" alt="{alt}" style="max-width: 100%; height: auto; border-radius: 4px; box-shadow: 0 1px 4px rgba(0,0,0,0.1); margin: 8px 0;" />'
            return ""

        rendered_html = re.sub(r"<img\b[^>]*>", replace_img_tag, sanitized, flags=re.IGNORECASE)

        # 未配置の画像があれば末尾に追加
        unplaced = [img for img in image_attachments if (img.get("cid") or img.get("filename") or "").lower() not in used_cids]
        if unplaced:
            unplaced_tags = []
            for img in unplaced:
                embedded_count += 1
                b64_data = base64.b64encode(img["data"]).decode("ascii")
                data_url = f"data:{img['mime']};base64,{b64_data}"
                alt = html.escape(img.get("filename") or "添付画像")
                unplaced_tags.append(
                    f'<div style="margin: 10px 0;"><img src="{data_url}" alt="{alt}" style="max-width: 100%; height: auto; border-radius: 4px; box-shadow: 0 1px 4px rgba(0,0,0,0.1);" /><div style="font-size: 11px; color: #64748b; margin-top: 4px;">{alt}</div></div>'
                )
            rendered_html += f'<div class="unplaced-email-images" style="margin-top: 16px; padding-top: 12px; border-top: 1px dashed #e2e8f0;"><h4 style="font-size: 13px; color: #475569; margin: 0 0 8px 0;">📎 メール内の画像</h4>{"".join(unplaced_tags)}</div>'

        return rendered_html, embedded_count

    # HTML本文がなく、プレーンテキスト本文と画像がある場合
    escaped_plain = html.escape(body_plain)
    rendered_parts = [f'<div class="email-plain-body"><pre>{escaped_plain}</pre></div>']
    if image_attachments:
        unplaced_tags = []
        for img in image_attachments:
            embedded_count += 1
            b64_data = base64.b64encode(img["data"]).decode("ascii")
            data_url = f"data:{img['mime']};base64,{b64_data}"
            alt = html.escape(img.get("filename") or "添付画像")
            unplaced_tags.append(
                f'<div style="margin: 10px 0;"><img src="{data_url}" alt="{alt}" style="max-width: 100%; height: auto; border-radius: 4px; box-shadow: 0 1px 4px rgba(0,0,0,0.1);" /><div style="font-size: 11px; color: #64748b; margin-top: 4px;">{alt}</div></div>'
            )
        rendered_parts.append(f'<div class="unplaced-email-images" style="margin-top: 16px; padding-top: 12px; border-top: 1px dashed #e2e8f0;"><h4 style="font-size: 13px; color: #475569; margin: 0 0 8px 0;">📎 メール内の画像</h4>{"".join(unplaced_tags)}</div>')

    return "".join(rendered_parts), embedded_count


def export_documents_to_html(
    vault_path: str = "",
    relative_paths: Optional[List[str]] = None,
    file_paths: Optional[List[str]] = None,
    prompt: str = "",
    title: str = "AIコンテキスト統合ドキュメント",
    include_raw_markdown: bool = True,
    include_images: bool = True,
    include_linked_emails: bool = True,
) -> Tuple[str, Dict[str, Any]]:
    """
    指定されたVault内の複数Markdownファイルを解析し、画像・図面・プロンプトを含む単一の自己完結HTMLドキュメントを生成する。
    file_paths が指定された場合は絶対パスの直接指定に対応する。
    include_linked_emails=True の場合、Markdownからリンクされているメールファイルを自動抽出しAPPENDIXとして追加する。
    """
    doc_sections = []
    toc_items = []
    total_images_embedded = 0
    valid_docs_count = 0
    all_linked_emails: List[Path] = []
    seen_emails: Set[str] = set()

    escaped_title = html.escape(title or "AIコンテキスト統合ドキュメント")
    escaped_prompt = html.escape(prompt.strip()) if prompt else ""

    targets = []
    if file_paths:
        for fp in file_paths:
            p = Path(fp).resolve()
            targets.append((p.parent, str(p)))
    elif relative_paths:
        v_dir = Path(vault_path).resolve() if vault_path else Path.cwd()
        for rp in relative_paths:
            targets.append((v_dir, rp))

    for idx, (v_dir, path_input) in enumerate(targets, start=1):
        target_file, resolved_rel_path = resolve_document_file(v_dir, path_input)
        if not target_file or not target_file.exists() or not target_file.is_file():
            continue

        # .excalidraw.md や Excalidraw 図面データを含むファイルは画像ファイル（図面アセット）として扱い、
        # 文書記事（<article>）としての本文出力はスキップする (obsidian-dagnetz 仕様準拠)
        if is_excalidraw_backed_markdown(target_file):
            continue

        try:
            raw_content = target_file.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue

        valid_docs_count += 1
        doc_title = target_file.stem
        escaped_doc_title = html.escape(doc_title)
        escaped_rel_path = html.escape(resolved_rel_path)
        anchor_id = f"doc-{idx}"

        toc_items.append(f'<li><a href="#{anchor_id}">{escaped_doc_title}</a> <span style="font-size: 11px; color: #94a3b8;">({escaped_rel_path})</span></li>')

        # リンクされたメールの検出
        if include_linked_emails:
            emails = extract_linked_email_paths(raw_content, base_dir=target_file.parent, vault_path=v_dir)
            for em_path in emails:
                em_str = str(em_path.resolve())
                if em_str not in seen_emails:
                    seen_emails.add(em_str)
                    all_linked_emails.append(em_path.resolve())

        # 1. 画像・図面の置換
        processed_md = raw_content
        if include_images:
            processed_md, img_count = replace_obsidian_image_embeds(
                content=processed_md,
                vault_path=str(v_dir),
                current_file_path=resolved_rel_path,
            )
            total_images_embedded += img_count

        # 2. MarkdownからHTMLへレンダリング
        rendered_body = render_markdown_to_clean_html(processed_md)

        # 3. Raw Markdown Section
        raw_section = ""
        if include_raw_markdown:
            escaped_raw = html.escape(strip_frontmatter(strip_excalidraw_data(raw_content)))
            raw_section = f"""
            <details class="doc-raw-markdown" open>
                <summary>📝 マークダウンファイルの元データ</summary>
                <pre><code>{escaped_raw}</code></pre>
            </details>
            """

        doc_sections.append(f"""
        <article class="document-article" id="{anchor_id}">
            <div class="document-article-header">
                <h2>[{idx}] {escaped_doc_title}</h2>
                <div class="document-path-badge">Path: {escaped_rel_path}</div>
            </div>
            <div class="document-body">
                {rendered_body}
            </div>
            {raw_section}
        </article>
        """)

    # 4. APPENDIX: 呼び出されたメールの展開
    total_linked_emails = 0
    if include_linked_emails and all_linked_emails:
        email_articles = []
        email_toc_items = []
        for e_idx, em_path in enumerate(all_linked_emails, start=1):
            parsed_mail = parse_email_file(em_path)
            if not parsed_mail:
                continue
            total_linked_emails += 1
            em_anchor = f"linked-email-{e_idx}"
            mail_subject = parsed_mail.get("subject") or em_path.name
            escaped_subject = html.escape(mail_subject)
            escaped_file_name = html.escape(em_path.name)
            escaped_sender = html.escape(parsed_mail.get("sender") or "-")
            escaped_to = html.escape(parsed_mail.get("to") or "-")
            escaped_date = html.escape(parsed_mail.get("date") or "-")
            escaped_mail_path = html.escape(str(em_path))

            rendered_mail_body, img_count = render_email_to_html(parsed_mail, include_images=include_images)
            total_images_embedded += img_count

            email_toc_items.append(
                f'<li><a href="#{em_anchor}">✉️ {escaped_subject}</a> <span style="font-size: 11px; color: #94a3b8;">({escaped_file_name})</span></li>'
            )

            email_articles.append(f"""
            <article class="document-article linked-email-article" id="{em_anchor}">
                <div class="document-article-header">
                    <h2>✉️ [{e_idx}] {escaped_subject}</h2>
                    <div class="document-path-badge">File: {escaped_file_name}</div>
                </div>
                <div class="linked-email-meta">
                    <dl style="margin: 0;">
                        <dt>件名:</dt><dd>{escaped_subject}</dd>
                        <dt>差出人:</dt><dd>{escaped_sender}</dd>
                        <dt>宛先:</dt><dd>{escaped_to}</dd>
                        <dt>送信日時:</dt><dd>{escaped_date}</dd>
                        <dt>パス:</dt><dd style="word-break: break-all;">{escaped_mail_path}</dd>
                    </dl>
                </div>
                <div class="document-body">
                    {rendered_mail_body}
                </div>
            </article>
            """)

        if email_articles:
            if toc_items:
                toc_items.append(f'<li style="margin-top: 8px;"><strong>📎 APPENDIX: 呼び出されたメール ({total_linked_emails} 件)</strong><ul>{"".join(email_toc_items)}</ul></li>')
            doc_sections.append(f"""
            <section class="ai-linked-emails-section">
                <h2>📎 APPENDIX: 呼び出されたメール ({total_linked_emails} 件)</h2>
                {"".join(email_articles)}
            </section>
            """)

    # AIプロンプトブロック
    prompt_block = ""
    if escaped_prompt:
        prompt_block = f"""
        <section class="ai-prompt-section">
            <h2>🎯 AIへの指示・質問 (Prompt Instructions)</h2>
            <div class="ai-prompt-content">{escaped_prompt}</div>
        </section>
        """

    # 目次ブロック
    toc_block = ""
    if toc_items:
        toc_block = f"""
        <nav class="document-toc">
            <h2>📚 含まれるドキュメント ({valid_docs_count} 件)</h2>
            <ul>
                {"".join(toc_items)}
            </ul>
        </nav>
        """

    body_content = "\n".join(doc_sections)

    full_html = f"""<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{escaped_title}</title>
    <style>
{get_ai_export_css()}
    </style>
</head>
<body>
    <div class="ai-document-container">
        <header class="ai-header">
            <h1>{escaped_title}</h1>
            <div class="ai-meta-info">Total Documents: {valid_docs_count} | Linked Emails: {total_linked_emails} | Embedded Images: {total_images_embedded} | Generated for Chat AI Context</div>
        </header>

        {prompt_block}
        {toc_block}

        <main>
            {body_content}
        </main>
    </div>
</body>
</html>
"""

    stats = {
        "total_documents": valid_docs_count,
        "total_linked_emails": total_linked_emails,
        "total_images_embedded": total_images_embedded,
        "size_bytes": len(full_html.encode("utf-8")),
    }

    return full_html, stats
