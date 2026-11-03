import { mergeTaskDraftAttachments } from './attachment-editor-model';
import { taskEditValuesEqual } from './json-value-equality';
import { logInfo, logWarn } from './logger';
import { useTaskStore } from './store';
import type { StoreActionResult } from './store-types';
import { runStoreCommand } from './store-write-gate';
import type { Attachment, Project, Task } from './types';


const missing = (kind: string): StoreActionResult => ({ success: false, error: `${kind} not found` });


export const logStaleWriteRefused = (operation: string): void => {
    try {
        logWarn('Store write refused: the row changed on another device', {
            scope: 'store', category: 'sync',
            context: { releaseCheck: 'v1.3.7/sync-write-gate', outcome: 'stale-refused', operation },
        });
    } catch {                                               }
};

export const updateTaskFromLatest = (
    id: string,
    build: (task: Task) => Partial<Task> | null,
): Promise<StoreActionResult> => runStoreCommand(async () => {
    const task = useTaskStore.getState()._tasksById.get(id);
    if (!task) return missing('Task');
    const updates = build(task);
    return updates ? useTaskStore.getState().updateTask(id, updates) : { success: true, id };
});

export const updateProjectFromLatest = (
    id: string,
    build: (project: Project) => Partial<Project> | null,
): Promise<StoreActionResult> => runStoreCommand(async () => {
    const project = useTaskStore.getState()._projectsById.get(id);
    if (!project) return missing('Project');
    const updates = build(project);
    return updates ? useTaskStore.getState().updateProject(id, updates) : { success: true, id };
});


export const batchUpdateTasksFromLatest = (
    ids: readonly string[],
    build: (task: Task) => Partial<Task> | null,
): Promise<StoreActionResult> => runStoreCommand(async () => {
    const byId = useTaskStore.getState()._tasksById;
    const updates = ids.flatMap((id) => {
        const task = byId.get(id);
        const next = task ? build(task) : null;
        return next ? [{ id, updates: next }] : [];
    });
    return updates.length > 0 ? useTaskStore.getState().batchUpdateTasks(updates) : { success: true, ids: [] };
});


const mergeTokenList = (base: readonly string[] = [], draft: readonly string[] = [], latest: readonly string[] = []): string[] => {
    const removed = new Set(base.filter((token) => !draft.includes(token)));
    const kept = latest.filter((token) => !removed.has(token));
    return [...kept, ...draft.filter((token) => !base.includes(token) && !kept.includes(token))];
};

type ChecklistItem = NonNullable<Task['checklist']>[number];


const mergeChecklist = (base: readonly ChecklistItem[] = [], draft: readonly ChecklistItem[] = [], latest: readonly ChecklistItem[] = []): ChecklistItem[] => {
    const baseById = new Map(base.map((item) => [item.id, item]));
    const draftById = new Map(draft.map((item) => [item.id, item]));
    const merged = latest.flatMap((item) => {
        const before = baseById.get(item.id);
        const after = draftById.get(item.id);
        if (before && !after) return [];
        if (!before || !after || taskEditValuesEqual(before, after)) return [item];
        const next: Record<string, unknown> = { ...item };
        for (const key of new Set([...Object.keys(before), ...Object.keys(after)]) as Set<keyof ChecklistItem>) {
            if (taskEditValuesEqual(before[key], after[key])) continue;
            if (after[key] === undefined) delete next[key];
            else next[key] = after[key];
        }
        return [next as unknown as ChecklistItem];
    });
    const latestIds = new Set(latest.map((item) => item.id));
    return [...merged, ...draft.filter((item) => !baseById.has(item.id) && !latestIds.has(item.id))];
};


const logSyncedChangeKept = (entity: 'task' | 'project', fields: string[]): void => {
    if (fields.length === 0) return;
    try {
        logInfo('Draft saved onto a synced change', {
            scope: 'store', category: 'sync',
            context: { releaseCheck: 'v1.3.7/sync-field-merge', entity, fields: fields.join(',') },
        });
    } catch {                                               }
};

const TASK_LIST_FIELDS = new Set<keyof Task>(['tags', 'contexts', 'checklist', 'attachments']);


