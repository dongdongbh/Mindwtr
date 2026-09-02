import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from '../store';
import type { StorageAdapter } from '../storage';
import { mergeAppData } from '../sync';
import type { AppData } from '../types';

const BASE_NOW = '2026-04-01T12:00:00.000Z';

describe('area actions', () => {
    let saveData: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        saveData = vi.fn().mockResolvedValue(undefined);
        const storage: StorageAdapter = {
            getData: vi.fn().mockResolvedValue({ tasks: [], projects: [], sections: [], areas: [], settings: {} }),
            saveData,
        };
        setStorageAdapter(storage);
        useTaskStore.setState({
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
            settings: {},
            isLoading: false,
            error: null,
            _allTasks: [],
            _allProjects: [],
            _allSections: [],
            _allAreas: [],
            _tasksById: new Map(),
            _projectsById: new Map(),
            _sectionsById: new Map(),
            _areasById: new Map(),
            lastDataChangeAt: 0,
        });
        vi.useFakeTimers();
        vi.setSystemTime(new Date(BASE_NOW));
    });

    afterEach(async () => {
        await flushPendingSave();
        resetForTests();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    const latestSavedData = (): AppData => {
        const saved = saveData.mock.calls.at(-1)?.[0] as AppData | undefined;
        expect(saved).toBeDefined();
        return saved!;
    };

    it('saves area tombstones and unassigns linked projects and tasks for sync', async () => {
        const { addArea, addProject, addSection, addTask, deleteArea } = useTaskStore.getState();
        const area = await addArea('Work', { color: '#3b82f6' });
        expect(area).not.toBeNull();
        if (!area) return;
        const project = await addProject('Launch', '#3b82f6', { areaId: area.id, areaTitle: 'Work' });
        expect(project).not.toBeNull();
        if (!project) return;
        const section = await addSection(project.id, 'Planning');
        expect(section).not.toBeNull();
        if (!section) return;
        await addTask('Area task', { areaId: area.id, status: 'next' });
        await addTask('Project task', { projectId: project.id, sectionId: section.id, status: 'next' });

        await deleteArea(area.id);
        await flushPendingSave();

        const state = useTaskStore.getState();
        expect(state.areas).toEqual([]);
        expect(state.projects.map((item) => item.id)).toEqual([project.id]);
        expect(state.sections.map((item) => item.id)).toEqual([section.id]);
        expect(state.tasks.map((item) => item.title).sort()).toEqual(['Area task', 'Project task']);
        const saved = latestSavedData();
        const savedArea = saved.areas.find((item) => item.id === area.id);
        expect(savedArea).toMatchObject({
            id: area.id,
            deletedAt: BASE_NOW,
            updatedAt: BASE_NOW,
        });
        expect(saved.projects.find((item) => item.id === project.id)).toMatchObject({
            areaId: undefined,
            areaTitle: undefined,
            updatedAt: BASE_NOW,
        });
        expect(saved.projects.find((item) => item.id === project.id)?.deletedAt).toBeUndefined();
        expect(saved.sections.find((item) => item.id === section.id)?.deletedAt).toBeUndefined();
        expect(saved.tasks.find((item) => item.title === 'Area task')).toMatchObject({
            areaId: undefined,
            updatedAt: BASE_NOW,
        });
        expect(saved.tasks.find((item) => item.title === 'Area task')?.deletedAt).toBeUndefined();
        expect(saved.tasks.find((item) => item.title === 'Project task')).toMatchObject({
            projectId: project.id,
            sectionId: section.id,
        });
        expect(saved.tasks.find((item) => item.title === 'Project task')?.deletedAt).toBeUndefined();
    });

    it('repaints projects back to the default color when the area color is cleared (#974)', async () => {
        const { addArea, addProject, updateArea } = useTaskStore.getState();
        const area = await addArea('Work', { color: '#3b82f6' });
        expect(area).not.toBeNull();
        if (!area) return;
        const project = await addProject('Launch', '#3b82f6', { areaId: area.id, areaTitle: 'Work' });
        expect(project).not.toBeNull();
        if (!project) return;
        expect(useTaskStore.getState().projects.find((item) => item.id === project.id)?.color).toBe('#3b82f6');

        await updateArea(area.id, { color: undefined });

        const state = useTaskStore.getState();
        expect(state.areas.find((item) => item.id === area.id)?.color).toBeUndefined();
        expect(state.projects.find((item) => item.id === project.id)?.color).toBe('#94a3b8');
    });

    it('detaches already-trashed tasks from a deleted area, the same as the sync merge would', async () => {
        // The merge clears a link to a non-live area on every device and restoreArea
        // never re-links children, so keeping the link here only produced a
        // non-canonical document that the next sync had to repair (#1001).
        const { addArea, addTask, deleteTask, deleteArea } = useTaskStore.getState();
        const area = await addArea('Work');
        expect(area).not.toBeNull();
        if (!area) return;
        const trashed = await addTask('Trashed area task', { areaId: area.id, status: 'next' });
        expect(trashed.success).toBe(true);
        if (!trashed.success) return;
        await deleteTask(trashed.id);
        const before = useTaskStore.getState()._allTasks.find((task) => task.id === trashed.id);
        expect(before?.deletedAt).toBeTruthy();
        expect(before?.areaId).toBe(area.id);

        await deleteArea(area.id);
        await flushPendingSave();

        const after = useTaskStore.getState()._allTasks.find((task) => task.id === trashed.id);
        expect(after?.deletedAt).toBe(before?.deletedAt);
        expect(after?.areaId).toBeUndefined();
        expect(after?.rev).toBe((before?.rev ?? 0) + 1);
    });

    it('restores the area without resurrecting independently deleted children', async () => {
        const { addArea, addProject, addSection, addTask, deleteArea, deleteProject, deleteTask, restoreArea } = useTaskStore.getState();
        const area = await addArea('Work');
        expect(area).not.toBeNull();
        if (!area) return;
        const activeProject = await addProject('Restore project', '#3b82f6', { areaId: area.id });
        const deletedProject = await addProject('Keep deleted project', '#64748b', { areaId: area.id });
        expect(activeProject).not.toBeNull();
        expect(deletedProject).not.toBeNull();
        if (!activeProject || !deletedProject) return;
        const section = await addSection(activeProject.id, 'Planning');
        expect(section).not.toBeNull();
        if (!section) return;
        const alreadyDeletedTask = await addTask('Keep deleted task', { projectId: activeProject.id, sectionId: section.id });
        expect(alreadyDeletedTask.success).toBe(true);
        if (!alreadyDeletedTask.success) return;

        vi.setSystemTime(new Date('2026-04-01T12:05:00.000Z'));
        await deleteTask(alreadyDeletedTask.id);
        const taskDeletedAt = useTaskStore.getState()._allTasks.find((task) => task.id === alreadyDeletedTask.id)?.deletedAt;
        await deleteProject(deletedProject.id);
        const projectDeletedAt = useTaskStore.getState()._allProjects.find((project) => project.id === deletedProject.id)?.deletedAt;

        vi.setSystemTime(new Date('2026-04-01T12:10:00.000Z'));
        await deleteArea(area.id);
        await restoreArea(area.id);

        const state = useTaskStore.getState();
        expect(state.areas.find((item) => item.id === area.id)?.deletedAt).toBeUndefined();
        expect(state.projects.find((item) => item.id === activeProject.id)?.deletedAt).toBeUndefined();
        expect(state.sections.find((item) => item.id === section.id)?.deletedAt).toBeUndefined();
        expect(state._allTasks.find((task) => task.id === alreadyDeletedTask.id)?.deletedAt).toBe(taskDeletedAt);
        expect(state._allProjects.find((project) => project.id === deletedProject.id)?.deletedAt).toBe(projectDeletedAt);
    });

    it('keeps newer area tombstones from being resurrected by older live sync data', () => {
        const deletedAt = '2026-04-01T12:10:00.000Z';
        const deletedArea = {
            id: 'area-work',
            name: 'Work',
            order: 0,
            createdAt: '2026-04-01T12:00:00.000Z',
            updatedAt: deletedAt,
            deletedAt,
            rev: 2,
            revBy: 'device-a',
        };
        const olderLiveArea = {
            ...deletedArea,
            updatedAt: '2026-04-01T12:05:00.000Z',
            deletedAt: undefined,
            rev: 1,
            revBy: 'device-b',
        };

        const merged = mergeAppData(
            { tasks: [], projects: [], sections: [], areas: [deletedArea], settings: {} },
            { tasks: [], projects: [], sections: [], areas: [olderLiveArea], settings: {} },
            { nowIso: deletedAt }
        );

        expect(merged.areas).toHaveLength(1);
        expect(merged.areas[0]).toMatchObject({
            id: deletedArea.id,
            updatedAt: deletedAt,
            deletedAt,
            rev: 2,
            revBy: 'device-a',
        });
    });

    it('reuses a deleted area tombstone without reassigning unassigned children', async () => {
        const { addArea, addProject, addSection, addTask, deleteArea } = useTaskStore.getState();
        const area = await addArea('Work');
        expect(area).not.toBeNull();
        if (!area) return;
        const project = await addProject('Launch', '#3b82f6', { areaId: area.id });
        expect(project).not.toBeNull();
        if (!project) return;
        const section = await addSection(project.id, 'Planning');
        expect(section).not.toBeNull();
        if (!section) return;
        const areaTask = await addTask('Area task', { areaId: area.id, status: 'next' });
        const projectTask = await addTask('Project task', { projectId: project.id, sectionId: section.id, status: 'next' });
        expect(areaTask.success).toBe(true);
        expect(projectTask.success).toBe(true);
        if (!areaTask.success || !projectTask.success) return;

        await deleteArea(area.id);
        vi.setSystemTime(new Date('2026-04-01T12:15:00.000Z'));
        const restored = await addArea(' work ', { color: '#ef4444' });

        expect(restored?.id).toBe(area.id);
        const state = useTaskStore.getState();
        expect(state._allAreas).toHaveLength(1);
        expect(state.areas).toHaveLength(1);
        expect(state._allAreas[0]).toMatchObject({
            id: area.id,
            name: 'work',
            deletedAt: undefined,
            updatedAt: '2026-04-01T12:15:00.000Z',
        });
        const restoredProject = state.projects.find((item) => item.id === project.id);
        expect(restoredProject).toMatchObject({
            areaId: undefined,
            color: '#3b82f6',
        });
        expect(restoredProject?.deletedAt).toBeUndefined();
        expect(state.sections.find((item) => item.id === section.id)?.deletedAt).toBeUndefined();
        const restoredAreaTask = state.tasks.find((task) => task.id === areaTask.id);
        expect(restoredAreaTask).toMatchObject({
            areaId: undefined,
        });
        expect(restoredAreaTask?.deletedAt).toBeUndefined();
        expect(state.tasks.find((task) => task.id === projectTask.id)?.deletedAt).toBeUndefined();

        await flushPendingSave();
        const saved = latestSavedData();
        expect(saved.projects.find((item) => item.id === project.id)?.deletedAt).toBeUndefined();
        expect(saved.projects.find((item) => item.id === project.id)?.areaId).toBeUndefined();
        expect(saved.sections.find((item) => item.id === section.id)?.deletedAt).toBeUndefined();
        expect(saved.tasks.find((task) => task.id === areaTask.id)?.deletedAt).toBeUndefined();
        expect(saved.tasks.find((task) => task.id === areaTask.id)?.areaId).toBeUndefined();
        expect(saved.tasks.find((task) => task.id === projectTask.id)?.deletedAt).toBeUndefined();
    });

    it('keeps a tombstone and remaps direct tasks when renaming into an existing area', async () => {
        const { addArea, addProject, addTask, updateArea } = useTaskStore.getState();
        const work = await addArea('Work', { color: '#3b82f6' });
        const home = await addArea('Home', { color: '#22c55e' });
        expect(work).not.toBeNull();
        expect(home).not.toBeNull();
        if (!work || !home) return;

        const project = await addProject('Launch', '#3b82f6', { areaId: work.id, areaTitle: 'Work' });
        expect(project).not.toBeNull();
        if (!project) return;
        const areaTask = await addTask('Area task', { areaId: work.id, status: 'next' });
        expect(areaTask.success).toBe(true);
        if (!areaTask.success) return;

        const result = await updateArea(work.id, { name: 'Home', color: '#ef4444' });
        await flushPendingSave();

        expect(result).toEqual({ success: true });
        const state = useTaskStore.getState();
        expect(state.areas.map((item) => item.id)).toEqual([home.id]);
        expect(state._allAreas.find((item) => item.id === work.id)).toMatchObject({
            id: work.id,
            deletedAt: BASE_NOW,
            updatedAt: BASE_NOW,
        });
        expect(state._allAreas.find((item) => item.id === home.id)).toMatchObject({
            id: home.id,
            name: 'Home',
            color: '#ef4444',
        });
        expect(state._allAreas.find((item) => item.id === home.id)?.deletedAt).toBeUndefined();
        expect(state.projects.find((item) => item.id === project.id)).toMatchObject({
            areaId: home.id,
            areaTitle: 'Home',
            color: '#ef4444',
        });
        expect(state.tasks.find((item) => item.id === areaTask.id)).toMatchObject({
            areaId: home.id,
            updatedAt: BASE_NOW,
        });

        const saved = latestSavedData();
        expect(saved.areas.find((item) => item.id === work.id)?.deletedAt).toBe(BASE_NOW);
        expect(saved.projects.find((item) => item.id === project.id)?.areaId).toBe(home.id);
        expect(saved.projects.find((item) => item.id === project.id)?.areaTitle).toBe('Home');
        expect(saved.tasks.find((item) => item.id === areaTask.id)?.areaId).toBe(home.id);
    });

    it('keeps deleted area tombstones when reordering active areas', async () => {
        const { addArea, deleteArea, reorderAreas } = useTaskStore.getState();
        const work = await addArea('Work');
        const home = await addArea('Home');
        expect(work).not.toBeNull();
        expect(home).not.toBeNull();
        if (!work || !home) return;

        await deleteArea(work.id);
        const deletedAt = useTaskStore.getState()._allAreas.find((item) => item.id === work.id)?.deletedAt;
        await reorderAreas([home.id]);
        await flushPendingSave();

        const state = useTaskStore.getState();
        expect(state.areas.map((item) => item.id)).toEqual([home.id]);
        expect(state._allAreas.find((item) => item.id === work.id)?.deletedAt).toBe(deletedAt);
        const saved = latestSavedData();
        expect(saved.areas.find((item) => item.id === work.id)?.deletedAt).toBe(deletedAt);
        expect(saved.areas.find((item) => item.id === home.id)?.order).toBe(0);
    });
});
