import { getWeekStartsOnIndex, safeParseDueDate } from './date';
import { matchesHierarchicalToken } from './hierarchy-utils';
import { parseSearchQuery, searchAll } from './search';
import { SEARCH_RESULT_LIMIT, type SearchProjectResult, type SearchResults, type SearchTaskResult } from './storage';
import { shouldShowTaskForStart } from './task-utils';
import { isTaskFinished } from './task-status';
import type { Project, Task, TaskStatus } from './types';

export type GlobalSearchScope = 'all' | 'projects' | 'tasks' | 'project_tasks';
export type DuePreset = 'any' | 'none' | 'overdue' | 'today' | 'tomorrow' | 'this_week' | 'next_week';

export type GlobalSearchFilterPresentation = {
    sections: {
        status: string;
        scope: string;
        area: string;
        due: string;
        tokens: string;
    };
    scope: Record<GlobalSearchScope, string>;
    due: Record<DuePreset, string>;
    clear: string;
};

/** Shared, exhaustive filter vocabulary for desktop and mobile search. */
export function getGlobalSearchFilterPresentation(
    t: (key: string) => string,
): GlobalSearchFilterPresentation {
    const translated = (key: string, fallback: string) => {
        const value = t(key);
        return value && value !== key ? value : fallback;
    };
    const scope = {
        all: translated('search.scope.all', 'All'),
        projects: translated('search.scope.projects', 'Projects only'),
        tasks: translated('search.scope.tasks', 'Tasks only'),
        project_tasks: translated('search.scope.projectTasks', 'Tasks in projects'),
    } satisfies Record<GlobalSearchScope, string>;
    const due = {
        any: translated('search.due.any', 'Any'),
        overdue: translated('search.due.overdue', 'Overdue'),
        today: translated('search.due.today', 'Today'),
        tomorrow: translated('search.due.tomorrow', 'Tomorrow'),
        this_week: translated('search.due.thisWeek', 'This week'),
        next_week: translated('search.due.nextWeek', 'Next week'),
        none: translated('search.due.none', 'No due date'),
    } satisfies Record<DuePreset, string>;

    return {
        sections: {
            status: translated('taskEdit.statusLabel', 'Status'),
            scope: translated('search.scope.label', 'Scope'),
            area: translated('taskEdit.areaLabel', 'Area'),
            due: translated('search.due.label', 'Due date'),
            tokens: translated('filters.contexts', 'Contexts & tags'),
        },
        scope,
        due,
        clear: translated('filters.clear', 'Clear'),
    };
}

export type ComputeGlobalSearchResultsInput = {
    query: string;
    tasks: Task[];
    projects: Project[];
    areas: Array<{ id: string }>;
    includeCompleted: boolean;
    includeReference: boolean;
    hideFutureTasks: boolean;
    selectedStatuses: TaskStatus[];
    selectedArea: string;
    selectedTokens: string[];
    locationQuery?: string;
    duePreset: DuePreset;
    scope: GlobalSearchScope;
    /** Raw or normalized week-start setting; resolved via getWeekStartsOnIndex. */
    weekStart?: string | null;
    ftsResults?: SearchResults | null;
    /**
     * The query string the ftsResults were fetched for. FTS answers arrive
     * debounced and async, so while the user is typing they describe an OLDER
     * query; merging them in front of the fresh in-memory results made the
     * list reshuffle on every keystroke. When provided and different from
     * `query`, ftsResults are ignored until a matching answer arrives.
     */
    ftsQuery?: string | null;
};

const buildDueMatcher = (duePreset: DuePreset, weekStart: number) => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(startOfToday);
    const weekday = startOfWeek.getDay();
    const diffToWeekStart = (weekday - weekStart + 7) % 7;
    startOfWeek.setDate(startOfWeek.getDate() - diffToWeekStart);
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(endOfWeek.getDate() + 7);
    const nextWeekStart = new Date(endOfWeek);
    const nextWeekEnd = new Date(nextWeekStart);
    nextWeekEnd.setDate(nextWeekStart.getDate() + 7);

    return (task: SearchTaskResult) => {
        if (duePreset === 'any') return true;
        if (duePreset === 'none') return !task.dueDate;
        if (!task.dueDate) return false;
        const due = safeParseDueDate(task.dueDate);
        if (!due) return false;
        if (duePreset === 'overdue') return due < startOfToday;
        if (duePreset === 'today') return due >= startOfToday && due < new Date(startOfToday.getTime() + 86400000);
        if (duePreset === 'tomorrow') {
            const tomorrow = new Date(startOfToday.getTime() + 86400000);
            const nextDay = new Date(startOfToday.getTime() + 2 * 86400000);
            return due >= tomorrow && due < nextDay;
        }
        if (duePreset === 'this_week') return due >= startOfWeek && due < endOfWeek;
        if (duePreset === 'next_week') return due >= nextWeekStart && due < nextWeekEnd;
        return true;
    };
};

