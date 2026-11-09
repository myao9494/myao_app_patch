/**
 * Windows WPF ランチャーのデータモデル・リクエストビルダー・4ペインナビゲーション・OpenCode CLIコマンドビルダー。
 **/
using System.IO;
using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace LocalSearchLauncher;

/// <summary>検索APIのJSONレスポンスを表す。</summary>
internal sealed record SearchResponse(int Total, List<SearchItem> Items, bool HasMore, bool BackgroundRefreshScheduled = false);

internal sealed record SearchItem(
    int FileId, string ResultKind, string SourceType, string TargetPath,
    string FileName, string FullPath, string FileExt, string Snippet, string? GanttLink,
    string? MatchSource = null, string? SalientSentence = null,
    double? HybridScore = null, double? VectorScore = null)
{
    /// <summary>HTML断片をランチャー表示用のプレーンテキストへ変換する。</summary>
    public string PlainSnippet => WebUtility.HtmlDecode(Regex.Replace(Snippet ?? "", "<[^>]+>", ""));
    public string DisplayTitle => MatchSource switch
    {
        "both" => $"{FileName}  🌟両方一致",
        "vector" => $"{FileName}  🔮意味一致",
        "keyword" => $"{FileName}  🏷️通常一致",
        _ => FileName
    };
    public string DisplaySnippet => !string.IsNullOrWhiteSpace(SalientSentence)
        ? $"💡 {SalientSentence}"
        : PlainSnippet;
    public bool IsGantt => SourceType == "gantt";
    public bool IsWeb => SourceType == "web";
    public bool IsLocal => !IsGantt && !IsWeb;
    public bool HasGanttLink => IsGantt && !string.IsNullOrWhiteSpace(GanttLink);
    public string IconPath => $"Assets/catppuccin/{ResolveIconName()}.png";

    private string ResolveIconName()
    {
        if (IsGantt || IsWeb) return "url";
        if (ResultKind == "folder") return "folder";
        return FileExt.ToLowerInvariant() switch
        {
            ".md" or ".markdown" => "markdown",
            ".pdf" => "pdf",
            ".json" or ".jsonc" => "json",
            ".xml" or ".drawio" or ".dio" => "xml",
            ".csv" or ".tsv" or ".xls" or ".xlsx" => "ms-excel",
            ".doc" or ".docx" => "ms-word",
            ".ppt" or ".pptx" => "ms-powerpoint",
            ".msg" or ".eml" => "email",
            ".py" => "python",
            ".js" => "javascript",
            ".ts" or ".tsx" => "typescript",
            ".html" or ".htm" => "html",
            ".css" => "css",
            ".yaml" or ".yml" => "yaml",
            ".toml" => "toml",
            ".sh" or ".bash" or ".zsh" or ".bat" or ".ps1" => "bash",
            ".png" or ".jpg" or ".jpeg" or ".gif" or ".webp" or ".bmp" => "image",
            ".svg" or ".excalidraw" => "svg",
            ".mp3" or ".wav" or ".m4a" or ".flac" => "audio",
            ".mp4" or ".mov" or ".avi" or ".mkv" => "video",
            ".zip" or ".tar" or ".gz" or ".7z" or ".rar" => "zip",
            _ => "text",
        };
    }
}

/// <summary>
/// 既存DB専用API（POST /api/search/indexed）の入力。
/// バックエンドの IndexedSearchRequest は folder_path が必須で、空文字は DB 全体を対象にする。
/// </summary>
internal sealed record IndexedLauncherSearchRequest(
    string Q, int Limit, string SourceType = "local_web", string Types = "",
    string SearchType = "hybrid", bool IncludePathInFilename = true)
{
    /// <summary>検索対象フォルダ。ランチャーは常に DB 全体（空文字）を検索する。</summary>
    public string FolderPath { get; init; } = "";
}

internal sealed record LauncherSearchRequest(
    string Q, string FullPath, int Limit, string SourceType, string Types,
    string SortBy, bool SkipRefresh, bool SearchAllEnabled, bool IncludeGanttTasks,
    string SearchType = "hybrid", bool IncludePathInFilename = true);

internal sealed record GanttTaskRequest(
    string Text, string StartDate, string EndDate, double Progress,
    int Parent, int KindTask, string Memo);

