/**
 * Git差分の左サイドバーに出す「ファイルの履歴」。変更一覧のファイルの履歴ボタンから開く。
 * そのファイルを変えたコミットを古い順に並べ、最後に作業ツリーの変更（未コミット）を置く。
 * 各段を選ぶと「直前のコミット → そのコミット」の差分を、変更一覧と同じビューアで表示する（縦に並ぶので ↑ / ↓ でも移動）。
 * Markdown は、各コミットにある埋め込みExcalidraw図・3D表示をサブ項目として並べる。
 */
import React, { useEffect, useRef } from "react";
import { ArrowLeft, Box, GitCommitHorizontal, Loader2, PenTool, Pencil } from "lucide-react";
import { changeTypeLabel } from "./gitLabels.js";
import { formatCommitDate } from "./gitHistory.js";
import { cadViewKey, cadViewLabel, cadViewMode } from "../cad-view/cadViewModel.js";

export function GitHistoryList({ history, targets, currentFile, currentView, onSelectTarget, onClose }) {
  const listRef = useRef(null);
  const { file, steps = [], loading, error, limit } = history;
  const name = file.path.split("/").pop();
  const commitCount = steps.filter((step) => step.commit).length;

  // 選んだ段が見えるようにする（← / → で移動したときも）
  useEffect(() => {
    listRef.current?.querySelector(".git-history-step.active, .git-subtarget.active")?.scrollIntoView({ block: "nearest" });
  }, [currentFile, currentView]);

  function targetIndex(step, mode) {
    return targets.findIndex((target) => target.file === step && (!mode || target.mode === mode));
  }

  return (
    <div className="git-file-history">
      <div className="git-file-history-head">
        <button type="button" className="btn btn-ghost git-file-history-back" onClick={onClose} title="変更一覧へ戻る">
          <ArrowLeft size={14} />変更一覧へ
        </button>
        <div className="git-file-history-title" title={file.path}>
          <strong>{name}</strong>
          <span>
            {loading ? "履歴を読み込んでいます…" : `${commitCount}件のコミット${limit && commitCount >= limit ? `（新しい${limit}件まで）` : ""}`}
          </span>
        </div>
      </div>
      {error && <p className="git-file-history-error">{error}</p>}
      <ol className="git-history-steps" ref={listRef} aria-label={`${file.path} の履歴（古い順）`}>
        {loading && (
          <li className="git-empty"><Loader2 className="spin" size={14} /> 読み込み中</li>
        )}
        {steps.map((step) => {
          const isCurrent = currentFile === step;
          const subViewOpen = currentView === "excalidraw" || cadViewKey(currentView) !== null;
          const index = targetIndex(step);
          const excalidrawIndex = step.kind === "text" && step.embedded_excalidraw ? targetIndex(step, "excalidraw") : -1;
          const cadViews = step.kind === "text" ? step.cad_views ?? [] : [];
          const renamed = step.head_path !== step.path && step.has_head;
          return (
            <li key={step.commit?.sha ?? "worktree"} className={isCurrent ? "current" : ""}>
              <button
                type="button"
                className={`git-history-step ${isCurrent && !subViewOpen ? "active" : ""}`}
                onClick={() => index >= 0 && onSelectTarget(index)}
                title={step.commit ? `${step.commit.sha}\n${step.commit.subject}` : "まだコミットしていない変更（HEAD → 作業ツリー）"}
              >
                {step.commit ? <GitCommitHorizontal size={15} className="kind-icon" /> : <Pencil size={14} className="kind-icon" />}
                <span className="git-history-step-text">
                  <span className="git-history-step-subject">{step.commit ? step.commit.subject || "（メッセージなし）" : "作業ツリーの変更（未コミット）"}</span>
                  <span className="git-history-step-meta">
                    {step.commit ? (
                      <>
                        <code>{step.commit.short}</code>
                        <span>{formatCommitDate(step.commit.date)}</span>
                        <span>{step.commit.author}</span>
                      </>
                    ) : (
                      <span>HEAD → 作業ツリー</span>
                    )}
                  </span>
                  {renamed && <span className="git-history-step-meta">← {step.head_path}</span>}
                </span>
                <span className={`badge ${step.change_type}`}>{changeTypeLabel(step.change_type)}</span>
              </button>
              {excalidrawIndex >= 0 && (
                <button
                  type="button"
                  className={`git-subtarget ${isCurrent && currentView === "excalidraw" ? "active" : ""}`}
                  onClick={() => onSelectTarget(excalidrawIndex)}
                >
                  <PenTool size={14} />
                  埋め込みExcalidraw図
                </button>
              )}
              {cadViews.map((view) => {
                const mode = cadViewMode(view.key);
                const viewIndex = targetIndex(step, mode);
                if (viewIndex < 0) return null;
                return (
                  <button
                    key={mode}
                    type="button"
                    className={`git-subtarget ${isCurrent && currentView === mode ? "active" : ""}`}
                    title="ノートに表示している3D（視点・断面・注記）を画像として比べる"
                    onClick={() => onSelectTarget(viewIndex)}
                  >
                    <Box size={14} />
                    {cadViewLabel(view)}
                  </button>
                );
              })}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
