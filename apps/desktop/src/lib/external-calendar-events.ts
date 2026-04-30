import { parseIcs, type ExternalCalendarEvent, type ExternalCalendarSubscription } from '@mindwtr/core';
import { ExternalCalendarService } from './external-calendar-service';
import { isTauriRuntime } from './runtime';
import { fetchSystemCalendarEvents } from './system-calendar';

const MINDWTR_PUSHED_EVENT_PREFIX = 'Mindwtr: ';
const MINDWTR_MIRROR_CALENDAR_NAMES = new Set(['mindwtr', 'mindwtr calendar', 'mindwtrcal']);
const ICS_MONTH_CACHE_TTL_MS = 5 * 60 * 1000;
const ICS_MONTH_CACHE_MAX_ENTRIES = 120;

type IcsMonthCacheEntry = {
    events: ExternalCalendarEvent[];
    expiresAt: number;
    lastAccessedAt: number;
};

type MonthRange = {
    end: Date;
    key: string;
    start: Date;
};

const icsMonthCache = new Map<string, IcsMonthCacheEntry>();

export const summarizeExternalCalendarWarnings = (warnings: string[]): string | null => {
    if (warnings.length === 0) return null;
    if (warnings.length === 1) return warnings[0];
    return `${warnings[0]} (+${warnings.length - 1} more)`;
};

