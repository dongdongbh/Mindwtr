import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskStore, type Task, type ViewSectionDefinition } from '@mindwtr/core';
import {
    retryPendingSomedaySectionMove,
    saveSomedaySectionMove,
    SomedaySectionMoveSaveError,
    SomedaySectionUndoSaveError,
    undoSomedaySectionMove,
} from './someday-section-move';
import { holdSyncSave } from '../test/hold-sync-save';

const flushMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@mindwtr/core', async (importOriginal) => ({
    ...await importOriginal<typeof import('@mindwtr/core')>(),
    flushPendingSave: flushMock,
}));

const now = '2026-09-15T00:00:00.000Z';
const sections: ViewSectionDefinition[] = [
    { id: 'books', title: 'Books', order: 0 },
    { id: 'empty', title: 'Empty ideas', order: 1 },
];
const task = (id: string, overrides: Partial<Task> = {}): Task => ({
    id,
    title: `Task ${id}`,
    status: 'someday',
    tags: [],
    contexts: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
});

const initialState = useTaskStore.getState();

function setTasks(tasks: Task[]) {
    const batchUpdateTasks = vi.fn(async (updates: Array<{ id: string; updates: Partial<Task> }>) => {
        useTaskStore.setState((state) => ({
            tasks: state.tasks.map((current) => {
                const update = updates.find((entry) => entry.id === current.id);
                return update ? { ...current, ...update.updates } : current;
            }),
        }));
        return { success: true };
    });
    useTaskStore.setState({
        tasks,
        _allTasks: tasks,
        projects: [],
        settings: { gtd: { viewSections: { someday: sections } } },
        batchUpdateTasks,
        retryPersistence: vi.fn(async () => { await flushMock(); }),
    });
    return batchUpdateTasks;
}

