import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatTimeEstimateLabel } from './calendar-scheduling';
import {
  countActiveFilterCriteria,
  criteriaFromSelections,
  selectionsFromCriteria,
} from './filter-criteria';
import { tFallback } from './i18n';
import { getListSearchChipLabel } from './list-filter-state';
import { hasActiveFilterCriteria, taskMatchesFilterCriteria } from './saved-filters';
import { matchesTask as taskMatchesSearchTerm, parseSearchQuery } from './search';
import type { TaskMetadataFilterVisibility } from './task-metadata-filter-visibility';
import type {
  FilterCriteria,
  MultiValueFilterMatchMode,
  SavedFilter,
  Task,
  TaskEnergyLevel,
  TaskPriority,
  TimeEstimate,
} from './types';

/**
 * Filter selections shared by desktop and mobile picker surfaces. Criteria
 * live in filter-criteria; this hook owns the picker state around them — the
 * tri-state token cycle, visibility pruning, chips, and saved-filter binding.
 */

export type TaskFilterView = 'focus' | 'list';

export type TaskFilterChip = {
  id: string;
  label: string;
  /** Excluded chips subtract; they render struck through so mono themes keep the state. */
  excluded?: boolean;
  onPress: () => void;
};

type TranslateFn = (key: string) => string;

