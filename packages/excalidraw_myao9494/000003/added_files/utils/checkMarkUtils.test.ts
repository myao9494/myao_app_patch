/**
 * チェックマーク（✓）ユーティリティのテスト
 *
 * 仕様:
 * - createCheckMarkElement: クリック位置を中心に、3 点の折れ線（✓）の line 要素を作る。
 *   色は赤（#e03131）、太さ 3px、矢じりなし。customData.checkMark = true で識別できる。
 * - isCheckMarkElement: 上記の要素かを判定する。
 */
import { describe, expect, it } from 'vitest';
import {
  CHECK_MARK_COLOR,
  CHECK_MARK_SIZE,
  createCheckMarkElement,
  isCheckMarkElement,
} from './checkMarkUtils';

describe('checkMarkUtils', () => {
  it('クリック位置を中心にした 3 点の line 要素を作る', () => {
    const element = createCheckMarkElement(100, 200) as any;

    expect(element.type).toBe('line');
    expect(element.points).toHaveLength(3);
    expect(element.x + element.width / 2).toBeCloseTo(100);
    expect(element.y + element.height / 2).toBeCloseTo(200);
    expect(element.width).toBeCloseTo(CHECK_MARK_SIZE);
    expect(element.height).toBeCloseTo(CHECK_MARK_SIZE);
  });

  it('✓ の形（左上から谷へ下り、右上へ上がる）になる', () => {
    const { points } = createCheckMarkElement(0, 0) as any;
    const [start, valley, end] = points;

    expect(valley[1]).toBeGreaterThan(start[1]);
    expect(valley[1]).toBeGreaterThan(end[1]);
    expect(start[0]).toBeLessThan(valley[0]);
    expect(valley[0]).toBeLessThan(end[0]);
  });

  it('既定は赤・矢じりなしで、色と太さを指定できる', () => {
    const base = createCheckMarkElement(0, 0) as any;
    expect(base.strokeColor).toBe(CHECK_MARK_COLOR);
    expect(base.startArrowhead).toBeNull();
    expect(base.endArrowhead).toBeNull();

    const custom = createCheckMarkElement(0, 0, { color: '#2f9e44', strokeWidth: 5 }) as any;
    expect(custom.strokeColor).toBe('#2f9e44');
    expect(custom.strokeWidth).toBe(5);
  });

  it('呼ぶたびに別の id になり、isCheckMarkElement で判定できる', () => {
    const a = createCheckMarkElement(0, 0);
    const b = createCheckMarkElement(0, 0);

    expect(a.id).not.toBe(b.id);
    expect(isCheckMarkElement(a)).toBe(true);
    expect(isCheckMarkElement({ ...a, customData: null } as any)).toBe(false);
  });
});
