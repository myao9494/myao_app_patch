/**
 * WPF ランチャーの常時保持メモ（Scratchpad）の本文と自動保存。
 *
 * 【仕様】
 * - アプリ（App）が 1 つだけ持ち、ウィンドウを閉じても保存処理が中断されないようにする（保存はアプリ側の HTTP クライアントで行う）。
 * - Update() のたびに保存タイマーを掛け直し、入力が止まってから最後の内容だけを保存する（デバウンス）。
 * - FlushAsync() は同時に 1 つしか走らない。保存の通信中に入力された内容は未保存のまま残し、次の保存で必ず届ける（版番号で判定）。
 * - 保存に失敗したら未保存のまま残し、Status を「保存失敗: 理由」にする。
 * - Load() はサーバーから読んだ値を反映する。手元で一度でも編集した後は反映しない（行き違った古い値で上書きしない）。
 **/
using System.Net.Http;

namespace LocalSearchLauncher;

/// <summary>常時保持メモの本文・未保存状態・保存タイマーをまとめる。</summary>
internal sealed class LauncherMemoStore : IDisposable
{
    private readonly Func<string, Task> _save;
    private readonly TimeSpan _debounce;
    private readonly object _lock = new();
    private readonly SemaphoreSlim _saveGate = new(1, 1);
    private readonly Timer _timer;
    private long _revision;
    private long _savedRevision;

    public LauncherMemoStore(Func<string, Task> save, TimeSpan debounce)
    {
        _save = save;
        _debounce = debounce;
        _timer = new Timer(_ => _ = FlushAsync(), null, Timeout.Infinite, Timeout.Infinite);
    }

    public string Text { get; private set; } = "";
    public string Status { get; private set; } = "自動保存（人間が消すまで保持）";
    public bool IsDirty { get { lock (_lock) return _revision != _savedRevision; } }

    /// <summary>保存状態が変わったときに通知する（呼び出し元のスレッドは問わない）。</summary>
    public event Action? Changed;

    /// <summary>サーバーから読んだメモを反映する。手元で編集済みなら反映せず false。</summary>
    public bool Load(string text)
    {
        lock (_lock)
        {
            if (_revision != 0) return false;
            Text = text ?? "";
        }
        Changed?.Invoke();
        return true;
    }

    /// <summary>入力された本文を記録し、保存タイマーを掛け直す。</summary>
    public void Update(string text)
    {
        lock (_lock)
        {
            Text = text ?? "";
            _revision++;
            Status = "未保存…";
        }
        _timer.Change(_debounce, Timeout.InfiniteTimeSpan);
        Changed?.Invoke();
    }

    /// <summary>未保存の編集があれば保存する。保存できた（または不要だった）ら true。</summary>
    public async Task<bool> FlushAsync()
    {
        await _saveGate.WaitAsync();
        try
        {
            string text;
            long revision;
            lock (_lock)
            {
                if (_revision == _savedRevision) return true;
                text = Text;
                revision = _revision;
            }
            try
            {
                await _save(text);
            }
            catch (Exception error) when (error is HttpRequestException or TaskCanceledException or InvalidOperationException)
            {
                lock (_lock) { Status = $"保存失敗: {error.Message}"; }
                Changed?.Invoke();
                return false;
            }
            lock (_lock)
            {
                _savedRevision = Math.Max(_savedRevision, revision);
                Status = _revision == _savedRevision ? "保存済み（常時保持）" : "未保存…";
            }
            Changed?.Invoke();
            return true;
        }
        finally
        {
            _saveGate.Release();
        }
    }

    public void Dispose()
    {
        _timer.Dispose();
        _saveGate.Dispose();
    }
}
