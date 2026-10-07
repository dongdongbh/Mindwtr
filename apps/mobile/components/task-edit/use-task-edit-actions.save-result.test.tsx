import React from 'react';
import { Share, Text } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTaskStore, type StoreActionResult, type Task } from '@mindwtr/core';

import { createTaskEditDraft } from './task-edit-draft-adapter';
import { useTaskEditActions } from './use-task-edit-actions';
import { useTaskEditState } from './use-task-edit-state';

vi.mock('expo-router', () => ({
    router: { push: vi.fn() },
}));

/**
 * Store writes resolve `{ success: false, error }` WITHOUT throwing. The editor
 * must be checked before the editor closes.
 */

const baseTask: Task = {
    id: 'task-1',
    title: 'Plan launch',
    status: 'next',
    tags: [],
    contexts: [],
    checklist: [{ id: 'step-1', title: 'Ship it', isCompleted: true }],
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
};

const t = (key: string) => key;
const initialTaskState = useTaskStore.getState();

type TaskEditActionsArgs = Parameters<typeof useTaskEditActions>[0];
type ShowToast = TaskEditActionsArgs['showToast'];
type SetChecklist = TaskEditActionsArgs['setChecklist'];

type Harness = {
    onSave: (taskId: string, updates: Partial<Task>) => unknown;
    onClose: () => void;
    showToast: ShowToast;
    deleteTask?: (taskId: string) => Promise<StoreActionResult>;
    resetTaskChecklist?: (taskId: string) => Promise<StoreActionResult>;
    restoreTask?: (taskId: string) => Promise<StoreActionResult>;
    convertTaskToSection?: (taskId: string) => Promise<StoreActionResult>;
    setChecklist?: SetChecklist;
};

let saveHandle: () => Promise<boolean>;
let cancelHandle: () => Promise<void>;
let deleteHandle: () => Promise<void>;
let resetHandle: () => Promise<void>;
let convertToSectionHandle: () => Promise<void>;
let promotionActions: ReturnType<typeof useTaskEditActions>;
let shareHandle: () => Promise<void>;

function SaveProbe({
    onSave,
    onClose,
    showToast,
    deleteTask = vi.fn(async () => ({ success: true })),
    resetTaskChecklist = vi.fn(async () => ({ success: true })),
    restoreTask = vi.fn(async () => ({ success: true })),
    convertTaskToSection = vi.fn(async () => ({ success: true })),
    setChecklist = vi.fn(),
}: Harness) {
    const draft = createTaskEditDraft(baseTask);
    const state = useTaskEditState({
        onClose,
        onSave,
        onSaveError: (message) => showToast({
            title: 'Task update failed',
            tone: 'error',
            message: message || 'Could not update task.',
        }),
        resetCopilotStateRef: { current: vi.fn() },
        sections: [],
        task: baseTask,
        tasks: [baseTask],
        visible: true,
    });
    state.titleDraftRef.current = 'Plan launch v2';
    const actions = useTaskEditActions({
        aiEnabled: false,
        closeAIModal: vi.fn(),
        deleteTask,
        descriptionDraft: '',
        draftLifecycle: state.draftLifecycle,
        duplicateTask: vi.fn(),
        convertTaskToSection,
        promoteTaskToProject: useTaskStore.getState().promoteTaskToProject,
        mergedTask: baseTask,
        taskEditDraft: draft,
        formatDate: () => '',
        formatDueDate: () => '',
        formatTimeEstimateLabel: () => '',
        isAIWorking: false,
        onClose,
        prioritiesEnabled: true,
        resetTaskChecklist,
        restoreTask,
        setAiModal: vi.fn(),
        setChecklist,
        setDraftField: vi.fn(),
        setIsAIWorking: vi.fn(),
        setTitleImmediate: vi.fn(),
        settings: {},
        showToast,
        t,
        task: baseTask,
        tasks: [baseTask],
        timeEstimatesEnabled: true,
        titleDraftRef: state.titleDraftRef,
    } as unknown as Parameters<typeof useTaskEditActions>[0]);

    promotionActions = actions;
    saveHandle = state.draftLifecycle.save;
    deleteHandle = actions.handleDeleteTask;
    cancelHandle = actions.handleCancelTask;
    resetHandle = actions.handleResetChecklist;
    convertToSectionHandle = actions.handleConvertToSection;
    shareHandle = actions.handleShare;
    return <Text>probe</Text>;
}

async function runSave(onSave: Harness['onSave']) {
    const showToast = vi.fn<ShowToast>();
    const onClose = vi.fn();
    await act(async () => {
        renderer.create(<SaveProbe onSave={onSave} onClose={onClose} showToast={showToast} />);
    });
    await act(async () => {
        await saveHandle();
        await Promise.resolve();
    });
    return { onClose, showToast };
}

