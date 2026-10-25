from __future__ import annotations

import base64
import binascii
import io
import json
import math
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

WHITE = (255, 255, 255, 255)
DEFAULT_CANVAS = (1600, 1200)
MAX_UPLOAD_BYTES = 100 * 1024 * 1024
MAX_PAGE_COUNT = 60
MAX_RASTER_PIXELS = 90_000_000
MAX_TOTAL_RASTER_PIXELS = 180_000_000
LZ_STRING_BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="
SVG_DRAWIO_RASTER_SCALE = 2.5
MULTIPAGE_FORMATS = {"pdf", "tif", "tiff"}  # sniff_format の戻り値のうち、複数ページを持てる形式


@dataclass(frozen=True)
class RasterPage:
    index: int
    image: Image.Image
    warnings: tuple[str, ...] = ()


@dataclass(frozen=True)
class RasterInfo:
    index: int
    width: int
    height: int
    warnings: tuple[str, ...] = ()


class ConversionError(ValueError):
    pass


class PageRangeError(ConversionError):
    pass


def encode_png(image: Image.Image) -> str:
    buf = io.BytesIO()
    # RGB画像はそのまま保存する（convert は同じモードでも全画素をコピーするため）
    (image if image.mode == "RGB" else image.convert("RGB")).save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def decode_png(data: str) -> Image.Image:
    try:
        raw = base64.b64decode(data, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ConversionError("Image payload is not valid base64") from exc
    _validate_upload_size(raw, "rediff image")
    return _load_pil_image(raw, "rediff image")


def pil_to_cv(image: Image.Image) -> np.ndarray:
    """PIL画像 → OpenCV(BGR)。チャンネル入れ替えを cvtColor の1回で行い、余分な全画素コピーをしない。"""
    rgb = image if image.mode == "RGB" else image.convert("RGB")
    return cv2.cvtColor(np.asarray(rgb), cv2.COLOR_RGB2BGR)


def cv_to_pil(image: np.ndarray) -> Image.Image:
    """OpenCV(BGR または グレー) → PIL画像。"""
    if image.ndim == 2:
        return Image.fromarray(image)
    return Image.fromarray(cv2.cvtColor(image, cv2.COLOR_BGR2RGB))


def normalize_page_image(image: Image.Image) -> Image.Image:
    if image.mode in ("RGBA", "LA") or ("transparency" in image.info):
        rgba = image.convert("RGBA")
        bg = Image.new("RGBA", rgba.size, WHITE)
        bg.alpha_composite(rgba)
        return bg.convert("RGB")
    return image.convert("RGB")


def sniff_format(filename: str, content: bytes) -> str:
    suffix = Path(filename).suffix.lower().lstrip(".")
    head = content[:512].lstrip()
    if head.startswith(b"%PDF"):
        return "pdf"
    if head.startswith((b"<svg", b"<?xml")) and b"<svg" in head[:256]:
        return "svg"
    if suffix in {"excalidraw", "json"}:
        return "excalidraw"
    if suffix == "md" and b"excalidraw" in content[:4096].lower():
        return "excalidraw-md"
    if suffix in {"tif", "tiff"}:
        return "tiff"
    if suffix:
        return suffix
    return "unknown"


def analyze_upload(filename: str, content: bytes, dpi: int = 180) -> tuple[str, list[RasterInfo]]:
    _validate_upload_size(content, filename)
    fmt = sniff_format(filename, content)
    if fmt == "pdf":
        return fmt, _analyze_pdf(content, dpi=dpi)
    if fmt in {"tif", "tiff"}:
        return "tiff", _analyze_tiff(content)
    fmt, pages = rasterize_upload_pages(filename, content, dpi=dpi, selected_pages={0})
    return fmt, [_info_from_page(page) for page in pages]


def rasterize_upload(filename: str, content: bytes, dpi: int = 180) -> tuple[str, list[RasterPage]]:
    return rasterize_upload_pages(filename, content, dpi=dpi)


def rasterize_upload_page(filename: str, content: bytes, page: int = 0, dpi: int = 180) -> tuple[str, RasterPage]:
    fmt, pages = rasterize_upload_pages(filename, content, dpi=dpi, selected_pages={page})
    if not pages:
        raise PageRangeError(f"Page index {page} is out of range")
    return fmt, pages[0]


def rasterize_upload_pages(
    filename: str,
    content: bytes,
    dpi: int = 180,
    selected_pages: set[int] | None = None,
) -> tuple[str, list[RasterPage]]:
    _validate_upload_size(content, filename)
    selected_pages = _normalize_selected_pages(selected_pages)
    fmt = sniff_format(filename, content)
    if fmt == "pdf":
        return fmt, _rasterize_pdf(content, dpi=dpi, selected_pages=selected_pages)
    if fmt == "svg":
        _require_single_page(selected_pages)
        return fmt, [_single_page(_rasterize_svg(content, dpi=dpi))]
    if fmt in {"tif", "tiff"}:
        return "tiff", _rasterize_tiff(content, selected_pages=selected_pages)
    if fmt in {"excalidraw", "excalidraw-md"}:
        _require_single_page(selected_pages)
        image, warnings = _rasterize_excalidraw(content, markdown=(fmt == "excalidraw-md"))
        return fmt, [_single_page(image, warnings=warnings)]
    _require_single_page(selected_pages)
    return fmt, [_single_page(_load_pil_image(content, filename))]


def _single_page(image: Image.Image, warnings: tuple[str, ...] = ()) -> RasterPage:
    normalized = normalize_page_image(image)
    _validate_raster_dimensions(normalized.width, normalized.height, "image")
    return RasterPage(index=0, image=normalized, warnings=warnings)


def _analyze_pdf(content: bytes, dpi: int) -> list[RasterInfo]:
    try:
        import fitz
    except ImportError as exc:
        raise ConversionError("PyMuPDF is required for PDF conversion") from exc

    infos: list[RasterInfo] = []
    with fitz.open(stream=content, filetype="pdf") as doc:
        _validate_page_count(len(doc), "PDF")
        scale = dpi / 72
        for i, page in enumerate(doc):
            width = int(math.ceil(page.rect.width * scale))
            height = int(math.ceil(page.rect.height * scale))
            _validate_raster_dimensions(width, height, f"PDF page {i + 1}")
            infos.append(RasterInfo(index=i, width=width, height=height))
    return infos


def _rasterize_pdf(content: bytes, dpi: int, selected_pages: set[int] | None) -> list[RasterPage]:
    try:
        import fitz
    except ImportError as exc:
        raise ConversionError("PyMuPDF is required for PDF conversion") from exc

    pages: list[RasterPage] = []
    with fitz.open(stream=content, filetype="pdf") as doc:
        _validate_page_count(len(doc), "PDF")
        indices = _selected_or_all_indices(selected_pages, len(doc))
        scale = dpi / 72
        matrix = fitz.Matrix(scale, scale)
        total_pixels = 0
        for i in indices:
            page = doc[i]
            # 巨大なページを描画してから拒否するとメモリを使い切るため、描画前に寸法を検査する。
            _validate_raster_dimensions(
                int(math.ceil(page.rect.width * scale)), int(math.ceil(page.rect.height * scale)), f"PDF page {i + 1}"
            )
            pix = page.get_pixmap(matrix=matrix, alpha=True)
            _validate_raster_dimensions(pix.width, pix.height, f"PDF page {i + 1}")
            total_pixels += pix.width * pix.height
            if selected_pages is None:
                _validate_total_raster_pixels(total_pixels, "PDF")
            mode = "RGBA" if pix.alpha else "RGB"
            img = Image.frombytes(mode, [pix.width, pix.height], pix.samples)
            pages.append(RasterPage(index=i, image=normalize_page_image(img)))
    return pages


def _analyze_tiff(content: bytes) -> list[RasterInfo]:
    infos: list[RasterInfo] = []
    with Image.open(io.BytesIO(content)) as img:
        frame_count = getattr(img, "n_frames", None)
        if frame_count is not None:
            _validate_page_count(int(frame_count), "TIFF")
        i = 0
        while True:
            _validate_raster_dimensions(img.width, img.height, f"TIFF frame {i + 1}")
            infos.append(RasterInfo(index=i, width=img.width, height=img.height))
            i += 1
            try:
                img.seek(i)
            except EOFError:
                break
        _validate_page_count(len(infos), "TIFF")
    return infos


def _rasterize_tiff(content: bytes, selected_pages: set[int] | None) -> list[RasterPage]:
    pages: list[RasterPage] = []
    with Image.open(io.BytesIO(content)) as img:
        frame_count = getattr(img, "n_frames", None)
        if frame_count is not None:
            _validate_page_count(int(frame_count), "TIFF")
        selected = set(selected_pages) if selected_pages is not None else None
        total_pixels = 0
        i = 0
        while True:
            if selected is None or i in selected:
                _validate_raster_dimensions(img.width, img.height, f"TIFF frame {i + 1}")
                total_pixels += img.width * img.height
                if selected is None:
                    _validate_total_raster_pixels(total_pixels, "TIFF")
                pages.append(RasterPage(index=i, image=normalize_page_image(img.copy())))
                if selected is not None:
                    selected.discard(i)
            i += 1
            try:
                img.seek(i)
            except EOFError:
                break
        _validate_page_count(i, "TIFF")
        if selected:
            missing = min(selected)
            raise PageRangeError(f"Page index {missing} is out of range")
    return pages


def _rasterize_svg(content: bytes, dpi: int = 180) -> Image.Image:
    errors = []
    raster_content = _prepare_svg_for_rasterization(content)
    # Draw.io SVGs are usually exported at a small CSS-pixel canvas size. Keep
    # the vector source but rasterize these files at a higher scale so thin
    # lines and Japanese glyphs remain readable in the diff viewer.
    scale = _drawio_raster_scale(content, dpi=dpi) if _looks_like_drawio_svg(content) else 1.0
    try:
        import cairosvg
        png = cairosvg.svg2png(bytestring=raster_content, background_color="white", scale=scale)
        return _load_pil_image(png, "SVG")
    except Exception as exc:
        errors.append(f"CairoSVG: {exc}")

    try:
        import fitz

        with fitz.open(stream=raster_content, filetype="svg") as doc:
            if len(doc) < 1:
                raise ConversionError("SVG has no pages")
            page = doc[0]
            pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=True)
            _validate_raster_dimensions(pix.width, pix.height, "SVG")
            mode = "RGBA" if pix.alpha else "RGB"
            image = Image.frombytes(mode, [pix.width, pix.height], pix.samples)
            return normalize_page_image(image)
    except Exception as exc:
        errors.append(f"PyMuPDF: {exc}")

    raise ConversionError("Could not convert SVG. " + "; ".join(errors))


