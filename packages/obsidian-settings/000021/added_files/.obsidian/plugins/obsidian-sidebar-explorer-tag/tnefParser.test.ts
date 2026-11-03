/**
 * TNEF（winmail.dat）およびリッチテキスト（RTF）デコーダーの動作を検証するテスト
 **/
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { parseTnefBinary, extractPlainTextFromRtf, extractHtmlFromRtf } from './tnefParser';

function calcTnefChecksum(data: Uint8Array): number {
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
        sum = (sum + data[i]) & 0xFFFF;
    }
    return sum;
}

function createTnefAttribute(level: number, id: number, type: number, data: Uint8Array): Buffer {
    const header = Buffer.alloc(9);
    header.writeUInt8(level, 0);
    header.writeUInt16LE(id, 1);
    header.writeUInt16LE(type, 3);
    header.writeUInt32LE(data.length, 5);

    const checksumBuf = Buffer.alloc(2);
    checksumBuf.writeUInt16LE(calcTnefChecksum(data), 0);

    return Buffer.concat([header, Buffer.from(data), checksumBuf]);
}

// attFrom の形（TRP）: 種類、全体の長さ、名前の長さ、アドレスの長さのあとに、名前とアドレス
function createTrp(name: Buffer): Buffer {
    const address = Buffer.from('taro@example.com\0', 'utf8');
    const header = Buffer.alloc(8);
    header.writeUInt16LE(0x0004, 0);
    header.writeUInt16LE(8 + name.length + address.length, 2);
    header.writeUInt16LE(name.length, 4);
    header.writeUInt16LE(address.length, 6);
    return Buffer.concat([header, name, address]);
}

// 可変長のMAPIプロパティ: 種類、ID、値の個数、長さ、値（4バイト境界まで埋める）
function mapiVariable(type: number, id: number, value: Buffer): Buffer {
    const head = Buffer.alloc(12);
    head.writeUInt16LE(type, 0);
    head.writeUInt16LE(id, 2);
    head.writeUInt32LE(1, 4);
    head.writeUInt32LE(value.length, 8);
    return Buffer.concat([head, value, Buffer.alloc(-value.length & 3)]);
}

function mapiInt(id: number, value: number): Buffer {
    const prop = Buffer.alloc(8);
    prop.writeUInt16LE(0x0003, 0);
    prop.writeUInt16LE(id, 2);
    prop.writeUInt32LE(value, 4);
    return prop;
}

function mapiList(props: Buffer[]): Buffer {
    const count = Buffer.alloc(4);
    count.writeUInt32LE(props.length, 0);
    return Buffer.concat([count, ...props]);
}

const utf16 = (text: string) => Buffer.from(text + '\0', 'utf16le');

function tnefStream(attributes: Buffer[]): Buffer {
    return Buffer.concat([Buffer.from([0x78, 0x9f, 0x3e, 0x22, 0x01, 0x00]), ...attributes]);
}

function oemCodepage(codepage: number): Buffer {
    const data = Buffer.alloc(8);
    data.writeUInt32LE(codepage, 0);
    return createTnefAttribute(1, 0x9007, 0x0006, data);
}

function createMockTnef(options: {
    subject?: string;
    from?: string;
    body?: string;
    attachments?: Array<{ name: string; data: Uint8Array }>;
}): Buffer {
    const signature = Buffer.from([0x78, 0x9f, 0x3e, 0x22]); // 0x223E9F78
    const key = Buffer.from([0x01, 0x00]); // 0x0001

    const chunks = [signature, key];

    if (options.subject) {
        const data = Buffer.from(options.subject + '\0', 'utf8');
        chunks.push(createTnefAttribute(1, 0x8004, 0x0001, data));
    }
    if (options.from) {
        chunks.push(createTnefAttribute(1, 0x8000, 0x0006, createTrp(Buffer.from(options.from + '\0', 'utf8'))));
    }
    if (options.body) {
        const data = Buffer.from(options.body + '\0', 'utf8');
        chunks.push(createTnefAttribute(1, 0x800C, 0x0002, data));
    }

    if (options.attachments) {
        for (const att of options.attachments) {
            // renddata marker
            chunks.push(createTnefAttribute(2, 0x9002, 0x0002, Buffer.alloc(14)));
            // filename
            const nameBuf = Buffer.from(att.name + '\0', 'utf8');
            chunks.push(createTnefAttribute(2, 0x8010, 0x0001, nameBuf));
            // data
            chunks.push(createTnefAttribute(2, 0x800F, 0x0007, att.data));
        }
    }

    return Buffer.concat(chunks);
}

