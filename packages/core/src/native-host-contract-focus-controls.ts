/**
 * The native host contract for the Focus screen's controls: the filter sheet,
 * the saved Focus filters, View options (sort, grouping), the active chips and
 * the Today's Focus reorder screen, all from focus-controls.ts. Kept in its own
 * file and spread into createNativeHostContract; getFocus and
 * getFocusSectionWindow in native-host-contract.ts read the control state and
 * return `controls` (buildNativeFocusControls).
 *
 * Where React Native keeps each choice, and how a host keeps it the same way:
 *
 * - Filter selections, the applied saved filter and the sort: React state
 *   (useTaskFilterSelections and the screen's `focusSortBy`), nothing on disk.
 *   They last while the Focus screen is mounted and reset when it remounts. A
 *   host keeps `controls.state` in memory and sends it as `controls` with every
 *   Focus read and command, with a control's `edit` as `controlEdit` to change it.
 * - Grouping: the synced setting `settings.gtd.focusGroupBy` (setFocusGroupBy).
 * - Show details and folded sections: AsyncStorage key `mindwtr:view:focus:v1`,
 *   JSON `{"showDetails":false,"expandedSections":{"focus":true,"schedule":true,
 *   "next":true,"nextActions":true,"upcoming":true,"reviewDue":true,
 *   "reviewProjects":true}}` (`nextActions` repeats `next` for older builds).
 * - The home-screen widget: RN's setFocusWidgetFilter holds `controls.widgetFilter`
 *   ({ criteria, sortBy, sortOrder }) in memory and republishes the widget when it
 *   changes; publishing stays platform wiring.
 *
 * Every write takes a request UUID: while its save is owed a retry only saves
 * (native-request-receipts.ts). Each write is target-state, so a replay after a
 * restart writes nothing: a saved filter is created under its request UUID, a
 * deleted one is already marked deleted, a removed criterion is already gone,
 * the grouping or order is already stored. A reorder is also compare-and-set on
 * the revisions the reorder rows showed: a replay after a later change to any
 * starred task is refused (STALE_REVISION).
 *
 * Only functions read this module's imports from native-host-contract.ts, so the
 * import cycle between the two files is safe.
 */
import type { DateFormatter } from './date';
import {
    applyFocusSavedFilter,
    DEFAULT_FOCUS_CONTROL_STATE,
    getFocusGroupByLabel,
    getFocusGroupByOptions,
    FOCUS_GROUP_BY_OPTIONS,
    getFocusReorderPositionLabel,
    getFocusReorderSecondaryLabel,
    getFocusSaveFilterName,
    getFocusSortByLabel,
    getFocusSortOptions,
    moveFocusReorderTask,
    planFocusFilterCriterionRemoval,
    planFocusFilterDelete,
    planFocusFilterSave,
    planFocusGroupChange,
    type FocusControlEdit,
    type FocusControlsModel,
    type FocusControlState,
} from './focus-controls';
import { DEFAULT_FOCUS_SORT_BY } from './focus-sections';
import { tFallback } from './i18n';
import { formatTimeEstimateLabel } from './calendar-scheduling';
import type { ListFilterEdit, ListFilterState } from './list-filter-state';
import { NATIVE_HOST_CONTRACT_VERSION, NATIVE_HOST_MAX_WINDOW, type NativeHostResult } from './native-host-contract';
import { buildNativeTaskDateFilter, fail, firstWindow, isFilterEdit, isPreservedFilterCriteria, isObjectRecord, isText, matchesPickerQuery, readFilterState, type NativeWindow } from './native-host-contract-menu-views';
import {
    createNativeRequestReceipts,
    isRevisions,
    refuseStaleTasks,
    runStoreWrite,
    settleWrite,
    taskRevisionOf,
    type NativeRevisions,
    type NativeUnsavedWrite,
} from './native-request-receipts';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';

import { isSavedFilterSortField, normalizeFilterCriteria } from './saved-filters';
import { buildAdvancedFilterCriteriaChips } from './saved-filter-labels';
import { useTaskStore } from './store';
import { FOCUS_SORT_OPTIONS } from './task-list-sort-options';
import { TASK_EDITOR_ENERGY_LEVEL_OPTIONS, TASK_EDITOR_PRIORITY_OPTIONS } from './task-editor-model';
import type { FilterCriteria, FocusGroupBy, SortField, TaskEnergyLevel, TaskPriority, TimeEstimate } from './types';

type Translate = (key: string) => string;

const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
const CONTROL_KEYS = new Set(['filters', 'savedFilterId', 'sortBy', 'preservedCriteria']);

/** The control state as a host sends it; missing keys are the default's. */
export type NativeFocusControlsInput = {
    filters?: Partial<ListFilterState>;
    savedFilterId?: string | null;
    sortBy?: SortField;
    preservedCriteria?: FilterCriteria;
};

