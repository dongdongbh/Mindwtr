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
    projects: { id: string; title: string }[];
    sections: { id: string; title: string }[];
    settings?: unknown;
    _allTasks: unknown[];
    _tasksById: Map<string, unknown>;
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
    mockUpdateCalendarAsync,
    mockDeleteCalendarAsync,
    mockCreateEventAsync,
    mockUpdateEventAsync,
    mockDeleteEventAsync,
    mockGetCalendarSyncEntry,
    mockUpsertCalendarSyncEntry,
    mockDeleteCalendarSyncEntry,
    mockGetAllCalendarSyncEntries,
    mockEnsureCalendarSyncStorageReady,
    mockGetState,
    mockSubscribe,
    mockLogInfo,
    mockLogWarn,
    mockLogError,
    mockPlatform,
} = vi.hoisted(() => ({
    mockGetItem: vi.fn<(key: string) => Promise<string | null>>(async () => null),
    mockSetItem: vi.fn(async (_key: string, _value: string) => {}),
    mockRemoveItem: vi.fn(async (_key: string) => {}),
    mockGetCalendarsAsync: vi.fn(async () => [] as Array<{
        id: string;
        title?: string;
        name?: string;
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
    mockCreateCalendarAsync: vi.fn(async (_details?: { color?: string }) => 'cal-1'),
    mockUpdateCalendarAsync: vi.fn(async () => 'cal-1'),
    mockDeleteCalendarAsync: vi.fn(async (_id: string) => {}),
    mockCreateEventAsync: vi.fn(async () => 'evt-1'),
    mockUpdateEventAsync: vi.fn(async () => 'evt-1'),
    mockDeleteEventAsync: vi.fn(async () => {}),
    mockGetCalendarSyncEntry: vi.fn<(taskId: string, platform: string) => Promise<MockCalendarSyncEntry | null>>(async () => null),
    mockUpsertCalendarSyncEntry: vi.fn(async () => {}),
    mockDeleteCalendarSyncEntry: vi.fn<(taskId: string, platform: string) => Promise<void>>(async () => {}),
    mockGetAllCalendarSyncEntries: vi.fn<(platform: string) => Promise<MockCalendarSyncEntry[]>>(async () => []),
    mockEnsureCalendarSyncStorageReady: vi.fn(async () => {}),
    mockGetState: vi.fn<() => MockCalendarStoreState>(() => ({
        tasks: [],
        projects: [],
        sections: [],
        _allTasks: [],
        _tasksById: new Map(),
    })),
    mockSubscribe: vi.fn((
        _selectorOrListener: ((state: MockCalendarStoreState) => unknown) | ((state: MockCalendarStoreState) => void),
        _listener?: (selected: unknown) => void
    ) => () => {}),
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
    updateCalendarAsync: mockUpdateCalendarAsync,
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

vi.mock('@mindwtr/core', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@mindwtr/core')>()),
    useTaskStore: {
        getState: mockGetState,
        subscribe: mockSubscribe,
    },
}));

vi.mock('@/lib/storage-adapter', () => ({
    ensureCalendarSyncStorageReady: mockEnsureCalendarSyncStorageReady,
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
    deleteMindwtrCalendar,
    ensureMindwtrCalendar,
    getCalendarPushColor,
    getCalendarPushTargetCalendars,
    runFullCalendarSync,
    startCalendarPushSync,
    stopCalendarPushSync,
    updateMindwtrCalendarColor,
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
    recurrence: unknown;
    showFutureRecurrence: boolean;
    isProjectedRecurringTask: boolean;
    sourceTaskId: string;
    timeEstimate: string;
    deletedAt: string | null;
    updatedAt: string;
    description: string;
    location: string | null;
    projectId: string;
    sectionId: string;
    attachments: { id: string; kind: string; uri: string; deletedAt?: string | null }[];
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

function setStoreTasks(
    tasks: unknown[],
    allTasks: unknown[] = tasks,
    { projects = [], sections = [], settings }: Partial<Pick<MockCalendarStoreState, 'projects' | 'sections' | 'settings'>> = {},
) {
    mockGetState.mockReturnValue({
        tasks,
        projects,
        sections,
        settings,
        _allTasks: allTasks,
        _tasksById: new Map(allTasks.map((task) => [(task as { id: string }).id, task])),
    });
}

type MockAndroidCalendar = {
    id: string;
    title?: string;
    name?: string;
    color?: string;
    ownerAccount?: string;
    accessLevel?: string;
    allowsModifications?: boolean;
    source?: { name: string; type?: string; isLocalAccount?: boolean };
};

/**
 * Wires AsyncStorage and the device calendar list as stateful mocks so the
 * Android delete-then-recreate color flow behaves like a real device: the
 * managed calendar starts as `cal-old`, deleting it removes it from the list,
 * and creating a new one yields `cal-new` carrying the requested color.
 */
function setupStatefulAndroidCalendar() {
    const storage = new Map<string, string>([
        ['mindwtr:calendar-push-sync:enabled', '1'],
        ['mindwtr:calendar-push-sync:calendar-id', 'cal-old'],
        ['mindwtr:calendar-push-sync:color', '#3B82F6'],
    ]);
    mockGetItem.mockImplementation(async (key: string) => storage.get(key) ?? null);
    mockSetItem.mockImplementation(async (key: string, value: string) => { storage.set(key, value); });
    mockRemoveItem.mockImplementation(async (key: string) => { storage.delete(key); });

    const ownedAccount = {
        ownerAccount: 'me@gmail.com',
        accessLevel: 'owner',
        allowsModifications: true,
        source: { name: 'me@gmail.com', type: 'com.google' },
    };
    let calendars: MockAndroidCalendar[] = [
        { id: 'cal-old', title: 'Mindwtr', name: 'mindwtr', color: '#3B82F6', ...ownedAccount },
        { id: 'google-primary', title: 'Personal', ...ownedAccount },
    ];
    mockGetCalendarsAsync.mockImplementation(async () => calendars);
    mockDeleteCalendarAsync.mockImplementation(async (id: string) => {
        calendars = calendars.filter((c) => c.id !== id);
    });
    mockCreateCalendarAsync.mockImplementation(async (details?: { color?: string }) => {
        calendars = [...calendars, { id: 'cal-new', title: 'Mindwtr', name: 'mindwtr', color: details?.color, ...ownedAccount }];
        return 'cal-new';
    });

    return { storage, calendars: () => calendars };
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
    mockEnsureCalendarSyncStorageReady.mockResolvedValue(undefined);
});

afterEach(() => {
    stopCalendarPushSync();
    vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('calendar sync storage readiness', () => {
    it('skips the full calendar run before touching events when SQLite is unavailable', async () => {
        mockGetItem.mockResolvedValueOnce('1');
        setStoreTasks([makeTask()]);
        mockEnsureCalendarSyncStorageReady.mockRejectedValue(
            new Error('Native SQLite module unavailable; rebuild or reinstall the app so op-sqlite is included'),
        );

        await expect(runFullCalendarSync()).resolves.toBeUndefined();

        expect(mockGetCalendarsAsync).not.toHaveBeenCalled();
        expect(mockGetCalendarSyncEntry).not.toHaveBeenCalled();
        expect(mockCreateEventAsync).not.toHaveBeenCalled();
        expect(mockLogWarn).toHaveBeenCalledWith(
            'Calendar sync skipped because SQLite storage is unavailable',
            expect.objectContaining({
                scope: 'calendar-push',
                extra: expect.objectContaining({
                    error: 'Native SQLite module unavailable; rebuild or reinstall the app so op-sqlite is included',
                }),
            }),
        );
    });
});

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

    it('uses the saved Mindwtr calendar color when creating the calendar', async () => {
        mockGetItem.mockImplementation(async (key: string) => {
            if (key === 'mindwtr:calendar-push-sync:calendar-id') return null;
            if (key === 'mindwtr:calendar-push-sync:color') return '#DB2777';
            return null;
        });
        mockGetCalendarsAsync.mockResolvedValue([]);
        mockCreateCalendarAsync.mockResolvedValue('cal-pink');

        const id = await ensureMindwtrCalendar();

        expect(id).toBe('cal-pink');
        expect(mockCreateCalendarAsync).toHaveBeenCalledWith(expect.objectContaining({
            color: '#DB2777',
        }));
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

describe('calendar push color', () => {
    it('normalizes saved colors and updates the managed Mindwtr calendar when supported', async () => {
        mockGetItem.mockImplementation(async (key: string) => {
            if (key === 'mindwtr:calendar-push-sync:calendar-id') return 'cal-1';
            if (key === 'mindwtr:calendar-push-sync:color') return '#db2777';
            return null;
        });
        mockGetCalendarsAsync.mockResolvedValue([{ id: 'cal-1', title: 'Mindwtr', allowsModifications: true }]);

        await expect(getCalendarPushColor()).resolves.toBe('#DB2777');
        const updated = await updateMindwtrCalendarColor('#059669');

        expect(updated).toBe(true);
        expect(mockSetItem).toHaveBeenCalledWith('mindwtr:calendar-push-sync:color', '#059669');
        expect(mockUpdateCalendarAsync).toHaveBeenCalledWith('cal-1', { color: '#059669' });
        // iOS updates the calendar in place — it must not recreate it.
        expect(mockDeleteCalendarAsync).not.toHaveBeenCalled();
        expect(mockCreateCalendarAsync).not.toHaveBeenCalled();
    });

    it('recreates the managed calendar with the new color on Android so external apps update (#726)', async () => {
        mockPlatform.OS = 'android';
        const { calendars } = setupStatefulAndroidCalendar();
        setStoreTasks([]);

        const updated = await updateMindwtrCalendarColor('#059669');

        expect(updated).toBe(true);
        expect(mockSetItem).toHaveBeenCalledWith('mindwtr:calendar-push-sync:color', '#059669');
        // expo-calendar cannot change a calendar's color in place on Android, so
        // the managed calendar is deleted and recreated with the new color.
        expect(mockUpdateCalendarAsync).not.toHaveBeenCalled();
        expect(mockDeleteCalendarAsync).toHaveBeenCalledWith('cal-old');
        expect(mockCreateCalendarAsync).toHaveBeenCalledTimes(1);
        expect(mockCreateCalendarAsync).toHaveBeenCalledWith(expect.objectContaining({ color: '#059669' }));
        expect(calendars().some((c) => c.id === 'cal-new' && c.color === '#059669')).toBe(true);
        expect(mockSetItem).toHaveBeenCalledWith('mindwtr:calendar-push-sync:calendar-id', 'cal-new');
    });

    it('re-pushes events to the recreated Android calendar so they inherit the new color (#726)', async () => {
        mockPlatform.OS = 'android';
        setupStatefulAndroidCalendar();
        setStoreTasks([makeTask({ id: 'task-1', dueDate: '2026-04-20' })]);

        await updateMindwtrCalendarColor('#059669');

        expect(mockCreateEventAsync).toHaveBeenCalledWith('cal-new', expect.objectContaining({
            calendarId: 'cal-new',
        }));
    });

    it('stores the color but does not recreate when no managed Android calendar exists yet (#726)', async () => {
        mockPlatform.OS = 'android';
        mockGetItem.mockImplementation(async (key: string) => (
            key === 'mindwtr:calendar-push-sync:color' ? '#3B82F6' : null
        ));
        mockGetCalendarsAsync.mockResolvedValue([
            { id: 'google-primary', title: 'Personal', accessLevel: 'owner', allowsModifications: true },
        ]);

        const updated = await updateMindwtrCalendarColor('#059669');

        expect(updated).toBe(false);
        expect(mockSetItem).toHaveBeenCalledWith('mindwtr:calendar-push-sync:color', '#059669');
        expect(mockDeleteCalendarAsync).not.toHaveBeenCalled();
        expect(mockCreateCalendarAsync).not.toHaveBeenCalled();
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

describe('deleteMindwtrCalendar', () => {
    it('removes app-created Mindwtr calendars even when the stored calendar id was lost', async () => {
        mockGetItem
            .mockResolvedValueOnce(null) // stored calendar id after reinstall
            .mockResolvedValueOnce(null); // selected target id
        mockGetCalendarsAsync.mockResolvedValue([
            {
                id: 'old-app-calendar',
                title: 'Mindwtr',
                name: 'mindwtr',
                accessLevel: 'owner',
                allowsModifications: true,
            },
            {
                id: 'user-calendar',
                title: 'Mindwtr',
                accessLevel: 'owner',
                allowsModifications: true,
            },
            {
                id: 'other',
                title: 'Personal',
                accessLevel: 'owner',
                allowsModifications: true,
            },
        ]);

        await deleteMindwtrCalendar();

        expect(mockDeleteCalendarAsync).toHaveBeenCalledWith('old-app-calendar');
        expect(mockDeleteCalendarAsync).not.toHaveBeenCalledWith('user-calendar');
        expect(mockDeleteCalendarAsync).not.toHaveBeenCalledWith('other');
        expect(mockRemoveItem).toHaveBeenCalledWith('mindwtr:calendar-push-sync:calendar-id');
    });

    it('clears the selected target and sync rows for deleted Mindwtr calendars', async () => {
        mockGetItem
            .mockResolvedValueOnce('stored-calendar')
            .mockResolvedValueOnce('stored-calendar');
        mockGetCalendarsAsync.mockResolvedValue([
            {
                id: 'stored-calendar',
                title: 'Mindwtr',
                name: 'mindwtr',
                accessLevel: 'owner',
                allowsModifications: true,
            },
        ]);
        mockGetAllCalendarSyncEntries.mockResolvedValue([
            { taskId: 'task-1', calendarEventId: 'evt-1', calendarId: 'stored-calendar', platform: 'ios', lastSyncedAt: '' },
            { taskId: 'task-2', calendarEventId: 'evt-2', calendarId: 'other', platform: 'ios', lastSyncedAt: '' },
        ]);

        await deleteMindwtrCalendar();

        expect(mockDeleteCalendarAsync).toHaveBeenCalledWith('stored-calendar');
        expect(mockRemoveItem).toHaveBeenCalledWith('mindwtr:calendar-push-sync:target-calendar-id');
        expect(mockDeleteCalendarSyncEntry).toHaveBeenCalledWith('task-1', 'ios');
        expect(mockDeleteCalendarSyncEntry).not.toHaveBeenCalledWith('task-2', 'ios');
    });
});

describe('buildEventDetails — date-only calendar events stay on the intended day', () => {
    it('exports a YYYY-MM-DD due date as an all-day event ending inside the same day on iOS', async () => {
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

        // EventKit counts every day the range touches: a next-midnight end made
        // the event span two days in Calendar and in Google accounts synced
        // through iOS (#1065). The end must stay inside the same local day.
        expect(eventData.endDate.getFullYear()).toBe(2026);
        expect(eventData.endDate.getMonth()).toBe(3);
        expect(eventData.endDate.getDate()).toBe(20);
        expect(eventData.endDate.getHours()).toBe(23);
    });

    it('uses UTC midnight boundaries for Android date-only scheduled starts', async () => {
        mockPlatform.OS = 'android';
        setupEnabled();
        const task = makeTask({
            dueDate: null,
            startTime: '2026-04-20',
        });
        setStoreTasks([task]);
        mockGetCalendarSyncEntry.mockResolvedValue(null);
        mockGetAllCalendarSyncEntries.mockResolvedValue([]);

        await runFullCalendarSync();

        expect(mockCreateEventAsync).toHaveBeenCalledOnce();
        const call = mockCreateEventAsync.mock.calls[0] as unknown as [string, {
            startDate: Date;
            endDate: Date;
            allDay: boolean;
            timeZone?: string;
            endTimeZone?: string;
        }];
        const [, eventData] = call;

        expect(eventData.allDay).toBe(true);
        expect(eventData.startDate.toISOString()).toBe('2026-04-20T00:00:00.000Z');
        expect(eventData.endDate.toISOString()).toBe('2026-04-21T00:00:00.000Z');
        expect(eventData.timeZone).toBe('UTC');
        expect(eventData.endTimeZone).toBe('UTC');
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

    it('sizes the pushed event by the estimate only while Time estimates is on', async () => {
        setupEnabled();
        // Feature off: the stored estimate stays on the task but stops
        // stretching the pushed event (the 30-minute default takes over).
        const task = makeTask({
            dueDate: null,
            startTime: '2026-04-20T10:45:00.000Z',
            timeEstimate: '2hr',
        });
        setStoreTasks([task], [task], { settings: { features: { timeEstimates: false } } });
        mockGetCalendarSyncEntry.mockResolvedValue(null);
        mockGetAllCalendarSyncEntries.mockResolvedValue([]);

        await runFullCalendarSync();

        const call = mockCreateEventAsync.mock.calls[0] as unknown as [string, { startDate: Date; endDate: Date }];
        expect(call[1].endDate.toISOString()).toBe('2026-04-20T11:15:00.000Z');
    });

    it('passes task location into pushed calendar event details', async () => {
        setupEnabled();
        const task = makeTask({
            description: 'Bring notes',
            location: 'Office 2A',
        });
        setStoreTasks([task]);

        await runFullCalendarSync();

        expect(mockCreateEventAsync).toHaveBeenCalledWith('cal-1', expect.objectContaining({
            notes: 'Status: Next\n\nBring notes',
            location: 'Office 2A',
        }));
    });

    it('pushes project, section, status, effort, and links into the event notes', async () => {
        setupEnabled();
        const task = makeTask({
            status: 'waiting',
            timeEstimate: 'custom:90',
            projectId: 'proj-1',
            sectionId: 'sec-1',
            description: 'Bring notes',
            attachments: [
                { id: 'att-1', kind: 'link', uri: 'https://example.com/agenda' },
                { id: 'att-2', kind: 'link', uri: 'mindwtr://task/other' },
            ],
        });
        setStoreTasks([task], [task], {
            projects: [{ id: 'proj-1', title: 'Launch' }],
            sections: [{ id: 'sec-1', title: 'Prep' }],
        });

        await runFullCalendarSync();

        expect(mockCreateEventAsync).toHaveBeenCalledWith('cal-1', expect.objectContaining({
            notes: [
                'Project: Launch › Prep',
                'Status: Waiting',
                'Effort: 1.5 h',
                '',
                'Bring notes',
                '',
                'Link: https://example.com/agenda',
            ].join('\n'),
            url: 'https://example.com/agenda',
        }));
    });

    it('creates a calendar event for an opted-in projected recurring task', async () => {
        vi.setSystemTime(new Date('2026-04-20T12:00:00.000Z'));
        setupEnabled();
        const task = makeTask({
            id: 'task-recurring',
            title: 'Monthly bill',
            dueDate: '2026-04-01',
            recurrence: { rule: 'monthly', strategy: 'strict' },
            showFutureRecurrence: true,
        });
        const projectedTask = {
            ...task,
            id: 'task-recurring:projected-recurrence',
            sourceTaskId: 'task-recurring',
            isProjectedRecurringTask: true,
            dueDate: '2026-05-01',
            updatedAt: '2026-04-20T00:00:00.000Z',
        };
        setStoreTasks([task]);

        await runFullCalendarSync();

        expect(mockCreateEventAsync).toHaveBeenCalledTimes(2);
        expect(mockCreateEventAsync).toHaveBeenCalledWith('cal-1', expect.objectContaining({
            title: 'Monthly bill (May 1, 2026)',
            notes: expect.stringContaining('Projected recurring occurrence for May 1, 2026'),
        }));
        expect(mockUpsertCalendarSyncEntry).toHaveBeenCalledWith(expect.objectContaining({
            taskId: projectedTask.id,
        }));
    });

    it('removes stale projected recurring events when projection is no longer enabled', async () => {
        setupEnabled();
        const task = makeTask({ id: 'task-recurring', dueDate: '2026-04-01' });
        const projectedEntry = {
            taskId: 'task-recurring:projected-recurrence',
            calendarEventId: 'evt-projected',
            calendarId: 'cal-1',
            platform: 'ios',
            lastSyncedAt: '',
        };
        setStoreTasks([task]);
        mockGetAllCalendarSyncEntries.mockResolvedValue([projectedEntry]);
        mockGetCalendarSyncEntry.mockImplementation(async (taskId: string) => (
            taskId === projectedEntry.taskId ? projectedEntry : null
        ));

        await runFullCalendarSync();

        expect(mockDeleteEventAsync).toHaveBeenCalledWith('evt-projected');
        expect(mockDeleteCalendarSyncEntry).toHaveBeenCalledWith(projectedEntry.taskId, 'ios');
    });
});

describe('runFullCalendarSync — selected target calendar', () => {
    it('writes unprefixed events to a selected account calendar instead of creating the managed calendar', async () => {
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
            title: task.title,
        }));
    });

    it('exports existing due-date tasks from the full store when a target calendar is selected', async () => {
        setupEnabled('cal-managed', 'davx5-calendar');
        mockGetCalendarsAsync.mockResolvedValue([
            {
                id: 'davx5-calendar',
                title: 'DAVx5',
                accessLevel: 'owner',
                allowsModifications: true,
            },
        ]);
        const visibleTask = makeTask({ id: 'visible-task', title: 'Visible task', dueDate: '2026-04-20' });
        const existingTask = makeTask({ id: 'existing-task', title: 'Existing task', dueDate: '2026-04-21' });
        setStoreTasks([visibleTask], [visibleTask, existingTask]);

        await runFullCalendarSync();

        expect(mockCreateCalendarAsync).not.toHaveBeenCalled();
        expect(mockCreateEventAsync).toHaveBeenCalledWith('davx5-calendar', expect.objectContaining({
            calendarId: 'davx5-calendar',
            title: visibleTask.title,
        }));
        expect(mockCreateEventAsync).toHaveBeenCalledWith('davx5-calendar', expect.objectContaining({
            calendarId: 'davx5-calendar',
            title: existingTask.title,
        }));
        expect(mockUpsertCalendarSyncEntry).toHaveBeenCalledWith(expect.objectContaining({
            taskId: existingTask.id,
            calendarId: 'davx5-calendar',
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

    it('preserves task titles that already start with the Mindwtr prefix', async () => {
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

    it('keeps the old mapping and avoids duplicates when deleting from the old calendar fails', async () => {
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
        mockDeleteEventAsync.mockRejectedValueOnce(new Error('Calendar temporarily unavailable'));

        await runFullCalendarSync();

        expect(mockDeleteEventAsync).toHaveBeenCalledWith('evt-old');
        expect(mockCreateEventAsync).not.toHaveBeenCalled();
        expect(mockDeleteCalendarSyncEntry).not.toHaveBeenCalled();
        expect(mockUpsertCalendarSyncEntry).not.toHaveBeenCalled();
    });
});

describe('runFullCalendarSync — existing event updates', () => {
    it('does not create a duplicate when updating an existing event fails', async () => {
        setupEnabled();
        const task = makeTask({ dueDate: '2026-04-20' });
        const entry = {
            taskId: task.id,
            calendarEventId: 'evt-existing',
            calendarId: 'cal-1',
            platform: 'ios',
            lastSyncedAt: '',
        };
        setStoreTasks([task]);
        mockGetCalendarSyncEntry.mockResolvedValue(entry);
        mockUpdateEventAsync.mockRejectedValueOnce(new Error('Calendar temporarily unavailable'));

        await runFullCalendarSync();

        expect(mockUpdateEventAsync).toHaveBeenCalledWith('evt-existing', expect.objectContaining({
            title: task.title,
        }));
        expect(mockCreateEventAsync).not.toHaveBeenCalled();
        expect(mockUpsertCalendarSyncEntry).not.toHaveBeenCalled();
        expect(mockDeleteCalendarSyncEntry).not.toHaveBeenCalled();
    });

    it('recreates an event when the old event was deleted externally', async () => {
        setupEnabled();
        const task = makeTask({ dueDate: '2026-04-20' });
        const entry = {
            taskId: task.id,
            calendarEventId: 'evt-existing',
            calendarId: 'cal-1',
            platform: 'ios',
            lastSyncedAt: '',
        };
        setStoreTasks([task]);
        mockGetCalendarSyncEntry.mockResolvedValue(entry);
        mockUpdateEventAsync.mockRejectedValueOnce(new Error('Calendar event not found'));

        await runFullCalendarSync();

        expect(mockDeleteCalendarSyncEntry).toHaveBeenCalledWith(task.id, 'ios');
        expect(mockCreateEventAsync).toHaveBeenCalledWith('cal-1', expect.objectContaining({
            title: task.title,
        }));
        expect(mockUpsertCalendarSyncEntry).toHaveBeenCalledWith(expect.objectContaining({
            taskId: task.id,
            calendarEventId: 'evt-1',
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

    it('keeps the sync mapping when deleting a completed task event fails', async () => {
        setupEnabled();
        const task = makeTask({ status: 'done' });
        setStoreTasks([task]);
        const entry = { taskId: task.id, calendarEventId: 'evt-done', calendarId: 'cal-1', platform: 'ios', lastSyncedAt: '' };
        mockGetCalendarSyncEntry.mockResolvedValue(entry);
        mockDeleteEventAsync.mockRejectedValueOnce(new Error('Calendar temporarily unavailable'));

        await runFullCalendarSync();

        expect(mockDeleteEventAsync).toHaveBeenCalledWith('evt-done');
        expect(mockDeleteCalendarSyncEntry).not.toHaveBeenCalled();
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

    it('removes a calendar event when the task becomes reference material', async () => {
        setupEnabled();
        const task = makeTask({ status: 'reference' });
        setStoreTasks([task]);
        mockGetCalendarSyncEntry.mockResolvedValue(
            { taskId: task.id, calendarEventId: 'evt-ref', calendarId: 'cal-1', platform: 'ios', lastSyncedAt: '' }
        );
        mockGetAllCalendarSyncEntries.mockResolvedValue([]);

        await runFullCalendarSync();

        expect(mockDeleteEventAsync).toHaveBeenCalledWith('evt-ref');
        expect(mockDeleteCalendarSyncEntry).toHaveBeenCalledWith(task.id, 'ios');
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
    it('syncs the projected recurring event when the projection setting changes', async () => {
        vi.setSystemTime(new Date('2026-04-20T12:00:00.000Z'));
        setupEnabled();

        const task = makeTask({
            id: 'task-recurring',
            recurrence: { rule: 'monthly', strategy: 'strict' },
            showFutureRecurrence: false,
            updatedAt: '2026-04-20T00:00:00.000Z',
        });
        const updatedTask = {
            ...task,
            showFutureRecurrence: true,
            updatedAt: '2026-04-20T01:00:00.000Z',
        };
        const projectedTask = {
            ...updatedTask,
            id: 'task-recurring:projected-recurrence',
            sourceTaskId: 'task-recurring',
            isProjectedRecurringTask: true,
            dueDate: '2026-05-20',
        };
        const makeTaskMap = (items: ReturnType<typeof makeTask>[]) => new Map(items.map((item) => [item.id, item]));
        let storeState = {
            tasks: [task],
            projects: [],
            sections: [],
            _allTasks: [task],
            _tasksById: makeTaskMap([task]),
        };

        mockGetState.mockImplementation(() => storeState);

        startCalendarPushSync();
        const selector = mockSubscribe.mock.calls[0]?.[0] as ((state: typeof storeState) => unknown) | undefined;
        const listener = mockSubscribe.mock.calls[0]?.[1] as ((tasks: typeof storeState._allTasks) => void) | undefined;
        expect(selector).toBeTypeOf('function');
        expect(listener).toBeTypeOf('function');
        if (!selector || !listener) return;

        storeState = {
            tasks: [updatedTask],
            projects: [],
            sections: [],
            _allTasks: [updatedTask],
            _tasksById: makeTaskMap([updatedTask]),
        };
        listener(selector(storeState) as typeof storeState._allTasks);

        await vi.advanceTimersByTimeAsync(2500);
        await Promise.resolve();

        expect(mockCreateEventAsync).toHaveBeenCalledWith('cal-1', expect.objectContaining({
            calendarId: 'cal-1',
            title: 'My Task (May 20, 2026)',
            notes: expect.stringContaining('Projected recurring occurrence for May 20, 2026'),
        }));
        expect(mockUpsertCalendarSyncEntry).toHaveBeenCalledWith(expect.objectContaining({
            taskId: projectedTask.id,
        }));
    });

    it('syncs an existing calendar event when only the task location changes', async () => {
        setupEnabled();

        const task = makeTask({
            id: 'task-location',
            location: 'Room A',
            updatedAt: '2026-04-20T00:00:00.000Z',
        });
        const updatedTask = {
            ...task,
            location: 'Room B',
        };
        const makeTaskMap = (items: ReturnType<typeof makeTask>[]) => new Map(items.map((item) => [item.id, item]));
        let storeState = {
            tasks: [task],
            projects: [],
            sections: [],
            _allTasks: [task],
            _tasksById: makeTaskMap([task]),
        };

        mockGetState.mockImplementation(() => storeState);
        mockGetCalendarSyncEntry.mockResolvedValue({
            taskId: task.id,
            calendarEventId: 'evt-location',
            calendarId: 'cal-1',
            platform: 'ios',
            lastSyncedAt: '',
        });

        startCalendarPushSync();
        const selector = mockSubscribe.mock.calls[0]?.[0] as ((state: typeof storeState) => unknown) | undefined;
        const listener = mockSubscribe.mock.calls[0]?.[1] as ((tasks: typeof storeState._allTasks) => void) | undefined;
        expect(selector).toBeTypeOf('function');
        expect(listener).toBeTypeOf('function');
        if (!selector || !listener) return;

        storeState = {
            tasks: [updatedTask],
            projects: [],
            sections: [],
            _allTasks: [updatedTask],
            _tasksById: makeTaskMap([updatedTask]),
        };
        listener(selector(storeState) as typeof storeState._allTasks);

        await vi.advanceTimersByTimeAsync(2500);
        await Promise.resolve();

        expect(mockUpdateEventAsync).toHaveBeenCalledWith('evt-location', expect.objectContaining({
            location: 'Room B',
        }));
    });

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
        const makeTaskMap = (items: ReturnType<typeof makeTask>[]) => new Map(items.map((task) => [task.id, task]));
        let storeState = {
            tasks: [taskOne, taskTwo],
            projects: [],
            sections: [],
            _allTasks: [taskOne, taskTwo],
            _tasksById: makeTaskMap([taskOne, taskTwo]),
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
        const selector = mockSubscribe.mock.calls[0]?.[0] as ((state: typeof storeState) => unknown) | undefined;
        const listener = mockSubscribe.mock.calls[0]?.[1] as ((tasks: typeof storeState._allTasks) => void) | undefined;
        expect(selector).toBeTypeOf('function');
        expect(listener).toBeTypeOf('function');
        if (!selector || !listener) return;

        storeState = {
            tasks: [taskTwo],
            projects: [],
            sections: [],
            _allTasks: [taskOneDeleted, taskTwo],
            _tasksById: makeTaskMap([taskOneDeleted, taskTwo]),
        };
        listener(selector(storeState) as typeof storeState._allTasks);

        storeState = {
            tasks: [taskTwoUpdated],
            projects: [],
            sections: [],
            _allTasks: [taskOneDeleted, taskTwoUpdated],
            _tasksById: makeTaskMap([taskOneDeleted, taskTwoUpdated]),
        };
        listener(selector(storeState) as typeof storeState._allTasks);

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
