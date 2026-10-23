import { getProjectAccentColor } from './task-accent-color';
/**
 * The React Native Inbox, Waiting, Someday, Reference and Done screens as data: which
 * tasks each lists, their order and groups, the counts, the empty states, and
 * the filters, sorts and groupings it offers. Mobile's screens call this and
 * keep only React state and wiring; the native host serves the same result.
 */
import {
    isTaskVisibleInInbox,
    projectMatchesAreaFilterSelection,
    taskMatchesAreaFilterSelection,
    type AreaFilterSelection,
} from './area-filter';
import { normalizeBulkTaskTokenInput } from './bulk-task-tokens';
import { TIME_ESTIMATE_OPTIONS } from './calendar-scheduling';
import { safeParseDueDate, type DateFormatter } from './date';
import { countActiveFilterCriteria } from './filter-criteria';
import { tFallback } from './i18n';
import { isTaskInActiveProject } from './project-utils';
import { createReferenceSearchPredicate, isReferenceInVisibleProject } from './reference';
import { resolveFeatureFlags } from './resolve-feature-flags';
import { SAVED_FILTER_NO_PROJECT_ID } from './saved-filters';
import { taskMatchesFilterSelections } from './task-filter-selections';
import { buildTaskGroupSections, getTaskGroupByLabel, type TaskGroupBy, type TaskGroupItem } from './task-group-sections';
import {
    DONE_TASK_LIST_SORT_OPTIONS,
    getTaskSortByLabel,
    getVisibleTaskSortOptions,
    resolveDoneTaskSortBy,
    resolveNonDoneTaskSortBy,
    TASK_LIST_SORT_OPTIONS,
} from './task-list-sort-options';
import { getTaskMetadataFilterVisibility, type TaskMetadataFilterVisibility } from './task-metadata-filter-visibility';
import { getUsedTaskTokens } from './task-token-usage';
import { baseTextCollator, getWaitingPerson, sortDoneTasksForListView, sortTasksBy } from './task-utils';
import type { AppSettings, Area, FilterCriteria, Project, Task, TaskSortBy, TimeEstimate, ViewSectionDefinition } from './types';
import {
    groupProjectsByViewSection,
    groupTasksByViewSection,
    sortViewSectionDefinitions,
    type ViewSectionTaskGroup,
} from './view-sections';

type Translate = (key: string) => string;

// ---------------------------------------------------------------------------
// Shared pieces

/**
 * The Waiting For screen's default order, shared with the widget lists (#1173):
 * dated tasks first by due date, then newest first.
 */
export function compareWaitingTasks(a: Task, b: Task): number {
    if (a.dueDate && !b.dueDate) return -1;
    if (!a.dueDate && b.dueDate) return 1;
    if (a.dueDate && b.dueDate) {
        const aDue = safeParseDueDate(a.dueDate);
        const bDue = safeParseDueDate(b.dueDate);
        if (aDue && bDue) return aDue.getTime() - bDue.getTime();
    }
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}

/** The Someday/Maybe screen's default order: newest first. */
export function compareSomedayTasks(a: Task, b: Task): number {
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}

const byOrderThenTitle = (a: Project, b: Project) => {
    const aOrder = Number.isFinite(a.order) ? a.order : Number.POSITIVE_INFINITY;
    const bOrder = Number.isFinite(b.order) ? b.order : Number.POSITIVE_INFINITY;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.title.localeCompare(b.title);
};

/**
 * Projects parked in the same bucket as the screen's tasks: Someday and Waiting
 * are the two GTD buckets a whole project can sit in.
 */
export function selectDeferredProjects(
    projects: readonly Project[],
    status: 'someday' | 'waiting',
    resolvedAreaFilter: AreaFilterSelection,
    areaById: Map<string, Area>,
): Project[] {
    return [...projects]
        .filter((project) => (
            !project.deletedAt
            && project.status === status
            && projectMatchesAreaFilterSelection(project, resolvedAreaFilter, areaById)
        ))
        .sort(byOrderThenTitle);
}

export type DeferredProjectsSection = {
    /** "Projects (2)"; also the header's accessibility label. */
    title: string;
    /** The swipe action that makes a project active again. */
    activateLabel: string;
    rows: { id: string; title: string; areaName: string | null; color: string | null }[];
};

