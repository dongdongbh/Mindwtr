import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { addDays } from 'date-fns';
import { safeParseDate } from './date';
import { useTaskStore, flushPendingSave, setStorageAdapter } from './store';
import type { StorageAdapter } from './storage';

const waitForExpectation = async (assertion: () => void, maxAttempts = 200): Promise<void> => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
            assertion();
            return;
        } catch (error) {
            lastError = error;
            await Promise.resolve();
        }
    }
    throw lastError ?? new Error('Timed out waiting for expectation');
};

describe('TaskStore', () => {
    let mockStorage: StorageAdapter;

    beforeEach(() => {
        // Create fresh mock storage for each test
        mockStorage = {
            getData: vi.fn().mockResolvedValue({ tasks: [], projects: [], sections: [], areas: [], settings: {} }),
            saveData: vi.fn().mockResolvedValue(undefined),
        };
        setStorageAdapter(mockStorage);
        useTaskStore.setState({
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
            settings: {},
            _allTasks: [],
            _allProjects: [],
            _allSections: [],
            _allAreas: [],
        });
        vi.useFakeTimers();
    });

    afterEach(async () => {
        await flushPendingSave();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('should add a task', () => {
        const { addTask } = useTaskStore.getState();
        addTask('New Task');

        const { tasks } = useTaskStore.getState();
        expect(tasks).toHaveLength(1);
        expect(tasks[0].title).toBe('New Task');
        expect(tasks[0].status).toBe('inbox');
    });

    it('should update a task', () => {
        const { addTask, updateTask } = useTaskStore.getState();
        addTask('Task to Update');

        const task = useTaskStore.getState().tasks[0];
        updateTask(task.id, { title: 'Updated Task', status: 'next' });

        const updatedTask = useTaskStore.getState().tasks[0];
        expect(updatedTask.title).toBe('Updated Task');
        expect(updatedTask.status).toBe('next');
    });

    it('should clear action fields when a task becomes reference', () => {
        const { addTask, updateTask } = useTaskStore.getState();
        addTask('Reference Task', {
            status: 'next',
            startTime: '2025-01-01T08:00:00.000Z',
            dueDate: '2025-01-01T09:00:00.000Z',
            reviewAt: '2025-01-02T09:00:00.000Z',
            recurrence: 'daily',
            priority: 'high',
            timeEstimate: '30min',
            checklist: [{ id: 'c1', title: 'Subtask', isCompleted: false }],
            isFocusedToday: true,
            pushCount: 2,
        });

        const task = useTaskStore.getState().tasks[0];
        updateTask(task.id, { status: 'reference' });

        const updatedTask = useTaskStore.getState()._allTasks.find(t => t.id === task.id)!;
        expect(updatedTask.status).toBe('reference');
        expect(updatedTask.startTime).toBeUndefined();
        expect(updatedTask.dueDate).toBeUndefined();
        expect(updatedTask.reviewAt).toBeUndefined();
        expect(updatedTask.recurrence).toBeUndefined();
        expect(updatedTask.priority).toBeUndefined();
        expect(updatedTask.timeEstimate).toBeUndefined();
        expect(updatedTask.checklist).toBeUndefined();
        expect(updatedTask.isFocusedToday).toBe(false);
        expect(updatedTask.pushCount).toBe(0);
    });

    it('should delete a task', () => {
        const { addTask, deleteTask } = useTaskStore.getState();
        addTask('Task to Delete');

        const task = useTaskStore.getState().tasks[0];
        deleteTask(task.id);

        const { tasks } = useTaskStore.getState();
        expect(tasks).toHaveLength(0);
    });

    it('keeps derived context and tag lists scoped to used tokens', () => {
        const { addTask } = useTaskStore.getState();
        addTask('Token Task', {
            contexts: ['@office'],
            tags: ['#deep'],
        });

        const derived = useTaskStore.getState().getDerivedState();
        expect(derived.allContexts).toEqual(['@office']);
        expect(derived.allTags).toEqual(['#deep']);
    });

    it('keeps store state consistent under rapid add/delete interleaving', async () => {
        const { addTask, deleteTask } = useTaskStore.getState();

        await Promise.all(
            Array.from({ length: 20 }, (_, index) => addTask(`Burst Task ${index}`))
        );

        const seededTaskIds = useTaskStore
            .getState()
            ._allTasks
            .filter((task) => task.title.startsWith('Burst Task'))
            .map((task) => task.id);

        const deleteIds = seededTaskIds.filter((_, index) => index % 2 === 0);
        await Promise.all([
            ...deleteIds.map((id) => deleteTask(id)),
            ...Array.from({ length: 10 }, (_, index) => addTask(`Late Task ${index}`)),
        ]);
        await flushPendingSave();

        const state = useTaskStore.getState();
        const allIds = state._allTasks.map((task) => task.id);
        expect(new Set(allIds).size).toBe(allIds.length);

        const expectedVisibleIds = state._allTasks
            .filter((task) => !task.deletedAt && task.status !== 'archived')
            .map((task) => task.id)
            .sort();
        const visibleIds = state.tasks.map((task) => task.id).sort();
        expect(visibleIds).toEqual(expectedVisibleIds);
    });

    it('should increment revision metadata when purging a task', () => {
        const { addTask, deleteTask, purgeTask } = useTaskStore.getState();
        addTask('Task to Purge');

        const task = useTaskStore.getState()._allTasks[0];
        deleteTask(task.id);
        const deleted = useTaskStore.getState()._allTasks.find((item) => item.id === task.id)!;
        const deletedRev = deleted.rev ?? 0;

        purgeTask(task.id);
        const purged = useTaskStore.getState()._allTasks.find((item) => item.id === task.id)!;
        expect(purged.purgedAt).toBeTruthy();
        expect((purged.rev ?? 0)).toBeGreaterThan(deletedRev);
        expect(typeof purged.revBy).toBe('string');
        expect((purged.revBy ?? '').length).toBeGreaterThan(0);
    });

    it('clears attachment remote metadata when purging tasks', () => {
        const { addTask, deleteTask, purgeTask } = useTaskStore.getState();
        addTask('Task with attachment', {
            attachments: [
                {
                    id: 'a1',
                    kind: 'file',
                    title: 'doc.txt',
                    uri: '/tmp/doc.txt',
                    cloudKey: 'attachments/doc.txt',
                    localStatus: 'available',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
        });

        const task = useTaskStore.getState()._allTasks[0];
        deleteTask(task.id);
        purgeTask(task.id);

        const purged = useTaskStore.getState()._allTasks.find((item) => item.id === task.id)!;
        expect(purged.purgedAt).toBeTruthy();
        expect(purged.attachments?.[0]?.cloudKey).toBeUndefined();
        expect(purged.attachments?.[0]?.localStatus).toBeUndefined();
    });

    it('skips fetch while edits are in progress', async () => {
        const { lockEditing, unlockEditing, fetchData } = useTaskStore.getState();
        lockEditing();
        await fetchData({ silent: true });
        expect(mockStorage.getData).not.toHaveBeenCalled();
        unlockEditing();
    });

    it('purges expired tombstones during fetch even without sync', async () => {
        mockStorage.getData = vi.fn().mockResolvedValue({
            tasks: [
                {
                    id: 't-old',
                    title: 'Old tombstone',
                    status: 'done',
                    tags: [],
                    contexts: [],
                    createdAt: '2000-01-01T00:00:00.000Z',
                    updatedAt: '2000-06-01T00:00:00.000Z',
                    deletedAt: '2000-06-01T00:00:00.000Z',
                    purgedAt: '2000-06-01T00:00:00.000Z',
                },
            ],
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        });

        await useTaskStore.getState().fetchData({ silent: true });
        await flushPendingSave();

        expect(useTaskStore.getState()._allTasks).toHaveLength(0);
        expect((mockStorage.saveData as unknown as { mock: { calls: any[][] } }).mock.calls.length).toBeGreaterThan(0);
    });

    it('promotes scheduled tasks to next when scheduled date is reached', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-02-14T10:00:00.000Z').getTime());
        mockStorage.getData = vi.fn().mockResolvedValue({
            tasks: [
                {
                    id: 't-inbox',
                    title: 'Inbox task due today',
                    status: 'inbox',
                    dueDate: '2026-02-14',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-02-01T00:00:00.000Z',
                    updatedAt: '2026-02-01T00:00:00.000Z',
                },
                {
                    id: 't-someday',
                    title: 'Someday task start passed',
                    status: 'someday',
                    startTime: '2026-02-13T08:00:00.000Z',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-02-01T00:00:00.000Z',
                    updatedAt: '2026-02-01T00:00:00.000Z',
                },
                {
                    id: 't-waiting-future',
                    title: 'Waiting task still future',
                    status: 'waiting',
                    startTime: '2026-02-15T08:00:00.000Z',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-02-01T00:00:00.000Z',
                    updatedAt: '2026-02-01T00:00:00.000Z',
                },
            ],
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        });

        await useTaskStore.getState().fetchData({ silent: true });
        await flushPendingSave();

        const byId = new Map(useTaskStore.getState()._allTasks.map((task) => [task.id, task]));
        expect(byId.get('t-inbox')?.status).toBe('next');
        expect(byId.get('t-someday')?.status).toBe('next');
        expect(byId.get('t-waiting-future')?.status).toBe('waiting');
        expect(byId.get('t-inbox')?.rev).toBe(1);
        expect(typeof byId.get('t-inbox')?.revBy).toBe('string');
        expect(mockStorage.saveData).toHaveBeenCalled();
    });

    it('archives active tasks that belong to archived projects during fetch', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-02-14T10:00:00.000Z').getTime());
        mockStorage.getData = vi.fn().mockResolvedValue({
            tasks: [
                {
                    id: 't-linked',
                    title: 'Should be archived',
                    status: 'next',
                    projectId: 'p-archived',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-02-01T00:00:00.000Z',
                    updatedAt: '2026-02-01T00:00:00.000Z',
                },
            ],
            projects: [
                {
                    id: 'p-archived',
                    title: 'Archived project',
                    status: 'archived',
                    color: '#123456',
                    order: 0,
                    tagIds: [],
                    createdAt: '2026-02-01T00:00:00.000Z',
                    updatedAt: '2026-02-01T00:00:00.000Z',
                },
            ],
            sections: [
                {
                    id: 's-linked',
                    projectId: 'p-archived',
                    title: 'Section should be archived',
                    order: 0,
                    createdAt: '2026-02-01T00:00:00.000Z',
                    updatedAt: '2026-02-01T00:00:00.000Z',
                },
            ],
            areas: [],
            settings: {},
        });

        await useTaskStore.getState().fetchData({ silent: true });
        await flushPendingSave();

        const linkedTask = useTaskStore.getState()._allTasks.find((task) => task.id === 't-linked');
        const linkedSection = useTaskStore.getState()._allSections.find((section) => section.id === 's-linked');
        expect(linkedTask?.status).toBe('archived');
        expect(linkedTask?.isFocusedToday).toBe(false);
        expect(linkedTask?.completedAt).toBeTruthy();
        expect(linkedSection?.deletedAt).toBeTruthy();
        expect(mockStorage.saveData).toHaveBeenCalled();
    });

    it('repairs invalid project, section, and area references during fetch', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-02-14T10:00:00.000Z').getTime());
        mockStorage.getData = vi.fn().mockResolvedValue({
            tasks: [
                {
                    id: 't-invalid',
                    title: 'Broken links',
                    status: 'next',
                    projectId: 'missing-project',
                    sectionId: 'missing-section',
                    areaId: 'missing-area',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-02-01T00:00:00.000Z',
                    updatedAt: '2026-02-01T00:00:00.000Z',
                },
            ],
            projects: [
                {
                    id: 'p-invalid',
                    title: 'Broken area',
                    status: 'active',
                    color: '#123456',
                    order: 0,
                    tagIds: [],
                    areaId: 'missing-area',
                    createdAt: '2026-02-01T00:00:00.000Z',
                    updatedAt: '2026-02-01T00:00:00.000Z',
                },
            ],
            sections: [
                {
                    id: 's-invalid',
                    projectId: 'missing-project',
                    title: 'Orphan section',
                    order: 0,
                    createdAt: '2026-02-01T00:00:00.000Z',
                    updatedAt: '2026-02-01T00:00:00.000Z',
                },
            ],
            areas: [],
            settings: {},
        });

        await useTaskStore.getState().fetchData({ silent: true });
        await flushPendingSave();

        const repairedTask = useTaskStore.getState()._allTasks.find((task) => task.id === 't-invalid');
        const repairedProject = useTaskStore.getState()._allProjects.find((project) => project.id === 'p-invalid');
        const orphanedSection = useTaskStore.getState()._allSections.find((section) => section.id === 's-invalid');
        expect(repairedTask?.projectId).toBeUndefined();
        expect(repairedTask?.sectionId).toBeUndefined();
        expect(repairedTask?.areaId).toBeUndefined();
        expect(repairedProject?.areaId).toBeUndefined();
        expect(orphanedSection?.deletedAt).toBeTruthy();
        expect(mockStorage.saveData).toHaveBeenCalled();
    });

    it('defaults notifications to off on first install', async () => {
        mockStorage.getData = vi.fn().mockResolvedValue({
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        });

        await useTaskStore.getState().fetchData({ silent: true });

        expect(useTaskStore.getState().settings.notificationsEnabled).toBe(false);
    });

    it('does not force notifications off for existing data with legacy settings', async () => {
        mockStorage.getData = vi.fn().mockResolvedValue({
            tasks: [
                {
                    id: 'legacy-task',
                    title: 'Legacy task',
                    status: 'inbox',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-02-01T00:00:00.000Z',
                    updatedAt: '2026-02-01T00:00:00.000Z',
                },
            ],
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        });

        await useTaskStore.getState().fetchData({ silent: true });

        expect(useTaskStore.getState().settings.notificationsEnabled).toBeUndefined();
    });

    it('supports a basic task lifecycle', async () => {
        const { addTask, updateTask, moveTask } = useTaskStore.getState();
        addTask('Lifecycle Task');
        const taskId = useTaskStore.getState().tasks[0].id;

        updateTask(taskId, { title: 'Lifecycle Task Updated', status: 'next' });
        await moveTask(taskId, 'done');
        await moveTask(taskId, 'archived');

        const archived = useTaskStore.getState()._allTasks.find((task) => task.id === taskId);
        expect(archived?.status).toBe('archived');
        expect(archived?.title).toBe('Lifecycle Task Updated');
    });

    it('keeps explicit waiting status after a refresh even when dated tasks are due', async () => {
        let persistedData = {
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        };
        mockStorage.getData = vi.fn().mockImplementation(async () => persistedData);
        mockStorage.saveData = vi.fn().mockImplementation(async (data) => {
            persistedData = JSON.parse(JSON.stringify(data));
        });

        const { addTask, moveTask } = useTaskStore.getState();
        await addTask('Waiting handoff', {
            status: 'next',
            dueDate: '2026-02-14T08:00:00.000Z',
            startTime: '2026-02-14T07:30:00.000Z',
        });

        const taskId = useTaskStore.getState()._allTasks[0]?.id;
        if (!taskId) throw new Error('Failed to seed waiting task');

        await moveTask(taskId, 'waiting');
        await flushPendingSave();
        await useTaskStore.getState().fetchData({ silent: true });

        const refreshed = useTaskStore.getState()._allTasks.find((task) => task.id === taskId);
        expect(refreshed?.status).toBe('waiting');
        expect(refreshed?.dueDate).toBe('2026-02-14T08:00:00.000Z');
        expect(refreshed?.startTime).toBe('2026-02-14T07:30:00.000Z');
    });

    it('queryTasks defaults to visible tasks and can include archived/deleted when requested', async () => {
        const { addTask, moveTask, deleteTask, queryTasks } = useTaskStore.getState();
        addTask('Visible task');
        addTask('Archived task');
        addTask('Deleted task');
        const allTasks = useTaskStore.getState()._allTasks;
        const archivedId = allTasks.find((task) => task.title === 'Archived task')?.id;
        const deletedId = allTasks.find((task) => task.title === 'Deleted task')?.id;

        if (!archivedId || !deletedId) throw new Error('Failed to seed tasks for query test');

        await moveTask(archivedId, 'archived');
        await deleteTask(deletedId);

        const visibleOnly = await queryTasks({});
        expect(visibleOnly.map((task) => task.title)).toContain('Visible task');
        expect(visibleOnly.map((task) => task.title)).not.toContain('Archived task');
        expect(visibleOnly.map((task) => task.title)).not.toContain('Deleted task');

        const withArchived = await queryTasks({ includeArchived: true });
        expect(withArchived.map((task) => task.title)).toContain('Archived task');

        const withDeleted = await queryTasks({ includeDeleted: true });
        expect(withDeleted.map((task) => task.title)).toContain('Deleted task');
    });

    it('restores deleted tasks without forcing status changes', async () => {
        const { addTask, deleteTask, restoreTask } = useTaskStore.getState();
        addTask('Keep Archived', { status: 'archived' });
        const taskId = useTaskStore.getState()._allTasks[0].id;

        await deleteTask(taskId);
        await restoreTask(taskId);

        const restored = useTaskStore.getState()._allTasks.find((task) => task.id === taskId);
        expect(restored?.deletedAt).toBeUndefined();
        expect(restored?.status).toBe('archived');
    });

    it('should coalesce saves and allow immediate flush', async () => {
        const { addTask } = useTaskStore.getState();

        // 1. Trigger a change
        addTask('Test Save');

        // 2. Flush pending save (should be safe even if already in-flight)
        await flushPendingSave();

        // Should have saved exactly once
        expect(mockStorage.saveData).toHaveBeenCalledTimes(1);
    });

    it('should persist the latest snapshot after rapid edits', async () => {
        const { addTask, addProject, updateTask } = useTaskStore.getState();

        addTask('Alpha');
        const taskId = useTaskStore.getState().tasks[0].id;
        const project = await addProject('Project Alpha', '#123456');
        expect(project).not.toBeNull();
        if (!project) return;

        updateTask(taskId, { title: 'Alpha Updated', projectId: project.id });
        await flushPendingSave();

        const saveCalls = (mockStorage.saveData as unknown as { mock: { calls: any[][] } }).mock.calls;
        const saved = saveCalls[saveCalls.length - 1]?.[0];
        expect(saved.projects).toHaveLength(1);
        expect(saved.tasks).toHaveLength(1);
        expect(saved.tasks[0].title).toBe('Alpha Updated');
        expect(saved.tasks[0].projectId).toBe(project.id);
    });

    it('retries failed saves with the latest queued snapshot', async () => {
        let rejectFirstSave: ((reason?: unknown) => void) | null = null;
        mockStorage.saveData = vi.fn().mockImplementation(() => {
            if (!rejectFirstSave) {
                return new Promise<void>((_, reject) => {
                    rejectFirstSave = reject;
                });
            }
            return Promise.resolve();
        });
        setStorageAdapter(mockStorage);

        const { addTask, updateTask } = useTaskStore.getState();
        addTask('Alpha');
        await Promise.resolve();

        const taskId = useTaskStore.getState().tasks[0].id;
        updateTask(taskId, { title: 'Alpha Updated' });
        expect(mockStorage.saveData).toHaveBeenCalledTimes(1);

        rejectFirstSave?.(new Error('disk full'));
        await Promise.resolve();

        await flushPendingSave();

        const saveCalls = (mockStorage.saveData as unknown as { mock: { calls: any[][] } }).mock.calls;
        expect(saveCalls.length).toBeGreaterThanOrEqual(2);
        const lastSaved = saveCalls[saveCalls.length - 1]?.[0];
        expect(lastSaved.tasks).toHaveLength(1);
        expect(lastSaved.tasks[0].title).toBe('Alpha Updated');
    });

    it('keeps flushing newer queued saves after a failed in-flight write', async () => {
        let rejectFirstSave: ((reason?: unknown) => void) | null = null;
        let callCount = 0;
        mockStorage.saveData = vi.fn().mockImplementation(() => {
            callCount += 1;
            if (callCount === 1) {
                return new Promise<void>((_, reject) => {
                    rejectFirstSave = reject;
                });
            }
            return Promise.resolve();
        });
        setStorageAdapter(mockStorage);

        const { addTask, updateTask } = useTaskStore.getState();
        addTask('Alpha');
        await Promise.resolve();

        const taskId = useTaskStore.getState().tasks[0].id;
        updateTask(taskId, { title: 'Alpha Updated' });
        expect(mockStorage.saveData).toHaveBeenCalledTimes(1);

        rejectFirstSave?.(new Error('disk full'));
        await waitForExpectation(() => {
            expect(mockStorage.saveData).toHaveBeenCalledTimes(2);
        });

        const saveCalls = (mockStorage.saveData as unknown as { mock: { calls: any[][] } }).mock.calls;
        const lastSaved = saveCalls[saveCalls.length - 1]?.[0];
        expect(lastSaved.tasks).toHaveLength(1);
        expect(lastSaved.tasks[0].title).toBe('Alpha Updated');
    });

    it('stops retrying after repeated terminal save failures', async () => {
        mockStorage.saveData = vi.fn().mockRejectedValue(new Error('disk full'));
        setStorageAdapter(mockStorage);

        const { addTask } = useTaskStore.getState();
        addTask('Unsaveable task');

        await vi.runAllTimersAsync();
        expect(mockStorage.saveData).toHaveBeenCalledTimes(5);
        expect(useTaskStore.getState().error).toContain('disk full');
    });

    it('should add a project', () => {
        const { addProject } = useTaskStore.getState();
        addProject('New Project', '#ff0000');

        const { projects } = useTaskStore.getState();
        expect(projects).toHaveLength(1);
        expect(projects[0].title).toBe('New Project');
        expect(projects[0].color).toBe('#ff0000');
    });

    it('should soft-delete areas and clear area references from projects/tasks', async () => {
        const { addArea, addProject, addTask, deleteArea } = useTaskStore.getState();
        const area = await addArea('Work');
        expect(area).not.toBeNull();
        if (!area) return;

        const project = await addProject('Area Project', '#123456', { areaId: area.id });
        expect(project).not.toBeNull();
        if (!project) return;
        addTask('Area Task', { areaId: area.id, status: 'next' });

        await deleteArea(area.id);

        const state = useTaskStore.getState();
        expect(state.areas).toHaveLength(0);
        const tombstone = state._allAreas.find((item) => item.id === area.id);
        expect(tombstone?.deletedAt).toBeTruthy();

        const updatedProject = state._allProjects.find((item) => item.id === project.id)!;
        expect(updatedProject.areaId).toBeUndefined();
        const updatedTask = state._allTasks.find((item) => item.title === 'Area Task')!;
        expect(updatedTask.areaId).toBeUndefined();
    });

    it('propagates area color updates to linked projects', async () => {
        const { addArea, addProject, updateArea } = useTaskStore.getState();
        const area = await addArea('Work', { color: '#3b82f6' });
        expect(area).not.toBeNull();
        if (!area) return;

        const project = await addProject('Area Project', '#3b82f6', { areaId: area.id });
        expect(project).not.toBeNull();
        if (!project) return;

        await updateArea(area.id, { color: '#ef4444' });

        const updatedProject = useTaskStore.getState()._allProjects.find((item) => item.id === project.id);
        expect(updatedProject?.color).toBe('#ef4444');
    });

    it('returns null when restoring a deleted area fails', async () => {
        const { addArea, deleteArea } = useTaskStore.getState();
        const area = await addArea('Work');
        expect(area).not.toBeNull();
        if (!area) return;

        await deleteArea(area.id);

        const originalUpdateArea = useTaskStore.getState().updateArea;
        useTaskStore.setState({
            updateArea: async () => {
                // Simulate a failed restore/update operation.
            },
        });

        const restored = await useTaskStore.getState().addArea('Work');
        expect(restored).toBeNull();
        expect(useTaskStore.getState().error).toBe('Failed to restore area');

        useTaskStore.setState({ updateArea: originalUpdateArea });
    });

    it('should move a project to someday without altering task status', () => {
        const { addProject, addTask, updateProject } = useTaskStore.getState();
        addProject('My Project', '#00ff00');

        const project = useTaskStore.getState().projects[0];
        addTask('Task 1', { status: 'next', projectId: project.id });
        addTask('Task 2', { status: 'waiting', projectId: project.id });

        updateProject(project.id, { status: 'someday' });

        const projectTasks = useTaskStore.getState()._allTasks.filter(t => t.projectId === project.id && !t.deletedAt);
        expect(projectTasks).toHaveLength(2);
        expect(projectTasks.map(t => t.status)).toEqual(['next', 'waiting']);
    });

    it('should archive a project, archive its active tasks, and archive its sections', async () => {
        const { addProject, addTask, addSection, updateProject } = useTaskStore.getState();
        addProject('Archived Project', '#123456');

        const project = useTaskStore.getState().projects[0];
        addTask('Task 1', { status: 'next', projectId: project.id });
        addTask('Task 2', { status: 'waiting', projectId: project.id });
        const section = await addSection(project.id, 'Section 1');
        expect(section).not.toBeNull();

        await updateProject(project.id, { status: 'archived' });

        const projectTasks = useTaskStore.getState()._allTasks.filter(t => t.projectId === project.id && !t.deletedAt);
        const projectSections = useTaskStore.getState()._allSections.filter((item) => item.projectId === project.id);
        expect(projectTasks).toHaveLength(2);
        expect(projectTasks.every(t => t.status === 'archived')).toBe(true);
        expect(projectSections).toHaveLength(1);
        expect(projectSections[0].deletedAt).toBeTruthy();
    });

    it('sets error when updateProject targets a missing project', () => {
        const { updateProject } = useTaskStore.getState();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        updateProject('missing-project-id', { status: 'active' });

        expect(useTaskStore.getState().error).toBe('Project not found');
        expect(warnSpy).toHaveBeenCalledWith('[mindwtr] updateProject skipped: missing-project-id was not found');
        warnSpy.mockRestore();
    });

    it('should roll a recurring task when completed', () => {
        const { addTask, moveTask } = useTaskStore.getState();
        addTask('Daily Task', {
            status: 'next',
            recurrence: 'daily',
            dueDate: '2023-01-01T09:00',
        });

        const original = useTaskStore.getState().tasks[0];
        moveTask(original.id, 'done');

        const state = useTaskStore.getState();
        expect(state._allTasks).toHaveLength(2);

        const completed = state._allTasks.find(t => t.id === original.id)!;
        expect(completed.status).toBe('done');
        expect(completed.completedAt).toBeTruthy();

        const nextInstance = state._allTasks.find(t => t.id !== original.id)!;
        expect(nextInstance.status).toBe('next');
        expect(nextInstance.recurrence).toBe('daily');
        expect(nextInstance.dueDate).toBe('2023-01-02T09:00');
    });

    it('should roll a fluid recurring task from completion date', () => {
        const { addTask, updateTask, moveTask } = useTaskStore.getState();
        addTask('Fluid Task', {
            status: 'next',
            recurrence: { rule: 'daily', strategy: 'fluid' },
            dueDate: '2023-01-01T09:00',
        });

        const original = useTaskStore.getState().tasks[0];
        updateTask(original.id, { dueDate: '2023-01-05T09:00' });
        moveTask(original.id, 'done');

        const state = useTaskStore.getState();
        const completed = state._allTasks.find(t => t.id === original.id)!;
        const nextInstance = state._allTasks.find(t => t.id !== original.id)!;

        expect(completed.completedAt).toBeTruthy();
        const completedAt = completed.completedAt!;
        const base = safeParseDate(completedAt) ?? new Date(completedAt);
        const expectedNext = addDays(base, 1).toISOString();
        expect(nextInstance.dueDate).toBe(expectedNext);
    });

    it('should increment pushCount when dueDate is pushed later', () => {
        const { addTask, updateTask } = useTaskStore.getState();
        addTask('Push Count', {
            status: 'next',
            dueDate: '2025-01-01T09:00:00.000Z',
        });

        const task = useTaskStore.getState().tasks[0];
        updateTask(task.id, { dueDate: '2025-01-02T09:00:00.000Z' });

        const updated = useTaskStore.getState()._allTasks.find(t => t.id === task.id)!;
        expect(updated.pushCount).toBe(1);

        updateTask(task.id, { dueDate: '2024-12-31T09:00:00.000Z' });
        const updatedEarlier = useTaskStore.getState()._allTasks.find(t => t.id === task.id)!;
        expect(updatedEarlier.pushCount).toBe(1);
    });

    describe('Sections', () => {
        it('should create, update, and delete sections with auto-ordering', async () => {
            const { addProject, addSection, updateSection, deleteSection, addTask } = useTaskStore.getState();
            const project = await addProject('Section Project', '#123456');
            expect(project).not.toBeNull();
            if (!project) return;

            const first = await addSection(project.id, 'Phase 1');
            const second = await addSection(project.id, 'Phase 2');

            expect(first).not.toBeNull();
            expect(second).not.toBeNull();
            expect(first?.order).toBe(0);
            expect(second?.order).toBe(1);

            if (!first) return;
            await updateSection(first.id, { title: 'Updated Phase' });
            const updated = useTaskStore.getState().sections.find((section) => section.id === first.id);
            expect(updated?.title).toBe('Updated Phase');

            await addTask('Section Task', { projectId: project.id, sectionId: first.id, status: 'next' });
            const task = useTaskStore.getState()._allTasks.find((item) => item.title === 'Section Task')!;
            expect(task.sectionId).toBe(first.id);

            await deleteSection(first.id);
            const clearedTask = useTaskStore.getState()._allTasks.find((item) => item.id === task.id)!;
            expect(clearedTask.sectionId).toBeUndefined();
            expect(useTaskStore.getState().sections.find((section) => section.id === first.id)).toBeUndefined();
        });

        it('should not create sections without a valid project or title', async () => {
            const { addProject, addSection } = useTaskStore.getState();
            const invalid = await addSection('missing-project', 'Section');
            expect(invalid).toBeNull();

            const project = await addProject('Valid Project', '#abcdef');
            expect(project).not.toBeNull();
            if (!project) return;
            const blank = await addSection(project.id, '   ');
            expect(blank).toBeNull();
            expect(useTaskStore.getState().sections).toHaveLength(0);
        });

        it('should clear sectionId when task moves to another project', async () => {
            const { addProject, addSection, addTask, updateTask } = useTaskStore.getState();
            const projectA = await addProject('Project A', '#111111');
            const projectB = await addProject('Project B', '#222222');
            expect(projectA).not.toBeNull();
            expect(projectB).not.toBeNull();
            if (!projectA || !projectB) return;
            const sectionA = await addSection(projectA.id, 'Section A');
            if (!sectionA) return;

            await addTask('Movable Task', { projectId: projectA.id, sectionId: sectionA.id, status: 'next' });
            const task = useTaskStore.getState()._allTasks.find((item) => item.title === 'Movable Task')!;
            expect(task.sectionId).toBe(sectionA.id);

            await updateTask(task.id, { projectId: projectB.id });
            const updated = useTaskStore.getState()._allTasks.find((item) => item.id === task.id)!;
            expect(updated.projectId).toBe(projectB.id);
            expect(updated.sectionId).toBeUndefined();
        });

        it('should clear sectionId when deleting a project', async () => {
            const { addProject, addSection, addTask, deleteProject } = useTaskStore.getState();
            const project = await addProject('Delete Project', '#333333');
            expect(project).not.toBeNull();
            if (!project) return;
            const section = await addSection(project.id, 'Cleanup');
            if (!section) return;

            await addTask('Project Task', { projectId: project.id, sectionId: section.id, status: 'next' });
            const task = useTaskStore.getState()._allTasks.find((item) => item.title === 'Project Task')!;
            expect(task.sectionId).toBe(section.id);

            await deleteProject(project.id);
            const deletedTask = useTaskStore.getState()._allTasks.find((item) => item.id === task.id)!;
            const deletedSection = useTaskStore.getState()._allSections.find((item) => item.id === section.id)!;
            expect(deletedTask.deletedAt).toBeTruthy();
            expect(deletedTask.sectionId).toBeUndefined();
            expect(deletedSection.deletedAt).toBeTruthy();
            expect(useTaskStore.getState().sections.find((item) => item.id === section.id)).toBeUndefined();
        });
    });
});
