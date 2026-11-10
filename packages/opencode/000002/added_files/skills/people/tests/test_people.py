"""people_cli のテスト。実行: python -m unittest discover -s skills/people/tests -v   (リポジトリのルートから)

メールのキャッシュは、outlook-mail の本物の outlook_cache で作る (キャッシュの形が変わったら、ここで気付く)。
"""
from __future__ import annotations

import datetime as dt
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SKILL_DIR = Path(__file__).resolve().parents[1]
MAIL_SCRIPTS = SKILL_DIR.parent / "outlook-mail" / "scripts"
sys.path.insert(0, str(SKILL_DIR / "scripts"))
sys.path.insert(0, str(MAIL_SCRIPTS))

import outlook_cache  # noqa: E402
import people_cli as cli  # noqa: E402

NOW = dt.datetime(2026, 11, 11, 10, 0, 0)


def mail(entry: str, kind: str, when: str, sender: str, addr: str, to: str, cc: str, subject: str) -> dict:
    return {"entry_id": entry, "time": dt.datetime.fromisoformat(when), "sender": sender, "sender_addr": addr, "to": to, "cc": cc,
            "subject": subject, "attachments": 0, "body": f"{subject} の本文"}


MAILS = [
    ("inbox", mail("E1", "inbox", "2026-11-10 09:00:00", "山田 太郎", "taro.yamada@abc.co.jp", "自分 一郎", "鈴木 花子", "B 案の図面")),
    ("inbox", mail("E2", "inbox", "2026-11-05 09:00:00", "山田 太郎", "taro.yamada@abc.co.jp", "自分 一郎", "", "見積の件")),
    ("sent", mail("E3", "sent", "2026-11-06 09:00:00", "自分 一郎", "/O=EXCHANGELABS/OU=X/CN=ME", "山田 太郎; 鈴木 花子", "", "RE: 見積の件")),
    ("inbox", mail("E4", "inbox", "2026-11-01 09:00:00", "田中 次郎", "jiro@xyz.co.jp", "自分 一郎", "", "打合せ")),
    ("inbox", mail("E5", "inbox", "2026-10-20 09:00:00", "田中 次郎", "jiro@xyz.co.jp", "自分 一郎", "", "議事録")),
    ("inbox", mail("E6", "inbox", "2026-10-10 09:00:00", "田中 次郎", "jiro@xyz.co.jp", "自分 一郎", "鈴木 花子", "日程")),
    ("inbox", mail("E7", "inbox", "2026-01-10 09:00:00", "古い 人", "old@xyz.co.jp", "自分 一郎", "", "昔の件")),
]


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name).resolve()
        self.vault = self.tmp / "vault"
        (self.vault / ".obsidian").mkdir(parents=True)
        self.cache = self.tmp / "cache" / "mail.sqlite3"
        with outlook_cache.CacheStore(self.cache) as store:
            for kind, record in MAILS:
                store.add_mail(record, kind, "F1", "受信トレイ" if kind == "inbox" else "送信済み")
        env = {k: v for k, v in os.environ.items() if k not in ("OPENCODE_VAULT",)}
        patcher = mock.patch.dict(os.environ, env, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_cli(self, *argv: str, cwd: Path | None = None, config: Path | None = None, cache: Path | None = None) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        code = cli.main(list(argv), stdout=out, stderr=err, cwd=cwd or self.vault, now=NOW,
                        config_path=config or self.tmp / "none.json", cache_path=cache or self.cache)
        return code, out.getvalue(), err.getvalue()

    def alias(self, entry: str) -> str:
        with outlook_cache.CacheStore(self.cache) as store:
            return store.find(entry)["alias"]

    def note(self, name: str) -> str:
        return (self.vault / "05_people" / f"{name}.md").read_text(encoding="utf-8")

    def add_yamada(self) -> None:
        code, _, err = self.run_cli("new", "山田 太郎", "--email", "taro.yamada@abc.co.jp", "--alias", "山田さん,山田部長",
                                    "--org", "ABC 株式会社 設計部", "--role", "見積の窓口", "--relation", "客先", "--point", "見積は部長決裁", "--checked")
        self.assertEqual(code, 0, err)


class NewTests(Base):
    def test_作る_frontmatterと節(self) -> None:
        self.add_yamada()
        text = self.note("山田太郎")
        for line in ("name: 山田 太郎", "  - 山田さん", "  - taro.yamada@abc.co.jp", "relation: 客先", "self: false",
                     "checked: 2026-11-11", "ai_generated: opencode", "ai_reviewed: false", "created: 2026-11-11 10:00:00", "  - 人物"):
            self.assertIn(line, text)
        self.assertIn("## 要点\n\n- 見積は部長決裁\n", text)
        self.assertIn("## やり取りのメモ", text)
        front, _ = cli.split_note(text)
        self.assertEqual(cli.parse_front(front)["aliases"], ["山田さん", "山田部長"])

    def test_同じ氏名やアドレスは作らない(self) -> None:
        self.add_yamada()
        code, _, err = self.run_cli("new", "山田太郎")
        self.assertEqual(code, 2)
        self.assertIn("同じ氏名かアドレス", err)
        code, _, err = self.run_cli("new", "別の 人", "--email", "TARO.YAMADA@abc.co.jp")
        self.assertEqual(code, 2)

    def test_電話番号や住所は書かない(self) -> None:
        for point in ("携帯 090-1234-5678", "〒100-0001 東京都", "03-1234-5678"):
            code, _, err = self.run_cli("new", "電話 人", "--point", point)
            self.assertEqual(code, 2, point)
            self.assertIn("書きません", err)
        self.assertFalse((self.vault / "05_people").exists())

    def test_関係は決まった値だけ(self) -> None:
        code, _, err = self.run_cli("new", "誰か", "--relation", "友達")
        self.assertEqual(code, 2)
        self.assertIn("relation", err)

    def test_自分は1人だけ(self) -> None:
        self.assertEqual(self.run_cli("new", "自分 一郎", "--self")[0], 0)
        self.assertIn("relation: 自分", self.note("自分一郎"))
        code, _, err = self.run_cli("new", "自分 二郎", "--self")
        self.assertEqual(code, 2)
        self.assertIn("もうあります", err)

    def test_試行は書かない(self) -> None:
        code, out, _ = self.run_cli("new", "山田 太郎", "--dry-run")
        self.assertEqual(code, 0)
        self.assertIn("試行", out)
        self.assertFalse((self.vault / "05_people").exists())


class EditTests(Base):
    def test_setは項目を直し_要点を足し_未レビューに戻す(self) -> None:
        self.add_yamada()
        path = self.vault / "05_people" / "山田太郎.md"
        path.write_text(path.read_text(encoding="utf-8").replace("ai_reviewed: false", "ai_reviewed: true").replace("ai_generated: opencode\n", "") + "\n自由に書いた行\n", encoding="utf-8")
        code, out, err = self.run_cli("set", "山田さん", "--role", "仕様の窓口", "--alias", "Yamada", "--point", "図面は PDF で送る")
        self.assertEqual(code, 0, err)
        text = path.read_text(encoding="utf-8")
        self.assertIn("role: 仕様の窓口", text)
        self.assertIn("  - Yamada", text)
        self.assertIn("  - 山田さん", text)
        self.assertIn("- 見積は部長決裁\n- 図面は PDF で送る\n", text)
        self.assertIn("ai_edited: 2026-11-11 10:00:00", text)
        self.assertIn("ai_reviewed: false", text)
        self.assertIn("自由に書いた行", text)
        self.assertEqual(text.count("ai_reviewed"), 1)

    def test_setは知らない項目と人の書いた形を残す(self) -> None:
        folder = self.vault / "05_people"
        folder.mkdir()
        (folder / "佐藤.md").write_text("---\nname: 佐藤 三郎\nemails: [sato@x.jp]\nmy_key: そのまま\nnested:\n  a: 1\n---\n人が書いた本文\n", encoding="utf-8")
        code, _, err = self.run_cli("set", "sato@x.jp", "--org", "X 社")
        self.assertEqual(code, 0, err)
        text = (folder / "佐藤.md").read_text(encoding="utf-8")
        self.assertIn("emails: [sato@x.jp]", text)
        self.assertIn("my_key: そのまま\nnested:\n  a: 1\n", text)
        self.assertIn("org: X 社", text)
        self.assertTrue(text.endswith("---\n人が書いた本文\n"), text)
        code, _, err = self.run_cli("set", "佐藤", "--alias", "サトウ")
        self.assertEqual(code, 0, err)
        self.assertIn("aliases:\n  - サトウ", (folder / "佐藤.md").read_text(encoding="utf-8"))

    def test_setは別の人のアドレスを付けない(self) -> None:
        self.add_yamada()
        self.assertEqual(self.run_cli("new", "鈴木 花子")[0], 0)
        code, _, err = self.run_cli("set", "鈴木 花子", "--email", "taro.yamada@abc.co.jp")
        self.assertEqual(code, 2)
        self.assertIn("別の人物ノート", err)

    def test_memoは日付と出典つき(self) -> None:
        self.add_yamada()
        code, _, err = self.run_cli("memo", "山田部長", "改訂は PDF で送る決まり", "--source", "RE: B 案の図面")
        self.assertEqual(code, 0, err)
        text = self.note("山田太郎")
        self.assertIn("## やり取りのメモ\n\n- 2026-11-11 改訂は PDF で送る決まり(出典: RE: B 案の図面)\n", text)
        self.assertIn("ai_edited: 2026-11-11 10:00:00", text)

    def test_あいまいな指定では書かない(self) -> None:
        folder = self.vault / "05_people"
        folder.mkdir()
        for name in ("山田 一", "山田 二"):
            (folder / f"{name}.md").write_text(f"---\nname: {name}\naliases:\n  - 山田さん\n---\n", encoding="utf-8")
        code, _, err = self.run_cli("memo", "山田さん", "x")
        self.assertEqual(code, 2)
        self.assertIn("2 人", err)


class WhoTests(Base):
    def test_名前で引くと要点と集計(self) -> None:
        self.add_yamada()
        code, out, err = self.run_cli("who", "山田")
        self.assertEqual(code, 0, err)
        self.assertIn("## 山田 太郎 (客先 / 見積の窓口) [未レビュー", out)
        self.assertIn("要点: 見積は部長決裁", out)
        self.assertIn("メール: 受信 2・送信 1 / 最後 2026-11-10", out)
        self.assertIn("よく一緒に入る人: 鈴木 花子 (2)", out)
        self.assertNotIn("自分 一郎 (", out)  # 自分は、よく一緒に入る人に出さない
        self.assertIn("最近の件: B 案の図面 / RE: 見積の件\n", out)  # 同じ件は 1 つ (最新の件名)
        self.assertIn("ノート: 05_people/山田太郎.md", out)

    def test_レビュー済みは印が無い(self) -> None:
        self.add_yamada()
        path = self.vault / "05_people" / "山田太郎.md"
        path.write_text(path.read_text(encoding="utf-8").replace("ai_reviewed: false", "ai_reviewed: true"), encoding="utf-8")
        _, out, _ = self.run_cli("who", "taro.yamada@abc.co.jp")
        self.assertNotIn("未レビュー", out)

    def test_メールの全員(self) -> None:
        self.add_yamada()
        code, out, err = self.run_cli("who", "--mail", self.alias("E1"))
        self.assertEqual(code, 0, err)
        self.assertIn("B 案の図面", out)
        self.assertIn("## 山田 太郎 (客先 / 見積の窓口) — 差出人", out)
        self.assertIn("## 自分 一郎 — 宛先 (自分)", out)
        self.assertIn("## 鈴木 花子 (未登録) — CC", out)
        self.assertEqual(self.run_cli("who", "--mail", "E1")[0], 0)  # entry_id でもよい

    def test_未登録の人はキャッシュから(self) -> None:
        _, out, _ = self.run_cli("who", "田中")
        self.assertIn("## 田中 次郎 (未登録)", out)
        self.assertIn("アドレス: jiro@xyz.co.jp", out)
        self.assertIn("受信 3・送信 0", out)
        _, out, _ = self.run_cli("who", "いない人")
        self.assertIn("見つかりません", out)

    def test_自分(self) -> None:
        _, out, _ = self.run_cli("who", "--self")
        self.assertIn("自分の人物ノートがありません", out)
        self.run_cli("new", "自分 一郎", "--self", "--role", "設計担当", "--point", "返信は丁寧語、署名は 設計部 自分")
        _, out, _ = self.run_cli("who", "--self")
        self.assertIn("## 自分 一郎 (自分 / 設計担当)", out)
        self.assertIn("返信は丁寧語", out)

    def test_キャッシュが無くてもノートは返す(self) -> None:
        self.add_yamada()
        code, out, _ = self.run_cli("who", "山田", cache=self.tmp / "none.sqlite3")
        self.assertEqual(code, 0)
        self.assertIn("見積は部長決裁", out)
        self.assertIn("メールのキャッシュがありません", out)

    def test_社内の表示名の言い換えで照合する(self) -> None:
        self.assertTrue(cli.name_variants("山田 太郎/設計部/ABC") & cli.name_variants("山田太郎"))
        self.assertTrue(cli.name_variants("'山田 太郎 (設計部)'") & {cli.norm_key("山田 太郎")})
        self.assertTrue(cli.name_variants("Taro <taro@abc.co.jp>") & {"taro@abc.co.jp"})


class CandidatesAndCheckTests(Base):
    def test_候補は未登録で通数の多い順(self) -> None:
        self.add_yamada()
        code, out, err = self.run_cli("candidates", "--min", "2")
        self.assertEqual(code, 0, err)
        lines = [l for l in out.splitlines() if l.startswith("- ")]
        self.assertTrue(lines[0].startswith("- 田中 次郎 | jiro@xyz.co.jp | 受信 3・送信 0"), lines)
        self.assertTrue(lines[1].startswith("- 鈴木 花子 | 宛先・CC だけ"), lines)
        self.assertNotIn("山田", out)
        self.assertNotIn("自分 一郎", "\n".join(lines))
        self.assertNotIn("古い 人", out)  # 90 日より前
        self.assertIn("自分の人物ノートがまだありません", out)

    def test_点検(self) -> None:
        self.add_yamada()
        self.run_cli("new", "鈴木 花子")
        code, out, _ = self.run_cli("check")
        self.assertEqual(code, 0)
        self.assertIn("アドレスが無い (メールと照合できない): 05_people/鈴木花子.md", out)
        self.assertIn("確かめた日が無いか", out)
        self.assertIn("未レビュー", out)
        self.assertIn("自分の人物ノートが無い", out)


class PlaceTests(Base):
    def test_設定のVaultを使う(self) -> None:
        config = self.tmp / "config.json"
        config.write_text(json.dumps({"vault": str(self.vault)}), encoding="utf-8")
        elsewhere = self.tmp / "work"
        elsewhere.mkdir()
        code, out, err = self.run_cli("new", "山田 太郎", cwd=elsewhere, config=config)
        self.assertEqual(code, 0, err)
        self.assertTrue((self.vault / "05_people" / "山田太郎.md").is_file())

    def test_Vaultが無ければ止める(self) -> None:
        elsewhere = self.tmp / "work"
        elsewhere.mkdir()
        code, _, err = self.run_cli("who", "山田", cwd=elsewhere)
        self.assertEqual(code, 2)
        self.assertIn("config.local.json", err)

    def test_ドットで始まる場所やVaultの外には置かない(self) -> None:
        config = self.tmp / "config.json"
        for bad in (".obsidian/people", "../out", "/abs"):
            config.write_text(json.dumps({"people_dir": bad}), encoding="utf-8")
            code, _, err = self.run_cli("new", "x", config=config)
            self.assertEqual(code, 2, bad)

    def test_キャッシュの場所はoutlook_mailと同じ(self) -> None:
        with mock.patch.dict(os.environ, {"LOCALAPPDATA": str(self.tmp)}, clear=False):
            os.environ.pop("OPENCODE_OUTLOOK_MAILCACHE", None)
            self.assertEqual(cli.mail_cache_path(), outlook_cache.cache_db_path())


if __name__ == "__main__":
    unittest.main()
