/**
 * The mobile apps' reminder alarms: which alarms a device should hold for the store, how
 * they differ from the alarms it holds, and how an alarm library is asked to change them.
 * Moved from React Native's lib/notification-service-local.ts so the native app arms and
 * cancels alarms by the same rules. What to remind and when is `buildReminderSchedule`.
 *
 * - The alarm map (JSON under REMINDER_ALARM_MAP_STORAGE_KEY) holds one entry per alarm
 *   key: the alarm's id and the signature of what it shows and when. An alarm whose
 *   signature is unchanged is left alone, a changed one is cancelled and made again, and a
 *   key no longer requested is cancelled. An entry marked `pending` was about to be made
 *   when the app stopped: it is never taken as current.
 * - An alarm that goes is `withdrawn` or `expired`. Withdrawn (the task or project is done,
 *   gone or moved, or its reminders are off): what it delivered is removed too. Expired (its
 *   time only passed, or the same reminder is remade): what it delivered stays, so a cycle
 *   5 s after a reminder fires never clears it from the tray.
 * - One-shot task and project reminders are capped per platform (Android 200, iOS 60),
 *   soonest first. A cycle runs again 5 s after the soonest fires, so the window tops up.
 * - Snooze is a new alarm outside the map, 10 minutes after the tap, so a cycle never
 *   cancels it. It can still fire after the task is done: a kept trade-off.
 * - Android start requests remove orphaned native rows (`findStaleNativeReminderAlarms`),
 *   while the native receiver consumes fired one-shots and discards those over 24 h late.
 *   A pending snooze of a live task stays.
 * - A store change re-runs a cycle 2.5 s after the last change to tasks, projects or a
 *   reminder setting.
 * - Date-only dates never schedule (buildReminderSchedule). No reminder feature on, or no
 *   notification permission, cancels every alarm.
 * - The Pomodoro completion alarm keeps its own entry (POMODORO_ALARM_STORAGE_KEY).
 */
import {
    buildReminderSchedule,
    getProjectReviewReminderIntent,
    getReminderNotificationTag,
    getTaskReminderPlan,
    hasActiveMobileNotificationFeature,
    type ReminderScheduleDiagnostics,
    type ReminderScheduleRequest,
} from './schedule-utils';
import { isTaskActionable } from './task-status';
import type { AppLanguage, NotificationSettings, Project, Task } from './types';

export const REMINDER_ALARM_MAP_STORAGE_KEY = 'mindwtr:local:alarms:v1';
export const POMODORO_ALARM_STORAGE_KEY = 'mindwtr:local:pomodoro-alarm:v1';
export const REMINDER_NOTIFICATION_CHANNEL = 'mindwtr_reminders_v2';
export const REMINDER_NOTIFICATION_CHANNEL_NAME = 'Mindwtr reminders';
const REMINDER_NOTIFICATION_COLOR = '#3b82f6';
const REMINDER_SMALL_ICON = 'ic_launcher';
export const MAX_DUPLICATE_ALARM_RETRIES = 59;
const DUPLICATE_ALARM_RETRY_INTERVAL_MS = 60_000;
/** One-shot reminder alarms a platform holds at once, soonest first. */
export const MAX_PENDING_ONE_SHOT_REMINDER_ALARMS = { android: 200, ios: 60 } as const;
const ALARM_SCHEDULE_BATCH_SIZE = 10;
const ONE_SHOT_TOP_UP_DELAY_MS = 5_000;
const MAX_TIMER_DELAY_MS = 24 * 60 * 60 * 1000;
/** A notification tap or dismissal re-runs a cycle this long after the last one. */
export const REMINDER_NOTIFICATION_EVENT_RESCHEDULE_DELAY_MS = 250;
// A sync cycle updates the store several times within a few seconds (write-local,
// write-remote bookkeeping, refresh); coalesce those into one full reschedule scan instead
// of 2-4 per cycle (#766). Alarms fire minutes out, so a short delay is imperceptible.
export const REMINDER_STORE_RESCHEDULE_DELAY_MS = 2_500;
export const TASK_REMINDER_SNOOZE_MINUTES = 10;
/** A Pomodoro alert due within this long is shown now instead of scheduled. */
const POMODORO_IMMEDIATE_WINDOW_MS = 1_000;

