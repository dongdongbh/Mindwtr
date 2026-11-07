import { useCallback, useEffect, useRef } from 'react';
import {
    flushPendingSave,
    taskDraftToChangedSincePatch,
    type Attachment,
    type Task,
    type TaskDraft,
} from '@mindwtr/core';

import { draftSinceLastSave, type IncrementalSaveSession, type TaskItemSubmitResult } from './useTaskItemSubmit';

export const AUTOSAVE_TEXT_IDLE_MS = 800;
export const AUTOSAVE_TEXT_MAX_WAIT_MS = 3000;
const AUTOSAVE_FLUSH_MAX_ROUNDS = 3;

export type AutosaveFlushOutcome = 'saved' | 'clean' | 'blocked' | 'failed';

const NON_TEXT_INPUT_TYPES = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color']);

export function isTextEntryElement(el: Element | null): boolean {
    if (!el) return false;
    if (el instanceof HTMLTextAreaElement) return true;
    if (el instanceof HTMLInputElement) return !NON_TEXT_INPUT_TYPES.has(el.type);
    const editable = el.getAttribute('contenteditable');
    return editable !== null && editable.toLowerCase() !== 'false';
}

type UseTaskItemAutosaveParams = {
    enabled: boolean;
    draft: TaskDraft;
    editAttachments: Attachment[] | undefined;
    isImportingFiles: boolean;
    baselineTask: Task;
    sessionRef: React.MutableRefObject<IncrementalSaveSession | null>;
    save: () => Promise<TaskItemSubmitResult>;
    formRef: React.RefObject<HTMLElement | null>;
};

type Timers = {
    immediate?: ReturnType<typeof setTimeout>;
    idle?: ReturnType<typeof setTimeout>;
    maxWait?: ReturnType<typeof setTimeout>;
};

export function useTaskItemAutosave({
    enabled,
    draft,
    editAttachments,
    isImportingFiles,
    baselineTask,
    sessionRef,
    save,
    formRef,
}: UseTaskItemAutosaveParams) {
    const latestRef = useRef({ enabled, draft, editAttachments, isImportingFiles, baselineTask, save });
    latestRef.current = { enabled, draft, editAttachments, isImportingFiles, baselineTask, save };
    const timersRef = useRef<Timers>({});
    const savingRef = useRef(false);
    const editedDuringSaveRef = useRef(false);
    const editVersionRef = useRef(0);
    const failedVersionRef = useRef<number | null>(null);
    const seenRef = useRef<{ draft: TaskDraft; editAttachments: Attachment[] | undefined } | null>(null);
    const wasImportingRef = useRef(isImportingFiles);

    const clearTimers = useCallback(() => {
        const timers = timersRef.current;
        clearTimeout(timers.immediate);
        clearTimeout(timers.idle);
        clearTimeout(timers.maxWait);
        timersRef.current = {};
    }, []);

    const isDirty = useCallback(() => {
        const session = sessionRef.current;
        if (!session) return false;
        const latest = latestRef.current;
        return taskDraftToChangedSincePatch(draftSinceLastSave(latest.draft, session.base), session.base.draft, latest.baselineTask, {
            attachments: latest.editAttachments,
            previousAttachments: session.base.rawAttachments,
        }) !== null;
    }, [sessionRef]);

    const scheduleRef = useRef<() => void>(() => {});
    const saveInBackground = useCallback(() => {
        clearTimers();
        const latest = latestRef.current;
        if (!latest.enabled || latest.isImportingFiles) return;
        if (savingRef.current) {
            editedDuringSaveRef.current = true;
            return;
        }
        const version = editVersionRef.current;
        if (failedVersionRef.current === version || !isDirty()) return;
        savingRef.current = true;
        void latest.save()
            .then((result) => result?.outcome === 'failed', () => true)
            .then((failed) => {
                if (failed) failedVersionRef.current = version;
                savingRef.current = false;
                if (!editedDuringSaveRef.current) return;
                editedDuringSaveRef.current = false;
                if (latestRef.current.enabled) scheduleRef.current();
            });
    }, [clearTimers, isDirty]);

    const schedule = useCallback(() => {
        const timers = timersRef.current;
        clearTimeout(timers.immediate);
        clearTimeout(timers.idle);
        if (!isTextEntryElement(document.activeElement)) {
            timers.immediate = setTimeout(saveInBackground, 0);
            return;
        }
        timers.idle = setTimeout(saveInBackground, AUTOSAVE_TEXT_IDLE_MS);
        timers.maxWait ??= setTimeout(saveInBackground, AUTOSAVE_TEXT_MAX_WAIT_MS);
    }, [saveInBackground]);
    scheduleRef.current = schedule;

    useEffect(() => {
        if (!enabled) return;
        return () => {
            clearTimers();
            editedDuringSaveRef.current = false;
            if (isDirty()) void latestRef.current.save().catch(() => undefined);
        };
    }, [enabled, clearTimers, isDirty]);

    useEffect(() => {
        if (!enabled) {
            seenRef.current = null;
            return;
        }
        const seen = seenRef.current;
        seenRef.current = { draft, editAttachments };
        if (!seen || (seen.draft === draft && seen.editAttachments === editAttachments)) return;
        editVersionRef.current += 1;
        schedule();
    }, [enabled, draft, editAttachments, schedule]);

    useEffect(() => {
        const wasImporting = wasImportingRef.current;
        wasImportingRef.current = isImportingFiles;
        if (enabled && wasImporting && !isImportingFiles && isDirty()) schedule();
    }, [enabled, isImportingFiles, isDirty, schedule]);

    useEffect(() => {
        if (!enabled) return;
        const handleFocusOut = (event: FocusEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (!target || !formRef.current?.contains(target) || !isTextEntryElement(target)) return;
            saveInBackground();
        };
        document.addEventListener('focusout', handleFocusOut);
        return () => document.removeEventListener('focusout', handleFocusOut);
    }, [enabled, formRef, saveInBackground]);

    const flush = useCallback(async (): Promise<AutosaveFlushOutcome> => {
        const session = sessionRef.current;
        let wrote = false;
        for (let round = 0; round < AUTOSAVE_FLUSH_MAX_ROUNDS; round += 1) {
            clearTimers();
            if (session) {
                await session.tail.catch(() => undefined);
                if (latestRef.current.isImportingFiles) return 'blocked';
                if (isDirty()) {
                    const result = await latestRef.current.save().catch(() => undefined);
                    if (result?.outcome === 'blocked') return 'blocked';
                    if (!result?.success) return 'failed';
                    wrote ||= result.outcome === 'saved';
                }
            }
            const settled = session?.tail;
            try {
                await flushPendingSave();
            } catch {
                return 'failed';
            }
            if (!session || (session.tail === settled && !isDirty())) {
                return wrote ? 'saved' : 'clean';
            }
        }
        return 'failed';
    }, [clearTimers, isDirty, sessionRef]);

    return { isDirty, flush };
}
