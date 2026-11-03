/**
 * TNEF（Transport Neutral Encapsulation Format / winmail.dat）および
 * リッチテキスト（RTF）から本文・メタデータ・添付ファイルを抽出するデコーダー
 *
 * 仕様:
 * - TNEF は MS-OXTNEF の形式で読む。属性の文字列は attOemCodepage の文字コードで読み、
 *   attMsgProps / attAttachment の MAPI プロパティから本文と添付の情報を読む。
 * - RTF は MS-OXRTFEX に沿って読む。HTML から作られた RTF（\fromhtml）は、\htmltag の中と、
 *   \htmlrtf で抑止されていない本文を順につないで元の HTML に戻す（extractHtmlFromRtf）。
 *   本文はタグの外にあるため、タグだけを読むと文字が消える。
 * - グループごとに \ucN と \htmlrtf の状態を持ち、\uN の代わりの文字を重ねて出力しない。
 * - Shift-JIS の2バイト目は ASCII の範囲だと \'xx にならず文字のまま書かれるため、1バイト目と一緒に読む。
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

// TNEF属性ID定数（MS-OXTNEF）
const ATT_FROM = 0x8000;
const ATT_SUBJECT = 0x8004;
const ATT_DATESENT = 0x8005;
const ATT_BODY = 0x800C;
const ATT_ATTACHDATA = 0x800F;
const ATT_ATTACHTITLE = 0x8010;
const ATT_ATTACHRENDDATA = 0x9002;
const ATT_MSGPROPS = 0x9003;
const ATT_ATTACHMENT = 0x9005;
const ATT_OEMCODEPAGE = 0x9007;

// MAPIプロパティID定数
const PR_SUBJECT = 0x0037;
const PR_SENDER_NAME = 0x0C1A;
const PR_BODY = 0x1000;
const PR_RTF_COMPRESSED = 0x1009;
const PR_HTML = 0x1013;
const PR_ATTACH_DATA_BIN = 0x3701;
const PR_ATTACH_LONG_FILENAME = 0x3707;
const PR_ATTACH_MIME_TAG = 0x370E;
const PR_ATTACH_CONTENT_ID = 0x3712;
const PR_INTERNET_CPID = 0x3FDE;

// コードページ → TextDecoder の文字コード
const CODEPAGE_ENCODINGS: Record<number, string> = {
    932: "shift-jis",
    936: "gbk",
    949: "euc-kr",
    950: "big5",
    1252: "windows-1252",
    20932: "euc-jp",
    51932: "euc-jp",
    50220: "iso-2022-jp",
    50221: "iso-2022-jp",
    50222: "iso-2022-jp",
    65001: "utf-8"
};

// RTF の本文に現れない（フォント表などの）グループ
const RTF_SKIPPED_GROUPS = new Set(["fonttbl", "colortbl", "stylesheet", "info", "filetbl", "pict", "object"]);

// 文字そのものを表す制御語
const RTF_SPECIAL_CHARACTERS: Record<string, string> = {
    tab: "\t",
    emdash: "—",
    endash: "–",
    lquote: "‘",
    rquote: "’",
    ldblquote: "“",
    rdblquote: "”",
    bullet: "•",
    emspace: " ",
    enspace: " ",
    qmspace: " "
};

/** NUL までのバイト列を文字列にする。文字コードが不明なら UTF-8、読めなければ Shift-JIS とする */
function decodeTextBytes(bytes: Uint8Array, encoding: string | null): string {
    const end = bytes.indexOf(0);
    const text = end === -1 ? bytes : bytes.subarray(0, end);
    if (encoding) return new TextDecoder(encoding).decode(text);
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(text);
    } catch {
        return new TextDecoder("shift-jis").decode(text);
    }
}

/** RTF の \'xx を読む文字コードを決める。日本語フォントがあれば \ansicpg1252 でも Shift-JIS とする */
function getRtfEncoding(rtf: string): string {
    const encoding = CODEPAGE_ENCODINGS[Number(rtf.match(/\\ansicpg(\d+)/i)?.[1])];
    if ((!encoding || encoding === "windows-1252") && /\\fcharset128\b|\\lang1041\b/i.test(rtf)) return "shift-jis";
    return encoding || "windows-1252";
}

function isShiftJisLeadByte(byte: number): boolean {
    return (byte >= 0x81 && byte <= 0x9F) || (byte >= 0xE0 && byte <= 0xFC);
}

/**
 * 連続した \'xx をまとめて文字列にする（マルチバイト文字が途中で壊れないように）。
 * start は最初の「'」の位置。next は読み終えた位置を返す。
 **/
