/**
 * RN's completion-time picker (apps/mobile/components/completed-at-picker.tsx) for a host that completes rows through
 * completeTask (native Android), bca5e3e7e. A row completes at a picked time (a long-press on the swipe tray's Done or the
 * status menu's Done), and a finished row's "Completed:" date edits its time. The editor's long-press on Done edits its draft
 * instead (editTaskDraft's backdatedCompletion, which also takes this picker's local day and time). The picker starts where
 * RN's does: now for a row's Done, the stored completion (else the last change) for an edit, the draft's start in the editor.
 * Android shows RN's date dialog, then its time dialog, then, for a Done with Time Spent on (Pomodoro with Link task, RN's
 * timeSpentEnabled), RN's card with the minutes.
 * iOS uses its own prepared coordinators (native-host-contract-task-checklist.ts).
 */
import { getArchiveCompletedAtPickerStart, resolvePickedCompletedAt } from './archive-view-model';
import type { DateFormatter } from './date';
import { tFallback } from './i18n';
import { logInfo } from './logger';
import type { NativeHostResult } from './native-host-contract';
import { fail, isObjectRecord } from './native-host-contract-menu-views';
import { createNativeRequestReceipts, runStoreWrite, settleWrite, taskRevisionOf } from './native-request-receipts';
import { useTaskStore } from './store';
import { getTaskEditorBackdatedCompletionStart } from './task-editor-model';
import { isTaskEditorTimeSpentEnabled, parseTaskEditorTimeSpent } from './task-editor-schedule';
import { isTaskCancelled, isTaskCompleted } from './task-status';
import { normalizeTimeSpentMinutes } from './time-spent';
import type { Task } from './types';

type Translate = (key: string) => string;

/** 'complete': a row's Done at a picked time; 'edit': a finished row's time; 'editor': the open editor's Done (its draft). */
export type NativeCompletedAtPickerMode = 'complete' | 'edit' | 'editor';

export type NativeCompletedAtPicker = {
    mode: NativeCompletedAtPickerMode; taskId: string; taskRevision: string;
    /** The date dialog's day (yyyy-MM-dd) and the time dialog's time (HH:mm). */
    day: string; time: string;
    /** RN's card after the time dialog, only when Time Spent is offered: its words and the minutes it starts with. */
    timeSpent: null | { title: string; label: string; placeholder: string; value: string; cancel: string; save: string };
};

export type NativeTaskCompletedAtRequest = {
    requestId: string; taskId: string; taskRevision: string; mode: 'complete' | 'edit'; day: string; time: string; timeSpentText?: string;
};

const id = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= 500;

/** The picked day and time as RN's card shows them before Save (the app's date format). */
export const formatPickedCompletedAt = (formatDate: DateFormatter, day: string, time: string): string | null => {
    const iso = resolvePickedCompletedAt(day, time);
    return iso ? formatDate(iso, 'Pp', iso) : null;
};

