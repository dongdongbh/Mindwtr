import {
    endOfDay,
    endOfMonth,
    endOfWeek,
    isAfter,
    isBefore,
    isEqual,
    startOfDay,
    startOfMonth,
    startOfWeek,
} from 'date-fns';

import { TIME_ESTIMATE_OPTIONS, timeEstimateToFilterBucket, timeEstimateToMinutes } from './calendar-scheduling';
import type { BulkTaskTokenField } from './bulk-task-tokens';
import { normalizeBulkTaskTokenInput } from './bulk-task-tokens';
import { safeParseDate, safeParseDueDate } from './date';
import { matchesHierarchicalToken, normalizePrefixedToken } from './hierarchy-utils';
import { logInfo } from './logger';
import type {
    DateRange,
    FilterCriteria,
    FilterPriority,
    FocusGroupBy,
    MultiValueFilterMatchMode,
    Project,
    SavedFilter,
    SavedFilterView,
    SortField,
    Task,
    TaskEnergyLevel,
    TaskPriority,
    TaskStatus,
    TimeEstimate,
} from './types';

export const SAVED_FILTER_NO_PROJECT_ID = '__no_project__';

type ApplyFilterOptions = {
    now?: Date;
    projects?: Project[];
    tokenMatchMode?: 'any' | 'all';
    weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
};

const TASK_STATUS_VALUES = new Set<TaskStatus>(['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived']);
const FILTER_PRIORITY_VALUES = new Set<FilterPriority>(['none', 'low', 'medium', 'high', 'urgent']);
const TASK_ENERGY_VALUES = new Set<TaskEnergyLevel>(['low', 'medium', 'high']);
const TIME_ESTIMATE_VALUES = new Set<TimeEstimate>(TIME_ESTIMATE_OPTIONS);
const MULTI_VALUE_FILTER_MATCH_MODE_VALUES = new Set<MultiValueFilterMatchMode>(['any', 'all']);
const SAVED_FILTER_VIEW_VALUES = new Set<SavedFilterView>(['focus', 'next', 'waiting', 'someday', 'contexts', 'all']);
const FOCUS_GROUP_BY_VALUES = new Set<FocusGroupBy>(['none', 'context', 'project', 'area', 'energy', 'priority', 'person', 'tag']);
const SORT_FIELD_VALUES = new Set<SortField>([
    'default',
    'due',
    'start',
    'review',
    'title',
    'created',
    'created-desc',
    'priority',
    'energy',
    'timeEstimate',
    'project',
    'updated',
]);
const DATE_PRESET_VALUES = new Set(['today', 'this_week', 'this_month', 'overdue', 'no_date']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const normalizeStringArray = (value: unknown, options?: { lowercase?: boolean; prefix?: '@' | '#' }): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const seen = new Set<string>();
    const next: string[] = [];
    for (const item of value) {
        if (typeof item !== 'string') continue;
        const trimmed = item.trim();
        if (!trimmed) continue;
        const normalized = options?.prefix
            ? normalizePrefixedToken(trimmed, options.prefix)
            : options?.lowercase
                ? trimmed.toLowerCase()
                : trimmed;
        const key = normalized.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(normalized);
    }
    return next.length > 0 ? next : undefined;
};

// Drop from `tokens` any entry that also appears (case-insensitively) in
// `remove`. Used so an exclude token never coexists with the same include.
const subtractTokens = (tokens: string[] | undefined, remove: string[] | undefined): string[] | undefined => {
    if (!tokens) return undefined;
    if (!remove || remove.length === 0) return tokens;
    const removeKeys = new Set(remove.map((token) => token.toLowerCase()));
    const next = tokens.filter((token) => !removeKeys.has(token.toLowerCase()));
    return next.length > 0 ? next : undefined;
};

const normalizeEnumArray = <T extends string>(value: unknown, allowed: Set<T>): T[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const seen = new Set<T>();
    const next: T[] = [];
    for (const item of value) {
        if (typeof item !== 'string') continue;
        if (!allowed.has(item as T)) continue;
        const normalized = item as T;
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        next.push(normalized);
    }
    return next.length > 0 ? next : undefined;
};

const normalizeMultiValueFilterMatchMode = (value: unknown): MultiValueFilterMatchMode | undefined => (
    typeof value === 'string' && MULTI_VALUE_FILTER_MATCH_MODE_VALUES.has(value as MultiValueFilterMatchMode)
        ? value as MultiValueFilterMatchMode
        : undefined
);

