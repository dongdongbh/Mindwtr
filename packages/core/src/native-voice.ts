import type { NativeHostResult } from './native-host-contract';
import { createQuickCaptureMethods, type QuickCaptureDeps } from './native-host-contract-quick-capture';
import { detach } from './native-host-contract-project-shared';
import { exact, isNativeJsonWithinBytes, record } from './native-json';
import { taskEditValuesEqual } from './json-value-equality';
import { toStableSyncJson } from './sync-helpers';
import { createNativeRequestReceipts, NativeReceiptSqliteAdapter } from './native-request-receipts';
import { getPersistenceStatus, getStorageAdapter, useTaskStore } from './store';
import { buildAudioNoteTitle } from './quick-capture-audio';
import { buildNativeVoiceSettingsOptions, buildNativeVoiceRuntimeOptions, nativeVoiceSettingsWitness, planNativeVoiceSettings, readNativeVoiceSettingsRequest,
    type NativeVoiceSettingsRequest } from './native-voice-settings';
import { nativeVoiceBasis, nativeVoiceCaptureResult, readNativeVoiceCaptureResult, nativeVoiceRawTask, planNativeVoiceSpeechResult, readNativeVoiceCaptureRequest,
    readNativeVoicePrepared, readNativeVoiceResultRequest, NATIVE_VOICE_JOURNAL_BYTES,
    type NativeVoicePrepared, type NativeVoiceRequest, type NativePreparedVoiceCapture, type NativePreparedVoiceSettings,
    type NativePreparedVoiceResult, type NativeVoiceCaptureRequest, type NativeVoiceCaptureResult, type NativeVoiceResultRequest,
    type NativeVoiceResult } from './native-voice-prepared';
import type { PreparedAreaAuthority } from './store-types';
import type { AppData } from './types';
export * from './native-voice-settings';
export * from './native-voice-prepared';

