/**
 * TNEF（Transport Neutral Encapsulation Format / winmail.dat）および
 * リッチテキスト（RTF）から本文・メタデータ・添付ファイルを抽出するデコーダー
 **/
import { decompressRTF } from "@kenjiuno/decompressrtf";

export interface ParsedTnefAttachment {
    FileName: string;
    MimeType: string;
    ContentId?: string;
    Data: Uint8Array;
}

export interface ParsedTnef {
    Subject: string;
    SenderName: string;
    Body: string;
    HtmlBody: string;
    RtfBody?: string;
    SentOn: string;
    Attachments: ParsedTnefAttachment[];
}

const TNEF_SIGNATURE = 0x223E9F78;

// TNEF属性ID定数
const ATT_NULL = 0x0000;
const ATT_FROM = 0x8000;
const ATT_SUBJECT = 0x8004;
const ATT_DATESENT = 0x8008;
const ATT_BODY = 0x800C;
const ATT_ATTACHDATA = 0x800F;
const ATT_ATTACHTITLE = 0x8010;
const ATT_ATTACHRENDDATA = 0x9003;
const ATT_MAPIPROPS = 0x9005;
const ATT_ATTACHMAPIPROPS = 0x9006;

// MAPIプロパティID定数
const PR_SUBJECT = 0x0037;
const PR_CLIENT_SUBMIT_TIME = 0x0039;
const PR_SENDER_NAME = 0x0C1A;
const PR_BODY = 0x1000;
const PR_RTF_COMPRESSED = 0x1009;
const PR_HTML = 0x1013;
const PR_ATTACH_DATA_BIN = 0x3701;
const PR_ATTACH_LONG_FILENAME = 0x3707;
const PR_ATTACH_MIME_TAG = 0x370E;
const PR_ATTACH_CONTENT_ID = 0x3712;

/**
 * 純粋なRTFドキュメント（\fromhtmlなし）から制御語を除去してプレーンテキストを抽出する
 **/
