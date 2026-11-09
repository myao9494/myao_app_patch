"""search_core / finder_cli のテスト。本物の Everything と Local-fulltext-search は使わず、偽のサーバーで確認する。

実行: python -m unittest discover -s skills/file-finder/tests -v   (リポジトリのルートから)
"""
from __future__ import annotations

import base64
import http.server
import io
import json
import os
import re
import socket
import socketserver
import sys
import tempfile
import threading
import unittest
import urllib.parse
from pathlib import Path
from unittest.mock import patch

SKILL_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL_DIR / "scripts"))

import finder_cli as cli  # noqa: E402
import search_core as sc  # noqa: E402


# ---------------------------------------------------------------------------
# 偽のサーバー
# ---------------------------------------------------------------------------

class FakeBackends:
    """Everything と Local-fulltext-search を、1 つのプロセスの中で真似る。受けた要求を記録する。"""

    def __init__(self) -> None:
        self.everything_requests: list[dict] = []
        self.everything_auth: list[str | None] = []
        self.fulltext_payloads: list[dict] = []
        # Everything が返す (全ドライブを索引しているので、roots の外のものも混ざる)
        self.everything_results = [
            {"type": "file", "name": "見積_2026.xlsx", "path": "C:\\Docs\\案件A", "size": "20480", "date_modified": "133800000000000000"},
            {"type": "folder", "name": "見積", "path": "C:\\Docs", "size": "", "date_modified": "133800000000000000"},
            {"type": "file", "name": "見積_private.xlsx", "path": "C:\\Users\\other\\Private", "size": "10", "date_modified": "133800000000000000"},
            {"type": "file", "name": "見積.tmp", "path": "C:\\Docs\\案件A", "size": "1", "date_modified": "133800000000000000"},
            {"type": "file", "name": "見積_share.docx", "path": "D:\\Share", "size": "3000000", "date_modified": "133800000000000000"},
            {"type": "file", "name": "x.md", "path": "C:\\Docs2", "size": "1", "date_modified": "0"},  # 'C:\Docs' と前方が同じだけの別フォルダ
        ]
        # Local-fulltext-search が返す
        self.fulltext_items = [
            {"full_path": "C:/Docs/案件A/議事録.md", "file_ext": "md", "result_kind": "file", "source_type": "local", "mtime": "2026-11-01T09:00:00Z", "snippet": "見積の金額について" + "あ" * 400},
            {"full_path": "C:/Docs/案件A/見積.xlsx", "file_ext": "xlsx", "result_kind": "file", "source_type": "local", "mtime": "2026-10-20T09:00:00Z", "snippet": "合計 100万円"},
            {"full_path": "C:/Users/other/Private/秘密.md", "file_ext": "md", "result_kind": "file", "source_type": "local", "mtime": "2026-10-20T09:00:00Z", "snippet": "漏れてはいけない"},
            {"full_path": "C:/Docs/.git/config.md", "file_ext": "md", "result_kind": "file", "source_type": "local", "mtime": "2026-10-20T09:00:00Z", "snippet": "除外されるべき"},
            {"full_path": "gantt://tasks/1", "file_ext": "", "result_kind": "file", "source_type": "gantt", "mtime": "2026-10-20T09:00:00Z", "snippet": "タスク"},
            {"full_path": "C:/Docs/案件A/議事録.md", "file_ext": "md", "result_kind": "file", "source_type": "local", "mtime": "2026-11-01T09:00:00Z", "snippet": "重複"},
        ]
        self.targets = [
            {"full_path": "C:/Docs", "source_type": "local", "is_enabled": True, "indexed_file_count": 120},
            {"full_path": "E:/Archive", "source_type": "local", "is_enabled": False, "indexed_file_count": 5},
        ]
        backends = self

        class Everything(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                backends.everything_requests.append({k: v[0] for k, v in query.items()})
                backends.everything_auth.append(self.headers.get("Authorization"))
                body = json.dumps({"totalResults": len(backends.everything_results), "results": backends.everything_results}, ensure_ascii=False).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args) -> None:
                pass

        class Fulltext(http.server.BaseHTTPRequestHandler):
            def _send(self, code: int, payload: dict) -> None:
                body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self) -> None:  # noqa: N802
                if self.path == "/api/health":
                    self._send(200, {"status": "ok"})
                elif self.path == "/api/index/search-targets":
                    self._send(200, {"items": backends.targets})
                else:
                    self._send(404, {"detail": "not found"})

            def do_POST(self) -> None:  # noqa: N802
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])).decode("utf-8"))
                backends.fulltext_payloads.append(payload)
                if self.path != "/api/search/indexed":
                    self._send(404, {"detail": "not found"})
                elif not payload.get("folder_path"):
                    self._send(422, {"detail": "folder_path が空です"})  # 空 = インデックス全体の検索。送ってはいけない
                else:
                    items = [i for i in backends.fulltext_items if i["full_path"].casefold().startswith(payload["folder_path"].casefold()) or i["full_path"].startswith("gantt:") or "Private" in i["full_path"]]
                    self._send(200, {"total": len(items), "items": items[: payload["limit"]], "has_more": False})

            def log_message(self, *args) -> None:
                pass

        class QuickServer(http.server.ThreadingHTTPServer):
            def server_bind(self) -> None:
                # 既定の実装は socket.getfqdn() を呼び、名前解決で数百ミリ秒かかるため、省く
                socketserver.TCPServer.server_bind(self)
                self.server_name, self.server_port = "127.0.0.1", self.server_address[1]

        self.servers = [QuickServer(("127.0.0.1", 0), handler) for handler in (Everything, Fulltext)]
        for server in self.servers:
            threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()  # 止めるときの待ちを短くする
        self.everything_url = f"http://127.0.0.1:{self.servers[0].server_address[1]}"
        self.fulltext_url = f"http://127.0.0.1:{self.servers[1].server_address[1]}"

    def close(self) -> None:
        for server in self.servers:
            server.shutdown()
            server.server_close()


