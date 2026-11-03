


import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    isSandboxMode,
    filterCalendarEventsForAreas,
    resolveExternalCalendarColor,
    safeParseDate,
    themeExternalCalendarDisplayColor,
    useTaskStore,
    type ExternalCalendarEvent,
    type ExternalCalendarSubscription,
    type Area,
    type AreaFilterSelection,
} from '@mindwtr/core';

import { logError, logInfo } from '../../../lib/app-log';
import { fetchExternalCalendarEvents, summarizeExternalCalendarWarnings } from '../../../lib/external-calendar-events';
import { dayKey } from './calendar-primitives';
import { getWorkspaceCache } from '../../../lib/workspace-cache';

const HIDDEN_EXTERNAL_CALENDAR_IDS_STORAGE_KEY = 'mindwtr.calendar.hiddenExternalCalendars';


export const defaultExternalCalendarColor = (sourceId: string, override?: string, feedColor?: string, theme?: string): string => (
    themeExternalCalendarDisplayColor(resolveExternalCalendarColor(sourceId, override, feedColor), theme)
);

const serializeHiddenExternalCalendarIds = (ids: Iterable<string>): string => (
    JSON.stringify([...ids].sort())
);

export const readHiddenExternalCalendarIds = (): { serialized: string; value: Set<string> } => {
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


export const filterVisibleReviewCalendarEvents = (
    events: readonly ExternalCalendarEvent[],
    calendars: readonly ExternalCalendarSubscription[],
): ExternalCalendarEvent[] => {
    const hiddenIds = readHiddenExternalCalendarIds().value;
    return filterCalendarEventsForAreas(events, calendars, { included: [], excluded: [] }, [])
        .filter((event) => !hiddenIds.has(event.sourceId));
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

    filterQuery: string;
    visibleRange: { end: Date; start: Date };
    areas?: Area[];
    areaSelection?: AreaFilterSelection;
};

export function useCalendarExternalEvents({ filterQuery, visibleRange, areas = [], areaSelection }: CalendarExternalEventsOptions) {
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

    const enabledExternalEvents = useMemo(
        () => externalEvents.filter((event) => externalCalendars.find((calendar) => calendar.id === event.sourceId)?.enabled !== false),
        [externalCalendars, externalEvents]
    );
    const visibleExternalEvents = useMemo(
        () => filterCalendarEventsForAreas(enabledExternalEvents, externalCalendars, areaSelection ?? { included: [], excluded: [] }, areas).filter((event) => {
            if (hiddenExternalCalendarIds.has(event.sourceId)) return false;
            if (!filterQuery) return true;
            const sourceName = calendarNameById.get(event.sourceId) ?? '';
            return event.title.toLowerCase().includes(filterQuery)
                || sourceName.toLowerCase().includes(filterQuery);
        }),
        [areas, areaSelection, calendarNameById, enabledExternalEvents, externalCalendars, hiddenExternalCalendarIds, filterQuery]
    );
    useEffect(() => {
        if (!areaSelection || (areaSelection.included.length === 0 && areaSelection.excluded.length === 0)) return;
        if (!externalCalendars.some((calendar) => calendar.areaIds?.length)) return;
        void logInfo('Calendar Area associations applied to display', {
            scope: 'calendar', extra: { releaseCheck: 'v1.3.3/calendar-areas' },
        });
    }, [areaSelection, externalCalendars, visibleExternalEvents]);

    const indexEvents = (events: ExternalCalendarEvent[]) => {
        const nextMap = new Map<string, ExternalCalendarEvent[]>();
        for (const event of events) {
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
    };
    const externalEventsByDay = useMemo(() => indexEvents(visibleExternalEvents), [visibleExternalEvents, visibleRange]);
    const availabilityEventsByDay = useMemo(() => indexEvents(enabledExternalEvents), [enabledExternalEvents, visibleRange]);

    const getExternalEventsForDay = useCallback(
        (date: Date) => externalEventsByDay.get(dayKey(date)) ?? [],
        [externalEventsByDay]
    );
    const getAvailabilityEventsForDay = useCallback(
        (date: Date) => availabilityEventsByDay.get(dayKey(date)) ?? [],
        [availabilityEventsByDay]
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
        getAvailabilityEventsForDay,
        hiddenExternalCalendarIds,
        isExternalLoading,
        toggleExternalCalendar,
        visibleExternalEvents,
    };
}

export type CalendarExternalEvents = ReturnType<typeof useCalendarExternalEvents>;
