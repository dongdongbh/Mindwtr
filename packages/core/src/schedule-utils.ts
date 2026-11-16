import { isAfter } from 'date-fns';
import { normalizeDueReminderLeadMinutes, normalizeStartReminderLeadMinutes } from './due-reminder-lead';
export { normalizeDueReminderLeadMinutes, normalizeStartReminderLeadMinutes } from './due-reminder-lead';
import { hasTimeComponent, safeParseDate } from './date';
import { isTaskActionable } from './task-status';
import { stripMarkdown } from './markdown';
import { getTaskReminderPolicy, isSingleTaskReminder, shouldSendTaskReminderKind, shouldSendTaskReminders } from './task-reminder-policy';
import type { NotificationSettings, Project, Task } from './types';

export type ScheduleOptions = {
    includeStartTime?: boolean;
    includeDueDate?: boolean;
    includeReviewAt?: boolean;
    taskReminderDefault?: NotificationSettings['taskReminderDefault'];
    dateOnlyStartReminderTime?: string;
    dateOnlyDueReminderTime?: string;
};

export type TaskReminderIntentKind = 'start' | 'due' | 'review' | 'due-repeat' | 'due-advance' | 'start-advance';

export type TaskReminderIntent = {
    key: string;
    dedupeKey: string;
    taskId: string;
    kind: TaskReminderIntentKind;
    scheduledAt: Date;
    repeatIndex?: number;
    dateOnly?: boolean;
};

export type TaskReminderPlan = {
    next: TaskReminderIntent | null;
    repeats: TaskReminderIntent[];
    advance: TaskReminderIntent | null;
    startAdvance: TaskReminderIntent | null;
};

export type ProjectReviewReminderIntent = {
    key: string;
    dedupeKey: string;
    projectId: string;
    kind: 'project-review';
    scheduledAt: Date;
};

export const REPEAT_REMINDER_INTERVAL_OPTIONS = [5, 10, 15, 30, 60] as const;
export const REPEAT_REMINDER_MAX_WINDOW_MINUTES = 120;
export const REPEAT_REMINDER_MAX_OCCURRENCES = 8;

const REPEAT_REMINDER_INTERVAL_SET: ReadonlySet<number> = new Set(REPEAT_REMINDER_INTERVAL_OPTIONS);


export function normalizeRepeatReminderMinutes(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    return REPEAT_REMINDER_INTERVAL_SET.has(value) ? value : undefined;
}

function getDueAdvanceReminderIntent(task: Task, now: Date, options: ScheduleOptions): TaskReminderIntent | null {
    if (isInactiveTask(task) || !shouldSendTaskReminderKind(task, 'due', options) || options.includeDueDate === false) return null;
    const lead = normalizeDueReminderLeadMinutes(task.dueReminderLeadMinutes);
    const due = resolveTaskReminderDate(task.dueDate, options.dateOnlyDueReminderTime);
    if (!lead || !due) return null;

    const scheduledAt = new Date(due);
    if (lead % 1440 === 0) scheduledAt.setDate(scheduledAt.getDate() - lead / 1440);
    else scheduledAt.setTime(scheduledAt.getTime() - lead * 60_000);
    if (!isAfter(scheduledAt, now)) return null;
    const key = `task:${task.id}:a${lead}:${scheduledAt.getTime()}`;
    return { key, dedupeKey: key, taskId: task.id, kind: 'due-advance', scheduledAt,
        ...(!hasTimeComponent(task.dueDate) ? { dateOnly: true } : {}) };
}

function getStartAdvanceReminderIntent(task: Task, now: Date, options: ScheduleOptions): TaskReminderIntent | null {
    const lead = normalizeStartReminderLeadMinutes(task.startReminderLeadMinutes);
    if (!lead || isInactiveTask(task) || !shouldSendTaskReminderKind(task, 'start', options) || options.includeStartTime === false) return null;
    const start = resolveTaskReminderDate(task.startTime, options.dateOnlyStartReminderTime);
    if (!start) return null;
    const scheduledAt = new Date(start.getTime() - lead * 60_000);
    if (!isAfter(scheduledAt, now)) return null;
    const key = `task:${task.id}:sa${lead}:${scheduledAt.getTime()}`;
    return { key, dedupeKey: key, taskId: task.id, kind: 'start-advance', scheduledAt,
        ...(!hasTimeComponent(task.startTime) ? { dateOnly: true } : {}) };
}

