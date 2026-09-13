/**
 * AIインプット候補ドキュメント判定のユニットテスト
 * 仕様:
 * - .excalidraw.md, .excalidraw, .dio.svg, .drawio.svg, 画像拡張子 (png/jpg/svg/webp等) は図面・画像アセットとして文書候補から除外 (false)
 * - .md, .txt, .pdf, .docx, .xlsx 等の通常文書ファイルは候補として許可 (true)
 */
import assert from "node:assert/strict";
import test from "node:test";
import { isAiInputDocumentCandidate } from "./aiInputCandidate.ts";

test("AIインプットのドキュメント候補から画像・図面アセットを除外する", () => {
  // 除外対象 (画像・図面アセット)
  assert.equal(isAiInputDocumentCandidate({ file_name: "明和高校.excalidraw.md", file_ext: ".excalidraw.md" }), false);
  assert.equal(isAiInputDocumentCandidate({ file_name: "システム図.excalidraw", file_ext: ".excalidraw" }), false);
  assert.equal(isAiInputDocumentCandidate({ file_name: "構成図.dio.svg", file_ext: ".dio.svg" }), false);
  assert.equal(isAiInputDocumentCandidate({ file_name: "flow.drawio.svg", file_ext: ".drawio.svg" }), false);
  assert.equal(isAiInputDocumentCandidate({ file_name: "screen.png", file_ext: ".png" }), false);
  assert.equal(isAiInputDocumentCandidate({ file_name: "photo.jpg", file_ext: ".jpg" }), false);

  // 許可対象 (文書ファイル)
  assert.equal(isAiInputDocumentCandidate({ file_name: "高校レポート.md", file_ext: ".md" }), true);
  assert.equal(isAiInputDocumentCandidate({ file_name: "仕様書.txt", file_ext: ".txt" }), true);
  assert.equal(isAiInputDocumentCandidate({ file_name: "マニュアル.pdf", file_ext: ".pdf" }), true);
  assert.equal(isAiInputDocumentCandidate({ file_name: "設計書.docx", file_ext: ".docx" }), true);
});
