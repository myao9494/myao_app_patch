# OpenCode ペイン（Claudian 風チャット）仕様書

ランチャー右上の OpenCode ペインを、Obsidian の [Claudian](https://github.com/YishenTu/claudian) プラグインのサイドバーチャットと同じような使い勝手にする。
対象は macOS（Cocoa）版と Windows（WPF）版の両方。処理の流れは [`opencode_chat_pane_flow.excalidraw.md`](opencode_chat_pane_flow.excalidraw.md) を参照。

## Claudian から取り入れたもの

| Claudian | ランチャー |
|---|---|
| 自分の指示と応答を吹き出しで並べる | 自分の指示は右寄せの青い吹き出し。応答は 1 往復の最初に「opencode」の見出しを付け、本文は簡易 Markdown で描く |
| 思考ブロック（「Thinking…」→「Thought for Ns」、終わると折りたたむ） | 「思考（1.2秒）」の折りたたみ。既定で閉じる |
| ツール呼び出しのカード（状態・名前・要約、開くと入力と出力） | 「✓ bash  npm test」（⏳ 実行中 / ✓ 完了 / ✗ 失敗）の折りたたみ。開くと入力（JSON）と出力 |
| Enter で送信 / Shift+Enter で改行 | 同じ。Ctrl+Enter（macOS は Cmd+Enter）でも送信 |
| ↑ で過去の指示 | 1 行目で ↑ が前の指示、最終行で ↓ が次の指示。最後まで戻ると打ちかけの下書き |
| 実行中は停止ボタン、送った指示は順番待ち | 送信ボタンが「停止」になる。実行中の送信は待ち行列へ入り、終わったら順に送る。停止すると待ち行列も捨てる |
| 新しい会話・会話履歴から再開 | 「新規」と「履歴」。履歴はこの作業フォルダの会話一覧で、選ぶとその会話を読み込んで続ける |
| モデル選択・Plan モード・権限モード | モデル選択、「Plan」（変更せず計画だけ）、「自動承認」（拒否されていない操作を自動で許可） |
| コンテキスト使用量 | 下端に「コンテキスト 10.1k トークン · $0.0300」 |
| 応答のコピー・読み返し中は自動スクロールしない | 応答ごとに「コピー」。下端から 100 より上を読んでいるときは追従しない |

取り入れていないもの: 複数タブ、@ でのファイル参照、インライン編集、差分表示、許可の確認ダイアログ（`opencode run` には対話の許可 UI がないため「自動承認」で代える）。

## スラッシュコマンド（このアプリ独自の定型作業）

定型作業のプロンプトに名前を付けて登録し、指示欄で `/名前` と打って実行する（例: `/pass gmail` でエクセルからパスワードを取得）。
Claudian / Obsidian のスラッシュコマンドと同じ操作で補完できる。流れの図は [`slash_commands_flow.excalidraw.md`](slash_commands_flow.excalidraw.md)。

| 項目 | 仕様 |
|---|---|
| 登録 | OpenCode ペイン見出しの「/ コマンド」（macOS は「コマンド」）で登録画面を開く。コマンド名（先頭の / は不要）・説明（候補に表示）・プロンプトを入れて「保存」。選んで書き換え（名前の変更も可）・「削除」（確認あり）ができる |
| 入力チェック | 名前が空・空白や / を含む・既存と重複（大文字小文字を区別しない）、プロンプトが空はエラーで保存しない |
| 保存先 | バックエンドの `backend/data/launcher_slash_commands.json`（`GET` / `PUT /api/index/settings/launcher-slash-commands`、一覧ごと置き換え）。Windows / macOS のランチャーで共有し、起動時と表示のたびに読み直す |
| 展開 | 送信時、最初の語が `/登録済みの名前` ならプロンプトに置き換えて opencode へ送る。`$ARGUMENTS` は名前の後ろの文字に置き換え、無ければ後ろの文字を空行のあとへ足す。吹き出しと指示の履歴には打った文字（`/pass gmail`）を残す。登録の無い名前や `/usr/bin` のようなパスは展開せずそのまま送る |
| 候補（Windows） | 指示欄の先頭が `/` で、カーソルが最初の語の中にある間、指示欄の上に候補（`/名前  説明`）を出す。前方一致 → 途中一致（それぞれ名前順）。打つたびに絞り込み、先頭を選ぶ |
| キー（Windows） | 候補表示中: `↑` / `↓` で選択（端で回る）、`Tab` / `Enter` で「/名前 」に置き換えて確定（送信しない）、`Esc` で候補だけ閉じる（ランチャーは隠さない。文字が変わるまで開かない）。候補が閉じていても `/` の語の中の `Tab` は、候補 1 つならすぐ補完、複数なら候補を開く。候補が 1 つも無い `Tab` は普段どおりペイン移動。クリックでも確定できる |
| キー（macOS） | `/` の語の中の `Tab` で、候補 1 つならすぐ補完、複数なら macOS 標準の補完一覧（`↑` / `↓` で選択、`Return` で確定、`Esc` で閉じる）。登録画面を開いている間は、フォーカスを失ってもランチャーを隠さない |

## opencode の呼び出し

| 操作 | コマンド（作業フォルダで実行） |
|---|---|
| 指示を送る | `opencode run --format json --thinking [--model M] [--agent plan] [--auto] [--session ID \| --continue] -- 指示` |
| 会話一覧 | `opencode session list --format json -n 20` |
| 過去の会話を読む | `opencode session export ID` |
| モデル一覧 | `opencode models`（アプリ起動中 1 度だけ取る。取れなければ次の表示で取り直す） |

- `--thinking` は常に付ける（思考を表示するため）。`--agent plan` は Plan のときだけ付け、Build は opencode の既定に任せる。
- 1 回目の出力の `sessionID` を覚え、2 回目以降は `--session`。履歴から読み込んだ会話はその ID で続ける。
- 作業フォルダ・実行ファイル・タイムアウトの約束は [`gantt_launcher_ui.md`](gantt_launcher_ui.md) の「OpenCode CLI の実行」のとおり。

## 出力（NDJSON）の表示

`opencode run --format json` は、部品（part）が完成するたびに 1 行のイベントを出す。

| イベント | 表示 |
|---|---|
| `text` | 応答の吹き出し（同じ part ID は同じ吹き出しを更新） |
| `reasoning` | 思考の折りたたみ（`time.start`〜`end` から秒数） |
| `tool_use` / `tool_call` | ツールカード（partID 優先。呼び出し ID は応答ごとに重なるため） |
| `step_finish` | 最後のトークン数（入力＋出力＋思考＋キャッシュ）をコンテキスト使用量、`cost` は合計 |
| `error` | 赤の「⚠ 理由」 |
| その他（`step_start` など） | 表示しない |
| JSON でない行 | ANSI を除いて本文として残す |

結果のお知らせ: 中断「— 中断しました —」、タイムアウト「⚠ タイムアウトしたため停止しました」、失敗「⚠ opencode 実行失敗（exit n）: 標準エラー」、応答が空「— （応答なし） —」。
作業状況は「作業中… 12秒 · 待機 1件」、終わると「完了（2.0秒）」。

## 実装の置き場所

| 内容 | Python（macOS） | Windows WPF |
|---|---|---|
| 表示モデル・書式・一覧の解析・指示の履歴 | `launcher_app/opencode_chat.py` | `OpenCodeChat.cs` |
| 簡易 Markdown | `launcher_app/markdown_lite.py` | `MarkdownLite.cs` |
| 会話の実行・待ち行列・停止・履歴の読み込み | `OpenCodeSession`（`opencode_runner.py`） | `OpenCodeConversation.cs` |
| 描画 | `ui/opencode_view.py`（文字列＋書式＋リンクの並び）→ `native_mac.py` が NSTextView へ | `OpenCodeChatView.cs`（StackPanel・Expander・FlowDocument） |
| 指示欄のキー | `ui/four_pane.py` の `enter_action(..., shift=)` と `native_mac.py` の ↑↓・Tab 補完 | `OpenCodeInputKeys`（`OpenCodeChat.cs`） |
| スラッシュコマンドの展開・入力チェック・補完 | `launcher_app/slash_commands.py` | `SlashCommands.cs`（`SlashSuggestions` を含む） |
| スラッシュコマンドの登録画面 | `ui/mac_slash_editor.py` | `SlashCommandsWindow.xaml(.cs)` |
| スラッシュコマンドの保存 | `AppSettingsStore.read/write_launcher_slash_commands`（バックエンド） | 同左 |

macOS の思考・ツールの開閉とコピーは、NSTextView のリンク（`toggle:ID` / `copy:ID`）のクリックで行う。
