import { useCallback, useMemo } from 'react';
import { selectionsFromCriteria } from '@mindwtr/core';
import type { FilterCriteria, MultiValueFilterMatchMode, TaskPriority, TimeEstimate } from '@mindwtr/core';
import { useUiStore } from '../../../store/ui-store';
import { removeFilterChipFromCriteria } from './active-filter-chips';

const EMPTY_ESTIMATES: TimeEstimate[] = [];


export function withListFilterValue<K extends keyof Pick<FilterCriteria, 'contexts' | 'tags' | 'excludedContexts' | 'excludedTags' | 'priority' | 'timeEstimates'>>(
    criteria: FilterCriteria,
    key: K,
    values: NonNullable<FilterCriteria[K]>,
): FilterCriteria {
    const next = { ...criteria };
    if (values.length > 0) {
        next[key] = values;
    } else {
        delete next[key];
    }
    return next;
}


export function useListFilterControls() {
    const listFilters = useUiStore((state) => state.listFilters);
    const setListFilters = useUiStore((state) => state.setListFilters);
    const resetListFilters = useUiStore((state) => state.resetListFilters);

    const criteria = listFilters.criteria;
    const selections = useMemo(() => selectionsFromCriteria(criteria), [criteria]);
    const selectedTokens = selections.tokens;
    const excludedTokens = selections.excludedTokens;
    const selectedPriorities = selections.priorities;
    const selectedTimeEstimates = criteria.timeEstimates ?? EMPTY_ESTIMATES;
    const contextMatchMode = selections.contextMatchMode;
    const tagMatchMode = selections.tagMatchMode;

    const toggleToken = useCallback((token: string) => {
        const isTag = token.trim().startsWith('#');
        const includeKey = isTag ? 'tags' : 'contexts';
        const excludeKey = isTag ? 'excludedTags' : 'excludedContexts';
        const included = criteria[includeKey] ?? [];
        const excluded = criteria[excludeKey] ?? [];


        let next = criteria;
        if (included.includes(token)) {
            next = withListFilterValue(next, includeKey, included.filter((item) => item !== token));
            next = withListFilterValue(next, excludeKey, [...excluded, token]);
        } else if (excluded.includes(token)) {
            next = withListFilterValue(next, excludeKey, excluded.filter((item) => item !== token));
        } else {
            next = withListFilterValue(next, includeKey, [...included, token]);
        }
        setListFilters({ criteria: next });
    }, [criteria, setListFilters]);

    const togglePriority = useCallback((priority: TaskPriority) => {
        const nextPriorities = selectedPriorities.includes(priority)
            ? selectedPriorities.filter((item) => item !== priority)
            : [...selectedPriorities, priority];
        setListFilters({ criteria: withListFilterValue(criteria, 'priority', nextPriorities) });
    }, [criteria, selectedPriorities, setListFilters]);

    const toggleEstimate = useCallback((estimate: TimeEstimate) => {
        const nextEstimates = selectedTimeEstimates.includes(estimate)
            ? selectedTimeEstimates.filter((item) => item !== estimate)
            : [...selectedTimeEstimates, estimate];
        setListFilters({ criteria: withListFilterValue(criteria, 'timeEstimates', nextEstimates) });
    }, [criteria, selectedTimeEstimates, setListFilters]);

    const setMatchMode = useCallback((kind: 'context' | 'tag', mode: MultiValueFilterMatchMode) => {
        const key = kind === 'context' ? 'contextMatchMode' : 'tagMatchMode';
        setListFilters({ criteria: { ...criteria, [key]: mode } });
    }, [criteria, setListFilters]);

    const removeFilterChip = useCallback((chipId: string) => {
        const next = removeFilterChipFromCriteria(criteria, chipId);
        if (next === criteria) return;
        setListFilters({ criteria: next });
    }, [criteria, setListFilters]);

    const setFiltersOpen = useCallback((open: boolean) => {
        setListFilters({ open });
    }, [setListFilters]);

    return {
        criteria,
        filtersOpen: listFilters.open,
        selectedTokens,
        excludedTokens,
        selectedPriorities,
        selectedTimeEstimates,
        contextMatchMode,
        tagMatchMode,
        toggleToken,
        togglePriority,
        toggleEstimate,
        setMatchMode,
        removeFilterChip,
        clearFilters: resetListFilters,
        setFiltersOpen,
        setListFilters,
    };
}

export const PRIORITY_FILTER_OPTIONS: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];
