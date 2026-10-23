import { isValidProjectColorOverride } from './color-constants';
import type { NativeHostResult } from './native-host-contract';
import type { NativeAreaOrderToken } from './native-host-contract-area-order';
import { detach, exact, iso, record } from './native-host-contract-project-shared';
import { ensureDeviceId } from './store-helpers';
import { useTaskStore } from './store';
import { createAreaSaveGuard, readAreaDurableData } from './native-host-contract-area-durable';
import { AREA_SYNC_FIELD_SCHEMA, areaToSqliteRow } from './area-sync-schema';
import { PROJECT_SYNC_FIELD_SCHEMA, projectToSqliteRow } from './project-sync-schema';
import { TASK_SYNC_FIELD_SCHEMA, taskToSqliteRow } from './task-sync-schema';
import { MAX_SYNC_REVISION } from './sync-revision';
import { areaRenameEffect, planAreaEditorSave, selectAreaRenameScope, type AreaRenameResult } from './area-rename';
import { AREA_PRESET_COLORS, DEFAULT_AREA_COLOR } from './color-constants';
import type { PreparedAreaRename } from './store-types';
import { taskEditValuesEqual } from './json-value-equality';
import type { Area, Project, Task } from './types';

export type NativeAreaRenameRequest = { requestId: string; areaId: string; name: string;
    expected: NativeAreaOrderToken; manageColor?: string };
export type NativeAreaRenameResult = AreaRenameResult;
export type NativePreparedAreaRename = PreparedAreaRename & { version: 1 | 2; request: NativeAreaRenameRequest;
    result: NativeAreaRenameResult };
export type NativeAreaRenamePreparation = { kind: 'noop'; result: NativeAreaRenameResult }
    | { kind: 'prepared'; prepared: NativePreparedAreaRename };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const same = taskEditValuesEqual;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const areaKeys = new Set(AREA_SYNC_FIELD_SCHEMA.map((field) => field.name));
const projectKeys = new Set(PROJECT_SYNC_FIELD_SCHEMA.map((field) => field.name));
const taskKeys = new Set(TASK_SYNC_FIELD_SCHEMA.map((field) => field.name));
const revision = (value: unknown) => value === undefined || typeof value === 'number'
    && Number.isSafeInteger(value) && value >= 0 && value <= MAX_SYNC_REVISION;
const token = (area: Area): NativeAreaOrderToken => ({ id: area.id, name: area.name,
    color: area.color ?? null, order: area.order, rev: area.rev ?? null,
    revBy: area.revBy ?? null, updatedAt: area.updatedAt });

const readRequest = (value: unknown): NativeAreaRenameRequest | null => {
    const input = detach<Record<string, unknown>>(value);
    if (!input || !(exact(input, ['requestId', 'areaId', 'name', 'expected'])
        || exact(input, ['requestId', 'areaId', 'name', 'expected', 'manageColor']))
        || typeof input.requestId !== 'string' || !UUID.test(input.requestId)
        || typeof input.areaId !== 'string' || !input.areaId || input.areaId.length > 500
        || typeof input.name !== 'string' || input.name.length > 10_000
        || !record(input.expected)
        || !exact(input.expected, ['id', 'name', 'color', 'order', 'rev', 'revBy', 'updatedAt'])) return null;
    const expected = input.expected;
    if (Object.prototype.hasOwnProperty.call(input, 'manageColor')
        && (typeof input.manageColor !== 'string' || !(
            (AREA_PRESET_COLORS as readonly string[]).includes(input.manageColor)
            || input.manageColor === (expected.color || DEFAULT_AREA_COLOR)))) return null;
    return expected.id === input.areaId
        && typeof expected.name === 'string' && expected.name.length <= 10_000
        && (expected.color === null || typeof expected.color === 'string' && expected.color.length <= 500)
        && typeof expected.order === 'number' && Number.isFinite(expected.order)
        && (expected.rev === null || revision(expected.rev))
        && (expected.revBy === null || typeof expected.revBy === 'string' && expected.revBy.length <= 500)
        && iso(expected.updatedAt) ? input as NativeAreaRenameRequest : null;
};

const validArea = (value: unknown): value is Area => {
    if (!record(value) || Object.keys(value).some((key) => !areaKeys.has(key as keyof Area))
        || typeof value.id !== 'string' || !value.id || value.id.length > 500
        || typeof value.name !== 'string' || value.name.length > 10_000
        || (value.color !== undefined && (typeof value.color !== 'string' || value.color.length > 500))
        || (value.icon !== undefined && (typeof value.icon !== 'string' || value.icon.length > 10_000))
        || typeof value.order !== 'number' || !Number.isFinite(value.order) || !revision(value.rev)
        || (value.revBy !== undefined && (typeof value.revBy !== 'string' || value.revBy.length > 500))
        || !iso(value.createdAt) || !iso(value.updatedAt) || value.deletedAt !== undefined) return false;
    try { areaToSqliteRow(value as unknown as Area, value.updatedAt as string); return true; }
    catch { return false; }
};

