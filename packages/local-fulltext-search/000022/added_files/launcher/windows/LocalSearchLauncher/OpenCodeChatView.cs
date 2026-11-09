/**
 * WPF ランチャーの OpenCode ペインのチャット描画（Claudian 風）。
 *
 * 【仕様】
 * - ChatTranscript の表示項目を StackPanel へ並べる。Id と Revision を覚え、変わった項目だけ作り直す。
 * - 自分の指示: 右寄せの青い吹き出し。opencode の応答: 1 往復の最初に「opencode」の見出しを付け、
 *   本文は簡易 Markdown（見出し・箇条書き・番号・引用・コード・行内コード・太字）を FlowDocument で描く。本文ごとに「コピー」ボタン。
 * - 思考とツールは Expander（既定で閉じる）。見出しは「思考（1.2秒）」「✓ bash  npm test」。開くと本文 / 入力と出力。
 * - お知らせは中央寄せの灰色「— 中断しました —」、エラーは赤の「⚠ 理由」。会話が空なら操作の案内を出す。
 * - 読み返し中（下端から 100px より上）はスクロール位置を保ち、下端付近なら最新へ追従する。
 **/
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Media;

namespace LocalSearchLauncher;

internal sealed class OpenCodeChatView(StackPanel panel, ScrollViewer scroll, Action<string> toggle, Action<string> copy)
{
    public const string EmptyHint = "opencode に指示を入力してください。\nEnter で送信 / Shift+Enter で改行 / ↑ で過去の指示\n履歴から過去の会話を再開でき、Plan にすると変更せず計画だけ立てます。";
    private static readonly Brush TextBrush = Brush("#F8FAFC");
    private static readonly Brush MutedBrush = Brush("#94A3B8");
    private static readonly Brush UserBubbleBrush = Brush("#CC1D4ED8");
    private static readonly Brush AssistantLabelBrush = Brush("#86EFAC");
    private static readonly Brush ToolBrush = Brush("#BFDBFE");
    private static readonly Brush ErrorBrush = Brush("#F87171");
    private static readonly Brush CodeBrush = Brush("#D9F99D");
    private static readonly Brush CodeBackground = Brush("#FF0B1220");
    private static readonly Brush LinkBrush = Brush("#60A5FA");
    private static readonly FontFamily MonoFont = new("Consolas, Cascadia Mono, MS Gothic");
    private readonly List<(string Id, int Revision)> _rendered = [];
    private bool _showingHint;

    /// <summary>会話を描く（変わった項目だけ作り直す）。</summary>
    public void Render(IReadOnlyList<ChatEntry> entries)
    {
        bool follow = scroll.ScrollableHeight - scroll.VerticalOffset <= 100;
        if (entries.Count == 0)
        {
            if (!_showingHint)
            {
                panel.Children.Clear();
                _rendered.Clear();
                panel.Children.Add(new TextBlock { Text = EmptyHint, Foreground = MutedBrush, FontSize = 12, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(4) });
                _showingHint = true;
            }
            return;
        }
        if (_showingHint || entries.Count < _rendered.Count || !SamePrefix(entries))
        {
            panel.Children.Clear();
            _rendered.Clear();
            _showingHint = false;
        }
        for (int index = 0; index < entries.Count; index++)
        {
            var entry = entries[index];
            bool startsResponse = entry.Kind is ChatEntryKind.Text or ChatEntryKind.Reasoning or ChatEntryKind.Tool
                && (index == 0 || entries[index - 1].Kind is ChatEntryKind.User or ChatEntryKind.Notice);
            if (index < _rendered.Count)
            {
                if (_rendered[index].Revision == entry.Revision) continue;
                panel.Children[index] = Build(entry, startsResponse);
                _rendered[index] = (entry.Id, entry.Revision);
            }
            else
            {
                panel.Children.Add(Build(entry, startsResponse));
                _rendered.Add((entry.Id, entry.Revision));
            }
        }
        if (follow) scroll.ScrollToEnd();
    }

    /// <summary>開閉をこの画面で切り替えたときに、描き直さないよう版番号だけ合わせる。</summary>
    public void Acknowledge(ChatEntry entry)
    {
        int index = _rendered.FindIndex(item => item.Id == entry.Id);
        if (index >= 0) _rendered[index] = (entry.Id, entry.Revision);
    }

    private bool SamePrefix(IReadOnlyList<ChatEntry> entries)
    {
        for (int index = 0; index < _rendered.Count; index++)
        {
            if (entries[index].Id != _rendered[index].Id) return false;
        }
        return true;
    }

