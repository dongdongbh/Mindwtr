/**
 * The native host contract for selection mode on the Inbox, Waiting, Someday,
 * Reference and Done lists: React Native's bulk bar (move to a status, Range, add
 * and remove tags, delete with Undo, Someday's Move to section) and Bulk Organize
 * on the Inbox, from core's task-list-bulk-actions.ts. Kept in its own file and
 * spread into createNativeHostContract.
 *
 * Selection state stays with the host, as it stays in React state on mobile:
 *
 * - The selection is the tapped rows in the order they were tapped. Send it as
 *   `taskIds`; a row tap goes in as `selectionEdit` and the view returns the new
 *   `selectedIds` and Range's `anchorId` to keep. Range mode ends after one tap.
 *   Leaving selection mode (the exit button, or any action that `changed`) clears
 *   the selection and the anchor.
 * - Select all is stateless, as on Archive: send `selectAll: { except }` (the rows
 *   deselected since) and the view returns `selectAll: { params, revision, except }`,
 *   the object an action takes. The action resolves it again and refuses with
 *   STALE_REVISION once the rows on screen changed, unless no row it covers now
 *   needs a write (then changed: false, as for the replay of one that landed).
 * - `params` are the list view's own inputs as last sent (the returned
 *   `filters.state`, no `filterEdit`, no paging). A row that a filter or a folded
 *   heading hides is not on screen: it leaves the selection and Select all skips it,
 *   as it does rows whose project is archived (they open read-only).
 * - Bulk Organize's choices are a `draft` the host keeps while the dialog is open
 *   (EMPTY_BULK_ORGANIZE_DRAFT each time it opens). Send it with a control's `edit`
 *   as `organize`; the view returns the new `draft`. Show `validationMessage` after
 *   an Apply while `canApply` is false, until the status or the person changes.
 * - Dates go in only as local days (yyyy-MM-dd); each date field names its picker
 *   start and its Today and Tomorrow chips' values.
 *
 * - The organize dialog's project and area pickers can create one, as on mobile:
 *   their search box offers `create` for a name no option carries, and `submit` is
 *   the search box's Done key (the exact match, or the create). Send a create to
 *   createBulkOrganizeDestination with the draft; keep the `draft` it returns
 *   (the new project or area chosen). Creating writes no task: Apply does. A new
 *   project or area takes the request UUID as its ID, so a replay after a restart
 *   finds the row it made (renamed, archived or deleted since) and adds nothing. A
 *   name an option already carries is refused: choose it with `submit.edit`.
 *
 * Review's selection offers the same dialog: the organize view, its pickers and the
 * draft's Apply check are exported for native-host-contract-review-views.ts, and
 * createBulkOrganizeDestination takes `list: 'review'`.
 *
 * Every write takes a request UUID and retries exactly (native-request-receipts.ts):
 * while its save is owed (SAVE_FAILED) a retry only saves. Each write is
 * target-state (a replay whose target already holds writes nothing) and
 * compare-and-set: explicit rows go with `taskRevisions` (the view's, for exactly
 * the ids sent), and Select all's revision folds in each row's revision, so a
 * replay after a restart refuses (STALE_REVISION) any row changed since. Undo is its
 * own command: a delete's toast carries `undo.action` ({ type: 'restoreTasks' },
 * with the trashed tasks' revisions) to send with a new request UUID.
 *
 * Only functions read this module's imports from native-host-contract.ts, so the
 * import cycle between the two files is safe.
 */
import type { BulkOrganizeTaskUpdateInput } from './bulk-organize';
import { addBulkOrganizeArea, addBulkOrganizeProject } from './bulk-organize-create';
import { collectBulkTaskTokens, type BulkTaskTokenMode } from './bulk-task-tokens';
import { safeParseDate, type DateFormatter } from './date';
import { tFallback } from './i18n';
import { isStatusListTaskReadOnly } from './menu-views-model';
import { NATIVE_HOST_CONTRACT_VERSION, NATIVE_HOST_MAX_WINDOW, type NativeHostResult, type NativeListActionResult, type NativeListToast } from './native-host-contract';
import type { createInboxViewMethods } from './native-host-contract-inbox-view';
import {
    fail,
    isObjectRecord,
    isPaging,
    isText,
    matchesPickerQuery,
    page,
    type createMenuViewMethods,
} from './native-host-contract-menu-views';
import {
    createNativeRequestReceipts,
    isRevisions,
    refuseStaleTasks,
    revisionsToken,
    runStoreWrite,
    settleWrite,
    taskRevisionOf,
    taskRevisionsOf,
    type NativeRevisions,
    type NativeUnsavedWrite,
} from './native-request-receipts';
import { updateRangeSelection } from './range-selection';
import { compareProjectsByPickerOrder, getProjectChoiceState } from './project-utils';
import { useTaskStore } from './store';
import {
    applyBulkOrganizeDraftEdit,
    BULK_ORGANIZE_DATE_FIELDS,
    BULK_ORGANIZE_KEEP,
    BULK_ORGANIZE_NONE,
    BULK_ORGANIZE_STATUS_OPTIONS,
    buildBulkOrganizeDateFieldModel,
    buildBulkOrganizeDialogModel,
    buildBulkOrganizeInput,
    buildTaskListBulkBarModel,
    EMPTY_BULK_ORGANIZE_DRAFT,
    getBulkMoveStatusOptions,
    getBulkOrganizeAreaOptions,
    getBulkOrganizeProjectOptions,
    getTaskListAddTagDialogText,
    getTaskListBulkBusyLabels,
    getTaskListBulkToast,
    getTaskListRemoveTagPickerText,
    planBulkOrganize,
    planBulkTagEdit,
    runTaskListBulkWrite,
    TASK_LIST_BULK_SCREENS,
    type BulkOrganizeDateFieldModel,
    type BulkOrganizeDialogModel,
    type BulkOrganizeDraft,
    type BulkOrganizeDraftEdit,
    type BulkOrganizeTextField,
    type TaskListBulkBarModel,
    type TaskListBulkWrite,
} from './task-list-bulk-actions';
import { getBulkTrashConfirmation, type ListConfirmation } from './trash-view-model';
import type { Area, Project, Task, TaskStatus } from './types';

