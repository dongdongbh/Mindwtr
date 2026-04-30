/**
 * Calendar push sync service.
 *
 * One-way push of scheduled tasks and tasks with due dates into a device
 * calendar (iOS EventKit via expo-calendar). Creates, updates, or removes
 * calendar events as task dates change. Mapping between task IDs and
 * calendar event IDs is persisted in the SQLite calendar_sync table.
 */
import * as Calendar from 'expo-calendar';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { hasTimeComponent, safeParseDate, useTaskStore, type Task } from '@mindwtr/core';

import { logInfo, logWarn, logError } from './app-log';
import {
    getCalendarSyncEntry,
    upsertCalendarSyncEntry,
    deleteCalendarSyncEntry,
    getAllCalendarSyncEntries,
} from './storage-adapter';

// MARK: - Constants

const CALENDAR_PUSH_ENABLED_KEY = 'mindwtr:calendar-push-sync:enabled';
const CALENDAR_ID_KEY = 'mindwtr:calendar-push-sync:calendar-id';
const CALENDAR_TARGET_ID_KEY = 'mindwtr:calendar-push-sync:target-calendar-id';
const PLATFORM = Platform.OS;
const SYNC_DEBOUNCE_MS = 2500;
const MANAGED_CALENDAR_TITLE = 'Mindwtr';
const MANAGED_CALENDAR_NAME = 'mindwtr';
const ACCOUNT_TARGET_TITLE_PREFIX = 'Mindwtr: ';

export type CalendarPushTargetCalendar = {
    id: string;
    name: string;
    sourceName?: string;
    color?: string;
    isMindwtrDedicated: boolean;
    isMindwtrManaged: boolean;
    isLocalOnly: boolean;
};

type CalendarPushTarget = {
    id: string;
    shouldPrefixTitles: boolean;
};

function isReadableAccountName(value: string): boolean {
    const normalized = value.trim().toLowerCase();
    return normalized.length > 0
        && normalized !== MANAGED_CALENDAR_NAME
        && normalized !== 'local account'
        && !normalized.endsWith('@group.calendar.google.com');
}

function getCalendarSourceName(calendar: Calendar.Calendar): string | undefined {
    const ownerAccount = typeof calendar.ownerAccount === 'string' && calendar.ownerAccount.trim().length > 0
        ? calendar.ownerAccount.trim()
        : undefined;
    const sourceName = typeof calendar.source?.name === 'string' && calendar.source.name.trim().length > 0
        ? calendar.source.name.trim()
        : undefined;

    if (sourceName && isReadableAccountName(sourceName)) {
        return sourceName;
    }

    if (ownerAccount && isReadableAccountName(ownerAccount)) {
        return ownerAccount;
    }

    return sourceName ?? ownerAccount;
}

function getCalendarSourceType(calendar: Calendar.Calendar): string | undefined {
    const sourceType = typeof calendar.source?.type === 'string' ? calendar.source.type.trim() : '';
    if (sourceType.length > 0) return sourceType;

    const platformCalendar = calendar as Calendar.Calendar & { type?: unknown };
    const calendarType = typeof platformCalendar.type === 'string' ? platformCalendar.type.trim() : '';
    return calendarType.length > 0 ? calendarType : undefined;
}

function isLocalOnlyCalendar(calendar: Calendar.Calendar): boolean {
    if (calendar.source?.isLocalAccount === true) return true;

    const sourceType = getCalendarSourceType(calendar)?.toLowerCase();
    if (sourceType === 'local') return true;

    const ownerAccount = typeof calendar.ownerAccount === 'string' ? calendar.ownerAccount.trim().toLowerCase() : '';
    const sourceName = typeof calendar.source?.name === 'string' ? calendar.source.name.trim().toLowerCase() : '';
    return ownerAccount === 'local account' && sourceName === 'local account';
}

// MARK: - Settings

export const getCalendarPushEnabled = async (): Promise<boolean> => {
    const val = await AsyncStorage.getItem(CALENDAR_PUSH_ENABLED_KEY);
    return val === '1';
};

export const setCalendarPushEnabled = async (enabled: boolean): Promise<void> => {
    await AsyncStorage.setItem(CALENDAR_PUSH_ENABLED_KEY, enabled ? '1' : '0');
};

export const getCalendarPushTargetCalendarId = async (): Promise<string | null> => {
    const value = await AsyncStorage.getItem(CALENDAR_TARGET_ID_KEY);
    const trimmed = value?.trim() ?? '';
    return trimmed.length > 0 ? trimmed : null;
};

