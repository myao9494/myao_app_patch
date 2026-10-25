/**
 * 差分メモ画面の左サイドバー（追加ボタン・描画ツール・メモ一覧）と、選択中メモの編集欄。
 * 状態は MemoDiffApp が持ち、ここでは表示と操作の受け渡しだけを行う。
 */
import React from "react";
import { MessageSquarePlus } from "lucide-react";
import { MEMO_ANNOTATION_TYPES, memoAnnotationTypeLabel, memoColor } from "./memoModel.js";

export function MemoSidebar({
  notes,
  selectedNoteId,
  annotationTool,
  onAddNote,
  onAddLeaderLine,
  onAddSticky,
  onSelectTool,
  onFocusNote,
  onNoteContextMenu,
}) {
  return (
    <aside className="memo-sidebar" aria-label="メモ一覧">
      <button type="button" className="primary memo-sidebar-action" onClick={onAddNote}>
        <MessageSquarePlus size={17} />
        メモ追加 <kbd>T</kbd>
      </button>
      <button type="button" className="memo-sidebar-action" onClick={onAddLeaderLine}>
        <span className="memo-line-icon">／</span>
        ライン追加 <kbd>L</kbd>
      </button>
      <button type="button" className="memo-sidebar-action sticky-action" data-sticky-add onClick={onAddSticky}>
        <span className="sticky-icon">付</span>
        付箋追加 <kbd>N</kbd>
      </button>
      <div className="memo-annotation-tools" aria-label="変更範囲の描画">
        {MEMO_ANNOTATION_TYPES.map((type) => (
          <button
            type="button"
            key={type.id}
            className={annotationTool === type.id ? "active" : ""}
            title={selectedNoteId ? `${type.label}を画像上でドラッグして追加` : "先にメモを選択してください"}
            onClick={() => onSelectTool(type.id)}
          >
            {type.label} <kbd>{type.shortcut}</kbd>
          </button>
        ))}
      </div>
      {annotationTool && <p className="memo-tool-hint">画像上をドラッグして{memoAnnotationTypeLabel(annotationTool)}を描画</p>}
      <div className="memo-list-heading">メモ一覧（{notes.length}）</div>
      <div className="memo-list">
        {notes.map((note) => (
          <button
            type="button"
            key={note.id}
            className={`memo-list-item ${selectedNoteId === note.id ? "selected" : ""}`}
            style={{ "--memo-list-color": memoColor(note).line }}
            data-memo-list-id={note.id}
            onClick={() => onFocusNote(note.id)}
            onContextMenu={(event) => onNoteContextMenu(event, note)}
          >
            <span className="memo-list-copy">
              <span className="memo-list-text">{note.text.trim() || "めも"}</span>
            </span>
          </button>
        ))}
        {!notes.length && <p className="memo-list-empty">Tキーまたは上のボタンで追加</p>}
      </div>
    </aside>
  );
}

export function MemoNoteEditor({
  note,
  annotation,
  editing,
  onActivateEditing,
  onChangeText,
  onFinishEditing,
  onChangeFields,
  onChangeAnnotation,
}) {
  return (
    <section className="memo-editor" aria-label="選択中メモの編集">
      <label className="control memo-text-control">
        <span>{editing ? "メモ本文（編集中）" : "メモ本文（クリックで編集）"}</span>
        <textarea
          value={note.text}
          readOnly={!editing}
          tabIndex={editing ? 0 : -1}
          className={editing ? "editing" : ""}
          onClick={(event) => onActivateEditing(note.id, event.currentTarget)}
          onFocus={(event) => {
            if (!editing) event.currentTarget.blur();
          }}
          onChange={(event) => onChangeText(note.id, event.target.value)}
          onKeyDown={(event) => onFinishEditing(event, note.id)}
        />
      </label>
      <label className="control compact-control">
        <span>メモ透過率 {note.opacity}%</span>
        <input
          type="range"
          min="20"
          max="100"
          value={note.opacity}
          onChange={(event) => onChangeFields(note.id, { opacity: Number(event.target.value) })}
        />
      </label>
      <label className="control compact-control">
        <span>文字サイズ {note.fontSize}px</span>
        <input
          type="range"
          min="12"
          max="48"
          value={note.fontSize}
          onChange={(event) => onChangeFields(note.id, { fontSize: Number(event.target.value) })}
        />
      </label>
      <label className="check-control">
        <input
          type="checkbox"
          checked={note.autoSize}
          onChange={(event) => onChangeFields(note.id, { autoSize: event.target.checked })}
        />
        <span>文字数に合わせて自動調整</span>
      </label>
      {annotation?.type === "arrow" && (
        <div className="memo-arrow-controls" aria-label="選択中の矢印設定">
          <label className="control compact-control">
            <span>矢印の線の太さ {annotation.strokeWidth}px</span>
            <input
              type="range"
              min="1"
              max="12"
              step="1"
              value={annotation.strokeWidth}
              onChange={(event) => onChangeAnnotation({ strokeWidth: Number(event.target.value) })}
            />
          </label>
          <label className="control compact-control">
            <span>矢印の大きさ {annotation.arrowHeadSize}px</span>
            <input
              type="range"
              min="6"
              max="32"
              step="1"
              value={annotation.arrowHeadSize}
              onChange={(event) => onChangeAnnotation({ arrowHeadSize: Number(event.target.value) })}
            />
          </label>
        </div>
      )}
    </section>
  );
}
