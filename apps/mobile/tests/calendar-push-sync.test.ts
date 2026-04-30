import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockCalendarSyncEntry = {
    taskId: string;
    calendarEventId: string;
    calendarId: string;
    platform: string;
    lastSyncedAt: string;
};

type MockCalendarStoreState = {
    tasks: unknown[];
    _allTasks: unknown[];
};

// ---------------------------------------------------------------------------
// Hoisted mocks — must be set up before any imports that reference them
// ---------------------------------------------------------------------------

const {
    mockGetItem,
    mockSetItem,
    mockRemoveItem,
    mockGetCalendarsAsync,
    mockGetSourcesAsync,
    mockCreateCalendarAsync,
    mockDeleteCalendarAsync,
    mockCreateEventAsync,
    mockUpdateEventAsync,
    mockDeleteEventAsync,
    mockGetCalendarSyncEntry,
    mockUpsertCalendarSyncEntry,
    mockDeleteCalendarSyncEntry,
    mockGetAllCalendarSyncEntries,
    mockGetState,
    mockSubscribe,
    mockLogInfo,
    mockLogWarn,
    mockLogError,
    mockPlatform,
} = vi.hoisted(() => ({
    mockGetItem: vi.fn(async () => null as string | null),
    mockSetItem: vi.fn(async () => {}),
    mockRemoveItem: vi.fn(async () => {}),
    mockGetCalendarsAsync: vi.fn(async () => [] as Array<{
        id: string;
        title?: string;
        ownerAccount?: string;
        accessLevel?: string;
        allowsModifications?: boolean;
        source?: {
            name: string;
            type?: string;
            isLocalAccount?: boolean;
        };
    }>),
    mockGetSourcesAsync: vi.fn(async () => [{ id: 'src1', type: 'local', name: 'Local' }]),
    mockCreateCalendarAsync: vi.fn(async () => 'cal-1'),
    mockDeleteCalendarAsync: vi.fn(async () => {}),
    mockCreateEventAsync: vi.fn(async () => 'evt-1'),
    mockUpdateEventAsync: vi.fn(async () => 'evt-1'),
    mockDeleteEventAsync: vi.fn(async () => {}),
    mockGetCalendarSyncEntry: vi.fn<(taskId: string, platform: string) => Promise<MockCalendarSyncEntry | null>>(async () => null),
    mockUpsertCalendarSyncEntry: vi.fn(async () => {}),
    mockDeleteCalendarSyncEntry: vi.fn<(taskId: string, platform: string) => Promise<void>>(async () => {}),
    mockGetAllCalendarSyncEntries: vi.fn<(platform: string) => Promise<MockCalendarSyncEntry[]>>(async () => []),
    mockGetState: vi.fn<() => MockCalendarStoreState>(() => ({ tasks: [], _allTasks: [] })),
    mockSubscribe: vi.fn<(listener: (state: MockCalendarStoreState) => void) => () => void>(() => () => {}),
    mockLogInfo: vi.fn(),
    mockLogWarn: vi.fn(),
    mockLogError: vi.fn(),
    mockPlatform: { OS: 'ios' },
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: mockGetItem,
        setItem: mockSetItem,
        removeItem: mockRemoveItem,
    },
}));

vi.mock('expo-calendar', () => ({
    EntityTypes: { EVENT: 'event' },
    SourceType: { LOCAL: 'local', CALDAV: 'caldav' },
    CalendarAccessLevel: {
        CONTRIBUTOR: 'contributor',
        EDITOR: 'editor',
        FREEBUSY: 'freebusy',
        NONE: 'none',
        OWNER: 'owner',
        READ: 'read',
        RESPOND: 'respond',
        ROOT: 'root',
        OVERRIDE: 'override',
        UNKNOWN: 'unknown',
    },
    getCalendarsAsync: mockGetCalendarsAsync,
    getSourcesAsync: mockGetSourcesAsync,
    createCalendarAsync: mockCreateCalendarAsync,
    deleteCalendarAsync: mockDeleteCalendarAsync,
    createEventAsync: mockCreateEventAsync,
    updateEventAsync: mockUpdateEventAsync,
    deleteEventAsync: mockDeleteEventAsync,
    getCalendarPermissionsAsync: vi.fn(async () => ({ status: 'granted' })),
    requestCalendarPermissionsAsync: vi.fn(async () => ({ status: 'granted' })),
}));

