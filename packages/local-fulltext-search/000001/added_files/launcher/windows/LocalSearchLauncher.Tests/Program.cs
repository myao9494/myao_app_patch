using LocalSearchLauncher;
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

var (indexedEndpoint, indexedPayload) = LauncherSearchRequestBuilder.Build("alpha", 8, false, ".md");
Assert(indexedEndpoint == "api/search/indexed", "通常検索は既存DB専用APIを使う");
Assert(indexedPayload is IndexedLauncherSearchRequest { SourceType: "local_web" }, "通常検索はlocalとwebを横断する");
var (ganttEndpoint, ganttPayload) = LauncherSearchRequestBuilder.Build("alpha", 8, true, "");
Assert(ganttEndpoint == "api/search", "gantt追加検索は統合APIを使う");
Assert(ganttPayload is LauncherSearchRequest { SourceType: "local_web", SkipRefresh: true }, "gantt追加時もlocal/web横断かつDB更新なしにする");
var (updateEndpoint, updatePayload) = LauncherSearchRequestBuilder.Build("alpha", 8, false, ".md", updateIndexOnSearch: true);
Assert(updateEndpoint == "api/search", "更新ONは統合APIを使う");
Assert(updatePayload is LauncherSearchRequest { SourceType: "local_web", SkipRefresh: false, IncludeGanttTasks: false }, "更新ONはganttを勝手に有効化せずバックグラウンド差分更新を許可する");

Assert(LauncherResultSelection.CanOpenWithReturn(hasSelectedResult: true, memoActive: false), "検索画面で先頭結果が選択されていればReturnだけで開く");
Assert(!LauncherResultSelection.CanOpenWithReturn(hasSelectedResult: false, memoActive: false), "検索結果がないときReturnでは開かない");
Assert(!LauncherResultSelection.CanOpenWithReturn(hasSelectedResult: true, memoActive: true), "ganttメモ画面のReturnでは検索結果を開かない");

Assert(WindowDragPolicy.CanStartDrag(MouseButton.Left, MouseButtonState.Pressed), "左ボタン押下時はウィンドウ移動を開始できる");
Assert(!WindowDragPolicy.CanStartDrag(MouseButton.Right, MouseButtonState.Pressed), "右クリックではウィンドウ移動を開始しない");
Assert(!WindowDragPolicy.CanStartDrag(MouseButton.Left, MouseButtonState.Released), "ボタン未押下ではウィンドウ移動を開始しない");

var state = new LauncherWindowState("query", ".md .py", "title", "body", true, true, true);
Assert(
    state.MemoActive && state.IncludeGantt && state.UpdateIndexOnSearch && state.MemoTitle == "title" && state.ExtensionFilter == ".md .py",
    "ウィンドウ再生成用に拡張子フィルタを含む入力状態を保持する"
);

Environment.SetEnvironmentVariable("LAUNCHER_WEB_BASE_URL", "http://127.0.0.1:8123/");
Assert(LauncherUrls.OpenHubBase() == "http://127.0.0.1:8123", "結果openは設定済みの外部Openハブを使う");
Environment.SetEnvironmentVariable("LAUNCHER_WEB_BASE_URL", null);

Console.WriteLine("LocalSearchLauncher tests passed");
