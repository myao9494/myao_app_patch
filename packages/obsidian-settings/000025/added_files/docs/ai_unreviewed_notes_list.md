<!--
仕様:
1. 03_Dataview/AI未レビューのノート一覧.md の仕様（対象の判定、表示項目、操作）を説明する。
-->

# AI 未レビューのノート一覧

AI が作った・編集したノートのうち、人がまだ確認していないものを `03_Dataview/AI未レビューのノート一覧.md`（DataviewJS）で一覧にする。

## 前提となるプロパティ

| プロパティ | 意味 |
|---|---|
| `ai_generated` | AI が作ったノート（値は作ったツール名。例: `opencode`） |
| `ai_edited` | AI が編集した日時 |
| `ai_reviewed` | 人がレビューしたらチェック（`true`）を入れる |

## 対象の判定

- `ai_generated` / `ai_edited` / `ai_reviewed` のいずれかをプロパティに持つ Markdown（`*.excalidraw.md` を含む）だけが候補。AI に関係ないノートは出ない。
- 候補のうち、`ai_reviewed` が `true`（真偽値、または文字列 `"true"`）**でないもの**を未レビューとして出す。`ai_reviewed: false`、空、`ai_reviewed` が無い（`ai_generated` / `ai_edited` だけがある）ものが該当する。
- `03_Dataview/` 配下は対象外。プロパティは `app.metadataCache` のフロントマターから読む。

## 表示と操作

- 列: ファイル名、フォルダ、`ai_generated`、`ai_edited`、作成日時、更新日時。更新日時の新しい順。
- 上部の検索ボックスでノート名を絞り込める。件数（絞り込み後 / 全体）を表の上に出す。
- ファイル名のクリックで開く。Ctrl/Cmd+クリックは新しいタブ。
- レビューを終えたらノートの `ai_reviewed` にチェックを入れる。一覧を開き直す（再描画する）と消える。

## 動作確認

Obsidian で `03_Dataview/AI未レビューのノート一覧.md` を開き、`ai_reviewed: false` のノート（例: `01_data/2026/11/07/マネゲの要点まとめ.md`）が出ること、`ai_reviewed` を `true` にすると再描画後に消えることを確認する。
