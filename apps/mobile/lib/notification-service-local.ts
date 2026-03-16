import {
  getNextScheduledAt,
  getSystemDefaultLanguage,
  getTranslations,
  hasTimeComponent,
  loadStoredLanguage,
  parseTimeOfDay,
  safeParseDate,
  type Language,
  useTaskStore,
} from '@mindwtr/core';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeEventEmitter, NativeModules, PermissionsAndroid, Platform } from 'react-native';

import { logWarn } from './app-log';
import { getDuplicateAlarmRetryFireAt } from './notification-service-local-utils';

type NotificationOpenPayload = {
  notificationId?: string;
  actionIdentifier?: string;
  taskId?: string;
  projectId?: string;
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
  deleteAlarm: (id: AlarmId) => void;
  deleteRepeatingAlarm: (id: AlarmId) => void;
  removeFiredNotification: (id: AlarmId) => void;
  removeAllFiredNotifications: () => void;
  requestPermissions?: (permissions: { alert: boolean; badge: boolean; sound: boolean }) => Promise<unknown>;
};

type LocalAlarmMapEntry = {
  id: AlarmId;
};

type LocalAlarmMap = Record<string, LocalAlarmMapEntry>;

type LocalAlarmConfig = {
  title: string;
  message: string;
  fireAt: Date;
  repeatInterval?: 'daily' | 'weekly';
  data?: Record<string, string>;
};

type NativeEmitterSubscription = {
  remove: () => void;
};

const LOCAL_ALARM_MAP_KEY = 'mindwtr:local:alarms:v1';
const LOCAL_ALARM_CHANNEL = 'mindwtr_reminders_v2';
const LOCAL_NOTIFICATION_COLOR = '#3b82f6';
const LOCAL_SMALL_ICON = 'ic_launcher';
const LOCAL_DIGEST_MORNING_KEY = 'digest:morning';
const LOCAL_DIGEST_EVENING_KEY = 'digest:evening';
const LOCAL_WEEKLY_REVIEW_KEY = 'digest:weekly-review';
const LOCAL_TASK_KEY_PREFIX = 'task:';
const LOCAL_PROJECT_KEY_PREFIX = 'project:';
const MAX_DUPLICATE_ALARM_RETRIES = 59;

let started = false;
let alarmApi: AlarmNotificationsApi | null = null;
let notificationOpenHandler: NotificationOpenHandler | null = null;
let storeSubscription: (() => void) | null = null;
let openSubscription: NativeEmitterSubscription | null = null;
let dismissSubscription: NativeEmitterSubscription | null = null;
let rescheduleTimer: ReturnType<typeof setTimeout> | null = null;
let rescheduleQueue: Promise<void> = Promise.resolve();
let alarmMap = new Map<string, LocalAlarmMapEntry>();
let loadedAlarmMap = false;
let alarmMapLoadPromise: Promise<void> | null = null;
const configByKey = new Map<string, string>();

const logNotificationError = (message: string, error?: unknown) => {
  const extra = error ? { error: error instanceof Error ? error.message : String(error) } : undefined;
  void logWarn(`[Local Notifications] ${message}`, { scope: 'notifications', extra });
};

function getTaskKey(taskId: string): string {
  return `${LOCAL_TASK_KEY_PREFIX}${taskId}`;
}

function getProjectKey(projectId: string): string {
  return `${LOCAL_PROJECT_KEY_PREFIX}${projectId}`;
}

function resetRuntimeState(): void {
  configByKey.clear();
  rescheduleQueue = Promise.resolve();
  notificationOpenHandler = null;
  alarmMapLoadPromise = null;
}

