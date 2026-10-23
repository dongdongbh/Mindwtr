import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTaskDraft, useTaskStore, type Attachment, type Task } from '@mindwtr/core';

import { useTaskItemSubmit } from './useTaskItemSubmit';
import { holdSyncSave } from '../../test/hold-sync-save';

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

const initialTaskState = useTaskStore.getState();
/** The editor saves through the store: [stored] is the row it finds, [updateTask] the store write it reaches. */
const seedStore = (stored: Task, updateTask = vi.fn().mockResolvedValue({ success: true })) => {
    useTaskStore.setState({ _allTasks: [stored], updateTask });
    return updateTask;
};

describe('useTaskItemSubmit attachment durability', () => {
    beforeEach(() => {
        flushPendingSaveMock.mockReset();
        flushPendingSaveMock.mockResolvedValue(undefined);
    });
    afterEach(() => {
        useTaskStore.setState(initialTaskState, true);
    });

    it('serializes browser preparation and saves intervening typing after upload', async () => {
        let finish!: (attachments: Attachment[]) => void;
        const prepareAttachmentsForSave = vi.fn(() => new Promise<Attachment[]>((resolve) => { finish = resolve; }));
        const retainWebAttachmentsBeforeStore = vi.fn();
        const updateTask = seedStore(task);
        const attachment: Attachment = { id: 'upload', kind: 'file', title: 'report.pdf', uri: '', createdAt: task.createdAt, updatedAt: task.updatedAt };
        const params = {
            baselineTask: task, task, editAttachments: [attachment], editingTaskId: task.id,
            setEditingTaskId: vi.fn(), setIsEditing: vi.fn(), showToast: vi.fn(), t: (key: string) => key,
            beginAttachmentSave: vi.fn(() => true), cancelAttachmentSaveBeforeStoreUpdate: vi.fn(),
            settlePersistedAttachmentSave: vi.fn(), prepareAttachmentsForSave, retainWebAttachmentsBeforeStore,
        };
        const { result, rerender } = renderHook(({ title }) => useTaskItemSubmit({ ...params, draft: createTaskDraft({ ...task, title }) }),
            { initialProps: { title: 'Before upload' } });
        let first!: ReturnType<typeof result.current>;
        act(() => { first = result.current(); });
        expect(result.current()).toBe(first);
        expect(updateTask).not.toHaveBeenCalled();
        rerender({ title: 'Continued typing' });
        await act(async () => { finish([{ ...attachment, cloudKey: 'attachments/upload.pdf' }]); await first; });
        expect(updateTask).toHaveBeenCalledOnce();
        expect(updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({ title: 'Continued typing', attachments: [expect.objectContaining({ cloudKey: 'attachments/upload.pdf' })] }));
        expect(retainWebAttachmentsBeforeStore.mock.invocationCallOrder[0]).toBeLessThan(updateTask.mock.invocationCallOrder[0]);
    });

    it('blocks metadata publication on failed browser preparation', async () => {
        const updateTask = seedStore(task);
        const setAttachmentError = vi.fn();
        const { result } = renderHook(() => useTaskItemSubmit({
            baselineTask: task, task, draft: createTaskDraft({ ...task, title: 'Keep draft' }), editAttachments: [], editingTaskId: task.id,
            setEditingTaskId: vi.fn(), setIsEditing: vi.fn(), showToast: vi.fn(), t: (key) => key,
            beginAttachmentSave: vi.fn(), cancelAttachmentSaveBeforeStoreUpdate: vi.fn(), settlePersistedAttachmentSave: vi.fn(),
            prepareAttachmentsForSave: async () => { throw new Error('offline'); }, setAttachmentError,
        }));
        await act(async () => { await result.current(); });
        expect(updateTask).not.toHaveBeenCalled();
        expect(setAttachmentError).toHaveBeenCalledWith(expect.stringContaining('attachments.webUploadRetry'));
    });

    it('rejects a discarded draft while its save waits behind a sync writer', async () => {
        const updateTask = seedStore(task);
        let generation = 0;
        const setAttachmentError = vi.fn();
        const finish = holdSyncSave(() => undefined);
        const { result } = renderHook(() => useTaskItemSubmit({
            baselineTask: task, task, draft: createTaskDraft({ ...task, title: 'Old draft' }), editAttachments: [], editingTaskId: task.id,
            setEditingTaskId: vi.fn(), setIsEditing: vi.fn(), showToast: vi.fn(), t: (key) => key,
            beginAttachmentSave: vi.fn(), cancelAttachmentSaveBeforeStoreUpdate: vi.fn(), settlePersistedAttachmentSave: vi.fn(),
            getAttachmentDraftGeneration: () => generation, setAttachmentError,
        }));
        let pending!: ReturnType<typeof result.current>;
        await act(async () => { pending = result.current(); await Promise.resolve(); });
        generation += 1;
        await act(async () => { await finish(); await pending; });
        expect(updateTask).not.toHaveBeenCalled();
        expect(setAttachmentError).not.toHaveBeenCalled();
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
        seedStore(task);
        const { result } = renderHook(() => useTaskItemSubmit({
            baselineTask: task,
            draft,
            editAttachments,
            editingTaskId: task.id,
            setEditingTaskId: vi.fn(),
            setIsEditing,
            showToast: vi.fn(),
            t: (key) => key,
            task,
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
        seedStore(task);
        const { result } = renderHook(() => useTaskItemSubmit({
            baselineTask: task,
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

    it('does not submit untouched fields changed after the edit session opened', async () => {
        const baselineTask: Task = {
            ...task,
            description: 'Opening description',
            tags: ['#opening'],
        };
        const liveTask: Task = {
            ...baselineTask,
            description: 'Concurrent description',
            tags: ['#concurrent'],
            updatedAt: '2026-08-27T01:00:00.000Z',
        };
        const draft = createTaskDraft(baselineTask);
        draft.title = 'Edited title';
        const updateTask = seedStore(liveTask);
        const { result } = renderHook(() => useTaskItemSubmit({
            baselineTask,
            draft,
            editAttachments: baselineTask.attachments,
            editingTaskId: task.id,
            setEditingTaskId: vi.fn(),
            setIsEditing: vi.fn(),
            showToast: vi.fn(),
            t: (key) => key,
            task: liveTask,
            beginAttachmentSave: vi.fn(() => false),
            cancelAttachmentSaveBeforeStoreUpdate: vi.fn(),
            settlePersistedAttachmentSave: vi.fn(),
        }));

        await act(async () => {
            await result.current();
        });

        expect(updateTask).toHaveBeenCalledWith(task.id, { title: 'Edited title' });
    });

    it('keeps a relative start when the editor saves a new due date', async () => {
        const offset = { amount: -3, unit: 'day' } as Task['relativeStartOffset'];
        const opened: Task = { ...task, rev: 1, dueDate: '2026-10-20', startTime: '2026-10-17', relativeStartOffset: offset };
        useTaskStore.setState({ _allTasks: [opened] });
        const { result } = renderHook(() => useTaskItemSubmit({
            baselineTask: opened,
            // The editor moves the start with the due date, as its relative start says.
            draft: createTaskDraft({ ...opened, dueDate: '2026-10-25', startTime: '2026-10-22' }),
            editAttachments: undefined,
            editingTaskId: task.id,
            setEditingTaskId: vi.fn(),
            setIsEditing: vi.fn(),
            showToast: vi.fn(),
            t: (key) => key,
            task: opened,
            beginAttachmentSave: vi.fn(() => false),
            cancelAttachmentSaveBeforeStoreUpdate: vi.fn(),
            settlePersistedAttachmentSave: vi.fn(),
        }));
        await act(async () => { await result.current(); });
        expect(useTaskStore.getState()._tasksById.get(task.id)).toMatchObject({ dueDate: '2026-10-25', relativeStartOffset: offset });
    });

    describe('behind a sync save', () => {
        const file = (id: string): Attachment => ({
            id, kind: 'file', title: `${id}.pdf`, uri: `/data/attachments/${id}.pdf`,
            createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z',
        });
        const opened: Task = { ...task, rev: 1, attachments: [file('A')] };
        const submitHook = (draftTask: Partial<Task>, editAttachments = opened.attachments, showToast = vi.fn()) => {
            const draft = createTaskDraft({ ...opened, ...draftTask });
            return renderHook((props: { draft: typeof draft }) => useTaskItemSubmit({
                baselineTask: opened,
                draft: props.draft,
                editAttachments,
                editingTaskId: task.id,
                setEditingTaskId: vi.fn(),
                setIsEditing: vi.fn(),
                showToast,
                t: (key) => key,
                task: opened,
                beginAttachmentSave: vi.fn(() => false),
                cancelAttachmentSaveBeforeStoreUpdate: vi.fn(),
                settlePersistedAttachmentSave: vi.fn(),
            }), { initialProps: { draft } });
        };
        const submitBehind = async (submit: () => Promise<unknown>, published: Partial<Task>) => {
            const finish = holdSyncSave(() => useTaskStore.setState({ _allTasks: [{ ...opened, rev: 3, ...published }] }));
            let outcome: unknown;
            await act(async () => {
                const saving = submit();
                await finish();
                outcome = await saving;
            });
            return outcome;
        };

        it('merges the draft attachment onto the attachments a sync save published, keeping the synced sibling', async () => {
            useTaskStore.setState({ _allTasks: [opened] });
            const { result } = submitHook({}, [file('A'), file('D')]);
            await submitBehind(() => result.current(), { attachments: [file('A'), file('B')] });
            expect(useTaskStore.getState()._tasksById.get(task.id)?.attachments?.map((item) => item.id)).toEqual(['A', 'B', 'D']);
        });

        it('writes a field another device changed since the editor opened as the draft holds it, as before the gate', async () => {
            useTaskStore.setState({ _allTasks: [opened] });
            const { result } = submitHook({ title: 'Draft title' });
            const outcome = await submitBehind(() => result.current(), { title: 'Remote title' });
            expect(outcome).toMatchObject({ success: true });
            expect(useTaskStore.getState()._tasksById.get(task.id)?.title).toBe('Draft title');
        });

        it('keeps the tombstone of an attachment another device deleted while the draft edited it', async () => {
            useTaskStore.setState({ _allTasks: [opened] });
            const { result } = submitHook({}, [{ ...file('A'), title: 'Renamed.pdf' }]);
            await submitBehind(() => result.current(), { attachments: [{ ...file('A'), deletedAt: '2026-08-28T00:00:00.000Z' }] });
            expect(useTaskStore.getState()._tasksById.get(task.id)?.attachments?.[0]?.deletedAt).toBe('2026-08-28T00:00:00.000Z');
        });

        it('writes only the fields the draft changed, merging tags onto the tags a sync save published', async () => {
            useTaskStore.setState({ _allTasks: [{ ...opened, tags: ['#a'] }] });
            const { result } = renderHook(() => useTaskItemSubmit({
                baselineTask: { ...opened, tags: ['#a'] },
                draft: createTaskDraft({ ...opened, title: 'Draft title', tags: ['#a', '#mine'] }),
                editAttachments: opened.attachments,
                editingTaskId: task.id,
                setEditingTaskId: vi.fn(),
                setIsEditing: vi.fn(),
                showToast: vi.fn(),
                t: (key) => key,
                task: opened,
                beginAttachmentSave: vi.fn(() => false),
                cancelAttachmentSaveBeforeStoreUpdate: vi.fn(),
                settlePersistedAttachmentSave: vi.fn(),
            }));
            await submitBehind(() => result.current(), { tags: ['#a', '#remote'], description: 'Remote note' });
            expect(useTaskStore.getState()._tasksById.get(task.id)).toMatchObject({
                title: 'Draft title', tags: ['#a', '#remote', '#mine'], description: 'Remote note',
            });
        });

        it('keeps a reminder policy another device changed when the draft left it as opened', async () => {
            const withPolicy: Task = { ...opened, reminderPolicy: 'send' };
            useTaskStore.setState({ _allTasks: [withPolicy] });
            const { result } = renderHook(() => useTaskItemSubmit({
                baselineTask: withPolicy,
                draft: createTaskDraft({ ...withPolicy, title: 'Draft title' }),
                editAttachments: opened.attachments,
                editingTaskId: task.id,
                setEditingTaskId: vi.fn(),
                setIsEditing: vi.fn(),
                showToast: vi.fn(),
                t: (key) => key,
                task: withPolicy,
                beginAttachmentSave: vi.fn(() => false),
                cancelAttachmentSaveBeforeStoreUpdate: vi.fn(),
                settlePersistedAttachmentSave: vi.fn(),
            }));
            await submitBehind(() => result.current(), { reminderPolicy: 'skip' });
            expect(useTaskStore.getState()._tasksById.get(task.id)).toMatchObject({ title: 'Draft title', reminderPolicy: 'skip' });
        });

        it('takes its own earlier save as the base, so a second save merges its attachments against it', async () => {
            useTaskStore.setState({ _allTasks: [opened] });
            const { result, rerender } = submitHook({ title: 'First' });
            await act(async () => { await result.current(undefined, { keepEditing: true }); });
            rerender({ draft: createTaskDraft({ ...opened, title: 'Second' }) });
            let outcome: unknown;
            await act(async () => { outcome = await result.current(undefined, { keepEditing: true }); });
            expect(outcome).toMatchObject({ success: true });
            expect(useTaskStore.getState()._tasksById.get(task.id)?.title).toBe('Second');
        });
    });
});