export function resolveTaskReminderDate(value: string | undefined | null, defaultTime?: string): Date | null {
    if (!value) return null;
    if (hasTimeComponent(value)) return parseExplicitReminderDate(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !defaultTime || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(defaultTime)) return null;
    const date = safeParseDate(value);
    if (!date) return null;
    const [hour, minute] = defaultTime.split(':').map(Number);
    date.setHours(hour, minute, 0, 0);
    return date;
}

function parseExplicitReminderDate(value: string | undefined | null): Date | null {
    if (!hasTimeComponent(value ?? undefined)) return null;
    return safeParseDate(value ?? undefined);
}

function isInactiveTask(task: Task): boolean {
    return Boolean(task.deletedAt) || !isTaskActionable(task);
}

function getNextTaskReminderIntent(
    task: Task,
    now: Date,
    options: ScheduleOptions,
): TaskReminderIntent | null {
    if (isInactiveTask(task)) return null;

    const candidates: TaskReminderIntent[] = [];
    const addCandidate = (
        kind: Exclude<TaskReminderIntentKind, 'due-repeat'>,
        value: string | undefined,
        enabled: boolean,
        defaultTime?: string,
    ) => {
        if (!enabled) return;
        const scheduledAt = kind === 'review'
            ? parseExplicitReminderDate(value)
            : resolveTaskReminderDate(value, defaultTime);
        if (!scheduledAt || !isAfter(scheduledAt, now)) return;
        candidates.push({
            key: `task:${task.id}`,
            dedupeKey: scheduledAt.toISOString(),
            taskId: task.id,
            kind,
            scheduledAt,
            ...(!hasTimeComponent(value) ? { dateOnly: true } : {}),
        });
    };

    addCandidate(
        'start',
        task.startTime,
        shouldSendTaskReminderKind(task, 'start', options) && options.includeStartTime !== false
            && !(isSingleTaskReminder(task) && normalizeStartReminderLeadMinutes(task.startReminderLeadMinutes)),
        options.dateOnlyStartReminderTime,
    );
    addCandidate(
        'due',
        task.dueDate,
        shouldSendTaskReminderKind(task, 'due', options) && options.includeDueDate !== false
            && !(isSingleTaskReminder(task) && normalizeDueReminderLeadMinutes(task.dueReminderLeadMinutes)),
        options.dateOnlyDueReminderTime,
    );
    addCandidate('review', task.reviewAt, options.includeReviewAt === true);

    candidates.sort((left, right) =>
        left.scheduledAt.getTime() - right.scheduledAt.getTime(),
    );
    return candidates[0] ?? null;
}


export function getNextScheduledAt(task: Task, now: Date = new Date(), options: ScheduleOptions = {}): Date | null {
    return getNextTaskReminderIntent(task, now, options)?.scheduledAt ?? null;
}


export function getDueReminderRepeatTimes(task: Task, options: ScheduleOptions = {}): Date[] {
    if (isInactiveTask(task)) return [];
    if (!shouldSendTaskReminders(task, options) || isSingleTaskReminder(task)) return [];
    if (options.includeDueDate === false) return [];

    const interval = normalizeRepeatReminderMinutes(task.repeatReminderMinutes);
    if (!interval) return [];

    const due = resolveTaskReminderDate(task.dueDate, options.dateOnlyDueReminderTime);
    if (!due) return [];

    const count = Math.min(
        REPEAT_REMINDER_MAX_OCCURRENCES,
        Math.floor(REPEAT_REMINDER_MAX_WINDOW_MINUTES / interval),
    );
    const times: Date[] = [];
    for (let i = 1; i <= count; i += 1) {
        times.push(new Date(due.getTime() + i * interval * 60_000));
    }
    return times;
}

const REMINDER_NOTIFICATION_TAG_PREFIX = 'mindwtr-reminder:';


export function getReminderNotificationTag(key: string): string {
    const base = key.startsWith('task:') ? key.replace(/:(?:r\d+|s?a\d+:-?\d+)$/, '') : key;
    return `${REMINDER_NOTIFICATION_TAG_PREFIX}${base}`;
}

export function getTaskReminderNotificationTag(taskId: string): string {
    return getReminderNotificationTag(`task:${taskId}`);
}

