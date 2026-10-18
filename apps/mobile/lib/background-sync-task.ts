import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { AppRegistry, AppState, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { flushPendingSave } from '@mindwtr/core';
import {
  createMobileBackgroundSyncRunner,
  MOBILE_BACKGROUND_SYNC_INTERVAL,
  MOBILE_BACKGROUND_SYNC_MINIMUM_INTERVAL_MINUTES,
  shouldScheduleMobileBackgroundSync,
  supportsMobileScheduledBackgroundSync,
  type MobileBackgroundSyncOutcome,
  type MobileBackgroundSyncRunner,
  type MobileBackgroundSyncTrigger,
} from '@mindwtr/core/mobile-background-sync';

import type { SyncBackend } from './sync-service-utils';
import { logInfo, logWarn } from './app-log';
import { areJsTimersPaused } from './js-timers';
import { drainPendingCapturesInBackground } from './pending-capture-drain';
import { reconcileLocalMobileNotificationsInBackground } from './notification-service-local';
import { quiesceMobileStorage } from './storage-adapter';
import { abortMobileSync, getMobileSyncConfigurationStatus, performMobileSync, setMobileSyncRequestDeadline } from './sync-service';
import {
  BACKGROUND_SYNC_LAST_REGISTERED_INTERVAL_KEY,
  type LegacyBackgroundSyncInterval,
} from './sync-constants';

// The run policy — which backends run in the background, the 4-minute deadline, the failure
// back-off, the capture import first and the storage quiesce last — lives in core
// (`packages/core/src/mobile-background-sync.ts`) so the native app's WorkManager job runs the
// same one. This module binds it to expo-background-task, the sync service, AsyncStorage and
// AppState, and keeps the Expo registration below.
export {
  MOBILE_BACKGROUND_SYNC_DEADLINE_MS,
  MOBILE_BACKGROUND_SYNC_INTERVAL,
  MOBILE_BACKGROUND_SYNC_MAX_FAILURE_COOLDOWN_MS,
  MOBILE_BACKGROUND_SYNC_MINIMUM_INTERVAL_MINUTES,
  MOBILE_BACKGROUND_SYNC_QUIESCE_DEADLINE_MS,
  MOBILE_BACKGROUND_SYNC_SLOW_RUN_MS,
} from '@mindwtr/core/mobile-background-sync';
export { supportsMobileScheduledBackgroundSync };

export const MOBILE_BACKGROUND_SYNC_TASK_NAME = 'mindwtr-background-sync';
/** Started by the Android capture dialog right after Save (#1257); the name is
 *  repeated in modules/android-widget CaptureSyncHeadlessService.kt. */
export const MOBILE_CAPTURE_SYNC_HEADLESS_TASK_NAME = 'MindwtrCaptureSync';

type MobileBackgroundSyncRegistrationAction = 'registered' | 'unregistered' | 'unchanged';

export type MobileBackgroundSyncRegistrationResult = {
  action: MobileBackgroundSyncRegistrationAction;
  available: boolean;
  backend: SyncBackend;
  configured: boolean;
  interval: typeof MOBILE_BACKGROUND_SYNC_INTERVAL;
  registered: boolean;
  status: BackgroundTask.BackgroundTaskStatus | null;
};

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

const isLegacyBackgroundSyncInterval = (value: unknown): value is LegacyBackgroundSyncInterval => (
  value === 'off' || value === '15m' || value === '1h' || value === '6h'
);

// expo-background-task keeps the previously registered interval on a repeat
// registerTaskAsync call, so the registration loop needs its own record of
// what interval is actually live to know when it must unregister first.
const getLastRegisteredBackgroundSyncInterval = async (): Promise<LegacyBackgroundSyncInterval | null> => {
  try {
    const stored = await AsyncStorage.getItem(BACKGROUND_SYNC_LAST_REGISTERED_INTERVAL_KEY);
    return isLegacyBackgroundSyncInterval(stored) ? stored : null;
  } catch (error) {
    logBackgroundSyncWarning('Failed to read the last registered background sync interval', error);
    return null;
  }
};

const setLastRegisteredBackgroundSyncInterval = async (): Promise<void> => {
  try {
    await AsyncStorage.setItem(BACKGROUND_SYNC_LAST_REGISTERED_INTERVAL_KEY, MOBILE_BACKGROUND_SYNC_INTERVAL);
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

// Created on first use, once per module instance.
let runner: MobileBackgroundSyncRunner | null = null;
const backgroundSyncRunner = (): MobileBackgroundSyncRunner => {
  runner ??= createMobileBackgroundSyncRunner({
    storage: {
      getItem: (key) => AsyncStorage.getItem(key),
      setItem: (key, value) => AsyncStorage.setItem(key, value),
      removeItem: (key) => AsyncStorage.removeItem(key),
    },
    log: {
      info: (message, context) => logInfo(message, context),
      warn: (message, context) => logWarn(message, context),
    },
    sync: {
      getConfigurationStatus: () => getMobileSyncConfigurationStatus(),
      performSync: async () => {
        const result = await performMobileSync();
        if (result.success) await reconcileLocalMobileNotificationsInBackground('sync');
        return result;
      },
      abort: () => abortMobileSync('deadline'),
      setRequestDeadline: (at) => setMobileSyncRequestDeadline(at),
    },
    flushPendingSave: () => flushPendingSave(),
    drainPendingCaptures: (trigger) => drainPendingCapturesInBackground(trigger),
    quiesceStorage: () => quiesceMobileStorage(),
    timersPaused: () => areJsTimersPaused(),
    onAppStateChange: (listener) => AppState.addEventListener('change', listener),
  });
  return runner;
};

const toBackgroundTaskResult = (outcome: MobileBackgroundSyncOutcome): BackgroundTask.BackgroundTaskResult => (
  outcome === 'success' ? BackgroundTask.BackgroundTaskResult.Success : BackgroundTask.BackgroundTaskResult.Failed
);

const runSharedBackgroundSync = (trigger: MobileBackgroundSyncTrigger): Promise<BackgroundTask.BackgroundTaskResult> => (
  backgroundSyncRunner().run(trigger).then(toBackgroundTaskResult)
);

const defineMobileBackgroundSyncTask = () => {
  if (TaskManager.isTaskDefined(MOBILE_BACKGROUND_SYNC_TASK_NAME)) return;

  TaskManager.defineTask(MOBILE_BACKGROUND_SYNC_TASK_NAME, () => runSharedBackgroundSync('scheduled'));
};

defineMobileBackgroundSyncTask();

/** A second Save during a run waits for it, then imports and sends its own capture. */
export const runCaptureSyncHeadlessTask = (): Promise<void> => backgroundSyncRunner().runCapture();

if (Platform.OS === 'android') {
  AppRegistry.registerHeadlessTask(MOBILE_CAPTURE_SYNC_HEADLESS_TASK_NAME, () => runCaptureSyncHeadlessTask);
}

type MobileBackgroundSyncRegistrationSnapshot = {
  configuration: Awaited<ReturnType<typeof getMobileSyncConfigurationStatus>>;
  lastRegisteredInterval: LegacyBackgroundSyncInterval | null;
  registered: boolean;
  status: BackgroundTask.BackgroundTaskStatus | null;
  taskManagerAvailable: boolean;
};

const readMobileBackgroundSyncRegistrationSnapshot = async (): Promise<MobileBackgroundSyncRegistrationSnapshot> => {
  const [configuration, status, taskManagerAvailable, registered, lastRegisteredInterval] = await Promise.all([
    getMobileSyncConfigurationStatus(),
    getBackgroundTaskStatus(),
    isTaskManagerAvailable(),
    isBackgroundTaskRegistered(),
    getLastRegisteredBackgroundSyncInterval(),
  ]);

  return { configuration, lastRegisteredInterval, registered, status, taskManagerAvailable };
};

const shouldUseAutomaticMobileBackgroundSync = (snapshot: MobileBackgroundSyncRegistrationSnapshot): boolean => (
  shouldScheduleMobileBackgroundSync({
    schedulerAvailable: snapshot.taskManagerAvailable
      && snapshot.status === BackgroundTask.BackgroundTaskStatus.Available,
    configured: snapshot.configuration.configured,
    backend: snapshot.configuration.backend,
  })
);

const registrationResult = (
  snapshot: MobileBackgroundSyncRegistrationSnapshot,
  action: MobileBackgroundSyncRegistrationAction,
  registered = snapshot.registered,
): MobileBackgroundSyncRegistrationResult => ({
  action,
  available: snapshot.taskManagerAvailable
    && snapshot.status === BackgroundTask.BackgroundTaskStatus.Available,
  backend: snapshot.configuration.backend,
  configured: snapshot.configuration.configured,
  interval: MOBILE_BACKGROUND_SYNC_INTERVAL,
  registered,
  status: snapshot.status,
});

const logRegistrationDecision = (
  snapshot: MobileBackgroundSyncRegistrationSnapshot,
  decision: string,
) => {
  void logInfo('Mobile background sync registration checked', {
    scope: 'sync',
    extra: {
      appState: String(AppState.currentState),
      decision,
      interval: MOBILE_BACKGROUND_SYNC_INTERVAL,
      registered: String(snapshot.registered),
      storedInterval: snapshot.lastRegisteredInterval ?? 'none',
    },
  });
};

let automaticScheduleReadyLogged = false;

const logAutomaticScheduleReady = (outcome: 'registered' | 'unchanged') => {
  if (automaticScheduleReadyLogged) return;
  automaticScheduleReadyLogged = true;
  void logInfo('Automatic mobile background sync schedule ready', {
    scope: 'sync',
    extra: {
      releaseCheck: 'v1.3.0/automatic-background-sync',
      interval: MOBILE_BACKGROUND_SYNC_INTERVAL,
      outcome,
    },
  });
};

const reconcileAutomaticMobileBackgroundSyncRegistration = async (): Promise<MobileBackgroundSyncRegistrationResult> => {
  let previousAction: MobileBackgroundSyncRegistrationAction = 'unchanged';

  while (true) {
    const snapshot = await readMobileBackgroundSyncRegistrationSnapshot();
    const shouldRegister = shouldUseAutomaticMobileBackgroundSync(snapshot);

    // Registration calls replace or cancel Expo's one shared native worker. A
    // headless wake can report an inactive app and a transient false negative
    // registration, so every native mutation waits for a foreground pass.
    if (AppState.currentState !== 'active') {
      logRegistrationDecision(snapshot, 'deferred-until-foreground');
      return registrationResult(
        snapshot,
        previousAction,
        snapshot.registered || snapshot.lastRegisteredInterval !== null,
      );
    }

    const needsNativeMutation = shouldRegister
      ? !snapshot.registered || snapshot.lastRegisteredInterval !== MOBILE_BACKGROUND_SYNC_INTERVAL
      : snapshot.registered;
    const inFlightBackgroundSync = backgroundSyncRunner().getInFlightRun();
    if (needsNativeMutation && inFlightBackgroundSync) {
      logRegistrationDecision(snapshot, 'waiting-for-background-run');
      await inFlightBackgroundSync.catch(() => undefined);
      // The app state, backend configuration, native registration, and legacy
      // record may all have changed while the run settled. Read them again.
      continue;
    }

    if (shouldRegister) {
      if (snapshot.registered && snapshot.lastRegisteredInterval !== MOBILE_BACKGROUND_SYNC_INTERVAL) {
        automaticScheduleReadyLogged = false;
        logRegistrationDecision(snapshot, 're-register');
        // Expo ignores an interval change on a repeat register call. Remove the
        // legacy worker first, then loop so configuration and app state are
        // re-read before the replacement native mutation.
        await BackgroundTask.unregisterTaskAsync(MOBILE_BACKGROUND_SYNC_TASK_NAME);
        await clearLastRegisteredBackgroundSyncInterval();
        previousAction = 'unregistered';
        continue;
      }

      if (!snapshot.registered) {
        logRegistrationDecision(snapshot, 'register');
        await BackgroundTask.registerTaskAsync(MOBILE_BACKGROUND_SYNC_TASK_NAME, {
          minimumInterval: MOBILE_BACKGROUND_SYNC_MINIMUM_INTERVAL_MINUTES,
        });
        await setLastRegisteredBackgroundSyncInterval();

        // A backend switch can finish while the native call is in flight. Do
        // not claim readiness for a schedule that is already stale; the queued
        // reconciliation for that switch will re-read and clean it up.
        const latestConfiguration = await getMobileSyncConfigurationStatus();
        if (
          AppState.currentState === 'active'
          && latestConfiguration.configured
          && supportsMobileScheduledBackgroundSync(latestConfiguration.backend)
        ) {
          logAutomaticScheduleReady('registered');
        }
        void logInfo('Mobile background sync registered', {
          scope: 'sync',
          extra: { backend: latestConfiguration.backend, interval: MOBILE_BACKGROUND_SYNC_INTERVAL },
        });
        return registrationResult(
          { ...snapshot, configuration: latestConfiguration },
          'registered',
          true,
        );
      }

      logRegistrationDecision(snapshot, 'unchanged');
      logAutomaticScheduleReady('unchanged');
      return registrationResult(snapshot, previousAction === 'unregistered' ? 'registered' : 'unchanged', true);
    }

    automaticScheduleReadyLogged = false;
    if (snapshot.registered) {
      logRegistrationDecision(snapshot, 'unregister');
      await BackgroundTask.unregisterTaskAsync(MOBILE_BACKGROUND_SYNC_TASK_NAME);
      await clearLastRegisteredBackgroundSyncInterval();
      void logInfo('Mobile background sync unregistered', {
        scope: 'sync',
        extra: {
          available: String(snapshot.taskManagerAvailable
            && snapshot.status === BackgroundTask.BackgroundTaskStatus.Available),
          backend: snapshot.configuration.backend,
          configured: String(snapshot.configuration.configured),
          interval: MOBILE_BACKGROUND_SYNC_INTERVAL,
        },
      });
      return registrationResult(snapshot, 'unregistered', false);
    }

    if (snapshot.lastRegisteredInterval !== null) {
      await clearLastRegisteredBackgroundSyncInterval();
    }
    return registrationResult(snapshot, previousAction, false);
  }
};

// Queue callers rather than sharing the current promise: a settings callback
// arriving after a backend change must run its own fresh native/config read.
let registrationReconciliationTail: Promise<void> = Promise.resolve();

export function syncMobileBackgroundSyncRegistration(): Promise<MobileBackgroundSyncRegistrationResult> {
  const reconciliation = registrationReconciliationTail.then(
    reconcileAutomaticMobileBackgroundSyncRegistration,
  );
  registrationReconciliationTail = reconciliation.then(
    () => undefined,
    () => undefined,
  );
  return reconciliation;
}