describe('TNEF and RTF parser', () => {
    it('1. TNEFバイナリから件名、送信者、本文、添付ファイルが正しく抽出されること', async () => {
        const pngData = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        const mockTnef = createMockTnef({
            subject: 'TNEF重要連絡',
            from: '山田 太郎',
            body: 'TNEF形式で送信された本文です。\nご確認お願いします。',
            attachments: [
                { name: 'diagram.png', data: pngData }
            ]
        });

        const result = parseTnefBinary(mockTnef);
        assert.ok(result, 'TNEFの解析結果がnullです');
        assert.strictEqual(result!.Subject, 'TNEF重要連絡');
        assert.strictEqual(result!.SenderName, '山田 太郎');
        assert.ok(result!.Body.includes('TNEF形式で送信された本文です。'));
        assert.strictEqual(result!.Attachments.length, 1);
        assert.strictEqual(result!.Attachments[0].FileName, 'diagram.png');
        assert.deepStrictEqual(result!.Attachments[0].Data, pngData);
    });

    it('2. 純粋なRTFドキュメントから日本語Shift-JIS制御語を除去してプレーンテキストを抽出できること', () => {
        // 「お疲れ様です。\nよろしくお願いいたします。」のShift-JIS 16進表現を含むRTF
        // お: 82 a8, 疲: 94 e6, れ: 82 ea, 様: 97 6c, で: 82 c5, す: 82 b7, 。: 81 42
        const rawRtf = '{\\rtf1\\ansi\\ansicpg932\\deff0{\\fonttbl{\\f0\\fnil\\fcharset128\\fprq1\\cpg932 MS Gothic;}}\n' +
            '{\\colortbl ;\\red0\\green0\\blue0;}\n' +
            '\\viewkind4\\uc1\\pard\\cf1\\lang1041\\f0\\fs22 ' +
            '\\\'82\\\'a8\\\'94\\\'e6\\\'82\\\'ea\\\'97\\\'6c\\\'82\\\'c5\\\'82\\\'b7\\\'81\\\'42\\par\n' +
            'よろしくお願いいたします。\\par\n' +
            '}';

        const text = extractPlainTextFromRtf(rawRtf);
        assert.ok(text.includes('お疲れ様です。'), `抽出テキストに含まれていません: ${text}`);
        assert.ok(text.includes('よろしくお願いいたします。'), `抽出テキストに含まれていません: ${text}`);
        assert.ok(!text.includes('fonttbl'), `fonttbl が残っています: ${text}`);
        assert.ok(!text.includes('ansicpg'), `ansicpg が残っています: ${text}`);
    });

    it('3. 無効なシグネチャのバイナリではnullを返すこと（異常系）', () => {
        const invalid = Buffer.from([0x00, 0x01, 0x02, 0x03]);
        const result = parseTnefBinary(invalid);
        assert.strictEqual(result, null);
    });

    it('4. RTF内のテーブル構造（\\trowd ... \\cell ... \\row）がMarkdownテーブルに変換されること', () => {
        const rawRtfWithTable = '{\\rtf1\\ansi\\deff0\n' +
            '\\pard 以下は進捗表です。\\par\n' +
            '\\trowd\\cellx2000\\cellx4000\n' +
            '項目\\cell 担当\\cell\\row\n' +
            '\\trowd\\cellx2000\\cellx4000\n' +
            '設計\\cell 山田\\cell\\row\n' +
            '\\trowd\\cellx2000\\cellx4000\n' +
            '実装\\cell 田中\\cell\\row\n' +
            '\\pard 以上よろしくお願いします。\\par\n' +
            '}';

        const text = extractPlainTextFromRtf(rawRtfWithTable);
        assert.ok(text.includes('以下は進捗表です。'), `抽出テキストに含まれていません: ${text}`);
        assert.ok(text.includes('| 項目 | 担当 |'), `Markdownテーブルヘッダーが含まれていません: ${text}`);
        assert.ok(text.includes('| --- | --- |'), `Markdownテーブル区切りが含まれていません: ${text}`);
        assert.ok(text.includes('| 設計 | 山田 |'), `Markdownテーブル行1が含まれていません: ${text}`);
        assert.ok(text.includes('| 実装 | 田中 |'), `Markdownテーブル行2が含まれていません: ${text}`);
        assert.ok(text.includes('以上よろしくお願いします。'), `末尾テキストが含まれていません: ${text}`);
    });

    it('5. ダッシュ記号（\\emdash / \\endash）を文字として出力すること', () => {
        assert.strictEqual(extractPlainTextFromRtf('{\\rtf1 a\\emdash b\\endash c\\par}'), 'a—b–c');
    });

    it('6. Unicodeエスケープ（\\uN）の直後の区切りの空白、または代替文字「?」を出力に残さないこと', () => {
        assert.strictEqual(extractPlainTextFromRtf('{\\rtf1\\uc0 \\u26085 \\u26412 \\par}'), '日本');
        assert.strictEqual(extractPlainTextFromRtf('{\\rtf1 \\u26085?\\u26412?\\par}'), '日本');
        // 負数表記（65536 を足した文字コード）
        assert.strictEqual(extractPlainTextFromRtf('{\\rtf1 \\u-28711?\\par}'), String.fromCharCode(65536 - 28711));
    });

    it('7. RTFソース内の生の改行（書式上の折り返し）を本文の改行として扱わないこと', () => {
        assert.strictEqual(extractPlainTextFromRtf('{\\rtf1 first\r\nsame\\par\r\nsecond\\par}'), 'firstsame\nsecond');
    });

    it('8. RTFではない入力には空文字を返すこと', () => {
        assert.strictEqual(extractPlainTextFromRtf('抽出済みの本文'), '');
        assert.strictEqual(extractPlainTextFromRtf(''), '');
    });
});

