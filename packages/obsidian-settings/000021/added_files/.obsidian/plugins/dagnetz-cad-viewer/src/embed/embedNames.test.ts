/**
 * 仕様: 3D 埋め込みの名前（自動採番と名前の変更）のテスト
 *
 * 1. listCadBlocks: ```step / ```cad ブロックとその名前を読む。4つ以上のバッククォートで囲んだ見本の中、
 *    他の言語のブロックは対象外。リスト・コールアウトの中のブロックも読む
 * 2. nextCadEmbedName: 使用中の最大の番号の次（3D-1, 3D-2 …）。手で付けた名前は番号に影響しない
 * 3. cadEmbedNameEdits: 名前の無い埋め込みと、重なった名前の2つ目以降に名前を付ける。
 *    名前の行は path の次に入れ、字下げ・「>」・CRLF を保つ。直す必要が無ければ何もしない
 * 4. renameCadEmbedEdit: 名前で探して name の行の値だけを変える。空・改行・他の埋め込みと同じ名前は不可
 * 5. 名前はコードブロックの設定として読み書きされ、ビューアからの保存（固定・リサイズ・注記）でも消えない
 * 6. isRenameShortcut: 修飾キー無しの R だけ（IME の変換中は除く）
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  applyTextEdits,
  cadEmbedNameEdits,
  isRenameShortcut,
  listCadBlocks,
  listCadEmbedNames,
  nextCadEmbedName,
  renameCadEmbedEdit,
  validateCadEmbedName,
} from "./embedNames";
import {
  carryOverEmbedSettings,
  parseStepCodeBlock,
  serializeStepCodeBlock,
  updateStepBlockInMarkdown,
} from "./StepCodeBlockUtils";
import { buildCadCodeBlock } from "../dropHandler";

const assignNames = (md: string): string => applyTextEdits(md, cadEmbedNameEdits(md));

test("ノート内の step / cad ブロックの名前を順に読む", () => {
  const md = [
    "```step",
    "path: a.step",
    "name: 本体",
    "```",
    "```js",
    "name: x",
    "```",
    "```cad",
    "path: b.stl",
    "```",
  ].join("\n");
  const blocks = listCadBlocks(md);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].name, "本体");
  assert.equal(blocks[0].lineStart, 0);
  assert.equal(blocks[0].lineEnd, 3);
  assert.equal(blocks[1].name, undefined);
  assert.deepEqual(listCadEmbedNames(md), ["本体"]);
});

test("4つのバッククォートで囲んだ見本の中の ```step は対象外", () => {
  const md = "````markdown\n```step\npath: sample.step\n```\n````\n";
  assert.equal(listCadBlocks(md).length, 0);
  assert.deepEqual(cadEmbedNameEdits(md), []);
});

test("注記の中の name: はブロックの名前として扱わない", () => {
  const md = "```step\npath: a.step\nannotations:\n  - id: a1\n    name: 注記\n```\n";
  assert.equal(listCadBlocks(md)[0].name, undefined);
  assert.equal(listCadBlocks(md)[0].nameLine, undefined);
});

test("数字だけの名前も文字列として読む", () => {
  assert.equal(listCadBlocks("```step\npath: a.step\nname: 12\n```")[0].name, "12");
  assert.equal(parseStepCodeBlock("path: a.step\nname: 12").name, "12");
});

test("次の名前は使用中の最大の番号の次", () => {
  assert.equal(nextCadEmbedName([]), "3D-1");
  assert.equal(nextCadEmbedName(["3D-1", "3D-2"]), "3D-3");
  assert.equal(nextCadEmbedName(["3D-5"]), "3D-6");
  assert.equal(nextCadEmbedName(["本体", "3D-x"]), "3D-1");
});

test("名前の無い埋め込みに、path の次の行へ 3D-1, 3D-2 … を付ける", () => {
  const md = "# 図\n\n```step\npath: a.step\nheight: 400\n```\n\n本文\n\n```cad\npath: b.stl\n```\n";
  const out = assignNames(md);
  assert.equal(
    out,
    "# 図\n\n```step\npath: a.step\nname: 3D-1\nheight: 400\n```\n\n本文\n\n```cad\npath: b.stl\nname: 3D-2\n```\n",
  );
  // 付け終わったら何もしない
  assert.deepEqual(cadEmbedNameEdits(out), []);
});

test("付いている名前は残し、番号はその続きから付ける", () => {
  const md = "```step\npath: a.step\n```\n```step\npath: b.step\nname: 3D-4\n```\n";
  assert.deepEqual(listCadEmbedNames(assignNames(md)), ["3D-5", "3D-4"]);
});

test("同じ名前の2つ目以降（コピーした埋め込み）は新しい番号へ付け直す", () => {
  const md = "```step\npath: a.step\nname: 3D-1\n```\n```step\npath: a.step\nname: 3D-1\n```\n";
  const out = assignNames(md);
  assert.deepEqual(listCadEmbedNames(out), ["3D-1", "3D-2"]);
  assert.ok(!out.includes("name: 3D-1\nname"));
});

test("リスト・コールアウトの中の埋め込みは字下げと「>」を保って名前を足す", () => {
  const md = "- 項目\n  ```step\n  path: a.step\n  ```\n\n> [!note]\n> ```cad\n> path: b.stl\n> ```\n";
  const out = assignNames(md);
  assert.ok(out.includes("  path: a.step\n  name: 3D-1\n  ```"));
  assert.ok(out.includes("> path: b.stl\n> name: 3D-2\n> ```"));
  assert.equal(parseStepCodeBlock("path: a.step\nname: 3D-1").name, "3D-1");
});

test("CRLF のノートでも行の区切りを保つ", () => {
  const md = "```step\r\npath: a.step\r\nheight: 400\r\n```\r\n";
  assert.equal(assignNames(md), "```step\r\npath: a.step\r\nname: 3D-1\r\nheight: 400\r\n```\r\n");
});

test("1行目にパスだけを書いた形式でも名前を足し、パスと名前を読める", () => {
  const out = assignNames("```step\nmodels/a.step\n```\n");
  assert.equal(out, "```step\nmodels/a.step\nname: 3D-1\n```\n");
  const config = parseStepCodeBlock("models/a.step\nname: 3D-1");
  assert.equal(config.path, "models/a.step");
  assert.equal(config.name, "3D-1");
});

test("名前の変更は name の行の値だけを変える", () => {
  const md = "```step\npath: a.step\nname: 3D-1\nheight: 400\n```\n```step\npath: b.step\nname: 3D-2\n```\n";
  const result = renameCadEmbedEdit(md, { name: "3D-2" }, "  ブラケット  ");
  assert.ok("edit" in result);
  const out = applyTextEdits(md, [result.edit]);
  assert.deepEqual(listCadEmbedNames(out), ["3D-1", "ブラケット"]);
  assert.equal(out.replace("ブラケット", "3D-2"), md);
});

test("名前の無い埋め込みは行番号で探して名前を足す", () => {
  const md = "本文\n```step\npath: a.step\n```\n";
  const result = renameCadEmbedEdit(md, { lineStart: 1 }, "本体");
  assert.ok("edit" in result);
  assert.equal(applyTextEdits(md, [result.edit]), "本文\n```step\npath: a.step\nname: 本体\n```\n");
});

test("同じノートの他の埋め込みと同じ名前・空・改行は付けられない", () => {
  const md = "```step\npath: a.step\nname: 3D-1\n```\n```step\npath: b.step\nname: 3D-2\n```\n";
  assert.ok("error" in renameCadEmbedEdit(md, { name: "3D-2" }, "3D-1"));
  assert.ok("error" in renameCadEmbedEdit(md, { name: "3D-2" }, "  "));
  assert.ok("error" in renameCadEmbedEdit(md, { name: "3D-9" }, "x"));
  assert.match(validateCadEmbedName("a\nb", []) ?? "", /改行/);
  // 自分の今の名前のままは可
  assert.ok("edit" in renameCadEmbedEdit(md, { name: "3D-2" }, "3D-2"));
});

test("YAML で特別な意味を持つ名前は引用符で囲んで書き、そのまま読み戻せる", () => {
  for (const name of ["123", "a: b", "#1", "true"]) {
    const md = "```step\npath: a.step\nname: 3D-1\n```\n";
    const result = renameCadEmbedEdit(md, { name: "3D-1" }, name);
    assert.ok("edit" in result);
    const out = applyTextEdits(md, [result.edit]);
    assert.deepEqual(listCadEmbedNames(out), [name], name);
  }
});

test("名前はコードブロックの設定として書き出し、ビューアからの保存でも消えない", () => {
  const current = parseStepCodeBlock("path: a.step\nname: 本体\nheight: 500");
  assert.equal(current.name, "本体");
  // ビューア（固定ボタン・注記の自動保存）が作る設定には name が無い
  const merged = carryOverEmbedSettings(current, { path: "a.step", view: "custom", locked: true });
  assert.equal(merged.name, "本体");
  const yaml = serializeStepCodeBlock(merged);
  assert.match(yaml, /^path: a\.step\nname: 本体\n/);
  const note = updateStepBlockInMarkdown("```step\npath: a.step\nname: 本体\nheight: 500\n```", "a.step", merged);
  assert.deepEqual(listCadEmbedNames(note), ["本体"]);
});

test("ドロップで入れるコードブロックに名前を書ける", () => {
  assert.equal(
    buildCadCodeBlock("a.step", 800, "iso", false, "3D-3"),
    "```step\npath: a.step\nname: 3D-3\nheight: 800\nview: iso\n```\n",
  );
  assert.ok(!buildCadCodeBlock("a.step").includes("name:"));
});

test("名前の変更のショートカットは修飾キー無しの R だけ", () => {
  assert.equal(isRenameShortcut({ key: "r" }), true);
  assert.equal(isRenameShortcut({ key: "R" }), true);
  assert.equal(isRenameShortcut({ key: "r", metaKey: true }), false);
  assert.equal(isRenameShortcut({ key: "r", ctrlKey: true }), false);
  assert.equal(isRenameShortcut({ key: "R", shiftKey: true }), false);
  assert.equal(isRenameShortcut({ key: "r", isComposing: true }), false);
  assert.equal(isRenameShortcut({ key: "e" }), false);
  assert.equal(isRenameShortcut({}), false);
});
