import { useEffect, useRef } from 'react';
import { type Task, type TaskStatus, useTaskStore, isTaskInActiveProject, getSequentialFirstTaskIds, isSequentialChainStatus } from '@mindwtr/core';
import { useConditionalMemo } from './useConditionalMemo';
import { useProgressiveComputation } from './useProgressiveComputation';

export type ListViewPerf = {
    trackUseMemo?: () => void;
    measure?: <T>(label: string, fn: () => T) => T;
};

export function useListViewOptimizations(
    tasks: Task[],
    baseTasks: Task[],
    statusFilter: TaskStatus | 'all',
    perf?: ListViewPerf,
) {
    const perfRef = useRef<ListViewPerf | undefined>(perf);
    useEffect(() => {
        perfRef.current = perf;
    }, [perf]);

    const getDerivedState = useTaskStore((state) => state.getDerivedState);
    const derived = getDerivedState();
    const allContexts = derived.allContexts;
    const allTags = derived.allTags;
    const projectMap = derived.projectMap;
    const sequentialProjectIds = derived.sequentialProjectIds;
    const sequentialWithinSectionProjectIds = derived.sequentialWithinSectionProjectIds;
    const tasksById = derived.tasksById;

    const sequentialProjectFirstTasks = useConditionalMemo(
        statusFilter === 'next',
        () => {
            const perfApi = perfRef.current;
            perfApi?.trackUseMemo?.();
            const compute = () => {
                if (sequentialProjectIds.size === 0) return new Set<string>();
                // Waiting tasks hold their chain slot too: a waiting first
                // step keeps later next tasks out of the Next list.
                return getSequentialFirstTaskIds(
                    baseTasks.filter((task) => !task.deletedAt && isSequentialChainStatus(task.status)),
                    sequentialProjectIds,
                    { sectionScopedProjectIds: sequentialWithinSectionProjectIds },
                );
            };

            return perfApi?.measure ? perfApi.measure('sequentialProjectFirstTasks', compute) : compute();
        },
        [baseTasks, sequentialProjectIds, sequentialWithinSectionProjectIds],
        new Set<string>(),
    );

    const tokenCounts = useProgressiveComputation(
        () => {
            const perfApi = perfRef.current;
            perfApi?.trackUseMemo?.();
            const compute = () => {
                const allowDeferredProjectTasks = statusFilter === 'done' || statusFilter === 'archived';
                const hideProjectTasksInDeferredList = statusFilter === 'someday' || statusFilter === 'waiting';
                const counts: Record<string, number> = {};
                tasks
                    .filter((task) => {
                        if (task.deletedAt) return false;
                        if (statusFilter !== 'all' && task.status !== statusFilter) return false;
                        if (!allowDeferredProjectTasks && !isTaskInActiveProject(task, projectMap)) return false;
                        if (hideProjectTasksInDeferredList && task.projectId && projectMap.get(task.projectId)) return false;
                        return true;
                    })
                    .forEach((task) => {
                        const tokens = new Set([...(task.contexts || []), ...(task.tags || [])]);
                        tokens.forEach((token) => {
                            counts[token] = (counts[token] || 0) + 1;
                        });
                    });
                return counts;
            };
            return perfApi?.measure ? perfApi.measure('tokenCounts', compute) : compute();
        },
        [tasks, statusFilter, projectMap],
        {},
        'low',
    );

    const nextCount = useProgressiveComputation(
        () => {
            const perfApi = perfRef.current;
            perfApi?.trackUseMemo?.();
            const compute = () => {
                let count = 0;
                for (const task of tasks) {
                    if (task.deletedAt) continue;
                    if (task.status !== 'next') continue;
                    if (!isTaskInActiveProject(task, projectMap)) continue;
                    count += 1;
                }
                return count;
            };
            return perfApi?.measure ? perfApi.measure('nextCount', compute) : compute();
        },
        [tasks, projectMap],
        0,
        'low',
    );

    return {
        allContexts,
        allTags,
        projectMap,
        sequentialProjectIds,
        sequentialProjectFirstTasks,
        tasksById,
        tokenCounts,
        nextCount,
    };
}
