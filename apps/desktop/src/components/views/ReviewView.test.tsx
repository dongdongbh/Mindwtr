import { beforeEach, describe, it, expect, vi } from 'vitest';
import { act, render, fireEvent, waitFor } from '@testing-library/react';
import { useTaskStore, type Project, type Task } from '@mindwtr/core';
import { ReviewView } from './ReviewView';
import { LanguageProvider } from '../../contexts/language-context';
import { useUiStore } from '../../store/ui-store';
import { fetchExternalCalendarEvents } from '../../lib/external-calendar-events';
import { resolveTaskNavigationView } from '../../lib/task-navigation';

const renderWithProviders = (ui: React.ReactElement) => {
    return render(
        <LanguageProvider>
            {ui}
        </LanguageProvider>
    );
};


vi.mock('../../lib/external-calendar-events', () => ({
    fetchExternalCalendarEvents: vi.fn(async () => ({ calendars: [], events: [], warnings: [] })),
    summarizeExternalCalendarWarnings: vi.fn((warnings: string[]) => warnings[0] ?? null),
}));

const waitForExternalCalendarIdle = async () => {
    const mock = vi.mocked(fetchExternalCalendarEvents);
    await waitFor(() => expect(mock).toHaveBeenCalled());
    const latest = mock.mock.results[mock.mock.results.length - 1];
    if (latest?.type !== 'return') return;
    await act(async () => {
        await latest.value;
    });
};

const initialTaskState = useTaskStore.getState();
const initialUiState = useUiStore.getState();

