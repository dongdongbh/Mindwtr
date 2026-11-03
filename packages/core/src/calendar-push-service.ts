


import { CALENDAR_PUSH_SYNC_CONCURRENCY, createCalendarPushScheduler } from './calendar-push-scheduler';
import { runCalendarPushFullSync, runCalendarPushPartialSync, type CalendarPushRunPorts } from './calendar-push-run';
import { buildCalendarPushEventFields, timeEstimateToMinutes } from './calendar-scheduling';
import { hasTimeComponent, safeFormatDate, safeParseDate } from './date';
import type { CalendarLogContext, DeviceCalendar, DeviceCalendarReader } from './external-calendar-feeds';
import { getTaskCalendarOccurrenceDate, isProjectedRecurringTask } from './recurrence';
import { resolveFeatureFlags } from './resolve-feature-flags';
import { isSandboxMode } from './sandbox';
import type { CalendarSyncEntry } from './sqlite-adapter';
import type { useTaskStore } from './store';
import { nameNotifyListener } from './store-notify-profiler';
import type { Task } from './types';
import { deterministicHash128Hex, generateUUID } from './uuid';

export const CALENDAR_PUSH_ENABLED_KEY = 'mindwtr:calendar-push-sync:enabled';
export const CALENDAR_PUSH_CALENDAR_ID_KEY = 'mindwtr:calendar-push-sync:calendar-id';
export const CALENDAR_PUSH_TARGET_ID_KEY = 'mindwtr:calendar-push-sync:target-calendar-id';
export const CALENDAR_PUSH_COLOR_KEY = 'mindwtr:calendar-push-sync:color';


export const CALENDAR_PUSH_PENDING_KEY = 'mindwtr:calendar-push-sync:pending-calendar';
export const CALENDAR_PUSH_CREATION_INTENT_KEY = 'mindwtr:calendar-push-sync:creation-intent';
export type CalendarPushDeleteExpectation = { calendarId: string | null; creationIntentRevision?: string | null };
export class CalendarPushOwnershipChangedError extends Error {}
const MANAGED_CALENDAR_TITLE = 'Mindwtr';
const MANAGED_CALENDAR_NAME = 'mindwtr';
const CREATION_TITLE_PATTERN = /^Mindwtr \([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\)$/;
type CalendarCreationIntent = { title: string; calendarId?: string; deletionRevision?: string };

function parseCalendarCreationIntent(raw: string): CalendarCreationIntent {
    let intent: CalendarCreationIntent;
    try { intent = JSON.parse(raw) as CalendarCreationIntent; }
    catch { throw new Error('Invalid Mindwtr calendar creation intent'); }
    if (!intent || typeof intent.title !== 'string' || !CREATION_TITLE_PATTERN.test(intent.title)
        || (intent.calendarId !== undefined && (typeof intent.calendarId !== 'string' || !intent.calendarId.trim()))
        || (intent.deletionRevision !== undefined && (!intent.calendarId || typeof intent.deletionRevision !== 'string'
            || !/^[0-9a-f]{32}$/.test(intent.deletionRevision)))) {
        throw new Error('Invalid Mindwtr calendar creation intent');
    }
    return intent;
}


export function matchesCalendarPushCreationIntentRevision(raw: string | null, expected: string | null | undefined): boolean {
    if (raw === null || deterministicHash128Hex(raw) === expected) return true;
    try {
        const revision = parseCalendarCreationIntent(raw).deletionRevision;
        return revision !== undefined && revision === expected;
    } catch { return false; }
}
export const DEFAULT_CALENDAR_PUSH_COLOR = '#3B82F6';
const PROJECTED_RECURRENCE_EVENT_DATE_FORMAT = 'PP';

const ENTITY_EVENT = 'event';
const ACCESS_OWNER = 'owner';
const READ_ONLY_ACCESS_LEVELS = new Set(['freebusy', 'none', 'read', 'respond', 'unknown']);
const SOURCE_LOCAL = 'local';
const SOURCE_CALDAV = 'caldav';

export const CALENDAR_PUSH_COLOR_OPTIONS = [
    '#3B82F6',
    '#2563EB',
    '#7C3AED',
    '#DB2777',
    '#EA580C',
    '#059669',
    '#0891B2',
    '#65A30D',
] as const;

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
};

export type DeviceCalendarSource = { id?: string; name?: string; type?: string; isLocalAccount?: boolean };


export type DeviceCalendarDetails = {
    title: string;
    color: string;
    entityType: string;
    name?: string;
    ownerAccount?: string;
    accessLevel?: string;
    source: DeviceCalendarSource;
    sourceId?: string;
    isVisible?: boolean;
    isSynced?: boolean;
};


export type CalendarPushEventDetails = {
    title: string;
    startDate: Date;
    endDate: Date;
    allDay: boolean;
    notes: string;
    location: string;
    url?: string;
    timeZone?: string;
    endTimeZone?: string;
};


export type CalendarPushEventIdentity = { taskId: string; calendarId: string };


