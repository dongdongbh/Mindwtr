


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
import { isTaskReminderSelectionCurrent, shouldSendTaskReminders } from './task-reminder-policy';
import type { AppLanguage, NotificationSettings, Project, Task } from './types';

export const REMINDER_ALARM_MAP_STORAGE_KEY = 'mindwtr:local:alarms:v1';
export const POMODORO_ALARM_STORAGE_KEY = 'mindwtr:local:pomodoro-alarm:v1';
export const REMINDER_NOTIFICATION_CHANNEL = 'mindwtr_reminders_v2';
export const REMINDER_NOTIFICATION_CHANNEL_NAME = 'Mindwtr reminders';
const REMINDER_NOTIFICATION_COLOR = '#3b82f6';
const REMINDER_SMALL_ICON = 'ic_launcher';
export const MAX_DUPLICATE_ALARM_RETRIES = 59;
const DUPLICATE_ALARM_RETRY_INTERVAL_MS = 60_000;

export const MAX_PENDING_ONE_SHOT_REMINDER_ALARMS = { android: 200, ios: 60 } as const;
const ALARM_SCHEDULE_BATCH_SIZE = 10;
const ONE_SHOT_TOP_UP_DELAY_MS = 5_000;
const MAX_TIMER_DELAY_MS = 24 * 60 * 60 * 1000;

export const REMINDER_NOTIFICATION_EVENT_RESCHEDULE_DELAY_MS = 250;


export const REMINDER_STORE_RESCHEDULE_DELAY_MS = 2_500;
export const TASK_REMINDER_SNOOZE_MINUTES = 10;

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


export type ReminderAlarmEntry = { id: number; signature?: string; pending?: true; fireAtMs?: number };

export type ReminderAlarmRequest = { key: string; config: ReminderAlarmConfig; signature: string };


export type ReminderAlarmCancelReason = 'withdrawn' | 'expired';

export const getMaxPendingOneShotReminderAlarms = (platform: string): number => (
    platform === 'ios' ? MAX_PENDING_ONE_SHOT_REMINDER_ALARMS.ios : MAX_PENDING_ONE_SHOT_REMINDER_ALARMS.android
);


export function readReminderAlarmMap(raw: string | null): Map<string, ReminderAlarmEntry> {
    const map = new Map<string, ReminderAlarmEntry>();
    if (!raw) return map;
    const parsed = JSON.parse(raw) as Record<string, ReminderAlarmEntry>;
    for (const [key, value] of Object.entries(parsed)) {
        if (!value || typeof value !== 'object') continue;
        const id = Number(value.id);
        if (!Number.isFinite(id)) continue;
        const signature = typeof value.signature === 'string' ? value.signature : undefined;
        const fireAtMs = Number(value.fireAtMs);
        map.set(key, {
            id: Math.floor(id),
            signature,
            ...(value.pending === true ? { pending: true as const } : {}),
            ...(value.fireAtMs !== undefined && Number.isFinite(fireAtMs) ? { fireAtMs } : {}),
        });
    }
    return map;
}

export function writeReminderAlarmMap(map: ReadonlyMap<string, ReminderAlarmEntry>): string {
    const result: Record<string, ReminderAlarmEntry> = {};
    for (const [key, value] of map.entries()) result[key] = value;
    return JSON.stringify(result);
}


function getDeviceTimeZone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
    } catch {
        return '';
    }
}


export function buildReminderAlarmSignature(config: ReminderAlarmConfig, timeZone: string = getDeviceTimeZone()): string {
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
        ...(config.repeatInterval && timeZone ? { timeZone } : {}),
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


        tag: getReminderNotificationTag(key),
        data: {
            ...(config.data ?? {}),
            alarmKey: key,
            ...(config.hasCompleteAction === true ? { notificationActionComplete: 'true' } : {}),
        },
        ...(config.hasSnoozeAction === true ? { snooze_interval: TASK_REMINDER_SNOOZE_MINUTES } : {}),
    };
}


export function getDuplicateAlarmRetryFireAt(baseFireAt: Date, retry: number): Date {
    const normalizedRetry = Math.max(0, Math.floor(retry));
    return new Date(baseFireAt.getTime() + normalizedRetry * DUPLICATE_ALARM_RETRY_INTERVAL_MS);
}

export function isDuplicateReminderAlarmError(error: unknown): boolean {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return message.includes('duplicate alarm set at date');
}


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

    translations: Record<string, string>;
    maxOneShotReminders: number;

    alarms: ReadonlyMap<string, ReminderAlarmEntry>;

    permissionGranted?: boolean;
};

