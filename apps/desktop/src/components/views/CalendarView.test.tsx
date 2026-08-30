import { act, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Area, Project, Task } from '@mindwtr/core';

import { LanguageProvider } from '../../contexts/language-context';
import { useUiStore } from '../../store/ui-store';
import { CalendarView } from './CalendarView';
import { combineDateAndTime } from './calendar/calendar-primitives';
import { useDesktopCalendarController } from './calendar/useDesktopCalendarController';
import { fetchExternalCalendarEvents } from '../../lib/external-calendar-events';
import { setCalendarTaskDragData } from '../../lib/calendar-task-drag';
import { clearUndoableAction, takeUndoableAction } from '../../lib/undo-registry';

const storeMocks = vi.hoisted(() => {
    const taskStoreState = {
        addArea: vi.fn(async () => null),
        addProject: vi.fn(async () => null),
        addTask: vi.fn(async () => ({ success: true, id: 'task-new' })),
        areas: [] as Area[],
        deleteTask: vi.fn(async () => ({ success: true })),
        duplicateTask: vi.fn(async () => ({ success: true, id: 'task-dup' })),
        getDerivedState: () => ({
            allContexts: Array.from(new Set(taskStoreState.tasks.flatMap((task) => task.contexts ?? []))).sort(),
            allTags: Array.from(new Set(taskStoreState.tasks.flatMap((task) => task.tags ?? []))).sort(),
            projectMap: new Map(taskStoreState.projects.map((project) => [project.id, project])),
            sequentialProjectIds: new Set(taskStoreState.projects.filter((project) => project.isSequential).map((project) => project.id)),
            sequentialWithinSectionProjectIds: new Set(taskStoreState.projects.filter((project) => project.isSequential && project.sequentialScope === 'section').map((project) => project.id)),
        }),
        moveTask: vi.fn(async () => ({ success: true })),
        people: [] as Array<{ id: string; name: string }>,
        projects: [] as Project[],
        promoteTaskToProject: vi.fn(async () => ({ success: true, id: 'project-new' })),
        restoreTask: vi.fn(async () => ({ success: true })),
        setError: vi.fn(),
        setHighlightTask: vi.fn(),
        settings: {
            diagnostics: {
                loggingEnabled: false,
            },
            undoNotificationsEnabled: true as boolean | undefined,
            weekStart: 'sunday',
        },
        tasks: [] as Task[],
        // Mirrors the real store's split: `tasks` is the visible projection
        // (store-helpers' isTaskVisible drops archived), `_allTasks` is
        // everything. Tests that need archived tasks set this one explicitly.
        _allTasks: null as Task[] | null,
        // Real updateTask always resolves a StoreActionResult; the quick-action
        // menu's "Remove from calendar" reads `.success` off it.
        updateTask: vi.fn<(id: string, updates: Partial<Task>) => Promise<{ success: boolean }>>(
            async () => ({ success: true })
        ),
    };

    return { taskStoreState };
});

