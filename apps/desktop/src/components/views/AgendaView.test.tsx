import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { safeFormatDate, useTaskStore, type Project, type Task } from '@mindwtr/core';
import { LanguageProvider } from '../../contexts/language-context';
import { AgendaView } from './AgendaView';
import { useUiStore } from '../../store/ui-store';
import { MINDWTR_NAVIGATE_EVENT } from '../../lib/navigation-events';
import { selectToolbarOption } from '../../test/toolbar-select';
import { expectScrolledEndGap } from '../../test/list-end-gap';

// Capture the focus-drag handler so tests can drive a drop without a real
// pointer gesture; dnd-kit contexts render as passthroughs (see BoardView.test).
let capturedFocusDndProps: { onDragEnd?: (event: unknown) => void } = {};
vi.mock('@dnd-kit/core', () => ({
    DndContext: ({ children, onDragEnd }: { children: React.ReactNode; onDragEnd?: (event: unknown) => void }) => {
        capturedFocusDndProps = { onDragEnd };
        return <div>{children}</div>;
    },
    DragOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    PointerSensor: class {},
    KeyboardSensor: class {},
    closestCenter: () => null,
    useSensor: () => ({}),
    useSensors: () => [],
}));
vi.mock('@dnd-kit/sortable', () => ({
    SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    verticalListSortingStrategy: {},
    sortableKeyboardCoordinates: () => ({}),
    arrayMove: <T,>(items: T[], from: number, to: number) => {
        const next = items.slice();
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        return next;
    },
    useSortable: () => ({
        attributes: {},
        listeners: {},
        setNodeRef: () => {},
        transform: null,
        transition: undefined,
        isDragging: false,
    }),
}));

const nowIso = '2026-02-28T12:00:00.000Z';
const focusViewStateStorageKey = 'mindwtr:view:focus:v1';

const focusedTask: Task = {
    id: 'focused-task',
    title: 'Focused task',
    status: 'next',
    isFocusedToday: true,
    checklist: [
        { id: 'item-1', title: 'Checklist item', isCompleted: false },
    ],
    tags: [],
    contexts: [],
    createdAt: nowIso,
    updatedAt: nowIso,
};

const renderAgenda = () => render(
    <LanguageProvider>
        <AgendaView />
    </LanguageProvider>
);

