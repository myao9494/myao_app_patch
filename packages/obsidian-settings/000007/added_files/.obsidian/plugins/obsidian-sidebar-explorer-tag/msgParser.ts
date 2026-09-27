/**
 * OutlookのMSGファイル（.msg）を解析し、本文・件名・送信者・添付画像等を抽出するパーサー
 * 仕様:
 * 1. コードページ未指定またはcp1252と誤認された日本語MSGにおいて、CP932/Windows-31Jを最優先とした
 *    ベストエフォートデコード（decodeBestEffortText）と文字化けスコア判定（mojibakeScore）により
 *    件名・送信者・本文の文字化けを防止・自動復旧する。
 * 2. HTML本文内の表（テーブル）構造を解析し、ネストされたテーブル（入れ子表）や
 *    セル内複数行（<p>, <br>）、パイプ文字を安全に処理してMarkdownテーブルへ変換する。
 *    外枠用の単一セルレイアウトテーブルは無意味な表化を避けて中身を展開する。
 * 3. Officeメタデータや条件付きコメント（<!--[if ...]>、<xml>、<o:p>等）、独自タグを除去して
 *    クリーンな本文を取得する。
 **/
import type { App, TFile } from "obsidian";
import MsgReader from "@kenjiuno/msgreader";
import { convertEmfToDataUrl, convertWmfToDataUrl } from "emf-converter";
import * as UTIF from "utif";
import { decompressRTF } from "@kenjiuno/decompressrtf";
import { extractPlainTextFromRtf, parseTnefBinary, type ParsedTnef } from "./tnefParser";

export interface ParsedMsgAttachment {
    FileName: string;
    MimeType: string;
    ContentId: string;
    ContentLocation: string;
    Data: Uint8Array;
}

export interface ParsedMsgFile {
    Subject: string;
    SenderName: string;
    Body: string;
    HtmlBody: string;
    RtfBody?: string;
    SentOn: string;
    Attachments: ParsedMsgAttachment[];
    Warnings: string[];
    Parser: "@kenjiuno/msgreader";
}

const MAX_CONVERTED_IMAGE_DIMENSION = 4096;
const MAX_TIFF_PIXELS = 25_000_000;
const MAX_CONVERTED_IMAGE_BYTES = 64 * 1024 * 1024;

function dataUrlToBytes(dataUrl: string): Uint8Array {
    const base64 = dataUrl.split(",", 2)[1] || "";
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
    return new Promise((resolve, reject) => canvas.toBlob(async blob => {
        if (!blob) return reject(new Error("CanvasからPNGを生成できません"));
        resolve(new Uint8Array(await blob.arrayBuffer()));
    }, "image/png"));
}

