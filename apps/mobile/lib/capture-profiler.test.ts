import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  platform: { OS: 'android' },
  native: { beginCaptureProfile: vi.fn(), endCaptureProfileAsync: vi.fn() },
  requireNative: vi.fn(),
}));
vi.mock('react-native', () => ({ Platform: mocks.platform }));
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: mocks.requireNative }));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.stubEnv('EXPO_PUBLIC_CAPTURE_PROFILING', '1');
  mocks.platform.OS = 'android';
  mocks.native.beginCaptureProfile.mockReturnValue(1);
  mocks.native.endCaptureProfileAsync.mockResolvedValue(true);
  mocks.requireNative.mockReturnValue(mocks.native);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); });

it.each(['', '0', 'true'])('does no native work without the exact build opt-in (%s)', async flag => {
  vi.stubEnv('EXPO_PUBLIC_CAPTURE_PROFILING', flag);
  const profiler = await import('./capture-profiler');
  profiler.beginCaptureProfile();
  profiler.endCaptureProfile();
  expect(mocks.requireNative).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('does not activate on Apple platforms', async () => {
  mocks.platform.OS = 'ios';
  const profiler = await import('./capture-profiler');
  profiler.beginCaptureProfile();
  expect(mocks.requireNative).not.toHaveBeenCalled();
});

it('starts before capture and defers serialization until after the close commit', async () => {
  const profiler = await import('./capture-profiler');
  profiler.beginCaptureProfile();
  expect(mocks.native.beginCaptureProfile).toHaveBeenCalledTimes(1);
  profiler.endCaptureProfile();
  await vi.advanceTimersByTimeAsync(199);
  expect(mocks.native.endCaptureProfileAsync).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.native.endCaptureProfileAsync).toHaveBeenCalledExactlyOnceWith(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('retains one bounded session when capture reopens during deferred stop', async () => {
  const profiler = await import('./capture-profiler');
  profiler.beginCaptureProfile();
  profiler.endCaptureProfile();
  await vi.advanceTimersByTimeAsync(100);
  profiler.beginCaptureProfile();
  await vi.advanceTimersByTimeAsync(100);
  expect(mocks.native.beginCaptureProfile).toHaveBeenCalledTimes(1);
  expect(mocks.native.endCaptureProfileAsync).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(29_800);
  expect(mocks.native.endCaptureProfileAsync).toHaveBeenCalledExactlyOnceWith(1);
});

it.each(['missing', 'denied', 'throws'])('cannot break capture when sampling is %s', async condition => {
  if (condition === 'missing') mocks.requireNative.mockReturnValue(null);
  if (condition === 'denied') mocks.native.beginCaptureProfile.mockReturnValue(0);
  if (condition === 'throws') mocks.native.beginCaptureProfile.mockImplementation(() => { throw new Error('unavailable'); });
  const profiler = await import('./capture-profiler');
  expect(() => profiler.beginCaptureProfile()).not.toThrow();
  profiler.endCaptureProfile();
  expect(vi.getTimerCount()).toBe(0);
});

it('contains native dump failures and permits a later session', async () => {
  mocks.native.endCaptureProfileAsync.mockRejectedValueOnce(new Error('unavailable'));
  const profiler = await import('./capture-profiler');
  profiler.beginCaptureProfile();
  profiler.endCaptureProfile();
  await vi.advanceTimersByTimeAsync(200);
  mocks.native.beginCaptureProfile.mockReturnValue(2);
  profiler.beginCaptureProfile();
  profiler.endCaptureProfile();
  await vi.advanceTimersByTimeAsync(200);
  expect(mocks.native.endCaptureProfileAsync.mock.calls).toEqual([[1], [2]]);
});
