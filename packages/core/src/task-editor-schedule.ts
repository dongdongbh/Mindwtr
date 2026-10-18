import {
    createCustomTimeEstimate,
    formatTimeEstimateLabel,
    isCustomTimeEstimate,
    parseTimeEstimateInput,
    timeEstimateToMinutes,
} from './calendar-scheduling';
import {
    getQuickDate,
    hasTimeComponent,
    isQuickDatePresetSelected,
    QUICK_DATE_PRESETS,
    safeParseDate,
    safeParseDueDate,
    type DateFormatter,
    type QuickDatePreset,
} from './date';
import { tFallback } from './i18n';
import { buildRRuleString, editRRuleString, getProjectedRecurringTaskCalendarDate, isMonthlyWeekdaySet, MONTHLY_WEEKDAYS, parseRRuleString, RECURRENCE_INTERVAL_MAX, type RRuleEditOverrides } from './recurrence';
import { getLocalizedWeekdayButtons, getLocalizedWeekdayLabels, WEEKDAY_ORDER } from './recurrence-constants';
import { resolveFeatureFlags } from './resolve-feature-flags';
import { REPEAT_REMINDER_INTERVAL_OPTIONS } from './schedule-utils';
import type { TaskDraft } from './task-draft';
import { computeRelativeStartTime } from './task-relative-start';
import { getTaskReminderPolicy, shouldSendTaskReminders } from './task-reminder-policy';
import type {
    AppSettings,
    NotificationSettings,
    RecurrenceByDay,
    RecurrenceRule,
    RecurrenceStrategy,
    RecurrenceWeekday,
    RelativeStartOffsetUnit,
    Task,
    TimeEstimate,
} from './types';

/**
 * The React Native editor's date, recurrence, reminder and estimate controls, as
 * pure functions: the labels they show and the draft values their taps write. The
 * mobile editor and native hosts both call these, so a tap writes the same draft.
 */

type Translate = (key: string) => string;

export type TaskEditorDateField = 'startTime' | 'dueDate' | 'reviewAt';

// ---------------------------------------------------------------------------
// Dates

/** A date field's text: the date, with the time when it has one. A due date parses as end of day. */
export function formatTaskEditorDate(
    value: string | undefined,
    formatDate: DateFormatter,
    notSet: string,
    options: { due?: boolean } = {},
): string {
    if (!value) return notSet;
    const parsed = options.due ? safeParseDueDate(value) : safeParseDate(value);
    if (!parsed) return notSet;
    return formatDate(parsed, hasTimeComponent(value) ? 'P p' : 'P', notSet) || notSet;
}

/** The value after "Date only": the local day, without the time. */
export function getTaskDraftDateOnly(value: string | undefined, formatDate: DateFormatter): string {
    const parsed = safeParseDate(value);
    return parsed ? formatDate(parsed, 'yyyy-MM-dd') : '';
}

/**
 * The value after picking a day. An existing time is kept; otherwise the default
 * schedule time is added; otherwise the value stays date-only. Start and due keep
 * their time as an ISO instant and review as local wall time, as the editor writes them.
 */
export function setTaskDraftDate(
    field: TaskEditorDateField,
    value: string | undefined,
    day: Date,
    options: { defaultScheduleTime?: string; formatDate: DateFormatter },
): string {
    const { formatDate } = options;
    const dateOnly = formatDate(day, 'yyyy-MM-dd');
    const existing = value && hasTimeComponent(value) ? safeParseDate(value) : null;
    if (existing) {
        if (field === 'reviewAt') return `${dateOnly}T${formatDate(existing, 'HH:mm')}`;
        const combined = new Date(day);
        combined.setHours(existing.getHours(), existing.getMinutes(), 0, 0);
        return combined.toISOString();
    }
    return options.defaultScheduleTime ? `${dateOnly}T${options.defaultScheduleTime}` : dateOnly;
}

/**
 * The value after picking a time: the hour and minute set on `base`'s local day, else
 * the value's day, else today; an ISO instant. A wall time the day skips at a DST change
 * moves forward, and a repeated one takes its first occurrence, as Date#setHours does.
 */
export function setTaskDraftTime(
    value: string | undefined,
    time: { hours: number; minutes: number },
    base?: Date | null,
    now: Date = new Date(),
): string {
    const combined = new Date(base ?? safeParseDate(value) ?? now);
    combined.setHours(time.hours, time.minutes, 0, 0);
    return combined.toISOString();
}

