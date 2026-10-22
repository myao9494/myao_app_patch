"""
MkDocsドキュメントリポジトリ判定、統合マークダウン＆図PDF出力、リンク先MD自動選択、およびMarkdownパッチ反映の統合テスト。

仕様:
1. リポジトリ内の mkdocs.yml / mkdocs.yaml を参照し、通常リポジトリか MkDocs ドキュメントリポジトリかを自動判定する。
2. 選択された Markdown ファイル群から呼び出されている画像をすべて検出し、所属ファイル名・リンク記法のラベル付きで1図1ページの図PDFにまとめ、統合マークダウンファイルと図PDFの2ファイルに分けて出力する。
3. 選択中の Markdown ファイルからリンクされている同一リポジトリ内の別 Markdown ファイルを再帰的に自動検出して選択対象に追加する。
4. AIが出力した Markdown ファイルの修正（内部にコードブロックを含むファイルパス付きコードブロック、`<file_changes>`、または `# ===== [ファイル ...] path =====` 形式）を解析し、差分プレビューと反映を行う。
"""

from __future__ import annotations

import io
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.main import app
from backend.pdf_output import count_pdf_pages
from pdf_helpers import pdf_page_images
from backend.mkdocs_support import (
    build_mkdocs_bundle,
    detect_mkdocs_config,
    discover_linked_markdown_files,
    find_inline_svgs,
    render_svg_text,
)


def _create_mkdocs_sample(base: Path) -> Path:
    """4文書・5画像のMkDocsサンプルリポジトリを作成する（個人環境のパスに依存しない）。"""
    repo = base / "mkdocs_sample"
    (repo / "docs" / "guide").mkdir(parents=True)
    (repo / "docs" / "spec").mkdir(parents=True)
    (repo / "mkdocs.yml").write_text("site_name: Sample\ndocs_dir: docs\n", encoding="utf-8")
    (repo / "docs" / "index.md").write_text("# Index\n\n![システム全体構成図](images/architecture.png)\n", encoding="utf-8")
    (repo / "docs" / "guide" / "setup.md").write_text("# Setup\n\n![初期設定画面](../images/setup_screen.png)\n", encoding="utf-8")
    (repo / "docs" / "guide" / "usage.md").write_text(
        "# Usage\n\n![メインダッシュボード画面](../images/main_dashboard.png)\n\n![エクスポート設定モーダル](../images/export_modal.png)\n",
        encoding="utf-8",
    )
    (repo / "docs" / "spec" / "data_flow.md").write_text("# Flow\n\n![データ連携フロー図](../images/data_flow.png)\n", encoding="utf-8")
    for name in ("architecture", "setup_screen", "main_dashboard", "export_modal", "data_flow"):
        _create_sample_png(repo / "docs" / "images" / f"{name}.png", width=3000, height=400)
    return repo


def _create_sample_png(path: Path, width: int = 400, height: int = 200, color: tuple[int, int, int] = (200, 220, 255)) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img = Image.new("RGB", (width, height), color=color)
    img.save(path, format="PNG")


def test_YAMLファイルからMkDocsリポジトリか通常リポジトリかを正しく判定する(tmp_path: Path) -> None:
    normal_repo = tmp_path / "normal_repo"
    normal_repo.mkdir()
    (normal_repo / "main.py").write_text("print('hello')\n", encoding="utf-8")

    mkdocs_repo = tmp_path / "mkdocs_repo"
    mkdocs_repo.mkdir()
    (mkdocs_repo / "mkdocs.yml").write_text(
        "site_name: テスト設計ドキュメント\ndocs_dir: docs\nnav:\n  - Home: index.md\n",
        encoding="utf-8",
    )
    (mkdocs_repo / "docs").mkdir()
    (mkdocs_repo / "docs" / "index.md").write_text("# ホーム\n", encoding="utf-8")

    normal_info = detect_mkdocs_config(normal_repo)
    assert normal_info["is_mkdocs"] is False

    mkdocs_info = detect_mkdocs_config(mkdocs_repo)
    assert mkdocs_info["is_mkdocs"] is True
    assert mkdocs_info["config_file"] == "mkdocs.yml"
    assert mkdocs_info["site_name"] == "テスト設計ドキュメント"
    assert mkdocs_info["docs_dir"] == "docs"