/** The collapsible header both screens show above their tasks; null when nothing is parked. */
export function buildDeferredProjectsSection(
    projects: readonly Project[],
    areaById: Map<string, Area>,
    t: Translate,
): DeferredProjectsSection | null {
    if (projects.length === 0) return null;
    return {
        title: `${tFallback(t, 'projects.title', 'Projects')} (${projects.length})`,
        activateLabel: t('projects.reactivate'),
        rows: projects.map((project) => ({
            id: project.id,
            title: project.title,
            areaName: (project.areaId ? areaById.get(project.areaId)?.name : undefined) ?? null,
            // Mobile draws the stored color, else its secondary text color.
            color: getProjectAccentColor(project, areaById) ?? null,
        })),
    };
}

const projectFilterOptions = (tasks: readonly Task[], projects: readonly Project[], t: Translate) => {
    const usedProjectIds = new Set(tasks.map((task) => task.projectId).filter((id): id is string => Boolean(id)));
    const noProjectOption = tasks.some((task) => !task.projectId)
        ? [{ id: SAVED_FILTER_NO_PROJECT_ID, title: tFallback(t, 'taskEdit.noProjectOption', 'No project') }]
        : [];
    const options = [...projects]
        .filter((project) => usedProjectIds.has(project.id) && !project.deletedAt && !project.purgedAt)
        .sort(byOrderThenTitle)
        .map((project) => ({ id: project.id, title: project.title }));
    return [...noProjectOption, ...options];
};

const projectFilterLabel = (projects: readonly Project[], t: Translate) => {
    const projectById = new Map(projects.map((project) => [project.id, project]));
    return (projectId: string) => (projectId === SAVED_FILTER_NO_PROJECT_ID
        ? tFallback(t, 'taskEdit.noProjectOption', 'No project')
        : projectById.get(projectId)?.title);
};

export type ListFilterOptions = {
    tokens: string[];
    /** Null where the screen offers no project filter. */
    projects: { id: string; title: string }[] | null;
    timeEstimates: TimeEstimate[];
    visibility: TaskMetadataFilterVisibility;
    /** What the filter picker keeps: selections outside these are dropped. */
    retainTokens?: string[];
    retainProjects?: string[];
    getProjectLabel?: (projectId: string) => string | undefined;
};

// ---------------------------------------------------------------------------
// Waiting For

export type WaitingViewModel = {
    /** The rows, filtered by the person and ordered. */
    tasks: Task[];
    /** Distinct people, first spelling seen, in collation order. */
    people: string[];
    /** False when the person asked for is no longer offered; mobile then clears it. */
    personOffered: boolean;
    /** A removed person falls back to All before rows are rendered. */
    person: string;
    count: number;
    withDeadlineCount: number;
    deferredProjects: Project[];
    deferred: DeferredProjectsSection | null;
    /** The list has no rows and no parked projects. */
    showEmptyState: boolean;
    labels: {
        count: string;
        withDeadline: string;
        filter: string;
        all: string;
        clear: string;
        emptyTitle: string;
        emptyHint: string;
    };
};

export function buildWaitingViewModel(input: {
    /** Store tasks visible in the selected areas (isTaskVisibleInArea). */
    tasks: readonly Task[];
    projects: readonly Project[];
    resolvedAreaFilter: AreaFilterSelection;
    areaById: Map<string, Area>;
    /** The chosen person, '' for All; matched without case. */
    person: string;
    t: Translate;
}): WaitingViewModel {
    const { t } = input;
    const waitingTasks = input.tasks.filter((task) => task.status === 'waiting').sort(compareWaitingTasks);
    const spellings = new Map<string, string>();
    for (const task of waitingTasks) {
        const person = getWaitingPerson(task);
        if (!person) continue;
        const key = person.toLowerCase();
        if (!spellings.has(key)) spellings.set(key, person);
    }
    const people = [...spellings.values()].sort((a, b) => baseTextCollator.compare(a, b));
    const selected = input.person.toLowerCase();
    const personOffered = !input.person || people.some((person) => person.toLowerCase() === selected);
    const effectivePerson = personOffered ? input.person : '';
    const tasks = waitingTasks.filter((task) => {
        if (!effectivePerson) return true;
        const person = getWaitingPerson(task);
        return Boolean(person) && person!.toLowerCase() === selected;
    });
    const deferredProjects = selectDeferredProjects(input.projects, 'waiting', input.resolvedAreaFilter, input.areaById);
    return {
        tasks,
        people,
        personOffered,
        person: effectivePerson,
        count: tasks.length,
        withDeadlineCount: tasks.filter((task) => task.dueDate).length,
        deferredProjects,
        deferred: buildDeferredProjectsSection(deferredProjects, input.areaById, t),
        showEmptyState: tasks.length === 0 && deferredProjects.length === 0,
        labels: {
            count: t('waiting.count'),
            withDeadline: t('waiting.withDeadline'),
            filter: t('process.delegateWhoLabel'),
            all: t('common.all'),
            clear: t('common.clear'),
            emptyTitle: t('waiting.empty'),
            emptyHint: t('waiting.emptyHint'),
        },
    };
}

