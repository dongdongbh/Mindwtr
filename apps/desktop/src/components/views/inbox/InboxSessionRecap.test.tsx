import { useState, type PropsWithChildren } from 'react';
import { act, fireEvent, render, renderHook, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTaskDraft, flushPendingSave, getStorageAdapter, setStorageAdapter, useTaskStore, type StoreActionResult, type Task } from '@mindwtr/core';
import { InboxSessionContext, useInboxCompletion, useInboxSessionTaskIds } from '../../../contexts/inbox-session-context';
import { KeybindingProvider } from '../../../contexts/keybinding-context';
import { LanguageProvider } from '../../../contexts/language-context';
import { useUiStore } from '../../../store/ui-store';
import { useTaskItemSubmit } from '../../Task/useTaskItemSubmit';
import { TaskItem } from '../../TaskItem';
import { ListView } from '../ListView';
import { createTaskListScope } from '../list/task-list-scope';
import { useTaskSelection } from '../list/useTaskSelection';
import { useInboxProcessingController } from './useInboxProcessingController';

const logInfo = vi.hoisted(() => vi.fn(async () => null));
vi.mock('../../../lib/app-log', () => ({ logInfo, logError: vi.fn(), logWarn: vi.fn() }));
vi.mock('../../../lib/report-error', () => ({ reportError: vi.fn() }));

const initialStorage = getStorageAdapter();
const initialTaskState = useTaskStore.getState();
const initialUiState = useUiStore.getState();
const stamp = '2026-11-12T12:00:00.000Z';
const makeTask = (id: string, patch: Partial<Task> = {}): Task => ({
    id, title: `Task ${id}`, status: 'inbox', contexts: [], tags: [], createdAt: stamp, updatedAt: stamp, ...patch,
});
const InboxScope = ({ children }: PropsWithChildren) => <InboxSessionContext.Provider value>{children}</InboxSessionContext.Provider>;

function renderInbox() {
    return render(
        <LanguageProvider>
            <KeybindingProvider currentView="inbox" onNavigate={() => {}}>
                <ListView title="Inbox" statusFilter="inbox" />
            </KeybindingProvider>
        </LanguageProvider>,
    );
}

beforeEach(() => {
    window.__MINDWTR_WORKSPACE_ID__ = 'default';
    useTaskStore.setState(initialTaskState, true);
    useUiStore.setState(initialUiState, true);
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allAreas: [], settings: {}, lastDataChangeAt: 0 });
    window.localStorage.clear();
    logInfo.mockClear();
});

afterEach(async () => {
    setStorageAdapter(initialStorage);
    await flushPendingSave();
    vi.restoreAllMocks();
    window.__MINDWTR_WORKSPACE_ID__ = 'default';
    useTaskStore.setState({ _allTasks: [] });
});

