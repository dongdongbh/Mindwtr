import {
    createSerializedAsyncQueue,
    executeCaptureTransaction,
    flushPendingSave,
    isTaskFinished,
    buildQuickAddParseOptions,
    parseQuickAdd,
    filterTasksBySearch,
    searchAll,
    setStorageAdapter,
    useTaskStore,
    type Area,
    type Project,
    type SearchProjectResult,
    type SearchResults,
    type Section,
    type Task,
    type TaskStatus,
} from '@mindwtr/core';
import { markNextLoadAsDocumentReplacement } from '../packages/core/src/store-settings';

import { createMindwtrAutomationStorage } from './mindwtr-automation-storage';


const singletonStoreQueue = createSerializedAsyncQueue();
let activeStorageIdentity: string | null = null;
const AUTOMATION_CONCURRENT_WRITE_PREFIX = 'SQLITE_BUSY: database changed after the automation snapshot was loaded';

const isRetryableAutomationConcurrencyError = (error: unknown): boolean => {
    const code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : '';
    const message = error instanceof Error ? error.message : String(error);
    return message.startsWith(`${AUTOMATION_CONCURRENT_WRITE_PREFIX} (external commit)`)
        || message.startsWith(`${AUTOMATION_CONCURRENT_WRITE_PREFIX} (no read baseline)`)
        || code === 'SQLITE_BUSY'
        || code === 'SQLITE_LOCKED'
        || /database is (?:busy|locked)/i.test(message);
};

const logAutomationRetryDiagnostic = (): void => {
    process.stderr.write(`${JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        scope: 'automation-storage',
        message: 'Automation storage operation succeeded after concurrent-write retry',
        context: {
            releaseCheck: 'v1.3.2/automation-concurrent-write-retry',
            retryCount: 1,
        },
    })}\n`);
};

const logAutomationCaptureProjectDiagnostic = (outcome: 'created' | 'reused' | 'explicit'): void => {
    process.stderr.write(`${JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        scope: 'automation-storage',
        message: 'Automation quick-add project routing completed',
        context: {
            releaseCheck: 'v1.3.2/automation-capture-project-routing',
            outcome,
        },
    })}\n`);
};

const logAutomationFailedOperationSettledDiagnostic = (): void => {
    process.stderr.write(`${JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        scope: 'automation-storage',
        message: 'Automation failed operation pending work settled',
        context: {
            releaseCheck: 'v1.3.2/automation-failed-operation-settled',
        },
    })}\n`);
};

const logAutomationCaptureImplicitStatusDiagnostic = (): void => {
    process.stderr.write(`${JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        scope: 'automation-storage',
        message: 'Automation capture applied implicit task status',
        context: {
            releaseCheck: 'v1.3.2/automation-capture-implicit-status',
        },
    })}\n`);
};

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
    isFocusedToday?: boolean;
};

type CreateTaskInput = {
    input?: string;
    title?: string;
    props?: Partial<Task>;
};

