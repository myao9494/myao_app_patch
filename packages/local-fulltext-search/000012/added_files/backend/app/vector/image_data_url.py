"""
画像ファイル・SVG テキストを Base64 Data URL（data:image/...;base64,...）へ変換する。
仕様:
- SVG は、ダークテーマ向けの配色のままだと白い背景で読めなくなるため、ライトテーマ向けに補正してから埋め込む。
- 画像として扱えないファイル、読めないファイルは None を返す（エクスポート全体は止めない）。
"""

import base64
import mimetypes
import re
from pathlib import Path
from typing import Optional


IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".svg", ".webp", ".ico"}


FIGURE_EXTENSIONS = {".drawio.svg", ".dio.svg", ".excalidraw.md", ".excalidraw"}


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
    except (OSError, ValueError):
        return None


def svg_text_to_base64_data_url(svg_text: str) -> str:
    """SVGテキストを Base64 Data URL に変換する"""
    sanitized = sanitize_svg_for_light_theme(svg_text)
    b64 = base64.b64encode(sanitized.encode("utf-8")).decode("ascii")
    return f"data:image/svg+xml;base64,{b64}"