describe('desktop Someday section move persistence', () => {
    beforeEach(() => {
        useTaskStore.setState(initialState, true);
        flushMock.mockReset();
        flushMock.mockResolvedValue(undefined);
    });

    it('moves one task to an empty definition and clears it without touching other scopes or fields', async () => {
        const original = task('one', {
            projectId: 'project-a',
            sectionId: 'project-section',
            dueDate: '2026-10-01',
            viewSectionIds: { waiting: 'wait', focus: 'focus' },
        });
        const batch = setTasks([original]);
        const move = await saveSomedaySectionMove(['one'], 'empty', ['one'], 'No section');
        expect(move.changedCount).toBe(1);
        expect(move.destinationTitle).toBe('Empty ideas');
        expect(batch).toHaveBeenCalledTimes(1);
        expect(flushMock).toHaveBeenCalledTimes(1);
        expect(useTaskStore.getState().tasks[0]).toMatchObject({
            status: 'someday', projectId: 'project-a', sectionId: 'project-section', dueDate: '2026-10-01',
            viewSectionIds: { someday: 'empty', waiting: 'wait', focus: 'focus' },
        });

        const clear = await saveSomedaySectionMove(['one'], undefined, ['one'], 'No section');
        expect(clear.changedCount).toBe(1);
        expect(useTaskStore.getState().tasks[0].viewSectionIds).toEqual({ focus: 'focus', waiting: 'wait' });
    });

    it('moves a visible bulk selection and rejects a removed destination or stale target', async () => {
        setTasks([task('a'), task('b')]);
        const move = await saveSomedaySectionMove(['a', 'b'], 'books', ['a', 'b'], 'No section');
        expect(move.changedCount).toBe(2);
        expect(useTaskStore.getState().tasks.map((item) => item.viewSectionIds?.someday)).toEqual(['books', 'books']);
        await expect(saveSomedaySectionMove(['a'], 'deleted', ['a'], 'No section')).rejects.toThrow('no longer exists');
        await expect(saveSomedaySectionMove(['a', 'b'], 'empty', ['a'], 'No section')).rejects.toThrow('no longer editable');
    });

    it('retains the pre-write Undo snapshot when flush fails and retry sees an optimistic assignment', async () => {
        setTasks([task('a', { viewSectionIds: { someday: 'books', waiting: 'wait' } })]);
        flushMock.mockRejectedValueOnce(new Error('disk unavailable'));

        let pendingMove: SomedaySectionMoveSaveError['pendingMove'] | undefined;
        try {
            await saveSomedaySectionMove(['a'], 'empty', ['a'], 'No section');
        } catch (error) {
            expect(error).toBeInstanceOf(SomedaySectionMoveSaveError);
            pendingMove = (error as SomedaySectionMoveSaveError).pendingMove;
        }
        expect(pendingMove?.previous).toEqual([{ id: 'a', sectionId: 'books' }]);
        expect(useTaskStore.getState().tasks[0].viewSectionIds?.someday).toBe('empty');
        expect(flushMock).toHaveBeenCalledTimes(1);

        const saved = await retryPendingSomedaySectionMove(pendingMove!);
        expect(saved.changedCount).toBe(1);
        expect(flushMock).toHaveBeenCalledTimes(2);
        expect(await undoSomedaySectionMove(saved)).toBe(1);
        expect(useTaskStore.getState().tasks[0].viewSectionIds).toEqual({ someday: 'books', waiting: 'wait' });
    });

    it('undoes only assignments still matching the move and preserves later edits', async () => {
        setTasks([task('a'), task('b')]);
        const move = await saveSomedaySectionMove(['a', 'b'], 'books', ['a', 'b'], 'No section');
        useTaskStore.setState((state) => ({
            tasks: state.tasks.map((current) => current.id === 'a'
                ? { ...current, title: 'Edited later', viewSectionIds: { someday: 'books', waiting: 'new-wait' } }
                : { ...current, viewSectionIds: { someday: 'empty' } }),
        }));
        expect(await undoSomedaySectionMove(move)).toBe(1);
        expect(useTaskStore.getState().tasks[0]).toMatchObject({ title: 'Edited later', viewSectionIds: { waiting: 'new-wait' } });
        expect(useTaskStore.getState().tasks[1].viewSectionIds?.someday).toBe('empty');
    });

    it('keeps Undo retryable when its flush fails after optimistic restoration', async () => {
        setTasks([task('a')]);
        const move = await saveSomedaySectionMove(['a'], 'books', ['a'], 'No section');
        flushMock.mockRejectedValueOnce(new Error('disk unavailable'));
        let pendingCount: number | undefined;
        try {
            await undoSomedaySectionMove(move);
        } catch (error) {
            expect(error).toBeInstanceOf(SomedaySectionUndoSaveError);
            pendingCount = (error as SomedaySectionUndoSaveError).pendingCount;
        }
        expect(pendingCount).toBe(1);
        expect(useTaskStore.getState().tasks[0].viewSectionIds?.someday).toBeUndefined();
        expect(await undoSomedaySectionMove(move, pendingCount)).toBe(1);
        expect(flushMock).toHaveBeenCalledTimes(3);
    });

    it('builds the move and its Undo on the rows a sync save published while each waited', async () => {
        const batch = setTasks([task('one')]);
        let finish = holdSyncSave(() => useTaskStore.setState({ tasks: [task('one', { viewSectionIds: { waiting: 'remote' } })] }));
        const moving = saveSomedaySectionMove(['one'], 'books', ['one'], 'No section');
        await finish();
        const move = await moving;
        expect(batch).toHaveBeenLastCalledWith([{ id: 'one', updates: { viewSectionIds: { someday: 'books', waiting: 'remote' } } }]);

        finish = holdSyncSave(() => useTaskStore.setState({ tasks: [task('one', { viewSectionIds: { someday: 'books', waiting: 'later' } })] }));
        const undoing = undoSomedaySectionMove(move);
        await finish();
        expect(await undoing).toBe(1);
        expect(batch).toHaveBeenLastCalledWith([{ id: 'one', updates: { viewSectionIds: { waiting: 'later' } } }]);
    });
});
