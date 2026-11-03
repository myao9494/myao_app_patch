/**
 * 3D 埋め込み（```step / ```cad コードブロック）の名前
 *
 * 1. 外部アプリが埋め込みを見分けられるよう、コードブロックの YAML に `name:` を持たせる
 * 2. 名前の無い埋め込みと、同じノートの中で名前が重なった埋め込みに、`3D-1`, `3D-2` … を自動で付ける
 *    （ノートの先頭から見て、先に出てきた埋め込みが名前を保つ。番号は使用中の最大の番号の次）
 * 3. 名前の変更（空、改行、同じノートの他の埋め込みと同じ名前は不可）
 * 4. 書き換えは「どの位置をどう変えるか」（TextEdit）で返し、変えた行以外のブロックを再描画させない
 *
 * ブロックの判定は Obsidian と同じく、行頭の字下げと「>」の後ろのフェンス（``` / ~~~）で行う。
 * 4つ以上のバッククォートで囲んだ見本の中の ```step は、埋め込みとして扱わない。
 **/

import * as yaml from "js-yaml";

export const CAD_EMBED_NAME_PREFIX = "3D-";

export interface TextEdit {
  from: number;
  to: number;
  text: string;
}

export interface CadBlockInfo {
  /** フェンス行の行番号（0始まり） */
  lineStart: number;
  /** 閉じるフェンス行の行番号 */
  lineEnd: number;
  /** 行頭の字下げと「>」 */
  prefix: string;
  /** 名前（無ければ undefined） */
  name?: string;
  /** トップレベルの `name:` 行の行番号 */
  nameLine?: number;
  /** トップレベルの `path:` 行、または1行目にパスだけを書いた行の行番号 */
  pathLine?: number;
}

const FENCE = /^([ \t>]*)(`{3,}|~{3,})(.*)$/;

/** ノート内の ```step / ```cad ブロックを、先頭から順に返す。 */
export function listCadBlocks(markdown: string): CadBlockInfo[] {
  const lines = markdown.split("\n");
  const blocks: CadBlockInfo[] = [];
  let open: { marker: string; isCad: boolean; start: number; prefix: string } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    const fence = FENCE.exec(line);
    if (!open) {
      if (!fence) continue;
      const info = fence[3].trim();
      // ``` の情報文字列にバッククォートは書けない（インラインコード）
      if (fence[2][0] === "`" && info.includes("`")) continue;
      const lang = info.split(/\s+/)[0].toLowerCase();
      open = { marker: fence[2], isCad: lang === "step" || lang === "cad", start: i, prefix: fence[1] };
      continue;
    }
    const closes =
      fence && !fence[3].trim() && fence[2][0] === open.marker[0] && fence[2].length >= open.marker.length;
    if (!closes) continue;
    if (open.isCad) blocks.push(readBlock(lines, open.start, i, open.prefix));
    open = null;
  }
  return blocks;
}

function readBlock(lines: string[], start: number, end: number, prefix: string): CadBlockInfo {
  const block: CadBlockInfo = { lineStart: start, lineEnd: end, prefix };
  const body: string[] = [];
  for (let i = start + 1; i < end; i++) {
    const content = stripPrefix(lines[i].replace(/\r$/, ""), prefix);
    body.push(content);
    if (/^name\s*:/.test(content) && block.nameLine === undefined) block.nameLine = i;
    if (/^path\s*:/.test(content) && block.pathLine === undefined) block.pathLine = i;
  }
  // 1行目にパスだけを書く形式
  if (block.pathLine === undefined) {
    const first = body.findIndex((l) => l.trim() !== "");
    if (first >= 0 && !/^\w+\s*:/.test(body[first].trim())) block.pathLine = start + 1 + first;
  }
  block.name = readName(body.join("\n"), block.nameLine !== undefined ? body[block.nameLine - start - 1] : undefined);
  return block;
}

function readName(body: string, nameLine?: string): string | undefined {
  try {
    const parsed = yaml.load(body) as any;
    if (parsed && typeof parsed === "object" && parsed.name != null) {
      return normalizeName(String(parsed.name));
    }
  } catch {
    // YAML として読めないブロック（1行目にパスだけを書く形式など）は、name 行だけを読む
  }
  if (nameLine === undefined) return undefined;
  const value = nameLine.replace(/^name\s*:/, "").trim();
  try {
    const parsed = yaml.load(value);
    if (parsed != null && typeof parsed !== "object") return normalizeName(String(parsed));
  } catch {
    // 引用符の閉じ忘れなどはそのまま使う
  }
  return normalizeName(value);
}

function normalizeName(value: string): string | undefined {
  const name = value.trim();
  return name ? name : undefined;
}

/** 行頭の字下げと「>」を、フェンス行と同じ分だけ取り除く。 */
function stripPrefix(line: string, prefix: string): string {
  if (line.startsWith(prefix)) return line.slice(prefix.length);
  // 空行では行末の空白が削られていることがある
  if (prefix.startsWith(line)) return "";
  return line.replace(/^[ \t>]*/, "");
}

