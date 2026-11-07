import type { Area, FilterSettings, Project, Task } from './types';
import { getTaskAreaId } from './task-utils';
import { isTaskInActiveProject } from './project-utils';

export const AREA_FILTER_ALL = '__all__';
export const AREA_FILTER_NONE = '__none__';

export type AreaFilterValue = typeof AREA_FILTER_ALL | typeof AREA_FILTER_NONE | string;


export interface AreaFilterSelection {
    included: string[];
    excluded: string[];
}

function resolveAreaFilter(value: string | undefined, areas: Area[]): AreaFilterValue {
    if (!value || value === AREA_FILTER_ALL || value === AREA_FILTER_NONE) {
        return value ?? AREA_FILTER_ALL;
    }
    return areas.some((area) => !area.deletedAt && area.id === value) ? value : AREA_FILTER_ALL;
}

const isSelectableAreaId = (id: string, areas: Area[]): boolean =>
    id === AREA_FILTER_NONE || areas.some((area) => !area.deletedAt && area.id === id);

const sanitizeAreaIds = (value: unknown, areas: Area[]): string[] => {
    if (!Array.isArray(value)) return [];
    const kept: string[] = [];
    for (const id of value) {
        if (typeof id === 'string' && !kept.includes(id) && isSelectableAreaId(id, areas)) kept.push(id);
    }
    return kept;
};


export function resolveAreaFilterSelection(value: unknown, areas: Area[]): AreaFilterSelection {
    if (value == null || typeof value === 'string') {
        const resolved = resolveAreaFilter(value ?? undefined, areas);
        return { included: resolved === AREA_FILTER_ALL ? [] : [resolved], excluded: [] };
    }
    if (typeof value !== 'object') return { included: [], excluded: [] };
    const source = value as {
        areaId?: unknown;
        areaIds?: unknown;
        excludedAreaIds?: unknown;
        included?: unknown;
        excluded?: unknown;
    };
    const includedSource = source.areaIds ?? source.included;
    const excludedSource = source.excludedAreaIds ?? source.excluded;
    if (!Array.isArray(includedSource) && !Array.isArray(excludedSource)) {
        return resolveAreaFilterSelection(typeof source.areaId === 'string' ? source.areaId : undefined, areas);
    }
    return {
        included: sanitizeAreaIds(includedSource, areas),
        excluded: sanitizeAreaIds(excludedSource, areas),
    };
}

export function isAreaFilterSelectionActive(selection: AreaFilterSelection): boolean {
    return selection.included.length > 0 || selection.excluded.length > 0;
}


export function areaFilterSelectionToValue(selection: AreaFilterSelection): AreaFilterValue {
    if (selection.excluded.length > 0 || selection.included.length !== 1) return AREA_FILTER_ALL;
    return selection.included[0];
}


export function areaFilterSelectionToFilters(selection: AreaFilterSelection): Required<Pick<FilterSettings, 'areaId' | 'areaIds' | 'excludedAreaIds'>> {
    return {
        areaId: areaFilterSelectionToValue(selection),
        areaIds: selection.included,
        excludedAreaIds: selection.excluded,
    };
}


export function cycleAreaFilterSelection(selection: AreaFilterSelection, id: string): AreaFilterSelection {
    if (selection.included.includes(id)) {
        return {
            included: selection.included.filter((entry) => entry !== id),
            excluded: [...selection.excluded, id],
        };
    }
    if (selection.excluded.includes(id)) {
        return {
            included: selection.included,
            excluded: selection.excluded.filter((entry) => entry !== id),
        };
    }
    return { included: [...selection.included, id], excluded: selection.excluded };
}

const normalizeAreaId = (areaId: string | undefined, areaById?: Map<string, Area>): string | undefined => {
    if (!areaId) return undefined;
    if (areaById && !areaById.has(areaId)) return undefined;
    return areaId;
};


export function isAreaVisibleInSelection(selection: AreaFilterSelection, id: string): boolean {
    if (selection.excluded.includes(id)) return false;
    return selection.included.length === 0 || selection.included.includes(id);
}

export function toggleAreaVisibility(
    selection: AreaFilterSelection,
    id: string,
    optionIds: readonly string[],
): AreaFilterSelection {
    const wasVisible = isAreaVisibleInSelection(selection, id);
    const visible = optionIds.filter((optionId) => (
        optionId === id ? !wasVisible : isAreaVisibleInSelection(selection, optionId)
    ));
    if (visible.length === optionIds.length) return { included: [], excluded: [] };
    if (visible.length === 1) return { included: [visible[0]], excluded: [] };
    return { included: [], excluded: optionIds.filter((optionId) => !visible.includes(optionId)) };
}

export function excludeAllAreas(optionIds: readonly string[]): AreaFilterSelection {
    return { included: [], excluded: [...optionIds] };
}

const areaIdMatchesSelection = (areaId: string | undefined, selection: AreaFilterSelection): boolean =>
    isAreaVisibleInSelection(selection, areaId ?? AREA_FILTER_NONE);

export function projectMatchesAreaFilterSelection(
    project: Project,
    selection: AreaFilterSelection,
    areaById?: Map<string, Area>,
): boolean {
    if (!isAreaFilterSelectionActive(selection)) return true;
    return areaIdMatchesSelection(normalizeAreaId(project.areaId, areaById), selection);
}

export function taskMatchesAreaFilterSelection(
    task: Task,
    selection: AreaFilterSelection,
    projectMap: Map<string, Project>,
    areaById?: Map<string, Area>,
): boolean {
    if (!isAreaFilterSelectionActive(selection)) return true;
    return areaIdMatchesSelection(normalizeAreaId(getTaskAreaId(task, projectMap), areaById), selection);
}


export interface AreaVisibilityContext {
    areaById?: Map<string, Area>;
    projectById: Map<string, Project>;
    resolvedAreaFilter: AreaFilterSelection;
}


export function isTaskVisibleInArea(task: Task, ctx: AreaVisibilityContext): boolean {
    return !task.deletedAt
        && isTaskInActiveProject(task, ctx.projectById)
        && taskMatchesAreaFilterSelection(task, ctx.resolvedAreaFilter, ctx.projectById, ctx.areaById);
}


export function isTaskVisibleInInbox(
    task: Task,
    ctx: Pick<AreaVisibilityContext, 'projectById'>,
): boolean {
    return !task.deletedAt && isTaskInActiveProject(task, ctx.projectById);
}
