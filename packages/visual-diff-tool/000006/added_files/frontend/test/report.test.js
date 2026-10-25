/**
 * HTML出力（report/standaloneReport.js）と表示範囲計算（report/reportGeometry.js）の単体テスト。
 * - 自己完結HTMLに埋め込む文字列は必ずエスケープする
 * - 出力領域（crop）と表示範囲は画像に対する % で計算する
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  effectiveMemoStageSize,
  normalizeReportCrop,
  normalizeReportView,
  reportViewportGeometry,
  reportVisibleCrop,
} from "../src/report/reportGeometry.js";
import { buildTextReportSection, gitReportFilename, reportLineHtml } from "../src/report/standaloneReport.js";
import { escapeHtml } from "../src/lib/util.js";

test("escapeHtml: HTMLの特殊文字をすべてエスケープする", () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  assert.equal(escapeHtml(null), "");
});

test("reportLineHtml: 変更箇所だけ mark で囲み、内容はエスケープする", () => {
  const row = { kind: "replace", old_segments: [{ text: "a<b", changed: false }, { text: "c", changed: true }] };
  assert.equal(reportLineHtml(row, "old"), "a&lt;b<mark>c</mark>");
  assert.equal(reportLineHtml({ kind: "insert", new: "<x>" }, "new"), "<mark>&lt;x&gt;</mark>");
  assert.equal(reportLineHtml({ kind: "equal", old: "same" }, "old"), "same");
});

test("buildTextReportSection: パスとメモをエスケープし、行を左右セルとして出力する", () => {
  const html = buildTextReportSection({
    file: { path: "<evil>.md", head_path: "old.md", change_type: "modified" },
    data: { rows: [{ kind: "replace", old_number: 1, new_number: 1, old: "a", new: "b" }] },
    memo: "line1\n<script>",
  });
  assert.ok(html.includes("&lt;evil&gt;.md"));
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("line1<br>&lt;script&gt;"));
  assert.equal((html.match(/class="code-cell/g) ?? []).length, 2);
});

test("gitReportFilename: Markdown起点はノート名、通常はリポジトリ名と日付", () => {
  assert.equal(gitReportFilename({ source_markdown: "C:\\vault\\設計メモ.md" }), "設計メモ_変更差分レポート.html");
  assert.match(gitReportFilename({ repo_root: "/work/my-repo" }), /^my-repo-diff-\d{8}\.html$/);
});

test("normalizeReportCrop: 範囲外を補正し、不正な値は null", () => {
  assert.equal(normalizeReportCrop(null), null);
  assert.deepEqual(normalizeReportCrop({ x: 99, y: -5, width: 50, height: 1 }), { x: 98, y: 0, width: 2, height: 2 });
});

test("reportViewportGeometry / reportVisibleCrop: 倍率100%では画像全体が表示範囲になる", () => {
  const view = normalizeReportView({ centerX: 50, centerY: 50, zoom: 100, cardWidth: 500, cardHeight: 250 });
  const imageSize = { width: 1000, height: 500 };
  const viewport = { width: 500, height: 250 };
  const geometry = reportViewportGeometry(imageSize, viewport, view);
  assert.deepEqual({ width: geometry.width, height: geometry.height, left: geometry.left, top: geometry.top }, {
    width: 500, height: 250, left: 0, top: 0,
  });
  assert.deepEqual(reportVisibleCrop(imageSize, viewport, view), { x: 0, y: 0, width: 100, height: 100 });
});

test("reportVisibleCrop: 倍率200%・中心を左上寄りにすると左上1/4付近を切り出す", () => {
  const view = normalizeReportView({ centerX: 25, centerY: 25, zoom: 200, cardWidth: 500, cardHeight: 250 });
  assert.deepEqual(reportVisibleCrop({ width: 1000, height: 500 }, { width: 500, height: 250 }, view), {
    x: 0, y: 0, width: 50, height: 50,
  });
});

test("effectiveMemoStageSize: 新形式は画像倍率を掛け、旧形式は妥当な寸法だけ使う", () => {
  assert.deepEqual(
    effectiveMemoStageSize({ stageSize: { width: 800, height: 600 }, memoGeometryVersion: 2, memoImageScale: 50 }),
    { width: 400, height: 300 },
  );
  assert.deepEqual(effectiveMemoStageSize({ stageSize: { width: 900, height: 600 } }), { width: 900, height: 600 });
  assert.equal(effectiveMemoStageSize({ stageSize: { width: 3000, height: 600 } }), null);
  assert.equal(effectiveMemoStageSize(null), null);
});
