import assert from 'node:assert/strict';

// Serialized into the isolated WebView by WebDriver, never bundled into the app.
export function installCaptureRenderProbe(selector, title, sampleJS = false) {
  const input = document.querySelector(selector);
  if (!input) throw new Error('Capture input missing');
  if (sampleJS && ['__enableSamplingProfiler', '__disableSamplingProfiler', '__dumpAndClearSamplingProfilerSamples']
    .some(name => typeof window[name] !== 'function')) throw new Error('JSC sampling hooks unavailable');
  const result = window.__nativeCaptureRender = {};
  let samplingTimeout;
  if (sampleJS) {
    // Start in this WebDriver entry so the next native event can be sampled.
    window.__enableSamplingProfiler();
    result.samplingStartMs = performance.now();
    samplingTimeout = setTimeout(() => {
      window.__disableSamplingProfiler();
      result.samplingTimedOut = true;
    }, 5000);
  }
  const onKeydown = event => {
    if (event.key === 'Enter' && result.keydownMs === undefined) result.keydownMs = performance.now();
  };
  input.addEventListener('keydown', onKeydown, true);
  const observer = new MutationObserver(() => {
    if (result.keydownMs === undefined) return;
    const row = [...document.querySelectorAll('[data-task-id]')]
      .find(el => el.textContent.includes(title) && el.getClientRects().length > 0);
    if (!row) return;
    result.domVisibleMs = performance.now();
    observer.disconnect();
    input.removeEventListener('keydown', onKeydown, true);
    // A frame callback is a rendering opportunity, NOT proof of presented pixels.
    requestAnimationFrame(() => {
      result.frameMs = performance.now();
      if (sampleJS) {
        window.__disableSamplingProfiler();
        clearTimeout(samplingTimeout);
        result.samplingStopMs = performance.now();
      }
    });
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['style', 'class'] });
}

export function validateCaptureRenderProbe(probe) {
  for (const key of ['keydownMs', 'domVisibleMs', 'frameMs']) {
    assert(Number.isFinite(probe?.[key]) && probe[key] >= 0, `Missing or invalid ${key}`);
  }
  assert(probe.domVisibleMs >= probe.keydownMs && probe.frameMs >= probe.domVisibleMs,
    'Invalid capture render clock order');
  return { eventToDomMs: probe.domVisibleMs - probe.keydownMs,
    eventToFrameMs: probe.frameMs - probe.keydownMs };
}

export function validateCaptureSampling(probe, profile) {
  validateCaptureRenderProbe(probe);
  assert(!probe.samplingTimedOut, 'JSC capture sampling timed out');
  assert(Number.isFinite(probe.samplingStartMs) && probe.samplingStartMs >= 0
    && probe.samplingStartMs <= probe.keydownMs
    && Number.isFinite(probe.samplingStopMs) && probe.samplingStopMs >= probe.frameMs
    && probe.samplingStopMs - probe.samplingStartMs <= 5000, 'Invalid JSC sampling window');
  assert.equal(profile?.interval, 0.001, 'Unexpected JSC sample interval');
  assert(Array.isArray(profile.traces) && profile.traces.length > 0, 'JSC capture profile has no stack samples');
  assert(profile.traces.every(trace => Number.isFinite(trace.timestamp)
    && Array.isArray(trace.frames) && trace.frames.length > 0), 'Malformed JSC stack samples');
  return { samples: profile.traces.length, interval: profile.interval };
}
