"""
MkDocsドキュメントリポジトリ判定、リンク先Markdown自動探索、および統合マークダウン＋結合画像生成モジュール (mkdocs_support.py)

仕様:
1. リポジトリ内のYAMLファイル（mkdocs.yml / mkdocs.yaml）を解析し、通常リポジトリかMkDocsドキュメントリポジトリかを判定する。
2. 選択中のMarkdownファイルや mkdocs.yml からリンクされている同一リポジトリ内のMarkdownファイルを再帰的に探索する。
3. チャットツールの添付ファイル数制限（5ファイル上限）およびビジョン機能に対応するため、
   Markdown内から呼び出されている全画像を検出し、所属ファイル名・リンク記法のヘッダーラベル付きで1枚の結合画像（PNG/JPEG、4.5MB制限自動クリア）に縦連結する。
4. 統合マークダウンには生の画像リンク記法を維持し、AIへの画像照合ルールおよびSpoonfeeder2で差分反映可能な出力契約を付与して出力する。
"""

from __future__ import annotations

import base64
import io
import logging
import re
import urllib.parse
from html import escape as html_escape
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont

from .repository import list_repository_entries, read_text_file, render_tree

logger = logging.getLogger(__name__)

# 大量画像結合時の DecompressionBombError 制限を解除
Image.MAX_IMAGE_PIXELS = None

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"}
MKDOCS_YAML_NAMES = ("mkdocs.yml", "mkdocs.yaml")


def _parse_yaml_safely(yaml_text: str) -> dict[str, Any]:
    """MkDocs固有の !!python/name: タグ等が含まれていても安全に辞書としてYAMLを解析する。"""
    try:
        import yaml

        class MkDocsSafeLoader(yaml.SafeLoader):
            pass

        def _ignore_unknown_tag(loader: yaml.SafeLoader, tag_suffix: str, node: yaml.Node) -> Any:
            if isinstance(node, yaml.ScalarNode):
                return loader.construct_scalar(node)
            if isinstance(node, yaml.SequenceNode):
                return loader.construct_sequence(node)
            if isinstance(node, yaml.MappingNode):
                return loader.construct_mapping(node)
            return None

        MkDocsSafeLoader.add_multi_constructor("", _ignore_unknown_tag)
        data = yaml.load(yaml_text, Loader=MkDocsSafeLoader)
        if isinstance(data, dict):
            return data
    except Exception:
        pass

    # フォールバック簡易解析
    result: dict[str, Any] = {}
    site_match = re.search(r"(?m)^\s*site_name\s*:\s*(.+)$", yaml_text)
    if site_match:
        result["site_name"] = site_match.group(1).strip().strip("\"'")
    docs_match = re.search(r"(?m)^\s*docs_dir\s*:\s*(.+)$", yaml_text)
    if docs_match:
        result["docs_dir"] = docs_match.group(1).strip().strip("\"'")
    if re.search(r"(?m)^\s*nav\s*:", yaml_text):
        result["nav"] = []
    return result


def detect_mkdocs_config(root: Path) -> dict[str, Any]:
    """リポジトリ内のYAMLファイルを確認し、MkDocsドキュメントリポジトリかどうかを判定する。"""
    root = root.resolve()
    candidates: list[Path] = []
    for name in MKDOCS_YAML_NAMES:
        cand = root / name
        if cand.is_file():
            candidates.append(cand)

    # 直下に他の *.yml / *.yaml があれば念のため確認
    if not candidates and root.is_dir():
        for p in sorted(root.iterdir()):
            if p.is_file() and p.suffix.lower() in {".yml", ".yaml"}:
                candidates.append(p)

    for yaml_path in candidates:
        try:
            text, _ = read_text_file(yaml_path)
        except OSError:
            continue
        parsed = _parse_yaml_safely(text)
        if not isinstance(parsed, dict):
            continue
        is_mkdocs_file = yaml_path.name.lower() in MKDOCS_YAML_NAMES
        has_mkdocs_keys = "site_name" in parsed and (
            is_mkdocs_file or "nav" in parsed or "docs_dir" in parsed or "theme" in parsed or (root / "docs").is_dir()
        )
        if has_mkdocs_keys or (is_mkdocs_file and ("nav" in parsed or "docs_dir" in parsed)):
            site_name = str(parsed.get("site_name") or root.name).strip()
            docs_dir = str(parsed.get("docs_dir") or "docs").strip().strip("/") or "docs"
            return {
                "is_mkdocs": True,
                "config_file": yaml_path.relative_to(root).as_posix(),
                "site_name": site_name,
                "docs_dir": docs_dir,
            }

    return {
        "is_mkdocs": False,
        "config_file": "",
        "site_name": "",
        "docs_dir": "docs",
    }


