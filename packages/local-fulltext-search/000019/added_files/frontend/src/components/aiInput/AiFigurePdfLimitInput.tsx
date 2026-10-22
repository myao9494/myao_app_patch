/**
 * 「2 ファイルを保存」で出力する図面 PDF の最大サイズ（MB）の入力欄。
 * 図は PDF（1 ページ 1 図、画質を落とさない）で保存し、この大きさを超えると図の境目で複数の PDF に分ける。
 * 値はサーバーに保存され、次回も使う（既定 10MB）。0 以下など無効な値のときは、直前の有効な値を使い続ける。
 */
import type { UseAiExportFolderResult } from "../../hooks/useAiExportFolder";

export function AiFigurePdfLimitInput({ exportFolderSettings }: { exportFolderSettings: UseAiExportFolderResult }) {
  const { figurePdfMaxMbText, handleFigurePdfMaxMbChange } = exportFolderSettings;
  return (
    <label
      style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "12px", color: "#cbd5e1" }}
      title="図面PDFがこの大きさを超えると、図の境目で複数のPDFに分割します（サーバーに保存され、次回も使います）"
    >
      <span>図面PDF上限:</span>
      <input
        type="number"
        min="0.5"
        step="0.5"
        className="figure-pdf-max-mb-input"
        style={{
          width: "56px",
          padding: "2px 4px",
          borderRadius: "4px",
          border: "1px solid rgba(255, 255, 255, 0.2)",
          backgroundColor: "#0f172a",
          color: "#f8fafc",
          fontSize: "12px",
          textAlign: "center",
        }}
        value={figurePdfMaxMbText}
        onChange={(e) => void handleFigurePdfMaxMbChange(e.target.value)}
      />
      <span>MB</span>
    </label>
  );
}
