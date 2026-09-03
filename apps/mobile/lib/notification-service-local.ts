import {
  areDueDateRemindersEnabled,
  areStartDateRemindersEnabled,
  areTaskRemindersEnabled,
  buildReminderSchedule,
  getSystemDefaultLanguage,
  getTranslations,
  hasActiveMobileNotificationFeature,
  isWeeklyReviewReminderEnabled,
  loadStoredLanguage,
  nameNotifyListener,
  type AppLanguage,
  type Language,
  type NotificationSettings,
  type ReminderScheduleRequest,
  useTaskStore,
} from '@mindwtr/core';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeEventEmitter, NativeModules, PermissionsAndroid, Platform } from 'react-native';

import { isLoggingEnabled, logInfo, logWarn } from './app-log';
import { ensureReminderNotificationChannel, restorePersistentCaptureNotification } from '@/modules/notification-open-intents';
import { getDuplicateAlarmRetryFireAt } from './notification-service-local-utils';

type NotificationOpenPayload = {
  notificationId?: string;
  actionIdentifier?: string;
  taskId?: string;
  projectId?: string;
  context?: string;
  kind?: string;
};

type NotificationOpenHandler = (payload: NotificationOpenPayload) => void;

type NotificationPermissionResult = {
  granted: boolean;
  canAskAgain: boolean;
};

type AlarmId = number;

type AlarmScheduleResult = {
  id?: number | string;
};

type AlarmNotificationsApi = {
  parseDate: (date: Date) => string;
  scheduleAlarm: (details: Record<string, unknown>) => Promise<AlarmScheduleResult>;
  sendNotification?: (details: Record<string, unknown>) => void;
  deleteAlarm: (id: AlarmId) => void;
  deleteRepeatingAlarm: (id: AlarmId) => void;
  removeFiredNotification: (id: AlarmId) => void;
  removeAllFiredNotifications: () => void;
  getScheduledAlarms?: () => Promise<unknown>;
  requestPermissions?: (permissions: { alert: boolean; badge: boolean; sound: boolean }) => Promise<unknown>;
};

type LocalAlarmMapEntry = {
  id: AlarmId;
  signature?: string;
};

type PomodoroAlarmEntry = {
  id: AlarmId;
  fireAtMs?: number;
};

type LocalAlarmMap = Record<string, LocalAlarmMapEntry>;

type LocalAlarmConfig = {
  title: string;
  message: string;
  fireAt: Date;
  repeatInterval?: 'daily' | 'weekly';
  hasSnoozeAction?: boolean;
  hasCompleteAction?: boolean;
  data?: Record<string, string>;
};

type NativeEmitterSubscription = {
  remove: () => void;
};

const LOCAL_ALARM_MAP_KEY = 'mindwtr:local:alarms:v1';
const LOCAL_POMODORO_ALARM_KEY = 'mindwtr:local:pomodoro-alarm:v1';
const LOCAL_NOTIFICATION_CHANNEL = 'mindwtr_reminders_v2';
const LOCAL_NOTIFICATION_CHANNEL_NAME = 'Mindwtr reminders';
const LOCAL_NOTIFICATION_COLOR = '#3b82f6';
const LOCAL_SMALL_ICON = 'ic_launcher';
const MAX_DUPLICATE_ALARM_RETRIES = 59;
const MAX_PENDING_ONE_SHOT_REMINDER_ALARMS_IOS = 60;
const MAX_PENDING_ONE_SHOT_REMINDER_ALARMS_ANDROID = 200;
const ALARM_SCHEDULE_BATCH_SIZE = 10;
const ONE_SHOT_TOP_UP_DELAY_MS = 5_000;
const MAX_SETTIMEOUT_DELAY_MS = 24 * 60 * 60 * 1000;
const NOTIFICATION_EVENT_RESCHEDULE_DEBOUNCE_MS = 250;
// A sync cycle updates the store several times within a few seconds
// (write-local, write-remote bookkeeping, refresh); coalesce those into one
// full reschedule scan instead of 2-4 per cycle (#766). Alarms fire minutes
// out, so a short scheduling delay is imperceptible.
const STORE_RESCHEDULE_DEBOUNCE_MS = 2_500;
const TASK_REMINDER_SNOOZE_MINUTES = 10;

let started = false;
let alarmApi: AlarmNotificationsApi | null = null;
let notificationOpenHandler: NotificationOpenHandler | null = null;
let storeSubscription: (() => void) | null = null;
let openSubscription: NativeEmitterSubscription | null = null;
let dismissSubscription: NativeEmitterSubscription | null = null;
let rescheduleTimer: ReturnType<typeof setTimeout> | null = null;
let oneShotTopUpTimer: ReturnType<typeof setTimeout> | null = null;
let notificationEventRescheduleTimer: ReturnType<typeof setTimeout> | null = null;
let rescheduleQueue: Promise<void> = Promise.resolve();
let alarmMap = new Map<string, LocalAlarmMapEntry>();
let loadedAlarmMap = false;
let alarmMapLoadPromise: Promise<void> | null = null;
// Last payload `saveAlarmMap` actually wrote; null means "unknown, write it".
let lastSavedAlarmMapJson: string | null = null;
const configByKey = new Map<string, string>();

type AlarmScheduleRequest = {
  key: string;
  config: LocalAlarmConfig;
};

const logNotificationError = (message: string, error?: unknown) => {
  const extra = error ? { error: error instanceof Error ? error.message : String(error) } : undefined;
  void logWarn(`[Local Notifications] ${message}`, { scope: 'notifications', extra });
};

