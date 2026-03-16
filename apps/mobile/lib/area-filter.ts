import type { Area, Project, Task } from '@mindwtr/core';
import { getTaskAreaId } from '@mindwtr/core';

export const AREA_FILTER_ALL = '__all__';
export const AREA_FILTER_NONE = '__none__';

export type AreaFilterValue = typeof AREA_FILTER_ALL | typeof AREA_FILTER_NONE | string;

export function resolveAreaFilter(value: string | undefined, areas: Area[]): AreaFilterValue {
  if (!value || value === AREA_FILTER_ALL || value === AREA_FILTER_NONE) {
    return value ?? AREA_FILTER_ALL;
  }
  return areas.some((area) => !area.deletedAt && area.id === value) ? value : AREA_FILTER_ALL;
}

const normalizeAreaId = (areaId: string | undefined, areaById?: Map<string, Area>): string | undefined => {
  if (!areaId) return undefined;
  if (areaById && !areaById.has(areaId)) return undefined;
  return areaId;
};

export function projectMatchesAreaFilter(
  project: Project,
  filter: AreaFilterValue,
  areaById?: Map<string, Area>,
): boolean {
  if (filter === AREA_FILTER_ALL) return true;
  const effectiveAreaId = normalizeAreaId(project.areaId, areaById);
  if (filter === AREA_FILTER_NONE) return !effectiveAreaId;
  return effectiveAreaId === filter;
}

export function taskMatchesAreaFilter(
  task: Task,
  filter: AreaFilterValue,
  projectMap: Map<string, Project>,
  areaById?: Map<string, Area>,
): boolean {
  if (filter === AREA_FILTER_ALL) return true;
  const taskAreaId = normalizeAreaId(getTaskAreaId(task, projectMap), areaById);
  if (filter === AREA_FILTER_NONE) return !taskAreaId;
  return taskAreaId === filter;
}
