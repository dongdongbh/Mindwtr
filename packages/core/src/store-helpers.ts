import { createNextRecurringTask } from './recurrence';
import { getUsedTaskTokens } from './task-token-usage';
import { rescheduleTask } from './task-utils';
import type { AppData, Area, Project, Section, Task, TaskStatus } from './types';
import { generateUUID as uuidv4 } from './uuid';
import type { DerivedState, SaveBaseState } from './store-types';

type EntityWithId = { id: string };

let projectOrderCacheRef: Task[] | null = null;
let projectOrderCacheValue: Map<string, number> | null = null;
let reservedProjectOrdersRef: Task[] | null = null;
let reservedProjectOrdersValue: Map<string, number> | null = null;

export const normalizeRevision = (value?: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export const ensureDeviceId = (settings: AppData['settings']): { settings: AppData['settings']; deviceId: string; updated: boolean } => {
    if (settings.deviceId) {
        return { settings, deviceId: settings.deviceId, updated: false };
    }
    const deviceId = uuidv4();
    return { settings: { ...settings, deviceId }, deviceId, updated: true };
};

export const getReferenceTaskFieldClears = (): Partial<Task> => ({
    status: 'reference',
    startTime: undefined,
    dueDate: undefined,
    reviewAt: undefined,
    recurrence: undefined,
    priority: undefined,
    timeEstimate: undefined,
    checklist: undefined,
    isFocusedToday: false,
    pushCount: 0,
});

export function applyTaskUpdates(oldTask: Task, updates: Partial<Task>, now: string): { updatedTask: Task; nextRecurringTask: Task | null } {
    let normalizedUpdates = updates;
    if (Object.prototype.hasOwnProperty.call(updates, 'textDirection') && updates.textDirection === undefined) {
        normalizedUpdates = { ...updates };
        delete normalizedUpdates.textDirection;
    }
    const updatesToApply = normalizedUpdates;
    const incomingStatus = updates.status ?? oldTask.status;
    const statusChanged = incomingStatus !== oldTask.status;

    let finalUpdates: Partial<Task> = updatesToApply;
    let nextRecurringTask: Task | null = null;
    const isCompleteStatus = (status: TaskStatus) => status === 'done' || status === 'archived';

    if (statusChanged && incomingStatus === 'done') {
        finalUpdates = {
            ...updatesToApply,
            status: incomingStatus,
            completedAt: now,
            isFocusedToday: false,
        };
        nextRecurringTask = createNextRecurringTask(oldTask, now, oldTask.status);
    } else if (statusChanged && incomingStatus === 'archived') {
        finalUpdates = {
            ...updatesToApply,
            status: incomingStatus,
            completedAt: oldTask.completedAt || now,
            isFocusedToday: false,
        };
    } else if (statusChanged && isCompleteStatus(oldTask.status) && !isCompleteStatus(incomingStatus)) {
        finalUpdates = {
            ...updatesToApply,
            status: incomingStatus,
            completedAt: undefined,
        };
    }

    if (Object.prototype.hasOwnProperty.call(updatesToApply, 'dueDate') && incomingStatus !== 'reference') {
        const rescheduled = rescheduleTask(oldTask, updatesToApply.dueDate);
        finalUpdates = {
            ...finalUpdates,
            dueDate: rescheduled.dueDate,
            pushCount: rescheduled.pushCount,
        };
    }

    // Reference tasks should be non-actionable; clear scheduling/priority fields.
    if (incomingStatus === 'reference') {
        finalUpdates = {
            ...finalUpdates,
            ...getReferenceTaskFieldClears(),
        };
    }

    return {
        updatedTask: { ...oldTask, ...finalUpdates, updatedAt: now },
        nextRecurringTask,
    };
}

export type TaskVisibilityOptions = {
    includeArchived?: boolean;
    includeDeleted?: boolean;
};

export const isTaskVisible = (task?: Task | null, options?: TaskVisibilityOptions): boolean => {
    if (!task) return false;
    const includeArchived = options?.includeArchived === true;
    const includeDeleted = options?.includeDeleted === true;
    if (!includeDeleted && task.deletedAt) return false;
    if (!includeArchived && task.status === 'archived') return false;
    return true;
};

export const toVisibleTask = (task: Task): Task => {
    const attachments = task.attachments;
    if (!attachments || attachments.length === 0) return task;
    const visibleAttachments = attachments.filter((attachment) => !attachment.deletedAt);
    return visibleAttachments.length === attachments.length
        ? task
        : { ...task, attachments: visibleAttachments };
};

export const selectVisibleTasks = (tasks: Task[]): Task[] =>
    tasks.filter((task) => isTaskVisible(task)).map(toVisibleTask);

export const updateVisibleTasks = (visible: Task[], previous?: Task | null, next?: Task | null): Task[] => {
    const wasVisible = isTaskVisible(previous);
    const isVisible = isTaskVisible(next);
    const visibleNext = next && isVisible ? toVisibleTask(next) : next;
    if (wasVisible && isVisible && next) {
        return visible.map((task) => (task.id === visibleNext!.id ? visibleNext! : task));
    }
    if (wasVisible && !isVisible && previous) {
        return visible.filter((task) => task.id !== previous.id);
    }
    if (!wasVisible && isVisible && next) {
        return [...visible, visibleNext!];
    }
    return visible;
};

const assertCollectionSnapshotIncludesExistingItems = <T extends EntityWithId>(
    label: string,
    nextItems: T[],
    previousItems: T[]
): void => {
    if (nextItems.length >= previousItems.length) return;
    const nextIds = new Set(nextItems.map((item) => item.id));
    const missingIds = previousItems
        .filter((item) => !nextIds.has(item.id))
        .slice(0, 10)
        .map((item) => item.id);
    if (missingIds.length === 0) return;
    throw new Error(
        `Refusing to save a partial ${label} snapshot; missing existing ids: ${missingIds.join(', ')}`
    );
};

export const buildSaveSnapshot = (state: SaveBaseState, overrides?: Partial<AppData>): AppData => {
    const tasks = overrides?.tasks ?? state._allTasks;
    const projects = overrides?.projects ?? state._allProjects;
    const sections = overrides?.sections ?? state._allSections;
    const areas = overrides?.areas ?? state._allAreas;
    if (overrides?.tasks) {
        assertCollectionSnapshotIncludesExistingItems<Task>('task', tasks, state._allTasks);
    }
    if (overrides?.projects) {
        assertCollectionSnapshotIncludesExistingItems<Project>('project', projects, state._allProjects);
    }
    if (overrides?.sections) {
        assertCollectionSnapshotIncludesExistingItems<Section>('section', sections, state._allSections);
    }
    if (overrides?.areas) {
        assertCollectionSnapshotIncludesExistingItems<Area>('area', areas, state._allAreas);
    }
    return {
        tasks,
        projects,
        sections,
        areas,
        settings: overrides?.settings ?? state.settings,
    };
};

export const computeDerivedState = (tasks: Task[], projects: Project[]): DerivedState => {
    const projectDerived = computeProjectDerivedState(projects);
    const taskDerived = computeTaskDerivedState(tasks);

    return {
        ...projectDerived,
        ...taskDerived,
    };
};

export const computeProjectDerivedState = (projects: Project[]): Pick<DerivedState, 'projectMap' | 'sequentialProjectIds'> => {
    const projectMap = new Map<string, Project>();
    const sequentialProjectIds = new Set<string>();

    projects.forEach((project) => {
        projectMap.set(project.id, project);
        if (project.isSequential && !project.deletedAt) {
            sequentialProjectIds.add(project.id);
        }
    });

    return {
        projectMap,
        sequentialProjectIds,
    };
};

export const computeTaskDerivedState = (
    tasks: Task[]
): Pick<DerivedState, 'tasksById' | 'activeTasksByStatus' | 'allContexts' | 'allTags' | 'focusedCount'> => {
    const tasksById = new Map<string, Task>();
    const activeTasksByStatus = new Map<TaskStatus, Task[]>();
    let focusedCount = 0;

    tasks.forEach((task) => {
        tasksById.set(task.id, task);
        if (task.deletedAt) return;
        const list = activeTasksByStatus.get(task.status) ?? [];
        list.push(task);
        activeTasksByStatus.set(task.status, list);
        if (task.isFocusedToday && task.status !== 'done' && task.status !== 'reference') {
            focusedCount += 1;
        }
    });

    return {
        tasksById,
        activeTasksByStatus,
        allContexts: getUsedTaskTokens(tasks, (task) => task.contexts, { prefix: '@' }),
        allTags: getUsedTaskTokens(tasks, (task) => task.tags, { prefix: '#' }),
        focusedCount,
    };
};

export const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
};