function clearRescheduleTimer(): void {
  if (!rescheduleTimer) return;
  clearTimeout(rescheduleTimer);
  rescheduleTimer = null;
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
  }

  alarmMap.clear();
  await saveAlarmMap();
  loadedAlarmMap = false;
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
        nextMap.set(key, { id: Math.floor(id) });
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
  try {
    await AsyncStorage.setItem(LOCAL_ALARM_MAP_KEY, JSON.stringify(serializeAlarmMap(alarmMap)));
  } catch (error) {
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

function nextDailyTime(hour: number, minute: number): Date {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

function nextWeeklyTime(dayOfWeekSundayFirst: number, hour: number, minute: number): Date {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);

  const current = next.getDay(); // 0 = Sunday
  let delta = dayOfWeekSundayFirst - current;
  if (delta < 0) {
    delta += 7;
  }
  if (delta === 0 && next.getTime() <= now.getTime()) {
    delta = 7;
  }

  next.setDate(next.getDate() + delta);
  return next;
}

function parseEventPayload(value: unknown): Record<string, string> | null {
  const raw = (() => {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
      try {
        return JSON.stringify(value);
      } catch {
        return null;
      }
    }
    return null;
  })();

  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const result: Record<string, string> = {};
    for (const [key, item] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof item === 'string') {
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
    if (!data || !notificationOpenHandler) return;
    try {
      notificationOpenHandler({
        notificationId: data.alarmKey || data.id,
        actionIdentifier: 'open',
        taskId: data.taskId,
        projectId: data.projectId,
        kind: data.kind,
      });
    } catch (error) {
      logNotificationError('Failed to handle notification open event', error);
    }
  });

  dismissSubscription?.remove();
  dismissSubscription = emitter.addListener('OnNotificationDismissed', () => {
    // No-op: kept for symmetry and possible future cleanup hooks.
  });
}

function buildAlarmConfigSignature(config: LocalAlarmConfig): string {
  return JSON.stringify({
    title: config.title,
    message: config.message,
    fireAt: config.fireAt.toISOString(),
    repeatInterval: config.repeatInterval ?? 'once',
    data: config.data ?? {},
  });
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
  return true;
}

async function scheduleAlarmForKey(api: AlarmNotificationsApi, key: string, config: LocalAlarmConfig): Promise<void> {
  const signature = buildAlarmConfigSignature(config);
  const existingSignature = configByKey.get(key);
  const existingAlarm = alarmMap.get(key);
  if (existingAlarm && existingSignature === signature) {
    return;
  }

  await cancelAlarmByKey(api, key);

  const baseFireAt = new Date(config.fireAt);
  baseFireAt.setMilliseconds(0);

  const detailsBase: Record<string, unknown> = {
    title: config.title,
    message: config.message,
    channel: LOCAL_ALARM_CHANNEL,
    auto_cancel: true,
    small_icon: LOCAL_SMALL_ICON,
    color: LOCAL_NOTIFICATION_COLOR,
    has_button: false,
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
    },
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
      break;
    } catch (error) {
      lastError = error;
      if (isDuplicateAlarmError(error) && retry < MAX_DUPLICATE_ALARM_RETRIES) {
        continue;
      }
      throw error;
    }
  }

  if (scheduledId === null) {
    logNotificationError(`Failed to schedule alarm for ${key} after duplicate retries`, lastError);
    return;
  }

  alarmMap.set(key, { id: scheduledId });
  configByKey.set(key, signature);
}

async function cancelInactiveKeys(api: AlarmNotificationsApi, activeKeys: Set<string>): Promise<void> {
  for (const key of Array.from(alarmMap.keys())) {
    if (activeKeys.has(key)) continue;
    await cancelAlarmByKey(api, key);
  }
}

