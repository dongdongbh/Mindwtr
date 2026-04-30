import { describe, expect, it } from 'vitest';
import type { Task } from '@mindwtr/core';

import { resolveTaskNavigationView } from './task-navigation';

const makeTask = (overrides: Partial<Task>): Task => ({
    id: 'task-1',
    title: 'Task',
    status: 'inbox',
    tags: [],
    contexts: [],
    createdAt: '2026-04-16T10:00:00.000Z',
    updatedAt: '2026-04-16T10:00:00.000Z',
    ...overrides,
});

describe('resolveTaskNavigationView', () => {
    const now = new Date('2026-04-16T10:00:00.000Z');

    it('keeps future-start inbox tasks in the inbox', () => {
        expect(resolveTaskNavigationView(makeTask({
            status: 'inbox',
            startTime: '2026-04-20',
        }), now)).toBe('inbox');
    });

    it('routes future-start next actions to review because next hides deferred actions', () => {
        expect(resolveTaskNavigationView(makeTask({
            status: 'next',
            startTime: '2026-04-20',
        }), now)).toBe('review');
    });
});
