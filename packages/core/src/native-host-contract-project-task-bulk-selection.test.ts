import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativeHostContract, type NativeHostResult, type NativeProjectDetailFilterView } from './native-host-contract';
import { EMPTY_BULK_ORGANIZE_DRAFT } from './task-list-bulk-actions';
import { taskRevisionOf } from './native-request-receipts';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { Project, Task } from './types';

const stamp = '2026-10-01T12:00:00.000Z';
const project: Project = { id: 'p', title: 'Project', status: 'active', color: '#123456', order: 0,
    tagIds: ['#shared'], taskSortBy: 'title', createdAt: stamp, updatedAt: stamp, rev: 1 };
const task = (id: string, extra: Partial<Task> = {}): Task => ({ id, title: id, projectId: 'p',
    status: 'next', tags: ['#keep'], contexts: [], createdAt: stamp, updatedAt: stamp, rev: 1, ...extra });
const params = { projectId: 'p', showCompleted: true, completedCollapsed: false, filters: {} };
const requestId = '11111111-1111-4111-8111-111111111111';
const saveData = vi.fn().mockResolvedValue(undefined);
const value = <T>(result: NativeHostResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const ids = (view: NativeProjectDetailFilterView) => view.items.flatMap(item => item.type === 'task' ? [item.row.id] : []);

async function open() {
    const host = createNativeHostContract();
    value(await host.activate({ writeSafetyReady: true }));
    useTaskStore.setState({ _allProjects: [project,
        { ...project, id: 'other', title: 'Other', tagIds: [] },
        { ...project, id: 'archived-parent', status: 'archived' },
        { ...project, id: 'deleted-parent', deletedAt: stamp }],
    _allTasks: [task('a-inbox', { status: 'inbox' }), task('b-next'), task('c-waiting', { status: 'waiting' }),
        task('d-someday', { status: 'someday' }), task('e-done', { status: 'done', completedAt: stamp }),
        task('f-archived', { status: 'archived', completedAt: stamp, archivedAt: stamp }),
        task('g-reference', { status: 'reference' }),
        task('h-foreign', { projectId: 'other', status: 'reference', tags: ['#shared', '#foreign'] }),
        task('i-readonly', { projectId: 'archived-parent', status: 'reference', tags: ['#shared'] }),
        task('j-deleted-parent', { projectId: 'deleted-parent', status: 'reference', tags: ['#shared'] }),
        task('k-hidden', { tags: ['#other'] }), task('l-deleted', { deletedAt: stamp }),
        task('m-purged', { purgedAt: stamp }), task('unrelated', { projectId: 'other' })] });
    saveData.mockClear();
    return host;
}

describe('native project task bulk selection (read only)', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-11-02T12:00:00.000Z'));
        setStorageAdapter({ getData: vi.fn().mockResolvedValue({ tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} }), saveData });
        useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
            settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0 });
    });
    afterEach(async () => { await flushPendingSave(); resetForTests(); vi.restoreAllMocks(); vi.useRealTimers(); });

    it('uses canonical project membership and all six bar statuses without writing', async () => {
        const host = await open();
        const before = JSON.stringify(useTaskStore.getState());
        const detail = value(host.getProjectDetailFilterView({ ...params, offset: 0, limit: 100 }));
        const all = ids(detail);
        expect(all).toContain('h-foreign');
        const bulk = value(host.getBulkActions({ list: 'project', params, taskIds: all }));
        expect(bulk.revision).toBe(detail.revision);
        expect(bulk.selectedIds).toEqual(all.filter(id => !['i-readonly', 'j-deleted-parent', 'm-purged'].includes(id)));
        expect(bulk.selectedIds).toContain('f-archived');
        expect(bulk.selectedIds).toContain('h-foreign');
        expect(bulk.selectedIds).not.toContain('unrelated');
        expect(bulk.selectedCount).toBe(bulk.selectedIds.length);
        expect(bulk.taskRevisions).toEqual(Object.fromEntries(bulk.selectedIds.map(id => [id,
            taskRevisionOf(useTaskStore.getState()._tasksById.get(id)!)])));
        expect(bulk.bar.statuses.map(option => option.status)).toEqual(['inbox', 'next', 'waiting', 'someday', 'done', 'reference']);
        expect(bulk.bar.organize).toMatchObject({ enabled: true });
        expect(bulk.bar.moveToSection).toBeNull();
        expect(bulk.bar.removeTag).toMatchObject({ enabled: true });
        expect(bulk.selectAll).toBeNull();
        expect(JSON.stringify(useTaskStore.getState())).toBe(before);
        expect(saveData).not.toHaveBeenCalled();
    });

    it('uses one-shot shared Range and prunes filters and collapsed completed rows', async () => {
        const host = await open();
        const first = value(host.getBulkActions({ list: 'project', params, selectionEdit: { taskId: 'a-inbox' } }));
        const ranged = value(host.getBulkActions({ list: 'project', params, taskIds: first.selectedIds, anchorId: first.anchorId,
            selectionEdit: { taskId: 'd-someday', range: true } }));
        expect(ranged.selectedIds).toEqual(['a-inbox', 'b-next', 'c-waiting', 'd-someday']);
        expect(ranged.anchorId).toBe('d-someday');
        expect(ranged.bar.range.active).toBe(false);
        const filtered = value(host.getBulkActions({ list: 'project', params: { ...params, filters: { searchQuery: 'b-next' } },
            taskIds: ranged.selectedIds }));
        expect(filtered.selectedIds).toEqual(['b-next']);
        const collapsed = value(host.getBulkActions({ list: 'project', params: { ...params, completedCollapsed: true },
            taskIds: ['b-next', 'e-done', 'f-archived', 'h-foreign'] }));
        expect(collapsed.selectedIds).toEqual(['b-next', 'h-foreign']);
        const hiddenCompleted = value(host.getBulkActions({ list: 'project', params: { ...params, showCompleted: false },
            taskIds: ['b-next', 'e-done', 'f-archived'] }));
        expect(hiddenCompleted.selectedIds).toEqual(['b-next']);
        expect(saveData).not.toHaveBeenCalled();
    });

    it('refuses hidden taps, skips read-only owning projects, and refuses archived workspaces', async () => {
        const host = await open();
        expect(host.getBulkActions({ list: 'project', params, selectionEdit: { taskId: 'unrelated' } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        for (const taskId of ['i-readonly', 'j-deleted-parent', 'm-purged']) {
            expect(value(host.getBulkActions({ list: 'project', params, selectionEdit: { taskId } })))
                .toMatchObject({ selectedIds: [], selectedCount: 0, anchorId: null });
        }
        expect(host.getBulkActions({ list: 'project', params: { ...params, projectId: 'archived-parent' }, taskIds: ['i-readonly'] }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(host.getBulkActions({ list: 'project', params: { ...params, projectId: 'missing' } }))
            .toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
    });

    it('shares Organize, destination and selected-tag picker builders and stable offer revisions', async () => {
        const host = await open();
        const selected: Parameters<typeof host.getBulkActions>[0] = { list: 'project', params, taskIds: ['b-next', 'h-foreign'] };
        const organize = value(host.getBulkActions({ ...selected, organize: { draft: EMPTY_BULK_ORGANIZE_DRAFT } }));
        expect(organize.organize).toMatchObject({ draft: EMPTY_BULK_ORGANIZE_DRAFT, canApply: true });
        const offered = value(host.getBulkActions({ ...selected, organize: { draft: EMPTY_BULK_ORGANIZE_DRAFT },
            picker: { kind: 'project', query: 'New destination', limit: 1 } }));
        expect(offered.picker?.create).toMatchObject({ name: 'New destination' });
        vi.setSystemTime(new Date('2026-11-02T12:01:00.000Z'));
        const next = value(host.getBulkActions({ ...selected, organize: { draft: EMPTY_BULK_ORGANIZE_DRAFT },
            picker: { kind: 'project', query: 'New destination', offset: 1, limit: 1, revision: offered.revision } }));
        expect(next.revision).toBe(offered.revision);
        const tags = value(host.getBulkActions({ ...selected, picker: { kind: 'removeTag' } }));
        expect(tags.picker?.items.map(item => item.value)).toEqual(expect.arrayContaining(['#keep', '#shared', '#foreign']));
        useTaskStore.setState({ _allTasks: useTaskStore.getState()._allTasks.map(row => row.id === 'h-foreign' ? { ...row, tags: ['#shared', '#changed'], rev: 2 } : row) });
        expect(host.getBulkActions({ ...selected, picker: { kind: 'removeTag', offset: 1, limit: 1, revision: tags.revision } }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(saveData).not.toHaveBeenCalled();
    });

    it('requires exact project view params and rejects Select all', async () => {
        const host = await open();
        for (const invalid of [{}, { ...params, filterSheetOpen: true }, { ...params, extra: true },
            { ...params, offset: 0 }, { ...params, filters: { projects: ['other'] } }, { ...params, filters: { timeEstimates: ['5m'] } }]) {
            expect(host.getBulkActions({ list: 'project', params: invalid }))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        const normal = value(host.getBulkActions({ list: 'project', params }));
        expect(value(host.getBulkActions({ list: 'project', params: { ...params, filterSheetOpen: false } }))).toEqual(normal);
        expect(host.getBulkActions({ list: 'project', params, selectAll: {} }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('preserves old bulk/detail keys and refuses every legacy project write/create', async () => {
        const host = await open();
        const old = value(host.getBulkActions({ list: 'inbox' }));
        expect(Object.keys(old).sort()).toEqual(['version', 'revision', 'list', 'selectedIds', 'taskRevisions', 'selectedCount', 'anchorId',
            'selectAll', 'selectableCount', 'bar', 'labels', 'addTag', 'removeTag', 'deleteConfirmation', 'moveToSection', 'organize', 'picker'].sort());
        const detail = value(host.getProjectDetailFilterView({ ...params, offset: 0, limit: 100 }));
        expect(Object.keys(detail).sort()).toEqual(['version', 'revision', 'mutationRevision', 'projectId', 'projectRevision', 'readOnly',
            'metadata', 'total', 'items', 'controls', 'filters', 'chips', 'filterButtonLabel', 'empty'].sort());
        const before = JSON.stringify(useTaskStore.getState());
        const target = { taskIds: ['b-next'], taskRevisions: { 'b-next': taskRevisionOf(useTaskStore.getState()._tasksById.get('b-next')!) } };
        for (const action of [{ ...target, type: 'moveTasks', status: 'done' }, { ...target, type: 'trashTasks' },
            { ...target, type: 'restoreTasks' }, { ...target, type: 'editTaskTokens', field: 'tags', mode: 'add', values: ['#new'] },
            { ...target, type: 'organize', draft: EMPTY_BULK_ORGANIZE_DRAFT }]) {
            // @ts-expect-error Project has only a read contract; legacy writes remain typed out.
            expect(await host.runBulkAction({ requestId, list: 'project', action })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        // @ts-expect-error Project destination creation requires a later prepared facade.
        expect(await host.createBulkOrganizeDestination({ requestId, list: 'project', kind: 'project', name: 'New destination' }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(JSON.stringify(useTaskStore.getState())).toBe(before);
        expect(saveData).not.toHaveBeenCalled();
    });
});
