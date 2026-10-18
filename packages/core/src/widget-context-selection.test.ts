import { describe, expect, it } from 'vitest';
import { applyFilter } from './saved-filters';
import type { AppData, Project, Task } from './types';
import { buildAndroidWidgetPublication, createWidgetPayloadProjection, iosWidgetProjectionOptions } from './widget-payload';
import { normalizeWidgetListDestinationId, resolveWidgetListDestination } from './widget-list-destination';

const timestamp = '2026-10-18T12:00:00Z';
const task = (id: string, patch: Partial<Task> = {}): Task => ({
    id, title: id, status: 'next', contexts: [], tags: [], createdAt: timestamp, updatedAt: timestamp, ...patch,
});
const project = (id: string, patch: Partial<Project> = {}): Project => ({
    id, title: id, status: 'active', color: '#000000', order: 0, tagIds: [], createdAt: timestamp, updatedAt: timestamp, ...patch,
});
const data = (tasks: Task[]): AppData => ({ tasks, projects: [], areas: [], sections: [], settings: {} });
const publish = (source: AppData, listSelections: string[] = []) => buildAndroidWidgetPublication(source, 'en', { listSelections });
const ids = (items: { id: string }[]) => items.map((item) => item.id).sort();

describe('Android context/tag widget selection', () => {
    it('caches every offered context, tag and saved filter before any widget selects it', () => {
        const source = data([
            task('inbox', { status: 'inbox', contexts: ['@desk'] }),
            task('waiting', { status: 'waiting', contexts: ['desk'], tags: ['#urgent'] }),
            task('someday', { status: 'someday', contexts: ['@desk/deep'] }),
            task('other', { contexts: ['@home'] }),
        ]);
        source.settings.savedFilters = [{ id: 'unselected', name: 'Urgent', view: 'all', criteria: { tags: ['#urgent'] }, createdAt: timestamp, updatedAt: timestamp }];
        const payload = buildAndroidWidgetPublication(source, 'en', {
            listSelections: [], focusFilter: { criteria: { contexts: ['@home'] }, sortBy: 'default' },
        });
        expect(ids(payload.lists['context:@desk'].items)).toEqual(['inbox', 'someday', 'waiting']);
        expect(ids(payload.lists['tag:#urgent'].items)).toEqual(['waiting']);
        expect(ids(payload.lists['filter:unselected'].items)).toEqual(['waiting']);
        for (const option of [...payload.contexts!, ...payload.tags!]) expect(payload.lists[option.id]).toBeDefined();
        expect(payload.contexts!.filter((option) => option.id === 'context:@desk')).toHaveLength(1);
        expect(payload.lists['context:@desk'].items.every((row) => row.completionToken && row.openUri)).toBe(true);
        expect(publish(source, ['context:@desk', 'tag:#urgent']).lists).toEqual(payload.lists);
    });

    it('uses shared canonical hierarchical matching and URI encodes Unicode and reserved characters once', () => {
        const token = '@家/机 +?%#é';
        const source = data([
            task('unicode', { contexts: [token] }),
            task('child', { contexts: [`${token}/child`] }),
            task('bare', { contexts: ['desk'] }),
            task('double', { contexts: ['@@desk'] }),
            task('tag', { tags: ['#desk'] }),
            task('different-case', { contexts: ['@Desk'] }),
        ]);
        const payload = publish(source);
        for (const option of payload.contexts!) {
            const expected = applyFilter(source.tasks, { contexts: [option.name] }, { projects: [] });
            expect(ids(payload.lists[option.id].items)).toEqual(ids(expected));
            const uri = payload.lists[option.id].openUri!;
            expect(decodeURIComponent(uri.slice('mindwtr:///widget-list/'.length))).toBe(option.id);
        }
        expect(ids(payload.lists['context:@desk'].items)).toEqual(['bare', 'double']);
        expect(ids(payload.lists['tag:#desk'].items)).toEqual(['tag']);
        expect(normalizeWidgetListDestinationId('context: desk ')).toBe('context:@desk');
        expect(resolveWidgetListDestination(source, 'en', `context:${token}`)?.tasks.map((row) => row.id).sort()).toEqual(['child', 'unicode']);
        for (const invalid of ['context:', 'context:@@', 'tag: ', 'tag:a\u0000b', `context:${'x'.repeat(1024)}`]) {
            expect(normalizeWidgetListDestinationId(invalid)).toBeNull();
        }
    });

    it('retains empty historical labels but excludes hidden-area and inactive-project labels and rows', () => {
        const source = data([
            task('good', { contexts: ['@desk'], areaId: 'visible' }),
            task('done', { status: 'done', contexts: ['@desk', '@retained'], areaId: 'visible' }),
            task('archived', { status: 'archived', contexts: ['@desk'], areaId: 'visible' }),
            task('deleted', { deletedAt: timestamp, contexts: ['@deleted'], areaId: 'visible' }),
            task('hidden', { contexts: ['@hidden'], areaId: 'hidden' }),
            task('deleted-project', { contexts: ['@deleted-project'], projectId: 'deleted-project' }),
            task('archived-project', { contexts: ['@archived-project'], projectId: 'archived-project' }),
        ]);
        source.projects = [project('deleted-project', { deletedAt: timestamp }), project('archived-project', { status: 'archived' })];
        source.areas = ['visible', 'hidden'].map((id, order) => ({ id, name: id, order, createdAt: timestamp, updatedAt: timestamp }));
        source.settings.filters = { areaIds: ['visible'] };
        const payload = publish(source, ['context:@deleted', 'context:@hidden']);
        expect(payload.contexts?.map((option) => option.id).sort()).toEqual(['context:@desk', 'context:@retained']);
        expect(ids(payload.lists['context:@desk'].items)).toEqual(['good']);
        for (const id of ['context:@retained', 'context:@deleted', 'context:@hidden']) {
            expect(payload.lists[id]).toMatchObject({ title: id.slice('context:'.length), items: [], totalCount: 0 });
        }
        expect(resolveWidgetListDestination(data([]), 'en', 'context:@removed')).toEqual({ title: '@removed', tasks: [] });
    });

    it('does not expose Android chooser metadata in iOS publication', () => {
        const projection = createWidgetPayloadProjection(data([task('desk', { contexts: ['@desk'], tags: ['#tag'] })]), 'en', iosWidgetProjectionOptions({}));
        expect(projection.build()).not.toHaveProperty('contexts');
        expect(projection.build()).not.toHaveProperty('tags');
        expect(projection.build().lists).not.toHaveProperty('context:@desk');
        expect(projection.build().listTitles).not.toHaveProperty('contexts');
    });

    it('offers more than fifty tokens and bounds each cached list to the existing Android row cap', () => {
        const source = data(Array.from({ length: 250 }, (_, index) => task(String(index), { contexts: ['@common', `@context-${index}`] })));
        const payload = publish(source);
        expect(payload.contexts).toHaveLength(251);
        expect(payload.lists['context:@common'].items).toHaveLength(200);
        expect(payload.lists['context:@common'].totalCount).toBe(250);
        expect(payload.lists['context:@context-249'].items).toHaveLength(1);
    });
});
