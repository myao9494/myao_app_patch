/**
 * AI用HTMLの文字数・容量の表示と、分割パートの切り替え。
 * - 分割前の文字数を「合計 12.35万文字（123,456 / 上限200,000）」で表示する（埋め込み画像の base64 は数えない）。
 *   表示中のファイルの容量も「2.10MB / 上限4.50MB」で表示する。上限を超えたものは警告色にする。
 * - 社内AIの上限に合わせて複数ファイルに分割されたときは、分割数とパートごとのタブ（文字数・容量つき）を表示し、
 *   タブで表示中のパートを切り替える。1 ファイルならタブは出さない。
 * - サーバーが上限に収めきれなかったときは、その内容を表示する。
 */
import type { GeneratedHtml } from "../../hooks/useAiDocumentBuilder";
import { formatMan, formatMegabytes } from "../../outputSize";

type AiOutputSummaryProps = {
  data: GeneratedHtml;
  activePartIndex: number;
  onSelectPart: (index: number) => void;
};

export function AiOutputSummary({ data, activePartIndex, onSelectPart }: AiOutputSummaryProps) {
  const parts = data.html_parts;
  const split = parts.length > 1;
  const active = parts[activePartIndex] ?? parts[0];
  const overChars = data.total_chars > data.char_limit && !split;
  const overBytes = active.bytes > data.size_limit_bytes;
  const warnColor = "#fbbf24";

  return (
    <div className="ai-output-summary" style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "12px", color: "#cbd5e1", flexShrink: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "baseline" }}>
        <span style={{ color: overChars ? warnColor : "#e2e8f0" }} title="埋め込み画像のデータは数えない文字数">
          <strong>合計 {formatMan(data.total_chars)}</strong>
          {" "}（{data.total_chars.toLocaleString()} / 上限{data.char_limit.toLocaleString()}）
        </span>
        <span style={{ color: overBytes ? warnColor : "#94a3b8" }}>
          {split ? `表示中のファイル: ` : "容量: "}
          {formatMegabytes(active.bytes)} / 上限{formatMegabytes(data.size_limit_bytes)}
        </span>
        {split && (
          <em style={{ color: warnColor, fontStyle: "normal" }}>
            上限を超えるため全{parts.length}ファイルに分割して出力します
          </em>
        )}
      </div>
      {split && (
        <div className="ai-output-part-tabs" style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
          {parts.map((part, index) => (
            <button
              key={part.index}
              type="button"
              className={`btn btn-sm ${index === activePartIndex ? "btn-primary" : "btn-secondary"}`}
              style={{ fontSize: "11.5px", padding: "2px 10px" }}
              onClick={() => onSelectPart(index)}
            >
              パート{part.index}/{part.total} ({formatMan(part.chars)}・{formatMegabytes(part.bytes)})
            </button>
          ))}
        </div>
      )}
      {data.limit_problems.length > 0 && (
        <div style={{ color: warnColor }}>⚠️ 上限に収めきれませんでした: {data.limit_problems.join(" / ")}</div>
      )}
    </div>
  );
}
