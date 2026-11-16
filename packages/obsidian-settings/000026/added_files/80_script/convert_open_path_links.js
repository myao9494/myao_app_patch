#!/usr/bin/env node
/**
 * 仕様: ノートにある、ファイルマネージャーで開くリンク（http://localhost:8001/api/open-path?path=…）を、
 *       パスそのものの file:/// のリンクへまとめて書き換える。
 *
 * 目的:
 *   From Clipboard とファイルマネージャーからのドロップは、リンク先にパス（file:///）を入れるようになった。
 *   Claudian などの AI がリンクからパスを読めるよう、以前に作ったリンクも同じ形にする。
 *   file:/// のリンクをクリックすると、今までどおりファイルマネージャー（localhost:8001）で開く
 *   （80_script/register_custom_commands/18_file_manager_and_editor_menu.js の installFileUrlOpenPatch）。
 *
 * 書き換え:
 *   [名前](http://localhost:8001/api/open-path?path=%2FUsers%2Fa%2F資料.pdf) → [名前](file:///Users/a/資料.pdf)
 *   <http://localhost:8001/api/open-path?path=…> と、本文にそのまま書いた URL      → [資料.pdf](file:///Users/a/資料.pdf)
 *   UNC パス \\server@80\share\… は file:////server@80/share/… にする。
 *   パスへの変換は From Clipboard と同じ関数（11_from_clipboard.js の localPathToFileUrl）を使う。
 *
 * 書き換えないもの:
 *   - コードブロック（``` / ~~~）とインラインコード（`…`）の中（API の説明として書いたもの）
 *   - 絶対パスでないもの（path={ファイルのフルパス} のような説明、文章が入ってしまったリンク）。一覧に出す
 *   - Excalidraw の図のデータ（# Excalidraw Data 以降）。図の上に書いたノートの部分だけを書き換える
 *   - 隠しフォルダ（.obsidian / .handoff など）、node_modules、docs、scratch、00_templates、80_script、
 *     保管庫の直下のファイル（CLAUDE.md などの説明）
 *   - localhost:3001/?filepath=…（Excalidraw の Web アプリで開くリンク）
 *
 * 使い方（保管庫のフォルダで実行する）:
 *   node 80_script/convert_open_path_links.js            # 確認だけ（書き換える箇所を表示する）
 *   node 80_script/convert_open_path_links.js --write    # 書き換える
 *   node 80_script/convert_open_path_links.js --write 01_data/2026   # フォルダやファイルを指定する
 */

const fs = require("fs");
const path = require("path");

const VAULT_ROOT = path.resolve(__dirname, "..");
const FROM_CLIPBOARD_SCRIPT = path.join(VAULT_ROOT, "80_script/register_custom_commands/11_from_clipboard.js");
const EXCLUDED_DIRECTORIES = new Set(["node_modules", "docs", "scratch", "00_templates", "80_script"]);

// From Clipboard と同じ変換関数を読み込む（11_from_clipboard.js は宣言だけのファイル）
const loadPathHelpers = () => {
    const source = fs.readFileSync(FROM_CLIPBOARD_SCRIPT, "utf8");
    // eslint-disable-next-line no-new-func
    return new Function(`${source}\nreturn { localPathToFileUrl, escapeMarkdownLinkText, getLastPathSegment, decodeUriSafely };`)();
};
const { localPathToFileUrl, escapeMarkdownLinkText, getLastPathSegment, decodeUriSafely } = loadPathHelpers();