export function normalizeDateRange(value: unknown): DateRange | undefined {
    if (!isRecord(value)) return undefined;
    if (typeof value.preset === 'string' && DATE_PRESET_VALUES.has(value.preset)) {
        return { preset: value.preset as 'today' | 'this_week' | 'this_month' | 'overdue' | 'no_date' };
    }
    const from = typeof value.from === 'string' && value.from.trim() ? value.from.trim() : undefined;
    const to = typeof value.to === 'string' && value.to.trim() ? value.to.trim() : undefined;
    return from || to ? { from, to } : undefined;
}

export function normalizeFilterCriteria(value: unknown): FilterCriteria {
    if (!isRecord(value)) return {};
    const criteria: FilterCriteria = {};

    const contexts = normalizeStringArray(value.contexts, { prefix: '@' });
    const areas = normalizeStringArray(value.areas);
    const projects = normalizeStringArray(value.projects);
    const tags = normalizeStringArray(value.tags, { prefix: '#' });
    // Exclude lists never override an include of the same token: a token on
    // both sides would filter every task out, so include wins and the token
    // drops from the exclude side.
    const excludedContexts = subtractTokens(normalizeStringArray(value.excludedContexts, { prefix: '@' }), contexts);
    const excludedTags = subtractTokens(normalizeStringArray(value.excludedTags, { prefix: '#' }), tags);
    const energy = normalizeEnumArray(value.energy, TASK_ENERGY_VALUES);
    const priority = normalizeEnumArray(value.priority, FILTER_PRIORITY_VALUES);
    const statuses = normalizeEnumArray(value.statuses, TASK_STATUS_VALUES);
    const assignedTo = normalizeStringArray(value.assignedTo);
    const locations = normalizeStringArray(value.locations);
    const timeEstimates = normalizeEnumArray(value.timeEstimates, TIME_ESTIMATE_VALUES);

    if (contexts) criteria.contexts = contexts;
    const contextMatchMode = normalizeMultiValueFilterMatchMode(value.contextMatchMode);
    if (contexts && contextMatchMode) criteria.contextMatchMode = contextMatchMode;
    if (excludedContexts) criteria.excludedContexts = excludedContexts;
    if (areas) criteria.areas = areas;
    if (projects) criteria.projects = projects;
    if (tags) criteria.tags = tags;
    const tagMatchMode = normalizeMultiValueFilterMatchMode(value.tagMatchMode);
    if (tags && tagMatchMode) criteria.tagMatchMode = tagMatchMode;
    if (excludedTags) criteria.excludedTags = excludedTags;
    if (energy) criteria.energy = energy;
    if (priority) criteria.priority = priority;
    if (statuses) criteria.statuses = statuses;
    if (assignedTo) criteria.assignedTo = assignedTo;
    if (locations) criteria.locations = locations;
    if (timeEstimates) criteria.timeEstimates = timeEstimates;

    const dueDateRange = normalizeDateRange(value.dueDateRange);
    const startDateRange = normalizeDateRange(value.startDateRange);
    if (dueDateRange) criteria.dueDateRange = dueDateRange;
    if (startDateRange) criteria.startDateRange = startDateRange;

    if (isRecord(value.timeEstimateRange)) {
        const min = typeof value.timeEstimateRange.min === 'number' && Number.isFinite(value.timeEstimateRange.min)
            ? Math.max(0, Math.floor(value.timeEstimateRange.min))
            : undefined;
        const max = typeof value.timeEstimateRange.max === 'number' && Number.isFinite(value.timeEstimateRange.max)
            ? Math.max(0, Math.floor(value.timeEstimateRange.max))
            : undefined;
        if (min !== undefined || max !== undefined) {
            criteria.timeEstimateRange = { min, max };
        }
    }

    if (typeof value.hasDescription === 'boolean') criteria.hasDescription = value.hasDescription;
    if (typeof value.isStarred === 'boolean') criteria.isStarred = value.isStarred;

    return criteria;
}

export function hasActiveFilterCriteria(criteria: FilterCriteria | undefined): boolean {
    if (!criteria) return false;
    const normalized = normalizeFilterCriteria(criteria);
    return Boolean(
        normalized.contexts?.length
        || normalized.excludedContexts?.length
        || normalized.areas?.length
        || normalized.projects?.length
        || normalized.tags?.length
        || normalized.excludedTags?.length
        || normalized.energy?.length
        || normalized.priority?.length
        || normalized.dueDateRange
        || normalized.startDateRange
        || normalized.statuses?.length
        || normalized.assignedTo?.length
        || normalized.locations?.length
        || normalized.timeEstimateRange
        || normalized.timeEstimates?.length
        || normalized.hasDescription !== undefined
        || normalized.isStarred !== undefined
    );
}

