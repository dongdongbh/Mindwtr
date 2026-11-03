import type { Task } from './types';

export function matchesHierarchicalToken(filter: string, token: string): boolean {
    const normalizedFilter = filter.replace(/\/+$/, '');
    if (token === normalizedFilter) return true;
    return token.startsWith(`${normalizedFilter}/`);
}

export function normalizePrefixedToken(value: string, prefix: '@' | '#'): string {
    if (value.startsWith(prefix)) return value;
    return `${prefix}${value}`;
}

export type ContextOrTagMatchMode = 'all' | 'any';


export function taskMatchesContextOrTagSelection(
    task: Task,
    selectedTokens: readonly string[],
    mode: ContextOrTagMatchMode = 'all',
): boolean {
    const taskTokens = [...(task.contexts ?? []), ...(task.tags ?? [])];
    const matches = (selected: string) => taskTokens.some((token) => matchesHierarchicalToken(selected, token));
    return mode === 'any' ? selectedTokens.some(matches) : selectedTokens.every(matches);
}
