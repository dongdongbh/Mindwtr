import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { addDays } from 'date-fns';
import { safeParseDate } from './date';
import { useTaskStore, flushPendingSave, setStorageAdapter } from './store';
import type { StorageAdapter } from './storage';

describe('TaskStore', () => {
    let mockStorage: StorageAdapter;

    beforeEach(() => {
        // Create fresh mock storage for each test
        mockStorage = {
            getData: vi.fn().mockResolvedValue({ tasks: [], projects: [], areas: [], settings: {} }),
            saveData: vi.fn().mockResolvedValue(undefined),
        };
        setStorageAdapter(mockStorage);
        useTaskStore.setState({ tasks: [], projects: [], areas: [], settings: {}, _allTasks: [], _allProjects: [], _allAreas: [] });
        vi.useFakeTimers();
    });

    afterEach(() => {
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

    it('should delete a task', () => {
        const { addTask, deleteTask } = useTaskStore.getState();
        addTask('Task to Delete');

        const task = useTaskStore.getState().tasks[0];
        deleteTask(task.id);

        const { tasks } = useTaskStore.getState();
        expect(tasks).toHaveLength(0);
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

    it('should add a project', () => {
        const { addProject } = useTaskStore.getState();
        addProject('New Project', '#ff0000');

        const { projects } = useTaskStore.getState();
        expect(projects).toHaveLength(1);
        expect(projects[0].title).toBe('New Project');
        expect(projects[0].color).toBe('#ff0000');
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

    it('should archive a project and archive its active tasks', () => {
        const { addProject, addTask, updateProject } = useTaskStore.getState();
        addProject('Archived Project', '#123456');

        const project = useTaskStore.getState().projects[0];
        addTask('Task 1', { status: 'next', projectId: project.id });
        addTask('Task 2', { status: 'waiting', projectId: project.id });

        updateProject(project.id, { status: 'archived' });

        const projectTasks = useTaskStore.getState()._allTasks.filter(t => t.projectId === project.id && !t.deletedAt);
        expect(projectTasks).toHaveLength(2);
        expect(projectTasks.every(t => t.status === 'archived')).toBe(true);
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
});
