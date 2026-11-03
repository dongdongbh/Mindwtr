import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  platform: { OS: 'ios' },
  nativeModule: {
    availability: vi.fn(),
    search: vi.fn(),
    cancel: vi.fn(),
  },
  requireOptionalNativeModule: vi.fn(),
}));

vi.mock('react-native', () => ({ Platform: mocks.platform }));
vi.mock('expo-modules-core', () => {
  mocks.requireOptionalNativeModule.mockReturnValue(mocks.nativeModule);
  return { requireOptionalNativeModule: mocks.requireOptionalNativeModule };
});


// eslint-disable-next-line import/first
import {
  cancelAppleTaskSearch,
  getAppleTaskSearchAvailability,
  searchAppleTasksNative,
} from './index';

describe('apple-task-search wrapper', () => {
  beforeEach(() => {
    vi.stubGlobal('__DEV__', true);
    mocks.platform.OS = 'ios';
    mocks.nativeModule.availability.mockReset().mockResolvedValue({ supported: true, reason: 'available' });
    mocks.nativeModule.search.mockReset().mockResolvedValue([]);
    mocks.nativeModule.cancel.mockReset().mockResolvedValue(undefined);
  });

  it('fails closed outside a development build', async () => {
    vi.stubGlobal('__DEV__', false);
    await expect(getAppleTaskSearchAvailability()).resolves.toEqual({
      supported: false,
      reason: 'development_only',
    });
  });

  it('returns capped real indexed ids and dedupes task ids without using titles as identity', async () => {
    mocks.nativeModule.search.mockResolvedValue([
      { indexedId: ' entity-opaque-1 ', taskId: ' task-1 ' },
      { indexedId: 'entity-opaque-2', taskId: 'task-1' },
      { indexedId: 'entity-opaque-3', taskId: 'task-2' },
      { indexedId: 'bad', taskId: '' },
      ...Array.from({ length: 60 }, (_, index) => ({
        indexedId: `entity-extra-${index}`,
        taskId: `task-extra-${index}`,
      })),
    ]);

    const matches = await searchAppleTasksNative('passport renewal');
    expect(matches).toHaveLength(50);
    expect(matches.slice(0, 2)).toEqual([
      { indexedId: 'entity-opaque-1', taskId: 'task-1' },
      { indexedId: 'entity-opaque-3', taskId: 'task-2' },
    ]);
    expect(mocks.nativeModule.search).toHaveBeenCalledWith(expect.any(String), 'passport renewal');
  });

  it('cancels native work and rejects a result delivered after abort', async () => {
    let resolveSearch!: (value: { indexedId: string; taskId: string }[]) => void;
    mocks.nativeModule.search.mockReturnValue(new Promise((resolve) => { resolveSearch = resolve; }));
    const controller = new AbortController();
    const pending = searchAppleTasksNative('renew passport', { signal: controller.signal });

    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    resolveSearch([{ indexedId: 'entity-1', taskId: 'task-1' }]);

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.nativeModule.cancel).toHaveBeenCalledTimes(1);
    expect(mocks.nativeModule.cancel).toHaveBeenCalledWith(
      mocks.nativeModule.search.mock.calls[0][0],
    );
  });

  it('exposes explicit cancellation for unmount and replacement-query cleanup', async () => {
    let resolveSearch!: (value: { indexedId: string; taskId: string }[]) => void;
    mocks.nativeModule.search.mockReturnValue(new Promise((resolve) => { resolveSearch = resolve; }));
    const pending = searchAppleTasksNative('renew passport');
    await vi.waitFor(() => expect(mocks.nativeModule.search).toHaveBeenCalledTimes(1));

    await cancelAppleTaskSearch();
    expect(mocks.nativeModule.cancel).toHaveBeenCalledWith(
      mocks.nativeModule.search.mock.calls[0][0],
    );
    resolveSearch([]);
    await expect(pending).resolves.toEqual([]);
  });
});
