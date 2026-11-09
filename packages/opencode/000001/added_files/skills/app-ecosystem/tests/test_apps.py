"""app-ecosystem のテスト (標準ライブラリだけ)。

5 つのアプリを真似た偽のサーバーを立て、コマンドの組み立て・整形・安全の決まりを確かめる。
- 呼ぶ先はこの PC だけ (設定で外の住所は拒否)
- 書き込み (task-add / task-update) は --dry-run なら何も送らない。送るのは変わる項目だけ
- 最終日 (人の言う期限) と、ガントの終了日 (最終日の翌日) の変換
- 削除・コマンド実行・OS のアプリ起動の API は、コードに書かれていない
"""
from __future__ import annotations

import io
import json
import re
import sys
import tempfile
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))

import apps_cli as cli  # noqa: E402
import apps_core as core  # noqa: E402

MANIFEST_LINKS = {
    "search": {"home": "/", "search": "/?q={q}&search_all=1", "search_in": "/?q={q}&full_path={folder}"},
    "gantt": {"home": "/"},
    "files": {"home": "/", "folder": "/?path={path}"},
    "diff": {"home": "/", "result": "/?result_id={result_id}", "markdown": "/?markdown_path={path}", "git": "/?git_path={path}"},
    "draw": {"home": "/", "open": "/?filepath={path}"},
}


class FakeApp:
    """1 つのアプリの偽物。routes[(method, path)] = 関数(query, body) -> (status, json)。"""

    def __init__(self, name: str, *, manifest: bool = True, app_id: str | None = None):
        self.name = name
        self.requests: list[tuple[str, str, dict, object]] = []
        self.routes: dict[tuple[str, str], object] = {("GET", "/api/health"): lambda q, b: (200, {"status": "ok"})}
        if manifest:
            self.routes[("GET", "/api/ecosystem")] = lambda q, b: (200, {"ecosystem": 1, "app": app_id or name, "title": name, "version": "9.9.9", "base_url": self.url, "links": MANIFEST_LINKS[name], "operations": []})
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):  # noqa: D401 - テストの出力を静かにする
                pass

            def _handle(self, method: str) -> None:
                parsed = urllib.parse.urlparse(self.path)
                query = {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()}
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length).decode("utf-8")) if length else None
                fake.requests.append((method, parsed.path, query, body))
                route = fake.routes.get((method, parsed.path))
                if route is None:
                    route = next((fn for (m, p), fn in fake.routes.items() if m == method and re.fullmatch(p, parsed.path)), None)
                status, payload = route(query, body) if route else (404, {"detail": "Not Found"})
                data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                self._handle("GET")

            def do_POST(self):
                self._handle("POST")

            def do_PUT(self):
                self._handle("PUT")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def writes(self) -> list[tuple[str, str, dict, object]]:
        return [r for r in self.requests if r[0] in ("POST", "PUT")]


def unused_url() -> str:
    server = ThreadingHTTPServer(("127.0.0.1", 0), BaseHTTPRequestHandler)
    port = server.server_address[1]
    server.server_close()
    return f"http://127.0.0.1:{port}"


TASKS = {
    1: {"id": 1, "text": "案件A", "start_date": "2026-11-01 00:00:00", "end_date": "2026-12-01 00:00:00", "progress": 0.2, "parent": 0, "memo": None, "ToDo": None},
    2: {"id": 2, "text": "図面のチェック", "start_date": "2026-11-05 00:00:00", "end_date": "2026-11-11 00:00:00", "progress": 0.4, "parent": 1, "memo": "長い" * 1000, "ToDo": "A社へ確認", "folder": "C:/Work/案件A"},
}


class AppsTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.apps = {name: FakeApp(name) for name in core.DEFAULT_APPS}
        for app in self.apps.values():
            self.addCleanup(app.close)
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name).resolve()
        self.write_config({name: app.url for name, app in self.apps.items()})
        gantt = self.apps["gantt"]
        gantt.routes[("GET", r"/api/tasks/(\d+)")] = self.get_task
        gantt.routes[("POST", "/api/tasks")] = lambda q, b: (200, {"id": 99, **b})
        gantt.routes[("PUT", r"/api/tasks/(\d+)")] = lambda q, b: (200, {**TASKS[2], **b})

    def get_task(self, query, body):
        task_id = int(self.apps["gantt"].requests[-1][1].rsplit("/", 1)[1])
        return (200, TASKS[task_id]) if task_id in TASKS else (404, {"detail": "Task not found"})

    def write_config(self, apps: dict[str, str], **extra) -> None:
        self.config = self.tmp / "config.local.json"
        self.config.write_text(json.dumps({"apps": apps, "timeout_sec": 2, **extra}), encoding="utf-8")

    def run_cli(self, *argv: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        code = cli.main(list(argv), stdout=out, stderr=err, cwd=self.tmp, config_path=self.config)
        return code, out.getvalue(), err.getvalue()


class ConfigTests(AppsTestCase):
    def test_既定は会社と同じポート(self) -> None:
        config = core.load_config(self.tmp / "none.json")
        self.assertEqual(config.apps["gantt"], "http://127.0.0.1:8000")
        self.assertEqual(config.apps["search"], "http://127.0.0.1:8079")
        self.assertEqual(config.apps["draw"], "http://127.0.0.1:3001")

    def test_外の住所は拒否(self) -> None:
        for url in ("http://192.168.0.5:8000", "http://example.com", "ftp://127.0.0.1:8000", "127.0.0.1:8000"):
            self.write_config({"gantt": url})
            code, _, err = self.run_cli("status")
            self.assertEqual(code, 2, url)
            self.assertIn("gantt", err)

    def test_知らないアプリ名は拒否(self) -> None:
        self.write_config({"mail": "http://127.0.0.1:1"})
        self.assertEqual(self.run_cli("status")[0], 2)


class StatusTests(AppsTestCase):
    def test_起動中と停止と古い版と別のアプリ(self) -> None:
        old = FakeApp("files", manifest=False)
        other = FakeApp("draw", app_id="gantt")
        self.addCleanup(old.close)
        self.addCleanup(other.close)
        self.write_config({**{n: a.url for n, a in self.apps.items()}, "search": unused_url(), "files": old.url, "draw": other.url})
        code, out, _ = self.run_cli("status")
        self.assertEqual(code, 0)
        self.assertRegex(out, r"起動中\s+gantt .*9\.9\.9")
        self.assertRegex(out, r"停止\s+search")
        self.assertIn("エコシステム API がありません (古い版か、別のアプリ)", out)
        self.assertIn("別のアプリが応答しました (app=gantt)", out)
        self.assertIn("起動中: 4 / 5", out)

    def test_全部止まっていたら終了コード3(self) -> None:
        self.write_config({name: unused_url() for name in core.DEFAULT_APPS})
        code, out, _ = self.run_cli("status")
        self.assertEqual(code, 3)
        self.assertIn("起動中: 0 / 5", out)


class LinksTests(AppsTestCase):
    def test_パスを_URLエンコードして埋める(self) -> None:
        (self.tmp / "図").mkdir()
        target = self.tmp / "図" / "申請 フロー.excalidraw.md"
        target.write_text("x", encoding="utf-8")
        code, out, _ = self.run_cli("links", "図/申請 フロー.excalidraw.md", "--q", "見積 金額")
        self.assertEqual(code, 0)
        quoted = urllib.parse.quote(str(target), safe="")
        self.assertIn(f"{self.apps['files'].url}/?path={quoted}", out)
        self.assertIn(f"{self.apps['draw'].url}/?filepath={quoted}", out)
        folder = urllib.parse.quote(str(self.tmp / "図"), safe="")
        self.assertIn(f"{self.apps['search'].url}/?q=%E8%A6%8B%E7%A9%8D%20%E9%87%91%E9%A1%8D&full_path={folder}", out)
        for app in self.apps.values():
            self.assertFalse(app.writes(), "links は何も書き込まない")

    def test_図でなければExcalidrawを出さない_停止中は印をつける(self) -> None:
        self.write_config({**{n: a.url for n, a in self.apps.items()}, "files": unused_url()})
        (self.tmp / "a.pdf").write_text("x", encoding="utf-8")
        _, out, _ = self.run_cli("links", "a.pdf")
        self.assertNotIn("Excalidraw", out)
        self.assertIn("停止中", out)

    def test_古い版のアプリには既定のひな形を使う(self) -> None:
        old = FakeApp("draw", manifest=False)
        self.addCleanup(old.close)
        self.write_config({**{n: a.url for n, a in self.apps.items()}, "draw": old.url})
        (self.tmp / "a.excalidraw").write_text("{}", encoding="utf-8")
        _, out, _ = self.run_cli("links", "a.excalidraw")
        self.assertIn(f"{old.url}/?filepath=", out)

    def test_見つからないパスは知らせる(self) -> None:
        _, out, _ = self.run_cli("links", "none/x.md")
        self.assertIn("見つかりません", out)


class TaskTests(AppsTestCase):
    def test_tasksは条件を渡して_読みやすく並べる(self) -> None:
        items = [
            {"id": 3, "text": "見積", "start": "2026-11-01", "end": "2026-11-05", "last_day": "2026-11-04", "progress": 0, "parent": 1, "path": "案件A", "kind": "task", "owner": "待", "pinned": True, "overdue": True, "days_left": -3, "todo": "電話", "has_memo": True},
            {"id": 4, "text": "提出", "start": "2026-11-07", "end": "2026-11-08", "last_day": "2026-11-07", "progress": 50, "parent": 0, "path": "", "kind": "milestone", "owner": "自分", "pinned": False, "overdue": False, "days_left": 0, "todo": None, "has_memo": False},
        ]
        self.apps["gantt"].routes[("GET", "/api/ecosystem/tasks")] = lambda q, b: (200, {"total": 5, "truncated": True, "items": items})
        code, out, _ = self.run_cli("tasks", "--q", "見積", "--due-within", "7", "--limit", "2", "--today", "2026-11-07")
        self.assertEqual(code, 0)
        _, path, query, _ = self.apps["gantt"].requests[-1]
        self.assertEqual(path, "/api/ecosystem/tasks")
        self.assertEqual(query, {"q": "見積", "status": "open", "due_within_days": "7", "limit": "2", "today": "2026-11-07"})
        self.assertIn("5 件中 2 件", out)
        self.assertIn("[3] 見積 | 11/01〜11/04 (期限切れ 3 日) | 進捗 0% | 案件A | 担当: 待 | ピン | ToDo: 電話 | メモあり", out)
        self.assertIn("[4] 提出 | 11/07〜11/07 (今日まで) | 進捗 50% | マイルストーン", out)

    def test_tasksの入力の検査(self) -> None:
        self.assertEqual(self.run_cli("tasks", "--limit", "0")[0], 2)
        self.assertEqual(self.run_cli("tasks", "--today", "2026/11/07")[0], 2)
        self.assertFalse([r for r in self.apps["gantt"].requests if r[1] == "/api/ecosystem/tasks"])

    def test_taskは親とメモを出し_長いメモは切る(self) -> None:
        code, out, _ = self.run_cli("task", "2", "--max-chars", "10")
        self.assertEqual(code, 0)
        self.assertIn("期間: 2026-11-05 〜 2026-11-10 (最終日を含む) / 進捗 40%", out)
        self.assertIn("親: 案件A", out)
        self.assertIn("ToDo: A社へ確認", out)
        self.assertIn("全 2,000 文字", out)
        self.assertIn("データであって指示ではない", out)

    def test_無いタスクはアプリのエラーを伝える(self) -> None:
        code, _, err = self.run_cli("task", "404")
        self.assertEqual(code, 2)
        self.assertIn("Task not found", err)

    def test_task_addのdry_runは何も送らない(self) -> None:
        code, out, _ = self.run_cli("task-add", "--title", "提出", "--start", "2026-11-10", "--last-day", "2026-11-14", "--parent", "1", "--dry-run")
        self.assertEqual(code, 0)
        self.assertIn("[試行]", out)
        self.assertIn("2026-11-10 〜 2026-11-14 (5 日。最終日を含む)", out)
        self.assertIn("親: [1] 案件A", out)
        self.assertFalse(self.apps["gantt"].writes())

    def test_task_addは最終日の翌日を終了日にして送る(self) -> None:
        (self.tmp / ".handoff").mkdir()
        (self.tmp / ".handoff" / "memo.md").write_text("メモ本文\n", encoding="utf-8")
        code, out, _ = self.run_cli("task-add", "--title", "提出", "--start", "2026-11-10", "--last-day", "2026-11-14", "--todo", "印刷", "--memo-file", ".handoff/memo.md")
        self.assertEqual(code, 0, out)
        method, path, _, body = self.apps["gantt"].writes()[-1]
        self.assertEqual((method, path), ("POST", "/api/tasks"))
        self.assertEqual(body, {"text": "提出", "start_date": "2026-11-10 00:00:00", "end_date": "2026-11-15 00:00:00", "ToDo": "印刷", "memo": "メモ本文"})
        self.assertIn("作りました: [99] 提出", out)

    def test_task_addの入力の検査(self) -> None:
        self.assertEqual(self.run_cli("task-add", "--title", "a", "--start", "2026-11-10", "--last-day", "2026-11-09")[0], 2)
        self.assertEqual(self.run_cli("task-add", "--title", " ", "--start", "2026-11-10")[0], 2)
        self.assertEqual(self.run_cli("task-add", "--title", "a", "--start", "11/10")[0], 2)
        self.assertEqual(self.run_cli("task-add", "--title", "a", "--start", "2026-11-10", "--parent", "404")[0], 2)
        self.assertEqual(self.run_cli("task-add", "--title", "a", "--start", "2026-11-10", "--memo-file", "none.md")[0], 2)
        self.assertFalse(self.apps["gantt"].writes())

    def test_task_updateは変わる項目だけを送る(self) -> None:
        code, out, _ = self.run_cli("task-update", "2", "--progress", "80", "--last-day", "2026-11-12", "--title", "図面のチェック", "--dry-run")
        self.assertEqual(code, 0)
        self.assertIn("進捗: 40% → 80%", out)
        self.assertIn("最終日: 2026-11-10 → 2026-11-12", out)
        self.assertNotIn("名前:", out)  # 同じ名前は変更に数えない
        self.assertFalse(self.apps["gantt"].writes())
        code, out, _ = self.run_cli("task-update", "2", "--progress", "80", "--last-day", "2026-11-12")
        self.assertEqual(code, 0)
        self.assertEqual(self.apps["gantt"].writes()[-1][1:], ("/api/tasks/2", {}, {"end_date": "2026-11-13 00:00:00", "progress": 0.8}))

    def test_task_updateの開始日だけの変更と_変化なし(self) -> None:
        self.run_cli("task-update", "2", "--start", "2026-11-06")
        self.assertEqual(self.apps["gantt"].writes()[-1][3], {"start_date": "2026-11-06 00:00:00", "end_date": "2026-11-11 00:00:00"})
        before = len(self.apps["gantt"].writes())
        code, out, _ = self.run_cli("task-update", "2", "--progress", "40")
        self.assertEqual(code, 0)
        self.assertIn("変わる項目がありません", out)
        self.assertEqual(len(self.apps["gantt"].writes()), before)
        self.assertEqual(self.run_cli("task-update", "2", "--start", "2026-11-20")[0], 2)  # 最終日より後
        self.assertEqual(self.run_cli("task-update", "2", "--progress", "120")[0], 2)

    def test_アプリの入力検証のエラーを読みやすく(self) -> None:
        self.apps["gantt"].routes[("POST", "/api/tasks")] = lambda q, b: (422, {"detail": [{"msg": "Field required"}]})
        code, _, err = self.run_cli("task-add", "--title", "a", "--start", "2026-11-10")
        self.assertEqual(code, 2)
        self.assertIn("HTTP 422", err)
        self.assertIn("Field required", err)


class TaskLinkTests(AppsTestCase):
    """ガントのタスクと Obsidian のノートをつなぐ (タスクの hyperlink にノートの絶対パス。ノートの名前は 名前【ID】.md)。"""

    def note(self, name: str) -> Path:
        folder = self.tmp / "01_data"
        folder.mkdir(exist_ok=True)
        path = folder / name
        path.write_text("x", encoding="utf-8")
        return path

    def test_dry_runは何も送らず_変更前後を見せる(self) -> None:
        path = self.note("見直し【2】.md")
        code, out, _ = self.run_cli("task-link", "2", "--note", "01_data/見直し【2】.md", "--dry-run")
        self.assertEqual(code, 0)
        self.assertIn("[試行]", out)
        self.assertIn(f"ノート: (なし) → {path}", out)
        self.assertFalse(self.apps["gantt"].writes())

    def test_絶対パスをhyperlinkに入れる(self) -> None:
        path = self.note("見直し【2】.md")
        code, out, _ = self.run_cli("task-link", "2", "--note", "01_data/見直し【2】.md")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.apps["gantt"].writes()[-1][1:], ("/api/tasks/2", {}, {"hyperlink": str(path)}))
        self.assertIn("つなぎました", out)
        self.assertNotIn("【2】がありません", out)

    def test_名前に_IDが無ければ知らせる_ほかのIDも(self) -> None:
        self.note("見直し.md")
        _, out, _ = self.run_cli("task-link", "2", "--note", "01_data/見直し.md", "--dry-run")
        self.assertIn("ファイル名に【2】がありません", out)
        self.note("見直し【9】.md")
        _, out, _ = self.run_cli("task-link", "2", "--note", "01_data/見直し【9】.md", "--dry-run")
        self.assertIn("別のタスクの ID【9】", out)

    def test_無いノート_Markdownでないもの_同じリンクは送らない(self) -> None:
        self.assertEqual(self.run_cli("task-link", "2", "--note", "none.md")[0], 2)
        (self.tmp / "a.png").write_bytes(b"x")
        self.assertEqual(self.run_cli("task-link", "2", "--note", "a.png")[0], 2)
        path = self.note("同じ【2】.md")
        TASKS[2]["hyperlink"] = str(path)
        self.addCleanup(TASKS[2].pop, "hyperlink")
        code, out, _ = self.run_cli("task-link", "2", "--note", str(path))
        self.assertEqual(code, 0)
        self.assertIn("すでにつながっています", out)
        self.assertFalse(self.apps["gantt"].writes())

    def test_一覧と詳細にノートが出る(self) -> None:
        item = {"id": 5, "text": "a", "start": "2026-11-01", "end": "2026-11-02", "last_day": "2026-11-01", "progress": 0, "parent": 0, "path": "", "kind": "task", "owner": "自分", "pinned": False, "overdue": False, "days_left": 3, "todo": None, "has_memo": False, "link": "まとめ【5】.md"}
        self.apps["gantt"].routes[("GET", "/api/ecosystem/tasks")] = lambda q, b: (200, {"total": 1, "truncated": False, "items": [item]})
        _, out, _ = self.run_cli("tasks")
        self.assertIn("ノート: まとめ【5】.md", out)
        TASKS[2]["hyperlink"] = "/v/01_data/図面のチェック【2】.md"
        self.addCleanup(TASKS[2].pop, "hyperlink")
        _, out, _ = self.run_cli("task", "2")
        self.assertIn("ノート: /v/01_data/図面のチェック【2】.md", out)


