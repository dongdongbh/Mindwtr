import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays, format } from 'date-fns';
import { applyFilter, hasActiveFilterCriteria, keepSavedFilters, normalizeDateRange, normalizeFilterCriteria, normalizeSavedFilters } from './saved-filters';
import { buildAdvancedFilterCriteriaChips, removeAdvancedFilterCriteriaChip } from './saved-filter-labels';
import { buildWidgetTaskList } from './widget-lists';
import { buildAndroidWidgetPublication, createWidgetPayloadProjection, iosWidgetProjectionOptions } from './widget-payload';
import { loadTranslations } from './i18n/i18n-loader';
import { consoleLogger, setLogger, type LogPayload } from './logger';
import type { AppData, DateRange, SavedFilter, Task } from './types';

const originalTz = process.env.TZ;
const task = (id: string, fields: Partial<Task> = {}): Task => ({
    id, title: id, status: 'next', tags: [], contexts: [],
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...fields,
});
const saved = (preset: Extract<DateRange, { preset: string }>['preset']): SavedFilter => ({
    id: 'dates', name: 'Dates', view: 'all', criteria: { anyDateRange: { preset } },
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
});
const data = (tasks: Task[]): AppData => ({
    tasks, projects: [], sections: [], areas: [], settings: { savedFilters: [saved('next_7_days')] },
});

beforeEach(async () => {
    process.env.TZ = 'America/New_York';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-17T16:00:00Z'));
    await loadTranslations('en');
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
});

