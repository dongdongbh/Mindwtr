import { describe, expect, it } from 'vitest';

import { getDailyDigestSummary } from './digest-utils';
import type { Project, Task } from './types';

describe('getDailyDigestSummary', () => {
    it('counts due/overdue/focus/review', () => {
        const now = new Date('2025-01-10T12:00:00.000Z');

        const tasks: Task[] = [
            {
                id: '1',
                title: 'Due today',
                status: 'next',
                tags: [],
                contexts: [],
                dueDate: '2025-01-10T09:00:00.000Z',
                createdAt: now.toISOString(),
                updatedAt: now.toISOString(),
            },
            {
                id: '2',
                title: 'Overdue',
                status: 'todo',
                tags: [],
                contexts: [],
                dueDate: '2025-01-09T09:00:00.000Z',
                createdAt: now.toISOString(),
                updatedAt: now.toISOString(),
            },
            {
                id: '3',
                title: 'Focused',
                status: 'inbox',
                tags: [],
                contexts: [],
                isFocusedToday: true,
                createdAt: now.toISOString(),
                updatedAt: now.toISOString(),
            },
            {
                id: '4',
                title: 'Review due',
                status: 'waiting',
                tags: [],
                contexts: [],
                reviewAt: '2025-01-10T00:00:00.000Z',
                createdAt: now.toISOString(),
                updatedAt: now.toISOString(),
            },
            {
                id: '5',
                title: 'Done (ignored)',
                status: 'done',
                tags: [],
                contexts: [],
                dueDate: '2025-01-10T09:00:00.000Z',
                isFocusedToday: true,
                reviewAt: '2025-01-10T00:00:00.000Z',
                createdAt: now.toISOString(),
                updatedAt: now.toISOString(),
            },
        ];

        const projects: Project[] = [
            {
                id: 'p1',
                title: 'Project review',
                status: 'active',
                color: '#000000',
                reviewAt: '2025-01-10T01:00:00.000Z',
                createdAt: now.toISOString(),
                updatedAt: now.toISOString(),
            },
            {
                id: 'p2',
                title: 'Completed (ignored)',
                status: 'completed',
                color: '#000000',
                reviewAt: '2025-01-10T01:00:00.000Z',
                createdAt: now.toISOString(),
                updatedAt: now.toISOString(),
            },
        ];

        const summary = getDailyDigestSummary(tasks, projects, now);
        expect(summary).toEqual({
            dueToday: 1,
            overdue: 1,
            focusToday: 1,
            reviewDueTasks: 1,
            reviewDueProjects: 1,
        });
    });
});

