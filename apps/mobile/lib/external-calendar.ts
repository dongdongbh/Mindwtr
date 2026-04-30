import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import * as Calendar from 'expo-calendar';
import { generateUUID, parseIcs, type ExternalCalendarEvent, type ExternalCalendarSubscription } from '@mindwtr/core';

export const EXTERNAL_CALENDARS_KEY = 'mindwtr-external-calendars';
export const SYSTEM_CALENDAR_SETTINGS_KEY = 'mindwtr-system-calendar-settings';

const SYSTEM_CALENDAR_SOURCE_PREFIX = 'system';
const MINDWTR_CALENDAR_TITLE = 'Mindwtr';
const MINDWTR_CALENDAR_NAME = 'mindwtr';
const MINDWTR_PUSHED_EVENT_PREFIX = 'Mindwtr: ';

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
    const title = getCalendarDisplayName(calendar).trim().toLowerCase();
    const name = typeof calendar.name === 'string' ? calendar.name.trim().toLowerCase() : '';
    return title === MINDWTR_CALENDAR_TITLE.toLowerCase() || name === MINDWTR_CALENDAR_NAME;
}

function isMindwtrPushedEvent(event: Calendar.Event, calendar: Calendar.Calendar | undefined): boolean {
    if (calendar && isMindwtrNamedCalendar(calendar)) return true;
    const title = typeof event.title === 'string' ? event.title.trim() : '';
    return title.toLowerCase().startsWith(MINDWTR_PUSHED_EVENT_PREFIX.toLowerCase());
}

function getSystemCalendarSourceId(calendarId: string): string {
    return `${SYSTEM_CALENDAR_SOURCE_PREFIX}:${calendarId}`;
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
            return parseIcs(text, { sourceId: calendar.id, rangeStart, rangeEnd });
        })
    );

    const events: ExternalCalendarEvent[] = [];
    for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        events.push(...result.value);
    }

    return { calendars, events };
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
    const rawEvents = await withAbortSignal(Calendar.getEventsAsync(selectedIds, rangeStart, rangeEnd), signal);

    const calendars: ExternalCalendarSubscription[] = selectedCalendars.map((calendar) => ({
        id: getSystemCalendarSourceId(calendar.id),
        name: getCalendarDisplayName(calendar),
        url: `system://${encodeURIComponent(calendar.id)}`,
        enabled: true,
    }));

    const events: ExternalCalendarEvent[] = [];
    for (const event of rawEvents) {
        const eventCalendarId = typeof event.calendarId === 'string' && event.calendarId.trim().length > 0
            ? event.calendarId
            : selectedIds[0];
        const eventCalendar = availableById.get(eventCalendarId);
        if (isMindwtrPushedEvent(event, eventCalendar)) continue;

        const sourceId = getSystemCalendarSourceId(eventCalendarId);
        const start = toDateSafe(event.startDate);
        if (!start) continue;

        const endCandidate = toDateSafe(event.endDate);
        const end = endCandidate && endCandidate.getTime() > start.getTime()
            ? endCandidate
            : new Date(start.getTime() + (event.allDay ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000));
        const startIso = start.toISOString();
        const endIso = end.toISOString();
        const rawTitle = typeof event.title === 'string' ? event.title.trim() : '';
        const eventId = typeof event.id === 'string' && event.id.trim().length > 0 ? event.id : generateUUID();

        events.push({
            id: `${sourceId}:${eventId}:${startIso}`,
            sourceId,
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

        const calendarsById = new Map<string, ExternalCalendarSubscription>();
        for (const calendar of [...icsData.calendars, ...systemData.calendars]) {
            calendarsById.set(calendar.id, calendar);
        }

        const events = [...icsData.events, ...systemData.events].sort((a, b) => {
            if (a.start === b.start) return a.title.localeCompare(b.title);
            return a.start.localeCompare(b.start);
        });

        return {
            calendars: Array.from(calendarsById.values()),
            events,
        };
    } finally {
        cleanup();
    }
}