const refreshState = async () => {
    await useTaskStore.getState().fetchData({ silent: true, throwOnError: true });


    await flushPendingSave();
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

const sanitizeSectionPatch = (patch: Partial<Section>): Partial<Section> => {
    const sanitized: Partial<Section> = { ...patch };
    delete sanitized.id;
    delete sanitized.projectId;
    delete sanitized.createdAt;
    delete sanitized.updatedAt;
    delete sanitized.deletedAt;
    delete sanitized.rev;
    delete sanitized.revBy;
    delete sanitized.deletedAtBeforeProjectArchive;
    delete sanitized.projectArchivedAt;
    return sanitized;
};

const filterProjectsForSearch = (projects: Project[], includeDeleted = false) => (
    includeDeleted ? projects : projects.filter((project) => !project.deletedAt)
);

export async function createMindwtrAutomationService(options: AutomationServiceOptions = {}) {
    const storage = createMindwtrAutomationStorage(options);
    const runStoreOperation = <T>(operation: () => Promise<T>): Promise<T> => singletonStoreQueue.run(async () => {
        const storageIdentity = `${storage.paths.dataPath}\0${storage.paths.dbPath}`;
        setStorageAdapter(storage);
        let retried = false;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                if (activeStorageIdentity !== storageIdentity) markNextLoadAsDocumentReplacement();
                const result = await operation();
                await flushPendingSave();
                activeStorageIdentity = storageIdentity;
                if (retried) logAutomationRetryDiagnostic();
                return result;
            } catch (error) {
                let settled = false;
                try {
                    await flushPendingSave();
                    settled = true;
                } catch {


                }
                activeStorageIdentity = null;
                if (settled) logAutomationFailedOperationSettledDiagnostic();
                if (attempt > 0 || !isRetryableAutomationConcurrencyError(error)) throw error;
                retried = true;
            }
        }
        throw new Error('Automation storage retry exhausted');
    });

    await runStoreOperation(refreshState);

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
        createTask: ({ input, title, props }: CreateTaskInput): Promise<Task> => runStoreOperation(async () => {
            const state = await refreshState();
            const beforeTaskIds = new Set(state._allTasks.map((task) => task.id));
            const now = new Date();
            const parsed = typeof input === 'string' && input.trim().length > 0
                ? parseQuickAdd(
                    input,
                    state._allProjects,
                    now,
                    state._allAreas,
                    buildQuickAddParseOptions(state.settings, {
                        tasks: state._allTasks,
                        people: state.people,
                    }),
                )
                : {
                    title: typeof title === 'string' ? title : '',
                    props: {},
                    projectTitle: undefined,
                    detectedDate: undefined,
                    invalidDateCommands: undefined,
                };
            const explicitProps = { ...(props || {}) };
            const parsedStatus = requireValidStatus(explicitProps.status);
            if (parsedStatus) explicitProps.status = parsedStatus;
            const shouldInferTaskStatus = parsed.props.status === undefined && explicitProps.status === undefined;

            const capture = await executeCaptureTransaction({
                parsed: {
                    ...parsed,
                    title: parsed.title || title || '',
                },
                rawInput: typeof input === 'string' ? input : (title || ''),
                projects: state._allProjects,
                extraProps: explicitProps,
            }, {
                addProject: (projectTitle, color, initialProps) => (
                    state.addProject(projectTitle, color, initialProps)
                ),
                addTask: (taskTitle, initialProps) => {
                    if (!shouldInferTaskStatus) return state.addTask(taskTitle, initialProps);
                    const taskProps = { ...initialProps };
                    delete taskProps.status;
                    return state.addTask(taskTitle, taskProps);
                },
            });
            if (!capture.success) {
                if (capture.reason === 'invalid-date-command') {
                    throw new Error(`Invalid date command: ${capture.invalidDateCommands.join(', ')}`);
                }
                if (capture.reason === 'empty-title') throw new Error('Task title is required');
                throw new Error(capture.error || 'Failed to create task');
            }

            await flushPendingSave();
            const allTasks = useTaskStore.getState()._allTasks;
            const created = capture.createdTaskId
                ? allTasks.find((task) => task.id === capture.createdTaskId)
                : allTasks.find((task) => !beforeTaskIds.has(task.id));
            if (!created) {
                throw new Error('Failed to locate newly created task');
            }
            if (shouldInferTaskStatus && (created.startTime || created.cancelledAt)) {
                logAutomationCaptureImplicitStatusDiagnostic();
            }
            if (parsed.projectTitle || parsed.props.projectId) {
                logAutomationCaptureProjectDiagnostic(
                    explicitProps.projectId ? 'explicit' : capture.createdProject ? 'created' : 'reused',
                );
            }
            return created;
        }),
        listTasks: ({ includeAll, includeDeleted, status, query, isFocusedToday }: ListTasksOptions = {}): Promise<Task[]> => runStoreOperation(async () => {
            const state = await refreshState();
            let tasks = state._allTasks.filter((task) => includeDeleted || !task.deletedAt);
            if (!includeAll) {
                tasks = tasks.filter((task) => !isTaskFinished(task));
            }
            if (status) {
                tasks = tasks.filter((task) => task.status === status);
            }


            if (isFocusedToday !== undefined) {
                tasks = tasks.filter((task) => Boolean(task.isFocusedToday) === isFocusedToday);
            }
            if (typeof query === 'string' && query.trim().length > 0) {


                tasks = filterTasksBySearch(tasks, filterProjectsForSearch(state._allProjects, includeDeleted), query);
            }
            return tasks;
        }),
        getTask: (taskId: string): Promise<Task> => runStoreOperation(() => requireTask(taskId)),
        updateTask: (taskId: string, patch: Partial<Task>): Promise<Task> => (
            runStoreOperation(() => updateTask(taskId, patch))
        ),
        completeTask: (taskId: string): Promise<Task> => (
            runStoreOperation(() => updateTask(taskId, { status: 'done' }))
        ),
        archiveTask: (taskId: string): Promise<Task> => (
            runStoreOperation(() => updateTask(taskId, { status: 'archived' }))
        ),
        deleteTask: (taskId: string): Promise<Task> => runStoreOperation(async () => {
            const state = await refreshState();
            const result = await state.deleteTask(taskId);
            if (!result.success) {
                throw new Error(result.error || `Failed to delete task: ${taskId}`);
            }
            await flushPendingSave();
            return requireTask(taskId);
        }),
        restoreTask: (taskId: string): Promise<Task> => runStoreOperation(async () => {
            const state = await refreshState();
            const result = await state.restoreTask(taskId);
            if (!result.success) {
                throw new Error(result.error || `Failed to restore task: ${taskId}`);
            }
            await flushPendingSave();
            return requireTask(taskId);
        }),
        search: (query: string): Promise<SearchResults> => runStoreOperation(async () => {
            const state = await refreshState();
            return searchAll(
                state._allTasks.filter((task) => !task.deletedAt),
                state._allProjects.filter((project) => !project.deletedAt),
                query,
            );
        }),
        listProjects: (): Promise<SearchProjectResult[]> => runStoreOperation(async () => {
            const state = await refreshState();
            return state._allProjects
                .filter((project) => !project.deletedAt)
                .map((project) => ({
                    id: project.id,
                    title: project.title,
                    status: project.status,
                    areaId: project.areaId,
                }));
        }),
        listAreas: (): Promise<Area[]> => runStoreOperation(async () => {
            const state = await refreshState();
            return state._allAreas.filter((area) => !area.deletedAt);
        }),
        listSections: (projectId?: string): Promise<Section[]> => runStoreOperation(async () => {
            const state = await refreshState();
            return state._allSections.filter(
                (section) => !section.deletedAt && (!projectId || section.projectId === projectId)
            );
        }),
        getSection: (sectionId: string): Promise<Section> => runStoreOperation(async () => {
            const state = await refreshState();
            const section = state._allSections.find((item) => item.id === sectionId && !item.deletedAt);
            if (!section) throw new Error(`Section not found: ${sectionId}`);
            return section;
        }),
        createSection: ({
            projectId,
            title,
            props,
        }: {
            projectId: string;
            title: string;
            props?: Partial<Section>;
        }): Promise<Section> => runStoreOperation(async () => {
            const state = await refreshState();
            const section = await state.addSection(projectId, title, props);
            if (!section) throw new Error('Failed to create section');
            await flushPendingSave();
            return section;
        }),
        updateSection: (sectionId: string, patch: Partial<Section>): Promise<Section> => runStoreOperation(async () => {
            const state = await refreshState();
            const result = await state.updateSection(sectionId, sanitizeSectionPatch(patch));
            if (!result.success) throw new Error(result.error || `Failed to update section: ${sectionId}`);
            await flushPendingSave();
            const updated = useTaskStore.getState()._allSections.find((item) => item.id === sectionId);
            if (!updated) throw new Error(`Section not found after update: ${sectionId}`);
            return updated;
        }),
        deleteSection: (sectionId: string): Promise<void> => runStoreOperation(async () => {
            const state = await refreshState();
            const result = await state.deleteSection(sectionId);
            if (!result.success) throw new Error(result.error || `Failed to delete section: ${sectionId}`);
            await flushPendingSave();
        }),
    };
}
