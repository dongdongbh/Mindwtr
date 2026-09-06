import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { flushPendingSave } from '@mindwtr/core';

import type { SyncBackend } from './sync-service-utils';
import { logInfo, logWarn } from './app-log';
import { areJsTimersPaused } from './js-timers';
import { quiesceMobileStorage } from './storage-adapter';
import { abortMobileSync, getMobileSyncConfigurationStatus, performMobileSync, setMobileSyncRequestDeadline } from './sync-service';
import {
  BACKGROUND_SYNC_INTERVAL_KEY,
  BACKGROUND_SYNC_LAST_REGISTERED_INTERVAL_KEY,
  type BackgroundSyncInterval,
} from './sync-constants';

export type { BackgroundSyncInterval };

export const MOBILE_BACKGROUND_SYNC_TASK_NAME = 'mindwtr-background-sync';
export const MOBILE_BACKGROUND_SYNC_MINIMUM_INTERVAL_MINUTES = 15;
// JobScheduler stops a WorkManager job that is still running after its
// allowance (10 minutes normally, 20 in the ACTIVE standby bucket), counts a
// "timeout" against the app, and defers the next run by about 40 minutes. On
// device the job held a wakelock for the whole allowance whenever the sync did
// not settle (#1001). The run is abandoned well inside that allowance instead,
// so the job always returns and the wakelock is released.
//
// Android pauses JavaScript timers while the app is not in the foreground, so
// the setTimeout race below only fires when the app is visible. The deadline
// that holds in the background is the request deadline handed to the sync's
// fetch, which refuses to start a request past it and caps each request at it.
export const MOBILE_BACKGROUND_SYNC_DEADLINE_MS = 4 * 60 * 1000;
export const MOBILE_BACKGROUND_SYNC_QUIESCE_DEADLINE_MS = 20 * 1000;
/** A run past this is written to the log even with debug logging off: a job
 *  that lives this long is what drained batteries in #1001, and the log a
 *  user shares is the only view into a background run. */
export const MOBILE_BACKGROUND_SYNC_SLOW_RUN_MS = 60 * 1000;

type MobileBackgroundSyncRegistrationAction = 'registered' | 'unregistered' | 'unchanged';

const MOBILE_BACKGROUND_SYNC_INTERVAL_MINUTES: Record<Exclude<BackgroundSyncInterval, 'off'>, number> = {
  '15m': MOBILE_BACKGROUND_SYNC_MINIMUM_INTERVAL_MINUTES,
  '1h': MOBILE_BACKGROUND_SYNC_MINIMUM_INTERVAL_MINUTES * 4,
  '6h': MOBILE_BACKGROUND_SYNC_MINIMUM_INTERVAL_MINUTES * 24,
};

export type MobileBackgroundSyncRegistrationResult = {
  action: MobileBackgroundSyncRegistrationAction;
  available: boolean;
  backend: SyncBackend;
  configured: boolean;
  interval: BackgroundSyncInterval;
  registered: boolean;
  status: BackgroundTask.BackgroundTaskStatus | null;
};

export const supportsMobileScheduledBackgroundSync = (backend: SyncBackend): boolean => (
  backend === 'webdav' || backend === 'cloud' || backend === 'cloudkit'
);

const logBackgroundSyncWarning = (message: string, error?: unknown) => {
  const extra = error ? { error: error instanceof Error ? error.message : String(error) } : undefined;
  void logWarn(message, { scope: 'sync', extra });
};

const isBackgroundTaskRegistered = async (): Promise<boolean> => {
  try {
    return await TaskManager.isTaskRegisteredAsync(MOBILE_BACKGROUND_SYNC_TASK_NAME);
  } catch (error) {
    logBackgroundSyncWarning('Failed to read mobile background sync registration state', error);
    return false;
  }
};

const getBackgroundTaskStatus = async (): Promise<BackgroundTask.BackgroundTaskStatus | null> => {
  try {
    return await BackgroundTask.getStatusAsync();
  } catch (error) {
    logBackgroundSyncWarning('Failed to read mobile background sync availability', error);
    return null;
  }
};

const isTaskManagerAvailable = async (): Promise<boolean> => {
  try {
    return await TaskManager.isAvailableAsync();
  } catch (error) {
    logBackgroundSyncWarning('Failed to read task manager availability', error);
    return false;
  }
};

const isBackgroundSyncInterval = (value: unknown): value is BackgroundSyncInterval => (
  value === 'off' || value === '15m' || value === '1h' || value === '6h'
);

export const getMobileBackgroundSyncInterval = async (): Promise<BackgroundSyncInterval> => {
  try {
    const stored = await AsyncStorage.getItem(BACKGROUND_SYNC_INTERVAL_KEY);
    return isBackgroundSyncInterval(stored) ? stored : '15m';
  } catch (error) {
    logBackgroundSyncWarning('Failed to read mobile background sync interval setting', error);
    return '15m';
  }
};

