/**
 * スケジューラー画面。
 * インデックス更新を開始する日時と対象フォルダ（複数）を指定して予約し、実行状況とログを表示する。
 */
import type { UseSchedulerResult } from "../hooks/useScheduler";

type SchedulerPageProps = {
  scheduler: UseSchedulerResult;
  onToggleMenu: () => void;
};

export function SchedulerPage({ scheduler, onToggleMenu }: SchedulerPageProps) {
  const {
    handleAddSchedulerPath,
    handlePickSchedulerFolder,
    handleStartScheduler,
    isStartingScheduler,
    schedulerPathDraft,
    schedulerPaths,
    schedulerStartAt,
    schedulerState,
    setSchedulerPathDraft,
    setSchedulerPaths,
    setSchedulerStartAt,
  } = scheduler;

  return (
    <section className="scheduler-panel">
      <div className="indexed-targets-panel-header">
        <div className="section-header">
          <div>
            <h2>スケジューラー</h2>
            <div className="form-help">
              指定した開始日時になると、登録済みフォルダを別プロセスで順次インデックスします。
            </div>
          </div>
          <div className="section-header-actions">
            <span>{schedulerState?.status ?? "idle"}</span>
            <button className="menu-button" onClick={onToggleMenu} type="button" aria-label="設定">
              <svg fill="currentColor" viewBox="0 0 24 24" width="24" height="24">
                <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"></path>
              </svg>
            </button>
          </div>
        </div>
      </div>

      <div className="scheduler-card">
        <label className="form-help" htmlFor="scheduler-start-at">
          開始日時
        </label>
        <input
          id="scheduler-start-at"
          className="search-input"
          value={schedulerStartAt}
          onChange={(event) => setSchedulerStartAt(event.target.value)}
          type="datetime-local"
        />

        <div className="scheduler-path-editor">
          <label className="form-help" htmlFor="scheduler-path-input">
            対象パス
          </label>
          <div className="scheduler-path-actions">
            <input
              id="scheduler-path-input"
              className="search-input"
              value={schedulerPathDraft}
              onChange={(event) => setSchedulerPathDraft(event.target.value)}
              placeholder="/Users/name/Documents/project-a"
            />
            <button className="secondary-button" onClick={() => handleAddSchedulerPath(schedulerPathDraft)} type="button">
              フォルダを追加
            </button>
            <button className="secondary-button" onClick={() => void handlePickSchedulerFolder()} type="button">
              フォルダ選択
            </button>
          </div>
          <div className="scheduler-path-list">
            {schedulerPaths.length === 0 ? (
              <div className="form-help">まだ対象フォルダはありません。</div>
            ) : (
              schedulerPaths.map((path) => (
                <div className="scheduler-path-item" key={path}>
                  <div className="scheduler-path-text">{path}</div>
                  <button
                    className="secondary-button"
                    onClick={() => setSchedulerPaths((current) => current.filter((item) => item !== path))}
                    type="button"
                  >
                    削除
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="scheduler-actions">
          <button className="secondary-button settings-save-button" onClick={() => void handleStartScheduler()} type="button" disabled={isStartingScheduler}>
            {isStartingScheduler ? "開始中..." : "スケジュール開始"}
          </button>
        </div>
      </div>

      <div className="status-card scheduler-status-card">
        <div>状態: {schedulerState?.status ?? "-"}</div>
        <div>開始予定: {schedulerState?.start_at ? new Date(schedulerState.start_at).toLocaleString() : "-"}</div>
        <div>最終開始: {schedulerState?.last_started_at ? new Date(schedulerState.last_started_at).toLocaleString() : "-"}</div>
        <div>最終完了: {schedulerState?.last_finished_at ? new Date(schedulerState.last_finished_at).toLocaleString() : "-"}</div>
        <div>処理中パス: {schedulerState?.current_path ?? "-"}</div>
        <div>最終エラー: {schedulerState?.last_error ?? "-"}</div>
      </div>

      <div className="scheduler-log-panel">
        <div className="section-header">
          <h3>ログ</h3>
          <span>{schedulerState?.logs.length ?? 0}件</span>
        </div>
        <div className="scheduler-log-list">
          {schedulerState?.logs.length ? (
            schedulerState.logs.map((item, index) => (
              <div className={`scheduler-log-item ${item.level}`} key={`${item.logged_at}-${index}`}>
                <div className="scheduler-log-meta">
                  <span>{new Date(item.logged_at).toLocaleString()}</span>
                  <span>{item.level}</span>
                </div>
                <div>{item.message}</div>
                {item.folder_path ? <div className="scheduler-log-path">{item.folder_path}</div> : null}
              </div>
            ))
          ) : (
            <div className="form-help">ログはまだありません。</div>
          )}
        </div>
      </div>
    </section>
  );
}
