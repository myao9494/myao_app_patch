"""貼り付け画像の短期保存（attachments/、3日経過したものは次回保存時に削除）。"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

ATTACHMENTS_DIR = Path(__file__).resolve().parents[2] / "attachments"
RETENTION_DAYS = 3


def cleanup_expired_attachments(now: datetime | None = None) -> int:
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(days=RETENTION_DAYS)
    deleted = 0
    if not ATTACHMENTS_DIR.exists():
        return deleted

    for path in ATTACHMENTS_DIR.iterdir():
        if not path.is_file():
            continue
        modified = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)
        if modified < cutoff:
            path.unlink(missing_ok=True)
            deleted += 1
    return deleted


def save_attachment(filename: str, content: bytes) -> Path:
    ATTACHMENTS_DIR.mkdir(parents=True, exist_ok=True)
    safe_name = _safe_filename(filename)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = ATTACHMENTS_DIR / f"{timestamp}_{uuid4().hex}_{safe_name}"
    path.write_bytes(content)
    return path


def _safe_filename(filename: str) -> str:
    name = Path(filename or "clipboard.png").name
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("._")
    return name or "clipboard.png"
