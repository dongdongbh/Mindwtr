import { createNextRecurringTask, normalizeRecurrenceForLoad } from './recurrence';
import { getTaskDateCoherenceIssues } from './task-date-coherence';
import {
    createTaskTokenUsageAccumulator,
    getUsedTaskTokensFromUsage,
} from './task-token-usage';
import { resolveRelativeStartUpdates } from './task-relative-start';
import { compareTasksByProjectOrder, isTaskFutureStart, rescheduleTask, shouldAutoArchiveCompletedTask, baseTextCollator } from './task-utils';
import { isTaskActionable, isTaskFinished } from './task-status';
import { safeParseDate } from './date';
import { filterNotDeleted } from './sync-helpers';
import { nextRevision, normalizeRevision } from './sync-revision';
import type { AiSettings, AppData, Area, Attachment, Person, Project, Section, Task, TaskStatus } from './types';
import { generateUUID as uuidv4 } from './uuid';
import type { DerivedState, SaveBaseState, TaskStore } from './store-types';

const hasOwnField = (value: object, field: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, field);

export { MAX_SYNC_REVISION, normalizeRevision, nextRevision } from './sync-revision';

type EntityWithId = { id: string };
type EntityWithRevision = EntityWithId & {
    updatedAt?: string;
    rev?: number;
    revBy?: string;
    deletedAt?: string;
    purgedAt?: string;
};