export type ReminderAlarmPlan = {

    recurring: ReminderAlarmRequest[];

    oneShot: ReminderAlarmRequest[];

    keep: string[];


    shifted: string[];

    schedule: string[];

    cancel: string[];

    reasons: Record<string, ReminderAlarmCancelReason>;
    topUpDelayMs: number | null;
} & (
    | { mode: 'active'; diagnostics: ReminderScheduleDiagnostics }

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


export function getActiveCancelReason(
    key: string,
    entry: ReminderAlarmEntry,
    requested: boolean,
    context: { settings: NotificationSettings; diagnostics: ReminderScheduleDiagnostics; tasks: Map<string, Task>; projects: Map<string, Project> },
): ReminderAlarmCancelReason {
    if (key.startsWith('digest:')) return requested ? 'expired' : 'withdrawn';
    const { diagnostics } = context;
    if (key.startsWith('task:')) {
        const task = context.tasks.get(key.slice('task:'.length).replace(/:(?:r\d+|s?a\d+:-?\d+)$/, ''));
        if (!diagnostics.taskRemindersEnabled || !task || task.deletedAt || !isTaskActionable(task)) return 'withdrawn';
        const firedAtMs = getSignedFireAtMs(entry);
        if (firedAtMs === null) return 'expired';
        const plan = getTaskReminderPlan(task, new Date(firedAtMs - 1), {
            includeStartTime: diagnostics.includeStartTime,
            includeDueDate: diagnostics.includeDueDate,
            includeReviewAt: diagnostics.includeReviewAt,
            taskReminderDefault: context.settings.taskReminderDefault,
        });
        return [plan.next, plan.advance, plan.startAdvance, ...plan.repeats].some((intent) => intent?.key === key && intent.scheduledAt.getTime() === firedAtMs)
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


export function planReminderAlarms(input: ReminderAlarmPlanInput): ReminderAlarmPlan {
    const held = Array.from(input.alarms.keys());
    if (input.permissionGranted === false || !hasActiveMobileNotificationFeature(input.settings)) {
        return {
            mode: input.permissionGranted === false ? 'revoked' : 'inactive',
            recurring: [],
            oneShot: [],
            keep: [],
            shifted: [],
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
    const requested = new Set([...recurring, ...oneShot].map((request) => request.key));

    let taskById: Map<string, Task> | null = null;
    let projectById: Map<string, Project> | null = null;
    const context = {
        settings: input.settings,
        diagnostics,
        get tasks() { return taskById ??= new Map(input.tasks.map((task) => [task.id, task])); },
        get projects() { return projectById ??= new Map(input.projects.map((project) => [project.id, project])); },
    };
    const nowMs = input.now.getTime();
    const shifted = held.filter((key) => {
        const entry = input.alarms.get(key)!;
        const signedFireAtMs = getSignedFireAtMs(entry);
        return entry.pending !== true && entry.fireAtMs !== undefined && entry.fireAtMs > nowMs
            && signedFireAtMs !== null && signedFireAtMs <= nowMs
            && getActiveCancelReason(key, entry, requested.has(key), context) === 'expired';
    });

    let excess = oneShot.length + shifted.filter((key) => !requested.has(key)).length - input.maxOneShotReminders;
    for (let index = oneShot.length - 1; excess > 0 && index >= 0; index -= 1) {
        if (shifted.includes(oneShot[index].key)) continue;
        requested.delete(oneShot[index].key);
        oneShot.splice(index, 1);
        excess -= 1;
    }
    const keep = held.filter((key) => shifted.includes(key) && !requested.has(key));
    const schedule: string[] = [];
    for (const request of [...recurring, ...oneShot]) {
        const current = shifted.includes(request.key) || isReminderAlarmCurrent(input.alarms.get(request.key), request.signature);
        (current ? keep : schedule).push(request.key);
    }
    const cancel = held.filter((key) => !requested.has(key) && !shifted.includes(key));
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
        shifted,
        schedule,
        cancel,
        reasons,
        topUpDelayMs: getOneShotTopUpDelayMs(
            [...oneShot.map((request) => request.config.fireAt.getTime()), ...shifted.map((key) => input.alarms.get(key)!.fireAtMs!)]
                .sort((left, right) => left - right),
            nowMs,
        ),
        diagnostics,
    };
}


export const getReminderAlarmCancelReason = (plan: ReminderAlarmPlan, key: string): ReminderAlarmCancelReason => (
    plan.reasons[key] ?? (plan.mode === 'active' ? 'expired' : 'withdrawn')
);


export function countReminderAlarmCancelReasons(plan: ReminderAlarmPlan): Record<ReminderAlarmCancelReason, number> {
    const counts = { withdrawn: 0, expired: 0 };
    for (const reason of Object.values(plan.reasons)) counts[reason] += 1;
    return counts;
}


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

    }
    alarms.delete(key);
    port.logInfo('Alarm canceled', { alarmKey: key, alarmId: entry.id });
    return true;
}


async function scheduleReminderAlarm(
    alarms: Map<string, ReminderAlarmEntry>,
    request: ReminderAlarmRequest,
    port: ReminderAlarmPort,
    plan: ReminderAlarmPlan,
): Promise<boolean> {
    const { key, config, signature } = request;
    if (plan.shifted.includes(key) || isReminderAlarmCurrent(alarms.get(key), signature)) return true;

    await cancelReminderAlarm(alarms, key, port, getReminderAlarmCancelReason(plan, key));

    const baseFireAt = new Date(config.fireAt);
    baseFireAt.setMilliseconds(0);
    const detailsBase = buildReminderAlarmDetails(key, config);

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
                return false;
            }
            port.logInfo('Alarm scheduled', {
                alarmKey: key,
                alarmId: Math.floor(id),
                fireAt: fireAt.toISOString(),
                retryCount: retry,
                scheduleType: config.repeatInterval ? 'repeat' : 'once',
            });
            if (config.data?.kind === 'task-due-advance' || config.data?.kind === 'task-start-advance') {
                port.logInfo('Advance reminder scheduled', { releaseCheck: config.data.kind === 'task-start-advance' ? 'v1.3.8/start-advance-reminder' : 'v1.3.8/due-advance-reminder', outcome: 'scheduled' });
            }
            if (config.data?.reminderSelection) port.logInfo('Selective task reminder scheduled', { releaseCheck: 'v1.3.9/selective-task-reminder', outcome: 'scheduled' });
            alarms.set(key, { id: Math.floor(id), signature, ...(retry > 0 ? { fireAtMs: fireAt.getTime() } : {}) });
            return true;
        } catch (error) {
            if (config.data?.kind !== 'task-due-advance' && config.data?.kind !== 'task-start-advance' && isDuplicateReminderAlarmError(error) && retry < MAX_DUPLICATE_ALARM_RETRIES) {
                continue;
            }
            port.logError(`Failed to schedule alarm (${key})`, error);
            return false;
        }
    }
    return false;
}


