import { isValidProjectColorOverride } from './color-constants';
import type { NativeHostResult } from './native-host-contract';
import { countLiveProjectsByArea } from './area-project-usage';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { ensureDeviceId } from './store-helpers';
import { useTaskStore } from './store';
import { createAreaSaveGuard, readAreaDurableData } from './native-host-contract-area-durable';
import { areaDeleteEffect, sameAreaAdditionRow, selectAreaDeleteScope } from './store-projects/area-actions';
import type { PreparedAreaDelete } from './store-types';
import { taskEditValuesEqual } from './store-tasks';
import { taskToSqliteRow } from './task-sync-schema';
import { projectToSqliteRow } from './project-sync-schema';
import type { Area, Project, Task } from './types';

export type NativeAreaDeleteToken = { name: string; color: string | null; order: number;
    rev: number | null; revBy: string | null; updatedAt: string };
export type NativeAreaDeleteRequest = { requestId: string; areaId: string; expected: NativeAreaDeleteToken;
    detachProjects?: true };
export type NativeAreaDeleteResult = { areaId: string };
export type NativePreparedAreaDelete = PreparedAreaDelete & { version: 1 | 2; request: NativeAreaDeleteRequest;
    result: NativeAreaDeleteResult };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const record = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
    Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const same = taskEditValuesEqual;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const iso = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
const token = (area: Area): NativeAreaDeleteToken => ({ name: area.name, color: area.color ?? null,
    order: area.order, rev: area.rev ?? null, revBy: area.revBy ?? null, updatedAt: area.updatedAt });

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

const readRequest = (value: unknown): NativeAreaDeleteRequest | null => {
    const input = detach<Record<string, unknown>>(value);
    if (!input || !exact(input, input.detachProjects === true
        ? ['requestId', 'areaId', 'expected', 'detachProjects'] : ['requestId', 'areaId', 'expected'])
        || typeof input.requestId !== 'string' || !UUID.test(input.requestId)
        || typeof input.areaId !== 'string' || !input.areaId || input.areaId.length > 500
        || !record(input.expected) || !exact(input.expected, ['name', 'color', 'order', 'rev', 'revBy', 'updatedAt']))
        return null;
    const expected = input.expected;
    return typeof expected.name === 'string' && expected.name.length <= 10_000
        && (expected.color === null || typeof expected.color === 'string' && expected.color.length <= 500)
        && typeof expected.order === 'number' && Number.isFinite(expected.order)
        && (expected.rev === null || typeof expected.rev === 'number'
            && Number.isSafeInteger(expected.rev) && expected.rev >= 0)
        && (expected.revBy === null || typeof expected.revBy === 'string' && expected.revBy.length <= 500)
        && iso(expected.updatedAt) ? input as NativeAreaDeleteRequest : null;
};

const validArea = (value: unknown): value is Area => record(value)
    && typeof value.id === 'string' && Boolean(value.id) && value.id.length <= 500
    && typeof value.name === 'string' && value.name.length <= 10_000
    && (value.color === undefined || typeof value.color === 'string' && value.color.length <= 500)
    && (value.icon === undefined || typeof value.icon === 'string' && value.icon.length <= 10_000)
    && typeof value.order === 'number' && Number.isFinite(value.order)
    && (value.rev === undefined || typeof value.rev === 'number' && Number.isSafeInteger(value.rev) && value.rev >= 0)
    && (value.revBy === undefined || typeof value.revBy === 'string' && value.revBy.length <= 500)
    && iso(value.createdAt) && iso(value.updatedAt) && value.deletedAt === undefined;

const validTask = (value: unknown, areaId: string): value is Task => {
    if (!record(value) || typeof value.id !== 'string' || !value.id || value.id.length > 500
        || typeof value.title !== 'string' || value.title.length > 100_000
        || !['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived'].includes(String(value.status))
        || value.areaId !== areaId || !Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === 'string')
        || !Array.isArray(value.contexts) || !value.contexts.every((context) => typeof context === 'string')
        || !iso(value.createdAt) || !iso(value.updatedAt)
        || (value.deletedAt !== undefined && !iso(value.deletedAt))
        || (value.rev !== undefined && !(typeof value.rev === 'number' && Number.isSafeInteger(value.rev) && value.rev >= 0))
        || (value.revBy !== undefined && typeof value.revBy !== 'string')) return false;
    try { taskToSqliteRow(value as unknown as Task); return true; }
    catch { return false; }
};

