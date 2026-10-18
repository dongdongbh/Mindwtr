import {
    compareProjectsByOrder,
    compareTasksByProjectOrder,
    flushPendingSave,
    isTaskFinished,
    resolveTaskSortByForFeatures,
    runAfterStoreWriteLock,
    useTaskStore,
    type TaskStore,
} from '@mindwtr/core';
import { logInfo } from './app-log';

export type TimelineOrderTarget =
    | { kind: 'project'; id: string; areaId?: string }
    | { kind: 'task'; id: string; projectId: string; sectionId: string | null };
export type TimelineOrderSnapshot = { target: TimelineOrderTarget; token: string; orderedIds: string[] };

export const timelineOrderScope = (target: TimelineOrderTarget): string => JSON.stringify(target.kind === 'project'
    ? ['project', target.areaId ?? null] : ['task', target.projectId, target.sectionId]);

/** Capture the whole ordering scope, including work hidden by dates or filters. */
export function captureTimelineOrder(target: TimelineOrderTarget, state: TaskStore = useTaskStore.getState()): TimelineOrderSnapshot | null {
    const project = state._allProjects.find((row) => row.id === (target.kind === 'project' ? target.id : target.projectId));
    if (!project || project.deletedAt || project.purgedAt || project.status === 'archived') return null;
    if (target.kind === 'project') {
        if ((project.areaId ?? undefined) !== target.areaId) return null;
        const projects = state._allProjects.filter((row) => !row.deletedAt && !row.purgedAt
            && (row.areaId ?? undefined) === target.areaId).sort(compareProjectsByOrder);
        return { target, orderedIds: projects.map((row) => row.id), token: JSON.stringify(projects.map((row) => ({
            id: row.id, title: row.title, order: row.order, status: row.status, areaId: row.areaId,
            startDate: row.startDate, dueDate: row.dueDate,
        }))) };
    }
    if (resolveTaskSortByForFeatures(project.taskSortBy ?? 'default', state.settings) !== 'default') return null;
    const tasks = state._allTasks.filter((row) => row.projectId === project.id && !row.deletedAt && !row.purgedAt);
    const task = tasks.find((row) => row.id === target.id);
    if (!task || isTaskFinished(task) || (task.sectionId ?? null) !== target.sectionId) return null;
    const sections = state._allSections.filter((row) => row.projectId === project.id);
    const orderedIds = tasks.filter((row) => (row.sectionId ?? null) === target.sectionId)
        .sort(compareTasksByProjectOrder).map((row) => row.id);
    const token = JSON.stringify({
        project: { id: project.id, status: project.status, taskSortBy: project.taskSortBy,
            isSequential: project.isSequential, sequentialScope: project.sequentialScope },
        sections: [...sections].sort((a, b) => a.id.localeCompare(b.id)),
        tasks: [...tasks].sort((a, b) => a.id.localeCompare(b.id)).map((row) => ({
            id: row.id, sectionId: row.sectionId, order: row.order, orderNum: row.orderNum,
            createdAt: row.createdAt, status: row.status, cancelledAt: row.cancelledAt,
            startTime: row.startTime, dueDate: row.dueDate,
        })),
    });
    return { target, token, orderedIds };
}

export function commitTimelineOrder(snapshot: TimelineOrderSnapshot, over: TimelineOrderTarget): Promise<'saved' | 'noop' | 'conflict'> {
    return runAfterStoreWriteLock(async () => {
        if (timelineOrderScope(snapshot.target) !== timelineOrderScope(over)) return 'conflict';
        const live = captureTimelineOrder(snapshot.target);
        if (!live || live.token !== snapshot.token || !captureTimelineOrder(over)) return 'conflict';
        const from = live.orderedIds.indexOf(snapshot.target.id);
        const to = live.orderedIds.indexOf(over.id);
        if (from < 0 || to < 0) return 'conflict';
        if (from === to) return 'noop';
        const orderedIds = [...live.orderedIds];
        orderedIds.splice(from, 1);
        orderedIds.splice(to, 0, snapshot.target.id);
        const state = useTaskStore.getState();
        const write = snapshot.target.kind === 'project'
            ? state.reorderProjects(orderedIds, snapshot.target.areaId)
            : state.reorderProjectTasks(snapshot.target.projectId, orderedIds, snapshot.target.sectionId, snapshot.target.id);
        // Store order mutations apply synchronously, before yielding to persistence.
        const applied = captureTimelineOrder(snapshot.target);
        await write;
        if (!applied || applied.token === live.token) return 'noop';
        await flushPendingSave();
        if (captureTimelineOrder(snapshot.target)?.token !== applied.token) return 'conflict';
        void logInfo('Timeline shared order saved', {
            scope: 'timeline',
            extra: { releaseCheck: 'v1.3.7/timeline-shared-order', kind: snapshot.target.kind, outcome: 'saved' },
        }).catch(() => undefined);
        return 'saved';
    });
}