export type NativeBulkList = 'inbox' | 'waiting' | 'someday' | 'reference' | 'done';
const BULK_LISTS: readonly NativeBulkList[] = ['inbox', 'waiting', 'someday', 'reference', 'done'];

/** Select all: every selectable row on screen for the view's `params`, less `except`. */
export type NativeBulkSelectAll = {
    params: Record<string, unknown>;
    revision: string;
    except?: string[];
};
/** Explicit rows carry the view's `taskRevisions` for exactly those ids; Select all's revision covers its rows. */
type Target = { taskIds: string[]; taskRevisions: NativeRevisions; selectAll?: undefined } | { selectAll: NativeBulkSelectAll; taskIds?: undefined };
export type NativeBulkAction =
    | ({ type: 'moveTasks'; status: TaskStatus } & Target)
    | ({ type: 'editTaskTokens'; field: 'tags'; mode: BulkTaskTokenMode; values: string[] } & Target)
    /** Bulk Organize's Apply, on the Inbox. */
    | ({ type: 'organize'; draft: Partial<BulkOrganizeDraft> } & Target)
    | ({ type: 'trashTasks' } & Target)
    /** A delete's Undo: the ids and revisions its toast carries. */
    | { type: 'restoreTasks'; taskIds: string[]; taskRevisions: NativeRevisions };

/** An open picker's options: the organize dialog's project or area picker, or the remove-tag picker. */
export type NativeBulkPicker = {
    kind: 'project' | 'area' | 'removeTag';
    total: number;
    /** Project and area pickers lead with Keep and None; choosing one sends its `edit` with `organize`. */
    items: { value: string; label: string; selected: boolean; edit: BulkOrganizeDraftEdit | null }[];
    /**
     * Project and area pickers: the "+ Create" row for a search no option names
     * exactly; send its `name` to createBulkOrganizeDestination. Null otherwise, and
     * while `busy`. A failed create shows `organize.createFailed`.
     */
    create: { name: string; label: string; accessibilityLabel: string } | null;
    /** The search box's Done key: choose the exact match (its `edit`), or create `create`. Null for an empty search, and while `busy`. */
    submit: { edit: BulkOrganizeDraftEdit } | { create: string } | null;
};

export type NativeBulkOrganizeView = Omit<BulkOrganizeDialogModel, 'statuses' | 'dates' | 'waitingFor' | 'contexts' | 'tags'> & {
    /** The draft with the edit applied: send it back as `organize.draft`, and with Apply. */
    draft: BulkOrganizeDraft;
    statuses: (BulkOrganizeDialogModel['statuses'][number] & { edit: BulkOrganizeDraftEdit })[];
    waitingFor: (NonNullable<BulkOrganizeDialogModel['waitingFor']> & { value: string }) | null;
    dates: (Omit<BulkOrganizeDateFieldModel, 'quickDates'> & {
        field: BulkOrganizeDialogModel['dates'][number]['field'];
        quickDates: (BulkOrganizeDateFieldModel['quickDates'][number] & { edit: BulkOrganizeDraftEdit })[];
    })[];
    contexts: BulkOrganizeDialogModel['contexts'] & { value: string };
    tags: BulkOrganizeDialogModel['tags'] & { value: string };
};

export type NativeBulkActionsView = {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;
    /** The list view's revision; later picker pages send it back as `picker.revision`. */
    revision: string;
    list: NativeBulkList;
    /** The explicit selection still on screen, in the order it was made; send it back as `taskIds`. Empty under Select all. */
    selectedIds: string[];
    /** Each of `selectedIds`' revision: an action on them sends it as `taskRevisions`. */
    taskRevisions: NativeRevisions;
    selectedCount: number;
    /** Range's anchor: the last row tapped. Send it back as `anchorId`. */
    anchorId: string | null;
    /** Under Select all: the object an action takes as `selectAll`. */
    selectAll: NativeBulkSelectAll | null;
    /** The rows Select all selects. */
    selectableCount: number;
    bar: TaskListBulkBarModel;
    labels: {
        selectAll: string;
        /** A failed action's toast title; its message is the error, or "<busy label> failed.". */
        failureTitle: string;
        busy: ReturnType<typeof getTaskListBulkBusyLabels>;
    };
    addTag: ReturnType<typeof getTaskListAddTagDialogText>;
    /** Null when the list offers no Remove tag; open `picker: { kind: 'removeTag' }` for the selection's tags. */
    removeTag: ReturnType<typeof getTaskListRemoveTagPickerText> | null;
    deleteConfirmation: ListConfirmation;
    /** Someday: the selection's ids and revisions, for getSomedayMoveDialog and moveSomedayTasksToSection. */
    moveToSection: { taskIds: string[]; taskRevisions: NativeRevisions } | null;
    /** Only when `organize` is sent (the dialog is open). */
    organize: NativeBulkOrganizeView | null;
    /** Only when `picker` is sent. */
    picker: NativeBulkPicker | null;
};

type ListViews = Pick<ReturnType<typeof createMenuViewMethods>, 'getWaitingView' | 'getSomedayView' | 'getReferenceView' | 'getDoneView'>
    & Pick<ReturnType<typeof createInboxViewMethods>, 'getInboxView'>;

export type BulkActionDeps = {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    t: () => (key: string) => string;
    /** The user's date formatting (createDateFormatter); the only formatter this block uses. */
    formatDate: () => DateFormatter;
    /** The list views, read to know which rows are on screen. */
    views: ListViews;
    /** Data/settings/language/locale authority, without the minute used to refresh row labels. */
    pickerRevision: () => string;
};

