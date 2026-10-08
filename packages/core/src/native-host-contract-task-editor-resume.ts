import type { NativeHostResult } from './native-host-contract';
import { getPersistenceStatus, getStorageAdapter, useTaskStore } from './store';
import { taskEditValuesEqual } from './store-tasks';
import { createTaskDraft, type TaskDraft, type TaskDraftField } from './task-draft';
import { isStatusListTaskReadOnly } from './menu-views-model';
import { normalizeRecurrenceForLoad } from './recurrence';
import { normalizeTimeSpentMinutes } from './time-spent';
import { ASSOCIATIONS, LIFECYCLE, RECURRENCE, SCHEDULE, getNativeTaskRecurrenceBase,
    getNativeTaskScheduleBase, readNativeTaskDraftSaveRequest,
    type NativeTaskRecurrenceBase, type NativeTaskScheduleBase } from './native-host-contract-task-save';
import { isNativeJsonWithinBytes, readChecklist, sameChecklist, toChecklist } from './native-host-contract-task-view';
import type { ChecklistItem, Task } from './types';
import type { Attachment } from './types';
import { mergeNativeTaskLinkHalf, readNativeAttachments, readNativeTaskLinkHalf, type NativeTaskLinkHalf } from './native-host-contract-attachments';
import { mergeTaskDraftAttachments } from './attachment-editor-model';
import { readNativeAttachmentDraftPayload, validateNativeAttachmentDraftLineageV3, validateNativeAttachmentDraftLineageV4, validateNativeAttachmentDraftLineageV5 } from './native-attachment-draft';
import { captureNativeOwnedFileAddSaveData } from './native-host-contract-owned-file-save';

const OWNED_GROUPS = [SCHEDULE, RECURRENCE, ASSOCIATIONS, LIFECYCLE] as const;
const own = (value: object, field: string) => Object.prototype.hasOwnProperty.call(value, field);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'TASK_NOT_FOUND' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });

export type NativeTaskEditorResumeCheck = {
    id: string;
    /** Exact opening draft values for all owned fields, including raw-only and no-op inputs. Null records a missing optional value. */
    touchedBase: Record<string, unknown>;
    /** Raw opening witnesses, present exactly when that group is owned. */
    scheduleBase?: NativeTaskScheduleBase;
    recurrenceBase?: NativeTaskRecurrenceBase;
    checklistBase?: ChecklistItem[];
    attachmentsBase?: Attachment[];
    attachments?: Attachment[];
};

export type NativeTaskEditorResumeReady = {
    kind: 'ready';
    freshDraft: TaskDraft;
    freshScheduleBase: NativeTaskScheduleBase;
    freshRecurrenceBase: NativeTaskRecurrenceBase;
    freshChecklistBase: ChecklistItem[];
    freshAttachmentsBase: Attachment[];
};

/** Read the saved raw row without flushing queued writes or touching the write journal. */
async function currentTask(id: string): Promise<NativeHostResult<{ task: Task; projects: ReturnType<typeof useTaskStore.getState>['_allProjects'] }>> {
    const adapter = getStorageAdapter();
    const state = useTaskStore.getState();
    const before = getPersistenceStatus();
    if (before.queued || before.inFlight || before.immediate || before.retrying || before.failed)
        return fail('SAVE_FAILED', 'Editor recovery must wait for pending persistence');
    let data;
    try { data = await adapter.getData({ rawTasks: true }); }
    catch { return fail('SAVE_FAILED', 'Editor recovery could not read saved data'); }
    const after = getPersistenceStatus();
    const current = useTaskStore.getState();
    if (getStorageAdapter() !== adapter || after.generation !== before.generation
        || after.queued || after.inFlight || after.immediate || after.retrying || after.failed
        || current._allTasks !== state._allTasks || current._allProjects !== state._allProjects
        || current._allSections !== state._allSections || current._allAreas !== state._allAreas
        || current._allPeople !== state._allPeople || current.settings !== state.settings
        || current.lastDataChangeAt !== state.lastDataChangeAt)
        return fail('SAVE_FAILED', 'Editor recovery data changed during read; retry');
    const task = data.tasks.find((row) => row.id === id);
    return task && !task.deletedAt && !task.purgedAt
        ? { ok: true, value: { task, projects: data.projects } }
        : fail('TASK_NOT_FOUND', 'Task not found');
}