/** A host's control state, completed and checked; null when it is not one Focus can hold. */
export function readNativeFocusControls(value: unknown): FocusControlState | null {
    if (value === undefined) return DEFAULT_FOCUS_CONTROL_STATE;
    if (!isObjectRecord(value) || Object.keys(value).some((key) => !CONTROL_KEYS.has(key))) return null;
    if (value.preservedCriteria !== undefined && !isPreservedFilterCriteria(value.preservedCriteria)) return null;
    const filters = readFilterState(value.filters);
    // Focus has no search box.
    if (!filters || filters.searchQuery !== '') return null;
    if (value.savedFilterId !== undefined && value.savedFilterId !== null && !isId(value.savedFilterId)) return null;
    // Applying a saved filter can retain a sort that Focus's menu does not offer.
    // A later picker edit keeps that sort after detaching the saved filter.
    if (value.sortBy !== undefined && !isSavedFilterSortField(value.sortBy)) return null;
    return {
        filters,
        savedFilterId: (value.savedFilterId as string | null | undefined) ?? null,
        ...(value.preservedCriteria ? { preservedCriteria: value.preservedCriteria as FilterCriteria } : {}),
        sortBy: (value.sortBy as SortField | undefined) ?? DEFAULT_FOCUS_SORT_BY,
    };
}

/** A control's edit as a host sends it back; null when it is not one. */
export function readNativeFocusControlEdit(value: unknown): FocusControlEdit | null {
    if (!isObjectRecord(value)) return null;
    switch (value.type) {
        case 'filter':
            return isFilterEdit(value.edit) && value.edit.type !== 'setSearch' ? { type: 'filter', edit: value.edit } : null;
        case 'sort':
            return FOCUS_SORT_OPTIONS.includes(value.sortBy as SortField) ? { type: 'sort', sortBy: value.sortBy as SortField } : null;
        case 'removePreservedCriterion':
            return isId(value.criterionId) ? { type: 'removePreservedCriterion', criterionId: value.criterionId } : null;
        case 'applySavedFilter':
            return isId(value.id) ? { type: 'applySavedFilter', id: value.id } : null;
        default:
            return null;
    }
}

const filterEdit = (edit: ListFilterEdit): FocusControlEdit => ({ type: 'filter', edit });
const CLEAR_EDIT: FocusControlEdit = filterEdit({ type: 'clear' });

export type NativeFocusChip = { id: string; label: string; excluded: boolean; edit: FocusControlEdit };
export type NativeFocusToken = { value: string; state: 'included' | 'excluded' | 'none'; edit: FocusControlEdit };
export type NativeFocusProjectOption = { id: string; title: string; selected: boolean; edit: FocusControlEdit };
export type NativeFocusSavedFilterChip = { id: string; label: string; selected: boolean; edit: FocusControlEdit; deleteLabel: string };
type Confirm = { title: string; cancelLabel: string; confirmLabel: string };

export type NativeFocusReorderRow = {
    id: string;
    /** The task's revision: reorderFocus sends each row's as `taskRevisions`. */
    taskRevision: string;
    title: string;
    secondaryLabel: string;
    /** The row's spoken label. */
    positionLabel: string;
    /** The whole order after Move up / Move down, for reorderFocus; null at the ends. */
    moveUp: string[] | null;
    moveDown: string[] | null;
};

/**
 * The Focus screen's controls, in the current language. A control's `edit`
 * changes only the control state: send it as `controlEdit` with `controls` on
 * the next Focus read. Group options, saving, removing an advanced criterion,
 * deleting a saved filter and reordering are commands.
 */
export type NativeFocusControls = {
    /** Send back as `controls` with every Focus read and command. */
    state: FocusControlState;
    header: {
        /** Tinted while the sort or grouping is off its default (or details are shown: the host's own flag). */
        viewOptions: { label: string; active: boolean };
        /** Tinted with a count badge while filters are active. */
        filters: { label: string; active: boolean; badge: string | null };
    };
    view: {
        title: string;
        doneLabel: string;
        sort: { label: string; options: { value: SortField; label: string; selected: boolean; edit: FocusControlEdit }[] };
        /** Choose with setFocusGroupBy. */
        group: { label: string; options: { value: FocusGroupBy; label: string; selected: boolean }[] };
        details: { sectionLabel: string; showLabel: string; hideLabel: string };
    };
    /** The row above the sections; null without saved Focus filters. Delete asks first with `deleteConfirm` (message: the name). */
    savedFilters: {
        all: { label: string; selected: boolean; edit: FocusControlEdit };
        /** getFocusControlsList('savedFilters') pages the rest. */
        chips: NativeWindow<NativeFocusSavedFilterChip>;
        deleteConfirm: Confirm;
    } | null;
    /** The active filters row; shown while filters are on without a saved filter. */
    activeChips: { chips: NativeFocusChip[]; clear: { label: string; edit: FocusControlEdit } } | null;
    filterSheet: NativeFocusFilterSheet;
    /** Reorder mode for Today's Focus; null while it is not allowed (a filter, a non-default sort, or no star). */
    reorder: {
        label: string;
        title: string;
        doneLabel: string;
        hint: string;
        moveUpLabel: string;
        moveDownLabel: string;
        rows: NativeWindow<NativeFocusReorderRow>;
    } | null;
    /** The empty screen's lines, when no section has anything. */
    empty: { title: string; subtitle: string } | null;
    /** What RN hands the home-screen widget's Focus list (setFocusWidgetFilter). */
    widgetFilter: { criteria: FilterCriteria; sortBy: SortField; sortOrder: 'asc' | 'desc' | null };
};