export async function scheduleReminderAlarms(
    plan: ReminderAlarmPlan,
    alarms: Map<string, ReminderAlarmEntry>,
    port: ReminderAlarmPort,
): Promise<number> {
    let refused = 0;
    const arm = async (request: ReminderAlarmRequest) => {
        try {
            if (await scheduleReminderAlarm(alarms, request, port, plan)) return;
        } catch (error) {
            port.logError(`Failed to schedule alarm (${request.key})`, error);
        }
        refused += 1;
    };
    for (const request of plan.recurring) await arm(request);
    for (let index = 0; index < plan.oneShot.length; index += ALARM_SCHEDULE_BATCH_SIZE) {
        await Promise.all(plan.oneShot.slice(index, index + ALARM_SCHEDULE_BATCH_SIZE).map(arm));
    }
    return refused;
}


export async function cancelUnrequestedReminderAlarms(
    plan: ReminderAlarmPlan,
    alarms: Map<string, ReminderAlarmEntry>,
    port: ReminderAlarmPort,
): Promise<void> {
    const requested = new Set([...plan.recurring, ...plan.oneShot].map((request) => request.key));
    for (const key of Array.from(alarms.keys())) {
        if (requested.has(key) || plan.shifted.includes(key)) continue;
        await cancelReminderAlarm(alarms, key, port, getReminderAlarmCancelReason(plan, key));
    }
}


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