/** ノート内の埋め込みの名前（名前の無い埋め込みは含まない） */
export function listCadEmbedNames(markdown: string): string[] {
  return listCadBlocks(markdown)
    .map((b) => b.name)
    .filter((n): n is string => !!n);
}

/** 使われている名前と重ならない、次の自動の名前（`3D-<使用中の最大の番号 + 1>`）。 */
export function nextCadEmbedName(usedNames: Iterable<string>): string {
  const used = new Set(usedNames);
  let max = 0;
  const pattern = new RegExp(`^${escapeRegExp(CAD_EMBED_NAME_PREFIX)}(\\d+)$`);
  for (const name of used) {
    const m = pattern.exec(name);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  let n = max + 1;
  while (used.has(`${CAD_EMBED_NAME_PREFIX}${n}`)) n++;
  return `${CAD_EMBED_NAME_PREFIX}${n}`;
}

/** YAML の値として書く名前（数字だけの名前などは引用符で囲む）。 */
export function formatYamlName(name: string): string {
  return yaml.dump(name, { lineWidth: -1 }).trim();
}

/**
 * 名前の無い埋め込みと、名前が重なった埋め込み（2つ目以降）に名前を付ける書き換え。
 * 直す必要が無ければ空の配列を返す。
 */
export function cadEmbedNameEdits(markdown: string): TextEdit[] {
  const blocks = listCadBlocks(markdown);
  const seen = new Set<string>();
  const needs: CadBlockInfo[] = [];
  for (const block of blocks) {
    if (block.name && !seen.has(block.name)) seen.add(block.name);
    else needs.push(block);
  }
  if (needs.length === 0) return [];

  const lineOffsets = computeLineOffsets(markdown);
  const lines = markdown.split("\n");
  return needs.map((block) => {
    const name = nextCadEmbedName(seen);
    seen.add(name);
    return setNameEdit(lines, lineOffsets, block, name);
  });
}

/** 名前の変更で起きる問題（無ければ null）。 */
export function validateCadEmbedName(name: string, otherNames: Iterable<string>): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "名前を入力してください";
  if (/[\r\n]/.test(name)) return "名前に改行は使えません";
  for (const other of otherNames) {
    if (other === trimmed) return `「${trimmed}」はこのノートの別の3D埋め込みで使われています`;
  }
  return null;
}

export interface RenameTarget {
  /** 今の名前（名前で埋め込みを探す） */
  name?: string;
  /** 名前で見つからない場合に使う、フェンス行の行番号 */
  lineStart?: number;
}

export type RenameResult = { edit: TextEdit } | { error: string };

/** 埋め込み1つの名前を変える書き換え。 */
export function renameCadEmbedEdit(markdown: string, target: RenameTarget, newName: string): RenameResult {
  const blocks = listCadBlocks(markdown);
  const block =
    (target.name ? blocks.find((b) => b.name === target.name) : undefined) ??
    blocks.find((b) => b.lineStart === target.lineStart);
  if (!block) return { error: "ノートの中に対象の3D埋め込みが見つかりません" };

  const others = blocks.filter((b) => b !== block && b.name).map((b) => b.name as string);
  const error = validateCadEmbedName(newName, others);
  if (error) return { error };

  const lines = markdown.split("\n");
  return { edit: setNameEdit(lines, computeLineOffsets(markdown), block, newName.trim()) };
}

/** 書き換えを本文へ当てる（位置は元の本文の位置。後ろから当てる）。 */
export function applyTextEdits(text: string, edits: TextEdit[]): string {
  let out = text;
  for (const edit of [...edits].sort((a, b) => b.from - a.from)) {
    out = out.slice(0, edit.from) + edit.text + out.slice(edit.to);
  }
  return out;
}

export interface KeyLike {
  key?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
}

/** 名前の変更のショートカット（修飾キー無しの R。IME の変換中は除く）か。 */
export function isRenameShortcut(e: KeyLike): boolean {
  return (
    e.key?.toLowerCase() === "r" &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    !e.shiftKey &&
    !e.isComposing
  );
}

function setNameEdit(lines: string[], offsets: number[], block: CadBlockInfo, name: string): TextEdit {
  const value = formatYamlName(name);
  if (block.nameLine !== undefined) {
    const line = lines[block.nameLine].replace(/\r$/, "");
    const content = stripPrefix(line, block.prefix);
    const key = /^name\s*:\s*/.exec(content)?.[0] ?? "name: ";
    const from = offsets[block.nameLine] + (line.length - content.length) + key.length;
    return { from, to: offsets[block.nameLine] + line.length, text: value };
  }
  // path 行の次（無ければフェンス行の次）に name 行を足す
  const after = block.pathLine ?? block.lineStart;
  const eol = lines[after].endsWith("\r") ? "\r\n" : "\n";
  const at = offsets[after + 1];
  return { from: at, to: at, text: `${block.prefix}name: ${value}${eol}` };
}

function computeLineOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
