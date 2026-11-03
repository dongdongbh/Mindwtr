import { PRESET_CONTEXTS, PRESET_TAGS } from './contexts';
import {
    getGlobalSearchFilterPresentation,
    type ComputeGlobalSearchResultsInput,
    type DuePreset,
    type GlobalSearchScope,
} from './global-search-filter';
import type { SearchResults, SearchTaskResult } from './storage';
import type { Area, SavedSearch, Task, TaskStatus } from './types';
import { formatI18nTemplate, tFallback, translateWithFallback } from './i18n';
import { hasTimeComponent } from './date';
import { isTaskCancelled, isTaskCompleted } from './task-status';
import { getTaskUrgency } from './task-utils';
import { parseSearchQuery } from './search';

export type GlobalSearchFilterState = Pick<ComputeGlobalSearchResultsInput,
    'includeCompleted' | 'includeReference' | 'hideFutureTasks' | 'selectedStatuses' | 'selectedArea'
    | 'selectedTokens' | 'locationQuery' | 'duePreset' | 'scope'>;

export const GLOBAL_SEARCH_STATUS_OPTIONS: TaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'done', 'reference', 'archived'];
export const GLOBAL_SEARCH_DUE_OPTIONS: DuePreset[] = ['any', 'overdue', 'today', 'tomorrow', 'this_week', 'next_week', 'none'];
export const GLOBAL_SEARCH_SCOPE_OPTIONS: GlobalSearchScope[] = ['all', 'projects', 'tasks', 'project_tasks'];

export const DEFAULT_GLOBAL_SEARCH_FILTERS: GlobalSearchFilterState = {
    includeCompleted: false,
    includeReference: true,
    hideFutureTasks: false,
    selectedStatuses: [],
    selectedArea: 'all',
    selectedTokens: [],
    locationQuery: '',
    duePreset: 'any',
    scope: 'all',
};

export const getGlobalSearchTokens = (tasks: Task[]): string[] => {
    const tokens = new Set<string>([...PRESET_CONTEXTS, ...PRESET_TAGS]);
    tasks.forEach((task) => {
        task.contexts?.forEach((context) => tokens.add(context));
        task.tags?.forEach((tag) => tokens.add(tag));
    });
    return Array.from(tokens).filter(Boolean).sort();
};

export const getGlobalSearchFilterOptions = (tasks: Task[], areas: Pick<Area, 'id' | 'name'>[], t: (key: string) => string) => {
    const presentation = getGlobalSearchFilterPresentation(t);
    return {
        presentation,
        statuses: GLOBAL_SEARCH_STATUS_OPTIONS.map((value) => ({ value, label: tFallback(t, `status.${value}`, value) })),
        due: GLOBAL_SEARCH_DUE_OPTIONS.map((value) => ({ value, label: presentation.due[value] })),
        scope: GLOBAL_SEARCH_SCOPE_OPTIONS.map((value) => ({ value, label: presentation.scope[value] })),
        areas: [
            { value: 'all', label: `${t('common.all')} ${tFallback(t, 'taskEdit.areaLabel', 'Area')}` },
            { value: 'none', label: tFallback(t, 'taskEdit.noAreaOption', 'No Area') },
            ...areas.map((area) => ({ value: area.id, label: area.name })),
        ],
        tokens: getGlobalSearchTokens(tasks),
        include: {
            label: tFallback(t, 'search.include.label', 'Include'),
            completed: t('search.includeCompleted'),
            reference: t('search.includeReference'),
            hideFutureTasks: translateWithFallback(t, 'filters.hideFutureTasks', 'Hide future tasks'),
        },
        location: {
            label: tFallback(t, 'taskEdit.locationLabel', 'Location'),
            placeholder: tFallback(t, 'taskEdit.locationPlaceholder', 'e.g. Office'),
        },
    };
};