export const normalizeTagId = (value: string): string => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return '';
    const withPrefix = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
    return withPrefix.toLowerCase();
};

export const stripSensitiveSettings = (settings: AppData['settings']): AppData['settings'] => {
    if (!settings?.ai || !settings.ai.apiKey) return settings;
    return {
        ...settings,
        ai: {
            ...settings.ai,
            apiKey: undefined,
        },
    };
};

export const normalizeAiSettingsForSync = (ai?: AppData['settings']['ai']): AppData['settings']['ai'] | undefined => {
    if (!ai) return ai;
    const { apiKey, ...rest } = ai;
    if (!rest.speechToText) return rest;
    return {
        ...rest,
        speechToText: {
            ...rest.speechToText,
            offlineModelPath: undefined,
        },
    };
};

export const cloneSettings = (settings: AppData['settings']): AppData['settings'] => {
    try {
        if (typeof structuredClone === 'function') {
            return structuredClone(settings);
        }
    } catch {
        // Fallback below
    }
    return JSON.parse(JSON.stringify(settings)) as AppData['settings'];
};

export const sanitizeAppDataForStorage = (data: AppData): AppData => ({
    ...data,
    settings: stripSensitiveSettings(cloneSettings(data.settings)),
});

export const getTaskOrder = (task: Pick<Task, 'order' | 'orderNum'>): number | undefined => {
    if (Number.isFinite(task.order)) return task.order as number;
    if (Number.isFinite(task.orderNum)) return task.orderNum as number;
    return undefined;
};

