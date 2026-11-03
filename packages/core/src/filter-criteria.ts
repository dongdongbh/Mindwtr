import { normalizeFilterCriteria } from './saved-filters';
import type {
    DateRange,
    FilterCriteria,
    MultiValueFilterMatchMode,
    TaskEnergyLevel,
    TaskPriority,
    TaskStatus,
    TimeEstimate,
} from './types';


export type FilterSelections = {
    anyDateRange?: DateRange;

    tokens: string[];

    excludedTokens: string[];
    projects: string[];
    excludedProjects?: string[];
    statuses?: TaskStatus[];
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

        ...(contexts.length > 1 && selections.contextMatchMode
            ? { contextMatchMode: selections.contextMatchMode }
            : {}),
        ...(tags.length > 0 ? { tags } : {}),

        ...(tags.length > 1 && selections.tagMatchMode
            ? { tagMatchMode: selections.tagMatchMode }
            : {}),
        ...(excludedContexts.length > 0 ? { excludedContexts } : {}),
        ...(excludedTags.length > 0 ? { excludedTags } : {}),
        ...(projects.length > 0 ? { projects } : {}),
        ...(selections.excludedProjects?.length ? { excludedProjects: selections.excludedProjects } : {}),
        ...(selections.statuses?.length ? { statuses: selections.statuses } : {}),
        ...(locations.length > 0 ? { locations } : {}),
        ...(priorities.length > 0 ? { priority: priorities } : {}),
        ...(energyLevels.length > 0 ? { energy: energyLevels } : {}),
        ...(timeEstimates.length > 0 ? { timeEstimates } : {}),
    };
}


export function selectionsFromCriteria(criteria: FilterCriteria | undefined): FilterSelections {
    const normalized = normalizeFilterCriteria(criteria ?? {});
    return {
        ...(normalized.anyDateRange ? { anyDateRange: normalized.anyDateRange } : {}),
        tokens: [...(normalized.contexts ?? []), ...(normalized.tags ?? [])],
        excludedTokens: [...(normalized.excludedContexts ?? []), ...(normalized.excludedTags ?? [])],
        projects: normalized.projects ?? [],
        ...(normalized.excludedProjects ? { excludedProjects: normalized.excludedProjects } : {}),
        ...(normalized.statuses ? { statuses: normalized.statuses } : {}),
        locations: normalized.locations ?? [],
        priorities: (normalized.priority ?? []).filter((priority): priority is TaskPriority => priority !== 'none'),
        energyLevels: normalized.energy ?? [],
        timeEstimates: normalized.timeEstimates ?? [],
        contextMatchMode: normalized.contextMatchMode ?? 'all',
        tagMatchMode: normalized.tagMatchMode ?? 'all',
    };
}


export function countActiveFilterCriteria(criteria: FilterCriteria | undefined): number {
    if (!criteria) return 0;
    const normalized = normalizeFilterCriteria(criteria);
    return (
        (normalized.contexts?.length ?? 0)
        + (normalized.tags?.length ?? 0)
        + (normalized.excludedContexts?.length ?? 0)
        + (normalized.excludedTags?.length ?? 0)
        + (normalized.projects?.length ?? 0)
        + (normalized.excludedProjects?.length ?? 0)
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