const logNotificationInfo = (message: string, extra?: Record<string, unknown>) => {
  void logInfo(`[Local Notifications] ${message}`, { scope: 'notifications', extra });
};

const logNotificationWarn = (message: string, extra?: Record<string, unknown>) => {
  void logWarn(`[Local Notifications] ${message}`, { scope: 'notifications', extra });
};

async function loadPomodoroAlarmEntry(): Promise<PomodoroAlarmEntry | null> {
  try {
    const raw = await AsyncStorage.getItem(LOCAL_POMODORO_ALARM_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PomodoroAlarmEntry>;
    const id = Number(parsed?.id);
    if (!Number.isFinite(id)) return null;
    const fireAtMs = Number(parsed?.fireAtMs);
    return {
      id: Math.floor(id),
      ...(Number.isFinite(fireAtMs) ? { fireAtMs } : {}),
    };
  } catch (error) {
    logNotificationError('Failed to load pomodoro alarm', error);
    return null;
  }
}

async function savePomodoroAlarmEntry(entry: PomodoroAlarmEntry): Promise<void> {
  try {
    await AsyncStorage.setItem(LOCAL_POMODORO_ALARM_KEY, JSON.stringify(entry));
  } catch (error) {
    logNotificationError('Failed to persist pomodoro alarm', error);
  }
}

async function clearPomodoroAlarmEntry(): Promise<void> {
  try {
    await AsyncStorage.removeItem(LOCAL_POMODORO_ALARM_KEY);
  } catch (error) {
    logNotificationError('Failed to clear pomodoro alarm', error);
  }
}

function resetRuntimeState(): void {
  configByKey.clear();
  lastSavedAlarmMapJson = null;
  rescheduleQueue = Promise.resolve();
  notificationOpenHandler = null;
  alarmMapLoadPromise = null;
  clearOneShotTopUpTimer();
  clearNotificationEventRescheduleTimer();
}

function clearRescheduleTimer(): void {
  if (!rescheduleTimer) return;
  clearTimeout(rescheduleTimer);
  rescheduleTimer = null;
}

function clearOneShotTopUpTimer(): void {
  if (!oneShotTopUpTimer) return;
  clearTimeout(oneShotTopUpTimer);
  oneShotTopUpTimer = null;
}

function clearNotificationEventRescheduleTimer(): void {
  if (!notificationEventRescheduleTimer) return;
  clearTimeout(notificationEventRescheduleTimer);
  notificationEventRescheduleTimer = null;
}

function getMaxPendingOneShotReminderAlarms(): number {
  return Platform.OS === 'ios'
    ? MAX_PENDING_ONE_SHOT_REMINDER_ALARMS_IOS
    : MAX_PENDING_ONE_SHOT_REMINDER_ALARMS_ANDROID;
}

async function getAndroidNotificationPermissionStatus(): Promise<NotificationPermissionResult> {
  if (Number(Platform.Version) < 33) {
    return { granted: true, canAskAgain: true };
  }

  try {
    const granted = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    return { granted, canAskAgain: !granted };
  } catch (error) {
    logNotificationError('Failed to read Android notification permission', error);
    return { granted: false, canAskAgain: false };
  }
}

async function ensureLocalReminderNotificationChannel(): Promise<void> {
  try {
    await ensureReminderNotificationChannel(LOCAL_NOTIFICATION_CHANNEL, LOCAL_NOTIFICATION_CHANNEL_NAME);
    logNotificationInfo('Android reminder notification channel ensured', {
      channel: LOCAL_NOTIFICATION_CHANNEL,
    });
  } catch (error) {
    logNotificationError('Failed to ensure local notification channel', error);
  }
}

async function loadAlarmApi(): Promise<AlarmNotificationsApi | null> {
  if (alarmApi) return alarmApi;
  try {
    const mod = await import('react-native-alarm-notification');
    const api = mod?.default as AlarmNotificationsApi | undefined;
    if (!api || typeof api.scheduleAlarm !== 'function') {
      logNotificationError('react-native-alarm-notification API unavailable');
      return null;
    }
    alarmApi = api;
    return api;
  } catch (error) {
    logNotificationError('Failed to load react-native-alarm-notification', error);
    return null;
  }
}

async function clearScheduledAlarms(api: AlarmNotificationsApi | null): Promise<void> {
  await loadAlarmMapIfNeeded();
  await cancelLocalPomodoroCompletionNotification(api, { removeFired: true, reason: 'service-clear' });
  const scheduledAlarmCount = alarmMap.size;

  if (api) {
    for (const entry of alarmMap.values()) {
      try {
        api.deleteAlarm(entry.id);
        api.deleteRepeatingAlarm(entry.id);
        api.removeFiredNotification(entry.id);
      } catch (error) {
        logNotificationError('Failed to cancel local alarm', error);
      }
    }

    try {
      api.removeAllFiredNotifications();
    } catch {
      // no-op
    }

    // removeAllFiredNotifications() is NotificationManager.cancelAll(): it also
    // wipes the pinned quick-capture notification, which is why the handle
    // vanished whenever reminders were off (#819). Re-assert it from its
    // native mirror; a no-op when the capture toggle is off.
    try {
      restorePersistentCaptureNotification();
    } catch {
      // no-op
    }
  }

  alarmMap.clear();
  await saveAlarmMap();
  loadedAlarmMap = false;
  logNotificationInfo('Scheduled alarms cleared', { scheduledAlarmCount });
}

function serializeAlarmMap(map: Map<string, LocalAlarmMapEntry>): LocalAlarmMap {
  const result: LocalAlarmMap = {};
  for (const [key, value] of map.entries()) {
    result[key] = value;
  }
  return result;
}

async function loadAlarmMapIfNeeded(): Promise<void> {
  if (loadedAlarmMap) return;
  if (alarmMapLoadPromise) {
    await alarmMapLoadPromise;
    return;
  }
  alarmMapLoadPromise = (async () => {
    try {
      const raw = await AsyncStorage.getItem(LOCAL_ALARM_MAP_KEY);
      if (!raw) {
        alarmMap = new Map<string, LocalAlarmMapEntry>();
        loadedAlarmMap = true;
        return;
      }
      const parsed = JSON.parse(raw) as LocalAlarmMap;
      const nextMap = new Map<string, LocalAlarmMapEntry>();
      for (const [key, value] of Object.entries(parsed)) {
        if (!value || typeof value !== 'object') continue;
        const id = Number((value as LocalAlarmMapEntry).id);
        if (!Number.isFinite(id)) continue;
        const signature = typeof (value as LocalAlarmMapEntry).signature === 'string'
          ? (value as LocalAlarmMapEntry).signature
          : undefined;
        nextMap.set(key, { id: Math.floor(id), signature });
        if (signature) {
          configByKey.set(key, signature);
        }
      }
      alarmMap = nextMap;
      loadedAlarmMap = true;
    } catch (error) {
      alarmMap = new Map<string, LocalAlarmMapEntry>();
      loadedAlarmMap = false;
      logNotificationError('Failed to load alarm map', error);
    }
  })().finally(() => {
    alarmMapLoadPromise = null;
  });
  await alarmMapLoadPromise;
}

async function saveAlarmMap(): Promise<void> {
  // Every reschedule cycle ends here, but a cycle that re-derives the same
  // alarms leaves the map byte-identical — the common case, since most saves
  // touch no reminder-relevant field. Comparing the serialized form catches
  // that regardless of which path mutated the map (schedule, cancel, clear),
  // so a no-op cycle costs no AsyncStorage write (#766).
  const serialized = JSON.stringify(serializeAlarmMap(alarmMap));
  if (serialized === lastSavedAlarmMapJson) return;
  try {
    await AsyncStorage.setItem(LOCAL_ALARM_MAP_KEY, serialized);
    lastSavedAlarmMapJson = serialized;
  } catch (error) {
    lastSavedAlarmMapJson = null;
    logNotificationError('Failed to persist alarm map', error);
  }
}

function toAlarmFireDate(api: AlarmNotificationsApi, date: Date): string {
  const next = new Date(date);
  next.setMilliseconds(0);
  return api.parseDate(next);
}

function isDuplicateAlarmError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes('duplicate alarm set at date');
}

