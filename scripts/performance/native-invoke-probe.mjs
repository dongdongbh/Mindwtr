import assert from 'node:assert/strict';

// Serialized into the verified synthetic Benchmark WebView by WebDriver.
// Keep this function self-contained: it is not bundled into the application.
export function installNativeInvokeProbe() {
  const stateKey = '__mindwtrNativeInvokeCompletionProbeV1';
  const target = window.__mindwtrNativeInvokeTransport;
  if (!target || target.schemaVersion !== 1 || target.label !== 'mindwtr-native-invoke-transport-v1') {
    throw new Error('Native invoke profiling transport unavailable');
  }
  if (!target || typeof target.invoke !== 'function') throw new Error('Native invoke callable unavailable');
  if (Object.prototype.hasOwnProperty.call(window, stateKey)) throw new Error('Native invoke probe already installed');

  const now = () => {
    try { return performance.now(); } catch { return NaN; }
  };
  const allowed = new Set(['save_data', 'save_task', 'get_data']);
  const original = target.invoke;
  const state = {
    installedAtMs: now(),
    target,
    original,
    wrapper: undefined,
    sequence: 0,
    records: [],
    pending: new Map(),
    overflow: false,
    observationFailures: 0,
    stopped: false,
  };

  const complete = (entry, outcome, settledMs) => {
    try {
      if (state.stopped || !state.pending.delete(entry.sequence)) return;
      state.records.push({
        command: entry.command,
        sequence: entry.sequence,
        startMs: entry.startMs,
        returnedMs: entry.returnedMs,
        settledMs,
        outcome,
      });
    } catch { /* Benchmark diagnostics must never change invoke behavior. */ }
  };

  state.wrapper = function (...args) {
    const command = args[0];
    if (!allowed.has(command)) return Reflect.apply(original, this, args);

    const sequence = ++state.sequence;
    if (sequence > 64) {
      state.overflow = true;
      return Reflect.apply(original, this, args);
    }

    const entry = { command, sequence, startMs: now(), returnedMs: NaN };
    state.pending.set(sequence, entry);
    let result;
    try {
      result = Reflect.apply(original, this, args);
    } catch (error) {
      entry.returnedMs = now();
      complete(entry, 'threw', entry.returnedMs);
      throw error;
    }

    entry.returnedMs = now();
    let then;
    try { then = result != null ? result.then : undefined; } catch {
      state.observationFailures += 1;
      return result;
    }
    if (typeof then === 'function') {
      try {
        Reflect.apply(then, result, [
          () => complete(entry, 'fulfilled', now()),
          () => complete(entry, 'rejected', now()),
        ]);
      } catch {
        state.observationFailures += 1;
        // An unusual thenable must still be returned unchanged.
      }
    } else {
      complete(entry, 'fulfilled', entry.returnedMs);
    }
    return result;
  };

  window[stateKey] = state;
  target.invoke = state.wrapper;
}

// Also serialized into the WebView. Restoration happens before evidence is copied.
export function stopNativeInvokeProbe() {
  const stateKey = '__mindwtrNativeInvokeCompletionProbeV1';
  const state = window[stateKey];
  if (!state) throw new Error('Native invoke probe is not installed');
  const target = state.target;
  let publishedTargetOwned = false;
  let wrapperOwned = false;
  let wrapperRestored = false;
  try { publishedTargetOwned = window.__mindwtrNativeInvokeTransport === target; } catch { /* Invalid evidence below. */ }
  try { wrapperOwned = !!target && target.invoke === state.wrapper; } catch { /* Invalid evidence below. */ }
  if (wrapperOwned) {
    try {
      target.invoke = state.original;
      wrapperRestored = target.invoke === state.original;
    } catch { /* Invalid evidence below; do not touch a later owner. */ }
  }
  const ownershipLost = !publishedTargetOwned || !wrapperOwned || !wrapperRestored;
  state.stopped = true;
  let stoppedAtMs;
  try { stoppedAtMs = performance.now(); } catch { stoppedAtMs = NaN; }
  const snapshot = {
    schemaVersion: 1,
    label: 'native-invoke-completion-v1',
    installedAtMs: state.installedAtMs,
    stoppedAtMs,
    maxRecords: 64,
    overflow: state.overflow,
    pendingCount: state.pending.size + state.observationFailures + (ownershipLost ? 1 : 0),
    records: state.records
      .slice()
      .sort((left, right) => left.sequence - right.sequence)
      .map(record => ({ ...record })),
  };
  delete window[stateKey];
  return snapshot;
}

const exactKeys = (value, keys, name) => {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${name} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `Invalid ${name} shape`);
};

export function validateNativeInvokeProbe(probe) {
  exactKeys(probe, [
    'schemaVersion', 'label', 'installedAtMs', 'stoppedAtMs', 'maxRecords',
    'overflow', 'pendingCount', 'records',
  ], 'native invoke probe');
  assert.equal(probe.schemaVersion, 1, 'Unsupported native invoke probe version');
  assert.equal(probe.label, 'native-invoke-completion-v1', 'Unexpected native invoke probe label');
  assert.equal(probe.maxRecords, 64, 'Unexpected native invoke record bound');
  assert.equal(probe.overflow, false, 'Native invoke probe overflowed');
  assert.equal(probe.pendingCount, 0, 'Native invoke probe has pending calls');
  assert(Number.isFinite(probe.installedAtMs) && probe.installedAtMs >= 0, 'Invalid invoke install clock');
  assert(Number.isFinite(probe.stoppedAtMs) && probe.stoppedAtMs >= probe.installedAtMs,
    'Invalid invoke stop clock');
  assert(Array.isArray(probe.records) && probe.records.length <= probe.maxRecords,
    'Invalid native invoke records');

  const commandCounts = { save_data: 0, save_task: 0, get_data: 0 };
  for (const [index, record] of probe.records.entries()) {
    exactKeys(record, ['command', 'sequence', 'startMs', 'returnedMs', 'settledMs', 'outcome'],
      'native invoke record');
    assert(['save_data', 'save_task', 'get_data'].includes(record.command), 'Unexpected native invoke command');
    assert(['fulfilled', 'rejected', 'threw'].includes(record.outcome), 'Unexpected native invoke outcome');
    assert.equal(record.sequence, index + 1, 'Native invoke sequences must be unique and contiguous');
    for (const field of ['startMs', 'returnedMs', 'settledMs']) {
      assert(Number.isFinite(record[field]) && record[field] >= 0, `Invalid native invoke ${field}`);
    }
    assert(record.startMs >= probe.installedAtMs
      && record.returnedMs >= record.startMs
      && record.settledMs >= record.returnedMs
      && probe.stoppedAtMs >= record.settledMs, 'Invalid native invoke clock order');
    commandCounts[record.command] += 1;
  }
  assert(commandCounts.save_data + commandCounts.save_task > 0,
    'Native invoke probe observed no persistence call');
  return { label: probe.label, callCount: probe.records.length, commandCounts };
}