type Row = { id: string; readOnly: boolean };
/** createBulkOrganizeDestination's answer: the project or area chosen, and the draft with it chosen. */
export type NativeBulkOrganizeCreateResult = { id: string; changed: boolean; draft: BulkOrganizeDraft };
type ActionOutcome = NativeHostResult<NativeListActionResult<NativeBulkAction>> | NativeUnsavedWrite<NativeListActionResult<NativeBulkAction>>;

const ID_LIMIT = 10_000;
const isIdList = (value: unknown, allowEmpty = false): value is string[] => (
    Array.isArray(value) && value.length <= ID_LIMIT && (allowEmpty || value.length > 0)
    && value.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 200) && new Set(value).size === value.length
);
const isDay = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && safeParseDate(value) !== null;
const TEXT_LIMITS: Record<BulkOrganizeTextField, number> = {
    contexts: 2000, tags: 2000, startDate: 10, dueDate: 10, reviewDate: 10, delegateWho: 500,
};
const DRAFT_KEYS = new Set(Object.keys(EMPTY_BULK_ORGANIZE_DRAFT));
const PARAM_ONLY_KEYS = ['filterEdit', 'offset', 'limit', 'revision'];

/**
 * The option a picker search names exactly, as mobile's pickers match it: a project
 * by its trimmed title, case-insensitive (getProjectChoiceState); an area by its name
 * against the trimmed search, case-insensitive (TaskEditAreaPicker).
 */
const exactDestination = (kind: 'project' | 'area', query: string): Project | Area | undefined => {
    const state = useTaskStore.getState();
    if (kind === 'project') {
        const options = getBulkOrganizeProjectOptions(state.projects);
        return getProjectChoiceState([...options].sort(compareProjectsByPickerOrder), query, [...state.projects].sort(compareProjectsByPickerOrder)).exactMatch;
    }
    const normalized = query.trim().toLowerCase();
    return normalized ? getBulkOrganizeAreaOptions(state.areas).find((area) => area.name.toLowerCase() === normalized) : undefined;
};

/** A draft as the host sends it, completed from the empty one; null when a field is not one the dialog holds. */
export const readBulkOrganizeDraftShape = (value: unknown): BulkOrganizeDraft | null => {
    if (value === undefined) return EMPTY_BULK_ORGANIZE_DRAFT;
    if (!isObjectRecord(value) || Object.keys(value).some((key) => !DRAFT_KEYS.has(key))) return null;
    const draft = { ...EMPTY_BULK_ORGANIZE_DRAFT, ...value } as BulkOrganizeDraft;
    const valid = (draft.status === BULK_ORGANIZE_KEEP || BULK_ORGANIZE_STATUS_OPTIONS.includes(draft.status))
        && isText(draft.projectChoice, 200) && isText(draft.areaChoice, 200)
        && (Object.keys(TEXT_LIMITS) as BulkOrganizeTextField[]).every((field) => isText(draft[field], TEXT_LIMITS[field]))
        && BULK_ORGANIZE_DATE_FIELDS.every((field) => draft[field] === '' || isDay(draft[field]));
    return valid ? draft : null;
};
/** Whether the draft's project and area choices are ones the dialog offers now. */
const offersChoices = (draft: BulkOrganizeDraft): boolean => {
    const state = useTaskStore.getState();
    const isChoice = (choice: string, ids: Set<string>) => choice === BULK_ORGANIZE_KEEP || choice === BULK_ORGANIZE_NONE || ids.has(choice);
    return isChoice(draft.projectChoice, new Set(getBulkOrganizeProjectOptions(state.projects).map((project) => project.id)))
        && isChoice(draft.areaChoice, new Set(getBulkOrganizeAreaOptions(state.areas).map((area) => area.id)));
};
/** A draft as the host sends it, completed from the empty one; null when a choice is not one the dialog offers. */
const readDraft = (value: unknown): BulkOrganizeDraft | null => {
    const draft = readBulkOrganizeDraftShape(value);
    return draft && offersChoices(draft) ? draft : null;
};
const readEdit = (value: unknown): BulkOrganizeDraftEdit | null => {
    if (!isObjectRecord(value)) return null;
    switch (value.type) {
        case 'setStatus':
        case 'setProject':
        case 'setArea':
            return typeof value.value === 'string' ? value as BulkOrganizeDraftEdit : null;
        case 'setText':
            return typeof value.field === 'string' && value.field in TEXT_LIMITS && typeof value.value === 'string' ? value as BulkOrganizeDraftEdit : null;
        default:
            return null;
    }
};

/**
 * Bulk Organize's dialog for the draft the host keeps and one control's edit, as the
 * lists (getBulkActions) and Review (getReviewOverview) show it. Null when the draft or
 * the edit is not valid, or names a project or area the dialog does not offer.
 */
export function buildNativeBulkOrganizeView(
    organize: { draft?: unknown; edit?: unknown },
    context: { selectedCount: number; t: (key: string) => string; formatDate: DateFormatter },
): NativeBulkOrganizeView | null {
    const sent = readDraft(organize.draft);
    const edit = organize.edit === undefined ? null : readEdit(organize.edit);
    const draft = sent && (organize.edit === undefined ? sent : edit ? readDraft(applyBulkOrganizeDraftEdit(sent, edit)) : null);
    if (!draft) return null;
    const state = useTaskStore.getState();
    const { t, formatDate } = context;
    const dialog = buildBulkOrganizeDialogModel({
        draft, projects: getBulkOrganizeProjectOptions(state.projects), areas: getBulkOrganizeAreaOptions(state.areas), selectedCount: context.selectedCount, t,
    });
    const now = new Date();
    return {
        ...dialog,
        draft,
        statuses: dialog.statuses.map((status) => ({ ...status, edit: { type: 'setStatus', value: status.value } })),
        waitingFor: dialog.waitingFor ? { ...dialog.waitingFor, value: draft.delegateWho } : null,
        dates: dialog.dates.map(({ field, label }) => {
            const model = buildBulkOrganizeDateFieldModel({ label, value: draft[field], now, t, formatDate });
            return {
                ...model,
                field,
                quickDates: model.quickDates.map((chip) => ({ ...chip, edit: { type: 'setText', field, value: chip.value } })),
            };
        }),
        contexts: { ...dialog.contexts, value: draft.contexts },
        tags: { ...dialog.tags, value: draft.tags },
    };
}

