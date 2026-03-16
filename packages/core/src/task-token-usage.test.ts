import { describe, expect, it } from 'vitest';
import { collectTaskTokenUsage, getFrequentTaskTokens, getRecentTaskTokens, getUsedTaskTokens } from './task-token-usage';
import type { Task } from './types';

const buildTask = (overrides: Partial<Task>): Task => ({
    id: overrides.id ?? `task-${Math.random().toString(16).slice(2, 8)}`,
    title: overrides.title ?? 'Task',
    status: overrides.status ?? 'next',
    createdAt: overrides.createdAt ?? '2026-03-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? overrides.createdAt ?? '2026-03-01T00:00:00.000Z',
    tags: overrides.tags ?? [],
    contexts: overrides.contexts ?? [],
    ...overrides,
});

describe('task token usage', () => {
    it('returns only used tokens and skips deleted tasks', () => {
        const tasks = [
            buildTask({ id: '1', contexts: ['@work', '@home'] }),
            buildTask({ id: '2', contexts: ['@office'], deletedAt: '2026-03-03T00:00:00.000Z' }),
            buildTask({ id: '3', contexts: ['@agendas'] }),
        ];

        expect(getUsedTaskTokens(tasks, (task) => task.contexts, { prefix: '@' })).toEqual([
            '@agendas',
            '@home',
            '@work',
        ]);
    });

    it('sorts frequent tokens by count then recency', () => {
        const tasks = [
            buildTask({ id: '1', tags: ['#deep'], updatedAt: '2026-03-01T00:00:00.000Z' }),
            buildTask({ id: '2', tags: ['#deep'], updatedAt: '2026-03-02T00:00:00.000Z' }),
            buildTask({ id: '3', tags: ['#admin'], updatedAt: '2026-03-05T00:00:00.000Z' }),
        ];

        expect(getFrequentTaskTokens(tasks, (task) => task.tags, 3, { prefix: '#' })).toEqual([
            '#deep',
            '#admin',
        ]);
    });

    it('sorts recent tokens by recency then count', () => {
        const tasks = [
            buildTask({ id: '1', contexts: ['@work'], updatedAt: '2026-03-01T00:00:00.000Z' }),
            buildTask({ id: '2', contexts: ['@office'], updatedAt: '2026-03-05T00:00:00.000Z' }),
            buildTask({ id: '3', contexts: ['@work'], updatedAt: '2026-03-04T00:00:00.000Z' }),
        ];

        expect(getRecentTaskTokens(tasks, (task) => task.contexts, 3, { prefix: '@' })).toEqual([
            '@office',
            '@work',
        ]);
    });

    it('counts a duplicated token only once per task', () => {
        const tasks = [
            buildTask({ id: '1', tags: ['#focus', '#focus'], updatedAt: '2026-03-04T00:00:00.000Z' }),
        ];

        expect(collectTaskTokenUsage(tasks, (task) => task.tags, { prefix: '#' })).toEqual([
            { token: '#focus', count: 1, lastUsedAt: new Date('2026-03-04T00:00:00.000Z').getTime() },
        ]);
    });
});
