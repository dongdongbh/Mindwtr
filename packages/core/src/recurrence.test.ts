import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import {
    buildRRuleString,
    editRRuleString,
    parseRRuleString,
    createNextRecurringTask,
    projectNextRecurringTask,
    buildNextRecurringTask,
    createCurrentRecurringCalendarTask,
    expandCalendarRecurringTasks,
    expandCalendarRecurringTasksInRange,
    expandCalendarRecurringTaskSetInRange,
    createProjectedRecurringTask,
    formatRecurrenceLabel,
    getRecurrenceRRuleValue,
    getProjectedRecurringTaskCalendarDate,
    getProjectedRecurringTaskId,
    getRecurringTaskPreviewDate,
    getTaskCalendarOccurrenceDate,
    isProjectedRecurringTask,
    isProjectedRecurringTaskId,
    normalizeRecurrenceForLoad,
    CALENDAR_RANGE_PROJECTION_PER_TASK_CAP,
    CALENDAR_RANGE_PROJECTION_TOTAL_CAP,
} from './recurrence';
import { safeParseDate } from './date';
import { applyTaskUpdates } from './store-helpers';
import { isTaskDateCoherent } from './task-date-coherence';
import type { Task, TaskStatus } from './types';

type LocalApiRecurrenceParityCase = {
    kind?: 'recurrence';
    name: string;
    completedAt: string;
    previousStatus: TaskStatus;
    task: Task;
    expected: Record<string, unknown> | null;
};

// The fixture file also carries `kind: 'action'` cases (complete/archive/restore
// write-path parity, asserted by local-api-action-parity.test.ts) alongside these
// recurrence-only cases; the recurrence-only ones predate the `kind` field, so its
// absence means 'recurrence'.
const localApiRecurrenceParityCases = (JSON.parse(
    readFileSync(new URL('./recurrence-local-api-parity.fixtures.json', import.meta.url), 'utf8')
) as Array<LocalApiRecurrenceParityCase & { kind?: string }>).filter(
    (testCase) => !testCase.kind || testCase.kind === 'recurrence'
);

const toLocalApiRecurrenceParitySnapshot = (task: Task | null): Record<string, unknown> | null => {
    if (!task) return null;
    // Full-task equality except `id`: createNextRecurringTask mints a fresh
    // random id independently of the Rust engine under test in
    // local_api.rs's own parity test, making it the one legitimately
    // platform/run-variant field (mirrored there by the same exclusion in
    // comparable_local_api_recurring_task).
    const { id: _id, ...rest } = task;
    return rest;
};

