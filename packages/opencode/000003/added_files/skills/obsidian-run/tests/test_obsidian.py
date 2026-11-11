"""obsidian_cli のテスト。本物の Obsidian は使わず、Local REST API を真似た偽のサーバー (自分の PC の中) で確認する。

実行: python -m unittest discover -s skills/obsidian-run/tests -v   (リポジトリのルートから)
"""
from __future__ import annotations

import http.server
import io
import json
import os
import re
import socketserver
import sys
import tempfile
import threading
import unicodedata
import unittest
import urllib.parse
from pathlib import Path
from typing import Callable
from unittest.mock import patch

SKILL_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL_DIR / "scripts"))

import obsidian_cli as cli  # noqa: E402

API_KEY = "SECRET-KEY-for-tests-123"


class FakeObsidian:
    """Local REST API の GET / と GET /commands/ と POST /commands/<id>/ だけを真似る。"""

    def __init__(self) -> None:
        self.requests: list[tuple[str, str, str | None]] = []
        self.commands = [{"id": "editor:toggle-bold", "name": "Toggle bold"}, {"id": "my-plugin:export-html", "name": "My plugin: export html"}, {"id": "app:delete-file", "name": "Delete current file"}]
        self.executed: list[str] = []
        self.opened: list[tuple[str, bool]] = []  # (デコードしたパス, newLeaf)
        self.on_execute: Callable[[str], None] | None = None
        self.post_status = 204
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args) -> None:  # noqa: ANN002
                pass

            def _auth_ok(self) -> bool:
                return self.headers.get("Authorization") == f"Bearer {API_KEY}"

            def _send(self, code: int, body: dict | None = None) -> None:
                data = json.dumps(body).encode() if body is not None else b""
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self) -> None:  # noqa: N802
                owner.requests.append(("GET", self.path, self.headers.get("Authorization")))
                if self.path == "/":
                    self._send(200, {"status": "OK", "authenticated": self._auth_ok()})
                elif self.path == "/commands/":
                    self._send(200, {"commands": owner.commands}) if self._auth_ok() else self._send(401, {"message": "Authorization required"})
                else:
                    self._send(404, {"message": "not found"})

            def do_POST(self) -> None:  # noqa: N802
                owner.requests.append(("POST", self.path, self.headers.get("Authorization")))
                if not self._auth_ok():
                    return self._send(401, {"message": "Authorization required"})
                if self.path.startswith("/commands/") and self.path.endswith("/"):
                    command_id = self.path[len("/commands/"):-1]
                    if command_id not in {c["id"] for c in owner.commands}:
                        return self._send(404, {"message": "The command you specified does not exist."})
                    owner.executed.append(command_id)
                    if owner.on_execute:
                        owner.on_execute(command_id)
                    return self._send(owner.post_status)
                if self.path.startswith("/open/"):  # 本物と同じく、パスを decodeURIComponent して開く (無ければ作る)
                    raw, _, query = self.path[len("/open/"):].partition("?")
                    owner.opened.append((urllib.parse.unquote(raw), "newLeaf=true" in query))
                    return self._send(200, {})
                self._send(404, {"message": "not found"})

        class Server(http.server.HTTPServer):
            def server_bind(self) -> None:  # getfqdn で遅くならないように
                socketserver.TCPServer.server_bind(self)
                self.server_name, self.server_port = "127.0.0.1", self.server_address[1]

        self.server = Server(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


class FakeClock:
    """sleep で時間が進み、決めた時刻に、決めた動作 (ファイルの作成など) が起きる。"""

    def __init__(self) -> None:
        self.now = 0.0
        self.events: list[tuple[float, Callable[[], None]]] = []

    def clock(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.now += seconds
        for event in [e for e in self.events if e[0] <= self.now]:
            self.events.remove(event)
            event[1]()


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name).resolve()
        self.vault = self.tmp / "vault"
        (self.vault / ".obsidian").mkdir(parents=True)
        (self.vault / "01_data" / "2026").mkdir(parents=True)
        self.fake = FakeObsidian()
        self.addCleanup(self.fake.close)
        self.clock = FakeClock()
        patcher = patch.dict(os.environ, {"OBSIDIAN_API_KEY": API_KEY})
        patcher.start()
        self.addCleanup(patcher.stop)

    def write_config(self, **overrides) -> Path:
        config = {
            "api": {"url": self.fake.url, "key_env": "OBSIDIAN_API_KEY"},
            "vault": str(self.vault),
            "commands": {"export-html": {"id": "my-plugin:export-html", "description": "HTML を書き出す", "watch": ["01_data"], "settle_sec": 2, "wait_sec": 10}},
        }
        config.update(overrides)
        path = self.tmp / "config.local.json"
        path.write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")
        return path

    def run_cli(self, *argv: str, config: Path | None = None) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        code = cli.main(list(argv), stdout=out, stderr=err, config_path=config or self.write_config(), clock=self.clock.clock, sleep=self.clock.sleep)
        return code, out.getvalue(), err.getvalue()

    def make(self, rel: str, content: str = "x") -> Path:
        path = self.vault / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path


class ConfigTests(Base):
    def load(self, **overrides) -> cli.Config:
        return cli.load_config(self.write_config(**overrides))

    def test_正しい設定(self) -> None:
        config = self.load()
        self.assertEqual(config.commands["export-html"].watch, ["01_data"])
        self.assertEqual(config.commands["export-html"].settle_sec, 2)

    def test_設定ファイルが無い_壊れている(self) -> None:
        with self.assertRaises(cli.ConfigError) as ctx:
            cli.load_config(self.tmp / "none.json")
        self.assertIn("config.sample.json", str(ctx.exception))
        bad = self.tmp / "bad.json"
        bad.write_text("{", encoding="utf-8")
        with self.assertRaises(cli.ConfigError):
            cli.load_config(bad)

    def test_APIキーを設定ファイルに書かせない(self) -> None:
        with self.assertRaises(cli.ConfigError) as ctx:
            self.load(api={"url": self.fake.url, "key": "abc"})
        self.assertIn("環境変数", str(ctx.exception))
        self.assertNotIn("abc", str(ctx.exception))

    def test_接続先は自分のPCだけ(self) -> None:
        for url in ("https://example.com:27124", "http://192.168.0.5:27123", "http://10.0.0.1", "ftp://127.0.0.1", "127.0.0.1:27124"):
            with self.assertRaises(cli.ConfigError, msg=url):
                self.load(api={"url": url})
        for url in ("http://127.0.0.1:27123", "https://localhost:27124", "http://[::1]:27123"):
            self.assertEqual(self.load(api={"url": url}).url, url)

    def test_vaultの検査(self) -> None:
        with self.assertRaises(cli.ConfigError):
            self.load(vault=str(self.tmp / "ない"))
        (self.tmp / "plain").mkdir()
        with self.assertRaises(cli.ConfigError) as ctx:
            self.load(vault=str(self.tmp / "plain"))
        self.assertIn(".obsidian", str(ctx.exception))
        with self.assertRaises(cli.ConfigError):
            self.load(vault="")

    def test_commandsの検査(self) -> None:
        good = {"id": "a:b", "watch": []}
        for commands in ({"Bad Name": good}, {"a": {"id": "has space"}}, {"a": {"id": "a/b"}}, {"a": {"id": ""}}, {"a": {"id": "a:b", "watch": "x"}},
                         {"a": {"id": "a:b", "settle_sec": 999}}, {"a": {"id": "a:b", "wait_sec": 0}}, {"a": "text"}):
            with self.assertRaises(cli.ConfigError, msg=str(commands)):
                self.load(commands=commands)

    def test_watchの検査(self) -> None:
        def watch(value: str) -> list[str]:
            return self.load(commands={"a": {"id": "a:b", "watch": [value]}}).commands["a"].watch
        self.assertEqual(watch("01_data\\2026"), ["01_data/2026"])
        self.assertEqual(watch("01_data/"), ["01_data"])
        self.assertEqual(watch("."), ["."])
        for bad in ("../outside", "01_data/../../x", "C:/Windows", "C:\\x", "..\\x", "/01_data", "\\01_data"):
            with self.assertRaises(cli.ConfigError, msg=bad):
                watch(bad)

    def test_watchがvaultの外へのシンボリックリンクなら拒否(self) -> None:
        outside = self.tmp / "outside"
        outside.mkdir()
        try:
            os.symlink(outside, self.vault / "link")
        except (OSError, NotImplementedError):
            self.skipTest("シンボリックリンクを作れない環境")
        with self.assertRaises(cli.ConfigError):
            self.load(commands={"a": {"id": "a:b", "watch": ["link"]}})


class ApiTests(Base):
    def test_接続とコマンド一覧(self) -> None:
        config = cli.load_config(self.write_config())
        api = cli.Api(config, API_KEY)
        self.assertEqual(api.status()["status"], "OK")
        self.assertIn("my-plugin:export-html", {c["id"] for c in api.list_commands()})

    def test_APIキーが違うと分かるメッセージ_キーは出さない(self) -> None:
        config = cli.load_config(self.write_config())
        with self.assertRaises(cli.ApiError) as ctx:
            cli.Api(config, "WRONG-KEY").list_commands()
        self.assertIn("401", str(ctx.exception))
        self.assertNotIn("WRONG-KEY", str(ctx.exception))

    def test_キーが無いとき(self) -> None:
        config = cli.load_config(self.write_config())
        with self.assertRaises(cli.ApiError) as ctx:
            cli.Api(config, None).list_commands()
        self.assertIn("OBSIDIAN_API_KEY", str(ctx.exception))
        self.assertEqual([r for r in self.fake.requests if r[1] == "/commands/"], [])  # キー無しでは送らない

    def test_接続できないとき(self) -> None:
        self.fake.close()
        config = cli.load_config(self.write_config())
        with self.assertRaises(cli.ApiError) as ctx:
            cli.Api(config, API_KEY).status()
        self.assertIn("Obsidian に接続できません", str(ctx.exception))
        self.fake = FakeObsidian()  # tearDown の close 用

    def test_TLSの設定(self) -> None:
        config = cli.load_config(self.write_config(api={"url": "https://127.0.0.1:27124"}))
        self.assertIsNotNone(cli.Api(config, API_KEY).context)
        self.assertIsNone(cli.Api(cli.load_config(self.write_config()), API_KEY).context)  # http は TLS なし
        with self.assertRaises(cli.ConfigError):
            cli.load_config(self.write_config(api={"url": "https://127.0.0.1:27124", "ca_file": str(self.tmp / "ない.crt")}))


class RunTests(Base):
    def test_新規_更新_削除を検出して報告する(self) -> None:
        old = self.make("01_data/2026/old.md", "古い")
        gone = self.make("01_data/2026/gone.md", "消える")
        os.utime(old, (1_000_000, 1_000_000))

        def on_execute(_: str) -> None:
            self.clock.events.append((1.0, lambda: (self.make("01_data/2026/print.html", "<html/>"), old.write_text("新しい内容", encoding="utf-8"), gone.unlink())))
        self.fake.on_execute = on_execute
        code, out, err = self.run_cli("run", "export-html")
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(self.fake.executed, ["my-plugin:export-html"])
        self.assertIn("実行しました: export-html (my-plugin:export-html)", out)
        self.assertIn("変化: 3 件", out)
        self.assertIn("新規: 01_data/2026/print.html (7 B)", out)
        self.assertIn("更新: 01_data/2026/old.md", out)
        self.assertIn("削除: 01_data/2026/gone.md", out)

    def test_変化が止まるまで待つ(self) -> None:
        def on_execute(_: str) -> None:
            self.clock.events.append((1.0, lambda: self.make("01_data/a.html")))
            self.clock.events.append((2.5, lambda: self.make("01_data/b.html")))  # 続けて 2 つ目ができる
        self.fake.on_execute = on_execute
        _, out, _ = self.run_cli("run", "export-html")
        self.assertIn("変化: 2 件", out)  # 1 つ目だけで終わらない
        self.assertIn("b.html", out)

    def test_変化が無いときは成功と言い切らない(self) -> None:
        code, out, _ = self.run_cli("run", "export-html")
        self.assertEqual(code, 0)
        self.assertEqual(self.fake.executed, ["my-plugin:export-html"])
        self.assertIn("検出できませんでした", out)
        self.assertIn("成功とは言い切れません", out)
        self.assertGreaterEqual(self.clock.now, 10)  # wait_sec まで待った

    def test_隠しフォルダと一時ファイルは変化に数えない(self) -> None:
        def on_execute(_: str) -> None:
            self.clock.events.append((1.0, lambda: (self.make(".obsidian/workspace.json"), self.make("01_data/.hidden/x.md"), self.make("01_data/~$lock.docx"), self.make("01_data/.dot.md"))))
        self.fake.on_execute = on_execute
        _, out, _ = self.run_cli("run", "export-html")
        self.assertIn("検出できませんでした", out)

    def test_監視の外の変化は数えない(self) -> None:
        def on_execute(_: str) -> None:
            self.clock.events.append((1.0, lambda: self.make("02_MOC/x.md")))
        self.fake.on_execute = on_execute
        _, out, _ = self.run_cli("run", "export-html")
        self.assertIn("検出できませんでした", out)

    def test_許可していない名前は実行しない(self) -> None:
        code, out, err = self.run_cli("run", "delete-file")
        self.assertEqual(code, 2)
        self.assertIn("許可したコマンドにありません", err)
        self.assertIn("export-html", err)
        self.assertEqual([r for r in self.fake.requests if r[0] == "POST"], [])
        self.assertEqual(self.fake.requests, [])  # 何も送っていない

    def test_コマンドIDをそのまま指定しても実行できない(self) -> None:
        code, _, err = self.run_cli("run", "app:delete-file")
        self.assertEqual(code, 2)
        self.assertEqual([r for r in self.fake.requests if r[0] == "POST"], [])

    def test_Obsidianにそのコマンドが無いときは実行しない(self) -> None:
        self.fake.commands = [c for c in self.fake.commands if c["id"] != "my-plugin:export-html"]
        code, _, err = self.run_cli("run", "export-html")
        self.assertEqual(code, 3)
        self.assertIn("そのコマンドがありません", err)
        self.assertEqual([r for r in self.fake.requests if r[0] == "POST"], [])

    def test_実行が失敗したとき(self) -> None:
        self.fake.post_status = 500
        code, _, err = self.run_cli("run", "export-html")
        self.assertEqual(code, 3)
        self.assertIn("500", err)

    def test_dry_runは何も送らない_キーも要らない(self) -> None:
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("OBSIDIAN_API_KEY", None)
            code, out, _ = self.run_cli("run", "export-html", "--dry-run")
        self.assertEqual(code, 0)
        self.assertIn("実際には何も実行していません", out)
        self.assertEqual(self.fake.requests, [])

    def test_dry_runでも許可していない名前は拒否(self) -> None:
        self.assertEqual(self.run_cli("run", "nope", "--dry-run")[0], 2)

    def test_監視が未設定のときは場所を人に確認する(self) -> None:
        config = self.write_config(commands={"x": {"id": "my-plugin:export-html", "watch": []}})
        code, out, _ = self.run_cli("run", "x", config=config)
        self.assertEqual(code, 0)
        self.assertIn("監視するフォルダが未設定", out)

    def test_一覧が長くなりすぎない(self) -> None:
        def on_execute(_: str) -> None:
            self.clock.events.append((1.0, lambda: [self.make(f"01_data/f{i:03}.md") for i in range(50)]))
        self.fake.on_execute = on_execute
        _, out, _ = self.run_cli("run", "export-html")
        self.assertIn("変化: 50 件", out)
        self.assertIn("… ほか 20 件", out)
        self.assertLess(len(out.splitlines()), 40)

    def test_監視が大きすぎるとき(self) -> None:
        with patch.object(cli, "MAX_SNAPSHOT_FILES", 3):
            for i in range(5):
                self.make(f"01_data/f{i}.md")
            code, _, err = self.run_cli("run", "export-html")
        self.assertEqual(code, 2)
        self.assertIn("狭くしてください", err)
        self.assertEqual([r for r in self.fake.requests if r[0] == "POST"], [])  # 実行前に止まる


class OtherCommandTests(Base):
    def test_list(self) -> None:
        code, out, _ = self.run_cli("list")
        self.assertEqual(code, 0)
        self.assertIn("export-html: HTML を書き出す", out)
        self.assertIn("id: my-plugin:export-html", out)
        self.assertEqual(self.fake.requests, [])  # 通信しない

    def test_commandsは許可済みに印を付け_実行はしない(self) -> None:
        code, out, _ = self.run_cli("commands", "--grep", "export html")
        self.assertIn("該当 1 個", out)
        self.assertIn("my-plugin:export-html | My plugin: export html  ← 許可済み (export-html)", out)
        self.assertNotIn("toggle-bold", out)
        code, out, _ = self.run_cli("commands")
        self.assertIn("全部で 3 個", out)
        self.assertEqual(self.fake.executed, [])
        self.assertEqual([r for r in self.fake.requests if r[0] == "POST"], [])

    def test_commandsの件数制限(self) -> None:
        self.fake.commands = [{"id": f"p:c{i}", "name": f"C{i}"} for i in range(100)]
        _, out, _ = self.run_cli("commands", "--limit", "5")
        self.assertIn("… ほか 95 個", out)

    def test_check(self) -> None:
        code, out, err = self.run_cli("check")
        self.assertEqual((code, err), (0, ""))
        self.assertIn("接続OK", out)
        self.assertNotIn("未実施", out)
        self.assertIn("export-html: Obsidian にあります", out)

    def test_checkでキーが無いとき(self) -> None:
        os.environ.pop("OBSIDIAN_API_KEY", None)
        code, out, _ = self.run_cli("check")
        self.assertEqual(code, 3)
        self.assertIn("環境変数 OBSIDIAN_API_KEY が未設定", out)

    def test_checkでidが違うとき(self) -> None:
        config = self.write_config(commands={"x": {"id": "no:such", "watch": []}})
        code, out, _ = self.run_cli("check", config=config)
        self.assertEqual(code, 3)
        self.assertIn("Obsidian にありません", out)

    def test_APIキーはどの出力にも出ない(self) -> None:
        outputs = []
        for argv in (("check",), ("list",), ("commands",), ("run", "export-html"), ("run", "export-html", "--dry-run"), ("run", "nope")):
            outputs.extend(self.run_cli(*argv)[1:])
        with patch.dict(os.environ, {"OBSIDIAN_API_KEY": "WRONG-" + API_KEY}):
            outputs.extend(self.run_cli("check")[1:])
            outputs.extend(self.run_cli("run", "export-html")[1:])
        for text in outputs:
            self.assertNotIn(API_KEY, text)
            self.assertNotIn("WRONG-", text)
        for method, path, auth in self.fake.requests:
            self.assertNotIn("SECRET", path)  # URL にも入れない


class OpenTests(Base):
    def setUp(self) -> None:
        super().setUp()
        self.make("01_data/2026/11/07/報告書.md")
        self.make("01_data/2026/11/08/議事録.md")
        self.make("01_data/2026/11/09/議事録.md")
        self.make("01_data/2026/11/09/図_流れ.excalidraw.md")
        self.make("Media/資料.pdf")
        self.make("Media/tool.exe")
        self.make("01_data/2026/11/09/a#b.md")
        self.make(".obsidian/workspace.json", "{}")
        self.make(".trash/消した.md")

    def test_名前で開く_リンクの形も出す(self) -> None:
        code, out, err = self.run_cli("open", "報告書")
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(self.fake.opened, [("01_data/2026/11/07/報告書.md", False)])
        self.assertIn("開きました: 01_data/2026/11/07/報告書.md (いまのタブ)", out)
        self.assertIn("リンク: [[報告書]]", out)

    def test_いろいろな指定の形(self) -> None:
        for target in ("報告書.md", "[[報告書]]", "[[報告書|別名]]", "[[報告書#結論]]", "07/報告書", "01_data\\2026\\11\\07\\報告書.md", str(self.vault / "01_data/2026/11/07/報告書.md")):
            self.fake.opened.clear()
            code, _, err = self.run_cli("open", target)
            self.assertEqual((code, err, self.fake.opened), (0, "", [("01_data/2026/11/07/報告書.md", False)]), target)

    def test_新しいタブ(self) -> None:
        self.run_cli("open", "報告書", "--new-tab")
        self.assertEqual(self.fake.opened, [("01_data/2026/11/07/報告書.md", True)])

    def test_Macの濁点の分解と大文字小文字をそろえる(self) -> None:
        self.make("01_data/2026/11/10/" + unicodedata.normalize("NFD", "ガイド") + ".md")
        self.make("01_data/2026/11/10/ReadMe.md")
        self.assertEqual(self.run_cli("open", "ガイド")[0], 0)
        self.assertEqual(self.run_cli("open", "readme")[0], 0)
        self.assertEqual(len(self.fake.opened), 2)

    def test_無いノートは開かない_作らない(self) -> None:
        code, _, err = self.run_cli("open", "ない")
        self.assertEqual(code, 2)
        self.assertIn("ノートは作りません", err)
        self.assertEqual([r for r in self.fake.requests if r[0] == "POST"], [])  # 本物は、無いパスを渡すと作ってしまう

    def test_同名が複数なら候補を出して開かない(self) -> None:
        code, out, _ = self.run_cli("open", "議事録")
        self.assertEqual(code, 2)
        self.assertIn("候補が 2 個", out)
        self.assertIn("01_data/2026/11/08/議事録.md  [[01_data/2026/11/08/議事録]]", out)
        self.assertEqual(self.fake.opened, [])
        code, out, _ = self.run_cli("open", "09/議事録")
        self.assertEqual(code, 0)
        self.assertIn("リンク: [[01_data/2026/11/09/議事録]]", out)  # 同名があるのでフォルダつき

    def test_図とPDFは開ける_ほかの種類は開かない(self) -> None:
        self.assertEqual(self.run_cli("open", "図_流れ.excalidraw")[0], 0)
        self.assertEqual(self.run_cli("open", "Media/資料.pdf")[0], 0)
        code, _, err = self.run_cli("open", "tool.exe")
        self.assertEqual(code, 2)
        self.assertIn("この種類のファイル", err)
        self.assertEqual([p for p, _ in self.fake.opened], ["01_data/2026/11/09/図_流れ.excalidraw.md", "Media/資料.pdf"])

    def test_危ない指定は通信しない(self) -> None:
        for target in ("../外.md", ".obsidian/workspace.json", ".trash/消した.md", "消した", "a#b", "", "[[]]", "/etc/hosts", str(self.tmp / "外.md")):
            code, _, err = self.run_cli("open", target)
            self.assertEqual(code, 2, target)
            self.assertTrue(err, target)
        self.assertEqual([r for r in self.fake.requests if r[0] == "POST"], [])

    def test_シンボリックリンクの先は探さない(self) -> None:
        outside = self.tmp / "outside"
        outside.mkdir()
        (outside / "外のノート.md").write_text("x", encoding="utf-8")
        try:
            (self.vault / "link").symlink_to(outside, target_is_directory=True)
        except OSError:
            self.skipTest("シンボリックリンクを作れない環境")
        code, _, _ = self.run_cli("open", "外のノート")
        self.assertEqual(code, 2)
        self.assertEqual(self.fake.opened, [])

    def test_dry_runは通信しない_キーも要らない(self) -> None:
        os.environ.pop("OBSIDIAN_API_KEY", None)
        code, out, _ = self.run_cli("open", "報告書", "--dry-run")
        self.assertEqual(code, 0)
        self.assertIn("[試行] 開くノート: 01_data/2026/11/07/報告書.md", out)
        self.assertEqual(self.fake.requests, [])

    def test_キーが無い_違うとき(self) -> None:
        os.environ.pop("OBSIDIAN_API_KEY", None)
        code, _, err = self.run_cli("open", "報告書")
        self.assertEqual(code, 3)
        self.assertIn("API キーがありません", err)
        with patch.dict(os.environ, {"OBSIDIAN_API_KEY": "WRONG-" + API_KEY}):
            code, out, err = self.run_cli("open", "報告書")
        self.assertEqual(code, 3)
        self.assertNotIn("WRONG-", out + err)
        self.assertEqual(self.fake.opened, [])

    def test_許可リストが空でも開ける(self) -> None:
        code, _, _ = self.run_cli("open", "報告書", config=self.write_config(commands={}))
        self.assertEqual(code, 0)
        self.assertEqual(self.fake.executed, [])  # コマンドは実行しない


class SafetyTests(unittest.TestCase):
    def test_ソースが呼ぶのは_コマンドの一覧と実行とノートを開くだけ(self) -> None:
        source = (SKILL_DIR / "scripts" / "obsidian_cli.py").read_text(encoding="utf-8")
        self.assertEqual(source.count("urlopen("), 1)
        self.assertEqual(sorted(set(re.findall(r'_call\("([A-Z]+)", "([^"]*)"', source))), [("GET", "/"), ("GET", "/commands/"), ("POST", "/commands/"), ("POST", "/open/")])
        for needle in ("/vault", "/active", "/search", "/periodic", '"DELETE"', '"PUT"', '"PATCH"', "subprocess", "os.system", "eval(", "exec(", ".unlink(", "rmtree", "write_text", "write_bytes", "shutil"):
            self.assertNotIn(needle, source, f"obsidian_cli.py に {needle} があります")

    def test_サンプル設定にAPIキーの値が無い(self) -> None:
        sample = (SKILL_DIR / "config.sample.json").read_text(encoding="utf-8")
        self.assertNotIn('"key"', sample)
        self.assertIn("key_env", sample)


if __name__ == "__main__":
    unittest.main()
