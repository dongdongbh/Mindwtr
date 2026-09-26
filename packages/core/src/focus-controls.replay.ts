/**
 * Test support only (imported by the Focus controls tests; not exported).
 * Replays the frozen React Native Focus controls scenarios
 * (focus-controls-parity.fixtures.json, captured by
 * apps/mobile/lib/focus-controls-parity.test.tsx) through core: either core's
 * functions directly, or the native host contract. Both produce the screen as
 * the mobile harness observed it.
 */
import { readFileSync } from 'node:fs';
import { splitTodayTasksByStartTime } from './task-utils';
import {
    applyFocusControlEdit,
    applyFocusSavedFilter,
    buildFocusControlsModel,
    buildFocusNextItems,
    buildFocusScheduleItems,
    DEFAULT_FOCUS_CONTROL_STATE,
    getFocusGroupByLabel,
    getFocusGroupByOptions,
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
    reconcileFocusReorderOrder,
    type FocusControlEdit,
    type FocusControlsModel,
    type FocusControlState,
    type FocusListItem,
} from './focus-controls';
import { buildFocusTaskSections, DEFAULT_FOCUS_SORT_BY } from './focus-sections';
import { formatTimeEstimateLabel } from './calendar-scheduling';
import { safeFormatDate } from './date';
import { tFallback } from './i18n';
import type { ListFilterEdit } from './list-filter-state';
import type { createNativeHostContract, NativeFocusView } from './native-host-contract';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { generateUUID } from './uuid';
import type { AppSettings, Area, FocusGroupBy, Project, SortField, Task } from './types';

export type FocusControlsAction = [string, ...unknown[]];
export type FocusControlsScenario = { name: string; settings: string; taskIds?: string[]; actions: FocusControlsAction[] };
export type FocusControlsFixture = {
    timeZone: string;
    now: string;
    tasks: Task[];
    projects: Project[];
    areas: Area[];
    settings: Record<string, AppSettings>;
    scenarios: FocusControlsScenario[];
    observations: Record<string, unknown[]>;
};

export const loadFocusControlsFixture = (): FocusControlsFixture => JSON.parse(
    readFileSync(new URL('./focus-controls-parity.fixtures.json', import.meta.url), 'utf8'),
);

type Translate = (key: string) => string;

// ---------------------------------------------------------------------------
// Store seeding and write recording, as the mobile harness did.

const writeLog: unknown[] = [];
/** The store writes since the last seed, as the mobile harness records them. */
export const focusControlsWrites = (): unknown[] => writeLog;
let knownIds = new Set<string>();
const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, entry) => (
    entry === undefined ? '<undefined>' : entry
)).replace(/"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/g, (match, id) => (
    knownIds.has(id) ? match : '"<new>"'
)));

let realActions: Pick<ReturnType<typeof useTaskStore.getState>, 'updateSettings' | 'reorderFocusedTasks'> | null = null;

export async function seedFocusControlsStore(
    fixture: FocusControlsFixture,
    scenario: FocusControlsScenario,
    adapter: { saveData?: (data: unknown) => Promise<void> } = {},
): Promise<void> {
    writeLog.length = 0;
    await flushPendingSave();
    resetForTests();
    const initial = useTaskStore.getState();
    realActions ??= { updateSettings: initial.updateSettings, reorderFocusedTasks: initial.reorderFocusedTasks };
    const real = realActions;
    const settings = fixture.settings[scenario.settings];
    knownIds = new Set((settings.savedFilters ?? []).map((filter) => filter.id));
    const tasks = scenario.taskIds ? fixture.tasks.filter((task) => scenario.taskIds!.includes(task.id)) : fixture.tasks;
    let data = JSON.parse(JSON.stringify({ tasks, projects: fixture.projects, sections: [], areas: fixture.areas, people: [], settings }));
    setStorageAdapter({
        getData: async () => data,
        saveData: async (next) => {
            await adapter.saveData?.(next);
            data = JSON.parse(JSON.stringify(next));
        },
    });
    useTaskStore.setState({
        ...real,
        _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
    });
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    if (useTaskStore.getState()._allTasks.length !== tasks.length) throw new Error('Store seed did not load');
    useTaskStore.setState({
        updateSettings: async (updates) => {
            writeLog.push(['updateSettings', normalize(updates)]);
            return real.updateSettings(updates);
        },
        reorderFocusedTasks: async (ids) => {
            writeLog.push(['reorderFocusedTasks', [...ids]]);
            return real.reorderFocusedTasks(ids);
        },
    });
}