    private FrameworkElement Build(ChatEntry entry, bool startsResponse)
    {
        var element = BuildEntry(entry, startsResponse);
        // 吹き出し内の文字欄がホイールを奪わないよう、会話全体のスクロールへ渡す（ツール出力の欄は自分でスクロールする）
        element.PreviewMouseWheel += (_, e) =>
        {
            if (e.OriginalSource is DependencyObject source && FindScrollableTextBox(source) is not null) return;
            e.Handled = true;
            scroll.ScrollToVerticalOffset(scroll.VerticalOffset - e.Delta / 3.0);
        };
        return element;
    }

    private static TextBox? FindScrollableTextBox(DependencyObject? current)
    {
        while (current is not null)
        {
            if (current is TextBox { VerticalScrollBarVisibility: ScrollBarVisibility.Auto } box && box.ExtentHeight > box.ViewportHeight) return box;
            current = current is Visual or System.Windows.Media.Media3D.Visual3D ? VisualTreeHelper.GetParent(current) : LogicalTreeHelper.GetParent(current);
        }
        return null;
    }

    private FrameworkElement BuildEntry(ChatEntry entry, bool startsResponse)
    {
        FrameworkElement body = entry.Kind switch
        {
            ChatEntryKind.User => UserBubble(entry),
            ChatEntryKind.Text => AssistantText(entry),
            ChatEntryKind.Reasoning => Collapsible(entry, entry.DurationSeconds is { } seconds ? $"思考（{OpenCodeChatFormat.FormatElapsed(seconds)}）" : "思考", MutedBrush, PlainBox(entry.Text, MutedBrush, mono: false)),
            ChatEntryKind.Tool => Collapsible(
                entry,
                OpenCodeChatFormat.ToolHeader(entry.Tool, entry.Status, entry.Summary),
                entry.Status == "error" ? ErrorBrush : ToolBrush,
                PlainBox(string.Join("\n\n", new[] { entry.DetailInput, entry.DetailOutput.Length > 0 ? entry.DetailOutput : "（出力なし）" }.Where(part => part.Length > 0)), MutedBrush, mono: true)),
            _ => Notice(entry),
        };
        if (!startsResponse) return body;
        var stack = new StackPanel();
        stack.Children.Add(new TextBlock { Text = "opencode", Foreground = AssistantLabelBrush, FontSize = 11, FontWeight = FontWeights.SemiBold, Margin = new Thickness(2, 8, 0, 2) });
        stack.Children.Add(body);
        return stack;
    }

    private static FrameworkElement UserBubble(ChatEntry entry) => new Border
    {
        Background = UserBubbleBrush,
        CornerRadius = new CornerRadius(10),
        Padding = new Thickness(10, 6, 10, 6),
        Margin = new Thickness(40, 8, 0, 2),
        HorizontalAlignment = HorizontalAlignment.Right,
        Child = PlainBox(entry.Text, TextBrush, mono: false, transparent: true),
    };

    private FrameworkElement AssistantText(ChatEntry entry)
    {
        var box = new RichTextBox
        {
            IsReadOnly = true,
            IsDocumentEnabled = true,
            Background = Brushes.Transparent,
            BorderThickness = new Thickness(0),
            Foreground = TextBrush,
            Padding = new Thickness(0),
            Document = MarkdownDocument(entry.Text),
        };
        var copyButton = new Button
        {
            Content = "コピー",
            FontSize = 10,
            Padding = new Thickness(6, 0, 6, 0),
            Margin = new Thickness(0, 0, 0, 4),
            Background = Brushes.Transparent,
            BorderThickness = new Thickness(0),
            Foreground = LinkBrush,
            Cursor = System.Windows.Input.Cursors.Hand,
            HorizontalAlignment = HorizontalAlignment.Left,
            Focusable = false,
        };
        copyButton.Click += (_, _) => copy(entry.Id);
        var stack = new StackPanel { Margin = new Thickness(0, 2, 0, 2) };
        stack.Children.Add(box);
        stack.Children.Add(copyButton);
        return stack;
    }

    private FrameworkElement Collapsible(ChatEntry entry, string header, Brush headerBrush, FrameworkElement content)
    {
        var expander = new Expander
        {
            Header = new TextBlock { Text = header, Foreground = headerBrush, FontSize = 12, TextTrimming = TextTrimming.CharacterEllipsis },
            IsExpanded = entry.Expanded,
            Content = content,
            Foreground = headerBrush,
            Margin = new Thickness(0, 1, 0, 1),
            Focusable = false,
        };
        // 画面上の開閉状態を覚え、変わったときだけ会話側の状態を切り替える
        bool expanded = entry.Expanded;
        expander.Expanded += (_, _) => { if (!expanded) { expanded = true; toggle(entry.Id); } };
        expander.Collapsed += (_, _) => { if (expanded) { expanded = false; toggle(entry.Id); } };
        return expander;
    }

