/**
 * ImagePreviewModal コンポーネントおよびスタイルの検証テスト
 * - マウスホイールによるズーム処理とパッシブ制御
 * - ポインターイベントによるドラッグ・パン移動処理
 * - 実寸（1:1）および画面フィット機能
 * - 水平/垂直反転およびピクセル補間トグル
 * - ミニマップ機能
 * - キーボードショートカット対応
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

describe("ImagePreviewModal Rich Viewer Tests", () => {
  const modalTsxPath = path.resolve(__dirname, "ImagePreviewModal.tsx");
  const modalCssPath = path.resolve(__dirname, "ImagePreviewModal.css");

  it("ホイール操作によるズームイベントハンドラーが passive: false で登録されていること", () => {
    const tsx = fs.readFileSync(modalTsxPath, "utf-8");
    // passive: false で wheel イベントをリッスンし、preventDefault して拡大縮小する
    expect(tsx).toContain("addEventListener");
    expect(tsx).toMatch(/wheel/i);
    expect(tsx).toContain("passive: false");
    expect(tsx).toContain("preventDefault");
  });

  it("ドラッグ（パン移動）のためのポインターイベントが実装されていること", () => {
    const tsx = fs.readFileSync(modalTsxPath, "utf-8");
    // pointerdown, pointermove, pointerup を処理する
    expect(tsx).toMatch(/pointerdown/i);
    expect(tsx).toMatch(/pointermove/i);
    expect(tsx).toMatch(/pointerup/i);
    // offset (translateX, translateY) がスタイルに反映されること
    expect(tsx).toContain("translate");
  });

  it("実寸（1:1）表示および画面フィットボタンが備わっていること", () => {
    const tsx = fs.readFileSync(modalTsxPath, "utf-8");
    expect(tsx).toMatch(/実寸|1:1/);
    expect(tsx).toMatch(/フィット/);
  });

  it("反転（水平/垂直）およびピクセル補間（Pixelated）の切り替えが実装されていること", () => {
    const tsx = fs.readFileSync(modalTsxPath, "utf-8");
    expect(tsx).toMatch(/flip|反転/i);
    expect(tsx).toMatch(/pixelated/i);
  });

  it("ミニマップ（ナビゲーター）表示とクリック移動が実装されていること", () => {
    const tsx = fs.readFileSync(modalTsxPath, "utf-8");
    expect(tsx).toMatch(/minimap/i);
  });

  it("フルスクリーン切り替えが実装されていること", () => {
    const tsx = fs.readFileSync(modalTsxPath, "utf-8");
    expect(tsx).toMatch(/fullscreen/i);
  });

  it("CSSにドラッグ中やピクセル補間、ミニマップのスタイルが定義されていること", () => {
    const css = fs.readFileSync(modalCssPath, "utf-8");
    expect(css).toMatch(/grabbing/);
    expect(css).toMatch(/pixelated/);
    expect(css).toMatch(/minimap/);
  });

  it("画像表示領域やコントロールの操作時に勝手にモーダルが閉じないようイベント伝播が遮断されていること", () => {
    const tsx = fs.readFileSync(modalTsxPath, "utf-8");
    // body領域のクリックや操作でイベント伝播を止め、勝手に閉じないこと
    expect(tsx).toContain("stopPropagation");
    // e.target === overlayRef.current による外側クリック判定があること
    expect(tsx).toContain("overlayRef.current");
  });

  it("SVGアイコンが黒く塗りつぶされないようfillとstrokeが明示的に保護されていること", () => {
    const css = fs.readFileSync(modalCssPath, "utf-8");
    // svg の fill: none または stroke: currentColor が定義されていること
    expect(css).toMatch(/svg\s*\{[^}]*fill:\s*none/);
    expect(css).toMatch(/svg\s*\{[^}]*stroke:\s*currentColor/);
  });

  it("ダークモードおよびライトモードのテーマスタイルが定義されていること", () => {
    const css = fs.readFileSync(modalCssPath, "utf-8");
    expect(css).toContain("data-theme");
  });

  it("画像をクリップボードにコピー（保存）するボタンおよびショートカットが備わっていること", () => {
    const tsx = fs.readFileSync(modalTsxPath, "utf-8");
    expect(tsx).toMatch(/クリップボードに(コピー|保存)/);
    expect(tsx).toContain("copyImageToClipboard");
  });

  it("複数画像表示（グリッド表示モード）の切り替えとアイコンが備わっていること", () => {
    const tsx = fs.readFileSync(modalTsxPath, "utf-8");
    // LayoutGrid アイコンやグリッド表示切替ボタン
    expect(tsx).toMatch(/LayoutGrid/);
    expect(tsx).toMatch(/グリッド表示|一覧表示/);
    // viewMode モード切り替えロジック
    expect(tsx).toMatch(/viewMode/);
  });

  it("グリッド表示時に複数画像（サムネイルリスト）とメタデータがレンダリングされること", () => {
    const tsx = fs.readFileSync(modalTsxPath, "utf-8");
    expect(tsx).toContain("image-preview-grid");
    expect(tsx).toMatch(/grid-card|grid-item/);
    // サムネイルクリックで単一画像プレビューに切り替えるハンドラー
    expect(tsx).toMatch(/handleSelectImage|handleImageClick/);
  });

  it("ショートカットキー G によるグリッド表示トグルが備わっていること", () => {
    const tsx = fs.readFileSync(modalTsxPath, "utf-8");
    expect(tsx).toMatch(/e\.key\.toLowerCase\(\)\s*===\s*["']g["']/);
  });

  it("CSSに複数画像グリッド表示のスタイルが定義されていること", () => {
    const css = fs.readFileSync(modalCssPath, "utf-8");
    expect(css).toMatch(/\.image-preview-grid/);
    expect(css).toMatch(/grid-template-columns/);
  });
});
