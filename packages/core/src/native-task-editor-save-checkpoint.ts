import type { NativeHostResult } from './native-host-contract';
import { validateNativeTaskEditorOpeningFields } from './native-host-contract-task-editor-resume';
import { ASSOCIATIONS, LIFECYCLE, NATIVE_NULLABLE_DRAFT_FIELDS, RECURRENCE, SCHEDULE, readNativeTaskDraftSaveRequest, validRawTask,
    type NativeTaskRecurrenceBase, type NativeTaskScheduleBase } from './native-host-contract-task-save';
import { readNativeAttachments } from './native-host-contract-attachments';
import { isNativeJsonWithinBytes, readChecklist } from './native-host-contract-task-view';
import { getTaskEditorDailyInterval, getTaskEditorSuggestions } from './task-editor-model';
import { getTaskEditorRelativeStart, getTaskEditorRecurrenceInputValues, getTaskEditorTimeEstimate } from './task-editor-schedule';
import { taskEditValuesEqual } from './json-value-equality';
import type { TaskDraft, TaskDraftField } from './task-draft';
import type { Task } from './types';

export type NativeTaskEditorSaveCheckpointInput = { payloadJSON: string; saveRequest: unknown; beforeTask: Task };
const PAYLOAD_BYTES = 1_000_000;
const REQUEST_BYTES = 8 * 1024 * 1024;
const TASK_BYTES = 16 * 1024 * 1024;
const FIELDS = ['title', 'description', 'location', 'assignedTo', 'priority', 'energyLevel', 'timeEstimate',
    'projectId', 'areaId', 'sectionId', 'contexts', 'tags', ...SCHEDULE, ...RECURRENCE, 'timeSpentMinutes',
    'reminderPolicy', 'dueReminderLeadMinutes', 'startReminderLeadMinutes'];
const TOKEN_FIELDS = ['contexts', 'tags', 'assignedTo'] as const;
const RAW_FIELDS = ['title', 'note', 'location', 'estimate', 'estimateResolved', 'timeSpent', 'timeSpentResolved',
    'tokens', 'tokenCanonical', 'tokenResolved', 'tokenEdited', 'checklistInputs', 'checklistAppend',
    'relativeAmount', 'relativeUnit', 'relativeOwned', 'relativeCommitRequested',
    'recurrenceInputs', 'recurrenceOwned', 'recurrenceCommitRequested'];
const own = (value: object, field: string) => Object.prototype.hasOwnProperty.call(value, field);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: unknown, names: readonly string[]): value is Record<string, unknown> => record(value)
    && Object.keys(value).length === names.length && names.every((name) => own(value, name));
const invalid = (): NativeHostResult<never> => ({ ok: false, error: { code: 'INVALID_INPUT', message: 'Editor Save checkpoint is incomplete or does not match the request' } });
const utf8 = (text: string): number => {
    let size = 0;
    for (let index = 0; index < text.length; index++) {
        const unit = text.charCodeAt(index);
        if (unit < 128) size++;
        else if (unit < 2048) size += 2;
        else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length
            && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) { size += 4; index++; }
        else size += 3;
    }
    return size;
};


