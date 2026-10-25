/**
 * テキスト差分の左右表示。変更後の行はその場で編集でき、行ごとにHEAD側の内容へ戻せる。
 * 行番号は共通行・置換行が左右同じ通し番号、追加行は「A」、削除行は「D」（Backend の text_diff.py が生成）。
 */
import React, { useMemo } from "react";
import { ArrowRight, FileText, Save } from "lucide-react";
import { normalizeLineEndings } from "../lib/util.js";

export function TextDiffView({ file, item, memo, busy, previewBusy, dirty, onEditText, onSave, onRevertLine, onMemoChange }) {
  const canRevertFile = Boolean(file.has_head && file.has_current);
  const editableLines = useMemo(() => normalizeLineEndings(item?.text_current ?? "").split("\n"), [item?.text_current]);
  return (
    <section className="text-diff-section">
      <div className="text-diff-heading">
        <div>
          <button
            type="button"
            className="btn btn-primary text-save-button"
            disabled={!dirty || busy || previewBusy}
            onClick={onSave}
            title="変更後の内容を元のテキストファイルへ保存（Ctrl/Cmd+S）"
          >
            <Save size={15} />
            保存
          </button>
          {dirty ? <span className="unsaved-badge">未保存の編集があります</span> : <span className="text-edit-hint">右側の行はその場で編集できます</span>}
        </div>
        <label>
          <FileText size={15} />
          <textarea
            aria-label="このファイルのメモ（HTMLへ出力）"
            title="このファイルのメモ（HTMLへ出力）"
            value={memo}
            placeholder="確認事項や変更理由を入力"
            onChange={(event) => onMemoChange(event.target.value)}
          />
        </label>
      </div>
      <div className="text-diff-columns" aria-label="テキスト差分">
        <div className="text-column-title">変更前: {file.head_path}</div>
        <div className="text-column-title text-diff-action-title" aria-hidden="true" />
        <div className="text-column-title">変更後: {file.path}</div>
        {(item?.rows ?? []).map((row, index) => (
          <React.Fragment key={`${row.old_number ?? "x"}-${row.new_number ?? "x"}-${index}`}>
            <DiffCodeCell side="old" row={row} />
            <DiffActionCell row={row} busy={busy || previewBusy} onRevertLine={canRevertFile ? onRevertLine : null} />
            <DiffCodeCell
              side="new"
              row={row}
              editable
              editableText={Number.isInteger(row.new_index) ? editableLines[row.new_index] ?? row.new ?? "" : row.new ?? ""}
              onEdit={onEditText}
              disabled={busy}
            />
          </React.Fragment>
        ))}
        {!item && <div className="text-diff-empty">差分を読み込んでいます。</div>}
      </div>
    </section>
  );
}

function DiffActionCell({ row, busy, onRevertLine }) {
  const canRevert = Boolean(
    onRevertLine
      && ["replace", "insert", "delete"].includes(row.kind)
      && Number.isInteger(row.old_index)
      && Number.isInteger(row.new_index),
  );
  return (
    <div className={`diff-action-cell ${canRevert ? "has-action" : ""}`}>
      {canRevert && (
        <button
          type="button"
          disabled={busy}
          title="HEAD側の内容を変更後ファイルへ反映して元に戻す"
          aria-label="HEAD側の内容を変更後ファイルへ反映して元に戻す"
          onClick={() => onRevertLine(row)}
        >
          <ArrowRight size={17} />
        </button>
      )}
    </div>
  );
}

function DiffLineEditor({ number, row, value, segments, onEdit, disabled }) {
  const segmentText = segments?.map((segment) => segment.text).join("") ?? "";
  const showHighlight = Boolean(segments?.length && segmentText === value);

  return (
    <span className="diff-line-editor-wrap">
      <span className="diff-line-sizer" aria-hidden="true">
        {showHighlight ? segments.map((segment, index) => (
          <mark key={index} className={segment.changed ? "changed" : ""}>{segment.text}</mark>
        )) : (value || " ")}
        {"\n"}
      </span>
      <textarea
        className="diff-line-editor"
        aria-label={`変更後 ${number ?? ""}行目`}
        rows={1}
        wrap="soft"
        value={value}
        disabled={disabled}
        spellCheck="false"
        onChange={(event) => onEdit(row, event.target.value)}
      />
    </span>
  );
}

function DiffCodeCell({ side, row, editable = false, editableText = "", onEdit, disabled = false }) {
  const number = side === "old" ? row.old_number : row.new_number;
  const text = side === "old" ? row.old : row.new;
  const segments = side === "old" ? row.old_segments : row.new_segments;
  const className = side === "old"
    ? row.kind === "delete" || row.kind === "replace" ? "removed" : row.kind === "insert" ? "added-gap" : ""
    : row.kind === "insert" || row.kind === "replace" ? "added" : row.kind === "delete" ? "removed-gap" : "";
  return (
    <div className={`diff-code-cell ${className}`}>
      <span className="line-number">{number ?? ""}</span>
      <code>{editable && side === "new" && row.new !== null && Number.isInteger(row.new_index) ? (
        <DiffLineEditor
          number={number}
          row={row}
          value={editableText}
          segments={segments}
          onEdit={onEdit}
          disabled={disabled}
        />
      ) : segments ? segments.map((segment, index) => (
        <mark key={index} className={segment.changed ? "changed" : ""}>{segment.text}</mark>
      )) : row.kind === "insert" || row.kind === "delete" ? <mark className="changed">{text ?? ""}</mark> : text ?? ""}</code>
    </div>
  );
}