function readRtfHexRun(rtf: string, start: number, encoding: string): { text: string; next: number } {
    const bytes: number[] = [];
    let index = start;
    let expectTrailByte = false;
    while (rtf[index] === "'") {
        const hex = rtf.slice(index + 1, index + 3);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) break;
        const byte = parseInt(hex, 16);
        bytes.push(byte);
        index += 3;
        expectTrailByte = encoding === "shift-jis" && !expectTrailByte && isShiftJisLeadByte(byte);
        if (expectTrailByte) {
            const char = rtf[index];
            const next = rtf[index + 1];
            if (char === "\\" && (next === "\\" || next === "{" || next === "}")) {
                bytes.push(next.charCodeAt(0));
                index += 2;
                expectTrailByte = false;
            } else if (char !== undefined && char >= " " && char !== "\\" && char !== "{" && char !== "}") {
                bytes.push(char.charCodeAt(0) & 0xFF);
                index += 1;
                expectTrailByte = false;
            }
        }
        if (rtf[index] === "\\" && rtf[index + 1] === "'") index += 1;
        else break;
    }
    if (bytes.length === 0) return { text: "", next: start };
    return { text: new TextDecoder(encoding).decode(new Uint8Array(bytes)), next: index };
}

/** \uN の直後の代わりの文字（count 個）を読み飛ばす */
function skipRtfFallback(rtf: string, start: number, count: number): number {
    let index = start;
    for (let skipped = 0; skipped < count && index < rtf.length; skipped++) {
        if (rtf[index] === "{" || rtf[index] === "}") break;
        if (rtf[index] !== "\\") {
            index += 1;
            continue;
        }
        if (rtf[index + 1] === "'") {
            index += 4;
            continue;
        }
        const word = rtf.slice(index + 1, index + 49).match(/^[a-z]+-?\d* ?/i);
        index += word ? word[0].length + 1 : 2;
    }
    return index;
}

interface RtfGroupState {
    skip: boolean;
    unicodeSkip: number;
    suppressed: boolean;
    htmlTag: boolean;
}

interface RtfScanHandlers {
    /** \htmltag の中身を読むか（false ならタグの中は読み飛ばす） */
    keepHtmlTags: boolean;
    text: (text: string) => void;
    word: (word: string) => void;
}

/** RTF を先頭から読み、本文の文字と制御語を handlers へ渡す（読み飛ばすグループと抑止された部分は渡さない） */
function scanRtf(rtf: string, handlers: RtfScanHandlers): void {
    const encoding = getRtfEncoding(rtf);
    const stack: RtfGroupState[] = [];
    let state: RtfGroupState = { skip: false, unicodeSkip: 1, suppressed: false, htmlTag: false };
    const isVisible = () => !state.suppressed || state.htmlTag;
    const emit = (text: string) => {
        if (isVisible()) handlers.text(text);
    };

    let i = 0;
    while (i < rtf.length) {
        const char = rtf[i];

        if (char === "{") {
            stack.push(state);
            state = { ...state };
            i++;
            if (state.skip) continue;
            const head = rtf.slice(i, i + 40);
            const htmlTag = head.match(/^\\\*\\htmltag\d* ?/i);
            if (htmlTag && handlers.keepHtmlTags) {
                state.htmlTag = true;
                i += htmlTag[0].length;
            } else if (head.startsWith("\\*")) {
                state.skip = true;
            } else if (RTF_SKIPPED_GROUPS.has(head.match(/^\\([a-z]+)/i)?.[1].toLowerCase() ?? "")) {
                state.skip = true;
            }
            continue;
        }

        if (char === "}") {
            state = stack.pop() ?? state;
            i++;
            continue;
        }

        if (state.skip) {
            i += char === "\\" ? 2 : 1;
            continue;
        }

        if (char === "\r" || char === "\n") {
            i++;
            continue;
        }

        if (char !== "\\") {
            emit(char);
            i++;
            continue;
        }

        i++;
        if (i >= rtf.length) break;
        const next = rtf[i];

        if (next === "\\" || next === "{" || next === "}") {
            emit(next);
            i++;
        } else if (next === "'") {
            const run = readRtfHexRun(rtf, i, encoding);
            if (run.text) emit(run.text);
            i = run.next;
        } else if (next === "~") {
            emit(" ");
            i++;
        } else if (next === "_") {
            emit("-");
            i++;
        } else {
            const head = rtf.slice(i, i + 48);
            const unicode = head.match(/^u(-?\d+) ?/i);
            const control = head.match(/^([a-z]+)(-?\d+)? ?/i);
            if (unicode) {
                const code = parseInt(unicode[1], 10);
                emit(String.fromCharCode(code < 0 ? code + 65536 : code));
                i = skipRtfFallback(rtf, i + unicode[0].length, state.unicodeSkip);
            } else if (control) {
                const word = control[1].toLowerCase();
                if (word === "uc") state.unicodeSkip = Number(control[2] ?? 1);
                else if (word === "htmlrtf") state.suppressed = control[2] !== "0";
                else if (RTF_SPECIAL_CHARACTERS[word]) emit(RTF_SPECIAL_CHARACTERS[word]);
                else if (isVisible()) handlers.word(word);
                i += control[0].length;
            } else {
                i++;
            }
        }
    }
}

