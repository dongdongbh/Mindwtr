import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NativeAttachmentCleanupUnconfirmedError } from './native-attachment-cleanup';
import * as autoSyncController from './auto-sync-controller';

import {
  createMobileSyncTriggers,
  getMobileAutoSyncCadence,
  MOBILE_AUTO_SYNC_CADENCE_FILE,
  MOBILE_AUTO_SYNC_CADENCE_OFF,
  MOBILE_AUTO_SYNC_CADENCE_REMOTE,
  type MobileSyncTriggerPorts,
} from './mobile-sync-triggers';

const createPorts = (overrides: Partial<MobileSyncTriggerPorts> = {}) => {
  let fingerprint = 'sync-change:1';
  const ports: MobileSyncTriggerPorts = {
    initialAppState: 'active',
    performSync: vi.fn(async () => ({ success: true } as { success: boolean; error?: string })),
    abortSync: vi.fn(),
    flushPendingSave: vi.fn(async () => undefined),
    reconcileBackgroundSync: vi.fn(),
    readStoredBackend: vi.fn(async () => 'webdav'),
    resolveSupportedBackend: (raw) => raw ?? 'off',
    getSyncChangeFingerprint: () => fingerprint,
    isLikelyOfflineSyncError: (error) => /offline/i.test(error),
    classifySyncFailure: (error) => (/401/.test(error) ? 'auth' : 'unknown'),
    reportError: vi.fn(),
    logWarn: vi.fn(),
    showSyncIssue: vi.fn(),
    ...overrides,
  };
  return { ports, setFingerprint: (next: string) => { fingerprint = next; } };
};

