import type { NativeHostResult } from './native-host-contract';
import { createOwnedFileTaskDraftSaveAuthority, LIFECYCLE, readNativeTaskDraftSaveRequest,
    type NativeTaskDraftSaveDependencies, type NativeTaskDraftSaveRequest,
    type NativePreparedTaskDraftSaveV2 } from './native-host-contract-task-save';
import { validateNativeAttachmentDraftLineageV2, type NativeAttachmentDraftLineageInputV2 } from './native-attachment-draft';
import { captureNativeOwnedFileAddSaveData, mergeNativeOwnedFileAddAttachments, readNativeOwnedFileAddHalf } from './native-host-contract-owned-file-save';
import { validateNativeTaskEditorSaveCheckpoint } from './native-task-editor-save-checkpoint';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { taskEditValuesEqual } from './json-value-equality';
import { createTaskDraft, type TaskDraft } from './task-draft';
import type { NativeTaskLinkHalf } from './native-host-contract-attachments';

const REQUEST_BYTES = 8 * 1024 * 1024;
const PREPARED_BYTES = 16 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const KIND = 'owned-editor-file-add-save' as const;
export type OwnedEditorFileAddSaveRequest = {
    version: 1; kind: typeof KIND;
    checkpoint: { version: 1; sessionID: string; taskID: string; generation: number; payloadJSON: string };
    ownedDraft: NativeAttachmentDraftLineageInputV2;
    saveRequest: NativeTaskDraftSaveRequest & { attachments: NativeTaskLinkHalf };
};
export type PreparedOwnedEditorFileAddSave = Omit<NativePreparedTaskDraftSaveV2, 'version' | 'request'> & {
    version: 1; kind: typeof KIND; request: OwnedEditorFileAddSaveRequest;
};
type Envelope = { request: OwnedEditorFileAddSaveRequest; prepared: PreparedOwnedEditorFileAddSave };
type Result = { id: string; draft: TaskDraft };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value: object, field: string) => Object.prototype.hasOwnProperty.call(value, field);
const exact = (value: unknown, fields: readonly string[]): value is Record<string, unknown> => record(value)
    && Object.keys(value).length === fields.length && fields.every((field) => own(value, field));
const invalid = (): NativeHostResult<never> => ({ ok: false, error: { code: 'INVALID_INPUT', message: 'A bounded owned-editor file Add Save and complete checkpoint are required' } });