const validProject = (value: unknown): value is Project => {
    if (!record(value) || Object.keys(value).some((key) => !projectKeys.has(key as keyof Project))
        || typeof value.id !== 'string' || !value.id || value.id.length > 500
        || typeof value.title !== 'string' || value.title.length > 100_000
        || !['active', 'someday', 'waiting', 'archived'].includes(String(value.status))
        || !isValidProjectColorOverride(value.colorOverride) || typeof value.color !== 'string' || typeof value.order !== 'number' || !Number.isFinite(value.order)
        || !Array.isArray(value.tagIds) || !value.tagIds.every((item) => typeof item === 'string')
        || !revision(value.rev) || !iso(value.createdAt) || !iso(value.updatedAt)
        || (value.areaId !== undefined && (typeof value.areaId !== 'string' || value.areaId.length > 500))
        || (value.deletedAt !== undefined && !iso(value.deletedAt))
        || (value.purgedAt !== undefined && !iso(value.purgedAt))) return false;
    try { projectToSqliteRow(value as unknown as Project); return true; }
    catch { return false; }
};

const validTask = (value: unknown): value is Task => {
    if (!record(value) || Object.keys(value).some((key) => !taskKeys.has(key as keyof Task))
        || typeof value.id !== 'string' || !value.id || value.id.length > 500
        || typeof value.title !== 'string' || value.title.length > 100_000
        || !['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived'].includes(String(value.status))
        || !Array.isArray(value.tags) || !value.tags.every((item) => typeof item === 'string')
        || !Array.isArray(value.contexts) || !value.contexts.every((item) => typeof item === 'string')
        || !revision(value.rev) || !iso(value.createdAt) || !iso(value.updatedAt)
        || (value.areaId !== undefined && (typeof value.areaId !== 'string' || value.areaId.length > 500))
        || (value.projectId !== undefined && (typeof value.projectId !== 'string' || value.projectId.length > 500))
        || (value.deletedAt !== undefined && !iso(value.deletedAt))
        || (value.purgedAt !== undefined && !iso(value.purgedAt))) return false;
    try { taskToSqliteRow(value as unknown as Task); return true; }
    catch { return false; }
};

const revisionsAdvance = <T extends { rev?: number }>(pairs: Array<{ before: T; after: T }>) =>
    pairs.every(({ before, after }) => typeof after.rev === 'number' && after.rev > (before.rev ?? 0)
        && after.rev <= MAX_SYNC_REVISION);

/** Pure cold-journal validation before SQLite opens. */
const readPrepared = (value: unknown): NativePreparedAreaRename | null => {
    const envelope = detach<Record<string, unknown>>(value);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readRequest(envelope.request);
    const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'request', 'scope', 'effect', 'deviceIdBefore',
        'deviceIdToInitialize', 'updateAt', 'result']) || (raw.version !== 1 && raw.version !== 2) || !same(raw.request, request)
        || !record(raw.scope) || !exact(raw.scope, ['areas', 'projects', 'tasks'])
        || !Array.isArray(raw.scope.areas) || !Array.isArray(raw.scope.projects) || !Array.isArray(raw.scope.tasks)
        || !record(raw.effect) || !exact(raw.effect, ['areas', 'projects', 'tasks'])
        || !Array.isArray(raw.effect.areas) || !Array.isArray(raw.effect.projects) || !Array.isArray(raw.effect.tasks)
        || !(raw.deviceIdBefore === null || typeof raw.deviceIdBefore === 'string' && Boolean(raw.deviceIdBefore))
        || (raw.deviceIdBefore === null
            ? typeof raw.deviceIdToInitialize !== 'string' || !UUID.test(raw.deviceIdToInitialize)
            : raw.deviceIdToInitialize !== null)
        || !iso(raw.updateAt) || !record(raw.result) || !exact(raw.result, ['id', 'areaId', 'name'])) return null;
    try {
        const prepared = raw as unknown as NativePreparedAreaRename;
        const { scope } = prepared;
        if (!scope.areas.length || scope.areas.some((row) => !validArea(row))
            || scope.projects.some((row) => !validProject(row)) || scope.tasks.some((row) => !validTask(row))
            || new Set(scope.areas.map((row) => row.id)).size !== scope.areas.length
            || new Set(scope.projects.map((row) => row.id)).size !== scope.projects.length
            || new Set(scope.tasks.map((row) => row.id)).size !== scope.tasks.length) return null;
        const source = scope.areas.find((row) => row.id === request.areaId);
        if (!source || !same(token(source), request.expected)) return null;
        const name = request.name.trim();
        if (!name || request.manageColor === undefined && name === source.name) return null;
        const planned = areaRenameEffect(scope, request.areaId, request.name,
            prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!, prepared.updateAt, request.manageColor, prepared.version);
        if (!planned || !same(planned.result, prepared.result) || !same(planned.effect, prepared.effect)
            || prepared.result.id !== request.areaId
            || scope.projects.some((row) => row.areaId !== request.areaId && row.areaId !== prepared.result.areaId)
            || scope.tasks.some((row) => row.areaId !== request.areaId)
            || prepared.effect.areas.length !== (prepared.result.areaId === request.areaId ? 1 : 2)
            || !revisionsAdvance(prepared.effect.areas)
            || !revisionsAdvance(prepared.effect.projects)
            || !revisionsAdvance(prepared.effect.tasks)) return null;
        return prepared;
    } catch { return null; }
};

