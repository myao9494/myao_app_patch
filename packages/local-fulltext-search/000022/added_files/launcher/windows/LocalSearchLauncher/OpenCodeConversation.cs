/**
 * WPF ランチャーの OpenCode CLI ペインの会話とプロセス実行。
 *
 * 【仕様】
 * - OpenCodeConversation はアプリ（App）が 1 つだけ持ち、ウィンドウを閉じても実行中の opencode とチャット表示（Transcript）を保持する。
 *   ウィンドウは Changed イベントで画面を更新し、再表示時は現在の会話・状態を表示する。
 * - 作業フォルダが未設定・存在しないときは opencode を起動しない（別のフォルダで代わりに動かさない）。
 * - 1 回目の出力に含まれる sessionID を覚え、2 回目以降は --session で同じ会話を続ける。ID が取れない成功時は --continue。
 * - 送信時に Model（--model）・PlanMode（--agent plan）・AutoApprove（--auto）を渡し、常に --thinking で思考も受け取る。
 * - 同時に 2 つの opencode は走らせない。実行中に送った指示は待ち行列（Queue）へ入れ、今の実行が終わったら順に送る。
 *   Cancel()（停止）は実行中の opencode を止め、待ち行列も捨てる。Reset()（新規）はさらに表示と会話IDを消す。
 * - 結果のお知らせ: 中断「中断しました」、タイムアウト「タイムアウトしたため停止しました」、
 *   失敗「opencode 実行失敗（exit n）: 標準エラー」、応答が空「（応答なし）」。
 * - StatusText(): 実行中は「作業中… 12秒」（待ち行列があれば「 · 待機 n件」）、終わったら「完了（2.0秒）」など。
 * - 会話一覧は session list --format json -n 20、過去の会話の読み込みは session export <ID>、モデル一覧は models（作業フォルダで実行）。
 * - ProcessOpenCodeRunner は標準出力と標準エラーを並行して読み、タイムアウトで止める。cmd.exe は経由しない。
 * - 登録したスラッシュコマンド（SlashCommands）は送る直前にプロンプトへ展開する。吹き出しと指示の履歴には打った文字を残す。
 **/
using System.Diagnostics;
using System.IO;
using System.Text;

namespace LocalSearchLauncher;

/// <summary>opencode プロセス 1 回分の終了状態。</summary>
internal sealed record OpenCodeRunResult(int ExitCode, string Stderr, bool TimedOut = false, bool Cancelled = false);

/// <summary>短い問い合わせ（会話一覧・会話の書き出し・モデル一覧）の結果。</summary>
internal sealed record OpenCodeCaptureResult(int ExitCode, string Stdout, string Stderr);

/// <summary>opencode を起動し、標準出力を 1 行ずつ渡す部品。</summary>
internal interface IOpenCodeProcessRunner
{
    Task<OpenCodeRunResult> RunAsync(string workingDir, IReadOnlyList<string> args, Action<string> onLine, CancellationToken cancellationToken);

    Task<OpenCodeCaptureResult> CaptureAsync(string workingDir, IReadOnlyList<string> args, CancellationToken cancellationToken);
}

/// <summary>opencode を実行できない理由（実行ファイルなし等）。</summary>
internal sealed class OpenCodeException(string message) : Exception(message);

/// <summary>opencode.exe をサブプロセスで実行する既定のランナー。</summary>
internal sealed class ProcessOpenCodeRunner(Func<string?> executableResolver, TimeSpan timeout, bool warmUp = true) : IOpenCodeProcessRunner
{
    private static readonly TimeSpan CaptureTimeout = TimeSpan.FromSeconds(60);
    private static int _serviceWarmupStarted;

    public static ProcessOpenCodeRunner CreateDefault() =>
        new(OpenCodeCommandBuilder.ResolveExecutable, TimeSpan.FromMinutes(15));

    /// <summary>opencode の常駐サービス（opencode service start）を裏で 1 度だけ起動する。</summary>
    public static void WarmUpService(string executable)
    {
        if (Interlocked.Exchange(ref _serviceWarmupStarted, 1) != 0) return;
        _ = Task.Run(() =>
        {
            try
            {
                var startInfo = new ProcessStartInfo(executable)
                {
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true,
                };
                startInfo.ArgumentList.Add("service");
                startInfo.ArgumentList.Add("start");
                using var process = Process.Start(startInfo);
                process?.WaitForExit(15000);
            }
            catch (Exception error) when (error is System.ComponentModel.Win32Exception or InvalidOperationException or IOException)
            {
                // 常駐サービスを起動できなくても opencode run 単体は動く
            }
        });
    }

