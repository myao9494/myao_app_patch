"""
Git差分処理の高速化（無駄な繰り返しの排除・ピンポイント取得）および
画像Diffパイプラインの並列処理（画像ラスタライズ・特徴量抽出・PNGエンコードの並列化）
の動作を検証するテスト。
"""

import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.app.git_repo import changed_files
from backend.app.main import app
from backend.app.text_diff import build_markdown_text_diff_rows


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
            from backend.app import git_repo
            original_git_show = git_repo.git_show

            def tracked_git_show(repo, rel_path, *args, **kwargs):
                git_show_calls.append(rel_path)
                return original_git_show(repo, rel_path, *args, **kwargs)

            with patch("backend.app.git_repo.git_show", side_effect=tracked_git_show):
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
        通常の変更ファイル一覧取得（changed_files）において、
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
            from backend.app import git_repo
            original_git_show = git_repo.git_show

            def tracked_git_show(repo, rel_path, *args, **kwargs):
                git_show_called.append(rel_path)
                return original_git_show(repo, rel_path, *args, **kwargs)

            with patch("backend.app.git_repo.git_show", side_effect=tracked_git_show):
                files = changed_files(repo_path, repo_path, {".md"})

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
        rows = build_markdown_text_diff_rows(old_text, new_text)

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
        from backend.app import git_repo

        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp).resolve()
            (repo / ".git").mkdir()
            nested = repo / "notes" / "2026"
            nested.mkdir(parents=True)
            with patch.object(git_repo.subprocess, "run", side_effect=AssertionError("git must not be spawned")):
                self.assertEqual(git_repo.git_repo_root(nested), repo)

    def test_git_show_reads_blob_with_one_process_and_enforces_limit(self):
        from fastapi import HTTPException

        from backend.app import git_repo

        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            self._init_repo(repo)
            (repo / "small.txt").write_text("hello", encoding="utf-8")
            (repo / "big.bin").write_bytes(b"x" * 100)
            self._commit_all(repo)

            with patch.object(git_repo.subprocess, "run", side_effect=AssertionError("single Popen expected")):
                self.assertEqual(git_repo.git_show(repo, "small.txt", max_bytes=1024), b"hello")
                self.assertEqual(git_repo.git_show(repo, "small.txt"), b"hello")
                with self.assertRaises(HTTPException) as too_big:
                    git_repo.git_show(repo, "big.bin", max_bytes=10)
                with self.assertRaises(HTTPException) as missing:
                    git_repo.git_show(repo, "nope.txt", max_bytes=10)
            self.assertEqual(too_big.exception.status_code, 413)
            self.assertEqual(missing.exception.status_code, 404)

    def test_many_notes_and_missing_links_do_not_scale_process_or_walk_count(self):
        from backend.app import git_repo, markdown_links

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
            real_run = git_repo.subprocess.run
            real_walk = markdown_links.os.walk

            def counting_run(command, *args, **kwargs):
                run_calls.append(command)
                return real_run(command, *args, **kwargs)

            def counting_walk(top, *args, **kwargs):
                walk_calls.append(top)
                return real_walk(top, *args, **kwargs)

            with patch.object(git_repo.subprocess, "run", counting_run), patch.object(markdown_links.os, "walk", counting_walk):
                related = markdown_links.related_markdown_paths(repo, "note0.md")

            self.assertEqual({f"note{i}.md" for i in range(25)}, related)
            # ls-files（追跡）と ls-files --others（未追跡）のみ。ノート数・リンク数に比例しない。
            self.assertLessEqual(len(run_calls), 3, run_calls)
            # リンク切れが何件あってもVault走査は検索ルートごとに高々1回。
            self.assertLessEqual(len(walk_calls), 2, walk_calls)

    def test_untracked_and_ignored_link_targets_are_still_resolved(self):
        from backend.app import markdown_links

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

            related = markdown_links.related_markdown_paths(repo, "note.md")

            self.assertIn("assets/fresh.png", related)
            self.assertIn("tracked.png", related)
            self.assertIn("ignored_dir/hidden.png", related)

    def test_line_opcodes_with_trimmed_context_reconstructs_both_sides(self):
        import random

        from backend.app.text_diff import build_text_diff_rows

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
            rows = build_text_diff_rows(old_text, new_text)
            # 片側が空のときだけ付く「ファイル末尾: 改行…」マーカー行（行番号が左右ともNone）は対象外。
            rows = [row for row in rows if not (row["old_number"] is None and row["new_number"] is None)]
            self.assertEqual([row["old"] for row in rows if row["old"] is not None], old)
            self.assertEqual([row["new"] for row in rows if row["new"] is not None], new)

    def test_replace_rows_share_one_inline_comparison(self):
        from backend.app.text_diff import build_text_diff_rows, inline_diff_pair

        rows = build_text_diff_rows("name = old_value\n", "name = new_value\n")
        self.assertEqual(len(rows), 1)
        expected_old, expected_new = inline_diff_pair("name = old_value", "name = new_value")
        self.assertEqual(rows[0]["old_segments"], expected_old)
        self.assertEqual(rows[0]["new_segments"], expected_new)
        self.assertTrue(any(segment["changed"] for segment in rows[0]["old_segments"]))

    def test_small_component_filter_matches_per_component_reference(self):
        """ノイズ除去を一括処理にしても、成分ごとに処理していた従来実装と完全に同じマスクになること。"""
        import cv2
        import numpy as np

        from backend.app.diffing import _remove_small_components

        def reference(mask, min_pixels):
            count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
            filtered = np.zeros_like(mask)
            for label in range(1, count):
                if stats[label, cv2.CC_STAT_AREA] >= min_pixels:
                    filtered[labels == label] = 255
            return filtered

        rng = np.random.default_rng(1)
        mask = np.zeros((300, 400), np.uint8)
        mask[rng.random(mask.shape) > 0.97] = 255
        for y, x in zip(rng.integers(0, 297, 200), rng.integers(0, 397, 200)):
            mask[y : y + 2, x : x + 2] = 255
        for min_pixels in (1, 3, 5):
            self.assertTrue(np.array_equal(_remove_small_components(mask, min_pixels), reference(mask, min_pixels)))
        empty = np.zeros((10, 10), np.uint8)
        self.assertTrue(np.array_equal(_remove_small_components(empty, 3), empty))

    def test_visual_diff_matches_original_numpy_implementation(self):
        """高速化した差分（OpenCVの行列変換・一括合成）が、従来のnumpy実装とマスク・オーバーレイまで完全一致すること。"""
        import cv2
        import numpy as np

        from backend.app.diffing import _remove_small_components, build_visual_diff

        def reference(a, b, threshold):
            fa, fb = a.astype(np.float32), b.astype(np.float32)
            b1, g1, r1 = cv2.split(fa)
            b2, g2, r2 = cv2.split(fb)
            y = (r1 - r2) * 0.29889531 + (g1 - g2) * 0.58662247 + (b1 - b2) * 0.11448223
            i = (r1 - r2) * 0.59597799 - (g1 - g2) * 0.27417610 - (b1 - b2) * 0.32180189
            q = (r1 - r2) * 0.21147017 - (g1 - g2) * 0.52261711 + (b1 - b2) * 0.31114694
            delta = 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q
            mask = np.where(delta > 35215.0 * threshold * threshold, 255, 0).astype(np.uint8)
            mask = cv2.dilate(_remove_small_components(mask, 3), np.ones((3, 3), np.uint8))
            ink_a = cv2.inRange(cv2.cvtColor(a, cv2.COLOR_BGR2GRAY), 0, 245)
            ink_b = cv2.inRange(cv2.cvtColor(b, cv2.COLOR_BGR2GRAY), 0, 245)
            overlay = a.copy()
            for selected, color in (
                (cv2.bitwise_and(mask, cv2.bitwise_and(ink_a, cv2.bitwise_not(ink_b))), (40, 40, 230)),
                (cv2.bitwise_and(mask, cv2.bitwise_and(ink_b, cv2.bitwise_not(ink_a))), (230, 110, 40)),
                (cv2.bitwise_and(mask, cv2.bitwise_and(ink_a, ink_b)), (40, 190, 255)),
            ):
                blended = cv2.addWeighted(overlay, 0.35, np.full_like(overlay, color), 0.65, 0)
                overlay = np.where(selected[:, :, None] > 0, blended, overlay)
            return mask, overlay

        rng = np.random.default_rng(3)
        a = np.full((240, 320, 3), 255, np.uint8)
        cv2.putText(a, "DRAWING A-01", (10, 120), cv2.FONT_HERSHEY_SIMPLEX, 1.5, (0, 0, 0), 2)
        cv2.circle(a, (250, 60), 30, (0, 0, 200), 2)
        b = a.copy()
        cv2.putText(b, "REV B", (10, 200), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (20, 20, 20), 2)
        cv2.circle(b, (250, 60), 30, (0, 160, 0), -1)
        b = cv2.add(b, rng.integers(0, 12, b.shape, dtype=np.uint8))  # 微小なノイズ
        for threshold in (0.02, 0.1, 0.3):
            expected_mask, expected_overlay = reference(a, b, threshold)
            result = build_visual_diff(a, b, threshold)
            self.assertTrue(np.array_equal(result["mask"], expected_mask), threshold)
            # build_visual_diff は合成後に差分矩形の枠線を描くので、期待値にも同じ枠線を描いて比べる
            for rect in result["rects"]:
                x, y, w, h = rect["x"], rect["y"], rect["width"], rect["height"]
                cv2.rectangle(expected_overlay, (x, y), (x + w, y + h), (0, 80, 255), 2)
            self.assertTrue(np.array_equal(result["overlay"], expected_overlay), threshold)

    def test_analyze_then_convert_rasterizes_single_page_file_once(self):
        """画像選択時の /api/analyze → /api/convert で、同じファイルを2回画像化しないこと。"""
        from backend.app import raster_cache

        svg = b'<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="20" height="10"/><text x="1" y="25">cache-test</text></svg>'
        real = raster_cache.rasterize_upload_page
        with patch.object(raster_cache, "rasterize_upload_page", side_effect=real) as rasterize:
            client = TestClient(app)
            analyzed = client.post("/api/analyze", files={"file": ("cache-test.svg", svg, "image/svg+xml")})
            converted = client.post("/api/convert", files={"file": ("cache-test.svg", svg, "image/svg+xml")}, data={"page": "0"})
        self.assertEqual(analyzed.status_code, 200, analyzed.text)
        self.assertEqual(converted.status_code, 200, converted.text)
        self.assertEqual(analyzed.json()["pages"][0]["width"], converted.json()["width"])
        self.assertEqual(rasterize.call_count, 1)

    def test_long_repetitive_line_highlight_stays_fast(self):
        """同じトークンが繰り返される長い行でも行内ハイライトが止まらず、変更箇所だけを強調すること。

        SequenceMatcher のままだと 2,800 トークンの行で約28秒かかっていた。
        """
        import time

        from backend.app.text_diff import build_text_diff_rows, inline_diff_pair

        old_line = "a b " * 700 + "OLD" + " a b" * 10
        new_line = "a b " * 700 + "NEW" + " a b" * 10
        started = time.perf_counter()
        old_segments, new_segments = inline_diff_pair(old_line, new_line)
        self.assertLess(time.perf_counter() - started, 1.0)
        self.assertEqual([segment["text"] for segment in old_segments if segment["changed"]], ["OLD"])
        self.assertEqual([segment["text"] for segment in new_segments if segment["changed"]], ["NEW"])
        self.assertEqual("".join(segment["text"] for segment in old_segments), old_line)

        # 通常の短い行は従来どおりトークン単位で比較する
        rows = build_text_diff_rows("value = old_name(1)\n", "value = new_name(1)\n")
        self.assertEqual([segment["text"] for segment in rows[0]["new_segments"] if segment["changed"]], ["new_name"])

    def test_anchor_regions_finish_quickly_on_dense_grid(self):
        """方眼のグラフ（縦横の罫線が多数）でも基準領域候補の抽出が止まらないこと。

        以前は枠候補が組み合わせ爆発し、重複除去も二乗の計算量だったため数分以上かかっていた。
        """
        import time

        import cv2
        import numpy as np

        from backend.app.regions import suggest_anchor_regions

        image = np.full((1800, 2400, 3), 255, np.uint8)
        for index in range(61):
            y = 40 + index * 28
            x = 40 + index * 38
            cv2.line(image, (30, y), (2370, y), (0, 0, 0), 2)
            cv2.line(image, (x, 30), (x, 1770), (0, 0, 0), 2)
        started = time.perf_counter()
        regions = suggest_anchor_regions(image)
        self.assertLess(time.perf_counter() - started, 10.0)
        self.assertTrue(1 <= len(regions) <= 8)

    def test_cached_result_response_reuses_aligned_images(self):
        """GET /api/diff/{result_id} が補正済み画像を元画像欄にも返す（エンコード共通化後も内容は同じ）。"""
        import numpy as np

        from backend.app.result_cache import store_diff_images

        image_a = np.full((20, 30, 3), 255, np.uint8)
        image_b = image_a.copy()
        image_b[5:10, 5:10] = 0
        result_id = store_diff_images(image_a, image_b, filename_a="a.png", filename_b="b.png")
        body = TestClient(app).get(f"/api/diff/{result_id}").json()
        self.assertEqual(body["image_a"], body["image_a_original"])
        self.assertEqual(body["image_b_aligned"], body["image_b_original"])
        self.assertNotEqual(body["image_a"]["data"], body["image_b_aligned"]["data"])
        self.assertGreater(body["diff_pixels"], 0)


if __name__ == "__main__":
    unittest.main()
