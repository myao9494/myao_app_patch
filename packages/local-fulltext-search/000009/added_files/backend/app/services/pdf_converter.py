"""
HTMLから高精度PDFを生成するコンバーターサービス。
仕様:
- 端末にインストール済みの Chrome または Microsoft Edge を自動検出し、Playwright でヘッドレス実行する。
- 外部ブラウザの追加ダウンロード（playwright install）は不要。
- Base64画像、SVG、CSSスタイルを忠実にレンダリングし、A4サイズの高品質PDFバイナリ（bytes）を生成する。
- 空のHTMLや変換失敗時は PdfConverterError を送出する。
"""

from __future__ import annotations

import logging
from typing import Optional

logger = logging.getLogger(__name__)


class PdfConverterError(RuntimeError):
    """PDF変換処理に失敗した場合のエラー"""
    pass


def _detect_browser_channel() -> Optional[str]:
    """端末で利用可能なブラウザチャンネル（chrome, msedge, chromium 等）を検出する"""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as e:
        raise PdfConverterError(
            "Playwright がインストールされていません。pip install playwright を実行してください。"
        ) from e

    # 優先順位: chrome -> msedge -> chromium -> None (Playwright同梱)
    candidates = ["chrome", "msedge", "chromium", None]

    with sync_playwright() as p:
        for channel in candidates:
            try:
                launch_kwargs = {"headless": True}
                if channel is not None:
                    launch_kwargs["channel"] = channel
                browser = p.chromium.launch(**launch_kwargs)
                browser.close()
                return channel
            except Exception:
                continue

    return None


def convert_html_to_pdf(
    html_content: str,
    page_size: str = "A4",
    print_background: bool = True,
    margin_top: str = "12mm",
    margin_bottom: str = "12mm",
    margin_left: str = "15mm",
    margin_right: str = "15mm",
) -> bytes:
    """
    HTML文字列をPDFバイナリ（bytes）に変換する。
    
    Args:
        html_content: 変換対象の完全なHTML文字列
        page_size: PDFページサイズ（デフォルト: 'A4'）
        print_background: 背景色・グラフィックスを印刷するか（デフォルト: True）
        margin_*: 印刷マージン設定
    
    Returns:
        生成されたPDFのバイトデータ（bytes）
    
    Raises:
        PdfConverterError: HTMLが空、またはブラウザの起動・PDF生成に失敗した場合
    """
    if not html_content or not html_content.strip():
        raise PdfConverterError("HTMLコンテンツが空です")

    try:
        from playwright.sync_api import sync_playwright
    except ImportError as e:
        raise PdfConverterError(
            "Playwright がインストールされていません。pip install playwright を実行してください。"
        ) from e

    channel = _detect_browser_channel()

    try:
        with sync_playwright() as p:
            launch_kwargs = {
                "headless": True,
                "args": [
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                ],
            }
            if channel is not None:
                launch_kwargs["channel"] = channel

            browser = p.chromium.launch(**launch_kwargs)
            try:
                page = browser.new_page()

                # set_content でHTMLを流し込み、DOM構築とネットワーク待機
                page.set_content(html_content, wait_until="load", timeout=30_000)

                # Base64画像や動的SVGのレンダリング完了を確実にするため、少し待機
                try:
                    page.wait_for_load_state("networkidle", timeout=5_000)
                except Exception:
                    pass

                pdf_bytes = page.pdf(
                    format=page_size,
                    print_background=print_background,
                    margin={
                        "top": margin_top,
                        "bottom": margin_bottom,
                        "left": margin_left,
                        "right": margin_right,
                    },
                )
                return pdf_bytes
            finally:
                browser.close()
    except PdfConverterError:
        raise
    except Exception as e:
        logger.error(f"PDF generation failed: {e}", exc_info=True)
        raise PdfConverterError(f"PDF生成中にエラーが発生しました: {e}") from e
