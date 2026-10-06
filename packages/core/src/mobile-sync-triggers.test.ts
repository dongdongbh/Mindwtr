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