export function getTaskReminderPlan(
    task: Task,
    now: Date = new Date(),
    options: ScheduleOptions = {},
): TaskReminderPlan {
    const repeats = getDueReminderRepeatTimes(task, options).map(
        (scheduledAt, index): TaskReminderIntent => ({
            key: `task:${task.id}:r${index + 1}`,
            dedupeKey: `${hasTimeComponent(task.dueDate) ? task.dueDate : scheduledAt.toISOString()}#${index + 1}`,
            taskId: task.id,
            kind: 'due-repeat',
            scheduledAt,
            repeatIndex: index + 1,
            ...(!hasTimeComponent(task.dueDate) ? { dateOnly: true } : {}),
        }),
    );
    const next = getNextTaskReminderIntent(task, now, options);
    const advance = getDueAdvanceReminderIntent(task, now, options);
    const startAdvance = getStartAdvanceReminderIntent(task, now, options);
    if (!advance && !startAdvance) return { next, repeats, advance, startAdvance };

    const seen = new Set<number>();
    const unique = (intent: TaskReminderIntent | null): TaskReminderIntent | null => {
        if (!intent || seen.has(intent.scheduledAt.getTime())) return null;
        seen.add(intent.scheduledAt.getTime());
        return intent;
    };
    return {
        next: unique(next),
        repeats: repeats.filter((intent) => unique(intent) !== null),
        advance: unique(advance),
        startAdvance: unique(startAdvance),
    };
}

export function getProjectReviewReminderIntent(
    project: Project,
    now: Date = new Date(),
): ProjectReviewReminderIntent | null {
    if (project.deletedAt || project.status === 'archived') return null;
    const scheduledAt = parseExplicitReminderDate(project.reviewAt);
    if (!scheduledAt || !isAfter(scheduledAt, now)) return null;
    return {
        key: `project:${project.id}`,
        dedupeKey: scheduledAt.toISOString(),
        projectId: project.id,
        kind: 'project-review',
        scheduledAt,
    };
}

export function getUpcomingSchedules(tasks: Task[], now: Date = new Date(), options: ScheduleOptions = {}) {
    return tasks
        .map((task) => {
            const scheduledAt = getNextScheduledAt(task, now, options);
            return scheduledAt ? { task, scheduledAt } : null;
        })
        .filter(Boolean)
        .sort((a, b) => (a!.scheduledAt.getTime() - b!.scheduledAt.getTime()));
}

export function isDueWithinMinutes(task: Task, minutes: number, now: Date = new Date(), options: ScheduleOptions = {}): boolean {
    const next = getNextScheduledAt(task, now, options);
    if (!next) return false;
    const diffMs = next.getTime() - now.getTime();
    return diffMs >= 0 && diffMs <= minutes * 60 * 1000;
}

export function parseTimeOfDay(value: string | undefined, fallback: { hour: number; minute: number }) {
    if (!value) return fallback;
    const [h, m] = value.split(':');
    const hour = Number.parseInt(h, 10);
    const minute = Number.parseInt(m, 10);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return fallback;
    if (hour < 0 || hour > 23) return fallback;
    if (minute < 0 || minute > 59) return fallback;
    return { hour, minute };
}


export function areTaskRemindersEnabled(settings: NotificationSettings): boolean {
    return settings.notificationsEnabled !== false;
}

export function areStartDateRemindersEnabled(settings: NotificationSettings): boolean {
    return areTaskRemindersEnabled(settings) && settings.startDateNotificationsEnabled !== false;
}

export function areDueDateRemindersEnabled(settings: NotificationSettings): boolean {
    return areTaskRemindersEnabled(settings) && settings.dueDateNotificationsEnabled !== false;
}


export function isWeeklyReviewReminderEnabled(settings: NotificationSettings): boolean {
    return settings.weeklyReviewEnabled === true;
}


export function hasActiveMobileNotificationFeature(settings: NotificationSettings): boolean {
    return areTaskRemindersEnabled(settings)
        || settings.dailyDigestMorningEnabled === true
        || settings.dailyDigestEveningEnabled === true
        || isWeeklyReviewReminderEnabled(settings);
}


export type DigestTimeSlot = { enabled: boolean; hour: number; minute: number };
export type WeeklyReviewSlot = DigestTimeSlot & { day: number };

export type DigestSchedule = {
    morning: DigestTimeSlot;
    evening: DigestTimeSlot;
    weekly: WeeklyReviewSlot;
};

