"""
MkDocsドキュメントリポジトリ判定、リンク先Markdown自動探索、および統合マークダウン＋図PDF生成モジュール (mkdocs_support.py)

仕様:
1. リポジトリ内のYAMLファイル（mkdocs.yml / mkdocs.yaml）を解析し、通常リポジトリかMkDocsドキュメントリポジトリかを判定する。
2. 選択中のMarkdownファイルや mkdocs.yml からリンクされている同一リポジトリ内のMarkdownファイルを再帰的に探索する。
3. チャットツールの添付ファイル数制限（5ファイル上限）およびビジョン機能に対応するため、
   Markdown内から呼び出されている全画像を検出し、所属ファイル名・リンク記法のヘッダーラベル付きで1図1ページのPDFにまとめる（画像は無劣化で埋め込む。会社AIの自動圧縮を避けるためPDFで出力）。
   Markdownに直接書かれたインライン `<svg>` も画像として図PDFへ収録し、統合マークダウン側は短い参照文に置き換えて肥大化を防ぐ。
   PDFが指定の上限（既定10MB）を超える場合は図の境界で複数のPDFに分割する（build_pdf_parts）。1ページが上限を超える場合だけそのページを縮小・JPEG化する。
4. 統合マークダウンには生の画像リンク記法を維持し、AIへの画像照合ルールおよびSpoonfeeder2で差分反映可能な出力契約を付与して出力する。
"""

from __future__ import annotations

import base64
import io
import logging
import re
import urllib.parse
from dataclasses import dataclass
from html import escape as html_escape
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont

from .output_limits import DEFAULT_PDF_MAX_BYTES
from .pdf_output import assemble_pdf, encode_page, pack_pages, page_budget
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


_SVG_TAG_RE = re.compile(r"<(/?)svg\b[^>]*?(/?)>", re.IGNORECASE)
_FENCE_RE = re.compile(r"(```|~~~)[\s\S]*?(?:\1|\Z)")
SVG_NS = "http://www.w3.org/2000/svg"


def find_inline_svgs(markdown_text: str) -> list[tuple[int, int]]:
    """
    Markdown本文に直接書かれた `<svg ...>...</svg>` の範囲 (開始, 終了) を出現順に返す。
    入れ子の `<svg>` は最外殻だけを1件として扱い、フェンス付きコードブロック内の例示は対象外とする。
    閉じタグのない `<svg>` は無視する。
    """
    fenced = [m.span() for m in _FENCE_RE.finditer(markdown_text)]

    def in_fence(pos: int) -> bool:
        return any(start <= pos < end for start, end in fenced)

    spans: list[tuple[int, int]] = []
    depth = 0
    start = 0
    for m in _SVG_TAG_RE.finditer(markdown_text):
        if in_fence(m.start()):
            continue
        is_close, is_self_closing = bool(m.group(1)), bool(m.group(2))
        if is_close:
            if depth > 0:
                depth -= 1
                if depth == 0:
                    spans.append((start, m.end()))
        elif is_self_closing:
            if depth == 0:
                spans.append((m.start(), m.end()))
        else:
            if depth == 0:
                start = m.start()
            depth += 1
    return spans


def render_svg_text(svg_text: str) -> Image.Image | None:
    """SVGマークアップをPIL Imageへ描画する。変換器（resvg-py / cairosvg）がない・不正なSVGならNone。"""
    if not re.search(r"<svg\b[^>]*\bxmlns\s*=", svg_text, flags=re.IGNORECASE):
        # HTML埋め込みのSVGは名前空間を省略しがちだが、変換器は必須とするため補う
        svg_text = re.sub(r"<svg\b", f'<svg xmlns="{SVG_NS}"', svg_text, count=1, flags=re.IGNORECASE)
    try:
        import resvg_py
        png_bytes = resvg_py.svg_to_bytes(svg_text)
        if png_bytes:
            img = Image.open(io.BytesIO(png_bytes))
            img.load()
            return img
    except Exception:
        pass
    try:
        import cairosvg
        png_bytes = cairosvg.svg2png(bytestring=svg_text.encode("utf-8"))
        if png_bytes:
            img = Image.open(io.BytesIO(png_bytes))
            img.load()
            return img
    except Exception:
        pass
    return None


def replace_inline_svgs(markdown_text: str, on_svg) -> str:
    """
    本文中のインライン `<svg>` を `on_svg(svg_text, 出現番号)` の戻り値へ置き換える。
    戻り値がNone（描画できなかった等）の場合は、情報を失わないよう元のSVGをそのまま残す。
    """
    out: list[str] = []
    cursor = 0
    for number, (start, end) in enumerate(find_inline_svgs(markdown_text), start=1):
        replacement = on_svg(markdown_text[start:end], number)
        if replacement is None:
            continue
        out.append(markdown_text[cursor:start])
        out.append(replacement)
        cursor = end
    out.append(markdown_text[cursor:])
    return "".join(out)