export const setCalendarPushTargetCalendarId = async (calendarId: string | null): Promise<void> => {
    const trimmed = calendarId?.trim() ?? '';
    if (trimmed.length === 0) {
        await AsyncStorage.removeItem(CALENDAR_TARGET_ID_KEY);
        return;
    }
    await AsyncStorage.setItem(CALENDAR_TARGET_ID_KEY, trimmed);
};

// MARK: - Permission

export const requestCalendarWritePermission = async (): Promise<boolean> => {
    try {
        const { status } = await Calendar.requestCalendarPermissionsAsync();
        return status === 'granted';
    } catch {
        return false;
    }
};

export const getCalendarWritePermissionStatus = async (): Promise<'granted' | 'denied' | 'undetermined'> => {
    try {
        const { status } = await Calendar.getCalendarPermissionsAsync();
        if (status === 'granted') return 'granted';
        if (status === 'denied') return 'denied';
        return 'undetermined';
    } catch {
        return 'undetermined';
    }
};

// MARK: - Managed Calendar

const getStoredCalendarId = (): Promise<string | null> =>
    AsyncStorage.getItem(CALENDAR_ID_KEY);

const setStoredCalendarId = (id: string): Promise<void> =>
    AsyncStorage.setItem(CALENDAR_ID_KEY, id);

const READ_ONLY_ACCESS_LEVELS = new Set([
    Calendar.CalendarAccessLevel.FREEBUSY,
    Calendar.CalendarAccessLevel.NONE,
    Calendar.CalendarAccessLevel.READ,
    Calendar.CalendarAccessLevel.RESPOND,
    Calendar.CalendarAccessLevel.UNKNOWN,
]);

function getCalendarDisplayName(calendar: Calendar.Calendar): string {
    const legacyName = (calendar as Calendar.Calendar & { name?: string }).name;
    const preferred = typeof calendar.title === 'string' && calendar.title.trim().length > 0
        ? calendar.title
        : typeof legacyName === 'string' && legacyName.trim().length > 0
            ? legacyName
            : 'Calendar';
    return preferred.trim() || 'Calendar';
}

function isWritableCalendar(calendar: Calendar.Calendar): boolean {
    if (calendar.allowsModifications === false) return false;
    if (calendar.accessLevel && READ_ONLY_ACCESS_LEVELS.has(calendar.accessLevel)) return false;
    return true;
}

function isMindwtrNamedCalendar(calendar: Calendar.Calendar): boolean {
    const title = getCalendarDisplayName(calendar).trim().toLowerCase();
    const name = typeof calendar.name === 'string' ? calendar.name.trim().toLowerCase() : '';
    return title === MANAGED_CALENDAR_TITLE.toLowerCase() || name === MANAGED_CALENDAR_NAME;
}

function isStoredMindwtrManagedCalendar(calendar: Calendar.Calendar, storedCalendarId: string | null): boolean {
    return Boolean(storedCalendarId && calendar.id === storedCalendarId);
}

export const getCalendarPushTargetCalendars = async (): Promise<CalendarPushTargetCalendar[]> => {
    try {
        const [storedCalendarId, calendars] = await Promise.all([
            getStoredCalendarId(),
            Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT),
        ]);
        return calendars
            .filter((calendar) =>
                typeof calendar.id === 'string'
                && calendar.id.trim().length > 0
                && isWritableCalendar(calendar)
            )
            .map((calendar) => {
                const isMindwtrDedicated = isMindwtrNamedCalendar(calendar);
                return {
                    id: calendar.id,
                    name: getCalendarDisplayName(calendar),
                    sourceName: getCalendarSourceName(calendar),
                    color: typeof calendar.color === 'string' && calendar.color.trim().length > 0 ? calendar.color : undefined,
                    isMindwtrDedicated,
                    isMindwtrManaged: isStoredMindwtrManagedCalendar(calendar, storedCalendarId),
                    isLocalOnly: isLocalOnlyCalendar(calendar),
                };
            })
            .sort((a, b) => {
                if (a.isMindwtrManaged !== b.isMindwtrManaged) return a.isMindwtrManaged ? -1 : 1;
                if (a.isMindwtrDedicated !== b.isMindwtrDedicated) return a.isMindwtrDedicated ? -1 : 1;
                return a.name.localeCompare(b.name);
            });
    } catch (error) {
        void logError(error, { scope: 'calendar-push', extra: { operation: 'getCalendarPushTargetCalendars' } });
        return [];
    }
};

