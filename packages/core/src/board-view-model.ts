import { getProjectAccentColor } from './task-accent-color';


import { projectMatchesAreaFilterSelection, type AreaFilterSelection } from './area-filter';
import { normalizeBulkTaskTokenInput } from './bulk-task-tokens';
import { formatTimeEstimateLabel } from './calendar-scheduling';
import { countActiveFilterCriteria } from './filter-criteria';
import { tFallback } from './i18n';
import { applyListFilterEdit, EMPTY_LIST_FILTER_STATE, resolveListFilterState, type ListFilterEdit } from './list-filter-state';
import { createTaskFilterPredicate, hasActiveFilterCriteria, SAVED_FILTER_NO_PROJECT_ID } from './saved-filters';
import type { TaskMetadataFilterVisibility } from './task-metadata-filter-visibility';
import { getUsedTaskTokens } from './task-token-usage';
import { sortTasksByBoardOrder } from './task-utils';
import type { Area, FilterCriteria, MultiValueFilterMatchMode, Project, Task, TaskStatus } from './types';

type Translate = (key: string) => string;

export type BoardStatus = Extract<TaskStatus, 'inbox' | 'next' | 'waiting' | 'someday' | 'done'>;

export type BoardColumnTone = 'text' | 'tint' | 'warning' | 'secondaryText' | 'success';

export const BOARD_COLUMNS: readonly { status: BoardStatus; labelKey: string; label: string; tone: BoardColumnTone }[] = [
    { status: 'inbox', labelKey: 'status.inbox', label: 'Inbox', tone: 'text' },
    { status: 'next', labelKey: 'status.next', label: 'Next', tone: 'tint' },
    { status: 'waiting', labelKey: 'status.waiting', label: 'Waiting', tone: 'warning' },
    { status: 'someday', labelKey: 'status.someday', label: 'Someday', tone: 'secondaryText' },
    { status: 'done', labelKey: 'status.done', label: 'Done', tone: 'success' },
];

export const isBoardStatus = (status: unknown): status is BoardStatus => BOARD_COLUMNS.some((column) => column.status === status);


export const BOARD_FILTER_VISIBILITY: TaskMetadataFilterVisibility = {
    energyLevel: false,
    location: false,
    priority: false,
    timeEstimate: false,
};

export type BoardDuePreset = 'today' | 'this_week' | 'this_month' | 'overdue' | 'no_date';
export const BOARD_DUE_DATE_PRESETS: BoardDuePreset[] = ['today', 'this_week', 'this_month', 'overdue', 'no_date'];


export const toggleBoardDuePreset = (criteria: FilterCriteria, preset: BoardDuePreset): FilterCriteria => {
    const isActive = criteria.dueDateRange
        && 'preset' in criteria.dueDateRange
        && criteria.dueDateRange.preset === preset;
    const next = { ...criteria };
    if (isActive) {
        delete next.dueDateRange;
    } else {
        next.dueDateRange = { preset };
    }
    return next;
};


export const getBoardDuePreset = (criteria: FilterCriteria): BoardDuePreset | null => {
    const dueDateRange = criteria.dueDateRange;
    if (!dueDateRange || !('preset' in dueDateRange)) return null;
    return BOARD_DUE_DATE_PRESETS.includes(dueDateRange.preset as BoardDuePreset) ? dueDateRange.preset as BoardDuePreset : null;
};


export const selectBoardTasks = (visibleTasks: readonly Task[]): Task[] => visibleTasks.filter((task) => task.status !== 'reference');

export type BoardColumn = {
    status: BoardStatus;
    label: string;
    tone: BoardColumnTone;
    tasks: Task[];

    empty: string | null;
};


export function buildBoardColumns(input: {
    tasks: readonly Task[];
    criteria: FilterCriteria;
    searchQuery: string;
    projects: Project[];
    now: Date;
    t: Translate;
}): BoardColumn[] {
    const criteriaFiltered = hasActiveFilterCriteria(input.criteria)
        ? input.tasks.filter(createTaskFilterPredicate(input.criteria, { projects: input.projects, now: input.now }))
        : input.tasks;
    const search = input.searchQuery.trim().toLowerCase();
    const shown = search ? criteriaFiltered.filter((task) => task.title.toLowerCase().includes(search)) : criteriaFiltered;
    return BOARD_COLUMNS.map((column) => {
        const tasks = sortTasksByBoardOrder(shown.filter((task) => task.status === column.status));
        return {
            status: column.status,
            label: tFallback(input.t, column.labelKey, column.label),
            tone: column.tone,
            tasks,
            empty: tasks.length === 0 ? input.t('board.noTasks') : null,
        };
    });
}