// ---------------------------------------------------------------------------
// The observation the mobile harness recorded, from its parts.

const encodeItem = (item: FocusListItem | { type: 'project'; id: string }): string => {
    if (item.type === 'task') return `${item.task.id}${item.grouped ? '~' : ''}`;
    if (item.type === 'project') return `@${item.id}`;
    return `#${item.id}|${item.title}|${item.count}|${item.muted ? 1 : 0}|${item.dotColor ?? ''}`;
};

type Screen = {
    sections: { type: string; title: string; total: number; items: string[] }[] | null;
    empty: { title: string; subtitle: string } | null;
    reorderMode: boolean;
    header: { viewOptionsTinted: boolean; filterTinted: boolean; filterBadge: string | null };
    savedRow: unknown;
    activeRow: unknown;
    sheet: unknown;
    view: unknown;
    reorderToggle: string | null;
    reorderRows: unknown[] | null;
    saveName: string | null;
    widget: { criteria: unknown; sortBy: SortField; sortOrder: string | null };
};

function observation(screen: Screen) {
    const list = !screen.reorderMode;
    // The save dialog replaces the sheet's body: no overview rows, no Clear.
    const sheet = screen.saveName === null ? screen.sheet : { ...(screen.sheet as object), rows: [], clear: false };
    return normalize({
        sections: list ? screen.sections ?? [] : null,
        empty: list ? screen.empty : null,
        header: list ? screen.header : null,
        savedRow: list ? screen.savedRow : null,
        activeRow: list ? screen.activeRow : null,
        sheet,
        view: screen.view,
        reorder: { toggle: list ? screen.reorderToggle : null, rows: screen.reorderRows },
        saveName: screen.saveName,
        widget: screen.widget,
        focusOrder: Object.fromEntries(useTaskStore.getState().tasks
            .filter((task) => task.isFocusedToday)
            .map((task) => [task.id, task.focusOrder ?? null])),
        writes: [...writeLog],
    });
}

/** RN's setFocusWidgetFilter keeps the previous value while the new one has the same JSON. */
function createWidgetMirror() {
    let current: Screen['widget'] = { criteria: {}, sortBy: DEFAULT_FOCUS_SORT_BY, sortOrder: null };
    return (next: Screen['widget']) => {
        if (JSON.stringify([next.criteria, next.sortBy, next.sortOrder]) !== JSON.stringify([current.criteria, current.sortBy, current.sortOrder])) current = next;
        return current;
    };
}

const FILTER_METHOD_EDITS: Record<string, (...args: unknown[]) => ListFilterEdit> = {
    toggleToken: (value) => ({ type: 'toggleToken', value: value as string }),
    removeToken: (value) => ({ type: 'removeToken', value: value as string }),
    toggleProject: (value) => ({ type: 'toggleProject', value: value as string }),
    togglePriority: (value) => ({ type: 'togglePriority', value: value as never }),
    toggleEnergyLevel: (value) => ({ type: 'toggleEnergyLevel', value: value as never }),
    toggleTimeEstimate: (value) => ({ type: 'toggleTimeEstimate', value: value as never }),
    setLocation: (value) => ({ type: 'setLocation', value: value as string }),
    setMatchMode: (kind, value) => ({ type: 'setMatchMode', kind: kind as 'context' | 'tag', value: value as 'any' | 'all' }),
    clear: () => ({ type: 'clear' }),
};

