import { addDays, addMonths, addWeeks, differenceInCalendarDays, format } from 'date-fns';

import { safeFormatDate, safeParseDate } from './date';
import { generateUUID as uuidv4 } from './uuid';
import { computeRelativeStartTime } from './task-relative-start';
import { isTaskActionable } from './task-status';
import type { Recurrence, RecurrenceByDay, RecurrenceRule, RecurrenceStrategy, RecurrenceWeekday, Task, TaskStatus, ChecklistItem, Attachment } from './types';

export const RECURRENCE_RULES: RecurrenceRule[] = ['daily', 'weekly', 'monthly', 'yearly'];
export const RECURRENCE_INTERVAL_MAX = 999;

const RRULE_SERIES_ID_KEY = 'X-MINDWTR-SERIES-ID';
const WEEKDAY_ORDER: RecurrenceWeekday[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

export function isRecurrenceRule(value: string | undefined | null): value is RecurrenceRule {
    return !!value && (RECURRENCE_RULES as readonly string[]).includes(value);
}

const RRULE_FREQ_MAP: Record<string, RecurrenceRule> = {
    DAILY: 'daily',
    WEEKLY: 'weekly',
    MONTHLY: 'monthly',
    YEARLY: 'yearly',
};

type ParsedRRule = {
    rule?: RecurrenceRule;
    byDay?: RecurrenceByDay[];
    byMonthDay?: number[];
    interval?: number;
    weekStart?: RecurrenceWeekday;
    count?: number;
    until?: string;
};

type BuildRRuleOptions = {
    byMonthDay?: number[];
    weekStart?: RecurrenceWeekday;
    count?: number;
    until?: string;
};

type FormatRecurrenceLabelOptions = {
    recurrence: Task['recurrence'];
    t: (key: string) => string;
    formatDate?: (value: string) => string;
};

const getSeriesIdFromRRule = (rrule: string | undefined): string | undefined => {
    if (!rrule) return undefined;
    const token = rrule.split(';').find((part) => (
        part.slice(0, part.indexOf('=')).trim().toUpperCase() === RRULE_SERIES_ID_KEY
    ));
    if (!token) return undefined;
    const raw = token.slice(token.indexOf('=') + 1).trim();
    if (!raw) return undefined;
    try {
        return decodeURIComponent(raw).trim() || undefined;
    } catch {
        return raw;
    }
};

const withSeriesIdInRRule = (rrule: string, seriesId: string): string => {
    const parts = rrule.split(';').filter((part) => (
        part.slice(0, part.indexOf('=')).trim().toUpperCase() !== RRULE_SERIES_ID_KEY
    ));
    parts.push(`${RRULE_SERIES_ID_KEY}=${encodeURIComponent(seriesId)}`);
    return parts.join(';');
};

export type ProjectedRecurringTask = Task & {
    isProjectedRecurringTask: true;
    sourceTaskId: string;
};

const PROJECTED_RECURRENCE_ID_SUFFIX = ':projected-recurrence';

export const getProjectedRecurringTaskId = (taskId: string): string => (
    `${taskId}${PROJECTED_RECURRENCE_ID_SUFFIX}`
);

// Range expansion needs one synthetic id per occurrence (`<id>:projected-recurrence:<anchor-iso>`)
// instead of the single-projection suffix above. `isProjectedRecurringTaskId` matches both forms
// via substring rather than `endsWith` so it keeps recognizing every synthetic id calendar-push-run
// still mints with the old suffix-only scheme.
const getRangeProjectedRecurringTaskId = (taskId: string, occurrenceIso: string): string => (
    `${taskId}${PROJECTED_RECURRENCE_ID_SUFFIX}:${occurrenceIso}`
);

export const isProjectedRecurringTaskId = (taskId: string | undefined | null): boolean => (
    typeof taskId === 'string' && taskId.includes(PROJECTED_RECURRENCE_ID_SUFFIX)
);

export const isProjectedRecurringTask = (task: Partial<Task> | null | undefined): task is ProjectedRecurringTask => (
    Boolean(
        task
        && (task as Partial<ProjectedRecurringTask>).isProjectedRecurringTask === true
        && typeof (task as Partial<ProjectedRecurringTask>).sourceTaskId === 'string'
    )
);

export const getTaskCalendarOccurrenceDate = (task: Pick<Task, 'startTime' | 'dueDate'>): string | undefined => (
    task.startTime ?? task.dueDate
);

const parseByDayToken = (token: string): RecurrenceByDay | null => {
    const trimmed = token.toUpperCase().trim();
    if (!trimmed) return null;
    const match = trimmed.match(/^(-1|1|2|3|4)?(SU|MO|TU|WE|TH|FR|SA)$/);
    if (!match) return null;
    const ordinal = match[1];
    const weekday = match[2] as RecurrenceWeekday;
    if (ordinal) {
        return `${ordinal}${weekday}` as RecurrenceByDay;
    }
    return weekday;
};

const normalizeWeekdays = (days?: string[] | null): RecurrenceByDay[] | undefined => {
    if (!days || days.length === 0) return undefined;
    const normalized = days
        .map(parseByDayToken)
        .filter((day): day is RecurrenceByDay => Boolean(day));
    return normalized.length > 0 ? Array.from(new Set(normalized)) : undefined;
};

const normalizeWeekStart = (value?: string | null): RecurrenceWeekday | undefined => {
    const parsed = parseByDayToken(String(value || ''));
    return parsed && WEEKDAY_ORDER.includes(parsed as RecurrenceWeekday)
        ? parsed as RecurrenceWeekday
        : undefined;
};

const normalizeMonthDays = (days?: string[] | null): number[] | undefined => {
    if (!days || days.length === 0) return undefined;
    const normalized = days
        .map((day) => Number(day))
        // -1 is RFC 5545's "last day of the month" (BYMONTHDAY=-1) — the only
        // negative ordinal supported; deeper counts from the end stay rejected
        // until someone actually asks for them.
        .filter((day) => Number.isFinite(day) && ((day >= 1 && day <= 31) || day === -1));
    const unique = Array.from(new Set(normalized)).sort((a, b) => a - b);
    return unique.length > 0 ? unique : undefined;
};

const normalizeAnchorDay = (value: unknown): number | undefined => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    const day = Math.floor(value);
    return day >= 1 && day <= 31 ? day : undefined;
};

