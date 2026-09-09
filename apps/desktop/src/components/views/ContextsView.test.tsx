import { act, fireEvent, render } from '@testing-library/react';
import type { Task } from '@mindwtr/core';
import { useTaskStore } from '@mindwtr/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../../contexts/language-context';
import { ContextsView } from './ContextsView';
import { CONTEXTS_VIEW_STATE_STORAGE_KEY, dispatchContextsTokenSelection } from '../../lib/contexts-view-state';
import { selectToolbarOption } from '../../test/toolbar-select';
import { expectScrolledEndGap } from '../../test/list-end-gap';

const contextExportInputs = vi.hoisted(() => ({ tasks: null as Task[] | null }));
vi.mock('../../contexts/view-export-context', () => ({
    useViewExportTasks: (tasks: Task[] | null) => {
        contextExportInputs.tasks = tasks;
    },
}));

// Its own key, separate from the view state above: see the note in ContextsView.
const CONTEXTS_GROUP_COLLAPSE_STORAGE_KEY = 'mindwtr:view:contexts:groups:v1';

const initialTaskState = useTaskStore.getState();
const now = '2026-05-12T12:00:00.000Z';

const makeTask = (id: string, overrides: Partial<Task>): Task => ({
    id,
    title: `Task ${id}`,
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
});

const renderContextsView = () => render(
    <LanguageProvider>
        <ContextsView />
    </LanguageProvider>
);