def test_repository_structure_APIがMkDocsリポジトリ判定結果と設定情報を返す(tmp_path: Path) -> None:
    mkdocs_repo = tmp_path / "mkdocs_repo"
    (mkdocs_repo / "docs").mkdir(parents=True)
    (mkdocs_repo / "mkdocs.yaml").write_text(
        "site_name: API確認ドキュメント\ndocs_dir: docs\n",
        encoding="utf-8",
    )
    (mkdocs_repo / "docs" / "index.md").write_text("# Top\n", encoding="utf-8")

    client = TestClient(app)
    response = client.post(
        "/api/repository_structure",
        json={"library_path": str(mkdocs_repo), "show_ignored": False},
    )

    assert response.status_code == 200
    data = response.json()
    assert data["is_mkdocs_repository"] is True
    assert data["mkdocs_config"]["site_name"] == "API確認ドキュメント"
    assert data["mkdocs_config"]["config_file"] == "mkdocs.yaml"


def test_選択されたMarkdownからリンクされている別Markdownファイルを再帰的に自動検出する(tmp_path: Path) -> None:
    repo = tmp_path / "mkdocs_links"
    (repo / "docs" / "guide").mkdir(parents=True)
    (repo / "docs" / "spec").mkdir(parents=True)
    (repo / "mkdocs.yml").write_text("site_name: LinkTest\ndocs_dir: docs\n", encoding="utf-8")

    (repo / "docs" / "index.md").write_text(
        "# トップ\n詳細は [セットアップ](guide/setup.md) を参照。\n",
        encoding="utf-8",
    )
    (repo / "docs" / "guide" / "setup.md").write_text(
        "# セットアップ\n次は [データ仕様](../spec/flow.md#section-1) と [トップへ戻る](../index.md) を確認。\n",
        encoding="utf-8",
    )
    (repo / "docs" / "spec" / "flow.md").write_text(
        "# データ仕様\n本文です。\n",
        encoding="utf-8",
    )
    (repo / "docs" / "unrelated.md").write_text(
        "# 無関係なページ\n",
        encoding="utf-8",
    )

    detected = discover_linked_markdown_files(repo, ["docs/index.md"])
    assert "docs/guide/setup.md" in detected
    assert "docs/spec/flow.md" in detected
    assert "docs/unrelated.md" not in detected

    client = TestClient(app)
    res = client.post(
        "/api/auto_select_modules",
        json={"library_path": str(repo), "selected_files": ["docs/index.md"]},
    )
    assert res.status_code == 200
    body = res.json()
    assert set(body["selected_files"]) == {"docs/index.md", "docs/guide/setup.md", "docs/spec/flow.md"}


def test_MkDocsのMarkdown群から統合マークダウンと図PDFを分けて生成する(tmp_path: Path) -> None:
    repo = tmp_path / "mkdocs_bundle"
    (repo / "docs" / "guide").mkdir(parents=True)
    (repo / "docs" / "images").mkdir(parents=True)
    (repo / "mkdocs.yml").write_text("site_name: BundleTest\ndocs_dir: docs\n", encoding="utf-8")

    _create_sample_png(repo / "docs" / "images" / "arch.png", width=600, height=240, color=(220, 240, 255))
    _create_sample_png(repo / "docs" / "images" / "screen.png", width=600, height=300, color=(220, 255, 220))

    (repo / "docs" / "index.md").write_text(
        "# システム概要\n\n![全体構成図](images/arch.png)\n\n説明テキストです。\n",
        encoding="utf-8",
    )
    (repo / "docs" / "guide" / "usage.md").write_text(
        "# 使い方\n\n![操作画面](../images/screen.png)\n\n手順の説明です。\n",
        encoding="utf-8",
    )

    markdown_text, image_parts, stats = build_mkdocs_bundle(
        root=repo,
        selected_files=["docs/index.md", "docs/guide/usage.md"],
    )

    assert "![全体構成図](images/arch.png)" in markdown_text
    assert "![操作画面](../images/screen.png)" in markdown_text
    assert "docs/index.md" in markdown_text
    assert "docs/guide/usage.md" in markdown_text
    assert "<file_changes>" in markdown_text
    assert len(image_parts) == 1
    assert stats["total_documents"] == 2
    assert stats["total_images"] == 2
    assert len(stats["images_meta"]) == 2
    assert stats["images_meta"][0]["doc_path"] == "docs/index.md"
    assert stats["images_meta"][0]["link_text"] == "![全体構成図](images/arch.png)"
    assert stats["images_meta"][1]["doc_path"] == "docs/guide/usage.md"

    assert image_parts[0].data.startswith(b"%PDF-")
    assert count_pdf_pages(image_parts[0].data) == 2
    assert [page.width for page in pdf_page_images(image_parts[0].data)] == [1256, 1256]


