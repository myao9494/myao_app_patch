/**
 * Windows WPFランチャー共有ロジック・モデル仕様テスト
 * 外部テストパッケージ（xUnit等）に依存せず、.NET 8標準機能でWPFランチャーの契約・振る舞いを検証する。
 **/
using LocalSearchLauncher;
using System.Net.Http;
using System.Windows.Input;

/// <summary>外部テストパッケージなしでWPF共有ロジックの契約を検証する。</summary>
static void Assert(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

var task = GanttTaskBuilder.Build(" 仕様確認 ", " メモ ", 12, new DateOnly(2026, 7, 11));
Assert(task.Text == "仕様確認", "タスク名をtrimする");
Assert(task.Memo == "メモ", "メモをtrimする");
Assert(task.StartDate == "2026-07-11 00:00:00", "開始日は当日0時");
Assert(task.EndDate == "2026-07-12 00:00:00", "終了日は翌日0時");
Assert(task.Progress == 0.1 && task.Parent == 12 && task.KindTask == 1, "macOS版と同じ既定値");

var gantt = new SearchItem(-9, "file", "gantt", "", "task", "gantt://tasks/9", "", "&lt;b&gt;memo&lt;/b&gt;", "https://example.test");
Assert(gantt.IsGantt && !gantt.IsLocal && gantt.HasGanttLink, "gantt結果を判定する");
Assert(gantt.PlainSnippet == "<b>memo</b>", "HTMLエンティティを復元する");

var web = new SearchItem(10, "file", "web", "", "Web page", "https://example.test/page", ".html", "snippet", null);
Assert(web.IsWeb && !web.IsLocal && !web.IsGantt, "web結果をローカルファイルと区別する");

var msg = new SearchItem(11, "file", "local", "C:\\mail.msg", "mail.msg", "C:\\mail.msg", ".msg", "snippet", null);
Assert(msg.IconPath == "Assets/catppuccin/email.png", "msgファイルはemailアイコンを指す");
var eml = new SearchItem(12, "file", "local", "C:\\mail.eml", "mail.eml", "C:\\mail.eml", ".eml", "snippet", null);
Assert(eml.IconPath == "Assets/catppuccin/email.png", "emlファイルはemailアイコンを指す");

var hybridItem = new SearchItem(13, "file", "local", "C:\\test.md", "test.md", "C:\\test.md", ".md", "snippet", null, MatchSource: "both", SalientSentence: "核心文テスト");
Assert(hybridItem.DisplayTitle == "test.md  🌟両方一致", "両方一致バッジを表示する");
Assert(hybridItem.DisplaySnippet == "💡 核心文テスト", "核心文を表示する");

var (defaultEndpoint, defaultPayload) = LauncherSearchRequestBuilder.Build("alpha", 8, false, ".md");
Assert(defaultEndpoint == "api/search/indexed", "既定のハイブリッド検索（更新OFF）は既存DB専用APIを使う");
Assert(defaultPayload is IndexedLauncherSearchRequest { SourceType: "local_web", SearchType: "hybrid", Types: ".md" }, "ハイブリッド検索はSearchTypeにhybridを指定して既存DBから検索する");

// 既存DB専用API（IndexedSearchRequest）は folder_path が必須。空文字で DB 全体を対象にする
var indexedJson = System.Text.Json.JsonSerializer.Serialize(defaultPayload, defaultPayload.GetType(), LauncherApiClient.JsonOptions);
Assert(indexedJson.Contains("\"folder_path\":\"\""), $"既存DB検索は folder_path を空文字で送る: {indexedJson}");
Assert(indexedJson.Contains("\"q\":\"alpha\"") && indexedJson.Contains("\"search_type\":\"hybrid\"") && indexedJson.Contains("\"include_path_in_filename\":true"), $"既存DB検索の項目名はスネークケース: {indexedJson}");

var (excludeQueryEndpoint, excludeQueryPayload) =LauncherSearchRequestBuilder.Build("-.png", 8, false, "-png");
Assert(excludeQueryEndpoint == "api/search/indexed", "除外語検索も更新OFFなら既存DB専用APIを使う");
Assert(excludeQueryPayload is IndexedLauncherSearchRequest { Q: "-.png", Types: "-png", SearchType: "hybrid" }, "除外語および除外拡張子フィルタをリクエストへ反映する");

var (indexedEndpoint, indexedPayload) = LauncherSearchRequestBuilder.Build("alpha", 8, false, ".md", searchType: "keyword");
Assert(indexedEndpoint == "api/search/indexed", "通常キーワード検索は既存DB専用APIを使う");
Assert(indexedPayload is IndexedLauncherSearchRequest { SourceType: "local_web", SearchType: "keyword" }, "通常検索はlocalとwebを横断する");

var (pathOffEndpoint, pathOffPayload) = LauncherSearchRequestBuilder.Build("alpha", 8, false, "", includePathInFilename: false);
Assert(defaultPayload is IndexedLauncherSearchRequest { IncludePathInFilename: true }, "フォルダ名も対象にする設定は既定でオンにする");
Assert(pathOffPayload is IndexedLauncherSearchRequest { IncludePathInFilename: false }, "フォルダ名を対象にする設定をオフにして送れる");

var (ganttEndpoint, ganttPayload) = LauncherSearchRequestBuilder.Build("alpha", 8, true, "");
Assert(ganttEndpoint == "api/search", "gantt追加検索は統合APIを使う");
Assert(ganttPayload is LauncherSearchRequest { SourceType: "local_web", SkipRefresh: true, SearchAllEnabled: true }, "gantt追加時もlocal/web横断かつDB更新なしにする");

var (updateEndpoint, updatePayload) = LauncherSearchRequestBuilder.Build("alpha", 8, false, ".md", updateIndexOnSearch: true);
Assert(updateEndpoint == "api/search", "更新ONは統合APIを使う");
Assert(updatePayload is LauncherSearchRequest { SourceType: "local_web", SkipRefresh: false, SearchAllEnabled: false, IncludeGanttTasks: false }, "更新ONは登録済みフォルダのインデックス作成・更新を許可して検索する");

Assert(LauncherResultSelection.CanOpenWithReturn(hasSelectedResult: true, memoActive: false), "検索画面で先頭結果が選択されていればReturnだけで開く");
Assert(!LauncherResultSelection.CanOpenWithReturn(hasSelectedResult: false, memoActive: false), "検索結果がないときReturnでは開かない");
Assert(!LauncherResultSelection.CanOpenWithReturn(hasSelectedResult: true, memoActive: true), "ganttメモ画面のReturnでは検索結果を開かない");

Assert(WindowDragPolicy.CanStartDrag(MouseButton.Left, MouseButtonState.Pressed), "左ボタン押下時はウィンドウ移動を開始できる");
Assert(!WindowDragPolicy.CanStartDrag(MouseButton.Right, MouseButtonState.Pressed), "右クリックではウィンドウ移動を開始しない");
Assert(!WindowDragPolicy.CanStartDrag(MouseButton.Left, MouseButtonState.Released), "ボタン未押下ではウィンドウ移動を開始しない");

var state = new LauncherWindowState("query", ".md .py", "title", "body", true, true, true, "vector");
Assert(
    state.MemoActive && state.IncludeGantt && state.UpdateIndexOnSearch && state.MemoTitle == "title" && state.ExtensionFilter == ".md .py" && state.SearchType == "vector",
    "ウィンドウ再生成用に検索方式や拡張子フィルタを含む入力状態を保持する"
);

Environment.SetEnvironmentVariable("LAUNCHER_WEB_BASE_URL", "http://127.0.0.1:8123/");
Assert(LauncherUrls.OpenHubBase() == "http://127.0.0.1:8123", "結果openは設定済みの外部Openハブを使う");
Environment.SetEnvironmentVariable("LAUNCHER_WEB_BASE_URL", null);

Assert(LauncherApiClient.ResolveRequestTimeout(null) == TimeSpan.FromSeconds(15), "API タイムアウトの既定値はPython版と同じ15秒");
Assert(LauncherApiClient.ResolveRequestTimeout("30") == TimeSpan.FromSeconds(30), "LAUNCHER_REQUEST_TIMEOUTの秒数を使う");
Assert(LauncherApiClient.ResolveRequestTimeout("not_a_number") == TimeSpan.FromSeconds(15), "数値でなければ既定値を使う");
Assert(LauncherApiClient.ResolveRequestTimeout("-1.5") == TimeSpan.FromSeconds(15), "負の値は既定値を使う");
Assert(LauncherApiClient.ResolveRequestTimeout("0") == TimeSpan.FromSeconds(15), "0は既定値を使う");

var requestTimeout = TimeSpan.FromSeconds(15);
using var cancelledSearch = new CancellationTokenSource();
cancelledSearch.Cancel();
// HttpClient.Timeout の超過は、利用者の取り消しと同じ TaskCanceledException で通知される
var timeoutError = new TaskCanceledException("timeout", new TimeoutException());
Assert(
    LauncherSearchFailure.StatusText(timeoutError, CancellationToken.None, requestTimeout) == "検索がタイムアウトしました（15秒）",
    "タイムアウトは検索中のまま残さず失敗として表示する"
);
Assert(
    LauncherSearchFailure.StatusText(timeoutError, cancelledSearch.Token, requestTimeout) is null,
    "新しい検索に置き換えられた検索は何も表示しない"
);
Assert(
    LauncherSearchFailure.StatusText(new HttpRequestException("接続できません"), CancellationToken.None, requestTimeout) == "検索に失敗しました: 接続できません",
    "接続エラーは失敗の理由を表示する"
);
Assert(
    LauncherSearchFailure.StatusText(new HttpRequestException("接続できません"), cancelledSearch.Token, requestTimeout) is null,
    "取り消した検索の失敗で新しい検索の表示を上書きしない"
);


// 4ペイン（左上:検索 → 右上:opencode CLI → 左下:永続メモ → 右下:gantt）のTab/Shift+Tabフォーカス巡回契約
Assert(LauncherTabNavigation.Next("Query", backwards: false) == "Extension", "Queryの次はExtension");
Assert(LauncherTabNavigation.Next("Extension", backwards: false) == "OpenCodeInput", "Extensionの次はOpenCodeInput（右上ペイン）");
Assert(LauncherTabNavigation.Next("OpenCodeInput", backwards: false) == "OpenCodeSubmit", "OpenCodeInputの次はOpenCodeSubmit");
Assert(LauncherTabNavigation.Next("OpenCodeSubmit", backwards: false) == "Scratchpad", "OpenCodeSubmitの次はScratchpad（左下ペイン）");
Assert(LauncherTabNavigation.Next("Scratchpad", backwards: false) == "MemoTitle", "Scratchpadの次はMemoTitle（右下ペイン）");
Assert(LauncherTabNavigation.Next("MemoTitle", backwards: false) == "MemoBody", "MemoTitleの次はMemoBody");
Assert(LauncherTabNavigation.Next("MemoBody", backwards: false) == "MemoSubmit", "MemoBodyの次はMemoSubmit");
Assert(LauncherTabNavigation.Next("MemoSubmit", backwards: false) == "Query", "MemoSubmitの次はQueryへ循環する");
Assert(LauncherTabNavigation.Next("Query", backwards: true) == "MemoSubmit", "QueryからShift+TabでMemoSubmitへ戻る");
Assert(LauncherTabNavigation.Next("Scratchpad", backwards: true) == "OpenCodeSubmit", "ScratchpadからShift+TabでOpenCodeSubmitへ戻る");

// OpenCode CLI コマンド引数組み立て（思考表示・モデル・Plan・自動承認・会話の継続）
var firstArgs = OpenCodeCommandBuilder.BuildArguments("テストを実行して");
Assert(firstArgs.SequenceEqual(["run", "--format", "json", "--thinking", "--", "テストを実行して"]), "初回は--format json --thinking付きでrunを実行し、指示は--の後ろへ置く");
var dashArgs = OpenCodeCommandBuilder.BuildArguments("-h の意味");
Assert(dashArgs.SequenceEqual(["run", "--format", "json", "--thinking", "--", "-h の意味"]), "-で始まる指示もオプションとして解釈させない");
var sessionArgs = OpenCodeCommandBuilder.BuildArguments("続きをお願い", sessionId: "ses_1");
Assert(sessionArgs.SequenceEqual(["run", "--format", "json", "--thinking", "--session", "ses_1", "--", "続きをお願い"]), "会話IDが分かれば--sessionで同じ会話を続ける");
var continuedArgs = OpenCodeCommandBuilder.BuildArguments("続きをお願い", continueSession: true);
Assert(continuedArgs.SequenceEqual(["run", "--format", "json", "--thinking", "--continue", "--", "続きをお願い"]), "会話IDが分からなければ--continueで続ける");
var optionArgs = OpenCodeCommandBuilder.BuildArguments("直して", sessionId: "ses_1", model: "anthropic/claude-opus-5-5", planMode: true, autoApprove: true);
Assert(optionArgs.SequenceEqual(["run", "--format", "json", "--thinking", "--model", "anthropic/claude-opus-5-5", "--agent", "plan", "--auto", "--session", "ses_1", "--", "直して"]), "モデル・Plan・自動承認を渡す");
Assert(OpenCodeCommandBuilder.BuildArguments("直して", model: "  ").SequenceEqual(["run", "--format", "json", "--thinking", "--", "直して"]), "空のモデル指定とBuild（既定）は付けない");
Assert(OpenCodeCommandBuilder.StripAnsi("\u001b[32mOK\u001b[0m\r\nDone") == "OK\nDone", "ANSIエスケープシーケンスを除去する");
Assert(OpenCodeCommandBuilder.ExtractSessionId("{\"type\":\"error\",\"sessionID\":\"ses_e42\"}") == "ses_e42", "NDJSONイベントから会話IDを取り出す");
Assert(OpenCodeCommandBuilder.ExtractSessionId("plain") is null, "JSONでない行から会話IDは取り出さない");

// opencode 実行ファイルは cmd.exe を経由する opencode.cmd を使わない
var fakeAppData = @"C:\fake\AppData";
string NpmExe() => Path.Combine(fakeAppData, "npm", "node_modules", "@opencode", "cli", "bin", "opencode.exe");
Assert(
    OpenCodeCommandBuilder.ResolveExecutable(fakeAppData, path => path.EndsWith("opencode.cmd", StringComparison.OrdinalIgnoreCase), "") is null,
    "opencode.cmd しかない場合は使わずに見つからない扱いにする"
);
Assert(OpenCodeCommandBuilder.ResolveExecutable(fakeAppData, path => path == NpmExe(), "") == NpmExe(), "npm 配下の opencode.exe を使う");
Assert(
    OpenCodeCommandBuilder.ResolveExecutable("", path => path == @"D:\tools\opencode.exe", @"C:\none;D:\tools") == @"D:\tools\opencode.exe",
    "PATH 上の opencode.exe を使う"
);

// チャット表示モデル（Claudian 風: 吹き出し・思考/ツールの折りたたみ・使用量）
string Ev(string type, string part) => $"{{\"type\":\"{type}\",\"sessionID\":\"ses_A\",\"part\":{part}}}";
var chat = new ChatTranscript();
chat.AddUser("ファイル一覧を教えて");
Assert(chat.ApplyLine(Ev("text", "{\"id\":\"p1\",\"type\":\"text\",\"text\":\"a.txt です\"}")), "text イベントを表示する");
var chatEntries = chat.Snapshot();
Assert(chatEntries.Count == 2 && chatEntries[0].Kind == ChatEntryKind.User && chatEntries[1].Kind == ChatEntryKind.Text && chatEntries[1].Text == "a.txt です", "指示と応答を別の吹き出しとして順に並べる");
chat.ApplyLine(Ev("tool_use", "{\"id\":\"t1\",\"type\":\"tool\",\"tool\":\"bash\",\"state\":{\"status\":\"running\",\"input\":{\"command\":\"npm test\"}}}"));
int toolRevision = chat.Snapshot()[2].Revision;
chat.ApplyLine(Ev("tool_use", "{\"id\":\"t1\",\"type\":\"tool\",\"tool\":\"bash\",\"state\":{\"status\":\"completed\",\"input\":{\"command\":\"npm test\"},\"output\":\"253 passed\"}}"));
var tool = chat.Snapshot()[2];
Assert(chat.Snapshot().Count == 3 && tool.Status == "completed" && tool.Summary == "npm test" && tool.DetailOutput.Contains("253 passed") && tool.DetailInput.Contains("\"command\": \"npm test\""), "同じpart IDのツールは同じカードを更新する");
Assert(tool.Revision > toolRevision, "更新したカードは版番号を上げる（画面は版番号で差分だけ描き直す）");
chat.ApplyLine(Ev("tool_use", "{\"partID\":\"prt_9\",\"id\":\"functions.read:0\",\"type\":\"tool\",\"tool\":\"read\",\"state\":{\"status\":\"completed\",\"input\":{\"path\":\"x.txt\"}}}"));
chat.ApplyLine(Ev("tool_use", "{\"partID\":\"prt_10\",\"id\":\"functions.read:0\",\"type\":\"tool\",\"tool\":\"read\",\"state\":{\"status\":\"completed\",\"input\":{\"path\":\"y.txt\"}}}"));
Assert(chat.Snapshot().Count == 5, "呼び出しIDが重なってもpartIDで別のツールとして扱う");
chat.ApplyLine(Ev("reasoning", "{\"id\":\"r1\",\"type\":\"reasoning\",\"text\":\"考える\",\"time\":{\"start\":1000,\"end\":3500}}"));
var reasoning = chat.Snapshot()[^1];
Assert(reasoning.Kind == ChatEntryKind.Reasoning && !reasoning.Expanded && reasoning.DurationSeconds == 2.5, "思考は既定で折りたたみ、時間を持つ");
Assert(chat.Toggle("r1") && chat.Snapshot()[^1].Expanded && !chat.Toggle("missing"), "思考・ツールを開閉できる");
Assert(!chat.ApplyLine(Ev("reasoning", "{\"id\":\"r2\",\"type\":\"reasoning\",\"text\":\" \"}")) && !chat.ApplyLine(Ev("step_start", "{\"type\":\"step-start\"}")), "空の思考や制御イベントは表示しない");
chat.ApplyLine(Ev("step_finish", "{\"type\":\"step-finish\",\"cost\":0.01,\"tokens\":{\"input\":9976,\"output\":30,\"reasoning\":21,\"cache\":{\"read\":0,\"write\":0}}}"));
chat.ApplyLine(Ev("step_finish", "{\"type\":\"step-finish\",\"cost\":0.02,\"tokens\":{\"input\":191,\"output\":6,\"reasoning\":87,\"cache\":{\"read\":9856,\"write\":0}}}"));
Assert(chat.ContextTokens == 10140 && chat.UsageText() == "コンテキスト 10.1k トークン · $0.0300", "最後のstep_finishをコンテキスト使用量とし、費用は合計する");
chat.ApplyLine("{\"type\":\"error\",\"error\":{\"name\":\"APIError\",\"data\":{\"message\":\"認証が必要です\"}}}");
Assert(chat.Snapshot()[^1] is { Kind: ChatEntryKind.Notice, Status: "error", Text: "認証が必要です" }, "errorイベントはエラーのお知らせにする");
Assert(chat.ApplyLine("\u001b[33m警告\u001b[0m") && chat.Snapshot()[^1] is { Kind: ChatEntryKind.Text, Text: "警告" }, "JSONでない出力は本文として残す");
Assert(chat.CopyText("p1") == "a.txt です" && chat.LastAssistantText() == "警告", "吹き出し単位と最後の応答をコピーできる");
Assert(new ChatTranscript().UsageText() == "", "使用量がなければ空");

var exported = ChatTranscript.FromExport("""
{"info":{"id":"ses_A","title":"hello.txt を読む"},"messages":[
 {"id":"m1","type":"user","text":"hello.txt を読んで"},
 {"id":"m2","type":"assistant","content":[
   {"type":"reasoning","text":"読む","time":{"created":1000,"completed":1500}},
   {"type":"tool","id":"functions.read:0","name":"read","state":{"status":"completed","input":{"path":"hello.txt"},"content":[{"type":"text","text":"1: hello world"}]}}],
  "tokens":{"input":9976,"output":30,"reasoning":21,"cache":{"read":0,"write":0}}},
 {"id":"m3","type":"assistant","content":[{"type":"text","text":"hello world"}],"tokens":{"input":191,"output":6,"reasoning":87,"cache":{"read":9856,"write":0}}},
 {"id":"m4","type":"idle"}]}
""");
var exportedEntries = exported.Snapshot();
Assert(exported.Title == "hello.txt を読む", "会話の題名を復元する");
Assert(exportedEntries.Select(e => e.Kind).SequenceEqual([ChatEntryKind.User, ChatEntryKind.Reasoning, ChatEntryKind.Tool, ChatEntryKind.Text]), "過去の会話を指示・思考・ツール・応答の順に復元する");
Assert(exportedEntries[1].DurationSeconds == 0.5 && exportedEntries[2].Summary == "hello.txt" && exportedEntries[2].DetailOutput.Contains("hello world"), "思考の時間とツールの結果を復元する");
Assert(exported.ContextTokens == 10140 && exportedEntries.Select(e => e.Id).Distinct().Count() == 4, "使用量を復元し、IDは重ならない");

Assert(OpenCodeChatFormat.SummarizeTool("read", "{\"filePath\":\"src/app.py\"}") == "src/app.py", "readはパス");
Assert(OpenCodeChatFormat.SummarizeTool("bash", "{\"command\":\"npm test\\nnpm run build\"}") == "npm test", "bashはコマンドの1行目");
Assert(OpenCodeChatFormat.SummarizeTool("grep", "{\"pattern\":\"TODO\",\"path\":\"src\"}") == "TODO in src", "grepは検索語と場所");
Assert(OpenCodeChatFormat.SummarizeTool("todowrite", "{\"todos\":[{\"status\":\"completed\"},{\"status\":\"pending\"}]}") == "Tasks 1/2", "todowriteは進み具合");
Assert(OpenCodeChatFormat.SummarizeTool("custom", "{}", "独自ツール") == "独自ツール" && OpenCodeChatFormat.SummarizeTool("custom", "{\"x\":1,\"query\":\"検索\"}") == "検索", "その他は題名か最初の文字列");
Assert(OpenCodeChatFormat.SummarizeTool("bash", "{\"command\":\"" + new string('x', 200) + "\"}").Length == 80, "長い要約は80文字で切る");
Assert(OpenCodeChatFormat.ToolHeader("read", "completed", "hello.txt") == "✓ read  hello.txt" && OpenCodeChatFormat.ToolHeader("bash", "running", "npm test") == "⏳ bash  npm test" && OpenCodeChatFormat.ToolHeader("bash", "error", "") == "✗ bash", "ツールの見出しは状態アイコン付き");
Assert(OpenCodeChatFormat.FormatElapsed(0.24) == "0.2秒" && OpenCodeChatFormat.FormatElapsed(12.6) == "13秒" && OpenCodeChatFormat.FormatElapsed(65) == "1分05秒", "経過時間の表示");
Assert(OpenCodeChatFormat.FormatTokens(950) == "950" && OpenCodeChatFormat.FormatTokens(10669) == "10.7k" && OpenCodeChatFormat.FormatTokens(1_260_000) == "1.3M", "トークン数の表示");
long nowMs = 10L * 24 * 3600 * 1000;
Assert(OpenCodeChatFormat.FormatRelativeTime(nowMs - 30_000, nowMs) == "たった今" && OpenCodeChatFormat.FormatRelativeTime(nowMs - 300_000, nowMs) == "5分前" && OpenCodeChatFormat.FormatRelativeTime(nowMs - 3L * 3600_000, nowMs) == "3時間前" && OpenCodeChatFormat.FormatRelativeTime(nowMs - 2L * 24 * 3600_000, nowMs) == "2日前", "相対時刻の表示");
var parsedSessions = OpenCodeChatFormat.ParseSessionList("warn\n[{\"id\":\"ses_1\",\"title\":\"一つ目\",\"updated\":2000},{\"id\":\"ses_2\",\"updated\":1000}]\n");
Assert(parsedSessions.Count == 2 && parsedSessions[0] == new OpenCodeSessionSummary("ses_1", "一つ目", 2000) && parsedSessions[1].Title == "" && OpenCodeChatFormat.ParseSessionList("x").Count == 0, "会話一覧を読む（余計な出力は無視）");
Assert(OpenCodeChatFormat.ParseModelList("opencode/big-pickle\nanthropic/claude-opus-5-5\n\nServiceUnavailableError: x\n    at k (B:/x.js:1:2)\n").SequenceEqual(["opencode/big-pickle", "anthropic/claude-opus-5-5"]), "モデル一覧はプロバイダー/モデルの行だけ");

// 指示の履歴（↑↓）
var promptHistory = new PromptHistory(limit: 3);
foreach (var prompt in new[] { "一つ目", "二つ目", "二つ目", "三つ目", "四つ目" }) promptHistory.Add(prompt);
Assert(promptHistory.Items.SequenceEqual(["二つ目", "三つ目", "四つ目"]), "連続する同じ指示はまとめ、上限を超えたら古いものから捨てる");
Assert(promptHistory.Previous("下書き") == "四つ目" && promptHistory.Previous("四つ目") == "三つ目" && promptHistory.Previous("三つ目") == "二つ目" && promptHistory.Previous("二つ目") == "二つ目", "↑で新しい順に呼び出す");
Assert(promptHistory.Next() == "三つ目" && promptHistory.Next() == "四つ目" && promptHistory.Next() == "下書き" && promptHistory.Next() is null, "↓で戻り、最後は下書きを返す");
Assert(new PromptHistory().Previous("") is null, "履歴が空なら呼び出さない");

// 指示欄のキー操作（Claudian と同じく Enter で送信・Shift+Enter で改行・↑↓で履歴）
Assert(OpenCodeInputKeys.Decide(Key.Enter, ModifierKeys.None, caretOnFirstLine: true, caretOnLastLine: true) == OpenCodeInputAction.Submit, "Enterで送信");
Assert(OpenCodeInputKeys.Decide(Key.Enter, ModifierKeys.Shift, true, true) == OpenCodeInputAction.Newline, "Shift+Enterで改行");
Assert(OpenCodeInputKeys.Decide(Key.Enter, ModifierKeys.Control, true, true) == OpenCodeInputAction.Submit, "Ctrl+Enterでも送信");
Assert(OpenCodeInputKeys.Decide(Key.Up, ModifierKeys.None, caretOnFirstLine: true, caretOnLastLine: false) == OpenCodeInputAction.HistoryPrevious, "1行目で↑は前の指示");
Assert(OpenCodeInputKeys.Decide(Key.Up, ModifierKeys.None, caretOnFirstLine: false, caretOnLastLine: true) == OpenCodeInputAction.None, "2行目以降の↑はカーソル移動");
Assert(OpenCodeInputKeys.Decide(Key.Down, ModifierKeys.None, caretOnFirstLine: false, caretOnLastLine: true) == OpenCodeInputAction.HistoryNext, "最終行で↓は次の指示");
Assert(OpenCodeInputKeys.Decide(Key.A, ModifierKeys.None, true, true) == OpenCodeInputAction.None, "他のキーは通常入力");

// 応答の簡易 Markdown（見出し・箇条書き・番号・引用・コード・行内コード・太字）
var md = MarkdownLite.Parse("## 手順\n- 準備\n  - 下準備\n2. 実行\n> 注意\n\n`npm test` を **必ず**\n```bash\nnpm test # **x**\n```");
Assert(md.Select(b => (b.Kind, b.Level)).SequenceEqual([(MdBlockKind.Heading, 2), (MdBlockKind.Bullet, 0), (MdBlockKind.Bullet, 1), (MdBlockKind.Numbered, 2), (MdBlockKind.Quote, 0), (MdBlockKind.Paragraph, 0), (MdBlockKind.Code, 0)]), "ブロックの種類と階層を見分ける");
Assert(md[^1].Text == "npm test # **x**" && md[^1].Language == "bash", "コードブロックは中身をそのまま残す");
Assert(md[5].Inlines.SequenceEqual([new MdInline("npm test", MdInlineStyle.Code), new MdInline(" を ", MdInlineStyle.Plain), new MdInline("必ず", MdInlineStyle.Bold)]), "行内コードと太字");
Assert(MarkdownLite.ParseInlines("2 ** 3 と `未完").SequenceEqual([new MdInline("2 ** 3 と `未完", MdInlineStyle.Plain)]), "閉じていない記号は文字のまま");
Assert(MarkdownLite.Parse("```python\nprint(1)").Single() is { Kind: MdBlockKind.Code, Text: "print(1)" }, "閉じていないコードブロックは最後までコード");
Assert(MarkdownLite.Parse("一行目\n二行目\n\n次").Select(b => b.Inlines[0].Text).SequenceEqual(["一行目\n二行目", "次"]), "空行で段落を分け、段落内の改行は残す");

// opencode 会話はウィンドウより長く生き、作業フォルダが無ければ起動しない
var fakeRunner = new FakeOpenCodeRunner();
var unsetConversation = new OpenCodeConversation(fakeRunner, _ => true);
Assert(!await unsetConversation.SendAsync("質問"), "作業フォルダ未設定なら送信しない");
Assert(unsetConversation.Status.Contains("未設定"), "未設定の理由を表示する");
var missingConversation = new OpenCodeConversation(fakeRunner, _ => false);
missingConversation.SetWorkingDir(@"D:\missing");
Assert(!await missingConversation.SendAsync("質問"), "作業フォルダが無ければ送信しない");
Assert(missingConversation.Status == @"opencode 実行フォルダが見つかりません: D:\missing", "見つからない作業フォルダを表示する");
Assert(fakeRunner.Calls.Count == 0, "作業フォルダが無いとき opencode を起動しない（別フォルダで代わりに動かさない）");

var clockNow = new DateTimeOffset(2026, 11, 9, 12, 0, 0, TimeSpan.Zero);
var conversation = new OpenCodeConversation(fakeRunner, _ => true, () => clockNow);
conversation.SetWorkingDir(@"C:\work");
var changedCount = 0;
conversation.Changed += () => changedCount++;
fakeRunner.OnRun = () => clockNow = clockNow.AddSeconds(2);
fakeRunner.Script.Enqueue(([Ev("text", "{\"id\":\"a1\",\"type\":\"text\",\"text\":\"前半\"}"), Ev("text", "{\"id\":\"a2\",\"type\":\"text\",\"text\":\"後半\"}")], new OpenCodeRunResult(0, "")));
Assert(await conversation.SendAsync("最初の質問"), "1回目を送信する");
Assert(fakeRunner.Calls[^1].Args.SequenceEqual(["run", "--format", "json", "--thinking", "--", "最初の質問"]), "1回目は新規会話");
Assert(fakeRunner.Calls[^1].WorkingDir == @"C:\work", "設定された作業フォルダで実行する");
Assert(conversation.Transcript.Snapshot().Select(e => (e.Kind, e.Text)).SequenceEqual([(ChatEntryKind.User, "最初の質問"), (ChatEntryKind.Text, "前半"), (ChatEntryKind.Text, "後半")]), "指示と応答をチャットとして並べる");
Assert(conversation.SessionId == "ses_A" && conversation.HasConversation, "会話IDを覚える");
Assert(changedCount >= 3, "ストリーミング中の途中経過を通知する");
Assert(conversation.StatusText() == "完了（2.0秒）", "完了とかかった時間を表示する");
fakeRunner.OnRun = null;
conversation.Model = "opencode/big-pickle";
conversation.PlanMode = true;
conversation.AutoApprove = true;
await conversation.SendAsync("2回目の質問");
Assert(fakeRunner.Calls[^1].Args.SequenceEqual(["run", "--format", "json", "--thinking", "--model", "opencode/big-pickle", "--agent", "plan", "--auto", "--session", "ses_A", "--", "2回目の質問"]), "2回目は同じ会話IDで続け、選んだモデル・Plan・自動承認を渡す");
Assert(conversation.History.Items.SequenceEqual(["最初の質問", "2回目の質問"]), "送った指示を履歴に残す");
conversation.Model = null;
conversation.PlanMode = false;
conversation.AutoApprove = false;
fakeRunner.Script.Enqueue(([], new OpenCodeRunResult(1, "認証が必要です")));
conversation.SetWorkingDir(@"D:\other");
Assert(!conversation.HasConversation, "作業フォルダを変えたら新規会話に戻す");
await conversation.SendAsync("失敗する質問");
Assert(conversation.Transcript.Snapshot()[^1] is { Kind: ChatEntryKind.Notice, Status: "error", Text: "opencode 実行失敗（exit 1）: 認証が必要です" }, "失敗時は終了コードと標準エラーをお知らせする");
Assert(!conversation.HasConversation, "失敗した実行を会話継続の起点にしない");
fakeRunner.Script.Enqueue(([], new OpenCodeRunResult(-1, "", TimedOut: true)));
await conversation.SendAsync("時間切れ");
Assert(conversation.Transcript.Snapshot()[^1].Text == "タイムアウトしたため停止しました", "タイムアウトをお知らせする");
fakeRunner.Script.Enqueue(([], new OpenCodeRunResult(0, "")));
await conversation.SendAsync("空");
Assert(conversation.Transcript.Snapshot()[^1].Text == "（応答なし）", "応答なしをお知らせする");
conversation.Reset();
Assert(conversation.Transcript.Snapshot().Count == 0 && conversation.SessionId is null, "新規会話で表示と会話IDを消す");

// 実行中の送信は待ち行列へ入れ、終わったら順に送る。停止は待ち行列も捨てる
var blockingRunner = new BlockingOpenCodeRunner();
var busyNow = clockNow;
var busyConversation = new OpenCodeConversation(blockingRunner, _ => true, () => busyNow);
busyConversation.SetWorkingDir(@"C:\work");
var firstSend = busyConversation.SendAsync("長い処理");
await blockingRunner.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
Assert(busyConversation.IsRunning, "実行中を示す");
Assert(await busyConversation.SendAsync("次の指示"), "実行中の送信は待ち行列で受け付ける");
busyNow = busyNow.AddSeconds(12);
Assert(busyConversation.Queue.SequenceEqual(["次の指示"]) && busyConversation.StatusText() == "作業中… 12秒 · 待機 1件", "待ち行列と経過時間を表示する");
blockingRunner.Release.TrySetResult();
await firstSend.WaitAsync(TimeSpan.FromSeconds(5));
Assert(blockingRunner.Prompts.SequenceEqual(["長い処理", "次の指示"]) && busyConversation.Queue.Count == 0 && !busyConversation.IsRunning, "今の実行が終わったら待ち行列を順に送る");

var cancelRunner = new BlockingOpenCodeRunner();
var cancelConversation = new OpenCodeConversation(cancelRunner, _ => true);
cancelConversation.SetWorkingDir(@"C:\work");
var cancelSend = cancelConversation.SendAsync("長い処理");
await cancelRunner.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
await cancelConversation.SendAsync("待機中の指示");
cancelConversation.Cancel();
await cancelSend.WaitAsync(TimeSpan.FromSeconds(5));
Assert(cancelRunner.Prompts.Count == 1 && cancelConversation.Queue.Count == 0 && !cancelConversation.IsRunning, "停止は実行を止め、待ち行列も捨てる");
Assert(cancelConversation.Transcript.Snapshot()[^1].Text == "中断しました" && cancelConversation.StatusText() == "中断しました", "中断を表示する");

// 会話履歴からの再開とモデル一覧
var historyRunner = new FakeOpenCodeRunner();
historyRunner.Captures["session list --format json -n 20"] = new OpenCodeCaptureResult(0, "[{\"id\":\"ses_old\",\"title\":\"前の会話\",\"updated\":5}]", "");
historyRunner.Captures["session export ses_old"] = new OpenCodeCaptureResult(0, "{\"info\":{\"id\":\"ses_old\",\"title\":\"前の会話\"},\"messages\":[{\"id\":\"m1\",\"type\":\"user\",\"text\":\"前の質問\"},{\"id\":\"m2\",\"type\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"前の応答\"}]}]}", "");
historyRunner.Captures["models"] = new OpenCodeCaptureResult(0, "opencode/big-pickle\nanthropic/claude-opus-5-5\n", "");
var historyConversation = new OpenCodeConversation(historyRunner, _ => true);
historyConversation.SetWorkingDir(@"C:\work");
var sessionList = await historyConversation.ListSessionsAsync();
Assert(sessionList.Count == 1 && sessionList[0].Id == "ses_old" && historyRunner.CaptureCalls[^1].WorkingDir == @"C:\work", "作業フォルダの会話一覧を取る");
Assert(await historyConversation.ResumeAsync("ses_old"), "過去の会話を読み込む");
Assert(historyConversation.Transcript.Snapshot().Select(e => e.Text).SequenceEqual(["前の質問", "前の応答"]) && historyConversation.SessionId == "ses_old" && historyConversation.HasConversation, "読み込んだ会話の続きから送る");
await historyConversation.SendAsync("続き");
Assert(historyRunner.Calls[^1].Args.TakeLast(4).SequenceEqual(["--session", "ses_old", "--", "続き"]), "読み込んだ会話IDで続ける");
Assert(!await historyConversation.ResumeAsync("ses_missing") && historyConversation.SessionId == "ses_old" && historyConversation.Status.Contains("会話を読み込めません"), "読み込めなければ今の会話を残す");
Assert((await historyConversation.ListModelsAsync()).SequenceEqual(["opencode/big-pickle", "anthropic/claude-opus-5-5"]), "モデル一覧を取る");
Assert((await new OpenCodeConversation(new FakeOpenCodeRunner(), _ => true).ListModelsAsync()).Count == 0, "モデル一覧が取れなければ空");

// 実プロセス: 標準エラーを大量に書いても止まらず、応答しないプロセスはタイムアウトで止める
var powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
var processRunner = new ProcessOpenCodeRunner(() => powershell, TimeSpan.FromSeconds(30), warmUp: false);
var lines = new List<string>();
var bigStderr = await processRunner.RunAsync(
    Path.GetTempPath(),
    ["-NoProfile", "-Command", "[Console]::Error.Write('e' * 200000); [Console]::Error.Flush(); Write-Output 'done'"],
    lines.Add,
    CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(25));
Assert(bigStderr.ExitCode == 0 && bigStderr.Stderr.Length >= 200000 && lines.Contains("done"), "標準エラーの量に関わらず最後まで読み切る");
var timeoutRunner = new ProcessOpenCodeRunner(() => powershell, TimeSpan.FromSeconds(1), warmUp: false);
var timedOut = await timeoutRunner.RunAsync(Path.GetTempPath(), ["-NoProfile", "-Command", "Start-Sleep -Seconds 30"], _ => { }, CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(20));
Assert(timedOut.TimedOut, "応答しない opencode はタイムアウトで止める");
var captured = await processRunner.CaptureAsync(Path.GetTempPath(), ["-NoProfile", "-Command", "Write-Output '[]'"], CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(25));
Assert(captured.ExitCode == 0 && captured.Stdout.Trim() == "[]", "短い問い合わせは標準出力をまとめて受け取る");
var missingExeRunner = new ProcessOpenCodeRunner(() => null, TimeSpan.FromSeconds(1), warmUp: false);
var missingExeConversation = new OpenCodeConversation(missingExeRunner, _ => true);
missingExeConversation.SetWorkingDir(Path.GetTempPath());
await missingExeConversation.SendAsync("質問");
Assert(missingExeConversation.Status.Contains("opencode が見つかりません"), "opencode.exe が無いことを表示する");

// スラッシュコマンド（このアプリ独自の定型作業）: 展開・入力チェック・補完（Obsidian と同じ操作）
var passCommand = new SlashCommand("pass", "パスワード表 C:\\secret\\pw.xlsx から $ARGUMENTS のパスワードを探して", "パスワード取得");
var pasteCommand = new SlashCommand("paste", "クリップボードを整形して");
var dailyCommand = new SlashCommand("daily", "今日の作業をまとめて");
var reportCommand = new SlashCommand("report-pass", "合格者を報告して");
SlashCommand[] slashCommands = [passCommand, pasteCommand, dailyCommand, reportCommand];
Assert(SlashCommands.Expand("/pass gmail", slashCommands) == "パスワード表 C:\\secret\\pw.xlsx から gmail のパスワードを探して", "$ARGUMENTS をコマンドの後ろの文字に置き換える");
Assert(SlashCommands.Expand("/PASS  gmail ", slashCommands) == "パスワード表 C:\\secret\\pw.xlsx から gmail のパスワードを探して", "名前は大文字小文字を区別しない");
Assert(SlashCommands.Expand("/daily", slashCommands) == "今日の作業をまとめて", "引数なしはプロンプトそのまま");
Assert(SlashCommands.Expand("/daily 午後は会議\n夜は資料", slashCommands) == "今日の作業をまとめて\n\n午後は会議\n夜は資料", "$ARGUMENTS が無ければ後ろの文字を空行のあとへ足す");
Assert(SlashCommands.Expand("/unknown x", slashCommands) is null && SlashCommands.Expand("/usr/bin を調べて", slashCommands) is null && SlashCommands.Expand("pass", slashCommands) is null, "登録の無い名前・パスは展開しない");
Assert(SlashCommands.Validate("", "x", []) == "コマンド名を入力してください", "名前が空");
Assert(SlashCommands.Validate("two words", "x", []) == "コマンド名に空白や / は使えません" && SlashCommands.Validate("a/b", "x", []) == "コマンド名に空白や / は使えません", "名前に空白や /");
Assert(SlashCommands.Validate("/pass", "x", ["PASS"]) == "/pass はすでに登録されています", "名前の重複");
Assert(SlashCommands.Validate("pass", "  ", []) == "プロンプトを入力してください", "プロンプトが空");
Assert(SlashCommands.Validate("/pass", "x", ["daily"]) is null, "正しい入力");
Assert(SlashCommands.NormalizeName(" /pass ") == "pass", "先頭の / を外す");
Assert(LauncherApiClient.ParseSavedWorkingDir("{\"opencode_working_dir\":\" C:\\\\work \",\"gantt_parent\":3}") == "C:\\work" && LauncherApiClient.ParseSavedWorkingDir("{}") == "" && LauncherApiClient.ParseSavedWorkingDir("{\"opencode_working_dir\":null}") == "", "実行フォルダの保存結果は前後の空白を除いて読み、無ければ空にする");
Assert(SlashCommands.Parse("{\"commands\":[{\"name\":\"pass\",\"prompt\":\"p\",\"description\":\"d\"},{\"name\":\"x\"},\"bad\"]}").SequenceEqual([new SlashCommand("pass", "p", "d")]) && SlashCommands.Parse("壊れた").Count == 0, "API の一覧を読み、壊れた項目は飛ばす");
Assert(SlashCommands.Query("/p", 2) == "p" && SlashCommands.Query("/", 1) == "" && SlashCommands.Query("/pa extra", 3) == "pa", "最初の語を打っている間だけ検索語を返す");
Assert(SlashCommands.Query("/pa extra", 6) is null && SlashCommands.Query("a/p", 3) is null && SlashCommands.Query("/p", 0) is null, "最初の語の外では補完しない");
Assert(SlashCommands.Candidates(slashCommands, "pa").Select(c => c.Name).SequenceEqual(["pass", "paste", "report-pass"]), "前方一致を先に、途中一致を後ろに");
Assert(SlashCommands.Candidates(slashCommands, "").Select(c => c.Name).SequenceEqual(["daily", "pass", "paste", "report-pass"]), "空の検索語は全件を名前順");
Assert(SlashCommands.ApplyCompletion("/p", 2, "pass") == ("/pass ", 6) && SlashCommands.ApplyCompletion("/pa gmail", 3, "pass") == ("/pass gmail", 6), "最初の語を「/名前 」に置き換える");

var suggestions = new SlashSuggestions();
suggestions.Refresh("/pa", 3, slashCommands);
Assert(suggestions.IsOpen && suggestions.Selected == passCommand, "/ を打つと候補が開き、先頭を選ぶ");
suggestions.Move(1);
Assert(suggestions.Selected == pasteCommand, "↓で次の候補");
suggestions.Move(-2);
Assert(suggestions.Selected == reportCommand, "上下の移動は端で回る");
suggestions.Refresh("/pa", 3, slashCommands);
suggestions.Move(1);
Assert(suggestions.Accept("/pa", 3) == ("/paste ", 7) && !suggestions.IsOpen, "確定で補完して閉じる");
suggestions.Refresh("/p", 2, slashCommands);
suggestions.Dismiss();
suggestions.Refresh("/p", 2, slashCommands);
Assert(!suggestions.IsOpen, "Esc で閉じたら同じ文字のままでは開かない");
suggestions.Refresh("/pa", 3, slashCommands);
Assert(suggestions.IsOpen, "文字が変われば開く");
suggestions.Refresh("/zzz", 4, slashCommands);
Assert(!suggestions.IsOpen, "候補が無ければ閉じる");
var tabState = new SlashSuggestions();
Assert(tabState.CompleteOnTab("/d", 2, slashCommands) == ("/daily ", 7), "Tab: 候補が 1 つならそのまま補完");
tabState.Refresh("/p", 2, slashCommands);
tabState.Dismiss();
Assert(tabState.CompleteOnTab("/p", 2, slashCommands) is null && tabState.IsOpen, "Tab: 複数なら候補を開く");
Assert(tabState.CompleteOnTab("/p", 2, slashCommands) == ("/pass ", 6), "Tab: 開いていれば選択中を確定");

Assert(OpenCodeInputKeys.Decide(Key.Down, ModifierKeys.None, caretOnFirstLine: false, caretOnLastLine: true, suggestionsOpen: true) == OpenCodeInputAction.SuggestionNext, "候補表示中の↓は候補の移動（履歴ではない）");
Assert(OpenCodeInputKeys.Decide(Key.Up, ModifierKeys.None, caretOnFirstLine: true, caretOnLastLine: false, suggestionsOpen: true) == OpenCodeInputAction.SuggestionPrevious, "候補表示中の↑は候補の移動");
Assert(OpenCodeInputKeys.Decide(Key.Tab, ModifierKeys.None, true, true, suggestionsOpen: true) == OpenCodeInputAction.AcceptSuggestion && OpenCodeInputKeys.Decide(Key.Enter, ModifierKeys.None, true, true, suggestionsOpen: true) == OpenCodeInputAction.AcceptSuggestion, "候補表示中の Tab / Enter は確定（送信しない）");
Assert(OpenCodeInputKeys.Decide(Key.Escape, ModifierKeys.None, true, true, suggestionsOpen: true) == OpenCodeInputAction.CloseSuggestions, "候補表示中の Esc は候補を閉じる（ランチャーは隠さない）");
Assert(OpenCodeInputKeys.Decide(Key.Tab, ModifierKeys.None, true, true, inSlashToken: true) == OpenCodeInputAction.CompleteSlash, "/ の語の中の Tab は補完");
Assert(OpenCodeInputKeys.Decide(Key.Tab, ModifierKeys.None, true, true) == OpenCodeInputAction.None && OpenCodeInputKeys.Decide(Key.Escape, ModifierKeys.None, true, true) == OpenCodeInputAction.None, "それ以外の Tab / Esc はペイン移動・非表示に任せる");

var slashRunner = new FakeOpenCodeRunner();
var slashConversation = new OpenCodeConversation(slashRunner, _ => true);
slashConversation.SetWorkingDir(@"C:\work");
slashConversation.SlashCommands = [passCommand];
await slashConversation.SendAsync("/pass gmail");
await slashConversation.SendAsync("/usr/bin を調べて");
Assert(slashRunner.Calls.Select(call => call.Args[^1]).SequenceEqual(["パスワード表 C:\\secret\\pw.xlsx から gmail のパスワードを探して", "/usr/bin を調べて"]), "登録したコマンドは展開して送り、登録の無い /… はそのまま送る");
Assert(slashConversation.Transcript.Snapshot().Where(e => e.Kind == ChatEntryKind.User).Select(e => e.Text).SequenceEqual(["/pass gmail", "/usr/bin を調べて"]), "吹き出しには打った文字を残す");
Assert(slashConversation.History.Items.SequenceEqual(["/pass gmail", "/usr/bin を調べて"]), "指示の履歴にも打った文字を残す");

// 常時保持メモ: ウィンドウを閉じても保存が中断されず、保存中の追記も取りこぼさない
var savedMemos = new List<string>();
LauncherMemoStore? memoStoreRef = null;
var memoStore = new LauncherMemoStore(async text =>
{
    await Task.Yield();
    savedMemos.Add(text);
    if (savedMemos.Count == 1) memoStoreRef!.Update("1行目\n2行目");
}, TimeSpan.FromMinutes(10));
memoStoreRef = memoStore;
memoStore.Load("サーバーのメモ");
Assert(!memoStore.IsDirty && memoStore.Text == "サーバーのメモ", "読み込んだメモは未保存扱いにしない");
memoStore.Update("1行目");
Assert(await memoStore.FlushAsync(), "保存できる");
Assert(savedMemos.SequenceEqual(["1行目"]) && memoStore.IsDirty, "保存中の追記は未保存として残す");
Assert(await memoStore.FlushAsync(), "残った追記を保存できる");
Assert(savedMemos.SequenceEqual(["1行目", "1行目\n2行目"]) && !memoStore.IsDirty, "保存中の追記も次の保存で届く");
memoStore.Load("上書きされない");
Assert(memoStore.Text == "1行目\n2行目", "手元の編集はサーバーの古い値で消さない（空でないときは読み込まない）");

var debounceSaved = new List<string>();
using var debounceStore = new LauncherMemoStore(text => { debounceSaved.Add(text); return Task.CompletedTask; }, TimeSpan.FromMilliseconds(50));
debounceStore.Update("a");
debounceStore.Update("ab");
for (var i = 0; i < 40 && debounceSaved.Count == 0; i++) await Task.Delay(50);
Assert(debounceSaved.SequenceEqual(["ab"]), "入力が止まってから最後の内容だけを保存する");

var failCount = 0;
var flakyStore = new LauncherMemoStore(_ => ++failCount == 1 ? throw new HttpRequestException("接続できません") : Task.CompletedTask, TimeSpan.FromMinutes(10));
flakyStore.Update("メモ");
Assert(!await flakyStore.FlushAsync() && flakyStore.IsDirty && flakyStore.Status == "保存失敗: 接続できません", "保存に失敗したら未保存のまま残す");
Assert(await flakyStore.FlushAsync() && !flakyStore.IsDirty, "次の保存で再送する");

// ウィンドウ再生成で保持する入力（opencode の会話とメモはウィンドウではなくアプリ側が持つ）
var fourPaneState = new LauncherWindowState(
    Query: "query",
    ExtensionFilter: ".md",
    MemoTitle: "title",
    MemoBody: "body",
    IncludeGantt: true,
    UpdateIndexOnSearch: false,
    SearchType: "hybrid",
    IncludePathInFilename: true,
    OpenCodePrompt: "下書きプロンプト"
);
Assert(fourPaneState.OpenCodePrompt == "下書きプロンプト" && fourPaneState.MemoTitle == "title", "ウィンドウ再生成時も入力途中の文字を保持する");

Console.WriteLine("LocalSearchLauncher tests passed");

/// <summary>opencode の代わりに決めた NDJSON 行を返すテスト用ランナー。capture は引数ごとに決めた結果を返す。</summary>
sealed class FakeOpenCodeRunner : IOpenCodeProcessRunner
{
    public Queue<(string[] Lines, OpenCodeRunResult Result)> Script { get; } = new();
    public List<(string WorkingDir, string[] Args)> Calls { get; } = [];
    public Dictionary<string, OpenCodeCaptureResult> Captures { get; } = [];
    public List<(string WorkingDir, string[] Args)> CaptureCalls { get; } = [];
    public Action? OnRun { get; set; }

    public Task<OpenCodeRunResult> RunAsync(string workingDir, IReadOnlyList<string> args, Action<string> onLine, CancellationToken cancellationToken)
    {
        Calls.Add((workingDir, args.ToArray()));
        OnRun?.Invoke();
        var (lines, result) = Script.Count > 0 ? Script.Dequeue() : ([], new OpenCodeRunResult(0, ""));
        foreach (var line in lines) onLine(line);
        return Task.FromResult(result);
    }

    public Task<OpenCodeCaptureResult> CaptureAsync(string workingDir, IReadOnlyList<string> args, CancellationToken cancellationToken)
    {
        CaptureCalls.Add((workingDir, args.ToArray()));
        return Task.FromResult(Captures.TryGetValue(string.Join(" ", args), out var result) ? result : new OpenCodeCaptureResult(1, "", "not scripted"));
    }
}

/// <summary>1 回目の実行だけ、Release か中断まで終わらないテスト用ランナー。</summary>
sealed class BlockingOpenCodeRunner : IOpenCodeProcessRunner
{
    public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public List<string> Prompts { get; } = [];

    public async Task<OpenCodeRunResult> RunAsync(string workingDir, IReadOnlyList<string> args, Action<string> onLine, CancellationToken cancellationToken)
    {
        Prompts.Add(args[^1]);
        if (Prompts.Count > 1) return new OpenCodeRunResult(0, "");
        Entered.TrySetResult();
        try { await Release.Task.WaitAsync(cancellationToken); }
        catch (OperationCanceledException) { return new OpenCodeRunResult(-1, "", Cancelled: true); }
        return new OpenCodeRunResult(0, "");
    }

    public Task<OpenCodeCaptureResult> CaptureAsync(string workingDir, IReadOnlyList<string> args, CancellationToken cancellationToken) =>
        Task.FromResult(new OpenCodeCaptureResult(1, "", ""));
}
