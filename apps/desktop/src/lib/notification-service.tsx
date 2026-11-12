import {
    areDueDateRemindersEnabled,
    areTaskRemindersEnabled,
    buildReminderNotificationBody,
    type DigestSchedule,
    getDailyDigestSummary,
    getDigestSchedule,
    getReminderNotificationTag,
    getTaskReminderNotificationTag,
    getTaskReminderPlan,
    resolveDueReminders,
    type Language,
    type NotificationSettings,
    type Task,
    getTranslationsSync,
    getTranslator,
    resolveI18nText,
    loadTranslations,
    loadStoredLanguageSync,
    getSystemDefaultLanguage,
} from '@mindwtr/core';
import { useTaskStore } from '@mindwtr/core';
import { isFlatpakRuntime, isLinuxRuntime, isMacRuntime, isTauriRuntime, isWindowsRuntime } from './runtime';
import { invokeNative } from './tauri-invoke';
import { logInfo, logWarn } from './app-log';
import { isAppLocked } from './app-lock';

const notifiedAtByTask = new Map<string, string>();
const advanceObservedByTask = new Set<string>();
const repeatNotifiedByTask = new Map<string, string>();
const notifiedAtByProject = new Map<string, string>();
const digestSentOnByKind = new Map<'morning' | 'evening', string>();
let weeklyReviewSentOnDate: string | null = null;
let intervalId: number | null = null;
let storeSubscription: (() => void) | null = null;
let started = false;
let startPromise: Promise<void> | null = null;
let checkDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastCheckAt = 0;

type TauriNotificationApi = {
    sendNotification: (payload: { title: string; body?: string }) => void;
    isPermissionGranted?: () => Promise<boolean>;
    requestPermission?: () => Promise<unknown>;
};

let tauriNotificationApi: TauriNotificationApi | null = null;

const CHECK_INTERVAL_MS = 15_000;
const REPEAT_CATCH_UP_MS = CHECK_INTERVAL_MS;
const LINUX_NOTIFICATION_ERROR_TYPES = [
    'invalid_title',
    'session_bus_unavailable',
    'service_unavailable',
    'daemon_rejected',
    'protocol_error',
    'delivery_timeout',
    'portal_unavailable',
    'portal_rejected',
    'unsupported_install',
    'unsupported_platform',
] as const;


const MAX_CATCH_UP_MS = 5 * 60_000;
let lastPollAt: number | null = null;


export function resolvePollCatchUpMs(nowMs: number, lastPollAtMs: number | null): number {
    if (lastPollAtMs === null) return CHECK_INTERVAL_MS;
    return Math.min(Math.max(nowMs - lastPollAtMs, CHECK_INTERVAL_MS), MAX_CATCH_UP_MS);
}


export function resolveDueRepeatToFire(
    task: Task,
    now: Date,
    alreadyNotifiedKey: string | undefined,
    options: { includeDueDate: boolean; catchUpMs?: number; taskReminderDefault?: NotificationSettings['taskReminderDefault'] },
): { key: string; index: number; scheduledAt: Date } | null {
    const catchUpMs = options.catchUpMs ?? REPEAT_CATCH_UP_MS;
    const repeats = getTaskReminderPlan(task, now, {
        includeDueDate: options.includeDueDate,
        taskReminderDefault: options.taskReminderDefault,
    }).repeats;
    if (repeats.length === 0) return null;
    const nowMs = now.getTime();
    let chosen = null as (typeof repeats)[number] | null;
    for (const repeat of repeats) {
        const t = repeat.scheduledAt.getTime();
        if (t <= nowMs && nowMs - t <= catchUpMs) {
            chosen = repeat;
        }
    }
    if (!chosen || chosen.repeatIndex === undefined) return null;
    if (alreadyNotifiedKey === chosen.dedupeKey) return null;
    return { key: chosen.dedupeKey, index: chosen.repeatIndex, scheduledAt: chosen.scheduledAt };
}

function getCurrentLanguage(): Language {
    if (typeof localStorage === 'undefined') return 'en';
    return loadStoredLanguageSync(localStorage, getSystemDefaultLanguage());
}

function localDateKey(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}


export const buildDesktopTaskNotificationBody = buildReminderNotificationBody;

async function loadTauriNotificationApi(): Promise<TauriNotificationApi | null> {
    if (!isTauriRuntime()) return null;
    if (tauriNotificationApi) return tauriNotificationApi;
    try {

        const mod = await import('@tauri-apps/plugin-notification');
        tauriNotificationApi = mod as unknown as TauriNotificationApi;
        return tauriNotificationApi;
    } catch {
        return null;
    }
}