const sheetRows = (
    options: FocusControlsModel['options'],
    filters: FocusControlState['filters'],
    tf: (key: string, fallback: string) => string,
    t: Translate,
): string[][] => {
    const all = tf('common.all', 'All');
    const join = (values: string[]) => (values.length > 0 ? values.join(', ') : all);
    const rows: string[][] = [];
    if (options.tokens.length > 0) {
        rows.push([tf('filters.contexts', 'Contexts & tags'), join([...filters.tokens, ...filters.excludedTokens.map((token) => `${tf('filters.excluded', 'Excluded')}: ${token}`)])]);
    }
    if (options.projects.length > 0) {
        rows.push([tf('filters.projects', 'Projects'), join(options.projects.filter((project) => filters.projects.includes(project.id)).map((project) => project.title))]);
    }
    if (options.visibility.timeEstimate && options.timeEstimates.length > 0) {
        rows.push([tf('filters.timeEstimate', 'Time estimate'), join(filters.timeEstimates.map((estimate) => formatTimeEstimateLabel(estimate)))]);
    }
    if (options.visibility.energyLevel) rows.push([tf('taskEdit.energyLevel', 'Energy level'), join(filters.energyLevels.map((level) => t(`energyLevel.${level}`)))]);
    if (options.visibility.priority || options.visibility.location) {
        rows.push([tf('filters.more', 'More filters'), join([
            ...filters.priorities.map((priority) => t(`priority.${priority}`)),
            ...(filters.location.trim() ? [`${tf('taskEdit.locationLabel', 'Location')}: ${filters.location.trim()}`] : []),
        ])]);
    }
    return rows;
};

// ---------------------------------------------------------------------------
// Core functions called directly.

