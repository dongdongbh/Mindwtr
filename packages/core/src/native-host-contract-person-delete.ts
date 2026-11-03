import type { NativeHostResult } from './native-host-contract';
import { getManageDeleteConfirm, type ManageConfirm } from './manage-settings-model';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { ensureDeviceId, nextRevision } from './store-helpers';
import { useTaskStore } from './store';
import { personDeleteEffect, personPersistedSnapshot, samePersonAdditionRow } from './store-projects/people-actions';
import type { PreparedPersonDelete } from './store-types';
import { taskEditValuesEqual } from './json-value-equality';
import type { Person } from './types';

export type NativePersonDeleteRequest = { requestId: string; personId: string; expected: Person };
export type NativePersonDeleteResult = { personId: string };
export type NativePersonDeleteOptions = { personId: string; name: string; expected: Person; confirm: ManageConfirm };
export type NativePreparedPersonDelete = PreparedPersonDelete & { version: 1; request: NativePersonDeleteRequest;
    result: NativePersonDeleteResult };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const text = (value: unknown, limit = 2_000_000): value is string => typeof value === 'string' && value.length <= limit;
const id = (value: unknown): value is string => text(value, 500) && Boolean(value);
const stamp = (value: unknown): value is string => text(value, 500) && Boolean(value.trim());
const iso = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const same = taskEditValuesEqual;


const detach = <T>(value: unknown): T | null => {
    const valid = (item: unknown, depth: number): boolean => {
        if (depth > 24) return false;
        if (item === null || typeof item === 'string' || typeof item === 'boolean') return true;
        if (typeof item === 'number') return Number.isFinite(item);
        return record(item) && (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)
            && Object.keys(item).length <= 128 && Object.entries(item).every(([key, part]) =>
                !['__proto__', 'constructor', 'prototype'].includes(key) && valid(part, depth + 1));
    };
    return isNativeJsonWithinBytes(value) && valid(value, 0) ? JSON.parse(JSON.stringify(value)) as T : null;
};

const livePerson = (value: unknown): value is Person => record(value)
    && Object.keys(value).every((key) => ['id', 'name', 'note', 'referenceLink', 'rev', 'revBy', 'createdAt', 'updatedAt'].includes(key))
    && id(value.id) && text(value.name) && stamp(value.createdAt) && stamp(value.updatedAt)
    && (value.note === undefined || text(value.note)) && (value.referenceLink === undefined || text(value.referenceLink))
    && (value.rev === undefined || typeof value.rev === 'number' && Number.isSafeInteger(value.rev) && value.rev >= 0)
    && (value.revBy === undefined || id(value.revBy));
const readRequest = (value: unknown): NativePersonDeleteRequest | null => {
    const input = detach<Record<string, unknown>>(value);
    return input && exact(input, ['requestId', 'personId', 'expected']) && typeof input.requestId === 'string'
        && UUID.test(input.requestId) && id(input.personId) && livePerson(input.expected)
        && input.expected.id === input.personId && same(input.expected, personPersistedSnapshot(input.expected))
        ? input as NativePersonDeleteRequest : null;
};


const readPrepared = (value: unknown): NativePreparedPersonDelete | null => {
    const envelope = detach<Record<string, unknown>>(value);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readRequest(envelope.request);
    const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'request', 'scope', 'effect', 'deviceIdBefore', 'deviceIdToInitialize', 'updateAt', 'result'])
        || raw.version !== 1 || !same(raw.request, request)
        || !record(raw.scope) || !exact(raw.scope, ['person']) || !same(raw.scope.person, request.expected)
        || !record(raw.effect) || !exact(raw.effect, ['person'])
        || !record(raw.effect.person) || !exact(raw.effect.person, ['before', 'after'])
        || !(raw.deviceIdBefore === null || id(raw.deviceIdBefore))
        || (raw.deviceIdBefore === null ? typeof raw.deviceIdToInitialize !== 'string' || !UUID.test(raw.deviceIdToInitialize)
            : raw.deviceIdToInitialize !== null)
        || !iso(raw.updateAt) || !record(raw.result) || !exact(raw.result, ['personId'])
        || raw.result.personId !== request.personId) return null;
    const prepared = raw as unknown as NativePreparedPersonDelete;
    const effect = personDeleteEffect(request.expected, prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!, prepared.updateAt);
    return same(prepared.effect, effect) ? prepared : null;
};