const capture = (input: unknown, maximum: number): unknown => {
    const seen = new WeakSet<object>();
    let nodes = 0, bytes = 0;
    const charge = (count: number) => { bytes += count; if (bytes > maximum) throw new Error('bounded'); };
    const copy = (value: unknown, depth: number): unknown => {
        if (++nodes > 100_000 || depth > 40) throw new Error('bounded');
        if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) {
            charge(String(value).length); return value;
        }
        if (typeof value === 'string') {
            if (value.length > maximum) throw new Error('bounded');
            charge(utf8(JSON.stringify(value))); return value;
        }
        if (!record(value) && !Array.isArray(value) || seen.has(value as object)) throw new Error('data');
        seen.add(value as object);
        if (Array.isArray(value)) {
            if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 10_000
                || Reflect.ownKeys(value).length !== value.length + 1) throw new Error('data');
            charge(2 + Math.max(0, value.length - 1));
            const result: unknown[] = [];
            for (let index = 0; index < value.length; index++) {
                const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
                if (!descriptor?.enumerable || !own(descriptor, 'value')) throw new Error('data');
                result.push(copy(descriptor.value, depth + 1));
            }
            return result;
        }
        if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('data');
        const names = Reflect.ownKeys(value as object);
        if (names.length > 256) throw new Error('data');
        charge(2 + Math.max(0, names.length - 1));
        const result: Record<string, unknown> = Object.create(null);
        for (const name of names) {
            if (typeof name !== 'string' || ['__proto__', 'prototype', 'constructor', 'toJSON'].includes(name)) throw new Error('data');
            const descriptor = Object.getOwnPropertyDescriptor(value, name);
            if (!descriptor?.enumerable || !own(descriptor, 'value')) throw new Error('data');
            charge(utf8(JSON.stringify(name)) + 1);
            result[name] = copy(descriptor.value, depth + 1);
        }
        return result;
    };
    try { return copy(input, 0); } catch { return null; }
};
const numberDisplay = (text: unknown, value: unknown): boolean => {
    if (typeof text !== 'string') return false;
    if (value === null || value === undefined) return text === '';
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)
        && Number.isFinite(Number(text)) && Number(text) === value;
};
const safeIntegerDisplay = (number: number): string | null => Number.isSafeInteger(number) && number >= 0 ? String(number) : null;


export function validateNativeTaskEditorSaveCheckpoint(
    input: NativeTaskEditorSaveCheckpointInput,
    validateField: (field: TaskDraftField, value: unknown) => boolean,
): NativeHostResult<{ kind: 'ready' }> {
    return validateEditorSaveCheckpoint(input, validateField, false);
}


export function validateNativeOwnedCompleteTaskEditorSaveCheckpoint(
    input: NativeTaskEditorSaveCheckpointInput,
    validateField: (field: TaskDraftField, value: unknown) => boolean,
): NativeHostResult<{ kind: 'ready' }> {
    return validateEditorSaveCheckpoint(input, validateField, true);
}

