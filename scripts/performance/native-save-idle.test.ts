import { expect, it } from 'bun:test';
import { isNativeSaveIdle, waitForNativeSaveIdle } from './native-save-idle.mjs';

const idle = () => ({ core: { queued: 0, immediate: 0, inFlight: false, retrying: false, generation: 1, failed: false },
  desktop: { pending: 0, generation: 1, failed: false, reconciliationPending: false } });

it('rejects missing, failed and malformed state; every pending phase blocks readiness', () => {
  expect(() => isNativeSaveIdle(null)).toThrow();
  for (const part of ['core', 'desktop'] as const) {
    const failed = idle(); failed[part].failed = true;
    expect(() => isNativeSaveIdle(failed)).toThrow();
  }
  for (const [part, field, value] of [['core', 'queued', 1], ['core', 'immediate', 1],
    ['core', 'inFlight', true], ['core', 'retrying', true], ['desktop', 'pending', 1],
    ['desktop', 'reconciliationPending', true]] as const) {
    const status = idle(); (status[part] as Record<string, unknown>)[field] = value;
    expect(isNativeSaveIdle(status)).toBe(false);
  }
  expect(() => isNativeSaveIdle({ ...idle(), core: {} })).toThrow();
  expect(isNativeSaveIdle(idle())).toBe(true);
});

it('waits across dispatch, commit and new generations without flushing', async () => {
  const queued = idle(); queued.core.queued = 1;
  const active = idle(); active.desktop.pending = 1;
  const newer = idle(); newer.core.generation++;
  const states = [queued, active, idle(), newer, newer];
  let time = 0;
  const result = await waitForNativeSaveIdle(async () => states.shift(), {
    now: () => time, sleep: async ms => { time += ms; },
  });
  expect(result.polls).toBe(5);
  expect(result.waitMs).toBe(200);
});

it('fails a permanently pending or failing queue instead of reporting a fast sample', async () => {
  let time = 0;
  const busy = idle(); busy.core.queued = 1;
  await expect(waitForNativeSaveIdle(async () => busy, {
    timeoutMs: 100, now: () => time, sleep: async ms => { time += ms; },
  })).rejects.toThrow('Timed out');
  await expect(waitForNativeSaveIdle(async () => null)).rejects.toThrow('Missing');
});