export type NativeFocusFilterSheet = {
    title: string;
    doneLabel: string;
    /** Shown while any filter or advanced criterion is active. */
    clear: { label: string; visible: boolean; edit: FocusControlEdit };
    activeCount: number;
    hasActive: boolean;
    visibility: FocusControlsModel['options']['visibility'];
    /** getFocusControlsList('tokens' / 'projects') pages the rest. */
    tokens: NativeWindow<NativeFocusToken>;
    projects: NativeWindow<NativeFocusProjectOption>;
    priorities: { value: TaskPriority; label: string; selected: boolean; edit: FocusControlEdit }[];
    energyLevels: { value: TaskEnergyLevel; label: string; selected: boolean; edit: FocusControlEdit }[];
    timeEstimates: { value: TimeEstimate; label: string; selected: boolean; edit: FocusControlEdit }[];
    /** The location field's text; send typing as a setLocation filter edit. */
    location: string;
    taskDates: { label: string; options: { value: string; label: string; selected: boolean; edit: FocusControlEdit }[] };
    /** Any / All for two or more selected contexts (or tags). */
    matchModes: {
        context: { visible: boolean; label: string; options: { value: 'any' | 'all'; label: string; selected: boolean; edit: FocusControlEdit }[] };
        tag: { visible: boolean; label: string; options: { value: 'any' | 'all'; label: string; selected: boolean; edit: FocusControlEdit }[] };
    };
    /** The overview rows' summaries: the selections, or "All". */
    summaries: { tokens: string; projects: string; timeEstimates: string; energyLevels: string; more: string };
    chips: NativeFocusChip[];
    /** An applied saved filter's criteria no picker expresses; removeFocusFilterCriterion after `removeConfirm` (message: the label). */
    advancedChips: { id: string; criterionId: string; label: string }[];
    removeConfirm: Confirm;
    /** Save the current filter (saveFocusFilter); null when there is nothing to save. */
    save: {
        label: string;
        dialog: { title: string; placeholder: string; defaultName: string; cancelLabel: string; saveLabel: string };
    } | null;
    text: {
        contexts: string; projects: string; timeEstimate: string; energyLevel: string; more: string; priority: string;
        location: string; locationPlaceholder: string; active: string; excluded: string; removeFilter: string;
        search: string; noResults: string; selected: string; back: string; all: string;
    };
};

const joinSummary = (values: string[], fallback: string): string => (values.length > 0 ? values.join(', ') : fallback);

type ListName = 'tokens' | 'projects' | 'savedFilters';

function focusLists(model: FocusControlsModel, t: Translate): { tokens: NativeFocusToken[]; projects: NativeFocusProjectOption[]; savedFilters: NativeFocusSavedFilterChip[] } {
    const { state } = model.filter;
    const { filters } = state;
    const deleteLabel = `${tFallback(t, 'common.delete', 'Delete')} ${tFallback(t, 'savedFilters.label', 'saved filter')}`;
    return {
        tokens: model.options.tokens.map((value) => ({
            value,
            state: filters.tokens.includes(value) ? 'included' : filters.excludedTokens.includes(value) ? 'excluded' : 'none',
            edit: filterEdit({ type: 'toggleToken', value }),
        })),
        projects: model.options.projects.map((project) => ({
            ...project,
            selected: filters.projects.includes(project.id),
            edit: filterEdit({ type: 'toggleProject', value: project.id }),
        })),
        savedFilters: model.savedFilters.map((filter) => {
            const selected = state.savedFilterId === filter.id;
            return {
                id: filter.id,
                label: `${filter.icon ? `${filter.icon} ` : ''}${filter.name}`,
                selected,
                // A selected chip clears, like the All chip.
                edit: selected ? CLEAR_EDIT : { type: 'applySavedFilter', id: filter.id },
                deleteLabel: `${deleteLabel} ${filter.name}`,
            };
        }),
    };
}