def _extract_nav_md_paths(nav_obj: Any) -> list[str]:
    """mkdocs.yml の nav 構造から .md ファイルパスを再帰的に抽出する。"""
    found: list[str] = []
    if isinstance(nav_obj, str):
        if nav_obj.lower().endswith(".md"):
            found.append(nav_obj)
    elif isinstance(nav_obj, list):
        for item in nav_obj:
            found.extend(_extract_nav_md_paths(item))
    elif isinstance(nav_obj, dict):
        for val in nav_obj.values():
            found.extend(_extract_nav_md_paths(val))
    return found


def _extract_markdown_doc_links(markdown_text: str) -> list[str]:
    """Markdown本文から他ドキュメントへのリンク（[text](path) および [[path]]）を抽出する。"""
    # コードブロック内は除外して誤検出を防ぐ
    cleaned = re.sub(r"```[\s\S]*?```", "", markdown_text)
    targets: list[str] = []

    # 1. 標準Markdownリンク（先頭が ! でないもの）: [label](url)
    for m in re.finditer(r"(?<!!)\[[^\]]*\]\(([^)\n]+)\)", cleaned):
        raw_url = m.group(1).strip().split()[0].strip("<>\"'")
        if not raw_url or raw_url.startswith(("http://", "https://", "mailto:", "tel:", "data:", "#")):
            continue
        target = urllib.parse.unquote(raw_url.split("#")[0].split("?")[0].strip())
        if target:
            targets.append(target)

    # 2. WikiLink（先頭が ! でないもの）: [[target|alias]] または [[target]]
    for m in re.finditer(r"(?<!!)\[\[([^\]\n]+)\]\]", cleaned):
        raw_target = m.group(1).split("|")[0].split("#")[0].strip()
        if raw_target:
            targets.append(raw_target)

    return targets


def _resolve_linked_md(root: Path, docs_dir: str, current_file: Path, raw_target: str) -> str | None:
    """リンク文字列からリポジトリ内の実在する .md ファイルの相対パスを解決する。"""
    root = root.resolve()
    docs_root = (root / docs_dir).resolve()
    clean = raw_target.replace("\\", "/").strip()
    if not clean:
        return None

    # 画像拡張子は除外
    lower = clean.lower()
    if any(lower.endswith(ext) for ext in IMAGE_EXTENSIONS):
        return None

    search_bases = [current_file.parent, docs_root, root]
    suffix_variants = [clean]
    if not lower.endswith(".md"):
        suffix_variants.append(f"{clean}.md")
        suffix_variants.append(f"{clean.rstrip('/')}/index.md")

    for base in search_bases:
        for variant in suffix_variants:
            cand = (base / variant.lstrip("/")).resolve() if clean.startswith("/") else (base / variant).resolve()
            if cand.is_file() and cand.suffix.lower() == ".md" and root in cand.parents:
                return cand.relative_to(root).as_posix()

    return None


def discover_linked_markdown_files(root: Path, selected_files: list[str]) -> list[str]:
    """選択されたMarkdownファイルやmkdocs.ymlからリンクされている別Markdownファイルを再帰的に探索する。"""
    root = root.resolve()
    mkdocs_info = detect_mkdocs_config(root)
    docs_dir = mkdocs_info.get("docs_dir") or "docs"

    queue: list[str] = []
    visited: set[str] = set()
    discovered: set[str] = set()

    for rel in selected_files:
        norm = rel.replace("\\", "/").strip("/")
        if norm and norm not in visited:
            visited.add(norm)
            queue.append(norm)

    while queue:
        current_rel = queue.pop(0)
        current_path = (root / current_rel).resolve()
        if not current_path.is_file() or root not in current_path.parents:
            continue

        try:
            text, _ = read_text_file(current_path)
        except OSError:
            continue

        # mkdocs.yml / mkdocs.yaml の場合は nav 内の .md を辿る
        if current_path.name.lower() in MKDOCS_YAML_NAMES:
            parsed = _parse_yaml_safely(text)
            nav_paths = _extract_nav_md_paths(parsed.get("nav"))
            for nav_target in nav_paths:
                resolved = _resolve_linked_md(root, docs_dir, root / docs_dir / "index.md", nav_target)
                if resolved and resolved not in visited:
                    visited.add(resolved)
                    discovered.add(resolved)
                    queue.append(resolved)
            continue

        if current_path.suffix.lower() != ".md":
            continue

        for raw_target in _extract_markdown_doc_links(text):
            resolved = _resolve_linked_md(root, docs_dir, current_path, raw_target)
            if resolved and resolved not in visited:
                visited.add(resolved)
                discovered.add(resolved)
                queue.append(resolved)

    return sorted(discovered)


