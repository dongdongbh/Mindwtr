


import { hasCalendarPushTaskMarker } from './calendar-scheduling';
import { normalizeExternalCalendarColor } from './external-calendar-colors';
import { readResponseText, ResponseTooLargeError } from './http-utils';
import { isMindwtrMirrorCalendar, mergeExternalCalendarSources, type ExternalCalendarSourceResult } from './external-calendar-ingestion';
import { expandCategoryCalendars, parseIcsWithMetadata, type ExternalCalendarEvent, type ExternalCalendarSubscription } from './ics';
import { isSandboxMode } from './sandbox';
import { generateUUID } from './uuid';

export const EXTERNAL_CALENDARS_KEY = 'mindwtr-external-calendars';
export const SYSTEM_CALENDAR_SETTINGS_KEY = 'mindwtr-system-calendar-settings';

const SYSTEM_CALENDAR_SOURCE_PREFIX = 'system';

export const EXTERNAL_CALENDAR_FEED_TIMEOUT_MS = 15_000;

export const EXTERNAL_CALENDAR_FEED_MAX_BYTES = 20 * 1024 * 1024;

export const EXTERNAL_CALENDAR_REFRESH_THROTTLE_MS = 1_000;


export function shouldRefreshExternalCalendarOnAppStateChange(
    previousAppState: string,
    nextAppState: string,
): boolean {
    const wasInactiveOrBackground = previousAppState === 'inactive' || previousAppState === 'background';
    return wasInactiveOrBackground && nextAppState === 'active';
}

export type SystemCalendarPermissionStatus = 'undetermined' | 'granted' | 'denied';

export interface SystemCalendarSettings {
    enabled: boolean;
    selectAll: boolean;
    selectedCalendarIds: string[];
    areaIdsByCalendar?: Record<string, string[]>;
}

export interface SystemCalendarInfo {
    id: string;
    name: string;
    color?: string;
}

export type ExternalCalendarFetchOptions = {
    signal?: AbortSignal;
    timeoutMs?: number;

    onFeedError?: (calendarId: string) => void;

    sources?: { subscriptions: ExternalCalendarSubscription[]; systemSettings: SystemCalendarSettings };
};


export type DeviceCalendar = {
    id: string;
    title?: string;
    name?: string | null;
    color?: string;
    ownerAccount?: string;
    accessLevel?: string;
    allowsModifications?: boolean;
    type?: string;
    source?: { id?: string; name?: string; type?: string; isLocalAccount?: boolean };
};


export type DeviceCalendarEvent = {
    id?: string;
    calendarId?: string;
    title?: string;
    startDate?: unknown;
    endDate?: unknown;
    allDay?: boolean;
    notes?: string | null;
    location?: string | null;
};


export type DeviceCalendarReader = {

    getPermissions(): Promise<{ status: unknown }>;

    requestPermissions(): Promise<{ status: unknown }>;

    getCalendars(): Promise<DeviceCalendar[]>;

    getEvents(calendarIds: string[], start: Date, end: Date): Promise<DeviceCalendarEvent[]>;
};

export type CalendarLogContext = { scope: string; extra: Record<string, string> };

export type ExternalCalendarFeedsHost = {

    platform(): string;

    storage: { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> };
    fetch: typeof fetch;

    readLocalFile(url: string, signal?: AbortSignal): Promise<string>;
    calendars: DeviceCalendarReader;

    getAllCalendarSyncEntries(platform: string): Promise<Array<{ calendarId?: unknown; calendarEventId?: unknown }>>;
    logInfo(message: string, context: CalendarLogContext): unknown;


    syncedSubscriptions?(): ExternalCalendarSubscription[] | undefined;
};

