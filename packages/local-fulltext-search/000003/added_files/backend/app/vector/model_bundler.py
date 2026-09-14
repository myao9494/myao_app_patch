"""
モデルファイル分割・自動結合モジュール (model_bundler)

仕様:
- GitHubの単一ファイルサイズ制限 (100MB) およびセキュリティ制限のある会社PC (外部ダウンロード不可・Git LFS不可) に対応。
- 大規模モデルファイル (model.safetensors 等) を安全なサイズ (既定45MB) のパーツ (model.safetensors.part00, part01...) に分割 (split)。
- アプリケーション起動時およびモデルロード時に、分割パーツから自動で元のバイナリファイルをバイナリ結合・復元 (reassemble)。
- 既に結合済みファイルが存在する場合は二重実行をスキップし、高速に復帰。
- CLI からの直接実行 (python -m app.vector.model_bundler [split|reconstruct]) にも対応。
"""

from __future__ import annotations

import glob
import logging
from pathlib import Path
import sys
from typing import List, Optional

logger = logging.getLogger(__name__)

# 既定のチャンクサイズ: 45MB (GitHub 100MB 制限および 50MB 警告を余裕をもってクリア)
DEFAULT_CHUNK_SIZE_BYTES = 45 * 1024 * 1024


def split_file_into_chunks(
    source_file: Path,
    chunk_size_bytes: int = DEFAULT_CHUNK_SIZE_BYTES,
) -> List[Path]:
    """
    指定されたバイナリファイルを chunk_size_bytes ごとの分割ファイル (*.part00, *.part01...) に分割する。
    戻り値: 生成された分割ファイルパスのリスト
    """
    source_p = Path(source_file).resolve()
    if not source_p.exists() or not source_p.is_file():
        raise FileNotFoundError(f"分割対象ファイルが存在しません: {source_p}")

    part_files: List[Path] = []
    buffer_size = 1024 * 1024 * 8  # 8MB 読み込みバッファ
    part_index = 0

    with open(source_p, "rb") as in_f:
        while True:
            first_chunk = in_f.read(min(buffer_size, chunk_size_bytes))
            if not first_chunk:
                break

            part_name = f"{source_p.name}.part{part_index:02d}"
            part_path = source_p.parent / part_name

            with open(part_path, "wb") as out_f:
                out_f.write(first_chunk)
                bytes_written = len(first_chunk)

                while bytes_written < chunk_size_bytes:
                    to_read = min(buffer_size, chunk_size_bytes - bytes_written)
                    chunk = in_f.read(to_read)
                    if not chunk:
                        break
                    out_f.write(chunk)
                    bytes_written += len(chunk)

            part_files.append(part_path)
            part_index += 1

    logger.info("ファイル分割完了: %s -> %d parts", source_p.name, len(part_files))
    return part_files


def reassemble_chunks_into_file(
    output_file: Path,
    chunk_files: Optional[List[Path]] = None,
) -> Path:
    """
    分割されたパーツファイル (*.part*) を順番にバイナリ結合して output_file を復元する。
    """
    out_p = Path(output_file).resolve()

    if chunk_files is None:
        pattern = str(out_p.parent / f"{out_p.name}.part*")
        found = [Path(p) for p in glob.glob(pattern)]
        chunk_files = sorted(found, key=lambda p: p.name)

    if not chunk_files:
        raise FileNotFoundError(f"結合対象のパーツファイルが見つかりません: {out_p.name}.part*")

    logger.info("分割パーツを結合中: %s (%d parts)", out_p.name, len(chunk_files))
    buffer_size = 1024 * 1024 * 8  # 8MB バッファ

    # 一時ファイルに書き出してからアトミックに置換
    temp_output = out_p.with_suffix(".tmp_reassemble")
    try:
        with open(temp_output, "wb") as out_f:
            for part in chunk_files:
                with open(part, "rb") as in_f:
                    while chunk := in_f.read(buffer_size):
                        out_f.write(chunk)
        temp_output.replace(out_p)
    finally:
        if temp_output.exists():
            temp_output.unlink(missing_ok=True)

    logger.info("ファイルの結合・復元完了: %s", out_p)
    return out_p


def ensure_model_files(model_dir: Path | str) -> Path:
    """
    モデルディレクトリ内に model.safetensors が存在するか確認し、
    未存在で分割パーツ (model.safetensors.part*) がある場合は自動結合して復元する。
    戻り値: model.safetensors のパス
    """
    dir_p = Path(model_dir).resolve()
    target_safetensors = dir_p / "model.safetensors"

    if target_safetensors.exists() and target_safetensors.stat().st_size > 0:
        return target_safetensors

    parts = sorted(dir_p.glob("model.safetensors.part*"), key=lambda p: p.name)
    if parts:
        logger.info("モデル safetensors が見つからないため分割パーツから自動復元します: %s", dir_p.name)
        reassemble_chunks_into_file(target_safetensors, parts)
        return target_safetensors

    # 分割パーツもない場合は target_safetensors (未存在のまま) を返す
    return target_safetensors


def reconstruct_all_models(models_root: Path | str) -> None:
    """
    指定された models ルート配下の全モデルディレクトリを走査し、
    未結合の分割パーツがあれば一括復元する。
    """
    root_p = Path(models_root).resolve()
    if not root_p.exists():
        return

    for item in root_p.iterdir():
        if item.is_dir():
            ensure_model_files(item)


if __name__ == "__main__":
    # CLI サポート
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print("Usage:")
        print("  python -m app.vector.model_bundler split <file_or_dir>")
        print("  python -m app.vector.model_bundler reconstruct <dir_or_models_root>")
        sys.exit(0)

    cmd = args[0]
    target = Path(args[1]) if len(args) > 1 else Path.cwd()

    if cmd == "split":
        if target.is_file():
            split_file_into_chunks(target)
        elif target.is_dir():
            sf = target / "model.safetensors"
            if sf.exists():
                split_file_into_chunks(sf)
            else:
                for sub in target.iterdir():
                    sub_sf = sub / "model.safetensors"
                    if sub_sf.exists():
                        split_file_into_chunks(sub_sf)
    elif cmd == "reconstruct":
        if target.is_dir():
            if (target / "model.safetensors.part00").exists() or (target / "model.safetensors.part0").exists():
                ensure_model_files(target)
            else:
                reconstruct_all_models(target)