function normalizeCalendarName(value: string | undefined): string {
    return (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function getMonthKey(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function getVisibleMonthRanges(rangeStart: Date, rangeEnd: Date): MonthRange[] {
    const ranges: MonthRange[] = [];
    const cursor = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1);
    const inclusiveEnd = rangeEnd > rangeStart ? new Date(rangeEnd.getTime() - 1) : rangeStart;
    const last = new Date(inclusiveEnd.getFullYear(), inclusiveEnd.getMonth(), 1);

    while (cursor <= last) {
        const start = new Date(cursor);
        const end = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
        ranges.push({ key: getMonthKey(start), start, end });
        cursor.setMonth(cursor.getMonth() + 1);
    }
    return ranges;
}

function getIcsCacheKey(calendar: ExternalCalendarSubscription, monthKey: string): string {
    return `${calendar.id}:${calendar.url}:${monthKey}`;
}

function pruneIcsMonthCache(): void {
    while (icsMonthCache.size > ICS_MONTH_CACHE_MAX_ENTRIES) {
        let oldestKey: string | null = null;
        let oldestAccessedAt = Number.POSITIVE_INFINITY;
        for (const [key, entry] of icsMonthCache.entries()) {
            if (entry.lastAccessedAt < oldestAccessedAt) {
                oldestAccessedAt = entry.lastAccessedAt;
                oldestKey = key;
            }
        }
        if (!oldestKey) return;
        icsMonthCache.delete(oldestKey);
    }
}

function eventOverlapsRange(event: ExternalCalendarEvent, rangeStart: Date, rangeEnd: Date): boolean {
    const startMs = Date.parse(event.start);
    const endMs = Date.parse(event.end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return false;
    return startMs < rangeEnd.getTime() && endMs > rangeStart.getTime();
}

function dedupeEvents(events: ExternalCalendarEvent[]): ExternalCalendarEvent[] {
    const byKey = new Map<string, ExternalCalendarEvent>();
    for (const event of events) {
        byKey.set(`${event.sourceId}:${event.id}:${event.start}:${event.end}`, event);
    }
    return Array.from(byKey.values());
}

async function loadCachedIcsEventsForCalendar(
    calendar: ExternalCalendarSubscription,
    monthRanges: MonthRange[],
    rangeStart: Date,
    rangeEnd: Date,
): Promise<ExternalCalendarEvent[]> {
    const now = Date.now();
    const events: ExternalCalendarEvent[] = [];
    const missingRanges: MonthRange[] = [];

    for (const monthRange of monthRanges) {
        const cacheKey = getIcsCacheKey(calendar, monthRange.key);
        const cached = icsMonthCache.get(cacheKey);
        if (cached && cached.expiresAt > now) {
            cached.lastAccessedAt = now;
            events.push(...cached.events.filter((event) => eventOverlapsRange(event, rangeStart, rangeEnd)));
            continue;
        }
        if (cached) icsMonthCache.delete(cacheKey);
        missingRanges.push(monthRange);
    }

    if (missingRanges.length === 0) {
        return events;
    }

    const text = await fetchTextWithTimeout(calendar.url, 15_000);
    for (const monthRange of missingRanges) {
        const parsed = parseIcs(text, {
            sourceId: calendar.id,
            rangeStart: monthRange.start,
            rangeEnd: monthRange.end,
        });
        icsMonthCache.set(getIcsCacheKey(calendar, monthRange.key), {
            events: parsed,
            expiresAt: now + ICS_MONTH_CACHE_TTL_MS,
            lastAccessedAt: now,
        });
        events.push(...parsed.filter((event) => eventOverlapsRange(event, rangeStart, rangeEnd)));
    }
    pruneIcsMonthCache();
    return events;
}

export function isMindwtrMirrorCalendar(calendar: Pick<ExternalCalendarSubscription, 'name'>): boolean {
    return MINDWTR_MIRROR_CALENDAR_NAMES.has(normalizeCalendarName(calendar.name));
}

export function isMindwtrMirrorEvent(
    event: Pick<ExternalCalendarEvent, 'sourceId' | 'title'>,
    calendarById: Map<string, ExternalCalendarSubscription>,
): boolean {
    const sourceCalendar = calendarById.get(event.sourceId);
    if (sourceCalendar && isMindwtrMirrorCalendar(sourceCalendar)) return true;
    return event.title.trim().toLowerCase().startsWith(MINDWTR_PUSHED_EVENT_PREFIX.toLowerCase());
}

async function fetchTextWithTimeout(url: string, timeoutMs: number): Promise<string> {
    if (isTauriRuntime()) {
        const mod: any = await import('@tauri-apps/plugin-http');
        const tauriFetch: any = mod.fetch;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await tauriFetch(url, { method: 'GET', signal: controller.signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.text();
        } finally {
            clearTimeout(timeout);
        }
    }

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
        const res = await fetch(url, controller ? { signal: controller.signal } : undefined);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

export async function fetchExternalCalendarEvents(
    rangeStart: Date,
    rangeEnd: Date,
): Promise<{
    calendars: ExternalCalendarSubscription[];
    events: ExternalCalendarEvent[];
    warnings: string[];
}> {
    const calendars = await ExternalCalendarService.getCalendars();
    const importableCalendars = calendars.filter((calendar) => !isMindwtrMirrorCalendar(calendar));
    const enabled = importableCalendars.filter((calendar) => calendar.enabled);
    const monthRanges = getVisibleMonthRanges(rangeStart, rangeEnd);

    const [icsResults, systemResults] = await Promise.all([
        Promise.allSettled(
            enabled.map((calendar) => loadCachedIcsEventsForCalendar(calendar, monthRanges, rangeStart, rangeEnd))
        ),
        fetchSystemCalendarEvents(rangeStart, rangeEnd),
    ]);

    const calendarById = new Map<string, ExternalCalendarSubscription>();
    for (const calendar of [...calendars, ...systemResults.calendars]) {
        calendarById.set(calendar.id, calendar);
    }
    const systemCalendars = systemResults.calendars.filter((calendar) => !isMindwtrMirrorCalendar(calendar));

    const events: ExternalCalendarEvent[] = systemResults.events
        .filter((event) => !isMindwtrMirrorEvent(event, calendarById));
    const warnings: string[] = [];
    for (const [index, result] of icsResults.entries()) {
        if (result.status !== 'fulfilled') {
            const calendar = enabled[index];
            const label = (calendar?.name || calendar?.url || 'Unnamed calendar').trim();
            const detail = result.reason instanceof Error ? result.reason.message : String(result.reason ?? 'Unknown error');
            warnings.push(`Failed to load "${label}": ${detail}`);
            continue;
        }
        events.push(...result.value.filter((event) => !isMindwtrMirrorEvent(event, calendarById)));
    }

    const mergedCalendars = [...importableCalendars];
    const existingIds = new Set(mergedCalendars.map((calendar) => calendar.id));
    for (const systemCalendar of systemCalendars) {
        if (existingIds.has(systemCalendar.id)) continue;
        existingIds.add(systemCalendar.id);
        mergedCalendars.push(systemCalendar);
    }

    const dedupedEvents = dedupeEvents(events);
    dedupedEvents.sort((a, b) => {
        if (a.start === b.start) return a.title.localeCompare(b.title);
        return a.start.localeCompare(b.start);
    });

    return { calendars: mergedCalendars, events: dedupedEvents, warnings };
}

export const __externalCalendarEventsTestUtils = {
    clearCache: () => icsMonthCache.clear(),
};