// ---------------------------------------------------------------------------
// Someday/Maybe

export const SOMEDAY_GROUP_OPTIONS = ['viewSection', 'none', 'project', 'area'] as const;
export type SomedayGroupBy = typeof SOMEDAY_GROUP_OPTIONS[number];
const SOMEDAY_SECTION_GROUP_PREFIX = 'view-section:someday:';
const SOMEDAY_NO_SECTION_GROUP_ID = SOMEDAY_SECTION_GROUP_PREFIX;

function getSomedayGroupByLabel(groupBy: SomedayGroupBy, t: Translate): string {
    switch (groupBy) {
        case 'viewSection':
            return tFallback(t, 'viewSections.somedaySection', 'Someday section');
        case 'none':
            return tFallback(t, 'list.groupByNone', 'No grouping');
        case 'project':
            return tFallback(t, 'list.groupByProject', 'Project');
        case 'area':
            return tFallback(t, 'list.groupByArea', 'Area');
    }
}

/** The Someday section a group id adds to: undefined for "No section", null for a group that is not a section. */
export function getSomedayGroupSectionId(groupId: string): string | undefined | null {
    if (groupId === SOMEDAY_NO_SECTION_GROUP_ID) return undefined;
    return groupId.startsWith(SOMEDAY_SECTION_GROUP_PREFIX) ? groupId.slice(SOMEDAY_SECTION_GROUP_PREFIX.length) : null;
}

export function selectSomedayTasks(visibleTasks: readonly Task[]): Task[] {
    return visibleTasks.filter((task) => task.status === 'someday');
}

export function buildSomedayFilterOptions(input: {
    /** The screen's Someday tasks before filters (selectSomedayTasks). */
    tasks: readonly Task[];
    projects: readonly Project[];
    settings: AppSettings | undefined;
    t: Translate;
}): ListFilterOptions {
    const features = resolveFeatureFlags(input.settings);
    const tokens = getUsedTaskTokens([...input.tasks], (task) => [
        ...(task.contexts ?? []).map((token) => normalizeBulkTaskTokenInput(token, 'contexts')),
        ...(task.tags ?? []).map((token) => normalizeBulkTaskTokenInput(token, 'tags')),
    ], { includeAncestors: true });
    const projects = projectFilterOptions(input.tasks, input.projects, input.t);
    return {
        tokens,
        projects,
        timeEstimates: TIME_ESTIMATE_OPTIONS,
        visibility: getTaskMetadataFilterVisibility(input.tasks, {
            prioritiesEnabled: features.priorities,
            timeEstimatesEnabled: features.timeEstimates,
        }),
        retainTokens: tokens,
        retainProjects: projects.map((project) => project.id),
        getProjectLabel: projectFilterLabel(input.projects, input.t),
    };
}

/** Someday offers the task-list sorts, without Time estimate or Priority while that feature is off. */
function getSomedaySortOptions(settings: AppSettings | undefined): TaskSortBy[] {
    return getVisibleTaskSortOptions(TASK_LIST_SORT_OPTIONS, settings);
}

const toTaskListViewGroups = (items: readonly TaskGroupItem[]): ViewSectionTaskGroup[] => {
    const groups: ViewSectionTaskGroup[] = [];
    let current: ViewSectionTaskGroup | null = null;
    items.forEach((item) => {
        if (item.type === 'section') {
            current = { id: `attribute-group:${item.id}`, title: item.title, muted: item.muted, tasks: [] };
            groups.push(current);
            return;
        }
        current?.tasks.push(item.task);
    });
    return groups;
};