def load_pil_image(img_path: Path) -> Image.Image | None:
    """画像ファイル（PNG/JPG/SVG等）をPIL Imageとして読み込む。"""
    suffix = img_path.suffix.lower()
    if suffix == ".svg":
        try:
            return render_svg_text(img_path.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            return None

    try:
        img = Image.open(img_path)
        img.load()
        return img
    except Exception:
        logger.warning("画像を読み込めませんでした: %s", img_path, exc_info=True)
        return None


_PAGE_MIN_WIDTH = 1200


def render_figure_page(item: dict[str, Any]) -> Image.Image:
    """
    1図を1ページ分のRGB画像にする。上部に白背景＋黒文字の図説明ラベル（【図N】所属・リンク記法）を置き、
    その下に図を等倍で中央寄せする（縮小しない。収まらないときの圧縮は pdf_output が行う）。
    """
    label_text = f"【図{item['index']}】 所属: {item['doc_path']}  |  リンク記法: {item['link_text']}"
    figure = flatten_to_rgb(item["image"])
    margin = 28
    header_height = 44
    font_size = 22
    page_width = max(_PAGE_MIN_WIDTH, figure.width) + margin * 2
    page = Image.new("RGB", (page_width, margin + header_height + figure.height + margin), color=(255, 255, 255))
    draw = ImageDraw.Draw(page)
    draw.text((margin + 4, margin + (header_height - font_size) // 2), label_text, fill=(0, 0, 0), font=get_japanese_font(size=font_size))
    line_y = margin + header_height - 2
    draw.line([(margin, line_y), (page_width - margin, line_y)], fill=(226, 232, 240), width=1)
    page.paste(figure, ((page_width - figure.width) // 2, margin + header_height))
    return page


@dataclass(frozen=True)
class PdfPart:
    """図PDF1ファイル分。figures は収録した図番号の範囲 (最初, 最後)。"""

    data: bytes
    figures: tuple[int, int]


def build_pdf_parts(images_data: list[dict[str, Any]], max_bytes: int = DEFAULT_PDF_MAX_BYTES) -> list[PdfPart]:
    """
    図を1図1ページのPDFにする。各ページは無劣化で埋め込み、1ページが max_bytes に収まらないときだけ
    そのページを縮小・JPEG化する。全体が max_bytes を超える場合は図の境界で複数のPDFに分割する。
    """
    if not images_data:
        return []
    budget = page_budget(max_bytes)
    pages = [encode_page(render_figure_page(item), budget) for item in images_data]
    return [
        PdfPart(assemble_pdf([pages[i] for i in group]), (images_data[group[0]]["index"], images_data[group[-1]]["index"]))
        for group in pack_pages(pages, max_bytes)
    ]


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
    pdf_max_bytes: int = DEFAULT_PDF_MAX_BYTES,
) -> tuple[str, list[PdfPart], dict[str, Any]]:
    """
    MkDocsリポジトリの選択されたファイル群から：
    1. 画像リンク記法を維持し、AI指示・反映契約を含めた統合マークダウン文字列
    2. 呼び出されている全画像を1図1ページにまとめた図PDF（各 pdf_max_bytes 以下。大きければ複数ファイルに分割。画像なしは空リスト）
    3. 統計・画像対応メタ情報（stats）
    を生成して返却する。テキストの文字数上限による分割は呼び出し側（output_limits.split_text_parts）が行う。
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
# 【AIへの指示: MkDocsドキュメントおよび図PDFの参照・修正出力ルール】
本ドキュメントは、MkDocsリポジトリ（サイト名: {site_name}）の複数ファイル（設定YAMLおよびMarkdown文書）を統合したコンテキストドキュメントです。
各Markdownファイル内で呼び出されている図面・画面キャプチャ画像は、同時に添付された図PDF（1図1ページ）に収録されています。
@@PDF_PARTS_NOTE@@
## 1. 添付図PDFの照合ルール
- 本文中の `![alt](画像パス)` や `![[画像名]]` という画像リンク記法は、同時添付された図PDF内の各図面と対応しています。
- 図PDFの各ページの上部には、対応する【図番号】、所属ファイルパス、および元のリンク記法（例: `【図1】 所属: docs/index.md | リンク記法: ![全体構成図](images/architecture.png)`）が明記されています。
- 本文中の `[インラインSVG → 図PDFの【図N】に収録]` は、元のMarkdownに直接書かれていた `<svg>` を図PDFの【図N】へ移した跡です。内容は図PDFで確認してください。
- ドキュメントの内容確認・修正・追記を行う際は、本文と図PDFの該当ページを照合して回答してください。

## 2. ドキュメント修正・出力時の必須ルール（MkDocs互換性 & Spoonfeeder2自動反映）
- あなたがMarkdownファイルや `mkdocs.yml` の修正案を出力する際は、**文中の画像リンク記法（例: `![システム全体構成図](images/architecture.png)`）を勝手に削除したり別形式へ書き換えたりせず、そのままの形で維持して出力してください**。
- 上記のインラインSVG参照文を含むファイルを修正する場合は、参照文をそのまま維持して出力してください（SVG本体を勝手に生成・復元しないでください）。
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

    md_sections: list[str] = []
    images_collected: list[dict[str, Any]] = []
    images_meta: list[dict[str, Any]] = []
    seen_image_keys: set[str] = set()
    inline_svg_chars = 0
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
        if file_path.suffix.lower() == ".md":
            inline_svg_index: dict[str, int] = {}

            def _collect_inline_svg(svg_text: str, number: int, rel_path: str = rel_path) -> str | None:
                nonlocal inline_svg_chars
                if svg_text in inline_svg_index:
                    return f"[インラインSVG → 図PDFの【図{inline_svg_index[svg_text]}】に収録]"
                pil_img = render_svg_text(svg_text)
                if pil_img is None:
                    return None
                idx = len(images_collected) + 1
                label = f"インラインSVG（{number}個目）"
                inline_svg_index[svg_text] = idx
                inline_svg_chars += len(svg_text)
                images_collected.append({
                    "index": idx,
                    "doc_path": rel_path,
                    "link_text": label,
                    "resolved_path": "",
                    "image": pil_img,
                })
                images_meta.append({
                    "index": idx,
                    "doc_path": rel_path,
                    "link_text": label,
                    "resolved_path": "",
                    "inline_svg": True,
                    "width": pil_img.width,
                    "height": pil_img.height,
                })
                return f"[インラインSVG → 図PDFの【図{idx}】に収録]"

            cleaned_body = replace_inline_svgs(cleaned_body, _collect_inline_svg)
        section_text = f"""# ===== [ファイル {doc_count}/{len(chosen)}] {rel_path} =====
<file path="{html_escape(rel_path, quote=True)}">
{cleaned_body.strip()}
</file>"""
        md_sections.append(section_text)

    pdf_parts = build_pdf_parts(images_collected, max_bytes=pdf_max_bytes)
    part_total = len(pdf_parts)
    for meta in images_meta:
        meta["part"] = next(n for n, part in enumerate(pdf_parts, start=1) if part.figures[0] <= meta["index"] <= part.figures[1])

    pdf_parts_note = ""
    if part_total > 1:
        pdf_parts_note = (
            f"図PDFは容量制限のため全{part_total}ファイルに分割されています（各PDFに収録した【図】の範囲は末尾の対応一覧を参照）。"
            "分割されたPDFはすべて確認してください。\n"
        )
    md_sections.insert(0, header_rules.replace("@@PDF_PARTS_NOTE@@", pdf_parts_note).strip())

    if images_meta:
        mapping_lines = [
            "# 🖼️ 添付図PDFの対応一覧",
            "同時添付された図PDFには、以下の順序で図面が1図1ページで収録されています：",
            "",
        ]
        if part_total > 1:
            mapping_lines.append(f"図PDFは全{part_total}ファイルです（ファイル名の `_part◯of{part_total}` の番号が下記の「図PDF ◯/{part_total}」に対応）。")
            mapping_lines.extend(
                f"- 図PDF {n}/{part_total}: 【図{part.figures[0]}】〜【図{part.figures[1]}】" for n, part in enumerate(pdf_parts, start=1)
            )
            mapping_lines.append("")
        for meta in images_meta:
            where = f" | 図PDF {meta['part']}/{part_total}" if part_total > 1 else ""
            if meta.get("inline_svg"):
                mapping_lines.append(f"- **【図{meta['index']}】** 所属: `{meta['doc_path']}` | {meta['link_text']}（本文から移した `<svg>`）{where}")
                continue
            mapping_lines.append(
                f"- **【図{meta['index']}】** 所属: `{meta['doc_path']}` | リンク記法: `{meta['link_text']}` (実体: `{meta['resolved_path']}`){where}"
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
    stats: dict[str, Any] = {
        "site_name": site_name,
        "docs_dir": docs_dir,
        "total_documents": doc_count,
        "total_images": len(images_collected),
        "inline_svg_count": sum(1 for m in images_meta if m.get("inline_svg")),
        "inline_svg_chars_moved": inline_svg_chars,
        "pdf_part_count": part_total,
        "pdf_max_bytes": pdf_max_bytes,
        "pdf_sizes": [len(part.data) for part in pdf_parts],
        "markdown_chars": len(final_markdown),
        "images_meta": images_meta,
    }
    return final_markdown, pdf_parts, stats


def pdf_bytes_to_data_url(pdf_bytes: bytes | None) -> str:
    """図PDFのバイト列をプレビュー・保存用の Base64 Data URL に変換する。"""
    if not pdf_bytes:
        return ""
    return f"data:application/pdf;base64,{base64.b64encode(pdf_bytes).decode('ascii')}"