function validateEditorSaveCheckpoint(input: NativeTaskEditorSaveCheckpointInput,
    validateField: (field: TaskDraftField, value: unknown) => boolean, complete: boolean): NativeHostResult<{ kind: 'ready' }> {
    try {
        const captured = capture(input, 2 * PAYLOAD_BYTES + REQUEST_BYTES + TASK_BYTES + 256);
        if (!exact(captured, ['payloadJSON', 'saveRequest', 'beforeTask']) || typeof captured.payloadJSON !== 'string'
            || captured.payloadJSON.length > PAYLOAD_BYTES || utf8(captured.payloadJSON) > PAYLOAD_BYTES
            || !isNativeJsonWithinBytes(captured.saveRequest, REQUEST_BYTES)
            || !isNativeJsonWithinBytes(captured.beforeTask, TASK_BYTES)) return invalid();
        let payload: unknown;
        try { payload = capture(JSON.parse(captured.payloadJSON), PAYLOAD_BYTES); } catch { return invalid(); }
        if (!record(payload) || !record(payload.touchedBase) || !record(payload.edited)) return invalid();
        const touched = Object.keys(payload.touchedBase), edited = payload.edited, base = payload.touchedBase;
        const scheduleOwned = SCHEDULE.some((field) => touched.includes(field));
        const recurrenceOwned = RECURRENCE.some((field) => touched.includes(field));
        const checklistOwned = complete && (own(payload, 'checklistBase') || own(payload, 'checklistValue'));
        const keys = ['version', 'taskID', 'tab', 'touchedBase', 'edited', 'raw', 'scheduleEdits', 'scheduleFailedID',
            'attachmentsOwned', 'attachmentsBase', 'attachments', 'linkSheet',
            ...(scheduleOwned ? ['scheduleBase'] : []), ...(recurrenceOwned ? ['recurrenceBase'] : []),
            ...(checklistOwned ? ['checklistBase', 'checklistValue'] : [])];
        if (!exact(payload, keys) || payload.version !== 2 || payload.attachmentsOwned !== true
            || (payload.tab !== 'task' && payload.tab !== 'view') || typeof payload.taskID !== 'string'
            || !exact(edited, touched) || touched.some((field) => !(complete ? [...FIELDS, ...LIFECYCLE] : FIELDS).includes(field)
                || !complete && (LIFECYCLE as readonly string[]).includes(field))
            || !exact(payload.raw, RAW_FIELDS) || !Array.isArray(payload.scheduleEdits) || payload.scheduleEdits.length !== 0
            || payload.scheduleFailedID !== null || !exact(payload.linkSheet, [])
            || !validRawTask(captured.beforeTask, payload.taskID)) return invalid();
        const beforeTask = captured.beforeTask;
        const openingInput = { id: payload.taskID, touchedBase: base,
            ...(scheduleOwned ? { scheduleBase: payload.scheduleBase as NativeTaskScheduleBase } : {}),
            ...(recurrenceOwned ? { recurrenceBase: payload.recurrenceBase as NativeTaskRecurrenceBase } : {}),
            ...(checklistOwned ? { checklistBase: readChecklist(payload.checklistBase, true) ?? undefined } : {}) };
        if (checklistOwned && (!readChecklist(payload.checklistBase, true) || !readChecklist(payload.checklistValue, true))) return invalid();
        const opening = validateNativeTaskEditorOpeningFields(openingInput, beforeTask, validateField);
        if (!opening.ok) return opening;
        const editedGrammar = readNativeTaskDraftSaveRequest({ id: payload.taskID, base, patch: edited,
            scheduleBase: scheduleOwned ? payload.scheduleBase : opening.value.freshScheduleBase,
            ...(recurrenceOwned ? { recurrenceBase: payload.recurrenceBase } : {}) }, validateField, true, true);
        if (!editedGrammar) return invalid();
        const current = { ...opening.value.freshDraft, ...Object.fromEntries(Object.entries(edited)
            .map(([key, value]) => [key, value === null && NATIVE_NULLABLE_DRAFT_FIELDS.includes(key) ? undefined : value])) } as TaskDraft;
        const attachmentBase = readNativeAttachments(payload.attachmentsBase), attachments = readNativeAttachments(payload.attachments);
        if (!attachmentBase || !attachments || !record(captured.saveRequest)) return invalid();
        const request = captured.saveRequest;
        const attachmentChanged = !taskEditValuesEqual(attachmentBase, attachments);
        if (own(request, 'attachments') !== (complete || attachmentChanged) || (complete || attachmentChanged) && (!exact(request.attachments, ['base', 'value'])
            || !taskEditValuesEqual(request.attachments.base, attachmentBase) || !taskEditValuesEqual(request.attachments.value, attachments))) return invalid();
        if (complete && (!exact(request, ['id', 'requestId', 'base', 'patch', 'scheduleBase', 'checklist', 'attachments',
            ...(own(request, 'recurrenceBase') ? ['recurrenceBase'] : []), ...(own(request, 'intent') ? ['intent'] : [])])
            || typeof request.requestId !== 'string' || request.requestId.length !== 36
            || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(request.requestId)
            || own(request, 'intent') && request.intent !== 'cancel' && request.intent !== 'skip'
            || !exact(request.checklist, ['base', 'value']))) return invalid();
        if (complete) {
            const checklist = request.checklist as Record<string, unknown>;
            const checklistBase = readChecklist(checklist.base, true), checklistValue = readChecklist(checklist.value, true);
            if (!checklistBase || !checklistValue || !taskEditValuesEqual(checklistBase, checklistOwned ? payload.checklistBase : opening.value.freshChecklistBase)
                || !taskEditValuesEqual(checklistValue, checklistOwned ? payload.checklistValue : opening.value.freshChecklistBase)) return invalid();
        }


        const surrogate = { base: [], value: [{ id: '00000000-0000-4000-8000-000000000000', kind: 'link', title: 'Grammar',
            uri: 'https://example.invalid/', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' }] };
        const { requestId: _requestId, checklist: _checklist, intent: _intent, attachments: _attachments, ...completeFields } = request;
        const parsed = complete ? readNativeTaskDraftSaveRequest(completeFields, validateField, true, true)
            : readNativeTaskDraftSaveRequest({ ...request, ...(attachmentChanged ? { attachments: surrogate } : {}) }, validateField, false, true, true);
        if (!parsed || parsed.id !== payload.taskID || !taskEditValuesEqual(parsed.scheduleBase, opening.value.freshScheduleBase)
            || scheduleOwned && !taskEditValuesEqual(parsed.scheduleBase, payload.scheduleBase)) return invalid();
        const changed = new Set(touched.filter((field) => !taskEditValuesEqual(base[field], edited[field])));
        for (const group of (complete ? [ASSOCIATIONS, RECURRENCE, LIFECYCLE] : [ASSOCIATIONS, RECURRENCE]))
            if (group.some((field) => changed.has(field))) group.forEach((field) => changed.add(field));
        if (!exact(parsed.patch, [...changed]) || !exact(parsed.base, [...changed])
            || [...changed].some((field) => !taskEditValuesEqual(parsed.patch[field as keyof typeof parsed.patch], edited[field])
                || !taskEditValuesEqual(parsed.base[field as keyof typeof parsed.base], base[field]))
            || own(parsed, 'recurrenceBase') !== RECURRENCE.some((field) => changed.has(field))
            || own(parsed, 'recurrenceBase') && !taskEditValuesEqual(parsed.recurrenceBase, payload.recurrenceBase)) return invalid();
        const raw = payload.raw;
        for (const [rawField, field] of [['title', 'title'], ['note', 'description'], ['location', 'location']]) {
            if (raw[rawField] !== (touched.includes(field) ? edited[field] : '')) return invalid();
        }
        const estimate = touched.includes('timeEstimate') ? getTaskEditorTimeEstimate(current.timeEstimate, (key) => key).customText : '';
        if (raw.estimate !== estimate || raw.estimateResolved !== estimate || typeof raw.timeSpent !== 'string'
            || raw.timeSpent !== raw.timeSpentResolved || (touched.includes('timeSpentMinutes')
                ? !numberDisplay(raw.timeSpent, current.timeSpentMinutes) : raw.timeSpent !== '')) return invalid();
        const tokens = TOKEN_FIELDS.filter((field) => touched.includes(field));
        if (![raw.tokens, raw.tokenCanonical, raw.tokenResolved].every((entry) => exact(entry, tokens))
            || !Array.isArray(raw.tokenEdited) || new Set(raw.tokenEdited).size !== raw.tokenEdited.length
            || raw.tokenEdited.some((field) => !tokens.includes(field as typeof tokens[number]))) return invalid();
        for (const field of tokens) {
            const value = edited[field];
            if (typeof value !== 'string' || [raw.tokens, raw.tokenCanonical, raw.tokenResolved]
                .some((entry) => (entry as Record<string, unknown>)[field] !== value)) return invalid();
            if (!raw.tokenEdited.includes(field)) {
                if (!taskEditValuesEqual(value, base[field])) return invalid();
            } else if (field !== 'assignedTo' && getTaskEditorSuggestions({ field, text: value, limit: 0,
                knownTokens: [], usage: [], people: [], tasks: [] }).draftValue !== value) return invalid();
        }
        if (!exact(raw.checklistInputs, []) || raw.checklistAppend !== '' || raw.relativeOwned !== false || raw.relativeCommitRequested !== false
            || !Array.isArray(raw.recurrenceOwned) || raw.recurrenceOwned.length !== 0
            || !Array.isArray(raw.recurrenceCommitRequested) || raw.recurrenceCommitRequested.length !== 0) return invalid();
        const relative = scheduleOwned ? getTaskEditorRelativeStart(current, (key) => key) : null;
        const amount = relative ? safeIntegerDisplay(relative.amount) : '';
        if (amount === null || raw.relativeAmount !== amount || raw.relativeUnit !== (relative?.unit ?? '')) return invalid();
        if (recurrenceOwned) {
            const values = getTaskEditorRecurrenceInputValues(current, getTaskEditorDailyInterval(current.recurrence, current.recurrenceRRule));
            const interval = safeIntegerDisplay(values.interval), count = safeIntegerDisplay(values.count);
            if (interval === null || count === null || !exact(raw.recurrenceInputs, ['interval', 'count'])
                || raw.recurrenceInputs.interval !== interval || raw.recurrenceInputs.count !== count) return invalid();
        } else if (!exact(raw.recurrenceInputs, [])) return invalid();
        return { ok: true, value: { kind: 'ready' } };
    } catch { return invalid(); }
}
