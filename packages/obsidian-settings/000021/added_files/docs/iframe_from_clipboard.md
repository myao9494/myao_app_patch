# スラッシュコマンド「iframe (from clipboard)」

## 概要
クリップボードの URL から `<iframe>` を作り、カーソル位置（選択中なら置き換え）へ挿入する。Google マイマップの埋め込みなど、ノートへ外部ページを表示するために使う。

## 動作
1. スラッシュコマンド `iframe (from clipboard)`（`custom:iframe-from-clipboard`）を実行する。並びは `From Clipboard` の次。
2. クリップボードの文字列から URL を取り出す（`extractIframeUrl`）。
   - URL だけ（前後の空白・山括弧・折り返された URL も可）、または `<iframe src="…">` のコピーを受け付ける。
   - `http` / `https` 以外（`javascript:`、`file:` など）と、URL でない文字列は受け付けない。
3. 次の形で挿入する（`buildIframeHtml`）。`src` の属性を壊す文字（`"` `<` `>`）は URL エンコードする。

```html
<iframe
  src="https://www.google.com/maps/d/embed?mid=1SzkuWimfv2iS53Xv-p42Ngdx3RXO5lTM"
  width="100%"
  height="600"
  style="border:0">
</iframe>
```

4. URL が無いときは「クリップボードに http(s) の URL がありません」と通知し、何も挿入しない。

## 実装対象
- `80_script/register_custom_commands/11_from_clipboard.js`（`extractIframeUrl` / `buildIframeHtml` / `iframeFromClipboard`）
- `80_script/register_custom_commands/13_commands.js`（コマンド登録）
- `.obsidian/plugins/slash-commander/data.json`（`From Clipboard` の次に配置）

## テスト
`scratch/test_from_clipboard.js`（`iframe (from clipboard)`）
