import { describe, expect, it } from 'vitest';
import type { AppData, Task } from './types';
import { createWidgetPayloadProjection, iosWidgetProjectionOptions } from './widget-payload';
import { parseWidgetListSelection } from './widget-lists';
const stamp = '2026-10-24T12:00:00.000Z';
const task = (id: string, patch: Partial<Task> = {}): Task => ({
    id, title: id, status: 'next', tags: [], contexts: [], createdAt: stamp, updatedAt: stamp, ...patch,
});
const source = (tasks: Task[]): AppData => ({ tasks, projects: [], areas: [], sections: [], settings: {} });
const variant = (axis: string, id: string) => `group:${axis}:${encodeURIComponent(id)}`;
const project = (data: AppData, listIds: string[], limit = 30) => createWidgetPayloadProjection(data, 'en', {
    listIds, now: new Date(stamp), includeTokenLists: true,
}).build(limit);

describe('widget presentation', () => {
    it('keeps mixed-list status visible independent of the displayed slice, without changing selection or order', () => {
        const data = source([task('next', { contexts: ['@desk'] }), task('waiting', { status: 'waiting', contexts: ['@desk'] }),
            task('someday', { status: 'someday', contexts: ['@desk'] })]);
        const full = project(data, ['context:@desk', 'waiting']);
        expect(full.lists['context:@desk'].items).toHaveLength(3);
        expect(full.lists['context:@desk'].items.every((item) => item.showStatus)).toBe(true);
        expect(project(data, ['context:@desk'], 1).lists['context:@desk'].items[0].showStatus).toBe(true);
        expect(full.lists.waiting.items[0].showStatus).toBeUndefined();
        expect(full.lists['context:@desk'].items.map((item) => item.id)).toEqual(
            createWidgetPayloadProjection(data, 'en', { listIds: ['context:@desk'], now: new Date(stamp) })
                .getTaskList('context:@desk')!.tasks.map((item) => item.id));
    });

    it('keeps independent widget variants, full group counts and unique total counts before limiting appearances', () => {
        const data = source([task('a', { contexts: ['@a', '@b'], priority: 'high' }),
            task('b', { contexts: ['@b'], priority: 'low' }), task('c', { contexts: ['@b'], priority: 'low' })]);
        const context = variant('context', 'next');
        const priority = variant('priority', 'next');
        const payload = project(data, ['next', context, priority], 2);
        expect(payload.lists.next.sections).toBeUndefined();
        expect(payload.lists[context].sections?.map((group) => [group.key, group.detail])).toEqual([
            ['context:@a', '1'], ['context:@b', '3'],
        ]);
        expect(payload.lists[context].totalCount).toBe(3);
        expect(payload.lists[context].items).toHaveLength(2);
        expect(payload.lists[context].items[0].id).toBe(payload.lists[context].items[1].id);
        expect(payload.lists[context].items[0].completionToken).toBe(payload.lists[context].items[1].completionToken);
        expect(payload.lists[priority].sections?.length).toBe(2);
        expect(payload.lists[context].openUri).toBe('mindwtr:///widget-list/next');
        expect(Object.keys(payload.lists).sort()).toEqual(['focus', 'next', context, priority].sort());
    });

    it('honors saved grouping on both platforms, allows explicit none and respects disabled priorities', () => {
        const data = source([task('a', { priority: 'high' }), task('b', { priority: 'low' })]);
        data.settings.savedFilters = [{ id: 'mix', name: 'Mixed', view: 'all', criteria: {}, groupBy: 'priority',
            createdAt: stamp, updatedAt: stamp }];
        const payload = project(data, ['filter:mix', variant('none', 'filter:mix')]);
        expect(payload.lists['filter:mix'].sections).toHaveLength(2);
        expect(payload.lists[variant('none', 'filter:mix')].sections).toBeUndefined();
        expect(payload.lists['filter:mix'].items.every((item) => item.showStatus)).toBe(true);
        const ios = createWidgetPayloadProjection(data, 'en', iosWidgetProjectionOptions({})).build(10);
        expect(ios.lists['filter:mix'].sections).toHaveLength(2);
        data.settings.features = { priorities: false };
        expect(project(data, ['filter:mix']).lists['filter:mix'].sections).toBeUndefined();
    });

    it('rejects malformed/nested variants and leaves the default Focus hierarchy intact', () => {
        for (const id of ['group:other:next', 'group:context:%', 'group:context:focus', 'group:context:group%3Aproject%3Anext']) {
            expect(parseWidgetListSelection(id)).toBeNull();
        }
        const unicode = `context:@${'家'.repeat(1000)}`;
        expect(parseWidgetListSelection(variant('project', unicode))?.listId).toBe(unicode);
        const data = source([task('a', { isFocused: true })]);
        const baseline = project(data, []);
        expect(project(data, [variant('project', 'focus')]).lists.focus).toEqual(baseline.lists.focus);
    });
});