describe('task date saved filters', () => {
    it.each(['today', 'next_7_days', 'overdue_next_7_days', 'next_14_days', 'next_30_days', 'upcoming'] as const)('normalizes and retains %s as a rolling preset', (preset) => {
        const criteria = { anyDateRange: { preset } };
        expect(normalizeFilterCriteria(criteria)).toEqual(criteria);
        expect(normalizeFilterCriteria(normalizeFilterCriteria(criteria))).toEqual(criteria);
        expect(hasActiveFilterCriteria(criteria)).toBe(true);
        const reloaded = normalizeSavedFilters(keepSavedFilters(JSON.parse(JSON.stringify([saved(preset)]))));
        expect(reloaded[0].criteria).toEqual(criteria);
    });

    it('rejects unknown presets and empty ranges', () => {
        expect(normalizeDateRange({ preset: 'next_8_days' })).toBeUndefined();
        expect(normalizeFilterCriteria({ anyDateRange: { preset: 'unknown' } })).toEqual({});
        expect(normalizeFilterCriteria({ anyDateRange: {} })).toEqual({});
        expect(hasActiveFilterCriteria({ anyDateRange: {} })).toBe(false);
    });

    it('matches start, due, or review dates using OR, then AND with other criteria', () => {
        const tasks = [
            task('start', { startTime: '2026-10-17', dueDate: '2026-10-30', contexts: ['@desk'] }),
            task('due', { dueDate: '2026-10-17', contexts: ['@desk'] }),
            task('review', { reviewAt: '2026-10-17T22:00:00-04:00', contexts: ['@desk'] }),
            task('other-context', { dueDate: '2026-10-17', contexts: ['@home'] }),
            task('none', { contexts: ['@desk'] }),
            task('invalid', { startTime: 'invalid', dueDate: 'invalid', reviewAt: 'invalid', contexts: ['@desk'] }),
            task('recurring-undated', { recurrence: { rule: 'weekly' }, contexts: ['@desk'] }),
        ];
        expect(applyFilter(tasks, { anyDateRange: { preset: 'today' }, contexts: ['@desk'] }).map(({ id }) => id))
            .toEqual(['start', 'due', 'review']);
        expect(applyFilter(tasks, { anyDateRange: { preset: 'today' }, dueDateRange: { preset: 'today' } }).map(({ id }) => id))
            .toEqual(['due', 'other-context']);
    });

    it.each([
        ['2026-03-07T12:00:00-05:00', 7], ['2026-03-07T12:00:00-05:00', 14], ['2026-03-07T12:00:00-05:00', 30],
        ['2026-10-31T12:00:00-04:00', 7], ['2026-10-31T12:00:00-04:00', 14], ['2026-10-31T12:00:00-04:00', 30],
    ])('includes local calendar days across DST from %s for %i days', (instant, days) => {
        const now = new Date(instant);
        const first = format(now, 'yyyy-MM-dd');
        const last = format(addDays(now, days - 1), 'yyyy-MM-dd');
        const after = format(addDays(now, days), 'yyyy-MM-dd');
        const before = format(addDays(now, -1), 'yyyy-MM-dd');
        const tasks = [
            task('before', { dueDate: before }),
            task('first', { startTime: first + 'T00:00:00' }),
            task('last-date', { dueDate: last }),
            task('last-instant', { reviewAt: last + 'T23:59:59.999' }),
            task('after', { startTime: after + 'T00:00:00' }),
        ];
        const range = { preset: `next_${days}_days` } as DateRange;
        expect(applyFilter(tasks, { anyDateRange: range }, { now }).map(({ id }) => id))
            .toEqual(['first', 'last-date', 'last-instant']);
    });

    it('uses the local day for UTC datetimes, includes all of today, and keeps upcoming unbounded', () => {
        const tasks = [
            task('yesterday-utc', { startTime: '2026-10-17T03:59:59Z' }),
            task('midnight-utc', { reviewAt: '2026-10-17T04:00:00Z' }),
            task('date-only', { dueDate: '2026-10-17' }),
            task('next-midnight', { startTime: '2026-10-18T04:00:00Z' }),
            task('far-future', { dueDate: '2030-01-01' }),
        ];
        expect(applyFilter(tasks, { anyDateRange: { preset: 'today' } }).map(({ id }) => id)).toEqual(['midnight-utc', 'date-only']);
        expect(applyFilter(tasks, { anyDateRange: { preset: 'upcoming' } }).map(({ id }) => id))
            .toEqual(['midnight-utc', 'date-only', 'next-midnight', 'far-future']);
    });

    it('combines overdue due dates with the next seven local days without treating past starts or reviews as overdue', () => {
        const tasks = [
            task('old-due', { dueDate: '2020-01-01' }),
            task('timed-overdue', { dueDate: '2026-10-17T11:00:00-04:00' }),
            task('today-later', { startTime: '2026-10-17T23:00:00-04:00' }),
            task('today-date-only', { dueDate: '2026-10-17' }),
            task('last-day', { reviewAt: '2026-10-23T23:59:59.999-04:00' }),
            task('old-start', { startTime: '2026-10-16' }),
            task('old-review', { reviewAt: '2026-10-16' }),
            task('outside-window', { startTime: '2026-10-24T00:00:00-04:00' }),
            task('none'),
            task('invalid', { startTime: 'invalid', dueDate: 'invalid', reviewAt: 'invalid' }),
            task('wrong-status', { dueDate: '2026-10-16', status: 'done' }),
            task('deleted', { dueDate: '2026-10-16', deletedAt: '2026-10-17T00:00:00Z' }),
            task('other-context', { dueDate: '2026-10-16', contexts: ['@home'] }),
        ].map((item) => item.id === 'other-context' ? item : { ...item, contexts: ['@desk'] });
        const criteria = { ...saved('overdue_next_7_days').criteria, statuses: ['next' as const], contexts: ['@desk'] };
        expect(applyFilter(tasks, criteria).map(({ id }) => id))
            .toEqual(['old-due', 'timed-overdue', 'today-later', 'today-date-only', 'last-day']);
        expect(buildAdvancedFilterCriteriaChips(criteria)).toContainEqual({
            id: 'anyDateRange', label: 'Task dates: Overdue + next 7 days',
        });
    });

    it.each(['2026-03-07T12:00:00-05:00', '2026-10-31T12:00:00-04:00'])(
        'keeps the overdue and seven-day window local across DST from %s', (instant) => {
            const now = new Date(instant);
            const before = format(addDays(now, -1), 'yyyy-MM-dd');
            const last = format(addDays(now, 6), 'yyyy-MM-dd');
            const after = format(addDays(now, 7), 'yyyy-MM-dd');
            const tasks = [
                task('overdue', { dueDate: before }),
                task('past-start', { startTime: before }),
                task('last', { reviewAt: last + 'T23:59:59.999' }),
                task('after', { dueDate: after }),
            ];
            expect(applyFilter(tasks, saved('overdue_next_7_days').criteria, { now }).map(({ id }) => id))
                .toEqual(['overdue', 'last']);
        },
    );

    it('requires all task date fields to be absent for no_date', () => {
        const tasks = [task('none'), task('start', { startTime: '2026-10-17' }), task('due', { dueDate: '2026-10-17' }), task('review', { reviewAt: '2026-10-17' })];
        expect(applyFilter(tasks, { anyDateRange: { preset: 'no_date' } }).map(({ id }) => id)).toEqual(['none']);
    });

    it('supports bounded task date ranges and removes only the date chip', () => {
        const criteria = { anyDateRange: { from: '2026-10-17', to: '2026-10-18' }, contexts: ['@desk'] };
        const tasks = [task('review', { reviewAt: '2026-10-18', contexts: ['@desk'] }), task('past', { dueDate: '2026-10-16' })];
        expect(applyFilter(tasks, criteria).map(({ id }) => id)).toEqual(['review']);
        expect(buildAdvancedFilterCriteriaChips({ anyDateRange: { preset: 'next_14_days' } })).toEqual([
            { id: 'anyDateRange', label: 'Task dates: Next 14 days' },
        ]);
        expect(removeAdvancedFilterCriteriaChip(criteria, 'anyDateRange')).toEqual({ contexts: ['@desk'] });
    });

    it('preserves explicit widget now instead of reading a different wall clock', () => {
        const source = data([task('pinned', { dueDate: '2020-01-01' }), task('wall-clock', { dueDate: '2026-10-17' })]);
        source.settings.savedFilters = [saved('today')];
        const receipts: LogPayload[] = [];
        setLogger((payload) => receipts.push(payload));
        try {
            const list = buildWidgetTaskList('filter:dates', {
                data: source, activeTasks: source.tasks, focusLists: {} as never,
                sortBy: 'title', prioritiesEnabled: true, tr: {}, now: new Date('2020-01-01T12:00:00-05:00'),
            });
            expect(list?.tasks.map(({ id }) => id)).toEqual(['pinned']);
            expect(receipts).toEqual([{
                level: 'info', message: 'Task date filter projected for widget', scope: 'widget-lists', category: 'unknown',
                context: { releaseCheck: 'v1.3.7/task-date-filter', count: 1, outcome: 'projected' },
            }]);
        } finally {
            setLogger(consoleLogger);
        }
    });

    it('publishes an overdue plus next seven days saved selection through both existing widget builders', () => {
        const source = data([
            task('overdue-date', { dueDate: '2020-01-01', contexts: ['@desk'] }),
            task('overdue-time', { dueDate: '2026-10-17T11:00:00-04:00', contexts: ['@desk'] }),
            task('today-later', { startTime: '2026-10-17T23:00:00-04:00', contexts: ['@desk'] }),
            task('last-day', { reviewAt: '2026-10-23T23:59:59.999-04:00', contexts: ['@desk'] }),
            task('new-day', { reviewAt: '2026-10-24', contexts: ['@desk'] }),
            task('old-start', { startTime: '2026-10-16', contexts: ['@desk'] }),
            task('old-review', { reviewAt: '2026-10-16', contexts: ['@desk'] }),
            task('other-context', { dueDate: '2026-10-16', contexts: ['@home'] }),
            task('done', { status: 'done', dueDate: '2026-10-16', contexts: ['@desk'] }),
            task('deleted', { dueDate: '2026-10-16', contexts: ['@desk'], deletedAt: '2026-10-16T00:00:00Z' }),
            task('inactive', { dueDate: '2026-10-16', contexts: ['@desk'], projectId: 'inactive' }),
        ]);
        source.settings.savedFilters = [{ ...saved('overdue_next_7_days'), criteria: {
            ...saved('overdue_next_7_days').criteria, contexts: ['@desk'],
        } }];
        source.projects = [{ id: 'inactive', title: 'Inactive', status: 'someday', color: '#000000', order: 0, tagIds: [], createdAt: '2026-01-01', updatedAt: '2026-01-01' }];
        const reloaded: AppData = JSON.parse(JSON.stringify(source));
        const android = buildAndroidWidgetPublication(reloaded, 'en', { listSelections: ['filter:dates'] });
        const ios = createWidgetPayloadProjection(reloaded, 'en', iosWidgetProjectionOptions({})).build(50);
        for (const payload of [android, ios]) {
            expect(payload.lists['filter:dates'].items.map(({ id }) => id).sort())
                .toEqual(['last-day', 'overdue-date', 'overdue-time', 'today-later']);
        }
        vi.setSystemTime(new Date('2026-10-18T04:00:00Z'));
        const refreshed = createWidgetPayloadProjection(reloaded, 'en', { includeSavedFilterLists: true }).build(50);
        expect(refreshed.lists['filter:dates'].items.map(({ id }) => id).sort())
            .toEqual(['last-day', 'new-day', 'overdue-date', 'overdue-time']);
        expect(reloaded.settings.savedFilters?.[0].criteria.anyDateRange).toEqual({ preset: 'overdue_next_7_days' });
    });

    it('publishes both widgets with existing exclusions and advances a reloaded preset on app refresh', () => {
        const source = data([
            task('today-start', { startTime: '2026-10-17' }),
            task('last-review', { reviewAt: '2026-10-23' }),
            task('next-due', { dueDate: '2026-10-24' }),
            task('deleted', { dueDate: '2026-10-17', deletedAt: '2026-10-16T00:00:00Z' }),
            ...(['done', 'reference', 'archived'] as const).map((status) => task(status, { status, dueDate: '2026-10-17' })),
            task('inactive', { projectId: 'inactive', dueDate: '2026-10-17' }),
        ]);
        source.projects = [{ id: 'inactive', title: 'Inactive', status: 'someday', color: '#000000', order: 0, tagIds: [], createdAt: '2026-01-01', updatedAt: '2026-01-01' }];
        // Android builds a saved filter's list for a placed widget that chose it; iOS carries every saved filter.
        const android = buildAndroidWidgetPublication(source, 'en', { listSelections: ['filter:dates'] });
        const ios = createWidgetPayloadProjection(source, 'en', iosWidgetProjectionOptions({})).build(50);
        for (const payload of [android, ios]) {
            expect(payload.lists['filter:dates'].items.map(({ id }) => id).sort()).toEqual(['last-review', 'today-start']);
        }
        vi.setSystemTime(new Date('2026-10-18T04:00:00Z'));
        const reloaded: AppData = JSON.parse(JSON.stringify(source));
        const refreshed = createWidgetPayloadProjection(reloaded, 'en', { includeSavedFilterLists: true }).build(50);
        expect(refreshed.lists['filter:dates'].items.map(({ id }) => id).sort()).toEqual(['last-review', 'next-due']);
        expect(reloaded.settings.savedFilters?.[0].criteria.anyDateRange).toEqual({ preset: 'next_7_days' });
    });
});
