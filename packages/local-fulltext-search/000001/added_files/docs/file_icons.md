# ファイル種別アイコン仕様書

## 概要
本アプリケーション（Webフロントエンドおよび各種デスクトップランチャー）では、検索結果一覧においてファイルの種類や拡張子を一目で判別できるよう、Catppuccin スタイルの統一された線画アイコンを採用しています。

## 対応アイコン一覧

| アイコン名 | ファイル名 | カラー / テーマ | 主な対象拡張子・種別 |
|---|---|---|---|
| **メール (Email)** | `email.svg` / `email.png` | `#1E66F5` (Blue) | `.msg`, `.eml` |
| **Markdown** | `markdown.svg` / `markdown.png` | `#209FB5` (Sapphire) | `.md`, `.markdown` |
| **PDF** | `pdf.svg` / `pdf.png` | `#D20F39` (Red) | `.pdf` |
| **JSON** | `json.svg` / `json.png` | `#DF8E1D` (Yellow) | `.json` |
| **XML** | `xml.svg` / `xml.png` | `#FE640B` (Peach) | `.xml` |
| **テキスト** | `txt.svg` / `txt.png` | `#4C4F69` (Text) | `.txt` |
| **CSV** | `csv.svg` / `csv.png` | `#40A02B` (Green) | `.csv` |
| **YAML** | `yaml.svg` / `yaml.png` | `#D20F39` (Red) | `.yaml`, `.yml` |
| **ZIP** | `zip.svg` / `zip.png` | `#DF8E1D` (Yellow) | `.zip` |
| **HTML** | `html.svg` / `html.png` | `#FE640B` (Peach) | `.html`, `.htm`, Webページ結果 |
| **JavaScript** | `javascript.svg` / `javascript.png` | `#DF8E1D` (Yellow) | `.js`, `.jsx` |
| **TypeScript** | `typescript.svg` / `typescript.png` | `#1E66F5` (Blue) | `.ts`, `.tsx` |
| **Python** | `python.svg` / `python.png` | `#1E66F5` / `#DF8E1D` | `.py` |
| **Excalidraw** | `excalidraw.svg` / `excalidraw.png` | 多色 | `.excalidraw` |
| **Draw.io** | `drawio.svg` / `drawio.png` | `#FE640B` (Peach) | `.dio`, `.drawio` |
| **EPUB** | `epub.svg` / `epub.png` | `#40A02B` (Green) | `.epub` |
| **画像** | `image.svg` / `image.png` | `#209FB5` / `#40A02B` | `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.webp` |
| **音声** | `audio.svg` / `audio.png` | `#D20F39` (Red) | `.mp3`, `.wav`, `.m4a` |
| **動画** | `video.svg` / `video.png` | `#1E66F5` (Blue) | `.mp4`, `.mov`, `.avi` |
| **フォルダ** | `folder.svg` / `folder.png` | `#fab387` (Peach) | ディレクトリ結果 |
| **タスク** | `task.svg` / `task.png` | `#209FB5` (Sapphire) | ganttタスク結果 |
| **その他一般** | `file.svg` / `file.png` | `#4C4F69` (Text) | 上記以外の一般ファイル |

## デザイン仕様
- **SVG 仕様**:
  - `viewBox="0 0 16 16"`
  - `stroke-width="1"`
  - `stroke-linecap="round"`
  - `stroke-linejoin="round"`
- **メールアイコン形状**:
  - 封筒の外枠: 幅 13px、高さ 9px、角丸 1.5px
  - 封筒のフラップ: 上部左右から中央下へ折り込まれる V 字ライン
- **PNG 仕様 (Windows WPF向け)**:
  - 解像度: 32x32 ピクセル、8-bit RGBA、透過背景

## 配置パス
- **Web クライアント**:
  - `frontend/public/icons/catppuccin/`
  - `frontend/dist/icons/catppuccin/`
- **デスクトップランチャー (macOS / Flet)**:
  - `launcher/src/launcher_app/assets/catppuccin/`
- **Windows WPF ランチャー**:
  - `launcher/windows/LocalSearchLauncher/Assets/catppuccin/`
  - `launcher/windows/publish/folder/Assets/catppuccin/`
  - `launcher/windows/publish/single-file/Assets/catppuccin/`