/** The controls view for a model (buildFocusControlsModel). */
export function buildNativeFocusControls(model: FocusControlsModel, ctx: { t: Translate; formatDate: DateFormatter }): NativeFocusControls {
    const { t } = ctx;
    const tf = (key: string, fallback: string) => tFallback(t, key, fallback);
    const { filter, perspective, lists } = model;
    const { state } = filter;
    const { filters } = state;
    const all = tf('common.all', 'All');
    const excluded = tf('filters.excluded', 'Excluded');
    const preserved = !filter.activeSavedFilter ? state.preservedCriteria : undefined;
    const preservedBasic = [
        { field: 'priority' as const, prefix: 'priority:', label: tf('filters.priority', 'Priority'),
            values: preserved?.priority?.map((value) => value === 'none' ? tf('focus.group.noPriority', 'No priority') : t(`priority.${value}`)) },
        { field: 'energy' as const, prefix: 'energy:', label: tf('taskEdit.energyLevel', 'Energy level'),
            values: preserved?.energy?.map((value) => t(`energyLevel.${value}`)) },
        { field: 'timeEstimates' as const, prefix: 'time:', label: tf('filters.timeEstimate', 'Time estimate'),
            values: preserved?.timeEstimates?.map((value) => formatTimeEstimateLabel(value, { t })) },
        { field: 'projects' as const, prefix: 'project:', label: tf('filters.projects', 'Projects'),
            values: preserved?.projects?.map((id) => model.projectById.get(id)?.title ?? id) },
    ].filter((part) => part.values?.length);
    const chips: NativeFocusChip[] = [
        ...filter.chips.filter((chip) => !(chip.id === 'location' && preserved?.locations)
            && !preservedBasic.some((part) => chip.id.startsWith(part.prefix)))
            .map((chip) => ({ id: chip.id, label: chip.label, excluded: chip.excluded, edit: filterEdit(chip.edit) })),
        ...preservedBasic.map((part) => ({ id: `preserved:${part.field}`, label: `${part.label}: ${part.values!.join(', ')}`, excluded: false,
            edit: { type: 'removePreservedCriterion' as const, criterionId: part.field } })),
        ...(!filter.activeSavedFilter ? buildAdvancedFilterCriteriaChips(normalizeFilterCriteria(state.preservedCriteria), { resolveText: tf }).map((chip) => ({
            id: `preserved:${chip.id}`, label: chip.label, excluded: false,
            edit: { type: 'removePreservedCriterion' as const, criterionId: chip.id },
        })) : []),
    ];
    const lists_ = focusLists(model, t);
    const activeChipLabels = [...chips.map((chip) => chip.label), ...model.advancedChips.map((chip) => chip.label)];
    const matchMode = (kind: 'context' | 'tag', visible: boolean, label: string, value: 'any' | 'all') => ({
        visible,
        label,
        options: (['any', 'all'] as const).map((option) => ({
            value: option,
            label: option === 'any' ? tf('filters.matchAny', 'Any') : all,
            selected: value === option,
            edit: filterEdit({ type: 'setMatchMode', kind, value: option }),
        })),
    });
    const confirm = (title: string): Confirm => ({ title, cancelLabel: tf('common.cancel', 'Cancel'), confirmLabel: tf('common.delete', 'Delete') });
    const focused = lists.focusedTasks;
    const taskDates = buildNativeTaskDateFilter(filters, t);
    return {
        state,
        header: {
            viewOptions: {
                label: tf('common.viewOptions', 'View options'),
                active: perspective.effectiveGroupBy !== 'none' || perspective.effectiveSortBy !== DEFAULT_FOCUS_SORT_BY,
            },
            filters: { label: tf('filters.label', 'Filters'), active: filter.hasActive, badge: filter.hasActive ? String(filter.activeCount) : null },
        },
        view: {
            title: tf('common.viewOptions', 'View options'),
            doneLabel: tf('common.done', 'Done'),
            sort: {
                label: tf('sort.label', 'Sort'),
                options: getFocusSortOptions(model.prioritiesEnabled).map((value) => ({
                    value, label: getFocusSortByLabel(value, t), selected: perspective.effectiveSortBy === value, edit: { type: 'sort', sortBy: value },
                })),
            },
            group: {
                label: tf('focus.groupBy', 'Group next actions by'),
                options: getFocusGroupByOptions(model.prioritiesEnabled).map((value) => ({
                    value, label: getFocusGroupByLabel(value, t), selected: perspective.effectiveGroupBy === value,
                })),
            },
            details: {
                sectionLabel: tf('common.viewOptions', 'View options'),
                showLabel: tf('list.showDetails', 'Show details'),
                hideLabel: tf('list.hideDetails', 'Hide details'),
            },
        },
        savedFilters: model.savedFilters.length > 0 ? {
            all: { label: all, selected: perspective.isDefaultPerspective, edit: CLEAR_EDIT },
            chips: firstWindow(lists_.savedFilters),
            deleteConfirm: confirm(tf('savedFilters.deleteTitle', 'Delete saved filter?')),
        } : null,
        activeChips: filter.hasActive && !filter.activeSavedFilter ? {
            // No advanced chips here: they exist only while a saved filter is applied.
            chips,
            clear: { label: tf('filters.clear', 'Clear'), edit: CLEAR_EDIT },
        } : null,
        filterSheet: {
            title: tf('filters.label', 'Filters'),
            doneLabel: tf('common.done', 'Done'),
            clear: { label: tf('filters.clear', 'Clear'), visible: filter.hasActive || model.advancedChips.length > 0, edit: CLEAR_EDIT },
            activeCount: filter.activeCount,
            hasActive: filter.hasActive,
            visibility: model.options.visibility,
            tokens: firstWindow(lists_.tokens),
            projects: firstWindow(lists_.projects),
            priorities: TASK_EDITOR_PRIORITY_OPTIONS.map((value) => ({
                value, label: t(`priority.${value}`), selected: filters.priorities.includes(value), edit: filterEdit({ type: 'togglePriority', value }),
            })),
            energyLevels: TASK_EDITOR_ENERGY_LEVEL_OPTIONS.map((value) => ({
                value, label: t(`energyLevel.${value}`), selected: filters.energyLevels.includes(value), edit: filterEdit({ type: 'toggleEnergyLevel', value }),
            })),
            timeEstimates: model.options.timeEstimates.map((value) => ({
                value, label: formatTimeEstimateLabel(value), selected: filters.timeEstimates.includes(value), edit: filterEdit({ type: 'toggleTimeEstimate', value }),
            })),
            location: filters.location,
            taskDates: { ...taskDates, options: taskDates.options.map((option) => ({ ...option, edit: filterEdit(option.edit) })) },
            matchModes: {
                context: matchMode('context', filter.showContextMatchMode, tf('filters.contextMatchMode', 'Context match'), filters.contextMatchMode),
                tag: matchMode('tag', filter.showTagMatchMode, tf('filters.tagMatchMode', 'Tag match'), filters.tagMatchMode),
            },
            summaries: {
                tokens: joinSummary([...filters.tokens, ...filters.excludedTokens.map((token) => `${excluded}: ${token}`)], all),
                projects: joinSummary(model.options.projects.filter((project) => filters.projects.includes(project.id)).map((project) => project.title), all),
                timeEstimates: joinSummary(filters.timeEstimates.map((estimate) => formatTimeEstimateLabel(estimate)), all),
                energyLevels: joinSummary(filters.energyLevels.map((level) => t(`energyLevel.${level}`)), all),
                more: joinSummary([
                    ...filters.priorities.map((priority) => t(`priority.${priority}`)),
                    ...(filters.location.trim() ? [`${tf('taskEdit.locationLabel', 'Location')}: ${filters.location.trim()}`] : []),
                ], all),
            },
            chips,
            advancedChips: model.advancedChips,
            removeConfirm: confirm(tf('common.delete', 'Delete')),
            save: perspective.canSavePerspective ? {
                label: tf('savedFilters.save', 'Save'),
                dialog: {
                    title: tf('savedFilters.saveTitle', 'Save filter'),
                    placeholder: tf('savedFilters.namePlaceholder', 'Filter name'),
                    defaultName: getFocusSaveFilterName(activeChipLabels, tf('savedFilters.defaultName', 'Focus filter')),
                    cancelLabel: tf('common.cancel', 'Cancel'),
                    saveLabel: tf('common.save', 'Save'),
                },
            } : null,
            text: {
                contexts: tf('filters.contexts', 'Contexts & tags'),
                projects: tf('filters.projects', 'Projects'),
                timeEstimate: tf('filters.timeEstimate', 'Time estimate'),
                energyLevel: tf('taskEdit.energyLevel', 'Energy level'),
                more: tf('filters.more', 'More filters'),
                priority: tf('filters.priority', 'Priority'),
                location: tf('taskEdit.locationLabel', 'Location'),
                locationPlaceholder: tf('taskEdit.locationPlaceholder', 'e.g. Office'),
                active: tf('filters.active', 'Active filters'),
                excluded,
                removeFilter: tf('filters.remove', 'Remove filter'),
                search: tf('common.search', 'Search'),
                noResults: tf('search.noResults', 'No results'),
                selected: tf('bulk.selected', 'Selected'),
                back: tf('common.back', 'Back'),
                all,
            },
        },
        reorder: model.canReorder ? {
            label: tf('projects.reorderTasks', 'Reorder'),
            title: t('agenda.todaysFocus') ?? "Today's Focus",
            doneLabel: tf('common.done', 'Done'),
            hint: tf('focus.reorderHint', 'Long press and drag to reorder'),
            moveUpLabel: tf('projects.moveUp', 'Move up'),
            moveDownLabel: tf('projects.moveDown', 'Move down'),
            rows: firstWindow(focused.map((task, index) => ({
                id: task.id,
                taskRevision: taskRevisionOf(task),
                title: task.title,
                secondaryLabel: getFocusReorderSecondaryLabel(task, model.projectById, ctx.formatDate),
                positionLabel: getFocusReorderPositionLabel(t, task.title, index, focused.length),
                moveUp: moveFocusReorderTask(focused, task.id, -1)?.map(({ id }) => id) ?? null,
                moveDown: moveFocusReorderTask(focused, task.id, 1)?.map(({ id }) => id) ?? null,
            }))),
        } : null,
        empty: model.empty,
        widgetFilter: { criteria: filter.criteria, sortBy: perspective.effectiveSortBy, sortOrder: filter.activeSavedFilter?.sortOrder ?? null },
    };
}