describe('実際の winmail.dat の形式（MS-OXTNEF）', () => {
    const SJIS_TEST = Buffer.from([0x83, 0x65, 0x83, 0x58, 0x83, 0x67, 0x00]); // テスト
    const SJIS_YAMADA = Buffer.from([0x8e, 0x52, 0x93, 0x63, 0x00]); // 山田
    const SJIS_SHIRYO = Buffer.from([0x8e, 0x91, 0x97, 0xbf, 0x2e, 0x74, 0x78, 0x74, 0x00]); // 資料.txt

    it('属性の文字列を attOemCodepage の文字コードで読むこと', () => {
        const dateSent = Buffer.alloc(14);
        [2026, 11, 1, 9, 5, 7, 0].forEach((value, index) => dateSent.writeUInt16LE(value, index * 2));
        const result = parseTnefBinary(tnefStream([
            oemCodepage(932),
            createTnefAttribute(1, 0x8000, 0x0006, createTrp(SJIS_YAMADA)),
            createTnefAttribute(1, 0x8004, 0x0001, SJIS_TEST),
            createTnefAttribute(1, 0x8005, 0x0003, dateSent),
        ]));
        assert.strictEqual(result!.Subject, 'テスト');
        assert.strictEqual(result!.SenderName, '山田');
        assert.strictEqual(result!.SentOn, '2026-11-01 09:05:07');
    });

    it('attMsgProps（0x9003）から本文とHTMLを読むこと', () => {
        const props = mapiList([
            mapiInt(0x0E07, 8),
            mapiVariable(0x001F, 0x0037, utf16('MAPIの件名')),
            mapiVariable(0x001F, 0x0C1A, utf16('MAPIの送信者')),
            mapiVariable(0x001F, 0x1000, utf16('MAPIの本文')),
            mapiInt(0x3FDE, 65001),
            mapiVariable(0x0102, 0x1013, Buffer.from('<p>本文</p>', 'utf8')),
        ]);
        const result = parseTnefBinary(tnefStream([createTnefAttribute(1, 0x9003, 0x0006, props)]));
        assert.strictEqual(result!.Subject, 'MAPIの件名');
        assert.strictEqual(result!.SenderName, 'MAPIの送信者');
        assert.strictEqual(result!.Body, 'MAPIの本文');
        assert.strictEqual(result!.HtmlBody, '<p>本文</p>');
    });

    it('添付は attAttachRendData（0x9002）で始まり、attAttachment（0x9005）で名前と種類を上書きすること', () => {
        const data = Buffer.from([1, 2, 3]);
        const result = parseTnefBinary(tnefStream([
            oemCodepage(932),
            createTnefAttribute(2, 0x9002, 0x0006, Buffer.alloc(14)),
            createTnefAttribute(2, 0x8010, 0x0001, SJIS_SHIRYO),
            createTnefAttribute(2, 0x800F, 0x0006, data),
            createTnefAttribute(2, 0x9005, 0x0006, mapiList([
                mapiVariable(0x001F, 0x3707, utf16('長い名前の資料.png')),
                mapiVariable(0x001E, 0x370E, Buffer.from('image/png\0', 'latin1')),
                mapiVariable(0x001F, 0x3712, utf16('<image001@x>')),
            ])),
            createTnefAttribute(2, 0x9002, 0x0006, Buffer.alloc(14)),
            createTnefAttribute(2, 0x8010, 0x0001, SJIS_SHIRYO),
            createTnefAttribute(2, 0x800F, 0x0006, data),
        ]));
        assert.strictEqual(result!.Attachments.length, 2);
        assert.strictEqual(result!.Attachments[0].FileName, '長い名前の資料.png');
        assert.strictEqual(result!.Attachments[0].MimeType, 'image/png');
        assert.strictEqual(result!.Attachments[0].ContentId, 'image001@x');
        assert.strictEqual(result!.Attachments[1].FileName, '資料.txt');
    });
});

