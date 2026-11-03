import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AREA_FILTER_ALL, buildEntityMap, getStorageAdapter, setStorageAdapter, safeFormatDate, useTaskStore, type Area, type Project, type Task } from '@mindwtr/core';
import { LanguageProvider } from '../contexts/language-context';
import { useUiStore } from '../store/ui-store';
import { GlobalSearch } from './GlobalSearch';
import { registerTaskEditExitRequest } from './Task/task-edit-session';


import { beginNotifyProfile, endNotifyProfile } from '../../../../packages/core/src/store-notify-profiler';

const initialTaskState = useTaskStore.getState();
const initialUiState = useUiStore.getState();
const initialStorageAdapter = getStorageAdapter();
const originalScrollIntoView = Element.prototype.scrollIntoView;
const now = '2026-05-03T00:00:00.000Z';

const areas: Area[] = [
    {
        id: 'area-work',
        name: 'Work',
        color: '#2563eb',
        order: 0,
        createdAt: now,
        updatedAt: now,
    },
    {
        id: 'area-home',
        name: 'Home',
        color: '#16a34a',
        order: 1,
        createdAt: now,
        updatedAt: now,
    },
];

const tasks: Task[] = [
    {
        id: 'task-work',
        title: 'Work task',
        status: 'next',
        tags: [],
        contexts: [],
        areaId: 'area-work',
        createdAt: now,
        updatedAt: now,
    },
    {
        id: 'task-home',
        title: 'Home needle task',
        status: 'next',
        tags: [],
        contexts: [],
        areaId: 'area-home',
        createdAt: now,
        updatedAt: now,
    },
    {
        id: 'task-done',
        title: 'Completed report',
        status: 'done',
        tags: [],
        contexts: [],
        createdAt: now,
        updatedAt: now,
        completedAt: now,
    },
    {
        id: 'task-archived',
        title: 'Archived report',
        status: 'archived',
        tags: [],
        contexts: [],
        createdAt: now,
        updatedAt: now,
        completedAt: now,
    },
];

