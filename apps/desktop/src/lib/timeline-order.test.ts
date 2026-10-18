import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    compareProjectsByOrder, compareTasksByProjectOrder, getSequentialFirstTaskIds, resetForTests, runSerializedSyncDocumentWriteOperation,
    setStorageAdapter, useTaskStore, type Project, type Section, type Task,
} from '@mindwtr/core';
import { captureTimelineOrder, commitTimelineOrder, type TimelineOrderTarget } from './timeline-order';

const mocks = vi.hoisted(() => ({ flush: vi.fn(), log: vi.fn() }));
vi.mock('@mindwtr/core', async () => ({
    ...await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core'),
    flushPendingSave: mocks.flush,
}));
vi.mock('./app-log', () => ({ logInfo: mocks.log }));
const core = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');

const project = (id: string, order: number, areaId?: string): Project => ({
    id, order, areaId, title: `Private ${id}`, status: 'active', color: '#000000', tagIds: [],
    createdAt: '2026-01-01', updatedAt: '2026-01-01', startDate: '2026-10-10', dueDate: '2026-10-20',
});
const task = (id: string, order: number, sectionId?: string): Task => ({
    id, order, orderNum: order, sectionId, projectId: 'p', title: `Private ${id}`, status: 'next',
    tags: [], contexts: [], createdAt: '2026-01-01', updatedAt: '2026-01-01',
    startTime: '2026-10-10', dueDate: '2026-10-20',
});
const target = (id: string, sectionId: string | null = null): TimelineOrderTarget => ({ kind: 'task', id, projectId: 'p', sectionId });
const snapshot = (input: TimelineOrderTarget) => {
    const captured = captureTimelineOrder(input);
    if (!captured) throw new Error('Missing order snapshot');
    return captured;
};
const taskIds = () => [...useTaskStore.getState()._allTasks].sort(compareTasksByProjectOrder).map((row) => row.id);