export type ReminderAlarmConfig = {
    title: string;
    message: string;
    fireAt: Date;
    repeatInterval?: 'daily' | 'weekly';
    hasSnoozeAction?: boolean;
    hasCompleteAction?: boolean;
    data?: Record<string, string>;
};

export type ReminderAlarmEntry = { id: number; signature?: string; pending?: true };

export type ReminderAlarmRequest = { key: string; config: ReminderAlarmConfig; signature: string };

/**
 * Why a held alarm goes. `withdrawn`: what it announced no longer holds, so its delivered
 * notification goes too. `expired`: what it announced held when it fired, so a delivered
 * notification stays.
 */
export type ReminderAlarmCancelReason = 'withdrawn' | 'expired';

export const getMaxPendingOneShotReminderAlarms = (platform: string): number => (
    platform === 'ios' ? MAX_PENDING_ONE_SHOT_REMINDER_ALARMS.ios : MAX_PENDING_ONE_SHOT_REMINDER_ALARMS.android
);

/** The stored alarm map; entries without a usable id are skipped. Throws on unreadable JSON. */
export function readReminderAlarmMap(raw: string | null): Map<string, ReminderAlarmEntry> {
    const map = new Map<string, ReminderAlarmEntry>();
    if (!raw) return map;
    const parsed = JSON.parse(raw) as Record<string, ReminderAlarmEntry>;
    for (const [key, value] of Object.entries(parsed)) {
        if (!value || typeof value !== 'object') continue;
        const id = Number(value.id);
        if (!Number.isFinite(id)) continue;
        const signature = typeof value.signature === 'string' ? value.signature : undefined;
        map.set(key, { id: Math.floor(id), signature, ...(value.pending === true ? { pending: true as const } : {}) });
    }
    return map;
}

export function writeReminderAlarmMap(map: ReadonlyMap<string, ReminderAlarmEntry>): string {
    const result: Record<string, ReminderAlarmEntry> = {};
    for (const [key, value] of map.entries()) result[key] = value;
    return JSON.stringify(result);
}

