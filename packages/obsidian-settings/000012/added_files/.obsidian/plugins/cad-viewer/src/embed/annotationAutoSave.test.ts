/**
 * 仕様: 注記の変更をコードブロック（YAML）へ自動保存する制御のテスト
 *
 * 1. shouldAutoSaveAnnotations: コードブロックが注記の保存先になっている埋め込み
 *    （ロック中、またはコードブロックに注記がある）だけを自動保存の対象にすること
 * 2. AnnotationAutoSaver:
 *    - 連続した変更は1回の保存にまとめること（デバウンス）
 *    - 注記のテキスト編集中は保存を保留し、編集が終わってから保存すること
 *      （保存するとコードブロックが再描画され、入力中の編集ボックスが閉じてしまうため）
 *    - flush: 保留中の変更があれば即座に保存すること（ビューア破棄時の取りこぼし防止）
 *    - cancel: 保留中の保存を取り消すこと（固定ボタンが同じ内容を保存する場合）
 *    - 保存処理が失敗しても例外を外へ伝播させないこと
 */

import test from "node:test";
import assert from "node:assert/strict";
import { AnnotationAutoSaver, shouldAutoSaveAnnotations } from "./annotationAutoSave";

/** 手動で時間を進められるタイマー */
function createFakeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      set: (fn: () => void, ms: number) => {
        const id = nextId++;
        pending.set(id, { at: now + ms, fn });
        return id;
      },
      clear: (id: unknown) => {
        pending.delete(id as number);
      },
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
    count: () => pending.size,
  };
}

function createSaver(options: { editing?: () => boolean; save?: () => void | Promise<void> } = {}) {
  const clock = createFakeTimers();
  let saves = 0;
  const saver = new AnnotationAutoSaver({
    delayMs: 600,
    isEditing: options.editing ?? (() => false),
    save: options.save ?? (() => {
      saves++;
    }),
    timers: clock.timers,
  });
  return { saver, clock, saves: () => saves };
}

test("shouldAutoSaveAnnotations: ロック中の埋め込みは自動保存の対象になること", () => {
  assert.equal(shouldAutoSaveAnnotations({ canSave: true, locked: true, codeBlockAnnotationCount: 0 }), true);
});

test("shouldAutoSaveAnnotations: コードブロックに注記がある埋め込みは自動保存の対象になること", () => {
  assert.equal(shouldAutoSaveAnnotations({ canSave: true, locked: false, codeBlockAnnotationCount: 2 }), true);
});

test("shouldAutoSaveAnnotations: 固定も注記の保存もしていない埋め込みは対象外になること", () => {
  // 注記は従来どおり data.json にだけ保存し、コードブロックを書き換えない
  assert.equal(shouldAutoSaveAnnotations({ canSave: true, locked: false, codeBlockAnnotationCount: 0 }), false);
});

test("shouldAutoSaveAnnotations: 保存先のコードブロックが無い表示（CADファイルを直接開いたビュー）は対象外になること", () => {
  assert.equal(shouldAutoSaveAnnotations({ canSave: false, locked: true, codeBlockAnnotationCount: 3 }), false);
});

test("AnnotationAutoSaver: 変更から一定時間後に1回だけ保存すること", () => {
  const { saver, clock, saves } = createSaver();

  saver.notifyChanged();
  clock.advance(599);
  assert.equal(saves(), 0);
  clock.advance(1);
  assert.equal(saves(), 1);
  clock.advance(5000);
  assert.equal(saves(), 1);
  assert.equal(saver.hasPending(), false);
});

test("AnnotationAutoSaver: 連続した変更は最後の変更から数えて1回の保存にまとめること", () => {
  const { saver, clock, saves } = createSaver();

  saver.notifyChanged();
  clock.advance(400);
  saver.notifyChanged();
  clock.advance(400);
  saver.notifyChanged();
  clock.advance(599);
  assert.equal(saves(), 0);
  clock.advance(1);
  assert.equal(saves(), 1);
});

test("AnnotationAutoSaver: テキスト編集中は保存を保留し、編集が終わってから保存すること", () => {
  let editing = true;
  const { saver, clock, saves } = createSaver({ editing: () => editing });

  saver.notifyChanged();
  clock.advance(3000);
  assert.equal(saves(), 0, "編集中は保存しないこと");
  assert.equal(saver.hasPending(), true);

  editing = false;
  clock.advance(600);
  assert.equal(saves(), 1, "編集終了後に保存すること");
});

test("AnnotationAutoSaver: flush は保留中の変更を即座に保存し、タイマーを残さないこと", () => {
  const { saver, clock, saves } = createSaver();

  saver.notifyChanged();
  saver.flush();
  assert.equal(saves(), 1);
  assert.equal(clock.count(), 0);
  clock.advance(5000);
  assert.equal(saves(), 1, "同じ変更を二重に保存しないこと");
});

test("AnnotationAutoSaver: 保留中の変更が無ければ flush は何もしないこと", () => {
  const { saver, saves } = createSaver();

  saver.flush();
  assert.equal(saves(), 0);
});

test("AnnotationAutoSaver: cancel は保留中の保存を取り消すこと", () => {
  const { saver, clock, saves } = createSaver();

  saver.notifyChanged();
  saver.cancel();
  clock.advance(5000);
  saver.flush();
  assert.equal(saves(), 0);
  assert.equal(saver.hasPending(), false);
});

test("AnnotationAutoSaver: 保存処理が失敗（同期例外・非同期の拒否）しても例外を伝播させないこと", async () => {
  const sync = createSaver({
    save: () => {
      throw new Error("sync failure");
    },
  });
  sync.saver.notifyChanged();
  assert.doesNotThrow(() => sync.clock.advance(600));

  const asyncSaver = createSaver({ save: () => Promise.reject(new Error("async failure")) });
  asyncSaver.saver.notifyChanged();
  asyncSaver.clock.advance(600);
  // 未処理の Promise 拒否にならないことを確認するため、マイクロタスクを消化する
  await new Promise((resolve) => setImmediate(resolve));
});
