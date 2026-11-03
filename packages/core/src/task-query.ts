import { isTaskVisible } from './store-helpers';
import type { Task } from './types';
import type { TaskQueryOptions } from './storage';


export const taskMatchesQuery = (task: Task, query: TaskQueryOptions): boolean => {
    const includeArchived = query.includeArchived === true;
    const includeDeleted = query.includeDeleted === true;
    if (!isTaskVisible(task, { includeArchived, includeDeleted })) return false;
    if (query.status && query.status !== 'all' && task.status !== query.status) return false;
    if (query.excludeStatuses && query.excludeStatuses.length > 0 && query.excludeStatuses.includes(task.status)) return false;
    if (query.projectId && task.projectId !== query.projectId) return false;
    if (query.isFocusedToday !== undefined && Boolean(task.isFocusedToday) !== query.isFocusedToday) return false;
    return true;
};


export const buildTaskWhere = (query: TaskQueryOptions): { sql: string; params: unknown[] } => {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.includeDeleted !== true) {
        where.push('deletedAt IS NULL');
    }
    if (query.includeArchived !== true) {
        where.push("status != 'archived'");
    }
    if (query.status && query.status !== 'all') {
        where.push('status = ?');
        params.push(query.status);
    }
    if (query.excludeStatuses && query.excludeStatuses.length > 0) {
        where.push(`status NOT IN (${query.excludeStatuses.map(() => '?').join(', ')})`);
        params.push(...query.excludeStatuses);
    }
    if (query.projectId) {
        where.push('projectId = ?');
        params.push(query.projectId);
    }
    if (query.isFocusedToday !== undefined) {
        where.push('COALESCE(isFocusedToday, 0) = ?');
        params.push(query.isFocusedToday ? 1 : 0);
    }
    return { sql: where.join(' AND '), params };
};
