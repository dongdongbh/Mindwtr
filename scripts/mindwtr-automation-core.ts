import {
    flushPendingSave,
    parseQuickAdd,
    searchAll,
    setStorageAdapter,
    useTaskStore,
    type Area,
    type Project,
    type SearchProjectResult,
    type SearchResults,
    type Task,
    type TaskStatus,
} from '@mindwtr/core';

import { createMindwtrAutomationStorage } from './mindwtr-automation-storage';

export const TASK_STATUSES: TaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived'];

export const asTaskStatus = (value: unknown): TaskStatus | null => {
    if (typeof value !== 'string') return null;
    return TASK_STATUSES.includes(value as TaskStatus) ? (value as TaskStatus) : null;
};

type AutomationServiceOptions = {
    dataPath?: string;
    dbPath?: string;
};

type ListTasksOptions = {
    includeAll?: boolean;
    includeDeleted?: boolean;
    status?: TaskStatus | null;
    query?: string;
};

type CreateTaskInput = {
    input?: string;
    title?: string;
    props?: Partial<Task>;
};

const refreshState = async () => {
    await useTaskStore.getState().fetchData({ silent: true });
    return useTaskStore.getState();
};

const requireTask = async (taskId: string): Promise<Task> => {
    const state = await refreshState();
    const task = state._allTasks.find((item) => item.id === taskId);
    if (!task) {
        throw new Error(`Task not found: ${taskId}`);
    }
    return task;
};

const requireValidStatus = (status: unknown, fieldName = 'status'): TaskStatus | undefined => {
    if (status === undefined) return undefined;
    const parsed = asTaskStatus(status);
    if (!parsed) {
        throw new Error(`Invalid ${fieldName}: ${String(status)}`);
    }
    return parsed;
};

const sanitizeTaskPatch = (patch: Partial<Task>): Partial<Task> => {
    const sanitized = { ...patch } as Record<string, unknown>;
    delete sanitized.id;
    delete sanitized.createdAt;
    delete sanitized.updatedAt;
    delete sanitized.rev;
    delete sanitized.revBy;
    delete sanitized.completedAt;
    delete sanitized.deletedAt;
    delete sanitized.purgedAt;
    const parsedStatus = requireValidStatus(sanitized.status);
    if (parsedStatus) {
        sanitized.status = parsedStatus;
    }
    return sanitized as Partial<Task>;
};

const filterProjectsForSearch = (projects: Project[], includeDeleted = false) => (
    includeDeleted ? projects : projects.filter((project) => !project.deletedAt)
);

export async function createMindwtrAutomationService(options: AutomationServiceOptions = {}) {
    const storage = createMindwtrAutomationStorage(options);
    setStorageAdapter(storage);
    await refreshState();

    const updateTask = async (taskId: string, patch: Partial<Task>): Promise<Task> => {
        const state = await refreshState();
        const result = await state.updateTask(taskId, sanitizeTaskPatch(patch));
        if (!result.success) {
            throw new Error(result.error || `Failed to update task: ${taskId}`);
        }
        await flushPendingSave();
        return requireTask(taskId);
    };

    return {
        paths: storage.paths,
        createTask: async ({ input, title, props }: CreateTaskInput): Promise<Task> => {
            const state = await refreshState();
            const beforeTaskIds = new Set(state._allTasks.map((task) => task.id));
            const now = new Date();
            const parsed = typeof input === 'string' && input.trim().length > 0
                ? parseQuickAdd(input, state._allProjects, now, state._allAreas)
                : { title: typeof title === 'string' ? title : '', props: {} };
            const resolvedTitle = (parsed.title || title || input || '').trim();
            if (!resolvedTitle) {
                throw new Error('Task title is required');
            }

            const parsedStatus = requireValidStatus((props || {}).status);

            const result = await state.addTask(resolvedTitle, {
                ...parsed.props,
                ...(props || {}),
                ...(parsedStatus ? { status: parsedStatus } : {}),
            } as Partial<Task>);
            if (!result.success) {
                throw new Error(result.error || 'Failed to create task');
            }

            await flushPendingSave();
            const created = useTaskStore.getState()._allTasks.find((task) => !beforeTaskIds.has(task.id));
            if (!created) {
                throw new Error('Failed to locate newly created task');
            }
            return created;
        },
        listTasks: async ({ includeAll, includeDeleted, status, query }: ListTasksOptions = {}): Promise<Task[]> => {
            const state = await refreshState();
            let tasks = state._allTasks.filter((task) => includeDeleted || !task.deletedAt);
            if (!includeAll) {
                tasks = tasks.filter((task) => task.status !== 'done' && task.status !== 'archived');
            }
            if (status) {
                tasks = tasks.filter((task) => task.status === status);
            }
            if (typeof query === 'string' && query.trim().length > 0) {
                const results = searchAll(tasks, filterProjectsForSearch(state._allProjects, includeDeleted), query);
                const ids = new Set(results.tasks.map((task) => task.id));
                tasks = tasks.filter((task) => ids.has(task.id));
            }
            return tasks;
        },
        getTask: async (taskId: string): Promise<Task> => {
            return requireTask(taskId);
        },
        updateTask,
        completeTask: async (taskId: string): Promise<Task> => {
            return updateTask(taskId, { status: 'done' });
        },
        archiveTask: async (taskId: string): Promise<Task> => {
            return updateTask(taskId, { status: 'archived' });
        },
        deleteTask: async (taskId: string): Promise<Task> => {
            const state = await refreshState();
            const result = await state.deleteTask(taskId);
            if (!result.success) {
                throw new Error(result.error || `Failed to delete task: ${taskId}`);
            }
            await flushPendingSave();
            return requireTask(taskId);
        },
        restoreTask: async (taskId: string): Promise<Task> => {
            const state = await refreshState();
            const result = await state.restoreTask(taskId);
            if (!result.success) {
                throw new Error(result.error || `Failed to restore task: ${taskId}`);
            }
            await flushPendingSave();
            return requireTask(taskId);
        },
        search: async (query: string): Promise<SearchResults> => {
            const state = await refreshState();
            return searchAll(
                state._allTasks.filter((task) => !task.deletedAt),
                state._allProjects.filter((project) => !project.deletedAt),
                query,
            );
        },
        listProjects: async (): Promise<SearchProjectResult[]> => {
            const state = await refreshState();
            return state._allProjects
                .filter((project) => !project.deletedAt)
                .map((project) => ({
                    id: project.id,
                    title: project.title,
                    status: project.status,
                    areaId: project.areaId,
                }));
        },
        listAreas: async (): Promise<Area[]> => {
            const state = await refreshState();
            return state._allAreas.filter((area) => !area.deletedAt);
        },
    };
}