describe('RTF の細部', () => {
    it('行ごとに \\pard\\intbl が付いた表を1つの表にすること', () => {
        const text = extractPlainTextFromRtf('{\\rtf1\\ansi\\trowd\\cellx1\\pard\\intbl A\\cell B\\cell\\row\\trowd\\pard\\intbl C\\cell D\\cell\\row\\pard after\\par}');
        assert.strictEqual(text, '| A | B |\n| --- | --- |\n| C | D |\n\nafter');
    });

    it('セルの中の改行で表を壊さないこと', () => {
        const text = extractPlainTextFromRtf('{\\rtf1\\ansi\\trowd\\pard\\intbl A1\\par A2\\cell B\\cell\\row\\trowd\\pard\\intbl C\\cell D\\cell\\row\\pard\\par}');
        assert.ok(text.includes('| A1 A2 | B |'), text);
        assert.ok(text.includes('| C | D |'), text);
    });

    it('\\uN の代わりの文字（\\ucN バイト分）を重ねて出力しないこと', () => {
        assert.strictEqual(extractPlainTextFromRtf("{\\rtf1\\ansicpg932\\uc2 \\u12354\\'82\\'a0\\par}"), 'あ');
        assert.strictEqual(extractPlainTextFromRtf("{\\rtf1\\ansicpg932\\uc1 \\u12354\\'3f い\\par}"), 'あ い');
    });

    it('Shift-JIS の2バイト目が文字のまま書かれていても読めること', () => {
        assert.strictEqual(extractPlainTextFromRtf("{\\rtf1\\ansicpg932 \\'83e\\'83X\\'83g\\par}"), 'テスト');
        assert.strictEqual(extractPlainTextFromRtf("{\\rtf1\\ansicpg932 \\'83\\\\\\'83t\\par}"), 'ソフ');
    });

    it('引用符などの制御語を文字として出力すること', () => {
        assert.strictEqual(extractPlainTextFromRtf('{\\rtf1 don\\rquote t \\ldblquote x\\rdblquote  \\bullet\\par}'), 'don’t “x” •');
    });

    it('\\ansicpg1252 でも日本語フォントがあれば Shift-JIS として読むこと', () => {
        assert.strictEqual(extractPlainTextFromRtf("{\\rtf1\\ansi\\ansicpg1252{\\fonttbl{\\f0\\fcharset128 MS Gothic;}}\\f0 \\'82\\'a0\\par}"), 'あ');
    });

    it('コードページの指定が無ければ windows-1252 として読むこと', () => {
        assert.strictEqual(extractPlainTextFromRtf("{\\rtf1\\ansi caf\\'e9\\par}"), 'café');
    });

    it('スキップするグループの中のエスケープした括弧でグループを終わらせないこと', () => {
        assert.strictEqual(extractPlainTextFromRtf('{\\rtf1{\\info a\\}b}本文\\par}'), '本文');
    });

    it('\\htmlrtf で抑止された部分を出力しないこと', () => {
        assert.strictEqual(extractPlainTextFromRtf('{\\rtf1\\fromhtml1 本文\\htmlrtf 抑止\\htmlrtf0 続き\\par}'), '本文続き');
    });
});