/**
 * Bulk Organize's project or area picker for a draft: Keep and None, then the options
 * whose label matches `query` (the Inbox tokens' rule), one window of them. `create` and
 * `submit` are what mobile's picker offers for the search; none while `busy` (Apply runs).
 */
export function buildNativeBulkOrganizePicker(input: {
    kind: 'project' | 'area';
    query?: string;
    draft: BulkOrganizeDraft;
    busy: boolean;
    t: (key: string) => string;
    offset: number;
    limit: number;
}): NativeBulkPicker {
    const { kind, query, draft, t } = input;
    const state = useTaskStore.getState();
    const isProject = kind === 'project';
    const current = isProject ? draft.projectChoice : draft.areaChoice;
    const set = (value: string): BulkOrganizeDraftEdit => ({ type: isProject ? 'setProject' : 'setArea', value });
    const choice = (value: string, label: string) => ({ value, label, selected: current === value, edit: set(value) });
    const options = isProject
        // In mobile's picker order (TaskEditProjectPicker sorts core's title-ordered options by `order`).
        ? [...getBulkOrganizeProjectOptions(state.projects)].sort(compareProjectsByPickerOrder).map((project) => ({ id: project.id, label: project.title }))
        : getBulkOrganizeAreaOptions(state.areas).map((area) => ({ id: area.id, label: area.name }));
    // Keep and None stay whatever the search; the options narrow.
    const items = [
        choice(BULK_ORGANIZE_KEEP, isProject ? tFallback(t, 'bulk.keepProject', 'Keep project') : tFallback(t, 'bulk.keepArea', 'Keep area')),
        choice(BULK_ORGANIZE_NONE, isProject ? t('taskEdit.noProjectOption') : t('taskEdit.noAreaOption')),
        ...options.filter((option) => query === undefined || matchesPickerQuery(option.label, query)).map((option) => choice(option.id, option.label)),
    ];
    let create: NativeBulkPicker['create'] = null;
    let submit: NativeBulkPicker['submit'] = null;
    // Mobile hides Create and ignores Done while Apply runs.
    const name = input.busy ? '' : (query ?? '').trim();
    if (name) {
        const exact = exactDestination(kind, name);
        const createLabel = t(isProject ? 'projects.create' : 'areas.create');
        create = exact ? null : { name, label: `+ ${createLabel} "${name}"`, accessibilityLabel: `${createLabel}: ${name}` };
        submit = exact ? { edit: set(exact.id) } : { create: name };
    }
    return { kind, total: items.length, items: page(items, input), create, submit };
}

/** The remove-tag picker: the selection's tags matching `query` (the Inbox tokens' rule), one window of them. */
export function buildNativeRemoveTagPicker(tags: readonly string[], query: string | undefined, window: { offset: number; limit: number }): NativeBulkPicker {
    const items = tags.filter((tag) => query === undefined || matchesPickerQuery(tag, query))
        .map((tag) => ({ value: tag, label: tag, selected: false, edit: null }));
    return { kind: 'removeTag', total: items.length, items: page(items, window), create: null, submit: null };
}

/** Apply's organize input for a draft as the host sends it; refused when a choice is not offered or Waiting names no person. */
export function readBulkOrganizeApply(value: unknown): NativeHostResult<BulkOrganizeTaskUpdateInput> {
    const draft = readDraft(value);
    if (!draft) return fail('INVALID_INPUT', 'A Bulk organize draft with choices the dialog offers is required');
    if (draft.status === 'waiting' && !draft.delegateWho.trim()) return fail('INVALID_INPUT', 'Waiting needs the person these tasks wait for');
    return { ok: true, value: buildBulkOrganizeInput(draft) };
}

