import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { formatTimeEstimateLabel } from './calendar-scheduling';
import { createDateFormatter, hasTimeComponent, normalizeClockTimeInput, safeParseDate, type DateFormatter } from './date';
import { loadTranslations } from './i18n/i18n-loader';
import { normalizeRecurrenceForLoad } from './recurrence';
import { WEEKDAY_ORDER } from './recurrence-constants';
import { applyTaskUpdates } from './store-helpers';
import { createTaskDraft, setTaskDraftField, type TaskDraft, type TaskDraftField } from './task-draft';
import { getTaskEditorDateIssueLabel } from './task-date-coherence';
import {
    buildTaskEditUpdatePatch,
    getTaskEditorDailyInterval,
    getTaskEditorMonthlyAnchorSource,
    getTaskEditorMonthlyPattern,
    resolveTaskEditorMonthlyAnchorDate,
} from './task-editor-model';
import {
    buildTaskEditorMonthlyCustomRRule,
    editTaskDraftRecurrence,
    getTaskDraftDateEdit,
    getTaskDraftDateOnly,
    getTaskDraftRecurrenceWeekdays,
    getTaskDraftRelativeStartEdit,
    getTaskEditorDatePart,
    getTaskEditorMonthlyCustom,
    getTaskEditorRecurrenceDefaultUntil,
    getTaskEditorRecurrenceDetails,
    getTaskEditorRecurrenceCalendarPreviewHint,
    getTaskEditorRelativeStart,
    getTaskEditorReminders,
    getTaskEditorTimeEstimate,
    getTaskEditorWeekdayButtons,
    isTaskEditorTimeSpentEnabled,
    parseRecurrenceIntervalInput,
    parseTaskEditorTimeEstimate,
    parseTaskEditorTimeSpent,
    setTaskDraftDate,
    setTaskDraftTime,
    type TaskDraftRecurrenceEdit,
    type TaskEditorDateField,
    type TaskEditorMonthlyCustom,
} from './task-editor-schedule';
import type { AppSettings, RecurrenceRule, RecurrenceWeekday, Task } from './types';

type DateDisplay = [string | null, boolean, string[], boolean, Array<[string, boolean]>, string, string[], boolean | null];
type OpDateDisplay = [string | null, string[], boolean, string, string[], boolean | null];
type RecurrenceDisplay = {
    rules: boolean[];
    interval: string[];
    weekdays: string[];
    monthly: boolean[];
    ends: boolean[];
    count: string[];
    untilLabel: string[];
    strategy: boolean;
};

const fixture = JSON.parse(
    readFileSync(new URL('./task-editor-schedule-parity.fixtures.json', import.meta.url), 'utf8'),
) as {
    timeZone: string;
    now: string;
    tasks: Task[];
    settings: Record<string, AppSettings>;
    formats: Record<string, { language: string; dateFormat: string; timeFormat: string; systemLocale: string }>;
    flagSettings: Record<string, AppSettings>;
    mobileSnapshot: {
        display: Record<string, DateDisplay | RecurrenceDisplay>;
        ops: Record<string, [unknown[], OpDateDisplay | RecurrenceDisplay]>;
        custom: Record<string, [TaskEditorMonthlyCustom, string[]]>;
        estimates: Record<string, [unknown, string[]]>;
        timeSpentFlags: Record<string, boolean>;
    };
};
const snapshot = fixture.mobileSnapshot;
const tasksById = new Map(fixture.tasks.map((task) => [task.id, task]));
const RULE_KEYS: Array<RecurrenceRule | ''> = ['', 'daily', 'weekly', 'monthly', 'yearly'];

const encodeDraft = (draft: TaskDraft) => [
    draft.startTime, draft.dueDate, draft.reviewAt, draft.relativeStartOffset ?? null, draft.recurrence,
    draft.recurrenceStrategy, draft.recurrenceRRule, draft.repeatReminderMinutes ?? null,
    draft.suppressMindwtrReminders, draft.timeEstimate, draft.timeSpentMinutes ?? null,
];

const applyFields = (draft: TaskDraft, fields: Partial<TaskDraft>) => {
    let next = draft;
    for (const [field, value] of Object.entries(fields)) {
        next = setTaskDraftField(next, field as TaskDraftField, value as never);
    }
    return next;
};

