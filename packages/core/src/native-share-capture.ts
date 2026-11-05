import { NativeReceiptSqliteAdapter } from './native-request-receipts';
import { buildPreparedShareCaptureDocument, type NativeShareCaptureMethod } from './native-host-contract-quick-capture';
import type { createNativeHostContract } from './native-host-contract';
import { flushPendingSave, getPersistenceStatus, getStorageAdapter, useTaskStore } from './store';
import { runSerializedSyncDocumentWriteOperation } from './data-transfer-transaction';
import { markNextLoadAsDocumentReplacement } from './store-settings';
import { taskEditValuesEqual } from './json-value-equality';

type Contract = Pick<ReturnType<typeof createNativeHostContract>, 'prepareQuickCapture' | 'prepareQuickCaptureCopilot' | 'prepareQuickCaptureLines'>;
export type NativeShareCaptureIdentity = { id: string; fingerprint: string };
type Request = { source: NativeShareCaptureIdentity; method: NativeShareCaptureMethod; requestFingerprint: string; capture: unknown };
type Plan = { version: 1; request: Request; capture: { request: unknown; prepared: unknown } };
const invalid = () => new Error('INVALID_INPUT: Share capture is invalid');
const unavailable = () => new Error('SAVE_FAILED: Share capture outcome is not proven');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, fields: string[]) => Object.keys(value).length === fields.length && fields.every(field => Object.prototype.hasOwnProperty.call(value, field));
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const identity = (value: unknown): NativeShareCaptureIdentity => {
    if (!record(value) || !exact(value, ['id', 'fingerprint']) || !uuid(value.id) || !hash(value.fingerprint)) throw invalid();
    return { id: value.id, fingerprint: value.fingerprint };
};
const request = (value: unknown): Request => {
    if (!record(value) || !exact(value, ['source', 'method', 'requestFingerprint', 'capture'])
        || !['captureSubmit', 'captureCopilotSubmit', 'captureLinesSubmit'].includes(value.method as string) || !hash(value.requestFingerprint)
        || !record(value.capture)) throw invalid();
    const source = identity(value.source), method = value.method as NativeShareCaptureMethod;
    const capture = method === 'captureCopilotSubmit' ? value.capture.capture : value.capture;
    if (!record(capture) || (method === 'captureLinesSubmit'
        ? !Array.isArray(capture.captureIds) || capture.captureIds[0] !== source.id
        : capture.captureId !== source.id)) throw invalid();
    return { source, method, requestFingerprint: value.requestFingerprint, capture: value.capture };
};
const payload = (source: NativeShareCaptureIdentity) => JSON.stringify(['iosShareCapture', source.id, source.fingerprint]);
const savedReply = (value: unknown, source: NativeShareCaptureIdentity): { version: 1; requestFingerprint: string; result: Record<string, unknown> } => {
    if (!record(value) || !exact(value, ['version', 'requestFingerprint', 'result']) || value.version !== 1 || !hash(value.requestFingerprint)
        || !record(value.result) || value.result.kind !== 'saved') throw unavailable();
    const result = value.result;
    if (Array.isArray(result.taskIds)) {
        if (!exact(result, ['kind', 'taskIds']) || result.taskIds.length < 2 || result.taskIds.length > 1000
            || result.taskIds[0] !== source.id || result.taskIds.some(id => !uuid(id)) || new Set(result.taskIds).size !== result.taskIds.length) throw unavailable();
    } else if (!['kind', 'taskId', 'next', 'reset'].every(field => Object.prototype.hasOwnProperty.call(result, field))
        || Object.keys(result).some(field => !['kind', 'taskId', 'projectId', 'next', 'reset'].includes(field)) || result.taskId !== source.id
        || result.projectId !== undefined && (typeof result.projectId !== 'string' || !result.projectId || result.projectId.length > 500)
        || !['open', 'close', 'addAnother'].includes(result.next as string)
        || (result.next === 'addAnother' ? !record(result.reset) : result.reset !== null)) throw unavailable();
    return { version: 1, requestFingerprint: value.requestFingerprint, result };
};

