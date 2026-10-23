// The mobile apps' automatic sync triggers: what the app does on resume, on leaving the
// foreground, on a data change and on a CloudKit change, the per-backend pacing, the
// app-state dedupe, and when an automatic failure is worth a log line and a warning. It moved
// here from React Native's `hooks/root-layout/use-root-layout-sync-effects.ts` so the native
// app triggers sync by the same rules. The pacing itself is core's `createAutoSyncController`.
import { createAutoSyncController, type AutoSyncCadence, type AutoSyncController } from './auto-sync-controller';
import { NativeAttachmentCleanupUnconfirmedError } from './native-attachment-cleanup';

export type MobileAutoSyncCadence = AutoSyncCadence & {
  foregroundMinIntervalMs: number;
};

const AUTO_SYNC_BACKEND_CACHE_TTL_MS = 5_000;
const APP_STATE_TRIGGER_DEDUPE_MS = 1_000;
// Auto-sync pacing adapts to how long cycles actually take on this device/dataset:
// period = cycle duration T + idle gap, and share = T / period is the fraction of
// time sync occupies the JS thread. Gap = 9T (capped) makes period = 10T, so a
// continuously-editing device spends ~10% of its time syncing instead of ~33%
// at gap = 2T (#766).
const ADAPTIVE_SYNC_DURATION_MULTIPLIER = 9;
const MAX_ADAPTIVE_SYNC_INTERVAL_MS = 5 * 60_000;
// Same base and ceiling as the desktop auto-sync controller.
const AUTO_SYNC_FAILURE_COOLDOWN_MS = 60_000;
const MAX_AUTO_SYNC_FAILURE_COOLDOWN_MS = 10 * 60_000;
/** The same failure is logged and shown again only after this long. */
const AUTO_SYNC_FAILURE_REPORT_REPEAT_MS = 10 * 60 * 1000;
const BACKGROUND_HOLD_RELEASE_CHECK = 'v1.3.7/ios-background-sync-hold';
export const MOBILE_AUTO_SYNC_CADENCE_FILE: MobileAutoSyncCadence = {
  minIntervalMs: 30_000,
  debounceFirstChangeMs: 8_000,
  debounceContinuousChangeMs: 15_000,
  foregroundMinIntervalMs: 45_000,
};
export const MOBILE_AUTO_SYNC_CADENCE_REMOTE: MobileAutoSyncCadence = {
  minIntervalMs: 5_000,
  debounceFirstChangeMs: 2_000,
  debounceContinuousChangeMs: 5_000,
  foregroundMinIntervalMs: 30_000,
};
export const MOBILE_AUTO_SYNC_CADENCE_OFF: MobileAutoSyncCadence = {
  minIntervalMs: 60_000,
  debounceFirstChangeMs: 15_000,
  debounceContinuousChangeMs: 30_000,
  foregroundMinIntervalMs: 60_000,
};

/** File Sync is far cheaper to leave alone than a remote backend; sync off barely paces. */
export const getMobileAutoSyncCadence = (backend: string): MobileAutoSyncCadence => {
  if (backend === 'file') return MOBILE_AUTO_SYNC_CADENCE_FILE;
  if (backend === 'webdav' || backend === 'cloud' || backend === 'cloudkit') return MOBILE_AUTO_SYNC_CADENCE_REMOTE;
  return MOBILE_AUTO_SYNC_CADENCE_OFF;
};

type SyncStoreSnapshot = {
  lastDataChangeAt: number;
  settings?: { lastSyncStatus?: string; lastSyncAt?: string } | null;
};

export type MobileSyncTriggerPorts = {
  /** The app state when the host mounted ('active', 'background', 'inactive'). */
  initialAppState: string;
  performSync(): Promise<{ success: boolean; error?: string }>;
  abortSync(): unknown;
  flushPendingSave(): Promise<void>;
  /** Schedules or cancels the platform's periodic background job for the current config. */
  reconcileBackgroundSync(): void;
  readStoredBackend(): Promise<string | null>;
  /** The stored backend value as a backend this device supports (CloudKit only where present). */
  resolveSupportedBackend(raw: string | null): string;
  /** The sync payload fingerprint (core's `getInMemorySyncChangeFingerprint`); may throw. */
  getSyncChangeFingerprint(): string | null;
  isLikelyOfflineSyncError(error: string): boolean;
  classifySyncFailure(error: string): string;
  reportError(error: unknown): void;
  logWarn(message: string, context: { scope: string; extra: Record<string, string> }): unknown;
  /** Receives only the pacing lines tagged for release diagnostics; absent means none are logged. */
  logInfo?(message: string, context: { scope: string; extra: Record<string, string> }): unknown;
  /** A local change is waiting to upload (true) or a successful cycle covered it (false); the badge shows pending. */
  onLocalChangePendingChange?(pending: boolean): void;
  /** Show the user one warning for an automatic sync failure, by its classification. */
  showSyncIssue(classification: string): void;
  /** iOS: asks the OS to keep the app running in the background (#1432). Returns the release, or null
   *  when the platform has none. `onExpire` runs once if the OS ends the time first; the platform has
   *  already let go by then. */
  holdBackgroundExecution?(onExpire: () => void): (() => void) | null;
  /** Resolves once no sync cycle is running or queued, follow-ups included. */
  waitForSyncIdle?(): Promise<void>;
};