describe('task editor schedule parity with the mobile editor', () => {
    const originalTz = process.env.TZ;
    let t: (key: string) => string = (key) => key;
    let now: Date;
    beforeAll(async () => {
        process.env.TZ = fixture.timeZone;
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(fixture.now));
        now = new Date();
        const english = await loadTranslations('en');
        t = (key) => english[key] || key;
    });
    afterAll(() => {
        vi.useRealTimers();
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    });

    const dateDisplay = (draft: TaskDraft, field: TaskEditorDateField, formatDate: DateFormatter): DateDisplay => {
        const part = getTaskEditorDatePart(field, draft[field], { t, now, formatDate });
        const reminders = getTaskEditorReminders(draft, t);
        const aria = field === 'dueDate' ? 'task.aria.dueTime' : 'task.aria.startTime';
        return [
            field === 'dueDate' && !part.value ? null : part.label,
            field === 'dueDate' && !part.value,
            field !== 'reviewAt' && part.time ? [`${t(aria)}: ${part.time}`] : [],
            Boolean(part.value) && part.hasTime,
            part.quickDates.map((chip) => [chip.label, chip.selected]),
            field === 'reviewAt' ? '' : getTaskEditorDateIssueLabel(draft, t),
            field === 'dueDate' && reminders.showRepeat ? [`${reminders.repeatLabel}: ${reminders.repeatValueLabel}`] : [],
            field === 'dueDate' && reminders.showSkip ? draft.suppressMindwtrReminders : null,
        ];
    };

    const recurrenceDisplay = (task: Task, draft: TaskDraft, weekdays: RecurrenceWeekday[], formatDate: DateFormatter): RecurrenceDisplay => {
        const anchor = resolveTaskEditorMonthlyAnchorDate(getTaskEditorMonthlyAnchorSource(task, draft), now);
        const details = getTaskEditorRecurrenceDetails({
            draft, task, dailyInterval: getTaskEditorDailyInterval(draft.recurrence, draft.recurrenceRRule), t, formatDate, now,
        });
        const rule = draft.recurrence;
        const monthly = rule === 'monthly' ? getTaskEditorMonthlyPattern(rule, draft.recurrenceRRule, anchor) : null;
        return {
            rules: RULE_KEYS.map((key) => key === rule),
            interval: rule ? [String(details.interval)] : [],
            weekdays: rule === 'weekly'
                ? getTaskEditorWeekdayButtons('en', weekdays).filter((day) => day.selected).map((day) => day.day)
                : [],
            monthly: [monthly === 'date', monthly === 'custom'],
            ends: rule ? [details.ends === 'never', details.ends === 'until', details.ends === 'count'] : [false, false, false],
            count: rule && details.ends === 'count' ? [String(details.count)] : [],
            untilLabel: rule && details.ends === 'until' ? [details.untilLabel] : [],
            strategy: Boolean(rule) && draft.recurrenceStrategy === 'fluid',
        };
    };

    it('shows the same date fields, chips, warnings and reminder controls', () => {
        const display: Record<string, unknown> = {};
        for (const key of Object.keys(snapshot.display)) {
            const [taskId, formatName, field] = key.split('|');
            const task = tasksById.get(taskId)!;
            const formatDate = createDateFormatter(fixture.formats[formatName]);
            const draft = createTaskDraft(task);
            display[key] = field === 'recurrence'
                ? recurrenceDisplay(task, draft, getTaskDraftRecurrenceWeekdays(draft.recurrence, draft.recurrenceRRule), formatDate)
                : dateDisplay(draft, field as TaskEditorDateField, formatDate);
        }
        expect(display).toEqual(snapshot.display);
    });

    // The mobile editor after the move: core computes each draft write; React keeps
    // the picker's pending day and the weekly day selection as UI state.
    const replayDateOp = (task: Task, settings: AppSettings, field: TaskEditorDateField, op: string) => {
        const formatDate = createDateFormatter(fixture.formats.us);
        const defaultScheduleTime = normalizeClockTimeInput(settings.gtd?.defaultScheduleTime) || '';
        let draft = createTaskDraft(task);
        let pending: Date | null = null;
        const edit = (target: TaskEditorDateField, value: string) => {
            draft = applyFields(draft, getTaskDraftDateEdit(target, value));
        };
        const pickDay = (target: TaskEditorDateField, day: Date) => {
            const value = setTaskDraftDate(target, draft[target], day, { defaultScheduleTime, formatDate });
            pending = hasTimeComponent(value) ? safeParseDate(value) : new Date(day);
            edit(target, value);
        };
        // The picked hour and minute, as a host sends them.
        const pickTime = (target: TaskEditorDateField, time: string) => {
            const [hours, minutes] = time.split(':').map(Number);
            edit(target, setTaskDraftTime(draft[target], { hours, minutes }, pending));
            pending = null;
        };
        const relative = () => {
            const control = getTaskEditorRelativeStart(draft, t);
            const patch = control && getTaskDraftRelativeStartEdit(draft.dueDate, control.amount, control.unit);
            if (patch) draft = applyFields(draft, patch);
        };
        // Only the picked local day matters.
        const day = (value: string) => {
            const [year, month, date] = value.split('-').map(Number);
            return new Date(year, month - 1, date, 12, 0, 0);
        };
        const steps = op.split('+');
        for (const step of steps) {
            const [name, arg] = step.includes(':') ? [step.slice(0, step.indexOf(':')), step.slice(step.indexOf(':') + 1)] : [step, ''];
            if (name === 'due') {
                pickDay('dueDate', day(arg.slice('pick:'.length)));
            } else if (name === 'pick') {
                pickDay(field, day(arg));
            } else if (name === 'time') {
                pickTime(field, arg);
            } else if (name === 'chip') {
                const label = t(arg);
                const chip = getTaskEditorDatePart(field, draft[field], { t, now, formatDate, defaultScheduleTime })
                    .quickDates.find((entry) => entry.label === label)!;
                edit(field, chip.value);
            } else if (name === 'dateOnly') {
                if (draft[field] && hasTimeComponent(draft[field])) edit(field, getTaskDraftDateOnly(draft[field], formatDate));
            } else if (name === 'clear') {
                if (draft[field]) edit(field, '');
            } else if (name === 'relative') {
                relative();
            } else if (name === 'absolute') {
                if (draft.dueDate) draft = setTaskDraftField(draft, 'relativeStartOffset', undefined);
            } else if (name === 'unit') {
                const control = getTaskEditorRelativeStart(draft, t);
                const unit = control?.units.find((entry) => entry.label === t(`taskEdit.${arg}`));
                const patch = control?.active && unit ? getTaskDraftRelativeStartEdit(draft.dueDate, control.amount, unit.unit) : null;
                if (patch) draft = applyFields(draft, patch);
            } else if (name === 'amount') {
                const control = getTaskEditorRelativeStart(draft, t);
                const patch = control?.active ? getTaskDraftRelativeStartEdit(draft.dueDate, Number(arg), control.unit) : null;
                if (patch) draft = applyFields(draft, patch);
            } else if (name === 'skip') {
                if (getTaskEditorReminders(draft, t).showSkip) {
                    draft = setTaskDraftField(draft, 'suppressMindwtrReminders', !draft.suppressMindwtrReminders);
                }
            } else if (name === 'repeat') {
                const reminders = getTaskEditorReminders(draft, t);
                const option = reminders.repeatOptions.find((entry) => (entry.value ?? 0) === Number(arg));
                if (reminders.showRepeat && option) draft = setTaskDraftField(draft, 'repeatReminderMinutes', option.value ?? undefined);
            } else {
                throw new Error(`Unknown step ${step}`);
            }
        }
        const [label, , time, dateOnly, , issue, repeat, skip] = dateDisplay(draft, field, formatDate);
        return [encodeDraft(draft), [label ?? null, time, dateOnly, issue, repeat, skip]];
    };

    it('writes the same draft on DST days, for a skipped and a repeated hour, and late in the evening', () => {
        const dst = (fixture as unknown as { dstSnapshot: { tasks: Task[]; ops: Record<string, unknown> } }).dstSnapshot;
        const dstTasks = new Map(dst.tasks.map((task) => [task.id, task]));
        const ops: Record<string, unknown> = {};
        try {
            for (const key of Object.keys(dst.ops)) {
                const [clock, taskId, settingsName, field, op] = key.split('|');
                vi.setSystemTime(new Date(clock));
                now = new Date();
                ops[key] = replayDateOp(dstTasks.get(taskId)!, fixture.settings[settingsName], field as TaskEditorDateField, op);
            }
        } finally {
            vi.setSystemTime(new Date(fixture.now));
            now = new Date();
        }
        expect(Object.keys(ops).length).toBeGreaterThan(600);
        expect(ops).toEqual(dst.ops);
        // Spelled out: 02:30 does not exist on 2027-03-14 and becomes 03:30; on 2027-03-20
        // (picked while today is 2027-03-14) it stays 02:30; 23:30 stays on its own day.
        const due = (key: string) => (dst.ops[key] as [string[]])[0][1];
        expect(safeParseDate(due('2027-03-14T10:00:00|spring-day|plain|dueDate|time:02:30'))?.getHours()).toBe(3);
        expect(safeParseDate(due('2027-03-14T10:00:00|spring-week|plain|dueDate|time:02:30'))?.getHours()).toBe(2);
        const late = safeParseDate(due('2027-03-14T10:00:00|spring-week|plain|dueDate|time:23:30'));
        expect([late?.getDate(), late?.getHours(), late?.getMinutes()]).toEqual([20, 23, 30]);
    });

    const replayRecurrenceOp = (task: Task, op: string) => {
        const formatDate = createDateFormatter(fixture.formats.us);
        let draft = createTaskDraft(task);
        let weekdays = getTaskDraftRecurrenceWeekdays(draft.recurrence, draft.recurrenceRRule);
        let typedInterval: string | null = null;
        const apply = (edit: TaskDraftRecurrenceEdit) => {
            const next = editTaskDraftRecurrence(draft, edit, {
                weekdays,
                defaultUntil: getTaskEditorRecurrenceDefaultUntil(draft, task, formatDate, now),
            });
            draft = applyFields(draft, next);
        };
        for (const rawStep of op.split('+')) {
            // "weekday:MO+TH" presses Monday, then Thursday.
            const step = WEEKDAY_ORDER.includes(rawStep as RecurrenceWeekday) ? `weekday:${rawStep}` : rawStep;
            const [name, arg] = [step.slice(0, step.indexOf(':') === -1 ? step.length : step.indexOf(':')), step.slice(step.indexOf(':') + 1)];
            if (name === 'rule') {
                const rule = arg.replace('recurrence.', '').replace('none', '') as RecurrenceRule | '';
                if (rule !== 'weekly') weekdays = [];
                apply({ kind: 'rule', rule });
            } else if (name === 'interval') {
                if (!draft.recurrence) continue;
                typedInterval = arg;
                apply({ kind: 'interval', interval: parseRecurrenceIntervalInput(arg) ?? 1 });
            } else if (name === 'weekday') {
                if (draft.recurrence !== 'weekly') continue;
                const day = arg as RecurrenceWeekday;
                weekdays = weekdays.includes(day) ? weekdays.filter((value) => value !== day) : [...weekdays, day];
                apply({ kind: 'weekdays', weekdays });
            } else if (name === 'monthlyOnDay') {
                if (draft.recurrence === 'monthly') apply({ kind: 'monthlyOnDay' });
            } else if (name === 'end') {
                if (draft.recurrence) apply({ kind: 'ends', ends: arg as 'never' | 'until' | 'count' });
            } else if (name === 'text') {
                if (draft.recurrence) apply({ kind: 'count', text: arg });
            } else if (name === 'pick' || name === 'until') {
                apply({ kind: 'until', date: '2027-02-01' });
            } else if (name === 'strategy') {
                if (draft.recurrence) apply({ kind: 'strategy' });
            } else {
                throw new Error(`Unknown step ${step}`);
            }
        }
        const display = recurrenceDisplay(task, draft, weekdays, formatDate);
        // The interval input keeps the text as typed until it is left.
        if (typedInterval !== null && draft.recurrence) display.interval = [typedInterval];
        return [encodeDraft(draft), display];
    };

    it('writes the same draft for every date, reminder and relative start control', () => {
        const ops: Record<string, unknown> = {};
        const expected: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(snapshot.ops)) {
            const [taskId, settingsName, field, op] = key.split('|');
            if (field === 'recurrence') continue;
            ops[key] = replayDateOp(tasksById.get(taskId)!, fixture.settings[settingsName], field as TaskEditorDateField, op);
            expected[key] = value;
        }
        expect(Object.keys(ops).length).toBeGreaterThan(1000);
        expect(ops).toEqual(expected);
    });

    it('writes the same rule for every recurrence control, keeping ends across rule changes', () => {
        const ops: Record<string, unknown> = {};
        const expected: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(snapshot.ops)) {
            const [taskId, , field, op] = key.split('|');
            if (field !== 'recurrence') continue;
            ops[key] = replayRecurrenceOp(tasksById.get(taskId)!, op);
            expected[key] = value;
        }
        expect(ops).toEqual(expected);
        // The native review's case, spelled out: Weekly with COUNT=5, then Daily.
        expect((snapshot.ops['weekly-count|plain|recurrence|rule:recurrence.daily'][0] as string[])[6]).toBe('FREQ=DAILY;COUNT=5');
    });

    it('opens and saves the custom monthly dialog the same way', () => {
        const custom: Record<string, unknown> = {};
        for (const key of Object.keys(snapshot.custom)) {
            const [anchor, rrule] = key.split('|');
            const [year, month, day] = anchor.slice(0, 10).split('-').map(Number);
            const state = getTaskEditorMonthlyCustom(rrule, new Date(year, month - 1, day, anchor.includes('T') ? 10 : 0, 0, 0));
            custom[key] = [state, [
                state,
                { ...state, mode: 'nth', ordinal: '-1', weekday: 'SU', interval: 3 },
                { ...state, mode: 'lastDay', interval: 0 },
                { ...state, mode: 'date', monthDays: [] },
                { ...state, mode: 'date', monthDays: [31, 5, 5] },
            ].map((entry) => buildTaskEditorMonthlyCustomRRule(rrule, entry as TaskEditorMonthlyCustom))];
        }
        expect(custom).toEqual(snapshot.custom);
    });

    it('round-trips the last weekday through the shared custom monthly editor', () => {
        const rrule = 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1';
        const anchor = new Date(2026, 0, 30);
        expect(getTaskEditorMonthlyPattern('monthly', rrule, anchor)).toBe('custom');
        const state = getTaskEditorMonthlyCustom(rrule, anchor);
        expect(state).toMatchObject({ mode: 'nth', ordinal: '-1', weekday: 'WEEKDAY' });
        expect(buildTaskEditorMonthlyCustomRRule(rrule, state))
            .toBe('FREQ=MONTHLY;BYDAY=FR,MO,TH,TU,WE;BYSETPOS=-1');
    });

    it('parses custom estimates and time spent the same way', () => {
        for (const [key, [value, text]] of Object.entries(snapshot.estimates)) {
            const [taskId, step, typed, blur] = key.split('|');
            const task = tasksById.get(taskId)!;
            if (step === 'open') {
                const model = getTaskEditorTimeEstimate(task.timeEstimate ?? '', t);
                expect([task.timeEstimate ?? '', model.customSelected ? [model.customText] : []], key).toEqual([value, text]);
            } else if (step === 'custom' && !typed) {
                const model = getTaskEditorTimeEstimate(task.timeEstimate ?? '', t);
                expect([model.customValue, [getTaskEditorTimeEstimate(model.customValue, t).customText]], key).toEqual([value, text]);
            } else if (step === 'custom') {
                const input = typed.slice('type:'.length);
                const parsed = parseTaskEditorTimeEstimate(input);
                if (parsed) expect(parsed, key).toBe(value);
                // A text that does not parse keeps the estimate, and leaving the input restores its text.
                if (!parsed && blur) expect(text, key).toEqual([formatTimeEstimateLabel(value as never)]);
                if (!blur || parsed) expect(text, key).toEqual([input]);
            } else if (step === 'spent' && typed) {
                const minutes = parseTaskEditorTimeSpent(typed.slice('type:'.length)) ?? null;
                expect([minutes, [minutes === null ? '' : String(minutes)]], key).toEqual([value, text]);
            }
        }
        expect(Object.fromEntries(Object.entries(fixture.flagSettings).map(([name, settings]) => [
            name, isTaskEditorTimeSpentEnabled(settings),
        ]))).toEqual(snapshot.timeSpentFlags);
    });
});

