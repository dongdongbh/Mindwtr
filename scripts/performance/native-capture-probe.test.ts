import { expect, it } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { installCaptureRenderProbe, validateCaptureRenderProbe } from './native-capture-probe.mjs';

it('requires ordered in-page event, DOM and frame clocks', () => {
  expect(validateCaptureRenderProbe({ keydownMs: 100, domVisibleMs: 150, frameMs: 160 }))
    .toEqual({ eventToDomMs: 50, eventToFrameMs: 60 });
  for (const bad of [null, {}, { keydownMs: 100, domVisibleMs: 150 },
    { keydownMs: 100, domVisibleMs: 99, frameMs: 160 },
    { keydownMs: 100, domVisibleMs: 150, frameMs: 149 },
    { keydownMs: -1, domVisibleMs: 150, frameMs: 160 },
    { keydownMs: NaN, domVisibleMs: 150, frameMs: 160 }]) {
    expect(() => validateCaptureRenderProbe(bad)).toThrow();
  }
});

it('observes the capture event and matching visible row, then disconnects', () => {
  let keydown: (event: { key: string }) => void = () => {};
  let mutation: () => void = () => {};
  let frame: () => void = () => {};
  let time = 100;
  let visible = false;
  let disconnected = false;
  let removed = false;
  const browser = { __nativeCaptureRender: undefined as any };
  const input = {
    addEventListener: (_type: string, callback: typeof keydown) => { keydown = callback; },
    removeEventListener: (_type: string, callback: typeof keydown) => { removed = callback === keydown; },
  };
  runInNewContext(`(${installCaptureRenderProbe.toString()})('input', 'Synthetic capture')`, {
    window: browser,
    document: { body: {}, querySelector: () => input,
      querySelectorAll: () => [{ textContent: 'Other task', getClientRects: () => [1] },
        { textContent: 'Synthetic capture', getClientRects: () => visible ? [1] : [] }] },
    performance: { now: () => time },
    MutationObserver: class {
      constructor(callback: () => void) { mutation = callback; }
      observe() {}
      disconnect() { disconnected = true; }
    },
    requestAnimationFrame: (callback: () => void) => { frame = callback; },
  });
  mutation();
  keydown({ key: 'a' });
  expect(browser.__nativeCaptureRender.keydownMs).toBeUndefined();
  keydown({ key: 'Enter' });
  time = 110;
  keydown({ key: 'Enter' });
  mutation();
  expect(browser.__nativeCaptureRender.domVisibleMs).toBeUndefined();
  visible = true;
  time = 150;
  mutation();
  expect(disconnected && removed).toBe(true);
  time = 160;
  frame();
  expect(validateCaptureRenderProbe(browser.__nativeCaptureRender))
    .toEqual({ eventToDomMs: 50, eventToFrameMs: 60 });
});