vi.mock('react-native', () => ({
    Platform: mockPlatform,
}));

vi.mock('@mindwtr/core', () => ({
    useTaskStore: {
        getState: mockGetState,
        subscribe: mockSubscribe,
    },
    hasTimeComponent: (dateStr: string | null | undefined): boolean =>
        Boolean(dateStr && /[T\s]\d{2}:\d{2}/.test(dateStr)),
    // Real implementation: parses YYYY-MM-DD as LOCAL midnight (not UTC).
    safeParseDate: (dateStr: string | null | undefined): Date | null => {
        if (!dateStr) return null;
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
        if (match) {
            return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
        }
        const d = new Date(dateStr);
        return isNaN(d.getTime()) ? null : d;
    },
}));

vi.mock('@/lib/storage-adapter', () => ({
    getCalendarSyncEntry: mockGetCalendarSyncEntry,
    upsertCalendarSyncEntry: mockUpsertCalendarSyncEntry,
    deleteCalendarSyncEntry: mockDeleteCalendarSyncEntry,
    getAllCalendarSyncEntries: mockGetAllCalendarSyncEntries,
}));

vi.mock('@/lib/app-log', () => ({
    logInfo: mockLogInfo,
    logWarn: mockLogWarn,
    logError: mockLogError,
}));

// ---------------------------------------------------------------------------
// Subject under test — imported AFTER mocks are established
// ---------------------------------------------------------------------------

import {
    ensureMindwtrCalendar,
    getCalendarPushTargetCalendars,
    runFullCalendarSync,
    startCalendarPushSync,
    stopCalendarPushSync,
} from '@/lib/calendar-push-sync';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<{
    id: string;
    title: string;
    status: string;
    startTime: string | null;
    dueDate: string | null;
    timeEstimate: string;
    deletedAt: string | null;
    updatedAt: string;
}> = {}) {
    return {
        id: 'task-1',
        title: 'My Task',
        status: 'next',
        dueDate: '2026-04-20',
        deletedAt: null,
        updatedAt: new Date().toISOString(),
        description: '',
        ...overrides,
    };
}

/** Sets up the AsyncStorage.getItem calls made by runFullCalendarSync. */
function setupEnabled(calendarId = 'cal-1', targetCalendarId: string | null = null) {
    mockGetItem
        .mockResolvedValueOnce('1')         // getCalendarPushEnabled → enabled
        .mockResolvedValueOnce(targetCalendarId); // getCalendarPushTargetCalendarId
    if (!targetCalendarId) {
        mockGetItem.mockResolvedValueOnce(calendarId); // ensureMindwtrCalendar → stored ID
    }
}

function setStoreTasks(tasks: unknown[], allTasks: unknown[] = tasks) {
    mockGetState.mockReturnValue({ tasks, _allTasks: allTasks });
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockPlatform.OS = 'ios';
    // Default: the stored calendar still exists
    mockGetCalendarsAsync.mockResolvedValue([{ id: 'cal-1', title: 'Mindwtr' }]);
    // Default: no prior sync entries
    mockGetCalendarSyncEntry.mockResolvedValue(null);
    mockGetAllCalendarSyncEntries.mockResolvedValue([]);
});

