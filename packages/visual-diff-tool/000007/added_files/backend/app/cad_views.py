"""
Markdown内の3D表示（Dagnetz CAD Viewer の ```step / ```cad コードブロック）の取り出し。
- ノートに見えている3Dの絵（視点・断面・注記）を画像として比較するため、ブロックの設定を読む
- 設定の読み方はプラグインの parseStepCodeBlock に合わせる（YAML、だめなら「key: value」の行）
- リストの字下げやコールアウト（「>」）の中のブロックも、行頭の字下げと「>」を外して読む
- HEADと作業ツリーのブロックは `name:` で対応づける（pair_cad_views）。name の無いブロックは、
  名前で対応づかなかった残りと出現順で対応づける（name を付ける前のHEADとも比べられるように）
- 一覧・ジョブ・メモIDでは、ブロックを key（name、無ければ「#出現順」）で指す
"""

from __future__ import annotations

import re

import yaml

# 行頭の字下げ・「>」を含めてフェンスを探す。閉じフェンスは開きと同じ行頭のものだけを対象にする。
CAD_VIEW_FENCE_RE = re.compile(r"^(?P<prefix>[ \t>]*)```(?P<lang>step|cad)[ \t]*$", re.IGNORECASE)
DEFAULT_ANNOTATION_COLOR = "#ffc531"
SECTION_AXES = ("x", "y", "z")
# STEP 以外でブラウザーが直接読める三角形メッシュ（プラグインの OBJ / STL 読み込みと同じ）
MESH_MODEL_FORMATS = {".stl": "stl", ".obj": "obj"}


def extract_cad_views(text: str) -> list[dict]:
    """ノート本文の3D表示ブロックを、出現順に {index, key, name, lang, source, config} で返す。"""
    views = []
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        match = CAD_VIEW_FENCE_RE.match(lines[i])
        if not match:
            i += 1
            continue
        prefix = match.group("prefix")
        body = []
        i += 1
        while i < len(lines) and lines[i].rstrip() != f"{prefix}```".rstrip():
            body.append(_strip_prefix(lines[i], prefix))
            i += 1
        i += 1
        source = "\n".join(body)
        config = parse_cad_view_block(source)
        if config["path"]:
            views.append({"index": len(views), "lang": match.group("lang").lower(), "source": source, "config": config})
    _assign_keys(views)
    return views


def _assign_keys(views: list[dict]) -> None:
    """name を key にする。同じ name が重なったら2つ目以降に「 (2)」などを付けて区別する。"""
    used: set[str] = set()
    for view in views:
        name = view["config"].get("name") or ""
        base = name or f"#{view['index'] + 1}"
        key, count = base, 1
        while key in used:
            count += 1
            key = f"{base} ({count})"
        used.add(key)
        view["name"] = name
        view["key"] = key


def cad_view_summaries(text: str) -> list[dict]:
    """変更一覧のサブ項目に出す、ブロックの key・name・番号とモデルのファイル名。"""
    return [
        {"key": view["key"], "name": view["name"], "index": view["index"], "model": view["config"]["path"].split("/")[-1]}
        for view in extract_cad_views(text)
    ]


def pair_cad_views(head_views: list[dict], current_views: list[dict]) -> list[dict]:
    """HEADと作業ツリーのブロックを {head, current, paired_by} の組にする。

    1. 同じ name どうし（paired_by="name"）
    2. 残りは出現順に、どちらかに name が無いときだけ組む（paired_by="order"）。
       name が付いていて違うものは、別の3D表示として片側だけの組にする。
    """
    pairs = []
    head_named = {view["key"]: view for view in head_views if view["name"]}
    matched_heads = set()
    leftovers = []
    for view in current_views:
        head = head_named.get(view["key"]) if view["name"] else None
        if head is not None:
            pairs.append({"head": head, "current": view, "paired_by": "name"})
            matched_heads.add(id(head))
        else:
            leftovers.append(view)
    remaining_heads = [view for view in head_views if id(view) not in matched_heads]
    for view in leftovers:
        head = next((item for item in remaining_heads if not (item["name"] and view["name"])), None)
        if head is not None:
            remaining_heads.remove(head)
            pairs.append({"head": head, "current": view, "paired_by": "order"})
        else:
            pairs.append({"head": None, "current": view, "paired_by": None})
    pairs.extend({"head": view, "current": None, "paired_by": None} for view in remaining_heads)
    return pairs


def mesh_model_format(path: str) -> str | None:
    lower = path.lower()
    return next((fmt for suffix, fmt in MESH_MODEL_FORMATS.items() if lower.endswith(suffix)), None)


def _strip_prefix(line: str, prefix: str) -> str:
    if prefix and line.startswith(prefix):
        return line[len(prefix) :]
    # コールアウトの空行は「>」だけになるなど、行頭が短いことがある
    return line.lstrip(" \t>") if prefix.strip() else line


