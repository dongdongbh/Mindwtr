import { getFocusStarBlockedText } from './focus-star';
import { normalizeFocusTaskLimit } from './focus-utils';
import type { DateFormatter } from './date';
import { normalizeClockTimeInput, safeParseDate } from './date';
import { isTodayScheduleCandidate } from './focus-sections';
import { tFallback } from './i18n';
import type { NativeHostResult } from './native-host-contract';
import { fail, isObjectRecord } from './native-host-contract-menu-views';
import { createNativeRequestReceipts, runStoreWrite, settleWrite, taskRevisionOf } from './native-request-receipts';
import { useTaskStore } from './store';
import { getTaskEditorDateIssueLabel, isTaskDateCoherent } from './task-date-coherence';
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

export type NativeTaskDeferOption = {
    id: 'today' | 'tomorrow' | 'nextWeek' | 'custom';
    label: string;
    draft: NativeTaskDates;
    refocus: boolean;
    toast: { title: string; message: string };
};

export type NativeTaskDeferMenu = {
    taskId: string;
    title: string;
    message: string;
    cancel: string;
    base: NativeTaskDates;
    options: NativeTaskDeferOption[];
    custom: { label: string; min: string; max: string | null };
};

export type NativeTaskReviewMenu = {
    title: string;
    cancel: string;
    options: Array<{ label: string; action: { type: 'markTaskReviewed'; taskId: string; advance: boolean; taskRevision: string } }>;
};

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

