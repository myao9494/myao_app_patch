/**
 * デスクトップランチャー管理画面。
 * ランチャーの起動状態を表示し、起動・停止・再起動と、呼び出しキーの変更を行う。
 */
import type { UseLauncherResult } from "../hooks/useLauncher";

type LauncherPageProps = {
  launcher: UseLauncherResult;
  onToggleMenu: () => void;
};

export function LauncherPage({ launcher, onToggleMenu }: LauncherPageProps) {
  const {
    handleChangeLauncherHotkey,
    handleLauncherAction,
    isLauncherActionRunning,
    isSavingLauncherHotkey,
    launcherHotkey,
    launcherState,
    refreshLauncherState,
  } = launcher;

  return (
    <section className="launcher-panel">
      <div className="indexed-targets-panel-header">
        <div className="section-header">
          <div>
            <h2>ランチャー</h2>
            <div className="form-help">
              デスクトップランチャーの起動状態、停止・再起動、ログを確認できます。
            </div>
          </div>
          <div className="section-header-actions">
            <span>{launcherState?.status ?? "unknown"}</span>
            <button className="menu-button" onClick={onToggleMenu} type="button" aria-label="設定">
              <svg fill="currentColor" viewBox="0 0 24 24" width="24" height="24">
                <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"></path>
              </svg>
            </button>
          </div>
        </div>
      </div>

      <div className="launcher-control-grid">
        <div className="status-card launcher-status-card">
          <div>状態: {launcherState?.status ?? "-"}</div>
          <div>PID: {launcherState?.pid ?? "-"}</div>
          <div>終了コード: {launcherState?.returncode ?? "-"}</div>
          <div>自動起動: {launcherState?.autostart ? "有効" : "無効"}</div>
          <div>ログ: {launcherState?.log_path ?? "-"}</div>
        </div>

        <div className="scheduler-card launcher-actions-card">
          <label htmlFor="launcher-hotkey">表示・非表示のショートカット</label>
          <select
            id="launcher-hotkey"
            className="settings-select"
            value={launcherHotkey}
            onChange={(event) => void handleChangeLauncherHotkey(event.target.value as "command_option" | "double_shift")}
            disabled={isSavingLauncherHotkey}
          >
            <option value="command_option">Command + Option（Windows: Windows + Alt）</option>
            <option value="double_shift">Shift を2回</option>
          </select>
          <div className="form-help">保存後、ランチャーを再起動すると反映されます。</div>
        </div>

        <div className="scheduler-card launcher-actions-card">
          <button
            className="secondary-button settings-save-button"
            onClick={() => void handleLauncherAction("start")}
            type="button"
            disabled={isLauncherActionRunning || launcherState?.is_running}
          >
            起動
          </button>
          <button
            className="secondary-button settings-save-button"
            onClick={() => void handleLauncherAction("restart")}
            type="button"
            disabled={isLauncherActionRunning}
          >
            再起動
          </button>
          <button
            className="secondary-button danger settings-save-button"
            onClick={() => void handleLauncherAction("stop")}
            type="button"
            disabled={isLauncherActionRunning || !launcherState?.is_running}
          >
            停止
          </button>
          <button
            className="secondary-button settings-save-button"
            onClick={() => void refreshLauncherState()}
            type="button"
            disabled={isLauncherActionRunning}
          >
            再読込
          </button>
        </div>
      </div>

      <div className="scheduler-log-panel launcher-log-panel">
        <div className="section-header">
          <h3>ログ</h3>
          <span>{launcherState?.logs.length ?? 0}行</span>
        </div>
        <pre className="launcher-log-output">
          {launcherState?.logs.length ? launcherState.logs.join("\n") : "ログはまだありません。"}
        </pre>
      </div>
    </section>
  );
}
