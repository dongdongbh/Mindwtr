import type { GeneralSettingsModel } from './general-settings-model';
import { readAreaDurableData, readDurableSettings } from './native-host-contract-area-durable';
import type { NativeHostResult } from './native-host-contract';
import { detach, exact, record } from './native-host-contract-project-shared';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { taskEditValuesEqual } from './json-value-equality';
import { createNativeRequestReceipts, NativeReceiptSqliteAdapter } from './native-request-receipts';
import { appLockWitness, type AppLockWitness } from './store-settings';
import { getPersistenceStatus, getStorageAdapter, useTaskStore } from './store';
import type { PreparedAreaAuthority } from './store-types';
import type { AppSettings } from './types';

export type { AppLockWitness } from './store-settings';
export type AppLockRequest = { requestId: string; value: boolean; expected: AppLockWitness };
export type AppLockResult = { changed: boolean; value: boolean };
export type PreparedAppLock = { version: 1; request: AppLockRequest };
export type AppLockOptions = { row: GeneralSettingsModel['privacy']['appLock'];
    expected: AppLockWitness; value: boolean };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED' | 'ACTION_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const witness = (value: unknown): value is AppLockWitness => record(value)
    && exact(value, ['groupPresent', 'present', 'value'])
    && typeof value.groupPresent === 'boolean' && typeof value.present === 'boolean'
    && (value.groupPresent || !value.present)
    && (value.present ? value.groupPresent && typeof value.value === 'boolean' : value.value === null);
const requestOf = (input: unknown): AppLockRequest | null => {
    if (!isNativeJsonWithinBytes(input, 8192)) return null;
    const raw = detach<Record<string, unknown>>(input);
    return raw && exact(raw, ['requestId', 'value', 'expected'])
        && typeof raw.requestId === 'string' && UUID.test(raw.requestId)
        && typeof raw.value === 'boolean' && witness(raw.expected)
        ? raw as AppLockRequest : null;
};
const preparedOf = (input: unknown): PreparedAppLock | null => {
    if (!isNativeJsonWithinBytes(input, 8192)) return null;
    const raw = detach<Record<string, unknown>>(input);
    if (!raw || !exact(raw, ['request', 'prepared']) || !record(raw.prepared)) return null;
    const request = requestOf(raw.request);
    const prepared = raw.prepared;
    return request && exact(prepared, ['version', 'request']) && prepared.version === 1
        && taskEditValuesEqual(prepared.request, request)
        ? prepared as PreparedAppLock : null;
};
const payload = (request: AppLockRequest): string => JSON.stringify(['appLock', request.value,
    request.expected.groupPresent, request.expected.present, request.expected.value]);
const validResult = (value: unknown, request: AppLockRequest): value is AppLockResult => record(value)
    && exact(value, ['changed', 'value']) && value.changed === true && value.value === request.value;