describe('task editor schedule rules', () => {
    const originalTz = process.env.TZ;
    beforeAll(() => {
        process.env.TZ = 'America/New_York';
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-23T10:00:00'));
    });
    afterAll(() => {
        vi.useRealTimers();
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    });
    const formatDate = createDateFormatter({ language: 'en' });
    const base: Task = { id: 't', title: 'T', status: 'next', tags: [], contexts: [], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' };

    it.each([
        ['strict', 'BYDAY=2TU'],
        ['fluid', 'BYDAY=2TU'],
        ['strict', 'BYDAY=FR,MO,TH,TU,WE;BYSETPOS=-1'],
        ['fluid', 'BYDAY=FR,MO,TH,TU,WE;BYSETPOS=-1'],
    ] as const)('keeps the monthly weekday pattern when toggling %s strategy (%s)', (strategy, pattern) => {
        const current = {
            recurrence: 'monthly' as const,
            recurrenceStrategy: strategy,
            recurrenceRRule: `FREQ=MONTHLY;INTERVAL=2;${pattern};COUNT=5;X-FOO=bar`,
        };
        const context = { weekdays: [], defaultUntil: '2026-09-30' };
        const next = editTaskDraftRecurrence(current, { kind: 'strategy' }, context);
        expect(next).toEqual({ ...current, recurrenceStrategy: strategy === 'strict' ? 'fluid' : 'strict' });
        expect(editTaskDraftRecurrence(next, { kind: 'strategy' }, context)).toEqual(current);
    });

    it('keeps the active weekly rule and its selected days on repeated taps', () => {
        const current = {
            recurrence: 'weekly' as const,
            recurrenceStrategy: 'fluid' as const,
            recurrenceRRule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;COUNT=5;WKST=SU;X-FOO=bar',
        };
        const context = { weekdays: ['MO', 'TH'] as RecurrenceWeekday[], defaultUntil: '2026-09-30' };
        const next = editTaskDraftRecurrence(current, { kind: 'rule', rule: 'weekly' }, context);
        expect(next).toEqual(current);
        expect(editTaskDraftRecurrence(next, { kind: 'rule', rule: 'weekly' }, context)).toEqual(current);
    });

    it('keeps week start and opaque tokens when picking an end date, replacing count', () => {
        const current = {
            recurrence: 'weekly' as const,
            recurrenceStrategy: 'fluid' as const,
            recurrenceRRule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;COUNT=5;WKST=SU;X-FOO=bar',
        };
        const context = { weekdays: [], defaultUntil: '2026-09-30' };
        const next = editTaskDraftRecurrence(current, { kind: 'until', date: '2026-12-31' }, context);
        expect(next).toEqual({
            ...current,
            recurrenceRRule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;WKST=SU;UNTIL=20261231;X-FOO=bar',
        });
        expect(editTaskDraftRecurrence(next, { kind: 'until', date: '2026-12-31' }, context)).toEqual(next);
    });

    it('preserves recurrence patterns and date precision through load, edit, save and re-edit across the schedule matrix', () => {
        const patterns: Array<[RecurrenceRule, string, string]> = [
            ['daily', 'FREQ=DAILY;INTERVAL=2', 'INTERVAL=2'],
            ['weekly', 'FREQ=WEEKLY;BYDAY=MO,TH;WKST=SU', 'BYDAY=MO,TH;WKST=SU'],
            ['monthly', 'FREQ=MONTHLY;BYMONTHDAY=15', 'BYMONTHDAY=15'],
            ['monthly', 'FREQ=MONTHLY;BYDAY=2TU', 'BYDAY=2TU'],
            ['monthly', 'FREQ=MONTHLY;BYDAY=FR,MO,TH,TU,WE;BYSETPOS=-1', 'BYDAY=FR,MO,TH,TU,WE;BYSETPOS=-1'],
            ['yearly', 'FREQ=YEARLY;INTERVAL=2', 'INTERVAL=2'],
            ['daily', 'FREQ=DAILY;COUNT=5', 'FREQ=DAILY'],
        ];
        for (const strategy of ['strict', 'fluid'] as const) {
            for (const timed of [false, true]) {
                for (const schedule of ['start', 'due', 'both', 'neither']) {
                    for (const [rule, rrule, pattern] of patterns) {
                        const date = timed ? '2026-09-25T14:30' : '2026-09-25';
                        let stored: Task = {
                            ...base,
                            startTime: schedule === 'start' || schedule === 'both' ? date : undefined,
                            dueDate: schedule === 'due' || schedule === 'both' ? date : undefined,
                            recurrence: normalizeRecurrenceForLoad({ rule, strategy, rrule: `${rrule};X-FOO=bar` }),
                        };
                        const initial = createTaskDraft(stored);
                        for (const edit of [
                            { kind: 'strategy' }, { kind: 'rule', rule }, { kind: 'until', date: '2026-12-31' },
                        ] satisfies TaskDraftRecurrenceEdit[]) {
                            const draft = createTaskDraft(stored);
                            const context = {
                                weekdays: getTaskDraftRecurrenceWeekdays(rule, draft.recurrenceRRule),
                                defaultUntil: '2026-09-30',
                            };
                            const edited = applyFields(draft, editTaskDraftRecurrence(draft, edit, context));
                            expect(edited.recurrenceRRule).toContain(pattern);
                            expect(edited.recurrenceRRule).toContain('X-FOO=bar');
                            expect([edited.startTime, edited.dueDate]).toEqual([initial.startTime, initial.dueDate]);
                            const patch = buildTaskEditUpdatePatch({ draft: edited, checklist: stored.checklist, attachments: stored.attachments }, stored);
                            if (patch) stored = applyTaskUpdates(stored, patch, '2026-09-23T14:00:00.000Z').updatedTask;
                            const reloaded = createTaskDraft(stored);
                            expect(reloaded.recurrenceRRule).toContain(pattern);
                            expect(reloaded.recurrenceRRule).toContain('X-FOO=bar');
                            expect(reloaded.recurrenceStrategy).toBe(strategy === 'strict' ? 'fluid' : 'strict');
                            expect([reloaded.startTime, reloaded.dueDate]).toEqual([initial.startTime, initial.dueDate]);
                            expect(normalizeRecurrenceForLoad(stored.recurrence)).toEqual(stored.recurrence);
                            if (edit.kind === 'until') {
                                expect(reloaded.recurrenceRRule).toContain('UNTIL=20261231');
                                expect(reloaded.recurrenceRRule).not.toContain('COUNT=');
                                expect(editTaskDraftRecurrence(reloaded, edit, context)).toMatchObject({ recurrenceRRule: reloaded.recurrenceRRule });
                            }
                        }
                    }
                }
            }
        }
    });

    it('keeps date-only values date-only and keeps an existing time on a new day', () => {
        const day = new Date(2026, 9, 3, 7, 45);
        expect(setTaskDraftDate('dueDate', '2026-09-25', day, { formatDate })).toBe('2026-10-03');
        expect(setTaskDraftDate('dueDate', '', day, { formatDate })).toBe('2026-10-03');
        expect(safeParseDate(setTaskDraftDate('dueDate', '2026-09-25T14:30', day, { formatDate }))?.getHours()).toBe(14);
        expect(setTaskDraftDate('reviewAt', '2026-09-25T14:30', day, { formatDate })).toBe('2026-10-03T14:30');
        expect(setTaskDraftDate('startTime', '2026-09-25', day, { formatDate, defaultScheduleTime: '09:05' })).toBe('2026-10-03T09:05');
        expect(safeParseDate(setTaskDraftTime('2026-09-25', { hours: 16, minutes: 20 }))?.toString())
            .toBe(new Date(2026, 8, 25, 16, 20).toString());
    });

    it('moves a relative start with its due date and ends the link on a hand-set start', () => {
        const draft = createTaskDraft({ ...base, dueDate: '2026-09-28', startTime: '2026-09-26', relativeStartOffset: { amount: -2, unit: 'day' } });
        const moved = setTaskDraftField(draft, 'dueDate', '2026-10-05');
        expect(moved).toMatchObject({ startTime: '2026-10-03', relativeStartOffset: { amount: -2, unit: 'day' } });
        expect(setTaskDraftField(draft, 'dueDate', '').relativeStartOffset).toBeUndefined();
        // Hours cannot be computed before a date-only due: the link ends.
        const hours = createTaskDraft({ ...base, dueDate: '2026-09-28T18:00', startTime: '2026-09-28T15:00', relativeStartOffset: { amount: -3, unit: 'hour' } });
        expect(setTaskDraftField(hours, 'dueDate', '2026-09-28')).toMatchObject({ startTime: '2026-09-28T15:00', relativeStartOffset: undefined });
        expect(setTaskDraftField(draft, 'startTime', '2026-09-25').relativeStartOffset).toBeUndefined();
        // The start the link computes keeps it, so "offset, then its start" writes both.
        const relative = applyFields(createTaskDraft({ ...base, dueDate: '2026-09-28' }), getTaskDraftRelativeStartEdit('2026-09-28', 1, 'week')!);
        expect(relative).toMatchObject({ startTime: '2026-09-21', relativeStartOffset: { amount: -1, unit: 'week' } });
        // The editor's start controls end the link even on the computed start.
        expect(applyFields(draft, getTaskDraftDateEdit('startTime', '2026-09-26')).relativeStartOffset).toBeUndefined();
    });

    it('saves a moved relative start with its link, so the store keeps it', () => {
        const stored: Task = { ...base, dueDate: '2026-09-28', startTime: '2026-09-26', relativeStartOffset: { amount: -2, unit: 'day' } };
        const draft = setTaskDraftField(createTaskDraft(stored), 'dueDate', '2026-10-05');
        const patch = buildTaskEditUpdatePatch({ draft, checklist: undefined, attachments: undefined }, stored)!;
        expect(patch).toEqual({ dueDate: '2026-10-05', startTime: '2026-10-03', relativeStartOffset: { amount: -2, unit: 'day' } });
        expect(applyTaskUpdates(stored, patch, '2026-09-23T14:00:00.000Z').updatedTask).toMatchObject({
            dueDate: '2026-10-05', startTime: '2026-10-03', relativeStartOffset: { amount: -2, unit: 'day' },
        });
        // An unrelated edit does not send the link.
        const titled = setTaskDraftField(createTaskDraft(stored), 'title', 'Renamed');
        expect(buildTaskEditUpdatePatch({ draft: titled, checklist: undefined, attachments: undefined }, stored)).toEqual({ title: 'Renamed' });
    });

    it('keeps count and end date across rule changes, and the tokens it does not own', () => {
        const context = { weekdays: [] as RecurrenceWeekday[], defaultUntil: '2026-09-30' };
        const weekly = { recurrence: 'weekly' as const, recurrenceStrategy: 'strict' as const, recurrenceRRule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=5;X-A=1' };
        expect(editTaskDraftRecurrence(weekly, { kind: 'rule', rule: 'daily' }, context).recurrenceRRule).toBe('FREQ=DAILY;COUNT=5;X-A=1');
        expect(editTaskDraftRecurrence(weekly, { kind: 'rule', rule: 'monthly' }, context).recurrenceRRule).toBe('FREQ=MONTHLY;COUNT=5;X-A=1');
        const until = { ...weekly, recurrenceRRule: 'FREQ=WEEKLY;UNTIL=20261231' };
        expect(editTaskDraftRecurrence(until, { kind: 'rule', rule: 'yearly' }, context).recurrenceRRule).toContain('UNTIL=');
        expect(editTaskDraftRecurrence(weekly, { kind: 'rule', rule: '' }, context))
            .toEqual({ recurrence: '', recurrenceStrategy: 'strict', recurrenceRRule: '' });
        expect(editTaskDraftRecurrence(weekly, { kind: 'count', text: '1500' }, context).recurrenceRRule).toContain('COUNT=999');
        expect(parseRecurrenceIntervalInput('4')).toBe(4);
        expect(parseRecurrenceIntervalInput('x')).toBeNull();
        expect(WEEKDAY_ORDER).toHaveLength(7);
    });
});

// Literal output oracle captured from the unmodified RN caller at 2d62a09a.
// The cleared-date expectation includes date-less daily projection (#1322).
// Existing schedule/model fixture JSON remains byte-for-byte unchanged.
describe('task editor recurrence calendar preview parity', () => {
    const originalTZ = process.env.TZ;
    beforeAll(() => { process.env.TZ = 'America/New_York'; });
    afterAll(() => { if (originalTZ === undefined) delete process.env.TZ; else process.env.TZ = originalTZ; });
    const now = new Date('2026-09-27T12:00:00.000Z');
    const formatDate = createDateFormatter({ language: 'en', dateFormat: 'system', timeFormat: 'system', systemLocale: 'en-US' });
    const t = (key: string) => key;
    const base: Task = { id: 'preview', title: 'Preview', status: 'next', tags: ['#stored'], contexts: ['@stored'],
        dueDate: '2026-10-01', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' };
    const cases: Array<{ name: string; stored: Partial<Task>; edited?: Partial<TaskDraft>; hint: string }> = [
    { name: 'scheduled daily', stored: { recurrence: { rule: 'daily', strategy: 'strict' } }, hint: 'Next calendar preview: Oct 2, 2026.' },
    { name: 'custom monthly', stored: { dueDate: '2026-10-13', recurrence: { rule: 'monthly', strategy: 'strict', rrule: 'FREQ=MONTHLY;BYDAY=2TU' } }, hint: 'Next calendar preview: Nov 10, 2026.' },
    { name: 'no recurrence', stored: {}, hint: '' },
    { name: 'exhausted count', stored: { recurrence: { rule: 'daily', strategy: 'strict', count: 3, completedOccurrences: 2 } }, hint: '' },
    { name: 'exhausted until', stored: { recurrence: { rule: 'daily', strategy: 'strict', until: '2026-10-01' } }, hint: '' },
    { name: 'preview toggle off', stored: { recurrence: { rule: 'daily', strategy: 'strict' }, showFutureRecurrence: false }, hint: 'Next calendar preview: Oct 2, 2026.' },
    { name: 'cleared draft date', stored: { recurrence: { rule: 'daily', strategy: 'strict' } }, edited: { dueDate: '' }, hint: 'Next calendar preview: Sep 28, 2026.' },
    { name: 'stored completion progress', stored: { recurrence: { rule: 'daily', strategy: 'strict', count: 3, completedOccurrences: 1 } }, hint: 'Next calendar preview: Oct 2, 2026.' },
    { name: 'after completion', stored: { dueDate: '2026-09-25', recurrence: { rule: 'daily', strategy: 'fluid' } }, hint: 'Next calendar preview: Sep 28, 2026.' },
    { name: 'draft status done', stored: { recurrence: { rule: 'daily', strategy: 'strict' } }, edited: { status: 'done' }, hint: '' },
];
    it.each(cases)('matches calendar preview output for $name without changing task or draft', ({ stored, edited, hint }) => {
        const task = { ...base, ...stored };
        const draft = { ...createTaskDraft(task), ...edited };
        const before = JSON.stringify({ task, draft });
        expect(getTaskEditorRecurrenceCalendarPreviewHint({ task, draft, t, formatDate, now })).toBe(hint);
        expect(JSON.stringify({ task, draft })).toBe(before);
    });
    it('uses the supplied translation and PP formatter, including a new unsaved task', () => {
        const format = vi.fn(() => 'localized date');
        const draft = createTaskDraft({ ...base, recurrence: { rule: 'daily', strategy: 'strict' } });
        expect(getTaskEditorRecurrenceCalendarPreviewHint({ task: null, draft, t: () => 'Localized preview', formatDate: format, now }))
            .toBe('Localized preview: localized date.');
        expect(format).toHaveBeenCalledWith('2026-10-02', 'PP');
    });
});


describe('task reminder policy controls', () => {
    const task: Task = { id: 'policy', title: 'Task', status: 'next', tags: [], contexts: [],
        createdAt: '2026-10-14', updatedAt: '2026-10-14', dueDate: '2026-10-15T10:00', repeatReminderMinutes: 15 };
    it.each([
        ['inherit', 'send', true], ['inherit', 'skip', false],
        ['send', 'skip', true], ['skip', 'send', false],
    ] as const)('resolves %s against %s without changing the saved repeat', (reminderPolicy, taskReminderDefault, showRepeat) => {
        const draft = createTaskDraft({ ...task, reminderPolicy });
        const before = structuredClone(draft);
        const model = getTaskEditorReminders(draft, (key) => key, { taskReminderDefault, notificationsEnabled: false });
        expect(model.policyOptions.map((option) => option.value)).toEqual(['inherit', 'send', 'skip']);
        expect(model.policyOptions.filter((option) => option.selected).map((option) => option.value)).toEqual([reminderPolicy]);
        expect(model.policyOptions[0].label).toBe(`Use default (${taskReminderDefault === 'skip' ? 'Skip' : 'Send'})`);
        expect(model.showRepeat).toBe(showRepeat);
        expect(model.hint).toContain('explicit time');
        expect(model.disabledHint).toContain('turned off');
        expect(draft).toEqual(before);
    });
    it('keeps date-only reminders out of the controls and never invents a time', () => {
        const draft = createTaskDraft({ ...task, dueDate: '2026-10-15', reminderPolicy: 'send' });
        const model = getTaskEditorReminders(draft, (key) => key);
        expect(model.showSkip).toBe(false);
        expect(model.showRepeat).toBe(false);
        expect(draft.dueDate).toBe('2026-10-15');
    });
});
