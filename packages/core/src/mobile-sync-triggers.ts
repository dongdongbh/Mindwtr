


import { createAutoSyncController, type AutoSyncCadence, type AutoSyncController } from './auto-sync-controller';
import { NativeAttachmentCleanupUnconfirmedError } from './native-attachment-cleanup';

export type MobileAutoSyncCadence = AutoSyncCadence & {
  foregroundMinIntervalMs: number;
};

const AUTO_SYNC_BACKEND_CACHE_TTL_MS = 5_000;
const APP_STATE_TRIGGER_DEDUPE_MS = 1_000;


const ADAPTIVE_SYNC_DURATION_MULTIPLIER = 9;
const MAX_ADAPTIVE_SYNC_INTERVAL_MS = 5 * 60_000;

const AUTO_SYNC_FAILURE_COOLDOWN_MS = 60_000;
const MAX_AUTO_SYNC_FAILURE_COOLDOWN_MS = 10 * 60_000;

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

  initialAppState: string;
  performSync(): Promise<{ success: boolean; error?: string }>;
  abortSync(): unknown;
  flushPendingSave(): Promise<void>;

  reconcileBackgroundSync(): void;
  readStoredBackend(): Promise<string | null>;

  resolveSupportedBackend(raw: string | null): string;

  getSyncChangeFingerprint(): string | null;
  isLikelyOfflineSyncError(error: string): boolean;
  classifySyncFailure(error: string): string;
  reportError(error: unknown): void;
  logWarn(message: string, context: { scope: string; extra: Record<string, string> }): unknown;

  logInfo?(message: string, context: { scope: string; extra: Record<string, string> }): unknown;

  onLocalChangePendingChange?(pending: boolean): void;

  showSyncIssue(classification: string): void;


  holdBackgroundExecution?(onExpire: () => void): (() => void) | null;

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


  let localChangeSeq = 0;
  let coveredLocalChangeSeq = 0;
  let uploadedFingerprint: string | null = null;
  let publishedLocalChangePending = false;


  let abortRequests = 0;
  const hasPendingLocalChange = () => localChangeSeq > coveredLocalChangeSeq;
  const publishLocalChangePending = () => {
    const pending = hasPendingLocalChange();
    if (pending === publishedLocalChangePending) return;
    publishedLocalChangePending = pending;
    ports.onLocalChangePendingChange?.(pending);
  };


  type BackgroundHold = { release: () => void; startedAt: number; work: number; failed: boolean };
  let backgroundHold: BackgroundHold | null = null;

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

    const syncOff = syncBackendCache.readAt > 0 && syncBackendCache.backend === 'off';
    if (!backgroundHold && !backgroundHoldExpired && !syncOff && ports.holdBackgroundExecution) {
      let taken: BackgroundHold | null = null;
      const release = ports.holdBackgroundExecution(() => {
        if (!taken || backgroundHold !== taken) return;

        if (appState !== 'active') {
          backgroundHoldExpired = true;
          abortRequests += 1;

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


  const getController = (): AutoSyncController => {
    if (controller) return controller;
    controller = createAutoSyncController({


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

      logInfo: (message, extra) => {
        if (isActive && extra?.releaseCheck) void ports.logInfo?.(message, { scope: 'sync', extra });
      },
      hasPendingLocalChanges: hasPendingLocalChange,
      isRuntimeActive: () => isActive,
      onSyncFailure: reportAutoSyncFailure,


      isIgnorableFailure: (error) => !isActive || !error || ports.isLikelyOfflineSyncError(error),
      getCadence: () => syncCadence,
      refreshCadence: refreshSyncCadence,

      shouldSyncOnDebouncedChange: () => {
        if (!isActive) return false;
        const currentFingerprint = readCurrentSyncChangeFingerprint();
        if (!isActive) return false;
        const previousFingerprint = lastAutoSyncPayloadFingerprint;
        if (currentFingerprint) {
          lastAutoSyncPayloadFingerprint = currentFingerprint;

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


      continuousDebounceUntilSuspend: true,
      skipRetryWhileCycleRunning: true,
      autoFailureCooldownMs: AUTO_SYNC_FAILURE_COOLDOWN_MS,
      maxFailureCooldownMs: MAX_AUTO_SYNC_FAILURE_COOLDOWN_MS,


      periodicSyncIntervalMs: null,
    });
    return controller;
  };

  return {

    start(): void {
      if (!isActive) return;
      getController();
      void refreshSyncCadence().catch(reportError);
      ports.reconcileBackgroundSync();
      if (!isActive) return;
      lastAutoSyncPayloadFingerprint = readCurrentSyncChangeFingerprint();
    },


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


        activeController.notifyExternalSyncSuccess();
      }


      if (state.lastDataChangeAt === prevState.lastDataChangeAt) return;
      localChangeSeq += 1;
      publishLocalChangePending();
      activeController.handleDataChange();
    },


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


    hasPendingLocalChange,


    isRuntimeActive: (): boolean => isActive,


    dispose: stopRuntime,
  };
};

export type MobileSyncTriggers = ReturnType<typeof createMobileSyncTriggers>;