export function createPersonDeleteMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    t: () => (key: string) => string;
}) {
    return {
        getPersonDeleteOptions(input: { personId: string }): NativeHostResult<NativePersonDeleteOptions> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const value = detach<Record<string, unknown>>(input);
            if (!value || !exact(value, ['personId']) || !id(value.personId))
                return fail('INVALID_INPUT', 'A bounded Person ID is required');
            const person = useTaskStore.getState()._allPeople.find((row) => row.id === value.personId);
            if (!person || person.deletedAt) return fail('STALE_REVISION', 'Person changed; refresh before deleting');
            const expected = personPersistedSnapshot(person);
            if (!livePerson(expected)) return fail('INVALID_INPUT', 'Person metadata is not a valid bounded snapshot');
            const options = { personId: person.id, name: person.name, expected,
                confirm: getManageDeleteConfirm(deps.t(), person.name, 'people.deleteConfirm') };
            const detached = detach<NativePersonDeleteOptions>(options);
            return detached ? { ok: true, value: detached } : fail('INVALID_INPUT', 'Person delete options exceed the bounded response');
        },


        probePersonDeleteOutcome(input: NativePersonDeleteRequest): NativeHostResult<NativePersonDeleteResult> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded Person delete request is required');
            const current = useTaskStore.getState()._allPeople.find((person) => person.id === request.personId);
            if (!current || !iso(current.deletedAt) || current.updatedAt !== current.deletedAt || !id(current.revBy)
                || current.rev !== nextRevision(request.expected.rev))
                return fail('STALE_REVISION', 'Person deletion outcome changed; refresh before deleting');
            const observed = personDeleteEffect(request.expected, current.revBy, current.deletedAt).person.after;
            return samePersonAdditionRow(current, observed) ? { ok: true, value: { personId: request.personId } }
                : fail('STALE_REVISION', 'Person deletion outcome changed; refresh before deleting');
        },

        preparePersonDelete(input: NativePersonDeleteRequest): NativeHostResult<{ prepared: NativePreparedPersonDelete }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded Person delete request is required');
            const state = useTaskStore.getState();
            const current = state._allPeople.find((person) => person.id === request.personId);
            if (!current || current.deletedAt || !samePersonAdditionRow(current, request.expected))
                return fail('STALE_REVISION', 'Person changed; refresh before deleting');
            const device = ensureDeviceId(state.settings);
            const updateAt = new Date().toISOString();
            const prepared: NativePreparedPersonDelete = { version: 1, request, scope: { person: request.expected },
                effect: personDeleteEffect(request.expected, device.deviceId, updateAt),
                deviceIdBefore: state.settings.deviceId ?? null, deviceIdToInitialize: device.updated ? device.deviceId : null,
                updateAt, result: { personId: request.personId } };
            const frozen = detach<NativePreparedPersonDelete>(prepared);
            return frozen && readPrepared({ request, prepared: frozen }) ? { ok: true, value: { prepared: frozen } }
                : fail('INVALID_INPUT', 'Person deletion exceeds the bounded journal');
        },

        validatePreparedPersonDelete(input: { request: NativePersonDeleteRequest; prepared: NativePreparedPersonDelete }): NativeHostResult<NativePersonDeleteResult> {
            const prepared = readPrepared(input);
            return prepared ? { ok: true, value: prepared.result } : fail('INVALID_INPUT', 'Prepared Person delete request or journal does not match');
        },

        async commitPreparedPersonDelete(input: { request: NativePersonDeleteRequest; prepared: NativePreparedPersonDelete }): Promise<NativeHostResult<NativePersonDeleteResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const prepared = readPrepared(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared Person delete request or journal does not match');
            const applied = await useTaskStore.getState().commitPreparedPersonDelete(prepared);
            if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Prepared Person deletion conflicts with current data');
            try {
                if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
            } catch { return fail('SAVE_FAILED', 'Person deletion could not be saved'); }
            const saved = await deps.save();
            return saved.ok ? { ok: true, value: prepared.result } : saved;
        },
    };
}