def unused_url() -> str:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return f"http://127.0.0.1:{sock.getsockname()[1]}"


class FinderTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.backends = FakeBackends()
        self.addCleanup(self.backends.close)
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.config_path = self.tmp / "config.local.json"
        self.write_config()

    def write_config(self, **overrides) -> None:
        config = {
            "roots": ["C:/Docs", "D:/Share"],
            "exclude": [".git", "~$*", "*.tmp"],
            "everything": {"url": self.backends.everything_url, "user": "", "password_env": "TEST_EVERYTHING_PASSWORD"},
            "fulltext": {"url": self.backends.fulltext_url, "folders": []},
            "limits": {"max_results": 30, "snippet_chars": 160, "timeout_sec": 5},
        }
        config.update(overrides)
        self.config_path.write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")

    def run_cli(self, argv: list[str]) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        code = cli.main(argv, stdout=out, stderr=err, config_path=self.config_path)
        return code, out.getvalue(), err.getvalue()


# ---------------------------------------------------------------------------
# パスと設定
# ---------------------------------------------------------------------------

class PathTests(unittest.TestCase):
    def test_正規化(self) -> None:
        self.assertEqual(sc.norm_path("C:\\Docs\\案件A\\"), "C:/Docs/案件A")
        self.assertEqual(sc.norm_path("C:/Docs/a/../b"), "C:/Docs/b")
        self.assertEqual(sc.norm_path("\\\\server\\share\\x"), "//server/share/x")
        self.assertEqual(sc.norm_path("C:\\"), "C:/")

    def test_配下の判定(self) -> None:
        self.assertTrue(sc.is_under("C:/Docs/a.md", "C:/Docs"))
        self.assertTrue(sc.is_under("c:\\docs\\a.md", "C:/Docs"))  # 大文字小文字と区切りは区別しない
        self.assertTrue(sc.is_under("C:/Docs", "C:/Docs"))
        self.assertFalse(sc.is_under("C:/Docs2/a.md", "C:/Docs"))  # 前方が同じだけの別フォルダ
        self.assertFalse(sc.is_under("C:/Docs/../Other/a.md", "C:/Docs"))  # .. での抜け道
        self.assertFalse(sc.is_under("D:/Docs/a.md", "C:/Docs"))
        self.assertFalse(sc.is_under("", "C:/Docs"))

    def test_除外パターン(self) -> None:
        patterns = [".git", "~$*", "*.tmp", "node_modules"]
        self.assertTrue(sc.is_excluded("C:/Docs/.git/config", patterns))
        self.assertTrue(sc.is_excluded("C:/Docs/~$見積.xlsx", patterns))
        self.assertTrue(sc.is_excluded("C:/Docs/a/b.TMP", patterns))
        self.assertFalse(sc.is_excluded("C:/Docs/.github/x.md", patterns))  # .git と .github は別

    def test_雛形は_handoffの下書きとバックアップを除外する(self) -> None:
        """.handoff/ の下書きには AI の印が無く、人のノートに見えるので、検索結果に出さない。"""
        sample = json.loads((SKILL_DIR / "config.sample.json").read_text(encoding="utf-8"))
        self.assertIn(".handoff", sample["exclude"])
        self.assertTrue(sc.is_excluded("C:/Vault/.handoff/draft_見積.md", sample["exclude"]))
        self.assertTrue(sc.is_excluded("C:/Vault/.handoff/backup/20261108-202621_見積.md", sample["exclude"]))
        self.assertFalse(sc.is_excluded("C:/Vault/01_data/handoff の手順.md", sample["exclude"]))


