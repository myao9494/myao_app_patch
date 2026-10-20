---
tags:
  - spec
  - css
  - style
---

# 太字スタイルの仕様

## 概要
Obsidian内の太字（Bold）テキストの可視性を向上させるため、スタイルをカスタマイズしました。

## 変更内容
**対象**: `**text**` (Markdownの太字記法)

### スタイル定義
```css
/* Live Preview & Reading View */
color: #ffff00;            /* 文字色: 黄色 */
text-shadow: 0 0 10px #ffff00; /* 発光（グロー）効果 */
background-color: transparent; /* 背景なし */
font-size: 1.2em;          /* サイズ拡大 */
font-weight: bold;         /* 太字 */
```

### 対象の範囲
- ライブプレビュー: `.cm-strong`
- 閲覧モード: `.markdown-preview-view strong`
- ライブプレビュー内のコールアウト（`> [!Danger]` など）・埋め込み: `.markdown-rendered strong`
  （コールアウトはライブプレビュー中でも閲覧モードと同じ HTML で描画され、`.cm-strong` も `.markdown-preview-view` も付かないため）
- Dataview の表の中は対象外（ファイル名を読みやすくするため）

## 適用方法
- `.obsidian/snippets/bold-style.css` にCSSを配置
- `appearance.json` にてスニペットを有効化
