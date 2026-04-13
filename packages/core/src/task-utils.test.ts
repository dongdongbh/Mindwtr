import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sortTasks, getStatusColor, getTaskAgeLabel, rescheduleTask, extractWaitingPerson, getWaitingPerson } from './task-utils';
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
});
