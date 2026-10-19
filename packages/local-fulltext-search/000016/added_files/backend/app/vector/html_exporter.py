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
- 画像・図面の解決は app.vector.figure_assets、メールは app.vector.email_links / email_parsing / email_html、
  スタイルシートは app.vector.ai_export_css に分けている。このモジュールは文書の組み立てと
  Markdown / Dataview の変換を担う。
- 処理できない項目があっても出力を優先する。ノート・リンク先ノート・画像・図面・メールは 1 件ずつ制限時間
  （既定 10 秒、item_timeout_seconds）つきで処理し、見つからない・時間切れ・エラーの項目は飛ばして
  stats["skipped_links"] に記録する（app.vector.export_guard）。時間切れの画像は記法を残し、本文の変換が
  時間切れのノートは元のテキストをそのまま載せる。
"""

import functools
import logging
import html
import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from markdown_it import MarkdownIt

from app.vector.ai_export_css import get_ai_export_css
from app.vector.email_html import render_email_to_html
from app.vector.email_links import extract_linked_email_paths
from app.vector.email_parsing import parse_email_file
from app.vector.excalidraw_drawing import (
    excalidraw_to_svg,
    extract_excalidraw_data,
    is_excalidraw_backed_markdown,
    strip_excalidraw_data,
)
from app.vector.figure_assets import (
    replace_obsidian_image_embeds,
    resolve_document_file,
    resolve_image_or_figure_data_url,
)
from app.vector.image_data_url import svg_text_to_base64_data_url

from app.vector.export_document_reader import read_export_document_text
from app.vector.export_guard import (
    DEFAULT_ITEM_TIMEOUT_SECONDS,
    SKIP_ERROR,
    SKIP_NOT_FOUND,
    export_guard_scope,
    record_skip,
    run_guarded,
)
from app.vector.export_timing import stage, timed_export
from app.vector.file_name_index import uses_file_name_index

logger = logging.getLogger(__name__)

# 時間切れ・エラーで飛ばしたことを表す印（見つからない None と区別する）
_SKIPPED = object()

# Markdownパーサーの初期化
md_parser = MarkdownIt("commonmark", {"breaks": True, "html": True}).enable("table")


def strip_frontmatter(text: str) -> str:
    """YAML Frontmatterを除去する"""
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) >= 3:
            return parts[2].lstrip()
    return text


def expand_wikilinks(text: str) -> str:
    """Obsidianの内部リンク ([[リンク先|表示名]] または [[リンク先]]) を表示名に展開する"""
    # リンク記法 [[target|alias]] -> alias
    text = re.sub(r"\[\[(?:[^\]\|]+\|)([^\]]+)\]\]", r"\1", text)
    # リンク記法 [[target]] -> target (ファイル名のみ表示)
    text = re.sub(r"\[\[([^\]]+)\]\]", r"\1", text)
    return text


def parse_js_array_or_json(js_code_str: str) -> Optional[List[Dict[str, Any]]]:
    """
    JavaScriptコード内の JSON配列 / オブジェクト配列（例: noteListRows = [...]）を安全にパースする
    """
    clean_str = js_code_str.strip()
    try:
        if clean_str.startswith("[") and clean_str.endswith("]"):
            return json.loads(clean_str)
    except ValueError:
        # 厳密な JSON でなければ、下で緩い書式（末尾カンマ・引用符なしキー）として読み直す
        pass

    try:
        # 末尾カンマの除去
        norm = re.sub(r",\s*([\]}])", r"\1", clean_str)
        # キーにクォートがない場合 {"key": ...} に補正
        norm = re.sub(r'([{,]\s*)([a-zA-Z0-9_$]+)\s*:', r'\1"\2":', norm)
        return json.loads(norm)
    except ValueError:
        # 緩い書式としても読めなければ、表ではないものとして扱う
        pass

    return None


def strip_raw_markdown_dataview(markdown_text: str) -> str:
    """マークダウン元データ（doc-raw-markdown）からすべてのdataviewjs / dataviewコードブロックを除去する"""
    if not markdown_text:
        return ""
    text = re.sub(r"```(?:dataviewjs|dataview)\b[\s\S]*?```", "", markdown_text, flags=re.IGNORECASE)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def convert_dataview_blocks_to_html(markdown_text: str, optimize_tokens: bool = True) -> str:
    """
    Markdownテキスト内の Dataview / DataviewJS テーブル定義ブロックを検出し、
    Obsidian の表示と同様の美しい HTML テーブル (<table>) に変換する。
    optimize_tokens=True の場合、展開できない生JSコードや複雑なクエリは省略注釈に置換してトークンを削減する。
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
            except (TypeError, ValueError):
                logger.debug("Failed to convert a dataview table to HTML; keeping the original text.", exc_info=True)

        if optimize_tokens:
            return '\n\n<p class="dataview-omitted-note" style="padding: 8px 14px; background: #f8fafc; border-left: 3px solid #6366f1; border-radius: 4px; font-size: 12px; color: #64748b; margin: 12px 0;">📊 <em>[DataviewJS クエリ省略 (トークン最適化)]</em></p>\n\n'

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

        if optimize_tokens:
            return '\n\n<p class="dataview-omitted-note" style="padding: 8px 14px; background: #f8fafc; border-left: 3px solid #6366f1; border-radius: 4px; font-size: 12px; color: #64748b; margin: 12px 0;">📊 <em>[Dataview クエリ省略 (トークン最適化)]</em></p>\n\n'

        return match.group(0)

    text = re.sub(r"```dataview\s*\n([\s\S]*?)\n```", replace_dataview_dql_block, text)

    return text


