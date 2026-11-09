/**
 * Windows WPF ランチャーの1ページ4ペイン（左上: 検索、右上: OpenCode CLI、左下: 常時保持メモ、右下: gantt メモ）のウィンドウ制御。
 *
 * 【仕様】
 * - 非表示のたびにウィンドウを破棄して作り直す（仮想デスクトップ対応）。入力途中の文字は LauncherWindowState で引き継ぐ。
 * - opencode の会話（OpenCodeConversation）と常時保持メモ（LauncherMemoStore）はアプリ側が持つ。
 *   ウィンドウはそれらの Changed を購読して画面を更新し、閉じるときに購読を外す。
 *   このためウィンドウを閉じても、実行中の opencode とメモの保存は止まらない。
 * - Escape はどのペインからでもランチャーを隠す（未保存のメモはアプリ側が閉じる前に保存する）。
 * - OpenCode ペインは Claudian 風のチャット（OpenCodeChatView）。指示欄は Enter で送信・Shift+Enter で改行・↑↓で過去の指示。
 *   実行中の送信は待ち行列へ入り、送信ボタンは「停止」になる。履歴（過去の会話の再開）・新規・モデル・Plan・自動承認を持ち、
 *   下端に作業状況（経過時間）と使用量を出す。モデル一覧はアプリ起動中 1 度だけ取る。
 * - スラッシュコマンド（このアプリ独自の定型作業）: 「/ コマンド」で登録画面（SlashCommandsWindow）を開く。
 *   指示欄で / を打つと候補（SlashPopup）を出し、↑↓で選択・Tab / Enter で確定・Esc で閉じる（Obsidian と同じ）。
 *   指示欄のキーはペイン移動（Tab）・非表示（Esc）より先に OpenCodeInputKeys で判定する。
 **/
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Threading;

namespace LocalSearchLauncher;

/// <summary>アプリ全体で 1 つずつ持ち、ウィンドウを作り直しても引き継ぐ部品。</summary>
internal sealed record LauncherServices(LauncherMemoStore Memo, OpenCodeConversation OpenCode);

/// <summary>1ページ4ペイン（検索・OpenCode CLI・常時保持メモ・ganttメモ）を提供する。</summary>
public partial class MainWindow : Window
{
    private readonly LauncherApiClient _api = new();
    private readonly Action _hide;
    private readonly LauncherServices _services;
    private readonly DispatcherTimer _debounce = new() { Interval = TimeSpan.FromMilliseconds(180) };
    private CancellationTokenSource? _searchCancellation;
    private readonly DispatcherTimer _openCodeTicker = new() { Interval = TimeSpan.FromSeconds(1) };
    private readonly OpenCodeChatView _chatView;
    private static IReadOnlyList<string>? s_openCodeModels;
    private int _ganttParent = ReadNonNegativeInt("LAUNCHER_GANTT_PARENT", 0);
    private bool _suppressScratchpadEvent;
    private bool _suppressModelEvent;
    private readonly SlashSuggestions _slash = new();
    private bool _suppressSlashRefresh;
    private (string Text, int Caret)? _lastSlashInput;
    internal bool AllowClose { get; set; }
    private string SelectedSearchType =>
        (SearchTypeCombo?.SelectedItem as ComboBoxItem)?.Tag as string ?? "hybrid";

    /// <summary>ウィンドウを作り直しても入力途中の文字と検索条件を引き継ぐための画面状態を返す。</summary>
    internal LauncherWindowState CaptureState() => new(
        Query: QueryBox.Text,
        ExtensionFilter: ExtensionBox.Text,
        MemoTitle: MemoTitle.Text,
        MemoBody: MemoBody.Text,
        IncludeGantt: GanttCheck.IsChecked == true,
        UpdateIndexOnSearch: UpdateIndexCheck.IsChecked == true,
        SearchType: SelectedSearchType,
        IncludePathInFilename: PathInFilenameCheck.IsChecked == true,
        OpenCodePrompt: OpenCodeInput.Text
    );

