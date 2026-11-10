"""project_init のテスト。実行: python -m unittest discover -s skills/project-init/tests -v   (リポジトリのルートから)"""
from __future__ import annotations

import io
import os
import sys
import tempfile
import unittest
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL_DIR / "scripts"))

import project_init as cli  # noqa: E402

TEMPLATE_TEXT = "<!-- テンプレート -->\n\n# 【プロジェクト名】\n\n【説明】\n\n## 作業の進め方\n\n- 日本語で書く。\n"
DOC_TEMPLATE_TEXT = "<!-- 資料のテンプレート -->\n\n# 【プロジェクト名】\n\n- 読者: 【読者】\n"
CS_TEMPLATE_TEXT = "<!-- C# のテンプレート -->\n\n# 【プロジェクト名】\n\n- .NET の版: 【版】\n"


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name).resolve()
        self.home = self.tmp / "home"
        self.harness = self.tmp / "harness"
        self.home.mkdir()
        self.harness.mkdir()
        self.template = self.tmp / "template.md"
        self.template.write_text(TEMPLATE_TEXT, encoding="utf-8")
        self.doc_template = self.tmp / "doc_template.md"
        self.doc_template.write_text(DOC_TEMPLATE_TEXT, encoding="utf-8")
        self.cs_template = self.tmp / "cs_template.md"
        self.cs_template.write_text(CS_TEMPLATE_TEXT, encoding="utf-8")
        self.proj = self.tmp / "work" / "proj"
        (self.proj / ".git").mkdir(parents=True)

    def run_cli(self, *argv: str, cwd: Path | None = None, template: Path | None = None, raw: bool = False) -> tuple[int, str, str]:
        """plan / apply で AGENTS.md の元を指定していなければ、--template coding を足す (raw=True なら足さない)。"""
        args = list(argv)
        if not raw and args and args[0] in ("plan", "apply") and "--template" not in args and "--agents-file" not in args:
            args += ["--template", "coding"]
        out, err = io.StringIO(), io.StringIO()
        templates = {"coding": template or self.template, "csharp": self.cs_template, "document": self.doc_template}
        code = cli.main(args, stdout=out, stderr=err, cwd=cwd or self.tmp, templates=templates, home=self.home, harness=self.harness)
        return code, out.getvalue(), err.getvalue()

    def listing(self, folder: Path | None = None) -> set[str]:
        base = folder or self.proj
        return {p.relative_to(base).as_posix() for p in base.rglob("*") if ".git" not in p.relative_to(base).parts}

    def snapshot(self, folder: Path | None = None) -> dict[str, bytes | None]:
        base = folder or self.proj
        return {p.relative_to(base).as_posix(): (p.read_bytes() if p.is_file() else None) for p in base.rglob("*")}


class CheckAndPlanTests(Base):
    def test_checkは何も書かず_足りないものを示す(self) -> None:
        before = self.snapshot()
        code, out, err = self.run_cli("check", str(self.proj))
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(self.snapshot(), before)
        self.assertIn("Git: あります", out)
        self.assertIn("足りないもの: AGENTS.md, .handoff/, .gitignore", out)

    def test_planは何も書かず_置く内容を示す(self) -> None:
        before = self.snapshot()
        code, out, _ = self.run_cli("plan", str(self.proj))
        self.assertEqual(code, 0)
        self.assertEqual(self.snapshot(), before)
        self.assertIn("[作る] AGENTS.md", out)
        self.assertIn("[作る] .handoff/", out)
        self.assertIn("[作る] .gitignore", out)
        self.assertIn("実際には何も書いていません", out)

    def test_相対パスは作業フォルダ基準(self) -> None:
        code, out, _ = self.run_cli("check", "work/proj", cwd=self.tmp)
        self.assertEqual(code, 0)
        self.assertIn(str(self.proj), out)

    def test_Gitのルートでないときは警告する(self) -> None:
        sub = self.proj / "sub"
        sub.mkdir()
        _, out, _ = self.run_cli("check", str(sub))
        self.assertIn("リポジトリの途中", out)
        self.assertIn("Git のルートではありません", out)
        plain = self.tmp / "plain"
        plain.mkdir()
        _, out2, _ = self.run_cli("check", str(plain))
        self.assertIn("Git で管理されていません", out2)
        self.assertIn("git init は、このスクリプトでは実行しません", out2)
        self.assertIn("エージェントが承認を得てから実行", out2)
        self.assertIn("git init はしません (入れ子のリポジトリになるため)", out)


