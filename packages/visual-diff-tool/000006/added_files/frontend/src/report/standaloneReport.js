/**
 * Git差分の自己完結HTMLレポートを生成する。
 * 画像はdata URI、CSSと本文倍率変更用の短いスクリプトはインラインで埋め込み、
 * 外部スクリプト・Webフォント・ネットワーク接続を一切必要としない（CSPでも外部読み込みを禁止）。
 */
import { changeTypeLabel } from "../git/gitLabels.js";
import { toDataUri } from "../lib/files.js";
import { escapeHtml } from "../lib/util.js";
import { renderImageWithNotesDataUri, renderMemoCropDataUris } from "../memo/memoCanvas.js";
import {
  memoAnnotationTypeLabel,
  memoChangeTypeLabel,
  memoColor,
  normalizeMemoNotes,
  normalizeStickyNotes,
} from "../memo/memoModel.js";
import { effectiveMemoStageSize, normalizeReportView } from "./reportGeometry.js";

export function gitReportFilename(infoOrRepo) {
  if (infoOrRepo && typeof infoOrRepo === "object" && infoOrRepo.source_markdown) {
    const markdownName = String(infoOrRepo.source_markdown).split(/[\\/]/).filter(Boolean).pop() || "note.md";
    const baseName = markdownName.replace(/\.md$/i, "") || "note";
    return `${baseName}_変更差分レポート.html`;
  }
  const repo = typeof infoOrRepo === "object" ? infoOrRepo?.repo_root : infoOrRepo;
  const name = String(repo || "repository").split(/[\\/]/).filter(Boolean).pop() || "repository";
  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `${name}-diff-${stamp}.html`;
}