export const getNextDataChangeAt = (previous: number, now = Date.now()): number => (
    Math.max(now, previous + 1)
);

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
    relativeStartOffset: undefined,
    reviewAt: undefined,
    recurrence: undefined,
    priority: undefined,
    timeEstimate: undefined,
    suppressMindwtrReminders: undefined,
    repeatReminderMinutes: undefined,
    showFutureRecurrence: undefined,
    isFocusedToday: false,
    focusOrder: undefined,
    boardOrder: undefined,
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

    // A caller-supplied completedAt backdates the completion (e.g. "I actually
    // finished this yesterday") and must also anchor after-completion recurrence,
    // because the next instance is spawned here and never recomputed later.
    const explicitCompletedAt = typeof updates.completedAt === 'string' && safeParseDate(updates.completedAt)
        ? updates.completedAt
        : undefined;

    // A manual Focus position only means something while the task is in Today's
    // Focus (types.ts: focusOrder is "cleared when the task leaves Today's
    // Focus"). Completing or archiving unstars the task below, so focusOrder
    // must go with it too, unless the same patch sets focusOrder itself
    // (mirrors the guard in normalizeTaskUpdate).
    const clearsFocusOrder = oldTask.focusOrder !== undefined && !hasOwnField(updates, 'focusOrder')
        ? { focusOrder: undefined }
        : {};

    if (statusChanged && incomingStatus === 'done') {
        const isReturningFromArchive = oldTask.status === 'archived';
        const completedAt = explicitCompletedAt ?? (isReturningFromArchive ? (oldTask.completedAt || now) : now);
        finalUpdates = {
            ...updatesToApply,
            status: incomingStatus,
            completedAt,
            isFocusedToday: false,
            ...clearsFocusOrder,
        };
        // Moving an already-completed task back from Archived is a lifecycle
        // correction, not another completion event. Preserve its completion
        // timestamp and do not create a duplicate recurring occurrence.
        nextRecurringTask = isReturningFromArchive
            ? null
            : createNextRecurringTask(oldTask, completedAt, oldTask.status);
    } else if (statusChanged && incomingStatus === 'archived') {
        finalUpdates = {
            ...updatesToApply,
            status: incomingStatus,
            completedAt: explicitCompletedAt ?? (oldTask.completedAt || now),
            isFocusedToday: false,
            ...clearsFocusOrder,
        };
    } else if (statusChanged && isTaskFinished(oldTask.status) && !isTaskFinished(incomingStatus)) {
        finalUpdates = {
            ...updatesToApply,
            status: incomingStatus,
            completedAt: undefined,
        };
    }

    if (incomingStatus !== 'reference') {
        finalUpdates = resolveRelativeStartUpdates(oldTask, finalUpdates);
    }

    if (Object.prototype.hasOwnProperty.call(finalUpdates, 'dueDate') && incomingStatus !== 'reference') {
        const rescheduled = rescheduleTask(oldTask, finalUpdates.dueDate);
        finalUpdates = {
            ...finalUpdates,
            dueDate: rescheduled.dueDate,
            pushCount: hasOwnField(finalUpdates, 'pushCount')
                ? finalUpdates.pushCount
                : rescheduled.pushCount,
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

/**
 * Applies the store's task-update invariants (schedule-edit unstar, star/status
 * promotion and demotion, boardOrder reset on status change, focusOrder clear on
 * unstar) to a raw patch before it reaches {@link applyTaskUpdates}. Pure and
 * side-effect free so both the desktop/mobile store and the cloud REST API can
 * share the exact same write-path rules (P9, single write path).
 */
export const normalizeTaskUpdate = (
    task: Task,
    updates: Partial<Task>,
    /**
     * Settings enable the rules that depend on them; without them the update is
     * normalized exactly as before (the cloud PATCH path passes none).
     */
    context?: { settings?: AppData['settings']; nowMs?: number },
): Partial<Task> => {
    let adjustedUpdates = updates;
    if (hasOwnField(updates, 'recurrence')) {
        const recurrence = normalizeRecurrenceForLoad(updates.recurrence);
        const existingRecurrence = normalizeRecurrenceForLoad(task.recurrence);
        const existingSeriesId = existingRecurrence?.seriesId ?? task.id;
        const seriesId = recurrence?.seriesId ?? existingSeriesId;
        const completedOccurrences = recurrence?.completedOccurrences
            ?? (recurrence?.count && seriesId === existingSeriesId
                ? existingRecurrence?.completedOccurrences
                : undefined);
        adjustedUpdates = {
            ...adjustedUpdates,
            recurrence: recurrence
                ? {
                    ...recurrence,
                    seriesId,
                    ...(completedOccurrences !== undefined ? { completedOccurrences } : {}),
                }
                : undefined,
        };
    }
    const hasOrder = hasOwnField(updates, 'order');
    const hasOrderNum = hasOwnField(updates, 'orderNum');
    if (hasOrder || hasOrderNum) {
        const normalizedOrder = getTaskOrder(updates);
        adjustedUpdates = {
            ...adjustedUpdates,
            order: normalizedOrder,
            orderNum: normalizedOrder,
        };
    }
    // A schedule edit that defers the task (future start, or a recurring task
    // hidden until its due/review date, #843) drops the Today star with it:
    // the row leaves Focus either way, and a star surviving invisibly would
    // resurface unasked when the deferral ends. Evaluated on the merged task so
    // e.g. clearing the start of a recurring due-later task also unstars.
    const editsSchedule = hasOwnField(updates, 'startTime')
        || hasOwnField(updates, 'dueDate')
        || hasOwnField(updates, 'reviewAt')
        || hasOwnField(updates, 'recurrence');
    if (editsSchedule && isTaskFutureStart({ ...task, ...adjustedUpdates })) {
        adjustedUpdates = {
            ...adjustedUpdates,
            isFocusedToday: false,
        };
    }
    // Star ↔ status invariant: starring an unprocessed inbox task promotes it
    // to next (committing to do it today is a clarify decision), and demoting a
    // starred task to inbox takes the star with it. When one patch does both,
    // the star (the more deliberate action) wins. Review-due waiting/someday
    // tasks deliberately KEEP their status when starred — "chase this today"
    // does not stop the task being waiting-for. Creation-side promotion lives
    // in resolveCaptureStatusForStart, where focus eligibility is evaluated
    // before the star commits.
    // Setting a start date on an Inbox task is itself a clarify decision ("I
    // decided when I can act on this") and promotes it to next, mirroring the
    // star promotion below. An Inbox task with a start date is invisible in
    // Focus/Next and reads as a bug. Unlike the star, an explicit status in the
    // SAME patch always wins (a start date is a weaker signal than a star), so
    // this only fires when the patch carries no status of its own; a same-value
    // re-save or a clear (undefined/null/'') never promotes; Someday/Waiting
    // keep their status (a dated someday is a tickler, a dated waiting a
    // follow-up reminder — only Inbox means "unclarified").
    const startPromotingInbox = hasOwnField(updates, 'startTime')
        && !hasOwnField(updates, 'status')
        && updates.startTime != null
        && updates.startTime !== ''
        && updates.startTime !== task.startTime
        && task.status === 'inbox';
    const starTurningOn = adjustedUpdates.isFocusedToday === true && task.isFocusedToday !== true;
    const statusBecomingInbox = hasOwnField(updates, 'status') && updates.status === 'inbox' && task.status !== 'inbox';
    if (statusBecomingInbox && !starTurningOn) {
        if ((hasOwnField(adjustedUpdates, 'isFocusedToday') ? adjustedUpdates.isFocusedToday : task.isFocusedToday) === true) {
            adjustedUpdates = {
                ...adjustedUpdates,
                isFocusedToday: false,
            };
        }
    } else if (
        (starTurningOn && (hasOwnField(updates, 'status') ? updates.status : task.status) === 'inbox')
        || startPromotingInbox
    ) {
        adjustedUpdates = {
            ...adjustedUpdates,
            status: 'next',
        };
    }
    if (
        hasOwnField(adjustedUpdates, 'status')
        && adjustedUpdates.status !== task.status
        && !hasOwnField(updates, 'boardOrder')
    ) {
        adjustedUpdates = {
            ...adjustedUpdates,
            boardOrder: undefined,
        };
    }
    // A manual Focus position only means something while the task is in
    // Today's Focus: any path that turns isFocusedToday off — explicit unstar
    // or one of the auto-unstars above (future-start defer, demotion to
    // inbox) — drops focusOrder with it, unless the same patch sets
    // focusOrder itself.
    const resolvedIsFocusedToday = hasOwnField(adjustedUpdates, 'isFocusedToday')
        ? adjustedUpdates.isFocusedToday
        : task.isFocusedToday;
    if (
        task.isFocusedToday === true
        && resolvedIsFocusedToday !== true
        && !hasOwnField(updates, 'focusOrder')
    ) {
        adjustedUpdates = {
            ...adjustedUpdates,
            focusOrder: undefined,
        };
    }
    // Correcting a completion time to something older than the auto-archive
    // window files the task away now, instead of leaving it in Done until the
    // twice-daily sweep runs — which read as the setting being broken (#959).
    // Only an edit that carries no status *change* of its own: an absent
    // status field, or the same status resent by a full-editor patch (the
    // desktop editor's submit always includes `status: draft.status`). A
    // genuine status transition — e.g. moving a task back to Done from
    // Archive — deliberately keeps its old completion time, and re-archiving
    // it in the same write would make that action a no-op.
    const archiveEditNowMs = context?.nowMs ?? Date.now();
    if (
        context?.settings
        && hasOwnField(updates, 'completedAt')
        && (!hasOwnField(updates, 'status') || updates.status === task.status)
        && task.status === 'done'
        && shouldAutoArchiveCompletedTask(
            // Evaluated against the post-stamp updatedAt (applyTaskUpdates
            // hasn't run yet here), so a patch that clears/invalidates
            // completedAt falls back to "now" instead of the task's pre-edit
            // updatedAt — matching what the load-time sweep would conclude
            // after the write, instead of archiving a task the user just touched.
            { ...task, ...adjustedUpdates, updatedAt: new Date(archiveEditNowMs).toISOString() },
            context.settings,
            archiveEditNowMs,
        )
    ) {
        adjustedUpdates = {
            ...adjustedUpdates,
            status: 'archived',
            isFocusedToday: false,
        };
    }
    return adjustedUpdates;
};

/**
 * A start date at capture is a clarify decision, so a task created with a
 * start date and no explicit status enters as Next rather than Inbox (mirrors
 * the update-path promotion in {@link normalizeTaskUpdate}). An explicit
 * status always wins — importers and API writers that state status
 * deliberately are honoured, including an explicit 'inbox'. Unlike the star
 * creation path there is no focus cap or eligibility gate: nothing is being
 * starred. Shared by the store's addTasks and the cloud REST API's task
 * creation handler so the rule cannot drift between them.
 */
export const resolveCaptureStatusForStart = (
    initialProps: Partial<Task>,
    resolvedStatus: TaskStatus,
): TaskStatus => {
    const startPromotesToNext = !hasOwnField(initialProps, 'status')
        && resolvedStatus === 'inbox'
        && initialProps.startTime != null
        && initialProps.startTime !== '';
    return startPromotesToNext ? 'next' : resolvedStatus;
};

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
    const visibleAttachments = filterNotDeleted(attachments);
    return visibleAttachments.length === attachments.length
        ? task
        : { ...task, attachments: visibleAttachments };
};

export const selectVisibleTasks = (tasks: Task[]): Task[] =>
    tasks.filter((task) => isTaskVisible(task)).map(toVisibleTask);

export const selectVisibleProjects = (projects: Project[]): Project[] =>
    filterNotDeleted(projects);

export const selectVisibleSections = (sections: Section[]): Section[] =>
    filterNotDeleted(sections);

export const selectVisibleAreas = (areas: Area[]): Area[] =>
    filterNotDeleted(areas);

export const selectVisiblePeople = (people: Person[]): Person[] =>
    filterNotDeleted(people).sort((a, b) => baseTextCollator.compare(a.name, b.name));

export const completeTaskForProjectArchive = (task: Task, archivedAt: string, deviceId?: string): Task => ({
    ...task,
    status: 'done',
    completedAt: archivedAt,
    isFocusedToday: false,
    statusBeforeProjectArchive: task.status,
    completedAtBeforeProjectArchive: task.completedAt ?? null,
    isFocusedTodayBeforeProjectArchive: task.isFocusedToday ?? null,
    projectArchivedAt: archivedAt,
    updatedAt: archivedAt,
    rev: nextRevision(task.rev),
    revBy: deviceId,
});

export const restoreTaskFromProjectArchive = (task: Task, restoredAt: string, deviceId?: string): Task => {
    const previousStatus = task.statusBeforeProjectArchive;
    const archivedAt = task.projectArchivedAt;
    const shouldRestore =
        !task.deletedAt &&
        Boolean(previousStatus) &&
        !isTaskFinished(previousStatus) &&
        task.status === 'done' &&
        Boolean(archivedAt) &&
        task.completedAt === archivedAt;

    if (!shouldRestore) {
        return task;
    }

    return {
        ...task,
        status: previousStatus!,
        completedAt: task.completedAtBeforeProjectArchive ?? undefined,
        isFocusedToday: task.isFocusedTodayBeforeProjectArchive ?? false,
        statusBeforeProjectArchive: undefined,
        completedAtBeforeProjectArchive: undefined,
        isFocusedTodayBeforeProjectArchive: undefined,
        projectArchivedAt: undefined,
        updatedAt: restoredAt,
        rev: nextRevision(task.rev),
        revBy: deviceId,
    };
};

const hasTaskProjectArchiveMetadata = (task: Task): boolean => (
    task.projectArchivedAt !== undefined
    || task.statusBeforeProjectArchive !== undefined
    || task.completedAtBeforeProjectArchive !== undefined
    || task.isFocusedTodayBeforeProjectArchive !== undefined
);

export const clearDeletedTaskProjectArchiveMetadata = (task: Task): Task => {
    if (!task.deletedAt || !hasTaskProjectArchiveMetadata(task)) return task;
    return {
        ...task,
        statusBeforeProjectArchive: undefined,
        completedAtBeforeProjectArchive: undefined,
        isFocusedTodayBeforeProjectArchive: undefined,
        projectArchivedAt: undefined,
    };
};

export const archiveSectionForProjectArchive = (section: Section, archivedAt: string, deviceId?: string): Section => ({
    ...section,
    deletedAt: archivedAt,
    deletedAtBeforeProjectArchive: section.deletedAt ?? null,
    projectArchivedAt: archivedAt,
    updatedAt: archivedAt,
    rev: nextRevision(section.rev),
    revBy: deviceId,
});

export const restoreSectionFromProjectArchive = (section: Section, restoredAt: string, deviceId?: string): Section => {
    const archivedAt = section.projectArchivedAt;
    const shouldRestore =
        Boolean(archivedAt) &&
        section.deletedAt === archivedAt &&
        section.deletedAtBeforeProjectArchive === null;

    if (!shouldRestore) {
        return section;
    }

    return {
        ...section,
        deletedAt: undefined,
        deletedAtBeforeProjectArchive: undefined,
        projectArchivedAt: undefined,
        updatedAt: restoredAt,
        rev: nextRevision(section.rev),
        revBy: deviceId,
    };
};

export const buildEntityMap = <T extends EntityWithId>(items: readonly T[]): Map<string, T> =>
    new Map(items.map((item) => [item.id, item] as const));

export const replaceEntityInArray = <T extends EntityWithId>(items: readonly T[], id: string, nextItem: T): T[] => {
    const index = items.findIndex((item) => item.id === id);
    if (index < 0) return items as T[];
    if (items[index] === nextItem) return items as T[];
    const nextItems = items.slice();
    nextItems[index] = nextItem;
    return nextItems;
};

export const replaceEntitiesInArray = <T extends EntityWithId>(
    items: readonly T[],
    nextItems: readonly T[]
): T[] => {
    if (nextItems.length === 0) return items as T[];
    const replacementsById = new Map(nextItems.map((item) => [item.id, item] as const));
    let patchedItems: T[] | null = null;
    for (let index = 0; index < items.length; index += 1) {
        const currentItem = items[index];
        const nextItem = replacementsById.get(currentItem.id);
        if (!nextItem || nextItem === currentItem) continue;
        if (!patchedItems) patchedItems = items.slice();
        patchedItems[index] = nextItem;
    }
    return patchedItems ?? items as T[];
};

export const replaceEntityInMap = <T extends EntityWithId>(
    itemsById: Map<string, T>,
    nextItem: T
): Map<string, T> => {
    if (itemsById.get(nextItem.id) === nextItem) return itemsById;
    const nextItemsById = new Map(itemsById);
    nextItemsById.set(nextItem.id, nextItem);
    return nextItemsById;
};

export const reuseArrayIfShallowEqual = <T>(previous: T[], next: T[]): T[] => (
    previous.length === next.length && previous.every((item, index) => item === next[index])
        ? previous
        : next
);

// Attachments carry their own per-record LWW (deletedAt, cloudKey, localStatus,
// contentRev) and a merge can change them WITHOUT touching the owner's revision
// tuple. Reusing the existing owner object on that tuple alone kept a task's
// pre-merge attachments alive in the store; the post-load persist then wrote
// them back over what the sync cycle had just stored, every cycle (#1136).
const haveSameAttachments = (left?: Attachment[], right?: Attachment[]): boolean => {
    if (left === right) return true;
    const leftItems = left ?? [];
    const rightItems = right ?? [];
    if (leftItems.length !== rightItems.length) return false;
    for (let index = 0; index < leftItems.length; index += 1) {
        if (leftItems[index] === rightItems[index]) continue;
        if (JSON.stringify(leftItems[index]) !== JSON.stringify(rightItems[index])) return false;
    }
    return true;
};

export const hasSameEntityIdentity = <T extends EntityWithRevision>(existing: T, incoming: T): boolean => (
    existing.updatedAt === incoming.updatedAt
    && normalizeRevision(existing.rev) === normalizeRevision(incoming.rev)
    && existing.revBy === incoming.revBy
    && existing.deletedAt === incoming.deletedAt
    && existing.purgedAt === incoming.purgedAt
    && haveSameAttachments(
        (existing as { attachments?: Attachment[] }).attachments,
        (incoming as { attachments?: Attachment[] }).attachments,
    )
);

export const reconcileEntityCollection = <T extends EntityWithRevision>(
    previousItems: readonly T[],
    previousById: Map<string, T>,
    incomingItems: readonly T[]
): { items: T[]; byId: Map<string, T>; replacedCount: number } => {
    let changed = previousItems.length !== incomingItems.length;
    let replacedCount = 0;
    const nextItems = incomingItems.map((incoming, index) => {
        const existing = previousById.get(incoming.id);
        const reuseExisting = existing != null && hasSameEntityIdentity(existing, incoming);
        if (!reuseExisting) {
            replacedCount += 1;
        }
        const resolved = reuseExisting ? existing : incoming;
        if (!changed && previousItems[index] !== resolved) {
            changed = true;
        }
        return resolved;
    });

    if (!changed) {
        return {
            items: previousItems as T[],
            byId: previousById,
            replacedCount,
        };
    }

    return {
        items: nextItems,
        byId: buildEntityMap(nextItems),
        replacedCount,
    };
};

// Device-local sync status stamps; they change every sync cycle and are
// overlaid from local storage on each platform, so a settings object that
// differs only in these keys is behaviorally identical for every subscriber.
const VOLATILE_SYNC_STATUS_SETTINGS_KEYS = [
    'lastSyncAt',
    'lastSyncStatus',
    'lastSyncError',
    'lastSyncStats',
    'lastSyncHistory',
] as const;

const withoutVolatileSyncStatus = (settings: AppData['settings']): Record<string, unknown> => {
    const copy: Record<string, unknown> = { ...(settings ?? {}) };
    for (const key of VOLATILE_SYNC_STATUS_SETTINGS_KEYS) {
        delete copy[key];
    }
    return copy;
};

/**
 * Reuse the previous settings object identity when the incoming settings are
 * content-equal apart from the device-local `lastSync*` status keys. A fresh
 * identity per fetch re-renders every settings subscriber and re-arms the
 * mobile reminder rescheduler after every sync cycle (#766); keeping the old
 * identity also keeps its fresher local sync-status overlay, which the next
 * persistSyncStatus patch refreshes anyway. Comparison failures fall back to
 * the incoming object (no reuse), never the other way around.
 */
export const reuseSettingsIfEquivalent = (
    previous: AppData['settings'] | undefined,
    next: AppData['settings']
): AppData['settings'] => {
    if (!previous) return next;
    if (previous === next) return previous;
    try {
        return JSON.stringify(withoutVolatileSyncStatus(previous)) === JSON.stringify(withoutVolatileSyncStatus(next))
            ? previous
            : next;
    } catch {
        return next;
    }
};

const assertCollectionSnapshotIncludesExistingItems = <T extends EntityWithId>(
    label: string,
    nextItems: T[],
    previousItems: T[]
): void => {
    if (nextItems === previousItems) return;
    // Length tells nothing: a snapshot that drops N rows while adding N others
    // is exactly as partial as one that just drops them.
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
    const people = overrides?.people ?? state._allPeople;
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
    if (overrides?.people) {
        assertCollectionSnapshotIncludesExistingItems<Person>('person', people, state._allPeople);
    }
    return {
        tasks,
        projects,
        sections,
        areas,
        people,
        settings: overrides?.settings ?? state.settings,
    };
};

type PersistSet = (partial: Partial<TaskStore> | ((state: TaskStore) => Partial<TaskStore> | TaskStore)) => void;
type PersistDebouncedSave = (data: AppData, onError?: (msg: string) => void) => void;

/**
 * The store-write enqueue ritual, in one call: build the full-document
 * snapshot via {@link buildSaveSnapshot} (so the partial-snapshot guard always
 * runs) and hand it to the caller's debounced save with the store's standard
 * error write. Call it from inside the `set()` producer that computed
 * `overrides`, using that producer's own `state` argument.
 *
 * `debouncedSave` CAN call `set` synchronously here: a full pending-save queue
 * makes `enforcePendingSaveCap` write `error` (via `setError`, and via every
 * dropped save's `onError`) before `debouncedSave` returns. That nested write
 * still lands correctly because zustand's merge re-reads its module-level
 * state — but only if the *outer* producer's own return value is a partial,
 * not the `state` identity it was given. Callers must never `return state`
 * after calling `persist` in the same branch — return a fresh partial/object
 * instead — or the outer merge's last-write-wins `Object.assign` clobbers the
 * nested error write with the pre-nested state.
 */
export const persist = (
    set: PersistSet,
    debouncedSave: PersistDebouncedSave,
    state: SaveBaseState,
    overrides?: Partial<AppData>,
): void => {
    const snapshot = buildSaveSnapshot(state, overrides);
    debouncedSave(snapshot, (msg) => set({ error: msg }));
};

export const computeDerivedState = (tasks: Task[], projects: Project[]): DerivedState => {
    const projectDerived = computeProjectDerivedState(projects);
    const taskDerived = computeTaskDerivedState(tasks);

    return {
        ...projectDerived,
        ...taskDerived,
    };
};

export const computeProjectDerivedState = (
    projects: Iterable<Project>,
    projectMap?: Map<string, Project>
): Pick<DerivedState, 'projectMap' | 'sequentialProjectIds' | 'sequentialWithinSectionProjectIds' | 'focusedProjectCount'> => {
    const resolvedProjectMap = projectMap ?? new Map<string, Project>();
    const sequentialProjectIds = new Set<string>();
    const sequentialWithinSectionProjectIds = new Set<string>();
    let focusedProjectCount = 0;

    for (const project of projects) {
        if (!projectMap) {
            resolvedProjectMap.set(project.id, project);
        }
        if (project.deletedAt) continue;
        if (project.isSequential) {
            sequentialProjectIds.add(project.id);
            if (project.sequentialScope === 'section') {
                sequentialWithinSectionProjectIds.add(project.id);
            }
        }
        if (project.isFocused) {
            focusedProjectCount += 1;
        }
    }

    return {
        projectMap: resolvedProjectMap,
        sequentialProjectIds,
        sequentialWithinSectionProjectIds,
        focusedProjectCount,
    };
};

// Shared by computeTaskDerivedState's focusedCount tally and selectFocusedCount
// below so the two can never drift. Mirrors computeTaskDerivedState's early
// `if (task.deletedAt) return` (a deleted task never counts, even if fed an
// unfiltered array) plus its focus rule: done/reference/archived tasks keep
// their historical focus flag but should not consume today's focus limit —
// the Focus views never show them, so a counted-but-invisible star would eat
// a slot the user cannot free.
const isTaskCountedAsFocused = (task: Task): boolean => (
    !task.deletedAt
    && task.isFocusedToday === true
    && task.status !== 'done' && task.status !== 'reference' && task.status !== 'archived'
);

let focusedCountCache: { tasks: Task[]; count: number } | null = null;

// Cheap alternative to getDerivedState().focusedCount for callers that only
// need the count: a single linear scan, cached by array identity so repeat
// reads against the same `tasks` array (the common case within one render/
// notify) are free. Unlike getDerivedState's cache, this never misses on a
// task write that leaves the focus set alone — it only recomputes when the
// `tasks` array identity itself changes. Must read the SAME collection
// (visible tasks) with the SAME predicate as computeTaskDerivedState.
export const selectFocusedCount = (tasks: Task[]): number => {
    if (focusedCountCache && focusedCountCache.tasks === tasks) {
        return focusedCountCache.count;
    }
    let count = 0;
    for (const task of tasks) {
        if (isTaskCountedAsFocused(task)) count += 1;
    }
    focusedCountCache = { tasks, count };
    return count;
};

export const computeTaskDerivedState = (
    tasks: Task[],
    tasksById?: Map<string, Task>
): Pick<DerivedState, 'tasksById' | 'activeTasksByStatus' | 'tasksByProjectId' | 'tasksByContext' | 'tasksByTag' | 'focusedTasks' | 'projectTaskSummaryById' | 'allContexts' | 'allTags' | 'contextTokenUsage' | 'tagTokenUsage' | 'dateCoherenceIssuesByTaskId' | 'focusedCount'> => {
    const resolvedTasksById = tasksById ?? new Map<string, Task>();
    const activeTasksByStatus = new Map<TaskStatus, Task[]>();
    const tasksByProjectId = new Map<string, Task[]>();
    const tasksByContext = new Map<string, Task[]>();
    const tasksByTag = new Map<string, Task[]>();
    const focusedTasks: Task[] = [];
    const projectTaskSummaryById = new Map<string, { activeTaskCount: number; nextAction?: Task }>();
    const dateCoherenceIssuesByTaskId = new Map<string, ReturnType<typeof getTaskDateCoherenceIssues>>();
    // Accumulated in the main loop below rather than in two extra full passes over `tasks`
    // (A-04). The accumulator carries collectTaskTokenUsage's own inclusion rule, so the
    // deleted-task handling and first-seen ordering stay identical.
    const contextTokens = createTaskTokenUsageAccumulator({ prefix: '@' });
    const tagTokens = createTaskTokenUsageAccumulator({ prefix: '#' });
    let focusedCount = 0;

    tasks.forEach((task) => {
        if (!tasksById) {
            resolvedTasksById.set(task.id, task);
        }
        if (task.deletedAt) return;
        const list = activeTasksByStatus.get(task.status) ?? [];
        list.push(task);
        activeTasksByStatus.set(task.status, list);
        if (task.projectId) {
            const projectTasks = tasksByProjectId.get(task.projectId) ?? [];
            projectTasks.push(task);
            tasksByProjectId.set(task.projectId, projectTasks);

            if (isTaskActionable(task)) {
                const summary = projectTaskSummaryById.get(task.projectId) ?? { activeTaskCount: 0 };
                summary.activeTaskCount += 1;
                if (task.status === 'next' && (!summary.nextAction || compareTasksByProjectOrder(task, summary.nextAction) < 0)) {
                    summary.nextAction = task;
                }
                projectTaskSummaryById.set(task.projectId, summary);
            }
        }
        contextTokens.add(task, (candidate) => candidate.contexts);
        tagTokens.add(task, (candidate) => candidate.tags);
        (task.contexts ?? []).forEach((context) => {
            const contextTasks = tasksByContext.get(context) ?? [];
            contextTasks.push(task);
            tasksByContext.set(context, contextTasks);
        });
        (task.tags ?? []).forEach((tag) => {
            const tagTasks = tasksByTag.get(tag) ?? [];
            tagTasks.push(task);
            tasksByTag.set(tag, tagTasks);
        });
        const dateCoherenceIssues = getTaskDateCoherenceIssues(task);
        if (dateCoherenceIssues.length > 0) {
            dateCoherenceIssuesByTaskId.set(task.id, dateCoherenceIssues);
        }
        if (isTaskCountedAsFocused(task)) {
            focusedCount += 1;
            focusedTasks.push(task);
        }
    });

    const contextTokenUsage = contextTokens.toUsage();
    const tagTokenUsage = tagTokens.toUsage();

    return {
        tasksById: resolvedTasksById,
        activeTasksByStatus,
        tasksByProjectId,
        tasksByContext,
        tasksByTag,
        focusedTasks,
        projectTaskSummaryById,
        allContexts: getUsedTaskTokensFromUsage(contextTokenUsage),
        allTags: getUsedTaskTokensFromUsage(tagTokenUsage),
        contextTokenUsage,
        tagTokenUsage,
        dateCoherenceIssuesByTaskId,
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

export const normalizeAiSettingsForSync = (ai?: AiSettings): AiSettings | undefined => {
    if (!ai) return ai;
    const { apiKey: _apiKey, ...rest } = ai;
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
    const nextCache = new Map<string, number>();
    for (const task of tasks) {
        if (task.deletedAt || !task.projectId) continue;
        const order = getTaskOrder(task) ?? -1;
        const previous = nextCache.get(task.projectId) ?? -1;
        if (order > previous) {
            nextCache.set(task.projectId, order);
        }
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

export type ProjectOrderReserver = (projectId: string | undefined) => number | undefined;

export const createProjectOrderReserver = (tasks: Task[]): ProjectOrderReserver => {
    const nextOrders = getProjectOrderIndex(tasks);
    return (projectId: string | undefined): number | undefined => {
        if (!projectId) return undefined;
        const nextOrder = (nextOrders.get(projectId) ?? -1) + 1;
        nextOrders.set(projectId, nextOrder);
        return nextOrder;
    };
};