def test_MkDocsサンプルリポジトリから2ファイルを指定フォルダへ分けて出力できる(tmp_path: Path) -> None:
    sample_dir = _create_mkdocs_sample(tmp_path)
    out_dir = tmp_path / "exported_ai_inputs"
    client = TestClient(app)

    response = client.post(
        "/api/mkdocs/save_bundle",
        json={
            "library_path": str(sample_dir),
            "selected_files": [
                "mkdocs.yml",
                "docs/index.md",
                "docs/guide/setup.md",
                "docs/guide/usage.md",
                "docs/spec/data_flow.md",
            ],
            "target_dir": str(out_dir),
            "file_base_name": "mkdocs_sample_export",
        },
    )

    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "success"
    assert data["has_images"] is True
    assert data["stats"]["total_images"] == 5

    md_path = Path(data["markdown_path"])
    img_path = Path(data["pdf_path"])
    assert md_path.is_file()
    assert img_path.is_file()

    md_content = md_path.read_text(encoding="utf-8")
    assert "![システム全体構成図](images/architecture.png)" in md_content
    assert "![初期設定画面](../images/setup_screen.png)" in md_content
    assert "![メインダッシュボード画面](../images/main_dashboard.png)" in md_content
    assert "![エクスポート設定モーダル](../images/export_modal.png)" in md_content
    assert "![データ連携フロー図](../images/data_flow.png)" in md_content

    assert img_path.name == "mkdocs_sample_export_images.pdf"
    assert count_pdf_pages(img_path.read_bytes()) == 5


def test_MkDocsの保存先フォルダ設定を永続化および取得できる(tmp_path: Path) -> None:
    client = TestClient(app)
    custom_dir = str(tmp_path / "custom_ai_export")

    post_res = client.post("/api/mkdocs/export_config", json={"export_folder": custom_dir})
    assert post_res.status_code == 200
    assert post_res.json()["export_folder"] == custom_dir

    get_res = client.get("/api/mkdocs/export_config")
    assert get_res.status_code == 200
    assert get_res.json()["export_folder"] == custom_dir


def test_AIが出力したコードブロック入りのMarkdown変更やファイル境界形式を差分反映できる(tmp_path: Path) -> None:
    repo = tmp_path / "mkdocs_patch_repo"
    (repo / "docs" / "guide").mkdir(parents=True)
    (repo / "mkdocs.yml").write_text("site_name: PatchTest\ndocs_dir: docs\n", encoding="utf-8")
    target_md = repo / "docs" / "guide" / "setup.md"
    target_md.write_text(
        "# セットアップ手順\n\n![初期設定画面](../images/setup_screen.png)\n\n古い説明文です。\n",
        encoding="utf-8",
    )

    ai_output = """以下が修正後のドキュメントです。

```markdown path: docs/guide/setup.md
# セットアップ手順（改訂版）

![初期設定画面](../images/setup_screen.png)

インストールコマンドを実行します：

```bash
pip install -r requirements.txt
```

以上の手順で完了です。
```
"""

    client = TestClient(app)
    preview_res = client.post(
        "/api/patch/preview",
        json={"library_path": str(repo), "ai_output": ai_output},
    )
    assert preview_res.status_code == 200
    preview_data = preview_res.json()
    assert preview_data["status"] == "success"
    assert len(preview_data["changes"]) == 1
    assert preview_data["changes"][0]["path"] == "docs/guide/setup.md"

    apply_res = client.post(
        "/api/patch/apply",
        json={"library_path": str(repo), "ai_output": ai_output},
    )
    assert apply_res.status_code == 200
    assert apply_res.json()["status"] == "success"

    updated_text = target_md.read_text(encoding="utf-8")
    assert "# セットアップ手順（改訂版）" in updated_text
    assert "pip install -r requirements.txt" in updated_text
    assert "以上の手順で完了です。" in updated_text
    assert "![初期設定画面](../images/setup_screen.png)" in updated_text


