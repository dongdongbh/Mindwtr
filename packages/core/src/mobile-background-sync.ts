


import { BACKGROUND_SYNC_FAILURE_STATE_KEY, type SyncKeyValueStoragePort } from './sync-storage-keys';

export type MobileBackgroundSyncTrigger = 'scheduled' | 'capture';
export const MOBILE_BACKGROUND_SYNC_MINIMUM_INTERVAL_MINUTES = 15;
export const MOBILE_BACKGROUND_SYNC_INTERVAL = '15m' as const;


export const MOBILE_BACKGROUND_SYNC_DEADLINE_MS = 4 * 60 * 1000;
export const MOBILE_BACKGROUND_SYNC_QUIESCE_DEADLINE_MS = 20 * 1000;


export const MOBILE_BACKGROUND_SYNC_SLOW_RUN_MS = 60 * 1000;


export const MOBILE_BACKGROUND_SYNC_MAX_FAILURE_COOLDOWN_MS =
  8 * MOBILE_BACKGROUND_SYNC_MINIMUM_INTERVAL_MINUTES * 60 * 1000;


export const supportsMobileScheduledBackgroundSync = (backend: string): boolean => (
  backend === 'webdav' || backend === 'cloud' || backend === 'cloudkit'
);


export const shouldScheduleMobileBackgroundSync = (input: {
  schedulerAvailable: boolean;
  configured: boolean;
  backend: string;
}): boolean => (
  input.schedulerAvailable
  && input.configured
  && supportsMobileScheduledBackgroundSync(input.backend)
);

export type MobileBackgroundSyncOutcome = 'success' | 'failed';

type LogContext = { scope: string; extra?: Record<string, string>; force?: boolean };

export type MobileBackgroundSyncPorts = {

  storage: SyncKeyValueStoragePort;
  log: {
    info(message: string, context: LogContext): unknown;
    warn(message: string, context: LogContext): unknown;
  };
  sync: {
    getConfigurationStatus(): Promise<{ backend: string; configured: boolean }>;
    performSync(): Promise<{ success: boolean; error?: string }>;

    abort(): unknown;

    setRequestDeadline(at: number | null): void;
  };
  flushPendingSave(): Promise<void>;

  drainPendingCaptures(trigger: MobileBackgroundSyncTrigger): Promise<number>;

  quiesceStorage(): Promise<void>;

  timersPaused(): boolean;

  onAppStateChange(listener: (state: string) => void): { remove(): void };
  now?: () => number;

  deadlineMs?: () => number;
};

const withDeadline = <T>(work: Promise<T>, deadlineMs: number, onDeadline: () => T): Promise<T> => (
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(onDeadline()), deadlineMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  })
);


type BackgroundSyncFailureState = { lastFailureAt: number; consecutiveFailures: number };

export const backgroundSyncFailureCooldownMs = (consecutiveFailures: number): number => Math.min(
  MOBILE_BACKGROUND_SYNC_MAX_FAILURE_COOLDOWN_MS,
  MOBILE_BACKGROUND_SYNC_MINIMUM_INTERVAL_MINUTES * 60 * 1000 * (2 ** (Math.max(1, consecutiveFailures) - 1)),
);

