import { beforeEach, describe, it, expect, vi } from 'vitest';
import { act, render, fireEvent, waitFor, within } from '@testing-library/react';
import { useTaskStore, type Project, type Task } from '@mindwtr/core';
import { ReviewView } from './ReviewView';
import { LanguageProvider } from '../../contexts/language-context';
import { useUiStore } from '../../store/ui-store';
import { fetchExternalCalendarEvents } from '../../lib/external-calendar-events';

const renderWithProviders = (ui: React.ReactElement) => {
    return render(
        <LanguageProvider>
            {ui}
        </LanguageProvider>
    );
};

// Keep review calendar stages genuinely empty unless a test seeds calendar work.
vi.mock('../../lib/external-calendar-events', () => ({
    fetchExternalCalendarEvents: vi.fn(async () => ({ events: [], warnings: [] })),
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
                focusTop3Only: false,
            },
            expandedTaskIds: {},
        });
    });

    it('renders the review list with a guide button', () => {
        const { getByRole } = renderWithProviders(<ReviewView />);
        expect(getByRole('heading', { name: /^review$/i })).toBeInTheDocument();
        expect(getByRole('button', { name: /weekly review/i })).toBeInTheDocument();
    });

    it('hides compact metadata when the details toggle is turned off', () => {
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

        const { getByRole, queryByText } = renderWithProviders(<ReviewView />);

        expect(queryByText('Desk lamp')).toBeInTheDocument();

        fireEvent.click(getByRole('button', { name: /^view$/i }));
        fireEvent.click(within(getByRole('dialog', { name: /^view$/i })).getByRole('button', { name: /^details$/i }));

        expect(queryByText('Desk lamp')).not.toBeInTheDocument();
        expect(useUiStore.getState().listOptions.showDetails).toBe(false);
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

        fireEvent.click(getByRole('button', { name: 'Select' }));
        fireEvent.click(getByRole('button', { name: 'Select All' }));

        expect(getByRole('button', { name: 'Bulk organize' })).toBeInTheDocument();
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