def _prepare_svg_for_rasterization(content: bytes) -> bytes:
    """Make draw.io's HTML text fallback usable by SVG rasterizers.

    draw.io exports labels as a ``foreignObject`` plus an SVG ``text`` fallback
    inside ``switch``. Rasterizers used by this backend do not consistently
    support the HTML branch and can therefore render a label as blank. Removing
    that branch lets the portable SVG fallback be selected.
    """
    try:
        root = ET.fromstring(content)
    except ET.ParseError:
        return content

    changed = _normalize_svg_light_dark_colors(root)
    for parent in root.iter():
        if _svg_local_name(parent.tag) != "switch":
            continue
        children = list(parent)
        inserted_texts: list[ET.Element] = []
        for child in children:
            if _svg_local_name(child.tag) == "foreignObject":
                replacement = _drawio_foreign_object_text(child)
                if replacement is not None:
                    parent.insert(list(parent).index(child), replacement)
                    inserted_texts.append(replacement)
                parent.remove(child)
                changed = True
        if inserted_texts:
            namespace = parent.tag.split("}", 1)[0] + "}" if "}" in parent.tag else ""
            parent.tag = f"{namespace}g"
            for child in list(parent):
                if _svg_local_name(child.tag) == "text" and child not in inserted_texts:
                    parent.remove(child)
                    changed = True

    if _normalize_svg_text_glyphs(root):
        changed = True

    if not changed:
        return content
    return ET.tostring(root, encoding="utf-8")


