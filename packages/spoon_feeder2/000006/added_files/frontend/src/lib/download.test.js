import { describe, expect, it } from 'vitest';
import { dataUrlToBlob, partFileName } from './download';

describe('dataUrlToBlob', () => {
  it('Base64のData URLをMIMEタイプとバイト列を保ったBlobへ変換する', async () => {
    const blob = dataUrlToBlob(`data:application/pdf;base64,${btoa('%PDF-1.4')}`);
    expect(blob.type).toBe('application/pdf');
    expect(await blob.text()).toBe('%PDF-1.4');
  });
});

describe('partFileName', () => {
  it('分割なしは拡張子だけ、分割ありは_partNofMを付ける', () => {
    expect(partFileName('repo_context', 1, 1, 'md')).toBe('repo_context.md');
    expect(partFileName('repo_context', 2, 3, 'md')).toBe('repo_context_part2of3.md');
  });
});