export const getGlobalSearchActiveChips = (
    filters: GlobalSearchFilterState,
    areas: Pick<Area, 'id' | 'name'>[],
    t: (key: string) => string,
): { key: string; label: string }[] => {
    const presentation = getGlobalSearchFilterPresentation(t);
    const chips: { key: string; label: string }[] = filters.selectedStatuses.map((status) => ({
        key: `status:${status}`, label: tFallback(t, `status.${status}`, status),
    }));
    if (filters.selectedArea !== 'all') {
        const label = filters.selectedArea === 'none'
            ? t('taskEdit.noAreaOption')
            : (areas.find((area) => area.id === filters.selectedArea)?.name ?? filters.selectedArea);
        chips.push({ key: `area:${filters.selectedArea}`, label: `${t('taskEdit.areaLabel')}: ${label}` });
    }
    filters.selectedTokens.forEach((token) => chips.push({ key: `token:${token}`, label: token }));
    if (filters.locationQuery?.trim()) chips.push({
        key: 'location', label: `${t('taskEdit.locationLabel')}: ${filters.locationQuery.trim()}`,
    });
    if (filters.duePreset !== 'any') chips.push({
        key: `due:${filters.duePreset}`, label: `${presentation.sections.due}: ${presentation.due[filters.duePreset]}`,
    });
    if (filters.scope !== 'all') chips.push({ key: `scope:${filters.scope}`, label: presentation.scope[filters.scope] });
    if (filters.includeCompleted) chips.push({ key: 'includeCompleted', label: t('search.includeCompleted') });
    if (!filters.includeReference) chips.push({
        key: 'hideReference',
        label: `${translateWithFallback(t, 'filters.hide', 'Hide')}: ${tFallback(t, 'status.reference', 'Reference')}`,
    });
    if (filters.hideFutureTasks) chips.push({
        key: 'hideFutureTasks', label: translateWithFallback(t, 'filters.hideFutureTasks', 'Hide future tasks'),
    });
    return chips;
};

export const clearGlobalSearchActiveChip = (filters: GlobalSearchFilterState, key: string): GlobalSearchFilterState => {
    if (key.startsWith('status:')) return {
        ...filters, selectedStatuses: filters.selectedStatuses.filter((status) => status !== key.slice(7)),
    };
    if (key.startsWith('token:')) return {
        ...filters, selectedTokens: filters.selectedTokens.filter((token) => token !== key.slice(6)),
    };
    if (key.startsWith('area:')) return { ...filters, selectedArea: 'all' };
    if (key.startsWith('due:')) return { ...filters, duePreset: 'any' };
    if (key.startsWith('scope:')) return { ...filters, scope: 'all' };
    if (key === 'location') return { ...filters, locationQuery: '' };
    if (key === 'includeCompleted') return { ...filters, includeCompleted: false };
    if (key === 'hideReference') return { ...filters, includeReference: true };
    if (key === 'hideFutureTasks') return { ...filters, hideFutureTasks: false };
    return filters;
};


export const shouldRequestGlobalSearchFts = (query: string): boolean => query.length > 0
    && !/\b\w+:/i.test(query)
    && !parseSearchQuery(query).clauses.some((clause) => clause.terms.some((term) => term.field !== null || term.negated));

export const fetchGlobalSearchAdapterResults = async (
    query: string,
    searchAll?: (query: string) => Promise<SearchResults>,
): Promise<SearchResults | null> => {
    if (!shouldRequestGlobalSearchFts(query) || !searchAll) return null;
    try { return await searchAll(query); } catch { return null; }
};

export const getGlobalSearchTaskListTarget = (task: SearchTaskResult): { route: string; projectId: string | null } => {
    if (task.status === 'done') return { route: '/done', projectId: null };
    if (task.status === 'archived') return { route: '/archived', projectId: null };
    if (task.projectId) return { route: '/projects-screen', projectId: task.projectId };
    return { route: ({ inbox: '/inbox', next: '/focus', waiting: '/waiting', someday: '/someday', reference: '/reference' } as Record<string, string>)[task.status] ?? '/focus', projectId: null };
};

export const resolveSavedSearch = (savedSearches: SavedSearch[], query: string, name: string, id: string) => {
    const trimmedQuery = query.trim();
    const existing = savedSearches.find((search) => search.query === trimmedQuery);
    if (existing) return { search: existing, existing: true as const };
    return { search: { id, name: name.trim(), query: trimmedQuery }, existing: false as const };
};

export const getGlobalSearchResultDate = (
    task: Task | undefined,
    t: (key: string) => string,
    formatDate: (value: string, format: 'P' | 'Pp') => string,
): { tone: 'secondary' | 'warning' | 'danger'; label: string } | null => {
    if (!task) return null;
    if (isTaskCancelled(task)) return {
        tone: 'secondary',
        label: formatI18nTemplate(t('search.cancelledDate'), {
            date: formatDate(task.cancelledAt!, hasTimeComponent(task.cancelledAt) ? 'Pp' : 'P'),
        }),
    };
    if (isTaskCompleted(task)) {
        if (!task.completedAt) return null;
        return {
            tone: 'secondary',
            label: formatI18nTemplate(t('search.completedDate'), {
                date: formatDate(task.completedAt, hasTimeComponent(task.completedAt) ? 'Pp' : 'P'),
            }),
        };
    }
    if (!task.dueDate) return null;
    const urgency = getTaskUrgency(task);
    return {
        tone: urgency === 'overdue' ? 'danger' : urgency === 'urgent' || urgency === 'upcoming' ? 'warning' : 'secondary',
        label: formatI18nTemplate(t('search.dueDate'), {
            date: formatDate(task.dueDate!, hasTimeComponent(task.dueDate) ? 'Pp' : 'P'),
        }),
    };
};
