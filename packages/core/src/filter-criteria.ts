import { normalizeFilterCriteria } from './saved-filters';
import type {
    DateRange,
    FilterCriteria,
    MultiValueFilterMatchMode,
    TaskEnergyLevel,
    TaskPriority,
    TimeEstimate,
} from './types';

/**
 * Filter selections ⇄ criteria as one module: every filtering surface keeps
 * its picker state as FilterSelections and converts through here, so the
 * token @/# split, the contextMatchMode rule, saved-filter validation, and
 * the active-filter count live in one place instead of one copy per view.
 *
 * Interface: criteriaFromSelections · selectionsFromCriteria ·
 * countActiveFilterCriteria. Everything else is implementation.
 */
export type FilterSelections = {
    anyDateRange?: DateRange;
    /** Mixed @context / #tag tokens, as shown in one token picker. */
    tokens: string[];
    /** Mixed @context / #tag tokens whose presence excludes a task. */
    excludedTokens: string[];
    projects: string[];
    locations: string[];
    priorities: TaskPriority[];
    energyLevels: TaskEnergyLevel[];
    timeEstimates: TimeEstimate[];
    contextMatchMode: MultiValueFilterMatchMode;
    tagMatchMode: MultiValueFilterMatchMode;
};

export function criteriaFromSelections(selections: Partial<FilterSelections>): FilterCriteria {
    const tokens = selections.tokens ?? [];
    const contexts = tokens.filter((token) => token.trim().startsWith('@'));
    const tags = tokens.filter((token) => token.trim().startsWith('#'));
    const excludedTokens = selections.excludedTokens ?? [];
    const excludedContexts = excludedTokens.filter((token) => token.trim().startsWith('@'));
    const excludedTags = excludedTokens.filter((token) => token.trim().startsWith('#'));
    const projects = selections.projects ?? [];
    const locations = selections.locations ?? [];
    const priorities = selections.priorities ?? [];
    const energyLevels = selections.energyLevels ?? [];
    const timeEstimates = selections.timeEstimates ?? [];
    return {
        ...(selections.anyDateRange ? { anyDateRange: selections.anyDateRange } : {}),
        ...(contexts.length > 0 ? { contexts } : {}),
        // The match mode only means something once several contexts compete.
        ...(contexts.length > 1 && selections.contextMatchMode
            ? { contextMatchMode: selections.contextMatchMode }
            : {}),
        ...(tags.length > 0 ? { tags } : {}),
        // The match mode only means something once several tags compete.
        ...(tags.length > 1 && selections.tagMatchMode
            ? { tagMatchMode: selections.tagMatchMode }
            : {}),
        ...(excludedContexts.length > 0 ? { excludedContexts } : {}),
        ...(excludedTags.length > 0 ? { excludedTags } : {}),
        ...(projects.length > 0 ? { projects } : {}),
        ...(locations.length > 0 ? { locations } : {}),
        ...(priorities.length > 0 ? { priority: priorities } : {}),
        ...(energyLevels.length > 0 ? { energy: energyLevels } : {}),
        ...(timeEstimates.length > 0 ? { timeEstimates } : {}),
    };
}

/**
 * Derive picker selections from criteria (applying a saved filter). Criteria
 * may come from another device or an older version, so they pass through
 * normalizeFilterCriteria: enum values are validated, custom time estimates
 * (no picker option) are dropped, and bare tokens gain their @/# prefix.
 * 'none' is a criteria-only priority; pickers select real priorities.
 */
export function selectionsFromCriteria(criteria: FilterCriteria | undefined): FilterSelections {
    const normalized = normalizeFilterCriteria(criteria ?? {});
    return {
        ...(normalized.anyDateRange ? { anyDateRange: normalized.anyDateRange } : {}),
        tokens: [...(normalized.contexts ?? []), ...(normalized.tags ?? [])],
        excludedTokens: [...(normalized.excludedContexts ?? []), ...(normalized.excludedTags ?? [])],
        projects: normalized.projects ?? [],
        locations: normalized.locations ?? [],
        priorities: (normalized.priority ?? []).filter((priority): priority is TaskPriority => priority !== 'none'),
        energyLevels: normalized.energy ?? [],
        timeEstimates: normalized.timeEstimates ?? [],
        contextMatchMode: normalized.contextMatchMode ?? 'all',
        tagMatchMode: normalized.tagMatchMode ?? 'all',
    };
}

/** Chip-count of active criteria: one per selected value, one per range/flag. */
export function countActiveFilterCriteria(criteria: FilterCriteria | undefined): number {
    if (!criteria) return 0;
    const normalized = normalizeFilterCriteria(criteria);
    return (
        (normalized.contexts?.length ?? 0)
        + (normalized.tags?.length ?? 0)
        + (normalized.excludedContexts?.length ?? 0)
        + (normalized.excludedTags?.length ?? 0)
        + (normalized.projects?.length ?? 0)
        + (normalized.areas?.length ?? 0)
        + (normalized.priority?.length ?? 0)
        + (normalized.energy?.length ?? 0)
        + (normalized.statuses?.length ?? 0)
        + (normalized.assignedTo?.length ?? 0)
        + (normalized.locations?.length ?? 0)
        + (normalized.timeEstimates?.length ?? 0)
        + (normalized.anyDateRange ? 1 : 0)
        + (normalized.dueDateRange ? 1 : 0)
        + (normalized.startDateRange ? 1 : 0)
        + (normalized.timeEstimateRange ? 1 : 0)
        + (normalized.hasDescription !== undefined ? 1 : 0)
        + (normalized.isStarred !== undefined ? 1 : 0)
    );
}
