<!--
/**
 * AIインプット: 高精度PDFエクスポート処理フロー図
 * 
 * 1. AIインプット画面で対象ドキュメント選択＆HTMLプレビュー生成
 * 2. ユーザーが「PDFダウンロード」または「PDFを保存（パスをコピー）」をクリック
 * 3. バックエンド pdf_converter:
 *    - 端末ブラウザ（Chrome / Edge）を Playwright でヘッドレス起動
 *    - HTML（Base64画像・SVG・Markdown展開済み）をロード
 *    - @media print CSS によるレイアウト＆改ページ最適化適用
 *    - page.pdf(format='A4', print_background=True) で高品質PDFバイナリ生成
 * 4. クライアント返却:
 *    - ダウンロード: ブラウザDL
 *    - 保存: Downloadsフォルダ等に保存＆絶対パスをクリップボードに自動コピー
 *    - 社内AIへ即座に投入可能！
 **/
-->
---

excalidraw-plugin: parsed
tags: [excalidraw]

---
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==

# Excalidraw Data

## Text Elements
AIインプット: 高精度PDFエクスポート処理フロー ^title
① 対象ドキュメント選択 & HTML生成 (AiInputPage / export_documents_to_html) ^step1
Markdown・Excalidraw図面・メール等をBase64インライン統合したHTMLを準備 ^step1-desc
② PDF出力トリガー (ユーザー操作) ^step2
【ボタン1】PDFダウンロード (.pdf)  /  【ボタン2】PDF保存（パスをコピー） ^step2-desc
③ ヘッドレスブラウザ起動 (pdf_converter.py) ^step3
端末インストール済みの Chrome または Edge を自動検出して起動 (追加DL不要) ^step3-desc
④ レンダリング & PDF生成 (Playwright) ^step4
・@media print CSS (A4サイズ、改ページ制御、背景色維持)
・Base64画像・SVGベクター図面・テーブルを忠実に描画
・page.pdf(format="A4", print_background=True) で高品質バイナリ生成 ^step4-desc
⑤ 出力・連携 (ダウンロード または ローカル保存 & パスコピー) ^step5
社内AIのチャット画面へドラッグ＆ドロップ、またはパス指定で投入！ ^step5-desc

