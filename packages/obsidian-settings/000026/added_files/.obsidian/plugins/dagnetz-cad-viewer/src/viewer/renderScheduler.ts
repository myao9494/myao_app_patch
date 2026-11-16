/**
 * 3D ビューの描画の要否を決める（変化があったときだけ描画する）
 *
 * 1. 毎フレーム描画すると、3D が画面に出ているあいだ GPU と CPU を使い続ける。
 *    表示が変わるとき（下の 2〜4）だけ描画し、何も変わらないフレームは描画を飛ばす。
 * 2. カメラ・モデルの位置や向きが、最後に描画したときから変わった（回転・ズーム・パン・ロール・慣性の動き）
 * 3. 描画の依頼（request）から一定時間のあいだ（操作への追従、非同期に入る変更の取りこぼし防止）
 * 4. 最後の描画から一定時間が経った（依頼の漏れがあっても、表示が古いまま残らないようにする保険）
 **/

/** 描画の依頼のあと、毎フレーム描画し続ける時間（ms） */
export const RENDER_HOLD_MS = 250;
/** 変化が無くても描画する間隔（ms） */
export const RENDER_IDLE_INTERVAL_MS = 500;
/** カメラ・モデルの状態が変わったとみなす差（値の大きさに対する割合）。これより小さい動きは画面に出ない。 */
export const RENDER_STATE_TOLERANCE = 1e-6;

/** 2つの状態（数値の並び）に、許容を超える差があるか。 */
export function renderStateDiffers(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  tolerance = RENDER_STATE_TOLERANCE,
): boolean {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    // NaN や無限大は差があるものとして扱う（比較が常に false になり、描画が止まるのを防ぐ）
    if (!Number.isFinite(x) || !Number.isFinite(y)) return true;
    if (Math.abs(x - y) > tolerance * Math.max(1, Math.abs(x), Math.abs(y))) return true;
  }
  return false;
}

export class RenderScheduler {
  private renderUntil = -Infinity;
  private lastRenderAt = -Infinity;
  private lastSubject: unknown = undefined;
  private lastState: Float64Array | null = null;

  /** 表示が変わった（変わりうる）ことを知らせる。holdMs のあいだは毎フレーム描画する。 */
  request(now: number, holdMs = RENDER_HOLD_MS): void {
    this.renderUntil = Math.max(this.renderUntil, now + holdMs);
  }

  /**
   * このフレームを描画するかを返す。描画する場合は、今の状態を「最後に描画した状態」として覚える。
   * 状態の比較は直前のフレームではなく最後に描画した状態と行うため、許容より小さい動きが
   * 積み重なった場合も、差が許容を超えた時点で描画される。
   * @param subject 描画に使うカメラ（透視投影と平行投影の切り替えを検出する）
   * @param state カメラ・モデルの位置や向きを並べた数値（呼び出しのたびに同じ配列を使い回してよい）
   */
  shouldRender(now: number, subject: unknown, state: ArrayLike<number>): boolean {
    const changed =
      subject !== this.lastSubject || this.lastState === null || renderStateDiffers(state, this.lastState);
    if (!changed && now >= this.renderUntil && now - this.lastRenderAt < RENDER_IDLE_INTERVAL_MS) {
      return false;
    }
    if (this.lastState === null || this.lastState.length !== state.length) {
      this.lastState = new Float64Array(state.length);
    }
    for (let i = 0; i < state.length; i++) this.lastState[i] = state[i];
    this.lastSubject = subject;
    this.lastRenderAt = now;
    return true;
  }
}
