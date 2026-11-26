/**
 * ランチャーで .py を開くときに使う Python（venv）を選び、起動のしかたを組み立てる。
 * Python 版（launcher_app/python_env.py）と同じ約束で動く。
 *
 * 【仕様】
 * - スクリプトと同じ階層（親フォルダの直下）に .venv があれば、その venv の Python で実行する。さらに上の階層の .venv は見ない。
 * - 無ければ、Web 設定ドロワーの「Python 実行環境（.venv）」（共有設定 python_venv_path。絶対パス）の venv で実行する。
 *   venv フォルダの代わりに python 実行ファイルそのものを指定してもよい。
 * - どちらも無い（設定が空欄）ときは、システムの Python（コマンド名 python。実行ファイルは PATH から探す）で実行する。
 * - 設定した venv が見つからない・絶対パスでないときは、別の Python で代わりに動かさず PythonEnvException にする。
 * - 実行時の current dir はスクリプトの親フォルダ。ランチャーはコンソールを持たないため、Python は新しいコンソールで動く。
 * - 起動用ラッパー（launcher/src/launcher_app/python_run_wrapper.py を埋め込んだもの）を挟んで実行し、
 *   スクリプトが例外や 0 以外の終了コードで終わったらトレースバックの末尾をポップアップで知らせる（コンソールの表示はそのまま）。
 **/
using System.Diagnostics;
using System.IO;

namespace LocalSearchLauncher;

/// <summary>設定した venv が使えないため、.py を実行しなかったことを表す。</summary>
internal sealed class PythonEnvException(string message) : Exception(message);

internal static class PythonEnv
{
    /// <summary>venv の中で Python 実行ファイルが置かれる場所（Windows の venv と macOS / Linux の venv）。</summary>
    private static readonly string[] InterpreterCandidates =
    [
        Path.Combine("Scripts", "python.exe"),
        Path.Combine("bin", "python"),
        Path.Combine("bin", "python3"),
    ];

    internal const string SiblingVenvName = ".venv";

    /// <summary>埋め込んだ起動用ラッパーのリソース名とファイル名。</summary>
    internal const string RunWrapperResourceName = "LocalSearchLauncher.python_run_wrapper.py";
    internal const string RunWrapperFileName = "python_run_wrapper.py";

    /// <summary>起動用ラッパーを取り出す既定のフォルダ（%TEMP%\\LocalSearchLauncher）。</summary>
    internal static string DefaultRunWrapperDirectory => Path.Combine(Path.GetTempPath(), "LocalSearchLauncher");

    /// <summary>システムの Python のコマンド名（PATH から探す）。Python 版の Windows での値と同じ。</summary>
    internal const string SystemPythonCommand = "python";

    /// <summary>拡張子が .py（大文字小文字は問わない）のファイルかを返す。</summary>
    internal static bool IsPythonScript(string path) =>
        string.Equals(Path.GetExtension(path), ".py", StringComparison.OrdinalIgnoreCase);

    /// <summary>venv フォルダから Python 実行ファイルのパスを返す。python 実行ファイルそのものならそのまま返す。無ければ null。</summary>
    internal static string? VenvInterpreter(string venvPath)
    {
        if (File.Exists(venvPath)) return venvPath;
        if (!Directory.Exists(venvPath)) return null;
        foreach (var candidate in InterpreterCandidates)
        {
            var interpreter = Path.Combine(venvPath, candidate);
            if (File.Exists(interpreter)) return interpreter;
        }
        return null;
    }

    /// <summary>
    /// スクリプトを実行する Python（パスまたはコマンド名）を返す。
    /// 優先順: スクリプトと同じ階層の .venv → 設定の venv → システムの Python。
    /// 設定した venv が使えないときは PythonEnvException（システムの Python で代わりに動かさない）。
    /// </summary>
    internal static string Resolve(string scriptPath, string? configuredVenv)
    {
        var scriptDir = Path.GetDirectoryName(scriptPath);
        var sibling = string.IsNullOrEmpty(scriptDir) ? null : VenvInterpreter(Path.Combine(scriptDir, SiblingVenvName));
        if (sibling is not null) return sibling;
        var configured = (configuredVenv ?? "").Trim();
        if (configured.Length == 0) return SystemPythonCommand;
        if (!Path.IsPathFullyQualified(configured))
            throw new PythonEnvException($"Python 実行環境（.venv）は絶対パスで指定してください: {configured}");
        return VenvInterpreter(configured)
            ?? throw new PythonEnvException($"Python 実行環境（.venv）が見つかりません: {configured}");
    }

    /// <summary>
    /// 埋め込んだ起動用ラッパーを directory へ書き出し、そのパスを返す。
    /// 一時フォルダが掃除されたときや、ランチャーの更新で中身が変わったときは書き直す（同じなら書かない）。
    /// </summary>
    internal static string EnsureRunWrapper(string directory)
    {
        using var stream = typeof(PythonEnv).Assembly.GetManifestResourceStream(RunWrapperResourceName)
            ?? throw new InvalidOperationException($"起動用ラッパーがランチャーに含まれていません: {RunWrapperResourceName}");
        using var memory = new MemoryStream();
        stream.CopyTo(memory);
        var content = memory.ToArray();
        var path = Path.Combine(directory, RunWrapperFileName);
        if (File.Exists(path) && File.ReadAllBytes(path).AsSpan().SequenceEqual(content)) return path;
        Directory.CreateDirectory(directory);
        File.WriteAllBytes(path, content);
        return path;
    }

    /// <summary>指定した Python で、起動用ラッパー経由でスクリプトを実行する起動情報（current dir はスクリプトの親フォルダ）。</summary>
    internal static ProcessStartInfo BuildRunStartInfo(string scriptPath, string interpreter, string wrapperPath)
    {
        // 標準入出力をつなぎ替えないので、コンソールを持たないランチャーから起動すると新しいコンソールが開く
        var info = new ProcessStartInfo(interpreter)
        {
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(scriptPath) ?? Environment.CurrentDirectory,
        };
        info.ArgumentList.Add(wrapperPath);
        info.ArgumentList.Add(scriptPath);
        return info;
    }
}