export function validateNativeTaskEditorOpeningFields(
    input: Pick<NativeTaskEditorResumeCheck, 'id' | 'touchedBase' | 'scheduleBase' | 'recurrenceBase' | 'checklistBase'>,
    task: Task, validateField: (field: TaskDraftField, value: unknown) => boolean,
): NativeHostResult<Omit<NativeTaskEditorResumeReady, 'kind' | 'freshAttachmentsBase'>> {
    const touched = Object.keys(input.touchedBase);
    if (task.id !== input.id || OWNED_GROUPS.some((group) => group.some((field) => touched.includes(field))
            && !group.every((field) => touched.includes(field)))
        || own(input, 'scheduleBase') !== SCHEDULE.some((field) => touched.includes(field))
        || own(input, 'recurrenceBase') !== RECURRENCE.some((field) => touched.includes(field)))
        return fail('INVALID_INPUT', 'Incomplete editor recovery group');
    const checklist = own(input, 'checklistBase') ? readChecklist(input.checklistBase, true) : undefined;
    if (checklist === null) return fail('INVALID_INPUT', 'Invalid editor recovery checklist');
    const freshScheduleBase = getNativeTaskScheduleBase(task);
    const freshRecurrenceBase = getNativeTaskRecurrenceBase({ ...task, recurrence: normalizeRecurrenceForLoad(task.recurrence) });
    // The save parser owns field type grammar. An untouched schedule uses its fresh witness;
    // a touched schedule carries the opening witness and cannot be silently rebased.
    const candidate = readNativeTaskDraftSaveRequest({
        id: input.id, base: input.touchedBase, patch: input.touchedBase,
        scheduleBase: input.scheduleBase ?? freshScheduleBase,
        ...(own(input, 'recurrenceBase') ? { recurrenceBase: input.recurrenceBase } : {}),
    }, validateField, true, true);
    if (!candidate) return fail('INVALID_INPUT', 'Invalid editor recovery field base');

    const freshChecklistBase = toChecklist(task.checklist);
    const projected = { ...task, timeSpentMinutes: normalizeTimeSpentMinutes(task.timeSpentMinutes),
        recurrence: normalizeRecurrenceForLoad(task.recurrence) };
    const freshDraft = createTaskDraft(projected);
    if ((own(input, 'scheduleBase') && !taskEditValuesEqual(input.scheduleBase, freshScheduleBase))
        || (own(input, 'recurrenceBase') && !taskEditValuesEqual(input.recurrenceBase, freshRecurrenceBase)))
        return fail('STALE_REVISION', 'Task changed while editor draft was open');
    const matchesOpening = (field: string) => taskEditValuesEqual(freshDraft[field as keyof TaskDraft],
        input.touchedBase[field] === null && ['relativeStartOffset', 'timeSpentMinutes'].includes(field)
            ? undefined : input.touchedBase[field]);
    // A matching raw witness makes the current projection the opening projection.
    // Its touched draft half must agree too; otherwise the snapshot is internally inconsistent.
    if (touched.some((field) => (SCHEDULE.includes(field as typeof SCHEDULE[number])
        || RECURRENCE.includes(field as typeof RECURRENCE[number])) && !matchesOpening(field)))
        return fail('INVALID_INPUT', 'Editor recovery draft disagrees with its opening witness');
    if ((checklist && !sameChecklist(checklist, freshChecklistBase))
        || touched.some((field) => !SCHEDULE.includes(field as typeof SCHEDULE[number])
            && !RECURRENCE.includes(field as typeof RECURRENCE[number]) && !matchesOpening(field)))
        return fail('STALE_REVISION', 'Task changed while editor draft was open');
    return { ok: true, value: { freshDraft, freshScheduleBase, freshRecurrenceBase, freshChecklistBase } };
}

type ResumeDependencies = {
    readiness: () => NativeHostResult<null>;
    validateField: (field: TaskDraftField, value: unknown) => boolean;
    isReadOnly: (task: Task) => boolean;
};
async function checkSavedOpening(input: NativeTaskEditorResumeCheck, deps: ResumeDependencies,
    attachments: NativeTaskLinkHalf | undefined, selection: 'links' | 'owned'): Promise<NativeHostResult<NativeTaskEditorResumeReady>> {
    const saved = await currentTask(input.id);
    if (!saved.ok) return saved;
    const { task, projects } = saved.value;
    if (deps.isReadOnly(task) || isStatusListTaskReadOnly(task, projects))
        return fail('INVALID_INPUT', 'Task is read-only');
    const freshAttachmentsBase = readNativeAttachments(task.attachments ?? []);
    const merged = freshAttachmentsBase && attachments ? selection === 'owned'
        ? readNativeAttachments(mergeTaskDraftAttachments(freshAttachmentsBase, attachments.base, attachments.value))
        : mergeNativeTaskLinkHalf(freshAttachmentsBase, attachments) : freshAttachmentsBase;
    if (!freshAttachmentsBase || !merged) return fail('INVALID_INPUT', 'Invalid editor recovery attachments');
    const opening = validateNativeTaskEditorOpeningFields(input, task, deps.validateField);
    if (!opening.ok) return opening;
    return { ok: true, value: { kind: 'ready', ...opening.value, freshAttachmentsBase } };
}