export function createTaskBackdateMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    t: () => Translate;
    formatDate: () => DateFormatter;
    requestIdPattern: RegExp;
}) {
    const receipts = createNativeRequestReceipts({
        save: async () => {
            if (useTaskStore.getState().persistenceFailure) {
                try {
                    await useTaskStore.getState().retryPersistence();
                } catch (error) {
                    return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error));
                }
            }
            return deps.save();
        },
    });
    /** RN's canBackdateCompletion (a row's Done: not done yet) and onEditCompletedAt (a finished, not cancelled row). */
    const offered = (task: Task, mode: 'complete' | 'edit') => (mode === 'complete'
        ? task.status !== 'done' : isTaskCompleted(task) && !isTaskCancelled(task));

    return {
        /**
         * Where the picker starts and whether its Time Spent card shows (RN's showTimeSpent: a Done, with Time Spent on). The
         * editor sends its draft's completedAt and timeSpentMinutes (RN's getTaskEditorBackdatedCompletionStart).
         */
        getCompletedAtPicker(input: {
            taskId: string; mode: NativeCompletedAtPickerMode; draft?: { completedAt?: string | null; timeSpentMinutes?: number | null };
        }): NativeHostResult<{ picker: NativeCompletedAtPicker | null }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !id(input.taskId) || !['complete', 'edit', 'editor'].includes(input.mode as string)
                || (input.draft !== undefined && !isObjectRecord(input.draft))) {
                return fail('INVALID_INPUT', 'A task and a picker mode are required');
            }
            const state = useTaskStore.getState();
            const task = state._tasksById.get(input.taskId);
            if (!task || task.deletedAt) return fail('TASK_NOT_FOUND', 'Task not found');
            const mode = input.mode;
            if (mode !== 'editor' && !offered(task, mode)) return { ok: true, value: { picker: null } };
            const formatDate = deps.formatDate();
            const now = new Date();
            const draft = input.draft ?? {};
            const draftMinutes = typeof draft.timeSpentMinutes === 'number' ? draft.timeSpentMinutes : undefined;
            const start = mode === 'editor'
                ? getTaskEditorBackdatedCompletionStart(task, { completedAt: typeof draft.completedAt === 'string' ? draft.completedAt : '',
                    timeSpentMinutes: draftMinutes })
                : null;
            // A row's Done starts now; an edit at the stored time; the editor at its draft's start (now when it has none).
            const at = mode === 'complete' ? now : mode === 'edit' ? null : (start?.initialValue ? new Date(start.initialValue) : now);
            const { day, time } = at
                ? { day: formatDate(at, 'yyyy-MM-dd'), time: formatDate(at, 'HH:mm') }
                : getArchiveCompletedAtPickerStart(task, formatDate, now);
            const minutes = mode === 'editor' ? start?.initialTimeSpentMinutes : normalizeTimeSpentMinutes(task.timeSpentMinutes);
            const t = deps.t();
            const showTimeSpent = mode !== 'edit' && isTaskEditorTimeSpentEnabled(state.settings);
            return { ok: true, value: { picker: {
                mode, taskId: task.id, taskRevision: taskRevisionOf(task), day, time,
                timeSpent: showTimeSpent ? {
                    title: tFallback(t, 'task.completedAtPromptTitle', 'Completion time'),
                    label: tFallback(t, 'taskEdit.timeSpentLabel', 'Time Spent'),
                    placeholder: tFallback(t, 'taskEdit.timeSpentPlaceholder', 'minutes'),
                    value: minutes != null ? String(minutes) : '',
                    cancel: tFallback(t, 'common.cancel', 'Cancel'),
                    save: tFallback(t, 'common.save', 'Save'),
                } : null,
            } } };
        },

        /** RN's card line: the picked day and time in the app's date format. */
        getPickedCompletedAtLabel(input: { day: string; time: string }): NativeHostResult<{ label: string }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const label = isObjectRecord(input) ? formatPickedCompletedAt(deps.formatDate(), input.day as string, input.time as string) : null;
            return label ? { ok: true, value: { label } } : fail('INVALID_INPUT', 'A local day and time are required');
        },

        /**
         * A row's picked completion (RN's applyCompletedAt), journaled under `requestId`: 'complete' sets Done at the picked
         * minute, with the minutes typed when Time Spent is on; 'edit' moves a finished task's completion time. `taskRevision`
         * is the row's: a task changed since is refused (STALE_REVISION).
         */
        async setTaskCompletedAt(input: NativeTaskCompletedAtRequest): Promise<NativeHostResult<{ id: string; completed: boolean }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || typeof input.requestId !== 'string' || !deps.requestIdPattern.test(input.requestId)
                || !id(input.taskId) || !id(input.taskRevision) || (input.mode !== 'complete' && input.mode !== 'edit')
                || (input.timeSpentText !== undefined && (typeof input.timeSpentText !== 'string' || input.timeSpentText.length > 50))) {
                return fail('INVALID_INPUT', 'A request UUID, a task, its revision and a picker mode are required');
            }
            const completedAt = resolvePickedCompletedAt(input.day, input.time);
            if (!completedAt) return fail('INVALID_INPUT', 'A local day and time are required');
            const { requestId, ...rest } = input;
            const result = await receipts.run<{ id: string; completed: boolean }>(requestId, JSON.stringify(['taskCompletedAt', rest]), async () => {
                const state = useTaskStore.getState();
                const task = state._tasksById.get(input.taskId);
                if (!task || task.deletedAt) return fail('TASK_NOT_FOUND', 'Task not found');
                if (taskRevisionOf(task) !== input.taskRevision) return fail('STALE_REVISION', 'The task changed since the row showed it');
                if (!offered(task, input.mode)) return fail('INVALID_INPUT', input.mode === 'complete' ? 'Task is already done' : 'Task has no completion time to edit');
                const updates: Partial<Task> = input.mode === 'complete' ? { status: 'done', completedAt } : { completedAt };
                if (input.mode === 'complete' && isTaskEditorTimeSpentEnabled(state.settings) && input.timeSpentText !== undefined) {
                    updates.timeSpentMinutes = normalizeTimeSpentMinutes(parseTaskEditorTimeSpent(input.timeSpentText));
                }
                const written = await runStoreWrite(() => useTaskStore.getState().updateTask(task.id, updates));
                return settleWrite(written, { id: task.id, completed: input.mode === 'complete' });
            });
            if (result.ok) {
                try {
                    logInfo('Native completion time saved', { scope: 'native-host', category: 'storage', force: true, context: {
                        releaseCheck: 'v1.3.8/native-backdated-completion', outcome: input.mode } });
                } catch { /* a diagnostic line never changes the write */ }
            }
            return result;
        },
    };
}