/// <summary>
/// 仮想デスクトップ切り替えのためウィンドウを再生成する際に、入力途中の文字と検索条件を保持する。
/// opencode の会話と常時保持メモはウィンドウではなくアプリ側（OpenCodeConversation / LauncherMemoStore）が持つ。
/// </summary>
internal sealed record LauncherWindowState(
    string Query = "",
    string ExtensionFilter = "",
    string MemoTitle = "",
    string MemoBody = "",
    // 4ペイン化で画面の切り替えは無くなったため参照しない（既存テストと位置引数の並びを保つために残す）
    bool MemoActive = false,
    bool IncludeGantt = false,
    bool UpdateIndexOnSearch = false,
    string SearchType = "hybrid",
    bool IncludePathInFilename = true,
    string OpenCodePrompt = "");

/// <summary>Windowsランチャーの検索リクエストを組み立てる。</summary>
internal static class LauncherSearchRequestBuilder
{
    public static (string Endpoint, object Payload) Build(
        string query,
        int limit,
        bool includeGanttTasks,
        string extensionFilter = "",
        bool updateIndexOnSearch = false,
        string searchType = "hybrid",
        bool includePathInFilename = true)
    {
        var q = query.Trim();
        var types = extensionFilter.Trim();
        var normalizedSearchType = string.IsNullOrWhiteSpace(searchType) ? "hybrid" : searchType.Trim();
        if (updateIndexOnSearch)
        {
            return ("api/search", new LauncherSearchRequest(
                q, "", limit, "local_web", types, "default",
                SkipRefresh: false, SearchAllEnabled: false, IncludeGanttTasks: includeGanttTasks,
                SearchType: normalizedSearchType, IncludePathInFilename: includePathInFilename));
        }
        if (!includeGanttTasks)
            return ("api/search/indexed", new IndexedLauncherSearchRequest(q, limit, "local_web", types, normalizedSearchType, includePathInFilename));

        return ("api/search", new LauncherSearchRequest(
            q, "", limit, "local_web", types, "default",
            SkipRefresh: true, SearchAllEnabled: true, IncludeGanttTasks: true,
            SearchType: normalizedSearchType, IncludePathInFilename: includePathInFilename));
    }
}

/// <summary>検索結果リストのReturnキー起動可否を判定する。</summary>
internal static class LauncherResultSelection
{
    public static bool CanOpenWithReturn(bool hasSelectedResult, bool memoActive) =>
        hasSelectedResult && !memoActive;
}

/// <summary>Open/UIハブの設定値を全WPF画面で一貫して組み立てる。</summary>
internal static class LauncherUrls
{
    public static string OpenHubBase() =>
        (Environment.GetEnvironmentVariable("LAUNCHER_WEB_BASE_URL") ?? "http://127.0.0.1:8001").TrimEnd('/');
}

/// <summary>macOS版と同じganttタスク作成値を組み立てる。</summary>
internal static class GanttTaskBuilder
{
    public static GanttTaskRequest Build(string title, string memo, int parent, DateOnly? today = null)
    {
        var start = today ?? DateOnly.FromDateTime(DateTime.Today);
        return new(
            title.Trim(),
            $"{start:yyyy-MM-dd} 00:00:00",
            $"{start.AddDays(1):yyyy-MM-dd} 00:00:00",
            0.1,
            Math.Max(0, parent),
            1,
            memo.Trim());
    }
}

/// <summary>1ページ4ペイン（左上:検索 → 右上:opencode CLI → 左下:永続メモ → 右下:gantt）のTab/Shift+Tabフォーカス順序を提供する。</summary>
internal static class LauncherTabNavigation
{
    private static readonly string[] Order =
    [
        "Query",
        "Extension",
        "OpenCodeInput",
        "OpenCodeSubmit",
        "Scratchpad",
        "MemoTitle",
        "MemoBody",
        "MemoSubmit",
    ];

    public static string Next(string current, bool backwards = false)
    {
        int index = Array.IndexOf(Order, current);
        if (index < 0) index = 0;
        int step = backwards ? -1 : 1;
        int nextIndex = (index + step + Order.Length) % Order.Length;
        return Order[nextIndex];
    }
}

