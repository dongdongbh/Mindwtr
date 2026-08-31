import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskStore, type CalendarSyncEntry, type Project, type Section, type Task } from '@mindwtr/core';

import {
    __desktopCalendarPushSyncTestUtils,
    enableDesktopCalendarPush,
    runFullDesktopCalendarPushSync,
} from './desktop-calendar-push-sync';
import type { SystemCalendarEventDetails, SystemCalendarEventWriteResult, SystemCalendarPushTarget } from './system-calendar';

const makeTask = (overrides: Partial<Task> = {}): Task => ({
    id: 'task-1',
    title: 'Plan review',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-01-01T08:00:00.000Z',
    updatedAt: '2026-01-01T08:00:00.000Z',
    ...overrides,
});

const setStoreTasks = (tasks: Task[]) => {
    useTaskStore.setState((state) => ({
        ...state,
        tasks,
        _allTasks: tasks,
        _tasksById: new Map(tasks.map((task) => [task.id, task])),
    }));
};

const setStoreProjectsAndSections = (projects: Project[], sections: Section[]) => {
    // Write the canonical `_all*` collections; the store derives the visible
    // `projects`/`sections` arrays and id maps from them.
    useTaskStore.setState({ _allProjects: projects, _allSections: sections });
};

const writeOk = (eventId: string | null): SystemCalendarEventWriteResult => ({
    ok: true,
    eventId,
});

const writeFailed = (error: string): SystemCalendarEventWriteResult => ({
    ok: false,
    eventId: null,
    error,
});

