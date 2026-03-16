import { describe, expect, it } from 'vitest';

import { getNextScheduledAt } from './schedule-utils';
import type { Task } from './types';

const buildTask = (overrides: Partial<Task>): Task => ({
    id: 'task-1',
    title: 'Reminder',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-03-16T12:00:00.000Z',
    updatedAt: '2026-03-16T12:00:00.000Z',
    ...overrides,
});

describe('schedule-utils', () => {
    it('skips date-only start reminders', () => {
        const task = buildTask({ startTime: '2026-03-17' });
        const now = new Date(2026, 2, 16, 20, 0, 0, 0);

        const next = getNextScheduledAt(task, now);

        expect(next).toBeNull();
    });

    it('skips date-only due reminders', () => {
        const task = buildTask({ dueDate: '2026-03-17' });
        const now = new Date(2026, 2, 16, 20, 0, 0, 0);

        const next = getNextScheduledAt(task, now);

        expect(next).toBeNull();
    });

    it('keeps explicit start times unchanged', () => {
        const task = buildTask({ startTime: '2026-03-17T14:30:00.000Z' });
        const now = new Date('2026-03-16T12:00:00.000Z');

        const next = getNextScheduledAt(task, now);

        expect(next?.toISOString()).toBe('2026-03-17T14:30:00.000Z');
    });
});
