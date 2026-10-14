"""
Obsidian ノートに埋め込まれた画像（Embedded Files）の解決と書き出し

- 読み込み時: [[リンク]] を実ファイルに解決し、画像は dataURL として files に補完する。
  Vault 外にフォルダごと移動した場合も、同じフォルダ・添付用サブフォルダから探す。
- 保存時: dataURL の画像を外部ファイルとして書き出し、Markdown にはリンクだけを残す。
"""
import base64
import json
import logging
import os
import urllib.parse
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    from .obsidian_markdown import find_vault_root, has_excalidraw_plugin_marker
    from .storage import atomic_write_bytes
except ImportError:  # backend/ をカレントにして `uvicorn main:app` で起動した場合
    from obsidian_markdown import find_vault_root, has_excalidraw_plugin_marker
    from storage import atomic_write_bytes

logger = logging.getLogger("excalidraw.obsidian_files")


IMAGE_MIME_TYPE_MAP = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "svg": "image/svg+xml",
    "webp": "image/webp",
}


SUPPORTED_IMAGE_EXTENSIONS = (
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".ico", ".md"
)
COMMON_ATTACHMENT_DIRS = (
    "attachments", "assets", "images", "img", "files", "resources", "_resources", ".attachments"
)


def resolve_embedded_file_path(
    file_path: Path,
    image_filename: str,
    vault_root: Optional[Path] = None,
) -> Path:
    """
    埋め込み画像の候補パスを順に探索する。
    - Obsidian Vault外にフォルダごと移動した場合でも、同じフォルダ直下やサブフォルダ内の画像を自動検出する。
    - URLエンコード、拡張子省略、パイプ・アンカー、大文字小文字の差異にも対応する。
    """
    # パイプやアンカーの除去・URLデコード
    clean_link = image_filename.split("|")[0].split("#")[0].strip()
    decoded_link = urllib.parse.unquote(clean_link)
    raw_basename = Path(clean_link).name
    decoded_basename = Path(decoded_link).name

    # 1. まずインデックス辞書 (image_paths.json) からパスの解決を試みる
    if vault_root is not None:
        index_file = vault_root / ".obsidian" / "plugins" / "obsidian-sidebar-explorer" / "image_paths.json"
        if index_file.exists():
            try:
                with open(index_file, "r", encoding="utf-8") as f:
                    index_data = json.load(f)
                by_obsidian_path = index_data.get("byObsidianPath", {})
                for lookup_key in (clean_link, decoded_link, raw_basename, decoded_basename):
                    resolved_path_str = by_obsidian_path.get(lookup_key)
                    if resolved_path_str:
                        resolved_path = Path(resolved_path_str)
                        if resolved_path.exists():
                            return resolved_path
            except Exception as e:
                logger.warning("Failed to resolve path using index file: %s", e)

    # 2. 探索対象ベースディレクトリ一覧
    search_dirs: List[Path] = [file_path.parent]

    # 同一フォルダ直下のよくある添付サブフォルダ
    for sub in COMMON_ATTACHMENT_DIRS:
        sub_dir = file_path.parent / sub
        if sub_dir.is_dir():
            search_dirs.append(sub_dir)

    if vault_root is not None:
        search_dirs.append(vault_root)
        for sub in COMMON_ATTACHMENT_DIRS:
            vault_sub_dir = vault_root / sub
            if vault_sub_dir.is_dir():
                search_dirs.append(vault_sub_dir)

    if file_path.parent.parent != file_path.parent:
        search_dirs.append(file_path.parent.parent)

    # 3. 探索対象の名前・パス候補（優先度順）
    name_candidates: List[str] = []
    for name in (decoded_link, clean_link, decoded_basename, raw_basename):
        if name and name not in name_candidates:
            name_candidates.append(name)

    # 4. 完全一致 / 拡張子補完探索
    for base_dir in search_dirs:
        if not base_dir.is_dir():
            continue
        for name in name_candidates:
            candidate = base_dir / name
            if candidate.is_file():
                # ディスク上の正確なケーシングの実ファイルパスを返す
                try:
                    for item in base_dir.iterdir():
                        if item.name.lower() == candidate.name.lower():
                            return item
                except OSError:
                    pass
                return candidate

            # 拡張子がない、または別の拡張子での実在確認
            if not candidate.suffix:
                for ext in SUPPORTED_IMAGE_EXTENSIONS:
                    candidate_with_ext = candidate.with_suffix(ext)
                    if candidate_with_ext.is_file():
                        try:
                            for item in base_dir.iterdir():
                                if item.name.lower() == candidate_with_ext.name.lower():
                                    return item
                        except OSError:
                            pass
                        return candidate_with_ext

    # 5. 大文字小文字（Case-insensitive）探索
    # 同一フォルダおよびそのサブフォルダ内のファイルを走査
    target_names_lower = set()
    for name in name_candidates:
        base_name = Path(name).name
        target_names_lower.add(base_name.lower())
        if not Path(name).suffix:
            for ext in SUPPORTED_IMAGE_EXTENSIONS:
                target_names_lower.add(f"{base_name.lower()}{ext.lower()}")

    for base_dir in search_dirs:
        if not base_dir.is_dir():
            continue
        try:
            for item in base_dir.iterdir():
                if item.is_file() and item.name.lower() in target_names_lower:
                    return item
        except OSError:
            continue

    # 6. 見つからない場合のフォールバックデフォルトパス
    return file_path.parent / (decoded_basename if decoded_basename else clean_link)


