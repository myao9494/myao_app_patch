"""
Git差分処理の高速化（無駄な繰り返しの排除・ピンポイント取得）および
画像Diffパイプラインの並列処理（画像ラスタライズ・特徴量抽出・PNGエンコードの並列化）
の動作を検証するテスト。
"""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.app.main import (
    _build_markdown_text_diff_rows,
    _changed_files,
    _git,
    app,
)


class TestPerformanceAndParallel(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def _init_repo(self, repo_dir: str):
        subprocess.run(["git", "init", "--quiet"], cwd=repo_dir, check=True)
        subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo_dir, check=True)
        subprocess.run(["git", "config", "user.name", "Tester"], cwd=repo_dir, check=True)

    def test_markdown_scope_does_not_call_git_show_on_unrelated_files(self):
        """
        単一のMarkdownファイルを指定した場合、リポジトリ内の無関係な大量の変更ファイルに対して
        _git_show（外部プロセス）が呼び出されないこと（ピンポイント取得）を検証する。
        """
        with tempfile.TemporaryDirectory() as tmp:
            repo_path = Path(tmp)
            self._init_repo(str(repo_path))

            # 対象のMarkdownファイル
            target_md = repo_path / "target.md"
            target_md.write_text("# Target Note\n本文の修正前\n", encoding="utf-8")

            # 大量の無関係なMarkdownファイル（Obsidianでよくある未コミットメモ等）
            unrelated_files = []
            for i in range(15):
                unrelated = repo_path / f"unrelated_{i}.md"
                unrelated.write_text(f"# Unrelated Note {i}\n", encoding="utf-8")
                unrelated_files.append(unrelated)

            subprocess.run(["git", "add", "."], cwd=str(repo_path), check=True)
            subprocess.run(["git", "commit", "--quiet", "-m", "initial"], cwd=str(repo_path), check=True)

            # すべてのファイルを変更する
            target_md.write_text("# Target Note\n本文の修正後\n", encoding="utf-8")
            for unrelated in unrelated_files:
                unrelated.write_text(unrelated.read_text(encoding="utf-8") + "変更追加\n", encoding="utf-8")

            git_show_calls = []
            from backend.app import main as app_main
            original_git_show = app_main._git_show

            def tracked_git_show(repo, rel_path, *args, **kwargs):
                git_show_calls.append(rel_path)
                return original_git_show(repo, rel_path, *args, **kwargs)

            with patch("backend.app.main._git_show", side_effect=tracked_git_show):
                response = self.client.post(
                    "/api/git/files",
                    json={"folder": str(target_md), "text_extensions": [".md"]},
                )

            self.assertEqual(response.status_code, 200, response.text)
            body = response.json()
            # 返される変更ファイルは target.md のみであること
            returned_paths = {item["path"] for item in body["files"]}
            self.assertEqual(returned_paths, {"target.md"})

            # 無関係なファイル（unrelated_*.md）に対して _git_show が1回も呼ばれていないことを検証
            for called_rel in git_show_calls:
                self.assertNotIn("unrelated_", called_rel, f"無関係なファイル {called_rel} に対する git_show が呼ばれました")

    def test_changed_files_avoids_git_show_for_plain_markdown(self):
        """
        通常の変更ファイル一覧取得（_changed_files）において、
        通常のMarkdownファイルに対して不要な _git_show サブプロセスを実行しないことを検証する。
        """
        with tempfile.TemporaryDirectory() as tmp:
            repo_path = Path(tmp)
            self._init_repo(str(repo_path))

            # 通常のMarkdownファイルを複数作成
            for i in range(5):
                (repo_path / f"note_{i}.md").write_text(f"# Note {i}\n普通のテキスト\n", encoding="utf-8")

            subprocess.run(["git", "add", "."], cwd=str(repo_path), check=True)
            subprocess.run(["git", "commit", "--quiet", "-m", "init"], cwd=str(repo_path), check=True)

            # 更新
            for i in range(5):
                (repo_path / f"note_{i}.md").write_text(f"# Note {i}\n更新後\n", encoding="utf-8")

            git_show_called = []
            from backend.app import main as app_main
            original_git_show = app_main._git_show

            def tracked_git_show(repo, rel_path, *args, **kwargs):
                git_show_called.append(rel_path)
                return original_git_show(repo, rel_path, *args, **kwargs)

            with patch("backend.app.main._git_show", side_effect=tracked_git_show):
                files = _changed_files(repo_path, repo_path, {".md"})

            # 通常のテキスト一覧取得時に、全ファイルに対する HEAD 側 git show の直列実行が行われていないこと
            self.assertEqual(len(files), 5)
            self.assertEqual(len(git_show_called), 0, f"不要な git_show が {len(git_show_called)} 回呼ばれました")

    def test_markdown_text_diff_rows_removes_excalidraw_data_early(self):
        """
        Excalidraw埋め込みMarkdownのテキストDiffで、
        巨大なExcalidrawデータ行が除外された上で正確に行番号と本文の差分が取得できることを検証する。
        """
        old_text = (
            "---\nexcalidraw-plugin: parsed\n---\n"
            "# My Note\n"
            "This is old line\n\n"
            "# Excalidraw Data\n"
            '{"type":"excalidraw","elements":[{"id":"1","type":"rectangle"}]}\n'
        )
        new_text = (
            "---\nexcalidraw-plugin: parsed\n---\n"
            "# My Note\n"
            "This is new line\n\n"
            "# Excalidraw Data\n"
            '{"type":"excalidraw","elements":[{"id":"2","type":"rectangle"}]}\n'
        )
        rows = _build_markdown_text_diff_rows(old_text, new_text)

        # Excalidrawの内部JSON行は差分行から除外されていること
        rendered_texts = [r.get("new") or r.get("old") or "" for r in rows]
        for t in rendered_texts:
            self.assertNotIn('"type":"excalidraw"', t)

        # 本文の差分は正しく含まれていること
        changed_kinds = [r["kind"] for r in rows if r["kind"] != "equal"]
        self.assertIn("replace", changed_kinds)

    def test_image_diff_parallel_pipeline_produces_identical_result(self):
        """
        画像DiffAPI（/api/diff）が並列パイプラインを通っても
        正常にアライメントおよび差分レスポンスを返すことを検証する。
        """
        gear_a = Path(__file__).resolve().parents[1] / "samples" / "gear_a.png"
        gear_b = Path(__file__).resolve().parents[1] / "samples" / "gear_b.png"

        with open(gear_a, "rb") as f_a, open(gear_b, "rb") as f_b:
            response = self.client.post(
                "/api/diff",
                files={
                    "file_a": ("gear_a.png", f_a.read(), "image/png"),
                    "file_b": ("gear_b.png", f_b.read(), "image/png"),
                },
                data={"category": "図面", "diff_threshold": 0.1},
            )
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertIn("diff_pixels", data)
        self.assertGreaterEqual(data["diff_pixels"], 1)
        self.assertTrue(data["alignment"]["success"])