export const setMobileBackgroundSyncInterval = async (interval: BackgroundSyncInterval): Promise<void> => {
  await AsyncStorage.setItem(BACKGROUND_SYNC_INTERVAL_KEY, interval);
};

// expo-background-task keeps the previously registered interval on a repeat
// registerTaskAsync call, so the registration loop needs its own record of
// what interval is actually live to know when it must unregister first.
const getLastRegisteredBackgroundSyncInterval = async (): Promise<BackgroundSyncInterval | null> => {
  try {
    const stored = await AsyncStorage.getItem(BACKGROUND_SYNC_LAST_REGISTERED_INTERVAL_KEY);
    return isBackgroundSyncInterval(stored) ? stored : null;
  } catch (error) {
    logBackgroundSyncWarning('Failed to read the last registered background sync interval', error);
    return null;
  }
};

const setLastRegisteredBackgroundSyncInterval = async (interval: BackgroundSyncInterval): Promise<void> => {
  try {
    await AsyncStorage.setItem(BACKGROUND_SYNC_LAST_REGISTERED_INTERVAL_KEY, interval);
  } catch (error) {
    logBackgroundSyncWarning('Failed to persist the last registered background sync interval', error);
  }
};

const clearLastRegisteredBackgroundSyncInterval = async (): Promise<void> => {
  try {
    await AsyncStorage.removeItem(BACKGROUND_SYNC_LAST_REGISTERED_INTERVAL_KEY);
  } catch (error) {
    logBackgroundSyncWarning('Failed to clear the last registered background sync interval', error);
  }
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

const performBackgroundSyncWork = async (): Promise<BackgroundTask.BackgroundTaskResult> => {
  const { backend, configured } = await getMobileSyncConfigurationStatus();
  if (!configured || !supportsMobileScheduledBackgroundSync(backend)) {
    return BackgroundTask.BackgroundTaskResult.Success;
  }

  await flushPendingSave().catch((error) => {
    logBackgroundSyncWarning('Mobile background sync save flush failed', error);
  });
  const result = await performMobileSync();
  if (result.success) {
    return BackgroundTask.BackgroundTaskResult.Success;
  }

  logBackgroundSyncWarning('Mobile background sync failed', result.error);
  return BackgroundTask.BackgroundTaskResult.Failed;
};

const runMobileBackgroundSync = async (): Promise<BackgroundTask.BackgroundTaskResult> => {
  const startedAt = Date.now();
  // Kept on an object: the deadline callback below assigns it from a closure,
  // which control-flow narrowing on a plain `let` cannot see.
  const run: { outcome: 'success' | 'failed' | 'abandoned' | 'crashed' } = { outcome: 'crashed' };
  setMobileSyncRequestDeadline(startedAt + MOBILE_BACKGROUND_SYNC_DEADLINE_MS);
  // A "started" line without its "finished" line in a shared log is the
  // signature of a run that never settled (#1001).
  void logInfo('Mobile background sync started', {
    scope: 'sync',
    extra: { timersPaused: String(areJsTimersPaused()) },
  });
  try {
    const result = await withDeadline(performBackgroundSyncWork(), MOBILE_BACKGROUND_SYNC_DEADLINE_MS, () => {
      abortMobileSync();
      run.outcome = 'abandoned';
      void logWarn('Mobile background sync did not finish before its deadline and was abandoned', {
        scope: 'sync',
        extra: { deadlineMs: String(MOBILE_BACKGROUND_SYNC_DEADLINE_MS) },
      });
      return BackgroundTask.BackgroundTaskResult.Failed;
    });
    if (run.outcome !== 'abandoned') {
      run.outcome = result === BackgroundTask.BackgroundTaskResult.Success ? 'success' : 'failed';
    }
    return result;
  } catch (error) {
    logBackgroundSyncWarning('Mobile background sync crashed', error);
    return BackgroundTask.BackgroundTaskResult.Failed;
  } finally {
    setMobileSyncRequestDeadline(null);
    // This runs in a headless RN instance that is destroyed the moment the task
    // promise settles; deferred storage work must land before that, not after.
    // It gets its own short deadline for the same reason as the sync above.
    await withDeadline(quiesceMobileStorage(), MOBILE_BACKGROUND_SYNC_QUIESCE_DEADLINE_MS, () => {
      logBackgroundSyncWarning('Mobile background sync storage quiesce did not finish before its deadline');
    });
    const elapsedMs = Date.now() - startedAt;
    const extra = { outcome: run.outcome, elapsedMs: String(elapsedMs) };
    if (elapsedMs >= MOBILE_BACKGROUND_SYNC_SLOW_RUN_MS) {
      void logWarn('Mobile background sync run took longer than a minute', { scope: 'sync', force: true, extra });
    } else {
      void logInfo('Mobile background sync finished', { scope: 'sync', extra });
    }
  }
};

// expo-background-task delivers every queued event it has accumulated, so several
// invocations can land at once (three arrived in the same millisecond on device) and
// performMobileSync has no re-entrancy guard of its own. Overlapping runs raced each
// other's snapshots and widened the teardown window above, so they share one run.
let inFlightBackgroundSync: Promise<BackgroundTask.BackgroundTaskResult> | null = null;

const defineMobileBackgroundSyncTask = () => {
  if (TaskManager.isTaskDefined(MOBILE_BACKGROUND_SYNC_TASK_NAME)) return;

  TaskManager.defineTask(MOBILE_BACKGROUND_SYNC_TASK_NAME, async () => {
    if (!inFlightBackgroundSync) {
      inFlightBackgroundSync = runMobileBackgroundSync().finally(() => {
        inFlightBackgroundSync = null;
      });
    }
    return inFlightBackgroundSync;
  });
};

defineMobileBackgroundSyncTask();

export async function syncMobileBackgroundSyncRegistration(): Promise<MobileBackgroundSyncRegistrationResult> {
  const [configuration, status, taskManagerAvailable, registered, interval, lastRegisteredInterval] = await Promise.all([
    getMobileSyncConfigurationStatus(),
    getBackgroundTaskStatus(),
    isTaskManagerAvailable(),
    isBackgroundTaskRegistered(),
    getMobileBackgroundSyncInterval(),
    getLastRegisteredBackgroundSyncInterval(),
  ]);
  const available = taskManagerAvailable && status === BackgroundTask.BackgroundTaskStatus.Available;
  const shouldRegister = available
    && configuration.configured
    && supportsMobileScheduledBackgroundSync(configuration.backend)
    && interval !== 'off';
  const appState = AppState.currentState;
  const logDecision = (decision: string) => {
    void logInfo('Mobile background sync registration checked', {
      scope: 'sync',
      extra: {
        decision,
        registered: String(registered),
        storedInterval: lastRegisteredInterval ?? 'none',
        interval,
        appState: String(appState),
      },
    });
  };

  // On a headless cold start TaskManager restores its persisted registrations
  // asynchronously, so isTaskRegisteredAsync can answer false while our own
  // record says a registration is live. Re-registering there makes
  // expo-background-task cancel the very worker that woke the app (device
  // test 2026-09-02: job released after 0.76 s, sync frozen mid-cycle). Trust
  // the record until the app is on screen, where a re-registration is harmless.
  if (shouldRegister && !registered && lastRegisteredInterval !== null && appState !== 'active') {
    logDecision('deferred-until-foreground');
    return {
      action: 'unchanged',
      available,
      backend: configuration.backend,
      configured: configuration.configured,
      interval,
      registered: true,
      status,
    };
  }

  if (shouldRegister) {
    const minimumInterval = MOBILE_BACKGROUND_SYNC_INTERVAL_MINUTES[interval];
    const intervalChanged = registered && lastRegisteredInterval !== interval;
    logDecision(!registered ? 'register' : intervalChanged ? 're-register' : 'unchanged');
    // Every registerTaskAsync call makes expo-background-task cancel its
    // current WorkManager worker and enqueue a fresh one with a full delay.
    // On a cold start woken by that very worker, re-registering cancelled the
    // run that woke the app, so a task that is already live is left alone.
    if (!registered || intervalChanged) {
      if (intervalChanged) {
        // expo-background-task ignores a changed minimumInterval on a plain
        // re-registration; only unregister-then-register actually applies it.
        await BackgroundTask.unregisterTaskAsync(MOBILE_BACKGROUND_SYNC_TASK_NAME);
      }
      await BackgroundTask.registerTaskAsync(MOBILE_BACKGROUND_SYNC_TASK_NAME, { minimumInterval });
      await setLastRegisteredBackgroundSyncInterval(interval);
      void logInfo('Mobile background sync registered', {
        scope: 'sync',
        extra: { backend: configuration.backend, interval },
      });
    }
    return {
      action: (!registered || intervalChanged) ? 'registered' : 'unchanged',
      available,
      backend: configuration.backend,
      configured: configuration.configured,
      interval,
      registered: true,
      status,
    };
  }

  if (registered) {
    logDecision('unregister');
    await BackgroundTask.unregisterTaskAsync(MOBILE_BACKGROUND_SYNC_TASK_NAME);
    await clearLastRegisteredBackgroundSyncInterval();
    void logInfo('Mobile background sync unregistered', {
      scope: 'sync',
      extra: { backend: configuration.backend, available: String(available), configured: String(configuration.configured), interval },
    });
    return {
      action: 'unregistered',
      available,
      backend: configuration.backend,
      configured: configuration.configured,
      interval,
      registered: false,
      status,
    };
  }

  return {
    action: 'unchanged',
    available,
    backend: configuration.backend,
    configured: configuration.configured,
    interval,
    registered: false,
    status,
  };
}
