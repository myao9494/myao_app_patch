import { describe, expect, it } from 'vitest';
import {
  DROP_STICKY_COLORS,
  createDroppedFileStickyNote,
  extractEmailSubject,
  getFileType,
  resizeImage,
} from './dragDropUtils';

const fakeDataTransfer = (data: Record<string, string>) => ({
  types: Object.keys(data),
  getData: (type: string) => data[type] ?? '',
}) as unknown as DataTransfer;

describe('getFileType', () => {
  it('画像・メール・その他を判定する', () => {
    expect(getFileType(new File([''], 'a.png', { type: 'image/png' }))).toBe('image');
    expect(getFileType(new File([''], 'mail.EML'))).toBe('email');
    expect(getFileType(new File([''], 'mail.msg'))).toBe('email');
    expect(getFileType(new File([''], 'report.pdf', { type: 'application/pdf' }))).toBe('general');
  });
});

describe('resizeImage', () => {
  it('長辺が上限を超える場合だけ、縦横比を保って縮小する', () => {
    expect(resizeImage(800, 400, 400)).toEqual({ width: 400, height: 200 });
    expect(resizeImage(300, 900, 400)).toEqual({ width: 400 / 3, height: 400 });
    expect(resizeImage(200, 100, 400)).toEqual({ width: 200, height: 100 });
  });
});

describe('createDroppedFileStickyNote', () => {
  it('矩形とテキストの両方にリンクを設定し、テキストは矩形に結び付ける', () => {
    const [rect, text] = createDroppedFileStickyNote(100, 100, 'a.pdf', 'uploads/files/a_1.pdf') as any[];
    expect(rect.link).toBe('uploads/files/a_1.pdf');
    expect(text.link).toBe('uploads/files/a_1.pdf');
    expect(text.containerId).toBe(rect.id);
    expect(rect.boundElements).toEqual([{ type: 'text', id: text.id }]);
    expect(rect.backgroundColor).toBe(DROP_STICKY_COLORS.FILE.backgroundColor);
  });

  it('25文字を超える表示名は省略し、元の名前は originalText に残す', () => {
    const name = 'a-very-long-file-name-for-testing.pdf';
    const [, text] = createDroppedFileStickyNote(0, 0, name, 'x', DROP_STICKY_COLORS.EMAIL) as any[];
    expect(text.text).toBe(`${name.substring(0, 22)}...`);
    expect(text.originalText).toBe(name);
    expect(text.strokeColor).toBe(DROP_STICKY_COLORS.EMAIL.strokeColor);
  });
});

describe('extractEmailSubject', () => {
  it('プレーンテキストの1行目を件名にする', () => {
    expect(extractEmailSubject(fakeDataTransfer({ 'text/plain': '会議のお知らせ\n本文' })).subject).toBe('会議のお知らせ');
  });

  it('HTMLはスクリプトや画像の読み込みを実行せずにテキストだけを取り出す', () => {
    const html = '<img src="x" onerror="window.__dropXss = true"><p>件名です</p>';
    const { subject } = extractEmailSubject(fakeDataTransfer({ 'text/html': html }));
    expect(subject).toBe('件名です');
    expect((window as any).__dropXss).toBeUndefined();
  });
});
