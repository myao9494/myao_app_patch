namespace LocalSearchLauncher;

/// <summary>
/// 検索の失敗を、状態表示の文言へ変換する。
/// HttpClient.Timeout の超過は利用者の取り消しと同じ OperationCanceledException の派生型で通知されるため、
/// 例外の型ではなく、検索に渡したトークンが取り消されたかで見分ける。
/// </summary>
internal static class LauncherSearchFailure
{
    /// <summary>
    /// 表示する文言を返す。新しい検索に置き換えられた検索（トークンが取り消し済み）は null を返し、
    /// 実行中の検索の「検索中…」や結果を古い検索の失敗で上書きしない。
    /// </summary>
    public static string? StatusText(Exception error, CancellationToken token, TimeSpan timeout)
    {
        if (token.IsCancellationRequested) return null;
        return error is OperationCanceledException
            ? $"検索がタイムアウトしました（{timeout.TotalSeconds:0.#}秒）"
            : $"検索に失敗しました: {error.Message}";
    }
}