describe('ContextsView', () => {
    beforeEach(() => {
        contextExportInputs.tasks = null;
        window.localStorage.clear();
        useTaskStore.setState(initialTaskState, true);
        const tasks = [
            makeTask('task-1', {
                title: 'Plan launch',
                contexts: ['@Office'],
                tags: ['#ERP', '#Finance'],
            }),
            makeTask('task-2', {
                title: 'Write brief',
                contexts: ['@Home'],
                tags: [],
            }),
        ];
        useTaskStore.setState({
            tasks,
            _allTasks: tasks,
            projects: [],
            areas: [],
            settings: {},
        });
    });

    it('ends both scrollers with the shared end gap, not with viewport padding (#977)', () => {
        const { container } = renderContextsView();
        expectScrolledEndGap(container);
    });

    it('groups context and tag filters into collapsible sections', () => {
        const { getByRole, queryByRole } = renderContextsView();

        const contextsHeader = getByRole('button', { name: 'Contexts (2)' });
        const tagsHeader = getByRole('button', { name: 'Tags (2)' });

        expect(contextsHeader).toHaveAttribute('aria-expanded', 'true');
        expect(tagsHeader).toHaveAttribute('aria-expanded', 'true');
        expect(getByRole('button', { name: '@Office (1)' })).toBeInTheDocument();
        expect(getByRole('button', { name: '@Home (1)' })).toBeInTheDocument();
        expect(getByRole('button', { name: '#ERP (1)' })).toBeInTheDocument();
        expect(getByRole('button', { name: '#Finance (1)' })).toBeInTheDocument();

        fireEvent.click(tagsHeader);

        expect(tagsHeader).toHaveAttribute('aria-expanded', 'false');
        expect(queryByRole('button', { name: '#ERP (1)' })).not.toBeInTheDocument();
        expect(queryByRole('button', { name: '#Finance (1)' })).not.toBeInTheDocument();
        expect(getByRole('button', { name: '@Office (1)' })).toBeInTheDocument();

        fireEvent.click(contextsHeader);

        expect(contextsHeader).toHaveAttribute('aria-expanded', 'false');
        expect(queryByRole('button', { name: '@Office (1)' })).not.toBeInTheDocument();
        expect(queryByRole('button', { name: '@Home (1)' })).not.toBeInTheDocument();
    });

    it('keeps tag filters selectable from the tag section', () => {
        const { getByRole, getByText } = renderContextsView();

        fireEvent.click(getByRole('button', { name: '#ERP (1)' }));

        expect(getByRole('heading', { name: '#ERP' })).toBeInTheDocument();
        expect(getByText('Plan launch')).toBeInTheDocument();
        expect(contextExportInputs.tasks?.map((task) => task.title)).toEqual(['Plan launch']);
    });

    it('keeps the sort control labeled and visually scannable', () => {
        const { getByRole, getByTestId } = renderContextsView();

        expect(getByRole('combobox', { name: 'Sort' })).toBeInTheDocument();
        expect(getByTestId('contexts-sort-icon')).toBeInTheDocument();
    });

    it('groups the task list by status and by tag from the Group control', () => {
        const tasks = [
            makeTask('grp-next', { title: 'Next task', tags: ['#ERP'] }),
            makeTask('grp-waiting', { title: 'Waiting task', status: 'waiting', tags: ['#ERP'] }),
            makeTask('grp-someday', { title: 'Someday task', status: 'someday', tags: ['#Finance'] }),
        ];
        useTaskStore.setState({ tasks, _allTasks: tasks });
        const { getByText, getAllByText } = renderContextsView();

        selectToolbarOption('Group', 'Status');

        // Status names also appear as filter chips, so assert on the group
        // header shape (a span next to the count) via duplicate presence.
        expect(getAllByText('Next').length).toBeGreaterThan(1);
        expect(getAllByText('Waiting').length).toBeGreaterThan(1);
        expect(getAllByText('Someday').length).toBeGreaterThan(1);
        expect(getByText('Next task')).toBeInTheDocument();
        expect(getByText('Waiting task')).toBeInTheDocument();

        selectToolbarOption('Group', 'Tags');

        expect(getAllByText('#ERP').length).toBeGreaterThan(0);
        expect(getAllByText('#Finance').length).toBeGreaterThan(0);
    });

    it('folds a context group and keeps it folded across a remount', () => {
        const tasks = [
            makeTask('grp-erp', { title: 'ERP task', tags: ['#ERP'] }),
            makeTask('grp-finance', { title: 'Finance task', tags: ['#Finance'] }),
        ];
        useTaskStore.setState({ tasks, _allTasks: tasks });
        const firstRender = renderContextsView();

        selectToolbarOption('Group', 'Tags', firstRender);

        const erpGroup = firstRender.getByRole('button', { name: /#ERP\s*1/i });
        expect(erpGroup).toHaveAttribute('aria-expanded', 'true');

        fireEvent.click(erpGroup);

        expect(firstRender.getByRole('button', { name: /#ERP\s*1/i })).toHaveAttribute('aria-expanded', 'false');
        expect(firstRender.queryByText('ERP task')).not.toBeInTheDocument();
        expect(firstRender.getByText('Finance task')).toBeInTheDocument();

        const persisted = JSON.parse(
            window.localStorage.getItem(CONTEXTS_GROUP_COLLAPSE_STORAGE_KEY) ?? '{}'
        ) as { collapsedGroups?: Record<string, string[]> };
        expect(persisted.collapsedGroups?.tag).toEqual(['tag:#ERP']);

        firstRender.unmount();
        const secondRender = renderContextsView();

        expect(secondRender.getByRole('button', { name: /#ERP\s*1/i })).toHaveAttribute('aria-expanded', 'false');
        expect(secondRender.queryByText('ERP task')).not.toBeInTheDocument();
    });

    it('leaves a folded group out of Select all', () => {
        const tasks = [
            makeTask('grp-erp', { title: 'ERP task', tags: ['#ERP'] }),
            makeTask('grp-finance', { title: 'Finance task', tags: ['#Finance'] }),
        ];
        useTaskStore.setState({ tasks, _allTasks: tasks });
        const view = renderContextsView();

        selectToolbarOption('Group', 'Tags', view);
        fireEvent.click(view.getByRole('button', { name: /#ERP\s*1/i }));
        fireEvent.click(view.getByRole('button', { name: 'Select' }));
        fireEvent.click(view.getByRole('button', { name: 'Select All' }));

        // The folded group renders no rows, so it contributes no tasks to act on.
        expect(view.getAllByRole('checkbox', { name: 'Select task' }).map((checkbox) => (
            (checkbox as HTMLInputElement).checked
        ))).toEqual([true]);
    });

    it('virtualizes a grouped context list instead of rendering every row', () => {
        const tasks = Array.from({ length: 200 }, (_, index) => makeTask(`bulk-${index}`, {
            title: `Bulk task ${index}`,
            tags: [index % 2 === 0 ? '#ERP' : '#Finance'],
        }));
        useTaskStore.setState({ tasks, _allTasks: tasks });
        const view = renderContextsView();

        selectToolbarOption('Group', 'Tags', view);

        expect(view.getByTestId('virtualized-task-list')).toHaveAttribute('data-grouped', 'true');
        expect(document.querySelectorAll('[data-task-id]').length).toBeLessThan(100);
    });

    it('hides done tasks from the default context filter while keeping the Done status available', () => {
        const tasks = [
            makeTask('active-office', {
                title: 'Active office task',
                contexts: ['@Office'],
            }),
            makeTask('done-office', {
                title: 'Done office task',
                status: 'done',
                contexts: ['@Office'],
            }),
        ];
        useTaskStore.setState({
            tasks,
            _allTasks: tasks,
            projects: [],
            areas: [],
            settings: {},
        });

        const { getAllByRole, getByRole, getByText, queryByText } = renderContextsView();

        expect(getByRole('button', { name: '@Office (1)' })).toBeInTheDocument();
        expect(getByText('Active office task')).toBeInTheDocument();
        expect(queryByText('Done office task')).not.toBeInTheDocument();

        const doneStatusButton = getAllByRole('button', { name: 'Done' }).find(
            (button) => button.getAttribute('aria-pressed') === 'false'
        );
        expect(doneStatusButton).toBeTruthy();

        fireEvent.click(doneStatusButton!);

        expect(getByText('Done office task')).toBeInTheDocument();
        expect(queryByText('Active office task')).not.toBeInTheDocument();
    });

    it('allows multiple status filters while keeping Done hidden until selected', () => {
        const tasks = [
            makeTask('next-office', {
                title: 'Next office task',
                status: 'next',
                contexts: ['@Office'],
            }),
            makeTask('waiting-office', {
                title: 'Waiting office task',
                status: 'waiting',
                contexts: ['@Office'],
            }),
            makeTask('done-office', {
                title: 'Done office task',
                status: 'done',
                contexts: ['@Office'],
            }),
        ];
        useTaskStore.setState({
            tasks,
            _allTasks: tasks,
            projects: [],
            areas: [],
            settings: {},
        });

        const { getAllByRole, getByText, queryByText } = renderContextsView();
        const statusButton = (label: string) => {
            const button = getAllByRole('button', { name: label }).find((item) => item.hasAttribute('aria-pressed'));
            expect(button).toBeTruthy();
            return button!;
        };

        expect(getByText('Next office task')).toBeInTheDocument();
        expect(getByText('Waiting office task')).toBeInTheDocument();
        expect(queryByText('Done office task')).not.toBeInTheDocument();

        const nextButton = statusButton('Next');
        fireEvent.click(nextButton);

        expect(nextButton).toHaveAttribute('aria-pressed', 'true');
        expect(nextButton).toHaveClass('bg-primary', 'text-primary-foreground');
        expect(getByText('Next office task')).toBeInTheDocument();
        expect(queryByText('Waiting office task')).not.toBeInTheDocument();
        expect(queryByText('Done office task')).not.toBeInTheDocument();

        fireEvent.click(statusButton('Waiting'));

        expect(getByText('Next office task')).toBeInTheDocument();
        expect(getByText('Waiting office task')).toBeInTheDocument();
        expect(queryByText('Done office task')).not.toBeInTheDocument();

        fireEvent.click(statusButton('Done'));

        expect(getByText('Next office task')).toBeInTheDocument();
        expect(getByText('Waiting office task')).toBeInTheDocument();
        expect(getByText('Done office task')).toBeInTheDocument();
    });

    it('sorts context tasks with the shared task sort preference', () => {
        const tasks = [
            makeTask('task-b', {
                title: 'Write brief',
                contexts: ['@Office'],
            }),
            makeTask('task-a', {
                title: 'Archive notes',
                contexts: ['@Office'],
            }),
            makeTask('task-c', {
                title: 'Plan launch',
                contexts: ['@Office'],
            }),
        ];
        useTaskStore.setState({
            tasks,
            _allTasks: tasks,
            projects: [],
            areas: [],
            settings: {},
        });

        const { container } = renderContextsView();

        selectToolbarOption('Sort', 'Title');

        const text = container.textContent ?? '';
        expect(text.indexOf('Archive notes')).toBeLessThan(text.indexOf('Plan launch'));
        expect(text.indexOf('Plan launch')).toBeLessThan(text.indexOf('Write brief'));
    });

    it('applies task token navigation while the context view is mounted', () => {
        const { getByRole, getByText } = renderContextsView();

        act(() => {
            dispatchContextsTokenSelection('#ERP');
        });

        expect(getByRole('heading', { name: '#ERP' })).toBeInTheDocument();
        expect(getByText('Plan launch')).toBeInTheDocument();
        expect(window.localStorage.getItem(CONTEXTS_VIEW_STATE_STORAGE_KEY)).toContain('"selectedContext":"#ERP"');
    });

    it('selects and clears all visible tasks in context selection mode', () => {
        const { getAllByRole, getByRole } = renderContextsView();

        fireEvent.click(getByRole('button', { name: 'Select' }));

        expect(getByRole('button', { name: 'Select All' })).toBeEnabled();
        expect(getByRole('button', { name: 'Clear' })).toBeDisabled();

        fireEvent.click(getByRole('button', { name: 'Select All' }));

        expect(getAllByRole('checkbox', { name: 'Select task' }).map((checkbox) => (
            (checkbox as HTMLInputElement).checked
        ))).toEqual([true, true]);
        expect(getByRole('button', { name: 'Select All' })).toBeDisabled();
        expect(getByRole('button', { name: 'Clear' })).toBeEnabled();

        fireEvent.click(getByRole('button', { name: 'Clear' }));

        expect(getAllByRole('checkbox', { name: 'Select task' }).map((checkbox) => (
            (checkbox as HTMLInputElement).checked
        ))).toEqual([false, false]);
    });

    it('selects all only within the current context search results', () => {
        const { getAllByRole, getByPlaceholderText, getByRole, getByText, queryByText } = renderContextsView();

        fireEvent.change(getByPlaceholderText('Search...'), {
            target: { value: 'Plan' },
        });
        expect(getByText('Plan launch')).toBeInTheDocument();
        expect(queryByText('Write brief')).not.toBeInTheDocument();

        fireEvent.click(getByRole('button', { name: 'Select' }));
        fireEvent.click(getByRole('button', { name: 'Select All' }));

        expect(getAllByRole('checkbox', { name: 'Select task' }).map((checkbox) => (
            (checkbox as HTMLInputElement).checked
        ))).toEqual([true]);
    });
});
