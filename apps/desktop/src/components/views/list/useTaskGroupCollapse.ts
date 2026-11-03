import { useCallback, useMemo } from 'react';
import type { Task } from '@mindwtr/core';
import { usePersistedViewState } from '../../../hooks/usePersistedViewState';
import {
    buildGroupedVirtualRows,
    flattenVisibleGroupTasks,
    type GroupedVirtualRow,
} from './GroupedTaskSections';
import {
    emptyCollapsedGroups,
    sanitizeCollapsedGroups,
    type CollapsedGroups,
    type TaskGroup,
    type TaskGroupAxis,
} from './next-grouping';


export function getGroupDomIdSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'group';
}

export function buildSectionDomId(
    idPrefix: string,
    axis: string,
    groupIndex: number,
    groupId: string,
): string {
    return `${idPrefix}-${getGroupDomIdSegment(axis)}-${groupIndex}-${getGroupDomIdSegment(groupId)}`;
}

type SetCollapsedGroups<Axis extends TaskGroupAxis> = (
    updater: (current: CollapsedGroups<Axis>) => CollapsedGroups<Axis>,
) => void;


export function useCollapsedGroupsViewState<Axis extends TaskGroupAxis>(
    storageKey: string,
    axes: readonly Axis[],
): { collapsedGroups: CollapsedGroups<Axis>; setCollapsedGroups: SetCollapsedGroups<Axis> } {
    const fallback = useMemo(() => ({ collapsedGroups: emptyCollapsedGroups(axes) }), [axes]);
    const sanitize = useCallback((value: unknown, current: { collapsedGroups: CollapsedGroups<Axis> }) => {
        const parsed = value && typeof value === 'object' && !Array.isArray(value)
            ? value as { collapsedGroups?: unknown }
            : {};
        return {
            collapsedGroups: sanitizeCollapsedGroups(axes, parsed.collapsedGroups, current.collapsedGroups),
        };
    }, [axes]);
    const [state, setState] = usePersistedViewState(storageKey, fallback, sanitize);
    const setCollapsedGroups = useCallback<SetCollapsedGroups<Axis>>((updater) => {
        setState((current) => ({ collapsedGroups: updater(current.collapsedGroups) }));
    }, [setState]);
    return { collapsedGroups: state.collapsedGroups, setCollapsedGroups };
}

type TaskGroupCollapseOptions<Axis extends TaskGroupAxis> = {

    axis: Axis;

    groups: TaskGroup[];

    tasks: Task[];

    idPrefix: string;
    collapsedGroups: CollapsedGroups<Axis>;
    setCollapsedGroups: SetCollapsedGroups<Axis>;
};


export function useTaskGroupCollapse<Axis extends TaskGroupAxis>({
    axis,
    groups,
    tasks,
    idPrefix,
    collapsedGroups,
    setCollapsedGroups,
}: TaskGroupCollapseOptions<Axis>): {
    isGrouping: boolean;
    collapsedGroupIds: Set<string>;
    toggleGroup: (groupId: string) => void;
    getSectionDomId: (group: TaskGroup, groupIndex: number) => string;

    virtualRows: GroupedVirtualRow[] | null;
    visibleTasks: Task[];
} {
    const isGrouping = axis !== 'none';
    const collapseKey = isGrouping ? axis as Exclude<Axis, 'none'> : null;
    const collapsedGroupIds = useMemo(
        () => new Set(collapseKey ? collapsedGroups[collapseKey] ?? [] : []),
        [collapseKey, collapsedGroups],
    );
    const toggleGroup = useCallback((groupId: string) => {
        if (!collapseKey) return;
        setCollapsedGroups((current) => {
            const nextIds = new Set(current[collapseKey] ?? []);
            if (nextIds.has(groupId)) {
                nextIds.delete(groupId);
            } else {
                nextIds.add(groupId);
            }
            return { ...current, [collapseKey]: Array.from(nextIds) };
        });
    }, [collapseKey, setCollapsedGroups]);
    const getSectionDomId = useCallback(
        (group: TaskGroup, groupIndex: number) => buildSectionDomId(idPrefix, axis, groupIndex, group.id),
        [axis, idPrefix],
    );


    const virtualRows = useMemo(
        () => (isGrouping ? buildGroupedVirtualRows(groups, collapsedGroupIds, getSectionDomId) : null),
        [collapsedGroupIds, getSectionDomId, groups, isGrouping],
    );
    const visibleTasks = useMemo(
        () => (isGrouping ? flattenVisibleGroupTasks(groups, collapsedGroupIds) : tasks),
        [collapsedGroupIds, groups, isGrouping, tasks],
    );

    return { isGrouping, collapsedGroupIds, toggleGroup, getSectionDomId, virtualRows, visibleTasks };
}
