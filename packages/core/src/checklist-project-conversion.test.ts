import { beforeEach, describe, expect, it } from 'vitest';
import { resetForTests, setStorageAdapter, useTaskStore } from './store';
import { checklistProjectBlockReason, prepareChecklistProjectConversion } from './checklist-project-conversion';
import type { AppData, Task } from './types';

let saved: AppData | undefined;
let failSave = false;
const source = (): Task => ({ id: 'source', title: 'Launch', status: 'next', tags: ['work'], contexts: ['@computer'],
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', rev: 1,
    description: 'Instructions', dueDate: '2026-12-01', startTime: '2026-11-01', reviewAt: '2026-11-15',
    attachments: [{ id: 'file', kind: 'file', title: 'Brief', uri: '/brief.pdf', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }],
    checklist: [{ id: 'duplicate', title: 'First', isCompleted: true }, { id: 'duplicate', title: 'Second', isCompleted: false }] });
const prepare = () => {
    const state = useTaskStore.getState();
    const prepared = prepareChecklistProjectConversion(state, state._tasksById.get('source')!, 'Launch');
    if (!prepared.success) throw new Error(prepared.error);
    return prepared.command;
};
beforeEach(() => {
    resetForTests(); saved = undefined; failSave = false;
    setStorageAdapter({ getData: async () => saved!, saveData: async data => {
        if (failSave) throw new Error('Disk unavailable');
        saved = structuredClone(data);
    } });
    useTaskStore.setState({ _allTasks: [source()], _allProjects: [], _allSections: [], _allAreas: [], settings: {} });
});
describe('optional checklist project conversion', () => {
    it('keeps default promotion unchanged', async () => {
        const result = await useTaskStore.getState().promoteTaskToProject('source');
        expect(result.success).toBe(true);
        expect(useTaskStore.getState().tasks).toHaveLength(1);
        expect(useTaskStore.getState().tasks[0].checklist).toEqual(source().checklist);
    });
    it('atomically transfers metadata, preserves checked state/order, replays, and undoes without duplicates', async () => {
        const command = prepare();
        expect(await useTaskStore.getState().convertChecklistToProject(command)).toMatchObject({ success: true });
        expect(saved?.projects[0]).toMatchObject({ supportNotes: 'Instructions', dueDate: '2026-12-01', startDate: '2026-11-01', attachments: source().attachments });
        expect(saved?.tasks.find(task => task.id === 'source')?.deletedAt).toBeTruthy();
        expect(useTaskStore.getState().tasks.map(task => [task.title, task.status, task.order, task.completedAt]))
            .toEqual([['First', 'done', 0, undefined], ['Second', 'next', 1, undefined]]);
        expect(useTaskStore.getState().tasks.every(task => !task.dueDate && !task.recurrence && !task.attachments)).toBe(true);
        expect(await useTaskStore.getState().convertChecklistToProject(command)).toMatchObject({ success: true });
        expect(useTaskStore.getState()._allTasks).toHaveLength(3);
        expect(await useTaskStore.getState().undoChecklistToProject(command)).toMatchObject({ success: true });
        expect(useTaskStore.getState().tasks).toHaveLength(1);
        expect(useTaskStore.getState().tasks[0]).toMatchObject({ title: 'Launch', checklist: source().checklist, attachments: source().attachments });
        expect(useTaskStore.getState().projects).toHaveLength(0);
        expect(await useTaskStore.getState().undoChecklistToProject(command)).toMatchObject({ success: true });
    });
    it('rejects a changed source or destination and never overwrites edits during undo', async () => {
        const command = prepare();
        useTaskStore.setState({ _allTasks: [{ ...source(), description: 'New edit' }] });
        expect((await useTaskStore.getState().convertChecklistToProject(command)).success).toBe(false);
        const fresh = prepare();
        await useTaskStore.getState().convertChecklistToProject(fresh);
        await useTaskStore.getState().updateTask(fresh.tasks[1].id, { title: 'Edited child' });
        expect((await useTaskStore.getState().undoChecklistToProject(fresh)).success).toBe(false);
        expect(useTaskStore.getState()._tasksById.get(fresh.tasks[1].id)?.title).toBe('Edited child');
    });
    it('preserves unrelated edits and refuses undo after new tasks were added to the project', async () => {
        const command = prepare();
        await useTaskStore.getState().convertChecklistToProject(command);
        const unrelated = await useTaskStore.getState().addTask('Unrelated');
        expect((await useTaskStore.getState().undoChecklistToProject(command)).success).toBe(true);
        expect(useTaskStore.getState()._tasksById.get(unrelated.id!)?.title).toBe('Unrelated');
        const next = prepare();
        await useTaskStore.getState().convertChecklistToProject(next);
        await useTaskStore.getState().addTask('New project work', { projectId: next.project.id });
        expect((await useTaskStore.getState().undoChecklistToProject(next)).success).toBe(false);
    });
    it('rejects task-only commitments and existing names without changing source data', () => {
        for (const patch of [{ recurrence: 'daily' }, { repeatReminderMinutes: 10 }, { dueDate: '2026-11-01T10:00:00Z' },
            { reviewAt: '2026-11-01T10:00:00Z', suppressMindwtrReminders: true }, { timeSpentMinutes: 10 }, { assignedTo: 'Someone' }, { location: 'Office' }, { status: 'archived' }]) {
            expect(checklistProjectBlockReason({ ...source(), ...patch } as Task)).not.toBeNull();
        }
        const command = prepare();
        useTaskStore.setState({ _allProjects: [command.project] });
        expect(prepareChecklistProjectConversion(useTaskStore.getState(), source(), 'Launch'))
            .toEqual({ success: false, error: 'task.expandChecklistNameExists' });
        expect(useTaskStore.getState()._tasksById.get('source')?.deletedAt).toBeUndefined();
    });
    it('retains one conversion across a failed save and retry', async () => {
        const command = prepare(); failSave = true;
        const failed = await useTaskStore.getState().convertChecklistToProject(command);
        expect(failed.success).toBe(false);
        failSave = false;
        expect((await useTaskStore.getState().convertChecklistToProject(command)).success).toBe(true);
        expect(saved?.tasks).toHaveLength(3);
        expect(saved?.projects).toHaveLength(1);
    });
});
