/**
 * WPF ランチャーの OpenCode ペインのチャット表示モデル（Obsidian の Claudian プラグイン風）と、表示用の書式・解析。
 * Python 版（launcher_app/opencode_chat.py）と同じ約束で動く。
 *
 * 【仕様】
 * - 会話は表示項目（ChatEntry）の並び。種類は User（自分の指示）/ Text（応答本文・Markdown）/
 *   Reasoning（思考。既定で折りたたみ、見出しに「思考（n秒）」）/ Tool（ツール実行カード。見出しは「状態アイコン ツール名 要約」、
 *   既定で折りたたみ、開くと入力と出力）/ Notice（中断・失敗などのお知らせ。Status は info / error）。
 * - opencode run --format json の NDJSON を ApplyLine で取り込む。text / reasoning / tool_use は part ID ごとに 1 項目で、
 *   同じ ID なら更新する（ツールは partID を優先）。step_finish は最後のトークン数をコンテキスト使用量とし、費用は合計する。
 *   error はエラーのお知らせ、その他の制御イベントは表示しない。JSON でない行は ANSI を除いて本文として残す。
 * - opencode session export の JSON から過去の会話を復元できる（FromExport）。
 * - 項目は不変の record。更新するたびに Revision を上げた新しい record に差し替える（画面は Id と Revision で差分だけ描き直す）。
 * - opencode の出力を読むスレッドと UI スレッドの両方から触るため、更新と Snapshot はロックで守る。
 **/
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows.Input;

namespace LocalSearchLauncher;

/// <summary>表示項目の種類。</summary>
internal enum ChatEntryKind { User, Text, Reasoning, Tool, Notice }

/// <summary>会話の表示項目 1 つ（不変）。</summary>
internal sealed record ChatEntry(
    string Id,
    ChatEntryKind Kind,
    string Text = "",
    string Tool = "",
    string Status = "",
    string Summary = "",
    string DetailInput = "",
    string DetailOutput = "",
    double? DurationSeconds = null,
    bool Expanded = false,
    int Revision = 0);

/// <summary>会話一覧の 1 件（opencode session list --format json）。</summary>
internal sealed record OpenCodeSessionSummary(string Id, string Title, long UpdatedMs);

/// <summary>OpenCode ペインに表示する会話。</summary>
internal sealed class ChatTranscript
{
    private const int DetailLimit = 4000;
    private static readonly JsonSerializerOptions IndentedJson = new()
    {
        WriteIndented = true,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };
    private readonly object _lock = new();
    private readonly List<ChatEntry> _entries = [];
    private int _nextId = 1;

    public long ContextTokens { get; private set; }
    public double Cost { get; private set; }
    public string Title { get; private set; } = "";

    /// <summary>今の表示項目の写し。</summary>
    public IReadOnlyList<ChatEntry> Snapshot()
    {
        lock (_lock) return _entries.ToArray();
    }

    public bool IsEmpty
    {
        get { lock (_lock) return _entries.Count == 0; }
    }

    /// <summary>表示と使用量を消す。</summary>
    public void Clear()
    {
        lock (_lock)
        {
            _entries.Clear();
            ContextTokens = 0;
            Cost = 0;
            Title = "";
        }
    }

    /// <summary>表示・使用量・題名を other の内容へ置き換える（過去の会話の読み込み）。</summary>
    public void ReplaceWith(ChatTranscript other)
    {
        var restored = other.Snapshot();
        lock (_lock)
        {
            _entries.Clear();
            _entries.AddRange(restored);
            ContextTokens = other.ContextTokens;
            Cost = other.Cost;
            Title = other.Title;
            _nextId = restored.Count + 1;
        }
    }

    private string NewId(string prefix)
    {
        lock (_lock) return $"{prefix}{_nextId++}";
    }

    /// <summary>同じ ID があれば Revision を上げて差し替え、なければ末尾へ足す。</summary>
    private ChatEntry Upsert(string id, Func<ChatEntry?, ChatEntry> build)
    {
        lock (_lock)
        {
            int index = _entries.FindIndex(entry => entry.Id == id);
            if (index < 0)
            {
                var created = build(null);
                _entries.Add(created);
                return created;
            }
            var updated = build(_entries[index]) with { Revision = _entries[index].Revision + 1 };
            _entries[index] = updated;
            return updated;
        }
    }

