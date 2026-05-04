import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    sortTasks,
    sortFocusNextActions,
    getStatusColor,
    getTaskAgeLabel,
    rescheduleTask,
    extractWaitingPerson,
    getSequentialFirstTaskIds,
    getWaitingPerson,
    isTaskFutureStart,
    shouldShowTaskForStart,
} from './task-utils';
import { Task } from './types';

describe('task-utils', () => {
    describe('sortTasks', () => {
        it('should sort by status order', () => {
            const tasks: Partial<Task>[] = [
                { id: '1', status: 'next', title: 'Next', createdAt: '2023-01-01' },
                { id: '2', status: 'inbox', title: 'Inbox', createdAt: '2023-01-01' },
                { id: '3', status: 'done', title: 'Done', createdAt: '2023-01-01' },
            ];

            const sorted = sortTasks(tasks as Task[]);
            expect(sorted.map(t => t.status)).toEqual(['inbox', 'next', 'done']);
        });

        it('should sort by due date within status', () => {
            const tasks: Partial<Task>[] = [
                { id: '1', status: 'next', title: 'Later', dueDate: '2023-01-02', createdAt: '2023-01-01' },
                { id: '2', status: 'next', title: 'Soon', dueDate: '2023-01-01', createdAt: '2023-01-01' },
                { id: '3', status: 'next', title: 'No Date', createdAt: '2023-01-01' },
            ];

            const sorted = sortTasks(tasks as Task[]);
            expect(sorted.map(t => t.title)).toEqual(['Soon', 'Later', 'No Date']);
        });
    });

    describe('sortFocusNextActions', () => {
        it('puts due-soon tasks ahead of undated tasks and sinks far-future due tasks', () => {
            const sorted = sortFocusNextActions([
                {
                    id: 'future',
                    title: 'Future due',
                    status: 'next',
                    dueDate: '2027-04-01T09:00:00.000Z',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-01-01T08:00:00.000Z',
                    updatedAt: '2026-01-01T08:00:00.000Z',
                },
                {
                    id: 'undated',
                    title: 'Undated task',
                    status: 'next',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-01-01T07:00:00.000Z',
                    updatedAt: '2026-01-01T07:00:00.000Z',
                },
                {
                    id: 'soon',
                    title: 'Soon due',
                    status: 'next',
                    dueDate: '2026-01-10T09:00:00.000Z',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-01-01T06:00:00.000Z',
                    updatedAt: '2026-01-01T06:00:00.000Z',
                },
            ] as Task[], {
                now: new Date('2026-01-01T00:00:00.000Z'),
            });

            expect(sorted.map((task) => task.id)).toEqual(['soon', 'undated', 'future']);
        });

        it('orders due-soon tasks by earliest due date', () => {
            const sorted = sortFocusNextActions([
                {
                    id: 'later',
                    title: 'Later this month',
                    status: 'next',
                    dueDate: '2026-01-20T09:00:00.000Z',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-01-01T08:00:00.000Z',
                    updatedAt: '2026-01-01T08:00:00.000Z',
                },
                {
                    id: 'overdue',
                    title: 'Overdue task',
                    status: 'next',
                    dueDate: '2025-12-31T09:00:00.000Z',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-01-01T07:00:00.000Z',
                    updatedAt: '2026-01-01T07:00:00.000Z',
                },
                {
                    id: 'near',
                    title: 'Near due',
                    status: 'next',
                    dueDate: '2026-01-05T09:00:00.000Z',
                    tags: [],
                    contexts: [],
                    createdAt: '2026-01-01T06:00:00.000Z',
                    updatedAt: '2026-01-01T06:00:00.000Z',
                },
            ] as Task[], {
                now: new Date('2026-01-01T00:00:00.000Z'),
            });

            expect(sorted.map((task) => task.id)).toEqual(['overdue', 'near', 'later']);
        });
    });

    describe('getStatusColor', () => {
        it('should return valid color object', () => {
            const color = getStatusColor('next');
            expect(color).toHaveProperty('bg');
            expect(color).toHaveProperty('text');
            expect(color).toHaveProperty('border');
        });

        it('should default to inbox color for unknown', () => {
            // @ts-ignore
            const color = getStatusColor('unknown');
            const inboxColor = getStatusColor('inbox');
            expect(color).toEqual(inboxColor);
        });

        it('uses distinct default colors for next and done', () => {
            expect(getStatusColor('next')).not.toEqual(getStatusColor('done'));
            expect(getStatusColor('next').text).toBe('#2563EB');
        });
    });

    describe('getTaskAgeLabel', () => {
        beforeEach(() => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2025-02-15T12:00:00.000Z'));
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('should return null for new tasks', () => {
            expect(getTaskAgeLabel('2025-02-15T12:00:00.000Z')).toBeNull();
        });

        it('should return correct label for old tasks', () => {
            expect(getTaskAgeLabel('2025-02-01T12:00:00.000Z')).toBe('2 weeks old');
        });
    });

    describe('rescheduleTask', () => {
        it('increments pushCount when dueDate moves later', () => {
            const task: Task = {
                id: '1',
                title: 'Reschedule',
                status: 'next',
                tags: [],
                contexts: [],
                dueDate: '2025-01-01T09:00:00.000Z',
                createdAt: '2025-01-01T00:00:00.000Z',
                updatedAt: '2025-01-01T00:00:00.000Z',
            };
            const updated = rescheduleTask(task, '2025-01-02T09:00:00.000Z');
            expect(updated.pushCount).toBe(1);
        });

        it('does not increment pushCount when dueDate moves earlier', () => {
            const task: Task = {
                id: '2',
                title: 'Reschedule earlier',
                status: 'next',
                tags: [],
                contexts: [],
                dueDate: '2025-01-03T09:00:00.000Z',
                pushCount: 2,
                createdAt: '2025-01-01T00:00:00.000Z',
                updatedAt: '2025-01-01T00:00:00.000Z',
            };
            const updated = rescheduleTask(task, '2025-01-02T09:00:00.000Z');
            expect(updated.pushCount).toBe(2);
        });
    });

    describe('extractWaitingPerson', () => {
        it('extracts the waiting person from a dedicated line', () => {
            const description = 'Need follow-up\nWaiting for: Alex\nContext details';
            expect(extractWaitingPerson(description)).toBe('Alex');
        });

        it('supports case-insensitive matching and full-width colon', () => {
            const description = 'waiting FOR：Jordan';
            expect(extractWaitingPerson(description)).toBe('Jordan');
        });

        it('returns null when no waiting person line exists', () => {
            expect(extractWaitingPerson('No delegation info here')).toBeNull();
        });
    });

    describe('getWaitingPerson', () => {
        it('prefers assignedTo when present', () => {
            expect(getWaitingPerson({
                assignedTo: 'Alex',
                description: 'Waiting for: Jordan',
            })).toBe('Alex');
        });

        it('falls back to the legacy description line', () => {
            expect(getWaitingPerson({
                description: 'Need follow-up\nWaiting for: Jordan',
            })).toBe('Jordan');
        });

        it('returns null when no waiting person is available', () => {
            expect(getWaitingPerson({ description: 'No delegation info here' })).toBeNull();
        });
    });

    describe('task start visibility', () => {
        const now = new Date(2026, 4, 2, 10, 0, 0, 0);

        it('does not treat tasks starting later today as future-start tasks', () => {
            expect(isTaskFutureStart({ startTime: new Date(2026, 4, 2, 22, 0, 0, 0).toISOString() }, now)).toBe(false);
        });

        it('treats tasks starting after today as future-start tasks', () => {
            expect(isTaskFutureStart({ startTime: new Date(2026, 4, 3, 0, 0, 0, 0).toISOString() }, now)).toBe(true);
        });

        it('hides future-start tasks unless the view opts into showing them', () => {
            const task = { startTime: new Date(2026, 4, 3, 0, 0, 0, 0).toISOString() };

            expect(shouldShowTaskForStart(task, { now })).toBe(false);
            expect(shouldShowTaskForStart(task, { now, showFutureStarts: true })).toBe(true);
        });
    });

    describe('getSequentialFirstTaskIds', () => {
        it('returns the first active task per sequential project by order', () => {
            const firstTaskIds = getSequentialFirstTaskIds([
                { id: 'p1-second', projectId: 'p1', order: 2, orderNum: undefined, createdAt: '2026-04-02T00:00:00.000Z' },
                { id: 'p1-first', projectId: 'p1', order: 1, orderNum: undefined, createdAt: '2026-04-03T00:00:00.000Z' },
                { id: 'p2-first', projectId: 'p2', order: undefined, orderNum: undefined, createdAt: '2026-04-04T00:00:00.000Z' },
            ], new Set(['p1']));

            expect([...firstTaskIds]).toEqual(['p1-first']);
        });

        it('falls back to created time when a sequential project has no order values', () => {
            const firstTaskIds = getSequentialFirstTaskIds([
                { id: 'newer', projectId: 'p1', order: undefined, orderNum: undefined, createdAt: '2026-04-02T00:00:00.000Z' },
                { id: 'older', projectId: 'p1', order: undefined, orderNum: undefined, createdAt: '2026-04-01T00:00:00.000Z' },
            ], new Set(['p1']));

            expect([...firstTaskIds]).toEqual(['older']);
        });
    });
});
