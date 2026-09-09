import { expect, it } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { installCaptureRenderProbe, validateCaptureRenderProbe, validateCaptureSampling } from './native-capture-probe.mjs';

it('requires a bounded capture sampling window and nonempty stack data', () => {
  const probe = { samplingStartMs: 99, keydownMs: 100, domVisibleMs: 150, frameMs: 160, samplingStopMs: 161 };
  const data = { interval: 0.001, traces: [{ timestamp: 500, frames: [{ name: 'Synthetic' }] }] };
  expect(validateCaptureSampling(probe, data)).toEqual({ samples: 1, interval: 0.001 });
  for (const bad of [{ ...probe, samplingTimedOut: true }, { ...probe, samplingStartMs: 101 },
    { ...probe, samplingStopMs: 159 }, { ...probe, samplingStopMs: 5100 }]) {
    expect(() => validateCaptureSampling(bad, data)).toThrow();
  }
  for (const bad of [null, { ...data, interval: 0.01 }, { ...data, traces: [] },
    { ...data, traces: [{ timestamp: NaN, frames: [{}] }] },
    { ...data, traces: [{ timestamp: 500, frames: [] }] }]) {
    expect(() => validateCaptureSampling(probe, bad)).toThrow();
  }
});

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

it.each([false, true])('observes capture and cleans up, JSC sampling=%s', (sampleJS) => {
  let keydown: (event: { key: string }) => void = () => {};
  let mutation: () => void = () => {};
  let frame: () => void = () => {};
  let time = 100;
  let visible = false;
  let disconnected = false;
  let removed = false;
  let sampling = false;
  let timeoutCleared = false;
  const browser = { __nativeCaptureRender: undefined as any,
    __enableSamplingProfiler: () => { sampling = true; },
    __disableSamplingProfiler: () => { sampling = false; },
    __dumpAndClearSamplingProfilerSamples: () => {},
  };
  const input = {
    addEventListener: (_type: string, callback: typeof keydown) => { keydown = callback; },
    removeEventListener: (_type: string, callback: typeof keydown) => { removed = callback === keydown; },
  };
  runInNewContext(`(${installCaptureRenderProbe.toString()})('input', 'Synthetic capture', ${sampleJS})`, {
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
    setTimeout: () => 1,
    clearTimeout: () => { timeoutCleared = true; },
  });
  expect(sampling).toBe(sampleJS);
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
  expect(sampling).toBe(false);
  expect(timeoutCleared).toBe(sampleJS);
  if (sampleJS) expect(browser.__nativeCaptureRender.samplingStopMs).toBe(160);
  expect(validateCaptureRenderProbe(browser.__nativeCaptureRender))
    .toEqual({ eventToDomMs: 50, eventToFrameMs: 60 });
});

it('fails explicitly when opt-in sampling hooks are unavailable', () => {
  expect(() => runInNewContext(`(${installCaptureRenderProbe.toString()})('input', 'Synthetic', true)`, {
    document: { querySelector: () => ({}) }, window: {},
  })).toThrow('JSC sampling hooks unavailable');
});

it('bounds sampling when capture never reaches a frame', () => {
  let timeout: () => void = () => {};
  let sampling = false;
  const browser = { __nativeCaptureRender: undefined as any,
    __enableSamplingProfiler: () => { sampling = true; },
    __disableSamplingProfiler: () => { sampling = false; },
    __dumpAndClearSamplingProfilerSamples: () => {},
  };
  runInNewContext(`(${installCaptureRenderProbe.toString()})('input', 'Synthetic', true)`, {
    window: browser, document: { body: {}, querySelector: () => ({ addEventListener() {} }) },
    performance: { now: () => 100 }, MutationObserver: class { observe() {} },
    setTimeout: (callback: () => void, duration: number) => {
      expect(duration).toBe(5000); timeout = callback; return 1;
    },
  });
  expect(sampling).toBe(true);
  timeout();
  expect(sampling).toBe(false);
  expect(browser.__nativeCaptureRender.samplingTimedOut).toBe(true);
});