export function extractPlainTextFromRtf(rtfInput: string | Uint8Array): string {
    let rtf = typeof rtfInput === "string" ? rtfInput : new TextDecoder("latin1").decode(rtfInput);
    if (!rtf || !rtf.startsWith("{\\rtf")) return "";

    // 文字コードの推定（\ansicpg932 など）
    let encoding = "utf-8";
    const cpgMatch = rtf.match(/\\ansicpg(\d+)/i);
    if (cpgMatch) {
        const cpg = cpgMatch[1];
        if (cpg === "932") encoding = "shift-jis";
        else if (cpg === "936") encoding = "gbk";
        else if (cpg === "950") encoding = "big5";
        else if (cpg === "949") encoding = "euc-kr";
        else if (cpg === "1252") encoding = "windows-1252";
    } else if (/\\lang1041/i.test(rtf)) {
        encoding = "shift-jis";
    }

    const outputChars: string[] = [];
    let currentCellText = "";
    let currentRowCells: string[] = [];
    let currentTableRows: string[][] = [];

    const flushTable = () => {
        if (currentTableRows.length === 0) return;
        const maxCols = Math.max(...currentTableRows.map(r => r.length));
        if (maxCols > 0) {
            const normalizedRows = currentTableRows.map(r => {
                const row = [...r];
                while (row.length < maxCols) row.push("");
                return row;
            });
            const header = normalizedRows[0];
            const sep = new Array(maxCols).fill("---");
            const data = normalizedRows.slice(1);
            const mdLines = [
                `\n\n| ${header.join(" | ")} |`,
                `| ${sep.join(" | ")} |`,
                ...data.map(row => `| ${row.join(" | ")} |`),
                "\n"
            ];
            outputChars.push(mdLines.join("\n"));
        }
        currentTableRows = [];
    };

    const appendText = (text: string) => {
        if (currentRowCells.length === 0 && currentTableRows.length > 0 && text.trim() && text !== "\n") {
            flushTable();
        }
        currentCellText += text;
    };

    let i = 0;
    const len = rtf.length;
    let groupDepth = 0;
    const skipStack: boolean[] = [];

    // スキップ対象グループのリスト
    const skipGroups = [
        "fonttbl", "colortbl", "stylesheet", "info", "*\\datastore",
        "*\\xmlnstbl", "*\\themedata", "*\\colorschememapping",
        "filetbl", "pict", "object", "*"
    ];

    while (i < len) {
        const char = rtf[i];

        if (char === "{") {
            groupDepth++;
            i++;
            const isParentSkipped = skipStack.length > 0 && skipStack[skipStack.length - 1];
            if (isParentSkipped) {
                skipStack.push(true);
                continue;
            }
            // 次の制御語がスキップ対象グループか判定
            if (i < len && (rtf[i] === "\\" || rtf[i] === "*")) {
                let checkStr = rtf.slice(i, Math.min(i + 40, len));
                if (checkStr.startsWith("\\*")) {
                    skipStack.push(true);
                    continue;
                }
                if (checkStr.startsWith("\\")) checkStr = checkStr.slice(1);
                const wordMatch = checkStr.match(/^([a-z0-9_-]+)/i);
                if (wordMatch) {
                    const tag = wordMatch[1].toLowerCase();
                    const shouldSkip = skipGroups.some(g => tag === g);
                    if (shouldSkip) {
                        skipStack.push(true);
                        continue;
                    }
                }
            }
            skipStack.push(false);
            continue;
        }

        if (char === "}") {
            groupDepth--;
            skipStack.pop();
            i++;
            continue;
        }

        // 現在スキップ中のグループ内部なら読み飛ばす
        if (skipStack.length > 0 && skipStack[skipStack.length - 1]) {
            i++;
            continue;
        }

        if (char === "\\") {
            i++;
            if (i >= len) break;
            const next = rtf[i];

            if (next === "\\" || next === "{" || next === "}") {
                appendText(next);
                i++;
                continue;
            }

            if (next === "\r" || next === "\n") {
                i++;
                continue;
            }

            // 16進エスケープ（\'xx）の連続バイト列を収集してデコード
            if (next === "'") {
                const hexBytes: number[] = [];
                while (i < len && rtf[i] === "'") {
                    const hexStr = rtf.slice(i + 1, i + 3);
                    if (/^[0-9a-fA-F]{2}$/.test(hexStr)) {
                        hexBytes.push(parseInt(hexStr, 16));
                        i += 3;
                    } else {
                        break;
                    }
                    if (i < len && rtf[i] === "\\" && rtf[i + 1] === "'") {
                        i++; // 次の \' へ
                    } else {
                        break;
                    }
                }
                if (hexBytes.length > 0) {
                    try {
                        const decoded = new TextDecoder(encoding).decode(new Uint8Array(hexBytes));
                        appendText(decoded);
                    } catch {
                        appendText(String.fromCharCode(...hexBytes));
                    }
                }
                continue;
            }

            // Unicodeエスケープ（\uN?）
            const uMatch = rtf.slice(i).match(/^u(-?\d+)(\?)?/i);
            if (uMatch) {
                let code = parseInt(uMatch[1], 10);
                if (code < 0) code += 65536;
                appendText(String.fromCharCode(code));
                i += uMatch[0].length;
                continue;
            }

            // 制御語（\par, \line, \tab, \cell, \row 等）
            const wordMatch = rtf.slice(i).match(/^([a-z]+)(-?\d+)? ?/i);
            if (wordMatch) {
                const word = wordMatch[1].toLowerCase();
                if (word === "cell" || word === "nestcell") {
                    currentRowCells.push(currentCellText.replace(/\|/g, "\\|").trim());
                    currentCellText = "";
                } else if (word === "row" || word === "nestrow") {
                    if (currentCellText.trim()) {
                        currentRowCells.push(currentCellText.replace(/\|/g, "\\|").trim());
                    }
                    currentCellText = "";
                    if (currentRowCells.length > 0) {
                        currentTableRows.push(currentRowCells);
                    }
                    currentRowCells = [];
                } else if (word === "par" || word === "line") {
                    if (currentTableRows.length > 0) flushTable();
                    if (currentCellText) {
                        outputChars.push(currentCellText);
                        currentCellText = "";
                    }
                    outputChars.push("\n");
                } else if (word === "tab") {
                    appendText("\t");
                } else if (word === "pard") {
                    if (currentRowCells.length === 0 && currentTableRows.length > 0) {
                        flushTable();
                    }
                }
                i += wordMatch[0].length;
                continue;
            }

            // その他のバックスラッシュ文字
            i++;
            continue;
        }

        if (char === "\r" || char === "\n") {
            i++;
            continue;
        }

        appendText(char);
        i++;
    }

    if (currentTableRows.length > 0) flushTable();
    if (currentCellText) outputChars.push(currentCellText);

    return outputChars.join("")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

/**
 * MAPIプロパティストリーム（attMsgProps）から属性辞書を解析する
 **/
function parseMapiProperties(data: Uint8Array): Map<number, Uint8Array | string> {
    const props = new Map<number, Uint8Array | string>();
    if (data.length < 4) return props;

    const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    let offset = 0;
    const numProps = buffer.readUInt32LE(offset);
    offset += 4;

    for (let i = 0; i < numProps && offset + 4 <= buffer.length; i++) {
        const propType = buffer.readUInt16LE(offset);
        const propId = buffer.readUInt16LE(offset + 2);
        offset += 4;

        // Named properties (0x8000 - 0xFFFE) have GUID and kind
        if (propId >= 0x8000 && propId <= 0xFFFE) {
            offset += 16; // GUID
            if (offset + 4 > buffer.length) break;
            const kind = buffer.readUInt32LE(offset);
            offset += 4;
            if (kind === 0) {
                offset += 4; // ID
            } else if (kind === 1) {
                if (offset + 4 > buffer.length) break;
                const iidLen = buffer.readUInt32LE(offset);
                offset += 4;
                offset += iidLen + (-iidLen & 3);
            }
        }

        // Multi-value check
        const isMulti = (propType & 0x1000) !== 0;
        const baseType = propType & ~0x1000;

        let valCount = 1;
        if (isMulti) {
            if (offset + 4 > buffer.length) break;
            valCount = buffer.readUInt32LE(offset);
            offset += 4;
        }

        // Type size
        let typeSize = -1;
        if (baseType === 0x0002) typeSize = 2; // short
        else if (baseType === 0x0003 || baseType === 0x000A) typeSize = 4; // int / error
        else if (baseType === 0x0004) typeSize = 4; // float
        else if (baseType === 0x0005 || baseType === 0x0007) typeSize = 8; // double / apptime
        else if (baseType === 0x0006 || baseType === 0x0014 || baseType === 0x0040) typeSize = 8; // currency / int8 / systime
        else if (baseType === 0x000B) typeSize = 2; // bool
        else if (baseType === 0x0048) typeSize = 16; // clsid

        for (let v = 0; v < valCount; v++) {
            let itemLen = typeSize;
            if (typeSize < 0) {
                if (offset + 4 > buffer.length) break;
                itemLen = buffer.readUInt32LE(offset);
                offset += 4;
            }

            if (offset + itemLen > buffer.length) break;
            const valBytes = buffer.subarray(offset, offset + itemLen);

            if (v === 0) {
                if (baseType === 0x001F) {
                    // Unicode string
                    let str = Buffer.from(valBytes).toString("utf16le");
                    const nullIdx = str.indexOf("\0");
                    if (nullIdx !== -1) str = str.substring(0, nullIdx);
                    props.set(propId, str);
                } else if (baseType === 0x001E) {
                    // ANSI string
                    let str = new TextDecoder("shift-jis").decode(valBytes);
                    const nullIdx = str.indexOf("\0");
                    if (nullIdx !== -1) str = str.substring(0, nullIdx);
                    props.set(propId, str);
                } else {
                    props.set(propId, new Uint8Array(valBytes));
                }
            }

            offset += itemLen;
            offset += -itemLen & 3; // 4-byte padding
        }
    }

    return props;
}

/**
 * TNEFバイナリ（winmail.dat）を解析する
 **/
export function parseTnefBinary(binary: Uint8Array | ArrayBuffer): ParsedTnef | null {
    const bytes = binary instanceof Uint8Array ? binary : new Uint8Array(binary);
    if (bytes.length < 16) return null;

    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const signature = buffer.readUInt32LE(0);
    if (signature !== TNEF_SIGNATURE) {
        return null;
    }

    let subject = "";
    let senderName = "";
    let body = "";
    let htmlBody = "";
    let rtfBody = "";
    let sentOn = "";

    const attachments: ParsedTnefAttachment[] = [];
    let currentAttachment: Partial<ParsedTnefAttachment> | null = null;

    let offset = 6; // signature (4) + key (2)
    while (offset + 9 <= buffer.length) {
        const level = buffer.readUInt8(offset);
        const id = buffer.readUInt16LE(offset + 1);
        const type = buffer.readUInt16LE(offset + 3);
        const length = buffer.readUInt32LE(offset + 5);
        offset += 9;

        if (offset + length + 2 > buffer.length) break;
        const attrData = buffer.subarray(offset, offset + length);
        offset += length;
        const checksum = buffer.readUInt16LE(offset);
        offset += 2;

        if (level === 1) { // Message level
            if (id === ATT_SUBJECT) {
                const str = attrData.toString("utf8").replace(/\0+$/, "");
                if (str) subject = str;
            } else if (id === ATT_FROM) {
                const str = attrData.toString("utf8").replace(/\0+$/, "");
                if (str) senderName = str;
            } else if (id === ATT_BODY) {
                const str = attrData.toString("utf8").replace(/\0+$/, "");
                if (str) body = str;
            } else if (id === ATT_DATESENT && length >= 14) {
                // DTR structure: YYYY MM DD HH MM SS DOW
                const year = attrData.readUInt16LE(0);
                const month = attrData.readUInt16LE(2);
                const day = attrData.readUInt16LE(4);
                const hour = attrData.readUInt16LE(6);
                const min = attrData.readUInt16LE(8);
                const sec = attrData.readUInt16LE(10);
                sentOn = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ` +
                         `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
            } else if (id === ATT_MAPIPROPS) {
                const mapi = parseMapiProperties(attrData);
                if (mapi.has(PR_SUBJECT) && !subject) {
                    subject = String(mapi.get(PR_SUBJECT));
                }
                if (mapi.has(PR_SENDER_NAME) && !senderName) {
                    senderName = String(mapi.get(PR_SENDER_NAME));
                }
                if (mapi.has(PR_BODY) && !body) {
                    body = String(mapi.get(PR_BODY));
                }
                if (mapi.has(PR_HTML)) {
                    const htmlVal = mapi.get(PR_HTML);
                    if (typeof htmlVal === "string") htmlBody = htmlVal;
                    else if (htmlVal instanceof Uint8Array) {
                        htmlBody = new TextDecoder("utf-8").decode(htmlVal);
                    }
                }
                if (mapi.has(PR_RTF_COMPRESSED)) {
                    const rtfBytes = mapi.get(PR_RTF_COMPRESSED);
                    if (rtfBytes instanceof Uint8Array) {
                        try {
                            const decompressed = Buffer.from(decompressRTF(Array.from(rtfBytes))).toString("latin1");
                            rtfBody = decompressed;
                            if (!body && !htmlBody) {
                                body = extractPlainTextFromRtf(decompressed);
                            }
                        } catch {
                            // RTF解凍失敗時はスキップ
                        }
                    }
                }
            }
        } else if (level === 2) { // Attachment level
            if (id === ATT_ATTACHRENDDATA) {
                if (currentAttachment && currentAttachment.Data && currentAttachment.FileName) {
                    attachments.push({
                        FileName: currentAttachment.FileName,
                        MimeType: currentAttachment.MimeType || "application/octet-stream",
                        ContentId: currentAttachment.ContentId,
                        Data: currentAttachment.Data
                    });
                }
                currentAttachment = {};
            } else if (currentAttachment) {
                if (id === ATT_ATTACHTITLE) {
                    const name = attrData.toString("utf8").replace(/\0+$/, "");
                    if (name) currentAttachment.FileName = name;
                } else if (id === ATT_ATTACHDATA) {
                    currentAttachment.Data = new Uint8Array(attrData);
                } else if (id === ATT_ATTACHMAPIPROPS) {
                    const attMapi = parseMapiProperties(attrData);
                    if (attMapi.has(PR_ATTACH_LONG_FILENAME)) {
                        currentAttachment.FileName = String(attMapi.get(PR_ATTACH_LONG_FILENAME));
                    }
                    if (attMapi.has(PR_ATTACH_MIME_TAG)) {
                        currentAttachment.MimeType = String(attMapi.get(PR_ATTACH_MIME_TAG));
                    }
                    if (attMapi.has(PR_ATTACH_CONTENT_ID)) {
                        currentAttachment.ContentId = String(attMapi.get(PR_ATTACH_CONTENT_ID)).replace(/^<|>$/g, "");
                    }
                    if (attMapi.has(PR_ATTACH_DATA_BIN) && !currentAttachment.Data) {
                        const bin = attMapi.get(PR_ATTACH_DATA_BIN);
                        if (bin instanceof Uint8Array) currentAttachment.Data = bin;
                    }
                }
            }
        }
    }

    if (currentAttachment && currentAttachment.Data && currentAttachment.FileName) {
        attachments.push({
            FileName: currentAttachment.FileName,
            MimeType: currentAttachment.MimeType || "application/octet-stream",
            ContentId: currentAttachment.ContentId,
            Data: currentAttachment.Data
        });
    }

    return {
        Subject: subject,
        SenderName: senderName,
        Body: body,
        HtmlBody: htmlBody,
        RtfBody: rtfBody,
        SentOn: sentOn,
        Attachments: attachments
    };
}