function parseEventPayload(value: unknown): Record<string, string> | null {
  const raw = typeof value === 'string' ? value : null;
  try {
    const parsed = raw ? JSON.parse(raw) as unknown : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const result: Record<string, string> = {};
    for (const [key, item] of Object.entries(parsed as Record<string, unknown>)) {
      if (key === 'data') {
        const nested = parseEventPayload(item);
        if (nested) {
          for (const [nestedKey, nestedValue] of Object.entries(nested)) {
            result[nestedKey] ??= nestedValue;
          }
        }
      } else if (typeof item === 'string') {
        result[key] = item;
      } else if (item !== undefined && item !== null) {
        result[key] = String(item);
      }
    }
    return result;
  } catch {
    return null;
  }
}

function attachNativeEventListeners(): void {
  const nativeModule = (NativeModules as Record<string, unknown>).RNAlarmNotification;
  if (!nativeModule) return;

  const emitter = new NativeEventEmitter(nativeModule as any);

  openSubscription?.remove();
  openSubscription = emitter.addListener('OnNotificationOpened', (payload: unknown) => {
    const data = parseEventPayload(payload);
    if (!data) {
      logNotificationWarn('Notification event payload was unreadable');
      return;
    }
    // Receipt evidence for #1028: every tap that reaches JS is logged, so a
    // dead action button with no line here means the tap died in the native
    // layer (receiver never ran, or the alarm row it looks up is gone).
    logNotificationInfo('Notification opened event', {
      action: data.actionIdentifier || 'open',
      alarmKey: data.alarmKey || data.id || '',
      taskId: data.taskId || '',
      handlerAttached: String(Boolean(notificationOpenHandler)),
    });
    if (data.kind === 'pomodoro') {
      // Presentation evidence for #888: a tap proves iOS actually showed it.
      logNotificationInfo('Pomodoro notification opened', { id: data.alarmKey || data.id || '' });
    }
    if (alarmApi && (data.taskId || data.projectId)) {
      enqueueNotificationEventReschedule(alarmApi);
    }
    if (!notificationOpenHandler) return;
    try {
      notificationOpenHandler({
        notificationId: data.alarmKey || data.id,
        actionIdentifier: data.actionIdentifier || 'open',
        taskId: data.taskId,
        projectId: data.projectId,
        context: data.context,
        kind: data.kind,
      });
    } catch (error) {
      logNotificationError('Failed to handle notification open event', error);
    }
  });

  dismissSubscription?.remove();
  dismissSubscription = emitter.addListener('OnNotificationDismissed', (payload: unknown) => {
    const data = parseEventPayload(payload);
    logNotificationInfo('Notification dismissed event', {
      alarmKey: data?.alarmKey || data?.id || '',
      taskId: data?.taskId || '',
    });
    if (data?.kind === 'pomodoro') {
      logNotificationInfo('Pomodoro notification dismissed', { id: data.alarmKey || data.id || '' });
    }
    if (alarmApi && data && (data.taskId || data.projectId)) {
      enqueueNotificationEventReschedule(alarmApi);
    }
  });
}