class ConfigTests(FinderTestCase):
    def test_正常(self) -> None:
        config = sc.load_config(self.config_path)
        self.assertEqual(config.roots, ["C:/Docs", "D:/Share"])

    def test_rootsが空_プレースホルダのままならエラー(self) -> None:
        self.write_config(roots=[])
        with self.assertRaises(sc.ConfigError):
            sc.load_config(self.config_path)
        self.write_config(roots=["C:/Users/<ユーザー名>/Documents"])
        with self.assertRaises(sc.ConfigError):
            sc.load_config(self.config_path)

    def test_相対パスのrootsはエラー(self) -> None:
        self.write_config(roots=["Documents"])
        with self.assertRaises(sc.ConfigError):
            sc.load_config(self.config_path)

    def test_fulltextのフォルダがrootsの外ならエラー(self) -> None:
        self.write_config(fulltext={"url": self.backends.fulltext_url, "folders": ["E:/Archive"]})
        with self.assertRaises(sc.ConfigError):
            sc.load_config(self.config_path)

    def test_設定ファイルが無い_壊れているときは案内する(self) -> None:
        with self.assertRaises(sc.ConfigError) as ctx:
            sc.load_config(self.tmp / "none.json")
        self.assertIn("config.sample.json", str(ctx.exception))
        self.config_path.write_text("{ broken", encoding="utf-8")
        with self.assertRaises(sc.ConfigError):
            sc.load_config(self.config_path)

    def test_CLIは設定の誤りを終了コード2で知らせる(self) -> None:
        self.write_config(roots=[])
        code, _, err = self.run_cli(["content", "見積"])
        self.assertEqual(code, 2)
        self.assertIn("roots", err)


# ---------------------------------------------------------------------------
# 全文検索
# ---------------------------------------------------------------------------

