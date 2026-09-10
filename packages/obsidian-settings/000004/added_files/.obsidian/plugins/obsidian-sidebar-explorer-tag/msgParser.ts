/**
 * OutlookのMSGファイル（.msg）を解析し、本文・件名・送信者・添付画像等を抽出するパーサー
 * Officeメタデータや条件付きコメント、独自タグを除去してクリーンな本文を取得する
 **/
import type { App, TFile } from "obsidian";
import MsgReader from "@kenjiuno/msgreader";
import { convertEmfToDataUrl, convertWmfToDataUrl } from "emf-converter";
import * as UTIF from "utif";
import { decompressRTF } from "@kenjiuno/decompressrtf";

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

function decodeHtmlBytes(bytes?: Uint8Array): string {
    if (!bytes?.byteLength) return "";
    const preview = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 2048)));
    const charset = preview.match(/charset\s*=\s*["']?([a-zA-Z0-9_-]+)/i)?.[1] || "utf-8";
    for (const encoding of [charset, "utf-8", "windows-31j", "shift-jis"]) {
        try {
            return new TextDecoder(encoding).decode(bytes).replace(/\0+$/g, "");
        } catch {
            // Try the next decoder.
        }
    }
    return new TextDecoder().decode(bytes).replace(/\0+$/g, "");
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

function htmlToPlainText(html: string): string {
    if (!html) return "";
    const cleanHtml = html
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<(head|style|script|xml|title)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
        .replace(/<!DOCTYPE\b[^>]*>/gi, "")
        .replace(/<\/?xml\b[^>]*>/gi, "")
        .replace(/<\/?\w+:[^>]*>/gi, "");
    try {
        const document = new DOMParser().parseFromString(cleanHtml, "text/html");
        document.querySelectorAll("script,style,xml,title").forEach(element => element.remove());
        return (document.body.textContent || "").replace(/\r/g, "").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
    } catch {
        return cleanHtml
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<\/p\s*>/gi, "\n\n")
            .replace(/<[^>]+>/g, "")
            .replace(/&nbsp;/gi, " ")
            .replace(/&lt;/gi, "<")
            .replace(/&gt;/gi, ">")
            .replace(/&amp;/gi, "&")
            .replace(/&quot;/gi, '"')
            .replace(/&#39;/gi, "'")
            .trim();
    }
}

function normalizeDate(value: unknown): string {
    if (!value) return "";
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

export async function parseMsgBinaryWithLibrary(binary: ArrayBuffer, convertImages = true): Promise<ParsedMsgFile> {
    const reader = new MsgReader(binary);
    const fields = reader.getFileData();
    if (fields.error) throw new Error(`MSG解析エラー: ${fields.error}`);

    const htmlBody = String(fields.bodyHtml || "")
        || decodeHtmlBytes(fields.html)
        || extractHtmlFromCompressedRtf(fields.compressedRtf);
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
        Subject: String(fields.subject || ""),
        SenderName: String(fields.senderName || fields.senderEmail || ""),
        Body: String(fields.body || "").trim() ? String(fields.body) : htmlToPlainText(htmlBody),
        HtmlBody: htmlBody,
        SentOn: normalizeDate(fields.clientSubmitTime || fields.messageDeliveryTime || fields.creationTime),
        Attachments: attachments,
        Warnings: warnings,
        Parser: "@kenjiuno/msgreader"
    };
}

export async function parseMsgFileWithLibrary(app: App, file: TFile, convertImages = true): Promise<ParsedMsgFile> {
    return parseMsgBinaryWithLibrary(await app.vault.readBinary(file), convertImages);
}