export type DeviceCalendarWriter = DeviceCalendarReader & {

    getSources(): Promise<DeviceCalendarSource[]>;
    createCalendar(details: DeviceCalendarDetails): Promise<string>;

    updateCalendar?: (calendarId: string, details: { color: string; title?: string }) => Promise<unknown>;
    deleteCalendar(calendarId: string): Promise<unknown>;
    createEvent(calendarId: string, details: CalendarPushEventDetails & { calendarId: string }, context?: CalendarPushEventIdentity): Promise<string>;
    updateEvent(eventId: string, details: CalendarPushEventDetails, context?: CalendarPushEventIdentity): Promise<unknown>;
    deleteEvent(eventId: string, context?: CalendarPushEventIdentity): Promise<unknown>;
};

export type CalendarPushServiceHost = {

    platform: string;

    os(): string;

    storage: {
        getItem(key: string): Promise<string | null>;
        setItem(key: string, value: string): Promise<void>;
        removeItem(key: string): Promise<void>;
    };
    calendars: DeviceCalendarWriter;

    syncEntries: {
        ensureReady(): Promise<unknown>;
        get(taskId: string, platform: string): Promise<CalendarSyncEntry | null>;
        upsert(entry: CalendarSyncEntry): Promise<void>;
        delete(taskId: string, platform: string): Promise<void>;
        getAll(platform: string): Promise<CalendarSyncEntry[]>;
    };
    log: {
        info(message: string, context: CalendarLogContext): unknown;
        warn(message: string, context: { scope: string; extra?: Record<string, string> }): unknown;
        error(error: unknown, context: CalendarLogContext): unknown;
    };

    store: Pick<typeof useTaskStore, 'getState' | 'subscribe'>;

    requestPartialSync?: (taskIds: string[]) => void;
};

export function normalizeCalendarPushColor(value: string | null | undefined): string {
    const trimmed = value?.trim().toUpperCase() ?? '';
    return CALENDAR_PUSH_COLOR_OPTIONS.includes(trimmed as typeof CALENDAR_PUSH_COLOR_OPTIONS[number])
        ? trimmed
        : DEFAULT_CALENDAR_PUSH_COLOR;
}

function isReadableAccountName(value: string): boolean {
    const normalized = value.trim().toLowerCase();
    return normalized.length > 0
        && normalized !== MANAGED_CALENDAR_NAME
        && normalized !== 'local account'
        && !normalized.endsWith('@group.calendar.google.com');
}

function getCalendarSourceName(calendar: DeviceCalendar): string | undefined {
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

function getCalendarSourceType(calendar: DeviceCalendar): string | undefined {
    const sourceType = typeof calendar.source?.type === 'string' ? calendar.source.type.trim() : '';
    if (sourceType.length > 0) return sourceType;

    const calendarType = typeof calendar.type === 'string' ? calendar.type.trim() : '';
    return calendarType.length > 0 ? calendarType : undefined;
}

function isLocalOnlyCalendar(calendar: DeviceCalendar): boolean {
    if (calendar.source?.isLocalAccount === true) return true;

    const sourceType = getCalendarSourceType(calendar)?.toLowerCase();
    if (sourceType === 'local') return true;

    const ownerAccount = typeof calendar.ownerAccount === 'string' ? calendar.ownerAccount.trim().toLowerCase() : '';
    const sourceName = typeof calendar.source?.name === 'string' ? calendar.source.name.trim().toLowerCase() : '';
    return ownerAccount === 'local account' && sourceName === 'local account';
}

function getCalendarDisplayName(calendar: DeviceCalendar): string {
    const legacyName = calendar.name;
    const preferred = typeof calendar.title === 'string' && calendar.title.trim().length > 0
        ? calendar.title
        : typeof legacyName === 'string' && legacyName.trim().length > 0
            ? legacyName
            : 'Calendar';
    return preferred.trim() || 'Calendar';
}

function isWritableCalendar(calendar: DeviceCalendar): boolean {
    if (calendar.allowsModifications === false) return false;
    if (calendar.accessLevel && READ_ONLY_ACCESS_LEVELS.has(calendar.accessLevel)) return false;
    return true;
}

function isMindwtrNamedCalendar(calendar: DeviceCalendar): boolean {
    const title = getCalendarDisplayName(calendar).trim().toLowerCase();
    const name = typeof calendar.name === 'string' ? calendar.name.trim().toLowerCase() : '';
    return title === MANAGED_CALENDAR_TITLE.toLowerCase() || name === MANAGED_CALENDAR_NAME;
}

function isStoredMindwtrManagedCalendar(calendar: DeviceCalendar, storedCalendarId: string | null): boolean {
    return Boolean(storedCalendarId && calendar.id === storedCalendarId);
}


const managedCalendarName = (marker: string): string => `${MANAGED_CALENDAR_NAME}:${marker}`;

const hasManagedCalendarName = (calendar: DeviceCalendar): boolean =>
    calendar.name === MANAGED_CALENDAR_NAME || (typeof calendar.name === 'string' && calendar.name.startsWith(`${MANAGED_CALENDAR_NAME}:`));

const OWNED_ONLY_CHECK = 'v1.3.4/calendar-push-owned-only';

function getAndroidManagedCalendarSeed(
    calendars: DeviceCalendar[],
    color: string
): DeviceCalendarDetails | null {
    const ownedCalendar = calendars.find((calendar) =>
        calendar.accessLevel === ACCESS_OWNER
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
        color,
        entityType: ENTITY_EVENT,
        name: MANAGED_CALENDAR_NAME,
        ownerAccount: ownedCalendar.ownerAccount,
        accessLevel: ACCESS_OWNER,
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

function formatProjectedRecurrenceEventDate(task: Task): string {
    return safeFormatDate(getTaskCalendarOccurrenceDate(task), PROJECTED_RECURRENCE_EVENT_DATE_FORMAT);
}

function formatCalendarEventTitle(title: string, occurrenceDateLabel = ''): string {
    const trimmed = title.trim() || 'Task';
    return occurrenceDateLabel ? `${trimmed} (${occurrenceDateLabel})` : trimmed;
}

function formatProjectedRecurrenceNote(task: Task): string {
    const occurrenceDateLabel = formatProjectedRecurrenceEventDate(task);
    return occurrenceDateLabel
        ? `Projected recurring occurrence for ${occurrenceDateLabel}. Complete the current Mindwtr task to create the real next task.`
        : 'Projected recurring occurrence. Complete the current Mindwtr task to create the real next task.';
}

function buildAllDayBoundary(date: Date, os: string, dayOffset = 0): Date {
    if (os === 'android') {
        return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate() + dayOffset));
    }
    const boundary = new Date(date);
    boundary.setHours(0, 0, 0, 0);
    boundary.setDate(boundary.getDate() + dayOffset);
    return boundary;
}

function buildAllDayEndOfDay(date: Date): Date {
    const boundary = new Date(date);
    boundary.setHours(23, 59, 59, 0);
    return boundary;
}

function getCalendarErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object') {
        const value = error as { code?: unknown; message?: unknown; name?: unknown };
        return [value.name, value.code, value.message]
            .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
            .join(' ');
    }
    return String(error);
}

