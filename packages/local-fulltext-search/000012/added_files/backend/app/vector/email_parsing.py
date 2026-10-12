"""
メールファイル（MSG / EML / winmail.dat）の解析。
仕様:
- 件名・差出人・宛先・日時・本文（HTML / テキスト）・画像の添付を辞書で返す。
- Outlook MSG は、コードページ 1252 と記録されつつ日本語（CP932）が格納されているファイルでも文字化けしないよう、
  生ストリームからのベストエフォートデコードと文字化けスコアによる判定を行う。
- 破損したメールファイルがあっても例外を外へ出さず（None を返す）、エクスポート全体を止めない。
"""

import email
import email.policy
import html
import logging
import mimetypes
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from app.vector.email_html import sanitize_outlook_html

logger = logging.getLogger(__name__)


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
            except (AttributeError, LookupError, UnicodeError):
                logger.debug("Failed to decode an EML HTML part.", exc_info=True)
        elif content_type == "text/plain" and not body_plain:
            try:
                payload = part.get_payload(decode=True)
                charset = part.get_content_charset() or "utf-8"
                body_plain = payload.decode(charset, errors="replace")
            except (AttributeError, LookupError, UnicodeError):
                logger.debug("Failed to decode an EML text part.", exc_info=True)
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
                logger.debug("Failed to read an EML inline image part.", exc_info=True)

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
            except (UnicodeError, LookupError):
                continue
        except (UnicodeError, LookupError):
            continue

    if not candidates:
        try:
            decoded = data.decode("utf-8", errors="replace")
        except (AttributeError, UnicodeError):
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
        logger.debug("Failed to read a Unicode MSG property stream.", exc_info=True)

    # 2. ANSI stream (001E)
    try:
        a_data = get_stream(f"__substg1.0_{prop_id}001E", prefix=False)
        if not a_data:
            a_data = get_stream(f"__substg1.0_{prop_id}001E")
        if a_data:
            return decode_best_effort_text(a_data, preferred_encodings or ["cp932", "shift_jis"])
    except Exception:
        logger.debug("Failed to read an ANSI MSG property stream.", exc_info=True)

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
    except Exception:
        logger.debug("Failed to read an MSG property; trying the raw stream.", exc_info=True)

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
            logger.debug("Failed to read the MSG date.", exc_info=True)
        body_plain = _safe_read_msg_prop(msg, "body", "1000")

        # HTML本文の取得
        raw_html = None
        try:
            raw_html = getattr(msg, "htmlBody", None)
        except Exception:
            logger.debug("Failed to read the MSG HTML body property.", exc_info=True)

        if not raw_html:
            get_stream = getattr(msg, "getStream", None)
            if callable(get_stream):
                try:
                    raw_html = get_stream("__substg1.0_10130102", prefix=False) or get_stream("__substg1.0_10130102")
                except Exception:
                    logger.debug("Failed to read the MSG HTML body stream.", exc_info=True)

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
    except Exception:
        return None
    finally:
        close_fn = getattr(msg, "close", None)
        if callable(close_fn):
            try:
                close_fn()
            except Exception:
                # 読み取りは終わっているので、クローズの失敗は無視してよい
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