export function createBulkActionMethods(deps: BulkActionDeps) {
    const durableSave = async (): Promise<NativeHostResult<null>> => {
        if (useTaskStore.getState().persistenceFailure) {
            try {
                await useTaskStore.getState().retryPersistence();
            } catch (error) {
                return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error));
            }
        }
        return deps.save();
    };
    const receipts = createNativeRequestReceipts({ save: durableSave });

    const readOnly = (task: Task) => isStatusListTaskReadOnly(task, useTaskStore.getState()._allProjects);
    const liveTask = (id: string): Task | undefined => {
        const task = useTaskStore.getState()._tasksById.get(id);
        return task && !task.deletedAt ? task : undefined;
    };

    /** Every row the list shows for these params, in list order, paged through the list's own view. */
    const listRows = (list: NativeBulkList, params: unknown): NativeHostResult<{ revision: string; rows: Row[] }> => {
        if (!isObjectRecord(params) || PARAM_ONLY_KEYS.some((key) => params[key] !== undefined)) {
            return fail('INVALID_INPUT', 'The list view\'s own params are required (filters as returned, no filterEdit or paging)');
        }
        const read = (offset: number, revision?: string) => {
            const input = { ...params, offset, limit: NATIVE_HOST_MAX_WINDOW, ...(revision ? { revision } : {}) };
            const { views } = deps;
            switch (list) {
                case 'inbox': return views.getInboxView(input as Parameters<ListViews['getInboxView']>[0]);
                case 'waiting': return views.getWaitingView(input as Parameters<ListViews['getWaitingView']>[0]);
                case 'someday': return views.getSomedayView(input as Parameters<ListViews['getSomedayView']>[0]);
                case 'reference': return views.getReferenceView(input as Parameters<ListViews['getReferenceView']>[0]);
                case 'done': return views.getDoneView(input as Parameters<ListViews['getDoneView']>[0]);
            }
        };
        const rows: Row[] = [];
        const seen = new Set<string>();
        let revision: string | undefined;
        for (let offset = 0; ; offset += NATIVE_HOST_MAX_WINDOW) {
            const result = read(offset, revision);
            if (!result.ok) return result;
            revision = result.value.revision;
            const value = result.value as { total: number; rows?: { id: string }[]; items?: { type: string; row?: { id: string; readOnly?: boolean } }[] };
            const entries: Row[] = value.rows
                ? value.rows.map((row) => ({ id: row.id, readOnly: false }))
                : (value.items ?? []).flatMap((item) => (item.type === 'task' && item.row ? [{ id: item.row.id, readOnly: item.row.readOnly === true }] : []));
            // A task grouped under several headings is one row to select.
            for (const entry of entries) {
                if (seen.has(entry.id)) continue;
                seen.add(entry.id);
                rows.push(entry);
            }
            if (offset + NATIVE_HOST_MAX_WINDOW >= value.total) return { ok: true, value: { revision, rows } };
        }
    };
    const selectableIds = (rows: Row[]) => rows.filter((row) => !row.readOnly).map((row) => row.id);
    // Each row's revision is in it: a change to any selected row, on screen or not, makes Select all stale.
    const selectAllRevision = (ids: string[]) => {
        const { _tasksById } = useTaskStore.getState();
        return revisionsToken(ids.map((id) => {
            const task = _tasksById.get(id);
            return `${id}@${task ? taskRevisionOf(task) : ''}`;
        }));
    };

    /**
     * The rows an action takes: its `taskIds`, or its Select all resolved now. `current` is
     * false once Select all's revision no longer holds: the action is STALE_REVISION unless
     * no row it covers now needs a write (a replay of one that landed: its rows changed).
     */
    const resolveTarget = (list: NativeBulkList, action: Record<string, unknown>): { taskIds: string[]; current: boolean } | NativeHostResult<never> => {
        if (action.taskIds !== undefined && action.selectAll !== undefined) return fail('INVALID_INPUT', 'Send taskIds or selectAll, not both');
        if (action.selectAll === undefined) {
            if (!isIdList(action.taskIds)) return fail('INVALID_INPUT', 'Task IDs or Select all are required');
            const invalid = action.taskIds.some((id) => {
                const task = liveTask(id);
                return !task || readOnly(task);
            });
            return invalid ? fail('INVALID_INPUT', 'Every task must exist, not be in Trash, and be editable') : { taskIds: action.taskIds, current: true };
        }
        const selectAll = action.selectAll;
        if (!isObjectRecord(selectAll) || typeof selectAll.revision !== 'string' || (selectAll.except !== undefined && !isIdList(selectAll.except, true))) {
            return fail('INVALID_INPUT', 'Select all needs the view\'s params, its revision and the rows deselected since');
        }
        const read = listRows(list, selectAll.params);
        if (!read.ok) return read;
        const ids = selectableIds(read.value.rows);
        const current = selectAllRevision(ids) === selectAll.revision;
        const except = new Set(selectAll.except as string[] | undefined);
        const selected = ids.filter((id) => !except.has(id));
        return current && selected.length === 0 ? fail('INVALID_INPUT', 'Select all selects no task') : { taskIds: selected, current };
    };

    const toToast = (write: TaskListBulkWrite, t: (key: string) => string): NativeListToast<NativeBulkAction> | null => {
        const toast = getTaskListBulkToast(write, t);
        if (!toast) return null;
        return {
            tone: toast.tone,
            title: toast.title,
            message: toast.message,
            // Read after the delete landed: the Undo restores the tasks as they are now.
            undo: toast.undo ? { label: toast.undo.label, action: { type: 'restoreTasks', taskIds: toast.undo.taskIds, taskRevisions: taskRevisionsOf(toast.undo.taskIds) } } : null,
        };
    };
    const unchanged = (): ActionOutcome => ({ ok: true, value: { changed: false, toast: null } });
    /**
     * The write, compare-and-set against `revisions` (none under Select all: its revision covered
     * them) on `ids`: the rows it changes, or those of them not at the target yet.
     */
    const perform = async (
        write: TaskListBulkWrite, t: (key: string) => string, revisions: NativeRevisions | undefined,
        ids = write.kind === 'update' ? write.updates.map(({ id }) => id) : write.taskIds,
    ): Promise<ActionOutcome> => {
        const stale = revisions ? refuseStaleTasks(ids, revisions) : null;
        if (stale) return stale;
        const written = await runStoreWrite(() => runTaskListBulkWrite(useTaskStore.getState(), write));
        return settleWrite(written, { changed: true, toast: toToast(write, t) });
    };
    // Target state: a replay of an update that landed finds every field already set.
    const hasLanded = (updates: { id: string; updates: Partial<Task> }[]) => updates.every(({ id, updates: fields }) => {
        const task = useTaskStore.getState()._tasksById.get(id) as Record<string, unknown> | undefined;
        return task && Object.entries(fields).every(([key, value]) => JSON.stringify(task[key] ?? null) === JSON.stringify(value ?? null));
    });

    return {
        /**
         * A list's selection mode: the bulk bar for the selection, its dialogs, and an
         * open picker's options. `list` names the list, `params` are its view's inputs.
         */
        getBulkActions(input: {
            list: NativeBulkList;
            params?: Record<string, unknown>;
            taskIds?: string[];
            selectAll?: { except?: string[] };
            anchorId?: string | null;
            /** A row tap; `range` when Range mode was on. */
            selectionEdit?: { taskId: string; range?: boolean };
            rangeSelectMode?: boolean;
            /** While an action runs: the bar disables its controls. */
            busy?: boolean;
            organize?: { draft?: Partial<BulkOrganizeDraft>; edit?: BulkOrganizeDraftEdit };
            /** An open picker; later pages send the view's `revision`. */
            picker?: { kind: NativeBulkPicker['kind']; query?: string; offset?: number; limit?: number; revision?: string };
        }): NativeHostResult<NativeBulkActionsView> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !BULK_LISTS.includes(input.list)
                || (input.taskIds !== undefined && !isIdList(input.taskIds, true))
                || (input.selectAll !== undefined && (!isObjectRecord(input.selectAll) || input.taskIds !== undefined
                    || (input.selectAll.except !== undefined && !isIdList(input.selectAll.except, true))))
                || (input.anchorId != null && !isText(input.anchorId, 200))
                || (input.selectionEdit !== undefined && (!isObjectRecord(input.selectionEdit) || input.selectAll !== undefined
                    || !isText(input.selectionEdit.taskId, 200)
                    || (input.selectionEdit.range !== undefined && typeof input.selectionEdit.range !== 'boolean')))
                || (input.rangeSelectMode !== undefined && typeof input.rangeSelectMode !== 'boolean')
                || (input.busy !== undefined && typeof input.busy !== 'boolean')
                || (input.organize !== undefined && !isObjectRecord(input.organize))
                || (input.picker !== undefined && (!isObjectRecord(input.picker)
                    || !['project', 'area', 'removeTag'].includes(input.picker.kind as string)
                    || (input.picker.query !== undefined && !isText(input.picker.query))
                    || !isPaging({ offset: input.picker.offset ?? 0, limit: input.picker.limit ?? NATIVE_HOST_MAX_WINDOW, revision: input.picker.revision })))) {
                return fail('INVALID_INPUT', 'A list, its view params, one selection, and valid selection, organize and picker inputs are required');
            }
            const screen = TASK_LIST_BULK_SCREENS[input.list];
            if ((input.organize !== undefined || input.picker?.kind === 'project' || input.picker?.kind === 'area') && !screen.organize) {
                return fail('INVALID_INPUT', 'This list does not offer Bulk organize');
            }
            if (input.picker?.kind === 'removeTag' && !screen.removeTags) return fail('INVALID_INPUT', 'This list does not offer Remove tag');
            const read = listRows(input.list, input.params ?? {});
            if (!read.ok) return read;
            const { revision: listRevision, rows } = read.value;
            const removeTagPicker = input.picker?.kind === 'removeTag';
            const inboxOrganizePicker = input.list === 'inbox' && input.organize !== undefined
                && (input.picker?.kind === 'project' || input.picker?.kind === 'area');
            if (!removeTagPicker && !inboxOrganizePicker && (input.picker?.offset ?? 0) > 0 && input.picker?.revision !== listRevision) return fail('STALE_REVISION', 'The list changed; open the picker again');
            const selectable = selectableIds(rows);
            const onScreen = new Set(selectable);

            // The selection, as mobile keeps it: tapped rows in tap order, pruned to the rows on screen.
            let selectedIds = (input.taskIds ?? []).filter((id) => onScreen.has(id));
            let anchorId = input.anchorId ?? null;
            if (input.selectionEdit) {
                const { taskId } = input.selectionEdit;
                if (!rows.some((row) => row.id === taskId)) return fail('INVALID_INPUT', 'That row is not on screen');
                // A read-only row does not select.
                if (onScreen.has(taskId)) {
                    const result = updateRangeSelection({
                        anchorId, range: input.selectionEdit.range === true, selectedIds: new Set(selectedIds), targetId: taskId, visibleIds: selectable,
                    });
                    selectedIds = Array.from(result.selectedIds);
                    anchorId = result.anchorId;
                }
            }
            const except = input.selectAll ? (input.selectAll.except ?? []).filter((id) => onScreen.has(id)) : [];
            const exceptSet = new Set(except);
            const selection = input.selectAll ? selectable.filter((id) => !exceptSet.has(id)) : selectedIds;

            const t = deps.t();
            const state = useTaskStore.getState();
            const tokens = screen.removeTags ? collectBulkTaskTokens(selection, state._tasksById, 'tags') : [];
            // A minute refreshes labels, not an unchanged tag inventory. Re-read
            // eligibility first, then bind the picker to its actual scope/selection
            // and ordered RN token union; never strip an opaque list revision.
            let revision = removeTagPicker ? `${deps.pickerRevision()}:${revisionsToken([
                JSON.stringify({ kind: 'removeTag', list: input.list, params: input.params ?? {}, query: input.picker?.query ?? null }),
                JSON.stringify(selectable),
                JSON.stringify(selection.map((id) => [id, taskRevisionOf(state._tasksById.get(id)!)])),
                JSON.stringify(tokens),
            ])}` : listRevision;
            if (removeTagPicker && (input.picker?.offset ?? 0) > 0 && input.picker?.revision !== revision) return fail('STALE_REVISION', 'The selection or tags changed; open the picker again');
            const bar = buildTaskListBulkBarModel({
                selectedCount: selection.length,
                hasSelection: selection.length > 0,
                busy: input.busy === true,
                rangeSelectMode: input.rangeSelectMode === true,
                statuses: getBulkMoveStatusOptions(screen.status),
                moveToSection: screen.moveToSection,
                organize: screen.organize,
                removeTag: screen.removeTags ? { canRemove: tokens.length > 0 } : null,
                t,
            });

            let organize: NativeBulkOrganizeView | null = null;
            if (input.organize) {
                organize = buildNativeBulkOrganizeView(input.organize, { selectedCount: selection.length, t, formatDate: deps.formatDate() });
                if (!organize) return fail('INVALID_INPUT', 'A Bulk organize draft and edit with choices the dialog offers are required');
            }
            if (inboxOrganizePicker) {
                // Display minutes do not change an offer; re-read eligibility and bind its complete picker context.
                revision = `${deps.pickerRevision()}:${revisionsToken([
                    JSON.stringify({ list: input.list, params: input.params ?? {}, kind: input.picker!.kind, query: (input.picker!.query ?? '').trim() }),
                    JSON.stringify(selectable),
                    JSON.stringify(selection.map((id) => [id, taskRevisionOf(state._tasksById.get(id)!)])),
                    JSON.stringify(organize!.draft),
                ])}`;
                if ((input.picker?.offset ?? 0) > 0 && input.picker?.revision !== revision) return fail('STALE_REVISION', 'The selection or Inbox destination offer changed; open the picker again');
            }

            let picker: NativeBulkPicker | null = null;
            if (input.picker) {
                const { kind, query } = input.picker;
                const window = { offset: input.picker.offset ?? 0, limit: input.picker.limit ?? NATIVE_HOST_MAX_WINDOW };
                picker = kind === 'removeTag'
                    ? buildNativeRemoveTagPicker(tokens, query, window)
                    : buildNativeBulkOrganizePicker({ kind, query, draft: organize?.draft ?? EMPTY_BULK_ORGANIZE_DRAFT, busy: input.busy === true, t, ...window });
            }

            return {
                ok: true,
                value: {
                    version: NATIVE_HOST_CONTRACT_VERSION,
                    revision,
                    list: input.list,
                    selectedIds: input.selectAll ? [] : selectedIds,
                    taskRevisions: taskRevisionsOf(input.selectAll ? [] : selectedIds),
                    selectedCount: selection.length,
                    anchorId,
                    selectAll: input.selectAll
                        ? { params: input.params ?? {}, revision: selectAllRevision(selectable), except }
                        : null,
                    selectableCount: selectable.length,
                    bar,
                    labels: {
                        selectAll: `${tFallback(t, 'bulk.select', 'Select')} ${tFallback(t, 'common.all', 'all')}`,
                        failureTitle: t('common.notice'),
                        busy: getTaskListBulkBusyLabels(t),
                    },
                    addTag: getTaskListAddTagDialogText(t),
                    removeTag: screen.removeTags ? getTaskListRemoveTagPickerText(t) : null,
                    deleteConfirmation: getBulkTrashConfirmation(t),
                    moveToSection: screen.moveToSection ? { taskIds: selection, taskRevisions: taskRevisionsOf(selection) } : null,
                    organize,
                    picker,
                },
            };
        },

        /**
         * Create a project or area from the organize dialog's picker (its `create.name`,
         * or its search box's text on Done), as mobile does; a project goes in the draft's
         * chosen area. A name an option already carries is refused (INVALID_INPUT): the
         * picker's `submit.edit` chooses it, as mobile's Done does, so no request ever
         * resolves a destination by name. Returns the draft with the new one chosen (a
         * project resets the area to Keep). Writes no task.
         * Reuse `requestId` to retry. A new project or area takes the request UUID as its
         * ID: a replay after a restart answers with that row and writes nothing, choosing
         * it only while the dialog still offers it. Review's organize dialog (getReviewOverview)
         * is the same dialog: send `list: 'review'`.
         */
        async createBulkOrganizeDestination(input: {
            requestId: string;
            list: NativeBulkList | 'review';
            kind: 'project' | 'area';
            name: string;
            draft?: Partial<BulkOrganizeDraft>;
        }): Promise<NativeHostResult<NativeBulkOrganizeCreateResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            // Only the shape here: what the dialog offers is checked when the request first runs,
            // so a retry that owes only a save is never refused by a change since.
            const draft = isObjectRecord(input) ? readBulkOrganizeDraftShape(input.draft) : null;
            if (!isObjectRecord(input) || (input.list !== 'review' && (!BULK_LISTS.includes(input.list) || !TASK_LIST_BULK_SCREENS[input.list].organize))
                || (input.kind !== 'project' && input.kind !== 'area') || !isText(input.name) || !input.name.trim() || !draft) {
                return fail('INVALID_INPUT', 'A request UUID, a list that offers Bulk organize, a project or area name and a valid draft are required');
            }
            const { kind, requestId } = input;
            const name = input.name.trim();
            return receipts.run(requestId, JSON.stringify(['bulkCreate', input.list, kind, name, draft]), async () => {
                const offered = (id: string) => (kind === 'project'
                    ? getBulkOrganizeProjectOptions(useTaskStore.getState().projects).some((project) => project.id === id)
                    : getBulkOrganizeAreaOptions(useTaskStore.getState().areas).some((area) => area.id === id));
                const choose = (id: string, changed: boolean): NativeBulkOrganizeCreateResult => ({
                    id,
                    changed,
                    draft: offered(id) ? applyBulkOrganizeDraftEdit(draft, { type: kind === 'project' ? 'setProject' : 'setArea', value: id }) : draft,
                });
                // A new row takes the request UUID as its ID. A replay after a restart finds it,
                // renamed, archived or deleted since: made already, so nothing is added or restored.
                const id = requestId.toLowerCase();
                const state = useTaskStore.getState();
                if (kind === 'project' ? state._projectsById.has(id) : state._areasById.has(id)) return { ok: true, value: choose(id, false) };
                if (!offersChoices(draft)) return fail('INVALID_INPUT', 'The draft\'s project or area is not one the dialog offers');
                // The search box's Done on an exact match is the picker's `submit.edit`, not a create:
                // choosing by name here could not be told apart from a later row of that name on replay.
                if (exactDestination(kind, name)) return fail('INVALID_INPUT', 'An option already has that name; choose it with the picker\'s submit edit');
                const before = useTaskStore.getState();
                // RN's picker creates the project in the dialog's chosen area (dialog.area.selectedId).
                const areaId = draft.areaChoice !== BULK_ORGANIZE_KEEP && draft.areaChoice !== BULK_ORGANIZE_NONE ? draft.areaChoice : undefined;
                const made: { entity: Project | Area | null } = { entity: null };
                const written = await runStoreWrite(async () => {
                    made.entity = kind === 'project' ? await addBulkOrganizeProject(name, areaId, id) : await addBulkOrganizeArea(name, id);
                    return made.entity ? undefined : { success: false, error: kind === 'project' ? 'Project creation failed' : 'Area creation failed' };
                });
                if (!made.entity) return written.ok ? fail('ACTION_FAILED', 'Creation failed') : written;
                const after = useTaskStore.getState();
                const changed = kind === 'project' ? after._allProjects !== before._allProjects : after._allAreas !== before._allAreas;
                // The store reused a live row of that name (its own name match): nothing was made, so nothing to answer.
                if (made.entity.id !== id && !changed) return fail('INVALID_INPUT', 'An option already has that name; choose it with the picker\'s submit edit');
                return settleWrite(written, choose(made.entity.id, changed));
            });
        },

        /**
         * One bulk action on a list, as its bar writes it. Reuse `requestId` to retry;
         * a delete's Undo is `restoreTasks` with a new request UUID.
         */
        async runBulkAction(input: { requestId: string; list: NativeBulkList; action: NativeBulkAction }): Promise<NativeHostResult<NativeListActionResult<NativeBulkAction>>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !BULK_LISTS.includes(input.list) || !isObjectRecord(input.action)) {
                return fail('INVALID_INPUT', 'A request UUID, a list and an action are required');
            }
            const { list } = input;
            const action = input.action as NativeBulkAction & Record<string, unknown>;
            return receipts.run(input.requestId, JSON.stringify(['bulk', list, action]), async (): Promise<ActionOutcome> => {
                const screen = TASK_LIST_BULK_SCREENS[list];
                const t = deps.t();
                const state = useTaskStore.getState();
                // Explicit rows come with the revision the view showed for each, and for nothing else.
                const revisions = action.selectAll === undefined ? action.taskRevisions : undefined;
                if (action.selectAll === undefined && (!isIdList(action.taskIds) || !isRevisions(revisions, action.taskIds))) {
                    return fail('INVALID_INPUT', 'Task IDs and the revision the view showed for each, or Select all, are required');
                }
                if (action.type === 'restoreTasks') {
                    if (!isIdList(action.taskIds) || action.taskIds.some((id) => {
                        const task = state._tasksById.get(id);
                        return !task || task.purgedAt;
                    })) {
                        return fail('INVALID_INPUT', 'Every task must exist');
                    }
                    // Target state: the tasks already back stay as they are.
                    const trashed = action.taskIds.filter((id) => state._tasksById.get(id)?.deletedAt);
                    return trashed.length > 0 ? perform({ kind: 'restore', taskIds: trashed }, t, revisions) : unchanged();
                }
                if (action.type === 'trashTasks' && isIdList(action.taskIds) && action.selectAll === undefined
                    && action.taskIds.every((id) => {
                        const task = state._tasksById.get(id);
                        return task?.deletedAt && !task.purgedAt;
                    })) {
                    return unchanged();
                }
                const target = resolveTarget(list, action);
                if ('ok' in target) return target;
                const { taskIds } = target;
                // Target state first: rows that already hold it need no write, and none left is
                // changed: false. Then compare-and-set: a stale Select all refuses the rest.
                const run = (write: TaskListBulkWrite | null, casIds?: string[]): Promise<ActionOutcome> | ActionOutcome => {
                    if (!write) return unchanged();
                    return target.current ? perform(write, t, revisions, casIds) : fail('STALE_REVISION', 'The list changed; select all again');
                };
                switch (action.type) {
                    case 'moveTasks': {
                        if (!getBulkMoveStatusOptions(screen.status).includes(action.status)) return fail('INVALID_INPUT', 'This list does not offer that status');
                        // Mobile moves every selected row; only the rows not there yet are compared.
                        const move: TaskListBulkWrite = { kind: 'move', taskIds, status: action.status };
                        const moving = taskIds.filter((id) => state._tasksById.get(id)?.status !== action.status);
                        // Every row there already: nothing to write, and the toast mobile shows for the move.
                        if (moving.length === 0) return { ok: true, value: { changed: false, toast: taskIds.length > 0 ? toToast(move, t) : null } };
                        return run(move, moving);
                    }
                    case 'editTaskTokens': {
                        if (action.field !== 'tags' || (action.mode !== 'add' && action.mode !== 'remove')
                            || (action.mode === 'remove' && !screen.removeTags)
                            || !Array.isArray(action.values) || action.values.length === 0 || action.values.length > 100
                            || !action.values.every((value) => isText(value) && value.trim().length > 0)) {
                            return fail('INVALID_INPUT', 'Tags to add, or tags to remove where the list offers it, are required');
                        }
                        return run(planBulkTagEdit(taskIds, state._tasksById, action.mode, action.values));
                    }
                    case 'organize': {
                        if (!screen.organize) return fail('INVALID_INPUT', 'This list does not offer Bulk organize');
                        const apply = readBulkOrganizeApply(action.draft);
                        if (!apply.ok) return apply;
                        const write = planBulkOrganize(taskIds, state._tasksById, apply.value);
                        return run(write && write.kind === 'update' && !hasLanded(write.updates) ? write : null);
                    }
                    case 'trashTasks':
                        return run(taskIds.length > 0 ? { kind: 'trash', taskIds } : null);
                    default:
                        return fail('INVALID_INPUT', 'This list does not offer that action');
                }
            });
        },
    };
}
