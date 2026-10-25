/**
 * 画像ビューアの上部バー（表示の切り替え・拡大縮小・メモを開く）。
 * 表示: 元画像 / 補正B / 差分（オーバーレイ） / マスク。数字キー 1〜4 と Tab でも切り替えられる。
 */
import React from "react";
import { Maximize, MoveHorizontal, PanelRight, PanelTopOpen, ZoomIn, ZoomOut } from "lucide-react";

export const VIEWS = [
  { id: "original", label: "元画像", key: "1" },
  { id: "aligned", label: "補正B", key: "2" },
  { id: "overlay", label: "差分", key: "3" },
  { id: "mask", label: "マスク", key: "4" },
];

export function ViewerToolbar({ view, onViewChange, viewsEnabled, zoom, onZoom, onFitWidth, onFitAll, memoLabel, onOpenMemo, canOpenMemo, status, inspectorOpen, onToggleInspector }) {
  return (
    <div className="viewer-toolbar">
      <div className="segmented" role="group" aria-label="表示の切り替え">
        {VIEWS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={view === item.id ? "active" : ""}
            disabled={!viewsEnabled}
            title={`${item.label}（${item.key}）`}
            onClick={() => onViewChange(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {status && <span className="viewer-status">{status}</span>}
      <div className="viewer-toolbar-right">
        <div className="zoom-group" role="group" aria-label="拡大縮小">
          <button type="button" className="btn btn-ghost btn-icon" title="縮小" aria-label="縮小" onClick={() => onZoom(-0.1)}>
            <ZoomOut size={16} />
          </button>
          <output title="Ctrl+ホイールでも拡大縮小できます">{Math.round(zoom * 100)}%</output>
          <button type="button" className="btn btn-ghost btn-icon" title="拡大" aria-label="拡大" onClick={() => onZoom(0.1)}>
            <ZoomIn size={16} />
          </button>
          <button type="button" className="btn btn-ghost btn-icon" title="幅に合わせる（W）" aria-label="幅に合わせる" onClick={onFitWidth}>
            <MoveHorizontal size={16} />
          </button>
          <button type="button" className="btn btn-ghost btn-icon" title="全体を表示（F）" aria-label="全体を表示" onClick={onFitAll}>
            <Maximize size={16} />
          </button>
        </div>
        {onOpenMemo && (
          <button type="button" className="btn" disabled={!canOpenMemo} onClick={onOpenMemo} title="別タブでメモを付ける">
            <PanelTopOpen size={16} />
            {memoLabel}
          </button>
        )}
        {onToggleInspector && (
          <button
            type="button"
            className={`btn btn-ghost btn-icon ${inspectorOpen ? "active" : ""}`}
            title={inspectorOpen ? "右パネルを隠す（I）" : "右パネルを表示（I）"}
            aria-label="右パネルの表示切り替え"
            aria-pressed={inspectorOpen}
            onClick={onToggleInspector}
          >
            <PanelRight size={17} />
          </button>
        )}
      </div>
    </div>
  );
}