    internal MainWindow(Action hide, LauncherWindowState state, string hotkeyDisplayName, LauncherServices services)
    {
        InitializeComponent();
        _hide = hide;
        _services = services;
        _debounce.Tick += async (_, _) => { _debounce.Stop(); await SearchAsync(); };
        Closing += (_, e) =>
        {
            if (!AllowClose)
            {
                e.Cancel = true;
                _hide();
            }
        };

        QueryBox.Text = state.Query;
        ExtensionBox.Text = state.ExtensionFilter;
        MemoTitle.Text = state.MemoTitle;
        MemoBody.Text = state.MemoBody;
        GanttCheck.IsChecked = state.IncludeGantt;
        UpdateIndexCheck.IsChecked = state.UpdateIndexOnSearch;
        PathInFilenameCheck.IsChecked = state.IncludePathInFilename;
        OpenCodeInput.Text = state.OpenCodePrompt;

        foreach (ComboBoxItem item in SearchTypeCombo.Items)
        {
            if ((string)item.Tag == state.SearchType)
            {
                SearchTypeCombo.SelectedItem = item;
                break;
            }
        }
        Status.Text = $"{hotkeyDisplayName}　Tabで4ペイン移動　Escで閉じる";
        ParentLabel.Text = $"parent: {_ganttParent}";

        _chatView = new OpenCodeChatView(OpenCodeChatPanel, OpenCodeChatScroll, ToggleOpenCodeEntry, CopyOpenCodeEntry);
        OpenCodePlanCheck.IsChecked = _services.OpenCode.PlanMode;
        OpenCodeAutoCheck.IsChecked = _services.OpenCode.AutoApprove;
        FillOpenCodeModels(s_openCodeModels ?? []);
        _openCodeTicker.Tick += (_, _) => RenderOpenCodeStatus();
        // 指示欄からフォーカスが外れたら補完の候補を隠す
        OpenCodeInput.LostKeyboardFocus += (_, _) => SlashPopup.IsOpen = false;
        _openCodeTicker.Start();

        RenderMemo();
        RenderOpenCode();
        _services.Memo.Changed += OnMemoChanged;
        _services.OpenCode.Changed += OnOpenCodeChanged;
        if (s_openCodeModels is null || s_openCodeModels.Count == 0) _ = LoadOpenCodeModelsAsync();
    }

    internal void ShowAndActivate()
    {
        Show();
        var handle = new WindowInteropHelper(this).Handle;
        ShowWindow(handle, 9);
        SetForegroundWindow(handle);
        Activate();
        FocusActiveView();
        _ = RefreshSharedSettingsAsync();
        // WPFが描画・前面化を完了した後にも再指定し、直後の文字入力を検索欄で受け取る。
        Dispatcher.BeginInvoke(new Action(FocusActiveView), DispatcherPriority.ApplicationIdle);
    }

    private void FocusActiveView()
    {
        Keyboard.Focus(QueryBox);
        QueryBox.SelectAll();
    }

    private void HideLauncherWindow() => _hide();

    private void QueryBox_TextChanged(object sender, TextChangedEventArgs e)
    {
        // 前回の検索結果を新しい検索語で誤って開かないよう選択を解除する。
        Results.SelectedIndex = -1;
        _debounce.Stop();
        _debounce.Start();
    }

    private void ScratchpadBox_TextChanged(object sender, TextChangedEventArgs e)
    {
        if (_suppressScratchpadEvent) return;
        _services.Memo.Update(ScratchpadBox.Text);
    }

    /// <summary>メモの保存状態（保存タイマーのスレッドからも届く）を UI スレッドで表示する。</summary>
    private void OnMemoChanged() => Dispatcher.BeginInvoke(RenderMemo);

    private void RenderMemo()
    {
        var memo = _services.Memo;
        if (!ScratchpadBox.IsKeyboardFocusWithin && ScratchpadBox.Text != memo.Text)
        {
            _suppressScratchpadEvent = true;
            ScratchpadBox.Text = memo.Text;
            _suppressScratchpadEvent = false;
        }
        ScratchpadStatus.Text = memo.Status;
    }

