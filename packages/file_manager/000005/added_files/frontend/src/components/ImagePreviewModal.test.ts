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

  it("高解像度レンダリングのため、自然解像度(naturalSize)とスケールに応じた動的サイズスタイルまたはシャープ化処理が備わっていること", () => {
    const tsx = fs.readFileSync(modalTsxPath, "utf-8");
    // naturalSize に基づく高精細レンダリング処理（文字ボケ防止）
    expect(tsx).toMatch(/naturalSize/);
    expect(tsx).toMatch(/baseFitSize|fitSize|naturalWidth/);
    // CSSの画像レンダリング高品質指定
    const css = fs.readFileSync(modalCssPath, "utf-8");
    expect(css).toMatch(/image-rendering:\s*(high-quality|-webkit-optimize-contrast|auto)/);
  });

  it("右クリック等でinitialModeがgridの場合でも、画像選択後に矢印キーでの画像切り替え(handleNext/handlePrev)が動作しgridに戻らないよう制御されていること", () => {
    const tsx = fs.readFileSync(modalTsxPath, "utf-8");
    // isOpenの変化のみでinitialModeを適用するガード（prevIsOpenRef等）が存在すること
    expect(tsx).toMatch(/prevIsOpenRef/);
    // 矢印キーイベントハンドラーがキャプチャフェーズ(true)で登録されていること
    expect(tsx).toContain('addEventListener("keydown", handleKeyDown, true)');
    // activeImage基準でcurrentIndexが計算されていること
    expect(tsx).toMatch(/activeImage/);
    expect(tsx).toMatch(/siblingImages\.findIndex/);
  });

  it("グリッド表示時に上下左右（ArrowLeft, ArrowRight, ArrowUp, ArrowDown）の矢印キーでカード選択が移動でき、スクロール追従処理が備わっていること", () => {
    const tsx = fs.readFileSync(modalTsxPath, "utf-8");
    // 上下左右キーのハンドリング
    expect(tsx).toMatch(/ArrowUp/);
    expect(tsx).toMatch(/ArrowDown/);
    expect(tsx).toMatch(/ArrowLeft/);
    expect(tsx).toMatch(/ArrowRight/);
    // グリッド列数（columns）に応じた上下移動またはグリッド内選択インデックスの管理
    expect(tsx).toMatch(/selectedGridIndex|selectedCardIndex|focusedIndex/);
    // スクロール追従（scrollIntoView）
    expect(tsx).toMatch(/scrollIntoView/);
  });

  it("グリッド表示中にEnter/Returnキーを押すと選択中の画像が単一プレビュー（拡大プレビュー）として開くこと", () => {
    const tsx = fs.readFileSync(modalTsxPath, "utf-8");
    // Enterキーで選択画像を開く処理
    expect(tsx).toMatch(/e\.key\s*===\s*["']Enter["']/);
    expect(tsx).toMatch(/setViewMode\(["']single["']\)/);
  });

  it("単一プレビュー表示中に矢印キー（左右・上下）で次の画像・前の画像へ連続で切り替わり、グリッドに戻らずプレビュー状態が維持されること", () => {
    const tsx = fs.readFileSync(modalTsxPath, "utf-8");
    expect(tsx).toMatch(/viewMode\s*===\s*["']single["']/);
    // 単一プレビュー時の矢印キー操作で次へ/前へナビゲーション
    expect(tsx).toMatch(/handleNext/);
    expect(tsx).toMatch(/handlePrev/);
  });

  it("高速な操作レスポンスのため、グリッド選択スクロール追従が即時実行(behavior auto等)され、前後の画像プリロード処理が備わっていること", () => {
    const tsx = fs.readFileSync(modalTsxPath, "utf-8");
    // 即時スクロール追従（スムーズキュー遅延防止）
    expect(tsx).toMatch(/behavior:\s*["']auto["']/);
    // 前後画像の高速切り替え用プリロード（Image preloading）
    expect(tsx).toMatch(/preload|Image\(\)/);
  });

  it("背後要素のフォーカス残存によるキーイベント無反応を防止するため、モーダルへのフォーカス制御(tabIndex/focus)およびモーダル外フォーカス解除が備わっていること", () => {
    const tsx = fs.readFileSync(modalTsxPath, "utf-8");
    // tabIndex または focus() によるモーダルフォーカス制御
    expect(tsx).toMatch(/tabIndex={-1}|tabIndex="-1"|\.focus\(\)/);
    // モーダルオープン時のフォーカス確保
    expect(tsx).toMatch(/overlayRef\.current\?\.focus\(\)/);
  });

  it("キー連打時のインデックス追従遅延を防ぐため、Refまたは関数型更新(prev => ...)による確実な選択インデックス更新が備わっていること", () => {
    const tsx = fs.readFileSync(modalTsxPath, "utf-8");
    expect(tsx).toMatch(/selectedGridIndexRef|setSelectedGridIndex\(\(prev\)/);
  });

  it("矢印キー1回の押下で確実に移動し、古いpropsによるインデックス巻き戻し（リバウンド）を防止するため、モーダル内インデックスが自律更新されuseEffectでの引き戻しが存在しないこと", () => {
    const tsx = fs.readFileSync(modalTsxPath, "utf-8");
    // handleNext / handlePrev 内で selectedGridIndexRef.current を更新して1回で確実にインデックスを進める
    expect(tsx).toMatch(/selectedGridIndexRef\.current\s*=\s*nextIdx/);
    // モーダル操作中に currentImage props との差分で selectedGridIndex を古いインデックスに引き戻す悪影響な useEffect が存在しないこと
    expect(tsx).not.toMatch(/useEffect\(\(\)\s*=>\s*\{\s*if\s*\(currentImage\)\s*\{\s*const idx = siblingImages\.findIndex/);
  });

  it("モーダルが処理したキーイベントが背後のFileListコンポーネントに漏れて二重処理されないようstopPropagationが備わっていること", () => {
    const tsx = fs.readFileSync(modalTsxPath, "utf-8");
    expect(tsx).toMatch(/e\.stopPropagation\(\)/);
  });

  it("単一プレビュー表示中に上キー（ArrowUp）を押すと、フォルダ内ファイルのグリッド表示に戻る（setViewMode('grid')）こと", () => {
    const tsx = fs.readFileSync(modalTsxPath, "utf-8");
    // 単一プレビュー時の ArrowUp キー処理で grid 表示へ戻る
    expect(tsx).toMatch(/e\.key\s*===\s*["']ArrowUp["'][\s\S]*?setViewMode\(["']grid["']\)/);
  });

  it("階層（depth）を指定できるコントローラー（初期値0、増加/減少ボタン）とAPI連携が備わっていること", () => {
    const tsx = fs.readFileSync(modalTsxPath, "utf-8");
    // depth state (初期値 0)
    expect(tsx).toMatch(/depth.*useState.*0/);
    // 階層コントローラー（階層表示、増減ボタン）
    expect(tsx).toMatch(/階層/);
    // フォルダ内画像一覧取得API（getFolderImages）の呼び出し
    expect(tsx).toMatch(/getFolderImages/);
  });
});



