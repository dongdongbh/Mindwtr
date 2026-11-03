import { projectMatchesAreaFilterSelection, taskMatchesAreaFilterSelection, type AreaFilterSelection } from './area-filter';
import type { DateFormatter } from './date';
import { formatI18nTemplate, tFallback } from './i18n';
import { formatListItemCount } from './list-count';
import type { StoreActionResult, TaskStore } from './store-types';
import { DEFAULT_TOMBSTONE_RETENTION_DAYS } from './sync-tombstones';
import type { Area, Project, Task } from './types';


export type ListConfirmation = { title: string; message: string; cancelLabel: string; confirmLabel: string };


export function selectTrashedTasks(
    allTasks: Task[],
    selection: AreaFilterSelection,
    projectById: Map<string, Project>,
    areaById: Map<string, Area>,
): Task[] {
    return allTasks.filter((task) => (
        task.deletedAt && !task.purgedAt && taskMatchesAreaFilterSelection(task, selection, projectById, areaById)
    ));
}

export function selectTrashedProjects(
    allProjects: Project[],
    selection: AreaFilterSelection,
    areaById: Map<string, Area>,
): Project[] {
    return allProjects.filter((project) => (
        project.deletedAt && !project.purgedAt && projectMatchesAreaFilterSelection(project, selection, areaById)
    ));
}


export function formatTrashCounts(taskCount: number, projectCount: number, t: (key: string) => string): string {
    return `${formatListItemCount(taskCount, 'task', t)} · ${formatListItemCount(projectCount, 'project', t)}`;
}

export function getTrashRetentionHint(t: (key: string) => string): string {
    return formatI18nTemplate(
        tFallback(t, 'trash.retentionHint', 'Items in Trash are removed for good after {{days}} days'),
        { days: DEFAULT_TOMBSTONE_RETENTION_DAYS },
    );
}


export function formatTrashDeletedDate(deletedAt: string | undefined, formatDate: DateFormatter, notSetLabel: string): string {
    return formatDate(deletedAt, 'P', notSetLabel);
}

export function getTrashRowLabels(t: (key: string) => string) {
    return {
        taskType: tFallback(t, 'trash.taskType', 'Task'),
        projectType: tFallback(t, 'trash.projectType', 'Project'),
        deleted: tFallback(t, 'trash.deletedAt', 'Deleted'),
        restore: tFallback(t, 'trash.restore', 'Restore'),
        delete: tFallback(t, 'common.delete', 'Delete'),
        select: tFallback(t, 'bulk.select', 'Select'),
        notSet: tFallback(t, 'common.notSet', 'Not set'),
    };
}

export function getTrashEmptyState(t: (key: string) => string): { title: string; message: string } {
    return {
        title: tFallback(t, 'trash.empty', 'Trash is empty'),
        message: tFallback(t, 'trash.emptyHintWithProjects', 'Deleted tasks and projects will appear here'),
    };
}


export function getTrashPurgeConfirmation(
    target: { kind: 'item' } | { kind: 'selection' } | { kind: 'clear'; narrowed: boolean; taskCount: number; projectCount: number },
    t: (key: string) => string,
): ListConfirmation {
    const cancelLabel = tFallback(t, 'common.cancel', 'Cancel');
    const body = tFallback(t, 'trash.deleteConfirmBody', 'This action cannot be undone.');
    if (target.kind !== 'clear') {
        return {
            title: tFallback(t, 'trash.deleteConfirm', target.kind === 'item' ? 'Delete Permanently?' : 'Delete permanently?'),
            message: body,
            cancelLabel,
            confirmLabel: tFallback(t, 'trash.deletePermanently', 'Delete'),
        };
    }
    return {
        title: target.narrowed
            ? tFallback(t, 'trash.deleteConfirm', 'Delete permanently?')
            : tFallback(t, 'trash.clearAllConfirm', 'Clear trash?'),


        message: target.narrowed
            ? `${formatTrashCounts(target.taskCount, target.projectCount, t)}\n${body}`
            : tFallback(t, 'trash.clearAllConfirmBodyWithProjects', 'This will permanently delete all trashed tasks and projects.'),
        cancelLabel,
        confirmLabel: tFallback(t, 'trash.clearAll', 'Clear Trash'),
    };
}


export function getBulkTrashConfirmation(t: (key: string) => string): ListConfirmation {
    return {
        title: tFallback(t, 'bulk.confirmDeleteTitle', t('common.delete')),
        message: tFallback(t, 'bulk.confirmDeleteBody', t('list.confirmBatchDelete')),
        cancelLabel: t('common.cancel'),
        confirmLabel: t('common.delete'),
    };
}


export const getTrashUndoLabel = (t: (key: string) => string): string => tFallback(t, 'common.undo', 'Undo');

type TrashItemIds = { taskIds: string[]; projectIds: string[] };


export function restoreTrashItems(
    store: Pick<TaskStore, 'restoreTasks' | 'restoreProject'>,
    { taskIds, projectIds }: TrashItemIds,
): Promise<(StoreActionResult | undefined)[]> {
    return Promise.all([
        taskIds.length > 0 ? store.restoreTasks(taskIds) : Promise.resolve(undefined),
        ...projectIds.map((projectId) => store.restoreProject(projectId)),
    ]);
}


export function purgeTrashItems(
    store: Pick<TaskStore, 'purgeTasks' | 'purgeProject'>,
    { taskIds, projectIds }: TrashItemIds,
): Promise<(StoreActionResult | undefined)[]> {
    return Promise.all([
        taskIds.length > 0 ? store.purgeTasks(taskIds) : Promise.resolve(undefined),
        ...projectIds.map((projectId) => store.purgeProject(projectId)),
    ]);
}
