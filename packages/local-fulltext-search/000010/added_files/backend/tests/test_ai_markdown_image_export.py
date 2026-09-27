"""
AIインプット用 マークダウン＆結合画像エクスポート（MarkdownImageExporter）の単体テスト。
仕様:
- 生のマークダウンリンク記法（![[...]]）を改変せず維持し、Obsidianコピペ互換性を保証する。
- ドキュメント最上部に、添付画像との照合ルールおよび回答出力時にリンク記法を維持する指示を埋め込む。
- 複数ノートを結合する際、各ノートの境界見出しを明示する。
- 参照されるメール（.msg / .eml）は末尾に集約し、重複を排除し、To（宛先）およびCCを完全除去する。
- 抽出された全図面（Excalidraw, PNG等）を縦に連結し、ヘッダー帯（所属ノート名・リンク記法）を描画する。
- 結合画像ファイルのサイズを 4.5MB 未満に自動制御する。
"""

import pytest
from pathlib import Path
from PIL import Image
from app.vector.markdown_image_exporter import export_documents_to_markdown_and_image


def test_export_markdown_bundle_content_and_rules(tmp_path: Path) -> None:
    """統合マークダウンが生リンク・AI指示ルール・境界見出し・重複排除メール（To/CC除外）を含むこと"""
    # 1. テスト用メール作成
    mail_path = tmp_path / "important_notice.eml"
    mail_path.write_text(
        """From: boss@example.com
To: dev_all@example.com, management@example.com
Cc: secret_audit@example.com, observer@example.com
Subject: 仕様変更の件
Date: 2026-09-26 10:00:00

関係者各位
仕様変更の詳細は以下の通りです。
ご確認よろしくお願いします。
""",
        encoding="utf-8",
    )

    # 2. テスト用ノート1（メールリンクあり）
    doc1 = tmp_path / "アーキテクチャ設計.md"
    doc1.write_text(
        f"""# アーキテクチャ設計
本システムの全体構成です。
![[arch_diagram.png]]

メール確認: [[important_notice.eml]]
""",
        encoding="utf-8",
    )

    # 3. テスト用ノート2（同じメールを再リンクして重複テスト）
    doc2 = tmp_path / "インフラ運用手順.md"
    doc2.write_text(
        f"""# インフラ運用手順
障害対応時のフローです。
![[infra_flow.png|400]]

参照メール: [[important_notice.eml]]
""",
        encoding="utf-8",
    )

    # ダミー画像作成 (PNG)
    img1_path = tmp_path / "arch_diagram.png"
    Image.new("RGB", (200, 100), color=(73, 109, 137)).save(img1_path)

    img2_path = tmp_path / "infra_flow.png"
    Image.new("RGB", (300, 150), color=(150, 75, 75)).save(img2_path)

    # 実行
    md_content, image_bytes, stats = export_documents_to_markdown_and_image(
        file_paths=[str(doc1), str(doc2)],
        vault_path=str(tmp_path),
        title="システム統合設計書",
    )

    # 検証1: 最上部のAI指示ルール
    assert "# 【AIへの指示: 添付ドキュメントおよび図面の参照・出力ルール】" in md_content
    assert "リンク記法" in md_content
    assert "そのままの形で" in md_content or "勝手に削除" in md_content

    # 検証2: 本文内の生のリンク記法が維持されていること（Obsidianコピペ互換）
    assert "![[arch_diagram.png]]" in md_content
    assert "![[infra_flow.png|400]]" in md_content

    # 検証3: ファイル境界の見出し
    assert "アーキテクチャ設計.md" in md_content
    assert "インフラ運用手順.md" in md_content

    # 検証4: メールの重複排除（2回リンクされているが、メール本文の掲載は1回のみ）
    assert md_content.count("仕様変更の件") == 1
    assert "仕様変更の詳細は以下の通りです。" in md_content

    # 検証5: メールのTo（宛先）およびCCが完全に除去されていること
    assert "dev_all@example.com" not in md_content
    assert "management@example.com" not in md_content
    assert "secret_audit@example.com" not in md_content
    assert "observer@example.com" not in md_content

    # 検証6: 差出人や日時は維持されていること
    assert "boss@example.com" in md_content

    # 検証7: 結合画像が生成され、サイズが4.5MB（4,718,592 bytes）以下であること
    assert image_bytes is not None
    assert len(image_bytes) > 0
    assert len(image_bytes) <= 4.5 * 1024 * 1024
    assert stats["total_images"] == 2
    assert stats["total_documents"] == 2
    assert stats["total_emails"] == 1


