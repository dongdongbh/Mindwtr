import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatTimeEstimateLabel } from './calendar-scheduling';
import {
  countActiveFilterCriteria,
  criteriaFromSelections,
  selectionsFromCriteria,
} from './filter-criteria';
import { tFallback } from './i18n';
import { getListSearchChipLabel } from './list-filter-state';
import { buildAdvancedFilterCriteriaChips, removeAdvancedFilterCriteriaChip } from './saved-filter-labels';
import { hasActiveFilterCriteria, normalizeFilterCriteria, taskMatchesFilterCriteria } from './saved-filters';
import { matchesTask as taskMatchesSearchTerm, parseSearchQuery } from './search';
import type { TaskMetadataFilterVisibility } from './task-metadata-filter-visibility';
import type {
  DateRange,
  FilterCriteria,
  MultiValueFilterMatchMode,
  SavedFilter,
  Task,
  TaskEnergyLevel,
  TaskPriority,
  TaskStatus,
  TimeEstimate,
} from './types';


export type TaskFilterView = 'focus' | 'list';

export type TaskFilterChip = {
  id: string;
  label: string;

  excluded?: boolean;
  onPress: () => void;
};

type TranslateFn = (key: string) => string;

export type TaskFilterSelectionsOptions = {
  view: TaskFilterView;
  t: TranslateFn;

  visibility: TaskMetadataFilterVisibility;

  savedFilters?: SavedFilter[];

  rawSavedFilters?: SavedFilter[];

  retainTokens?: string[];

  retainProjects?: string[];

  getProjectLabel?: (projectId: string) => string | undefined;


  onClear?: () => void;
};

export type TaskFilterSelections = ReturnType<typeof useTaskFilterSelections>;

type TokenSelection = { included: string[]; excluded: string[] };

const NO_TOKENS: TokenSelection = { included: [], excluded: [] };

const stableFilter = <T,>(current: T[], predicate: (item: T) => boolean): T[] => {
  const next = current.filter(predicate);
  return next.length === current.length && next.every((item, index) => item === current[index])
    ? current
    : next;
};

const toggleValue = <T,>(current: T[], value: T): T[] => (
  current.includes(value) ? current.filter((item) => item !== value) : [...current, value]
);

const normalize = (value: string | undefined): string => value?.trim().toLowerCase() ?? '';


export function taskMatchesFilterSearchQuery(task: Task, searchQueryValue: string): boolean {
  const searchQuery = normalize(searchQueryValue);
  if (!searchQuery) return true;

  const parsedSearch = parseSearchQuery(searchQuery);
  const hasFieldedTerm = parsedSearch.clauses.some((clause) =>
    clause.terms.some((term) => term.field !== null)
  );
  if (hasFieldedTerm) {
    const now = new Date();
    return parsedSearch.clauses.some((clause) =>
      clause.terms.every((term) => taskMatchesSearchTerm(term, task, null, now))
    );
  }

  const searchable = `${task.title} ${task.description ?? ''}`.toLowerCase();
  return searchable.includes(searchQuery);
}


export function taskMatchesFilterSelections(
  task: Task,
  selections: { criteria: FilterCriteria; searchQuery: string },
): boolean {
  if (!taskMatchesFilterSearchQuery(task, selections.searchQuery)) return false;
  if (!hasActiveFilterCriteria(selections.criteria)) return true;
  return taskMatchesFilterCriteria(task, selections.criteria, { tokenMatchMode: 'all' });
}