export type SomedayViewModel = {
    /** Filtered and ordered, before grouping. */
    tasks: Task[];
    /** Headings with their rows; undefined shows the tasks ungrouped. */
    groups: ViewSectionTaskGroup[] | undefined;
    effectiveSortBy: TaskSortBy;
    sortOptions: TaskSortBy[];
    sections: ViewSectionDefinition[];
    ideasCount: number;
    inProjectsCount: number;
    deferredProjects: Project[];
    /** The block above the list; null when parked projects are drawn inside section groups instead. */
    deferred: DeferredProjectsSection | null;
    /** Headings let a row be added to a section only in section grouping. */
    canAddTaskToGroup: boolean;
    showEmptyState: boolean;
    empty: { message: string; hint: string; actionLabel: string | null };
    labels: {
        ideas: string;
        inProjects: string;
        emptyTitle: string;
        emptyHint: string;
        filters: string;
        filtersClear: string;
        sort: string;
        group: string;
        details: string;
        newSection: string;
        back: string;
        close: string;
        more: string;
        moveToSection: string;
        addTask: string;
    };
    /** The overflow menu's current values and choices, as mobile draws them. */
    menu: {
        sortValue: string;
        sortOptions: { value: TaskSortBy; label: string; selected: boolean }[];
        groupValue: string;
        groupOptions: { value: SomedayGroupBy; label: string; selected: boolean }[];
    };
};

export function buildSomedayViewModel(input: {
    /** The screen's Someday tasks before filters (selectSomedayTasks). */
    tasks: readonly Task[];
    projects: readonly Project[];
    /** Visible areas in display order. */
    areaById: Map<string, Area>;
    resolvedAreaFilter: AreaFilterSelection;
    settings: AppSettings | undefined;
    sortBy: TaskSortBy;
    groupBy: SomedayGroupBy;
    showDetails: boolean;
    criteria: FilterCriteria;
    searchQuery: string;
    filterChips: readonly StatusListChip[];
    t: Translate;
}): SomedayViewModel {
    const { settings, t } = input;
    const effectiveSortBy = resolveNonDoneTaskSortBy(input.sortBy, settings);
    const filtered = input.tasks.filter((task) => taskMatchesFilterSelections(task, {
        criteria: input.criteria,
        searchQuery: input.searchQuery,
    }));
    const tasks = effectiveSortBy === 'default'
        ? [...filtered].sort(compareSomedayTasks)
        : sortTasksBy([...filtered], effectiveSortBy);
    const hasActiveFilters = Boolean(input.searchQuery.trim()) || countActiveFilterCriteria(input.criteria) > 0;
    const filteredEmpty = tasks.length === 0 && hasActiveFilters;
    const filterSummary = buildStatusListFilterSummary({
        kind: 'someday', chips: input.filterChips, activeCount: input.filterChips.length,
        hasActive: hasActiveFilters, includeArchivedProjects: false, t,
    });
    const sections = sortViewSectionDefinitions(settings?.gtd?.viewSections?.someday ?? []);
    const projectById = new Map(input.projects.map((project) => [project.id, project]));
    let groups: ViewSectionTaskGroup[] | undefined;
    if (input.groupBy === 'project' || input.groupBy === 'area') {
        groups = toTaskListViewGroups(buildTaskGroupSections({
            groupBy: input.groupBy,
            tasks,
            areas: Array.from(input.areaById.values()),
            projectById,
            t,
        }));
    }
    const deferredProjects = selectDeferredProjects(input.projects, 'someday', input.resolvedAreaFilter, input.areaById);
    let projectsInGroups = false;
    if (input.groupBy === 'viewSection' && sections.length > 0 && !filteredEmpty) {
        const noSectionTitle = tFallback(t, 'viewSections.noSection', 'No section');
        const grouped = groupTasksByViewSection(tasks, 'someday', sections, noSectionTitle);
        const byId = new Map(grouped.map((group) => [group.id, group]));
        // Parked projects sit in their section, before its tasks (#1319).
        const projectsById = groupProjectsByViewSection(deferredProjects, 'someday', sections);
        const withProjects = (group: ViewSectionTaskGroup): ViewSectionTaskGroup => {
            const projects = projectsById.get(group.id);
            return projects ? { ...group, projects } : group;
        };
        const noSectionGroup = byId.get(SOMEDAY_NO_SECTION_GROUP_ID)
            ?? (projectsById.has(SOMEDAY_NO_SECTION_GROUP_ID)
                ? { id: SOMEDAY_NO_SECTION_GROUP_ID, title: noSectionTitle, tasks: [], muted: true }
                : undefined);
        // This grouping is actionable: empty definitions still offer Add task.
        groups = [
            ...sections.map((section) => withProjects(byId.get(`${SOMEDAY_SECTION_GROUP_PREFIX}${section.id}`)
                ?? { id: `${SOMEDAY_SECTION_GROUP_PREFIX}${section.id}`, title: section.title, tasks: [] })),
            ...(noSectionGroup ? [withProjects(noSectionGroup)] : []),
        ];
        projectsInGroups = true;
    }
    const rowCount = groups ? groups.reduce((sum, group) => sum + 1 + group.tasks.length, 0) : tasks.length;
    const sortOptions = getSomedaySortOptions(settings);
    return {
        tasks,
        groups,
        effectiveSortBy,
        sortOptions,
        sections,
        ideasCount: input.tasks.length,
        inProjectsCount: input.tasks.filter((task) => task.projectId).length,
        deferredProjects,
        deferred: projectsInGroups ? null : buildDeferredProjectsSection(deferredProjects, input.areaById, t),
        canAddTaskToGroup: input.groupBy === 'viewSection',
        showEmptyState: filteredEmpty || (rowCount === 0 && deferredProjects.length === 0),
        empty: filterSummary.empty,
        labels: {
            ideas: t('someday.ideas'),
            inProjects: t('someday.inProjects'),
            emptyTitle: filterSummary.empty.message,
            emptyHint: filterSummary.empty.hint,
            filters: tFallback(t, 'filters.title', 'Filters'),
            filtersClear: tFallback(t, 'filters.clear', 'Clear'),
            sort: tFallback(t, 'sort.label', 'Sort'),
            group: tFallback(t, 'list.groupBy', 'Group'),
            details: input.showDetails
                ? tFallback(t, 'list.hideDetails', 'Hide details')
                : tFallback(t, 'list.showDetails', 'Show details'),
            newSection: tFallback(t, 'viewSections.new', 'New section'),
            back: tFallback(t, 'common.back', 'Back'),
            close: tFallback(t, 'common.close', 'Close'),
            more: tFallback(t, 'taskEdit.moreOptions', 'More options'),
            moveToSection: tFallback(t, 'viewSections.moveToSection', 'Move to section…'),
            addTask: tFallback(t, 'nav.addTask', 'Add task'),
        },
        menu: {
            sortValue: getTaskSortByLabel(effectiveSortBy, t),
            sortOptions: sortOptions.map((option) => ({ value: option, label: getTaskSortByLabel(option, t), selected: effectiveSortBy === option })),
            groupValue: getSomedayGroupByLabel(input.groupBy, t),
            groupOptions: SOMEDAY_GROUP_OPTIONS.map((option) => ({
                value: option,
                label: getSomedayGroupByLabel(option, t),
                selected: input.groupBy === option,
            })),
        },
    };
}

