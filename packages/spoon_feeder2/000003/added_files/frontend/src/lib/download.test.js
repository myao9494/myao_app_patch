import { describe, expect, it } from 'vitest';
import { imageExtension } from './download';

describe('imageExtension', () => {
  it('PNGのData URLはpng、それ以外(JPEG)はjpgにする', () => {
    expect(imageExtension('data:image/png;base64,AAA')).toBe('png');
    expect(imageExtension('data:image/jpeg;base64,AAA')).toBe('jpg');
  });
});
