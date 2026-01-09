import { getNextScheduledAt, type Language, Task, useTaskStore, parseTimeOfDay, getTranslations, loadStoredLanguage } from '@mindwtr/core';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';

type NotificationsApi = typeof import('expo-notifications');
type NotificationContentInput = {
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
  categoryIdentifier?: string;
};
type NotificationResponse = {
  notification?: {
    request?: {
      content?: {
        data?: Record<string, unknown>;
      };
    };
  };
  actionIdentifier?: string;
};
type Subscription = { remove: () => void };

type ScheduledEntry = { scheduledAtIso: string; notificationId: string };

const scheduledByTask = new Map<string, ScheduledEntry>();
const scheduledDigestByKind = new Map<'morning' | 'evening', string>();
let digestConfigKey: string | null = null;
let weeklyReviewConfigKey: string | null = null;
let scheduledWeeklyReviewId: string | null = null;
let started = false;
let responseSubscription: Subscription | null = null;
let storeSubscription: (() => void) | null = null;

let Notifications: NotificationsApi | null = null;

const logNotificationError = (message: string, error: unknown) => {
  console.warn(`[Notifications] ${message}`, error);
};

async function loadNotifications(): Promise<NotificationsApi | null> {
  if (Notifications) return Notifications;

  // Skip notifications in Expo Go (not supported in newer SDKs)
  if (!Constants.appOwnership || Constants.appOwnership === 'expo') {
    return null;
  }

  try {
    const mod = await import('expo-notifications');
    Notifications = mod;
    mod.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
    });
    return mod;
  } catch (error) {
    console.warn('[Notifications] expo-notifications unavailable:', error);
    return null;
  }
}

async function getCurrentLanguage(): Promise<Language> {
  try {
    return await loadStoredLanguage(AsyncStorage);
  } catch {
    return 'en';
  }
}

async function ensurePermission(api: NotificationsApi) {
  const { status } = await api.getPermissionsAsync();
  if (status === 'granted') return true;
  const request = await api.requestPermissionsAsync();
  return request.status === 'granted';
}

async function cancelDailyDigests(api: NotificationsApi) {
  for (const id of scheduledDigestByKind.values()) {
    await api.cancelScheduledNotificationAsync(id).catch((error) => logNotificationError('Failed to cancel daily digest', error));
  }
  scheduledDigestByKind.clear();
}

async function cancelWeeklyReview(api: NotificationsApi) {
  if (!scheduledWeeklyReviewId) return;
  await api.cancelScheduledNotificationAsync(scheduledWeeklyReviewId).catch((error) => logNotificationError('Failed to cancel weekly review', error));
  scheduledWeeklyReviewId = null;
}

async function rescheduleDailyDigest(api: NotificationsApi) {
  const { settings } = useTaskStore.getState();

  const notificationsEnabled = settings.notificationsEnabled !== false;
  const morningEnabled = settings.dailyDigestMorningEnabled === true;
  const eveningEnabled = settings.dailyDigestEveningEnabled === true;
  const morningTime = settings.dailyDigestMorningTime || '09:00';
  const eveningTime = settings.dailyDigestEveningTime || '20:00';

  const nextKey = JSON.stringify({
    notificationsEnabled,
    morningEnabled,
    eveningEnabled,
    morningTime,
    eveningTime,
  });
  if (nextKey === digestConfigKey) return;
  digestConfigKey = nextKey;

  await cancelDailyDigests(api);
  if (!notificationsEnabled) return;
  if (!morningEnabled && !eveningEnabled) return;

  const language = await getCurrentLanguage();
  const tr = await getTranslations(language);

  if (morningEnabled) {
    const { hour, minute } = parseTimeOfDay(settings.dailyDigestMorningTime, { hour: 9, minute: 0 });
    const id = await api.scheduleNotificationAsync({
      content: {
        title: tr['digest.morningTitle'],
        body: tr['digest.morningBody'],
        data: { kind: 'daily-digest', when: 'morning' },
      } as any,
      trigger: { hour, minute, repeats: true } as any,
    });
    scheduledDigestByKind.set('morning', id);
  }

  if (eveningEnabled) {
    const { hour, minute } = parseTimeOfDay(settings.dailyDigestEveningTime, { hour: 20, minute: 0 });
    const id = await api.scheduleNotificationAsync({
      content: {
        title: tr['digest.eveningTitle'],
        body: tr['digest.eveningBody'],
        data: { kind: 'daily-digest', when: 'evening' },
      } as any,
      trigger: { hour, minute, repeats: true } as any,
    });
    scheduledDigestByKind.set('evening', id);
  }
}

