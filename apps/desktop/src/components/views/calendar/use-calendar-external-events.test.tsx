import { act, renderHook, waitFor } from '@testing-library/react';
import { getExternalCalendarColorForId, isCalendarSlotFree, type Area, type ExternalCalendarEvent } from '@mindwtr/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchExternalCalendarEvents } from '../../../lib/external-calendar-events';
import { dayKey } from './calendar-primitives';
import { defaultExternalCalendarColor, useCalendarExternalEvents } from './use-calendar-external-events';

vi.mock('../../../lib/external-calendar-events', () => ({
    fetchExternalCalendarEvents: vi.fn(async () => ({ calendars: [], events: [], warnings: [] })),
    summarizeExternalCalendarWarnings: (warnings: string[]) => {
        if (warnings.length === 0) return null;
        if (warnings.length === 1) return warnings[0];
        return `${warnings[0]} (+${warnings.length - 1} more)`;
    },
}));

const HIDDEN_KEY = 'mindwtr.calendar.hiddenExternalCalendars';

const APRIL = { start: new Date(2026, 3, 1), end: new Date(2026, 3, 30) };

const makeEvent = (overrides: Partial<ExternalCalendarEvent> = {}): ExternalCalendarEvent => ({
    id: 'event-1',
    sourceId: 'work',
    title: 'Launch window',
    start: '2026-04-03T09:00:00',
    end: '2026-04-03T10:00:00',
    allDay: false,
    ...overrides,
});

const renderExternalEvents = (filterQuery = '', visibleRange = APRIL) => renderHook(
    ({ query, range }: { query: string; range: typeof APRIL }) => useCalendarExternalEvents({
        filterQuery: query,
        visibleRange: range,
    }),
    { initialProps: { query: filterQuery, range: visibleRange } }
);