class MatchAndAiTests(FinderTestCase):
    """0.12.0: 意味だけの一致 (語を含まない) と、AI のまとめ (未レビュー) を、結果で見分けられるようにする。
    レビューで、hybrid の意味だけの一致に関係の無いノートが混ざり、AI のまとめが検索の上位に来ることが分かった。"""

    def setUp(self) -> None:
        super().setUp()
        vault = self.tmp / "vault"
        (vault / "01_data").mkdir(parents=True)
        (vault / "10_summary").mkdir()
        self.human = vault / "01_data" / "人のノート.md"
        self.human.write_text("---\ncreated: 2026-01-01 00:00:00\ntags:\n---\n本文\n", encoding="utf-8")
        self.ai = vault / "01_data" / "まとめ【1】.md"
        self.ai.write_text("---\ncreated: 2026-11-07 00:00:00\nai_generated: opencode\nai_reviewed: false\ntags:\n---\n本文\n", encoding="utf-8")
        self.ai_ok = vault / "01_data" / "まとめ済.md"
        self.ai_ok.write_bytes("---\r\nai_generated: opencode\r\nai_reviewed: true\r\n---\r\n本文\r\n".encode("utf-8"))
        self.summary = vault / "10_summary" / "古い要約_summary.md"
        self.summary.write_text("# 要約\n", encoding="utf-8")
        root = vault.as_posix()
        self.write_config(roots=[root])
        self.backends.fulltext_items = [
            {"full_path": self.human.as_posix(), "file_ext": "md", "source_type": "local", "match_type": "both", "hybrid_score": 0.98, "snippet": "a"},
            {"full_path": self.ai.as_posix(), "file_ext": "md", "source_type": "local", "match_type": "keyword_only", "snippet": "b"},
            {"full_path": self.ai_ok.as_posix(), "file_ext": "md", "source_type": "local", "match_type": "both", "hybrid_score": 0.9, "snippet": "c"},
            {"full_path": self.summary.as_posix(), "file_ext": "md", "source_type": "local", "match_type": "vector_only", "hybrid_score": 0.45, "vector_score": 0.61, "snippet": "d"},
        ]

    def test_一致の種類と点数_AIのまとめの印(self) -> None:
        code, out, _ = self.run_cli(["content", "まとめ", "--mode", "hybrid"])
        self.assertEqual(code, 0, out)
        lines = {l.split(" | ")[0].rsplit("/", 1)[-1]: l for l in out.splitlines() if l.startswith("[")}
        self.assertIn("一致: 語と意味 (0.98)", lines["人のノート.md"])
        self.assertNotIn("AI", lines["人のノート.md"])
        self.assertIn("一致: 語", lines["まとめ【1】.md"])
        self.assertIn("AI のまとめ (未レビュー)", lines["まとめ【1】.md"])
        self.assertIn("AI のまとめ (レビュー済)", lines["まとめ済.md"])
        self.assertIn("一致: 意味だけ (0.45)", lines["古い要約_summary.md"])
        self.assertIn("AI のまとめ (未レビュー)", lines["古い要約_summary.md"])  # 10_summary は、印が無くても AI の要約
        self.assertIn("注意: 「意味だけ」の一致が 1 件", out)
        self.assertIn("注意: 未レビューの AI のまとめが 2 件", out)

    def test_意味だけの一致は後ろの別の欄にまとめる(self) -> None:
        self.backends.fulltext_items.insert(0, self.backends.fulltext_items.pop())  # 意味だけを先頭にしても
        code, out, _ = self.run_cli(["content", "まとめ", "--mode", "hybrid"])
        self.assertEqual(code, 0, out)
        rows = [l for l in out.splitlines() if l.startswith("[") or l.startswith("--- ここから")]
        self.assertTrue(rows[-2].startswith("--- ここから「意味だけ」"), rows)
        self.assertIn("古い要約_summary.md", rows[-1])
        self.assertTrue(rows[-1].startswith("[4]"))
        self.assertEqual(sum(1 for l in rows if l.startswith("--- ここから")), 1)

    def test_AIが直した人のノートは_根拠に使ってよい印(self) -> None:
        self.human.write_text("---\ncreated: 2026-01-01 00:00:00\nai_edited: 2026-11-08 10:00:00\nai_reviewed: false\n---\n本文\n", encoding="utf-8")
        code, out, _ = self.run_cli(["content", "まとめ"])
        line = next(l for l in out.splitlines() if "人のノート.md" in l)
        self.assertIn("AI が修正 (未レビュー。根拠に使ってよい)", line)
        self.assertIn("注意: 未レビューの AI のまとめが 2 件", out)  # 直したノートは、まとめに数えない
        self.human.write_text("---\nai_edited: 2026-11-08 10:00:00\nai_reviewed: true\n---\n本文\n", encoding="utf-8")
        _, out, _ = self.run_cli(["content", "まとめ"])
        self.assertNotIn("AI が修正", out)

    def test_無いファイルや_md_以外は読まずに印を付けない(self) -> None:
        self.backends.fulltext_items = [{"full_path": (self.tmp / "vault" / "01_data" / "無い.md").as_posix(), "file_ext": "md", "source_type": "local", "match_type": "both", "snippet": "x"},
                                        {"full_path": (self.tmp / "vault" / "01_data" / "表.xlsx").as_posix(), "file_ext": "xlsx", "source_type": "local", "snippet": "y"}]
        code, out, _ = self.run_cli(["content", "まとめ"])
        self.assertEqual(code, 0)
        self.assertNotIn("AI のまとめ", out)


