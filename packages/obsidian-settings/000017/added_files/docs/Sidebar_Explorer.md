---
tags:
  - dashboard
  - plugin
---

# Sidebar Explorer 現行メモ

このノートは Dataview 試作ではなく、現在使っている `obsidian-sidebar-explorer` プラグイン実装の要点メモとして扱う。

## 実装場所
- ソース: `plugins/obsidian-sidebar-explorer`
- 実体: `.obsidian/plugins/obsidian-sidebar-explorer` は上記へのシンボリックリンク

## 現在のセクション
1. 今日のフォルダ
2. 開いている関連ファイル
3. 最近開いたファイル
4. アクセス数 TOP8

## 今日のフォルダ
- 対象フォルダは `01_data/YYYY/MM/DD`
- `.md` のみに絞らず、その日のフォルダ配下にあるすべての `TFile` を表示する
- ヘッダークリックでセクション開閉
- タイトル部分クリックで OS のファイラから当日のフォルダを開く

## 関連ファイル
- アクティブファイルを基準に `Links to:` と `Linked from:` を表示する
- `Links to:` は `cache.links` と `cache.embeds` を両方走査する
- Markdown ファイルは常時表示する
- 添付ファイルやその他ファイルは折りたたみ表示する
- バックリンクは `resolvedLinks` に加えて `unresolvedLinks` も確認し、`getFirstLinkpathDest()` で現在ファイルへ解決されるものを含める
- これにより `[[xxx.excalidraw]]` のような拡張子省略リンクも Excalidraw のバックリンクとして扱える
- CAD Viewer のコードブロック（```` ```step ```` / ```` ```cad ````）で表示している CAD ファイルも関連ファイルに含める
  - コードブロックはリンクではなく `cache.links` / `cache.embeds` に載らないため、本文から `path:` を読む（`extractCadCodeBlockPaths`）。字下げの無い `path:` 行、無ければキーの無い最初の行をパスとする（CAD Viewer の `parseStepCodeBlock` と同じ読み方）
  - パスは CAD Viewer と同じ順序で解決する（`getFirstLinkpathDest`、だめなら Vault のパス。`resolveCadCodeBlockPath`）
  - ノートを開いたとき: 呼び出している CAD ファイルを `Links to:` の折りたたみ（Attachments / Others）に出す
  - CAD ファイルを開いたとき: それを呼び出しているノートを `Linked from:` に出す（`getCadCodeBlockBacklinkPaths`）
  - 起動時に、コードブロックを含むノートの本文を1回読んで「ノート → コードブロックのパス」の索引を作る（`buildCadCodeBlockIndex`）。以降は `metadataCache` の `changed` が渡す本文から更新し、削除・改名にも追従する
  - CAD ファイルの拡張子（`step`, `stp`, `fcstd`, `obj`, `stl`）は添付ファイル扱い（`isAttachmentFile`）。`[[xxx.step]]` のリンクも関連ファイルと削除時の添付候補に出る

## Excalidraw 連携
- `.excalidraw.md` ファイルの `Webアプリで開く` メニューは `RegisterCustomCommands.md` 側に集約する
- Sidebar Explorer 独自メニューでは `web app urlをコピー` を提供し、同種の「開く」項目の重複表示を避ける
- URL は `http://localhost:3001/?filepath={絶対パス}` を使う
- Windows の `\` は事前に `/` へ正規化し、パス区切り `/` は維持しつつ、各パスセグメントを `encodeURIComponent` でエンコードする

## 削除
- サイドバー項目の右クリック `Delete` と、選択中項目への `Delete` / `Cmd+Backspace` で削除導線を出す
- 関連添付がない場合は `window.confirm`
- 関連添付がある場合は選択式モーダルを開く
- 削除対象は system trash に移動する
- 添付判定は関連ファイル表示と共通のリンク解決ロジックを使う

## ノート一覧
- Sidebar Explorer Tag 側の「ノート一覧を追加」は `# note一覧` セクションをMarkdownテーブルで生成する
- 新規生成分には `<!-- custom-note-list:start -->` / `<!-- custom-note-list:end -->` マーカーを入れ、更新時はその範囲だけを置換する
- マーカーがない旧形式の一覧は、見出し直下の表または箇条書き部分だけを置換し、通常本文を巻き込まない

## 補足
- アイコンは `.obsidian/plugins/obsidian-sidebar-explorer/icons` から読み込み、メモリキャッシュする
- 最近開いたファイルとアクセス数はプラグイン設定 (`data.json`) に保持する
- `Refresh Sidebar Explorer Index` コマンドで、重要度インデックスと画像パス解決インデックスを手動更新できる

## パフォーマンス方針
- 通常ノート編集中は、全Markdown再集計や画像インデックス書き出しを即時実行しない
- `file-open` ではアクセス数と最終オープン日時のみを軽量更新する
- Vault の `create` / `delete` / `rename` では重要度インデックス更新を約60秒遅延させる
- `metadataCache.changed` / `deleted` / `resolved` では重要度インデックス更新を約5分遅延させ、頻繁な編集時の全件走査を避ける
- `image_paths.json` のエクスポートは起動直後に同期実行せず、レイアウト準備後に遅延実行する。画像変更時もデバウンスして複数イベントをまとめる
- Sidebar表示中の重要度TOP8再描画は即時ではなくデバウンスする

## 画像を開く/閉じるボタンとトグル分割表示、およびスラッシュコマンド
- サイドバーエクスプローラーの一番上に、「画像一覧の表示」ボタンを配置。
  - デザインはサイドバーに馴染む地味なフラットスタイル（透明背景、極細枠線、ホバー時のみ強調）。
- クリック時、およびコマンド `obsidian-excalidraw-cards:excalidraw_open_close` 実行時にトグル動作を行う：
  - **すでに開いている場合**: 開いているタブ（リーフ）を閉じる（`leaf.detach()`）。
  - **開いていない場合**: `obsidian-excalidraw-cards` の画像一覧ビューが現在アクティブなタブの下（上下分割した新しいタブグループ）に開かれる。
- 実装詳細：
  - `workspace.iterateAllLeaves` ですべての開いているタブを走査し、すでに対象ファイルが開かれているか検出する。
  - 開いていれば `detach()` を呼び出す。
  - 開いていなければ `workspace.getLeaf('split', 'horizontal')` を用いて上下分割した新しい WorkspaceLeaf を作成し、画像一覧ビューを開く。