const deferPatch = (task: Task, startTime: string, refocus: boolean): Partial<Task> | null => {
    const start = safeParseDate(startTime);
    const now = new Date();
    const startsToday = !start || start.getTime() <= new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const patch: Partial<Task> = {
        ...(startTime === (task.startTime ?? '') ? {} : { startTime: startTime || undefined }),
        ...(refocus && task.isFocusedToday !== true ? { isFocusedToday: true } : {}),
        ...(!refocus && !startsToday && task.status !== 'next' && task.isFocusedToday === true ? { isFocusedToday: false } : {}),
    };
    return Object.keys(patch).length ? patch : null;
};

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

        getFocusRowMenus(input: { deferIds: string[]; reviewIds: string[]; day?: string }): NativeHostResult<{
            defer: Record<string, NativeTaskDeferMenu>; review: Record<string, NativeTaskReviewMenu>;
            pick: { option: NativeTaskDeferOption | null; issue: string } | null;
        }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const ids = (list: unknown): list is string[] => Array.isArray(list) && list.length <= 500 && list.every(id);
            if (!isObjectRecord(input) || !ids(input.deferIds) || !ids(input.reviewIds)
                || (input.day !== undefined && (input.deferIds.length !== 1 || input.reviewIds.length !== 0 || !localDay(input.day)))) {
                return fail('INVALID_INPUT', 'Up to 500 row ids per kind, or one deferred task and a local day, are required');
            }
            const t = deps.t();
            const formatDate = deps.formatDate();
            const now = new Date();
            const dayFrom = (days: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
            const dayText = (day: Date) => formatDate(day, 'yyyy-MM-dd');
            const today = dayFrom(0);
            const canStartOn = (task: Task, day: Date) => isTaskDateCoherent({ dueDate: task.dueDate, startTime: dayText(day) });
            const option = (task: Task, optionId: NativeTaskDeferOption['id'], label: string, day: Date): NativeTaskDeferOption => {
                const startsToday = day.getTime() <= today.getTime();
                return {
                    id: optionId, label, draft: { ...datesOf(createTaskDraft(task)), startTime: dayText(day) },
                    refocus: !startsToday && task.status !== 'next' && task.isFocusedToday === true,
                    toast: { title: task.title, message: startsToday
                        ? `${tFallback(t, 'taskEdit.startDateLabel', 'Start Date')}: ${tFallback(t, 'quickDate.today', 'Today')}`
                        : `${tFallback(t, 'review.startTime', 'Defer until')} ${formatDate(day, 'PP')}` },
                };
            };
            const review: Record<string, NativeTaskReviewMenu> = {};
            const deferIds = [...input.deferIds];
            for (const taskId of input.reviewIds) {
                const task = liveTask(taskId);
                if (!task) continue;
                if (!task.reviewAt) { deferIds.push(taskId); continue; }
                const mark = (advance: boolean) => ({ type: 'markTaskReviewed' as const, taskId, advance, taskRevision: taskRevisionOf(task) });
                review[taskId] = {
                    title: task.title,
                    cancel: tFallback(t, 'common.cancel', 'Cancel'),
                    options: [
                        { label: tFallback(t, 'review.markReviewed', 'Mark reviewed'), action: mark(false) },
                        { label: tFallback(t, 'review.advanceWeek', 'Review in 1 week'), action: mark(true) },
                    ],
                };
            }
            const menus: Record<string, NativeTaskDeferMenu> = {};
            for (const taskId of deferIds) {
                const task = liveTask(taskId);
                if (!task || !(task.isFocusedToday === true || task.status === 'next') || !canStartOn(task, dayFrom(1))) continue;
                const due = safeParseDate(task.dueDate);
                menus[taskId] = {
                    taskId,
                    title: tFallback(t, 'taskEdit.startDateLabel', 'Start Date'),
                    message: task.title,
                    cancel: tFallback(t, 'common.cancel', 'Cancel'),
                    base: datesOf(createTaskDraft(task)),
                    options: [
                        ...(isTodayScheduleCandidate(task, now) ? [] : [option(task, 'today', tFallback(t, 'quickDate.today', 'Today'), today)]),
                        option(task, 'tomorrow', tFallback(t, 'quickDate.tomorrow', 'Tomorrow'), dayFrom(1)),
                        ...(canStartOn(task, dayFrom(7)) ? [option(task, 'nextWeek', tFallback(t, 'quickDate.nextWeek', 'Next week'), dayFrom(7))] : []),
                    ],
                    custom: { label: tFallback(t, 'recurrence.custom', 'Custom...'), min: dayText(dayFrom(1)), max: due ? dayText(due) : null },
                };
            }
            if (input.day === undefined) return { ok: true, value: { defer: menus, review, pick: null } };
            const task = menus[input.deferIds[0]] ? liveTask(input.deferIds[0]) : null;
            const picked = localDay(input.day)!;
            const day = picked < dayFrom(1) ? dayFrom(1) : picked;
            if (!task) return { ok: true, value: { defer: menus, review, pick: { option: null, issue: tFallback(t, 'task.updateFailed', 'Could not update task.') } } };
            return { ok: true, value: { defer: menus, review, pick: canStartOn(task, day)
                ? { option: option(task, 'custom', dayText(day), day), issue: '' }
                : { option: null, issue: tFallback(t, 'task.dateIssue.startAfterDue', 'Starts after due date') } } };
        },

        async saveTaskDates(input: { requestId: string; taskId: string; base: NativeTaskDates; draft: NativeTaskDates; defer?: { refocus: boolean } }):
            Promise<NativeHostResult<{ id: string; changed: boolean }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const base = isObjectRecord(input) ? readDates(input.base) : null;
            const dates = isObjectRecord(input) ? readDraftDates(input.draft) : null;
            const defer = isObjectRecord(input) ? input.defer : undefined;
            if (!isObjectRecord(input) || typeof input.requestId !== 'string' || !deps.requestIdPattern.test(input.requestId)
                || !id(input.taskId) || !base || !dates
                || (defer !== undefined && (!isObjectRecord(defer) || Object.keys(defer).join() !== 'refocus' || typeof defer.refocus !== 'boolean'
                    || dates.dueDate !== base.dueDate))) {
                return fail('INVALID_INPUT', 'A request UUID, a task and its base and new dates are required');
            }
            const { requestId, ...rest } = input;
            return receipts.run<{ id: string; changed: boolean }>(requestId, JSON.stringify(['taskDatesSave', rest]), async () => {
                const task = liveTask(input.taskId);
                if (!task) return fail('TASK_NOT_FOUND', 'Task not found');
                if (!sameDates(datesOf(createTaskDraft(task)), base)) return fail('STALE_REVISION', 'The task\'s dates changed since the sheet opened');
                const patch = defer ? deferPatch(task, dates.startTime, defer.refocus) : taskDraftToChangedUpdatePatch(editedDraft(task, base, dates), task);
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