afterEach(() => {
    stopCalendarPushSync();
    vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ensureMindwtrCalendar', () => {
    it('returns the stored calendar ID when the calendar still exists', async () => {
        mockGetItem.mockResolvedValueOnce('cal-1'); // CALENDAR_ID_KEY

        const id = await ensureMindwtrCalendar();

        expect(id).toBe('cal-1');
        expect(mockCreateCalendarAsync).not.toHaveBeenCalled();
    });

    it('recreates the calendar when the stored one has been deleted', async () => {
        mockGetItem.mockResolvedValueOnce('cal-old'); // stored but gone
        mockGetCalendarsAsync.mockResolvedValue([]);  // not found
        mockCreateCalendarAsync.mockResolvedValue('cal-2');

        const id = await ensureMindwtrCalendar();

        expect(mockCreateCalendarAsync).toHaveBeenCalledOnce();
        expect(id).toBe('cal-2');
        expect(mockSetItem).toHaveBeenCalledWith('mindwtr:calendar-push-sync:calendar-id', 'cal-2');
    });

    it('creates an Android managed calendar using an existing owned calendar source', async () => {
        mockPlatform.OS = 'android';
        mockGetItem.mockResolvedValueOnce(null);
        mockCreateCalendarAsync.mockResolvedValue('cal-android');
        mockGetCalendarsAsync.mockResolvedValue([
            {
                id: 'google-primary',
                title: 'Personal',
                ownerAccount: 'me@gmail.com',
                accessLevel: 'owner',
                source: {
                    name: 'me@gmail.com',
                    type: 'com.google',
                },
            },
        ]);

        const id = await ensureMindwtrCalendar();

        expect(id).toBe('cal-android');
        expect(mockCreateCalendarAsync).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Mindwtr',
            name: 'mindwtr',
            ownerAccount: 'me@gmail.com',
            accessLevel: 'owner',
            isVisible: true,
            isSynced: true,
            source: {
                name: 'me@gmail.com',
                type: 'com.google',
            },
        }));
    });

    it('returns null on Android when no usable owned calendar source exists', async () => {
        mockPlatform.OS = 'android';
        mockGetItem.mockResolvedValueOnce(null);
        mockGetCalendarsAsync.mockResolvedValue([
            { id: 'read-only', title: 'Holidays', accessLevel: 'read' },
        ]);

        const id = await ensureMindwtrCalendar();

        expect(id).toBeNull();
        expect(mockCreateCalendarAsync).not.toHaveBeenCalled();
        expect(mockLogWarn).toHaveBeenCalled();
    });
});

