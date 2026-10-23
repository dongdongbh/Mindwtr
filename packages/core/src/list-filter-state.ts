import { formatTimeEstimateLabel } from './calendar-scheduling';
import { countActiveFilterCriteria, criteriaFromSelections } from './filter-criteria';
import { tFallback } from './i18n';
import { buildAdvancedFilterCriteriaChips } from './saved-filter-labels';
import type { TaskMetadataFilterVisibility } from './task-metadata-filter-visibility';
import type {
    DateRange,
    FilterCriteria,
    MultiValueFilterMatchMode,
    TaskEnergyLevel,
    TaskPriority,
    TimeEstimate,
} from './types';

/**
 * The list filter picker's state as plain data, for hosts that cannot run
 * `useTaskFilterSelections` (task-filter-selections.ts). The edits, the pruning
 * and the chips mirror that hook without a saved filter applied, which is how
 * Someday, Reference and Done use it.
 */
export type ListFilterState = {
    searchQuery: string;
    tokens: string[];
    excludedTokens: string[];
    projects: string[];
    priorities: TaskPriority[];
    energyLevels: TaskEnergyLevel[];
    timeEstimates: TimeEstimate[];
    location: string;
    anyDateRange?: DateRange;
    contextMatchMode: MultiValueFilterMatchMode;
    tagMatchMode: MultiValueFilterMatchMode;
};

export const EMPTY_LIST_FILTER_STATE: ListFilterState = {
    searchQuery: '',
    tokens: [],
    excludedTokens: [],
    projects: [],
    priorities: [],
    energyLevels: [],
    timeEstimates: [],
    location: '',
    contextMatchMode: 'all',
    tagMatchMode: 'all',
};

/** One picker control's change, exactly as the hook's setter of the same name makes it. */
export type ListFilterEdit =
    | { type: 'toggleToken'; value: string }
    | { type: 'removeToken'; value: string }
    | { type: 'toggleProject'; value: string }
    | { type: 'togglePriority'; value: TaskPriority }
    | { type: 'toggleEnergyLevel'; value: TaskEnergyLevel }
    | { type: 'toggleTimeEstimate'; value: TimeEstimate }
    | { type: 'setSearch'; value: string }
    | { type: 'setLocation'; value: string }
    | { type: 'setAnyDateRange'; value: DateRange | null }
    | { type: 'setMatchMode'; kind: 'context' | 'tag'; value: MultiValueFilterMatchMode }
    | { type: 'clear' };

const toggleValue = <T,>(current: readonly T[], value: T): T[] => (
    current.includes(value) ? current.filter((item) => item !== value) : [...current, value]
);

export function applyListFilterEdit(state: ListFilterState, edit: ListFilterEdit): ListFilterState {
    switch (edit.type) {
        case 'removeToken':
            return {
                ...state,
                tokens: state.tokens.filter((item) => item !== edit.value),
                excludedTokens: state.excludedTokens.filter((item) => item !== edit.value),
            };
        case 'toggleToken': {
            // Tri-state cycle: neutral → included → excluded → neutral.
            const token = edit.value;
            if (state.tokens.includes(token)) {
                return {
                    ...state,
                    tokens: state.tokens.filter((item) => item !== token),
                    excludedTokens: state.excludedTokens.includes(token) ? state.excludedTokens : [...state.excludedTokens, token],
                };
            }
            if (state.excludedTokens.includes(token)) {
                return { ...state, excludedTokens: state.excludedTokens.filter((item) => item !== token) };
            }
            return { ...state, tokens: [...state.tokens, token] };
        }
        case 'toggleProject':
            return { ...state, projects: toggleValue(state.projects, edit.value) };
        case 'togglePriority':
            return { ...state, priorities: toggleValue(state.priorities, edit.value) };
        case 'toggleEnergyLevel':
            return { ...state, energyLevels: toggleValue(state.energyLevels, edit.value) };
        case 'toggleTimeEstimate':
            return { ...state, timeEstimates: toggleValue(state.timeEstimates, edit.value) };
        case 'setSearch':
            return { ...state, searchQuery: edit.value };
        case 'setLocation':
            return { ...state, location: edit.value };
        case 'setAnyDateRange': {
            const { anyDateRange: _previous, ...rest } = state;
            return edit.value ? { ...rest, anyDateRange: edit.value } : rest;
        }
        case 'setMatchMode':
            return edit.kind === 'context' ? { ...state, contextMatchMode: edit.value } : { ...state, tagMatchMode: edit.value };
        case 'clear':
            return EMPTY_LIST_FILTER_STATE;
    }
}

export const getListSearchChipLabel = (search: string, t: (key: string) => string): string => `${t('search.title')}: ${search}`;

export type ListFilterChip = {
    id: string;
    label: string;
    /** Excluded chips subtract; they render struck through. */
    excluded: boolean;
    /** What pressing the chip sends: the hook's own chip action. */
    edit: ListFilterEdit;
};

