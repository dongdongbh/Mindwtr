import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildWidgetPayload } from './widget-payload';
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
            .toEqual(['today', 'due', 'available', 'review', 'upcoming']);
        expect(payload.lists['filter:without-person'].totalCount).toBe(5);
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
