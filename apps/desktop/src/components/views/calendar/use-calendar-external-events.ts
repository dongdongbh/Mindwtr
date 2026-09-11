/**
 * Subscribed (read-only) calendars: fetching the events for the visible range,
 * bucketing them per day, remembering which calendars the user hid, and
 * resolving each source's colour.
 *
 * Hidden calendars are a local display preference, not synced state — they live
 * in localStorage under one key.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    isSandboxMode,
    resolveExternalCalendarColor,
    safeParseDate,
    themeExternalCalendarDisplayColor,
    useTaskStore,
    type ExternalCalendarEvent,
    type ExternalCalendarSubscription,
} from '@mindwtr/core';

import { logError } from '../../../lib/app-log';
import { fetchExternalCalendarEvents, summarizeExternalCalendarWarnings } from '../../../lib/external-calendar-events';
import { dayKey } from './calendar-primitives';
import { getWorkspaceCache } from '../../../lib/workspace-cache';

const HIDDEN_EXTERNAL_CALENDAR_IDS_STORAGE_KEY = 'mindwtr.calendar.hiddenExternalCalendars';

/**
 * User pick > feed-provided color > deterministic palette hash (#974), then a
 * display-only theme remap — the resolved value is canonical, `theme` only
 * decides which hex it is painted as.
 */
export const defaultExternalCalendarColor = (sourceId: string, override?: string, feedColor?: string, theme?: string): string => (
    themeExternalCalendarDisplayColor(resolveExternalCalendarColor(sourceId, override, feedColor), theme)
);

const serializeHiddenExternalCalendarIds = (ids: Iterable<string>): string => (
    JSON.stringify([...ids].sort())
);