class ApplyTests(Base):
    def test_すべて置く(self) -> None:
        code, out, err = self.run_cli("apply", str(self.proj))
        self.assertEqual((code, err), (0, ""))
        self.assertEqual((self.proj / "AGENTS.md").read_text(encoding="utf-8"), TEMPLATE_TEXT)
        self.assertTrue((self.proj / ".handoff").is_dir())
        ignore = (self.proj / ".gitignore").read_text(encoding="utf-8")
        for entry in (".handoff/", ".venv/", "__pycache__/"):
            self.assertIn(entry + "\n", ignore)
        self.assertIn("埋まっていない【 】が 2 個残っています", out)

    def test_二回目は何もしない(self) -> None:
        self.run_cli("apply", str(self.proj))
        before = self.snapshot()
        code, out, _ = self.run_cli("apply", str(self.proj))
        self.assertEqual(code, 0)
        self.assertEqual(self.snapshot(), before)
        self.assertIn("何もする必要がありません", out)

    def test_既存のAGENTS_mdは触らない(self) -> None:
        (self.proj / "AGENTS.md").write_text("既存の内容\n", encoding="utf-8")
        _, out, _ = self.run_cli("apply", str(self.proj))
        self.assertEqual((self.proj / "AGENTS.md").read_text(encoding="utf-8"), "既存の内容\n")
        self.assertIn("あります (AGENTS.md)。触りません", out)

    def test_大文字小文字が違う既存の名前も触らない(self) -> None:
        (self.proj / "agents.md").write_text("既存\n", encoding="utf-8")
        self.run_cli("apply", str(self.proj))
        same = [p for p in self.proj.iterdir() if p.name.lower() == "agents.md"]
        self.assertEqual(len(same), 1, "大文字小文字だけ違う AGENTS.md を、もう 1 つ作ってはいけません")
        self.assertEqual(same[0].read_text(encoding="utf-8"), "既存\n")

    def test_CLAUDE_mdだけのとき_AGENTS_mdは作らない(self) -> None:
        (self.proj / "CLAUDE.md").write_text("クロードの指示\n", encoding="utf-8")
        _, out, _ = self.run_cli("apply", str(self.proj))
        self.assertFalse((self.proj / "AGENTS.md").exists())
        self.assertEqual((self.proj / "CLAUDE.md").read_text(encoding="utf-8"), "クロードの指示\n")
        self.assertIn("CLAUDE.md を最初に読む", out)  # 作らない理由を示す
        self.assertTrue((self.proj / ".handoff").is_dir())  # ほかは置く
        self.assertTrue((self.proj / ".gitignore").is_file())

    def test_名前が違う大文字のClaude_mdでも作らない(self) -> None:
        (self.proj / "Claude.md").write_text("x\n", encoding="utf-8")
        self.run_cli("apply", str(self.proj))
        self.assertFalse(any(p.name.lower() == "agents.md" for p in self.proj.iterdir()))

    def test_nameで見出しを置き換える(self) -> None:
        self.run_cli("apply", str(self.proj), "--name", "橋梁の設計計算")
        text = (self.proj / "AGENTS.md").read_text(encoding="utf-8")
        self.assertIn("# 橋梁の設計計算\n", text)
        self.assertNotIn("【プロジェクト名】", text)

    def test_nameが不正なら何も作らない(self) -> None:
        before = self.snapshot()
        code, _, err = self.run_cli("apply", str(self.proj), "--name", "a\nb")
        self.assertEqual(code, 2)
        self.assertIn("--name", err)
        self.assertEqual(self.snapshot(), before)

    def test_テンプレートに見出しが無いのにnameを指定したらエラー(self) -> None:
        bad = self.tmp / "bad.md"
        bad.write_text("見出しなし\n", encoding="utf-8")
        before = self.snapshot()
        code, _, err = self.run_cli("apply", str(self.proj), "--name", "x", template=bad)
        self.assertEqual(code, 2)
        self.assertIn("プロジェクト名の行", err)
        self.assertEqual(self.snapshot(), before)

    def test_テンプレートが無ければ何も作らない(self) -> None:
        before = self.snapshot()
        code, _, err = self.run_cli("apply", str(self.proj), template=self.tmp / "none.md")
        self.assertEqual(code, 2)
        self.assertIn("テンプレートがありません", err)
        self.assertEqual(self.snapshot(), before)

    def test_ファイルの排他的作成は上書きしない(self) -> None:
        target = self.tmp / "x.txt"
        target.write_text("元\n", encoding="utf-8")
        with self.assertRaises(FileExistsError):
            cli.create_new_file(target, "新\n")
        self.assertEqual(target.read_text(encoding="utf-8"), "元\n")


