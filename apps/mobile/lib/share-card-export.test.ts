import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';
import {
  captureShareCardPng,
  exportShareCardPng,
  isShareCardDismissal,
  ShareCardUnavailableError,
} from './share-card-export';

const nativeMocks = vi.hoisted(() => ({
  constructFile: vi.fn(),
  createFile: vi.fn(),
  deleteFile: vi.fn(),
  logInfo: vi.fn().mockResolvedValue(null),
  logWarn: vi.fn().mockResolvedValue(null),
  pixelRatio: vi.fn(() => 3),
  shareAsync: vi.fn().mockResolvedValue(undefined),
  sharingAvailable: vi.fn().mockResolvedValue(true),
  writeFile: vi.fn(),
}));

vi.mock('react-native', () => ({ PixelRatio: { get: nativeMocks.pixelRatio }, Platform: { OS: 'android' } }));
vi.mock('expo-sharing', () => ({
  isAvailableAsync: nativeMocks.sharingAvailable,
  shareAsync: nativeMocks.shareAsync,
}));
vi.mock('expo-file-system', () => ({
  Paths: { cache: { uri: 'file:///cache' } },
  File: class MockFile {
    uri: string;

    constructor(...uris: unknown[]) {
      nativeMocks.constructFile(...uris);
      // Faithfully model the app URL shim bug: Expo Paths.join drops later
      // segments when File receives a Directory plus filename.
      this.uri = uris.length === 1
        ? String(uris[0])
        : String((uris[0] as { uri?: string })?.uri);
    }

    create() {
      nativeMocks.createFile(this.uri);
    }

    write(content: string, options: unknown) {
      if (!nativeMocks.createFile.mock.calls.some(([uri]) => uri === this.uri)) {
        throw Object.assign(new Error('file must exist before write'), { code: 'ERR_INVALID_TYPE_FILE' });
      }
      nativeMocks.writeFile(content, options);
    }

    delete() {
      nativeMocks.deleteFile();
    }
  },
}));
vi.mock('./app-log', () => ({ logInfo: nativeMocks.logInfo, logWarn: nativeMocks.logWarn }));

const svgRef = (base64 = 'png-base64') => ({
  toDataURL: vi.fn((callback: (value: string) => void) => callback(base64)),
});

