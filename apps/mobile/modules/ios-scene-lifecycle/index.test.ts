import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  platform: { OS: 'ios' },
  remove: vi.fn(),
  nativeModule: {
    drainDiagnostics: vi.fn(),
    addListener: vi.fn(),
    beginBackgroundTask: vi.fn(),
    endBackgroundTask: vi.fn(),
  },
  requireOptionalNativeModule: vi.fn(),
}));

vi.mock('react-native', () => ({ Platform: mocks.platform }));
vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: mocks.requireOptionalNativeModule,
}));

describe('ios-scene-lifecycle bridge', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.platform.OS = 'ios';
    mocks.nativeModule.drainDiagnostics.mockReturnValue([]);
    mocks.nativeModule.addListener.mockReturnValue({ remove: mocks.remove });
    mocks.requireOptionalNativeModule.mockReturnValue(mocks.nativeModule);
  });

  it('projects bounded native records onto the fixed privacy-safe fields', async () => {
    mocks.nativeModule.drainDiagnostics.mockReturnValue([
      {
        stage: 'coldDelivery',
        deliveryKind: 'url',
        count: 1,
        url: 'mindwtr:///capture?task=private',
        title: 'private',
      },
      { stage: 'coldDelivery', deliveryKind: 'notification', count: 1 },
      { stage: 'unknown', deliveryKind: 'url', count: 2 },
      { stage: 'warmDelivery', deliveryKind: 'url', count: 0 },
    ]);
    const bridge = await import('./index');

    expect(bridge.drainIosSceneDiagnostics()).toEqual([
      { stage: 'coldDelivery', deliveryKind: 'url', count: 1 },
      { stage: 'coldDelivery', deliveryKind: 'notification', count: 1 },
    ]);
  });

  it('subscribes to the native wake-up edge', async () => {
    const bridge = await import('./index');
    const listener = vi.fn();

    const subscription = bridge.subscribeIosSceneDiagnostics(listener);
    expect(mocks.nativeModule.addListener).toHaveBeenCalledWith('onDiagnosticsChanged', listener);
    subscription.remove();
    expect(mocks.remove).toHaveBeenCalledTimes(1);
  });

  it('ends a background task exactly once on release', async () => {
    mocks.nativeModule.beginBackgroundTask.mockReturnValue(7);
    const bridge = await import('./index');
    const onExpire = vi.fn();

    const release = bridge.beginIosBackgroundTask('Mindwtr sync', onExpire);
    expect(mocks.nativeModule.beginBackgroundTask).toHaveBeenCalledWith('Mindwtr sync');
    expect(mocks.nativeModule.addListener).toHaveBeenCalledWith('onBackgroundTaskExpired', expect.any(Function));
    release!();
    release!();
    expect(mocks.nativeModule.endBackgroundTask).toHaveBeenCalledTimes(1);
    expect(mocks.nativeModule.endBackgroundTask).toHaveBeenCalledWith(7);
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('reports only its own expiry once, and a later release does not end it again', async () => {
    mocks.nativeModule.beginBackgroundTask.mockReturnValue(7);
    const bridge = await import('./index');
    const onExpire = vi.fn();

    const release = bridge.beginIosBackgroundTask('Mindwtr sync', onExpire);
    const listener = mocks.nativeModule.addListener.mock.calls[0][1] as (event: { id: unknown }) => void;
    listener({ id: 8 });
    expect(onExpire).not.toHaveBeenCalled();
    listener({ id: 7 });
    listener({ id: 7 });
    expect(onExpire).toHaveBeenCalledTimes(1);
    release!();
    expect(mocks.nativeModule.endBackgroundTask).not.toHaveBeenCalled();
  });

  it('grants no hold when iOS refuses one or the native function is missing', async () => {
    mocks.nativeModule.beginBackgroundTask.mockReturnValue(0);
    let bridge = await import('./index');
    expect(bridge.beginIosBackgroundTask('Mindwtr sync', vi.fn())).toBeNull();
    expect(mocks.nativeModule.addListener).not.toHaveBeenCalled();

    vi.resetModules();
    mocks.requireOptionalNativeModule.mockReturnValue({ drainDiagnostics: vi.fn(), addListener: vi.fn() });
    bridge = await import('./index');
    expect(bridge.beginIosBackgroundTask('Mindwtr sync', vi.fn())).toBeNull();

    vi.resetModules();
    mocks.platform.OS = 'android';
    bridge = await import('./index');
    expect(bridge.beginIosBackgroundTask('Mindwtr sync', vi.fn())).toBeNull();
  });

  it('is nonfatal outside iOS and when an older client lacks the module', async () => {
    mocks.platform.OS = 'android';
    let bridge = await import('./index');
    expect(bridge.drainIosSceneDiagnostics()).toEqual([]);
    expect(() => bridge.subscribeIosSceneDiagnostics(vi.fn()).remove()).not.toThrow();
    expect(mocks.requireOptionalNativeModule).not.toHaveBeenCalled();

    vi.resetModules();
    mocks.platform.OS = 'ios';
    mocks.requireOptionalNativeModule.mockImplementation(() => {
      throw new Error('not linked');
    });
    bridge = await import('./index');
    expect(bridge.drainIosSceneDiagnostics()).toEqual([]);
    expect(() => bridge.subscribeIosSceneDiagnostics(vi.fn()).remove()).not.toThrow();
  });
});