async function renderActions(overrides: Partial<Harness> = {}) {
    const showToast = vi.fn<ShowToast>();
    const onClose = vi.fn();
    const setChecklist = vi.fn<SetChecklist>();
    await act(async () => {
        renderer.create(
            <SaveProbe
                onSave={vi.fn()}
                onClose={onClose}
                showToast={showToast}
                setChecklist={setChecklist}
                {...overrides}
            />,
        );
    });
    return { onClose, setChecklist, showToast };
}

describe('task editor save results', () => {
    afterEach(() => {
        useTaskStore.setState(initialTaskState, true);
        vi.restoreAllMocks();
    });
    it('keeps the exact native Share payload from the unsaved title and raw checklist', async () => {
        const share = vi.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never);
        await renderActions();

        await act(async () => { await shareHandle(); });

        expect(share).toHaveBeenCalledExactlyOnceWith({
            title: 'Plan launch v2',
            message: 'Plan launch v2\ntaskEdit.statusLabel: status.next\n\ntaskEdit.checklist:\n[x] Ship it',
        });
    });
    it('shows an error when the store write resolves to a failure', async () => {
        const onSave = vi.fn(() => Promise.resolve({ success: false, error: 'Task is deleted' }));

        const { showToast } = await runSave(onSave);

        expect(onSave).toHaveBeenCalledWith('task-1', expect.objectContaining({ title: 'Plan launch v2' }));
        expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
            tone: 'error',
            message: 'Task is deleted',
        }));
    });

    // Regression guard for the old hardcoded 'Task update failed' literal, which
    // was a non-empty string and therefore pre-empted the `task.updateFailed`
    // lookup it was supposed to be a fallback for.
    it('routes a message-less failure through the translated copy', async () => {
        const onSave = vi.fn(() => Promise.resolve({ success: false }));

        const { showToast } = await runSave(onSave);

        expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
            tone: 'error',
            message: 'Could not update task.',
        }));
    });

    it('reports a thrown write too', async () => {
        const onSave = vi.fn(() => Promise.reject(new Error('offline')));

        const { showToast } = await runSave(onSave);

        expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'error', message: 'offline' }));
    });

    it('stays quiet on a successful save', async () => {
        const onSave = vi.fn(() => Promise.resolve({ success: true }));

        const { onClose, showToast } = await runSave(onSave);

        expect(showToast).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalled();
    });

    it('does not mistake a void-returning save handler for a failure', async () => {
        const onSave = vi.fn(() => undefined);

        const { showToast } = await runSave(onSave);

        expect(showToast).not.toHaveBeenCalled();
    });

    it('keeps the editor open when delete resolves to a failure', async () => {
        const { onClose, showToast } = await renderActions({
            deleteTask: vi.fn(async () => ({ success: false, error: 'Task is missing' })),
        });

        await act(async () => {
            await deleteHandle();
        });

        expect(onClose).not.toHaveBeenCalled();
        expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
            tone: 'error',
            message: 'Task is missing',
        }));
    });

    it('routes cancellation through the draft lifecycle', async () => {
        const onSave = vi.fn(async () => ({ success: true }));
        const { onClose, showToast } = await renderActions({ onSave });

        await act(async () => {
            await cancelHandle();
        });

        expect(onSave).toHaveBeenCalledOnce();
        expect(onSave).toHaveBeenCalledWith('task-1', expect.objectContaining({
            title: 'Plan launch v2',
            status: 'archived',
            completedAt: undefined,
        }));
        expect(onClose).toHaveBeenCalledOnce();
        expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
            message: 'Task cancelled. You can restore it from Archive.',
            tone: 'info',
            actionLabel: 'Undo',
        }));
    });

    it('restores cancellation fields while retaining later edits', async () => {
        const original = { ...baseTask, isFocusedToday: true, focusOrder: 3, boardOrder: 7 };
        useTaskStore.setState({ _allTasks: [original], _tasksById: new Map([[original.id, original]]) });
        const onSave = vi.fn(async (_id: string, patch: Partial<Task>) => {
            const cancelled = { ...original, ...patch, isFocusedToday: false, focusOrder: undefined, boardOrder: undefined };
            useTaskStore.setState({ _allTasks: [cancelled], _tasksById: new Map([[original.id, cancelled]]) });
            return { success: true };
        });
        const updateTask = vi.fn(async (_id: string, patch: Partial<Task>) => {
            const current = useTaskStore.getState()._tasksById.get(original.id)!;
            const restored = { ...current, ...patch };
            useTaskStore.setState({ _allTasks: [restored], _tasksById: new Map([[original.id, restored]]) });
            return { success: true };
        });
        useTaskStore.setState({ updateTask });
        const { showToast } = await renderActions({ onSave });
        await act(async () => { await cancelHandle(); });
        const successToast = showToast.mock.calls.find(([options]) => options.tone === 'info')?.[0];
        expect(successToast?.onAction).toBeTypeOf('function');
        const newer = { ...useTaskStore.getState()._tasksById.get(original.id)!, description: 'Later edit' };
        useTaskStore.setState({ _allTasks: [newer], _tasksById: new Map([[original.id, newer]]) });

        await act(async () => { await successToast?.onAction?.(); });
        expect(updateTask).toHaveBeenCalledExactlyOnceWith(original.id, {
            status: 'next', cancelledAt: undefined, completedAt: undefined,
            isFocusedToday: true, focusOrder: 3, boardOrder: 7,
        });
        expect(useTaskStore.getState()._tasksById.get(original.id)).toMatchObject({
            status: 'next', description: 'Later edit', isFocusedToday: true,
        });
    });

    it('shows errors when cancellation or its Undo fails', async () => {
        const failedCancel = await renderActions({
            onSave: vi.fn(async () => ({ success: false, error: 'disk full' })),
        });
        await act(async () => { await cancelHandle(); });
        expect(failedCancel.showToast).not.toHaveBeenCalledWith(expect.objectContaining({ tone: 'info' }));
        expect(failedCancel.showToast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'error', message: 'disk full' }));

        const archived = { ...baseTask, status: 'archived' as const, cancelledAt: '2026-09-24T12:00:00.000Z' };
        const onSave = vi.fn(async () => {
            useTaskStore.setState({ _allTasks: [archived], _tasksById: new Map([[archived.id, archived]]) });
            return { success: true };
        });
        useTaskStore.setState({
            _allTasks: [baseTask],
            _tasksById: new Map([[baseTask.id, baseTask]]),
            updateTask: vi.fn(async () => ({ success: false, error: 'undo save failed' })),
        });
        const { showToast } = await renderActions({ onSave });
        await act(async () => { await cancelHandle(); });
        const undo = showToast.mock.calls.find(([options]) => options.tone === 'info')?.[0].onAction;
        await act(async () => { await undo?.(); });
        expect(showToast).toHaveBeenLastCalledWith(expect.objectContaining({
            tone: 'error', message: 'undo save failed', actionLabel: 'Undo',
        }));
    });

    it('keeps the original status for Undo after an optimistic cancellation retry', async () => {
        const archived = { ...baseTask, status: 'archived' as const, cancelledAt: '2026-09-24T12:00:00.000Z' };
        useTaskStore.setState({ _allTasks: [baseTask], _tasksById: new Map([[baseTask.id, baseTask]]) });
        const onSave = vi.fn()
            .mockImplementationOnce(async () => {
                useTaskStore.setState({ _allTasks: [archived], _tasksById: new Map([[baseTask.id, archived]]) });
                return { success: false, error: 'disk full' };
            })
            .mockResolvedValueOnce({ success: true });
        const updateTask = vi.fn(async (_id: string, patch: Partial<Task>) => {
            const restored = { ...archived, ...patch };
            useTaskStore.setState({ _allTasks: [restored], _tasksById: new Map([[baseTask.id, restored]]) });
            return { success: true };
        });
        useTaskStore.setState({ updateTask });
        const { showToast } = await renderActions({ onSave });

        await act(async () => { await cancelHandle(); });
        expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ tone: 'info' }));
        await act(async () => { await cancelHandle(); });
        const successToast = showToast.mock.calls.find(([options]) => options.tone === 'info')?.[0];
        await act(async () => { await successToast?.onAction?.(); });
        expect(updateTask).toHaveBeenCalledWith(baseTask.id, expect.objectContaining({ status: 'next', cancelledAt: undefined }));
    });

    it('does not reset the draft when checklist reset resolves to a failure', async () => {
        const { setChecklist, showToast } = await renderActions({
            resetTaskChecklist: vi.fn(async () => ({ success: false, error: 'Task is deleted' })),
        });

        await act(async () => {
            await resetHandle();
        });

        expect(setChecklist).not.toHaveBeenCalled();
        expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
            tone: 'error',
            message: 'Task is deleted',
        }));
    });

    // The conversion soft-deletes the task, so an uncommitted title edit would be
    // lost with it unless the draft is saved first (#1106).
    it('commits the open draft before converting the task into a section', async () => {
        const onSave = vi.fn(() => Promise.resolve({ success: true }));
        const convertTaskToSection = vi.fn(async () => ({ success: true }));
        const { showToast } = await renderActions({ onSave, convertTaskToSection });

        await act(async () => {
            await convertToSectionHandle();
        });

        expect(onSave).toHaveBeenCalledWith('task-1', expect.objectContaining({ title: 'Plan launch v2' }));
        expect(convertTaskToSection).toHaveBeenCalledWith('task-1');
        expect(convertTaskToSection.mock.invocationCallOrder[0])
            .toBeGreaterThan(onSave.mock.invocationCallOrder[0]);
        expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'success' }));
    });

    it('reports a failed conversion instead of a success toast', async () => {
        const { showToast } = await renderActions({
            onSave: vi.fn(() => Promise.resolve({ success: true })),
            convertTaskToSection: vi.fn(async () => ({ success: false, error: 'Task is not in a project' })),
        });

        await act(async () => {
            await convertToSectionHandle();
        });

        expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
            tone: 'error',
            message: 'Task is not in a project',
        }));
        expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ tone: 'success' }));
    });

    it('reports a fulfilled undo failure', async () => {
        const { showToast } = await renderActions({
            deleteTask: vi.fn(async () => ({ success: true })),
            restoreTask: vi.fn(async () => ({ success: false, error: 'Restore conflicted' })),
        });

        await act(async () => {
            await deleteHandle();
        });
        const deletedToast = showToast.mock.calls[0]?.[0];
        expect(deletedToast?.onAction).toBeTypeOf('function');
        await act(async () => {
            await deletedToast?.onAction?.();
        });

        expect(showToast).toHaveBeenLastCalledWith(expect.objectContaining({
            tone: 'error',
            message: 'Restore conflicted',
        }));
    });
});

