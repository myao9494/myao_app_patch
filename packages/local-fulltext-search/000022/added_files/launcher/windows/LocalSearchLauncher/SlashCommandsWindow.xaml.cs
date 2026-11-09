/**
 * OpenCode ペインの独自スラッシュコマンド（/pass など）の登録画面。
 *
 * 【仕様】
 * - 左に登録済みの一覧（名前順）、右に コマンド名・説明・プロンプト の入力欄。一覧で選ぶと入力欄へ読み込む。
 * - 「＋ 新規」で入力欄を空にする。「保存」は入力をチェック（SlashCommands.Validate）してから、
 *   選択中のコマンドの書き換え（名前の変更も可）または追加として一覧ごとバックエンドへ保存する。
 * - 「削除」は確認してから一覧ごと保存する。保存に失敗したら理由を表示し、画面の一覧は変えない。
 * - Esc で閉じる。保存はその場でバックエンドへ送るため、閉じても取り消しにはならない。
 **/
using System.Net.Http;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;

namespace LocalSearchLauncher;

public partial class SlashCommandsWindow : Window
{
    private readonly Func<IReadOnlyList<SlashCommand>, Task<IReadOnlyList<SlashCommand>>> _save;
    private List<SlashCommand> _commands;
    private string? _editingName;
    private bool _suppressSelection;

    internal SlashCommandsWindow(IReadOnlyList<SlashCommand> commands, Func<IReadOnlyList<SlashCommand>, Task<IReadOnlyList<SlashCommand>>> save)
    {
        InitializeComponent();
        _save = save;
        _commands = Sorted(commands);
        RenderList(null);
        ClearEditor();
        Loaded += (_, _) => NameBox.Focus();
    }

    private static List<SlashCommand> Sorted(IEnumerable<SlashCommand> commands) =>
        commands.OrderBy(c => c.Name, StringComparer.OrdinalIgnoreCase).ToList();

    private void RenderList(string? selectName)
    {
        _suppressSelection = true;
        CommandList.Items.Clear();
        foreach (var command in _commands)
        {
            CommandList.Items.Add(new ListBoxItem
            {
                Content = command.Description.Length > 0 ? $"/{command.Name}  {command.Description}" : $"/{command.Name}",
                Tag = command.Name,
                ToolTip = command.Prompt,
            });
        }
        int index = selectName is null ? -1 : _commands.FindIndex(c => string.Equals(c.Name, selectName, StringComparison.OrdinalIgnoreCase));
        CommandList.SelectedIndex = index;
        _suppressSelection = false;
        DeleteButton.IsEnabled = index >= 0;
    }

    private void ClearEditor()
    {
        _editingName = null;
        NameBox.Text = "";
        DescriptionBox.Text = "";
        PromptBox.Text = "";
        DeleteButton.IsEnabled = false;
    }

    private void CommandList_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_suppressSelection || CommandList.SelectedItem is not ListBoxItem { Tag: string name }) return;
        var command = _commands.FirstOrDefault(c => c.Name == name);
        if (command is null) return;
        _editingName = command.Name;
        NameBox.Text = command.Name;
        DescriptionBox.Text = command.Description;
        PromptBox.Text = command.Prompt;
        DeleteButton.IsEnabled = true;
        StatusText.Text = "";
    }

    private void NewButton_Click(object sender, RoutedEventArgs e)
    {
        CommandList.SelectedIndex = -1;
        ClearEditor();
        StatusText.Text = "新しいコマンドを入力して「保存」を押してください";
        NameBox.Focus();
    }

    /// <summary>入力をチェックし、選択中の書き換えまたは追加として一覧ごと保存する。</summary>
    private async void SaveButton_Click(object sender, RoutedEventArgs e)
    {
        var others = _commands.Where(c => !string.Equals(c.Name, _editingName, StringComparison.OrdinalIgnoreCase)).ToList();
        if (SlashCommands.Validate(NameBox.Text, PromptBox.Text, others.Select(c => c.Name)) is { } problem)
        {
            StatusText.Text = problem;
            return;
        }
        var command = new SlashCommand(SlashCommands.NormalizeName(NameBox.Text), PromptBox.Text.Trim(), DescriptionBox.Text.Trim());
        if (await SaveAsync([.. others, command]))
        {
            _editingName = command.Name;
            RenderList(command.Name);
            StatusText.Text = $"/{command.Name} を保存しました";
        }
    }

    private async void DeleteButton_Click(object sender, RoutedEventArgs e)
    {
        if (_editingName is null) return;
        string name = _editingName;
        if (MessageBox.Show(this, $"/{name} を削除しますか？", "スラッシュコマンド", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes) return;
        if (await SaveAsync(_commands.Where(c => c.Name != name).ToList()))
        {
            RenderList(null);
            ClearEditor();
            StatusText.Text = $"/{name} を削除しました";
        }
    }

    /// <summary>一覧をバックエンドへ保存し、成功したら保存後の一覧で置き換える。失敗したら理由を出して false。</summary>
    private async Task<bool> SaveAsync(List<SlashCommand> commands)
    {
        SaveButton.IsEnabled = false;
        try
        {
            _commands = Sorted(await _save(commands));
            return true;
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException)
        {
            StatusText.Text = $"保存できません: {error.Message}";
            return false;
        }
        finally
        {
            SaveButton.IsEnabled = true;
        }
    }

    private void CloseButton_Click(object sender, RoutedEventArgs e) => Close();

    private void Window_PreviewKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Escape)
        {
            e.Handled = true;
            Close();
        }
    }
}
