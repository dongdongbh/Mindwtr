import type { NativeHostResult } from './native-host-contract';
import { AREA_PRESET_COLORS, isValidProjectColorOverride } from './color-constants';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { ensureDeviceId } from './store-helpers';
import { useTaskStore } from './store';
import { areaColorEffect, sameAreaAdditionRow, selectAreaColorScope } from './store-projects/area-actions';
import type { PreparedAreaColor } from './store-types';
import { taskEditValuesEqual } from './store-tasks';
import type { Area } from './types';

export type NativeAreaColorToken = { name: string; color: string | null; rev: number | null;
    revBy: string | null; updatedAt: string };
export type NativeAreaColorRequest = { requestId: string; areaId: string; color: string | null;
    expected: NativeAreaColorToken };
export type NativeAreaColorResult = { id: string; color: string | null };
export type NativePreparedAreaColor = PreparedAreaColor & { version: 1 | 2; request: NativeAreaColorRequest;
    result: NativeAreaColorResult };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const record = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length
    && keys.every((key) => own(value, key));
const same = taskEditValuesEqual;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const token = (area: Area): NativeAreaColorToken => ({ name: area.name, color: area.color ?? null,
    rev: area.rev ?? null, revBy: area.revBy ?? null, updatedAt: area.updatedAt });

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
const iso = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
const readRequest = (value: unknown): NativeAreaColorRequest | null => {
    const input = detach<Record<string, unknown>>(value);
    if (!input || !exact(input, ['requestId', 'areaId', 'color', 'expected'])
        || typeof input.requestId !== 'string' || !UUID.test(input.requestId)
        || typeof input.areaId !== 'string' || !input.areaId || input.areaId.length > 500
        || !(input.color === null || typeof input.color === 'string'
            && (AREA_PRESET_COLORS as readonly string[]).includes(input.color))
        || !record(input.expected) || !exact(input.expected, ['name', 'color', 'rev', 'revBy', 'updatedAt'])) return null;
    const expected = input.expected;
    return typeof expected.name === 'string' && expected.name.length <= 10_000
        && (expected.color === null || typeof expected.color === 'string' && expected.color.length <= 500)
        && (expected.rev === null || typeof expected.rev === 'number' && Number.isSafeInteger(expected.rev) && expected.rev >= 0)
        && (expected.revBy === null || typeof expected.revBy === 'string' && expected.revBy.length <= 500)
        && typeof expected.updatedAt === 'string' && expected.updatedAt.length <= 100
        ? input as NativeAreaColorRequest : null;
};

const hasObservableChange = (effect: PreparedAreaColor['effect']): boolean =>
    !sameAreaAdditionRow.area(effect.area.before, effect.area.after)
    || effect.projects.some(({ before, after }) => !sameAreaAdditionRow.project(before, after));

/** Pure cold-journal validation. Swift may call this before opening SQLite. */
const readPrepared = (value: unknown): NativePreparedAreaColor | null => {
    const envelope = detach<Record<string, unknown>>(value);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readRequest(envelope.request);
    const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'request', 'scope', 'effect', 'deviceIdBefore',
        'deviceIdToInitialize', 'updateAt', 'result']) || (raw.version !== 1 && raw.version !== 2) || !same(raw.request, request)
        || !record(raw.scope) || !exact(raw.scope, ['area', 'projects']) || !record(raw.scope.area)
        || !Array.isArray(raw.scope.projects) || !record(raw.effect)
        || !exact(raw.effect, ['area', 'projects']) || !record(raw.effect.area)
        || !exact(raw.effect.area, ['before', 'after']) || !Array.isArray(raw.effect.projects)
        || !(raw.deviceIdBefore === null || typeof raw.deviceIdBefore === 'string' && Boolean(raw.deviceIdBefore))
        || (raw.deviceIdBefore === null
            ? typeof raw.deviceIdToInitialize !== 'string' || !UUID.test(raw.deviceIdToInitialize)
            : raw.deviceIdToInitialize !== null)
        || !iso(raw.updateAt) || !record(raw.result) || !exact(raw.result, ['id', 'color'])
        || raw.result.id !== request.areaId || raw.result.color !== request.color) return null;
    try {
        const prepared = raw as unknown as NativePreparedAreaColor;
        const scope = prepared.scope;
        if (scope.area.id !== request.areaId || scope.area.deletedAt || !same(token(scope.area), request.expected)
            || typeof scope.area.name !== 'string' || typeof scope.area.order !== 'number'
            || typeof scope.area.createdAt !== 'string' || typeof scope.area.updatedAt !== 'string'
            || scope.projects.some((project) => !record(project) || project.areaId !== request.areaId
                || typeof project.id !== 'string' || !project.id || typeof project.title !== 'string'
                || !['active', 'someday', 'waiting', 'archived'].includes(project.status)
                || !isValidProjectColorOverride(project.colorOverride)
                || typeof project.color !== 'string' || typeof project.order !== 'number'
                || !Array.isArray(project.tagIds) || !project.tagIds.every((tag) => typeof tag === 'string')
                || typeof project.createdAt !== 'string' || typeof project.updatedAt !== 'string')
            || new Set(scope.projects.map((project) => project.id)).size !== scope.projects.length) return null;
        const deviceId = prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!;
        const effect = areaColorEffect(scope, request.color ?? undefined, deviceId, prepared.updateAt, prepared.version);
        return hasObservableChange(effect) && same(effect, prepared.effect) ? prepared : null;
    } catch { return null; }
};

