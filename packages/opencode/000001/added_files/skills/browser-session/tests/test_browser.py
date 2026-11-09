"""browser-session のテスト。実行: python -m unittest discover -s skills/browser-session/tests -v   (リポジトリのルートから)

- 偽の WebSocket (CDP) のサーバーで、標準ライブラリだけの接続部分を確かめる (会社と同じく、ブラウザが無くても動く)
- Chrome / Edge があれば、画面なしで起動して、つなぎ直しと止める仕組みを、本物で確かめる (無ければ飛ばす)
"""
from __future__ import annotations

import base64
import hashlib
import http.server
import io
import json
import os
import socket
import socketserver
import struct
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL_DIR / "scripts"))

import browser_cli as cli  # noqa: E402
import browser_lib  # noqa: E402
import cdp  # noqa: E402

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def read_frame(conn: socket.socket) -> tuple[int, bytes]:
    head = conn.recv(2, socket.MSG_WAITALL)
    opcode, length = head[0] & 0x0F, head[1] & 0x7F
    masked = head[1] & 0x80
    if length == 126:
        length = struct.unpack("!H", conn.recv(2, socket.MSG_WAITALL))[0]
    elif length == 127:
        length = struct.unpack("!Q", conn.recv(8, socket.MSG_WAITALL))[0]
    mask = conn.recv(4, socket.MSG_WAITALL) if masked else b""
    data = conn.recv(length, socket.MSG_WAITALL) if length else b""
    if mask:
        data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    return opcode, data


def frame(opcode: int, data: bytes, final: bool = True) -> bytes:
    first = (0x80 if final else 0) | opcode
    if len(data) < 126:
        return bytes([first, len(data)]) + data
    if len(data) < 65536:
        return bytes([first, 126]) + struct.pack("!H", len(data)) + data
    return bytes([first, 127]) + struct.pack("!Q", len(data)) + data


class FakeCdpServer:
    """1 つの接続を受け、メッセージごとに決まった応答を返す、偽の CDP のサーバー。"""

    def __init__(self) -> None:
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(1)
        self.port = self.sock.getsockname()[1]
        self.received: list[dict] = []
        self.masked: list[bool] = []
        self.origin_sent = None
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def serve(self) -> None:
        conn, _ = self.sock.accept()
        request = b""
        while b"\r\n\r\n" not in request:
            request += conn.recv(1024)
        headers = dict(line.split(": ", 1) for line in request.decode().split("\r\n")[1:] if ": " in line)
        self.origin_sent = "Origin" in headers
        accept = base64.b64encode(hashlib.sha1((headers["Sec-WebSocket-Key"] + GUID).encode()).digest()).decode()
        conn.sendall(f"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n".encode())
        while True:
            try:
                opcode, data = read_frame(conn)
            except (OSError, IndexError):
                return
            if opcode == 0x8:
                conn.close()
                return
            if opcode == 0xA:
                continue
            message = json.loads(data)
            self.received.append(message)
            method, mid = message["method"], message["id"]
            if method == "Test.event":  # 応答の前に、イベントと ping を挟む
                conn.sendall(frame(0x1, json.dumps({"method": "Page.loadEventFired", "params": {}}).encode()))
                conn.sendall(frame(0x9, b"hi"))
                conn.sendall(frame(0x1, json.dumps({"id": mid, "result": {"ok": True}}).encode()))
            elif method == "Test.big":  # 長い応答 (127 の長さ)
                conn.sendall(frame(0x1, json.dumps({"id": mid, "result": {"data": "あ" * 30000}}).encode()))
            elif method == "Test.fragmented":  # 断片に分けた応答
                body = json.dumps({"id": mid, "result": {"part": "ok"}}).encode()
                conn.sendall(frame(0x1, body[:10], final=False) + frame(0x0, body[10:]))
            elif method == "Test.error":
                conn.sendall(frame(0x1, json.dumps({"id": mid, "error": {"message": "だめ"}}).encode()))
            elif method == "Test.silent":
                pass
            else:
                conn.sendall(frame(0x1, json.dumps({"id": mid, "result": {"echo": message["params"]}}).encode()))