    private ProcessStartInfo CreateStartInfo(string workingDir, IReadOnlyList<string> args)
    {
        string executable = executableResolver()
            ?? throw new OpenCodeException("opencode が見つかりません（opencode.exe をインストールしてください）");
        if (warmUp) WarmUpService(executable);
        var startInfo = new ProcessStartInfo(executable)
        {
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        if (!string.IsNullOrWhiteSpace(workingDir)) startInfo.WorkingDirectory = workingDir;
        foreach (string arg in args) startInfo.ArgumentList.Add(arg);
        return startInfo;
    }

    public async Task<OpenCodeRunResult> RunAsync(string workingDir, IReadOnlyList<string> args, Action<string> onLine, CancellationToken cancellationToken)
    {
        using var process = new Process { StartInfo = CreateStartInfo(workingDir, args) };
        process.Start();
        process.StandardInput.Close();
        using var timeoutSource = new CancellationTokenSource(timeout);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeoutSource.Token);
        using var killOnCancel = linked.Token.Register(() => Kill(process));

        Task<string> stderrTask = process.StandardError.ReadToEndAsync();
        while (await process.StandardOutput.ReadLineAsync() is { } line)
        {
            onLine(line);
        }
        await process.WaitForExitAsync(CancellationToken.None);
        string stderr = OpenCodeCommandBuilder.StripAnsi(await stderrTask).Trim();
        return new OpenCodeRunResult(
            process.ExitCode,
            stderr,
            TimedOut: timeoutSource.IsCancellationRequested,
            Cancelled: cancellationToken.IsCancellationRequested);
    }

    public async Task<OpenCodeCaptureResult> CaptureAsync(string workingDir, IReadOnlyList<string> args, CancellationToken cancellationToken)
    {
        using var process = new Process { StartInfo = CreateStartInfo(workingDir, args) };
        process.Start();
        process.StandardInput.Close();
        using var timeoutSource = new CancellationTokenSource(CaptureTimeout);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeoutSource.Token);
        using var killOnCancel = linked.Token.Register(() => Kill(process));
        Task<string> stdoutTask = process.StandardOutput.ReadToEndAsync();
        Task<string> stderrTask = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync(CancellationToken.None);
        string stdout = await stdoutTask;
        string stderr = OpenCodeCommandBuilder.StripAnsi(await stderrTask).Trim();
        return timeoutSource.IsCancellationRequested
            ? new OpenCodeCaptureResult(-1, "", "タイムアウトしました")
            : new OpenCodeCaptureResult(process.ExitCode, stdout, stderr);
    }

    private static void Kill(Process process)
    {
        try { process.Kill(entireProcessTree: true); }
        catch (InvalidOperationException) { }
    }
}

/// <summary>OpenCode ペインの作業フォルダ・会話ID・チャット表示・待ち行列・実行状態を、ウィンドウより長く保持する。</summary>
internal sealed class OpenCodeConversation(IOpenCodeProcessRunner runner, Func<string, bool>? directoryExists = null, Func<DateTimeOffset>? clock = null)
{
    private const int SessionListLimit = 20;
    private readonly Func<string, bool> _directoryExists = directoryExists ?? Directory.Exists;
    private readonly Func<DateTimeOffset> _clock = clock ?? (() => DateTimeOffset.Now);
    private readonly object _lock = new();
    private readonly List<string> _queue = [];
    private CancellationTokenSource? _running;
    private DateTimeOffset? _startedAt;
    private int _generation;

    public string WorkingDir { get; private set; } = "";
    public ChatTranscript Transcript { get; } = new();
    public PromptHistory History { get; } = new();
    public string Status { get; private set; } = "";
    public string? SessionId { get; private set; }
    public bool HasConversation { get; private set; }
    public bool IsRunning
    {
        get { lock (_lock) return _running is not null; }
    }

    public string? Model { get; set; }
    /// <summary>このアプリ独自のスラッシュコマンド（/pass など）。バックエンドから読み、登録画面で書き換える。</summary>
    public IReadOnlyList<SlashCommand> SlashCommands { get; set; } = [];
    public bool PlanMode { get; set; }
    public bool AutoApprove { get; set; }

    public IReadOnlyList<string> Queue
    {
        get { lock (_lock) return _queue.ToArray(); }
    }

    /// <summary>表示・状態が変わったときに通知する（呼び出し元のスレッドは問わない）。</summary>
    public event Action? Changed;