// `selected` (the filter criteria) is already prefix-normalized by
// normalizeFilterCriteria. A task's own contexts/tags can still hold a bare
// token saved before #1013's draft-save fix, so `actual` gets the same
// normalization here — otherwise a selected "@home" chip never matches a
// stored bare "home", even though both mean the same context.
const matchesAnyToken = (
    selected: readonly string[] | undefined,
    actual: readonly string[] | undefined,
    field: BulkTaskTokenField
): boolean => {
    if (!selected || selected.length === 0) return true;
    const actualValues = (actual ?? []).map((token) => normalizeBulkTaskTokenInput(token, field));
    return selected.some((selectedToken) =>
        actualValues.some((actualToken) => matchesHierarchicalToken(selectedToken, actualToken))
    );
};

const matchesAllTokens = (
    selected: readonly string[] | undefined,
    actual: readonly string[] | undefined,
    field: BulkTaskTokenField
): boolean => {
    if (!selected || selected.length === 0) return true;
    const actualValues = (actual ?? []).map((token) => normalizeBulkTaskTokenInput(token, field));
    return selected.every((selectedToken) =>
        actualValues.some((actualToken) => matchesHierarchicalToken(selectedToken, actualToken))
    );
};

const matchesTokens = (
    selected: readonly string[] | undefined,
    actual: readonly string[] | undefined,
    field: BulkTaskTokenField,
    mode: ApplyFilterOptions['tokenMatchMode'] = 'any'
): boolean => (
    mode === 'all'
        ? matchesAllTokens(selected, actual, field)
        : matchesAnyToken(selected, actual, field)
);

const matchesDateRange = (
    value: string | undefined,
    range: DateRange | undefined,
    parser: (input: string | undefined) => Date | null,
    options: Required<Pick<ApplyFilterOptions, 'now' | 'weekStartsOn'>>
): boolean => {
    if (!range) return true;
    if ('preset' in range && range.preset === 'no_date') {
        return !value;
    }
    if (!value) return false;
    const date = parser(value);
    if (!date) return false;

    if ('preset' in range) {
        const todayStart = startOfDay(options.now);
        switch (range.preset) {
            case 'today': {
                const todayEnd = endOfDay(options.now);
                return (isAfter(date, todayStart) || isEqual(date, todayStart))
                    && (isBefore(date, todayEnd) || isEqual(date, todayEnd));
            }
            case 'this_week': {
                const start = startOfWeek(options.now, { weekStartsOn: options.weekStartsOn });
                const end = endOfWeek(options.now, { weekStartsOn: options.weekStartsOn });
                return (isAfter(date, start) || isEqual(date, start))
                    && (isBefore(date, end) || isEqual(date, end));
            }
            case 'this_month': {
                const start = startOfMonth(options.now);
                const end = endOfMonth(options.now);
                return (isAfter(date, start) || isEqual(date, start))
                    && (isBefore(date, end) || isEqual(date, end));
            }
            case 'overdue':
                return isBefore(date, todayStart);
            case 'no_date':
                return false;
            default:
                return true;
        }
    }

    const from = range.from ? safeParseDate(range.from) : null;
    const to = range.to ? safeParseDate(range.to) : null;
    if (from) {
        const fromStart = startOfDay(from);
        if (isBefore(date, fromStart) && !isEqual(date, fromStart)) return false;
    }
    if (to) {
        const toEnd = endOfDay(to);
        if (isAfter(date, toEnd) && !isEqual(date, toEnd)) return false;
    }
    return true;
};

const matchesAssignedTo = (selected: readonly string[] | undefined, assignedTo: string | undefined): boolean => {
    if (!selected || selected.length === 0) return true;
    const normalized = assignedTo?.trim().toLowerCase();
    if (!normalized) return false;
    return selected.some((item) => item.trim().toLowerCase() === normalized);
};

const matchesLocation = (selected: readonly string[] | undefined, location: string | undefined): boolean => {
    if (!selected || selected.length === 0) return true;
    const normalized = location?.trim().toLowerCase();
    if (!normalized) return false;
    return selected.some((item) => normalized.includes(item.trim().toLowerCase()));
};

const matchesPriority = (selected: readonly FilterPriority[] | undefined, priority: TaskPriority | undefined): boolean => {
    if (!selected || selected.length === 0) return true;
    return selected.some((item) => item === 'none' ? !priority : priority === item);
};

