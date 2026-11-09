/**
 * OpenCode ペインのスラッシュコマンド（このアプリ独自の定型作業。/pass など）の展開・入力チェック・補完。
 * Python 版（launcher_app/slash_commands.py）と同じ約束で動く。
 *
 * 【仕様】
 * - コマンドは 名前・プロンプト・説明。保存はバックエンドの api/index/settings/launcher-slash-commands（一覧ごと）。
 * - 展開: 指示の最初の語が「/登録済みの名前」（大文字小文字を区別しない）なら、プロンプトへ置き換えて送る。
 *   プロンプト中の $ARGUMENTS は名前の後ろの文字に置き換え、無ければ後ろの文字があるときだけ空行のあとへ足す。
 *   登録の無い名前や /usr/bin のようなパスは展開しない。
 * - 登録の入力チェック: 名前（先頭の / は外す）が空・空白や / を含む・既存と重複、プロンプトが空はエラー。
 * - 補完（Obsidian と同じ操作）: 先頭が / でカーソルが最初の語の中にある間だけ候補を出す。前方一致 → 途中一致（それぞれ名前順）。
 *   上下で選び（端で回る）、Tab / Enter で「/名前 」に置き換えて確定、Esc で閉じる（文字が変わるまで開かない）。
 *   Tab は候補が 1 つならすぐ補完、複数なら候補を開く。
 **/
using System.Text.Json;
using System.Text.RegularExpressions;

namespace LocalSearchLauncher;

/// <summary>スラッシュコマンド 1 件。Name は先頭の / を含まない。</summary>
internal sealed record SlashCommand(string Name, string Prompt, string Description = "");

internal static class SlashCommands
{
    public const string ArgumentsPlaceholder = "$ARGUMENTS";
    private static readonly Regex FirstToken = new(@"^/(\S*)", RegexOptions.Compiled);

    /// <summary>前後の空白と先頭の / を外す。</summary>
    public static string NormalizeName(string name) => (name ?? "").Trim().TrimStart('/');

    /// <summary>API の {"commands": [...]} を読む。名前かプロンプトの無い項目・壊れた JSON は飛ばす。</summary>
    public static IReadOnlyList<SlashCommand> Parse(string json)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            var items = root.ValueKind == JsonValueKind.Object && root.TryGetProperty("commands", out var list) ? list : root;
            if (items.ValueKind != JsonValueKind.Array) return [];
            var commands = new List<SlashCommand>();
            foreach (var item in items.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.Object) continue;
                string name = NormalizeName(Str(item, "name"));
                string prompt = Str(item, "prompt").Trim();
                if (name.Length > 0 && prompt.Length > 0) commands.Add(new SlashCommand(name, prompt, Str(item, "description").Trim()));
            }
            return commands;
        }
        catch (JsonException) { return []; }
    }

    /// <summary>登録画面の入力チェック。問題があれば利用者向けの文言、無ければ null。</summary>
    public static string? Validate(string name, string prompt, IEnumerable<string> existingNames)
    {
        string cleaned = NormalizeName(name);
        if (cleaned.Length == 0) return "コマンド名を入力してください";
        if (cleaned.Any(ch => char.IsWhiteSpace(ch) || ch == '/')) return "コマンド名に空白や / は使えません";
        if (existingNames.Any(existing => string.Equals(NormalizeName(existing), cleaned, StringComparison.OrdinalIgnoreCase))) return $"/{cleaned} はすでに登録されています";
        if ((prompt ?? "").Trim().Length == 0) return "プロンプトを入力してください";
        return null;
    }

    /// <summary>「/名前 引数」を登録したプロンプトへ展開する。登録の無い名前・コマンドでない文字は null。</summary>
    public static string? Expand(string text, IReadOnlyList<SlashCommand> commands)
    {
        string raw = (text ?? "").Trim();
        var match = FirstToken.Match(raw);
        if (!match.Success || match.Groups[1].Value.Length == 0) return null;
        var command = commands.FirstOrDefault(c => string.Equals(c.Name, match.Groups[1].Value, StringComparison.OrdinalIgnoreCase));
        if (command is null) return null;
        string arguments = raw[match.Length..].Trim();
        if (command.Prompt.Contains(ArgumentsPlaceholder, StringComparison.Ordinal)) return command.Prompt.Replace(ArgumentsPlaceholder, arguments, StringComparison.Ordinal);
        return arguments.Length > 0 ? $"{command.Prompt}\n\n{arguments}" : command.Prompt;
    }

    /// <summary>先頭が / でカーソルが最初の語の中にあるとき、/ の後ろからカーソルまでの文字（検索語）。それ以外は null。</summary>
    public static string? Query(string text, int caret)
    {
        string before = (text ?? "")[..Math.Clamp(caret, 0, (text ?? "").Length)];
        if (!before.StartsWith('/') || before.Any(char.IsWhiteSpace)) return null;
        return before[1..];
    }

    /// <summary>前方一致（名前順）→ 途中一致（名前順）の候補。</summary>
    public static IReadOnlyList<SlashCommand> Candidates(IReadOnlyList<SlashCommand> commands, string query)
    {
        var ordered = commands.OrderBy(c => c.Name, StringComparer.OrdinalIgnoreCase).ToList();
        var prefix = ordered.Where(c => c.Name.StartsWith(query ?? "", StringComparison.OrdinalIgnoreCase)).ToList();
        var contains = ordered.Where(c => !prefix.Contains(c) && c.Name.Contains(query ?? "", StringComparison.OrdinalIgnoreCase));
        return [.. prefix, .. contains];
    }

    /// <summary>最初の語を「/名前 」に置き換え、(新しい文字, カーソル位置) を返す。後ろの文字は残す。</summary>
    public static (string Text, int Caret) ApplyCompletion(string text, int caret, string name)
    {
        string raw = text ?? "";
        var match = FirstToken.Match(raw);
        string rest = match.Success ? raw[match.Length..] : raw[Math.Clamp(caret, 0, raw.Length)..];
        string head = $"/{name}";
        return rest.Length > 0 && char.IsWhiteSpace(rest[0]) ? ($"{head}{rest}", head.Length + 1) : ($"{head} {rest}", head.Length + 1);
    }

    private static string Str(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : "";
}