async function ensurePermission() {
    const tauriApi = await loadTauriNotificationApi();
    if (tauriApi?.isPermissionGranted && tauriApi?.requestPermission) {
        try {
            const granted = await tauriApi.isPermissionGranted();
            if (!granted) {
                await tauriApi.requestPermission();
            }
            return;
        } catch {

        }
    }

    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        const canPrompt =
            typeof navigator !== 'undefined'
            && 'userActivation' in navigator
            && (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation?.isActive;
        if (!canPrompt) return;
        try {
            await Notification.requestPermission();
        } catch {

        }
    }
}

export async function requestDesktopNotificationPermission() {
    await ensurePermission();
    await loadTauriNotificationApi();
}

export async function sendDesktopImmediateNotification(title: string, body?: string) {
    const { settings } = useTaskStore.getState();
    if (settings.notificationsEnabled === false) return;
    await ensurePermission();
    await loadTauriNotificationApi();
    await sendNotification(title, body);
}


function logNotificationSent(path: string): void {
    void logInfo('Desktop notification sent', {
        scope: 'notification',
        extra: { path },
    });
}

function logNotificationFailed(path: string, error: unknown): void {
    void logWarn('Desktop notification send failed', {
        scope: 'notification',
        extra: {
            path,
            error: error instanceof Error ? error.message : String(error),
        },
    });
}

function classifyLinuxNotificationError(error: unknown): string {
    const detail = error instanceof Error
        ? error.message
        : typeof error === 'string'
            ? error
            : error && typeof error === 'object' && 'kind' in error
                ? String((error as { kind?: unknown }).kind ?? '')
                : '';
    return LINUX_NOTIFICATION_ERROR_TYPES.find((candidate) => detail.includes(candidate)) ?? 'unknown';
}


async function handleLinuxNotification(title: string, body?: string, tag?: string): Promise<boolean | null> {
    if (!isTauriRuntime() || (!isLinuxRuntime() && !isFlatpakRuntime())) return null;

    const flatpak = isFlatpakRuntime();
    const backend = flatpak ? 'linux-portal' : 'linux-dbus';
    const command = flatpak ? 'send_flatpak_notification' : 'send_linux_notification';

    try {
        await invokeNative(command, {
            title,
            body: body?.trim() ? body : undefined,
            tag,
        });
        void logInfo('Linux desktop notification submitted', {
            scope: 'notification',
            extra: {
                backend,
                outcome: 'submitted',
            },
        });
        return true;
    } catch (error) {
        void logWarn('Linux desktop notification delivery failed', {
            scope: 'notification',
            extra: {
                backend,
                outcome: 'failed',
                errorType: classifyLinuxNotificationError(error),
            },
        });
    }


    return false;
}


async function sendWindowsPackagedNotification(title: string, body?: string, tag?: string): Promise<boolean> {
    if (!isTauriRuntime() || !isWindowsRuntime()) return false;

    try {
        await invokeNative('send_windows_packaged_notification', {
            title,
            body: body?.trim() ? body : undefined,
            tag,
        });
        return true;
    } catch (error) {
        logNotificationFailed('windows-packaged', error);
        return false;
    }
}


async function sendReplacingNotification(title: string, body: string | undefined, tag: string): Promise<boolean> {
    if (!isTauriRuntime() || (!isMacRuntime() && !isWindowsRuntime())) return false;

    try {
        await invokeNative('send_replacing_notification', {
            title,
            body: body?.trim() ? body : undefined,
            tag,
        });
        return true;
    } catch (error) {
        logNotificationFailed('replacing', error);
        return false;
    }
}


async function sendNotification(title: string, body?: string, tag?: string): Promise<boolean> {


    if (isAppLocked()) {
        title = resolveI18nText(getTranslator(getCurrentLanguage()), 'appLock.lockedReminder', { fallback: 'Mindwtr reminder' });
        body = undefined;
    }
    const linuxSent = await handleLinuxNotification(title, body, tag);
    if (linuxSent !== null) return linuxSent;

    if (await sendWindowsPackagedNotification(title, body, tag)) {
        logNotificationSent('windows-packaged');
        return true;
    }

    if (tag && await sendReplacingNotification(title, body, tag)) {
        logNotificationSent('replacing');
        return true;
    }

    if (tauriNotificationApi?.sendNotification) {
        try {
            tauriNotificationApi.sendNotification({ title, body });
            logNotificationSent('plugin');
            return true;
        } catch (error) {
            logNotificationFailed('plugin', error);

        }
    }

    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {

            const options = { ...(body ? { body } : {}), ...(tag ? { tag, renotify: true } : {}) } as NotificationOptions;
            new Notification(title, Object.keys(options).length > 0 ? options : undefined);
            logNotificationSent('web');
            return true;
        } catch (error) {
            logNotificationFailed('web', error);
        }
    }
    return false;
}