export function createCoreFocusDriver(t: Translate, now: () => Date) {
    const tf = (key: string, fallback: string) => tFallback(t, key, fallback);
    let state: FocusControlState = DEFAULT_FOCUS_CONTROL_STATE;
    let reorderDraft: Task[] | null = null;
    let saveName: string | null = null;
    const widget = createWidgetMirror();

    const model = (): FocusControlsModel => {
        const store = useTaskStore.getState();
        return buildFocusControlsModel({
            state, tasks: store.tasks, projects: store.projects, areas: store.areas, sections: store.sections,
            settings: store.settings, now: now(), t,
        });
    };
    const edit = (current: FocusControlsModel, controlEdit: FocusControlEdit) => {
        state = applyFocusControlEdit({
            state: current.filter.state,
            activeSavedFilter: current.filter.activeSavedFilter,
            effectiveSortBy: current.perspective.effectiveSortBy,
        }, controlEdit, current.savedFilters) ?? state;
    };
    const settings = () => useTaskStore.getState().settings;

    const observe = () => {
        const current = model();
        const { filter, perspective, lists, options } = current;
        const store = useTaskStore.getState();
        if (reorderDraft && !current.canReorder) reorderDraft = null;
        const split = splitTodayTasksByStartTime(lists.schedule, now());
        const sections = current.hasTasks ? [
            ...buildFocusTaskSections(lists, t).map((section) => ({
                type: section.key,
                title: section.title,
                total: section.items.length,
                items: (section.key === 'schedule'
                    ? buildFocusScheduleItems(split, t)
                    : section.key === 'next'
                        ? buildFocusNextItems({ groupBy: perspective.effectiveGroupBy, tasks: lists.nextActions, projects: store.projects, areas: store.areas, t, theme: 'default' })
                        : section.items.map((task) => ({ type: 'task' as const, task, grouped: false }))).map(encodeItem),
            })),
            {
                type: 'reviewProjects',
                title: t('agenda.reviewDueProjects') ?? 'Projects to review',
                total: current.reviewProjects.length,
                items: current.reviewProjects.map((project) => encodeItem({ type: 'project', id: project.id })),
            },
        ] : [];
        const chips = filter.chips.map((chip) => ({ label: chip.label, variant: chip.excluded ? 'excluded' : null }));
        const reorderData = reorderDraft ? reconcileFocusReorderOrder(reorderDraft, lists.focusedTasks) : null;
        return observation({
            sections,
            empty: current.empty,
            reorderMode: reorderDraft !== null,
            header: {
                viewOptionsTinted: perspective.effectiveGroupBy !== 'none' || perspective.effectiveSortBy !== DEFAULT_FOCUS_SORT_BY,
                filterTinted: filter.hasActive,
                filterBadge: filter.hasActive ? String(filter.activeCount) : null,
            },
            savedRow: current.savedFilters.length > 0 ? {
                all: { label: tf('common.all', 'All'), selected: perspective.isDefaultPerspective },
                chips: current.savedFilters.map((saved) => ({
                    label: `${saved.icon ? `${saved.icon} ` : ''}${saved.name}`,
                    selected: filter.state.savedFilterId === saved.id,
                    deleteLabel: `${tf('common.delete', 'Delete')} ${tf('savedFilters.label', 'saved filter')} ${saved.name}`,
                })),
            } : null,
            activeRow: filter.hasActive && !filter.activeSavedFilter ? { chips, clear: tf('filters.clear', 'Clear') } : null,
            sheet: {
                options,
                rows: sheetRows(options, filter.state.filters, tf, t),
                clear: filter.hasActive || current.advancedChips.length > 0,
                save: perspective.canSavePerspective ? tf('savedFilters.save', 'Save') : null,
                advancedChips: current.advancedChips.map((chip) => ({ id: chip.id, label: chip.label, variant: 'advanced' })),
                selections: {
                    tokens: filter.state.filters.tokens,
                    excludedTokens: filter.state.filters.excludedTokens,
                    projects: filter.state.filters.projects,
                    priorities: filter.state.filters.priorities,
                    energyLevels: filter.state.filters.energyLevels,
                    timeEstimates: filter.state.filters.timeEstimates,
                    locationQuery: filter.state.filters.location,
                    contextMatchMode: filter.state.filters.contextMatchMode,
                    tagMatchMode: filter.state.filters.tagMatchMode,
                    activeSavedFilterId: filter.state.savedFilterId,
                    criteria: filter.criteria,
                    currentCriteria: filter.currentCriteria,
                    activeCount: filter.activeCount,
                    hasActive: filter.hasActive,
                    hasCurrentCriteria: filter.hasCurrentCriteria,
                    canSave: filter.canSave,
                    showContextMatchMode: filter.showContextMatchMode,
                    showTagMatchMode: filter.showTagMatchMode,
                    chips: filter.chips.map((chip) => ({ id: chip.id, label: chip.label, excluded: chip.excluded })),
                },
            },
            view: {
                sort: getFocusSortOptions(current.prioritiesEnabled).map((value) => ({ label: getFocusSortByLabel(value, t), selected: perspective.effectiveSortBy === value })),
                group: getFocusGroupByOptions(current.prioritiesEnabled).map((value) => ({ label: getFocusGroupByLabel(value, t), selected: perspective.effectiveGroupBy === value })),
                details: { label: tf('list.showDetails', 'Show details'), selected: false },
            },
            reorderToggle: current.canReorder ? tf('projects.reorderTasks', 'Reorder') : null,
            reorderRows: reorderData ? reorderData.map((task, index) => {
                const secondary = getFocusReorderSecondaryLabel(task, current.projectById, safeFormatDate);
                return {
                    id: task.id,
                    texts: secondary ? [task.title, secondary] : [task.title],
                    label: getFocusReorderPositionLabel(t, task.title, index, reorderData.length),
                    hint: tf('focus.reorderHint', 'Long press and drag to reorder'),
                    actions: [
                        ...(index > 0 ? [['moveUp', tf('projects.moveUp', 'Move up')]] : []),
                        ...(index < reorderData.length - 1 ? [['moveDown', tf('projects.moveDown', 'Move down')]] : []),
                    ],
                };
            }) : null,
            saveName,
            widget: widget({ criteria: filter.criteria, sortBy: perspective.effectiveSortBy, sortOrder: filter.activeSavedFilter?.sortOrder ?? null }),
        });
    };

    const perform = async (action: FocusControlsAction) => {
        const current = model();
        const [kind, ...args] = action;
        switch (kind) {
            case 'filter':
                edit(current, { type: 'filter', edit: FILTER_METHOD_EDITS[args[0] as string](...args.slice(1)) });
                break;
            case 'chip': {
                const chip = current.filter.chips.find((entry) => entry.id === args[0])!;
                edit(current, { type: 'filter', edit: chip.edit });
                break;
            }
            case 'headerClear':
            case 'all':
                edit(current, { type: 'filter', edit: { type: 'clear' } });
                break;
            case 'sort':
                edit(current, { type: 'sort', sortBy: args[0] as SortField });
                break;
            case 'group': {
                const plan = planFocusGroupChange(args[0] as FocusGroupBy, {
                    effectiveGroupBy: current.perspective.effectiveGroupBy,
                    hasActiveSavedFilter: current.filter.activeSavedFilter !== null,
                    settings: settings(),
                });
                if (!plan) break;
                state = { ...current.filter.state, savedFilterId: null };
                await useTaskStore.getState().updateSettings(plan.settingsUpdate);
                break;
            }
            case 'saved':
                edit(current, current.filter.state.savedFilterId === args[0]
                    ? { type: 'filter', edit: { type: 'clear' } }
                    : { type: 'applySavedFilter', id: args[0] as string });
                break;
            case 'advancedChip': {
                const chip = current.advancedChips.find((entry) => entry.id === args[0])!;
                const plan = planFocusFilterCriterionRemoval({
                    activeSavedFilter: current.filter.activeSavedFilter,
                    criterionId: chip.criterionId,
                    savedFilters: settings().savedFilters,
                    nowIso: now().toISOString(),
                });
                if (plan) await useTaskStore.getState().updateSettings({ savedFilters: plan.savedFilters });
                break;
            }
            case 'deleteSaved':
                await useTaskStore.getState().updateSettings(planFocusFilterDelete(settings().savedFilters, args[0] as string));
                break;
            case 'openSave':
                saveName = getFocusSaveFilterName([
                    ...current.filter.chips.map((chip) => chip.label),
                    ...current.advancedChips.map((chip) => chip.label),
                ], tf('savedFilters.defaultName', 'Focus filter'));
                break;
            case 'saveName':
                saveName = args[0] as string;
                break;
            case 'saveConfirm': {
                const plan = planFocusFilterSave({
                    name: saveName ?? '',
                    canSave: current.perspective.canSavePerspective,
                    currentCriteria: current.filter.currentCriteria,
                    effectiveSortBy: current.perspective.effectiveSortBy,
                    effectiveGroupBy: current.perspective.effectiveGroupBy,
                    savedFilters: settings().savedFilters,
                    id: generateUUID(),
                    nowIso: now().toISOString(),
                });
                if (!plan) break;
                await useTaskStore.getState().updateSettings({ savedFilters: plan.savedFilters });
                state = applyFocusSavedFilter(current.filter.state, plan.filter);
                saveName = null;
                break;
            }
            case 'reorderEnter':
                reorderDraft = current.lists.focusedTasks;
                break;
            case 'reorderMove': {
                const next = moveFocusReorderTask(reconcileFocusReorderOrder(reorderDraft ?? [], current.lists.focusedTasks), args[0] as string, args[1] as -1 | 1);
                if (!next) break;
                reorderDraft = next;
                await useTaskStore.getState().reorderFocusedTasks(next.map((task) => task.id));
                break;
            }
            case 'reorderDrag': {
                const byId = new Map(reconcileFocusReorderOrder(reorderDraft ?? [], current.lists.focusedTasks).map((task) => [task.id, task]));
                reorderDraft = (args[0] as string[]).map((id) => byId.get(id)!);
                await useTaskStore.getState().reorderFocusedTasks(args[0] as string[]);
                break;
            }
            case 'reorderDone':
                reorderDraft = null;
                break;
            default:
                throw new Error(`Unknown action ${kind}`);
        }
    };
    return { observe, perform };
}