async function rescheduleWeeklyReview(api: NotificationsApi) {
  const { settings } = useTaskStore.getState();

  const notificationsEnabled = settings.notificationsEnabled !== false;
  const weeklyReviewEnabled = settings.weeklyReviewEnabled === true;
  const weeklyReviewTime = settings.weeklyReviewTime || '18:00';
  const weeklyReviewDay = Number.isFinite(settings.weeklyReviewDay)
    ? Math.max(0, Math.min(6, Math.floor(settings.weeklyReviewDay as number)))
    : 0;

  const nextKey = JSON.stringify({
    notificationsEnabled,
    weeklyReviewEnabled,
    weeklyReviewDay,
    weeklyReviewTime,
  });
  if (nextKey === weeklyReviewConfigKey) return;
  weeklyReviewConfigKey = nextKey;

  await cancelWeeklyReview(api);
  if (!notificationsEnabled || !weeklyReviewEnabled) return;

  const language = await getCurrentLanguage();
  const tr = await getTranslations(language);
  const { hour, minute } = parseTimeOfDay(weeklyReviewTime, { hour: 18, minute: 0 });
  const weekday = weeklyReviewDay + 1; // Expo: 1 = Sunday

  scheduledWeeklyReviewId = await api.scheduleNotificationAsync({
    content: {
      title: tr['digest.weeklyReviewTitle'],
      body: tr['digest.weeklyReviewBody'],
      data: { kind: 'weekly-review', weekday },
    } as any,
    trigger: { weekday, hour, minute, repeats: true } as any,
  });
}

async function scheduleForTask(api: NotificationsApi, task: Task, when: Date) {
  const content: NotificationContentInput = {
    title: task.title,
    body: task.description || '',
    data: { taskId: task.id },
    categoryIdentifier: 'task-reminder',
  };

  const secondsUntil = Math.max(1, Math.floor((when.getTime() - Date.now()) / 1000));
  const id = await api.scheduleNotificationAsync({
    content,
    trigger: { seconds: secondsUntil, repeats: false } as any,
  });

  scheduledByTask.set(task.id, { scheduledAtIso: when.toISOString(), notificationId: id });
}

async function cancelTaskNotification(api: NotificationsApi, taskId: string, entry: ScheduledEntry) {
  await api.cancelScheduledNotificationAsync(entry.notificationId).catch((error) => logNotificationError(`Failed to cancel task reminder (${taskId})`, error));
  scheduledByTask.delete(taskId);
}

async function rescheduleAll(api: NotificationsApi) {
  const now = new Date();
  const { tasks, settings } = useTaskStore.getState();
  if (settings.notificationsEnabled === false) {
    for (const [taskId, entry] of scheduledByTask.entries()) {
      await cancelTaskNotification(api, taskId, entry);
    }
    return;
  }

  const activeTaskIds = new Set<string>();

  for (const task of tasks) {
    const next = getNextScheduledAt(task, now);
    if (!next || next.getTime() <= now.getTime()) {
      const existing = scheduledByTask.get(task.id);
      if (existing) {
        await cancelTaskNotification(api, task.id, existing);
      }
      continue;
    }

    const existing = scheduledByTask.get(task.id);
    const nextIso = next.toISOString();

    if (existing && existing.scheduledAtIso === nextIso) {
      activeTaskIds.add(task.id);
      continue;
    }

    if (existing) {
      await cancelTaskNotification(api, task.id, existing);
    }

    await scheduleForTask(api, task, next);
    activeTaskIds.add(task.id);
  }

  for (const [taskId, entry] of scheduledByTask.entries()) {
    if (!activeTaskIds.has(taskId)) {
      await cancelTaskNotification(api, taskId, entry);
    }
  }
}

