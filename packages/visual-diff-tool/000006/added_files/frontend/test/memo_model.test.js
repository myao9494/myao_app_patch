/**
 * 差分メモのデータモデル（memo/memoModel.js）の単体テスト。
 * - 保存データが古い・壊れていても normalize* で安全な値へ補正できる
 * - 矢印の起点・終点と矩形表現の相互変換
 * - メモの色割り当て・引出線の辺へのスナップ・自動サイズ
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  arrowAnnotationFromEndpoints,
  calculateMemoAutoSize,
  MEMO_COLORS,
  MEMO_DEFAULTS,
  memoArrowEndpoints,
  memoColor,
  memoHistorySnapshot,
  memoHistorySnapshotEquals,
  memoNoteLeaders,
  nextMemoColorIndex,
  nextMemoNumber,
  normalizeMemoAnnotations,
  normalizeMemoNotes,
  normalizeStickyNotes,
  snapMemoLeaderPoint,
  STICKY_DEFAULTS,
  updateMemoLeader,
} from "../src/memo/memoModel.js";

test("normalizeMemoNotes: 配列以外・nullを除外し、範囲外や不正値を既定値へ補正する", () => {
  assert.deepEqual(normalizeMemoNotes(null), []);
  assert.deepEqual(normalizeMemoNotes("x"), []);
  const [note] = normalizeMemoNotes([null, { x: 500, y: -10, text: 3, changeType: "unknown", fontSize: 999 }]);
  assert.equal(note.id, "recovered-note-0"); // null を除いた後の位置で採番する
  assert.equal(note.x, 88);
  assert.equal(note.y, 0);
  assert.equal(note.text, MEMO_DEFAULTS.text);
  assert.equal(note.changeType, MEMO_DEFAULTS.changeType);
  assert.equal(note.fontSize, 48);
  assert.deepEqual(note.extraLeaders, []);
  assert.deepEqual(note.annotations, []);
});

test("normalizeMemoNotes: 色番号がない古いデータはメモ番号から色を決める", () => {
  const [note] = normalizeMemoNotes([{ id: "a", number: MEMO_COLORS.length + 2 }]);
  assert.equal(note.colorIndex, 1);
  assert.equal(memoColor(note), MEMO_COLORS[1]);
});

test("normalizeMemoAnnotations: 未知の種類は矩形、マーカーは細い高さを許可する", () => {
  const [rect, marker] = normalizeMemoAnnotations([
    { type: "triangle", x: 10, y: 10, width: 200, height: 0 },
    { type: "highlight", x: 0, y: 0, width: 10, height: 0.05 },
  ]);
  assert.equal(rect.type, "rectangle");
  assert.equal(rect.width, 90); // 画像の右端を超えない
  assert.equal(rect.height, 0.4);
  assert.equal(marker.height, 0.05);
  assert.equal(marker.opacity, 28);
});

test("normalizeStickyNotes: 位置・サイズを範囲内へ収める", () => {
  const [sticky] = normalizeStickyNotes([{ x: 200, width: 10, fontSize: "abc" }]);
  assert.equal(sticky.x, 90);
  assert.equal(sticky.y, STICKY_DEFAULTS.y);
  assert.equal(sticky.width, 120);
  assert.equal(sticky.fontSize, STICKY_DEFAULTS.fontSize);
});

test("arrowAnnotationFromEndpoints / memoArrowEndpoints: 右上から左下への矢印を往復変換できる", () => {
  const start = { x: 80, y: 10 };
  const end = { x: 20, y: 60 };
  const annotation = arrowAnnotationFromEndpoints(start, end);
  assert.deepEqual(
    { x: annotation.x, y: annotation.y, reverseX: annotation.reverseX, reverseY: annotation.reverseY },
    { x: 20, y: 10, reverseX: true, reverseY: false },
  );
  assert.deepEqual(memoArrowEndpoints(annotation), { start, end });
});

test("nextMemoColorIndex / nextMemoNumber: 未使用の色と次の番号を選ぶ", () => {
  const notes = [{ id: "a", number: 1, colorIndex: 0 }, { id: "b", number: 4, colorIndex: 2 }];
  assert.equal(nextMemoColorIndex(notes), 1);
  assert.equal(nextMemoNumber(notes), 5);
});

test("snapMemoLeaderPoint: 引出線の起点はメモ枠の最も近い辺に吸着する", () => {
  const size = { width: 100, height: 40 };
  assert.deepEqual(snapMemoLeaderPoint({ x: 3, y: 20 }, size), { x: 0, y: 20 });
  assert.deepEqual(snapMemoLeaderPoint({ x: 50, y: 38 }, size), { x: 50, y: 40 });
  assert.deepEqual(snapMemoLeaderPoint({ x: 500, y: 20 }, size), { x: 100, y: 20 });
});

test("memoNoteLeaders / updateMemoLeader: 追加の引出線も含めて終点を更新できる", () => {
  const [note] = normalizeMemoNotes([{ id: "n", extraLeaders: [{ id: "l1" }] }]);
  assert.deepEqual(memoNoteLeaders(note).map((leader) => leader.id), ["primary", "l1"]);
  const moved = updateMemoLeader(note, "n", "l1", "end", { end: { x: 5, y: 6 } });
  assert.equal(moved.extraLeaders[0].leaderEndX, 5);
  assert.equal(moved.leaderEndX, note.leaderEndX);
});

test("calculateMemoAutoSize: 文字数に応じて広がり、上限で折り返す", () => {
  const small = calculateMemoAutoSize({ text: "あ", fontSize: 15 });
  const long = calculateMemoAutoSize({ text: "あ".repeat(200), fontSize: 15 });
  assert.equal(small.width, 100);
  assert.equal(long.width, 420);
  assert.ok(long.height > small.height);
});

test("memoHistorySnapshotEquals: 正規化後の内容で比較する", () => {
  const left = memoHistorySnapshot([{ id: "a", text: "x" }], []);
  const right = memoHistorySnapshot([{ id: "a", text: "x", unknownField: 1 }], null);
  assert.ok(memoHistorySnapshotEquals(left, right));
});