export const createMobileBackgroundSyncRunner = (ports: MobileBackgroundSyncPorts) => {
  const now = ports.now ?? (() => Date.now());

  const logBackgroundSyncWarning = (message: string, error?: unknown) => {
    const extra = error ? { error: error instanceof Error ? error.message : String(error) } : undefined;
    void ports.log.warn(message, { scope: 'sync', extra });
  };

  const readBackgroundSyncFailureState = async (): Promise<BackgroundSyncFailureState | null> => {
    try {
      const stored = await ports.storage.getItem(BACKGROUND_SYNC_FAILURE_STATE_KEY);
      if (!stored) return null;
      const parsed = JSON.parse(stored) as Partial<BackgroundSyncFailureState> | null;
      const lastFailureAt = Number(parsed?.lastFailureAt);
      const consecutiveFailures = Number(parsed?.consecutiveFailures);
      if (!Number.isFinite(lastFailureAt) || !Number.isFinite(consecutiveFailures) || consecutiveFailures < 1) {
        return null;
      }
      return { lastFailureAt, consecutiveFailures };
    } catch (error) {
      logBackgroundSyncWarning('Failed to read the background sync failure record', error);
      return null;
    }
  };

  const recordBackgroundSyncOutcome = async (
    succeeded: boolean,
    previous: BackgroundSyncFailureState | null,
  ): Promise<void> => {
    try {
      if (succeeded) {
        if (previous) await ports.storage.removeItem(BACKGROUND_SYNC_FAILURE_STATE_KEY);
        return;
      }
      await ports.storage.setItem(BACKGROUND_SYNC_FAILURE_STATE_KEY, JSON.stringify({
        lastFailureAt: now(),
        consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
      } satisfies BackgroundSyncFailureState));
    } catch (error) {
      logBackgroundSyncWarning('Failed to persist the background sync failure record', error);
    }
  };


  const withDeadlineAndResumeCheck = <T>(
    work: Promise<T>,
    deadlineAt: number,
    onDeadline: (stage: 'timer' | 'resume') => T,
  ): Promise<T> => (
    new Promise<T>((resolve, reject) => {
      let settled = false;
      let subscription: { remove: () => void } | null = null;
      const cleanup = () => {
        clearTimeout(timer);
        subscription?.remove();
      };
      const settleWithDeadline = (stage: 'timer' | 'resume') => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(onDeadline(stage));
      };
      const timer = setTimeout(() => settleWithDeadline('timer'), Math.max(0, deadlineAt - now()));
      subscription = ports.onAppStateChange((state) => {
        if (state === 'active' && now() >= deadlineAt) settleWithDeadline('resume');
      });
      work.then(
        (value) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      );
    })
  );

  const performBackgroundSyncWork = async (): Promise<MobileBackgroundSyncOutcome> => {
    const { backend, configured } = await ports.sync.getConfigurationStatus();
    if (!configured || !supportsMobileScheduledBackgroundSync(backend)) {
      return 'success';
    }

    await ports.flushPendingSave().catch((error) => {
      logBackgroundSyncWarning('Mobile background sync save flush failed', error);
    });
    const result = await ports.sync.performSync();
    if (result.success) {
      return 'success';
    }

    logBackgroundSyncWarning('Mobile background sync failed', result.error);
    return 'failed';
  };

  const quiesceWithinDeadline = (): Promise<void> => (
    withDeadline(ports.quiesceStorage(), MOBILE_BACKGROUND_SYNC_QUIESCE_DEADLINE_MS, () => {
      logBackgroundSyncWarning('Mobile background sync storage quiesce did not finish before its deadline');
    })
  );

  const runMobileBackgroundSync = async (
    trigger: MobileBackgroundSyncTrigger = 'scheduled',
  ): Promise<MobileBackgroundSyncOutcome> => {
    const startedAt = now();


    const drained = await ports.drainPendingCaptures(trigger).catch((error) => {
      logBackgroundSyncWarning('Background capture import failed', error);
      return 0;
    });

    if (trigger === 'capture' && drained === 0) return 'success';
    const failureState = await readBackgroundSyncFailureState();

    if (failureState && trigger === 'scheduled') {
      const cooldownMs = backgroundSyncFailureCooldownMs(failureState.consecutiveFailures);
      const waitedMs = startedAt - failureState.lastFailureAt;


      if (waitedMs >= 0 && waitedMs < cooldownMs) {
        void ports.log.info('Mobile background sync skipped during failure cooldown', {
          scope: 'sync',
          extra: {
            consecutiveFailures: String(failureState.consecutiveFailures),
            cooldownMs: String(cooldownMs),
            waitedMs: String(waitedMs),
          },
        });
        if (drained > 0) await quiesceWithinDeadline();
        return 'success';
      }
    }


    const run: { outcome: 'success' | 'failed' | 'abandoned' | 'crashed' } = { outcome: 'crashed' };


    const deadlineMs = ports.deadlineMs?.() ?? MOBILE_BACKGROUND_SYNC_DEADLINE_MS;
    const deadlineAt = now() + deadlineMs;
    ports.sync.setRequestDeadline(deadlineAt);


    void ports.log.info('Mobile background sync started', {
      scope: 'sync',
      extra: { timersPaused: String(ports.timersPaused()) },
    });
    try {
      const result = await withDeadlineAndResumeCheck(
        performBackgroundSyncWork(),
        deadlineAt,


        (stage): MobileBackgroundSyncOutcome => {
          ports.sync.abort();
          run.outcome = 'abandoned';
          void ports.log.warn('Mobile background sync did not finish before its deadline and was abandoned', {
            scope: 'sync',
            force: true,
            extra: {
              deadlineMs: String(deadlineMs),
              elapsedMs: String(now() - startedAt),
              stage,
              releaseCheck: 'v1.3.2/background-sync-wallclock-abort',
            },
          });
          return 'failed';
        },
      );
      if (run.outcome !== 'abandoned') {
        run.outcome = result === 'success' ? 'success' : 'failed';
      }
      return result;
    } catch (error) {
      logBackgroundSyncWarning('Mobile background sync crashed', error);
      return 'failed';
    } finally {
      ports.sync.setRequestDeadline(null);


      await quiesceWithinDeadline();


      await recordBackgroundSyncOutcome(run.outcome === 'success', failureState);
      const elapsedMs = now() - startedAt;
      const extra = { outcome: run.outcome, elapsedMs: String(elapsedMs) };
      if (elapsedMs >= MOBILE_BACKGROUND_SYNC_SLOW_RUN_MS) {
        void ports.log.warn('Mobile background sync run took longer than a minute', { scope: 'sync', force: true, extra });
      } else {
        void ports.log.info('Mobile background sync finished', { scope: 'sync', extra });
      }
    }
  };


  let inFlightBackgroundSync: Promise<MobileBackgroundSyncOutcome> | null = null;

  const runSharedBackgroundSync = (trigger: MobileBackgroundSyncTrigger): Promise<MobileBackgroundSyncOutcome> => {
    if (!inFlightBackgroundSync) {
      inFlightBackgroundSync = runMobileBackgroundSync(trigger).finally(() => {
        inFlightBackgroundSync = null;
      });
    }
    return inFlightBackgroundSync;
  };

  return {

    run: runSharedBackgroundSync,

    runCapture: async (): Promise<void> => {
      if (inFlightBackgroundSync) await inFlightBackgroundSync.catch(() => undefined);
      await runSharedBackgroundSync('capture');
    },

    getInFlightRun: (): Promise<MobileBackgroundSyncOutcome> | null => inFlightBackgroundSync,
  };
};

export type MobileBackgroundSyncRunner = ReturnType<typeof createMobileBackgroundSyncRunner>;
