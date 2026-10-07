/**
 * 3D寸法測定および注記（アノテーション）オーバーレイ レイヤー仕様。
 * Three.js キャンバスの上に重なり、3D座標をスクリーン座標へ投影して
 * 寸法線（SVG）、頂点スナップマーカー、注記ピン、引出線、メモカードを描画する。
 * - 穴径(φ)、円弧半径(R)、C面取り、エッジ/直線寸法のスマート自動認識および手動選択切替
 * - 寸法ラベルおよび注記カードのマウスドラッグによる位置調整と引き出し線 (Leader Line)
 * - 完全オフライン動作（外部CDN・追加ライブラリ非依存）
 * - カメラ操作（回転・ズーム・パン）に追従するリアルタイム座標同期
 */

import React, { useState, useRef, useEffect } from "react";
import {
  Ruler,
  MessageSquare,
  X,
  ChevronDown,
  ChevronUp,
  Trash2,
  Check,
  Move,
  Edit2,
} from "lucide-react";
import { projectToScreen, calculateDistance } from "./measureUtils.js";

const CATEGORY_COLORS = [
  { name: "通常メモ", color: "#3b82f6" },     // Blue
  { name: "変更/追加確認", color: "#22c55e" }, // Green
  { name: "要確認/課題", color: "#eab308" },   // Yellow
  { name: "削除/不具合", color: "#ef4444" },   // Red
];

const TYPE_LABELS = {
  distance: "直線",
  diameter: "穴径 (φ)",
  radius: "半径 (R)",
  chamfer: "面取り (C)",
};