/**
 * The draft fields a date control writes, in order. A new start ends the relative
 * start link even when it equals the computed start; a new due moves a relative
 * start through setTaskDraftField's cascade.
 */
export function getTaskDraftDateEdit(field: TaskEditorDateField, value: string): Partial<TaskDraft> {
    if (field === 'startTime') return { startTime: value, relativeStartOffset: undefined };
    return field === 'dueDate' ? { dueDate: value } : { reviewAt: value };
}

export const QUICK_DATE_LABELS: Record<QuickDatePreset, { key: string; fallback: string }> = {
    today: { key: 'quickDate.today', fallback: 'Today' },
    tomorrow: { key: 'quickDate.tomorrow', fallback: 'Tomorrow' },
    in_2_days: { key: 'quickDate.in2Days', fallback: '+2 days' },
    in_3_days: { key: 'quickDate.in3Days', fallback: '+3 days' },
    next_week: { key: 'quickDate.nextWeek', fallback: 'Next week' },
    next_month: { key: 'quickDate.nextMonth', fallback: 'Next month' },
    no_date: { key: 'quickDate.noDate', fallback: 'No date' },
};

export const getQuickDateLabel = (preset: QuickDatePreset, t: Translate): string => (
    tFallback(t, QUICK_DATE_LABELS[preset].key, QUICK_DATE_LABELS[preset].fallback)
);

export type TaskEditorQuickDate = {
    preset: QuickDatePreset;
    label: string;
    selected: boolean;
    /** The field's value after tapping the chip: the selected chip and No date clear it. */
    value: string;
};

/** A date field's quick chips. */
export function getTaskEditorQuickDates(
    field: TaskEditorDateField,
    value: string | undefined,
    options: { t: Translate; now: Date; defaultScheduleTime?: string; formatDate: DateFormatter },
): TaskEditorQuickDate[] {
    const selectedDate = value ? safeParseDate(value) : null;
    return QUICK_DATE_PRESETS.map((preset) => {
        const selected = isQuickDatePresetSelected(preset, selectedDate, options.now);
        const day = selected ? null : getQuickDate(preset, options.now);
        return {
            preset,
            label: getQuickDateLabel(preset, options.t),
            selected,
            value: day ? setTaskDraftDate(field, value, day, options) : '',
        };
    });
}

export type TaskEditorDatePart = {
    /** The draft value. */
    value: string;
    /** The field's text, in the user's date and time settings. */
    label: string;
    hasTime: boolean;
    /** The value after "Date only", or '' when unset. */
    dateOnly: string;
    /** The time as HH:mm, or '' when the value is date-only or unset. */
    time: string;
    /** Where the date and time pickers start: the value, else now. */
    picker: { date: string; time: string };
    quickDates: TaskEditorQuickDate[];
};

export function getTaskEditorDatePart(
    field: TaskEditorDateField,
    value: string,
    options: { t: Translate; now: Date; defaultScheduleTime?: string; formatDate: DateFormatter },
): TaskEditorDatePart {
    const { formatDate } = options;
    const parsed = value ? safeParseDate(value) : null;
    const hasTime = hasTimeComponent(value);
    const pickerDate = parsed ?? options.now;
    return {
        value,
        label: formatTaskEditorDate(value, formatDate, options.t('common.notSet'), { due: field === 'dueDate' }),
        hasTime,
        dateOnly: getTaskDraftDateOnly(value, formatDate),
        time: hasTime && parsed ? formatDate(parsed, 'HH:mm') : '',
        picker: { date: formatDate(pickerDate, 'yyyy-MM-dd'), time: formatDate(pickerDate, 'HH:mm') },
        quickDates: getTaskEditorQuickDates(field, value, options),
    };
}

// ---------------------------------------------------------------------------
// Relative start

const isSubDayUnit = (unit: RelativeStartOffsetUnit) => unit === 'minute' || unit === 'hour';

/** Minutes and hours need a due time; before a date-only due they read as days. */
export const getTaskEditorRelativeStartUnit = (
    dueDate: string | undefined,
    unit: RelativeStartOffsetUnit,
): RelativeStartOffsetUnit => (dueDate && !hasTimeComponent(dueDate) && isSubDayUnit(unit) ? 'day' : unit);