const hasPositiveTaskIdLookup = (query: string) => {
    const ast = parseSearchQuery(query);
    return ast.clauses.some((clause) =>
        clause.terms.some((term) => term.field === 'id' && !term.negated && term.value.trim().length > 0)
    );
};

/**
 * Merge policy: full-text results are UNIONED with the in-memory fallback, not
 * substituted for it. FTS wins ordering (its hits come first) but can miss what
 * the in-memory matcher finds - field terms, hierarchical tokens, and rows
 * written since the last index update - so replacing it would silently drop
 * real matches. `limited`/`limit` propagate from either source so the "200+"
 * label stays honest about a truncated source.
 */
const mergeSearchResults = (ftsResults: SearchResults, fallbackResults: SearchResults): SearchResults => {
    const seenTaskIds = new Set(ftsResults.tasks.map((task) => task.id));
    const seenProjectIds = new Set(ftsResults.projects.map((project) => project.id));
    const limited = ftsResults.limited === true || fallbackResults.limited === true;
    const limit = ftsResults.limit ?? fallbackResults.limit;
    return {
        tasks: [...ftsResults.tasks, ...fallbackResults.tasks.filter((task) => !seenTaskIds.has(task.id))],
        projects: [
            ...ftsResults.projects,
            ...fallbackResults.projects.filter((project) => !seenProjectIds.has(project.id)),
        ],
        limited: limited || undefined,
        limit: limited ? limit : undefined,
    };
};

/**
 * The single global-search pipeline for every platform: takes already-fetched
 * FTS results plus the raw collections and filter state, returns the rendered
 * result list. Pure - no storage adapter, no React, no platform imports.
 */