export function createNativeShareCaptureMethods(deps: { contract: Contract; current: () => void }) {
    const adapter = () => {
        deps.current();
        const selected = getStorageAdapter(), status = getPersistenceStatus();
        if (!(selected instanceof NativeReceiptSqliteAdapter) || !selected.concurrentWritesGuarded
            || status.failed || status.queued || status.inFlight || status.immediate || status.retrying) throw unavailable();
        return selected;
    };
    const probe = async (source: NativeShareCaptureIdentity, selected = adapter()) => {
        const result = await selected.readDurableReceipt(source.id, payload(source), { committedOnly: true });
        deps.current(); if (getStorageAdapter() !== selected || !result.ok) throw unavailable();
        return result.value === null ? null : savedReply(result.value, source);
    };
    const readPlan = (value: unknown): Plan => {
        if (!record(value) || !exact(value, ['version', 'request', 'capture']) || value.version !== 1
            || !record(value.capture) || !exact(value.capture, ['request', 'prepared'])) throw invalid();
        const selected = request(value.request);
        if (!taskEditValuesEqual(selected.capture, value.capture.request)) throw invalid();
        return { version: 1, request: selected, capture: { request: value.capture.request, prepared: value.capture.prepared } };
    };
    return {
        async outcome(input: unknown) {
            const source = identity(input), result = await probe(source);
            return result?.result ?? null;
        },
        async prepare(input: unknown) {
            const selected = request(input), existing = await probe(selected.source);
            if (existing) {
                if (existing.requestFingerprint !== selected.requestFingerprint) throw invalid();
                return { kind: 'alreadySaved' as const, result: existing.result };
            }
            const prepared = selected.method === 'captureLinesSubmit'
                ? deps.contract.prepareQuickCaptureLines(selected.capture as Parameters<Contract['prepareQuickCaptureLines']>[0])
                : selected.method === 'captureCopilotSubmit'
                    ? deps.contract.prepareQuickCaptureCopilot(selected.capture as Parameters<Contract['prepareQuickCaptureCopilot']>[0])
                    : deps.contract.prepareQuickCapture(selected.capture as Parameters<Contract['prepareQuickCapture']>[0]);
            if (!prepared.ok) throw new Error(prepared.error.code + ': ' + prepared.error.message);
            if (prepared.value.kind !== 'prepared') return prepared.value;
            return { kind: 'prepared' as const, prepared: { version: 1, request: selected,
                capture: { request: selected.capture, prepared: prepared.value.prepared } } satisfies Plan };
        },
        async commit(input: unknown) {
            const plan = readPlan(input);
            return runSerializedSyncDocumentWriteOperation(async () => {
                await flushPendingSave();
                const selected = adapter(), prior = await probe(plan.request.source, selected);
                let result: Record<string, unknown>;
                if (prior) {
                    if (prior.requestFingerprint !== plan.request.requestFingerprint) throw invalid();
                    result = prior.result;
                } else {
                    const before = await selected.getData({ rawTasks: true });
                    deps.current(); if (getStorageAdapter() !== selected || !before) throw unavailable();
                    const built = buildPreparedShareCaptureDocument(plan.request.method, plan.capture, before);
                    if (!built.ok) throw new Error(built.error.code + ': ' + built.error.message);
                    const reply = { version: 1, requestFingerprint: plan.request.requestFingerprint, result: built.value.result };
                    try {
                        const saved = await selected.saveShareCaptureWithReceipt({ requestId: plan.request.source.id,
                            payload: payload(plan.request.source), expectedCurrent: before, data: built.value.data, reply });
                        const confirmed = savedReply(saved.reply, plan.request.source);
                        if (confirmed.requestFingerprint !== plan.request.requestFingerprint) throw unavailable();
                        result = confirmed.result;
                    } catch { throw unavailable(); }
                }
                deps.current(); if (getStorageAdapter() !== selected) throw unavailable();
                try {
                    markNextLoadAsDocumentReplacement();
                    await useTaskStore.getState().fetchData({ throwOnError: true, recoveryLoad: true });
                } catch { throw unavailable(); }
                deps.current(); if (getStorageAdapter() !== selected) throw unavailable();
                return result;
            });
        },
    };
}
