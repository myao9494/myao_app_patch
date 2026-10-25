/**
 * 差分メモのデータモデル（メモ・引出線・描画・付箋）。
 * 座標はステージ（画像）に対する % で持ち、メモの大きさ・引出線はステージ基準のpxで持つ。
 * 保存データは古い形式や壊れた値も normalize* で補正してから使う。
 */
import { clamp } from "../lib/util.js";

const MEMO_CHANGE_TYPES = [
  { id: "change", label: "変更" },
  { id: "add", label: "追加" },
  { id: "remove", label: "削除" },
  { id: "confirm", label: "確認依頼" },
  { id: "decision", label: "要判断" },
];

export const MEMO_ANNOTATION_TYPES = [
  { id: "arrow", label: "矢印", shortcut: "A" },
  { id: "cloud", label: "変更雲", shortcut: "C" },
  { id: "rectangle", label: "矩形", shortcut: "R" },
  { id: "ellipse", label: "楕円", shortcut: "O" },
  { id: "highlight", label: "マーカー", shortcut: "M" },
];

export const MEMO_DEFAULTS = {
  text: "めも",
  changeType: "change",
  opacity: 60,
  fontSize: 15,
  width: 100,
  height: 42,
  autoSize: true,
  leaderX: 18,
  leaderY: 46,
  leaderEndX: -73,
  leaderEndY: 163,
  annotations: [],
};

export const MEMO_EXTRA_LEADER_DEFAULT = {
  leaderX: 162,
  leaderY: 46,
  leaderEndX: 275,
  leaderEndY: 163,
};

export const STICKY_DEFAULTS = {
  text: "付箋",
  x: 42,
  y: 12,
  width: 180,
  height: 72,
  fontSize: 15,
};

export const MEMO_COLORS = [
  { fill: "#ef4444", border: "#fecaca", line: "#ef4444", hex: "#ef4444" },
  { fill: "#2563eb", border: "#bfdbfe", line: "#3b82f6", hex: "#3b82f6" },
  { fill: "#10b981", border: "#a7f3d0", line: "#10b981", hex: "#10b981" },
  { fill: "#d97706", border: "#fde68a", line: "#f59e0b", hex: "#f59e0b" },
  { fill: "#9333ea", border: "#e9d5ff", line: "#a855f7", hex: "#a855f7" },
  { fill: "#0891b2", border: "#a5f3fc", line: "#06b6d4", hex: "#06b6d4" },
];

export function normalizeStickyNotes(stickies) {
  if (!Array.isArray(stickies)) return [];
  return stickies
    .filter((sticky) => sticky && typeof sticky === "object")
    .map((sticky, index) => ({
      id: sticky.id ? String(sticky.id) : `recovered-sticky-${index}`,
      text: typeof sticky.text === "string" ? sticky.text : STICKY_DEFAULTS.text,
      x: Number.isFinite(Number(sticky.x)) ? clamp(Number(sticky.x), 0, 90) : STICKY_DEFAULTS.x,
      y: Number.isFinite(Number(sticky.y)) ? clamp(Number(sticky.y), 0, 90) : STICKY_DEFAULTS.y,
      width: Number.isFinite(Number(sticky.width)) ? clamp(Number(sticky.width), 120, 420) : STICKY_DEFAULTS.width,
      height: Number.isFinite(Number(sticky.height)) ? clamp(Number(sticky.height), 64, 320) : STICKY_DEFAULTS.height,
      fontSize: Number.isFinite(Number(sticky.fontSize)) ? clamp(Number(sticky.fontSize), 12, 36) : STICKY_DEFAULTS.fontSize,
    }));
}

export function calculateStickyAutoHeight(sticky, text) {
  const fontSize = Number(sticky.fontSize) || STICKY_DEFAULTS.fontSize;
  const width = Number(sticky.width) || STICKY_DEFAULTS.width;
  const usableCharacters = Math.max(1, Math.floor((width - 24) / (fontSize * 0.62)));
  const rows = String(text || " ").split("\n").reduce((total, line) => (
    total + Math.max(1, Math.ceil(Array.from(line || " ").length / usableCharacters))
  ), 0);
  return clamp(Math.ceil(38 + rows * fontSize * 1.45), 64, 320);
}

