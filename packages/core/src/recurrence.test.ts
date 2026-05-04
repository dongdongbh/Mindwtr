import { describe, it, expect } from 'vitest';
import { buildRRuleString, parseRRuleString, createNextRecurringTask, normalizeRecurrenceForLoad } from './recurrence';
import type { Task } from './types';

describe('recurrence', () => {
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
        expect(next?.startTime).toBe('2025-01-08T14:00:00.000Z');
        expect(next?.status).toBe('next');
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

    it('advances startTime by monthly BYDAY interval when interval is greater than 1', () => {
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
        expect(next?.dueDate).toBe('2025-03-13');
        expect(next?.startTime).toBe('2025-03-13');
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
});
