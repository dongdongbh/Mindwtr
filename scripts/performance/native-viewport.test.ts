import { describe, expect, it } from 'bun:test';
import { configureOwnedNativeWindow, findOwnedNativeWindow, installNativeViewportGuard, parseNativeViewport, validateNativeViewport } from './native-viewport.mjs';

describe('native comparison viewport', () => {
  it('requires an explicit bounded size and scale', () => {
    expect(parseNativeViewport(undefined)).toBeUndefined();
    expect(parseNativeViewport('1200x800@2')).toEqual({ width: 1200, height: 800, ratio: 2 });
    for (const bad of ['', '1200x800', '1200x800@0', '0x800@2', '99999x800@2', '1200x800@2;quit']) {
      expect(() => parseNativeViewport(bad)).toThrow();
    }
  });
  it('rejects monitor or scaling drift even in the first sample of another batch', () => {
    const expected = parseNativeViewport('1200x800@2');
    expect(validateNativeViewport(expected, expected)).toEqual(expected);
    for (const actual of [{ width: 1440, height: 2513, ratio: 2 }, { ...expected, ratio: 1 },
      { ...expected, height: NaN }]) expect(() => validateNativeViewport(actual, expected)).toThrow();
  });
  it('matches executable ownership and never falls back to a title or focus', () => {
    const windows = [{ id: 1, pid: 10, title: 'Mindwtr Benchmark', is_focused: true }, { id: 2, pid: 20 }];
    const executable = (pid: number) => pid === 20 ? '/owned/mindwtr' : '/personal/mindwtr';
    expect(findOwnedNativeWindow(windows, '/owned/mindwtr', executable)).toEqual(windows[1]);
    expect(findOwnedNativeWindow(windows, '/missing/mindwtr', executable)).toBeUndefined();
    expect(() => findOwnedNativeWindow([...windows, { id: 3, pid: 20 }], '/owned/mindwtr', executable)).toThrow();
    expect(findOwnedNativeWindow(windows, '/owned/mindwtr', () => { throw Error('gone'); })).toBeUndefined();
  });
  it('targets every action by verified window ID, without global display changes', () => {
    const calls: string[][] = [];
    configureOwnedNativeWindow({ id: 23 }, parseNativeViewport('1200x800@2'), (...args: string[]) => calls.push(args));
    expect(calls).toEqual([
      ['move-window-to-floating', '--id', '23'], ['set-window-width', '--id', '23', '1200'],
      ['set-window-height', '--id', '23', '800'],
    ]);
    expect(() => configureOwnedNativeWindow(undefined, {}, () => calls.push(['unsafe']))).toThrow();
    expect(calls).toHaveLength(3);
  });
  it('remembers a temporary mid-interaction resize even after the original size returns', () => {
    let resize = () => {};
    const window = { innerWidth: 1200, innerHeight: 800, devicePixelRatio: 2, __nativeViewportDrift: false,
      addEventListener: (_event: string, callback: () => void) => { resize = callback; } };
    new Function('window', 'expected', `(${installNativeViewportGuard.toString()})(expected)`)(window, parseNativeViewport('1200x800@2'));
    expect(window.__nativeViewportDrift).toBe(false);
    window.innerWidth = 1440;
    resize();
    window.innerWidth = 1200;
    resize();
    expect(window.__nativeViewportDrift).toBe(true);
  });
});
