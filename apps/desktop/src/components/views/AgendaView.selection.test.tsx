import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import { useTaskStore, type Project, type Task } from '@mindwtr/core';
import { LanguageProvider } from '../../contexts/language-context';
import { KeybindingProvider } from '../../contexts/keybinding-context';
import { useUiStore } from '../../store/ui-store';
import { selectToolbarOption } from '../../test/toolbar-select';
import { AgendaView } from './AgendaView';

const initialTaskState = useTaskStore.getState();
const initialUiState = useUiStore.getState();
const nowIso = '2026-11-10T12:00:00.000Z';
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
const setTasks = (tasks: Task[]) => useTaskStore.setState({ tasks, _allTasks: tasks });
const renderAgenda = () => render(
    <StrictMode>
        <LanguageProvider>
            <KeybindingProvider currentView="agenda" onNavigate={() => undefined}>
                <AgendaView />
            </KeybindingProvider>
        </LanguageProvider>
    </StrictMode>,
);

describe('Focus bulk selection', () => {
    beforeEach(() => {
        vi.useFakeTimers({ now: new Date(nowIso), toFake: ['Date'] });
        window.localStorage.removeItem('mindwtr:view:focus:v1');
        useTaskStore.setState(initialTaskState, true);
        useUiStore.setState(initialUiState, true);
        useTaskStore.setState({
            tasks: [], _allTasks: [], projects: [], _allProjects: [],
            sections: [], _allSections: [], areas: [], _allAreas: [], settings: { language: 'en', keybindingStyle: 'standard' },
            error: null, highlightTaskId: null,
        });
    });
    afterEach(() => { vi.useRealTimers(); });

    it('selects only filtered rows and clears hidden selections when the filter changes', async () => {
        setTasks([makeTask('one', { title: 'Match one' }), makeTask('two', { title: 'Match two' }), makeTask('hidden')]);
        const view = renderAgenda();
        expect(view.queryByRole('button', { name: 'Select All' })).not.toBeInTheDocument();
        fireEvent.click(view.getByRole('button', { name: 'Filters' }));
        fireEvent.change(view.getByRole('searchbox', { name: 'Search task titles' }), { target: { value: 'Match' } });
        fireEvent.click(view.getByRole('button', { name: 'Select' }));
        fireEvent.click(view.getByRole('button', { name: 'Select All' }));
        expect(view.getByText('2 selected - 2 tasks')).toBeInTheDocument();
        expect(view.getByRole('button', { name: 'Select All' })).toBeDisabled();
        fireEvent.change(view.getByRole('searchbox', { name: 'Search task titles' }), { target: { value: 'Match one' } });
        await waitFor(() => expect(view.getByText('1 selected - 1 tasks')).toBeInTheDocument());
        fireEvent.change(view.getByRole('combobox', { name: 'Move to' }), { target: { value: 'someday' } });
        await waitFor(() => expect(useTaskStore.getState()._tasksById.get('one')?.status).toBe('someday'));
        expect(useTaskStore.getState()._tasksById.get('two')?.status).toBe('next');
        expect(useTaskStore.getState()._tasksById.get('hidden')?.status).toBe('next');
    });

    it('deduplicates grouped task IDs and excludes collapsed groups', () => {
        setTasks([makeTask('both', { contexts: ['@work', '@home'] }), makeTask('hidden', { contexts: ['@closed'] })]);
        const view = renderAgenda();
        selectToolbarOption('Group', 'Context', view);
        expect(view.getAllByText('Task both')).toHaveLength(2);
        fireEvent.click(view.getByRole('button', { name: /@closed\s*1/i }));
        fireEvent.click(view.getByRole('button', { name: 'Select' }));
        fireEvent.click(view.getByRole('button', { name: 'Select All' }));
        expect(view.getByText('1 selected - 1 tasks')).toBeInTheDocument();
        expect(view.getAllByRole('checkbox', { name: 'Select task' }).every((checkbox) => checkbox instanceof HTMLInputElement && checkbox.checked)).toBe(true);
        expect(view.getByRole('button', { name: 'Select All' })).toBeDisabled();
        fireEvent.click(view.getByRole('button', { name: /@work\s*1/i }));
        expect(view.getByText('1 selected - 1 tasks')).toBeInTheDocument();
        fireEvent.click(view.getByRole('button', { name: /@home\s*1/i }));
        expect(view.getByText('0 selected - 0 tasks')).toBeInTheDocument();
    });

    it('excludes folded sections and project review cards while keeping current recurring task IDs', () => {
        const project = makeProject('review', { reviewAt: '2026-11-09' });
        const tasks = [
            makeTask('focused', { isFocusedToday: true }),
            makeTask('scheduled', { dueDate: '2026-11-10' }),
            makeTask('review', { status: 'waiting', reviewAt: '2026-11-09' }),
            makeTask('recurring', { recurrence: { rule: 'daily' } }),
            makeTask('upcoming', { startTime: '2026-11-12' }),
        ];
        setTasks(tasks);
        useTaskStore.setState({ projects: [project], _allProjects: [project] });
        const view = renderAgenda();
        fireEvent.click(view.getByRole('button', { name: /Today's Focus/ }));
        fireEvent.click(view.getByRole('button', { name: /^Today\(1\)$/ }));
        fireEvent.click(view.getByRole('button', { name: /^Upcoming\(1\)$/ }));
        fireEvent.click(view.getByRole('button', { name: 'Select' }));
        fireEvent.click(view.getByRole('button', { name: 'Select All' }));
        expect(view.getByText('2 selected - 2 tasks')).toBeInTheDocument();
        expect(view.getAllByRole('checkbox')).toHaveLength(2);
        expect(view.getByRole('button', { name: 'Open Project review' })).toBeInTheDocument();
        expect(view.container.querySelectorAll('[data-task-id="recurring"]')).toHaveLength(1);
    });

    it('applies a selected status to the current sequential action without selecting its successor', async () => {
        const project = makeProject('sequence', { isSequential: true });
        setTasks([makeTask('first', { projectId: project.id, orderNum: 0 }), makeTask('second', { projectId: project.id, orderNum: 1 })]);
        useTaskStore.setState({ projects: [project], _allProjects: [project] });
        const view = renderAgenda();
        expect(view.queryByText('Task second')).not.toBeInTheDocument();
        fireEvent.click(view.getByRole('button', { name: 'Select' }));
        fireEvent.click(view.getByRole('button', { name: 'Select All' }));
        fireEvent.change(view.getByRole('combobox', { name: 'Move to' }), { target: { value: 'done' } });
        await waitFor(() => expect(view.getByText('Task second')).toBeInTheDocument());
        expect(useTaskStore.getState()._tasksById.get('first')?.status).toBe('done');
        expect(useTaskStore.getState()._tasksById.get('second')?.status).toBe('next');
        expect(view.queryByRole('checkbox')).not.toBeInTheDocument();
    });

    it('keeps selected tasks when bulk deletion is canceled', () => {
        setTasks([makeTask('one')]);
        const view = renderAgenda();
        fireEvent.click(view.getByRole('button', { name: 'Select' }));
        fireEvent.click(view.getByRole('button', { name: 'Select All' }));
        fireEvent.click(view.getByRole('button', { name: 'Delete' }));
        fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
        expect(view.getByRole('checkbox')).toBeChecked();
        expect(useTaskStore.getState()._tasksById.get('one')?.deletedAt).toBeUndefined();
    });

    it('keeps selection when organizing is canceled and discards canceled form values', () => {
        setTasks([makeTask('one')]);
        const view = renderAgenda();
        fireEvent.click(view.getByRole('button', { name: 'Select' }));
        fireEvent.click(view.getByRole('button', { name: 'Select All' }));
        fireEvent.click(view.getByRole('button', { name: 'Bulk organize' }));
        fireEvent.change(view.getByRole('combobox', { name: 'Tags' }), { target: { value: '#discarded' } });
        fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
        expect(view.getByRole('checkbox')).toBeChecked();
        expect(useTaskStore.getState()._tasksById.get('one')?.tags).toEqual([]);
        fireEvent.click(view.getByRole('button', { name: 'Bulk organize' }));
        expect(view.getByRole('combobox', { name: 'Tags' })).toHaveValue('');
    });

    it.each(['returned', 'rejected'] as const)('retains the organizer, fields and selection after a %s action failure', async (failure) => {
        setTasks([makeTask('one')]);
        const write = vi.fn(async () => {
            if (failure === 'rejected') throw new Error('Failed save');
            return { success: false, error: 'Failed save' };
        });
        useTaskStore.setState({ batchUpdateTasks: write });
        const view = renderAgenda();
        fireEvent.click(view.getByRole('button', { name: 'Select' }));
        fireEvent.click(view.getByRole('button', { name: 'Select All' }));
        fireEvent.click(view.getByRole('button', { name: 'Bulk organize' }));
        fireEvent.change(view.getByRole('combobox', { name: 'Tags' }), { target: { value: '#retained' } });
        await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Apply to selected' })); });
        expect(write).toHaveBeenCalledWith([{ id: 'one', updates: { tags: ['#retained'] } }]);
        expect(view.getByRole('dialog', { name: 'Bulk organize' })).toBeInTheDocument();
        expect(view.getByRole('combobox', { name: 'Tags' })).toHaveValue('#retained');
        expect(view.getByRole('checkbox')).toBeChecked();
        const toasts = useUiStore.getState().toasts;
        expect(toasts[toasts.length - 1]).toMatchObject({ tone: 'error' });
        expect(toasts.some((toast) => toast.tone === 'success')).toBe(false);
    });

    it('supports modifier and range clicks plus keyboard selection and removes drag and quick actions', () => {
        setTasks([makeTask('one', { isFocusedToday: true, focusOrder: 0 }), makeTask('two', { isFocusedToday: true, focusOrder: 1 }), makeTask('three', { isFocusedToday: true, focusOrder: 2 })]);
        const view = renderAgenda();
        expect(view.getAllByRole('button', { name: 'Reorder' })).toHaveLength(3);
        const first = view.container.querySelector<HTMLElement>('[data-task-id="one"]');
        if (!first) throw new Error('First task row missing');
        fireEvent.click(first, { detail: 1, ctrlKey: true });
        expect(view.container.querySelector('[data-task-id="one"] [data-task-selection-checkbox]')).toBeChecked();
        const thirdCheckbox = view.container.querySelector('[data-task-id="three"] [data-task-selection-checkbox]');
        if (!thirdCheckbox) throw new Error('Third task checkbox missing');
        fireEvent.click(thirdCheckbox, { shiftKey: true });
        expect(view.getByText('3 selected - 3 tasks')).toBeInTheDocument();
        expect(view.queryByRole('button', { name: 'Reorder' })).not.toBeInTheDocument();
        expect(view.queryByRole('button', { name: "Remove from today's focus" })).not.toBeInTheDocument();
        const selectedRow = view.container.querySelector<HTMLElement>('[data-task-id="two"]');
        if (!selectedRow) throw new Error('Second task row missing');
        fireEvent.contextMenu(selectedRow);
        expect(view.queryByRole('menu')).not.toBeInTheDocument();
        within(selectedRow).getByRole('button', { name: 'Toggle task details: Task two' }).focus();
        fireEvent.keyDown(window, { key: 'x' });
        expect(view.getByText('2 selected - 3 tasks')).toBeInTheDocument();
        fireEvent.click(view.getByRole('button', { name: 'Done' }));
        expect(view.queryByRole('checkbox')).not.toBeInTheDocument();
        expect(view.getAllByRole('button', { name: 'Reorder' })).toHaveLength(3);
    });
});