/**
 * "Start N units before due": the draft fields to write, in order, or null when the
 * input changes nothing. A start that cannot be computed ends the link.
 */
export function getTaskDraftRelativeStartEdit(
    dueDate: string,
    amount: number,
    unit: RelativeStartOffsetUnit,
): Partial<TaskDraft> | null {
    if (!dueDate || !Number.isFinite(amount)) return null;
    // 0 is valid: start on the due date itself.
    const magnitude = Math.max(0, Math.floor(amount));
    const offset = { amount: magnitude === 0 ? 0 : -magnitude, unit: getTaskEditorRelativeStartUnit(dueDate, unit) };
    const startTime = computeRelativeStartTime(dueDate, offset);
    return startTime ? { relativeStartOffset: offset, startTime } : { relativeStartOffset: undefined };
}

export type TaskEditorRelativeStart = {
    /** Relative mode is on. */
    active: boolean;
    /** The amount shown and applied when switching to relative mode. */
    amount: number;
    unit: RelativeStartOffsetUnit;
    units: Array<{ unit: RelativeStartOffsetUnit; label: string }>;
};

/** The start field's absolute/relative control; null without a due date. */
export function getTaskEditorRelativeStart(
    draft: Pick<TaskDraft, 'dueDate' | 'relativeStartOffset'>,
    t: Translate,
): TaskEditorRelativeStart | null {
    if (!draft.dueDate) return null;
    const units: RelativeStartOffsetUnit[] = hasTimeComponent(draft.dueDate)
        ? ['minute', 'hour', 'day', 'week']
        : ['day', 'week'];
    const unitLabelKeys: Record<RelativeStartOffsetUnit, string> = {
        minute: 'taskEdit.relativeStartMinutesShort',
        hour: 'taskEdit.relativeStartHoursShort',
        day: 'taskEdit.relativeStartDaysShort',
        week: 'taskEdit.relativeStartWeeksShort',
    };
    return {
        active: Boolean(draft.relativeStartOffset),
        amount: draft.relativeStartOffset ? Math.abs(draft.relativeStartOffset.amount) : 3,
        unit: getTaskEditorRelativeStartUnit(draft.dueDate, draft.relativeStartOffset?.unit ?? 'day'),
        units: units.map((unit) => ({ unit, label: t(unitLabelKeys[unit]) })),
    };
}

// ---------------------------------------------------------------------------
// Reminders

export type TaskEditorReminders = {
    /** "Skip reminders" shows when the start or due has a time. */
    showSkip: boolean;
    /** "Repeat reminder" shows under a timed due, unless reminders are skipped. */
    showRepeat: boolean;
    policyLabel: string;
    policyValueLabel: string;
    policyOptions: Array<{ value: NonNullable<Task['reminderPolicy']>; label: string; selected: boolean }>;
    hint: string;
    disabledHint: string | null;
    repeatLabel: string;
    /** The current interval, as the collapsed control shows it. */
    repeatValueLabel: string;
    /** Off, then each interval; `value` is the draft value (null for Off). */
    repeatOptions: Array<{ value: number | null; label: string; selected: boolean }>;
};

