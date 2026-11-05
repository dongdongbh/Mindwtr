import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TextInput } from 'react-native';

const mocks = vi.hoisted(() => ({
  native: { getModalKeyboardInsetAsync: vi.fn() },
  findNodeHandle: vi.fn(),
  available: true,
  platform: { OS: 'android' },
}));
vi.mock('react-native', () => ({ Platform: mocks.platform, findNodeHandle: mocks.findNodeHandle }));
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => mocks.available ? mocks.native : null }));

describe('modal keyboard native measurement', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.available = true;
    mocks.platform.OS = 'android';
    mocks.findNodeHandle.mockReturnValue(123);
    mocks.native.getModalKeyboardInsetAsync = vi.fn().mockResolvedValue(283);
  });

  const input = {} as TextInput;
  it('passes the owning input tag instead of querying the activity window', async () => {
    const { measureAndroidModalKeyboardInset } = await import('./android-modal-keyboard');
    await expect(measureAndroidModalKeyboardInset(input)).resolves.toBe(283);
    expect(mocks.findNodeHandle).toHaveBeenCalledWith(input);
    expect(mocks.native.getModalKeyboardInsetAsync).toHaveBeenCalledExactlyOnceWith(123);
  });

  it.each([0, 150.5])('retains a real measured inset of %s', async (inset) => {
    mocks.native.getModalKeyboardInsetAsync.mockResolvedValue(inset);
    const { measureAndroidModalKeyboardInset } = await import('./android-modal-keyboard');
    await expect(measureAndroidModalKeyboardInset(input)).resolves.toBe(inset);
  });

  it.each([null, -1, NaN, Infinity, '283'])('rejects an invalid native measurement %s', async (inset) => {
    mocks.native.getModalKeyboardInsetAsync.mockResolvedValue(inset);
    const { measureAndroidModalKeyboardInset } = await import('./android-modal-keyboard');
    await expect(measureAndroidModalKeyboardInset(input)).resolves.toBeNull();
  });

  it.each(['missing-module', 'old-client', 'unmounted', 'rejected', 'ios'])('keeps the event fallback for %s', async (mode) => {
    if (mode === 'missing-module') mocks.available = false;
    if (mode === 'old-client') Reflect.deleteProperty(mocks.native, 'getModalKeyboardInsetAsync');
    if (mode === 'unmounted') mocks.findNodeHandle.mockReturnValue(null);
    if (mode === 'rejected') mocks.native.getModalKeyboardInsetAsync.mockRejectedValue(new Error('native unavailable'));
    if (mode === 'ios') mocks.platform.OS = 'ios';
    const { measureAndroidModalKeyboardInset } = await import('./android-modal-keyboard');
    await expect(measureAndroidModalKeyboardInset(input)).resolves.toBeNull();
  });
});