// ---------------------------------------------------------------------------
// The native host contract.

type Host = ReturnType<typeof createNativeHostContract>;

const unwrap = <T,>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};

export function createContractFocusDriver(host: Host, t: Translate) {
    const tf = (key: string, fallback: string) => tFallback(t, key, fallback);
    let state: FocusControlState = DEFAULT_FOCUS_CONTROL_STATE;
    let reorderMode = false;
    let saveName: string | null = null;
    const widget = createWidgetMirror();
    const read = (controlEdit?: FocusControlEdit): NativeFocusView => {
        const view = unwrap(host.getFocus({ limit: 100, controls: state, ...(controlEdit ? { controlEdit } : {}) }));
        state = view.controls.state;
        return view;
    };
    const commandInput = () => ({ requestId: generateUUID(), controls: state });

    const observe = () => {
        const view = read();
        const { controls } = view;
        if (reorderMode && !controls.reorder) reorderMode = false;
        const sheet = controls.filterSheet;
        const sections = view.sections.map((section) => {
            const items: string[] = [];
            const laterTodayCount = section.rows.filter((row) => row.laterToday).length;
            section.rows.forEach((row, index) => {
                const group = section.groups?.find(({ start }) => start === index);
                if (group) items.push(`#${group.id}|${group.title}|${group.count}|${group.muted ? 1 : 0}|${group.dotColor ?? ''}`);
                if (row.laterToday && !section.rows[index - 1]?.laterToday) {
                    items.push(`#focus:schedule:later-today|${tf('agenda.laterToday', 'Later today')}|${laterTodayCount}|1|`);
                }
                items.push(`${row.id}${section.groups || row.laterToday ? '~' : ''}`);
            });
            return { type: section.key, title: section.title, total: section.total, items };
        });
        const hasTasks = view.sections.some((section) => section.total > 0) || view.reviewProjects.length > 0;
        const tokens = sheet.tokens.items;
        const chipLabels = sheet.chips.map((chip) => ({ label: chip.label, variant: chip.excluded ? 'excluded' : null }));
        const priorityOn = sheet.visibility.priority;
        return observation({
            sections: hasTasks ? [...sections, {
                type: 'reviewProjects',
                title: t('agenda.reviewDueProjects') ?? 'Projects to review',
                total: view.reviewProjects.length,
                items: view.reviewProjects.map((project) => `@${project.id}`),
            }] : [],
            empty: controls.empty,
            reorderMode,
            header: {
                viewOptionsTinted: controls.header.viewOptions.active,
                filterTinted: controls.header.filters.active,
                filterBadge: controls.header.filters.badge,
            },
            savedRow: controls.savedFilters ? {
                all: { label: controls.savedFilters.all.label, selected: controls.savedFilters.all.selected },
                chips: controls.savedFilters.chips.items.map((chip) => ({ label: chip.label, selected: chip.selected, deleteLabel: chip.deleteLabel })),
            } : null,
            activeRow: controls.activeChips ? { chips: chipLabels, clear: controls.activeChips.clear.label } : null,
            sheet: {
                options: {
                    tokens: tokens.map((token) => token.value),
                    projects: sheet.projects.items.map((project) => ({ id: project.id, title: project.title })),
                    timeEstimates: sheet.timeEstimates.map((estimate) => estimate.value),
                    visibility: sheet.visibility,
                },
                rows: [
                    ...(sheet.tokens.total > 0 ? [[sheet.text.contexts, sheet.summaries.tokens]] : []),
                    ...(sheet.projects.total > 0 ? [[sheet.text.projects, sheet.summaries.projects]] : []),
                    ...(sheet.visibility.timeEstimate && sheet.timeEstimates.length > 0 ? [[sheet.text.timeEstimate, sheet.summaries.timeEstimates]] : []),
                    ...(sheet.visibility.energyLevel ? [[sheet.text.energyLevel, sheet.summaries.energyLevels]] : []),
                    ...(priorityOn || sheet.visibility.location ? [[sheet.text.more, sheet.summaries.more]] : []),
                ],
                clear: sheet.clear.visible,
                save: sheet.save?.label ?? null,
                advancedChips: sheet.advancedChips.map((chip) => ({ id: chip.id, label: chip.label, variant: 'advanced' })),
                selections: selectionsFromView(view),
            },
            view: {
                sort: controls.view.sort.options.map((option) => ({ label: option.label, selected: option.selected })),
                group: controls.view.group.options.map((option) => ({ label: option.label, selected: option.selected })),
                details: { label: controls.view.details.showLabel, selected: false },
            },
            reorderToggle: controls.reorder?.label ?? null,
            reorderRows: reorderMode && controls.reorder ? controls.reorder.rows.items.map((row) => ({
                id: row.id,
                texts: row.secondaryLabel ? [row.title, row.secondaryLabel] : [row.title],
                label: row.positionLabel,
                hint: controls.reorder!.hint,
                actions: [
                    ...(row.moveUp ? [['moveUp', controls.reorder!.moveUpLabel]] : []),
                    ...(row.moveDown ? [['moveDown', controls.reorder!.moveDownLabel]] : []),
                ],
            })) : null,
            saveName,
            widget: widget(controls.widgetFilter),
        });
    };

    const perform = async (action: FocusControlsAction) => {
        const view = read();
        const { controls } = view;
        const [kind, ...args] = action;
        switch (kind) {
            case 'filter': {
                const [method, ...rest] = args as [string, ...unknown[]];
                const sheet = controls.filterSheet;
                // The option's own edit where the sheet offers one; the rest are typed input.
                const offered = method === 'toggleToken' ? sheet.tokens.items.find((token) => token.value === rest[0])?.edit
                    : method === 'toggleProject' ? sheet.projects.items.find((project) => project.id === rest[0])?.edit
                        : method === 'togglePriority' ? sheet.priorities.find((option) => option.value === rest[0])?.edit
                            : method === 'toggleEnergyLevel' ? sheet.energyLevels.find((option) => option.value === rest[0])?.edit
                                : method === 'toggleTimeEstimate' ? sheet.timeEstimates.find((option) => option.value === rest[0])?.edit
                                    : method === 'setMatchMode' ? sheet.matchModes[rest[0] as 'context' | 'tag'].options.find((option) => option.value === rest[1])?.edit
                                        : method === 'clear' ? sheet.clear.edit
                                            : undefined;
                read(offered ?? { type: 'filter', edit: FILTER_METHOD_EDITS[method](...rest) });
                break;
            }
            case 'chip':
                read(controls.filterSheet.chips.find((chip) => chip.id === args[0])!.edit);
                break;
            case 'headerClear':
                read(controls.activeChips!.clear.edit);
                break;
            case 'all':
                read(controls.savedFilters!.all.edit);
                break;
            case 'saved':
                read(controls.savedFilters!.chips.items.find((chip) => chip.id === args[0])!.edit);
                break;
            case 'sort':
                read(controls.view.sort.options.find((option) => option.value === args[0])!.edit);
                break;
            case 'group':
                state = unwrap(await host.setFocusGroupBy({ ...commandInput(), groupBy: args[0] as FocusGroupBy })).controls;
                break;
            case 'advancedChip': {
                const chip = controls.filterSheet.advancedChips.find((entry) => entry.id === args[0])!;
                state = unwrap(await host.removeFocusFilterCriterion({ ...commandInput(), criterionId: chip.criterionId })).controls;
                break;
            }
            case 'deleteSaved':
                state = unwrap(await host.deleteFocusFilter({ ...commandInput(), id: args[0] as string })).controls;
                break;
            case 'openSave':
                saveName = controls.filterSheet.save!.dialog.defaultName;
                break;
            case 'saveName':
                saveName = args[0] as string;
                break;
            case 'saveConfirm':
                state = unwrap(await host.saveFocusFilter({ ...commandInput(), name: saveName ?? '' })).controls;
                saveName = null;
                break;
            case 'reorderEnter':
                reorderMode = true;
                break;
            case 'reorderMove': {
                const row = controls.reorder!.rows.items.find((entry) => entry.id === args[0])!;
                const ids = (args[1] as number) < 0 ? row.moveUp : row.moveDown;
                if (ids) unwrap(await host.reorderFocus({ ...commandInput(), ids }));
                break;
            }
            case 'reorderDrag':
                unwrap(await host.reorderFocus({ ...commandInput(), ids: args[0] as string[] }));
                break;
            case 'reorderDone':
                reorderMode = false;
                break;
            default:
                throw new Error(`Unknown action ${kind}`);
        }
    };
    return { observe, perform, getState: () => state };
}

