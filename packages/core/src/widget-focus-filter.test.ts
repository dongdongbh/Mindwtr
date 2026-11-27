import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAndroidWidgetPublication, buildWidgetPayload, createWidgetPayloadProjection, iosWidgetProjectionOptions } from './widget-payload';
import { loadTranslations } from './i18n/i18n-loader';
import type { AppData, Task } from './types';

const stamp = '2026-11-13T12:00:00.000Z';
const task = (id: string, fields: Partial<Task> = {}): Task => ({
    id, title: id, status: 'next', contexts: [], tags: [], createdAt: stamp, updatedAt: stamp, ...fields,
});

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(stamp));
    await loadTranslations('en');
});
afterEach(() => vi.useRealTimers());

describe('saved Focus widget scope', () => {
    const data = (): AppData => ({
        tasks: [
            task('today', { isFocusedToday: true }),
            task('due', { dueDate: '2026-11-13' }),
            task('available'),
            task('review', { status: 'waiting', reviewAt: '2026-11-12' }),
            task('upcoming', { startTime: '2026-11-14' }),
            task('inbox', { status: 'inbox' }),
            task('someday', { status: 'someday' }),
            task('waiting', { status: 'waiting' }),
            task('reference', { status: 'reference' }),
            task('done', { status: 'done' }),
            task('deleted', { deletedAt: stamp }),
            task('person', { contexts: ['@person/Emma'] }),
            task('first', { projectId: 'sequential', order: 0, contexts: ['@person/Emma'] }),
            task('blocked', { projectId: 'sequential', order: 1 }),
        ],
        projects: [{ id: 'sequential', title: 'Sequential', status: 'active', color: '#000000', isSequential: true,
            order: 0, tagIds: [], createdAt: stamp, updatedAt: stamp }],
        settings: { savedFilters: [{ id: 'without-person', name: '-@person', view: 'focus',
            criteria: { excludedContexts: ['@person'] }, createdAt: stamp, updatedAt: stamp }] },
    });

    it('keeps the app Focus sections without leaking unrelated statuses or unblocking a hidden predecessor', () => {
        const payload = buildWidgetPayload(data(), 'en', { maxItems: 50, listIds: ['filter:without-person'],
            focusFilter: { criteria: { contexts: ['@person'] }, sortBy: 'default' } });
        expect(payload.lists['filter:without-person'].items.map(({ id }) => id))
            .toEqual(['today', 'due', 'review', 'available', 'upcoming']);
        expect(payload.lists['filter:without-person'].sections?.map(({ title }) => title))
            .toEqual(["Today's Focus", 'Today', 'Review Due', 'Next Actions', 'Upcoming']);
        expect(payload.lists['filter:without-person'].totalCount).toBe(5);
    });

    it('groups only Next Actions and keeps the widget task budget across sections', () => {
        const source = data();
        source.settings.savedFilters![0].groupBy = 'context';
        for (const task of source.tasks) {
            if (!task.contexts?.length) task.contexts = ['@desk'];
        }
        source.tasks.push(task('shared', { contexts: ['@desk', '@home'] }));

        const selection = 'filter:without-person';
        const list = buildAndroidWidgetPublication(source, 'en', { listSelections: [selection] }).lists[selection];
        expect(list.sections?.map(({ title, detail, items }) => [title, detail, items.map(({ id }) => id)])).toEqual([
            ["Today's Focus", null, ['today']],
            ['Today', null, ['due']],
            ['Review Due', null, ['review']],
            ['Next Actions · @desk', '2', ['available', 'shared']],
            ['Next Actions · @home', '1', ['shared']],
            ['Upcoming', null, ['upcoming']],
        ]);
        expect(list.totalCount).toBe(6);
        const ios = createWidgetPayloadProjection(source, 'en', iosWidgetProjectionOptions({})).build(13);
        expect(ios.lists[selection]).toEqual(list);

        const limited = buildWidgetPayload(source, 'en', { maxItems: 4, listIds: [selection] }).lists[selection];
        expect(limited.items.map(({ id }) => id)).toEqual(['today', 'due', 'review', 'available']);
        expect(limited.sections?.at(-1)?.detail).toBe('2');
        expect(limited.totalCount).toBe(6);

        const ungrouped = 'group:none:filter%3Awithout-person';
        const override = buildWidgetPayload(source, 'en', { maxItems: 50, listIds: [ungrouped] }).lists[ungrouped];
        expect(override.sections?.map(({ title }) => title))
            .toEqual(["Today's Focus", 'Today', 'Review Due', 'Next Actions', 'Upcoming']);
    });

    it('retains explicit mixed-status Context filters', () => {
        const source = data();
        source.settings.savedFilters![0].view = 'contexts';
        source.settings.savedFilters![0].criteria.statuses = ['inbox', 'someday', 'reference'];
        const payload = buildWidgetPayload(source, 'en', { maxItems: 50, listIds: ['filter:without-person'] });
        expect(payload.lists['filter:without-person'].items.map(({ id }) => id).sort())
            .toEqual(['inbox', 'reference', 'someday']);
        expect(payload.lists['filter:without-person'].items.find(({ id }) => id === 'reference')?.canComplete).toBe(false);
    });

    it('labels the existing compact built-in list Today without expanding it', () => {
        const payload = buildWidgetPayload(data(), 'en', { maxItems: 50 });
        expect(payload.lists.focus.title).toBe('Today');
        expect(payload.listTitles.focus).toBe('Today');
        expect(payload.lists.focus.items.map(({ id }) => id)).toEqual(['today', 'due']);
        expect(payload.lists.focus.openUri).toBe('mindwtr:///focus');
    });
});