export function getTaskEditorReminders(
    draft: Pick<TaskDraft, 'startTime' | 'dueDate' | 'repeatReminderMinutes' | 'suppressMindwtrReminders'> & Partial<Pick<TaskDraft, 'reminderPolicy'>>,
    t: Translate,
    settings: Pick<NotificationSettings, 'taskReminderDefault' | 'notificationsEnabled'> = {},
): TaskEditorReminders {
    const current = draft.repeatReminderMinutes ?? 0;
    const off = tFallback(t, 'taskEdit.repeatReminderOff', 'Off');
    const count = (key: string, fallback: string, minutes: number) => (
        minutes === 0 ? off : tFallback(t, key, fallback).replace('{count}', String(minutes))
    );
    const policy = getTaskReminderPolicy(draft);
    const send = tFallback(t, 'taskEdit.reminderPolicySend', 'Send');
    const skip = tFallback(t, 'taskEdit.reminderPolicySkip', 'Skip');
    const policyOptions: TaskEditorReminders['policyOptions'] = [
        { value: 'inherit', label: tFallback(t, 'taskEdit.reminderPolicyInherit', 'Use default ({value})').replace('{value}', settings.taskReminderDefault === 'skip' ? skip : send), selected: policy === 'inherit' },
        { value: 'send', label: send, selected: policy === 'send' },
        { value: 'skip', label: skip, selected: policy === 'skip' },
    ];
    return {
        showSkip: hasTimeComponent(draft.startTime) || hasTimeComponent(draft.dueDate),
        showRepeat: hasTimeComponent(draft.dueDate) && shouldSendTaskReminders(draft, settings),
        policyLabel: tFallback(t, 'taskEdit.reminders', 'Start/due reminders'),
        policyValueLabel: policyOptions.find((option) => option.selected)!.label,
        policyOptions,
        hint: tFallback(t, 'taskEdit.reminderPolicyHint', 'Start and due reminders need an explicit time. Focus and review reminders are unchanged.'),
        disabledHint: settings.notificationsEnabled === false
            ? tFallback(t, 'taskEdit.remindersDisabledHint', 'Task reminders are turned off in Notifications settings on this device.') : null,
        repeatLabel: tFallback(t, 'taskEdit.repeatReminderLabel', 'Repeat reminder'),
        repeatValueLabel: count('taskEdit.repeatReminderEveryMinutes', 'Every {count} min', current),
        repeatOptions: [0, ...REPEAT_REMINDER_INTERVAL_OPTIONS].map((minutes) => ({
            value: minutes > 0 ? minutes : null,
            label: count('taskEdit.repeatReminderMinutesShort', '{count} min', minutes),
            selected: current === minutes,
        })),
    };
}

// ---------------------------------------------------------------------------
// Time estimate and time spent

/** The Custom… estimate for typed text ("2h30", "45"), or null when it does not parse. */
export function parseTaskEditorTimeEstimate(text: string): TimeEstimate | null {
    const minutes = parseTimeEstimateInput(text);
    return minutes === null ? null : createCustomTimeEstimate(minutes);
}

export type TaskEditorTimeEstimate = {
    customLabel: string;
    customSelected: boolean;
    /** The draft value after tapping Custom…: the current estimate as exact minutes. */
    customValue: TimeEstimate;
    /** The custom input's text for the current value; '' when the estimate is not custom. */
    customText: string;
};

export function getTaskEditorTimeEstimate(current: TimeEstimate | '', t: Translate): TaskEditorTimeEstimate {
    const customSelected = isCustomTimeEstimate(current || undefined);
    return {
        customLabel: tFallback(t, 'recurrence.custom', 'Custom…'),
        customSelected,
        customValue: createCustomTimeEstimate(timeEstimateToMinutes(current || undefined)),
        // The editor shows the input text without the language, as it always has.
        customText: customSelected && current ? formatTimeEstimateLabel(current) : '',
    };
}

/** Time spent shows when Pomodoro is on and linked to tasks. */
export const isTaskEditorTimeSpentEnabled = (settings: AppSettings): boolean => (
    resolveFeatureFlags(settings).pomodoro && settings.gtd?.pomodoro?.linkTask === true
);

/** Time spent for typed text: its digits as minutes, or unset when there are none. */
export const parseTaskEditorTimeSpent = (text: string): number | undefined => {
    const digits = text.replace(/[^0-9]/g, '');
    return digits ? Number(digits) : undefined;
};

// ---------------------------------------------------------------------------
// Recurrence

export type TaskDraftRecurrence = Pick<TaskDraft, 'recurrence' | 'recurrenceStrategy' | 'recurrenceRRule'>;