export type ResolvedListFilter = {
    /** The state with selections the view no longer offers dropped, as the hook's effects drop them. */
    state: ListFilterState;
    criteria: FilterCriteria;
    searchQuery: string;
    activeCount: number;
    hasActive: boolean;
    chips: ListFilterChip[];
    /** The match mode control shows once two tokens of a kind are selected. */
    showContextMatchMode: boolean;
    showTagMatchMode: boolean;
};

export function resolveListFilterState(
    input: ListFilterState,
    options: {
        visibility: TaskMetadataFilterVisibility;
        /** Offered tokens from older callers; explicit selections remain clearable when absent. */
        retainTokens?: readonly string[];
        retainProjects?: readonly string[];
        getProjectLabel?: (projectId: string) => string | undefined;
        t: (key: string) => string;
    },
): ResolvedListFilter {
    const { visibility, retainProjects, getProjectLabel, t } = options;
    const state: ListFilterState = {
        ...input,
        priorities: visibility.priority ? input.priorities : [],
        energyLevels: visibility.energyLevel ? input.energyLevels : [],
        timeEstimates: visibility.timeEstimate ? input.timeEstimates : [],
        location: !visibility.location && input.location.trim() ? '' : input.location,
        tokens: input.tokens,
        excludedTokens: input.excludedTokens,
        projects: retainProjects ? input.projects.filter((projectId) => retainProjects.includes(projectId)) : input.projects,
    };
    const currentCriteria = criteriaFromSelections({
        tokens: state.tokens,
        excludedTokens: state.excludedTokens,
        projects: state.projects,
        locations: visibility.location && state.location.trim() ? [state.location.trim()] : [],
        priorities: visibility.priority ? state.priorities : [],
        energyLevels: visibility.energyLevel ? state.energyLevels : [],
        timeEstimates: visibility.timeEstimate ? state.timeEstimates : [],
        contextMatchMode: state.contextMatchMode,
        tagMatchMode: state.tagMatchMode,
        anyDateRange: state.anyDateRange,
    });
    const criteria: FilterCriteria = {
        ...currentCriteria,
        ...(visibility.priority ? {} : { priority: undefined }),
        ...(visibility.energyLevel ? {} : { energy: undefined }),
        ...(visibility.location ? {} : { locations: undefined }),
        ...(visibility.timeEstimate ? {} : { timeEstimates: undefined, timeEstimateRange: undefined }),
    };
    const activeCount = (state.searchQuery.trim().toLowerCase() ? 1 : 0) + countActiveFilterCriteria(criteria);

    const chips: ListFilterChip[] = [];
    const search = state.searchQuery.trim();
    if (search) chips.push({ id: 'search', label: getListSearchChipLabel(search, t), excluded: false, edit: { type: 'setSearch', value: '' } });
    state.tokens.forEach((token) => {
        chips.push({ id: `token:${token}`, label: token, excluded: false, edit: { type: 'removeToken', value: token } });
    });
    state.excludedTokens.forEach((token) => {
        chips.push({ id: `excluded-token:${token}`, label: token, excluded: true, edit: { type: 'removeToken', value: token } });
    });
    state.projects.forEach((projectId) => {
        const label = getProjectLabel?.(projectId);
        if (!label) return;
        chips.push({ id: `project:${projectId}`, label, excluded: false, edit: { type: 'toggleProject', value: projectId } });
    });
    if (visibility.priority) {
        state.priorities.forEach((priority) => {
            chips.push({ id: `priority:${priority}`, label: t(`priority.${priority}`), excluded: false, edit: { type: 'togglePriority', value: priority } });
        });
    }
    if (visibility.energyLevel) {
        state.energyLevels.forEach((energyLevel) => {
            chips.push({ id: `energy:${energyLevel}`, label: t(`energyLevel.${energyLevel}`), excluded: false, edit: { type: 'toggleEnergyLevel', value: energyLevel } });
        });
    }
    if (visibility.timeEstimate) {
        state.timeEstimates.forEach((estimate) => {
            chips.push({ id: `time:${estimate}`, label: formatTimeEstimateLabel(estimate), excluded: false, edit: { type: 'toggleTimeEstimate', value: estimate } });
        });
    }
    if (state.anyDateRange) {
        chips.push({
            id: 'anyDateRange',
            label: buildAdvancedFilterCriteriaChips({ anyDateRange: state.anyDateRange }, { resolveText: (key, fallback) => tFallback(t, key, fallback) })[0].label,
            excluded: false,
            edit: { type: 'setAnyDateRange', value: null },
        });
    }
    const location = state.location.trim();
    if (visibility.location && location) {
        chips.push({
            id: 'location',
            label: `${tFallback(t, 'taskEdit.locationLabel', 'Location')}: ${location}`,
            excluded: false,
            edit: { type: 'setLocation', value: '' },
        });
    }
    return {
        state,
        criteria,
        searchQuery: state.searchQuery,
        activeCount,
        hasActive: activeCount > 0,
        chips,
        showContextMatchMode: state.tokens.filter((token) => token.trim().startsWith('@')).length > 1,
        showTagMatchMode: state.tokens.filter((token) => token.trim().startsWith('#')).length > 1,
    };
}