// ---------------------------------------------------------------------------
// Inbox, Reference and Done (mobile's TaskList for one status)

export type StatusListKind = 'inbox' | 'reference' | 'done';
export const TASK_LIST_GROUP_OPTIONS = ['none', 'context', 'area', 'project', 'tag'] as const satisfies readonly TaskGroupBy[];
/** Grouping by completion only says something in a list of finished work (#945). */
export const DONE_LIST_GROUP_OPTIONS = ['none', 'completedDate', 'context', 'area', 'project', 'tag'] as const satisfies readonly TaskGroupBy[];
export const REFERENCE_LIST_DEFAULT_GROUP_BY: TaskGroupBy = 'area';
export const DONE_LIST_DEFAULT_GROUP_BY: TaskGroupBy = 'none';

/** The Inbox's empty state offers voice capture when that is the default capture method. */
const inboxCapturesAudio = (settings: AppSettings | undefined) => settings?.gtd?.defaultCaptureMethod === 'audio';

/**
 * The screen's title and its empty state when nothing is filtered. Only the
 * Inbox's empty state has an action (capture); it reads the capture method.
 */
export function getStatusListScreenText(kind: StatusListKind, t: Translate, settings?: AppSettings): {
    title: string;
    emptyText: string;
    emptyHint: string;
    emptyActionLabel: string | null;
} {
    if (kind === 'inbox') {
        const audio = inboxCapturesAudio(settings);
        return {
            title: t('inbox.title'),
            emptyText: t('inbox.empty'),
            emptyHint: audio ? t('inbox.emptyAddHintVoice') : t('inbox.emptyAddHint'),
            emptyActionLabel: audio ? t('quickAdd.audioCaptureLabel') : t('nav.addTask'),
        };
    }
    return kind === 'reference'
        ? {
            title: tFallback(t, 'nav.reference', 'Reference'),
            emptyText: tFallback(t, 'reference.empty', 'Nothing filed yet'),
            emptyHint: tFallback(t, 'reference.emptyHint', 'Reference holds info you might want later — no action required.'),
            emptyActionLabel: null,
        }
        : {
            title: tFallback(t, 'nav.done', 'Done'),
            emptyText: tFallback(t, 'list.done', 'Done'),
            emptyHint: tFallback(t, 'done.emptyHint', 'Completed tasks land here — a running log of what you finished.'),
            emptyActionLabel: null,
        };
}