    /// <summary>上部の専用ドラッグ領域で、検索ウィンドウを任意の場所へ移動する。</summary>
    private void WindowDragHandle_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (!WindowDragPolicy.CanStartDrag(e.ChangedButton, e.ButtonState)) return;
        try { DragMove(); }
        catch (InvalidOperationException) { }
    }

    private async Task SearchAsync()
    {
        var query = QueryBox.Text.Trim();
        if (query.Length == 0) { Results.ItemsSource = null; Status.Text = "検索語を入力してください　Tabで4ペイン移動"; return; }
        _searchCancellation?.Cancel();
        _searchCancellation?.Dispose();
        _searchCancellation = new CancellationTokenSource();
        // 次の検索が取り消して破棄しても判定できるよう、この検索のトークンを保持する。
        var token = _searchCancellation.Token;
        try
        {
            Status.Text = "検索中…";
            var limit = ReadNonNegativeInt("LAUNCHER_SEARCH_LIMIT", 8);
            var response = await _api.SearchAsync(query, Math.Max(1, limit), GanttCheck.IsChecked == true, ExtensionBox.Text.Trim(), UpdateIndexCheck.IsChecked == true, token, SelectedSearchType, PathInFilenameCheck.IsChecked == true);
            Results.ItemsSource = response.Items;
            Results.SelectedIndex = response.Items.Count > 0 ? 0 : -1;
            Status.Text = response.BackgroundRefreshScheduled
                ? $"{response.Total} 件　差分更新をバックグラウンド開始"
                : $"{response.Total} 件　Enterで開く　Tabで4ペイン移動";
        }
        catch (Exception error)
        {
            if (LauncherSearchFailure.StatusText(error, token, _api.RequestTimeout) is { } message) Status.Text = message;
        }
    }

    private void SearchTypeCombo_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (IsLoaded)
        {
            _debounce.Stop();
            _debounce.Start();
            QueryBox.Focus();
        }
    }

    private void GanttCheck_Click(object sender, RoutedEventArgs e)
    { _debounce.Stop(); _debounce.Start(); QueryBox.Focus(); }

    private void PathInFilenameCheck_Click(object sender, RoutedEventArgs e)
    { _debounce.Stop(); _debounce.Start(); QueryBox.Focus(); }

    private void UpdateIndexCheck_Click(object sender, RoutedEventArgs e)
    { _debounce.Stop(); _debounce.Start(); QueryBox.Focus(); }

    private bool IsNonSearchPaneFocused() =>
        MemoTitle.IsKeyboardFocusWithin
        || MemoBody.IsKeyboardFocusWithin
        || MemoSubmit.IsKeyboardFocusWithin
        || MemoCancel.IsKeyboardFocusWithin
        || ScratchpadBox.IsKeyboardFocusWithin
        || OpenCodeInput.IsKeyboardFocusWithin
        || OpenCodeChatScroll.IsKeyboardFocusWithin
        || OpenCodeSubmit.IsKeyboardFocusWithin
        || OpenCodeNewChat.IsKeyboardFocusWithin
        || OpenCodeHistoryButton.IsKeyboardFocusWithin
        || OpenCodeModelCombo.IsKeyboardFocusWithin
        || OpenCodePlanCheck.IsKeyboardFocusWithin
        || OpenCodeAutoCheck.IsKeyboardFocusWithin;

    private void Window_PreviewKeyDown(object sender, KeyEventArgs e)
    {
        if (OpenCodeInput.IsKeyboardFocusWithin && HandleOpenCodeInputKey(e))
        {
            e.Handled = true;
            return;
        }
        if (e.Key == Key.Escape)
        {
            e.Handled = true;
            HideLauncherWindow();
            return;
        }
        if (e.Key == Key.Tab)
        {
            e.Handled = true;
            MoveTabFocus(Keyboard.Modifiers.HasFlag(ModifierKeys.Shift));
            return;
        }
        if (!IsNonSearchPaneFocused() && e.Key is Key.Down or Key.Up)
        {
            e.Handled = true;
            MoveSelection(e.Key == Key.Down ? 1 : -1);
            return;
        }
        if (e.Key == Key.Return)
        {
            bool hasCtrl = Keyboard.Modifiers.HasFlag(ModifierKeys.Control);
            if (hasCtrl && (MemoTitle.IsKeyboardFocusWithin || MemoBody.IsKeyboardFocusWithin))
            {
                e.Handled = true;
                MemoSubmit_Click(MemoSubmit, new RoutedEventArgs());
                return;
            }
            if (MemoSubmit.IsKeyboardFocusWithin)
            {
                e.Handled = true;
                MemoSubmit_Click(MemoSubmit, new RoutedEventArgs());
                return;
            }
            if (OpenCodeSubmit.IsKeyboardFocusWithin)
            {
                e.Handled = true;
                OpenCodeSubmit_Click(OpenCodeSubmit, new RoutedEventArgs());
                return;
            }
            if (MemoCancel.IsKeyboardFocusWithin)
            {
                e.Handled = true;
                MemoCancel_Click(MemoCancel, new RoutedEventArgs());
                return;
            }
            if (MemoTitle.IsKeyboardFocusWithin)
            {
                // タスク名欄でのEnterでは送信しない
                e.Handled = true;
                return;
            }
            if (MemoBody.IsKeyboardFocusWithin || ScratchpadBox.IsKeyboardFocusWithin || OpenCodeInput.IsKeyboardFocusWithin)
            {
                // 複数行テキストボックスではAcceptsReturnによる改行に委ねる（OpenCode 指示欄の Enter 送信は OpenCodeInput_PreviewKeyDown）
                return;
            }            if (!IsNonSearchPaneFocused() && LauncherResultSelection.CanOpenWithReturn(Results.SelectedItem is not null, memoActive: false))
            {
                e.Handled = true;
                _ = OpenSelectedAsync();
            }
        }
    }

    private void MoveSelection(int delta)
    {
        if (Results.Items.Count == 0) return;
        var current = Results.SelectedIndex < 0 ? 0 : Results.SelectedIndex;
        Results.SelectedIndex = (current + delta + Results.Items.Count) % Results.Items.Count;
        Results.ScrollIntoView(Results.SelectedItem);
    }

    private async Task OpenSelectedAsync()
    {
        if (Results.SelectedItem is SearchItem item) await OpenItemAsync(item);
    }

    private async Task OpenItemAsync(SearchItem item)
    {
        try
        {
            if (item.IsGantt) await _api.OpenGanttTaskAsync(item.FileId);
            else
            {
                var clickTask = _api.RecordClickAsync(item, QueryBox.Text.Trim());
                if (UsesSystemFileLauncher(item.FullPath)) OpenFileWithSystemDefault(item.FullPath);
                else OpenUrl(PrimaryUrl(item));
                try { await clickTask; } catch { }
            }
            HideLauncherWindow();
        }
        catch (Exception error) { Status.Text = $"結果を開けません: {error.Message}"; }
    }

    private async void Results_MouseDoubleClick(object sender, MouseButtonEventArgs e)
    {
        if (FindAncestor<Button>(e.OriginalSource as DependencyObject) is not null) return;
        await OpenSelectedAsync();
    }
    private async void Reveal_Click(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.DataContext is not SearchItem item) return;
        var target = item.ResultKind == "folder" ? item.FullPath : ParentPath(item.FullPath);
        try { await _api.OpenLocationAsync(target); } catch (Exception error) { Status.Text = $"保存場所を開けません: {error.Message}"; }
    }
    private void CopyPath_Click(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.DataContext is not SearchItem item) return;
        try { Clipboard.SetText(item.FullPath); Status.Text = "クリップボードにコピーしました"; }
        catch (Exception error) { Status.Text = $"クリップボードへコピーできません: {error.Message}"; }
    }
    private void OpenFolder_Click(object sender, RoutedEventArgs e)
    { if ((sender as FrameworkElement)?.DataContext is SearchItem item) TryOpenUrl(FolderUrl(item)); }
    private void OpenGanttLink_Click(object sender, RoutedEventArgs e)
    { if ((sender as FrameworkElement)?.DataContext is SearchItem { GanttLink: not null } item) TryOpenUrl(item.GanttLink); }
    private void OpenGui_Click(object sender, RoutedEventArgs e) { if (TryOpenUrl($"{ApiBase()}/")) HideLauncherWindow(); }

    private string CurrentFocusedStopName()
    {
        if (ExtensionBox.IsKeyboardFocusWithin) return "Extension";
        if (MemoTitle.IsKeyboardFocusWithin) return "MemoTitle";
        if (MemoBody.IsKeyboardFocusWithin) return "MemoBody";
        if (MemoSubmit.IsKeyboardFocusWithin) return "MemoSubmit";
        if (MemoCancel.IsKeyboardFocusWithin) return "MemoBody";
        if (ScratchpadBox.IsKeyboardFocusWithin) return "Scratchpad";
        if (OpenCodeInput.IsKeyboardFocusWithin) return "OpenCodeInput";
        if (OpenCodeSubmit.IsKeyboardFocusWithin) return "OpenCodeSubmit";
        // OpenCode の見出し・ツールバー・会話欄からの Tab は指示欄へ進む
        if (OpenCodeNewChat.IsKeyboardFocusWithin || OpenCodeChatScroll.IsKeyboardFocusWithin || OpenCodeHistoryButton.IsKeyboardFocusWithin
            || OpenCodeModelCombo.IsKeyboardFocusWithin || OpenCodePlanCheck.IsKeyboardFocusWithin || OpenCodeAutoCheck.IsKeyboardFocusWithin) return "Extension";
        return "Query";
    }

    /// <summary>4ペインの主要コントロールをTab/Shift+Tabで順番に循環する。</summary>
    private void MoveTabFocus(bool backwards)
    {
        Control target = LauncherTabNavigation.Next(CurrentFocusedStopName(), backwards) switch
        {
            "Extension" => ExtensionBox,
            "MemoTitle" => MemoTitle,
            "MemoBody" => MemoBody,
            "MemoSubmit" => MemoSubmit,
            "Scratchpad" => ScratchpadBox,
            "OpenCodeInput" => OpenCodeInput,
            "OpenCodeSubmit" => OpenCodeSubmit,
            _ => QueryBox,
        };
        target.Focus();
    }

    /// <summary>Web の設定（gantt parent・opencode 実行フォルダ・常時保持メモ）を取り直して反映する。</summary>
    private async Task RefreshSharedSettingsAsync()
    {
        try
        {
            var shared = await _api.GetSharedSettingsAsync(_ganttParent, _services.OpenCode.WorkingDir);
            _ganttParent = shared.GanttParent;
            _services.OpenCode.SetWorkingDir(shared.OpenCodeWorkingDir);
            if (shared.HasLauncherMemo) _services.Memo.Load(shared.LauncherMemo);
            _services.OpenCode.SlashCommands = await _api.GetSlashCommandsAsync();
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException or System.Text.Json.JsonException)
        {
            // バックエンドに届かないときは今の値のまま使う
        }
        ParentLabel.Text = $"parent: {_ganttParent}";
        RenderOpenCode();
    }

    private async void MemoSubmit_Click(object sender, RoutedEventArgs e)
    {
        var title = MemoTitle.Text.Trim();
        if (title.Length == 0) { MemoStatus.Text = "タスク名を入力してください"; MemoTitle.Focus(); return; }
        MemoSubmit.IsEnabled = false;
        try
        {
            await RefreshSharedSettingsAsync();
            await _api.CreateGanttTaskAsync(GanttTaskBuilder.Build(title, MemoBody.Text, _ganttParent));
            MemoTitle.Clear(); MemoBody.Clear();
            MemoStatus.Text = "gantt に追加しました";
            MemoTitle.Focus();
        }
        catch (Exception error) { MemoStatus.Text = $"gantt 追加に失敗しました: {error.Message}"; }
        finally { MemoSubmit.IsEnabled = true; }
    }

    private void MemoCancel_Click(object sender, RoutedEventArgs e)
    {
        MemoTitle.Clear();
        MemoBody.Clear();
        MemoStatus.Text = "入力をクリアしました";
        MemoTitle.Focus();
    }

    /// <summary>
    /// OpenCode の指示を送る。実行中なら待ち行列へ入る。受け付けなかった（空・フォルダなし）ときだけ指示を入力欄へ残す。
    /// </summary>
    private async Task SubmitOpenCodeAsync()
    {
        string prompt = OpenCodeInput.Text;
        if (prompt.Trim().Length == 0) { OpenCodeActivity.Text = "指示を入力してください"; return; }
        var conversation = _services.OpenCode;
        if (!conversation.IsRunning) await RefreshSharedSettingsAsync();
        var sending = conversation.SendAsync(prompt);
        if (!(sending.IsCompleted && !sending.Result))
        {
            OpenCodeInput.Clear();
        }
        OpenCodeInput.Focus();
        await sending;
    }

    /// <summary>送信ボタン: 実行中は停止（待ち行列も捨てる）、それ以外は送信。</summary>
    private async void OpenCodeSubmit_Click(object sender, RoutedEventArgs e)
    {
        if (_services.OpenCode.IsRunning)
        {
            _services.OpenCode.Cancel();
            OpenCodeActivity.Text = "停止しています…";
            return;
        }
        await SubmitOpenCodeAsync();
    }

    /// <summary>
    /// 指示欄のキー（ウィンドウ全体のキー処理より先に呼ぶ）。処理したら true。
    /// Enter で送信、Shift+Enter で改行、1 行目の ↑ / 最終行の ↓ で過去の指示。
    /// スラッシュコマンドの候補表示中は ↑↓ で選択、Tab / Enter で確定、Esc で閉じる。/ の語の中の Tab は補完。
    /// </summary>
    private bool HandleOpenCodeInputKey(KeyEventArgs e)
    {
        string text = OpenCodeInput.Text;
        int caret = OpenCodeInput.CaretIndex;
        int caretLine = OpenCodeInput.GetLineIndexFromCharacterIndex(caret);
        int lastLine = Math.Max(0, OpenCodeInput.LineCount - 1);
        var action = OpenCodeInputKeys.Decide(
            e.Key,
            Keyboard.Modifiers,
            caretOnFirstLine: caretLine <= 0,
            caretOnLastLine: caretLine < 0 || caretLine >= lastLine,
            suggestionsOpen: _slash.IsOpen,
            inSlashToken: SlashCommands.Query(text, caret) is not null);
        switch (action)
        {
            case OpenCodeInputAction.Submit:
                _ = SubmitOpenCodeAsync();
                return true;
            case OpenCodeInputAction.HistoryPrevious:
                if (_services.OpenCode.History.Previous(text) is not { } previous) return false;
                SetOpenCodeInput(previous, previous.Length);
                return true;
            case OpenCodeInputAction.HistoryNext:
                if (_services.OpenCode.History.Next() is not { } next) return false;
                SetOpenCodeInput(next, next.Length);
                return true;
            case OpenCodeInputAction.SuggestionPrevious or OpenCodeInputAction.SuggestionNext:
                _slash.Move(action == OpenCodeInputAction.SuggestionNext ? 1 : -1);
                RenderSlashPopup();
                return true;
            case OpenCodeInputAction.AcceptSuggestion:
                if (_slash.Accept(text, caret) is { } accepted) SetOpenCodeInput(accepted.Text, accepted.Caret);
                RenderSlashPopup();
                return true;
            case OpenCodeInputAction.CloseSuggestions:
                _slash.Dismiss();
                RenderSlashPopup();
                return true;
            case OpenCodeInputAction.CompleteSlash:
                var completed = _slash.CompleteOnTab(text, caret, _services.OpenCode.SlashCommands);
                if (completed is { } done) SetOpenCodeInput(done.Text, done.Caret);
                RenderSlashPopup();
                // 候補が 1 つも無いときは、普段どおり Tab でペインを移動する
                return _slash.IsOpen || completed is not null;
            default:
                return false;
        }
    }

    /// <summary>指示欄の文字とカーソルを置き換える（補完の候補は作り直さない）。</summary>
    private void SetOpenCodeInput(string text, int caret)
    {
        _suppressSlashRefresh = true;
        OpenCodeInput.Text = text;
        OpenCodeInput.CaretIndex = Math.Clamp(caret, 0, text.Length);
        _lastSlashInput = (OpenCodeInput.Text, OpenCodeInput.CaretIndex);
        _suppressSlashRefresh = false;
    }

    /// <summary>
    /// 指示欄の文字かカーソルが変わったら、スラッシュコマンドの候補を作り直す。
    /// 文字の変更通知はカーソルが動く前に届くことがあるため、カーソルの移動でも確かめる（同じ状態なら作り直さない）。
    /// </summary>
    private void OpenCodeInput_TextChanged(object sender, RoutedEventArgs e)
    {
        if (_suppressSlashRefresh) return;
        var current = (OpenCodeInput.Text, OpenCodeInput.CaretIndex);
        if (_lastSlashInput == current) return;
        _lastSlashInput = current;
        _slash.Refresh(current.Text, current.CaretIndex, _services.OpenCode.SlashCommands);
        RenderSlashPopup();
    }

    /// <summary>候補の一覧（「/名前  説明」）と選択位置を描く。閉じていれば隠す。</summary>
    private void RenderSlashPopup()
    {
        if (!_slash.IsOpen || !OpenCodeInput.IsKeyboardFocusWithin)
        {
            SlashPopup.IsOpen = false;
            return;
        }
        SlashList.Items.Clear();
        var descriptionBrush = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0x94, 0xA3, 0xB8));
        foreach (var command in _slash.Items)
        {
            var line = new TextBlock { TextTrimming = TextTrimming.CharacterEllipsis };
            line.Inlines.Add(new System.Windows.Documents.Run($"/{command.Name}") { FontWeight = FontWeights.SemiBold });
            if (command.Description.Length > 0)
            {
                line.Inlines.Add(new System.Windows.Documents.Run($"  {command.Description}") { Foreground = descriptionBrush });
            }
            SlashList.Items.Add(new ListBoxItem { Content = line, ToolTip = command.Prompt, Padding = new Thickness(6, 3, 6, 3), Foreground = System.Windows.Media.Brushes.White });
        }
        SlashList.SelectedIndex = _slash.Index;
        if (SlashList.SelectedItem is not null) SlashList.ScrollIntoView(SlashList.SelectedItem);
        SlashPopup.IsOpen = true;
    }

    /// <summary>候補をクリックしたら、その候補で補完する。</summary>
    private void SlashList_PreviewMouseLeftButtonUp(object sender, MouseButtonEventArgs e)
    {
        if (FindAncestor<ListBoxItem>(e.OriginalSource as DependencyObject) is not { } item) return;
        _slash.Move(SlashList.Items.IndexOf(item) - _slash.Index);
        if (_slash.Accept(OpenCodeInput.Text, OpenCodeInput.CaretIndex) is { } accepted) SetOpenCodeInput(accepted.Text, accepted.Caret);
        RenderSlashPopup();
        OpenCodeInput.Focus();
        e.Handled = true;
    }

    /// <summary>☰: opencode 実行フォルダの設定メニュー（現在のフォルダ表示・選ぶ・既定に戻す）を開く。</summary>
    private void OpenCodeMenu_Click(object sender, RoutedEventArgs e)
    {
        var menu = OpenCodeMenu;
        menu.Items.Clear();
        var current = _services.OpenCode.WorkingDir;
        // Header へ文字列を直接入れると "_" がアクセスキー扱いで消えるため、TextBlock で包む
        menu.Items.Add(new MenuItem { Header = new TextBlock { Text = $"実行フォルダ: {(current.Length > 0 ? current : "（未設定）")}" }, IsEnabled = false });
        menu.Items.Add(new Separator());
        var choose = new MenuItem { Header = "実行フォルダを選ぶ…" };
        choose.Click += async (_, _) => await ChooseOpenCodeWorkingDirAsync();
        menu.Items.Add(choose);
        var reset = new MenuItem { Header = "実行フォルダを既定に戻す" };
        reset.Click += async (_, _) => await ApplyOpenCodeWorkingDirAsync("");
        menu.Items.Add(reset);
        menu.PlacementTarget = OpenCodeMenuButton;
        menu.Placement = System.Windows.Controls.Primitives.PlacementMode.Bottom;
        menu.IsOpen = true;
    }

    /// <summary>フォルダ選択ダイアログで選んだフォルダを opencode 実行フォルダとして保存する。</summary>
    private async Task ChooseOpenCodeWorkingDirAsync()
    {
        var dialog = new Microsoft.Win32.OpenFolderDialog { Title = "OpenCode を実行するフォルダを選んでください", Multiselect = false };
        var current = _services.OpenCode.WorkingDir;
        if (current.Length > 0 && Directory.Exists(current)) dialog.InitialDirectory = current;
        if (dialog.ShowDialog(this) != true) return;
        await ApplyOpenCodeWorkingDirAsync(dialog.FolderName);
    }

    /// <summary>実行フォルダを保存して OpenCode へ反映する。実行中は変更しない。保存に失敗したら今のフォルダのまま。</summary>
    private async Task ApplyOpenCodeWorkingDirAsync(string path)
    {
        if (_services.OpenCode.IsRunning)
        {
            OpenCodeActivity.Text = "OpenCode の実行中は実行フォルダを変更できません";
            return;
        }
        try
        {
            var saved = await _api.SaveOpenCodeWorkingDirAsync(path);
            _services.OpenCode.SetWorkingDir(saved);
            RenderOpenCode();
            OpenCodeActivity.Text = saved.Length > 0 ? $"実行フォルダを変更しました: {saved}" : "実行フォルダを既定に戻しました";
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException)
        {
            OpenCodeActivity.Text = $"実行フォルダの保存に失敗しました: {error.Message}";
        }
    }

    /// <summary>「/ コマンド」: スラッシュコマンドの登録画面を開き、保存した一覧を会話へ反映する。</summary>
    private void OpenCodeCommands_Click(object sender, RoutedEventArgs e)
    {
        var conversation = _services.OpenCode;
        SlashPopup.IsOpen = false;
        var dialog = new SlashCommandsWindow(conversation.SlashCommands, async commands =>
        {
            var saved = await _api.SaveSlashCommandsAsync(commands);
            conversation.SlashCommands = saved;
            return saved;
        })
        { Owner = this };
        dialog.ShowDialog();
        OpenCodeInput.Focus();
    }

    private void OpenCodeNewChat_Click(object sender, RoutedEventArgs e)
    {
        _services.OpenCode.Reset();
        OpenCodeInput.Focus();
    }

    /// <summary>履歴ボタン: この作業フォルダの会話一覧を取り、選んだ会話を読み込んで続ける。</summary>
    private async void OpenCodeHistory_Click(object sender, RoutedEventArgs e)
    {
        var menu = OpenCodeHistoryMenu;
        menu.Items.Clear();
        menu.Items.Add(new MenuItem { Header = "読み込み中…", IsEnabled = false });
        menu.PlacementTarget = OpenCodeHistoryButton;
        menu.Placement = System.Windows.Controls.Primitives.PlacementMode.Bottom;
        menu.IsOpen = true;
        await RefreshSharedSettingsAsync();
        var sessions = await _services.OpenCode.ListSessionsAsync();
        menu.Items.Clear();
        long nowMs = DateTimeOffset.Now.ToUnixTimeMilliseconds();
        foreach (var summary in sessions)
        {
            var item = new MenuItem
            {
                Header = $"{(summary.Title.Length > 0 ? summary.Title : "（無題）")} · {OpenCodeChatFormat.FormatRelativeTime(summary.UpdatedMs, nowMs)}",
                Tag = summary.Id,
                IsChecked = summary.Id == _services.OpenCode.SessionId,
            };
            item.Click += async (_, _) =>
            {
                OpenCodeActivity.Text = "会話を読み込んでいます…";
                if (await _services.OpenCode.ResumeAsync(summary.Id)) OpenCodeInput.Focus();
            };
            menu.Items.Add(item);
        }
        if (sessions.Count == 0) menu.Items.Add(new MenuItem { Header = "（会話はまだありません）", IsEnabled = false });
    }

    private void OpenCodeModelCombo_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_suppressModelEvent) return;
        _services.OpenCode.Model = OpenCodeModelCombo.SelectedIndex <= 0 ? null : OpenCodeModelCombo.SelectedItem as string;
    }

    private void OpenCodePlanCheck_Click(object sender, RoutedEventArgs e) => _services.OpenCode.PlanMode = OpenCodePlanCheck.IsChecked == true;

    private void OpenCodeAutoCheck_Click(object sender, RoutedEventArgs e) => _services.OpenCode.AutoApprove = OpenCodeAutoCheck.IsChecked == true;

    /// <summary>モデル一覧（opencode models）をアプリ起動中 1 度だけ取り、選択欄へ並べる。取れなければ次の表示で取り直す。</summary>
    private async Task LoadOpenCodeModelsAsync()
    {
        var models = await _services.OpenCode.ListModelsAsync();
        if (models.Count > 0) s_openCodeModels = models;
        FillOpenCodeModels(models);
    }

    private void FillOpenCodeModels(IReadOnlyList<string> models)
    {
        _suppressModelEvent = true;
        OpenCodeModelCombo.Items.Clear();
        OpenCodeModelCombo.Items.Add("既定のモデル");
        foreach (string model in models) OpenCodeModelCombo.Items.Add(model);
        string? current = _services.OpenCode.Model;
        OpenCodeModelCombo.SelectedIndex = current is not null && models.Contains(current) ? OpenCodeModelCombo.Items.IndexOf(current) : 0;
        _suppressModelEvent = false;
    }

    private void ToggleOpenCodeEntry(string id)
    {
        var transcript = _services.OpenCode.Transcript;
        if (!transcript.Toggle(id)) return;
        if (transcript.Snapshot().FirstOrDefault(entry => entry.Id == id) is { } entry) _chatView.Acknowledge(entry);
    }

    private void CopyOpenCodeEntry(string id)
    {
        try
        {
            Clipboard.SetText(_services.OpenCode.Transcript.CopyText(id));
            OpenCodeActivity.Text = "応答をコピーしました";
        }
        catch (Exception error) { OpenCodeActivity.Text = $"コピーできません: {error.Message}"; }
    }

    /// <summary>会話の更新（opencode の出力を読むスレッドからも届く）を UI スレッドで表示する。</summary>
    private void OnOpenCodeChanged() => Dispatcher.BeginInvoke(RenderOpenCode);

    private void RenderOpenCode()
    {
        var conversation = _services.OpenCode;
        OpenCodeDirLabel.Text = conversation.WorkingDir.Length > 0
            ? $"cwd: {conversation.WorkingDir}"
            : "cwd: （☰ メニューから opencode 実行フォルダを指定してください）";
        _chatView.Render(conversation.Transcript.Snapshot());
        RenderOpenCodeStatus();
    }

    /// <summary>作業状況（経過時間・待ち行列）・使用量・送信 / 停止ボタンを今の状態に合わせる（1 秒ごとにも呼ぶ）。</summary>
    private void RenderOpenCodeStatus()
    {
        var conversation = _services.OpenCode;
        bool running = conversation.IsRunning;
        string status = conversation.StatusText();
        if (running || status.Length > 0) OpenCodeActivity.Text = status;
        OpenCodeUsage.Text = conversation.Transcript.UsageText();
        OpenCodeSubmit.Content = running ? "停止" : "送信";
        OpenCodeHistoryButton.IsEnabled = !running;
    }

    private string PrimaryUrl(SearchItem item) => item.IsWeb
        ? item.FullPath
        : item.ResultKind == "folder" ? $"{WebBase()}/?path={Uri.EscapeDataString(item.FullPath)}" : $"{WebBase()}/api/fullpath?path={Uri.EscapeDataString(item.FullPath)}";
    private string FolderUrl(SearchItem item) => $"{WebBase()}/?path={Uri.EscapeDataString(item.ResultKind == "folder" ? item.FullPath : ParentPath(item.FullPath))}";
    private static string ParentPath(string path) => Path.GetDirectoryName(path) ?? path;
    private static string WebBase() => LauncherUrls.OpenHubBase();
    private static string ApiBase() => (Environment.GetEnvironmentVariable("LAUNCHER_API_BASE_URL") ?? "http://127.0.0.1:8079").TrimEnd('/');
    private static void OpenUrl(string url) => Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    private static bool UsesSystemFileLauncher(string path) => new[] { ".py", ".bat", ".exe", ".lnk" }.Contains(Path.GetExtension(path), StringComparer.OrdinalIgnoreCase);
    /// <summary>スクリプト・実行ファイル・ショートカットを親フォルダをcurrent dirとして起動する。</summary>
    private static void OpenFileWithSystemDefault(string path) => Process.Start(new ProcessStartInfo(path)
    {
        UseShellExecute = true,
        WorkingDirectory = Path.GetDirectoryName(path) ?? Environment.CurrentDirectory,
    });
    private bool TryOpenUrl(string url)
    {
        try { OpenUrl(url); return true; }
        catch (Exception error) { Status.Text = $"リンクを開けません: {error.Message}"; return false; }
    }
    private static int ReadNonNegativeInt(string name, int fallback) => int.TryParse(Environment.GetEnvironmentVariable(name), out var value) && value >= 0 ? value : fallback;
    private static T? FindAncestor<T>(DependencyObject? current) where T : DependencyObject
    {
        while (current is not null)
        {
            if (current is T match) return match;
            current = System.Windows.Media.VisualTreeHelper.GetParent(current);
        }
        return null;
    }

    protected override void OnClosed(EventArgs e)
    {
        _debounce.Stop();
        _openCodeTicker.Stop();
        _services.Memo.Changed -= OnMemoChanged;
        _services.OpenCode.Changed -= OnOpenCodeChanged;
        _searchCancellation?.Cancel();
        _searchCancellation?.Dispose();
        _api.Dispose();
        base.OnClosed(e);
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
    [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int command);
}