/** What an alarm shows and when; repeating alarms by time of day (and weekday), in local time. */
export function buildReminderAlarmSignature(config: ReminderAlarmConfig): string {
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

export const isReminderAlarmCurrent = (entry: ReminderAlarmEntry | undefined, signature: string): boolean => (
    entry !== undefined && entry.pending !== true && entry.signature === signature
);

export function normalizeNotificationMessage(title: string, message?: string): string {
    const trimmedMessage = String(message || '').trim();
    if (trimmedMessage) return trimmedMessage;
    return String(title || '').trim();
}

/** The alarm library's details for a reminder alarm, without its fire date. */
export function buildReminderAlarmDetails(key: string, config: ReminderAlarmConfig): Record<string, unknown> {
    return {
        title: config.title,
        message: normalizeNotificationMessage(config.title, config.message),
        channel: REMINDER_NOTIFICATION_CHANNEL,
        auto_cancel: true,
        small_icon: REMINDER_SMALL_ICON,
        color: REMINDER_NOTIFICATION_COLOR,
        has_button: config.hasSnoozeAction === true || config.hasCompleteAction === true,
        has_complete_action: config.hasCompleteAction === true,
        loop_sound: false,
        play_sound: true,
        schedule_type: config.repeatInterval ? 'repeat' : 'once',
        repeat_interval: config.repeatInterval ?? 'hourly',
        interval_value: 1,
        use_big_text: true,
        vibrate: false,
        // Android posts under (tag, one id), iOS uses it as the thread: each reminder of a task
        // replaces the task's notification instead of adding another one.
        tag: getReminderNotificationTag(key),
        data: {
            ...(config.data ?? {}),
            alarmKey: key,
            ...(config.hasCompleteAction === true ? { notificationActionComplete: 'true' } : {}),
        },
        ...(config.hasSnoozeAction === true ? { snooze_interval: TASK_REMINDER_SNOOZE_MINUTES } : {}),
    };
}

/** React Native's alarm library treats alarms in the same minute as duplicates; each retry is a minute later. */
export function getDuplicateAlarmRetryFireAt(baseFireAt: Date, retry: number): Date {
    const normalizedRetry = Math.max(0, Math.floor(retry));
    return new Date(baseFireAt.getTime() + normalizedRetry * DUPLICATE_ALARM_RETRY_INTERVAL_MS);
}

export function isDuplicateReminderAlarmError(error: unknown): boolean {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return message.includes('duplicate alarm set at date');
}

/** How long after `now` a cycle should run again so the capped one-shot window tops up. */
export function getOneShotTopUpDelayMs(sortedFireAtMs: number[], nowMs: number): number | null {
    if (sortedFireAtMs.length === 0) return null;
    const nextFireAtMs = sortedFireAtMs[0];
    if (!Number.isFinite(nextFireAtMs)) return null;
    const rawDelayMs = Math.max(ONE_SHOT_TOP_UP_DELAY_MS, nextFireAtMs - nowMs + ONE_SHOT_TOP_UP_DELAY_MS);
    return Math.min(MAX_TIMER_DELAY_MS, rawDelayMs);
}

export type ReminderAlarmPlanInput = {
    settings: NotificationSettings;
    tasks: Task[];
    projects: Project[];
    now: Date;
    /** Alarm texts; read only while a reminder feature is on. */
    translations: Record<string, string>;
    maxOneShotReminders: number;
    /** The alarms the device holds, by key. */
    alarms: ReadonlyMap<string, ReminderAlarmEntry>;
    /** False when the OS denies notifications. Default true. */
    permissionGranted?: boolean;
};

export type ReminderAlarmPlan = {
    /** Daily digests and the weekly review, scheduled one at a time before the one-shots. */
    recurring: ReminderAlarmRequest[];
    /** Task and project reminders, soonest first and capped. */
    oneShot: ReminderAlarmRequest[];
    /** Requested keys whose held alarm already matches. */
    keep: string[];
    /** Requested keys to make (again): missing, changed or pending. */
    schedule: string[];
    /** Held keys that are not requested. */
    cancel: string[];
    /** Why each held alarm that goes (cancelled, or remade because it changed) goes. */
    reasons: Record<string, ReminderAlarmCancelReason>;
    topUpDelayMs: number | null;
} & (
    | { mode: 'active'; diagnostics: ReminderScheduleDiagnostics }
    /** No reminder feature on (`inactive`) or no notification permission (`revoked`): cancel every alarm. */
    | { mode: 'inactive' | 'revoked'; diagnostics: null }
);

const toReminderAlarmRequest = (request: ReminderScheduleRequest): ReminderAlarmRequest => {
    const config: ReminderAlarmConfig = {
        title: request.title,
        message: request.message,
        fireAt: request.fireAt,
        repeatInterval: request.repeatInterval,
        hasSnoozeAction: request.hasSnoozeAction,
        hasCompleteAction: request.hasCompleteAction,
        data: request.data,
    };
    return { key: request.key, config, signature: buildReminderAlarmSignature(config) };
};

/** The time a held one-shot alarm was made for, from its signature; null when it cannot be read. */
export function getSignedFireAtMs(entry: Pick<ReminderAlarmEntry, 'signature'>): number | null {
    if (!entry.signature) return null;
    try {
        const fireAt = (JSON.parse(entry.signature) as { fireAt?: unknown }).fireAt;
        const fireAtMs = typeof fireAt === 'string' ? Date.parse(fireAt) : Number.NaN;
        return Number.isFinite(fireAtMs) ? fireAtMs : null;
    } catch {
        return null;
    }
}

/**
 * Why the held alarm under `key` goes, while reminders are on. A digest that is still requested
 * only moved; one that is not was turned off. A task or project reminder expired when its task or
 * project would still give the same key at the same moment, judged just before that moment;
 * otherwise it was withdrawn. An alarm whose moment cannot be read is taken as expired.
 */
export function getActiveCancelReason(
    key: string,
    entry: ReminderAlarmEntry,
    requested: boolean,
    context: { diagnostics: ReminderScheduleDiagnostics; tasks: Map<string, Task>; projects: Map<string, Project> },
): ReminderAlarmCancelReason {
    if (key.startsWith('digest:')) return requested ? 'expired' : 'withdrawn';
    const { diagnostics } = context;
    if (key.startsWith('task:')) {
        const task = context.tasks.get(key.slice('task:'.length).replace(/:r\d+$/, ''));
        if (!diagnostics.taskRemindersEnabled || !task || task.deletedAt || !isTaskActionable(task)) return 'withdrawn';
        const firedAtMs = getSignedFireAtMs(entry);
        if (firedAtMs === null) return 'expired';
        const plan = getTaskReminderPlan(task, new Date(firedAtMs - 1), {
            includeStartTime: diagnostics.includeStartTime,
            includeDueDate: diagnostics.includeDueDate,
            includeReviewAt: diagnostics.includeReviewAt,
        });
        return [plan.next, ...plan.repeats].some((intent) => intent?.key === key && intent.scheduledAt.getTime() === firedAtMs)
            ? 'expired'
            : 'withdrawn';
    }
    if (key.startsWith('project:')) {
        const project = context.projects.get(key.slice('project:'.length));
        if (!diagnostics.includeReviewAt || !project) return 'withdrawn';
        const firedAtMs = getSignedFireAtMs(entry);
        if (firedAtMs === null) return 'expired';
        return getProjectReviewReminderIntent(project, new Date(firedAtMs - 1))?.scheduledAt.getTime() === firedAtMs ? 'expired' : 'withdrawn';
    }
    return 'withdrawn';
}

/** Pure: the alarms the device should hold for this store, against the alarms it holds. */
export function planReminderAlarms(input: ReminderAlarmPlanInput): ReminderAlarmPlan {
    const held = Array.from(input.alarms.keys());
    if (input.permissionGranted === false || !hasActiveMobileNotificationFeature(input.settings)) {
        return {
            mode: input.permissionGranted === false ? 'revoked' : 'inactive',
            recurring: [],
            oneShot: [],
            keep: [],
            schedule: [],
            cancel: held,
            reasons: Object.fromEntries(held.map((key) => [key, 'withdrawn' as const])),
            topUpDelayMs: null,
            diagnostics: null,
        };
    }
    const { requests, diagnostics } = buildReminderSchedule({
        settings: input.settings,
        tasks: input.tasks,
        projects: input.projects,
        now: input.now,
        translations: input.translations,
        maxOneShotReminders: input.maxOneShotReminders,
    });
    const recurring = requests.filter((request) => request.repeatInterval).map(toReminderAlarmRequest);
    const oneShot = requests.filter((request) => !request.repeatInterval).map(toReminderAlarmRequest);
    const requested = new Set<string>();
    const keep: string[] = [];
    const schedule: string[] = [];
    for (const request of [...recurring, ...oneShot]) {
        requested.add(request.key);
        (isReminderAlarmCurrent(input.alarms.get(request.key), request.signature) ? keep : schedule).push(request.key);
    }
    const cancel = held.filter((key) => !requested.has(key));
    const context = {
        diagnostics,
        tasks: new Map(input.tasks.map((task) => [task.id, task])),
        projects: new Map(input.projects.map((project) => [project.id, project])),
    };
    const reasons: Record<string, ReminderAlarmCancelReason> = {};
    for (const key of [...schedule, ...cancel]) {
        const entry = input.alarms.get(key);
        if (entry) reasons[key] = getActiveCancelReason(key, entry, requested.has(key), context);
    }
    return {
        mode: 'active',
        recurring,
        oneShot,
        keep,
        schedule,
        cancel,
        reasons,
        topUpDelayMs: getOneShotTopUpDelayMs(oneShot.map((request) => request.config.fireAt.getTime()), input.now.getTime()),
        diagnostics,
    };
}

/**
 * The plan's reason for the alarm under `key`. One the plan did not hold (made late by an
 * aborted cycle) expires, unless every alarm is going.
 */
export const getReminderAlarmCancelReason = (plan: ReminderAlarmPlan, key: string): ReminderAlarmCancelReason => (
    plan.reasons[key] ?? (plan.mode === 'active' ? 'expired' : 'withdrawn')
);

/** How many held alarms the plan withdraws and lets expire, for the diagnostics line. */
export function countReminderAlarmCancelReasons(plan: ReminderAlarmPlan): Record<ReminderAlarmCancelReason, number> {
    const counts = { withdrawn: 0, expired: 0 };
    for (const reason of Object.values(plan.reasons)) counts[reason] += 1;
    return counts;
}

/** React Native's alarm library, and the service's log. */
export type ReminderAlarmPort = {
    parseDate(date: Date): string;
    scheduleAlarm(details: Record<string, unknown>): Promise<{ id?: number | string } | null | undefined>;
    deleteAlarm(id: number): void;
    deleteRepeatingAlarm(id: number): void;
    removeFiredNotification(id: number): void;
    logInfo(message: string, extra?: Record<string, unknown>): void;
    logError(message: string, error?: unknown): void;
};

const toAlarmFireDate = (port: ReminderAlarmPort, date: Date): string => {
    const next = new Date(date);
    next.setMilliseconds(0);
    return port.parseDate(next);
};

/**
 * Cancels the alarm held under `key`; false when none is held. A withdrawn alarm's delivered
 * notification goes first: Android's library finds it through the alarm's row, which
 * deleteAlarm deletes. An expired alarm's delivered notification stays.
 */
export async function cancelReminderAlarm(
    alarms: Map<string, ReminderAlarmEntry>,
    key: string,
    port: ReminderAlarmPort,
    reason: ReminderAlarmCancelReason,
): Promise<boolean> {
    const entry = alarms.get(key);
    if (!entry) return false;
    if (reason === 'withdrawn') {
        try {
            port.removeFiredNotification(entry.id);
        } catch {
            // Safe to ignore if notification has not fired.
        }
    }
    try {
        port.deleteAlarm(entry.id);
    } catch (error) {
        port.logError(`Failed to delete alarm (${key})`, error);
    }
    try {
        port.deleteRepeatingAlarm(entry.id);
    } catch {
        // Safe to ignore when alarm is one-shot.
    }
    alarms.delete(key);
    port.logInfo('Alarm canceled', { alarmKey: key, alarmId: entry.id });
    return true;
}

/**
 * Makes one requested alarm unless the held one matches. A duplicate-minute refusal retries
 * a minute later; any other refusal throws, and the alarms made so far stay in `alarms`.
 */
async function scheduleReminderAlarm(
    alarms: Map<string, ReminderAlarmEntry>,
    request: ReminderAlarmRequest,
    port: ReminderAlarmPort,
    plan: ReminderAlarmPlan,
): Promise<void> {
    const { key, config, signature } = request;
    if (isReminderAlarmCurrent(alarms.get(key), signature)) return;

    await cancelReminderAlarm(alarms, key, port, getReminderAlarmCancelReason(plan, key));

    const baseFireAt = new Date(config.fireAt);
    baseFireAt.setMilliseconds(0);
    const detailsBase = buildReminderAlarmDetails(key, config);

    let scheduledId: number | null = null;
    let lastError: unknown = null;

    for (let retry = 0; retry <= MAX_DUPLICATE_ALARM_RETRIES; retry += 1) {
        const fireAt = getDuplicateAlarmRetryFireAt(baseFireAt, retry);
        try {
            const result = await port.scheduleAlarm({
                ...detailsBase,
                fire_date: toAlarmFireDate(port, fireAt),
            });
            const id = Number(result?.id);
            if (!Number.isFinite(id)) {
                port.logError(`Scheduled alarm returned invalid id for ${key}`);
                return;
            }
            scheduledId = Math.floor(id);
            port.logInfo('Alarm scheduled', {
                alarmKey: key,
                alarmId: scheduledId,
                fireAt: fireAt.toISOString(),
                retryCount: retry,
                scheduleType: config.repeatInterval ? 'repeat' : 'once',
            });
            break;
        } catch (error) {
            lastError = error;
            if (isDuplicateReminderAlarmError(error) && retry < MAX_DUPLICATE_ALARM_RETRIES) {
                continue;
            }
            port.logError(`Failed to schedule alarm (${key})`, error);
            throw error;
        }
    }

    if (scheduledId === null) {
        port.logError(`Failed to schedule alarm for ${key} after duplicate retries`, lastError);
        return;
    }

    alarms.set(key, { id: scheduledId, signature });
}

async function scheduleReminderAlarmBatches(
    alarms: Map<string, ReminderAlarmEntry>,
    plan: ReminderAlarmPlan,
    port: ReminderAlarmPort,
): Promise<void> {
    for (let index = 0; index < plan.oneShot.length; index += ALARM_SCHEDULE_BATCH_SIZE) {
        const batch = plan.oneShot.slice(index, index + ALARM_SCHEDULE_BATCH_SIZE);
        await Promise.all(batch.map((request) => scheduleReminderAlarm(alarms, request, port, plan)));
    }
}

/**
 * Makes every requested alarm that is missing or changed: the repeating ones one at a time,
 * then the one-shots ten at a time. It updates `alarms` as it goes, so a refusal that aborts
 * the pass leaves the ids of the alarms already made there to be saved.
 */
export async function scheduleReminderAlarms(
    plan: ReminderAlarmPlan,
    alarms: Map<string, ReminderAlarmEntry>,
    port: ReminderAlarmPort,
): Promise<void> {
    for (const request of plan.recurring) {
        await scheduleReminderAlarm(alarms, request, port, plan);
    }
    await scheduleReminderAlarmBatches(alarms, plan, port);
}

/** Cancels every held alarm the plan does not request, as `alarms` stands now. */
export async function cancelUnrequestedReminderAlarms(
    plan: ReminderAlarmPlan,
    alarms: Map<string, ReminderAlarmEntry>,
    port: ReminderAlarmPort,
): Promise<void> {
    const requested = new Set([...plan.recurring, ...plan.oneShot].map((request) => request.key));
    for (const key of Array.from(alarms.keys())) {
        if (requested.has(key)) continue;
        await cancelReminderAlarm(alarms, key, port, getReminderAlarmCancelReason(plan, key));
    }
}

/**
 * Snooze: the fired alarm again, `snooze_interval` minutes after the tap, as an alarm of its
 * own that no cycle cancels. `snoozeKey` names it, so a replay replaces it instead of adding
 * one. Null when the alarm has no Snooze.
 */
export function buildReminderSnooze(
    details: Record<string, unknown>,
    requestedAtMs: number,
    snoozeKey: string,
): { key: string; fireAtMs: number; details: Record<string, unknown> } | null {
    const minutes = details.snooze_interval;
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0 || !Number.isFinite(requestedAtMs)) return null;
    const fireAt = new Date(requestedAtMs + minutes * 60_000);
    fireAt.setMilliseconds(0);
    const data = details.data && typeof details.data === 'object' ? details.data as Record<string, unknown> : {};
    return {
        key: snoozeKey,
        fireAtMs: fireAt.getTime(),
        details: { ...details, schedule_type: 'once', data: { ...data } },
    };
}