function logReminderFired(kind: 'due-repeat' | 'task' | 'project', fireAt: string): void {
    void logInfo('Desktop reminder fired', {
        scope: 'notification',
        extra: {
            kind,
            entity: kind === 'project' ? 'project' : 'task',
            fireAt,
            appState:
                typeof document !== 'undefined' && document.visibilityState === 'visible'
                    ? 'focused'
                    : 'hidden',
        },
    });
}

export type DesktopReminderGates = {
    taskRemindersEnabled: boolean;
    weeklyReviewEnabled: boolean;
    morningDigestEnabled: boolean;
    eveningDigestEnabled: boolean;
};


export function resolveDesktopReminderGates(
    settings: NotificationSettings,
    digest: DigestSchedule = getDigestSchedule(settings),
): DesktopReminderGates {
    const taskRemindersEnabled = areTaskRemindersEnabled(settings);
    return {
        taskRemindersEnabled,
        weeklyReviewEnabled: digest.weekly.enabled,
        morningDigestEnabled: digest.morning.enabled,
        eveningDigestEnabled: digest.evening.enabled,
    };
}

function checkDueAndNotify() {
    const now = new Date();
    const { tasks, projects, settings } = useTaskStore.getState();

    const dateKey = localDateKey(now);
    const lang = getCurrentLanguage();
    void loadTranslations(lang);
    const tr = getTranslationsSync(lang);


    const translator = getTranslator(lang);
    const text = (key: string, fallback: string) => resolveI18nText(translator, key, { fallback });


    const catchUpMs = resolvePollCatchUpMs(now.getTime(), lastPollAt);
    lastPollAt = now.getTime();
    const lookbackFrom = new Date(now.getTime() - catchUpMs);
    const lookaheadTo = new Date(now.getTime() + CHECK_INTERVAL_MS);

    const digest = getDigestSchedule(settings);
    const gates = resolveDesktopReminderGates(settings, digest);
    const includeDueDate = areDueDateRemindersEnabled(settings);


    tasks.forEach((task: Task) => {
        const repeat = resolveDueRepeatToFire(task, now, repeatNotifiedByTask.get(task.id), { includeDueDate, catchUpMs, taskReminderDefault: settings.taskReminderDefault });
        if (!repeat) return;
        logReminderFired('due-repeat', repeat.scheduledAt.toISOString());
        void sendNotification(task.title, buildDesktopTaskNotificationBody(task, 'due-repeat', tr), getTaskReminderNotificationTag(task.id));
        repeatNotifiedByTask.set(task.id, repeat.key);
    });


    const dueReminders = resolveDueReminders(
        { settings, tasks, projects, translations: tr },
        { from: lookbackFrom, to: lookaheadTo },
    );
    for (const request of dueReminders) {
        const fireIso = request.fireAt.toISOString();
        const taskId = request.data.taskId;
        const projectId = request.data.projectId;
        if (taskId) {
            if (request.data.kind === 'task-due-advance' || request.data.kind === 'task-start-advance') {

                if (request.fireAt.getTime() > now.getTime() || !advanceObservedByTask.has(request.key)) continue;
                void sendNotification(request.title, request.message, getReminderNotificationTag(request.key)).then((sent) => {
                    if (sent && request.data.reminderSelection) void logInfo('Selective task reminder delivered', { scope: 'notifications', force: true,
                        extra: { releaseCheck: 'v1.3.9/selective-task-reminder', outcome: 'delivered' } });
                    if (sent) void logInfo('Advance reminder delivered', { scope: 'notifications', force: true,
                        extra: { releaseCheck: request.data.kind === 'task-start-advance' ? 'v1.3.8/start-advance-reminder' : 'v1.3.8/due-advance-reminder', outcome: 'delivered' } });
                });
                continue;
            }
            if (notifiedAtByTask.get(taskId) === fireIso) continue;
            logReminderFired('task', fireIso);
            void sendNotification(request.title, request.message, getReminderNotificationTag(request.key)).then(sent => {
                if (sent && request.data.reminderSelection) void logInfo('Selective task reminder delivered', { scope: 'notifications', force: true,
                    extra: { releaseCheck: 'v1.3.9/selective-task-reminder', outcome: 'delivered' } });
            });
            notifiedAtByTask.set(taskId, fireIso);
        } else if (projectId) {
            if (notifiedAtByProject.get(projectId) === fireIso) continue;
            logReminderFired('project', fireIso);
            void sendNotification(request.title, request.message, getReminderNotificationTag(request.key));
            notifiedAtByProject.set(projectId, fireIso);
        } else {
            console.warn('resolveDueReminders returned a request with neither taskId nor projectId', request);
        }
    }

    advanceObservedByTask.clear();
    for (const task of gates.taskRemindersEnabled ? tasks : []) {
        const plan = getTaskReminderPlan(task, now, { includeStartTime: settings.startDateNotificationsEnabled !== false, includeDueDate, taskReminderDefault: settings.taskReminderDefault });
        for (const advance of [plan.advance, plan.startAdvance]) {
            if (advance) advanceObservedByTask.add(advance.key);
        }
    }

    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    if (gates.morningDigestEnabled) {
        const target = digest.morning.hour * 60 + digest.morning.minute;
        if (nowMinutes >= target && digestSentOnByKind.get('morning') !== dateKey) {
            const summary = getDailyDigestSummary(tasks, projects, now);
            const reviewDue = summary.reviewDueTasks + summary.reviewDueProjects;
            const hasAny =
                summary.dueToday > 0 || summary.overdue > 0 || summary.focusToday > 0 || reviewDue > 0;

            const body = hasAny
                ? [
                    `${text('digest.dueToday', 'Due today')}: ${summary.dueToday}`,
                    `${text('digest.overdue', 'Overdue')}: ${summary.overdue}`,
                    `${text('digest.focus', 'Focus')}: ${summary.focusToday}`,
                    `${text('digest.reviewDue', 'Review due')}: ${reviewDue}`,
                ].join(' • ')
                : text('digest.noItems', 'No urgent items today.');

            void sendNotification(text('digest.morningTitle', 'Morning briefing'), body);
            digestSentOnByKind.set('morning', dateKey);
        }
    }

    if (gates.eveningDigestEnabled) {
        const target = digest.evening.hour * 60 + digest.evening.minute;
        if (nowMinutes >= target && digestSentOnByKind.get('evening') !== dateKey) {
            void sendNotification(text('digest.eveningTitle', 'Evening review'), text('digest.eveningBody', 'Open Mindwtr to review and wrap up.'));
            digestSentOnByKind.set('evening', dateKey);
        }
    }

    if (gates.weeklyReviewEnabled) {
        const target = digest.weekly.hour * 60 + digest.weekly.minute;
        if (now.getDay() === digest.weekly.day && nowMinutes >= target && weeklyReviewSentOnDate !== dateKey) {
            void sendNotification(text('digest.weeklyReviewTitle', 'Weekly review'), text('digest.weeklyReviewBody', 'Open Mindwtr to review and reset your week.'));
            weeklyReviewSentOnDate = dateKey;
        }
    }
}