describe('RTF にカプセル化された HTML（extractHtmlFromRtf）', () => {
    const wrap = (body: string) => '{\\rtf1\\ansi\\ansicpg932\\fromhtml1 \\deff0{\\fonttbl{\\f0\\fcharset128 MS PGothic;}}\r\n' + body + '}';

    it('タグの外にある本文も HTML に含めること', () => {
        const html = extractHtmlFromRtf(wrap("{\\*\\htmltag19 <html>}{\\*\\htmltag50 <body>}{\\*\\htmltag84 <p>}\\htmlrtf {\\htmlrtf0 \\'82\\'a0本文{\\*\\htmltag92 </p>}\\htmlrtf \\par}\\htmlrtf0 {\\*\\htmltag58 </body>}{\\*\\htmltag27 </html>}"));
        assert.strictEqual(html, '<html><body><p>あ本文</p></body></html>');
    });

    it('表のセルの文字を残すこと', () => {
        const html = extractHtmlFromRtf(wrap('{\\*\\htmltag96 <table>}{\\*\\htmltag96 <tr>}{\\*\\htmltag96 <td>}\\htmlrtf \\intbl\\htmlrtf0 項目{\\*\\htmltag104 </td>}\\htmlrtf \\cell\\htmlrtf0 {\\*\\htmltag96 </tr>}\\htmlrtf \\row\\htmlrtf0 {\\*\\htmltag96 </table>}'));
        assert.strictEqual(html, '<table><tr><td>項目</td></tr></table>');
    });

    it('タグの中のエスケープと改行を戻し、mhtmltag を無視すること', () => {
        const html = extractHtmlFromRtf(wrap('{\\*\\htmltag84 <a href="a\\{b\\}">}{\\*\\mhtmltag84 <a href="cid:x">}{\\*\\htmltag92 </a>}\\par {\\*\\htmltag0 x\\tab y}'));
        assert.strictEqual(html, '<a href="a{b}"></a>\r\nx\ty');
    });

    it('本文の特殊文字を HTML のまま残すこと', () => {
        assert.strictEqual(extractHtmlFromRtf(wrap('{\\*\\htmltag84 <p>}a\\~b\\rquote c{\\*\\htmltag92 </p>}')), '<p>a b’c</p>');
    });

    it('HTML から作られた RTF でなければ空を返すこと', () => {
        assert.strictEqual(extractHtmlFromRtf('{\\rtf1\\ansi 本文\\par}'), '');
    });
});
