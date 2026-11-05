import { getFocusStarBlockedText } from './focus-star';
import { normalizeFocusTaskLimit } from './focus-utils';
import type { DateFormatter } from './date';
import { normalizeClockTimeInput, safeParseDate } from './date';
import { tFallback } from './i18n';
import type { NativeHostResult } from './native-host-contract';
import { fail, isObjectRecord } from './native-host-contract-menu-views';
import { createNativeRequestReceipts, runStoreWrite, settleWrite, taskRevisionOf } from './native-request-receipts';
import { useTaskStore } from './store';
import { getTaskEditorDateIssueLabel } from './task-date-coherence';
import { createTaskDraft, setTaskDraftField, taskDraftToChangedUpdatePatch, type TaskDraft, type TaskDraftField } from './task-draft';
import {
    formatTaskEditorDate,
    getTaskDraftDateEdit,
    getTaskEditorQuickDates,
    setTaskDraftDate,
} from './task-editor-schedule';
import { buildTaskRowSwipeActions, type TaskRowSwipeActions } from './task-row-swipe-actions';
import type { Task, TaskStatus } from './types';

type Translate = (key: string) => string;

const STATUSES: readonly TaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived'];
const DATE_FIELDS = ['startTime', 'dueDate'] as const;
type DateField = typeof DATE_FIELDS[number];
export type NativeTaskDates = Record<DateField, string>;

export type NativeTaskDatesSheet = {
    taskId: string;
    taskRevision: string;
    title: string;
    cancel: string;
    save: string;
    base: NativeTaskDates;
    draft: NativeTaskDates;
    fields: Array<{
        field: DateField;
        label: string;
        value: string;
        pickerStart: string;
        quickDates: Array<{ label: string; selected: boolean; value: string }>;
    }>;
    issue: string;
};

const id = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= 500;
const readDates = (value: unknown): NativeTaskDates | null => {
    if (!isObjectRecord(value) || Object.keys(value).some((key) => !(DATE_FIELDS as readonly string[]).includes(key))) return null;
    if (!DATE_FIELDS.every((field) => typeof value[field] === 'string' && (value[field] as string).length <= 100)) return null;
    return { startTime: value.startTime as string, dueDate: value.dueDate as string };
};
const readDraftDates = (value: unknown): NativeTaskDates | null => {
    const dates = readDates(value);
    return dates && DATE_FIELDS.every((field) => dates[field] === '' || safeParseDate(dates[field])) ? dates : null;
};
const datesOf = (draft: TaskDraft): NativeTaskDates => ({ startTime: draft.startTime ?? '', dueDate: draft.dueDate ?? '' });
const sameDates = (a: NativeTaskDates, b: NativeTaskDates) => a.startTime === b.startTime && a.dueDate === b.dueDate;

const editedDraft = (task: Task, base: NativeTaskDates, dates: NativeTaskDates): TaskDraft => DATE_FIELDS.reduce((draft, field) => (
    dates[field] === base[field] ? draft : Object.entries(getTaskDraftDateEdit(field, dates[field])).reduce(
        (next, [key, fieldValue]) => setTaskDraftField(next, key as TaskDraftField, fieldValue as never), draft)
), createTaskDraft(task));

const localDay = (day: unknown): Date | null => {
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    const [y, m, d] = day.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? date : null;
};