export function getDigestSchedule(settings: NotificationSettings): DigestSchedule {
    const weeklyDay = Number.isFinite(settings.weeklyReviewDay)
        ? Math.max(0, Math.min(6, Math.floor(settings.weeklyReviewDay as number)))
        : 0;
    return {
        morning: {
            enabled: settings.dailyDigestMorningEnabled === true,
            ...parseTimeOfDay(settings.dailyDigestMorningTime, { hour: 9, minute: 0 }),
        },
        evening: {
            enabled: settings.dailyDigestEveningEnabled === true,
            ...parseTimeOfDay(settings.dailyDigestEveningTime, { hour: 20, minute: 0 }),
        },
        weekly: {
            enabled: isWeeklyReviewReminderEnabled(settings),
            day: weeklyDay,
            ...parseTimeOfDay(settings.weeklyReviewTime, { hour: 18, minute: 0 }),
        },
    };
}

function nextDailyTime(hour: number, minute: number, now: Date): Date {
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next.getTime() <= now.getTime()) {
        next.setDate(next.getDate() + 1);
    }
    return next;
}

function nextWeeklyTime(dayOfWeekSundayFirst: number, hour: number, minute: number, now: Date): Date {
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);

    const current = next.getDay();
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


export function buildReminderNotificationBody(
    task: Task,
    kind: TaskReminderIntentKind,
    translations: Record<string, string>
): string {
    const reminderLabel = kind === 'start-advance'
        ? (translations['taskEdit.startAdvanceReminderLabel'] ?? 'Before start')
        : kind === 'due-advance'
        ? (translations['taskEdit.advanceReminderLabel'] ?? 'Advance reminder')
        : kind === 'start'
        ? (translations['settings.startDateNotifications'] ?? 'Start date reminder')
        : kind === 'due' || kind === 'due-repeat'
            ? (translations['settings.dueDateNotifications'] ?? 'Due date reminder')
            : kind === 'review'
                ? (translations['settings.reviewAtNotifications'] ?? 'Review date reminder')
                : (translations['settings.notifications'] ?? 'Task reminder');
    const description = stripMarkdown(task.description || '').trim();
    return description ? `${reminderLabel}\n${description}` : reminderLabel;
}


export type ReminderScheduleRequest = {
    key: string;
    title: string;
    message: string;
    fireAt: Date;
    repeatInterval?: 'daily' | 'weekly';
    hasSnoozeAction?: boolean;
    hasCompleteAction?: boolean;
    data: Record<string, string>;
};

export type ReminderScheduleDiagnostics = {
    taskRemindersEnabled: boolean;
    includeStartTime: boolean;
    includeDueDate: boolean;
    includeReviewAt: boolean;
    weeklyReviewEnabled: boolean;
    dateOnlyDueDateCount: number;
    futureDueDateReminderCount: number;
    pastDueDateReminderCount: number;
    dateOnlyStartTimeCount: number;
    futureStartTimeReminderCount: number;
    pastStartTimeReminderCount: number;
    futureTaskReviewReminderCount: number;
    pastTaskReviewReminderCount: number;
    suppressedTaskReminderCount: number;
    taskReminderCount: number;
    taskReviewReminderCount: number;
    projectReviewReminderCount: number;
    oneShotReminderCount: number;
};

export type ReminderScheduleInput = {
    settings: NotificationSettings;
    tasks: Task[];
    projects: Project[];

    now?: Date;
    translations: Record<string, string>;

    maxOneShotReminders?: number;


    deliveryWindowTo?: Date;
};

export type ReminderSchedule = {


    requests: ReminderScheduleRequest[];
    diagnostics: ReminderScheduleDiagnostics;
};


