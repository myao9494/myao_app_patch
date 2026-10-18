"""
AIインプット書き出しで、対象文書の本文テキストを読む部品。

仕様:
- 変換対象は次の拡張子だけ。
  - Markdown / テキスト（.md / .markdown / .txt）: UTF-8 で読み、読めなければ CP932 で読む。
  - Word / PowerPoint（.docx / .pptx）: 本文テキストを抽出する（段落・表・スライドの文字）。壊れていれば空文字。
- Excel・PDF・画像・メール・その他の拡張子は変換対象外（None を返し、呼び出し側は文書ごと読み飛ばす）。
  バイナリを Markdown 変換へ流すと文字化けするうえ極端に遅いため。
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

from app.extractors.text_extractor import extract_text

logger = logging.getLogger(__name__)

_PLAIN_TEXT_EXTENSIONS = frozenset({".md", ".markdown", ".txt"})
_OFFICE_EXTENSIONS = frozenset({".docx", ".pptx"})


def read_export_document_text(path: Path) -> Optional[str]:
    """書き出し対象の文書を読んで本文を返す。変換対象外の拡張子なら None。"""
    suffix = path.suffix.lower()
    if suffix in _PLAIN_TEXT_EXTENSIONS:
        try:
            return path.read_text(encoding="utf-8")
        except UnicodeError:
            return path.read_text(encoding="cp932", errors="replace")
    if suffix in _OFFICE_EXTENSIONS:
        try:
            return extract_text(path)
        except Exception:
            logger.warning("Failed to extract text from %s", path, exc_info=True)
            return ""
    return None
