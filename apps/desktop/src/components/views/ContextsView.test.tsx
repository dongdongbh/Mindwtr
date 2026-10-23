import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { Area, Project, Task } from '@mindwtr/core';
import { safeFormatDate, useTaskStore } from '@mindwtr/core';
import * as core from '@mindwtr/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../../contexts/language-context';
import { ContextsView } from './ContextsView';
import { CONTEXTS_VIEW_STATE_STORAGE_KEY, dispatchContextsTokenSelection } from '../../lib/contexts-view-state';
import { openToolbarSelect, selectToolbarOption } from '../../test/toolbar-select';
import { expectScrolledEndGap } from '../../test/list-end-gap';
import * as dataTransfer from '../../lib/data-transfer';
import { useUiStore } from '../../store/ui-store';
import { CALENDAR_TASK_DRAG_MIME, setCalendarTaskDragData } from '../../lib/calendar-task-drag';
import { clearUndoableAction, takeUndoableAction } from '../../lib/undo-registry';
import { holdSyncSave } from '../../test/hold-sync-save';

// Its own key, separate from the view state above: see the note in ContextsView.
const CONTEXTS_GROUP_COLLAPSE_STORAGE_KEY = 'mindwtr:view:contexts:groups:v1';

const initialTaskState = useTaskStore.getState();
const initialShowToast = useUiStore.getState().showToast;
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
        vi.restoreAllMocks();
        clearUndoableAction();
        window.localStorage.clear();
        useTaskStore.setState(initialTaskState, true);
        useUiStore.setState((state) => ({
            ...state,
            showToast: initialShowToast,
            expandedTaskIds: {},
            listOptions: { ...state.listOptions, showDetails: false },
        }));
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

    const taskDrag = (id: string) => {
        const values: Record<string, string> = {};
        const transfer = {
            types: [] as string[],
            effectAllowed: 'none' as DataTransfer['effectAllowed'],
            dropEffect: 'none' as DataTransfer['dropEffect'],
            getData: (type: string) => values[type] ?? '',
            setData: (type: string, value: string) => {
                values[type] = value;
                transfer.types.push(type);
            },
        };
        setCalendarTaskDragData(transfer, id);
        return transfer;
    };
    const mockContextWrite = () => {
        const updateTask = vi.fn(async (id: string, updates: Partial<Task>) => {
            const tasks = useTaskStore.getState()._allTasks.map((task) => task.id === id ? { ...task, ...updates } : task);
            useTaskStore.setState({ _allTasks: tasks });
            return { success: true };
        });
        useTaskStore.setState({ updateTask });
        return updateTask;
    };

    it('adds and undoes a dropped context on the contexts a sync save published while each write waited', async () => {
        vi.spyOn(core, 'flushPendingSave').mockResolvedValue(undefined);
        const toast = vi.spyOn(useUiStore.getState(), 'showToast');
        const view = renderContextsView();
        const target = view.getByRole('button', { name: '@Office (1)' });
        const transfer = taskDrag('task-2');
        const publishContexts = (contexts: string[]) => holdSyncSave(() => useTaskStore.setState({
            _allTasks: useTaskStore.getState()._allTasks.map((task) => task.id === 'task-2' ? { ...task, contexts } : task),
        }));

        let finish = publishContexts(['@Home', '@Phone']);
        fireEvent.dragOver(target, { dataTransfer: transfer });
        await act(async () => { fireEvent.drop(target, { dataTransfer: transfer }); });
        await act(finish);
        await vi.waitFor(() => expect(useTaskStore.getState()._tasksById.get('task-2')?.contexts).toEqual(['@Home', '@Phone', '@Office']));

        await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('Added @Office', 'info', 5000, expect.objectContaining({ label: 'Undo' })));
        const undo = toast.mock.calls[0]![3]!.onClick;
        finish = publishContexts(['@Home', '@Phone', '@Office', '@Later']);
        await act(async () => { undo(); });
        await act(finish);
        await vi.waitFor(() => expect(useTaskStore.getState()._tasksById.get('task-2')?.contexts).toEqual(['@Home', '@Phone', '@Later']));
    });

    it('adds the dropped context only after a durable save and undoes only that addition', async () => {
        const updateTask = mockContextWrite();
        let finishSave!: () => void;
        const save = vi.spyOn(core, 'flushPendingSave').mockImplementationOnce(() => new Promise<void>((resolve) => {
            finishSave = resolve;
        })).mockResolvedValue(undefined);
        const toast = vi.spyOn(useUiStore.getState(), 'showToast');
        const view = renderContextsView();
        const target = view.getByRole('button', { name: '@Office (1)' });
        const transfer = taskDrag('task-2');
        fireEvent.dragOver(target, { dataTransfer: transfer });
        expect(target).toHaveClass('ring-2');
        expect(view.getByText('Add @Office')).toBeInTheDocument();
        const childLeave = new Event('dragleave', { bubbles: true });
        Object.defineProperty(childLeave, 'relatedTarget', { value: target.querySelector('span') });
        fireEvent(target, childLeave);
        expect(target).toHaveClass('ring-2');
        fireEvent.dragEnd(window);
        expect(target).not.toHaveClass('ring-2');
        fireEvent.dragOver(target, { dataTransfer: transfer });
        await act(async () => { fireEvent.drop(target, { dataTransfer: transfer }); });
        expect(updateTask).toHaveBeenCalledWith('task-2', { contexts: ['@Home', '@Office'] });
        expect(toast).not.toHaveBeenCalled();
        expect(takeUndoableAction()).toBeNull();
        await act(async () => { finishSave(); });
        expect(toast).toHaveBeenCalledWith('Added @Office', 'info', 5000, expect.objectContaining({ label: 'Undo' }));
        const undo = toast.mock.calls[0]![3]!.onClick;
        const latest = useTaskStore.getState()._allTasks.map((task) => task.id === 'task-2'
            ? { ...task, title: 'Edited after drop', contexts: [...task.contexts, '@Later'], tags: ['#New'], projectId: 'later-project', status: 'waiting' as const, order: 17 }
            : task);
        act(() => useTaskStore.setState({ _allTasks: latest }));
        await act(async () => { undo(); });
        expect(useTaskStore.getState()._tasksById.get('task-2')).toMatchObject({
            title: 'Edited after drop', contexts: ['@Home', '@Later'], tags: ['#New'], projectId: 'later-project', status: 'waiting', order: 17,
        });
        expect(save).toHaveBeenCalledTimes(2);
        await act(async () => { undo(); });
        expect(updateTask).toHaveBeenCalledTimes(2);
    });

    it('ignores existing normalized membership, tags, foreign, malformed, missing, and deleted drags', async () => {
        const updateTask = mockContextWrite();
        const save = vi.spyOn(core, 'flushPendingSave').mockResolvedValue(undefined);
        const tasks = useTaskStore.getState()._allTasks.map((task) => task.id === 'task-2' ? { ...task, contexts: ['Office'] } : task);
        const deleted = makeTask('deleted', { deletedAt: now, contexts: ['@Home'] });
        useTaskStore.setState({ _allTasks: [...tasks, deleted] });
        const view = renderContextsView();
        const target = view.getByRole('button', { name: '@Office (1)' });
        const textOnly = { types: ['text/plain'], getData: () => 'mindwtr-task:task-2' };
        const malformed = { types: [CALENDAR_TASK_DRAG_MIME], getData: () => ' ' };
        await act(async () => {
            for (const transfer of [taskDrag('task-2'), textOnly, malformed, taskDrag('missing'), taskDrag('deleted')]) {
                fireEvent.drop(target, { dataTransfer: transfer });
            }
            fireEvent.drop(view.getByRole('button', { name: '#ERP (1)' }), { dataTransfer: taskDrag('task-2') });
            fireEvent.drop(view.getByRole('button', { name: /No context/ }), { dataTransfer: taskDrag('task-1') });
        });
        expect(updateTask).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
        fireEvent.dragOver(target, { dataTransfer: taskDrag('task-2') });
        expect(target).not.toHaveClass('ring-2');
        expect(takeUndoableAction()).toBeNull();
    });

    it('guards overlapping drops and keeps keyboard undo when undo notifications are disabled', async () => {
        const updateTask = mockContextWrite();
        let finishSave!: () => void;
        vi.spyOn(core, 'flushPendingSave').mockImplementationOnce(() => new Promise<void>((resolve) => {
            finishSave = resolve;
        })).mockResolvedValue(undefined);
        useTaskStore.setState({ settings: { undoNotificationsEnabled: false } });
        const toast = vi.spyOn(useUiStore.getState(), 'showToast');
        const view = renderContextsView();
        const target = view.getByRole('button', { name: '@Office (1)' });
        await act(async () => {
            fireEvent.drop(target, { dataTransfer: taskDrag('task-2') });
            fireEvent.drop(target, { dataTransfer: taskDrag('task-2') });
        });
        expect(updateTask).toHaveBeenCalledTimes(1);
        await act(async () => { finishSave(); });
        expect(toast).toHaveBeenCalledWith('Added @Office', 'success');
        const undo = takeUndoableAction();
        expect(undo).not.toBeNull();
        await act(async () => { undo!(); });
        expect(useTaskStore.getState()._tasksById.get('task-2')?.contexts).toEqual(['@Home']);
    });

    it('shows save and undo failures without reporting success for failed saves', async () => {
        const updateTask = mockContextWrite();
        const save = vi.spyOn(core, 'flushPendingSave').mockRejectedValueOnce(new Error('disk full'));
        const toast = vi.spyOn(useUiStore.getState(), 'showToast');
        const view = renderContextsView();
        await act(async () => { fireEvent.drop(view.getByRole('button', { name: '@Office (1)' }), { dataTransfer: taskDrag('task-2') }); });
        expect(toast).toHaveBeenCalledWith('Could not save the context assignment.', 'error');
        expect(takeUndoableAction()).toBeNull();
        const tasks = useTaskStore.getState()._allTasks.map((task) => task.id === 'task-2' ? { ...task, contexts: ['@Home'] } : task);
        act(() => useTaskStore.setState({ _allTasks: tasks }));
        save.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('undo disk full'));
        await act(async () => { fireEvent.drop(view.getByRole('button', { name: '@Office (1)' }), { dataTransfer: taskDrag('task-2') }); });
        await act(async () => { takeUndoableAction()!(); });
        expect(toast).toHaveBeenLastCalledWith('Could not undo the context assignment.', 'error');
        expect(updateTask).toHaveBeenCalledTimes(3);
        expect(save).toHaveBeenCalledTimes(3);
    });

    it.each(['deleted', 'removed'])('does not undo a task/context %s after the drop or later re-addition', async (change) => {
        const updateTask = mockContextWrite();
        vi.spyOn(core, 'flushPendingSave').mockResolvedValue(undefined);
        const view = renderContextsView();
        await act(async () => { fireEvent.drop(view.getByRole('button', { name: '@Office (1)' }), { dataTransfer: taskDrag('task-2') }); });
        const undo = takeUndoableAction()!;
        let tasks = useTaskStore.getState()._allTasks.map((task) => task.id === 'task-2'
            ? { ...task, ...(change === 'deleted' ? { deletedAt: now } : { contexts: ['@Home'] }) }
            : task);
        act(() => useTaskStore.setState({ _allTasks: tasks }));
        await act(async () => { undo(); });
        tasks = tasks.map((task) => task.id === 'task-2' ? { ...task, contexts: ['@Home', '@Office'], deletedAt: undefined } : task);
        act(() => useTaskStore.setState({ _allTasks: tasks }));
        await act(async () => { undo(); });
        expect(updateTask).toHaveBeenCalledTimes(1);
        expect(useTaskStore.getState()._tasksById.get('task-2')?.contexts).toEqual(['@Home', '@Office']);
    });

    it('shows a rejected store write without saving or registering undo', async () => {
        const updateTask = vi.fn(async () => ({ success: false, error: 'Rejected' }));
        useTaskStore.setState({ updateTask });
        const save = vi.spyOn(core, 'flushPendingSave').mockResolvedValue(undefined);
        const toast = vi.spyOn(useUiStore.getState(), 'showToast');
        const view = renderContextsView();
        await act(async () => { fireEvent.drop(view.getByRole('button', { name: '@Office (1)' }), { dataTransfer: taskDrag('task-2') }); });
        expect(toast).toHaveBeenCalledWith('Could not save the context assignment.', 'error');
        expect(save).not.toHaveBeenCalled();
        expect(takeUndoableAction()).toBeNull();
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
    });

    // #1428: a nested row after its parent row shows only "/leaf", indented; its name stays the full token.
    it('shows nested contexts and tags under their parent with a short label', () => {
        const tasks = [
            makeTask('emma', { title: 'Emma', contexts: ['@person/emma'] }),
            makeTask('todd', { title: 'Todd', contexts: ['@person/todd'] }),
            makeTask('bank', { title: 'Bank', contexts: ['@place/bank'], tags: ['#errand/post'] }),
        ];
        useTaskStore.setState({ tasks, _allTasks: tasks });
        const view = renderContextsView();
        const row = (name: string) => {
            const button = view.getByRole('button', { name });
            const label = button.querySelectorAll('span')[1] as HTMLElement;
            return [label.textContent, label.style.paddingLeft, button.getAttribute('title')];
        };
        expect(row('@person (2)')).toEqual(['person', '', null]);
        expect(row('@person/emma (1)')).toEqual(['/emma', '0.75rem', '@person/emma']);
        expect(row('@person/todd (1)')).toEqual(['/todd', '0.75rem', '@person/todd']);
        expect(row('@place/bank (1)')).toEqual(['/bank', '0.75rem', '@place/bank']);
        expect(row('#errand (1)')).toEqual(['errand', '', null]);
        expect(row('#errand/post (1)')).toEqual(['/post', '0.75rem', '#errand/post']);
        fireEvent.click(view.getByRole('button', { name: '@person/todd (1)' }));
        expect(view.getByRole('heading', { name: '@person/todd' })).toBeInTheDocument();
        expect(view.getByText('Todd')).toBeInTheDocument();
        expect(view.queryByText('Emma')).not.toBeInTheDocument();
    });

    it('offers parent filters and keeps a selected parent with zero matches', () => {
        const tasks = [
            makeTask('excavator', { title: 'Excavator', contexts: ['@tools/excavator'] }),
            makeTask('chainsaw', { title: 'Chainsaw', contexts: ['@tools/chainsaw'] }),
            makeTask('home', { title: 'Home', contexts: ['@home'] }),
        ];
        useTaskStore.setState({ tasks, _allTasks: tasks });
        const view = renderContextsView();
        fireEvent.click(view.getByRole('button', { name: '@tools (2)' }));
        expect(view.getByText('Excavator')).toBeInTheDocument();
        expect(view.getByText('Chainsaw')).toBeInTheDocument();
        const completed = tasks.map((entry) => entry.id === 'excavator' ? { ...entry, status: 'done' as const } : entry);
        act(() => useTaskStore.setState({ tasks: completed, _allTasks: completed }));
        expect(view.getByRole('button', { name: '@tools (1)' })).toHaveAttribute('aria-pressed', 'true');
        expect(view.queryByText('Excavator')).not.toBeInTheDocument();
        expect(view.getByText('Chainsaw')).toBeInTheDocument();
        const empty = completed.map((entry) => entry.id === 'chainsaw' ? { ...entry, status: 'done' as const } : entry);
        act(() => useTaskStore.setState({ tasks: empty, _allTasks: empty }));
        expect(view.getByRole('button', { name: '@tools (0)' })).toHaveAttribute('aria-pressed', 'true');
        expect(view.queryByRole('button', { name: '@tools/chainsaw (0)' })).not.toBeInTheDocument();
        expect(view.queryByText('Home')).not.toBeInTheDocument();
        expect(view.getByRole('button', { name: 'Remove filter @tools' })).toBeInTheDocument();
        fireEvent.click(view.getByRole('button', { name: 'Remove filter @tools' }));
        expect(view.getByText('Home')).toBeInTheDocument();
    });

    it('keeps imported raw labels in their original context and tag sections', () => {
        const tasks = [
            makeTask('raw-context', { title: 'Office task', contexts: ['office/deep'] }),
            makeTask('raw-tag', { title: 'Work task', tags: ['work/blue'] }),
        ];
        useTaskStore.setState({ tasks, _allTasks: tasks });
        const view = renderContextsView();
        expect(view.getByRole('button', { name: 'Contexts (2)' })).toBeInTheDocument();
        expect(view.getByRole('button', { name: 'Tags (2)' })).toBeInTheDocument();
        fireEvent.click(view.getByRole('button', { name: 'office (1)' }));
        expect(view.getByText('Office task')).toBeInTheDocument();
        expect(view.queryByText('Work task')).not.toBeInTheDocument();
        fireEvent.click(view.getByRole('button', { name: 'work (1)' }));
        expect(view.queryByText('Office task')).not.toBeInTheDocument();
    });

    // #1427: a plain click switches to the token; Ctrl/Cmd-click or Ctrl/Cmd+Enter adds it.
    it('switches token on click and combines on Ctrl/Cmd-click or Ctrl/Cmd+Enter', () => {
        const tasks = [
            makeTask('alice', { title: 'Alice only', contexts: ['@alice'] }),
            makeTask('bob', { title: 'Bob only', contexts: ['@bob'] }),
            makeTask('both', { title: 'Alice and Bob', contexts: ['@alice', '@bob'] }),
            makeTask('none', { title: 'Untagged' }),
        ];
        useTaskStore.setState({ tasks, _allTasks: tasks });
        const view = renderContextsView();
        const alice = () => view.getByRole('button', { name: '@alice (2)' });
        const bob = () => view.getByRole('button', { name: '@bob (2)' });
        const none = () => view.getByRole('button', { name: /No context/ });
        fireEvent.click(alice());
        fireEvent.click(bob());
        expect(alice()).toHaveAttribute('aria-pressed', 'false');
        expect(view.getByRole('heading', { name: '@bob' })).toBeInTheDocument();
        expect(view.getByText('Bob only')).toBeInTheDocument();
        expect(view.queryByText('Alice only')).not.toBeInTheDocument();
        fireEvent.click(bob());
        expect(view.getByText('Alice only')).toBeInTheDocument();
        expect(view.getByText('Bob only')).toBeInTheDocument();

        fireEvent.click(alice());
        fireEvent.click(bob(), { metaKey: true });
        expect(view.getByRole('heading', { name: '@alice + @bob' })).toBeInTheDocument();
        fireEvent.click(bob(), { ctrlKey: true });
        expect(view.getByRole('heading', { name: '@alice' })).toBeInTheDocument();
        fireEvent.keyDown(bob(), { key: 'Enter', ctrlKey: true });
        expect(view.getByRole('heading', { name: '@alice + @bob' })).toBeInTheDocument();
        fireEvent.click(alice());
        expect(view.getByRole('heading', { name: '@alice' })).toBeInTheDocument();

        fireEvent.click(none());
        expect(view.getByText('Untagged')).toBeInTheDocument();
        expect(view.queryByText('Alice only')).not.toBeInTheDocument();
        fireEvent.click(alice());
        expect(view.getByRole('heading', { name: '@alice' })).toBeInTheDocument();
        fireEvent.click(none());
        fireEvent.click(none());
        expect(view.getByText('Alice only')).toBeInTheDocument();
        expect(view.getByText('Bob only')).toBeInTheDocument();
    });

    it('combines context and tag tokens with All or Any without duplicate rows', () => {
        const tasks = [
            makeTask('alice', { title: 'Alice only', contexts: ['@alice'] }),
            makeTask('bob', { title: 'Bob only', tags: ['#bob'] }),
            makeTask('both', { title: 'Alice and Bob', contexts: ['@alice'], tags: ['#bob'] }),
            makeTask('other', { title: 'Other', contexts: ['@other'] }),
            makeTask('none', { title: 'Untagged' }),
        ];
        useTaskStore.setState({ tasks, _allTasks: tasks });
        const view = renderContextsView();
        fireEvent.click(view.getByRole('button', { name: '@alice (2)' }));
        expect(view.queryByRole('button', { name: 'Any' })).not.toBeInTheDocument();
        fireEvent.click(view.getByRole('button', { name: '#bob (2)' }), { ctrlKey: true });

        expect(view.getByRole('button', { name: '@alice (2)' })).toHaveAttribute('aria-pressed', 'true');
        expect(view.getByRole('button', { name: '#bob (2)' })).toHaveAttribute('aria-pressed', 'true');
        expect(view.getByText('Alice and Bob')).toBeInTheDocument();
        expect(view.queryByText('Alice only')).not.toBeInTheDocument();
        expect(view.queryByText('Bob only')).not.toBeInTheDocument();
        expect(view.queryByText('Other')).not.toBeInTheDocument();
        expect(view.getAllByRole('button', { name: 'All' }).find((button) => button.hasAttribute('aria-pressed')))
            .toHaveAttribute('aria-pressed', 'true');

        fireEvent.click(view.getByRole('button', { name: 'Any' }));
        expect(view.getByRole('heading', { name: '@alice / #bob' })).toBeInTheDocument();
        expect(view.getByText('Alice only')).toBeInTheDocument();
        expect(view.getByText('Bob only')).toBeInTheDocument();
        expect(view.getByText('Alice and Bob')).toBeInTheDocument();
        expect(view.container.querySelectorAll('[data-task-id="both"]')).toHaveLength(1);
        expect(view.queryByText('Other')).not.toBeInTheDocument();

        fireEvent.click(view.getByRole('button', { name: /No context/ }));
        expect(view.getByText('Untagged')).toBeInTheDocument();
        expect(view.queryByRole('button', { name: 'Any' })).not.toBeInTheDocument();
    });

    it('migrates the old single persisted token and adds tokens from the compact selector', () => {
        window.localStorage.setItem(CONTEXTS_VIEW_STATE_STORAGE_KEY,
            JSON.stringify({ selectedContext: '@Office', statusFilters: [], groupBy: 'none' }));
        const view = renderContextsView();
        expect(view.getByRole('heading', { name: '@Office' })).toBeInTheDocument();
        const compactSelect = view.getByRole('combobox', { name: 'Contexts & Tags' });
        fireEvent.change(compactSelect, { target: { value: '#ERP' } });
        expect(view.getByRole('button', { name: 'Remove filter #ERP' })).toBeInTheDocument();
        expect(view.getByRole('button', { name: 'Any' })).toBeInTheDocument();
        const state = JSON.parse(window.localStorage.getItem(CONTEXTS_VIEW_STATE_STORAGE_KEY) ?? '{}') as {
            selectedContexts?: string[];
            matchMode?: string;
        };
        expect(state.selectedContexts).toEqual(['@Office', '#ERP']);
        expect(state.matchMode).toBe('all');
        fireEvent.click(view.getByRole('button', { name: 'Remove filter #ERP' }));
        expect(view.getByRole('heading', { name: '@Office' })).toBeInTheDocument();
    });

    it('returns the compact token selector to all contexts', () => {
        const view = renderContextsView();
        const compactSelect = view.getByRole('combobox', { name: 'Contexts & Tags' });

        fireEvent.change(compactSelect, { target: { value: '@Office' } });

        expect(compactSelect).toHaveValue('@Office');

        const clearOption = view.getByRole('option', { name: 'Clear' }) as HTMLOptionElement;
        fireEvent.change(compactSelect, { target: { value: clearOption.value } });

        expect(compactSelect).toHaveValue('');
        expect(view.getByRole('heading', { name: 'Contexts & Tags' })).toBeInTheDocument();
    });

    it('shows direct Sort and Group controls and highlights only the changed control', () => {
        const { getByRole } = renderContextsView();
        const sort = getByRole('combobox', { name: 'Sort' });
        const group = getByRole('combobox', { name: 'Group' });

        expect(sort).toHaveClass('bg-card');
        expect(group).toHaveClass('bg-card');
        expect(getByRole('combobox', { name: 'Sort' }).querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

        selectToolbarOption('Sort', 'Title');
        expect(sort).toHaveClass('bg-primary/10');
        expect(group).toHaveClass('bg-card');

        selectToolbarOption('Sort', 'Default');
        expect(sort).toHaveClass('bg-card');
    });

    it('shows the direct Details toggle and propagates it to compact task metadata', () => {
        const dueDate = '2030-01-15';
        const tasks = [makeTask('due-context', {
            title: 'Due context task',
            contexts: ['@Office'],
            dueDate,
        })];
        useTaskStore.setState({ tasks, _allTasks: tasks });
        const view = renderContextsView();
        const formattedDueDate = safeFormatDate(dueDate, 'P');

        expect(view.getByRole('button', { name: 'Show details' })).toBeInTheDocument();
        expect(view.queryByText(formattedDueDate)).not.toBeInTheDocument();

        fireEvent.click(view.getByRole('button', { name: 'Show details' }));

        expect(view.getByRole('button', { name: 'Hide details' })).toBeInTheDocument();
        expect(view.getByText(formattedDueDate)).toBeInTheDocument();
        expect(useUiStore.getState().listOptions.showDetails).toBe(true);
    });

    it('collapses expanded rows when hiding Details', () => {
        useUiStore.setState((state) => ({
            ...state,
            expandedTaskIds: { 'task-1': true },
            listOptions: { ...state.listOptions, showDetails: true },
        }));
        const view = renderContextsView();

        fireEvent.click(view.getByRole('button', { name: 'Hide details' }));

        expect(view.getByRole('button', { name: 'Show details' })).toBeInTheDocument();
        expect(useUiStore.getState().listOptions.showDetails).toBe(false);
        expect(useUiStore.getState().expandedTaskIds).toEqual({});
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

    // #1415: Priority joins the shared list sort while Priorities is on.
    it('offers the Priority sort while Priorities is on and stores it as the shared list sort', () => {
        const tasks = [
            makeTask('task-low', { title: 'Low task', contexts: ['@Office'], priority: 'low' }),
            makeTask('task-none', { title: 'Unranked task', contexts: ['@Office'] }),
            makeTask('task-high', { title: 'High task', contexts: ['@Office'], priority: 'high' }),
        ];
        useTaskStore.setState({ tasks, _allTasks: tasks, projects: [], areas: [], settings: {} });

        const { container } = renderContextsView();
        selectToolbarOption('Sort', 'Priority');

        expect(useTaskStore.getState().settings.taskSortBy).toBe('priority');
        const text = container.textContent ?? '';
        expect(text.indexOf('High task')).toBeLessThan(text.indexOf('Low task'));
        expect(text.indexOf('Low task')).toBeLessThan(text.indexOf('Unranked task'));
    });

    it('hides the Priority sort while Priorities is off', () => {
        useTaskStore.setState({ settings: { features: { priorities: false } } });
        renderContextsView();
        openToolbarSelect('Sort');
        expect(screen.queryByRole('option', { name: 'Priority' })).not.toBeInTheDocument();
        expect(screen.getByRole('option', { name: 'Title' })).toBeInTheDocument();
    });

    it('applies task token navigation while the context view is mounted', () => {
        const { getByRole, getByText } = renderContextsView();

        act(() => {
            dispatchContextsTokenSelection('#ERP');
        });

        expect(getByRole('heading', { name: '#ERP' })).toBeInTheDocument();
        expect(getByText('Plan launch')).toBeInTheDocument();
        expect(window.localStorage.getItem(CONTEXTS_VIEW_STATE_STORAGE_KEY)).toContain('"selectedContexts":["#ERP"]');
    });

    it.each([
        ['Add context', 'Remove context', '@unused'],
        ['Add tag', 'Remove tag', '#unused'],
    ])('offers saved unused tokens in %s while Remove stays assigned-only', (add, remove, token) => {
        useTaskStore.setState({ settings: { taxonomy: {
            contexts: [{ token: '@unused', rev: 1, revBy: 'test', updatedAt: now }],
            tags: [{ token: '#unused', rev: 1, revBy: 'test', updatedAt: now }],
        } } });
        const view = renderContextsView();
        fireEvent.click(view.getByRole('button', { name: 'Select' }));
        fireEvent.click(view.getByRole('button', { name: 'Select All' }));
        fireEvent.click(view.getByRole('button', { name: add }));
        expect(within(view.getByRole('dialog')).getByRole('button', { name: token })).toBeInTheDocument();
        fireEvent.click(within(view.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
        fireEvent.click(view.getByRole('button', { name: remove }));
        expect(within(view.getByRole('dialog')).queryByRole('button', { name: token })).toBeNull();
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

    it('exports only selected customer tasks across projects in the active area', async () => {
        const workArea: Area = {
            id: 'area-work',
            name: 'Work',
            color: '#3b82f6',
            order: 0,
            createdAt: now,
            updatedAt: now,
        };
        const homeArea: Area = { ...workArea, id: 'area-home', name: 'Home', order: 1 };
        const project = (id: string, areaId: string): Project => ({
            id,
            title: id,
            status: 'active',
            color: '#3b82f6',
            order: 0,
            tagIds: [],
            areaId,
            createdAt: now,
            updatedAt: now,
        });
        const projects = [
            project('work-one', workArea.id),
            project('work-two', workArea.id),
            project('home-one', homeArea.id),
        ];
        const tasks = [
            makeTask('work-customer-1', { projectId: 'work-one', contexts: ['@customer1'] }),
            makeTask('work-customer-2', { projectId: 'work-two', contexts: ['@customer1'] }),
            makeTask('home-customer', { projectId: 'home-one', contexts: ['@customer1'] }),
            makeTask('work-other', { projectId: 'work-one', contexts: ['@other'] }),
        ];
        useTaskStore.setState({
            tasks,
            _allTasks: tasks,
            projects,
            _allProjects: projects,
            areas: [workArea, homeArea],
            _allAreas: [workArea, homeArea],
            settings: { filters: { areaId: workArea.id } },
        });
        const exportDesktopCsv = vi.spyOn(dataTransfer, 'exportDesktopCsv').mockResolvedValue(true);
        const view = renderContextsView();

        fireEvent.click(view.getByRole('button', { name: '@customer1 (2)' }));
        fireEvent.click(view.getByRole('button', { name: 'Select' }));
        fireEvent.click(view.getByRole('button', { name: 'Select All' }));
        await act(async () => {
            fireEvent.click(view.getByRole('button', { name: 'Export selected tasks as CSV' }));
            await vi.waitFor(() => expect(exportDesktopCsv).toHaveBeenCalledTimes(1));
        });
        const [snapshot, exportedTasks = []] = exportDesktopCsv.mock.calls[0]!;
        expect(snapshot.projects.map((item) => item.id).sort()).toEqual([
            'home-one',
            'work-one',
            'work-two',
        ]);
        expect(exportedTasks.map((item) => item.id).sort()).toEqual([
            'work-customer-1',
            'work-customer-2',
        ]);
        expect(exportedTasks).not.toContainEqual(expect.objectContaining({ id: 'home-customer' }));
        expect(exportedTasks).not.toContainEqual(expect.objectContaining({ id: 'work-other' }));
        exportDesktopCsv.mockRestore();
    });
});