const matchesTimeEstimateRange = (
    range: FilterCriteria['timeEstimateRange'],
    estimate: TimeEstimate | undefined
): boolean => {
    if (!range) return true;
    if (!estimate) return false;
    const minutes = timeEstimateToMinutes(estimate);
    if (range.min !== undefined && minutes < range.min) return false;
    if (range.max !== undefined && minutes > range.max) return false;
    return true;
};

type PreparedFilterContext = {
    normalized: FilterCriteria;
    projectById?: Map<string, Project>;
    now: Date;
    tokenMatchMode: 'any' | 'all';
    contextMatchMode: 'any' | 'all';
    tagMatchMode: 'any' | 'all';
    weekStartsOn: 0 | 1 | 2 | 3 | 4 | 5 | 6;
};

const prepareFilterContext = (
    criteria: FilterCriteria | undefined,
    options: ApplyFilterOptions = {}
): PreparedFilterContext => {
    const normalized = normalizeFilterCriteria(criteria);
    const tokenMatchMode = options.tokenMatchMode ?? 'any';
    return {
        normalized,
        projectById: options.projects ? new Map(options.projects.map((project) => [project.id, project])) : undefined,
        now: options.now ?? new Date(),
        tokenMatchMode,
        contextMatchMode: normalized.contextMatchMode ?? tokenMatchMode,
        tagMatchMode: normalized.tagMatchMode ?? tokenMatchMode,
        weekStartsOn: options.weekStartsOn ?? 1,
    };
};

const taskMatchesPreparedFilterCriteria = (
    task: Task,
    context: PreparedFilterContext
): boolean => {
    if (task.deletedAt) return false;
    const { normalized, projectById, now, contextMatchMode, tagMatchMode, weekStartsOn } = context;

    if (normalized.statuses?.length && !normalized.statuses.includes(task.status)) return false;
    if (!matchesTokens(normalized.contexts, task.contexts, 'contexts', contextMatchMode)) return false;
    if (!matchesTokens(normalized.tags, task.tags, 'tags', tagMatchMode)) return false;
    // Excluded tokens always subtract: a task carrying ANY excluded context/tag
    // (hierarchical) is filtered out, independent of the include match modes.
    if (normalized.excludedContexts?.length && matchesAnyToken(normalized.excludedContexts, task.contexts, 'contexts')) return false;
    if (normalized.excludedTags?.length && matchesAnyToken(normalized.excludedTags, task.tags, 'tags')) return false;

    if (normalized.areas?.length) {
        const projectAreaId = task.projectId ? projectById?.get(task.projectId)?.areaId : undefined;
        const taskAreaId = task.areaId ?? projectAreaId;
        if (!taskAreaId || !normalized.areas.includes(taskAreaId)) return false;
    }

    if (normalized.projects?.length) {
        const matchesProject = normalized.projects.some((projectId) => (
            projectId === SAVED_FILTER_NO_PROJECT_ID ? !task.projectId : task.projectId === projectId
        ));
        if (!matchesProject) return false;
    }

    if (normalized.energy?.length && (!task.energyLevel || !normalized.energy.includes(task.energyLevel))) return false;
    if (!matchesPriority(normalized.priority, task.priority)) return false;
    if (!matchesDateRange(task.dueDate, normalized.dueDateRange, safeParseDueDate, { now, weekStartsOn })) return false;
    if (!matchesDateRange(task.startTime, normalized.startDateRange, safeParseDate, { now, weekStartsOn })) return false;
    if (!matchesAssignedTo(normalized.assignedTo, task.assignedTo)) return false;
    if (!matchesLocation(normalized.locations, task.location)) return false;
    if (normalized.timeEstimates?.length) {
        const bucket = timeEstimateToFilterBucket(task.timeEstimate);
        if (!bucket || !normalized.timeEstimates.includes(bucket)) return false;
    }
    if (!matchesTimeEstimateRange(normalized.timeEstimateRange, task.timeEstimate)) return false;
    if (normalized.hasDescription !== undefined) {
        const hasDescription = Boolean(task.description?.trim());
        if (hasDescription !== normalized.hasDescription) return false;
    }
    if (normalized.isStarred !== undefined && Boolean(task.isFocusedToday) !== normalized.isStarred) return false;

    return true;
};

export function taskMatchesFilterCriteria(
    task: Task,
    criteria: FilterCriteria | undefined,
    options: ApplyFilterOptions = {}
): boolean {
    return taskMatchesPreparedFilterCriteria(task, prepareFilterContext(criteria, options));
}

export function createTaskFilterPredicate(
    criteria: FilterCriteria | undefined,
    options: ApplyFilterOptions = {}
): (task: Task) => boolean {
    const context = prepareFilterContext(criteria, options);
    return (task: Task) => taskMatchesPreparedFilterCriteria(task, context);
}