function getAndroidManagedCalendarSeed(
    calendars: Awaited<ReturnType<typeof Calendar.getCalendarsAsync>>
): Parameters<typeof Calendar.createCalendarAsync>[0] | null {
    const ownedCalendar = calendars.find((calendar) =>
        calendar.accessLevel === Calendar.CalendarAccessLevel.OWNER
        && typeof calendar.ownerAccount === 'string'
        && calendar.ownerAccount.trim().length > 0
        && typeof calendar.source?.name === 'string'
        && calendar.source.name.trim().length > 0
    ) ?? calendars.find((calendar) =>
        calendar.allowsModifications
        && typeof calendar.ownerAccount === 'string'
        && calendar.ownerAccount.trim().length > 0
        && typeof calendar.source?.name === 'string'
        && calendar.source.name.trim().length > 0
    );

    if (!ownedCalendar || !ownedCalendar.source) {
        return null;
    }

    return {
        title: MANAGED_CALENDAR_TITLE,
        color: '#3B82F6',
        entityType: Calendar.EntityTypes.EVENT,
        name: MANAGED_CALENDAR_NAME,
        ownerAccount: ownedCalendar.ownerAccount,
        accessLevel: Calendar.CalendarAccessLevel.OWNER,
        source: {
            name: ownedCalendar.source.name,
            ...(ownedCalendar.source.type ? { type: ownedCalendar.source.type } : {}),
            ...(typeof ownedCalendar.source.isLocalAccount === 'boolean'
                ? { isLocalAccount: ownedCalendar.source.isLocalAccount }
                : {}),
        },
        isVisible: true,
        isSynced: true,
    };
}

/**
 * Returns the ID of the managed "Mindwtr" calendar, creating it if needed.
 * Returns null if the calendar cannot be created (e.g. no permission, no source).
 */
export const ensureMindwtrCalendar = async (): Promise<string | null> => {
    try {
        const storedId = await getStoredCalendarId();
        const allCalendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
        if (storedId) {
            if (allCalendars.some((c) => c.id === storedId)) return storedId;
            // Calendar was deleted externally — fall through to recreate
        }

        let calendarDetails: Parameters<typeof Calendar.createCalendarAsync>[0];

        if (Platform.OS === 'android') {
            // Android calendars need to be attached to a real device account/source
            // or some calendar providers will keep them hidden from the OS calendar app.
            const androidSeed = getAndroidManagedCalendarSeed(allCalendars);
            if (!androidSeed) {
                void logWarn('No owned Android calendar source available; cannot create Mindwtr calendar', {
                    scope: 'calendar-push',
                    extra: { calendarCount: String(allCalendars.length) },
                });
                return null;
            }
            calendarDetails = androidSeed;
        } else {
            // iOS requires a source
            const sources = await Calendar.getSourcesAsync();
            const source =
                sources.find((s) => s.type === Calendar.SourceType.LOCAL) ??
                sources.find((s) => s.type === Calendar.SourceType.CALDAV) ??
                sources[0];

            if (!source) {
                void logWarn('No calendar source available; cannot create Mindwtr calendar', {
                    scope: 'calendar-push',
                });
                return null;
            }

            calendarDetails = {
                title: MANAGED_CALENDAR_TITLE,
                color: '#3B82F6',
                entityType: Calendar.EntityTypes.EVENT,
                sourceId: source.id,
                source,
            };
        }

        const newId = await Calendar.createCalendarAsync(calendarDetails);

        await setStoredCalendarId(newId);
        void logInfo('Created Mindwtr calendar', {
            scope: 'calendar-push',
            extra: { calendarId: newId },
        });
        return newId;
    } catch (error) {
        void logError(error, { scope: 'calendar-push', extra: { operation: 'ensureMindwtrCalendar' } });
        return null;
    }
};

async function resolveCalendarPushTarget(): Promise<CalendarPushTarget | null> {
    const selectedId = await getCalendarPushTargetCalendarId();
    if (selectedId) {
        try {
            const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
            const selected = calendars.find((calendar) => calendar.id === selectedId);
            if (selected && isWritableCalendar(selected)) {
                return {
                    id: selectedId,
                    shouldPrefixTitles: !isMindwtrNamedCalendar(selected),
                };
            }
            await setCalendarPushTargetCalendarId(null);
            void logWarn('Selected calendar push target is unavailable; falling back to Mindwtr calendar', {
                scope: 'calendar-push',
                extra: { calendarId: selectedId },
            });
        } catch (error) {
            void logError(error, { scope: 'calendar-push', extra: { operation: 'resolveCalendarPushTargetId' } });
        }
    }

    const managedId = await ensureMindwtrCalendar();
    return managedId ? { id: managedId, shouldPrefixTitles: false } : null;
}