export function createOwnedEditorFileAddTaskDraftSaveMethods(deps: NativeTaskDraftSaveDependencies) {
    const readSaveRequest = (input: unknown): OwnedEditorFileAddSaveRequest['saveRequest'] | null => {
        if (!record(input) || !exact(input, ['id', 'base', 'patch', 'scheduleBase', 'attachments',
            ...(own(input, 'recurrenceBase') ? ['recurrenceBase'] : [])]) || !record(input.patch)
            || LIFECYCLE.some((field) => own(input.patch as object, field))) return null;
        const { attachments, ...fieldHalf } = input;


        const fields = readNativeTaskDraftSaveRequest(fieldHalf, deps.validateField, true, true);
        const half = readNativeOwnedFileAddHalf(attachments);
        return fields && half ? { ...fields, attachments: half } : null;
    };
    const readRequest = (input: unknown): OwnedEditorFileAddSaveRequest | null => {
        const value = captureNativeOwnedFileAddSaveData(input, REQUEST_BYTES);
        if (!exact(value, ['version', 'kind', 'checkpoint', 'ownedDraft', 'saveRequest'])
            || value.version !== 1 || value.kind !== KIND
            || !exact(value.checkpoint, ['version', 'sessionID', 'taskID', 'generation', 'payloadJSON'])) return null;
        const checkpoint = value.checkpoint;
        if (checkpoint.version !== 1 || typeof checkpoint.sessionID !== 'string' || !UUID.test(checkpoint.sessionID)
            || typeof checkpoint.generation !== 'number' || !Number.isSafeInteger(checkpoint.generation) || checkpoint.generation < 1
            || typeof checkpoint.payloadJSON !== 'string') return null;
        try {
            const lineage = validateNativeAttachmentDraftLineageV2(value.ownedDraft);
            const owned = value.ownedDraft as NativeAttachmentDraftLineageInputV2;
            if (owned.priorAdditions.length < 1 || checkpoint.generation < owned.priorAdditions.length + 1
                || checkpoint.taskID !== lineage.taskID || checkpoint.payloadJSON !== lineage.payloadJSON) return null;
            const latest = JSON.parse(checkpoint.payloadJSON) as Record<string, unknown>;
            const saveRequest = readSaveRequest(value.saveRequest);
            if (!saveRequest || saveRequest.id !== lineage.taskID
                || !taskEditValuesEqual(saveRequest.attachments.base, latest.attachmentsBase)
                || !taskEditValuesEqual(saveRequest.attachments.value, latest.attachments)) return null;
            return { ...value, saveRequest } as OwnedEditorFileAddSaveRequest;
        } catch { return null; }
    };
    const authority = createOwnedFileTaskDraftSaveAuthority(deps, {
        readRequest: readSaveRequest, mergeAttachments: mergeNativeOwnedFileAddAttachments,
        detachPrepared: (input) => captureNativeOwnedFileAddSaveData(input, PREPARED_BYTES),
    });
    const inner = (prepared: PreparedOwnedEditorFileAddSave): NativePreparedTaskDraftSaveV2 => {
        const { kind: _kind, request, ...fields } = prepared;
        return { ...fields, version: 2, request: request.saveRequest };
    };
    const readEnvelope = (input: unknown): { envelope: Envelope; prepared: NativePreparedTaskDraftSaveV2; result: Result } | null => {
        const value = captureNativeOwnedFileAddSaveData(input, REQUEST_BYTES + PREPARED_BYTES + 128);
        if (!exact(value, ['request', 'prepared']) || !exact(value.prepared,
            ['version', 'kind', 'request', 'preparedAt', 'deviceIdBefore', 'deviceIdToInitialize', 'scope', 'effect'])
            || value.prepared.version !== 1 || value.prepared.kind !== KIND
            || !isNativeJsonWithinBytes(value.prepared, PREPARED_BYTES)) return null;
        const request = readRequest(value.request), repeated = readRequest(value.prepared.request);
        if (!request || !repeated || !taskEditValuesEqual(request, repeated)) return null;
        const frozen = { ...value.prepared, request } as PreparedOwnedEditorFileAddSave;
        const prepared = authority.readPrepared(inner(frozen));
        if (!prepared) return null;
        const correspondence = validateNativeTaskEditorSaveCheckpoint({ payloadJSON: request.checkpoint.payloadJSON,
            saveRequest: request.saveRequest, beforeTask: prepared.effect.task.before }, deps.validateField);
        if (!correspondence.ok) return null;
        const result = { id: request.saveRequest.id, draft: createTaskDraft(prepared.effect.task.after) };
        return isNativeJsonWithinBytes(result, PREPARED_BYTES)
            ? { envelope: { request, prepared: frozen }, prepared, result } : null;
    };
    return {
        async prepareOwnedEditorFileAddTaskDraftSave(input: OwnedEditorFileAddSaveRequest): Promise<NativeHostResult<{
            kind: 'prepared'; prepared: PreparedOwnedEditorFileAddSave }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return invalid();
            const result = await authority.prepare(request.saveRequest);
            if (!result.ok) return result;
            if (result.value.kind !== 'prepared') return invalid();
            const prepared: PreparedOwnedEditorFileAddSave = { ...result.value.prepared, version: 1, kind: KIND, request };
            const checked = readEnvelope({ request, prepared });
            return checked ? { ok: true, value: { kind: 'prepared', prepared: checked.envelope.prepared } } : invalid();
        },
        validatePreparedOwnedEditorFileAddTaskDraftSave(input: Envelope): NativeHostResult<{
            version: 1; kind: typeof KIND; result: Result }> {
            const checked = readEnvelope(input);
            return checked ? { ok: true, value: { version: 1, kind: KIND, result: checked.result } } : invalid();
        },
        async commitPreparedOwnedEditorFileAddTaskDraftSave(input: Envelope): Promise<NativeHostResult<Result>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const checked = readEnvelope(input);


            return checked ? authority.commit(checked.prepared, checked.envelope) : invalid();
        },
    };
}
