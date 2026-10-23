import { getProjectAccentColor } from '@mindwtr/core';
import {
    buildAdvancedFilterCriteriaChips,
    formatTimeEstimateLabel,
    removeAdvancedFilterCriteriaChip,
    SAVED_FILTER_NO_PROJECT_ID,
} from '@mindwtr/core';
import type { FilterCriteria, Project } from '@mindwtr/core';

import type { DesktopActiveFilterChip } from './FilterDisclosure';

/**
 * Filter criteria → the removable chips a desktop view shows above its list,
 * written once instead of once per view (List, Archive, Board, Agenda).
 *
 * Pure: no store, no React. The view keeps its own chips (search, waiting
 * person, location), maps `chip.id` to an `onRemove`, and decides where the
 * built chips sit. `removeFilterChipFromCriteria` is the inverse, so a chip a
 * view shows is always a chip that view can take away again.
 *
 * `inactive` is computed here, never passed in: a chip whose value is missing
 * from `appliedCriteria` is one the view holds but does not filter by (a
 * priority while the category is gated off, a context in Reference). It is
 * shown muted, stays removable, and must not count as "filtered".
 */
export type ActiveFilterChip = Omit<DesktopActiveFilterChip, 'onRemove'>;

export type ActiveFilterChipDeps = {
    t: (key: string) => string;
    resolveText: (key: string, fallback: string) => string;
    getProject: (projectId: string) => Pick<Project, 'title' | 'color' | 'colorOverride' | 'areaId'> | undefined;
    getAreaColor: (areaId: string) => string | undefined;
    getAreaLabel: (areaId: string) => string | undefined;
};

export type ActiveFilterChipOptions = {
    /** What the view really filters by. A chip whose value is missing here is `inactive`. Default: `criteria`. */
    appliedCriteria?: FilterCriteria;
    /** Board: show a due-date preset as a plain chip after projects, not as an advanced chip. */
    duePresetAsBasic?: boolean;
    /** Board: priority / energy / time chips carry `isAdvanced`. */
    metadataAsAdvanced?: boolean;
};

type ListKey = 'contexts' | 'tags' | 'excludedContexts' | 'excludedTags' | 'projects' | 'priority' | 'energy' | 'timeEstimates';

const inactiveFlag = (applied: FilterCriteria, key: ListKey, value: string): { inactive?: true } => (
    (applied[key] as string[] | undefined)?.includes(value) ? {} : { inactive: true }
);

const duePreset = (criteria: FilterCriteria): string | undefined => (
    criteria.dueDateRange && 'preset' in criteria.dueDateRange ? criteria.dueDateRange.preset : undefined
);

/** token, excluded-token, project, [due preset], priority, energy, time — in that order. */
export function buildSelectionChips(
    criteria: FilterCriteria,
    deps: ActiveFilterChipDeps,
    options: ActiveFilterChipOptions = {},
): ActiveFilterChip[] {
    const applied = options.appliedCriteria ?? criteria;
    const chips: ActiveFilterChip[] = [];
    const advanced = options.metadataAsAdvanced ? { isAdvanced: true as const } : {};

    const pushTokens = (key: 'contexts' | 'tags' | 'excludedContexts' | 'excludedTags', excluded: boolean) => {
        (criteria[key] ?? []).forEach((token) => {
            chips.push({
                id: `${excluded ? 'excluded-token' : 'token'}:${token}`,
                label: token,
                ...(excluded ? { excluded: true } : {}),
                ...inactiveFlag(applied, key, token),
            });
        });
    };
    pushTokens('contexts', false);
    pushTokens('tags', false);
    pushTokens('excludedContexts', true);
    pushTokens('excludedTags', true);

    (criteria.projects ?? []).forEach((projectId) => {
        const project = deps.getProject(projectId);
        chips.push({
            id: `project:${projectId}`,
            label: projectId === SAVED_FILTER_NO_PROJECT_ID
                ? deps.resolveText('taskEdit.noProjectOption', 'No project')
                : project?.title ?? projectId,
            dotColor: project
                ? getProjectAccentColor(project, new Map(project.areaId ? [[project.areaId, { color: deps.getAreaColor(project.areaId) }]] : []))
                : undefined,
            ...inactiveFlag(applied, 'projects', projectId),
        });
    });

    if (options.duePresetAsBasic) {
        const preset = duePreset(criteria);
        if (preset) {
            chips.push({
                id: 'dueDateRange',
                label: `${deps.resolveText('taskEdit.dueDateLabel', 'Due date')}: ${deps.t(`filters.datePreset.${preset}`)}`,
                ...(duePreset(applied) === preset ? {} : { inactive: true }),
            });
        }
    }

    (criteria.priority ?? []).forEach((priority) => {
        chips.push({
            id: `priority:${priority}`,
            label: priority === 'none' ? deps.t('focus.group.noPriority') : deps.t(`priority.${priority}`),
            ...advanced,
            ...inactiveFlag(applied, 'priority', priority),
        });
    });
    (criteria.energy ?? []).forEach((energy) => {
        chips.push({
            id: `energy:${energy}`,
            label: deps.t(`energyLevel.${energy}`),
            ...advanced,
            ...inactiveFlag(applied, 'energy', energy),
        });
    });
    (criteria.timeEstimates ?? []).forEach((estimate) => {
        chips.push({
            id: `time:${estimate}`,
            label: formatTimeEstimateLabel(estimate, { t: deps.t }),
            ...advanced,
            ...inactiveFlag(applied, 'timeEstimates', estimate),
        });
    });

    return chips;
}

