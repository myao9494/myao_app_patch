<!-- 仕様: コールアウトスラッシュコマンドおよび引用一括適用ショートカット（ctrl + .）の設計・実装仕様 -->
# コールアウトスラッシュコマンドおよび引用ショートカット (ctrl + .) 仕様書

## 1. 概要
本機能は、Obsidianエディタにおいて特定のコールアウト（important, warning, Danger）を即座に挿入するコマンド（スラッシュコマンドから呼び出し可能）を追加し、また `ctrl + .` ショートカットを用いて複数行の選択範囲に一括で引用符（`>`）を適用するものである。

## 2. 詳細仕様

### 2.1 コールアウト挿入コマンド
以下の3つのコマンドを登録する。

1. **Callout Important**
   - ID: `custom:callout-important`
   - 挙動: カーソル位置または選択範囲を以下のテキストで置換する。
     ```markdown
     > [!important] 
     > Contents
     ```

2. **Callout Warning**
   - ID: `custom:callout-warning`
   - 挙動: カーソル位置または選択範囲を以下のテキストで置換する。
     ```markdown
     > [!warning] 
     > Contents
     ```

3. **Callout Danger**
   - ID: `custom:callout-danger`
   - 挙動: カーソル位置または選択範囲を以下のテキストで置換する。
     ```markdown
     > [!Danger] 
     > Contents
     ```

### 2.2 引用一括適用ショートカット
- **ショートカット**:
  - Macの場合: `Cmd + .`
  - Windows/Linuxの場合: `Ctrl + .`
- **挙動**:
  - エディタがアクティブかつフォーカスされている状態で実行可能。
  - 選択範囲が存在する場合：
    - 選択範囲を改行で分割し、各行の先頭に `> ` を付加する。
    - 行頭にある `-` や `- [ ]` などのリストマーカーは**削除せず維持**し、その左側に `> ` を挿入する。
      - 変換例：
        ```markdown
        - item 1
        - [ ] todo 1
        ```
        ↓
        ```markdown
        > - item 1
        > - [ ] todo 1
        ```
  - 選択範囲が存在しない場合：
    - 現在のカーソル行の先頭に `> ` を追加する。
  - 適用後、編集内容をエディタに反映し、選択状態またはカーソル位置を適切に維持する。

## 3. 技術的要件
- **実装場所**: `00_templates/RegisterCustomCommands.md`
- **キーイベント捕捉**:
  - グローバルな `keydown` リスナー（`window._customQuoteShortcutListener`）を登録し、`e.ctrlKey && e.key === "."` を検知する。
  - エディタがアクティブでない場合や、インプットエリア（検索ボックス、モーダル、CAD Viewer の注記の入力欄等）にフォーカスがある場合は処理をバイパスする。
- **エディタ操作**:
  - Obsidianの `Editor` API を用いて `getSelection()` でテキストを取得し、行ごとに処理した後に `replaceSelection()` で書き換える。

## 4. テスト・検証計画
- 変換ロジックをテストするためのテストスクリプト `scratch/test_quote.js` を作成し、リストマーカーや複数行が正しく処理されるか検証する。