class GitignoreTests(Base):
    def apply(self) -> str:
        code, out, err = self.run_cli("apply", str(self.proj))
        self.assertEqual((code, err), (0, ""))
        return out

    def test_既存の内容を保ち_足りない行だけを末尾に足す(self) -> None:
        original = "node_modules/\n*.log\n.venv/\n"
        (self.proj / ".gitignore").write_bytes(original.encode("utf-8"))
        self.apply()
        data = (self.proj / ".gitignore").read_bytes().decode("utf-8")
        self.assertTrue(data.startswith(original))
        added = data[len(original):]
        self.assertIn(".handoff/", added)
        self.assertIn("__pycache__/", added)
        self.assertNotIn(".venv/", added)  # 既にあるものは足さない
        self.assertEqual(data.count(".venv/"), 1)

    def test_改行がCRLFならCRLFで足す(self) -> None:
        (self.proj / ".gitignore").write_bytes(b"dist/\r\n*.log\r\n")
        self.apply()
        data = (self.proj / ".gitignore").read_bytes()
        self.assertTrue(data.startswith(b"dist/\r\n*.log\r\n"))
        added = data[len(b"dist/\r\n*.log\r\n"):]
        self.assertNotIn(b"\n", added.replace(b"\r\n", b""))  # 追記分の改行はすべて CRLF

    def test_末尾に改行が無くても行が連結しない(self) -> None:
        (self.proj / ".gitignore").write_bytes("dist/".encode("utf-8"))
        self.apply()
        lines = (self.proj / ".gitignore").read_text(encoding="utf-8").splitlines()
        self.assertIn("dist/", lines)
        self.assertIn(".handoff/", lines)

    def test_別の書き方でも既にあるとみなす(self) -> None:
        (self.proj / ".gitignore").write_text(".handoff\n/.venv/\n**/__pycache__\n", encoding="utf-8")
        before = (self.proj / ".gitignore").read_bytes()
        out = self.apply()
        self.assertEqual((self.proj / ".gitignore").read_bytes(), before)
        self.assertIn("必要な行が揃っています", out)

    def test_コメントの中の名前は既にあるとみなさない(self) -> None:
        (self.proj / ".gitignore").write_text("# .handoff/ はあとで\n", encoding="utf-8")
        self.apply()
        lines = [ln for ln in (self.proj / ".gitignore").read_text(encoding="utf-8").splitlines() if not ln.startswith("#")]
        self.assertIn(".handoff/", lines)

    def test_除外しない行がある場合は足さずに警告する(self) -> None:
        (self.proj / ".gitignore").write_text("!.handoff/\n", encoding="utf-8")
        out = self.apply()
        text = (self.proj / ".gitignore").read_text(encoding="utf-8")
        self.assertNotIn("\n.handoff/\n", "\n" + text.replace("!.handoff/", "!X"))
        self.assertIn("除外しない行", out)

    def test_UTF8でないgitignoreは触らず_何も作らない(self) -> None:
        (self.proj / ".gitignore").write_bytes("日本語\n".encode("cp932"))
        before = self.snapshot()
        code, _, err = self.run_cli("apply", str(self.proj))
        self.assertEqual(code, 2)
        self.assertIn("UTF-8 ではありません", err)
        self.assertEqual(self.snapshot(), before)

    def test_BOMつきでも壊さない(self) -> None:
        original = b"\xef\xbb\xbfdist/\n"
        (self.proj / ".gitignore").write_bytes(original)
        self.apply()
        data = (self.proj / ".gitignore").read_bytes()
        self.assertTrue(data.startswith(original))

    @unittest.skipUnless(hasattr(os, "symlink"), "シンボリックリンクが使えない環境")
    def test_gitignoreがリンクなら触らない(self) -> None:
        real = self.tmp / "real_ignore"
        real.write_text("x\n", encoding="utf-8")
        try:
            os.symlink(real, self.proj / ".gitignore")
        except OSError:
            self.skipTest("リンクを作れない")
        self.apply()
        self.assertEqual(real.read_text(encoding="utf-8"), "x\n")