def extract_markdown_image_links(markdown_text: str) -> list[tuple[str, str]]:
    """
    Markdownテキスト内から画像・図面を指すリンク記法を抽出する。
    戻り値: [(元のマークダウン記法, リンク先ターゲットパス), ...]
    """
    links: list[tuple[str, str]] = []

    # 1. Obsidian埋め込み: ![[filename|alias]] または ![[filename]]
    for m in re.finditer(r"!\[\[([^\]\n]+)\]\]", markdown_text):
        full_match = m.group(0)
        target = m.group(1).split("|")[0].strip()
        if target:
            links.append((full_match, target))

    # 2. 標準マークダウン画像: ![alt](url) または ![alt](url "title")
    for m in re.finditer(r"!\[([^\]]*)\]\(([^)\n]+)\)", markdown_text):
        full_match = m.group(0)
        raw_url = m.group(2).strip().split()[0].strip("<>\"'")
        if raw_url and not raw_url.startswith(("http://", "https://", "data:")):
            links.append((full_match, raw_url))

    # 3. HTML <img src="..."> タグ
    for m in re.finditer(r'<img\b[^>]*?\bsrc=["\']([^"\']+)["\'][^>]*>', markdown_text, flags=re.IGNORECASE):
        full_match = m.group(0)
        raw_url = m.group(1).strip()
        if raw_url and not raw_url.startswith(("http://", "https://", "data:")):
            links.append((full_match, raw_url))

    # 4. 画像拡張子を持つ通常WikiLink: [[image.png]]
    for m in re.finditer(r"(?<!!)\[\[([^\]\n]+)\]\]", markdown_text):
        full_match = m.group(0)
        target = m.group(1).split("|")[0].strip()
        lower = target.lower()
        if any(lower.endswith(ext) for ext in IMAGE_EXTENSIONS) or lower.endswith((".excalidraw.md", ".excalidraw")):
            links.append((full_match, target))

    return links


def resolve_mkdocs_image_path(root: Path, docs_dir: str, current_md_path: Path, raw_target: str) -> Path | None:
    """Markdown内の画像リンク文字列から実在する画像ファイルパスを解決する。"""
    root = root.resolve()
    docs_root = (root / docs_dir).resolve()
    decoded = urllib.parse.unquote(raw_target.split("?")[0].split("#")[0].strip())
    clean = decoded.replace("\\", "/")
    if not clean:
        return None

    search_bases = [current_md_path.parent, docs_root, root]
    for base in search_bases:
        cand = (base / clean.lstrip("/")).resolve() if clean.startswith("/") else (base / clean).resolve()
        if cand.is_file() and (root in cand.parents or cand == root):
            return cand

    # 同名ファイルのフォールバック探索
    basename = Path(clean).name
    if basename:
        for p in root.rglob(basename):
            if p.is_file() and not any(part in {".git", ".venv", "venv", "node_modules", "site"} for part in p.parts):
                return p.resolve()

    return None


def flatten_to_rgb(img: Image.Image, bg_color: tuple[int, int, int] = (255, 255, 255)) -> Image.Image:
    """透過画像（RGBA, LA, Pモード等）の透明部分を白背景でアルファ合成し、黒潰れを防止する。"""
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        alpha_img = img.convert("RGBA")
        base = Image.new("RGBA", alpha_img.size, (*bg_color, 255))
        composite = Image.alpha_composite(base, alpha_img)
        return composite.convert("RGB")
    return img.convert("RGB")