function buildAlarmConfigSignature(config: LocalAlarmConfig): string {
  const repeatSchedule = (() => {
    if (!config.repeatInterval) return config.fireAt.toISOString();
    const hours = String(config.fireAt.getHours()).padStart(2, '0');
    const minutes = String(config.fireAt.getMinutes()).padStart(2, '0');
    if (config.repeatInterval === 'weekly') {
      return `${config.repeatInterval}:${config.fireAt.getDay()}:${hours}:${minutes}`;
    }
    return `${config.repeatInterval}:${hours}:${minutes}`;
  })();
  return JSON.stringify({
    title: config.title,
    message: config.message,
    fireAt: repeatSchedule,
    repeatInterval: config.repeatInterval ?? 'once',
    hasSnoozeAction: config.hasSnoozeAction === true,
    ...(config.hasCompleteAction === true ? { hasCompleteAction: true } : {}),
    data: config.data ?? {},
  });
}

function normalizeNotificationMessage(title: string, message?: string): string {
  const trimmedMessage = String(message || '').trim();
  if (trimmedMessage) return trimmedMessage;

  return String(title || '').trim();
}

async function cancelAlarmByKey(api: AlarmNotificationsApi, key: string): Promise<boolean> {
  const entry = alarmMap.get(key);
  if (!entry) return false;
  try {
    api.deleteAlarm(entry.id);
  } catch (error) {
    logNotificationError(`Failed to delete alarm (${key})`, error);
  }
  try {
    api.deleteRepeatingAlarm(entry.id);
  } catch {
    // Safe to ignore when alarm is one-shot.
  }
  try {
    api.removeFiredNotification(entry.id);
  } catch {
    // Safe to ignore if notification has not fired.
  }
  alarmMap.delete(key);
  configByKey.delete(key);
  logNotificationInfo('Alarm canceled', { alarmKey: key, alarmId: entry.id });
  return true;
}

async function scheduleAlarmForKey(api: AlarmNotificationsApi, key: string, config: LocalAlarmConfig): Promise<void> {
  const signature = buildAlarmConfigSignature(config);
  const existingAlarm = alarmMap.get(key);
  const existingSignature = configByKey.get(key) ?? existingAlarm?.signature;
  if (existingAlarm && existingSignature === signature) {
    configByKey.set(key, signature);
    return;
  }

  await cancelAlarmByKey(api, key);

  const baseFireAt = new Date(config.fireAt);
  baseFireAt.setMilliseconds(0);

  const detailsBase: Record<string, unknown> = {
    title: config.title,
    message: normalizeNotificationMessage(config.title, config.message),
    channel: LOCAL_NOTIFICATION_CHANNEL,
    auto_cancel: true,
    small_icon: LOCAL_SMALL_ICON,
    color: LOCAL_NOTIFICATION_COLOR,
    has_button: config.hasSnoozeAction === true || config.hasCompleteAction === true,
    has_complete_action: config.hasCompleteAction === true,
    loop_sound: false,
    play_sound: true,
    schedule_type: config.repeatInterval ? 'repeat' : 'once',
    repeat_interval: config.repeatInterval ?? 'hourly',
    interval_value: 1,
    use_big_text: true,
    vibrate: false,
    data: {
      ...(config.data ?? {}),
      alarmKey: key,
      ...(config.hasCompleteAction === true ? { notificationActionComplete: 'true' } : {}),
    },
    ...(config.hasSnoozeAction === true ? { snooze_interval: TASK_REMINDER_SNOOZE_MINUTES } : {}),
  };

  let scheduledId: number | null = null;
  let lastError: unknown = null;

  for (let retry = 0; retry <= MAX_DUPLICATE_ALARM_RETRIES; retry += 1) {
    // The Android alarm library treats same-minute alarms as duplicates.
    const fireAt = getDuplicateAlarmRetryFireAt(baseFireAt, retry);
    try {
      const result = await api.scheduleAlarm({
        ...detailsBase,
        fire_date: toAlarmFireDate(api, fireAt),
      });
      const id = Number(result?.id);
      if (!Number.isFinite(id)) {
        logNotificationError(`Scheduled alarm returned invalid id for ${key}`);
        return;
      }
      scheduledId = Math.floor(id);
      logNotificationInfo('Alarm scheduled', {
        alarmKey: key,
        alarmId: scheduledId,
        fireAt: fireAt.toISOString(),
        retryCount: retry,
        scheduleType: config.repeatInterval ? 'repeat' : 'once',
      });
      break;
    } catch (error) {
      lastError = error;
      if (isDuplicateAlarmError(error) && retry < MAX_DUPLICATE_ALARM_RETRIES) {
        continue;
      }
      logNotificationError(`Failed to schedule alarm (${key})`, error);
      throw error;
    }
  }

  if (scheduledId === null) {
    logNotificationError(`Failed to schedule alarm for ${key} after duplicate retries`, lastError);
    return;
  }

  alarmMap.set(key, { id: scheduledId, signature });
  configByKey.set(key, signature);
}

