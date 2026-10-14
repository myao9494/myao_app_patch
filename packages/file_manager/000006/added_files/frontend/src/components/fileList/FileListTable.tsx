/**
 * ファイル一覧のテーブル（フォルダを先に、続けてファイルを表示）
 * - 行: 選択・カーソル（focused）・ドラッグ先ハイライト。data-path / data-index は範囲選択や
 *   キーボード操作のスクロールで使うため変更しないこと
 * - チェックボックスで Enter: 選択済みなら開く、未選択なら選択
 * - フォルダ名クリックで移動、ファイル行ダブルクリックで開く
 * - 見出しクリックで並べ替え、見出しの右クリックはペインのメニュー
 * - Git 列: G キーで確認した結果（getGitStatusLabel / getGitStatusTitle）
 */
import type { DragEvent, MouseEvent } from "react";
import { ChevronDown, ChevronUp, Copy, Link } from "lucide-react";
import type { FileItem } from "../../types/file";
import { formatFileDate } from "../../utils/formatFileDate";
import { formatFileSize } from "../../utils/formatFileSize";
import type { FileListSortKey, FileListSortOrder } from "../../utils/fileListFilter";
import { getGitStatusLabel, getGitStatusTitle, type FolderGitStatus } from "../../utils/gitStatusDisplay";
import { FileIcon } from "../FileIcon";

interface FileListTableProps {
  folders: FileItem[];
  files: FileItem[];
  selectedItems: Set<string>;
  focusedIndex: number;
  dragOverPath: string | null;
  sortKey: FileListSortKey;
  sortOrder: FileListSortOrder;
  folderLatestModified: Record<string, string>;
  folderLatestModifiedLoading: Set<string>;
  gitStatuses: Record<string, FolderGitStatus>;
  isGitStatusLoading: boolean;
  onSort: (key: FileListSortKey) => void;
  onHeaderContextMenu: (e: MouseEvent<HTMLElement>) => void;
  onRowClick: (e: MouseEvent, item: FileItem, index: number) => void;
  onRowContextMenu: (e: MouseEvent, item: FileItem) => void;
  onToggleSelect: (path: string) => void;
  onOpenFolder: (path: string) => void;
  onOpenFile: (item: FileItem) => void;
  onCopyFullPath: (item: FileItem) => void;
  onCopyLink: (path: string, type: "file" | "directory") => void;
  onGitStatusAction: (item: FileItem) => void;
  onDragStart: (e: DragEvent, item: FileItem) => void;
  onDragOver: (e: DragEvent, path: string) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent, path: string) => void;
}

