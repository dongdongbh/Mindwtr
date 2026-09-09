import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBulkOrganizeArea, createBulkOrganizeProject, ensureBulkOrganizeDestinationSaved } from './bulk-organize-create';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData } from './types';

describe('Bulk Organize destination creation (#1187)', () => {
    const saveData = vi.fn<(...args: unknown[]) => Promise<void>>();

    beforeEach(() => {
        resetForTests();
        saveData.mockReset().mockResolvedValue(undefined);
        setStorageAdapter({
            getData: async () => ({ tasks: [], projects: [], sections: [], areas: [], settings: {} }),
            saveData,
        });
        useTaskStore.setState({
            tasks: [], projects: [], sections: [], areas: [], settings: {},
            _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [],
            _tasksById: new Map(), _projectsById: new Map(), _sectionsById: new Map(), _areasById: new Map(),
            isLoading: false, error: null, persistenceFailure: null, lastDataChangeAt: 0,
        });
        vi.useFakeTimers();
    });

    afterEach(() => {
        resetForTests();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('creates and durably saves stamped destinations without changing tasks', async () => {
        await useTaskStore.getState().addTask('Selected task');
        await flushPendingSave();
        const tasks = useTaskStore.getState().tasks;
        const area = await createBulkOrganizeArea(' Work ');
        const project = await createBulkOrganizeProject(' Launch ', area!.id);
        expect(area).toMatchObject({ name: 'Work', rev: 1 });
        expect(project).toMatchObject({ title: 'Launch', areaId: area!.id, areaTitle: 'Work', rev: 1 });
        expect(project!.revBy).toBeTruthy();
        const saved = saveData.mock.calls.at(-1)![0] as AppData;
        expect(saved.projects).toContainEqual(project);
        expect(saved.areas).toContainEqual(area);
        expect(useTaskStore.getState().tasks).toBe(tasks);
        expect(saved.tasks[0].projectId).toBeUndefined();
    });

    it('does not acknowledge creation until storage resolves', async () => {
        let release!: () => void;
        saveData.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
        let settled = false;
        const pending = createBulkOrganizeProject('Launch').then((value) => { settled = true; return value; });
        await vi.advanceTimersByTimeAsync(0);
        expect(saveData).toHaveBeenCalledOnce();
        expect(settled).toBe(false);
        release();
        expect(await pending).toMatchObject({ title: 'Launch' });
    });

    it('reuses existing destinations and preserves same-title projects in distinct areas', async () => {
        const work = await createBulkOrganizeArea('Work');
        const home = await createBulkOrganizeArea('Home');
        const first = await createBulkOrganizeProject('Launch', work!.id);
        const duplicate = await createBulkOrganizeProject(' launch ', work!.id);
        const distinct = await createBulkOrganizeProject('Launch', home!.id);
        expect(duplicate!.id).toBe(first!.id);
        expect(distinct!.id).not.toBe(first!.id);
        expect((await createBulkOrganizeArea(' work '))!.id).toBe(work!.id);
        expect(useTaskStore.getState().projects).toHaveLength(2);
        expect(useTaskStore.getState().areas).toHaveLength(2);
    });

    it('does not create destinations for whitespace', async () => {
        expect(await createBulkOrganizeArea(' ')).toBeNull();
        expect(await createBulkOrganizeProject(' ')).toBeNull();
        expect(saveData).not.toHaveBeenCalled();
    });

    it('does not replace an existing area color when reusing its name', async () => {
        const area = await useTaskStore.getState().addArea('Work', { color: '#aabbcc', icon: 'Briefcase' });
        await flushPendingSave();
        saveData.mockClear();
        expect(await createBulkOrganizeArea(' work ')).toEqual(area);
        expect(useTaskStore.getState().areas[0]).toMatchObject({ color: '#aabbcc', icon: 'Briefcase', rev: 1 });
        expect(saveData).not.toHaveBeenCalled();
    });

    it.each(['project', 'area'] as const)('rejects failed %s persistence and retries without duplicating it', async (kind) => {
        const create = () => kind === 'project' ? createBulkOrganizeProject('Draft') : createBulkOrganizeArea('Draft');
        saveData.mockRejectedValue(new Error('disk unavailable'));
        const outcome = create().then(() => 'unexpected success', (error: Error) => error.message);
        await vi.runAllTimersAsync();
        expect(await outcome).toBe('disk unavailable');
        expect(useTaskStore.getState().persistenceFailure).not.toBeNull();
        // The failed destination is now visible to pickers. Selecting its row
        // must retry persistence, not acknowledge an undurable in-memory item.
        const failedSelection = ensureBulkOrganizeDestinationSaved().then(
            () => 'unexpected success', (error: Error) => error.message,
        );
        await vi.runAllTimersAsync();
        expect(await failedSelection).toBe('disk unavailable');
        saveData.mockResolvedValue(undefined);
        await ensureBulkOrganizeDestinationSaved();
        const recovered = await create();
        expect(recovered).not.toBeNull();
        expect(useTaskStore.getState().persistenceFailure).toBeNull();
        expect(kind === 'project' ? useTaskStore.getState().projects : useTaskStore.getState().areas).toHaveLength(1);
    });
});