type ReminderStoreSnapshot = {
    tasks: unknown;
    projects: unknown;
    settings: NotificationSettings & { language?: AppLanguage };
};

// Every field a reschedule cycle reads (its own gates plus buildReminderSchedule's:
// areTaskRemindersEnabled, areStartDateRemindersEnabled, areDueDateRemindersEnabled,
// isWeeklyReviewReminderEnabled, hasActiveMobileNotificationFeature, getDigestSchedule and
// reviewAtNotificationsEnabled) plus `language`: every alarm title and body is localized
// from it, so a language switch must re-arm too (correction #3). A settings object can
// change identity every sync cycle (lastSyncAt/lastSyncStatus/lastSyncStats bookkeeping)
// without moving any of these (#766).
function getReminderSettingsSignature(settings: ReminderStoreSnapshot['settings']): string {
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

/**
 * Whether a store change re-arms alarms: any change to the task or project arrays, or to a
 * reminder setting. Re-run the cycle REMINDER_STORE_RESCHEDULE_DELAY_MS after the last one.
 */
export function shouldRescheduleReminderAlarms(state: ReminderStoreSnapshot, previous: ReminderStoreSnapshot): boolean {
    const tasksOrProjectsChanged = state.tasks !== previous.tasks || state.projects !== previous.projects;
    const settingsRelevantChanged = state.settings !== previous.settings
        && getReminderSettingsSignature(state.settings) !== getReminderSettingsSignature(previous.settings);
    return tasksOrProjectsChanged || settingsRelevantChanged;
}

/** An Android alarm row's `key==>value;;` data (or an object), as strings. */
function readNativeAlarmData(value: unknown): Record<string, string> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, String(item)]));
    }
    const data: Record<string, string> = {};
    if (typeof value !== 'string') return data;
    for (const item of value.split(';;')) {
        const separator = item.indexOf('==>');
        if (separator > 0) data[item.slice(0, separator)] = item.slice(separator + 3);
    }
    return data;
}

