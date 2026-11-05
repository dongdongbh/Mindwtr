


import {
    BOARD_CARD_SWIPES,
    BOARD_DUE_DATE_PRESETS,
    EMPTY_BOARD_FILTER_STATE,
    applyBoardFilterEdit,
    buildBoardColumns,
    getBoardCard,
    getBoardCardText,
    getBoardFilterOptions,
    getBoardFilterSummary,
    getBoardProjectBadges,
    isBoardStatus,
    planBoardDrop,
    resolveBoardFilterState,
    selectBoardTasks,
    type BoardCard,
    type BoardCardAction,
    type BoardColumnTone,
    type BoardDuePreset,
    type BoardFilterEdit,
    type BoardFilterState,
    type BoardStatus,
} from './board-view-model';
import { canCompleteNativeBoardTask } from './native-host-contract-task-checklist';
import { matchesPickerQuery } from './native-host-contract-menu-views';
import { createProjectOrderReserver, ensureDeviceId, matchesDuplicateSource, nextRevision } from './store-helpers';
import { boardMoveEffect, boardMoveScope, boardReactivationContainerAllowed, samePreparedTask, buildDuplicateTask, sanitizeRestoredTaskContainerReferences, taskEditValuesEqual } from './store-tasks';
import { TASK_SYNC_FIELD_SCHEMA } from './task-sync-schema';
import { boardOrderForDuplicate, projectFocusDateValues } from './task-utils';
import { validFrozenFocusDate } from './native-host-contract-task-focus';
import type { PreparedAreaAuthority, PreparedBoardMove, PreparedNativeSaveBoundary, TaskStore } from './store-types';
import { PROJECT_SYNC_FIELD_SCHEMA } from './project-sync-schema';
import { SECTION_SYNC_FIELD_SCHEMA } from './section-sync-schema';
import { AREA_SYNC_FIELD_SCHEMA } from './area-sync-schema';
import { isTaskVisibleInArea, resolveAreaFilterSelection } from './area-filter';
import {
    NATIVE_HOST_CONTRACT_VERSION,
    NATIVE_HOST_MAX_WINDOW,
    sortAreasForDisplay,
    type NativeHostResult,
    type NativeTaskRow,
} from './native-host-contract';
import { createNativeRequestReceipts, isRevision, refuseStale, runStoreWrite, settleWrite, taskRevisionOf, NativeReceiptSqliteAdapter, isNativeRequestReceiptDurable, type NativeUnsavedWrite } from './native-request-receipts';
import { isProjectedRecurringTaskId } from './recurrence';
import { isStatusListTaskReadOnly } from './menu-views-model';
import { resolveFeatureFlags } from './resolve-feature-flags';
import { getPersistenceStatus, getStorageAdapter, useTaskStore } from './store';
import { createAreaSaveGuard, readAreaDurableData } from './native-host-contract-area-durable';
import { validRawTask } from './native-host-contract-task-save';
import type { AppData, Area, Project, Section, Task } from './types';
import { resolveI18nText } from './i18n';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { logInfo } from './logger';
import { boardOrderWritability, createBoardOrderMethods,
    type NativeBoardOrderRequest, type NativePreparedBoardOrder, type NativeBoardOrderActions, type NativeBoardColumnOrder } from './native-host-contract-board-order';

type NativeHostErrorCode = Extract<NativeHostResult<never>, { ok: false }>['error']['code'];
type Translate = (key: string) => string;

export type BoardViewDeps = {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;

    revision: (now: Date) => string;
    t: () => Translate;

    rows: (tasks: readonly Task[], now: Date) => NativeTaskRow[];
    requestIdPattern: RegExp;
};


export type NativeBoardFilters = Partial<BoardFilterState>;
export type NativeBoardWindow<T> = { total: number; items: T[] };
export type NativeBoardCard = { row: NativeTaskRow; card: BoardCard; boardOrder: number | null; moveAllowed: boolean; completeAllowed: boolean; orderActions?: NativeBoardOrderActions };
export type NativeBoardColumn = {
    status: BoardStatus;
    order?: NativeBoardColumnOrder;
    label: string;
    tone: BoardColumnTone;

    count: number;

    cards: NativeBoardCard[];

    empty: string | null;
};
export type NativeBoardView = {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;
    revision: string;

    filters: BoardFilterState;
    bar: {
        searchPlaceholder: string;
        searchQuery: string;

        searchActive: boolean;

        active: boolean;
        clearLabel: string;

        filterLabel: string;
    };
    sheet: {

        tokens: NativeBoardWindow<{ value: string; state: 'included' | 'excluded' | 'none' }>;

        projects: NativeBoardWindow<{ id: string; title: string; selected: boolean }>;

        showContextMatchMode: boolean;
        showTagMatchMode: boolean;

        chips: NativeBoardWindow<NativeBoardChip>;
        additionalChips: { id: string; label: string; edit: BoardFilterEdit }[];

        due: { label: string; summary: string; accessibilityLabel: string; presets: { preset: BoardDuePreset; label: string; selected: boolean }[] };
    };
    columns: NativeBoardColumn[];
    cardActions: {

        editorTab: 'view';

        swipes: Record<'left' | 'right', { label: string; actions: readonly BoardCardAction[] }>;

        errorTitle: string;
        complete: { label: string };
        moveTo: { label: string; destinations: { status: NativeBoardMoveStatus; label: string }[] };
    };
};

export type NativeBoardChip = { id: string; label: string; excluded: boolean; edit: BoardFilterEdit };
export type NativeBoardList = 'cards' | 'tokens' | 'projects' | 'chips';

export type NativeBoardAction =


    | { type: 'moveCard'; taskId: string; status: BoardStatus; afterId?: string | null; filters?: NativeBoardFilters; taskRevision: string }
    | { type: 'duplicateTask'; taskId: string }
    | { type: 'trashTask'; taskId: string; taskRevision: string };

export type NativeBoardMoveStatus = Extract<BoardStatus, 'inbox' | 'next' | 'waiting' | 'someday'>;


export type NativeBoardWriteRequest = {
    requestId: string;
    action: { type: 'duplicateTask' | 'trashTask'; taskId: string }
        | { type: 'moveCard'; taskId: string; status: NativeBoardMoveStatus; taskRevision: string; filters: NativeBoardFilters };
};
export type NativePreparedBoardAction = {

    version: 1 | 2;
    request: NativeBoardWriteRequest;

    before: Task;

    after: Task;
    deviceIdToInitialize: string | null;

    move?: PreparedBoardMove;
    result: NativeBoardActionResult;
};
export type NativeBoardPrepareResult =
    | { kind: 'prepared'; prepared: NativePreparedBoardAction }
    | { kind: 'noop'; result: NativeBoardActionResult };

export type NativeBoardActionResult = {

    changed: boolean;

    open: { taskId: string; projectId: string | null; tab: 'task' } | null;
};

export type NativeCalendarDeleteRequest = { requestId: string; taskId: string; taskRevision: string };
export type NativePreparedCalendarDelete = {
    version: 1;
    request: NativeCalendarDeleteRequest;
    board: { request: NativeBoardWriteRequest; prepared: NativePreparedBoardAction };
};
export type NativeCalendarDeletePreparation = { kind: 'prepared'; prepared: NativePreparedCalendarDelete };

export type NativeTaskDeleteRequest = { requestId: string; taskId: string; taskRevision: string; source?: 'archive' | 'done' | 'reference' };
export type NativeTaskDeleteResult = {
    id: string; deletion: { message: string; undoLabel: string; undoEnabled: true };
};
export type NativePreparedTaskDelete = {
    version: 1; request: NativeTaskDeleteRequest;
    board: { request: NativeBoardWriteRequest; prepared: NativePreparedBoardAction };
    result: NativeTaskDeleteResult;
};
export type NativeTaskDeletePreparation = { kind: 'prepared'; prepared: NativePreparedTaskDelete };
export type NativeTaskDeleteEnvelope = { request: NativeTaskDeleteRequest; prepared: NativePreparedTaskDelete };
export type NativeTaskDeleteUndoRequest = { requestId: string; deleteRequestId: string };
type NativeRestoreScope = { projects: Project[]; sections: Section[]; areas: Area[] };
export type NativePreparedTaskDeleteUndo = {
    version: 1; request: NativeTaskDeleteUndoRequest; delete: NativeTaskDeleteEnvelope;
    before: Task; after: Task; scope: NativeRestoreScope;
    deviceIdBefore: string | null; deviceIdToInitialize: string | null; result: { id: string };
};
export type NativeTaskDeleteUndoPreparation = { kind: 'prepared'; prepared: NativePreparedTaskDeleteUndo };
export type NativeTaskDeleteUndoEnvelope = { request: NativeTaskDeleteUndoRequest; prepared: NativePreparedTaskDeleteUndo };
export type NativeTrashTaskRestoreRequest = { requestId: string; taskId: string; taskRevision: string };
export type NativePreparedTrashTaskRestore = {
    version: 1; request: NativeTrashTaskRestoreRequest; before: Task; after: Task; scope: NativeRestoreScope;
    deviceIdBefore: string | null; deviceIdToInitialize: string | null; result: { id: string };
};
export type NativeTrashTaskRestorePreparation = { kind: 'prepared'; prepared: NativePreparedTrashTaskRestore };
export type NativeTrashTaskRestoreEnvelope = { request: NativeTrashTaskRestoreRequest; prepared: NativePreparedTrashTaskRestore };

const fail = (code: NativeHostErrorCode, message: string): NativeHostResult<never> => ({ ok: false, error: { code, message } });
const isObjectRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);
const utf8Within = (text: string, limit: number): boolean => {
    let bytes = 0;
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code < 0x80) bytes++;
        else if (code < 0x800) bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length
            && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
            bytes += 4;
            index++;
        } else bytes += 3;
        if (bytes > limit) return false;
    }
    return true;
};
const isText = (value: unknown, max = 500): value is string => typeof value === 'string' && value.length <= max;
const isTextList = (value: unknown): value is string[] => (
    Array.isArray(value) && value.length <= NATIVE_HOST_MAX_WINDOW && value.every((entry) => isText(entry))
);
const isMatchMode = (value: unknown) => value === 'all' || value === 'any';
const isDuePreset = (value: unknown): value is BoardDuePreset => BOARD_DUE_DATE_PRESETS.includes(value as BoardDuePreset);
const FILTER_CHECKS: Record<keyof BoardFilterState, (value: unknown) => boolean> = {
    searchQuery: (value) => isText(value, 2000),
    tokens: isTextList,
    excludedTokens: isTextList,
    projects: isTextList,
    contextMatchMode: isMatchMode,
    tagMatchMode: isMatchMode,
    duePreset: (value) => value === null || isDuePreset(value),
};

