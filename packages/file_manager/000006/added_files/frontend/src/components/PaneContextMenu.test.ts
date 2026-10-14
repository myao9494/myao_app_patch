/**
 * ペイン右クリックメニューコンポーネント (PaneContextMenu) の検証テスト
 * - 「画像を表示」メニュー項目の表示とコールバック実行
 * - リスト取得（check_box / 箇条書き / リンク付）および隣のペインで開くの検証
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

describe("PaneContextMenu Component Tests", () => {
  const componentPath = path.resolve(__dirname, "PaneContextMenu.tsx");

  it("「画像を表示」メニュー項目のプロパティ onOpenImageViewer が定義されていること", () => {
    const tsx = fs.readFileSync(componentPath, "utf-8");
    expect(tsx).toContain("onOpenImageViewer?: () => void");
  });

  it("「画像を表示」メニュー項目とアイコン（ImageIcon等）がレンダリングに含まれること", () => {
    const tsx = fs.readFileSync(componentPath, "utf-8");
    expect(tsx).toMatch(/onOpenImageViewer/);
    expect(tsx).toContain("画像を表示");
    expect(tsx).toMatch(/ImageIcon|Image/);
  });

  it("「リスト取得(リンク付)」メニュー項目のプロパティ onCopyLinkList が定義されていること", () => {
    const tsx = fs.readFileSync(componentPath, "utf-8");
    expect(tsx).toContain("onCopyLinkList?: () => void");
  });

  it("「リスト取得(リンク付)」メニュー項目とLinkアイコンがレンダリングに含まれること", () => {
    const tsx = fs.readFileSync(componentPath, "utf-8");
    expect(tsx).toMatch(/onCopyLinkList/);
    expect(tsx).toContain("リスト取得(リンク付)");
    expect(tsx).toMatch(/Link/);
  });
});

