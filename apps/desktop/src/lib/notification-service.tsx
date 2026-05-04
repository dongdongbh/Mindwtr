import { getDailyDigestSummary, getNextScheduledAt, stripMarkdown, type Language, Task, parseTimeOfDay, getTranslationsSync, loadTranslations, loadStoredLanguageSync, safeParseDate, hasTimeComponent, getSystemDefaultLanguage } from '@mindwtr/core';
import { useTaskStore } from '@mindwtr/core';
import { isTauriRuntime } from './runtime';

const notifiedAtByTask = new Map<string, string>();
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

async function loadTauriNotificationApi(): Promise<TauriNotificationApi | null> {
    if (!isTauriRuntime()) return null;
    if (tauriNotificationApi) return tauriNotificationApi;
    try {
        // Optional dependency. If unavailable, we fall back to Web Notifications.
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
            // Ignore and fall through to web notifications.
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
            // ignore
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
    sendNotification(title, body);
}

function sendNotification(title: string, body?: string) {
    if (tauriNotificationApi?.sendNotification) {
        tauriNotificationApi.sendNotification({ title, body });
        return;
    }

    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
            new Notification(title, body ? { body } : undefined);
        } catch {
            // ignore
        }
    }
}

function checkDueAndNotify() {
    const now = new Date();
    const { tasks, projects, settings } = useTaskStore.getState();

    if (settings.notificationsEnabled === false) return;

    const includeStartTime = settings.startDateNotificationsEnabled !== false;
    const includeDueDate = settings.dueDateNotificationsEnabled !== false;
    const includeReviewAt = settings.reviewAtNotificationsEnabled !== false;
    tasks.forEach((task: Task) => {
        const next = getNextScheduledAt(task, now, { includeStartTime, includeDueDate, includeReviewAt });
        if (!next) return;
        const diffMs = next.getTime() - now.getTime();
        if (diffMs > CHECK_INTERVAL_MS) return;

        const key = next.toISOString();
        if (notifiedAtByTask.get(task.id) === key) return;

        sendNotification(task.title, stripMarkdown(task.description || '') || undefined);
        notifiedAtByTask.set(task.id, key);
    });

    const dateKey = localDateKey(now);
    const lang = getCurrentLanguage();
    void loadTranslations(lang);
    const tr = getTranslationsSync(lang);

    if (includeReviewAt) {
        projects.forEach((project) => {
            if (project.deletedAt) return;
            if (project.status === 'archived') return;
            const review = safeParseDate(project.reviewAt);
            if (!review) return;
            if (!hasTimeComponent(project.reviewAt)) {
                review.setHours(9, 0, 0, 0);
            }
            const diffMs = review.getTime() - now.getTime();
            if (diffMs < 0 || diffMs > CHECK_INTERVAL_MS) return;
            const key = review.toISOString();
            if (notifiedAtByProject.get(project.id) === key) return;
            sendNotification(project.title, tr['review.projectsStep'] ?? 'Review project');
            notifiedAtByProject.set(project.id, key);
        });
    }

    const morningEnabled = settings.dailyDigestMorningEnabled === true;
    const eveningEnabled = settings.dailyDigestEveningEnabled === true;
    const weeklyReviewEnabled = settings.weeklyReviewEnabled === true;

    const { hour: morningHour, minute: morningMinute } = parseTimeOfDay(settings.dailyDigestMorningTime, { hour: 9, minute: 0 });
    const { hour: eveningHour, minute: eveningMinute } = parseTimeOfDay(settings.dailyDigestEveningTime, { hour: 20, minute: 0 });
    const { hour: weeklyHour, minute: weeklyMinute } = parseTimeOfDay(settings.weeklyReviewTime, { hour: 18, minute: 0 });
    const weeklyReviewDay = Number.isFinite(settings.weeklyReviewDay)
        ? Math.max(0, Math.min(6, Math.floor(settings.weeklyReviewDay as number)))
        : 0;

    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    if (morningEnabled) {
        const target = morningHour * 60 + morningMinute;
        if (nowMinutes >= target && digestSentOnByKind.get('morning') !== dateKey) {
            const summary = getDailyDigestSummary(tasks, projects, now);
            const reviewDue = summary.reviewDueTasks + summary.reviewDueProjects;
            const hasAny =
                summary.dueToday > 0 || summary.overdue > 0 || summary.focusToday > 0 || reviewDue > 0;

            const body = hasAny
                ? [
                    `${tr['digest.dueToday']}: ${summary.dueToday}`,
                    `${tr['digest.overdue']}: ${summary.overdue}`,
                    `${tr['digest.focus']}: ${summary.focusToday}`,
                    `${tr['digest.reviewDue']}: ${reviewDue}`,
                ].join(' • ')
                : tr['digest.noItems'];

            sendNotification(tr['digest.morningTitle'], body);
            digestSentOnByKind.set('morning', dateKey);
        }
    }

    if (eveningEnabled) {
        const target = eveningHour * 60 + eveningMinute;
        if (nowMinutes >= target && digestSentOnByKind.get('evening') !== dateKey) {
            sendNotification(tr['digest.eveningTitle'], tr['digest.eveningBody']);
            digestSentOnByKind.set('evening', dateKey);
        }
    }

    if (weeklyReviewEnabled) {
        const target = weeklyHour * 60 + weeklyMinute;
        if (now.getDay() === weeklyReviewDay && nowMinutes >= target && weeklyReviewSentOnDate !== dateKey) {
            sendNotification(tr['digest.weeklyReviewTitle'], tr['digest.weeklyReviewBody']);
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

        // Re-check on data changes.
        storeSubscription?.();
        storeSubscription = useTaskStore.subscribe((state, prevState) => {
            if (state.lastDataChangeAt === prevState.lastDataChangeAt) return;
            if (checkDebounceTimer) {
                clearTimeout(checkDebounceTimer);
            }
            checkDebounceTimer = setTimeout(() => {
                const now = Date.now();
                if (now - lastCheckAt < 2_000) return;
                lastCheckAt = now;
                checkDueAndNotify();
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
    notifiedAtByProject.clear();
    digestSentOnByKind.clear();
    weeklyReviewSentOnDate = null;
    started = false;
}