# ---- 追加: YAML解析 / リンク抽出 / 画像解決 / 画像連結 ------------------------------

from backend.mkdocs_support import (  # noqa: E402
    _extract_markdown_doc_links,
    _extract_nav_md_paths,
    _parse_yaml_safely,
    build_pdf_parts,
    extract_markdown_image_links,
    flatten_to_rgb,
    pdf_bytes_to_data_url,
    render_figure_page,
    load_pil_image,
    resolve_mkdocs_image_path,
    strip_excalidraw_data_section,
)


def test_MkDocs固有のPythonタグを含むYAMLも辞書として解析できる():
    parsed = _parse_yaml_safely("site_name: S\nmarkdown_extensions:\n  - pymdownx.emoji:\n      emoji_index: !!python/name:material.extensions.emoji.twemoji\nnav:\n  - Home: index.md\n")
    assert parsed["site_name"] == "S" and parsed["nav"] == [{"Home": "index.md"}]


def test_壊れたYAMLでも主要キーを簡易解析で取得する():
    parsed = _parse_yaml_safely("site_name: 'Broken Site'\ndocs_dir: \"manual\"\nnav:\n  - [unclosed\n")
    assert (parsed["site_name"], parsed["docs_dir"], parsed["nav"]) == ("Broken Site", "manual", [])


def test_mkdocs_yamlでdocs_dirを変更した設定も検出する(tmp_path: Path) -> None:
    (tmp_path / "mkdocs.yaml").write_text("site_name: Manual\ndocs_dir: manual/\n", encoding="utf-8")
    info = detect_mkdocs_config(tmp_path)
    assert (info["is_mkdocs"], info["config_file"], info["docs_dir"], info["site_name"]) == (True, "mkdocs.yaml", "manual", "Manual")


def test_mkdocs以外のYAMLだけのリポジトリはMkDocsと判定しない(tmp_path: Path) -> None:
    (tmp_path / "docker-compose.yml").write_text("services:\n  web:\n    image: nginx\n", encoding="utf-8")
    assert detect_mkdocs_config(tmp_path)["is_mkdocs"] is False


def test_navから入れ子のMarkdownパスだけを抽出する():
    nav = ["index.md", {"Guide": ["guide/a.md", {"B": "guide/b.md"}, "https://example.com"]}, {"Img": "x.png"}]
    assert _extract_nav_md_paths(nav) == ["index.md", "guide/a.md", "guide/b.md"]


def test_Markdownリンクの抽出はコードブロックと外部リンクを除外する():
    text = "[a](a.md) [ext](https://e.com) [anc](#x) [mail](mailto:x@y.z) [sp](My%20Doc.md#sec \"t\") [[wiki|alias]] ![img](p.png)\n```\n[code](c.md)\n```\n"
    assert _extract_markdown_doc_links(text) == ["a.md", "My Doc.md", "wiki"]


def test_mkdocs_ymlのnavを起点に未選択のMarkdownも再帰的に検出する(tmp_path: Path) -> None:
    (tmp_path / "docs" / "sub").mkdir(parents=True)
    (tmp_path / "mkdocs.yml").write_text("site_name: S\nnav:\n  - Home: index.md\n  - Sub: sub/page.md\n", encoding="utf-8")
    (tmp_path / "docs" / "index.md").write_text("# Home\n", encoding="utf-8")
    (tmp_path / "docs" / "sub" / "page.md").write_text("[deep](deep.md) [[wikipage]]\n", encoding="utf-8")
    (tmp_path / "docs" / "sub" / "deep.md").write_text("# deep\n", encoding="utf-8")
    (tmp_path / "docs" / "wikipage.md").write_text("# wiki\n", encoding="utf-8")
    assert discover_linked_markdown_files(tmp_path, ["mkdocs.yml"]) == ["docs/index.md", "docs/sub/deep.md", "docs/sub/page.md", "docs/wikipage.md"]


def test_ディレクトリ形式リンクや拡張子省略リンクもindex_mdへ解決する(tmp_path: Path) -> None:
    (tmp_path / "docs" / "guide").mkdir(parents=True)
    (tmp_path / "mkdocs.yml").write_text("site_name: S\n", encoding="utf-8")
    (tmp_path / "docs" / "index.md").write_text("[g](guide/) [s](setup)\n", encoding="utf-8")
    (tmp_path / "docs" / "guide" / "index.md").write_text("# g\n", encoding="utf-8")
    (tmp_path / "docs" / "setup.md").write_text("# s\n", encoding="utf-8")
    assert discover_linked_markdown_files(tmp_path, ["docs/index.md"]) == ["docs/guide/index.md", "docs/setup.md"]