class ReviewTests(AppsTestCase):
    """資料 (Obsidian のノート) を更新した後、前回のコミットからの変更と、人が差分ツールで見る URL。"""

    def setUp(self) -> None:
        super().setUp()
        self.note = self.tmp / "01_data" / "file_manager 個人開発.md"
        self.note.parent.mkdir()
        self.note.write_text("x", encoding="utf-8")
        files = [
            {"path": "01_data/file_manager 個人開発.md", "kind": "text", "change_type": "modified", "embedded_excalidraw": True},
            {"path": "01_data/図_全体.excalidraw.md", "kind": "image", "change_type": "modified", "embedded_excalidraw": False},
            {"path": "01_data/新しい図.png", "kind": "image", "change_type": "untracked", "embedded_excalidraw": False},
        ]
        self.apps["diff"].routes[("GET", "/api/git/markdown")] = lambda q, b: (200, {"repo_root": str(self.tmp), "source_markdown": q.get("path"), "files": files, "diff_url": "http://127.0.0.1:8078/?markdown_path=X"})

    def test_変更の一覧と_人が見るURL(self) -> None:
        code, out, _ = self.run_cli("review", "01_data/file_manager 個人開発.md")
        self.assertEqual(code, 0, out)
        _, path, query, _ = self.apps["diff"].requests[-1]
        self.assertEqual((path, query["path"]), ("/api/git/markdown", str(self.note)))
        self.assertIn("ノートの本文: 変更あり", out)
        self.assertIn("[変更] 01_data/図_全体.excalidraw.md (図)", out)
        self.assertIn("[新規・未コミット] 01_data/新しい図.png (画像)", out)
        self.assertIn("人が差分ツールで見る: http://127.0.0.1:8078/?markdown_path=X", out)
        self.assertFalse(self.apps["diff"].writes(), "review は読み取りだけ")

    def test_本文が変わっていないとき(self) -> None:
        self.apps["diff"].routes[("GET", "/api/git/markdown")] = lambda q, b: (200, {"files": [], "diff_url": "http://x/?markdown_path=Y"})
        _, out, _ = self.run_cli("review", "01_data/file_manager 個人開発.md")
        self.assertIn("ノートの本文: 前回のコミットから変わっていません", out)
        self.assertIn("関係するファイルの変更: なし", out)

    def test_無いノート_Gitでない(self) -> None:
        self.assertEqual(self.run_cli("review", "none.md")[0], 2)
        self.apps["diff"].routes[("GET", "/api/git/markdown")] = lambda q, b: (404, {"detail": "Git リポジトリではありません"})
        code, _, err = self.run_cli("review", "01_data/file_manager 個人開発.md")
        self.assertEqual(code, 2)
        self.assertIn("Git リポジトリではありません", err)

    def test_linksにMarkdownの差分のURL(self) -> None:
        _, out, _ = self.run_cli("links", "01_data/file_manager 個人開発.md")
        self.assertIn(f"{self.apps['diff'].url}/?markdown_path=" + urllib.parse.quote(str(self.note), safe=""), out)

    def test_linksにフォルダとファイルの差分のURL(self) -> None:
        # 0.18.0: ファイルマネージャーの右クリック「差分を表示」と同じ画面 (?git_path=)
        (self.tmp / "a.pdf").write_bytes(b"x")
        for target in (self.tmp / "01_data", self.tmp / "a.pdf"):
            _, out, _ = self.run_cli("links", str(target))
            self.assertIn(f"差分ツール (Git の変更): {self.apps['diff'].url}/?git_path=" + urllib.parse.quote(str(target), safe=""), out)


