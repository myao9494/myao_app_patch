/**
 * Windows WPF ランチャーからローカル FastAPI バックエンドおよび gantt API へ接続する HTTP クライアント。
 **/
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace LocalSearchLauncher;

/// <summary>Web設定ドロワーと共有されるランチャー設定値。</summary>
internal sealed record LauncherSharedSettings(
    int GanttParent,
    string OpenCodeWorkingDir,
    string LauncherMemo,
    bool HasLauncherMemo);

/// <summary>ローカルバックエンドへプロキシを介さず接続する。</summary>
internal sealed class LauncherApiClient : IDisposable
{
    /// <summary>API タイムアウトの既定秒数。Python ランチャーの既定値と揃える。</summary>
    private const double DefaultRequestTimeoutSeconds = 15;

    private readonly HttpClient _http;
    private readonly HttpClient _ganttHttp;
    /// <summary>バックエンドとの JSON の書式（項目名はスネークケース、読み込みは大文字小文字を区別しない）。</summary>
    internal static JsonSerializerOptions JsonOptions { get; } = new() { PropertyNameCaseInsensitive = true, PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower };

    private readonly JsonSerializerOptions _json = JsonOptions;

    /// <summary>検索APIとgantt APIに共通のタイムアウト。</summary>
    public TimeSpan RequestTimeout { get; }

    public LauncherApiClient()
    {
        var baseUrl = Environment.GetEnvironmentVariable("LAUNCHER_API_BASE_URL") ?? "http://127.0.0.1:8079";
        RequestTimeout = ResolveRequestTimeout(Environment.GetEnvironmentVariable("LAUNCHER_REQUEST_TIMEOUT"));
        _http = new HttpClient(new HttpClientHandler { UseProxy = false }) { BaseAddress = new Uri(baseUrl.TrimEnd('/') + "/"), Timeout = RequestTimeout };
        var ganttBase = Environment.GetEnvironmentVariable("LAUNCHER_GANTT_API_BASE_URL") ?? "http://localhost:8000/api";
        _ganttHttp = new HttpClient(new HttpClientHandler { UseProxy = false }) { BaseAddress = new Uri(ganttBase.TrimEnd('/') + "/"), Timeout = RequestTimeout };
    }

    /// <summary>LAUNCHER_REQUEST_TIMEOUT の秒数を返す。未設定・数値以外・0以下なら既定値を使う。</summary>
    internal static TimeSpan ResolveRequestTimeout(string? configuredSeconds) =>
        TimeSpan.FromSeconds(double.TryParse(configuredSeconds, out var seconds) && seconds > 0 ? seconds : DefaultRequestTimeoutSeconds);

    public async Task<SearchResponse> SearchAsync(string query, int limit, bool includeGanttTasks, string types, bool updateIndexOnSearch, CancellationToken token, string searchType = "hybrid", bool includePathInFilename = true)
    {
        var (endpoint, payload) = LauncherSearchRequestBuilder.Build(query, limit, includeGanttTasks, types, updateIndexOnSearch, searchType, includePathInFilename);
        using var response = await _http.PostAsJsonAsync(endpoint, payload, _json, token);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<SearchResponse>(_json, token) ?? new SearchResponse(0, [], false);
    }

    public async Task RecordClickAsync(SearchItem item, string query)
    {
        if (item.FileId <= 0) return;
        using var response = await _http.PostAsJsonAsync("api/search/click", new { file_id = item.FileId, query }, _json);
        response.EnsureSuccessStatusCode();
    }

    public async Task OpenLocationAsync(string path)
    {
        using var response = await _http.PostAsJsonAsync("api/files/open-location", new { path }, _json);
        response.EnsureSuccessStatusCode();
    }

    public async Task OpenGanttTaskAsync(int taskId)
    {
        using var response = await _http.PostAsJsonAsync($"api/gantt/tasks/{Math.Abs(taskId)}/open-input", new { }, _json);
        response.EnsureSuccessStatusCode();
    }

    public async Task<int> GetGanttParentAsync(int fallback)
    {
        using var response = await _http.GetAsync("api/index/settings");
        response.EnsureSuccessStatusCode();
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        if (!document.RootElement.TryGetProperty("gantt_parent", out var value)) return fallback;
        return value.ValueKind switch
        {
            JsonValueKind.Number when value.TryGetInt32(out var number) && number >= 0 => number,
            JsonValueKind.String when int.TryParse(value.GetString(), out var number) && number >= 0 => number,
            _ => fallback,
        };
    }

