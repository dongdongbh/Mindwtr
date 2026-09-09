import { describe, expect, it, vi } from 'vitest';
import type { CalendarSyncEntry } from './sqlite-adapter';
import type { Task } from './types';
import {
    runCalendarPushFullSync,
    runCalendarPushPartialSync,
    type CalendarPushRunPorts,
} from './calendar-push-run';

const now = '2026-07-14T12:00:00.000Z';

const makeTask = (overrides: Partial<Task> = {}): Task => ({
    id: 'task-1',
    title: 'Plan review',
    status: 'next',
    tags: [],
    contexts: [],
    dueDate: '2026-07-20',
    createdAt: now,
    updatedAt: now,
    ...overrides,
});

const createHarness = () => {
    const entries = new Map<string, CalendarSyncEntry>();
    const createEvent = vi.fn(async () => 'event-new');
    const updateEvent = vi.fn(async (entry: CalendarSyncEntry) => ({
        status: 'updated' as const,
        eventId: entry.calendarEventId,
    }));
    const deleteEvent = vi.fn(async () => undefined);
    const getSyncEntry = vi.fn(async (taskId: string) => entries.get(taskId) ?? null);
    const getAllSyncEntries = vi.fn(async () => Array.from(entries.values()));
    const upsertSyncEntry = vi.fn(async (entry: CalendarSyncEntry) => {
        entries.set(entry.taskId, entry);
    });
    const deleteSyncEntry = vi.fn(async (taskId: string) => {
        entries.delete(taskId);
    });
    const ports: CalendarPushRunPorts = {
        platform: 'test',
        nowIso: () => now,
        createEvent,
        updateEvent,
        deleteEvent,
        getSyncEntry,
        getAllSyncEntries,
        upsertSyncEntry,
        deleteSyncEntry,
    };
    return {
        entries,
        createEvent,
        updateEvent,
        deleteEvent,
        getSyncEntry,
        getAllSyncEntries,
        upsertSyncEntry,
        deleteSyncEntry,
        ports,
    };
};