async function scheduleAlarmRequests(api: AlarmNotificationsApi, requests: AlarmScheduleRequest[]): Promise<void> {
  for (let index = 0; index < requests.length; index += ALARM_SCHEDULE_BATCH_SIZE) {
    const batch = requests.slice(index, index + ALARM_SCHEDULE_BATCH_SIZE);
    await Promise.all(batch.map((request) => scheduleAlarmForKey(api, request.key, request.config)));
  }
}

// Pending requests the OS actually holds, for the cycle-complete log only —
// never used to drive cancellation. A count above `alarmMap.size` is the
// signature of #1020 (a cancel that silently removed nothing), and it is the
// one number that separates "still leaking" from "orphans from before the fix
// firing one last time" without another week of counting notifications by
// hand. Returns null when the module cannot enumerate.
//
// Diagnostics-only, so it is gated on logging: the enumeration is a native
// round-trip that a reschedule cycle otherwise pays on every store change even
// though nothing reads the result with logging off (#766).
async function countPendingNativeAlarms(api: AlarmNotificationsApi): Promise<number | null> {
  if (!isLoggingEnabled()) return null;
  if (typeof api.getScheduledAlarms !== 'function') return null;
  try {
    const pending = await api.getScheduledAlarms();
    return Array.isArray(pending) ? pending.length : null;
  } catch (error) {
    logNotificationError('Failed to read pending native alarms', error);
    return null;
  }
}

async function cancelInactiveKeys(api: AlarmNotificationsApi, activeKeys: Set<string>): Promise<void> {
  for (const key of Array.from(alarmMap.keys())) {
    if (activeKeys.has(key)) continue;
    await cancelAlarmByKey(api, key);
  }
}

function scheduleOneShotTopUp(api: AlarmNotificationsApi, sortedFireAtMs: number[], nowMs: number): void {
  clearOneShotTopUpTimer();
  if (sortedFireAtMs.length === 0) return;

  const nextFireAtMs = sortedFireAtMs[0];
  if (!Number.isFinite(nextFireAtMs)) return;

  const rawDelayMs = Math.max(ONE_SHOT_TOP_UP_DELAY_MS, nextFireAtMs - nowMs + ONE_SHOT_TOP_UP_DELAY_MS);
  const delayMs = Math.min(MAX_SETTIMEOUT_DELAY_MS, rawDelayMs);
  oneShotTopUpTimer = setTimeout(() => {
    oneShotTopUpTimer = null;
    enqueueReschedule(api);
  }, delayMs);
}

function toLocalAlarmConfig(request: ReminderScheduleRequest): LocalAlarmConfig {
  return {
    title: request.title,
    message: request.message,
    fireAt: request.fireAt,
    repeatInterval: request.repeatInterval,
    hasSnoozeAction: request.hasSnoozeAction,
    hasCompleteAction: request.hasCompleteAction,
    data: request.data,
  };
}

// Every field a reschedule cycle actually reads (runRescheduleCycle's own
// gates plus buildReminderSchedule's: areTaskRemindersEnabled,
// areStartDateRemindersEnabled, areDueDateRemindersEnabled,
// isWeeklyReviewReminderEnabled, hasActiveMobileNotificationFeature,
// getDigestSchedule, and reviewAtNotificationsEnabled) plus `language`: the
// cycle localizes every alarm title/body from it (see the language read near
// the translations load below), so a language switch must re-arm too even
// though buildReminderSchedule itself never reads it directly (correction
// #3). A settings object can change identity every sync cycle
// (lastSyncAt/lastSyncStatus/lastSyncStats bookkeeping) without moving any of
// these, so the store-change guard below compares this signature instead of
// settings identity (#766).
function buildReminderRelevantSettingsSignature(
  settings: NotificationSettings & { language?: AppLanguage },
): string {
  return JSON.stringify([
    settings.notificationsEnabled,
    settings.startDateNotificationsEnabled,
    settings.dueDateNotificationsEnabled,
    settings.weeklyReviewEnabled,
    settings.reviewAtNotificationsEnabled,
    settings.dailyDigestMorningEnabled,
    settings.dailyDigestMorningTime,
    settings.dailyDigestEveningEnabled,
    settings.dailyDigestEveningTime,
    settings.weeklyReviewDay,
    settings.weeklyReviewTime,
    settings.language,
  ]);
}