    /// <summary>自分の指示を吹き出しとして足す。</summary>
    public ChatEntry AddUser(string text)
    {
        string id = NewId("user_");
        string cleaned = (text ?? "").Trim();
        return Upsert(id, _ => new ChatEntry(id, ChatEntryKind.User, cleaned));
    }

    /// <summary>お知らせ（中断・失敗など）を足す。</summary>
    public ChatEntry AddNotice(string text, bool error = false)
    {
        string id = NewId("notice_");
        return Upsert(id, _ => new ChatEntry(id, ChatEntryKind.Notice, text, Status: error ? "error" : "info"));
    }

    /// <summary>思考・ツールの開閉を切り替える。見つからなければ false。</summary>
    public bool Toggle(string id)
    {
        lock (_lock)
        {
            int index = _entries.FindIndex(entry => entry.Id == id);
            if (index < 0) return false;
            var entry = _entries[index];
            _entries[index] = entry with { Expanded = !entry.Expanded, Revision = entry.Revision + 1 };
            return true;
        }
    }

    /// <summary>吹き出し単位のコピー用文字列。</summary>
    public string CopyText(string id)
    {
        lock (_lock) return _entries.FirstOrDefault(entry => entry.Id == id)?.Text ?? "";
    }

    /// <summary>最後の応答本文。</summary>
    public string LastAssistantText()
    {
        lock (_lock) return _entries.LastOrDefault(entry => entry.Kind == ChatEntryKind.Text)?.Text ?? "";
    }

    /// <summary>「コンテキスト 10.1k トークン · $0.0300」。使用量が無ければ空文字。</summary>
    public string UsageText()
    {
        if (ContextTokens <= 0) return "";
        string text = $"コンテキスト {OpenCodeChatFormat.FormatTokens(ContextTokens)} トークン";
        return Cost > 0 ? $"{text} · ${Cost.ToString("0.0000", System.Globalization.CultureInfo.InvariantCulture)}" : text;
    }

    /// <summary>NDJSON の 1 行を取り込む。表示が変わったら true。</summary>
    public bool ApplyLine(string line)
    {
        string raw = (line ?? "").Trim();
        if (raw.Length == 0) return false;
        if (raw.StartsWith('{') && raw.EndsWith('}'))
        {
            try
            {
                using var doc = JsonDocument.Parse(raw);
                if (doc.RootElement.ValueKind == JsonValueKind.Object) return ApplyEvent(doc.RootElement);
            }
            catch (JsonException)
            {
                // JSON として読めない行は本文として残す
            }
        }
        string cleaned = OpenCodeCommandBuilder.StripAnsi(raw).Trim();
        if (cleaned.Length == 0) return false;
        string id = NewId("raw_");
        Upsert(id, _ => new ChatEntry(id, ChatEntryKind.Text, cleaned));
        return true;
    }