vi.mock('@mindwtr/core', async () => {
    const actual = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
    const useTaskStore = Object.assign(
        (selector: (state: typeof storeMocks.taskStoreState) => unknown) => selector({
            ...storeMocks.taskStoreState,
            _allTasks: storeMocks.taskStoreState._allTasks ?? storeMocks.taskStoreState.tasks,
        } as typeof storeMocks.taskStoreState),
        {
            getState: () => storeMocks.taskStoreState,
            subscribe: vi.fn(),
        }
    );

    return {
        ...actual,
        isTaskInActiveProject: () => true,
        // The projected-recurrence label passes the occurrence's raw date
        // string (task.startTime/dueDate), not a Date -- the real
        // safeFormatDate accepts either.
        safeFormatDate: (value: Date | string) => (value instanceof Date ? value : new Date(value)).toISOString(),
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

const makeProject = (overrides: Partial<Project> = {}): Project => ({
    id: 'project-1',
    title: 'Project',
    status: 'active',
    color: '#94a3b8',
    order: 0,
    tagIds: [],
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
});

const makeArea = (overrides: Partial<Area> = {}): Area => ({
    id: 'area-1',
    name: 'Area',
    color: '#94a3b8',
    order: 0,
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
});

const renderCalendar = () => render(
    <LanguageProvider>
        <CalendarView />
    </LanguageProvider>
);

function DesktopControllerHost({
    onResult,
}: {
    onResult: (controller: ReturnType<typeof useDesktopCalendarController>) => void;
}) {
    onResult(useDesktopCalendarController());
    return null;
}

const flushCalendarEffects = async () => {
    await act(async () => {
        vi.advanceTimersByTime(0);
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

const expandPlanningPanel = async () => {
    const expandButton = screen.queryByRole('button', { name: 'Expand planning panel' });
    if (!expandButton) return;
    await act(async () => {
        fireEvent.click(expandButton);
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

const createTaskDragDataTransfer = (taskId: string, itemKind?: 'scheduled' | 'deadline'): DataTransfer => {
    const values = new Map<string, string>();
    const types: string[] = [];
    const dataTransfer = {
        dropEffect: 'none' as DataTransfer['dropEffect'],
        effectAllowed: 'all' as DataTransfer['effectAllowed'],
        types,
        getData: vi.fn((type: string) => values.get(type) ?? ''),
        setData: vi.fn((type: string, value: string) => {
            values.set(type, value);
            if (!types.includes(type)) types.push(type);
        }),
    } as unknown as DataTransfer;
    setCalendarTaskDragData(dataTransfer, taskId, { itemKind });
    return dataTransfer;
};

describe('CalendarView', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-04-03T14:48:00.000Z'));
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
            configurable: true,
            value: vi.fn(),
        });
        window.history.replaceState(null, '', '/');
        window.localStorage.clear();
        storeMocks.taskStoreState.tasks = [];
        storeMocks.taskStoreState._allTasks = null;
        storeMocks.taskStoreState.projects = [];
        storeMocks.taskStoreState.areas = [];
        storeMocks.taskStoreState.settings = {
            diagnostics: { loggingEnabled: false },
            undoNotificationsEnabled: true,
            weekStart: 'sunday',
        };
        storeMocks.taskStoreState.addProject.mockClear();
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

    it.each([
        ['day', 'Previous day', 'Next day'],
        ['week', 'Previous week', 'Next week'],
        ['month', 'Previous month', 'Next month'],
        ['schedule', 'Previous month', 'Next month'],
    ])('labels %s navigation for the period it changes', async (viewMode, previousLabel, nextLabel) => {
        window.history.replaceState(null, '', `/?calendarView=${viewMode}&calendarDate=2026-04-03`);

        renderCalendar();
        await flushCalendarEffects();

        expect(screen.getByRole('button', { name: previousLabel })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: nextLabel })).toBeInTheDocument();
    });

    it('keeps week columns aligned beside the scrollbar and the midnight label visible', async () => {
        window.history.replaceState(null, '', '/?calendarView=week&calendarDate=2026-04-03');
        const offsetWidth = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(100);
        const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(88);

        try {
            renderCalendar();
            await flushCalendarEffects();

            const headerGrid = screen.getByText('Time').parentElement;
            const allDayGrid = screen.getByText('All day').parentElement;
            const timedScroller = document.querySelector('[data-calendar-timed-drop-date]')?.parentElement?.parentElement;
            const midnightLabel = timedScroller?.firstElementChild?.firstElementChild?.firstElementChild;

            expect(headerGrid).toHaveStyle({ paddingRight: '12px' });
            expect(allDayGrid).toHaveStyle({ paddingRight: '12px' });
            expect(midnightLabel).toHaveClass('first:translate-y-0');
        } finally {
            offsetWidth.mockRestore();
            clientWidth.mockRestore();
        }
    });

    it('starts a restored schedule view from today instead of the first day of the month', async () => {
        window.history.replaceState(null, '', '/?calendarView=schedule&calendarMonth=2026-04');
        storeMocks.taskStoreState.tasks = [
            makeTask({
                id: 'month-start-task',
                title: 'Month start task',
                dueDate: '2026-04-01T12:00:00',
                startTime: '2026-04-01T12:00:00',
            }),
            makeTask({
                id: 'today-task',
                title: 'Today task',
                dueDate: '2026-04-03T12:00:00',
            }),
        ];

        renderCalendar();
        await flushCalendarEffects();

        expect(screen.queryByText('Month start task')).not.toBeInTheDocument();
        expect(screen.getAllByText('Today task').length).toBeGreaterThan(0);
        expect(window.location.search).toContain('calendarDate=2026-04-03');
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

        await flushCalendarEffects();

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

        await flushCalendarEffects();

        expect(screen.getByText(/Failed to load "Work": HTTP 504/)).toBeInTheDocument();
    });

    it('creates a task from a selected external calendar event', async () => {
        vi.mocked(fetchExternalCalendarEvents).mockResolvedValue({
            calendars: [{ id: 'work', name: 'Work', url: 'https://calendar.example/work', enabled: true }],
            events: [{
                id: 'event-1',
                sourceId: 'work',
                title: 'Launch window',
                start: '2026-04-03T10:00:00.000Z',
                end: '2026-04-03T10:45:00.000Z',
                allDay: false,
                description: 'Discuss launch.',
                location: 'Room 1',
            }],
            warnings: [],
        });

        renderCalendar();
        await flushCalendarEffects();
        await selectDay('3');

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: /create task: launch window/i }));
            await Promise.resolve();
        });

        expect(storeMocks.taskStoreState.addTask).toHaveBeenCalledWith('Launch window', {
            status: 'next',
            startTime: '2026-04-03T10:00:00.000Z',
            timeEstimate: 'custom:45',
            location: 'Room 1',
            description: 'Discuss launch.\n\nCalendar: Work',
        });
    });

    it('labels a date-only scheduled task All day in the month grid, never a midnight time', async () => {
        storeMocks.taskStoreState.tasks = [makeTask({
            id: 'date-only-start',
            title: 'Sort photos',
            startTime: '2026-04-04',
            status: 'next',
        })];

        renderCalendar();
        await flushCalendarEffects();

        const chip = screen.getByText('Sort photos').closest('button');
        expect(chip).toHaveTextContent('All day');
        expect(chip).not.toHaveTextContent(/12:00/);
    });

    it('opens the day view when month overflow is clicked', async () => {
        storeMocks.taskStoreState.tasks = Array.from({ length: 5 }, (_, index) => makeTask({
            id: `overflow-task-${index}`,
            title: `Overflow task ${index + 1}`,
            dueDate: '2026-04-04T12:00:00',
        }));

        renderCalendar();
        await flushCalendarEffects();

        const overflowButton = screen.getByRole('button', { name: /open day view: apr 4, 2026/i });
        await act(async () => {
            fireEvent.click(overflowButton);
            await Promise.resolve();
        });

        expect(window.location.search).toContain('calendarView=day');
        expect(window.location.search).toContain('calendarDate=2026-04-04');
        expect(screen.queryByText('+2 more')).not.toBeInTheDocument();
    });

    it('opens an empty month day from the keyboard', async () => {
        renderCalendar();
        await flushCalendarEffects();

        const dayCell = screen.getByRole('button', { name: /apr 5, 2026, open day view/i });
        await act(async () => {
            fireEvent.keyDown(dayCell, { key: 'Enter' });
            await Promise.resolve();
        });

        expect(window.location.search).toContain('calendarView=day');
        expect(window.location.search).toContain('calendarDate=2026-04-05');
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

    it('keeps a retyped composer date and schedules the task on that day', async () => {
        renderCalendar();
        await flushCalendarEffects();
        await openNewTaskComposerForDay('4');

        fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Draft launch note' } });
        fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-04-09' } });

        // The composer uses the shared DateField, which echoes the date back in
        // the locale's display order rather than the stored ISO value.
        expect(screen.getByLabelText('Date')).toHaveValue('04/09/2026');

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Save' }));
            await Promise.resolve();
        });

        expect(storeMocks.taskStoreState.addTask).toHaveBeenCalledWith('Draft launch note', expect.objectContaining({
            startTime: new Date(2026, 3, 9, 8, 0).toISOString(),
        }));
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

    it('colors the month due bar by project or area, falling back to neutral for unfiled tasks', async () => {
        storeMocks.taskStoreState.projects = [
            makeProject({ id: 'project-green', title: 'Green project', color: '#22c55e' }),
        ];
        storeMocks.taskStoreState.areas = [
            makeArea({ id: 'area-violet', name: 'Violet area', color: '#8b5cf6' }),
        ];
        storeMocks.taskStoreState.tasks = [
            makeTask({ id: 'task-project', title: 'Project due task', projectId: 'project-green', dueDate: '2026-04-10' }),
            makeTask({ id: 'task-area', title: 'Area due task', areaId: 'area-violet', dueDate: '2026-04-10' }),
            makeTask({ id: 'task-plain', title: 'Unfiled due task', dueDate: '2026-04-10' }),
        ];

        renderCalendar();
        await flushCalendarEffects();

        expect(screen.getByRole('button', { name: /Project due task/ })).toHaveStyle({ borderLeftColor: '#22c55e' });
        expect(screen.getByRole('button', { name: /Area due task/ })).toHaveStyle({ borderLeftColor: '#8b5cf6' });
        // No project or area: the inline override stays unset, so the chip falls back
        // to the theme's neutral bar. Red is reserved for overdue/urgency, and a
        // deadline chip is not automatically either — the bar carries identity, not
        // alarm. Scheduled chips stay primary-tinted, so the two are still distinct.
        const unfiled = screen.getByRole('button', { name: /Unfiled due task/ });
        expect(unfiled.style.borderLeftColor).toBe('');
        expect(unfiled.className).toContain('border-muted-foreground/60');
        expect(unfiled.className).not.toContain('border-destructive');
    });

    it('parses quick-add syntax when creating a scheduled task from the calendar composer', async () => {
        storeMocks.taskStoreState.projects = [
            makeProject({ id: 'project-launch', title: 'Launch' }),
        ];

        renderCalendar();
        await flushCalendarEffects();
        await openNewTaskComposerForDay('4');

        fireEvent.change(screen.getByLabelText('Task title'), {
            target: { value: 'Draft launch note +Launch @computer #deep /note:Outline next steps' },
        });

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Save' }));
            await Promise.resolve();
        });

        expect(storeMocks.taskStoreState.addTask).toHaveBeenCalledWith('Draft launch note', expect.objectContaining({
            contexts: ['@computer'],
            description: 'Outline next steps',
            projectId: 'project-launch',
            startTime: new Date(2026, 3, 4, 8, 0).toISOString(),
            status: 'next',
            tags: ['#deep'],
            timeEstimate: '30min',
        }));
        expect(storeMocks.taskStoreState.addProject).not.toHaveBeenCalled();
    });

    it('shows quick-add autocomplete options in the calendar composer', async () => {
        storeMocks.taskStoreState.projects = [
            makeProject({ id: 'project-launch', title: 'Launch' }),
        ];
        storeMocks.taskStoreState.areas = [
            makeArea({ id: 'area-work', name: 'Work' }),
        ];
        storeMocks.taskStoreState.tasks = [
            makeTask({
                id: 'task-token-source',
                contexts: ['@computer'],
                tags: ['#deep'],
                title: 'Token source',
            }),
        ];

        renderCalendar();
        await flushCalendarEffects();
        await openNewTaskComposerForDay('4');

        const titleInput = screen.getByLabelText('Task title') as HTMLInputElement;
        const updateTitle = (value: string, key: string) => {
            fireEvent.change(titleInput, { target: { value } });
            titleInput.setSelectionRange(value.length, value.length);
            fireEvent.keyUp(titleInput, { key });
        };

        updateTitle('Draft +L', 'L');
        expect(screen.getByRole('option', { name: 'Launch' })).toBeInTheDocument();

        updateTitle('Draft !W', 'W');
        expect(screen.getByRole('option', { name: 'Work' })).toBeInTheDocument();

        updateTitle('Draft #d', 'd');
        expect(screen.getByRole('option', { name: '#deep' })).toBeInTheDocument();

        updateTitle('Draft @c', 'c');
        expect(screen.getByRole('option', { name: '@computer' })).toBeInTheDocument();
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

    it('plans unscheduled next actions from the calendar side panel', async () => {
        storeMocks.taskStoreState.tasks = [
            makeTask({
                id: 'task-plan',
                title: 'Draft planning memo',
            }),
            makeTask({
                id: 'task-deadline',
                title: 'Review deadline brief',
                dueDate: '2026-04-10T17:00:00.000Z',
            }),
            makeTask({
                id: 'task-scheduled',
                title: 'Already scheduled',
                startTime: '2026-04-04T09:00:00.000Z',
            }),
            makeTask({
                id: 'task-focused',
                title: 'Focused today',
                isFocusedToday: true,
            }),
        ];

        renderCalendar();
        await flushCalendarEffects();
        await expandPlanningPanel();

        const panel = screen.getByText('Plan next actions').closest('aside') as HTMLElement;
        expect(within(panel).getByText('Draft planning memo')).toBeInTheDocument();
        expect(within(panel).getByText('Review deadline brief')).toBeInTheDocument();
        expect(within(panel).queryByText('Already scheduled')).not.toBeInTheDocument();
        expect(within(panel).queryByText('Focused today')).not.toBeInTheDocument();

        await selectDay('4');
        const planTitle = panel.querySelector('[data-task-id="task-plan"]') as HTMLElement;
        const planCard = planTitle.closest('[data-planning-task-id]') as HTMLElement;
        await act(async () => {
            fireEvent.click(within(planCard).getByRole('button', { name: 'Schedule' }));
            await Promise.resolve();
        });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Save' }));
            await Promise.resolve();
        });

        expect(storeMocks.taskStoreState.updateTask).toHaveBeenCalledWith('task-plan', expect.objectContaining({
            startTime: new Date(2026, 3, 4, 8, 0).toISOString(),
        }));
    });


    it('drags a planning panel task onto a month day', async () => {
        storeMocks.taskStoreState.tasks = [
            makeTask({
                id: 'task-plan',
                title: 'Draft planning memo',
            }),
        ];

        renderCalendar();
        await flushCalendarEffects();
        await expandPlanningPanel();

        const panel = screen.getByText('Plan next actions').closest('aside') as HTMLElement;
        const planCard = panel.querySelector('[data-planning-task-id="task-plan"]') as HTMLElement;
        expect(planCard).toHaveAttribute('draggable', 'true');

        // Starts empty: the drag data must come from the row's own dragstart.
        const values = new Map<string, string>();
        const types: string[] = [];
        const dataTransfer = {
            dropEffect: 'none' as DataTransfer['dropEffect'],
            effectAllowed: 'all' as DataTransfer['effectAllowed'],
            types,
            getData: vi.fn((type: string) => values.get(type) ?? ''),
            setData: vi.fn((type: string, value: string) => {
                values.set(type, value);
                if (!types.includes(type)) types.push(type);
            }),
        } as unknown as DataTransfer;

        const dropTarget = document.querySelector('[data-calendar-drop-date="2026-04-04"]') as HTMLElement;
        expect(dropTarget).toBeTruthy();

        await act(async () => {
            fireEvent.dragStart(planCard, { dataTransfer });
            fireEvent.dragOver(dropTarget, { dataTransfer });
            fireEvent.drop(dropTarget, { dataTransfer });
            await Promise.resolve();
        });

        expect(storeMocks.taskStoreState.updateTask).toHaveBeenCalledWith('task-plan', {
            dueDate: '2026-04-04',
        });
    });

    it('explains disabled planning schedule buttons until a day is selected', async () => {
        storeMocks.taskStoreState.tasks = [
            makeTask({
                id: 'task-plan',
                title: 'Draft planning memo',
            }),
        ];

        renderCalendar();
        await flushCalendarEffects();
        await expandPlanningPanel();

        const panel = screen.getByText('Plan next actions').closest('aside') as HTMLElement;
        const planTitle = within(panel).getByText('Draft planning memo');
        const planCard = planTitle.closest('[data-planning-task-id]') as HTMLElement;
        const disabledHintTarget = within(planCard).getByTitle('Select a day to plan first.');
        const scheduleButton = within(disabledHintTarget).getByRole('button', { name: 'Schedule' });

        expect(scheduleButton).toBeDisabled();
        expect(within(planCard).getByText('Select a day to plan first.')).toHaveClass('sr-only');

        await selectDay('4');

        expect(within(planCard).queryByTitle('Select a day to plan first.')).not.toBeInTheDocument();
        expect(within(planCard).getByRole('button', { name: 'Schedule' })).toBeEnabled();
    });

    it('defaults the calendar planning panel to collapsed and keeps the disclosure reversible', async () => {
        storeMocks.taskStoreState.tasks = [
            makeTask({
                id: 'task-plan',
                title: 'Draft planning memo',
            }),
        ];

        renderCalendar();
        await flushCalendarEffects();

        expect(screen.queryByText('Draft planning memo')).not.toBeInTheDocument();
        await expandPlanningPanel();
        expect(screen.getByText('Draft planning memo')).toBeInTheDocument();
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Collapse planning panel' }));
            await Promise.resolve();
        });

        expect(screen.queryByText('Draft planning memo')).not.toBeInTheDocument();
        expect(window.localStorage.getItem('mindwtr.calendar.planningPanelCollapsed')).toBe('true');

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Expand planning panel' }));
            await Promise.resolve();
        });

        expect(screen.getByText('Draft planning memo')).toBeInTheDocument();
        expect(window.localStorage.getItem('mindwtr.calendar.planningPanelCollapsed')).toBe('false');
    });

    it('shows date-only start times as all-day scheduled tasks on the calendar', async () => {
        storeMocks.taskStoreState.tasks = [
            makeTask({
                id: 'task-date-only',
                title: 'Date-only start',
                startTime: '2026-04-04',
            }),
            makeTask({
                id: 'task-timed',
                title: 'Timed start',
                startTime: '2026-04-04T09:00:00',
            }),
        ];

        renderCalendar();
        await flushCalendarEffects();

        expect(screen.getByText('Date-only start')).toBeInTheDocument();
        expect(screen.getByText('Timed start')).toBeInTheDocument();
    });

    it('leaves a seam between back-to-back timed blocks in the week grid', async () => {
        window.history.replaceState(null, '', '/?calendarView=week&calendarDate=2026-04-03');
        storeMocks.taskStoreState.tasks = [
            makeTask({ id: 'task-first', title: 'First hour', startTime: '2026-04-03T09:00:00', timeEstimate: '1hr' }),
            makeTask({ id: 'task-second', title: 'Second hour', startTime: '2026-04-03T10:00:00', timeEstimate: '1hr' }),
        ];

        renderCalendar();
        await flushCalendarEffects();

        // A 60-minute block spans one hour row (56px) minus a 2px seam, so the
        // next block's top edge never touches it.
        expect(screen.getByTitle(/^First hour /)).toHaveStyle({ height: '54px' });
        expect(screen.getByTitle(/^Second hour /)).toHaveStyle({ height: '54px' });
    });

    it('reveals done and archived tasks on their completion date only while the toggle is on (#955)', async () => {
        const openTask = makeTask({
            id: 'task-open',
            title: 'Still open',
            startTime: '2026-04-04T09:00:00',
        });
        const doneTask = makeTask({
            id: 'task-done',
            title: 'Finished thing',
            status: 'done',
            // Scheduled for one day, finished on another: the look-back must
            // file it under the completion date, not the old start date.
            startTime: '2026-04-02T09:00:00',
            completedAt: '2026-04-08T15:30:00',
        });
        const archivedTask = makeTask({
            id: 'task-archived',
            title: 'Archived thing',
            status: 'archived',
            completedAt: '2026-04-09T11:00:00',
        });
        // Archived tasks never reach the visible `tasks` projection, so the
        // look-back has to read them from _allTasks like the Archive view does.
        storeMocks.taskStoreState.tasks = [openTask, doneTask];
        storeMocks.taskStoreState._allTasks = [openTask, doneTask, archivedTask];

        renderCalendar();
        await flushCalendarEffects();

        expect(screen.queryByText('Finished thing')).not.toBeInTheDocument();
        expect(screen.queryByText('Archived thing')).not.toBeInTheDocument();

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Completed' }));
            await Promise.resolve();
        });

        const completedItem = screen.getAllByText('Finished thing')[0];
        expect(completedItem).toBeInTheDocument();
        expect(screen.getAllByText('Archived thing').length).toBeGreaterThan(0);
        // A record of what happened, not a plan that can be dragged elsewhere.
        expect(completedItem.closest('button')).toHaveAttribute('draggable', 'false');
        expect(window.localStorage.getItem('mindwtr.calendar.showCompleted')).toBe('true');

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Completed' }));
            await Promise.resolve();
        });

        expect(screen.queryByText('Finished thing')).not.toBeInTheDocument();
        expect(screen.getByText('Still open')).toBeInTheDocument();
    });

    it('paints a daily recurring task into every visible day in the month, read-only', async () => {
        // System time is 2026-04-03T14:48 (see beforeEach); a daily task due
        // the day before projects forward across the rest of the visible month.
        const recurringTask = makeTask({
            id: 'task-recurring-daily',
            title: 'Daily standup',
            dueDate: '2026-04-02',
            recurrence: 'daily',
            showFutureRecurrence: true,
        });
        storeMocks.taskStoreState.tasks = [recurringTask];

        renderCalendar();
        await flushCalendarEffects();

        // The real occurrence (the task itself, on its own dueDate) stays a normal,
        // editable chip -- only the synthetic range-projected occurrences are inert.
        const realChip = document.querySelector('[data-task-id="task-recurring-daily"]');
        expect(realChip).not.toBeNull();
        expect(realChip).toHaveAttribute('data-task-edit-trigger', 'true');
        expect(realChip).not.toBeDisabled();

        const projectedChips = document.querySelectorAll(
            '[data-task-id^="task-recurring-daily:projected-recurrence:"]'
        );
        // Every remaining day of the visible month (04-04 through 04-30) should
        // have painted its own projected occurrence -- a range, not one preview.
        expect(projectedChips.length).toBeGreaterThan(20);

        for (const chip of projectedChips) {
            expect(chip).toBeDisabled();
            expect(chip).not.toHaveAttribute('data-task-edit-trigger');
        }

        // Read-only: clicking a projected chip is a no-op (the button is disabled,
        // so no click handler fires and nothing gets written back to the store).
        await act(async () => {
            fireEvent.click(projectedChips[0] as HTMLElement);
            await Promise.resolve();
        });
        expect(storeMocks.taskStoreState.updateTask).not.toHaveBeenCalled();
        expect(storeMocks.taskStoreState.deleteTask).not.toHaveBeenCalled();
    });

    it('refreshes recurrence projections and planning candidates after local midnight while open', async () => {
        vi.setSystemTime(new Date(2026, 3, 8, 23, 59, 59, 900));
        storeMocks.taskStoreState.tasks = [
            makeTask({
                id: 'task-unscheduled-monthly',
                title: 'Ninth day planning',
                recurrence: {
                    rule: 'monthly',
                    strategy: 'strict',
                    byMonthDay: [9],
                    rrule: 'FREQ=MONTHLY;BYMONTHDAY=9',
                },
                showFutureRecurrence: true,
            }),
            makeTask({
                id: 'task-no-deadline',
                title: 'No deadline',
                createdAt: '2026-04-01T00:00:00.000Z',
            }),
            makeTask({
                id: 'task-enters-due-soon',
                title: 'Enters due-soon window',
                dueDate: '2026-05-08',
                createdAt: '2026-04-02T00:00:00.000Z',
            }),
        ];

        let controller!: ReturnType<typeof useDesktopCalendarController>;
        render(
            <LanguageProvider>
                <DesktopControllerHost onResult={(value) => { controller = value; }} />
            </LanguageProvider>
        );
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        // This suite's lightweight safeParseDate mock parses date-only values as
        // UTC, so use the same instant that the projected `2026-04-09` start uses.
        const projectedOccurrenceDate = new Date('2026-04-09');
        expect(controller.getCalendarItemsForDate(projectedOccurrenceDate).some(
            (item) => 'task' in item && item.task.id === 'task-unscheduled-monthly'
        )).toBe(true);
        expect(controller.planningTasks.map((task) => task.id).indexOf('task-no-deadline'))
            .toBeLessThan(controller.planningTasks.map((task) => task.id).indexOf('task-enters-due-soon'));

        await act(async () => {
            vi.advanceTimersByTime(200);
            await Promise.resolve();
        });

        expect(controller.getCalendarItemsForDate(projectedOccurrenceDate).some(
            (item) => 'task' in item && item.task.id === 'task-unscheduled-monthly'
        )).toBe(false);
        expect(controller.planningTasks.map((task) => task.id).indexOf('task-enters-due-soon'))
            .toBeLessThan(controller.planningTasks.map((task) => task.id).indexOf('task-no-deadline'));
    });

    it('shares the 500-occurrence cap across all recurring series', async () => {
        storeMocks.taskStoreState.tasks = Array.from({ length: 20 }, (_, index) => makeTask({
            id: `task-recurring-${index}`,
            title: `Daily task ${index}`,
            dueDate: '2026-04-02',
            recurrence: 'daily',
            showFutureRecurrence: true,
        }));

        let controller!: ReturnType<typeof useDesktopCalendarController>;
        render(
            <LanguageProvider>
                <DesktopControllerHost onResult={(value) => { controller = value; }} />
            </LanguageProvider>
        );
        await flushCalendarEffects();

        const projectedIds = new Set<string>();
        for (let offset = 0; offset < 35; offset += 1) {
            const date = new Date(2026, 2, 29 + offset);
            controller.getCalendarItemsForDate(date).forEach((item) => {
                if ('task' in item && item.task.id.includes(':projected-recurrence:')) {
                    projectedIds.add(item.task.id);
                }
            });
        }

        expect(projectedIds).toHaveLength(500);
        for (let index = 0; index < 20; index += 1) {
            expect([...projectedIds].filter(
                (id) => id.startsWith(`task-recurring-${index}:projected-recurrence:`)
            )).toHaveLength(25);
        }
    });

    it("paints a weekly recurring task into the month grid's spill day from next month (correction pass finding 2)", async () => {
        // April 2026's grid is week-aligned and spills into 2026-03-29..2026-05-02 (35 cells) --
        // wider than the calendar month itself. A weekly task due 04-24 projects next to 05-01,
        // a spill day; before the fix the recurrence range only covered the month proper and
        // this occurrence was silently dropped even though the cell renders on screen.
        const recurringTask = makeTask({
            id: 'task-recurring-weekly-spill',
            title: 'Weekly sync',
            dueDate: '2026-04-24',
            recurrence: 'weekly',
            showFutureRecurrence: true,
        });
        storeMocks.taskStoreState.tasks = [recurringTask];

        renderCalendar();
        await flushCalendarEffects();

        const spillDayChip = document.querySelector(
            '[data-task-id^="task-recurring-weekly-spill:projected-recurrence:2026-05-01"]'
        );
        expect(spillDayChip).not.toBeNull();
    });

    it('counts a filtered recurring task once, not once per painted occurrence (correction pass finding 4)', async () => {
        const recurringTask = makeTask({
            id: 'task-recurring-daily-count',
            title: 'Daily standup',
            dueDate: '2026-04-02',
            recurrence: 'daily',
            showFutureRecurrence: true,
        });
        storeMocks.taskStoreState.tasks = [recurringTask];

        renderCalendar();
        await flushCalendarEffects();

        const searchInput = document.querySelector('[data-view-filter-input]') as HTMLInputElement;
        await act(async () => {
            fireEvent.change(searchInput, { target: { value: 'Daily standup' } });
            await Promise.resolve();
        });

        // Without keying on the source task, this would report one match per painted
        // day (dozens) instead of one match for the one recurring task.
        expect(screen.getByText('1 matches in this view')).toBeInTheDocument();
    });

    it('keeps completed work from archived projects in history without admitting deferred or deleted projects', async () => {
        const archivedProject = makeProject({ id: 'project-archived', status: 'archived' });
        const somedayProject = makeProject({ id: 'project-someday', status: 'someday' });
        const deletedProject = makeProject({
            id: 'project-deleted',
            deletedAt: '2026-04-07T00:00:00',
        });
        const archivedProjectTask = makeTask({
            id: 'task-archived-project',
            title: 'Finished archived project work',
            status: 'done',
            projectId: archivedProject.id,
            completedAt: '2026-04-08T10:00:00',
        });
        const somedayProjectTask = makeTask({
            id: 'task-someday-project',
            title: 'Deferred project history',
            status: 'done',
            projectId: somedayProject.id,
            completedAt: '2026-04-08T11:00:00',
        });
        const deletedProjectTask = makeTask({
            id: 'task-deleted-project',
            title: 'Deleted project history',
            status: 'done',
            projectId: deletedProject.id,
            completedAt: '2026-04-08T12:00:00',
        });
        storeMocks.taskStoreState.projects = [archivedProject, somedayProject, deletedProject];
        storeMocks.taskStoreState.tasks = [archivedProjectTask, somedayProjectTask, deletedProjectTask];
        storeMocks.taskStoreState._allTasks = [archivedProjectTask, somedayProjectTask, deletedProjectTask];

        renderCalendar();
        await flushCalendarEffects();
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Completed' }));
            await Promise.resolve();
        });

        expect(screen.getAllByText('Finished archived project work').length).toBeGreaterThan(0);
        expect(screen.queryByText('Deferred project history')).not.toBeInTheDocument();
        expect(screen.queryByText('Deleted project history')).not.toBeInTheDocument();
    });

    it('sets a task due date when dropped on a month day', async () => {
        storeMocks.taskStoreState.tasks = [
            makeTask({
                id: 'drop-task',
                title: 'Drop me',
            }),
        ];

        renderCalendar();
        await flushCalendarEffects();

        const dropTarget = document.querySelector('[data-calendar-drop-date="2026-04-04"]') as HTMLElement;
        expect(dropTarget).toBeTruthy();

        const dataTransfer = createTaskDragDataTransfer('drop-task');
        await act(async () => {
            fireEvent.dragOver(dropTarget, { dataTransfer });
            fireEvent.drop(dropTarget, { dataTransfer });
            await Promise.resolve();
        });

        expect(storeMocks.taskStoreState.updateTask).toHaveBeenCalledWith('drop-task', {
            dueDate: '2026-04-04',
        });
    });

    it('moves a deadline item without changing the scheduled start time', async () => {
        storeMocks.taskStoreState.tasks = [
            makeTask({
                id: 'mixed-drop-task',
                title: 'Mixed drop task',
                dueDate: '2026-04-03',
                startTime: '2026-04-03T09:00:00',
            }),
        ];

        renderCalendar();
        await flushCalendarEffects();

        const dropTarget = document.querySelector('[data-calendar-drop-date="2026-04-05"]') as HTMLElement;
        expect(dropTarget).toBeTruthy();

        const dataTransfer = createTaskDragDataTransfer('mixed-drop-task', 'deadline');
        await act(async () => {
            fireEvent.drop(dropTarget, { dataTransfer });
            await Promise.resolve();
        });

        expect(storeMocks.taskStoreState.updateTask).toHaveBeenCalledWith('mixed-drop-task', {
            dueDate: '2026-04-05',
        });
    });

    it('schedules a task when dropped on a timed calendar slot', async () => {
        window.history.replaceState(null, '', '/?calendarView=week&calendarDate=2026-04-03');
        storeMocks.taskStoreState.tasks = [
            makeTask({
                id: 'timed-drop-task',
                title: 'Schedule me',
            }),
        ];

        renderCalendar();
        await flushCalendarEffects();

        const dropTarget = document.querySelector('[data-calendar-timed-drop-date="2026-04-03"]') as HTMLElement;
        expect(dropTarget).toBeTruthy();
        Object.defineProperty(dropTarget, 'getBoundingClientRect', {
            value: () => ({
                bottom: 24 * 56,
                height: 24 * 56,
                left: 0,
                right: 320,
                top: 0,
                width: 320,
                x: 0,
                y: 0,
                toJSON: () => ({}),
            }),
        });

        const dataTransfer = createTaskDragDataTransfer('timed-drop-task');
        await act(async () => {
            const dragOverEvent = createEvent.dragOver(dropTarget, { dataTransfer });
            Object.defineProperty(dragOverEvent, 'clientY', { value: 9 * 56 });
            fireEvent(dropTarget, dragOverEvent);
            const dropEvent = createEvent.drop(dropTarget, { dataTransfer });
            Object.defineProperty(dropEvent, 'clientY', { value: 9 * 56 });
            fireEvent(dropTarget, dropEvent);
            await Promise.resolve();
        });

        expect(storeMocks.taskStoreState.updateTask).toHaveBeenCalledWith('timed-drop-task', {
            startTime: new Date(2026, 3, 3, 9, 0).toISOString(),
        });
    });

    it('moves an existing calendar task by dragging it to another day', async () => {
        storeMocks.taskStoreState.tasks = [
            makeTask({
                id: 'calendar-drag-task',
                title: 'Move me',
                dueDate: '2026-04-03T12:00:00',
            }),
        ];

        renderCalendar();
        await flushCalendarEffects();

        const taskButton = screen.getByRole('button', { name: /Move me/i });
        const dropTarget = document.querySelector('[data-calendar-drop-date="2026-04-05"]') as HTMLElement;
        expect(dropTarget).toBeTruthy();

        const dataTransfer = createTaskDragDataTransfer('');
        await act(async () => {
            fireEvent.dragStart(taskButton, { dataTransfer });
            fireEvent.drop(dropTarget, { dataTransfer });
            await Promise.resolve();
        });

        expect(storeMocks.taskStoreState.updateTask).toHaveBeenCalledWith('calendar-drag-task', {
            dueDate: '2026-04-05',
        });
    });

    it('moves an existing timed calendar task to another day without turning it into a deadline', async () => {
        storeMocks.taskStoreState.tasks = [
            makeTask({
                id: 'calendar-timed-drag-task',
                title: 'Move timed task',
                startTime: '2026-04-03T11:15:00',
            }),
        ];

        renderCalendar();
        await flushCalendarEffects();

        const taskButton = screen.getByRole('button', { name: /Move timed task/i });
        const dropTarget = document.querySelector('[data-calendar-drop-date="2026-04-05"]') as HTMLElement;
        expect(dropTarget).toBeTruthy();

        const dataTransfer = createTaskDragDataTransfer('');
        await act(async () => {
            fireEvent.dragStart(taskButton, { dataTransfer });
            fireEvent.drop(dropTarget, { dataTransfer });
            await Promise.resolve();
        });

        expect(storeMocks.taskStoreState.updateTask).toHaveBeenCalledWith('calendar-timed-drag-task', {
            startTime: new Date(2026, 3, 5, 11, 15).toISOString(),
        });
    });

    describe('quick-action menu on calendar blocks and chips', () => {
        let showToast: ReturnType<typeof vi.fn>;

        beforeEach(() => {
            showToast = vi.fn();
            useUiStore.setState({ showToast });
            clearUndoableAction();
        });

        it('right-clicking a scheduled block opens the quick menu without opening the task editor or starting a drag', async () => {
            storeMocks.taskStoreState.tasks = [
                makeTask({
                    id: 'scheduled-task',
                    title: 'Scheduled task',
                    startTime: '2026-04-04T09:00:00',
                }),
            ];

            renderCalendar();
            await flushCalendarEffects();

            const taskButton = screen.getByRole('button', { name: /Scheduled task/i });
            await act(async () => {
                fireEvent.contextMenu(taskButton);
                await Promise.resolve();
            });

            expect(screen.getByRole('menu')).toBeInTheDocument();
            expect(screen.getByRole('menuitem', { name: 'Remove from calendar' })).toBeInTheDocument();
            expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
            expect(storeMocks.taskStoreState.updateTask).not.toHaveBeenCalled();
        });

        it('clears startTime and relativeStartOffset for a scheduled block, and undo restores both exactly', async () => {
            storeMocks.taskStoreState.tasks = [
                makeTask({
                    id: 'scheduled-task',
                    title: 'Scheduled task',
                    startTime: '2026-04-04T09:00:00',
                    relativeStartOffset: { amount: -1, unit: 'day' },
                }),
            ];

            renderCalendar();
            await flushCalendarEffects();

            const taskButton = screen.getByRole('button', { name: /Scheduled task/i });
            await act(async () => {
                fireEvent.contextMenu(taskButton);
                await Promise.resolve();
            });

            await act(async () => {
                fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from calendar' }));
                await Promise.resolve();
            });

            // toHaveBeenCalledWith treats an explicit `key: undefined` the same
            // as an absent key, which would hide a dropped clear — assert the
            // key is actually present on the update object, not just its value.
            const removeCall = storeMocks.taskStoreState.updateTask.mock.calls.find(([id]) => id === 'scheduled-task');
            expect(removeCall).toBeTruthy();
            const removeUpdates = removeCall?.[1] as Record<string, unknown>;
            expect(Object.keys(removeUpdates).sort()).toEqual(['relativeStartOffset', 'startTime']);
            expect(removeUpdates.startTime).toBeUndefined();
            expect(removeUpdates.relativeStartOffset).toBeUndefined();

            expect(showToast).toHaveBeenCalledWith(
                'Remove from calendar',
                'info',
                5000,
                expect.objectContaining({ label: 'Undo' })
            );
            showToast.mock.calls[0][3].onClick();

            expect(storeMocks.taskStoreState.updateTask).toHaveBeenCalledWith('scheduled-task', {
                startTime: '2026-04-04T09:00:00',
                relativeStartOffset: { amount: -1, unit: 'day' },
            });
        });

        // The undo-notifications setting hides the toast, not Ctrl/Cmd+Z:
        // showUndoToast always registers, so the shortcut still restores the
        // cleared schedule even with the toast off.
        it('registers the undo but shows no toast when undo notifications are disabled', async () => {
            storeMocks.taskStoreState.settings = {
                ...storeMocks.taskStoreState.settings,
                undoNotificationsEnabled: false,
            };
            storeMocks.taskStoreState.tasks = [
                makeTask({
                    id: 'scheduled-task',
                    title: 'Scheduled task',
                    startTime: '2026-04-04T09:00:00',
                }),
            ];

            renderCalendar();
            await flushCalendarEffects();

            const taskButton = screen.getByRole('button', { name: /Scheduled task/i });
            await act(async () => {
                fireEvent.contextMenu(taskButton);
                await Promise.resolve();
            });
            await act(async () => {
                fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from calendar' }));
                await Promise.resolve();
            });

            expect(storeMocks.taskStoreState.updateTask).toHaveBeenCalled();
            expect(showToast).not.toHaveBeenCalled();

            takeUndoableAction()?.();
            expect(storeMocks.taskStoreState.updateTask).toHaveBeenCalledWith('scheduled-task', {
                startTime: '2026-04-04T09:00:00',
                relativeStartOffset: undefined,
            });
        });

        it('clears only dueDate for a due-date chip, leaving startTime untouched, and undo restores it exactly', async () => {
            storeMocks.taskStoreState.tasks = [
                makeTask({
                    id: 'mixed-task',
                    title: 'Mixed task',
                    dueDate: '2026-04-06',
                    startTime: '2026-04-04T09:00:00',
                }),
            ];

            renderCalendar();
            await flushCalendarEffects();

            // The task renders twice (a scheduled block on Apr 4 and a deadline
            // chip on its due day) — pick the one that is NOT on the known
            // scheduled day, since date-only values like dueDate parse as UTC
            // midnight and can land a calendar day earlier or later depending
            // on the test machine's timezone.
            const chips = screen.getAllByRole('button', { name: /Mixed task/i });
            const dueChip = chips.find((chip) => (
                chip.closest('[data-calendar-drop-date]')?.getAttribute('data-calendar-drop-date') !== '2026-04-04'
            ));
            expect(dueChip).toBeTruthy();

            await act(async () => {
                fireEvent.contextMenu(dueChip as HTMLElement);
                await Promise.resolve();
            });
            await act(async () => {
                fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from calendar' }));
                await Promise.resolve();
            });

            // toHaveBeenCalledWith elides explicit `key: undefined` properties on
            // both sides, so an accidental extra `startTime: undefined` in the
            // update would slip past a plain equality check — assert the key set
            // directly instead.
            const removeCall = storeMocks.taskStoreState.updateTask.mock.calls.find(([id]) => id === 'mixed-task');
            expect(removeCall).toBeTruthy();
            const removeUpdates = removeCall?.[1] as Record<string, unknown>;
            expect(Object.keys(removeUpdates)).toEqual(['dueDate']);
            expect(removeUpdates.dueDate).toBeUndefined();

            showToast.mock.calls[0][3].onClick();

            const undoCall = storeMocks.taskStoreState.updateTask.mock.calls
                .slice(1)
                .find(([id]) => id === 'mixed-task');
            expect(undoCall).toBeTruthy();
            const undoUpdates = undoCall?.[1] as Record<string, unknown>;
            expect(Object.keys(undoUpdates).sort()).toEqual(['dueDate', 'relativeStartOffset']);
            expect(undoUpdates.dueDate).toBe('2026-04-06');
            expect(undoUpdates.relativeStartOffset).toBeUndefined();
        });
    });
});