const mergeTaskDraft = (
    base: Task,
    updates: Partial<Task>,
    latest: Task,
    options: { keepUntouched?: boolean },
): { merged: Partial<Task>; keptLists: string[] } => {
    const merged: Record<string, unknown> = {};
    const keptLists: string[] = [];
    for (const key of Object.keys(updates) as Array<keyof Task>) {
        const value = updates[key];
        const syncedChange = !taskEditValuesEqual(latest[key], base[key]);
        if (taskEditValuesEqual(value, base[key])) {
            if (options.keepUntouched && !syncedChange) merged[key] = value;
            continue;
        }
        if (!syncedChange) { merged[key] = value; continue; }
        merged[key] = key === 'tags' || key === 'contexts'
            ? mergeTokenList(base[key], value as string[] | undefined, latest[key])
            : key === 'checklist'
                ? mergeChecklist(base.checklist, value as ChecklistItem[] | undefined, latest.checklist)
                : key === 'attachments'
                    ? mergeTaskDraftAttachments(latest.attachments ?? [], base.attachments ?? [], (value as Attachment[] | undefined) ?? [])
                    : value;

        if (TASK_LIST_FIELDS.has(key) && !taskEditValuesEqual(merged[key], value)) keptLists.push(key);
    }


    if (updates.relativeStartOffset && ('startTime' in merged || 'dueDate' in merged)) {
        merged.relativeStartOffset = updates.relativeStartOffset;
    }
    return { merged: merged as Partial<Task>, keptLists };
};


export const mergeTaskDraftOntoLatest = (
    base: Task,
    updates: Partial<Task>,
    latest: Task,
    options: { keepUntouched?: boolean } = {},
): Partial<Task> => mergeTaskDraft(base, updates, latest, options).merged;

const wrote = (result: unknown): boolean => result !== false
    && !(result && typeof result === 'object' && (result as { success?: unknown }).success === false);


export const saveTaskDraftOntoLatest = <R = StoreActionResult>(
    id: string,
    base: Task,
    updates: Partial<Task>,
    options: {
        write?: (id: string, updates: Partial<Task>) => R | Promise<R>;
        read?: (id: string) => Task | undefined;
        keepUntouched?: boolean;
    } = {},
): Promise<R> => runStoreCommand(async () => {
    const write = options.write ?? ((taskId: string, next: Partial<Task>) => useTaskStore.getState().updateTask(taskId, next) as unknown as R);
    const latest = (options.read ?? ((taskId: string) => useTaskStore.getState()._tasksById.get(taskId)))(id);
    if (!latest) return write(id, updates);
    const { merged, keptLists } = mergeTaskDraft(base, updates, latest, options);
    const result = await write(id, merged);
    if (wrote(result)) logSyncedChangeKept('task', keptLists);
    return result;
});


export const updateTaskFromDraft = (id: string, base: Task, updates: Partial<Task>): Promise<StoreActionResult> =>
    saveTaskDraftOntoLatest(id, base, updates, {
        write: (taskId, next) => (Object.keys(next).length > 0 ? useTaskStore.getState().updateTask(taskId, next) : { success: true, id: taskId }),
    });


export const updateProjectFromDraft = (id: string, base: Project, updates: Partial<Project>): Promise<StoreActionResult> =>
    runStoreCommand(async () => {
        const latest = useTaskStore.getState()._projectsById.get(id);
        if (!latest) return missing('Project');
        const merged: Partial<Project> = {};
        let keptTags = false;
        for (const key of Object.keys(updates) as Array<keyof Project>) {
            const value = updates[key];
            if (taskEditValuesEqual(value, base[key])) continue;
            const synced = key === 'tagIds' && !taskEditValuesEqual(latest.tagIds, base.tagIds);
            (merged as Record<string, unknown>)[key] = synced
                ? mergeTokenList(base.tagIds, value as string[] | undefined, latest.tagIds)
                : value;
            if (synced && !taskEditValuesEqual(merged.tagIds, value)) keptTags = true;
        }
        if (Object.keys(merged).length === 0) return { success: true, id };
        const result = await useTaskStore.getState().updateProject(id, merged);
        if (wrote(result) && keptTags) logSyncedChangeKept('project', ['tagIds']);
        return result;
    });

type Settings = ReturnType<typeof useTaskStore.getState>['settings'];


export const updateSettingsFromLatest = (
    build: (settings: Settings) => Partial<Settings> | null | undefined,
    options: { write?: (updates: Partial<Settings>) => Promise<unknown> | unknown; read?: () => Settings | undefined } = {},
): Promise<boolean> => runStoreCommand(async () => {
    const updates = build((options.read ?? (() => useTaskStore.getState().settings))() ?? {});
    if (!updates) return false;
    await (options.write ?? ((next: Partial<Settings>) => useTaskStore.getState().updateSettings(next)))(updates);
    return true;
});