export type TaskFilterSelectionsOptions = {
  view: TaskFilterView;
  t: TranslateFn;
  /** Which metadata sections the visible tasks justify showing. */
  visibility: TaskMetadataFilterVisibility;
  /** Saved filters for this view, already filtered to non-deleted ones. */
  savedFilters?: SavedFilter[];
  /** Token chips currently offered; selections outside the list are dropped. */
  retainTokens?: string[];
  /** Project ids currently offered; selections outside the list are dropped. */
  retainProjects?: string[];
  /** Resolves a project chip label; a project that resolves to nothing gets no chip. */
  getProjectLabel?: (projectId: string) => string | undefined;
  /**
   * Extra reset for view state that reads as a filter but is not a criterion
   * (Focus's sort order). Memoize it: `clear` inherits its identity.
   */
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

/**
 * Search-box matching for a filter surface: fielded terms (`id:`, `due:` …)
 * run through the core search parser, everything else is a plain title and
 * description substring.
 */
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

/** Search box + criteria in one predicate, for surfaces that filter locally. */
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
  retainTokens,
  retainProjects,
  getProjectLabel,
  onClear,
}: TaskFilterSelectionsOptions) {
  const [searchQuery, setSearchQuery] = useState('');
  // Both sides of the token cycle in one value: the transition reads them
  // together, so splitting them would make a toggle depend on a stale render.
  const [tokenSelection, setTokenSelection] = useState<TokenSelection>(NO_TOKENS);
  const [projects, setProjects] = useState<string[]>([]);
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

  // Selections whose section is no longer offered stop filtering silently:
  // drop them so a later re-appearance does not resurrect a hidden filter.
  // The selections are dependencies too: an applied saved filter can select
  // what the view already hides or does not offer.
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
    if (!retainTokens) return;
    setTokenSelection((current) => {
      const offered = (token: string) => retainTokens.includes(token);
      const included = stableFilter(current.included, offered);
      const excluded = stableFilter(current.excluded, offered);
      return included === current.included && excluded === current.excluded
        ? current
        : { included, excluded };
    });
  }, [retainTokens, tokenSelection]);
  useEffect(() => {
    if (!retainProjects) return;
    setProjects((current) => stableFilter(current, (projectId) => retainProjects.includes(projectId)));
  }, [projects, retainProjects]);

  const toggleToken = useCallback((token: string) => {
    setActiveSavedFilterId(null);
    // Tri-state cycle: neutral → included → excluded → neutral. A token lives
    // on only one side, so each transition clears the other.
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
  }, []);

  const removeToken = useCallback((token: string) => {
    setActiveSavedFilterId(null);
    setTokenSelection((current) => ({
      included: current.included.filter((item) => item !== token),
      excluded: current.excluded.filter((item) => item !== token),
    }));
  }, []);

  const toggleProject = useCallback((projectId: string) => {
    setActiveSavedFilterId(null);
    setProjects((current) => toggleValue(current, projectId));
  }, []);
  const togglePriority = useCallback((priority: TaskPriority) => {
    setActiveSavedFilterId(null);
    setPriorities((current) => toggleValue(current, priority));
  }, []);
  const toggleEnergyLevel = useCallback((energyLevel: TaskEnergyLevel) => {
    setActiveSavedFilterId(null);
    setEnergyLevels((current) => toggleValue(current, energyLevel));
  }, []);
  const toggleTimeEstimate = useCallback((estimate: TimeEstimate) => {
    setActiveSavedFilterId(null);
    setTimeEstimates((current) => toggleValue(current, estimate));
  }, []);
  const setLocation = useCallback((value: string) => {
    setActiveSavedFilterId(null);
    setLocationQuery(value);
  }, []);
  const setMatchMode = useCallback((kind: 'context' | 'tag', mode: MultiValueFilterMatchMode) => {
    setActiveSavedFilterId(null);
    if (kind === 'context') setContextMatchMode(mode);
    else setTagMatchMode(mode);
  }, []);

  const clear = useCallback(() => {
    setActiveSavedFilterId(null);
    setSearchQuery('');
    setTokenSelection(NO_TOKENS);
    setProjects([]);
    setPriorities([]);
    setEnergyLevels([]);
    setTimeEstimates([]);
    setLocationQuery('');
    setContextMatchMode('all');
    setTagMatchMode('all');
    onClear?.();
  }, [onClear]);

  /**
   * Detach from the applied saved filter, keeping the selections. For view
   * state the filter also carries (sort, grouping): changing it means you are
   * no longer looking at that saved filter.
   */
  const unbindSaved = useCallback(() => setActiveSavedFilterId(null), []);

  const applySaved = useCallback((filter: SavedFilter) => {
    const selections = selectionsFromCriteria(filter.criteria);
    setTokenSelection({ included: selections.tokens, excluded: selections.excludedTokens });
    setProjects(selections.projects);
    setPriorities(selections.priorities);
    setEnergyLevels(selections.energyLevels);
    setTimeEstimates(selections.timeEstimates);
    setLocationQuery(selections.locations[0] ?? '');
    setContextMatchMode(selections.contextMatchMode);
    setTagMatchMode(selections.tagMatchMode);
    setActiveSavedFilterId(filter.id);
  }, []);

  const { included: tokens, excluded: excludedTokens } = tokenSelection;
  const currentCriteria = useMemo(() => criteriaFromSelections({
    tokens,
    excludedTokens,
    projects,
    locations: visibility.location && locationQuery.trim() ? [locationQuery.trim()] : [],
    priorities: visibility.priority ? priorities : [],
    energyLevels: visibility.energyLevel ? energyLevels : [],
    timeEstimates: visibility.timeEstimate ? timeEstimates : [],
    contextMatchMode,
    tagMatchMode,
  }), [
    contextMatchMode,
    energyLevels,
    excludedTokens,
    locationQuery,
    priorities,
    projects,
    tagMatchMode,
    timeEstimates,
    tokens,
    visibility.energyLevel,
    visibility.location,
    visibility.priority,
    visibility.timeEstimate,
  ]);

  // An applied saved filter can carry criteria no picker can express (areas,
  // date ranges), so it filters from its own criteria rather than the
  // round-tripped selections — still gated by what this view can show.
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
      result.push({ id: `project:${projectId}`, label, onPress: () => toggleProject(projectId) });
    });
    if (visibility.priority) {
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
    if (visibility.timeEstimate) {
      timeEstimates.forEach((estimate) => {
        result.push({
          id: `time:${estimate}`,
          label: formatTimeEstimateLabel(estimate),
          onPress: () => toggleTimeEstimate(estimate),
        });
      });
    }
    const normalizedLocation = locationQuery.trim();
    // A saved filter owns its location criterion; removing it belongs to the
    // saved filter, not to this picker, so no removable chip is offered.
    if (visibility.location && normalizedLocation && !activeSavedFilter) {
      result.push({
        id: 'location',
        label: `${tFallback(t, 'taskEdit.locationLabel', 'Location')}: ${normalizedLocation}`,
        onPress: () => setLocation(''),
      });
    }
    return result;
  }, [
    activeSavedFilter,
    energyLevels,
    excludedTokens,
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
  ]);

  return {
    view,
    // selections
    searchQuery,
    tokens,
    excludedTokens,
    projects,
    priorities,
    energyLevels,
    timeEstimates,
    locationQuery,
    contextMatchMode,
    tagMatchMode,
    // derived
    criteria,
    currentCriteria,
    activeCount,
    hasActive,
    hasCurrentCriteria,
    canSave,
    chips,
    activeSavedFilterId,
    activeSavedFilter,
    // The match mode only means something once several tokens of a kind compete.
    showContextMatchMode: selectedContextCount > 1,
    showTagMatchMode: selectedTagCount > 1,
    // actions
    setSearchQuery,
    setLocation,
    setMatchMode,
    toggleToken,
    removeToken,
    toggleProject,
    togglePriority,
    toggleEnergyLevel,
    toggleTimeEstimate,
    clear,
    applySaved,
    unbindSaved,
  };
}
