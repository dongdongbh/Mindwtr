import { beforeEach, describe, expect, it, vi } from 'vitest';

const reactNativeMock = vi.hoisted(() => ({
  AppState: { currentState: 'background' as string },
  Platform: { OS: 'android' as string },
}));
const coreMock = vi.hoisted(() => ({ setSleepBypass: vi.fn() }));
vi.mock('react-native', () => reactNativeMock);
vi.mock('@mindwtr/core', () => coreMock);

describe('js-timers', () => {
  beforeEach(() => {
    vi.resetModules();
    coreMock.setSleepBypass.mockClear();
  });

  it('installs a sleep bypass that holds only while the app is off screen on Android', async () => {
    const { areJsTimersPaused } = await import('./js-timers');
    expect(coreMock.setSleepBypass).toHaveBeenCalledWith(areJsTimersPaused);

    reactNativeMock.AppState.currentState = 'background';
    reactNativeMock.Platform.OS = 'android';
    expect(areJsTimersPaused()).toBe(true);
    reactNativeMock.AppState.currentState = 'active';
    expect(areJsTimersPaused()).toBe(false);
    reactNativeMock.AppState.currentState = 'background';
    reactNativeMock.Platform.OS = 'ios';
    expect(areJsTimersPaused()).toBe(false);
  });
});