def _looks_like_drawio_svg(content: bytes) -> bool:
    return b"foreignObject" in content or b"drawio" in content.lower() or b"mxfile" in content.lower()


def _drawio_raster_scale(content: bytes, dpi: int = 180) -> float:
    scale = min(SVG_DRAWIO_RASTER_SCALE, max(1.0, float(dpi) / 72.0))
    try:
        root = ET.fromstring(content)
        width = _css_pixels(root.attrib.get("width"), 0.0)
        height = _css_pixels(root.attrib.get("height"), 0.0)
        if (width <= 0 or height <= 0) and root.attrib.get("viewBox"):
            parts = root.attrib["viewBox"].replace(",", " ").split()
            if len(parts) == 4:
                width, height = float(parts[2]), float(parts[3])
        source_pixels = width * height
        if source_pixels > 0:
            scale = min(scale, math.sqrt(MAX_RASTER_PIXELS / source_pixels))
    except (ET.ParseError, TypeError, ValueError, ZeroDivisionError):
        pass
    return max(1.0, scale)


def _normalize_svg_text_glyphs(root: ET.Element) -> bool:
    """Work around MuPDF's missing-glyph handling for Japanese prolonged marks.

    MuPDF's SVG text renderer silently drops U+30FC (for example, rendering
    ``メール`` as ``メル``). U+2212 has the same visible horizontal mark and is
    rendered reliably by the installed CJK fallback fonts. Keep the original
    text in an attribute for diagnostics while using the compatible glyph for
    rasterization.
    """
    changed = False
    for element in root.iter():
        if _svg_local_name(element.tag).lower() not in {"text", "tspan"} or not element.text:
            continue
        normalized = element.text.replace("ー", "−").replace("ｰ", "−")
        if normalized == element.text:
            continue
        if "data-original-text" not in element.attrib:
            element.set("data-original-text", element.text)
        element.text = normalized
        changed = True
    return changed