export function createAreaColorMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    revision: () => string;
    sortedAreas: () => Area[];
}) {
    return {
        getAreaColorOptions(): NativeHostResult<{ revision: string; colors: string[];
            areas: Array<{ id: string } & NativeAreaColorToken> }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const value = { revision: deps.revision(), colors: [...AREA_PRESET_COLORS],
                areas: deps.sortedAreas().filter((area) => !area.deletedAt)
                    .map((area) => ({ id: area.id, ...token(area) })) };
            return isNativeJsonWithinBytes(value) ? { ok: true, value }
                : fail('INVALID_INPUT', 'Area list exceeds the bounded native response');
        },

        /** A cleaned journal cannot prove the old color write; observe only and require refresh. */
        probeAreaColorOutcome(input: NativeAreaColorRequest): NativeHostResult<NativeAreaColorResult> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            return readRequest(input) ? fail('STALE_REVISION', 'Area color outcome is unknown; refresh before saving again')
                : fail('INVALID_INPUT', 'A bounded Area color request is required');
        },

        prepareAreaColor(input: NativeAreaColorRequest): NativeHostResult<{ prepared: NativePreparedAreaColor }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded Area color request is required');
            const state = useTaskStore.getState();
            const scope = selectAreaColorScope(state._allAreas, state._allProjects, request.areaId);
            if (!scope || scope.area.deletedAt || !same(token(scope.area), request.expected))
                return fail('STALE_REVISION', 'Area changed; refresh before changing its color');
            const device = ensureDeviceId(state.settings);
            const updateAt = new Date().toISOString();
            const prepared: NativePreparedAreaColor = { version: 2, request, scope,
                effect: areaColorEffect(scope, request.color ?? undefined, device.deviceId, updateAt),
                deviceIdBefore: state.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                updateAt, result: { id: request.areaId, color: request.color } };
            // A receipt identical to its before state cannot prove that the write happened.
            if (!hasObservableChange(prepared.effect))
                return fail('STALE_REVISION', 'Area color revision did not advance; refresh before saving again');
            const frozen = detach<NativePreparedAreaColor>(JSON.parse(JSON.stringify(prepared)));
            return frozen && readPrepared({ request, prepared: frozen }) ? { ok: true, value: { prepared: frozen } }
                : fail('INVALID_INPUT', 'Area color change exceeds the bounded journal');
        },

        validatePreparedAreaColor(input: { request: NativeAreaColorRequest; prepared: NativePreparedAreaColor }): NativeHostResult<NativeAreaColorResult> {
            const prepared = readPrepared(input);
            return prepared ? { ok: true, value: prepared.result }
                : fail('INVALID_INPUT', 'Prepared Area color request or journal does not match');
        },

        async commitPreparedAreaColor(input: { request: NativeAreaColorRequest; prepared: NativePreparedAreaColor }): Promise<NativeHostResult<NativeAreaColorResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const prepared = readPrepared(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared Area color request or journal does not match');
            const applied = await useTaskStore.getState().commitPreparedAreaColor(prepared);
            if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Prepared Area color conflicts with current data');
            try {
                if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
            } catch (error) { return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error)); }
            const saved = await deps.save();
            return saved.ok ? { ok: true, value: prepared.result } : saved;
        },
    };
}
