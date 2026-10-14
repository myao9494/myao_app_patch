<!-- 仕様: クリップボード権限エラー（User Activation失効）防止 & 安全フォールバック仕様書 -->
# クリップボード権限エラー（User Activation失効）防止 & 安全フォールバック仕様書

## 1. 背景

AIインプット画面で「保存してパスをコピー」を行うと、ファイルの保存自体は成功しているのに、次のエラーが「保存失敗」として表示されることがあった。

```
The request is not allowed by the user agent or the platform in the current context, possibly because the user denied permission.
```

原因は次の 3 点。

1. **User Activation（一時的なユーザー操作権限）の失効**:
   ブラウザの `navigator.clipboard.writeText()` は、クリックなどの直接操作が有効な間しか許可されない。
   サーバーでのファイル生成・保存を `await` している数秒の間にこの権限が失効し、`NotAllowedError` になる。
2. **保存の失敗とコピーの失敗を区別していなかった**:
   保存とクリップボードコピーが同じ `try-catch` の中にあり、コピーの失敗が「保存に失敗しました」と表示されていた。
3. **制限環境**:
   非 HTTPS、iframe 内、組織ポリシーなどにより、Clipboard API そのものが使えない端末がある。

> この仕様はもともと PDF 保存で顕在化したが、PDF 機能は撤廃済み。現在は HTML の保存・コピーで同じ仕組みを使っている。

## 2. 仕様

### 2.1 クリップボードヘルパー（`frontend/src/clipboard.ts`）

`copyTextToClipboard(text: string): Promise<boolean>`

1. `navigator.clipboard.writeText` が使える場合はそれを試す。
2. 例外（`NotAllowedError` など）が出た場合、または API が無い場合は、画面外に一時的な `<textarea>` を作って選択し、`document.execCommand("copy")` を試す。
3. どちらも失敗したら `false` を返す。**例外は投げない**（呼び出し元の処理を中断させない）。成功時は `true`。
4. 空文字列は何もせず `false`。

### 2.2 保存とコピーの責務分離（`frontend/src/hooks/useAiDocumentBuilder.ts`）

- **HTML をローカル保存してパスをコピー（`handleSaveHtmlAndCopyPath`）**
  - `saveAiHtmlToFile`（`POST /api/export/ai-html/save`）の成否だけを保存の成否として扱う。
  - 保存に成功したら、返ってきた `saved_path` を `copyTextToClipboard` でコピーする。
  - コピー成功: `✅ パスをコピーしました: {saved_path}`
  - コピー失敗: `✅ HTML保存完了 (パス手動コピー): {saved_path}`（保存は成功として扱い、パスを画面に表示する）
- **HTML ソースのコピー（`copyHtmlCode`）**: 同じヘルパーを使う。

マークダウン + 結合画像の 2 ファイル保存（`handleSaveBundle`）はパスをコピーせず、保存先フォルダを「📂 フォルダを開く」で開く運用のため対象外。

## 3. テスト

- `frontend/src/clipboard.test.ts`
  - `navigator.clipboard.writeText` 成功時に `true` を返す。
  - 拒否された場合に `document.execCommand` へフォールバックして成功する。
  - すべて失敗しても例外を投げず `false` を返す。
- `frontend/src/aiInputInteraction.test.ts`
  - HTML 保存で、保存先のパスをクリップボードへコピーすること。
  - クリップボードへ書き込めない環境でも、保存は成功として扱い、パスを手で写せるよう表示すること。