function isCalendarEventMissingError(error: unknown): boolean {
    const message = getCalendarErrorMessage(error).toLowerCase();
    return message.includes('event-not-found')
        || message.includes('calendar event not found')
        || message.includes('event not found')
        || message.includes('event does not exist')
        || message.includes('event already deleted')
        || (message.includes('event') && message.includes('not found'));
}

const buildCalendarSyncTaskMap = (tasks: Task[]) => new Map(tasks.map((task) => [task.id, task]));

export type CalendarPushService = ReturnType<typeof createCalendarPushService>;

export function createCalendarPushService(host: CalendarPushServiceHost) {
    const PLATFORM = host.platform;
    const { storage, calendars: device, syncEntries, log } = host;


    const getCalendarPushEnabled = async (): Promise<boolean> => {
        if (isSandboxMode()) return false;
        const val = await storage.getItem(CALENDAR_PUSH_ENABLED_KEY);
        return val === '1';
    };

    const setCalendarPushEnabled = async (enabled: boolean): Promise<void> => {
        if (isSandboxMode()) return;
        await storage.setItem(CALENDAR_PUSH_ENABLED_KEY, enabled ? '1' : '0');
    };

    const getCalendarPushTargetCalendarId = async (): Promise<string | null> => {
        if (isSandboxMode()) return null;
        const value = await storage.getItem(CALENDAR_PUSH_TARGET_ID_KEY);
        const trimmed = value?.trim() ?? '';
        return trimmed.length > 0 ? trimmed : null;
    };

    const setCalendarPushTargetCalendarId = async (calendarId: string | null): Promise<void> => {
        if (isSandboxMode()) return;
        const trimmed = calendarId?.trim() ?? '';
        if (trimmed.length === 0) {
            await storage.removeItem(CALENDAR_PUSH_TARGET_ID_KEY);
            return;
        }
        await storage.setItem(CALENDAR_PUSH_TARGET_ID_KEY, trimmed);
    };

    const getCalendarPushColor = async (): Promise<string> => {
        if (isSandboxMode()) return DEFAULT_CALENDAR_PUSH_COLOR;
        const value = await storage.getItem(CALENDAR_PUSH_COLOR_KEY);
        return normalizeCalendarPushColor(value);
    };

    const setCalendarPushColor = async (color: string): Promise<string> => {
        const normalized = normalizeCalendarPushColor(color);
        if (isSandboxMode()) return normalized;
        await storage.setItem(CALENDAR_PUSH_COLOR_KEY, normalized);
        return normalized;
    };


    const requestCalendarWritePermission = async (): Promise<boolean> => {
        if (isSandboxMode()) return false;
        try {
            const { status } = await device.requestPermissions();
            return status === 'granted';
        } catch {
            return false;
        }
    };

    const getCalendarWritePermissionStatus = async (): Promise<'granted' | 'denied' | 'undetermined'> => {
        if (isSandboxMode()) return 'undetermined';
        try {
            const { status } = await device.getPermissions();
            if (status === 'granted') return 'granted';
            if (status === 'denied') return 'denied';
            return 'undetermined';
        } catch {
            return 'undetermined';
        }
    };


    const getStoredCalendarId = (): Promise<string | null> =>
        storage.getItem(CALENDAR_PUSH_CALENDAR_ID_KEY);

    const setStoredCalendarId = (id: string): Promise<void> =>
        storage.setItem(CALENDAR_PUSH_CALENDAR_ID_KEY, id);

    const getCreationIntent = async (): Promise<CalendarCreationIntent | null> => {
        const raw = await storage.getItem(CALENDAR_PUSH_CREATION_INTENT_KEY);
        return raw === null ? null : parseCalendarCreationIntent(raw);
    };

    const setCreationIntent = (intent: CalendarCreationIntent): Promise<void> =>
        storage.setItem(CALENDAR_PUSH_CREATION_INTENT_KEY, JSON.stringify(intent));

    const findIntentCalendar = (all: DeviceCalendar[], intent: CalendarCreationIntent, storedId: string | null): DeviceCalendar | null => {
        const matches = all.filter((calendar) => calendar.title === intent.title);
        const stored = all.find((calendar) => calendar.id === storedId);
        if (matches.length > 1 || (intent.calendarId && matches.some((calendar) => calendar.id !== intent.calendarId))
            || (stored && stored.id !== intent.calendarId)) {
            throw new Error('Conflicting Mindwtr calendar creation intent');
        }
        const found = intent.calendarId
            ? all.find((calendar) => calendar.id === intent.calendarId)
            : matches[0];
        if (found && found.title !== intent.title && found.title !== MANAGED_CALENDAR_TITLE) {
            throw new Error('Conflicting Mindwtr calendar creation intent');
        }
        return found ?? null;
    };

    let pendingEnsure: Promise<string | null> | null = null;
    let pendingDelete: Promise<void> | null = null;
    let pendingDeleteExpectation: string | null = null;
    let pendingColor: Promise<boolean> | null = null;


    const adoptPendingCalendar = async (calendars: DeviceCalendar[]): Promise<string | null> => {
        const marker = await storage.getItem(CALENDAR_PUSH_PENDING_KEY);
        if (!marker) return null;
        const made = calendars.find((calendar) => calendar.name === managedCalendarName(marker));
        if (!made) return null;
        await setStoredCalendarId(made.id);
        await storage.removeItem(CALENDAR_PUSH_PENDING_KEY);
        void log.info('Recovered Mindwtr calendar', {
            scope: 'calendar-push',
            extra: { releaseCheck: OWNED_ONLY_CHECK, outcome: 'adopted' },
        });
        return made.id;
    };

    const savedIsOwned = (calendars: DeviceCalendar[], savedId: string | null): savedId is string => Boolean(savedId)
        && calendars.some((calendar) => calendar.id === savedId && (host.os() !== 'android' || hasManagedCalendarName(calendar)));

    const forgetCalendarRows = async (calendarId: string): Promise<void> => {
        for (const entry of (await syncEntries.getAll(PLATFORM)).filter((item) => item.calendarId === calendarId)) {
            await syncEntries.delete(entry.taskId, PLATFORM);
        }
    };

    const resolveOwnedCalendar = async (calendars: DeviceCalendar[], savedId: string | null): Promise<string | null> => (
        savedIsOwned(calendars, savedId) ? savedId : adoptPendingCalendar(calendars)
    );

    const getCalendarPushTargetCalendars = async (): Promise<CalendarPushTargetCalendar[]> => {
        if (isSandboxMode()) return [];
        try {
            const [storedCalendarId, calendars] = await Promise.all([
                getStoredCalendarId(),
                device.getCalendars(),
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
                        isMindwtrManaged: isStoredMindwtrManagedCalendar(calendar, storedCalendarId) && savedIsOwned([calendar], storedCalendarId),
                        isLocalOnly: isLocalOnlyCalendar(calendar),
                    };
                })
                .sort((a, b) => {
                    if (a.isMindwtrManaged !== b.isMindwtrManaged) return a.isMindwtrManaged ? -1 : 1;
                    if (a.isMindwtrDedicated !== b.isMindwtrDedicated) return a.isMindwtrDedicated ? -1 : 1;
                    return a.name.localeCompare(b.name);
                });
        } catch (error) {
            void log.error(error, { scope: 'calendar-push', extra: { operation: 'getCalendarPushTargetCalendars' } });
            return [];
        }
    };


    const ensureMindwtrCalendarUnsafe = async (withColor?: string): Promise<string | null> => {
        if (isSandboxMode()) return null;
        try {
            const storedId = await getStoredCalendarId();
            const intent = host.os() === 'ios' ? await getCreationIntent() : null;
            if (intent?.deletionRevision) return null;
            const allCalendars = await device.getCalendars();
            if (intent) {
                const recovered = findIntentCalendar(allCalendars, intent, storedId);
                if (recovered) {
                    if (!intent.calendarId) await setCreationIntent({ ...intent, calendarId: recovered.id });
                    await setStoredCalendarId(recovered.id);
                    if (recovered.title === intent.title) {
                        if (!device.updateCalendar) throw new Error('This device cannot finish a calendar creation');
                        await device.updateCalendar(recovered.id, {
                            title: MANAGED_CALENDAR_TITLE,
                            color: recovered.color ?? await getCalendarPushColor(),
                        });
                    }
                    await storage.removeItem(CALENDAR_PUSH_CREATION_INTENT_KEY);
                    void log.info('Recovered Mindwtr calendar creation', {
                        scope: 'calendar-push',
                        extra: { releaseCheck: 'v1.3.4/ios-calendar-create-recovery' },
                    });
                    return recovered.id;
                }
                if (intent.calendarId) return null;
            } else if (savedIsOwned(allCalendars, storedId)) {
                if (host.os() === 'android' && await storage.getItem(CALENDAR_PUSH_PENDING_KEY)) {
                    await storage.removeItem(CALENDAR_PUSH_PENDING_KEY);
                }
                return storedId;
            } else if (storedId && allCalendars.some((calendar) => calendar.id === storedId)) {
                void log.warn('Saved Mindwtr calendar ID now names another calendar', {
                    scope: 'calendar-push',
                    extra: { releaseCheck: 'v1.3.8/calendar-push-reused-id', outcome: 'skipped' },
                });
            }
            if (host.os() === 'android' && storedId) await forgetCalendarRows(storedId);
            const adoptedId = host.os() === 'android' ? await resolveOwnedCalendar(allCalendars, null) : null;
            if (adoptedId) return adoptedId;

            const color = withColor ?? await getCalendarPushColor();
            let calendarDetails: DeviceCalendarDetails;

            if (host.os() === 'android') {


                const androidSeed = getAndroidManagedCalendarSeed(allCalendars, color);
                if (!androidSeed) {
                    void log.warn('No owned Android calendar source available; cannot create Mindwtr calendar', {
                        scope: 'calendar-push',
                        extra: { calendarCount: String(allCalendars.length) },
                    });
                    return null;
                }
                calendarDetails = androidSeed;
            } else {

                const sources = await device.getSources();
                const source =
                    sources.find((s) => s.type === SOURCE_LOCAL) ??
                    sources.find((s) => s.type === SOURCE_CALDAV) ??
                    sources[0];

                if (!source) {
                    void log.warn('No calendar source available; cannot create Mindwtr calendar', {
                        scope: 'calendar-push',
                    });
                    return null;
                }

                calendarDetails = {
                    title: intent?.title ?? MANAGED_CALENDAR_TITLE,
                    color,
                    entityType: ENTITY_EVENT,
                    sourceId: source.id,
                    source,
                };
            }


            const marked = host.os() === 'android';
            if (marked) {
                const marker = await storage.getItem(CALENDAR_PUSH_PENDING_KEY) ?? generateUUID();
                await storage.setItem(CALENDAR_PUSH_PENDING_KEY, marker);
                calendarDetails = { ...calendarDetails, name: managedCalendarName(marker) };
            } else if (host.os() === 'ios' && !intent) {
                calendarDetails = { ...calendarDetails, title: `${MANAGED_CALENDAR_TITLE} (${generateUUID()})` };
                await setCreationIntent({ title: calendarDetails.title });
            }
            const newId = await device.createCalendar(calendarDetails);

            if (host.os() === 'ios') await setCreationIntent({ title: calendarDetails.title, calendarId: newId });
            await setStoredCalendarId(newId);
            if (marked) await storage.removeItem(CALENDAR_PUSH_PENDING_KEY);
            if (host.os() === 'ios') {
                if (!device.updateCalendar) throw new Error('This device cannot finish a calendar creation');
                await device.updateCalendar(newId, { title: MANAGED_CALENDAR_TITLE, color });
                await storage.removeItem(CALENDAR_PUSH_CREATION_INTENT_KEY);
                void log.info('Recovered Mindwtr calendar creation', {
                    scope: 'calendar-push',
                    extra: { releaseCheck: 'v1.3.4/ios-calendar-create-recovery' },
                });
            }
            void log.info('Created Mindwtr calendar', {
                scope: 'calendar-push',
                extra: { calendarId: newId },
            });
            return newId;
        } catch (error) {
            void log.error(error, { scope: 'calendar-push', extra: { operation: 'ensureMindwtrCalendar' } });
            return null;
        }
    };

    const ensureMindwtrCalendar = (withColor?: string): Promise<string | null> => {
        if (pendingDelete) return Promise.resolve(null);
        if (pendingEnsure) return pendingEnsure;
        const run = (async () => {


            if (host.os() === 'ios' && pendingColor) await pendingColor.catch(() => undefined);
            if (pendingDelete) return null;
            return ensureMindwtrCalendarUnsafe(withColor);
        })();
        pendingEnsure = run;
        void run.then(() => { pendingEnsure = null; }, () => { pendingEnsure = null; });
        return run;
    };

    const resolveCalendarPushTarget = async (): Promise<CalendarPushTarget | null> => {
        const selectedId = await getCalendarPushTargetCalendarId();
        if (selectedId) {
            try {
                const calendars = await device.getCalendars();
                const selected = calendars.find((calendar) => calendar.id === selectedId);
                const selectedIsReusedMindwtrId = host.os() === 'android' && selectedId === await getStoredCalendarId() && !savedIsOwned(calendars, selectedId);
                if (selected && isWritableCalendar(selected) && !selectedIsReusedMindwtrId) {
                    return { id: selectedId };
                }
                await setCalendarPushTargetCalendarId(null);
                void log.warn('Selected calendar push target is unavailable; falling back to Mindwtr calendar', {
                    scope: 'calendar-push',
                    extra: { calendarId: selectedId },
                });
            } catch (error) {
                void log.error(error, { scope: 'calendar-push', extra: { operation: 'resolveCalendarPushTargetId' } });
            }
        }

        const managedId = await ensureMindwtrCalendar();
        return managedId ? { id: managedId } : null;
    };


    const deleteMindwtrCalendarUnsafe = async (expected?: CalendarPushDeleteExpectation): Promise<void> => {
        if (isSandboxMode()) return;
        const savedId = await getStoredCalendarId();
        const rawIntent = host.os() === 'ios' ? await storage.getItem(CALENDAR_PUSH_CREATION_INTENT_KEY) : null;
        if (expected) {
            if ((savedId !== null && savedId !== expected.calendarId)
                || !matchesCalendarPushCreationIntentRevision(rawIntent, expected.creationIntentRevision)) {
                throw new CalendarPushOwnershipChangedError('The Mindwtr calendar changed before deletion');
            }
        }
        const intent = rawIntent === null ? null : parseCalendarCreationIntent(rawIntent);
        const selectedTargetId = await getCalendarPushTargetCalendarId();

        const calendars = await device.getCalendars();
        const ownedId = intent
            ? findIntentCalendar(calendars, intent, savedId)?.id ?? null
            : await resolveOwnedCalendar(calendars, savedId);
        if (intent && !ownedId && !intent.deletionRevision) throw new Error('Cannot identify pending Mindwtr calendar');

        if (ownedId) {
            if (intent && !intent.deletionRevision) {
                await setCreationIntent({ ...intent, calendarId: ownedId, deletionRevision: deterministicHash128Hex(rawIntent!) });
            }
            try {
                await device.deleteCalendar(ownedId);
            } catch (error) {


                const stillThere = await device.getCalendars()
                    .then((list) => list.some((calendar) => calendar.id === ownedId), () => true);
                if (stillThere) {
                    void log.warn('Failed to delete Mindwtr calendar; keeping it for a retry', {
                        scope: 'calendar-push',
                        extra: { releaseCheck: OWNED_ONLY_CHECK, outcome: 'refused', error: getCalendarErrorMessage(error) },
                    });
                    throw error;
                }
            }
        }


        const goneIds = new Set([ownedId, savedId, intent?.calendarId].filter((id): id is string => Boolean(id)));
        try {
            const syncedEntries = await syncEntries.getAll(PLATFORM);
            for (const entry of syncedEntries.filter((item) => goneIds.has(item.calendarId))) {
                await syncEntries.delete(entry.taskId, PLATFORM);
            }
        } catch (error) {

            void log.warn('Failed to clear deleted Mindwtr calendar sync entries', {
                scope: 'calendar-push',
                extra: { error: String(error) },
            });
        }

        if (selectedTargetId && goneIds.has(selectedTargetId)) {
            await setCalendarPushTargetCalendarId(null);
        }
        await storage.removeItem(CALENDAR_PUSH_PENDING_KEY);
        await storage.removeItem(CALENDAR_PUSH_CALENDAR_ID_KEY);
        if (intent) await storage.removeItem(CALENDAR_PUSH_CREATION_INTENT_KEY);

        if (selectedTargetId && !goneIds.has(selectedTargetId)) {
            void log.info('Calendar deletion kept the selected target', {
                scope: 'calendar-push', extra: { releaseCheck: 'v1.3.5/calendar-delete-target', outcome: 'preserved' },
            });
        }

        void log.info('Deleted Mindwtr calendar', {
            scope: 'calendar-push',
            extra: { releaseCheck: OWNED_ONLY_CHECK, outcome: ownedId ? 'deleted' : 'none-owned' },
        });
    };


    const deleteMindwtrCalendar = (expected?: CalendarPushDeleteExpectation): Promise<void> => {
        const expectation = JSON.stringify(expected ?? null);
        if (pendingDelete) return expectation === pendingDeleteExpectation
            ? pendingDelete
            : pendingDelete.catch(() => undefined).then(() => deleteMindwtrCalendar(expected));
        const run = (async () => {
            if (pendingEnsure) await pendingEnsure;
            if (pendingColor) await pendingColor.catch(() => undefined);
            await deleteMindwtrCalendarUnsafe(expected);
        })();
        pendingDelete = run;
        pendingDeleteExpectation = expectation;
        void run.then(() => { pendingDelete = null; }, () => { pendingDelete = null; });
        return run;
    };


    const buildEventDetails = (task: Task): CalendarPushEventDetails => {


        const dateValue = task.startTime ?? task.dueDate;
        const parsed = safeParseDate(dateValue);
        const startDate = parsed ?? new Date();
        const projectedOccurrenceDateLabel = isProjectedRecurringTask(task)
            ? formatProjectedRecurrenceEventDate(task)
            : '';
        const title = formatCalendarEventTitle(task.title, projectedOccurrenceDateLabel);
        const location = typeof task.location === 'string' ? task.location.trim() : '';
        const { projects, sections, settings } = host.store.getState();
        const projectName = task.projectId
            ? projects.find((project) => project.id === task.projectId)?.title
            : undefined;
        const sectionName = task.sectionId
            ? sections.find((section) => section.id === task.sectionId)?.title
            : undefined;
        const leadingNote = isProjectedRecurringTask(task) ? formatProjectedRecurrenceNote(task) : undefined;
        const { notes, url } = buildCalendarPushEventFields(task, { projectName, sectionName, leadingNote });

        if (hasTimeComponent(dateValue)) {


            const estimateMinutes = timeEstimateToMinutes(task.timeEstimate, {
                enabled: resolveFeatureFlags(settings).timeEstimates,
            });
            const endDate = new Date(startDate.getTime() + estimateMinutes * 60 * 1000);
            return {
                title,
                startDate,
                endDate,
                allDay: false,
                notes,
                location,
                ...(url ? { url } : {}),
            };
        }

        const os = host.os();
        const startDateOnly = buildAllDayBoundary(startDate, os);


        const endDate = os === 'android'
            ? buildAllDayBoundary(startDate, os, 1)
            : buildAllDayEndOfDay(startDate);
        return {
            title,
            startDate: startDateOnly,
            endDate,
            allDay: true,
            notes,
            location,
            ...(url ? { url } : {}),
            ...(os === 'android' ? { timeZone: 'UTC', endTimeZone: 'UTC' } : {}),
        };
    };

    const createCalendarPushRunPorts = (target: CalendarPushTarget): CalendarPushRunPorts => ({
        platform: PLATFORM,
        nowIso: () => new Date().toISOString(),
        createEvent: async (task) => {
            const details = buildEventDetails(task);
            return device.createEvent(target.id, { ...details, calendarId: target.id }, { taskId: task.id, calendarId: target.id });
        },
        updateEvent: async (entry, task) => {
            try {
                await device.updateEvent(entry.calendarEventId, buildEventDetails(task), { taskId: entry.taskId, calendarId: entry.calendarId });
                return { status: 'updated', eventId: entry.calendarEventId };
            } catch (error) {
                if (isCalendarEventMissingError(error)) {
                    return { status: 'missing' };
                }
                void log.warn('Failed to update calendar event; keeping local sync mapping for retry', {
                    scope: 'calendar-push',
                    extra: {
                        taskId: entry.taskId,
                        eventId: entry.calendarEventId,
                        error: getCalendarErrorMessage(error),
                    },
                });
                throw error;
            }
        },
        deleteEvent: async (entry) => {
            try {
                await device.deleteEvent(entry.calendarEventId, { taskId: entry.taskId, calendarId: entry.calendarId });
            } catch (error) {
                if (isCalendarEventMissingError(error)) {
                    return;
                }
                void log.warn('Failed to delete calendar event; keeping local sync mapping for retry', {
                    scope: 'calendar-push',
                    extra: {
                        taskId: entry.taskId,
                        eventId: entry.calendarEventId,
                        error: getCalendarErrorMessage(error),
                    },
                });
                throw error;
            }
        },
        getSyncEntry: (taskId) => syncEntries.get(taskId, PLATFORM),
        getAllSyncEntries: () => syncEntries.getAll(PLATFORM),
        upsertSyncEntry: syncEntries.upsert,
        deleteSyncEntry: (taskId) => syncEntries.delete(taskId, PLATFORM),
    });

    let calendarSyncStorageWarningShown = false;
    const canUseCalendarSyncStorage = async (): Promise<boolean> => {
        try {
            await syncEntries.ensureReady();
            calendarSyncStorageWarningShown = false;
            return true;
        } catch (error) {
            if (!calendarSyncStorageWarningShown) {
                calendarSyncStorageWarningShown = true;
                void log.warn('Calendar sync skipped because SQLite storage is unavailable', {
                    scope: 'calendar-push',
                    extra: { error: getCalendarErrorMessage(error) },
                });
            }
            return false;
        }
    };


    const runFullCalendarSyncUnsafe = async (): Promise<void> => {
        const enabled = await getCalendarPushEnabled();
        if (!enabled) return;
        if (!await canUseCalendarSyncStorage()) return;

        const target = await resolveCalendarPushTarget();
        if (!target) return;

        const { _allTasks } = host.store.getState();
        const result = await runCalendarPushFullSync({
            tasks: _allTasks as Task[],
            target,
            ports: createCalendarPushRunPorts(target),
            concurrency: CALENDAR_PUSH_SYNC_CONCURRENCY,
        });
        void log.info('Full calendar sync complete', {
            scope: 'calendar-push',
            extra: {
                total: String(result.total),
                failed: String(result.failed),
                stale: String(result.stale),
                releaseCheck: 'v1.3.0/calendar-push-inventory',
            },
        });
    };


    const runPartialCalendarSyncUnsafe = async (taskIds: string[]): Promise<void> => {
        const enabled = await getCalendarPushEnabled();
        if (!enabled) return;
        if (!await canUseCalendarSyncStorage()) return;

        const target = await resolveCalendarPushTarget();
        if (!target) return;

        const { _tasksById } = host.store.getState();
        await runCalendarPushPartialSync({
            taskIds,
            tasksById: _tasksById as Map<string, Task>,
            target,
            ports: createCalendarPushRunPorts(target),
            concurrency: CALENDAR_PUSH_SYNC_CONCURRENCY,
        });
    };


    const calendarPushScheduler = createCalendarPushScheduler({
        runFull: () => runFullCalendarSyncUnsafe(),
        runPartial: (taskIds) => runPartialCalendarSyncUnsafe(taskIds),
        onPartialDue: host.requestPartialSync,
    });

    const enqueueCalendarSync = calendarPushScheduler.enqueue;

    const runFullCalendarSync = (): Promise<void> => (
        isSandboxMode() ? Promise.resolve() : calendarPushScheduler.runFull()
    );

    const runPartialCalendarSync = (taskIds: readonly string[]): Promise<void> => (
        isSandboxMode() ? Promise.resolve() : calendarPushScheduler.runPartial(taskIds)
    );

    const scheduleSyncDebounced = (taskIds: string[]): void => {
        if (isSandboxMode()) return;
        calendarPushScheduler.scheduleDebounced(taskIds);
    };


    const recreateManagedMindwtrCalendar = async (color: string): Promise<boolean> => {
        let recreatedId: string | null = null;
        await enqueueCalendarSync(async () => {
            await deleteMindwtrCalendarUnsafe();
            recreatedId = await ensureMindwtrCalendarUnsafe(color);
            if (!recreatedId) return;
            await setCalendarPushColor(color);
            await runFullCalendarSyncUnsafe();
        });
        return recreatedId !== null;
    };


    const updateMindwtrCalendarColorUnsafe = async (color: string): Promise<boolean> => {
        if (isSandboxMode()) return false;
        const normalized = normalizeCalendarPushColor(color);
        const stored = async (outcome: 'updated' | 'already' | 'deferred'): Promise<boolean> => {
            await setCalendarPushColor(normalized);
            if (outcome === 'deferred') {
                void log.info('Mindwtr calendar color kept for the next calendar', {
                    scope: 'calendar-push',
                    extra: { releaseCheck: OWNED_ONLY_CHECK, outcome },
                });
            }
            return outcome !== 'deferred';
        };
        try {
            if (host.os() === 'ios' && await getCreationIntent() && !await ensureMindwtrCalendarUnsafe()) return false;
            const storedCalendarId = await getStoredCalendarId();
            const calendars = await device.getCalendars();

            const ownId = await resolveOwnedCalendar(calendars, storedCalendarId);
            const target = calendars.find((calendar) => ownId && calendar.id === ownId);
            if (!target) return await stored('deferred');
            if ((target.color ?? '').trim().toUpperCase() === normalized) return await stored('already');
            if (!isWritableCalendar(target)) throw new Error('The Mindwtr calendar cannot be changed on this device');


            if (host.os() === 'android') {
                if (await recreateManagedMindwtrCalendar(normalized)) return true;

                return await stored('deferred');
            }

            if (typeof device.updateCalendar !== 'function') throw new Error('This device cannot change a calendar color');
            await device.updateCalendar(target.id, { color: normalized });
            return await stored('updated');
        } catch (error) {
            void log.warn('Failed to update Mindwtr calendar color', {
                scope: 'calendar-push',
                extra: { error: getCalendarErrorMessage(error) },
            });
            throw error;
        }
    };

    const updateMindwtrCalendarColor = (color: string): Promise<boolean> => {
        if (pendingDelete) return Promise.resolve(false);
        const previous = pendingColor;
        const run = (async () => {
            if (previous) await previous.catch(() => undefined);
            if (pendingEnsure) await pendingEnsure;
            return updateMindwtrCalendarColorUnsafe(color);
        })();
        pendingColor = run;
        void run.then(() => { if (pendingColor === run) pendingColor = null; }, () => { if (pendingColor === run) pendingColor = null; });
        return run;
    };


    let unsubscribeStore: (() => void) | null = null;

    const stopCalendarPushSync = (): void => {
        unsubscribeStore?.();
        unsubscribeStore = null;
        calendarPushScheduler.cancelPending();
    };


    const startCalendarPushSync = (): (() => void) => {
        if (isSandboxMode()) return () => {};
        if (unsubscribeStore) return unsubscribeStore;

        let previousTaskMap = buildCalendarSyncTaskMap(host.store.getState()._allTasks);

        unsubscribeStore = host.store.subscribe(
            (state) => state._allTasks,
            nameNotifyListener('calendar-push', (currentTasks: Task[]) => {
                const changedIds: string[] = [];
                const currentMap = buildCalendarSyncTaskMap(currentTasks);


                for (const task of currentTasks) {
                    const prev = previousTaskMap.get(task.id);
                    if (
                        !prev ||
                        prev.updatedAt !== task.updatedAt ||
                        prev.startTime !== task.startTime ||
                        prev.dueDate !== task.dueDate ||
                        prev.deletedAt !== task.deletedAt ||
                        prev.status !== task.status ||
                        prev.title !== task.title ||
                        prev.description !== task.description ||
                        prev.location !== task.location ||
                        prev.timeEstimate !== task.timeEstimate ||
                        prev.suppressMindwtrReminders !== task.suppressMindwtrReminders ||
                        prev.recurrence !== task.recurrence ||
                        prev.showFutureRecurrence !== task.showFutureRecurrence
                    ) {
                        changedIds.push(task.id);
                    }
                }


                for (const id of previousTaskMap.keys()) {
                    if (!currentMap.has(id)) {
                        changedIds.push(id);
                    }
                }

                previousTaskMap = currentMap;

                if (changedIds.length > 0) {
                    scheduleSyncDebounced(changedIds);
                }
            })
        );

        return stopCalendarPushSync;
    };

    return {
        getCalendarPushEnabled,
        setCalendarPushEnabled,
        getCalendarPushTargetCalendarId,
        setCalendarPushTargetCalendarId,
        getCalendarPushColor,
        setCalendarPushColor,
        requestCalendarWritePermission,
        getCalendarWritePermissionStatus,
        getCalendarPushTargetCalendars,
        ensureMindwtrCalendar,
        updateMindwtrCalendarColor,
        deleteMindwtrCalendar,
        runFullCalendarSync,
        runPartialCalendarSync,
        scheduleSyncDebounced,
        startCalendarPushSync,
        stopCalendarPushSync,
    };
}