/** RN's draft-backed Calendar hint, shown even when the preview toggle is off. */
export function getTaskEditorRecurrenceCalendarPreviewHint(input: {
    draft: TaskDraft;
    task: Task | null;
    t: Translate;
    formatDate: DateFormatter;
    now?: Date;
}): string {
    const { draft, task, t, formatDate } = input;
    if (!draft.recurrence) return '';
    const parsed = parseRRuleString(draft.recurrenceRRule);
    const completedOccurrences = task?.recurrence && typeof task.recurrence === 'object'
        ? task.recurrence.completedOccurrences : undefined;
    const recurrence = {
        rule: draft.recurrence,
        strategy: draft.recurrenceStrategy,
        ...(parsed.byDay?.length ? { byDay: parsed.byDay } : {}),
        ...(parsed.byMonthDay?.length ? { byMonthDay: parsed.byMonthDay } : {}),
        ...(parsed.count ? { count: parsed.count } : {}),
        ...(parsed.until ? { until: parsed.until } : {}),
        ...(typeof completedOccurrences === 'number' ? { completedOccurrences } : {}),
        rrule: editRRuleString(draft.recurrenceRRule, draft.recurrence, {}),
    };
    const nowIso = (input.now ?? new Date()).toISOString();
    const splitTokens = (value: string) => value.split(',').map((token) => token.trim()).filter(Boolean);
    const previewTask: Task = {
        ...(task ?? {}),
        id: task?.id ?? 'draft-recurrence-preview',
        title: draft.title,
        status: draft.status,
        tags: splitTokens(draft.tags),
        contexts: splitTokens(draft.contexts),
        createdAt: task?.createdAt ?? nowIso,
        updatedAt: task?.updatedAt ?? nowIso,
        startTime: draft.startTime || undefined,
        dueDate: draft.dueDate || undefined,
        reviewAt: draft.reviewAt || undefined,
        recurrence,
        showFutureRecurrence: true,
    };
    const label = formatDate(getProjectedRecurringTaskCalendarDate(previewTask, nowIso), 'PP');
    return label ? `${tFallback(t, 'recurrence.nextCalendarPreview', 'Next calendar preview')}: ${label}.` : '';
}

export type TaskEditorMonthlyCustom = {
    interval: number;
    mode: 'date' | 'nth' | 'lastDay';
    ordinal: '1' | '2' | '3' | '4' | '-1';
    weekday: RecurrenceWeekday | 'WEEKDAY';
    monthDays: number[];
};

export type TaskDraftRecurrenceEdit =
    | { kind: 'rule'; rule: RecurrenceRule | '' }
    /** "Repeat every", already parsed (parseRecurrenceIntervalInput). */
    | { kind: 'interval'; interval: number }
    /** Weekly days, the full new list. */
    | { kind: 'weekdays'; weekdays: RecurrenceWeekday[] }
    | { kind: 'monthlyOnDay' }
    | { kind: 'ends'; ends: 'never' | 'until' | 'count' }
    /** The "after N occurrences" input as typed. */
    | { kind: 'count'; text: string }
    /** The end date picked, yyyy-MM-dd. */
    | { kind: 'until'; date: string }
    | { kind: 'strategy' }
    | { kind: 'monthlyCustom'; custom: TaskEditorMonthlyCustom };

const normalizeRecurrenceInterval = (value: number): number => (
    Number.isFinite(value) && value > 0 ? Math.min(Math.round(value), RECURRENCE_INTERVAL_MAX) : 1
);

/** "Repeat every" text as a whole number of units, or null when it is not one. */
export function parseRecurrenceIntervalInput(text: string): number | null {
    const trimmed = text.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) && parsed > 0 ? normalizeRecurrenceInterval(parsed) : null;
}

/** The interval an interval input shows. */
export const getRecurrenceIntervalDisplay = normalizeRecurrenceInterval;

/** Weekly days on a draft rule, in rule order. */
export function getTaskDraftRecurrenceWeekdays(recurrence: RecurrenceRule | '', rrule: string): RecurrenceWeekday[] {
    if (recurrence !== 'weekly') return [];
    return (parseRRuleString(rrule).byDay ?? [])
        .filter((day): day is RecurrenceWeekday => WEEKDAY_ORDER.includes(day as RecurrenceWeekday));
}

/** Where "Ends on date" starts: the rule's end, else the due or start day, else today. */
export function getTaskEditorRecurrenceDefaultUntil(
    draft: Pick<TaskDraft, 'recurrenceRRule' | 'dueDate' | 'startTime'>,
    task: Pick<Task, 'dueDate' | 'startTime'> | null | undefined,
    formatDate: DateFormatter,
    now: Date = new Date(),
): string {
    return parseRRuleString(draft.recurrenceRRule).until
        || formatDate(safeParseDate(draft.dueDate || draft.startTime || task?.dueDate || task?.startTime) ?? now, 'yyyy-MM-dd');
}