/// <summary>指示欄の補完候補の表示状態（開閉・候補・選択位置）。</summary>
internal sealed class SlashSuggestions
{
    private string? _text;
    private string? _dismissedText;

    public IReadOnlyList<SlashCommand> Items { get; private set; } = [];
    public int Index { get; private set; }
    public bool IsOpen { get; private set; }
    public SlashCommand? Selected => IsOpen && Items.Count > 0 ? Items[Index] : null;

    /// <summary>入力が変わるたびに候補を作り直し、先頭を選ぶ。force は Esc で閉じた状態でも開く（Tab 用）。</summary>
    public void Refresh(string text, int caret, IReadOnlyList<SlashCommand> commands, bool force = false)
    {
        _text = text;
        string? query = SlashCommands.Query(text, caret);
        if (query is null)
        {
            IsOpen = false;
            _dismissedText = null;
            return;
        }
        if (!force && _dismissedText == text)
        {
            IsOpen = false;
            return;
        }
        _dismissedText = null;
        // 入力が変わったら先頭の候補を選び直す（Obsidian と同じ）
        Items = SlashCommands.Candidates(commands, query);
        Index = 0;
        IsOpen = Items.Count > 0;
    }

    /// <summary>選択を上下へ動かす（端で回る）。</summary>
    public void Move(int delta)
    {
        if (Items.Count > 0) Index = ((Index + delta) % Items.Count + Items.Count) % Items.Count;
    }

    /// <summary>選択中の候補で補完して閉じる。候補が無ければ null。</summary>
    public (string Text, int Caret)? Accept(string text, int caret)
    {
        var command = Selected;
        if (command is null) return null;
        IsOpen = false;
        return SlashCommands.ApplyCompletion(text, caret, command.Name);
    }

    /// <summary>Esc: 閉じて、文字が変わるまで開かない。</summary>
    public void Dismiss()
    {
        _dismissedText = _text;
        IsOpen = false;
    }

    /// <summary>Tab: 開いていれば選択中を確定。閉じていれば、候補 1 つは即補完、複数は開いて null。</summary>
    public (string Text, int Caret)? CompleteOnTab(string text, int caret, IReadOnlyList<SlashCommand> commands)
    {
        if (IsOpen) return Accept(text, caret);
        Refresh(text, caret, commands, force: true);
        return IsOpen && Items.Count == 1 ? Accept(text, caret) : null;
    }
}
