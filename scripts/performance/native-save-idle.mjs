import assert from 'node:assert/strict';

export function isNativeSaveIdle(status) {
  assert(status?.core && status?.desktop, 'Missing native save-queue observation hook');
  const { core, desktop } = status;
  for (const value of [core.queued, core.immediate, core.generation, desktop.pending, desktop.generation]) {
    assert(Number.isSafeInteger(value) && value >= 0, 'Malformed save-queue count');
  }
  for (const value of [core.inFlight, core.retrying, core.failed, desktop.failed, desktop.reconciliationPending]) {
    assert.equal(typeof value, 'boolean', 'Malformed save-queue state');
  }
  assert(!core.failed && !desktop.failed, 'Persistence failed before measurement');
  return !core.queued && !core.immediate && !core.inFlight && !core.retrying
    && !desktop.pending && !desktop.reconciliationPending;
}

// Two idle observations with unchanged generations across event-loop turns.
// This is a boundary on known local work, not a promise against future writers.
export async function waitForNativeSaveIdle(read, { timeoutMs = 60_000, pollMs = 50,
  now = () => performance.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const start = now();
  let previous = null;
  let polls = 0;
  while (now() - start < timeoutMs) {
    const status = await read();
    const idle = isNativeSaveIdle(status);
    const generation = `${status.core.generation}:${status.desktop.generation}`;
    polls++;
    if (idle && previous === generation) return { waitMs: now() - start, polls, status };
    previous = idle ? generation : null;
    await sleep(pollMs);
  }
  throw new Error('Timed out waiting for native save queues to become idle');
}
