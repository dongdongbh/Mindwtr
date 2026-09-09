import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@mindwtr/core';

import { useTaskEditState } from './use-task-edit-state';

const flushPendingSaveMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const logInfoMock = vi.hoisted(() => vi.fn(() => Promise.resolve(null)));

vi.mock('@mindwtr/core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@mindwtr/core')>();
    return { ...actual, flushPendingSave: flushPendingSaveMock };
});
vi.mock('../../lib/app-log', () => ({ logInfo: logInfoMock }));

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
        logInfoMock.mockReset();
        logInfoMock.mockResolvedValue(null);
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

    it('preserves the complete draft in one cancellation write without completing a recurring task', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-09T14:30:00.000Z'));
        const recurringTask: Task = {
            ...task,
            description: 'Original notes',
            recurrence: { rule: 'daily', strategy: 'strict' },
            checklist: [{ id: 'step-1', title: 'Close venue', isCompleted: false }],
        };
        const added = {
            id: 'draft-file',
            kind: 'file' as const,
            title: 'reason.txt',
            uri: 'file:///documents/attachments/draft-file.txt',
            createdAt: '2026-09-09T14:00:00.000Z',
            updatedAt: '2026-09-09T14:00:00.000Z',
        };
        let state!: ReturnType<typeof useTaskEditState>;
        const onSave = vi.fn().mockResolvedValue({ success: true });
        const onClose = vi.fn();

        function Probe() {
            state = useTaskEditState({
                onClose,
                onSave,
                onSaveError: vi.fn(),
                resetCopilotStateRef: { current: vi.fn() },
                sections: [],
                task: recurringTask,
                tasks: [recurringTask],
                visible: true,
            });
            return null;
        }

        try {
            renderer.act(() => {
                renderer.create(React.createElement(Probe));
            });
            renderer.act(() => {
                state.titleDraftRef.current = 'Cancel launch';
                state.descriptionDraftRef.current = 'Cancelled because the venue closed';
                state.setDraftField('title', 'Cancel launch');
                state.setDraftField('description', 'Cancelled because the venue closed');
                state.setAttachments([added]);
                state.setChecklist([{ id: 'step-1', title: 'Close venue', isCompleted: true }]);
                state.setDraftField('status', 'done');
                state.setDraftField('completedAt', '2026-09-09T14:20:00.000Z');
            });

            await renderer.act(async () => {
                expect(await state.draftLifecycle.cancel()).toBe(true);
            });

            expect(onSave).toHaveBeenCalledOnce();
            expect(onSave).toHaveBeenCalledWith('task-1', expect.objectContaining({
                title: 'Cancel launch',
                description: 'Cancelled because the venue closed',
                attachments: [added],
                checklist: [{ id: 'step-1', title: 'Close venue', isCompleted: true }],
                status: 'archived',
                cancelledAt: '2026-09-09T14:30:00.000Z',
                completedAt: undefined,
            }));
            expect(flushPendingSaveMock).toHaveBeenCalledOnce();
            expect(logInfoMock).toHaveBeenCalledWith(
                'Mobile task cancellation draft saved',
                {
                    scope: 'task-edit',
                    extra: {
                        releaseCheck: 'v1.3.0/mobile-cancel-draft',
                        outcome: 'cancelled',
                    },
                },
            );
            expect(onClose).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it('writes a cancellation-only patch for an otherwise unchanged valid draft', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-09T15:00:00.000Z'));
        let state!: ReturnType<typeof useTaskEditState>;
        const onSave = vi.fn().mockResolvedValue({ success: true });

        function Probe() {
            state = useTaskEditState({
                onClose: vi.fn(),
                onSave,
                onSaveError: vi.fn(),
                resetCopilotStateRef: { current: vi.fn() },
                sections: [],
                task,
                tasks: [task],
                visible: true,
            });
            return null;
        }

        try {
            renderer.act(() => {
                renderer.create(React.createElement(Probe));
            });
            await renderer.act(async () => {
                expect(await state.draftLifecycle.cancel()).toBe(true);
            });

            expect(onSave).toHaveBeenCalledWith('task-1', {
                status: 'archived',
                cancelledAt: '2026-09-09T15:00:00.000Z',
                completedAt: undefined,
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('rejects cancellation when the normal draft patch is invalid', async () => {
        const invalidTask: Task = { ...task, title: '' };
        let state!: ReturnType<typeof useTaskEditState>;
        const onSave = vi.fn();
        const onClose = vi.fn();

        function Probe() {
            state = useTaskEditState({
                onClose,
                onSave,
                onSaveError: vi.fn(),
                resetCopilotStateRef: { current: vi.fn() },
                sections: [],
                task: invalidTask,
                tasks: [invalidTask],
                visible: true,
            });
            return null;
        }

        renderer.act(() => {
            renderer.create(React.createElement(Probe));
        });
        await renderer.act(async () => {
            expect(await state.draftLifecycle.cancel()).toBe(false);
        });

        expect(onSave).not.toHaveBeenCalled();
        expect(flushPendingSaveMock).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
    });

    it('keeps the cancellation draft and copied file after a rejected write so both can retry', async () => {
        const added = {
            id: 'draft-file',
            kind: 'file' as const,
            title: 'reason.txt',
            uri: 'file:///documents/attachments/draft-file.txt',
            createdAt: '2026-09-09T14:00:00.000Z',
            updatedAt: '2026-09-09T14:00:00.000Z',
        };
        let state!: ReturnType<typeof useTaskEditState>;
        const onSave = vi.fn()
            .mockResolvedValueOnce({ success: false, error: 'disk full' })
            .mockResolvedValueOnce({ success: true });
        const onSaveError = vi.fn();
        const onClose = vi.fn();
        const settleAttachmentDraft = vi.fn();

        function Probe() {
            state = useTaskEditState({
                onClose,
                onSave,
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
        renderer.act(() => state.setAttachments([added]));

        await renderer.act(async () => {
            expect(await state.draftLifecycle.cancel()).toBe(false);
        });
        expect(state.taskEditDraft?.attachments).toEqual([added]);
        expect(onSaveError).toHaveBeenCalledWith('disk full');
        expect(settleAttachmentDraft).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        expect(logInfoMock).not.toHaveBeenCalled();

        await renderer.act(async () => {
            expect(await state.draftLifecycle.cancel()).toBe(true);
        });
        expect(onSave).toHaveBeenCalledTimes(2);
        expect(settleAttachmentDraft).toHaveBeenCalledWith({
            baselineAttachments: undefined,
            draftAttachments: [added],
            committedAttachments: [added],
        });
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('keeps the cancellation draft and copied file after a failed durability barrier', async () => {
        flushPendingSaveMock
            .mockRejectedValueOnce(new Error('sqlite unavailable'))
            .mockResolvedValueOnce(undefined);
        const added = {
            id: 'draft-file',
            kind: 'file' as const,
            title: 'reason.txt',
            uri: 'file:///documents/attachments/draft-file.txt',
            createdAt: '2026-09-09T14:00:00.000Z',
            updatedAt: '2026-09-09T14:00:00.000Z',
        };
        let state!: ReturnType<typeof useTaskEditState>;
        const onSave = vi.fn().mockResolvedValue({ success: true });
        const onSaveError = vi.fn();
        const onClose = vi.fn();
        const settleAttachmentDraft = vi.fn();

        function Probe() {
            state = useTaskEditState({
                onClose,
                onSave,
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
        renderer.act(() => state.setAttachments([added]));

        await renderer.act(async () => {
            expect(await state.draftLifecycle.cancel()).toBe(false);
        });
        expect(state.taskEditDraft?.attachments).toEqual([added]);
        expect(onSaveError).toHaveBeenCalledWith('sqlite unavailable');
        expect(settleAttachmentDraft).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        expect(logInfoMock).not.toHaveBeenCalled();

        await renderer.act(async () => {
            expect(await state.draftLifecycle.cancel()).toBe(true);
        });
        expect(onSave).toHaveBeenCalledTimes(2);
        expect(flushPendingSaveMock).toHaveBeenCalledTimes(2);
        expect(settleAttachmentDraft).toHaveBeenCalledWith({
            baselineAttachments: undefined,
            draftAttachments: [added],
            committedAttachments: [added],
        });
        expect(logInfoMock).toHaveBeenCalledOnce();
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

    it('retries a failed attachment durability barrier even after the optimistic task becomes the baseline', async () => {
        let state!: ReturnType<typeof useTaskEditState>;
        let currentTask = task;
        let visible = true;
        const settleAttachmentDraft = vi.fn();
        const onClose = vi.fn();
        const onSave = vi.fn().mockResolvedValue({ success: true });
        const resetCopilotStateRef = { current: vi.fn() };
        const added = {
            id: 'draft-file',
            kind: 'file' as const,
            title: 'draft.txt',
            uri: 'file:///documents/attachments/draft-file.txt',
            createdAt: '2026-08-27T00:00:00.000Z',
            updatedAt: '2026-08-27T00:00:00.000Z',
        };
        let resolveRetry!: () => void;
        flushPendingSaveMock
            .mockRejectedValueOnce(new Error('sqlite unavailable'))
            .mockImplementationOnce(() => new Promise<void>((resolve) => {
                resolveRetry = resolve;
            }));

        function Probe() {
            state = useTaskEditState({
                onClose,
                onSave,
                onSaveError: vi.fn(),
                resetCopilotStateRef,
                settleAttachmentDraft,
                sections: [],
                task: currentTask,
                tasks: [currentTask],
                visible,
            });
            return null;
        }

        let tree!: renderer.ReactTestRenderer;
        renderer.act(() => {
            tree = renderer.create(React.createElement(Probe));
        });
        renderer.act(() => state.setAttachments([added]));
        await renderer.act(async () => {
            expect(await state.draftLifecycle.save()).toBe(false);
        });

        currentTask = {
            ...task,
            attachments: [added],
            updatedAt: '2026-08-27T00:00:01.000Z',
        };
        visible = false;
        renderer.act(() => tree.update(React.createElement(Probe)));
        visible = true;
        renderer.act(() => tree.update(React.createElement(Probe)));

        let retry!: Promise<boolean>;
        renderer.act(() => {
            retry = state.draftLifecycle.save();
        });
        await Promise.resolve();
        expect(onSave).toHaveBeenCalledOnce();
        expect(settleAttachmentDraft).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();

        resolveRetry();
        await renderer.act(async () => {
            expect(await retry).toBe(true);
        });
        expect(settleAttachmentDraft).toHaveBeenCalledWith({
            baselineAttachments: [added],
            draftAttachments: [added],
            committedAttachments: [added],
        });
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