describe('recurrence', () => {
    const t = (key: string) => ({
        'recurrence.daily': 'Daily',
        'recurrence.weekly': 'Weekly',
        'recurrence.monthly': 'Monthly',
        'recurrence.yearly': 'Yearly',
        'recurrence.onNthWeekday': 'The {ordinal} {weekday}',
        'recurrence.ordinal.last': 'Last',
        'recurrence.weekdayMonFri': 'Weekday (Mon–Fri)',
        'recurrence.repeatEvery': 'Repeat every',
        'recurrence.dayUnit': 'day(s)',
        'recurrence.weekUnit': 'week(s)',
        'recurrence.yearUnit': 'year(s)',
        'recurrence.endsAfterCount': 'After',
        'recurrence.endsOnDate': 'On date',
        'recurrence.occurrenceUnit': 'occurrence(s)',
        'recurrence.occurrenceProgressOf': 'of',
        'recurrence.afterCompletionShort': 'after completion',
    }[key] ?? key);

    it('formats daily recurrence intervals for display', () => {
        const label = formatRecurrenceLabel({
            recurrence: { rule: 'daily', rrule: 'FREQ=DAILY;INTERVAL=3' },
            t,
        });

        expect(label).toBe('Daily · Repeat every 3 day(s)');
    });

    it('formats long weekly and yearly recurrence intervals for display', () => {
        expect(formatRecurrenceLabel({
            recurrence: { rule: 'weekly', rrule: 'FREQ=WEEKLY;INTERVAL=78' },
            t,
        })).toBe('Weekly · Repeat every 78 week(s)');

        expect(formatRecurrenceLabel({
            recurrence: { rule: 'yearly', rrule: 'FREQ=YEARLY;INTERVAL=2' },
            t,
        })).toBe('Yearly · Repeat every 2 year(s)');
    });

    it('formats recurrence end metadata for display', () => {
        const label = formatRecurrenceLabel({
            recurrence: { rule: 'weekly', strategy: 'fluid', rrule: 'FREQ=WEEKLY;INTERVAL=2;COUNT=4' },
            t,
        });

        expect(label).toBe('Weekly · after completion · Repeat every 2 week(s) · After 4 occurrence(s)');
    });

    // #1082: a counted series shows how far along it is once there is progress
    // to show; a fresh one stays on the plain form.
    it('shows count progress once occurrences have been completed', () => {
        expect(formatRecurrenceLabel({
            recurrence: { rule: 'daily', rrule: 'FREQ=DAILY;COUNT=10', completedOccurrences: 6 },
            t,
        })).toBe('Daily · After 6 of 10 occurrence(s)');

        expect(formatRecurrenceLabel({
            recurrence: { rule: 'daily', rrule: 'FREQ=DAILY;COUNT=10', completedOccurrences: 0 },
            t,
        })).toBe('Daily · After 10 occurrence(s)');

        expect(formatRecurrenceLabel({
            recurrence: { rule: 'daily', rrule: 'FREQ=DAILY;COUNT=10' },
            t,
        })).toBe('Daily · After 10 occurrence(s)');
    });

    it('builds and parses weekly BYDAY rules', () => {
        const rrule = buildRRuleString('weekly', ['WE', 'MO']);
        expect(rrule).toBe('FREQ=WEEKLY;BYDAY=MO,WE');

        const parsed = parseRRuleString(rrule);
        expect(parsed.rule).toBe('weekly');
        expect(parsed.byDay).toEqual(['MO', 'WE']);
    });

    it('parses and preserves weekly WKST rules', () => {
        const parsed = parseRRuleString('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;WKST=SU');
        expect(parsed.weekStart).toBe('SU');

        const rrule = buildRRuleString('weekly', ['TU', 'TH'], 2, { weekStart: 'SU' });
        expect(rrule).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;WKST=SU');
    });

    it('edits one RRULE field without dropping WKST or extension tokens', () => {
        expect(editRRuleString(
            'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;WKST=SU;X-CUSTOM=keep',
            'weekly',
            { interval: 3 },
        )).toBe('FREQ=WEEKLY;INTERVAL=3;BYDAY=TU,TH;WKST=SU;X-CUSTOM=keep');
    });

    it('removes explicitly cleared RRULE fields while retaining untouched tokens', () => {
        expect(editRRuleString(
            'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;COUNT=5;WKST=SU;X-CUSTOM=keep',
            'weekly',
            { byDay: ['WE'], count: undefined },
        )).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=WE;WKST=SU;X-CUSTOM=keep');
    });

    it('builds and parses count and until options', () => {
        const rrule = buildRRuleString('monthly', undefined, 2, {
            byMonthDay: [15],
            count: 4,
            until: '2025-06-15',
        });
        expect(rrule).toBe('FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=15;COUNT=4;UNTIL=20250615');

        const parsed = parseRRuleString(rrule);
        expect(parsed.rule).toBe('monthly');
        expect(parsed.interval).toBe(2);
        expect(parsed.byMonthDay).toEqual([15]);
        expect(parsed.count).toBe(4);
        expect(parsed.until).toBe('2025-06-15');
    });

    it('builds and parses yearly interval rules', () => {
        const rrule = buildRRuleString('yearly', undefined, 2);
        expect(rrule).toBe('FREQ=YEARLY;INTERVAL=2');

        const parsed = parseRRuleString(rrule);
        expect(parsed.rule).toBe('yearly');
        expect(parsed.interval).toBe(2);
    });

    describe('getRecurrenceRRuleValue', () => {
        it('returns no rule for absent and legacy string recurrence values', () => {
            expect(getRecurrenceRRuleValue(undefined)).toBe('');
            expect(getRecurrenceRRuleValue('daily')).toBe('');
        });

        it('preserves an existing RRULE verbatim', () => {
            expect(getRecurrenceRRuleValue({
                rule: 'weekly',
                byDay: ['MO'],
                rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=WE;X-CUSTOM=value',
            })).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=WE;X-CUSTOM=value');
        });

        it('includes a stored week start when synthesizing an RRULE', () => {
            expect(getRecurrenceRRuleValue({
                rule: 'weekly',
                byDay: ['TU'],
                weekStart: 'SU',
            })).toBe('FREQ=WEEKLY;BYDAY=TU;WKST=SU');
        });

        it('serializes recurrence metadata through the canonical RRULE builder', () => {
            expect(getRecurrenceRRuleValue({ rule: 'daily' })).toBe('FREQ=DAILY');
            expect(getRecurrenceRRuleValue({
                rule: 'weekly',
                byDay: ['WE', 'MO'],
                count: 5,
                until: '2026-09-30',
            })).toBe('FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5;UNTIL=20260930');
            expect(getRecurrenceRRuleValue({
                rule: 'monthly',
                byMonthDay: [15, -1],
            })).toBe('FREQ=MONTHLY;BYMONTHDAY=-1,15');
        });
    });

    it('normalizes legacy recurrence values to object form', () => {
        expect(normalizeRecurrenceForLoad('daily')).toEqual({ rule: 'daily' });
        expect(normalizeRecurrenceForLoad('FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4')).toEqual({
            rule: 'weekly',
            byDay: ['MO', 'WE'],
            count: 4,
            rrule: 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4',
        });
        expect(normalizeRecurrenceForLoad({ rrule: 'FREQ=MONTHLY;BYDAY=1MO' })).toEqual({
            rule: 'monthly',
            byDay: ['1MO'],
            rrule: 'FREQ=MONTHLY;BYDAY=1MO',
        });
        expect(normalizeRecurrenceForLoad({ rrule: 'FREQ=MONTHLY;BYMONTHDAY=9' })).toEqual({
            rule: 'monthly',
            byMonthDay: [9],
            rrule: 'FREQ=MONTHLY;BYMONTHDAY=9',
        });
        expect(normalizeRecurrenceForLoad({ rule: 'daily', seriesId: ' series-1 ' })).toEqual({
            rule: 'daily',
            seriesId: 'series-1',
            rrule: 'FREQ=DAILY;X-MINDWTR-SERIES-ID=series-1',
        });
        expect(normalizeRecurrenceForLoad({
            rrule: 'FREQ=WEEKLY;BYDAY=MO;X-MINDWTR-SERIES-ID=series%20two',
        })).toEqual({
            rule: 'weekly',
            seriesId: 'series two',
            byDay: ['MO'],
            rrule: 'FREQ=WEEKLY;BYDAY=MO;X-MINDWTR-SERIES-ID=series%20two',
        });
    });

    it('creates next instance using weekly BYDAY (strict)', () => {
        const task: Task = {
            id: 't1',
            title: 'Laundry',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-06T10:00:00.000Z', // Monday
            recurrence: { rule: 'weekly', byDay: ['MO', 'WE'], strategy: 'strict' },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-06T12:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2025-01-08T10:00:00.000Z'); // Wednesday
        expect(next?.status).toBe('next');
    });

    it('keeps a legacy single anchorDay off the start date when it came from the due day', () => {
        // Pre-per-field-anchor recurrences carry only anchorDay, derived from
        // the due day. Crediting it to the start field advanced an Aug 14
        // start as a day-15 monthly rule: the first day-15 after Aug 14 is
        // Aug 15, so the next copy started a day later in the SAME month.
        const task: Task = {
            id: 't-legacy-anchor',
            title: 'Pay rent',
            status: 'done',
            tags: [],
            contexts: [],
            startTime: '2026-08-14',
            dueDate: '2026-08-15',
            recurrence: { rule: 'monthly', strategy: 'strict', anchorDay: 15 },
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2026-08-14T18:00:00.000Z', 'done');
        expect(next?.startTime).toBe('2026-09-14');
        expect(next?.dueDate).toBe('2026-09-15');
        // The next copy's per-field anchors must record each field's own day,
        // so the series stays correct from here on.
        expect(next?.recurrence).toMatchObject({ startAnchorDay: 14, dueAnchorDay: 15 });
    });

    it('keeps the legacy anchorDay authoritative for the field it was derived from', () => {
        // Due Jan 31 clamps to Feb 28; the global anchor is what returns the
        // series to the 31st in March — the owner field must keep it.
        const task: Task = {
            id: 't-legacy-anchor-owner',
            title: 'Invoice',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2026-02-28',
            recurrence: { rule: 'monthly', strategy: 'strict', anchorDay: 31 },
            createdAt: '2026-01-31T00:00:00.000Z',
            updatedAt: '2026-01-31T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2026-02-28T10:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2026-03-31');
    });

    it('preserves text direction on the next recurring task', () => {
        const task: Task = {
            id: 't1-rtl',
            title: 'RTL reading',
            status: 'done',
            tags: [],
            contexts: [],
            textDirection: 'rtl',
            dueDate: '2025-01-06T10:00:00.000Z',
            recurrence: { rule: 'daily' },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-06T12:00:00.000Z', 'done');

        expect(next?.textDirection).toBe('rtl');
    });

    it('uses completion date for fluid recurrence', () => {
        const task: Task = {
            id: 't2',
            title: 'Meditate',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-01T09:00:00.000Z',
            recurrence: { rule: 'daily', strategy: 'fluid' },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-05T14:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2025-01-06T14:00:00.000Z');
    });

    it('advances date-only start dates for fluid recurrence', () => {
        const task: Task = {
            id: 't2-start-fluid-date',
            title: 'Weekly planning',
            status: 'done',
            tags: [],
            contexts: [],
            startTime: '2026-06-01',
            recurrence: { rule: 'weekly', strategy: 'fluid' },
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2026-06-12T12:00:00.000Z', 'done');
        expect(next?.startTime).toBe('2026-06-19');
        expect(next?.dueDate).toBeUndefined();
    });

    it('keeps the advanced start date when switching a strict follow-up to fluid', () => {
        const original: Task = {
            id: 't2-start-strict-to-fluid',
            title: 'Weekly reset',
            status: 'done',
            tags: [],
            contexts: [],
            startTime: '2026-06-01',
            recurrence: { rule: 'weekly', strategy: 'strict' },
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
        };

        const strictNext = createNextRecurringTask(original, '2026-06-01T12:00:00.000Z', 'done') as Task;
        const fluidTask: Task = {
            ...strictNext,
            recurrence: { rule: 'weekly', strategy: 'fluid' },
        };

        const next = createNextRecurringTask(fluidTask, '2026-06-12T12:00:00.000Z', 'next');
        expect(strictNext.startTime).toBe('2026-06-08');
        expect(next?.startTime).toBe('2026-06-19');
    });

    it('keeps dueDate unset for startTime-only recurring tasks', () => {
        const task: Task = {
            id: 't2-start-only',
            title: 'Read a book',
            status: 'done',
            tags: [],
            contexts: [],
            startTime: '2025-01-01T09:00:00.000Z',
            recurrence: { rule: 'daily', strategy: 'strict' },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-01T12:00:00.000Z', 'done');
        expect(next?.startTime).toBe('2025-01-02T09:00:00.000Z');
        expect(next?.dueDate).toBeUndefined();
    });

    it('carries startTime and dueDate forward for yearly strict recurrence', () => {
        const task: Task = {
            id: 't2-yearly-window',
            title: 'Annual enrollment reminder',
            status: 'done',
            tags: [],
            contexts: [],
            startTime: '2027-03-01T09:00:00.000Z',
            dueDate: '2027-04-01T09:00:00.000Z',
            recurrence: { rule: 'yearly', strategy: 'strict' },
            createdAt: '2027-01-01T00:00:00.000Z',
            updatedAt: '2027-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2027-04-01T12:00:00.000Z', 'done');
        expect(next?.startTime).toBe('2028-03-01T09:00:00.000Z');
        expect(next?.dueDate).toBe('2028-04-01T09:00:00.000Z');
        expect(next?.status).toBe('next');
    });

    it('carries recurrence task metadata into the next instance', () => {
        const task: Task = {
            id: 't2-field-carry',
            title: 'Renew prescription',
            status: 'done',
            tags: [],
            contexts: [],
            taskMode: 'list',
            checklist: [{ id: 'c1', title: 'Call pharmacy', isCompleted: true }],
            startTime: '2025-01-09T09:00:00.000Z',
            relativeStartOffset: { amount: -1, unit: 'day' },
            dueDate: '2025-01-10T09:00:00.000Z',
            repeatReminderMinutes: 30,
            dueReminderLeadMinutes: 1440,
            recurrence: { rule: 'weekly', strategy: 'strict' },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-10T12:00:00.000Z', 'done');

        expect(next?.taskMode).toBe('list');
        expect(next?.relativeStartOffset).toEqual({ amount: -1, unit: 'day' });
        expect(next?.repeatReminderMinutes).toBe(30);
        expect(next?.dueReminderLeadMinutes).toBe(1440);
        expect(next?.startTime).toBe('2025-01-16T09:00:00.000Z');
        expect(next?.dueDate).toBe('2025-01-17T09:00:00.000Z');
        expect(next?.checklist).toHaveLength(1);
        expect(next?.checklist?.[0]).toMatchObject({ title: 'Call pharmacy', isCompleted: false });
        expect(next?.checklist?.[0]?.id).not.toBe('c1');
    });

    it('replays the same complete and follow-up rows from frozen generated IDs', () => {
        const now = '2026-10-05T14:00:00.000Z';
        const task: Task = {
            id: 'source-occurrence', title: 'Renew subscription', status: 'next',
            tags: ['#finance'], contexts: ['@desk'], dueDate: '2026-10-05',
            recurrence: { rule: 'daily', strategy: 'strict' },
            checklist: [
                { id: 'source-check-done', title: 'Verify invoice', isCompleted: true },
                { id: 'source-check-open', title: 'File receipt', isCompleted: false },
            ],
            attachments: [
                { id: 'source-live-file', kind: 'file', title: 'invoice.pdf', uri: 'file:///invoice.pdf',
                    cloudKey: 'retained-cloud-object', createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z' },
                { id: 'source-deleted-file', kind: 'file', title: 'old.pdf', uri: 'file:///old.pdf',
                    createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z',
                    deletedAt: '2026-10-02T10:00:00.000Z' },
            ],
            createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z',
        };
        const sourceBefore = JSON.parse(JSON.stringify(task)) as Task;
        const ids = ['next-file', 'next-occurrence', 'next-check-done', 'next-check-open'];
        const plan = () => {
            let used = 0;
            const result = applyTaskUpdates(task, { status: 'done' }, now, () => ids[used++]);
            return { result, used };
        };
        const first = plan();
        const second = plan();

        expect(first).toEqual(second);
        expect(first.used).toBe(ids.length);
        expect(first.result.updatedTask).toMatchObject({ id: task.id, status: 'done', completedAt: now });
        const followUp = first.result.nextRecurringTask;
        expect(followUp?.id).toBe('next-occurrence');
        expect(followUp?.checklist).toEqual([
            { id: 'next-check-done', title: 'Verify invoice', isCompleted: false },
            { id: 'next-check-open', title: 'File receipt', isCompleted: false },
        ]);
        expect(followUp?.attachments).toEqual([{
            ...task.attachments?.[0], id: 'next-file', createdAt: now, updatedAt: now, deletedAt: undefined,
        }]);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.every((id) => id !== task.id && !task.checklist?.some((item) => item.id === id)
            && !task.attachments?.some((item) => item.id === id))).toBe(true);
        expect(task).toEqual(sourceBefore);
    });

    it('regenerates relative start dates from the next due date across month clamps', () => {
        const task: Task = {
            id: 't2-relative-start-month-clamp',
            title: 'Month-end close prep',
            status: 'done',
            tags: [],
            contexts: [],
            startTime: '2025-01-30',
            relativeStartOffset: { amount: -1, unit: 'day' },
            dueDate: '2025-01-31',
            recurrence: { rule: 'monthly', strategy: 'strict' },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-31T12:00:00.000Z', 'done');

        expect(next?.dueDate).toBe('2025-02-28');
        expect(next?.startTime).toBe('2025-02-27');
        expect(next?.relativeStartOffset).toEqual({ amount: -1, unit: 'day' });
    });

    it('respects daily interval for strict recurrence', () => {
        const task: Task = {
            id: 't2b',
            title: 'Water plants',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-01T09:00:00.000Z',
            recurrence: { rule: 'daily', strategy: 'strict', rrule: 'FREQ=DAILY;INTERVAL=3' },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-05T14:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2025-01-04T09:00:00.000Z');
        expect(next?.startTime).toBeUndefined();
    });

    it('respects daily interval for fluid recurrence', () => {
        const task: Task = {
            id: 't2c',
            title: 'Stretching',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-01T09:00:00.000Z',
            recurrence: { rule: 'daily', strategy: 'fluid', rrule: 'FREQ=DAILY;INTERVAL=3' },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-05T14:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2025-01-08T14:00:00.000Z');
        expect(next?.startTime).toBeUndefined();
    });

    it('uses completion date for fluid weekly BYDAY recurrence', () => {
        const task: Task = {
            id: 't2c-weekly-byday-fluid',
            title: 'Strength training',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-06T09:00:00.000Z',
            recurrence: {
                rule: 'weekly',
                strategy: 'fluid',
                rrule: 'FREQ=WEEKLY;BYDAY=MO,WE',
            },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-10T14:00:00.000Z', 'done');

        expect(next?.dueDate).toBe('2025-01-13T14:00:00.000Z');
        expect(next?.startTime).toBeUndefined();
    });

    it('applies the weekly interval for fluid BYDAY recurrence', () => {
        const task: Task = {
            id: 't2c-weekly-byday-fluid-interval',
            title: 'Change bedsheets',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2026-07-12',
            recurrence: {
                rule: 'weekly',
                strategy: 'fluid',
                rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU',
            },
            createdAt: '2026-07-01T00:00:00.000Z',
            updatedAt: '2026-07-01T00:00:00.000Z',
        };

        // Completed Tue 2026-07-14: the next Sunday lands in the 2nd week after
        // completion (Jul 26), not the Sunday of the completion week (Jul 19).
        const next = createNextRecurringTask(task, '2026-07-14T10:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2026-07-26');

        const everyThreeWeeks: Task = {
            ...task,
            recurrence: { rule: 'weekly', strategy: 'fluid', rrule: 'FREQ=WEEKLY;INTERVAL=3;BYDAY=SU' },
        };
        const nextInThree = createNextRecurringTask(everyThreeWeeks, '2026-07-14T10:00:00.000Z', 'done');
        expect(nextInThree?.dueDate).toBe('2026-08-02');
    });

    it('spawns a full interval later when a fluid BYDAY task is completed on its weekday', () => {
        const task: Task = {
            id: 't2c-weekly-byday-fluid-on-weekday',
            title: 'Change bedsheets',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2026-07-19',
            recurrence: {
                rule: 'weekly',
                strategy: 'fluid',
                rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU',
            },
            createdAt: '2026-07-01T00:00:00.000Z',
            updatedAt: '2026-07-01T00:00:00.000Z',
        };

        // Completed on a Sunday: the next occurrence is exactly two weeks out.
        const next = createNextRecurringTask(task, '2026-07-19T10:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2026-08-02');
    });

    it('applies the monthly interval for fluid BYMONTHDAY recurrence', () => {
        const task: Task = {
            id: 't2c-monthly-bymonthday-fluid-interval',
            title: 'Replace water filter',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2026-07-10',
            recurrence: {
                rule: 'monthly',
                strategy: 'fluid',
                byMonthDay: [15],
                rrule: 'FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=15',
            },
            createdAt: '2026-07-01T00:00:00.000Z',
            updatedAt: '2026-07-01T00:00:00.000Z',
        };

        // Completed 2026-07-14: the next 15th lands in the 2nd month after
        // completion (Aug 15), not the following day (Jul 15).
        const next = createNextRecurringTask(task, '2026-07-14T10:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2026-08-15');
    });

    it('applies the monthly interval for fluid ordinal BYDAY recurrence', () => {
        const task: Task = {
            id: 't2c-monthly-byday-fluid-interval',
            title: 'Team retro',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2026-07-14',
            recurrence: {
                rule: 'monthly',
                strategy: 'fluid',
                rrule: 'FREQ=MONTHLY;INTERVAL=2;BYDAY=2TU',
            },
            createdAt: '2026-07-01T00:00:00.000Z',
            updatedAt: '2026-07-01T00:00:00.000Z',
        };

        // Completed Tue 2026-07-14 (July's 2nd Tuesday): August's 2nd Tuesday
        // (Aug 11) falls before the shifted base (Aug 14), so the next match is
        // September's 2nd Tuesday.
        const next = createNextRecurringTask(task, '2026-07-14T10:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2026-09-08');
    });

    it('applies the weekly interval when deferring unscheduled fluid BYDAY recurrence', () => {
        const task: Task = {
            id: 't2d-weekly-byday-unscheduled',
            title: 'Water the plants',
            status: 'next',
            tags: [],
            contexts: [],
            recurrence: {
                rule: 'weekly',
                strategy: 'fluid',
                rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU',
            },
            createdAt: '2026-07-01T00:00:00.000Z',
            updatedAt: '2026-07-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2026-07-14T10:00:00.000Z', 'next');
        expect(next?.dueDate).toBeUndefined();
        expect(next?.startTime).toBe('2026-07-26');
    });

    it('keeps strict BYDAY interval recurrence anchored to the previous occurrence', () => {
        const task: Task = {
            id: 't2c-weekly-byday-strict-interval',
            title: 'Change bedsheets',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2026-07-12',
            recurrence: {
                rule: 'weekly',
                strategy: 'strict',
                rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU',
            },
            createdAt: '2026-07-01T00:00:00.000Z',
            updatedAt: '2026-07-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2026-07-14T10:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2026-07-26');
    });

    it('defers unscheduled fluid recurrence from completion date', () => {
        const task: Task = {
            id: 't2d',
            title: 'Unscheduled recurring task',
            status: 'next',
            tags: [],
            contexts: [],
            recurrence: { rule: 'daily', strategy: 'fluid', rrule: 'FREQ=DAILY;INTERVAL=3' },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-05T14:00:00.000Z', 'next');
        expect(next?.dueDate).toBeUndefined();
        expect(next?.startTime).toBe('2025-01-08');
        expect(next?.status).toBe('next');
    });

    it('keeps regenerated unscheduled recurrences date-only instead of inheriting the completion time', () => {
        const task: Task = {
            id: 't2e',
            title: 'Pay rent',
            status: 'next',
            tags: [],
            contexts: [],
            recurrence: { rule: 'monthly', strategy: 'strict', byMonthDay: [9], rrule: 'FREQ=MONTHLY;BYMONTHDAY=9' },
            createdAt: '2026-07-01T00:00:00.000Z',
            updatedAt: '2026-07-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2026-07-03T12:00:00.000Z', 'done');
        expect(next?.startTime).toBe('2026-07-09');
        expect(next?.dueDate).toBeUndefined();
    });

    // RFC 5545 BYMONTHDAY=-1: "last day of the month" — the end-of-month rule
    // that needs no 31st-anchor ritual (Discord ask). The matrix below walks
    // strict/fluid × short/long months × interval × date-only.
    it('advances a strict last-day-of-month rule through short and long months', () => {
        const task: Task = {
            id: 'lastday-1',
            title: 'Close the books',
            status: 'next',
            tags: [],
            contexts: [],
            dueDate: '2026-08-31',
            recurrence: { rule: 'monthly', strategy: 'strict', byMonthDay: [-1], rrule: 'FREQ=MONTHLY;BYMONTHDAY=-1' },
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:00:00.000Z',
        };

        const sept = createNextRecurringTask(task, '2026-08-31T10:00:00.000Z', 'done');
        expect(sept?.dueDate).toBe('2026-09-30');
        const oct = createNextRecurringTask({ ...task, dueDate: '2026-09-30' }, '2026-09-30T10:00:00.000Z', 'done');
        expect(oct?.dueDate).toBe('2026-10-31');
        const feb = createNextRecurringTask({ ...task, dueDate: '2027-01-31' }, '2027-01-31T10:00:00.000Z', 'done');
        expect(feb?.dueDate).toBe('2027-02-28');
        const leapFeb = createNextRecurringTask({ ...task, dueDate: '2028-01-31' }, '2028-01-31T10:00:00.000Z', 'done');
        expect(leapFeb?.dueDate).toBe('2028-02-29');
    });

    it('lands a fluid last-day-of-month rule on the last day after the completion', () => {
        const task: Task = {
            id: 'lastday-2',
            title: 'Invoice run',
            status: 'next',
            tags: [],
            contexts: [],
            dueDate: '2026-08-31',
            recurrence: { rule: 'monthly', strategy: 'fluid', byMonthDay: [-1], rrule: 'FREQ=MONTHLY;BYMONTHDAY=-1' },
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:00:00.000Z',
        };

        // Completed mid-September: the next last-day after Sep 15 is Sep 30.
        const next = createNextRecurringTask(task, '2026-09-15T09:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2026-09-30');
    });

    it('respects the interval for last-day-of-month rules', () => {
        const task: Task = {
            id: 'lastday-3',
            title: 'Quarterly close',
            status: 'next',
            tags: [],
            contexts: [],
            dueDate: '2026-08-31',
            recurrence: { rule: 'monthly', strategy: 'strict', interval: 2, byMonthDay: [-1], rrule: 'FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=-1' },
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2026-08-31T10:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2026-10-31');
    });

    // BYMONTHDAY lists (#1078): the engine picks the earliest remaining day in
    // each candidate month and skips months where none of the days exist.
    it('walks a strict multi-day month rule through both of its days', () => {
        const task: Task = {
            id: 'multiday-1',
            title: 'Pay the halves',
            status: 'next',
            tags: [],
            contexts: [],
            dueDate: '2026-06-01',
            recurrence: { rule: 'monthly', strategy: 'strict', byMonthDay: [1, 16], rrule: 'FREQ=MONTHLY;BYMONTHDAY=1,16' },
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
        };

        expect(createNextRecurringTask(task, '2026-06-01T10:00:00.000Z', 'done')?.dueDate).toBe('2026-06-16');
        expect(createNextRecurringTask({ ...task, dueDate: '2026-06-16' }, '2026-06-16T10:00:00.000Z', 'done')?.dueDate)
            .toBe('2026-07-01');
    });

    it('lands a fluid multi-day month rule on the next day after the completion', () => {
        const task: Task = {
            id: 'multiday-2',
            title: 'Water the plants',
            status: 'next',
            tags: [],
            contexts: [],
            dueDate: '2026-06-01T09:00',
            recurrence: { rule: 'monthly', strategy: 'fluid', byMonthDay: [1, 16], rrule: 'FREQ=MONTHLY;BYMONTHDAY=1,16' },
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
        };

        // Completed on the 10th: the next listed day after that is the 16th.
        // Fluid rules search from the completion instant, so the regenerated
        // datetime carries that instant's clock rather than the old 09:00.
        expect(createNextRecurringTask(task, '2026-06-10T12:00:00.000Z', 'done')?.dueDate)
            .toBe('2026-06-16T12:00:00.000Z');
    });

    it('keeps the clock time of a strict multi-day datetime rule', () => {
        const task: Task = {
            id: 'multiday-2b',
            title: 'Standup prep',
            status: 'next',
            tags: [],
            contexts: [],
            dueDate: '2026-06-01T09:00',
            recurrence: { rule: 'monthly', strategy: 'strict', byMonthDay: [1, 16], rrule: 'FREQ=MONTHLY;BYMONTHDAY=1,16' },
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
        };

        expect(createNextRecurringTask(task, '2026-06-01T10:00:00.000Z', 'done')?.dueDate).toBe('2026-06-16T09:00');
    });

    it('respects the interval for multi-day month rules', () => {
        const task: Task = {
            id: 'multiday-3',
            title: 'Bi-monthly review',
            status: 'next',
            tags: [],
            contexts: [],
            dueDate: '2026-06-16',
            recurrence: {
                rule: 'monthly',
                strategy: 'strict',
                interval: 2,
                byMonthDay: [1, 16],
                rrule: 'FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=1,16',
            },
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
        };

        // Nothing left in June after the 16th, so the interval carries it to August's 1st.
        expect(createNextRecurringTask(task, '2026-06-16T10:00:00.000Z', 'done')?.dueDate).toBe('2026-08-01');
    });

    it('skips a month where none of the listed days exist', () => {
        const task: Task = {
            id: 'multiday-4',
            title: 'Late-month chore',
            status: 'next',
            tags: [],
            contexts: [],
            dueDate: '2027-01-31',
            recurrence: { rule: 'monthly', strategy: 'strict', byMonthDay: [30, 31], rrule: 'FREQ=MONTHLY;BYMONTHDAY=30,31' },
            createdAt: '2027-01-01T00:00:00.000Z',
            updatedAt: '2027-01-01T00:00:00.000Z',
        };

        // February 2027 has neither a 30th nor a 31st, so the series falls through to March.
        expect(createNextRecurringTask(task, '2027-01-31T10:00:00.000Z', 'done')?.dueDate).toBe('2027-03-30');
    });

    it('round-trips a BYMONTHDAY list through the rrule string', () => {
        const rrule = buildRRuleString('monthly', undefined, 1, { byMonthDay: [16, 1, 16] });
        expect(rrule).toBe('FREQ=MONTHLY;BYMONTHDAY=1,16');
        expect(parseRRuleString(rrule).byMonthDay).toEqual([1, 16]);
    });

    it('round-trips BYMONTHDAY=-1 through the rrule string', () => {
        const rrule = buildRRuleString('monthly', undefined, 1, { byMonthDay: [-1] });
        expect(rrule).toBe('FREQ=MONTHLY;BYMONTHDAY=-1');
        const parsed = parseRRuleString(rrule);
        expect(parsed.rule).toBe('monthly');
        expect(parsed.byMonthDay).toEqual([-1]);
    });

    it('preserves the positioned weekday rule through edits and normalization', () => {
        const rrule = 'FREQ=MONTHLY;BYDAY=FR,MO,TH,TU,WE;BYSETPOS=-1';
        expect(parseRRuleString(rrule).bySetPos).toBe(-1);
        expect(editRRuleString(rrule, 'monthly', { interval: 2 }))
            .toBe('FREQ=MONTHLY;INTERVAL=2;BYDAY=FR,MO,TH,TU,WE;BYSETPOS=-1');
        expect(editRRuleString(rrule, 'monthly', { byMonthDay: [-1], byDay: undefined }))
            .toBe('FREQ=MONTHLY;BYMONTHDAY=-1');
        const loaded = normalizeRecurrenceForLoad({ rule: 'monthly', rrule });
        expect(loaded?.rrule).toBe(rrule);
        expect(normalizeRecurrenceForLoad(JSON.parse(JSON.stringify(loaded)))).toEqual(loaded);
        expect(formatRecurrenceLabel({ recurrence: loaded, t }))
            .toBe('Monthly · The Last Weekday (Mon–Fri)');
    });

    it.each([
        ['2026-01-30', '2026-02-27'], // February ends on Saturday.
        ['2026-02-27', '2026-03-31'], // March ends on Tuesday.
        ['2026-04-30', '2026-05-29'], // May ends on Sunday.
        ['2027-01-29', '2027-02-26'], // Non-leap February ends on Sunday.
        ['2028-02-29', '2028-03-31'], // Leap February ends on Tuesday.
    ])('advances last-weekday month end from %s to %s', (dueDate, expected) => {
        const rrule = buildRRuleString('monthly', ['MO', 'TU', 'WE', 'TH', 'FR'], 1, { bySetPos: -1 });
        const task: Task = {
            id: 'last-weekday', title: 'Close accounts', status: 'done', tags: [], contexts: [], dueDate,
            recurrence: { rule: 'monthly', strategy: 'strict', rrule },
            createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        };
        const next = createNextRecurringTask(task, `${dueDate}T12:00:00.000Z`, 'done');
        expect(next?.dueDate).toBe(expected);
        expect(typeof next?.recurrence === 'object' ? next.recurrence.rrule : undefined).toBe(rrule);
    });

    it('keeps the time and agrees with the calendar preview', () => {
        const task: Task = {
            id: 'last-weekday-time', title: 'Close accounts', status: 'next', tags: [], contexts: [],
            dueDate: '2026-01-30T09:30:00.000Z', showFutureRecurrence: true,
            recurrence: { rule: 'monthly', strategy: 'strict',
                rrule: 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1' },
            createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        };
        const next = createNextRecurringTask(task, '2026-01-30T12:00:00.000Z', 'done');
        const projected = createProjectedRecurringTask(task, '2026-01-30T12:00:00.000Z');
        expect(next?.dueDate).toBe('2026-02-27T09:30:00.000Z');
        expect(projected?.dueDate).toBe(next?.dueDate);
    });

    it('applies the monthly interval after completion', () => {
        const task: Task = {
            id: 'last-weekday-fluid', title: 'Close accounts', status: 'done', tags: [], contexts: [],
            dueDate: '2026-01-30',
            recurrence: { rule: 'monthly', strategy: 'fluid',
                rrule: 'FREQ=MONTHLY;INTERVAL=2;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1' },
            createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        };
        expect(createNextRecurringTask(task, '2026-01-31T12:00:00.000Z', 'done')?.dueDate)
            .toBe('2026-03-31');
    });

    it('falls back to weekly interval when BYDAY is empty', () => {
        const task: Task = {
            id: 't4',
            title: 'Weekly check-in',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-06T10:00:00.000Z', // Monday
            recurrence: { rule: 'weekly', byDay: [], strategy: 'strict' },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-06T12:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2025-01-13T10:00:00.000Z');
    });

    it('respects weekly interval when BYDAY is provided', () => {
        const task: Task = {
            id: 't5',
            title: 'Biweekly sync',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-08T10:00:00.000Z', // Wednesday
            recurrence: { rule: 'weekly', rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE', strategy: 'strict' },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-08T12:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2025-01-20T10:00:00.000Z'); // Monday two weeks later
    });

    it('uses Monday as the default weekly interval anchor per RFC 5545', () => {
        const task: Task = {
            id: 't5-rfc-week-start',
            title: 'Every other Tue/Thu',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-05T10:00:00.000Z', // Sunday
            recurrence: { rule: 'weekly', rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH', strategy: 'strict' },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-05T12:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2025-01-14T10:00:00.000Z');
    });

    it('honors explicit weekly WKST when interval is greater than 1', () => {
        const task: Task = {
            id: 't5-wkst',
            title: 'Every other Tue/Thu with Sunday week start',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-05T10:00:00.000Z', // Sunday
            recurrence: { rule: 'weekly', rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;WKST=SU', strategy: 'strict' },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-05T12:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2025-01-07T10:00:00.000Z');
        expect(typeof next?.recurrence === 'object' ? next.recurrence.rrule : undefined).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;WKST=SU');
    });

    it('preserves the start lead for monthly BYDAY recurrence', () => {
        const task: Task = {
            id: 't5b',
            title: 'Every two months on 2nd Thursday',
            status: 'done',
            tags: [],
            contexts: [],
            startTime: '2025-01-01',
            dueDate: '2025-01-09',
            recurrence: { rule: 'monthly', rrule: 'FREQ=MONTHLY;INTERVAL=2;BYDAY=2TH', strategy: 'strict' },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-09T12:00:00.000Z', 'done');
        // The due date identifies the occurrence. The start keeps its original
        // eight-day lead instead of snapping independently onto the BYDAY grid.
        expect(next?.dueDate).toBe('2025-03-13');
        expect(next?.startTime).toBe('2025-03-05');
    });

    it('uses current month for monthly BYDAY and preserves time', () => {
        const task: Task = {
            id: 't6',
            title: 'First Monday',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-01T09:00:00.000Z',
            recurrence: { rule: 'monthly', byDay: ['1MO'], strategy: 'strict' },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-01T12:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2025-01-06T09:00:00.000Z');
    });

    it('uses the earliest matching weekday for monthly BYDAY without ordinals', () => {
        const task: Task = {
            id: 't6-plain-byday',
            title: 'Office days',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2026-08-03',
            recurrence: {
                rule: 'monthly',
                strategy: 'strict',
                rrule: 'FREQ=MONTHLY;BYDAY=MO,WE',
            },
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2026-08-03T12:00:00.000Z', 'done');

        expect(next?.dueDate).toBe('2026-08-05');
    });

    it('preserves the interval and time for strict monthly BYDAY without ordinals', () => {
        const task: Task = {
            id: 't6-plain-byday-strict-interval',
            title: 'Office days every other month',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2026-08-31T09:30:00.000Z',
            recurrence: {
                rule: 'monthly',
                strategy: 'strict',
                byDay: ['MO', 'WE'],
                rrule: 'FREQ=MONTHLY;INTERVAL=2;BYDAY=MO,WE',
            },
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2026-08-31T12:00:00.000Z', 'done');

        expect(next?.dueDate).toBe('2026-10-05T09:30:00.000Z');
    });

    it('uses completion time as the anchor for fluid monthly BYDAY without ordinals', () => {
        const task: Task = {
            id: 't6-plain-byday-fluid-interval',
            title: 'Office days after completion',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2026-08-03',
            recurrence: {
                rule: 'monthly',
                strategy: 'fluid',
                byDay: ['MO', 'WE'],
                rrule: 'FREQ=MONTHLY;INTERVAL=2;BYDAY=MO,WE',
            },
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2026-08-03T12:00:00.000Z', 'done');

        expect(next?.dueDate).toBe('2026-09-07');
    });

    it('keeps projected schedule fields on the same plain monthly BYDAY occurrence', () => {
        const localIso = (day: number, hour: number) => new Date(2026, 7, day, hour).toISOString();
        const task: Task = {
            id: 't6-plain-byday-projected-fields',
            title: 'Office day schedule',
            status: 'next',
            tags: [],
            contexts: [],
            startTime: localIso(3, 9),
            dueDate: localIso(3, 17),
            reviewAt: localIso(3, 18),
            recurrence: {
                rule: 'monthly',
                strategy: 'strict',
                byDay: ['MO', 'WE'],
                rrule: 'FREQ=MONTHLY;BYDAY=MO,WE',
            },
            showFutureRecurrence: true,
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:00:00.000Z',
        };

        const projected = createProjectedRecurringTask(task, localIso(3, 20));

        expect(projected).toMatchObject({
            startTime: localIso(5, 9),
            dueDate: localIso(5, 17),
            reviewAt: localIso(5, 18),
        });
    });

    it('checks the current month for monthly BYDAY rules with interval greater than 1', () => {
        const task: Task = {
            id: 't6-interval-current-month',
            title: 'Third Monday every two months',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-10T09:00:00.000Z',
            recurrence: { rule: 'monthly', rrule: 'FREQ=MONTHLY;INTERVAL=2;BYDAY=3MO', strategy: 'strict' },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-10T12:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2025-01-20T09:00:00.000Z');
    });

    it('stops generating tasks after the configured count', () => {
        const task: Task = {
            id: 't6-count',
            title: 'Three-time reminder',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-01',
            recurrence: {
                rule: 'daily',
                strategy: 'strict',
                count: 3,
                completedOccurrences: 1,
                rrule: 'FREQ=DAILY;COUNT=3',
            },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-02T12:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2025-01-02');
        expect(next?.recurrence).toMatchObject({
            count: 3,
            completedOccurrences: 2,
            rrule: 'FREQ=DAILY;COUNT=3',
        });

        const final = createNextRecurringTask(next as Task, '2025-01-03T12:00:00.000Z', 'done');
        expect(final).toBeNull();
    });

    it('treats RRULE COUNT without completedOccurrences as a total series count', () => {
        const task: Task = {
            id: 't6-rrule-count-unseeded',
            title: 'Two-time reminder',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-01',
            recurrence: {
                rule: 'daily',
                strategy: 'strict',
                rrule: 'FREQ=DAILY;COUNT=2',
            },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-01T12:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2025-01-02');
        expect(next?.recurrence).toMatchObject({
            count: 2,
            completedOccurrences: 1,
            rrule: 'FREQ=DAILY;COUNT=2',
        });

        const final = createNextRecurringTask(next as Task, '2025-01-02T12:00:00.000Z', 'done');
        expect(final).toBeNull();
    });

    it('stops generating tasks after the until date', () => {
        const task: Task = {
            id: 't6-until',
            title: 'Temporary habit',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-02',
            recurrence: {
                rule: 'daily',
                strategy: 'strict',
                until: '2025-01-03',
                rrule: 'FREQ=DAILY;UNTIL=20250103',
            },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-02T12:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2025-01-03');

        const final = createNextRecurringTask(next as Task, '2025-01-03T12:00:00.000Z', 'done');
        expect(final).toBeNull();
    });

    it('preserves date-only format for next occurrence', () => {
        const task: Task = {
            id: 't3',
            title: 'Monthly bill',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-02-01',
            recurrence: 'monthly',
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-02-01T08:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2025-03-01');
    });

    it('clamps monthly recurrence to the last day of the month', () => {
        const task: Task = {
            id: 't7',
            title: 'Month end report',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-31',
            recurrence: 'monthly',
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-31T12:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2025-02-28');
    });

    it('preserves the monthly anchor day across clamped hops', () => {
        const task: Task = {
            id: 't7-anchor',
            title: 'Month end report',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-31',
            recurrence: 'monthly',
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const february = createNextRecurringTask(task, '2025-01-31T12:00:00.000Z', 'done') as Task;
        const march = createNextRecurringTask(february, '2025-02-28T12:00:00.000Z', 'done');

        expect(february.dueDate).toBe('2025-02-28');
        expect(march?.dueDate).toBe('2025-03-31');
    });

    it('preserves the quarterly anchor day across clamped hops', () => {
        const task: Task = {
            id: 't7-quarterly',
            title: 'Quarter close',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-31',
            recurrence: { rule: 'monthly', rrule: 'FREQ=MONTHLY;INTERVAL=3' },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const april = createNextRecurringTask(task, '2025-01-31T12:00:00.000Z', 'done') as Task;
        const july = createNextRecurringTask(april, '2025-04-30T12:00:00.000Z', 'done');

        expect(april.dueDate).toBe('2025-04-30');
        expect(july?.dueDate).toBe('2025-07-31');
    });

    it('carries yearly recurrence forward by the RRULE interval', () => {
        const task: Task = {
            id: 't7-biennial',
            title: 'Biennial renewal',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-06-15',
            recurrence: { rule: 'yearly', rrule: 'FREQ=YEARLY;INTERVAL=2' },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-06-15T12:00:00.000Z', 'done');

        expect(next?.dueDate).toBe('2027-06-15');
        expect(next?.recurrence).toMatchObject({
            rule: 'yearly',
            rrule: 'FREQ=YEARLY;INTERVAL=2',
        });
    });

    it('clamps yearly recurrence for leap-day tasks', () => {
        const task: Task = {
            id: 't8',
            title: 'Leap day reminder',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2024-02-29',
            recurrence: 'yearly',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2024-02-29T12:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2025-02-28');
    });

    it('preserves leap-day yearly anchors across non-leap years', () => {
        const task: Task = {
            id: 't8-anchor',
            title: 'Leap day reminder',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2024-02-29',
            recurrence: 'yearly',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
        };

        const year2025 = createNextRecurringTask(task, '2024-02-29T12:00:00.000Z', 'done') as Task;
        const year2026 = createNextRecurringTask(year2025, '2025-02-28T12:00:00.000Z', 'done') as Task;
        const year2027 = createNextRecurringTask(year2026, '2026-02-28T12:00:00.000Z', 'done') as Task;
        const year2028 = createNextRecurringTask(year2027, '2027-02-28T12:00:00.000Z', 'done');

        expect(year2028?.dueDate).toBe('2028-02-29');
    });

    it('preserves local time across a DST boundary (spring forward)', () => {
        const task: Task = {
            id: 't9',
            title: 'Morning check-in',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2024-03-09T09:30',
            recurrence: 'daily',
            createdAt: '2024-03-01T00:00:00.000Z',
            updatedAt: '2024-03-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2024-03-09T10:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2024-03-10T09:30');
    });

    it('preserves local time across a DST boundary (fall back)', () => {
        const task: Task = {
            id: 't10',
            title: 'Morning check-in',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2024-11-02T09:30',
            recurrence: 'daily',
            createdAt: '2024-10-01T00:00:00.000Z',
            updatedAt: '2024-10-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2024-11-02T10:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2024-11-03T09:30');
    });

    it('keeps section assignment for recurring project tasks', () => {
        const task: Task = {
            id: 't11',
            title: 'Section recurring',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-01T09:00:00.000Z',
            recurrence: 'daily',
            projectId: 'project-1',
            sectionId: 'section-1',
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-01T10:00:00.000Z', 'done');
        expect(next?.projectId).toBe('project-1');
        expect(next?.sectionId).toBe('section-1');
    });

    it('keeps area assignment for recurring area tasks', () => {
        const task: Task = {
            id: 't12',
            title: 'Area recurring',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-01T09:00:00.000Z',
            recurrence: 'daily',
            areaId: 'area-1',
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-01T10:00:00.000Z', 'done');
        expect(next?.areaId).toBe('area-1');
    });

    it('projects the next future strict recurrence without creating a real task', () => {
        const task: Task = {
            id: 't-projected-monthly',
            title: 'Monthly bill',
            status: 'next',
            tags: [],
            contexts: [],
            dueDate: '2025-01-01',
            recurrence: 'monthly',
            showFutureRecurrence: true,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const projected = createProjectedRecurringTask(task, '2025-05-27T12:00:00.000Z');

        expect(projected?.id).toBe(getProjectedRecurringTaskId(task.id));
        expect(projected?.sourceTaskId).toBe(task.id);
        expect(isProjectedRecurringTask(projected)).toBe(true);
        expect(projected?.dueDate).toBe('2025-06-01');
        expect(projected?.createdAt).toBe(task.createdAt);
        expect(projected?.updatedAt).toBe('2025-05-27T12:00:00.000Z');
    });

    it('returns the calendar occurrence date for calendar-visible tasks', () => {
        expect(getTaskCalendarOccurrenceDate({
            startTime: '2026-07-09T09:00',
            dueDate: '2026-07-10',
        })).toBe('2026-07-09T09:00');
        expect(getTaskCalendarOccurrenceDate({
            dueDate: '2026-07-10',
        })).toBe('2026-07-10');
        expect(getTaskCalendarOccurrenceDate({})).toBeUndefined();
    });

    it.each(localApiRecurrenceParityCases.map((testCase) => [testCase.name, testCase] as const))(
        'matches the local API recurrence parity fixture: %s',
        (_name, testCase) => {
            const next = createNextRecurringTask(testCase.task, testCase.completedAt, testCase.previousStatus);

            expect(toLocalApiRecurrenceParitySnapshot(next)).toEqual(testCase.expected);
        }
    );

    it('returns the projected calendar occurrence date for recurrence previews', () => {
        const task: Task = {
            id: 't-projected-date-label',
            title: 'Ninth day planning',
            status: 'next',
            tags: [],
            contexts: [],
            recurrence: {
                rule: 'monthly',
                strategy: 'strict',
                byMonthDay: [9],
                rrule: 'FREQ=MONTHLY;BYMONTHDAY=9',
            },
            showFutureRecurrence: true,
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
        };

        expect(getProjectedRecurringTaskCalendarDate(task, '2026-06-05T12:00:00.000Z')).toBe('2026-07-09');
    });

    it('projects a start-only monthly nth-weekday recurrence into the calendar preview', () => {
        const task: Task = {
            id: 't-projected-first-thursday',
            title: 'First Thursday planning',
            status: 'next',
            tags: [],
            contexts: [],
            startTime: '2026-06-04T09:00',
            recurrence: {
                rule: 'monthly',
                strategy: 'strict',
                byDay: ['1TH'],
                rrule: 'FREQ=MONTHLY;BYDAY=1TH',
            },
            showFutureRecurrence: true,
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
        };

        const projected = createProjectedRecurringTask(task, '2026-06-30T12:00:00.000Z');

        expect(projected?.startTime).toBe('2026-07-02T09:00');
        expect(projected?.dueDate).toBeUndefined();
    });

    it('projects a start-only monthly day-of-month recurrence into the calendar preview', () => {
        const task: Task = {
            id: 't-projected-ninth-day',
            title: 'Ninth day planning',
            status: 'next',
            tags: [],
            contexts: [],
            startTime: '2026-06-01T09:00',
            recurrence: {
                rule: 'monthly',
                strategy: 'strict',
                byMonthDay: [9],
            },
            showFutureRecurrence: true,
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
        };

        const projected = createProjectedRecurringTask(task, '2026-06-30T12:00:00.000Z');

        expect(projected?.startTime).toBe('2026-07-09T09:00');
        expect(projected?.dueDate).toBeUndefined();
    });

    it('expands an unscheduled monthly day-of-month recurrence into current and projected calendar tasks', () => {
        const task: Task = {
            id: 't-projected-unscheduled-ninth-day',
            title: 'Ninth day planning',
            status: 'next',
            tags: [],
            contexts: [],
            recurrence: {
                rule: 'monthly',
                strategy: 'strict',
                byMonthDay: [9],
                rrule: 'FREQ=MONTHLY;BYMONTHDAY=9',
            },
            showFutureRecurrence: true,
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
        };

        const current = createCurrentRecurringCalendarTask(task, '2026-06-05T12:00:00.000Z');
        const projected = createProjectedRecurringTask(task, '2026-06-05T12:00:00.000Z');
        const expanded = expandCalendarRecurringTasks(task, '2026-06-05T12:00:00.000Z');

        expect(current?.id).toBe(task.id);
        expect(current?.startTime).toBe('2026-06-09');
        expect(isProjectedRecurringTask(current)).toBe(false);
        expect(projected?.id).toBe(getProjectedRecurringTaskId(task.id));
        expect(projected?.startTime).toBe('2026-07-09');
        expect(expanded.map((item) => ({
            id: item.id,
            projected: isProjectedRecurringTask(item),
            startTime: item.startTime,
        }))).toEqual([
            { id: task.id, projected: false, startTime: '2026-06-09' },
            { id: getProjectedRecurringTaskId(task.id), projected: true, startTime: '2026-07-09' },
        ]);
    });

    it('expands an unscheduled monthly nth-weekday recurrence into current and projected calendar tasks', () => {
        const task: Task = {
            id: 't-projected-unscheduled-third-thursday',
            title: 'Third Thursday planning',
            status: 'next',
            tags: [],
            contexts: [],
            recurrence: {
                rule: 'monthly',
                strategy: 'strict',
                byDay: ['3TH'],
                rrule: 'FREQ=MONTHLY;BYDAY=3TH',
            },
            showFutureRecurrence: true,
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
        };

        const current = createCurrentRecurringCalendarTask(task, '2026-06-05T12:00:00.000Z');
        const projected = createProjectedRecurringTask(task, '2026-06-05T12:00:00.000Z');

        expect(current?.id).toBe(task.id);
        expect(current?.startTime).toBe('2026-06-18');
        expect(isProjectedRecurringTask(current)).toBe(false);
        expect(projected?.id).toBe(getProjectedRecurringTaskId(task.id));
        expect(projected?.startTime).toBe('2026-07-16');
        expect(projected?.dueDate).toBeUndefined();
    });

    it('projects fluid BYDAY interval recurrence to the same date completion would spawn', () => {
        const task: Task = {
            id: 't-projected-fluid-byday-interval',
            title: 'Change bedsheets',
            status: 'next',
            tags: [],
            contexts: [],
            dueDate: '2026-07-12',
            recurrence: {
                rule: 'weekly',
                strategy: 'fluid',
                rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU',
            },
            showFutureRecurrence: true,
            createdAt: '2026-07-01T00:00:00.000Z',
            updatedAt: '2026-07-01T00:00:00.000Z',
        };

        const projected = createProjectedRecurringTask(task, '2026-07-14T10:00:00.000Z');
        const spawned = createNextRecurringTask(task, '2026-07-14T10:00:00.000Z', 'done');

        expect(projected?.dueDate?.slice(0, 10)).toBe('2026-07-26');
        expect(projected?.dueDate?.slice(0, 10)).toBe(spawned?.dueDate);
    });

    it('projects a future-dated fluid task from its own date, not from now (#900)', () => {
        // Reporter's case: due 3 days from now, fluid daily INTERVAL=3. Projecting
        // from "now" would land on/before the due date and duplicate it on the
        // calendar; the fix must project one interval past the due date itself.
        const task: Task = {
            id: 't-projected-fluid-future-daily',
            title: 'Run',
            status: 'next',
            tags: [],
            contexts: [],
            dueDate: '2026-07-21',
            recurrence: {
                rule: 'daily',
                strategy: 'fluid',
                interval: 3,
                rrule: 'FREQ=DAILY;INTERVAL=3',
            },
            showFutureRecurrence: true,
            createdAt: '2026-07-01T00:00:00.000Z',
            updatedAt: '2026-07-01T00:00:00.000Z',
        };

        const projected = createProjectedRecurringTask(task, '2026-07-18T12:00:00.000Z');

        expect(projected?.dueDate).toBe('2026-07-24');
        expect(projected?.dueDate).not.toBe(task.dueDate);

        // Parity: the projection must match what completing the task on its own
        // due date would actually spawn.
        const spawned = createNextRecurringTask(task, task.dueDate as string, 'done');
        expect(projected?.dueDate).toBe(spawned?.dueDate);
    });

    it('projects a future-dated fluid weekly BYDAY task by counting the interval from its own date, not from now', () => {
        const task: Task = {
            id: 't-projected-fluid-future-byday',
            title: 'Water plants',
            status: 'next',
            tags: [],
            contexts: [],
            dueDate: '2026-07-12', // Sunday, future relative to projectedAtIso below
            recurrence: {
                rule: 'weekly',
                strategy: 'fluid',
                rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU',
            },
            showFutureRecurrence: true,
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
        };

        const projected = createProjectedRecurringTask(task, '2026-07-01T10:00:00.000Z');
        const spawned = createNextRecurringTask(task, task.dueDate as string, 'done');

        // Two weeks after the task's own Sunday, not the Sunday nearest to "now".
        expect(projected?.dueDate).toBe('2026-07-26');
        expect(projected?.dueDate).not.toBe(task.dueDate);
        expect(projected?.dueDate).toBe(spawned?.dueDate);
    });

    it('projects a fluid start+due pair from one due-led occurrence', () => {
        const task: Task = {
            id: 't-projected-fluid-start-due',
            title: 'Prep and ship report',
            status: 'next',
            tags: [],
            contexts: [],
            startTime: '2026-07-20T09:00',
            dueDate: '2026-07-22T17:00',
            recurrence: {
                rule: 'daily',
                strategy: 'fluid',
                interval: 2,
                rrule: 'FREQ=DAILY;INTERVAL=2',
            },
            showFutureRecurrence: true,
            createdAt: '2026-07-01T00:00:00.000Z',
            updatedAt: '2026-07-01T00:00:00.000Z',
        };

        const projected = createProjectedRecurringTask(task, '2026-07-18T08:00:00.000Z');

        expect(projected?.startTime).toBe('2026-07-22T09:00');
        expect(projected?.dueDate).toBe('2026-07-24T17:00');

        const originalSpacingMs = new Date(task.dueDate as string).getTime() - new Date(task.startTime as string).getTime();
        const projectedSpacingMs = new Date(projected?.dueDate as string).getTime() - new Date(projected?.startTime as string).getTime();
        expect(projectedSpacingMs).toBe(originalSpacingMs);
    });

    it.each([
        {
            label: 'strict date-only',
            strategy: 'strict' as const,
            startTime: '2026-06-01',
            dueDate: '2026-06-03',
            reviewAt: '2026-06-04',
            completedAt: '2026-06-03T18:00:00.000Z',
            expected: ['2026-06-14', '2026-06-16', '2026-06-17'],
        },
        {
            label: 'fluid date-only',
            strategy: 'fluid' as const,
            startTime: '2026-06-01',
            dueDate: '2026-06-03',
            reviewAt: '2026-06-04',
            completedAt: '2026-06-10T12:00:00.000Z',
            expected: ['2026-06-14', '2026-06-16', '2026-06-17'],
        },
        {
            label: 'strict datetime',
            strategy: 'strict' as const,
            startTime: '2026-06-01T09:00',
            dueDate: '2026-06-03T17:00',
            reviewAt: '2026-06-04T18:00',
            completedAt: '2026-06-03T18:00:00.000Z',
            expected: ['2026-06-14T09:00', '2026-06-16T17:00', '2026-06-17T18:00'],
        },
        {
            label: 'fluid datetime',
            strategy: 'fluid' as const,
            startTime: '2026-06-01T09:00',
            dueDate: '2026-06-03T17:00',
            reviewAt: '2026-06-04T18:00',
            completedAt: '2026-06-10T12:00:00.000Z',
            expected: ['2026-06-14T09:00', '2026-06-16T12:00:00.000Z', '2026-06-17T18:00'],
        },
    ])('keeps a multi-day monthly occurrence coherent for $label', ({
        strategy,
        startTime,
        dueDate,
        reviewAt,
        completedAt,
        expected,
    }) => {
        const task: Task = {
            id: `coherent-${strategy}-${startTime}`,
            title: 'Prepare, deliver, review',
            status: 'next',
            tags: [],
            contexts: [],
            startTime,
            dueDate,
            reviewAt,
            recurrence: {
                rule: 'monthly',
                strategy,
                byMonthDay: [1, 16],
                rrule: 'FREQ=MONTHLY;BYMONTHDAY=1,16',
            },
            showFutureRecurrence: true,
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
        };

        const spawned = createNextRecurringTask(task, completedAt, 'done');
        const projected = createProjectedRecurringTask(task, completedAt);

        expect([spawned?.startTime, spawned?.dueDate, spawned?.reviewAt]).toEqual(expected);
        expect([projected?.startTime, projected?.dueDate, projected?.reviewAt]).toEqual(expected);
    });

    it('sweeps fluid schedule/rule/timing combinations, projecting strictly past the field\'s own date when future-dated', () => {
        const projectedAtIso = '2026-07-15T10:00:00.000Z'; // Wednesday
        type ScheduleType = 'due-only' | 'start-only' | 'start+due';
        type RuleType = 'daily-interval' | 'weekly-byday';
        type Timing = 'future' | 'overdue';

        const fieldDate = (rule: RuleType, timing: Timing): string => {
            if (rule === 'daily-interval') return timing === 'future' ? '2026-07-20' : '2026-07-10';
            // Sundays, matching BYDAY=SU
            return timing === 'future' ? '2026-07-19' : '2026-07-05';
        };

        const buildRecurrence = (rule: RuleType): Task['recurrence'] => (
            rule === 'daily-interval'
                ? { rule: 'daily', strategy: 'fluid', interval: 3, rrule: 'FREQ=DAILY;INTERVAL=3' }
                : { rule: 'weekly', strategy: 'fluid', rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU' }
        );

        const scheduleTypes: ScheduleType[] = ['due-only', 'start-only', 'start+due'];
        const ruleTypes: RuleType[] = ['daily-interval', 'weekly-byday'];
        const timings: Timing[] = ['future', 'overdue'];

        for (const scheduleType of scheduleTypes) {
            for (const ruleType of ruleTypes) {
                for (const timing of timings) {
                    const date = fieldDate(ruleType, timing);
                    const task: Task = {
                        id: `t-matrix-${scheduleType}-${ruleType}-${timing}`,
                        title: 'Matrix task',
                        status: 'next',
                        tags: [],
                        contexts: [],
                        ...(scheduleType === 'due-only' ? { dueDate: date } : {}),
                        ...(scheduleType === 'start-only' ? { startTime: date } : {}),
                        ...(scheduleType === 'start+due' ? { startTime: date, dueDate: date } : {}),
                        recurrence: buildRecurrence(ruleType),
                        showFutureRecurrence: true,
                        createdAt: '2026-06-01T00:00:00.000Z',
                        updatedAt: '2026-06-01T00:00:00.000Z',
                    };

                    const projected = createProjectedRecurringTask(task, projectedAtIso);
                    expect(projected).not.toBeNull();

                    if (timing === 'future') {
                        if (task.dueDate) {
                            expect(new Date(projected?.dueDate as string).getTime())
                                .toBeGreaterThan(new Date(task.dueDate).getTime());
                        }
                        if (task.startTime) {
                            expect(new Date(projected?.startTime as string).getTime())
                                .toBeGreaterThan(new Date(task.startTime).getTime());
                        }
                    }
                }
            }
        }
    });

    it('does not project recurring tasks unless the calendar preview is enabled', () => {
        const task: Task = {
            id: 't-projected-disabled',
            title: 'Monthly bill',
            status: 'next',
            tags: [],
            contexts: [],
            dueDate: '2025-01-01',
            recurrence: 'monthly',
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        expect(createProjectedRecurringTask(task, '2025-05-27T12:00:00.000Z')).toBeNull();
    });

    it('does not project past the configured recurrence count', () => {
        const task: Task = {
            id: 't-projected-count',
            title: 'Three-time reminder',
            status: 'next',
            tags: [],
            contexts: [],
            dueDate: '2025-01-01',
            recurrence: {
                rule: 'daily',
                strategy: 'strict',
                count: 3,
                completedOccurrences: 0,
                rrule: 'FREQ=DAILY;COUNT=3',
            },
            showFutureRecurrence: true,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        expect(createProjectedRecurringTask(task, '2025-01-04T12:00:00.000Z')).toBeNull();
    });

    it('carries the calendar projection setting to the next real recurrence', () => {
        const task: Task = {
            id: 't-projected-carry',
            title: 'Monthly bill',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-01',
            recurrence: 'monthly',
            showFutureRecurrence: true,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-01T12:00:00.000Z', 'done');

        expect(next?.showFutureRecurrence).toBe(true);
    });

    it('keeps priority, energy level, and assignee on recurring task instances', () => {
        const task: Task = {
            id: 't13',
            title: 'High focus recurring',
            status: 'done',
            priority: 'urgent',
            energyLevel: 'high',
            assignedTo: 'Ada',
            tags: [],
            contexts: [],
            dueDate: '2025-01-01T09:00:00.000Z',
            recurrence: 'daily',
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-01T10:00:00.000Z', 'done');
        expect(next?.priority).toBe('urgent');
        expect(next?.energyLevel).toBe('high');
        expect(next?.assignedTo).toBe('Ada');
    });
});

describe('expandCalendarRecurringTasksInRange', () => {
    const rangeTask = (overrides: Partial<Task>): Task => ({
        id: 't-range-task',
        title: 'Range task',
        status: 'next',
        tags: [],
        contexts: [],
        showFutureRecurrence: true,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        ...overrides,
    });

    it.each([
        { interval: 1, dates: ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'] },
        { interval: 2, dates: ['2026-10-01', '2026-10-03', '2026-10-05'] },
    ])('starts date-less daily interval $interval on today (#1322)', ({ interval, dates }) => {
        const task = rangeTask({
            recurrence: { rule: 'daily', strategy: 'strict', rrule: `FREQ=DAILY;INTERVAL=${interval}` },
        });
        const expanded = expandCalendarRecurringTasksInRange(
            task,
            { startIso: '2026-09-27', endIso: '2026-10-05' },
            '2026-10-01T12:00:00',
        );

        expect(expanded.map((occurrence) => occurrence.startTime?.slice(0, 10))).toEqual(dates);
        expect(expanded.every((occurrence) => /^\d{4}-\d{2}-\d{2}$/.test(occurrence.startTime ?? ''))).toBe(true);
        expect(task.startTime).toBeUndefined();
    });

    it.each([
        {
            label: 'MO/WE includes today', now: '2026-10-05T12:00:00',
            recurrence: { rule: 'weekly', byDay: ['MO', 'WE'], strategy: 'strict' },
            dates: ['2026-10-05', '2026-10-07', '2026-10-12', '2026-10-14', '2026-10-19', '2026-10-21'],
        },
        {
            label: 'interval 2 starts at the next match', now: '2026-10-01T12:00:00',
            recurrence: { rule: 'weekly', strategy: 'strict', rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;WKST=MO' },
            dates: ['2026-10-05', '2026-10-07', '2026-10-19', '2026-10-21'],
        },
        {
            label: 'interval 2 respects Sunday week start', now: '2026-10-04T12:00:00',
            recurrence: { rule: 'weekly', strategy: 'strict', rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,MO;WKST=SU' },
            dates: ['2026-10-04', '2026-10-05', '2026-10-18', '2026-10-19'],
        },
    ] satisfies { label: string; now: string; recurrence: Task['recurrence']; dates: string[] }[])(
        'projects date-less weekly $label (#1322)', ({ now, recurrence, dates }) => {
            const task = rangeTask({ recurrence });
            const expanded = expandCalendarRecurringTasksInRange(
                task, { startIso: '2026-09-27', endIso: '2026-10-21' }, now,
            );

            expect(expanded.map((occurrence) => occurrence.startTime?.slice(0, 10))).toEqual(dates);
            expect(expanded.every((occurrence) => /^\d{4}-\d{2}-\d{2}$/.test(occurrence.startTime ?? ''))).toBe(true);
            expect(task.startTime).toBeUndefined();
        },
    );

    it.each(['weekly', 'yearly', 'monthly'] as const)('leaves date-less %s without selectors unscheduled (#1322)', (rule) => {
        const task = rangeTask({ recurrence: rule });
        expect(expandCalendarRecurringTasksInRange(
            task, { startIso: '2026-10-01', endIso: '2026-11-01' }, '2026-10-01T12:00:00',
        )).toEqual([task]);
    });

    it.each([
        'daily',
        { rule: 'weekly', byDay: ['MO', 'WE'] },
    ] satisfies Task['recurrence'][])('keeps date-less recurrence %j disabled with the toggle off (#1322)', (recurrence) => {
        const task = rangeTask({ recurrence, showFutureRecurrence: false });
        expect(expandCalendarRecurringTasksInRange(
            task, { startIso: '2026-10-01', endIso: '2026-11-01' }, '2026-10-01T12:00:00',
        )).toEqual([task]);
        expect(expandCalendarRecurringTasks(task, '2026-10-01T12:00:00')).toEqual([task]);
    });

    it.each([
        { completedOccurrences: 0, until: undefined, dates: ['2026-10-01', '2026-10-02', '2026-10-03'] },
        { completedOccurrences: 2, until: undefined, dates: ['2026-10-01'] },
        { completedOccurrences: 3, until: undefined, dates: [] },
        { completedOccurrences: 0, until: '2026-10-02', dates: ['2026-10-01', '2026-10-02'] },
        { completedOccurrences: 0, until: '2026-09-30', dates: [] },
    ])('bounds date-less daily COUNT=3, completed=$completedOccurrences, UNTIL=$until (#1322)', ({ completedOccurrences, until, dates }) => {
        const task = rangeTask({ recurrence: { rule: 'daily', count: 3, completedOccurrences, until } });
        const expanded = expandCalendarRecurringTasksInRange(
            task, { startIso: '2026-10-01', endIso: '2026-11-01' }, '2026-10-01T12:00:00',
        );
        expect(expanded.filter((occurrence) => occurrence.startTime).map((occurrence) => occurrence.startTime?.slice(0, 10))).toEqual(dates);
    });

    it.each([
        {
            rule: 'daily', rrule: 'FREQ=DAILY;INTERVAL=2',
            dates: ['2026-10-01', '2026-10-03', '2026-10-05', '2026-10-07', '2026-10-09', '2026-10-11', '2026-10-13'],
        },
        {
            rule: 'weekly', rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE',
            dates: ['2026-10-05', '2026-10-14'],
        },
    ] as const)('keeps existing fluid stepping after the date-less $rule current occurrence (#1322)', ({ rule, rrule, dates }) => {
        const task = rangeTask({ recurrence: { rule, strategy: 'fluid', rrule } });
        const expanded = expandCalendarRecurringTasksInRange(
            task, { startIso: '2026-10-01', endIso: '2026-10-14' }, '2026-10-01T12:00:00',
        );
        expect(expanded.map((occurrence) => occurrence.startTime?.slice(0, 10))).toEqual(dates);
    });

    it('preserves monthly exclusion of today when its date-less rule matches (#1322)', () => {
        const task = rangeTask({ recurrence: { rule: 'monthly', byMonthDay: [1] } });
        expect(createCurrentRecurringCalendarTask(task, '2026-10-01T12:00:00')?.startTime).toBe('2026-11-01');
    });

    it('keeps per-task and total caps for date-less daily projections (#1322)', () => {
        const tasks = Array.from({ length: 20 }, (_, index) => rangeTask({ id: `dateless-${index}`, recurrence: 'daily' }));
        const range = { startIso: '2026-10-01', endIso: '2027-01-01' };
        const now = '2026-10-01T12:00:00';
        expect(expandCalendarRecurringTasksInRange(tasks[0], range, now).filter(isProjectedRecurringTask))
            .toHaveLength(CALENDAR_RANGE_PROJECTION_PER_TASK_CAP);
        expect(expandCalendarRecurringTaskSetInRange(tasks, range, now).filter(isProjectedRecurringTask))
            .toHaveLength(CALENDAR_RANGE_PROJECTION_TOTAL_CAP);
    });

    it('paints a daily task into every visible day and includes exact range-boundary occurrences', () => {
        const task = rangeTask({
            id: 't-range-daily',
            dueDate: '2026-08-02T12:00:00.000Z',
            recurrence: 'daily',
        });
        const projectedAtIso = '2026-08-02T12:00:00.000Z';
        const range = { startIso: '2026-08-03T12:00:00.000Z', endIso: '2026-08-06T12:00:00.000Z' };

        const expanded = expandCalendarRecurringTasksInRange(task, range, projectedAtIso);

        expect(expanded[0]).toBe(task);
        const projected = expanded.slice(1);
        expect(projected.map((occurrence) => occurrence.dueDate)).toEqual([
            '2026-08-03T12:00:00.000Z',
            '2026-08-04T12:00:00.000Z',
            '2026-08-05T12:00:00.000Z',
            '2026-08-06T12:00:00.000Z',
        ]);
        for (const occurrence of projected) {
            expect(isProjectedRecurringTask(occurrence)).toBe(true);
            expect(occurrence.sourceTaskId).toBe(task.id);
            expect(isProjectedRecurringTaskId(occurrence.id)).toBe(true);
        }
    });

    it('expands a single-weekday weekly recurrence to every occurrence in range', () => {
        const task = rangeTask({
            id: 't-range-weekly-single',
            dueDate: '2026-08-03', // a Monday
            recurrence: { rule: 'weekly', strategy: 'strict', byDay: ['MO'], rrule: 'FREQ=WEEKLY;BYDAY=MO' },
        });
        const projectedAtIso = '2026-08-02T12:00:00.000Z';
        const range = { startIso: '2026-08-01', endIso: '2026-09-15' };

        const projected = expandCalendarRecurringTasksInRange(task, range, projectedAtIso).slice(1);

        expect(projected.map((occurrence) => occurrence.dueDate)).toEqual([
            '2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14',
        ]);
        for (const occurrence of projected) {
            expect(new Date(`${occurrence.dueDate}T00:00:00`).getDay()).toBe(1); // Monday
        }
    });

    it('expands a multi-weekday weekly recurrence, alternating between the configured weekdays', () => {
        const task = rangeTask({
            id: 't-range-weekly-multi',
            dueDate: '2026-08-03', // a Monday
            recurrence: { rule: 'weekly', strategy: 'strict', byDay: ['MO', 'WE'], rrule: 'FREQ=WEEKLY;BYDAY=MO,WE' },
        });
        const projectedAtIso = '2026-08-02T12:00:00.000Z';
        const range = { startIso: '2026-08-01', endIso: '2026-08-20' };

        const projected = expandCalendarRecurringTasksInRange(task, range, projectedAtIso).slice(1);

        expect(projected.map((occurrence) => occurrence.dueDate)).toEqual([
            '2026-08-05', '2026-08-10', '2026-08-12', '2026-08-17', '2026-08-19',
        ]);
        for (const occurrence of projected) {
            const weekday = new Date(`${occurrence.dueDate}T00:00:00`).getDay();
            expect([1, 3]).toContain(weekday); // Monday or Wednesday only
        }
    });

    it('honors an interval greater than one for a daily recurrence', () => {
        const task = rangeTask({
            id: 't-range-interval-daily',
            dueDate: '2026-08-01',
            recurrence: { rule: 'daily', strategy: 'strict', interval: 2, rrule: 'FREQ=DAILY;INTERVAL=2' },
        });
        const projectedAtIso = '2026-07-30T00:00:00.000Z';
        const range = { startIso: '2026-08-01', endIso: '2026-08-09' };

        const projected = expandCalendarRecurringTasksInRange(task, range, projectedAtIso).slice(1);

        expect(projected.map((occurrence) => occurrence.dueDate)).toEqual([
            '2026-08-03', '2026-08-05', '2026-08-07', '2026-08-09',
        ]);
        for (let i = 1; i < projected.length; i += 1) {
            const gapMs = new Date(projected[i]!.dueDate as string).getTime() - new Date(projected[i - 1]!.dueDate as string).getTime();
            expect(gapMs).toBe(2 * 24 * 60 * 60 * 1000);
        }
    });

    it('honors an interval greater than one for a weekly recurrence', () => {
        const task = rangeTask({
            id: 't-range-interval-weekly',
            dueDate: '2026-08-03', // a Monday
            recurrence: { rule: 'weekly', strategy: 'strict', interval: 2, rrule: 'FREQ=WEEKLY;INTERVAL=2' },
        });
        const projectedAtIso = '2026-07-01T00:00:00.000Z';
        const range = { startIso: '2026-08-01', endIso: '2026-09-20' };

        const projected = expandCalendarRecurringTasksInRange(task, range, projectedAtIso).slice(1);

        expect(projected.map((occurrence) => occurrence.dueDate)).toEqual([
            '2026-08-17', '2026-08-31', '2026-09-14',
        ]);
        for (const occurrence of projected) {
            expect(new Date(`${occurrence.dueDate}T00:00:00`).getDay()).toBe(1); // stays on Monday
        }
        for (let i = 1; i < projected.length; i += 1) {
            const gapMs = new Date(projected[i]!.dueDate as string).getTime() - new Date(projected[i - 1]!.dueDate as string).getTime();
            expect(gapMs).toBe(14 * 24 * 60 * 60 * 1000);
        }
    });

    it('stops mid-range once the recurrence COUNT is exhausted', () => {
        const task = rangeTask({
            id: 't-range-count',
            dueDate: '2026-08-02T12:00:00.000Z',
            recurrence: { rule: 'daily', strategy: 'strict', count: 5, completedOccurrences: 0, rrule: 'FREQ=DAILY;COUNT=5' },
        });
        const projectedAtIso = '2026-08-02T12:00:00.000Z';
        // Range extends far past where COUNT exhausts, to prove the stop happens mid-range and
        // not because the range itself ran out.
        const range = { startIso: '2026-08-01', endIso: '2026-08-15' };

        const projected = expandCalendarRecurringTasksInRange(task, range, projectedAtIso).slice(1);

        expect(projected.map((occurrence) => occurrence.dueDate)).toEqual([
            '2026-08-03T12:00:00.000Z',
            '2026-08-04T12:00:00.000Z',
            '2026-08-05T12:00:00.000Z',
            '2026-08-06T12:00:00.000Z',
        ]);
    });

    it('stops mid-range once the recurrence UNTIL date passes, including the UNTIL date itself', () => {
        const task = rangeTask({
            id: 't-range-until',
            dueDate: '2026-08-02T12:00:00.000Z',
            recurrence: { rule: 'daily', strategy: 'strict', until: '2026-08-05', rrule: 'FREQ=DAILY;UNTIL=20260805T000000Z' },
        });
        const projectedAtIso = '2026-08-02T12:00:00.000Z';
        const range = { startIso: '2026-08-01', endIso: '2026-08-10' };

        const projected = expandCalendarRecurringTasksInRange(task, range, projectedAtIso).slice(1);

        expect(projected.map((occurrence) => occurrence.dueDate)).toEqual([
            '2026-08-03T12:00:00.000Z',
            '2026-08-04T12:00:00.000Z',
            '2026-08-05T12:00:00.000Z',
        ]);
    });

    it('keeps date-only occurrences date-only across a DST spring-forward transition', () => {
        const task = rangeTask({
            id: 't-range-dst-date-only',
            dueDate: '2026-03-06', // Friday, before the 2026-03-08 US spring-forward
            recurrence: 'daily',
        });
        const projectedAtIso = '2026-03-01T00:00:00.000Z';
        const range = { startIso: '2026-03-07', endIso: '2026-03-10' };

        const projected = expandCalendarRecurringTasksInRange(task, range, projectedAtIso).slice(1);

        expect(projected.map((occurrence) => occurrence.dueDate)).toEqual([
            '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10',
        ]);
        for (const occurrence of projected) {
            expect(occurrence.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
    });

    it('keeps a datetime occurrence\'s wall-clock time across a DST spring-forward transition', () => {
        const task = rangeTask({
            id: 't-range-dst-datetime',
            startTime: '2026-03-06T09:00',
            recurrence: 'daily',
        });
        const projectedAtIso = '2026-03-01T00:00:00.000Z';
        // endIso is an exact instant (inclusive), not a whole-day shorthand -- callers widen to
        // end-of-day themselves (see the desktop/mobile controllers), so cover the whole 10th here.
        const range = { startIso: '2026-03-07', endIso: '2026-03-10T23:59:59' };

        const projected = expandCalendarRecurringTasksInRange(task, range, projectedAtIso).slice(1);

        expect(projected.map((occurrence) => occurrence.startTime)).toEqual([
            '2026-03-07T09:00', '2026-03-08T09:00', '2026-03-09T09:00', '2026-03-10T09:00',
        ]);
    });

    it('returns just the task itself when showFutureRecurrence is off, matching expandCalendarRecurringTasks', () => {
        const task = rangeTask({
            id: 't-range-disabled',
            dueDate: '2026-08-02',
            recurrence: 'daily',
            showFutureRecurrence: false,
        });
        const range = { startIso: '2026-08-01', endIso: '2026-09-01' };

        const expanded = expandCalendarRecurringTasksInRange(task, range);

        expect(expanded).toEqual([task]);
        expect(expanded).toEqual(expandCalendarRecurringTasks(task));
    });

    it('truncates at the per-task cap, earliest occurrences winning, even with a much larger range', () => {
        const task = rangeTask({
            id: 't-range-per-task-cap',
            dueDate: '2026-01-01T00:00:00.000Z',
            recurrence: 'daily',
        });
        const projectedAtIso = '2026-01-01T00:00:00.000Z';
        const range = { startIso: '2026-01-01', endIso: '2027-01-01' };

        const explicitCap = expandCalendarRecurringTasksInRange(task, range, projectedAtIso, 5).slice(1);
        expect(explicitCap).toHaveLength(5);
        expect(explicitCap[0]?.dueDate).toBe('2026-01-02T00:00:00.000Z');
        expect(explicitCap[4]?.dueDate).toBe('2026-01-06T00:00:00.000Z');

        const defaultCap = expandCalendarRecurringTasksInRange(task, range, projectedAtIso).slice(1);
        expect(defaultCap).toHaveLength(CALENDAR_RANGE_PROJECTION_PER_TASK_CAP);
    });

    it('holds the monthly anchor day fixed across a February clamp instead of drifting to the clamped value', () => {
        // Without a fixed anchor this drifts to Feb 28, Mar 28, Apr 28... instead of returning
        // to the 31st whenever the month allows it (correction pass finding 1).
        const task = rangeTask({
            id: 't-range-monthly-anchor-31',
            dueDate: '2026-01-31',
            recurrence: 'monthly',
        });
        const projectedAtIso = '2026-01-01T00:00:00.000Z';
        const range = { startIso: '2026-02-01', endIso: '2026-07-01' };

        const projected = expandCalendarRecurringTasksInRange(task, range, projectedAtIso).slice(1);

        expect(projected.map((occurrence) => occurrence.dueDate)).toEqual([
            '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30',
        ]);
    });

    it('returns to Feb 29 in a later leap year instead of getting stuck on Feb 28 (correction pass finding 1)', () => {
        const task = rangeTask({
            id: 't-range-yearly-anchor-29',
            dueDate: '2024-02-29',
            recurrence: 'yearly',
        });
        const projectedAtIso = '2024-03-01T00:00:00.000Z';
        // 2025/2026/2027 clamp to the 28th and are walked-past (before rangeStart); 2028 is the
        // next leap year and must land back on the 29th.
        const range = { startIso: '2027-06-01', endIso: '2028-12-31' };

        const projected = expandCalendarRecurringTasksInRange(task, range, projectedAtIso).slice(1);

        expect(projected.map((occurrence) => occurrence.dueDate)).toEqual(['2028-02-29']);
    });

    it('matches createProjectedRecurringTask for the first occurrence (anchor, clamp, and fluid parity)', () => {
        const cases: Task[] = [
            rangeTask({ id: 't-parity-monthly-31', dueDate: '2026-01-31', recurrence: 'monthly' }),
            rangeTask({ id: 't-parity-yearly-leap', dueDate: '2024-02-29', recurrence: 'yearly' }),
            rangeTask({
                id: 't-parity-fluid-interval',
                dueDate: '2026-07-15',
                recurrence: { rule: 'daily', strategy: 'fluid', interval: 3, rrule: 'FREQ=DAILY;INTERVAL=3' },
            }),
        ];
        const projectedAtIso = '2026-01-01T00:00:00.000Z';
        const wideOpenRange = { startIso: '2000-01-01', endIso: '2100-01-01' };

        for (const task of cases) {
            const single = createProjectedRecurringTask(task, projectedAtIso);
            const [firstRanged] = expandCalendarRecurringTasksInRange(task, wideOpenRange, projectedAtIso).slice(1);
            expect(firstRanged?.dueDate).toEqual(single?.dueDate);
            expect(firstRanged?.startTime).toEqual(single?.startTime);
        }
    });

    it('fills the entire visible window for a daily task even when the range starts many months out (correction pass finding 3)', () => {
        // The reviewer's measured repro: a per-task cap that counted walked-past steps instead of
        // in-range occurrences returned 0 occurrences for November and 3-then-blank for October.
        const task = rangeTask({
            id: 't-range-far-future-window',
            dueDate: '2026-08-02',
            recurrence: 'daily',
        });
        const projectedAtIso = '2026-08-02T00:00:00.000Z';

        const novemberProjected = expandCalendarRecurringTasksInRange(
            task, { startIso: '2026-11-01', endIso: '2026-11-30' }, projectedAtIso,
        ).slice(1);
        expect(novemberProjected).toHaveLength(30);
        expect(novemberProjected[0]?.dueDate).toBe('2026-11-01');
        expect(novemberProjected[29]?.dueDate).toBe('2026-11-30');

        const octoberProjected = expandCalendarRecurringTasksInRange(
            task, { startIso: '2026-10-01', endIso: '2026-10-31' }, projectedAtIso,
        ).slice(1);
        expect(octoberProjected).toHaveLength(31);
    });

    it('charges only in-range (pushed) occurrences against the cap, not the walk-up before the range starts', () => {
        const task = rangeTask({
            id: 't-range-cap-in-range-only',
            dueDate: '2026-08-02',
            recurrence: 'daily',
        });
        const projectedAtIso = '2026-08-02T00:00:00.000Z';
        // ~90 days of walked-past-but-discarded occurrences before the range even starts.
        const range = { startIso: '2026-11-01', endIso: '2027-01-01' };

        const projected = expandCalendarRecurringTasksInRange(task, range, projectedAtIso, 5).slice(1);

        expect(projected).toHaveLength(5);
        expect(projected[0]?.dueDate).toBe('2026-11-01');
        expect(projected[4]?.dueDate).toBe('2026-11-05');
    });

    it('jumps to a far-future visible range without dropping daily occurrences', () => {
        const task = rangeTask({
            id: 't-range-years-ahead',
            dueDate: '2026-08-02',
            recurrence: 'daily',
        });

        const projected = expandCalendarRecurringTasksInRange(
            task,
            { startIso: '2030-08-01', endIso: '2030-08-03' },
            '2026-08-02T00:00:00.000Z',
        ).slice(1);

        expect(projected.map((occurrence) => occurrence.dueDate)).toEqual([
            '2030-08-01',
            '2030-08-02',
            '2030-08-03',
        ]);
    });

    it('uses one far-range occurrence step for every schedule field', () => {
        const task = rangeTask({
            id: 't-range-multi-field-offset',
            startTime: '2026-08-01',
            dueDate: '2026-08-03',
            recurrence: 'daily',
        });

        const projected = expandCalendarRecurringTasksInRange(
            task,
            { startIso: '2030-08-01', endIso: '2030-08-05' },
            '2026-08-01T00:00:00.000Z',
        ).slice(1);

        expect(projected.map((occurrence) => ({
            startTime: occurrence.startTime,
            dueDate: occurrence.dueDate,
        }))).toEqual([
            { startTime: '2030-07-30', dueDate: '2030-08-01' },
            { startTime: '2030-07-31', dueDate: '2030-08-02' },
            { startTime: '2030-08-01', dueDate: '2030-08-03' },
            { startTime: '2030-08-02', dueDate: '2030-08-04' },
            { startTime: '2030-08-03', dueDate: '2030-08-05' },
        ]);
    });

    it('charges far-range multi-field catch-up against COUNT once per occurrence', () => {
        const task = rangeTask({
            id: 't-range-multi-field-count',
            startTime: '2026-08-01',
            dueDate: '2026-08-03',
            recurrence: {
                rule: 'daily',
                strategy: 'strict',
                count: 1460,
                completedOccurrences: 0,
                rrule: 'FREQ=DAILY;COUNT=1460',
            },
        });

        const projected = expandCalendarRecurringTasksInRange(
            task,
            { startIso: '2030-08-01', endIso: '2030-08-05' },
            '2026-08-01T00:00:00.000Z',
        ).slice(1);

        expect(projected).toHaveLength(1);
        expect(projected[0]).toMatchObject({
            startTime: '2030-07-30',
            dueDate: '2030-08-01',
        });
    });

    it('recomputes a relative start from the shared far-range due occurrence', () => {
        const task = rangeTask({
            id: 't-range-relative-start',
            startTime: '2026-01-30',
            dueDate: '2026-01-31',
            relativeStartOffset: { amount: -1, unit: 'day' },
            recurrence: {
                rule: 'monthly',
                strategy: 'strict',
                anchorDay: 31,
                startAnchorDay: 30,
                dueAnchorDay: 31,
                rrule: 'FREQ=MONTHLY',
            },
        });

        const projected = expandCalendarRecurringTasksInRange(
            task,
            { startIso: '2027-02-01', endIso: '2027-02-28' },
            '2026-01-31T00:00:00.000Z',
        ).slice(1);

        expect(projected).toHaveLength(1);
        expect(projected[0]).toMatchObject({
            startTime: '2027-02-27',
            dueDate: '2027-02-28',
            relativeStartOffset: { amount: -1, unit: 'day' },
        });
    });

    it('keeps the completion anchor when a fluid series catches up to a far-future range', () => {
        const task = rangeTask({
            id: 't-range-years-ahead-fluid',
            dueDate: '2026-08-02',
            recurrence: {
                rule: 'daily',
                strategy: 'fluid',
                interval: 3,
                rrule: 'FREQ=DAILY;INTERVAL=3',
            },
        });

        const projected = expandCalendarRecurringTasksInRange(
            task,
            { startIso: '2030-08-01', endIso: '2030-08-09' },
            '2026-08-02T00:00:00.000Z',
        ).slice(1);

        expect(projected.map((occurrence) => occurrence.dueDate)).toEqual([
            '2030-08-02',
            '2030-08-05',
            '2030-08-08',
        ]);
    });

    it('keeps COUNT authoritative when jumping past exhausted occurrences', () => {
        const task = rangeTask({
            id: 't-range-years-ahead-count',
            dueDate: '2026-08-02',
            recurrence: {
                rule: 'daily',
                strategy: 'strict',
                count: 5,
                completedOccurrences: 0,
                rrule: 'FREQ=DAILY;COUNT=5',
            },
        });

        const projected = expandCalendarRecurringTasksInRange(
            task,
            { startIso: '2030-08-01', endIso: '2030-08-03' },
            '2026-08-02T00:00:00.000Z',
        ).slice(1);

        expect(projected).toEqual([]);
    });

    it('keeps fluid COUNT authoritative while catch-up skips discarded occurrences', () => {
        const task = rangeTask({
            id: 't-range-years-ahead-fluid-count',
            dueDate: '2026-08-02',
            recurrence: {
                rule: 'daily',
                strategy: 'fluid',
                interval: 3,
                count: 5,
                completedOccurrences: 0,
                rrule: 'FREQ=DAILY;INTERVAL=3;COUNT=5',
            },
        });

        const projected = expandCalendarRecurringTasksInRange(
            task,
            { startIso: '2030-08-01', endIso: '2030-08-09' },
            '2026-08-02T00:00:00.000Z',
        ).slice(1);

        expect(projected).toEqual([]);
    });

    it('shares the total projection budget across every recurring series', () => {
        const tasks = Array.from({ length: 20 }, (_, index) => rangeTask({
            id: `t-range-fair-${index}`,
            dueDate: '2026-08-02',
            recurrence: 'daily',
        }));

        const expanded = expandCalendarRecurringTaskSetInRange(
            tasks,
            { startIso: '2026-08-03', endIso: '2026-09-13' },
            '2026-08-02T00:00:00.000Z',
        );
        const projected = expanded.filter(isProjectedRecurringTask);
        const counts = new Map<string, number>();
        projected.forEach((occurrence) => {
            counts.set(occurrence.sourceTaskId, (counts.get(occurrence.sourceTaskId) ?? 0) + 1);
        });

        expect(projected).toHaveLength(CALENDAR_RANGE_PROJECTION_TOTAL_CAP);
        expect(tasks.map((task) => counts.get(task.id))).toEqual(Array(20).fill(25));
    });

    it('redistributes projection budget that exhausted series cannot use', () => {
        const exhausted = Array.from({ length: 3 }, (_, index) => rangeTask({
            id: `t-range-exhausted-${index}`,
            dueDate: '2026-08-02',
            recurrence: {
                rule: 'daily',
                strategy: 'strict',
                count: 1,
                completedOccurrences: 0,
                rrule: 'FREQ=DAILY;COUNT=1',
            },
        }));
        const active = rangeTask({
            id: 't-range-active',
            dueDate: '2026-08-02',
            recurrence: 'daily',
        });

        const expanded = expandCalendarRecurringTaskSetInRange(
            [...exhausted, active],
            { startIso: '2026-08-03', endIso: '2026-08-20' },
            '2026-08-02T00:00:00.000Z',
            8,
        );
        const projected = expanded.filter(isProjectedRecurringTask);

        expect(projected).toHaveLength(8);
        expect(projected.every((occurrence) => occurrence.sourceTaskId === active.id)).toBe(true);
    });
});

describe('createNextRecurringTask late completion coherence', () => {
    // Local (offset-free) date strings throughout: the schedule fields and the
    // completion instant are then read in the same zone, so every cell asserts
    // the same thing regardless of the machine's timezone.
    const buildTask = (overrides: Partial<Task>): Task => ({
        id: 'late-completion',
        title: 'Late completion',
        status: 'done',
        tags: [],
        contexts: [],
        recurrence: { rule: 'daily', strategy: 'strict' },
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        ...overrides,
    });

    const at = (iso: string): number => (safeParseDate(iso) as Date).getTime();
    const calendarDayDiff = (fromIso: string, toIso: string): number => {
        const from = safeParseDate(fromIso) as Date;
        const to = safeParseDate(toIso) as Date;
        const dayNumber = (date: Date) => (
            Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000
        );
        return dayNumber(to) - dayNumber(from);
    };

    it('keeps the next instance on one day when a strict daily start=due task is completed a day late', () => {
        const next = createNextRecurringTask(
            buildTask({ startTime: '2026-08-10', dueDate: '2026-08-10' }),
            '2026-08-11T20:00',
            'done',
        );

        expect(next?.startTime).toBe('2026-08-12');
        expect(next?.dueDate).toBe('2026-08-12');
    });

    it('advances every schedule field by the same steps when completion is several periods late', () => {
        const next = createNextRecurringTask(
            buildTask({ startTime: '2026-08-10', dueDate: '2026-08-12', reviewAt: '2026-08-13' }),
            '2026-08-15T20:00',
            'done',
        );

        // The due anchor catches up to the first occurrence after completion
        // (16th); start and review keep their 2-day and 1-day offsets from it.
        expect(next?.startTime).toBe('2026-08-14');
        expect(next?.dueDate).toBe('2026-08-16');
        expect(next?.reviewAt).toBe('2026-08-17');
    });

    it('keeps the wall-clock times of a datetime task when the past-completion push fires', () => {
        const next = createNextRecurringTask(
            buildTask({ startTime: '2026-08-10T09:00', dueDate: '2026-08-10T17:00' }),
            '2026-08-11T20:00',
            'done',
        );

        expect(next?.startTime).toBe('2026-08-12T09:00');
        expect(next?.dueDate).toBe('2026-08-12T17:00');
    });

    type Shape = 'same-day' | 'start-before-due' | 'start-due-review';
    type RuleKey = 'daily' | 'weekly' | 'monthly';
    type Precision = 'date-only' | 'datetime';
    type Timing = 'before-next-start' | 'after-next-start' | 'several-periods-late';

    const shapeOffsets: Record<Shape, { due: number; review?: number }> = {
        'same-day': { due: 0 },
        'start-before-due': { due: 2 },
        'start-due-review': { due: 2, review: 3 },
    };
    // Base start is 2026-08-10 (a Monday), day 10 of the month, so no weekly or
    // monthly cell ever hits a month-end clamp that would move a day offset.
    const fieldIso = (precision: Precision, day: string, time: string): string => (
        precision === 'date-only' ? day : `${day}T${time}`
    );
    const baseDays: Record<Shape, { start: string; due: string; review?: string }> = {
        'same-day': { start: '2026-08-10', due: '2026-08-10' },
        'start-before-due': { start: '2026-08-10', due: '2026-08-12' },
        'start-due-review': { start: '2026-08-10', due: '2026-08-12', review: '2026-08-13' },
    };
    const completedAt: Record<RuleKey, Record<Timing, string>> = {
        daily: {
            'before-next-start': '2026-08-10T20:00',
            'after-next-start': '2026-08-11T20:00',
            'several-periods-late': '2026-08-15T20:00',
        },
        weekly: {
            'before-next-start': '2026-08-16T20:00',
            'after-next-start': '2026-08-17T20:00',
            'several-periods-late': '2026-09-07T20:00',
        },
        monthly: {
            'before-next-start': '2026-09-09T20:00',
            'after-next-start': '2026-09-10T20:00',
            'several-periods-late': '2026-11-10T20:00',
        },
    };

    const shapes = Object.keys(shapeOffsets) as Shape[];
    const rules: RuleKey[] = ['daily', 'weekly', 'monthly'];
    const precisions: Precision[] = ['date-only', 'datetime'];
    const timings: Timing[] = ['before-next-start', 'after-next-start', 'several-periods-late'];

    it('sweeps strict start/due/review shapes against on-time and late completions', () => {
        for (const shape of shapes) {
            for (const rule of rules) {
                for (const precision of precisions) {
                    for (const timing of timings) {
                        const label = `${shape}/${rule}/${precision}/${timing}`;
                        const days = baseDays[shape];
                        const task = buildTask({
                            id: `late-${shape}-${rule}-${precision}-${timing}`,
                            startTime: fieldIso(precision, days.start, '09:00'),
                            dueDate: fieldIso(precision, days.due, '17:00'),
                            ...(days.review ? { reviewAt: fieldIso(precision, days.review, '18:00') } : {}),
                            recurrence: { rule, strategy: 'strict' },
                        });
                        const completion = completedAt[rule][timing];

                        const next = createNextRecurringTask(task, completion, 'done');
                        expect(next, label).not.toBeNull();
                        const nextStart = next?.startTime as string;
                        const nextDue = next?.dueDate as string;

                        // Coherence: the source start<->due<->review offsets survive.
                        expect(calendarDayDiff(nextStart, nextDue), label)
                            .toBe(calendarDayDiff(task.startTime as string, task.dueDate as string));
                        // The same start-after-due check the store runs over every
                        // task and both apps render as a warning on the row.
                        expect(isTaskDateCoherent(next as Task), label).toBe(true);
                        if (task.reviewAt) {
                            const nextReview = next?.reviewAt as string;
                            expect(calendarDayDiff(nextDue, nextReview), label)
                                .toBe(calendarDayDiff(task.dueDate as string, task.reviewAt));
                            expect(at(nextDue), label).toBeLessThanOrEqual(at(nextReview));
                        }

                        // The past-completion guard's intent: never hand back an
                        // occurrence that is already past. The occurrence is
                        // identified by its due date; a start already behind at
                        // completion time with its due date ahead is a live task.
                        expect(at(nextDue), label).toBeGreaterThan(at(completion));
                        // And it always moves forward from the source instance.
                        expect(at(nextStart), label).toBeGreaterThan(at(task.startTime as string));

                        // P13: date-only fields never gain an implicit time.
                        const fields = [nextStart, nextDue, ...(next?.reviewAt ? [next.reviewAt] : [])];
                        for (const value of fields) {
                            expect(/^\d{4}-\d{2}-\d{2}$/.test(value), `${label} ${value}`)
                                .toBe(precision === 'date-only');
                        }
                        if (precision === 'datetime') {
                            expect(nextStart.endsWith('T09:00'), label).toBe(true);
                            expect(nextDue.endsWith('T17:00'), label).toBe(true);
                        }
                    }
                }
            }
        }
    });

    it('leaves relative start offsets deriving from the next due date when completion is late', () => {
        const next = createNextRecurringTask(
            buildTask({
                startTime: '2026-08-09',
                dueDate: '2026-08-10',
                relativeStartOffset: { amount: -1, unit: 'day' },
            }),
            '2026-08-11T20:00',
            'done',
        );

        expect(next?.dueDate).toBe('2026-08-11');
        expect(next?.startTime).toBe('2026-08-10');
        expect(next?.relativeStartOffset).toEqual({ amount: -1, unit: 'day' });
    });

    it('catches up start-only strict tasks to today when completed several days late (#1366)', () => {
        const next = createNextRecurringTask(
            buildTask({ startTime: '2026-08-10' }),
            '2026-08-13T20:00',
            'done',
        );

        expect(next?.startTime).toBe('2026-08-13');
        expect(next?.dueDate).toBeUndefined();
    });

    const catchUpRules = [
        { name: 'daily', recurrence: { rule: 'daily' }, first: '2026-01-06', today: '2026-01-08', next: '2026-01-09' },
        { name: 'weekly', recurrence: { rule: 'weekly' }, first: '2026-01-12', today: '2026-01-26', next: '2026-02-02' },
        { name: 'monthly-day', recurrence: { rule: 'monthly', byMonthDay: [5] }, first: '2026-02-05', today: '2026-04-05', next: '2026-05-05' },
        { name: 'monthly-nth', recurrence: { rule: 'monthly', byDay: ['1MO'] }, first: '2026-02-02', today: '2026-04-06', next: '2026-05-04' },
        { name: 'yearly', recurrence: { rule: 'yearly' }, first: '2027-01-05', today: '2029-01-05', next: '2030-01-05' },
        { name: 'COUNT', recurrence: { rule: 'daily', count: 3, completedOccurrences: 0 }, first: '2026-01-06', today: '2026-01-08', next: '2026-01-09' },
    ] satisfies { name: string; recurrence: NonNullable<Exclude<Task['recurrence'], string>>; first: string; today: string; next: string }[];
    const catchUpCases = catchUpRules.flatMap((schedule) =>
        (['strict', 'fluid'] as const).flatMap((strategy) =>
            (['start-only', 'due-only', 'both', 'neither'] as const).flatMap((shape) =>
                (['date-only', 'datetime'] as const).map((precision) => ({
                    ...schedule, strategy, shape, precision,
                    label: `${strategy}/${shape}/${schedule.name}/${precision}`,
                })))));

    it.each(catchUpCases)('preserves recurrence completion matrix $label (#1366)', ({ recurrence, first, today, next, strategy, shape, precision }) => {
        const scheduled = fieldIso(precision, '2026-01-05', '09:00');
        const task = buildTask({
            startTime: shape === 'start-only' || shape === 'both' ? scheduled : undefined,
            dueDate: shape === 'due-only' || shape === 'both' ? scheduled : undefined,
            recurrence: { ...recurrence, strategy, seriesId: 'matrix-series' },
        });
        const completion = `${today}T12:00`;
        const result = createNextRecurringTask(task, completion, 'done')!;
        const expectedDay = strategy === 'fluid' || shape === 'neither' || shape === 'both'
            ? next : shape === 'due-only' ? first : precision === 'date-only' ? today : next;
        const expected = shape === 'neither' ? expectedDay
            : fieldIso(precision, expectedDay, strategy === 'fluid' ? '12:00' : '09:00');

        const expectedStart = strategy === 'fluid' && shape === 'both' ? fieldIso(precision, expectedDay, '09:00') : expected;
        expect(result.startTime).toBe(shape === 'start-only' || shape === 'both' || shape === 'neither' ? expectedStart : undefined);
        expect(result.dueDate).toBe(shape === 'due-only' || shape === 'both' ? expected : undefined);
        expect(result.status).toBe('next');
        expect(result.recurrence).toMatchObject({ ...recurrence, strategy, seriesId: 'matrix-series',
            ...(recurrence.count ? { completedOccurrences: 1 } : {}) });
        expect(projectNextRecurringTask(task, completion)).toEqual(projectNextRecurringTask(task, completion));
        const reloaded = normalizeRecurrenceForLoad(JSON.parse(JSON.stringify(result.recurrence)));
        expect(reloaded).toEqual(normalizeRecurrenceForLoad(result.recurrence));
        expect(applyTaskUpdates({ ...result, recurrence: reloaded }, { description: 'Edited' }, completion).updatedTask.recurrence)
            .toEqual(reloaded);

        if (strategy === 'strict' && shape !== 'neither') {
            const skipped = createNextRecurringTask(task, completion, 'next', { advanceOne: true })!;
            expect(skipped.startTime).toBe(shape === 'start-only' || shape === 'both' ? fieldIso(precision, first, '09:00') : undefined);
            expect(skipped.dueDate).toBe(shape === 'due-only' || shape === 'both' ? fieldIso(precision, first, '09:00') : undefined);
        }
    });

    it.each([
        { startTime: '2026-08-10', completion: '2026-08-13T20:00', expected: '2026-08-13' },
        { startTime: '2026-08-10T09:00', completion: '2026-08-13T08:00', expected: '2026-08-13T09:00' },
        { startTime: '2026-08-10T09:00', completion: '2026-08-13T09:00', expected: '2026-08-16T09:00' },
        { startTime: '2026-08-10T09:00', completion: '2026-08-13T20:00', expected: '2026-08-16T09:00' },
    ])('retains strict interval cadence at the boundary $completion ($startTime)', ({ startTime, completion, expected }) => {
        const task = buildTask({ startTime, recurrence: { rule: 'daily', strategy: 'strict', rrule: 'FREQ=DAILY;INTERVAL=3' } });
        expect(createNextRecurringTask(task, completion, 'done')?.startTime).toBe(expected);
    });

    it('retains month-end anchors and review spacing after start-only catchup (#1366)', () => {
        const task = buildTask({ startTime: '2026-01-31', reviewAt: '2026-02-01', recurrence: { rule: 'monthly', strategy: 'strict' } });
        const result = createNextRecurringTask(task, '2026-04-20T12:00', 'done')!;
        expect(result.startTime).toBe('2026-04-30');
        expect(result.reviewAt).toBe('2026-05-01');
        expect(createNextRecurringTask(result, '2026-04-30T12:00', 'done')?.startTime).toBe('2026-05-31');
    });

    it('keeps local wall time across DST and catches up long daily gaps (#1366)', () => {
        const task = buildTask({ startTime: '2026-03-06T09:00' });
        expect(createNextRecurringTask(task, '2026-03-09T12:00', 'done')?.startTime).toBe('2026-03-10T09:00');
        expect(createNextRecurringTask({ ...task, startTime: '2000-01-01' }, '2026-08-13T20:00', 'done')?.startTime)
            .toBe('2026-08-13');
    });

    it.each([
        { startTime: '2000-01-03', recurrence: { rule: 'weekly', byDay: ['MO'] }, completion: '2026-10-11T12:00', expected: '2026-10-12' },
        { startTime: '2000-01-03', recurrence: { rule: 'weekly', byDay: ['MO', 'WE', 'FR'], rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;WKST=SU' }, completion: '2026-10-11T12:00', expected: '2026-10-19' },
        { startTime: '2000-01-03', recurrence: { rule: 'monthly', byDay: ['MO', 'TU', 'WE', 'TH', 'FR'] }, completion: '2026-10-11T12:00', expected: '2026-10-12' },
        { startTime: '2000-01-31', recurrence: { rule: 'monthly', byDay: ['-1MO'], rrule: 'FREQ=MONTHLY;INTERVAL=2;BYDAY=-1MO' }, completion: '2026-10-11T12:00', expected: '2026-11-30' },
    ] satisfies { startTime: string; recurrence: NonNullable<Exclude<Task['recurrence'], string>>; completion: string; expected: string }[])(
        'catches up old selector series $recurrence without exhausting the search cap (#1366)', ({ startTime, recurrence, completion, expected }) => {
            const task = buildTask({ startTime, recurrence: { ...recurrence, strategy: 'strict', count: 3 } });
            const result = createNextRecurringTask(task, completion, 'done')!;
            expect(result.startTime).toBe(expected);
            expect(result.recurrence).toMatchObject({ count: 3, completedOccurrences: 1 });
        },
    );

    it.each([
        { rule: 'weekly', byDay: ['MO', 'WE', 'FR'], rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;WKST=SU' },
        { rule: 'monthly', byDay: ['-1MO'], rrule: 'FREQ=MONTHLY;INTERVAL=2;BYDAY=-1MO' },
        { rule: 'monthly', byMonthDay: [1, 31], rrule: 'FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=1,31' },
    ] satisfies NonNullable<Exclude<Task['recurrence'], string>>[])(
        'matches canonical one-step selector cadence across DST $rrule (#1366)', (recurrence) => {
            const task = buildTask({ startTime: '2025-01-03T09:00', recurrence: { ...recurrence, strategy: 'strict' } });
            const completion = '2026-03-09T12:00';
            let expected = task;
            for (let steps = 0; steps < 500; steps += 1) {
                expected = createNextRecurringTask(expected, completion, 'done', { advanceOne: true })!;
                if (at(expected.startTime!) > at(completion)) break;
            }
            expect(at(expected.startTime!)).toBeGreaterThan(at(completion));
            expect(createNextRecurringTask(task, completion, 'done')?.startTime).toBe(expected.startTime);
        },
    );

    it('honors UNTIL and counts completions rather than skipped dates on start-only catchup (#1366)', () => {
        const task = buildTask({ startTime: '2026-08-10', recurrence: { rule: 'daily', strategy: 'strict', count: 2, until: '2026-08-13' } });
        const result = createNextRecurringTask(task, '2026-08-13T20:00', 'done')!;
        expect(result.startTime).toBe('2026-08-13');
        expect(result.recurrence).toMatchObject({ completedOccurrences: 1 });
        expect(createNextRecurringTask(result, '2026-08-13T20:00', 'done')).toBeNull();
        expect(createNextRecurringTask({ ...task, recurrence: { rule: 'daily', strategy: 'strict', until: '2026-08-12' } }, '2026-08-13T20:00', 'done')).toBeNull();
        const timed = buildTask({ startTime: '2026-08-10T12:00:00+14:00',
            recurrence: { rule: 'daily', strategy: 'strict', until: '2026-08-11T11:00:00-12:00' } });
        expect(createNextRecurringTask(timed, '2026-08-10T23:00:00Z', 'done')?.startTime).toBe('2026-08-11T22:00:00.000Z');
    });

    it('keeps fluid start and due spacing around the completion-anchored due date', () => {
        const next = createNextRecurringTask(
            buildTask({
                startTime: '2026-08-10',
                dueDate: '2026-08-12',
                recurrence: { rule: 'daily', strategy: 'fluid' },
            }),
            '2026-08-15T20:00',
            'done',
        );

        // Fluid re-bases the due anchor on completion, while the sibling start
        // keeps its original two-day lead.
        expect(next?.startTime).toBe('2026-08-14');
        expect(next?.dueDate).toBe('2026-08-16');
    });

    // Local (offset-free) strings: every zone the suite runs in asserts the same
    // local days. Due-only strict completion keeps one step by design, so it is
    // not part of this parity table.
    it.each([
        { label: 'daily overdue date-only start', fields: { startTime: '2026-10-08' }, now: '2026-10-11T12:00', next: { startTime: '2026-10-11' } },
        { label: 'daily start yesterday', fields: { startTime: '2026-10-10' }, now: '2026-10-11T00:30', next: { startTime: '2026-10-11' } },
        { label: 'daily interval 3', fields: { startTime: '2026-08-10' }, rrule: { rule: 'daily', rrule: 'FREQ=DAILY;INTERVAL=3' }, now: '2026-08-13T20:00', next: { startTime: '2026-08-13' } },
        { label: 'weekly', fields: { startTime: '2026-10-04' }, rrule: { rule: 'weekly' }, now: '2026-10-11T12:00', next: { startTime: '2026-10-11' } },
        { label: 'weekly three weeks late', fields: { startTime: '2026-01-05' }, rrule: { rule: 'weekly' }, now: '2026-01-26T12:00', next: { startTime: '2026-01-26' } },
        { label: 'monthly-day', fields: { startTime: '2026-02-05' }, rrule: { rule: 'monthly', byMonthDay: [5] }, now: '2026-04-05T12:00', next: { startTime: '2026-04-05' } },
        { label: 'monthly-nth', fields: { startTime: '2026-02-02' }, rrule: { rule: 'monthly', byDay: ['1MO'] }, now: '2026-04-06T12:00', next: { startTime: '2026-04-06' } },
        { label: 'month-end on the 30th', fields: { startTime: '2026-01-31', reviewAt: '2026-02-01' }, rrule: { rule: 'monthly' }, now: '2026-04-30T12:00', next: { startTime: '2026-04-30', reviewAt: '2026-05-01' } },
        { label: 'month-end mid-month', fields: { startTime: '2026-01-31', reviewAt: '2026-02-01' }, rrule: { rule: 'monthly' }, now: '2026-04-20T12:00', next: { startTime: '2026-04-30', reviewAt: '2026-05-01' } },
        { label: 'Feb 29 yearly', fields: { startTime: '2024-02-29' }, rrule: { rule: 'yearly' }, now: '2027-02-28T12:00', next: { startTime: '2027-02-28' } },
        { label: 'DST date-only', fields: { startTime: '2026-03-06' }, now: '2026-03-09T12:00', next: { startTime: '2026-03-09' } },
        { label: 'DST timed start', fields: { startTime: '2026-03-06T09:00' }, now: '2026-03-09T12:00', next: { startTime: '2026-03-10T09:00' } },
        { label: 'timed start later today', fields: { startTime: '2026-10-08T15:00' }, now: '2026-10-11T12:00', next: { startTime: '2026-10-11T15:00' } },
        { label: 'start and due', fields: { startTime: '2026-01-05', dueDate: '2026-01-05' }, now: '2026-01-08T12:00', next: { startTime: '2026-01-09', dueDate: '2026-01-09' } },
        { label: 'future start', fields: { startTime: '2026-10-15' }, now: '2026-10-11T12:00', next: { startTime: '2026-10-16' } },
        { label: 'start today', fields: { startTime: '2026-10-11' }, now: '2026-10-11T12:00', next: { startTime: '2026-10-12' } },
    ] satisfies { label: string; fields: Partial<Task>; rrule?: NonNullable<Exclude<Task['recurrence'], string>>; now: string; next: Partial<Task> }[])(
        'previews the same next occurrence that completion creates: $label (#1366)', ({ fields, rrule, now, next }) => {
            const task = buildTask({ ...fields, recurrence: { ...(rrule ?? { rule: 'daily' }), strategy: 'strict' } });
            const pick = (value: Task | null | undefined) => ({
                startTime: value?.startTime, dueDate: value?.dueDate, reviewAt: value?.reviewAt,
            });
            const expected = { startTime: undefined, dueDate: undefined, reviewAt: undefined, ...next };
            expect(pick(createNextRecurringTask(task, now, 'done'))).toEqual(expected);

            const open: Task = { ...task, status: 'next', showFutureRecurrence: true };
            expect(pick(createProjectedRecurringTask(open, now))).toEqual(expected);
            expect(getRecurringTaskPreviewDate({ ...open, showFutureRecurrence: false }, now))
                .toBe(getTaskCalendarOccurrenceDate({ ...open, ...expected }));
            const range = expandCalendarRecurringTasksInRange(open, { startIso: '2000-01-01T00:00', endIso: '2031-01-01T00:00' }, now);
            expect(pick(range[1])).toEqual(expected);
        },
    );
});

describe('getRecurringTaskPreviewDate', () => {
    const nowIso = '2026-07-03T12:00:00.000Z';
    const base: Task = {
        id: 'preview-1',
        title: 'Pay rent',
        status: 'next',
        tags: [],
        contexts: [],
        createdAt: nowIso,
        updatedAt: nowIso,
    };

    it.each([
        { recurrence: 'daily', date: '2026-07-03' },
        { recurrence: { rule: 'daily', rrule: 'FREQ=DAILY;INTERVAL=2' }, date: '2026-07-03' },
        { recurrence: { rule: 'weekly', byDay: ['MO', 'WE'] }, date: '2026-07-06' },
        { recurrence: { rule: 'weekly', byDay: ['FR'] }, date: '2026-07-03' },
    ] satisfies { recurrence: Task['recurrence']; date: string }[])(
        'previews date-less $recurrence as $date with the toggle off (#1322)', ({ recurrence, date }) => {
            expect(getRecurringTaskPreviewDate({ ...base, recurrence, showFutureRecurrence: false }, '2026-07-03T12:00:00')).toBe(date);
        },
    );

    it('shows the first upcoming occurrence for an unscheduled day-of-month rule without the calendar toggle', () => {
        const task: Task = {
            ...base,
            recurrence: { rule: 'monthly', strategy: 'strict', byMonthDay: [9], rrule: 'FREQ=MONTHLY;BYMONTHDAY=9' },
        };
        expect(getRecurringTaskPreviewDate(task, nowIso)).toBe('2026-07-09');
    });

    it('shows the first upcoming occurrence for an unscheduled nth-weekday rule without the calendar toggle', () => {
        const task: Task = {
            ...base,
            recurrence: { rule: 'monthly', strategy: 'strict', byDay: ['3TH'], rrule: 'FREQ=MONTHLY;BYDAY=3TH' },
        };
        expect(getRecurringTaskPreviewDate(task, nowIso)).toBe('2026-07-16');
    });

    it('shows the first upcoming occurrence for an unscheduled plain monthly BYDAY rule', () => {
        const task: Task = {
            ...base,
            recurrence: { rule: 'monthly', strategy: 'strict', rrule: 'FREQ=MONTHLY;BYDAY=MO,WE' },
        };
        expect(getRecurringTaskPreviewDate(task, nowIso)).toBe('2026-07-06');
    });

    it('shows the projected next occurrence for a scheduled task', () => {
        const task: Task = {
            ...base,
            startTime: '2026-07-09',
            recurrence: { rule: 'monthly', strategy: 'strict', byMonthDay: [9], rrule: 'FREQ=MONTHLY;BYMONTHDAY=9' },
        };
        expect(getRecurringTaskPreviewDate(task, nowIso)).toBe('2026-08-09');
    });

    it('matches the calendar projection when the calendar toggle is enabled', () => {
        const task: Task = {
            ...base,
            showFutureRecurrence: true,
            recurrence: { rule: 'monthly', strategy: 'strict', byMonthDay: [9], rrule: 'FREQ=MONTHLY;BYMONTHDAY=9' },
        };
        expect(getRecurringTaskPreviewDate(task, nowIso)).toBe('2026-07-09');
    });

    it('returns undefined for done tasks and tasks without recurrence', () => {
        expect(getRecurringTaskPreviewDate({ ...base, status: 'done' as TaskStatus, recurrence: 'daily' }, nowIso)).toBeUndefined();
        expect(getRecurringTaskPreviewDate(base, nowIso)).toBeUndefined();
    });
});

describe('frozen recurring follow-up projection', () => {
    const completedAtIso = '2026-03-07T15:00:00.000Z';
    const ids = ['attachment-1', 'task-1', 'checklist-1', 'checklist-2'];
    const sourceUrl = new URL('./recurrence.ts', import.meta.url).href;
    const subprocess = `
        import { projectNextRecurringTask, buildNextRecurringTask, createNextRecurringTask } from ${JSON.stringify(sourceUrl)};
        const input = JSON.parse(await Bun.stdin.text());
        const projection = input.projection ?? projectNextRecurringTask(input.task, input.completedAtIso);
        let used = 0;
        const row = buildNextRecurringTask(input.task, input.completedAtIso, 'done', projection, () => input.ids[used++]);
        let rnUsed = 0;
        const rn = input.projection ? undefined : createNextRecurringTask(input.task, input.completedAtIso, 'done',
            { createId: () => input.ids[rnUsed++] });
        console.log(JSON.stringify({ projection, row, rn, used, rnUsed }));
    `;
    const inTimeZone = (timeZone: string, input: object) => JSON.parse(execFileSync('bun', ['-e', subprocess], {
        cwd: new URL('../../..', import.meta.url).pathname,
        env: { ...process.env, TZ: timeZone },
        input: JSON.stringify(input),
        encoding: 'utf8',
    }).trim()) as { projection: ReturnType<typeof projectNextRecurringTask>; row: Task | null; rn?: Task | null; used: number; rnUsed: number };
    const base = { id: 'source', title: 'Recurring', status: 'done', recurrence: { rule: 'daily', strategy: 'strict' } } as Task;

    it('rebuilds exact full rows across processes and opposite timezones', () => {
        const cases: Array<{ name: string; task: Task; completedAt: string; expectDue?: string; expectDateOnly?: boolean }> = [
            { name: 'spring DST and copied sub-IDs', task: { ...base, dueDate: '2026-03-07T14:00:00.000Z',
                checklist: [{ id: 'old-check-1', text: 'One', isCompleted: true }, { id: 'old-check-2', text: 'Two', isCompleted: false }],
                attachments: [{ id: 'old-attachment', name: 'file', uri: 'file:///example', cloudKey: 'shared' }] as Task['attachments'],
            }, completedAt: completedAtIso, expectDue: '2026-03-08T13:00:00.000Z' },
            { name: 'fluid date-only near midnight', task: { ...base, dueDate: '2026-03-07',
                recurrence: { rule: 'daily', strategy: 'fluid' } }, completedAt: '2026-03-08T04:30:00.000Z', expectDateOnly: true },
            { name: 'monthly day 31', task: { ...base, dueDate: '2026-01-31',
                recurrence: { rule: 'monthly', anchorDay: 31 } }, completedAt: '2026-01-31T15:00:00.000Z', expectDateOnly: true },
            { name: 'naive UNTIL', task: { ...base, dueDate: '2026-03-07T14:00:00.000Z',
                recurrence: { rule: 'daily', rrule: 'FREQ=DAILY;UNTIL=20260308T090000' } }, completedAt: completedAtIso },
            { name: 'naive DST-gap UNTIL', task: { ...base, dueDate: '2026-03-07T14:00:00.000Z',
                recurrence: { rule: 'daily', rrule: 'FREQ=DAILY;UNTIL=20260308T023000' } }, completedAt: completedAtIso },
            { name: 'Z UNTIL', task: { ...base, dueDate: '2026-03-07T14:00:00.000Z',
                recurrence: { rule: 'daily', rrule: 'FREQ=DAILY;UNTIL=20260308T130000Z' } }, completedAt: completedAtIso },
            { name: 'invalid legacy UNTIL', task: { ...base, dueDate: '2026-03-07T14:00:00.000Z',
                recurrence: { rule: 'daily', rrule: 'FREQ=DAILY;UNTIL=not-a-date' } }, completedAt: completedAtIso },
            { name: 'COUNT exhausted', task: { ...base, dueDate: '2026-03-07',
                recurrence: { rule: 'daily', count: 1, completedOccurrences: 0 } }, completedAt: completedAtIso },
            { name: 'past UNTIL', task: { ...base, dueDate: '2026-03-07',
                recurrence: { rule: 'daily', until: '2026-03-07' } }, completedAt: completedAtIso },
        ];
        for (const testCase of cases) {
            for (const [prepareZone, rebuildZone] of [
                ['America/New_York', 'UTC'], ['UTC', 'America/New_York'],
            ]) {
                const input = { task: testCase.task, completedAtIso: testCase.completedAt, ids };
                const prepared = inTimeZone(prepareZone, input);
                const rebuilt = inTimeZone(rebuildZone, { ...input, projection: prepared.projection });
                expect(prepared.row, `${testCase.name} prepared in ${prepareZone}`).toEqual(prepared.rn);
                expect(rebuilt.row, `${testCase.name} rebuilt in ${rebuildZone}`).toEqual(prepared.row);
                expect(rebuilt.used).toBe(prepared.used);
                expect(prepared.used).toBe(prepared.rnUsed);
                if (testCase.expectDue && prepareZone === 'America/New_York') {
                    expect(prepared.row?.dueDate).toBe(testCase.expectDue);
                }
                if (testCase.expectDateOnly) expect(prepared.row?.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
                if (testCase.name === 'naive UNTIL' && prepareZone === 'America/New_York') {
                    expect(prepared.row?.recurrence && typeof prepared.row.recurrence === 'object'
                        ? prepared.row.recurrence.rrule : undefined).toBe('FREQ=DAILY;UNTIL=20260308T130000Z');
                }
                if (testCase.name === 'invalid legacy UNTIL') {
                    expect(prepared.row?.recurrence && typeof prepared.row.recurrence === 'object'
                        ? prepared.row.recurrence.rrule : undefined).toBe('FREQ=DAILY');
                }
                if (testCase.name === 'spring DST and copied sub-IDs') {
                    expect(prepared.row?.id).toBe('task-1');
                    expect(prepared.row?.attachments?.[0].id).toBe('attachment-1');
                    expect(prepared.row?.checklist?.map((item) => item.id)).toEqual(['checklist-1', 'checklist-2']);
                }
                if (testCase.name === 'COUNT exhausted' || testCase.name === 'past UNTIL') {
                    expect(prepared.projection?.candidate.dueDate).toBeTruthy();
                    expect(prepared.row).toBeNull();
                    expect(prepared.used).toBe(0);
                }
            }
        }
    }, 60_000);

    it('preserves RN legacy invalid schedule fallback and a relative start absent from the source', () => {
        const legacy = createNextRecurringTask({ ...base, dueDate: 'not-a-date' }, completedAtIso, 'done');
        expect(legacy?.dueDate).toBeTruthy();
        expect(legacy?.dueDate).not.toBe('not-a-date');
        const offset = { amount: -1, unit: 'day' as const };
        const linked = { ...base, dueDate: '2026-03-07', relativeStartOffset: offset };
        const next = createNextRecurringTask(linked, completedAtIso, 'done');
        expect(next?.dueDate).toBe('2026-03-08');
        expect(next?.startTime).toBe('2026-03-07');
        expect(next?.relativeStartOffset).toEqual(offset);
        const projection = projectNextRecurringTask(linked, completedAtIso)!;
        expect(buildNextRecurringTask(linked, completedAtIso, 'done', projection)?.startTime).toBe('2026-03-07');
        expect(() => buildNextRecurringTask(linked, completedAtIso, 'done', {
            ...projection, candidate: { ...projection.candidate, relativeStartOffset: undefined },
        })).toThrow('Incomplete recurrence candidate');
    });

    it('refuses a missing or single-operand-tampered projection before allocating IDs', () => {
        const task = { ...base, dueDate: '2026-03-07T14:00:00.000Z',
            recurrence: { rule: 'daily', until: '2026-03-08T13:00:00.000Z' } } as Task;
        const projection = projectNextRecurringTask(task, completedAtIso);
        expect(projection).not.toBeNull();
        const createId = () => { throw new Error('must not allocate'); };
        expect(() => buildNextRecurringTask(task, completedAtIso, 'done', null, createId)).toThrow('Missing recurrence projection');
        expect(() => buildNextRecurringTask(task, completedAtIso, 'done', {
            ...projection!, candidate: { ...projection!.candidate, dueDate: undefined },
        }, createId)).toThrow('Incomplete recurrence candidate');
        const comparison = projection!.until?.comparison;
        expect(comparison?.kind).toBe('epoch');
        if (comparison?.kind !== 'epoch') throw new Error('Expected epoch comparison');
        expect(() => buildNextRecurringTask(task, completedAtIso, 'done', {
            ...projection!, until: { ...projection!.until!, comparison: { ...comparison, candidateMs: comparison.candidateMs + 1 } },
        }, createId)).toThrow('Invalid recurrence instant comparison');
        const dayTask = { ...task, dueDate: '2026-03-07', recurrence: { rule: 'daily', until: '2026-03-08' } } as Task;
        const dayProjection = projectNextRecurringTask(dayTask, completedAtIso)!;
        const dayComparison = dayProjection.until?.comparison;
        if (dayComparison?.kind !== 'local-day') throw new Error('Expected day comparison');
        expect(() => buildNextRecurringTask(dayTask, completedAtIso, 'done', {
            ...dayProjection, until: { ...dayProjection.until!, comparison: { ...dayComparison, candidateDay: '2026-03-07' } },
        }, createId)).toThrow('Invalid recurrence day comparison');
        const exhausted = { ...dayTask, recurrence: { rule: 'daily', count: 1, completedOccurrences: 0 } } as Task;
        expect(() => buildNextRecurringTask(exhausted, completedAtIso, 'done', null, createId)).toThrow('Missing recurrence projection');
        const nonRecurring = { ...task, recurrence: undefined } as Task;
        expect(projectNextRecurringTask(nonRecurring, completedAtIso)).toBeNull();
        expect(buildNextRecurringTask(nonRecurring, completedAtIso, 'done', null, createId)).toBeNull();
        expect(() => buildNextRecurringTask(nonRecurring, completedAtIso, 'done', projection, createId))
            .toThrow('Unexpected recurrence projection');
    });

    it('binds explicit UTC and date-only RRULE UNTIL tokens to the frozen stop value', () => {
        const createId = () => { throw new Error('must not allocate'); };
        const utcTask = { ...base, dueDate: '2026-03-07T14:00:00.000Z',
            recurrence: { rule: 'daily', rrule: 'FREQ=DAILY;UNTIL=20260312T140000Z' } } as Task;
        const utcProjection = projectNextRecurringTask(utcTask, completedAtIso)!;
        expect(utcProjection.until?.comparison?.kind).toBe('epoch');
        const utcComparison = utcProjection.until?.comparison;
        if (utcComparison?.kind !== 'epoch') throw new Error('Expected epoch comparison');
        const earlierUtc = '2026-03-07T13:00:00.000Z';
        const tamperedUtc = {
            ...utcProjection,
            until: {
                normalized: earlierUtc,
                comparison: {
                    ...utcComparison,
                    untilInstant: { epochMs: Date.parse(earlierUtc), offsetMinutes: 0,
                        local: '2026-03-07T13:00:00.000' },
                    untilMs: Date.parse(earlierUtc),
                },
                rruleUntilToken: '20260307T130000Z',
            },
            rruleText: 'FREQ=DAILY;UNTIL=20260307T130000Z',
        } satisfies NonNullable<ReturnType<typeof projectNextRecurringTask>>;
        expect(() => buildNextRecurringTask(utcTask, completedAtIso, 'done', tamperedUtc, createId))
            .toThrow('Invalid recurrence UNTIL source');

        const dayTask = { ...base, dueDate: '2026-03-07',
            recurrence: { rule: 'daily', rrule: 'FREQ=DAILY;UNTIL=20260312' } } as Task;
        const dayProjection = projectNextRecurringTask(dayTask, completedAtIso)!;
        const dayComparison = dayProjection.until?.comparison;
        if (dayComparison?.kind !== 'local-day') throw new Error('Expected day comparison');
        const tamperedDay = {
            ...dayProjection,
            until: { normalized: '2026-03-07',
                comparison: { ...dayComparison, untilDay: '2026-03-07' },
                rruleUntilToken: '20260307' },
            rruleText: 'FREQ=DAILY;UNTIL=20260307',
        } satisfies NonNullable<ReturnType<typeof projectNextRecurringTask>>;
        expect(() => buildNextRecurringTask(dayTask, completedAtIso, 'done', tamperedDay, createId))
            .toThrow('Invalid recurrence UNTIL source');

        const explicitUntilTask = { ...dayTask,
            recurrence: { rule: 'daily', until: '2026-03-12', rrule: 'FREQ=DAILY;UNTIL=20260307' } } as Task;
        const explicitUntilProjection = projectNextRecurringTask(explicitUntilTask, completedAtIso)!;
        expect(explicitUntilProjection.until?.normalized).toBe('2026-03-12');
        expect(buildNextRecurringTask(explicitUntilTask, completedAtIso, 'done', explicitUntilProjection,
            () => 'allowed-by-explicit-until')).not.toBeNull();
    });

    it('binds floating candidate wall text, explicit anchors and copied relative offsets', () => {
        const createId = () => { throw new Error('must not allocate'); };
        const floatingTask = { ...base, dueDate: '2026-03-07T09:00',
            recurrence: { rule: 'daily', until: '2026-03-15' } } as Task;
        const floatingProjection = projectNextRecurringTask(floatingTask, completedAtIso)!;
        const comparison = floatingProjection.until?.comparison;
        if (comparison?.kind !== 'local-day') throw new Error('Expected day comparison');
        const falseWall = '2026-03-16T09:00:00.000';
        const falseEpoch = Date.parse(`${falseWall}Z`) + comparison.candidate.offsetMinutes * 60_000;
        const tamperedFloating = {
            ...floatingProjection,
            until: { ...floatingProjection.until!, comparison: {
                ...comparison,
                candidate: { ...comparison.candidate, local: falseWall, epochMs: falseEpoch },
                candidateDay: '2026-03-16',
            } },
        } satisfies NonNullable<ReturnType<typeof projectNextRecurringTask>>;
        expect(() => buildNextRecurringTask(floatingTask, completedAtIso, 'done', tamperedFloating, createId))
            .toThrow('Invalid recurrence candidate witness');

        const monthlyTask = { ...base, dueDate: '2026-01-31',
            recurrence: { rule: 'monthly', anchorDay: 31 } } as Task;
        const monthlyProjection = projectNextRecurringTask(monthlyTask, '2026-01-31T15:00:00.000Z')!;
        expect(() => buildNextRecurringTask(monthlyTask, '2026-01-31T15:00:00.000Z', 'done', {
            ...monthlyProjection,
            sourceAnchorDays: { ...monthlyProjection.sourceAnchorDays, dueDate: 1 },
        }, createId)).toThrow('Invalid recurrence source anchor');

        const noOffsetTask = { ...base, dueDate: '2026-03-07' } as Task;
        const noOffsetProjection = projectNextRecurringTask(noOffsetTask, completedAtIso)!;
        expect(() => buildNextRecurringTask(noOffsetTask, completedAtIso, 'done', {
            ...noOffsetProjection,
            candidate: { ...noOffsetProjection.candidate, relativeStartOffset: { amount: -2, unit: 'day' } },
        }, createId)).toThrow('Invalid recurrence relative start offset');
    });
});