const readFilters = (value: unknown): BoardFilterState | null => {
    if (value === undefined) return EMPTY_BOARD_FILTER_STATE;
    if (!isObjectRecord(value)) return null;
    for (const [key, entry] of Object.entries(value)) {
        const check = FILTER_CHECKS[key as keyof BoardFilterState];
        if (!check || !check(entry)) return null;
    }
    return { ...EMPTY_BOARD_FILTER_STATE, ...(value as NativeBoardFilters) };
};
const isFilterEdit = (edit: unknown): edit is BoardFilterEdit => {
    if (!isObjectRecord(edit)) return false;
    switch (edit.type) {
        case 'toggleToken':
        case 'removeToken':
        case 'toggleProject':
        case 'removeProject':
            return isText(edit.value) && (edit.value as string).length > 0;
        case 'setSearch':
            return isText(edit.value, 2000);
        case 'setMatchMode':
            return (edit.kind === 'context' || edit.kind === 'tag') && isMatchMode(edit.value);
        case 'toggleDuePreset':
            return isDuePreset(edit.preset);
        case 'clearDuePreset':
        case 'clear':
            return true;
        default:
            return false;
    }
};
const isWindow = (input: Record<string, unknown>) => (
    Number.isSafeInteger(input.offset) && (input.offset as number) >= 0
    && Number.isSafeInteger(input.limit) && (input.limit as number) >= 1 && (input.limit as number) <= NATIVE_HOST_MAX_WINDOW
);

const paramsKey = (params: unknown): string => {
    const text = JSON.stringify(params);
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash.toString(36);
};

const pagedList = <T, Item>(all: readonly T[], toItem: (entry: T) => Item) => ({
    total: all.length,
    page: (offset: number, limit: number): Item[] => all.slice(offset, offset + limit).map(toItem),
});
const firstPage = <Item,>(list: { total: number; page: (offset: number, limit: number) => Item[] }): NativeBoardWindow<Item> => (
    { total: list.total, items: list.page(0, NATIVE_HOST_MAX_WINDOW) }
);

const ENTERED_LIMIT = 200;

