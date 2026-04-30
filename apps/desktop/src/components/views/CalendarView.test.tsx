import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@mindwtr/core';

import { LanguageProvider } from '../../contexts/language-context';
import { CalendarView } from './CalendarView';
import { combineDateAndTime } from './calendar/useDesktopCalendarController';
import { fetchExternalCalendarEvents } from '../../lib/external-calendar-events';

const storeMocks = vi.hoisted(() => ({
    taskStoreState: {
        addTask: vi.fn(async () => ({ success: true, id: 'task-new' })),
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
        tasks: [] as Task[],
        updateTask: vi.fn(async () => {}),
    },
}));

vi.mock('@mindwtr/core', async () => {
    const actual = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
    const useTaskStore = Object.assign(
        (selector: (state: typeof storeMocks.taskStoreState) => unknown) => selector(storeMocks.taskStoreState),
        {
            getState: () => storeMocks.taskStoreState,
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

const makeTask = (overrides: Partial<Task> = {}): Task => ({
    id: 'task-1',
    title: 'Task',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
});

const renderCalendar = () => render(
    <LanguageProvider>
        <CalendarView />
    </LanguageProvider>
);

const flushCalendarEffects = async () => {
    await act(async () => {
        vi.runAllTimers();
        await Promise.resolve();
        await Promise.resolve();
    });
};

const selectDay = async (dayText: string) => {
    await act(async () => {
        fireEvent.click(screen.getByText(dayText).closest('.group') as HTMLElement);
        await Promise.resolve();
    });
};

const openNewTaskComposerForDay = async (dayText: string) => {
    await selectDay(dayText);
    await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /add new task/i }));
        await Promise.resolve();
    });
};

describe('CalendarView', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-04-03T14:48:00.000Z'));
        window.history.replaceState(null, '', '/');
        window.localStorage.clear();
        storeMocks.taskStoreState.tasks = [];
        storeMocks.taskStoreState.addTask.mockClear();
        storeMocks.taskStoreState.addTask.mockResolvedValue({ success: true, id: 'task-new' });
        storeMocks.taskStoreState.updateTask.mockClear();
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

    it('rejects rolled-over date values in calendar composer parsing', () => {
        expect(combineDateAndTime('2026-02-30', '09:00')).toBeNull();
        expect(combineDateAndTime('2026-02-28', '09:00')?.getDate()).toBe(28);
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

        expect(screen.getAllByText(/Launch window/).length).toBeGreaterThan(0);

        const searchInput = document.querySelector('[data-view-filter-input]') as HTMLInputElement;
        await act(async () => {
            fireEvent.change(searchInput, { target: { value: 'not-launch' } });
            await Promise.resolve();
        });

        expect(screen.getByText('No matching calendar items in this view')).toBeInTheDocument();
        expect(screen.queryByText(/Launch window/)).not.toBeInTheDocument();

        await act(async () => {
            fireEvent.change(searchInput, { target: { value: 'Launch' } });
            await Promise.resolve();
        });

        expect(screen.getByText('1 matches in this view')).toBeInTheDocument();
        expect(screen.getAllByText(/Launch window/).length).toBeGreaterThan(0);
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

    it('rejects composer submissions when the end time is before the start time', async () => {
        renderCalendar();
        await flushCalendarEffects();
        await openNewTaskComposerForDay('4');

        fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Draft launch note' } });
        fireEvent.change(screen.getByLabelText('End'), { target: { value: '07:45' } });

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Save' }));
            await Promise.resolve();
        });

        expect(screen.getByText('Choose a valid start and end time.')).toBeInTheDocument();
        expect(storeMocks.taskStoreState.addTask).not.toHaveBeenCalled();
    });

    it('rejects composer submissions that overlap visible external events', async () => {
        vi.mocked(fetchExternalCalendarEvents).mockResolvedValue({
            calendars: [{ id: 'work', name: 'Work', url: 'https://calendar.example/work', enabled: true }],
            events: [{
                id: 'event-1',
                sourceId: 'work',
                title: 'Standup',
                start: '2026-04-04T08:00:00',
                end: '2026-04-04T09:00:00',
                allDay: false,
            }],
            warnings: [],
        });

        renderCalendar();
        await flushCalendarEffects();
        await openNewTaskComposerForDay('4');

        fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Prepare notes' } });
        fireEvent.change(screen.getByLabelText('Start'), { target: { value: '08:30' } });

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Save' }));
            await Promise.resolve();
        });

        expect(screen.getByText('That time overlaps with an event. Please choose a free slot.')).toBeInTheDocument();
        expect(storeMocks.taskStoreState.addTask).not.toHaveBeenCalled();
    });

    it('saves existing tasks from the calendar composer', async () => {
        storeMocks.taskStoreState.tasks = [
            makeTask({
                id: 'task-existing',
                title: 'Write proposal',
                timeEstimate: '1hr',
            }),
        ];

        renderCalendar();
        await flushCalendarEffects();
        await openNewTaskComposerForDay('4');

        fireEvent.click(screen.getByRole('button', { name: 'Existing task' }));
        fireEvent.click(screen.getByRole('button', { name: /Write proposal/ }));

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Save' }));
            await Promise.resolve();
        });

        expect(storeMocks.taskStoreState.updateTask).toHaveBeenCalledWith('task-existing', expect.objectContaining({
            startTime: new Date(2026, 3, 4, 8, 0).toISOString(),
            timeEstimate: '1hr',
        }));
        expect(storeMocks.taskStoreState.addTask).not.toHaveBeenCalled();
    });
});
