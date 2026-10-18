import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetForTests, useTaskStore, type Project, type Task } from '@mindwtr/core';

import { WeeklyReviewGuideModal } from './WeeklyReviewModal';
import { fetchExternalCalendarEvents } from '../../../lib/external-calendar-events';
import { useCalendarExternalEvents } from '../calendar/use-calendar-external-events';
import { reportError } from '../../../lib/report-error';

vi.mock('../../../contexts/language-context', () => ({
    useLanguage: () => ({
        language: 'en',
        t: (key: string) => ({
            'review.title': 'Weekly Review',
            'review.inboxZero': 'Inbox Zero',
            'review.inboxZeroDesc': 'tasks in your inbox',
            'review.inboxEmpty': 'Inbox empty',
            'review.inboxStep': 'Inbox',
            'review.staleStep': 'Stale Items',
            'review.calendarStep': 'Calendar',
            'review.waitingStep': 'Waiting For',
            'review.contexts': 'Contexts',
            'review.projectsStep': 'Projects',
            'review.somedayStep': 'Someday',
            'review.allDone': 'All Done',
            'review.allDoneDesc': 'Nice work.',
            'review.complete': 'Review Complete!',
            'review.completeDesc': 'Nice work this week.',
            'review.summaryInboxEmpty': 'Inbox is empty.',
            'review.weekHeading': 'This week',
            'review.weekCompletedCount': '{{count}} action(s) completed this week',
            'review.weekProjectsMovedCount': '{{count}} project(s) moved forward',
            'review.weekEstimatedTasksCount': '{{count}} completed task(s) had an estimate',
            'review.weekEstimatedTotal': 'Estimated: {{duration}}',
            'review.weekTrackedTotal': 'Tracked on those tasks: {{duration}}',
            'review.finish': 'Finish',
            'shareCard.action': 'Share my reflection',
            'review.step': 'Step',
            'review.of': 'of',
            'mindSweep.title': 'Mind Sweep',
            'mindSweep.intro': 'Capture anything on your mind.',
            'common.close': 'Close',
            'common.cancel': 'Cancel',
            'projects.addTask': 'Add task',
            'projects.nextActionPromptComplete': 'Complete project',
            'projects.completeConfirm': 'Mark this project completed and finish all its tasks?',
            'projects.archiveFailed': 'Failed to archive project',
        }[key] ?? key),
    }),
}));

vi.mock('../../../lib/external-calendar-events', () => ({
    fetchExternalCalendarEvents: vi.fn(async () => ({ calendars: [], events: [], warnings: [] })),
    summarizeExternalCalendarWarnings: vi.fn(() => null),
}));

vi.mock('../../TaskItem', () => ({
    TaskItem: ({ task }: { task: Task }) => <div data-testid={`task-${task.id}`}>{task.title}</div>,
}));

vi.mock('../InboxProcessor', () => ({
    InboxProcessor: () => <div data-testid="inbox-processor" />,
}));

vi.mock('../../MindSweepModal', () => ({
    MindSweepLauncher: () => <div data-testid="mind-sweep-launcher" />,
}));

vi.mock('../../PromptModal', () => ({
    PromptModal: () => null,
}));

vi.mock('../../../lib/report-error', () => ({ reportError: vi.fn() }));

vi.mock('../../ShareCardDialog', () => ({
    ShareCardDialog: ({ onClose, reviewDate }: { onClose: () => void; reviewDate: string }) => (
        <div role="dialog" aria-label="My weekly reflection" data-review-date={reviewDate}>
            <button type="button" onClick={onClose}>Close share</button>
        </div>
    ),
}));

const now = '2026-02-01T00:00:00.000Z';
const storageKey = 'mindwtr:weeklyReview:currentStep';
const initialTaskState = useTaskStore.getState();

const makeTask = (overrides: Partial<Task>): Task => ({
    id: 'task-1',
    title: 'Task',
    status: 'next',
    createdAt: now,
    updatedAt: now,
    ...overrides,
} as Task);