/**
 * The tasks the list can show before filters: its status, the selected areas, and
 * live projects. The Inbox stays global across area selections.
 */
export function selectStatusListTasks(input: {
    kind: StatusListKind;
    /** Store tasks (state.tasks). */
    tasks: readonly Task[];
    /** Store projects (state.projects). */
    projects: readonly Project[];
    /** Every project, archived and deleted included (state._allProjects). */
    allProjects: readonly Project[];
    resolvedAreaFilter: AreaFilterSelection;
    areaById: Map<string, Area>;
    /** Reference only: include references filed in archived projects. */
    includeArchivedProjects?: boolean;
}): Task[] {
    const projectById = new Map(input.projects.map((project) => [project.id, project]));
    if (input.kind === 'inbox') {
        return input.tasks.filter((task) => task.status === 'inbox' && isTaskVisibleInInbox(task, { projectById }));
    }
    const allProjectById = new Map(input.allProjects.map((project) => [project.id, project]));
    const areaProjectLookup = input.kind === 'reference' ? allProjectById : projectById;
    return input.tasks.filter((task) => {
        if (task.deletedAt) return false;
        if (input.kind === 'reference') {
            if (!isReferenceInVisibleProject(task, allProjectById, input.includeArchivedProjects === true)) return false;
        } else if (!isTaskInActiveProject(task, projectById)) {
            return false;
        }
        return taskMatchesAreaFilterSelection(task, input.resolvedAreaFilter, areaProjectLookup, input.areaById)
            && task.status === input.kind;
    });
}

export function buildStatusListFilterOptions(input: {
    kind: StatusListKind;
    /** selectStatusListTasks's result. */
    tasks: readonly Task[];
    allProjects: readonly Project[];
    settings: AppSettings | undefined;
    t: Translate;
    /** Done only: the screen offers time filters (both screens turn them off). The Inbox never does. */
    timeEstimateFilters?: boolean;
    /** False skips the token scan; mobile builds tokens only while its filter sheet is open. */
    withTokens?: boolean;
}): ListFilterOptions {
    const withTokens = input.withTokens !== false;
    if (input.kind === 'reference') {
        const projects = projectFilterOptions(input.tasks, input.allProjects, input.t);
        return {
            // Reference tags may be stored without a leading #; only the options are normalized.
            tokens: withTokens
                ? getUsedTaskTokens([...input.tasks], (task) => (task.tags ?? []).map((tag) => normalizeBulkTaskTokenInput(tag, 'tags')), { includeAncestors: true })
                : [],
            projects,
            timeEstimates: TIME_ESTIMATE_OPTIONS,
            visibility: { energyLevel: false, location: false, priority: false, timeEstimate: false },
            retainProjects: projects.map((project) => project.id),
            getProjectLabel: projectFilterLabel(input.allProjects, input.t),
        };
    }
    const features = resolveFeatureFlags(input.settings);
    return {
        tokens: withTokens ? getUsedTaskTokens([...input.tasks], (task) => [
            ...(task.contexts ?? []).map((token) => normalizeBulkTaskTokenInput(token, 'contexts')),
            ...(task.tags ?? []).map((token) => normalizeBulkTaskTokenInput(token, 'tags')),
        ], { includeAncestors: true }) : [],
        projects: null,
        timeEstimates: TIME_ESTIMATE_OPTIONS,
        visibility: getTaskMetadataFilterVisibility(input.tasks, {
            prioritiesEnabled: features.priorities,
            timeEstimatesEnabled: input.kind !== 'inbox' && input.timeEstimateFilters === true && features.timeEstimates,
        }),
    };
}

export type StatusListItem =
    | { type: 'section'; id: string; title: string; count: number; muted: boolean; collapsible: boolean; collapsed: boolean }
    | { type: 'task'; task: Task; groupId: string | null };

export type StatusListModel = {
    orderedTasks: Task[];
    items: StatusListItem[];
    sortBy: TaskSortBy;
    sortByLabel: string;
    sortTitle: string;
    /** The sorts the sort sheet lists, Time estimate only while that feature is on. */
    sortOptions: { value: TaskSortBy; label: string; selected: boolean }[];
    groupBy: TaskGroupBy;
    groupByLabel: string;
    groupTitle: string;
    groupOptions: { value: TaskGroupBy; label: string; selected: boolean }[];
};

