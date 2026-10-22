"""
AIインプット用 マークダウンおよび図面PDFエクスポートサービス。
仕様:
1. マークダウン内の画像リンク（![[...]］等）を生のまま保持し、Obsidianコピペ互換性を保証する。
2. 最上部に「AIへの指示ルール（画像照合および出力時にリンク記法を削除・変更しないことの指示）」を埋め込む。
3. 複数ノートの境界に明確な見出しを配置する。
4. 参照されるメール（.msg / .eml）は末尾（付録）に集約し、重複を排除する。既定（include_email_recipients=False）では
   To（宛先）・CC・BCC を見出しにも本文にも含めない。True のときは見出しに宛先を出し、本文の宛先行も残す。
5. 全図面（Excalidraw, PNG, JPG等）をPillowで縦1列に連結し、上部に所属ノート名・リンク記法のヘッダー帯を描画する。
6. 図は PDF で出力する（社内AIは添付画像を勝手に圧縮するため）。図 1 枚をラベル付きで 1 ページにし、
   PNG のデータをそのまま埋め込んで画質を落とさない（app.vector.figure_pdf）。PDF が最大サイズ（既定 10MB、
   利用者が変えられる）を超えるときは図の境目で複数の PDF に分け、統合マークダウンの冒頭に PDF の数と
   各 PDF に収録した【図】の範囲を書く。テキストの20万文字による分割は保存側（api/export.py と app.vector.output_limits）が行う。
7. Excalidrawノート内の描画バイナリ・JSONデータ（# Excalidraw Data 以降）を完全除去し、AIへの無意味な圧縮テキスト出力を防止する。
"""

import logging
import base64
import io
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple, Union

from PIL import Image, ImageDraw, ImageFont

# 大量ノート・画像結合時のピクセル数制限（DecompressionBombError）を解除
Image.MAX_IMAGE_PIXELS = None

from app.vector.email_links import extract_linked_email_paths
from app.vector.email_parsing import parse_email_file
from app.vector.email_recipients import strip_email_recipient_lines
from app.vector.excalidraw_drawing import strip_excalidraw_data
from app.vector.figure_assets import resolve_image_or_figure_data_url

from app.vector.export_document_reader import read_export_document_text
from app.vector.export_timing import stage, timed_export
from app.vector.file_name_index import uses_file_name_index
from app.vector.figure_pdf import DEFAULT_FIGURE_PDF_MAX_BYTES, FigurePage, FigurePdfPart, build_figure_pdf_parts
from app.vector.output_limits import MAX_IMAGE_BYTES

logger = logging.getLogger(__name__)



def flatten_to_rgb(img: Image.Image, bg_color: Tuple[int, int, int] = (255, 255, 255)) -> Image.Image:
    """
    透過画像（RGBA, LA, Pモード等）の透明部分を白背景で自然にアルファ合成し、RGBモードの画像を返す。
    Pillowの単純な convert("RGB") による透明部の黒潰れ（黒背景化）を完全に防止する。
    """
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        alpha_img = img.convert("RGBA")
        base = Image.new("RGBA", alpha_img.size, (*bg_color, 255))
        composite = Image.alpha_composite(base, alpha_img)
        return composite.convert("RGB")
    return img.convert("RGB")



def convert_svg_to_pil_image(svg_content: Union[str, bytes]) -> Optional[Image.Image]:
    """
    SVG文字列またはバイト列をラスタライズし、PIL Image (RGBA) として返却する。
    resvg_py を最優先で使用し、cairosvg へのフォールバックも備える。
    """
    if isinstance(svg_content, str):
        svg_bytes = svg_content.encode("utf-8")
        svg_str = svg_content
    else:
        svg_bytes = svg_content
        svg_str = svg_content.decode("utf-8", errors="replace")

    # 1. resvg_py（最優先: 高速・高品質・Rust製スタンドアロン）
    try:
        import resvg_py
        png_bytes = resvg_py.svg_to_bytes(svg_str)
        if png_bytes:
            return Image.open(io.BytesIO(png_bytes))
    except Exception:
        logger.debug("resvg could not rasterize the SVG; trying the next renderer.", exc_info=True)

    # 2. cairosvg（フォールバック）
    try:
        import cairosvg
        png_bytes = cairosvg.svg2png(bytestring=svg_bytes)
        if png_bytes:
            return Image.open(io.BytesIO(png_bytes))
    except Exception:
        logger.debug("cairosvg could not rasterize the SVG.", exc_info=True)

    return None