/** The custom monthly dialog's starting state for a rule and the monthly anchor day. */
export function getTaskEditorMonthlyCustom(rrule: string, anchorDate: Date): TaskEditorMonthlyCustom {
    const parsed = parseRRuleString(rrule);
    const state: TaskEditorMonthlyCustom = {
        interval: parsed.interval && parsed.interval > 0 ? parsed.interval : 1,
        mode: 'date',
        ordinal: '1',
        weekday: WEEKDAY_ORDER[anchorDate.getDay()],
        monthDays: [anchorDate.getDate()],
    };
    const monthDays = (parsed.byMonthDay ?? []).filter((day) => day === -1 || (day >= 1 && day <= 31));
    if (monthDays.length === 1 && monthDays[0] === -1) {
        state.mode = 'lastDay';
    } else if (monthDays.length > 0) {
        state.monthDays = monthDays;
    }
    const token = parsed.byDay?.find((day) => /^(-1|1|2|3|4)/.test(String(day)));
    const match = token ? String(token).match(/^(-1|1|2|3|4)?(SU|MO|TU|WE|TH|FR|SA)$/) : null;
    if (isMonthlyWeekdaySet(parsed.byDay) && [-1, 1, 2, 3, 4].includes(parsed.bySetPos ?? 0)) {
        state.mode = 'nth';
        state.ordinal = String(parsed.bySetPos) as TaskEditorMonthlyCustom['ordinal'];
        state.weekday = 'WEEKDAY';
    } else if (match) {
        state.mode = 'nth';
        state.ordinal = (match[1] ?? '1') as TaskEditorMonthlyCustom['ordinal'];
        state.weekday = match[2] as RecurrenceWeekday;
    }
    return state;
}

/** The monthly rule the custom dialog saves; the rule's end carries over. */
export function buildTaskEditorMonthlyCustomRRule(rrule: string, custom: TaskEditorMonthlyCustom): string {
    const parsed = parseRRuleString(rrule);
    const intervalValue = Number(custom.interval);
    const interval = Number.isFinite(intervalValue) && intervalValue > 0 ? intervalValue : 1;
    const ends = { count: parsed.count, until: parsed.until };
    // buildRRuleString clamps, dedupes and sorts the day list.
    return custom.mode === 'nth'
        ? buildRRuleString('monthly', custom.weekday === 'WEEKDAY'
            ? MONTHLY_WEEKDAYS
            : [`${custom.ordinal}${custom.weekday}` as RecurrenceByDay], interval, {
            ...ends,
            bySetPos: custom.weekday === 'WEEKDAY' ? Number(custom.ordinal) : undefined,
        })
        : buildRRuleString('monthly', undefined, interval, {
            ...ends,
            byMonthDay: custom.mode === 'lastDay' ? [-1] : (custom.monthDays.length > 0 ? custom.monthDays : [1]),
        });
}

/**
 * A recurrence control's edit, as the editor applies it. Rule and ends edits use
 * editRRuleString to preserve fields they do not override, including opaque
 * tokens. `weekdays` is the weekly day selection shown.
 */