/** Whether the task or project an alarm key names is gone, done or archived; a key of another kind has none to lose. */
export function isReminderOwnerGone(key: string, tasks: ReadonlyMap<string, Task>, projects: ReadonlyMap<string, Project>): boolean {
    const task = key.startsWith('task:') ? tasks.get(key.slice('task:'.length).replace(/:r\d+$/, '')) : undefined;
    const project = key.startsWith('project:') ? projects.get(key.slice('project:'.length)) : undefined;
    return (key.startsWith('task:') && (!task || Boolean(task.deletedAt) || !isTaskActionable(task)))
        || (key.startsWith('project:') && (!project || Boolean(project.deletedAt) || project.status === 'archived'));
}

/**
 * The Android alarm rows (`getScheduledAlarms`: id, scheduleType, local year/month/day/hour/
 * minute/second, data) that no cycle can cancel and nothing still wants, with why each goes.
 * A row whose id the alarm map holds, or a Pomodoro alarm, is never listed. Withdrawn: it
 * names a task or project that is gone, done or archived. Expired: it repeats (every digest
 * is in the map), or its time is over 24 h past. A recent or future one-shot
 * of a live task stays: it may be a late or pending snooze.
 */
export function findStaleNativeReminderAlarms(input: {
    rows: unknown;
    trackedIds: ReadonlySet<number>;
    tasks: Task[];
    projects: Project[];
    now: Date;
}): { id: number; reason: ReminderAlarmCancelReason }[] {
    if (!Array.isArray(input.rows)) return [];
    const tasks = new Map(input.tasks.map((task) => [task.id, task]));
    const projects = new Map(input.projects.map((project) => [project.id, project]));
    const stale: { id: number; reason: ReminderAlarmCancelReason }[] = [];
    for (const row of input.rows as Record<string, unknown>[]) {
        if (!row || typeof row !== 'object') continue;
        const id = Number(row.id);
        if (!Number.isSafeInteger(id) || id <= 0 || input.trackedIds.has(id) || isPomodoroNativeAlarm(row)) continue;
        const key = readNativeAlarmData(row.data).alarmKey ?? '';
        const ownerGone = isReminderOwnerGone(key, tasks, projects);
        const fireAtMs = new Date(
            Number(row.year), Number(row.month) - 1, Number(row.day), Number(row.hour), Number(row.minute), Number(row.second),
        ).getTime();
        if (ownerGone) stale.push({ id, reason: 'withdrawn' });
        // A live snooze may be pending just after its fire time; Android can
        // deliver it late. Match the native 24 h grace before expiring it.
        else if (row.scheduleType === 'repeat' || fireAtMs < input.now.getTime() - 24 * 60 * 60 * 1000) {
            stale.push({ id, reason: 'expired' });
        }
    }
    return stale;
}