describe('useCalendarExternalEvents', () => {
    beforeEach(() => {
        window.localStorage.clear();
        vi.mocked(fetchExternalCalendarEvents).mockClear();
        vi.mocked(fetchExternalCalendarEvents).mockResolvedValue({ calendars: [], events: [], warnings: [] });
    });

    afterEach(() => {
        window.localStorage.clear();
    });

    it('keeps an Area-hidden appointment busy for the schedule caller', async () => {
        vi.mocked(fetchExternalCalendarEvents).mockResolvedValue({
            calendars: [{ id: 'work', name: 'Work', url: 'https://calendar.example/work', enabled: true, areaIds: ['work-area'] }],
            events: [makeEvent()], warnings: [],
        });
        const { result } = renderHook(() => useCalendarExternalEvents({
            filterQuery: '', visibleRange: APRIL,
            areas: [{ id: 'work-area' }, { id: 'home-area' }] as Area[],
            areaSelection: { included: ['home-area'], excluded: [] },
        }));
        await waitFor(() => expect(result.current.externalCalendars).toHaveLength(1));
        const day = new Date(2026, 3, 3);
        expect(result.current.getExternalEventsForDay(day)).toEqual([]);
        expect(isCalendarSlotFree(day, new Date(2026, 3, 3, 9, 30), 30, {
            events: result.current.getAvailabilityEventsForDay(day), tasks: [], timeEstimatesEnabled: true,
        })).toBe(false);
    });

    it('spreads a multi-day event over every day it covers, clamped to the visible range', async () => {
        vi.mocked(fetchExternalCalendarEvents).mockResolvedValue({
            calendars: [],
            events: [makeEvent({
                id: 'offsite',
                title: 'Offsite',
                start: '2026-03-30T09:00:00',
                end: '2026-04-02T17:00:00',
            })],
            warnings: [],
        });

        const { result } = renderExternalEvents();
        await waitFor(() => expect(result.current.visibleExternalEvents).toHaveLength(1));


        expect(result.current.getExternalEventsForDay(new Date(2026, 2, 30))).toHaveLength(0);
        expect(result.current.getExternalEventsForDay(new Date(2026, 3, 1))).toHaveLength(1);
        expect(result.current.getExternalEventsForDay(new Date(2026, 3, 2))).toHaveLength(1);
        expect(result.current.getExternalEventsForDay(new Date(2026, 3, 3))).toHaveLength(0);
    });

    it('ends an exclusive-midnight event on its last real day', async () => {
        vi.mocked(fetchExternalCalendarEvents).mockResolvedValue({
            calendars: [],
            events: [makeEvent({
                id: 'all-day',
                allDay: true,
                start: '2026-04-06T00:00:00',
                end: '2026-04-07T00:00:00',
            })],
            warnings: [],
        });

        const { result } = renderExternalEvents();
        await waitFor(() => expect(result.current.visibleExternalEvents).toHaveLength(1));

        expect(result.current.getExternalEventsForDay(new Date(2026, 3, 6))).toHaveLength(1);
        expect(result.current.getExternalEventsForDay(new Date(2026, 3, 7))).toHaveLength(0);
    });

    it('filters on the event title or its calendar name', async () => {
        vi.mocked(fetchExternalCalendarEvents).mockResolvedValue({
            calendars: [{ id: 'work', name: 'Work', url: 'https://calendar.example/work', enabled: true }],
            events: [makeEvent(), makeEvent({ id: 'event-2', title: 'Dentist', sourceId: 'personal' })],
            warnings: [],
        });

        const { result, rerender } = renderExternalEvents();
        await waitFor(() => expect(result.current.visibleExternalEvents).toHaveLength(2));

        rerender({ query: 'launch', range: APRIL });
        expect(result.current.visibleExternalEvents.map((event) => event.id)).toEqual(['event-1']);


        rerender({ query: 'work', range: APRIL });
        expect(result.current.visibleExternalEvents.map((event) => event.id)).toEqual(['event-1']);

        rerender({ query: 'nothing', range: APRIL });
        expect(result.current.visibleExternalEvents).toHaveLength(0);
    });

    it('restores hidden calendars from storage and persists a toggle', async () => {
        window.localStorage.setItem(HIDDEN_KEY, JSON.stringify(['work']));
        vi.mocked(fetchExternalCalendarEvents).mockResolvedValue({
            calendars: [{ id: 'work', name: 'Work', url: 'https://calendar.example/work', enabled: true }],
            events: [makeEvent()],
            warnings: [],
        });

        const { result } = renderExternalEvents();
        await waitFor(() => expect(result.current.externalCalendars).toHaveLength(1));

        expect(result.current.hiddenExternalCalendarIds.has('work')).toBe(true);
        expect(result.current.visibleExternalEvents).toHaveLength(0);

        expect(window.localStorage.getItem(HIDDEN_KEY)).toBe(JSON.stringify(['work']));

        act(() => result.current.toggleExternalCalendar('work'));
        expect(result.current.visibleExternalEvents).toHaveLength(1);
        expect(window.localStorage.getItem(HIDDEN_KEY)).toBe('[]');

        act(() => result.current.toggleExternalCalendar('work'));
        expect(window.localStorage.getItem(HIDDEN_KEY)).toBe(JSON.stringify(['work']));
    });

    it('ignores unparseable hidden-calendar storage instead of throwing', async () => {
        window.localStorage.setItem(HIDDEN_KEY, '{not json');

        const { result } = renderExternalEvents();
        await waitFor(() => expect(result.current.isExternalLoading).toBe(false));

        expect(result.current.hiddenExternalCalendarIds.size).toBe(0);
    });

    it('prefers the calendar colour the user set, and falls back to the palette', async () => {
        vi.mocked(fetchExternalCalendarEvents).mockResolvedValue({
            calendars: [
                { id: 'work', name: 'Work', url: 'https://calendar.example/work', enabled: true, color: '#ff0000' },
                { id: 'personal', name: 'Personal', url: 'https://calendar.example/home', enabled: true },
            ],
            events: [],
            warnings: [],
        });

        const { result } = renderExternalEvents();
        await waitFor(() => expect(result.current.externalCalendars).toHaveLength(2));

        expect(result.current.getExternalCalendarColor('work')).toBe('#ff0000');
        expect(result.current.getExternalCalendarColor('personal')).toBe(getExternalCalendarColorForId('personal'));

        expect(result.current.getExternalCalendarColor('gone')).toBe(getExternalCalendarColorForId('gone'));
    });

    it('names the module-level default distinctly from the override-aware hook member', () => {


        expect(defaultExternalCalendarColor('work', '#ff0000')).toBe('#ff0000');
        expect(defaultExternalCalendarColor('work')).toBe(getExternalCalendarColorForId('work'));
        expect(defaultExternalCalendarColor('')).toBe(getExternalCalendarColorForId('calendar'));
    });

    it('surfaces partial failures as a warning without dropping the events that loaded', async () => {
        vi.mocked(fetchExternalCalendarEvents).mockResolvedValue({
            calendars: [],
            events: [makeEvent()],
            warnings: ['Failed to load "Work": HTTP 504', 'Failed to load "Home": HTTP 500'],
        });

        const { result } = renderExternalEvents();

        await waitFor(() => expect(result.current.externalError).toBe('Failed to load "Work": HTTP 504 (+1 more)'));
        expect(result.current.visibleExternalEvents).toHaveLength(1);
        expect(result.current.isExternalLoading).toBe(false);
    });

    it('clears the events and reports the message when the whole load fails', async () => {
        vi.mocked(fetchExternalCalendarEvents).mockRejectedValue(new Error('  network down  '));

        const { result } = renderExternalEvents();

        await waitFor(() => expect(result.current.externalError).toBe('network down'));
        expect(result.current.visibleExternalEvents).toHaveLength(0);
        expect(result.current.isExternalLoading).toBe(false);
    });

    it('refetches with day bounds when the visible range changes', async () => {
        const { rerender } = renderExternalEvents();
        await waitFor(() => expect(fetchExternalCalendarEvents).toHaveBeenCalledTimes(1));

        const may = { start: new Date(2026, 4, 1), end: new Date(2026, 4, 31) };
        rerender({ query: '', range: may });

        await waitFor(() => expect(fetchExternalCalendarEvents).toHaveBeenCalledTimes(2));
        const [rangeStart, rangeEnd] = vi.mocked(fetchExternalCalendarEvents).mock.calls[1];
        expect(dayKey(rangeStart)).toBe('2026-05-01');
        expect(rangeStart.getHours()).toBe(0);
        expect(dayKey(rangeEnd)).toBe('2026-05-31');
        expect(rangeEnd.getHours()).toBe(23);
        expect(rangeEnd.getMinutes()).toBe(59);
    });
});
