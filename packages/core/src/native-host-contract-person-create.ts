import type { NativeHostResult } from './native-host-contract';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { normalizePersonName, getPersonNameKey } from './people';
import { ensureDeviceId } from './store-helpers';
import { useTaskStore } from './store';
import { personCreateProps, planPersonAddition, resolvePersonAddition } from './store-projects/people-actions';
import type { PreparedPersonCreate } from './store-types';
import { taskEditValuesEqual } from './json-value-equality';
import type { Person } from './types';

export type NativePersonCreateRequest = { requestId: string; name: string; note: string; referenceLink: string; expectedPersonId: string };
export type NativePersonCreateResult = { id: string; created: boolean };
export type NativePreparedPersonCreate = PreparedPersonCreate & {
    version: 1;
    request: NativePersonCreateRequest;
    result: { id: string; created: true };
};
export type NativePersonCreatePreparation = { kind: 'existing'; result: NativePersonCreateResult }
    | { kind: 'prepared'; prepared: NativePreparedPersonCreate };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit;
const iso = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });


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
const readRequest = (value: unknown): NativePersonCreateRequest | null => {
    const input = detach<Record<string, unknown>>(value);
    return input && exact(input, ['requestId', 'name', 'note', 'referenceLink', 'expectedPersonId'])
        && typeof input.requestId === 'string' && UUID.test(input.requestId)
        && text(input.name, 500) && Boolean(normalizePersonName(input.name))
        && text(input.note, 10_000) && text(input.referenceLink, 2_000)
        && text(input.expectedPersonId, 500) && Boolean(input.expectedPersonId)
        ? input as NativePersonCreateRequest : null;
};
const readPerson = (value: unknown): value is Person => record(value)
    && Object.keys(value).every((key) => ['id', 'name', 'note', 'referenceLink', 'rev', 'revBy', 'createdAt', 'updatedAt', 'deletedAt'].includes(key))
    && text(value.id, 500) && Boolean(value.id) && text(value.name, 500) && Boolean(normalizePersonName(value.name))
    && text(value.createdAt, 500) && Boolean(value.createdAt) && text(value.updatedAt, 500) && Boolean(value.updatedAt)
    && (value.note === undefined || text(value.note, 10_000))
    && (value.referenceLink === undefined || text(value.referenceLink, 2_000))
    && (value.rev === undefined || typeof value.rev === 'number' && Number.isSafeInteger(value.rev) && value.rev >= 0)
    && (value.revBy === undefined || typeof value.revBy === 'string' && Boolean(value.revBy))
    && (value.deletedAt === undefined || text(value.deletedAt, 500) && Boolean(value.deletedAt));


const readPrepared = (value: unknown): NativePreparedPersonCreate | null => {
    const envelope = detach<Record<string, unknown>>(value);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readRequest(envelope.request);
    const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'request', 'kind', 'scope', 'effect', 'deviceIdBefore', 'deviceIdToInitialize', 'updateAt', 'result'])
        || raw.version !== 1 || !taskEditValuesEqual(raw.request, request)
        || (raw.kind !== 'fresh' && raw.kind !== 'restored')
        || !record(raw.scope) || !exact(raw.scope, ['person'])
        || !record(raw.effect) || !exact(raw.effect, ['person'])
        || !record(raw.effect.person) || !exact(raw.effect.person, ['before', 'after'])
        || !readPerson(raw.effect.person.after)
        || !(raw.deviceIdBefore === null || typeof raw.deviceIdBefore === 'string' && Boolean(raw.deviceIdBefore))
        || (raw.deviceIdBefore === null ? typeof raw.deviceIdToInitialize !== 'string' || !UUID.test(raw.deviceIdToInitialize)
            : raw.deviceIdToInitialize !== null)
        || !iso(raw.updateAt) || !record(raw.result) || !exact(raw.result, ['id', 'created'])
        || raw.result.id !== request.expectedPersonId || raw.result.created !== true) return null;
    const prepared = raw as unknown as NativePreparedPersonCreate;
    const before = prepared.scope.person;
    if (prepared.kind === 'fresh' ? before !== null || request.expectedPersonId !== request.requestId
        : !readPerson(before) || before.id !== request.expectedPersonId || !before.deletedAt
            || getPersonNameKey(before.name) !== getPersonNameKey(request.name)) return null;
    const planned = planPersonAddition(before ? [before] : [], request.name, personCreateProps(request), request.requestId,
        prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!, prepared.updateAt);
    return planned && planned.kind === prepared.kind && planned.person.id === request.expectedPersonId
        && taskEditValuesEqual(prepared.effect, JSON.parse(JSON.stringify({ person: { before, after: planned.person } })))
        ? prepared : null;
};

