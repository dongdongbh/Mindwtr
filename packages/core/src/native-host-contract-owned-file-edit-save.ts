import type { NativeHostResult } from './native-host-contract';
import { createOwnedFileTaskDraftSaveAuthority, LIFECYCLE, readNativeTaskDraftSaveRequest,
    type NativeTaskDraftSaveDependencies, type NativeTaskDraftSaveRequest,
    type NativePreparedTaskDraftSaveV2, type NativeOwnedTaskDraftNoopDecision } from './native-host-contract-task-save';
import { validateNativeAttachmentDraftLineageV3, validateNativeAttachmentDraftLineageV4, validateNativeAttachmentDraftLineageV5, type NativeAttachmentDraftLineageInputV3, type NativeAttachmentDraftLineageInputV4, type NativeAttachmentDraftLineageInputV5 } from './native-attachment-draft';
import { captureNativeOwnedFileAddSaveData } from './native-host-contract-owned-file-save';
import { readNativeAttachments, type NativeTaskLinkHalf } from './native-host-contract-attachments';
import { mergeTaskDraftAttachments } from './attachment-editor-model';
import { planAttachmentDraftSettlement, type AttachmentDraftCleanupCandidate } from './attachment-draft-settlement';
import { validateNativeTaskEditorSaveCheckpoint, validateNativeOwnedCompleteTaskEditorSaveCheckpoint } from './native-task-editor-save-checkpoint';
import { createOwnedCompleteTaskChecklistSaveAuthority, type NativeTaskChecklistSaveDependencies,
    type NativeOwnedCompleteChecklistSaveRequest, type NativeOwnedCompleteChecklistDecision,
    type NativeOwnedCompleteChecklistCancellation, type NativeTaskCancellationUndoRequest,
    type NativePreparedOwnedCompleteCancellationUndo } from './native-host-contract-task-checklist';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { taskEditValuesEqual } from './json-value-equality';
import { createTaskDraft, type TaskDraft } from './task-draft';

const REQUEST_BYTES = 8 * 1024 * 1024;
const PREPARED_BYTES = 16 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const KIND = 'owned-editor-file-edit-save' as const;
export type OwnedEditorFileEditSaveRequest = {
    version: 1; kind: typeof KIND;
    checkpoint: { version: 1; sessionID: string; taskID: string; generation: number; payloadJSON: string };
    ownedDraft: NativeAttachmentDraftLineageInputV3;
    saveRequest: NativeTaskDraftSaveRequest & { attachments: NativeTaskLinkHalf };
};
export type OwnedEditorFileEditSaveDecision = { kind: 'changed'; prepared: NativePreparedTaskDraftSaveV2 }
    | NativeOwnedTaskDraftNoopDecision;
export type PreparedOwnedEditorFileEditSave = {
    version: 1; kind: typeof KIND; request: OwnedEditorFileEditSaveRequest;
    decision: OwnedEditorFileEditSaveDecision;
};
export type OwnedEditorFileEditSaveEnvelope = { request: OwnedEditorFileEditSaveRequest; prepared: PreparedOwnedEditorFileEditSave };
type Result = { id: string; draft: TaskDraft };
type Validation = { version: 1; kind: typeof KIND; result: Result; settlementPlan: AttachmentDraftCleanupCandidate[] };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value: object, field: string) => Object.prototype.hasOwnProperty.call(value, field);
const exact = (value: unknown, fields: readonly string[]): value is Record<string, unknown> => record(value)
    && Object.keys(value).length === fields.length && fields.every((field) => own(value, field));
const invalid = (): NativeHostResult<never> => ({ ok: false, error: { code: 'INVALID_INPUT',
    message: 'A bounded mixed file-edit Save and complete checkpoint are required' } });