export function createTaskSwipeMethods(deps: {
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
    const liveTask = (taskId: string): Task | null => {
        const task = useTaskStore.getState()._tasksById.get(taskId);
        return task && !task.deletedAt ? task : null;
    };
    const scheduleOptions = () => ({
        t: deps.t(), now: new Date(), formatDate: deps.formatDate(),
        defaultScheduleTime: normalizeClockTimeInput(useTaskStore.getState().settings?.gtd?.defaultScheduleTime) || undefined,
    });

    return {
        getTaskRowSwipeTrays(): NativeHostResult<{ trays: Record<string, TaskRowSwipeActions> }> {
            const t = deps.t();
            const trays: Record<string, TaskRowSwipeActions> = {};
            for (const status of STATUSES) {
                trays[status] = buildTaskRowSwipeActions({ task: { status, isFocusedToday: false }, t });
                trays[`${status}:focused`] = buildTaskRowSwipeActions({ task: { status, isFocusedToday: true }, t });
            }
            return { ok: true, value: { trays } };
        },

        getTaskDatesSheet(input: { taskId: string; base?: NativeTaskDates; draft?: NativeTaskDates; pick?: { field: DateField; day: string } }):
            NativeHostResult<{ sheet: NativeTaskDatesSheet }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !id(input.taskId)) return fail('INVALID_INPUT', 'A task is required');
            const task = liveTask(input.taskId);
            if (!task) return fail('TASK_NOT_FOUND', 'Task not found');
            const opened = datesOf(createTaskDraft(task));
            const base = input.base === undefined ? opened : readDates(input.base);
            let dates = input.draft === undefined ? base : readDraftDates(input.draft);
            if (!base || !dates || (input.base === undefined) !== (input.draft === undefined)) {
                return fail('INVALID_INPUT', 'base and draft must both hold startTime and dueDate');
            }
            const options = scheduleOptions();
            if (input.pick !== undefined) {
                const pick = input.pick;
                const day = isObjectRecord(pick) ? localDay(pick.day) : null;
                if (!day || !(DATE_FIELDS as readonly unknown[]).includes(pick.field)) return fail('INVALID_INPUT', 'A date field and a local day are required');
                dates = { ...dates, [pick.field]: setTaskDraftDate(pick.field, dates[pick.field] || undefined, day, options) };
            }
            const t = options.t;
            const notSet = tFallback(t, 'common.notSet', 'Not set');
            const draft = editedDraft(task, base, dates);
            return { ok: true, value: { sheet: {
                taskId: task.id,
                taskRevision: taskRevisionOf(task),
                title: tFallback(t, 'filters.taskDates', 'Task dates'),
                cancel: tFallback(t, 'common.cancel', 'Cancel'),
                save: tFallback(t, 'common.save', 'Save'),
                base,
                draft: dates,
                fields: DATE_FIELDS.map((field) => ({
                    field,
                    label: field === 'startTime'
                        ? tFallback(t, 'taskEdit.startDateLabel', 'Start Date')
                        : tFallback(t, 'taskEdit.dueDateLabel', 'Due Date'),
                    value: formatTaskEditorDate(dates[field], options.formatDate, notSet, { due: field === 'dueDate' }),
                    pickerStart: options.formatDate(safeParseDate(dates[field]) ?? options.now, 'yyyy-MM-dd'),
                    quickDates: getTaskEditorQuickDates(field, dates[field] || undefined, options)
                        .map(({ label, selected, value }) => ({ label, selected, value })),
                })),
                issue: getTaskEditorDateIssueLabel(draft, t),
            } } };
        },

        async saveTaskDates(input: { requestId: string; taskId: string; base: NativeTaskDates; draft: NativeTaskDates }):
            Promise<NativeHostResult<{ id: string; changed: boolean }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const base = isObjectRecord(input) ? readDates(input.base) : null;
            const dates = isObjectRecord(input) ? readDraftDates(input.draft) : null;
            if (!isObjectRecord(input) || typeof input.requestId !== 'string' || !deps.requestIdPattern.test(input.requestId)
                || !id(input.taskId) || !base || !dates) {
                return fail('INVALID_INPUT', 'A request UUID, a task and its base and new dates are required');
            }
            const { requestId, ...rest } = input;
            return receipts.run<{ id: string; changed: boolean }>(requestId, JSON.stringify(['taskDatesSave', rest]), async () => {
                const task = liveTask(input.taskId);
                if (!task) return fail('TASK_NOT_FOUND', 'Task not found');
                if (!sameDates(datesOf(createTaskDraft(task)), base)) return fail('STALE_REVISION', 'The task\'s dates changed since the sheet opened');
                const patch = taskDraftToChangedUpdatePatch(editedDraft(task, base, dates), task);
                if (!patch || Object.keys(patch).length === 0) return { ok: true, value: { id: task.id, changed: false } };
                const written = await runStoreWrite(() => useTaskStore.getState().updateTask(task.id, patch));
                return settleWrite(written, { id: task.id, changed: true });
            });
        },

        async setTaskSwipeFocus(input: { requestId: string; taskId: string; taskRevision: string }):
            Promise<NativeHostResult<{ id: string; focused: boolean } | { blocked: string; blockedTitle: string }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || typeof input.requestId !== 'string' || !deps.requestIdPattern.test(input.requestId)
                || !id(input.taskId) || !id(input.taskRevision)) {
                return fail('INVALID_INPUT', 'A request UUID, a task and its revision are required');
            }
            const { requestId, ...rest } = input;
            return receipts.run<{ id: string; focused: boolean } | { blocked: string; blockedTitle: string }>(
                requestId, JSON.stringify(['taskSwipeFocus', rest]), async () => {
                    const state = useTaskStore.getState();
                    const task = liveTask(input.taskId);
                    if (!task) return fail('TASK_NOT_FOUND', 'Task not found');
                    if (taskRevisionOf(task) !== input.taskRevision) return fail('STALE_REVISION', 'The task changed since the row showed it');
                    const action = state.getFocusStarAction(task, { promoteInbox: true });
                    if (!action.canToggle) {
                        const t = deps.t();
                        return { ok: true, value: {
                            blocked: getFocusStarBlockedText(t, action, normalizeFocusTaskLimit(state.settings.gtd?.focusTaskLimit)) ?? '',
                            blockedTitle: tFallback(t, 'digest.focus', 'Focus'),
                        } };
                    }
                    const written = await runStoreWrite(() => useTaskStore.getState().updateTask(task.id, action.patch));
                    return settleWrite(written, { id: task.id, focused: action.patch.isFocusedToday === true });
                });
        },
    };
}