const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED' | 'ACTION_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
type Preparation<P, R> = { kind: 'prepared'; prepared: P } | { kind: 'noop'; result: R };
export function createNativeVoiceMethods(deps: QuickCaptureDeps) {
    const capture = createQuickCaptureMethods(deps);
    let retired = false;
    const read = async (current: () => void): Promise<NativeHostResult<{ adapter: ReturnType<typeof getStorageAdapter>; authority: PreparedAreaAuthority }>> => {
        if (retired) return fail('STALE_REVISION', 'Voice owner is retired; reload before editing');
        const adapter = getStorageAdapter(), state = useTaskStore.getState(), status = getPersistenceStatus();
        const references = [state._allTasks, state._allProjects, state._allSections, state._allAreas, state._allPeople, state.settings];
        let frozen: unknown, fullReadStarted = false;
        const ready = () => {
            current();
            const admission = deps.readiness(); if (!admission.ok) throw new Error(admission.error.code);
            const now = useTaskStore.getState(), persistence = getPersistenceStatus();
            if (getStorageAdapter() !== adapter || persistence.generation !== status.generation
                || now.lastDataChangeAt !== state.lastDataChangeAt
                || ![now._allTasks, now._allProjects, now._allSections, now._allAreas, now._allPeople, now.settings]
                    .every((value, index) => value === references[index])
                || frozen && !taskEditValuesEqual(references, frozen)) throw new Error('STALE_REVISION');
            if (persistence.failed || persistence.queued || persistence.inFlight || persistence.immediate || persistence.retrying
                || now.isLoading || now.editLockCount > 0) throw new Error('ACTION_FAILED');
        };
        try {
            ready();
            if (!(adapter instanceof NativeReceiptSqliteAdapter) || !adapter.concurrentWritesGuarded) return fail('ACTION_FAILED', 'Voice needs guarded receipt storage');
            const baseline = await adapter.readRowBaseline(); ready();
            if (!baseline) throw new Error('STALE_REVISION');
            if (!taskEditValuesEqual(baseline.settings, state.settings)) throw new Error('STALE_REVISION');
            frozen = JSON.parse(JSON.stringify(references));
            fullReadStarted = true;
            const snapshot = await adapter.getData({ rawTasks: true }); ready();
            const after = await adapter.readRowBaseline(); ready();
            if (!after || !taskEditValuesEqual(after, baseline) || !taskEditValuesEqual(snapshot.settings, baseline.settings))
                throw new Error('STALE_REVISION');
            return { ok: true, value: { adapter, authority: { snapshot, state } } };
        } catch (error) {
            if (fullReadStarted) retired = true;
            const message = error instanceof Error ? error.message : '';
            if (message.includes('ACTION_FAILED') || message.includes('NOT_READY') || message.includes('SAVE_FAILED'))
                return fail('ACTION_FAILED', 'Voice waits for current saved data');
            retired = true;
            return fail('STALE_REVISION', 'Voice saved data changed; reload before editing');
        }
    };
    const authorizations = new Map<string, { payload: string; adapter: ReturnType<typeof getStorageAdapter>;
        authority: PreparedAreaAuthority; prepared: NativeVoicePrepared }>();
    const receipts = createNativeRequestReceipts({
        save: async (id) => {
            const authorized = authorizations.get(id);
            if (useTaskStore.getState().persistenceFailure) {
                if (!authorized || getStorageAdapter() !== authorized.adapter
                    || authorized.authority.saveBoundary?.failure !== useTaskStore.getState().persistenceFailure)
                    return fail('SAVE_FAILED', 'Voice save ownership changed');
                const retry = await useTaskStore.getState().retryPreparedVoiceSnapshot(authorized.authority);
                if (!retry.success) return fail('SAVE_FAILED', 'Voice save ownership changed');
            }
            const boundary = authorized?.authority.saveBoundary, raw = authorized?.authority.rawSavedSnapshot;
            const before = useTaskStore.getState();
            const owns = authorized && boundary && raw && getStorageAdapter() === authorized.adapter
                && before._allTasks === boundary.taskReference && before.settings === raw.settings
                && before.lastDataChangeAt === boundary.lastDataChangeAt
                && getPersistenceStatus().generation === boundary.generation && before.persistenceFailure === boundary.failure;
            const saved = await deps.save();
            const after = useTaskStore.getState();
            if (owns && !saved.ok && saved.error.code === 'SAVE_FAILED' && after.persistenceFailure
                && after.persistenceFailure !== before.persistenceFailure && getStorageAdapter() === authorized.adapter
                && after._allTasks === boundary.taskReference && after.settings === raw.settings
                && after.lastDataChangeAt === boundary.lastDataChangeAt && getPersistenceStatus().generation === boundary.generation)
                authorized.authority.saveBoundary = { ...boundary, failure: after.persistenceFailure };
            return saved;
        },
        receiptOnly: async (id, frozen) => {
            const authorized = authorizations.get(id), boundary = authorized?.authority.saveBoundary;
            const raw = authorized?.authority.rawSavedSnapshot, state = useTaskStore.getState(), status = getPersistenceStatus();
            if (!authorized || authorized.payload !== frozen || !boundary || !raw
                || getStorageAdapter() !== authorized.adapter || !(authorized.adapter instanceof NativeReceiptSqliteAdapter)
                || state._allTasks !== boundary.taskReference || state.settings !== raw.settings
                || state.lastDataChangeAt !== boundary.lastDataChangeAt || status.generation !== boundary.generation
                || status.failed || status.queued || status.inFlight || status.immediate || status.retrying) return false;
            return authorized.adapter.commitReceiptOnly(id, frozen);
        },
    });
    const bind = <R extends NativeVoiceRequest, P extends NativeVoicePrepared & { request: R }, V>(config: {
        kind: P['kind']; command: string; request: (input: unknown) => R | null;
        plan: (request: R, data: AppData) => NativeHostResult<Preparation<P, V>>;
        result: (prepared: P) => V; validResult: (value: unknown, request: R) => boolean;
    }) => {
        const payload = (request: R) => toStableSyncJson([config.command, request]);
        const envelope = (input: unknown): P | null => {
            if (!record(input) || !exact(input, ['request', 'prepared']) || !isNativeJsonWithinBytes(input, NATIVE_VOICE_JOURNAL_BYTES * 2)) return null;
            const request = config.request(input.request), prepared = readNativeVoicePrepared(input.prepared);
            return request && prepared?.kind === config.kind && taskEditValuesEqual(request, prepared.request) ? prepared as P : null;
        };
        const saved = (request: R): NativeHostResult<V> | null => {
            const value = receipts.saved<V>(request.requestId, payload(request));
            return value?.ok && !config.validResult(value.value, request) ? fail('INVALID_INPUT', 'Voice saved receipt is malformed') : value;
        };
        const authorize = (request: R, prepared: P, data: { adapter: ReturnType<typeof getStorageAdapter>; authority: PreparedAreaAuthority }) => {
            for (const [id, previous] of authorizations) if (id !== request.requestId && !previous.authority.saveBoundary) authorizations.delete(id);
            authorizations.set(request.requestId, { payload: payload(request), ...data, prepared });
        };
        return {
            outcome(input: unknown): NativeHostResult<V> {
                const ready = deps.readiness(); if (!ready.ok) return ready;
                const request = config.request(input);
                return request ? saved(request) ?? fail('STALE_REVISION', 'Voice outcome is unknown') : fail('INVALID_INPUT', 'Voice request is invalid');
            },
            validate(input: unknown): NativeHostResult<V> {
                const prepared = envelope(input);
                return prepared ? { ok: true, value: config.result(prepared) } : fail('INVALID_INPUT', 'Voice prepared journal is invalid');
            },
            async prepare(input: unknown, current: () => void = () => {}): Promise<NativeHostResult<Preparation<P, V>>> {
                const request = config.request(input); if (!request) return fail('INVALID_INPUT', 'Voice request is invalid');
                const identity = receipts.checkIdentity(request.requestId, payload(request)); if (!identity.ok) return identity;
                const data = await read(current); if (!data.ok) return data;
                let plan;
                try { current(); plan = config.plan(request, data.value.authority.snapshot); } catch { return fail('INVALID_INPUT', 'Voice preparation is unavailable'); }
                if (!plan.ok || plan.value.kind !== 'prepared') return plan;
                const prepared = detach<P>(JSON.parse(JSON.stringify(plan.value.prepared)));
                if (!prepared || !envelope({ request, prepared })) return fail('INVALID_INPUT', 'Voice preparation exceeds its bound');
                const latest = receipts.checkIdentity(request.requestId, payload(request)); if (!latest.ok) return latest;
                authorize(request, prepared, data.value);
                return { ok: true, value: { kind: 'prepared', prepared } };
            },
            async recover(input: unknown, current: () => void = () => {}): Promise<NativeHostResult<{ kind: 'authorized' } | { kind: 'saved'; result: V }>> {
                const prepared = envelope(input); if (!prepared) return fail('INVALID_INPUT', 'Voice prepared journal is invalid');
                const request = prepared.request;
                const known = saved(request); if (known) return known.ok ? { ok: true, value: { kind: 'saved', result: known.value } } : known;
                const identity = receipts.checkIdentity(request.requestId, payload(request)); if (!identity.ok) return identity;
                const data = await read(current); if (!data.ok) return data;
                current();
                if (prepared.kind !== 'capture') {
                    let planned;
                    try { planned = config.plan(request, data.value.authority.snapshot); }
                    catch { return fail('INVALID_INPUT', 'Voice recovery preparation is unavailable'); }
                    if (!planned.ok || planned.value.kind !== 'prepared' || !taskEditValuesEqual(planned.value.prepared, prepared))
                        return fail('STALE_REVISION', 'Voice recovery data changed');
                } else if (data.value.authority.snapshot.tasks.some(row => row.id === request.requestId))
                    return fail('STALE_REVISION', 'Voice capture has no proved receipt');
                authorize(request, prepared, data.value);
                return { ok: true, value: { kind: 'authorized' } };
            },
            async commit(input: unknown, current: () => void = () => {}): Promise<NativeHostResult<V>> {
                const ready = deps.readiness(); if (!ready.ok) return ready;
                const prepared = envelope(input); if (!prepared) return fail('INVALID_INPUT', 'Voice prepared journal is invalid');
                const request = prepared.request, known = saved(request);
                if (known) { if (known.ok) authorizations.delete(request.requestId); return known; }
                const key = payload(request);
                const result = await receipts.run<V>(request.requestId, key, async () => {
                    const authorized = authorizations.get(request.requestId);
                    if (!authorized || authorized.payload !== key || !taskEditValuesEqual(authorized.prepared, prepared)
                        || getStorageAdapter() !== authorized.adapter) return fail('STALE_REVISION', 'Voice prepared authority is unknown');
                    const data = await read(current); if (!data.ok) return data;
                    current();
                    if (prepared.kind === 'result') {
                        const first = captureMethods.outcome(prepared.request.capture);
                        if (!first.ok || !taskEditValuesEqual(first.value, prepared.initial)) return fail('STALE_REVISION', 'Voice capture receipt changed');
                    }
                    const applied = prepared.kind === 'settings'
                        ? await useTaskStore.getState().commitPreparedVoiceSettings(prepared.request, data.value.authority)
                        : await useTaskStore.getState().commitPreparedVoiceRows(prepared, data.value.authority);
                    if (!applied.success) return fail('STALE_REVISION', 'Voice saved data changed');
                    authorized.authority = data.value.authority;
                    return { ok: true, value: config.result(prepared) };
                });
                if (result.ok || result.error.code === 'STALE_REVISION') authorizations.delete(request.requestId);
                return result;
            },
        };
    };
    const settingsMethods = bind<NativeVoiceSettingsRequest, NativePreparedVoiceSettings, { changed: boolean }>({
        kind: 'settings', command: 'voiceSettings', request: readNativeVoiceSettingsRequest, result: () => ({ changed: true }),
        validResult: value => record(value) && exact(value, ['changed']) && value.changed === true,
        plan: (request, data) => {
            const witness = nativeVoiceSettingsWitness(data.settings);
            if (!witness || !taskEditValuesEqual(witness, request.expected)) return fail('STALE_REVISION', 'Speech settings changed');
            if (!planNativeVoiceSettings(witness, request.change)) return { ok: true, value: { kind: 'noop', result: { changed: false } } };
            return { ok: true, value: { kind: 'prepared', prepared: { version: 1, kind: 'settings', request } } };
        },
    });
    const captureMethods = bind<NativeVoiceCaptureRequest, NativePreparedVoiceCapture, NativeVoiceCaptureResult>({
        kind: 'capture', command: 'voiceCapture', request: readNativeVoiceCaptureRequest, result: nativeVoiceCaptureResult,
        validResult: (value, request) => readNativeVoiceCaptureResult(value, request) !== null,
        plan: (request) => {
            const fallback = buildAudioNoteTitle(deps.t()('quickAdd.audioNoteTitle'), new Date(request.recordedAt), deps.formatDate());
            const input = { text: request.text.trim() ? request.text : fallback,
                options: request.options, captureId: request.requestId, openAfterSave: request.openAfterSave };
            const result = request.applied === null ? capture.prepareQuickCapture(input)
                : capture.prepareQuickCaptureCopilot({ capture: input, applied: request.applied });
            if (!result.ok) return result;
            if (result.value.kind !== 'prepared') return fail('INVALID_INPUT', 'Audio capture is limited to a single valid task');
            const base = result.value.prepared;
            const task = { ...base.task, ...(request.attachment ? { attachments: [...(base.task.attachments ?? []), request.attachment] } : {}) };
            return { ok: true, value: { kind: 'prepared', prepared: { version: 3, kind: 'capture', request, capture: base, task } } };
        },
    });
    const resultMethods = bind<NativeVoiceResultRequest, NativePreparedVoiceResult, NativeVoiceResult>({
        kind: 'result', command: 'voiceResult', request: readNativeVoiceResultRequest,
        result: prepared => ({ taskId: prepared.taskAfter.id, outcome: prepared.outcome }),
        validResult: (value, request) => record(value) && exact(value, ['taskId', 'outcome']) && value.taskId === request.capture.requestId
            && (value.outcome === 'applied' || value.outcome === 'discarded'),
        plan: (request, data) => {
            const initial = captureMethods.outcome(request.capture); if (!initial.ok) return initial;
            const rows = data.tasks.filter(task => task.id === request.capture.requestId), before = rows.length === 1 ? nativeVoiceRawTask(rows[0]) : null;
            const basis = nativeVoiceBasis(data);
            if (!before || !basis) return { ok: true, value: { kind: 'noop', result: { taskId: request.capture.requestId, outcome: 'skipped' } } };
            const plan = planNativeVoiceSpeechResult(request, initial.value, before, basis);
            if (!('taskAfter' in plan)) return { ok: true, value: { kind: 'noop', result: { taskId: before.id, outcome: plan.outcome } } };
            return { ok: true, value: { kind: 'prepared', prepared: { version: 1, kind: 'result', request,
                initial: initial.value, basis, taskBefore: before, ...plan } } };
        },
    });
    return {
        async settingsOptions(input: unknown, current: () => void = () => {}) {
            if (!record(input) || !exact(input, [])) return fail('INVALID_INPUT', 'Speech options take no fields');
            const data = await read(current); if (!data.ok) return data;
            const options = buildNativeVoiceSettingsOptions(data.value.authority.snapshot.settings);
            return options ? { ok: true as const, value: options } : fail('INVALID_INPUT', 'Speech settings are malformed');
        },
        async runtimeOptions(input: unknown, current: () => void = () => {}) {
            if (!record(input) || !exact(input, [])) return fail('INVALID_INPUT', 'Voice runtime options take no fields');
            const data = await read(current); if (!data.ok) return data;
            const options = buildNativeVoiceRuntimeOptions(data.value.authority.snapshot.settings);
            return options ? { ok: true as const, value: options } : fail('INVALID_INPUT', 'Voice runtime is malformed');
        },
        prepareSettings: settingsMethods.prepare, validateSettings: settingsMethods.validate, commitSettings: settingsMethods.commit,
        settingsOutcome: settingsMethods.outcome, recoverSettings: settingsMethods.recover,
        prepareCapture: captureMethods.prepare, validateCapture: captureMethods.validate, commitCapture: captureMethods.commit,
        captureOutcome: captureMethods.outcome, recoverCapture: captureMethods.recover,
        prepareResult: resultMethods.prepare, validateResult: resultMethods.validate, commitResult: resultMethods.commit,
        resultOutcome: resultMethods.outcome, recoverResult: resultMethods.recover,
    };
}