export function useTaskFilterSelections({
  view,
  t,
  visibility,
  savedFilters,
  rawSavedFilters,
  retainProjects,
  getProjectLabel,
  onClear,
}: TaskFilterSelectionsOptions) {
  const [anyDateRange, updateAnyDateRange] = useState<DateRange>();
  const [preservedCriteria, setPreservedCriteria] = useState<FilterCriteria>({});
  const [searchQuery, setSearchQuery] = useState('');


  const [tokenSelection, setTokenSelection] = useState<TokenSelection>(NO_TOKENS);
  const [projectSelection, setProjectSelection] = useState<TokenSelection>(NO_TOKENS);
  const { included: projects, excluded: excludedProjects } = projectSelection;
  const [statuses, setStatuses] = useState<TaskStatus[]>([]);
  const [priorities, setPriorities] = useState<TaskPriority[]>([]);
  const [energyLevels, setEnergyLevels] = useState<TaskEnergyLevel[]>([]);
  const [timeEstimates, setTimeEstimates] = useState<TimeEstimate[]>([]);
  const [locationQuery, setLocationQuery] = useState('');
  const [contextMatchMode, setContextMatchMode] = useState<MultiValueFilterMatchMode>('all');
  const [tagMatchMode, setTagMatchMode] = useState<MultiValueFilterMatchMode>('all');
  const [activeSavedFilterId, setActiveSavedFilterId] = useState<string | null>(null);

  const activeSavedFilter = useMemo(
    () => (savedFilters ?? []).find((filter) => filter.id === activeSavedFilterId) ?? null,
    [activeSavedFilterId, savedFilters],
  );

  useEffect(() => {
    if (activeSavedFilterId && !activeSavedFilter) {
      setActiveSavedFilterId(null);
    }
  }, [activeSavedFilter, activeSavedFilterId]);


  useEffect(() => {
    if (!visibility.priority) setPriorities((current) => (current.length > 0 ? [] : current));
  }, [priorities, visibility.priority]);
  useEffect(() => {
    if (!visibility.energyLevel) setEnergyLevels((current) => (current.length > 0 ? [] : current));
  }, [energyLevels, visibility.energyLevel]);
  useEffect(() => {
    if (!visibility.timeEstimate) setTimeEstimates((current) => (current.length > 0 ? [] : current));
  }, [timeEstimates, visibility.timeEstimate]);
  useEffect(() => {
    if (!visibility.location) setLocationQuery((current) => (current.trim() ? '' : current));
  }, [locationQuery, visibility.location]);
  useEffect(() => {
    if (!retainProjects) return;
    setProjectSelection((current) => {
      const included = stableFilter(current.included, (projectId) => retainProjects.includes(projectId));
      return included === current.included ? current : { ...current, included };
    });
  }, [projects, retainProjects]);

  const forgetPreservedFields = useCallback((...fields: (keyof FilterCriteria)[]) => {
    setPreservedCriteria((current) => {
      const next = { ...(activeSavedFilter
        ? rawSavedFilters?.find((filter) => filter.id === activeSavedFilter.id)?.criteria ?? activeSavedFilter.criteria
        : current) };
      fields.forEach((field) => { delete next[field]; });
      return next;
    });
  }, [activeSavedFilter, rawSavedFilters]);

  const toggleToken = useCallback((token: string) => {
    forgetPreservedFields('contexts', 'tags', 'excludedContexts', 'excludedTags');
    setActiveSavedFilterId(null);


    setTokenSelection((current) => {
      if (current.included.includes(token)) {
        return {
          included: current.included.filter((item) => item !== token),
          excluded: current.excluded.includes(token) ? current.excluded : [...current.excluded, token],
        };
      }
      if (current.excluded.includes(token)) {
        return { included: current.included, excluded: current.excluded.filter((item) => item !== token) };
      }
      return { included: [...current.included, token], excluded: current.excluded };
    });
  }, [forgetPreservedFields]);

  const removeToken = useCallback((token: string) => {
    forgetPreservedFields('contexts', 'tags', 'excludedContexts', 'excludedTags');
    setActiveSavedFilterId(null);
    setTokenSelection((current) => ({
      included: current.included.filter((item) => item !== token),
      excluded: current.excluded.filter((item) => item !== token),
    }));
  }, [forgetPreservedFields]);

  const toggleProject = useCallback((projectId: string) => {
    forgetPreservedFields('projects', 'excludedProjects');
    setActiveSavedFilterId(null);
    setProjectSelection((current) => ({ ...current, included: toggleValue(current.included, projectId) }));
  }, [forgetPreservedFields]);
  const cycleProject = useCallback((projectId: string) => {
    forgetPreservedFields('projects', 'excludedProjects');
    setActiveSavedFilterId(null);
    setProjectSelection((current) => {
      if (current.included.includes(projectId)) return {
        included: current.included.filter((id) => id !== projectId),
        excluded: current.excluded.includes(projectId) ? current.excluded : [...current.excluded, projectId],
      };
      if (current.excluded.includes(projectId)) return { ...current, excluded: current.excluded.filter((id) => id !== projectId) };
      return { ...current, included: [...current.included, projectId] };
    });
  }, [forgetPreservedFields]);
  const removeProject = useCallback((projectId: string) => {
    forgetPreservedFields('projects', 'excludedProjects');
    setActiveSavedFilterId(null);
    setProjectSelection((current) => ({ included: current.included.filter((id) => id !== projectId),
      excluded: current.excluded.filter((id) => id !== projectId) }));
  }, [forgetPreservedFields]);
  const toggleStatus = useCallback((status: TaskStatus) => {
    forgetPreservedFields('statuses');
    setActiveSavedFilterId(null);
    setStatuses((current) => toggleValue(current, status));
  }, [forgetPreservedFields]);
  const setStatusSelection = useCallback((next: TaskStatus[]) => {
    forgetPreservedFields('statuses');
    setActiveSavedFilterId(null);
    setStatuses(next);
  }, [forgetPreservedFields]);
  const togglePriority = useCallback((priority: TaskPriority) => {
    forgetPreservedFields('priority');
    setActiveSavedFilterId(null);
    setPriorities((current) => toggleValue(current, priority));
  }, [forgetPreservedFields]);
  const toggleEnergyLevel = useCallback((energyLevel: TaskEnergyLevel) => {
    forgetPreservedFields('energy');
    setActiveSavedFilterId(null);
    setEnergyLevels((current) => toggleValue(current, energyLevel));
  }, [forgetPreservedFields]);
  const toggleTimeEstimate = useCallback((estimate: TimeEstimate) => {
    forgetPreservedFields('timeEstimates', 'timeEstimateRange');
    setActiveSavedFilterId(null);
    setTimeEstimates((current) => toggleValue(current, estimate));
  }, [forgetPreservedFields]);
  const setLocation = useCallback((value: string) => {
    forgetPreservedFields('locations');
    setActiveSavedFilterId(null);
    setLocationQuery(value);
  }, [forgetPreservedFields]);
  const setMatchMode = useCallback((kind: 'context' | 'tag', mode: MultiValueFilterMatchMode) => {
    forgetPreservedFields(kind === 'context' ? 'contextMatchMode' : 'tagMatchMode');
    setActiveSavedFilterId(null);
    if (kind === 'context') setContextMatchMode(mode);
    else setTagMatchMode(mode);
  }, [forgetPreservedFields]);

  const setAnyDateRange = useCallback((value: DateRange | undefined) => {
    if (activeSavedFilter) {

      const preserved = { ...(rawSavedFilters?.find((filter) => filter.id === activeSavedFilter.id)?.criteria ?? activeSavedFilter.criteria) };
      delete preserved.anyDateRange;
      setPreservedCriteria(preserved);
    }
    setActiveSavedFilterId(null);
    updateAnyDateRange(value);
  }, [activeSavedFilter, rawSavedFilters]);

  const clear = useCallback(() => {
    setActiveSavedFilterId(null);
    setSearchQuery('');
    updateAnyDateRange(undefined);
    setPreservedCriteria({});
    setTokenSelection(NO_TOKENS);
    setProjectSelection(NO_TOKENS);
    setStatuses([]);
    setPriorities([]);
    setEnergyLevels([]);
    setTimeEstimates([]);
    setLocationQuery('');
    setContextMatchMode('all');
    setTagMatchMode('all');
    onClear?.();
  }, [onClear]);


  const unbindSaved = useCallback(() => setActiveSavedFilterId(null), []);

  const applySaved = useCallback((filter: SavedFilter) => {
    const selections = selectionsFromCriteria(filter.criteria);
    updateAnyDateRange(selections.anyDateRange);
    setPreservedCriteria({});
    setTokenSelection({ included: selections.tokens, excluded: selections.excludedTokens });
    setProjectSelection({ included: selections.projects, excluded: selections.excludedProjects ?? [] });
    setStatuses(selections.statuses ?? []);
    setPriorities(selections.priorities);
    setEnergyLevels(selections.energyLevels);
    setTimeEstimates(selections.timeEstimates);
    setLocationQuery(selections.locations[0] ?? '');
    setContextMatchMode(selections.contextMatchMode);
    setTagMatchMode(selections.tagMatchMode);
    setActiveSavedFilterId(filter.id);
  }, []);

  const { included: tokens, excluded: excludedTokens } = tokenSelection;
  const currentCriteria = useMemo(() => ({
    ...criteriaFromSelections({
      anyDateRange,
      tokens,
      excludedTokens,
      projects,
      excludedProjects,
      statuses,
      locations: visibility.location && locationQuery.trim() ? [locationQuery.trim()] : [],
      priorities: visibility.priority ? priorities : [],
      energyLevels: visibility.energyLevel ? energyLevels : [],
      timeEstimates: visibility.timeEstimate ? timeEstimates : [],
      contextMatchMode,
      tagMatchMode,
    }),
    ...preservedCriteria,
  }), [
    anyDateRange,
    preservedCriteria,
    contextMatchMode,
    energyLevels,
    excludedTokens,
    locationQuery,
    priorities,
    projects,
    excludedProjects,
    statuses,
    tagMatchMode,
    timeEstimates,
    tokens,
    visibility.energyLevel,
    visibility.location,
    visibility.priority,
    visibility.timeEstimate,
  ]);


  const criteria = useMemo<FilterCriteria>(() => ({
    ...(activeSavedFilter?.criteria ?? currentCriteria),
    ...(visibility.priority ? {} : { priority: undefined }),
    ...(visibility.energyLevel ? {} : { energy: undefined }),
    ...(visibility.location ? {} : { locations: undefined }),
    ...(visibility.timeEstimate ? {} : { timeEstimates: undefined, timeEstimateRange: undefined }),
  }), [
    activeSavedFilter,
    currentCriteria,
    visibility.energyLevel,
    visibility.location,
    visibility.priority,
    visibility.timeEstimate,
  ]);

  const activeCount = (normalize(searchQuery) ? 1 : 0) + countActiveFilterCriteria(criteria);
  const hasActive = activeCount > 0;
  const hasCurrentCriteria = hasActiveFilterCriteria(currentCriteria);
  const canSave = activeSavedFilterId === null && hasCurrentCriteria;

  const selectedContextCount = useMemo(
    () => tokens.filter((token) => token.trim().startsWith('@')).length,
    [tokens],
  );
  const selectedTagCount = useMemo(
    () => tokens.filter((token) => token.trim().startsWith('#')).length,
    [tokens],
  );

  const hasPreservedPriority = Array.isArray(preservedCriteria.priority) && preservedCriteria.priority.includes('none');
  const hasPreservedEstimates = Array.isArray(preservedCriteria.timeEstimates) && preservedCriteria.timeEstimates.some((estimate) => typeof estimate === 'string' && estimate.startsWith('custom:'));
  const chips = useMemo<TaskFilterChip[]>(() => {
    const result: TaskFilterChip[] = [];
    const normalizedSearch = searchQuery.trim();
    if (normalizedSearch) {
      result.push({
        id: 'search',
        label: getListSearchChipLabel(normalizedSearch, t),
        onPress: () => setSearchQuery(''),
      });
    }
    tokens.forEach((token) => {
      result.push({ id: `token:${token}`, label: token, onPress: () => removeToken(token) });
    });
    excludedTokens.forEach((token) => {
      result.push({
        id: `excluded-token:${token}`,
        label: token,
        excluded: true,
        onPress: () => removeToken(token),
      });
    });
    projects.forEach((projectId) => {
      const label = getProjectLabel?.(projectId);
      if (!label) return;
      result.push({ id: `project:${projectId}`, label, onPress: () => removeProject(projectId) });
    });
    excludedProjects.forEach((projectId) => result.push({ id: `excluded-project:${projectId}`,
      label: getProjectLabel?.(projectId) ?? projectId, excluded: true, onPress: () => removeProject(projectId) }));
    if (view === 'list') statuses.forEach((status) => result.push({ id: `status:${status}`, label: t(`status.${status}`), onPress: () => toggleStatus(status) }));
    if (visibility.priority && !hasPreservedPriority) {
      priorities.forEach((priority) => {
        result.push({
          id: `priority:${priority}`,
          label: t(`priority.${priority}`),
          onPress: () => togglePriority(priority),
        });
      });
    }
    if (visibility.energyLevel) {
      energyLevels.forEach((energyLevel) => {
        result.push({
          id: `energy:${energyLevel}`,
          label: t(`energyLevel.${energyLevel}`),
          onPress: () => toggleEnergyLevel(energyLevel),
        });
      });
    }
    if (visibility.timeEstimate && !hasPreservedEstimates) {
      timeEstimates.forEach((estimate) => {
        result.push({
          id: `time:${estimate}`,
          label: formatTimeEstimateLabel(estimate),
          onPress: () => toggleTimeEstimate(estimate),
        });
      });
    }
    if (visibility.priority && hasPreservedPriority) {
      result.push({
        id: 'preserved:priority',
        label: `${tFallback(t, 'filters.priority', 'Priority')}: ${(preservedCriteria.priority ?? []).map((value) => value === 'none' ? tFallback(t, 'focus.group.noPriority', 'No priority') : t(`priority.${value}`)).join(', ')}`,
        onPress: () => { forgetPreservedFields('priority'); setPriorities([]); },
      });
    }
    if (visibility.timeEstimate && hasPreservedEstimates) {
      result.push({
        id: 'preserved:timeEstimates',
        label: `${tFallback(t, 'filters.timeEstimate', 'Time estimate')}: ${(preservedCriteria.timeEstimates ?? []).filter((value) => typeof value === 'string').map((value) => formatTimeEstimateLabel(value)).join(', ')}`,
        onPress: () => { forgetPreservedFields('timeEstimates'); setTimeEstimates([]); },
      });
    }
    const normalizedLocation = locationQuery.trim();


    if (visibility.location && normalizedLocation && !activeSavedFilter && !preservedCriteria.locations) {
      result.push({
        id: 'location',
        label: `${tFallback(t, 'taskEdit.locationLabel', 'Location')}: ${normalizedLocation}`,
        onPress: () => setLocation(''),
      });
    }
    const chipOptions = { resolveText: (key: string, fallback: string) => tFallback(t, key, fallback), getProjectLabel };
    const visiblePreservedCriteria = normalizeFilterCriteria({
      ...preservedCriteria,
      excludedProjects: undefined,
      statuses: undefined,
      ...(visibility.location ? {} : { locations: undefined }),
      ...(visibility.timeEstimate ? {} : { timeEstimateRange: undefined }),
    });
    buildAdvancedFilterCriteriaChips(visiblePreservedCriteria, chipOptions).forEach((chip) => {
      result.push({
        id: `advanced:${chip.id}`,
        label: chip.label,
        onPress: () => {
          setPreservedCriteria((current) => removeAdvancedFilterCriteriaChip(current, chip.id));
          if (chip.id.startsWith('location:')) setLocationQuery('');
        },
      });
    });
    if (anyDateRange) {
      const dateChip = buildAdvancedFilterCriteriaChips({ anyDateRange }, chipOptions)[0];
      if (dateChip) result.push({ id: 'anyDateRange', label: dateChip.label, onPress: () => setAnyDateRange(undefined) });
    }
    return result;
  }, [
    anyDateRange,
    preservedCriteria,
    hasPreservedPriority,
    hasPreservedEstimates,
    forgetPreservedFields,
    setAnyDateRange,
    activeSavedFilter,
    energyLevels,
    excludedTokens,
    excludedProjects,
    statuses,
    removeProject,
    toggleStatus,
    setStatusSelection,
    getProjectLabel,
    locationQuery,
    removeToken,
    priorities,
    projects,
    searchQuery,
    setLocation,
    t,
    timeEstimates,
    toggleEnergyLevel,
    togglePriority,
    toggleProject,
    toggleTimeEstimate,
    tokens,
    visibility.energyLevel,
    visibility.location,
    visibility.priority,
    visibility.timeEstimate,
    view,
  ]);

  return {
    view,

    anyDateRange,
    searchQuery,
    tokens,
    excludedTokens,
    projects,
    excludedProjects,
    statuses,
    priorities,
    energyLevels,
    timeEstimates,
    locationQuery,
    contextMatchMode,
    tagMatchMode,

    criteria,
    currentCriteria,
    activeCount,
    hasActive,
    hasCurrentCriteria,
    canSave,
    chips,
    activeSavedFilterId,
    activeSavedFilter,

    showContextMatchMode: selectedContextCount > 1,
    showTagMatchMode: selectedTagCount > 1,

    setAnyDateRange,
    setSearchQuery,
    setLocation,
    setMatchMode,
    toggleToken,
    removeToken,
    toggleProject,
    cycleProject,
    removeProject,
    toggleStatus,
    setStatusSelection,
    togglePriority,
    toggleEnergyLevel,
    toggleTimeEstimate,
    clear,
    applySaved,
    unbindSaved,
  };
}