def get_japanese_font(size: int = 20) -> ImageFont.ImageFont:
    """OS標準の日本語フォントを自動検出してロードする（文字化け防止）。"""
    candidate_paths = [
        # macOS
        "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc",
        "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc",
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/System/Library/Fonts/AppleSDGothicNeo.ttc",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/Library/Fonts/Arial Unicode.ttf",
        # Windows
        "C:/Windows/Fonts/msgothic.ttc",
        "C:/Windows/Fonts/meiryo.ttc",
        "C:/Windows/Fonts/YuGothM.ttc",
        "C:/Windows/Fonts/YuGothR.ttc",
        "C:/Windows/Fonts/msmincho.ttc",
        # Linux
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/vlgothic/VL-Gothic-Regular.ttf",
        "/usr/share/fonts/ipafont-gothic/ipag.ttf",
    ]
    for p in candidate_paths:
        try:
            path_obj = Path(p)
            if path_obj.exists():
                return ImageFont.truetype(str(path_obj), size=size)
        except OSError:
            continue
    return ImageFont.load_default()


def load_pil_image(img_path: Path) -> Image.Image | None:
    """画像ファイル（PNG/JPG/SVG等）をPIL Imageとして読み込む。"""
    suffix = img_path.suffix.lower()
    if suffix == ".svg":
        try:
            svg_bytes = img_path.read_bytes()
            try:
                import resvg_py
                png_bytes = resvg_py.svg_to_bytes(svg_bytes.decode("utf-8", errors="replace"))
                if png_bytes:
                    return Image.open(io.BytesIO(png_bytes))
            except Exception:
                pass
            try:
                import cairosvg
                png_bytes = cairosvg.svg2png(bytestring=svg_bytes)
                if png_bytes:
                    return Image.open(io.BytesIO(png_bytes))
            except Exception:
                pass
        except OSError:
            return None
        return None

    try:
        img = Image.open(img_path)
        img.load()
        return img
    except Exception:
        logger.warning("画像を読み込めませんでした: %s", img_path, exc_info=True)
        return None