describe('ReviewView', () => {
    const nowIso = '2026-04-19T12:00:00.000Z';
    const dateStringFromToday = (offsetDays: number) => {
        const date = new Date();
        date.setDate(date.getDate() + offsetDays);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    };
    const makeTask = (id: string, overrides: Partial<Task> = {}): Task => ({
        id,
        title: `Task ${id}`,
        status: 'next',
        tags: [],
        contexts: [],
        createdAt: nowIso,
        updatedAt: nowIso,
        ...overrides,
    });
    const makeProject = (id: string, overrides: Partial<Project> = {}): Project => ({
        id,
        title: `Project ${id}`,
        status: 'active',
        color: '#2563eb',
        order: 0,
        tagIds: [],
        createdAt: nowIso,
        updatedAt: nowIso,
        ...overrides,
    });

    beforeEach(() => {
        window.localStorage.removeItem('mindwtr:view:review:v1');
        window.localStorage.removeItem('mindwtr:weeklyReview:currentStep');
        useTaskStore.setState(initialTaskState, true);
        useUiStore.setState(initialUiState, true);
        vi.mocked(fetchExternalCalendarEvents).mockClear();
        useTaskStore.setState({
            tasks: [],
            _allTasks: [],
            projects: [],
            _allProjects: [],
            sections: [],
            _allSections: [],
            areas: [],
            _allAreas: [],
            settings: {},
            highlightTaskId: null,
        });
        useUiStore.setState({
            listOptions: {
                showDetails: false,
                focusGroupBy: 'none', inboxGroupBy: 'none', nextGroupBy: 'none',
                waitingGroupBy: 'none', somedayGroupBy: 'none',
                referenceGroupBy: 'area', doneGroupBy: 'none', archivedGroupBy: 'none',
            },
            expandedTaskIds: {},
        });
    });

    it('keeps sequence tails editable behind a local disclosure and never hides explicit due reviews', () => {
        const project = makeProject('sequence', { isSequential: true });
        const tasks = [
            makeTask('head', { projectId: project.id, title: 'Waiting head', status: 'waiting', order: 0 }),
            makeTask('tail', { projectId: project.id, title: 'Later tail', order: 1 }),
            makeTask('due-tail', { projectId: project.id, title: 'Review due tail', order: 2, reviewAt: '2020-01-01' }),
        ];
        const updateTask = vi.fn();
        useTaskStore.setState({ _allTasks: tasks, tasks, _allProjects: [project], projects: [project], updateTask });
        const { getByRole, getByText, queryByText, container } = renderWithProviders(<ReviewView />);
        expect(getByText('Review due tail')).toBeInTheDocument();
        expect(queryByText('Later tail')).not.toBeInTheDocument();
        expect(queryByText(/Later in sequence/)).not.toBeInTheDocument();
        fireEvent.click(getByRole('button', { name: 'All open tasks' }));
        expect(getByText('Waiting head')).toBeInTheDocument();
        const disclosure = getByRole('button', { name: 'Later in sequence (2)' });
        expect(disclosure).toHaveAttribute('aria-expanded', 'false');
        expect(queryByText('Later tail')).not.toBeInTheDocument();
        fireEvent.click(disclosure);
        expect(getByText('Later tail')).toBeInTheDocument();
        expect(container.querySelector('[data-task-id="tail"]')).toBeInTheDocument();
        fireEvent.click(disclosure);
        expect(queryByText('Later tail')).not.toBeInTheDocument();
        expect(updateTask).not.toHaveBeenCalled();
        expect(useTaskStore.getState()._allTasks).toEqual(tasks);
        fireEvent.click(disclosure);
        fireEvent.doubleClick(getByText('Later tail'));
        expect(useUiStore.getState().editingTaskId).toBe('tail');
    });

    it('keeps manual later sequence order when the ordinary review list uses title sort', () => {
        const project = makeProject('sequence', { isSequential: true });
        const tasks = [
            makeTask('head', { projectId: project.id, status: 'waiting', order: 0 }),
            makeTask('zulu', { projectId: project.id, title: 'Zulu comes first', order: 1 }),
            makeTask('alpha', { projectId: project.id, title: 'Alpha comes later', order: 2 }),
        ];
        useTaskStore.setState({ _allTasks: tasks, tasks, _allProjects: [project], projects: [project], settings: { taskSortBy: 'title' } });
        const { getByRole, getByText, container } = renderWithProviders(<ReviewView />);
        fireEvent.click(getByRole('button', { name: 'All open tasks' }));
        fireEvent.click(getByRole('button', { name: 'Select' }));
        fireEvent.click(getByRole('button', { name: 'Select All' }));
        expect(getByText('1 selected - 1 tasks')).toBeInTheDocument();
        expect(getByRole('button', { name: 'Select All' })).toBeDisabled();
        fireEvent.click(getByRole('button', { name: 'Later in sequence (2)' }));
        expect(Array.from(container.querySelectorAll('[data-task-id]')).map((row) => row.getAttribute('data-task-id'))).toEqual(['head', 'zulu', 'alpha']);
    });

    it('renders the review list with a guide button', () => {
        const { getByRole } = renderWithProviders(<ReviewView />);
        expect(getByRole('heading', { name: /^review$/i })).toBeInTheDocument();
        expect(getByRole('button', { name: /weekly review/i })).toBeInTheDocument();
    });

    it('updates the details preference from the direct toolbar toggle', () => {
        const reviewTask = makeTask('review-1', {
            title: 'Review task',
            location: 'Desk lamp',
        });

        useTaskStore.setState({
            tasks: [reviewTask],
            _allTasks: [reviewTask],
            lastDataChangeAt: 1,
        });
        useUiStore.setState((state) => ({
            ...state,
            listOptions: {
                ...state.listOptions,
                showDetails: true,
            },
        }));

        const { getByRole } = renderWithProviders(<ReviewView />);

        fireEvent.click(getByRole('button', { name: /hide details/i }));

        expect(useUiStore.getState().listOptions.showDetails).toBe(false);
        expect(getByRole('button', { name: /show details/i })).toBeInTheDocument();
    });

    it('labels the aggregate scope as open tasks and filters completed tasks from the compact selector', () => {
        const openTask = makeTask('open-1', { title: 'Open review task', status: 'next' });
        const doneTask = makeTask('done-1', { title: 'Completed review task', status: 'done' });
        useTaskStore.setState({
            tasks: [openTask, doneTask],
            _allTasks: [openTask, doneTask],
            lastDataChangeAt: 1,
        });

        const { getByRole, getByText, queryByText } = renderWithProviders(<ReviewView />);

        fireEvent.click(getByRole('button', { name: 'All open tasks' }));
        fireEvent.click(getByRole('combobox', { name: 'Status' }));
        expect(getByRole('option', { name: 'Open tasks (1)' })).toBeInTheDocument();
        expect(getByText('Open review task')).toBeInTheDocument();
        expect(queryByText('Completed review task')).not.toBeInTheDocument();

        fireEvent.click(getByRole('option', { name: 'Done (1)' }));

        expect(getByText('Completed review task')).toBeInTheDocument();
        expect(queryByText('Open review task')).not.toBeInTheDocument();
    });

    it('selects and clears all visible review tasks', () => {
        const tasks = [
            makeTask('review-1', { title: 'First review task' }),
            makeTask('review-2', { title: 'Second review task' }),
        ];
        useTaskStore.setState({
            tasks,
            _allTasks: tasks,
            lastDataChangeAt: 1,
        });

        const { getAllByRole, getByRole } = renderWithProviders(<ReviewView />);

        fireEvent.click(getByRole('button', { name: 'All open tasks' }));
        fireEvent.click(getByRole('button', { name: 'Select' }));
        fireEvent.click(getByRole('button', { name: 'Select All' }));

        expect(getAllByRole('checkbox', { name: 'Select task' }).map((checkbox) => (
            (checkbox as HTMLInputElement).checked
        ))).toEqual([true, true]);

        fireEvent.click(getByRole('button', { name: 'Clear' }));

        expect(getAllByRole('checkbox', { name: 'Select task' }).map((checkbox) => (
            (checkbox as HTMLInputElement).checked
        ))).toEqual([false, false]);
    });

    it('shows bulk organize for selected review tasks', () => {
        const tasks = [
            makeTask('review-1', { title: 'First review task' }),
            makeTask('review-2', { title: 'Second review task' }),
        ];
        useTaskStore.setState({
            tasks,
            _allTasks: tasks,
            lastDataChangeAt: 1,
        });

        const { getByRole } = renderWithProviders(<ReviewView />);

        fireEvent.click(getByRole('button', { name: 'All open tasks' }));
        fireEvent.click(getByRole('button', { name: 'Select' }));
        fireEvent.click(getByRole('button', { name: 'Select All' }));

        expect(getByRole('button', { name: 'Bulk organize' })).toBeInTheDocument();
    });

    it('defaults to due reminders and keeps future and undated tasks in the overview', () => {
        const due = makeTask('due', { title: 'Due reminder', reviewAt: dateStringFromToday(0) });
        const future = makeTask('future', { title: 'Future reminder', reviewAt: dateStringFromToday(1) });
        const undated = makeTask('undated', { title: 'Undated task' });
        const done = makeTask('done', { title: 'Completed task', status: 'done' });
        const archived = makeTask('archived', { title: 'Archived task', status: 'archived' });
        useTaskStore.setState({ tasks: [due, future, undated, done, archived], _allTasks: [due, future, undated, done, archived] });
        const { getByRole, getByText, queryByText } = renderWithProviders(<ReviewView />);
        expect(getByText('Due reminder')).toBeInTheDocument();
        expect(queryByText('Future reminder')).not.toBeInTheDocument();
        expect(queryByText('Undated task')).not.toBeInTheDocument();

        fireEvent.click(getByRole('button', { name: 'All open tasks' }));
        expect(getByText('Future reminder')).toBeInTheDocument();
        expect(getByText('Undated task')).toBeInTheDocument();
        expect(queryByText('Archived task')).not.toBeInTheDocument();
        fireEvent.click(getByRole('button', { name: 'Done tasks' }));
        expect(getByText('Completed task')).toBeInTheDocument();
        expect(queryByText('Due reminder')).not.toBeInTheDocument();
    });

    it.each([
        { reviewOffset: undefined, groupBy: 'none' },
        { reviewOffset: 1, groupBy: 'none' },
        { reviewOffset: undefined, groupBy: 'status' },
    ])('reveals and scrolls to a deferred search target outside Due ($reviewOffset, $groupBy)', async ({ reviewOffset, groupBy }) => {
        const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
        window.localStorage.setItem('mindwtr:view:review:v1', JSON.stringify({ filterStatus: 'all', groupBy }));
        const target = makeTask('deferred', {
            title: 'Deferred search target',
            startTime: dateStringFromToday(7),
            reviewAt: reviewOffset === undefined ? undefined : dateStringFromToday(reviewOffset),
        });
        const due = makeTask('due', { title: 'Due reminder', reviewAt: dateStringFromToday(0) });
        const tasks = [target, due];
        useTaskStore.setState({ tasks, _allTasks: tasks });
        expect(resolveTaskNavigationView(target)).toBe('review');

        useTaskStore.getState().setHighlightTask(target.id);
        const { getByRole, getByText, queryByText } = renderWithProviders(<ReviewView />);

        expect(getByText(target.title)).toBeInTheDocument();
        expect(document.querySelector(`[data-task-id="${target.id}"]`)).toBeInTheDocument();
        expect(getByRole('button', { name: 'All open tasks' })).toHaveAttribute('aria-pressed', 'true');
        expect(scrollIntoView.mock.instances.some((element) => element instanceof Element && element.getAttribute('data-task-id') === target.id)).toBe(true);
        expect(useTaskStore.getState().tasks).toEqual(tasks);

        scrollIntoView.mockClear();
        const reselectionClock = vi.spyOn(Date, 'now').mockReturnValue(useTaskStore.getState().highlightTaskAt! + 1);
        act(() => useTaskStore.getState().setHighlightTask(target.id));
        reselectionClock.mockRestore();
        expect(scrollIntoView.mock.instances.some((element) => element instanceof Element && element.getAttribute('data-task-id') === target.id)).toBe(true);

        fireEvent.click(getByRole('button', { name: 'Due for review' }));
        expect(queryByText(target.title)).not.toBeInTheDocument();
        expect(getByText(due.title)).toBeInTheDocument();
        act(() => useTaskStore.setState({ tasks: [...tasks] }));
        expect(getByRole('button', { name: 'Due for review' })).toHaveAttribute('aria-pressed', 'true');


        const highlightAt = useTaskStore.getState().highlightTaskAt!;
        const clock = vi.spyOn(Date, 'now').mockReturnValue(highlightAt + 1);
        act(() => useTaskStore.getState().setHighlightTask(target.id));
        clock.mockRestore();
        await waitFor(() => expect(getByText(target.title)).toBeInTheDocument());
        scrollIntoView.mockRestore();
    });

    it('keeps Due selected when the deferred search target is already due for review', () => {
        const target = makeTask('deferred-due', {
            title: 'Deferred due target',
            startTime: dateStringFromToday(7),
            reviewAt: dateStringFromToday(0),
        });
        useTaskStore.setState({ tasks: [target], _allTasks: [target] });
        expect(resolveTaskNavigationView(target)).toBe('review');
        useTaskStore.getState().setHighlightTask(target.id);
        const { getByRole, getByText } = renderWithProviders(<ReviewView />);

        expect(getByText(target.title)).toBeInTheDocument();
        expect(getByRole('button', { name: 'Due for review' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('clears only filters that hide a new search target and allows later filter changes', () => {
        const target = makeTask('deferred', { title: 'Deferred search target', startTime: dateStringFromToday(7) });
        useTaskStore.setState({ tasks: [target], _allTasks: [target] });
        const { getByRole, getByText, queryByText } = renderWithProviders(<ReviewView />);
        fireEvent.click(getByRole('button', { name: 'All open tasks' }));
        fireEvent.click(getByRole('button', { name: 'Done tasks' }));
        fireEvent.change(getByRole('textbox', { name: 'Search...' }), { target: { value: 'unrelated' } });
        act(() => useTaskStore.getState().setHighlightTask(target.id));

        expect(getByText(target.title)).toBeInTheDocument();
        expect(getByRole('textbox', { name: 'Search...' })).toHaveValue('');
        fireEvent.click(getByRole('combobox', { name: 'Status' }));
        fireEvent.click(getByRole('option', { name: 'Next (1)' }));
        fireEvent.change(getByRole('textbox', { name: 'Search...' }), { target: { value: 'Deferred' } });
        act(() => useTaskStore.getState().setHighlightTask(null));
        act(() => useTaskStore.getState().setHighlightTask(target.id));
        expect(getByRole('combobox', { name: 'Status' })).toHaveTextContent('Next (1)');
        expect(getByRole('textbox', { name: 'Search...' })).toHaveValue('Deferred');

        fireEvent.change(getByRole('textbox', { name: 'Search...' }), { target: { value: 'unrelated' } });
        expect(queryByText(target.title)).not.toBeInTheDocument();
        expect(getByRole('textbox', { name: 'Search...' })).toHaveValue('unrelated');
    });

    it('marks selected due reminders reviewed after the write succeeds', async () => {
        const due = makeTask('due', { title: 'Due reminder', reviewAt: dateStringFromToday(0) });
        const batchUpdateTasks = vi.fn(async (updates: { id: string; updates: Partial<Task> }[]) => {
            useTaskStore.setState((state) => ({ tasks: state.tasks.map((task) => updates.find(({ id }) => id === task.id)
                ? { ...task, reviewAt: undefined } : task) }));
            return { success: true };
        });
        useTaskStore.setState({ tasks: [due], _allTasks: [due], batchUpdateTasks });
        const { getByRole, getByText, queryByText } = renderWithProviders(<ReviewView />);
        fireEvent.click(getByRole('button', { name: 'Select' }));
        fireEvent.click(getByRole('button', { name: 'Select All' }));
        fireEvent.click(getByRole('button', { name: 'Mark reviewed' }));
        await waitFor(() => expect(batchUpdateTasks).toHaveBeenCalledWith([{ id: 'due', updates: { reviewAt: undefined } }]));
        await waitFor(() => expect(queryByText('Due reminder')).not.toBeInTheDocument());
        expect(getByText('No review reminders are due.')).toBeInTheDocument();
    });

    it('auto-skips an empty weekly review to the all-clear state while showing checked stages', async () => {
        const { getByText } = renderWithProviders(<ReviewView />);

        fireEvent.click(getByText('Weekly Review'));
        await waitForExternalCalendarIdle();

        await waitFor(() => expect(getByText('Review Complete!')).toBeInTheDocument());
        expect(getByText('Process Inbox')).toBeInTheDocument();
        expect(getByText('Review Calendar')).toBeInTheDocument();
    });

    it('navigates through the wizard steps that have review work', async () => {
        const project = makeProject('project-1', { title: 'Launch Project' });
        const tasks = [
            makeTask('inbox-1', { title: 'Inbox item', status: 'inbox' }),
            makeTask('calendar-1', { title: 'Calendar item', dueDate: dateStringFromToday(1), status: 'next' }),
            makeTask('waiting-1', { title: 'Waiting item', status: 'waiting' }),
            makeTask('context-1', { title: 'Context item', contexts: ['@home'], status: 'next' }),
            makeTask('project-1-task', { title: 'Project item', projectId: project.id, status: 'next' }),
            makeTask('someday-1', { title: 'Someday item', status: 'someday' }),
        ];
        useTaskStore.setState({
            tasks,
            _allTasks: tasks,
            projects: [project],
            _allProjects: [project],
            settings: {
                gtd: {
                    weeklyReview: {
                        includeContextStep: true,
                    },
                },
            },
        });
        const { getByRole, getByText, queryByRole } = renderWithProviders(<ReviewView />);

        fireEvent.click(getByText('Weekly Review'));
        await waitForExternalCalendarIdle();
        expect(getByRole('heading', { level: 1, name: 'Process Inbox' })).toBeInTheDocument();
        expect(getByText('Inbox Zero Goal')).toBeInTheDocument();
        expect(getByRole('button', { name: 'Process Inbox (1)' })).toBeInTheDocument();

        fireEvent.click(getByText('Next Step'));
        expect(getByRole('heading', { level: 1, name: 'Stale items' })).toBeInTheDocument();
        fireEvent.click(getByText('Next Step'));

        expect(getByRole('heading', { level: 1, name: 'Review Calendar' })).toBeInTheDocument();
        expect(getByText('Events')).toBeInTheDocument();
        expect(getByText('Look at the next week. What do you need to prepare for? Capture any new next actions.')).toBeInTheDocument();

        fireEvent.click(getByText('Next Step'));
        expect(getByRole('heading', { level: 1, name: 'Waiting For' })).toBeInTheDocument();

        fireEvent.click(getByText('Next Step'));
        const contextsVisible = queryByRole('heading', { level: 1, name: 'Contexts' });
        if (contextsVisible) {
            expect(contextsVisible).toBeInTheDocument();
            fireEvent.click(getByText('Next Step'));
        }
        expect(getByRole('heading', { level: 1, name: 'Review Projects' })).toBeInTheDocument();

        fireEvent.click(getByText('Next Step'));
        expect(getByRole('heading', { level: 1, name: 'Someday/Maybe' })).toBeInTheDocument();

        fireEvent.click(getByText('Next Step'));
        expect(getByRole('heading', { name: 'Review Complete!' })).toBeInTheDocument();
        expect(getByText('Finish')).toBeInTheDocument();
    });

    it('can navigate back', async () => {
        const freshIso = new Date().toISOString();
        const tasks = [
            makeTask('inbox-1', { title: 'Inbox item', status: 'inbox' }),
            makeTask('waiting-1', { title: 'Waiting item', status: 'waiting', updatedAt: freshIso }),
        ];
        useTaskStore.setState({
            tasks,
            _allTasks: tasks,
            settings: {
                gtd: {
                    weeklyReview: {
                        includeContextStep: false,
                    },
                },
            },
        });
        const { getByRole, getByText, queryByText } = renderWithProviders(<ReviewView />);

        fireEvent.click(getByText('Weekly Review'));
        await waitForExternalCalendarIdle();
        expect(getByRole('heading', { level: 1, name: 'Process Inbox' })).toBeInTheDocument();

        fireEvent.click(getByText('Next Step'));
        expect(getByRole('heading', { level: 1, name: 'Waiting For' })).toBeInTheDocument();
        expect(queryByText('Inbox Zero Goal')).not.toBeInTheDocument();
        fireEvent.click(getByText('Back'));
        expect(getByText('Inbox Zero Goal')).toBeInTheDocument();
    });

    it('can apply AI Someday suggestions for stale projects', async () => {
        const project = makeProject('project-1', {
            title: 'Stale Project',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        });
        const updateProject = vi.fn(async () => ({ success: true }));
        const responseText = vi.fn(async () => JSON.stringify({
            choices: [{
                message: {
                    content: JSON.stringify({
                        suggestions: [{
                            id: 'project:project-1',
                            action: 'someday',
                            reason: 'No movement for a long time.',
                        }],
                    }),
                },
            }],
        }));
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            text: responseText,
        } as unknown as Response);
        useTaskStore.setState({
            projects: [project],
            _allProjects: [project],
            settings: {
                ai: {
                    enabled: true,
                    provider: 'openai',
                    baseUrl: 'https://ai.example.com/v1',
                    model: 'gpt-4o-mini',
                },
                gtd: {
                    weeklyReview: {
                        includeContextStep: false,
                    },
                },
            },
            updateProject,
        });

        const { getByRole, getByText } = renderWithProviders(<ReviewView />);

        fireEvent.click(getByText('Weekly Review'));
        await waitFor(() => expect(getByRole('heading', { level: 1, name: 'Stale items' })).toBeInTheDocument());

        fireEvent.click(getByRole('button', { name: 'Run analysis' }));

        await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
        await waitFor(() => expect(responseText).toHaveBeenCalledOnce());
        const projectSuggestion = await waitFor(() => (
            getByRole('button', { name: 'Stale Project: Move to Someday' })
        ));
        expect(projectSuggestion).toHaveAttribute('aria-pressed', 'true');

        fireEvent.click(getByRole('button', { name: 'Apply selected (1)' }));

        await waitFor(() => {
            expect(updateProject).toHaveBeenCalledWith('project-1', { status: 'someday' });
        });
        fetchSpy.mockRestore();
    });

    it('parses quick-add date commands when adding a task during project review', async () => {
        const addTask = vi.fn(async () => ({ success: true }));
        const project = makeProject('project-1', { title: 'Launch Project', updatedAt: new Date().toISOString() });
        useTaskStore.setState({
            projects: [project],
            _allProjects: [project],
            settings: {
                quickAddAutoClean: true,
                gtd: {
                    weeklyReview: {
                        includeContextStep: false,
                    },
                },
            },
            addTask,
        });

        const { getByText, getByRole, getByPlaceholderText } = renderWithProviders(<ReviewView />);

        fireEvent.click(getByText('Weekly Review'));
        await waitForExternalCalendarIdle();

        expect(getByRole('heading', { level: 1, name: 'Review Projects' })).toBeInTheDocument();
        fireEvent.click(getByRole('button', { name: 'Add Task' }));
        fireEvent.change(getByPlaceholderText('Add Task'), {
            target: { value: 'Draft launch plan /due:2026-05-30' },
        });
        fireEvent.click(getByRole('button', { name: 'Add' }));

        await waitFor(() => {
            expect(addTask).toHaveBeenCalledWith(
                'Draft launch plan',
                expect.objectContaining({
                    projectId: 'project-1',
                    status: 'next',
                    dueDate: expect.stringContaining('2026-05-30'),
                }),
            );
        });
    });
});
