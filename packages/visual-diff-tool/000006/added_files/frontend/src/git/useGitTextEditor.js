/**
 * git差分のテキスト編集（変更後の行をその場で編集 → 差分プレビュー → 作業ファイルへ保存）。
 * - 編集のたびに /api/git/text-diff で差分行を取り直す（古い応答は requestId で捨てる）
 * - 元に戻す／やり直す の履歴はファイルごとに持ち、保存・ファイル切り替えで消える
 * - 保存は /api/git/save-text。読み込み時の本文（text_saved）を base_text として送り、
 *   外部でファイルが変わっていればサーバーが409で拒否する
 * - テキスト表示中は Ctrl/Cmd+S で保存、Ctrl/Cmd+Z / Shift+Z で元に戻す／やり直す
 */
import { useEffect, useRef, useState } from "react";
import { postJson } from "../lib/api.js";
import { normalizeLineEndings } from "../lib/util.js";

const EMPTY_HISTORY = { path: "", undo: [], redo: [] };

export function useGitTextEditor({ enabled, file, info, folder, textExtensions, item, setItem, onError, onNotice }) {
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState(EMPTY_HISTORY);
  const previewRequestRef = useRef(0);

  const dirty = Boolean(
    file?.kind === "text"
      && item
      && normalizeLineEndings(item.text_current ?? "") !== normalizeLineEndings(item.text_saved ?? ""),
  );

  function requestBody(extra) {
    return {
      folder: info.folder || folder,
      text_extensions: textExtensions,
      path: file.path,
      head_path: file.head_path,
      has_head: file.has_head,
      ...extra,
    };
  }

  /** ファイルを読み込み直したときに履歴を消す（テキスト以外では path を空にする）。 */
  function resetHistory(path = "") {
    setHistory({ path, undo: [], redo: [] });
  }

  async function preview(nextText, { recordHistory = true } = {}) {
    if (!file || file.kind !== "text" || !info || !item) return;
    const normalizedText = normalizeLineEndings(nextText);
    const currentText = normalizeLineEndings(item.text_current ?? "");
    if (normalizedText === currentText) return;
    if (recordHistory) {
      setHistory((current) => current.path === file.path
        ? { path: current.path, undo: [...current.undo, currentText], redo: [] }
        : { path: file.path, undo: [currentText], redo: [] });
    }
    const requestId = previewRequestRef.current + 1;
    previewRequestRef.current = requestId;
    setItem((current) => current ? { ...current, text_current: normalizedText } : current);
    setBusy(true);
    onError("");
    try {
      const result = await postJson("/git/text-diff", requestBody({ text: normalizedText }));
      if (requestId === previewRequestRef.current) {
        setItem((current) => current ? { ...current, text_current: normalizedText, rows: result.rows } : current);
      }
    } catch (err) {
      if (requestId === previewRequestRef.current) onError(`編集内容を反映できませんでした: ${err.message}`);
    } finally {
      if (requestId === previewRequestRef.current) setBusy(false);
    }
  }

  function editLine(row, value) {
    if (!item || !Number.isInteger(row.new_index)) return;
    const lines = normalizeLineEndings(item.text_current ?? "").split("\n");
    if (row.new_index < 0 || row.new_index >= lines.length) return;
    lines[row.new_index] = value;
    preview(lines.join("\n"));
  }

  /** 差分行をHEAD側の内容へ戻す（編集中の本文に対して行い、保存するまでファイルは変えない）。 */
  function revertLine(row) {
    if (!item || !file || file.kind !== "text") return;
    const lines = normalizeLineEndings(item.text_current ?? "").split("\n");
    const index = Number.isInteger(row.new_index) ? row.new_index : lines.length;
    if (row.kind === "insert") {
      if (index >= 0 && index < lines.length) lines.splice(index, 1);
    } else if (row.kind === "delete") {
      lines.splice(Math.max(0, Math.min(index, lines.length)), 0, String(row.old ?? ""));
    } else if (row.kind === "replace" && index >= 0 && index < lines.length) {
      lines[index] = String(row.old ?? "");
    } else {
      return;
    }
    preview(lines.join("\n"));
  }

  function undo() {
    if (!file || !item || history.path !== file.path || !history.undo.length) return;
    const currentText = normalizeLineEndings(item.text_current ?? "");
    const previousText = history.undo[history.undo.length - 1];
    setHistory((current) => ({
      path: current.path,
      undo: current.undo.slice(0, -1),
      redo: [...current.redo, currentText],
    }));
    preview(previousText, { recordHistory: false });
  }

  function redo() {
    if (!file || !item || history.path !== file.path || !history.redo.length) return;
    const currentText = normalizeLineEndings(item.text_current ?? "");
    const nextText = history.redo[history.redo.length - 1];
    setHistory((current) => ({
      path: current.path,
      undo: [...current.undo, currentText],
      redo: current.redo.slice(0, -1),
    }));
    preview(nextText, { recordHistory: false });
  }

  async function save() {
    if (!file || file.kind !== "text" || !info || !item || !dirty || busy) return;
    const text = normalizeLineEndings(item.text_current ?? "");
    setBusy(true);
    onError("");
    try {
      const saved = await postJson("/git/save-text", requestBody({
        base_text: normalizeLineEndings(item.text_saved ?? ""),
        text,
      }));
      const savedText = normalizeLineEndings(saved.text_current ?? text);
      setItem((current) => current ? { ...current, text_current: savedText, text_saved: savedText, rows: saved.rows } : current);
      resetHistory(file.path);
      onNotice(`${file.path} を保存しました。`);
    } catch (err) {
      onError(`保存できませんでした: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    function handleTextEditKeys(event) {
      if (!enabled) return;
      const modifier = event.ctrlKey || event.metaKey;
      if (!modifier) return;
      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        save();
      } else if (event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      }
    }
    window.addEventListener("keydown", handleTextEditKeys);
    return () => window.removeEventListener("keydown", handleTextEditKeys);
  }, [enabled, file, info, folder, textExtensions, item, history, dirty, busy]);

  return { busy, dirty, editLine, revertLine, save, resetHistory };
}