def render_markdown_to_clean_html(markdown_text: str, optimize_tokens: bool = True) -> str:
    """MarkdownテキストをパースしてHTMLに変換する"""
    text = strip_frontmatter(markdown_text)
    text = strip_excalidraw_data(text)
    text = convert_dataview_blocks_to_html(text, optimize_tokens=optimize_tokens)
    text = expand_wikilinks(text)
    rendered = md_parser.render(text)
    return rendered


@timed_export("AI HTMLの書き出し")
@uses_file_name_index
def export_documents_to_html(
    vault_path: str = "",
    relative_paths: Optional[List[str]] = None,
    file_paths: Optional[List[str]] = None,
    file_depths: Optional[Dict[str, int]] = None,
    excluded_file_paths: Optional[List[str]] = None,
    prompt: str = "",
    title: str = "AIコンテキスト統合ドキュメント",
    include_raw_markdown: bool = False,
    include_images: bool = True,
    include_linked_emails: bool = True,
    optimize_tokens: bool = True,
    item_timeout_seconds: float = DEFAULT_ITEM_TIMEOUT_SECONDS,
) -> Tuple[str, Dict[str, Any]]:
    """
    指定されたVault内の複数Markdownファイルを解析し、画像・図面・プロンプトを含む単一の自己完結HTMLドキュメントを生成する。
    file_paths が指定された場合は絶対パスの直接指定に対応する。
    file_depths が指定された場合は、各ノートのリンク先を階層数に応じて再帰的に展開して含める。
    excluded_file_paths が指定された場合は、該当ファイルを展開・出力から除外する。
    include_linked_emails=True の場合、Markdownからリンクされているメールファイルを自動抽出しAPPENDIXとして追加する。
    item_timeout_seconds は 1 項目（ノート・画像・メールなど）あたりの制限時間。超えた項目は飛ばして
    stats["skipped_links"] に記録する。
    """
    with export_guard_scope(item_timeout_seconds) as skipped_links:
        full_html, stats = _build_html_document(
            vault_path=vault_path,
            relative_paths=relative_paths,
            file_paths=file_paths,
            file_depths=file_depths,
            excluded_file_paths=excluded_file_paths,
            prompt=prompt,
            title=title,
            include_raw_markdown=include_raw_markdown,
            include_images=include_images,
            include_linked_emails=include_linked_emails,
            optimize_tokens=optimize_tokens,
        )
        stats["skipped_links"] = list(skipped_links)
    return full_html, stats