export function normalizeMemoNotes(notes) {
  if (!Array.isArray(notes)) return [];
  return notes
    .filter((note) => note && typeof note === "object")
    .map((note, index) => {
      const number = Number.isFinite(Number(note.number)) ? Math.max(1, Math.round(Number(note.number))) : index + 1;
      const legacyColorIndex = (number - 1) % MEMO_COLORS.length;
      return {
        id: note.id ? String(note.id) : `recovered-note-${index}`,
        number,
        colorIndex: Number.isFinite(Number(note.colorIndex))
          ? clamp(Math.round(Number(note.colorIndex)), 0, MEMO_COLORS.length - 1)
          : legacyColorIndex,
        text: typeof note.text === "string" ? note.text : MEMO_DEFAULTS.text,
        changeType: MEMO_CHANGE_TYPES.some((type) => type.id === note.changeType) ? note.changeType : MEMO_DEFAULTS.changeType,
        x: Number.isFinite(Number(note.x)) ? clamp(Number(note.x), 0, 88) : 42,
        y: Number.isFinite(Number(note.y)) ? clamp(Number(note.y), 0, 82) : 12,
        opacity: Number.isFinite(Number(note.opacity)) ? clamp(Number(note.opacity), 20, 100) : MEMO_DEFAULTS.opacity,
        fontSize: Number.isFinite(Number(note.fontSize)) ? clamp(Number(note.fontSize), 12, 48) : MEMO_DEFAULTS.fontSize,
        width: Number.isFinite(Number(note.width)) ? clamp(Number(note.width), 100, 520) : MEMO_DEFAULTS.width,
        height: Number.isFinite(Number(note.height)) ? clamp(Number(note.height), 44, 320) : MEMO_DEFAULTS.height,
        autoSize: typeof note.autoSize === "boolean" ? note.autoSize : MEMO_DEFAULTS.autoSize,
        leaderX: Number.isFinite(Number(note.leaderX)) ? clamp(Number(note.leaderX), -420, 620) : MEMO_DEFAULTS.leaderX,
        leaderY: Number.isFinite(Number(note.leaderY)) ? clamp(Number(note.leaderY), -240, 520) : MEMO_DEFAULTS.leaderY,
        leaderEndX: Number.isFinite(Number(note.leaderEndX)) ? clamp(Number(note.leaderEndX), -420, 620) : MEMO_DEFAULTS.leaderEndX,
        leaderEndY: Number.isFinite(Number(note.leaderEndY)) ? clamp(Number(note.leaderEndY), -240, 520) : MEMO_DEFAULTS.leaderEndY,
        extraLeaders: normalizeExtraMemoLeaders(note.extraLeaders),
        annotations: normalizeMemoAnnotations(note.annotations),
      };
    });
}

export function normalizeMemoAnnotations(annotations) {
  if (!Array.isArray(annotations)) return [];
  return annotations
    .filter((annotation) => annotation && typeof annotation === "object")
    .map((annotation, index) => {
      const type = MEMO_ANNOTATION_TYPES.some((item) => item.id === annotation.type) ? annotation.type : "rectangle";
      const x = clamp(Number(annotation.x) || 0, 0, 99);
      const y = clamp(Number(annotation.y) || 0, 0, 99);
      const minimumHeight = type === "highlight" ? 0.05 : 0.4;
      return {
        id: annotation.id ? String(annotation.id) : `recovered-annotation-${index}`,
        type,
        x,
        y,
        width: clamp(Number(annotation.width) || 1, 0.4, 100 - x),
        height: clamp(Number(annotation.height) || minimumHeight, minimumHeight, 100 - y),
        opacity: clamp(Number(annotation.opacity) || (type === "highlight" ? 28 : 82), 10, 100),
        strokeWidth: clamp(Number(annotation.strokeWidth) || 4, 1, 12),
        arrowHeadSize: clamp(Number(annotation.arrowHeadSize) || 16, 6, 32),
        reverseX: Boolean(annotation.reverseX),
        reverseY: Boolean(annotation.reverseY),
      };
    });
}

