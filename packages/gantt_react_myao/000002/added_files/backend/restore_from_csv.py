"""
バックアップCSVからデータベースを復元するスクリプト（最終手段の復元フロー）。

Obsidian Vault の {obsidian_home}/70_gantt_csv/ に定期保存されている
gantt_tasks.csv / gantt_links.csv を読み込み、tasks / links テーブルを丸ごと置き換える。
置き換えは1トランザクションで行うため、失敗した場合は元のデータが残る。

使い方（backend ディレクトリで実行）:
    uv run python restore_from_csv.py [obsidian_home]

obsidian_home を省略した場合は環境変数 OBSIDIAN_HOME、それもなければ既定のVaultパスを使う。
"""
import sys
from pathlib import Path

from config import default_obsidian_home
from database import SessionLocal, init_db
from services import csv_io
from services.obsidian_export import build_output_paths


def restore(obsidian_home: str | None = None) -> bool:
    """復元を実行し、成功したら True を返す。"""
    paths = build_output_paths(obsidian_home or default_obsidian_home())
    tasks_csv_path: Path = paths["task_csv_path"]
    links_csv_path: Path = paths["link_csv_path"]

    if not tasks_csv_path.exists():
        print(f"Error: {tasks_csv_path} が存在しません。")
        return False

    parsed_tasks = csv_io.parse_task_csv(tasks_csv_path.read_text(encoding="utf-8-sig"))
    # links.csv が無い場合は、リンクを空にする
    parsed_links = (
        csv_io.parse_link_csv(links_csv_path.read_text(encoding="utf-8-sig"))
        if links_csv_path.exists() else csv_io.ParsedRows()
    )

    db = SessionLocal()
    try:
        csv_io.replace_tables(db, parsed_tasks.rows, parsed_links.rows)
    except Exception as e:
        print(f"復元処理中にエラーが発生しました（データは変更していません）: {e}")
        return False
    finally:
        db.close()

    print(f"CSVから {len(parsed_tasks.rows)} 件のタスクをインポートしました。")
    print(f"CSVから {len(parsed_links.rows)} 件のリンクをインポートしました。")
    for error in [*parsed_tasks.errors, *parsed_links.errors]:
        print(f"スキップ: {error}")
    print("データベースの復元が正常に完了しました。")
    return True


if __name__ == "__main__":
    init_db()
    succeeded = restore(sys.argv[1] if len(sys.argv) > 1 else None)
    sys.exit(0 if succeeded else 1)