    /// <summary>Web設定ドロワーで保存されたgantt_parent / opencode_working_dir / launcher_memo を一括取得する。</summary>
    public async Task<LauncherSharedSettings> GetSharedSettingsAsync(int fallbackParent, string fallbackWorkingDir)
    {
        using var response = await _http.GetAsync("api/index/settings");
        response.EnsureSuccessStatusCode();
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var root = document.RootElement;

        int parent = fallbackParent;
        if (root.TryGetProperty("gantt_parent", out var parentElem))
        {
            parent = parentElem.ValueKind switch
            {
                JsonValueKind.Number when parentElem.TryGetInt32(out var n) && n >= 0 => n,
                JsonValueKind.String when int.TryParse(parentElem.GetString(), out var n) && n >= 0 => n,
                _ => fallbackParent,
            };
        }

        string workingDir = fallbackWorkingDir;
        if (root.TryGetProperty("opencode_working_dir", out var dirElem) && dirElem.ValueKind == JsonValueKind.String)
        {
            var rawDir = dirElem.GetString()?.Trim();
            if (!string.IsNullOrWhiteSpace(rawDir)) workingDir = rawDir;
        }

        string memo = "";
        bool hasMemo = false;
        if (root.TryGetProperty("launcher_memo", out var memoElem) && memoElem.ValueKind == JsonValueKind.String)
        {
            memo = memoElem.GetString() ?? "";
            hasMemo = true;
        }

        return new LauncherSharedSettings(parent, workingDir, memo, hasMemo);
    }

    /// <summary>opencode 実行フォルダだけを共有設定のPUTで保存し、保存後のフォルダを返す（他の設定は送らず据え置く。空欄ならバックエンドの既定フォルダが補われる）。</summary>
    public async Task<string> SaveOpenCodeWorkingDirAsync(string path)
    {
        using var response = await _http.PutAsJsonAsync("api/index/settings", new { opencode_working_dir = path ?? "" }, _json);
        response.EnsureSuccessStatusCode();
        return ParseSavedWorkingDir(await response.Content.ReadAsStringAsync());
    }

    /// <summary>設定保存APIの応答から opencode_working_dir を取り出す（無い・文字列でないときは空）。</summary>
    internal static string ParseSavedWorkingDir(string json)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.TryGetProperty("opencode_working_dir", out var value) && value.ValueKind == JsonValueKind.String
            ? (value.GetString() ?? "").Trim()
            : "";
    }

    /// <summary>常時保持メモ（Scratchpad）だけをメモ専用APIへPUT保存する（他の共有設定は書き直さない）。</summary>
    public async Task SaveLauncherMemoAsync(string memo)
    {
        using var response = await _http.PutAsJsonAsync("api/index/settings/launcher-memo", new { launcher_memo = memo ?? "" }, _json);
        response.EnsureSuccessStatusCode();
    }

    /// <summary>OpenCode ペインの独自スラッシュコマンド一覧を読む。</summary>
    public async Task<IReadOnlyList<SlashCommand>> GetSlashCommandsAsync()
    {
        using var response = await _http.GetAsync("api/index/settings/launcher-slash-commands");
        response.EnsureSuccessStatusCode();
        return SlashCommands.Parse(await response.Content.ReadAsStringAsync());
    }

    /// <summary>独自スラッシュコマンドの一覧を丸ごと保存し、保存後の一覧を返す。</summary>
    public async Task<IReadOnlyList<SlashCommand>> SaveSlashCommandsAsync(IReadOnlyList<SlashCommand> commands)
    {
        var payload = new { commands = commands.Select(c => new { name = c.Name, prompt = c.Prompt, description = c.Description }).ToArray() };
        using var response = await _http.PutAsJsonAsync("api/index/settings/launcher-slash-commands", payload, _json);
        response.EnsureSuccessStatusCode();
        return SlashCommands.Parse(await response.Content.ReadAsStringAsync());
    }

    /// <summary>再起動時に保存済みのホットキー方式を取得する。</summary>
    public async Task<string> GetLauncherHotkeyAsync(string fallback = "command_option")
    {
        using var response = await _http.GetAsync("api/index/settings");
        response.EnsureSuccessStatusCode();
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        if (!document.RootElement.TryGetProperty("launcher_hotkey", out var value) || value.ValueKind != JsonValueKind.String)
            return fallback;
        var hotkey = value.GetString();
        return hotkey is "command_option" or "double_shift" ? hotkey : fallback;
    }

    public async Task CreateGanttTaskAsync(GanttTaskRequest task)
    {
        using var response = await _ganttHttp.PostAsJsonAsync("tasks", task, _json);
        response.EnsureSuccessStatusCode();
    }

    public void Dispose()
    {
        _http.Dispose();
        _ganttHttp.Dispose();
    }
}
