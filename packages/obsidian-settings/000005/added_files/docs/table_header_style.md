<!--
 * テーブルヘッダーの強調およびインデント表のサイズ最適化スタイル仕様書
-->
# テーブルヘッダー（項目行）の強調およびインデント表の最適化仕様書

Markdown内でテーブルを表示した際、およびライブプレビューモードにおいて、一番上の項目行（ヘッダー行）を中央揃えにして背景色や文字色を変更し、項目であることを際立たせるスタイル、ならびに箇条書き配下にインデントされた表（Nested Markdown Renderer プラグイン連携）の幅・罫線長さを自然に最適化するスタイルの仕様について記載します。

## 適用CSSスニペット
[table-header-style.css](file:///Users/mine/000_work/obsidian-dagnetz/.obsidian/snippets/table-header-style.css)

## スタイルの詳細

### 1. テーブルヘッダーおよび枠線スタイル

| 項目 | 適用されるスタイル・プロパティ | 説明 |
| :--- | :--- | :--- |
| **テキスト配置** | `text-align: center !important` | テーブルの `th` 要素内のテキストを強制的に中央揃えにします。 |
| **背景色** | `background-color: var(--background-secondary-alt) !important` | Obsidianの現在のテーマにおけるセカンダリ背景色を適用し、他のセルと区別します。 |
| **文字色** | `color: var(--text-accent) !important` | テーマのアクセントカラーを適用し、項目であることを強調します。 |
| **フォント太さ** | `font-weight: bold !important` | 太字で強調します。 |
| **下部境界線** | `border-bottom: 2px solid var(--background-modifier-border) !important` | ヘッダー行とデータ行の境界を明確にするためのボーダーを設定します。 |
| **全体枠線・グリッド** | `border: 1px solid var(--background-modifier-border) !important` | テーブル外枠および全セルの境界に統一されたグリッド線を表示します。 |

### 2. リスト配下インデント表の幅・罫線長さの最適化

`Nested Markdown Renderer` プラグインで描画されるインデント表は、デフォルトで `min-width: 100%` が指定されているため、文字数が少なくても画面幅いっぱいまで引き伸ばされてしまいます。本スニペットでこれを上書きし、通常の表と同様にコンテンツ幅に合わせたコンパクトな罫線長さに統一します。

| セレクタ | プロパティ | 目的・効果 |
| :--- | :--- | :--- |
| `.nmr-table-widget` | `width: auto !important; max-width: 100% !important; display: inline-block !important;` | ウィジェット全体の横幅100%強制を解除し、内容にフィットさせます。 |
| `.nmr-table-widget > table` | `width: auto !important; min-width: unset !important;` | テーブル自体の最小幅100%を解除し、セルの内容量に応じた自然な罫線長さに整えます。 |

## リスト配下インデント表の編集手順（推奨ワークフロー）

リスト配下にインデントされた表は、Obsidian本体のコア仕様により右側の「＋」列追加ボタンなどのGUIエディタが非表示となります。以下の手順でスムーズにGUI編集を行えます：

1. **インデント解除**: 表全体を選択し、`Shift + Tab` を押下。
   - インデントが外れ、即座にObsidian公式のGUIテーブルエディタが起動（右側に列追加ボタン「＋」、行追加ボタン、直接セル編集が表示）。
2. **GUI編集**: 必要な列や行をGUIで自由に追加・編集。
3. **再インデント**: 編集完了後、表全体を選択して `Tab` を押下。
   - リスト配下にインデントされた綺麗な表に戻ります。

