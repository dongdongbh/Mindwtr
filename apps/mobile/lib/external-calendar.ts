import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import * as Calendar from 'expo-calendar';
import {
    expandCategoryCalendars,
    generateUUID,
    isMindwtrMirrorCalendar,
    mergeExternalCalendarSources,
    normalizeExternalCalendarColor,
    parseIcsWithMetadata,
    type ExternalCalendarEvent,
    type ExternalCalendarSourceResult,
    type ExternalCalendarSubscription,
} from '@mindwtr/core';
import * as FileSystem from './file-system';

export const EXTERNAL_CALENDARS_KEY = 'mindwtr-external-calendars';
export const SYSTEM_CALENDAR_SETTINGS_KEY = 'mindwtr-system-calendar-settings';

const SYSTEM_CALENDAR_SOURCE_PREFIX = 'system';

export type SystemCalendarPermissionStatus = 'undetermined' | 'granted' | 'denied';

export interface SystemCalendarSettings {
    enabled: boolean;
    selectAll: boolean;
    selectedCalendarIds: string[];
}

export interface SystemCalendarInfo {
    id: string;
    name: string;
    color?: string;
}

type ExternalCalendarFetchOptions = {
    signal?: AbortSignal;
    timeoutMs?: number;
};

function isLocalCalendarSourceUrl(url: string): boolean {
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

function normalizeSystemCalendarSettings(raw: Partial<SystemCalendarSettings> | null): SystemCalendarSettings {
    const enabled = raw?.enabled === true;
    const selectAll = raw?.selectAll !== false;
    const selectedCalendarIds = Array.isArray(raw?.selectedCalendarIds)
        ? Array.from(
            new Set(
                raw.selectedCalendarIds
                    .filter((id): id is string => typeof id === 'string')
                    .map((id) => id.trim())
                    .filter((id) => id.length > 0)
            )
        )
        : [];

    return {
        enabled,
        selectAll,
        selectedCalendarIds: selectAll ? [] : selectedCalendarIds,
    };
}

function normalizePermissionStatus(status: unknown): SystemCalendarPermissionStatus {
    if (status === 'granted' || status === 'denied' || status === 'undetermined') {
        return status;
    }
    return 'denied';
}

function getCalendarDisplayName(calendar: Calendar.Calendar): string {
    const rawTitle = calendar.title;
    const legacyName = (calendar as Calendar.Calendar & { name?: string }).name;
    const preferred = typeof rawTitle === 'string' && rawTitle.trim().length > 0
        ? rawTitle
        : typeof legacyName === 'string' && legacyName.trim().length > 0
            ? legacyName
            : 'Calendar';
    return preferred.trim() || 'Calendar';
}

function isMindwtrNamedCalendar(calendar: Calendar.Calendar): boolean {
    if (isMindwtrMirrorCalendar({ name: getCalendarDisplayName(calendar) })) {
        return true;
    }
    return typeof calendar.name === 'string'
        && isMindwtrMirrorCalendar({ name: calendar.name });
}

function getSystemCalendarSourceId(calendarId: string): string {
    return `${SYSTEM_CALENDAR_SOURCE_PREFIX}:${calendarId}`;
}

export function canOpenExternalCalendarEvent(event: ExternalCalendarEvent): boolean {
    return Platform.OS !== 'web'
        && event.sourceId.startsWith(`${SYSTEM_CALENDAR_SOURCE_PREFIX}:`)
        && typeof event.nativeEventId === 'string'
        && event.nativeEventId.trim().length > 0;
}

export async function openExternalCalendarEvent(event: ExternalCalendarEvent): Promise<boolean> {
    if (!canOpenExternalCalendarEvent(event)) return false;

    const params = {
        id: event.nativeEventId as string,
        instanceStartDate: event.start,
    };

    if (typeof Calendar.editEventInCalendarAsync === 'function') {
        await Calendar.editEventInCalendarAsync(params, { startNewActivityTask: Platform.OS === 'android' });
        return true;
    }

    if (typeof Calendar.openEventInCalendarAsync === 'function') {
        await Calendar.openEventInCalendarAsync(params, {
            allowsEditing: true,
            startNewActivityTask: Platform.OS === 'android',
        });
        return true;
    }

    return false;
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

export async function getExternalCalendars(): Promise<ExternalCalendarSubscription[]> {
    const raw = await AsyncStorage.getItem(EXTERNAL_CALENDARS_KEY);
    const parsed = safeJsonParse<ExternalCalendarSubscription[]>(raw, []);
    return parsed
        .filter((c) => c && typeof c.url === 'string')
        .map((c) => ({
            id: c.id || generateUUID(),
            name: (c.name || 'Calendar').trim() || 'Calendar',
            url: c.url.trim(),
            enabled: c.enabled !== false,
            color: normalizeExternalCalendarColor(c.color),
        }))
        .filter((c) => c.url.length > 0);
}

export async function saveExternalCalendars(calendars: ExternalCalendarSubscription[]): Promise<void> {
    const sanitized = calendars
        .map((c) => ({
            id: c.id || generateUUID(),
            name: (c.name || 'Calendar').trim() || 'Calendar',
            url: (c.url || '').trim(),
            enabled: c.enabled !== false,
            color: normalizeExternalCalendarColor(c.color),
        }))
        .filter((c) => c.url.length > 0);
    await AsyncStorage.setItem(EXTERNAL_CALENDARS_KEY, JSON.stringify(sanitized));
}

export async function getSystemCalendarSettings(): Promise<SystemCalendarSettings> {
    const raw = await AsyncStorage.getItem(SYSTEM_CALENDAR_SETTINGS_KEY);
    const parsed = safeJsonParse<Partial<SystemCalendarSettings> | null>(raw, null);
    return normalizeSystemCalendarSettings(parsed);
}

export async function saveSystemCalendarSettings(settings: SystemCalendarSettings): Promise<void> {
    const sanitized = normalizeSystemCalendarSettings(settings);
    await AsyncStorage.setItem(SYSTEM_CALENDAR_SETTINGS_KEY, JSON.stringify(sanitized));
}

export async function getSystemCalendarPermissionStatus(): Promise<SystemCalendarPermissionStatus> {
    if (Platform.OS === 'web') return 'denied';
    try {
        const result = await Calendar.getCalendarPermissionsAsync();
        return normalizePermissionStatus(result.status);
    } catch {
        return 'denied';
    }
}

export async function requestSystemCalendarPermission(): Promise<SystemCalendarPermissionStatus> {
    if (Platform.OS === 'web') return 'denied';
    try {
        const result = await Calendar.requestCalendarPermissionsAsync();
        return normalizePermissionStatus(result.status);
    } catch {
        return 'denied';
    }
}

export async function getSystemCalendars(): Promise<SystemCalendarInfo[]> {
    if (Platform.OS === 'web') return [];
    const permission = await getSystemCalendarPermissionStatus();
    if (permission !== 'granted') return [];

    try {
        const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
        return calendars
            .filter((calendar) => typeof calendar.id === 'string' && calendar.id.trim().length > 0)
            .filter((calendar) => !isMindwtrNamedCalendar(calendar))
            .map((calendar) => ({
                id: calendar.id,
                name: getCalendarDisplayName(calendar),
                color: typeof calendar.color === 'string' && calendar.color.trim().length > 0 ? calendar.color : undefined,
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
        return [];
    }
}

async function fetchTextWithTimeout(url: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
    if (isLocalCalendarSourceUrl(url)) {
        throwIfAborted(signal);
        const text = url.trim().toLowerCase().startsWith('content://')
            ? await FileSystem.StorageAccessFramework.readAsStringAsync(url)
            : await FileSystem.readAsStringAsync(url);
        throwIfAborted(signal);
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
        const res = await fetch(url, controller ? { signal: controller.signal } : undefined);
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
        return await res.text();
    } finally {
        if (timeout) clearTimeout(timeout);
        if (signal && onAbort) {
            signal.removeEventListener('abort', onAbort);
        }
    }
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

async function fetchIcsCalendarEvents(rangeStart: Date, rangeEnd: Date, signal?: AbortSignal): Promise<{
    calendars: ExternalCalendarSubscription[];
    events: ExternalCalendarEvent[];
}> {
    throwIfAborted(signal);
    const calendars = await getExternalCalendars();
    const enabled = calendars.filter((c) => c.enabled);

    const results = await Promise.allSettled(
        enabled.map(async (calendar) => {
            const text = await fetchTextWithTimeout(calendar.url, 15_000, signal);
            return parseIcsWithMetadata(text, {
                sourceId: calendar.id,
                rangeStart,
                rangeEnd,
                splitByCategory: true,
            });
        })
    );

    // A feed split by CATEGORIES is represented by its category calendars, so
    // the subscription itself drops out of the visible list once nothing is
    // left on it. `contributed` also carries the parent's `feedColor` when
    // the feed wasn't split — it must win over the raw persisted entry
    // (which never carries `feedColor`), so it's merged in as a later
    // source rather than dropped, the same way desktop does it.
    const splitCalendarIds = new Set<string>();
    const icsSources: ExternalCalendarSourceResult[] = [];
    for (const [index, result] of results.entries()) {
        if (result.status !== 'fulfilled') continue;
        const calendar = enabled[index];
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
}

async function fetchSystemCalendarEvents(rangeStart: Date, rangeEnd: Date, signal?: AbortSignal): Promise<{
    calendars: ExternalCalendarSubscription[];
    events: ExternalCalendarEvent[];
}> {
    throwIfAborted(signal);
    if (Platform.OS === 'web') {
        return { calendars: [], events: [] };
    }

    const settings = await getSystemCalendarSettings();
    if (!settings.enabled) {
        return { calendars: [], events: [] };
    }

    const permission = await getSystemCalendarPermissionStatus();
    if (permission !== 'granted') {
        return { calendars: [], events: [] };
    }

    const rawCalendars = await withAbortSignal(Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT), signal);
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
        .filter((calendar): calendar is Calendar.Calendar => Boolean(calendar));
    if (selectedCalendars.length === 0) {
        return { calendars: [], events: [] };
    }

    const selectedIds = selectedCalendars.map((calendar) => calendar.id);
    // expo-calendar's Android query selects `Instances.BEGIN >= start AND Instances.END <= end`
    // (expo-calendar/android/.../CalendarModule.kt `findEvents`), i.e. only events *contained* in
    // the window. A multi-day event that crosses either edge — the classic one spanning a month
    // boundary — is dropped by the provider before we ever see it (#1134). iOS uses
    // `predicateForEvents`, which already matches on overlap. So widen the Android query and clip
    // to the requested window below, the same overlap rule the .ics path uses (core `ics.ts`).
    // ponytail: fixed 92-day pad; an event hanging more than a quarter past an edge is still
    // missed. Proper fix is our own CalendarContract.Instances query in native code.
    const queryPadMs = Platform.OS === 'android' ? 92 * 24 * 60 * 60 * 1000 : 0;
    const rawEvents = await withAbortSignal(
        Calendar.getEventsAsync(
            selectedIds,
            new Date(rangeStart.getTime() - queryPadMs),
            new Date(rangeEnd.getTime() + queryPadMs),
        ),
        signal,
    );

    const calendars: ExternalCalendarSubscription[] = selectedCalendars.map((calendar) => ({
        id: getSystemCalendarSourceId(calendar.id),
        name: getCalendarDisplayName(calendar),
        url: `system://${encodeURIComponent(calendar.id)}`,
        enabled: true,
        // The OS calendar's own color, resolved as a feed hint (#974) — never
        // an explicit pick, so it never gets written into synced settings.
        feedColor: typeof calendar.color === 'string' && calendar.color.trim().length > 0 ? calendar.color : undefined,
    }));

    const events: ExternalCalendarEvent[] = [];
    for (const event of rawEvents) {
        const eventCalendarId = typeof event.calendarId === 'string' && event.calendarId.trim().length > 0
            ? event.calendarId
            : selectedIds[0];

        const sourceId = getSystemCalendarSourceId(eventCalendarId);
        const rawStart = toDateSafe(event.startDate);
        if (!rawStart) continue;

        const endCandidate = toDateSafe(event.endDate);
        const rawEnd = endCandidate && endCandidate.getTime() > rawStart.getTime()
            ? endCandidate
            : new Date(rawStart.getTime() + (event.allDay ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000));

        // An all-day event's bounds are calendar dates, not instants. Android's provider stores
        // them as UTC midnight (CalendarContract requires it) and expo-calendar formats them with a
        // GMT formatter, so east of UTC they read back as mid-day and paint an extra day, west of
        // UTC they slide a day earlier (#1133). Re-read the date parts in UTC and rebuild local
        // midnights — the exact shape the .ics path produces (core `ics.ts` parses a DATE value as
        // local midnight, with DTEND left exclusive), so day projection needs no platform knowledge.
        // iOS already hands back local all-day bounds, so it must not be shifted.
        const allDayDates = Platform.OS === 'android' && event.allDay === true;
        const start = allDayDates ? toLocalMidnightOfUtcDate(rawStart) : rawStart;
        const end = allDayDates ? toLocalMidnightOfUtcDate(rawEnd) : rawEnd;
        // Overlap, not containment: an event that starts before the window or ends after it still
        // belongs to it. Never stricter than the native query, so nothing that loaded before drops.
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

    return { calendars, events };
}

export async function fetchExternalCalendarEvents(
    rangeStart: Date,
    rangeEnd: Date,
    options: ExternalCalendarFetchOptions = {},
): Promise<{
    calendars: ExternalCalendarSubscription[];
    events: ExternalCalendarEvent[];
}> {
    const { signal, cleanup } = createLinkedAbortSignal(options.signal, options.timeoutMs);

    try {
        const [icsData, systemData] = await Promise.all([
            fetchIcsCalendarEvents(rangeStart, rangeEnd, signal),
            fetchSystemCalendarEvents(rangeStart, rangeEnd, signal),
        ]);

        return mergeExternalCalendarSources([icsData, systemData]);
    } finally {
        cleanup();
    }
}
