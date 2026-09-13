import { baseTextCollator } from './task-utils';
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

export const getTaskTokenUsageTimestamp = (task: Task): number =>
    safeParseDate(task.updatedAt)?.getTime()
    ?? safeParseDate(task.createdAt)?.getTime()
    ?? 0;

/**
 * Per-task token accumulation, shared so the streaming caller and collectTaskTokenUsage
 * cannot drift on the three things that define the output: skip deleted tasks, dedupe within
 * a task, and keep first-seen insertion order.
 */
export const createTaskTokenUsageAccumulator = (options?: TaskTokenOptions) => {
    const prefix = options?.prefix;
    const usage = new Map<string, TaskTokenUsage>();

    return {
        add: (task: Task, selector: TaskTokenSelector, suppliedTimestamp?: number): void => {
            if (task.deletedAt) return;
            const tokens = selector(task) ?? [];
            if (tokens.length === 0) return;

            const taskTimestamp = suppliedTimestamp ?? getTaskTokenUsageTimestamp(task);
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

                usage.set(token, { token, count: 1, lastUsedAt: taskTimestamp });
            });
        },
        toUsage: (): TaskTokenUsage[] => Array.from(usage.values()),
    };
};

export const collectTaskTokenUsage = (
    tasks: Task[],
    selector: TaskTokenSelector,
    options?: TaskTokenOptions
): TaskTokenUsage[] => {
    const accumulator = createTaskTokenUsageAccumulator(options);
    tasks.forEach((task) => accumulator.add(task, selector));
    return accumulator.toUsage();
};

export const getUsedTaskTokens = (
    tasks: Task[],
    selector: TaskTokenSelector,
    options?: TaskTokenOptions
): string[] => {
    // Name-only callers (including capture parsing) do not need usage counts or
    // recency. Avoid parsing every task's timestamps and allocating usage rows.
    const tokens = new Set<string>();
    tasks.forEach((task) => {
        if (task.deletedAt) return;
        (selector(task) ?? []).forEach((rawToken) => {
            const token = normalizeToken(rawToken);
            if (token && matchesPrefix(token, options?.prefix)) tokens.add(token);
        });
    });
    return Array.from(tokens).sort((a, b) => baseTextCollator.compare(a, b));
};

export const getUsedTaskTokensFromUsage = (usage: readonly TaskTokenUsage[]): string[] =>
    usage
        .map((entry) => entry.token)
        .sort((a, b) => baseTextCollator.compare(a, b));

export const getFrequentTaskTokens = (
    tasks: Task[],
    selector: TaskTokenSelector,
    limit: number,
    options?: TaskTokenOptions
): string[] =>
    getFrequentTaskTokensFromUsage(collectTaskTokenUsage(tasks, selector, options), limit);

export const getFrequentTaskTokensFromUsage = (
    usage: readonly TaskTokenUsage[],
    limit: number
): string[] =>
    [...usage]
        .sort((a, b) =>
            b.count - a.count
            || b.lastUsedAt - a.lastUsedAt
            || baseTextCollator.compare(a.token, b.token)
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
            || baseTextCollator.compare(a.token, b.token)
        )
        .slice(0, Math.max(0, limit))
        .map((entry) => entry.token);
