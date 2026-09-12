import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const remove = vi.fn();
  const getActivitySessionForId = vi.fn();
  return {
    platform: { OS: 'android' },
    nativeModule: {
      getLayout: vi.fn(),
      getActivitySession: vi.fn(),
      getActivitySessionForId,
      addListener: vi.fn((_eventName: string, _listener: unknown) => ({ remove })),
    },
    remove,
    getActivitySessionForId,
    requireOptionalNativeModule: vi.fn(),
  };
});

vi.mock('react-native', () => ({ Platform: mocks.platform }));
vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: mocks.requireOptionalNativeModule,
}));

async function loadWrapper() {
  return import('./index');
}

describe('android-window-layout wrapper', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.platform.OS = 'android';
    mocks.requireOptionalNativeModule.mockReturnValue(mocks.nativeModule);
    mocks.nativeModule.getLayout.mockReturnValue(null);
    mocks.nativeModule.getActivitySession.mockReturnValue(null);
    mocks.nativeModule.getActivitySessionForId = mocks.getActivitySessionForId;
    mocks.getActivitySessionForId.mockReset().mockReturnValue(null);
  });

  it('queries a bounded destroyed activity session by its source identity', async () => {
    const destroyedSession = { activityId: 4815, isChangingConfigurations: true };
    mocks.getActivitySessionForId.mockReturnValue(destroyedSession);
    const wrapper = await loadWrapper();

    expect(wrapper.getAndroidActivitySession(4815)).toEqual(destroyedSession);
    expect(mocks.getActivitySessionForId).toHaveBeenCalledWith(4815);
    expect(mocks.nativeModule.getActivitySession).not.toHaveBeenCalled();
  });

  it('falls back to a matching current session for an older native module', async () => {
    const currentSession = { activityId: 4815, isChangingConfigurations: false };
    const legacyNativeModule = {
      getLayout: mocks.nativeModule.getLayout,
      getActivitySession: vi.fn(() => currentSession),
      addListener: mocks.nativeModule.addListener,
    };
    mocks.requireOptionalNativeModule.mockReturnValue(legacyNativeModule);
    const wrapper = await loadWrapper();

    expect(wrapper.getAndroidActivitySession(4815)).toEqual(currentSession);
    expect(wrapper.getAndroidActivitySession(1623)).toBeNull();
  });

  it('returns a same-process activity session token for recreation recovery', async () => {
    const session = { activityId: 4815, isChangingConfigurations: true };
    mocks.nativeModule.getActivitySession.mockReturnValue(session);
    const wrapper = await loadWrapper();

    expect(wrapper.getAndroidActivitySession()).toEqual(session);
  });

  it('returns current window geometry and forwards layout events', async () => {
    const snapshot = {
      width: 673,
      height: 841,
      features: [{
        bounds: { left: 335, top: 0, right: 338, bottom: 841 },
        orientation: 'vertical' as const,
        state: 'flat' as const,
        isSeparating: true,
        occlusionType: 'full' as const,
      }],
    };
    mocks.nativeModule.getLayout.mockReturnValue(snapshot);
    const wrapper = await loadWrapper();

    expect(wrapper.getAndroidWindowLayout()).toEqual(snapshot);

    const listener = vi.fn();
    const unsubscribe = wrapper.subscribeAndroidWindowLayout(listener);
    expect(mocks.nativeModule.addListener).toHaveBeenCalledWith('onLayoutChanged', listener);

    const nativeListener = mocks.nativeModule.addListener.mock.calls[0][1] as (value: typeof snapshot) => void;
    nativeListener(snapshot);
    expect(listener).toHaveBeenCalledWith(snapshot);

    unsubscribe();
    expect(mocks.remove).toHaveBeenCalledTimes(1);
  });

  it('does not load the Android module on another platform', async () => {
    mocks.platform.OS = 'ios';
    const wrapper = await loadWrapper();

    expect(wrapper.getAndroidWindowLayout()).toBeNull();
    expect(wrapper.getAndroidActivitySession()).toBeNull();
    expect(wrapper.subscribeAndroidWindowLayout(vi.fn())).toEqual(expect.any(Function));
    expect(mocks.requireOptionalNativeModule).not.toHaveBeenCalled();
  });

  it('fails safely when the optional native module is absent', async () => {
    mocks.requireOptionalNativeModule.mockReturnValue(null);
    const wrapper = await loadWrapper();

    expect(wrapper.getAndroidWindowLayout()).toBeNull();
    expect(wrapper.getAndroidActivitySession()).toBeNull();
    expect(() => wrapper.subscribeAndroidWindowLayout(vi.fn())()).not.toThrow();
  });

  it('fails safely when native lookup or invocation throws', async () => {
    mocks.requireOptionalNativeModule.mockImplementation(() => {
      throw new Error('unavailable in this client');
    });
    let wrapper = await loadWrapper();
    expect(wrapper.getAndroidWindowLayout()).toBeNull();
    expect(wrapper.getAndroidActivitySession()).toBeNull();

    vi.resetModules();
    mocks.requireOptionalNativeModule.mockReturnValue(mocks.nativeModule);
    mocks.nativeModule.getLayout.mockImplementation(() => {
      throw new Error('activity unavailable');
    });
    mocks.nativeModule.getActivitySession.mockImplementation(() => {
      throw new Error('activity unavailable');
    });
    mocks.nativeModule.addListener.mockImplementation(() => {
      throw new Error('event emitter unavailable');
    });
    wrapper = await loadWrapper();
    expect(wrapper.getAndroidWindowLayout()).toBeNull();
    expect(wrapper.getAndroidActivitySession()).toBeNull();
    expect(() => wrapper.subscribeAndroidWindowLayout(vi.fn())()).not.toThrow();
  });
});
