# 画像ビューワー仕様書 (Image Viewer)

## 概要
画像ファイル（`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.bmp`, `.ico`, `.avif`）をアプリケーション内で直接プレビュー表示する機能です。大画面モーダルによる高品質な画像閲覧、ズーム・回転、同一フォルダ内の前後画像への高速移動、画像メタデータ（解像度・ファイルサイズ）の表示を提供します。

---

## 主な機能

1. **インライン画像配信バックエンド (`GET /api/view-image`)**:
   - `path` クエリパラメータで指定された画像ファイルを、適切な Content-Type（`image/png`, `image/jpeg` 等）と `inline` ヘッダーを付与して配信。
   - 日本語ファイル名に対応した RFC 2231 エンコードをサポート。
   - パストラバーサル保護および非画像ファイルの拒絶。

2. **美麗なモーダルUI (`ImagePreviewModal`)**:
   - 背景にダーク半透明オーバーレイ（Blur効果付き）を採用。
   - 画面中央に画像を最大サイズでアスペクト比を維持して表示。

3. **ズーム & 回転コントロール**:
   - ズームイン (`+`), ズームアウト (`-`), 100%等倍リセット (`0`), 90度回転。

4. **フォルダ内画像ナビゲーション**:
   - 同一フォルダ内の画像一覧を自動検出し、前後の画像へワンクリックまたは矢印キー（`←` / `→`）で遷移。
   - カウンター表示（例: `3 / 12`）。

5. **メタデータ & ユーティリティ**:
   - 自然解像度（幅 × 高さ px）およびファイルサイズの表示。
   - ダウンロード機能、ブラウザの別タブで開く機能。

6. **キーボードショートカット**:
   - `Escape`: プレビューを閉じる
   - `←` / `→`: 前の画像 / 次の画像
   - `+` / `=`: 拡大
   - `-`: 縮小
   - `0`: 実寸/フィットリセット

---

## アーキテクチャ図（Excalidraw形式）

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "https://excalidraw.com",
  "elements": [
    {
      "type": "rectangle",
      "id": "fe-trigger",
      "x": 60,
      "y": 80,
      "width": 200,
      "height": 90,
      "strokeColor": "#2563eb",
      "backgroundColor": "#eff6ff",
      "fillStyle": "solid",
      "strokeWidth": 2
    },
    {
      "type": "text",
      "id": "fe-trigger-text",
      "x": 75,
      "y": 95,
      "text": "【トリガー】\n・画像ダブルクリック\n・Enterキーで開く\n・右クリック「画像を表示」",
      "fontSize": 13
    },
    {
      "type": "arrow",
      "id": "arrow-1",
      "x": 260,
      "y": 125,
      "width": 80,
      "height": 0,
      "strokeColor": "#1e293b"
    },
    {
      "type": "rectangle",
      "id": "fe-modal",
      "x": 340,
      "y": 60,
      "width": 260,
      "height": 130,
      "strokeColor": "#10b981",
      "backgroundColor": "#ecfdf5",
      "fillStyle": "solid",
      "strokeWidth": 2
    },
    {
      "type": "text",
      "id": "fe-modal-text",
      "x": 355,
      "y": 75,
      "text": "【ImagePreviewModal】\n・拡大/縮小/回転/リセット\n・前後画像送り (← / →)\n・解像度/ファイルサイズ表示\n・ダウンロード/別タブ表示",
      "fontSize": 13
    },
    {
      "type": "arrow",
      "id": "arrow-2",
      "x": 600,
      "y": 125,
      "width": 80,
      "height": 0,
      "strokeColor": "#1e293b"
    },
    {
      "type": "rectangle",
      "id": "be-api",
      "x": 680,
      "y": 80,
      "width": 220,
      "height": 90,
      "strokeColor": "#8b5cf6",
      "backgroundColor": "#f5f3ff",
      "fillStyle": "solid",
      "strokeWidth": 2
    },
    {
      "type": "text",
      "id": "be-api-text",
      "x": 695,
      "y": 95,
      "text": "【Backend API】\nGET /api/view-image?path=...\n・MIMEタイプ自動判定\n・inline Content-Disposition",
      "fontSize": 13
    }
  ]
}
```
