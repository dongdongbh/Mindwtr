import { beforeEach, describe, expect, it, vi } from 'vitest';

const nativeModuleMock = vi.hoisted(() => ({
  createBookmark: vi.fn(),
  resolveBookmark: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
}));

vi.mock('expo-modules-core', () => ({
  requireNativeModule: vi.fn(() => nativeModuleMock),
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

vi.mock('./app-log', () => ({
  logWarn: vi.fn(),
}));

describe('sync-path-bookmarks wrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves a bookmark to a uri and optional refreshed bookmark', async () => {
    nativeModuleMock.resolveBookmark.mockResolvedValue({
      uri: 'file:///resolved/data.json',
      refreshedBookmark: 'fresh-token',
    });
    const { resolveSyncPathBookmark } = await import('./sync-path-bookmarks');

    await expect(resolveSyncPathBookmark('stale-token')).resolves.toEqual({
      uri: 'file:///resolved/data.json',
      refreshedBookmark: 'fresh-token',
    });
  });

  it('returns null and logs when native bookmark resolution fails', async () => {
    nativeModuleMock.resolveBookmark.mockRejectedValue(new Error('boom'));
    const { resolveSyncPathBookmark } = await import('./sync-path-bookmarks');

    await expect(resolveSyncPathBookmark('token')).resolves.toBeNull();
  });

  it('reads and writes sync file text through the native module', async () => {
    nativeModuleMock.readTextFile.mockResolvedValue('{"tasks":[]}');
    const {
      readBookmarkedSyncFileText,
      writeBookmarkedSyncFileText,
      supportsBookmarkedSyncFileIO,
    } = await import('./sync-path-bookmarks');

    expect(supportsBookmarkedSyncFileIO()).toBe(true);
    await expect(readBookmarkedSyncFileText('token')).resolves.toBe('{"tasks":[]}');
    await writeBookmarkedSyncFileText('token', '{"projects":[]}');
    expect(nativeModuleMock.writeTextFile).toHaveBeenCalledWith('token', '{"projects":[]}');
  });

  it('logs a failed bookmark create or resolve by the error name, never its text', async () => {
    const privatePath = 'file:///private/var/mobile/Containers/Shared/AppGroup/private-folder/data.json';
    nativeModuleMock.createBookmark.mockRejectedValue(new Error(`The file "${privatePath}" couldn't be opened.`));
    nativeModuleMock.resolveBookmark.mockRejectedValue(new Error(`NSFilePath=${privatePath}`));
    const { createSyncPathBookmark, resolveSyncPathBookmark } = await import('./sync-path-bookmarks');
    const { logWarn } = await import('./app-log');

    await expect(createSyncPathBookmark(privatePath)).resolves.toBeNull();
    await expect(resolveSyncPathBookmark('token')).resolves.toBeNull();

    expect(vi.mocked(logWarn).mock.calls.map(([, context]) => context)).toEqual([
      { scope: 'sync', extra: { error: 'Error' } },
      { scope: 'sync', extra: { error: 'Error' } },
    ]);
    expect(JSON.stringify(vi.mocked(logWarn).mock.calls)).not.toContain('private-folder');
  });
});