beforeEach(() => {
  nativeMocks.constructFile.mockReset();
  nativeMocks.createFile.mockReset();
  (Platform as { OS: string }).OS = 'android';
  nativeMocks.deleteFile.mockReset();
  nativeMocks.logInfo.mockReset().mockResolvedValue(null);
  nativeMocks.logWarn.mockReset().mockResolvedValue(null);
  nativeMocks.pixelRatio.mockReset().mockReturnValue(3);
  nativeMocks.shareAsync.mockReset().mockResolvedValue(undefined);
  nativeMocks.sharingAvailable.mockReset().mockResolvedValue(true);
  nativeMocks.writeFile.mockReset();
  vi.spyOn(Date, 'now').mockReturnValue(1234);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('share card PNG export', () => {
  it('captures at 1080px, shares a unique PNG, and records metadata only', async () => {
    const svg = svgRef();

    await expect(exportShareCardPng(svg as never, 'Share image')).resolves.toBe('share');

    expect(svg.toDataURL).toHaveBeenCalledWith(expect.any(Function), { width: 1080, height: 1080 });
    expect(nativeMocks.constructFile).toHaveBeenCalledWith('file:///cache/mindwtr-share-card-1234-0.png');
    expect(nativeMocks.createFile).toHaveBeenCalledWith('file:///cache/mindwtr-share-card-1234-0.png');
    expect(nativeMocks.writeFile).toHaveBeenCalledWith('png-base64', { encoding: 'base64' });
    expect(nativeMocks.shareAsync).toHaveBeenCalledWith(
      'file:///cache/mindwtr-share-card-1234-0.png',
      { dialogTitle: 'Share image', mimeType: 'image/png', UTI: 'public.png' },
    );
    // The chooser can resolve before the receiver has read the URI. The unique
    // cache file stays available for the receiving app and is OS-cache managed.
    expect(nativeMocks.deleteFile).not.toHaveBeenCalled();
    expect(nativeMocks.logInfo).toHaveBeenCalledWith('Share card export completed', {
      scope: 'share-card',
      extra: {
        releaseCheck: 'v1.3.0/share-card-export',
        cardKind: 'review',
        exportMethod: 'share',
      },
    });
    expect(nativeMocks.logWarn).not.toHaveBeenCalled();
  });

  it('does not reuse a cache URI when exports begin in the same millisecond', async () => {
    await exportShareCardPng(svgRef() as never, 'Share image');
    await exportShareCardPng(svgRef() as never, 'Share image');

    const firstUri = nativeMocks.shareAsync.mock.calls[0]?.[0];
    const secondUri = nativeMocks.shareAsync.mock.calls[1]?.[0];
    expect(firstUri).not.toBe(secondUri);
  });

  it('requests point dimensions that produce a 1080px iOS PNG at screen scale', async () => {
    (Platform as { OS: string }).OS = 'ios';
    const svg = svgRef();

    await captureShareCardPng(svg as never);

    expect(svg.toDataURL).toHaveBeenCalledWith(expect.any(Function), { width: 360, height: 360 });
  });

  it('uses the created cache PNG and public PNG UTI on iOS', async () => {
    (Platform as { OS: string }).OS = 'ios';

    await exportShareCardPng(svgRef() as never, 'Share image');

    const uri = nativeMocks.shareAsync.mock.calls[0]?.[0];
    expect(nativeMocks.createFile).toHaveBeenCalledWith(uri);
    expect(nativeMocks.writeFile).toHaveBeenCalledWith('png-base64', { encoding: 'base64' });
    expect(nativeMocks.shareAsync).toHaveBeenCalledWith(uri, {
      dialogTitle: 'Share image',
      mimeType: 'image/png',
      UTI: 'public.png',
    });
  });

  it('does not delete a path when native file creation rejects it', async () => {
    nativeMocks.createFile.mockImplementationOnce(() => {
      throw Object.assign(new Error('invalid file path'), { code: 'ERR_INVALID_TYPE_FILE' });
    });

    await expect(exportShareCardPng(svgRef() as never, 'Share image'))
      .rejects.toMatchObject({ code: 'ERR_INVALID_TYPE_FILE' });

    expect(nativeMocks.writeFile).not.toHaveBeenCalled();
    expect(nativeMocks.deleteFile).not.toHaveBeenCalled();
    expect(nativeMocks.logWarn).toHaveBeenLastCalledWith('Share card export failed', {
      scope: 'share-card',
      extra: expect.objectContaining({
        failureStage: 'create',
        errorType: 'Error',
        nativeCode: 'ERR_INVALID_TYPE_FILE',
      }),
    });
  });

  it('cleans up when writing or sharing fails', async () => {
    nativeMocks.writeFile.mockImplementationOnce(() => {
      throw new Error('write failed');
    });
    await expect(exportShareCardPng(svgRef() as never, 'Share image')).rejects.toThrow('write failed');
    expect(nativeMocks.deleteFile).toHaveBeenCalledOnce();
    expect(nativeMocks.logWarn).toHaveBeenLastCalledWith('Share card export failed', {
      scope: 'share-card',
      extra: {
        releaseCheck: 'v1.3.0/share-card-export',
        failureStage: 'write',
        errorType: 'Error',
        nativeCode: undefined,
      },
    });

    nativeMocks.shareAsync.mockRejectedValueOnce(new Error('share failed'));
    await expect(exportShareCardPng(svgRef() as never, 'Share image')).rejects.toThrow('share failed');
    expect(nativeMocks.deleteFile).toHaveBeenCalledTimes(2);
    expect(nativeMocks.logInfo).not.toHaveBeenCalled();
    expect(nativeMocks.logWarn).toHaveBeenLastCalledWith('Share card export failed', {
      scope: 'share-card',
      extra: expect.objectContaining({ failureStage: 'share', errorType: 'Error' }),
    });
  });

  it('reports unavailable capture or sharing without leaving a file', async () => {
    await expect(captureShareCardPng(null)).rejects.toBeInstanceOf(ShareCardUnavailableError);

    nativeMocks.sharingAvailable.mockResolvedValueOnce(false);
    await expect(exportShareCardPng(svgRef() as never, 'Share image'))
      .rejects.toBeInstanceOf(ShareCardUnavailableError);
    expect(nativeMocks.writeFile).not.toHaveBeenCalled();
    expect(nativeMocks.deleteFile).not.toHaveBeenCalled();
    expect(nativeMocks.logWarn).toHaveBeenLastCalledWith('Share card export failed', {
      scope: 'share-card',
      extra: expect.objectContaining({ failureStage: 'availability' }),
    });
  });

  it('bounds capture when the native callback never arrives', async () => {
    const stalled = { toDataURL: vi.fn() };
    await expect(captureShareCardPng(stalled as never, 1)).rejects.toBeInstanceOf(ShareCardUnavailableError);
  });

  it('recognizes platform dismissal errors', () => {
    expect(isShareCardDismissal(new Error('User cancelled'))).toBe(true);
    expect(isShareCardDismissal(Object.assign(new Error('Stopped'), { name: 'AbortError' }))).toBe(true);
    expect(isShareCardDismissal(new Error('Disk failed'))).toBe(false);
  });

  it('bounds an unresolved native share without deleting its receiver URI', async () => {
    nativeMocks.shareAsync.mockReturnValueOnce(new Promise(() => {}));

    await expect(exportShareCardPng(svgRef() as never, 'Share image', 1))
      .rejects.toMatchObject({ name: 'AbortError' });

    expect(nativeMocks.deleteFile).not.toHaveBeenCalled();
    expect(nativeMocks.logWarn).not.toHaveBeenCalled();
  });

  it('downloads locally on web without invoking the native share module', async () => {
    const click = vi.fn();
    const link = { click, download: '', href: '', rel: '' };
    vi.stubGlobal('document', { createElement: vi.fn(() => link) });
    (Platform as { OS: string }).OS = 'web';

    await expect(exportShareCardPng(svgRef('web-png') as never, 'Share image'))
      .resolves.toBe('download');

    expect(link.href).toBe('data:image/png;base64,web-png');
    expect(link.download).toBe('mindwtr-share-card.png');
    expect(click).toHaveBeenCalledOnce();
    expect(nativeMocks.sharingAvailable).not.toHaveBeenCalled();
    expect(nativeMocks.writeFile).not.toHaveBeenCalled();
  });
});
