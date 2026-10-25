/**
 * Git差分の左サイドバー。フォルダー／Markdownの指定、変更ファイルの一覧（種類・変更種別・絞り込み）、
 * HTML出力に含めるファイルのチェック、HTMLプレビューの作成をまとめる。
 * ファイルは ← / → キーでも順に移動できる。
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, ChevronDown, Download, FileText, FolderOpen, Image, Loader2, PenTool, RefreshCw, Search } from "lucide-react";
import { changeTypeLabel } from "./gitLabels.js";

const KIND_ICONS = { image: Image, text: FileText, "3d": Box };

export function GitSidebar({
  folder,
  folderHistory,
  onFolderChange,
  onLoad,
  info,
  files,
  targets,
  currentFile,
  currentView,
  busy,
  onSelectTarget,
  excludedPaths,
  onToggleExport,
  onIncludeAll,
  onExcludeAll,
  onExport,
  exportBusy,
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const folderInputRef = useRef(null);

  // 長いパスは末尾（フォルダー名・ファイル名）が見えるようにする。入力中は触らない。
  useEffect(() => {
    const input = folderInputRef.current;
    if (input && document.activeElement !== input) input.scrollLeft = input.scrollWidth;
  }, [folder, info]);
  const [filterText, setFilterText] = useState("");
  const query = filterText.trim().toLowerCase();
  const visibleFiles = useMemo(
    () => (query ? files.filter((file) => file.path.toLowerCase().includes(query)) : files),
    [files, query],
  );
  const exportCount = files.filter((file) => !excludedPaths.includes(file.path)).length;

  function targetIndex(file, mode) {
    return targets.findIndex((target) => target.file.path === file.path && (!mode || target.mode === mode));
  }

  return (
    <aside className="git-sidebar" aria-label="Gitの変更ファイル">
      <div className="git-source">
        <label className="field-label" htmlFor="git-folder-input">リポジトリのフォルダー / Markdown</label>
        <div className="git-source-row">
          <div className="git-folder-box">
            <input
              id="git-folder-input"
              ref={folderInputRef}
              className="input"
              title={folder}
              type="text"
              value={folder}
              placeholder="/path/to/repo または note.md"
              onChange={(event) => onFolderChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onLoad();
              }}
              onBlur={(event) => {
                event.currentTarget.scrollLeft = event.currentTarget.scrollWidth;
              }}
            />
            <button
              type="button"
              className="git-history-toggle"
              title="最近使ったフォルダー"
              aria-label="最近使ったフォルダー"
              aria-expanded={historyOpen}
              disabled={!folderHistory.length}
              onClick={() => setHistoryOpen((open) => !open)}
            >
              <ChevronDown size={15} />
            </button>
            {historyOpen && folderHistory.length > 0 && (
              <div className="git-history" role="listbox" aria-label="最近使ったフォルダー">
                {folderHistory.map((item) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={item === folder}
                    key={item}
                    title={item}
                    onClick={() => {
                      onFolderChange(item);
                      setHistoryOpen(false);
                    }}
                  >
                    {item}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button type="button" className="btn btn-primary btn-icon" title={info ? "再読み込み" : "読み込み"} aria-label="読み込み" disabled={!folder || busy} onClick={() => onLoad()}>
            {busy ? <Loader2 className="spin" size={16} /> : info ? <RefreshCw size={16} /> : <FolderOpen size={16} />}
          </button>
        </div>
        {info && (
          <p className="git-source-meta">
            {files.length}件の変更{info.source_markdown ? " ・ Markdownのリンク先のみ" : ""}
          </p>
        )}
      </div>

      {info ? (
        <>
          {files.length > 3 && (
            <label className="git-filter">
              <Search size={14} />
              <input type="text" value={filterText} placeholder="ファイル名で絞り込み" onChange={(event) => setFilterText(event.target.value)} />
            </label>
          )}
          <ul className="git-file-list">
            {visibleFiles.map((file) => {
              const Icon = KIND_ICONS[file.kind] ?? FileText;
              const included = !excludedPaths.includes(file.path);
              const isCurrent = currentFile?.path === file.path;
              const name = file.path.split("/").pop();
              const dir = file.path.slice(0, file.path.length - name.length);
              const excalidrawIndex = file.kind === "text" && file.embedded_excalidraw ? targetIndex(file, "excalidraw") : -1;
              return (
                <li key={file.path} className={isCurrent ? "current" : ""}>
                  <div className={`git-file ${isCurrent && currentView !== "excalidraw" ? "active" : ""}`}>
                    <input
                      type="checkbox"
                      checked={included}
                      title="HTML出力に含める"
                      aria-label={`${file.path} をHTML出力に含める`}
                      onChange={(event) => onToggleExport(file.path, event.target.checked)}
                    />
                    <button type="button" className="git-file-main" onClick={() => onSelectTarget(targetIndex(file))} title={file.path}>
                      <Icon size={16} className={`kind-icon kind-${file.kind}`} />
                      <span className="git-file-text">
                        <span className="git-file-name">{name}</span>
                        {dir && <span className="git-file-dir">{dir}</span>}
                      </span>
                      <span className={`badge ${file.change_type}`}>{changeTypeLabel(file.change_type)}</span>
                    </button>
                  </div>
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
                </li>
              );
            })}
            {!visibleFiles.length && <li className="git-empty">{files.length ? "一致するファイルがありません" : "変更されたファイルはありません"}</li>}
          </ul>
          <div className="git-export">
            <div className="git-export-head">
              <span>HTML出力 <strong>{exportCount}</strong> / {files.length}</span>
              <span className="git-export-toggles">
                <button type="button" className="link-button" disabled={!files.length} onClick={onIncludeAll}>すべて</button>
                <button type="button" className="link-button" disabled={!files.length} onClick={onExcludeAll}>なし</button>
              </span>
            </div>
            <button type="button" className="btn btn-primary" disabled={!exportCount || busy || exportBusy} onClick={onExport}>
              {exportBusy ? <Loader2 className="spin" size={16} /> : <Download size={16} />}
              HTMLプレビューを作成
            </button>
          </div>
        </>
      ) : (
        <div className="git-intro">
          <FolderOpen size={30} strokeWidth={1.5} />
          <p>Git管理しているフォルダー、またはObsidianのMarkdownファイルを指定すると、HEAD（最後のコミット）からの変更を一覧します。</p>
          <ul>
            <li>画像・図面は位置を合わせて差分を表示</li>
            <li>テキストは左右に並べて行ごとに比較・編集</li>
            <li>STEPファイルは3Dで比較</li>
          </ul>
        </div>
      )}
    </aside>
  );
}
