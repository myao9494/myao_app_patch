/**
 * 画像差分の右パネル。比較の設定（カテゴリ・基準領域・しきい値）と結果（差分率・凡例・変更箇所の一覧）をまとめる。
 * 変更箇所をクリックすると、左右の画像をその位置へ移動して強調表示する。
 */
import React from "react";
import { AlertTriangle, Crosshair, MousePointer2, X } from "lucide-react";

const CATEGORIES = ["汎用", "図面", "グラフ", "書類"];

export function DiffInspector({
  result,
  threshold,
  onThresholdChange,
  category,
  onCategoryChange,
  anchor,
  focusedRect,
  onFocusRect,
  busy,
  onClose,
}) {
  const rects = result?.diff_rects ?? [];
  const warnings = [
    result?.alignment?.warning ? `位置合わせに失敗したため、補正せずに比較しています（${result.alignment.warning}）` : null,
    ...(result?.conversion_warnings ?? []).map((warning) => `変換時の注意: ${warning}`),
  ].filter(Boolean);

  return (
    <aside className="inspector" aria-label="比較の設定と結果">
      {onClose && (
        <button type="button" className="btn btn-ghost btn-icon inspector-close" aria-label="右パネルを閉じる" title="閉じる（I）" onClick={onClose}>
          <X size={16} />
        </button>
      )}
      {result ? (
        <section className="inspector-section summary-section">
          <div className="summary-hero">
            <span className="summary-label">差分率</span>
            <strong className={result.diff_ratio > 0 ? "has-diff" : "no-diff"}>{(result.diff_ratio * 100).toFixed(3)}%</strong>
            <span className="summary-sub">
              {rects.length ? `${rects.length}か所の変更` : result.diff_pixels ? "小さな差分のみ" : "差分なし"}
            </span>
          </div>
          <dl className="summary-grid">
            <div><dt>差分ピクセル</dt><dd>{result.diff_pixels.toLocaleString()}</dd></div>
            <div title="一致した特徴点の数 / 位置合わせに採用した数"><dt>特徴点</dt><dd>{result.alignment.method === "cached" ? "—" : `${result.alignment.matches} / ${result.alignment.inliers}`}</dd></div>
          </dl>
          <p className="summary-method" title={result.alignment.method}>位置合わせ: {result.alignment.method === "none" ? "なし" : result.alignment.method === "cached" ? "保存済みの結果" : result.alignment.method}</p>
        </section>
      ) : (
        <section className="inspector-section">
          <p className="inspector-hint">A と B を選んで「比較」を押すと、ここに差分率と変更箇所が表示されます。</p>
        </section>
      )}

      {warnings.length > 0 && (
        <section className="inspector-section">
          {warnings.map((warning) => (
            <p className="callout warning" key={warning}><AlertTriangle size={15} />{warning}</p>
          ))}
        </section>
      )}

      {result && (
        <section className="inspector-section">
          <h3>凡例</h3>
          <ul className="legend">
            <li><i className="swatch removed" />削除<span>A（基準）だけにある</span></li>
            <li><i className="swatch added" />追加<span>B（比較）だけにある</span></li>
            <li><i className="swatch changed" />変更<span>両方にあり、違う</span></li>
          </ul>
        </section>
      )}

      <section className="inspector-section">
        <label className="slider-field">
          <span className="slider-head">
            <h3>しきい値</h3>
            <output>{threshold.toFixed(2)}</output>
          </span>
          <input type="range" min="0" max="1" step="0.01" value={threshold} onChange={(event) => onThresholdChange(Number(event.target.value))} />
          <span className="slider-scale"><span>細かな違いも検出</span><span>大きな違いだけ</span></span>
        </label>
      </section>

      <section className="inspector-section">
        <h3>画像の種類</h3>
        <div className="segmented full" role="group" aria-label="画像の種類">
          {CATEGORIES.map((item) => (
            <button key={item} type="button" className={category === item ? "active" : ""} onClick={() => onCategoryChange(item)}>
              {item}
            </button>
          ))}
        </div>
        <p className="inspector-note">種類に合わせて位置合わせの前処理を切り替えます。</p>
      </section>

      {anchor && (
        <section className="inspector-section">
          <h3>位置合わせの基準領域</h3>
          {anchor.picking ? (
            <>
              <p className="callout info"><MousePointer2 size={15} />A の画像上で、位置合わせに使う枠をクリックしてください。</p>
              <button type="button" className="btn btn-ghost anchor-action" onClick={anchor.onCancelPicking}>やめる</button>
            </>
          ) : anchor.selected ? (
            <>
              <div className="anchor-chip">
                <Crosshair size={15} />
                <span>{anchor.selected.label}</span>
                <button type="button" className="btn btn-ghost btn-icon" aria-label="基準領域を解除" title="解除" onClick={anchor.onClear}>
                  <X size={15} />
                </button>
              </div>
              <button type="button" className="btn btn-ghost anchor-action" onClick={anchor.onStartPicking}>選び直す</button>
            </>
          ) : (
            <>
              <button type="button" className="btn anchor-action" disabled={!anchor.count} onClick={anchor.onStartPicking}>
                <Crosshair size={15} />
                画像上で選ぶ（{anchor.count}候補）
              </button>
              <p className="inspector-note">通常は自動で位置合わせします。ずれる場合に、図枠など動かない部分を基準にできます。</p>
            </>
          )}
        </section>
      )}

      {result && (
        <section className="inspector-section grow">
          <h3>変更箇所 <span className="count">{rects.length}</span></h3>
          {rects.length ? (
            <ol className="change-list">
              {rects.map((rect, index) => {
                const active = focusedRect && focusedRect.x === rect.x && focusedRect.y === rect.y && focusedRect.width === rect.width && focusedRect.height === rect.height;
                return (
                  <li key={`${rect.x}-${rect.y}-${rect.width}-${rect.height}`}>
                    <button type="button" className={active ? "active" : ""} disabled={busy} onClick={() => onFocusRect(rect)}>
                      <span className="change-index">{index + 1}</span>
                      <span className="change-size">{rect.width} × {rect.height}px</span>
                      <span className="change-pos">({rect.x}, {rect.y})</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="inspector-note">大きな変更箇所はありません。</p>
          )}
        </section>
      )}
    </aside>
  );
}