/**
 * 純粋なRTFドキュメント（\fromhtmlなし）から制御語を除去してプレーンテキストを抽出する
 **/
export function extractPlainTextFromRtf(rtfInput: string | Uint8Array): string {
    const rtf = typeof rtfInput === "string" ? rtfInput : new TextDecoder("latin1").decode(rtfInput);
    if (!rtf || !rtf.startsWith("{\\rtf")) return "";

    const outputChars: string[] = [];
    let currentCellText = "";
    let currentRowCells: string[] = [];
    let currentTableRows: string[][] = [];
    // 表の中にいるか（\intbl / \trowd / \cell で入り、\pard で出る。行の間の \pard\intbl では出ない）
    let inTable = false;

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

    const finishCell = () => {
        currentRowCells.push(currentCellText.replace(/\|/g, "\\|").trim());
        currentCellText = "";
    };

    scanRtf(rtf, {
        keepHtmlTags: false,
        text: (text) => {
            if (!inTable && currentRowCells.length === 0 && text.trim()) flushTable();
            currentCellText += text;
        },
        word: (word) => {
            if (word === "cell" || word === "nestcell") {
                inTable = true;
                finishCell();
            } else if (word === "row" || word === "nestrow") {
                if (currentCellText.trim()) finishCell();
                currentCellText = "";
                if (currentRowCells.length > 0) currentTableRows.push(currentRowCells);
                currentRowCells = [];
            } else if (word === "intbl" || word === "trowd") {
                inTable = true;
            } else if (word === "pard") {
                inTable = false;
            } else if (word === "par" || word === "line") {
                if (inTable && (currentRowCells.length > 0 || currentCellText.trim())) {
                    // セルの中の改行（Markdownのセルは1行のため空白にする）
                    currentCellText += " ";
                    return;
                }
                flushTable();
                if (currentCellText) {
                    outputChars.push(currentCellText);
                    currentCellText = "";
                }
                outputChars.push("\n");
            }
        }
    });

    flushTable();
    if (currentCellText) outputChars.push(currentCellText);

    return outputChars.join("")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

/**
 * HTML から作られた RTF（\fromhtml）を元の HTML に戻す（MS-OXRTFEX の de-encapsulation）。
 * HTML から作られた RTF でなければ空文字を返す。
 **/
export function extractHtmlFromRtf(rtf: string): string {
    if (!rtf || !/\\fromhtml\d?/i.test(rtf)) return "";
    const chunks: string[] = [];
    scanRtf(rtf, {
        keepHtmlTags: true,
        text: (text) => chunks.push(text),
        word: (word) => {
            if (word === "par" || word === "line") chunks.push("\r\n");
        }
    });
    const html = chunks.join("").trim();
    return /<[a-z!]/i.test(html) ? html : "";
}

/**
 * MAPIプロパティストリーム（attMsgProps / attAttachment）から属性辞書を解析する
 * encoding は ANSI 文字列（PT_STRING8）の文字コード
 **/
function parseMapiProperties(data: Uint8Array, encoding: string | null): Map<number, Uint8Array | string> {
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

        const isMulti = (propType & 0x1000) !== 0;
        const baseType = propType & ~0x1000;

        // Type size
        let typeSize = -1;
        if (baseType === 0x0002) typeSize = 2; // short
        else if (baseType === 0x0003 || baseType === 0x000A) typeSize = 4; // int / error
        else if (baseType === 0x0004) typeSize = 4; // float
        else if (baseType === 0x0005 || baseType === 0x0007) typeSize = 8; // double / apptime
        else if (baseType === 0x0006 || baseType === 0x0014 || baseType === 0x0040) typeSize = 8; // currency / int8 / systime
        else if (baseType === 0x000B) typeSize = 2; // bool
        else if (baseType === 0x0048) typeSize = 16; // clsid

        // 複数値のプロパティと可変長のプロパティは、値の個数から始まる（可変長は1個でも個数がある）
        let valCount = 1;
        if (isMulti || typeSize < 0) {
            if (offset + 4 > buffer.length) break;
            valCount = buffer.readUInt32LE(offset);
            offset += 4;
        }

        // 複数値の2バイトの値は詰めて並ぶ（奇数個のときだけ最後に2バイト埋める）
        const packedShorts = isMulti && typeSize === 2;

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
                    props.set(propId, decodeTextBytes(valBytes, encoding ?? "shift-jis"));
                } else {
                    props.set(propId, new Uint8Array(valBytes));
                }
            }

            offset += itemLen;
            if (!packedShorts) offset += -itemLen & 3; // 4-byte padding
        }
        if (packedShorts && valCount % 2 === 1) offset += 2;
    }

    return props;
}