/** Core's advanced chips, ids prefixed `advanced:`, `isAdvanced: true`, `inactive` from `appliedCriteria`. */
export function buildAdvancedChips(
    criteria: FilterCriteria,
    deps: ActiveFilterChipDeps,
    options: ActiveFilterChipOptions = {},
): ActiveFilterChip[] {
    const applied = options.appliedCriteria ?? criteria;
    const chipOptions = {
        getAreaColor: deps.getAreaColor,
        getAreaLabel: deps.getAreaLabel,
        resolveText: deps.resolveText,
    };
    // Board already showed the due preset as a plain chip, so it must not come
    // back a second time as an advanced one.
    const withoutDuePreset = (value: FilterCriteria): FilterCriteria => (
        options.duePresetAsBasic ? { ...value, dueDateRange: undefined } : value
    );
    const appliedIds = new Set(
        buildAdvancedFilterCriteriaChips(withoutDuePreset(applied), chipOptions).map((chip) => chip.id),
    );
    return buildAdvancedFilterCriteriaChips(withoutDuePreset(criteria), chipOptions).map((chip) => ({
        id: `advanced:${chip.id}`,
        label: chip.label,
        dotColor: chip.color,
        isAdvanced: true,
        ...(appliedIds.has(chip.id) ? {} : { inactive: true }),
    }));
}

/** buildSelectionChips + buildAdvancedChips (due preset left out of the advanced part when `duePresetAsBasic`). */
export function buildActiveFilterChips(
    criteria: FilterCriteria,
    deps: ActiveFilterChipDeps,
    options: ActiveFilterChipOptions = {},
): ActiveFilterChip[] {
    return [...buildSelectionChips(criteria, deps, options), ...buildAdvancedChips(criteria, deps, options)];
}

/** The inverse of the builders: the criteria without the value that chip stands for. Unknown id → same object back. */
export function removeFilterChipFromCriteria(criteria: FilterCriteria, chipId: string): FilterCriteria {
    const next = { ...criteria };
    // Dropping the key, not leaving an empty array: `hasActiveFilterCriteria`
    // counts an empty array as active, which keeps the "filtered" badge lit
    // with nothing selected.
    const removeValue = (key: ListKey, value: string) => {
        const current = criteria[key];
        if (!Array.isArray(current)) return;
        const values = current.filter((item) => item !== value);
        if (values.length > 0) Object.assign(next, { [key]: values });
        else delete next[key];
    };

    if (chipId.startsWith('token:')) {
        const token = chipId.slice('token:'.length);
        removeValue(token.trim().startsWith('#') ? 'tags' : 'contexts', token);
    } else if (chipId.startsWith('excluded-token:')) {
        const token = chipId.slice('excluded-token:'.length);
        removeValue(token.trim().startsWith('#') ? 'excludedTags' : 'excludedContexts', token);
    } else if (chipId.startsWith('project:')) {
        removeValue('projects', chipId.slice('project:'.length));
    } else if (chipId.startsWith('priority:')) {
        removeValue('priority', chipId.slice('priority:'.length));
    } else if (chipId.startsWith('energy:')) {
        removeValue('energy', chipId.slice('energy:'.length));
    } else if (chipId.startsWith('time:')) {
        removeValue('timeEstimates', chipId.slice('time:'.length));
    } else if (chipId.startsWith('advanced:')) {
        return removeAdvancedFilterCriteriaChip(criteria, chipId.slice('advanced:'.length));
    } else if (chipId === 'dueDateRange') {
        return removeAdvancedFilterCriteriaChip(criteria, 'dueDateRange');
    } else {
        return criteria;
    }
    return next;
}
