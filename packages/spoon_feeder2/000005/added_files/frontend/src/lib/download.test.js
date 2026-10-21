import { describe, expect, it } from 'vitest';
import { imageExtension, partFileName } from './download';

describe('imageExtension', () => {
  it('PNGのData URLはpng、それ以外(JPEG)はjpgにする', () => {
    expect(imageExtension('data:image/png;base64,AAA')).toBe('png');
    expect(imageExtension('data:image/jpeg;base64,AAA')).toBe('jpg');
  });
});

describe('partFileName', () => {
  it('分割なしは拡張子だけ、分割ありは_partNofMを付ける', () => {
    expect(partFileName('repo_context', 1, 1, 'md')).toBe('repo_context.md');
    expect(partFileName('repo_context', 2, 3, 'md')).toBe('repo_context_part2of3.md');
  });
});
