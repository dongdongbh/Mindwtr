import { useEffect, useRef } from 'react';
import { type Task, type TaskStatus, useTaskStore, isReferenceInVisibleProject, isTaskInActiveProject, getSequentialFirstTaskIds, isSequentialChainStatus } from '@mindwtr/core';
import { useConditionalMemo } from './useConditionalMemo';
import { useProgressiveComputation } from './useProgressiveComputation';
import { logInfo } from '../lib/app-log';

let reportedTokenTimestampDerivation = false;

export type ListViewPerf = {
    trackUseMemo?: () => void;
    measure?: <T>(label: string, fn: () => T) => T;
};

export function useListViewOptimizations(
    tasks: Task[],
    baseTasks: Task[],
    statusFilter: TaskStatus | 'all',
    perf?: ListViewPerf,
    includeArchivedReferenceProjects = false,
) {
    const perfRef = useRef<ListViewPerf | undefined>(perf);
    useEffect(() => {
        perfRef.current = perf;
    }, [perf]);

    const getDerivedState = useTaskStore((state) => state.getDerivedState);
    const derived = getDerivedState();
    const allContexts = derived.allContexts;
    const allTags = derived.allTags;
    useEffect(() => {
        if (reportedTokenTimestampDerivation || (allContexts.length === 0 && allTags.length === 0)) return;
        reportedTokenTimestampDerivation = true;
        void logInfo('List token statistics available from shared timestamp derivation', {
            scope: 'perf', extra: { releaseCheck: 'v1.3.0/derived-token-timestamps' },
        });
    }, [allContexts, allTags]);
    const projectMap = derived.projectMap;
    const sequentialProjectIds = derived.sequentialProjectIds;
    const sequentialWithinSectionProjectIds = derived.sequentialWithinSectionProjectIds;
    const tasksById = derived.tasksById;
    const sections = useTaskStore((state) => state.sections);

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
                    { sectionScopedProjectIds: sequentialWithinSectionProjectIds, sections },
                );
            };

            return perfApi?.measure ? perfApi.measure('sequentialProjectFirstTasks', compute) : compute();
        },
        [baseTasks, sections, sequentialProjectIds, sequentialWithinSectionProjectIds],
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
                        if (statusFilter === 'reference') {
                            if (!isReferenceInVisibleProject(task, projectMap, includeArchivedReferenceProjects)) return false;
                        } else if (!allowDeferredProjectTasks && !isTaskInActiveProject(task, projectMap)) return false;
                        if (hideProjectTasksInDeferredList && task.projectId && projectMap.get(task.projectId)) return false;
                        return true;
                    })
                    .forEach((task) => {
                        const tokens = new Set(
                            statusFilter === 'reference'
                                ? task.tags
                                : [...(task.contexts || []), ...(task.tags || [])],
                        );
                        tokens.forEach((token) => {
                            counts[token] = (counts[token] || 0) + 1;
                        });
                    });
                return counts;
            };
            return perfApi?.measure ? perfApi.measure('tokenCounts', compute) : compute();
        },
        [tasks, statusFilter, projectMap, includeArchivedReferenceProjects],
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
