import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTaskDraft, type Attachment, type Task, type TaskDraft } from '@mindwtr/core';

import { AUTOSAVE_TEXT_MAX_WAIT_MS, isTextEntryElement, useTaskItemAutosave } from './useTaskItemAutosave';
import type { IncrementalSaveSession, TaskItemSubmitResult } from './useTaskItemSubmit';

const flushPendingSaveMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock('@mindwtr/core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@mindwtr/core')>();
    return { ...actual, flushPendingSave: flushPendingSaveMock };
});

const task: Task = {
    id: 'task-1',
    title: 'A',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
};

const draftWith = (title: string): TaskDraft => createTaskDraft({ ...task, title });

type Props = { enabled?: boolean; title?: string; isImportingFiles?: boolean; editAttachments?: Attachment[] };

const createSession = (): IncrementalSaveSession => ({
    baselineTask: task,
    base: { draft: createTaskDraft(task), rawAttachments: undefined, preparedAttachments: undefined },
    tail: Promise.resolve(),
});

const setup = (initialProps: Props = {}, saveResult: TaskItemSubmitResult = { success: true, outcome: 'saved' }) => {
    const sessionRef = { current: createSession() as IncrementalSaveSession | null };
    const form = document.createElement('form');
    const input = document.createElement('input');
    const button = document.createElement('button');
    form.append(input, button);
    document.body.append(form);
    const formRef = { current: form as HTMLElement | null };
    const drafts = new Map<string, TaskDraft>();
    const draftFor = (title: string) => {
        if (!drafts.has(title)) drafts.set(title, draftWith(title));
        return drafts.get(title)!;
    };
    let current: Required<Pick<Props, 'title'>> & Props = { title: task.title, ...initialProps };
    const save = vi.fn(async (): Promise<TaskItemSubmitResult> => {
        if (saveResult?.outcome === 'saved' && sessionRef.current) {
            sessionRef.current.base = { ...sessionRef.current.base, draft: draftWith(current.title) };
        }
        return saveResult;
    });
    const hook = renderHook((props: Props) => {
        current = { title: task.title, ...props };
        return useTaskItemAutosave({
            enabled: props.enabled ?? true,
            draft: draftFor(props.title ?? task.title),
            editAttachments: props.editAttachments,
            isImportingFiles: props.isImportingFiles ?? false,
            baselineTask: task,
            sessionRef,
            save,
            formRef,
        });
    }, { initialProps: { enabled: true, ...initialProps } });
    const edit = (props: Props) => hook.rerender({ enabled: true, ...props });
    return { ...hook, save, sessionRef, form, input, button, edit };
};

describe('isTextEntryElement', () => {
    it('treats typed inputs, textareas and contenteditable as text entry', () => {
        const date = document.createElement('input');
        date.type = 'date';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        const editable = document.createElement('div');
        editable.setAttribute('contenteditable', '');
        const notEditable = document.createElement('div');
        notEditable.setAttribute('contenteditable', 'false');
        expect(isTextEntryElement(date)).toBe(true);
        expect(isTextEntryElement(checkbox)).toBe(false);
        expect(isTextEntryElement(document.createElement('textarea'))).toBe(true);
        expect(isTextEntryElement(editable)).toBe(true);
        expect(isTextEntryElement(notEditable)).toBe(false);
        expect(isTextEntryElement(document.createElement('button'))).toBe(false);
        expect(isTextEntryElement(null)).toBe(false);
    });
});

