import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  backgroundSyncFailureCooldownMs,
  createMobileBackgroundSyncRunner,
  MOBILE_BACKGROUND_SYNC_DEADLINE_MS,
  MOBILE_BACKGROUND_SYNC_MAX_FAILURE_COOLDOWN_MS,
  shouldScheduleMobileBackgroundSync,
  supportsMobileScheduledBackgroundSync,
  type MobileBackgroundSyncPorts,
} from './mobile-background-sync';
import { BACKGROUND_SYNC_FAILURE_STATE_KEY } from './sync-storage-keys';

const INTERVAL_MS = 15 * 60_000;

const createPorts = (overrides: Partial<MobileBackgroundSyncPorts['sync']> = {}) => {
  const values = new Map<string, string>();
  const appStateListeners = new Set<(state: string) => void>();
  const logs: Array<{ level: string; message: string; extra?: Record<string, string> }> = [];
  const ports = {
    storage: {
      getItem: vi.fn(async (key: string) => values.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
      removeItem: vi.fn(async (key: string) => { values.delete(key); }),
    },
    log: {
      info: (message: string, context: { extra?: Record<string, string> }) => { logs.push({ level: 'info', message, extra: context.extra }); },
      warn: (message: string, context: { extra?: Record<string, string> }) => { logs.push({ level: 'warn', message, extra: context.extra }); },
    },
    sync: {
      getConfigurationStatus: vi.fn(async () => ({ backend: 'webdav', configured: true })),
      performSync: vi.fn(async () => ({ success: true } as { success: boolean; error?: string })),
      abort: vi.fn(),
      setRequestDeadline: vi.fn(),
      ...overrides,
    },
    flushPendingSave: vi.fn(async () => undefined),
    drainPendingCaptures: vi.fn(async () => 0),
    quiesceStorage: vi.fn(async () => undefined),
    timersPaused: () => true,
    onAppStateChange: (listener: (state: string) => void) => {
      appStateListeners.add(listener);
      return { remove: () => { appStateListeners.delete(listener); } };
    },
  } satisfies MobileBackgroundSyncPorts;
  const failureRecord = () => {
    const raw = values.get(BACKGROUND_SYNC_FAILURE_STATE_KEY);
    return raw ? JSON.parse(raw) as { lastFailureAt: number; consecutiveFailures: number } : null;
  };
  const setFailureRecord = (waitedMs: number, consecutiveFailures: number) => {
    values.set(BACKGROUND_SYNC_FAILURE_STATE_KEY, JSON.stringify({ lastFailureAt: Date.now() - waitedMs, consecutiveFailures }));
  };
  const emitAppState = (state: string) => appStateListeners.forEach((listener) => listener(state));
  return { ports, logs, failureRecord, setFailureRecord, emitAppState };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('mobile background sync policy', () => {
  it('runs WebDAV, self-hosted cloud, Dropbox and CloudKit in the background, never File Sync', () => {
    expect(['webdav', 'cloud', 'cloudkit'].every(supportsMobileScheduledBackgroundSync)).toBe(true);
    expect(supportsMobileScheduledBackgroundSync('file')).toBe(false);
    expect(supportsMobileScheduledBackgroundSync('off')).toBe(false);
    expect(shouldScheduleMobileBackgroundSync({ schedulerAvailable: true, configured: true, backend: 'webdav' })).toBe(true);
    expect(shouldScheduleMobileBackgroundSync({ schedulerAvailable: false, configured: true, backend: 'webdav' })).toBe(false);
    expect(shouldScheduleMobileBackgroundSync({ schedulerAvailable: true, configured: false, backend: 'cloud' })).toBe(false);
    expect(shouldScheduleMobileBackgroundSync({ schedulerAvailable: true, configured: true, backend: 'file' })).toBe(false);
  });

  it('doubles the failure cooldown from one interval up to two hours', () => {
    expect(backgroundSyncFailureCooldownMs(1)).toBe(INTERVAL_MS);
    expect(backgroundSyncFailureCooldownMs(2)).toBe(2 * INTERVAL_MS);
    expect(backgroundSyncFailureCooldownMs(4)).toBe(8 * INTERVAL_MS);
    expect(backgroundSyncFailureCooldownMs(40)).toBe(MOBILE_BACKGROUND_SYNC_MAX_FAILURE_COOLDOWN_MS);
    expect(MOBILE_BACKGROUND_SYNC_MAX_FAILURE_COOLDOWN_MS).toBe(2 * 60 * 60_000);
  });

  it('skips File Sync and unconfigured sync as a successful no-op', async () => {
    const fake = createPorts({ getConfigurationStatus: vi.fn(async () => ({ backend: 'file', configured: true })) });
    const runner = createMobileBackgroundSyncRunner(fake.ports);

    await expect(runner.run('scheduled')).resolves.toBe('success');
    expect(fake.ports.sync.performSync).not.toHaveBeenCalled();
    expect(fake.ports.flushPendingSave).not.toHaveBeenCalled();
    expect(fake.ports.quiesceStorage).toHaveBeenCalledTimes(1);
  });

  it('records failures, sits out the cooldown, and clears the record after a success', async () => {
    const fake = createPorts({ performSync: vi.fn(async () => ({ success: false, error: 'auth failed' })) });
    const runner = createMobileBackgroundSyncRunner(fake.ports);

    await expect(runner.run('scheduled')).resolves.toBe('failed');
    expect(fake.failureRecord()).toMatchObject({ consecutiveFailures: 1 });

    fake.setFailureRecord(INTERVAL_MS, 2);
    await expect(runner.run('scheduled')).resolves.toBe('success');
    expect(fake.ports.sync.performSync).toHaveBeenCalledTimes(1);
    expect(fake.logs).toContainEqual(expect.objectContaining({ message: 'Mobile background sync skipped during failure cooldown' }));


    fake.ports.drainPendingCaptures.mockResolvedValueOnce(1);
    fake.ports.sync.performSync.mockResolvedValue({ success: true });
    await expect(runner.run('capture')).resolves.toBe('success');
    expect(fake.ports.sync.performSync).toHaveBeenCalledTimes(2);
    expect(fake.failureRecord()).toBeNull();
  });

  it('does not sync for a capture the visible app already imported', async () => {
    const fake = createPorts();
    const runner = createMobileBackgroundSyncRunner(fake.ports);

    await expect(runner.run('capture')).resolves.toBe('success');
    expect(fake.ports.sync.performSync).not.toHaveBeenCalled();
  });

  it('abandons a run at the 4-minute deadline and clears the request deadline', async () => {
    vi.useFakeTimers();
    const fake = createPorts({ performSync: vi.fn(() => new Promise<never>(() => undefined)) });
    const runner = createMobileBackgroundSyncRunner(fake.ports);

    const run = runner.run('scheduled');
    await vi.advanceTimersByTimeAsync(MOBILE_BACKGROUND_SYNC_DEADLINE_MS - 1);
    expect(fake.ports.sync.abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await expect(run).resolves.toBe('failed');
    expect(fake.ports.sync.abort).toHaveBeenCalledTimes(1);
    expect(fake.ports.sync.setRequestDeadline.mock.calls.at(-1)?.[0]).toBeNull();
    expect(fake.logs).toContainEqual(expect.objectContaining({
      message: 'Mobile background sync did not finish before its deadline and was abandoned',
      extra: expect.objectContaining({ stage: 'timer' }),
    }));
    expect(fake.failureRecord()).toMatchObject({ consecutiveFailures: 1 });
  });

  it('abandons a run at the deadline its host gives (the native app\'s debug check), and logs that deadline', async () => {
    vi.useFakeTimers();
    const fake = createPorts({ performSync: vi.fn(() => new Promise<never>(() => undefined)) });
    const runner = createMobileBackgroundSyncRunner({ ...fake.ports, deadlineMs: () => 15_000 });

    const run = runner.run('scheduled');
    await vi.advanceTimersByTimeAsync(14_999);
    expect(fake.ports.sync.abort).not.toHaveBeenCalled();
    expect(fake.ports.sync.setRequestDeadline.mock.calls[0]?.[0]).toBe(Date.now() + 1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(run).resolves.toBe('failed');
    expect(fake.ports.sync.abort).toHaveBeenCalledTimes(1);
    expect(fake.logs).toContainEqual(expect.objectContaining({
      message: 'Mobile background sync did not finish before its deadline and was abandoned',
      extra: expect.objectContaining({ deadlineMs: '15000', stage: 'timer' }),
    }));
  });

  it('abandons a run resumed past its deadline as soon as the app is active again', async () => {
    vi.useFakeTimers();
    const fake = createPorts({ performSync: vi.fn(() => new Promise<never>(() => undefined)) });
    const runner = createMobileBackgroundSyncRunner(fake.ports);

    const startedAt = Date.now();
    const run = runner.run('scheduled');
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(startedAt + MOBILE_BACKGROUND_SYNC_DEADLINE_MS + 5_000);
    fake.emitAppState('active');

    await expect(run).resolves.toBe('failed');
    expect(fake.logs).toContainEqual(expect.objectContaining({ extra: expect.objectContaining({ stage: 'resume' }) }));
  });

  it('shares one run between overlapping invocations', async () => {
    let finish: (value: { success: boolean }) => void = () => undefined;
    const fake = createPorts({ performSync: vi.fn(() => new Promise<{ success: boolean }>((resolve) => { finish = resolve; })) });
    const runner = createMobileBackgroundSyncRunner(fake.ports);

    const runs = Promise.all([runner.run('scheduled'), runner.run('scheduled'), runner.run('scheduled')]);
    await vi.waitFor(() => expect(fake.ports.sync.performSync).toHaveBeenCalledTimes(1));
    expect(runner.getInFlightRun()).not.toBeNull();
    finish({ success: true });

    await expect(runs).resolves.toEqual(['success', 'success', 'success']);
    expect(runner.getInFlightRun()).toBeNull();
  });
});