describe('task editor checklist actions', () => {
    const renderChecklistActions = async (task: Task, draftChecklist: NonNullable<Task['checklist']>) => {
        const calls = {
            resetTaskChecklist: vi.fn(async () => ({ success: true })),
            setChecklist: vi.fn(),
            setDraftField: vi.fn(),
            showToast: vi.fn(),
        };
        let actions!: ReturnType<typeof useTaskEditActions>;
        function Probe() {
            actions = useTaskEditActions({
                ...calls,
                canMutate: () => true,
                mergedTask: task,
                t,
                task,
                taskEditDraft: { ...createTaskEditDraft(task), checklist: draftChecklist },
                tasks: [task],
            } as unknown as Parameters<typeof useTaskEditActions>[0]);
            return null;
        }
        await act(async () => {
            renderer.create(<Probe />);
        });
        return { actions, calls };
    };

    it('reopens items added in this editor on Reset checklist, and writes nothing', async () => {
        const task: Task = { ...baseTask, checklist: undefined };
        const { actions, calls } = await renderChecklistActions(task, [
            { id: 'new-1', title: 'Added', isCompleted: true },
            { id: 'new-2', title: 'Also added', isCompleted: false },
        ]);

        await act(async () => {
            await actions.handleResetChecklist();
        });

        expect(calls.resetTaskChecklist).not.toHaveBeenCalled();
        expect(calls.showToast).not.toHaveBeenCalled();
        expect(calls.setChecklist).toHaveBeenCalledWith([
            { id: 'new-1', title: 'Added', isCompleted: false },
            { id: 'new-2', title: 'Also added', isCompleted: false },
        ]);
    });

    it('keeps a Reference list its status when every item is ticked', async () => {
        const task: Task = { ...baseTask, status: 'reference', taskMode: 'list' };
        const { actions, calls } = await renderChecklistActions(task, task.checklist ?? []);

        act(() => {
            actions.applyChecklistUpdate([{ id: 'step-1', title: 'Ship it now', isCompleted: true }]);
        });

        expect(calls.setChecklist).toHaveBeenCalledWith([{ id: 'step-1', title: 'Ship it now', isCompleted: true }]);
        expect(calls.setDraftField).not.toHaveBeenCalled();
    });
});

describe('checklist project choice', () => {
    it.each([false, true])('only expands after explicit confirmation (%s)', async expand => {
        const promote = vi.fn(async () => ({ success: true, id: 'project' }));
        const convert = vi.fn(async () => ({ success: true, id: 'project' }));
        useTaskStore.setState({ _allTasks: [baseTask], _allProjects: [], _allAreas: [], _allSections: [],
            promoteTaskToProject: promote, convertChecklistToProject: convert });
        const onSave = vi.fn(async () => ({ success: true }));
        const onClose = vi.fn();
        let tree!: renderer.ReactTestRenderer;
        await act(async () => { tree = renderer.create(<SaveProbe onSave={onSave} onClose={onClose} showToast={vi.fn()} />); });
        await act(async () => { promotionActions.handlePromoteTaskToProject(); });
        expect(promotionActions.projectConversionOpen).toBe(true);
        expect(convert).not.toHaveBeenCalled();
        expect(promote).not.toHaveBeenCalled();
        await act(async () => { await promotionActions.confirmProjectConversion('New project', expand); });
        expect(expand ? convert : promote).toHaveBeenCalledTimes(1);
        expect(expand ? promote : convert).not.toHaveBeenCalled();
        await act(async () => { tree.unmount(); });
    });
});