async function runRescheduleCycle(api: AlarmNotificationsApi): Promise<void> {
  const cycleStartedAtMs = Date.now();
  await loadAlarmMapIfNeeded();

  const { settings, tasks, projects } = useTaskStore.getState();
  const activeKeys = new Set<string>();
  const taskRemindersEnabled = areTaskRemindersEnabled(settings);
  const includeStartTime = areStartDateRemindersEnabled(settings);
  const includeDueDate = areDueDateRemindersEnabled(settings);
  const weeklyReviewEnabled = isWeeklyReviewReminderEnabled(settings);
  const activeFeature = hasActiveMobileNotificationFeature(settings);

  logNotificationInfo('Reschedule cycle started', {
    taskCount: tasks.length,
    projectCount: projects.length,
    existingAlarmCount: alarmMap.size,
    activeFeature,
    taskRemindersEnabled,
    includeStartTime,
    includeDueDate,
    includeReviewAt: taskRemindersEnabled && settings.reviewAtNotificationsEnabled !== false,
    weeklyReviewEnabled,
  });

  if (!activeFeature) {
    clearOneShotTopUpTimer();
    for (const key of Array.from(alarmMap.keys())) {
      await cancelAlarmByKey(api, key);
    }
    await saveAlarmMap();
    logNotificationInfo('Reschedule cycle complete', {
      activeFeature,
      scheduledAlarmCount: alarmMap.size,
      oneShotReminderCount: 0,
      scheduledOneShotReminderCount: 0,
      durationMs: Date.now() - cycleStartedAtMs,
    });
    return;
  }

  const language: Language = await loadStoredLanguage(AsyncStorage, getSystemDefaultLanguage()).catch(() => getSystemDefaultLanguage());
  const tr = await getTranslations(language);
  const now = new Date();

  // Derivation lives in core (`buildReminderSchedule`): digests, weekly review, every task's
  // next reminder plus its due-time repeats, and project reviews, already sorted and capped.
  // This effect layer only reconciles the resulting request set against AlarmManager.
  const { requests, diagnostics } = buildReminderSchedule({
    settings,
    tasks,
    projects,
    now,
    translations: tr,
    maxOneShotReminders: getMaxPendingOneShotReminderAlarms(),
  });

  const recurringRequests = requests.filter((request) => request.repeatInterval);
  const oneShotRequests = requests.filter((request) => !request.repeatInterval);

  for (const request of recurringRequests) {
    activeKeys.add(request.key);
    await scheduleAlarmForKey(api, request.key, toLocalAlarmConfig(request));
  }

  for (const request of oneShotRequests) {
    activeKeys.add(request.key);
  }
  await scheduleAlarmRequests(api, oneShotRequests.map((request) => ({
    key: request.key,
    config: toLocalAlarmConfig(request),
  })));
  scheduleOneShotTopUp(api, oneShotRequests.map((request) => request.fireAt.getTime()), now.getTime());

  await cancelInactiveKeys(api, activeKeys);
  await saveAlarmMap();
  logNotificationInfo('Reschedule cycle complete', {
    activeFeature,
    scheduledAlarmCount: alarmMap.size,
    pendingNativeAlarmCount: await countPendingNativeAlarms(api),
    oneShotReminderCount: diagnostics.oneShotReminderCount,
    scheduledOneShotReminderCount: oneShotRequests.length,
    maxPendingOneShotReminderAlarms: getMaxPendingOneShotReminderAlarms(),
    nextOneShotFireAt: oneShotRequests[0]?.fireAt.toISOString() ?? '',
    taskReminderCount: diagnostics.taskReminderCount,
    taskReviewReminderCount: diagnostics.taskReviewReminderCount,
    projectReviewReminderCount: diagnostics.projectReviewReminderCount,
    dateOnlyDueDateCount: diagnostics.dateOnlyDueDateCount,
    futureDueDateReminderCount: diagnostics.futureDueDateReminderCount,
    pastDueDateReminderCount: diagnostics.pastDueDateReminderCount,
    dateOnlyStartTimeCount: diagnostics.dateOnlyStartTimeCount,
    futureStartTimeReminderCount: diagnostics.futureStartTimeReminderCount,
    pastStartTimeReminderCount: diagnostics.pastStartTimeReminderCount,
    futureTaskReviewReminderCount: diagnostics.futureTaskReviewReminderCount,
    pastTaskReviewReminderCount: diagnostics.pastTaskReviewReminderCount,
    suppressedTaskReminderCount: diagnostics.suppressedTaskReminderCount,
    durationMs: Date.now() - cycleStartedAtMs,
  });
}

function enqueueReschedule(api: AlarmNotificationsApi): void {
  rescheduleQueue = rescheduleQueue
    .catch(() => undefined)
    .then(async () => {
      await runRescheduleCycle(api);
    })
    .catch((error) => logNotificationError('Failed to reschedule local notifications', error));
}

function enqueueNotificationEventReschedule(api: AlarmNotificationsApi): void {
  clearNotificationEventRescheduleTimer();
  notificationEventRescheduleTimer = setTimeout(() => {
    notificationEventRescheduleTimer = null;
    enqueueReschedule(api);
  }, NOTIFICATION_EVENT_RESCHEDULE_DEBOUNCE_MS);
}

export function setLocalNotificationOpenHandler(handler: NotificationOpenHandler | null): void {
  notificationOpenHandler = handler;
  if (handler) {
    attachNativeEventListeners();
  }
}

export async function requestLocalNotificationPermission(): Promise<NotificationPermissionResult> {
  if (Platform.OS === 'android') {
    const currentStatus = await getAndroidNotificationPermissionStatus();
    logNotificationInfo('Android notification permission checked', currentStatus);
    if (currentStatus.granted) {
      await ensureLocalReminderNotificationChannel();
      return currentStatus;
    }

    try {
      const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      logNotificationInfo('Android notification permission requested', { result });
      if (result === PermissionsAndroid.RESULTS.GRANTED) {
        await ensureLocalReminderNotificationChannel();
        return { granted: true, canAskAgain: true };
      }
      if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
        return { granted: false, canAskAgain: false };
      }
      return { granted: false, canAskAgain: true };
    } catch (error) {
      logNotificationError('Failed to request Android notification permission', error);
      return { granted: false, canAskAgain: false };
    }
  }

  const api = await loadAlarmApi();
  if (!api || typeof api.requestPermissions !== 'function') {
    return { granted: false, canAskAgain: false };
  }

  try {
    const result = await api.requestPermissions({ alert: true, badge: true, sound: true });
    const granted = Boolean((result as { alert?: boolean } | undefined)?.alert);
    return { granted, canAskAgain: !granted };
  } catch (error) {
    logNotificationError('Failed to request iOS notification permission', error);
    return { granted: false, canAskAgain: false };
  }
}