## Drawing
```json
{
	"type": "excalidraw",
	"version": 2,
	"source": "https://excalidraw.com",
	"elements": [
		{
			"type": "rectangle",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "box-title",
			"fillStyle": "solid",
			"strokeWidth": 2,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 40,
			"y": 40,
			"strokeColor": "#6366f1",
			"backgroundColor": "#1e1b4b",
			"width": 780,
			"height": 55,
			"seed": 10001,
			"groupIds": [],
			"roundness": { "type": 3 }
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "text-title",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 60,
			"y": 55,
			"strokeColor": "#c7d2fe",
			"backgroundColor": "transparent",
			"width": 700,
			"height": 26,
			"seed": 10002,
			"groupIds": [],
			"roundness": null,
			"fontSize": 20,
			"fontFamily": 1,
			"text": "AIインプット: 高精度PDFエクスポート処理フロー",
			"textAlign": "left",
			"verticalAlign": "middle"
		},
		{
			"type": "rectangle",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "box-step1",
			"fillStyle": "solid",
			"strokeWidth": 1.5,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 40,
			"y": 120,
			"strokeColor": "#3b82f6",
			"backgroundColor": "#172554",
			"width": 780,
			"height": 80,
			"seed": 10003,
			"groupIds": [],
			"roundness": { "type": 3 }
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "text-step1",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 60,
			"y": 135,
			"strokeColor": "#93c5fd",
			"backgroundColor": "transparent",
			"width": 740,
			"height": 48,
			"seed": 10004,
			"groupIds": [],
			"roundness": null,
			"fontSize": 15,
			"fontFamily": 1,
			"text": "① 対象ドキュメント選択 & HTML生成\nMarkdown・Excalidraw図面・メール等をBase64インライン統合したHTMLを準備",
			"textAlign": "left",
			"verticalAlign": "top"
		},
		{
			"type": "rectangle",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "box-step2",
			"fillStyle": "solid",
			"strokeWidth": 1.5,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 40,
			"y": 220,
			"strokeColor": "#8b5cf6",
			"backgroundColor": "#2e1065",
			"width": 780,
			"height": 80,
			"seed": 10005,
			"groupIds": [],
			"roundness": { "type": 3 }
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "text-step2",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 60,
			"y": 235,
			"strokeColor": "#c4b5fd",
			"backgroundColor": "transparent",
			"width": 740,
			"height": 48,
			"seed": 10006,
			"groupIds": [],
			"roundness": null,
			"fontSize": 15,
			"fontFamily": 1,
			"text": "② PDF出力トリガー (ユーザー操作)\n【ボタン1】PDFダウンロード (.pdf)  /  【ボタン2】PDF保存（パスをコピー）",
			"textAlign": "left",
			"verticalAlign": "top"
		},
		{
			"type": "rectangle",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "box-step3",
			"fillStyle": "solid",
			"strokeWidth": 1.5,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 40,
			"y": 320,
			"strokeColor": "#06b6d4",
			"backgroundColor": "#083344",
			"width": 780,
			"height": 80,
			"seed": 10007,
			"groupIds": [],
			"roundness": { "type": 3 }
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "text-step3",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 60,
			"y": 335,
			"strokeColor": "#67e8f9",
			"backgroundColor": "transparent",
			"width": 740,
			"height": 48,
			"seed": 10008,
			"groupIds": [],
			"roundness": null,
			"fontSize": 15,
			"fontFamily": 1,
			"text": "③ ヘッドレスブラウザ起動 (pdf_converter.py)\n端末インストール済みの Chrome または Edge を自動検出して起動 (追加DL不要)",
			"textAlign": "left",
			"verticalAlign": "top"
		},
		{
			"type": "rectangle",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "box-step4",
			"fillStyle": "solid",
			"strokeWidth": 1.5,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 40,
			"y": 420,
			"strokeColor": "#10b981",
			"backgroundColor": "#022c22",
			"width": 780,
			"height": 95,
			"seed": 10009,
			"groupIds": [],
			"roundness": { "type": 3 }
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "text-step4",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 60,
			"y": 435,
			"strokeColor": "#6ee7b7",
			"backgroundColor": "transparent",
			"width": 740,
			"height": 65,
			"seed": 10010,
			"groupIds": [],
			"roundness": null,
			"fontSize": 14,
			"fontFamily": 1,
			"text": "④ レンダリング & PDF生成 (Playwright)\n・@media print CSS (A4サイズ、改ページ制御、背景色維持)\n・Base64画像・SVGベクター図面・テーブルを忠実に描画\n・page.pdf(format='A4', print_background=True) で高品質バイナリ生成",
			"textAlign": "left",
			"verticalAlign": "top"
		},
		{
			"type": "rectangle",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "box-step5",
			"fillStyle": "solid",
			"strokeWidth": 1.5,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 40,
			"y": 535,
			"strokeColor": "#f59e0b",
			"backgroundColor": "#451a03",
			"width": 780,
			"height": 80,
			"seed": 10011,
			"groupIds": [],
			"roundness": { "type": 3 }
		},
		{
			"type": "text",
			"version": 1,
			"versionNonce": 1,
			"isDeleted": false,
			"id": "text-step5",
			"fillStyle": "solid",
			"strokeWidth": 1,
			"strokeStyle": "solid",
			"roughness": 1,
			"opacity": 100,
			"angle": 0,
			"x": 60,
			"y": 550,
			"strokeColor": "#fcd34d",
			"backgroundColor": "transparent",
			"width": 740,
			"height": 48,
			"seed": 10012,
			"groupIds": [],
			"roundness": null,
			"fontSize": 15,
			"fontFamily": 1,
			"text": "⑤ 出力・連携 (ダウンロード または ローカル保存 & パスコピー)\n社内AIのチャット画面へドラッグ＆ドロップ、またはパス指定で投入！",
			"textAlign": "left",
			"verticalAlign": "top"
		}
	],
	"appState": {
		"viewBackgroundColor": "#0f172a",
		"gridSize": 20
	},
	"files": {}
}
```