function getReminderSettingsSignature(settings: ReminderStoreSnapshot['settings']): string {
    return JSON.stringify([
        settings.notificationsEnabled,
        settings.startDateNotificationsEnabled,
        settings.dueDateNotificationsEnabled,
        settings.taskReminderDefault,
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


export function shouldRescheduleReminderAlarms(state: ReminderStoreSnapshot, previous: ReminderStoreSnapshot): boolean {
    const tasksOrProjectsChanged = state.tasks !== previous.tasks || state.projects !== previous.projects;
    const settingsRelevantChanged = state.settings !== previous.settings
        && getReminderSettingsSignature(state.settings) !== getReminderSettingsSignature(previous.settings);
    return tasksOrProjectsChanged || settingsRelevantChanged;
}


export function readNativeAlarmData(value: unknown): Record<string, string> {
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


export function isReminderOwnerGone(key: string, tasks: ReadonlyMap<string, Task>, projects: ReadonlyMap<string, Project>): boolean {
    const task = key.startsWith('task:') ? tasks.get(key.slice('task:'.length).replace(/:(?:r\d+|s?a\d+:-?\d+)$/, '')) : undefined;
    const project = key.startsWith('project:') ? projects.get(key.slice('project:'.length)) : undefined;
    return (key.startsWith('task:') && (!task || Boolean(task.deletedAt) || !isTaskActionable(task)))
        || (key.startsWith('project:') && (!project || Boolean(project.deletedAt) || project.status === 'archived'));
}


export function findStaleNativeReminderAlarms(input: {
    rows: unknown;
    trackedIds: ReadonlySet<number>;
    settings?: NotificationSettings;
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
        if (!Number.isSafeInteger(id) || id <= 0 || isPomodoroNativeAlarm(row)) continue;
        const data = readNativeAlarmData(row.data);
        const key = data.alarmKey ?? '';
        const task = key.startsWith('task:') ? tasks.get(key.slice('task:'.length).replace(/:(?:r\d+|s?a\d+:-?\d+)$/, '')) : undefined;
        const taskDateReminder = data.kind === 'task-start' || data.kind === 'task-due' || data.kind === 'task-due-advance' || data.kind === 'task-start-advance' || data.kind === 'task-reminder';
        const selectionChanged = taskDateReminder && task && !isTaskReminderSelectionCurrent(task, data, input.settings);
        if (input.trackedIds.has(id) && !selectionChanged) continue;
        const remindersSkipped = taskDateReminder && task && (!shouldSendTaskReminders(task, input.settings) || selectionChanged);
        const ownerGone = isReminderOwnerGone(key, tasks, projects);
        const fireAtMs = new Date(
            Number(row.year), Number(row.month) - 1, Number(row.day), Number(row.hour), Number(row.minute), Number(row.second),
        ).getTime();
        if (ownerGone || remindersSkipped) stale.push({ id, reason: 'withdrawn' });


        else if (row.scheduleType === 'repeat' || fireAtMs < input.now.getTime() - 24 * 60 * 60 * 1000) {
            stale.push({ id, reason: 'expired' });
        }
    }
    return stale;
}


export type PomodoroAlarmEntry = {
    id?: number;
    fireAtMs?: number;
    phase?: string;
    notifiedImmediately?: boolean;
};


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


export const isExplicitPomodoroAlarmCancellation = (reason: string): boolean => reason !== 'timer-not-running';


export const isPomodoroAlarmDue = (entry: PomodoroAlarmEntry | null | undefined, atMs: number): boolean => (
    entry?.fireAtMs !== undefined && entry.fireAtMs <= atMs
);


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


export function isPomodoroAlarmScheduleSuperseded(
    cancellation: PomodoroAlarmCancellation | null,
    scheduleOrder: number,
    fireAtMs: number,
): boolean {
    if (!cancellation || cancellation.order <= scheduleOrder) return false;
    return cancellation.reason !== 'timer-not-running'
        || cancellation.requestedAtMs < fireAtMs;
}


export function isPomodoroAlarmUnchanged(previous: PomodoroAlarmEntry | null, fireAtMs: number, phase: string): boolean {
    const samePhase = !previous?.phase || !phase || previous.phase === phase;
    return previous?.fireAtMs === fireAtMs && samePhase;
}


export const isPomodoroAlarmImmediate = (fireAtMs: number, nowMs: number): boolean => fireAtMs <= nowMs + POMODORO_IMMEDIATE_WINDOW_MS;

const pomodoroData = (data?: Record<string, string>) => ({ kind: 'pomodoro', ...(data ?? {}) });


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


export function buildPomodoroAlarmDetails(title: string, message: string, data?: Record<string, string>): Record<string, unknown> {
    return {
        title,
        message: normalizeNotificationMessage(title, message),
        channel: REMINDER_NOTIFICATION_CHANNEL,
        auto_cancel: true,
        small_icon: REMINDER_SMALL_ICON,
        color: REMINDER_NOTIFICATION_COLOR,
        has_button: false,


        has_complete_action: false,
        loop_sound: false,
        play_sound: true,
        schedule_type: 'once',
        use_big_text: true,
        vibrate: false,
        data: pomodoroData(data),
    };
}


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