const validProject = (value: unknown, areaId: string): value is Project => {
    if (!record(value) || typeof value.id !== 'string' || !value.id || value.id.length > 500
        || typeof value.title !== 'string' || value.title.length > 100_000
        || !['active', 'someday', 'waiting', 'archived'].includes(String(value.status))
        || !isValidProjectColorOverride(value.colorOverride) || typeof value.color !== 'string' || typeof value.order !== 'number' || !Number.isFinite(value.order)
        || !Array.isArray(value.tagIds) || !value.tagIds.every((item) => typeof item === 'string')
        || value.areaId !== areaId || value.deletedAt !== undefined
        || !iso(value.createdAt) || !iso(value.updatedAt)
        || (value.rev !== undefined && !(typeof value.rev === 'number' && Number.isSafeInteger(value.rev) && value.rev >= 0))
        || (value.revBy !== undefined && typeof value.revBy !== 'string')) return false;
    try { projectToSqliteRow(value as unknown as Project); return true; }
    catch { return false; }
};

/** Pure cold-journal validation before SQLite opens. */
const readPrepared = (value: unknown): NativePreparedAreaDelete | null => {
    const envelope = detach<Record<string, unknown>>(value);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readRequest(envelope.request);
    const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'request', 'scope', 'effect', 'deviceIdBefore',
        'deviceIdToInitialize', 'updateAt', 'result']) || (raw.version !== 1 && raw.version !== 2) || !same(raw.request, request)
        || !record(raw.scope) || !exact(raw.scope, ['area', 'tasks', 'liveProjects'])
        || !record(raw.scope.area) || !Array.isArray(raw.scope.tasks)
        || !Array.isArray(raw.scope.liveProjects) || (!request.detachProjects && raw.scope.liveProjects.length !== 0)
        || !record(raw.effect) || !exact(raw.effect, request.detachProjects
            ? ['area', 'tasks', 'projects'] : ['area', 'tasks'])
        || !record(raw.effect.area) || !exact(raw.effect.area, ['before', 'after'])
        || !Array.isArray(raw.effect.tasks)
        || (request.detachProjects && !Array.isArray(raw.effect.projects))
        || !(raw.deviceIdBefore === null || typeof raw.deviceIdBefore === 'string' && Boolean(raw.deviceIdBefore))
        || (raw.deviceIdBefore === null
            ? typeof raw.deviceIdToInitialize !== 'string' || !UUID.test(raw.deviceIdToInitialize)
            : raw.deviceIdToInitialize !== null)
        || !iso(raw.updateAt) || !record(raw.result) || !exact(raw.result, ['areaId'])
        || raw.result.areaId !== request.areaId) return null;
    try {
        const prepared = raw as unknown as NativePreparedAreaDelete;
        const scope = prepared.scope;
        if (!validArea(scope.area) || scope.area.id !== request.areaId
            || !same(token(scope.area), request.expected)
            || scope.tasks.some((task) => !validTask(task, request.areaId))
            || scope.liveProjects.some((project) => !validProject(project, request.areaId))
            || new Set(scope.tasks.map((task) => task.id)).size !== scope.tasks.length
            || new Set(scope.liveProjects.map((project) => project.id)).size !== scope.liveProjects.length
            || prepared.effect.tasks.length !== scope.tasks.length
            || (request.detachProjects && prepared.effect.projects?.length !== scope.liveProjects.length)) return null;
        const effect = areaDeleteEffect(scope, prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!,
            prepared.updateAt, request.detachProjects, prepared.version);
        return same(effect, prepared.effect)
            && !sameAreaAdditionRow.area(effect.area.before, effect.area.after) ? prepared : null;
    } catch { return null; }
};