/** Unbound metadata/settlement authority only. Native ownership and file proofs remain separate. */
export function createOwnedEditorFileEditTaskDraftSaveMethods(deps: NativeTaskDraftSaveDependencies) {
    const readSaveRequest = (input: unknown): OwnedEditorFileEditSaveRequest['saveRequest'] | null => {
        if (!record(input) || !exact(input, ['id', 'base', 'patch', 'scheduleBase', 'attachments',
            ...(own(input, 'recurrenceBase') ? ['recurrenceBase'] : [])]) || !record(input.patch)
            || LIFECYCLE.some((field) => own(input.patch as object, field))
            || !exact(input.attachments, ['base', 'value'])) return null;
        const { attachments, ...fields } = input;
        const parsed = readNativeTaskDraftSaveRequest(fields, deps.validateField, true, true);
        const base = readNativeAttachments(attachments.base), value = readNativeAttachments(attachments.value);
        return parsed && base && value ? { ...parsed, attachments: { base, value } } : null;
    };
    const readRequest = (input: unknown): OwnedEditorFileEditSaveRequest | null => {
        const value = captureNativeOwnedFileAddSaveData(input, REQUEST_BYTES);
        if (!exact(value, ['version', 'kind', 'checkpoint', 'ownedDraft', 'saveRequest'])
            || value.version !== 1 || value.kind !== KIND
            || !exact(value.checkpoint, ['version', 'sessionID', 'taskID', 'generation', 'payloadJSON'])) return null;
        const checkpoint = value.checkpoint;
        if (checkpoint.version !== 1 || typeof checkpoint.sessionID !== 'string' || checkpoint.sessionID.length !== 36 || !UUID.test(checkpoint.sessionID)
            || typeof checkpoint.generation !== 'number' || !Number.isSafeInteger(checkpoint.generation) || checkpoint.generation < 1
            || typeof checkpoint.payloadJSON !== 'string') return null;
        try {
            const lineage = validateNativeAttachmentDraftLineageV3(value.ownedDraft);
            const history = value.ownedDraft as NativeAttachmentDraftLineageInputV3;
            if (!history.priorOperations.length || checkpoint.generation < history.priorOperations.length + 1
                || checkpoint.taskID !== lineage.taskID || checkpoint.payloadJSON !== lineage.payloadJSON) return null;
            const latest = JSON.parse(checkpoint.payloadJSON) as Record<string, unknown>;
            const saveRequest = readSaveRequest(value.saveRequest);
            if (!saveRequest || saveRequest.id !== lineage.taskID
                || !taskEditValuesEqual(saveRequest.attachments.base, latest.attachmentsBase)
                || !taskEditValuesEqual(saveRequest.attachments.value, latest.attachments)) return null;
            return { ...value, saveRequest } as OwnedEditorFileEditSaveRequest;
        } catch { return null; }
    };
    const authority = createOwnedFileTaskDraftSaveAuthority(deps, {
        readRequest: readSaveRequest,
        mergeAttachments: (stored, half) => readNativeAttachments(mergeTaskDraftAttachments(stored, half.base, half.value)),
        detachPrepared: (input) => captureNativeOwnedFileAddSaveData(input, PREPARED_BYTES),
    });
    const readEnvelope = (input: unknown): { envelope: OwnedEditorFileEditSaveEnvelope; validation: Validation } | null => {
        const value = captureNativeOwnedFileAddSaveData(input, REQUEST_BYTES + PREPARED_BYTES + 128);
        if (!exact(value, ['request', 'prepared']) || !exact(value.prepared, ['version', 'kind', 'request', 'decision'])
            || value.prepared.version !== 1 || value.prepared.kind !== KIND
            || !isNativeJsonWithinBytes(value.prepared, PREPARED_BYTES)) return null;
        const request = readRequest(value.request), repeated = readRequest(value.prepared.request);
        if (!request || !repeated || !taskEditValuesEqual(request, repeated) || !record(value.prepared.decision)) return null;
        let decision: OwnedEditorFileEditSaveDecision;
        if (value.prepared.decision.kind === 'changed') {
            if (!exact(value.prepared.decision, ['kind', 'prepared'])) return null;
            const prepared = authority.readPrepared(value.prepared.decision.prepared);
            if (!prepared || !taskEditValuesEqual(prepared.request, request.saveRequest)) return null;
            decision = { kind: 'changed', prepared };
        } else {
            const noop = authority.readNoop(value.prepared.decision, request.saveRequest);
            if (!noop) return null;
            decision = noop;
        }
        const effect = decision.kind === 'changed' ? decision.prepared.effect : decision.effect;
        const correspondence = validateNativeTaskEditorSaveCheckpoint({ payloadJSON: request.checkpoint.payloadJSON,
            saveRequest: request.saveRequest, beforeTask: effect.task.before }, deps.validateField);
        if (!correspondence.ok) return null;
        const result = { id: request.saveRequest.id, draft: createTaskDraft(effect.task.after) };
        const settlementPlan = planAttachmentDraftSettlement({ baselineAttachments: request.saveRequest.attachments.base,
            draftAttachments: request.saveRequest.attachments.value, committedAttachments: effect.task.after.attachments });
        const validation: Validation = { version: 1, kind: KIND, result, settlementPlan };
        // The complete actual plan is bounded together with the result. No 128-candidate clipping.
        if (!isNativeJsonWithinBytes(validation, PREPARED_BYTES)) return null;
        return { envelope: { request, prepared: { version: 1, kind: KIND, request, decision } }, validation };
    };
    return {
        async prepareOwnedEditorFileEditTaskDraftSave(input: OwnedEditorFileEditSaveRequest): Promise<NativeHostResult<{
            kind: 'prepared'; prepared: PreparedOwnedEditorFileEditSave }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return invalid();
            const selected = await authority.prepareDecision(request.saveRequest);
            if (!selected.ok) return selected;
            const checked = readEnvelope({ request, prepared: { version: 1, kind: KIND, request, decision: selected.value } });
            return checked ? { ok: true, value: { kind: 'prepared', prepared: checked.envelope.prepared } } : invalid();
        },
        validatePreparedOwnedEditorFileEditTaskDraftSave(input: OwnedEditorFileEditSaveEnvelope): NativeHostResult<Validation> {
            const checked = readEnvelope(input);
            return checked ? { ok: true, value: checked.validation } : invalid();
        },
        async commitPreparedOwnedEditorFileEditTaskDraftSave(input: OwnedEditorFileEditSaveEnvelope): Promise<NativeHostResult<Result>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const checked = readEnvelope(input);
            if (!checked) return invalid();
            const decision = checked.envelope.prepared.decision;
            return decision.kind === 'changed' ? authority.commit(decision.prepared, checked.envelope)
                : authority.confirmNoop(decision, checked.envelope.request.saveRequest);
        },
    };
}