export function buildReminderSchedule(input: ReminderScheduleInput): ReminderSchedule {
    const { settings, tasks, projects, translations } = input;
    const now = input.now ?? new Date();
    const nowMs = now.getTime();
    const windowToMs = input.deliveryWindowTo?.getTime() ?? Infinity;


    const trackDiagnostics = input.deliveryWindowTo === undefined;

    const taskRemindersEnabled = areTaskRemindersEnabled(settings);
    const includeStartTime = areStartDateRemindersEnabled(settings);
    const includeDueDate = areDueDateRemindersEnabled(settings);
    const includeReviewAt = taskRemindersEnabled && settings.reviewAtNotificationsEnabled !== false;
    const digest = getDigestSchedule(settings);

    const requests: ReminderScheduleRequest[] = [];

    if (digest.morning.enabled) {
        requests.push({
            key: 'digest:morning',
            title: translations['digest.morningTitle'],
            message: translations['digest.morningBody'],
            fireAt: nextDailyTime(digest.morning.hour, digest.morning.minute, now),
            repeatInterval: 'daily',
            data: { kind: 'daily-digest' },
        });
    }

    if (digest.evening.enabled) {
        requests.push({
            key: 'digest:evening',
            title: translations['digest.eveningTitle'],
            message: translations['digest.eveningBody'],
            fireAt: nextDailyTime(digest.evening.hour, digest.evening.minute, now),
            repeatInterval: 'daily',
            data: { kind: 'daily-digest' },
        });
    }

    if (digest.weekly.enabled) {
        requests.push({
            key: 'digest:weekly-review',
            title: translations['digest.weeklyReviewTitle'],
            message: translations['digest.weeklyReviewBody'],
            fireAt: nextWeeklyTime(digest.weekly.day, digest.weekly.hour, digest.weekly.minute, now),
            repeatInterval: 'weekly',
            data: { kind: 'weekly-review' },
        });
    }

    const oneShot: ReminderScheduleRequest[] = [];
    let dateOnlyDueDateCount = 0;
    let futureDueDateReminderCount = 0;
    let pastDueDateReminderCount = 0;
    let dateOnlyStartTimeCount = 0;
    let futureStartTimeReminderCount = 0;
    let pastStartTimeReminderCount = 0;
    let futureTaskReviewReminderCount = 0;
    let pastTaskReviewReminderCount = 0;
    let suppressedTaskReminderCount = 0;
    let taskReminderCount = 0;
    let taskReviewReminderCount = 0;
    let projectReviewReminderCount = 0;

    if (taskRemindersEnabled) {
        for (const task of tasks) {


            if (!task.dueDate && !task.startTime && !task.reviewAt) continue;


            if (trackDiagnostics) {
                const suppressTaskReminders = !shouldSendTaskReminders(task, settings);
                const dueAt = resolveTaskReminderDate(task.dueDate, settings.dateOnlyDueReminderTime);
                const startAt = resolveTaskReminderDate(task.startTime, settings.dateOnlyStartReminderTime);
                const hasSuppressibleReminder = (includeDueDate && dueAt !== null)
                    || (includeStartTime && startAt !== null);
                if (suppressTaskReminders && hasSuppressibleReminder) {
                    suppressedTaskReminderCount += 1;
                }
                if (!suppressTaskReminders && includeDueDate && task.dueDate) {
                    if (!hasTimeComponent(task.dueDate)) dateOnlyDueDateCount += 1;
                    if (dueAt) {
                        if (dueAt.getTime() > nowMs) futureDueDateReminderCount += 1;
                        else pastDueDateReminderCount += 1;
                    }
                }
                if (!suppressTaskReminders && includeStartTime && task.startTime) {
                    if (!hasTimeComponent(task.startTime)) dateOnlyStartTimeCount += 1;
                    if (startAt) {
                        if (startAt.getTime() > nowMs) futureStartTimeReminderCount += 1;
                        else pastStartTimeReminderCount += 1;
                    }
                }
                if (includeReviewAt && task.reviewAt && hasTimeComponent(task.reviewAt)) {
                    const reviewAtMs = safeParseDate(task.reviewAt)?.getTime() ?? NaN;
                    if (Number.isFinite(reviewAtMs) && reviewAtMs > nowMs) futureTaskReviewReminderCount += 1;
                    else if (Number.isFinite(reviewAtMs)) pastTaskReviewReminderCount += 1;
                }
            }

            const plan = getTaskReminderPlan(task, now, { includeStartTime, includeDueDate, includeReviewAt,
                taskReminderDefault: settings.taskReminderDefault,
                dateOnlyStartReminderTime: settings.dateOnlyStartReminderTime,
                dateOnlyDueReminderTime: settings.dateOnlyDueReminderTime });


            for (const repeat of plan.repeats) {
                const repeatFireAtMs = repeat.scheduledAt.getTime();
                if (repeatFireAtMs <= nowMs || repeatFireAtMs > windowToMs) continue;
                oneShot.push({
                    key: repeat.key,
                    title: task.title,
                    message: buildReminderNotificationBody(task, 'due-repeat', translations),
                    fireAt: repeat.scheduledAt,
                    hasSnoozeAction: true,
                    hasCompleteAction: true,
                    data: { kind: 'task-reminder', taskId: task.id, ...(repeat.dateOnly ? { dateOnly: 'true', dateOnlyKind: 'due' } : {}) },
                });
            }

            for (const advance of [plan.advance, plan.startAdvance]) {
                if (!advance || advance.scheduledAt.getTime() > windowToMs) continue;
                oneShot.push({
                    key: advance.key,
                    title: task.title,
                    message: buildReminderNotificationBody(task, advance.kind, translations),
                    fireAt: advance.scheduledAt,
                    hasSnoozeAction: true,
                    hasCompleteAction: true,
                    data: { kind: advance.kind === 'start-advance' ? 'task-start-advance' : 'task-due-advance', taskId: task.id,
                        ...(advance.dateOnly ? { dateOnly: 'true', dateOnlyKind: advance.kind === 'start-advance' ? 'start' : 'due' } : {}),
                        ...(isSingleTaskReminder(task) ? { reminderSelection: getTaskReminderPolicy(task) } : {}) },
                });
            }

            const next = plan.next;
            const fireAtMs = next?.scheduledAt.getTime() ?? NaN;
            if (!next || fireAtMs <= nowMs || fireAtMs > windowToMs) continue;
            const isReview = next.kind === 'review';
            if (isReview) taskReviewReminderCount += 1;
            else taskReminderCount += 1;
            oneShot.push({
                key: next.key,
                title: task.title,
                message: buildReminderNotificationBody(task, next.kind, translations),
                fireAt: next.scheduledAt,
                hasSnoozeAction: true,
                hasCompleteAction: !isReview,
                data: { kind: isReview ? 'task-review' : 'task-reminder', taskId: task.id,
                    ...(next.dateOnly ? { dateOnly: 'true', dateOnlyKind: next.kind === 'start' ? 'start' : 'due' } : {}),
                    ...(!isReview && isSingleTaskReminder(task) ? { reminderSelection: getTaskReminderPolicy(task) } : {}) },
            });
        }
    }

    if (includeReviewAt) {
        const reviewLabel = translations['review.projectsStep'] ?? 'Review project';
        for (const project of projects) {
            const reminder = getProjectReviewReminderIntent(project, now);
            if (!reminder || reminder.scheduledAt.getTime() > windowToMs) continue;
            projectReviewReminderCount += 1;
            oneShot.push({
                key: reminder.key,
                title: project.title,
                message: reviewLabel,
                fireAt: reminder.scheduledAt,
                data: { kind: 'project-review', projectId: project.id },
            });
        }
    }

    oneShot.sort((left, right) => left.fireAt.getTime() - right.fireAt.getTime());
    const cap = input.maxOneShotReminders ?? Infinity;
    requests.push(...oneShot.slice(0, cap));

    return {
        requests,
        diagnostics: {
            taskRemindersEnabled,
            includeStartTime,
            includeDueDate,
            includeReviewAt,
            weeklyReviewEnabled: digest.weekly.enabled,
            dateOnlyDueDateCount,
            futureDueDateReminderCount,
            pastDueDateReminderCount,
            dateOnlyStartTimeCount,
            futureStartTimeReminderCount,
            pastStartTimeReminderCount,
            futureTaskReviewReminderCount,
            pastTaskReviewReminderCount,
            suppressedTaskReminderCount,
            taskReminderCount,
            taskReviewReminderCount,
            projectReviewReminderCount,
            oneShotReminderCount: oneShot.length,
        },
    };
}


export type ReminderDeliveryWindow = {

    from: Date;

    to: Date;
};


export function resolveDueReminders(
    input: Omit<ReminderScheduleInput, 'now'>,
    window: ReminderDeliveryWindow,
): ReminderScheduleRequest[] {


    const { requests } = buildReminderSchedule({ ...input, now: window.from, deliveryWindowTo: window.to });
    return requests.filter((request) => (
        !request.repeatInterval
        && (!request.data.taskId || request.key === `task:${request.data.taskId}` || request.data.kind === 'task-due-advance' || request.data.kind === 'task-start-advance')
    ));
}