class ContentTests(FinderTestCase):
    def test_対象外_除外_重複_他の種類は結果に出ない(self) -> None:
        code, out, _ = self.run_cli(["content", "見積"])
        self.assertEqual(code, 0)
        self.assertIn("C:/Docs/案件A/議事録.md", out)
        self.assertIn("C:/Docs/案件A/見積.xlsx", out)
        self.assertNotIn("Private", out)       # roots の外
        self.assertNotIn(".git", out)           # 除外
        self.assertNotIn("gantt://", out)       # ローカル以外
        self.assertEqual(out.count("議事録.md"), 1)  # 重複

    def test_空のfolder_pathを送らず_rootsごとに検索する(self) -> None:
        self.run_cli(["content", "見積"])
        folders = [p["folder_path"] for p in self.backends.fulltext_payloads]
        self.assertEqual(folders, ["C:/Docs", "D:/Share"])
        self.assertTrue(all(folders))
        self.assertTrue(all(p["source_type"] == "local" and p["search_type"] == "keyword" for p in self.backends.fulltext_payloads))

    def test_folder指定はrootsの中だけ(self) -> None:
        code, _, _ = self.run_cli(["content", "見積", "--folder", "C:/Docs/案件A"])
        self.assertEqual(code, 0)
        self.assertEqual([p["folder_path"] for p in self.backends.fulltext_payloads], ["C:/Docs/案件A"])
        self.backends.fulltext_payloads.clear()
        code, _, err = self.run_cli(["content", "見積", "--folder", "C:/Users/other"])
        self.assertEqual(code, 2)
        self.assertIn("roots", err)
        code, _, _ = self.run_cli(["content", "見積", "--folder", "C:/Docs/../Users/other"])
        self.assertEqual(code, 2)
        self.assertEqual(self.backends.fulltext_payloads, [])  # サーバーには何も送られていない

    def test_fulltextのfoldersを設定すると_そのフォルダだけを検索する(self) -> None:
        self.write_config(fulltext={"url": self.backends.fulltext_url, "folders": ["C:/Docs/案件A"]})
        self.run_cli(["content", "見積"])
        self.assertEqual([p["folder_path"] for p in self.backends.fulltext_payloads], ["C:/Docs/案件A"])

    def test_拡張子は送り_結果でも絞る(self) -> None:
        _, out, _ = self.run_cli(["content", "見積", "--ext", ".XLSX, md"])
        self.assertEqual(self.backends.fulltext_payloads[0]["extensions"], "xlsx,md")
        _, out, _ = self.run_cli(["content", "見積", "--ext", "xlsx"])
        self.assertIn("見積.xlsx", out)
        self.assertNotIn("議事録.md", out)

    def test_件数と抜粋の長さに上限がある(self) -> None:
        _, out, _ = self.run_cli(["content", "見積", "--limit", "1"])
        self.assertTrue(out.splitlines()[0].startswith("全文検索: '見積' (1 件"))
        snippet = [l for l in out.splitlines() if l.startswith("    ")][0].strip()
        self.assertLessEqual(len(snippet), 161)
        self.assertTrue(snippet.endswith("…"))

    def test_引用符で囲まずに並べた語も_スペースのANDで送る(self) -> None:
        """手順書の例 `run.bat content 見積 金額` のとおりに打っても動くこと。"""
        code, _, err = self.run_cli(["content", "見積", "金額", "--limit", "5"])
        self.assertEqual(code, 0, err)
        self.assertEqual({p["q"] for p in self.backends.fulltext_payloads}, {"見積 金額"})

    def test_方式を指定できる(self) -> None:
        self.run_cli(["content", "見積", "--mode", "hybrid"])
        self.assertEqual(self.backends.fulltext_payloads[0]["search_type"], "hybrid")

    def test_サーバーに接続できないときは分かるエラー(self) -> None:
        self.write_config(fulltext={"url": unused_url(), "folders": []})
        code, _, err = self.run_cli(["content", "見積"])
        self.assertEqual(code, 3)
        self.assertIn("接続できません", err)

    def test_検索語が空ならエラー(self) -> None:
        code, _, _ = self.run_cli(["content", "  "])
        self.assertEqual(code, 2)


class TargetsTests(FinderTestCase):
    def test_検索対象のフォルダとrootsの内外を示す(self) -> None:
        code, out, _ = self.run_cli(["targets"])
        self.assertEqual(code, 0)
        self.assertIn("C:/Docs (有効, 120 ファイル, roots の中)", out)
        self.assertIn("E:/Archive (無効, 5 ファイル, roots の外", out)


# ---------------------------------------------------------------------------
# 名前検索
# ---------------------------------------------------------------------------

