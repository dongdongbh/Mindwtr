import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  platform: { OS: 'android' },
  nativeModule: null as null | {
    getCapability: ReturnType<typeof vi.fn>;
    downloadModel: ReturnType<typeof vi.fn>;
    clarifyInbox: ReturnType<typeof vi.fn>;
    cancelRequest: ReturnType<typeof vi.fn>;
  },
  throwOnLoad: false,
}));

vi.mock('react-native', () => ({ Platform: mocks.platform }));
vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: () => {
    if (mocks.throwOnLoad) throw new Error('native registry unavailable');
    return mocks.nativeModule;
  },
}));

const load = async () => {
  vi.resetModules();
  return import('./index');
};

describe('Nano clarification optional module wrapper', () => {
  beforeEach(() => {
    mocks.platform.OS = 'android';
    mocks.throwOnLoad = false;
    mocks.nativeModule = {
      getCapability: vi.fn(async () => ({
        available: true,
        reason: 'available',
        supportedOperations: ['inbox_clarification'],
        modelName: 'nano-v3',
      })),
      downloadModel: vi.fn(async () => ({
        available: true,
        reason: 'available',
        supportedOperations: ['inbox_clarification'],
      })),
      clarifyInbox: vi.fn(async () => '{"cleanedTitle":"Call the dentist"}'),
      cancelRequest: vi.fn(async () => undefined),
    };
  });

  it('does not fail module import when the optional native registry throws', async () => {
    mocks.throwOnLoad = true;
    const api = await load();

    await expect(api.getNativeNanoClarificationCapability('en-US')).resolves.toEqual({
      available: false,
      reason: 'native_module_missing',
      supportedOperations: [],
    });
  });

  it('returns an inert capability on non-Android platforms', async () => {
    mocks.platform.OS = 'ios';
    const api = await load();

    await expect(api.getNativeNanoClarificationCapability('en-US')).resolves.toMatchObject({
      available: false,
      reason: 'unsupported_platform',
    });
    await expect(api.cancelNativeNanoClarificationRequest('request-1')).resolves.toBeUndefined();
    expect(mocks.nativeModule?.cancelRequest).not.toHaveBeenCalled();
  });

  it('forwards the bounded request and preserves raw suggestion JSON', async () => {
    const api = await load();
    const request = {
      requestId: 'request-1',
      locale: 'en-US',
      title: 'dentist',
      description: '',
      candidates: [{ kind: 'context', id: 'phone', label: 'Phone' }],
    } as const;

    await expect(api.requestNativeNanoInboxClarification(request)).resolves.toBe(
      '{"cleanedTitle":"Call the dentist"}',
    );
    await api.cancelNativeNanoClarificationRequest(request.requestId);

    expect(mocks.nativeModule?.clarifyInbox).toHaveBeenCalledWith(request);
    expect(mocks.nativeModule?.cancelRequest).toHaveBeenCalledWith('request-1');
  });

  it('downloads only when explicitly requested', async () => {
    const api = await load();

    await api.getNativeNanoClarificationCapability('en-US');
    expect(mocks.nativeModule?.downloadModel).not.toHaveBeenCalled();

    await api.downloadNativeNanoClarificationModel('download-1', 'en-US');
    expect(mocks.nativeModule?.downloadModel).toHaveBeenCalledWith('download-1', 'en-US');
  });
});
