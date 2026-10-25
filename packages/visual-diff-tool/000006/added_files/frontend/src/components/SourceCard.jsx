/**
 * ファイル差分の比較元（A: 基準 / B: 比較対象）を選ぶカード。
 * クリックでファイル選択、ドラッグ＆ドロップ、フォーカス中の Ctrl/Cmd+V 貼り付けに対応し、
 * 複数ページ（PDF/TIFF）はページを選べる。
 */
import React, { useRef, useState } from "react";
import { FileImage, Layers, Upload } from "lucide-react";
import { firstDroppedFile } from "../lib/files.js";

export function SourceCard({ label, role, side, active, data, page, setPage, onFile, onActivate, onPasteImage }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const pages = data?.metadata?.pages ?? [];
  const selected = Boolean(data);

  function handleDrop(event) {
    event.preventDefault();
    setDragging(false);
    onActivate(side);
    const file = firstDroppedFile(event.dataTransfer);
    if (file) onFile(file);
  }

  return (
    <div
      className={`source-card ${selected ? "selected" : "empty"} ${active ? "active" : ""} ${dragging ? "dragging" : ""}`}
      tabIndex={0}
      onFocus={() => onActivate(side)}
      onClick={() => onActivate(side)}
      onPaste={(event) => onPasteImage(side, event)}
      onDragEnter={(event) => {
        event.preventDefault();
        setDragging(true);
        onActivate(side);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false);
      }}
      onDrop={handleDrop}
    >
      <span className={`source-tag ${side}`}>{label}</span>
      <div className="source-body">
        <span className="source-role">{role}</span>
        {selected ? (
          <>
            <strong className="source-name" title={data.file?.name}>{data.file?.name}</strong>
            <span className="source-meta">
              {data.metadata.format.toUpperCase()}
              {data.metadata.page_count > 1 ? ` ・ ${data.metadata.page_count}ページ` : ""}
              {data.attachment ? " ・ 貼り付け" : ""}
            </span>
          </>
        ) : (
          <span className="source-placeholder">ドロップ / クリック / Ctrl+V</span>
        )}
      </div>
      {pages.length > 1 && (
        <label className="source-page" title="比較するページ" onClick={(event) => event.stopPropagation()}>
          <Layers size={14} />
          <select value={page} onChange={(event) => setPage(Number(event.target.value))}>
            {pages.map((item) => (
              <option key={item.index} value={item.index}>
                {item.index + 1} / {pages.length}
              </option>
            ))}
          </select>
        </label>
      )}
      <button
        type="button"
        className="btn btn-ghost source-pick"
        onClick={(event) => {
          event.stopPropagation();
          inputRef.current?.click();
        }}
      >
        {selected ? <FileImage size={15} /> : <Upload size={15} />}
        {selected ? "変更" : "選択"}
      </button>
      <input
        ref={inputRef}
        type="file"
        hidden
        onChange={(event) => {
          if (event.target.files?.[0]) {
            onFile(event.target.files[0]);
            event.target.value = "";
          }
        }}
      />
    </div>
  );
}