// --- The Pomodoro completion alarm ---

export type PomodoroAlarmEntry = {
    id?: number;
    fireAtMs?: number;
    phase?: string;
    notifiedImmediately?: boolean;
};

/** The stored Pomodoro alarm, or null when none is stored. Throws on unreadable JSON. */
export function readPomodoroAlarmEntry(raw: string | null): PomodoroAlarmEntry | null {
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PomodoroAlarmEntry>;
    const id = Number(parsed?.id);
    const fireAtMs = Number(parsed?.fireAtMs);
    const entry: PomodoroAlarmEntry = {
        ...(Number.isFinite(id) ? { id: Math.floor(id) } : {}),
        ...(Number.isFinite(fireAtMs) ? { fireAtMs } : {}),
        ...(typeof parsed?.phase === 'string' ? { phase: parsed.phase } : {}),
        ...(parsed?.notifiedImmediately === true ? { notifiedImmediately: true } : {}),
    };
    if (entry.id === undefined && entry.fireAtMs === undefined) return null;
    return entry;
}

/** Only a timer that stopped on its own (`timer-not-running`) is not an explicit cancellation. */
export const isExplicitPomodoroAlarmCancellation = (reason: string): boolean => reason !== 'timer-not-running';

/** The stored alarm's deadline has passed: its alert is (about to be) shown, so it is kept. */
export const isPomodoroAlarmDue = (entry: PomodoroAlarmEntry | null | undefined, atMs: number): boolean => (
    entry?.fireAtMs !== undefined && entry.fireAtMs <= atMs
);

