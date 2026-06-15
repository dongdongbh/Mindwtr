import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { addDays } from 'date-fns';
import { safeParseDate } from './date';
import { useTaskStore, flushPendingSave, resetForTests, setStorageAdapter } from './store';
import { buildEntityMap } from './store-helpers';
import type { StorageAdapter } from './storage';
import type { Area, Project, Task } from './types';

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

const parseLoggedContext = (value: unknown): Record<string, unknown> => {
    expect(typeof value).toBe('string');
    return JSON.parse(String(value)) as Record<string, unknown>;
};

const createStoreTask = (id: string, overrides: Partial<Task> = {}): Task => ({
    id,
    title: `Task ${id}`,
    status: 'inbox',
    tags: [],
    contexts: [],
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    rev: 1,
    revBy: 'device-a',
    ...overrides,
});

const createStoreProject = (id: string, overrides: Partial<Project> = {}): Project => ({
    id,
    title: `Project ${id}`,
    status: 'active',
    color: '#2563EB',
    order: 0,
    tagIds: [],
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    rev: 1,
    revBy: 'device-a',
    ...overrides,
});

const createStoreArea = (id: string, overrides: Partial<Area> = {}): Area => ({
    id,
    name: `Area ${id}`,
    order: 0,
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    rev: 1,
    revBy: 'device-a',
    ...overrides,
});

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
    });

    afterEach(async () => {
        await flushPendingSave();
        resetForTests();
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

    it('should ignore reserved task fields when adding a task', async () => {
        const { addTask } = useTaskStore.getState();
        const result = await addTask('Safe Task', {
            id: 'custom-id',
            rev: 99,
            revBy: 'other-device',
            createdAt: '2000-01-01T00:00:00.000Z',
            updatedAt: '2000-01-01T00:00:00.000Z',
            deletedAt: '2000-01-02T00:00:00.000Z',
            purgedAt: '2000-01-03T00:00:00.000Z',
        });

        const task = useTaskStore.getState().tasks[0];
        expect(result.success).toBe(true);
        expect(result.id).toBe(task.id);
        expect(task.id).not.toBe('custom-id');
        expect(task.rev).toBe(1);
        expect(task.revBy).toBeTruthy();
        expect(task.revBy).not.toBe('other-device');
        expect(task.createdAt).not.toBe('2000-01-01T00:00:00.000Z');
        expect(task.updatedAt).not.toBe('2000-01-01T00:00:00.000Z');
        expect(task.deletedAt).toBeUndefined();
        expect(task.purgedAt).toBeUndefined();
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

    it('persists simple task updates through incremental task storage when available', async () => {
        const saveTask = vi.fn().mockResolvedValue(undefined);
        mockStorage.saveTask = saveTask;
        const task = createStoreTask('task-1', { status: 'next' });
        useTaskStore.setState({
            tasks: [task],
            _allTasks: [task],
            _tasksById: buildEntityMap([task]),
        });

        const result = await useTaskStore.getState().updateTask('task-1', { title: 'Updated Task' });

        expect(result).toEqual({ success: true });
        await waitForExpectation(() => {
            expect(saveTask).toHaveBeenCalledTimes(1);
        });
        expect(saveTask.mock.calls[0]?.[0]).toMatchObject({
            id: 'task-1',
            title: 'Updated Task',
        });
        expect(mockStorage.saveData).not.toHaveBeenCalled();
        await flushPendingSave();
        expect(mockStorage.saveData).not.toHaveBeenCalled();
    });

    it('waits for incremental task storage during flushPendingSave', async () => {
        let resolveSaveTask: (() => void) | null = null;
        const saveTask = vi.fn(() => new Promise<void>((resolve) => {
            resolveSaveTask = resolve;
        }));
        mockStorage.saveTask = saveTask;
        const task = createStoreTask('task-1', { status: 'next' });
        useTaskStore.setState({
            tasks: [task],
            _allTasks: [task],
            _tasksById: buildEntityMap([task]),
        });

        const result = await useTaskStore.getState().updateTask('task-1', { title: 'Updated Task' });
        expect(result).toEqual({ success: true });
        expect(saveTask).toHaveBeenCalledTimes(1);

        let flushed = false;
        const flushPromise = flushPendingSave().then(() => {
            flushed = true;
        });
        await Promise.resolve();
        expect(flushed).toBe(false);

        resolveSaveTask?.();
        await flushPromise;
        expect(flushed).toBe(true);
        expect(mockStorage.saveData).not.toHaveBeenCalled();
    });

    it('falls back to full snapshot storage when incremental task storage is unavailable', async () => {
        const task = createStoreTask('task-1', { status: 'next' });
        useTaskStore.setState({
            tasks: [task],
            _allTasks: [task],
            _tasksById: buildEntityMap([task]),
        });

        const result = await useTaskStore.getState().updateTask('task-1', { title: 'Updated Task' });

        expect(result).toEqual({ success: true });
        await flushPendingSave();
        expect(mockStorage.saveData).toHaveBeenCalledTimes(1);
    });

    it('rejects adding a task with a missing projectId', async () => {
        const result = await useTaskStore.getState().addTask('Broken Task', {
            projectId: 'missing-project',
        });

        expect(result).toEqual({ success: false, error: 'Project not found' });
        expect(useTaskStore.getState().tasks).toHaveLength(0);
    });

    it('rejects adding a task with a missing areaId', async () => {
        const result = await useTaskStore.getState().addTask('Broken Area Task', {
            areaId: 'missing-area',
        });

        expect(result).toEqual({ success: false, error: 'Area not found' });
        expect(useTaskStore.getState().tasks).toHaveLength(0);
    });

    it('infers projectId from a valid section when adding a task', async () => {
        const { addProject, addSection, addTask } = useTaskStore.getState();
        const project = await addProject('Section Project', '#123456');
        expect(project).not.toBeNull();
        if (!project) return;
        const section = await addSection(project.id, 'Phase 1');
        expect(section).not.toBeNull();
        if (!section) return;

        const result = await addTask('Section Scoped Task', {
            sectionId: section.id,
            status: 'next',
        });

        expect(result.success).toBe(true);
        const task = useTaskStore.getState()._allTasks.find((item) => item.id === result.id)!;
        expect(task.projectId).toBe(project.id);
        expect(task.sectionId).toBe(section.id);
    });

    it('rejects updating a task to a missing projectId', async () => {
        const { addTask, updateTask } = useTaskStore.getState();
        await addTask('Task to Reassign');
        const taskId = useTaskStore.getState().tasks[0].id;

        const result = await updateTask(taskId, { projectId: 'missing-project' });

        expect(result).toEqual({ success: false, error: 'Project not found' });
        expect(useTaskStore.getState()._allTasks.find((task) => task.id === taskId)?.projectId).toBeUndefined();
    });

    it('rejects assigning a task to a section from another project', async () => {
        const { addProject, addSection, addTask, updateTask } = useTaskStore.getState();
        const projectA = await addProject('Project A', '#111111');
        const projectB = await addProject('Project B', '#222222');
        expect(projectA).not.toBeNull();
        expect(projectB).not.toBeNull();
        if (!projectA || !projectB) return;
        const sectionA = await addSection(projectA.id, 'Section A');
        expect(sectionA).not.toBeNull();
        if (!sectionA) return;

        const addResult = await addTask('Cross Project Task', { projectId: projectB.id, status: 'next' });
        expect(addResult.success).toBe(true);
        if (!addResult.id) return;

        const result = await updateTask(addResult.id, {
            projectId: projectB.id,
            sectionId: sectionA.id,
        });

        expect(result).toEqual({ success: false, error: 'Section does not belong to project' });
        const task = useTaskStore.getState()._allTasks.find((item) => item.id === addResult.id)!;
        expect(task.projectId).toBe(projectB.id);
        expect(task.sectionId).toBeUndefined();
    });

    it('should clear action fields and preserve checklist data when a task becomes reference', () => {
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
        expect(updatedTask.checklist).toEqual([{ id: 'c1', title: 'Subtask', isCompleted: false }]);
        expect(updatedTask.isFocusedToday).toBe(false);
        expect(updatedTask.pushCount).toBe(0);
    });

    it('duplicates reference items into Inbox with checklist items reset', async () => {
        const { addTask, duplicateTask } = useTaskStore.getState();
        const addResult = await addTask('Reference Checklist', {
            status: 'reference',
            checklist: [
                { id: 'c1', title: 'Pack charger', isCompleted: true },
                { id: 'c2', title: 'Print agenda', isCompleted: false },
            ],
            attachments: [
                {
                    id: 'a1',
                    kind: 'file',
                    title: 'Agenda',
                    uri: '/tmp/agenda.pdf',
                    cloudKey: 'attachments/a1.pdf',
                    fileHash: 'hash-a1',
                    localStatus: 'available',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
        });
        expect(addResult.success).toBe(true);

        await duplicateTask(addResult.id!, false);

        const duplicatedTask = useTaskStore.getState()._allTasks.find((task) => (
            task.id !== addResult.id && task.title === 'Reference Checklist (Copy)'
        ));
        expect(duplicatedTask?.status).toBe('inbox');
        expect(duplicatedTask?.checklist?.map((item) => ({
            title: item.title,
            isCompleted: item.isCompleted,
        }))).toEqual([
            { title: 'Pack charger', isCompleted: false },
            { title: 'Print agenda', isCompleted: false },
        ]);
        expect(duplicatedTask?.checklist?.map((item) => item.id)).not.toEqual(['c1', 'c2']);
        expect(duplicatedTask?.attachments?.map((attachment) => ({
            id: attachment.id,
            title: attachment.title,
            uri: attachment.uri,
            cloudKey: attachment.cloudKey,
            fileHash: attachment.fileHash,
            localStatus: attachment.localStatus,
        }))).toEqual([
            {
                id: expect.not.stringMatching(/^a1$/),
                title: 'Agenda',
                uri: '/tmp/agenda.pdf',
                cloudKey: undefined,
                fileHash: undefined,
                localStatus: undefined,
            },
        ]);
    });

    it('rejects promoting a fourth task into today focus', async () => {
        const { addTask, updateTask } = useTaskStore.getState();

        const taskIds: string[] = [];
        for (const title of ['Focused 1', 'Focused 2', 'Focused 3', 'Focused 4']) {
            const result = await addTask(title, { status: 'next' });
            expect(result.success).toBe(true);
            expect(result.id).toBeTruthy();
            if (result.id) taskIds.push(result.id);
        }

        for (const taskId of taskIds.slice(0, 3)) {
            const result = await updateTask(taskId, { isFocusedToday: true });
            expect(result).toEqual({ success: true });
        }
        await flushPendingSave();
        (mockStorage.saveData as ReturnType<typeof vi.fn>).mockClear();

        const fourthResult = await updateTask(taskIds[3], { isFocusedToday: true });

        expect(fourthResult).toEqual({ success: false, error: 'Maximum of 3 focused tasks allowed' });
        const focusedTasks = useTaskStore.getState()._allTasks.filter((task) => task.isFocusedToday === true && !task.deletedAt);
        expect(focusedTasks).toHaveLength(3);
        expect(focusedTasks.map((task) => task.id)).toEqual(taskIds.slice(0, 3));
        expect(useTaskStore.getState()._allTasks.find((task) => task.id === taskIds[3])?.isFocusedToday).not.toBe(true);
        expect(useTaskStore.getState().error).toBe('Maximum of 3 focused tasks allowed');
        expect(mockStorage.saveData).not.toHaveBeenCalled();
    });

    it('uses the configured today focus limit when promoting tasks', async () => {
        const { addTask, updateSettings, updateTask } = useTaskStore.getState();
        await updateSettings({ gtd: { focusTaskLimit: 5 } });

        const taskIds: string[] = [];
        for (const title of ['Focused 1', 'Focused 2', 'Focused 3', 'Focused 4', 'Focused 5', 'Focused 6']) {
            const result = await addTask(title, { status: 'next' });
            expect(result.success).toBe(true);
            if (result.id) taskIds.push(result.id);
        }

        for (const taskId of taskIds.slice(0, 5)) {
            const result = await updateTask(taskId, { isFocusedToday: true });
            expect(result).toEqual({ success: true });
        }
        const sixthResult = await updateTask(taskIds[5], { isFocusedToday: true });

        expect(sixthResult).toEqual({ success: false, error: 'Maximum of 5 focused tasks allowed' });
        expect(useTaskStore.getState().getDerivedState().focusedCount).toBe(5);
    });

    it('applies focus eligibility and limit when adding focused tasks', async () => {
        const { addTask } = useTaskStore.getState();

        const focusedIds: string[] = [];
        for (const title of ['Focused 1', 'Focused 2', 'Focused 3']) {
            const result = await addTask(title, { status: 'next', isFocusedToday: true });
            expect(result.success).toBe(true);
            if (result.id) focusedIds.push(result.id);
        }

        const overLimit = await addTask('Over limit', { status: 'next', isFocusedToday: true });
        const unclarified = await addTask('Inbox focus request', { isFocusedToday: true });

        expect(overLimit.success).toBe(true);
        expect(unclarified.success).toBe(true);
        const state = useTaskStore.getState();
        expect(state.getDerivedState().focusedCount).toBe(3);
        expect(focusedIds.every((id) => state._tasksById.get(id)?.isFocusedToday === true)).toBe(true);
        expect(state._tasksById.get(overLimit.id ?? '')?.isFocusedToday).toBe(false);
        expect(state._tasksById.get(unclarified.id ?? '')?.isFocusedToday).toBe(false);
    });

    it('does not focus newly added sequential tasks blocked by an earlier action', async () => {
        const { addProject, addTask } = useTaskStore.getState();

        const projectResult = await addProject('Sequential project', '#2563EB', { isSequential: true });
        expect(projectResult).not.toBeNull();
        const projectId = projectResult!.id;
        const first = await addTask('First action', { status: 'next', projectId });
        const second = await addTask('Second action', { status: 'next', projectId, isFocusedToday: true });

        expect(first.success).toBe(true);
        expect(second.success).toBe(true);
        const state = useTaskStore.getState();
        expect(state._tasksById.get(second.id ?? '')?.isFocusedToday).toBe(false);
        expect(state.getDerivedState().focusedCount).toBe(0);
    });

    it('allows new focus promotion after focused tasks are completed or moved to reference', async () => {
        const { addTask, updateTask } = useTaskStore.getState();

        const taskIds: string[] = [];
        for (const title of ['Focused 1', 'Focused 2', 'Focused 3', 'Next active']) {
            const result = await addTask(title, { status: 'next' });
            expect(result.success).toBe(true);
            if (result.id) taskIds.push(result.id);
        }

        for (const taskId of taskIds.slice(0, 3)) {
            await expect(updateTask(taskId, { isFocusedToday: true })).resolves.toEqual({ success: true });
        }
        await expect(updateTask(taskIds[0], { status: 'done' })).resolves.toEqual({ success: true });
        await expect(updateTask(taskIds[1], { status: 'reference' })).resolves.toEqual({ success: true });

        const result = await updateTask(taskIds[3], { isFocusedToday: true });

        expect(result).toEqual({ success: true });
        expect(useTaskStore.getState().getDerivedState().focusedCount).toBe(2);
        expect(useTaskStore.getState()._tasksById.get(taskIds[3])?.isFocusedToday).toBe(true);
    });

    it('clears today focus when a focused task is deferred to a future start date', async () => {
        vi.setSystemTime(new Date('2026-05-02T10:00:00.000Z'));
        const { addTask, updateTask } = useTaskStore.getState();
        const result = await addTask('Focused later', { status: 'next', isFocusedToday: true });
        expect(result.success).toBe(true);
        const taskId = result.id;
        expect(taskId).toBeTruthy();

        await expect(updateTask(taskId!, { startTime: '2026-05-03' })).resolves.toEqual({ success: true });

        const task = useTaskStore.getState()._tasksById.get(taskId!);
        expect(task?.startTime).toBe('2026-05-03');
        expect(task?.isFocusedToday).toBe(false);
        expect(useTaskStore.getState().getDerivedState().focusedCount).toBe(0);
    });

    it('derives date-coherence issues from updateTask without auto-mutating dates', async () => {
        const { addTask, updateTask } = useTaskStore.getState();
        const result = await addTask('Conflicting dates', { status: 'next', dueDate: '2026-04-24' });
        expect(result.success).toBe(true);
        const taskId = result.id;
        expect(taskId).toBeTruthy();

        await expect(updateTask(taskId!, { startTime: '2026-04-25' })).resolves.toEqual({ success: true });

        const task = useTaskStore.getState()._tasksById.get(taskId!);
        expect(task?.startTime).toBe('2026-04-25');
        expect(task?.dueDate).toBe('2026-04-24');
        expect(useTaskStore.getState().getDerivedState().dateCoherenceIssuesByTaskId.get(taskId!)).toEqual([{
            code: 'start_after_due',
            field: 'startTime',
            relatedField: 'dueDate',
        }]);
    });

    it('stamps the GTD sync time when the focus limit changes', async () => {
        vi.setSystemTime(new Date('2026-03-21T12:00:00.000Z'));

        await useTaskStore.getState().updateSettings({ gtd: { focusTaskLimit: 5 } });

        expect(useTaskStore.getState().settings.syncPreferencesUpdatedAt?.gtd).toBe('2026-03-21T12:00:00.000Z');
    });

    it('stamps the GTD sync time when the Focus grouping changes', async () => {
        vi.setSystemTime(new Date('2026-03-21T12:00:00.000Z'));

        await useTaskStore.getState().updateSettings({ gtd: { focusGroupBy: 'project' } });

        expect(useTaskStore.getState().settings.syncPreferencesUpdatedAt?.gtd).toBe('2026-03-21T12:00:00.000Z');
    });

    it('prefers the renamed tag when deduplicating normalized tag collisions', async () => {
        const { addProject, addTask, renameTag } = useTaskStore.getState();

        const project = await addProject('Tagged Project', '#123456', {
            status: 'active',
            tagIds: ['BAR', 'foo'],
        });
        expect(project).not.toBeNull();
        if (!project) return;

        const taskResult = await addTask('Tagged Task', {
            status: 'next',
            projectId: project.id,
            tags: ['BAR', 'foo'],
        });
        expect(taskResult.success).toBe(true);
        expect(taskResult.id).toBeTruthy();
        if (!taskResult.id) return;

        await renameTag('foo', 'bar');

        const updatedTask = useTaskStore.getState()._allTasks.find((task) => task.id === taskResult.id);
        const updatedProject = useTaskStore.getState()._allProjects.find((item) => item.id === project.id);
        expect(updatedTask?.tags).toEqual(['#bar']);
        expect(updatedProject?.tagIds).toEqual(['#bar']);
    });

    it('allows case-only tag renames', async () => {
        const { addProject, addTask, renameTag } = useTaskStore.getState();

        const project = await addProject('Tagged Project', '#123456', {
            status: 'active',
            tagIds: ['#help'],
        });
        expect(project).not.toBeNull();
        if (!project) return;

        const taskResult = await addTask('Tagged Task', {
            status: 'next',
            projectId: project.id,
            tags: ['#help'],
        });
        expect(taskResult.success).toBe(true);
        expect(taskResult.id).toBeTruthy();
        if (!taskResult.id) return;

        await renameTag('#help', '#Help');

        const updatedTask = useTaskStore.getState()._allTasks.find((task) => task.id === taskResult.id);
        const updatedProject = useTaskStore.getState()._allProjects.find((item) => item.id === project.id);
        expect(updatedTask?.tags).toEqual(['#Help']);
        expect(updatedProject?.tagIds).toEqual(['#Help']);
    });

    it('allows case-only context renames', async () => {
        const { addTask, renameContext } = useTaskStore.getState();

        const taskResult = await addTask('Context Task', {
            status: 'next',
            contexts: ['@help'],
        });
        expect(taskResult.success).toBe(true);
        expect(taskResult.id).toBeTruthy();
        if (!taskResult.id) return;

        await renameContext('@help', '@Help');

        const updatedTask = useTaskStore.getState()._allTasks.find((task) => task.id === taskResult.id);
        expect(updatedTask?.contexts).toEqual(['@Help']);
    });

    it('filters soft-deleted attachments from visible tasks while preserving tombstones in _allTasks', async () => {
        vi.setSystemTime(new Date('2026-03-02T10:00:00.000Z'));
        const now = '2026-03-01T10:00:00.000Z';
        mockStorage.getData = vi.fn().mockResolvedValue({
            tasks: [
                {
                    id: 'task-with-attachments',
                    title: 'Task with attachments',
                    status: 'next',
                    attachments: [
                        {
                            id: 'keep',
                            kind: 'file',
                            title: 'Keep',
                            uri: 'file:///keep.txt',
                            createdAt: now,
                            updatedAt: now,
                        },
                        {
                            id: 'deleted',
                            kind: 'file',
                            title: 'Deleted',
                            uri: 'file:///deleted.txt',
                            createdAt: now,
                            updatedAt: now,
                            deletedAt: now,
                        },
                    ],
                    createdAt: now,
                    updatedAt: now,
                },
            ],
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        });

        await useTaskStore.getState().fetchData({ silent: true });
        await flushPendingSave();

        expect(useTaskStore.getState().tasks[0]?.attachments?.map((attachment) => attachment.id)).toEqual(['keep']);
        expect(useTaskStore.getState()._allTasks[0]?.attachments?.map((attachment) => attachment.id)).toEqual([
            'keep',
            'deleted',
        ]);
    });

    it('migrates uncustomized task editor layouts to lean defaults', async () => {
        mockStorage.getData = vi.fn().mockResolvedValue({
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
            settings: {
                gtd: {
                    taskEditor: {
                        hidden: [],
                        defaultsVersion: 4,
                    },
                },
            },
        });

        await useTaskStore.getState().fetchData({ silent: true });
        await flushPendingSave();

        const taskEditor = useTaskStore.getState().settings.gtd?.taskEditor;
        expect(taskEditor?.defaultsVersion).toBe(5);
        expect(taskEditor?.hidden).toEqual(expect.arrayContaining([
            'section',
            'priority',
            'energyLevel',
            'timeEstimate',
            'assignedTo',
            'location',
        ]));
        expect(taskEditor?.hidden).not.toEqual(expect.arrayContaining([
            'status',
            'project',
            'area',
            'contexts',
            'dueDate',
        ]));
    });

    it('should delete a task', () => {
        const { addTask, deleteTask } = useTaskStore.getState();
        addTask('Task to Delete');

        const task = useTaskStore.getState().tasks[0];
        deleteTask(task.id);

        const { tasks } = useTaskStore.getState();
        expect(tasks).toHaveLength(0);
    });

    it('auto-clears stale errors after ten seconds', () => {
        useTaskStore.getState().setError('Temporary failure');

        vi.advanceTimersByTime(10_000);

        expect(useTaskStore.getState().error).toBeNull();
    });

    it('keeps save queue overflow errors visible until dismissed', () => {
        useTaskStore.getState().setError(
            'Save queue overflow: dropped 1 queued save(s) (versions 1-1) while keeping versions 2-2.'
        );

        vi.advanceTimersByTime(10_000);

        expect(useTaskStore.getState().error).toBe(
            'Save queue overflow: dropped 1 queued save(s) (versions 1-1) while keeping versions 2-2.'
        );
    });

    it('does not replace a visible save queue overflow error with a transient error', () => {
        useTaskStore.getState().setError(
            'Save queue overflow: dropped 1 queued save(s) (versions 1-1) while keeping versions 2-2.'
        );

        useTaskStore.getState().setError('Temporary failure');
        vi.advanceTimersByTime(10_000);

        expect(useTaskStore.getState().error).toBe(
            'Save queue overflow: dropped 1 queued save(s) (versions 1-1) while keeping versions 2-2.'
        );
    });

    it('tracks filter changes as local data mutations', async () => {
        vi.setSystemTime(new Date('2026-03-21T12:00:00.000Z'));

        await useTaskStore.getState().updateSettings({
            filters: { areaId: 'area-2' },
        });

        const state = useTaskStore.getState();
        expect(state.settings.filters?.areaId).toBe('area-2');
        expect(state.lastDataChangeAt).toBe(new Date('2026-03-21T12:00:00.000Z').getTime());
    });

    it('merges appearance updates so density changes keep text size and task age', async () => {
        await useTaskStore.getState().updateSettings({
            appearance: {
                textSize: 'large',
                showTaskAge: true,
            },
        });

        await useTaskStore.getState().updateSettings({
            appearance: {
                density: 'compact',
            },
        });

        expect(useTaskStore.getState().settings.appearance).toEqual({
            textSize: 'large',
            showTaskAge: true,
            density: 'compact',
        });
    });

    it('tracks saved filter changes as synced local data mutations', async () => {
        vi.setSystemTime(new Date('2026-03-21T12:00:00.000Z'));

        await useTaskStore.getState().updateSettings({
            savedFilters: [{
                id: 'filter-1',
                name: 'Desk',
                view: 'focus',
                criteria: { contexts: ['@desk'] },
                createdAt: '2026-03-21T12:00:00.000Z',
                updatedAt: '2026-03-21T12:00:00.000Z',
            }],
        });

        const state = useTaskStore.getState();
        expect(state.settings.savedFilters?.[0]?.name).toBe('Desk');
        expect(state.settings.syncPreferencesUpdatedAt?.savedFilters).toBe('2026-03-21T12:00:00.000Z');
        expect(state.lastDataChangeAt).toBe(new Date('2026-03-21T12:00:00.000Z').getTime());
    });

    it('does not treat sync bookkeeping updates as local data mutations', async () => {
        useTaskStore.setState({ lastDataChangeAt: 123 });

        await useTaskStore.getState().updateSettings({
            lastSyncAt: '2026-03-21T12:00:00.000Z',
            lastSyncStatus: 'success',
            lastSyncError: undefined,
        });

        const state = useTaskStore.getState();
        expect(state.settings.lastSyncAt).toBe('2026-03-21T12:00:00.000Z');
        expect(state.settings.lastSyncStatus).toBe('success');
        expect(state.lastDataChangeAt).toBe(123);
    });

    it('keeps entity maps synchronized when a same-slot task update arrives via setState', () => {
        const first = createStoreTask('task-1');
        const second = createStoreTask('task-2');
        useTaskStore.setState({
            tasks: [first, second],
            _allTasks: [first, second],
        });

        const previousMap = useTaskStore.getState()._tasksById;
        const updatedFirst = createStoreTask('task-1', {
            title: 'Task task-1 updated',
            updatedAt: '2026-04-02T00:00:00.000Z',
            rev: 2,
        });
        useTaskStore.setState({
            tasks: [updatedFirst, second],
            _allTasks: [updatedFirst, second],
        });

        const state = useTaskStore.getState();
        expect(state._tasksById).not.toBe(previousMap);
        expect(state._tasksById.get(updatedFirst.id)).toBe(updatedFirst);
        expect(state._tasksById.get(second.id)).toBe(second);
    });

    it('removes deleted ids from entity maps when a collection shrinks via setState', () => {
        const visibleTask = createStoreTask('task-visible');
        const deletedTask = createStoreTask('task-deleted', {
            deletedAt: '2026-04-02T00:00:00.000Z',
        });
        useTaskStore.setState({
            tasks: [visibleTask],
            _allTasks: [visibleTask, deletedTask],
        });

        useTaskStore.setState({
            tasks: [visibleTask],
            _allTasks: [visibleTask],
        });

        const state = useTaskStore.getState();
        expect(state._tasksById.has(deletedTask.id)).toBe(false);
        expect(state._tasksById.get(visibleTask.id)).toBe(visibleTask);
    });

    it('preserves tombstones when production compat setState writes only visible tasks', () => {
        const originalNodeEnv = process.env.NODE_ENV;
        const visibleTask = createStoreTask('task-visible');
        const deletedTask = createStoreTask('task-deleted', {
            deletedAt: '2026-04-02T00:00:00.000Z',
        });
        useTaskStore.setState({
            tasks: [visibleTask],
            _allTasks: [visibleTask, deletedTask],
        });

        try {
            process.env.NODE_ENV = 'production';
            const updatedVisibleTask = createStoreTask('task-visible', {
                title: 'Updated visible task',
                updatedAt: '2026-04-03T00:00:00.000Z',
            });
            useTaskStore.setState({ tasks: [updatedVisibleTask] });

            const state = useTaskStore.getState();
            expect(state.tasks).toEqual([updatedVisibleTask]);
            expect(state._allTasks.map((task) => task.id).sort()).toEqual(['task-deleted', 'task-visible']);
            expect(state._tasksById.get('task-visible')).toBe(updatedVisibleTask);
            expect(state._tasksById.get('task-deleted')).toBe(deletedTask);
        } finally {
            process.env.NODE_ENV = originalNodeEnv;
        }
    });

    it('ignores visible-only production compat setState inserts when all tasks is empty', () => {
        const originalNodeEnv = process.env.NODE_ENV;
        const visibleTask = createStoreTask('task-visible');

        try {
            process.env.NODE_ENV = 'production';
            useTaskStore.setState({ tasks: [visibleTask] });

            const state = useTaskStore.getState();
            expect(state.tasks).toEqual([]);
            expect(state._allTasks).toEqual([]);
            expect(state._tasksById.has('task-visible')).toBe(false);
        } finally {
            process.env.NODE_ENV = originalNodeEnv;
        }
    });

    it('drops stale live tasks when production compat setState replaces visible tasks', () => {
        const originalNodeEnv = process.env.NODE_ENV;
        const previousVisibleTask = createStoreTask('task-previous');
        const nextVisibleTask = createStoreTask('task-next');
        const deletedTask = createStoreTask('task-deleted', {
            deletedAt: '2026-04-02T00:00:00.000Z',
        });
        useTaskStore.setState({
            tasks: [previousVisibleTask],
            _allTasks: [previousVisibleTask, deletedTask],
        });

        try {
            process.env.NODE_ENV = 'production';
            useTaskStore.setState({ tasks: [nextVisibleTask] });

            const state = useTaskStore.getState();
            expect(state.tasks).toEqual([nextVisibleTask]);
            expect(state._allTasks.map((task) => task.id).sort()).toEqual(['task-deleted', 'task-next']);
            expect(state._tasksById.has('task-previous')).toBe(false);
            expect(state._tasksById.get('task-next')).toBe(nextVisibleTask);
            expect(state._tasksById.get('task-deleted')).toBe(deletedTask);
        } finally {
            process.env.NODE_ENV = originalNodeEnv;
        }
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
        expect(useTaskStore.getState().settings.attachments?.pendingRemoteDeletes).toEqual([
            { cloudKey: 'attachments/doc.txt', title: 'doc.txt' },
        ]);
    });

    it('does not queue remote attachment delete while another task still references the cloud key', () => {
        const { addTask, deleteTask, purgeTask } = useTaskStore.getState();
        const sharedAttachment = {
            id: 'a-shared-1',
            kind: 'file' as const,
            title: 'shared.txt',
            uri: '/tmp/shared.txt',
            cloudKey: 'attachments/shared.txt',
            localStatus: 'available' as const,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        };
        addTask('First shared attachment', { attachments: [sharedAttachment] });
        addTask('Second shared attachment', {
            attachments: [{ ...sharedAttachment, id: 'a-shared-2' }],
        });

        const [firstTask, secondTask] = useTaskStore.getState()._allTasks;
        deleteTask(firstTask.id);
        purgeTask(firstTask.id);

        const state = useTaskStore.getState();
        expect(state.settings.attachments?.pendingRemoteDeletes).toBeUndefined();
        expect(state._allTasks.find((task) => task.id === firstTask.id)?.attachments?.[0]?.cloudKey).toBeUndefined();
        expect(state._allTasks.find((task) => task.id === secondTask.id)?.attachments?.[0]?.cloudKey).toBe('attachments/shared.txt');
    });

    it('does not queue remote attachment delete from purge-all while a live task still references the cloud key', () => {
        const { addTask, deleteTask, purgeDeletedTasks } = useTaskStore.getState();
        const sharedAttachment = {
            id: 'a-shared-1',
            kind: 'file' as const,
            title: 'shared.txt',
            uri: '/tmp/shared.txt',
            cloudKey: 'attachments/shared.txt',
            localStatus: 'available' as const,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        };
        addTask('Deleted shared attachment', { attachments: [sharedAttachment] });
        addTask('Live shared attachment', {
            attachments: [{ ...sharedAttachment, id: 'a-shared-2' }],
        });

        const [deletedTask, liveTask] = useTaskStore.getState()._allTasks;
        deleteTask(deletedTask.id);
        purgeDeletedTasks();

        const state = useTaskStore.getState();
        expect(state.settings.attachments?.pendingRemoteDeletes).toBeUndefined();
        expect(state._allTasks.find((task) => task.id === deletedTask.id)?.purgedAt).toBeTruthy();
        expect(state._allTasks.find((task) => task.id === liveTask.id)?.attachments?.[0]?.cloudKey).toBe('attachments/shared.txt');
    });

    it('queues remote attachment deletes when purging all deleted tasks', () => {
        const { addTask, deleteTask, purgeDeletedTasks } = useTaskStore.getState();
        addTask('First deleted attachment', {
            attachments: [
                {
                    id: 'a1',
                    kind: 'file',
                    title: 'first.txt',
                    uri: '/tmp/first.txt',
                    cloudKey: 'attachments/first.txt',
                    localStatus: 'available',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
        });
        addTask('Second deleted attachment', {
            attachments: [
                {
                    id: 'a2',
                    kind: 'file',
                    title: 'second.txt',
                    uri: '/tmp/second.txt',
                    cloudKey: 'attachments/second.txt',
                    localStatus: 'available',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
        });

        for (const task of useTaskStore.getState()._allTasks) {
            deleteTask(task.id);
        }
        purgeDeletedTasks();

        expect(useTaskStore.getState()._allTasks.every((task) => task.purgedAt)).toBe(true);
        expect(useTaskStore.getState().settings.attachments?.pendingRemoteDeletes).toEqual([
            { cloudKey: 'attachments/first.txt', title: 'first.txt' },
            { cloudKey: 'attachments/second.txt', title: 'second.txt' },
        ]);
    });

    it('skips fetch while edits are in progress', async () => {
        const { lockEditing, unlockEditing, fetchData } = useTaskStore.getState();
        lockEditing();
        await fetchData({ silent: true });
        expect(mockStorage.getData).not.toHaveBeenCalled();
        unlockEditing();
    });

    it('keeps specific fetch failure details in store error state', async () => {
        mockStorage.getData = vi.fn().mockRejectedValue(new Error('Database needs repair'));

        await useTaskStore.getState().fetchData({ silent: true });

        expect(useTaskStore.getState().error).toBe('Failed to fetch data: Database needs repair');
    });

    it('preserves duplicate active area names in current-version data during fetch', async () => {
        const nowIso = '2026-06-12T12:00:00.000Z';
        vi.setSystemTime(new Date(nowIso));
        const areaA = createStoreArea('area-a', { name: 'Work', order: 0 });
        const areaB = createStoreArea('area-b', {
            name: 'Work',
            order: 1,
            createdAt: '2026-04-02T00:00:00.000Z',
            updatedAt: '2026-04-02T00:00:00.000Z',
        });
        mockStorage.getData = vi.fn().mockResolvedValue({
            tasks: [],
            projects: [],
            sections: [],
            areas: [areaA, areaB],
            people: [],
            settings: {
                deviceId: 'device-a',
                migrations: {
                    version: 9999,
                    lastAutoArchiveAt: nowIso,
                    lastTombstoneCleanupAt: nowIso,
                },
                gtd: {
                    taskEditor: {
                        defaultsVersion: 9999,
                    },
                },
            },
        });

        await useTaskStore.getState().fetchData({ silent: true });
        await flushPendingSave();

        expect(useTaskStore.getState()._allAreas.map((area) => area.id)).toEqual(['area-a', 'area-b']);
        expect(mockStorage.saveData).not.toHaveBeenCalled();
    });

    it('does not overwrite local task edits made during an in-flight fetch', async () => {
        const persistedData = {
            tasks: [
                {
                    id: 'task-1',
                    title: 'Original title',
                    status: 'next',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-03-22T10:00:00.000Z',
                    updatedAt: '2026-03-22T10:00:00.000Z',
                },
            ],
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        };
        let resolveFetch: ((value: typeof persistedData) => void) | null = null;
        mockStorage.getData = vi.fn()
            .mockResolvedValue(persistedData)
            .mockResolvedValueOnce(persistedData)
            .mockImplementationOnce(
                () =>
                    new Promise<typeof persistedData>((resolve) => {
                        resolveFetch = resolve;
                    })
            );

        await useTaskStore.getState().fetchData({ silent: true });

        const slowFetch = useTaskStore.getState().fetchData({ silent: true });
        await waitForExpectation(() => {
            expect(mockStorage.getData).toHaveBeenCalledTimes(2);
        });

        await useTaskStore.getState().updateTask('task-1', { title: 'Edited during sync' });
        resolveFetch?.(persistedData);
        await slowFetch;
        await flushPendingSave();

        const currentTask = useTaskStore.getState()._allTasks.find((task) => task.id === 'task-1');
        expect(currentTask?.title).toBe('Edited during sync');

        const saveCalls = (mockStorage.saveData as unknown as { mock: { calls: any[][] } }).mock.calls;
        const lastSaved = saveCalls[saveCalls.length - 1]?.[0];
        expect(lastSaved?.tasks?.[0]?.title).toBe('Edited during sync');
    });

    it('does not overwrite same-millisecond task completions made during an in-flight fetch', async () => {
        const fixedNow = new Date('2026-03-22T10:00:00.000Z').getTime();
        vi.setSystemTime(fixedNow);
        const persistedData = {
            tasks: [
                {
                    id: 'task-1',
                    title: 'Complete during sync',
                    status: 'next',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-03-22T09:00:00.000Z',
                    updatedAt: '2026-03-22T09:00:00.000Z',
                },
            ],
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        };
        let resolveFetch: ((value: typeof persistedData) => void) | null = null;
        mockStorage.getData = vi.fn()
            .mockResolvedValueOnce(persistedData)
            .mockImplementationOnce(
                () =>
                    new Promise<typeof persistedData>((resolve) => {
                        resolveFetch = resolve;
                    })
            );

        await useTaskStore.getState().fetchData({ silent: true });
        useTaskStore.setState({ lastDataChangeAt: fixedNow });

        const slowFetch = useTaskStore.getState().fetchData({ silent: true });
        await waitForExpectation(() => {
            expect(mockStorage.getData).toHaveBeenCalledTimes(2);
        });

        await useTaskStore.getState().updateTask('task-1', { status: 'done' });
        expect(useTaskStore.getState().lastDataChangeAt).toBeGreaterThan(fixedNow);
        resolveFetch?.(persistedData);
        await slowFetch;
        await flushPendingSave();

        const currentTask = useTaskStore.getState()._allTasks.find((task) => task.id === 'task-1');
        expect(currentTask?.status).toBe('done');
        expect(currentTask?.completedAt).toBe('2026-03-22T10:00:00.000Z');

        const saveCalls = (mockStorage.saveData as unknown as { mock: { calls: any[][] } }).mock.calls;
        const lastSaved = saveCalls[saveCalls.length - 1]?.[0];
        expect(lastSaved?.tasks?.[0]?.status).toBe('done');
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

    it('clears project archive metadata from deleted task tombstones during fetch', async () => {
        const archivedAt = '2026-05-10T00:00:00.000Z';
        mockStorage.getData = vi.fn().mockResolvedValue({
            tasks: [
                {
                    id: 't-deleted-archive',
                    title: 'Deleted archive tombstone',
                    status: 'done',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-05-01T00:00:00.000Z',
                    updatedAt: archivedAt,
                    deletedAt: '2026-05-11T00:00:00.000Z',
                    completedAt: archivedAt,
                    statusBeforeProjectArchive: 'next',
                    completedAtBeforeProjectArchive: null,
                    isFocusedTodayBeforeProjectArchive: false,
                    projectArchivedAt: archivedAt,
                    rev: 4,
                    revBy: 'device-a',
                },
            ],
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        });

        await useTaskStore.getState().fetchData({ silent: true });
        await flushPendingSave();

        const task = useTaskStore.getState()._allTasks[0];
        expect(task.statusBeforeProjectArchive).toBeUndefined();
        expect(task.completedAtBeforeProjectArchive).toBeUndefined();
        expect(task.isFocusedTodayBeforeProjectArchive).toBeUndefined();
        expect(task.projectArchivedAt).toBeUndefined();
        expect(task.rev).toBe(4);
        expect(task.updatedAt).toBe(archivedAt);

        const saveCalls = (mockStorage.saveData as unknown as { mock: { calls: any[][] } }).mock.calls;
        const lastSaved = saveCalls[saveCalls.length - 1]?.[0];
        expect(lastSaved?.tasks?.[0]?.projectArchivedAt).toBeUndefined();
        expect(lastSaved?.tasks?.[0]?.statusBeforeProjectArchive).toBeUndefined();
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

    it('auto-archives stale completed tasks during fetch', async () => {
        vi.setSystemTime(new Date('2026-04-10T12:00:00.000Z'));
        const staleTask = createStoreTask('task-stale', {
            status: 'done',
            completedAt: '2026-03-01T12:00:00.000Z',
            updatedAt: '2026-03-01T12:00:00.000Z',
        });
        const recentTask = createStoreTask('task-recent', {
            status: 'done',
            completedAt: '2026-04-09T12:00:00.000Z',
            updatedAt: '2026-04-09T12:00:00.000Z',
        });
        mockStorage.getData = vi.fn().mockResolvedValue({
            tasks: [staleTask, recentTask],
            projects: [],
            sections: [],
            areas: [],
            settings: {
                deviceId: 'device-a',
                gtd: { autoArchiveDays: 7 },
                migrations: { lastAutoArchiveAt: '2026-03-01T00:00:00.000Z' },
            },
        });

        await useTaskStore.getState().fetchData({ silent: true });
        await flushPendingSave();

        const byId = new Map(useTaskStore.getState()._allTasks.map((task) => [task.id, task]));
        expect(byId.get('task-stale')?.status).toBe('archived');
        expect(byId.get('task-stale')?.rev).toBe(2);
        expect(byId.get('task-stale')?.revBy).toBe('device-a');
        expect(byId.get('task-recent')?.status).toBe('done');
        expect(useTaskStore.getState().tasks.some((task) => task.id === 'task-stale')).toBe(false);
        expect(mockStorage.saveData).toHaveBeenCalled();
    });

    it('auto-archives stale completed tasks when archive days change', async () => {
        vi.setSystemTime(new Date('2026-04-10T12:00:00.000Z'));
        const staleTask = createStoreTask('task-stale', {
            status: 'done',
            completedAt: '2026-03-01T12:00:00.000Z',
            updatedAt: '2026-03-01T12:00:00.000Z',
        });
        useTaskStore.setState({
            tasks: [staleTask],
            _allTasks: [staleTask],
            settings: {
                deviceId: 'device-a',
                gtd: { autoArchiveDays: 30 },
            },
            lastDataChangeAt: 0,
        });

        await useTaskStore.getState().updateSettings({
            gtd: { autoArchiveDays: 7 },
        });
        await flushPendingSave();

        const archivedTask = useTaskStore.getState()._allTasks.find((task) => task.id === staleTask.id);
        expect(archivedTask?.status).toBe('archived');
        expect(archivedTask?.rev).toBe(2);
        expect(archivedTask?.revBy).toBe('device-a');
        expect(useTaskStore.getState().tasks.some((task) => task.id === staleTask.id)).toBe(false);
        expect(useTaskStore.getState().lastDataChangeAt).toBe(new Date('2026-04-10T12:00:00.000Z').getTime());
        expect(mockStorage.saveData).toHaveBeenCalled();
    });

    it('marks active tasks that belong to archived projects as done during fetch', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-02-14T10:00:00.000Z').getTime());
        mockStorage.getData = vi.fn().mockResolvedValue({
            tasks: [
                {
                    id: 't-linked',
                    title: 'Should be completed',
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
        expect(linkedTask?.status).toBe('done');
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

    it('leaves first install data empty until the user starts fresh', async () => {
        mockStorage.getData = vi.fn().mockResolvedValue({
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        });

        await useTaskStore.getState().fetchData({ silent: true });
        await flushPendingSave();

        const state = useTaskStore.getState();
        expect(state.projects).toHaveLength(0);
        expect(state.tasks).toHaveLength(0);

        const saveCalls = (mockStorage.saveData as unknown as { mock: { calls: any[][] } }).mock.calls;
        const saved = saveCalls[saveCalls.length - 1]?.[0];
        expect(saved?.projects).toHaveLength(0);
        expect(saved?.tasks).toHaveLength(0);
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
        expect(useTaskStore.getState().projects).toHaveLength(0);
    });

    it('does not seed getting started data when existing settings are present', async () => {
        mockStorage.getData = vi.fn().mockResolvedValue({
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
            settings: { theme: 'dark' },
        });

        await useTaskStore.getState().fetchData({ silent: true });

        expect(useTaskStore.getState().tasks).toHaveLength(0);
        expect(useTaskStore.getState().projects).toHaveLength(0);
    });

    it('can seed getting started data on demand without duplicating it', async () => {
        const firstResult = await useTaskStore.getState().seedGettingStarted();
        await flushPendingSave();

        expect(firstResult.success).toBe(true);
        expect(firstResult.id).toBeTruthy();
        expect(useTaskStore.getState().projects.map((project) => project.title)).toEqual(['Getting Started']);
        expect(useTaskStore.getState().tasks).toHaveLength(8);
        const state = useTaskStore.getState();
        const starterTasks = state.tasks
            .filter((task) => task.projectId === firstResult.id)
            .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
        expect(starterTasks.map((task) => task.title)).toEqual([
            'Start here: process your first inbox item',
            'Try quick capture with a context and date',
            "Star up to 3 tasks for Today's Focus",
            'Set up sync across your devices',
            'Import tasks from another app',
            'Run your first weekly review',
        ]);
        expect(starterTasks.every((task) => task.status === 'next')).toBe(true);
        expect(starterTasks.every((task) => task.taskMode === 'list')).toBe(true);
        expect(starterTasks.every((task) => task.checklist?.length === 3)).toBe(true);
        expect(starterTasks[0].checklist?.map((item) => item.title)).toEqual([
            'Open Inbox',
            'Tap Process Inbox',
            'Clarify one sample item into a next action or project',
        ]);
        expect(starterTasks[3].checklist?.map((item) => item.title)).toContain('Open Settings -> Sync');
        expect(starterTasks[2].isFocusedToday).toBe(true);
        const sampleInboxTasks = state.tasks
            .filter((task) => task.status === 'inbox')
            .map((task) => task.title)
            .sort();
        expect(sampleInboxTasks).toEqual(['Buy milk', 'Reply to Sam']);

        const secondResult = await useTaskStore.getState().seedGettingStarted();
        await flushPendingSave();

        expect(secondResult).toEqual(firstResult);
        expect(useTaskStore.getState().projects.map((project) => project.title)).toEqual(['Getting Started']);
        expect(useTaskStore.getState().tasks).toHaveLength(8);
    });

    it('backfills missing getting started tasks into an existing empty project', async () => {
        const existingProject = createStoreProject('starter-project', {
            title: 'Getting Started',
        });
        useTaskStore.setState({
            projects: [existingProject],
            _allProjects: [existingProject],
        });

        const result = await useTaskStore.getState().seedGettingStarted();
        await flushPendingSave();

        expect(result).toEqual({ success: true, id: existingProject.id });
        expect(useTaskStore.getState().projects.map((project) => project.title)).toEqual(['Getting Started']);
        expect(useTaskStore.getState().tasks).toHaveLength(8);
        expect(
            useTaskStore.getState().tasks
                .filter((task) => task.projectId === existingProject.id)
                .map((task) => task.title)
        ).toEqual([
            'Start here: process your first inbox item',
            'Try quick capture with a context and date',
            "Star up to 3 tasks for Today's Focus",
            'Set up sync across your devices',
            'Import tasks from another app',
            'Run your first weekly review',
        ]);
    });

    it('repairs duplicated getting started lessons from older seed copy', async () => {
        const existingProject = createStoreProject('starter-project', {
            title: 'Getting Started',
        });
        const legacyProcessTask = createStoreTask('legacy-process', {
            title: 'Process your first inbox item',
            status: 'next',
            projectId: existingProject.id,
            order: 0,
            orderNum: 0,
        });
        const currentProcessTask = createStoreTask('current-process', {
            title: 'Start here: process your first inbox item',
            status: 'next',
            taskMode: 'list',
            projectId: existingProject.id,
            order: 1,
            orderNum: 1,
            checklist: [
                { id: 'check-1', title: 'Open Inbox', isCompleted: true },
            ],
        });
        useTaskStore.setState({
            tasks: [legacyProcessTask, currentProcessTask],
            projects: [existingProject],
            _allTasks: [legacyProcessTask, currentProcessTask],
            _allProjects: [existingProject],
        });

        const result = await useTaskStore.getState().seedGettingStarted();
        await flushPendingSave();

        expect(result).toEqual({ success: true, id: existingProject.id });
        const visibleStarterTasks = useTaskStore.getState().tasks
            .filter((task) => task.projectId === existingProject.id)
            .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
        expect(visibleStarterTasks.map((task) => task.title)).toEqual([
            'Start here: process your first inbox item',
            'Try quick capture with a context and date',
            "Star up to 3 tasks for Today's Focus",
            'Set up sync across your devices',
            'Import tasks from another app',
            'Run your first weekly review',
        ]);
        expect(visibleStarterTasks.filter((task) => task.title === 'Start here: process your first inbox item')).toHaveLength(1);
        expect(visibleStarterTasks[0].checklist?.[0]?.isCompleted).toBe(true);
        expect(visibleStarterTasks.every((task) => task.checklist?.length === 3)).toBe(true);
        expect(useTaskStore.getState()._allTasks.find((task) => task.id === legacyProcessTask.id)?.deletedAt).toBeTruthy();
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

    it('purges deleted tasks while deriving the visible task slice from all tasks', async () => {
        const archivedTask = {
            id: 'archived-visible',
            title: 'Archived Visible Task',
            status: 'archived' as const,
            tags: [],
            contexts: [],
            createdAt: '2026-04-01T00:00:00.000Z',
            updatedAt: '2026-04-01T00:00:00.000Z',
        };
        const deletedTask = {
            id: 'deleted-task',
            title: 'Deleted Task',
            status: 'inbox' as const,
            tags: [],
            contexts: [],
            createdAt: '2026-04-01T00:00:00.000Z',
            updatedAt: '2026-04-01T00:00:00.000Z',
            deletedAt: '2026-04-01T00:00:00.000Z',
        };

        useTaskStore.setState({
            tasks: [archivedTask],
            _allTasks: [archivedTask, deletedTask],
        });

        await useTaskStore.getState().purgeDeletedTasks();

        expect(useTaskStore.getState().tasks).toEqual([]);
        expect(useTaskStore.getState()._allTasks.find((task) => task.id === archivedTask.id)).toEqual(archivedTask);
        expect(useTaskStore.getState()._allTasks.find((task) => task.id === deletedTask.id)?.purgedAt).toBeTruthy();
    });

    it('does not re-purge tasks that already have a tombstone purge marker', async () => {
        const alreadyPurgedTask = createStoreTask('purged-task', {
            deletedAt: '2026-04-01T00:00:00.000Z',
            purgedAt: '2026-04-02T00:00:00.000Z',
            updatedAt: '2026-04-03T00:00:00.000Z',
            rev: 7,
        });

        useTaskStore.setState({
            tasks: [],
            _allTasks: [alreadyPurgedTask],
        });

        await useTaskStore.getState().purgeDeletedTasks();

        expect(useTaskStore.getState()._allTasks).toEqual([alreadyPurgedTask]);
    });

    it('keeps the task lookup aligned when purging deleted tasks', async () => {
        const visibleTask = createStoreTask('visible-task');
        const deletedTask = createStoreTask('deleted-task', {
            deletedAt: '2026-04-01T00:00:00.000Z',
        });

        useTaskStore.setState({
            tasks: [visibleTask],
            _allTasks: [visibleTask, deletedTask],
            _tasksById: buildEntityMap([visibleTask, deletedTask]),
        });
        const previousMap = useTaskStore.getState()._tasksById;

        await useTaskStore.getState().purgeDeletedTasks();

        const state = useTaskStore.getState();
        const purgedTask = state._allTasks.find((task) => task.id === deletedTask.id);
        expect(purgedTask?.purgedAt).toBeTruthy();
        expect(state._tasksById).not.toBe(previousMap);
        expect(state._tasksById.get(deletedTask.id)).toBe(purgedTask);
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

    it('defers automatic persistence so UI updates can paint first', async () => {
        const { addTask } = useTaskStore.getState();

        addTask('Deferred Save');
        await Promise.resolve();

        expect(mockStorage.saveData).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(120);
        await waitForExpectation(() => {
            expect(mockStorage.saveData).toHaveBeenCalledTimes(1);
        });
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

    it('logs dropped save versions when the pending queue overflows', async () => {
        let resolveFirstSave: (() => void) | null = null;
        mockStorage.saveData = vi.fn().mockImplementation(() => {
            if (!resolveFirstSave) {
                return new Promise<void>((resolve) => {
                    resolveFirstSave = resolve;
                });
            }
            return Promise.resolve();
        });
        setStorageAdapter(mockStorage);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const { addTask, updateTask } = useTaskStore.getState();
        await addTask('Overflow Task');
        await Promise.resolve();

        const taskId = useTaskStore.getState()._allTasks[0].id;
        for (let index = 0; index < 110; index += 1) {
            await updateTask(taskId, { title: `Overflow Task ${index}` });
        }

        expect(useTaskStore.getState().error).toContain('Save queue overflow');
        expect(useTaskStore.getState().error).toContain('versions');
        const overflowCall = warnSpy.mock.calls.find(([message]) => message === 'Save queue overflow');
        expect(overflowCall).toBeTruthy();
        const [, overflowMeta] = overflowCall ?? [];
        expect(overflowMeta).toEqual(
            expect.objectContaining({
                scope: 'store',
                category: 'storage',
                context: expect.any(String),
            })
        );
        expect(parseLoggedContext(overflowMeta?.context)).toEqual(
            expect.objectContaining({
                droppedCount: expect.any(Number),
                droppedFromVersion: expect.any(Number),
                droppedToVersion: expect.any(Number),
            })
        );

        const flushPromise = flushPendingSave();
        await waitForExpectation(() => {
            expect(mockStorage.saveData).toHaveBeenCalledTimes(1);
        });
        resolveFirstSave?.();
        await flushPromise;
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

        const flushPromise = flushPendingSave();
        await waitForExpectation(() => {
            expect(mockStorage.saveData).toHaveBeenCalledTimes(1);
        });
        rejectFirstSave?.(new Error('disk full'));
        await vi.advanceTimersByTimeAsync(250);
        await flushPromise;

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
        const flushPromise = flushPendingSave();
        await waitForExpectation(() => {
            expect(mockStorage.saveData).toHaveBeenCalledTimes(1);
        });

        const taskId = useTaskStore.getState().tasks[0].id;
        updateTask(taskId, { title: 'Alpha Updated' });

        rejectFirstSave?.(new Error('disk full'));
        await flushPromise;
        expect(mockStorage.saveData).toHaveBeenCalledTimes(2);

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

        await vi.advanceTimersByTimeAsync(4_000);
        expect(mockStorage.saveData).toHaveBeenCalledTimes(5);
        expect(useTaskStore.getState().error).toContain('disk full');

        await vi.advanceTimersByTimeAsync(10_000);
        expect(useTaskStore.getState().error).toBeNull();
    });

    it('should add a project', () => {
        const { addProject } = useTaskStore.getState();
        addProject('New Project', '#ff0000');

        const { projects } = useTaskStore.getState();
        expect(projects).toHaveLength(1);
        expect(projects[0].title).toBe('New Project');
        expect(projects[0].color).toBe('#ff0000');
    });

    it('uses the configured default project flow mode for new projects', async () => {
        const { addProject, updateSettings } = useTaskStore.getState();
        await updateSettings({ gtd: { defaultProjectFlowMode: 'sequential' } });

        const defaultedProject = await addProject('Sequential Project', '#ff0000');
        const explicitParallelProject = await addProject('Parallel Project', '#00ff00', { isSequential: false });

        expect(defaultedProject?.isSequential).toBe(true);
        expect(explicitParallelProject?.isSequential).toBe(false);
    });

    it('should soft-delete areas and unassign linked projects/tasks', async () => {
        const { addArea, addProject, addSection, addTask, deleteArea } = useTaskStore.getState();
        const area = await addArea('Work');
        expect(area).not.toBeNull();
        if (!area) return;

        const project = await addProject('Area Project', '#123456', { areaId: area.id, areaTitle: 'Work' });
        expect(project).not.toBeNull();
        if (!project) return;
        const section = await addSection(project.id, 'Planning');
        expect(section).not.toBeNull();
        if (!section) return;
        await addTask('Area Task', { areaId: area.id, status: 'next' });
        await addTask('Project Task', { projectId: project.id, sectionId: section.id, status: 'next' });

        await deleteArea(area.id);

        const state = useTaskStore.getState();
        expect(state.areas).toHaveLength(0);
        expect(state.projects).toHaveLength(1);
        expect(state.sections).toHaveLength(1);
        expect(state.tasks).toHaveLength(2);
        const tombstone = state._allAreas.find((item) => item.id === area.id);
        expect(tombstone?.deletedAt).toBeTruthy();

        const updatedProject = state._allProjects.find((item) => item.id === project.id)!;
        expect(updatedProject.deletedAt).toBeUndefined();
        expect(updatedProject.areaId).toBeUndefined();
        expect(updatedProject.areaTitle).toBeUndefined();
        const updatedSection = state._allSections.find((item) => item.id === section.id)!;
        expect(updatedSection.deletedAt).toBeUndefined();
        const updatedTask = state._allTasks.find((item) => item.title === 'Area Task')!;
        expect(updatedTask.deletedAt).toBeUndefined();
        expect(updatedTask.areaId).toBeUndefined();
        const updatedProjectTask = state._allTasks.find((item) => item.title === 'Project Task')!;
        expect(updatedProjectTask.deletedAt).toBeUndefined();
        expect(updatedProjectTask.projectId).toBe(project.id);
    });

    it('restores a deleted area without reassigning unassigned children', async () => {
        const { addArea, addProject, addSection, addTask, deleteArea, restoreArea } = useTaskStore.getState();
        const area = await addArea('Work');
        expect(area).not.toBeNull();
        if (!area) return;
        const project = await addProject('Area Project', '#123456', { areaId: area.id });
        expect(project).not.toBeNull();
        if (!project) return;
        const section = await addSection(project.id, 'Planning');
        expect(section).not.toBeNull();
        if (!section) return;
        await addTask('Area Task', { areaId: area.id, status: 'next' });
        await addTask('Project Task', { projectId: project.id, sectionId: section.id, status: 'next' });

        await deleteArea(area.id);

        const result = await restoreArea(area.id);
        expect(result).toEqual({ success: true });

        const state = useTaskStore.getState();
        const restored = state.areas.find((item) => item.id === area.id);
        expect(restored?.deletedAt).toBeUndefined();
        const restoredProject = state.projects.find((item) => item.id === project.id);
        expect(restoredProject?.areaId).toBeUndefined();
        expect(restoredProject?.deletedAt).toBeUndefined();
        expect(state.sections.find((item) => item.id === section.id)?.deletedAt).toBeUndefined();
        expect(state.tasks.find((item) => item.title === 'Area Task')?.areaId).toBeUndefined();
        const projectTask = state.tasks.find((item) => item.title === 'Project Task');
        expect(projectTask?.projectId).toBe(project.id);
        expect(projectTask?.sectionId).toBe(section.id);
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

        const originalRestoreArea = useTaskStore.getState().restoreArea;
        useTaskStore.setState({
            restoreArea: async () => ({ success: false, error: 'Failed to restore area' }),
        });

        try {
            const restored = await useTaskStore.getState().addArea('Work');
            expect(restored).toBeNull();
            expect(useTaskStore.getState().error).toBe('Failed to restore area');
        } finally {
            useTaskStore.setState({ restoreArea: originalRestoreArea });
        }
    });

    it('returns action failure when updateArea targets a missing area', async () => {
        const result = await useTaskStore.getState().updateArea('missing-area', { color: '#ef4444' });

        expect(result).toEqual({ success: false, error: 'Area not found' });
        expect(useTaskStore.getState().error).toBe('Area not found');
    });

    it('returns action failure when updateArea receives a blank name', async () => {
        const area = await useTaskStore.getState().addArea('Work');

        expect(area).not.toBeNull();

        const result = await useTaskStore.getState().updateArea(area!.id, { name: '   ' });

        expect(result).toEqual({ success: false, error: 'Area name is required' });
        expect(useTaskStore.getState().error).toBe('Area name is required');
        expect(useTaskStore.getState()._allAreas.find((item) => item.id === area!.id)?.name).toBe('Work');
    });

    it('returns action failure when deleteArea targets a missing area', async () => {
        const result = await useTaskStore.getState().deleteArea('missing-area');

        expect(result).toEqual({ success: false, error: 'Area not found' });
        expect(useTaskStore.getState().error).toBe('Area not found');
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

    it('duplicates projects as fresh active work with reset checklists', async () => {
        const { addProject, addSection, addTask, duplicateProject } = useTaskStore.getState();
        const project = await addProject('Launch Template', '#00ff00');
        expect(project).not.toBeNull();
        if (!project) return;
        const section = await addSection(project.id, 'Preparation');
        expect(section).not.toBeNull();
        if (!section) return;
        await addTask('Reference checklist', {
            projectId: project.id,
            sectionId: section.id,
            status: 'reference',
            checklist: [
                { id: 'c1', title: 'Confirm venue', isCompleted: true },
                { id: 'c2', title: 'Send agenda', isCompleted: false },
            ],
        });

        const duplicated = await duplicateProject(project.id);

        expect(duplicated?.title).toBe('Launch Template (Copy)');
        const duplicatedSection = useTaskStore.getState()._allSections.find((item) => (
            item.projectId === duplicated?.id && item.title === 'Preparation'
        ));
        expect(duplicatedSection).toBeTruthy();
        const duplicatedTask = useTaskStore.getState()._allTasks.find((task) => (
            task.projectId === duplicated?.id && task.title === 'Reference checklist'
        ));
        expect(duplicatedTask?.status).toBe('next');
        expect(duplicatedTask?.sectionId).toBe(duplicatedSection?.id);
        expect(duplicatedTask?.checklist?.map((item) => ({
            title: item.title,
            isCompleted: item.isCompleted,
        }))).toEqual([
            { title: 'Confirm venue', isCompleted: false },
            { title: 'Send agenda', isCompleted: false },
        ]);
        expect(duplicatedTask?.checklist?.map((item) => item.id)).not.toEqual(['c1', 'c2']);
    });

    it('should archive a project, mark incomplete tasks done, and archive its sections', async () => {
        const { addProject, addTask, addSection, updateProject } = useTaskStore.getState();
        addProject('Archived Project', '#123456');

        const project = useTaskStore.getState().projects[0];
        addTask('Task 1', { status: 'next', projectId: project.id });
        addTask('Task 2', { status: 'waiting', projectId: project.id });
        addTask('Already Done', {
            status: 'done',
            completedAt: '2026-03-20T10:00:00.000Z',
            updatedAt: '2026-03-20T10:00:00.000Z',
            projectId: project.id,
        });
        addTask('Already Archived', {
            status: 'archived',
            completedAt: '2026-03-19T10:00:00.000Z',
            updatedAt: '2026-03-19T10:00:00.000Z',
            projectId: project.id,
        });
        const section = await addSection(project.id, 'Section 1');
        expect(section).not.toBeNull();

        await updateProject(project.id, { status: 'archived' });

        const projectTasks = useTaskStore.getState()._allTasks.filter(t => t.projectId === project.id && !t.deletedAt);
        const projectSections = useTaskStore.getState()._allSections.filter((item) => item.projectId === project.id);
        expect(projectTasks).toHaveLength(4);
        expect(projectTasks.filter((task) => task.status === 'done')).toHaveLength(3);
        expect(projectTasks.find((task) => task.title === 'Task 1')?.statusBeforeProjectArchive).toBe('next');
        expect(projectTasks.find((task) => task.title === 'Task 2')?.statusBeforeProjectArchive).toBe('waiting');
        expect(projectTasks.find((task) => task.title === 'Already Done')?.completedAt).toBe('2026-03-20T10:00:00.000Z');
        expect(projectTasks.find((task) => task.title === 'Already Done')?.statusBeforeProjectArchive).toBeUndefined();
        expect(projectTasks.find((task) => task.title === 'Already Archived')?.status).toBe('archived');
        expect(projectSections).toHaveLength(1);
        expect(projectSections[0].deletedAt).toBeTruthy();
        expect(projectSections[0].deletedAtBeforeProjectArchive).toBeNull();
    });

    it('should restore project-archived task and section state when unarchiving', async () => {
        const { addProject, addTask, addSection, updateProject } = useTaskStore.getState();
        addProject('Reversible Archive Project', '#123456');

        const project = useTaskStore.getState().projects[0];
        addTask('Next Task', {
            status: 'next',
            projectId: project.id,
            completedAt: '2026-03-18T10:00:00.000Z',
            isFocusedToday: true,
        });
        addTask('Waiting Task', { status: 'waiting', projectId: project.id });
        addTask('Already Done', {
            status: 'done',
            completedAt: '2026-03-20T10:00:00.000Z',
            projectId: project.id,
        });
        const section = await addSection(project.id, 'Section 1');
        expect(section).not.toBeNull();

        await updateProject(project.id, { status: 'archived' });
        await updateProject(project.id, { status: 'active' });

        const projectTasks = useTaskStore.getState()._allTasks.filter(t => t.projectId === project.id && !t.deletedAt);
        const nextTask = projectTasks.find((task) => task.title === 'Next Task');
        const waitingTask = projectTasks.find((task) => task.title === 'Waiting Task');
        const doneTask = projectTasks.find((task) => task.title === 'Already Done');
        const projectSections = useTaskStore.getState()._allSections.filter((item) => item.projectId === project.id);

        expect(nextTask?.status).toBe('next');
        expect(nextTask?.completedAt).toBe('2026-03-18T10:00:00.000Z');
        expect(nextTask?.isFocusedToday).toBe(true);
        expect(nextTask?.statusBeforeProjectArchive).toBeUndefined();
        expect(nextTask?.projectArchivedAt).toBeUndefined();
        expect(waitingTask?.status).toBe('waiting');
        expect(waitingTask?.completedAt).toBeUndefined();
        expect(doneTask?.status).toBe('done');
        expect(doneTask?.completedAt).toBe('2026-03-20T10:00:00.000Z');
        expect(projectSections[0].deletedAt).toBeUndefined();
        expect(projectSections[0].deletedAtBeforeProjectArchive).toBeUndefined();
        expect(projectSections[0].projectArchivedAt).toBeUndefined();
    });

    it('does not rewrite a project-archived task that moved before unarchive', async () => {
        const { addProject, addTask, updateProject, updateTask } = useTaskStore.getState();
        const sourceProject = await addProject('Source Project', '#123456');
        const targetProject = await addProject('Target Project', '#654321');
        expect(sourceProject).not.toBeNull();
        expect(targetProject).not.toBeNull();
        if (!sourceProject || !targetProject) return;

        await addTask('Moved Task', { status: 'next', projectId: sourceProject.id });
        const taskId = useTaskStore.getState()._allTasks[0].id;

        await updateProject(sourceProject.id, { status: 'archived' });
        const archivedTask = useTaskStore.getState()._tasksById.get(taskId);
        expect(archivedTask?.projectArchivedAt).toBeTruthy();

        await updateTask(taskId, { projectId: targetProject.id });
        const movedTask = useTaskStore.getState()._tasksById.get(taskId);
        expect(movedTask?.projectId).toBe(targetProject.id);

        await updateProject(sourceProject.id, { status: 'active' });
        const afterUnarchive = useTaskStore.getState()._tasksById.get(taskId);

        expect(afterUnarchive).toBe(movedTask);
        expect(afterUnarchive?.projectId).toBe(targetProject.id);
        expect(afterUnarchive?.projectArchivedAt).toBe(movedTask?.projectArchivedAt);
        expect(afterUnarchive?.rev).toBe(movedTask?.rev);
        expect(afterUnarchive?.updatedAt).toBe(movedTask?.updatedAt);
    });

    it('sets error when updateProject targets a missing project', async () => {
        const { updateProject } = useTaskStore.getState();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const result = await updateProject('missing-project-id', { status: 'active' });

        expect(result).toEqual({ success: false, error: 'Project not found' });
        expect(useTaskStore.getState().error).toBe('Project not found');
        const missingProjectCall = warnSpy.mock.calls.find(
            ([message]) => message === 'updateProject skipped: project not found'
        );
        expect(missingProjectCall).toBeTruthy();
        const [, missingProjectMeta] = missingProjectCall ?? [];
        expect(missingProjectMeta).toEqual(
            expect.objectContaining({
                scope: 'store',
                category: 'validation',
                context: expect.any(String),
            })
        );
        expect(parseLoggedContext(missingProjectMeta?.context)).toEqual({ id: 'missing-project-id' });
        warnSpy.mockRestore();
    });

    it('returns action failure when deleteProject targets a missing project', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const result = await useTaskStore.getState().deleteProject('missing-project-id');

        expect(result).toEqual({ success: false, error: 'Project not found' });
        expect(useTaskStore.getState().error).toBe('Project not found');
        expect(warnSpy).toHaveBeenCalledWith(
            'deleteProject skipped: project not found',
            expect.objectContaining({ scope: 'store', category: 'validation' }),
        );
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
        expect(nextInstance.recurrence).toEqual({ rule: 'daily' });
        expect(nextInstance.dueDate).toBe('2023-01-02T09:00');
    });

    it('does not append a duplicate recurring follow-up when one already exists', async () => {
        vi.setSystemTime(new Date('2026-06-09T00:00:00.000Z'));

        const current: Task = {
            id: 'weekly-current',
            title: 'Timeblock',
            status: 'next',
            recurrence: { rule: 'weekly', strategy: 'strict' },
            startTime: '2026-06-08T08:00:00.000Z',
            dueDate: '2026-06-08T17:00:00.000Z',
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
        };
        const existingFollowUp: Task = {
            ...current,
            id: 'weekly-follow-up',
            startTime: '2026-06-15T08:00:00.000Z',
            dueDate: '2026-06-15T17:00:00.000Z',
        };

        useTaskStore.setState({
            tasks: [current, existingFollowUp],
            _allTasks: [current, existingFollowUp],
        });

        await useTaskStore.getState().updateTask(current.id, { status: 'done' });

        const state = useTaskStore.getState();
        expect(state._allTasks).toHaveLength(2);
        expect(state._allTasks.find((task) => task.id === current.id)?.status).toBe('done');
        const openTimeblocks = state._allTasks.filter((task) => task.title === 'Timeblock' && task.status === 'next');
        expect(openTimeblocks).toHaveLength(1);
        expect(openTimeblocks[0]?.id).toBe(existingFollowUp.id);
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

        it('returns action failure when updateSection targets a missing section', async () => {
            const result = await useTaskStore.getState().updateSection('missing-section', { title: 'Updated Phase' });

            expect(result).toEqual({ success: false, error: 'Section not found' });
            expect(useTaskStore.getState().error).toBe('Section not found');
        });

        it('returns action failure when deleteSection targets a missing section', async () => {
            const result = await useTaskStore.getState().deleteSection('missing-section');

            expect(result).toEqual({ success: false, error: 'Section not found' });
            expect(useTaskStore.getState().error).toBe('Section not found');
        });

        it('reorders sections within one project without changing other projects', async () => {
            const { addProject, addSection, reorderSections } = useTaskStore.getState();
            const project = await addProject('Section Order Project', '#123456');
            const otherProject = await addProject('Other Project', '#654321');
            expect(project).not.toBeNull();
            expect(otherProject).not.toBeNull();
            if (!project || !otherProject) return;

            const first = await addSection(project.id, 'First');
            const second = await addSection(project.id, 'Second');
            const third = await addSection(project.id, 'Third');
            const other = await addSection(otherProject.id, 'Other');
            expect(first && second && third && other).toBeTruthy();
            if (!first || !second || !third || !other) return;

            await reorderSections(project.id, [third.id, first.id, second.id]);

            const ordered = useTaskStore.getState().sections
                .filter((section) => section.projectId === project.id)
                .sort((a, b) => a.order - b.order);
            expect(ordered.map((section) => section.id)).toEqual([third.id, first.id, second.id]);
            expect(ordered.map((section) => section.order)).toEqual([0, 1, 2]);
            expect(useTaskStore.getState().sections.find((section) => section.id === other.id)?.order).toBe(0);
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

        it('should normalize project changes in batch updates', async () => {
            const { addProject, addSection, addTask, batchUpdateTasks, addArea } = useTaskStore.getState();
            const projectA = await addProject('Project A', '#111111');
            const projectB = await addProject('Project B', '#222222');
            expect(projectA).not.toBeNull();
            expect(projectB).not.toBeNull();
            if (!projectA || !projectB) return;
            const area = await addArea('Area 1');
            expect(area).not.toBeNull();
            if (!area) return;

            const sectionA = await addSection(projectA.id, 'Section A');
            if (!sectionA) return;

            await addTask('Batch movable', {
                projectId: projectA.id,
                sectionId: sectionA.id,
                status: 'next',
            });
            await addTask('Area scoped', {
                areaId: area.id,
                status: 'next',
            });

            const movableTask = useTaskStore.getState()._allTasks.find((item) => item.title === 'Batch movable')!;
            const areaTask = useTaskStore.getState()._allTasks.find((item) => item.title === 'Area scoped')!;

            await batchUpdateTasks([
                { id: movableTask.id, updates: { projectId: projectB.id } },
                { id: areaTask.id, updates: { projectId: projectB.id } },
            ]);

            const updatedMovable = useTaskStore.getState()._allTasks.find((item) => item.id === movableTask.id)!;
            const updatedAreaTask = useTaskStore.getState()._allTasks.find((item) => item.id === areaTask.id)!;
            expect(updatedMovable.projectId).toBe(projectB.id);
            expect(updatedMovable.sectionId).toBeUndefined();
            expect(updatedMovable.order).toBe(0);
            expect(updatedMovable.orderNum).toBe(0);
            expect(updatedAreaTask.projectId).toBe(projectB.id);
            expect(updatedAreaTask.areaId).toBeUndefined();
            expect(updatedAreaTask.order).toBe(1);
            expect(updatedAreaTask.orderNum).toBe(1);
        });

        it('fails batch updates when any task id is missing', async () => {
            const { addTask, batchUpdateTasks } = useTaskStore.getState();
            await addTask('Existing Task', { status: 'next' });
            const task = useTaskStore.getState()._allTasks.find((item) => item.title === 'Existing Task')!;

            const result = await batchUpdateTasks([
                { id: task.id, updates: { title: 'Should not apply' } },
                { id: 'missing-task', updates: { title: 'Missing' } },
            ]);

            expect(result).toEqual({ success: false, error: 'Tasks not found: missing-task' });
            expect(useTaskStore.getState()._allTasks.find((item) => item.id === task.id)?.title).toBe('Existing Task');
        });

        it('fails batch updates when task ids are duplicated', async () => {
            const { addTask, batchUpdateTasks } = useTaskStore.getState();
            await addTask('Existing Task', { status: 'next' });
            const task = useTaskStore.getState()._allTasks.find((item) => item.title === 'Existing Task')!;

            const result = await batchUpdateTasks([
                { id: task.id, updates: { title: 'First change' } },
                { id: task.id, updates: { title: 'Second change' } },
            ]);

            expect(result).toEqual({ success: false, error: `Duplicate task ids in batch update: ${task.id}` });
            expect(useTaskStore.getState()._allTasks.find((item) => item.id === task.id)?.title).toBe('Existing Task');
        });

        it('fails batch updates when the target project is missing', async () => {
            const { addTask, batchUpdateTasks } = useTaskStore.getState();
            await addTask('Existing Task', { status: 'next' });
            const task = useTaskStore.getState()._allTasks.find((item) => item.title === 'Existing Task')!;

            const result = await batchUpdateTasks([
                { id: task.id, updates: { projectId: 'missing-project' } },
            ]);

            expect(result).toEqual({ success: false, error: 'Project not found' });
            expect(useTaskStore.getState()._allTasks.find((item) => item.id === task.id)?.projectId).toBeUndefined();
        });

        it('fails batch deletes when any task id is missing', async () => {
            const { addTask, batchDeleteTasks } = useTaskStore.getState();
            await addTask('Existing Task', { status: 'next' });
            const task = useTaskStore.getState()._allTasks.find((item) => item.title === 'Existing Task')!;

            const result = await batchDeleteTasks([task.id, 'missing-task']);

            expect(result).toEqual({ success: false, error: 'Tasks not found: missing-task' });
            expect(useTaskStore.getState()._allTasks.find((item) => item.id === task.id)?.deletedAt).toBeUndefined();
        });

        it('fails batch deletes when any task id is already tombstoned', async () => {
            const { addTask, batchDeleteTasks, deleteTask } = useTaskStore.getState();
            await addTask('Active Task', { status: 'next' });
            await addTask('Deleted Task', { status: 'next' });
            const activeTask = useTaskStore.getState()._allTasks.find((item) => item.title === 'Active Task')!;
            const deletedTask = useTaskStore.getState()._allTasks.find((item) => item.title === 'Deleted Task')!;

            await deleteTask(deletedTask.id);
            const deletedTaskBeforeBatch = useTaskStore.getState()._allTasks.find((item) => item.id === deletedTask.id)!;

            const result = await batchDeleteTasks([activeTask.id, deletedTask.id]);

            expect(result).toEqual({ success: false, error: `Tasks not found: ${deletedTask.id}` });
            expect(useTaskStore.getState()._allTasks.find((item) => item.id === activeTask.id)?.deletedAt).toBeUndefined();
            expect(useTaskStore.getState()._allTasks.find((item) => item.id === deletedTask.id)).toEqual(deletedTaskBeforeBatch);
        });

        it('keeps the task lookup aligned after batch updates and deletes', async () => {
            const { addTask, batchDeleteTasks, batchUpdateTasks } = useTaskStore.getState();
            await addTask('First Task', { status: 'next' });
            await addTask('Second Task', { status: 'next' });
            const firstTask = useTaskStore.getState()._allTasks.find((item) => item.title === 'First Task')!;
            const secondTask = useTaskStore.getState()._allTasks.find((item) => item.title === 'Second Task')!;

            await batchUpdateTasks([
                { id: firstTask.id, updates: { title: 'Updated First Task' } },
            ]);
            let state = useTaskStore.getState();
            const updatedFirstTask = state._allTasks.find((item) => item.id === firstTask.id)!;
            expect(state._tasksById.get(firstTask.id)).toBe(updatedFirstTask);
            expect(state._tasksById.get(firstTask.id)?.title).toBe('Updated First Task');

            await batchDeleteTasks([firstTask.id, secondTask.id]);

            state = useTaskStore.getState();
            const deletedFirstTask = state._allTasks.find((item) => item.id === firstTask.id)!;
            const deletedSecondTask = state._allTasks.find((item) => item.id === secondTask.id)!;
            expect(deletedFirstTask.deletedAt).toBeTruthy();
            expect(deletedSecondTask.deletedAt).toBeTruthy();
            expect(state._tasksById.get(firstTask.id)).toBe(deletedFirstTask);
            expect(state._tasksById.get(secondTask.id)).toBe(deletedSecondTask);
        });

        it('detaches live project task section ids when deleting a project', async () => {
            const { addProject, addSection, addTask, deleteProject, restoreProject } = useTaskStore.getState();
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
            expect(deletedTask.deletedAt).toBeUndefined();
            expect(deletedTask.projectId).toBeUndefined();
            expect(deletedTask.sectionId).toBeUndefined();
            expect(deletedSection.deletedAt).toBeTruthy();
            expect(useTaskStore.getState().tasks.find((item) => item.id === task.id)).toMatchObject({
                projectId: undefined,
                sectionId: undefined,
            });
            expect(useTaskStore.getState().sections.find((item) => item.id === section.id)).toBeUndefined();

            const restoreResult = await restoreProject(project.id);
            expect(restoreResult).toEqual({ success: true });

            const restoredTask = useTaskStore.getState()._allTasks.find((item) => item.id === task.id)!;
            const restoredSection = useTaskStore.getState()._allSections.find((item) => item.id === section.id)!;
            expect(restoredTask.deletedAt).toBeUndefined();
            expect(restoredTask.projectId).toBeUndefined();
            expect(restoredTask.sectionId).toBeUndefined();
            expect(restoredSection.deletedAt).toBeUndefined();
        });

        it('restores only project children deleted by the project cascade', async () => {
            const { addProject, addSection, addTask, deleteTask, deleteProject, restoreProject } = useTaskStore.getState();
            const project = await addProject('Cascade Restore', '#444444');
            expect(project).not.toBeNull();
            if (!project) return;
            const section = await addSection(project.id, 'Section');
            expect(section).not.toBeNull();
            if (!section) return;

            await addTask('Keep Deleted', { projectId: project.id, sectionId: section.id, status: 'next' });
            await addTask('Restore Me', { projectId: project.id, sectionId: section.id, status: 'next' });
            const deletedTask = useTaskStore.getState()._allTasks.find((item) => item.title === 'Keep Deleted')!;
            const restoredTask = useTaskStore.getState()._allTasks.find((item) => item.title === 'Restore Me')!;

            vi.useFakeTimers();
            try {
                await deleteTask(deletedTask.id);
                vi.setSystemTime(new Date('2026-04-01T12:00:01.000Z'));
                await deleteProject(project.id);
                await restoreProject(project.id);
            } finally {
                vi.useRealTimers();
            }

            const finalDeletedTask = useTaskStore.getState()._allTasks.find((item) => item.id === deletedTask.id)!;
            const finalRestoredTask = useTaskStore.getState()._allTasks.find((item) => item.id === restoredTask.id)!;
            expect(finalDeletedTask.deletedAt).toBeTruthy();
            expect(finalRestoredTask.deletedAt).toBeUndefined();
        });
    });
});
