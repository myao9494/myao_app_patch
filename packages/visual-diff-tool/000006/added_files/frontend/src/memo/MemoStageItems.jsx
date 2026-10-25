/**
 * 差分メモ画面のステージ（画像）上に置く要素: 付箋、描画（矢印・変更雲・矩形・楕円・マーカー）、メモと引出線。
 * 位置は画像に対する %、メモの大きさと引出線はステージ基準のpx（memoModel.js 参照）。
 * ドラッグなどの状態は MemoDiffApp が持ち、ここでは表示と操作の受け渡しだけを行う。
 */
import React from "react";
import { X } from "lucide-react";
import {
  memoAnnotationTypeLabel,
  memoBoxStyle,
  memoChangeTypeLabel,
  memoColor,
  memoLeaderHandleStyle,
  memoNoteLeaders,
  memoSize,
} from "./memoModel.js";

export function StickyNote({ sticky, onStartDrag, onChangeText, onFinishEditing, onDelete }) {
  return (
    <div
      className="memo-sticky"
      style={{
        left: `${sticky.x}%`,
        top: `${sticky.y}%`,
        width: `${sticky.width}px`,
        height: `${sticky.height}px`,
        "--sticky-font-size": `${sticky.fontSize}px`,
      }}
      onPointerDown={(event) => onStartDrag(event, sticky)}
    >
      <div
        className="sticky-grip"
        title="ドラッグして付箋を移動"
        aria-label="付箋を移動"
        onPointerDown={(event) => onStartDrag(event, sticky)}
      >
        <span>•••</span>
      </div>
      <textarea
        value={sticky.text}
        aria-label="独立した付箋"
        onChange={(event) => onChangeText(sticky.id, event.target.value)}
        onKeyDown={onFinishEditing}
      />
      <button type="button" className="sticky-delete" title="付箋を削除" onClick={() => onDelete(sticky.id)}>
        <X size={13} />
      </button>
    </div>
  );
}

export function MemoAnnotationShape({ note, annotation, selected, memoZoom, onSelect, onStartTransform, onStartEndpointDrag }) {
  const color = memoColor(note);
  return (
    <div
      className={`memo-annotation ${annotation.type} ${selected ? "selected" : ""}`}
      style={{
        left: `${annotation.x}%`,
        top: `${annotation.y}%`,
        width: `${annotation.width}%`,
        height: `${annotation.height}%`,
        "--annotation-color": color.line,
        "--annotation-opacity": annotation.opacity / 100,
        "--arrow-stroke-width": annotation.strokeWidth,
      }}
      title={`${memoAnnotationTypeLabel(annotation.type)}（${memoChangeTypeLabel(note.changeType)}）`}
      onPointerDown={(event) => onStartTransform(event, note, annotation, "move")}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(note.id, annotation.id);
      }}
    >
      {annotation.type === "arrow" && (
        <svg className="memo-arrow" aria-hidden="true">
          <defs>
            {/* 矢尻は表示倍率に合わせて大きさを変え、画像を拡大しても見た目の比率を保つ */}
            <marker
              id={`arrowhead-${annotation.id}`}
              viewBox="0 0 10 10"
              markerWidth={annotation.arrowHeadSize * (memoZoom / 100)}
              markerHeight={annotation.arrowHeadSize * (memoZoom / 100)}
              refX="9"
              refY="5"
              orient="auto"
              markerUnits="userSpaceOnUse"
              preserveAspectRatio="xMidYMid"
            >
              <path d="M0,0 L10,5 L0,10 Z" fill="var(--annotation-color)" />
            </marker>
          </defs>
          <line
            x1={annotation.reverseX ? "100%" : "0%"}
            y1={annotation.reverseY ? "100%" : "0%"}
            x2={annotation.reverseX ? "0%" : "100%"}
            y2={annotation.reverseY ? "0%" : "100%"}
            markerEnd={`url(#arrowhead-${annotation.id})`}
          />
        </svg>
      )}
      {selected && <>
        {annotation.type === "arrow" ? <>
          <button
            type="button"
            className="memo-arrow-endpoint start"
            style={{ left: annotation.reverseX ? "100%" : "0%", top: annotation.reverseY ? "100%" : "0%" }}
            aria-label="矢印の起点をドラッグ"
            title="ドラッグして矢印の起点を変更"
            onPointerDown={(event) => onStartEndpointDrag(event, note, annotation, "start")}
          />
          <button
            type="button"
            className="memo-arrow-endpoint end"
            style={{ left: annotation.reverseX ? "0%" : "100%", top: annotation.reverseY ? "0%" : "100%" }}
            aria-label="矢印の終点をドラッグ"
            title="ドラッグして矢印の終点を変更"
            onPointerDown={(event) => onStartEndpointDrag(event, note, annotation, "end")}
          />
        </> : <button
          type="button"
          className="memo-annotation-resize"
          aria-label="図形の大きさを変更"
          title="ドラッグして大きさを変更"
          onPointerDown={(event) => onStartTransform(event, note, annotation, "resize")}
        />}
      </>}
    </div>
  );
}

