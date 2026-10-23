import type { NativeHostResult } from './native-host-contract';
import { detach, exact, record } from './native-host-contract-project-shared';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { taskEditValuesEqual } from './json-value-equality';
import { createNativeRequestReceipts, NativeReceiptSqliteAdapter } from './native-request-receipts';
import { getPersistenceStatus, getStorageAdapter, useTaskStore } from './store';
import { resolveAIRequestTimeoutSeconds } from './ai-config';
import type { PreparedAreaAuthority } from './store-types';

import { nativeAIRequestTimeoutWitness, readNativeAIRequestTimeoutRequest, type AIRequestTimeoutWitness, type AIRequestTimeoutRequest, type AIRequestTimeoutResult, type PreparedAIRequestTimeout } from './native-ai-request-timeout-request';
export { nativeAIRequestTimeoutWitness, readNativeAIRequestTimeoutRequest } from './native-ai-request-timeout-request';
export type { AIRequestTimeoutValue, AIRequestTimeoutWitness, AIRequestTimeoutRequest, AIRequestTimeoutResult, PreparedAIRequestTimeout } from './native-ai-request-timeout-request';

const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED' | 'ACTION_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });

const preparedOf = (input: unknown): PreparedAIRequestTimeout | null => {
    if (!isNativeJsonWithinBytes(input, 8192) || !record(input) || !exact(input, ['request', 'prepared'])
        || !record(input.prepared) || !exact(input.prepared, ['version', 'request']) || input.prepared.version !== 1) return null;
    const request = readNativeAIRequestTimeoutRequest(input.request), original = readNativeAIRequestTimeoutRequest(input.prepared.request);
    return request && original && taskEditValuesEqual(request, original) ? { version: 1, request } : null;
};
const payload = (request: AIRequestTimeoutRequest) => JSON.stringify(['aiRequestTimeout', request.value, request.expected]);
const resultFor = (request: AIRequestTimeoutRequest, changed: boolean): AIRequestTimeoutResult => ({ value: request.value, changed });
const validResult = (value: unknown, request: AIRequestTimeoutRequest): value is AIRequestTimeoutResult => record(value)
    && exact(value, ['value', 'changed']) && value.changed === true && value.value === request.value;