/// <summary>
/// opencode CLI 実行用の引数組み立て・会話IDの取り出し・ANSIエスケープ除去・実行ファイル解決を提供する。
/// 出力（NDJSON）の表示は ChatTranscript（OpenCodeChat.cs）が受け持つ。
/// 指示は `--` の後ろへ置き、`-` で始まる指示もオプションとして解釈させない。
/// 実行ファイルは opencode.exe だけを使い、cmd.exe を経由する opencode.cmd は使わない
/// （cmd.exe は `&` や `|` を含む指示を別コマンドとして解釈するため）。
/// </summary>
internal static class OpenCodeCommandBuilder
{
    private static readonly Regex AnsiEscapeRegex = new(@"\x1b\[[0-9;?]*[ -/]*[@-~]", RegexOptions.Compiled);

    /// <summary>
    /// opencode run の引数を組み立てる。思考を表示するため常に --thinking を付け、
    /// モデル（--model）・Plan（--agent plan）・自動承認（--auto）・会話の続き（--session / --continue）の順に足し、指示は -- の後ろへ置く。
    /// </summary>
    public static IReadOnlyList<string> BuildArguments(
        string prompt,
        string? sessionId = null,
        bool continueSession = false,
        string? model = null,
        bool planMode = false,
        bool autoApprove = false)
    {
        string cleaned = (prompt ?? "").Trim();
        var args = new List<string> { "run", "--format", "json", "--thinking" };
        if (!string.IsNullOrWhiteSpace(model))
        {
            args.Add("--model");
            args.Add(model.Trim());
        }
        if (planMode)
        {
            args.Add("--agent");
            args.Add("plan");
        }
        if (autoApprove) args.Add("--auto");
        if (!string.IsNullOrWhiteSpace(sessionId))
        {
            args.Add("--session");
            args.Add(sessionId);
        }
        else if (continueSession)
        {
            args.Add("--continue");
        }
        args.Add("--");
        args.Add(cleaned);
        return args;
    }

    public static string StripAnsi(string text)
    {
        string normalized = (text ?? "").Replace("\r\n", "\n").Replace("\r", "\n");
        return AnsiEscapeRegex.Replace(normalized, "");
    }

    /// <summary>NDJSON の1行を JSON として読む。JSONでなければ null。</summary>
    private static JsonDocument? TryParse(string line)
    {
        string raw = (line ?? "").Trim();
        if (!(raw.StartsWith('{') && raw.EndsWith('}'))) return null;
        try { return JsonDocument.Parse(raw); }
        catch (JsonException) { return null; }
    }

    /// <summary>NDJSONイベントの sessionID を返す。JSONでない行やIDのない行は null。</summary>
    public static string? ExtractSessionId(string line)
    {
        using var doc = TryParse(line);
        if (doc is null) return null;
        return doc.RootElement.ValueKind == JsonValueKind.Object
            && doc.RootElement.TryGetProperty("sessionID", out var id)
            && id.ValueKind == JsonValueKind.String
            && !string.IsNullOrWhiteSpace(id.GetString())
            ? id.GetString()
            : null;
    }

    /// <summary>この PC の環境から opencode.exe を探す。見つからなければ null。</summary>
    public static string? ResolveExecutable() => ResolveExecutable(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        File.Exists,
        Environment.GetEnvironmentVariable("PATH") ?? "");

    /// <summary>npm 配下の opencode.exe → PATH 上の opencode.exe の順に探す。opencode.cmd は使わない。</summary>
    public static string? ResolveExecutable(string appData, Func<string, bool> fileExists, string pathVariable)
    {
        if (!string.IsNullOrWhiteSpace(appData))
        {
            string npmRoot = Path.Combine(appData, "npm", "node_modules", "@opencode", "cli");
            foreach (var candidate in new[]
            {
                Path.Combine(npmRoot, "bin", "opencode.exe"),
                Path.Combine(npmRoot, "node_modules", "@opencode", "cli-windows-x64", "bin", "opencode.exe"),
            })
            {
                if (fileExists(candidate)) return candidate;
            }
        }
        foreach (var directory in (pathVariable ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            string candidate = Path.Combine(directory, "opencode.exe");
            if (fileExists(candidate)) return candidate;
        }
        return null;
    }
}