export async function startDesktopNotifications() {
    if (startPromise) {
        await startPromise;
        return;
    }
    if (started) return;
    startPromise = (async () => {
        started = true;
        try {
            await loadTranslations(getCurrentLanguage());
            await ensurePermission();
            await loadTauriNotificationApi();
        } catch (error) {
            started = false;
            throw error;
        }

        if (intervalId) clearInterval(intervalId);
        intervalId = window.setInterval(checkDueAndNotify, CHECK_INTERVAL_MS);
        checkDueAndNotify();


        storeSubscription?.();
        storeSubscription = useTaskStore.subscribe((state, prevState) => {
            if (state.lastDataChangeAt === prevState.lastDataChangeAt
                && state.settings.taskReminderDefault === prevState.settings.taskReminderDefault) return;
            if (checkDebounceTimer) {
                clearTimeout(checkDebounceTimer);
            }
            checkDebounceTimer = setTimeout(() => {
                const now = Date.now();
                if (now - lastCheckAt < 2_000) return;
                lastCheckAt = now;
                checkDueAndNotify();
                void logInfo('Task reminder policy reevaluated', { scope: 'notifications',
                    extra: { releaseCheck: 'v1.3.7/task-reminder-policy', outcome: 'planned' } });
            }, 750);
        });
    })();
    try {
        await startPromise;
    } finally {
        startPromise = null;
    }
}

export function stopDesktopNotifications() {
    if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
    }

    if (checkDebounceTimer) {
        clearTimeout(checkDebounceTimer);
        checkDebounceTimer = null;
    }

    storeSubscription?.();
    storeSubscription = null;

    notifiedAtByTask.clear();
    repeatNotifiedByTask.clear();
    advanceObservedByTask.clear();
    notifiedAtByProject.clear();
    lastPollAt = null;
    digestSentOnByKind.clear();
    weeklyReviewSentOnDate = null;
    started = false;
}