export function createAreaDeleteMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    revision: () => string;
    sortedAreas: () => Area[];
}) {
    const saves = createAreaSaveGuard(deps.save);
    return {
        getAreaDeleteOptions(): NativeHostResult<{ revision: string;
            areas: Array<{ id: string } & NativeAreaDeleteToken & { projectCount: number; canDelete: boolean }> }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const usage = countLiveProjectsByArea(useTaskStore.getState()._allProjects);
            const value = { revision: deps.revision(), areas: deps.sortedAreas().filter((area) => !area.deletedAt)
                .map((area) => ({ id: area.id, ...token(area), projectCount: usage.get(area.id) ?? 0,
                    canDelete: !usage.has(area.id) })) };
            return isNativeJsonWithinBytes(value) ? { ok: true, value }
                : fail('INVALID_INPUT', 'Area delete options exceed the bounded native response');
        },
        probeAreaDeleteOutcome(input: NativeAreaDeleteRequest): NativeHostResult<NativeAreaDeleteResult> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            return readRequest(input) ? fail('STALE_REVISION', 'Area delete outcome is unknown; refresh before deleting again')
                : fail('INVALID_INPUT', 'A bounded Area delete request is required');
        },
        async prepareAreaDelete(input: NativeAreaDeleteRequest): Promise<NativeHostResult<{ prepared: NativePreparedAreaDelete }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded Area delete request is required');
            const updateAt = new Date().toISOString();
            const read = await readAreaDurableData();
            if (!read.ok) return read;
            const snapshot = read.value.authority.snapshot;
            const state = { _allAreas: snapshot.areas ?? [], _allProjects: snapshot.projects,
                _allSections: snapshot.sections ?? [], _allTasks: snapshot.tasks, settings: snapshot.settings };
            if ((state.settings.deviceId ?? null) !== (read.value.authority.state.settings.deviceId ?? null))
                return fail('STALE_REVISION', 'Area device changed while reading saved data');
            const scope = selectAreaDeleteScope(state._allAreas, state._allProjects, state._allTasks, request.areaId);
            if (!scope || scope.area.deletedAt || !same(token(scope.area), request.expected)
                || (!request.detachProjects && (scope.liveProjects.length !== 0
                    || countLiveProjectsByArea(state._allProjects).has(request.areaId))))
                return fail('STALE_REVISION', 'Area changed or is in use; refresh before deleting');
            const device = ensureDeviceId(state.settings);
            const prepared: NativePreparedAreaDelete = { version: 2, request, scope,
                effect: areaDeleteEffect(scope, device.deviceId, updateAt, request.detachProjects),
                deviceIdBefore: state.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                updateAt, result: { areaId: request.areaId } };
            const frozen = isNativeJsonWithinBytes(prepared)
                ? detach<NativePreparedAreaDelete>(JSON.parse(JSON.stringify(prepared))) : null;
            return frozen && readPrepared({ request, prepared: frozen })
                ? { ok: true, value: { prepared: frozen } }
                : fail('INVALID_INPUT', 'Area delete exceeds the bounded journal');
        },
        validatePreparedAreaDelete(input: { request: NativeAreaDeleteRequest; prepared: NativePreparedAreaDelete }): NativeHostResult<NativeAreaDeleteResult> {
            const prepared = readPrepared(input);
            return prepared ? { ok: true, value: prepared.result }
                : fail('INVALID_INPUT', 'Prepared Area delete request or journal does not match');
        },
        async commitPreparedAreaDelete(input: { request: NativeAreaDeleteRequest; prepared: NativePreparedAreaDelete }): Promise<NativeHostResult<NativeAreaDeleteResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const prepared = readPrepared(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared Area delete request or journal does not match');
            const read = await readAreaDurableData(true);
            if (!read.ok) return read;
            if (!saves.mayApply(prepared, read.value.adapter))
                return fail('SAVE_FAILED', 'Area operation has an unresolved persistence failure');
            const applied = await useTaskStore.getState().commitPreparedAreaDelete(prepared, read.value.authority);
            if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Prepared Area delete conflicts with current data');
            const saved = await saves.finish(prepared, read.value.adapter, applied.outcome === 'replayed', read.value.authority.saveBoundary);
            return saved.ok ? { ok: true, value: prepared.result } : saved;
        },
    };
}