    /// <summary>opencode のイベント 1 つを取り込む。表示が変わったら true。</summary>
    public bool ApplyEvent(JsonElement root)
    {
        string type = Str(root, "type");
        JsonElement part = root.TryGetProperty("part", out var p) && p.ValueKind == JsonValueKind.Object ? p : default;
        bool hasPart = part.ValueKind == JsonValueKind.Object;
        switch (type)
        {
            case "text":
            {
                string text = hasPart && part.TryGetProperty("text", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() ?? "" : Str(root, "text");
                if (text.Trim().Length == 0) return false;
                string id = hasPart ? Str(part, "id") : "";
                if (id.Length == 0) id = NewId("text_");
                Upsert(id, _ => new ChatEntry(id, ChatEntryKind.Text, text));
                return true;
            }
            case "reasoning":
            {
                string text = hasPart ? Str(part, "text").Trim() : "";
                if (text.Length == 0) return false;
                string id = Str(part, "id");
                if (id.Length == 0) id = NewId("reasoning_");
                double? duration = Duration(part, "start", "end");
                Upsert(id, _ => new ChatEntry(id, ChatEntryKind.Reasoning, text, DurationSeconds: duration));
                return true;
            }
            case "tool_use" or "tool_call":
                if (hasPart) ApplyTool(part, null);
                return hasPart;
            case "step_finish":
                lock (_lock)
                {
                    if (hasPart && part.TryGetProperty("tokens", out var tokens))
                    {
                        long context = ContextTokensOf(tokens);
                        if (context > 0) ContextTokens = context;
                    }
                    if (hasPart && part.TryGetProperty("cost", out var cost) && cost.ValueKind == JsonValueKind.Number) Cost += cost.GetDouble();
                }
                return true;
            case "error":
                AddNotice(ErrorMessage(root), error: true);
                return true;
            default:
                return false;
        }
    }

    /// <summary>ツールの part（run の tool_use / export の tool）をカードへ反映する。</summary>
    private void ApplyTool(JsonElement part, string? entryId)
    {
        JsonElement state = part.TryGetProperty("state", out var s) && s.ValueKind == JsonValueKind.Object ? s : default;
        bool hasState = state.ValueKind == JsonValueKind.Object;
        string tool = Str(part, "tool");
        if (tool.Length == 0) tool = Str(part, "name");
        if (tool.Length == 0) tool = "tool";
        string status = hasState ? Str(state, "status") : "";
        if (status.Length == 0 || status == "pending") status = "running";
        string inputJson = hasState && state.TryGetProperty("input", out var input) && input.ValueKind == JsonValueKind.Object ? input.GetRawText() : "";
        string title = hasState ? Str(state, "title") : "";
        if (title.Length == 0) title = Str(part, "title");
        string output = hasState ? Str(state, "output") : "";
        if (output.Length == 0 && hasState && state.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.Array)
        {
            output = string.Join("\n", content.EnumerateArray().Where(item => item.ValueKind == JsonValueKind.Object).Select(item => Str(item, "text")));
        }
        if (output.Length == 0 && status == "error" && hasState) output = Str(state, "error");
        string id = entryId ?? FirstNonEmpty(Str(part, "partID"), Str(part, "id"));
        if (id.Length == 0) id = NewId("tool_");
        string summary = OpenCodeChatFormat.SummarizeTool(tool, inputJson.Length > 0 ? inputJson : "{}", title);
        string detailInput = inputJson.Length > 0 && inputJson != "{}" ? Truncate(Indent(inputJson), DetailLimit) : "";
        string detailOutput = Truncate(OpenCodeCommandBuilder.StripAnsi(output).Trim(), DetailLimit);
        Upsert(id, _ => new ChatEntry(id, ChatEntryKind.Tool, Tool: tool, Status: status, Summary: summary, DetailInput: detailInput, DetailOutput: detailOutput));
    }

    /// <summary>opencode session export の JSON から会話を復元する。読めなければ空の会話。</summary>
    public static ChatTranscript FromExport(string json)
    {
        var transcript = new ChatTranscript();
        JsonDocument doc;
        try { doc = JsonDocument.Parse(json); }
        catch (JsonException) { return transcript; }
        using (doc)
        {
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return transcript;
            if (root.TryGetProperty("info", out var info) && info.ValueKind == JsonValueKind.Object) transcript.Title = Str(info, "title");
            if (!root.TryGetProperty("messages", out var messages) || messages.ValueKind != JsonValueKind.Array) return transcript;
            foreach (var message in messages.EnumerateArray())
            {
                if (message.ValueKind != JsonValueKind.Object) continue;
                string kind = FirstNonEmpty(Str(message, "type"), Str(message, "role"));
                if (kind == "user")
                {
                    transcript.AddUser(Str(message, "text"));
                    continue;
                }
                if (kind != "assistant") continue;
                if (message.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.Array)
                {
                    foreach (var item in content.EnumerateArray())
                    {
                        if (item.ValueKind != JsonValueKind.Object) continue;
                        string itemType = Str(item, "type");
                        string text = Str(item, "text");
                        if (itemType == "text" && text.Trim().Length > 0)
                        {
                            string id = transcript.NewId("text_");
                            transcript.Upsert(id, _ => new ChatEntry(id, ChatEntryKind.Text, text));
                        }
                        else if (itemType == "reasoning" && text.Trim().Length > 0)
                        {
                            string id = transcript.NewId("reasoning_");
                            double? duration = Duration(item, "created", "completed");
                            transcript.Upsert(id, _ => new ChatEntry(id, ChatEntryKind.Reasoning, text.Trim(), DurationSeconds: duration));
                        }
                        else if (itemType == "tool")
                        {
                            transcript.ApplyTool(item, transcript.NewId("tool_"));
                        }
                    }
                }
                if (message.TryGetProperty("tokens", out var tokens))
                {
                    long context = ContextTokensOf(tokens);
                    if (context > 0) transcript.ContextTokens = context;
                }
                if (message.TryGetProperty("cost", out var cost) && cost.ValueKind == JsonValueKind.Number) transcript.Cost += cost.GetDouble();
            }
        }
        return transcript;
    }

    private static string Str(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? ""
            : "";

    private static string FirstNonEmpty(params string[] values) => values.FirstOrDefault(value => value.Length > 0) ?? "";

    private static double? Duration(JsonElement element, string startKey, string endKey)
    {
        if (!element.TryGetProperty("time", out var time) || time.ValueKind != JsonValueKind.Object) return null;
        if (time.TryGetProperty(startKey, out var start) && start.ValueKind == JsonValueKind.Number
            && time.TryGetProperty(endKey, out var end) && end.ValueKind == JsonValueKind.Number
            && end.GetDouble() >= start.GetDouble())
        {
            return Math.Round((end.GetDouble() - start.GetDouble()) / 1000.0, 3);
        }
        return null;
    }

    private static long ContextTokensOf(JsonElement tokens)
    {
        if (tokens.ValueKind != JsonValueKind.Object) return 0;
        double total = 0;
        foreach (string key in new[] { "input", "output", "reasoning" })
        {
            if (tokens.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.Number) total += value.GetDouble();
        }
        if (tokens.TryGetProperty("cache", out var cache) && cache.ValueKind == JsonValueKind.Object)
        {
            foreach (string key in new[] { "read", "write" })
            {
                if (cache.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.Number) total += value.GetDouble();
            }
        }
        return (long)total;
    }

    private static string ErrorMessage(JsonElement root)
    {
        if (root.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.Object)
        {
            if (error.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Object && Str(data, "message").Length > 0) return Str(data, "message");
            return FirstNonEmpty(Str(error, "message"), Str(root, "message"), Str(error, "name"), "不明なエラー");
        }
        return FirstNonEmpty(Str(root, "message"), "不明なエラー");
    }

    private static string Indent(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            return JsonSerializer.Serialize(doc.RootElement, IndentedJson).Replace("\r\n", "\n");
        }
        catch (JsonException) { return json; }
    }

    private static string Truncate(string text, int limit) => text.Length <= limit ? text : text[..(limit - 1)] + "…";
}

/// <summary>チャット表示の書式（ツールの要約・見出し・時間・トークン数・相対時刻）と、CLI 出力の解析。</summary>
internal static class OpenCodeChatFormat
{
    private const int SummaryLimit = 80;
    private static readonly Regex ModelLine = new(@"^[A-Za-z0-9._-]+/\S+$", RegexOptions.Compiled);