/**
 * True when the normalized criteria ask for nothing. `normalizeFilterCriteria`
 * only ever writes a key it means — no key is set to `undefined` or to an empty
 * array, and the two match-mode keys ride along with the tokens they belong to
 * — so an empty object is exactly "no criterion". A criterion added there later
 * shows up here as a key and takes the full path, which is the safe direction.
 */
const hasNoCriteria = (context: PreparedFilterContext): boolean => (
    Object.keys(context.normalized).length === 0
);

export function applyFilter<T extends Task>(
    tasks: readonly T[],
    criteria: FilterCriteria | undefined,
    options: ApplyFilterOptions = {}
): T[] {
    const context = prepareFilterContext(criteria, options);
    // With no criteria, every one of the ~20 checks below passes and only the
    // deleted-task rule is left, so run that rule alone. This is the common
    // case, not a corner: Focus narrows four pools through here on every
    // derivation and the screen has no saved filter until the user picks one.
    // On an engine without a JIT those four passes were the single largest
    // cost in the whole derivation.
    if (hasNoCriteria(context)) return tasks.filter((task) => !task.deletedAt);
    return tasks.filter((task) => taskMatchesPreparedFilterCriteria(task, context));
}

export function normalizeSavedFilter(value: unknown): SavedFilter | null {
    if (!isRecord(value)) return null;
    if (typeof value.id !== 'string' || !value.id.trim()) return null;
    if (typeof value.name !== 'string' || !value.name.trim()) return null;
    const view = typeof value.view === 'string' && SAVED_FILTER_VIEW_VALUES.has(value.view as SavedFilterView)
        ? value.view as SavedFilterView
        : 'focus';
    const createdAt = typeof value.createdAt === 'string' && value.createdAt.trim() ? value.createdAt : new Date().toISOString();
    const updatedAt = typeof value.updatedAt === 'string' && value.updatedAt.trim() ? value.updatedAt : createdAt;
    const sortBy = typeof value.sortBy === 'string' && SORT_FIELD_VALUES.has(value.sortBy as SortField)
        ? value.sortBy as SortField
        : undefined;
    const sortOrder = value.sortOrder === 'asc' || value.sortOrder === 'desc' ? value.sortOrder : undefined;
    const groupBy = typeof value.groupBy === 'string' && FOCUS_GROUP_BY_VALUES.has(value.groupBy as FocusGroupBy)
        ? value.groupBy as FocusGroupBy
        : undefined;
    const icon = typeof value.icon === 'string' && value.icon.trim() ? value.icon.trim() : undefined;
    const deletedAt = typeof value.deletedAt === 'string' && value.deletedAt.trim() ? value.deletedAt.trim() : undefined;

    return {
        id: value.id.trim(),
        name: value.name.trim(),
        ...(icon ? { icon } : {}),
        view,
        criteria: normalizeFilterCriteria(value.criteria),
        ...(sortBy ? { sortBy } : {}),
        ...(sortOrder ? { sortOrder } : {}),
        ...(groupBy ? { groupBy } : {}),
        createdAt,
        updatedAt,
        ...(deletedAt ? { deletedAt } : {}),
    };
}

export function normalizeSavedFilters(value: unknown): SavedFilter[] {
    if (!Array.isArray(value)) return [];
    const byId = new Map<string, SavedFilter>();
    for (const item of value) {
        const normalized = normalizeSavedFilter(item);
        if (!normalized) continue;
        byId.set(normalized.id, normalized);
    }
    return Array.from(byId.values()).sort((a, b) => {
        const createdDiff = Date.parse(a.createdAt) - Date.parse(b.createdAt);
        if (Number.isFinite(createdDiff) && createdDiff !== 0) return createdDiff;
        return a.name.localeCompare(b.name);
    });
}

/**
 * Tombstone one saved filter. Only that entry changes: the others stay as
 * stored, in stored order, including a newer app's views and fields.
 */
export function markSavedFilterDeleted(
    filters: readonly SavedFilter[] | undefined,
    filterId: string,
    deletedAt: string = new Date().toISOString(),
): SavedFilter[] {
    const next = (filters ?? []).map((filter) => (
        filter.id === filterId
            ? { ...filter, updatedAt: deletedAt, deletedAt }
            : filter
    ));
    logInfo('Saved filter deleted; other saved filters kept as stored', {
        scope: 'saved-filters',
        category: 'storage',
        context: { releaseCheck: 'v1.3.3/saved-filter-delete-keeps-others', count: next.length - 1 },
    });
    return next;
}