describe('getCalendarPushTargetCalendars', () => {
    it('lists writable device calendars and filters read-only calendars', async () => {
        mockGetItem.mockResolvedValueOnce('managed-local');
        mockGetCalendarsAsync.mockResolvedValue([
            { id: 'holidays', title: 'Holidays', allowsModifications: false },
            {
                id: 'managed-local',
                title: 'Mindwtr',
                accessLevel: 'owner',
                allowsModifications: true,
                source: { name: 'local account', type: 'local' },
            },
            {
                id: 'google-mindwtr',
                title: 'Mindwtr',
                ownerAccount: 'me@gmail.com',
                accessLevel: 'owner',
                allowsModifications: true,
                source: { name: 'me@gmail.com', type: 'com.google' },
            },
            {
                id: 'google-primary',
                title: 'Google',
                ownerAccount: 'me@gmail.com',
                accessLevel: 'owner',
                allowsModifications: true,
                source: { name: 'me@gmail.com', type: 'com.google' },
            },
        ]);

        const targets = await getCalendarPushTargetCalendars();

        expect(targets).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'managed-local',
                name: 'Mindwtr',
                isMindwtrDedicated: true,
                isMindwtrManaged: true,
                isLocalOnly: true,
            }),
            expect.objectContaining({
                id: 'google-mindwtr',
                name: 'Mindwtr',
                sourceName: 'me@gmail.com',
                isMindwtrDedicated: true,
                isMindwtrManaged: false,
                isLocalOnly: false,
            }),
            expect.objectContaining({
                id: 'google-primary',
                name: 'Google',
                sourceName: 'me@gmail.com',
                isMindwtrDedicated: false,
                isMindwtrManaged: false,
                isLocalOnly: false,
            }),
        ]));
        expect(targets.map((target) => target.id)).not.toContain('holidays');
    });

    it('prefers the calendar owner account over a generic source name in target labels', async () => {
        mockGetItem.mockResolvedValueOnce(null);
        mockGetCalendarsAsync.mockResolvedValue([
            {
                id: 'google-mindwtr',
                title: 'Mindwtr',
                ownerAccount: 'me@gmail.com',
                accessLevel: 'owner',
                allowsModifications: true,
                source: { name: 'local account', type: 'com.google' },
            },
        ]);

        const targets = await getCalendarPushTargetCalendars();

        expect(targets).toEqual([
            expect.objectContaining({
                id: 'google-mindwtr',
                sourceName: 'me@gmail.com',
                isLocalOnly: false,
            }),
        ]);
    });

    it('uses the sync account label instead of Google secondary calendar owner ids', async () => {
        mockGetItem.mockResolvedValueOnce(null);
        mockGetCalendarsAsync.mockResolvedValue([
            {
                id: 'google-secondary-mindwtr',
                title: 'Mindwtr',
                ownerAccount: 'abc123@group.calendar.google.com',
                accessLevel: 'owner',
                allowsModifications: true,
                source: { name: 'me@gmail.com', type: 'com.google' },
            },
        ]);

        const targets = await getCalendarPushTargetCalendars();

        expect(targets).toEqual([
            expect.objectContaining({
                id: 'google-secondary-mindwtr',
                sourceName: 'me@gmail.com',
                isLocalOnly: false,
            }),
        ]);
    });

    it('marks provider local account calendars as device-local targets', async () => {
        mockGetItem.mockResolvedValueOnce(null);
        mockGetCalendarsAsync.mockResolvedValue([
            {
                id: 'local-mindwtr',
                title: 'Mindwtr',
                ownerAccount: 'local account',
                accessLevel: 'owner',
                allowsModifications: true,
                source: { name: 'local account', type: 'LOCAL' },
            },
        ]);

        const targets = await getCalendarPushTargetCalendars();

        expect(targets).toEqual([
            expect.objectContaining({
                id: 'local-mindwtr',
                isMindwtrDedicated: true,
                isLocalOnly: true,
            }),
        ]);
    });
});

describe('buildEventDetails — date-only due date stays on correct local day', () => {
    it('does not shift a YYYY-MM-DD due date to the previous day', async () => {
        setupEnabled();
        // Use a fixed date-only string — no time, no timezone suffix.
        // new Date('2026-04-20') parses as UTC midnight and shifts to Apr 19
        // in US time zones; safeParseDate('2026-04-20') must produce Apr 20.
        const task = makeTask({ dueDate: '2026-04-20' });
        setStoreTasks([task]);
        mockGetCalendarSyncEntry.mockResolvedValue(null);
        mockGetAllCalendarSyncEntries.mockResolvedValue([]);

        await runFullCalendarSync();

        expect(mockCreateEventAsync).toHaveBeenCalledOnce();
        const call = mockCreateEventAsync.mock.calls[0] as unknown as [string, { startDate: Date; endDate: Date; allDay: boolean }];
        const [, eventData] = call;

        expect(eventData.allDay).toBe(true);
        expect(eventData.startDate.getFullYear()).toBe(2026);
        expect(eventData.startDate.getMonth()).toBe(3); // April (0-indexed)
        expect(eventData.startDate.getDate()).toBe(20);
        expect(eventData.startDate.getHours()).toBe(0);

        expect(eventData.endDate.getFullYear()).toBe(2026);
        expect(eventData.endDate.getMonth()).toBe(3);
        expect(eventData.endDate.getDate()).toBe(20);
    });

    it('creates a timed event for a scheduled task with a start time', async () => {
        setupEnabled();
        const task = makeTask({
            dueDate: null,
            startTime: '2026-04-20T10:45:00.000Z',
            timeEstimate: '1hr',
        });
        setStoreTasks([task]);
        mockGetCalendarSyncEntry.mockResolvedValue(null);
        mockGetAllCalendarSyncEntries.mockResolvedValue([]);

        await runFullCalendarSync();

        expect(mockCreateEventAsync).toHaveBeenCalledOnce();
        const call = mockCreateEventAsync.mock.calls[0] as unknown as [string, { startDate: Date; endDate: Date; allDay: boolean }];
        const [, eventData] = call;

        expect(eventData.allDay).toBe(false);
        expect(eventData.startDate.toISOString()).toBe('2026-04-20T10:45:00.000Z');
        expect(eventData.endDate.toISOString()).toBe('2026-04-20T11:45:00.000Z');
    });
});

