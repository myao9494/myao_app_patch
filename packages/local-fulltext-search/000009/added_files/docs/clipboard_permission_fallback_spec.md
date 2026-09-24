<!-- 仕様: クリップボード権限エラー（User Activation失効）防止 & 安全フォールバック仕様書 -->
# クリップボード権限エラー（User Activation失効）防止 & 安全フォールバック仕様書

## 1. 課題と原因分析

### 1.1 発生したエラー
AIインプット画面で「💾 PDFを保存（パスをコピー）」を実行した際、以下のエラーアラートが表示される事象が発生した：
```
PDF保存に失敗しました: The request is not allowed by the user agent or the platform in the current context, possibly because the user denied permission.
```

### 1.2 原因
1. **非同期処理に伴う User Activation（一時的ユーザー操作権限）の失効**:
   - ブラウザ（Chromium / Safari / Firefox）の `navigator.clipboard.writeText()` は、ユーザーのクリック等の直接操作（User Activation）が有効なコンテキストでのみ許可される。
   - バックエンドでの高精度PDF生成（PlaywrightによるChromium描画やPDF結合）には 2〜5 秒程度の通信・処理時間がかかる。
   - `await saveAiPdfToFile(...)` の完了後にはブラウザの User Activation Window がタイムアウト（失効）しており、`navigator.clipboard.writeText` が `NotAllowedError` をスローする。
2. **エラーハンドリングの混同（偽のエラー表示）**:
   - `saveAiPdfToFile`（PDF生成・ローカル保存）自体は**正常に成功してファイルが保存されている**にもかかわらず、その後のクリップボードコピー処理が同一の `try-catch` ブロック内にあったため、クリップボードのエラーが「PDF保存に失敗しました」としてユーザーに誤認表示されていた。
3. **会社PC等の制限環境**:
   - 端末やブラウザのセキュリティポリシー（非HTTPS環境、iframe内、組織ポリシー）により、Clipboard API へのアクセスがブロックされる場合がある。

---

## 2. 解決策と仕様

### 2.1 堅牢なクリップボードヘルパー (`clipboard.ts`)
`copyTextToClipboard(text: string): Promise<boolean>` を新設する。
1. **第一優先 (Modern Clipboard API)**:
   - `window.isSecureContext` かつ `navigator.clipboard?.writeText` が利用可能な場合、`await navigator.clipboard.writeText(text)` を実行。
2. **フォールバック (Legacy DOM execCommand)**:
   - 上記で例外（`NotAllowedError` など）が発生した場合、または API が未サポートの場合、画面外の見えない `<textarea>` を一時生成して選択し、`document.execCommand("copy")` を実行。
3. **例外スローの防止**:
   - いずれの方式も失敗した場合は `false` を返し、エラーをスローしてメイン処理を中断させない。成功時は `true` を返す。

### 2.2 保存処理とクリップボードコピーの責務分離 (`AiInputPage.tsx`)
- **PDF保存 (`handleSavePdfAndCopyPath`)**:
  - `saveAiPdfToFile` の成否のみを `try-catch` で判定。失敗時は「PDF保存に失敗しました」と表示。
  - 保存成功後（`res.saved_path` 取得後）、`copyTextToClipboard` でパスのコピーを試みる。
  - コピー成功時: `✅ PDF保存 & パスコピー完了: ${res.saved_path}`
  - コピー失敗時（権限制限時）: `✅ PDF保存完了 (パス手動コピー): ${res.saved_path}` を表示し、パス選択用プロンプトまたはフィードバックバナーで確実にパスを提示する。
- **HTML保存 (`handleSaveHtmlAndCopyPath`)**:
  - PDFと同様に、ファイル保存の成功判定とクリップボードコピーを完全に分離。

---

## 3. テスト計画 (TDD)
1. `clipboard.test.ts`:
   - `navigator.clipboard.writeText` 成功時に `true` を返すこと。
   - `navigator.clipboard.writeText` が拒否された際に `document.execCommand` にフォールバックして成功すること。
   - 全方式失敗時に `false` を返し、例外を投げないこと。
2. `vectorSearchUi.test.ts`:
   - `AiInputPage.tsx` が `copyTextToClipboard` を利用していること。
   - クリップボードコピー失敗時でも保存成功メッセージが表示されること。
