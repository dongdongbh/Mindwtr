import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetFocusWidgetFilter, setFocusWidgetFilter } from './focus-widget-filter';
import { loadTranslations } from './i18n/i18n-loader';
import { getTaskDeferUntil, getTaskDeferUntilSource } from './task-utils';
import type { AppData, Project, Task } from './types';
import { resolveWidgetListDestination } from './widget-list-destination';
import {
    buildAndroidWidgetPublication, buildWidgetPayload, createWidgetPayloadProjection,
    IOS_WIDGET_FAMILY_CACHE_ITEMS, iosWidgetProjectionOptions,
} from './widget-payload';

const originalTz = process.env.TZ;
const task = (id: string, fields: Partial<Task> = {}): Task => ({
    id, title: id, status: 'next', tags: [], contexts: [],
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...fields,
});
const data = (tasks: Task[]): AppData => ({
    tasks, projects: [], sections: [], areas: [], settings: { dateFormat: 'ymd', timeFormat: '24h' },
});
const upcoming = (source: AppData) => buildWidgetPayload(source, 'en', { listIds: ['upcoming'], maxItems: 200 }).lists.upcoming;

beforeEach(async () => {
    process.env.TZ = 'UTC';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
    resetFocusWidgetFilter();
    await loadTranslations('en');
    await loadTranslations('de');
});
afterEach(() => {
    resetFocusWidgetFilter();
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
});