/** Private synced scalar writes. Never activates the AI factory or migrates credentials. */
export function createNativeAIRequestTimeoutMethods(deps: { readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>> }) {
    // A getData race can advance the adapter's accepted epoch. Only a new explicit host load restores authority.
    let retired = false;
    const read = async (current: () => void): Promise<NativeHostResult<{ adapter: ReturnType<typeof getStorageAdapter>; authority: PreparedAreaAuthority }>> => {
        if (retired) return fail('STALE_REVISION', 'AI timeout owner is retired; reload before editing');
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
            if (!(adapter instanceof NativeReceiptSqliteAdapter) || !adapter.concurrentWritesGuarded) return fail('ACTION_FAILED', 'AI timeout needs guarded receipt storage');
            const baseline = await adapter.readRowBaseline(); ready();
            if (!baseline) throw new Error('STALE_REVISION');
            if (!nativeAIRequestTimeoutWitness(baseline.settings)) return fail('INVALID_INPUT', 'Saved AI timeout controls are malformed');
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
                return fail('ACTION_FAILED', 'AI timeout waits for current saved data');
            retired = true;
            return fail('STALE_REVISION', 'AI timeout saved data changed; reload before editing');
        }
    };
    const authorizations = new Map<string, { payload: string; adapter: ReturnType<typeof getStorageAdapter>;
        authority: PreparedAreaAuthority }>();
    const receipts = createNativeRequestReceipts({
        save: async (id) => {
            const authorized = authorizations.get(id);
            if (useTaskStore.getState().persistenceFailure) {
                if (!authorized || getStorageAdapter() !== authorized.adapter
                    || authorized.authority.saveBoundary?.failure !== useTaskStore.getState().persistenceFailure)
                    return fail('SAVE_FAILED', 'AI timeout save ownership changed');
                const retry = await useTaskStore.getState().retryPreparedAIRequestTimeoutSnapshot(authorized.authority);
                if (!retry.success) return fail('SAVE_FAILED', 'AI timeout save ownership changed');
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
    const saved = (request: AIRequestTimeoutRequest): NativeHostResult<AIRequestTimeoutResult> | null => {
        const result = receipts.saved<AIRequestTimeoutResult>(request.requestId, payload(request));
        if (!result || !result.ok) return result;
        return validResult(result.value, request) ? result : fail('INVALID_INPUT', 'Saved AI timeout receipt is malformed');
    };
    return {
        async options(input: unknown, current: () => void = () => {}): Promise<NativeHostResult<{ value: number; expected: AIRequestTimeoutWitness }>> {
            if (!record(input) || !exact(input, [])) return fail('INVALID_INPUT', 'AI timeout options take an empty object');
            const saved = await read(current); if (!saved.ok) return saved;
            const expected = nativeAIRequestTimeoutWitness(saved.value.authority.snapshot.settings);
            return expected ? { ok: true, value: { value: resolveAIRequestTimeoutSeconds(expected.timeout), expected } }
                : fail('INVALID_INPUT', 'Saved AI timeout controls are malformed');
        },
        outcome(input: unknown): NativeHostResult<AIRequestTimeoutResult> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const request = readNativeAIRequestTimeoutRequest(input);
            return request ? saved(request) ?? fail('STALE_REVISION', 'AI timeout outcome is unknown; refresh AI settings')
                : fail('INVALID_INPUT', 'A bounded AI timeout request is required');
        },
        async prepare(input: unknown, current: () => void = () => {}): Promise<NativeHostResult<{ kind: 'noop'; result: AIRequestTimeoutResult }
            | { kind: 'prepared'; prepared: PreparedAIRequestTimeout }>> {
            const request = readNativeAIRequestTimeoutRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded AI timeout request is required');
            const key = payload(request), identity = receipts.checkIdentity(request.requestId, key);
            if (!identity.ok) return identity;
            const known = authorizations.get(request.requestId);
            if (known && known.payload !== key) return fail('INVALID_INPUT', 'Request ID already belongs to another action');
            const data = await read(current); if (!data.ok) return data;
            const witness = nativeAIRequestTimeoutWitness(data.value.authority.snapshot.settings);
            if (!witness || !taskEditValuesEqual(witness, request.expected))
                return fail('STALE_REVISION', 'AI timeout setting changed; refresh AI settings');
            if (witness.timeoutPresent && witness.timeout === request.value)
                return { ok: true, value: { kind: 'noop', result: resultFor(request, false) } };
            const prepared = detach<PreparedAIRequestTimeout>({ version: 1, request });
            if (!prepared || !preparedOf({ request, prepared })) return fail('INVALID_INPUT', 'AI timeout journal exceeds the bound');
            // Another preparation can publish this UUID while the durable read awaits.
            const latestIdentity = receipts.checkIdentity(request.requestId, key);
            if (!latestIdentity.ok) return latestIdentity;
            const latest = authorizations.get(request.requestId);
            if (latest && latest.payload !== key) return fail('INVALID_INPUT', 'Request ID already belongs to another action');
            // The private native facade admits one intent. Retain only applied snapshots
            // that can still own an uncertain save; cancelled unapplied plans need no raw data.
            for (const [id, previous] of authorizations) {
                if (id !== request.requestId && !previous.authority.saveBoundary) authorizations.delete(id);
            }
            authorizations.set(request.requestId, { payload: key, adapter: data.value.adapter, authority: data.value.authority });
            return { ok: true, value: { kind: 'prepared', prepared } };
        },
        validate(input: unknown): NativeHostResult<AIRequestTimeoutResult> {
            const prepared = preparedOf(input);
            return prepared ? { ok: true, value: resultFor(prepared.request, true) }
                : fail('INVALID_INPUT', 'Prepared AI timeout request is malformed');
        },
        async commit(input: unknown, current: () => void = () => {}): Promise<NativeHostResult<AIRequestTimeoutResult>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const prepared = preparedOf(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared AI timeout request is malformed');
            const request = prepared.request, known = saved(request);
            if (known) { if (known.ok) authorizations.delete(request.requestId); return known; }
            const key = payload(request);
            const result = await receipts.run<AIRequestTimeoutResult>(request.requestId, key, async () => {
                const authorized = authorizations.get(request.requestId);
                if (!authorized || authorized.payload !== key || getStorageAdapter() !== authorized.adapter)
                    return fail('STALE_REVISION', 'AI timeout outcome is unknown; refresh AI settings');
                if (useTaskStore.getState().persistenceFailure)
                    return fail('ACTION_FAILED', 'AI settings have an unresolved persistence failure');
                const data = await read(current);
                if (useTaskStore.getState().persistenceFailure)
                    return fail('ACTION_FAILED', 'AI settings have an unresolved persistence failure');
                if (!data.ok) return data;
                if (data.value.adapter !== authorized.adapter) return fail('STALE_REVISION', 'AI timeout storage changed');
                current();
                const applied = await useTaskStore.getState().commitPreparedAIRequestTimeout(request, data.value.authority);
                if (!applied.success) return fail('STALE_REVISION', 'AI timeout setting changed; refresh AI settings');
                authorized.authority = data.value.authority;
                return { ok: true, value: resultFor(request, true) };
            });
            if (result.ok || result.error.code === 'STALE_REVISION') authorizations.delete(request.requestId);
            return result;
        },
    };
}
