import { safeParseDate } from './date';
import type { Task } from './types';

type TaskTokenSelector = (task: Task) => readonly (string | null | undefined)[] | null | undefined;

export type TaskTokenUsage = {
    token: string;
    count: number;
    lastUsedAt: number;
};

type TaskTokenOptions = {
    prefix?: string;
};

const normalizeToken = (value: string | null | undefined): string => String(value || '').trim();

const matchesPrefix = (token: string, prefix?: string): boolean =>
    prefix ? token.startsWith(prefix) : true;

const getTaskTimestamp = (task: Task): number =>
    safeParseDate(task.updatedAt)?.getTime()
    ?? safeParseDate(task.createdAt)?.getTime()
    ?? 0;

export const collectTaskTokenUsage = (
    tasks: Task[],
    selector: TaskTokenSelector,
    options?: TaskTokenOptions
): TaskTokenUsage[] => {
    const prefix = options?.prefix;
    const usage = new Map<string, TaskTokenUsage>();

    tasks.forEach((task) => {
        if (task.deletedAt) return;
        const tokens = selector(task) ?? [];
        if (tokens.length === 0) return;

        const taskTimestamp = getTaskTimestamp(task);
        const seenInTask = new Set<string>();

        tokens.forEach((rawToken) => {
            const token = normalizeToken(rawToken);
            if (!token || !matchesPrefix(token, prefix) || seenInTask.has(token)) return;
            seenInTask.add(token);

            const existing = usage.get(token);
            if (existing) {
                existing.count += 1;
                if (taskTimestamp > existing.lastUsedAt) {
                    existing.lastUsedAt = taskTimestamp;
                }
                return;
            }

            usage.set(token, {
                token,
                count: 1,
                lastUsedAt: taskTimestamp,
            });
        });
    });

    return Array.from(usage.values());
};

export const getUsedTaskTokens = (
    tasks: Task[],
    selector: TaskTokenSelector,
    options?: TaskTokenOptions
): string[] =>
    collectTaskTokenUsage(tasks, selector, options)
        .map((entry) => entry.token)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

export const getFrequentTaskTokens = (
    tasks: Task[],
    selector: TaskTokenSelector,
    limit: number,
    options?: TaskTokenOptions
): string[] =>
    collectTaskTokenUsage(tasks, selector, options)
        .sort((a, b) =>
            b.count - a.count
            || b.lastUsedAt - a.lastUsedAt
            || a.token.localeCompare(b.token, undefined, { sensitivity: 'base' })
        )
        .slice(0, Math.max(0, limit))
        .map((entry) => entry.token);

export const getRecentTaskTokens = (
    tasks: Task[],
    selector: TaskTokenSelector,
    limit: number,
    options?: TaskTokenOptions
): string[] =>
    collectTaskTokenUsage(tasks, selector, options)
        .sort((a, b) =>
            b.lastUsedAt - a.lastUsedAt
            || b.count - a.count
            || a.token.localeCompare(b.token, undefined, { sensitivity: 'base' })
        )
        .slice(0, Math.max(0, limit))
        .map((entry) => entry.token);