/**
 * Deletes the managed Mindwtr calendar and removes the stored ID.
 * Called when the user disables calendar push sync and chooses to clean up.
 */
export const deleteMindwtrCalendar = async (): Promise<void> => {
    const storedId = await getStoredCalendarId();
    if (!storedId) return;
    const selectedTargetId = await getCalendarPushTargetCalendarId();
    try {
        await Calendar.deleteCalendarAsync(storedId);
    } catch {
        // Already deleted or not found — ignore
    }
    await AsyncStorage.removeItem(CALENDAR_ID_KEY);
    if (selectedTargetId === storedId) {
        await setCalendarPushTargetCalendarId(null);
    }
    void logInfo('Deleted Mindwtr calendar', { scope: 'calendar-push' });
};

// MARK: - Per-task sync

function timeEstimateToMinutes(estimate: Task['timeEstimate']): number {
    switch (estimate) {
        case '5min': return 5;
        case '10min': return 10;
        case '15min': return 15;
        case '30min': return 30;
        case '1hr': return 60;
        case '2hr': return 120;
        case '3hr': return 180;
        case '4hr':
        case '4hr+': return 240;
        default: return 30;
    }
}

function formatCalendarEventTitle(title: string, shouldPrefixTitle: boolean): string {
    if (!shouldPrefixTitle) return title;
    const trimmed = title.trim();
    if (trimmed.toLowerCase().startsWith(ACCOUNT_TARGET_TITLE_PREFIX.toLowerCase())) {
        return title;
    }
    return `${ACCOUNT_TARGET_TITLE_PREFIX}${trimmed || title}`;
}

function buildEventDetails(task: Task, shouldPrefixTitle: boolean) {
    // safeParseDate parses YYYY-MM-DD as local midnight, avoiding the UTC
    // shift that `new Date(dateString)` produces for date-only strings.
    const dateValue = task.startTime ?? task.dueDate;
    const parsed = safeParseDate(dateValue);
    const startDate = parsed ?? new Date();
    const title = formatCalendarEventTitle(task.title, shouldPrefixTitle);
    if (hasTimeComponent(dateValue)) {
        const endDate = new Date(startDate.getTime() + timeEstimateToMinutes(task.timeEstimate) * 60 * 1000);
        return {
            title,
            startDate,
            endDate,
            allDay: false,
            notes: task.description ?? '',
        };
    }

    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(startDate);
    endDate.setHours(23, 59, 59, 999);
    return {
        title,
        startDate,
        endDate,
        allDay: true,
        notes: task.description ?? '',
    };
}

async function removeTaskFromCalendar(taskId: string): Promise<void> {
    const entry = await getCalendarSyncEntry(taskId, PLATFORM);
    if (!entry) return;
    try {
        await Calendar.deleteEventAsync(entry.calendarEventId);
    } catch {
        // Event may already be deleted
    }
    await deleteCalendarSyncEntry(taskId, PLATFORM);
}

/** Returns true for tasks that should not have a calendar event. */
function shouldRemoveFromCalendar(task: Task): boolean {
    return (!task.dueDate && !task.startTime) || !!task.deletedAt || task.status === 'done' || task.status === 'archived';
}

async function syncTaskToCalendar(task: Task, target: CalendarPushTarget): Promise<void> {
    if (shouldRemoveFromCalendar(task)) {
        await removeTaskFromCalendar(task.id);
        return;
    }

    const details = buildEventDetails(task, target.shouldPrefixTitles);
    const calendarId = target.id;
    const existing = await getCalendarSyncEntry(task.id, PLATFORM);

    if (existing && existing.calendarId === calendarId) {
        try {
            await Calendar.updateEventAsync(existing.calendarEventId, details);
            await upsertCalendarSyncEntry({
                taskId: task.id,
                calendarEventId: existing.calendarEventId,
                calendarId,
                platform: PLATFORM,
                lastSyncedAt: new Date().toISOString(),
            });
            return;
        } catch {
            // Event deleted externally — fall through to create
        }
    } else if (existing) {
        try {
            await Calendar.deleteEventAsync(existing.calendarEventId);
        } catch {
            // Event may already be deleted or belong to an unavailable calendar
        }
    }

    const eventId = await Calendar.createEventAsync(calendarId, { ...details, calendarId });
    await upsertCalendarSyncEntry({
        taskId: task.id,
        calendarEventId: eventId,
        calendarId,
        platform: PLATFORM,
        lastSyncedAt: new Date().toISOString(),
    });
}

// MARK: - Full sync

