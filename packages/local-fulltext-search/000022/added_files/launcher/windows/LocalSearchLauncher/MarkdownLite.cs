/**
 * OpenCode の応答（Markdown）を、ランチャーの小さなペインで表示するための簡易 Markdown 解析。
 * Python 版（launcher_app/markdown_lite.py）と同じ約束で動く。
 *
 * 【仕様】
 * - ブロック: 段落・見出し（# 〜 ######、Level=深さ）・箇条書き（- * +、Level=字下げ 2 文字ごとの階層）・
 *   番号付き（1. 、Level=番号）・引用（> ）・コード（``` で囲む。言語名を持ち、中身は解釈しない）。
 * - 空行で段落を分け、段落内の改行は残す。閉じていないコードブロックは最後までコードとして扱う。
 * - 行内: `コード` と **太字** だけを分ける。閉じていない記号は文字のまま残す。
 **/
using System.Text.RegularExpressions;

namespace LocalSearchLauncher;

internal enum MdBlockKind { Paragraph, Heading, Bullet, Numbered, Quote, Code }

internal enum MdInlineStyle { Plain, Bold, Code }

/// <summary>行内の文字列と書式。</summary>
internal sealed record MdInline(string Text, MdInlineStyle Style = MdInlineStyle.Plain);

/// <summary>ブロック 1 つ。Code は Text / Language を、それ以外は Inlines を持つ。</summary>
internal sealed record MdBlock(MdBlockKind Kind, IReadOnlyList<MdInline> Inlines, int Level = 0, string Text = "", string Language = "");

internal static class MarkdownLite
{
    private static readonly Regex Heading = new(@"^(#{1,6})\s+(.*)$", RegexOptions.Compiled);
    private static readonly Regex Bullet = new(@"^(\s*)[-*+]\s+(.*)$", RegexOptions.Compiled);
    private static readonly Regex Numbered = new(@"^\s*(\d+)[.)]\s+(.*)$", RegexOptions.Compiled);
    private static readonly Regex Quote = new(@"^>\s?(.*)$", RegexOptions.Compiled);
    private static readonly Regex Fence = new(@"^\s*```\s*([\w+#.-]*)\s*$", RegexOptions.Compiled);
    private static readonly Regex Inline = new(@"`([^`\n]+)`|\*\*([^*\n](?:[^\n]*?[^*\s])?)\*\*", RegexOptions.Compiled);

    /// <summary>行内コードと太字を分ける。</summary>
    public static IReadOnlyList<MdInline> ParseInlines(string text)
    {
        var result = new List<MdInline>();
        int position = 0;
        foreach (Match match in Inline.Matches(text ?? ""))
        {
            if (match.Index > position) result.Add(new MdInline(text![position..match.Index]));
            result.Add(match.Groups[1].Success
                ? new MdInline(match.Groups[1].Value, MdInlineStyle.Code)
                : new MdInline(match.Groups[2].Value, MdInlineStyle.Bold));
            position = match.Index + match.Length;
        }
        if (position < (text ?? "").Length) result.Add(new MdInline(text![position..]));
        return result;
    }

    /// <summary>Markdown をブロックの並びへ分ける。</summary>
    public static IReadOnlyList<MdBlock> Parse(string text)
    {
        string[] lines = (text ?? "").Replace("\r\n", "\n").Replace("\r", "\n").Split('\n');
        var blocks = new List<MdBlock>();
        var paragraph = new List<string>();

        void FlushParagraph()
        {
            if (paragraph.Count == 0) return;
            blocks.Add(new MdBlock(MdBlockKind.Paragraph, ParseInlines(string.Join("\n", paragraph))));
            paragraph.Clear();
        }

        for (int index = 0; index < lines.Length; index++)
        {
            string line = lines[index];
            var fence = Fence.Match(line);
            if (fence.Success)
            {
                FlushParagraph();
                var code = new List<string>();
                index++;
                while (index < lines.Length && !Fence.IsMatch(lines[index]))
                {
                    code.Add(lines[index]);
                    index++;
                }
                blocks.Add(new MdBlock(MdBlockKind.Code, [], Text: string.Join("\n", code), Language: fence.Groups[1].Value));
                continue;
            }
            if (line.Trim().Length == 0)
            {
                FlushParagraph();
                continue;
            }
            Match match;
            if ((match = Heading.Match(line)).Success)
            {
                FlushParagraph();
                blocks.Add(new MdBlock(MdBlockKind.Heading, ParseInlines(match.Groups[2].Value.Trim()), match.Groups[1].Length));
            }
            else if ((match = Bullet.Match(line)).Success)
            {
                FlushParagraph();
                int indent = match.Groups[1].Value.Replace("\t", "  ").Length;
                blocks.Add(new MdBlock(MdBlockKind.Bullet, ParseInlines(match.Groups[2].Value.Trim()), indent / 2));
            }
            else if ((match = Numbered.Match(line)).Success)
            {
                FlushParagraph();
                blocks.Add(new MdBlock(MdBlockKind.Numbered, ParseInlines(match.Groups[2].Value.Trim()), int.Parse(match.Groups[1].Value)));
            }
            else if ((match = Quote.Match(line)).Success)
            {
                FlushParagraph();
                blocks.Add(new MdBlock(MdBlockKind.Quote, ParseInlines(match.Groups[1].Value.Trim())));
            }
            else
            {
                paragraph.Add(line.TrimEnd());
            }
        }
        FlushParagraph();
        return blocks;
    }
}