describe('runCalendarPushFullSync', () => {
    it.each([
        ['undated', { dueDate: null }],
        ['archived', { status: 'archived' as const }],
    ])('bounds mapping inventory reads for 5,000 %s tasks without mappings', async (_name, overrides) => {
        const harness = createHarness();
        const tasks = Array.from({ length: 5_000 }, (_value, index) =>
            makeTask({ id: `task-${index}`, ...overrides })
        );

        const result = await runCalendarPushFullSync({
            tasks,
            target: { id: 'calendar-1' },
            ports: harness.ports,
        });

        expect(harness.getAllSyncEntries.mock.calls.length).toBeLessThanOrEqual(2);
        expect(harness.createEvent).not.toHaveBeenCalled();
        expect(harness.updateEvent).not.toHaveBeenCalled();
        expect(harness.deleteEvent).not.toHaveBeenCalled();
        expect(result).toEqual({
            total: 5_000,
            failed: 0,
            stale: 0,
            staleFailed: 0,
        });
        expect(harness.getSyncEntry).not.toHaveBeenCalled();
    });

    it('creates an event and persists its mapping for an eligible task', async () => {
        const harness = createHarness();

        const result = await runCalendarPushFullSync({
            tasks: [makeTask()],
            target: { id: 'calendar-1' },
            ports: harness.ports,
        });

        expect(harness.createEvent).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'task-1' }),
        );
        expect(harness.entries.get('task-1')).toEqual({
            taskId: 'task-1',
            calendarEventId: 'event-new',
            calendarId: 'calendar-1',
            platform: 'test',
            lastSyncedAt: now,
        });
        expect(result).toEqual({
            total: 1,
            failed: 0,
            stale: 0,
            staleFailed: 0,
        });
    });

    it('rejects an unavailable initial inventory before calendar side effects', async () => {
        const harness = createHarness();
        harness.getAllSyncEntries.mockRejectedValueOnce(new Error('calendar database unavailable'));

        await expect(runCalendarPushFullSync({
            tasks: [makeTask()],
            target: { id: 'calendar-1' },
            ports: harness.ports,
        })).rejects.toThrow('calendar database unavailable');

        expect(harness.createEvent).not.toHaveBeenCalled();
        expect(harness.updateEvent).not.toHaveBeenCalled();
        expect(harness.deleteEvent).not.toHaveBeenCalled();
        expect(harness.upsertSyncEntry).not.toHaveBeenCalled();
        expect(harness.deleteSyncEntry).not.toHaveBeenCalled();
    });

    it('expands opted-in unscheduled monthly recurrence before calendar eligibility', async () => {
        const harness = createHarness();

        const result = await runCalendarPushFullSync({
            tasks: [makeTask({
                dueDate: undefined,
                startTime: undefined,
                recurrence: { rule: 'monthly', strategy: 'strict', byMonthDay: [20] },
                showFutureRecurrence: true,
            })],
            target: { id: 'calendar-1' },
            ports: harness.ports,
        });

        expect(harness.createEvent).toHaveBeenCalledTimes(2);
        expect(harness.createEvent).toHaveBeenCalledWith(expect.objectContaining({
            id: 'task-1',
            startTime: '2026-07-20',
        }));
        expect(harness.createEvent).toHaveBeenCalledWith(expect.objectContaining({
            id: 'task-1:projected-recurrence',
            startTime: '2026-08-20',
        }));
        expect(result).toEqual({
            total: 2,
            failed: 0,
            stale: 0,
            staleFailed: 0,
        });
    });

    it('reconciles a mixed inventory through the initial mapping snapshot', async () => {
        const harness = createHarness();
        const tasks = [
            makeTask({ id: 'active' }),
            makeTask({ id: 'undated', dueDate: null }),
            makeTask({ id: 'done', status: 'done' }),
            makeTask({ id: 'archived', status: 'archived' }),
            makeTask({ id: 'reference', status: 'reference' }),
            makeTask({ id: 'deleted', deletedAt: now }),
        ];
        for (const task of tasks) {
            harness.entries.set(task.id, {
                taskId: task.id,
                calendarEventId: `event-${task.id}`,
                calendarId: 'calendar-1',
                platform: 'test',
                lastSyncedAt: now,
            });
        }
        harness.entries.set('missing', {
            taskId: 'missing',
            calendarEventId: 'event-missing',
            calendarId: 'calendar-1',
            platform: 'test',
            lastSyncedAt: now,
        });

        const result = await runCalendarPushFullSync({
            tasks,
            target: { id: 'calendar-1' },
            ports: harness.ports,
        });

        expect(harness.updateEvent).toHaveBeenCalledTimes(1);
        expect(harness.updateEvent).toHaveBeenCalledWith(
            expect.objectContaining({ taskId: 'active' }),
            expect.objectContaining({ id: 'active' }),
        );
        expect(harness.deleteEvent).toHaveBeenCalledTimes(6);
        expect(Array.from(harness.entries.keys())).toEqual(['active']);
        expect(result).toEqual({
            total: 6,
            failed: 0,
            stale: 1,
            staleFailed: 0,
        });
    });

    it('deletes the event and mapping when a task becomes completed', async () => {
        const harness = createHarness();
        harness.entries.set('task-1', {
            taskId: 'task-1',
            calendarEventId: 'event-old',
            calendarId: 'calendar-1',
            platform: 'test',
            lastSyncedAt: now,
        });

        const result = await runCalendarPushFullSync({
            tasks: [makeTask({ status: 'done' })],
            target: { id: 'calendar-1' },
            ports: harness.ports,
        });

        expect(harness.deleteEvent).toHaveBeenCalledWith(
            expect.objectContaining({ calendarEventId: 'event-old' }),
        );
        expect(harness.entries.has('task-1')).toBe(false);
        expect(harness.createEvent).not.toHaveBeenCalled();
        expect(result.stale).toBe(0);
        expect(result.staleFailed).toBe(0);
    });

    it('updates an existing event in place and refreshes its mapping', async () => {
        const harness = createHarness();
        harness.entries.set('task-1', {
            taskId: 'task-1',
            calendarEventId: 'event-old',
            calendarId: 'calendar-1',
            platform: 'test',
            lastSyncedAt: '2026-07-13T12:00:00.000Z',
        });

        await runCalendarPushFullSync({
            tasks: [makeTask()],
            target: { id: 'calendar-1' },
            ports: harness.ports,
        });

        expect(harness.updateEvent).toHaveBeenCalledWith(
            expect.objectContaining({ calendarEventId: 'event-old' }),
            expect.objectContaining({ id: 'task-1' }),
        );
        expect(harness.createEvent).not.toHaveBeenCalled();
        expect(harness.entries.get('task-1')?.lastSyncedAt).toBe(now);
    });

    it('recreates an event when the native adapter reports the old event missing', async () => {
        const harness = createHarness();
        harness.entries.set('task-1', {
            taskId: 'task-1',
            calendarEventId: 'event-old',
            calendarId: 'calendar-1',
            platform: 'test',
            lastSyncedAt: now,
        });
        harness.updateEvent.mockResolvedValue({ status: 'missing' });

        await runCalendarPushFullSync({
            tasks: [makeTask()],
            target: { id: 'calendar-1' },
            ports: harness.ports,
        });

        expect(harness.createEvent).toHaveBeenCalledTimes(1);
        expect(harness.entries.get('task-1')?.calendarEventId).toBe('event-new');
    });

    it('deletes then recreates an event when the target calendar changes', async () => {
        const harness = createHarness();
        harness.entries.set('task-1', {
            taskId: 'task-1',
            calendarEventId: 'event-old',
            calendarId: 'calendar-old',
            platform: 'test',
            lastSyncedAt: now,
        });

        await runCalendarPushFullSync({
            tasks: [makeTask()],
            target: { id: 'calendar-new' },
            ports: harness.ports,
        });

        expect(harness.deleteEvent).toHaveBeenCalledWith(
            expect.objectContaining({ calendarEventId: 'event-old' }),
        );
        expect(harness.createEvent).toHaveBeenCalledTimes(1);
        expect(harness.entries.get('task-1')?.calendarId).toBe('calendar-new');
    });

    it('keeps the mapping and avoids a duplicate when updating fails', async () => {
        const harness = createHarness();
        harness.entries.set('task-1', {
            taskId: 'task-1',
            calendarEventId: 'event-old',
            calendarId: 'calendar-1',
            platform: 'test',
            lastSyncedAt: now,
        });
        harness.updateEvent.mockRejectedValue(new Error('calendar unavailable'));

        const result = await runCalendarPushFullSync({
            tasks: [makeTask()],
            target: { id: 'calendar-1' },
            ports: harness.ports,
        });

        expect(result.failed).toBe(1);
        expect(harness.createEvent).not.toHaveBeenCalled();
        expect(harness.entries.get('task-1')?.calendarEventId).toBe('event-old');
    });

    it('keeps the old mapping and avoids a duplicate when a target move cannot delete', async () => {
        const harness = createHarness();
        harness.entries.set('task-1', {
            taskId: 'task-1',
            calendarEventId: 'event-old',
            calendarId: 'calendar-old',
            platform: 'test',
            lastSyncedAt: now,
        });
        harness.deleteEvent.mockRejectedValue(new Error('calendar unavailable'));

        const result = await runCalendarPushFullSync({
            tasks: [makeTask()],
            target: { id: 'calendar-new' },
            ports: harness.ports,
        });

        expect(result.failed).toBe(1);
        expect(harness.createEvent).not.toHaveBeenCalled();
        expect(harness.entries.get('task-1')?.calendarId).toBe('calendar-old');
    });

    it('reports a failed mapping upsert without claiming the event was mapped', async () => {
        const harness = createHarness();
        harness.upsertSyncEntry.mockRejectedValueOnce(new Error('calendar database unavailable'));

        const result = await runCalendarPushFullSync({
            tasks: [makeTask()],
            target: { id: 'calendar-1' },
            ports: harness.ports,
        });

        expect(harness.createEvent).toHaveBeenCalledTimes(1);
        expect(harness.entries.has('task-1')).toBe(false);
        expect(result.failed).toBe(1);
        expect(result.stale).toBe(0);
    });

    it('uses the fresh ending inventory to retry a failed inactive-task mapping deletion', async () => {
        const harness = createHarness();
        harness.entries.set('task-1', {
            taskId: 'task-1',
            calendarEventId: 'event-old',
            calendarId: 'calendar-1',
            platform: 'test',
            lastSyncedAt: now,
        });
        harness.deleteSyncEntry.mockRejectedValueOnce(new Error('calendar database unavailable'));

        const result = await runCalendarPushFullSync({
            tasks: [makeTask({ status: 'done' })],
            target: { id: 'calendar-1' },
            ports: harness.ports,
        });

        expect(harness.deleteEvent).toHaveBeenCalledTimes(2);
        expect(harness.deleteSyncEntry).toHaveBeenCalledTimes(2);
        expect(harness.entries.has('task-1')).toBe(false);
        expect(result).toEqual({
            total: 1,
            failed: 1,
            stale: 1,
            staleFailed: 0,
        });
    });

    it('reconciles stale mappings that no longer have a task', async () => {
        const harness = createHarness();
        harness.entries.set('ghost', {
            taskId: 'ghost',
            calendarEventId: 'event-ghost',
            calendarId: 'calendar-1',
            platform: 'test',
            lastSyncedAt: now,
        });

        const result = await runCalendarPushFullSync({
            tasks: [],
            target: { id: 'calendar-1' },
            ports: harness.ports,
        });

        expect(harness.deleteEvent).toHaveBeenCalledTimes(1);
        expect(harness.entries.size).toBe(0);
        expect(result.stale).toBe(1);
        expect(result.staleFailed).toBe(0);
    });

    it('honors the configured concurrency limit', async () => {
        const harness = createHarness();
        let active = 0;
        let peak = 0;
        harness.createEvent.mockImplementation(async (task) => {
            active += 1;
            peak = Math.max(peak, active);
            await Promise.resolve();
            active -= 1;
            return 'event-' + task.id;
        });
        const tasks = Array.from({ length: 6 }, (_value, index) =>
            makeTask({ id: 'task-' + index })
        );

        await runCalendarPushFullSync({
            tasks,
            target: { id: 'calendar-1' },
            ports: harness.ports,
            concurrency: 2,
        });

        expect(peak).toBe(2);
    });
});