    /// <summary>実行中は「作業中… 12秒 · 待機 1件」、それ以外は直近の結果。</summary>
    public string StatusText()
    {
        DateTimeOffset? started;
        int waiting;
        lock (_lock)
        {
            started = _running is not null ? _startedAt : null;
            waiting = _queue.Count;
        }
        if (started is null) return Status;
        string text = $"作業中… {OpenCodeChatFormat.FormatElapsed((_clock() - started.Value).TotalSeconds)}";
        return waiting > 0 ? $"{text} · 待機 {waiting}件" : text;
    }

    /// <summary>作業フォルダを変える。変わったら新規会話へ戻す。</summary>
    public void SetWorkingDir(string workingDir)
    {
        string normalized = (workingDir ?? "").Trim();
        if (string.Equals(normalized, WorkingDir, StringComparison.OrdinalIgnoreCase)) return;
        WorkingDir = normalized;
        SessionId = null;
        HasConversation = false;
        Changed?.Invoke();
    }

    private string? WorkingDirProblem()
    {
        if (WorkingDir.Length == 0) return "opencode 実行フォルダが未設定です（ランチャーの ☰ メニューか Web の設定で指定してください）";
        if (!_directoryExists(WorkingDir)) return $"opencode 実行フォルダが見つかりません: {WorkingDir}";
        return null;
    }

    /// <summary>
    /// 指示を送る。受け付けなかった（空・未設定・フォルダなし）ときは false。
    /// 実行中なら待ち行列へ入れて true を返す。実行した場合は、待ち行列の指示も順に送ってから終わる。
    /// </summary>
    public async Task<bool> SendAsync(string prompt)
    {
        string cleaned = (prompt ?? "").Trim();
        if (cleaned.Length == 0) return SetStatus("指示を入力してください");
        if (WorkingDirProblem() is { } problem) return SetStatus(problem);

        lock (_lock)
        {
            if (_running is not null)
            {
                _queue.Add(cleaned);
                cleaned = "";
            }
            else
            {
                _running = new CancellationTokenSource();
            }
        }
        if (cleaned.Length == 0)
        {
            Changed?.Invoke();
            return true;
        }

        try
        {
            string? next = cleaned;
            while (next is not null)
            {
                await RunOnceAsync(next);
                lock (_lock)
                {
                    if (_queue.Count > 0)
                    {
                        next = _queue[0];
                        _queue.RemoveAt(0);
                        _running?.Dispose();
                        _running = new CancellationTokenSource();
                    }
                    else
                    {
                        next = null;
                    }
                }
            }
        }
        finally
        {
            lock (_lock)
            {
                _running?.Dispose();
                _running = null;
                _startedAt = null;
            }
            Changed?.Invoke();
        }
        return true;
    }

    /// <summary>1 回分の実行と、結果のお知らせ。</summary>
    private async Task RunOnceAsync(string prompt)
    {
        CancellationToken token;
        int generation;
        DateTimeOffset started = _clock();
        lock (_lock)
        {
            token = _running!.Token;
            generation = _generation;
            _startedAt = started;
        }
        History.Add(prompt);
        Transcript.AddUser(prompt);
        int shownBefore = Transcript.Snapshot().Count;
        string toSend = LocalSearchLauncher.SlashCommands.Expand(prompt, SlashCommands) ?? prompt;
        var args = OpenCodeCommandBuilder.BuildArguments(toSend, SessionId, HasConversation, Model, PlanMode, AutoApprove);
        string? capturedSession = null;
        Changed?.Invoke();
        try
        {
            var result = await runner.RunAsync(WorkingDir, args, line =>
            {
                capturedSession ??= OpenCodeCommandBuilder.ExtractSessionId(line);
                bool current;
                lock (_lock) current = generation == _generation;
                if (current && Transcript.ApplyLine(line)) Changed?.Invoke();
            }, token);

            lock (_lock)
            {
                if (generation != _generation) return;
            }
            double elapsed = (_clock() - started).TotalSeconds;
            if (result.Cancelled)
            {
                Transcript.AddNotice("中断しました");
                Status = "中断しました";
            }
            else if (result.TimedOut)
            {
                Transcript.AddNotice("タイムアウトしたため停止しました", error: true);
                Status = "タイムアウトしました";
            }
            else if (result.ExitCode != 0)
            {
                string detail = result.Stderr.Length > 0 ? $": {result.Stderr}" : "";
                Transcript.AddNotice($"opencode 実行失敗（exit {result.ExitCode}）{detail}", error: true);
                Status = $"opencode 実行失敗（exit {result.ExitCode}）";
            }
            else
            {
                if (!Transcript.Snapshot().Skip(shownBefore).Any(entry => entry.Kind is ChatEntryKind.Text or ChatEntryKind.Tool))
                {
                    Transcript.AddNotice("（応答なし）");
                }
                Status = $"完了（{OpenCodeChatFormat.FormatElapsed(elapsed)}）";
            }
            if (capturedSession is not null)
            {
                SessionId = capturedSession;
                HasConversation = true;
            }
            else if (result.ExitCode == 0 && !result.Cancelled && !result.TimedOut)
            {
                HasConversation = true;
            }
        }
        catch (Exception error) when (error is OpenCodeException or System.ComponentModel.Win32Exception or InvalidOperationException or IOException)
        {
            Transcript.AddNotice(error.Message, error: true);
            Status = $"opencode 実行失敗: {error.Message}";
        }
    }

