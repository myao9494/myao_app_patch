# 起動速度の改善 (Startup Performance Optimization)

## 背景と課題
Obsidianの起動時に非常に長い時間がかかり、プラグインのロード遅延警告やセーフモードでの起動確認画面が頻発していました。
このボトルネックの原因を調査した結果、起動時に同期実行されている以下の2つの処理がメインスレッドを長時間占有（ブロッキング）していることが判明しました。

1.  **自作プラグイン `obsidian-sidebar-explorer` の画像パス解決処理・重要度インデックス更新**
    *   `onload()` 内で `await this.exportImagePathsJson();` が呼び出されており、保管庫全体のすべてのファイルを同期的に走査してマップ構築・JSON書き出しを行っていました。
    *   さらに通常ノート編集中でも `metadataCache.changed/resolved` を契機に全Markdownの重要度再計算が予約され、Windows環境では保存・同期・Defender監視と重なってカクつきの原因になっていました。
2.  **`RegisterCustomCommands.md` の起動時自動MOC移動処理**
    *   スクリプトがロードされた2秒後に、保管庫内のすべてのMarkdownファイルをスキャンして自動的にMOCフォルダへ移動する処理（`moveMocFiles()`）がバックグラウンドで強制実行されていました。

---

## 改善内容

### 1. `obsidian-sidebar-explorer` の初期化タイミング調整
起動をブロックしていた同期的な処理を、Obsidianの画面レイアウトの構築が完全に終わった後（`onLayoutReady`）に実行するように変更します。これにより、Obsidianの起動プロセスが即座に完了するようになります。

**変更前 (onload):**
```typescript
async onload() {
    await this.loadSettings();
    this.scheduleFileImportanceRefresh(15000);
    await this.exportImagePathsJson();
    ...
}
```

**変更後:**
```typescript
async onload() {
    await this.loadSettings();
    this.scheduleFileImportanceRefresh(60000);
    
    // UIレイアウト構築後に遅延して画像パス解決を実行 (ブロッキング回避)
    this.app.workspace.onLayoutReady(() => {
        this.scheduleImagePathsExport(30000);
    });
    ...
}
```

### 1.1 通常編集時の全件再計算を抑制
通常ノートを開く・編集するだけでは重い全件再計算を走らせない方針に変更します。

**変更内容:**
* `file-open` ではアクセス数と最終オープン日時のみを軽量更新し、全Markdown重要度再計算は予約しない。
* `create` / `delete` / `rename` では重要度インデックス更新を約60秒遅延。
* `metadataCache.changed` / `deleted` / `resolved` では重要度インデックス更新を約30分遅延。
* `Refresh Sidebar Explorer Index` コマンドを追加し、必要なタイミングで重要度インデックスと画像パス解決インデックスを手動更新できるようにする。
* 重要度TOP8 のセクションは現在表示していない（重要度のデータは外部のアプリが使うため、計算と保存は続ける）。ファイルの移動・改名・削除での `data.json` の保存は、約3秒後にまとめて1回にする。

### 1.2 画像パス解決インデックスの書き出し集約
`plugins/obsidian-sidebar-explorer/image_paths.json` の更新は、画像変更イベントごとに即時書き出さず、短いデバウンスでまとめます。

**変更内容:**
* 起動時は `onLayoutReady` 後さらに遅延して書き出す。
* 画像ファイルの作成・リネーム・削除時は `scheduleImagePathsExport()` でキュー化する。
* 書き出し中に追加イベントが来た場合は、完了後にもう一度だけ再予約する。

---

### 2. 起動時の自動MOC移動処理の廃止
起動時に裏で全Markdownファイルのスキャンを実行していた自動処理を廃止します。
MOCフォルダの移動整理自体は機能として便利であるため、ユーザーが意図したタイミングで手動で実行できるようにコマンド（`MOCファイルを移動 (Move MOC Files)`）のみを残します。

**変更内容:**
*   `RegisterCustomCommands.md` の末尾付近にある `window._hasRunMocAutoMove` を使用した `setTimeout` ブロックを完全に削除。
*   手動コマンド `custom:move-moc-files` の定義はそのまま維持。

---

## 期待される効果
*   Obsidian全体の起動時間が大幅に短縮され、動作が軽量化されます。
*   起動プロセス中の同期的なファイル走査やディスクI/Oが消失するため、ロード遅延による「セーフモード起動確認ダイアログ」が完全に解消されます。
*   通常ノート編集中に全Markdown再計算や画像パスJSON書き出しが頻発しなくなり、Windows環境でのカクつきを抑制します。