class HandoffTests(Base):
    def test_handoffがファイルなら触らず警告する(self) -> None:
        (self.proj / ".handoff").write_text("ファイル\n", encoding="utf-8")
        code, out, _ = self.run_cli("apply", str(self.proj))
        self.assertEqual(code, 0)
        self.assertEqual((self.proj / ".handoff").read_text(encoding="utf-8"), "ファイル\n")
        self.assertIn(".handoff がフォルダではありません", out)

    def test_handoffが既にあれば中身に触らない(self) -> None:
        (self.proj / ".handoff").mkdir()
        (self.proj / ".handoff" / "memo.md").write_text("残す\n", encoding="utf-8")
        self.run_cli("apply", str(self.proj))
        self.assertEqual((self.proj / ".handoff" / "memo.md").read_text(encoding="utf-8"), "残す\n")


class RefusalTests(Base):
    def assert_refused(self, folder: Path, expect: str) -> None:
        before = self.snapshot(folder) if (folder.is_dir() and cli.is_within(folder, self.tmp)) else None  # 一時フォルダの外 (ルート、/usr など) は走査しない
        code, _, err = self.run_cli("apply", str(folder))
        self.assertEqual(code, 2, err)
        self.assertIn(expect, err)
        if before is not None:
            self.assertEqual(self.snapshot(folder), before)

    def test_ホームフォルダそのものは拒否(self) -> None:
        self.assert_refused(self.home, "ホームフォルダ")

    def test_ハーネス自身とその中は拒否(self) -> None:
        self.assert_refused(self.harness, "ハーネス自身")
        (self.harness / "skills").mkdir()
        self.assert_refused(self.harness / "skills", "ハーネス自身")

    def test_ドライブやルートは拒否(self) -> None:
        root = Path(self.tmp.anchor)
        self.assert_refused(root, "ルート")

    def test_gitの中は拒否(self) -> None:
        self.assert_refused(self.proj / ".git", ".git の中")

    @unittest.skipUnless(os.name == "posix" and Path("/usr").is_dir() and not Path("/usr").is_symlink(), "POSIX の /usr が使える環境のみ")
    def test_システムのフォルダは拒否(self) -> None:
        self.assert_refused(Path("/usr"), "システムのフォルダ")

    def test_存在しないフォルダとファイルはエラー(self) -> None:
        code, _, err = self.run_cli("apply", str(self.tmp / "ない"))
        self.assertEqual(code, 2)
        self.assertIn("フォルダがありません", err)
        a_file = self.tmp / "a.txt"
        a_file.write_text("x", encoding="utf-8")
        code, _, err = self.run_cli("apply", str(a_file))
        self.assertEqual(code, 2)
        self.assertIn("フォルダではありません", err)

    def test_空のフォルダ指定はエラー(self) -> None:
        code, _, err = self.run_cli("apply", "  ")
        self.assertEqual(code, 2)
        self.assertIn("指定されていません", err)

    def test_checkとplanも同じ拒否をする(self) -> None:
        for command in ("check", "plan"):
            code, _, err = self.run_cli(command, str(self.home))
            self.assertEqual(code, 2, command)
            self.assertIn("ホームフォルダ", err)