const getProjectOrderIndex = (tasks: Task[]): Map<string, number> => {
    if (projectOrderCacheRef === tasks && projectOrderCacheValue) {
        return projectOrderCacheValue;
    }
    const nextCache = new Map<string, number>();
    for (const task of tasks) {
        if (task.deletedAt || !task.projectId) continue;
        const order = getTaskOrder(task) ?? -1;
        const previous = nextCache.get(task.projectId) ?? -1;
        if (order > previous) {
            nextCache.set(task.projectId, order);
        }
    }
    projectOrderCacheRef = tasks;
    projectOrderCacheValue = nextCache;
    if (reservedProjectOrdersRef !== tasks) {
        reservedProjectOrdersRef = tasks;
        reservedProjectOrdersValue = null;
    }
    return nextCache;
};

export const getNextProjectOrder = (
    projectId: string | undefined,
    tasks: Task[]
): number | undefined => {
    if (!projectId) return undefined;
    return (getProjectOrderIndex(tasks).get(projectId) ?? -1) + 1;
};

export const reserveNextProjectOrder = (
    projectId: string | undefined,
    tasks: Task[]
): number | undefined => {
    if (!projectId) return undefined;
    if (reservedProjectOrdersRef !== tasks || !reservedProjectOrdersValue) {
        reservedProjectOrdersRef = tasks;
        reservedProjectOrdersValue = new Map<string, number>();
    }
    const snapshotReservations = reservedProjectOrdersValue;
    const reserved = snapshotReservations.get(projectId);
    if (typeof reserved === 'number') {
        snapshotReservations.set(projectId, reserved + 1);
        return reserved;
    }
    const nextOrder = getNextProjectOrder(projectId, tasks);
    if (typeof nextOrder !== 'number') return undefined;
    snapshotReservations.set(projectId, nextOrder + 1);
    return nextOrder;
};