export type FocusControlDeps = {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    t: () => Translate;
    /**
     * The Focus model for a control state (null: a read without `controls`, which keeps
     * the flat pre-controls Focus), cached per revision, and the revision it answers under.
     */
    focusModel: (state: FocusControlState | null, now: Date) => { model: FocusControlsModel; revision: string };
    requestIdPattern: RegExp;
};

/** A Focus control command's answer: the control state to keep, and whether the store changed. */
export type NativeFocusCommandResult = { controls: FocusControlState; changed: boolean };

export type NativeFocusGroupExpected = { groupBy: string | null; updatedAt: string | null };
export type NativeFocusGroupWriteRequest = {
    requestId: string;
    controls: NativeFocusControlsInput;
    groupBy: FocusGroupBy;
    expected: NativeFocusGroupExpected;
};
export type NativeFocusGroupResult = { groupBy: FocusGroupBy; controls: FocusControlState };

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]) => (
    Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
);
const rawGroup = (): NativeHostResult<string | null> => {
    const gtd = useTaskStore.getState().settings.gtd;
    if (!gtd || !Object.prototype.hasOwnProperty.call(gtd, 'focusGroupBy')) return { ok: true, value: null };
    return typeof gtd.focusGroupBy === 'string'
        ? { ok: true, value: gtd.focusGroupBy }
        : fail('INVALID_INPUT', 'Stored Focus grouping has an unsupported value');
};
const rawGtdStamp = (): NativeHostResult<string | null> => {
    const stamps = useTaskStore.getState().settings.syncPreferencesUpdatedAt;
    if (!stamps || !Object.prototype.hasOwnProperty.call(stamps, 'gtd')) return { ok: true, value: null };
    return typeof stamps.gtd === 'string'
        ? { ok: true, value: stamps.gtd }
        : fail('INVALID_INPUT', 'Stored GTD timestamp has an unsupported value');
};

