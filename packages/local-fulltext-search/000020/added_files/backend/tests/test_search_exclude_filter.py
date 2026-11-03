"""
検索結果の除外判定（search_result_items.should_exclude_search_result）の単体テスト。

仕様:
- ファイル名・ステムは matches_exclude_keyword の規則で判定する（短い英数字は語の区切りで判定する）。
- フォルダ名・パス形式は exclude_rules の規則で判定する。対象フォルダより上の階層は判定しない。
- Web の URL は部分一致で判定する。
"""

import pytest

from app.services.search_result_items import should_exclude_search_result


@pytest.mark.parametrize(
    ("candidate_path", "keywords", "expected"),
    [
        ("/work/old.md", ["old"], True),
        ("/work/older.md", ["old"], False),
        ("/work/report_OLD.md", ["old"], True),
        ("/work/digital.md", ["git"], False),
        ("/work/gantt_diff_summary_v1.md", ["gantt_diff_summary"], True),
        ("/work/notes.tar.gz", ["tar"], True),
        ("/work/資料_旧版.md", ["旧"], True),
        ("/work/.git/config", [".git"], True),
        ("/work/repo/node_modules/a.js", ["node_modules"], True),
        ("/work/repo/src/a.js", ["repo/src"], True),
        ("/work/repo/lib/a.js", ["repo/src"], False),
        ("/work/a.md", [], False),
        ("/work/a.md", ["  "], False),
    ],
)
def test_local_paths(candidate_path: str, keywords: list[str], expected: bool) -> None:
    assert (
        should_exclude_search_result(target_path="/work", candidate_path=candidate_path, excluded_keywords=keywords)
        is expected
    )


def test_folders_above_the_target_are_not_checked() -> None:
    assert not should_exclude_search_result(
        target_path="/backup/work", candidate_path="/backup/work/a.md", excluded_keywords=["backup"]
    )
    assert should_exclude_search_result(target_path="", candidate_path="/backup/work/a.md", excluded_keywords=["backup"])


def test_web_urls_use_substring_match() -> None:
    assert should_exclude_search_result(
        target_path="", candidate_path="https://example.com/Login/page", excluded_keywords=["login"]
    )
    assert not should_exclude_search_result(
        target_path="", candidate_path="https://example.com/page", excluded_keywords=["login"]
    )