def _svg_local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _normalize_svg_light_dark_colors(root: ET.Element) -> bool:
    changed = False
    for element in root.iter():
        for name, value in list(element.attrib.items()):
            normalized = _replace_light_dark_css(value)
            if normalized != value:
                element.set(name, normalized)
                changed = True
    return changed


def _replace_light_dark_css(value: str) -> str:
    marker = "light-dark("
    result = value
    while marker in result:
        start = result.find(marker)
        index = start + len(marker)
        depth = 0
        comma = None
        end = None
        while index < len(result):
            char = result[index]
            if char == "(":
                depth += 1
            elif char == ")":
                if depth == 0:
                    end = index
                    break
                depth -= 1
            elif char == "," and depth == 0 and comma is None:
                comma = index
            index += 1
        if comma is None or end is None:
            break
        first_color = result[start + len(marker) : comma].strip()
        result = result[:start] + first_color + result[end + 1 :]
    return result


def _drawio_foreign_object_text(foreign_object: ET.Element) -> ET.Element | None:
    lines = _foreign_object_lines(foreign_object)
    if not any(line for line in lines):
        return None
    outer = next(iter(foreign_object), None)
    if outer is None:
        return None
    outer_style = _parse_css_style(outer.attrib.get("style", ""))
    text_element = _deepest_text_element(outer)
    text_style = _parse_css_style(text_element.attrib.get("style", "")) if text_element is not None else {}
    font_size = _css_pixels(text_style.get("font-size"), 12.0)
    line_height_value = text_style.get("line-height", "1.2")
    line_height = _css_pixels(line_height_value, font_size * 1.2)
    if line_height_value and not line_height_value.endswith("px"):
        try:
            line_height = float(line_height_value) * font_size
        except ValueError:
            pass
    margin_left = _css_pixels(outer_style.get("margin-left"), 0.0)
    padding_top = _css_pixels(outer_style.get("padding-top"), 0.0)
    width = _css_pixels(outer_style.get("width"), 0.0)
    justify = outer_style.get("justify-content", "")
    if "center" in justify:
        x = margin_left + (width / 2 if width > 1 else 0)
        anchor = "middle"
    elif "flex-end" in justify or "right" in text_style.get("text-align", ""):
        x = margin_left + width
        anchor = "end"
    else:
        x = margin_left
        anchor = "start"
    align = outer_style.get("align-items", "")
    if "center" in align:
        first_y = padding_top - ((len(lines) - 1) * line_height / 2) + font_size * 0.35
    elif "flex-end" in align:
        first_y = padding_top - ((len(lines) - 1) * line_height)
    else:
        first_y = padding_top + font_size

    svg_ns = "http://www.w3.org/2000/svg"
    text = ET.Element(f"{{{svg_ns}}}text", {
        "x": _svg_number(x),
        "y": _svg_number(first_y),
        "fill": _first_light_dark_color(text_style.get("color", "#000000")),
        "font-family": text_style.get("font-family", "Helvetica, Arial, sans-serif"),
        "font-size": _svg_number(font_size),
        "text-anchor": anchor,
    })
    for index, line in enumerate(lines):
        tspan = ET.SubElement(text, f"{{{svg_ns}}}tspan", {"x": _svg_number(x)})
        if index:
            tspan.set("dy", _svg_number(line_height))
        tspan.text = line or " "
    return text