def test_画像リンクは4種類の記法を抽出し外部URLは除外する():
    text = '![a](img/a.png "t") ![[b.png|300]] <img src="c.png" width="10"> [[d.excalidraw]] ![ext](https://e.com/x.png) ![d](data:image/png;base64,AAA)'
    targets = [target for _, target in extract_markdown_image_links(text)]
    assert sorted(targets) == ["b.png", "c.png", "d.excalidraw", "img/a.png"]


def test_画像パスはURLエンコードとファイル名一致フォールバックでも解決する(tmp_path: Path) -> None:
    _create_sample_png(tmp_path / "docs" / "images" / "my pic.png")
    _create_sample_png(tmp_path / "assets" / "deep" / "found.png")
    doc = tmp_path / "docs" / "index.md"
    doc.write_text("x", encoding="utf-8")
    assert resolve_mkdocs_image_path(tmp_path, "docs", doc, "images/my%20pic.png") == (tmp_path / "docs" / "images" / "my pic.png").resolve()
    assert resolve_mkdocs_image_path(tmp_path, "docs", doc, "/images/my pic.png") == (tmp_path / "docs" / "images" / "my pic.png").resolve()
    assert resolve_mkdocs_image_path(tmp_path, "docs", doc, "nowhere/found.png") == (tmp_path / "assets" / "deep" / "found.png").resolve()
    assert resolve_mkdocs_image_path(tmp_path, "docs", doc, "missing.png") is None


def test_透過画像は白背景に合成され黒潰れしない():
    result = flatten_to_rgb(Image.new("RGBA", (4, 4), (0, 0, 0, 0)))
    assert result.mode == "RGB" and result.getpixel((0, 0)) == (255, 255, 255)


def test_壊れた画像やSVG変換器なしでは読み込みをNoneで諦める(tmp_path: Path):
    broken = tmp_path / "broken.png"
    broken.write_bytes(b"not an image")
    svg = tmp_path / "a.svg"
    svg.write_text("<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'/>", encoding="utf-8")
    assert load_pil_image(broken) is None
    assert load_pil_image(svg) in (None,) or load_pil_image(svg).width > 0  # resvg/cairosvg が入っていれば変換される