export function createPersonCreateMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
}) {
    return {
        resolvePersonCreateName(input: { requestId: string; name: string }): NativeHostResult<{
            expectedPersonId: string; taken: boolean; normalizedName: string; displayName: string }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const value = detach<Record<string, unknown>>(input);
            if (!value || !exact(value, ['requestId', 'name']) || typeof value.requestId !== 'string' || !UUID.test(value.requestId)
                || !text(value.name, 500) || !normalizePersonName(value.name))
                return fail('INVALID_INPUT', 'A bounded Person name and lowercase UUID are required');
            const found = resolvePersonAddition(useTaskStore.getState()._allPeople, value.name);
            return { ok: true, value: { expectedPersonId: found?.id ?? value.requestId,
                taken: Boolean(found && !found.deletedAt), normalizedName: getPersonNameKey(value.name),
                displayName: found && !found.deletedAt ? found.name : normalizePersonName(value.name) } };
        },


        probePersonCreateOutcome(input: NativePersonCreateRequest): NativeHostResult<NativePersonCreateResult> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded Person request is required');
            const current = resolvePersonAddition(useTaskStore.getState()._allPeople, request.name);
            return current && !current.deletedAt && current.id === request.expectedPersonId
                ? { ok: true, value: { id: current.id, created: false } }
                : fail('STALE_REVISION', 'Person changed; refresh before saving again');
        },

        preparePersonCreate(input: NativePersonCreateRequest): NativeHostResult<NativePersonCreatePreparation> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded Person request and lowercase UUID are required');
            const state = useTaskStore.getState();
            const selected = resolvePersonAddition(state._allPeople, request.name);
            if (selected ? selected.id !== request.expectedPersonId : request.expectedPersonId !== request.requestId)
                return fail('STALE_REVISION', 'Person name resolution changed');
            if (selected && !selected.deletedAt) return { ok: true, value: { kind: 'existing', result: { id: selected.id, created: false } } };
            if (!selected && state._allPeople.some((person) => person.id === request.requestId))
                return fail('STALE_REVISION', 'Person request UUID is already in use');
            const device = ensureDeviceId(state.settings);
            const updateAt = new Date().toISOString();
            const planned = planPersonAddition(state._allPeople, request.name, personCreateProps(request), request.requestId, device.deviceId, updateAt);
            if (!planned || planned.kind === 'live' || planned.person.id !== request.expectedPersonId)
                return fail('STALE_REVISION', 'Person name resolution changed');
            const prepared: NativePreparedPersonCreate = { version: 1, request, kind: planned.kind,
                scope: { person: selected }, effect: { person: { before: selected, after: planned.person } },
                deviceIdBefore: state.settings.deviceId ?? null, deviceIdToInitialize: device.updated ? device.deviceId : null,
                updateAt, result: { id: request.expectedPersonId, created: true } };
            const detached = detach<NativePreparedPersonCreate>(JSON.parse(JSON.stringify(prepared)));
            return detached && readPrepared({ request, prepared: detached }) ? { ok: true, value: { kind: 'prepared', prepared: detached } }
                : fail('INVALID_INPUT', 'Person restoration exceeds the bounded journal');
        },

        validatePreparedPersonCreate(input: { request: NativePersonCreateRequest; prepared: NativePreparedPersonCreate }): NativeHostResult<NativePersonCreateResult> {
            const prepared = readPrepared(input);
            return prepared ? { ok: true, value: prepared.result } : fail('INVALID_INPUT', 'Prepared Person request or journal does not match');
        },

        async commitPreparedPersonCreate(input: { request: NativePersonCreateRequest; prepared: NativePreparedPersonCreate }): Promise<NativeHostResult<NativePersonCreateResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const prepared = readPrepared(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared Person request or journal does not match');
            const applied = await useTaskStore.getState().commitPreparedPersonCreate(prepared);
            if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Prepared Person conflicts with current data');
            try {
                if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
            } catch { return fail('SAVE_FAILED', 'Person could not be saved'); }
            const saved = await deps.save();
            return saved.ok ? { ok: true, value: prepared.result } : saved;
        },
    };
}
