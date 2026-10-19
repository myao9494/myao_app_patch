/**
 * ステップ 2: 候補ノートの選択。
 * 候補の一覧をチェックボックスで選ぶ。押すたびに切り替わり、ドラッグでまとめて切り替え、Shift + ドラッグでまとめて解除できる。
 * 選択したノートの概算トークン数を表示し、ここから HTML の生成を始められる。
 */
import { truncateSnippet } from "../../aiInputCandidate";
import type { UseAiDocumentBuilderResult } from "../../hooks/useAiDocumentBuilder";
import type { UseAiCandidatesResult } from "../../hooks/useAiCandidates";

type AiCandidateTableProps = {
  builder: UseAiDocumentBuilderResult;
  candidateList: UseAiCandidatesResult;
  openFileViaHub: (fullPath: string) => void;
};

export function AiCandidateTable({ builder, candidateList, openFileViaHub }: AiCandidateTableProps) {
  const { handleGenerateHtml, isGenerating } = builder;
  const {
    candidates,
    defaultSelectCount,
    deselectAll,
    dragModeRef,
    estimatedTokens,
    handleCheckboxMouseDown,
    handleDefaultSelectCountChange,
    handleRowMouseEnter,
    isDragging,
    selectAll,
    selectedPaths,
    toggleSelect,
  } = candidateList;

  return (
    <div className="panel glass-panel" style={{ marginBottom: "16px", padding: "18px 22px", borderRadius: "14px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px", marginBottom: "14px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          <h2 style={{ fontSize: "15px", fontWeight: 600, margin: 0, display: "flex", alignItems: "center", gap: "8px", color: "#f8fafc" }}>
            <span>☑️</span>
            ステップ 2: AIにインプットするノートを選択
          </h2>
          <span className="badge" style={{ backgroundColor: "rgba(168, 85, 247, 0.2)", color: "#c084fc", fontSize: "12px", padding: "2px 8px" }}>
            {selectedPaths.size} / {candidates.length} 件 選択中
          </span>
          {selectedPaths.size > 0 && (
            <span style={{ fontSize: "12px", color: "#38bdf8", fontWeight: 500 }}>
              約 {estimatedTokens.toLocaleString()} トークン
            </span>
          )}
          <span style={{ fontSize: "11.5px", color: "#94a3b8" }}>
            💡 <strong>クリック</strong>で切替 / <strong>ドラッグ</strong>で連続切替 / <strong>Shift+ドラッグ</strong>で連続解除
          </span>
        </div>

        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <button
            className="btn btn-primary ai-generate-top-btn"
            title="AI用HTMLファイルを生成する"
            onClick={() => void handleGenerateHtml()}
            disabled={isGenerating || selectedPaths.size === 0}
          >
            {isGenerating ? (
              <>
                <span className="spin">🔄</span>
                HTML生成中...
              </>
            ) : (
              <>
                <span>🚀</span>
                AI用HTMLファイルを生成する ({selectedPaths.size}件)
              </>
            )}
          </button>
          <button className="btn btn-secondary" style={{ fontSize: "12px", padding: "4px 12px" }} onClick={selectAll}>
            全選択
          </button>
          <button className="btn btn-secondary" style={{ fontSize: "12px", padding: "4px 12px" }} onClick={deselectAll}>
            全解除
          </button>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              marginLeft: "4px",
              padding: "3px 8px",
              borderRadius: "6px",
              backgroundColor: "rgba(255, 255, 255, 0.05)",
              border: "1px solid rgba(255, 255, 255, 0.12)",
              fontSize: "12px",
              color: "#cbd5e1",
            }}
            title="検索時に上位から自動で選択する件数（サーバーに保存され次回起動時も維持されます）"
          >
            <span>デフォルト選択数:</span>
            <input
              type="number"
              min="0"
              max="100"
              className="default-select-count-input"
              style={{
                width: "48px",
                padding: "2px 4px",
                borderRadius: "4px",
                border: "1px solid rgba(255, 255, 255, 0.2)",
                backgroundColor: "#0f172a",
                color: "#f8fafc",
                fontSize: "12px",
                textAlign: "center",
                fontWeight: "bold",
              }}
              value={defaultSelectCount}
              onChange={(e) => void handleDefaultSelectCountChange(e.target.value)}
            />
            <span>件</span>
          </div>
        </div>
      </div>

      <div
        className="table-responsive-container ai-candidate-table-container"
        style={{
          height: "calc(100vh - 210px)",
          minHeight: "480px",
          overflowY: "auto",
          userSelect: isDragging ? "none" : "auto",
          cursor: isDragging ? (dragModeRef.current ? "crosshair" : "not-allowed") : "auto",
          border: "1px solid rgba(255, 255, 255, 0.08)",
          borderRadius: "8px",
        }}
      >
        <table className="ai-export-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
          <thead style={{ position: "sticky", top: 0, backgroundColor: "#1e293b", zIndex: 2 }}>
            <tr style={{ textAlign: "left", color: "#94a3b8", borderBottom: "1px solid rgba(255, 255, 255, 0.1)" }}>
              <th style={{ width: "48px", textAlign: "center", padding: "8px 4px" }}>選択</th>
              <th style={{ width: "55px", padding: "8px" }}>順位</th>
              <th style={{ width: "120px", padding: "8px" }}>一致種別</th>
              <th style={{ padding: "8px", minWidth: "160px" }}>ノートタイトル</th>
              <th style={{ padding: "8px", minWidth: "180px" }}>パス</th>
              <th style={{ padding: "8px" }}>スニペット / 根拠文</th>
            </tr>
          </thead>
          <tbody>
            {candidates.map((item, idx) => {
              const isChecked = selectedPaths.has(item.full_path);
              return (
                <tr
                  key={item.full_path}
                  className={isChecked ? "row-selected" : ""}
                  onMouseEnter={(e) => handleRowMouseEnter(e, item.full_path)}
                  style={{
                    cursor: "pointer",
                    backgroundColor: isChecked ? "rgba(99, 102, 241, 0.15)" : "transparent",
                    borderBottom: "1px solid rgba(255, 255, 255, 0.05)",
                  }}
                >
                  <td
                    style={{
                      textAlign: "center",
                      cursor: "pointer",
                      padding: "8px 4px",
                      userSelect: "none",
                    }}
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      handleCheckboxMouseDown(e, item.full_path);
                    }}
                    title="クリックで切替 / ドラッグで連続切替 / Shift+ドラッグで連続解除"
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => {}}
                      style={{ cursor: "pointer", width: "16px", height: "16px", accentColor: "#6366f1" }}
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        handleCheckboxMouseDown(e, item.full_path);
                      }}
                    />
                  </td>
                  <td
                    style={{ padding: "8px", fontFamily: "monospace", fontWeight: 600, color: "#38bdf8" }}
                    onClick={() => toggleSelect(item.full_path)}
                  >
                    #{idx + 1}
                  </td>
                  <td style={{ padding: "8px" }} onClick={() => toggleSelect(item.full_path)}>
                    {item.match_source === "both" && (
                      <span className="badge badge-both" style={{ fontSize: "11px" }}>🌟 両方一致</span>
                    )}
                    {item.match_source === "vector" && (
                      <span className="badge badge-vector" style={{ fontSize: "11px" }}>🔮 意味一致</span>
                    )}
                    {item.match_source === "keyword" && (
                      <span className="badge badge-keyword" style={{ fontSize: "11px" }}>🏷️ キーワード</span>
                    )}
                    {!item.match_source && (
                      <span className="badge" style={{ fontSize: "11px", color: "#94a3b8" }}>通常一致</span>
                    )}
                  </td>
                  <td style={{ padding: "8px" }}>
                    <button
                      type="button"
                      className="table-title-link"
                      style={{
                        background: "transparent",
                        border: "none",
                        color: "#60a5fa",
                        cursor: "pointer",
                        textAlign: "left",
                        fontWeight: 600,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "4px",
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        openFileViaHub(item.full_path);
                      }}
                      title="8001 Open Hub で開く"
                    >
                      <span>{item.file_name}</span>
                      <span style={{ fontSize: "11px" }}>↗</span>
                    </button>
                  </td>
                  <td
                    style={{ padding: "8px", fontFamily: "monospace", fontSize: "11px", color: "#94a3b8" }}
                    onClick={() => toggleSelect(item.full_path)}
                  >
                    {item.full_path}
                  </td>
                  <td
                    style={{ padding: "8px", fontSize: "11.5px", color: "#cbd5e1", maxWidth: "340px", lineHeight: "1.4" }}
                    onClick={() => toggleSelect(item.full_path)}
                  >
                    {(() => {
                      const formatted = truncateSnippet(item, 200);
                      return formatted.includes("<mark>") ? (
                        <span dangerouslySetInnerHTML={{ __html: formatted }} />
                      ) : (
                        <span>{formatted}</span>
                      );
                    })()}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