def _foreign_object_lines(foreign_object: ET.Element) -> list[str]:
    block_tags = {"div", "p", "br"}
    lines: list[str] = []
    current: list[str] = []

    def flush() -> None:
        value = "".join(current).strip()
        if value or not lines:
            lines.append(value)
        current.clear()

    def walk(element: ET.Element, *, root: bool = False) -> None:
        name = _svg_local_name(element.tag).lower()
        is_block = not root and name in block_tags
        if is_block and current:
            flush()
        if element.text:
            current.append(element.text)
        for child in element:
            if _svg_local_name(child.tag).lower() == "br":
                flush()
            else:
                walk(child)
            if child.tail:
                current.append(child.tail)
        if is_block and current:
            flush()

    walk(foreign_object, root=True)
    if current:
        flush()
    while len(lines) > 1 and not lines[0]:
        lines.pop(0)
    return lines


def _deepest_text_element(root: ET.Element) -> ET.Element | None:
    candidates = [element for element in root.iter() if (element.text or "").strip()]
    return candidates[-1] if candidates else root


def _parse_css_style(style: str) -> dict[str, str]:
    result = {}
    for declaration in style.split(";"):
        if ":" in declaration:
            name, value = declaration.split(":", 1)
            result[name.strip().lower()] = value.strip()
    return result


def _css_pixels(value: str | None, default: float) -> float:
    if not value:
        return default
    match = re.match(r"[-+]?\d+(?:\.\d+)?", value)
    return float(match.group(0)) if match else default


def _first_light_dark_color(value: str) -> str:
    match = re.match(r"light-dark\(\s*([^,()]+)", value)
    return match.group(1).strip() if match else value


def _svg_number(value: float) -> str:
    return f"{value:.3f}".rstrip("0").rstrip(".")


def _rasterize_excalidraw(content: bytes, markdown: bool) -> tuple[Image.Image, tuple[str, ...]]:
    payload = _extract_excalidraw_json(content) if markdown else json.loads(content.decode("utf-8"))
    elements = [el for el in payload.get("elements", []) if not el.get("isDeleted")]
    app_state = payload.get("appState", {})
    warnings = _excalidraw_warnings(elements)
    bounds = _element_bounds(elements)
    if bounds:
        x0, y0, x1, y1 = bounds
        pad = 80
        width = max(1, int(np.ceil(x1 - x0 + pad * 2)))
        height = max(1, int(np.ceil(y1 - y0 + pad * 2)))
        _validate_raster_dimensions(width, height, "Excalidraw canvas")
        offset_x = pad - x0
        offset_y = pad - y0
        canvas = Image.new("RGBA", (width, height), (255, 255, 255, 0))
        drawable_elements = [_translated_element(element, offset_x, offset_y) for element in elements]
    else:
        _validate_raster_dimensions(DEFAULT_CANVAS[0], DEFAULT_CANVAS[1], "Excalidraw canvas")
        canvas = Image.new("RGBA", DEFAULT_CANVAS, (255, 255, 255, 0))
        drawable_elements = elements
    draw = ImageDraw.Draw(canvas)

    for element in drawable_elements:
        _draw_excalidraw_element(draw, element)

    bg = app_state.get("viewBackgroundColor") or "#ffffff"
    background = Image.new("RGBA", canvas.size, _hex_to_rgba(bg))
    background.alpha_composite(canvas)
    canvas = background
    return normalize_page_image(canvas), warnings


