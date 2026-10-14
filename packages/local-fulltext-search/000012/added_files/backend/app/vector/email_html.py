"""
メール本文の HTML 整形（AIインプットのエクスポート用）。
仕様:
- Word / Outlook 由来の条件付きコメント・名前空間タグなどを除去する。
- トークン最適化時は、引用・転送ヘッダー内の Cc 行を除去する。
- 解析済みのメール（email_parsing の結果）を、ヘッダー情報つきの HTML 断片へ変換する。
"""

import base64
import html
import re
from typing import Any, Dict, Set, Tuple


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


def strip_email_cc_lines(text: str, is_html: bool = False) -> str:
    """
    メール本文（プレーンテキストまたはHTML）からCc行・Ccブロックを自動除去する。
    """
    if not text:
        return ""

    if is_html:
        # 1. <tr><th>Cc:</th><td>...</td></tr>
        cleaned = re.sub(
            r"<tr\b[^>]*>[\s\S]*?<t[hd][^>]*>[\s\S]*?(?:cc|ｃｃ)\s*[:：][\s\S]*?</t[hd]>[\s\S]*?</tr>",
            "",
            text,
            flags=re.IGNORECASE,
        )
        # 2. <p> または <div> が Cc 行単体で構成されている場合
        cleaned = re.sub(
            r"<(?:p|div)\b[^>]*>\s*<b>\s*(?:cc|ｃｃ)\s*[:：]</b>[\s\S]*?</(?:p|div)>",
            "",
            cleaned,
            flags=re.IGNORECASE,
        )
        # 3. <b>Cc:</b> ... <br> のインライン形式（後ろの <br> も巻き込んで除去）
        cleaned = re.sub(
            r"<b>\s*(?:cc|ｃｃ)\s*[:：]</b>[\s\S]*?(?:<br\s*/?>|(?=<b>|</(?:p|div|tr|td)>|$))",
            "",
            cleaned,
            flags=re.IGNORECASE,
        )
        # 4. Cc: ... <br> （<b>なし）の形式
        cleaned = re.sub(
            r"(?im)^\s*(?:cc|ｃｃ)\s*[:：][^<]*(?:<[^>]+>[^<]*)*?(?:<br\s*/?>|$)",
            "",
            cleaned,
        )
        # <br> の重複整理
        cleaned = re.sub(r"(?:<br\s*/?>\s*){3,}", "<br><br>", cleaned, flags=re.IGNORECASE)
        return cleaned

    # プレーンテキストの場合
    # "Cc: ... \n    ..." のように次行がインデントされている複数行Ccもまとめて除去
    pattern = r"(?im)^\s*(?:cc|ｃｃ)\s*[:：][^\n]*(?:\n[ \t]+[^\n]*)*\n?"
    cleaned = re.sub(pattern, "", text)
    return re.sub(r"\n{3,}", "\n\n", cleaned)


def render_email_to_html(
    parsed: Dict[str, Any],
    include_images: bool = True,
    optimize_tokens: bool = True,
) -> Tuple[str, int]:
    """
    解析済みメール情報から安全で美麗なHTML本文を生成する。
    - include_images=True の場合、CID参照画像および添付画像をBase64 Data URLにインライン置換。
    - 未配置画像は「メール内の画像」として末尾に展開。
    - include_images=False の場合、または画像なし&表なしの場合はプレーンテキスト本文を優先。
    - optimize_tokens=True の場合、本文から長大なCcヘッダー行・Ccブロックを除去してトークンを削減。
    """
    body_html = parsed.get("body_html", "") or ""
    body_plain = parsed.get("body_plain", "") or ""

    if optimize_tokens:
        if body_plain:
            body_plain = strip_email_cc_lines(body_plain, is_html=False)
        if body_html:
            body_html = strip_email_cc_lines(body_html, is_html=True)

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