export function createBoardViewMethods(deps: BoardViewDeps) {

    const receipts = createNativeRequestReceipts({
        save: async () => {
            if (useTaskStore.getState().persistenceFailure) {
                try {
                    await useTaskStore.getState().retryPersistence();
                } catch (error) {
                    return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error));
                }
            }
            return deps.save();
        },
    });

    let cache: { key: string; value: ReturnType<typeof buildBoard> } | null = null;


    function buildBoard(input: BoardFilterState, now: Date, state = useTaskStore.getState(), includeOrdering = true) {
        const t = deps.t();
        const areas = sortAreasForDisplay(state.areas);
        const areaById = new Map(areas.map((area) => [area.id, area]));
        const projectById = new Map(state.projects.map((project) => [project.id, project]));
        const resolvedAreaFilter = resolveAreaFilterSelection(state.settings.filters, areas);

        const tasks = selectBoardTasks(state.tasks.filter((task) => isTaskVisibleInArea(task, { areaById, projectById, resolvedAreaFilter })));
        const badges = getBoardProjectBadges(state.projects, areaById);
        const options = getBoardFilterOptions({ tasks, projects: state.projects, areaFilter: resolvedAreaFilter, areaById, badges, t });
        const resolved = resolveBoardFilterState(input, {
            tokens: options.tokens, projectIds: options.projects.map((project) => project.id), getProjectLabel: options.getProjectLabel, t,
        });
        const filters = resolved.state;
        const summary = getBoardFilterSummary({ criteria: resolved.criteria, searchQuery: filters.searchQuery, t });
        const columns = buildBoardColumns({ tasks, criteria: resolved.criteria, searchQuery: filters.searchQuery, projects: state.projects, now, t });
        const cardText = getBoardCardText(t);
        const timeEstimatesEnabled = resolveFeatureFlags(state.settings).timeEstimates;
        const tokenItem = (value: string) => ({
            value, state: filters.tokens.includes(value) ? 'included' as const : filters.excludedTokens.includes(value) ? 'excluded' as const : 'none' as const,
        });
        const projectItem = (project: (typeof options.projects)[number]) => ({ ...project, selected: filters.projects.includes(project.id) });
        const lists = {
            tokens: pagedList(options.tokens, tokenItem),
            projects: pagedList(options.projects, projectItem),
            chips: pagedList(resolved.chips, (chip): NativeBoardChip => ({ id: chip.id, label: chip.label, excluded: chip.excluded, edit: chip.edit as BoardFilterEdit })),
        };

        const search = {
            tokens: (query: string) => pagedList(options.tokens.filter((value) => matchesPickerQuery(value, query)), tokenItem),
            projects: (query: string) => pagedList(options.projects.filter((project) => matchesPickerQuery(project.title, query)), projectItem),
        };
        const view: Omit<NativeBoardView, 'version' | 'revision' | 'columns'> = {
            filters,
            bar: {
                searchPlaceholder: summary.searchPlaceholder,
                searchQuery: filters.searchQuery,
                searchActive: summary.searchActive,
                active: summary.active,
                clearLabel: summary.clearLabel,
                filterLabel: summary.filterLabel,
            },
            sheet: {
                tokens: firstPage(lists.tokens),
                projects: firstPage(lists.projects),
                showContextMatchMode: resolved.showContextMatchMode,
                showTagMatchMode: resolved.showTagMatchMode,
                chips: firstPage(lists.chips),
                additionalChips: summary.chips.map((chip) => ({
                    ...chip, edit: chip.id === 'board-search' ? { type: 'setSearch', value: '' } : { type: 'clearDuePreset' },
                })),
                due: summary.due,
            },
            cardActions: {
                editorTab: 'view',
                swipes: {
                    left: { label: cardText.duplicate, actions: BOARD_CARD_SWIPES.left.actions },
                    right: { label: cardText.delete, actions: BOARD_CARD_SWIPES.right.actions },
                },
                errorTitle: cardText.errorTitle,
                complete: { label: resolveI18nText(t, 'common.done') },
                moveTo: { label: t('task.moveTo'), destinations: columns
                    .filter(column => ['inbox', 'next', 'waiting', 'someday'].includes(column.status))
                    .map(column => ({ status: column.status as NativeBoardMoveStatus, label: column.label })) },
            },
        };
        const ordering = new Map<BoardStatus, { order: NativeBoardColumnOrder; actions: Map<string, NativeBoardOrderActions> }>();
        if (includeOrdering) for (const column of columns) {
            const actions = new Map<string, NativeBoardOrderActions>();
            let token: string | null = null;
            try {
                const snapshot = orderMethods.snapshot(filters, column.status, now, state, { filters, columns });
                const scope = snapshot?.scope;

                token = snapshot?.token ?? null;
                if (token && scope && typeof state.settings.deviceId === 'string' && state.settings.deviceId.trim()) {
                    const writable = boardOrderWritability(scope);
                    for (let index = 0; index < column.tasks.length; index++) {
                        const row = column.tasks[index];
                        if (!writable(row)) continue;
                        actions.set(row.id, { up: index === 0 ? null : { afterId: index === 1 ? null : column.tasks[index - 2].id },
                            down: index === column.tasks.length - 1 ? null : { afterId: column.tasks[index + 1].id } });
                    }
                }
            } catch { token = null; }
            ordering.set(column.status, { order: { available: token !== null, expectedOrder: token,
                moveUpLabel: resolveI18nText(t, 'projects.moveUp'), moveDownLabel: resolveI18nText(t, 'projects.moveDown') }, actions });
        }
        return { view, columns, lists, search, badges, timeEstimatesEnabled, ordering };
    }

    const orderMethods = createBoardOrderMethods({ ...deps, readFilters,
        snapshot: (filters, now, state) => { const board = buildBoard(filters, now, state, false);
            return { filters: board.view.filters, columns: board.columns }; } });


    const readBoard = (input: Record<string, unknown>) => {
        const read = readFilters(input.filters);
        if (!read || (input.filterEdit !== undefined && !isFilterEdit(input.filterEdit))) return null;
        const edited = input.filterEdit === undefined ? read : applyBoardFilterEdit(read, input.filterEdit as BoardFilterEdit);
        if (!readFilters(edited)) return null;
        const now = new Date();
        const base = deps.revision(now);
        const key = `${base}:${paramsKey(edited)}`;
        if (cache?.key !== key) cache = { key, value: buildBoard(edited, now) };

        return { now, board: cache.value, revision: `${base}:${paramsKey(cache.value.view.filters)}` };
    };

    const moveAllowed = (task: Task): boolean => {
        const state = useTaskStore.getState();
        const inferred = task.projectId ?? state._sectionsById.get(task.sectionId ?? '')?.projectId;
        const parent = inferred ? state._projectsById.get(inferred) : undefined;
        return ['inbox', 'next', 'waiting', 'someday', 'done'].includes(task.status) && !task.deletedAt && !task.purgedAt
            && (task.status !== 'done' || state._allTasks.filter(row => row.id === task.id).length === 1
                && boardReactivationContainerAllowed(task, state._allProjects, state._allSections))
            && !isProjectedRecurringTaskId(task.id) && typeof state.settings.deviceId === 'string' && Boolean(state.settings.deviceId.trim())
            && !isStatusListTaskReadOnly({ ...task, projectId: inferred }, parent ? [parent] : []);
    };
    const cards = (board: ReturnType<typeof buildBoard>, tasks: readonly Task[], now: Date): NativeBoardCard[] => {
        const rows = deps.rows(tasks, now);
        const state = useTaskStore.getState();


        const projects = new Map<string, Project[]>(); const sections = new Map<string, Section[]>();
        for (const row of state._allProjects) projects.set(row.id, [...(projects.get(row.id) ?? []), row]);
        for (const row of state._allSections) sections.set(row.id, [...(sections.get(row.id) ?? []), row]);
        const completeAllowed = (task: Task) => {
            const sourceSections = sections.get(task.sectionId ?? '') ?? [];
            const parentId = task.projectId ?? sourceSections[0]?.projectId;
            return canCompleteNativeBoardTask(task, projects.get(parentId ?? '') ?? [], sourceSections);
        };
        return tasks.map((task, index) => ({
            row: rows[index],
            card: getBoardCard(task, { badges: board.badges, timeEstimatesEnabled: board.timeEstimatesEnabled, t: deps.t() }),
            boardOrder: Number.isFinite(task.boardOrder) ? task.boardOrder as number : null,
            moveAllowed: moveAllowed(task),
            completeAllowed: completeAllowed(task),
            ...(board.ordering.get(task.status as BoardStatus)?.actions.has(task.id)
                ? { orderActions: board.ordering.get(task.status as BoardStatus)!.actions.get(task.id)! } : {}),
        }));
    };


    type Outcome = NativeHostResult<NativeBoardActionResult> | NativeUnsavedWrite<NativeBoardActionResult>;

    type Prepared = { result: Outcome } | { write: () => Promise<Outcome> };

    const unchanged: Prepared = { result: { ok: true, value: { changed: false, open: null } } };
    const refuse = (code: NativeHostErrorCode, message: string): Prepared => ({ result: fail(code, message) });

    const stale = (task: Task, taskRevision: string): Prepared | null => {
        const refused = refuseStale([task], [taskRevision], 'The card changed since the Board showed it; read the Board again');
        return refused ? { result: refused } : null;
    };
    const liveTask = (id: unknown) => {
        const task = typeof id === 'string' ? useTaskStore.getState()._tasksById.get(id) : undefined;
        return task && !task.deletedAt && !task.purgedAt ? task : undefined;
    };


    const written = async (call: Parameters<typeof runStoreWrite>[0], open: () => NativeBoardActionResult['open'] = () => null): Promise<Outcome> => {
        const before = useTaskStore.getState()._allTasks;
        const landed = await runStoreWrite(call);
        return settleWrite(landed, { changed: useTaskStore.getState()._allTasks !== before, open: open() });
    };

    const prepare = (action: NativeBoardAction, requestId: string): Prepared => {
        const store = useTaskStore.getState();
        switch (action.type) {
            case 'moveCard': {
                const filters = readFilters(action.filters);
                if (!isBoardStatus(action.status) || !filters || !isRevision(action.taskRevision)
                    || !(action.afterId === undefined || action.afterId === null || isText(action.afterId))) {
                    return refuse('INVALID_INPUT', 'A task, a Board column, an optional card to land after, valid filters and the revision the view showed are required');
                }
                const task = liveTask(action.taskId);
                if (!task) return refuse('TASK_NOT_FOUND', 'Task not found');
                if (!isBoardStatus(task.status)) return refuse('INVALID_INPUT', 'The card is not on the Board');
                let columnIds: string[] = [];
                if (task.status !== action.status) {
                    if (action.afterId !== undefined) return refuse('INVALID_INPUT', 'A drop into another column has no position');
                } else if (action.afterId !== undefined) {
                    const { board } = readBoard({ filters })!;
                    columnIds = board.columns.find((column) => column.status === action.status)!.tasks.map((entry) => entry.id);
                    if (!columnIds.includes(task.id) || (action.afterId !== null && (action.afterId === task.id || !columnIds.includes(action.afterId)))) {
                        return refuse('INVALID_INPUT', 'The card and the card it lands after must be shown in that column');
                    }
                }
                const plan = planBoardDrop({ task, status: action.status, columnIds, afterId: action.afterId });
                if (!plan) return unchanged;
                const refused = stale(task, action.taskRevision);
                if (refused) return refused;
                return {
                    write: () => written(() => (plan.kind === 'status'
                        ? store.updateTask(plan.taskId, { status: plan.status })
                        : store.reorderBoardTasks(plan.status, plan.orderedIds, plan.taskId))),
                };
            }
            case 'trashTask': {
                if (!isRevision(action.taskRevision)) return refuse('INVALID_INPUT', 'A task and the revision the view showed are required');
                const task = typeof action.taskId === 'string' ? store._tasksById.get(action.taskId) : undefined;
                if (!task || task.purgedAt) return refuse('TASK_NOT_FOUND', 'Task not found');
                if (task.deletedAt) return unchanged;
                return stale(task, action.taskRevision) ?? { write: () => written(() => store.deleteTask(task.id)) };
            }
            case 'duplicateTask': {
                const task = liveTask(action.taskId);
                if (!task) return refuse('TASK_NOT_FOUND', 'Task not found');
                const copy = store._tasksById.get(requestId);
                if (copy) {

                    if (!matchesDuplicateSource(task, copy)) {
                        return refuse('INVALID_INPUT', 'The duplicate request ID does not match this source');
                    }
                    return { result: { ok: true, value: { changed: false, open: { taskId: copy.id, projectId: task.projectId ?? null, tab: 'task' } } } };
                }
                const { duplicateFailed } = getBoardCardText(deps.t());
                let createdId: string | undefined;

                return {
                    write: () => written(async () => {
                        try {
                            const result = await store.duplicateTask(task.id, false, requestId);
                            createdId = result.id;
                            return result.success && result.id ? result : { success: false, error: result.error || duplicateFailed };
                        } catch {
                            return { success: false, error: duplicateFailed };
                        }
                    }, () => (createdId ? { taskId: createdId, projectId: task.projectId ?? null, tab: 'task' } : null)),
                };
            }
            default:
                return refuse('INVALID_INPUT', 'The Board does not offer that action');
        }
    };
    const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
        Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
    const detach = (input: unknown): unknown => {
        try {
            const json = JSON.stringify(input);
            return json.length <= 2_000_000 ? JSON.parse(json) : null;
        } catch { return null; }
    };
    const readWriteRequest = (input: unknown): NativeBoardWriteRequest | null => {
        if (!isObjectRecord(input) || !exactKeys(input, ['requestId', 'action'])
            || typeof input.requestId !== 'string' || !deps.requestIdPattern.test(input.requestId)
            || !isObjectRecord(input.action) || !isText(input.action.taskId) || !input.action.taskId) return null;
        const action = input.action;
        const valid = action.type === 'moveCard'
            ? exactKeys(action, ['type', 'taskId', 'status', 'taskRevision', 'filters'])
                && typeof action.status === 'string' && ['inbox', 'next', 'waiting', 'someday'].includes(action.status)
                && isRevision(action.taskRevision) && isObjectRecord(action.filters) && readFilters(action.filters) !== null
            : exactKeys(action, ['type', 'taskId']) && typeof action.type === 'string' && ['duplicateTask', 'trashTask'].includes(action.type);
        return valid ? input as unknown as NativeBoardWriteRequest : null;
    };
    const taskRecord = (input: unknown): input is Task => isObjectRecord(input)
        && isText(input.id) && Boolean(input.id) && typeof input.title === 'string'
        && ['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived'].includes(input.status as string)
        && typeof input.createdAt === 'string' && typeof input.updatedAt === 'string'
        && Object.keys(input).every((name) => TASK_SYNC_FIELD_SCHEMA.some((field) => field.name === name));
    const moveDates = (before: Task, scope: PreparedBoardMove['scope']): string[] => [...new Set([before, ...scope.focused]
        .flatMap(row => [row.startTime, row.dueDate, row.reviewAt]).filter((value): value is string => typeof value === 'string' && value.length > 0))].sort();
    const readMove = (value: unknown, before: Task, at: string): value is PreparedBoardMove => {
        if (!isObjectRecord(value) || !exactKeys(value, ['deviceIdBefore', 'clock', 'scope'])
            || typeof value.deviceIdBefore !== 'string' || !value.deviceIdBefore.trim() || value.deviceIdBefore.length > 500
            || !isObjectRecord(value.clock) || !exactKeys(value.clock, ['preparedLocalDay', 'preparedOffsetMinutes', 'boundaryOffsetMinutes', 'futureBoundary', 'dates'])
            || !isObjectRecord(value.scope) || !exactKeys(value.scope, ['projects', 'sections', 'areas', 'focused', 'focusLimit'])) return false;
        const move = value as unknown as PreparedBoardMove; const { clock, scope } = move;
        const collections = [[scope.projects, PROJECT_SYNC_FIELD_SCHEMA], [scope.sections, SECTION_SYNC_FIELD_SCHEMA], [scope.areas, AREA_SYNC_FIELD_SCHEMA]] as const;
        if (collections.some(([rows, schema]) => !Array.isArray(rows) || rows.some((row, index) => !isObjectRecord(row)
            || typeof row.id !== 'string' || !row.id || typeof row.title !== 'string' && typeof row.name !== 'string'
            || Object.keys(row).some(key => !schema.some(field => field.name === key))
            || index > 0 && rows[index - 1].id >= row.id))
            || scope.projects.length > 2 || scope.sections.length > 1 || scope.areas.length > 1
            || scope.sections.some(row => row.id !== before.sectionId)
            || scope.projects.some(row => row.id !== before.projectId && row.id !== scope.sections[0]?.projectId)
            || scope.areas.some(row => row.id !== before.areaId)
            || !Array.isArray(scope.focused) || scope.focused.some((row, index) => !isObjectRecord(row)
                || !exactKeys(row, ['id', 'status', 'createdAt', 'projectId', 'sectionId', 'startTime', 'dueDate', 'reviewAt', 'order', 'orderNum', 'isFocusedToday', 'recurrence'])
                || row.isFocusedToday !== true || !validRawTask({ ...row, title: '', updatedAt: row.createdAt, tags: [], contexts: [] }, row.id)
                || index > 0 && scope.focused[index - 1].id >= row.id)
            || !Number.isInteger(scope.focusLimit) || scope.focusLimit < 1) return false;
        try {
            return /^\d{4}-\d{2}-\d{2}$/.test(clock.preparedLocalDay)
                && Number.isInteger(clock.preparedOffsetMinutes) && Math.abs(clock.preparedOffsetMinutes) <= 840
                && Number.isInteger(clock.boundaryOffsetMinutes) && Math.abs(clock.boundaryOffsetMinutes) <= 840
                && new Date(Date.parse(at) - clock.preparedOffsetMinutes * 60_000).toISOString().slice(0, 10) === clock.preparedLocalDay
                && new Date(Date.parse(clock.preparedLocalDay + 'T23:59:59.999Z') + clock.boundaryOffsetMinutes * 60_000).toISOString() === clock.futureBoundary
                && Array.isArray(clock.dates) && clock.dates.every(validFrozenFocusDate)
                && taskEditValuesEqual(clock.dates.map(row => row.value), moveDates(before, scope));
        } catch { return false; }
    };
    const readPrepared = (input: unknown): NativePreparedBoardAction | null => {
        const detached = detach(input);
        if (!isObjectRecord(detached) || (detached.version !== 1 && detached.version !== 2)
            || !taskRecord(detached.before) || !taskRecord(detached.after)) return null;
        const request = readWriteRequest(detached.request);
        if (!request || (detached.version === 2 && request.action.type !== 'duplicateTask')
            || !exactKeys(detached, ['version', 'request', 'before', 'after', 'deviceIdToInitialize', 'result',
            ...(request.action.type === 'moveCard' ? ['move'] : [])])) return null;
        const prepared = detached as unknown as NativePreparedBoardAction;
        const { before, after, deviceIdToInitialize } = prepared;
        try {
            if (before.id !== request.action.taskId || before.deletedAt || before.purgedAt
                || !isText(after.revBy) || !after.revBy || new Date(after.updatedAt).toISOString() !== after.updatedAt
                || (deviceIdToInitialize !== null && (deviceIdToInitialize !== after.revBy || !deps.requestIdPattern.test(deviceIdToInitialize)))) return null;
            let expected: Task;
            let result: NativeBoardActionResult;
            if (request.action.type === 'moveCard') {
                if (deviceIdToInitialize !== null || !validRawTask(before, before.id) || !validRawTask(after, before.id)
                    || taskRevisionOf(before) !== request.action.taskRevision || !readMove(prepared.move, before, after.updatedAt)
                    || after.revBy !== prepared.move!.deviceIdBefore) return null;
                expected = boardMoveEffect(before, request.action.status, prepared.move!, after.updatedAt);
                result = { changed: true, open: null };
            } else if (request.action.type === 'trashTask') {
                expected = { ...before, deletedAt: after.updatedAt, updatedAt: after.updatedAt, rev: nextRevision(before.rev), revBy: after.revBy };
                result = { changed: true, open: null };
            } else {
                if (after.id !== request.requestId || after.id === before.id || after.order !== after.orderNum
                    || (before.projectId ? typeof after.order !== 'number' || !Number.isFinite(after.order) : after.order !== undefined)
                    || (after.boardOrder !== undefined && (!Number.isSafeInteger(after.boardOrder)
                        || !Number.isSafeInteger(before.boardOrder) || after.boardOrder <= before.boardOrder!))) return null;
                const ids = [...(after.checklist ?? []).map((item) => item.id), ...(after.attachments ?? []).map((item) => item.id)];
                const sourceIds = new Set([before.id, ...(before.checklist ?? []).map((item) => item.id), ...(before.attachments ?? []).map((item) => item.id)]);
                if (!ids.every((id) => typeof id === 'string' && deps.requestIdPattern.test(id) && !sourceIds.has(id))
                    || new Set([after.id, ...ids]).size !== ids.length + 1) return null;
                let index = 0;

                const sourceTask = prepared.version === 1
                    ? { ...before, checklist: before.checklist?.map((item) => ({ ...item, isCompleted: false })) } : before;
                expected = buildDuplicateTask({ sourceTask, copyId: request.requestId, now: after.createdAt, deviceId: after.revBy,
                    projectOrder: after.order, boardOrder: after.boardOrder, generateId: () => ids[index++] });
                if (index !== ids.length) return null;
                result = { changed: true, open: { taskId: after.id, projectId: after.projectId ?? null, tab: 'task' } };
            }
            return taskEditValuesEqual(after, expected) && taskEditValuesEqual(prepared.result, result) ? prepared : null;
        } catch { return null; }
    };
    const readPreparedCommand = (input: unknown): NativePreparedBoardAction | null => {
        if (!isObjectRecord(input) || !exactKeys(input, ['request', 'prepared'])) return null;
        const request = readWriteRequest(detach(input.request));
        const prepared = readPrepared(input.prepared);
        return request && prepared && taskEditValuesEqual(request, prepared.request) ? prepared : null;
    };
    const readCalendarDeleteRequest = (input: unknown): NativeCalendarDeleteRequest | null => (
        isObjectRecord(input) && exactKeys(input, ['requestId', 'taskId', 'taskRevision'])
        && typeof input.requestId === 'string' && deps.requestIdPattern.test(input.requestId)
        && typeof input.taskId === 'string' && input.taskId.length > 0 && input.taskId.length <= 200
        && typeof input.taskRevision === 'string' && input.taskRevision.length > 0 && input.taskRevision.length <= 200
            ? input as NativeCalendarDeleteRequest : null
    );
    const readPreparedCalendarDelete = (input: unknown): NativePreparedCalendarDelete | null => {
        try {
            const json = JSON.stringify(input);
            if (typeof json !== 'string' || !utf8Within(json, 2_000_000)
                || !isObjectRecord(input) || !exactKeys(input, ['request', 'prepared'])
                || !isObjectRecord(input.prepared) || !exactKeys(input.prepared, ['version', 'request', 'board'])
                || input.prepared.version !== 1 || !isObjectRecord(input.prepared.board)
                || !exactKeys(input.prepared.board, ['request', 'prepared'])) return null;
            const request = readCalendarDeleteRequest(input.request);
            const wrapped = readCalendarDeleteRequest(input.prepared.request);
            const board = readPreparedCommand(input.prepared.board);
            if (!request || !wrapped || !board || !taskEditValuesEqual(request, wrapped)
                || board.request.requestId !== request.requestId || board.request.action.type !== 'trashTask'
                || board.request.action.taskId !== request.taskId || board.before.id !== request.taskId
                || taskRevisionOf(board.before) !== request.taskRevision
                || board.before.deletedAt || board.before.purgedAt || board.before.status === 'reference'
                || isProjectedRecurringTaskId(request.taskId)
                || !taskEditValuesEqual(board.result, { changed: true, open: null })) return null;
            return input.prepared as NativePreparedCalendarDelete;
        } catch { return null; }
    };
    const bounded = (input: unknown): unknown => {
        try {
            const json = JSON.stringify(input);
            return typeof json === 'string' && utf8Within(json, 2_000_000) ? JSON.parse(json) : null;
        } catch { return null; }
    };
    const validNotice = (value: unknown, max: number): value is string => typeof value === 'string'
        && value.length > 0 && value.length <= max && value.trim() === value
        && Array.from(value).every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127);
    const readTaskDeleteRequest = (input: unknown, allowSource = false): NativeTaskDeleteRequest | null => isObjectRecord(input)
        && (exactKeys(input, ['requestId', 'taskId', 'taskRevision'])
            || allowSource && exactKeys(input, ['requestId', 'taskId', 'taskRevision', 'source'])
                && (input.source === 'archive' || input.source === 'done' || input.source === 'reference'))
        && typeof input.requestId === 'string' && deps.requestIdPattern.test(input.requestId)
        && typeof input.taskId === 'string' && input.taskId.length > 0 && input.taskId.length <= 200
        && typeof input.taskRevision === 'string' && input.taskRevision.length > 0 && input.taskRevision.length <= 200
            ? input as NativeTaskDeleteRequest : null;
    const readPreparedTaskDelete = (input: unknown): NativeTaskDeleteEnvelope | null => {
        const envelope = bounded(input);
        if (!isObjectRecord(envelope) || !exactKeys(envelope, ['request', 'prepared'])
            || !isObjectRecord(envelope.prepared)
            || !exactKeys(envelope.prepared, ['version', 'request', 'board', 'result'])
            || envelope.prepared.version !== 1 || !isObjectRecord(envelope.prepared.board)
            || !exactKeys(envelope.prepared.board, ['request', 'prepared'])) return null;
        const request = readTaskDeleteRequest(envelope.request, true);
        const wrapped = readTaskDeleteRequest(envelope.prepared.request, true);
        const board = readPreparedCommand(envelope.prepared.board);
        const result = envelope.prepared.result;
        if (!request || !wrapped || !board || !taskEditValuesEqual(request, wrapped)
            || board.request.requestId !== request.requestId || board.request.action.type !== 'trashTask'
            || board.request.action.taskId !== request.taskId || board.before.id !== request.taskId
            || taskRevisionOf(board.before) !== request.taskRevision || board.before.deletedAt || board.before.purgedAt
            || (request.source === 'archive' && board.before.status !== 'archived')
            || (request.source === 'done' && board.before.status !== 'done')
            || (request.source === 'reference' && board.before.status !== 'reference')
            || isProjectedRecurringTaskId(request.taskId)
            || !taskEditValuesEqual(board.result, { changed: true, open: null })
            || !isObjectRecord(result) || !exactKeys(result, ['id', 'deletion']) || result.id !== request.taskId
            || !isObjectRecord(result.deletion) || !exactKeys(result.deletion, ['message', 'undoLabel', 'undoEnabled'])
            || !validNotice(result.deletion.message, 512) || !validNotice(result.deletion.undoLabel, 80)
            || result.deletion.undoEnabled !== true) return null;
        return envelope as NativeTaskDeleteEnvelope;
    };
    const readTaskDeleteUndoRequest = (input: unknown): NativeTaskDeleteUndoRequest | null => isObjectRecord(input)
        && exactKeys(input, ['requestId', 'deleteRequestId'])
        && typeof input.requestId === 'string' && deps.requestIdPattern.test(input.requestId)
        && typeof input.deleteRequestId === 'string' && deps.requestIdPattern.test(input.deleteRequestId)
        && input.requestId !== input.deleteRequestId ? input as NativeTaskDeleteUndoRequest : null;
    const restoreScope = (task: Task, state: Pick<ReturnType<typeof useTaskStore.getState>, '_allProjects' | '_allSections' | '_allAreas'>): NativeRestoreScope => {
        const section = state._allSections.find((entry) => entry.id === task.sectionId);
        const projects = new Set([task.projectId, section?.projectId]);
        return {
            projects: state._allProjects.filter((entry) => projects.has(entry.id)),
            sections: section ? [section] : [],
            areas: state._allAreas.filter((entry) => entry.id === task.areaId),
        };
    };
    const readPreparedTaskDeleteUndo = (input: unknown): NativeTaskDeleteUndoEnvelope | null => {
        const envelope = bounded(input);
        if (!isObjectRecord(envelope) || !exactKeys(envelope, ['request', 'prepared'])
            || !isObjectRecord(envelope.prepared)
            || !exactKeys(envelope.prepared, ['version', 'request', 'delete', 'before', 'after', 'scope',
                'deviceIdBefore', 'deviceIdToInitialize', 'result']) || envelope.prepared.version !== 1) return null;
        const request = readTaskDeleteUndoRequest(envelope.request);
        const raw = envelope.prepared;
        const wrapped = readTaskDeleteUndoRequest(raw.request);
        const deletion = readPreparedTaskDelete(raw.delete);
        if (!request || !wrapped || !taskEditValuesEqual(request, wrapped) || !deletion
            || request.deleteRequestId !== deletion.request.requestId || !taskEditValuesEqual(raw.delete, deletion)
            || !taskRecord(raw.before) || !taskRecord(raw.after) || !isObjectRecord(raw.scope)
            || !exactKeys(raw.scope, ['projects', 'sections', 'areas'])
            || !Array.isArray(raw.scope.projects) || !Array.isArray(raw.scope.sections) || !Array.isArray(raw.scope.areas)
            || raw.scope.projects.length > 2 || raw.scope.sections.length > 1 || raw.scope.areas.length > 1
            || !raw.scope.projects.every((entry) => isObjectRecord(entry) && typeof entry.id === 'string')
            || !raw.scope.sections.every((entry) => isObjectRecord(entry) && typeof entry.id === 'string'
                && typeof entry.projectId === 'string')
            || !raw.scope.areas.every((entry) => isObjectRecord(entry) && typeof entry.id === 'string')
            || !isObjectRecord(raw.result) || !exactKeys(raw.result, ['id'])) return null;
        const prepared = raw as unknown as NativePreparedTaskDeleteUndo;
        const { before, after, scope } = prepared;
        const section = scope.sections[0];
        const allowedProjects = new Set([before.projectId, section?.projectId]);
        if (!taskEditValuesEqual(before, deletion.prepared.board.prepared.after) || !before.deletedAt || before.purgedAt
            || before.id !== after.id || prepared.result.id !== before.id
            || scope.projects.some((entry) => !allowedProjects.has(entry.id))
            || scope.sections.some((entry) => entry.id !== before.sectionId)
            || scope.areas.some((entry) => entry.id !== before.areaId)
            || new Set(scope.projects.map((entry) => entry.id)).size !== scope.projects.length
            || !isText(after.revBy) || !after.revBy
            || typeof after.updatedAt !== 'string' || !Number.isFinite(Date.parse(after.updatedAt))
            || new Date(after.updatedAt).toISOString() !== after.updatedAt
            || prepared.deviceIdBefore !== null && typeof prepared.deviceIdBefore !== 'string'
            || (prepared.deviceIdBefore === null
                ? typeof prepared.deviceIdToInitialize !== 'string'
                    || !deps.requestIdPattern.test(prepared.deviceIdToInitialize)
                    || after.revBy !== prepared.deviceIdToInitialize
                : prepared.deviceIdToInitialize !== null || after.revBy !== prepared.deviceIdBefore)) return null;
        try {
            const expected = { ...before, deletedAt: undefined,
                ...sanitizeRestoredTaskContainerReferences(before, {
                    _allProjects: scope.projects, _allSections: scope.sections, _allAreas: scope.areas,
                }), updatedAt: after.updatedAt, rev: nextRevision(before.rev), revBy: after.revBy };
            return taskEditValuesEqual(after, expected) ? envelope as NativeTaskDeleteUndoEnvelope : null;
        } catch { return null; }
    };
    const readPreparedTrashTaskRestore = (input: unknown): NativeTrashTaskRestoreEnvelope | null => {
        const envelope = bounded(input);
        if (!isObjectRecord(envelope) || !exactKeys(envelope, ['request', 'prepared'])
            || !isObjectRecord(envelope.prepared)
            || !exactKeys(envelope.prepared, ['version', 'request', 'before', 'after', 'scope',
                'deviceIdBefore', 'deviceIdToInitialize', 'result']) || envelope.prepared.version !== 1) return null;
        const request = readTaskDeleteRequest(envelope.request);
        const raw = envelope.prepared;
        const wrapped = readTaskDeleteRequest(raw.request);
        if (!request || !wrapped || !taskEditValuesEqual(request, wrapped)
            || !validRawTask(raw.before, request.taskId) || !validRawTask(raw.after, request.taskId)
            || !isObjectRecord(raw.scope) || !exactKeys(raw.scope, ['projects', 'sections', 'areas'])
            || !Array.isArray(raw.scope.projects) || !Array.isArray(raw.scope.sections) || !Array.isArray(raw.scope.areas)
            || raw.scope.projects.length > 2 || raw.scope.sections.length > 1 || raw.scope.areas.length > 1
            || !raw.scope.projects.every((entry) => isObjectRecord(entry) && typeof entry.id === 'string')
            || !raw.scope.sections.every((entry) => isObjectRecord(entry) && typeof entry.id === 'string'
                && typeof entry.projectId === 'string')
            || !raw.scope.areas.every((entry) => isObjectRecord(entry) && typeof entry.id === 'string')
            || !isObjectRecord(raw.result) || !exactKeys(raw.result, ['id'])) return null;
        const prepared = raw as unknown as NativePreparedTrashTaskRestore;
        const { before, after, scope } = prepared;
        const section = scope.sections[0];
        const allowedProjects = new Set([before.projectId, section?.projectId]);
        if (!before.deletedAt || before.purgedAt || isProjectedRecurringTaskId(request.taskId)
            || taskRevisionOf(before) !== request.taskRevision || prepared.result.id !== request.taskId
            || scope.projects.some((entry) => !allowedProjects.has(entry.id))
            || scope.sections.some((entry) => entry.id !== before.sectionId)
            || scope.areas.some((entry) => entry.id !== before.areaId)
            || new Set(scope.projects.map((entry) => entry.id)).size !== scope.projects.length
            || !isText(after.revBy) || !after.revBy
            || typeof after.updatedAt !== 'string' || !Number.isFinite(Date.parse(after.updatedAt))
            || new Date(after.updatedAt).toISOString() !== after.updatedAt
            || prepared.deviceIdBefore !== null && typeof prepared.deviceIdBefore !== 'string'
            || (prepared.deviceIdBefore === null
                ? typeof prepared.deviceIdToInitialize !== 'string'
                    || !deps.requestIdPattern.test(prepared.deviceIdToInitialize)
                    || after.revBy !== prepared.deviceIdToInitialize
                : prepared.deviceIdToInitialize !== null || after.revBy !== prepared.deviceIdBefore)) return null;
        try {
            const expected = { ...before, deletedAt: undefined,
                ...sanitizeRestoredTaskContainerReferences(before, {
                    _allProjects: scope.projects, _allSections: scope.sections, _allAreas: scope.areas,
                }), updatedAt: after.updatedAt, rev: nextRevision(before.rev), revBy: after.revBy };
            return taskEditValuesEqual(after, expected) ? envelope as NativeTrashTaskRestoreEnvelope : null;
        } catch { return null; }
    };

    const canonicalJSON = (input: unknown): string => JSON.stringify(input, (_name, value) =>
        isObjectRecord(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);

    const prepareBoardActionBody = (input: NativeBoardWriteRequest): NativeHostResult<NativeBoardPrepareResult> => {
        const ready = deps.readiness();
        if (!ready.ok) return ready;
        const request = readWriteRequest(detach(input));
        if (!request) return fail('INVALID_INPUT', 'A request UUID and a supported Board action are required');
        const state = useTaskStore.getState();
        const source = state._tasksById.get(request.action.taskId);
        if (!source || source.purgedAt || (source.deletedAt && request.action.type !== 'trashTask')) return fail('TASK_NOT_FOUND', 'Task not found');
        if (source.deletedAt) return { ok: true, value: { kind: 'noop', result: { changed: false, open: null } } };
        if (request.action.type === 'moveCard') {
            if (!moveAllowed(source)) return fail('INVALID_INPUT', 'This card is read-only or needs an unsupported lifecycle/device identity; Board Move supports one task only');
            const shown = readBoard({ filters: request.action.filters });
            if (!shown || !shown.board.columns.some(column => column.tasks.some(row => row.id === source.id)))
                return fail('INVALID_INPUT', 'The card is not shown under the current Board filters');
            if (taskRevisionOf(source) !== request.action.taskRevision) return fail('STALE_REVISION', 'The card changed since the Board showed it');
            if (source.status === request.action.status) return { ok: true, value: { kind: 'noop', result: { changed: false, open: null } } };
            const before = detach(source); if (!taskRecord(before)) return fail('INVALID_INPUT', 'Task cannot fit a valid bounded Board journal');
            const now = new Date(); const at = now.toISOString(); const end = new Date(now); end.setHours(23, 59, 59, 999);
            const scope = boardMoveScope(state, before); const offset = now.getTimezoneOffset();
            const move: PreparedBoardMove = { deviceIdBefore: state.settings.deviceId!, scope, clock: {
                preparedLocalDay: new Date(now.getTime() - offset * 60_000).toISOString().slice(0, 10),
                preparedOffsetMinutes: offset, boundaryOffsetMinutes: end.getTimezoneOffset(), futureBoundary: end.toISOString(),
                dates: projectFocusDateValues(moveDates(before, scope)),
            } };
            try {
                const after = boardMoveEffect(before, request.action.status, move, at);
                const prepared = readPrepared({ version: 1, request, before, after, deviceIdToInitialize: null,
                    result: { changed: true, open: null }, move });
                return prepared ? { ok: true, value: { kind: 'prepared', prepared } }
                    : fail('INVALID_INPUT', 'Board Move cannot produce a valid frozen one-task journal');
            } catch (error) { return fail('INVALID_INPUT', error instanceof Error ? error.message : 'Board Move scope refused'); }
        }

        if (request.action.type === 'duplicateTask' && state._tasksById.has(request.requestId)) {
            return fail('INVALID_INPUT', 'The duplicate request ID is already in use; retry its prepared command');
        }
        const before = detach(source);
        if (!taskRecord(before)) return fail('INVALID_INPUT', 'Task cannot fit a valid bounded Board journal');
        const device = ensureDeviceId(state.settings);
        const now = new Date().toISOString();
        const after = request.action.type === 'trashTask'
            ? { ...before, deletedAt: now, updatedAt: now, rev: nextRevision(before.rev), revBy: device.deviceId }
            : buildDuplicateTask({ sourceTask: before, copyId: request.requestId, now, deviceId: device.deviceId,
                projectOrder: before.projectId ? createProjectOrderReserver(state._allTasks)(before.projectId) : undefined,
                boardOrder: boardOrderForDuplicate(before.boardOrder, state._allTasks.filter((task) => task.status === before.status && !task.deletedAt)) });
        const result: NativeBoardActionResult = { changed: true, open: request.action.type === 'duplicateTask'
            ? { taskId: after.id, projectId: after.projectId ?? null, tab: 'task' } : null };
        const prepared = readPrepared({ version: request.action.type === 'duplicateTask' ? 2 : 1,
            request, before, after, deviceIdToInitialize: device.updated ? device.deviceId : null, result });
        return prepared ? { ok: true, value: { kind: 'prepared', prepared } }
            : fail('INVALID_INPUT', 'Board action cannot produce a valid bounded journal');
    };

    const commitPreparedBoard = (prepared: NativePreparedBoardAction, receiptKind: 'preparedBoard' | 'preparedCalendarDelete', respectReadOnly = false) => (
        receipts.run(prepared.request.requestId, canonicalJSON([receiptKind, prepared]), async () => {
            const result = await useTaskStore.getState().commitPreparedBoardTask({
                kind: prepared.request.action.type, before: prepared.before, after: prepared.after,
                deviceIdToInitialize: prepared.deviceIdToInitialize,
                ...(prepared.request.action.type === 'moveCard' ? { move: prepared.move,
                    admitMove: () => {
                        const current = useTaskStore.getState()._tasksById.get(prepared.before.id);
                        const shown = readBoard({ filters: (prepared.request.action as Extract<NativeBoardWriteRequest['action'], { type: 'moveCard' }>).filters });
                        return Boolean(current && moveAllowed(current) && shown?.board.columns.some(column => column.tasks.some(row => row.id === current.id)));
                    } } : {}),
                ...(respectReadOnly ? { respectReadOnly: true as const } : {}),
            });
            if (!result.success) return fail(result.reason === 'conflict' ? 'STALE_REVISION' : 'INVALID_INPUT', result.error ?? 'Prepared Board action refused');
            return { ok: true as const, value: prepared.result };
        })
    );


    let reactivationAdapter: NativeReceiptSqliteAdapter | null = null;
    const boundReactivationAdapter = (): NativeReceiptSqliteAdapter | null => {
        if (!deps.readiness().ok) return null;
        const adapter = getStorageAdapter();
        if (!(adapter instanceof NativeReceiptSqliteAdapter) || !adapter.concurrentWritesGuarded
            || !isNativeRequestReceiptDurable('boardTaskReactivate')) return null;
        if (reactivationAdapter === null) reactivationAdapter = adapter;
        return reactivationAdapter === adapter ? adapter : null;
    };
    const reactivationSaves = createAreaSaveGuard(deps.save);
    let pendingReactivation: { prepared: NativePreparedBoardAction; adapter: ReturnType<typeof getStorageAdapter>;
        boundary: PreparedNativeSaveBoundary | undefined } | null = null;
    const reactivationPayload = (prepared: NativePreparedBoardAction) => canonicalJSON(['boardTaskReactivate', prepared]);
    const reactivationState = (data: AppData): TaskStore => ({ ...useTaskStore.getState(),
        _allTasks: data.tasks, _allProjects: data.projects, _allSections: data.sections ?? [], _allAreas: data.areas ?? [],
        tasks: data.tasks.filter(row => !row.deletedAt && !row.purgedAt),
        projects: data.projects.filter(row => !row.deletedAt && !row.purgedAt),
        areas: (data.areas ?? []).filter(row => !row.deletedAt), settings: data.settings });
    const checkReactivation = (prepared: NativePreparedBoardAction, authority: PreparedAreaAuthority): NativeHostResult<null> => {
        const data = authority.snapshot; const source = data.tasks.filter(row => row.id === prepared.before.id);
        const state = reactivationState(data); const move = prepared.move!;
        if (source.length !== 1 || !samePreparedTask(source[0], prepared.before)
            || data.settings.deviceId !== move.deviceIdBefore
            || !boardReactivationContainerAllowed(source[0], data.projects, data.sections ?? [])
            || !taskEditValuesEqual(boardMoveScope(state, source[0]), move.scope))
            return fail('STALE_REVISION', 'Board reactivation source or dependencies changed');
        const action = prepared.request.action as Extract<NativeBoardWriteRequest['action'], { type: 'moveCard' }>;
        const shown = buildBoard({ ...EMPTY_BOARD_FILTER_STATE, ...action.filters }, new Date(prepared.after.updatedAt), state);
        if (!shown.columns.some(column => column.tasks.some(row => row.id === source[0].id)))
            return fail('STALE_REVISION', 'Board reactivation source is no longer visible');
        try { return samePreparedTask(boardMoveEffect(source[0], action.status, move, prepared.after.updatedAt), prepared.after)
            ? { ok: true, value: null } : fail('STALE_REVISION', 'Board reactivation effect changed'); }
        catch { return fail('STALE_REVISION', 'Board reactivation dependencies refused'); }
    };
    const applyReactivation = (prepared: NativePreparedBoardAction, authority: PreparedAreaAuthority) =>
        useTaskStore.getState().commitPreparedTaskDraftV2({ request: { id: prepared.before.id },
            deviceIdBefore: prepared.move!.deviceIdBefore, deviceIdToInitialize: null,
            effect: { task: { before: prepared.before, after: prepared.after } } }, authority);
    const reactivationReceipts = createNativeRequestReceipts({ save: async requestId => {
        const pending = pendingReactivation;
        if (!pending || pending.prepared.request.requestId !== requestId)
            return fail('SAVE_FAILED', 'Board reactivation has no owned raw save');
        if (useTaskStore.getState().persistenceFailure) {
            if (!reactivationSaves.mayApply(pending.prepared, pending.adapter))
                return fail('SAVE_FAILED', 'Board reactivation has an unrelated persistence failure');
            const read = await readAreaDurableData(true, true); if (!read.ok) return read;
            if (read.value.adapter !== pending.adapter) return fail('STALE_REVISION', 'Board reactivation storage changed');
            const checked = checkReactivation(pending.prepared, read.value.authority); if (!checked.ok) return checked;
            const applied = await applyReactivation(pending.prepared, read.value.authority);
            if (!applied.success || applied.outcome !== 'applied') return fail('STALE_REVISION', 'Board reactivation raw retry was superseded');
            pending.boundary = read.value.authority.saveBoundary;
        }
        const saved = await reactivationSaves.finish(pending.prepared, pending.adapter, false, pending.boundary);
        if (saved.ok) pendingReactivation = null;
        return saved;
    } });
    const reactivationOutcome = async (prepared: NativePreparedBoardAction): Promise<NativeHostResult<NativeBoardActionResult | null>> => {
        const ready = deps.readiness(); if (!ready.ok) return ready;
        const adapter = boundReactivationAdapter(); const state = useTaskStore.getState(); const status = getPersistenceStatus();
        const settled = () => {
            const current = useTaskStore.getState(); const persistence = getPersistenceStatus();
            return deps.readiness().ok && getStorageAdapter() === adapter && !current.persistenceFailure
                && !persistence.queued && !persistence.inFlight && !persistence.immediate && !persistence.retrying
                && persistence.generation === status.generation && current._allTasks === state._allTasks
                && current._allProjects === state._allProjects && current._allSections === state._allSections
                && current._allAreas === state._allAreas && current._allPeople === state._allPeople
                && current.settings === state.settings && current.lastDataChangeAt === state.lastDataChangeAt;
        };


        if (!adapter || !settled())
            return fail('SAVE_FAILED', 'Board reactivation saved outcome is not available');
        try {


            const data = await adapter.getData({ rawTasks: true });
            if (!settled()) return fail('STALE_REVISION', 'Board reactivation changed during saved outcome read');
            const receipt = await adapter.readDurableReceipt(prepared.request.requestId, reactivationPayload(prepared), { committedOnly: true });
            if (!receipt.ok) return receipt;


            const baseline = await adapter.readRowBaseline();
            if (!baseline || !settled()) return fail('STALE_REVISION', 'Board reactivation durable proof changed');
            if (receipt.value === null) return { ok: true, value: null };
            if (!taskEditValuesEqual(receipt.value, prepared.result)) return fail('INVALID_INPUT', 'Board reactivation saved receipt does not match');
            const rows = data.tasks.filter(row => row.id === prepared.after.id);
            return { ok: true, value: rows.length === 1 && samePreparedTask(rows[0], prepared.after) ? prepared.result : null };
        } catch { return fail('SAVE_FAILED', 'Board reactivation saved outcome could not be read'); }
    };
    const commitReactivation = async (prepared: NativePreparedBoardAction): Promise<NativeHostResult<NativeBoardActionResult>> => {
        const adapter = boundReactivationAdapter();
        if (!adapter) return fail('SAVE_FAILED', 'Board reactivation requires guarded receipt ownership');
        const payload = reactivationPayload(prepared);
        const saved = reactivationReceipts.saved<NativeBoardActionResult>(prepared.request.requestId, payload);
        if (saved) {
            if (!saved.ok) return saved;
            const outcome = await reactivationOutcome(prepared);
            return !outcome.ok ? outcome : outcome.value === null
                ? fail('STALE_REVISION', 'Board reactivation saved row changed') : { ok: true, value: outcome.value };
        }
        let readFailure: NativeHostResult<never> | null = null;
        const result = await reactivationReceipts.run(prepared.request.requestId, payload, async () => {


            if (useTaskStore.getState().persistenceFailure) {
                readFailure = fail('SAVE_FAILED', 'Board reactivation has an unresolved persistence failure');
                return fail('ACTION_FAILED', 'Board reactivation has an unresolved persistence failure');
            }
            const read = await readAreaDurableData(false, true);
            if (!read.ok) {
                if (read.error.code === 'SAVE_FAILED') { readFailure = read; return fail('ACTION_FAILED', read.error.message); }
                return read;
            }
            if (read.value.adapter !== adapter) return fail('STALE_REVISION', 'Board reactivation storage changed');
            const checked = checkReactivation(prepared, read.value.authority); if (!checked.ok) return checked;
            const applied = await applyReactivation(prepared, read.value.authority);
            if (!applied.success || applied.outcome !== 'applied') return fail('STALE_REVISION', 'Board reactivation raw write was superseded');
            pendingReactivation = { prepared, adapter, boundary: read.value.authority.saveBoundary };
            return { ok: true, value: prepared.result };
        });
        return readFailure ?? result;
    };


    const entered = new Map<string, string>();

    return {


        getBoardView(input: { filters?: NativeBoardFilters; filterEdit?: BoardFilterEdit; limit: number }): NativeHostResult<NativeBoardView> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const read = isObjectRecord(input) && isWindow({ offset: 0, limit: input.limit }) ? readBoard(input) : null;
            if (!read) return fail('INVALID_INPUT', 'Valid filters, a filter edit and a bounded limit are required');
            const { now, board, revision } = read;
            const limit = input.limit;
            const value: NativeBoardView = {
                    version: NATIVE_HOST_CONTRACT_VERSION,
                    revision,
                    ...board.view,
                    columns: board.columns.map((column) => ({
                        status: column.status,
                        label: column.label,
                        tone: column.tone,
                        order: board.ordering.get(column.status)?.order,
                        count: column.tasks.length,
                        cards: cards(board, column.tasks.slice(0, limit), now),
                        empty: column.empty,
                    })),
            };
            if (!isNativeJsonWithinBytes(value)) for (const column of value.columns) {
                delete column.order;
                for (const card of column.cards) delete card.orderActions;
            }
            return { ok: true, value };
        },


        getBoardList(input: {
            filters?: NativeBoardFilters;
            list: NativeBoardList;
            status?: BoardStatus;
            query?: string;
            offset: number;
            limit: number;
            revision: string;
        }): NativeHostResult<{ version: typeof NATIVE_HOST_CONTRACT_VERSION; revision: string; list: NativeBoardList; total: number; items: unknown[] }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const valid = isObjectRecord(input) && typeof input.revision === 'string' && isWindow(input)
                && (input.list === 'tokens' || input.list === 'projects' || input.list === 'chips' || (input.list === 'cards' && isBoardStatus(input.status)))
                && (input.query === undefined || (isText(input.query) && (input.list === 'tokens' || input.list === 'projects')));
            const read = valid ? readBoard({ filters: input.filters }) : null;
            if (!read) return fail('INVALID_INPUT', 'The view\'s filters, a list (a column\'s status for cards), a picker query only for tokens or projects, a valid window and its revision are required');
            if (read.revision !== input.revision) return fail('STALE_REVISION', 'The Board changed; read it again');
            const { board, now } = read;
            let total: number;
            let items: unknown[];
            if (input.list === 'cards') {
                const column = board.columns.find((entry) => entry.status === input.status)!;
                total = column.tasks.length;
                items = cards(board, column.tasks.slice(input.offset, input.offset + input.limit), now);
            } else {
                const list = input.query !== undefined && (input.list === 'tokens' || input.list === 'projects')
                    ? board.search[input.list](input.query)
                    : board.lists[input.list];
                total = list.total;
                items = list.page(input.offset, input.limit);
            }
            const value = { version: NATIVE_HOST_CONTRACT_VERSION, revision: read.revision, list: input.list, total, items } as const;
            if (input.list === 'cards' && !isNativeJsonWithinBytes(value)) for (const card of items as NativeBoardCard[]) delete card.orderActions;
            return { ok: true, value };
        },


        prepareBoardAction(input: NativeBoardWriteRequest | NativeBoardOrderRequest) {
            return input?.action?.type === 'orderCard' ? orderMethods.prepare(input) : prepareBoardActionBody(input as NativeBoardWriteRequest);
        },


        validatePreparedBoardAction(input: { request: NativeBoardWriteRequest; prepared: NativePreparedBoardAction } | { request: NativeBoardOrderRequest; prepared: NativePreparedBoardOrder }): NativeHostResult<NativeBoardActionResult> {
            if (input?.request?.action?.type === 'orderCard') {
                const envelope = orderMethods.readEnvelope(input);
                return envelope ? { ok: true, value: envelope.prepared.result } : fail('INVALID_INPUT', 'Prepared Board order does not match');
            }
            const prepared = readPreparedCommand(input);
            return prepared ? { ok: true, value: prepared.result } : fail('INVALID_INPUT', 'Prepared Board request or journal does not match');
        },


        async boardMoveOutcome(input: { request: NativeBoardWriteRequest; prepared: NativePreparedBoardAction }): Promise<NativeHostResult<NativeBoardActionResult | null>> {
            const prepared = readPreparedCommand(input);
            return prepared && prepared.request.action.type === 'moveCard' && prepared.before.status === 'done'
                ? reactivationOutcome(prepared) : fail('INVALID_INPUT', 'A prepared Done Board move is required');
        },

        async boardOrderOutcome(input: { request: NativeBoardOrderRequest; prepared: NativePreparedBoardOrder }): Promise<NativeHostResult<NativeBoardActionResult | null>> {
            return orderMethods.outcome(input);
        },

        async commitPreparedBoardAction(input: { request: NativeBoardWriteRequest; prepared: NativePreparedBoardAction } | { request: NativeBoardOrderRequest; prepared: NativePreparedBoardOrder }): Promise<NativeHostResult<NativeBoardActionResult>> {
            if (input?.request?.action?.type === 'orderCard') return orderMethods.commit(input);
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const prepared = readPreparedCommand(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared Board request or journal does not match');
            const result = await (prepared.request.action.type === 'moveCard' && prepared.before.status === 'done'
                ? commitReactivation(prepared) : commitPreparedBoard(prepared, 'preparedBoard'));
            if (result.ok && prepared.request.action.type === 'duplicateTask') {
                try { logInfo('Native duplicate checklist state confirmed', { scope: 'native-host', category: 'storage', force: true,
                    context: { releaseCheck: 'v1.3.8/duplicate-checklist-state', version: prepared.version, outcome: 'confirmed' } }); }
                catch {                                                               }
            }
            return result;
        },


        prepareCalendarDelete(input: NativeCalendarDeleteRequest): NativeHostResult<NativeCalendarDeletePreparation> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readCalendarDeleteRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A Calendar task and view revision are required');
            const state = useTaskStore.getState();
            const task = state._tasksById.get(request.taskId);
            if (!task || task.deletedAt || task.purgedAt || task.status === 'reference'
                || isProjectedRecurringTaskId(request.taskId) || isStatusListTaskReadOnly(task, state._allProjects)) {
                return fail('TASK_NOT_FOUND', 'Task is not deletable');
            }
            if (taskRevisionOf(task) !== request.taskRevision) return fail('STALE_REVISION', 'Task changed since the Calendar view');
            const boardRequest: NativeBoardWriteRequest = { requestId: request.requestId, action: { type: 'trashTask', taskId: request.taskId } };
            const board = prepareBoardActionBody(boardRequest);
            if (!board.ok) return board;
            if (board.value.kind !== 'prepared') return fail('TASK_NOT_FOUND', 'Task is not deletable');
            const prepared: NativePreparedCalendarDelete = { version: 1, request, board: { request: boardRequest, prepared: board.value.prepared } };
            return readPreparedCalendarDelete({ request, prepared })
                ? { ok: true, value: { kind: 'prepared', prepared } }
                : fail('INVALID_INPUT', 'Calendar Delete could not produce a valid prepared journal');
        },


        validatePreparedCalendarDelete(input: { request: NativeCalendarDeleteRequest; prepared: NativePreparedCalendarDelete }): NativeHostResult<NativeBoardActionResult> {
            const prepared = readPreparedCalendarDelete(input);
            return prepared ? { ok: true, value: prepared.board.prepared.result }
                : fail('INVALID_INPUT', 'Prepared Calendar Delete request or journal does not match');
        },

        async commitPreparedCalendarDelete(input: { request: NativeCalendarDeleteRequest; prepared: NativePreparedCalendarDelete }): Promise<NativeHostResult<NativeBoardActionResult>> {
            const prepared = readPreparedCalendarDelete(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared Calendar Delete request or journal does not match');
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            return commitPreparedBoard(prepared.board.prepared, 'preparedCalendarDelete', true);
        },


        prepareTaskDelete(input: NativeTaskDeleteRequest): NativeHostResult<NativeTaskDeletePreparation> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readTaskDeleteRequest(input, true);
            if (!request) return fail('INVALID_INPUT', 'A Task Delete UUID, task and saved revision are required');
            const state = useTaskStore.getState();
            const task = state._tasksById.get(request.taskId);
            if (!task || task.deletedAt || task.purgedAt || isProjectedRecurringTaskId(request.taskId)
                || (request.source === 'archive' ? task.status !== 'archived'
                    : request.source === 'done' || request.source === 'reference' ? task.status !== request.source
                        || isStatusListTaskReadOnly(task, state._allProjects)
                        : isStatusListTaskReadOnly(task, state._allProjects))) return fail('TASK_NOT_FOUND', 'Task is not deletable');
            if (taskRevisionOf(task) !== request.taskRevision) return fail('STALE_REVISION', 'Task changed since the editor opened');
            const boardRequest: NativeBoardWriteRequest = { requestId: request.requestId,
                action: { type: 'trashTask', taskId: request.taskId } };
            const board = prepareBoardActionBody(boardRequest);
            if (!board.ok) return board;
            if (board.value.kind !== 'prepared') return fail('TASK_NOT_FOUND', 'Task is not deletable');
            const t = deps.t();
            const prepared: NativePreparedTaskDelete = { version: 1, request,
                board: { request: boardRequest, prepared: board.value.prepared },
                result: { id: request.taskId, deletion: {
                    message: resolveI18nText(t, 'list.taskDeleted'),
                    undoLabel: resolveI18nText(t, 'common.undo'), undoEnabled: true,
                } } };
            return readPreparedTaskDelete({ request, prepared })
                ? { ok: true, value: { kind: 'prepared', prepared } }
                : fail('INVALID_INPUT', 'Task Delete could not produce a valid prepared journal');
        },

        validatePreparedTaskDelete(input: NativeTaskDeleteEnvelope): NativeHostResult<NativeTaskDeleteResult> {
            const envelope = readPreparedTaskDelete(input);
            return envelope ? { ok: true, value: envelope.prepared.result }
                : fail('INVALID_INPUT', 'Prepared Task Delete request or journal does not match');
        },


        taskDeleteOutcome(input: NativeTaskDeleteEnvelope): NativeHostResult<NativeTaskDeleteResult | null> {
            const envelope = readPreparedTaskDelete(input);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared Task Delete request or journal does not match');
            const saved = receipts.saved<NativeTaskDeleteResult>(envelope.request.requestId,
                canonicalJSON(['preparedTaskDelete', envelope]));
            if (saved?.ok && !taskEditValuesEqual(saved.value, envelope.prepared.result))
                return fail('INVALID_INPUT', 'Saved Task Delete result does not match the prepared request');
            return saved === null ? { ok: true, value: null } : saved;
        },

        async commitPreparedTaskDelete(input: NativeTaskDeleteEnvelope): Promise<NativeHostResult<NativeTaskDeleteResult>> {
            const envelope = readPreparedTaskDelete(input);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared Task Delete request or journal does not match');
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const payload = canonicalJSON(['preparedTaskDelete', envelope]);
            const alreadySaved = receipts.saved<NativeTaskDeleteResult>(envelope.request.requestId, payload);
            const confirmed = await receipts.run(envelope.request.requestId, payload, async () => {
                const board = envelope.prepared.board.prepared;
                const applied = await useTaskStore.getState().commitPreparedBoardTask({
                    kind: 'trashTask', before: board.before, after: board.after,
                    deviceIdToInitialize: board.deviceIdToInitialize,
                    ...(envelope.request.source === 'archive' ? { strictBefore: true as const }
                        : envelope.request.source === 'done' || envelope.request.source === 'reference'
                            ? { strictBefore: true as const, respectReadOnly: true as const }
                            : { respectReadOnly: true as const }),
                });
                if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Prepared Task Delete conflicts with saved data');
                return { ok: true, value: envelope.prepared.result };
            });
            if (confirmed.ok && envelope.request.source === 'archive' && !alreadySaved?.ok) {
                try { logInfo('Native archived Task delete confirmed', { scope: 'native-host', category: 'storage',
                    context: { releaseCheck: 'v1.3.4/ios-archive-task-trash', outcome: 'confirmed' } }); }
                catch {                                                               }
            }
            if (confirmed.ok && envelope.request.source === 'done' && !alreadySaved?.ok) {
                try { logInfo('Native Done Task delete confirmed', { scope: 'native-host', category: 'storage',
                    context: { releaseCheck: 'v1.3.4/ios-done-task-trash', outcome: 'confirmed' } }); }
                catch {                                                               }
            }
            if (confirmed.ok && envelope.request.source === 'reference' && !alreadySaved?.ok) {
                try { logInfo('Native Reference Task delete confirmed', { scope: 'native-host', category: 'storage',
                    context: { releaseCheck: 'v1.3.4/ios-reference-task-trash', outcome: 'deleted' } }); }
                catch {                                                               }
            }
            return confirmed;
        },

        prepareTaskDeleteUndo(input: { request: NativeTaskDeleteUndoRequest; delete: NativeTaskDeleteEnvelope }): NativeHostResult<NativeTaskDeleteUndoPreparation> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readTaskDeleteUndoRequest(input?.request);
            const deletion = readPreparedTaskDelete(input?.delete);
            if (!request || !deletion || request.deleteRequestId !== deletion.request.requestId)
                return fail('INVALID_INPUT', 'A confirmed Delete and new Undo UUID are required');
            const state = useTaskStore.getState();
            const before = state._tasksById.get(deletion.request.taskId);
            if (!before || !taskEditValuesEqual(before, deletion.prepared.board.prepared.after)
                || !before.deletedAt || before.purgedAt) return fail('STALE_REVISION', 'Delete was superseded');
            const device = ensureDeviceId(state.settings);
            const scope = restoreScope(before, state);
            const after: Task = { ...before, deletedAt: undefined,
                ...sanitizeRestoredTaskContainerReferences(before, {
                    _allProjects: scope.projects, _allSections: scope.sections, _allAreas: scope.areas,
                }), updatedAt: new Date().toISOString(), rev: nextRevision(before.rev), revBy: device.deviceId };
            const prepared = bounded({ version: 1, request, delete: deletion, before, after, scope,
                deviceIdBefore: state.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null, result: { id: before.id } }) as NativePreparedTaskDeleteUndo | null;
            return prepared && readPreparedTaskDeleteUndo({ request, prepared })
                ? { ok: true, value: { kind: 'prepared', prepared } }
                : fail('INVALID_INPUT', 'Task Delete Undo could not produce a valid prepared journal');
        },

        validatePreparedTaskDeleteUndo(input: NativeTaskDeleteUndoEnvelope): NativeHostResult<{ id: string }> {
            const envelope = readPreparedTaskDeleteUndo(input);
            return envelope ? { ok: true, value: envelope.prepared.result }
                : fail('INVALID_INPUT', 'Prepared Task Delete Undo is malformed');
        },


        taskDeleteUndoOutcome(input: NativeTaskDeleteUndoEnvelope): NativeHostResult<{ id: string } | null> {
            const envelope = readPreparedTaskDeleteUndo(input);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared Task Delete Undo is malformed');
            const saved = receipts.saved<{ id: string }>(envelope.request.requestId,
                canonicalJSON(['preparedTaskDeleteUndo', envelope]));
            if (saved?.ok && !taskEditValuesEqual(saved.value, envelope.prepared.result))
                return fail('INVALID_INPUT', 'Saved Task Delete Undo result does not match the prepared request');
            return saved === null ? { ok: true, value: null } : saved;
        },

        async commitPreparedTaskDeleteUndo(input: NativeTaskDeleteUndoEnvelope): Promise<NativeHostResult<{ id: string }>> {
            const envelope = readPreparedTaskDeleteUndo(input);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared Task Delete Undo is malformed');
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const payload = canonicalJSON(['preparedTaskDeleteUndo', envelope]);
            const alreadySaved = receipts.saved<{ id: string }>(envelope.request.requestId, payload);
            const confirmed = await receipts.run(envelope.request.requestId, payload, async () => {
                const { before, after, deviceIdBefore, deviceIdToInitialize, result } = envelope.prepared;
                const applied = await useTaskStore.getState().commitPreparedBoardTask({
                    kind: 'restoreTask', before, after, deviceIdBefore, deviceIdToInitialize,
                    ...(envelope.prepared.delete.request.source === 'done' || envelope.prepared.delete.request.source === 'reference'
                        ? { strictBefore: true as const } : {}),
                });
                if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Prepared Task Delete Undo conflicts with saved data');
                return { ok: true, value: result };
            });
            if (confirmed.ok && envelope.prepared.delete.request.source === 'reference' && !alreadySaved?.ok) {
                try { logInfo('Native Reference Task restore confirmed', { scope: 'native-host', category: 'storage',
                    context: { releaseCheck: 'v1.3.4/ios-reference-task-trash', outcome: 'restored' } }); }
                catch {                                                               }
            }
            return confirmed;
        },


        prepareTrashTaskRestore(input: NativeTrashTaskRestoreRequest): NativeHostResult<NativeTrashTaskRestorePreparation> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readTaskDeleteRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A Restore UUID, task and saved Trash revision are required');
            const state = useTaskStore.getState();
            const source = state._tasksById.get(request.taskId);
            if (!source || !source.deletedAt || source.purgedAt || isProjectedRecurringTaskId(request.taskId))
                return fail('TASK_NOT_FOUND', 'Task is not restorable from Trash');
            if (taskRevisionOf(source) !== request.taskRevision)
                return fail('STALE_REVISION', 'Task changed since Trash was read');
            const before = bounded(source) as Task | null;
            if (!validRawTask(before, request.taskId)) return fail('INVALID_INPUT', 'Task cannot fit a valid bounded Restore journal');
            const device = ensureDeviceId(state.settings);
            const scope = restoreScope(before, state);
            const after: Task = { ...before, deletedAt: undefined,
                ...sanitizeRestoredTaskContainerReferences(before, {
                    _allProjects: scope.projects, _allSections: scope.sections, _allAreas: scope.areas,
                }), updatedAt: new Date().toISOString(), rev: nextRevision(before.rev), revBy: device.deviceId };
            const prepared = bounded({ version: 1, request, before, after, scope,
                deviceIdBefore: state.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null, result: { id: before.id } }) as NativePreparedTrashTaskRestore | null;
            return prepared && readPreparedTrashTaskRestore({ request, prepared })
                ? { ok: true, value: { kind: 'prepared', prepared } }
                : fail('INVALID_INPUT', 'Trash Restore could not produce a valid prepared journal');
        },

        validatePreparedTrashTaskRestore(input: NativeTrashTaskRestoreEnvelope): NativeHostResult<{ id: string }> {
            const envelope = readPreparedTrashTaskRestore(input);
            return envelope ? { ok: true, value: envelope.prepared.result }
                : fail('INVALID_INPUT', 'Prepared Trash Restore is malformed');
        },

        async commitPreparedTrashTaskRestore(input: NativeTrashTaskRestoreEnvelope): Promise<NativeHostResult<{ id: string }>> {
            const envelope = readPreparedTrashTaskRestore(input);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared Trash Restore is malformed');
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            return receipts.run(envelope.request.requestId, canonicalJSON(['preparedTrashTaskRestore', envelope]), async () => {
                const { before, after, deviceIdBefore, deviceIdToInitialize, result } = envelope.prepared;
                const applied = await useTaskStore.getState().commitPreparedBoardTask({
                    kind: 'restoreTask', before, after, deviceIdBefore, deviceIdToInitialize,
                });
                if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Prepared Trash Restore conflicts with saved data');
                return { ok: true, value: result };
            });
        },


        async runBoardAction(input: { requestId: string; action: NativeBoardAction }): Promise<NativeHostResult<NativeBoardActionResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !isObjectRecord(input.action) || typeof input.requestId !== 'string' || !deps.requestIdPattern.test(input.requestId)) {
                return fail('INVALID_INPUT', 'A request UUID and an action are required');
            }
            const action = input.action as NativeBoardAction;
            const requestId = input.requestId;
            const payload = JSON.stringify(['board', action]);


            const known = entered.get(requestId);
            if (known === undefined) {
                const prepared = prepare(action, requestId);
                if ('result' in prepared) return prepared.result as NativeHostResult<NativeBoardActionResult>;
                entered.set(requestId, payload);
                if (entered.size > ENTERED_LIMIT) entered.delete(entered.keys().next().value!);
            }
            const outcome = await receipts.run(requestId, payload, () => {
                const prepared = prepare(action, requestId);
                return 'result' in prepared ? Promise.resolve(prepared.result) : prepared.write();
            });

            if (!outcome.ok && outcome.error.code !== 'SAVE_FAILED' && (known === undefined || known === payload)) entered.delete(requestId);
            return outcome;
        },
    };
}