class ReviewPathTests(AppsTestCase):
    """0.18.0: フォルダー・Markdown 以外のファイルの、前回のコミットからの変更と、人が差分ツールで見る URL (差分ツールの GET /api/git/path)。"""

    def setUp(self) -> None:
        super().setUp()
        self.folder = self.tmp / "src"
        self.folder.mkdir()
        (self.folder / "tool.py").write_text("x", encoding="utf-8")
        files = [
            {"path": "src/tool.py", "kind": "text", "change_type": "modified"},
            {"path": "src/図.png", "kind": "image", "change_type": "untracked"},
        ]
        self.apps["diff"].routes[("GET", "/api/git/path")] = lambda q, b: (200, {"repo_root": str(self.tmp), "files": files, "diff_url": "http://127.0.0.1:8078/?git_path=Z"})

    def test_フォルダーの変更の一覧と_人が見るURL(self) -> None:
        code, out, _ = self.run_cli("review", "src")
        self.assertEqual(code, 0, out)
        _, path, query, _ = self.apps["diff"].requests[-1]
        self.assertEqual((path, query["path"]), ("/api/git/path", str(self.folder)))
        self.assertIn("Git の変更 (前回のコミットから): src (フォルダー)", out)
        self.assertIn("[変更] src/tool.py (文章)", out)
        self.assertIn("[新規・未コミット] src/図.png (画像)", out)
        self.assertIn("人が差分ツールで見る: http://127.0.0.1:8078/?git_path=Z", out)
        self.assertFalse(self.apps["diff"].writes(), "review は読み取りだけ")

    def test_ファイル1つ_変更なし(self) -> None:
        self.apps["diff"].routes[("GET", "/api/git/path")] = lambda q, b: (200, {"files": [], "diff_url": "http://x/?git_path=Y"})
        code, out, _ = self.run_cli("review", "src/tool.py")
        self.assertEqual(code, 0, out)
        self.assertIn("Git の変更 (前回のコミットから): tool.py (ファイル)", out)
        self.assertIn("変更: なし", out)

    def test_対象拡張子の外とGitでないときは_差分ツールの理由を伝える(self) -> None:
        self.apps["diff"].routes[("GET", "/api/git/path")] = lambda q, b: (422, {"detail": "この拡張子（.py）は、Git差分の対象拡張子に入っていません"})
        code, _, err = self.run_cli("review", "src/tool.py")
        self.assertEqual(code, 2)
        self.assertIn("対象拡張子", err)

    def test_差分ツールが古いときは_更新を案内する(self) -> None:
        del self.apps["diff"].routes[("GET", "/api/git/path")]
        code, _, err = self.run_cli("review", "src")
        self.assertEqual(code, 2)
        self.assertIn("差分ツールが古い版", err)