export type BoardProjectBadge = { title: string; color?: string };


export const getBoardProjectBadges = (projects: readonly Project[], areaById: Map<string, Area>, themePreset?: string | null): Map<string, BoardProjectBadge> => new Map(
    projects.map((project) => [project.id, { title: project.title, color: getProjectAccentColor(project, areaById, themePreset) }]),
);

export type BoardCard = {
    projectTitle: string | null;

    projectColor: string | null;

    tags: string[];
    contexts: string[];
    timeEstimateLabel: string | null;
    showMetaRow: boolean;
};

export function getBoardCard(task: Task, options: { badges: Map<string, BoardProjectBadge>; timeEstimatesEnabled: boolean; t: Translate }): BoardCard {
    const badge = task.projectId ? options.badges.get(task.projectId) : undefined;
    const projectTitle = badge?.title || null;
    const timeEstimateLabel = options.timeEstimatesEnabled && task.timeEstimate
        ? formatTimeEstimateLabel(task.timeEstimate, { t: options.t })
        : null;
    const tags = (task.tags || []).slice(0, 6);
    const contexts = (task.contexts || []).slice(0, 6);
    return {
        projectTitle,
        projectColor: projectTitle ? badge?.color || null : null,
        tags,
        contexts,
        timeEstimateLabel,
        showMetaRow: Boolean(projectTitle) || (task.tags?.length ?? 0) > 0 || (task.contexts?.length ?? 0) > 0 || Boolean(timeEstimateLabel),
    };
}

export type BoardCardAction = 'duplicate' | 'trash';


export const BOARD_CARD_SWIPES: Record<'left' | 'right', { labelKey: string; actions: readonly BoardCardAction[] }> = {
    left: { labelKey: 'taskEdit.duplicateTask', actions: ['duplicate'] },
    right: { labelKey: 'board.delete', actions: ['trash'] },
};


export const getBoardCardText = (t: Translate) => ({
    duplicate: t(BOARD_CARD_SWIPES.left.labelKey),
    delete: t(BOARD_CARD_SWIPES.right.labelKey),
    errorTitle: tFallback(t, 'common.error', 'Error'),
    duplicateFailed: t('task.duplicateFailed'),
});


export type BoardDropPlan =

    | { kind: 'status'; taskId: string; status: BoardStatus }

    | { kind: 'reorder'; status: BoardStatus; orderedIds: string[]; taskId: string };


export function planBoardDrop(input: {
    task: Pick<Task, 'id' | 'status'>;
    status: BoardStatus;
    columnIds: readonly string[];
    afterId?: string | null;
}): BoardDropPlan | null {
    const { task, status, columnIds, afterId } = input;
    if (!isBoardStatus(task.status)) return null;
    if (task.status !== status) return { kind: 'status', taskId: task.id, status };
    if (afterId === undefined || !columnIds.includes(task.id)) return null;
    const orderedIds = columnIds.filter((id) => id !== task.id);
    const at = afterId === null ? 0 : orderedIds.indexOf(afterId) + 1;
    if (at === 0 && afterId !== null) return null;
    orderedIds.splice(at, 0, task.id);
    return orderedIds.every((id, index) => id === columnIds[index]) ? null : { kind: 'reorder', status, orderedIds, taskId: task.id };
}


export function getBoardFilterOptions(input: {
    tasks: Task[];
    projects: readonly Project[];
    areaFilter: AreaFilterSelection;
    areaById: Map<string, Area>;
    badges: Map<string, BoardProjectBadge>;
    t: Translate;
}) {
    const noProject = input.t('taskEdit.noProjectOption');
    const projects = [
        { id: SAVED_FILTER_NO_PROJECT_ID, title: noProject },
        ...input.projects
            .filter((project) => !project.deletedAt)
            .filter((project) => projectMatchesAreaFilterSelection(project, input.areaFilter, input.areaById))
            .sort((a, b) => a.title.localeCompare(b.title))
            .map((project) => ({ id: project.id, title: project.title })),
    ];
    return {
        tokens: getUsedTaskTokens(input.tasks, (task) => [
            ...(task.contexts ?? []).map((token) => normalizeBulkTaskTokenInput(token, 'contexts')),
            ...(task.tags ?? []).map((token) => normalizeBulkTaskTokenInput(token, 'tags')),
        ], { includeAncestors: true }),
        projects,
        getProjectLabel: (projectId: string) => (
            projectId === SAVED_FILTER_NO_PROJECT_ID ? noProject : input.badges.get(projectId)?.title
        ),
    };
}