export function createAreaRenameMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
}) {
    const saves = createAreaSaveGuard(deps.save);
    return {
        probeAreaRenameOutcome(input: NativeAreaRenameRequest): NativeHostResult<NativeAreaRenameResult> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            return readRequest(input)
                ? fail('STALE_REVISION', 'Area rename outcome is unknown; refresh before saving again')
                : fail('INVALID_INPUT', 'A bounded Area rename request is required');
        },

        async prepareAreaRename(input: NativeAreaRenameRequest): Promise<NativeHostResult<NativeAreaRenamePreparation>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded Area rename request is required');
            const updateAt = new Date().toISOString();
            const read = await readAreaDurableData();
            if (!read.ok) return read;
            const snapshot = read.value.authority.snapshot;
            const state = { _allAreas: snapshot.areas ?? [], _allProjects: snapshot.projects,
                _allSections: snapshot.sections ?? [], _allTasks: snapshot.tasks, settings: snapshot.settings };
            if ((state.settings.deviceId ?? null) !== (read.value.authority.state.settings.deviceId ?? null))
                return fail('STALE_REVISION', 'Area device changed while reading saved data');
            const source = state._allAreas.find((row) => row.id === request.areaId);
            if (!source || source.deletedAt || !same(token(source), request.expected))
                return fail('STALE_REVISION', 'Area changed; refresh before renaming');
            const name = request.name.trim();
            if (!name || request.manageColor === undefined && name === source.name) return { ok: true, value: { kind: 'noop',
                result: { id: source.id, areaId: source.id, name: source.name } } };
            const device = ensureDeviceId(state.settings);
            const rows = { areas: state._allAreas, projects: state._allProjects, tasks: state._allTasks };
            const planned = planAreaEditorSave(rows, request.areaId, request.name, request.manageColor,
                device.deviceId, updateAt);
            if (!planned) return { ok: true, value: { kind: 'noop',
                result: { id: source.id, areaId: source.id, name: source.name } } };
            const scope = selectAreaRenameScope(rows, request.areaId, planned.result.areaId);
            const effect = areaRenameEffect(scope, request.areaId, request.name, device.deviceId, updateAt,
                request.manageColor);
            if (!effect || !same(effect.result, planned.result))
                return fail('STALE_REVISION', 'Area changed; refresh before renaming');
            const prepared: NativePreparedAreaRename = { version: 2, request, scope, effect: effect.effect,
                deviceIdBefore: state.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                updateAt, result: planned.result };
            const frozen = detach<NativePreparedAreaRename>(JSON.parse(JSON.stringify(prepared)));
            return frozen && readPrepared({ request, prepared: frozen })
                ? { ok: true, value: { kind: 'prepared', prepared: frozen } }
                : fail('INVALID_INPUT', 'Area rename exceeds the bounded journal');
        },

        validatePreparedAreaRename(input: { request: NativeAreaRenameRequest;
            prepared: NativePreparedAreaRename }): NativeHostResult<NativeAreaRenameResult> {
            const prepared = readPrepared(input);
            return prepared ? { ok: true, value: prepared.result }
                : fail('INVALID_INPUT', 'Prepared Area rename request or journal does not match');
        },

        async commitPreparedAreaRename(input: { request: NativeAreaRenameRequest;
            prepared: NativePreparedAreaRename }): Promise<NativeHostResult<NativeAreaRenameResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const prepared = readPrepared(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared Area rename request or journal does not match');
            const read = await readAreaDurableData(true);
            if (!read.ok) return read;
            if (!saves.mayApply(prepared, read.value.adapter))
                return fail('SAVE_FAILED', 'Area operation has an unresolved persistence failure');
            const applied = await useTaskStore.getState().commitPreparedAreaRename(prepared, read.value.authority);
            if (!applied.success)
                return fail('STALE_REVISION', applied.error ?? 'Prepared Area rename conflicts with current data');
            const saved = await saves.finish(prepared, read.value.adapter, applied.outcome === 'replayed', read.value.authority.saveBoundary);
            return saved.ok ? { ok: true, value: prepared.result } : saved;
        },
    };
}