export function createTaskEditorResumeMethods(deps: ResumeDependencies) {
    return {
        async checkTaskEditorResume(input: NativeTaskEditorResumeCheck): Promise<NativeHostResult<NativeTaskEditorResumeReady>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isNativeJsonWithinBytes(input) || !record(input)
                || Object.keys(input).some((field) => !['id', 'touchedBase', 'scheduleBase', 'recurrenceBase', 'checklistBase', 'attachmentsBase', 'attachments'].includes(field))
                || typeof input.id !== 'string' || !input.id.trim() || input.id.length > 500
                || !record(input.touchedBase)) return fail('INVALID_INPUT', 'Invalid editor recovery base');

            const touched = Object.keys(input.touchedBase);
            if (OWNED_GROUPS.some((group) => group.some((field) => touched.includes(field))
                    && !group.every((field) => touched.includes(field)))
                || own(input, 'scheduleBase') !== SCHEDULE.some((field) => touched.includes(field))
                || own(input, 'recurrenceBase') !== RECURRENCE.some((field) => touched.includes(field)))
                return fail('INVALID_INPUT', 'Incomplete editor recovery group');
            const checklist = own(input, 'checklistBase') ? readChecklist(input.checklistBase, true) : undefined;
            if (checklist === null) return fail('INVALID_INPUT', 'Invalid editor recovery checklist');
            if (own(input, 'attachmentsBase') !== own(input, 'attachments'))
                return fail('INVALID_INPUT', 'Incomplete editor recovery attachments');
            const attachments = own(input, 'attachmentsBase')
                ? readNativeTaskLinkHalf({ base: input.attachmentsBase, value: input.attachments }, false) : undefined;
            if (attachments === null) return fail('INVALID_INPUT', 'Invalid editor recovery attachments');

            return checkSavedOpening(input, deps, attachments, 'links');
        },
    };
}

/** Internal historical lineage selection; native file/editor authority remains outside this factory. */
export function createOwnedTaskEditorResumeMethods(deps: ResumeDependencies) {
    return {
        async checkOwnedTaskEditorResume(input: unknown): Promise<NativeHostResult<NativeTaskEditorResumeReady>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const captured = captureNativeOwnedFileAddSaveData(input, 8 * 1024 * 1024);
            const exact = (value: unknown, fields: readonly string[]): value is Record<string, unknown> => record(value)
                && Object.keys(value).length === fields.length && fields.every((field) => own(value, field));
            if (!exact(captured, ['version', 'kind', 'checkpoint', 'ownedDraft']) || (captured.version !== 1 && captured.version !== 2 && captured.version !== 3) || captured.kind !== 'owned-editor-resume'
                || !exact(captured.checkpoint, ['version', 'sessionID', 'taskID', 'generation', 'payloadJSON']))
                return fail('INVALID_INPUT', 'An exact owned editor checkpoint and lineage are required');
            const checkpoint = captured.checkpoint;
            if (checkpoint.version !== 1 || typeof checkpoint.sessionID !== 'string'
                || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(checkpoint.sessionID)
                || typeof checkpoint.taskID !== 'string' || !checkpoint.taskID.trim() || checkpoint.taskID.length > 500
                || typeof checkpoint.generation !== 'number' || !Number.isSafeInteger(checkpoint.generation) || checkpoint.generation < 1
                || typeof checkpoint.payloadJSON !== 'string') return fail('INVALID_INPUT', 'Invalid owned editor checkpoint');
            let opening: NativeTaskEditorResumeCheck, attachments: NativeTaskLinkHalf;
            try {
                const lineage = (captured.version === 3 ? validateNativeAttachmentDraftLineageV5 : captured.version === 2 ? validateNativeAttachmentDraftLineageV4 : validateNativeAttachmentDraftLineageV3)(captured.ownedDraft);
                if (!record(captured.ownedDraft) || !Array.isArray(captured.ownedDraft.priorOperations)
                    || checkpoint.generation < captured.ownedDraft.priorOperations.length + 1
                    || checkpoint.taskID !== lineage.taskID || checkpoint.payloadJSON !== lineage.payloadJSON)
                    return fail('INVALID_INPUT', 'Owned editor checkpoint disagrees with its lineage');
                const payload: unknown = JSON.parse(checkpoint.payloadJSON);
                if (!record(payload) || payload.version !== 2 || payload.attachmentsOwned !== true || !record(payload.touchedBase))
                    return fail('INVALID_INPUT', 'Invalid owned editor opening fields');
                const half = readNativeAttachmentDraftPayload(checkpoint.payloadJSON, checkpoint.taskID);
                attachments = { base: half.baselineAttachments, value: half.attachments };
                opening = { id: checkpoint.taskID, touchedBase: payload.touchedBase,
                    ...Object.fromEntries(['scheduleBase', 'recurrenceBase', 'checklistBase'].filter((field) => own(payload, field))
                        .map((field) => [field, payload[field]])) };
            } catch { return fail('INVALID_INPUT', 'Invalid owned editor lineage'); }
            return checkSavedOpening(opening, deps, attachments, 'owned');
        },
    };
}
