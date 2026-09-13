/**
 * TNEF（winmail.dat）およびリッチテキスト（RTF）デコーダーの動作を検証するテスト
 **/
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { parseTnefBinary, extractPlainTextFromRtf } from './tnefParser';

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
        const data = Buffer.from(options.from + '\0', 'utf8');
        chunks.push(createTnefAttribute(1, 0x8000, 0x0001, data));
    }
    if (options.body) {
        const data = Buffer.from(options.body + '\0', 'utf8');
        chunks.push(createTnefAttribute(1, 0x800C, 0x0002, data));
    }

    if (options.attachments) {
        for (const att of options.attachments) {
            // renddata marker
            chunks.push(createTnefAttribute(2, 0x9003, 0x0002, Buffer.alloc(14)));
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
});