    /// <summary>ツールカードの見出しに出す要約（パス・コマンド・検索語など）。80 文字で切る。</summary>
    public static string SummarizeTool(string tool, string inputJson, string title = "")
    {
        string name = (tool ?? "").ToLowerInvariant();
        JsonElement data = default;
        JsonDocument? doc = null;
        try
        {
            doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(inputJson) ? "{}" : inputJson);
            data = doc.RootElement;
        }
        catch (JsonException) { }
        try
        {
            string Text(string key) =>
                data.ValueKind == JsonValueKind.Object && data.TryGetProperty(key, out var value)
                    ? value.ValueKind switch
                    {
                        JsonValueKind.String => (value.GetString() ?? "").Trim(),
                        JsonValueKind.Number => value.GetRawText(),
                        _ => "",
                    }
                    : "";

            string summary = name switch
            {
                "read" or "write" or "edit" or "patch" or "list" or "multiedit" => FirstNonEmpty(Text("filePath"), Text("path")),
                "bash" => Text("command").Split('\n')[0],
                "grep" or "glob" => Text("pattern").Length > 0 && Text("path").Length > 0 ? $"{Text("pattern")} in {Text("path")}" : Text("pattern"),
                "webfetch" => Text("url"),
                "websearch" => Text("query"),
                "task" => Text("description"),
                "todowrite" => TodoSummary(data),
                _ => "",
            };
            if (summary.Length == 0)
            {
                string cleanedTitle = (title ?? "").Trim();
                if (cleanedTitle.Length > 0 && !cleanedTitle.Equals(name, StringComparison.OrdinalIgnoreCase)) summary = cleanedTitle;
            }
            if (summary.Length == 0 && data.ValueKind == JsonValueKind.Object)
            {
                summary = data.EnumerateObject()
                    .Where(property => property.Value.ValueKind == JsonValueKind.String && (property.Value.GetString() ?? "").Trim().Length > 0)
                    .Select(property => (property.Value.GetString() ?? "").Trim())
                    .FirstOrDefault() ?? "";
            }
            summary = summary.Split('\n')[0];
            return summary.Length <= SummaryLimit ? summary : summary[..(SummaryLimit - 1)] + "…";
        }
        finally
        {
            doc?.Dispose();
        }
    }