async function snoozeTask(api: NotificationsApi, taskId: string, minutes: number) {
  const { tasks } = useTaskStore.getState();
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    logNotificationError(`Snooze skipped: task not found (${taskId})`, '');
    return;
  }
  const snoozeAt = new Date(Date.now() + minutes * 60 * 1000);
  await scheduleForTask(api, task, snoozeAt);
}

export async function startMobileNotifications() {
  if (started) return;
  started = true;

  const api = await loadNotifications();
  if (!api || typeof api.scheduleNotificationAsync !== 'function') {
    storeSubscription?.();
    storeSubscription = null;
    responseSubscription?.remove();
    responseSubscription = null;
    scheduledByTask.clear();
    scheduledDigestByKind.clear();
    scheduledWeeklyReviewId = null;
    digestConfigKey = null;
    weeklyReviewConfigKey = null;
    started = false;
    return;
  }

  const granted = await ensurePermission(api);
  if (!granted) {
    storeSubscription?.();
    storeSubscription = null;
    responseSubscription?.remove();
    responseSubscription = null;
    scheduledByTask.clear();
    scheduledDigestByKind.clear();
    scheduledWeeklyReviewId = null;
    digestConfigKey = null;
    weeklyReviewConfigKey = null;
    started = false;
    return;
  }

  await api.setNotificationCategoryAsync('task-reminder', [
    {
      identifier: 'snooze10',
      buttonTitle: 'Snooze 10m',
      options: { opensAppToForeground: false },
    },
    {
      identifier: 'open',
      buttonTitle: 'Open',
      options: { opensAppToForeground: true },
    },
  ]).catch((error) => logNotificationError('Failed to register notification category', error));

  await rescheduleAll(api);
  await rescheduleDailyDigest(api);
  await rescheduleWeeklyReview(api);

  storeSubscription?.();
  storeSubscription = useTaskStore.subscribe(() => {
    rescheduleAll(api).catch(console.error);
    rescheduleDailyDigest(api).catch(console.error);
    rescheduleWeeklyReview(api).catch(console.error);
  });

  responseSubscription?.remove();
  responseSubscription = api.addNotificationResponseReceivedListener((response: NotificationResponse) => {
    const taskId = (response.notification?.request?.content?.data as any)?.taskId as string | undefined;
    if (response.actionIdentifier === 'snooze10' && taskId) {
      snoozeTask(api, taskId, 10).catch(console.error);
    }
  });
}

export async function stopMobileNotifications() {
  responseSubscription?.remove();
  responseSubscription = null;
  storeSubscription?.();
  storeSubscription = null;

  if (Notifications) {
    for (const entry of scheduledByTask.values()) {
      await Notifications.cancelScheduledNotificationAsync(entry.notificationId).catch((error) => logNotificationError('Failed to cancel task reminder', error));
    }
    for (const id of scheduledDigestByKind.values()) {
      await Notifications.cancelScheduledNotificationAsync(id).catch((error) => logNotificationError('Failed to cancel daily digest', error));
    }
    if (scheduledWeeklyReviewId) {
      await Notifications.cancelScheduledNotificationAsync(scheduledWeeklyReviewId).catch((error) => logNotificationError('Failed to cancel weekly review', error));
    }
  }

  scheduledByTask.clear();
  scheduledDigestByKind.clear();
  scheduledWeeklyReviewId = null;
  digestConfigKey = null;
  weeklyReviewConfigKey = null;
  started = false;
}
