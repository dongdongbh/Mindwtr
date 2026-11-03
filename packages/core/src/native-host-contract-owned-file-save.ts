import type { NativeHostResult } from './native-host-contract';
import { createOwnedFileTaskDraftSaveAuthority, readNativeTaskDraftSaveRequest,
    type NativeTaskDraftSaveDependencies, type NativeTaskDraftSaveRequest,
    type NativePreparedTaskDraftSaveV2 } from './native-host-contract-task-save';
import { validateNativeAttachmentDraftLineage, type NativeAttachmentDraftLineageInput } from './native-attachment-draft';
import { mergeTaskDraftAttachments } from './attachment-editor-model';
import { readNativeAttachments, readNativeTaskLinkHalf, type NativeTaskLinkHalf } from './native-host-contract-attachments';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { taskEditValuesEqual } from './json-value-equality';
import { createTaskDraft, type TaskDraft } from './task-draft';
import type { Attachment } from './types';

const REQUEST_BYTES = 8 * 1024 * 1024;
const PREPARED_BYTES = 16 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const KIND = 'owned-file-add-save' as const;
export type OwnedFileAddSaveRequest = {
    version: 1; kind: typeof KIND;
    checkpoint: { version: 1; sessionID: string; taskID: string; generation: number; payloadJSON: string };
    ownedDraft: NativeAttachmentDraftLineageInput;
    saveRequest: Omit<NativeTaskDraftSaveRequest, 'base' | 'patch' | 'attachments' | 'recurrenceBase'> & { base: Record<string, never>; patch: Record<string, never>;
        attachments: NativeTaskLinkHalf };
};
export type PreparedOwnedFileAddSave = Omit<NativePreparedTaskDraftSaveV2, 'version' | 'request'> & {
    version: 1; kind: typeof KIND; request: OwnedFileAddSaveRequest;
};
type Envelope = { request: OwnedFileAddSaveRequest; prepared: PreparedOwnedFileAddSave };
type Result = { id: string; draft: TaskDraft };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value: object, field: string) => Object.prototype.hasOwnProperty.call(value, field);
const exact = (value: unknown, fields: readonly string[]): value is Record<string, unknown> => record(value)
    && Object.keys(value).length === fields.length && fields.every((field) => own(value, field));
const invalid = (): NativeHostResult<never> => ({ ok: false, error: { code: 'INVALID_INPUT', message: 'A bounded owned-file Add Save and exact checkpoint are required' } });


