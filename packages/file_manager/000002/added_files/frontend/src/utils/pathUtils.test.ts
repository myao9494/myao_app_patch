import { describe, it, expect } from 'vitest';
import { formatPathForClipboard, getParentDirectory, isAbsolutePath, resolvePath } from './pathUtils';

describe('formatPathForClipboard', () => {
    it('should format simple absolute path', () => {
        const input = "/Users/mine/test";
        expect(formatPathForClipboard(input)).toBe("/Users/mine/test");
    });

    it('should format simple relative path', () => {
        const input = "test/file.txt";
        expect(formatPathForClipboard(input)).toBe("test/file.txt");
    });

    it('should convert Windows-like path starting with /C:/ to C:\\', () => {
        const input = "/C:/Users/mine";
        expect(formatPathForClipboard(input)).toBe("C:\\Users\\mine");
    });

    it('should convert Windows-like path starting with /d:/ to D:\\ (case insensitive drive letter)', () => {
        const input = "/d:/Data";
        expect(formatPathForClipboard(input)).toBe("D:\\Data");
    });

    it('should convert path with backslashes to Windows format if it looks like Windows path', () => {
        // This case might be tricky. If it already has backslashes, it might be fine, but we generally want to standardize based on the request.
        // The request says "replace / with \".
        const input = "C:/Users/mine";
        expect(formatPathForClipboard(input)).toBe("C:\\Users\\mine");
    });

    it('should handle UNC paths (starting with //)', () => {
        const input = "//server/share/file";
        expect(formatPathForClipboard(input)).toBe("\\\\server\\share\\file");
    });

    it('should handle mixed slashes in Windows path', () => {
        const input = "C:\\Users/mine";
        expect(formatPathForClipboard(input)).toBe("C:\\Users\\mine");
    });
});

describe('getParentDirectory', () => {
    it('returns parent directory for POSIX absolute file path', () => {
        expect(getParentDirectory('/Users/mine/000_work/temp/test/aaa.md')).toBe('/Users/mine/000_work/temp/test');
    });

    it('returns parent directory for POSIX directory path with trailing slash', () => {
        expect(getParentDirectory('/Users/mine/000_work/temp/test/')).toBe('/Users/mine/000_work/temp');
    });

    it('returns root for root-level file', () => {
        expect(getParentDirectory('/file.txt')).toBe('/');
    });

    it('returns parent directory for Windows absolute path', () => {
        expect(getParentDirectory('C:\\Users\\mine\\Documents\\note.md')).toBe('C:/Users/mine/Documents');
        expect(getParentDirectory('C:/Users/mine/Documents/note.md')).toBe('C:/Users/mine/Documents');
    });

    it('returns parent directory for Windows UNC path', () => {
        expect(getParentDirectory('\\\\server\\share\\folder\\doc.md')).toBe('//server/share/folder');
        expect(getParentDirectory('//server/share/folder/doc.md')).toBe('//server/share/folder');
    });

    it('returns empty string for single file name or empty string', () => {
        expect(getParentDirectory('aaa.md')).toBe('');
        expect(getParentDirectory('')).toBe('');
    });
});

describe('isAbsolutePath', () => {
    it('detects POSIX absolute path', () => {
        expect(isAbsolutePath('/Users/mine')).toBe(true);
        expect(isAbsolutePath('relative/path')).toBe(false);
        expect(isAbsolutePath('./relative/path')).toBe(false);
    });

    it('detects Windows absolute path', () => {
        expect(isAbsolutePath('C:\\Users\\mine')).toBe(true);
        expect(isAbsolutePath('d:/data')).toBe(true);
    });

    it('detects UNC path', () => {
        expect(isAbsolutePath('\\\\server\\share')).toBe(true);
        expect(isAbsolutePath('//server/share')).toBe(true);
    });
});

describe('resolvePath', () => {
    it('resolves relative path with POSIX base directory', () => {
        expect(resolvePath('/Users/mine/000_work/temp/test', 'image.png')).toBe('/Users/mine/000_work/temp/test/image.png');
        expect(resolvePath('/Users/mine/000_work/temp/test', './image.png')).toBe('/Users/mine/000_work/temp/test/image.png');
        expect(resolvePath('/Users/mine/000_work/temp/test', '../images/pic.png')).toBe('/Users/mine/000_work/temp/images/pic.png');
    });

    it('resolves relative path with Windows base directory', () => {
        expect(resolvePath('C:\\Users\\mine\\temp', 'image.png')).toBe('C:/Users/mine/temp/image.png');
        expect(resolvePath('C:/Users/mine/temp', './sub/image.png')).toBe('C:/Users/mine/temp/sub/image.png');
    });

    it('resolves relative path with UNC base directory', () => {
        expect(resolvePath('\\\\server\\share\\docs', 'image.png')).toBe('//server/share/docs/image.png');
    });

    it('returns relativePath if it is already absolute', () => {
        expect(resolvePath('/Users/mine/base', '/Users/other/image.png')).toBe('/Users/other/image.png');
        expect(resolvePath('C:/base', 'D:/other/image.png')).toBe('D:/other/image.png');
    });

    it('returns relativePath as-is if baseDir is empty', () => {
        expect(resolvePath('', 'image.png')).toBe('image.png');
    });
});