async function runRescheduleCycle(api: AlarmNotificationsApi): Promise<void> {
  await loadAlarmMapIfNeeded();

  const { settings, tasks, projects } = useTaskStore.getState();
  const activeKeys = new Set<string>();

  if (settings.notificationsEnabled === false) {
    for (const key of Array.from(alarmMap.keys())) {
      await cancelAlarmByKey(api, key);
    }
    await saveAlarmMap();
    return;
  }

  const language: Language = await loadStoredLanguage(AsyncStorage, getSystemDefaultLanguage()).catch(() => getSystemDefaultLanguage());
  const tr = await getTranslations(language);

  if (settings.dailyDigestMorningEnabled === true) {
    const { hour, minute } = parseTimeOfDay(settings.dailyDigestMorningTime, { hour: 9, minute: 0 });
    const key = LOCAL_DIGEST_MORNING_KEY;
    activeKeys.add(key);
    await scheduleAlarmForKey(api, key, {
      title: tr['digest.morningTitle'],
      message: tr['digest.morningBody'],
      fireAt: nextDailyTime(hour, minute),
      repeatInterval: 'daily',
      data: { kind: 'daily-digest' },
    });
  }

  if (settings.dailyDigestEveningEnabled === true) {
    const { hour, minute } = parseTimeOfDay(settings.dailyDigestEveningTime, { hour: 20, minute: 0 });
    const key = LOCAL_DIGEST_EVENING_KEY;
    activeKeys.add(key);
    await scheduleAlarmForKey(api, key, {
      title: tr['digest.eveningTitle'],
      message: tr['digest.eveningBody'],
      fireAt: nextDailyTime(hour, minute),
      repeatInterval: 'daily',
      data: { kind: 'daily-digest' },
    });
  }

  if (settings.weeklyReviewEnabled === true) {
    const { hour, minute } = parseTimeOfDay(settings.weeklyReviewTime, { hour: 18, minute: 0 });
    const day = Number.isFinite(settings.weeklyReviewDay)
      ? Math.max(0, Math.min(6, Math.floor(settings.weeklyReviewDay as number)))
      : 0;
    const key = LOCAL_WEEKLY_REVIEW_KEY;
    activeKeys.add(key);
    await scheduleAlarmForKey(api, key, {
      title: tr['digest.weeklyReviewTitle'],
      message: tr['digest.weeklyReviewBody'],
      fireAt: nextWeeklyTime(day, hour, minute),
      repeatInterval: 'weekly',
      data: { kind: 'weekly-review' },
    });
  }

  const now = new Date();
  const includeReviewAt = settings.reviewAtNotificationsEnabled !== false;

  for (const task of tasks) {
    const next = getNextScheduledAt(task, now, { includeReviewAt });
    if (!next || next.getTime() <= now.getTime()) continue;
    const key = getTaskKey(task.id);
    activeKeys.add(key);
    await scheduleAlarmForKey(api, key, {
      title: task.title,
      message: task.description || '',
      fireAt: next,
      data: {
        kind: 'task-reminder',
        taskId: task.id,
      },
    });
  }

  if (includeReviewAt) {
    const reviewLabel = tr['review.projectsStep'] ?? 'Review project';
    for (const project of projects) {
      if (project.deletedAt) continue;
      if (project.status === 'archived') continue;
      const reviewAt = safeParseDate(project.reviewAt);
      if (!reviewAt) continue;
      if (!hasTimeComponent(project.reviewAt)) {
        reviewAt.setHours(9, 0, 0, 0);
      }
      if (reviewAt.getTime() <= now.getTime()) continue;
      const key = getProjectKey(project.id);
      activeKeys.add(key);
      await scheduleAlarmForKey(api, key, {
        title: project.title,
        message: reviewLabel,
        fireAt: reviewAt,
        data: {
          kind: 'project-review',
          projectId: project.id,
        },
      });
    }
  }

  await cancelInactiveKeys(api, activeKeys);
  await saveAlarmMap();
}

function enqueueReschedule(api: AlarmNotificationsApi): void {
  rescheduleQueue = rescheduleQueue
    .catch(() => undefined)
    .then(async () => {
      await runRescheduleCycle(api);
    })
    .catch((error) => logNotificationError('Failed to reschedule local notifications', error));
}

export function setLocalNotificationOpenHandler(handler: NotificationOpenHandler | null): void {
  notificationOpenHandler = handler;
}

export async function requestLocalNotificationPermission(): Promise<NotificationPermissionResult> {
  if (Platform.OS === 'android') {
    const currentStatus = await getAndroidNotificationPermissionStatus();
    if (currentStatus.granted) {
      return currentStatus;
    }

    try {
      const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      if (result === PermissionsAndroid.RESULTS.GRANTED) {
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
    await api.scheduleAlarm({
      title: trimmedTitle,
      message: String(message || '').trim(),
      channel: LOCAL_ALARM_CHANNEL,
      auto_cancel: true,
      small_icon: LOCAL_SMALL_ICON,
      color: LOCAL_NOTIFICATION_COLOR,
      fire_date: api.parseDate(new Date(Date.now() + 2000)),
      has_button: false,
      loop_sound: false,
      play_sound: true,
      schedule_type: 'once',
      use_big_text: true,
      vibrate: false,
      data: {
        kind: 'pomodoro',
        ...(data ?? {}),
      },
    });
  } catch (error) {
    logNotificationError('Failed to send local mobile notification', error);
  }
}

export async function startLocalMobileNotifications(): Promise<void> {
  if (started) return;
  started = true;

  const api = await loadAlarmApi();
  if (!api) {
    started = false;
    return;
  }

  const permission = await requestLocalNotificationPermission();
  if (!permission.granted) {
    await clearScheduledAlarms(api);
    started = false;
    return;
  }

  attachNativeEventListeners();
  await runRescheduleCycle(api);

  storeSubscription?.();
  storeSubscription = useTaskStore.subscribe(() => {
    clearRescheduleTimer();
    rescheduleTimer = setTimeout(() => {
      rescheduleTimer = null;
      enqueueReschedule(api);
    }, 500);
  });
}

export async function stopLocalMobileNotifications(): Promise<void> {
  clearRescheduleTimer();

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
