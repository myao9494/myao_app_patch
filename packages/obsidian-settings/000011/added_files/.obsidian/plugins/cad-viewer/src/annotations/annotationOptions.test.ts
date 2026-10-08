/**
 * 注記のフォントサイズおよび文字色のスタイルオプションに関する単体テスト
 **/
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FONT_SIZE_OPTIONS,
  TEXT_COLOR_OPTIONS,
  getEffectiveFontSize,
  getEffectiveTextColor,
} from "./annotationOptions";

describe("annotationOptions", () => {
  it("フォントサイズオプションが正しく定義されていること", () => {
    assert.ok(FONT_SIZE_OPTIONS.length >= 3);
    const keys = FONT_SIZE_OPTIONS.map((o) => o.key);
    assert.ok(keys.includes("small"));
    assert.ok(keys.includes("medium"));
    assert.ok(keys.includes("large"));
  });

  it("getEffectiveFontSizeで適切なCSSフォントサイズ値が取得できること", () => {
    assert.equal(getEffectiveFontSize("small"), "12px");
    assert.equal(getEffectiveFontSize("medium"), "14px");
    assert.equal(getEffectiveFontSize("large"), "18px");
    assert.equal(getEffectiveFontSize("xlarge"), "24px");
    // 未指定時はmedium (14px)
    assert.equal(getEffectiveFontSize(undefined), "14px");
    // カスタムpx指定時
    assert.equal(getEffectiveFontSize("16px"), "16px");
  });

  it("文字色オプションが正しく定義されていること", () => {
    assert.ok(TEXT_COLOR_OPTIONS.length >= 4);
    const colors = TEXT_COLOR_OPTIONS.map((o) => o.color);
    assert.ok(colors.includes("#000000"));
    assert.ok(colors.includes("#ffffff"));
    assert.ok(colors.includes("#e5484d"));
  });

  it("getEffectiveTextColorで適切な文字色が取得できること", () => {
    assert.equal(getEffectiveTextColor("#000000"), "#000000");
    assert.equal(getEffectiveTextColor("#e5484d"), "#e5484d");
    assert.equal(getEffectiveTextColor(undefined), undefined);
    assert.equal(getEffectiveTextColor(""), undefined);
  });
});