def _load_export_target(base_dir: Optional[Path], path_input: str) -> Optional[Dict[str, Any]]:
    """
    書き出し対象の文書を解決して本文を読む。ファイルが無ければ None。
    戻り値: v_dir（基準フォルダ）・target_file・rel_path・raw_content（変換対象外の拡張子なら None）・is_excalidraw。
    読み込みに失敗したら OSError をそのまま出す（呼び出し側の時間制限が「エラー」として記録する）。
    """
    if base_dir is None:
        resolved_input = Path(path_input).resolve()
        v_dir = resolved_input.parent
        path_str = str(resolved_input)
    else:
        v_dir = base_dir
        path_str = path_input
    target_file, resolved_rel_path = resolve_document_file(v_dir, path_str)
    if not target_file or not target_file.exists() or not target_file.is_file():
        return None
    if is_excalidraw_backed_markdown(target_file):
        try:
            raw_content: Optional[str] = target_file.read_text(encoding="utf-8", errors="replace")
        except OSError:
            raw_content = ""
        is_excalidraw = True
    else:
        raw_content = read_export_document_text(target_file)
        is_excalidraw = False
    return {
        "v_dir": v_dir,
        "target_file": target_file,
        "rel_path": resolved_rel_path,
        "raw_content": raw_content,
        "is_excalidraw": is_excalidraw,
    }


def _render_excalidraw_note_data_url(v_dir: Path, target_file: Path, raw_content: str) -> Optional[str]:
    """図面ノートを画像の Data URL にする（キャッシュ画像、無ければ元データから SVG を生成）。"""
    with stage("図面ノートの画像解決", target_file.name):
        data_url, _ = resolve_image_or_figure_data_url(str(v_dir), target_file.name, str(target_file))
    if not data_url and raw_content:
        try:
            with stage("Excalidraw図面のSVG生成", target_file.name):
                excalidraw_dict = extract_excalidraw_data(raw_content)
                if excalidraw_dict:
                    gen_svg = excalidraw_to_svg(excalidraw_dict, vault_path=v_dir, current_file_path=target_file)
                    data_url = svg_text_to_base64_data_url(gen_svg)
        except Exception:
            logger.warning("Failed to render an embedded Excalidraw note: %s", target_file, exc_info=True)
    return data_url


def _render_linked_email(em_path: Path, include_images: bool, optimize_tokens: bool) -> Optional[Tuple[Dict[str, Any], str, int]]:
    """メール 1 通を解析して本文 HTML にする。解析できなければ None。"""
    with stage("メール解析", em_path.name):
        parsed_mail = parse_email_file(em_path)
    if not parsed_mail:
        return None
    with stage("メール描画", em_path.name):
        rendered_mail_body, img_count = render_email_to_html(
            parsed_mail,
            include_images=include_images,
            optimize_tokens=optimize_tokens,
        )
    return parsed_mail, rendered_mail_body, img_count