def test_export_documents_without_images(tmp_path: Path) -> None:
    """画像がない場合は画像バイナリが None となり、マークダウンのみが生成されること"""
    doc = tmp_path / "memo.md"
    doc.write_text("# メモ\n画像のないプレーンなノートです。", encoding="utf-8")

    md_content, image_bytes, stats = export_documents_to_markdown_and_image(
        file_paths=[str(doc)],
        vault_path=str(tmp_path),
    )

    assert "# メモ" in md_content
    assert "画像のないプレーンなノートです。" in md_content
    assert image_bytes is None
    assert stats["total_images"] == 0


def test_excalidraw_svg_included_and_rasterized(tmp_path: Path) -> None:
    """ExcalidrawのSVG図面およびPNG画像がすべてラスタライズされ、結合画像に含まれること"""
    # 1. Excalidrawファイル作成 (SVGデータ)
    excal_file = tmp_path / "システム構成図.excalidraw"
    svg_content = """<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200">
        <rect width="400" height="200" fill="#ffffff" />
        <rect x="50" y="50" width="120" height="80" fill="#3b82f6" rx="8" />
        <text x="110" y="95" fill="#ffffff" font-size="14" text-anchor="middle">Frontend</text>
        <rect x="230" y="50" width="120" height="80" fill="#10b981" rx="8" />
        <text x="290" y="95" fill="#ffffff" font-size="14" text-anchor="middle">Backend</text>
    </svg>"""
    excal_file.write_text(svg_content, encoding="utf-8")

    # 2. PNG画像作成
    png_file = tmp_path / "スクリーンショット.png"
    Image.new("RGB", (300, 100), color=(200, 220, 240)).save(png_file)

    # 3. ノート作成（ExcalidrawとPNGの2つを参照）
    doc = tmp_path / "プロジェクト設計.md"
    doc.write_text(
        """# プロジェクト設計
全体構成です。
![[システム構成図.excalidraw|800]]

画面キャプチャです。
![[スクリーンショット.png]]
""",
        encoding="utf-8",
    )

    md_content, image_bytes, stats = export_documents_to_markdown_and_image(
        file_paths=[str(doc)],
        vault_path=str(tmp_path),
        title="SVG結合テスト",
    )

    # SVG図面とPNGの両方が結合画像に収録されていること（計2件）
    assert stats["total_images"] == 2
    assert image_bytes is not None
    assert len(image_bytes) > 0

    # 結合画像を開いてサイズを確認
    import io
    combined_img = Image.open(io.BytesIO(image_bytes))
    assert combined_img.width >= 600
    assert combined_img.height > 200


def test_image_strip_black_text_without_black_background(tmp_path: Path) -> None:
    """図の説明（ラベル）は黒背景を含まず、黒文字だけで描画されていること"""
    img_file = tmp_path / "sample.png"
    Image.new("RGB", (200, 100), color=(255, 255, 255)).save(img_file)

    doc = tmp_path / "test_note.md"
    doc.write_text("# テスト\n![[sample.png]]", encoding="utf-8")

    _, image_bytes, _ = export_documents_to_markdown_and_image(
        file_paths=[str(doc)],
        vault_path=str(tmp_path),
    )
    assert image_bytes is not None

    import io
    combined_img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    w, h = combined_img.size

    # 旧仕様の濃紺/黒背景色 (15, 23, 42) の帯が存在しないこと
    dark_navy_count = 0
    for y in range(h):
        for x in range(0, w, 20):
            pixel = combined_img.getpixel((x, y))
            if pixel == (15, 23, 42):
                dark_navy_count += 1
    assert dark_navy_count == 0, "黒背景（濃紺帯）が存在してはならない"

    # テキスト用の黒〜濃色文字 (r, g, b がすべて <= 40) のピクセルが存在すること
    black_pixel_count = 0
    # 上部ヘッダー領域（y: 0〜60）を検査
    for y in range(min(60, h)):
        for x in range(w):
            r, g, b = combined_img.getpixel((x, y))
            if r <= 40 and g <= 40 and b <= 40:
                black_pixel_count += 1
    assert black_pixel_count > 0, "ラベルの黒文字ピクセルが存在すること"


