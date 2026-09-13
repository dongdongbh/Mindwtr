import { describe, expect, it } from 'vitest';
import { collectTaskTokenUsage, createTaskTokenUsageAccumulator, getFrequentTaskTokens, getRecentTaskTokens, getUsedTaskTokens, getUsedTaskTokensFromUsage } from './task-token-usage';
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
    it('uses a supplied timestamp without weakening lazy timestamp reads', () => {
        const accumulator = createTaskTokenUsageAccumulator({ prefix: '@' });
        const deleted = buildTask({
            id: 'deleted',
            contexts: ['@ghost'],
            deletedAt: '2026-03-02T00:00:00.000Z',
        });
        const empty = buildTask({ id: 'empty', contexts: [] });
        const supplied = buildTask({ id: 'supplied', contexts: ['@work'] });
        for (const task of [deleted, empty, supplied]) {
            Object.defineProperties(task, {
                updatedAt: { get: () => { throw new Error('Timestamp fallback should stay lazy'); } },
                createdAt: { get: () => { throw new Error('Timestamp fallback should stay lazy'); } },
            });
        }

        accumulator.add(deleted, (task) => task.contexts);
        accumulator.add(empty, (task) => task.contexts);
        accumulator.add(supplied, (task) => task.contexts, 0);

        expect(accumulator.toUsage()).toEqual([
            { token: '@work', count: 1, lastUsedAt: 0 },
        ]);
    });

    it('does not inspect timestamps when only token names are requested', () => {
        const task = buildTask({ id: 'names-only', contexts: ['@work', '@work'] });
        Object.defineProperty(task, 'updatedAt', { get() { throw new Error('Names do not need recency'); } });
        Object.defineProperty(task, 'createdAt', { get() { throw new Error('Names do not need recency'); } });
        expect(getUsedTaskTokens([task], (entry) => entry.contexts, { prefix: '@' })).toEqual(['@work']);
    });

    it('matches usage-derived names for a large mixed store without changing its tasks', () => {
        const tasks = Array.from({ length: 5000 }, (_, index) => Object.freeze(buildTask({
            id: `tokens-${index}`,
            contexts: index % 5 === 0 ? [] : [` @Office ${index % 11} `, '@home', '@home', '#other', '', '@office 1'],
            deletedAt: index % 7 === 0 ? '2026-03-02T00:00:00.000Z' : undefined,
            updatedAt: index % 2 === 0 ? 'invalid-date' : '2026-03-03T00:00:00.000Z',
        })));
        for (const prefix of [undefined, '@', '#', '!']) {
            const selector = (task: Task) => task.id.endsWith('3') ? null : task.contexts;
            expect(getUsedTaskTokens(tasks, selector, { prefix })).toEqual(
                getUsedTaskTokensFromUsage(collectTaskTokenUsage(tasks, selector, { prefix })),
            );
        }
    });

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