export type OwnedEditorCompleteSaveRequest = {
    version: 2 | 3 | 4; kind: typeof KIND; checkpoint: OwnedEditorFileEditSaveRequest['checkpoint'];
    ownedDraft: NativeAttachmentDraftLineageInputV3 | NativeAttachmentDraftLineageInputV4 | NativeAttachmentDraftLineageInputV5; saveRequest: NativeOwnedCompleteChecklistSaveRequest;
};
export type PreparedOwnedEditorCompleteSave = {
    version: 2 | 3 | 4; kind: typeof KIND; request: OwnedEditorCompleteSaveRequest; decision: NativeOwnedCompleteChecklistDecision;
};
export type OwnedEditorCompleteSaveEnvelope = { request: OwnedEditorCompleteSaveRequest; prepared: PreparedOwnedEditorCompleteSave };
export type OwnedEditorCompleteSaveResult = Result & {
    cancellation?: { cancelledAt: string; undoEnabled: boolean; message: string; undoLabel: string };
};
export type OwnedEditorCompleteSaveValidation = {
    version: 2 | 3 | 4; kind: typeof KIND; result: OwnedEditorCompleteSaveResult; settlementPlan: AttachmentDraftCleanupCandidate[];
};
export type PreparedOwnedEditorCompleteCancellationUndo = NativePreparedOwnedCompleteCancellationUndo & { cancel: OwnedEditorCompleteSaveEnvelope };
export type OwnedEditorCompleteCancellationUndoEnvelope = {
    request: NativeTaskCancellationUndoRequest; prepared: PreparedOwnedEditorCompleteCancellationUndo;
};