const flush = async () => {
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('mobile sync triggers', () => {
  it('paces File Sync slower than a remote backend, and sync off slowest', () => {
    expect(getMobileAutoSyncCadence('file')).toBe(MOBILE_AUTO_SYNC_CADENCE_FILE);
    for (const backend of ['webdav', 'cloud', 'cloudkit']) {
      expect(getMobileAutoSyncCadence(backend)).toBe(MOBILE_AUTO_SYNC_CADENCE_REMOTE);
    }
    expect(getMobileAutoSyncCadence('off')).toBe(MOBILE_AUTO_SYNC_CADENCE_OFF);
    expect(MOBILE_AUTO_SYNC_CADENCE_REMOTE).toEqual({
      minIntervalMs: 5_000,
      debounceFirstChangeMs: 2_000,
      debounceContinuousChangeMs: 5_000,
      foregroundMinIntervalMs: 30_000,
    });
  });

  it('aborts the running cycle and syncs once when the app leaves the foreground', async () => {
    const { ports } = createPorts();
    const triggers = createMobileSyncTriggers(ports);
    triggers.start();
    await flush();

    expect(triggers.handleAppStateChange('background')).toBe('left');
    await flush();

    expect(ports.abortSync).toHaveBeenCalledTimes(1);
    expect(ports.reconcileBackgroundSync).toHaveBeenCalledTimes(2);
    expect(ports.performSync).toHaveBeenCalledTimes(1);
    triggers.dispose();
  });

  it('dedupes a quick background and foreground round trip with an unchanged payload', async () => {
    const { ports } = createPorts();
    const triggers = createMobileSyncTriggers(ports);
    triggers.start();
    await flush();

    triggers.handleAppStateChange('background');
    await flush();
    expect(triggers.handleAppStateChange('active')).toBe('resumed');
    await flush();
    triggers.handleAppStateChange('background');
    await flush();
    triggers.handleAppStateChange('active');
    await flush();

    expect(ports.performSync).toHaveBeenCalledTimes(1);
    triggers.dispose();
  });

  it('syncs on resume only after the foreground interval since the last automatic sync', async () => {
    const { ports } = createPorts({ initialAppState: 'background' });
    const triggers = createMobileSyncTriggers(ports);
    triggers.start();
    await flush();

    expect(triggers.handleAppStateChange('active')).toBe('resumed');
    await flush();
    expect(ports.performSync).toHaveBeenCalledTimes(1);

    triggers.handleAppStateChange('inactive');
    await flush();
    const afterLeave = vi.mocked(ports.performSync).mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    triggers.handleAppStateChange('active');
    await flush();
    // Within 30 s of the last automatic sync: no foreground sync.
    expect(ports.performSync).toHaveBeenCalledTimes(afterLeave);
    triggers.dispose();
  });

  it('syncs a data change after the debounce only when the sync payload changed', async () => {
    const fake = createPorts();
    const triggers = createMobileSyncTriggers(fake.ports);
    triggers.start();
    await flush();

    triggers.handleStoreChange({ lastDataChangeAt: 2 }, { lastDataChangeAt: 1 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fake.ports.performSync).not.toHaveBeenCalled();

    fake.setFingerprint('sync-change:2');
    triggers.handleStoreChange({ lastDataChangeAt: 3 }, { lastDataChangeAt: 2 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fake.ports.performSync).toHaveBeenCalledTimes(1);
    triggers.dispose();
  });

  it('warns once for a repeated automatic failure and ignores offline failures', async () => {
    const { ports } = createPorts({ performSync: vi.fn(async () => ({ success: false, error: 'HTTP 401' })) });
    const triggers = createMobileSyncTriggers(ports);
    triggers.start();
    await flush();

    triggers.requestSync(0);
    await flush();
    expect(ports.showSyncIssue).toHaveBeenCalledWith('auth');
    expect(ports.logWarn).toHaveBeenCalledWith('Auto-sync failed', { scope: 'sync', extra: { error: 'HTTP 401' } });

    // The cooldown retry fails the same way within ten minutes: no second warning.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ports.performSync).toHaveBeenCalledTimes(2);
    expect(ports.showSyncIssue).toHaveBeenCalledTimes(1);
    triggers.dispose();

    const offline = createPorts({ performSync: vi.fn(async () => ({ success: false, error: 'Network offline' })) });
    const offlineTriggers = createMobileSyncTriggers(offline.ports);
    offlineTriggers.start();
    offlineTriggers.requestSync(0);
    await flush();
    expect(offline.ports.showSyncIssue).not.toHaveBeenCalled();
    offlineTriggers.dispose();
  });

  it('a finished manual sync cancels the automatic retry', async () => {
    const { ports } = createPorts({ performSync: vi.fn(async () => ({ success: false, error: 'HTTP 401' })) });
    const triggers = createMobileSyncTriggers(ports);
    triggers.start();
    triggers.requestSync(0);
    await flush();
    expect(ports.performSync).toHaveBeenCalledTimes(1);

    triggers.handleStoreChange(
      { lastDataChangeAt: 1, settings: { lastSyncStatus: 'success', lastSyncAt: '2026-09-28T12:01:00.000Z' } },
      { lastDataChangeAt: 1, settings: { lastSyncStatus: 'error', lastSyncAt: '2026-09-28T12:00:00.000Z' } },
    );
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(ports.performSync).toHaveBeenCalledTimes(1);
    triggers.dispose();
  });

  it('quarantines every trigger and queued timer after an unconfirmed native cleanup', async () => {
    const fatal = new NativeAttachmentCleanupUnconfirmedError();
    let rejectSync!: (error: unknown) => void;
    const pendingSync = new Promise<{ success: boolean }>((_resolve, reject) => { rejectSync = reject; });
    const fake = createPorts({
      performSync: vi.fn(() => pendingSync),
      getSyncChangeFingerprint: vi.fn(() => 'changed'),
      resolveSupportedBackend: vi.fn((raw) => raw ?? 'off'),
      isLikelyOfflineSyncError: vi.fn(() => false),
      classifySyncFailure: vi.fn(() => 'unknown'),
    });
    const { ports } = fake;
    const triggers = createMobileSyncTriggers(ports);
    triggers.start();
    await flush();
    triggers.requestSync(0);
    await flush();
    expect(ports.performSync).toHaveBeenCalledTimes(1);
    triggers.handleStoreChange({ lastDataChangeAt: 2 }, { lastDataChangeAt: 1 });
    triggers.requestSync(0);
    triggers.handleCloudKitChange();

    rejectSync(fatal);
    await flush();
    expect(triggers.isRuntimeActive()).toBe(false);
    expect(ports.reportError).not.toHaveBeenCalled();
    expect(ports.logWarn).not.toHaveBeenCalled();
    expect(ports.showSyncIssue).not.toHaveBeenCalled();
    const callsAtFatal = Object.values(ports).filter(vi.isMockFunction).map((port) => port.mock.calls.length);

    triggers.start();
    triggers.requestSync();
    triggers.requestSync(0);
    triggers.handleStoreChange(
      { lastDataChangeAt: 3, settings: { lastSyncStatus: 'success', lastSyncAt: 'later' } },
      { lastDataChangeAt: 2 },
    );
    triggers.handleCloudKitChange();
    expect(triggers.handleAppStateChange('inactive')).toBeNull();
    expect(triggers.handleAppStateChange('background')).toBeNull();
    expect(triggers.handleAppStateChange('active')).toBeNull();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(Object.values(ports).filter(vi.isMockFunction).map((port) => port.mock.calls.length)).toEqual(callsAtFatal);
    expect(vi.getTimerCount()).toBe(0);
    triggers.dispose();
  });

  it.each(['performSync', 'flushPendingSave'] as const)(
    'propagates the exact fatal from %s through the real controller without ordinary reporting',
    async (port) => {
      const fatal = new NativeAttachmentCleanupUnconfirmedError();
      const createController = autoSyncController.createAutoSyncController;
      const runs: Promise<void>[] = [];
      vi.spyOn(autoSyncController, 'createAutoSyncController').mockImplementation((options) => {
        const controller = createController(options);
        return {
          ...controller,
          requestAutoSync: (...args) => {
            const run = controller.requestAutoSync(...args);
            runs.push(run);
            return run;
          },
        };
      });
      const { ports } = createPorts({ [port]: vi.fn(async () => { throw fatal; }) });
      const triggers = createMobileSyncTriggers(ports);
      triggers.start();
      await flush();
      triggers.requestSync(0);
      // Observe the actual request rejection; the public trigger owns its quiet catch.
      await expect(runs[0]).rejects.toBe(fatal);
      await flush();

      expect(triggers.isRuntimeActive()).toBe(false);
      expect(ports.flushPendingSave).toHaveBeenCalledTimes(1);
      expect(ports.performSync).toHaveBeenCalledTimes(port === 'performSync' ? 1 : 0);
      expect(ports.reportError).not.toHaveBeenCalled();
      expect(ports.logWarn).not.toHaveBeenCalled();
      expect(ports.showSyncIssue).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(runs).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
      triggers.dispose();
    },
  );

  it.each(['resolve', 'reject'] as const)(
    'ignores held cadence %s after fatal, including resume, request and debounce continuations',
    async (completion) => {
      const fatal = new NativeAttachmentCleanupUnconfirmedError();
      let resolveBackend!: (backend: string) => void;
      let rejectBackend!: (error: unknown) => void;
      const backend = new Promise<string>((resolve, reject) => {
        resolveBackend = resolve;
        rejectBackend = reject;
      });
      const fingerprint = vi.fn().mockReturnValueOnce('initial').mockReturnValue('changed');
      const { ports } = createPorts({
        initialAppState: 'background',
        performSync: vi.fn(async () => { throw fatal; }),
        getSyncChangeFingerprint: fingerprint,
        resolveSupportedBackend: vi.fn((raw) => raw ?? 'off'),
      });
      const triggers = createMobileSyncTriggers(ports);
      triggers.start();
      await flush();
      await vi.advanceTimersByTimeAsync(6_000);
      vi.mocked(ports.readStoredBackend).mockReturnValue(backend);
      triggers.requestSync();
      expect(triggers.handleAppStateChange('active')).toBe('resumed');
      triggers.handleStoreChange({ lastDataChangeAt: 2 }, { lastDataChangeAt: 1 });
      await vi.advanceTimersByTimeAsync(2_000);
      // All three continuations have a real outstanding cadence port.
      expect(ports.readStoredBackend).toHaveBeenCalledTimes(4);
      triggers.requestSync(0);
      await flush();
      expect(triggers.isRuntimeActive()).toBe(false);
      const callsAtFatal = Object.values(ports).filter(vi.isMockFunction).map((port) => port.mock.calls.length);

      if (completion === 'resolve') resolveBackend('file');
      else rejectBackend(new Error('late cadence refusal'));
      await flush();
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(Object.values(ports).filter(vi.isMockFunction).map((port) => port.mock.calls.length)).toEqual(callsAtFatal);
      expect(ports.reportError).not.toHaveBeenCalled();
      expect(ports.logWarn).not.toHaveBeenCalled();
      expect(ports.showSyncIssue).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      triggers.dispose();
    },
  );

  it('continues an ordinary flush refusal and reports its original error', async () => {
    const error = new Error('ordinary flush refusal');
    const { ports } = createPorts({ flushPendingSave: vi.fn(async () => { throw error; }) });
    const triggers = createMobileSyncTriggers(ports);
    triggers.start();
    triggers.requestSync(0);
    await flush();

    expect(triggers.isRuntimeActive()).toBe(true);
    expect(ports.reportError).toHaveBeenCalledExactlyOnceWith(error);
    expect(ports.performSync).toHaveBeenCalledTimes(1);
    expect(ports.logWarn).not.toHaveBeenCalled();
    triggers.dispose();
  });

  it('keeps ordinary cooldown behavior for an Error merely named like the fatal class', async () => {
    const error = new Error('HTTP 401');
    error.name = 'NativeAttachmentCleanupUnconfirmedError';
    const { ports } = createPorts({ performSync: vi.fn(async () => { throw error; }) });
    const triggers = createMobileSyncTriggers(ports);
    triggers.start();
    triggers.requestSync(0);
    await flush();

    expect(triggers.isRuntimeActive()).toBe(true);
    expect(ports.showSyncIssue).toHaveBeenCalledExactlyOnceWith('auth');
    expect(ports.logWarn).toHaveBeenCalledExactlyOnceWith('Auto-sync failed', {
      scope: 'sync', extra: { error: String(error) },
    });
    expect(ports.reportError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ports.performSync).toHaveBeenCalledTimes(2);
    expect(ports.showSyncIssue).toHaveBeenCalledTimes(1);
    triggers.dispose();
  });

  it('does not classify or schedule an ordinary result after a late fingerprint fatal', async () => {
    const fatal = new NativeAttachmentCleanupUnconfirmedError();
    let shouldThrow = false;
    let triggers: ReturnType<typeof createMobileSyncTriggers>;
    const { ports } = createPorts({
      performSync: vi.fn(async () => {
        queueMicrotask(() => queueMicrotask(() => {
          shouldThrow = true;
          triggers.handleAppStateChange('background');
        }));
        return { success: false, error: 'HTTP 401' };
      }),
      getSyncChangeFingerprint: vi.fn(() => {
        if (shouldThrow) throw fatal;
        return 'initial';
      }),
      isLikelyOfflineSyncError: vi.fn(() => false),
    });
    triggers = createMobileSyncTriggers(ports);
    triggers.start();
    await flush();
    triggers.requestSync(0);
    await flush();
    expect(triggers.isRuntimeActive()).toBe(false);
    expect(ports.isLikelyOfflineSyncError).not.toHaveBeenCalled();
    expect(ports.reportError).not.toHaveBeenCalled();
    expect(ports.logWarn).not.toHaveBeenCalled();
    expect(ports.showSyncIssue).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    triggers.dispose();
  });

  it('does nothing after dispose', async () => {
    const { ports } = createPorts();
    const triggers = createMobileSyncTriggers(ports);
    triggers.start();
    triggers.dispose();

    expect(triggers.isRuntimeActive()).toBe(false);
    expect(triggers.handleAppStateChange('background')).toBeNull();
    triggers.requestSync(0);
    triggers.handleCloudKitChange();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ports.performSync).not.toHaveBeenCalled();
    expect(ports.abortSync).not.toHaveBeenCalled();
  });
});

// #1431: the issue's harness on the real triggers, controller and orchestrator. The opening
// sync takes 1,919 ms and finds no changes; a save changes the fingerprint and lastDataChangeAt.
describe('mobile sync triggers: a local change after a sync (#1431)', () => {
  const OPENING_MS = 1_919;

  const replay = async ({ openingMs = OPENING_MS, cycleMs = 0, results }: {
    openingMs?: number;
    cycleMs?: number;
    results?: Array<{ success: boolean; error?: string }>;
  } = {}) => {
    const base = Date.now();
    const runs: number[] = [];
    const pendingChanges: boolean[] = [];
    let lastDataChangeAt = 0;
    const fake = createPorts({
      initialAppState: 'background',
      readStoredBackend: vi.fn(async () => 'cloud'),
      performSync: vi.fn(async () => {
        runs.push(Date.now() - base);
        const duration = runs.length === 1 ? openingMs : cycleMs;
        if (duration > 0) await new Promise((resolve) => setTimeout(resolve, duration));
        return results?.shift() ?? { success: true };
      }),
      logInfo: vi.fn(),
      onLocalChangePendingChange: (pending) => { pendingChanges.push(pending); },
    });
    const triggers = createMobileSyncTriggers(fake.ports);
    triggers.start();
    await flush();
    triggers.handleAppStateChange('active');
    await flush();
    expect(runs).toEqual([0]);
    await vi.advanceTimersByTimeAsync(openingMs);
    let saves = 0;
    const advanceTo = (offsetMs: number) => vi.advanceTimersByTimeAsync(Math.max(0, base + offsetMs - Date.now()));
    const save = async (offsetMs: number) => {
      await advanceTo(offsetMs);
      saves += 1;
      fake.setFingerprint(`tasks:${3416 + saves}`);
      const previous = lastDataChangeAt;
      lastDataChangeAt = Date.now();
      triggers.handleStoreChange({ lastDataChangeAt }, { lastDataChangeAt: previous });
    };
    return { triggers, fake, runs, pendingChanges, save, advanceTo };
  };

  it.each([3_000, 6_000, 9_000, 12_000])('uploads a save at %i ms after the debounce, not after nine opening-sync durations', async (saveMs) => {
    const { triggers, runs, save, advanceTo } = await replay();
    await save(saveMs);
    await advanceTo(20_000);
    // The 2 s debounce, never closer than the 5 s minimum gap after the opening sync ended.
    // Before the fix every save waited until 9 x 1,919 ms after the opening sync: 19,190 ms.
    expect(runs).toEqual([0, Math.max(saveMs + 2_000, OPENING_MS + 5_000)]);
    triggers.dispose();
  });

  it('still uploads at once when the app goes inactive before the debounce', async () => {
    const { triggers, runs, save, advanceTo } = await replay();
    await save(9_000);
    await advanceTo(10_000);
    triggers.handleAppStateChange('inactive');
    await flush();
    expect(runs).toEqual([0, 10_000]);
    await advanceTo(30_000);
    expect(runs).toEqual([0, 10_000]);
    triggers.dispose();
  });

  it('keeps the control case: an instant opening sync uploads a save after the debounce', async () => {
    const { triggers, fake, runs, save, advanceTo } = await replay({ openingMs: 0 });
    await save(9_000);
    await advanceTo(20_000);
    expect(runs).toEqual([0, 11_000]);
    // Nothing was stretched, so nothing is logged as skipped.
    expect(fake.ports.logInfo).not.toHaveBeenCalled();
    triggers.dispose();
  });

  it('logs one bounded release-check line when a save skips the adaptive wait', async () => {
    const { triggers, fake, save, advanceTo } = await replay();
    await save(9_000);
    await advanceTo(20_000);
    expect(fake.ports.logInfo).toHaveBeenCalledTimes(1);
    expect(fake.ports.logInfo).toHaveBeenCalledWith('Auto sync local change skipped adaptive pacing', {
      scope: 'sync',
      extra: {
        releaseCheck: 'v1.3.7/local-change-upload',
        source: 'data-change',
        delayMs: '0',
        adaptiveWaitMs: String(9 * OPENING_MS - (11_000 - OPENING_MS)),
      },
    });
    triggers.dispose();
  });

  it('keeps the adaptive wait for back-to-back local uploads (#766)', async () => {
    const { triggers, runs, save, advanceTo } = await replay({ cycleMs: 2_000 });
    await save(9_000);
    await advanceTo(14_000);
    expect(runs).toEqual([0, 11_000]);
    // The upload ended at 13,000 and carried a local change, so the next one waits 9 x 2,000 ms.
    await save(14_000);
    await advanceTo(30_999);
    expect(runs).toEqual([0, 11_000]);
    await advanceTo(31_000);
    expect(runs).toEqual([0, 11_000, 31_000]);
    triggers.dispose();
  });

  it('shows pending from the save until the cycle that started after it succeeds', async () => {
    const { triggers, runs, pendingChanges, save, advanceTo } = await replay({ cycleMs: 1_000 });
    expect(triggers.hasPendingLocalChange()).toBe(false);
    await save(9_000);
    expect(triggers.hasPendingLocalChange()).toBe(true);
    expect(pendingChanges).toEqual([true]);
    // An edit during the upload is not covered by it.
    await save(11_500);
    await advanceTo(12_000);
    expect(runs).toEqual([0, 11_000]);
    expect(triggers.hasPendingLocalChange()).toBe(true);
    expect(pendingChanges).toEqual([true]);
    await advanceTo(60_000);
    expect(runs.length).toBe(3);
    expect(triggers.hasPendingLocalChange()).toBe(false);
    expect(pendingChanges).toEqual([true, false]);
    triggers.dispose();
  });

  it('keeps pending after a failed upload', async () => {
    const { triggers, runs, save, advanceTo } = await replay({
      results: [{ success: true }, { success: false, error: 'Network offline' }],
    });
    await save(9_000);
    await advanceTo(12_000);
    expect(runs).toEqual([0, 11_000]);
    expect(triggers.hasPendingLocalChange()).toBe(true);
    triggers.dispose();
  });

  it('clears pending without a cycle when a write leaves the payload as uploaded', async () => {
    const { triggers, fake, runs, pendingChanges, advanceTo } = await replay();
    // The opening sync uploaded 'sync-change:1'; this write changes lastDataChangeAt only.
    await advanceTo(9_000);
    triggers.handleStoreChange({ lastDataChangeAt: 2 }, { lastDataChangeAt: 1 });
    expect(triggers.hasPendingLocalChange()).toBe(true);
    await advanceTo(20_000);
    expect(runs).toEqual([0]);
    expect(triggers.hasPendingLocalChange()).toBe(false);
    expect(pendingChanges).toEqual([true, false]);
    expect(fake.ports.logInfo).not.toHaveBeenCalled();
    triggers.dispose();
  });
});

// #1432: iOS suspends the app seconds after it leaves the foreground. A sync running or starting
// then holds one OS background hold until it and every queued follow-up settle.
describe('mobile sync triggers background hold', () => {
  type SyncResult = { success: boolean; error?: string };
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };

  const setup = (overrides: Partial<MobileSyncTriggerPorts> = {}) => {
    const holds: Array<{ onExpire: () => void; release: ReturnType<typeof vi.fn> }> = [];
    const cycles: Array<ReturnType<typeof deferred<SyncResult>>> = [];
    const fake = createPorts({
      performSync: vi.fn(() => {
        const cycle = deferred<SyncResult>();
        cycles.push(cycle);
        return cycle.promise;
      }),
      holdBackgroundExecution: vi.fn((onExpire: () => void) => {
        const release = vi.fn();
        holds.push({ onExpire, release });
        return release;
      }),
      logInfo: vi.fn(),
      ...overrides,
    });
    const triggers = createMobileSyncTriggers(fake.ports);
    triggers.start();
    const holdLines = () => vi.mocked(fake.ports.logInfo!).mock.calls
      .filter(([, context]) => context.extra.releaseCheck === 'v1.3.7/ios-background-sync-hold')
      .map(([message, context]) => [message, context.extra.outcome ?? context.extra.source]);
    return { ...fake, triggers, holds, cycles, holdLines };
  };

  it('holds while the leave sync runs and releases once when it completes', async () => {
    const { ports, triggers, holds, cycles, holdLines } = setup();
    await flush();

    triggers.handleAppStateChange('inactive');
    await flush();
    expect(ports.holdBackgroundExecution).toHaveBeenCalledTimes(1);
    expect(cycles).toHaveLength(1);
    expect(holds[0].release).not.toHaveBeenCalled();

    cycles[0].resolve({ success: true });
    await flush();
    expect(holds[0].release).toHaveBeenCalledTimes(1);
    expect(holdLines()).toEqual([
      ['Background sync hold started', 'app-left'],
      ['Background sync hold ended', 'completed'],
    ]);
    const ended = vi.mocked(ports.logInfo!).mock.calls.at(-1)![1].extra;
    expect(ended.heldMs).toMatch(/^\d+$/);
    triggers.dispose();
    expect(holds[0].release).toHaveBeenCalledTimes(1);
  });

  it('keeps the hold until queued follow-ups drain', async () => {
    const idle = deferred<void>();
    const { triggers, holds, cycles } = setup({ waitForSyncIdle: vi.fn(() => idle.promise) });
    await flush();

    triggers.handleAppStateChange('inactive');
    await flush();
    cycles[0].resolve({ success: true });
    await flush();
    expect(holds[0].release).not.toHaveBeenCalled();

    idle.resolve();
    await flush();
    expect(holds[0].release).toHaveBeenCalledTimes(1);
    triggers.dispose();
  });

  it.each([
    ['a failed result', (cycle: ReturnType<typeof deferred<SyncResult>>) => cycle.resolve({ success: false, error: 'HTTP 500' })],
    ['a thrown error', (cycle: ReturnType<typeof deferred<SyncResult>>) => cycle.reject(new Error('boom'))],
  ])('releases once as failed after %s', async (_label, settle) => {
    const { triggers, holds, cycles, holdLines } = setup();
    await flush();

    triggers.handleAppStateChange('background');
    await flush();
    settle(cycles[0]);
    await flush();
    expect(holds[0].release).toHaveBeenCalledTimes(1);
    expect(holdLines().at(-1)).toEqual(['Background sync hold ended', 'failed']);
    triggers.dispose();
  });

  it('on expiry aborts the cycle, keeps the change pending and syncs on the next foreground', async () => {
    const { ports, triggers, holds, cycles, holdLines, setFingerprint } = setup();
    await flush();
    setFingerprint('sync-change:2');
    triggers.handleStoreChange({ lastDataChangeAt: 2 }, { lastDataChangeAt: 1 });

    triggers.handleAppStateChange('inactive');
    triggers.handleAppStateChange('background');
    await flush();
    expect(ports.abortSync).toHaveBeenCalledTimes(1);

    holds[0].onExpire();
    expect(ports.abortSync).toHaveBeenCalledTimes(2);
    expect(holds[0].release).toHaveBeenCalledTimes(1);
    expect(holdLines().at(-1)).toEqual(['Background sync hold ended', 'expired']);

    // The lifecycle abort settles as success, but nothing was uploaded.
    cycles[0].resolve({ success: true });
    await flush();
    expect(holds[0].release).toHaveBeenCalledTimes(1);
    expect(triggers.hasPendingLocalChange()).toBe(true);

    // No second hold in the same background episode.
    triggers.handleCloudKitChange();
    await flush();
    expect(ports.holdBackgroundExecution).toHaveBeenCalledTimes(1);

    // That cycle runs unheld and is cut off too.
    cycles[1].resolve({ success: false, error: 'Network offline' });
    await flush();
    expect(triggers.hasPendingLocalChange()).toBe(true);

    // The foreground syncs at once, inside the 30 s foreground interval.
    const before = cycles.length;
    triggers.handleAppStateChange('active');
    await flush();
    expect(cycles.length).toBe(before + 1);
    cycles.at(-1)!.resolve({ success: true });
    await flush();
    expect(triggers.hasPendingLocalChange()).toBe(false);
    triggers.dispose();
  });

  it('holds a cycle already running when the app leaves until its follow-up drains', async () => {
    const idle = deferred<void>();
    const { triggers, holds, cycles, setFingerprint } = setup({ waitForSyncIdle: vi.fn(() => idle.promise) });
    await flush();
    setFingerprint('sync-change:2');
    triggers.handleStoreChange({ lastDataChangeAt: 2 }, { lastDataChangeAt: 1 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(cycles).toHaveLength(1);

    triggers.handleAppStateChange('background');
    await flush();
    expect(holds).toHaveLength(1);
    // The lifecycle abort reports success; it does not cover the change.
    cycles[0].resolve({ success: true });
    await flush();
    expect(triggers.hasPendingLocalChange()).toBe(true);
    expect(holds[0].release).not.toHaveBeenCalled();

    idle.resolve();
    await flush();
    expect(holds[0].release).toHaveBeenCalledTimes(1);
    triggers.dispose();
  });

  it('takes no hold for a foreground-only cycle', async () => {
    const { ports, triggers, cycles, setFingerprint } = setup();
    await flush();
    setFingerprint('sync-change:2');
    triggers.handleStoreChange({ lastDataChangeAt: 2 }, { lastDataChangeAt: 1 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(cycles).toHaveLength(1);
    cycles[0].resolve({ success: true });
    await flush();
    expect(ports.holdBackgroundExecution).not.toHaveBeenCalled();
    triggers.dispose();
  });

  it('takes one hold across rapid inactive and background events', async () => {
    const { ports, triggers, holds, cycles } = setup();
    await flush();

    triggers.handleAppStateChange('inactive');
    triggers.handleAppStateChange('active');
    triggers.handleAppStateChange('inactive');
    triggers.handleAppStateChange('background');
    await flush();
    expect(ports.holdBackgroundExecution).toHaveBeenCalledTimes(1);

    for (const cycle of cycles) cycle.resolve({ success: true });
    await flush();
    for (const cycle of cycles) cycle.resolve({ success: true });
    await flush();
    expect(holds[0].release).toHaveBeenCalledTimes(1);
    triggers.dispose();
  });

  it('releases as aborted when the runtime is disposed mid-hold', async () => {
    const { triggers, holds, holdLines } = setup();
    await flush();
    triggers.handleAppStateChange('background');
    await flush();
    triggers.dispose();
    expect(holds[0].release).toHaveBeenCalledTimes(1);
    expect(holdLines().at(-1)).toEqual(['Background sync hold ended', 'aborted']);
  });

  it('takes no hold when sync is off', async () => {
    const { ports, triggers } = setup({ readStoredBackend: vi.fn(async () => 'off') });
    await flush();
    triggers.handleAppStateChange('background');
    await flush();
    expect(ports.holdBackgroundExecution).not.toHaveBeenCalled();
    triggers.dispose();
  });
});
