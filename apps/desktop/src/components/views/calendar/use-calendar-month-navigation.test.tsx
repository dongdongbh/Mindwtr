import { act, renderHook } from '@testing-library/react';
import { addDays, addWeeks, subDays, subWeeks } from 'date-fns';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dayKey } from './calendar-primitives';
import { useCalendarMonthNavigation, type CalendarMonthNavigationOptions } from './use-calendar-month-navigation';

const renderNavigation = (overrides: Partial<CalendarMonthNavigationOptions> = {}) => {
    const onNavigate = overrides.onNavigate ?? vi.fn();
    const view = renderHook(() => useCalendarMonthNavigation({
        calendarLocale: 'en-US',
        calendarSystem: 'gregorian',
        onNavigate,
        weekStartsOn: 0,
        ...overrides,
    }));
    return { ...view, onNavigate };
};

describe('useCalendarMonthNavigation', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 3, 3, 14, 48));
        window.history.replaceState(null, '', '/');
        window.localStorage.clear();
    });

    afterEach(() => {
        vi.useRealTimers();
        window.history.replaceState(null, '', '/');
        window.localStorage.clear();
    });

    it('restores the view mode and dates from the URL, defaulting a schedule view to today', () => {
        window.history.replaceState(null, '', '/?calendarView=schedule&calendarMonth=2026-04');

        const { result } = renderNavigation();

        expect(result.current.viewMode).toBe('schedule');
        expect(dayKey(result.current.selectedDate as Date)).toBe('2026-04-03');
        expect(dayKey(result.current.currentMonth)).toBe('2026-04-03');
    });

    it('leaves the month view unselected and writes the resolved view back to the URL', () => {
        const { result } = renderNavigation();

        expect(result.current.viewMode).toBe('month');
        expect(result.current.selectedDate).toBeNull();
        expect(window.location.search).toContain('calendarView=month');
        expect(window.location.search).toContain('calendarMonth=2026-04');
        expect(window.location.search).not.toContain('calendarDate=');
    });

    it('rejects a rolled-over date in the URL instead of silently landing on another day', () => {
        window.history.replaceState(null, '', '/?calendarView=day&calendarDate=2026-02-30');

        const { result } = renderNavigation();


        expect(dayKey(result.current.selectedDate as Date)).toBe('2026-04-03');
    });


    const stepCases = [
        { mode: 'day', prev: subDays(new Date(2026, 3, 3), 1), next: addDays(new Date(2026, 3, 3), 1), keepsSelection: true },
        { mode: 'week', prev: subWeeks(new Date(2026, 3, 3), 1), next: addWeeks(new Date(2026, 3, 3), 1), keepsSelection: true },
        { mode: 'schedule', prev: subWeeks(new Date(2026, 3, 3), 2), next: addWeeks(new Date(2026, 3, 3), 2), keepsSelection: true },
        { mode: 'month', prev: new Date(2026, 2, 3), next: new Date(2026, 4, 3), keepsSelection: false },
    ] as const;

    for (const { mode, prev, next, keepsSelection } of stepCases) {
        it(`steps ${mode} view by its own unit and ${keepsSelection ? 'keeps' : 'drops'} the selected day`, () => {
            const { result, onNavigate } = renderNavigation();

            act(() => result.current.handleViewModeChange(mode));
            act(() => result.current.handlePrevMonth());

            expect(dayKey(result.current.currentMonth)).toBe(dayKey(prev));
            expect(result.current.selectedDate && dayKey(result.current.selectedDate)).toBe(
                keepsSelection ? dayKey(prev) : null
            );

            act(() => result.current.handleNextMonth());
            act(() => result.current.handleNextMonth());

            expect(dayKey(result.current.currentMonth)).toBe(dayKey(next));
            expect(onNavigate).toHaveBeenCalled();
        });
    }

    it('opens the day view for a date and reports the navigation', () => {
        const { result, onNavigate } = renderNavigation();

        act(() => result.current.openDayViewForDate(new Date(2026, 3, 9)));

        expect(result.current.viewMode).toBe('day');
        expect(dayKey(result.current.selectedDate as Date)).toBe('2026-04-09');
        expect(result.current.isMonthPickerOpen).toBe(false);
        expect(onNavigate).toHaveBeenCalledTimes(1);
        expect(window.location.search).toContain('calendarDate=2026-04-09');
    });

    it('selects a date without navigating away from the current month', () => {
        const { result, onNavigate } = renderNavigation();

        act(() => result.current.selectCalendarDate(new Date(2026, 3, 20)));

        expect(dayKey(result.current.selectedDate as Date)).toBe('2026-04-20');
        expect(dayKey(result.current.currentMonth)).toBe('2026-04-03');


        expect(onNavigate).not.toHaveBeenCalled();

        act(() => result.current.selectCalendarDate(new Date(2026, 4, 20)));
        expect(dayKey(result.current.currentMonth)).toBe('2026-05-20');
    });

    it('reveals a date the user just acted on, and closing the day resets the panel', () => {
        const { result, onNavigate } = renderNavigation();

        act(() => result.current.revealDate(new Date(2026, 3, 11)));
        expect(dayKey(result.current.selectedDate as Date)).toBe('2026-04-11');
        expect(dayKey(result.current.currentMonth)).toBe('2026-04-11');
        expect(onNavigate).not.toHaveBeenCalled();

        act(() => result.current.closeSelectedDay());
        expect(result.current.selectedDate).toBeNull();
        expect(onNavigate).toHaveBeenCalledTimes(1);
    });

    it('builds a month grid padded to whole weeks and a seven-day timeline', () => {
        const { result } = renderNavigation();

        expect(result.current.days.length % 7).toBe(0);
        expect(dayKey(result.current.days[0])).toBe('2026-03-29');
        expect(result.current.weekdayHeaders).toHaveLength(7);
        expect(result.current.monthNames).toHaveLength(12);
        expect(result.current.yearOptions).toEqual([
            2021, 2022, 2023, 2024, 2025, 2026, 2027, 2028, 2029, 2030, 2031,
        ]);

        act(() => result.current.handleViewModeChange('week'));
        expect(result.current.timelineDays).toHaveLength(7);
        expect(dayKey(result.current.timelineDays[0])).toBe('2026-03-29');

        act(() => result.current.handleViewModeChange('day'));
        expect(result.current.timelineDays).toHaveLength(1);
    });

    describe('timeline day count (#951)', () => {
        it('uses the current day as the start of a shorter rolling window', () => {
            const { result } = renderNavigation();

            act(() => result.current.handleViewModeChange('week'));
            act(() => result.current.setTimelineDayCount(5));

            expect(result.current.timelineDays.map(dayKey)).toEqual([
                '2026-04-03', '2026-04-04', '2026-04-05', '2026-04-06', '2026-04-07',
            ]);
            expect(dayKey(result.current.visibleRange.start)).toBe('2026-04-03');
            expect(dayKey(result.current.visibleRange.end)).toBe('2026-04-07');
            expect(result.current.currentMonthLabel).toBe('Apr 3 - Apr 7, 2026');
        });

        it('steps by the visible day count so every day remains reachable', () => {
            const { result } = renderNavigation();

            act(() => result.current.handleViewModeChange('week'));
            act(() => result.current.revealDate(new Date(2026, 3, 6)));
            act(() => result.current.setTimelineDayCount(5));

            expect(result.current.timelineDays.map(dayKey)).toEqual([
                '2026-04-06', '2026-04-07', '2026-04-08', '2026-04-09', '2026-04-10',
            ]);

            act(() => result.current.handleNextMonth());
            expect(result.current.timelineDays.map(dayKey)).toEqual([
                '2026-04-11', '2026-04-12', '2026-04-13', '2026-04-14', '2026-04-15',
            ]);

            act(() => result.current.handlePrevMonth());
            act(() => result.current.handlePrevMonth());
            expect(result.current.timelineDays.map(dayKey)).toEqual([
                '2026-04-01', '2026-04-02', '2026-04-03', '2026-04-04', '2026-04-05',
            ]);
        });

        it('does not shift a rolling window when selecting a visible day in the next month', () => {
            const { result } = renderNavigation();

            act(() => result.current.handleViewModeChange('week'));
            act(() => result.current.revealDate(new Date(2026, 3, 29)));
            act(() => result.current.setTimelineDayCount(5));
            act(() => result.current.selectCalendarDate(new Date(2026, 4, 1)));

            expect(dayKey(result.current.selectedDate as Date)).toBe('2026-05-01');
            expect(result.current.timelineDays.map(dayKey)).toEqual([
                '2026-04-29', '2026-04-30', '2026-05-01', '2026-05-02', '2026-05-03',
            ]);
        });

        it('leaves the day view on one day whatever the count is', () => {
            const { result } = renderNavigation();

            act(() => result.current.setTimelineDayCount(3));
            act(() => result.current.handleViewModeChange('day'));

            expect(result.current.timelineDays).toHaveLength(1);
        });

        it('clamps out-of-range counts instead of rendering an empty or overlong week', () => {
            const { result } = renderNavigation();

            act(() => result.current.setTimelineDayCount(0));
            expect(result.current.timelineDayCount).toBe(2);

            act(() => result.current.setTimelineDayCount(99));
            expect(result.current.timelineDayCount).toBe(7);
        });

        it('remembers the count on this device only, and falls back to a whole week when the stored value is unusable', () => {
            const { result, unmount } = renderNavigation();

            act(() => result.current.setTimelineDayCount(4));
            expect(window.localStorage.getItem('mindwtr.calendar.timelineDayCount')).toBe('4');


            expect(window.location.search).not.toMatch(/day|count/i);
            unmount();

            expect(renderNavigation().result.current.timelineDayCount).toBe(4);

            window.localStorage.setItem('mindwtr.calendar.timelineDayCount', 'not-a-number');
            expect(renderNavigation().result.current.timelineDayCount).toBe(7);
        });
    });

    it('keeps the schedule view range at 61 days', () => {
        const { result } = renderNavigation();

        act(() => result.current.handleViewModeChange('schedule'));

        expect(result.current.scheduleDays).toHaveLength(61);
        expect(dayKey(result.current.scheduleDays[0])).toBe('2026-04-03');
    });

    it('changes month and year from the picker without keeping the old selection', () => {
        const { result, onNavigate } = renderNavigation();

        act(() => result.current.selectCalendarDate(new Date(2026, 3, 20)));
        act(() => result.current.handleMonthChange(6));

        expect(dayKey(result.current.currentMonth)).toBe('2026-07-03');
        expect(result.current.selectedDate).toBeNull();

        act(() => result.current.handleYearChange(2030));
        expect(dayKey(result.current.currentMonth)).toBe('2030-07-03');
        expect(onNavigate).toHaveBeenCalledTimes(2);
    });

    it('toggles the month picker and closes it on every navigation', () => {
        const { result } = renderNavigation();

        act(() => result.current.toggleMonthPicker());
        expect(result.current.isMonthPickerOpen).toBe(true);

        act(() => result.current.handleToday());
        expect(result.current.isMonthPickerOpen).toBe(false);
    });
});
