/**
 * 画像ビューワーのズーム・パン・表示計算ユーティリティのテスト
 * - スケール計算（ホイールスクロール・ボタン操作・クランプ）
 * - カーソル位置中心のズームオフセット計算
 * - パン移動オフセット計算
 * - 実寸（1:1）スケール計算
 * - アスペクト比計算
 * - ミニマップ（表示範囲枠）の計算
 */
import { describe, it, expect } from "vitest";
import {
  calculateZoomScale,
  calculateZoomOffset,
  calculatePanOffset,
  calculateActualSizeScale,
  formatAspectRatio,
  calculateMinimapViewport,
  calculateOffsetFromMinimapClick,
} from "./imageViewerCalculations";

describe("imageViewerCalculations", () => {
  describe("calculateZoomScale", () => {
    it("ホイールのdeltaY（上スクロール: 負）でズームインすること", () => {
      const currentScale = 1.0;
      const nextScale = calculateZoomScale(currentScale, -100);
      expect(nextScale).toBeGreaterThan(1.0);
    });

    it("ホイールのdeltaY（下スクロール: 正）でズームアウトすること", () => {
      const currentScale = 1.0;
      const nextScale = calculateZoomScale(currentScale, 100);
      expect(nextScale).toBeLessThan(1.0);
    });

    it("最小スケール（デフォルト0.1）を下回らないこと", () => {
      const nextScale = calculateZoomScale(0.12, 1000, { minScale: 0.1 });
      expect(nextScale).toBe(0.1);
    });

    it("最大スケール（デフォルト30）を超えないこと", () => {
      const nextScale = calculateZoomScale(28, -1000, { maxScale: 30 });
      expect(nextScale).toBe(30);
    });

    it("ステップ単位でのズームイン・ズームアウト（ボタン用）ができること", () => {
      const inScale = calculateZoomScale(1.0, "in");
      expect(inScale).toBeCloseTo(1.25, 2);

      const outScale = calculateZoomScale(1.0, "out");
      expect(outScale).toBeCloseTo(0.8, 2);
    });
  });

  describe("calculateZoomOffset", () => {
    it("コンテナ中心でのズーム時はオフセットが維持または中心対称に変化すること", () => {
      // コンテナサイズ 800x600, 中心 (400, 300)
      const containerSize = { width: 800, height: 600 };
      const cursor = { x: 400, y: 300 };
      const currentOffset = { x: 0, y: 0 };
      const currentScale = 1.0;
      const nextScale = 2.0;

      const nextOffset = calculateZoomOffset({
        cursor,
        containerSize,
        currentOffset,
        currentScale,
        nextScale,
      });

      // 中心でズームした場合、オフセットは (0, 0) のまま
      expect(nextOffset.x).toBeCloseTo(0, 1);
      expect(nextOffset.y).toBeCloseTo(0, 1);
    });

    it("カーソルが右下にある状態でズームインした時、画像が左上方向に引っ張られる（カーソル下の点が固定される）こと", () => {
      const containerSize = { width: 800, height: 600 };
      // 中心(400, 300)から右下へ+100, +100
      const cursor = { x: 500, y: 400 };
      const currentOffset = { x: 0, y: 0 };
      const currentScale = 1.0;
      const nextScale = 2.0;

      const nextOffset = calculateZoomOffset({
        cursor,
        containerSize,
        currentOffset,
        currentScale,
        nextScale,
      });

      // カーソル下の相対位置 (dx, dy) = (100, 100)
      // 新オフセット = (100) - (100 * 2) = -100
      expect(nextOffset.x).toBeCloseTo(-100, 1);
      expect(nextOffset.y).toBeCloseTo(-100, 1);
    });
  });

  describe("calculatePanOffset", () => {
    it("ドラッグ移動量（delta）が現在のオフセットに正しく加算されること", () => {
      const currentOffset = { x: 50, y: -20 };
      const delta = { dx: 15, dy: -30 };
      const next = calculatePanOffset(currentOffset, delta);
      expect(next).toEqual({ x: 65, y: -50 });
    });
  });

  describe("calculateActualSizeScale", () => {
    it("自然サイズとレンダリング（フィット）サイズから100%等倍スケールを算出すること", () => {
      // 画面にフィットさせた時の画像幅が 400px、自然サイズが 1200px の場合、実寸は 3.0倍
      const natural = { width: 1200, height: 900 };
      const renderedFit = { width: 400, height: 300 };
      const scale = calculateActualSizeScale(natural, renderedFit);
      expect(scale).toBeCloseTo(3.0, 2);
    });

    it("自然サイズが無効または0の場合は1.0を返すこと", () => {
      expect(calculateActualSizeScale({ width: 0, height: 0 }, { width: 400, height: 300 })).toBe(1.0);
    });
  });

  describe("formatAspectRatio", () => {
    it("代表的な比率（16:9, 4:3, 1:1, 3:2, 21:9）を簡潔に表現すること", () => {
      expect(formatAspectRatio(1920, 1080)).toBe("16:9");
      expect(formatAspectRatio(1024, 768)).toBe("4:3");
      expect(formatAspectRatio(800, 800)).toBe("1:1");
      expect(formatAspectRatio(3000, 2000)).toBe("3:2");
    });

    it("割り切れない比率は小数点1桁の形式で返すこと", () => {
      expect(formatAspectRatio(1000, 600)).toBe("5:3");
      expect(formatAspectRatio(1000, 700)).toBe("1.43:1");
    });

    it("無効な値に対しては空文字を返すこと", () => {
      expect(formatAspectRatio(0, 0)).toBe("");
    });
  });

  describe("calculateMinimapViewport", () => {
    it("拡大中のビューポート矩形（パーセント値）を計算すること", () => {
      // コンテナ 800x600, スケール 2.0, オフセット (0, 0)
      const rect = calculateMinimapViewport({
        viewportSize: { width: 800, height: 600 },
        contentSize: { width: 800, height: 600 },
        scale: 2.0,
        offset: { x: 0, y: 0 },
      });

      // スケール2倍の場合、全体の50%が表示されている
      expect(rect.widthPct).toBeCloseTo(50, 1);
      expect(rect.heightPct).toBeCloseTo(50, 1);
      // オフセット0なら中央に位置する（左から25%の位置）
      expect(rect.leftPct).toBeCloseTo(25, 1);
      expect(rect.topPct).toBeCloseTo(25, 1);
    });

    it("スケールが1.0以下のときは全体(100%)を表示すること", () => {
      const rect = calculateMinimapViewport({
        viewportSize: { width: 800, height: 600 },
        contentSize: { width: 800, height: 600 },
        scale: 1.0,
        offset: { x: 0, y: 0 },
      });

      expect(rect.widthPct).toBe(100);
      expect(rect.heightPct).toBe(100);
      expect(rect.leftPct).toBe(0);
      expect(rect.topPct).toBe(0);
    });
  });

  describe("calculateOffsetFromMinimapClick", () => {
    it("ミニマップ中央（50%, 50%）をクリックしたときはオフセットが(0, 0)になること", () => {
      const offset = calculateOffsetFromMinimapClick({
        clickPct: { x: 50, y: 50 },
        contentSize: { width: 800, height: 600 },
        scale: 2.0,
      });
      expect(offset.x).toBeCloseTo(0, 1);
      expect(offset.y).toBeCloseTo(0, 1);
    });

    it("ミニマップ右側（75%, 50%）をクリックしたとき、画像が左へ移動する（負のオフセット）こと", () => {
      const offset = calculateOffsetFromMinimapClick({
        clickPct: { x: 75, y: 50 },
        contentSize: { width: 800, height: 600 },
        scale: 2.0,
      });
      // (75 - 50) / 100 * 800 * 2.0 = 0.25 * 1600 = 400 -> オフセットは -400
      expect(offset.x).toBeCloseTo(-400, 1);
      expect(offset.y).toBeCloseTo(0, 1);
    });
  });
});