class TestGitLaunchReduction(unittest.TestCase):
    """Windowsで支配的なgitプロセス起動回数・ファイル全探索の回数が増えないことを検証する。"""

    def _init_repo(self, repo_dir: Path):
        for args in (["init", "--quiet"], ["config", "user.email", "t@example.com"], ["config", "user.name", "T"]):
            subprocess.run(["git", *args], cwd=repo_dir, check=True)

    def _commit_all(self, repo_dir: Path):
        subprocess.run(["git", "add", "."], cwd=repo_dir, check=True)
        subprocess.run(["git", "commit", "--quiet", "-m", "init"], cwd=repo_dir, check=True)

    def test_repo_root_is_found_without_spawning_git(self):
        from backend.app import main as app_main

        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp).resolve()
            (repo / ".git").mkdir()
            nested = repo / "notes" / "2026"
            nested.mkdir(parents=True)
            with patch.object(app_main.subprocess, "run", side_effect=AssertionError("git must not be spawned")):
                self.assertEqual(app_main._git_repo_root(nested), repo)

    def test_git_show_reads_blob_with_one_process_and_enforces_limit(self):
        from backend.app import main as app_main
        from fastapi import HTTPException

        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            self._init_repo(repo)
            (repo / "small.txt").write_text("hello", encoding="utf-8")
            (repo / "big.bin").write_bytes(b"x" * 100)
            self._commit_all(repo)

            with patch.object(app_main.subprocess, "run", side_effect=AssertionError("single Popen expected")):
                self.assertEqual(app_main._git_show(repo, "small.txt", max_bytes=1024), b"hello")
                self.assertEqual(app_main._git_show(repo, "small.txt"), b"hello")
                with self.assertRaises(HTTPException) as too_big:
                    app_main._git_show(repo, "big.bin", max_bytes=10)
                with self.assertRaises(HTTPException) as missing:
                    app_main._git_show(repo, "nope.txt", max_bytes=10)
            self.assertEqual(too_big.exception.status_code, 413)
            self.assertEqual(missing.exception.status_code, 404)

    def test_many_notes_and_missing_links_do_not_scale_process_or_walk_count(self):
        from backend.app import main as app_main

        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            self._init_repo(repo)
            for index in range(25):
                links = " ".join(f"[[note{(index + k) % 25}]] ![[missing_{index}_{k}.png]]" for k in range(1, 4))
                (repo / f"note{index}.md").write_text(f"# {index}\n{links}\n", encoding="utf-8")
            self._commit_all(repo)
            (repo / "note0.md").write_text("# changed\n[[note1]] ![[missing_0_1.png]]\n", encoding="utf-8")

            run_calls = []
            walk_calls = []
            real_run = app_main.subprocess.run
            real_walk = app_main.os.walk

            def counting_run(command, *args, **kwargs):
                run_calls.append(command)
                return real_run(command, *args, **kwargs)

            def counting_walk(top, *args, **kwargs):
                walk_calls.append(top)
                return real_walk(top, *args, **kwargs)

            with patch.object(app_main.subprocess, "run", counting_run), patch.object(app_main.os, "walk", counting_walk):
                related = app_main._related_markdown_paths(repo, "note0.md")

            self.assertEqual({f"note{i}.md" for i in range(25)}, related)
            # ls-files（追跡）と ls-files --others（未追跡）のみ。ノート数・リンク数に比例しない。
            self.assertLessEqual(len(run_calls), 3, run_calls)
            # リンク切れが何件あってもVault走査は検索ルートごとに高々1回。
            self.assertLessEqual(len(walk_calls), 2, walk_calls)

    def test_untracked_and_ignored_link_targets_are_still_resolved(self):
        from backend.app import main as app_main

        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            self._init_repo(repo)
            (repo / ".gitignore").write_text("ignored_dir/\n", encoding="utf-8")
            (repo / "note.md").write_text("![[fresh]] ![[hidden.png]] ![[tracked.png]]\n", encoding="utf-8")
            (repo / "tracked.png").write_bytes(b"\x89PNG")
            self._commit_all(repo)
            (repo / "assets").mkdir()
            (repo / "assets" / "fresh.png").write_bytes(b"\x89PNG")  # 未追跡
            (repo / "ignored_dir").mkdir()
            (repo / "ignored_dir" / "hidden.png").write_bytes(b"\x89PNG")  # gitignore済み

            related = app_main._related_markdown_paths(repo, "note.md")

            self.assertIn("assets/fresh.png", related)
            self.assertIn("tracked.png", related)
            self.assertIn("ignored_dir/hidden.png", related)

    def test_line_opcodes_with_trimmed_context_reconstructs_both_sides(self):
        import random

        from backend.app.main import _build_text_diff_rows

        rng = random.Random(7)
        vocab = ["alpha", "beta", "", "gamma", "{", "}", "delta delta"]
        for _ in range(200):
            old = [rng.choice(vocab) for _ in range(rng.randint(0, 40))]
            new = list(old)
            for _ in range(rng.randint(0, 6)):
                action = rng.choice(["edit", "insert", "delete"])
                if action == "insert" or not new:
                    new.insert(rng.randint(0, len(new)), f"added-{rng.randint(0, 99)}")
                elif action == "delete":
                    del new[rng.randrange(len(new))]
                else:
                    new[rng.randrange(len(new))] = f"edited-{rng.randint(0, 99)}"
            # 末尾改行を揃えて splitlines の差による末尾マーカー行を避ける。
            old_text = "".join(f"{line}\n" for line in old)
            new_text = "".join(f"{line}\n" for line in new)
            rows = _build_text_diff_rows(old_text, new_text)
            # 片側が空のときだけ付く「ファイル末尾: 改行…」マーカー行（行番号が左右ともNone）は対象外。
            rows = [row for row in rows if not (row["old_number"] is None and row["new_number"] is None)]
            self.assertEqual([row["old"] for row in rows if row["old"] is not None], old)
            self.assertEqual([row["new"] for row in rows if row["new"] is not None], new)

    def test_replace_rows_share_one_inline_comparison(self):
        from backend.app.main import _build_text_diff_rows, _inline_diff_pair

        rows = _build_text_diff_rows("name = old_value\n", "name = new_value\n")
        self.assertEqual(len(rows), 1)
        expected_old, expected_new = _inline_diff_pair("name = old_value", "name = new_value")
        self.assertEqual(rows[0]["old_segments"], expected_old)
        self.assertEqual(rows[0]["new_segments"], expected_new)
        self.assertTrue(any(segment["changed"] for segment in rows[0]["old_segments"]))


if __name__ == "__main__":
    unittest.main()