export function MeasureAnnotationLayer({
  width,
  height,
  camera,
  activeMode, // "none" | "measure" | "annotate"
  measurements,
  onUpdateMeasurement,
  onDeleteMeasurement,
  onClearMeasurements,
  currentMeasurePoints,
  hoverSnapPoint,
  annotations,
  onUpdateAnnotation,
  onDeleteAnnotation,
}) {
  const [activeTypeMenuId, setActiveTypeMenuId] = useState(null);

  // ドラッグ状態管理
  const [dragState, setDragState] = useState(null); // { type: 'measure' | 'annotation', id, startClientX, startClientY, initialOffset }

  if (!width || !height || !camera) return null;

  const projectFn = (pt) => {
    if (!pt) return { x: 0, y: 0, z: 0 };
    if (typeof pt.clone === "function") {
      const cloned = pt.clone().project(camera);
      return { x: cloned.x, y: cloned.y, z: cloned.z };
    }
    const v3 = new window.THREE_REF.Vector3(pt.x, pt.y, pt.z);
    v3.project(camera);
    return { x: v3.x, y: v3.y, z: v3.z };
  };

  // ドラッグイベントハンドラー
  const handlePointerDown = (e, itemType, item) => {
    e.stopPropagation();
    const initOffset = itemType === "measure"
      ? { ...(item.offset || { dx: 0, dy: 0 }) }
      : { ...(item.offset || { x: 25, y: -45 }) };

    setDragState({
      type: itemType,
      id: item.id,
      startClientX: e.clientX,
      startClientY: e.clientY,
      initialOffset: initOffset,
    });
  };

  const handlePointerMove = (e) => {
    if (!dragState) return;
    const deltaX = e.clientX - dragState.startClientX;
    const deltaY = e.clientY - dragState.startClientY;

    if (dragState.type === "measure") {
      const newOffset = {
        dx: dragState.initialOffset.dx + deltaX,
        dy: dragState.initialOffset.dy + deltaY,
      };
      if (onUpdateMeasurement) {
        onUpdateMeasurement(dragState.id, { offset: newOffset });
      }
    } else if (dragState.type === "annotation") {
      const newOffset = {
        x: dragState.initialOffset.x + deltaX,
        y: dragState.initialOffset.y + deltaY,
      };
      if (onUpdateAnnotation) {
        onUpdateAnnotation(dragState.id, { offset: newOffset });
      }
    }
  };

  const handlePointerUp = () => {
    if (dragState) setDragState(null);
  };

  // 1. スナップマーカーの投影
  let snapScreen = null;
  if (hoverSnapPoint) {
    const s = projectToScreen(hoverSnapPoint, projectFn, width, height);
    if (s.visible) snapScreen = s;
  }

  // 2. 計測中（1点または複数点指定済み）のリアルタイム寸法線
  let currentMeasureScreen = null;
  if (currentMeasurePoints && currentMeasurePoints.length > 0 && hoverSnapPoint) {
    const pStart = currentMeasurePoints[0];
    const s1 = projectToScreen(pStart, projectFn, width, height);
    const s2 = projectToScreen(hoverSnapPoint, projectFn, width, height);
    if (s1.visible && s2.visible) {
      const dist = Math.sqrt(
        (hoverSnapPoint.x - pStart.x) ** 2 +
        (hoverSnapPoint.y - pStart.y) ** 2 +
        (hoverSnapPoint.z - pStart.z) ** 2
      );
      currentMeasureScreen = {
        x1: s1.x,
        y1: s1.y,
        x2: s2.x,
        y2: s2.y,
        midX: (s1.x + s2.x) / 2,
        midY: (s1.y + s2.y) / 2,
        distLabel: `${dist.toFixed(2)} mm`,
      };
    }
  }

  // 3. 確定済みピン留め寸法の投影
  const projectedMeasurements = measurements
    .map((m) => {
      const s1 = projectToScreen(m.start, projectFn, width, height);
      const s2 = projectToScreen(m.end, projectFn, width, height);
      if (!s1.visible || !s2.visible) return null;

      const midX = (s1.x + s2.x) / 2;
      const midY = (s1.y + s2.y) / 2;
      const offX = m.offset?.dx || 0;
      const offY = m.offset?.dy || 0;
      const badgeX = midX + offX;
      const badgeY = midY + offY;

      return {
        ...m,
        x1: s1.x,
        y1: s1.y,
        x2: s2.x,
        y2: s2.y,
        midX,
        midY,
        badgeX,
        badgeY,
        hasLeader: offX !== 0 || offY !== 0,
      };
    })
    .filter(Boolean);

  // 4. 注記の投影
  const projectedAnnotations = annotations
    .map((a) => {
      const s = projectToScreen(a.point, projectFn, width, height);
      if (!s.visible) return null;
      return {
        ...a,
        screenX: s.x,
        screenY: s.y,
      };
    })
    .filter(Boolean);

  return (
    <div
      className="measure-annotation-overlay"
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width,
        height,
        pointerEvents: dragState ? "auto" : "none",
        overflow: "hidden",
        userSelect: "none",
      }}
    >
      {/* SVG層: 寸法線、引出線、矢印 */}
      <svg
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
        }}
      >
        <defs>
          <marker
            id="arrowhead-cyan"
            markerWidth="6"
            markerHeight="6"
            refX="3"
            refY="3"
            orient="auto"
          >
            <path d="M 0 0 L 6 3 L 0 6 z" fill="#38bdf8" />
          </marker>
        </defs>

        {/* 計測中のリアルタイム線 */}
        {currentMeasureScreen && (
          <g>
            <line
              x1={currentMeasureScreen.x1}
              y1={currentMeasureScreen.y1}
              x2={currentMeasureScreen.x2}
              y2={currentMeasureScreen.y2}
              stroke="#38bdf8"
              strokeWidth="2"
              strokeDasharray="4 3"
            />
            <circle cx={currentMeasureScreen.x1} cy={currentMeasureScreen.y1} r="4" fill="#38bdf8" />
            <circle cx={currentMeasureScreen.x2} cy={currentMeasureScreen.y2} r="4" fill="#38bdf8" />
          </g>
        )}

        {/* 確定済み寸法線 & 引き出し線 */}
        {projectedMeasurements.map((m) => (
          <g key={m.id} className="measure-item-group">
            {/* 測定箇所の幾何ライン */}
            <line
              x1={m.x1}
              y1={m.y1}
              x2={m.x2}
              y2={m.y2}
              stroke="#38bdf8"
              strokeWidth="2"
            />
            <circle cx={m.x1} cy={m.y1} r="4" fill="#0f172a" stroke="#38bdf8" strokeWidth="2" />
            <circle cx={m.x2} cy={m.y2} r="4" fill="#0f172a" stroke="#38bdf8" strokeWidth="2" />

            {/* ドラッグで移動した時の引き出し線 (Leader line) */}
            {m.hasLeader && (
              <g>
                <line
                  x1={m.midX}
                  y1={m.midY}
                  x2={m.badgeX}
                  y2={m.badgeY}
                  stroke="#38bdf8"
                  strokeWidth="1.5"
                  strokeDasharray="3 3"
                />
                <circle cx={m.midX} cy={m.midY} r="3" fill="#38bdf8" />
              </g>
            )}
          </g>
        ))}

        {/* 注記の引出線 */}
        {projectedAnnotations.map((a) => {
          if (a.collapsed) return null;
          const cardX = a.screenX + (a.offset?.x ?? 25);
          const cardY = a.screenY + (a.offset?.y ?? -45);
          return (
            <g key={`leader-${a.id}`}>
              <line
                x1={a.screenX}
                y1={a.screenY}
                x2={cardX}
                y2={cardY}
                stroke={a.color || "#3b82f6"}
                strokeWidth="1.5"
                strokeDasharray="3 2"
              />
              <circle cx={a.screenX} cy={a.screenY} r="3.5" fill={a.color || "#3b82f6"} />
            </g>
          );
        })}
      </svg>

      {/* HTML層: スナップインジケータ */}
      {snapScreen && (
        <div
          style={{
            position: "absolute",
            left: snapScreen.x - 7,
            top: snapScreen.y - 7,
            width: 14,
            height: 14,
            borderRadius: "50%",
            border: "2px solid #22c55e",
            boxShadow: "0 0 6px #22c55e",
            pointerEvents: "none",
            zIndex: 10,
          }}
        />
      )}

      {/* 計測中のリアルタイム数値バッジ */}
      {currentMeasureScreen && (
        <div
          style={{
            position: "absolute",
            left: currentMeasureScreen.midX,
            top: currentMeasureScreen.midY,
            transform: "translate(-50%, -50%)",
            background: "rgba(15, 23, 42, 0.9)",
            border: "1px solid #38bdf8",
            borderRadius: 4,
            padding: "2px 6px",
            color: "#38bdf8",
            fontSize: "11px",
            fontWeight: "bold",
            pointerEvents: "none",
            boxShadow: "0 2px 6px rgba(0,0,0,0.4)",
            whiteSpace: "nowrap",
          }}
        >
          {currentMeasureScreen.distLabel}
        </div>
      )}

      {/* 確定済み寸法バッジ（ドラッグハンドル・手動切替ピル・個別削除ボタン付き） */}
      {projectedMeasurements.map((m) => (
        <div
          key={`badge-${m.id}`}
          style={{
            position: "absolute",
            left: m.badgeX,
            top: m.badgeY,
            transform: "translate(-50%, -50%)",
            background: "rgba(15, 23, 42, 0.92)",
            border: "1px solid #0284c7",
            borderRadius: 5,
            padding: "3px 8px",
            color: "#f8fafc",
            fontSize: "11px",
            fontWeight: "600",
            pointerEvents: "auto",
            display: "flex",
            alignItems: "center",
            gap: 6,
            boxShadow: "0 3px 10px rgba(0,0,0,0.5)",
            cursor: "grab",
            zIndex: 14,
          }}
          onPointerDown={(e) => handlePointerDown(e, "measure", m)}
          title="ドラッグで位置調整 / クリックで種別選択"
        >
          {/* ドラッグアイコン */}
          <Move size={11} className="text-sky-400 opacity-70" />

          {/* 寸法ラベル（クリックで手動選択ピルを開閉） */}
          <span
            onClick={(e) => {
              e.stopPropagation();
              if (m.availableTypes && m.availableTypes.length > 1) {
                setActiveTypeMenuId(activeTypeMenuId === m.id ? null : m.id);
              }
            }}
            style={{
              cursor: m.availableTypes && m.availableTypes.length > 1 ? "pointer" : "grab",
              textDecoration: m.availableTypes && m.availableTypes.length > 1 ? "underline dotted" : "none",
            }}
            title={m.availableTypes && m.availableTypes.length > 1 ? "クリックして表示形式を手動変更" : undefined}
          >
            {m.label}
          </span>

          {/* 手動選択ドロップダウンピル（人間が選択するフォールバック） */}
          {activeTypeMenuId === m.id && m.availableTypes && (
            <div
              style={{
                position: "absolute",
                top: "100%",
                left: 0,
                marginTop: 4,
                background: "#1e293b",
                border: "1px solid #38bdf8",
                borderRadius: 4,
                padding: 4,
                display: "flex",
                flexDirection: "column",
                gap: 2,
                boxShadow: "0 4px 12px rgba(0,0,0,0.6)",
                zIndex: 30,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {m.availableTypes.map((t) => (
                <button
                  key={t}
                  onClick={() => {
                    let newLabel = m.label;
                    if (t === "diameter" && m.diameter) newLabel = `φ${m.diameter.toFixed(2)} mm`;
                    else if (t === "radius" && m.radius) newLabel = `R${m.radius.toFixed(2)} mm`;
                    else if (t === "distance") newLabel = `${(m.value || m.distance).toFixed(2)} mm`;
                    else if (t === "chamfer") newLabel = `C${(m.value || 2).toFixed(2)} mm`;

                    if (onUpdateMeasurement) {
                      onUpdateMeasurement(m.id, { type: t, label: newLabel });
                    }
                    setActiveTypeMenuId(null);
                  }}
                  style={{
                    background: m.type === t ? "#0284c7" : "transparent",
                    color: "#fff",
                    border: "none",
                    borderRadius: 3,
                    padding: "2px 8px",
                    fontSize: "10px",
                    textAlign: "left",
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  {TYPE_LABELS[t] || t}
                </button>
              ))}
            </div>
          )}

          {/* 削除ボタン */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDeleteMeasurement(m.id);
            }}
            style={{
              background: "transparent",
              border: "none",
              color: "#94a3b8",
              cursor: "pointer",
              padding: 0,
              display: "flex",
              alignItems: "center",
            }}
            title="寸法を削除"
          >
            <X size={12} className="hover:text-red-400" />
          </button>
        </div>
      ))}

      {/* 注記ピンおよびメモカード（ドラッグ移動対応） */}
      {projectedAnnotations.map((a) => {
        const cardX = a.screenX + (a.offset?.x ?? 25);
        const cardY = a.screenY + (a.offset?.y ?? -45);

        return (
          <React.Fragment key={`annot-${a.id}`}>
            {/* 注記ピンマーカー */}
            <div
              style={{
                position: "absolute",
                left: a.screenX - 10,
                top: a.screenY - 10,
                width: 20,
                height: 20,
                borderRadius: "50%",
                background: a.color || "#3b82f6",
                border: "2px solid #ffffff",
                boxShadow: "0 0 8px rgba(0,0,0,0.6)",
                cursor: "pointer",
                pointerEvents: "auto",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 12,
              }}
              onClick={(e) => {
                e.stopPropagation();
                onUpdateAnnotation(a.id, { collapsed: !a.collapsed });
              }}
              title={a.collapsed ? `メモを展開: ${a.text || "無題"}` : "メモを折りたたむ"}
            >
              <span style={{ fontSize: "10px", color: "#fff", fontWeight: "bold" }}>●</span>
            </div>

            {/* 注記カード（ヘッダーでドラッグ位置調整） */}
            {!a.collapsed && (
              <div
                style={{
                  position: "absolute",
                  left: cardX,
                  top: cardY,
                  background: "#1e293b",
                  border: `1px solid ${a.color || "#3b82f6"}`,
                  borderRadius: 6,
                  padding: "6px 8px",
                  color: "#f8fafc",
                  fontSize: "12px",
                  pointerEvents: "auto",
                  boxShadow: "0 4px 14px rgba(0,0,0,0.6)",
                  minWidth: 160,
                  maxWidth: 240,
                  zIndex: 20,
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {/* ヘッダー・ドラッグバー＆カラー選択 */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 6,
                    gap: 6,
                    cursor: "grab",
                  }}
                  onPointerDown={(e) => handlePointerDown(e, "annotation", a)}
                  title="ドラッグでメモ位置を移動"
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <Move size={11} className="text-slate-400" />
                    {CATEGORY_COLORS.map((c) => (
                      <div
                        key={c.color}
                        onClick={() => onUpdateAnnotation(a.id, { color: c.color })}
                        style={{
                          width: 11,
                          height: 11,
                          borderRadius: "50%",
                          background: c.color,
                          cursor: "pointer",
                          border: a.color === c.color ? "1.5px solid #ffffff" : "none",
                        }}
                        title={c.name}
                      />
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: 4 }}>
                    <button
                      onClick={() => onUpdateAnnotation(a.id, { collapsed: true })}
                      style={{
                        background: "transparent",
                        border: "none",
                        color: "#94a3b8",
                        cursor: "pointer",
                        padding: 0,
                      }}
                      title="最小化"
                    >
                      <ChevronUp size={13} />
                    </button>
                    <button
                      onClick={() => onDeleteAnnotation(a.id)}
                      style={{
                        background: "transparent",
                        border: "none",
                        color: "#ef4444",
                        cursor: "pointer",
                        padding: 0,
                      }}
                      title="注記を削除"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>

                {/* メモテキストエリア */}
                <textarea
                  value={a.text}
                  onChange={(e) => onUpdateAnnotation(a.id, { text: e.target.value })}
                  placeholder="注記・レビューメモを入力..."
                  rows={2}
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    background: "#0f172a",
                    border: "1px solid #334155",
                    borderRadius: 4,
                    color: "#f8fafc",
                    fontSize: "11px",
                    padding: "4px 6px",
                    resize: "vertical",
                    outline: "none",
                  }}
                />
              </div>
            )}
          </React.Fragment>
        );
      })}

      {/* 右上のコントロールパネル（寸法一覧・注記数・全消去） */}
      {(measurements.length > 0 || annotations.length > 0) && (
        <div
          style={{
            position: "absolute",
            top: 10,
            right: 10,
            background: "rgba(15, 23, 42, 0.88)",
            backdropFilter: "blur(4px)",
            border: "1px solid #334155",
            borderRadius: 6,
            padding: "6px 10px",
            color: "#94a3b8",
            fontSize: "11px",
            pointerEvents: "auto",
            display: "flex",
            alignItems: "center",
            gap: 10,
            zIndex: 15,
          }}
        >
          {measurements.length > 0 && (
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <Ruler size={13} className="text-sky-400" />
              <span>寸法: {measurements.length} 件</span>
              <button
                onClick={onClearMeasurements}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#ef4444",
                  cursor: "pointer",
                  fontSize: "10px",
                  marginLeft: 2,
                  textDecoration: "underline",
                }}
              >
                消去
              </button>
            </span>
          )}
          {annotations.length > 0 && (
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <MessageSquare size={13} className="text-emerald-400" />
              <span>注記: {annotations.length} 件</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
