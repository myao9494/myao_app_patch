"""
AIコンテキスト用トークン最適化（メールCC & DataviewJSコード除外）のテスト。
仕様:
- strip_dataviewjs_blocks_for_ai:
    - 静的テーブルに変換できないDataviewJSの生コードブロック（dv.pages()等）をプレースホルダーまたは省略注釈に置換する。
    - 静的テーブル形式（noteListRows）はHTMLテーブルとして正常に保持されること。
- strip_raw_markdown_dataview:
    - マークダウン元データ（doc-raw-markdown）からすべてのdataviewjs / dataviewコードブロックを完全除去すること。
- strip_email_cc_lines:
    - プレーンテキスト本文中の長大なCcヘッダー行（1行および複数行にわたるカンマ区切りアドレス）を自動除去すること。
    - HTML本文中のCc関連タグ（<tr><th>Cc:</th>...</tr> や <div><b>Cc:</b>...</div>）を自動除去すること。
- export_documents_to_html:
    - optimize_tokens=True のとき、メールCCとDataviewJSコードが自動除去・最適化されること。
"""

from pathlib import Path
from app.vector.html_exporter import (
    strip_email_cc_lines,
    strip_raw_markdown_dataview,
    convert_dataview_blocks_to_html,
    export_documents_to_html,
)


def test_strip_dataviewjs_complex_script_omitted():
    """パースできない複雑なDataviewJS生コードがそのまま出力されず省略されること"""
    raw_md = """# ノート見出し

```dataviewjs
const pages = dv.pages("#project").where(p => p.status === "active");
for (const p of pages) {
    dv.paragraph(`- ${p.file.link}`);
}
```

本文テキスト
"""
    # convert_dataview_blocks_to_html で生JSコード（const pages = ...）が出力されず、省略注釈またはプレースホルダーになること
    result = convert_dataview_blocks_to_html(raw_md, optimize_tokens=True)
    assert "const pages = dv.pages(" not in result
    assert "dv.paragraph" not in result
    assert "DataviewJS" in result or "省略" in result
    assert "本文テキスト" in result


def test_strip_raw_markdown_dataview_removes_code():
    """マークダウン元データ（doc-raw-markdown）からDataviewJSコードブロックが完全除去されること"""
    raw_md = """---
title: Test
---
# タイトル

```dataviewjs
dv.list(dv.pages().file.name);
```

```dataview
TABLE file.mtime FROM "notes"
```

本文内容
"""
    cleaned = strip_raw_markdown_dataview(raw_md)
    assert "```dataviewjs" not in cleaned
    assert "dv.list" not in cleaned
    assert "```dataview" not in cleaned
    assert "TABLE file.mtime" not in cleaned
    assert "本文内容" in cleaned


def test_strip_email_cc_lines_plain_text():
    """メールプレーンテキスト本文からCc行（複数行含む）が除去されること"""
    email_body = """お疲れ様です。山田です。

-----Original Message-----
From: satou@example.com
To: yamada@example.com
Cc: suzuki@example.com, tanaka@example.com,
    watanabe@example.com, takahashi@example.com,
    ito@example.com
Subject: プロジェクト進捗確認

進捗の件、了解いたしました。
よろしくお願いいたします。
"""
    cleaned = strip_email_cc_lines(email_body, is_html=False)
    assert "Cc: suzuki@example.com" not in cleaned
    assert "watanabe@example.com" not in cleaned
    assert "ito@example.com" not in cleaned
    assert "From: satou@example.com" in cleaned
    assert "進捗の件、了解いたしました。" in cleaned


def test_strip_email_cc_lines_html():
    """メールHTML本文からCcブロックが除去されること"""
    html_body = """<div>
<p>お疲れ様です。</p>
<div style="border-top:solid #B5C4DF 1.0pt;">
<b>差出人:</b> 佐藤<br>
<b>宛先:</b> 山田<br>
<b>Cc:</b> 鈴木 &lt;suzuki@example.com&gt;; 田中 &lt;tanaka@example.com&gt;; 渡辺 &lt;watanabe@example.com&gt;<br>
<b>件名:</b> 会議の件<br>
</div>
<p>明日のアジェンダです。</p>
</div>"""

    cleaned = strip_email_cc_lines(html_body, is_html=True)
    assert "suzuki@example.com" not in cleaned
    assert "tanaka@example.com" not in cleaned
    assert "<b>Cc:</b>" not in cleaned
    assert "<b>差出人:</b>" in cleaned
    assert "明日のアジェンダです。" in cleaned


def test_export_documents_to_html_with_token_optimization(tmp_path: Path):
    """export_documents_to_html に optimize_tokens=True を指定した場合のトークン最適化検証"""
    md_file = tmp_path / "test_note.md"
    md_file.write_text(
        """# 会議メモ

```dataviewjs
const rows = dv.pages().map(p => [p.file.name]);
dv.table(["Name"], rows);
```

会議の決定事項です。
""",
        encoding="utf-8",
    )

    eml_file = tmp_path / "thread.eml"
    eml_file.write_text(
        """Subject: [Report] Progress
From: leader@example.com
To: member@example.com
Cc: boss@example.com, auditor@example.com, client@example.com
Date: Wed, 24 Sep 2026 10:00:00 +0900
Content-Type: text/plain; charset=utf-8

本日の報告です。
Cc: other_auditor@example.com
確認をお願いします。
""",
        encoding="utf-8",
    )

    # Markdownからメールを呼び出すリンクを追加
    md_with_link = tmp_path / "note_with_mail.md"
    md_with_link.write_text(
        f"""# レポート

```dataviewjs
dv.span("Long JS Code");
```

メール参照: [[thread.eml]]
""",
        encoding="utf-8",
    )

    html_opt, stats_opt = export_documents_to_html(
        file_paths=[str(md_with_link)],
        include_raw_markdown=True,
        include_linked_emails=True,
        optimize_tokens=True,
    )

    # 1. DataviewJSの生コードがマークダウン元データ（doc-raw-markdown）に含まれていないこと
    assert 'details class="doc-raw-markdown"' in html_opt
    assert "Long JS Code" not in html_opt

    # 2. メールのCcメールアドレスが除去されていること
    assert "auditor@example.com" not in html_opt
    assert "other_auditor@example.com" not in html_opt

    # 3. 本文とリンクは維持されていること
    assert "本日の報告です。" in html_opt
    assert "確認をお願いします。" in html_opt


def test_export_documents_defaults_to_no_raw_markdown(tmp_path: Path) -> None:
    """既定呼び出し（include_raw_markdown 未指定）では、二重化を防ぐためマークダウン元データ（doc-raw-markdown）が出力されないこと"""
    doc = tmp_path / "sample.md"
    doc.write_text("# 議事録\n本日の決定事項について。", encoding="utf-8")

    # 1. 既定呼び出し (include_raw_markdown未指定)
    html_default, _ = export_documents_to_html(file_paths=[str(doc)])
    assert "議事録" in html_default
    assert "本日の決定事項について。" in html_default
    assert 'details class="doc-raw-markdown"' not in html_default
    assert "マークダウンファイルの元データ" not in html_default

    # 2. 明示的に include_raw_markdown=True を指定した場合のみ元データが出力されること
    html_with_raw, _ = export_documents_to_html(file_paths=[str(doc)], include_raw_markdown=True)
    assert 'details class="doc-raw-markdown"' in html_with_raw
    assert "マークダウンファイルの元データ" in html_with_raw