export async function sendLocalMobileNotification(
  title: string,
  message?: string,
  data?: Record<string, string>
): Promise<void> {
  const trimmedTitle = String(title || '').trim();
  if (!trimmedTitle) return;

  const api = await loadAlarmApi();
  if (!api) return;

  const permission = await requestLocalNotificationPermission();
  if (!permission.granted) return;

  try {
    const details = {
      title: trimmedTitle,
      message: normalizeNotificationMessage(trimmedTitle, message),
      channel: LOCAL_NOTIFICATION_CHANNEL,
      auto_cancel: true,
      small_icon: LOCAL_SMALL_ICON,
      color: LOCAL_NOTIFICATION_COLOR,
      has_button: false,
      loop_sound: false,
      play_sound: true,
      use_big_text: true,
      vibrate: false,
      data: {
        kind: 'pomodoro',
        ...(data ?? {}),
      },
    };

    if (typeof api.sendNotification === 'function') {
      api.sendNotification(details);
      return;
    }

    await api.scheduleAlarm({
      ...details,
      fire_date: api.parseDate(new Date(Date.now() + 2000)),
      schedule_type: 'once',
    });
  } catch (error) {
    logNotificationError('Failed to send local mobile notification', error);
  }
}

export async function cancelLocalPomodoroCompletionNotification(
  loadedApi?: AlarmNotificationsApi | null,
  options: { removeFired?: boolean; reason?: string } = {},
): Promise<void> {
  const api = loadedApi ?? await loadAlarmApi();
  const entry = await loadPomodoroAlarmEntry();
  if (entry) {
    // Every path that kills a pending completion alert must say so: #888's
    // empty diagnostic log was itself the bug report.
    logNotificationInfo('Pomodoro alarm cancelled', {
      alarmId: entry.id,
      reason: options.reason ?? 'unspecified',
      fireAt: entry.fireAtMs ? new Date(entry.fireAtMs).toISOString() : '',
      apiAvailable: String(Boolean(api)),
    });
  }
  if (api && entry) {
    try {
      api.deleteAlarm(entry.id);
      api.deleteRepeatingAlarm(entry.id);
      const shouldRemoveFired = options.removeFired ?? (!entry.fireAtMs || entry.fireAtMs > Date.now());
      if (shouldRemoveFired) {
        api.removeFiredNotification(entry.id);
      }
    } catch (error) {
      logNotificationError('Failed to cancel pomodoro alarm', error);
    }
  }
  await clearPomodoroAlarmEntry();
}

export async function scheduleLocalPomodoroCompletionNotification(
  title: string,
  message: string,
  fireAt: Date,
  data?: Record<string, string>,
): Promise<void> {
  const trimmedTitle = String(title || '').trim();
  const fireAtMs = fireAt.getTime();
  const fireAtValid = Number.isFinite(fireAtMs);

  // The very first statement, before every gate: a diagnostic log with no
  // "requested" line now proves the panel never asked for an alert at all —
  // an empty log used to be ambiguous (#888).
  logNotificationInfo('Pomodoro alarm requested', {
    fireAt: fireAtValid ? new Date(fireAtMs).toISOString() : 'invalid',
    inMs: fireAtValid ? String(fireAtMs - Date.now()) : 'invalid',
    phase: data?.phase ?? '',
    hasTitle: String(Boolean(trimmedTitle)),
  });

  if (!trimmedTitle) {
    logNotificationWarn('Pomodoro alarm skipped; empty title');
    return;
  }
  if (!fireAtValid) {
    logNotificationWarn('Pomodoro alarm skipped; invalid fire date');
    return;
  }

  const api = await loadAlarmApi();
  if (!api) {
    logNotificationWarn('Pomodoro alarm skipped; alarm module unavailable');
    return;
  }

  const permission = await requestLocalNotificationPermission();
  if (!permission.granted) {
    logNotificationWarn('Pomodoro alarm skipped; notification permission not granted');
    return;
  }

  if (fireAtMs <= Date.now() + 1000) {
    logNotificationInfo('Pomodoro completion already due; notifying immediately');
    await cancelLocalPomodoroCompletionNotification(api, { reason: 'past-due-immediate' });
    await sendLocalMobileNotification(trimmedTitle, message, data);
    return;
  }

  const previousEntry = await loadPomodoroAlarmEntry();

  try {
    const result = await api.scheduleAlarm({
      title: trimmedTitle,
      message: normalizeNotificationMessage(trimmedTitle, message),
      channel: LOCAL_NOTIFICATION_CHANNEL,
      auto_cancel: true,
      small_icon: LOCAL_SMALL_ICON,
      color: LOCAL_NOTIFICATION_COLOR,
      has_button: false,
      // The patched iOS module reads this key into a dictionary literal, where
      // a missing value is nil and throws NSInvalidArgumentException — the
      // reason no pomodoro alert ever scheduled on iOS (#888). Always pass it,
      // like the task-reminder path does.
      has_complete_action: false,
      loop_sound: false,
      play_sound: true,
      schedule_type: 'once',
      use_big_text: true,
      vibrate: false,
      fire_date: toAlarmFireDate(api, fireAt),
      data: {
        kind: 'pomodoro',
        ...(data ?? {}),
      },
    });
    const id = Number(result?.id);
    if (!Number.isFinite(id)) {
      logNotificationError('Pomodoro alarm returned invalid id');
      return;
    }
    const scheduledId = Math.floor(id);
    await savePomodoroAlarmEntry({ id: scheduledId, fireAtMs });
    logNotificationInfo('Pomodoro alarm scheduled', {
      alarmId: scheduledId,
      fireAt: new Date(fireAtMs).toISOString(),
    });
    // Cancel the superseded alarm only after its replacement exists, so an app
    // suspension mid-flight never leaves a running phase with no pending alert.
    // Skip when the ids match: the iOS module keys requests by creation second,
    // so a same-second reschedule already replaced the old request natively and
    // deleting the shared id would remove the alarm we just scheduled (#888).
    if (previousEntry && previousEntry.id !== scheduledId) {
      try {
        api.deleteAlarm(previousEntry.id);
        api.deleteRepeatingAlarm(previousEntry.id);
        if (!previousEntry.fireAtMs || previousEntry.fireAtMs > Date.now()) {
          api.removeFiredNotification(previousEntry.id);
        }
      } catch (error) {
        logNotificationError('Failed to cancel superseded pomodoro alarm', error);
      }
    }
  } catch (error) {
    logNotificationError('Failed to schedule pomodoro alarm', error);
  }
}