def parse_cad_view_block(source: str) -> dict:
    """プラグインの parseStepCodeBlock と同じ規則で、ブロックの設定を読む。"""
    trimmed = source.strip()
    if not trimmed:
        return {"path": ""}
    try:
        parsed = yaml.safe_load(trimmed)
    except yaml.YAMLError:
        parsed = None
    if isinstance(parsed, dict) and parsed.get("path"):
        return _config_from_yaml(parsed)
    return _config_from_lines(source)


def _config_from_yaml(parsed: dict) -> dict:
    config: dict = {"path": _strip_link(str(parsed.get("path") or ""))}
    if parsed.get("name") is not None and str(parsed["name"]).strip():
        config["name"] = str(parsed["name"]).strip()
    for key in ("width", "height"):
        value = _int_or_none(parsed.get(key))
        if value is not None:
            config[key] = value
    if parsed.get("view") is not None:
        config["view"] = str(parsed["view"])
    roll = _int_or_none(parsed.get("roll"))
    if roll is not None:
        config["roll"] = roll
    annotations = parsed.get("annotations")
    if isinstance(annotations, list):
        config["annotations"] = [_annotation(item) for item in annotations if isinstance(item, dict)]
    elif isinstance(annotations, bool):
        config["showAnnotations"] = annotations
    camera = parsed.get("camera")
    if isinstance(camera, dict) and _numbers(camera.get("position"), 3) and _numbers(camera.get("target"), 3):
        config["camera"] = {
            "position": [float(v) for v in camera["position"]],
            "target": [float(v) for v in camera["target"]],
        }
        if _is_number(camera.get("zoom")):
            config["camera"]["zoom"] = float(camera["zoom"])
        if _is_number(camera.get("viewHeight")):
            config["camera"]["viewHeight"] = float(camera["viewHeight"])
        if camera.get("perspective"):
            config["camera"]["perspective"] = True
        if _numbers(camera.get("modelPosition"), 3) and _numbers(camera.get("modelRotation"), 4):
            config["camera"]["modelPosition"] = [float(v) for v in camera["modelPosition"]]
            config["camera"]["modelRotation"] = [float(v) for v in camera["modelRotation"]]
    section = parsed.get("section")
    if isinstance(section, dict):
        axis = str(section.get("axis") or "z").lower()
        config["section"] = {
            "enabled": bool(section.get("enabled")),
            "axis": axis if axis in SECTION_AXES else "z",
            "offset": float(section["offset"]) if _is_number(section.get("offset")) else 0.5,
            "flipped": bool(section.get("flipped")),
        }
        if _numbers(section.get("point"), 3) and _numbers(section.get("tilt"), 4):
            config["section"]["point"] = [float(v) for v in section["point"]]
            config["section"]["tilt"] = [float(v) for v in section["tilt"]]
    return config


def _config_from_lines(source: str) -> dict:
    """YAMLとして読めない古い書き方（1行目にパス、または key: value の行）。"""
    config: dict = {"path": ""}
    for raw in source.split("\n"):
        line = raw.strip()
        if not line:
            continue
        match = re.match(r"^(\w+)\s*:\s*(.+)$", line)
        if match:
            key, value = match.group(1).lower(), match.group(2).strip()
            if key == "path":
                config["path"] = _strip_link(value)
            elif key in ("width", "height", "roll") and _int_or_none(value) is not None:
                config[key] = _int_or_none(value)
            elif key == "view":
                config["view"] = value
            elif key == "name":
                config["name"] = value.strip("\"'")
        elif not config["path"]:
            config["path"] = _strip_link(line)
    return config


def _annotation(item: dict) -> dict:
    annotation = {
        "id": str(item.get("id") or ""),
        "x": _float_or_zero(item.get("x")),
        "y": _float_or_zero(item.get("y")),
        "z": _float_or_zero(item.get("z")),
        "text": str(item.get("text") or ""),
        "color": str(item.get("color") or DEFAULT_ANNOTATION_COLOR),
        "leader": bool(item.get("leader")),
    }
    for key in ("textColor", "fontSize"):
        if item.get(key) not in (None, ""):
            annotation[key] = item[key]
    for key in ("ox", "oy"):
        if _is_number(item.get(key)):
            annotation[key] = float(item[key])
    return annotation


def _strip_link(value: str) -> str:
    """`[[path|別名]]` や引用符を外して、ファイルのパスだけにする。"""
    value = value.strip().strip("\"'")
    match = re.fullmatch(r"!?\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]", value)
    return (match.group(1) if match else value).strip()


def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _numbers(value, count: int) -> bool:
    return isinstance(value, list) and len(value) == count and all(_is_number(v) for v in value)


def _int_or_none(value) -> int | None:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def _float_or_zero(value) -> float:
    return float(value) if _is_number(value) else 0.0