export const runFullCalendarSync = async (): Promise<void> => {
    const enabled = await getCalendarPushEnabled();
    if (!enabled) return;

    const target = await resolveCalendarPushTarget();
    if (!target) return;

    const { tasks } = useTaskStore.getState();

    // Sync all tasks currently in the store
    const results = await Promise.allSettled(
        tasks.map((task) => syncTaskToCalendar(task, target))
    );

    // Reconcile: remove stale calendar_sync entries for tasks that are no
    // longer in the store or that should not have an event (completed between
    // sessions, archived, etc.)
    const activeEventIds = new Set(
        tasks.filter((t) => !shouldRemoveFromCalendar(t)).map((t) => t.id)
    );
    const syncedEntries = await getAllCalendarSyncEntries(PLATFORM);
    const staleEntries = syncedEntries.filter((e) => !activeEventIds.has(e.taskId));
    await Promise.allSettled(staleEntries.map((e) => removeTaskFromCalendar(e.taskId)));

    const failed = results.filter((r) => r.status === 'rejected').length;
    void logInfo('Full calendar sync complete', {
        scope: 'calendar-push',
        extra: {
            total: String(tasks.length),
            failed: String(failed),
            stale: String(staleEntries.length),
        },
    });
};

// MARK: - Debounced partial sync

let syncDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSyncTaskIds = new Set<string>();

export const scheduleSyncDebounced = (taskIds: string[]): void => {
    taskIds.forEach((id) => pendingSyncTaskIds.add(id));
    if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
    syncDebounceTimer = setTimeout(() => {
        syncDebounceTimer = null;
        const idsToSync = Array.from(pendingSyncTaskIds);
        pendingSyncTaskIds.clear();
        void runPartialCalendarSync(idsToSync);
    }, SYNC_DEBOUNCE_MS);
};

const runPartialCalendarSync = async (taskIds: string[]): Promise<void> => {
    const enabled = await getCalendarPushEnabled();
    if (!enabled) return;

    const target = await resolveCalendarPushTarget();
    if (!target) return;

    const { _allTasks } = useTaskStore.getState();
    const targets = _allTasks.filter((t) => taskIds.includes(t.id));

    // Also handle tasks that were removed from the store (deleted)
    const storeIds = new Set(_allTasks.map((t) => t.id));
    const removedIds = taskIds.filter((id) => !storeIds.has(id));

    await Promise.allSettled([
        ...targets.map((t) => syncTaskToCalendar(t, target)),
        ...removedIds.map((id) => removeTaskFromCalendar(id)),
    ]);
};

// MARK: - Store subscription

let unsubscribeStore: (() => void) | null = null;

/**
 * Starts watching the task store for changes and syncing due-date tasks to
 * the device calendar. Returns an unsubscribe function.
 */
export const startCalendarPushSync = (): (() => void) => {
    if (unsubscribeStore) return unsubscribeStore;

    let previousTaskMap = new Map(
        useTaskStore.getState()._allTasks.map((t) => [t.id, t])
    );

    unsubscribeStore = useTaskStore.subscribe((state) => {
        const changedIds: string[] = [];
        const currentMap = new Map(state._allTasks.map((t) => [t.id, t]));

        // Changed or new tasks
        for (const task of state._allTasks) {
            const prev = previousTaskMap.get(task.id);
            if (
                !prev ||
                prev.updatedAt !== task.updatedAt ||
                prev.startTime !== task.startTime ||
                prev.dueDate !== task.dueDate ||
                prev.deletedAt !== task.deletedAt ||
                prev.status !== task.status ||
                prev.title !== task.title ||
                prev.timeEstimate !== task.timeEstimate
            ) {
                changedIds.push(task.id);
            }
        }

        // Tasks removed from store entirely
        for (const id of previousTaskMap.keys()) {
            if (!currentMap.has(id)) {
                changedIds.push(id);
            }
        }

        previousTaskMap = currentMap;

        if (changedIds.length > 0) {
            scheduleSyncDebounced(changedIds);
        }
    });

    return () => {
        unsubscribeStore?.();
        unsubscribeStore = null;
        if (syncDebounceTimer) {
            clearTimeout(syncDebounceTimer);
            syncDebounceTimer = null;
        }
        pendingSyncTaskIds.clear();
    };
};

export const stopCalendarPushSync = (): void => {
    unsubscribeStore?.();
    unsubscribeStore = null;
    if (syncDebounceTimer) {
        clearTimeout(syncDebounceTimer);
        syncDebounceTimer = null;
    }
    pendingSyncTaskIds.clear();
};