def test_図のページは等倍の図の上にラベル帯が付く():
    figure = Image.new("RGB", (1600, 300), (10, 20, 30))
    page = render_figure_page({"index": 3, "doc_path": "docs/a.md", "link_text": "![x](x.png)", "image": figure})
    assert page.width >= 1600 and page.height > 300 + 44
    assert page.getpixel((page.width // 2, page.height - 60)) == (10, 20, 30)
    assert page.getpixel((2, 2)) == (255, 255, 255)


def test_上限をどう縮めても収まらない場合は最小のJPEGページを返す():
    items = [{"index": 1, "doc_path": "d.md", "link_text": "l", "image": Image.new("RGB", (900, 300), (10, 20, 30))}]
    parts = build_pdf_parts(items, max_bytes=1)
    assert len(parts) == 1 and b"/DCTDecode" in parts[0].data


def test_図がなければPDFは作らない():
    assert build_pdf_parts([]) == []


def test_Excalidraw圧縮データ節は統合マークダウンから除去される():
    assert strip_excalidraw_data_section("本文\n\n# Excalidraw Data\n\n圧縮JSON...") == "本文"
    assert strip_excalidraw_data_section("本文のみ") == "本文のみ"


def test_図PDFのData_URLはPDFと空を区別する():
    assert pdf_bytes_to_data_url(None) == ""
    assert pdf_bytes_to_data_url(b"%PDF-1.4").startswith("data:application/pdf;base64,")


def test_解決できない画像リンクと同一文書内で重複した画像は図PDFに1枚だけ含める(tmp_path: Path) -> None:
    (tmp_path / "docs").mkdir()
    (tmp_path / "mkdocs.yml").write_text("site_name: S\n", encoding="utf-8")
    _create_sample_png(tmp_path / "docs" / "a.png")
    (tmp_path / "docs" / "index.md").write_text("![a](a.png)\n![again](a.png)\n![missing](none.png)\n", encoding="utf-8")
    _, image_parts, stats = build_mkdocs_bundle(tmp_path, ["mkdocs.yml", "docs/index.md"])
    assert len(image_parts) == 1
    assert stats["total_images"] == 1
    assert stats["images_meta"][0]["link_text"] == "![a](a.png)"


_INLINE_SVG = (
    '<svg viewBox="0 0 300 120"><rect width="300" height="120" fill="#cde"/>'
    '<text x="10" y="60">inline-marker</text></svg>'
)


def _create_svg_repo(tmp_path: Path, md_text: str) -> Path:
    (tmp_path / "docs").mkdir()
    (tmp_path / "mkdocs.yml").write_text("site_name: S\n", encoding="utf-8")
    (tmp_path / "docs" / "index.md").write_text(md_text, encoding="utf-8")
    return tmp_path


def test_インラインSVGは統合マークダウンから外れ図PDFに収録される(tmp_path: Path) -> None:
    repo = _create_svg_repo(tmp_path, f"# 図\n\n{_INLINE_SVG}\n\n後続の文章\n")
    markdown_text, image_parts, stats = build_mkdocs_bundle(repo, ["docs/index.md"])
    assert "<rect" not in markdown_text
    assert "inline-marker" not in markdown_text
    assert "[インラインSVG → 図PDFの【図1】に収録]" in markdown_text
    assert "後続の文章" in markdown_text
    assert len(image_parts) == 1
    assert stats["total_images"] == 1
    assert stats["inline_svg_count"] == 1
    assert stats["inline_svg_chars_moved"] == len(_INLINE_SVG)
    assert stats["images_meta"][0]["link_text"] == "インラインSVG（1個目）"


def test_インラインSVGが図PDFのページとして描画される(tmp_path: Path) -> None:
    repo = _create_svg_repo(tmp_path, f"{_INLINE_SVG}\n")
    _, image_parts, _ = build_mkdocs_bundle(repo, ["docs/index.md"])
    [page] = pdf_page_images(image_parts[0].data)
    assert (204, 221, 238) in {color for _, color in page.getcolors(maxcolors=1_000_000)}


def test_フェンス付きコードブロック内のsvg例示は本文に残す(tmp_path: Path) -> None:
    repo = _create_svg_repo(tmp_path, f"```html\n{_INLINE_SVG}\n```\n")
    markdown_text, image_parts, stats = build_mkdocs_bundle(repo, ["docs/index.md"])
    assert "inline-marker" in markdown_text
    assert image_parts == []
    assert stats["total_images"] == 0


def test_同一文書内の同じインラインSVGは1枚だけ収録し参照文は同じ図番号を指す(tmp_path: Path) -> None:
    repo = _create_svg_repo(tmp_path, f"{_INLINE_SVG}\n\n中間\n\n{_INLINE_SVG}\n")
    markdown_text, _, stats = build_mkdocs_bundle(repo, ["docs/index.md"])
    assert stats["total_images"] == 1
    assert markdown_text.count("[インラインSVG → 図PDFの【図1】に収録]") == 2


def test_描画できない壊れたSVGは情報を失わないよう本文に残す(tmp_path: Path) -> None:
    broken = "<svg><g><text>broken-marker</text></svg>"
    repo = _create_svg_repo(tmp_path, f"{broken}\n")
    markdown_text, image_parts, stats = build_mkdocs_bundle(repo, ["docs/index.md"])
    assert "broken-marker" in markdown_text
    assert image_parts == []
    assert stats["inline_svg_count"] == 0


def test_入れ子のsvgは最外殻の1件として扱う() -> None:
    text = 'a <svg width="10" height="10"><svg width="5" height="5"></svg><circle r="1"/></svg> b <svg width="1" height="1"/> c'
    spans = find_inline_svgs(text)
    assert [text[s:e] for s, e in spans] == [
        '<svg width="10" height="10"><svg width="5" height="5"></svg><circle r="1"/></svg>',
        '<svg width="1" height="1"/>',
    ]


def test_xmlns省略のインラインSVGも描画できる() -> None:
    img = render_svg_text('<svg width="40" height="20"><rect width="40" height="20" fill="red"/></svg>')
    assert img is not None
    assert img.size == (40, 20)