export function buildStatusListModel(input: {
    kind: StatusListKind;
    /** selectStatusListTasks's result. */
    tasks: readonly Task[];
    /** Store projects (state.projects) and areas (state.areas). */
    projects: readonly Project[];
    areas: readonly Area[];
    settings: AppSettings | undefined;
    groupBy: TaskGroupBy;
    /** Done only: the device's chosen sort. */
    viewSortBy?: TaskSortBy;
    criteria: FilterCriteria;
    searchQuery: string;
    collapsedGroupIds: ReadonlySet<string>;
    t: Translate;
    now?: Date;
    /** Month titles in the completion-date grouping; see buildTaskGroupSections. */
    formatDate?: DateFormatter;
}): StatusListModel {
    const { kind, settings, t } = input;
    const isReference = kind === 'reference';
    const matchesReferenceSearch = createReferenceSearchPredicate(isReference ? input.searchQuery : '');
    const filterSelections = { criteria: input.criteria, searchQuery: isReference ? '' : input.searchQuery };
    const filtered = input.tasks.filter((task) => matchesReferenceSearch(task) && taskMatchesFilterSelections(task, filterSelections));
    const sortBy = kind === 'done'
        ? resolveDoneTaskSortBy(settings?.taskSortBy, input.viewSortBy, settings)
        : resolveNonDoneTaskSortBy(settings?.taskSortBy, settings);
    // Done is a log: its default order is completion date, newest first.
    const orderedTasks = kind === 'done' && sortBy === 'default'
        ? sortDoneTasksForListView(filtered)
        : sortTasksBy(filtered, sortBy);
    const projectById = new Map(input.projects.map((project) => [project.id, project]));
    const items: StatusListItem[] = input.groupBy !== 'none'
        ? buildTaskGroupSections({
            groupBy: input.groupBy,
            tasks: orderedTasks,
            areas: [...input.areas],
            projectById,
            t,
            now: input.now,
            collapsedGroupIds: input.collapsedGroupIds,
            formatDate: input.formatDate,
        }).map((item) => (item.type === 'section'
            ? { type: 'section', id: item.id, title: item.title, count: item.count, muted: item.muted === true, collapsible: item.collapsible === true, collapsed: item.collapsed === true }
            : { type: 'task', task: item.task, groupId: item.groupId ?? null }))
        : orderedTasks.map((task) => ({ type: 'task', task, groupId: null }));
    const groupOptions: readonly TaskGroupBy[] = kind === 'done' ? DONE_LIST_GROUP_OPTIONS : TASK_LIST_GROUP_OPTIONS;
    return {
        orderedTasks,
        items,
        sortBy,
        sortByLabel: getTaskSortByLabel(sortBy, t),
        sortTitle: t('sort.label'),
        sortOptions: getVisibleTaskSortOptions(kind === 'done' ? DONE_TASK_LIST_SORT_OPTIONS : TASK_LIST_SORT_OPTIONS, settings)
            .map((option) => ({ value: option, label: getTaskSortByLabel(option, t), selected: option === sortBy })),
        groupBy: input.groupBy,
        groupByLabel: getTaskGroupByLabel(input.groupBy, t),
        groupTitle: tFallback(t, 'list.groupBy', 'Group'),
        groupOptions: groupOptions.map((option) => ({ value: option, label: getTaskGroupByLabel(option, t), selected: option === input.groupBy })),
    };
}

export type StatusListChip = { id: string; label: string; excluded: boolean };

/**
 * The active filters as the list header and the empty state show them. Reference
 * adds a chip for archived projects; that toggle counts as a filter in the
 * header but not in the empty state's "no match" test.
 */
export function buildStatusListFilterSummary(input: {
    kind: StatusListKind | 'someday';
    chips: readonly StatusListChip[];
    activeCount: number;
    hasActive: boolean;
    includeArchivedProjects: boolean;
    /** The Inbox's unfiltered empty state reads the capture method. */
    settings?: AppSettings;
    t: Translate;
}): {
    chips: StatusListChip[];
    activeCount: number;
    hasActive: boolean;
    empty: { message: string; hint: string; actionLabel: string | null };
} {
    const { t } = input;
    const archived = input.kind === 'reference' && input.includeArchivedProjects;
    const chips = archived
        ? [...input.chips, { id: REFERENCE_ARCHIVED_CHIP_ID, label: t('reference.includeArchivedProjects'), excluded: false }]
        : [...input.chips];
    const text = input.kind === 'someday'
        ? { emptyText: t('someday.empty'), emptyHint: t('someday.emptyHint'), emptyActionLabel: null }
        : getStatusListScreenText(input.kind, t, input.settings);
    return {
        chips,
        activeCount: input.activeCount + (archived ? 1 : 0),
        hasActive: input.hasActive || archived,
        empty: input.hasActive
            ? {
                message: tFallback(t, 'filters.noMatch', 'No tasks match these filters.'),
                hint: chips.slice(0, 3).map((chip) => chip.label).join(', '),
                actionLabel: tFallback(t, 'filters.clear', 'Clear'),
            }
            : { message: text.emptyText || t('list.noTasks'), hint: text.emptyHint, actionLabel: text.emptyActionLabel },
    };
}