function readMapiInteger(value: Uint8Array | string | undefined): number {
    if (!(value instanceof Uint8Array) || value.length < 4) return 0;
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).readUInt32LE(0);
}

/** PR_HTML を文字列にする。文字コードは PR_INTERNET_CPID、HTML の charset、TNEF の文字コードの順で決める */
function decodeHtmlProperty(value: Uint8Array | string, codepage: number, encoding: string | null): string {
    if (typeof value === "string") return value;
    const declared = new TextDecoder("latin1").decode(value.subarray(0, 2048)).match(/charset\s*=\s*["']?([\w-]+)/i)?.[1];
    for (const label of [CODEPAGE_ENCODINGS[codepage], declared, encoding]) {
        if (!label) continue;
        try {
            return decodeTextBytes(value, label);
        } catch {
            // 未対応の文字コードは次の候補へ
        }
    }
    return decodeTextBytes(value, null);
}

/** attFrom（TRP 構造）から送信者名を読む: 8バイトの見出し（4バイト目から名前の長さ）のあとに名前 */
function readTrpName(data: Buffer, encoding: string | null): string {
    if (data.length < 8) return "";
    return decodeTextBytes(data.subarray(8, 8 + data.readUInt16LE(4)), encoding);
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
    let encoding: string | null = null;

    const attachments: ParsedTnefAttachment[] = [];
    let currentAttachment: Partial<ParsedTnefAttachment> | null = null;

    const finishAttachment = () => {
        if (currentAttachment?.Data) {
            attachments.push({
                FileName: currentAttachment.FileName || "attachment",
                MimeType: currentAttachment.MimeType || "application/octet-stream",
                ContentId: currentAttachment.ContentId,
                Data: currentAttachment.Data
            });
        }
    };

    let offset = 6; // signature (4) + key (2)
    while (offset + 9 <= buffer.length) {
        const level = buffer.readUInt8(offset);
        const id = buffer.readUInt16LE(offset + 1);
        const length = buffer.readUInt32LE(offset + 5);
        offset += 9;

        if (offset + length + 2 > buffer.length) break;
        const attrData = buffer.subarray(offset, offset + length);
        offset += length + 2; // 属性の値 + チェックサム (2)

        if (level === 1) { // Message level
            if (id === ATT_OEMCODEPAGE && length >= 4) {
                encoding = CODEPAGE_ENCODINGS[attrData.readUInt32LE(0)] ?? null;
            } else if (id === ATT_SUBJECT) {
                const str = decodeTextBytes(attrData, encoding);
                if (str) subject = str;
            } else if (id === ATT_FROM) {
                const str = readTrpName(attrData, encoding);
                if (str) senderName = str;
            } else if (id === ATT_BODY) {
                const str = decodeTextBytes(attrData, encoding);
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
            } else if (id === ATT_MSGPROPS) {
                const mapi = parseMapiProperties(attrData, encoding);
                if (mapi.has(PR_SUBJECT) && !subject) {
                    subject = String(mapi.get(PR_SUBJECT));
                }
                if (mapi.has(PR_SENDER_NAME) && !senderName) {
                    senderName = String(mapi.get(PR_SENDER_NAME));
                }
                if (mapi.has(PR_BODY) && !body) {
                    body = String(mapi.get(PR_BODY));
                }
                const htmlVal = mapi.get(PR_HTML);
                if (htmlVal !== undefined) {
                    htmlBody = decodeHtmlProperty(htmlVal, readMapiInteger(mapi.get(PR_INTERNET_CPID)), encoding);
                }
                const rtfBytes = mapi.get(PR_RTF_COMPRESSED);
                if (rtfBytes instanceof Uint8Array) {
                    try {
                        const decompressed = Buffer.from(decompressRTF(Array.from(rtfBytes))).toString("latin1");
                        rtfBody = decompressed;
                        if (!htmlBody) htmlBody = extractHtmlFromRtf(decompressed);
                        if (!body && !htmlBody) {
                            body = extractPlainTextFromRtf(decompressed);
                        }
                    } catch {
                        // RTF解凍失敗時はスキップ
                    }
                }
            }
        } else if (level === 2) { // Attachment level
            if (id === ATT_ATTACHRENDDATA) {
                finishAttachment();
                currentAttachment = {};
            } else if (currentAttachment) {
                if (id === ATT_ATTACHTITLE) {
                    const name = decodeTextBytes(attrData, encoding);
                    if (name) currentAttachment.FileName = name;
                } else if (id === ATT_ATTACHDATA) {
                    currentAttachment.Data = new Uint8Array(attrData);
                } else if (id === ATT_ATTACHMENT) {
                    const attMapi = parseMapiProperties(attrData, encoding);
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

    finishAttachment();

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