def _extract_excalidraw_json(content: bytes) -> dict:
    text = content.decode("utf-8", errors="ignore")
    compressed = re.search(r"```compressed-json\s*(.*?)\s*```", text, flags=re.S)
    if compressed:
        decoded = _decompress_lz_string_base64(compressed.group(1))
        if decoded:
            return json.loads(decoded)
    fenced = re.search(r"```json\s*(\{.*?\})\s*```", text, flags=re.S)
    if fenced:
        return json.loads(fenced.group(1))
    raw = re.search(r"(\{\s*\"type\"\s*:\s*\"excalidraw\".*\})", text, flags=re.S)
    if raw:
        return json.loads(raw.group(1))
    raise ConversionError("Could not find Excalidraw JSON in markdown")


def extract_excalidraw_json(content: bytes) -> dict:
    """Extract the Excalidraw payload from an Obsidian markdown note.

    The renderer historically kept this parser private because uploads called
    it internally. Git-backed Markdown notes also need the same parser when a
    note contains an embedded ``compressed-json`` drawing block, so expose a
    small validated entry point for that workflow.
    """
    return _extract_excalidraw_json(content)


def _decompress_lz_string_base64(value: str) -> str | None:
    compressed = "".join(value.split())
    if not compressed:
        return ""
    reverse = {char: index for index, char in enumerate(LZ_STRING_BASE64_ALPHABET)}
    try:
        return _lz_string_decompress(len(compressed), 32, lambda index: reverse[compressed[index]])
    except (IndexError, KeyError, TypeError, ValueError):
        return None


def _lz_string_decompress(length: int, reset_value: int, get_next_value) -> str | None:
    dictionary: list[str | int | None] = [0, 1, 2]
    enlarge_in = 4
    dict_size = 4
    num_bits = 3
    data_value = get_next_value(0)
    data_position = reset_value
    data_index = 1

    def read_bits(bit_count: int) -> int:
        nonlocal data_value, data_position, data_index
        bits = 0
        power = 1
        max_power = 1 << bit_count
        while power != max_power:
            result_bit = data_value & data_position
            data_position >>= 1
            if data_position == 0:
                data_position = reset_value
                data_value = get_next_value(data_index) if data_index < length else 0
                data_index += 1
            if result_bit:
                bits |= power
            power <<= 1
        return bits

    next_value = read_bits(2)
    if next_value == 0:
        char = chr(read_bits(8))
    elif next_value == 1:
        char = chr(read_bits(16))
    elif next_value == 2:
        return ""
    else:
        return None
    dictionary.append(char)
    word = char
    result = [char]

    while data_index <= length:
        code = read_bits(num_bits)
        if code == 0:
            dictionary.append(chr(read_bits(8)))
            dict_size += 1
            code = dict_size - 1
            enlarge_in -= 1
        elif code == 1:
            dictionary.append(chr(read_bits(16)))
            dict_size += 1
            code = dict_size - 1
            enlarge_in -= 1
        elif code == 2:
            return "".join(result)

        if enlarge_in == 0:
            enlarge_in = 1 << num_bits
            num_bits += 1

        if code < len(dictionary) and isinstance(dictionary[code], str):
            entry = dictionary[code]
        elif code == dict_size:
            entry = word + word[0]
        else:
            return None
        result.append(entry)
        dictionary.append(word + entry[0])
        dict_size += 1
        enlarge_in -= 1
        word = entry

        if enlarge_in == 0:
            enlarge_in = 1 << num_bits
            num_bits += 1
    return None