export function createFocusControlMethods(deps: FocusControlDeps) {
    const durableSave = async (): Promise<NativeHostResult<null>> => {
        try {
            if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
        } catch (error) {
            return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error));
        }
        return deps.save();
    };
    const receipts = createNativeRequestReceipts({ save: durableSave });

    /** Checks readiness, the request UUID and the control state, then runs the write once per request. */
    const command = async (
        input: unknown,
        payload: (input: Record<string, unknown>) => unknown[] | null,
        write: (input: Record<string, unknown>, state: FocusControlState, model: FocusControlsModel) => Promise<
            NativeHostResult<NativeFocusCommandResult> | NativeUnsavedWrite<NativeFocusCommandResult>
        >,
    ): Promise<NativeHostResult<NativeFocusCommandResult>> => {
        const ready = deps.readiness();
        if (!ready.ok) return ready;
        const state = isObjectRecord(input) ? readNativeFocusControls(input.controls) : null;
        const parts = isObjectRecord(input) && state ? payload(input) : null;
        if (!isObjectRecord(input) || !state || !parts || typeof input.requestId !== 'string' || !deps.requestIdPattern.test(input.requestId)) {
            return fail('INVALID_INPUT', 'A request UUID, the Focus controls and this command\'s input are required');
        }
        return receipts.run(input.requestId, JSON.stringify([...parts, state]), () => {
            const { model } = deps.focusModel(state, new Date());
            return write(input, model.filter.state, model);
        });
    };
    const unchanged = (controls: FocusControlState): NativeHostResult<NativeFocusCommandResult> => ({ ok: true, value: { controls, changed: false } });

    return {
        getFocusGroupOptions(input: { controls: NativeFocusControlsInput }): NativeHostResult<{
            revision: string;
            controls: FocusControlState;
            expected: NativeFocusGroupExpected;
            choices: { value: FocusGroupBy; label: string; selected: boolean }[];
        }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const controls = isObjectRecord(input) && isObjectRecord(input.controls) ? readNativeFocusControls(input.controls) : null;
            if (!controls || !isObjectRecord(input) || !hasExactKeys(input, ['controls'])) {
                return fail('INVALID_INPUT', 'Focus controls are required');
            }
            const groupBy = rawGroup();
            if (!groupBy.ok) return groupBy;
            const updatedAt = rawGtdStamp();
            if (!updatedAt.ok) return updatedAt;
            const { model, revision } = deps.focusModel(controls, new Date());
            const t = deps.t();
            return { ok: true, value: {
                revision, controls: model.filter.state,
                expected: { groupBy: groupBy.value, updatedAt: updatedAt.value },
                choices: getFocusGroupByOptions(model.prioritiesEnabled).map((value) => ({
                    value, label: getFocusGroupByLabel(value, t), selected: model.perspective.effectiveGroupBy === value,
                })),
            } };
        },

        /** Static validation for a journaled request, safe before the store opens. */
        validateFocusGroupWrite(input: unknown): NativeHostResult<NativeFocusGroupResult> {
            if (!isObjectRecord(input) || !hasExactKeys(input, ['requestId', 'controls', 'groupBy', 'expected'])
                || typeof input.requestId !== 'string' || !deps.requestIdPattern.test(input.requestId)
                || !isObjectRecord(input.controls) || !isObjectRecord(input.expected)
                || !hasExactKeys(input.expected, ['groupBy', 'updatedAt'])
                || !FOCUS_GROUP_BY_OPTIONS.includes(input.groupBy as FocusGroupBy)
                || (input.expected.groupBy !== null && !isText(input.expected.groupBy, 500))
                || (input.expected.updatedAt !== null && !isText(input.expected.updatedAt, 500))) {
                return fail('INVALID_INPUT', 'A checked Focus grouping request is required');
            }
            const controls = readNativeFocusControls(input.controls);
            if (!controls) return fail('INVALID_INPUT', 'Valid Focus controls are required');
            if (!isNativeJsonWithinBytes(input, 32_768)) return fail('INVALID_INPUT', 'Focus grouping request is too large');
            return { ok: true, value: { groupBy: input.groupBy as FocusGroupBy, controls: { ...controls, savedFilterId: null } } };
        },

        /** Read-only answer after the native journal confirms the SQLite save completed. */
        probeFocusGroupOutcome(input: NativeFocusGroupWriteRequest): NativeHostResult<NativeFocusGroupResult> {
            const checked = this.validateFocusGroupWrite(input);
            if (!checked.ok) return checked;
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const current = rawGroup();
            if (!current.ok) return current;
            if (current.value === checked.value.groupBy) return checked;
            const stamp = rawGtdStamp();
            if (!stamp.ok) return stamp;
            if (current.value !== input.expected.groupBy || stamp.value !== input.expected.updatedAt) {
                return fail('STALE_REVISION', 'Focus grouping changed while editing');
            }
            const { model } = deps.focusModel(readNativeFocusControls(input.controls)!, new Date());
            const plan = planFocusGroupChange(checked.value.groupBy, {
                effectiveGroupBy: model.perspective.effectiveGroupBy,
                hasActiveSavedFilter: model.filter.activeSavedFilter !== null,
                settings: useTaskStore.getState().settings,
            });
            return !plan && getFocusGroupByOptions(model.prioritiesEnabled).includes(checked.value.groupBy)
                ? checked : fail('STALE_REVISION', 'Focus grouping outcome is not present');
        },

        async setFocusGroupChecked(input: NativeFocusGroupWriteRequest): Promise<NativeHostResult<NativeFocusGroupResult>> {
            const checked = this.validateFocusGroupWrite(input);
            if (!checked.ok) return checked;
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const { groupBy } = checked.value;
            const expected = input.expected;
            const originalControls = readNativeFocusControls(input.controls)!;
            return receipts.run(input.requestId, JSON.stringify(['checkedGroup', input]), async () => {
                const current = rawGroup();
                if (!current.ok) return current;
                // A journaled lost acknowledgment must not rewrite newer GTD preferences.
                if (current.value === groupBy) return { ok: true, value: checked.value };
                const stamp = rawGtdStamp();
                if (!stamp.ok) return stamp;
                if (current.value !== expected.groupBy || stamp.value !== expected.updatedAt) {
                    return fail('STALE_REVISION', 'Focus grouping changed while editing');
                }
                const { model } = deps.focusModel(originalControls, new Date());
                const plan = planFocusGroupChange(groupBy, {
                    effectiveGroupBy: model.perspective.effectiveGroupBy,
                    hasActiveSavedFilter: model.filter.activeSavedFilter !== null,
                    settings: useTaskStore.getState().settings,
                });
                if (!getFocusGroupByOptions(model.prioritiesEnabled).includes(groupBy)) {
                    return fail('INVALID_INPUT', 'That grouping is not offered');
                }
                if (!plan) return { ok: true, value: checked.value };
                const written = await runStoreWrite(() => useTaskStore.getState().updateSettings(plan.settingsUpdate));
                return settleWrite(written, checked.value);
            });
        },

        /**
         * A View options Group by chip: detaches an applied saved filter and stores the
         * synced `settings.gtd.focusGroupBy`. Only an offered grouping is accepted.
         */
        setFocusGroupBy(input: { requestId: string; controls?: NativeFocusControlsInput; groupBy: FocusGroupBy }) {
            return command(
                input,
                (value) => (typeof value.groupBy === 'string' ? ['group', value.groupBy] : null),
                async (value, state, model) => {
                    const groupBy = value.groupBy as FocusGroupBy;
                    if (!getFocusGroupByOptions(model.prioritiesEnabled).includes(groupBy)) return fail('INVALID_INPUT', 'That grouping is not offered');
                    const settings = useTaskStore.getState().settings;
                    const plan = planFocusGroupChange(groupBy, {
                        effectiveGroupBy: model.perspective.effectiveGroupBy,
                        hasActiveSavedFilter: model.filter.activeSavedFilter !== null,
                        settings,
                    });
                    if (!plan) return unchanged(state);
                    const controls = { ...state, savedFilterId: null };
                    // Target state: a stored grouping is not written again.
                    if (settings.gtd?.focusGroupBy === groupBy) return unchanged(controls);
                    const written = await runStoreWrite(() => useTaskStore.getState().updateSettings(plan.settingsUpdate));
                    return settleWrite(written, { controls, changed: true });
                },
            );
        },

        /**
         * Save the current filter, sort and grouping as a saved Focus filter named `name`
         * (trimmed), then apply it. The request UUID becomes the saved filter's ID.
         */
        saveFocusFilter(input: { requestId: string; controls?: NativeFocusControlsInput; name: string }) {
            return command(
                input,
                (value) => (typeof value.name === 'string' && value.name.length <= 500 && value.name.trim() ? ['save', value.name] : null),
                async (value, state, model) => {
                    const id = (value.requestId as string).toLowerCase();
                    const settings = useTaskStore.getState().settings;
                    const existing = settings.savedFilters?.find((filter) => filter.id === id);
                    if (existing) {
                        // A replay after a restart: the filter it created answers it.
                        if (existing.name !== (value.name as string).trim() || existing.deletedAt) return fail('INVALID_INPUT', 'Request ID already belongs to another saved filter');
                        return unchanged(applyFocusSavedFilter(state, existing));
                    }
                    const plan = planFocusFilterSave({
                        name: value.name as string,
                        canSave: model.perspective.canSavePerspective,
                        currentCriteria: model.filter.currentCriteria,
                        effectiveSortBy: model.perspective.effectiveSortBy,
                        effectiveGroupBy: model.perspective.effectiveGroupBy,
                        savedFilters: settings.savedFilters,
                        id,
                        nowIso: new Date().toISOString(),
                    });
                    if (!plan) return fail('INVALID_INPUT', 'There is nothing to save');
                    const written = await runStoreWrite(() => useTaskStore.getState().updateSettings({ savedFilters: plan.savedFilters }));
                    return settleWrite(written, { controls: applyFocusSavedFilter(state, plan.filter), changed: true });
                },
            );
        },

        /** Remove one advanced criterion (a chip's `criterionId`) from the applied saved filter. */
        removeFocusFilterCriterion(input: { requestId: string; controls?: NativeFocusControlsInput; criterionId: string }) {
            return command(
                input,
                (value) => (isId(value.criterionId) ? ['removeCriterion', value.criterionId] : null),
                async (value, state, model) => {
                    if (!model.filter.activeSavedFilter) return fail('INVALID_INPUT', 'No saved filter is applied');
                    // Target state: a criterion the filter no longer shows is already removed.
                    if (!model.advancedChips.some((chip) => chip.criterionId === value.criterionId)) return unchanged(state);
                    const plan = planFocusFilterCriterionRemoval({
                        activeSavedFilter: model.filter.activeSavedFilter,
                        criterionId: value.criterionId as string,
                        savedFilters: useTaskStore.getState().settings.savedFilters,
                        nowIso: new Date().toISOString(),
                    });
                    if (!plan) return unchanged(state);
                    const written = await runStoreWrite(() => useTaskStore.getState().updateSettings({ savedFilters: plan.savedFilters }));
                    return settleWrite(written, { controls: state, changed: true });
                },
            );
        },

        /** Delete a saved Focus filter (marked deleted: saved filters sync). An applied one is detached. */
        deleteFocusFilter(input: { requestId: string; controls?: NativeFocusControlsInput; id: string }) {
            return command(
                input,
                (value) => (isId(value.id) ? ['delete', value.id] : null),
                async (value, state, model) => {
                    const id = value.id as string;
                    const controls = state.savedFilterId === id ? { ...state, savedFilterId: null } : state;
                    // Target state: a filter Focus no longer offers is already deleted.
                    if (!model.savedFilters.some((filter) => filter.id === id)) return unchanged(controls);
                    const plan = planFocusFilterDelete(useTaskStore.getState().settings.savedFilters, id);
                    const written = await runStoreWrite(() => useTaskStore.getState().updateSettings({ savedFilters: plan.savedFilters }));
                    return settleWrite(written, { controls, changed: true });
                },
            );
        },

        /**
         * Put Today's Focus in this order: every starred task Focus shows, once. Allowed
         * only while `controls.reorder` is (default sort, no filter), so hidden stars are
         * never renumbered. Writes only the tasks whose position changes. `taskRevisions`
         * holds each row's `taskRevision`: a task changed since refuses the order (STALE_REVISION).
         */
        reorderFocus(input: { requestId: string; controls?: NativeFocusControlsInput; ids: string[]; taskRevisions: NativeRevisions }) {
            return command(
                input,
                (value) => (Array.isArray(value.ids) && value.ids.length <= NATIVE_HOST_MAX_WINDOW && value.ids.every(isId)
                    && isRevisions(value.taskRevisions, value.ids) ? ['reorder', value.ids, value.taskRevisions] : null),
                async (value, state, model) => {
                    const ids = value.ids as string[];
                    const focused = model.lists.focusedTasks;
                    if (!model.canReorder) return fail('INVALID_INPUT', 'Reorder needs the default sort and no filter');
                    if (ids.length !== focused.length || new Set(ids).size !== ids.length || !focused.every((task) => ids.includes(task.id))) {
                        return fail('INVALID_INPUT', 'Every starred task Focus shows, once, is required');
                    }
                    const byId = new Map(focused.map((task) => [task.id, task]));
                    // Target state: the same order again writes nothing.
                    if (ids.every((id, index) => byId.get(id)!.focusOrder === index)) return unchanged(state);
                    const stale = refuseStaleTasks(ids, value.taskRevisions as NativeRevisions);
                    if (stale) return stale;
                    const written = await runStoreWrite(() => useTaskStore.getState().reorderFocusedTasks(ids));
                    return settleWrite(written, { controls: state, changed: true });
                },
            );
        },

        /**
         * A later window of the filter sheet's tokens or projects, or of the saved filter chips, under a Focus revision.
         * `query` is the tokens or projects picker's search text: the ones matching it, from offset zero (the Inbox tokens' rule).
         */
        getFocusControlsList(input: { controls?: NativeFocusControlsInput; list: ListName; offset: number; limit: number; revision: string; query?: string }): NativeHostResult<{
            version: typeof NATIVE_HOST_CONTRACT_VERSION;
            revision: string;
            list: ListName;
            total: number;
            items: (NativeFocusToken | NativeFocusProjectOption | NativeFocusSavedFilterChip)[];
        }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const state = isObjectRecord(input) ? readNativeFocusControls(input.controls) : null;
            if (!isObjectRecord(input) || !state || (input.list !== 'tokens' && input.list !== 'projects' && input.list !== 'savedFilters')
                || !Number.isSafeInteger(input.offset) || input.offset < 0
                || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > NATIVE_HOST_MAX_WINDOW
                || typeof input.revision !== 'string'
                || (input.query !== undefined && (!isText(input.query, 2000) || input.list === 'savedFilters'))) {
                return fail('INVALID_INPUT', 'The Focus controls, a list, a valid window, the Focus revision and a picker query only for tokens or projects are required');
            }
            const { model, revision } = deps.focusModel(input.controls === undefined ? null : state, new Date());
            if (revision !== input.revision) return fail('STALE_REVISION', 'Focus changed; read it again');
            const all = focusLists(model, deps.t())[input.list as ListName];
            const query = input.query;
            const items = query === undefined ? all : all.filter((item) => matchesPickerQuery(
                input.list === 'tokens' ? (item as NativeFocusToken).value : (item as NativeFocusProjectOption).title,
                query,
            ));
            return {
                ok: true,
                value: {
                    version: NATIVE_HOST_CONTRACT_VERSION,
                    revision,
                    list: input.list,
                    total: items.length,
                    items: items.slice(input.offset, input.offset + input.limit),
                },
            };
        },
    };
}
