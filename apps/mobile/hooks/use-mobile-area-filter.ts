import { useCallback, useEffect, useMemo } from 'react';
import {
  AREA_FILTER_ALL,
  AREA_FILTER_NONE,
  areaFilterSelectionToFilters,
  areaFilterSelectionToValue,
  resolveAreaFilterSelection,
  type AreaFilterSelection,
  type FilterSettings,
  useTaskStore,
} from '@mindwtr/core';

let staleAreaFilterResetInFlight: string | null = null;

const filterKey = (filters: FilterSettings | undefined) => [
  filters?.areaId ?? '',
  (filters?.areaIds ?? []).join(' '),
  (filters?.excludedAreaIds ?? []).join(' '),
].join('|');

export function useMobileAreaFilter() {
  const areas = useTaskStore((state) => state.areas);
  const settings = useTaskStore((state) => state.settings);
  const updateSettings = useTaskStore((state) => state.updateSettings);
  const filterSettings: FilterSettings | undefined = settings?.filters;
  const storedFilterKey = filterKey(filterSettings);

  const sortedAreas = useMemo(() => (
    [...areas]
      .filter((area) => !area.deletedAt)
      .sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        return a.name.localeCompare(b.name);
      })
  ), [areas]);

  const areaById = useMemo(
    () => new Map(sortedAreas.map((area) => [area.id, area])),
    [sortedAreas],
  );

  const resolvedAreaFilter = useMemo(
    () => resolveAreaFilterSelection(filterSettings, sortedAreas),
    [filterSettings, sortedAreas],
  );
  // True once the stored filter names an area that no longer exists, so the
  // resolved selection is narrower than what was saved.
  const didResetDeletedAreaFilter = useMemo(() => {
    const hasLists = Boolean(filterSettings?.areaIds || filterSettings?.excludedAreaIds);
    const stored = hasLists
      ? [...(filterSettings?.areaIds ?? []), ...(filterSettings?.excludedAreaIds ?? [])]
      : [filterSettings?.areaId ?? ''];
    return stored.some((id) => (
      id
      && id !== AREA_FILTER_ALL
      && id !== AREA_FILTER_NONE
      && !sortedAreas.some((area) => area.id === id)
    ));
  }, [filterSettings, sortedAreas]);

  useEffect(() => {
    if (!didResetDeletedAreaFilter) return;
    if (staleAreaFilterResetInFlight === storedFilterKey) return;
    staleAreaFilterResetInFlight = storedFilterKey;
    void updateSettings({
      filters: {
        ...(filterSettings ?? {}),
        ...areaFilterSelectionToFilters(resolvedAreaFilter),
      },
    }).finally(() => {
      if (staleAreaFilterResetInFlight === storedFilterKey) {
        staleAreaFilterResetInFlight = null;
      }
    });
  }, [didResetDeletedAreaFilter, filterSettings, resolvedAreaFilter, storedFilterKey, updateSettings]);

  const setAreaFilter = useCallback((selection: AreaFilterSelection) => {
    void updateSettings({
      filters: {
        ...(filterSettings ?? {}),
        ...areaFilterSelectionToFilters(selection),
      },
    });
  }, [filterSettings, updateSettings]);

  const selectedAreaIdForNewTasks = useMemo(() => {
    const value = areaFilterSelectionToValue(resolvedAreaFilter);
    if (value === AREA_FILTER_ALL) return undefined;
    if (value === AREA_FILTER_NONE) return null;
    return value;
  }, [resolvedAreaFilter]);

  return {
    areaById,
    didResetDeletedAreaFilter,
    resolvedAreaFilter,
    selectedAreaIdForNewTasks,
    setAreaFilter,
    sortedAreas,
  };
}
