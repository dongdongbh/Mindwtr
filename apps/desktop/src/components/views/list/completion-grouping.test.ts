import { describe, expect, it } from 'vitest';
import type { Area, Project, Task } from '@mindwtr/core';
import { DONE_AXES, groupTasks } from './next-grouping';

const task = (id: string, completedAt?: string): Task => ({
    id,
    title: id,
    status: 'done',
    tags: [],
    contexts: [],
    completedAt,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
});

const groupByCompletionDate = (tasks: Task[]) => groupTasks('completedDate', {
    tasks,
    areas: [] as Area[],
    projectMap: new Map<string, Project>(),
    t: (key: string) => key,
});


describe('completedDate axis (#945, #959)', () => {
    it('splits old completions by month instead of one Earlier heading', () => {
        const groups = groupByCompletionDate([
            task('older', '2026-01-05T10:00:00'),
            task('never'),
        ]);

        expect(groups.map((group) => group.id)).toEqual([
            'completedDate:2026-01',
            'completedDate:notCompleted',
        ]);
        expect(groups[0].title).toBe('January 2026');
        expect(groups[1].muted).toBe(true);
    });

    it('keeps every task exactly once', () => {
        const grouped = groupByCompletionDate([
            task('a', new Date().toISOString()),
            task('b', '2026-01-01T08:00:00'),
            task('c'),
        ]).flatMap((group) => group.tasks.map((item) => item.id));

        expect(grouped.sort()).toEqual(['a', 'b', 'c']);
    });

    it('offers the axis only through the Done roster', () => {
        expect(DONE_AXES).toContain('completedDate');
    });
});