describe('Upcoming widget', () => {
    it('uses the seven-day Focus preview, with status, tombstone and schedule exclusions', () => {
        const source = data([
            task('last-day', { startTime: '2026-10-24T23:59:59Z' }),
            task('tomorrow', { startTime: '2026-10-18', isFocusedToday: true }),
            task('later-today', { startTime: '2026-10-17T22:00:00Z' }),
            task('past', { startTime: '2026-10-16' }),
            task('too-far', { startTime: '2026-10-25' }),
            task('due-only', { dueDate: '2026-10-18' }),
            task('review-only', { reviewAt: '2026-10-18' }),
            task('invalid', { startTime: 'invalid' }),
            task('deleted', { startTime: '2026-10-18', deletedAt: '2026-10-16T00:00:00Z' }),
            ...(['inbox', 'waiting', 'someday', 'done', 'reference', 'archived'] as const)
                .map((status) => task(status, { status, startTime: '2026-10-18' })),
        ]);
        const list = upcoming(source);
        expect(list.items.map((item) => item.id)).toEqual(['tomorrow', 'last-day']);
        expect(list.totalCount).toBe(2);
        expect(list.openUri).toBe('mindwtr:///widget-list/upcoming');
        expect(list.title).toBe('Upcoming');
        expect(buildWidgetPayload(source, 'en').lists).not.toHaveProperty('upcoming');
    });

    it('previews recurring returns from the earlier due/review date and lets a valid start override both', () => {
        const source = data([
            task('due', { recurrence: { rule: 'weekly' }, dueDate: '2026-10-19', reviewAt: '2026-10-21' }),
            task('review', { recurrence: { rule: 'weekly' }, dueDate: '2026-10-23', reviewAt: '2026-10-20T08:30:00+00:00' }),
            task('start', { recurrence: { rule: 'weekly' }, startTime: '2026-10-22', dueDate: '2026-10-18' }),
            task('bad-start', { recurrence: { rule: 'weekly' }, startTime: 'invalid', dueDate: '2026-10-23' }),
            task('already-returned', { recurrence: { rule: 'weekly' }, dueDate: '2026-10-17T22:00:00Z' }),
        ]);
        expect(upcoming(source).items.map(({ id, upcomingDate, upcomingLabel, dueLabel }) => ({ id, upcomingDate, upcomingLabel, dueLabel }))).toEqual([
            { id: 'due', upcomingDate: '2026-10-19', upcomingLabel: 'Returns', dueLabel: 'Returns 2026-10-19' },
            { id: 'review', upcomingDate: '2026-10-20T08:30:00.000Z', upcomingLabel: 'Returns', dueLabel: 'Returns 2026-10-20 08:30' },
            { id: 'start', upcomingDate: '2026-10-22', upcomingLabel: 'Starts', dueLabel: 'Starts 2026-10-22' },
            { id: 'bad-start', upcomingDate: '2026-10-23', upcomingLabel: 'Returns', dueLabel: 'Returns 2026-10-23' },
        ]);
        for (const item of source.tasks) {
            const raw = getTaskDeferUntilSource(item);
            if (raw) expect(new Date(raw).getTime()).toBe(getTaskDeferUntil(item)?.getTime());
        }
    });

    it('keeps preview rows separate from completable rows for the same task', () => {
        const source = data([task('shared', { startTime: '2026-10-18', dueDate: '2026-10-16' })]);
        const projection = createWidgetPayloadProjection(source, 'en', { listIds: ['upcoming', 'filter:all'] });
        source.settings.savedFilters = [{ id: 'all', name: 'All', view: 'next', criteria: {}, createdAt: '2026-10-01', updatedAt: '2026-10-01' }];
        const payload = buildWidgetPayload(source, 'en', { listIds: ['upcoming', 'filter:all'] });
        const preview = payload.lists.upcoming.items[0];
        expect(preview).not.toHaveProperty('completionToken');
        expect(preview).toMatchObject({ upcomingDate: '2026-10-18', dueLabel: 'Starts 2026-10-18', dueTone: 'normal', dueEmphasis: false, openUri: 'mindwtr://open?task=shared' });
        expect(payload.lists['filter:all'].items[0].completionToken).toBeTruthy();
        expect(payload.lists['filter:all'].items[0]).not.toHaveProperty('upcomingDate');
        expect(projection.build().items).toEqual([]);
    });

    it('applies area/custom filters and preserves sequential blockers outside the filter', () => {
        const source = data([
            task('visible', { startTime: '2026-10-20', areaId: 'work', contexts: ['@desk'] }),
            task('area-hidden', { startTime: '2026-10-18', areaId: 'home', contexts: ['@desk'] }),
            task('filter-hidden', { startTime: '2026-10-18', areaId: 'work', contexts: ['@home'] }),
            task('first', { projectId: 'seq', order: 0, contexts: ['@home'] }),
            task('blocked', { projectId: 'seq', order: 1, startTime: '2026-10-19', contexts: ['@desk'] }),
            task('inactive', { projectId: 'inactive', startTime: '2026-10-18', contexts: ['@desk'] }),
            task('deleted-parent', { projectId: 'deleted', startTime: '2026-10-18', contexts: ['@desk'] }),
        ]);
        source.areas = ['work', 'home'].map((id, order) => ({ id, name: id, order, createdAt: '2026-10-01', updatedAt: '2026-10-01' }));
        const project = (id: string, fields: Partial<Project> = {}): Project => ({ id, title: id, status: 'active', areaId: 'work', color: '#112233', order: 0, tagIds: [], createdAt: '2026-10-01', updatedAt: '2026-10-01', ...fields });
        source.projects = [project('seq', { isSequential: true }), project('inactive', { status: 'someday' }), project('deleted', { deletedAt: '2026-10-16' })];
        source.settings.filters = { areaIds: ['work'] };
        const payload = buildWidgetPayload(source, 'en', { listIds: ['upcoming'], focusFilter: { criteria: { contexts: ['@desk'] }, sortBy: 'title', sortOrder: 'desc' } });
        expect(payload.lists.upcoming.items.map((item) => item.id)).toEqual(['visible']);
    });

    it('preserves date-only and local/offset datetimes across local-day boundaries', () => {
        process.env.TZ = 'America/New_York';
        vi.setSystemTime(new Date('2026-11-01T16:00:00Z'));
        const source = data([
            task('date-only', { startTime: '2026-11-02' }),
            task('local', { startTime: '2026-11-02T08:30:00' }),
            task('offset-today', { startTime: '2026-11-02T01:00:00Z' }),
            task('offset-tomorrow', { startTime: '2026-11-02T05:00:00Z' }),
            task('last-day', { startTime: '2026-11-08T23:59:59-05:00' }),
            task('too-far', { startTime: '2026-11-09T00:00:00-05:00' }),
        ]);
        const list = upcoming(source);
        expect(list.items.map((item) => item.id)).toEqual(['date-only', 'offset-tomorrow', 'local', 'last-day']);
        expect(list.items[0]).toMatchObject({ upcomingDate: '2026-11-02', dueLabel: 'Starts 2026-11-02' });
        expect(list.items[2]).toMatchObject({ upcomingDate: '2026-11-02T08:30:00.000', dueLabel: 'Starts 2026-11-02 08:30' });
        vi.setSystemTime(new Date('2026-11-02T05:00:00Z'));
        expect(upcoming(source).items.map((item) => item.id)).toEqual(['last-day', 'too-far']);
    });

    it.each([
        ['2026-10-18T08:30:00+0000', '2026-10-18T08:30:00.000Z', 'Starts 2026-10-18 04:30'],
        ['2026-10-18T08:30:00.123456Z', '2026-10-18T08:30:00.123Z', 'Starts 2026-10-18 04:30'],
        ['2026-10-18T08:30Z', '2026-10-18T08:30:00.000Z', 'Starts 2026-10-18 04:30'],
        ['2026-10-18T08:30+0530', '2026-10-18T03:00:00.000Z', 'Starts 2026-10-17 23:00'],
        ['2026-10-18', '2026-10-18', 'Starts 2026-10-18'],
        ['2026-10-18T08:30', '2026-10-18T08:30:00.000', 'Starts 2026-10-18 08:30'],
        ['2026-10-18T08:30:00.123', '2026-10-18T08:30:00.123', 'Starts 2026-10-18 08:30'],
    ])('normalizes native metadata for imported %s without altering task data', (startTime, expectedDate, dueLabel) => {
        process.env.TZ = 'America/New_York';
        vi.setSystemTime(new Date('2026-10-16T16:00:00Z'));
        const source = data([task('imported', { startTime })]);
        const android = buildAndroidWidgetPublication(source, 'en', { listSelections: [] });
        const ios = createWidgetPayloadProjection(source, 'en', iosWidgetProjectionOptions({})).build(20);
        for (const payload of [android, ios]) {
            expect(payload.lists.upcoming.items[0]).toMatchObject({ upcomingDate: expectedDate, dueLabel });
            expect(payload.lists.upcoming.items[0]).not.toHaveProperty('completionToken');
        }
        expect(source.tasks[0].startTime).toBe(startTime);
        expect(getTaskDeferUntilSource(source.tasks[0])).toBe(startTime);
    });

    it('publishes Upcoming for both platform choosers and never falls back when it is empty', () => {
        const source = data([task('only-next')]);
        const android = buildAndroidWidgetPublication(source, 'en', { listSelections: [] });
        expect(android.lists.upcoming).toMatchObject({ title: 'Upcoming', items: [], totalCount: 0 });
        expect(android.lists.next.items).toHaveLength(1);
        const projection = createWidgetPayloadProjection(source, 'en', iosWidgetProjectionOptions({}));
        for (const cap of Object.values(IOS_WIDGET_FAMILY_CACHE_ITEMS)) {
            expect(projection.build(cap).lists.upcoming).toMatchObject({ items: [], totalCount: 0 });
        }
    });

    it('localizes the absolute label with the app settings even without Intl', () => {
        const source = data([task('timed', { startTime: '2026-10-18T21:30:00Z' })]);
        const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => { throw new Error('No Intl'); });
        const payload = buildWidgetPayload(source, 'de', { listIds: ['upcoming'], systemLocale: 'de-DE' });
        expect(payload.lists.upcoming.items[0]).toMatchObject({ upcomingLabel: 'Beginnt', dueLabel: 'Beginnt 2026-10-18 21:30' });
        spy.mockRestore();
    });

    it('opens the full live Upcoming list and applies the same Focus filter', () => {
        const source = data(Array.from({ length: 90 }, (_, i) => task(`task-${i}`, { startTime: '2026-10-18', contexts: ['@desk'] })));
        source.tasks.push(task('other', { startTime: '2026-10-18', contexts: ['@home'] }));
        setFocusWidgetFilter({ criteria: { contexts: ['@desk'] }, sortBy: 'default', sortOrder: 'asc' });
        expect(resolveWidgetListDestination(source, 'en', 'upcoming')?.tasks).toHaveLength(90);
        expect(resolveWidgetListDestination(source, 'en', 'upcoming/extra')).toBeNull();
        expect(resolveWidgetListDestination(source, 'en', 'upcoming?days=90')).toBeNull();
    });
});
