import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  platform: { OS: 'ios' },
  remove: vi.fn(),
  nativeModule: {
    isAvailable: vi.fn(),
    claimPending: vi.fn(),
    acknowledge: vi.fn(),
    publishSnapshot: vi.fn(),
    clearSnapshot: vi.fn(),
    setAccessAllowed: vi.fn(),
    addListener: vi.fn(),
  },
  requireOptionalNativeModule: vi.fn(),
}));

vi.mock('react-native', () => ({ Platform: mocks.platform }));
vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: mocks.requireOptionalNativeModule,
}));

const request = {
  version: 1 as const,
  id: '00000000-0000-4000-8000-000000000001',
  replayOnly: true,
  operation: 'update' as const,
  targetId: '00000000-0000-4000-8000-000000000002',
  expectedToken: 'revision-1',
  createdAt: 1_000,
  expiresAt: 121_000,
  fields: { title: 'Next action' },
  clearFields: ['description' as const],
};

describe('ios-siri-actions wrapper', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.platform.OS = 'ios';
    mocks.nativeModule.isAvailable.mockReturnValue(true);
    mocks.nativeModule.claimPending.mockResolvedValue([]);
    mocks.nativeModule.acknowledge.mockResolvedValue(undefined);
    mocks.nativeModule.publishSnapshot.mockResolvedValue(undefined);
    mocks.nativeModule.clearSnapshot.mockResolvedValue(undefined);
    mocks.nativeModule.setAccessAllowed.mockResolvedValue(undefined);
    mocks.nativeModule.addListener.mockReturnValue({ remove: mocks.remove });
    mocks.requireOptionalNativeModule.mockReturnValue(mocks.nativeModule);
  });

  it('passes requests and durable transport arguments through unchanged', async () => {
    mocks.nativeModule.claimPending.mockResolvedValue([request]);
    const bridge = await import('./index');

    expect(bridge.isAvailable()).toBe(true);
    await expect(bridge.claimPending()).resolves.toEqual([request]);
    await bridge.acknowledge(request.id, '{"outcome":"persisted","task":"{}"}');
    await bridge.publishSnapshot('{"requiresAppUnlock":true}');
    await bridge.setAccessAllowed(true);
    await bridge.clearSnapshot();

    expect(mocks.nativeModule.acknowledge).toHaveBeenCalledWith(
      request.id,
      '{"outcome":"persisted","task":"{}"}',
    );
    expect(mocks.nativeModule.publishSnapshot).toHaveBeenCalledWith(
      '{"requiresAppUnlock":true}',
    );
    expect(mocks.nativeModule.setAccessAllowed).toHaveBeenCalledWith(true);
    expect(mocks.nativeModule.clearSnapshot).toHaveBeenCalledOnce();
  });

  it('subscribes to the native pending-action wake-up edge', async () => {
    const bridge = await import('./index');
    const listener = vi.fn();

    const subscription = bridge.subscribePendingActionsChanged(listener);
    expect(mocks.nativeModule.addListener).toHaveBeenCalledWith(
      'onPendingActionsChanged',
      listener,
    );
    subscription.remove();
    expect(mocks.remove).toHaveBeenCalledTimes(1);
  });

  it('is nonfatal away from iOS', async () => {
    mocks.platform.OS = 'android';
    const bridge = await import('./index');

    expect(bridge.isAvailable()).toBe(false);
    await expect(bridge.claimPending()).resolves.toEqual([]);
    await expect(bridge.acknowledge(request.id, '{}')).resolves.toBeUndefined();
    await expect(bridge.publishSnapshot('{}')).resolves.toBeUndefined();
    await expect(bridge.setAccessAllowed(true)).resolves.toBeUndefined();
    expect(() =>
      bridge.subscribePendingActionsChanged(vi.fn()).remove(),
    ).not.toThrow();
    expect(mocks.requireOptionalNativeModule).not.toHaveBeenCalled();
  });

  it('keeps optional capabilities nonfatal on an older iOS client', async () => {
    mocks.requireOptionalNativeModule.mockImplementation(() => {
      throw new Error('not linked');
    });
    const bridge = await import('./index');

    expect(bridge.isAvailable()).toBe(false);
    await expect(bridge.claimPending()).resolves.toEqual([]);
    await expect(bridge.publishSnapshot('{}')).resolves.toBeUndefined();
    await expect(bridge.setAccessAllowed(true)).resolves.toBeUndefined();
    expect(() =>
      bridge.subscribePendingActionsChanged(vi.fn()).remove(),
    ).not.toThrow();
  });

  it('rejects a missing acknowledgement method instead of pretending success', async () => {
    mocks.requireOptionalNativeModule.mockReturnValue({
      ...mocks.nativeModule,
      acknowledge: undefined,
    });
    const bridge = await import('./index');

    await expect(bridge.acknowledge(request.id, '{}')).rejects.toThrow(
      'native acknowledge method is unavailable',
    );
  });

  it('propagates native I/O failures', async () => {
    mocks.nativeModule.claimPending.mockRejectedValue(
      new Error('corrupt action store'),
    );
    mocks.nativeModule.acknowledge.mockRejectedValue(
      new Error('receipt write failed'),
    );
    const bridge = await import('./index');

    await expect(bridge.claimPending()).rejects.toThrow('corrupt action store');
    await expect(bridge.acknowledge(request.id, '{}')).rejects.toThrow(
      'receipt write failed',
    );
  });
});