/** Internal complete-owned selection. Legacy factories and bridge grammars remain sealed. */
export function createOwnedEditorCompleteTaskDraftSaveMethods(deps: NativeTaskChecklistSaveDependencies) {
    const authority = createOwnedCompleteTaskChecklistSaveAuthority(deps);
    const readRequest = (input: unknown): OwnedEditorCompleteSaveRequest | null => {
        const value = captureNativeOwnedFileAddSaveData(input, REQUEST_BYTES);
        if (!exact(value, ['version', 'kind', 'checkpoint', 'ownedDraft', 'saveRequest']) || (value.version !== 2 && value.version !== 3 && value.version !== 4) || value.kind !== KIND
            || !exact(value.checkpoint, ['version', 'sessionID', 'taskID', 'generation', 'payloadJSON'])) return null;
        const checkpoint = value.checkpoint;
        if (checkpoint.version !== 1 || typeof checkpoint.sessionID !== 'string' || checkpoint.sessionID.length !== 36 || !UUID.test(checkpoint.sessionID)
            || typeof checkpoint.generation !== 'number' || !Number.isSafeInteger(checkpoint.generation) || checkpoint.generation < 1
            || typeof checkpoint.payloadJSON !== 'string') return null;
        try {
            const lineage = (value.version === 4 ? validateNativeAttachmentDraftLineageV5 : value.version === 3 ? validateNativeAttachmentDraftLineageV4 : validateNativeAttachmentDraftLineageV3)(value.ownedDraft);
            const history = value.ownedDraft as NativeAttachmentDraftLineageInputV3;
            if (checkpoint.generation < history.priorOperations.length + 1 || checkpoint.taskID !== lineage.taskID
                || checkpoint.payloadJSON !== lineage.payloadJSON) return null;
            const latest = JSON.parse(checkpoint.payloadJSON) as Record<string, unknown>, saveRequest = authority.readRequest(value.saveRequest);
            if (!saveRequest || saveRequest.id !== lineage.taskID || !taskEditValuesEqual(saveRequest.attachments.base, latest.attachmentsBase)
                || !taskEditValuesEqual(saveRequest.attachments.value, latest.attachments)) return null;
            return { ...value, saveRequest } as OwnedEditorCompleteSaveRequest;
        } catch { return null; }
    };
    const readEnvelope = (input: unknown): { envelope: OwnedEditorCompleteSaveEnvelope; validation: OwnedEditorCompleteSaveValidation } | null => {
        const value = captureNativeOwnedFileAddSaveData(input, REQUEST_BYTES + PREPARED_BYTES + 128);
        if (!exact(value, ['request', 'prepared']) || !exact(value.prepared, ['version', 'kind', 'request', 'decision'])
            || !record(value.request) || value.prepared.version !== value.request.version || (value.prepared.version !== 2 && value.prepared.version !== 3 && value.prepared.version !== 4) || value.prepared.kind !== KIND || !isNativeJsonWithinBytes(value.prepared, PREPARED_BYTES)) return null;
        const request = readRequest(value.request), repeated = readRequest(value.prepared.request), decision = authority.readDecision(value.prepared.decision);
        if (!request || !repeated || !decision || !taskEditValuesEqual(request, repeated)
            || !taskEditValuesEqual(decision.prepared.request, request.saveRequest)) return null;
        const before = decision.prepared.witness.source;
        const after = decision.kind === 'changed' ? decision.prepared.effect.tasks.find((row) => row.after.id === request.saveRequest.id)?.after : before;
        if (!after || !validateNativeOwnedCompleteTaskEditorSaveCheckpoint({ payloadJSON: request.checkpoint.payloadJSON,
            saveRequest: request.saveRequest, beforeTask: before }, deps.validateField).ok) return null;
        const checklistResult = decision.prepared.result;
        const result: OwnedEditorCompleteSaveResult = { id: request.saveRequest.id, draft: createTaskDraft(after),
            ...('cancellation' in checklistResult ? { cancellation: checklistResult.cancellation } : {}) };
        // Empty file history grants no cleanup ownership, including old baseline tombstones.
        const settlementPlan = request.ownedDraft.priorOperations.length === 0 ? [] : planAttachmentDraftSettlement({
            baselineAttachments: request.saveRequest.attachments.base, draftAttachments: request.saveRequest.attachments.value,
            committedAttachments: after.attachments });
        const validation: OwnedEditorCompleteSaveValidation = { version: request.version, kind: KIND, result, settlementPlan };
        if (!isNativeJsonWithinBytes(validation, PREPARED_BYTES)) return null;
        return { envelope: { request, prepared: { version: request.version, kind: KIND, request, decision } }, validation };
    };
    const cancellation = (input: unknown): { envelope: OwnedEditorCompleteSaveEnvelope; proof: NativeOwnedCompleteChecklistCancellation } | null => {
        const checked = readEnvelope(input);
        if (!checked || checked.envelope.request.saveRequest.intent !== 'cancel' || checked.envelope.prepared.decision.kind !== 'changed') return null;
        return { envelope: checked.envelope, proof: { request: checked.envelope.request.saveRequest as NativeOwnedCompleteChecklistCancellation['request'],
            prepared: checked.envelope.prepared.decision.prepared } };
    };
    const readUndo = (input: unknown): { envelope: OwnedEditorCompleteCancellationUndoEnvelope; cancel: NonNullable<ReturnType<typeof cancellation>> } | null => {
        const value = captureNativeOwnedFileAddSaveData(input, REQUEST_BYTES + PREPARED_BYTES + 128);
        if (!exact(value, ['request', 'prepared']) || !record(value.prepared) || !isNativeJsonWithinBytes(value.prepared, PREPARED_BYTES)) return null;
        const cancel = cancellation(value.prepared.cancel);
        if (!cancel || !authority.readUndo(value, cancel.proof, cancel.envelope)) return null;
        return { envelope: value as unknown as OwnedEditorCompleteCancellationUndoEnvelope, cancel };
    };
    return {
        async prepareOwnedEditorCompleteTaskDraftSave(input: OwnedEditorCompleteSaveRequest): Promise<NativeHostResult<{
            kind: 'prepared'; prepared: PreparedOwnedEditorCompleteSave }>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const request = readRequest(input); if (!request) return invalid();
            const selected = await authority.prepareDecision(request.saveRequest); if (!selected.ok) return selected;
            const checked = readEnvelope({ request, prepared: { version: request.version, kind: KIND, request, decision: selected.value } });
            return checked ? { ok: true, value: { kind: 'prepared', prepared: checked.envelope.prepared } } : invalid();
        },
        validatePreparedOwnedEditorCompleteTaskDraftSave(input: OwnedEditorCompleteSaveEnvelope): NativeHostResult<OwnedEditorCompleteSaveValidation> {
            const checked = readEnvelope(input); return checked ? { ok: true, value: checked.validation } : invalid();
        },
        async commitPreparedOwnedEditorCompleteTaskDraftSave(input: OwnedEditorCompleteSaveEnvelope): Promise<NativeHostResult<OwnedEditorCompleteSaveResult>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const checked = readEnvelope(input); if (!checked) return invalid();
            const committed = await authority.commitDecision(checked.envelope.prepared.decision, checked.envelope);
            return committed.ok ? { ok: true, value: checked.validation.result } : committed;
        },
        async prepareOwnedEditorCompleteTaskCancellationUndo(input: { request: NativeTaskCancellationUndoRequest; cancel: OwnedEditorCompleteSaveEnvelope }): Promise<NativeHostResult<{
            kind: 'prepared'; prepared: PreparedOwnedEditorCompleteCancellationUndo }>> {
            const value = captureNativeOwnedFileAddSaveData(input, REQUEST_BYTES + PREPARED_BYTES + 128);
            if (!exact(value, ['request', 'cancel'])) return invalid();
            const cancel = cancellation(value.cancel); if (!cancel || !exact(value.request, ['requestId', 'cancelRequestId'])) return invalid();
            const selected = await authority.prepareUndo(value.request as NativeTaskCancellationUndoRequest, cancel.proof, cancel.envelope);
            if (!selected.ok) return selected;
            const checked = readUndo({ request: value.request, prepared: selected.value.prepared });
            return checked ? { ok: true, value: { kind: 'prepared', prepared: checked.envelope.prepared } } : invalid();
        },
        validatePreparedOwnedEditorCompleteTaskCancellationUndo(input: OwnedEditorCompleteCancellationUndoEnvelope): NativeHostResult<{ id: string }> {
            const checked = readUndo(input); return checked ? { ok: true, value: checked.envelope.prepared.result } : invalid();
        },
        async commitPreparedOwnedEditorCompleteTaskCancellationUndo(input: OwnedEditorCompleteCancellationUndoEnvelope): Promise<NativeHostResult<{ id: string }>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const checked = readUndo(input); if (!checked) return invalid();
            return authority.commitUndo(checked.envelope, checked.cancel.proof, checked.cancel.envelope, checked.envelope);
        },
    };
}
