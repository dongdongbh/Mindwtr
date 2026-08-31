import React from 'react';
import { Text } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { StoreActionResult, Task } from '@mindwtr/core';

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

type Harness = {
    onSave: (taskId: string, updates: Partial<Task>) => unknown;
    onClose: () => void;
    showToast: ReturnType<typeof vi.fn>;
    deleteTask?: (taskId: string) => Promise<StoreActionResult>;
    resetTaskChecklist?: (taskId: string) => Promise<StoreActionResult>;
    restoreTask?: (taskId: string) => Promise<StoreActionResult>;
    convertTaskToSection?: (taskId: string) => Promise<StoreActionResult>;
    setChecklist?: ReturnType<typeof vi.fn>;
};

let saveHandle: () => Promise<boolean>;
let deleteHandle: () => Promise<void>;
let resetHandle: () => Promise<void>;
let convertToSectionHandle: () => Promise<void>;

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

    saveHandle = state.draftLifecycle.save;
    deleteHandle = actions.handleDeleteTask;
    resetHandle = actions.handleResetChecklist;
    convertToSectionHandle = actions.handleConvertToSection;
    return <Text>probe</Text>;
}

async function runSave(onSave: Harness['onSave']) {
    const showToast = vi.fn();
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
    const showToast = vi.fn();
    const onClose = vi.fn();
    const setChecklist = vi.fn();
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
        await act(async () => {
            await deletedToast.onAction();
        });

        expect(showToast).toHaveBeenLastCalledWith(expect.objectContaining({
            tone: 'error',
            message: 'Restore conflicted',
        }));
    });
});