function calendarReadDiagnosticCounts(
    calendars: ExternalCalendarSubscription[],
    events: ExternalCalendarEvent[],
): Record<string, string> {
    let allDayCount = 0;
    let allDayNonMidnightCount = 0;
    let localDayAheadCount = 0;
    let localDayBehindCount = 0;

    for (const event of events) {
        if (event.allDay) allDayCount += 1;
        const start = new Date(event.start);
        if (!Number.isFinite(start.getTime())) continue;
        if (event.allDay && (
            start.getHours() !== 0
            || start.getMinutes() !== 0
            || start.getSeconds() !== 0
            || start.getMilliseconds() !== 0
        )) {
            allDayNonMidnightCount += 1;
        }
        const localDay = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
        const utcDay = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
        if (localDay > utcDay) localDayAheadCount += 1;
        else if (localDay < utcDay) localDayBehindCount += 1;
    }

    const nativeColorCount = calendars.filter((calendar) => (
        typeof calendar.feedColor === 'string' && calendar.feedColor.trim().length > 0
    )).length;

    return {
        calendarCount: String(calendars.length),
        eventCount: String(events.length),
        allDayCount: String(allDayCount),
        timedCount: String(events.length - allDayCount),
        allDayNonMidnightCount: String(allDayNonMidnightCount),
        localDayAheadCount: String(localDayAheadCount),
        localDayBehindCount: String(localDayBehindCount),
        nativeColorCount: String(nativeColorCount),
        fallbackColorCount: String(calendars.length - nativeColorCount),
    };
}

export function isLocalCalendarSourceUrl(url: string): boolean {
    const normalized = url.trim().toLowerCase();
    return normalized.startsWith('file://') || normalized.startsWith('content://');
}

function safeJsonParse<T>(raw: string | null, fallback: T): T {
    if (!raw) return fallback;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

export function normalizeSystemCalendarSettings(raw: Partial<SystemCalendarSettings> | null): SystemCalendarSettings {
    const enabled = raw?.enabled === true;
    const selectAll = raw?.selectAll !== false;
    const selectedCalendarIds = Array.isArray(raw?.selectedCalendarIds)
        ? Array.from(
            new Set(
                raw.selectedCalendarIds

                    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
            )
        )
        : [];

    return {
        enabled,
        selectAll,
        selectedCalendarIds: selectAll ? [] : selectedCalendarIds,
        areaIdsByCalendar: Object.fromEntries(Object.entries(raw?.areaIdsByCalendar ?? {})
            .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]))
            .map(([id, ids]) => [id, [...new Set(ids.filter((areaId) => typeof areaId === 'string' && areaId.length > 0))]])),
    };
}


export function decodeSystemCalendarSettings(raw: string | null): SystemCalendarSettings {
    return normalizeSystemCalendarSettings(safeJsonParse<Partial<SystemCalendarSettings> | null>(raw, null));
}

function normalizePermissionStatus(status: unknown): SystemCalendarPermissionStatus {
    if (status === 'granted' || status === 'denied' || status === 'undetermined') {
        return status;
    }
    return 'denied';
}

export function getDeviceCalendarDisplayName(calendar: DeviceCalendar): string {
    const rawTitle = calendar.title;
    const legacyName = calendar.name;
    const preferred = typeof rawTitle === 'string' && rawTitle.trim().length > 0
        ? rawTitle
        : typeof legacyName === 'string' && legacyName.trim().length > 0
            ? legacyName
            : 'Calendar';
    return preferred.trim() || 'Calendar';
}

function isMindwtrNamedCalendar(calendar: DeviceCalendar): boolean {
    if (isMindwtrMirrorCalendar({ name: getDeviceCalendarDisplayName(calendar) })) {
        return true;
    }
    return typeof calendar.name === 'string'
        && isMindwtrMirrorCalendar({ name: calendar.name });
}

function getSystemCalendarSourceId(calendarId: string): string {
    return `${SYSTEM_CALENDAR_SOURCE_PREFIX}:${calendarId}`;
}


export function canOpenExternalCalendarEvent(event: ExternalCalendarEvent, platform: string): boolean {
    return !isSandboxMode()
        && platform !== 'web'
        && event.sourceId.startsWith(`${SYSTEM_CALENDAR_SOURCE_PREFIX}:`)
        && typeof event.nativeEventId === 'string'
        && event.nativeEventId.trim().length > 0;
}

function toLocalMidnightOfUtcDate(value: Date): Date {
    return new Date(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), 0, 0, 0, 0);
}

function toDateSafe(value: unknown): Date | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(String(value));
    if (!Number.isFinite(date.getTime())) return null;
    return date;
}

export function normalizeExternalCalendarSubscriptions(calendars: readonly ExternalCalendarSubscription[]): ExternalCalendarSubscription[] {
    return calendars
        .filter((c) => c && typeof c.url === 'string')
        .map((c) => ({
            id: c.id || generateUUID(),
            name: (c.name || 'Calendar').trim() || 'Calendar',
            url: c.url.trim(),
            enabled: c.enabled !== false,
            color: normalizeExternalCalendarColor(c.color),
            ...(Array.isArray(c.areaIds) ? { areaIds: c.areaIds } : {}),
        }))
        .filter((c) => c.url.length > 0);
}