class NamesTests(FinderTestCase):
    def test_roots内の結果だけを返し_前方一致だけの別フォルダは除く(self) -> None:
        code, out, _ = self.run_cli(["names", "見積"])
        self.assertEqual(code, 0)
        self.assertIn("C:/Docs/案件A/見積_2026.xlsx", out)
        self.assertIn("[フォルダ] C:/Docs/見積", out)
        self.assertIn("D:/Share/見積_share.docx", out)
        self.assertNotIn("Private", out)     # roots の外
        self.assertNotIn("見積.tmp", out)    # 除外
        self.assertNotIn("Docs2", out)       # 'C:/Docs' と前方が同じだけの別フォルダ

    def test_引用符で囲まずに並べた語も_ANDで送る(self) -> None:
        code, _, err = self.run_cli(["names", "議事録", "2026", "--kind", "file"])
        self.assertEqual(code, 0, err)
        self.assertTrue(all(r["search"].endswith(" 議事録 2026") for r in self.backends.everything_requests))

    def test_rootごとに_その下に絞った検索語を送る(self) -> None:
        self.run_cli(["names", "見積", "--kind", "file", "--ext", "xlsx"])
        searches = [r["search"] for r in self.backends.everything_requests]
        self.assertEqual(len(searches), 2)
        self.assertIn('"C:\\Docs\\"', searches[0])
        self.assertIn('"D:\\Share\\"', searches[1])
        self.assertTrue(searches[0].startswith("file: ext:xlsx "))
        self.assertTrue(searches[0].endswith(" 見積"))
        self.assertEqual(self.backends.everything_requests[0]["json"], "1")

    def test_folder指定はrootsの中だけ(self) -> None:
        self.run_cli(["names", "見積", "--folder", "C:/Docs/案件A"])
        self.assertEqual(len(self.backends.everything_requests), 1)
        self.assertIn('"C:\\Docs\\案件A\\"', self.backends.everything_requests[0]["search"])
        self.backends.everything_requests.clear()
        code, _, err = self.run_cli(["names", "見積", "--folder", "C:/Windows"])
        self.assertEqual(code, 2)
        self.assertEqual(self.backends.everything_requests, [])

    def test_contentコマンドは使えない(self) -> None:
        code, _, err = self.run_cli(["names", "content:パスワード"])
        self.assertEqual(code, 2)
        self.assertIn("content", err)
        self.assertEqual(self.backends.everything_requests, [])

    def test_ユーザーを設定したらBasic認証を送り_パスワード未設定ならエラー(self) -> None:
        self.write_config(everything={"url": self.backends.everything_url, "user": "me", "password_env": "TEST_EVERYTHING_PASSWORD"})
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("TEST_EVERYTHING_PASSWORD", None)
            code, _, err = self.run_cli(["names", "見積"])
            self.assertEqual(code, 2)
            self.assertIn("TEST_EVERYTHING_PASSWORD", err)
        with patch.dict(os.environ, {"TEST_EVERYTHING_PASSWORD": "秘密"}):
            code, _, _ = self.run_cli(["names", "見積"])
        self.assertEqual(code, 0)
        expected = "Basic " + base64.b64encode("me:秘密".encode("utf-8")).decode("ascii")
        self.assertEqual(self.backends.everything_auth[-1], expected)

    def test_日時とサイズの表示(self) -> None:
        _, out, _ = self.run_cli(["names", "見積", "--limit", "1"])
        line = [l for l in out.splitlines() if l.startswith("[1]")][0]
        self.assertRegex(line, r"\| 20\d\d-\d\d-\d\d \| 20KB")

    def test_件数の上限(self) -> None:
        _, out, _ = self.run_cli(["names", "見積", "--limit", "2"])
        self.assertEqual(len([l for l in out.splitlines() if l.startswith("[")]), 2)

    def test_Everythingに接続できないときは分かるエラー(self) -> None:
        self.write_config(everything={"url": unused_url(), "user": "", "password_env": "X"})
        code, _, err = self.run_cli(["names", "見積"])
        self.assertEqual(code, 3)
        self.assertIn("接続できません", err)


# ---------------------------------------------------------------------------
# 確認・出力・安全性
# ---------------------------------------------------------------------------

