# ランチャー 1ページ4ペイン統合 UI（検索 / OpenCode CLI / 常時保持メモ / ganttメモ）仕様書

本ドキュメントは、ローカル全文検索アプリケーションのデスクトップランチャーにおける、**1ページ4ペイン統合UI（左上: 検索、右上: OpenCode CLI、左下: 常時保持メモ、右下: ganttメモ）**およびキーボード操作仕様を定義します。

## 改善の目的
1. **1画面4ペイン統合 & 縦置きモニター対応サイズ**:
   - 従来の画面切り替えを廃止し、1ページ（2×2グリッド）にすべての主要機能を集約します。
   - 縦画面モニターでもはみ出さないよう、横幅を最適化しています（Windows WPF: `1040×940`、macOS Cocoa: `1170×780`。macOS は従来の `780×780` から横幅だけ1.5倍にした）。
2. **OpenCode ペインは Obsidian Claudian 風のチャット**（詳細は [`opencode_chat_pane_spec.md`](opencode_chat_pane_spec.md)）:
   - ランチャー起動時に `opencode service start` を裏で 1 度だけ起動し、常駐サービスを温めておきます。
   - 自分の指示と応答を吹き出しで並べ、思考とツール実行は折りたたみカードで表示します。履歴からの再開・モデル・Plan・自動承認・使用量表示を持ちます。
   - 実行は UI スレッドの外で行い、応答待ちの間も Escape・Tab・他ペインの入力が止まりません。
3. **送信キー**:
   - OpenCode の指示欄は Claudian と同じく **`Enter` で送信、`Shift + Enter` で改行**、`↑` / `↓` で過去の指示を呼び出します（`Ctrl + Enter` / `Cmd + Enter` でも送信）。
   - gantt メモ（タスク名・メモ本文）入力欄では、通常の `Enter`（および `Shift + Enter`）は改行・入力継続とし、**`Ctrl + Enter`**（macOS では `Cmd + Enter` も可）または「送信」ボタンで即座に送信します。
4. **常時保持メモ（Scratchpad）**:
   - 左下ペインの自由記述メモは、入力が止まってから 0.6 秒後と、ランチャーを隠す前にメモ専用 API（`PUT /api/index/settings/launcher-memo`、`backend/data/launcher_memo.txt`）へ保存され、ランチャーやPCを再起動しても人間が消すまで保持されます。

## OpenCode CLI の実行

| 項目 | 仕様 |
|---|---|
| コマンド | `opencode run --format json --thinking [--model M] [--agent plan] [--auto] [--session <ID> \| --continue] -- <指示>`。指示は `--` の後ろに置き、`-` で始まる指示もオプションとして解釈させない |
| 会話の続き | 1 回目の出力（NDJSON）の `sessionID` を覚え、2 回目以降は `--session <ID>`。ID が取れなかった成功時だけ `--continue` |
| 作業フォルダ | Web 設定ドロワーの「opencode 実行フォルダ」（`opencode_working_dir`）、またはランチャーの OpenCode ペイン左上の ☰ メニュー（フォルダ選択ダイアログで選ぶ／既定に戻す。`PUT /api/index/settings` へ `opencode_working_dir` だけを送る。実行中は変更不可）。空欄で保存するとバックエンドの既定値（環境変数 `SEARCH_APP_OPENCODE_DEFAULT_WORKING_DIR`、未指定ならホームフォルダの `000_work/AI_work`）に戻る |
| 実行時の `PWD` | macOS ランチャー（Python）は子プロセスの `cwd` に加えて環境変数 `PWD` も作業フォルダへ合わせる。起動元（バックエンドの `backend/` など）の `PWD` が残ると、opencode が設定と別のフォルダでコマンドを実行する |
| フォルダが無いとき | opencode を起動せず「opencode 実行フォルダが見つかりません: …」を表示する。ランチャー自身のフォルダなど別の場所では実行しない |
| 実行ファイル | Windows は npm 配下または PATH 上の `opencode.exe` だけを使い、`opencode.cmd` は使わない（cmd.exe が `&` や `\|` を含む指示を別コマンドとして解釈するため）。macOS は PATH 上の `opencode` |
| 同時実行 | 1 つまで。実行中の送信は待ち行列へ入れ、今の実行が終わったら順に送る |
| 中断・タイムアウト | 実行中は送信ボタンが「停止」になり、押すと実行中の opencode を止めて待ち行列も捨てる。「新規」はさらに表示と会話 ID を消す。15 分応答がなければ止めて「タイムアウトしたため停止しました」を出す |
| 出力の読み取り | 標準出力と標準エラーを並行して読む（パイプが詰まって止まらない）。失敗時は「opencode 実行失敗（exit N）: 標準エラー」をお知らせする |
| Windows の再表示 | WPF はウィンドウを閉じるたびに作り直すため、会話（`OpenCodeConversation`）はアプリ側が持つ。閉じても実行は続き、再表示すると途中経過から表示する |

## 常時保持メモの保存

- 保存はメモ専用 API だけで行い、共有設定の一括保存（`PUT /api/index/settings`）はメモを書き戻さない。Web 画面の設定保存が、ランチャーが保存した直後のメモを古い値で上書きしないため。
- 保存の通信中に入力された内容は「未保存」のまま残し、次の保存で必ず送る（版番号で判定）。保存に失敗したら「保存失敗: 理由」を表示して未保存のまま残す。
- サーバーのメモを読み込むのは、手元で一度も編集していないときだけ（ランチャー自身の編集を正とする）。
- Windows はメモの保存をアプリ側の部品（`LauncherMemoStore`）が持つため、ウィンドウを閉じても保存は中断されない。終了時は最大 3 秒保存を待つ。

## 実装の置き場所