export async function buildStandaloneGitReport(info, entries) {
  const sections = [];
  for (const entry of entries) {
    sections.push(entry.file.kind === "text" ? buildTextReportSection(entry) : await buildImageReportSection(entry));
  }
  const generated = new Intl.DateTimeFormat("ja-JP", { dateStyle: "long", timeStyle: "medium" }).format(new Date());
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>差分レポート - ${escapeHtml(info.repo_root)}</title><style>${standaloneReportCss()}</style></head>
<body><header><h1>差分レポート</h1><dl><div><dt>リポジトリ</dt><dd>${escapeHtml(info.repo_root)}</dd></div><div><dt>出力日時</dt><dd>${escapeHtml(generated)}</dd></div><div><dt>変更ファイル</dt><dd>${new Set(entries.map((entry) => entry.file.path)).size}件</dd></div></dl></header>
<main id="report-content">${sections.join("\n")}</main><footer>Visual Diff Tool — このHTMLは画像・CSSを内包した自己完結ファイルです。</footer>
<script>${standaloneReportScript()}</script></body></html>`;
}

export function buildTextReportSection({ file, data, memo }) {
  const rows = (data.rows ?? []).map((row) => `<div class="code-cell ${oldCellClass(row)}"${reportGapStyle(row, "old")}><span>${row.old_number ?? ""}</span><code>${reportLineHtml(row, "old")}</code></div><div class="code-cell ${newCellClass(row)}"${reportGapStyle(row, "new")}><span>${row.new_number ?? ""}</span><code>${reportLineHtml(row, "new")}</code></div>`).join("");
  return `<section><h2>${escapeHtml(file.path)} <b class="badge ${escapeHtml(file.change_type)}">${escapeHtml(changeTypeLabel(file.change_type))}</b></h2>${memo.trim() ? `<aside><strong>メモ</strong><p>${escapeHtml(memo).replaceAll("\n", "<br>")}</p></aside>` : ""}<div class="diff-grid"><h3>変更前: ${escapeHtml(file.head_path)}</h3><h3>変更後: ${escapeHtml(file.path)}</h3>${rows || '<p class="empty-report">差分行はありません。</p>'}</div></section>`;
}

async function buildImageReportSection({ file, data, imageMemo, reportOptions }) {
  const head = data.image_a ?? data.image_head ?? null;
  const current = data.image_b_aligned ?? data.image_current ?? null;
  const notes = normalizeMemoNotes(imageMemo?.notes);
  const stickies = normalizeStickyNotes(imageMemo?.stickies);
  const renderStageSize = effectiveMemoStageSize(imageMemo);
  const annotateHead = !current && Boolean(head);
  const hasAnnotations = notes.length || stickies.length;
  const headSrc = head ? (annotateHead && hasAnnotations ? await renderImageWithNotesDataUri(toDataUri(head), notes, renderStageSize, stickies) : toDataUri(head)) : null;
  const currentSrc = current ? (hasAnnotations ? await renderImageWithNotesDataUri(toDataUri(current), notes, renderStageSize, stickies) : toDataUri(current)) : null;
  const memoImageSrc = current ? toDataUri(current) : head ? toDataUri(head) : null;
  const memoCrops = memoImageSrc
    ? await renderMemoCropDataUris(memoImageSrc, notes, renderStageSize, stickies, reportOptions)
    : notes.map(() => null);
  const panels = [
    ["変更前", headSrc],
    ["変更後", currentSrc],
    ["差分オーバーレイ", data.overlay ? toDataUri(data.overlay) : null],
  ].filter(([, src]) => src).map(([label, src]) => `<figure><figcaption>${label}</figcaption><img src="${src}" alt="${label}"></figure>`).join("");
  const memoList = notes.length ? `<aside class="report-memos"><strong>画像メモ</strong><div class="memo-card-grid">${notes.map((note, index) => {
    const view = normalizeReportView(reportOptions?.views?.[note.id], note, renderStageSize);
    return `<article class="memo-card" style="border-color:${memoColor(note).hex};max-width:${view.cardWidth}px">${memoCrops[index] ? `<div class="memo-card-media" style="height:${view.cardHeight}px"><img src="${memoCrops[index]}" alt="${escapeHtml(memoAnnotationTypeLabel(note.annotations[0]?.type))}周辺の拡大画像"></div>` : ""}<div><b class="memo-type">${escapeHtml(memoChangeTypeLabel(note.changeType))}</b><p><i class="memo-color-dot" style="background:${memoColor(note).hex}"></i>${escapeHtml(note.text).replaceAll("\n", "<br>")}</p></div></article>`;
  }).join("")}</div></aside>` : "";
  const stickyList = stickies.length ? `<aside class="report-stickies"><strong>付箋</strong><ul>${stickies.map((sticky) => `<li>${escapeHtml(sticky.text).replaceAll("\n", "<br>")}</li>`).join("")}</ul></aside>` : "";
  return `<section><h2>${escapeHtml(file.display_path ?? file.path)} <b class="badge ${escapeHtml(file.change_type)}">${escapeHtml(changeTypeLabel(file.change_type))}</b></h2>${memoList}${stickyList}<div class="image-grid">${panels || '<p class="empty-report">表示できる画像がありません。</p>'}</div></section>`;
}

function oldCellClass(row) {
  return row.kind === "delete" || row.kind === "replace" ? "removed" : row.kind === "insert" ? "added-gap" : "";
}

function newCellClass(row) {
  return row.kind === "insert" || row.kind === "replace" ? "added" : row.kind === "delete" ? "removed-gap" : "";
}

function reportGapStyle(row, side) {
  if (side === "old" && row.kind === "insert") {
    return ' style="background:repeating-linear-gradient(135deg,#fff 0,#fff 6px,#dcfce7 6px,#dcfce7 12px)"';
  }
  if (side === "new" && row.kind === "delete") {
    return ' style="background:repeating-linear-gradient(135deg,#fff 0,#fff 6px,#fee2e2 6px,#fee2e2 12px)"';
  }
  return "";
}

export function reportLineHtml(row, side) {
  const segments = side === "old" ? row.old_segments : row.new_segments;
  if (segments) return segments.map((segment) => segment.changed ? `<mark>${escapeHtml(segment.text)}</mark>` : escapeHtml(segment.text)).join("");
  const text = side === "old" ? row.old ?? "" : row.new ?? "";
  return row.kind === "insert" || row.kind === "delete" ? `<mark>${escapeHtml(text)}</mark>` : escapeHtml(text);
}

function standaloneReportCss() {
  return `:root{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#172033;background:#f1f5f9}*{box-sizing:border-box}body{margin:0;overflow-x:auto}header,footer{padding:14px 1.5vw;background:#172033;color:#fff}header h1{margin:0 0 10px}dl{margin:0;display:flex;gap:18px;flex-wrap:wrap}dl div{display:flex;gap:6px}dt{color:#a8b3c7}dd{margin:0}#report-content{width:100%;margin:12px 0;transform-origin:top left}section{margin:0 0 16px;background:#fff;border:1px solid #cbd5e1;border-radius:6px;overflow:hidden;page-break-inside:avoid}h2{margin:0;padding:10px 12px;background:#e2e8f0;font-size:16px}.badge{margin-left:8px;padding:3px 8px;border-radius:99px;background:#64748b;color:#fff;font-size:11px}.badge.added,.badge.untracked{background:#16803b}.badge.deleted{background:#b42318}aside{margin:8px 12px;padding:9px 11px;border-left:4px solid #eab308;background:#fefce8}aside p,aside ol,aside ul{margin:5px 0 0}.memo-card-grid{margin-top:8px;display:grid;grid-template-columns:1fr;gap:10px}.memo-card{width:100%;min-width:0;display:grid;grid-template-columns:minmax(180px,44%) 1fr;align-items:start;gap:14px;border:2px solid #64748b;border-radius:8px;padding:10px;background:#fff}.memo-card-media{display:grid;place-items:center;overflow:hidden;background:#fff;border:1px solid #cbd5e1}.memo-card img{display:block;width:100%;height:100%;object-fit:contain}.memo-card p{margin:6px 0 0;overflow-wrap:anywhere;font-size:clamp(15px,2vw,28px);line-height:1.45}.memo-type{display:inline-block;padding:2px 7px;border-radius:99px;background:#e2e8f0;font-size:11px}.memo-color-dot{display:inline-block;width:10px;height:10px;margin-right:6px;border-radius:99px}.diff-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);overflow:auto}.diff-grid h3{position:sticky;top:0;margin:0;padding:8px 10px;background:#172033;color:#fff;font-size:12px}.code-cell{min-width:0;display:grid;grid-template-columns:46px 1fr;border-bottom:1px solid #e2e8f0;background:#fff}.code-cell>span{padding:2px 6px;background:#f8fafc;border-right:1px solid #e2e8f0;text-align:right;color:#64748b;user-select:none}.code-cell code{padding:2px 6px;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace}.code-cell.removed{background:#ffebe9}.code-cell.added{background:#dafbe1}.code-cell mark{padding:0;background:#f7a8a8}.code-cell.added mark{background:#83d997}.image-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;padding:8px;background:#e2e8f0}.image-grid figure{min-width:0;margin:0;background:#fff;border:1px solid #94a3b8}.image-grid figcaption{padding:6px 8px;background:#172033;color:#fff;font-weight:700;font-size:12px}.image-grid img{display:block;width:100%;height:auto}.empty-report{padding:18px}.report-zoom-indicator{position:fixed;right:10px;bottom:10px;padding:5px 8px;border-radius:4px;background:#172033e6;color:#fff;font:12px ui-sans-serif,system-ui,sans-serif;z-index:10}footer{text-align:center;color:#cbd5e1;font-size:12px}@media(max-width:900px){.image-grid{grid-template-columns:1fr}.memo-card{grid-template-columns:1fr;max-width:100%!important}}@media print{header{background:#fff;color:#000;border-bottom:2px solid #000}#report-content{width:100%;margin:8px 0}.diff-grid{font-size:9px}.image-grid{grid-template-columns:1fr 1fr}footer{display:none}}`;
}

function standaloneReportScript() {
  return `(function(){const root=document.getElementById("report-content");if(!root)return;let scale=1;const min=.5,max=3,step=.1;const label=document.createElement("div");label.className="report-zoom-indicator";label.textContent="表示倍率 100%（Ctrl+ホイール）";document.body.appendChild(label);const update=()=>{root.style.zoom=String(scale);label.textContent="表示倍率 "+Math.round(scale*100)+"%（Ctrl+ホイール）"};window.addEventListener("wheel",function(event){if(!event.ctrlKey)return;event.preventDefault();scale=Math.max(min,Math.min(max,scale+(event.deltaY<0?step:-step)));update()},{passive:false});update()})();`;
}
