/**
 * 右クリックメニューの位置（画面の端でも、メニュー全体を画面の内側に収める）のテスト
 */
import { describe, expect, it } from "vitest";
import { clampMenuPosition } from "./menuPosition";

describe("clampMenuPosition", () => {
  const viewport = { width: 1000, height: 800 };

  it("収まるときは、押した位置のまま", () => {
    expect(clampMenuPosition(100, 200, { width: 220, height: 300 }, viewport)).toEqual({ left: 100, top: 200 });
  });

  it("下や右にはみ出すときは、実際の大きさの分だけ内側へずらす（余白 8px）", () => {
    expect(clampMenuPosition(900, 700, { width: 220, height: 300 }, viewport)).toEqual({ left: 772, top: 492 });
  });

  it("画面より大きいときは、上端・左端に合わせる（項目を上から見られるように）", () => {
    expect(clampMenuPosition(500, 500, { width: 220, height: 900 }, viewport)).toEqual({ left: 500, top: 8 });
  });
});
