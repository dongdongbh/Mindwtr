import assert from 'node:assert/strict';

// Serialized into the isolated WebView by WebDriver, never bundled into the app.
export function installCaptureRenderProbe(selector, title) {
  const input = document.querySelector(selector);
  if (!input) throw new Error('Capture input missing');
  const result = window.__nativeCaptureRender = {};
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
    requestAnimationFrame(() => { result.frameMs = performance.now(); });
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