describe('runFullCalendarSync — selected target calendar', () => {
    it('writes prefixed events to a selected account calendar instead of creating the managed calendar', async () => {
        setupEnabled('cal-managed', 'google-primary');
        mockGetCalendarsAsync.mockResolvedValue([
            {
                id: 'google-primary',
                title: 'Google',
                accessLevel: 'owner',
                allowsModifications: true,
            },
        ]);
        const task = makeTask();
        setStoreTasks([task]);
        mockGetCalendarSyncEntry.mockResolvedValue(null);
        mockGetAllCalendarSyncEntries.mockResolvedValue([]);

        await runFullCalendarSync();

        expect(mockCreateCalendarAsync).not.toHaveBeenCalled();
        expect(mockCreateEventAsync).toHaveBeenCalledWith('google-primary', expect.objectContaining({
            calendarId: 'google-primary',
            title: `Mindwtr: ${task.title}`,
        }));
    });

    it('keeps titles unprefixed when the selected target is the managed Mindwtr calendar', async () => {
        setupEnabled('cal-managed', 'cal-managed');
        mockGetCalendarsAsync.mockResolvedValue([
            {
                id: 'cal-managed',
                title: 'Mindwtr',
                accessLevel: 'owner',
                allowsModifications: true,
            },
        ]);
        const task = makeTask();
        setStoreTasks([task]);

        await runFullCalendarSync();

        expect(mockCreateEventAsync).toHaveBeenCalledWith('cal-managed', expect.objectContaining({
            calendarId: 'cal-managed',
            title: task.title,
        }));
    });

    it('does not duplicate the Mindwtr title prefix on account calendars', async () => {
        setupEnabled('cal-managed', 'google-primary');
        mockGetCalendarsAsync.mockResolvedValue([
            {
                id: 'google-primary',
                title: 'Google',
                accessLevel: 'owner',
                allowsModifications: true,
            },
        ]);
        const task = makeTask({ title: 'Mindwtr: Existing prefix' });
        setStoreTasks([task]);

        await runFullCalendarSync();

        expect(mockCreateEventAsync).toHaveBeenCalledWith('google-primary', expect.objectContaining({
            calendarId: 'google-primary',
            title: task.title,
        }));
    });

    it('keeps titles unprefixed when the selected target is a user-created Google Mindwtr calendar', async () => {
        setupEnabled('cal-managed', 'google-mindwtr');
        mockGetCalendarsAsync.mockResolvedValue([
            {
                id: 'google-mindwtr',
                title: 'Mindwtr',
                accessLevel: 'owner',
                allowsModifications: true,
                source: { name: 'me@gmail.com', type: 'com.google' },
            },
        ]);
        const task = makeTask();
        setStoreTasks([task]);

        await runFullCalendarSync();

        expect(mockCreateEventAsync).toHaveBeenCalledWith('google-mindwtr', expect.objectContaining({
            calendarId: 'google-mindwtr',
            title: task.title,
        }));
    });

    it('moves an existing event when the selected calendar changes', async () => {
        setupEnabled('cal-managed', 'google-primary');
        mockGetCalendarsAsync.mockResolvedValue([
            {
                id: 'google-primary',
                title: 'Google',
                accessLevel: 'owner',
                allowsModifications: true,
            },
        ]);
        const task = makeTask();
        const previousEntry = {
            taskId: task.id,
            calendarEventId: 'evt-old',
            calendarId: 'cal-old',
            platform: 'ios',
            lastSyncedAt: '',
        };
        setStoreTasks([task]);
        mockGetCalendarSyncEntry.mockResolvedValue(previousEntry);
        mockGetAllCalendarSyncEntries.mockResolvedValue([previousEntry]);

        await runFullCalendarSync();

        expect(mockDeleteEventAsync).toHaveBeenCalledWith('evt-old');
        expect(mockCreateEventAsync).toHaveBeenCalledWith('google-primary', expect.objectContaining({
            calendarId: 'google-primary',
        }));
        expect(mockUpsertCalendarSyncEntry).toHaveBeenCalledWith(expect.objectContaining({
            taskId: task.id,
            calendarEventId: 'evt-1',
            calendarId: 'google-primary',
        }));
    });
});

