import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadTranslations } from './i18n/i18n-loader';
import type { AppData, Project, Task } from './types';
import { WIDGET_FIXED_LIST_IDS, WIDGET_FOCUS_AVAILABLE_LIST_ID } from './widget-lists';
import { buildAndroidWidgetPublication, buildWidgetPayload, iosWidgetProjectionOptions, createWidgetPayloadProjection } from './widget-payload';

// #1468: an opt-in Focus widget variant that adds Next Actions whose start date has arrived.
const originalTz = process.env.TZ;
const task = (id: string, fields: Partial<Task> = {}): Task => ({
    id, title: id, status: 'next', tags: [], contexts: [],
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...fields,
});
const project = (id: string, fields: Partial<Project> = {}): Project => ({
    id, title: id, status: 'active', color: '#123456', order: 0, tagIds: [],
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...fields,
});
const data = (tasks: Task[], projects: Project[] = []): AppData => ({
    tasks, projects, sections: [], areas: [], settings: { dateFormat: 'ymd', timeFormat: '24h' },
});
const sectionIds = (list: { sections?: { key: string; items: { id: string }[] }[] } | undefined) =>
    Object.fromEntries((list?.sections ?? []).map((section) => [section.key, section.items.map((item) => item.id)]));

beforeEach(async () => {
    process.env.TZ = 'UTC';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-17T10:00:00Z'));
    await loadTranslations('en');
});
afterEach(() => {
    vi.useRealTimers();
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
});

const store = data([
    task('starred', { isFocusedToday: true, startTime: '2026-10-10' }),
    task('due-today', { dueDate: '2026-10-17' }),
    task('started-yesterday', { startTime: '2026-10-16' }),
    task('started-this-morning', { startTime: '2026-10-17T08:00:00Z' }),
    task('starts-this-evening', { startTime: '2026-10-17T17:00:00Z' }),
    task('undated'),
    task('review-due', { startTime: '2026-10-15', reviewAt: '2026-10-16' }),
    task('waiting-started', { status: 'waiting', startTime: '2026-10-15' }),
    task('seq-first', { projectId: 'seq', order: 0, startTime: '2026-10-14' }),
    task('seq-second', { projectId: 'seq', order: 1, startTime: '2026-10-14' }),
], [project('seq', { isSequential: true })]);

describe('Focus widget: available actions (#1468)', () => {
    it('adds started Next Actions after Today, and only those', () => {
        const payload = buildWidgetPayload(store, 'en', { listIds: [WIDGET_FOCUS_AVAILABLE_LIST_ID], maxItems: 50 });
        const list = payload.lists[WIDGET_FOCUS_AVAILABLE_LIST_ID];
        // Any start today is in Today (day granularity) with the default focusIncludeStartDates; never repeated.
        expect(sectionIds(list)).toEqual({
            focus: ['starred'],
            schedule: ['started-this-morning', 'starts-this-evening', 'due-today'],
            available: ['seq-first', 'started-yesterday'],
        });
        expect(list.sections?.map((section) => section.title)).toEqual(["Today's Focus", 'Today', 'Available actions']);
        expect(list.totalCount).toBe(6);
        expect(list.items.map((item) => item.id))
            .toEqual(['starred', 'started-this-morning', 'starts-this-evening', 'due-today', 'seq-first', 'started-yesterday']);
        expect(list.openUri).toBe('mindwtr:///focus');
        expect(list.dateLabel).toBe(payload.lists.focus.dateLabel);
        expect(list.title).toBe(payload.lists.focus.title);
    });

    it('keeps a 17:00 start out until 17:00', () => {
        vi.setSystemTime(new Date('2026-10-17T17:00:00Z'));
        const source = data([task('timed', { startTime: '2026-10-17T17:00:00Z' })], []);
        const off = { ...source, settings: { ...source.settings, gtd: { focusIncludeStartDates: false } } };
        expect(sectionIds(buildWidgetPayload(off, 'en', { listIds: [WIDGET_FOCUS_AVAILABLE_LIST_ID] }).lists[WIDGET_FOCUS_AVAILABLE_LIST_ID]))
            .toEqual({ available: ['timed'] });
        vi.setSystemTime(new Date('2026-10-17T16:59:00Z'));
        expect(sectionIds(buildWidgetPayload(off, 'en', { listIds: [WIDGET_FOCUS_AVAILABLE_LIST_ID] }).lists[WIDGET_FOCUS_AVAILABLE_LIST_ID]))
            .toEqual({});
    });

    it('is off by default: no variant, and the Focus list is the same either way', () => {
        const plain = buildWidgetPayload(store, 'en', { listIds: WIDGET_FIXED_LIST_IDS, maxItems: 50 });
        expect(plain.lists).not.toHaveProperty(WIDGET_FOCUS_AVAILABLE_LIST_ID);
        const withVariant = buildWidgetPayload(store, 'en', { listIds: [...WIDGET_FIXED_LIST_IDS, WIDGET_FOCUS_AVAILABLE_LIST_ID], maxItems: 50 });
        delete withVariant.lists[WIDGET_FOCUS_AVAILABLE_LIST_ID];
        expect(withVariant).toEqual(plain);
        expect(sectionIds(plain.lists.focus)).not.toHaveProperty('available');
    });

    it('gives two Android widgets showing Focus their own variant', () => {
        const publication = buildAndroidWidgetPublication(store, 'en', { listSelections: ['focus', WIDGET_FOCUS_AVAILABLE_LIST_ID] });
        expect(sectionIds(publication.lists.focus))
            .toEqual({ focus: ['starred'], schedule: ['started-this-morning', 'starts-this-evening', 'due-today'] });
        expect(sectionIds(publication.lists[WIDGET_FOCUS_AVAILABLE_LIST_ID]).available).toEqual(['seq-first', 'started-yesterday']);
        expect(publication.listTitles.focusAvailable).toBe('Add Next Actions whose start date has arrived');
        expect(buildAndroidWidgetPublication(store, 'en', { listSelections: ['focus'] }).lists)
            .not.toHaveProperty(WIDGET_FOCUS_AVAILABLE_LIST_ID);
    });

    it('always publishes the variant for iOS, inside the family budget', () => {
        const payload = createWidgetPayloadProjection(store, 'en', iosWidgetProjectionOptions({})).build(5);
        const list = payload.lists[WIDGET_FOCUS_AVAILABLE_LIST_ID];
        expect(sectionIds(list)).toEqual({
            focus: ['starred'],
            schedule: ['started-this-morning', 'starts-this-evening', 'due-today'],
            available: ['seq-first'],
        });
        expect(list.items).toHaveLength(5);
        expect(list.totalCount).toBe(6);
    });
});
