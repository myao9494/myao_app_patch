/**
 * WPF ランチャーのアプリ本体。単一プロセス・グローバルホットキー・ウィンドウの作り直しを管理する。
 *
 * 【仕様】
 * - 常時保持メモ（LauncherMemoStore）と opencode の会話（OpenCodeConversation）はアプリが 1 つずつ持つ。
 *   ウィンドウを閉じる前に未保存のメモを保存し、閉じても実行中の opencode とメモの保存を止めない。
 * - 起動時に共有設定（メモ・opencode 実行フォルダ）を読み込み、opencode の常駐サービスを温める。
 * - 終了時は未保存のメモを保存し（最大 3 秒待つ）、実行中の opencode を止める。
 **/
using System.Threading;
using System.Windows;

namespace LocalSearchLauncher;

/// <summary>単一プロセスとグローバルホットキーを管理する。</summary>
public partial class App : Application
{
    private readonly LauncherApiClient _sharedApi = new();
    private readonly LauncherServices _services;
    private Mutex? _mutex;
    private DoubleShiftHook? _doubleShift;
    private ModifierChordHook? _modifierChord;
    private string _hotkeyMode = "command_option";
    private MainWindow? _window;
    private LauncherWindowState _windowState = new();

    public App()
    {
        var memo = new LauncherMemoStore(text => _sharedApi.SaveLauncherMemoAsync(text), TimeSpan.FromMilliseconds(600));
        var conversation = new OpenCodeConversation(ProcessOpenCodeRunner.CreateDefault());
        _services = new LauncherServices(memo, conversation);
    }

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        _mutex = new Mutex(true, "LocalFulltextSearch.WpfLauncher", out var created);
        if (!created) { Shutdown(); return; }

        try
        {
            // start_windows.bat の自動起動時はAPIが待受を始める前なので、
            // 先に従来どおりShift 2回を有効にしてから保存済み設定を非同期で反映する。
            ApplyHotkeyMode("double_shift");
            _ = RestoreHotkeyModeAsync();
            _ = LoadSharedStateAsync();
            if (OpenCodeCommandBuilder.ResolveExecutable() is { } executable) ProcessOpenCodeRunner.WarmUpService(executable);
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "Local Search Launcher", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown(1);
        }
    }

    /// <summary>
    /// キーボードフックを止めないようUIスレッドへ非同期で渡し、
    /// 非表示後のウィンドウは破棄して次回ホットキー時の仮想デスクトップ上でHWNDを作り直す。
    /// </summary>
    private void ToggleWindow()
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(ToggleWindow);
            return;
        }

        if (_window is { IsVisible: true }) { HideAndDisposeWindow(); return; }
        HideAndDisposeWindow();
        _window = new MainWindow(HideAndDisposeWindow, _windowState, _hotkeyMode == "double_shift" ? "Shift × 2" : "Windows + Alt", _services);
        _window.ShowAndActivate();
    }

    /// <summary>APIの起動完了後に保存済みのホットキー方式を反映する。</summary>
    private async Task RestoreHotkeyModeAsync()
    {
        for (var attempt = 0; attempt < 5; attempt++)
        {
            try
            {
                using var api = new LauncherApiClient();
                var mode = await api.GetLauncherHotkeyAsync();
                await Dispatcher.InvokeAsync(() => ApplyHotkeyMode(mode));
                return;
            }
            catch when (attempt < 4)
            {
                await Task.Delay(TimeSpan.FromMilliseconds(300));
            }
            catch
            {
                // API未起動時も、起動直後に設定したShift 2回で操作を継続できる。
            }
        }
    }

    /// <summary>APIの起動完了を待って、常時保持メモと opencode 実行フォルダを読み込む。</summary>
    private async Task LoadSharedStateAsync()
    {
        for (var attempt = 0; attempt < 10; attempt++)
        {
            try
            {
                var shared = await _sharedApi.GetSharedSettingsAsync(0, "");
                _services.OpenCode.SetWorkingDir(shared.OpenCodeWorkingDir);
                if (shared.HasLauncherMemo) _services.Memo.Load(shared.LauncherMemo);
                await LoadSlashCommandsAsync();
                return;
            }
            catch (Exception error) when (error is System.Net.Http.HttpRequestException or TaskCanceledException or System.Text.Json.JsonException)
            {
                await Task.Delay(TimeSpan.FromSeconds(1));
            }
        }
    }

    /// <summary>OpenCode ペインの独自スラッシュコマンドを読む（古いバックエンドで API が無くても止めない）。</summary>
    private async Task LoadSlashCommandsAsync()
    {
        try
        {
            _services.OpenCode.SlashCommands = await _sharedApi.GetSlashCommandsAsync();
        }
        catch (Exception error) when (error is System.Net.Http.HttpRequestException or TaskCanceledException)
        {
            // 読めなければ登録なしのまま使う
        }
    }

    /// <summary>現在のフックを切り替え、設定されたホットキー方式だけを監視する。</summary>
    private void ApplyHotkeyMode(string mode)
    {
        var normalized = mode == "command_option" ? "command_option" : "double_shift";
        if (_hotkeyMode == normalized && (_doubleShift is not null || _modifierChord is not null)) return;
        _doubleShift?.Dispose();
        _modifierChord?.Dispose();
        _doubleShift = null;
        _modifierChord = null;
        _hotkeyMode = normalized;
        if (_hotkeyMode == "double_shift")
        {
            _doubleShift = new DoubleShiftHook(ToggleWindow);
            _doubleShift.Start();
        }
        else
        {
            _modifierChord = new ModifierChordHook(ToggleWindow);
            _modifierChord.Start();
        }
    }

    private void HideAndDisposeWindow()
    {
        if (_window is null) return;
        // 閉じるウィンドウとは別のアプリ側クライアントで保存するため、ウィンドウを破棄しても保存は中断されない
        _ = _services.Memo.FlushAsync();
        var old = _window;
        _windowState = old.CaptureState();
        _window = null;
        old.AllowClose = true;
        old.Close();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _doubleShift?.Dispose();
        _modifierChord?.Dispose();
        try { _services.Memo.FlushAsync().Wait(TimeSpan.FromSeconds(3)); }
        catch (AggregateException) { }
        _services.OpenCode.Cancel();
        _services.Memo.Dispose();
        _sharedApi.Dispose();
        _mutex?.Dispose();
        base.OnExit(e);
    }
}
