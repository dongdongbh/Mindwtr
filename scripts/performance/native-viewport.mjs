import assert from 'node:assert/strict';

export function parseNativeViewport(value) {
  if (value === undefined) return undefined;
  const match = /^(\d+)x(\d+)@(\d+(?:\.\d+)?)$/.exec(value);
  assert(match, 'NATIVE_VIEWPORT must be WIDTHxHEIGHT@SCALE');
  const [width, height, ratio] = match.slice(1).map(Number);
  assert(width >= 800 && width <= 3840 && height >= 600 && height <= 2160
    && ratio >= 1 && ratio <= 4, 'Native viewport outside supported bounds');
  return { width, height, ratio };
}

// Match the unique copied executable of this iteration, not a window title,
// application name, or whichever window happens to have keyboard focus.
export function findOwnedNativeWindow(windows, application, executableForPid) {
  assert(Array.isArray(windows), 'Invalid compositor window inventory');
  const matches = windows.filter(window => {
    if (!Number.isSafeInteger(window.pid) || window.pid <= 0) return false;
    try { return executableForPid(window.pid) === application; }
    catch { return false; } // A window may exit during inventory collection.
  });
  assert(matches.length <= 1, 'Ambiguous benchmark window ownership');
  if (!matches.length) return undefined;
  assert(Number.isSafeInteger(matches[0].id) && matches[0].id > 0, 'Invalid owned window ID');
  return matches[0];
}

export function configureOwnedNativeWindow(window, viewport, action) {
  assert(window && Number.isSafeInteger(window.id) && window.id > 0, 'Explicit owned window required');
  const id = String(window.id);
  action('move-window-to-floating', '--id', id);
  action('set-window-width', '--id', id, String(viewport.width));
  action('set-window-height', '--id', id, String(viewport.height));
}

export function validateNativeViewport(actual, expected) {
  for (const field of ['width', 'height', 'ratio']) {
    assert(Number.isFinite(actual?.[field]) && actual[field] > 0, 'Invalid native viewport');
  }
  if (expected) assert.deepEqual(actual, expected, 'Native viewport differs from the requested comparison viewport');
  return actual;
}

// Serialized into the benchmark WebView. Keep this function self-contained.
export function installNativeViewportGuard(expected) {
  window.__nativeViewportDrift = false;
  const check = () => {
    if (window.innerWidth !== expected.width || window.innerHeight !== expected.height || window.devicePixelRatio !== expected.ratio) {
      window.__nativeViewportDrift = true;
    }
  };
  window.addEventListener('resize', check);
  check();
}