| 内容 | Python（macOS） | Windows WPF |
|---|---|---|
| Tab の巡回順・Enter の動作 | `launcher/src/launcher_app/ui/four_pane.py` | `LauncherTabNavigation`（`SearchModels.cs`） |
| opencode の引数・実行・待ち行列 | `launcher/src/launcher_app/opencode_runner.py` | `OpenCodeCommandBuilder`（`SearchModels.cs`）、`OpenCodeConversation.cs` |
| OpenCode のチャット表示 | `opencode_chat.py`・`markdown_lite.py`・`ui/opencode_view.py` | `OpenCodeChat.cs`・`MarkdownLite.cs`・`OpenCodeChatView.cs` |
| 常時保持メモの自動保存 | `launcher/src/launcher_app/scratchpad.py` | `LauncherMemoStore.cs` |
| macOS の 2×2 配置計算 | `launcher/src/launcher_app/ui/mac_layout.py`（AppKit 非依存。配置が重ならないことをテストで確かめる） | — |
| Shift 2 回押しの判定（macOS） | `DoubleShiftDetector`（`services/hotkeys.py`） | `DoubleShiftHook.cs` |

---

## 1. 4ペインのレイアウト構成

```
+---------------------------------------+---------------------------------------+
| 【左上】検索ペイン                    | 【右上】OpenCode ペイン（チャット）   |
|  [ 検索語... ] [ 拡張子 ] [ 方式 ]    |  OpenCode            [履歴 ▾] [新規]  |
|  [x] gantt  [ ] 更新  [x] フォルダ名  |  [モデル ▾]       [ ] Plan [ ]自動承認|
|  - 検索結果カード一覧                 |  cwd: ...\AI_work                     |
|                                       |        ( 自分の指示の吹き出し )       |
|                                       |  opencode  ▸ 思考 / ▸ ✓ bash ... / 本文|
|                                       |  作業中… 12秒 · 待機 1件              |
|                                       |  [ 指示（Enter送信 / Shift+Enter改行）]|
|                                       |  コンテキスト 10.1k トークン [送信/停止]|
+---------------------------------------+---------------------------------------+
| 【左下】メモ（常時保持）ペイン        | 【右下】gantt メモペイン              |
|  自動保存（人間が消すまで保持）       |  gantt メモ                 parent: 0 |
|  [ 自由記述メモ (Scratchpad)       ]  |  [ タスク名を入力 (Ctrl+Enterで送信)] |
|  [                                 ]  |  [ メモ本文を入力 (Ctrl+Enterで送信)] |
|                                       |                    [ クリア ] [ 送信 ]|
+---------------------------------------+---------------------------------------+
```

---

## 2. キーボード操作（フォーカス巡回・送信）仕様

### Tab / Shift + Tab フォーカス巡回順序

`Tab` および `Shift + Tab` によって、4ペインを以下の順序で循環移動します：

1. **検索欄** (`Query` / `query` / `search_field`) — 左上ペイン
2. **拡張子フィルタ欄** (`Extension` / `extension` / `extension_filter`) — 左上ペイン
3. **OpenCode 指示入力欄** (`OpenCodeInput` / `opencode_prompt` / `opencode_prompt_view`) — 右上ペイン
4. **OpenCode 送信ボタン** (`OpenCodeSubmit` / `opencode_submit` / `opencode_submit_button`) — 右上ペイン
5. **常時保持メモ欄** (`Scratchpad` / `scratchpad` / `scratchpad_view`) — 左下ペイン
6. **gantt タスク名欄** (`MemoTitle` / `memo_title` / `memo_title_field`) — 右下ペイン
7. **gantt メモ本文欄** (`MemoBody` / `memo_body` / `memo_body_view`) — 右下ペイン
8. **gantt 送信ボタン** (`MemoSubmit` / `memo_submit` / `memo_submit_button`) — 右下ペイン
9. **検索欄** へ戻る

### 特殊キー挙動

- **OpenCode 指示欄**（Claudian と同じ）:
  - `Enter` で送信（実行中なら待ち行列へ）、`Shift + Enter` で改行。`Ctrl + Enter`（macOS は `Cmd + Enter`）でも送信します。
  - 1 行目で `↑` は前の指示、最終行で `↓` は次の指示を呼び出します。
  - `/` で登録したスラッシュコマンドの候補を出し、`↑` / `↓` で選び `Tab` / `Enter` で確定、`Esc` で候補を閉じます（Obsidian と同じ。詳細は [`opencode_chat_pane_spec.md`](opencode_chat_pane_spec.md)）。
- **`Ctrl + Enter`（macOS では `Cmd + Enter` も可）**:
  - **gantt タスク名欄 / メモ本文欄**: タスクを即座に gantt API へ送信します。
- **`Enter` / `Return`（および `Shift + Enter`）**:
  - **常時保持メモ・gantt の入力欄**: 誤送信防止のため送信は行わず、改行（または通常の入力継続）となります。
  - **各ボタン**: フォーカスがある状態で `Enter` を押すと、そのボタンの操作（送信 / 停止・クリア・新規）を実行します。
  - **検索欄・拡張子欄**: 選択中の検索結果を開きます（`Ctrl` / `Cmd` 付きは保存場所を開く）。
- **巡回順にない部品**（gantt の「クリア」、OpenCode の「履歴」「新規」・モデル・Plan・自動承認・会話欄）からの `Tab` は、属するペインの次の入力へ進みます。
- **`Escape` キー**:
  - どのペインにフォーカスがあっても、未保存の常時保持メモを保存した上でランチャーを非表示にします。
- **再表示**: どのペインで隠しても、再表示時は検索欄へフォーカスします。共有設定（gantt parent・opencode 実行フォルダ・常時保持メモ）は表示を待たせずに裏で取り直します。
