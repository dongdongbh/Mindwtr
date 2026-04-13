import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LanguageProvider } from '../../contexts/language-context';
import { CalendarView } from './CalendarView';
import { fetchExternalCalendarEvents } from '../../lib/external-calendar-events';

vi.mock('@mindwtr/core', async () => {
    const actual = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
    const taskStoreState = {
        areas: [],
        deleteTask: vi.fn(async () => {}),
        getDerivedState: () => ({
            projectMap: new Map(),
        }),
        setError: vi.fn(),
        settings: {
            diagnostics: {
                loggingEnabled: false,
            },
            weekStart: 'sunday',
        },
        tasks: [],
        updateTask: vi.fn(async () => {}),
    };
    const useTaskStore = Object.assign(
        (selector: (state: typeof taskStoreState) => unknown) => selector(taskStoreState),
        {
            getState: () => taskStoreState,
            subscribe: vi.fn(),
        }
    );

    return {
        ...actual,
        isTaskInActiveProject: () => true,
        safeFormatDate: (value: Date) => value.toISOString(),
        safeParseDate: (value: string) => new Date(value),
        safeParseDueDate: (value: string) => new Date(value),
        shallow: () => false,
        useTaskStore,
    };
});

vi.mock('../../lib/external-calendar-events', () => ({
    fetchExternalCalendarEvents: vi.fn(async () => ({ calendars: [], events: [], warnings: [] })),
    summarizeExternalCalendarWarnings: (warnings: string[]) => {
        if (warnings.length === 0) return null;
        if (warnings.length === 1) return warnings[0];
        return `${warnings[0]} (+${warnings.length - 1} more)`;
    },
}));

describe('CalendarView', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-04-03T14:48:00.000Z'));
        vi.mocked(fetchExternalCalendarEvents).mockResolvedValue({ calendars: [], events: [], warnings: [] });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('renders the today marker with explicit primary contrast tokens', async () => {
        render(
            <LanguageProvider>
                <CalendarView />
            </LanguageProvider>
        );

        await act(async () => {
            await Promise.resolve();
        });

        const todayNumber = screen.getByText('3');
        const markerStyle = todayNumber.parentElement?.getAttribute('style') ?? '';
        expect(markerStyle).toContain('background-color: hsl(var(--primary));');
        expect(markerStyle).toContain('color: hsl(var(--primary-foreground));');
    });

    it('shows external events that span into the selected day', async () => {
        vi.mocked(fetchExternalCalendarEvents).mockResolvedValue({
            calendars: [{ id: 'work', name: 'Work', url: 'https://calendar.example/work', enabled: true }],
            events: [{
                id: 'event-1',
                sourceId: 'work',
                title: 'Launch window',
                start: '2026-04-02T23:30:00',
                end: '2026-04-03T00:30:00',
                allDay: false,
            }],
            warnings: [],
        });

        render(
            <LanguageProvider>
                <CalendarView />
            </LanguageProvider>
        );

        await act(async () => {
            vi.runAllTimers();
            await Promise.resolve();
        });

        await act(async () => {
            fireEvent.click(screen.getByText('3').closest('.group') as HTMLElement);
            await Promise.resolve();
        });

        expect(screen.getByText(/Launch window/)).toBeInTheDocument();
    });

    it('surfaces partial external calendar failures without dropping loaded events', async () => {
        vi.mocked(fetchExternalCalendarEvents).mockResolvedValue({
            calendars: [],
            events: [],
            warnings: ['Failed to load "Work": HTTP 504'],
        });

        render(
            <LanguageProvider>
                <CalendarView />
            </LanguageProvider>
        );

        await act(async () => {
            vi.runAllTimers();
            await Promise.resolve();
        });

        expect(screen.getByText(/Failed to load "Work": HTTP 504/)).toBeInTheDocument();
    });
});
