import type { NativeHostResult } from './native-host-contract';
import { AREA_PRESET_COLORS, DEFAULT_AREA_COLOR } from './color-constants';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { ensureDeviceId } from './store-helpers';
import { useTaskStore } from './store';
import { createAreaSaveGuard, readAreaDurableData } from './native-host-contract-area-durable';
import { areaAdditionEffect, planAreaAddition, selectAreaAdditionScope } from './store-projects/area-actions';
import type { PreparedAreaCreate } from './store-types';
import { taskEditValuesEqual } from './store-tasks';
import type { Area } from './types';

export type NativeAreaCreateRequest = { requestId: string; name: string; color: string; expectedAreaId: string };
export type NativeAreaCreateResult = { id: string; created: boolean };
export type NativePreparedAreaCreate = PreparedAreaCreate & {
    version: 1 | 2;
    request: NativeAreaCreateRequest;
    result: { id: string; created: true };
};
export type NativeAreaCreatePreparation = { kind: 'existing'; result: NativeAreaCreateResult }
    | { kind: 'prepared'; prepared: NativePreparedAreaCreate };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length
    && keys.every((key) => own(value, key));
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const same = taskEditValuesEqual;

/** Refuse non-JSON inputs and oversized UTF-8 envelopes before a store or SQL write. */
const detach = <T>(value: unknown): T | null => {
    const valid = (item: unknown, depth: number): boolean => {
        if (depth > 24) return false;
        if (item === null || typeof item === 'string' || typeof item === 'boolean') return true;
        if (typeof item === 'number') return Number.isFinite(item);
        if (Array.isArray(item)) return item.length <= 100_000 && item.every((part) => valid(part, depth + 1));
        return record(item) && (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)
            && Object.keys(item).length <= 128 && Object.entries(item).every(([key, part]) =>
                !['__proto__', 'constructor', 'prototype'].includes(key) && valid(part, depth + 1));
    };
    if (!isNativeJsonWithinBytes(value) || !valid(value, 0)) return null;
    return JSON.parse(JSON.stringify(value)) as T;
};
const normalized = (name: string) => name.trim().toLowerCase();
const resolution = (areas: readonly Area[], name: string) => {
    const match = (area: Area) => area.name?.trim().toLowerCase() === normalized(name);
    return areas.find((area) => !area.deletedAt && match(area))
        ?? areas.find((area) => area.deletedAt && match(area)) ?? null;
};
const orderMax = (areas: readonly Area[]) => areas.reduce((max, area) =>
    Math.max(max, Number.isFinite(area.order) ? area.order : -1), -1);
const iso = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
const readRequest = (value: unknown): NativeAreaCreateRequest | null => {
    const input = detach<Record<string, unknown>>(value);
    return input && exact(input, ['requestId', 'name', 'color', 'expectedAreaId'])
        && typeof input.requestId === 'string' && UUID.test(input.requestId)
        && typeof input.name === 'string' && Boolean(input.name.trim())
        && typeof input.color === 'string' && (input.color === DEFAULT_AREA_COLOR
            || (AREA_PRESET_COLORS as readonly string[]).includes(input.color))
        && typeof input.expectedAreaId === 'string' && Boolean(input.expectedAreaId) && input.expectedAreaId.length <= 500
        ? input as NativeAreaCreateRequest : null;
};