export function decodeExternalCalendarSubscriptions(raw: string | null): ExternalCalendarSubscription[] {
    return normalizeExternalCalendarSubscriptions(safeJsonParse<ExternalCalendarSubscription[]>(raw, []));
}

function sanitizeExternalCalendars(calendars: ExternalCalendarSubscription[]): ExternalCalendarSubscription[] {
    return calendars
        .map((c) => ({
            id: c.id || generateUUID(),
            name: (c.name || 'Calendar').trim() || 'Calendar',
            url: (c.url || '').trim(),
            enabled: c.enabled !== false,
            color: normalizeExternalCalendarColor(c.color),
            ...(Array.isArray(c.areaIds) ? { areaIds: c.areaIds } : {}),
        }))
        .filter((c) => c.url.length > 0);
}

function createAbortError(message: string): Error {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

function resolveAbortError(signal: AbortSignal, fallbackMessage: string): Error {
    return signal.reason instanceof Error ? signal.reason : createAbortError(fallbackMessage);
}

function throwIfAborted(signal?: AbortSignal, fallbackMessage = 'External calendar request cancelled'): void {
    if (!signal?.aborted) return;
    throw resolveAbortError(signal, fallbackMessage);
}

async function withAbortSignal<T>(
    promise: Promise<T>,
    signal?: AbortSignal,
    fallbackMessage = 'External calendar request cancelled',
): Promise<T> {
    if (!signal) return promise;
    throwIfAborted(signal, fallbackMessage);
    return await new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(resolveAbortError(signal, fallbackMessage));
        signal.addEventListener('abort', onAbort, { once: true });
        promise
            .then(resolve, reject)
            .finally(() => signal.removeEventListener('abort', onAbort));
    });
}

function createLinkedAbortSignal(
    signal?: AbortSignal,
    timeoutMs?: number,
): { signal?: AbortSignal; cleanup: () => void } {
    if (typeof AbortController === 'undefined') {
        return { signal, cleanup: () => undefined };
    }
    const controller = new AbortController();
    const cleanups: Array<() => void> = [];
    const abortWith = (reason: unknown, fallbackMessage: string) => {
        if (controller.signal.aborted) return;
        controller.abort(reason instanceof Error ? reason : createAbortError(fallbackMessage));
    };

    if (signal) {
        if (signal.aborted) {
            abortWith(signal.reason, 'External calendar request cancelled');
        } else {
            const onAbort = () => abortWith(signal.reason, 'External calendar request cancelled');
            signal.addEventListener('abort', onAbort, { once: true });
            cleanups.push(() => signal.removeEventListener('abort', onAbort));
        }
    }

    if (typeof timeoutMs === 'number' && timeoutMs > 0) {
        const timeout = setTimeout(() => {
            abortWith(undefined, 'External calendar request timed out');
        }, timeoutMs);
        cleanups.push(() => clearTimeout(timeout));
    }

    return {
        signal: controller.signal,
        cleanup: () => {
            cleanups.forEach((cleanup) => cleanup());
        },
    };
}

export type ExternalCalendarFeeds = ReturnType<typeof createExternalCalendarFeeds>;