def _excalidraw_warnings(elements: list[dict]) -> tuple[str, ...]:
    warnings = []
    if any(element.get("type") == "image" for element in elements):
        warnings.append("Excalidraw image elements are not rendered")
    if any(abs(_float_or_zero(element.get("angle"))) > 1e-6 for element in elements):
        warnings.append("Excalidraw element rotation is approximated")
    if any(element.get("type") == "arrow" and (element.get("startArrowhead") or element.get("endArrowhead")) for element in elements):
        warnings.append("Excalidraw arrow heads are not rendered")
    if any(element.get("type") == "text" and element.get("fontSize") not in (None, 20) for element in elements):
        warnings.append("Excalidraw text styling is approximated")
    if any(element.get("opacity") not in (None, 100) for element in elements):
        warnings.append("Excalidraw opacity is approximated")
    return tuple(warnings)


def _draw_excalidraw_element(draw: ImageDraw.ImageDraw, element: dict) -> None:
    x = float(element.get("x", 0))
    y = float(element.get("y", 0))
    w = float(element.get("width", 0))
    h = float(element.get("height", 0))
    color = element.get("strokeColor") or "#000000"
    fill = element.get("backgroundColor")
    stroke = max(1, int(element.get("strokeWidth") or 1))
    kind = element.get("type")
    box = [x, y, x + w, y + h]

    fill_color = None if not fill or fill == "transparent" else _hex_to_rgba(fill)
    line_color = _hex_to_rgba(color)
    if kind in {"rectangle", "diamond"}:
        if kind == "diamond":
            pts = [(x + w / 2, y), (x + w, y + h / 2), (x + w / 2, y + h), (x, y + h / 2)]
            draw.polygon(pts, fill=fill_color, outline=line_color)
        else:
            draw.rectangle(box, fill=fill_color, outline=line_color, width=stroke)
    elif kind == "ellipse":
        draw.ellipse(box, fill=fill_color, outline=line_color, width=stroke)
    elif kind in {"line", "arrow", "freedraw"}:
        points = element.get("points") or []
        if points:
            local_points = [(float(point[0]), float(point[1])) for point in points if len(point) >= 2]
            pts = [(x + px, y + py) for px, py in _smooth_excalidraw_points(local_points)]
            draw.line(pts, fill=line_color, width=stroke, joint="curve")
    elif kind == "text":
        text = element.get("text") or ""
        font_size = max(8, int(round(_float_or_zero(element.get("fontSize")) or 20)))
        draw.multiline_text((x, y), text, fill=line_color, font=_excalidraw_font(font_size), spacing=max(4, font_size // 5))


@lru_cache(maxsize=32)
def _excalidraw_font(size: int) -> ImageFont.ImageFont:
    candidates = (
        "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "C:/Windows/Fonts/YuGothM.ttc",
        "C:/Windows/Fonts/meiryo.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    )
    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, size=size)
        except OSError:
            continue
    return ImageFont.load_default(size=size)


def _smooth_excalidraw_points(points: list[tuple[float, float]], subdivisions: int = 16) -> list[tuple[float, float]]:
    """Approximate Excalidraw/Rough.js rounded line joins with a smooth spline."""
    if len(points) < 3:
        return points
    subdivisions = max(2, int(subdivisions))
    smoothed: list[tuple[float, float]] = []
    for index in range(len(points) - 1):
        p0 = points[index - 1] if index > 0 else points[index]
        p1 = points[index]
        p2 = points[index + 1]
        p3 = points[index + 2] if index + 2 < len(points) else p2
        for step in range(subdivisions):
            t = step / subdivisions
            t2 = t * t
            t3 = t2 * t
            smoothed.append((
                0.5 * (
                    2 * p1[0]
                    + (-p0[0] + p2[0]) * t
                    + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2
                    + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3
                ),
                0.5 * (
                    2 * p1[1]
                    + (-p0[1] + p2[1]) * t
                    + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2
                    + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3
                ),
            ))
    smoothed.append(points[-1])
    return smoothed


def _translated_element(element: dict, offset_x: float, offset_y: float) -> dict:
    translated = dict(element)
    translated["x"] = float(element.get("x", 0)) + offset_x
    translated["y"] = float(element.get("y", 0)) + offset_y
    return translated


def _element_bounds(elements: list[dict]) -> tuple[float, float, float, float] | None:
    boxes = []
    for el in elements:
        x = float(el.get("x", 0))
        y = float(el.get("y", 0))
        width = float(el.get("width", 0))
        height = float(el.get("height", 0))
        points = el.get("points") or []
        if el.get("type") in {"line", "arrow", "freedraw"} and points:
            # Excalidraw stores line points relative to (x, y), and a
            # hand-drawn line may legitimately leave the element's nominal
            # rectangle (for example, a point can have a negative y). The
            # nominal width/height alone would crop that part of the drawing.
            point_xs = [x + float(point[0]) for point in points if len(point) >= 2]
            point_ys = [y + float(point[1]) for point in points if len(point) >= 2]
            if point_xs and point_ys:
                boxes.append((min(x, *point_xs), min(y, *point_ys), max(x + width, *point_xs), max(y + height, *point_ys)))
                continue
        boxes.append((x, y, x + width, y + height))
    if not boxes:
        return None
    return (
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    )


def _hex_to_rgba(value: str) -> tuple[int, int, int, int]:
    value = value.strip()
    if value.startswith("#") and len(value) in {4, 7}:
        if len(value) == 4:
            value = "#" + "".join(ch * 2 for ch in value[1:])
        return tuple(int(value[i : i + 2], 16) for i in (1, 3, 5)) + (255,)
    return (0, 0, 0, 255)


def _float_or_zero(value) -> float:
    try:
        return float(value or 0.0)
    except (TypeError, ValueError):
        return 0.0


def _info_from_page(page: RasterPage) -> RasterInfo:
    return RasterInfo(index=page.index, width=page.image.width, height=page.image.height, warnings=page.warnings)


def _load_pil_image(content: bytes, label: str) -> Image.Image:
    with Image.open(io.BytesIO(content)) as image:
        _validate_raster_dimensions(image.width, image.height, label)
        return normalize_page_image(image)


def _normalize_selected_pages(selected_pages: set[int] | None) -> set[int] | None:
    if selected_pages is None:
        return None
    normalized = {int(page) for page in selected_pages}
    if any(page < 0 for page in normalized):
        raise PageRangeError("Page index must be zero or greater")
    return normalized


def _require_single_page(selected_pages: set[int] | None) -> None:
    if selected_pages is None:
        return
    if selected_pages != {0}:
        page = min(selected_pages)
        raise PageRangeError(f"Page index {page} is out of range")


def _selected_or_all_indices(selected_pages: set[int] | None, page_count: int) -> list[int]:
    if selected_pages is None:
        return list(range(page_count))
    missing = [page for page in selected_pages if page >= page_count]
    if missing:
        raise PageRangeError(f"Page index {min(missing)} is out of range")
    return sorted(selected_pages)


def _validate_upload_size(content: bytes, label: str) -> None:
    if len(content) > MAX_UPLOAD_BYTES:
        size_mb = len(content) / (1024 * 1024)
        limit_mb = MAX_UPLOAD_BYTES / (1024 * 1024)
        raise ConversionError(f"{label} is too large ({size_mb:.1f} MB); limit is {limit_mb:.0f} MB")


def _validate_page_count(page_count: int, label: str) -> None:
    if page_count > MAX_PAGE_COUNT:
        raise ConversionError(f"{label} has {page_count} pages; limit is {MAX_PAGE_COUNT} pages")


def _validate_raster_dimensions(width: int, height: int, label: str) -> None:
    if width <= 0 or height <= 0:
        raise ConversionError(f"{label} has invalid dimensions")
    pixels = int(width) * int(height)
    if pixels > MAX_RASTER_PIXELS:
        mp = pixels / 1_000_000
        limit = MAX_RASTER_PIXELS / 1_000_000
        raise ConversionError(f"{label} is too large to rasterize ({mp:.1f} MP); limit is {limit:.0f} MP")


def _validate_total_raster_pixels(total_pixels: int, label: str) -> None:
    if total_pixels > MAX_TOTAL_RASTER_PIXELS:
        mp = total_pixels / 1_000_000
        limit = MAX_TOTAL_RASTER_PIXELS / 1_000_000
        raise ConversionError(f"{label} pages are too large to rasterize together ({mp:.1f} MP); limit is {limit:.0f} MP")