describe('GlobalSearch', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        Element.prototype.scrollIntoView = vi.fn();
        useTaskStore.setState(initialTaskState, true);
        useUiStore.setState(initialUiState, true);
        useTaskStore.setState({
            _allTasks: tasks,
            _allProjects: [],
            _allAreas: areas,
            settings: {
                filters: {
                    areaId: 'area-work',
                },
            },
        });
    });

    afterEach(() => {
        setStorageAdapter(initialStorageAdapter);
        if (originalScrollIntoView) {
            Element.prototype.scrollIntoView = originalScrollIntoView;
        } else {
            delete (Element.prototype as { scrollIntoView?: Element['scrollIntoView'] }).scrollIntoView;
        }
        vi.useRealTimers();
        useUiStore.setState(initialUiState, true);
    });

    it.each([
        { query: '@computer', expected: ['Context match'], usesFts: false },
        { query: '@upload', expected: [], usesFts: false },
        { query: 'computer', expected: ['Computer title only', 'Context match'], usesFts: true },
    ])('routes $query correctly after the search debounce', async ({ query, expected, usesFts }) => {
        const contextTask: Task = { ...tasks[0], id: 'context-match', title: 'Context match', contexts: ['@computer'] };
        const computerTask: Task = { ...tasks[0], id: 'computer-title', title: 'Computer title only' };
        const uploadTask: Task = { ...tasks[0], id: 'upload-title', title: 'Upload title only' };
        useTaskStore.setState({ _allTasks: [contextTask, computerTask, uploadTask] });
        const searchAll = vi.fn(async (value: string) => ({
            tasks: value.includes('upload') ? [uploadTask] : [computerTask, contextTask], projects: [],
        }));
        setStorageAdapter({ ...initialStorageAdapter, searchAll });
        render(<LanguageProvider><GlobalSearch onNavigate={vi.fn()} /></LanguageProvider>);
        await act(async () => {
            window.dispatchEvent(new Event('mindwtr:open-search'));
            await vi.advanceTimersByTimeAsync(50);
        });
        fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), { target: { value: query } });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(200);
        });
        const titles = Array.from(screen.getByRole('dialog').querySelectorAll('[data-search-index] .font-medium'))
            .map((element) => element.textContent);
        expect(titles).toEqual(expected);
        if (usesFts) expect(searchAll).toHaveBeenCalledExactlyOnceWith(query);
        else expect(searchAll).not.toHaveBeenCalled();
    });


    it('bounds the dialog height and keeps the filter and result regions scrollable', async () => {
        render(
            <LanguageProvider>
                <GlobalSearch onNavigate={vi.fn()} />
            </LanguageProvider>
        );

        await act(async () => {
            window.dispatchEvent(new Event('mindwtr:open-search'));
            await vi.advanceTimersByTimeAsync(50);
        });


        const panel = screen.getByRole('dialog');
        expect(panel.className).toContain('max-h-[76vh]');

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
            await vi.advanceTimersByTimeAsync(50);
        });

        const scrollRegions = Array.from(panel.querySelectorAll<HTMLElement>(':scope > div'))
            .filter((region) => region.className.includes('overflow-y-auto'));
        expect(scrollRegions).toHaveLength(2);
        for (const region of scrollRegions) {
            expect(region.className).toContain('min-h-0');
        }


        expect(screen.queryByText('Type to search...')).not.toBeInTheDocument();

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
            await vi.advanceTimersByTimeAsync(50);
        });
        expect(screen.getByText('Type to search...')).toBeInTheDocument();
    });


    it('declares the query input off-limits to OS autocorrect and auto-capitalization', async () => {
        render(
            <LanguageProvider>
                <GlobalSearch onNavigate={vi.fn()} />
            </LanguageProvider>
        );

        await act(async () => {
            window.dispatchEvent(new Event('mindwtr:open-search'));
            await vi.advanceTimersByTimeAsync(50);
        });

        const input = screen.getByRole('textbox');
        expect(input).toHaveAttribute('autocorrect', 'off');
        expect(input).toHaveAttribute('autocapitalize', 'none');
        expect(input).toHaveAttribute('spellcheck', 'false');
    });

    it('searches all areas when opened from an active area filter', async () => {
        render(
            <LanguageProvider>
                <GlobalSearch onNavigate={vi.fn()} />
            </LanguageProvider>
        );

        await act(async () => {
            window.dispatchEvent(new Event('mindwtr:open-search'));
            await vi.advanceTimersByTimeAsync(50);
        });

        expect(screen.queryByText('Area: Work')).not.toBeInTheDocument();

        await act(async () => {
            fireEvent.change(screen.getByRole('textbox'), {
                target: { value: 'needle' },
            });
            await vi.advanceTimersByTimeAsync(200);
            await Promise.resolve();
        });

        expect(screen.getByText((_, element) => element?.textContent === 'Home needle task')).toBeInTheDocument();
    });

    it('highlights every nonadjacent query term in a result title', async () => {
        render(
            <LanguageProvider>
                <GlobalSearch onNavigate={vi.fn()} />
            </LanguageProvider>
        );

        await act(async () => {
            window.dispatchEvent(new Event('mindwtr:open-search'));
            await vi.advanceTimersByTimeAsync(50);
        });
        await act(async () => {
            fireEvent.change(screen.getByRole('textbox'), {
                target: { value: 'needle HOME' },
            });
            await vi.advanceTimersByTimeAsync(200);
            await Promise.resolve();
        });

        const title = document.querySelector<HTMLElement>('[data-search-index="0"] .font-medium');
        expect(title?.textContent).toBe('Home needle task');
        expect(Array.from(title!.querySelectorAll('.text-primary.font-semibold')).map((node) => node.textContent))
            .toEqual(['Home', 'needle']);
    });

    it('refreshes hidden-future results at midnight and at an explicit start time', async () => {
        vi.setSystemTime(new Date('2026-04-16T23:59:30'));
        useTaskStore.setState({
            _allTasks: [
                {
                    ...tasks[0],
                    id: 'tomorrow-date',
                    title: 'Tomorrow date task',
                    startTime: '2026-04-17',
                },
                {
                    ...tasks[0],
                    id: 'tomorrow-time',
                    title: 'Tomorrow timed task',
                    startTime: '2026-04-17T00:01',
                },
            ],
        });
        render(
            <LanguageProvider>
                <GlobalSearch onNavigate={vi.fn()} />
            </LanguageProvider>
        );

        await act(async () => {
            window.dispatchEvent(new Event('mindwtr:open-search'));
            await vi.advanceTimersByTimeAsync(50);
        });
        fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
        fireEvent.click(screen.getByRole('button', { name: 'Hide future tasks' }));
        expect(screen.queryByText('Tomorrow date task')).not.toBeInTheDocument();
        expect(screen.queryByText('Tomorrow timed task')).not.toBeInTheDocument();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(30_100);
        });
        expect(screen.getByText('Tomorrow date task')).toBeInTheDocument();
        expect(screen.queryByText('Tomorrow timed task')).not.toBeInTheDocument();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(60_100);
        });
        expect(screen.getByText('Tomorrow timed task')).toBeInTheDocument();
    });

    it('switches the sidebar area filter to all areas when opening a task hidden by the active area', async () => {
        const onNavigate = vi.fn();
        const showToast = vi.fn();
        const updateSettings = vi.fn().mockResolvedValue(undefined);
        useTaskStore.setState((state) => ({ ...state, updateSettings }));
        useUiStore.setState((state) => ({ ...state, showToast }));
        render(
            <LanguageProvider>
                <GlobalSearch onNavigate={onNavigate} />
            </LanguageProvider>
        );

        await act(async () => {
            window.dispatchEvent(new Event('mindwtr:open-search'));
            await vi.advanceTimersByTimeAsync(50);
        });

        await act(async () => {
            fireEvent.change(screen.getByRole('textbox'), {
                target: { value: 'needle' },
            });
            await vi.advanceTimersByTimeAsync(200);
            await Promise.resolve();
        });

        const resultButton = screen.getByText((_, element) => element?.textContent === 'Home needle task')
            .closest('button');
        expect(resultButton).toBeTruthy();
        await act(async () => {
            resultButton!.click();
            await Promise.resolve();
        });

        expect(updateSettings).toHaveBeenCalledWith({ filters: { areaId: AREA_FILTER_ALL, areaIds: [], excludedAreaIds: [] } });
        expect(showToast).toHaveBeenCalledWith(
            'Switched to All Areas so the selected item is visible.',
            'info',
        );
        expect(onNavigate).toHaveBeenCalledWith('next', 'task-home', { highlightTaskId: 'task-home' });
    });

    it('waits for the edit-exit decision before selecting a search project', async () => {
        const onNavigate = vi.fn();
        const destination: Project = {
            id: 'project-b',
            title: 'Project Beta',
            status: 'active',
            color: '#2563eb',
            order: 1,
            tagIds: [],
            createdAt: now,
            updatedAt: now,
        };
        let pendingSelection: (() => void) | undefined;
        const release = registerTaskEditExitRequest((action) => {
            pendingSelection = action;
        });
        useTaskStore.setState({ _allProjects: [destination], settings: {} });
        useUiStore.setState({ projectView: { selectedProjectId: 'project-a' } });
        render(<LanguageProvider><GlobalSearch onNavigate={onNavigate} /></LanguageProvider>);

        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:open-search', { detail: { query: 'Project Beta' } }));
            await vi.advanceTimersByTimeAsync(250);
        });
        fireEvent.click(screen.getByText((_, element) => element?.textContent === 'Project Beta').closest('button')!);

        expect(pendingSelection).toBeTypeOf('function');
        expect(useUiStore.getState().projectView.selectedProjectId).toBe('project-a');
        expect(onNavigate).not.toHaveBeenCalled();
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

        await act(async () => pendingSelection!());

        expect(useUiStore.getState().projectView.selectedProjectId).toBe('project-b');
        expect(onNavigate).toHaveBeenCalledWith('projects', 'project-b');
        release();
    });

    it('keeps task navigation unchanged when save is rejected or the user stays', async () => {
        const onNavigate = vi.fn();
        const destination = { ...tasks[0], id: 'project-task', title: 'Project task', projectId: 'project-b' };
        let pendingSelection: (() => void) | undefined;
        const release = registerTaskEditExitRequest((action) => {
            pendingSelection = action;
        });
        useTaskStore.setState({ _allTasks: [destination], settings: {} });
        useUiStore.setState({ projectView: { selectedProjectId: 'project-a' } });
        render(<LanguageProvider><GlobalSearch onNavigate={onNavigate} /></LanguageProvider>);

        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:open-search', { detail: { query: 'Project task' } }));
            await vi.advanceTimersByTimeAsync(250);
        });
        fireEvent.click(screen.getByText((_, element) => element?.textContent === 'Project task').closest('button')!);

        expect(pendingSelection).toBeTypeOf('function');
        expect(useUiStore.getState().projectView.selectedProjectId).toBe('project-a');
        expect(useTaskStore.getState().highlightTaskId).toBeNull();
        expect(onNavigate).not.toHaveBeenCalled();
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        release();
    });

    it('shows Done and Archived tasks when only status filters are selected', async () => {
        render(
            <LanguageProvider>
                <GlobalSearch onNavigate={vi.fn()} />
            </LanguageProvider>
        );

        await act(async () => {
            window.dispatchEvent(new Event('mindwtr:open-search'));
            await vi.advanceTimersByTimeAsync(50);
        });

        fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
        fireEvent.click(screen.getByRole('button', { name: 'Done' }));
        fireEvent.click(screen.getByRole('button', { name: 'Archived' }));

        expect(screen.getByText('Completed report')).toBeInTheDocument();
        expect(screen.getByText('Archived report')).toBeInTheDocument();
        expect(screen.queryByText('Work task')).not.toBeInTheDocument();
        expect(screen.queryByText('Type to search')).not.toBeInTheDocument();
    });

    it('offers parent tokens only for tasks eligible under current search visibility', async () => {
        useTaskStore.setState({
            _allTasks: [
                { ...tasks[0], id: 'done-tool', title: 'Done tool', status: 'done', contexts: ['@tools/excavator'], areaId: 'area-work' },
                { ...tasks[0], id: 'active-gear', title: 'Active gear', contexts: ['@gear/hammer'], areaId: 'area-work' },
                { ...tasks[1], id: 'home-task', title: 'Home task', contexts: ['@home'] },
            ],
        });
        render(<LanguageProvider><GlobalSearch onNavigate={vi.fn()} /></LanguageProvider>);
        await act(async () => {
            window.dispatchEvent(new Event('mindwtr:open-search'));
            await vi.advanceTimersByTimeAsync(50);
        });
        fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
        expect(screen.queryByRole('button', { name: '@tools' })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: '@gear' })).toBeInTheDocument();

        fireEvent.change(screen.getByRole('combobox', { name: 'Area' }), { target: { value: 'area-home' } });
        expect(screen.queryByRole('button', { name: '@gear' })).not.toBeInTheDocument();
        fireEvent.change(screen.getByRole('combobox', { name: 'Area' }), { target: { value: 'all' } });
        fireEvent.click(screen.getByRole('button', { name: 'Include Done and Archived tasks', pressed: false }));
        expect(screen.getByRole('button', { name: '@tools' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: '@tools' }));
        fireEvent.click(screen.getByRole('button', { name: 'Include Done and Archived tasks', pressed: true }));
        expect(screen.getAllByRole('button', { name: '@tools' })).toHaveLength(2);
        fireEvent.click(screen.getAllByRole('button', { name: '@tools' })[0]);
        expect(screen.queryByRole('button', { name: '@tools' })).not.toBeInTheDocument();
    });

    it('uses localized presentation labels for filter sections, options, and chips', async () => {
        render(
            <LanguageProvider>
                <GlobalSearch onNavigate={vi.fn()} />
            </LanguageProvider>
        );

        await act(async () => {
            window.dispatchEvent(new Event('mindwtr:open-search'));
            await vi.advanceTimersByTimeAsync(50);
        });
        fireEvent.click(screen.getByRole('button', { name: 'Filters' }));

        expect(screen.getByText('Status')).toBeInTheDocument();
        expect(screen.getByText('Scope')).toBeInTheDocument();
        expect(screen.getByText('Contexts & tags')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();

        fireEvent.change(screen.getByRole('combobox', { name: 'Due date' }), {
            target: { value: 'tomorrow' },
        });

        expect(screen.getByRole('button', { name: 'Due date: Tomorrow' })).toBeInTheDocument();
    });


    it('includes finished tasks from the start when opened with that default', async () => {
        render(
            <LanguageProvider>
                <GlobalSearch onNavigate={vi.fn()} defaultIncludeCompleted />
            </LanguageProvider>
        );

        await act(async () => {
            window.dispatchEvent(new Event('mindwtr:open-search'));
            await vi.advanceTimersByTimeAsync(50);
        });

        await act(async () => {
            fireEvent.change(screen.getByRole('textbox'), {
                target: { value: 'report' },
            });
            await vi.advanceTimersByTimeAsync(300);
            await Promise.resolve();
        });

        expect(screen.getByText((_, element) => element?.textContent === 'Completed report')).toBeInTheDocument();
        expect(screen.getByText((_, element) => element?.textContent === 'Archived report')).toBeInTheDocument();
    });

    it('opens with a requested person query and completed tasks, then resets for a plain open', async () => {
        useTaskStore.setState({
            _allTasks: [
                ...tasks,
                {
                    id: 'person-done',
                    title: 'Alex completed follow-up',
                    status: 'done',
                    assignedTo: 'Alex',
                    tags: [],
                    contexts: [],
                    createdAt: now,
                    updatedAt: now,
                    completedAt: now,
                },
            ],
        });
        render(
            <LanguageProvider>
                <GlobalSearch onNavigate={vi.fn()} />
            </LanguageProvider>
        );

        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:open-search', {
                detail: { query: 'person:"Alex"', includeCompleted: true },
            }));
            await vi.advanceTimersByTimeAsync(250);
        });

        expect(screen.getByRole('textbox')).toHaveValue('person:"Alex"');
        expect(screen.getByText((_, element) => element?.textContent === 'Alex completed follow-up')).toBeInTheDocument();

        await act(async () => {
            window.dispatchEvent(new Event('mindwtr:open-search'));
            await vi.advanceTimersByTimeAsync(50);
        });

        expect(screen.getByRole('textbox')).toHaveValue('');
        expect(screen.queryByText('Include Done and Archived tasks')).not.toBeInTheDocument();
    });


    describe('routing a task that belongs to a project', () => {
        const projectTask: Task = {
            id: 'project-task',
            title: 'Zeta project work',
            status: 'next',
            projectId: 'project-1',
            tags: [],
            contexts: [],
            createdAt: now,
            updatedAt: now,
        };

        const selectZeta = async (task: Task) => {
            const onNavigate = vi.fn();
            useTaskStore.setState({ _allTasks: [task], settings: {} });
            render(
                <LanguageProvider>
                    <GlobalSearch onNavigate={onNavigate} />
                </LanguageProvider>
            );
            await act(async () => {
                window.dispatchEvent(new Event('mindwtr:open-search'));
                await vi.advanceTimersByTimeAsync(50);
            });
            await act(async () => {
                fireEvent.change(screen.getByRole('textbox'), { target: { value: 'id:project-task' } });
                await vi.advanceTimersByTimeAsync(200);
                await Promise.resolve();
            });
            await act(async () => {
                document.querySelector<HTMLElement>('[data-search-index="0"]')!.click();
                await Promise.resolve();
            });
            return onNavigate;
        };

        it('opens a live task in its project', async () => {
            const onNavigate = await selectZeta(projectTask);

            expect(onNavigate).toHaveBeenCalledWith('projects', projectTask.id, { highlightTaskId: projectTask.id });
        });

        it('sends a done task to Done instead', async () => {
            const onNavigate = await selectZeta({ ...projectTask, status: 'done', completedAt: now });

            expect(onNavigate).toHaveBeenCalledWith('done', projectTask.id, { highlightTaskId: projectTask.id });
        });

        it('sends an archived task to Archive instead', async () => {
            const onNavigate = await selectZeta({ ...projectTask, status: 'archived', completedAt: now });

            expect(onNavigate).toHaveBeenCalledWith('archived', projectTask.id, { highlightTaskId: projectTask.id });
        });
    });


    describe('result dates', () => {
        const base: Task = {
            id: 'seed',
            title: 'seed',
            status: 'next',
            tags: [],
            contexts: [],
            createdAt: now,
            updatedAt: now,
        };
        const completedAt = '2026-05-01T09:15:00.000Z';
        const dateTasks: Task[] = [
            { ...base, id: 'zeta-done', title: 'Zeta done', status: 'done', completedAt },
            { ...base, id: 'zeta-archived', title: 'Zeta archived', status: 'archived', completedAt },
            { ...base, id: 'zeta-cancelled', title: 'Zeta cancelled', status: 'archived', cancelledAt: completedAt },
            { ...base, id: 'zeta-unstamped', title: 'Zeta unstamped', status: 'archived' },
            { ...base, id: 'zeta-due', title: 'Zeta due', dueDate: '2099-01-01' },
            { ...base, id: 'zeta-overdue', title: 'Zeta overdue', dueDate: '2020-01-01' },
            { ...base, id: 'zeta-plain', title: 'Zeta plain' },
        ];

        const rowFor = (title: string) => {
            const row = Array.from(document.querySelectorAll<HTMLElement>('[data-search-index]'))
                .find((candidate) => candidate.textContent?.includes(title));
            expect(row, `search row for ${title}`).toBeTruthy();
            return row!;
        };

        const searchZeta = async () => {
            useTaskStore.setState({ _allTasks: dateTasks, settings: {} });
            render(
                <LanguageProvider>
                    <GlobalSearch onNavigate={vi.fn()} />
                </LanguageProvider>
            );

            await act(async () => {
                window.dispatchEvent(new Event('mindwtr:open-search'));
                await vi.advanceTimersByTimeAsync(50);
            });
            await act(async () => {
                fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Zeta' } });
                await vi.advanceTimersByTimeAsync(200);
                await Promise.resolve();
            });

            await act(async () => {
                fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
                await vi.advanceTimersByTimeAsync(50);
            });
            await act(async () => {
                fireEvent.click(screen.getByRole('button', { name: 'Include Done and Archived tasks' }));
                await vi.advanceTimersByTimeAsync(200);
            });
        };

        it('labels a finished task with its completion date', async () => {
            await searchZeta();

            const label = `Completed ${safeFormatDate(completedAt, 'Pp')}`;
            expect(rowFor('Zeta done').textContent).toContain(label);

            expect(rowFor('Zeta archived').textContent).toContain(label);
            expect(rowFor('Zeta cancelled').textContent)
                .toContain(`Cancelled ${safeFormatDate(completedAt, 'Pp')}`);
            expect(rowFor('Zeta cancelled').textContent).not.toContain('Completed');
        });

        it('labels an unfinished task with its due date and reddens only the overdue one', async () => {
            await searchZeta();

            expect(rowFor('Zeta due').textContent)
                .toContain(`Due ${safeFormatDate('2099-01-01', 'P')}`);
            expect(within(rowFor('Zeta due')).getByText(/^Due /).className)
                .toContain('text-muted-foreground');

            expect(within(rowFor('Zeta overdue')).getByText(/^Due /).className)
                .toContain('text-destructive');
        });

        it('shows no date at all rather than an ambiguous or empty one', async () => {
            await searchZeta();

            expect(rowFor('Zeta plain').textContent).not.toMatch(/Due|Completed/);

            expect(rowFor('Zeta unstamped').textContent).not.toMatch(/Due|Completed/);
        });
    });
});


