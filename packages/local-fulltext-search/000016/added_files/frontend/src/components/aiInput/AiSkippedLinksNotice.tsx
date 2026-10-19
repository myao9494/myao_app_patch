/**
 * AI用HTMLの生成で処理できなかったリンクの一覧。
 * サーバーは、見つからない・制限時間（10 秒）を超えた・エラーになった項目を飛ばして出力を優先する。
 * 飛ばした項目を、時間切れ → エラー → 見つからない の順に、種類・対象・リンク元・詳細とともに表示し、
 * どこで詰まったかを利用者が把握できるようにする。項目が無ければ何も表示しない。
 */
import type { SkippedLink } from "../../types";

const REASON_LABELS: Record<string, string> = {
  timeout: "⏱️ 時間切れ",
  error: "⚠️ エラー",
  not_found: "❓ 見つからない",
};

const REASON_ORDER: Record<string, number> = { timeout: 0, error: 1, not_found: 2 };

const KIND_LABELS: Record<string, string> = {
  note: "ノート",
  linked_note: "リンク先ノート",
  image: "画像",
  figure: "図面",
  email: "メール",
  render: "本文の変換",
  folder_scan: "フォルダ走査",
};

/** 時間切れ → エラー → 見つからない の順に並べる（同じ理由の中は元の順序） */
export function sortSkippedLinks(items: SkippedLink[]): SkippedLink[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (REASON_ORDER[a.item.reason] ?? 9) - (REASON_ORDER[b.item.reason] ?? 9) || a.index - b.index)
    .map(({ item }) => item);
}

export function AiSkippedLinksNotice({ skippedLinks }: { skippedLinks: SkippedLink[] }) {
  if (skippedLinks.length === 0) {
    return null;
  }
  return (
    <details
      className="ai-skipped-links"
      open
      style={{
        margin: "8px 0",
        padding: "8px 12px",
        borderRadius: "8px",
        border: "1px solid rgba(251, 191, 36, 0.4)",
        backgroundColor: "rgba(251, 191, 36, 0.08)",
        fontSize: "12px",
        color: "#fde68a",
        flexShrink: 0,
      }}
    >
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>
        ⚠️ 処理できなかったリンク ({skippedLinks.length} 件) — 飛ばして生成しました
      </summary>
      <ul style={{ margin: "6px 0 0", paddingLeft: "18px", maxHeight: "160px", overflowY: "auto", color: "#e2e8f0" }}>
        {sortSkippedLinks(skippedLinks).map((item, index) => (
          <li key={`${item.kind}-${item.target}-${item.source}-${item.reason}-${index}`} style={{ marginBottom: "3px", wordBreak: "break-all" }}>
            <strong>{REASON_LABELS[item.reason] ?? item.reason}</strong>
            {" "}
            <span style={{ color: "#94a3b8" }}>[{KIND_LABELS[item.kind] ?? item.kind}]</span>
            {" "}
            <span style={{ fontFamily: "monospace" }}>{item.target}</span>
            {item.source && <span style={{ color: "#94a3b8" }}> (リンク元: {item.source})</span>}
            {item.detail && <span style={{ color: "#94a3b8" }}> — {item.detail}</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}
