import { getProjectAccentColor } from '@mindwtr/core';
import {
    buildAdvancedFilterCriteriaChips,
    formatTimeEstimateLabel,
    removeAdvancedFilterCriteriaChip,
    SAVED_FILTER_NO_PROJECT_ID,
} from '@mindwtr/core';
import type { FilterCriteria, Project } from '@mindwtr/core';

import type { DesktopActiveFilterChip } from './FilterDisclosure';


export type ActiveFilterChip = Omit<DesktopActiveFilterChip, 'onRemove'>;

export type ActiveFilterChipDeps = {
    t: (key: string) => string;
    resolveText: (key: string, fallback: string) => string;
    getProject: (projectId: string) => Pick<Project, 'title' | 'color' | 'colorOverride' | 'areaId'> | undefined;
    getAreaColor: (areaId: string) => string | undefined;
    getAreaLabel: (areaId: string) => string | undefined;
    theme?: string;
};

export type ActiveFilterChipOptions = {

    appliedCriteria?: FilterCriteria;

    duePresetAsBasic?: boolean;

    metadataAsAdvanced?: boolean;
};

type ListKey = 'contexts' | 'tags' | 'excludedContexts' | 'excludedTags' | 'projects' | 'priority' | 'energy' | 'timeEstimates';

const inactiveFlag = (applied: FilterCriteria, key: ListKey, value: string): { inactive?: true } => (
    (applied[key] as string[] | undefined)?.includes(value) ? {} : { inactive: true }
);

const duePreset = (criteria: FilterCriteria): string | undefined => (
    criteria.dueDateRange && 'preset' in criteria.dueDateRange ? criteria.dueDateRange.preset : undefined
);


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
                ? getProjectAccentColor(project, new Map(project.areaId ? [[project.areaId, { color: deps.getAreaColor(project.areaId) }]] : []), deps.theme)
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


export function buildAdvancedChips(
    criteria: FilterCriteria,
    deps: ActiveFilterChipDeps,
    options: ActiveFilterChipOptions = {},
): ActiveFilterChip[] {
    const applied = options.appliedCriteria ?? criteria;
    const chipOptions = {
        getAreaColor: deps.getAreaColor,
        getAreaLabel: deps.getAreaLabel,
        getProjectLabel: (id: string) => id === SAVED_FILTER_NO_PROJECT_ID ? deps.resolveText('taskEdit.noProjectOption', 'No project') : deps.getProject(id)?.title,
        resolveText: deps.resolveText,
    };


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


export function buildActiveFilterChips(
    criteria: FilterCriteria,
    deps: ActiveFilterChipDeps,
    options: ActiveFilterChipOptions = {},
): ActiveFilterChip[] {
    return [...buildSelectionChips(criteria, deps, options), ...buildAdvancedChips(criteria, deps, options)];
}


export function removeFilterChipFromCriteria(criteria: FilterCriteria, chipId: string): FilterCriteria {
    const next = { ...criteria };


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