describe('AgendaView', () => {
    beforeEach(() => {
        window.localStorage.removeItem(focusViewStateStorageKey);
        useTaskStore.setState({
            tasks: [focusedTask],
            _allTasks: [focusedTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            error: null,
            highlightTaskId: null,
        });
        useUiStore.setState({
            listOptions: {
                showDetails: false,
                focusGroupBy: 'none', inboxGroupBy: 'none', nextGroupBy: 'none',
                waitingGroupBy: 'none', somedayGroupBy: 'none',
                referenceGroupBy: 'area', doneGroupBy: 'none', archivedGroupBy: 'none',
                focusTop3Only: false,
            },
            expandedTaskIds: {},
            projectView: { selectedProjectId: null },
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('shows a starred task even when its project is not active (counted slot must be visible)', () => {
        // A starred task inside a someday project used to vanish from Today's
        // Focus while still consuming a focus-limit slot — "I can only star 4
        // when the limit is 5", unfixable by any filter change.
        const somedayProject = {
            id: 'proj-someday',
            title: 'Parked project',
            status: 'someday',
            order: 0,
            tagIds: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        } as unknown as Project;
        const parkedStarred: Task = {
            ...focusedTask,
            id: 'parked-starred',
            title: 'Starred inside parked project',
            checklist: undefined,
            projectId: 'proj-someday',
        };
        useTaskStore.setState({
            tasks: [focusedTask, parkedStarred],
            _allTasks: [focusedTask, parkedStarred],
            projects: [somedayProject],
            _allProjects: [somedayProject],
        });

        const { getByText } = renderAgenda();

        expect(getByText('Starred inside parked project')).toBeInTheDocument();
    });

    it('shows a starred task whose start time is later today', () => {
        vi.useFakeTimers({ now: new Date(nowIso), toFake: ['Date'] });
        const laterToday: Task = {
            ...focusedTask,
            id: 'later-today-starred',
            title: 'Starred starting tonight',
            checklist: undefined,
            startTime: '2026-02-28T22:00:00.000Z',
        };
        useTaskStore.setState({
            tasks: [focusedTask, laterToday],
            _allTasks: [focusedTask, laterToday],
        });

        const { getByText } = renderAgenda();

        expect(getByText('Starred starting tonight')).toBeInTheDocument();
    });

    it('ends the page with the shared end gap on its scrolled content (#977)', () => {
        const { container } = renderAgenda();
        expectScrolledEndGap(container);
    });

    it('keeps focus task details open when checklist items are toggled', async () => {
        const { getByRole, getByText } = renderAgenda();

        fireEvent.click(getByRole('button', { name: /toggle task details/i }));
        const checklistItem = getByText('Checklist item');
        expect(checklistItem).toBeInTheDocument();

        fireEvent.click(checklistItem);

        expect(getByText('Checklist item')).toBeInTheDocument();
    });

    it('uses a neutral surface for today focus in dark mode', () => {
        const { getByTestId } = renderAgenda();

        const sectionClassName = getByTestId('todays-focus-section').className;
        expect(sectionClassName).toContain('bg-card/70');
        expect(sectionClassName).toContain('border-l-amber-400');
        expect(sectionClassName).not.toContain('dark:from-yellow');
        expect(sectionClassName).not.toContain('dark:to-amber');
    });

    it('keeps today focus visible when Top 3 mode is enabled', () => {
        const task = (id: string, title: string, createdAt: string): Task => ({
            id,
            title,
            status: 'next',
            tags: [],
            contexts: [],
            createdAt,
            updatedAt: createdAt,
        });
        const tasks = [
            focusedTask,
            task('top-1', 'Top task 1', '2026-02-28T09:00:00.000Z'),
            task('top-2', 'Top task 2', '2026-02-28T10:00:00.000Z'),
            task('top-3', 'Top task 3', '2026-02-28T11:00:00.000Z'),
            task('top-4', 'Top task 4', '2026-02-28T12:00:00.000Z'),
        ];

        useTaskStore.setState({
            tasks,
            _allTasks: tasks,
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            error: null,
            highlightTaskId: null,
        });
        useUiStore.setState((state) => ({
            ...state,
            listOptions: {
                ...state.listOptions,
                focusTop3Only: true,
            },
        }));

        const { getByTestId, getByText, queryByText } = renderAgenda();

        expect(getByTestId('todays-focus-section')).toBeInTheDocument();
        expect(getByText('Focused task')).toBeInTheDocument();
        expect(getByText('Top task 1')).toBeInTheDocument();
        expect(getByText('Top task 2')).toBeInTheDocument();
        expect(getByText('Top task 3')).toBeInTheDocument();
        expect(queryByText('Top task 4')).not.toBeInTheDocument();
    });

    it('collapses expanded task details when page details are turned off', () => {
        const nextTask: Task = {
            id: 'next-action-task',
            title: 'Next action task',
            status: 'next',
            description: 'Expanded task note',
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [nextTask],
            _allTasks: [nextTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });
        useUiStore.setState((state) => ({
            ...state,
            listOptions: {
                ...state.listOptions,
                showDetails: true,
            },
            expandedTaskIds: { 'next-action-task': true },
        }));

        const { getByRole, queryByText } = renderAgenda();

        expect(queryByText('Expanded task note')).toBeInTheDocument();

        fireEvent.click(getByRole('button', { name: /^hide details$/i }));

        expect(queryByText('Expanded task note')).not.toBeInTheDocument();
        expect(useUiStore.getState().listOptions.showDetails).toBe(false);
        expect(useUiStore.getState().expandedTaskIds).toEqual({});
    });

    it('keeps non-next tasks with start time today out of Today', () => {
        const now = new Date();
        const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0, 0).toISOString();
        const startTodayTask: Task = {
            id: 'start-today-task',
            title: 'Start today inbox task',
            status: 'inbox',
            startTime: startToday,
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [startTodayTask],
            _allTasks: [startTodayTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { queryByRole, queryByText } = renderAgenda();

        expect(queryByRole('heading', { name: /today/i })).not.toBeInTheDocument();
        expect(queryByText('Start today inbox task')).not.toBeInTheDocument();
    });

    it('previews deferred and recurring tasks surfacing within a week under Upcoming (#1061)', () => {
        const now = new Date();
        const inThreeDays = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3, 9, 0, 0, 0);
        const inTwelveDays = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 12, 9, 0, 0, 0);
        const deferredTask: Task = {
            id: 'deferred-task',
            title: 'Deferred prep task',
            status: 'next',
            startTime: inThreeDays.toISOString(),
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const recurringTask: Task = {
            id: 'recurring-task',
            title: 'Weekly meeting task',
            status: 'next',
            dueDate: inThreeDays.toISOString(),
            recurrence: { rule: 'weekly' },
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const farTask: Task = {
            id: 'far-task',
            title: 'Far away task',
            status: 'next',
            startTime: inTwelveDays.toISOString(),
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [deferredTask, recurringTask, farTask],
            _allTasks: [deferredTask, recurringTask, farTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { getByText, queryByText } = renderAgenda();

        expect(getByText('Upcoming')).toBeInTheDocument();
        expect(getByText('Deferred prep task')).toBeInTheDocument();
        expect(getByText('Weekly meeting task')).toBeInTheDocument();
        expect(queryByText('Far away task')).not.toBeInTheDocument();
    });

    it('disables the Upcoming star and shows when each row appears', () => {
        const now = new Date();
        const inThreeDays = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3, 9, 0, 0, 0);
        const deferredTask: Task = {
            id: 'deferred-task',
            title: 'Deferred prep task',
            status: 'next',
            startTime: inThreeDays.toISOString(),
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [deferredTask],
            _allTasks: [deferredTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { getByText, getByLabelText } = renderAgenda();

        const upcomingSection = document.getElementById('agenda-section-upcoming');
        expect(upcomingSection).not.toBeNull();
        // Every Upcoming row is deferred, so the star states the reason instead of
        // offering an "Add to Focus" whose only outcome is a refusal toast.
        const star = getByLabelText('This task is deferred; change its start date before focusing it.');
        expect(upcomingSection).toContainElement(star);
        expect(star).toBeDisabled();
        // The reveal date is the section's purpose, so it renders on the row.
        expect(upcomingSection).toContainElement(getByText(safeFormatDate(inThreeDays, 'P')));
    });

    it('shows a start-deferred upcoming date once, not as a duplicate appears-on chip', () => {
        const now = new Date();
        // Date-only start, like the report: chip and appears-on label format identically.
        const inThreeDays = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3);
        const dateOnlyStart = `${inThreeDays.getFullYear()}-${String(inThreeDays.getMonth() + 1).padStart(2, '0')}-${String(inThreeDays.getDate()).padStart(2, '0')}`;
        const deferredTask: Task = {
            id: 'deferred-task',
            title: 'Deferred prep task',
            status: 'next',
            startTime: dateOnlyStart,
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [deferredTask],
            _allTasks: [deferredTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });
        // Details on: the row renders its own start chip for the same day.
        useUiStore.setState((state) => ({
            listOptions: { ...state.listOptions, showDetails: true },
        }));

        const { getAllByText } = renderAgenda();

        const upcomingSection = document.getElementById('agenda-section-upcoming');
        expect(upcomingSection).not.toBeNull();
        // The date renders exactly once — the start chip. The appears-on badge
        // yields to it instead of duplicating the same day (Discord report).
        expect(getAllByText(safeFormatDate(inThreeDays, 'P'))).toHaveLength(1);
    });

    it('shows an empty state when active tasks do not produce agenda sections', () => {
        const inboxTask: Task = {
            id: 'inbox-task',
            title: 'Inbox only task',
            status: 'inbox',
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [inboxTask],
            _allTasks: [inboxTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            error: null,
            highlightTaskId: null,
        });

        const { getByText, queryByText } = renderAgenda();

        expect(getByText('All Clear!')).toBeInTheDocument();
        expect(getByText('Nothing to focus on right now. Star a task or give it a due date and it will show up here.')).toBeInTheDocument();
        expect(queryByText('Inbox only task')).not.toBeInTheDocument();
    });

    it('shows capture guidance in the empty state when there are no tasks at all', () => {
        useTaskStore.setState({
            tasks: [],
            _allTasks: [],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            error: null,
            highlightTaskId: null,
        });

        const { getByText } = renderAgenda();

        expect(getByText('All Clear!')).toBeInTheDocument();
        expect(getByText('No tasks yet. Add whatever is on your mind to the Inbox and sort it out later.')).toBeInTheDocument();
    });

    it('does not show the saved-filter chip row when no Focus filters exist', () => {
        const { queryByRole } = renderAgenda();

        expect(queryByRole('button', { name: 'All' })).not.toBeInTheDocument();
        expect(queryByRole('button', { name: 'New saved filter' })).not.toBeInTheDocument();
    });

    it('keeps Focus filters collapsed until opened from the header', () => {
        const { getByRole, getByPlaceholderText, queryByPlaceholderText } = renderAgenda();

        expect(queryByPlaceholderText('Search...')).not.toBeInTheDocument();

        fireEvent.click(getByRole('button', { name: /^Filters$/i }));

        expect(getByPlaceholderText('Search...')).toBeInTheDocument();
    });

    it('does not let earlier non-Focus tasks hide the next task in a sequential project', () => {
        const project = {
            id: 'project-1',
            title: 'Sequential project',
            status: 'active' as const,
            isSequential: true,
            color: '#123456',
            order: 0,
            tagIds: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const inboxBefore: Task = {
            id: 'inbox-before',
            title: 'Inbox before',
            status: 'inbox',
            projectId: project.id,
            order: 0,
            orderNum: 0,
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const availableNext: Task = {
            id: 'available-next',
            title: 'Available next',
            status: 'next',
            projectId: project.id,
            order: 1,
            orderNum: 1,
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [inboxBefore, availableNext],
            _allTasks: [inboxBefore, availableNext],
            projects: [project],
            _allProjects: [project],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { getByRole, getByText, queryByText } = renderAgenda();

        expect(getByRole('heading', { name: /next actions/i })).toBeInTheDocument();
        expect(getByText('Available next')).toBeInTheDocument();
        expect(queryByText('Inbox before')).not.toBeInTheDocument();
    });

    it('shows next tasks with start time today in Today section (not Next Actions)', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 1, 28, 12, 0, 0, 0));
        const now = new Date();
        const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0, 0).toISOString();
        const startTodayNextTask: Task = {
            id: 'start-today-next-task',
            title: 'Start today next task',
            status: 'next',
            startTime: startToday,
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [startTodayNextTask],
            _allTasks: [startTodayNextTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { getByRole, getByText, queryByRole } = renderAgenda();

        expect(getByRole('heading', { name: /today/i })).toBeInTheDocument();
        expect(getByText('Start today next task')).toBeInTheDocument();
        expect(queryByRole('heading', { name: /next actions/i })).not.toBeInTheDocument();
    });

    it('always hides future-start next actions without a visibility control', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-02-28T12:00:00.000Z'));

        const futureStartTask: Task = {
            id: 'future-start-next-task',
            title: 'Future start next task',
            status: 'next',
            startTime: '2026-03-03T09:00:00.000Z',
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [futureStartTask],
            _allTasks: [futureStartTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: { appearance: { showFutureStarts: true } },
            highlightTaskId: null,
        });

        const { getByText, queryByRole, queryByText } = renderAgenda();

        // The task previews under Upcoming (#1061) — never in Today/Next, and
        // still with no visibility toggle: the list-view showFutureStarts
        // setting has no lever here.
        const upcomingSection = document.getElementById('agenda-section-upcoming');
        expect(upcomingSection).not.toBeNull();
        expect(upcomingSection).toContainElement(getByText('Future start next task'));
        expect(queryByText(/hidden \(future start\)/)).not.toBeInTheDocument();
        expect(queryByRole('button', { name: /^(show|hide)$/i })).not.toBeInTheDocument();
    });

    it('refreshes date-sensitive sections at local midnight', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 2, 2, 23, 59, 59, 900));
        const futureStartTask: Task = {
            id: 'starts-tomorrow',
            title: 'Starts tomorrow',
            status: 'next',
            startTime: '2026-03-03',
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        useTaskStore.setState({
            tasks: [futureStartTask],
            _allTasks: [futureStartTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { getByText } = renderAgenda();
        // Still tomorrow's task: visible only as an Upcoming preview.
        expect(document.getElementById('agenda-section-upcoming')).toContainElement(getByText('Starts tomorrow'));

        act(() => {
            vi.advanceTimersByTime(200);
        });

        // Midnight passed: the task graduates out of Upcoming into Today.
        expect(getByText('Starts tomorrow')).toBeInTheDocument();
        expect(document.getElementById('agenda-section-upcoming')).toBeNull();
    });

    it('refreshes date-sensitive sections when the desktop becomes visible on a new day', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 2, 2, 10, 0, 0));
        const futureStartTask: Task = {
            id: 'starts-tomorrow',
            title: 'Starts tomorrow',
            status: 'next',
            startTime: '2026-03-03',
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        useTaskStore.setState({
            tasks: [futureStartTask],
            _allTasks: [futureStartTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { getByText } = renderAgenda();
        // Still tomorrow's task: visible only as an Upcoming preview.
        expect(document.getElementById('agenda-section-upcoming')).toContainElement(getByText('Starts tomorrow'));

        vi.setSystemTime(new Date(2026, 2, 3, 10, 0, 0));
        act(() => {
            document.dispatchEvent(new Event('visibilitychange'));
        });

        expect(getByText('Starts tomorrow')).toBeInTheDocument();
        expect(document.getElementById('agenda-section-upcoming')).toBeNull();
    });

    it('removes focused tasks immediately when a local edit makes them ineligible', async () => {
        useTaskStore.setState({
            tasks: [focusedTask],
            _allTasks: [focusedTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: { deviceId: 'test-device' },
            error: null,
            highlightTaskId: null,
            lastDataChangeAt: 0,
        });

        const { getByText, queryByText } = renderAgenda();
        expect(getByText('Focused task')).toBeInTheDocument();

        await act(async () => {
            await useTaskStore.getState().updateTask('focused-task', {
                startTime: '2099-03-03T09:00:00.000Z',
            });
        });

        await waitFor(() => {
            expect(queryByText('Focused task')).not.toBeInTheDocument();
        });
    });

    it('does not show later sequential actions when the first action has a hidden future start', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-02-28T12:00:00.000Z'));

        const project = {
            id: 'project-1',
            title: 'Sequential project',
            status: 'active' as const,
            isSequential: true,
            color: '#123456',
            order: 0,
            tagIds: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const futureFirst: Task = {
            id: 'future-first',
            title: 'Future first',
            status: 'next',
            projectId: project.id,
            order: 0,
            orderNum: 0,
            startTime: '2026-03-03T09:00:00.000Z',
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const followingNext: Task = {
            id: 'following-next',
            title: 'Following next',
            status: 'next',
            projectId: project.id,
            order: 1,
            orderNum: 1,
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [futureFirst, followingNext],
            _allTasks: [futureFirst, followingNext],
            projects: [project],
            _allProjects: [project],
            areas: [],
            _allAreas: [],
            settings: { appearance: { showFutureStarts: true } },
            highlightTaskId: null,
        });

        const { getByText, queryByText } = renderAgenda();

        // The deferred first action previews under Upcoming; the follower stays
        // sequentially blocked and appears nowhere.
        expect(document.getElementById('agenda-section-upcoming')).toContainElement(getByText('Future first'));
        expect(queryByText('Following next')).not.toBeInTheDocument();
    });

    it('shows due-soon next actions before undated tasks and sinks far-future due tasks', () => {
        vi.useFakeTimers();
        const now = new Date('2026-02-28T12:00:00.000Z');
        vi.setSystemTime(now);

        const soonTask: Task = {
            id: 'soon-task',
            title: 'Soon task',
            status: 'next',
            dueDate: '2026-03-05T09:00:00.000Z',
            tags: [],
            contexts: [],
            createdAt: '2026-02-20T00:00:00.000Z',
            updatedAt: '2026-02-20T00:00:00.000Z',
        };
        const undatedTask: Task = {
            id: 'undated-task',
            title: 'Undated task',
            status: 'next',
            tags: [],
            contexts: [],
            createdAt: '2026-02-21T00:00:00.000Z',
            updatedAt: '2026-02-21T00:00:00.000Z',
        };
        const futureTask: Task = {
            id: 'future-task',
            title: 'Future task',
            status: 'next',
            dueDate: '2027-04-01T09:00:00.000Z',
            tags: [],
            contexts: [],
            createdAt: '2026-02-22T00:00:00.000Z',
            updatedAt: '2026-02-22T00:00:00.000Z',
        };

        useTaskStore.setState({
            tasks: [futureTask, undatedTask, soonTask],
            _allTasks: [futureTask, undatedTask, soonTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { container, getByRole } = renderAgenda();
        expect(getByRole('heading', { name: /next actions/i })).toBeInTheDocument();

        const soonRow = container.querySelector('[data-task-id="soon-task"]');
        const undatedRow = container.querySelector('[data-task-id="undated-task"]');
        const futureRow = container.querySelector('[data-task-id="future-task"]');

        expect(soonRow).toBeTruthy();
        expect(undatedRow).toBeTruthy();
        expect(futureRow).toBeTruthy();
        expect(soonRow!.compareDocumentPosition(undatedRow!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(undatedRow!.compareDocumentPosition(futureRow!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('surfaces one next action from a project due today before unrelated undated tasks', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-02-28T12:00:00.000Z'));

        const project: Project = {
            id: 'due-project',
            title: 'Due project',
            status: 'active',
            dueDate: '2026-02-28T17:00:00.000Z',
            color: '#123456',
            order: 0,
            tagIds: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const unrelatedTask: Task = {
            id: 'unrelated-next',
            title: 'Unrelated next',
            status: 'next',
            tags: [],
            contexts: [],
            createdAt: '2026-02-20T00:00:00.000Z',
            updatedAt: '2026-02-20T00:00:00.000Z',
        };
        const projectSecond: Task = {
            id: 'project-second',
            title: 'Project second',
            status: 'next',
            projectId: project.id,
            order: 1,
            orderNum: 1,
            tags: [],
            contexts: [],
            createdAt: '2026-02-21T00:00:00.000Z',
            updatedAt: '2026-02-21T00:00:00.000Z',
        };
        const projectFirst: Task = {
            id: 'project-first',
            title: 'Project first',
            status: 'next',
            projectId: project.id,
            order: 0,
            orderNum: 0,
            tags: [],
            contexts: [],
            createdAt: '2026-02-22T00:00:00.000Z',
            updatedAt: '2026-02-22T00:00:00.000Z',
        };

        useTaskStore.setState({
            tasks: [unrelatedTask, projectSecond, projectFirst],
            _allTasks: [unrelatedTask, projectSecond, projectFirst],
            projects: [project],
            _allProjects: [project],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { container, getByText } = renderAgenda();
        const firstRow = container.querySelector('[data-task-id="project-first"]');
        const unrelatedRow = container.querySelector('[data-task-id="unrelated-next"]');
        const secondRow = container.querySelector('[data-task-id="project-second"]');

        expect(firstRow).toBeTruthy();
        expect(unrelatedRow).toBeTruthy();
        expect(secondRow).toBeTruthy();
        expect(firstRow!.compareDocumentPosition(unrelatedRow!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(unrelatedRow!.compareDocumentPosition(secondRow!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(getByText('Project due today')).toBeInTheDocument();
        expect(projectFirst.dueDate).toBeUndefined();
    });

    it('keeps waiting tasks with review dates out of Today', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 1, 28, 12, 0, 0, 0));
        const now = new Date();
        const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0, 0).toISOString();
        const reviewDue = new Date(now.getTime() - 60_000).toISOString();
        const waitingTask: Task = {
            id: 'waiting-review-task',
            title: 'Waiting review task',
            status: 'waiting',
            startTime: startToday,
            reviewAt: reviewDue,
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [waitingTask],
            _allTasks: [waitingTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { getAllByText, getByRole, queryByRole } = renderAgenda();

        expect(queryByRole('heading', { name: /today/i })).not.toBeInTheDocument();
        expect(getByRole('heading', { name: /review due/i })).toBeInTheDocument();
        expect(getAllByText('Waiting review task')).toHaveLength(1);
    });

    it('opens a project due for review from Focus', () => {
        const now = new Date();
        const reviewProject: Project = {
            id: 'review-project',
            title: 'Project to revisit',
            status: 'active',
            color: '#3b82f6',
            order: 0,
            tagIds: [],
            reviewAt: new Date(now.getTime() - 60_000).toISOString(),
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const onNavigate = vi.fn((event: Event) => (event as CustomEvent).detail);
        window.addEventListener(MINDWTR_NAVIGATE_EVENT, onNavigate as EventListener);

        useTaskStore.setState({
            tasks: [],
            _allTasks: [],
            projects: [reviewProject],
            _allProjects: [reviewProject],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        try {
            const { getByRole } = renderAgenda();

            fireEvent.click(getByRole('button', { name: /open project to revisit/i }));

            expect(useUiStore.getState().projectView.selectedProjectId).toBe('review-project');
            expect(onNavigate).toHaveReturnedWith({ view: 'projects' });
        } finally {
            window.removeEventListener(MINDWTR_NAVIGATE_EVENT, onNavigate as EventListener);
        }
    });

    it('opens editor when double-clicking a non-focused task row in Focus', () => {
        const nextTask: Task = {
            id: 'next-action-task',
            title: 'Next action task',
            status: 'next',
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [nextTask],
            _allTasks: [nextTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { container, getByDisplayValue } = renderAgenda();
        const row = container.querySelector('[data-task-id="next-action-task"]');
        expect(row).toBeTruthy();

        fireEvent.doubleClick(row!);
        expect(getByDisplayValue('Next action task')).toBeInTheDocument();
    });

    it('groups next actions by context in Focus view', () => {
        const workTask: Task = {
            id: 'next-work-task',
            title: 'Work next task',
            status: 'next',
            contexts: ['@work'],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const homeTask: Task = {
            id: 'next-home-task',
            title: 'Home next task',
            status: 'next',
            contexts: ['@home'],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [workTask, homeTask],
            _allTasks: [workTask, homeTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { getByText } = renderAgenda();
        selectToolbarOption('Group', 'Context');

        expect(getByText('@work')).toBeInTheDocument();
        expect(getByText('@home')).toBeInTheDocument();
        expect(getByText('Work next task')).toBeInTheDocument();
        expect(getByText('Home next task')).toBeInTheDocument();
    });

    it('groups next actions by project in Focus view', () => {
        const projectTask: Task = {
            id: 'project-task',
            title: 'Project task',
            status: 'next',
            projectId: 'project-alpha',
            contexts: [],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const noProjectTask: Task = {
            id: 'no-project-task',
            title: 'Standalone task',
            status: 'next',
            contexts: [],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const projects = [{
            id: 'project-alpha',
            title: 'Alpha project',
            status: 'active' as const,
            color: '#123456',
            order: 0,
            tagIds: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        }];

        useTaskStore.setState({
            tasks: [projectTask, noProjectTask],
            _allTasks: [projectTask, noProjectTask],
            projects,
            _allProjects: projects,
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { getByText } = renderAgenda();
        selectToolbarOption('Group', 'Project');

        expect(getByText('Alpha project')).toBeInTheDocument();
        expect(getByText('No Project')).toBeInTheDocument();
        expect(getByText('Project task')).toBeInTheDocument();
        expect(getByText('Standalone task')).toBeInTheDocument();
    });

    it('groups next actions by priority in Focus view', () => {
        const urgentTask: Task = {
            id: 'urgent-task',
            title: 'Urgent task',
            status: 'next',
            priority: 'urgent',
            contexts: [],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const lowTask: Task = {
            id: 'low-task',
            title: 'Low task',
            status: 'next',
            priority: 'low',
            contexts: [],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const noPriorityTask: Task = {
            id: 'no-priority-task',
            title: 'No priority task',
            status: 'next',
            contexts: [],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [lowTask, noPriorityTask, urgentTask],
            _allTasks: [lowTask, noPriorityTask, urgentTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { getByText } = renderAgenda();
        selectToolbarOption('Group', 'Priority');

        expect(getByText('Urgent')).toBeInTheDocument();
        expect(getByText('Low')).toBeInTheDocument();
        expect(getByText('No priority')).toBeInTheDocument();
        expect(getByText('Urgent task')).toBeInTheDocument();
        expect(getByText('Low task')).toBeInTheDocument();
        expect(getByText('No priority task')).toBeInTheDocument();
    });

    it('filters focus tasks by project', () => {
        const projectTask: Task = {
            id: 'project-task',
            title: 'Project task',
            status: 'next',
            projectId: 'project-alpha',
            contexts: [],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const otherTask: Task = {
            id: 'other-task',
            title: 'Other task',
            status: 'next',
            projectId: 'project-beta',
            contexts: [],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const projects = [
            {
                id: 'project-alpha',
                title: 'Alpha project',
                status: 'active' as const,
                color: '#123456',
                order: 0,
                tagIds: [],
                createdAt: nowIso,
                updatedAt: nowIso,
            },
            {
                id: 'project-beta',
                title: 'Beta project',
                status: 'active' as const,
                color: '#654321',
                order: 1,
                tagIds: [],
                createdAt: nowIso,
                updatedAt: nowIso,
            },
        ];

        useTaskStore.setState({
            tasks: [projectTask, otherTask],
            _allTasks: [projectTask, otherTask],
            projects,
            _allProjects: projects,
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { getByRole, getByText, queryByText } = renderAgenda();

        fireEvent.click(getByRole('button', { name: /^Filters$/i }));
        fireEvent.click(getByRole('button', { name: 'Alpha project' }));

        expect(getByText('Project task')).toBeInTheDocument();
        expect(queryByText('Other task')).not.toBeInTheDocument();
    });

    it('filters focus tasks with the no-project option', () => {
        const projectTask: Task = {
            id: 'project-task',
            title: 'Project task',
            status: 'next',
            projectId: 'project-alpha',
            contexts: [],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const noProjectTask: Task = {
            id: 'no-project-task',
            title: 'Standalone task',
            status: 'next',
            contexts: [],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const projects = [{
            id: 'project-alpha',
            title: 'Alpha project',
            status: 'active' as const,
            color: '#123456',
            order: 0,
            tagIds: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        }];

        useTaskStore.setState({
            tasks: [projectTask, noProjectTask],
            _allTasks: [projectTask, noProjectTask],
            projects,
            _allProjects: projects,
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { getByRole, getByText, queryByText } = renderAgenda();

        fireEvent.click(getByRole('button', { name: /^Filters$/i }));
        fireEvent.click(getByRole('button', { name: 'No Project' }));

        expect(getByText('Standalone task')).toBeInTheDocument();
        expect(queryByText('Project task')).not.toBeInTheDocument();
    });

    it('filters focus tasks by energy level', () => {
        const lowEnergyTask: Task = {
            id: 'low-energy-task',
            title: 'Low energy task',
            status: 'next',
            energyLevel: 'low',
            contexts: [],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const highEnergyTask: Task = {
            id: 'high-energy-task',
            title: 'High energy task',
            status: 'next',
            energyLevel: 'high',
            contexts: [],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [lowEnergyTask, highEnergyTask],
            _allTasks: [lowEnergyTask, highEnergyTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { getByRole, getByText, queryByText } = renderAgenda();

        fireEvent.click(getByRole('button', { name: /^Filters$/i }));
        fireEvent.click(getByRole('button', { name: 'High energy' }));

        expect(getByText('High energy task')).toBeInTheDocument();
        expect(queryByText('Low energy task')).not.toBeInTheDocument();
    });

    it('shows an empty state when filters match no visible focus tasks', () => {
        const lowEnergyTask: Task = {
            id: 'low-energy-task',
            title: 'Low energy task',
            status: 'next',
            energyLevel: 'low',
            contexts: [],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [lowEnergyTask],
            _allTasks: [lowEnergyTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            error: null,
            highlightTaskId: null,
        });

        const { getByRole, getByText, queryByText } = renderAgenda();

        fireEvent.click(getByRole('button', { name: /^Filters$/i }));
        fireEvent.click(getByRole('button', { name: 'High energy' }));

        expect(queryByText('Low energy task')).not.toBeInTheDocument();
        expect(getByText('No tasks match these filters.')).toBeInTheDocument();
    });

    it('can switch multiple context filters from all to any matching', () => {
        const deskTask: Task = {
            id: 'desk-task',
            title: 'Desk task',
            status: 'next',
            contexts: ['@desk'],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const phoneTask: Task = {
            id: 'phone-task',
            title: 'Phone task',
            status: 'next',
            contexts: ['@phone'],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const deskPhoneTask: Task = {
            id: 'desk-phone-task',
            title: 'Desk and phone task',
            status: 'next',
            contexts: ['@desk', '@phone'],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [deskTask, phoneTask, deskPhoneTask],
            _allTasks: [deskTask, phoneTask, deskPhoneTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            error: null,
            highlightTaskId: null,
        });

        const { getByRole, getByText, queryByText } = renderAgenda();

        fireEvent.click(getByRole('button', { name: /^Filters$/i }));
        fireEvent.click(getByRole('button', { name: '@desk' }));
        fireEvent.click(getByRole('button', { name: '@phone' }));

        expect(queryByText('Desk task')).not.toBeInTheDocument();
        expect(queryByText('Phone task')).not.toBeInTheDocument();
        expect(getByText('Desk and phone task')).toBeInTheDocument();

        fireEvent.click(getByRole('button', { name: 'Any' }));

        expect(getByText('Desk task')).toBeInTheDocument();
        expect(getByText('Phone task')).toBeInTheDocument();
        expect(getByText('Desk and phone task')).toBeInTheDocument();
    });

    it('cycles a token chip to excluded and subtracts matching tasks from the list', () => {
        const deskTask: Task = {
            id: 'desk-task',
            title: 'Desk task',
            status: 'next',
            contexts: ['@desk'],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const waitingTask: Task = {
            id: 'waiting-task',
            title: 'Waiting task',
            status: 'next',
            contexts: ['@desk'],
            tags: ['#waiting'],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [deskTask, waitingTask],
            _allTasks: [deskTask, waitingTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            error: null,
            highlightTaskId: null,
        });

        const { getByRole, getByText, queryByText } = renderAgenda();

        fireEvent.click(getByRole('button', { name: /^Filters$/i }));
        // Neutral → included: only tasks carrying #waiting remain.
        fireEvent.click(getByRole('button', { name: '#waiting' }));
        expect(getByText('Waiting task')).toBeInTheDocument();
        expect(queryByText('Desk task')).not.toBeInTheDocument();

        // Included → excluded: the same chip (still named '#waiting') advances.
        fireEvent.click(getByRole('button', { name: '#waiting' }));
        expect(queryByText('Waiting task')).not.toBeInTheDocument();
        expect(getByText('Desk task')).toBeInTheDocument();

        // Excluded → neutral: the chip now exposes its excluded state in the name.
        fireEvent.click(getByRole('button', { name: '#waiting (Excluded)' }));
        expect(getByText('Waiting task')).toBeInTheDocument();
        expect(getByText('Desk task')).toBeInTheDocument();
    });

    it('shows store errors inside the Agenda surface', () => {
        useTaskStore.setState({
            error: 'Storage request timed out. Try again.',
        });

        const { getByRole, getByText } = renderAgenda();

        expect(getByRole('alert')).toBeInTheDocument();
        expect(getByText('Something went wrong')).toBeInTheDocument();
        expect(getByText('Storage request timed out. Try again.')).toBeInTheDocument();
    });

    it('applies and clears saved Focus filters from the chip row', () => {
        const deskTask: Task = {
            id: 'desk-task',
            title: 'Desk task',
            status: 'next',
            contexts: ['@desk'],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const phoneTask: Task = {
            id: 'phone-task',
            title: 'Phone task',
            status: 'next',
            contexts: ['@phone'],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [deskTask, phoneTask],
            _allTasks: [deskTask, phoneTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {
                savedFilters: [{
                    id: 'filter-desk',
                    name: 'Desk',
                    view: 'focus',
                    criteria: { contexts: ['@desk'] },
                    createdAt: nowIso,
                    updatedAt: nowIso,
                }],
            },
            highlightTaskId: null,
        });

        const { getByRole, getByText, queryByText } = renderAgenda();

        fireEvent.click(getByRole('button', { name: 'Desk' }));

        expect(getByText('Desk task')).toBeInTheDocument();
        expect(queryByText('Phone task')).not.toBeInTheDocument();

        fireEvent.click(getByRole('button', { name: 'All' }));

        expect(getByText('Desk task')).toBeInTheDocument();
        expect(getByText('Phone task')).toBeInTheDocument();
    });

    it('applies saved Focus sort preferences from the chip row', () => {
        const highLaterTask: Task = {
            id: 'high-later-task',
            title: 'High later task',
            status: 'next',
            priority: 'urgent',
            startTime: '2026-02-03T09:00:00.000Z',
            contexts: [],
            tags: [],
            createdAt: '2026-02-01T08:00:00.000Z',
            updatedAt: '2026-02-01T08:00:00.000Z',
        };
        const lowEarlierTask: Task = {
            id: 'low-earlier-task',
            title: 'Low earlier task',
            status: 'next',
            priority: 'low',
            startTime: '2026-02-02T09:00:00.000Z',
            contexts: [],
            tags: [],
            createdAt: '2026-02-01T07:00:00.000Z',
            updatedAt: '2026-02-01T07:00:00.000Z',
        };

        useTaskStore.setState({
            tasks: [highLaterTask, lowEarlierTask],
            _allTasks: [highLaterTask, lowEarlierTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {
                savedFilters: [{
                    id: 'filter-start',
                    name: 'Start first',
                    view: 'focus',
                    criteria: {},
                    sortBy: 'start',
                    createdAt: nowIso,
                    updatedAt: nowIso,
                }],
            },
            highlightTaskId: null,
        });

        const { container, getByRole } = renderAgenda();

        fireEvent.click(getByRole('button', { name: 'Start first' }));

        const taskIds = Array.from(container.querySelectorAll<HTMLElement>('[data-task-id]'))
            .map((element) => element.dataset.taskId);
        expect(taskIds).toEqual(['low-earlier-task', 'high-later-task']);
    });

    it('deletes the active saved Focus filter from the chip row', async () => {
        const deskTask: Task = {
            id: 'desk-task',
            title: 'Desk task',
            status: 'next',
            contexts: ['@desk'],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [deskTask],
            _allTasks: [deskTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {
                savedFilters: [{
                    id: 'filter-desk',
                    name: 'Desk',
                    view: 'focus',
                    criteria: { contexts: ['@desk'] },
                    createdAt: nowIso,
                    updatedAt: nowIso,
                }],
            },
            highlightTaskId: null,
        });

        const { getByRole, queryByRole } = renderAgenda();

        fireEvent.click(getByRole('button', { name: 'Desk' }));
        fireEvent.click(getByRole('button', { name: 'Delete saved filter Desk' }));
        fireEvent.click(getByRole('button', { name: /^Delete$/i }));

        await waitFor(() => {
            expect(useTaskStore.getState().settings.savedFilters).toEqual([
                expect.objectContaining({
                    id: 'filter-desk',
                    deletedAt: expect.any(String),
                }),
            ]);
        });
        expect(queryByRole('button', { name: 'Desk' })).not.toBeInTheDocument();
    });

    it('removes advanced synced criteria from the active saved Focus filter', async () => {
        const deskTask: Task = {
            id: 'desk-task',
            title: 'Desk task',
            status: 'next',
            contexts: ['@desk'],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [deskTask],
            _allTasks: [deskTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {
                savedFilters: [{
                    id: 'filter-desk',
                    name: 'Desk',
                    view: 'focus',
                    criteria: {
                        contexts: ['@desk'],
                        dueDateRange: { preset: 'this_week' },
                        hasDescription: true,
                    },
                    createdAt: nowIso,
                    updatedAt: nowIso,
                }],
            },
            highlightTaskId: null,
        });

        const { getByRole } = renderAgenda();

        fireEvent.click(getByRole('button', { name: 'Desk' }));
        fireEvent.click(getByRole('button', { name: 'Delete Due Date: This week' }));

        await waitFor(() => {
            expect(useTaskStore.getState().settings.savedFilters?.[0]).toMatchObject({
                id: 'filter-desk',
                criteria: {
                    contexts: ['@desk'],
                    hasDescription: true,
                },
                updatedAt: expect.any(String),
            });
        });
    });

    it('saves the current Focus filter from existing controls', async () => {
        const lowEnergyTask: Task = {
            id: 'low-energy-task',
            title: 'Low energy task',
            status: 'next',
            energyLevel: 'low',
            contexts: [],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const highEnergyTask: Task = {
            id: 'high-energy-task',
            title: 'High energy task',
            status: 'next',
            energyLevel: 'high',
            contexts: [],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [lowEnergyTask, highEnergyTask],
            _allTasks: [lowEnergyTask, highEnergyTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { getAllByRole, getByDisplayValue, getByRole, getByText } = renderAgenda();

        fireEvent.click(getByRole('button', { name: /^Filters$/i }));
        fireEvent.click(getByRole('button', { name: 'High energy' }));
        fireEvent.click(getByRole('button', { name: /^Save$/i }));
        fireEvent.change(getByDisplayValue('High energy'), { target: { value: 'High energy preset' } });
        const saveButtons = getAllByRole('button', { name: /^Save$/i });
        fireEvent.click(saveButtons[saveButtons.length - 1]);

        await waitFor(() => {
            expect(useTaskStore.getState().settings.savedFilters?.[0]).toMatchObject({
                name: 'High energy preset',
                view: 'focus',
                criteria: { energy: ['high'] },
            });
        });
        expect(getByText('High energy preset')).toBeInTheDocument();
    });

    it('persists context any matching when saving a Focus filter', async () => {
        const tasks: Task[] = [
            {
                id: 'desk-task',
                title: 'Desk task',
                status: 'next',
                contexts: ['@desk'],
                tags: [],
                createdAt: nowIso,
                updatedAt: nowIso,
            },
            {
                id: 'phone-task',
                title: 'Phone task',
                status: 'next',
                contexts: ['@phone'],
                tags: [],
                createdAt: nowIso,
                updatedAt: nowIso,
            },
        ];

        useTaskStore.setState({
            tasks,
            _allTasks: tasks,
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { getAllByRole, getByDisplayValue, getByRole } = renderAgenda();

        fireEvent.click(getByRole('button', { name: /^Filters$/i }));
        fireEvent.click(getByRole('button', { name: '@desk' }));
        fireEvent.click(getByRole('button', { name: '@phone' }));
        fireEvent.click(getByRole('button', { name: 'Any' }));
        fireEvent.click(getByRole('button', { name: /^Save$/i }));
        fireEvent.change(getByDisplayValue('@desk + @phone'), { target: { value: 'Desk or phone' } });
        const saveButtons = getAllByRole('button', { name: /^Save$/i });
        fireEvent.click(saveButtons[saveButtons.length - 1]);

        await waitFor(() => {
            expect(useTaskStore.getState().settings.savedFilters?.[0]).toMatchObject({
                name: 'Desk or phone',
                view: 'focus',
                criteria: {
                    contexts: ['@desk', '@phone'],
                    contextMatchMode: 'any',
                },
            });
        });
    });

    it('persists tag any matching when saving a Focus filter', async () => {
        const tasks: Task[] = [
            {
                id: 'quick-task',
                title: 'Quick task',
                status: 'next',
                contexts: [],
                tags: ['#quick'],
                createdAt: nowIso,
                updatedAt: nowIso,
            },
            {
                id: 'calls-task',
                title: 'Calls task',
                status: 'next',
                contexts: [],
                tags: ['#calls'],
                createdAt: nowIso,
                updatedAt: nowIso,
            },
        ];

        useTaskStore.setState({
            tasks,
            _allTasks: tasks,
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { getAllByRole, getByDisplayValue, getByRole } = renderAgenda();

        fireEvent.click(getByRole('button', { name: /^Filters$/i }));
        fireEvent.click(getByRole('button', { name: '#quick' }));
        fireEvent.click(getByRole('button', { name: '#calls' }));
        fireEvent.click(getByRole('button', { name: 'Any' }));
        fireEvent.click(getByRole('button', { name: /^Save$/i }));
        fireEvent.change(getByDisplayValue('#quick + #calls'), { target: { value: 'Quick or calls' } });
        const saveButtons = getAllByRole('button', { name: /^Save$/i });
        fireEvent.click(saveButtons[saveButtons.length - 1]);

        await waitFor(() => {
            expect(useTaskStore.getState().settings.savedFilters?.[0]).toMatchObject({
                name: 'Quick or calls',
                view: 'focus',
                criteria: {
                    tags: ['#quick', '#calls'],
                    tagMatchMode: 'any',
                },
            });
        });
    });

    it('saves Focus sort and group preferences without requiring criteria', async () => {
        useTaskStore.setState({
            tasks: [],
            _allTasks: [],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { getAllByRole, getByDisplayValue, getByRole } = renderAgenda();

        fireEvent.click(getByRole('button', { name: /^Filters$/i }));
        fireEvent.click(getByRole('button', { name: 'Start date' }));
        selectToolbarOption('Group', 'Project', { getByRole });
        fireEvent.click(getByRole('button', { name: /^Save$/i }));
        fireEvent.change(getByDisplayValue('Focus filter'), { target: { value: 'Start by project' } });
        const saveButtons = getAllByRole('button', { name: /^Save$/i });
        fireEvent.click(saveButtons[saveButtons.length - 1]);

        await waitFor(() => {
            expect(useTaskStore.getState().settings.savedFilters?.[0]).toMatchObject({
                name: 'Start by project',
                view: 'focus',
                criteria: {},
                sortBy: 'start',
                groupBy: 'project',
            });
        });
    });

    it('collapses next actions when the section header is toggled', () => {
        const nextTask: Task = {
            id: 'next-action-task',
            title: 'Next action task',
            status: 'next',
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const reviewTask: Task = {
            id: 'waiting-review-task',
            title: 'Waiting review task',
            status: 'waiting',
            reviewAt: '2026-02-27T09:00:00.000Z',
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [nextTask, reviewTask],
            _allTasks: [nextTask, reviewTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { container, getByRole } = renderAgenda();
        const nextSectionButton = getByRole('button', { name: /next actions/i });

        expect(nextSectionButton).toHaveAttribute('aria-expanded', 'true');
        expect(container.querySelector('[data-task-id="next-action-task"]')).toBeTruthy();
        expect(container.querySelector('[data-task-id="waiting-review-task"]')).toBeTruthy();

        fireEvent.click(nextSectionButton);

        expect(getByRole('button', { name: /next actions/i })).toHaveAttribute('aria-expanded', 'false');
        expect(container.querySelector('[data-task-id="next-action-task"]')).toBeNull();
        expect(container.querySelector('[data-task-id="waiting-review-task"]')).toBeTruthy();
    });

    it('persists collapsed Focus sections after leaving and returning to the view', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 1, 28, 12, 0, 0, 0));
        const now = new Date();
        const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0, 0).toISOString();
        const todayTask: Task = {
            id: 'today-task',
            title: 'Today task',
            status: 'next',
            startTime: startToday,
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const nextTask: Task = {
            id: 'next-task',
            title: 'Next task',
            status: 'next',
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [todayTask, nextTask],
            _allTasks: [todayTask, nextTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const firstRender = renderAgenda();
        const todayButton = firstRender.getByRole('button', { name: /^Today\s*\(1\)$/i });
        const nextActionsButton = firstRender.getByRole('button', { name: /^Next Actions\s*\(1\)$/i });

        fireEvent.click(todayButton);
        fireEvent.click(nextActionsButton);
        expect(todayButton).toHaveAttribute('aria-expanded', 'false');
        expect(nextActionsButton).toHaveAttribute('aria-expanded', 'false');

        firstRender.unmount();

        const secondRender = renderAgenda();
        expect(secondRender.getByRole('button', { name: /^Today\s*\(1\)$/i })).toHaveAttribute('aria-expanded', 'false');
        expect(secondRender.getByRole('button', { name: /^Next Actions\s*\(1\)$/i })).toHaveAttribute('aria-expanded', 'false');
    });

    it('exposes the filter panel state with aria-expanded', () => {
        const { getByRole } = renderAgenda();

        const filtersButton = getByRole('button', { name: /^Filters$/i });
        expect(filtersButton).toHaveAttribute('aria-expanded', 'false');

        fireEvent.click(filtersButton);
        expect(filtersButton).toHaveAttribute('aria-expanded', 'true');
        expect(getByRole('button', { name: /hide/i })).toHaveAttribute('aria-expanded', 'true');
    });

    it('allows hiding the filter panel after selecting a filter', () => {
        const filteredTask: Task = {
            id: 'filtered-task',
            title: 'Filtered task',
            status: 'next',
            energyLevel: 'high',
            contexts: [],
            tags: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [filteredTask],
            _allTasks: [filteredTask],
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { getByRole, queryByRole } = renderAgenda();

        fireEvent.click(getByRole('button', { name: /^Filters$/i }));
        fireEvent.click(getByRole('button', { name: 'High energy' }));
        fireEvent.click(getByRole('button', { name: /^hide$/i }));

        expect(getByRole('button', { name: /^Filters/i })).toHaveAttribute('aria-expanded', 'false');
        expect(queryByRole('button', { name: 'Low energy' })).not.toBeInTheDocument();
        expect(getByRole('textbox')).toBeInTheDocument();
        expect(queryByRole('button', { name: 'High energy' })).not.toBeInTheDocument();
        expect(document.body).toHaveTextContent('High energy');
    });

    it('renders every grouped no-context task when the list is large', () => {
        const tasks = Array.from({ length: 30 }, (_, index) => ({
            id: `next-task-${index + 1}`,
            title: `Next task ${index + 1}`,
            status: 'next',
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        } satisfies Task));

        useTaskStore.setState({
            tasks,
            _allTasks: tasks,
            projects: [],
            _allProjects: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const { getByText } = renderAgenda();
        selectToolbarOption('Group', 'Context');

        expect(getByText(/no context/i)).toBeInTheDocument();
        expect(getByText('Next task 30')).toBeInTheDocument();
    });

    it('persists collapsed grouped next-action state by grouping mode', () => {
        const workProject: Project = {
            id: 'work-project',
            title: '@work',
            status: 'active',
            color: '#2563eb',
            order: 0,
            tagIds: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const workTask: Task = {
            id: 'work-task',
            title: 'Work task',
            status: 'next',
            projectId: workProject.id,
            tags: [],
            contexts: ['@work'],
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        const homeTask: Task = {
            id: 'home-task',
            title: 'Home task',
            status: 'next',
            tags: [],
            contexts: ['@home'],
            createdAt: nowIso,
            updatedAt: nowIso,
        };

        useTaskStore.setState({
            tasks: [workTask, homeTask],
            _allTasks: [workTask, homeTask],
            projects: [workProject],
            _allProjects: [workProject],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });

        const firstRender = renderAgenda();
        selectToolbarOption('Group', 'Context', firstRender);

        const workContextGroup = firstRender.getByRole('button', { name: /@work\s*1/i });
        fireEvent.click(workContextGroup);

        expect(firstRender.getByRole('button', { name: /@work\s*1/i })).toHaveAttribute('aria-expanded', 'false');
        expect(firstRender.queryByText('Work task')).not.toBeInTheDocument();
        expect(firstRender.getByText('Home task')).toBeInTheDocument();

        const persisted = JSON.parse(window.localStorage.getItem(focusViewStateStorageKey) ?? '{}') as {
            collapsedGroups?: Record<string, string[]>;
        };
        expect(persisted.collapsedGroups?.context).toEqual(['context:@work']);
        expect(persisted.collapsedGroups?.project ?? []).toEqual([]);

        selectToolbarOption('Group', 'Project', firstRender);

        expect(firstRender.getByRole('button', { name: /@work\s*1/i })).toHaveAttribute('aria-expanded', 'true');
        expect(firstRender.getByText('Work task')).toBeInTheDocument();

        selectToolbarOption('Group', 'Context', firstRender);
        firstRender.unmount();

        const secondRender = renderAgenda();
        expect(secondRender.getByRole('button', { name: /@work\s*1/i })).toHaveAttribute('aria-expanded', 'false');
        expect(secondRender.queryByText('Work task')).not.toBeInTheDocument();
        expect(secondRender.getByText('Home task')).toBeInTheDocument();
    });

    describe('Today\'s Focus drag reorder', () => {
        const focusTask = (id: string, title: string, focusOrder?: number): Task => ({
            id,
            title,
            status: 'next',
            isFocusedToday: true,
            focusOrder,
            tags: [],
            contexts: [],
            createdAt: nowIso,
            updatedAt: nowIso,
        });

        beforeEach(() => {
            capturedFocusDndProps = {};
        });

        it('orders focused rows by focusOrder in the default sort', () => {
            // Provided out of order; sortTasksByFocusOrder must surface B (0) before A (1).
            const taskA = focusTask('task-a', 'Focus A', 1);
            const taskB = focusTask('task-b', 'Focus B', 0);
            const tasks = [taskA, taskB];
            useTaskStore.setState({
                tasks,
                _allTasks: tasks,
                projects: [],
                _allProjects: [],
                areas: [],
                _allAreas: [],
                settings: {},
                highlightTaskId: null,
            });

            const { getByTestId, getAllByRole } = renderAgenda();

            const section = getByTestId('todays-focus-section');
            const titleA = section.querySelector('[data-task-id="task-a"]')!;
            const titleB = section.querySelector('[data-task-id="task-b"]')!;
            expect(titleB.compareDocumentPosition(titleA) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

            // Default sort exposes a drag handle per focused row.
            const handles = getAllByRole('button', { name: 'Reorder' });
            expect(handles).toHaveLength(2);
        });

        it('commits a drop through reorderFocusedTasks with the new id order', () => {
            const taskA = focusTask('task-a', 'Focus A', 0);
            const taskB = focusTask('task-b', 'Focus B', 1);
            const tasks = [taskA, taskB];
            useTaskStore.setState({
                tasks,
                _allTasks: tasks,
                projects: [],
                _allProjects: [],
                areas: [],
                _allAreas: [],
                settings: {},
                highlightTaskId: null,
            });
            const reorderSpy = vi
                .spyOn(useTaskStore.getState(), 'reorderFocusedTasks')
                .mockResolvedValue({ success: true });

            renderAgenda();

            expect(capturedFocusDndProps.onDragEnd).toBeTypeOf('function');
            act(() => {
                capturedFocusDndProps.onDragEnd?.({ active: { id: 'task-a' }, over: { id: 'task-b' } });
            });

            expect(reorderSpy).toHaveBeenCalledWith(['task-b', 'task-a']);
        });

        it('renders no drag affordance under a non-default sort', () => {
            const tasks = [focusTask('task-a', 'Focus A', 0), focusTask('task-b', 'Focus B', 1)];
            useTaskStore.setState({
                tasks,
                _allTasks: tasks,
                projects: [],
                _allProjects: [],
                areas: [],
                _allAreas: [],
                settings: {},
                highlightTaskId: null,
            });

            const { getByRole, queryByRole, queryAllByRole } = renderAgenda();
            expect(queryAllByRole('button', { name: 'Reorder' }).length).toBeGreaterThan(0);

            fireEvent.click(getByRole('button', { name: /^Filters$/i }));
            fireEvent.click(getByRole('button', { name: 'Start date' }));

            expect(queryByRole('button', { name: 'Reorder' })).toBeNull();
        });

        it('renders no drag affordance while a search query narrows the focus list', () => {
            // Default sort, but a search query means focusedTasks is a subset;
            // dragging must be gated so a reorder cannot write 0..n over the
            // visible rows while hidden focused tasks keep their focusOrder.
            const tasks = [focusTask('task-a', 'Focus A', 0), focusTask('task-b', 'Focus B', 1)];
            useTaskStore.setState({
                tasks,
                _allTasks: tasks,
                projects: [],
                _allProjects: [],
                areas: [],
                _allAreas: [],
                settings: {},
                highlightTaskId: null,
            });

            const { getByRole, getByPlaceholderText, getByText, queryByRole, queryAllByRole } = renderAgenda();
            expect(queryAllByRole('button', { name: 'Reorder' }).length).toBeGreaterThan(0);

            fireEvent.click(getByRole('button', { name: /^Filters$/i }));
            fireEvent.change(getByPlaceholderText('Search...'), { target: { value: 'Focus A' } });

            // The matching row still renders, but without any drag handle.
            expect(getByText('Focus A')).toBeInTheDocument();
            expect(queryByRole('button', { name: 'Reorder' })).toBeNull();
        });

        it('renders no drag affordance while filter criteria narrow the focus list', () => {
            const highEnergy: Task = { ...focusTask('task-a', 'Focus A', 0), energyLevel: 'high' };
            const lowEnergy: Task = { ...focusTask('task-b', 'Focus B', 1), energyLevel: 'low' };
            const tasks = [highEnergy, lowEnergy];
            useTaskStore.setState({
                tasks,
                _allTasks: tasks,
                projects: [],
                _allProjects: [],
                areas: [],
                _allAreas: [],
                settings: {},
                highlightTaskId: null,
            });

            const { getByRole, getByText, queryByRole, queryAllByRole } = renderAgenda();
            expect(queryAllByRole('button', { name: 'Reorder' }).length).toBeGreaterThan(0);

            fireEvent.click(getByRole('button', { name: /^Filters$/i }));
            fireEvent.click(getByRole('button', { name: 'High energy' }));

            expect(getByText('Focus A')).toBeInTheDocument();
            expect(queryByRole('button', { name: 'Reorder' })).toBeNull();
        });
    });
});