class WebSocketTests(unittest.TestCase):
    def test_応答_イベント_ping_長い応答_断片_エラー(self) -> None:
        server = FakeCdpServer()
        client = cdp.Cdp(f"ws://127.0.0.1:{server.port}/devtools/page/X", timeout=3)
        try:
            self.assertEqual(client.call("Test.echo", text="日本語" * 100)["echo"]["text"], "日本語" * 100)  # 送る側の長さ 126
            self.assertEqual(client.call("Test.event"), {"ok": True})
            self.assertEqual(client.events[0]["method"], "Page.loadEventFired")
            self.assertIsNotNone(client.wait_event("Page.loadEventFired", timeout=0.1))
            self.assertEqual(len(client.call("Test.big")["data"]), 30000)
            self.assertEqual(client.call("Test.fragmented"), {"part": "ok"})
            with self.assertRaises(cdp.CdpError):
                client.call("Test.error")
            with self.assertRaises(cdp.CdpTimeout):
                client.call("Test.silent", timeout=0.3)
            self.assertFalse(server.origin_sent)  # Origin を送らない (Chrome の --remote-allow-origins が要らない)
        finally:
            client.close()

    def test_この_PC_以外にはつながない(self) -> None:
        for url in ("ws://192.168.0.10:9222/devtools/page/X", "ws://example.com/x", "wss://127.0.0.1/x"):
            with self.assertRaises(cdp.CdpError, msg=url):
                cdp.WebSocket(url, timeout=0.5)


class FakePage(browser_lib.Page):
    """要素の情報を差し替えて、止める仕組みだけを確かめる。"""

    def __init__(self, info: dict, allow_submit: bool = False, method: str = "") -> None:
        self.allow_submit = allow_submit
        self.info_value = info
        self.method = method
        self.clicked = False

    def find(self, selector=None, text=None, nth=0, exact=False):  # noqa: ANN001, ANN201
        return self.info_value

    def _mouse_click(self, x, y, clicks=1):  # noqa: ANN001, ANN201
        self.clicked = True

    def js(self, expression, await_promise=True):  # noqa: ANN001, ANN201
        return self.method


class GuardTests(unittest.TestCase):
    def test_送信_削除などの文字と_POSTの送信ボタンは止め_許可で押す(self) -> None:
        base = {"x": 1, "y": 1, "tag": "button", "type": "", "form_method": "", "disabled": False}
        cases = [({"text": "送信する"}, True), ({"text": "削除"}, True), ({"text": "Submit"}, True), ({"text": "申請"}, True),
                 ({"text": "保存", "form_method": "post"}, True), ({"text": "検索", "type": "submit", "form_method": "get"}, False),
                 ({"text": "次へ", "tag": "a"}, False), ({"text": "詳細を見る"}, False)]
        for change, blocked in cases:
            page = FakePage({**base, **change})
            if blocked:
                with self.assertRaises(browser_lib.DangerousAction, msg=change):
                    page.click(text="x")
                allowed = FakePage({**base, **change}, allow_submit=True)
                allowed.click(text="x")
                self.assertTrue(allowed.clicked)
            else:
                page.click(text="x")
                self.assertTrue(page.clicked, change)

    def test_POSTのフォームのEnterは止める(self) -> None:
        with self.assertRaises(browser_lib.DangerousAction):
            FakePage({}, method="post").press("Enter")


class CliTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.cwd = Path(self._tmp.name).resolve()
        self.config = self.cwd / "cfg.json"
        self.config.write_text(json.dumps({"browser": "chrome", "port": free_port()}), encoding="utf-8")

    def run_cli(self, *argv: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        code = cli.main(list(argv), stdout=out, stderr=err, cwd=self.cwd, config_path=self.config)
        return code, out.getvalue(), err.getvalue()

    def test_ブラウザが無ければ案内する(self) -> None:
        code, out, _ = self.run_cli("status")
        self.assertEqual(code, 3)
        self.assertIn("start で起動する", out)
        for command in (["tabs"], ["snapshot"], ["open", "http://127.0.0.1/"], ["run", "a.py"]):
            code, _, err = self.run_cli(*command)
            self.assertEqual(code, 2, command)
            self.assertIn("エラー:", err)

    def test_設定の検査(self) -> None:
        for bad in ({"browser": "firefox"}, {"port": 80}, {"executable": "/無い/chrome"}):
            self.config.write_text(json.dumps(bad), encoding="utf-8")
            code = self.run_cli("start")[0]
            self.assertEqual(code, 2, bad)

    def test_スクリプトは作業フォルダの中の_py_だけ(self) -> None:
        outside = Path(tempfile.mkdtemp()) / "a.py"
        outside.write_text("print(1)", encoding="utf-8")
        self.addCleanup(outside.unlink)
        (self.cwd / "a.txt").write_text("x", encoding="utf-8")
        for raw in (str(outside), "a.txt", "無い.py"):
            with self.assertRaises(cli.CliError):
                cli.resolve_script(raw, self.cwd)

    def test_削除_シェルを使わない(self) -> None:
        for name in ("browser_cli.py", "browser_lib.py", "cdp.py"):
            source = (SKILL_DIR / "scripts" / name).read_text(encoding="utf-8")
            for needle in (".unlink(", "rmtree", "os.remove", "shell=True", "os.system", "eval(", "urlopen(\"http://0", "0.0.0.0"):
                self.assertNotIn(needle, source, f"{name}: {needle}")


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def chrome_path() -> str | None:
    for browser in ("chrome", "edge"):
        try:
            return cli.find_executable(browser, "")
        except cli.CliError:
            continue
    return None


PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>試験の検索</title></head><body>
<h1>部品の検索</h1><form method="get" action="result.html"><label for="kw">検索語</label><input id="kw" name="kw">
<select name="cat"><option value="">すべて</option><option value="bolt">ボルト</option></select><button type="submit">検索</button></form>
<form method="post" action="/x"><input name="memo"><button>保存</button></form><input type="password" id="pw"></body></html>"""
RESULT = """<!doctype html><html><head><meta charset="utf-8"><title>結果</title></head><body><h2>検索結果</h2>
<table><tr><th>品番</th><th>名前</th></tr><tr><td>B-16</td><td>ボルト M16</td></tr></table></body></html>"""


@unittest.skipUnless(chrome_path() and os.environ.get("BROWSER_SESSION_SKIP_REAL") != "1", "Chrome / Edge が無い")
class RealBrowserTests(unittest.TestCase):
    """本物のブラウザ (画面なし) で、つなぎ直し・入力・検索・表の読み取り・止める仕組みを確かめる。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        root = Path(cls._tmp.name).resolve()
        (root / "site").mkdir()
        (root / "site" / "index.html").write_text(PAGE, encoding="utf-8")
        (root / "site" / "result.html").write_text(RESULT, encoding="utf-8")
        handler = lambda *a, **k: http.server.SimpleHTTPRequestHandler(*a, directory=str(root / "site"), **k)  # noqa: E731
        http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
        cls.httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.site = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        cls.work = root / "work"
        cls.work.mkdir()
        cls.port = free_port()
        cls.config = root / "cfg.json"
        browser = "chrome" if "Chrome" in chrome_path() or "chrome" in chrome_path() else "edge"
        cls.config.write_text(json.dumps({"browser": browser, "port": cls.port, "profile_dir": str(root / "profile")}), encoding="utf-8")
        code, out, err = cls.run_cli("start", "--headless")
        assert code == 0, out + err

    @classmethod
    def tearDownClass(cls) -> None:
        try:
            version = cdp.http_json(cls.port, "/json/version")
            browser = cdp.Cdp(version["webSocketDebuggerUrl"])
            try:
                browser.call("Browser.close", timeout=3)
            except cdp.CdpError:
                pass
            finally:
                browser.close()
        except cdp.CdpError:
            pass
        cls.httpd.shutdown()
        cls.httpd.server_close()
        time.sleep(0.5)
        cls._tmp.cleanup()

    @classmethod
    def run_cli(cls, *argv: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        code = cli.main(list(argv), stdout=out, stderr=err, cwd=cls.work, config_path=cls.config)
        return code, out.getvalue(), err.getvalue()

    def script(self, name: str, body: str) -> str:
        path = self.work / ".handoff" / "browser" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")
        return f".handoff/browser/{name}"

    def test_つなぎ直しても前の続きから動き_止める仕組みが働く(self) -> None:
        code, out, err = self.run_cli("open", f"{self.site}/index.html")
        self.assertEqual(code, 0, out + err)
        code, out, _ = self.run_cli("snapshot")
        self.assertIn("入力 text 「検索語」 → #kw", out)
        self.assertIn("(パスワード: 人が入力する)", out)
        self.assertEqual(self.run_cli("run", self.script("a.py", "page.fill('#kw', 'ボルト')\npage.select('select[name=\"cat\"]', 'ボルト')\n"))[0], 0)
        code, out, err = self.run_cli("run", self.script("b.py", "print('前の続き', page.js(\"document.querySelector('#kw').value\"))\n"
                                                         "page.click(text='検索')\npage.wait_for(text='検索結果')\nprint(page.tables()[0][1])\n"))
        self.assertEqual(code, 0, out + err)
        self.assertIn("前の続き ボルト", out)
        self.assertIn("['B-16', 'ボルト M16']", out)
        self.assertIn("result.html?kw=", out)
        self.run_cli("run", self.script("c.py", f"page.goto('{self.site}/index.html')\n"))
        for body in ("page.fill('#pw', 'x')\n", "page.fill('input[name=memo]', 'x')\npage.click(text='保存')\n"):
            code, out, err = self.run_cli("run", self.script("d.py", body))
            self.assertEqual(code, 4, body)
            self.assertIn("止めました", err)
        code, out, err = self.run_cli("run", self.script("e.py", "page.click('#無い')\n"))
        self.assertEqual(code, 1)
        self.assertIn("e.py の 1 行目", err)
        code, out, _ = self.run_cli("run", self.script("f.py", "print(page.save_json({'a': 1}, '結果.json').name)\npage.save_text('x', '../../外.txt')\n"))
        self.assertEqual(code, 1)
        self.assertFalse((self.work / "外.txt").exists())
        self.assertEqual(self.run_cli("close")[0], 0)
        self.assertEqual(self.run_cli("snapshot")[0], 2)


def has_playwright() -> bool:
    try:
        import playwright.sync_api  # noqa: F401
        return True
    except ImportError:
        return False


@unittest.skipUnless(has_playwright(), "Playwright が入っていない")
class PlaywrightTests(RealBrowserTests):
    """同じタブに Playwright でつなぐ。ページの中の見張りが、Playwright からの送信・パスワードの入力も止める。"""

    def test_つなぎ直しても前の続きから動き_止める仕組みが働く(self) -> None:  # 親の試験は、ここでは繰り返さない
        pass

    def test_Playwrightで同じタブを操作し_送信とパスワードは止まり_タブは残る(self) -> None:
        self.assertEqual(self.run_cli("open", f"{self.site}/index.html")[0], 0)
        code, out, err = self.run_cli("run", self.script("p1.py", "pw = page.playwright()\npw.get_by_label('検索語').fill('ボルト')\n"))
        self.assertEqual(code, 0, out + err)
        code, out, err = self.run_cli("run", self.script("p2.py", "pw = page.playwright()\nprint('前の続き', pw.locator('#kw').input_value())\n"
                                                         "pw.get_by_role('button', name='検索').click()\npw.get_by_text('検索結果').wait_for()\nprint(page.tables()[0][1])\n"))
        self.assertEqual(code, 0, out + err)
        self.assertIn("前の続き ボルト", out)
        self.assertIn("['B-16', 'ボルト M16']", out)
        self.run_cli("run", self.script("p3.py", f"page.goto('{self.site}/index.html')\n"))
        code, out, err = self.run_cli("run", self.script("p4.py", "pw = page.playwright()\npw.locator('input[name=memo]').fill('x')\npw.get_by_role('button', name='保存').click()\n"
                                                         "print('URL', pw.url)\n"))
        self.assertEqual(code, 4, out + err)
        self.assertIn("止めました (ページの中の見張り): 押す: 「保存」", err)
        self.assertIn("index.html", out)  # 送信されていない
        code, out, err = self.run_cli("run", self.script("p5.py", "pw = page.playwright()\npw.locator('#pw').fill('secret')\nprint('値', repr(pw.locator('#pw').input_value()))\n"))
        self.assertEqual(code, 4, out + err)
        self.assertIn("値 ''", out)
        self.assertIn("パスワード欄への入力", err)
        code, out, err = self.run_cli("run", self.script("p6.py", "pw = page.playwright()\npw.locator('#kw').press('Enter')\n"))  # GET の検索は Enter で送ってよい
        self.assertEqual(code, 0, out + err)
        self.assertEqual(self.run_cli("status")[0], 0)
        self.assertIn("作業中のタブ: 結果", self.run_cli("status")[1])  # Playwright を切っても、タブは残る


if __name__ == "__main__":
    unittest.main()