class SurveyAndChoiceTests(Base):
    """0.19.0: 中身を見てテンプレートを推奨し、draft の下書きを埋めて、--agents-file で置く。"""

    def test_空のフォルダは推奨なし(self) -> None:
        code, out, _ = self.run_cli("check", str(self.proj))
        self.assertEqual(code, 0)
        self.assertIn("中身: ファイル 0 個", out)
        self.assertIn("テンプレートの推奨: なし — 中身がありません", out)
        self.assertIn("coding (プログラム・設計計算・解析)", out)
        self.assertIn("csharp (C# (.NET) のプログラム)", out)

    def test_プログラムの手がかりがあればcoding(self) -> None:
        (self.proj / "package.json").write_text("{}", encoding="utf-8")
        (self.proj / "src").mkdir()
        (self.proj / "src" / "a.ts").write_text("x", encoding="utf-8")
        (self.proj / "README.md").write_text("# a", encoding="utf-8")
        (self.proj / "node_modules" / "x").mkdir(parents=True)
        (self.proj / "node_modules" / "x" / "b.js").write_text("x", encoding="utf-8")
        before = self.snapshot()
        _, out, _ = self.run_cli("check", str(self.proj))
        self.assertEqual(self.snapshot(), before)
        self.assertIn("テンプレートの推奨: coding", out)
        self.assertIn("プログラムの手がかり: package.json", out)
        self.assertIn("先に読む: README.md", out)
        self.assertIn("中身: ファイル 3 個 (プログラム 1、モデル 0、資料 1)", out)  # node_modules は数えない

    def test_C_Sharpの手がかりがあればcsharp(self) -> None:
        # 0.23.0: .sln・.csproj・global.json などと、.cs のファイル。bin/ obj/ は数えない
        (self.proj / "App.sln").write_text("x", encoding="utf-8")
        (self.proj / "src" / "App").mkdir(parents=True)
        (self.proj / "src" / "App" / "App.csproj").write_text("<Project />", encoding="utf-8")
        (self.proj / "src" / "App" / "Program.cs").write_text("x", encoding="utf-8")
        (self.proj / "README.md").write_text("# a", encoding="utf-8")
        (self.proj / "obj").mkdir()
        (self.proj / "obj" / "Generated.cs").write_text("x", encoding="utf-8")
        before = self.snapshot()
        _, out, _ = self.run_cli("check", str(self.proj))
        self.assertEqual(self.snapshot(), before)
        self.assertIn("テンプレートの推奨: csharp (C# (.NET) のプログラム)", out)
        self.assertIn("C# の手がかり: App.sln, src/App/App.csproj", out)
        self.assertIn("中身: ファイル 4 個 (プログラム 1、モデル 0、資料 1)", out)  # obj/ (生成された .cs) は数えない
        self.assertNotIn("プログラムの手がかり:", out)

    def test_C_Sharpのファイルだけでもcsharp_プロジェクトの印だけでもcsharp(self) -> None:
        (self.proj / "Calc.cs").write_text("x", encoding="utf-8")
        _, out, _ = self.run_cli("check", str(self.proj))
        self.assertIn("テンプレートの推奨: csharp", out)
        (self.proj / "Calc.cs").unlink()
        (self.proj / "App.slnx").write_text("x", encoding="utf-8")
        _, out, _ = self.run_cli("check", str(self.proj))
        self.assertIn("テンプレートの推奨: csharp", out)

    def test_PythonがC_Sharpより多ければcoding(self) -> None:
        (self.proj / "Tool.cs").write_text("x", encoding="utf-8")
        (self.proj / "requirements.txt").write_text("x", encoding="utf-8")
        for name in ("a.py", "b.py", "c.py"):
            (self.proj / name).write_text("x", encoding="utf-8")
        _, out, _ = self.run_cli("check", str(self.proj))
        self.assertIn("テンプレートの推奨: coding", out)

    def test_資料だけならdocument(self) -> None:
        (self.proj / "source").mkdir()
        for name in ("基準.pdf", "報告.docx", "手順.md"):
            (self.proj / "source" / name).write_bytes(b"x")
        _, out, _ = self.run_cli("check", str(self.proj))
        self.assertIn("テンプレートの推奨: document", out)

    def test_既にAGENTS_mdがあれば中身は調べない(self) -> None:
        (self.proj / "AGENTS.md").write_text("既存\n", encoding="utf-8")
        _, out, _ = self.run_cli("check", str(self.proj))
        self.assertNotIn("テンプレートの推奨", out)

    def test_元を指定しないplanとapplyは止める(self) -> None:
        before = self.snapshot()
        for command in ("plan", "apply"):
            code, _, err = self.run_cli(command, str(self.proj), raw=True)
            self.assertEqual(code, 2, command)
            self.assertIn("--agents-file", err)
        self.assertEqual(self.snapshot(), before)

    def test_draftは_handoffに下書きを書き_埋める所を示す(self) -> None:
        code, out, err = self.run_cli("draft", str(self.proj), "--template", "document", "--name", "締付の手順書")
        self.assertEqual((code, err), (0, ""))
        draft = self.proj / ".handoff" / "project-init_AGENTS.md"
        self.assertEqual(draft.read_text(encoding="utf-8"), DOC_TEMPLATE_TEXT.replace("# 【プロジェクト名】", "# 締付の手順書"))
        self.assertIn("埋める【 】: 1 個", out)
        self.assertIn("【読者】", out)
        self.assertEqual(self.listing(), {".handoff", ".handoff/project-init_AGENTS.md"})
        self.run_cli("draft", str(self.proj), "--template", "coding")
        self.assertTrue((self.proj / ".handoff" / "project-init_AGENTS_2.md").is_file())  # 上書きしない
        self.assertEqual(draft.read_text(encoding="utf-8"), DOC_TEMPLATE_TEXT.replace("# 【プロジェクト名】", "# 締付の手順書"))

    def test_既存のAGENTS_mdがあればdraftも作らない(self) -> None:
        (self.proj / "CLAUDE.md").write_text("x\n", encoding="utf-8")
        code, _, err = self.run_cli("draft", str(self.proj), "--template", "coding")
        self.assertEqual(code, 2)
        self.assertIn("下書きも作りません", err)
        self.assertFalse((self.proj / ".handoff").exists())

    def test_埋めた下書きから置く(self) -> None:
        self.run_cli("draft", str(self.proj), "--template", "document")
        draft = self.proj / ".handoff" / "project-init_AGENTS.md"
        filled = "# 締付の手順書\n\n- 読者: 入社 1 年目の作業者\n"
        draft.write_text(filled, encoding="utf-8")
        code, out, _ = self.run_cli("plan", str(self.proj), "--agents-file", str(draft))
        self.assertEqual(code, 0)
        self.assertIn("[作る] AGENTS.md: 下書きから作る", out)
        self.assertNotIn("埋まっていない", out)
        code, out, _ = self.run_cli("apply", str(self.proj), "--agents-file", ".handoff/project-init_AGENTS.md", cwd=self.proj)
        self.assertEqual(code, 0)
        self.assertEqual((self.proj / "AGENTS.md").read_text(encoding="utf-8"), filled)
        self.assertTrue(draft.is_file())  # 下書きは消さない

    def test_埋め残しと説明のコメントは注意する(self) -> None:
        self.run_cli("draft", str(self.proj), "--template", "document")
        _, out, _ = self.run_cli("plan", str(self.proj), "--agents-file", str(self.proj / ".handoff" / "project-init_AGENTS.md"))
        self.assertIn("埋まっていない【 】が 2 個", out)
        self.assertIn("説明のコメント", out)

    def test_下書きの誤りは何も置かない(self) -> None:
        bad_heading = self.tmp / "no_heading.md"
        bad_heading.write_text("見出しなし\n", encoding="utf-8")
        sjis = self.tmp / "sjis.md"
        sjis.write_bytes("# 名前\n".encode("cp932"))
        before = self.snapshot()
        for argv, message in ((["--agents-file", str(self.tmp / "none.md")], "下書きがありません"),
                              (["--agents-file", str(bad_heading)], "見出し"),
                              (["--agents-file", str(sjis)], "UTF-8"),
                              (["--agents-file", str(bad_heading), "--name", "x"], "--name")):
            code, _, err = self.run_cli("apply", str(self.proj), *argv)
            self.assertEqual(code, 2, argv)
            self.assertIn(message, err)
        self.assertEqual(self.snapshot(), before)