def test_export_documents_handles_linked_emails_without_type_error(tmp_path: Path) -> None:
    """メールリンクを含むノートを vault_path='' でエクスポートしても TypeError（str / str）にならず正常終了すること"""
    # 1. メールファイル作成
    mail = tmp_path / "weekly_report.eml"
    mail.write_text(
        """From: member@example.com
Subject: 週報
Date: 2026-09-26

今週の進捗です。
""",
        encoding="utf-8",
    )

    # 2. メールリンクを含むノート作成（未存在メールや別名リンクを含めてcand2のフォールバックを通過させる）
    doc = tmp_path / "議事録.md"
    doc.write_text(
        """# 議事録
関連メールを確認:
[[weekly_report.eml]]
[[subfolder/missing_notice.eml]]
[[archive.msg]]
""",
        encoding="utf-8",
    )

    # vault_path='' で実行した際に TypeError が発生せず正常に完了すること
    md_content, image_bytes, stats = export_documents_to_markdown_and_image(
        file_paths=[str(doc)],
        vault_path="",  # 空文字指定
        title="メールリンクテスト",
        include_linked_emails=True,
    )

    assert stats["total_documents"] == 1
    assert stats["total_emails"] == 1
    assert "週報" in md_content
    assert "今週の進捗です。" in md_content


def test_transparent_png_rendered_on_white_background_not_black(tmp_path: Path) -> None:
    """透過PNG（RGBA）の透明部分が黒潰れせず、白背景（255, 255, 255）として綺麗に合成されること"""
    # 透明背景に赤色の四角形を描画したRGBA画像
    transparent_img = Image.new("RGBA", (100, 100), color=(0, 0, 0, 0))
    # 中央に赤い四角 (50, 50)
    for x in range(25, 75):
        for y in range(25, 75):
            transparent_img.putpixel((x, y), (255, 0, 0, 255))
    
    img_path = tmp_path / "transparent_sample.png"
    transparent_img.save(img_path, format="PNG")

    doc = tmp_path / "透過テスト.md"
    doc.write_text("# 透過テスト\n![[transparent_sample.png]]", encoding="utf-8")

    _, image_bytes, stats = export_documents_to_markdown_and_image(
        file_paths=[str(doc)],
        vault_path=str(tmp_path),
    )

    assert image_bytes is not None
    assert stats["total_images"] == 1

    import io
    combined = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    w, h = combined.size

    # 透明だった領域（例: 画像部分の四隅付近）が黒(0, 0, 0)にならず白(255, 255, 255)であること
    # 結合画像の画像描画エリアの下端近く、または端のピクセルを検査
    # もし単純な convert("RGB") だと (0, 0, 0) の真っ黒になる
    has_pure_black_in_transparent_area = False
    for y in range(h - 50, h - 10):
        for x in range(20, 60):
            pixel = combined.getpixel((x, y))
            # 赤色 (255, 0, 0) 以外の部分が透明領域
            if pixel[0] < 100:  # 赤ではない領域
                if pixel == (0, 0, 0):
                    has_pure_black_in_transparent_area = True

    assert not has_pure_black_in_transparent_area, "透過PNGの透明部分が黒潰れ（黒背景化）してはならない（白背景として合成されること）"


def test_export_documents_handles_multiple_files_with_empty_vault_path(tmp_path: Path) -> None:
    """vault_path='' で複数サブフォルダのファイルを渡した際、os未インポートエラーにならず親ディレクトリを解決して完了すること"""
    sub1 = tmp_path / "sub1"
    sub2 = tmp_path / "sub2"
    sub1.mkdir()
    sub2.mkdir()

    doc1 = sub1 / "doc1.md"
    doc2 = sub2 / "doc2.md"
    doc1.write_text("# ノート1\n内容1", encoding="utf-8")
    doc2.write_text("# ノート2\n内容2", encoding="utf-8")

    # vault_path="" で複数ファイルを渡す（os.path.commonpath の実行経路）
    md_content, _, stats = export_documents_to_markdown_and_image(
        file_paths=[str(doc1), str(doc2)],
        vault_path="",
    )

    assert stats["total_documents"] == 2
    assert "ノート1" in md_content
    assert "ノート2" in md_content