def build_data_url(image_path: Path, mime_type: Optional[str] = None) -> tuple[str, int]:
    """画像ファイルから data URL を生成する。"""
    resolved_mime_type = mime_type
    if not resolved_mime_type:
        ext = image_path.suffix.lower().lstrip(".")
        resolved_mime_type = IMAGE_MIME_TYPE_MAP.get(ext, "image/png")

    with open(image_path, "rb") as img_file:
        image_bytes = img_file.read()

    base64_data = base64.b64encode(image_bytes).decode("utf-8")
    data_url = f"data:{resolved_mime_type};base64,{base64_data}"
    created = int(image_path.stat().st_mtime * 1000)
    return data_url, created


def hydrate_obsidian_files(
    file_path: Path,
    data: Dict[str, Any],
    embedded_files_map: Dict[str, str],
) -> Dict[str, str]:
    """Embedded Filesを解決し、画像dataURLとMarkdownリンク先を補完する。"""
    vault_root = find_vault_root(file_path)
    embedded_file_paths: Dict[str, str] = {}
    files = data.get("files")
    if not isinstance(files, dict):
        files = {}
        data["files"] = files

    for file_id, image_filename in embedded_files_map.items():
        image_path = resolve_embedded_file_path(file_path, image_filename, vault_root)
        if image_path.exists():
            embedded_file_paths[file_id] = str(image_path)
        elif image_path.suffix.lower() == '.svg':
            # Obsidian ExcalidrawのSVGは、元Markdownノートのスナップショットとして
            # 保存されていることがある。SVG本体が削除されていても、フロントエンドが
            # 同じフォルダのparsedノートへ解決できるよう、期待パスを返しておく。
            embedded_file_paths[file_id] = str(image_path)

        file_entry = files.get(file_id)
        if isinstance(file_entry, dict) and file_entry.get("dataURL"):
            continue

        if not image_path.exists():
            logger.warning("Image file not found: %s", image_filename)
            continue

        # Markdownノートはブラウザ側でExcalidraw SVGスナップショットに変換する。
        if image_path.suffix.lower() == '.md':
            continue

        try:
            data_url, created = build_data_url(image_path)
            files[file_id] = {
                **(file_entry if isinstance(file_entry, dict) else {}),
                "mimeType": IMAGE_MIME_TYPE_MAP.get(image_path.suffix.lower().lstrip("."), "image/png"),
                "id": file_id,
                "dataURL": data_url,
                "created": created,
            }
            logger.info("Loaded image: %s", image_path)
        except Exception as e:
            logger.warning("Failed to load image %s: %s", image_filename, e)

    for file_id, file_data in list(files.items()):
        if not isinstance(file_data, dict) or file_data.get("dataURL"):
            continue

        mime_type = file_data.get("mimeType", "image/png")
        ext = mime_type.split("/")[-1] if "/" in mime_type else "png"
        image_filename = embedded_files_map.get(file_id, f"{file_id[:8]}.{ext}")
        image_path = resolve_embedded_file_path(file_path, image_filename, vault_root)

        if not image_path.exists():
            logger.warning("Image file not found: %s", image_filename)
            continue

        if image_path.suffix.lower() == '.md':
            embedded_file_paths[file_id] = str(image_path)
            continue

        try:
            data_url, created = build_data_url(image_path, mime_type)
            file_data["dataURL"] = data_url
            file_data.setdefault("created", created)
            logger.info("Loaded image: %s", image_path)
        except Exception as e:
            logger.warning("Failed to load image %s: %s", image_filename, e)

    return embedded_file_paths