export function editTaskDraftRecurrence(
    current: TaskDraftRecurrence,
    edit: TaskDraftRecurrenceEdit,
    context: { weekdays: readonly RecurrenceWeekday[]; defaultUntil: string },
): TaskDraftRecurrence {
    const parsed = parseRRuleString(current.recurrenceRRule);
    const rule = current.recurrence;
    const build = (
        nextRule: RecurrenceRule,
        overrides: RRuleEditOverrides,
        strategy: RecurrenceStrategy = current.recurrenceStrategy,
    ): TaskDraftRecurrence => ({
        recurrence: nextRule,
        recurrenceStrategy: strategy === 'fluid' ? 'fluid' : 'strict',
        recurrenceRRule: editRRuleString(current.recurrenceRRule, nextRule, overrides),
    });
    const sameRuleInterval = (target: RecurrenceRule) => (
        parsed.rule === target && parsed.interval && parsed.interval > 0 ? parsed.interval : 1
    );
    const weekdays = [...context.weekdays];
    switch (edit.kind) {
        case 'rule':
            if (edit.rule === rule) return current;
            if (!edit.rule) return { recurrence: '', recurrenceStrategy: 'strict', recurrenceRRule: '' };
            if (edit.rule === 'weekly') return build('weekly', { byDay: undefined, byMonthDay: undefined, interval: undefined });
            return build(edit.rule, { byDay: undefined, byMonthDay: undefined, interval: sameRuleInterval(edit.rule) });
        case 'weekdays':
            return build('weekly', { byDay: [...edit.weekdays], byMonthDay: undefined });
        case 'monthlyOnDay':
            return build('monthly', { byDay: undefined, byMonthDay: undefined });
        case 'monthlyCustom':
            return {
                recurrence: 'monthly',
                recurrenceStrategy: current.recurrenceStrategy,
                recurrenceRRule: buildTaskEditorMonthlyCustomRRule(current.recurrenceRRule, edit.custom),
            };
        default:
            break;
    }
    if (!rule) return current;
    switch (edit.kind) {
        case 'interval':
            if (rule === 'weekly') {
                return build('weekly', {
                    ...(weekdays.length > 0 ? { byDay: weekdays } : {}),
                    byMonthDay: undefined,
                    interval: edit.interval,
                });
            }
            if (rule === 'monthly') return build('monthly', { interval: edit.interval });
            return build(rule, { byDay: undefined, byMonthDay: undefined, interval: edit.interval });
        case 'ends':
            if (edit.ends === 'never') return build(rule, { count: undefined, until: undefined });
            if (edit.ends === 'until') return build(rule, { count: undefined, until: parsed.until || context.defaultUntil });
            return build(rule, { count: parsed.count ?? 1, until: undefined });
        case 'count': {
            const value = Number.parseInt(edit.text, 10);
            const count = Number.isFinite(value) && value > 0 ? Math.min(value, 999) : 1;
            return build(rule, { count, until: undefined });
        }
        case 'until':
            return build(rule, { count: undefined, until: edit.date });
        case 'strategy':
            return build(
                rule,
                {},
                current.recurrenceStrategy === 'fluid' ? 'strict' : 'fluid',
            );
        default:
            return current;
    }
}

export type TaskEditorRecurrenceDetails = {
    /** "Repeat every" for the draft's rule. */
    interval: number;
    ends: 'never' | 'until' | 'count';
    /** "After N occurrences", as the input shows it. */
    count: number;
    /** The end date, or where "Ends on date" starts. */
    until: string;
    untilLabel: string;
};

/** Time-independent recurrence input values shared by display and Save validation. */
export function getTaskEditorRecurrenceInputValues(
    draft: Pick<TaskDraft, 'recurrence' | 'recurrenceRRule'>,
    dailyInterval: number,
): Pick<TaskEditorRecurrenceDetails, 'interval' | 'count' | 'ends'> {
    const parsed = parseRRuleString(draft.recurrenceRRule);
    const intervalByRule: Record<RecurrenceRule, number> = {
        daily: dailyInterval,
        weekly: parsed.interval ?? 1,
        monthly: parsed.interval && parsed.interval > 0 ? parsed.interval : 1,
        yearly: parsed.interval ?? 1,
    };
    return {
        interval: normalizeRecurrenceInterval(draft.recurrence ? intervalByRule[draft.recurrence] : 1),
        ends: parsed.count ? 'count' : parsed.until ? 'until' : 'never',
        count: Math.max(parsed.count ?? 1, 1),
    };
}

export function getTaskEditorRecurrenceDetails(input: {
    draft: Pick<TaskDraft, 'recurrence' | 'recurrenceRRule' | 'dueDate' | 'startTime'>;
    task: Pick<Task, 'dueDate' | 'startTime'> | null;
    dailyInterval: number;
    t: Translate;
    formatDate: DateFormatter;
    now: Date;
}): TaskEditorRecurrenceDetails {
    const { draft, formatDate } = input;
    const values = getTaskEditorRecurrenceInputValues(draft, input.dailyInterval);
    const until = getTaskEditorRecurrenceDefaultUntil(draft, input.task, formatDate, input.now);
    return {
        ...values,
        until,
        untilLabel: formatTaskEditorDate(until, formatDate, input.t('common.notSet')),
    };
}

/** Weekly day buttons in week order: `label` is narrow, `longLabel` names the day. */
export function getTaskEditorWeekdayButtons(
    language: string | undefined,
    selected: readonly RecurrenceWeekday[],
): Array<{ day: RecurrenceWeekday; label: string; longLabel: string; selected: boolean }> {
    const longLabels = getLocalizedWeekdayLabels(language, 'long');
    return getLocalizedWeekdayButtons(language, 'narrow').map(({ key, label }) => ({
        day: key,
        label,
        longLabel: longLabels[key],
        selected: selected.includes(key),
    }));
}