describe('desktop calendar push sync', () => {
    let createEvent: ReturnType<typeof vi.fn<(details: SystemCalendarEventDetails) => Promise<SystemCalendarEventWriteResult>>>;
    let updateEvent: ReturnType<typeof vi.fn<(eventId: string, details: SystemCalendarEventDetails) => Promise<SystemCalendarEventWriteResult>>>;
    let deleteEvent: ReturnType<typeof vi.fn<(eventId: string) => Promise<SystemCalendarEventWriteResult>>>;
    let upsertSyncEntry: ReturnType<typeof vi.fn<(entry: CalendarSyncEntry) => Promise<void>>>;
    let deleteSyncEntry: ReturnType<typeof vi.fn<(taskId: string, platform: string) => Promise<void>>>;
    let getSyncEntry: ReturnType<typeof vi.fn<(taskId: string, platform: string) => Promise<CalendarSyncEntry | null>>>;
    let getAllSyncEntries: ReturnType<typeof vi.fn<(platform: string) => Promise<CalendarSyncEntry[]>>>;
    let getTargetCalendarId: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
    let getTargets: ReturnType<typeof vi.fn<() => Promise<SystemCalendarPushTarget[]>>>;
    let ensureMindwtrCalendar: ReturnType<typeof vi.fn<() => Promise<SystemCalendarPushTarget | null>>>;

    const managedTarget: SystemCalendarPushTarget = {
        id: 'cal-mindwtr',
        name: 'Mindwtr',
        isMindwtrDedicated: true,
    };

    beforeEach(() => {
        (window as any).__TAURI_INTERNALS__ = {};
        __desktopCalendarPushSyncTestUtils.resetForTests();
        setStoreProjectsAndSections([], []);
        setStoreTasks([]);

        createEvent = vi.fn(async () => writeOk('event-new'));
        updateEvent = vi.fn(async (_eventId) => writeOk(_eventId));
        deleteEvent = vi.fn(async (_eventId) => writeOk(_eventId));
        upsertSyncEntry = vi.fn(async () => undefined);
        deleteSyncEntry = vi.fn(async () => undefined);
        getSyncEntry = vi.fn(async () => null);
        getAllSyncEntries = vi.fn(async () => []);
        getTargetCalendarId = vi.fn(async () => null);
        getTargets = vi.fn(async () => [managedTarget]);
        ensureMindwtrCalendar = vi.fn(async () => managedTarget);

        __desktopCalendarPushSyncTestUtils.setDependenciesForTests({
            createEvent,
            updateEvent,
            deleteEvent,
            upsertSyncEntry,
            deleteSyncEntry,
            getSyncEntry,
            getAllSyncEntries,
            getTargetCalendarId,
            getTargets,
            ensureMindwtrCalendar,
            getManagedCalendarId: async () => null,
            getPermissionStatus: async () => 'granted',
            getPlatform: () => 'macos',
            getPushEnabled: async () => true,
            setManagedCalendarId: async () => undefined,
            removeManagedCalendarId: async () => undefined,
            setTargetCalendarId: async () => undefined,
            nowIso: () => '2026-01-01T12:00:00.000Z',
        });
    });

    it('creates all-day events for due-date tasks in the managed Mindwtr calendar', async () => {
        setStoreTasks([makeTask({ dueDate: '2026-01-10' })]);

        await runFullDesktopCalendarPushSync();

        expect(ensureMindwtrCalendar).toHaveBeenCalledTimes(1);
        expect(createEvent).toHaveBeenCalledWith(expect.objectContaining({
            calendarId: 'cal-mindwtr',
            title: 'Plan review',
            startDate: '2026-01-10',
            endDate: '2026-01-11',
            allDay: true,
        }));
        // EventKit counts every day the [start, end] range touches, so the
        // instant end must stay inside the same local day (#1065) while the
        // exclusive date-only endDate above keeps the Linux ICS path correct.
        const details = createEvent.mock.calls[0][0];
        const endInstant = new Date(details.end);
        expect(endInstant.getFullYear()).toBe(2026);
        expect(endInstant.getMonth()).toBe(0);
        expect(endInstant.getDate()).toBe(10);
        expect(new Date(details.start).getDate()).toBe(10);
        expect(upsertSyncEntry).toHaveBeenCalledWith(expect.objectContaining({
            taskId: 'task-1',
            calendarEventId: 'event-new',
            calendarId: 'cal-mindwtr',
            platform: 'macos',
        }));
    });

    it('stores calendar mappings under the active desktop platform', async () => {
        __desktopCalendarPushSyncTestUtils.setDependenciesForTests({
            getPlatform: () => 'linux',
        });
        setStoreTasks([makeTask({ dueDate: '2026-01-10' })]);

        await runFullDesktopCalendarPushSync();

        expect(upsertSyncEntry).toHaveBeenCalledWith(expect.objectContaining({
            taskId: 'task-1',
            platform: 'linux',
        }));
    });

    it('enriches event notes with project, section, status, effort, and links via the core builder', async () => {
        setStoreProjectsAndSections(
            [{ id: 'proj-1', title: 'Launch' } as Project],
            [{ id: 'sec-1', title: 'Phase 2' } as Section],
        );
        setStoreTasks([makeTask({
            dueDate: '2026-01-10',
            projectId: 'proj-1',
            sectionId: 'sec-1',
            timeEstimate: '1hr',
            description: 'Discuss roadmap',
            attachments: [{
                id: 'att-1',
                kind: 'link',
                title: 'Doc',
                uri: 'https://example.com/doc',
                createdAt: '2026-01-01T08:00:00.000Z',
                updatedAt: '2026-01-01T08:00:00.000Z',
            }],
        })]);

        await runFullDesktopCalendarPushSync();

        const notes = createEvent.mock.calls[0]?.[0]?.notes ?? '';
        expect(notes).toContain('Project: Launch › Phase 2');
        expect(notes).toContain('Status: Next');
        expect(notes).toContain('Effort: 1 h');
        expect(notes).toContain('Discuss roadmap');
        expect(notes).toContain('Link: https://example.com/doc');
    });

    it('sizes the pushed event by the estimate only while Time estimates is on', async () => {
        setStoreTasks([makeTask({ startTime: '2026-01-10T09:00:00', timeEstimate: '2hr' })]);
        await runFullDesktopCalendarPushSync();
        const enabledEnd = new Date(createEvent.mock.calls[0]?.[0]?.end as string);
        expect(enabledEnd.getHours()).toBe(11);

        createEvent.mockClear();
        // Feature off: the stored estimate stays on the task but stops
        // stretching the pushed event (the 30-minute default takes over).
        useTaskStore.setState((state) => ({ ...state, settings: { ...state.settings, features: { timeEstimates: false } } }));
        setStoreTasks([makeTask({ id: 'task-2', startTime: '2026-01-10T09:00:00', timeEstimate: '2hr' })]);
        await runFullDesktopCalendarPushSync();
        const disabledEnd = new Date(createEvent.mock.calls[0]?.[0]?.end as string);
        expect(disabledEnd.getHours()).toBe(9);
        expect(disabledEnd.getMinutes()).toBe(30);
    });

    it('prefixes titles when pushing to a shared selected calendar', async () => {
        getTargetCalendarId.mockResolvedValue('cal-shared');
        getTargets.mockResolvedValue([{
            id: 'cal-shared',
            name: 'Work',
            isMindwtrDedicated: false,
        }]);
        setStoreTasks([makeTask({ startTime: '2026-01-10T09:00:00' })]);

        await runFullDesktopCalendarPushSync();

        expect(createEvent).toHaveBeenCalledWith(expect.objectContaining({
            calendarId: 'cal-shared',
            title: 'Mindwtr: Plan review',
            allDay: false,
        }));
    });

    it('includes the projected occurrence date in pushed recurring event details', async () => {
        setStoreTasks([makeTask({
            id: 'task-recurring',
            title: 'Monthly bill',
            dueDate: '2026-01-10',
            recurrence: { rule: 'monthly', strategy: 'strict' },
            showFutureRecurrence: true,
        })]);

        await runFullDesktopCalendarPushSync();

        expect(createEvent).toHaveBeenCalledWith(expect.objectContaining({
            calendarId: 'cal-mindwtr',
            title: 'Monthly bill (Feb 10, 2026)',
            notes: expect.stringContaining('Projected recurring occurrence for Feb 10, 2026'),
        }));
    });

    it('removes pushed events when tasks are completed', async () => {
        const entry: CalendarSyncEntry = {
            taskId: 'task-1',
            calendarEventId: 'event-old',
            calendarId: 'cal-mindwtr',
            platform: 'macos',
            lastSyncedAt: '2026-01-01T00:00:00.000Z',
        };
        getSyncEntry.mockResolvedValue(entry);
        setStoreTasks([makeTask({ dueDate: '2026-01-10', status: 'done' })]);

        await runFullDesktopCalendarPushSync();

        expect(deleteEvent).toHaveBeenCalledWith('event-old');
        expect(deleteSyncEntry).toHaveBeenCalledWith('task-1', 'macos');
        expect(createEvent).not.toHaveBeenCalled();
    });

    it('keeps the sync mapping when deleting an event fails', async () => {
        const entry: CalendarSyncEntry = {
            taskId: 'task-1',
            calendarEventId: 'event-old',
            calendarId: 'cal-mindwtr',
            platform: 'macos',
            lastSyncedAt: '2026-01-01T00:00:00.000Z',
        };
        deleteEvent.mockResolvedValue(writeFailed('calendar-temporarily-unavailable'));
        getSyncEntry.mockResolvedValue(entry);
        setStoreTasks([makeTask({ dueDate: '2026-01-10', status: 'done' })]);

        await runFullDesktopCalendarPushSync();

        expect(deleteEvent).toHaveBeenCalledWith('event-old');
        expect(deleteSyncEntry).not.toHaveBeenCalled();
        expect(createEvent).not.toHaveBeenCalled();
    });

    it('does not create a duplicate when updating an existing event fails', async () => {
        const entry: CalendarSyncEntry = {
            taskId: 'task-1',
            calendarEventId: 'event-old',
            calendarId: 'cal-mindwtr',
            platform: 'macos',
            lastSyncedAt: '2026-01-01T00:00:00.000Z',
        };
        updateEvent.mockResolvedValue(writeFailed('calendar-temporarily-unavailable'));
        getSyncEntry.mockResolvedValue(entry);
        setStoreTasks([makeTask({ dueDate: '2026-01-10' })]);

        await runFullDesktopCalendarPushSync();

        expect(updateEvent).toHaveBeenCalledWith('event-old', expect.objectContaining({
            calendarId: 'cal-mindwtr',
        }));
        expect(createEvent).not.toHaveBeenCalled();
        expect(upsertSyncEntry).not.toHaveBeenCalled();
        expect(deleteSyncEntry).not.toHaveBeenCalled();
    });

    it('recreates an event when the previous macOS event was deleted externally', async () => {
        const entry: CalendarSyncEntry = {
            taskId: 'task-1',
            calendarEventId: 'event-old',
            calendarId: 'cal-mindwtr',
            platform: 'macos',
            lastSyncedAt: '2026-01-01T00:00:00.000Z',
        };
        updateEvent.mockResolvedValue(writeFailed('event-not-found'));
        getSyncEntry.mockResolvedValue(entry);
        setStoreTasks([makeTask({ dueDate: '2026-01-10' })]);

        await runFullDesktopCalendarPushSync();

        expect(deleteSyncEntry).toHaveBeenCalledWith('task-1', 'macos');
        expect(createEvent).toHaveBeenCalledWith(expect.objectContaining({
            calendarId: 'cal-mindwtr',
        }));
        expect(upsertSyncEntry).toHaveBeenCalledWith(expect.objectContaining({
            calendarEventId: 'event-new',
        }));
    });

    it('reconciles stale calendar sync entries on full sync', async () => {
        getAllSyncEntries.mockResolvedValue([{
            taskId: 'ghost-task',
            calendarEventId: 'event-ghost',
            calendarId: 'cal-mindwtr',
            platform: 'macos',
            lastSyncedAt: '2026-01-01T00:00:00.000Z',
        }]);
        setStoreTasks([]);

        await runFullDesktopCalendarPushSync();

        expect(deleteEvent).toHaveBeenCalledWith('event-ghost');
        expect(deleteSyncEntry).toHaveBeenCalledWith('ghost-task', 'macos');
    });

    it('rolls back the enabled setting and subscription when initial sync fails', async () => {
        const setPushEnabled = vi.fn(async () => undefined);
        const unsubscribe = vi.fn();
        getAllSyncEntries.mockRejectedValue(new Error('calendar database unavailable'));
        __desktopCalendarPushSyncTestUtils.setDependenciesForTests({
            setPushEnabled,
            subscribe: vi.fn(() => unsubscribe) as unknown as typeof useTaskStore.subscribe,
        });

        await expect(enableDesktopCalendarPush()).rejects.toThrow('calendar database unavailable');

        expect(setPushEnabled.mock.calls).toEqual([[true], [false]]);
        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });
});