def find_embedded_markdown_candidates(file_path: Path) -> List[str]:
    """同じフォルダにある、埋め込み元候補の Excalidraw Markdown を返す。"""
    candidates: List[str] = []
    try:
        for candidate in sorted(file_path.parent.glob("*.md")):
            if candidate == file_path:
                continue
            try:
                content = candidate.read_text(encoding="utf-8")
            except (OSError, UnicodeError):
                continue
            if has_excalidraw_plugin_marker(content):
                candidates.append(str(candidate))
    except OSError:
        return []
    return candidates


def _is_virtual_markdown_snapshot(file_data: Any) -> bool:
    """
    フロントエンドが Markdown ノートから生成した表示用SVGか。
    元ノートの Embedded Files リンクから再生成できるので、ディスクには書き出さない。
    （sourcePath は旧クライアント互換、フラグは候補を特定できない場合の保険）
    """
    return isinstance(file_data, dict) and (
        file_data.get("isEmbeddedMarkdownSnapshot") is True
        or str(file_data.get("sourcePath", "")).lower().endswith(".md")
    )


def _resolve_existing_link_target(file_path: Path, link: str) -> Path:
    """既存の [[リンク]] が指す保存先。リンクのフォルダが見つからなければ図面と同じフォルダ。"""
    target = file_path.parent / link
    if not target.parent.exists():
        # 図面からの相対パスでなければ、Vault ルートからの相対パスとみなす
        vault_root = find_vault_root(file_path)
        if vault_root:
            target = vault_root / link
    if not target.parent.exists():
        target = file_path.parent / os.path.basename(link)
    return target


def export_embedded_images(
    file_path: Path,
    files: Dict[str, Any],
    existing_embedded_files: Dict[str, str],
) -> Dict[str, str]:
    """
    dataURL の画像を外部ファイルとして書き出し、Embedded Files 用の
    fileId → リンク文字列 の対応を返す。

    - 既存のリンクがある画像は、リンクの文字列とファイル名を変えずに上書きする
    - 新しい画像は <図面のフォルダ>/<fileId>.<拡張子> に保存する
    - 書き出した後、files から dataURL を取り除く（Markdown を小さく保つ）
    """
    image_files_map: Dict[str, str] = {}

    for file_id, file_data in files.items():
        if file_id in existing_embedded_files:
            # dataURL を書き出さない場合もリンクは Markdown に残す
            image_files_map[file_id] = existing_embedded_files[file_id]

        if _is_virtual_markdown_snapshot(file_data):
            continue
        data_url = file_data.get("dataURL") if isinstance(file_data, dict) else None
        if not isinstance(data_url, str) or not data_url.startswith("data:"):
            continue

        try:
            header, encoded = data_url.split(",", 1)
            mime_type = header.split(":")[1].split(";")[0]
            ext = mime_type.split("/")[1]
            if ext == "svg+xml":
                ext = "svg"
            image_bytes = base64.b64decode(encoded)

            if file_id in existing_embedded_files:
                target_path = _resolve_existing_link_target(file_path, existing_embedded_files[file_id])
            else:
                filename = f"{file_id}.{ext}"
                target_path = file_path.parent / filename
                image_files_map[file_id] = filename

            atomic_write_bytes(target_path, image_bytes)
            logger.info("Saved image: %s", target_path)
        except Exception as e:
            logger.warning("Failed to save image %s: %s", file_id, e)

    for file_data in files.values():
        if isinstance(file_data, dict):
            file_data.pop("dataURL", None)

    return image_files_map