// open-path の URL 部分。古いリンクには半角括弧がエンコードされずに残っているので、対応の取れた括弧は URL に含める
const OPEN_PATH_URL = String.raw`http://localhost:8001/api/open-path\?path=(?:[^()\s<>\]]|\([^()\s]*\))+`;
const MARKDOWN_LINK_TEXT = String.raw`\[(?:\\.|[^\]\\])*\]`;
const OPEN_PATH_PATTERN = new RegExp(
    `(${MARKDOWN_LINK_TEXT})\\((${OPEN_PATH_URL})\\)|<(${OPEN_PATH_URL})>|(${OPEN_PATH_URL})`,
    "g"
);
// コードブロックとインラインコード。この中は書き換えない
const CODE_PATTERN = /(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[^\n]*(?=\n|$)|$)|`[^`\n]+`/g;

// open-path の URL からパスを取り出す。URL として読めなければ path= の値をデコードする
const openPathUrlToLocalPath = (url) => {
    try {
        const value = new URL(url).searchParams.get("path");
        if (value) return value;
    } catch (e) {
        // 下で読む
    }
    const match = url.match(/[?&]path=([^&]+)/);
    return match ? decodeUriSafely(match[1].replace(/\+/g, " ")) : null;
};

// テキストの中の open-path のリンクを file:/// のリンクにする。書き換えた箇所と、書き換えなかった箇所を返す
const convertOpenPathLinksInText = (text) => {
    const changes = [];
    const skipped = [];
    const convertPart = (part) => part.replace(OPEN_PATH_PATTERN, (whole, linkText, linkUrl, angleUrl, bareUrl) => {
        const url = linkUrl || angleUrl || bareUrl;
        const localPath = openPathUrlToLocalPath(url);
        const fileUrl = localPath ? localPathToFileUrl(localPath) : null;
        if (!fileUrl) {
            skipped.push(whole);
            return whole;
        }
        const name = linkText || `[${escapeMarkdownLinkText(getLastPathSegment(localPath) || localPath)}]`;
        const replacement = `${name}(${fileUrl})`;
        changes.push({ from: whole, to: replacement });
        return replacement;
    });

    let result = "";
    let lastIndex = 0;
    for (const match of text.matchAll(CODE_PATTERN)) {
        result += convertPart(text.slice(lastIndex, match.index)) + match[0];
        lastIndex = match.index + match[0].length;
    }
    result += convertPart(text.slice(lastIndex));
    return { text: result, changes, skipped };
};

// ノート全体を書き換える。Excalidraw の図のデータ（# Excalidraw Data 以降）は変えない
const convertOpenPathLinksInNote = (content) => {
    const dataStart = content.search(/^(?:%%\s*\n)?# Excalidraw Data\s*$/m);
    const head = dataStart >= 0 ? content.slice(0, dataStart) : content;
    const tail = dataStart >= 0 ? content.slice(dataStart) : "";
    const converted = convertOpenPathLinksInText(head);
    return { ...converted, text: converted.text + tail };
};

const listMarkdownFiles = (target) => {
    const stat = fs.statSync(target);
    if (stat.isFile()) return target.endsWith(".md") ? [target] : [];
    const files = [];
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
        const fullPath = path.join(target, entry.name);
        if (entry.isDirectory()) {
            if (entry.name.startsWith(".") || EXCLUDED_DIRECTORIES.has(entry.name)) continue;
            files.push(...listMarkdownFiles(fullPath));
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
            // 保管庫の直下のファイル（CLAUDE.md などの説明）は対象外
            if (target === VAULT_ROOT) continue;
            files.push(fullPath);
        }
    }
    return files;
};

const main = () => {
    const args = process.argv.slice(2);
    const write = args.includes("--write");
    const targets = args.filter((arg) => arg !== "--write").map((arg) => path.resolve(VAULT_ROOT, arg));
    const files = (targets.length > 0 ? targets : [VAULT_ROOT]).flatMap(listMarkdownFiles);

    let changedFiles = 0;
    let changedLinks = 0;
    for (const file of files) {
        const content = fs.readFileSync(file, "utf8");
        if (!content.includes("localhost:8001/api/open-path")) continue;
        const { text, changes, skipped } = convertOpenPathLinksInNote(content);
        const relativePath = path.relative(VAULT_ROOT, file);
        for (const item of skipped) console.log(`[変換しない] ${relativePath}: ${item}`);
        if (changes.length === 0) continue;
        changedFiles++;
        changedLinks += changes.length;
        console.log(`\n${relativePath}（${changes.length}件）`);
        for (const change of changes) console.log(`  ${change.from}\n  → ${change.to}`);
        if (write) fs.writeFileSync(file, text, "utf8");
    }
    console.log(`\n${changedFiles}ファイル、${changedLinks}件${write ? "を書き換えました。" : "を書き換えます（確認だけ。書き換えるには --write を付ける）。"}`);
};

if (require.main === module) main();

module.exports = { convertOpenPathLinksInText, convertOpenPathLinksInNote, openPathUrlToLocalPath };
