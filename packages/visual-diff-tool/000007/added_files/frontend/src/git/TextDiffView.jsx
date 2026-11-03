/**
 * テキスト差分の左右表示。変更後の行はその場で編集でき、行ごとにHEAD側の内容へ戻せる。
 * 行番号は共通行・置換行が左右同じ通し番号、追加行は「A」、削除行は「D」（Backend の text_diff.py が生成）。
 * 長い差分（WINDOWING_MIN_ROWS 行以上）は BLOCK_ROWS 行ごとのブロックに分け、画面の近くのブロックだけ描画する。
 * 行ごとに編集欄があるため、3万行を全部描画すると開くのに数秒、1文字の入力ごとに約1秒かかる。
 * 短いファイルは全行を描画する（描画していない行はブラウザーのページ内検索で見つからないため）。
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, FileText, Save } from "lucide-react";
import { chunkItems, normalizeLineEndings } from "../lib/util.js";

const WINDOWING_MIN_ROWS = 3000;
const BLOCK_ROWS = 200;
const ESTIMATED_ROW_HEIGHT = 25; // 未描画ブロックの仮の高さ（1行 + 罫線）。描画後は実測値を使う
const RENDER_MARGIN = "1200px 0px"; // スクロールしても空白が見えないよう、画面外もこの範囲は描画しておく

export function TextDiffView({ file, item, memo, busy, previewBusy, dirty, onEditText, onSave, onRevertLine, onMemoChange }) {
  const canRevertFile = Boolean(file.has_head && file.has_current);
  const editableLines = useMemo(() => normalizeLineEndings(item?.text_current ?? "").split("\n"), [item?.text_current]);
  const rows = item?.rows ?? [];
  const blocks = useMemo(() => chunkItems(rows, BLOCK_ROWS), [rows]);
  const windowed = rows.length >= WINDOWING_MIN_ROWS;
  const scrollRef = useRef(null);
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
      <div className="text-diff-columns" aria-label="テキスト差分" ref={scrollRef}>
        <div className="text-column-title">変更前: {file.head_path}</div>
        <div className="text-column-title text-diff-action-title" aria-hidden="true" />
        <div className="text-column-title">変更後: {file.path}</div>
        {blocks.map((blockRows, blockIndex) => (
          <DiffRowBlock
            // ファイルが変わったら描画状態と実測の高さを持ち越さない
            key={`${file.path}-${blockIndex}`}
            rows={blockRows}
            windowed={windowed}
            initiallyVisible={blockIndex < 2}
            scrollRef={scrollRef}
          >
            {() => blockRows.map((row, rowIndex) => (
              <React.Fragment key={`${row.old_number ?? "x"}-${row.new_number ?? "x"}-${rowIndex}`}>
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
          </DiffRowBlock>
        ))}
        {!item && <div className="text-diff-empty">差分を読み込んでいます。</div>}
      </div>
    </section>
  );
}

/** 行のブロック。windowed のときは画面から離れている間、中身を描画せず同じ高さの空きだけを残す。 */
function DiffRowBlock({ rows, windowed, initiallyVisible, scrollRef, children }) {
  const blockRef = useRef(null);
  const heightRef = useRef(null);
  const [visible, setVisible] = useState(initiallyVisible);

  useEffect(() => {
    if (!windowed) return undefined;
    const block = blockRef.current;
    const observer = new IntersectionObserver(([entry]) => {
      // 編集中の行が消えるとフォーカスが失われるので、入力欄を含むブロックは残す
      if (!entry.isIntersecting && block.contains(document.activeElement)) return;
      if (!entry.isIntersecting) heightRef.current = entry.boundingClientRect.height;
      setVisible(entry.isIntersecting);
    }, { root: scrollRef.current, rootMargin: RENDER_MARGIN });
    observer.observe(block);
    return () => observer.disconnect();
  }, [windowed, scrollRef]);

  const rendered = !windowed || visible;
  const placeholderHeight = heightRef.current ?? rows.length * ESTIMATED_ROW_HEIGHT;
  return (
    <div className="text-diff-block" ref={blockRef} style={rendered ? undefined : { height: placeholderHeight }}>
      {rendered && children()}
    </div>
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