export const createMobileSyncTriggers = (ports: MobileSyncTriggerPorts) => {
  let appState = ports.initialAppState;
  let isActive = true;
  let lastLoggedAutoSyncError: string | null = null;
  let lastLoggedAutoSyncErrorAt = 0;
  let syncCadence: MobileAutoSyncCadence = MOBILE_AUTO_SYNC_CADENCE_REMOTE;
  let syncBackendCache: { backend: string; readAt: number } = {
    backend: 'off',
    readAt: 0,
  };
  let lastAutoSyncPayloadFingerprint: string | null = null;
  let lastAppStateSyncTriggerAt = -APP_STATE_TRIGGER_DEDUPE_MS;
  let controller: AutoSyncController | null = null;
  let cleanupFailure: NativeAttachmentCleanupUnconfirmedError | null = null;
  // A local change is pending while a data change is newer than the start of the last
  // successful cycle (#1431). The sequence numbers store changes; the fingerprint a
  // successful cycle started from lets a write that left the payload as uploaded clear it.
  let localChangeSeq = 0;
  let coveredLocalChangeSeq = 0;
  let uploadedFingerprint: string | null = null;
  let publishedLocalChangePending = false;
  // A cycle that spans an abort request was cut short and uploaded nothing for sure, even
  // though the lifecycle abort reports success.
  let abortRequests = 0;
  const hasPendingLocalChange = () => localChangeSeq > coveredLocalChangeSeq;
  const publishLocalChangePending = () => {
    const pending = hasPendingLocalChange();
    if (pending === publishedLocalChangePending) return;
    publishedLocalChangePending = pending;
    ports.onLocalChangePendingChange?.(pending);
  };

  // #1432: iOS suspends the app seconds after it leaves the foreground, mid-request. One OS
  // background hold keeps sync running while work started at (or running after) that moment is
  // unfinished; it ends once that work and every follow-up the sync service queued settle.
  type BackgroundHold = { release: () => void; startedAt: number; work: number; failed: boolean };
  let backgroundHold: BackgroundHold | null = null;
  // Set when iOS ended a hold early: no new hold until the next foreground, which then syncs.
  let backgroundHoldExpired = false;
  const endBackgroundHold = (hold: BackgroundHold, outcome: 'completed' | 'failed' | 'expired' | 'aborted') => {
    if (backgroundHold !== hold) return;
    backgroundHold = null;
    try {
      hold.release();
    } catch (error) {
      ports.reportError(error);
    }
    void ports.logInfo?.('Background sync hold ended', {
      scope: 'sync',
      extra: { releaseCheck: BACKGROUND_HOLD_RELEASE_CHECK, outcome, heldMs: String(Date.now() - hold.startedAt) },
    });
  };
  const runHoldingBackground = <T>(source: 'app-left' | 'background-cycle', work: () => Promise<T>): Promise<T> => {
    // With sync off a cycle returns at once; no hold, no log lines on every app switch.
    const syncOff = syncBackendCache.readAt > 0 && syncBackendCache.backend === 'off';
    if (!backgroundHold && !backgroundHoldExpired && !syncOff && ports.holdBackgroundExecution) {
      let taken: BackgroundHold | null = null;
      const release = ports.holdBackgroundExecution(() => {
        if (!taken || backgroundHold !== taken) return;
        // The foreground already came back: the cycle may finish there.
        if (appState !== 'active') {
          backgroundHoldExpired = true;
          abortRequests += 1;
          // The existing lifecycle abort: the service queues a follow-up, nothing counts as uploaded.
          ports.abortSync();
        }
        endBackgroundHold(taken, 'expired');
      });
      if (release) {
        taken = { release, startedAt: Date.now(), work: 0, failed: false };
        backgroundHold = taken;
        void ports.logInfo?.('Background sync hold started', {
          scope: 'sync',
          extra: { releaseCheck: BACKGROUND_HOLD_RELEASE_CHECK, source },
        });
      }
    }
    const hold = backgroundHold;
    const promise = (async () => work())();
    if (!hold) return promise;
    hold.work += 1;
    const settle = (rejected: boolean) => {
      if (backgroundHold !== hold) return;
      if (rejected) hold.failed = true;
      hold.work -= 1;
      if (hold.work > 0) return;
      void (async () => ports.waitForSyncIdle?.())().then(
        () => { if (hold.work === 0) endBackgroundHold(hold, hold.failed ? 'failed' : 'completed'); },
        () => { if (hold.work === 0) endBackgroundHold(hold, 'failed'); },
      );
    };
    promise.then(() => settle(false), () => settle(true));
    return promise;
  };

  const stopRuntime = () => {
    isActive = false;
    controller?.dispose();
    controller = null;
    if (backgroundHold) endBackgroundHold(backgroundHold, 'aborted');
  };
  const retainCleanupFailure = (error: unknown): boolean => {
    if (!(error instanceof NativeAttachmentCleanupUnconfirmedError)) return false;
    cleanupFailure ??= error;
    stopRuntime();
    return true;
  };
  const requireActiveRuntime = () => {
    if (cleanupFailure) throw cleanupFailure;
    if (!isActive) throw new Error('Auto-sync runtime is inactive');
  };
  const reportError = (error: unknown) => {
    if (retainCleanupFailure(error) || !isActive) return;
    ports.reportError(error);
  };

  const refreshSyncCadence = async (): Promise<MobileAutoSyncCadence> => {
    requireActiveRuntime();
    const now = Date.now();
    const cached = syncBackendCache;
    if (now - cached.readAt <= AUTO_SYNC_BACKEND_CACHE_TTL_MS) {
      syncCadence = getMobileAutoSyncCadence(cached.backend);
      return syncCadence;
    }
    const rawBackend = await ports.readStoredBackend();
    requireActiveRuntime();
    const backend = ports.resolveSupportedBackend(rawBackend);
    requireActiveRuntime();
    syncBackendCache = { backend, readAt: now };
    syncCadence = getMobileAutoSyncCadence(backend);
    return syncCadence;
  };

  // Device-local bookkeeping (lastSync*, pendingRemoteWrite*, network) is not
  // part of a sync payload, so the change fingerprint ignores it for free —
  // no separate strip pass needed.
  const readCurrentSyncChangeFingerprint = (): string | null => {
    if (!isActive) return null;
    try {
      const fingerprint = ports.getSyncChangeFingerprint();
      return isActive ? fingerprint : null;
    } catch (error) {
      reportError(error);
      return null;
    }
  };

  const shouldDedupeAppStateSyncTrigger = (now: number): boolean => {
    const currentFingerprint = readCurrentSyncChangeFingerprint();
    const previousFingerprint = lastAutoSyncPayloadFingerprint;
    if (currentFingerprint) {
      lastAutoSyncPayloadFingerprint = currentFingerprint;
    }
    if (!currentFingerprint || !previousFingerprint || currentFingerprint !== previousFingerprint) {
      return false;
    }
    return now - lastAppStateSyncTriggerAt < APP_STATE_TRIGGER_DEDUPE_MS;
  };

  const markAppStateSyncTrigger = (now: number) => {
    lastAppStateSyncTriggerAt = now;
  };

  const reportAutoSyncFailure = (error: string) => {
    if (!isActive) return;
    const nowMs = Date.now();
    const shouldLog = error !== lastLoggedAutoSyncError
      || nowMs - lastLoggedAutoSyncErrorAt > AUTO_SYNC_FAILURE_REPORT_REPEAT_MS;
    if (!shouldLog) return;
    lastLoggedAutoSyncError = error;
    lastLoggedAutoSyncErrorAt = nowMs;
    void ports.logWarn('Auto-sync failed', {
      scope: 'sync',
      extra: { error },
    });
    if (!isActive) return;
    const classification = ports.classifySyncFailure(error);
    if (isActive) ports.showSyncIssue(classification);
  };

  // One controller at a time: the shared pacing machine in core, configured with the mobile
  // policy switches. An unconfirmed native cleanup permanently stops this runtime;
  // only the host's exact recovery can release its durable owner.
  const getController = (): AutoSyncController => {
    if (controller) return controller;
    controller = createAutoSyncController({
      // Ordinary failures retain mobile cooldown behavior. A native cleanup fatal
      // must escape unchanged, after all timers and queued follow-ups are stopped.
      performSync: async () => {
        requireActiveRuntime();
        const startSeq = localChangeSeq;
        const startFingerprint = readCurrentSyncChangeFingerprint();
        const startAbortRequests = abortRequests;
        try {
          const result = appState === 'active'
            ? await ports.performSync()
            : await runHoldingBackground('background-cycle', async () => {
              const cycleResult = await ports.performSync();
              if (!cycleResult.success && backgroundHold) backgroundHold.failed = true;
              return cycleResult;
            });
          requireActiveRuntime();
          if (result.success && abortRequests === startAbortRequests) {
            coveredLocalChangeSeq = Math.max(coveredLocalChangeSeq, startSeq);
            uploadedFingerprint = startFingerprint;
            publishLocalChangePending();
          }
          return result;
        } catch (error) {
          if (retainCleanupFailure(error) || cleanupFailure) throw cleanupFailure;
          if (!isActive) throw error;
          return { success: false, error: String(error) };
        }
      },
      flushPendingSave: async () => {
        requireActiveRuntime();
        try {
          await ports.flushPendingSave();
          requireActiveRuntime();
        } catch (error) {
          retainCleanupFailure(error);
          throw cleanupFailure ?? error;
        }
      },
      reportError: (_label, error) => reportError(error),
      // The controller's step-by-step traces stay off on mobile; only release-check lines reach the log.
      logInfo: (message, extra) => {
        if (isActive && extra?.releaseCheck) void ports.logInfo?.(message, { scope: 'sync', extra });
      },
      hasPendingLocalChanges: hasPendingLocalChange,
      isRuntimeActive: () => isActive,
      onSyncFailure: reportAutoSyncFailure,
      // Being offline is not a backend refusing us: no cooldown, no toast.
      // A failure with no message carries nothing to back off from either.
      isIgnorableFailure: (error) => !isActive || !error || ports.isLikelyOfflineSyncError(error),
      getCadence: () => syncCadence,
      refreshCadence: refreshSyncCadence,
      // The fingerprint runs once per quiet period, not per write (#766).
      shouldSyncOnDebouncedChange: () => {
        if (!isActive) return false;
        const currentFingerprint = readCurrentSyncChangeFingerprint();
        if (!isActive) return false;
        const previousFingerprint = lastAutoSyncPayloadFingerprint;
        if (currentFingerprint) {
          lastAutoSyncPayloadFingerprint = currentFingerprint;
          // A write that left the payload exactly as last uploaded has nothing to upload.
          if (currentFingerprint === uploadedFingerprint) {
            coveredLocalChangeSeq = localChangeSeq;
            publishLocalChangePending();
          }
        }
        return !(currentFingerprint && previousFingerprint && currentFingerprint === previousFingerprint);
      },
      adaptivePacing: {
        durationMultiplier: ADAPTIVE_SYNC_DURATION_MULTIPLIER,
        maxIntervalMs: MAX_ADAPTIVE_SYNC_INTERVAL_MS,
      },
      isSuspended: () => appState !== 'active',
      // Both preserve mobile's existing pacing exactly: the first-change
      // debounce applies once per foreground session, and a throttle or
      // cooldown retry that a newer cycle already overtook is dropped.
      continuousDebounceUntilSuspend: true,
      skipRetryWhileCycleRunning: true,
      autoFailureCooldownMs: AUTO_SYNC_FAILURE_COOLDOWN_MS,
      maxFailureCooldownMs: MAX_AUTO_SYNC_FAILURE_COOLDOWN_MS,
      // No foreground heartbeat on mobile; background sync is a platform job,
      // never a JS timer.
      periodicSyncIntervalMs: null,
    });
    return controller;
  };

  return {
    /** Starts watching: reads the cadence, reconciles the background job, seeds the fingerprint. */
    start(): void {
      if (!isActive) return;
      getController();
      void refreshSyncCadence().catch(reportError);
      ports.reconcileBackgroundSync();
      if (!isActive) return;
      lastAutoSyncPayloadFingerprint = readCurrentSyncChangeFingerprint();
    },

    // Every trigger routed through here is automatic — app-state changes, CloudKit
    // change notifications, startup — so every one of them waits out a failure
    // cooldown. Exempting them let a throttled device fire again on the very next
    // foreground/background switch, which is how testing across two devices stayed
    // stuck (#948). The user-facing Sync now button does not come through here; it
    // calls the sync service directly and still forces a run.
    requestSync(minIntervalMs?: number): void {
      if (!isActive) return;
      const activeController = getController();
      if (typeof minIntervalMs === 'number') {
        void activeController.requestAutoSync(minIntervalMs, 'external').catch(reportError);
        return;
      }
      void refreshSyncCadence()
        .then(() => {
          if (isActive) return activeController.requestAutoSync(undefined, 'external');
        })
        .catch(reportError);
    },

    /** A store update: a finished sync cancels a failure retry; a data change starts the debounce. */
    handleStoreChange(state: SyncStoreSnapshot, prevState: SyncStoreSnapshot): void {
      if (!isActive) return;
      const activeController = getController();
      const currentSyncStatus = state.settings?.lastSyncStatus;
      const previousSyncStatus = prevState.settings?.lastSyncStatus;
      const syncCompleted = currentSyncStatus === 'success' || currentSyncStatus === 'conflict';
      if (
        syncCompleted
        && (
          currentSyncStatus !== previousSyncStatus
          || state.settings?.lastSyncAt !== prevState.settings?.lastSyncAt
        )
      ) {
        // Manual sync bypasses these triggers, but its successful status
        // update must still cancel an automatic retry left by a prior
        // failure.
        activeController.notifyExternalSyncSuccess();
      }
      // Cheap check first: the fingerprint reads a small tuple digest, not the
      // whole dataset, but it still must not run on every store update (#766).
      // Data writes always bump lastDataChangeAt, so skipping the fingerprint
      // here is safe.
      if (state.lastDataChangeAt === prevState.lastDataChangeAt) return;
      localChangeSeq += 1;
      publishLocalChangePending();
      activeController.handleDataChange();
    },

    /** An app state change. Returns 'resumed' when the app came back to the foreground, so the
     *  host refreshes what it shows; 'left' when it went to the background; otherwise null. */
    handleAppStateChange(nextAppState: string): 'resumed' | 'left' | null {
      if (!isActive) return null;
      const activeController = getController();
      const previousState = appState;
      const wasInactiveOrBackground = previousState === 'inactive' || previousState === 'background';
      const nextInactiveOrBackground = nextAppState === 'inactive' || nextAppState === 'background';
      let transition: 'resumed' | 'left' | null = null;
      if (wasInactiveOrBackground && nextAppState === 'active') {
        transition = 'resumed';
        ports.reconcileBackgroundSync();
        if (!isActive) return null;
        const holdExpired = backgroundHoldExpired;
        backgroundHoldExpired = false;
        if (activeController.takePendingSuspendedRequest() || holdExpired) {
          void activeController.requestAutoSync(0, 'app-state-resume').catch(reportError);
        } else {
          void refreshSyncCadence()
            .then((cadence) => {
              if (!isActive) return;
              const now = Date.now();
              if (now - activeController.getLastAutoSyncAt() > cadence.foregroundMinIntervalMs) {
                if (shouldDedupeAppStateSyncTrigger(now) || !isActive) return;
                markAppStateSyncTrigger(now);
                void activeController.requestAutoSync(0, 'app-state-active').catch(reportError);
              }
            })
            .catch(reportError);
        }
      }
      if (previousState === 'active' && nextInactiveOrBackground) {
        transition = 'left';
        ports.reconcileBackgroundSync();
        if (!isActive) return null;
        activeController.handleSuspend();
        abortRequests += 1;
        ports.abortSync();
        if (!isActive) return null;
        const now = Date.now();
        const syncRequested = !shouldDedupeAppStateSyncTrigger(now) && isActive;
        if (syncRequested) markAppStateSyncTrigger(now);
        // Held even without a new request: the aborted cycle's follow-up still has to run.
        void runHoldingBackground('app-left', () => (syncRequested
          ? activeController.requestAutoSync(0, 'app-state-background')
          : Promise.resolve())).catch(reportError);
      }
      appState = nextAppState;
      return transition;
    },

    handleCloudKitChange(): void {
      if (!isActive) return;
      void getController().requestAutoSync(0, 'cloudkit').catch(reportError);
    },

    /** True while a local change waits for a successful cycle to upload it (#1431). */
    hasPendingLocalChange,

    /** False once disposed or quarantined: the host's foreground work checks it too. */
    isRuntimeActive: (): boolean => isActive,

    /** Stops every trigger for good and drops the controller's timers. */
    dispose: stopRuntime,
  };
};

export type MobileSyncTriggers = ReturnType<typeof createMobileSyncTriggers>;
