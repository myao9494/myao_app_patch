/**
 * 仕様: 3D ビューの描画の要否（変化があったときだけ描画する）のテスト
 *
 * 1. 何も変わらないフレームは描画しないこと
 * 2. カメラ・モデルの状態が変わったフレーム、カメラを切り替えたフレームは描画すること
 * 3. 描画の依頼のあと、一定時間は毎フレーム描画すること
 * 4. 変化が無くても、一定間隔で描画すること（依頼の漏れへの保険）
 * 5. 許容より小さい動きは描画しないが、積み重なって許容を超えたら描画すること
 **/

import { test, describe } from "node:test";
import * as assert from "node:assert";
import {
  RenderScheduler,
  renderStateDiffers,
  RENDER_HOLD_MS,
  RENDER_IDLE_INTERVAL_MS,
  RENDER_STATE_TOLERANCE,
} from "./renderScheduler";

const camera = { name: "perspective" };
const state = (x = 0) => [x, 1, 2, 0, 0, 0, 1];

describe("renderStateDiffers", () => {
  test("同じ値、許容以内の差は、差が無いと判定する", () => {
    assert.strictEqual(renderStateDiffers([1, 2, 3], [1, 2, 3]), false);
    assert.strictEqual(renderStateDiffers([1000], [1000 + 1000 * RENDER_STATE_TOLERANCE * 0.5]), false);
    assert.strictEqual(renderStateDiffers([0], [RENDER_STATE_TOLERANCE * 0.5]), false);
  });

  test("許容を超える差、長さの違いは、差があると判定する", () => {
    assert.strictEqual(renderStateDiffers([1, 2, 3], [1, 2, 3.001]), true);
    assert.strictEqual(renderStateDiffers([1000], [1000 + 1000 * RENDER_STATE_TOLERANCE * 2]), true);
    assert.strictEqual(renderStateDiffers([1, 2], [1, 2, 3]), true);
  });

  test("NaN や無限大を含む場合は、差があると判定する（描画が止まらないように）", () => {
    assert.strictEqual(renderStateDiffers([NaN], [1]), true);
    assert.strictEqual(renderStateDiffers([1], [Infinity]), true);
  });
});

describe("RenderScheduler", () => {
  test("1. 最初のフレームは描画し、何も変わらない次のフレームは描画しない", () => {
    const scheduler = new RenderScheduler();
    assert.strictEqual(scheduler.shouldRender(0, camera, state()), true);
    assert.strictEqual(scheduler.shouldRender(16, camera, state()), false);
    assert.strictEqual(scheduler.shouldRender(32, camera, state()), false);
  });

  test("2. カメラ・モデルの状態が変わったフレームは描画する", () => {
    const scheduler = new RenderScheduler();
    scheduler.shouldRender(0, camera, state());
    assert.strictEqual(scheduler.shouldRender(16, camera, state(0.5)), true);
    assert.strictEqual(scheduler.shouldRender(32, camera, state(0.5)), false);
  });

  test("2b. 使い回した配列を書き換えて渡しても、変化を検出する", () => {
    const scheduler = new RenderScheduler();
    const shared = new Float64Array(state());
    scheduler.shouldRender(0, camera, shared);
    shared[0] = 3;
    assert.strictEqual(scheduler.shouldRender(16, camera, shared), true);
    assert.strictEqual(scheduler.shouldRender(32, camera, shared), false);
  });

  test("2c. カメラを切り替えたフレーム（透視投影と平行投影）は描画する", () => {
    const scheduler = new RenderScheduler();
    scheduler.shouldRender(0, camera, state());
    assert.strictEqual(scheduler.shouldRender(16, { name: "orthographic" }, state()), true);
  });

  test("3. 描画の依頼のあと、一定時間は毎フレーム描画し、過ぎたら止める", () => {
    const scheduler = new RenderScheduler();
    scheduler.shouldRender(0, camera, state());
    scheduler.request(100);
    assert.strictEqual(scheduler.shouldRender(116, camera, state()), true);
    assert.strictEqual(scheduler.shouldRender(100 + RENDER_HOLD_MS - 1, camera, state()), true);
    assert.strictEqual(scheduler.shouldRender(100 + RENDER_HOLD_MS, camera, state()), false);
  });

  test("3b. 短い依頼が、先に出した長い依頼を縮めない", () => {
    const scheduler = new RenderScheduler();
    scheduler.shouldRender(0, camera, state());
    scheduler.request(0, 1000);
    scheduler.request(10, 50);
    assert.strictEqual(scheduler.shouldRender(400, camera, state()), true);
  });

  test("4. 変化が無くても、一定間隔で描画する", () => {
    const scheduler = new RenderScheduler();
    scheduler.shouldRender(0, camera, state());
    assert.strictEqual(scheduler.shouldRender(RENDER_IDLE_INTERVAL_MS - 1, camera, state()), false);
    assert.strictEqual(scheduler.shouldRender(RENDER_IDLE_INTERVAL_MS, camera, state()), true);
    assert.strictEqual(scheduler.shouldRender(RENDER_IDLE_INTERVAL_MS + 16, camera, state()), false);
  });

  test("5. 許容より小さい動きは描画しないが、積み重なって許容を超えたら描画する", () => {
    const scheduler = new RenderScheduler();
    scheduler.shouldRender(0, camera, state(0));
    const step = RENDER_STATE_TOLERANCE * 0.4;
    assert.strictEqual(scheduler.shouldRender(16, camera, state(step)), false);
    assert.strictEqual(scheduler.shouldRender(32, camera, state(step * 2)), false);
    assert.strictEqual(scheduler.shouldRender(48, camera, state(step * 3)), true);
  });
});