/** Whether cancelling alarm `id` also removes its delivered notification. */
export function shouldRemoveFiredPomodoroAlarm(options: {
    removeFired?: boolean;
    reason: string;
    entry: PomodoroAlarmEntry | null;
    id: number;
    requestedAtMs: number;
}): boolean {
    const { entry } = options;
    return options.removeFired
        ?? (isExplicitPomodoroAlarmCancellation(options.reason) || entry?.id !== options.id || !entry.fireAtMs || entry.fireAtMs > options.requestedAtMs);
}

export type PomodoroAlarmCancellation = { order: number; requestedAtMs: number; reason: string };

/**
 * A later cancellation wins over a schedule request, except that a timer stopping on its own
 * does not cancel an alarm that was due before it stopped.
 */
export function isPomodoroAlarmScheduleSuperseded(
    cancellation: PomodoroAlarmCancellation | null,
    scheduleOrder: number,
    fireAtMs: number,
): boolean {
    if (!cancellation || cancellation.order <= scheduleOrder) return false;
    return cancellation.reason !== 'timer-not-running'
        || cancellation.requestedAtMs < fireAtMs;
}

/** The stored alarm already fires at this deadline for this phase (a record without a phase matches any). */
export function isPomodoroAlarmUnchanged(previous: PomodoroAlarmEntry | null, fireAtMs: number, phase: string): boolean {
    const samePhase = !previous?.phase || !phase || previous.phase === phase;
    return previous?.fireAtMs === fireAtMs && samePhase;
}