const parseUntilToken = (value: string | undefined): string | undefined => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return undefined;
    const dateOnlyMatch = /^(\d{4})(\d{2})(\d{2})$/.exec(trimmed);
    if (dateOnlyMatch) {
        const [, year, month, day] = dateOnlyMatch;
        return `${year}-${month}-${day}`;
    }

    const dateTimeMatch = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/i.exec(trimmed);
    if (!dateTimeMatch) return undefined;

    const [, year, month, day, hour, minute, second = '00', isUtc] = dateTimeMatch;
    const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}${isUtc ? 'Z' : ''}`;
    const parsed = safeParseDate(iso);
    if (!parsed) return undefined;
    return isUtc ? parsed.toISOString() : format(parsed, "yyyy-MM-dd'T'HH:mm:ss");
};

const formatUntilToken = (until: string | undefined): string | undefined => {
    const trimmed = String(until || '').trim();
    if (!trimmed) return undefined;
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        return trimmed.replace(/-/g, '');
    }
    const parsed = safeParseDate(trimmed);
    if (!parsed) return undefined;
    const year = String(parsed.getUTCFullYear()).padStart(4, '0');
    const month = String(parsed.getUTCMonth() + 1).padStart(2, '0');
    const day = String(parsed.getUTCDate()).padStart(2, '0');
    const hour = String(parsed.getUTCHours()).padStart(2, '0');
    const minute = String(parsed.getUTCMinutes()).padStart(2, '0');
    const second = String(parsed.getUTCSeconds()).padStart(2, '0');
    return `${year}${month}${day}T${hour}${minute}${second}Z`;
};

export function parseRRuleString(rrule: string): ParsedRRule {
    if (!rrule) return {};
    const tokens = rrule.split(';').reduce<Record<string, string>>((acc, part) => {
        const [key, value] = part.split('=');
        if (key && value) acc[key.toUpperCase()] = value;
        return acc;
    }, {});
    const freq = tokens.FREQ ? RRULE_FREQ_MAP[tokens.FREQ.toUpperCase()] : undefined;
    const byDay = tokens.BYDAY ? normalizeWeekdays(tokens.BYDAY.split(',')) : undefined;
    const byMonthDay = tokens.BYMONTHDAY ? normalizeMonthDays(tokens.BYMONTHDAY.split(',')) : undefined;
    const interval = tokens.INTERVAL ? Number(tokens.INTERVAL) : undefined;
    const weekStart = normalizeWeekStart(tokens.WKST);
    const count = tokens.COUNT ? Number(tokens.COUNT) : undefined;
    const until = parseUntilToken(tokens.UNTIL);
    return {
        rule: freq,
        byDay,
        byMonthDay,
        interval: interval && interval > 0 ? interval : undefined,
        weekStart,
        count: count && count > 0 ? Math.round(count) : undefined,
        until,
    };
}

export function normalizeRecurrenceForLoad(value: unknown): Recurrence | undefined {
    if (!value) return undefined;

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return undefined;
        if (isRecurrenceRule(trimmed)) return { rule: trimmed };
        const parsed = parseRRuleString(trimmed);
        return parsed.rule
            ? {
                rule: parsed.rule,
                ...(parsed.byDay ? { byDay: parsed.byDay } : {}),
                ...(parsed.byMonthDay ? { byMonthDay: parsed.byMonthDay } : {}),
                ...(parsed.weekStart ? { weekStart: parsed.weekStart } : {}),
                ...(parsed.count ? { count: parsed.count } : {}),
                ...(parsed.until ? { until: parsed.until } : {}),
                rrule: trimmed,
            }
            : undefined;
    }

    if (typeof value !== 'object' || Array.isArray(value)) return undefined;

    const recurrence = value as Partial<Recurrence>;
    const rrule = typeof recurrence.rrule === 'string' && recurrence.rrule.trim().length > 0
        ? recurrence.rrule.trim()
        : undefined;
    const parsed = rrule ? parseRRuleString(rrule) : {};
    const rule = isRecurrenceRule(recurrence.rule) ? recurrence.rule : parsed.rule;
    if (!rule) return undefined;

    const explicitSeriesId = typeof recurrence.seriesId === 'string' && recurrence.seriesId.trim().length > 0
        ? recurrence.seriesId.trim()
        : undefined;
    const seriesId = explicitSeriesId ?? getSeriesIdFromRRule(rrule);
    const strategy = recurrence.strategy === 'fluid' || recurrence.strategy === 'strict'
        ? recurrence.strategy
        : undefined;
    const explicitByDay = Array.isArray(recurrence.byDay)
        ? normalizeWeekdays(recurrence.byDay)
        : undefined;
    const byDay = explicitByDay ?? parsed.byDay;
    const explicitByMonthDay = Array.isArray(recurrence.byMonthDay)
        ? normalizeMonthDays(recurrence.byMonthDay.map(String))
        : undefined;
    const byMonthDay = explicitByMonthDay ?? parsed.byMonthDay;
    const weekStart = normalizeWeekStart(recurrence.weekStart) ?? parsed.weekStart;
    const count = typeof recurrence.count === 'number' && Number.isFinite(recurrence.count) && recurrence.count > 0
        ? Math.round(recurrence.count)
        : parsed.count;
    const until = typeof recurrence.until === 'string' && recurrence.until.trim().length > 0
        ? recurrence.until
        : parsed.until;
    const completedOccurrences =
        typeof recurrence.completedOccurrences === 'number'
        && Number.isFinite(recurrence.completedOccurrences)
        && recurrence.completedOccurrences >= 0
            ? Math.floor(recurrence.completedOccurrences)
            : undefined;
    const anchorDay = normalizeAnchorDay(recurrence.anchorDay);
    const startAnchorDay = normalizeAnchorDay(recurrence.startAnchorDay);
    const dueAnchorDay = normalizeAnchorDay(recurrence.dueAnchorDay);
    const reviewAnchorDay = normalizeAnchorDay(recurrence.reviewAnchorDay);
    const compatibleRRule = seriesId
        ? withSeriesIdInRRule(
            rrule ?? buildRRuleString(rule, byDay, parsed.interval, {
                byMonthDay,
                weekStart,
                count,
                until,
            }),
            seriesId,
        )
        : rrule;

    return {
        rule,
        ...(seriesId ? { seriesId } : {}),
        ...(strategy ? { strategy } : {}),
        ...(byDay ? { byDay } : {}),
        ...(byMonthDay ? { byMonthDay } : {}),
        ...(weekStart ? { weekStart } : {}),
        ...(count ? { count } : {}),
        ...(until ? { until } : {}),
        ...(completedOccurrences !== undefined ? { completedOccurrences } : {}),
        ...(anchorDay ? { anchorDay } : {}),
        ...(startAnchorDay ? { startAnchorDay } : {}),
        ...(dueAnchorDay ? { dueAnchorDay } : {}),
        ...(reviewAnchorDay ? { reviewAnchorDay } : {}),
        ...(compatibleRRule ? { rrule: compatibleRRule } : {}),
    };
}

const normalizeWeeklyByDay = (days?: RecurrenceByDay[] | null): RecurrenceWeekday[] | undefined => {
    const normalized = normalizeWeekdays(days as string[] | null);
    if (!normalized) return undefined;
    const weekly = normalized.filter((day) => WEEKDAY_ORDER.includes(day as RecurrenceWeekday)) as RecurrenceWeekday[];
    return weekly.length > 0 ? Array.from(new Set(weekly)) : undefined;
};

export function buildRRuleString(
    rule: RecurrenceRule,
    byDay?: RecurrenceByDay[],
    interval?: number,
    options: BuildRRuleOptions = {}
): string {
    const parts = [`FREQ=${rule.toUpperCase()}`];
    if (interval && interval > 1) {
        parts.push(`INTERVAL=${interval}`);
    }
    const normalizedDays = normalizeWeekdays(byDay as string[] | null);
    if (normalizedDays && normalizedDays.length > 0) {
        if (rule === 'weekly') {
            const weeklyDays = normalizeWeeklyByDay(normalizedDays);
            if (weeklyDays && weeklyDays.length > 0) {
                const ordered = WEEKDAY_ORDER.filter((day) => weeklyDays.includes(day));
                parts.push(`BYDAY=${ordered.join(',')}`);
            }
        } else if (rule === 'monthly') {
            const ordered = normalizedDays
                .filter(Boolean)
                .sort((a, b) => String(a).localeCompare(String(b)));
            parts.push(`BYDAY=${ordered.join(',')}`);
        }
    } else if (rule === 'monthly') {
        const normalizedMonthDays = normalizeMonthDays((options.byMonthDay || []).map(String));
        if (normalizedMonthDays && normalizedMonthDays.length > 0) {
            parts.push(`BYMONTHDAY=${normalizedMonthDays.join(',')}`);
        }
    }
    if (options.count && options.count > 0) {
        parts.push(`COUNT=${Math.round(options.count)}`);
    }
    const weekStart = normalizeWeekStart(options.weekStart);
    if (rule === 'weekly' && weekStart) {
        parts.push(`WKST=${weekStart}`);
    }
    const untilToken = formatUntilToken(options.until);
    if (untilToken) {
        parts.push(`UNTIL=${untilToken}`);
    }
    return parts.join(';');
}

export function hasRecurrenceRule(value: Task['recurrence']): boolean {
    return getRecurrenceRule(value) !== null;
}

function getRecurrenceRule(value: Task['recurrence']): RecurrenceRule | null {
    if (!value) return null;
    if (typeof value === 'string') {
        return isRecurrenceRule(value) ? value : null;
    }
    if (typeof value === 'object') {
        const rule = (value as Recurrence).rule;
        if (isRecurrenceRule(rule)) return rule;
        if ((value as Recurrence).rrule) {
            const parsed = parseRRuleString((value as Recurrence).rrule || '');
            if (parsed.rule) return parsed.rule;
        }
    }
    return null;
}

function getRecurrenceStrategy(value: Task['recurrence']): RecurrenceStrategy {
    if (value && typeof value === 'object' && value.strategy === 'fluid') {
        return 'fluid';
    }
    return 'strict';
}

function getRecurrenceByDay(value: Task['recurrence']): RecurrenceByDay[] | undefined {
    if (!value || typeof value === 'string') return undefined;
    const recurrence = value as Recurrence;
    const explicit = normalizeWeekdays(recurrence.byDay);
    if (explicit && explicit.length > 0) return explicit;
    if (recurrence.rrule) {
        const parsed = parseRRuleString(recurrence.rrule);
        return parsed.byDay;
    }
    return undefined;
}

function getRecurrenceByMonthDay(value: Task['recurrence']): number[] | undefined {
    if (!value || typeof value === 'string') return undefined;
    const recurrence = value as Recurrence;
    const explicit = Array.isArray(recurrence.byMonthDay)
        ? normalizeMonthDays(recurrence.byMonthDay.map(String))
        : undefined;
    if (explicit && explicit.length > 0) return explicit;
    if (recurrence.rrule) {
        const parsed = parseRRuleString(recurrence.rrule);
        return parsed.byMonthDay;
    }
    return undefined;
}

function getRecurrenceInterval(value: Task['recurrence']): number {
    if (!value || typeof value === 'string') return 1;
    const recurrence = value as Recurrence;
    if (recurrence.rrule) {
        const parsed = parseRRuleString(recurrence.rrule);
        if (parsed.interval && parsed.interval > 0) return parsed.interval;
    }
    return 1;
}

function getRecurrenceWeekStart(value: Task['recurrence']): RecurrenceWeekday | undefined {
    if (!value || typeof value === 'string') return undefined;
    const recurrence = value as Recurrence;
    const explicit = normalizeWeekStart(recurrence.weekStart);
    if (explicit) return explicit;
    if (recurrence.rrule) {
        return parseRRuleString(recurrence.rrule).weekStart;
    }
    return undefined;
}

export function getRecurrenceCountValue(value: Task['recurrence']): number | undefined {
    if (!value || typeof value === 'string') return undefined;
    const recurrence = value as Recurrence;
    if (typeof recurrence.count === 'number' && recurrence.count > 0) {
        return Math.round(recurrence.count);
    }
    if (recurrence.rrule) {
        const parsed = parseRRuleString(recurrence.rrule);
        if (parsed.count && parsed.count > 0) return parsed.count;
    }
    return undefined;
}

export function getRecurrenceUntilValue(value: Task['recurrence']): string | undefined {
    if (!value || typeof value === 'string') return undefined;
    const recurrence = value as Recurrence;
    if (recurrence.until) return recurrence.until;
    if (recurrence.rrule) {
        return parseRRuleString(recurrence.rrule).until;
    }
    return undefined;
}

export function getRecurrenceCompletedOccurrencesValue(value: Task['recurrence']): number | undefined {
    if (!value || typeof value === 'string') return undefined;
    const recurrence = value as Recurrence;
    if (typeof recurrence.completedOccurrences !== 'number' || recurrence.completedOccurrences < 0) {
        return undefined;
    }
    return Math.floor(recurrence.completedOccurrences);
}

/**
 * "After 10 occurrence(s)", or "After 6 of 10 occurrence(s)" once the series has
 * progress worth showing. Zero completions stay on the plain form so a freshly
 * created series carries no "0 of 10" noise.
 */
export function formatRecurrenceCountLabel(
    count: number,
    completedOccurrences: number | undefined,
    t: (key: string) => string
): string {
    const progress = completedOccurrences && completedOccurrences > 0
        ? `${completedOccurrences} ${t('recurrence.occurrenceProgressOf')} `
        : '';
    return `${t('recurrence.endsAfterCount')} ${progress}${count} ${t('recurrence.occurrenceUnit')}`;
}

export function formatRecurrenceLabel({ recurrence, t, formatDate }: FormatRecurrenceLabelOptions): string {
    const rule = getRecurrenceRule(recurrence);
    if (!rule) return '';

    const strategy = getRecurrenceStrategy(recurrence);
    const interval = getRecurrenceInterval(recurrence);
    const until = getRecurrenceUntilValue(recurrence);
    const count = getRecurrenceCountValue(recurrence);
    const completed = getRecurrenceCompletedOccurrencesValue(recurrence);
    const unitKey = rule === 'daily'
        ? 'recurrence.dayUnit'
        : rule === 'weekly'
            ? 'recurrence.weekUnit'
            : rule === 'monthly'
                ? 'recurrence.monthUnit'
                : rule === 'yearly'
                    ? 'recurrence.yearUnit'
                    : undefined;

    return [
        `${t(`recurrence.${rule}`) || rule}${strategy === 'fluid' ? ` · ${t('recurrence.afterCompletionShort')}` : ''}`,
        unitKey && interval > 1
            ? `${t('recurrence.repeatEvery')} ${interval} ${t(unitKey)}`
            : undefined,
        until ? `${t('recurrence.endsOnDate')} ${(formatDate ?? ((value: string) => safeFormatDate(value, 'P')))(until)}` : undefined,
        count ? formatRecurrenceCountLabel(count, completed, t) : undefined,
    ].filter(Boolean).join(' · ');
}

function getRecurrenceFieldAnchorDay(
    value: Task['recurrence'],
    field: 'startTime' | 'dueDate' | 'reviewAt'
): number | undefined {
    if (!value || typeof value === 'string') return undefined;
    const recurrence = value as Recurrence;
    const fieldAnchor = field === 'startTime'
        ? recurrence.startAnchorDay
        : field === 'dueDate'
            ? recurrence.dueAnchorDay
            : recurrence.reviewAnchorDay;
    return normalizeAnchorDay(fieldAnchor);
}

const getDateDay = (value: string | undefined): number | undefined => {
    const parsed = safeParseDate(value);
    return parsed ? parsed.getDate() : undefined;
};

type RecurrenceScheduleDates = Pick<Task, 'startTime' | 'dueDate' | 'reviewAt'>;
type RecurrenceScheduleField = keyof RecurrenceScheduleDates;

const getRecurrenceScheduleAnchorField = (
    dates: RecurrenceScheduleDates,
): RecurrenceScheduleField | null => (
    (['dueDate', 'startTime', 'reviewAt'] as const).find((field) => Boolean(dates[field])) ?? null
);

/**
 * Per-field anchor days with the legacy single `anchorDay` credited ONLY to
 * the field it was derived from (due, else start, else review — the same
 * order that writes it). A recurrence saved before per-field anchors existed
 * carries just `anchorDay` from its due day; letting that number anchor the
 * OTHER fields advanced a start of the 14th as a day-15 rule, so completing
 * "start 14th / due 15th, monthly" produced start Aug 15 instead of Sep 14.
 * The owner keeps the global anchor over its own date's day on purpose: the
 * stored date may be a clamped 31st sitting on Feb 28, and the anchor is what
 * returns it to the 31st.
 */
function resolveRecurrenceFieldAnchorDays(
    recurrence: Task['recurrence'],
    dates: RecurrenceScheduleDates,
): { startTime?: number; dueDate?: number; reviewAt?: number } {
    const globalAnchor = normalizeAnchorDay(
        recurrence && typeof recurrence === 'object' ? (recurrence as Recurrence).anchorDay : undefined
    );
    const ownerField: 'startTime' | 'dueDate' | 'reviewAt' | null = dates.dueDate
        ? 'dueDate'
        : dates.startTime
            ? 'startTime'
            : dates.reviewAt
                ? 'reviewAt'
                : null;
    const resolve = (field: 'startTime' | 'dueDate' | 'reviewAt'): number | undefined => (
        getRecurrenceFieldAnchorDay(recurrence, field)
            ?? (field === ownerField ? globalAnchor : undefined)
            ?? getDateDay(dates[field])
    );
    return {
        startTime: resolve('startTime'),
        dueDate: resolve('dueDate'),
        reviewAt: resolve('reviewAt'),
    };
}

function getNextRecurrenceAnchorDays(task: Task, rule: RecurrenceRule) {
    if (rule !== 'monthly' && rule !== 'yearly') return {};

    const {
        startTime: startAnchorDay,
        dueDate: dueAnchorDay,
        reviewAt: reviewAnchorDay,
    } = resolveRecurrenceFieldAnchorDays(task.recurrence, task);
    const anchorDay = normalizeAnchorDay(
        typeof task.recurrence === 'object' ? task.recurrence.anchorDay : undefined
    ) ?? dueAnchorDay ?? startAnchorDay ?? reviewAnchorDay;

    return {
        ...(anchorDay ? { anchorDay } : {}),
        ...(startAnchorDay ? { startAnchorDay } : {}),
        ...(dueAnchorDay ? { dueAnchorDay } : {}),
        ...(reviewAnchorDay ? { reviewAnchorDay } : {}),
    };
}

function addInterval(base: Date, rule: RecurrenceRule, interval: number = 1, anchorDay?: number): Date {
    switch (rule) {
        case 'daily':
            return addDays(base, interval);
        case 'weekly':
            return addWeeks(base, interval);
        case 'monthly':
            return addMonthsClamped(base, interval, anchorDay);
        case 'yearly':
            return addYearsClamped(base, interval, anchorDay);
    }
}

const weekdayIndex = (weekday: RecurrenceWeekday): number => WEEKDAY_ORDER.indexOf(weekday);

const getLastDayOfMonth = (year: number, month: number): number => {
    return new Date(year, month + 1, 0).getDate();
};

const buildDateWithTime = (year: number, month: number, day: number, base: Date): Date => {
    return new Date(
        year,
        month,
        day,
        base.getHours(),
        base.getMinutes(),
        base.getSeconds(),
        base.getMilliseconds()
    );
};

const addMonthsClamped = (base: Date, interval: number, anchorDay?: number): Date => {
    const seed = new Date(
        base.getFullYear(),
        base.getMonth() + interval,
        1,
        base.getHours(),
        base.getMinutes(),
        base.getSeconds(),
        base.getMilliseconds()
    );
    const year = seed.getFullYear();
    const month = seed.getMonth();
    const lastDay = getLastDayOfMonth(year, month);
    const day = Math.min(anchorDay ?? base.getDate(), lastDay);
    return buildDateWithTime(year, month, day, base);
};

const addYearsClamped = (base: Date, interval: number, anchorDay?: number): Date => {
    const year = base.getFullYear() + interval;
    const month = base.getMonth();
    const lastDay = getLastDayOfMonth(year, month);
    const day = Math.min(anchorDay ?? base.getDate(), lastDay);
    return buildDateWithTime(year, month, day, base);
};

const orderWeekdaysByWeekStart = (weekStart: RecurrenceWeekday): RecurrenceWeekday[] => {
    const startIndex = WEEKDAY_ORDER.indexOf(weekStart);
    if (startIndex < 0) return WEEKDAY_ORDER;
    return [...WEEKDAY_ORDER.slice(startIndex), ...WEEKDAY_ORDER.slice(0, startIndex)];
};

function nextWeeklyByDay(
    base: Date,
    byDay: RecurrenceByDay[],
    interval: number = 1,
    weekStart: RecurrenceWeekday = 'MO'
): Date {
    const normalizedDays = normalizeWeeklyByDay(byDay);
    if (!normalizedDays || normalizedDays.length === 0) {
        return addWeeks(base, interval);
    }
    const safeInterval = interval > 0 ? interval : 1;
    const normalizedWeekStart = normalizeWeekStart(weekStart) ?? 'MO';
    const orderedDays = orderWeekdaysByWeekStart(normalizedWeekStart).filter((day) => normalizedDays.includes(day));
    const weekStartIndex = weekdayIndex(normalizedWeekStart);
    const anchorWeekStart = new Date(base);
    anchorWeekStart.setDate(base.getDate() - ((base.getDay() - weekStartIndex + 7) % 7));

    for (let weekOffset = 0; weekOffset <= safeInterval * 52; weekOffset += safeInterval) {
        const candidateWeekStart = addWeeks(anchorWeekStart, weekOffset);
        for (const weekday of orderedDays) {
            const dayOffset = (weekdayIndex(weekday) - weekStartIndex + 7) % 7;
            const candidate = addDays(candidateWeekStart, dayOffset);
            if (weekOffset === 0 && candidate <= base) continue;
            return candidate;
        }
    }
    return addWeeks(base, safeInterval);
}

const getNthWeekdayOfMonth = (year: number, month: number, weekday: RecurrenceWeekday, ordinal: number): Date | null => {
    if (ordinal === 0) return null;
    if (ordinal > 0) {
        const firstOfMonth = new Date(year, month, 1);
        const firstWeekday = firstOfMonth.getDay();
        const targetWeekday = weekdayIndex(weekday);
        const offset = (targetWeekday - firstWeekday + 7) % 7;
        const day = 1 + offset + (ordinal - 1) * 7;
        const candidate = new Date(year, month, day);
        return candidate.getMonth() === month ? candidate : null;
    }
    // ordinal < 0 => from end of month
    const lastOfMonth = new Date(year, month + 1, 0);
    const lastWeekday = lastOfMonth.getDay();
    const targetWeekday = weekdayIndex(weekday);
    const offset = (lastWeekday - targetWeekday + 7) % 7;
    const day = lastOfMonth.getDate() - offset;
    const candidate = new Date(year, month, day);
    return candidate.getMonth() === month ? candidate : null;
};

const parseOrdinalByDay = (token: RecurrenceByDay): { weekday: RecurrenceWeekday; ordinal?: number } | null => {
    const match = String(token).match(/^(-?\d)?(SU|MO|TU|WE|TH|FR|SA)$/);
    if (!match) return null;
    const ordinal = match[1] ? Number(match[1]) : undefined;
    const weekday = match[2] as RecurrenceWeekday;
    return { weekday, ordinal };
};

function nextMonthlyByDay(base: Date, byDay: RecurrenceByDay[], interval: number = 1): Date {
    const normalized = normalizeWeekdays(byDay as string[] | null);
    if (!normalized || normalized.length === 0) {
        return addMonths(base, interval);
    }
    const candidates = normalized
        .map(parseOrdinalByDay)
        .filter((item): item is { weekday: RecurrenceWeekday; ordinal?: number } => Boolean(item));
    const safeInterval = interval > 0 ? interval : 1;
    for (let offset = 0; offset <= safeInterval * 12; offset += safeInterval) {
        const monthDate = addMonths(base, offset);
        const year = monthDate.getFullYear();
        const month = monthDate.getMonth();
        const monthCandidates: Date[] = [];
        candidates.forEach((candidate) => {
            if (typeof candidate.ordinal === 'number') {
                const result = getNthWeekdayOfMonth(year, month, candidate.weekday, candidate.ordinal);
                if (result) {
                    monthCandidates.push(buildDateWithTime(
                        result.getFullYear(),
                        result.getMonth(),
                        result.getDate(),
                        base
                    ));
                }
                return;
            }

            const targetWeekday = weekdayIndex(candidate.weekday);
            for (let day = 1; day <= getLastDayOfMonth(year, month); day += 1) {
                const result = buildDateWithTime(year, month, day, base);
                if (result.getDay() === targetWeekday) {
                    monthCandidates.push(result);
                }
            }
        });
        const filtered = monthCandidates
            .filter((date) => (offset === 0 ? date > base : true))
            .sort((a, b) => a.getTime() - b.getTime());
        if (filtered.length > 0) {
            return filtered[0];
        }
    }
    return addMonths(base, safeInterval);
}

function nextMonthlyByMonthDay(base: Date, byMonthDay: number[], interval: number = 1): Date {
    const normalized = normalizeMonthDays(byMonthDay.map(String));
    if (!normalized || normalized.length === 0) {
        return addMonths(base, interval);
    }
    const safeInterval = interval > 0 ? interval : 1;
    for (let offset = 0; offset <= safeInterval * 12; offset += safeInterval) {
        const monthDate = addMonths(base, offset);
        const year = monthDate.getFullYear();
        const month = monthDate.getMonth();
        const candidates = normalized.map((day) => new Date(
            year,
            // -1 = last day of this month, via day 0 of the following month.
            day === -1 ? month + 1 : month,
            day === -1 ? 0 : day,
            base.getHours(),
            base.getMinutes(),
            base.getSeconds(),
            base.getMilliseconds()
        ));
        const filtered = candidates
            .filter((date) => date.getMonth() === month)
            .filter((date) => (offset === 0 ? date > base : true))
            .sort((a, b) => a.getTime() - b.getTime());
        if (filtered.length > 0) return filtered[0];
    }
    return addMonths(base, safeInterval);
}

function nextIsoFrom(
    baseIso: string | undefined,
    rule: RecurrenceRule,
    fallbackBase: Date,
    byDay?: RecurrenceByDay[],
    interval: number = 1,
    byMonthDay?: number[],
    weekStart?: RecurrenceWeekday,
    searchBase?: Date,
    anchorDay?: number
): string | undefined {
    const parsed = safeParseDate(baseIso);
    const formatBase = parsed || fallbackBase;
    const base = searchBase ?? formatBase;
    const effectiveByDay = byDay && byDay.length > 0 ? byDay : undefined;
    const effectiveByMonthDay = byMonthDay && byMonthDay.length > 0 ? byMonthDay : undefined;
    let nextDate = rule === 'weekly' && effectiveByDay
        ? nextWeeklyByDay(base, effectiveByDay, interval, weekStart)
        : rule === 'monthly' && effectiveByDay
            ? nextMonthlyByDay(base, effectiveByDay, interval)
            : rule === 'monthly' && effectiveByMonthDay
                ? nextMonthlyByMonthDay(base, effectiveByMonthDay, interval)
                : addInterval(base, rule, interval, anchorDay ?? formatBase.getDate());

    // Preserve existing storage format:
    // - If base has timezone/offset, keep ISO (Z/offset).
    // - Otherwise, return local datetime-local compatible string.
    const isDateOnly = !!baseIso && /^\d{4}-\d{2}-\d{2}$/.test(baseIso);
    if (isDateOnly) {
        return format(nextDate, 'yyyy-MM-dd');
    }
    const hasTimezone = !!baseIso && /Z$|[+-]\d{2}:?\d{2}$/.test(baseIso);
    const hasLocalTime = !!baseIso && /[T\s]\d{2}:\d{2}/.test(baseIso);
    if (!hasTimezone && hasLocalTime) {
        nextDate = buildDateWithTime(nextDate.getFullYear(), nextDate.getMonth(), nextDate.getDate(), formatBase);
    }
    return hasTimezone ? nextDate.toISOString() : format(nextDate, "yyyy-MM-dd'T'HH:mm");
}

/**
 * Next occurrence for "repeat after completion" bases. Fluid recurrence has no
 * series anchor — the completion date is the only base — so a day-aligned rule
 * (weekly BYDAY, monthly BYDAY/BYMONTHDAY) with INTERVAL=N must land in the Nth
 * week/month after the base. Shift the search base by N-1 whole units and scan
 * the following unit for the first matching day; without the shift the base's
 * own week/month satisfies the scan and the interval is silently ignored (#867).
 */
function nextFluidIsoFrom(
    baseIso: string | undefined,
    rule: RecurrenceRule,
    fallbackBase: Date,
    byDay?: RecurrenceByDay[],
    interval: number = 1,
    byMonthDay?: number[],
    weekStart?: RecurrenceWeekday
): string | undefined {
    const hasByDay = !!byDay && byDay.length > 0;
    const hasByMonthDay = !!byMonthDay && byMonthDay.length > 0;
    const dayAligned = (rule === 'weekly' && hasByDay)
        || (rule === 'monthly' && (hasByDay || hasByMonthDay));
    if (!dayAligned || interval <= 1) {
        return nextIsoFrom(baseIso, rule, fallbackBase, byDay, interval, byMonthDay, weekStart);
    }
    const base = safeParseDate(baseIso) || fallbackBase;
    const shiftedBase = rule === 'weekly' ? addWeeks(base, interval - 1) : addMonths(base, interval - 1);
    return nextIsoFrom(baseIso, rule, fallbackBase, byDay, 1, byMonthDay, weekStart, shiftedBase);
}

const preserveDateOnlyFormat = (
    nextIso: string | undefined,
    sourceIso: string | undefined
): string | undefined => {
    if (!nextIso || !sourceIso || !/^\d{4}-\d{2}-\d{2}$/.test(sourceIso)) return nextIso;
    const parsed = safeParseDate(nextIso);
    return parsed ? format(parsed, 'yyyy-MM-dd') : nextIso;
};

/**
 * Rebuild one sibling schedule field around the selected occurrence anchor.
 * RRULE selectors choose an occurrence once; they do not independently snap a
 * task's start, due, and review fields onto the selector grid. Calendar-day
 * offsets preserve the task's shape across DST while the source field supplies
 * its own precision and wall-clock time.
 */
function shiftScheduleFieldFromAnchor(
    sourceIso: string,
    sourceAnchorIso: string,
    nextAnchorIso: string,
): string {
    const source = safeParseDate(sourceIso);
    const sourceAnchor = safeParseDate(sourceAnchorIso);
    const nextAnchor = safeParseDate(nextAnchorIso);
    if (!source || !sourceAnchor || !nextAnchor) return sourceIso;

    const shifted = addDays(nextAnchor, differenceInCalendarDays(source, sourceAnchor));
    shifted.setHours(
        source.getHours(),
        source.getMinutes(),
        source.getSeconds(),
        source.getMilliseconds(),
    );
    if (/^\d{4}-\d{2}-\d{2}$/.test(sourceIso)) return format(shifted, 'yyyy-MM-dd');
    if (/Z$|[+-]\d{2}:?\d{2}$/.test(sourceIso)) return shifted.toISOString();
    return format(shifted, "yyyy-MM-dd'T'HH:mm");
}

function rebuildScheduleFieldsFromAnchor(
    sourceDates: RecurrenceScheduleDates,
    anchorField: RecurrenceScheduleField,
    nextAnchorIso: string,
): RecurrenceScheduleDates {
    const sourceAnchorIso = sourceDates[anchorField];
    if (!sourceAnchorIso) return {};
    const rebuild = (field: RecurrenceScheduleField): string | undefined => {
        const sourceIso = sourceDates[field];
        if (!sourceIso) return undefined;
        return field === anchorField
            ? preserveDateOnlyFormat(nextAnchorIso, sourceIso)
            : shiftScheduleFieldFromAnchor(sourceIso, sourceAnchorIso, nextAnchorIso);
    };
    return {
        startTime: rebuild('startTime'),
        dueDate: rebuild('dueDate'),
        reviewAt: rebuild('reviewAt'),
    };
}

function resetChecklist(checklist: ChecklistItem[] | undefined): ChecklistItem[] | undefined {
    if (!checklist || checklist.length === 0) return undefined;
    return checklist.map((item) => ({
        ...item,
        id: uuidv4(),
        isCompleted: false,
    }));
}

const shouldStopAtUntil = (nextIso: string | undefined, until: string | undefined): boolean => {
    if (!nextIso || !until) return false;
    const nextDate = safeParseDate(nextIso);
    if (!nextDate) return false;
    if (/^\d{4}-\d{2}-\d{2}$/.test(until)) {
        return format(nextDate, 'yyyy-MM-dd') > until;
    }
    const untilDate = safeParseDate(until);
    if (!untilDate) return false;
    return nextDate.getTime() > untilDate.getTime();
};

type ProjectedIsoResult = {
    iso?: string;
    steps: number;
};

const emptyProjectedIsoResult = (): ProjectedIsoResult => ({ iso: undefined, steps: 0 });

const getProjectionBaseDate = (projectedAtIso: string): Date => {
    const parsed = safeParseDate(projectedAtIso);
    if (parsed) return parsed;
    const fallback = new Date(projectedAtIso);
    return Number.isNaN(fallback.getTime()) ? new Date() : fallback;
};

const hasMonthlyRuleDateAnchor = (byDay?: RecurrenceByDay[], byMonthDay?: number[]): boolean => (
    Boolean(byMonthDay?.length)
    || Boolean(byDay?.length)
);

function projectStrictIsoFrom(
    baseIso: string | undefined,
    rule: RecurrenceRule,
    projectionBase: Date,
    byDay?: RecurrenceByDay[],
    interval: number = 1,
    byMonthDay?: number[],
    weekStart?: RecurrenceWeekday,
    anchorDay?: number
): ProjectedIsoResult {
    const parsedBase = safeParseDate(baseIso);
    const safeInterval = interval > 0 ? interval : 1;
    const hasComplexCalendarRule = Boolean(byDay?.length) || Boolean(byMonthDay?.length);
    let skippedSteps = 0;
    let fastForwardedBaseIso = baseIso;

    // Simple interval rules can jump close to the requested projection boundary
    // without enumerating every occurrence since the series anchor. Use calendar
    // units rather than elapsed milliseconds so date-only values and local wall
    // times keep their DST behavior. Leave one step of headroom and finish with
    // the canonical nextIsoFrom loop below; that makes month-end clamps and exact
    // boundary inclusion identical to the iterative path.
    if (parsedBase && parsedBase < projectionBase && !hasComplexCalendarRule) {
        const calendarDayNumber = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
        const calendarDayDelta = Math.max(0, calendarDayNumber(projectionBase) - calendarDayNumber(parsedBase));
        const calendarMonthDelta = Math.max(
            0,
            (projectionBase.getFullYear() - parsedBase.getFullYear()) * 12
                + projectionBase.getMonth() - parsedBase.getMonth(),
        );
        const calendarYearDelta = Math.max(0, projectionBase.getFullYear() - parsedBase.getFullYear());
        const estimatedSteps = rule === 'daily'
            ? Math.floor(calendarDayDelta / safeInterval)
            : rule === 'weekly'
                ? Math.floor(calendarDayDelta / (safeInterval * 7))
                : rule === 'monthly'
                    ? Math.floor(calendarMonthDelta / safeInterval)
                    : Math.floor(calendarYearDelta / safeInterval);
        skippedSteps = Math.max(0, estimatedSteps - 1);
        if (skippedSteps > 0) {
            fastForwardedBaseIso = nextIsoFrom(
                baseIso,
                rule,
                projectionBase,
                undefined,
                safeInterval * skippedSteps,
                undefined,
                weekStart,
                undefined,
                anchorDay,
            );
        }
    }

    let nextIso = nextIsoFrom(
        fastForwardedBaseIso,
        rule,
        projectionBase,
        byDay,
        safeInterval,
        byMonthDay,
        weekStart,
        undefined,
        anchorDay,
    );
    if (!nextIso) return { iso: undefined, steps: 0 };

    let steps = skippedSteps + 1;
    for (let guard = 0; guard < 1000; guard += 1) {
        const parsedNext = safeParseDate(nextIso);
        if (!parsedNext || parsedNext > projectionBase) break;
        const followingIso = nextIsoFrom(nextIso, rule, projectionBase, byDay, interval, byMonthDay, weekStart, undefined, anchorDay);
        if (!followingIso || followingIso === nextIso) break;
        nextIso = followingIso;
        steps += 1;
    }
    return { iso: nextIso, steps };
}

function projectFluidIsoFrom(
    baseIso: string,
    rule: RecurrenceRule,
    projectedAtIso: string,
    projectionBase: Date,
    catchUpBase: Date | undefined,
    byDay?: RecurrenceByDay[],
    interval: number = 1,
    byMonthDay?: number[],
    weekStart?: RecurrenceWeekday,
): ProjectedIsoResult {
    // Fluid recurrence remains anchored to the completion/projection instant for
    // its first occurrence. Catch-up only begins after that canonical first step,
    // so opening a distant calendar range cannot change repeat-after-completion
    // semantics.
    const fieldBaseDate = safeParseDate(baseIso);
    const fieldIsFuture = Boolean(fieldBaseDate && fieldBaseDate.getTime() > projectionBase.getTime());
    const fluidBaseIso = fieldIsFuture ? baseIso : projectedAtIso;
    const fluidFallbackBase = fieldIsFuture && fieldBaseDate ? fieldBaseDate : projectionBase;
    let nextIso = preserveDateOnlyFormat(
        nextFluidIsoFrom(fluidBaseIso, rule, fluidFallbackBase, byDay, interval, byMonthDay, weekStart),
        baseIso,
    );
    if (!nextIso) return emptyProjectedIsoResult();

    let steps = 1;
    let parsedNext = safeParseDate(nextIso);
    if (!catchUpBase || !parsedNext || parsedNext > catchUpBase) {
        return { iso: nextIso, steps };
    }

    const safeInterval = interval > 0 ? interval : 1;
    const canFastForwardByCalendarDays = (rule === 'daily' || rule === 'weekly')
        && !byDay?.length
        && !byMonthDay?.length;
    if (canFastForwardByCalendarDays) {
        const calendarDayNumber = (date: Date) => (
            Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000
        );
        const calendarDayDelta = Math.max(
            0,
            calendarDayNumber(catchUpBase) - calendarDayNumber(parsedNext),
        );
        const recurrenceDays = safeInterval * (rule === 'weekly' ? 7 : 1);
        const skippedSteps = Math.max(0, Math.floor(calendarDayDelta / recurrenceDays) - 1);
        if (skippedSteps > 0) {
            nextIso = preserveDateOnlyFormat(
                nextIsoFrom(
                    nextIso,
                    rule,
                    catchUpBase,
                    undefined,
                    safeInterval * skippedSteps,
                    undefined,
                    weekStart,
                ),
                baseIso,
            );
            steps += skippedSteps;
            parsedNext = safeParseDate(nextIso);
        }
    }

    // Month-end fluid rules intentionally drift after a clamp, and BYDAY /
    // BYMONTHDAY rules have their own interval semantics. Finish those cases by
    // canonical stepping rather than replacing them with anchor-based math. The
    // outer range loop can continue catch-up if this defensive bound is reached.
    for (let guard = 0; guard < 1000 && parsedNext && parsedNext <= catchUpBase; guard += 1) {
        const followingIso = preserveDateOnlyFormat(
            nextFluidIsoFrom(nextIso, rule, parsedNext, byDay, safeInterval, byMonthDay, weekStart),
            baseIso,
        );
        if (!followingIso || followingIso === nextIso) break;
        nextIso = followingIso;
        parsedNext = safeParseDate(nextIso);
        steps += 1;
    }

    return { iso: nextIso, steps };
}

function projectUnscheduledMonthlyStart(
    rule: RecurrenceRule,
    projectionBase: Date,
    byDay?: RecurrenceByDay[],
    interval: number = 1,
    byMonthDay?: number[],
    weekStart?: RecurrenceWeekday
): ProjectedIsoResult {
    if (rule !== 'monthly' || !hasMonthlyRuleDateAnchor(byDay, byMonthDay)) {
        return emptyProjectedIsoResult();
    }

    const seedIso = format(projectionBase, 'yyyy-MM-dd');
    const iso = nextIsoFrom(seedIso, rule, projectionBase, byDay, interval, byMonthDay, weekStart);
    return iso ? { iso, steps: 1 } : emptyProjectedIsoResult();
}

type ProjectedOccurrenceFields = {
    startTime?: string;
    dueDate?: string;
    reviewAt?: string;
    steps: number;
};

type ProjectedOccurrenceAnchors = {
    startTime?: number;
    dueDate?: number;
    reviewAt?: number;
};

/**
 * Per-field anchor day (e.g. 31 for a monthly task due the 31st), resolved once
 * from the series' first base task and held fixed for every later occurrence.
 * `projectStrictIsoFrom` already holds its own anchor fixed across its internal
 * catch-up loop -- this does the same across occurrence-to-occurrence steps in
 * `expandCalendarRecurringTasksInRange`. Recomputing the anchor from each new
 * occurrence's (already clamped) date would drift it down every step: a task
 * due the 31st would clamp to 28 in February and then re-anchor on 28 for every
 * month after, instead of returning to 31 whenever the month allows it.
 */
function resolveProjectedOccurrenceAnchors(task: Task, baseTask: Task): ProjectedOccurrenceAnchors {
    return resolveRecurrenceFieldAnchorDays(task.recurrence, baseTask);
}

/**
 * One recurrence step forward from `baseTask`'s schedule fields. Shared by the
 * single-occurrence preview (`createProjectedRecurringTask`) and the range-based
 * calendar expansion (`expandCalendarRecurringTasksInRange`) so there remains
 * exactly one implementation of "what is a recurring task's next instance" (P10) --
 * the range expansion just calls this again with the previous occurrence as the
 * new `baseTask` instead of duplicating the stepping math.
 */
function projectNextRecurringOccurrenceFields(
    task: Task,
    baseTask: Task,
    rule: RecurrenceRule,
    projectedAtIso: string,
    projectionBase: Date,
    anchors: ProjectedOccurrenceAnchors,
    fluidCatchUpBase?: Date,
): ProjectedOccurrenceFields | null {
    const strategy = getRecurrenceStrategy(task.recurrence);
    const byDay = getRecurrenceByDay(task.recurrence);
    const byMonthDay = getRecurrenceByMonthDay(task.recurrence);
    const interval = getRecurrenceInterval(task.recurrence);
    const weekStart = getRecurrenceWeekStart(task.recurrence);

    const projectField = (field: RecurrenceScheduleField): ProjectedIsoResult => {
        const baseIso = baseTask[field];
        if (!baseIso) return { iso: undefined, steps: 0 };
        if (strategy === 'fluid') {
            return projectFluidIsoFrom(
                baseIso,
                rule,
                projectedAtIso,
                projectionBase,
                fluidCatchUpBase,
                byDay,
                interval,
                byMonthDay,
                weekStart,
            );
        }
        return projectStrictIsoFrom(baseIso, rule, projectionBase, byDay, interval, byMonthDay, weekStart, anchors[field]);
    };

    const hasScheduleFields = Boolean(baseTask.startTime || baseTask.dueDate || baseTask.reviewAt);
    if (!hasScheduleFields) {
        const nextStart = projectUnscheduledMonthlyStart(
            rule,
            projectionBase,
            byDay,
            interval,
            byMonthDay,
            weekStart,
        );
        return nextStart.iso
            ? { startTime: nextStart.iso, dueDate: undefined, reviewAt: undefined, steps: nextStart.steps }
            : null;
    }

    const anchorField = getRecurrenceScheduleAnchorField(baseTask);
    if (!anchorField) return null;
    const anchorProjection = projectField(anchorField);
    if (!anchorProjection.iso || anchorProjection.steps <= 0) return null;
    const steps = anchorProjection.steps;
    const rebuiltFields = rebuildScheduleFieldsFromAnchor(baseTask, anchorField, anchorProjection.iso);
    let nextStartIso = rebuiltFields.startTime;
    const nextDueIso = rebuiltFields.dueDate;
    const nextReviewIso = rebuiltFields.reviewAt;
    if (task.relativeStartOffset && nextDueIso) {
        nextStartIso = computeRelativeStartTime(nextDueIso, task.relativeStartOffset) ?? nextStartIso;
    }
    if (!nextStartIso && !nextDueIso) return null;

    return { startTime: nextStartIso, dueDate: nextDueIso, reviewAt: nextReviewIso, steps };
}

/**
 * Create a read-only, calendar-only preview of the next visible occurrence.
 *
 * This never creates a persisted task. It uses a synthetic ID so calendar views
 * and device calendar push can add/update/remove the preview independently.
 */
export function createProjectedRecurringTask(
    task: Task,
    projectedAtIso: string = new Date().toISOString()
): ProjectedRecurringTask | null {
    if (!task.showFutureRecurrence) return null;
    if (isProjectedRecurringTask(task)) return null;
    if (task.deletedAt || !isTaskActionable(task)) {
        return null;
    }

    const rule = getRecurrenceRule(task.recurrence);
    if (!rule) return null;

    const count = getRecurrenceCountValue(task.recurrence);
    const until = getRecurrenceUntilValue(task.recurrence);
    const completedOccurrences = getRecurrenceCompletedOccurrencesValue(task.recurrence) ?? 0;
    const projectionBase = getProjectionBaseDate(projectedAtIso);
    const baseTask = createCurrentRecurringCalendarTask(task, projectedAtIso) ?? task;
    const anchors = resolveProjectedOccurrenceAnchors(task, baseTask);

    const fields = projectNextRecurringOccurrenceFields(task, baseTask, rule, projectedAtIso, projectionBase, anchors);
    if (!fields) return null;
    if (count && completedOccurrences + fields.steps >= count) return null;

    const nextOccurrenceAnchor = fields.dueDate ?? fields.startTime ?? fields.reviewAt;
    if (shouldStopAtUntil(nextOccurrenceAnchor, until)) return null;

    return {
        ...task,
        id: getProjectedRecurringTaskId(task.id),
        sourceTaskId: task.id,
        isProjectedRecurringTask: true,
        startTime: fields.startTime,
        dueDate: fields.dueDate,
        reviewAt: fields.reviewAt,
        attachments: undefined,
        completedAt: undefined,
        deletedAt: undefined,
        purgedAt: undefined,
        isFocusedToday: false,
        createdAt: task.createdAt,
        updatedAt: projectedAtIso,
    };
}

export function getProjectedRecurringTaskCalendarDate(
    task: Task,
    projectedAtIso: string = new Date().toISOString()
): string | undefined {
    const projectedTask = createProjectedRecurringTask(task, projectedAtIso);
    return projectedTask ? getTaskCalendarOccurrenceDate(projectedTask) : undefined;
}

/**
 * Toggle-independent date for a recurring task's preview row: the first
 * upcoming occurrence for unscheduled tasks, or the occurrence after the
 * current one for scheduled tasks. `showFutureRecurrence` only opts a task
 * into Calendar projection entities; it must not hide this display date.
 */
export function getRecurringTaskPreviewDate(
    task: Task,
    projectedAtIso: string = new Date().toISOString()
): string | undefined {
    const previewSource: Task = task.showFutureRecurrence ? task : { ...task, showFutureRecurrence: true };
    const current = createCurrentRecurringCalendarTask(previewSource, projectedAtIso);
    if (current?.startTime) return current.startTime;
    return getProjectedRecurringTaskCalendarDate(previewSource, projectedAtIso);
}

export function createCurrentRecurringCalendarTask(
    task: Task,
    projectedAtIso: string = new Date().toISOString()
): Task | null {
    if (!task.showFutureRecurrence) return null;
    if (isProjectedRecurringTask(task)) return null;
    if (task.deletedAt || !isTaskActionable(task)) {
        return null;
    }
    if (task.startTime || task.dueDate || task.reviewAt) return null;

    const rule = getRecurrenceRule(task.recurrence);
    if (!rule) return null;

    const count = getRecurrenceCountValue(task.recurrence);
    const completedOccurrences = getRecurrenceCompletedOccurrencesValue(task.recurrence) ?? 0;
    if (count && completedOccurrences >= count) return null;

    const projectionBase = getProjectionBaseDate(projectedAtIso);
    const currentStart = projectUnscheduledMonthlyStart(
        rule,
        projectionBase,
        getRecurrenceByDay(task.recurrence),
        getRecurrenceInterval(task.recurrence),
        getRecurrenceByMonthDay(task.recurrence),
        getRecurrenceWeekStart(task.recurrence),
    );
    if (!currentStart.iso) return null;
    if (shouldStopAtUntil(currentStart.iso, getRecurrenceUntilValue(task.recurrence))) return null;

    return {
        ...task,
        startTime: currentStart.iso,
    };
}

export function expandCalendarRecurringTasks(
    task: Task,
    projectedAtIso: string = new Date().toISOString()
): Task[] {
    const currentTask = createCurrentRecurringCalendarTask(task, projectedAtIso) ?? task;
    const projectedTask = createProjectedRecurringTask(task, projectedAtIso);
    return projectedTask ? [currentTask, projectedTask] : [currentTask];
}

// Safety caps for expandCalendarRecurringTasksInRange: per-task in-range-occurrence cap (only
// occurrences that actually land inside `range` count against it -- see MAX_RANGE_PROJECTION_ITERATIONS
// below for the separate walk guard), and a total across one calendar render's whole expansion
// pass (all tasks) so one screen can never enumerate unboundedly (perf guardrail P19). Both
// truncate deterministically -- earliest occurrences win -- never silently reordering what's shown.
export const CALENDAR_RANGE_PROJECTION_PER_TASK_CAP = 62;
export const CALENDAR_RANGE_PROJECTION_TOTAL_CAP = 500;

// The walk itself needs its own, larger iteration guard, separate from the in-range cap above:
// occurrences before `range.startIso` are generated and discarded (they establish the stepping
// chain) without counting against the per-task cap, so a range that starts far in the future
// (e.g. paging the calendar several months ahead of a daily task's anchor date) must still be
// able to walk that many steps before it ever reaches something worth keeping. ~800 covers about
// two years of daily stepping; the `anchorDate > rangeEndMs` break just below already bounds the
// tail for any range that isn't absurdly far out, so this guard only matters for the walk-up.
const MAX_RANGE_PROJECTION_ITERATIONS = 800;

export type CalendarRecurrenceRange = {
    startIso: string;
    endIso: string;
};

/**
 * Calendar-only range expansion: every occurrence of a recurring task that
 * intersects `range` (inclusive of both ends), instead of just the single next
 * occurrence `expandCalendarRecurringTasks` returns. A drop-in superset of that
 * function for calendar views -- when `showFutureRecurrence` is off, or the task
 * isn't an active recurring series, it returns `[task]` (or the synthetic
 * "current" unscheduled occurrence), exactly like `expandCalendarRecurringTasks`.
 *
 * Device-calendar push and the ICS feed keep using `expandCalendarRecurringTasks`
 * (single occurrence) -- they must not gain multi-occurrence projections.
 *
 * `maxOccurrences` lets a caller iterating many tasks in one render thread a
 * shared total budget (CALENDAR_RANGE_PROJECTION_TOTAL_CAP) on top of the
 * per-task cap; it defaults to the per-task cap alone.
 */
export function expandCalendarRecurringTasksInRange(
    task: Task,
    range: CalendarRecurrenceRange,
    projectedAtIso: string = new Date().toISOString(),
    maxOccurrences: number = CALENDAR_RANGE_PROJECTION_PER_TASK_CAP
): Task[] {
    const currentTask = createCurrentRecurringCalendarTask(task, projectedAtIso) ?? task;
    if (!task.showFutureRecurrence) return [currentTask];
    if (isProjectedRecurringTask(task)) return [currentTask];
    if (task.deletedAt || !isTaskActionable(task)) return [currentTask];

    const rule = getRecurrenceRule(task.recurrence);
    if (!rule) return [currentTask];

    const rangeEndDate = safeParseDate(range.endIso);
    if (!rangeEndDate) return [currentTask];
    const rangeStartDate = safeParseDate(range.startIso);
    const rangeStartMs = rangeStartDate ? rangeStartDate.getTime() : -Infinity;
    const rangeEndMs = rangeEndDate.getTime();

    const count = getRecurrenceCountValue(task.recurrence);
    const until = getRecurrenceUntilValue(task.recurrence);
    const baseCompletedOccurrences = getRecurrenceCompletedOccurrencesValue(task.recurrence) ?? 0;
    const projectionBase = getProjectionBaseDate(projectedAtIso);
    // Catch up to the instant immediately before the visible range. Strict
    // recurrence can use it directly because the original task remains its
    // anchor. Fluid recurrence keeps projectionBase as its completion anchor and
    // receives the same boundary separately, after its first canonical step.
    const catchUpBase = Number.isFinite(rangeStartMs) && rangeStartMs > projectionBase.getTime()
        ? new Date(rangeStartMs - 1)
        : undefined;
    const strategy = getRecurrenceStrategy(task.recurrence);
    const rangeProjectionBase = strategy === 'strict' && catchUpBase ? catchUpBase : projectionBase;
    const anchors = resolveProjectedOccurrenceAnchors(task, currentTask);

    const results: Task[] = [currentTask];
    let baseTask: Task = currentTask;
    let stepsSoFar = 0;
    let pushedCount = 0;
    const cap = Math.max(0, Math.min(CALENDAR_RANGE_PROJECTION_PER_TASK_CAP, maxOccurrences));

    for (let iteration = 0; iteration < MAX_RANGE_PROJECTION_ITERATIONS && pushedCount < cap; iteration += 1) {
        const fields = projectNextRecurringOccurrenceFields(
            task,
            baseTask,
            rule,
            projectedAtIso,
            rangeProjectionBase,
            anchors,
            strategy === 'fluid' ? catchUpBase : undefined,
        );
        if (!fields) break;
        stepsSoFar += fields.steps;
        if (count && baseCompletedOccurrences + stepsSoFar >= count) break;

        const anchorIso = fields.dueDate ?? fields.startTime ?? fields.reviewAt;
        if (shouldStopAtUntil(anchorIso, until)) break;
        const anchorDate = safeParseDate(anchorIso);
        // Occurrences only move forward, so once one lands past the range end no
        // later occurrence can re-enter it -- safe to stop the whole walk here.
        if (!anchorDate || anchorDate.getTime() > rangeEndMs) break;

        const occurrenceTask: ProjectedRecurringTask = {
            ...task,
            id: getRangeProjectedRecurringTaskId(task.id, anchorIso as string),
            sourceTaskId: task.id,
            isProjectedRecurringTask: true,
            startTime: fields.startTime,
            dueDate: fields.dueDate,
            reviewAt: fields.reviewAt,
            attachments: undefined,
            completedAt: undefined,
            deletedAt: undefined,
            purgedAt: undefined,
            isFocusedToday: false,
            createdAt: task.createdAt,
            updatedAt: projectedAtIso,
        };

        if (anchorDate.getTime() >= rangeStartMs) {
            results.push(occurrenceTask);
            pushedCount += 1;
        }
        baseTask = occurrenceTask;
    }

    return results;
}

/**
 * Expand one calendar render's task set while sharing the total projection
 * budget fairly across recurring series. Source tasks never consume the budget.
 * Every eligible series gets an equal tranche before any series receives the
 * remainder, so store iteration order cannot let an early daily series starve
 * every later one.
 */
export function expandCalendarRecurringTaskSetInRange(
    tasks: readonly Task[],
    range: CalendarRecurrenceRange,
    projectedAtIso: string = new Date().toISOString(),
    totalProjectionCap: number = CALENDAR_RANGE_PROJECTION_TOTAL_CAP,
): Task[] {
    const projectionCandidates = tasks.filter((task) => (
        task.showFutureRecurrence === true
        && !isProjectedRecurringTask(task)
        && !task.deletedAt
        && isTaskActionable(task)
        && Boolean(getRecurrenceRule(task.recurrence))
    ));
    const candidateCount = projectionCandidates.length;
    if (candidateCount === 0) return [...tasks];

    const boundedTotalCap = Math.max(0, Math.floor(totalProjectionCap));
    const perTaskCap = Math.min(CALENDAR_RANGE_PROJECTION_PER_TASK_CAP, boundedTotalCap);
    const baseShare = Math.min(
        perTaskCap,
        Math.floor(boundedTotalCap / candidateCount),
    );
    let remainder = boundedTotalCap - baseShare * candidateCount;
    const allocationByTaskId = new Map<string, number>();
    const expansionByTaskId = new Map<string, Task[]>();
    const activeTaskIds = new Set(projectionCandidates.map((task) => task.id));
    const candidateOrder = new Map(projectionCandidates.map((task, index) => [task.id, index]));

    for (const task of projectionCandidates) {
        const extra = baseShare < perTaskCap && remainder > 0 ? 1 : 0;
        allocationByTaskId.set(task.id, baseShare + extra);
        remainder -= extra;
    }

    const expandAllocatedTasks = (allocatedTasks: readonly Task[]): void => {
        for (const task of allocatedTasks) {
            const allocation = allocationByTaskId.get(task.id) ?? 0;
            if (allocation === 0) {
                expansionByTaskId.set(task.id, [task]);
                continue;
            }
            const expansion = expandCalendarRecurringTasksInRange(
                task,
                range,
                projectedAtIso,
                allocation,
            );
            expansionByTaskId.set(task.id, expansion);
            const emitted = Math.max(0, expansion.length - 1);
            if (emitted < allocation || allocation >= perTaskCap) {
                activeTaskIds.delete(task.id);
            }
        }
    };

    expandAllocatedTasks(projectionCandidates);

    const projectedCount = (): number => Array.from(expansionByTaskId.values())
        .reduce((total, expansion) => total + Math.max(0, expansion.length - 1), 0);

    // A nominal series can be exhausted by COUNT/UNTIL or simply have no
    // occurrence in this range. Reallocate its unused share among the series
    // that filled their tranche. Water-filling the lowest allocation first
    // keeps the result fair while the 500-occurrence global cap bounds work.
    remainder = boundedTotalCap - projectedCount();
    while (remainder > 0 && activeTaskIds.size > 0) {
        const activeTasks = projectionCandidates
            .filter((task) => activeTaskIds.has(task.id))
            .sort((left, right) => (
                (allocationByTaskId.get(left.id) ?? 0) - (allocationByTaskId.get(right.id) ?? 0)
                || (candidateOrder.get(left.id) ?? 0) - (candidateOrder.get(right.id) ?? 0)
            ));
        const minimumAllocation = allocationByTaskId.get(activeTasks[0]!.id) ?? 0;
        const lowest = activeTasks.filter((task) => (
            (allocationByTaskId.get(task.id) ?? 0) === minimumAllocation
        ));
        const nextAllocation = activeTasks.find((task) => (
            (allocationByTaskId.get(task.id) ?? 0) > minimumAllocation
        ));
        const nextLevel = Math.min(
            perTaskCap,
            nextAllocation ? allocationByTaskId.get(nextAllocation.id) ?? perTaskCap : perTaskCap,
        );
        const fullLevelIncrease = Math.min(
            nextLevel - minimumAllocation,
            Math.floor(remainder / lowest.length),
        );
        const changed: Task[] = [];

        if (fullLevelIncrease > 0) {
            for (const task of lowest) {
                allocationByTaskId.set(task.id, minimumAllocation + fullLevelIncrease);
                changed.push(task);
            }
        } else {
            for (const task of lowest.slice(0, remainder)) {
                allocationByTaskId.set(task.id, minimumAllocation + 1);
                changed.push(task);
            }
        }
        if (changed.length === 0) break;

        expandAllocatedTasks(changed);
        remainder = boundedTotalCap - projectedCount();
    }

    return tasks.flatMap((task) => expansionByTaskId.get(task.id) ?? [task]);
}

/**
 * Create the next instance of a recurring task.
 *
 * - Advances dueDate only when the original task has a dueDate.
 * - Shifts startTime/reviewAt forward if present.
 * - Keeps schedule fields independent: due-only tasks stay due-only, start-only tasks stay start-only.
 * - Never splits the fields a task does have: when a late completion pushes the next
 *   instance past the completion date, every schedule field moves by the same steps.
 * - Resets checklist completion and IDs.
 * - New instance status is based on the previous status, with done -> next.
 */
export function createNextRecurringTask(
    task: Task,
    completedAtIso: string,
    previousStatus: TaskStatus
): Task | null {
    const rule = getRecurrenceRule(task.recurrence);
    if (!rule) return null;
    const strategy = getRecurrenceStrategy(task.recurrence);
    const byDay = getRecurrenceByDay(task.recurrence);
    const byMonthDay = getRecurrenceByMonthDay(task.recurrence);
    const interval = getRecurrenceInterval(task.recurrence);
    const weekStart = getRecurrenceWeekStart(task.recurrence);
    const count = getRecurrenceCountValue(task.recurrence);
    const until = getRecurrenceUntilValue(task.recurrence);
    const completedOccurrences = getRecurrenceCompletedOccurrencesValue(task.recurrence) ?? 0;
    const recurrenceAnchorDays = resolveRecurrenceFieldAnchorDays(task.recurrence, task);
    const parsedCompletedAt = safeParseDate(completedAtIso);
    const fallbackCompletedAt = (() => {
        const candidate = new Date(completedAtIso);
        return Number.isNaN(candidate.getTime()) ? new Date() : candidate;
    })();
    const completedAtDate = parsedCompletedAt ?? fallbackCompletedAt;
    const anchorField = getRecurrenceScheduleAnchorField(task);
    const sourceAnchorIso = anchorField ? task[anchorField] : undefined;
    let nextAnchorIso = sourceAnchorIso
        ? preserveDateOnlyFormat(
            strategy === 'fluid'
                ? nextFluidIsoFrom(completedAtIso, rule, completedAtDate, byDay, interval, byMonthDay, weekStart)
                : nextIsoFrom(
                    sourceAnchorIso,
                    rule,
                    completedAtDate,
                    byDay,
                    interval,
                    byMonthDay,
                    weekStart,
                    undefined,
                    recurrenceAnchorDays[anchorField!],
                ),
            sourceAnchorIso,
        )
        : undefined;
    let rebuiltFields = anchorField && nextAnchorIso
        ? rebuildScheduleFieldsFromAnchor(task, anchorField, nextAnchorIso)
        : {};
    if (
        strategy === 'strict'
        && anchorField === 'dueDate'
        && task.startTime
        && rebuiltFields.startTime
        && !task.relativeStartOffset
    ) {
        const parsedNextStart = safeParseDate(rebuiltFields.startTime);
        if (parsedNextStart && parsedNextStart <= completedAtDate) {
            const caughtUpAnchor = projectStrictIsoFrom(
                sourceAnchorIso!,
                rule,
                completedAtDate,
                byDay,
                interval,
                byMonthDay,
                weekStart,
                recurrenceAnchorDays.dueDate,
            ).iso;
            if (caughtUpAnchor) {
                nextAnchorIso = preserveDateOnlyFormat(caughtUpAnchor, sourceAnchorIso);
                rebuiltFields = rebuildScheduleFieldsFromAnchor(task, anchorField, nextAnchorIso!);
            }
        }
    }
    let nextStartTime = rebuiltFields.startTime;
    let nextDueDate = rebuiltFields.dueDate;
    let nextReviewAt = rebuiltFields.reviewAt;
    let nextRelativeStartOffset = task.relativeStartOffset ? { ...task.relativeStartOffset } : undefined;
    if (nextRelativeStartOffset) {
        if (nextDueDate) {
            const computedStartTime = computeRelativeStartTime(nextDueDate, nextRelativeStartOffset);
            if (computedStartTime) {
                nextStartTime = computedStartTime;
            } else {
                nextRelativeStartOffset = undefined;
            }
        } else {
            nextRelativeStartOffset = undefined;
        }
    }
    if (!nextStartTime && !nextDueDate && !nextReviewAt) {
        // When recurrence exists but no schedule fields are set, defer the next instance
        // from completion so it does not reappear in Next immediately. Seed with the
        // completion's date part only: the task never had a time, so its next instance
        // must stay date-only instead of inheriting the completion's time of day. The
        // ISO prefix (not the local date) keeps parity with the Rust local API.
        const completedAtDatePart = /^\d{4}-\d{2}-\d{2}/.exec(completedAtIso)?.[0]
            ?? format(completedAtDate, 'yyyy-MM-dd');
        nextStartTime = nextFluidIsoFrom(completedAtDatePart, rule, completedAtDate, byDay, interval, byMonthDay, weekStart);
    }

    if (count && completedOccurrences + 1 >= count) {
        return null;
    }

    const nextOccurrenceAnchor = nextDueDate ?? nextStartTime ?? nextReviewAt;
    if (shouldStopAtUntil(nextOccurrenceAnchor, until)) {
        return null;
    }

    let newStatus: TaskStatus = previousStatus;
    if (newStatus === 'done' || newStatus === 'archived') {
        newStatus = 'next';
    }

    // The next instance keeps its attachments, so the copies intentionally share
    // cloudKey/uri with the completed instance (unlike duplicateTask, which drops
    // file attachments). Every remote-delete and cleanup path must therefore
    // refcount cloudKeys across all tasks before deleting remote bytes.
    const duplicatedAttachments = (task.attachments || [])
        .filter((attachment) => !attachment.deletedAt)
        .map<Attachment>((attachment) => ({
            ...attachment,
            id: uuidv4(),
            createdAt: completedAtIso,
            updatedAt: completedAtIso,
            deletedAt: undefined,
        }));

    const nextCompletedOccurrences = completedOccurrences + 1;
    const seriesId = typeof task.recurrence === 'object' && typeof task.recurrence.seriesId === 'string'
        ? task.recurrence.seriesId.trim() || task.id
        : task.id;
    let nextRecurrence: Recurrence = { rule, seriesId };
    const nextAnchorDays = getNextRecurrenceAnchorDays(task, rule);
    if (task.recurrence && typeof task.recurrence === 'object') {
        const recurrence = task.recurrence as Recurrence;
        nextRecurrence = {
            ...recurrence,
            seriesId,
            ...nextAnchorDays,
            ...(byMonthDay ? { byMonthDay } : {}),
            ...(typeof recurrence.count === 'number' || count ? { count } : {}),
            ...(typeof recurrence.until === 'string' || until ? { until } : {}),
            ...(count ? { completedOccurrences: nextCompletedOccurrences } : {}),
            ...(recurrence.rrule
                ? {
                    rrule: buildRRuleString(rule, byDay, interval, {
                        byMonthDay,
                        weekStart,
                        count,
                        until,
                    }),
                }
                : {}),
        };
    } else {
        nextRecurrence = {
            rule,
            seriesId,
            ...nextAnchorDays,
        };
    }

    return {
        id: uuidv4(),
        title: task.title,
        status: newStatus,
        priority: task.priority,
        energyLevel: task.energyLevel,
        assignedTo: task.assignedTo,
        taskMode: task.taskMode,
        startTime: nextStartTime,
        relativeStartOffset: nextRelativeStartOffset,
        dueDate: nextDueDate,
        recurrence: nextRecurrence,
        showFutureRecurrence: task.showFutureRecurrence ? true : undefined,
        suppressMindwtrReminders: task.suppressMindwtrReminders ? true : undefined,
        repeatReminderMinutes: task.repeatReminderMinutes,
        tags: [...(task.tags || [])],
        contexts: [...(task.contexts || [])],
        checklist: resetChecklist(task.checklist),
        description: task.description,
        textDirection: task.textDirection,
        attachments: duplicatedAttachments.length > 0 ? duplicatedAttachments : undefined,
        location: task.location,
        projectId: task.projectId,
        sectionId: task.sectionId,
        areaId: task.areaId,
        isFocusedToday: false,
        timeEstimate: task.timeEstimate,
        reviewAt: nextReviewAt,
        createdAt: completedAtIso,
        updatedAt: completedAtIso,
    };
}