    private static string TodoSummary(JsonElement data)
    {
        if (data.ValueKind != JsonValueKind.Object || !data.TryGetProperty("todos", out var todos) || todos.ValueKind != JsonValueKind.Array) return "";
        int total = todos.GetArrayLength();
        int done = todos.EnumerateArray().Count(todo =>
            todo.ValueKind == JsonValueKind.Object && todo.TryGetProperty("status", out var status) && status.GetString() == "completed");
        return total > 0 ? $"Tasks {done}/{total}" : "";
    }

    private static string FirstNonEmpty(params string[] values) => values.FirstOrDefault(value => value.Length > 0) ?? "";

    /// <summary>ツールカードの見出し（✓ 完了 / ⏳ 実行中 / ✗ 失敗）。</summary>
    public static string ToolHeader(string tool, string status, string summary)
    {
        string icon = status switch { "completed" => "✓", "error" => "✗", _ => "⏳" };
        return summary.Length > 0 ? $"{icon} {tool}  {summary}" : $"{icon} {tool}";
    }

    /// <summary>経過時間（10 秒未満は小数 1 桁、1 分以上は「1分05秒」）。</summary>
    public static string FormatElapsed(double seconds)
    {
        double value = Math.Max(0, seconds);
        if (value < 10) return $"{value.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture)}秒";
        int total = (int)Math.Round(value, MidpointRounding.AwayFromZero);
        if (value < 60) return $"{total}秒";
        return $"{total / 60}分{total % 60:00}秒";
    }

    /// <summary>トークン数（950 / 10.7k / 1.3M）。</summary>
    public static string FormatTokens(long count)
    {
        var culture = System.Globalization.CultureInfo.InvariantCulture;
        if (count >= 1_000_000) return $"{(count / 1_000_000.0).ToString("0.0", culture)}M";
        if (count >= 1000) return $"{(count / 1000.0).ToString("0.0", culture)}k";
        return count.ToString(culture);
    }

    /// <summary>会話一覧の更新時刻（たった今 / n分前 / n時間前 / n日前）。</summary>
    public static string FormatRelativeTime(long updatedMs, long nowMs)
    {
        long seconds = Math.Max(0, (nowMs - updatedMs) / 1000);
        if (seconds < 60) return "たった今";
        if (seconds < 3600) return $"{seconds / 60}分前";
        if (seconds < 86400) return $"{seconds / 3600}時間前";
        return $"{seconds / 86400}日前";
    }

    /// <summary>opencode session list --format json の出力から会話一覧を読む。余計な出力は無視する。</summary>
    public static IReadOnlyList<OpenCodeSessionSummary> ParseSessionList(string stdout)
    {
        string text = stdout ?? "";
        for (int index = text.IndexOf('['); index >= 0; index = text.IndexOf('[', index + 1))
        {
            try
            {
                var reader = new Utf8JsonReader(System.Text.Encoding.UTF8.GetBytes(text[index..]), new JsonReaderOptions { AllowTrailingCommas = true });
                using var doc = JsonDocument.ParseValue(ref reader);
                if (doc.RootElement.ValueKind != JsonValueKind.Array) continue;
                var sessions = new List<OpenCodeSessionSummary>();
                foreach (var item in doc.RootElement.EnumerateArray())
                {
                    if (item.ValueKind != JsonValueKind.Object || !item.TryGetProperty("id", out var id) || id.ValueKind != JsonValueKind.String) continue;
                    string title = item.TryGetProperty("title", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() ?? "" : "";
                    long updated = item.TryGetProperty("updated", out var u) && u.ValueKind == JsonValueKind.Number ? (long)u.GetDouble() : 0;
                    sessions.Add(new OpenCodeSessionSummary(id.GetString() ?? "", title, updated));
                }
                return sessions;
            }
            catch (JsonException) { }
        }
        return [];
    }

    /// <summary>opencode models の出力から「プロバイダー/モデル」の行だけを取り出す。</summary>
    public static IReadOnlyList<string> ParseModelList(string stdout) =>
        (stdout ?? "").Split('\n').Select(line => line.Trim()).Where(line => ModelLine.IsMatch(line)).ToArray();
}

/// <summary>
/// 送った指示の履歴。↑（Previous）で新しい順に呼び出し、↓（Next）で戻る。最後まで戻ると呼び出し前の下書きを返し、
/// その次は null（呼び出し中でない）。連続する同じ指示はまとめ、上限を超えたら古いものから捨てる。
/// </summary>
internal sealed class PromptHistory(int limit = 50)
{
    private readonly List<string> _items = [];
    private int? _index;
    private string _draft = "";