/** Pure and usable to validate a cold-start journal before opening SQLite. */
const readPrepared = (value: unknown): NativePreparedAreaCreate | null => {
    const envelope = detach<Record<string, unknown>>(value);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readRequest(envelope.request);
    const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'request', 'kind', 'scope', 'effect', 'deviceIdBefore',
        'deviceIdToInitialize', 'orderMax', 'restoreAt', 'updateAt', 'result'])
        || (raw.version !== 1 && raw.version !== 2) || !same(raw.request, request)
        || (raw.kind !== 'fresh' && raw.kind !== 'restored')
        || !record(raw.scope) || !exact(raw.scope, ['area', 'projects', 'sections', 'tasks'])
        || !Array.isArray(raw.scope.projects) || !Array.isArray(raw.scope.sections) || !Array.isArray(raw.scope.tasks)
        || !record(raw.effect) || !exact(raw.effect, ['area', 'projects', 'sections', 'tasks'])
        || !record(raw.effect.area) || !exact(raw.effect.area, ['before', 'after'])
        || !Array.isArray(raw.effect.projects) || !Array.isArray(raw.effect.sections) || !Array.isArray(raw.effect.tasks)
        || !(raw.deviceIdBefore === null || typeof raw.deviceIdBefore === 'string' && Boolean(raw.deviceIdBefore))
        || (raw.deviceIdBefore === null
            ? typeof raw.deviceIdToInitialize !== 'string' || !UUID.test(raw.deviceIdToInitialize)
            : raw.deviceIdToInitialize !== null)
        || typeof raw.orderMax !== 'number' || !Number.isFinite(raw.orderMax) || raw.orderMax < -1
        || !iso(raw.restoreAt) || !iso(raw.updateAt)
        || !record(raw.result) || !exact(raw.result, ['id', 'created'])
        || raw.result.id !== request.expectedAreaId || raw.result.created !== true) return null;
    try {
        const prepared = raw as unknown as NativePreparedAreaCreate;
        const { scope } = prepared;
        if (prepared.kind === 'fresh') {
            if (scope.area !== null || scope.projects.length || scope.sections.length || scope.tasks.length
                || request.expectedAreaId !== request.requestId) return null;
        } else if (!record(scope.area) || scope.area.id !== request.expectedAreaId || !scope.area.deletedAt
            || normalized(scope.area.name) !== normalized(request.name)) return null;
        const witness = prepared.kind === 'fresh' && prepared.orderMax > -1
            ? [{ id: 'native-area-order-witness', name: `${request.name.trim()}\u0000`, order: prepared.orderMax,
                createdAt: prepared.restoreAt, updatedAt: prepared.restoreAt } as Area]
            : [];
        const planned = planAreaAddition({ areas: scope.area ? [scope.area] : witness,
            projects: scope.projects, sections: scope.sections, tasks: scope.tasks }, request.name,
        { color: request.color }, request.requestId, prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!,
        prepared.restoreAt, prepared.updateAt, prepared.version);
        if (!planned || planned.kind !== prepared.kind || planned.area.id !== request.expectedAreaId) return null;
        const expected = areaAdditionEffect(scope, planned.rows, request.expectedAreaId);
        return same(prepared.effect, expected) ? prepared : null;
    } catch { return null; }
};