export async function startLocalMobileNotifications(): Promise<void> {
  if (started) {
    logNotificationInfo('Start requested while service is already running; rescheduling current reminders');
    const api = await loadAlarmApi();
    if (api) {
      await runRescheduleCycle(api);
    }
    return;
  }
  started = true;
  logNotificationInfo('Start requested', {
    platform: Platform.OS,
    platformVersion: String(Platform.Version),
  });

  const api = await loadAlarmApi();
  if (!api) {
    logNotificationInfo('Start aborted; alarm API unavailable');
    started = false;
    return;
  }

  const permission = await requestLocalNotificationPermission();
  if (!permission.granted) {
    logNotificationInfo('Start aborted; notification permission not granted', permission);
    await clearScheduledAlarms(api);
    started = false;
    return;
  }

  attachNativeEventListeners();
  await runRescheduleCycle(api);
  logNotificationInfo('Service started');

  storeSubscription?.();
  storeSubscription = useTaskStore.subscribe(nameNotifyListener('notification-reschedule', (state, prevState) => {
    // Reschedule cycles only read tasks, projects, and a handful of settings
    // fields. tasks/projects re-arm on any identity change (cheap reference
    // compare). settings re-arms only when a reminder-relevant field actually
    // moved: an unchanged sync cycle still rewrites lastSyncAt/lastSyncStatus/
    // lastSyncStats into a fresh settings object every time (#766).
    const tasksOrProjectsChanged = state.tasks !== prevState.tasks || state.projects !== prevState.projects;
    const settingsRelevantChanged = state.settings !== prevState.settings
      && buildReminderRelevantSettingsSignature(state.settings) !== buildReminderRelevantSettingsSignature(prevState.settings);
    if (!tasksOrProjectsChanged && !settingsRelevantChanged) {
      return;
    }
    clearRescheduleTimer();
    rescheduleTimer = setTimeout(() => {
      rescheduleTimer = null;
      enqueueReschedule(api);
    }, STORE_RESCHEDULE_DEBOUNCE_MS);
  }));
}

// AlarmManager decides exact vs inexact when the alarm is *created*, so alarms
// that were scheduled while "Alarms & reminders" was denied stay inexact after
// the user allows it. `scheduleAlarmForKey` skips any key whose config
// signature is unchanged, so a plain reschedule cycle would re-confirm every
// stale alarm instead of re-creating it. Cancel first, then run the one
// existing cycle so it rebuilds them all as exact.
export async function rescheduleLocalAlarmsAsExact(): Promise<void> {
  if (!started) return;
  const api = await loadAlarmApi();
  if (!api) return;
  logNotificationInfo('Rebuilding alarms as exact after exact-alarm permission grant');
  rescheduleQueue = rescheduleQueue
    .catch(() => undefined)
    .then(async () => {
      await loadAlarmMapIfNeeded();
      for (const key of Array.from(alarmMap.keys())) {
        await cancelAlarmByKey(api, key);
      }
      await runRescheduleCycle(api);
    })
    .catch((error) => logNotificationError('Failed to rebuild alarms as exact', error));
  await rescheduleQueue;
}

export async function stopLocalMobileNotifications(): Promise<void> {
  logNotificationInfo('Stop requested');
  clearRescheduleTimer();
  clearNotificationEventRescheduleTimer();

  storeSubscription?.();
  storeSubscription = null;

  openSubscription?.remove();
  openSubscription = null;

  dismissSubscription?.remove();
  dismissSubscription = null;
  notificationOpenHandler = null;

  const api = await loadAlarmApi();
  await clearScheduledAlarms(api);
  resetRuntimeState();
  started = false;
  logNotificationInfo('Service stopped');
}

export async function getLocalNotificationPermissionStatus(): Promise<NotificationPermissionResult> {
  if (Platform.OS === 'android') {
    return getAndroidNotificationPermissionStatus();
  }
  return requestLocalNotificationPermission();
}

export const __localNotificationTestUtils = {
  loadAlarmMapIfNeeded,
  getAlarmMapSnapshot: () => new Map(alarmMap),
  getNotificationOpenHandler: () => notificationOpenHandler,
  isAlarmMapLoaded: () => loadedAlarmMap,
  resetForTests: () => {
    clearRescheduleTimer();
    storeSubscription?.();
    storeSubscription = null;
    openSubscription?.remove();
    openSubscription = null;
    dismissSubscription?.remove();
    dismissSubscription = null;
    started = false;
    alarmApi = null;
    alarmMap = new Map<string, LocalAlarmMapEntry>();
    loadedAlarmMap = false;
    resetRuntimeState();
  },
};
