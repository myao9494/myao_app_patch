<!--
/**
 * AIインプット特大プレビュー＆ファイル選択調整モーダル フロー図
 * 
 * 1. AI用HTML生成トリガー: 「🚀 AI用HTMLファイルを生成する」ボタン押下
 * 2. 特大モーダル自動展開: 画面全体（96vw × 94vh）を活用した Glassmorphism モーダル起動
 * 3. 左右2カラム構成:
 *    - 左側ペイン: iframe リアルタイムプレビュー ＆ 生HTMLソース切替
 *    - 右側ペイン: 対象ファイル選択チェックボックス一覧（Catppuccinアイコン・パス表示）
 * 4. リアルタイム除外連動: チェックを外すとデバウンス（200ms）でバックエンドAPI再実行し、HTMLから即時除外
 * 5. ローカル保存＆クリップボード自動格納:
 *    - 「💾 HTMLを保存（パスをコピー）」押下
 *    - POST /api/export/ai-html/save により ~/Downloads 配下に安全書き込み
 *    - 保存された絶対ファイルパスを即座に navigator.clipboard.writeText でコピー
 *    - ChatGPT / Claude / Cursor 等に Command + V で即時投入可能
 **/
-->
---

excalidraw-plugin: parsed
tags: [excalidraw]

---
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==

# Excalidraw Data

## Text Elements
AIインプット 特大プレビュー & ファイル選択調整モーダル フロー ^title
① 「🚀 AI用HTMLファイルを生成する」 押下 ^step1
選択ファイル群をバックエンドへ送信し初期HTMLを生成 ^step1-desc
② 特大モーダル自動オープン (96vw × 94vh) ^step2
画面いっぱいに左右2カラムの Glassmorphism モーダルを展開 ^step2-desc
③-A 【左側ペイン】 HTMLプレビュー (iframe) ^step3a
生成された完全自己完結型HTMLを大画面でリッチに閲覧
タブ切り替えで生HTMLソースも確認・部分コピー可能 ^step3a-desc
③-B 【右側ペイン】 対象ファイル選択チェックボックス ^step3b
チェックを外す/付ける ➔ デバウンス(200ms)で自動再生成
除外されたドキュメントがリアルタイムでHTMLから消去！ ^step3b-desc
④ 「💾 HTMLを保存（パスをコピー）」 ボタン押下 ^step4
POST /api/export/ai-html/save により ~/Downloads 配下へ直接保存 ^step4-desc
⑤ 絶対パスをクリップボードへ自動格納 ^step5
保存された絶対ファイルパス（例: /Users/.../Downloads/AI_Context.html）を
クリップボードへ即時コピー ➔ ChatGPT / Claude / Cursor にそのまま Cmd+V！ ^step5-desc

## Element Metadata
{"title": "AIインプット 特大プレビュー & ファイル選択調整モーダル フロー"}
