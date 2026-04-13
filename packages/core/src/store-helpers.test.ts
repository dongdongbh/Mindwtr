import { describe, expect, it } from 'vitest';
import { getNextProjectOrder, reserveNextProjectOrder } from './store-helpers';
import type { Task } from './types';

const createTask = (id: string, projectId: string, orderNum: number): Task => ({
    id,
    title: `Task ${id}`,
    status: 'inbox',
    tags: [],
    contexts: [],
    projectId,
    orderNum,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('getNextProjectOrder', () => {
    it('returns deterministic next project order without mutating shared cache', () => {
        const tasks = [
            createTask('t1', 'project-1', 0),
            createTask('t2', 'project-1', 1),
        ];

        expect(getNextProjectOrder('project-1', tasks)).toBe(2);
        expect(getNextProjectOrder('project-1', tasks)).toBe(2);
        expect(getNextProjectOrder('project-1', tasks)).toBe(2);
    });

    it('starts from zero for unseen projects on repeated calls', () => {
        const tasks = [createTask('t1', 'project-1', 0)];

        expect(getNextProjectOrder('project-2', tasks)).toBe(0);
        expect(getNextProjectOrder('project-2', tasks)).toBe(0);
    });

    it('reserves unique project orders against the same snapshot', () => {
        const tasks = [
            createTask('t1', 'project-1', 0),
            createTask('t2', 'project-1', 1),
        ];

        expect(reserveNextProjectOrder('project-1', tasks)).toBe(2);
        expect(reserveNextProjectOrder('project-1', tasks)).toBe(3);
        expect(reserveNextProjectOrder('project-2', tasks)).toBe(0);
        expect(reserveNextProjectOrder('project-2', tasks)).toBe(1);
    });

    it('does not carry reserved orders across new task snapshots', () => {
        const tasks = [
            createTask('t1', 'project-1', 0),
            createTask('t2', 'project-1', 1),
        ];

        expect(reserveNextProjectOrder('project-1', tasks)).toBe(2);

        const refreshedTasks = tasks.map((task) => ({ ...task }));
        expect(reserveNextProjectOrder('project-1', refreshedTasks)).toBe(2);
    });
});