class DiffAndRecentTests(AppsTestCase):
    def test_diffは絶対パスで送り_数値と位置だけを出す(self) -> None:
        (self.tmp / "a.png").write_bytes(b"a")
        (self.tmp / "b.png").write_bytes(b"b")
        result = {"result_id": "r1", "ui_url": "http://127.0.0.1:8078/?result_id=r1", "filename_a": "a.png", "filename_b": "b.png", "page_a": 0, "page_b": 1, "width": 800, "height": 600,
                  "alignment": {"success": True, "method": "not moved", "warning": None}, "diff_pixels": 4639, "diff_ratio": 0.0096, "threshold": 0.1, "rect_count": 3,
                  "rects": [{"x": 224, "y": 214, "width": 223, "height": 172, "area": 2065, "area_ratio": 0.0043, "position": "中中"}], "warnings": ["フォントを置き換えました"]}
        self.apps["diff"].routes[("POST", "/api/ecosystem/diff")] = lambda q, b: (200, result)
        code, out, _ = self.run_cli("diff", "a.png", "b.png", "--page-b", "1", "--max-rects", "1")
        self.assertEqual(code, 0)
        body = self.apps["diff"].writes()[-1][3]
        self.assertEqual(body["path_a"], str(self.tmp / "a.png"))
        self.assertEqual((body["page_b"], body["max_rects"], body["open_browser"]), (1, 1, False))
        self.assertIn("a.png (p.1) ↔ b.png (p.2) / 800×600 / 位置合わせ: 成功 (not moved)", out)
        self.assertIn("4,639 画素 (0.96%)、領域 3 個 (大きい順に 1 個)", out)
        self.assertIn("1. 中中  x=224 y=214 223×172 (画像の 0.43%)", out)
        self.assertIn("注意: フォントを置き換えました", out)
        self.assertIn("人が画面で見る: http://127.0.0.1:8078/?result_id=r1", out)

    def test_diffの違いなしと_無いファイル(self) -> None:
        (self.tmp / "a.png").write_bytes(b"a")
        self.apps["diff"].routes[("POST", "/api/ecosystem/diff")] = lambda q, b: (200, {"result_id": None, "ui_url": None, "filename_a": "a.png", "filename_b": "a.png", "page_a": 0, "page_b": 0, "width": 1, "height": 1, "alignment": {"success": True}, "diff_pixels": 0, "diff_ratio": 0, "threshold": 0.1, "rect_count": 0, "rects": [], "warnings": []})
        _, out, _ = self.run_cli("diff", "a.png", "a.png")
        self.assertIn("見つかりませんでした", out)
        self.assertEqual(self.run_cli("diff", "a.png", "none.png")[0], 2)

    def test_接続できなければ終了コード3(self) -> None:
        self.write_config({**{n: a.url for n, a in self.apps.items()}, "files": unused_url()})
        code, _, err = self.run_cli("recent")
        self.assertEqual(code, 3)
        self.assertIn("起動しているか確認してください", err)

    def test_recentは新しい順(self) -> None:
        self.apps["files"].routes[("GET", "/api/history")] = lambda q, b: (200, [{"path": "C:/old", "count": 1, "timestamp": 1_700_000_000}, {"path": "C:/new", "count": 5, "timestamp": 1_800_000_000}, {"bad": 1}])
        code, out, _ = self.run_cli("recent", "--limit", "1")
        self.assertEqual(code, 0)
        self.assertIn("2 件中 1 件", out)
        self.assertIn("5 回  C:/new", out)
        self.assertNotIn("C:/old", out)


