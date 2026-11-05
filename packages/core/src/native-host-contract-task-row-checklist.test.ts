import { describe, expect, it } from 'vitest';
import { createNativeHostContract, type NativeHostResult } from './native-host-contract';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Project, Task } from './types';
import { generateUUID } from './uuid';

const value = <T,>(result: NativeHostResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const NOW = new Date().toISOString();
const item = (id: string, title: string, isCompleted = false) => ({ id, title, isCompleted });
const task = (id: string, fields: Partial<Task> = {}): Task => ({
    id, title: `Title ${id}`, status: 'next', tags: [], contexts: [], createdAt: NOW, updatedAt: NOW, rev: 1, revBy: 'device-a',
    checklist: [item('a', 'Bread'), item('b', 'Milk')], ...fields,
} as Task);
const project = (id: string, fields: Partial<Project> = {}): Project => ({
    id, title: `Project ${id}`, status: 'active', color: '#94a3b8', order: 0, tagIds: [], createdAt: NOW, updatedAt: NOW, rev: 1, revBy: 'device-a', ...fields,
} as Project);

async function openHost(data: Partial<AppData>) {
    await flushPendingSave();
    resetForTests();
    let saved = { tasks: [], projects: [], sections: [], areas: [], people: [], settings: { deviceId: 'device-a' }, ...data };
    let writes = 0;
    setStorageAdapter({
        getData: async () => JSON.parse(JSON.stringify(saved)),
        saveData: async (next) => { writes += 1; saved = JSON.parse(JSON.stringify(next)); },
    });
    useTaskStore.setState({ error: null, persistenceFailure: null, isLoading: false, editLockCount: 0,
        tasks: [], _allTasks: [], projects: [], _allProjects: [] } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    const host = createNativeHostContract();
    value(await host.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' }));
    value(await host.activate({ writeSafetyReady: true }));
    return { host, writes: () => writes };
}
const stored = (id: string) => useTaskStore.getState()._tasksById.get(id)!;
const edit = (taskId: string, completed: Record<string, boolean>, added: Array<{ id: string; title: string }> = []) => ({ requestId: generateUUID(), taskId, completed, added });

describe('native host contract: a row\'s inline checklist (RN useSwipeableChecklist, #1416)', () => {
    it('reads the row\'s items, its labels, and whether the row may change', async () => {
        const { host } = await openHost({ tasks: [task('t1'), task('t2', { projectId: 'p1' })], projects: [project('p1', { status: 'archived' })] });
        expect(value(host.getTaskRowChecklist({ taskId: 't1' })).checklist).toMatchObject({
            taskId: 't1', readOnly: false, progressLabel: 'Checklist progress', addLabel: 'Add Item',
            markdownLabels: { deletedTask: 'deleted task', deletedProject: 'deleted project' },
            items: [{ id: 'a', title: 'Bread', completed: false }, { id: 'b', title: 'Milk', completed: false }],
        });
        expect(value(host.getTaskRowChecklist({ taskId: 't1' })).checklist.items[0].inline).toEqual([{ type: 'text', text: 'Bread' }]);
        expect(value(host.getTaskRowChecklist({ taskId: 't2' })).checklist.readOnly).toBe(true);
        const missing = host.getTaskRowChecklist({ taskId: 'nope' });
        expect(missing.ok ? '' : missing.error.code).toBe('TASK_NOT_FOUND');
    });

    it('a tick writes the item by id on the latest task in one store write', async () => {
        const { host } = await openHost({ tasks: [task('t1')] });
        await useTaskStore.getState().updateTask('t1', { checklist: [item('b', 'Milk'), item('a', 'Bread')] });
        await flushPendingSave();
        const before = stored('t1').rev ?? 0;
        expect(value(await host.editTaskRowChecklist(edit('t1', { a: true })))).toEqual({ id: 't1', status: 'next' });
        expect(stored('t1').checklist).toEqual([item('b', 'Milk'), item('a', 'Bread', true)]);
        expect(stored('t1').rev).toBe(before + 1);
    });

    it('ticks merged before a write land together, and a new item is appended', async () => {
        const { host } = await openHost({ tasks: [task('t1')] });
        const before = stored('t1').rev ?? 0;
        value(await host.editTaskRowChecklist(edit('t1', { a: true, b: true }, [{ id: 'c', title: '  Eggs  ' }])));
        expect(stored('t1').checklist).toEqual([item('a', 'Bread', true), item('b', 'Milk', true), item('c', 'Eggs')]);
        expect(stored('t1').rev).toBe(before + 1);
    });

    it('a list task completes when its last item is ticked, as RN\'s getChecklistEditStatus says', async () => {
        const { host } = await openHost({ tasks: [task('t1', { taskMode: 'list' })] });
        expect(value(await host.editTaskRowChecklist(edit('t1', { a: true, b: true })))).toEqual({ id: 't1', status: 'done' });
        expect(stored('t1').completedAt).toBeTruthy();
    });

    it('a Reference item\'s list ticks, while the reference never completes or enters Focus (bc518c30e)', async () => {
        const { host } = await openHost({ tasks: [task('r1', { status: 'reference', taskMode: 'list' })] });
        expect(value(await host.editTaskRowChecklist(edit('r1', { a: true, b: true })))).toEqual({ id: 'r1', status: 'reference' });
        expect(stored('r1')).toMatchObject({ status: 'reference', checklist: [item('a', 'Bread', true), item('b', 'Milk', true)] });
        expect(stored('r1').completedAt).toBeUndefined();
        expect(stored('r1').isFocusedToday).toBeFalsy();
    });

    it('refuses a row whose project is archived, a deleted task and bad input, and writes nothing', async () => {
        const { host, writes } = await openHost({ tasks: [task('t2', { projectId: 'p1' }), task('gone', { deletedAt: NOW })], projects: [project('p1', { status: 'archived' })] });
        const start = writes();
        const archived = await host.editTaskRowChecklist(edit('t2', { a: true }));
        expect(archived.ok ? '' : archived.error.code).toBe('ACTION_FAILED');
        const gone = await host.editTaskRowChecklist(edit('gone', { a: true }));
        expect(gone.ok ? '' : gone.error.code).toBe('TASK_NOT_FOUND');
        for (const bad of [{ ...edit('t2', {}), completed: { a: 'yes' } }, { ...edit('t2', {}), added: [{ id: 'c', title: '   ' }] }, { ...edit('t2', {}), requestId: 'x' }]) {
            const refused = await host.editTaskRowChecklist(bad as never);
            expect(refused.ok ? '' : refused.error.code).toBe('INVALID_INPUT');
        }
        expect(stored('t2').checklist).toEqual([item('a', 'Bread'), item('b', 'Milk')]);
        expect(writes()).toBe(start);
    });

    it('a retried request with the same id writes once', async () => {
        const { host } = await openHost({ tasks: [task('t1')] });
        const request = edit('t1', { a: true });
        const before = stored('t1').rev ?? 0;
        value(await host.editTaskRowChecklist(request));
        value(await host.editTaskRowChecklist(request));
        expect(stored('t1').rev).toBe(before + 1);
    });
});