describe('GlobalSearch closed-overlay derived-state gating (PERF-01)', () => {
    const BASE_ISO = '2026-05-01T09:00:00.000Z';
    const bigTasks: Task[] = Array.from({ length: 7_000 }, (_, index) => ({
        id: `perf-task-${index}`,
        title: `Synthetic task ${index}`,
        status: 'next',
        tags: [],
        contexts: [],
        createdAt: BASE_ISO,
        updatedAt: BASE_ISO,
    }));

    beforeEach(() => {
        useTaskStore.setState(initialTaskState, true);
        useUiStore.setState(initialUiState, true);
        useTaskStore.setState({
            _allTasks: bigTasks,
            _tasksById: buildEntityMap(bigTasks),
        });
    });

    afterEach(() => {
        useUiStore.setState(initialUiState, true);
    });

    it('costs zero derived-state rebuilds on a write while closed', async () => {
        render(
            <LanguageProvider>
                <GlobalSearch onNavigate={vi.fn()} />
            </LanguageProvider>
        );

        beginNotifyProfile();
        let profile: ReturnType<typeof endNotifyProfile>;
        try {
            await act(async () => {
                await useTaskStore.getState().updateTask('perf-task-3333', { title: 'closed-overlay edit' });
            });
        } finally {
            profile = endNotifyProfile();
        }
        expect(profile?.derivedRebuildCount).toBe(0);
    });


    it('rebuilds when a listener reads getDerivedState() unconditionally (old shape)', async () => {
        const unsubscribe = useTaskStore.subscribe((state) => state.getDerivedState());
        beginNotifyProfile();
        let profile: ReturnType<typeof endNotifyProfile>;
        try {
            await useTaskStore.getState().updateTask('perf-task-4444', { title: 'canary edit' });
        } finally {
            profile = endNotifyProfile();
            unsubscribe();
        }
        expect(profile?.derivedRebuildCount).toBeGreaterThan(0);
    });
});