export function FileListTable({
  folders,
  files,
  selectedItems,
  focusedIndex,
  dragOverPath,
  sortKey,
  sortOrder,
  folderLatestModified,
  folderLatestModifiedLoading,
  gitStatuses,
  isGitStatusLoading,
  onSort,
  onHeaderContextMenu,
  onRowClick,
  onRowContextMenu,
  onToggleSelect,
  onOpenFolder,
  onOpenFile,
  onCopyFullPath,
  onCopyLink,
  onGitStatusAction,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
}: FileListTableProps) {
  const sortIcon = (col: FileListSortKey) => {
    if (sortKey !== col) return null;
    return sortOrder === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} />;
  };

  const renderCheckbox = (item: FileItem) => (
    <td className="checkbox-col" onClick={(e) => e.stopPropagation()}>
      <input
        type="checkbox"
        checked={selectedItems.has(item.path)}
        onChange={() => onToggleSelect(item.path)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          if (!selectedItems.has(item.path)) {
            onToggleSelect(item.path);
          } else if (item.type === "directory") {
            onOpenFolder(item.path);
          } else {
            onOpenFile(item);
          }
        }}
      />
    </td>
  );

  const renderCopyButtons = (item: FileItem) => (
    <>
      <button
        className="row-copy-btn"
        onClick={(e) => {
          e.stopPropagation();
          onCopyFullPath(item);
        }}
        title="フルパスをコピー"
      >
        <Copy size={12} />
      </button>
      <button
        className="row-copy-btn"
        onClick={(e) => {
          e.stopPropagation();
          onCopyLink(item.path, item.type);
        }}
        title="リンクをコピー"
      >
        <Link size={12} />
      </button>
    </>
  );

  const renderGitCell = (item: FileItem) => {
    const status = gitStatuses[item.path];
    if (!status) return null;
    const label = getGitStatusLabel(status);
    if (label === "-") {
      return <span title="Gitリポジトリ外、または変更・リモートとの差分なし">-</span>;
    }
    return (
      <button
        className="git-status-button"
        type="button"
        title={getGitStatusTitle(status)}
        onClick={(e) => {
          e.stopPropagation();
          onGitStatusAction(item);
        }}
      >
        {label}
      </button>
    );
  };

  return (
    <div className="table-container">
      <table className="file-table">
        <thead onContextMenu={onHeaderContextMenu}>
          <tr>
            <th className="checkbox-col"></th>
            <th className="name-col" onClick={() => onSort("name")}>
              Name {sortIcon("name")}
            </th>
            <th className="size-col" onClick={() => onSort("size")}>
              Size {sortIcon("size")}
            </th>
            <th className="date-col" onClick={() => onSort("date")}>
              Date {sortIcon("date")}
            </th>
            <th className="git-col" title="Gキーでペイン内フォルダのGit変更を確認">
              Git{isGitStatusLoading ? "…" : ""}
            </th>
          </tr>
        </thead>
        <tbody>
          {folders.map((item, index) => (
            <tr
              key={item.path}
              data-path={item.path}
              data-index={index}
              className={`${selectedItems.has(item.path) ? "selected" : ""} ${dragOverPath === item.path ? "drag-over" : ""} ${focusedIndex === index ? "focused" : ""}`}
              draggable
              onDragStart={(e) => onDragStart(e, item)}
              onDragOver={(e) => onDragOver(e, item.path)}
              onDragLeave={onDragLeave}
              onDrop={(e) => onDrop(e, item.path)}
              onContextMenu={(e) => onRowContextMenu(e, item)}
              onClick={(e) => onRowClick(e, item, index)}
            >
              {renderCheckbox(item)}
              <td className="name-cell">
                <div className="name-cell-content">
                  {renderCopyButtons(item)}
                  <div className="name-info-wrapper" onClick={() => onOpenFolder(item.path)}>
                    <FileIcon name={item.name} type="directory" className="icon" />
                    <span>{item.name}</span>
                  </div>
                </div>
              </td>
              <td className="size-col">
                <div className="cell-content">-</div>
              </td>
              <td className="date-col">
                <div className="cell-content">
                  {folderLatestModifiedLoading.has(item.path)
                    ? "…"
                    : formatFileDate(folderLatestModified[item.path] ?? item.modified)}
                </div>
              </td>
              <td className="git-col">{renderGitCell(item)}</td>
            </tr>
          ))}

          {files.map((item, fileIndex) => {
            const index = folders.length + fileIndex;
            return (
              <tr
                key={item.path}
                data-path={item.path}
                data-index={index}
                className={`${selectedItems.has(item.path) ? "selected" : ""} ${focusedIndex === index ? "focused" : ""}`}
                draggable
                onDragStart={(e) => onDragStart(e, item)}
                onContextMenu={(e) => onRowContextMenu(e, item)}
                onClick={(e) => onRowClick(e, item, index)}
                onDoubleClick={() => onOpenFile(item)}
              >
                {renderCheckbox(item)}
                <td className="name-cell">
                  <div className="name-cell-content">
                    {renderCopyButtons(item)}
                    <div className="name-info-wrapper">
                      <FileIcon name={item.name} type="file" className="icon" />
                      <span>{item.name}</span>
                    </div>
                  </div>
                </td>
                <td className="size-col">
                  <div className="cell-content">{formatFileSize(item.size)}</div>
                </td>
                <td className="date-col">
                  <div className="cell-content">{formatFileDate(item.modified)}</div>
                </td>
                <td className="git-col" />
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