describe('useTaskItemAutosave', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        flushPendingSaveMock.mockReset();
        flushPendingSaveMock.mockResolvedValue(undefined);
    });
    afterEach(() => {
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    it('saves a discrete edit on the next tick', async () => {
        const { save, button, edit } = setup();
        button.focus();
        edit({ title: 'B' });
        expect(save).not.toHaveBeenCalled();
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(save).toHaveBeenCalledOnce();
    });

    it('saves typing after 800 ms of quiet', async () => {
        const { save, input, edit } = setup();
        input.focus();
        edit({ title: 'B' });
        await act(async () => { await vi.advanceTimersByTimeAsync(799); });
        expect(save).not.toHaveBeenCalled();
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        expect(save).toHaveBeenCalledOnce();
    });

    it('saves continuous typing no later than 3000 ms after the first edit', async () => {
        const { save, input, edit } = setup();
        input.focus();
        for (let i = 1; i <= 6; i += 1) {
            edit({ title: `B${i}` });
            await act(async () => { await vi.advanceTimersByTimeAsync(500); });
        }
        expect(save).toHaveBeenCalledOnce();
    });

    it('saves at once when focus leaves a text field in the form', async () => {
        const { save, input, button, edit } = setup();
        input.focus();
        edit({ title: 'B' });
        await act(async () => { button.focus(); });
        expect(save).toHaveBeenCalledOnce();
    });

    it('treats a cleared title as unchanged since the last save', async () => {
        const { save, input, edit, result } = setup();
        input.focus();
        edit({ title: 'B' });
        await act(async () => { await vi.advanceTimersByTimeAsync(AUTOSAVE_TEXT_MAX_WAIT_MS); });
        expect(save).toHaveBeenCalledOnce();
        edit({ title: '  ' });
        expect(result.current.isDirty()).toBe(false);
        await act(async () => { await vi.advanceTimersByTimeAsync(AUTOSAVE_TEXT_MAX_WAIT_MS); });
        expect(save).toHaveBeenCalledOnce();
    });

    it('defers saving while files import and saves when the import ends', async () => {
        const { save, button, edit } = setup();
        button.focus();
        edit({ title: 'B', isImportingFiles: true });
        await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
        expect(save).not.toHaveBeenCalled();
        edit({ title: 'B', isImportingFiles: false });
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(save).toHaveBeenCalledOnce();
    });

    it('saves again after an edit made while a save was running', async () => {
        const { save, button, edit } = setup();
        let finish!: () => void;
        save.mockImplementationOnce(() => new Promise<TaskItemSubmitResult>((resolve) => {
            finish = () => resolve({ success: true, outcome: 'saved' });
        }));
        button.focus();
        edit({ title: 'B' });
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        edit({ title: 'C' });
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(save).toHaveBeenCalledOnce();
        await act(async () => { finish(); await vi.advanceTimersByTimeAsync(0); });
        expect(save).toHaveBeenCalledTimes(2);
    });

    it('does not retry a failed save until the next edit', async () => {
        const { save, input, button, edit } = setup({}, { success: false, error: 'nope', outcome: 'failed' });
        input.focus();
        edit({ title: 'B' });
        await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
        expect(save).toHaveBeenCalledOnce();
        await act(async () => { button.focus(); await vi.advanceTimersByTimeAsync(10000); });
        expect(save).toHaveBeenCalledOnce();
        edit({ title: 'C' });
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(save).toHaveBeenCalledTimes(2);
    });

    it('does not save on the first render of a session', async () => {
        const { save, rerender } = setup({ enabled: false, title: 'B' });
        rerender({ enabled: true, title: 'B' });
        await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
        expect(save).not.toHaveBeenCalled();
    });

    describe('flush', () => {
        it('flushes persistence without saving a clean draft', async () => {
            const { result, save } = setup();
            let outcome: string | undefined;
            await act(async () => { outcome = await result.current.flush(); });
            expect(outcome).toBe('clean');
            expect(save).not.toHaveBeenCalled();
            expect(flushPendingSaveMock).toHaveBeenCalledOnce();
        });

        it('saves a dirty draft before flushing persistence', async () => {
            const { result, save, input, edit } = setup();
            input.focus();
            edit({ title: 'B' });
            let outcome: string | undefined;
            await act(async () => { outcome = await result.current.flush(); });
            expect(outcome).toBe('saved');
            expect(save).toHaveBeenCalledOnce();
            expect(save.mock.invocationCallOrder[0]).toBeLessThan(flushPendingSaveMock.mock.invocationCallOrder[0]);
            await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
            expect(save).toHaveBeenCalledOnce();
        });

        it('reports failed when persistence fails', async () => {
            flushPendingSaveMock.mockRejectedValueOnce(new Error('disk'));
            const { result } = setup();
            let outcome: string | undefined;
            await act(async () => { outcome = await result.current.flush(); });
            expect(outcome).toBe('failed');
        });

        it('reports failed when the save fails', async () => {
            const { result, edit } = setup({}, { success: false, error: 'nope', outcome: 'failed' });
            edit({ title: 'B' });
            let outcome: string | undefined;
            await act(async () => { outcome = await result.current.flush(); });
            expect(outcome).toBe('failed');
        });

        it('reports blocked while files import', async () => {
            const { result, save } = setup({ title: 'B', isImportingFiles: true });
            let outcome: string | undefined;
            await act(async () => { outcome = await result.current.flush(); });
            expect(outcome).toBe('blocked');
            expect(save).not.toHaveBeenCalled();
        });

        it('only flushes persistence without a session', async () => {
            const { result, save, sessionRef } = setup({ title: 'B' });
            sessionRef.current = null;
            let outcome: string | undefined;
            await act(async () => { outcome = await result.current.flush(); });
            expect(outcome).toBe('clean');
            expect(save).not.toHaveBeenCalled();
            expect(flushPendingSaveMock).toHaveBeenCalledOnce();
        });

        it('waits for the queued save before writing what is left', async () => {
            const { result, save, sessionRef } = setup();
            const session = sessionRef.current!;
            let finishB!: () => void;
            session.tail = new Promise<void>((resolve) => { finishB = resolve; }).then(() => {
                session.base = { ...session.base, draft: draftWith('B') };
            });
            expect(result.current.isDirty()).toBe(false);
            let outcome: string | undefined;
            let settled = false;
            let flushing!: Promise<void>;
            act(() => { flushing = result.current.flush().then((value) => { outcome = value; settled = true; }); });
            await act(async () => { await vi.advanceTimersByTimeAsync(0); });
            expect(settled).toBe(false);
            expect(save).not.toHaveBeenCalled();
            await act(async () => { finishB(); await flushing; });
            expect(save).toHaveBeenCalledOnce();
            expect(save.mock.invocationCallOrder[0]).toBeLessThan(flushPendingSaveMock.mock.invocationCallOrder[0]);
            expect(outcome).toBe('saved');
        });
    });

    it('saves unsaved edits without waiting when the row unmounts', async () => {
        const { save, input, edit, unmount } = setup();
        input.focus();
        edit({ title: 'B' });
        save.mockImplementationOnce(() => new Promise<TaskItemSubmitResult>(() => {}));
        unmount();
        expect(save).toHaveBeenCalledOnce();
        await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
        expect(save).toHaveBeenCalledOnce();
    });

    it('saves unsaved edits when the session ends without unmounting', async () => {
        const { save, input, edit, rerender } = setup();
        input.focus();
        edit({ title: 'B' });
        rerender({ enabled: false, title: 'B' });
        expect(save).toHaveBeenCalledOnce();
        await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
        expect(save).toHaveBeenCalledOnce();
    });

    it('does not save on unmount when nothing is unsaved', async () => {
        const { save, unmount } = setup();
        unmount();
        expect(save).not.toHaveBeenCalled();
    });
});