class CheckAndOutputTests(FinderTestCase):
    def test_checkは設定と2つのサーバーを確認する(self) -> None:
        code, out, _ = self.run_cli(["check"])
        self.assertEqual(code, 0)
        self.assertIn("設定: OK", out)
        self.assertIn("Local-fulltext-search: 接続OK", out)
        self.assertIn("Everything: 接続OK", out)

    def test_checkは1つでも失敗したら終了コード3(self) -> None:
        self.write_config(fulltext={"url": unused_url(), "folders": []})
        code, out, _ = self.run_cli(["check"])
        self.assertEqual(code, 3)
        self.assertIn("Local-fulltext-search: 失敗", out)

    def test_outは_handoffの中だけ_上書きしない(self) -> None:
        previous = os.getcwd()
        os.chdir(self.tmp)  # --out は、作業フォルダ直下の .handoff を基準にする
        try:
            target = self.tmp / ".handoff" / "finder_見積.md"
            code, out, _ = self.run_cli(["content", "見積", "--out", str(target)])
            self.assertEqual(code, 0)
            self.assertIn("議事録.md", target.read_text(encoding="utf-8"))
            self.assertNotIn("議事録.md", out)
            code, _, err = self.run_cli(["content", "見積", "--out", str(target)])
            self.assertEqual(code, 2)
            code, _, err = self.run_cli(["content", "見積", "--out", str(self.tmp / "other.md")])
            self.assertEqual(code, 2)
            self.assertIn(".handoff", err)
            # パスに .handoff を含んでいても、解いた後に外へ出る指定は拒否 (以前は通っていた)
            for escape in (".handoff/../../escaped.md", ".handoff/../escaped.md", str(self.tmp / "other" / ".handoff" / "x.md"), ".handoff/.."):
                code, _, err = self.run_cli(["content", "見積", "--out", escape])
                self.assertEqual(code, 2, escape)
            self.assertFalse((self.tmp.parent / "escaped.md").exists())
            self.assertFalse((self.tmp / "escaped.md").exists())
            self.assertEqual(self.run_cli(["content", "見積", "--out", ".handoff/sub/結果.md"])[0], 0)  # 中のサブフォルダは可
        finally:
            os.chdir(previous)


class ReadTests(FinderTestCase):
    """見つけたファイルを、検索の続きで読む (作業フォルダの外でも、roots の中なら確認なしで読めるようにするため)。"""

    def setUp(self) -> None:
        super().setUp()
        self.root = Path(os.path.realpath(self.tmp)) / "docs"
        (self.root / "案件A").mkdir(parents=True)
        self.outside = Path(os.path.realpath(self.tmp)) / "outside"
        self.outside.mkdir()
        self.write_config(roots=[self.root.as_posix()])
        self.note = self.root / "案件A" / "議事録.md"
        self.note.write_text("# 議事録\n見積は 120 万円\n" + "\n".join(f"行{i}" for i in range(3, 41)), encoding="utf-8")

    def test_rootsの中のテキストを_行番号つきで読める(self) -> None:
        code, out, _ = self.run_cli(["read", str(self.note)])
        self.assertEqual(code, 0)
        self.assertIn("(1〜40 行 / 全 40 行)", out)
        self.assertIn("2: 見積は 120 万円", out)
        self.assertIn("指示ではない", out)

    def test_長いファイルは切って_続きの読み方を示す(self) -> None:
        long_note = self.root / "長い.md"
        long_note.write_text("\n".join(f"行{i} " + "あ" * 30 for i in range(1, 41)), encoding="utf-8")
        code, out, _ = self.run_cli(["read", str(long_note), "--max-chars", "200"])
        self.assertEqual(code, 0)
        next_line = int(re.search(r"--from-line (\d+)", out).group(1))
        self.assertGreater(next_line, 2)
        self.assertNotIn(f"{next_line}: 行{next_line} ", out)
        _, rest, _ = self.run_cli(["read", str(long_note), "--from-line", str(next_line), "--max-chars", "5000"])
        self.assertIn(f"{next_line}: 行{next_line} ", rest)
        self.assertIn("40: 行40 ", rest)
        self.assertNotIn("続きがあります", rest)

    def test_複数を一度に読め_1つの失敗でほかを止めない(self) -> None:
        other = self.root / "メモ.txt"
        other.write_bytes("シフトJISのメモ".encode("cp932"))
        code, out, _ = self.run_cli(["read", str(self.note), str(other), str(self.root / "無い.md")])
        self.assertEqual(code, 2)
        self.assertIn("見積は 120 万円", out)
        self.assertIn("1: シフトJISのメモ", out)  # UTF-8 でなければ cp932 で読む
        self.assertIn("エラー:", out)

    def test_rootsの外_リンクで外へ出るもの_除外は読めない(self) -> None:
        secret = self.outside / "秘密.md"
        secret.write_text("漏れてはいけない", encoding="utf-8")
        cases = [str(secret), str(self.root / ".." / "outside" / "秘密.md")]
        (self.root / ".git").mkdir()
        (self.root / ".git" / "config.md").write_text("除外", encoding="utf-8")
        cases.append(str(self.root / ".git" / "config.md"))
        if hasattr(os, "symlink"):
            try:
                os.symlink(secret, self.root / "link.md")
                cases.append(str(self.root / "link.md"))
            except OSError:
                pass  # Windows で、リンクを作る権限が無い
        for case in cases:
            code, out, _ = self.run_cli(["read", case])
            self.assertEqual(code, 2, case)
            self.assertNotIn("漏れてはいけない", out)
            self.assertNotIn("1: 除外", out)

    def test_認証情報_Office_バイナリ_フォルダは読まない(self) -> None:
        (self.root / ".env").write_text("TOKEN=abc", encoding="utf-8")
        (self.root / "見積.xlsx").write_bytes(b"PK\x03\x04")
        (self.root / "図.bin").write_bytes(b"\x00\x01\x02")
        for name, word in ((".env", "認証情報"), ("見積.xlsx", "doc-convert"), ("図.bin", "テキスト"), ("案件A", "フォルダ")):
            code, out, _ = self.run_cli(["read", str(self.root / name)])
            self.assertEqual(code, 2, name)
            self.assertIn(word, out)
            self.assertNotIn("TOKEN", out)

    def test_未レビューのAIのまとめには_印が出る(self) -> None:
        summary = self.root / "まとめ.md"
        summary.write_text("---\nai_generated: 2026-11-01\n---\n要約", encoding="utf-8")
        _, out, _ = self.run_cli(["read", str(summary)])
        self.assertIn("未レビューの AI のまとめ", out)

    def test_一度に読める数の上限(self) -> None:
        code, _, err = self.run_cli(["read", *[str(self.note)] * (sc.READ_MAX_FILES + 1)])
        self.assertEqual(code, 2)
        self.assertIn(str(sc.READ_MAX_FILES), err)