    /// <summary>実行中の opencode を止め、待ち行列を捨てる。</summary>
    public void Cancel()
    {
        lock (_lock)
        {
            _queue.Clear();
            try { _running?.Cancel(); }
            catch (ObjectDisposedException) { }
        }
        Changed?.Invoke();
    }

    /// <summary>実行中なら止め、待ち行列・表示・会話IDを消して新規会話へ戻す。</summary>
    public void Reset()
    {
        lock (_lock)
        {
            _generation++;
            _queue.Clear();
            try { _running?.Cancel(); }
            catch (ObjectDisposedException) { }
        }
        SessionId = null;
        HasConversation = false;
        Transcript.Clear();
        Status = "新しい会話を開始します";
        Changed?.Invoke();
    }

    /// <summary>作業フォルダの会話一覧（新しい順）。取れなければ空。</summary>
    public async Task<IReadOnlyList<OpenCodeSessionSummary>> ListSessionsAsync()
    {
        if (WorkingDirProblem() is not null) return [];
        try
        {
            var result = await runner.CaptureAsync(WorkingDir, ["session", "list", "--format", "json", "-n", SessionListLimit.ToString()], CancellationToken.None);
            return result.ExitCode == 0 ? OpenCodeChatFormat.ParseSessionList(result.Stdout) : [];
        }
        catch (Exception error) when (error is OpenCodeException or System.ComponentModel.Win32Exception or InvalidOperationException or IOException)
        {
            return [];
        }
    }

    /// <summary>過去の会話を読み込み、その会話IDで続ける。実行中・読み込み失敗は false（今の会話は残す）。</summary>
    public async Task<bool> ResumeAsync(string sessionId)
    {
        if (WorkingDirProblem() is { } problem) return SetStatus(problem);
        if (IsRunning) return SetStatus("opencode 実行中は会話を切り替えられません");
        OpenCodeCaptureResult result;
        try
        {
            result = await runner.CaptureAsync(WorkingDir, ["session", "export", sessionId], CancellationToken.None);
        }
        catch (Exception error) when (error is OpenCodeException or System.ComponentModel.Win32Exception or InvalidOperationException or IOException)
        {
            return SetStatus($"会話を読み込めません: {error.Message}");
        }
        int start = result.Stdout.IndexOf('{');
        if (result.ExitCode != 0 || start < 0) return SetStatus($"会話を読み込めません: {(result.Stderr.Length > 0 ? result.Stderr : sessionId)}");
        var restored = ChatTranscript.FromExport(result.Stdout[start..]);
        lock (_lock) _generation++;
        Transcript.ReplaceWith(restored);
        SessionId = sessionId;
        HasConversation = true;
        Status = $"会話を再開しました: {(restored.Title.Length > 0 ? restored.Title : sessionId)}";
        Changed?.Invoke();
        return true;
    }

    /// <summary>使えるモデルの一覧（opencode models）。取れなければ空。</summary>
    public async Task<IReadOnlyList<string>> ListModelsAsync()
    {
        try
        {
            string dir = WorkingDirProblem() is null ? WorkingDir : "";
            var result = await runner.CaptureAsync(dir, ["models"], CancellationToken.None);
            return result.ExitCode == 0 ? OpenCodeChatFormat.ParseModelList(result.Stdout) : [];
        }
        catch (Exception error) when (error is OpenCodeException or System.ComponentModel.Win32Exception or InvalidOperationException or IOException)
        {
            return [];
        }
    }

    private bool SetStatus(string status)
    {
        Status = status;
        Changed?.Invoke();
        return false;
    }
}