/** A deadline this close is shown now instead of scheduled. */
export const isPomodoroAlarmImmediate = (fireAtMs: number, nowMs: number): boolean => fireAtMs <= nowMs + POMODORO_IMMEDIATE_WINDOW_MS;

const pomodoroData = (data?: Record<string, string>) => ({ kind: 'pomodoro', ...(data ?? {}) });

/** The alarm library's details for a notification shown now. */
export function buildImmediateNotificationDetails(title: string, message?: string, data?: Record<string, string>): Record<string, unknown> {
    return {
        title,
        message: normalizeNotificationMessage(title, message),
        channel: REMINDER_NOTIFICATION_CHANNEL,
        auto_cancel: true,
        small_icon: REMINDER_SMALL_ICON,
        color: REMINDER_NOTIFICATION_COLOR,
        has_button: false,
        loop_sound: false,
        play_sound: true,
        use_big_text: true,
        vibrate: false,
        data: pomodoroData(data),
    };
}

/** The alarm library's details for the Pomodoro completion alarm, without its fire date. */
export function buildPomodoroAlarmDetails(title: string, message: string, data?: Record<string, string>): Record<string, unknown> {
    return {
        title,
        message: normalizeNotificationMessage(title, message),
        channel: REMINDER_NOTIFICATION_CHANNEL,
        auto_cancel: true,
        small_icon: REMINDER_SMALL_ICON,
        color: REMINDER_NOTIFICATION_COLOR,
        has_button: false,
        // The patched iOS module reads this key into a dictionary literal, where a missing
        // value is nil and throws NSInvalidArgumentException — the reason no pomodoro alert
        // ever scheduled on iOS (#888). Always pass it, like the task-reminder path does.
        has_complete_action: false,
        loop_sound: false,
        play_sound: true,
        schedule_type: 'once',
        use_big_text: true,
        vibrate: false,
        data: pomodoroData(data),
    };
}

/** Whether an alarm the library lists (its data as an object, JSON, or `key==>value;;` pairs) is a Pomodoro alarm. */
export function isPomodoroNativeAlarm(value: unknown): boolean {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        return record.kind === 'pomodoro' || isPomodoroNativeAlarm(record.data);
    }
    if (typeof value !== 'string') return false;
    try {
        return isPomodoroNativeAlarm(JSON.parse(value) as unknown);
    } catch {
        return value.split(';;').some((item) => {
            const separator = item.indexOf('==>');
            return separator >= 0
                && item.slice(0, separator) === 'kind'
                && item.slice(separator + 3) === 'pomodoro';
        });
    }
}