const readHiddenExternalCalendarIds = (): { serialized: string; value: Set<string> } => {
    if (typeof window === 'undefined') {
        return { serialized: '[]', value: new Set() };
    }

    try {
        const raw = getWorkspaceCache()?.getItem(HIDDEN_EXTERNAL_CALENDAR_IDS_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        const ids = Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
        return { serialized: serializeHiddenExternalCalendarIds(ids), value: new Set(ids) };
    } catch {
        return { serialized: '[]', value: new Set() };
    }
};

const eventDayRangeForVisibleRange = (
    event: ExternalCalendarEvent,
    visibleRange: { end: Date; start: Date },
): { end: Date; start: Date } | null => {
    const start = safeParseDate(event.start);
    const end = safeParseDate(event.end);
    if (!start || !end) return null;

    const lastMoment = new Date(Math.max(start.getTime(), end.getTime() - 1));
    const eventStartDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const eventEndDay = new Date(lastMoment.getFullYear(), lastMoment.getMonth(), lastMoment.getDate());
    const visibleStartDay = new Date(visibleRange.start.getFullYear(), visibleRange.start.getMonth(), visibleRange.start.getDate());
    const visibleEndDay = new Date(visibleRange.end.getFullYear(), visibleRange.end.getMonth(), visibleRange.end.getDate());
    const clampedStart = new Date(Math.max(eventStartDay.getTime(), visibleStartDay.getTime()));
    const clampedEnd = new Date(Math.min(eventEndDay.getTime(), visibleEndDay.getTime()));

    if (clampedStart.getTime() > clampedEnd.getTime()) return null;
    return { start: clampedStart, end: clampedEnd };
};

export type CalendarExternalEventsOptions = {
    /** Already normalized (trimmed, lower-cased); empty means "no filter". */
    filterQuery: string;
    visibleRange: { end: Date; start: Date };
};

export function useCalendarExternalEvents({ filterQuery, visibleRange }: CalendarExternalEventsOptions) {
    const sandboxMode = isSandboxMode();
    const theme = useTaskStore((state) => state.settings?.theme);
    const [externalCalendars, setExternalCalendars] = useState<ExternalCalendarSubscription[]>([]);
    const [externalEvents, setExternalEvents] = useState<ExternalCalendarEvent[]>([]);
    const hiddenExternalCalendarIdsStorageRef = useRef<string | null>(null);
    const [hiddenExternalCalendarIds, setHiddenExternalCalendarIds] = useState<Set<string>>(() => {
        const { serialized, value } = readHiddenExternalCalendarIds();
        hiddenExternalCalendarIdsStorageRef.current = serialized;
        return value;
    });
    const [externalError, setExternalError] = useState<string | null>(null);
    const [isExternalLoading, setIsExternalLoading] = useState(false);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const serialized = serializeHiddenExternalCalendarIds(hiddenExternalCalendarIds);
        if (hiddenExternalCalendarIdsStorageRef.current === serialized) return;
        hiddenExternalCalendarIdsStorageRef.current = serialized;
        getWorkspaceCache()?.setItem(HIDDEN_EXTERNAL_CALENDAR_IDS_STORAGE_KEY, serialized);
    }, [hiddenExternalCalendarIds]);

    useEffect(() => {
        if (sandboxMode) {
            setExternalCalendars([]);
            setExternalEvents([]);
            setExternalError(null);
            setIsExternalLoading(false);
            return;
        }
        let cancelled = false;

        const load = async () => {
            setIsExternalLoading(true);
            setExternalError(null);
            try {
                const rangeStart = new Date(visibleRange.start);
                rangeStart.setHours(0, 0, 0, 0);
                const rangeEnd = new Date(visibleRange.end);
                rangeEnd.setHours(23, 59, 59, 999);
                const { calendars, events, warnings } = await fetchExternalCalendarEvents(rangeStart, rangeEnd);
                if (cancelled) return;
                setExternalCalendars(calendars);
                setExternalEvents(events);
                setExternalError(summarizeExternalCalendarWarnings(warnings));
            } catch (error) {
                if (cancelled) return;
                const message = error instanceof Error && error.message.trim()
                    ? error.message.trim()
                    : 'Failed to load external calendars.';
                void logError(error, { scope: 'calendar', step: 'loadExternalCalendars' });
                setExternalError(message);
                setExternalEvents([]);
            } finally {
                if (!cancelled) {
                    setIsExternalLoading(false);
                }
            }
        };

        load();

        return () => {
            cancelled = true;
        };
    }, [sandboxMode, visibleRange]);

    const calendarNameById = useMemo(() => new Map(externalCalendars.map((c) => [c.id, c.name])), [externalCalendars]);
    const calendarColorById = useMemo(
        () => new Map(externalCalendars.map((c) => [c.id, defaultExternalCalendarColor(c.id, c.color, c.feedColor, theme)])),
        [externalCalendars, theme]
    );
    const getExternalCalendarColor = useCallback(
        (sourceId: string) => calendarColorById.get(sourceId) ?? defaultExternalCalendarColor(sourceId, undefined, undefined, theme),
        [calendarColorById, theme]
    );

    const visibleExternalEvents = useMemo(
        () => externalEvents.filter((event) => {
            if (hiddenExternalCalendarIds.has(event.sourceId)) return false;
            if (!filterQuery) return true;
            const sourceName = calendarNameById.get(event.sourceId) ?? '';
            return event.title.toLowerCase().includes(filterQuery)
                || sourceName.toLowerCase().includes(filterQuery);
        }),
        [calendarNameById, externalEvents, hiddenExternalCalendarIds, filterQuery]
    );

    const externalEventsByDay = useMemo(() => {
        const nextMap = new Map<string, ExternalCalendarEvent[]>();
        for (const event of visibleExternalEvents) {
            const dayRange = eventDayRangeForVisibleRange(event, visibleRange);
            if (!dayRange) continue;

            const cursor = new Date(dayRange.start);
            while (cursor.getTime() <= dayRange.end.getTime()) {
                const key = dayKey(cursor);
                const existing = nextMap.get(key);
                if (existing) existing.push(event);
                else nextMap.set(key, [event]);
                cursor.setDate(cursor.getDate() + 1);
            }
        }
        return nextMap;
    }, [visibleExternalEvents, visibleRange]);

    const getExternalEventsForDay = useCallback(
        (date: Date) => externalEventsByDay.get(dayKey(date)) ?? [],
        [externalEventsByDay]
    );

    const toggleExternalCalendar = (calendarId: string) => {
        setHiddenExternalCalendarIds((prev) => {
            const next = new Set(prev);
            if (next.has(calendarId)) next.delete(calendarId);
            else next.add(calendarId);
            return next;
        });
    };

    return {
        calendarNameById,
        externalCalendars,
        externalError,
        getExternalCalendarColor,
        getExternalEventsForDay,
        hiddenExternalCalendarIds,
        isExternalLoading,
        toggleExternalCalendar,
        visibleExternalEvents,
    };
}

export type CalendarExternalEvents = ReturnType<typeof useCalendarExternalEvents>;