/**
 * The list header's labels, as mobile's TaskListHeader shows them: the Sort,
 * Group and Filters controls (inline on the Inbox, in the overflow menu
 * elsewhere), the active-filters count, and the chips with their Clear.
 */
export function getTaskListHeaderText(input: {
    sortByLabel: string;
    /** Undefined when the list offers no grouping. */
    groupByLabel?: string;
    hasActiveFilters: boolean;
    filterActiveCount: number;
    t: Translate;
}) {
    const { t } = input;
    const filters = tFallback(t, 'filters.label', 'Filters');
    const group = tFallback(t, 'list.groupBy', 'Group');
    const all = tFallback(t, 'common.all', 'All');
    const sort = t('sort.label');
    const removeFilter = tFallback(t, 'filters.remove', 'Remove filter');
    const excluded = tFallback(t, 'filters.excluded', 'Excluded');
    const groupValue = input.groupByLabel ?? all;
    return {
        filters,
        group,
        sort,
        more: tFallback(t, 'taskEdit.moreOptions', 'More options'),
        back: tFallback(t, 'common.back', 'Back'),
        close: tFallback(t, 'common.close', 'Close'),
        /** The chip row's last chip, which clears every filter. */
        clear: tFallback(t, 'filters.clear', t('common.clear')),
        /** The overflow layout's active-filters button. */
        activeFilters: `${filters} · ${input.filterActiveCount}`,
        sortAccessibilityLabel: `${sort}: ${input.sortByLabel}`,
        groupValue,
        groupAccessibilityLabel: `${group}: ${groupValue}`,
        filtersAccessibilityLabel: `${filters}: ${input.hasActiveFilters ? input.filterActiveCount : all}`,
        /** Tapping a chip removes its filter; an excluded token says so. */
        chipAccessibilityLabel: (chip: { label: string; excluded?: boolean }) => (chip.excluded
            ? `${removeFilter}: ${chip.label} (${excluded})`
            : `${removeFilter}: ${chip.label}`),
    };
}

/**
 * The Inbox screen's own parts around its list. `count` is the Inbox before the
 * user's filters (selectStatusListTasks), so filters never change the Process count.
 */
export function buildInboxScreenModel(input: { count: number; settings: AppSettings | undefined; t: Translate }): {
    title: string;
    /** The line above the rows: the Inbox is global across area selections. */
    scopeLabel: string;
    /** Process Inbox; null while the Inbox is empty. The label caps at 99+, the spoken label does not. */
    process: { label: string; accessibilityLabel: string; count: number } | null;
    /** A pill beside the list controls while there are tasks; the primary action when the Inbox is empty. */
    mindSweep: { label: string; placement: 'accessory' | 'primary' };
    /** The empty state's capture action starts recording when voice is the capture method. */
    autoRecord: boolean;
} {
    const { count, t } = input;
    const process = t('inbox.processButton');
    return {
        title: getStatusListScreenText('inbox', t).title,
        scopeLabel: t('projects.allAreas'),
        process: count > 0
            ? { label: `${process} (${count > 99 ? '99+' : count})`, accessibilityLabel: `${process} (${count})`, count }
            : null,
        mindSweep: { label: t('mindSweep.launchButton'), placement: count > 0 ? 'accessory' : 'primary' },
        autoRecord: inboxCapturesAudio(input.settings),
    };
}

export const REFERENCE_ARCHIVED_CHIP_ID = 'reference:include-archived-projects';

/** Mobile opens a task in an archived or deleted project read-only. */
export function isStatusListTaskReadOnly(task: Task, allProjects: readonly Project[]): boolean {
    if (!task.projectId) return false;
    const project = allProjects.find((candidate) => candidate.id === task.projectId);
    return Boolean(project?.deletedAt || project?.status === 'archived');
}