class RealTemplateTests(unittest.TestCase):
    def test_3つのテンプレートがある(self) -> None:
        self.assertEqual(set(cli.DEFAULT_TEMPLATES), {"coding", "csharp", "document"})
        for kind, path in cli.DEFAULT_TEMPLATES.items():
            text = path.read_text(encoding="utf-8")
            self.assertIn(cli.TITLE_PLACEHOLDER, text, kind)
            self.assertLessEqual(len(text.encode("utf-8")), cli.MAX_TEMPLATE_BYTES)
            for needle in ("git status", "git push", ".handoff", "出典"):
                self.assertIn(needle, text, f"{kind} に {needle!r} がありません")

    def test_一般資料のテンプレートはハーネスの道具を指す(self) -> None:
        text = cli.DEFAULT_TEMPLATES["document"].read_text(encoding="utf-8")
        for needle in ("doc-writing", "interview", "yomiyasu", "polish", "calc-check", "researcher", "finder", "diagram", "review", "読者", "原典", "未確認"):
            self.assertIn(needle, text, f"一般資料のテンプレートに {needle!r} がありません")

    def test_汎用テンプレートの形(self) -> None:
        text = cli.DEFAULT_TEMPLATES["coding"].read_text(encoding="utf-8")
        self.assertIn(cli.TITLE_PLACEHOLDER, text)
        self.assertLessEqual(len(text.encode("utf-8")), cli.MAX_TEMPLATE_BYTES)
        # コード専用ではなく、計算・解析のリポジトリも想定していること
        for needle in ("## 計算・解析", "単位系", "出典", "未検証", "CAE"):
            self.assertIn(needle, text, f"汎用テンプレートに {needle!r} がありません")
        # Git 前提、Python の決まりが残っていること
        for needle in ("git status", "git push", ".gitignore", ".venv", "python -m venv", ".handoff"):
            self.assertIn(needle, text, f"テンプレートに {needle!r} がありません")

    def test_C_Sharpのテンプレートの形(self) -> None:
        text = cli.DEFAULT_TEMPLATES["csharp"].read_text(encoding="utf-8")
        for needle in ("## コーディングの決まり(C#)", "## 計算・解析", "dotnet build", "dotnet test", "NuGet", "bin/", "obj/", ".gitignore",
                       "Nullable", "async", "CodePagesEncodingProvider", "未確認", "未検証", "未実行"):
            self.assertIn(needle, text, f"C# のテンプレートに {needle!r} がありません")
        # C# のテンプレートに、Python 専用の指示 (python-coding・.venv) を混ぜない
        self.assertNotIn("python-coding", text)
        self.assertNotIn("python -m venv", text)

    def test_テンプレートに会社固有の値や秘密が無い(self) -> None:
        for path in cli.DEFAULT_TEMPLATES.values():
            text = path.read_text(encoding="utf-8").replace("CancellationToken", "")  # C# の型の名前 (秘密ではない)
            self.assertNotRegex(text, r"(?i)api[_-]?key|password|secret|token|sk-[A-Za-z0-9]{10,}|https?://")


class SafetyTests(unittest.TestCase):
    def test_ソースに削除_実行_通信が無く_書き込み先が限られる(self) -> None:
        source = (SKILL_DIR / "scripts" / "project_init.py").read_text(encoding="utf-8")
        for needle in (".unlink(", "os.remove", "rmtree", "rmdir", "subprocess", "os.system", "urlopen", "socket", "eval(", "exec(", "rename(", "os.replace", "move(",
                       ".write_text(", ".write_bytes(", "shutil", "chmod", '"w"', "'w'", '"wb"', '"a"'):
            self.assertNotIn(needle, source, f"project_init.py に {needle} があります")
        self.assertEqual(source.count('open(path, "x"'), 1, "新規作成 (排他) は 1 か所だけ")
        self.assertEqual(source.count('open(path, "ab")'), 1, "追記は 1 か所だけ")
        self.assertEqual(source.count(".mkdir("), 1, "フォルダ作成は 1 か所だけ (.handoff/)")
        self.assertEqual(source.count("open("), 2, "open は、新規作成と追記の 2 か所だけ")


if __name__ == "__main__":
    unittest.main()
