import { mergeTaskDraftAttachments } from './attachment-editor-model';
import { taskEditValuesEqual } from './json-value-equality';
import { logInfo, logWarn } from './logger';
import { useTaskStore } from './store';
import type { StoreActionResult } from './store-types';
import { runStoreCommand } from './store-write-gate';
import type { Attachment, Project, Task } from './types';

/**
 * Writes that build a whole field (an attachment list, a checklist, tags) from the row as it is when the write is
 * admitted (store-write-gate.ts). A sync save admitted first publishes newer rows, so a list built from an earlier
 * read would drop what that save brought (a sibling attachment another device added) at a new revision.
 * [build] answers the updates for the latest row, or null to write nothing.
 */
const missing = (kind: string): StoreActionResult => ({ success: false, error: `${kind} not found` });

/** The one diagnostic line for a write refused because its row changed elsewhere (no task content). */
export const logStaleWriteRefused = (operation: string): void => {
    try {
        logWarn('Store write refused: the row changed on another device', {
            scope: 'store', category: 'sync',
            context: { releaseCheck: 'v1.3.7/sync-write-gate', outcome: 'stale-refused', operation },
        });
    } catch { /* a diagnostic line never fails its write */ }
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

/** batchUpdateTasks with each task's updates built from its latest row; a task that is gone is skipped. */
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

/** The draft's adds and removals since [base], applied to [latest]: a token another device added stays. */
const mergeTokenList = (base: readonly string[] = [], draft: readonly string[] = [], latest: readonly string[] = []): string[] => {
    const removed = new Set(base.filter((token) => !draft.includes(token)));
    const kept = latest.filter((token) => !removed.has(token));
    return [...kept, ...draft.filter((token) => !base.includes(token) && !kept.includes(token))];
};

type ChecklistItem = NonNullable<Task['checklist']>[number];
/**
 * The draft's checklist adds, edits and removals since [base], by item id, applied to [latest]. An item both sides
 * edited merges by field: the user's rename and another device's tick both stay.
 */
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

/** The one diagnostic line for a draft save that kept items another device synced (field names only, never text). */
const logSyncedChangeKept = (entity: 'task' | 'project', fields: string[]): void => {
    if (fields.length === 0) return;
    try {
        logInfo('Draft saved onto a synced change', {
            scope: 'store', category: 'sync',
            context: { releaseCheck: 'v1.3.7/sync-field-merge', entity, fields: fields.join(',') },
        });
    } catch { /* a diagnostic line never fails its write */ }
};

const TASK_LIST_FIELDS = new Set<keyof Task>(['tags', 'contexts', 'checklist', 'attachments']);

/** mergeTaskDraftOntoLatest's result and the list fields whose merge kept items from both sides. */
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
        // Logged only when something of the other side's survived: the merge wrote more than the draft alone.
        if (TASK_LIST_FIELDS.has(key) && !taskEditValuesEqual(merged[key], value)) keptLists.push(key);
    }
    // The store reads a start or due change that comes without the offset as a hand-set start and ends the relative
    // link (task-draft.ts, task-relative-start.ts): a draft that keeps the link sends it with its date change.
    if (updates.relativeStartOffset && ('startTime' in merged || 'dueDate' in merged)) {
        merged.relativeStartOffset = updates.relativeStartOffset;
    }
    return { merged: merged as Partial<Task>, keptLists };
};

/**
 * A draft's save as a field-level three-way merge (the editor and Process Inbox drafts): only the fields the draft
 * changed since [base] are written. When the latest row still holds [base]'s value, the draft's value is written as it
 * is (a reorder stays). When another device changed the same field too, lists merge (tags and contexts by token, the
 * checklist by item id and then by field, attachments by core's mergeTaskDraftAttachments, which also appends new ones)
 * and a single value takes the draft's (last write wins). [base] is the row the draft was opened or last saved on.
 * [keepUntouched]: a field the draft did not change is still written when no other device changed it either, so the
 * write carries the same fields as before (Process Inbox's frozen writes).
 */
export const mergeTaskDraftOntoLatest = (
    base: Task,
    updates: Partial<Task>,
    latest: Task,
    options: { keepUntouched?: boolean } = {},
): Partial<Task> => mergeTaskDraft(base, updates, latest, options).merged;

const wrote = (result: unknown): boolean => result !== false
    && !(result && typeof result === 'object' && (result as { success?: unknown }).success === false);

/**
 * Saves a task draft on the latest row inside one store command (mergeTaskDraftOntoLatest), through the screen's own
 * task writer ([write]; the store's updateTask by default) and reader ([read], for a test that replaces the store
 * hook). A save that kept items another device synced into a list it also changed logs v1.3.7/sync-field-merge once
 * the write succeeds. A task no longer stored gets [updates] as they are.
 */
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

/** Saves a task draft on the latest row through the store, by saveTaskDraftOntoLatest; an empty merge writes nothing. */
export const updateTaskFromDraft = (id: string, base: Task, updates: Partial<Task>): Promise<StoreActionResult> =>
    saveTaskDraftOntoLatest(id, base, updates, {
        write: (taskId, next) => (Object.keys(next).length > 0 ? useTaskStore.getState().updateTask(taskId, next) : { success: true, id: taskId }),
    });

/** A project draft's save, field by field as for tasks: tagIds merge by token, other fields take the draft's value. */
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
/**
 * A settings write built from the settings as stored when it is admitted: a page that sends a whole group (gtd, ai)
 * built from its rendered copy would put back a key another device changed since. [build] answers the updates, or null
 * to write nothing. [write] is the screen's own settings writer (the store's updateSettings by default); [read] is
 * where it reads the settings (the store's by default; a test that replaces the store hook passes its own).
 * Resolves true when it wrote.
 */
export const updateSettingsFromLatest = (
    build: (settings: Settings) => Partial<Settings> | null | undefined,
    options: { write?: (updates: Partial<Settings>) => Promise<unknown> | unknown; read?: () => Settings | undefined } = {},
): Promise<boolean> => runStoreCommand(async () => {
    const updates = build((options.read ?? (() => useTaskStore.getState().settings))() ?? {});
    if (!updates) return false;
    await (options.write ?? ((next: Partial<Settings>) => useTaskStore.getState().updateSettings(next)))(updates);
    return true;
});