def get_japanese_font(size: int = 20) -> ImageFont.ImageFont:
    """
    macOS / Windows / Linux の各OSにおける標準日本語フォントを自動探索してロードする。
    文字化け（□や壊れたグリフ）を防止し、美しい日本語ラベルを描画する。
    見つからない場合は安全に ImageFont.load_default() にフォールバックする。
    """
    candidate_paths = [
        # macOS
        "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc",
        "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc",
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/System/Library/Fonts/AppleSDGothicNeo.ttc",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/Library/Fonts/Arial Unicode.ttf",
        "/System/Library/Fonts/PingFang.ttc",
        # Windows
        "C:/Windows/Fonts/msgothic.ttc",
        "C:/Windows/Fonts/meiryo.ttc",
        "C:/Windows/Fonts/YuGothM.ttc",
        "C:/Windows/Fonts/YuGothR.ttc",
        "C:/Windows/Fonts/msmincho.ttc",
        # Linux
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/takao-gothic/TakaoPGothic.ttf",
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


def extract_wiki_and_md_image_links(markdown_text: str) -> List[Tuple[str, str]]:
    """
    Markdownテキスト内から画像・図面を指すリンク記法を抽出する。
    戻り値: [(元のマークダウン記法, リンク先ターゲット名), ...]
    例: [("![[明和高校.excalidraw|1475]]", "明和高校.excalidraw"), ("![alt](img.png)", "img.png")]
    """
    links: List[Tuple[str, str]] = []

    # 1. Obsidian 埋め込み: ![[filename|alias]] または ![[filename]]
    for m in re.finditer(r"!\[\[([^\]\n]+)\]\]", markdown_text):
        full_match = m.group(0)
        target = m.group(1).split("|")[0].strip()
        links.append((full_match, target))

    # 2. 標準マークダウン画像: ![alt](url)
    for m in re.finditer(r"!\[([^\]]*)\]\(([^)\n]+)\)", markdown_text):
        full_match = m.group(0)
        raw_url = m.group(2).split()[0].strip()
        if not raw_url.startswith(("http://", "https://", "data:")):
            links.append((full_match, raw_url))

    # 3. 通常のWikiLink（Excalidrawや画像へのリンク）
    for m in re.finditer(r"(?<!\!)\[\[([^\]\n]+)\]\]", markdown_text):
        full_match = m.group(0)
        target = m.group(1).split("|")[0].strip()
        lower = target.lower()
        if lower.endswith((".png", ".jpg", ".jpeg", ".svg", ".gif", ".webp", ".bmp", ".excalidraw.md", ".excalidraw", ".drawio", ".dio", ".drawio.svg")):
            links.append((full_match, target))

    return links


def build_image_strip(
    images_data: List[Dict[str, Any]],
    target_width: Optional[int] = None,
    max_bytes: int = MAX_IMAGE_BYTES,
) -> Optional[bytes]:
    """
    収集された画像リスト（PIL Image、所属ノート名、リンク記法）を上から下へ縦に連結し、
    上部に黒文字の図説明ラベルを描画した1枚の画像バイト列を生成する。
    仕様:
    - 黒背景は完全に廃止し、白背景に黒文字だけで図の説明を描画する。
    - OSの日本語フォントを自動適用し、文字化けを完全に防止する。
    - 図面の細かい文字が潰れないよう、高解像度（2800px以上）を基準幅として維持する。
    - 基準幅より小さい画像は無理に引き伸ばさず原寸鮮明度を維持し、中央揃えで配置する。
    - 4.5MB制限を確実にクリアするため、自動リサイズ・品質圧縮を行う。
    """
    if not images_data:
        return None

    # 画像の最大幅に基づき、文字が潰れない高解像度基準幅を算出（最低2800px、最大3200px）
    if target_width and target_width > 0:
        base_target_width = target_width
    else:
        max_img_w = max((item["image"].width for item in images_data), default=2800)
        base_target_width = max(2800, min(3200, max_img_w))

    header_height = 44
    gap = 28
    bg_color = (255, 255, 255)       # クリーンな白背景（黒背景廃止）
    label_text_color = (0, 0, 0)     # 黒文字のみ
    border_color = (226, 232, 240)   # 薄いグレーの区切り線

    def render_combined_canvas(scale: float) -> Image.Image:
        cur_width = max(800, int(base_target_width * scale))
        cur_header_h = max(32, int(header_height * scale))
        cur_gap = max(16, int(gap * scale))
        font_size = max(16, int(22 * scale))
        font = get_japanese_font(size=font_size)

        processed_blocks: List[Tuple[Image.Image, str]] = []
        total_height = cur_gap

        for item in images_data:
            orig_img = item["image"]
            label_text = f"【図{item['index']}】 所属: {item['note_name']}  |  リンク記法: {item['link_text']}"

            # 幅が cur_width より大きい場合のみ、アスペクト比を保って cur_width に縮小
            w, h = orig_img.size
            if w > cur_width and w > 0 and h > 0:
                new_h = max(1, int(h * (cur_width / float(w))))
                resized_img = orig_img.resize((cur_width, new_h), Image.Resampling.LANCZOS)
            else:
                # cur_width 以下の画像は無理に拡大せず、原寸の鮮明度をそのまま維持
                resized_img = orig_img

            block_h = cur_header_h + resized_img.height
            total_height += block_h + cur_gap
            processed_blocks.append((resized_img, label_text))

        # 巨大キャンバス生成（白背景）
        combined = Image.new("RGB", (cur_width + cur_gap * 2, total_height), color=bg_color)
        draw = ImageDraw.Draw(combined)

        y_offset = cur_gap
        for img, label_text in processed_blocks:
            x_offset = cur_gap

            # 1. 図の説明ラベルテキスト（黒背景なし・黒文字のみ）
            text_y = y_offset + (cur_header_h - font_size) // 2
            draw.text((x_offset + 4, text_y), label_text, fill=label_text_color, font=font)

            # ラベル下の薄い区切り線
            line_y = y_offset + cur_header_h - 2
            draw.line([(x_offset, line_y), (x_offset + cur_width, line_y)], fill=border_color, width=1)

            # 2. 画像貼り付け（原寸維持画像は中央揃え、透過PNG/SVG透明部分は白背景アルファ合成）
            img_rgb = flatten_to_rgb(img, bg_color=bg_color)
            paste_x = x_offset + max(0, (cur_width - img_rgb.width) // 2)
            combined.paste(img_rgb, (paste_x, y_offset + cur_header_h))

            y_offset += cur_header_h + img.height + cur_gap

        return combined

    # 段階的圧縮ループ（4.5MB制限の自動クリア）
    scale_steps = [1.0, 0.85, 0.70, 0.55, 0.45]
    jpeg_qualities = [92, 85, 75, 60]

    # まずスケール 1.0 で PNG を試行
    canvas = render_combined_canvas(1.0)
    buf = io.BytesIO()
    canvas.save(buf, format="PNG", optimize=True)
    png_data = buf.getvalue()
    if len(png_data) <= max_bytes:
        return png_data

    # PNG で 4.2MB を超える場合、JPEG 圧縮 & スケールダウンを試行
    for scale in scale_steps:
        if scale != 1.0:
            canvas = render_combined_canvas(scale)
        for quality in jpeg_qualities:
            buf = io.BytesIO()
            canvas.save(buf, format="JPEG", quality=quality, optimize=True)
            data = buf.getvalue()
            if len(data) <= max_bytes:
                return data

    # 最終フォールバック: さらに縮小・品質を下げて上限に収める
    data = b""
    for scale, quality in ((0.45, 65), (0.35, 50), (0.25, 35)):
        buf = io.BytesIO()
        render_combined_canvas(scale).save(buf, format="JPEG", quality=quality, optimize=True)
        data = buf.getvalue()
        if len(data) <= max_bytes:
            break
    return data


def render_figure_png(item: Dict[str, Any]) -> bytes:
    """図 1 枚を、上部にラベル（図番号・所属ノート・リンク記法）を付けた PNG にする（図面 PDF の 1 ページ分）。"""
    return build_image_strip([item], max_bytes=1 << 60) or b""


def shrink_figure_png(page: FigurePage, scale: float) -> bytes:
    """図面 PDF の 1 ページ分の PNG を、縦横 scale 倍に縮小して作り直す（1 枚で最大サイズを超えるとき用）。"""
    with Image.open(io.BytesIO(page.png)) as image:
        width = max(1, int(image.width * scale))
        height = max(1, int(image.height * scale))
        resized = image.convert("RGB").resize((width, height), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    resized.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


@timed_export("Markdown+画像の書き出し")
@uses_file_name_index
def export_documents_to_markdown_and_image(
    file_paths: List[Union[str, Path]],
    vault_path: Union[str, Path] = "",
    file_depths: Optional[Dict[str, int]] = None,
    excluded_file_paths: Optional[List[str]] = None,
    title: str = "AIコンテキスト統合ドキュメント",
    optimize_tokens: bool = True,
    include_linked_emails: bool = True,
    include_email_recipients: bool = False,
    figure_pdf_max_bytes: int = DEFAULT_FIGURE_PDF_MAX_BYTES,
) -> Tuple[str, List[FigurePdfPart], Dict[str, Any]]:
    """
    指定された複数Markdownノートを結合し、
    1. 生リンク維持・AI指示ルール付きの統合マークダウンテキスト
    2. 全図面を 1 ページ 1 図にした図面 PDF（各 figure_pdf_max_bytes 以下。大きければ複数に分割。図なしは空リスト）
    3. 統計情報
    を生成して返却する。テキストの文字数上限による分割は呼び出し側（output_limits.split_text_parts）が行う。
    file_depths が指定された場合は、各ノートのリンク先を階層数に応じて再帰的に展開して含める。
    excluded_file_paths が指定された場合は、該当ファイルを展開・出力から除外する。
    include_email_recipients=False（既定）の場合、付録のメールから宛先（To・CC・BCC）を除く。
    """
    from app.vector.link_expander import expand_linked_files

    # リンク先階層展開の適用
    target_file_paths = file_paths
    expanded_nodes: List[Dict[str, Any]] = []
    nodes_by_path: Dict[str, Dict[str, Any]] = {}

    if target_file_paths and file_depths is not None:
        with stage("リンク展開", ""):
            target_file_paths, meta = expand_linked_files(
                file_paths=target_file_paths,
                file_depths=file_depths,
                vault_path=vault_path,
                excluded_paths=excluded_file_paths,
            )
        expanded_nodes = meta.get("nodes", [])
        for n in expanded_nodes:
            try:
                p_val = n.get("full_path") or n.get("file_path")
                if p_val:
                    norm_p = str(Path(p_val).resolve())
                    nodes_by_path[norm_p] = n
            except (AttributeError, OSError, TypeError, ValueError):
                logger.debug("Failed to resolve a note path while building the export index.", exc_info=True)
    elif target_file_paths and excluded_file_paths:
        excluded_set = {str(Path(p).resolve()) for p in excluded_file_paths}
        target_file_paths = [p for p in target_file_paths if str(Path(p).resolve()) not in excluded_set]

    if vault_path and str(vault_path).strip():
        vault_dir = Path(vault_path).resolve()
    elif target_file_paths:
        try:
            common_ancestor = os.path.commonpath([str(Path(f).resolve().parent) for f in target_file_paths])
            vault_dir = Path(common_ancestor).resolve()
        except (OSError, ValueError):
            vault_dir = Path(target_file_paths[0]).resolve().parent
    else:
        vault_dir = Path.cwd()

    # 1. 最上部のAI指示ルール
    header_rules = f"""# 【AIへの指示: 添付ドキュメントおよび図面の参照・出力ルール】
本ドキュメントは、複数のマークダウンメモを統合したコンテキストドキュメント（タイトル: {title}）です。
ドキュメント内で参照されている図面・設計図・キャプチャ画像は、同時に添付された図面PDF（1ページに1図）に含まれています。
@@IMAGE_PARTS_NOTE@@
## 1. 添付図面の照合ルール
- 本文中の `![[画像名]]` や `[[画像名]]` というWikiLink記法は、添付した図面PDFの各ページの図面に対応しています。
- 図面PDFの各ページの上部には、対応する【図番号】、所属マークダウンファイル名、および元のリンク記法（例: `【図1】 所属: 〇〇.md | リンク記法: ![[△△.png]]`）が明記されています。
- テキストの解析や質問への回答を行う際は、テキストと図面PDFの該当ページを照合して回答してください。

## 2. 編集・出力時の必須ルール（Obsidian互換性維持）
- あなたがマークダウンの修正、追記、改善案などを出力する際は、**ドキュメント内の図面リンク記法（例: `![[全体アーキテクチャ.excalidraw.md]]`）を勝手に削除したり別形式に書き換えたりせず、そのままの形で文中に含めて出力してください**。
- ユーザーはこの出力をそのままObsidianへ貼り付けてノートを最新化します。

---
"""

    md_sections: List[str] = []
    images_collected: List[Dict[str, Any]] = []
    seen_image_keys: Set[str] = set()

    all_linked_emails: List[Tuple[Path, str]] = []  # (メールパス, 参照元ノート名)
    seen_email_paths: Set[str] = set()

    doc_count = 0

    for idx, f_path in enumerate(target_file_paths):
        path_obj = Path(f_path).resolve()
        if not path_obj.exists() or not path_obj.is_file():
            continue

        try:
            with stage("ノート読み込み", path_obj.name):
                raw_text = read_export_document_text(path_obj)
        except OSError:
            raw_text = ""
        if raw_text is None:
            continue  # Excel など変換対象外の拡張子は出力に含めない

        doc_count += 1
        note_name = path_obj.name

        # 画像リンクを解析・抽出
        image_links = extract_wiki_and_md_image_links(raw_text)
        for link_str, target_name in image_links:
            dedup_key = f"{note_name}::{target_name.lower()}"
            if dedup_key in seen_image_keys:
                continue

            # 画像データ解決（Excalidrawは低解像度キャッシュより元データからの直接ベクターSVGを高精細生成）
            with stage("画像・図面の解決", f"{note_name} -> {target_name}"):
                data_url, is_excalidraw = resolve_image_or_figure_data_url(
                    vault_path_str=str(vault_dir),
                    raw_link=target_name,
                    current_file_path=str(path_obj),
                    prefer_vector=True,
                )

            if data_url and data_url.startswith("data:image/"):
                try:
                    # Data URL から PIL Image を復元（SVGのラスタライズ対応）
                    header_part, b64_part = data_url.split(",", 1)
                    img_bytes = base64.b64decode(b64_part)
                    pil_img = None
                    if "image/svg+xml" in header_part or img_bytes.strip().startswith((b"<svg", b"<?xml")):
                        with stage("SVGラスタライズ", note_name):
                            pil_img = convert_svg_to_pil_image(img_bytes)
                    else:
                        pil_img = Image.open(io.BytesIO(img_bytes))

                    if pil_img is not None:
                        seen_image_keys.add(dedup_key)
                        images_collected.append({
                            "index": len(images_collected) + 1,
                            "note_name": note_name,
                            "link_text": link_str,
                            "image": pil_img,
                        })
                except Exception:
                    logger.warning("Failed to convert an embedded image for the Markdown export.", exc_info=True)

        # Excalidraw または画像ファイルそのものが選択対象だった場合
        lower_name = note_name.lower()
        if lower_name.endswith((".excalidraw", ".excalidraw.md", ".png", ".jpg", ".jpeg", ".svg", ".gif", ".webp", ".bmp")):
            dedup_key = f"{note_name}::__self__"
            if dedup_key not in seen_image_keys:
                with stage("画像・図面の解決", note_name):
                    data_url, is_excalidraw = resolve_image_or_figure_data_url(
                        vault_path_str=str(vault_dir),
                        raw_link=note_name,
                        current_file_path=str(path_obj),
                        prefer_vector=True,
                    )
                if data_url and data_url.startswith("data:image/"):
                    try:
                        header_part, b64_part = data_url.split(",", 1)
                        img_bytes = base64.b64decode(b64_part)
                        pil_img = None
                        if "image/svg+xml" in header_part or img_bytes.strip().startswith((b"<svg", b"<?xml")):
                            with stage("SVGラスタライズ", note_name):
                                pil_img = convert_svg_to_pil_image(img_bytes)
                        else:
                            pil_img = Image.open(io.BytesIO(img_bytes))
                        if pil_img is not None:
                            seen_image_keys.add(dedup_key)
                            images_collected.append({
                                "index": len(images_collected) + 1,
                                "note_name": note_name,
                                "link_text": f"![[{note_name}]]",
                                "image": pil_img,
                            })
                    except Exception:
                        logger.warning("Failed to convert an embedded image for the Markdown export.", exc_info=True)


        # メールリンクの探索
        if include_linked_emails:
            with stage("メールリンク探索", note_name):
                emails = extract_linked_email_paths(raw_text, base_dir=path_obj.parent, vault_path=vault_dir)
            for em_path in emails:
                canon_path = str(em_path.resolve()).lower()
                if canon_path not in seen_email_paths:
                    seen_email_paths.add(canon_path)
                    all_linked_emails.append((em_path, note_name))

        # 生マークダウン本文の整形（Obsidianコピペ互換性を保ちつつ、Excalidraw描画バイナリを除去し、DataviewJS生コードを注釈化）
        cleaned_body = strip_excalidraw_data(raw_text)
        if optimize_tokens:
            # 静的テーブルにできない生DataviewJSスクリプトコードは省略
            cleaned_body = re.sub(
                r"```(?:dataviewjs|dataview)\b[\s\S]*?```",
                "<!-- [DataviewJS クエリ省略 (トークン最適化)] -->",
                cleaned_body,
                flags=re.IGNORECASE,
            )

        node_info = nodes_by_path.get(str(path_obj.resolve()))
        depth_level = node_info.get("depth_level", 0) if node_info else 0
        parent_name = node_info.get("parent_name") if node_info else None

        if depth_level > 0:
            parent_label = f" (リンク元: {parent_name})" if parent_name else ""
            header_prefix = f" ↳ [階層 {depth_level}]{parent_label}"
        else:
            header_prefix = ""

        section_text = f"""
# ===== [ファイル {doc_count}/{len(target_file_paths)}]{header_prefix} {note_name} =====
{cleaned_body.strip()}
"""
        md_sections.append(section_text.strip())

    # メール付録 (APPENDIX)
    email_count = 0
    if include_linked_emails and all_linked_emails:
        appendix_note = "" if include_email_recipients else "（トークン最適化のため、宛先およびCCは除外されています）"
        email_appendix_lines = [
            "\n\n---",
            "# ✉️ 付録: 参照メール一覧 (APPENDIX)",
            f"本ドキュメント内のノートからリンクされているメール一覧です{appendix_note}。\n",
        ]

        for em_path, ref_note in all_linked_emails:
            try:
                with stage("メール解析", em_path.name):
                    email_info = parse_email_file(em_path)
            except Exception:
                email_info = None
            if not email_info:
                continue

            email_count += 1
            subj = email_info.get("subject") or "（無題）"
            sender = email_info.get("sender") or "-"
            dt = email_info.get("date") or "-"

            body_text = email_info.get("body_plain", "") or ""
            if not body_text.strip() and email_info.get("body_html"):
                # HTMLからプレーンテキスト抽出
                html_body = email_info.get("body_html", "")
                body_text = re.sub(r"<[^>]+>", " ", html_body)

            recipient_line = ""
            if include_email_recipients:
                recipient_line = f"\n- **宛先**: {email_info.get('to') or '-'}"
            else:
                body_text = strip_email_recipient_lines(body_text, is_html=False)

            email_block = f"""
### ✉️ [メール {email_count}] {subj}
- **参照元ノート**: {ref_note}
- **ファイル名**: {em_path.name}
- **差出人**: {sender}{recipient_line}
- **日時**: {dt}

```email-body
{body_text.strip()}
```
"""
            email_appendix_lines.append(email_block.strip())

        md_sections.append("\n\n".join(email_appendix_lines))

    # 図面 PDF の生成（図がある場合のみ。最大サイズを超えれば図の境目で複数に分割する）
    image_parts: List[FigurePdfPart] = []
    if images_collected:
        with stage("図面PDFの生成", f"{len(images_collected)}枚"):
            pages = [FigurePage(item["index"], render_figure_png(item)) for item in images_collected]
            image_parts = build_figure_pdf_parts(pages, max_bytes=figure_pdf_max_bytes, shrink=shrink_figure_png)
    part_total = len(image_parts)

    image_parts_note = ""
    if part_total > 1:
        range_lines = "\n".join(
            f"- 図面PDF {n}/{part_total}: 【図{part.figures[0]}】〜【図{part.figures[1]}】"
            for n, part in enumerate(image_parts, start=1)
        )
        image_parts_note = (
            f"図面PDFは容量制限のため全{part_total}個に分割されています（ファイル名の `_part◯of{part_total}` の番号が"
            f"下記の「図面PDF ◯/{part_total}」に対応）。分割された図面PDFはすべて確認してください。\n{range_lines}\n"
        )
    md_sections.insert(0, header_rules.replace("@@IMAGE_PARTS_NOTE@@", image_parts_note).strip())

    # 統合マークダウン完成
    final_markdown = "\n\n".join(md_sections)

    stats = {
        "total_documents": doc_count,
        "total_images": len(images_collected),
        "total_emails": email_count,
        "image_bytes": sum(len(part.data) for part in image_parts),
        "figure_pdf_count": part_total,
        "figure_pdf_sizes": [len(part.data) for part in image_parts],
        "markdown_chars": len(final_markdown),
        "expanded_nodes": expanded_nodes,
    }

    return final_markdown, image_parts, stats
