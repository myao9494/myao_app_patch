# Delete Active File コマンド仕様書

## 概要
現在のアクティブファイルを削除する Templater コマンド。
確認 UI を出したうえで、必要に応じて関連添付ファイルも一緒に system trash へ移動する。

## 実装場所
- `00_templates/RegisterCustomCommands.md`

## トリガー
- **ショートカット**: `Delete` キー (`Fn + Backspace`)
- **コマンドパレット**: `Delete Active File`

## 実行ガード
以下の場合は `Delete` キーを横取りしない。
- ユーザーが `input` / `textarea` / `contentEditable` で入力中
- モーダル (`.modal`) またはプロンプト (`.prompt`) 表示中
- タグペイン (`.workspace-leaf[data-type="tag"]`) にフォーカスがある
- ファイルエクスプローラー (`.nav-files-container`) にフォーカスがある
- Excalidraw または MarkMind（マインドマップ）の編集中（図形・ノードの削除を優先）
- CAD Viewer 内の要素にフォーカスがある（`.step-viewer-embed` または `[data-type='step-viewer-view']`）。CAD Viewer は選択中の注記・寸法バッジを `Delete` / `Backspace` で削除するため、キー操作をビューア側へ渡す
- フォーカス要素またはアクティブファイルが存在しない

## 挙動
1. アクティブファイルがなければ通知して終了する
2. アクティブファイルの `cache.links` と `cache.embeds` を走査する
3. `getFirstLinkpathDest()` で解決できる非 Markdown ファイル（画像、msg、pptx など）を関連ファイルとして抽出する
4. `01_data/common_image` 配下、および削除元以外の Markdown ノートから参照されているファイルを候補から除外する
5. 関連ファイルがない場合は、通常の `window.confirm` を表示し、承認された場合のみメインファイルを削除する
6. 関連ファイルがある場合は、チェックボックス付き一覧を持つ削除確認モーダルを表示する
7. `すべて選択` を使って一括選択できる
8. `削除` 実行時、選択された関連ファイルを先に削除し、その後メインファイルを削除する
9. 削除は `app.vault.trash(file, true)` を使い、system trash へ移動する

## 関連ファイルの対象
- 拡張子を限定せず、リンクまたは埋め込みで参照されたすべての非 Markdown ファイル
- `01_data/common_image` 配下のファイルは対象外
- 他の Markdown ノートからも参照されているファイルは対象外

## 補足
- 関連ファイルの初期状態は未選択
- 関連ファイルがある場合、メインファイル自体はモーダルの `削除` ボタン押下時に削除対象
- リスナー重複を防ぐため、`window._customDeleteListener` を使って再登録前に解除する

## テスト
- [scratch/test_delete_key_guard.js](file:///Users/mine/000_work/obsidian-dagnetz/scratch/test_delete_key_guard.js): テンプレート内の `handleDeleteKey` を読み込み、発動条件と各ガードを検証する。

## 変更履歴
- **2026-10-10**: CAD Viewer の注記・寸法を選択中に `Delete` を押すとノート削除の確認が開く競合を解消（CAD Viewer へのフォーカス時は横取りしない）。フォーカス要素が無い場合の例外も防止。
- **2026-06-25**: 関連ファイルがない場合は通常確認のみを表示する仕様へ明記し、実装も合わせて修正。
- **2026-06-18**: 添付対象を全非 Markdown ファイルへ拡張し、common_image と他ノートから参照中のファイルを除外。
- **2026-03-20**: 現行実装に合わせて、system trash 利用、常時モーダル表示、関連ファイル抽出手順を明記。
- **2026-01-17**: Backspaceキーでの誤動作防止のため、トリガーを `Delete` キーのみに限定。また、タグ設定画面やモーダル表示中の誤作動防止ガードを追加。