describe('runCalendarPushPartialSync', () => {
    it('keeps a one-task partial run on the point lookup path', async () => {
        const harness = createHarness();

        const result = await runCalendarPushPartialSync({
            taskIds: ['task-1'],
            tasksById: new Map([['task-1', makeTask()]]),
            target: { id: 'calendar-1' },
            ports: harness.ports,
        });

        expect(harness.getSyncEntry.mock.calls).toEqual([
            ['task-1'],
            ['task-1:projected-recurrence'],
        ]);
        expect(harness.getAllSyncEntries).not.toHaveBeenCalled();
        expect(result).toEqual({
            total: 1,
            failed: 0,
            removed: 1,
            removedFailed: 0,
        });
    });

    it('removes mappings for a missing task and its projected occurrence', async () => {
        const harness = createHarness();
        for (const taskId of ['missing', 'missing:projected-recurrence']) {
            harness.entries.set(taskId, {
                taskId,
                calendarEventId: 'event-' + taskId,
                calendarId: 'calendar-1',
                platform: 'test',
                lastSyncedAt: now,
            });
        }

        const result = await runCalendarPushPartialSync({
            taskIds: ['missing'],
            tasksById: new Map(),
            target: { id: 'calendar-1' },
            ports: harness.ports,
        });

        expect(harness.deleteEvent).toHaveBeenCalledTimes(2);
        expect(harness.entries.size).toBe(0);
        expect(result).toEqual({
            total: 0,
            failed: 0,
            removed: 2,
            removedFailed: 0,
        });
    });
});