export function createAppLockMethods(deps: { readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    model: (settings: AppSettings) => GeneralSettingsModel }) {
    const authorizations = new Map<string, { payload: string; adapter: ReturnType<typeof getStorageAdapter>;
        authority: PreparedAreaAuthority }>();
    const receipts = createNativeRequestReceipts({
        save: async (id) => {
            const authorized = authorizations.get(id);
            if (useTaskStore.getState().persistenceFailure) {
                if (!authorized || getStorageAdapter() !== authorized.adapter)
                    return fail('SAVE_FAILED', 'App lock save ownership changed');
                const retry = await useTaskStore.getState().retryPreparedAppLockSnapshot(authorized.authority);
                if (!retry.success) return fail('SAVE_FAILED', 'App lock save ownership changed');
            }
            return deps.save();
        },
        receiptOnly: async (id, frozen) => {
            const authorized = authorizations.get(id);
            const boundary = authorized?.authority.saveBoundary;
            const raw = authorized?.authority.rawSavedSnapshot;
            const state = useTaskStore.getState();
            const status = getPersistenceStatus();
            if (!authorized || authorized.payload !== frozen || !boundary || !raw
                || getStorageAdapter() !== authorized.adapter
                || !(authorized.adapter instanceof NativeReceiptSqliteAdapter)
                || state._allTasks !== boundary.taskReference || state.settings !== raw.settings
                || state.lastDataChangeAt !== boundary.lastDataChangeAt
                || status.generation !== boundary.generation || status.failed || status.queued
                || status.inFlight || status.immediate || status.retrying) return false;
            return authorized.adapter.commitReceiptOnly(id, frozen);
        },
    });
    const saved = (request: AppLockRequest): NativeHostResult<AppLockResult> | null => {
        const result = receipts.saved<AppLockResult>(request.requestId, payload(request));
        if (!result || !result.ok) return result;
        return validResult(result.value, request) ? result
            : fail('INVALID_INPUT', 'Saved App lock receipt is malformed');
    };
    return {
        async getAppLockOptions(input: unknown): Promise<NativeHostResult<AppLockOptions>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            if (!record(input) || !exact(input, [])) return fail('INVALID_INPUT', 'App lock options take an empty object');
            const read = await readDurableSettings(); if (!read.ok) return read;
            const settings = read.value;
            const expected = appLockWitness(settings);
            if (!expected) return fail('INVALID_INPUT', 'Saved App lock flag is malformed');
            const value = expected.value === true;
            const result = { row: deps.model(settings).privacy.appLock, expected, value };
            return isNativeJsonWithinBytes(result, 8192) ? { ok: true, value: result }
                : fail('INVALID_INPUT', 'App lock options exceed the bound');
        },
        probeAppLockOutcome(input: unknown): NativeHostResult<AppLockResult> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const request = requestOf(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded App lock request is required');
            return saved(request) ?? fail('STALE_REVISION', 'App lock outcome is unknown; refresh General');
        },
        async prepareAppLock(input: unknown): Promise<NativeHostResult<{ kind: 'noop'; result: AppLockResult }
            | { kind: 'prepared'; prepared: PreparedAppLock }>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const request = requestOf(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded App lock request is required');
            const identity = receipts.checkIdentity(request.requestId, payload(request));
            if (!identity.ok) return identity;
            const read = await readAreaDurableData(); if (!read.ok) return read;
            const current = appLockWitness(read.value.authority.snapshot.settings);
            if (!current) return fail('INVALID_INPUT', 'Saved App lock flag is malformed');
            if (!taskEditValuesEqual(current, request.expected))
                return fail('STALE_REVISION', 'App lock changed; refresh General');
            if (current.present && current.value === request.value)
                return { ok: true, value: { kind: 'noop', result: { changed: false, value: request.value } } };
            const frozen = { version: 1 as const, request };
            const key = payload(request);
            const known = authorizations.get(request.requestId);
            if (known && known.payload !== key) return fail('INVALID_INPUT', 'Request ID already belongs to another action');
            authorizations.set(request.requestId, { payload: key, adapter: read.value.adapter,
                authority: read.value.authority });
            return { ok: true, value: { kind: 'prepared', prepared: frozen } };
        },
        validatePreparedAppLock(input: unknown): NativeHostResult<AppLockResult> {
            const prepared = preparedOf(input);
            return prepared ? { ok: true, value: { changed: true, value: prepared.request.value } }
                : fail('INVALID_INPUT', 'Prepared App lock request is malformed');
        },
        async commitPreparedAppLock(input: unknown): Promise<NativeHostResult<AppLockResult>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const prepared = preparedOf(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared App lock request is malformed');
            const request = prepared.request;
            const known = saved(request);
            if (known) {
                if (known.ok) authorizations.delete(request.requestId);
                return known;
            }
            const key = payload(request);
            const result = await receipts.run<AppLockResult>(request.requestId, key, async () => {
                const authorized = authorizations.get(request.requestId);
                if (!authorized || authorized.payload !== key || getStorageAdapter() !== authorized.adapter)
                    return fail('STALE_REVISION', 'App lock outcome is unknown; refresh General');
                if (useTaskStore.getState().persistenceFailure)
                    return fail('ACTION_FAILED', 'App lock has an unresolved persistence failure');
                const read = await readAreaDurableData();
                if (!read.ok) return read.error.code === 'SAVE_FAILED'
                    ? fail('ACTION_FAILED', 'App lock could not read saved data') : read;
                if (read.value.adapter !== authorized.adapter) return fail('STALE_REVISION', 'App lock storage changed');
                const applied = await useTaskStore.getState().commitPreparedAppLock(request, read.value.authority);
                if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'App lock changed; refresh General');
                authorized.authority = read.value.authority;
                return { ok: true, value: { changed: true, value: request.value } };
            });
            if (result.ok || result.error.code === 'STALE_REVISION') authorizations.delete(request.requestId);
            return result;
        },
    };
}