export function createExternalCalendarFeeds(host: ExternalCalendarFeedsHost) {
    const getExternalCalendars = async (): Promise<ExternalCalendarSubscription[]> => {
        if (isSandboxMode()) return [];
        const raw = await host.storage.getItem(EXTERNAL_CALENDARS_KEY);
        return decodeExternalCalendarSubscriptions(raw);
    };

    const saveExternalCalendars = async (calendars: ExternalCalendarSubscription[]): Promise<void> => {
        if (isSandboxMode()) return;
        await host.storage.setItem(EXTERNAL_CALENDARS_KEY, JSON.stringify(sanitizeExternalCalendars(calendars)));
    };

    const getSystemCalendarSettings = async (): Promise<SystemCalendarSettings> => {
        if (isSandboxMode()) return normalizeSystemCalendarSettings(null);
        const raw = await host.storage.getItem(SYSTEM_CALENDAR_SETTINGS_KEY);
        return decodeSystemCalendarSettings(raw);
    };

    const saveSystemCalendarSettings = async (settings: SystemCalendarSettings): Promise<void> => {
        if (isSandboxMode()) return;
        const sanitized = normalizeSystemCalendarSettings(settings);
        await host.storage.setItem(SYSTEM_CALENDAR_SETTINGS_KEY, JSON.stringify(sanitized));
    };

    const getSystemCalendarPermissionStatus = async (): Promise<SystemCalendarPermissionStatus> => {
        if (isSandboxMode()) return 'denied';
        if (host.platform() === 'web') return 'denied';
        try {
            const result = await host.calendars.getPermissions();
            return normalizePermissionStatus(result.status);
        } catch {
            return 'denied';
        }
    };

    const requestSystemCalendarPermission = async (): Promise<SystemCalendarPermissionStatus> => {
        if (isSandboxMode()) return 'denied';
        if (host.platform() === 'web') return 'denied';
        try {
            const result = await host.calendars.requestPermissions();
            return normalizePermissionStatus(result.status);
        } catch {
            return 'denied';
        }
    };

    const getSystemCalendars = async (): Promise<SystemCalendarInfo[]> => {
        if (isSandboxMode()) return [];
        if (host.platform() === 'web') return [];
        const permission = await getSystemCalendarPermissionStatus();
        if (permission !== 'granted') throw new Error('Calendar provider unavailable');

        try {
            const calendars = await host.calendars.getCalendars();
            return calendars
                .filter((calendar) => typeof calendar.id === 'string' && calendar.id.trim().length > 0)
                .filter((calendar) => !isMindwtrNamedCalendar(calendar))
                .map((calendar) => ({
                    id: calendar.id,
                    name: getDeviceCalendarDisplayName(calendar),
                    color: typeof calendar.color === 'string' && calendar.color.trim().length > 0 ? calendar.color : undefined,
                }))
                .sort((a, b) => a.name.localeCompare(b.name));
        } catch {
            throw new Error('Calendar provider unavailable');
        }
    };

    const fetchTextWithTimeout = async (url: string, timeoutMs: number, signal?: AbortSignal): Promise<string> => {
        if (isLocalCalendarSourceUrl(url)) {
            throwIfAborted(signal);
            const text = await host.readLocalFile(url, signal);
            throwIfAborted(signal);

            if (text.length > EXTERNAL_CALENDAR_FEED_MAX_BYTES) throw new ResponseTooLargeError(EXTERNAL_CALENDAR_FEED_MAX_BYTES);
            return text;
        }

        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
        const onAbort = controller && signal
            ? () => controller.abort(resolveAbortError(signal, 'External calendar request cancelled'))
            : null;

        try {
            if (signal && onAbort) {
                if (signal.aborted) {
                    onAbort();
                } else {
                    signal.addEventListener('abort', onAbort, { once: true });
                }
            }
            const res = await host.fetch(url, controller ? { signal: controller.signal } : undefined);
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }
            return await readResponseText(res, EXTERNAL_CALENDAR_FEED_MAX_BYTES, controller?.signal ?? signal);
        } finally {
            if (timeout) clearTimeout(timeout);
            if (signal && onAbort) {
                signal.removeEventListener('abort', onAbort);
            }
        }
    };

    const fetchIcsCalendarEvents = async (
        rangeStart: Date,
        rangeEnd: Date,
        signal?: AbortSignal,
        onFeedError?: (calendarId: string) => void,
        sources?: ExternalCalendarFetchOptions['sources'],
    ): Promise<ExternalCalendarSourceResult> => {
        throwIfAborted(signal);
        const synced = sources ? undefined : host.syncedSubscriptions?.();
        const calendars = sources ? sources.subscriptions : Array.isArray(synced) ? sanitizeExternalCalendars(synced) : await getExternalCalendars();
        const enabled = calendars.filter((c) => c.enabled);

        const results = await Promise.allSettled(
            enabled.map(async (calendar) => {
                const text = await fetchTextWithTimeout(calendar.url, EXTERNAL_CALENDAR_FEED_TIMEOUT_MS, signal);
                return parseIcsWithMetadata(text, {
                    sourceId: calendar.id,
                    rangeStart,
                    rangeEnd,
                    splitByCategory: true,
                });
            })
        );


        const splitCalendarIds = new Set<string>();
        const icsSources: ExternalCalendarSourceResult[] = [];
        for (const [index, result] of results.entries()) {
            const calendar = enabled[index];
            if (result.status !== 'fulfilled') {
                onFeedError?.(calendar.id);
                continue;
            }
            const contributed = expandCategoryCalendars(
                calendar,
                result.value.events,
                result.value.categoryInfo,
                result.value.calendarColor,
            );
            if (!contributed.some((entry) => entry.id === calendar.id)) splitCalendarIds.add(calendar.id);
            icsSources.push({ calendars: contributed, events: result.value.events });
        }

        const merged = mergeExternalCalendarSources([
            { calendars: calendars.filter((calendar) => !splitCalendarIds.has(calendar.id)), events: [] },
            ...icsSources,
        ]);

        return merged;
    };

    const fetchSystemCalendarEvents = async (rangeStart: Date, rangeEnd: Date, signal?: AbortSignal, sources?: ExternalCalendarFetchOptions['sources']): Promise<ExternalCalendarSourceResult> => {
        throwIfAborted(signal);
        const platform = host.platform();
        if (platform === 'web') {
            return { calendars: [], events: [] };
        }

        const settings = sources ? sources.systemSettings : await getSystemCalendarSettings();
        throwIfAborted(signal);
        if (!settings.enabled) {
            return { calendars: [], events: [] };
        }

        const permission = await getSystemCalendarPermissionStatus();
        throwIfAborted(signal);
        if (permission !== 'granted') {
            return { calendars: [], events: [] };
        }

        const rawCalendars = await withAbortSignal(host.calendars.getCalendars(), signal);
        throwIfAborted(signal);
        const availableCalendars = rawCalendars
            .filter((calendar) => typeof calendar.id === 'string' && calendar.id.trim().length > 0)
            .filter((calendar) => !isMindwtrNamedCalendar(calendar));
        if (availableCalendars.length === 0) {
            return { calendars: [], events: [] };
        }

        const selectedCalendarIds = settings.selectAll
            ? availableCalendars.map((calendar) => calendar.id)
            : settings.selectedCalendarIds;
        if (selectedCalendarIds.length === 0) {
            return { calendars: [], events: [] };
        }

        const availableById = new Map(availableCalendars.map((calendar) => [calendar.id, calendar]));
        const selectedCalendars = selectedCalendarIds
            .map((id) => availableById.get(id))
            .filter((calendar): calendar is DeviceCalendar => Boolean(calendar));
        if (selectedCalendars.length === 0) {
            return { calendars: [], events: [] };
        }

        const selectedIds = selectedCalendars.map((calendar) => calendar.id);


        const queryPadMs = platform === 'android' ? 92 * 24 * 60 * 60 * 1000 : 0;
        const rawEvents = await withAbortSignal(
            host.calendars.getEvents(
                selectedIds,
                new Date(rangeStart.getTime() - queryPadMs),
                new Date(rangeEnd.getTime() + queryPadMs),
            ),
            signal,
        );
        throwIfAborted(signal);


        let mappedEventIdsByCalendar = new Map<string, Set<string>>();
        try {
            const entries = await withAbortSignal(host.getAllCalendarSyncEntries(platform), signal);
            for (const entry of entries) {
                if (typeof entry.calendarId !== 'string' || !entry.calendarId
                    || typeof entry.calendarEventId !== 'string' || !entry.calendarEventId) continue;
                const ids = mappedEventIdsByCalendar.get(entry.calendarId) ?? new Set<string>();
                ids.add(entry.calendarEventId);
                mappedEventIdsByCalendar.set(entry.calendarId, ids);
            }
        } catch {


            throwIfAborted(signal);
            mappedEventIdsByCalendar = new Map();
        }

        const calendars: ExternalCalendarSubscription[] = selectedCalendars.map((calendar) => ({
            id: getSystemCalendarSourceId(calendar.id),
            name: getDeviceCalendarDisplayName(calendar),
            url: `system://${encodeURIComponent(calendar.id)}`,
            enabled: true,
            areaIds: settings.areaIdsByCalendar?.[calendar.id],


            feedColor: typeof calendar.color === 'string' && calendar.color.trim().length > 0 ? calendar.color : undefined,
        }));

        const events: ExternalCalendarEvent[] = [];
        let mirroredNativeEventCount = 0;
        for (const event of rawEvents) {
            const nativeCalendarId = typeof event.calendarId === 'string' && event.calendarId.trim().length > 0
                ? event.calendarId
                : null;
            const eventCalendarId = nativeCalendarId
                ? nativeCalendarId
                : selectedIds[0];
            if (hasCalendarPushTaskMarker(event.notes)
                || (nativeCalendarId && typeof event.id === 'string'
                    && mappedEventIdsByCalendar.get(nativeCalendarId)?.has(event.id))) {
                mirroredNativeEventCount += 1;
                continue;
            }

            const sourceId = getSystemCalendarSourceId(eventCalendarId);
            const rawStart = toDateSafe(event.startDate);
            if (!rawStart) continue;

            const endCandidate = toDateSafe(event.endDate);
            const rawEnd = endCandidate && endCandidate.getTime() > rawStart.getTime()
                ? endCandidate
                : new Date(rawStart.getTime() + (event.allDay ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000));


            const allDayDates = platform === 'android' && event.allDay === true;
            const start = allDayDates ? toLocalMidnightOfUtcDate(rawStart) : rawStart;
            const end = allDayDates ? toLocalMidnightOfUtcDate(rawEnd) : rawEnd;


            if (end.getTime() <= rangeStart.getTime() || start.getTime() >= rangeEnd.getTime()) continue;
            const startIso = start.toISOString();
            const endIso = end.toISOString();
            const rawTitle = typeof event.title === 'string' ? event.title.trim() : '';
            const eventId = typeof event.id === 'string' && event.id.trim().length > 0 ? event.id : generateUUID();

            events.push({
                id: `${sourceId}:${eventId}:${startIso}`,
                sourceId,
                nativeEventId: eventId,
                title: rawTitle || 'Event',
                start: startIso,
                end: endIso,
                allDay: event.allDay === true,
                description: typeof event.notes === 'string' && event.notes.trim().length > 0 ? event.notes : undefined,
                location: typeof event.location === 'string' && event.location.trim().length > 0 ? event.location : undefined,
            });
        }

        if (mirroredNativeEventCount > 0) {
            void host.logInfo('Mirrored device calendar events excluded', {
                scope: 'calendar',
                extra: {
                    releaseCheck: 'v1.3.1/calendar-mirror-filter',
                    platform,
                    stage: 'native-read',
                    count: String(mirroredNativeEventCount),
                },
            });
        }


        const dayMs = 24 * 60 * 60 * 1000;
        let multiDay = 0;
        let allDay = 0;
        let spanning = 0;
        for (const event of events) {
            const start = new Date(event.start).getTime();
            const end = new Date(event.end).getTime();
            if (end - start > dayMs) multiDay += 1;
            if (event.allDay) allDay += 1;
            if (start < rangeStart.getTime() || end > rangeEnd.getTime()) spanning += 1;
        }
        void host.logInfo('Device calendar events loaded for the window', {
            scope: 'calendar',
            extra: {
                releaseCheck: 'v1.2.7/calendar-spanning-events',
                platform,
                total: String(events.length),
                multiDay: String(multiDay),
                allDay: String(allDay),
                spanning: String(spanning),
            },
        });

        void host.logInfo('Calendar date and color diagnostic snapshot', {
            scope: 'calendar',
            extra: {
                releaseCheck: 'v1.3.1/calendar-date-color-diagnostics',
                platform,
                ...calendarReadDiagnosticCounts(calendars, events),
            },
        });

        return { calendars, events };
    };

    const fetchExternalCalendarEvents = async (
        rangeStart: Date,
        rangeEnd: Date,
        options: ExternalCalendarFetchOptions = {},
    ): Promise<ExternalCalendarSourceResult> => {
        if (isSandboxMode()) return { calendars: [], events: [] };
        const { signal, cleanup } = createLinkedAbortSignal(options.signal, options.timeoutMs);

        try {
            const [icsData, systemData] = await Promise.all([
                fetchIcsCalendarEvents(rangeStart, rangeEnd, signal, options.onFeedError, options.sources),
                fetchSystemCalendarEvents(rangeStart, rangeEnd, signal, options.sources),
            ]);

            return mergeExternalCalendarSources([icsData, systemData]);
        } finally {
            cleanup();
        }
    };

    return {
        getExternalCalendars,
        saveExternalCalendars,
        getSystemCalendarSettings,
        saveSystemCalendarSettings,
        getSystemCalendarPermissionStatus,
        requestSystemCalendarPermission,
        getSystemCalendars,
        fetchExternalCalendarEvents,
        canOpenExternalCalendarEvent: (event: ExternalCalendarEvent) => canOpenExternalCalendarEvent(event, host.platform()),
    };
}