describe('runFullCalendarSync — completion removes event', () => {
    it('removes a calendar event when the task is marked done', async () => {
        setupEnabled();
        const task = makeTask({ status: 'done' });
        setStoreTasks([task]);
        const entry = { taskId: task.id, calendarEventId: 'evt-done', calendarId: 'cal-1', platform: 'ios', lastSyncedAt: '' };
        mockGetCalendarSyncEntry.mockResolvedValue(entry);
        mockGetAllCalendarSyncEntries.mockResolvedValue([]);

        await runFullCalendarSync();

        expect(mockDeleteEventAsync).toHaveBeenCalledWith('evt-done');
        expect(mockDeleteCalendarSyncEntry).toHaveBeenCalledWith(task.id, 'ios');
        expect(mockCreateEventAsync).not.toHaveBeenCalled();
    });

    it('removes a calendar event when the task is archived', async () => {
        setupEnabled();
        const task = makeTask({ status: 'archived' });
        setStoreTasks([task]);
        mockGetCalendarSyncEntry.mockResolvedValue(
            { taskId: task.id, calendarEventId: 'evt-arch', calendarId: 'cal-1', platform: 'ios', lastSyncedAt: '' }
        );
        mockGetAllCalendarSyncEntries.mockResolvedValue([]);

        await runFullCalendarSync();

        expect(mockDeleteEventAsync).toHaveBeenCalledWith('evt-arch');
        expect(mockCreateEventAsync).not.toHaveBeenCalled();
    });
});

describe('runFullCalendarSync — event removal', () => {
    it('removes a calendar event when dueDate is cleared', async () => {
        setupEnabled();
        const task = makeTask({ dueDate: null });
        setStoreTasks([task]);
        mockGetCalendarSyncEntry.mockResolvedValue(
            { taskId: task.id, calendarEventId: 'evt-old', calendarId: 'cal-1', platform: 'ios', lastSyncedAt: '' }
        );
        mockGetAllCalendarSyncEntries.mockResolvedValue([]);

        await runFullCalendarSync();

        expect(mockDeleteEventAsync).toHaveBeenCalledWith('evt-old');
        expect(mockCreateEventAsync).not.toHaveBeenCalled();
    });

    it('removes a calendar event when the task is soft-deleted', async () => {
        setupEnabled();
        const task = makeTask({ deletedAt: new Date().toISOString() });
        setStoreTasks([task]);
        mockGetCalendarSyncEntry.mockResolvedValue(
            { taskId: task.id, calendarEventId: 'evt-del', calendarId: 'cal-1', platform: 'ios', lastSyncedAt: '' }
        );
        mockGetAllCalendarSyncEntries.mockResolvedValue([]);

        await runFullCalendarSync();

        expect(mockDeleteEventAsync).toHaveBeenCalledWith('evt-del');
    });
});

