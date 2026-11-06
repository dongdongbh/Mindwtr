import { describe, expect, it } from 'vitest';
import { createNativeHostContract, type NativeHostResult } from './native-host-contract';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { checklistItemIdForMovedTask } from './task-checklist-move';
import type { AppData, Task } from './types';
import { generateUUID } from './uuid';

const value = <T,>(result: NativeHostResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const NOW = '2026-10-01T12:00:00.000Z';
const task = (id: string, fields: Partial<Task> = {}): Task => ({
    id, title: id, status: 'inbox', tags: [], contexts: [], createdAt: NOW, updatedAt: NOW, rev: 1, revBy: 'device-a', ...fields,
} as Task);

async function openHost(tasks: Task[]) {
    await flushPendingSave();
    resetForTests();
    let saved: AppData = { tasks, projects: [], sections: [], areas: [], people: [], settings: { deviceId: 'device-a' } };
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
    await flushPendingSave();
    writes = 0;
    return { host, writes: () => writes };
}
const stored = (id: string) => useTaskStore.getState()._tasksById.get(id)!;
const move = (sourceId: string, targetId: string) => ({ requestId: generateUUID(), sourceId, targetId });

describe('native host contract: an Inbox title into another task\'s checklist (RN 78dafc4a2, #1467)', () => {
    it('offers Add to checklist only for a title-only Inbox task, as RN\'s status menu does', async () => {
        const { host } = await openHost([task('plain'), task('noted', { description: 'x' }), task('dated', { dueDate: '2026-10-02' }), task('next', { status: 'next' })]);
        const eligible = (sourceId: string) => value(host.getChecklistMoveTargets({ sourceId, query: '' })).eligible;
        expect(eligible('plain')).toBe(true);
        expect(eligible('noted')).toBe(false);
        expect(eligible('dated')).toBe(false);
        expect(eligible('next')).toBe(false);
    });

    it('lists open tasks other than the source, ones with a checklist first, with their progress, filtered by the search', async () => {
        const { host } = await openHost([task('Eggs'), task('Groceries', { status: 'next', checklist: [{ id: 'c1', title: 'Milk', isCompleted: true }, { id: 'c2', title: 'Bread', isCompleted: false }] }),
            task('Plan trip', { status: 'next' }), task('Done one', { status: 'done' }), task('Gone', { status: 'next', deletedAt: NOW })]);
        const picker = value(host.getChecklistMoveTargets({ sourceId: 'Eggs', query: '' }));
        expect(picker).toMatchObject({ title: 'Add to checklist…', searchLabel: 'Search...', cancelLabel: 'Cancel', noMatches: null });
        expect(picker.rows).toEqual([{ id: 'Groceries', title: 'Groceries', progress: '1/2' }, { id: 'Plan trip', title: 'Plan trip', progress: null }]);
        expect(value(host.getChecklistMoveTargets({ sourceId: 'Eggs', query: 'TRIP' })).rows.map((row) => row.id)).toEqual(['Plan trip']);
        expect(value(host.getChecklistMoveTargets({ sourceId: 'Eggs', query: 'zzz' }))).toMatchObject({ rows: [], noMatches: 'No matches' });
    });

    it('moves the title into the target\'s checklist and trashes the Inbox item in one write, with RN\'s Undo toast', async () => {
        const { host, writes } = await openHost([task('src', { title: ' Eggs ' }), task('target', { status: 'next' })]);
        expect(value(await host.moveTaskToChecklist(move('src', 'target')))).toEqual({ id: 'target', toast: { message: 'Added to checklist', undoLabel: 'Undo' } });
        await flushPendingSave();
        expect(writes()).toBe(1);
        expect(stored('target').checklist).toEqual([{ id: checklistItemIdForMovedTask('src'), title: 'Eggs', isCompleted: false }]);
        expect(stored('src').deletedAt).toBeTruthy();
    });

    it('Undo restores the Inbox item and removes only its checklist item, in one write', async () => {
        const { host, writes } = await openHost([task('src', { title: 'Eggs' }), task('target', { status: 'next', checklist: [{ id: 'c1', title: 'Milk', isCompleted: false }] })]);
        value(await host.moveTaskToChecklist(move('src', 'target')));
        await flushPendingSave();
        const after = writes();
        expect(value(await host.undoMoveTaskToChecklist(move('src', 'target')))).toEqual({ id: 'src' });
        await flushPendingSave();
        expect(writes()).toBe(after + 1);
        expect(stored('src')).toMatchObject({ status: 'inbox' });
        expect(stored('src').deletedAt).toBeUndefined();
        expect(stored('target').checklist).toEqual([{ id: 'c1', title: 'Milk', isCompleted: false }]);
    });

    it('a source that stopped being a plain title or a closed target is refused as stale with RN\'s words, and nothing is written', async () => {
        const { host, writes } = await openHost([task('src', { tags: ['#x'] }), task('plain'), task('target', { status: 'next' }), task('closed', { status: 'done' })]);
        for (const [sourceId, targetId] of [['src', 'target'], ['plain', 'closed'], ['plain', 'plain']]) {
            const refused = await host.moveTaskToChecklist(move(sourceId, targetId));
            expect(refused.ok ? '' : refused.error.code).toBe('STALE_REVISION');
        }
        const bad = await host.moveTaskToChecklist({ ...move('plain', 'target'), requestId: 'x' });
        expect(bad.ok ? '' : bad.error.code).toBe('INVALID_INPUT');
        await flushPendingSave();
        expect(writes()).toBe(0);
    });

    it('a retried request id moves once', async () => {
        const { host, writes } = await openHost([task('src'), task('target', { status: 'next' })]);
        const request = move('src', 'target');
        value(await host.moveTaskToChecklist(request));
        value(await host.moveTaskToChecklist(request));
        await flushPendingSave();
        expect(writes()).toBe(1);
        expect(stored('target').checklist).toHaveLength(1);
    });
});