export function createAreaCreateMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    revision: () => string;
    sortedAreas: () => Area[];
}) {
    const saves = createAreaSaveGuard(deps.save);
    return {
        getAreaCreateOptions(): NativeHostResult<{ revision: string; defaultColor: string; colors: string[];
            areas: Array<{ id: string; name: string; color: string | null }> }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const value = { revision: deps.revision(), defaultColor: AREA_PRESET_COLORS[0],
                colors: [...AREA_PRESET_COLORS],
                areas: deps.sortedAreas().filter((area) => !area.deletedAt)
                    .map((area) => ({ id: area.id, name: area.name, color: area.color ?? null })) };
            return isNativeJsonWithinBytes(value) ? { ok: true, value }
                : fail('INVALID_INPUT', 'Area list exceeds the bounded native response');
        },

        resolveAreaCreateName(input: { requestId: string; name: string }): NativeHostResult<{
            expectedAreaId: string; taken: boolean; normalizedName: string }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const value = detach<Record<string, unknown>>(input);
            if (!value || !exact(value, ['requestId', 'name']) || typeof value.requestId !== 'string'
                || !UUID.test(value.requestId) || typeof value.name !== 'string' || !value.name.trim())
                return fail('INVALID_INPUT', 'A bounded Area name and lowercase UUID are required');
            const found = resolution(useTaskStore.getState()._allAreas, value.name);
            return { ok: true, value: { expectedAreaId: found?.id ?? value.requestId,
                taken: Boolean(found && !found.deletedAt), normalizedName: normalized(value.name) } };
        },

        /** Used only after retryPending() found no journal; this cannot create or restore an Area. */
        probeAreaCreateOutcome(input: NativeAreaCreateRequest): NativeHostResult<NativeAreaCreateResult> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded Area request is required');
            const current = resolution(useTaskStore.getState()._allAreas, request.name);
            return current && !current.deletedAt && current.id === request.expectedAreaId
                ? { ok: true, value: { id: current.id, created: false } }
                : fail('STALE_REVISION', 'Area changed; refresh before saving again');
        },

        async prepareAreaCreate(input: NativeAreaCreateRequest): Promise<NativeHostResult<NativeAreaCreatePreparation>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded Area name, supported color, and lowercase UUID are required');
            const restoreAt = new Date().toISOString();
            const updateAt = new Date().toISOString();
            const read = await readAreaDurableData();
            if (!read.ok) return read;
            const snapshot = read.value.authority.snapshot;
            const state = { _allAreas: snapshot.areas ?? [], _allProjects: snapshot.projects,
                _allSections: snapshot.sections ?? [], _allTasks: snapshot.tasks, settings: snapshot.settings };
            if ((state.settings.deviceId ?? null) !== (read.value.authority.state.settings.deviceId ?? null))
                return fail('STALE_REVISION', 'Area device changed while reading saved data');
            const selected = resolution(state._allAreas, request.name);
            if (selected?.id !== request.expectedAreaId && (selected || request.expectedAreaId !== request.requestId))
                return fail('STALE_REVISION', 'Area name resolution changed');
            if (selected && !selected.deletedAt) return { ok: true, value: { kind: 'existing',
                result: { id: selected.id, created: false } } };
            const device = ensureDeviceId(state.settings);
            const rows = { areas: state._allAreas, projects: state._allProjects,
                sections: state._allSections, tasks: state._allTasks };
            const scope = selectAreaAdditionScope(rows, selected);
            const planned = planAreaAddition(rows, request.name, { color: request.color }, request.requestId,
                device.deviceId, restoreAt, updateAt);
            if (!planned || planned.kind === 'live' || planned.area.id !== request.expectedAreaId)
                return fail('STALE_REVISION', 'Area name resolution changed');
            const prepared: NativePreparedAreaCreate = { version: 2, request, kind: planned.kind,
                scope, effect: areaAdditionEffect(scope, planned.rows, request.expectedAreaId),
                deviceIdBefore: state.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                orderMax: orderMax(rows.areas), restoreAt, updateAt,
                result: { id: request.expectedAreaId, created: true } };
            const detached = detach<NativePreparedAreaCreate>(JSON.parse(JSON.stringify(prepared)));
            return detached && readPrepared({ request, prepared: detached })
                ? { ok: true, value: { kind: 'prepared', prepared: detached } }
                : fail('INVALID_INPUT', 'Area restoration exceeds the bounded journal');
        },

        validatePreparedAreaCreate(input: { request: NativeAreaCreateRequest; prepared: NativePreparedAreaCreate }): NativeHostResult<NativeAreaCreateResult> {
            const prepared = readPrepared(input);
            return prepared ? { ok: true, value: prepared.result }
                : fail('INVALID_INPUT', 'Prepared Area request or journal does not match');
        },

        async commitPreparedAreaCreate(input: { request: NativeAreaCreateRequest; prepared: NativePreparedAreaCreate }): Promise<NativeHostResult<NativeAreaCreateResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const prepared = readPrepared(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared Area request or journal does not match');
            const read = await readAreaDurableData(true);
            if (!read.ok) return read;
            if (!saves.mayApply(prepared, read.value.adapter))
                return fail('SAVE_FAILED', 'Area operation has an unresolved persistence failure');
            const applied = await useTaskStore.getState().commitPreparedAreaCreate(prepared, read.value.authority);
            if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Prepared Area conflicts with current data');
            const saved = await saves.finish(prepared, read.value.adapter, applied.outcome === 'replayed', read.value.authority.saveBoundary);
            return saved.ok ? { ok: true, value: prepared.result } : saved;
        },
    };
}