    public IReadOnlyList<string> Items => _items;

    public void Add(string prompt)
    {
        string cleaned = (prompt ?? "").Trim();
        _index = null;
        if (cleaned.Length == 0 || (_items.Count > 0 && _items[^1] == cleaned)) return;
        _items.Add(cleaned);
        if (_items.Count > limit) _items.RemoveRange(0, _items.Count - limit);
    }

    public string? Previous(string currentDraft)
    {
        if (_items.Count == 0) return null;
        if (_index is null)
        {
            _draft = currentDraft ?? "";
            _index = _items.Count - 1;
        }
        else
        {
            _index = Math.Max(0, _index.Value - 1);
        }
        return _items[_index.Value];
    }

    public string? Next()
    {
        if (_index is null) return null;
        if (_index.Value >= _items.Count - 1)
        {
            _index = null;
            return _draft;
        }
        _index++;
        return _items[_index.Value];
    }
}

/// <summary>指示欄のキー操作の結果。</summary>
internal enum OpenCodeInputAction
{
    None,
    Submit,
    Newline,
    HistoryPrevious,
    HistoryNext,
    SuggestionPrevious,
    SuggestionNext,
    AcceptSuggestion,
    CloseSuggestions,
    CompleteSlash,
}

/// <summary>
/// 指示欄のキー操作を決める。Claudian と同じく Enter で送信・Shift+Enter で改行・↑↓で履歴。
/// スラッシュコマンドの候補表示中は ↑↓ で候補を選び、Tab / Enter で確定、Esc で閉じる（Obsidian と同じ）。
/// 候補が閉じていても「/」の語の中の Tab は補完する。それ以外の Tab / Esc はペイン移動・非表示に任せる（None）。
/// </summary>
internal static class OpenCodeInputKeys
{
    public static OpenCodeInputAction Decide(
        Key key,
        ModifierKeys modifiers,
        bool caretOnFirstLine,
        bool caretOnLastLine,
        bool suggestionsOpen = false,
        bool inSlashToken = false)
    {
        bool shift = modifiers.HasFlag(ModifierKeys.Shift);
        bool control = modifiers.HasFlag(ModifierKeys.Control);
        if (suggestionsOpen && modifiers == ModifierKeys.None)
        {
            switch (key)
            {
                case Key.Up: return OpenCodeInputAction.SuggestionPrevious;
                case Key.Down: return OpenCodeInputAction.SuggestionNext;
                case Key.Tab or Key.Enter or Key.Return: return OpenCodeInputAction.AcceptSuggestion;
                case Key.Escape: return OpenCodeInputAction.CloseSuggestions;
            }
        }
        if (key == Key.Tab && inSlashToken && modifiers == ModifierKeys.None) return OpenCodeInputAction.CompleteSlash;
        return key switch
        {
            Key.Enter or Key.Return when shift && !control => OpenCodeInputAction.Newline,
            Key.Enter or Key.Return => OpenCodeInputAction.Submit,
            Key.Up when caretOnFirstLine && modifiers == ModifierKeys.None => OpenCodeInputAction.HistoryPrevious,
            Key.Down when caretOnLastLine && modifiers == ModifierKeys.None => OpenCodeInputAction.HistoryNext,
            _ => OpenCodeInputAction.None,
        };
    }
}