    private static FrameworkElement Notice(ChatEntry entry) => new TextBlock
    {
        Text = entry.Status == "error" ? $"⚠ {entry.Text}" : $"— {entry.Text} —",
        Foreground = entry.Status == "error" ? ErrorBrush : MutedBrush,
        FontSize = 11,
        TextWrapping = TextWrapping.Wrap,
        HorizontalAlignment = entry.Status == "error" ? HorizontalAlignment.Left : HorizontalAlignment.Center,
        Margin = new Thickness(0, 4, 0, 4),
    };

    /// <summary>選択・コピーできる読み取り専用の文字欄。</summary>
    private static TextBox PlainBox(string text, Brush foreground, bool mono, bool transparent = false) => new()
    {
        Text = text,
        IsReadOnly = true,
        TextWrapping = TextWrapping.Wrap,
        BorderThickness = new Thickness(0),
        Background = transparent ? Brushes.Transparent : CodeBackground,
        Foreground = foreground,
        FontFamily = mono ? MonoFont : new FontFamily("Inter, Segoe UI"),
        FontSize = mono ? 11 : 13,
        Padding = transparent ? new Thickness(0) : new Thickness(6, 4, 6, 4),
        MaxHeight = mono ? 240 : double.PositiveInfinity,
        VerticalScrollBarVisibility = mono ? ScrollBarVisibility.Auto : ScrollBarVisibility.Disabled,
    };

    /// <summary>簡易 Markdown を FlowDocument にする。</summary>
    private static FlowDocument MarkdownDocument(string text)
    {
        var document = new FlowDocument { PagePadding = new Thickness(0), FontFamily = new FontFamily("Inter, Segoe UI"), FontSize = 13, Foreground = TextBrush };
        foreach (var block in MarkdownLite.Parse(text))
        {
            var paragraph = new Paragraph { Margin = new Thickness(0, 2, 0, 2) };
            switch (block.Kind)
            {
                case MdBlockKind.Code:
                    paragraph.FontFamily = MonoFont;
                    paragraph.FontSize = 12;
                    paragraph.Foreground = CodeBrush;
                    paragraph.Background = CodeBackground;
                    paragraph.Padding = new Thickness(6, 4, 6, 4);
                    AddLines(paragraph.Inlines, block.Text, null);
                    document.Blocks.Add(paragraph);
                    continue;
                case MdBlockKind.Heading:
                    paragraph.FontWeight = FontWeights.Bold;
                    paragraph.FontSize = block.Level <= 2 ? 15 : 14;
                    paragraph.Margin = new Thickness(0, 6, 0, 2);
                    break;
                case MdBlockKind.Bullet:
                    paragraph.Margin = new Thickness(4 + block.Level * 16, 0, 0, 0);
                    paragraph.Inlines.Add(new Run("• "));
                    break;
                case MdBlockKind.Numbered:
                    paragraph.Margin = new Thickness(4, 0, 0, 0);
                    paragraph.Inlines.Add(new Run($"{block.Level}. "));
                    break;
                case MdBlockKind.Quote:
                    paragraph.Foreground = MutedBrush;
                    paragraph.BorderBrush = MutedBrush;
                    paragraph.BorderThickness = new Thickness(2, 0, 0, 0);
                    paragraph.Padding = new Thickness(6, 0, 0, 0);
                    break;
            }
            foreach (var inline in block.Inlines)
            {
                AddLines(paragraph.Inlines, inline.Text, inline.Style);
            }
            document.Blocks.Add(paragraph);
        }
        return document;
    }

    /// <summary>改行を LineBreak に変えながら文字を足す。</summary>
    private static void AddLines(InlineCollection inlines, string text, MdInlineStyle? style)
    {
        string[] lines = text.Split('\n');
        for (int index = 0; index < lines.Length; index++)
        {
            if (index > 0) inlines.Add(new LineBreak());
            if (lines[index].Length == 0) continue;
            Inline run = new Run(lines[index]);
            if (style == MdInlineStyle.Bold) run = new Bold(run);
            else if (style == MdInlineStyle.Code)
            {
                run.FontFamily = MonoFont;
                run.Foreground = CodeBrush;
                run.Background = CodeBackground;
            }
            inlines.Add(run);
        }
    }

    private static SolidColorBrush Brush(string hex)
    {
        var brush = (SolidColorBrush)new BrushConverter().ConvertFromString(hex)!;
        brush.Freeze();
        return brush;
    }
}
