import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTaskDraft, type Task } from '@mindwtr/core';

import { useTaskItemSubmit } from './useTaskItemSubmit';

const flushPendingSaveMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock('@mindwtr/core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@mindwtr/core')>();
    return { ...actual, flushPendingSave: flushPendingSaveMock };
});

const task: Task = {
    id: 'task-1',
    title: 'Original',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
};

describe('useTaskItemSubmit attachment durability', () => {
    beforeEach(() => {
        flushPendingSaveMock.mockReset();
        flushPendingSaveMock.mockResolvedValue(undefined);
    });

    it('keeps the editor and attachment files unsettled until persistence completes', async () => {
        let resolveDurability!: () => void;
        flushPendingSaveMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
            resolveDurability = resolve;
        }));
        const beginAttachmentSave = vi.fn();
        const settlePersistedAttachmentSave = vi.fn();
        const setIsEditing = vi.fn();
        const editAttachments = [{
            id: 'draft-file',
            kind: 'file' as const,
            title: 'draft.txt',
            uri: '/data/mindwtr/attachments/draft-file.txt',
            createdAt: '2026-08-27T00:00:00.000Z',
            updatedAt: '2026-08-27T00:00:00.000Z',
        }];
        const draft = createTaskDraft(task);
        draft.title = 'Edited';
        const { result } = renderHook(() => useTaskItemSubmit({
            draft,
            editAttachments,
            editingTaskId: task.id,
            setEditingTaskId: vi.fn(),
            setIsEditing,
            showToast: vi.fn(),
            t: (key) => key,
            task,
            updateTask: vi.fn().mockResolvedValue({ success: true }),
            beginAttachmentSave: beginAttachmentSave.mockReturnValue(true),
            cancelAttachmentSaveBeforeStoreUpdate: vi.fn(),
            settlePersistedAttachmentSave,
        }));

        let submit!: ReturnType<typeof result.current>;
        await act(async () => {
            submit = result.current();
            await Promise.resolve();
        });
        expect(beginAttachmentSave).toHaveBeenCalledOnce();
        expect(settlePersistedAttachmentSave).not.toHaveBeenCalled();
        expect(setIsEditing).not.toHaveBeenCalled();

        resolveDurability();
        await act(async () => {
            await submit;
        });
        expect(settlePersistedAttachmentSave).toHaveBeenCalledWith(editAttachments);
        expect(setIsEditing).toHaveBeenCalledWith(false);
    });

    it('retains the attachment save guard when persistence fails', async () => {
        flushPendingSaveMock.mockRejectedValueOnce(new Error('sqlite unavailable'));
        const settlePersistedAttachmentSave = vi.fn();
        const cancelAttachmentSaveBeforeStoreUpdate = vi.fn();
        const showToast = vi.fn();
        const draft = createTaskDraft(task);
        draft.title = 'Edited';
        const { result } = renderHook(() => useTaskItemSubmit({
            draft,
            editAttachments: [{
                id: 'draft-file',
                kind: 'file',
                title: 'draft.txt',
                uri: '/data/mindwtr/attachments/draft-file.txt',
                createdAt: '2026-08-27T00:00:00.000Z',
                updatedAt: '2026-08-27T00:00:00.000Z',
            }],
            editingTaskId: task.id,
            setEditingTaskId: vi.fn(),
            setIsEditing: vi.fn(),
            showToast,
            t: (key) => key,
            task,
            updateTask: vi.fn().mockResolvedValue({ success: true }),
            beginAttachmentSave: vi.fn(() => true),
            cancelAttachmentSaveBeforeStoreUpdate,
            settlePersistedAttachmentSave,
        }));

        let outcome;
        await act(async () => {
            outcome = await result.current();
        });
        expect(outcome).toEqual({ success: false, error: 'sqlite unavailable' });
        expect(settlePersistedAttachmentSave).not.toHaveBeenCalled();
        expect(cancelAttachmentSaveBeforeStoreUpdate).not.toHaveBeenCalled();
        expect(showToast).toHaveBeenCalledWith('sqlite unavailable', 'error');
    });
});