export function MemoNoteBox({
  note,
  selected,
  editing,
  onStartDrag,
  onActivateEditing,
  onContextMenu,
  onSelect,
  onStartLeaderDrag,
  onChangeText,
  onFinishEditing,
  onDelete,
}) {
  const leaders = memoNoteLeaders(note);
  const color = memoColor(note);
  return (
    <div
      data-note-id={note.id}
      className={`memo-note ${selected ? "selected" : ""} ${editing ? "editing" : ""}`}
      style={{
        ...memoBoxStyle(note),
        left: `${note.x}%`,
        top: `${note.y}%`,
        "--memo-alpha": note.opacity / 100,
        "--memo-font-size": `${note.fontSize}px`,
        "--memo-fill": color.fill,
        "--memo-border": color.border,
        "--memo-line": color.line,
      }}
      onPointerDown={(event) => onStartDrag(event, note)}
      onDoubleClick={(event) => {
        if (event.target.closest("button, .memo-leader-handle")) return;
        event.preventDefault();
        event.stopPropagation();
        onActivateEditing(note.id);
      }}
      onContextMenu={(event) => onContextMenu(event, note)}
    >
      <svg className="memo-leader" viewBox="-420 -240 1040 760" aria-hidden="true">
        {leaders.map((leader) => (
          <line
            key={leader.id}
            x1={leader.start.x}
            y1={leader.start.y}
            x2={leader.endX}
            y2={leader.endY}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onSelect(note.id);
            }}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(note.id);
            }}
            onContextMenu={(event) => onContextMenu(event, note)}
          />
        ))}
      </svg>
      {leaders.map((leader, index) => (
        <React.Fragment key={leader.id}>
          <button
            type="button"
            className={`memo-leader-handle ${index > 0 ? "extra" : ""}`}
            title="引出線の起点をドラッグ"
            data-line-id={leader.id}
            style={memoLeaderHandleStyle(leader.start, memoSize(note))}
            onPointerDown={(event) => onStartLeaderDrag(event, note, "start")}
          />
          <button
            type="button"
            className={`memo-leader-handle end ${index > 0 ? "extra" : ""}`}
            title="引出線の終点をドラッグ"
            data-line-id={leader.id}
            style={{ left: `${leader.endX}px`, top: `${leader.endY}px` }}
            onPointerDown={(event) => onStartLeaderDrag(event, note, "end")}
          />
        </React.Fragment>
      ))}
      <textarea
        value={note.text}
        aria-label="メモ本文"
        readOnly={!editing}
        tabIndex={editing ? 0 : -1}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onActivateEditing(note.id, event.currentTarget);
        }}
        onFocus={(event) => {
          if (!editing) event.currentTarget.blur();
        }}
        onChange={(event) => onChangeText(note.id, event.target.value)}
        onKeyDown={(event) => onFinishEditing(event, note.id)}
      />
      <button className="memo-delete" title="メモ削除" onClick={() => onDelete(note.id)}>
        <X size={14} />
      </button>
    </div>
  );
}