export function getBoardFilterSummary(input: { criteria: FilterCriteria; searchQuery: string; t: Translate }) {
    const { criteria, t } = input;
    const search = input.searchQuery.trim();
    const searchActive = search.length > 0;
    const filtersActive = hasActiveFilterCriteria(criteria);
    const activeCount = countActiveFilterCriteria(criteria) + (searchActive ? 1 : 0);
    const duePreset = getBoardDuePreset(criteria);
    const dueLabel = tFallback(t, 'search.due.label', 'Due date');
    const dueSummary = duePreset ? t(`filters.datePreset.${duePreset}`) : tFallback(t, 'common.all', 'All');
    return {
        searchActive,

        active: filtersActive || searchActive,
        activeCount,
        filterLabel: `${t('filters.label')}${activeCount > 0 ? ` (${activeCount})` : ''}`,
        searchPlaceholder: t('common.search'),
        clearLabel: t('filters.clear'),
        duePreset,
        due: {
            label: dueLabel,
            summary: dueSummary,
            accessibilityLabel: `${dueLabel}: ${dueSummary}`,
            presets: BOARD_DUE_DATE_PRESETS.map((preset) => ({ preset, label: t(`filters.datePreset.${preset}`), selected: duePreset === preset })),
        },

        chips: [
            ...(searchActive ? [{ id: 'board-search' as const, label: `${t('common.search')}: ${search}` }] : []),
            ...(duePreset ? [{ id: 'board-due-date' as const, label: `${dueLabel}: ${t(`filters.datePreset.${duePreset}`)}` }] : []),
        ],
    };
}


export type BoardFilterState = {
    searchQuery: string;
    tokens: string[];
    excludedTokens: string[];
    projects: string[];
    contextMatchMode: MultiValueFilterMatchMode;
    tagMatchMode: MultiValueFilterMatchMode;
    duePreset: BoardDuePreset | null;
};

export const EMPTY_BOARD_FILTER_STATE: BoardFilterState = {
    searchQuery: '',
    tokens: [],
    excludedTokens: [],
    projects: [],
    contextMatchMode: 'any',
    tagMatchMode: 'any',
    duePreset: null,
};

export type BoardFilterEdit =
    | Extract<ListFilterEdit, { type: 'toggleToken' | 'removeToken' | 'toggleProject' | 'removeProject' | 'setMatchMode' | 'setSearch' | 'clear' }>
    | { type: 'toggleDuePreset'; preset: BoardDuePreset }
    | { type: 'clearDuePreset' };


const withMatchModes = (state: BoardFilterState): BoardFilterState => ({
    ...state,
    contextMatchMode: state.tokens.some((token) => token.startsWith('@')) ? state.contextMatchMode : 'any',
    tagMatchMode: state.tokens.some((token) => token.startsWith('#')) ? state.tagMatchMode : 'any',
});


export function applyBoardFilterEdit(state: BoardFilterState, edit: BoardFilterEdit): BoardFilterState {
    switch (edit.type) {
        case 'setSearch':
            return { ...state, searchQuery: edit.value };
        case 'toggleDuePreset':
            return { ...state, duePreset: state.duePreset === edit.preset ? null : edit.preset };
        case 'clearDuePreset':
            return { ...state, duePreset: null };
        case 'clear':
            return EMPTY_BOARD_FILTER_STATE;
        default: {
            const list = applyListFilterEdit({ ...EMPTY_LIST_FILTER_STATE, ...state, searchQuery: '' }, edit);
            return withMatchModes({
                ...state,
                tokens: list.tokens,
                excludedTokens: list.excludedTokens,
                projects: list.projects,
                contextMatchMode: list.contextMatchMode,
                tagMatchMode: list.tagMatchMode,
            });
        }
    }
}


export function resolveBoardFilterState(
    input: BoardFilterState,
    options: { tokens: readonly string[]; projectIds: readonly string[]; getProjectLabel: (projectId: string) => string | undefined; t: Translate },
) {
    const resolved = resolveListFilterState({ ...EMPTY_LIST_FILTER_STATE, ...withMatchModes(input), searchQuery: '' }, {
        visibility: BOARD_FILTER_VISIBILITY,
        retainTokens: options.tokens,
        retainProjects: options.projectIds,
        getProjectLabel: options.getProjectLabel,
        t: options.t,
    });
    const state = withMatchModes({
        ...input,
        tokens: resolved.state.tokens,
        excludedTokens: resolved.state.excludedTokens,
        projects: resolved.state.projects,
    });
    return {
        state,
        criteria: { ...resolved.criteria, ...(state.duePreset ? { dueDateRange: { preset: state.duePreset } } : {}) } as FilterCriteria,
        chips: resolved.chips,
        showContextMatchMode: resolved.showContextMatchMode,
        showTagMatchMode: resolved.showTagMatchMode,
    };
}