describe('WeeklyReviewGuideModal', () => {
    beforeEach(() => {
        vi.useRealTimers();
        resetForTests();
        window.localStorage.clear();
        vi.mocked(fetchExternalCalendarEvents).mockResolvedValue({ calendars: [], events: [], warnings: [] });
        useTaskStore.setState(initialTaskState, true);
        useTaskStore.setState({
            _allTasks: [],
            _allProjects: [],
            _allSections: [],
            _allAreas: [],
            _allPeople: [],
            settings: { gtd: { weeklyReview: { includeContextStep: true } } },
            addProject: vi.fn(),
            updateProject: vi.fn(),
            updateTask: vi.fn(),
            deleteTask: vi.fn(),
            batchUpdateTasks: vi.fn(),
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('lands on the all-clear step when nothing needs review', () => {
        render(<WeeklyReviewGuideModal onClose={vi.fn()} />);

        expect(screen.getByRole('heading', { level: 2, name: 'Review Complete!' })).toBeInTheDocument();
        expect(screen.queryByText('This week')).not.toBeInTheDocument();
    });

    const seedProjects = (tasks: Task[] = []) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(2026, 6, 15, 10));
        const projects: Project[] = ['Finish me', 'Keep reviewing'].map((title, index) => ({
            id: `project-${index}`, title, status: 'active', color: '#3B82F6',
            order: index, tagIds: [], createdAt: now, updatedAt: now,
        }));
        const updateProject = vi.fn(initialTaskState.updateProject);
        useTaskStore.setState({ _allTasks: tasks, _allProjects: projects, updateProject });
        window.localStorage.setItem(storageKey, JSON.stringify({ step: 'projects', startedAt: new Date().toISOString() }));
        return updateProject;
    };
    const completeFirstProject = () => {
        const card = screen.getByRole('heading', { level: 3, name: 'Finish me' }).parentElement!.parentElement!;
        fireEvent.click(within(card).getByRole('button', { name: 'Complete project' }));
    };

    it.each(['empty', 'done', 'reference', 'deleted'] as const)('completes a project with %s tasks through the existing lifecycle and keeps reviewing', async (kind) => {
        const tasks = kind === 'empty' ? [] : [makeTask({
            id: 'child', projectId: 'project-0', status: kind === 'done' ? 'done' : kind === 'reference' ? 'reference' : 'next',
            ...(kind === 'deleted' ? { deletedAt: now } : {}),
        })];
        const updateProject = seedProjects(tasks);
        const onClose = vi.fn();
        render(<WeeklyReviewGuideModal onClose={onClose} />);

        completeFirstProject();

        await waitFor(() => expect(updateProject).toHaveBeenCalledWith('project-0', { status: 'archived' }));
        expect(screen.queryByText('Mark this project completed and finish all its tasks?')).not.toBeInTheDocument();
        const completedProject = useTaskStore.getState()._allProjects.find((project) => project.id === 'project-0');
        expect(completedProject?.status).toBe('archived');
        expect(completedProject?.cancelledAt).toBeUndefined();
        expect(screen.queryByRole('heading', { name: 'Finish me' })).not.toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 1, name: 'Projects' })).toBeInTheDocument();
        expect(JSON.parse(window.localStorage.getItem(storageKey) ?? '{}').step).toBe('projects');
        expect(onClose).not.toHaveBeenCalled();
    });

    it('confirms and completes a deferred unfinished section task absent from the review cards', async () => {
        const deferred = makeTask({ id: 'deferred', title: 'Hidden deferred task', sectionId: 'section', startTime: '2027-01-01' });
        const updateProject = seedProjects([deferred]);
        useTaskStore.setState({ _allSections: [{
            id: 'section', projectId: 'project-0', title: 'Section', order: 0, createdAt: now, updatedAt: now,
        }] });
        render(<WeeklyReviewGuideModal onClose={vi.fn()} />);
        expect(screen.queryByTestId('task-deferred')).not.toBeInTheDocument();

        completeFirstProject();

        const confirmation = screen.getByRole('dialog', { name: 'Finish me' });
        expect(within(confirmation).getByText('Mark this project completed and finish all its tasks?')).toBeInTheDocument();
        expect(updateProject).not.toHaveBeenCalled();
        fireEvent.click(within(confirmation).getByRole('button', { name: 'Complete project' }));

        await waitFor(() => expect(updateProject).toHaveBeenCalledTimes(1));
        expect(useTaskStore.getState()._allTasks.find((task) => task.id === 'deferred')).toMatchObject({
            status: 'done', projectId: 'project-0', projectArchivedAt: expect.any(String),
        });
    });

    it('keeps the projects step after the final project is completed until the reviewer advances', async () => {
        seedProjects();
        useTaskStore.setState({ _allProjects: [useTaskStore.getState()._allProjects[0]] });
        const onClose = vi.fn();
        render(<WeeklyReviewGuideModal onClose={onClose} />);

        completeFirstProject();

        await waitFor(() => expect(screen.queryByRole('heading', { name: 'Finish me' })).not.toBeInTheDocument());
        expect(screen.getByRole('heading', { level: 1, name: 'Projects' })).toBeInTheDocument();
        expect(JSON.parse(window.localStorage.getItem(storageKey) ?? '{}').step).toBe('projects');
        expect(onClose).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'review.nextStepBtn' }));
        expect(screen.getByRole('heading', { level: 2, name: 'Review Complete!' })).toBeInTheDocument();
    });

    it('does not complete a project removed while its confirmation was open', async () => {
        const updateProject = seedProjects([makeTask({ projectId: 'project-0' })]);
        render(<WeeklyReviewGuideModal onClose={vi.fn()} />);
        completeFirstProject();
        act(() => useTaskStore.setState({
            _allProjects: useTaskStore.getState()._allProjects.map((project) => project.id === 'project-0' ? { ...project, deletedAt: now } : project),
        }));
        fireEvent.click(within(screen.getByRole('dialog', { name: 'Finish me' })).getByRole('button', { name: 'Complete project' }));

        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Finish me' })).not.toBeInTheDocument());
        expect(updateProject).not.toHaveBeenCalled();
    });

    it('checks the current underlying tasks at activation and leaves everything unchanged when confirmation is canceled', async () => {
        const updateProject = seedProjects();
        render(<WeeklyReviewGuideModal onClose={vi.fn()} />);
        const lateTask = makeTask({ id: 'late', title: 'Later task', projectId: 'project-0', status: 'someday', startTime: '2027-01-01' });
        act(() => useTaskStore.setState({ _allTasks: [lateTask] }));

        completeFirstProject();
        fireEvent.click(within(screen.getByRole('dialog', { name: 'Finish me' })).getByRole('button', { name: 'Cancel' }));

        await waitFor(() => expect(screen.getAllByRole('button', { name: 'Complete project' })[0]).toBeEnabled());
        expect(updateProject).not.toHaveBeenCalled();
        expect(useTaskStore.getState()._allTasks).toEqual([lateTask]);
        expect(useTaskStore.getState()._allProjects[0].status).toBe('active');
        expect(screen.getByRole('heading', { level: 1, name: 'Projects' })).toBeInTheDocument();
    });

    it.each(['result', 'rejection'] as const)('reports a failed completion %s and lets the reviewer retry', async (failure) => {
        seedProjects();
        vi.mocked(reportError).mockClear();
        const updateProject = failure === 'result'
            ? vi.fn(async () => ({ success: false as const, error: 'Save failed' }))
            : vi.fn(async () => { throw new Error('Save failed'); });
        useTaskStore.setState({ updateProject });
        const onClose = vi.fn();
        render(<WeeklyReviewGuideModal onClose={onClose} />);

        completeFirstProject();

        await waitFor(() => expect(reportError).toHaveBeenCalledWith(
            'Failed to complete project during weekly review', expect.any(Error), { userMessage: 'Failed to archive project' },
        ));
        expect(screen.getAllByRole('button', { name: 'Complete project' })[0]).toBeEnabled();
        expect(screen.getByRole('heading', { level: 3, name: 'Finish me' })).toBeInTheDocument();
        expect(useTaskStore.getState()._allProjects[0].status).toBe('active');
        expect(onClose).not.toHaveBeenCalled();
    });

    it('waits for completion and prevents duplicate writes while it is pending', async () => {
        seedProjects();
        let resolve!: (value: { success: true }) => void;
        const updateProject = vi.fn(() => new Promise<{ success: true }>((done) => { resolve = done; }));
        useTaskStore.setState({ updateProject });
        render(<WeeklyReviewGuideModal onClose={vi.fn()} />);

        completeFirstProject();
        expect(screen.getAllByRole('button', { name: 'Complete project' }).every((button) => button.hasAttribute('disabled'))).toBe(true);
        completeFirstProject();
        expect(updateProject).toHaveBeenCalledTimes(1);

        await act(async () => resolve({ success: true }));

        expect(screen.getAllByRole('button', { name: 'Complete project' })[0]).toBeEnabled();
    });

    it('honors calendar toggles and disabled sources when loading the calendar step', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(2026, 9, 11, 23, 30));
        const visibleRange = { start: new Date(), end: new Date() };
        const calendars = ['visible', 'feed', 'feed#category', 'macos:work', 'disabled'].map((id) => ({
            id, name: id, url: '', enabled: id !== 'disabled',
        }));
        const start = new Date();
        // Keep the fixture on one calendar day even when CI runs near midnight.
        start.setHours(12, 0, 0, 0);
        const end = new Date(start.getTime() + 60 * 60 * 1000);
        const events = calendars.map((calendar) => ({
            id: `${calendar.id}-event`, sourceId: calendar.id, title: `${calendar.id} appointment`,
            start: start.toISOString(), end: end.toISOString(), allDay: false,
        }));
        vi.mocked(fetchExternalCalendarEvents).mockResolvedValue({ calendars, events, warnings: [] });
        const mainCalendar = renderHook(() => useCalendarExternalEvents({ filterQuery: '', visibleRange }));
        await waitFor(() => expect(mainCalendar.result.current.externalCalendars).toHaveLength(5));
        act(() => {
            for (const id of ['feed', 'feed#category', 'macos:work']) mainCalendar.result.current.toggleExternalCalendar(id);
        });
        mainCalendar.unmount();

        useTaskStore.setState({ _allTasks: [makeTask({ status: 'inbox' })] });
        render(<WeeklyReviewGuideModal onClose={vi.fn()} />);
        await act(async () => {});
        fireEvent.click(screen.getByRole('button', { name: 'review.nextStepBtn' }));
        await waitFor(() => expect(screen.getByText('visible appointment')).toBeInTheDocument());
        const expand = screen.queryByRole('button', { name: '+3 common.more' });
        if (expand) fireEvent.click(expand);
        for (const id of ['feed', 'feed#category', 'macos:work', 'disabled']) {
            expect(screen.queryByText(`${id} appointment`)).not.toBeInTheDocument();
        }
        expect(window.localStorage.getItem('mindwtr.calendar.hiddenExternalCalendars')).toBe(
            JSON.stringify(['feed', 'feed#category', 'macos:work']),
        );
    });

    it('skips the calendar step when every calendar is switched off', async () => {
        useTaskStore.setState({ _allTasks: [makeTask({ status: 'inbox' })] });
        window.localStorage.setItem('mindwtr.calendar.hiddenExternalCalendars', JSON.stringify(['macos:work']));
        vi.mocked(fetchExternalCalendarEvents).mockResolvedValue({
            calendars: [{ id: 'macos:work', name: 'Work', url: '', enabled: true }],
            events: [{
                id: 'work-event', sourceId: 'macos:work', title: 'Hidden appointment',
                start: new Date().toISOString(), end: new Date(Date.now() + 60 * 60 * 1000).toISOString(), allDay: false,
            }],
            warnings: [],
        });
        render(<WeeklyReviewGuideModal onClose={vi.fn()} />);
        await act(async () => {});
        act(() => useTaskStore.setState({ _allTasks: [] }));
        expect(screen.getByRole('heading', { level: 2, name: 'Review Complete!' })).toBeInTheDocument();
        expect(screen.queryByText('Hidden appointment')).not.toBeInTheDocument();
    });

    it('offers sharing only from the final reflection without finishing the review', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 8, 12, 12, 0, 0));
        const onClose = vi.fn();
        render(<WeeklyReviewGuideModal onClose={onClose} />);

        fireEvent.click(screen.getByRole('button', { name: 'Share my reflection' }));
        expect(screen.getByRole('dialog', { name: 'My weekly reflection' })).toHaveAttribute(
            'data-review-date',
            'September 12, 2026',
        );

        fireEvent.click(screen.getByRole('button', { name: 'Close share' }));
        expect(screen.queryByRole('dialog', { name: 'My weekly reflection' })).not.toBeInTheDocument();
        expect(onClose).not.toHaveBeenCalled();

        vi.setSystemTime(new Date(2026, 8, 13, 12, 0, 0));
        fireEvent.click(screen.getByRole('button', { name: 'Share my reflection' }));
        expect(screen.getByRole('dialog', { name: 'My weekly reflection' })).toHaveAttribute(
            'data-review-date',
            'September 12, 2026',
        );
    });

    it('shows this week\'s completion, project, estimate, and tracked totals', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 2, 4, 12, 0, 0));
        useTaskStore.setState({
            _allTasks: [
                makeTask({
                    id: 'done-with-estimate',
                    status: 'done',
                    completedAt: new Date(2026, 2, 3, 9, 0, 0).toISOString(),
                    projectId: 'archived-project',
                    timeEstimate: '1hr',
                    timeSpentMinutes: 45,
                }),
                makeTask({
                    id: 'done-without-estimate',
                    status: 'done',
                    completedAt: new Date(2026, 2, 3, 10, 0, 0).toISOString(),
                    projectId: 'archived-project',
                }),
            ],
            _allProjects: [{
                id: 'archived-project',
                title: 'Archived project',
                status: 'archived',
                color: '#3B82F6',
                order: 0,
                tagIds: [],
                createdAt: now,
                updatedAt: now,
            }],
            settings: {
                weekStart: 'monday',
                features: { timeEstimates: true, pomodoro: true },
                gtd: {
                    weeklyReview: { includeContextStep: true },
                    pomodoro: { linkTask: true },
                },
            },
        });

        render(<WeeklyReviewGuideModal onClose={vi.fn()} />);

        expect(screen.getByText('This week')).toBeInTheDocument();
        expect(screen.getByText('2 action(s) completed this week')).toBeInTheDocument();
        expect(screen.getByText('1 project(s) moved forward')).toBeInTheDocument();
        expect(screen.getByText('1 completed task(s) had an estimate')).toBeInTheDocument();
        expect(screen.getByText('Estimated: 1h')).toBeInTheDocument();
        expect(screen.getByText('Tracked on those tasks: 45m')).toBeInTheDocument();
    });

    it('keeps estimate lines hidden until time estimates are enabled', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 2, 4, 12, 0, 0));
        useTaskStore.setState({
            _allTasks: [makeTask({
                id: 'done-with-hidden-estimate',
                status: 'done',
                completedAt: new Date(2026, 2, 3, 9, 0, 0).toISOString(),
                timeEstimate: '1hr',
                timeSpentMinutes: 45,
            })],
            settings: {
                weekStart: 'monday',
                features: { timeEstimates: false, pomodoro: true },
                gtd: {
                    weeklyReview: { includeContextStep: true },
                    pomodoro: { linkTask: true },
                },
            },
        });

        render(<WeeklyReviewGuideModal onClose={vi.fn()} />);

        expect(screen.getByText('1 action(s) completed this week')).toBeInTheDocument();
        expect(screen.queryByText('1 completed task(s) had an estimate')).not.toBeInTheDocument();
        expect(screen.queryByText('Estimated: 1h')).not.toBeInTheDocument();
        expect(screen.queryByText('Tracked on those tasks: 45m')).not.toBeInTheDocument();
    });

    it('shows the estimate look-back at defaults, with no features block stored', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 2, 4, 12, 0, 0));
        useTaskStore.setState({
            _allTasks: [makeTask({
                id: 'done-with-estimate',
                status: 'done',
                completedAt: new Date(2026, 2, 3, 9, 0, 0).toISOString(),
                timeEstimate: '1hr',
                timeSpentMinutes: 45,
            })],
            // No `features` key at all: time estimates default ON, so the
            // look-back must render. `features?.timeEstimates === true` read
            // this as OFF and hid the rows for everyone at defaults.
            settings: {
                weekStart: 'monday',
                gtd: {
                    weeklyReview: { includeContextStep: true },
                    pomodoro: { linkTask: true },
                },
            },
        });

        render(<WeeklyReviewGuideModal onClose={vi.fn()} />);

        expect(screen.getByText('1 completed task(s) had an estimate')).toBeInTheDocument();
        expect(screen.getByText('Estimated: 1h')).toBeInTheDocument();
        // Pomodoro still defaults OFF, so the tracked line stays hidden.
        expect(screen.queryByText('Tracked on those tasks: 45m')).not.toBeInTheDocument();
    });

    it('keeps a stale task listed after it is edited during the review (#1262)', () => {
        const staleTask = makeTask({ id: 'stale-1', title: 'Old next action', updatedAt: '2025-10-01T00:00:00.000Z', createdAt: '2025-10-01T00:00:00.000Z' });
        useTaskStore.setState({ _allTasks: [staleTask], tasks: [staleTask] });
        render(<WeeklyReviewGuideModal onClose={vi.fn()} />);

        expect(screen.getByTestId('task-stale-1')).toBeInTheDocument();
        expect(screen.getByText(/days inactive|staleDaysInactive/)).toBeInTheDocument();

        // Saving anything (a checklist item, a title) stamps updatedAt with "now".
        const touched = { ...staleTask, updatedAt: new Date().toISOString() };
        act(() => {
            useTaskStore.setState({ _allTasks: [touched], tasks: [touched] });
        });

        expect(screen.getByTestId('task-stale-1')).toBeInTheDocument();
        expect(screen.queryByText(/days inactive|staleDaysInactive/)).not.toBeInTheDocument();

        // A task that leaves Next/Waiting is done with this step.
        const done = { ...touched, status: 'done' as const };
        act(() => {
            useTaskStore.setState({ _allTasks: [done], tasks: [done] });
        });
        expect(screen.queryByTestId('task-stale-1')).not.toBeInTheDocument();
    });

    it('opens on the inbox step when there is an inbox task to process', () => {
        useTaskStore.setState({
            _allTasks: [makeTask({ id: 'inbox-1', title: 'Inbox task', status: 'inbox' })],
        });

        render(<WeeklyReviewGuideModal onClose={vi.fn()} />);

        expect(screen.getByRole('heading', { level: 1, name: 'Inbox' })).toBeInTheDocument();
        expect(screen.getByTestId('task-inbox-1')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'review.back' })).toBeDisabled();
    });

    it('resumes within the configured local review week, preserves Close, and clears on Finish', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 2, 4, 10, 0, 0));
        useTaskStore.setState({
            _allTasks: [
                makeTask({ id: 'inbox-1', title: 'Inbox task', status: 'inbox', updatedAt: new Date(2026, 2, 4).toISOString() }),
                makeTask({ id: 'waiting-1', title: 'Waiting task', status: 'waiting', updatedAt: new Date(2026, 2, 4).toISOString() }),
            ],
            settings: { weekStart: 'monday', gtd: { weeklyReview: { includeContextStep: true } } },
        });
        const onClose = vi.fn();
        const first = render(<WeeklyReviewGuideModal onClose={onClose} />);

        fireEvent.click(screen.getByRole('button', { name: 'review.nextStepBtn' }));
        expect(screen.getByRole('heading', { level: 1, name: 'Waiting For' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(JSON.parse(window.localStorage.getItem(storageKey) ?? '{}')).toEqual({
            step: 'waiting',
            startedAt: new Date(2026, 2, 4, 10, 0, 0).toISOString(),
        });

        first.unmount();
        render(<WeeklyReviewGuideModal onClose={vi.fn()} />);
        expect(screen.getByRole('heading', { level: 1, name: 'Waiting For' })).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'review.nextStepBtn' }));
        fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
        expect(window.localStorage.getItem(storageKey)).toBeNull();
    });

    it('ignores a checkpoint from the previous configured review week', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 2, 2, 9, 0, 0));
        window.localStorage.setItem(storageKey, JSON.stringify({
            step: 'completed',
            startedAt: new Date(2026, 2, 1, 16, 0, 0).toISOString(),
        }));
        useTaskStore.setState({
            _allTasks: [makeTask({ id: 'inbox-1', title: 'Inbox task', status: 'inbox' })],
            settings: { weekStart: 'monday', gtd: { weeklyReview: { includeContextStep: true } } },
        });

        render(<WeeklyReviewGuideModal onClose={vi.fn()} />);

        expect(screen.getByRole('heading', { level: 1, name: 'Inbox' })).toBeInTheDocument();
        expect(JSON.parse(window.localStorage.getItem(storageKey) ?? '{}')).toEqual({
            step: 'inbox',
            startedAt: new Date(2026, 2, 2, 9, 0, 0).toISOString(),
        });
    });
});