def _build_html_document(
    vault_path: str,
    relative_paths: Optional[List[str]],
    file_paths: Optional[List[str]],
    file_depths: Optional[Dict[str, int]],
    excluded_file_paths: Optional[List[str]],
    prompt: str,
    title: str,
    include_raw_markdown: bool,
    include_images: bool,
    include_linked_emails: bool,
    optimize_tokens: bool,
) -> Tuple[str, Dict[str, Any]]:
    """export_documents_to_html の本体。時間制限スコープの中で呼ぶ。"""
    from app.vector.link_expander import expand_linked_files

    doc_sections = []
    toc_items = []
    total_images_embedded = 0
    valid_docs_count = 0
    all_linked_emails: List[Path] = []
    seen_emails: Set[str] = set()
    email_sources: Dict[str, str] = {}

    escaped_title = html.escape(title or "AIコンテキスト統合ドキュメント")
    escaped_prompt = html.escape(prompt.strip()) if prompt else ""

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

    # (基準フォルダ, パス)。基準フォルダが None のものは、読み込み時に絶対パスへ解決して親フォルダを基準にする
    targets: List[Tuple[Optional[Path], str]] = []
    if target_file_paths:
        for fp in target_file_paths:
            targets.append((None, str(fp)))
    elif relative_paths:
        base_v_dir = Path(vault_path).resolve() if vault_path else Path.cwd()
        for rp in relative_paths:
            targets.append((base_v_dir, rp))

    for idx, (base_dir, path_input) in enumerate(targets, start=1):
        loaded = run_guarded(
            functools.partial(_load_export_target, base_dir, path_input),
            kind="note",
            target=path_input,
            default=_SKIPPED,
        )
        if loaded is _SKIPPED:
            continue
        if loaded is None:
            record_skip("note", path_input, SKIP_NOT_FOUND)
            continue
        v_dir: Path = loaded["v_dir"]
        target_file: Path = loaded["target_file"]
        resolved_rel_path: str = loaded["rel_path"]
        raw_content = loaded["raw_content"]

        resolved_key = str(target_file.resolve())
        node_info = nodes_by_path.get(resolved_key)
        depth_level = node_info.get("depth_level", 0) if node_info else 0
        parent_name = node_info.get("parent_name") if node_info else None

        # 階層表示プレフィックスおよびスタイル
        is_child = depth_level > 0
        article_extra_class = " is-child" if is_child else ""
        header_title_prefix = "↳ " if is_child else ""
        parent_text = f' <span class="depth-parent-info">(リンク元: {html.escape(parent_name)})</span>' if parent_name else ""
        child_badge = f'<span class="badge depth-badge">🔗 リンク先 [階層 {depth_level}]{parent_text}</span> ' if is_child else ""

        # .excalidraw.md や Excalidraw 図面データを含むファイルの場合
        if loaded["is_excalidraw"]:
            data_url = run_guarded(
                functools.partial(_render_excalidraw_note_data_url, v_dir, target_file, raw_content),
                kind="figure",
                target=str(target_file),
                default=None,
            )

            if data_url:
                valid_docs_count += 1
                doc_title = target_file.stem
                if doc_title.endswith(".excalidraw"):
                    doc_title = doc_title[:-11]
                escaped_doc_title = html.escape(doc_title)
                escaped_rel_path = html.escape(resolved_rel_path)
                anchor_id = f"doc-{idx}"

                if is_child:
                    indent_style = f"margin-left: {depth_level * 18}px;"
                    toc_items.append(
                        f'<li class="toc-child" style="{indent_style}">↳ <span class="badge depth-badge">階層 {depth_level}</span>'
                        f'<a href="#{anchor_id}">{escaped_doc_title}</a>{parent_text} <span style="font-size: 11px; color: #94a3b8;">({escaped_rel_path})</span></li>'
                    )
                else:
                    toc_items.append(f'<li><a href="#{anchor_id}">{escaped_doc_title}</a> <span style="font-size: 11px; color: #94a3b8;">({escaped_rel_path})</span></li>')
                total_images_embedded += 1

                rendered_body = f'<p class="embedded-image-container excalidraw-export-embed"><img src="{data_url}" alt="{escaped_doc_title}" style="max-width: 100%; height: auto; border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.15); background-color: #ffffff; color-scheme: light;" /></p>'

                raw_section = ""
                if include_raw_markdown and raw_content:
                    cleaned_raw = strip_frontmatter(strip_excalidraw_data(raw_content))
                    if optimize_tokens:
                        cleaned_raw = strip_raw_markdown_dataview(cleaned_raw)
                    escaped_raw = html.escape(cleaned_raw)
                    raw_section = f"""
                    <details class="doc-raw-markdown" open>
                        <summary>📝 マークダウンファイルの元データ</summary>
                        <pre><code>{escaped_raw}</code></pre>
                    </details>
                    """

                doc_sections.append(f"""
                <article class="document-article{article_extra_class}" id="{anchor_id}">
                    <div class="document-article-header">
                        <h2>[{idx}] {header_title_prefix}{escaped_doc_title}</h2>
                        <div class="document-path-badge">{child_badge}Path: {escaped_rel_path}</div>
                    </div>
                    <div class="document-body">
                        {rendered_body}
                    </div>
                    {raw_section}
                </article>
                """)
            continue

        if raw_content is None:
            continue  # Excel など変換対象外の拡張子は出力に含めない

        valid_docs_count += 1
        doc_title = target_file.stem
        escaped_doc_title = html.escape(doc_title)
        escaped_rel_path = html.escape(resolved_rel_path)
        anchor_id = f"doc-{idx}"

        if is_child:
            indent_style = f"margin-left: {depth_level * 18}px;"
            toc_items.append(
                f'<li class="toc-child" style="{indent_style}">↳ <span class="badge depth-badge">階層 {depth_level}</span>'
                f'<a href="#{anchor_id}">{escaped_doc_title}</a>{parent_text} <span style="font-size: 11px; color: #94a3b8;">({escaped_rel_path})</span></li>'
            )
        else:
            toc_items.append(f'<li><a href="#{anchor_id}">{escaped_doc_title}</a> <span style="font-size: 11px; color: #94a3b8;">({escaped_rel_path})</span></li>')

        # リンクされたメールの検出
        if include_linked_emails:
            with stage("メールリンク探索", target_file.name):
                emails = extract_linked_email_paths(
                    raw_content, base_dir=target_file.parent, vault_path=v_dir, source=target_file.name
                )
            for em_path in emails:
                em_str = str(em_path.resolve())
                if em_str not in seen_emails:
                    seen_emails.add(em_str)
                    email_sources[em_str] = target_file.name
                    all_linked_emails.append(em_path.resolve())

        # 1. 画像・図面の置換
        processed_md = raw_content
        if include_images:
            with stage("画像・図面の埋め込み", target_file.name):
                processed_md, img_count = replace_obsidian_image_embeds(
                    content=processed_md,
                    vault_path=str(v_dir),
                    current_file_path=resolved_rel_path,
                )
            total_images_embedded += img_count

        # 2. MarkdownからHTMLへレンダリング
        with stage("Markdown→HTML変換", target_file.name):
            rendered_body = run_guarded(
                functools.partial(render_markdown_to_clean_html, processed_md, optimize_tokens=optimize_tokens),
                kind="render",
                target=str(target_file),
                default=None,
            )
        if rendered_body is None:
            # 本文の変換が終わらないノートは、元のテキストをそのまま載せる
            rendered_body = f"<pre>{html.escape(strip_frontmatter(raw_content))}</pre>"

        # 3. Raw Markdown Section
        raw_section = ""
        if include_raw_markdown:
            cleaned_raw = strip_frontmatter(strip_excalidraw_data(raw_content))
            if optimize_tokens:
                cleaned_raw = strip_raw_markdown_dataview(cleaned_raw)
            escaped_raw = html.escape(cleaned_raw)
            raw_section = f"""
            <details class="doc-raw-markdown" open>
                <summary>📝 マークダウンファイルの元データ</summary>
                <pre><code>{escaped_raw}</code></pre>
            </details>
            """

        doc_sections.append(f"""
        <article class="document-article{article_extra_class}" id="{anchor_id}">
            <div class="document-article-header">
                <h2>[{idx}] {header_title_prefix}{escaped_doc_title}</h2>
                <div class="document-path-badge">{child_badge}Path: {escaped_rel_path}</div>
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
            rendered_mail = run_guarded(
                functools.partial(_render_linked_email, em_path, include_images, optimize_tokens),
                kind="email",
                target=str(em_path),
                source=email_sources.get(str(em_path), ""),
                default=_SKIPPED,
            )
            if rendered_mail is _SKIPPED:
                continue
            if rendered_mail is None:
                record_skip("email", str(em_path), SKIP_ERROR, source=email_sources.get(str(em_path), ""), detail="メールを解析できない")
                continue
            parsed_mail, rendered_mail_body, img_count = rendered_mail
            total_linked_emails += 1
            em_anchor = f"linked-email-{e_idx}"
            mail_subject = parsed_mail.get("subject") or em_path.name
            escaped_subject = html.escape(mail_subject)
            escaped_file_name = html.escape(em_path.name)
            escaped_sender = html.escape(parsed_mail.get("sender") or "-")
            escaped_to = html.escape(parsed_mail.get("to") or "-")
            escaped_date = html.escape(parsed_mail.get("date") or "-")
            escaped_mail_path = html.escape(str(em_path))

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
        "expanded_nodes": expanded_nodes,
    }

    return full_html, stats