const capture = (input: unknown, bytes: number): unknown => {
    let remainingNodes = 100_000;
    const check = (value: unknown, depth: number): boolean => {

        if (--remainingNodes < 0 || depth > 40) return false;
        if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
        if (typeof value === 'number') return Number.isFinite(value);
        if (Array.isArray(value)) {
            if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 10_000 || Reflect.ownKeys(value).length !== value.length + 1) return false;
            for (let index = 0; index < value.length; index++) {
                const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
                if (!descriptor?.enumerable || !own(descriptor, 'value') || !check(descriptor.value, depth + 1)) return false;
            }
            return true;
        }
        if (!record(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
        const names = Reflect.ownKeys(value);
        return names.length <= 256 && names.every((name) => {
            if (typeof name !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(name)) return false;
            const descriptor = Object.getOwnPropertyDescriptor(value, name);
            return !!descriptor?.enumerable && own(descriptor, 'value') && check(descriptor.value, depth + 1);
        });
    };
    try { return check(input, 0) && isNativeJsonWithinBytes(input, bytes) ? JSON.parse(JSON.stringify(input)) : null; }
    catch { return null; }
};
const payload = (json: string): Record<string, unknown> | null => {
    try { const value: unknown = JSON.parse(json); return record(value) ? value : null; }
    catch { return null; }
};


export { capture as captureNativeOwnedFileAddSaveData };
export const readNativeOwnedFileAddHalf = (input: unknown): NativeTaskLinkHalf | null => {
    if (!exact(input, ['base', 'value'])) return null;
    const base = readNativeAttachments(input.base), value = readNativeAttachments(input.value);
    if (!base || !value) return null;
    const old = new Map(base.map((item) => [item.id, item]));
    if (base.some((before) => !taskEditValuesEqual(before, value.find((item) => item.id === before.id)))
        || value.length <= base.length || value.some((item) => !old.has(item.id) && item.kind !== 'file')) return null;
    return { base, value };
};
export const mergeNativeOwnedFileAddAttachments = (stored: readonly Attachment[], half: NativeTaskLinkHalf): Attachment[] | null => {
    const baseIDs = new Set(half.base.map((item) => item.id));
    const additions = half.value.filter((item) => !baseIDs.has(item.id));
    if (stored.some((item) => additions.some((added) => added.id === item.id))) return null;
    const merged = mergeTaskDraftAttachments(stored, half.base, half.value);
    if (stored.some((item) => !taskEditValuesEqual(item, merged.find((row) => row.id === item.id)))
        || additions.some((item) => !taskEditValuesEqual(item, merged.find((row) => row.id === item.id)))) return null;
    return readNativeAttachments(merged);
};


export function createOwnedFileAddTaskDraftSaveMethods(deps: NativeTaskDraftSaveDependencies) {
    const readSaveRequest = (input: unknown): OwnedFileAddSaveRequest['saveRequest'] | null => {
        if (!exact(input, ['id', 'base', 'patch', 'scheduleBase', 'attachments'])
            || !exact(input.base, []) || !exact(input.patch, []) || !exact(input.attachments, ['base', 'value'])) return null;


        const fields = readNativeTaskDraftSaveRequest({ id: input.id, base: input.base, patch: input.patch,
            scheduleBase: input.scheduleBase }, deps.validateField, true, true);
        const half = readNativeOwnedFileAddHalf(input.attachments);
        return fields && half ? { ...fields, base: {}, patch: {}, attachments: half } : null;
    };
    const readRequest = (input: unknown): OwnedFileAddSaveRequest | null => {
        const value = capture(input, REQUEST_BYTES);
        if (!exact(value, ['version', 'kind', 'checkpoint', 'ownedDraft', 'saveRequest'])
            || value.version !== 1 || value.kind !== KIND
            || !exact(value.checkpoint, ['version', 'sessionID', 'taskID', 'generation', 'payloadJSON'])) return null;
        const checkpoint = value.checkpoint;
        if (checkpoint.version !== 1 || typeof checkpoint.sessionID !== 'string' || !UUID.test(checkpoint.sessionID)
            || typeof checkpoint.generation !== 'number' || !Number.isSafeInteger(checkpoint.generation) || checkpoint.generation < 1
            || typeof checkpoint.payloadJSON !== 'string') return null;
        try {
            const lineage = validateNativeAttachmentDraftLineage(value.ownedDraft);
            const owned = value.ownedDraft as NativeAttachmentDraftLineageInput;
            if (owned.priorAdditions.length < 1 || checkpoint.generation < owned.priorAdditions.length + 1
                || checkpoint.taskID !== lineage.taskID || checkpoint.payloadJSON !== lineage.payloadJSON) return null;
            const initial = payload(owned.initialPayloadJSON), final = payload(checkpoint.payloadJSON);
            if (!exact(initial, ['version', 'taskID', 'attachmentsOwned', 'attachmentsBase', 'attachments'])
                || !taskEditValuesEqual(initial.attachmentsBase, initial.attachments)
                || !readNativeTaskLinkHalf({ base: initial.attachmentsBase, value: initial.attachments }, false) || !final) return null;
            const saveRequest = readSaveRequest(value.saveRequest);
            if (!saveRequest || saveRequest.id !== lineage.taskID
                || !taskEditValuesEqual(saveRequest.attachments.base, initial.attachmentsBase)
                || !taskEditValuesEqual(saveRequest.attachments.value, final.attachments)) return null;
            return { ...value, saveRequest } as OwnedFileAddSaveRequest;
        } catch { return null; }
    };
    const authority = createOwnedFileTaskDraftSaveAuthority(deps, {
        readRequest: readSaveRequest, mergeAttachments: mergeNativeOwnedFileAddAttachments,
        detachPrepared: (input) => capture(input, PREPARED_BYTES),
    });
    const inner = (prepared: PreparedOwnedFileAddSave): NativePreparedTaskDraftSaveV2 => {
        const { kind: _kind, request, ...fields } = prepared;
        return { ...fields, version: 2, request: request.saveRequest };
    };
    const boundedResult = (prepared: PreparedOwnedFileAddSave): Result | null => {
        const result = { id: prepared.request.saveRequest.id, draft: createTaskDraft(prepared.effect.task.after) };
        return isNativeJsonWithinBytes(result, PREPARED_BYTES) ? result : null;
    };
    const readEnvelope = (input: unknown): { envelope: Envelope; prepared: NativePreparedTaskDraftSaveV2; result: Result } | null => {
        const value = capture(input, REQUEST_BYTES + PREPARED_BYTES + 128);
        if (!exact(value, ['request', 'prepared']) || !exact(value.prepared,
            ['version', 'kind', 'request', 'preparedAt', 'deviceIdBefore', 'deviceIdToInitialize', 'scope', 'effect'])
            || value.prepared.version !== 1 || value.prepared.kind !== KIND
            || !isNativeJsonWithinBytes(value.prepared, PREPARED_BYTES)) return null;
        const request = readRequest(value.request), repeated = readRequest(value.prepared.request);
        if (!request || !repeated || !taskEditValuesEqual(request, repeated)) return null;
        const frozen = { ...value.prepared, request } as PreparedOwnedFileAddSave;
        const prepared = authority.readPrepared(inner(frozen));
        if (!prepared) return null;
        const result = boundedResult(frozen);
        return result ? { envelope: { request, prepared: frozen }, prepared, result } : null;
    };
    return {
        async prepareOwnedFileAddTaskDraftSave(input: OwnedFileAddSaveRequest): Promise<NativeHostResult<{
            kind: 'prepared'; prepared: PreparedOwnedFileAddSave }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return invalid();
            const result = await authority.prepare(request.saveRequest);
            if (!result.ok) return result;
            if (result.value.kind !== 'prepared') return invalid();
            const prepared: PreparedOwnedFileAddSave = { ...result.value.prepared, version: 1, kind: KIND, request };
            const checked = readEnvelope({ request, prepared });
            return checked ? { ok: true, value: { kind: 'prepared', prepared: checked.envelope.prepared } } : invalid();
        },
        validatePreparedOwnedFileAddTaskDraftSave(input: Envelope): NativeHostResult<{
            version: 1; kind: typeof KIND; result: Result }> {
            const checked = readEnvelope(input);
            return checked ? { ok: true, value: { version: 1, kind: KIND, result: checked.result } } : invalid();
        },
        async commitPreparedOwnedFileAddTaskDraftSave(input: Envelope): Promise<NativeHostResult<Result>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const checked = readEnvelope(input);


            return checked ? authority.commit(checked.prepared, checked.envelope) : invalid();
        },
    };
}
