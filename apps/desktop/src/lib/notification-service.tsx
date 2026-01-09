import { getDailyDigestSummary, getNextScheduledAt, stripMarkdown, type Language, Task, parseTimeOfDay, getTranslationsSync, loadTranslations, loadStoredLanguageSync } from '@mindwtr/core';
import { useTaskStore } from '@mindwtr/core';

const notifiedAtByTask = new Map<string, string>();
const digestSentOnByKind = new Map<'morning' | 'evening', string>();
let intervalId: number | null = null;
let storeSubscription: (() => void) | null = null;

type TauriNotificationApi = {
    sendNotification: (payload: { title: string; body?: string }) => void;
    isPermissionGranted?: () => Promise<boolean>;
    requestPermission?: () => Promise<unknown>;
};

let tauriNotificationApi: TauriNotificationApi | null = null;

const CHECK_INTERVAL_MS = 15_000;

function getCurrentLanguage(): Language {
    if (typeof localStorage === 'undefined') return 'en';
    return loadStoredLanguageSync(localStorage);
}

function localDateKey(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

async function loadTauriNotificationApi(): Promise<TauriNotificationApi | null> {
    if (!(window as any).__TAURI__) return null;
    if (tauriNotificationApi) return tauriNotificationApi;
    try {
        // Optional dependency. If not installed, we fall back to Web Notifications.
        const moduleName = '@tauri-apps/plugin-notification';
        const mod = await import(/* @vite-ignore */ moduleName);
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
        try {
            await Notification.requestPermission();
        } catch {
            // ignore
        }
    }
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

    tasks.forEach((task: Task) => {
        const next = getNextScheduledAt(task, now);
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

    const morningEnabled = settings.dailyDigestMorningEnabled === true;
    const eveningEnabled = settings.dailyDigestEveningEnabled === true;

    const { hour: morningHour, minute: morningMinute } = parseTimeOfDay(settings.dailyDigestMorningTime, { hour: 9, minute: 0 });
    const { hour: eveningHour, minute: eveningMinute } = parseTimeOfDay(settings.dailyDigestEveningTime, { hour: 20, minute: 0 });

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
}

export async function startDesktopNotifications() {
    await loadTranslations(getCurrentLanguage());
    await ensurePermission();
    await loadTauriNotificationApi();

    if (intervalId) clearInterval(intervalId);
    intervalId = window.setInterval(checkDueAndNotify, CHECK_INTERVAL_MS);
    checkDueAndNotify();

    // Re-check on data changes.
    storeSubscription?.();
    storeSubscription = useTaskStore.subscribe(() => checkDueAndNotify());
}

export function stopDesktopNotifications() {
    if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
    }

    storeSubscription?.();
    storeSubscription = null;

    notifiedAtByTask.clear();
    digestSentOnByKind.clear();
}