def build_image_strip(
    images_data: list[dict[str, Any]],
    target_width: int | None = None,
    max_bytes: int = int(4.2 * 1024 * 1024),
) -> bytes | None:
    """
    収集された画像リスト（PIL Image、所属ファイルパス、リンク記法）を上から下へ縦1列に連結し、
    各画像上部に白背景＋黒文字の図説明ラベルを描画した1枚の画像バイト列を生成する。
    社内チャットのファイル添付上限（5ファイル制限・4.5MB制限）を確実にクリアする。
    """
    if not images_data:
        return None

    if target_width and target_width > 0:
        base_target_width = target_width
    else:
        max_img_w = max((item["image"].width for item in images_data), default=2800)
        base_target_width = max(2800, min(3200, max_img_w))

    header_height = 44
    gap = 28
    bg_color = (255, 255, 255)
    label_text_color = (0, 0, 0)
    border_color = (226, 232, 240)

    def render_combined_canvas(scale: float) -> Image.Image:
        cur_width = max(800, int(base_target_width * scale))
        cur_header_h = max(32, int(header_height * scale))
        cur_gap = max(16, int(gap * scale))
        font_size = max(16, int(22 * scale))
        font = get_japanese_font(size=font_size)

        processed_blocks: list[tuple[Image.Image, str]] = []
        total_height = cur_gap

        for item in images_data:
            orig_img = item["image"]
            label_text = f"【図{item['index']}】 所属: {item['doc_path']}  |  リンク記法: {item['link_text']}"

            w, h = orig_img.size
            if w > cur_width and w > 0 and h > 0:
                new_h = max(1, int(h * (cur_width / float(w))))
                resized_img = orig_img.resize((cur_width, new_h), Image.Resampling.LANCZOS)
            else:
                resized_img = orig_img

            block_h = cur_header_h + resized_img.height
            total_height += block_h + cur_gap
            processed_blocks.append((resized_img, label_text))

        combined = Image.new("RGB", (cur_width + cur_gap * 2, total_height), color=bg_color)
        draw = ImageDraw.Draw(combined)

        y_offset = cur_gap
        for img, label_text in processed_blocks:
            x_offset = cur_gap
            text_y = y_offset + (cur_header_h - font_size) // 2
            draw.text((x_offset + 4, text_y), label_text, fill=label_text_color, font=font)

            line_y = y_offset + cur_header_h - 2
            draw.line([(x_offset, line_y), (x_offset + cur_width, line_y)], fill=border_color, width=1)

            img_rgb = flatten_to_rgb(img, bg_color=bg_color)
            paste_x = x_offset + max(0, (cur_width - img_rgb.width) // 2)
            combined.paste(img_rgb, (paste_x, y_offset + cur_header_h))

            y_offset += cur_header_h + img.height + cur_gap

        return combined

    scale_steps = [1.0, 0.85, 0.70, 0.55]
    jpeg_qualities = [92, 85, 75]

    canvas = render_combined_canvas(1.0)
    buf = io.BytesIO()
    canvas.save(buf, format="PNG", optimize=True)
    png_data = buf.getvalue()
    if len(png_data) <= max_bytes:
        return png_data

    for scale in scale_steps:
        if scale != 1.0:
            canvas = render_combined_canvas(scale)
        for quality in jpeg_qualities:
            buf = io.BytesIO()
            canvas.save(buf, format="JPEG", quality=quality, optimize=True)
            data = buf.getvalue()
            if len(data) <= max_bytes:
                return data

    canvas = render_combined_canvas(0.45)
    buf = io.BytesIO()
    canvas.save(buf, format="JPEG", quality=65, optimize=True)
    return buf.getvalue()


def strip_excalidraw_data_section(text: str) -> str:
    """Excalidrawノート内の # Excalidraw Data 以降の圧縮JSONを除去する。"""
    marker = re.search(r"(?m)^#\s+Excalidraw Data\b", text)
    if marker:
        return text[: marker.start()].rstrip()
    return text


def build_mkdocs_bundle(
    root: Path,
    selected_files: list[str] | None = None,
    title: str = "",
) -> tuple[str, bytes | None, dict[str, Any]]:
    """
    MkDocsリポジトリの選択されたファイル群から：
    1. 画像リンク記法を維持し、AI指示・反映契約を含めた統合マークダウン文字列
    2. 呼び出されている全画像を縦1列に連結した結合画像バイト列（PNG/JPEG）
    3. 統計・画像対応メタ情報（stats）
    を生成して返却する。
    """
    root = root.resolve()
    mkdocs_info = detect_mkdocs_config(root)
    docs_dir = mkdocs_info.get("docs_dir") or "docs"
    site_name = title.strip() or mkdocs_info.get("site_name") or root.name

    entries, _ = list_repository_entries(root, show_ignored=False)
    available = {e.path for e in entries if e.kind == "file" and not e.ignored}
    chosen = sorted(available if selected_files is None else available.intersection(selected_files))

    # mkdocs.yml -> docs/index.md -> その他の順で見やすく整列
    def _sort_key(rel_path: str) -> tuple[int, str]:
        lower = rel_path.lower()
        if lower in MKDOCS_YAML_NAMES:
            return (0, lower)
        if lower == f"{docs_dir.lower()}/index.md" or lower == "index.md":
            return (1, lower)
        return (2, lower)

    chosen = sorted(chosen, key=_sort_key)

    header_rules = f"""<system_instructions>
# 【AIへの指示: MkDocsドキュメントおよび結合画像の参照・修正出力ルール】
本ドキュメントは、MkDocsリポジトリ（サイト名: {site_name}）の複数ファイル（設定YAMLおよびMarkdown文書）を統合したコンテキストドキュメントです。
各Markdownファイル内で呼び出されている図面・画面キャプチャ画像は、同時に添付された結合画像ファイル（1枚に縦連結された画像）に収録されています。

## 1. 添付画像の照合ルール
- 本文中の `![alt](画像パス)` や `![[画像名]]` という画像リンク記法は、同時添付された結合画像ファイル内の各図面と対応しています。
- 結合画像ファイル内の各図面の上部には、対応する【図番号】、所属ファイルパス、および元のリンク記法（例: `【図1】 所属: docs/index.md | リンク記法: ![全体構成図](images/architecture.png)`）が明記されています。
- ドキュメントの内容確認・修正・追記を行う際は、本文と結合画像の該当ブロックを照合して回答してください。

## 2. ドキュメント修正・出力時の必須ルール（MkDocs互換性 & Spoonfeeder2自動反映）
- あなたがMarkdownファイルや `mkdocs.yml` の修正案を出力する際は、**文中の画像リンク記法（例: `![システム全体構成図](images/architecture.png)`）を勝手に削除したり別形式へ書き換えたりせず、そのままの形で維持して出力してください**。
- 変更不要なファイルは出力しないでください。
- ファイルを新規作成・修正・削除する場合は、Spoonfeeder2の「AIの変更を反映」へそのまま貼り付けて自動反映できるよう、最初にYAML形式の `<change_manifest format="yaml">` を出力し、続けて以下の `<file_changes>` 形式（推奨）またはファイルパス付きコードブロック形式で変更後のファイル全文を出力してください。

<change_manifest format="yaml">
files:
  - path: docs/index.md
    action: modify
    reason: 変更理由
</change_manifest>

<file_changes>
  <file path="docs/index.md" action="modify"><![CDATA[
# 変更後のMarkdown全文をここに出力
]]></file>
</file_changes>
</system_instructions>

<repository_structure>
{render_tree(entries)}
</repository_structure>"""

    md_sections: list[str] = [header_rules.strip()]
    images_collected: list[dict[str, Any]] = []
    images_meta: list[dict[str, Any]] = []
    seen_image_keys: set[str] = set()
    doc_count = 0

    for rel_path in chosen:
        file_path = (root / rel_path).resolve()
        if not file_path.is_file() or root not in file_path.parents:
            continue
        try:
            raw_text, _ = read_text_file(file_path)
        except OSError:
            continue

        doc_count += 1

        if file_path.suffix.lower() == ".md":
            image_links = extract_markdown_image_links(raw_text)
            for link_str, target_str in image_links:
                img_path = resolve_mkdocs_image_path(root, docs_dir, file_path, target_str)
                if img_path is None:
                    continue
                rel_img = img_path.relative_to(root).as_posix() if root in img_path.parents else img_path.name
                dedup_key = f"{rel_path}::{rel_img}"
                if dedup_key in seen_image_keys:
                    continue
                pil_img = load_pil_image(img_path)
                if pil_img is not None:
                    seen_image_keys.add(dedup_key)
                    idx = len(images_collected) + 1
                    images_collected.append({
                        "index": idx,
                        "doc_path": rel_path,
                        "link_text": link_str,
                        "resolved_path": rel_img,
                        "image": pil_img,
                    })
                    images_meta.append({
                        "index": idx,
                        "doc_path": rel_path,
                        "link_text": link_str,
                        "resolved_path": rel_img,
                        "width": pil_img.width,
                        "height": pil_img.height,
                    })

        cleaned_body = strip_excalidraw_data_section(raw_text)
        section_text = f"""# ===== [ファイル {doc_count}/{len(chosen)}] {rel_path} =====
<file path="{html_escape(rel_path, quote=True)}">
{cleaned_body.strip()}
</file>"""
        md_sections.append(section_text)

    if images_meta:
        mapping_lines = [
            "# 🖼️ 添付結合画像の対応一覧",
            "同時添付された結合画像ファイルには、以下の順序で図面が収録されています：",
            "",
        ]
        for meta in images_meta:
            mapping_lines.append(
                f"- **【図{meta['index']}】** 所属: `{meta['doc_path']}` | リンク記法: `{meta['link_text']}` (実体: `{meta['resolved_path']}`)"
            )
        md_sections.append("\n".join(mapping_lines))

    reminder = """<response_reminder>
MkDocsドキュメントの修正を求められた場合は、回答直前に次を再確認してください。
1. 本文中の画像リンク記法（![alt](path) 等）を削除・改変せずそのまま維持する。
2. 変更対象ファイルはリポジトリ相対パス（例: docs/index.md）を明示し、<file_changes> または ```markdown path: docs/xxx.md 形式で変更後全文を出力する。
3. 変更不要なファイルは出力しない。
</response_reminder>"""
    md_sections.append(reminder)

    final_markdown = "\n\n".join(md_sections)
    image_bytes = build_image_strip(images_collected) if images_collected else None

    stats: dict[str, Any] = {
        "site_name": site_name,
        "docs_dir": docs_dir,
        "total_documents": doc_count,
        "total_images": len(images_collected),
        "image_bytes": len(image_bytes) if image_bytes else 0,
        "markdown_chars": len(final_markdown),
        "images_meta": images_meta,
    }
    return final_markdown, image_bytes, stats


def image_bytes_to_data_url(image_bytes: bytes | None) -> str:
    """結合画像のバイト列をプレビュー表示用の Base64 Data URL に変換する。"""
    if not image_bytes:
        return ""
    mime = "image/png" if image_bytes.startswith(b"\x89PNG\r\n\x1a\n") else "image/jpeg"
    b64 = base64.b64encode(image_bytes).decode("ascii")
    return f"data:{mime};base64,{b64}"
