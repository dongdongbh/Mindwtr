import { describe, it, expect } from 'vitest';
import { filterTasksBySearch } from './search';
import type { Project, Task } from './types';

describe('search', () => {
    it('supports status, OR groups, and negation', () => {
        const now = new Date('2025-01-01T10:00:00Z');

        const tasks: Task[] = [
            {
                id: 't1',
                title: 'Call mom',
                status: 'inbox',
                tags: [],
                contexts: [],
                createdAt: '2025-01-01T00:00:00Z',
                updatedAt: '2025-01-01T00:00:00Z',
            },
            {
                id: 't2',
                title: 'Write report',
                status: 'next',
                tags: [],
                contexts: [],
                createdAt: '2025-01-01T00:00:00Z',
                updatedAt: '2025-01-01T00:00:00Z',
            },
            {
                id: 't3',
                title: 'Old done task',
                status: 'done',
                tags: [],
                contexts: [],
                createdAt: '2024-12-01T00:00:00Z',
                updatedAt: '2024-12-01T00:00:00Z',
            },
        ];
        const projects: Project[] = [];

        const results = filterTasksBySearch(tasks, projects, 'status:inbox OR status:next -status:done', now);
        expect(results.map(t => t.id)).toEqual(['t1', 't2']);
    });

    it('supports reference status filter', () => {
        const now = new Date('2025-01-01T10:00:00Z');
        const tasks: Task[] = [
            {
                id: 't1',
                title: 'Reference task',
                status: 'reference',
                tags: [],
                contexts: [],
                createdAt: '2025-01-01T00:00:00Z',
                updatedAt: '2025-01-01T00:00:00Z',
            },
            {
                id: 't2',
                title: 'Next task',
                status: 'next',
                tags: [],
                contexts: [],
                createdAt: '2025-01-01T00:00:00Z',
                updatedAt: '2025-01-01T00:00:00Z',
            },
        ];

        const results = filterTasksBySearch(tasks, [], 'status:reference', now);
        expect(results.map(t => t.id)).toEqual(['t1']);
    });

    it('supports relative date comparisons', () => {
        const now = new Date('2025-01-01T00:00:00Z');
        const tasks: Task[] = [
            {
                id: 't1',
                title: 'Due soon',
                status: 'next',
                dueDate: '2025-01-05T09:00:00.000Z',
                tags: [],
                contexts: [],
                createdAt: '2025-01-01T00:00:00Z',
                updatedAt: '2025-01-01T00:00:00Z',
            },
            {
                id: 't2',
                title: 'Due later',
                status: 'next',
                dueDate: '2025-01-20T09:00:00.000Z',
                tags: [],
                contexts: [],
                createdAt: '2025-01-01T00:00:00Z',
                updatedAt: '2025-01-01T00:00:00Z',
            },
        ];

        const results = filterTasksBySearch(tasks, [], 'due:<=7d', now);
        expect(results.map(t => t.id)).toEqual(['t1']);
    });

    it('matches parent context filters against slash-delimited child contexts', () => {
        const nowIso = new Date('2025-01-01T00:00:00Z').toISOString();
        const tasks: Task[] = [
            {
                id: 't1',
                title: 'Team sync',
                status: 'next',
                tags: [],
                contexts: ['@work/meetings'],
                createdAt: nowIso,
                updatedAt: nowIso,
            },
            {
                id: 't2',
                title: 'Home admin',
                status: 'next',
                tags: [],
                contexts: ['@home'],
                createdAt: nowIso,
                updatedAt: nowIso,
            },
        ];

        const results = filterTasksBySearch(tasks, [], 'context:work');
        expect(results.map((task) => task.id)).toEqual(['t1']);
    });

    it('matches project filter by title', () => {
        const nowIso = new Date('2025-01-01T00:00:00Z').toISOString();
        const projects: Project[] = [
            {
                id: 'p1',
                title: 'Work Stuff',
                color: '#000000',
                status: 'active',
                tagIds: [],
                createdAt: nowIso,
                updatedAt: nowIso,
            },
        ];
        const tasks: Task[] = [
            {
                id: 't1',
                title: 'Task in project',
                status: 'next',
                projectId: 'p1',
                tags: [],
                contexts: [],
                createdAt: nowIso,
                updatedAt: nowIso,
            },
        ];

        const results = filterTasksBySearch(tasks, projects, 'project:work');
        expect(results).toHaveLength(1);
    });

    it('does not build project lookup when query has no project terms', () => {
        const nowIso = new Date('2025-01-01T00:00:00Z').toISOString();
        const tasks: Task[] = [
            {
                id: 't1',
                title: 'Call mom',
                status: 'inbox',
                tags: [],
                contexts: [],
                createdAt: nowIso,
                updatedAt: nowIso,
            },
        ];
        const projects = new Proxy([] as Project[], {
            get(target, property, receiver) {
                if (property === Symbol.iterator) {
                    throw new Error('projects should not be iterated without project search terms');
                }
                return Reflect.get(target, property, receiver);
            },
        });

        const results = filterTasksBySearch(tasks, projects, 'status:inbox');
        expect(results).toHaveLength(1);
    });
});