export const computeGlobalSearchResults = ({
    query,
    tasks,
    projects,
    areas,
    includeCompleted,
    includeReference,
    hideFutureTasks,
    selectedStatuses,
    selectedArea,
    selectedTokens,
    locationQuery = '',
    duePreset,
    scope,
    weekStart,
    ftsResults,
    ftsQuery,
}: ComputeGlobalSearchResultsInput) => {
    const trimmedQuery = query.trim();
    const hasTaskOnlyFilters = (
        selectedStatuses.length > 0
        || selectedTokens.length > 0
        || locationQuery.trim().length > 0
        || duePreset !== 'any'
        || !includeReference
        || hideFutureTasks
    );
    const hasActiveFilters = (
        hasTaskOnlyFilters
        || selectedArea !== 'all'
        || scope !== 'all'
        || includeCompleted
    );
    const hasActiveSearch = trimmedQuery !== '' || hasActiveFilters;
    const filterOnlyResults: SearchResults = hasActiveFilters
        ? {
            tasks: tasks.filter((task) => !task.deletedAt),
            projects: hasTaskOnlyFilters
                ? []
                : projects.filter((project) => !project.deletedAt),
        }
        : { tasks: [], projects: [] };
    const fallbackResults = trimmedQuery === ''
        ? filterOnlyResults
        : searchAll(tasks, projects, trimmedQuery);
    const ftsResultsAreCurrent = ftsQuery === undefined || ftsQuery === null || ftsQuery.trim() === trimmedQuery;
    const effectiveResults = trimmedQuery !== ''
        && ftsResults
        && ftsResultsAreCurrent
        && (ftsResults.tasks.length + ftsResults.projects.length) > 0
        ? mergeSearchResults(ftsResults, fallbackResults)
        : fallbackResults;

    const hasStatusFilter = selectedStatuses.length > 0;
    const shouldBypassDefaultStatusHiding = hasPositiveTaskIdLookup(trimmedQuery);
    const normalizedLocationQuery = locationQuery.trim().toLowerCase();
    const projectById = new Map(projects.map((project) => [project.id, project]));
    const areaById = new Map(areas.map((area) => [area.id, area]));

    const matchesArea = (areaId?: string | null) => {
        // An id pointing at a deleted area belongs in the "No area" bucket.
        const normalized = areaId && areaById.has(areaId) ? areaId : null;
        if (selectedArea === 'all') return true;
        if (selectedArea === 'none') return !normalized;
        return normalized === selectedArea;
    };

    const matchesTaskArea = (task: SearchTaskResult) => {
        const areaId = task.projectId
            ? projectById.get(task.projectId)?.areaId ?? null
            : task.areaId ?? null;
        return matchesArea(areaId);
    };

    const matchesTokens = (task: SearchTaskResult) => {
        if (selectedTokens.length === 0) return true;
        const taskTokens = [...(task.contexts || []), ...(task.tags || [])];
        return selectedTokens.every((token) =>
            taskTokens.some((taskToken) => matchesHierarchicalToken(token, taskToken))
        );
    };
    const matchesLocation = (task: SearchTaskResult) => {
        if (!normalizedLocationQuery) return true;
        return String(task.location ?? '').toLowerCase().includes(normalizedLocationQuery);
    };

    const matchesDue = buildDueMatcher(duePreset, getWeekStartsOnIndex(weekStart));

    const passesNonStatusTaskFilters = (task: SearchTaskResult) => {
        if (!shouldShowTaskForStart(task, { showFutureStarts: !hideFutureTasks, granularity: 'time' })) return false;
        if (scope === 'project_tasks' && !task.projectId) return false;
        if (!matchesTaskArea(task)) return false;
        if (!matchesTokens(task)) return false;
        if (!matchesLocation(task)) return false;
        if (!matchesDue(task)) return false;
        return true;
    };

    const filteredTasks = effectiveResults.tasks.filter((task) => {
        if (hasStatusFilter) {
            if (!selectedStatuses.includes(task.status)) return false;
        } else {
            // A positive `id:` term is an unambiguous request for one task, so it
            // outranks the default done/archived/reference hiding.
            if (!shouldBypassDefaultStatusHiding && !includeCompleted && isTaskFinished(task)) return false;
            if (!shouldBypassDefaultStatusHiding && !includeReference && task.status === 'reference') return false;
        }
        return passesNonStatusTaskFilters(task);
    });

    const filteredProjects = effectiveResults.projects.filter((project: SearchProjectResult) => {
        if (normalizedLocationQuery) return false;
        if (!includeCompleted && project.status === 'archived') return false;
        if (!matchesArea(project.areaId ?? null)) return false;
        return true;
    });

    // Matches that only the default done/archived exclusion is hiding. Surfacing
    // them keeps the search honest: a completed task must stay findable (#806).
    const hiddenCompletedTaskCount = !hasStatusFilter
        && !includeCompleted
        && !shouldBypassDefaultStatusHiding
        && scope !== 'projects'
        ? effectiveResults.tasks.filter((task) =>
            isTaskFinished(task) && passesNonStatusTaskFilters(task)
        ).length
        : 0;
    const hiddenArchivedProjectCount = !includeCompleted
        && scope !== 'tasks'
        && scope !== 'project_tasks'
        && !normalizedLocationQuery
        ? effectiveResults.projects.filter(
            (project) => project.status === 'archived' && matchesArea(project.areaId ?? null)
        ).length
        : 0;

    const scopedProjects = scope === 'tasks' || scope === 'project_tasks' ? [] : filteredProjects;
    const scopedTasks = scope === 'projects' ? [] : filteredTasks;
    const totalResults = scopedProjects.length + scopedTasks.length;
    const sourceLimited = effectiveResults.limited === true;
    const sourceLimit = effectiveResults.limit ?? SEARCH_RESULT_LIMIT;
    const results = !hasActiveSearch ? [] : [
        ...scopedProjects.map((project) => ({ type: 'project' as const, item: project })),
        ...scopedTasks.map((task) => ({ type: 'task' as const, item: task })),
    ].slice(0, 50);
    const isTruncated = totalResults > results.length || sourceLimited;

    return {
        totalResults,
        totalResultsLabel: sourceLimited ? `${sourceLimit}+` : String(totalResults),
        results,
        isTruncated,
        hasActiveSearch,
        hasActiveFilters,
        hiddenCompletedCount: hiddenCompletedTaskCount + hiddenArchivedProjectCount,
    };
};
