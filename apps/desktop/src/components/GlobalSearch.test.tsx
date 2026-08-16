import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AREA_FILTER_ALL, safeFormatDate, useTaskStore, type Area, type Task } from '@mindwtr/core';
import { LanguageProvider } from '../contexts/language-context';
import { useUiStore } from '../store/ui-store';
import { GlobalSearch } from './GlobalSearch';

const initialTaskState = useTaskStore.getState();
const initialUiState = useUiStore.getState();
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
        if (originalScrollIntoView) {
            Element.prototype.scrollIntoView = originalScrollIntoView;
        } else {
            delete (Element.prototype as { scrollIntoView?: Element['scrollIntoView'] }).scrollIntoView;
        }
        vi.useRealTimers();
        useUiStore.setState(initialUiState, true);
    });

    // Tripwire for #957: the panel ran past the bottom of a short window with the
    // filter panel open and nothing to scroll. jsdom cannot measure layout, so pin
    // the three declarations the fix depends on instead.
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

        // role="dialog" sits on the Dialog panel itself; the scrim around it is
        // presentational.
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

        // …and the empty-results hint gives its ~100px to the filter panel rather
        // than making it scroll while nothing is on screen below it (#957).
        expect(screen.queryByText('Type to search...')).not.toBeInTheDocument();

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
            await vi.advanceTimersByTimeAsync(50);
        });
        expect(screen.getByText('Type to search...')).toBeInTheDocument();
    });

    // Queries are operators and partial words; macOS WebKit applied system
    // auto-capitalization to the query input when nothing declared otherwise
    // (#1019). jsdom cannot exercise the OS behavior, so pin the declarations.
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
        expect(onNavigate).toHaveBeenCalledWith('next', 'task-home');
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

    // Opened over the Done or Archived view, search must find the finished
    // tasks the user is looking at — hiding them there read as broken (#1019).
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

    // A project workspace never lists archived tasks and hides done ones unless
    // that project has them switched on, so routing a finished task there sent
    // the user to a page that could not show it (#991).
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

            expect(onNavigate).toHaveBeenCalledWith('projects', projectTask.id);
        });

        it('sends a done task to Done instead', async () => {
            const onNavigate = await selectZeta({ ...projectTask, status: 'done', completedAt: now });

            expect(onNavigate).toHaveBeenCalledWith('done', projectTask.id);
        });

        it('sends an archived task to Archive instead', async () => {
            const onNavigate = await selectZeta({ ...projectTask, status: 'archived', completedAt: now });

            expect(onNavigate).toHaveBeenCalledWith('archived', projectTask.id);
        });
    });

    // A bare date on a search row cannot say whether it is a deadline or a
    // record of when the work finished (#991).
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
            // Done and Archived are filtered out of search by default.
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
            // A status gate that only checks 'done' misses archived (#968).
            expect(rowFor('Zeta archived').textContent).toContain(label);
        });

        it('labels an unfinished task with its due date and reddens only the overdue one', async () => {
            await searchZeta();

            expect(rowFor('Zeta due').textContent)
                .toContain(`Due ${safeFormatDate('2099-01-01', 'P')}`);
            expect(within(rowFor('Zeta due')).getByText(/^Due /).className)
                .toContain('text-muted-foreground');
            // Red is reserved for a date that has passed (#640).
            expect(within(rowFor('Zeta overdue')).getByText(/^Due /).className)
                .toContain('text-destructive');
        });

        it('shows no date at all rather than an ambiguous or empty one', async () => {
            await searchZeta();

            expect(rowFor('Zeta plain').textContent).not.toMatch(/Due|Completed/);
            // Finished with nothing to report: no fallback to the due date.
            expect(rowFor('Zeta unstamped').textContent).not.toMatch(/Due|Completed/);
        });
    });
});