describe('runFullCalendarSync — startup reconciliation', () => {
    it('removes stale events for tasks no longer in the store', async () => {
        setupEnabled();
        setStoreTasks([]);
        const ghostEntry = { taskId: 'ghost-task', calendarEventId: 'evt-ghost', calendarId: 'cal-1', platform: 'ios', lastSyncedAt: '' };
        mockGetAllCalendarSyncEntries.mockResolvedValue([ghostEntry]);
        mockGetCalendarSyncEntry.mockResolvedValue(ghostEntry);

        await runFullCalendarSync();

        expect(mockDeleteEventAsync).toHaveBeenCalledWith('evt-ghost');
        expect(mockDeleteCalendarSyncEntry).toHaveBeenCalledWith('ghost-task', 'ios');
    });

    it('removes stale events for tasks completed between sessions', async () => {
        setupEnabled();
        const task = makeTask({ status: 'done' });
        setStoreTasks([task]);
        const staleEntry = { taskId: task.id, calendarEventId: 'evt-stale', calendarId: 'cal-1', platform: 'ios', lastSyncedAt: '' };
        mockGetAllCalendarSyncEntries.mockResolvedValue([staleEntry]);
        mockGetCalendarSyncEntry.mockResolvedValue(staleEntry);

        await runFullCalendarSync();

        expect(mockDeleteEventAsync).toHaveBeenCalledWith('evt-stale');
    });

    it('does not touch events for active tasks with due dates', async () => {
        setupEnabled();
        const task = makeTask();
        setStoreTasks([task]);
        const activeEntry = { taskId: task.id, calendarEventId: 'evt-active', calendarId: 'cal-1', platform: 'ios', lastSyncedAt: '' };
        mockGetCalendarSyncEntry.mockResolvedValue(activeEntry);
        mockGetAllCalendarSyncEntries.mockResolvedValue([activeEntry]);

        await runFullCalendarSync();

        expect(mockDeleteEventAsync).not.toHaveBeenCalled();
        expect(mockUpdateEventAsync).toHaveBeenCalledOnce();
    });
});

describe('startCalendarPushSync', () => {
    it('keeps deleted tombstones in the debounced sync set until the partial sync runs', async () => {
        setupEnabled();

        const taskOne = makeTask({ id: 'task-1', title: 'First task', updatedAt: '2026-04-20T00:00:00.000Z' });
        const taskTwo = makeTask({ id: 'task-2', title: 'Second task', updatedAt: '2026-04-20T00:00:00.000Z' });
        const taskOneDeleted = {
            ...taskOne,
            deletedAt: '2026-04-20T01:00:00.000Z',
            updatedAt: '2026-04-20T01:00:00.000Z',
        };
        const taskTwoUpdated = {
            ...taskTwo,
            updatedAt: '2026-04-20T02:00:00.000Z',
            title: 'Second task updated',
            timeEstimate: '1hr',
        };
        let storeState = {
            tasks: [taskOne, taskTwo],
            _allTasks: [taskOne, taskTwo],
        };

        mockGetState.mockImplementation(() => storeState);
        mockGetCalendarSyncEntry.mockImplementation(async (taskId: string) => {
            if (taskId === 'task-1') {
                return { taskId, calendarEventId: 'evt-1', calendarId: 'cal-1', platform: 'ios', lastSyncedAt: '' };
            }
            if (taskId === 'task-2') {
                return { taskId, calendarEventId: 'evt-2', calendarId: 'cal-1', platform: 'ios', lastSyncedAt: '' };
            }
            return null;
        });

        startCalendarPushSync();
        const listener = mockSubscribe.mock.calls[0]?.[0] as ((state: typeof storeState) => void) | undefined;
        expect(listener).toBeTypeOf('function');
        if (!listener) return;

        storeState = {
            tasks: [taskTwo],
            _allTasks: [taskOneDeleted, taskTwo],
        };
        listener(storeState);

        storeState = {
            tasks: [taskTwoUpdated],
            _allTasks: [taskOneDeleted, taskTwoUpdated],
        };
        listener(storeState);

        await vi.advanceTimersByTimeAsync(2500);
        await Promise.resolve();

        expect(mockDeleteEventAsync).toHaveBeenCalledWith('evt-1');
        expect(mockDeleteCalendarSyncEntry).toHaveBeenCalledWith('task-1', 'ios');
        expect(mockUpdateEventAsync).toHaveBeenCalledWith('evt-2', expect.objectContaining({
            title: 'Second task updated',
            allDay: true,
        }));
    });
});
