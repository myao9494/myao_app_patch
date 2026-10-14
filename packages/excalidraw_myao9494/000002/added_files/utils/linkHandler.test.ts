import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  REDIRECT_SERVICE_BASE_URL,
  handleStickyNoteLink,
  openPathWithFallback,
} from './linkHandler';

const createPopup = () => ({
  location: { href: '' },
  closed: false,
  close: vi.fn(),
}) as unknown as Window;

describe('openPathWithFallback', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('port 8001が応答する場合はリダイレクトサービスを優先する', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({} as Response);
    const popup = createPopup();

    const method = await openPathWithFallback('/tmp/test file.pdf', popup);

    expect(method).toBe('redirect-service');
    expect(fetchMock).toHaveBeenCalledWith(
      `${REDIRECT_SERVICE_BASE_URL}/api/config`,
      expect.objectContaining({ method: 'GET', mode: 'no-cors' }),
    );
    expect(popup.location.href).toBe(
      `${REDIRECT_SERVICE_BASE_URL}/api/open-path?path=%2Ftmp%2Ftest%20file.pdf`,
    );
    expect(popup.close).not.toHaveBeenCalled();
  });

  it('port 8001がない場合は同梱FastAPIのOSハンドラーへフォールバックする', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('connection refused'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, targetType: 'file' }),
      } as Response);
    const popup = createPopup();

    const method = await openPathWithFallback('/tmp/test.pdf', popup);

    expect(method).toBe('system-handler');
    expect(popup.close).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenLastCalledWith('/api/open-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filepath: '/tmp/test.pdf' }),
    });
  });
});

describe('handleStickyNoteLink', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('cmdリンクは図面のフォルダを作業ディレクトリとしてコマンド実行する', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, command: 'python a.py' }),
    } as Response);

    await handleStickyNoteLink('cmd python &quot;a b.py&quot;', 'C:\\work\\dir');

    expect(fetchMock).toHaveBeenCalledWith('/api/run-command', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ command: 'cmd python "a b.py"', working_directory: 'C:/work/dir' }),
    }));
  });

  it('相対パスのExcalidrawリンクは図面のフォルダ基準で新しいタブに開く', async () => {
    window.history.pushState({}, '', '/?filepath=%2Fwork%2Fmain.excalidraw');
    const openMock = vi.spyOn(window, 'open').mockReturnValue(null);

    await handleStickyNoteLink('../other/sub.excalidraw', '/work/dir');

    const openedUrl = new URL(openMock.mock.calls[0][0] as string);
    expect(openedUrl.searchParams.get('filepath')).toBe('/work/other/sub.excalidraw');
    expect(openMock.mock.calls[0][1]).toBe('_blank');
  });

  it('http(s)リンクはそのまま新しいタブで開く', async () => {
    const openMock = vi.spyOn(window, 'open').mockReturnValue(null);

    await handleStickyNoteLink('  https://example.com/a  ');

    expect(openMock).toHaveBeenCalledWith('https://example.com/a', '_blank');
  });

  it('obsidian:// はバックエンドのopen-urlに渡す', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response);

    await handleStickyNoteLink('obsidian://open?vault=v&file=a');

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/open-url?url=${encodeURIComponent('obsidian://open?vault=v&file=a')}`,
    );
  });
});