describe('Inbox session recap completion paths', () => {
    it('records an Inbox row completion, preserves the active queue and empty state, and survives navigation', async () => {
        useTaskStore.setState({ _allTasks: [makeTask('one'), makeTask('two'), makeTask('old', { status: 'done' })] });
        const inbox = renderInbox();
        fireEvent.click(within(inbox.getByText('Task one').closest('[data-task-id]')!).getByRole('button', { name: 'Mark Done' }));
        await waitFor(() => expect(inbox.getByTestId('inbox-session-recap')).toBeInTheDocument());
        const recap = inbox.getByTestId('inbox-session-recap');
        expect(recap).not.toHaveAttribute('open');
        expect(recap.querySelector('summary')).toHaveTextContent('Completed in this session (1)');
        expect(recap.querySelectorAll('li')).toHaveLength(0);
        fireEvent.click(recap.querySelector('summary')!);
        await waitFor(() => expect(within(recap).getByText('Task one')).toBeInTheDocument());
        expect(within(recap).queryByText('Task old')).not.toBeInTheDocument();
        expect(within(recap).queryByRole('button')).not.toBeInTheDocument();
        expect(useTaskStore.getState()._tasksById.get('one')?.status).toBe('done');
        expect(useTaskStore.getState().tasks.filter((task) => task.status === 'inbox')).toHaveLength(1);
        expect(inbox.getByRole('button', { name: /Process Inbox \(1\)/ })).toBeInTheDocument();
        inbox.unmount();
        const returned = renderInbox();
        expect(returned.getByTestId('inbox-session-recap').querySelector('summary')).toHaveTextContent('(1)');
        fireEvent.click(within(returned.getByText('Task two').closest('[data-task-id]')!).getByRole('button', { name: 'Mark Done' }));
        await waitFor(() => expect(returned.getByTestId('inbox-session-recap').querySelector('summary')).toHaveTextContent('(2)'));
        expect(returned.getByText('Capture anything on your mind here — organize later.')).toBeInTheDocument();
        expect(logInfo).toHaveBeenCalledWith('Inbox session completions recorded', {
            scope: 'inbox', extra: { releaseCheck: 'v1.3.9/inbox-session-recap', entries: 1 },
        });
    });

    it('ignores completions from another surface even for an Inbox task', async () => {
        const task = makeTask('outside');
        useTaskStore.setState({ _allTasks: [task] });
        const outside = render(<LanguageProvider><TaskItem task={task} /></LanguageProvider>);
        fireEvent.click(outside.getByRole('button', { name: 'Mark Done' }));
        await waitFor(() => expect(useTaskStore.getState()._tasksById.get(task.id)?.status).toBe('done'));
        outside.unmount();
        expect(renderInbox().queryByTestId('inbox-session-recap')).not.toBeInTheDocument();
    });

    it.each(['failure', 'rejection'] as const)('does not record an Inbox row %s', async (mode) => {
        const moveTask = vi.fn(async () => {
            if (mode === 'rejection') throw new Error('Save failed');
            return { success: false, error: 'Save failed' };
        });
        useTaskStore.setState({ _allTasks: [makeTask('failed')], moveTask });
        const inbox = renderInbox();
        fireEvent.click(inbox.getByRole('button', { name: 'Mark Done' }));
        await waitFor(() => expect(moveTask).toHaveBeenCalled());
        await act(async () => {});
        expect(inbox.queryByTestId('inbox-session-recap')).not.toBeInTheDocument();
        expect(logInfo).not.toHaveBeenCalledWith('Inbox session completions recorded', expect.anything());
    });

    it.each(['resolve', 'reject'] as const)('waits for durable completion before recording: %s', async (outcome) => {
        useTaskStore.setState({ _allTasks: [makeTask('persist')] });
        let finish!: () => void;
        let fail!: (error: Error) => void;
        const held = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
        const saveData = vi.fn(() => held);
        setStorageAdapter({ ...initialStorage, saveData });
        const hook = renderHook(() => ({ track: useInboxCompletion(), ids: useInboxSessionTaskIds() }), { wrapper: InboxScope });
        let pending!: Promise<StoreActionResult>;
        act(() => { pending = hook.result.current.track(['persist'], () => useTaskStore.getState().moveTask('persist', 'done')); });
        const settled = pending.then(() => 'saved', () => 'failed');
        await waitFor(() => expect(saveData).toHaveBeenCalled());
        expect(hook.result.current.ids).toEqual([]);
        expect(logInfo).not.toHaveBeenCalledWith('Inbox session completions recorded', expect.anything());
        await act(async () => {
            if (outcome === 'resolve') finish();
            else fail(new Error('Disk unavailable'));
            expect(await settled).toBe(outcome === 'resolve' ? 'saved' : 'failed');
        });
        expect(hook.result.current.ids).toEqual(outcome === 'resolve' ? ['persist'] : []);
    });

    it('records only the completed recurring instance', async () => {
        useTaskStore.setState({ _allTasks: [makeTask('recurring', { recurrence: 'daily', dueDate: '2026-11-12' })] });
        const inbox = renderInbox();
        fireEvent.click(inbox.getByRole('button', { name: 'Mark Done' }));
        await waitFor(() => expect(inbox.getByTestId('inbox-session-recap')).toBeInTheDocument());
        const successor = useTaskStore.getState()._allTasks.find((task) => task.id !== 'recurring');
        expect(successor).toBeDefined();
        expect(successor?.status).not.toBe('done');
        fireEvent.click(inbox.getByTestId('inbox-session-recap').querySelector('summary')!);
        await waitFor(() => expect(inbox.getByTestId('inbox-session-recap').querySelectorAll('li')).toHaveLength(1));
        expect(inbox.getByTestId('inbox-session-recap').querySelectorAll('li')).toHaveLength(1);
        expect(useTaskStore.getState()._tasksById.get('recurring')?.status).toBe('done');
    });

    it.each(['reopen', 'delete', 'archive'] as const)('removes a recap entry on %s and does not restore it after an outside completion', async (action) => {
        useTaskStore.setState({ _allTasks: [makeTask('one')] });
        const inbox = renderInbox();
        fireEvent.click(inbox.getByRole('button', { name: 'Mark Done' }));
        await waitFor(() => expect(inbox.getByTestId('inbox-session-recap')).toBeInTheDocument());
        await act(async () => {
            const store = useTaskStore.getState();
            if (action === 'delete') await store.deleteTask('one');
            else await store.moveTask('one', action === 'archive' ? 'archived' : 'inbox');
        });
        expect(inbox.queryByTestId('inbox-session-recap')).not.toBeInTheDocument();
        await act(async () => {
            if (action === 'delete') await useTaskStore.getState().restoreTask('one');
            await useTaskStore.getState().moveTask('one', 'done');
        });
        expect(inbox.queryByTestId('inbox-session-recap')).not.toBeInTheDocument();
    });

    it('uses the keyboard completion seam and existing undo', async () => {
        useTaskStore.setState({ _allTasks: [makeTask('keyboard')] });
        const hook = renderHook(() => ({ track: useInboxCompletion(), ids: useInboxSessionTaskIds() }), { wrapper: InboxScope });
        const scope = createTaskListScope({
            getTasks: () => useTaskStore.getState().tasks,
            getSelectedIndex: () => 0, setSelectedIndex: () => {}, t: (key) => key,
            trackCompletion: hook.result.current.track,
        });
        act(() => scope.toggleDoneSelected());
        await waitFor(() => expect(hook.result.current.ids).toEqual(['keyboard']));
        const toasts = useUiStore.getState().toasts;
        const toast = toasts[toasts.length - 1];
        expect(toast?.action).toBeDefined();
        await act(async () => { toast?.action?.onClick(); });
        await waitFor(() => expect(hook.result.current.ids).toEqual([]));
        expect(useTaskStore.getState()._tasksById.get('keyboard')?.status).toBe('inbox');
    });

    it.each(['move', 'organize'] as const)('records selected IDs only through bulk %s', async (action) => {
        useTaskStore.setState({ _allTasks: [makeTask('selected'), makeTask('unselected')] });
        const hook = renderHook(() => ({
            selection: useTaskSelection(['selected', 'unselected'], {
                batchMoveTasks: useTaskStore.getState().batchMoveTasks,
                batchUpdateTasks: useTaskStore.getState().batchUpdateTasks,
                tasksById: useTaskStore.getState()._tasksById,
            }),
            ids: useInboxSessionTaskIds(),
        }), { wrapper: InboxScope });
        act(() => hook.result.current.selection.toggleMultiSelect('selected'));
        await act(async () => {
            if (action === 'move') await hook.result.current.selection.moveSelectedTasks('done');
            else await hook.result.current.selection.organizeSelectedTasks({ status: 'done' });
        });
        expect(hook.result.current.ids).toEqual(['selected']);
        expect(useTaskStore.getState()._tasksById.get('unselected')?.status).toBe('inbox');
    });

    it('records editor status saves through the production draft hook', async () => {
        const task = makeTask('editor');
        useTaskStore.setState({ _allTasks: [task] });
        const hook = renderHook(() => ({
            save: useTaskItemSubmit({
                task, baselineTask: task, draft: { ...createTaskDraft(task), status: 'done' },
                editAttachments: [], editingTaskId: task.id, setEditingTaskId: () => {}, setIsEditing: () => {},
                t: (key) => key, showToast: () => {}, beginAttachmentSave: () => false,
                cancelAttachmentSaveBeforeStoreUpdate: () => {}, settlePersistedAttachmentSave: () => {},
            }),
            ids: useInboxSessionTaskIds(),
        }), { wrapper: InboxScope });
        await act(async () => { await hook.result.current.save(); });
        expect(hook.result.current.ids).toEqual(['editor']);
    });

    it('keeps the Inbox source when the editor is rendered in a portal', async () => {
        useTaskStore.setState({
            _allTasks: [makeTask('modal')],
            settings: { gtd: { taskEditor: { presentation: 'modal' } } },
        });
        const inbox = renderInbox();
        fireEvent.doubleClick(inbox.getByText('Task modal').closest('[data-task-id]')!);
        const dialog = inbox.getByRole('dialog', { name: /edit task/i });
        expect(inbox.container.contains(dialog)).toBe(false);
        fireEvent.click(within(dialog).getByTitle('Right-click to complete with a different time'));
        await waitFor(() => expect(inbox.getByTestId('inbox-session-recap')).toHaveTextContent('Completed in this session (1)'));
        fireEvent.click(inbox.getByTestId('inbox-session-recap').querySelector('summary')!);
        await waitFor(() => expect(inbox.getByTestId('inbox-session-recap')).toHaveTextContent('Task modal'));
        expect(useTaskStore.getState()._tasksById.get('modal')?.status).toBe('done');
    });

    it('records an editor completion selected while attachment preparation is pending', async () => {
        const task = makeTask('upload');
        useTaskStore.setState({ _allTasks: [task] });
        let finish!: () => void;
        const preparing = new Promise<void>((resolve) => { finish = resolve; });
        const hook = renderHook(({ status }: { status: 'inbox' | 'done' }) => ({
            save: useTaskItemSubmit({
                task, baselineTask: task, draft: { ...createTaskDraft(task), status },
                editAttachments: [], editingTaskId: task.id, setEditingTaskId: () => {}, setIsEditing: () => {},
                t: (key) => key, showToast: () => {}, beginAttachmentSave: () => false,
                cancelAttachmentSaveBeforeStoreUpdate: () => {}, settlePersistedAttachmentSave: () => {},
                prepareAttachmentsForSave: async () => { await preparing; return []; },
            }),
            ids: useInboxSessionTaskIds(),
        }), { initialProps: { status: 'inbox' }, wrapper: InboxScope });
        let save!: ReturnType<typeof hook.result.current.save>;
        act(() => { save = hook.result.current.save(); });
        hook.rerender({ status: 'done' });
        await act(async () => { finish(); await save; });
        expect(hook.result.current.ids).toEqual(['upload']);
    });

    it('records successful Process Inbox completion through the workflow write', async () => {
        useTaskStore.setState({ _allTasks: [makeTask('processed')] });
        const hook = renderHook(() => {
            const [isProcessing, setIsProcessing] = useState(true);
            return {
                controller: useInboxProcessingController({
                    t: (key) => key, tasks: useTaskStore((state) => state.tasks), projects: [], areas: [], settings: {},
                    addTask: initialTaskState.addTask, addProject: initialTaskState.addProject,
                    updateTask: initialTaskState.updateTask, deleteTask: initialTaskState.deleteTask,
                    allContexts: [], allTags: [], isProcessing, setIsProcessing,
                }),
                ids: useInboxSessionTaskIds(),
            };
        }, { wrapper: InboxScope });
        await waitFor(() => expect(hook.result.current.controller.wizardProps.processingTask?.id).toBe('processed'));
        await act(async () => { await hook.result.current.controller.wizardProps.handleTwoMinDone(); });
        expect(hook.result.current.ids).toEqual(['processed']);
    });

    it('rejects a pending completion across workspaces, resets on switch, and ignores stale callbacks', async () => {
        useTaskStore.setState({ _allTasks: [makeTask('shared-id')] });
        const hook = renderHook(() => ({ track: useInboxCompletion(), ids: useInboxSessionTaskIds() }), { wrapper: InboxScope });
        let resolve!: (result: StoreActionResult) => void;
        const held = new Promise<StoreActionResult>((finish) => { resolve = finish; });
        const staleTrack = hook.result.current.track;
        const pending = staleTrack(['shared-id'], () => held);
        act(() => {
            window.__MINDWTR_WORKSPACE_ID__ = 'other';
            useTaskStore.setState({ _allTasks: [makeTask('shared-id', { status: 'done' })] });
        });
        await act(async () => { resolve({ success: true }); await pending; });
        hook.rerender();
        expect(hook.result.current.ids).toEqual([]);
        act(() => useTaskStore.setState({ _allTasks: [makeTask('shared-id')] }));
        await act(async () => { await staleTrack(['shared-id'], () => useTaskStore.getState().moveTask('shared-id', 'done')); });
        expect(hook.result.current.ids).toEqual([]);
        act(() => useTaskStore.setState({ _allTasks: [makeTask('shared-id')] }));
        await act(async () => { await hook.result.current.track(['shared-id'], () => useTaskStore.getState().moveTask('shared-id', 'done')); });
        expect(hook.result.current.ids).toEqual(['shared-id']);
        act(() => {
            window.__MINDWTR_WORKSPACE_ID__ = 'third';
            useTaskStore.setState({ _allTasks: [makeTask('shared-id', { status: 'done' })] });
        });
        expect(hook.result.current.ids).toEqual([]);
    });
});