async function convertTiffToPng(data: Uint8Array): Promise<Uint8Array> {
    const source = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const ifd = UTIF.decode(source)[0];
    if (!ifd) throw new Error("TIFFの画像ディレクトリがありません");
    const declaredWidth = Number(Array.isArray(ifd.t256) ? ifd.t256[0] : 0);
    const declaredHeight = Number(Array.isArray(ifd.t257) ? ifd.t257[0] : 0);
    if (declaredWidth > 0 && declaredHeight > 0 && declaredWidth * declaredHeight > MAX_TIFF_PIXELS) {
        throw new Error(`TIFF画像のサイズが大きすぎます: ${declaredWidth}x${declaredHeight}`);
    }
    UTIF.decodeImage(source, ifd);
    if (!ifd.width || !ifd.height || ifd.width * ifd.height > MAX_TIFF_PIXELS) {
        throw new Error(`TIFF画像のサイズが大きすぎます: ${ifd.width || 0}x${ifd.height || 0}`);
    }
    const rgba = UTIF.toRGBA8(ifd);
    const sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = ifd.width;
    sourceCanvas.height = ifd.height;
    const sourceContext = sourceCanvas.getContext("2d");
    if (!sourceContext) throw new Error("Canvas 2Dを使用できません");
    sourceContext.putImageData(new ImageData(new Uint8ClampedArray(rgba), ifd.width, ifd.height), 0, 0);

    const scale = Math.min(1, MAX_CONVERTED_IMAGE_DIMENSION / Math.max(ifd.width, ifd.height));
    if (scale === 1) return canvasToPng(sourceCanvas);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(ifd.width * scale));
    canvas.height = Math.max(1, Math.round(ifd.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2Dを使用できません");
    context.drawImage(sourceCanvas, 0, 0, canvas.width, canvas.height);
    return canvasToPng(canvas);
}

async function normalizeOutlookImage(attachment: ParsedMsgAttachment): Promise<ParsedMsgAttachment> {
    const extension = attachment.FileName.toLowerCase().match(/\.([^.]+)$/)?.[1] || "";
    const mime = attachment.MimeType.toLowerCase().split(";", 1)[0];
    let png: Uint8Array | null = null;
    if (attachment.Data.byteLength > MAX_CONVERTED_IMAGE_BYTES) {
        throw new Error(`画像データが変換上限（${MAX_CONVERTED_IMAGE_BYTES / 1024 / 1024}MB）を超えています`);
    }
    const source = attachment.Data.buffer.slice(
        attachment.Data.byteOffset,
        attachment.Data.byteOffset + attachment.Data.byteLength
    ) as ArrayBuffer;
    if (extension === "emf" || mime === "image/emf" || mime === "image/x-emf") {
        const dataUrl = await convertEmfToDataUrl(source, MAX_CONVERTED_IMAGE_DIMENSION, MAX_CONVERTED_IMAGE_DIMENSION);
        png = dataUrl ? dataUrlToBytes(dataUrl) : null;
    } else if (extension === "wmf" || mime === "image/wmf" || mime === "image/x-wmf") {
        const dataUrl = await convertWmfToDataUrl(source, MAX_CONVERTED_IMAGE_DIMENSION, MAX_CONVERTED_IMAGE_DIMENSION);
        png = dataUrl ? dataUrlToBytes(dataUrl) : null;
    } else if (["tif", "tiff"].includes(extension) || ["image/tif", "image/tiff"].includes(mime)) {
        png = await convertTiffToPng(attachment.Data);
    }
    if (!png) return attachment;
    return {
        ...attachment,
        FileName: attachment.FileName.replace(/\.(?:emf|wmf|tiff?)$/i, "") + ".png",
        MimeType: "image/png",
        Data: png
    };
}

/**
 * 文字列の文字化け度合いをスコアリングする。
 * スコアが低いほど自然な日本語、高いほど文字化けと判定する。
 **/
export function mojibakeScore(text: string): number {
    if (!text) return Number.MAX_SAFE_INTEGER;
    // 不正文字（\ufffd）は強いペナルティ (20)
    const badChars = (text.match(/[\ufffd\uFFFD]/g) || []).length * 20;
    // 典型的な文字化け文字（Ã, Â, ã, ¢, 縺, 繧, 譁, 謚, ｭ, ｱ 等）はペナルティ (5)
    const mojibakeMatches = (text.match(/[ÃÂã¢縺繧譁謚ｭｱ]/g) || []).length * 5;
    // 自然な日本語文字（ひらがな、カタカナ、漢字）は正しさの証拠としてボーナス (-1)
    const japaneseChars = (text.match(/[\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
    return badChars + mojibakeMatches - japaneseChars;
}

/**
 * バイト列または誤認文字列を、最も自然な日本語（文字化けスコア最小）へベストエフォートでデコードする。
 **/
export function decodeBestEffortText(data: Uint8Array | Buffer | string, preferredCharsets: string[] = []): string {
    let bytes: Uint8Array;
    if (typeof data === "string") {
        bytes = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) {
            bytes[i] = data.charCodeAt(i) & 0xff;
        }
    } else if (data instanceof Uint8Array) {
        bytes = data;
    } else {
        bytes = new Uint8Array(data);
    }
    if (bytes.length === 0) return "";

    const encodingsToTry: string[] = [];
    for (const c of preferredCharsets) {
        if (c && !encodingsToTry.includes(c.toLowerCase())) {
            encodingsToTry.push(c.toLowerCase());
        }
    }

    const standardCandidates = [
        "windows-31j",
        "shift-jis",
        "shift_jis",
        "utf-8",
        "euc-jp",
        "iso-2022-jp",
        "windows-1252",
        "latin1"
    ];
    for (const c of standardCandidates) {
        if (!encodingsToTry.includes(c)) {
            encodingsToTry.push(c);
        }
    }

    interface Candidate {
        charset: string;
        text: string;
        score: number;
    }
    const candidates: Candidate[] = [];

    for (const charset of encodingsToTry) {
        try {
            const decoder = new TextDecoder(charset, { fatal: false });
            let decoded = decoder.decode(bytes);
            const nullIdx = decoded.indexOf("\0");
            if (nullIdx !== -1) {
                decoded = decoded.substring(0, nullIdx);
            }
            candidates.push({
                charset,
                text: decoded.trim(),
                score: mojibakeScore(decoded)
            });
        } catch {
            // 未サポートのエンコーディングはスキップ
        }
    }

    if (candidates.length === 0) {
        try {
            return new TextDecoder("utf-8").decode(bytes).replace(/\0+$/g, "").trim();
        } catch {
            return "";
        }
    }

    candidates.sort((a, b) => a.score - b.score);
    return candidates[0].text;
}

function decodeHtmlBytes(bytes?: Uint8Array): string {
    if (!bytes?.byteLength) return "";
    const preview = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 2048)));
    const charsetMatch = preview.match(/charset\s*=\s*["']?([a-zA-Z0-9_-]+)/i);
    const preferred = charsetMatch ? [charsetMatch[1].toLowerCase()] : ["windows-31j", "shift-jis", "utf-8"];
    return decodeBestEffortText(bytes, preferred);
}

// Outlook sometimes stores the HTML body only as "RTF from HTML". In that
// representation the original HTML is split across {\*\htmltagN ...} groups.
function extractHtmlFromCompressedRtf(bytes?: Uint8Array): string {
    if (!bytes?.byteLength) return "";
    try {
        const rtf = Buffer.from(decompressRTF(Array.from(bytes))).toString("latin1");
        if (!/\\fromhtml\d?/i.test(rtf)) return "";
        const chunks: string[] = [];
        const marker = /\{\\\*\\htmltag\d+\s*/g;
        let match: RegExpExecArray | null;
        while ((match = marker.exec(rtf)) !== null) {
            let index = marker.lastIndex;
            let raw = "";
            while (index < rtf.length) {
                const char = rtf[index];
                if (char === "\\" && index + 1 < rtf.length) {
                    const next = rtf[index + 1];
                    if (next === "\\" || next === "{" || next === "}") {
                        raw += next;
                        index += 2;
                        continue;
                    }
                    const hex = rtf.slice(index).match(/^\\'([0-9a-f]{2})/i);
                    if (hex) {
                        raw += String.fromCharCode(Number.parseInt(hex[1], 16));
                        index += 4;
                        continue;
                    }
                    const control = rtf.slice(index).match(/^\\([a-z]+)-?\d*\s?/i);
                    if (control) {
                        if (control[1].toLowerCase() === "par" || control[1].toLowerCase() === "line") raw += "\n";
                        index += control[0].length;
                        continue;
                    }
                }
                if (char === "}") break;
                raw += char;
                index++;
            }
            chunks.push(raw);
            marker.lastIndex = Math.max(marker.lastIndex, index + 1);
        }
        const html = chunks.join("").trim();
        return /<html\b|<body\b|<img\b/i.test(html) ? html : "";
    } catch {
        return "";
    }
}

/**
 * 単一の <table>...</table> HTML（ネストを含まないもの）を Markdownテーブルまたは展開テキストに変換する
 **/
function convertSingleTable(tableHtml: string): string {
    // <tr> を抽出
    const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    const rows: string[][] = [];
    let rowMatch: RegExpExecArray | null;

    while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
        const rowContent = rowMatch[1];
        const cellRegex = /<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi;
        const cells: string[] = [];
        let cellMatch: RegExpExecArray | null;

        while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
            let cellHtml = cellMatch[1];
            // <br> や <p>, <div> 等のブロック要素を改行/空白に正規化（生の \n はセル内に残さない）
            cellHtml = cellHtml.replace(/<br\s*\/?>/gi, " ");
            cellHtml = cellHtml.replace(/<\/(p|div|section|article|header|footer|h[1-6]|li)>\s*/gi, " ");
            cellHtml = cellHtml.replace(/<li\b[^>]*>/gi, "- ");
            let cellText = cellHtml
                .replace(/<!--[\s\S]*?-->/g, "")
                .replace(/<[^>]+>/g, "")
                .replace(/&nbsp;/gi, " ")
                .replace(/&lt;/gi, "<")
                .replace(/&gt;/gi, ">")
                .replace(/&amp;/gi, "&")
                .replace(/&quot;/gi, '"')
                .replace(/&#39;/gi, "'")
                .replace(/[\r\n\t]+/g, " ")
                .replace(/\|/g, "\\|")
                .trim();
            cells.push(cellText);
        }

        if (cells.length > 0) {
            rows.push(cells);
        }
    }

    if (rows.length === 0) return "";

    const maxCols = Math.max(...rows.map(r => r.length));
    if (maxCols === 0) return "";

    // 1行1セルの場合はレイアウト枠線テーブルとみなし、表記法にせず中身のテキストを展開
    if (rows.length === 1 && maxCols === 1) {
        return `\n\n${rows[0][0]}\n\n`;
    }

    const normalizedRows = rows.map(r => {
        const padded = [...r];
        while (padded.length < maxCols) padded.push("");
        return padded;
    });

    const headerRow = normalizedRows[0];
    const separatorRow = new Array(maxCols).fill("---");
    const dataRows = normalizedRows.slice(1);

    const markdownTableLines = [
        `| ${headerRow.join(" | ")} |`,
        `| ${separatorRow.join(" | ")} |`,
        ...dataRows.map(row => `| ${row.join(" | ")} |`)
    ];

    return `\n\n${markdownTableLines.join("\n")}\n\n`;
}

/**
 * HTML文字列内の <table>...</table> をMarkdownテーブル形式へ変換する。
 * ネストされたテーブルがある場合、内側のテーブルから外側へ順に変換（ボトムアップ処理）し、
 * レイアウト枠（1行1セル）は中身を展開する。
 **/
export function convertHtmlTablesToMarkdown(html: string): string {
    if (!html || !/<table\b/i.test(html)) return html;

    let current = html;
    const tablePlaceholders: string[] = [];
    const deepestTableRegex = /<table\b(?:(?!<table\b)[\s\S])*?<\/table>/gi;
    let iterations = 0;
    const maxIterations = 50;

    while (deepestTableRegex.test(current) && iterations < maxIterations) {
        iterations++;
        current = current.replace(deepestTableRegex, (match) => {
            const converted = convertSingleTable(match);
            // Markdownテーブル（| ... |）になった場合は、
            // 外側テーブルのセル内パイプエスケープに巻き込まれないようプレースホルダーに退避
            if (converted.includes("| --- |")) {
                const placeholder = `__NESTED_TABLE_PLACEHOLDER_${tablePlaceholders.length}__`;
                tablePlaceholders.push(converted);
                return `\n\n${placeholder}\n\n`;
            }
            return converted;
        });
    }

    // プレースホルダーを元のMarkdownテーブルへ復元
    for (let i = 0; i < tablePlaceholders.length; i++) {
        current = current.replace(`__NESTED_TABLE_PLACEHOLDER_${i}__`, tablePlaceholders[i]);
    }

    return current;
}

function htmlToPlainText(html: string): string {
    if (!html) return "";
    let cleanHtml = html
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<(head|style|script|xml|title)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
        .replace(/<!DOCTYPE\b[^>]*>/gi, "")
        .replace(/<\/?xml\b[^>]*>/gi, "")
        .replace(/<\/?\w+:[^>]*>/gi, "");

    // 変換されたMarkdownテーブルが後続のタグ除去や改行正規化で破壊されないよう、
    // プレースホルダーに退避させて保護する
    const tablePlaceholders: string[] = [];
    cleanHtml = convertHtmlTablesToMarkdown(cleanHtml);

    // Markdownテーブル（| ... | で始まるブロック）を検出して保護
    cleanHtml = cleanHtml.replace(/(?:^|\n)(\|[^\n]+\|\r?\n\|[ \t]*[-:]+[-| :]*\|\r?\n(?:\|[^\n]+\|(?:\r?\n|$))+)/g, (_m, tableBlock) => {
        const id = `__MD_TABLE_HOLDER_${tablePlaceholders.length}__`;
        tablePlaceholders.push(`\n\n${tableBlock.trim()}\n\n`);
        return `\n\n${id}\n\n`;
    });

    let text = cleanHtml
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|section|article|header|footer|h[1-6])\s*>/gi, "\n\n")
        .replace(/<\/(li)\s*>/gi, "\n")
        .replace(/<li\b[^>]*>/gi, "- ")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/gi, " ")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&amp;/gi, "&")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/\r/g, "")
        .replace(/\n\s*\n\s*\n+/g, "\n\n")
        .trim();

    // テーブルプレースホルダーを復元
    for (let i = 0; i < tablePlaceholders.length; i++) {
        text = text.replace(`__MD_TABLE_HOLDER_${i}__`, tablePlaceholders[i]);
    }

    return text.replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeDate(value: unknown): string {
    if (!value) return "";
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function recoverStringIfGarbled(str: string): string {
    if (!str) return "";
    const score = mojibakeScore(str);
    if (score > 0) {
        // latin1で誤読された可能性のある生バイトを復元してベストエフォートデコード
        const recovered = decodeBestEffortText(str, ["windows-31j", "shift-jis", "utf-8"]);
        if (mojibakeScore(recovered) < score) {
            return recovered;
        }
    }
    return str;
}

export async function parseMsgBinaryWithLibrary(binary: ArrayBuffer, convertImages = true): Promise<ParsedMsgFile> {
    const reader = new MsgReader(binary);
    // 日本語環境のMSGファイル（コードページ未指定または1252誤認識）対策として、
    // ANSIエンコーディングに windows-31j (CP932) を明示設定
    (reader as any).parserConfig = {
        ansiEncoding: "windows-31j",
        includeRawProps: true
    };
    const fields = reader.getFileData();
    if (fields.error) throw new Error(`MSG解析エラー: ${fields.error}`);

    let htmlBody = String(fields.bodyHtml || "")
        || decodeHtmlBytes(fields.html)
        || extractHtmlFromCompressedRtf(fields.compressedRtf);

    let rtfBody = "";
    if (fields.compressedRtf?.byteLength) {
        try {
            const decompressed = Buffer.from(decompressRTF(Array.from(fields.compressedRtf))).toString("latin1");
            rtfBody = extractPlainTextFromRtf(decompressed);
        } catch {
            // RTF解凍・抽出エラー時はスキップ
        }
    }

    let body = recoverStringIfGarbled(String(fields.body || "").trim());
    const hasTableInHtml = /<table\b/i.test(htmlBody);
    const isBodyGarbled = body ? mojibakeScore(body) > 20 : false;
    if ((!body || hasTableInHtml || isBodyGarbled) && htmlBody) {
        const plainFromHtml = htmlToPlainText(htmlBody);
        if (plainFromHtml && (!body || mojibakeScore(plainFromHtml) <= mojibakeScore(body) || hasTableInHtml)) {
            body = plainFromHtml;
        }
    }
    if (!body && rtfBody) {
        body = rtfBody;
    }

    const attachments: ParsedMsgAttachment[] = [];
    const warnings: string[] = [];
    for (const metadata of fields.attachments || []) {
        // Embedded .msg objects do not necessarily expose a binary attachment stream.
        // getAttachment throws for those, so report them through the caller's error path.
        try {
            const extracted = reader.getAttachment(metadata);
            if (!extracted?.content?.byteLength) continue;
            const dynamic = metadata as typeof metadata & Record<string, unknown>;
            const attachment: ParsedMsgAttachment = {
                FileName: extracted.fileName || metadata.fileName || metadata.fileNameShort || metadata.name || "attachment",
                MimeType: String(metadata.attachMimeTag || ""),
                ContentId: String(metadata.pidContentId || "").replace(/^<|>$/g, ""),
                ContentLocation: String(dynamic.pidTagAttachContentLocation || dynamic.attachContentLocation || ""),
                Data: new Uint8Array(extracted.content)
            };

            // winmail.dat (TNEF) カプセル化ファイルの自動展開
            const isTnef = attachment.FileName.toLowerCase() === "winmail.dat" ||
                attachment.MimeType.toLowerCase().includes("ms-tnef");
            if (isTnef) {
                try {
                    const parsedTnef = parseTnefBinary(attachment.Data);
                    if (parsedTnef) {
                        if (!body && parsedTnef.Body) body = parsedTnef.Body;
                        if (!htmlBody && parsedTnef.HtmlBody) htmlBody = parsedTnef.HtmlBody;
                        for (const tnefAtt of parsedTnef.Attachments) {
                            const subAtt: ParsedMsgAttachment = {
                                FileName: tnefAtt.FileName,
                                MimeType: tnefAtt.MimeType,
                                ContentId: tnefAtt.ContentId || "",
                                ContentLocation: "",
                                Data: tnefAtt.Data
                            };
                            if (convertImages) {
                                try {
                                    attachments.push(await normalizeOutlookImage(subAtt));
                                } catch {
                                    attachments.push(subAtt);
                                }
                            } else {
                                attachments.push(subAtt);
                            }
                        }
                    }
                } catch (error) {
                    warnings.push(`winmail.datのTNEF解析に失敗: ${error instanceof Error ? error.message : String(error)}`);
                }
            }

            if (convertImages) {
                try {
                    attachments.push(await normalizeOutlookImage(attachment));
                } catch (error) {
                    warnings.push(`${attachment.FileName} のPNG変換に失敗: ${error instanceof Error ? error.message : String(error)}`);
                    attachments.push(attachment);
                }
            } else attachments.push(attachment);
        } catch (error) {
            warnings.push(`${metadata.fileName || metadata.name || "添付ファイル"} の抽出に失敗: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    return {
        Subject: recoverStringIfGarbled(String(fields.subject || "")),
        SenderName: recoverStringIfGarbled(String(fields.senderName || fields.senderEmail || "")),
        Body: body,
        HtmlBody: htmlBody,
        RtfBody: rtfBody || undefined,
        SentOn: normalizeDate(fields.clientSubmitTime || fields.messageDeliveryTime || fields.creationTime),
        Attachments: attachments,
        Warnings: warnings,
        Parser: "@kenjiuno/msgreader"
    };
}

export async function parseMsgFileWithLibrary(app: App, file: TFile, convertImages = true): Promise<ParsedMsgFile> {
    return parseMsgBinaryWithLibrary(await app.vault.readBinary(file), convertImages);
}

export async function parseTnefBinaryWithLibrary(binary: ArrayBuffer): Promise<ParsedTnef | null> {
    return parseTnefBinary(binary);
}

export async function parseTnefFileWithLibrary(app: App, file: TFile): Promise<ParsedTnef | null> {
    return parseTnefBinary(await app.vault.readBinary(file));
}