class SafetyTests(unittest.TestCase):
    def test_ファイルを開くのは_読み取りだけ(self) -> None:
        source = (SKILL_DIR / "scripts" / "search_core.py").read_text(encoding="utf-8")
        self.assertEqual(set(re.findall(r'open\([^)]*?,\s*"([a-z+]+)"', source)), {"rb"})

    def test_呼ぶAPIは読み取りの3つだけ(self) -> None:
        source = (SKILL_DIR / "scripts" / "search_core.py").read_text(encoding="utf-8")
        found = set(re.findall(r'/api/[A-Za-z0-9_/\-]+', source))
        self.assertEqual(found, {"/api/search/indexed", "/api/health", "/api/index/search-targets"})
        self.assertNotRegex(source, r'method\s*=\s*"(PUT|DELETE|PATCH)"')

    def test_ファイルを書き換える呼び出しが無い(self) -> None:
        for name in ("search_core.py", "finder_cli.py"):
            source = (SKILL_DIR / "scripts" / name).read_text(encoding="utf-8")
            self.assertNotRegex(source, r"\b(os\.remove|os\.unlink|shutil\.|\.unlink\(|\.rmdir\(|os\.rename)", name)

    def test_run_batはASCIIだけ(self) -> None:
        (SKILL_DIR / "run.bat").read_bytes().decode("ascii")

    def test_設定のひな形は有効なJSON(self) -> None:
        sample = json.loads((SKILL_DIR / "config.sample.json").read_text(encoding="utf-8"))
        self.assertIn("roots", sample)


class ConversionTests(unittest.TestCase):
    def test_FILETIME(self) -> None:
        self.assertRegex(sc.filetime_to_text("133800000000000000"), r"^20\d\d-\d\d-\d\d$")
        self.assertEqual(sc.filetime_to_text("0"), "")
        self.assertEqual(sc.filetime_to_text("2026-11-01 09:00"), "2026-11-01")

    def test_サイズ(self) -> None:
        self.assertEqual(sc.human_size("500"), "500B")
        self.assertEqual(sc.human_size("20480"), "20KB")
        self.assertEqual(sc.human_size("3000000"), "3MB")
        self.assertEqual(sc.human_size(""), "")


if __name__ == "__main__":
    unittest.main()
