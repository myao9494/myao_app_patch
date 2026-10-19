"""
AIインプット用の画像・図面（PNG / JPG / SVG / draw.io / Excalidraw）の解決とインライン化。
仕様:
- ノート内の埋め込み（`![[...]]`）やリンクが指す画像・図面を Vault 内から探索し、Base64 Data URL へ変換する。
- `.excalidraw.md` / `.excalidraw` は文書ではなく図面として扱い、キャッシュ画像（excalidraw_cache）または
  元データから生成した SVG（excalidraw_drawing）を使う。
- 画像ファイルの Data URL 化は image_data_url が行う。
- 書き出しの時間制限スコープ（app.vector.export_guard）の中では、埋め込み 1 件ごとの解決を制限時間つきで行い、
  時間切れの画像は記法をそのまま残して飛ばす。埋め込み（`![[...]]` / `![...](...)`）で見つからない画像も記録する。
  埋め込みでない `[[...]]` は通常のノートへのリンクでもあるため、見つからなくても記録しない。
"""

import functools
import html
import logging
import re
import urllib.parse
from pathlib import Path
from typing import Optional, Tuple

from app.vector.excalidraw_cache import (
    find_excalidraw_cache_dirs,
    find_excalidraw_cache_image,
    load_excalidraw_cache_indices,
)
from app.vector.excalidraw_drawing import (
    excalidraw_to_svg,
    extract_excalidraw_data,
    is_excalidraw_backed_markdown,
)
from app.vector.export_guard import SKIP_NOT_FOUND, record_skip, run_guarded
from app.vector.file_name_index import find_file_by_names
from app.vector.image_data_url import IMAGE_EXTENSIONS, file_to_base64_data_url, svg_text_to_base64_data_url

logger = logging.getLogger(__name__)


def resolve_image_or_figure_data_url(
    vault_path_str: str,
    raw_link: str,
    current_file_path: str = "",
    prefer_vector: bool = False,
) -> Tuple[Optional[str], bool]:
    """
    Markdown内の埋め込みリンク (raw_link) を解決し、Base64 Data URL と is_excalidraw フラグを返す。
    prefer_vector=True の場合、低解像度プレビューキャッシュに依存せず直接ノート内の JSON から
    最高精度の自己完結型ベクターSVGを動的生成して Data URL 化する。
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
        if cur_p.is_absolute():
            current_dir = cur_p.parent
            current_file_obj = cur_p
        else:
            cand_f, _ = resolve_document_file(vault_dir, current_file_path)
            if cand_f and cand_f.exists():
                current_dir = cand_f.parent
                current_file_obj = cand_f
            else:
                try:
                    current_dir = (vault_dir / current_file_path).parent
                except (TypeError, ValueError):
                    current_dir = vault_dir

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

    # 1-4 / 1-5. Vault 内、次に Vault 親ディレクトリの再帰探索（同名ファイル。走査結果は索引で共有する）
    if not target_file:
        file_basename = Path(clean_name).name
        recursive_names = [
            file_basename, file_basename + ".png", file_basename + ".svg",
            file_basename + ".drawio.svg", file_basename + ".excalidraw.md", file_basename + ".md",
        ]
        for search_root in (vault_dir, vault_dir.parent):
            target_file = find_file_by_names(search_root, recursive_names, hidden="skip_files")
            if target_file:
                break

    if not target_file:
        return None, False

    # 2. 対象ファイルが Excalidraw-backed markdown または .excalidraw の場合
    if is_excalidraw_backed_markdown(target_file):
        def try_generate_direct_svg() -> Optional[str]:
            try:
                note_text = target_file.read_text(encoding="utf-8", errors="replace")
                stripped_text = note_text.strip()
                if stripped_text.startswith(("<svg", "<?xml")):
                    return svg_text_to_base64_data_url(note_text)

                excalidraw_dict = extract_excalidraw_data(note_text)
                if excalidraw_dict:
                    gen_svg = excalidraw_to_svg(excalidraw_dict, vault_path=vault_dir, current_file_path=target_file)
                    return svg_text_to_base64_data_url(gen_svg)
            except Exception:
                logger.warning("Failed to render an Excalidraw note as SVG: %s", target_file, exc_info=True)
            return None

        # prefer_vector=True の場合は低解像度キャッシュより元データからの直接SVG生成を最優先
        if prefer_vector:
            direct_svg = try_generate_direct_svg()
            if direct_svg:
                return direct_svg, True

        # 2-1. .excalidraw-cache からキャッシュ画像を探す
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

        # 2-3. キャッシュ未生成時のフォールバック動的SVG生成
        if not prefer_vector:
            direct_svg = try_generate_direct_svg()
            if direct_svg:
                return direct_svg, True

        return None, True

    # 3. 通常画像またはSVG/Drawioファイルの場合
    ext = target_file.suffix.lower()
    if ext in IMAGE_EXTENSIONS or target_file.name.lower().endswith((".drawio.svg", ".dio.svg")):
        data_url = file_to_base64_data_url(target_file)
        return data_url, False

    return None, False


# 時間切れ・エラーで飛ばしたことを表す印
_SKIPPED = object()


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
    source_name = Path(current_file_path).name if current_file_path else ""

    def resolve(raw_link: str, report_missing: bool) -> Tuple[Optional[str], bool]:
        """埋め込み 1 件を制限時間つきで解決する。時間切れ・エラーは (None, False)。"""
        result = run_guarded(
            functools.partial(resolve_image_or_figure_data_url, vault_path, raw_link, current_file_path),
            kind="image",
            target=raw_link,
            source=source_name,
            default=_SKIPPED,
        )
        if result is _SKIPPED:
            return None, False
        data_url, is_excalidraw = result
        if report_missing and not data_url and not is_excalidraw:
            record_skip("image", raw_link, SKIP_NOT_FOUND, source=source_name)
        return data_url, is_excalidraw

    # 1. ![[filename|size]] 形式の置換
    def replace_wikilink_embed(match: re.Match) -> str:
        nonlocal embedded_count
        raw_link = match.group(1).strip()
        size_spec = match.group(2).strip() if match.group(2) else None

        data_url, is_excalidraw = resolve(raw_link, report_missing=True)
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

        data_url, is_excalidraw = resolve(raw_link, report_missing=True)
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

        data_url, is_excalidraw = resolve(raw_link, report_missing=False)
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

    # 5 / 6. Vault 内、次に親ディレクトリの再帰探索（同名ファイル。走査結果は索引で共有する）
    file_basename = raw_p.name
    for search_root in (vault_path, vault_path.parent):
        found = find_file_by_names(search_root, [file_basename], hidden="skip_files")
        if found is not None:
            try:
                rel = str(found.relative_to(vault_path))
            except ValueError:
                try:
                    rel = str(found.relative_to(vault_path.parent))
                except ValueError:
                    rel = file_basename
            return found, rel

    return None, path_str