export function memoHistorySnapshot(notes, stickies) {
  return {
    notes: normalizeMemoNotes(notes),
    stickies: normalizeStickyNotes(stickies),
  };
}

export function cloneMemoHistorySnapshot(snapshot) {
  return JSON.parse(JSON.stringify(snapshot));
}

export function memoHistorySnapshotEquals(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function memoArrowEndpoints(annotation) {
  return {
    start: {
      x: annotation.x + (annotation.reverseX ? annotation.width : 0),
      y: annotation.y + (annotation.reverseY ? annotation.height : 0),
    },
    end: {
      x: annotation.x + (annotation.reverseX ? 0 : annotation.width),
      y: annotation.y + (annotation.reverseY ? 0 : annotation.height),
    },
  };
}

export function arrowAnnotationFromEndpoints(rawStart, rawEnd) {
  const start = { x: clamp(rawStart.x, 0, 100), y: clamp(rawStart.y, 0, 100) };
  const end = { x: clamp(rawEnd.x, 0, 100), y: clamp(rawEnd.y, 0, 100) };
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return {
    x,
    y,
    width: clamp(Math.abs(end.x - start.x), 0.4, 100 - x),
    height: clamp(Math.abs(end.y - start.y), 0.4, 100 - y),
    reverseX: start.x > end.x,
    reverseY: start.y > end.y,
  };
}

export function updateMemoAnnotation(note, noteId, annotationId, fields) {
  if (note.id !== noteId) return note;
  return {
    ...note,
    annotations: note.annotations.map((annotation) => (
      annotation.id === annotationId ? { ...annotation, ...fields } : annotation
    )),
  };
}

export function stagePercentPoint(event, rect) {
  return {
    x: clamp(((event.clientX - rect.left) / rect.width) * 100, 0, 100),
    y: clamp(((event.clientY - rect.top) / rect.height) * 100, 0, 100),
  };
}

export function memoChangeTypeLabel(value) {
  return MEMO_CHANGE_TYPES.find((type) => type.id === value)?.label ?? "変更";
}

export function memoAnnotationTypeLabel(value) {
  return MEMO_ANNOTATION_TYPES.find((type) => type.id === value)?.label ?? "図形";
}

export function nextMemoNumber(notes) {
  return normalizeMemoNotes(notes).reduce((max, note) => Math.max(max, note.number), 0) + 1;
}

export function nextMemoColorIndex(notes) {
  const normalized = normalizeMemoNotes(notes);
  const used = new Set(normalized.map((note) => note.colorIndex));
  const available = MEMO_COLORS.findIndex((_, index) => !used.has(index));
  return available >= 0 ? available : normalized.length % MEMO_COLORS.length;
}

export function memoColor(note) {
  const fallback = Number.isFinite(Number(note?.number)) ? (Math.max(1, Number(note.number)) - 1) % MEMO_COLORS.length : 0;
  const colorIndex = Number.isFinite(Number(note?.colorIndex))
    ? clamp(Math.round(Number(note.colorIndex)), 0, MEMO_COLORS.length - 1)
    : fallback;
  return MEMO_COLORS[colorIndex];
}

function normalizeExtraMemoLeaders(leaders) {
  if (!Array.isArray(leaders)) return [];
  return leaders
    .filter((leader) => leader && typeof leader === "object")
    .map((leader, index) => ({
      id: leader.id ? String(leader.id) : `recovered-line-${index}`,
      leaderX: Number.isFinite(Number(leader.leaderX)) ? clamp(Number(leader.leaderX), -420, 620) : MEMO_EXTRA_LEADER_DEFAULT.leaderX,
      leaderY: Number.isFinite(Number(leader.leaderY)) ? clamp(Number(leader.leaderY), -240, 520) : MEMO_EXTRA_LEADER_DEFAULT.leaderY,
      leaderEndX: Number.isFinite(Number(leader.leaderEndX)) ? clamp(Number(leader.leaderEndX), -420, 620) : MEMO_EXTRA_LEADER_DEFAULT.leaderEndX,
      leaderEndY: Number.isFinite(Number(leader.leaderEndY)) ? clamp(Number(leader.leaderEndY), -240, 520) : MEMO_EXTRA_LEADER_DEFAULT.leaderEndY,
    }));
}

export function memoBoxStyle(note) {
  const size = memoSize(note);
  return {
    width: `${size.width}px`,
    height: `${size.height}px`,
  };
}

export function memoSize(note) {
  return note.autoSize ? calculateMemoAutoSize(note) : { width: note.width, height: note.height };
}

function memoLeaderStart(note) {
  return snapMemoLeaderPoint({ x: note.leaderX, y: note.leaderY }, memoSize(note));
}

export function memoNoteLeaders(note) {
  const size = memoSize(note);
  return [
    {
      id: "primary",
      start: snapMemoLeaderPoint({ x: note.leaderX, y: note.leaderY }, size),
      endX: note.leaderEndX,
      endY: note.leaderEndY,
    },
    ...note.extraLeaders.map((leader) => ({
      id: leader.id,
      start: snapMemoLeaderPoint({ x: leader.leaderX, y: leader.leaderY }, size),
      endX: leader.leaderEndX,
      endY: leader.leaderEndY,
    })),
  ];
}

export function memoLeaderHandleStyle(point, size) {
  const offset = 7;
  let x = point.x;
  let y = point.y;
  if (point.x <= 0) x -= offset;
  else if (point.x >= size.width) x += offset;
  if (point.y <= 0) y -= offset;
  else if (point.y >= size.height) y += offset;
  return { left: `${x}px`, top: `${y}px` };
}

export function updateMemoLeader(note, noteId, lineId, point, points) {
  if (note.id !== noteId) return note;
  const fields = point === "end"
    ? { leaderEndX: points.end.x, leaderEndY: points.end.y }
    : { leaderX: points.start.x, leaderY: points.start.y };
  if (lineId === "primary") return { ...note, ...fields };
  return {
    ...note,
    extraLeaders: note.extraLeaders.map((leader) => (leader.id === lineId ? { ...leader, ...fields } : leader)),
  };
}

export function nextExtraLeader(index) {
  const offset = index * 28;
  return {
    ...MEMO_EXTRA_LEADER_DEFAULT,
    leaderY: clamp(MEMO_EXTRA_LEADER_DEFAULT.leaderY + offset, -240, 520),
    leaderEndY: clamp(MEMO_EXTRA_LEADER_DEFAULT.leaderEndY + offset, -240, 520),
  };
}

export function snapMemoLeaderPoint(point, size) {
  const x = clamp(point.x, 0, size.width);
  const y = clamp(point.y, 0, size.height);
  const distances = [
    { edge: "left", value: x },
    { edge: "right", value: size.width - x },
    { edge: "top", value: y },
    { edge: "bottom", value: size.height - y },
  ];
  const nearest = distances.reduce((best, item) => (item.value < best.value ? item : best), distances[0]).edge;
  if (nearest === "left") return { x: 0, y };
  if (nearest === "right") return { x: size.width, y };
  if (nearest === "top") return { x, y: 0 };
  return { x, y: size.height };
}

export function calculateMemoAutoSize(note) {
  const lines = String(note.text || MEMO_DEFAULTS.text).split("\n");
  const longestLine = Math.max(...lines.map((line) => Array.from(line || " ").length), 1);
  const width = clamp(Math.round(longestLine * note.fontSize * 0.72 + 24), 100, 420);
  const usableChars = Math.max(1, Math.floor((width - 28) / (note.fontSize * 0.72)));
  const lineCount = lines.reduce((total, line) => total + Math.max(1, Math.ceil(Array.from(line || " ").length / usableChars)), 0);
  const height = clamp(Math.round(lineCount * note.fontSize * 1.18 + 16), 42, 260);
  return { width, height };
}
