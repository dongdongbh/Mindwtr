import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@mindwtr/core';

import { useTaskEditState } from './use-task-edit-state';

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
    createdAt: '2026-07-23T00:00:00.000Z',
    updatedAt: '2026-07-23T00:00:00.000Z',
};

describe('useTaskEditState', () => {
    beforeEach(() => {
        flushPendingSaveMock.mockReset();
        flushPendingSaveMock.mockResolvedValue(undefined);
    });

    it('can synchronize a persisted field without marking the draft dirty', () => {
        let state!: ReturnType<typeof useTaskEditState>;
        const resetCopilotStateRef = { current: vi.fn() };

        function Probe() {
            state = useTaskEditState({
                onClose: vi.fn(),
                onSave: vi.fn(),
                onSaveError: vi.fn(),
                resetCopilotStateRef,
                sections: [],
                task,
                tasks: [task],
                visible: true,
            });
            return null;
        }

        renderer.act(() => {
            renderer.create(React.createElement(Probe));
        });

        renderer.act(() => {
            state.setDraftField('title', 'Transcribed', false);
        });

        expect(state.taskEditDraft?.draft.title).toBe('Transcribed');
        expect(state.isDirtyRef.current).toBe(false);

        renderer.act(() => {
            state.setDraftField('title', 'Edited');
        });

        expect(state.isDirtyRef.current).toBe(true);
    });

    it('keeps the editor open until the draft write succeeds', async () => {
        let state!: ReturnType<typeof useTaskEditState>;
        const onClose = vi.fn();
        const onSaveError = vi.fn();
        const onSave = vi.fn()
            .mockResolvedValueOnce({ success: false, error: 'disk full' })
            .mockResolvedValueOnce({ success: true });
        const resetCopilotStateRef = { current: vi.fn() };

        function Probe() {
            state = useTaskEditState({
                onClose,
                onSave,
                onSaveError,
                resetCopilotStateRef,
                sections: [],
                task,
                tasks: [task],
                visible: true,
            });
            return null;
        }

        renderer.act(() => {
            renderer.create(React.createElement(Probe));
        });
        renderer.act(() => {
            state.titleDraftRef.current = 'Edited';
            state.setTitleDraft('Edited');
            state.setDraftField('title', 'Edited');
        });

        await renderer.act(async () => {
            expect(await state.draftLifecycle.save()).toBe(false);
        });
        expect(onSave).toHaveBeenLastCalledWith('task-1', { title: 'Edited' });
        expect(onSaveError).toHaveBeenCalledWith('disk full');
        expect(onClose).not.toHaveBeenCalled();

        await renderer.act(async () => {
            expect(await state.draftLifecycle.save()).toBe(true);
        });
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('settles copied attachment drafts against the baseline on discard', () => {
        let state!: ReturnType<typeof useTaskEditState>;
        const settleAttachmentDraft = vi.fn();
        const onClose = vi.fn();
        const added = {
            id: 'draft-file',
            kind: 'file' as const,
            title: 'draft.txt',
            uri: 'file:///documents/attachments/draft-file.txt',
            createdAt: '2026-08-27T00:00:00.000Z',
            updatedAt: '2026-08-27T00:00:00.000Z',
        };

        function Probe() {
            state = useTaskEditState({
                onClose,
                onSave: vi.fn(),
                onSaveError: vi.fn(),
                resetCopilotStateRef: { current: vi.fn() },
                settleAttachmentDraft,
                sections: [],
                task,
                tasks: [task],
                visible: true,
            });
            return null;
        }

        renderer.act(() => {
            renderer.create(React.createElement(Probe));
        });
        renderer.act(() => {
            state.setAttachments([added]);
        });
        renderer.act(() => {
            state.draftLifecycle.discard();
        });

        expect(settleAttachmentDraft).toHaveBeenCalledWith({
            baselineAttachments: undefined,
            draftAttachments: [added],
            committedAttachments: undefined,
        });
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('keeps a copied attachment unsettled after a failed save and adopts it after success', async () => {
        let state!: ReturnType<typeof useTaskEditState>;
        const settleAttachmentDraft = vi.fn();
        const onSave = vi.fn()
            .mockResolvedValueOnce({ success: false, error: 'disk full' })
            .mockResolvedValueOnce({ success: true });
        const added = {
            id: 'draft-file',
            kind: 'file' as const,
            title: 'draft.txt',
            uri: 'file:///documents/attachments/draft-file.txt',
            createdAt: '2026-08-27T00:00:00.000Z',
            updatedAt: '2026-08-27T00:00:00.000Z',
        };

        function Probe() {
            state = useTaskEditState({
                onClose: vi.fn(),
                onSave,
                onSaveError: vi.fn(),
                resetCopilotStateRef: { current: vi.fn() },
                settleAttachmentDraft,
                sections: [],
                task,
                tasks: [task],
                visible: true,
            });
            return null;
        }

        renderer.act(() => {
            renderer.create(React.createElement(Probe));
        });
        renderer.act(() => {
            state.setAttachments([added]);
        });

        await renderer.act(async () => {
            expect(await state.draftLifecycle.save()).toBe(false);
        });
        expect(settleAttachmentDraft).not.toHaveBeenCalled();

        await renderer.act(async () => {
            expect(await state.draftLifecycle.save()).toBe(true);
        });
        expect(settleAttachmentDraft).toHaveBeenCalledWith({
            baselineAttachments: undefined,
            draftAttachments: [added],
            committedAttachments: [added],
        });
    });

    it('settles attachment files only after the optimistic task write is durable', async () => {
        let state!: ReturnType<typeof useTaskEditState>;
        const settleAttachmentDraft = vi.fn();
        const onClose = vi.fn();
        let resolveDurability!: () => void;
        flushPendingSaveMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
            resolveDurability = resolve;
        }));
        const added = {
            id: 'draft-file',
            kind: 'file' as const,
            title: 'draft.txt',
            uri: 'file:///documents/attachments/draft-file.txt',
            createdAt: '2026-08-27T00:00:00.000Z',
            updatedAt: '2026-08-27T00:00:00.000Z',
        };

        function Probe() {
            state = useTaskEditState({
                onClose,
                onSave: vi.fn().mockResolvedValue({ success: true }),
                onSaveError: vi.fn(),
                resetCopilotStateRef: { current: vi.fn() },
                settleAttachmentDraft,
                sections: [],
                task,
                tasks: [task],
                visible: true,
            });
            return null;
        }

        renderer.act(() => {
            renderer.create(React.createElement(Probe));
        });
        renderer.act(() => state.setAttachments([added]));

        let save!: Promise<boolean>;
        await renderer.act(async () => {
            save = state.draftLifecycle.save();
            await Promise.resolve();
        });
        expect(settleAttachmentDraft).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();

        resolveDurability();
        await renderer.act(async () => {
            expect(await save).toBe(true);
        });
        expect(settleAttachmentDraft).toHaveBeenCalledOnce();
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('preserves all attachment files when the durability barrier fails', async () => {
        let state!: ReturnType<typeof useTaskEditState>;
        const settleAttachmentDraft = vi.fn();
        const onClose = vi.fn();
        const onSaveError = vi.fn();
        flushPendingSaveMock.mockRejectedValueOnce(new Error('sqlite unavailable'));

        function Probe() {
            state = useTaskEditState({
                onClose,
                onSave: vi.fn().mockResolvedValue({ success: true }),
                onSaveError,
                resetCopilotStateRef: { current: vi.fn() },
                settleAttachmentDraft,
                sections: [],
                task,
                tasks: [task],
                visible: true,
            });
            return null;
        }

        renderer.act(() => {
            renderer.create(React.createElement(Probe));
        });
        renderer.act(() => state.setAttachments([{
            id: 'draft-file',
            kind: 'file',
            title: 'draft.txt',
            uri: 'file:///documents/attachments/draft-file.txt',
            createdAt: '2026-08-27T00:00:00.000Z',
            updatedAt: '2026-08-27T00:00:00.000Z',
        }]));

        await renderer.act(async () => {
            expect(await state.draftLifecycle.save()).toBe(false);
        });
        expect(onSaveError).toHaveBeenCalledWith('sqlite unavailable');
        expect(settleAttachmentDraft).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();

        renderer.act(() => state.draftLifecycle.discard());
        expect(settleAttachmentDraft).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('settles a copied attachment against the baseline when the editor unmounts', () => {
        let state!: ReturnType<typeof useTaskEditState>;
        const settleAttachmentDraft = vi.fn();

        function Probe() {
            state = useTaskEditState({
                onClose: vi.fn(),
                onSave: vi.fn(),
                onSaveError: vi.fn(),
                resetCopilotStateRef: { current: vi.fn() },
                settleAttachmentDraft,
                sections: [],
                task,
                tasks: [task],
                visible: true,
            });
            return null;
        }

        let tree!: renderer.ReactTestRenderer;
        renderer.act(() => {
            tree = renderer.create(React.createElement(Probe));
        });
        const added = {
            id: 'unmounted-draft',
            kind: 'file' as const,
            title: 'draft.txt',
            uri: 'file:///documents/attachments/unmounted-draft.txt',
            createdAt: '2026-08-27T00:00:00.000Z',
            updatedAt: '2026-08-27T00:00:00.000Z',
        };
        renderer.act(() => state.setAttachments([added]));
        renderer.act(() => tree.unmount());

        expect(settleAttachmentDraft).toHaveBeenCalledWith({
            baselineAttachments: undefined,
            draftAttachments: [added],
            committedAttachments: undefined,
        });
    });
});