class SafetyTests(unittest.TestCase):
    def test_削除_実行_OSのアプリ起動のAPIを呼ばない(self) -> None:
        source = "\n".join(p.read_text(encoding="utf-8") for p in (HERE.parent / "scripts").glob("*.py"))
        self.assertNotIn('"DELETE"', source)
        for forbidden in ("/api/run-command", "/api/open/", "/api/delete", "/api/fullpath", "/api/open-path", "/api/open-file", "/api/save-file", "/api/index/reset", "/api/terminal", "/api/move", "/api/rename", "/api/launcher"):
            self.assertNotIn(forbidden, source, forbidden)

    def test_書き込みはtask_addとtask_updateだけ(self) -> None:
        source = (HERE.parent / "scripts" / "apps_cli.py").read_text(encoding="utf-8")
        writes = re.findall(r'request_json\(config, "(\w+)", "(POST|PUT)", (f?"[^"]+")', source)
        self.assertEqual(sorted(writes), sorted([("gantt", "POST", '"/api/tasks"'), ("gantt", "PUT", 'f"/api/tasks/{task[\'id\']}"'), ("gantt", "PUT", 'f"/api/tasks/{task[\'id\']}"'), ("diff", "POST", '"/api/ecosystem/diff"')]))


if __name__ == "__main__":
    unittest.main()