describe('Timeline shared order persistence', () => {
    beforeEach(() => {
        resetForTests();
        mocks.log.mockReset().mockResolvedValue(undefined);
        mocks.flush.mockReset().mockImplementation(core.flushPendingSave);
        setStorageAdapter({ getData: async () => ({ tasks: [], projects: [], sections: [], areas: [], settings: {} }),
            saveData: async () => undefined });
        const projects = [project('p', 0), project('hidden', 1024), project('q', 2048)];
        const tasks = [task('a', 0), { ...task('hidden', 1024), startTime: undefined, dueDate: undefined }, task('b', 2048), task('c', 3072)];
        useTaskStore.setState({ _allTasks: tasks, _allProjects: projects, _allSections: [], _allAreas: [],
            tasks, projects, sections: [], areas: [], settings: { deviceId: 'timeline-test' },
            error: null, persistenceFailure: null, isLoading: false });
    });
    afterEach(async () => {
        await core.flushPendingSave();
        vi.restoreAllMocks();
        resetForTests();
    });

    it('moves a visible task around hidden work through the canonical operation and preserves dates', async () => {
        useTaskStore.setState((state) => ({ _allProjects: state._allProjects.map((row) => row.id === 'p' ? { ...row, isSequential: true } : row) }));
        const dates = useTaskStore.getState()._allTasks.map(({ id, startTime, dueDate }) => ({ id, startTime, dueDate }));
        expect(await commitTimelineOrder(snapshot(target('c')), target('a'))).toBe('saved');
        expect(taskIds()).toEqual(['c', 'a', 'hidden', 'b']);
        expect([...getSequentialFirstTaskIds(useTaskStore.getState()._allTasks, new Set(['p']))]).toEqual(['c']);
        expect(useTaskStore.getState()._allTasks.map(({ id, startTime, dueDate }) => ({ id, startTime, dueDate }))).toEqual(dates);
        expect(mocks.flush).toHaveBeenCalledOnce();
        expect(mocks.log).toHaveBeenCalledExactlyOnceWith('Timeline shared order saved', {
            scope: 'timeline', extra: { releaseCheck: 'v1.3.7/timeline-shared-order', kind: 'task', outcome: 'saved' },
        });
        expect(JSON.stringify(mocks.log.mock.calls)).not.toContain('Private');
    });

    it('moves projects within their area without moving hidden projects relative to each other or changing dates', async () => {
        const before = useTaskStore.getState()._allProjects;
        expect(await commitTimelineOrder(snapshot({ kind: 'project', id: 'q' }), { kind: 'project', id: 'p' })).toBe('saved');
        expect([...useTaskStore.getState()._allProjects].sort(compareProjectsByOrder).map((row) => row.id)).toEqual(['q', 'p', 'hidden']);
        expect(useTaskStore.getState()._allProjects.map(({ startDate, dueDate }) => ({ startDate, dueDate })))
            .toEqual(before.map(({ startDate, dueDate }) => ({ startDate, dueDate })));
    });

    it('refuses cross-section, cross-project and cross-area destinations', async () => {
        const sections: Section[] = [{ id: 's', projectId: 'p', title: 'Section', order: 0, createdAt: '2026-01-01', updatedAt: '2026-01-01' }];
        useTaskStore.setState((state) => ({ _allSections: sections, sections,
            _allTasks: [...state._allTasks, task('section', 0, 's')],
            _allProjects: [...state._allProjects, project('other-area', 0, 'area')] }));
        const before = taskIds();
        const captured = snapshot(target('a'));
        expect(await commitTimelineOrder(captured, target('section', 's'))).toBe('conflict');
        expect(await commitTimelineOrder(captured, { kind: 'task', id: 'section', projectId: 'q', sectionId: 's' })).toBe('conflict');
        expect(await commitTimelineOrder(snapshot({ kind: 'project', id: 'p' }), { kind: 'project', id: 'other-area', areaId: 'area' })).toBe('conflict');
        expect(taskIds()).toEqual(before);
        expect(mocks.flush).not.toHaveBeenCalled();
    });

    it('rejects any changed hidden ordering scope after waiting for an import to finish', async () => {
        const captured = snapshot(target('c'));
        let release!: () => void;
        let started!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const start = new Promise<void>((resolve) => { started = resolve; });
        const transfer = runSerializedSyncDocumentWriteOperation(async () => {
            started();
            await gate;
            useTaskStore.setState((state) => ({ _allTasks: state._allTasks.map((row) => row.id === 'hidden' ? { ...row, order: 4096 } : row) }));
        });
        await start;
        const pending = commitTimelineOrder(captured, target('a'));
        release();
        await transfer;
        expect(await pending).toBe('conflict');
        expect(mocks.flush).not.toHaveBeenCalled();
        expect(mocks.log).not.toHaveBeenCalled();
    });

    it('rejects a stale creation-date tie-break before writing unordered tasks', async () => {
        useTaskStore.setState({ _allTasks: [task('a', 0), task('b', 0), task('c', 0)].map((row, index) => ({
            ...row, order: undefined, orderNum: undefined, createdAt: `2026-10-0${index + 1}`,
        })) });
        const captured = snapshot(target('b'));
        useTaskStore.setState((state) => ({ _allTasks: state._allTasks.map((row) => row.id === 'a'
            ? { ...row, createdAt: '2026-10-04' } : row) }));
        expect(taskIds()).toEqual(['b', 'c', 'a']);
        expect(await commitTimelineOrder(captured, target('a'))).toBe('conflict');
        expect(taskIds()).toEqual(['b', 'c', 'a']);
        expect(mocks.flush).not.toHaveBeenCalled();
        expect(mocks.log).not.toHaveBeenCalled();
    });

    it('hides manual reorder for explicit sorts, finished tasks, and archived projects', () => {
        useTaskStore.setState((state) => ({ _allProjects: state._allProjects.map((row) => row.id === 'p' ? { ...row, taskSortBy: 'due' } : row) }));
        expect(captureTimelineOrder(target('a'))).toBeNull();
        useTaskStore.setState((state) => ({ _allProjects: state._allProjects.map((row) => row.id === 'p' ? { ...row, taskSortBy: undefined } : row),
            _allTasks: state._allTasks.map((row) => row.id === 'a' ? { ...row, status: 'done' } : row) }));
        expect(captureTimelineOrder(target('a'))).toBeNull();
        useTaskStore.setState((state) => ({ _allProjects: state._allProjects.map((row) => row.id === 'p' ? { ...row, status: 'archived' } : row) }));
        expect(captureTimelineOrder({ kind: 'project', id: 'p' })).toBeNull();
    });

    it('does no save or diagnostic for a canceled/no-op position', async () => {
        expect(await commitTimelineOrder(snapshot(target('a')), target('a'))).toBe('noop');
        expect(mocks.flush).not.toHaveBeenCalled();
        expect(mocks.log).not.toHaveBeenCalled();
    });

    it('does not announce success after a refused action or failed persistence, preserving core recovery state', async () => {
        const reorder = vi.spyOn(useTaskStore.getState(), 'reorderProjectTasks').mockRejectedValueOnce(new Error('refused'));
        await expect(commitTimelineOrder(snapshot(target('c')), target('a'))).rejects.toThrow('refused');
        expect(taskIds()).toEqual(['a', 'hidden', 'b', 'c']);
        expect(mocks.flush).not.toHaveBeenCalled();
        reorder.mockRestore();
        mocks.flush.mockRejectedValueOnce(new Error('disk full'));
        await expect(commitTimelineOrder(snapshot(target('c')), target('a'))).rejects.toThrow('disk full');
        expect(taskIds()).toEqual(['c', 'a', 'hidden', 'b']);
        expect(mocks.log).not.toHaveBeenCalled();
    });

    it('does not announce a saved order superseded while persistence was pending', async () => {
        mocks.flush.mockImplementationOnce(async () => {
            await core.flushPendingSave();
            useTaskStore.setState((state) => ({ _allTasks: state._allTasks.map((row) => row.id === 'c' ? { ...row, order: 9000 } : row) }));
        });
        expect(await commitTimelineOrder(snapshot(target('c')), target('a'))).toBe('conflict');
        expect(mocks.log).not.toHaveBeenCalled();
    });
});