const selectionsFromView = (view: NativeFocusView) => {
    const { controls } = view;
    const { filters } = controls.state;
    const sheet = controls.filterSheet;
    return {
        tokens: filters.tokens,
        excludedTokens: filters.excludedTokens,
        projects: filters.projects,
        priorities: filters.priorities,
        energyLevels: filters.energyLevels,
        timeEstimates: filters.timeEstimates,
        locationQuery: filters.location,
        contextMatchMode: filters.contextMatchMode,
        tagMatchMode: filters.tagMatchMode,
        activeSavedFilterId: controls.state.savedFilterId,
        activeCount: sheet.activeCount,
        hasActive: sheet.hasActive,
        showContextMatchMode: sheet.matchModes.context.visible,
        showTagMatchMode: sheet.matchModes.tag.visible,
        chips: sheet.chips.map((chip) => ({ id: chip.id, label: chip.label, excluded: chip.excluded })),
    };
};

/** The observation keys the contract view carries (criteria and save flags live in core's model only). */
export const CONTRACT_SELECTION_KEYS = [
    'tokens', 'excludedTokens', 'projects', 'priorities', 'energyLevels', 'timeEstimates', 'locationQuery',
    'contextMatchMode', 'tagMatchMode', 'activeSavedFilterId', 'activeCount', 'hasActive', 'showContextMatchMode',
    'showTagMatchMode', 'chips',
] as const;