def test_export_documents_resilient_to_corrupted_email_files(tmp_path: Path) -> None:
    """破損したメールファイル（不正バイナリの.msg / .eml）がリンクされていてもクラッシュせずスキップすること"""
    corrupt_msg = tmp_path / "broken.msg"
    corrupt_msg.write_bytes(b"\x00\xff\xfe\x01\x02\x03\x04INVALID_MSG_BINARY_HEADER")

    corrupt_eml = tmp_path / "broken.eml"
    corrupt_eml.write_bytes(b"\xff\xfe\x00\x00\x00BAD_ENCODING")

    doc = tmp_path / "破損メール参照ノート.md"
    doc.write_text(
        """# 破損メール参照
[[broken.msg]]
[[broken.eml]]
""",
        encoding="utf-8",
    )

    # クラッシュ（500エラー）せず正常に終了すること
    md_content, _, stats = export_documents_to_markdown_and_image(
        file_paths=[str(doc)],
        vault_path=str(tmp_path),
        include_linked_emails=True,
    )

    assert stats["total_documents"] == 1
    assert "破損メール参照ノート" in md_content


def test_build_image_strip_maintains_high_resolution_for_large_images() -> None:
    """高解像度図面（幅2800px以上）を含む場合、幅1200pxに強制縮小されず高解像度（2400px以上）が維持され、かつ4.5MB以下であること"""
    from app.vector.markdown_image_exporter import build_image_strip

    # 幅 2800, 高さ 1800 の高解像度画像を模倣
    large_img = Image.new("RGB", (2800, 1800), color=(240, 240, 250))
    images_data = [
        {
            "index": 1,
            "note_name": "詳細設計図.md",
            "link_text": "![[詳細設計図.png]]",
            "image": large_img,
        }
    ]

    strip_bytes = build_image_strip(images_data)
    assert strip_bytes is not None
    assert len(strip_bytes) <= int(4.5 * 1024 * 1024)

    import io
    result_img = Image.open(io.BytesIO(strip_bytes))
    # 幅が 2400px 以上を維持していること（従来の 1200px + gap への強制縮小を行わない）
    assert result_img.width >= 2400, f"出力画像の幅が {result_img.width}px となり、高解像度が維持されていません"


def test_export_documents_prefers_high_resolution_for_excalidraw(tmp_path: Path) -> None:
    """Excalidrawノートから画像を取得する際、低解像度キャッシュに依存せず直接ベクターから高精細にラスタライズされること"""
    # 巨大なキャンバス（幅3000px）を持つExcalidrawノートを作成
    exc_file = tmp_path / "広大キャンバス.excalidraw.md"
    exc_file.write_text("""---
excalidraw-plugin: parsed
---
# Drawing
```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "https://excalidraw.com",
  "elements": [
    {
      "id": "rect1",
      "type": "rectangle",
      "x": 100,
      "y": 100,
      "width": 3000,
      "height": 2000,
      "strokeColor": "#000000",
      "backgroundColor": "#ffffff"
    },
    {
      "id": "txt1",
      "type": "text",
      "x": 200,
      "y": 200,
      "width": 400,
      "height": 50,
      "text": "詳細なシステム仕様",
      "fontSize": 24
    }
  ]
}
```
""", encoding="utf-8")

    doc = tmp_path / "仕様まとめ.md"
    doc.write_text("""# 仕様まとめ
![[広大キャンバス.excalidraw]]
""", encoding="utf-8")

    md_content, img_bytes, stats = export_documents_to_markdown_and_image(
        file_paths=[str(doc)],
        vault_path=str(tmp_path),
    )

    assert stats["total_images"] == 1
    assert img_bytes is not None
    assert len(img_bytes) <= int(4.5 * 1024 * 1024)

    import io
    res_img = Image.open(io.BytesIO(img_bytes))
    # 結合画像の幅が 2400px 以上の高精細解像度で出力されること
    assert res_img.width >= 2400, f"Excalidrawの出力幅が {res_img.width}px となり、文字が潰れる低解像度になっています"


