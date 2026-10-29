import type { NativeHostResult } from './native-host-contract';
import { areaOrderIdsForIntent, sortAreasForOrderDisplay, type AreaOrderIntent } from './area-ordering';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { ensureDeviceId } from './store-helpers';
import { useTaskStore } from './store';
import { areaOrderEffect, sameAreaAdditionRow } from './store-projects/area-actions';
import type { PreparedAreaOrder } from './store-types';
import { taskEditValuesEqual } from './store-tasks';
import type { Area } from './types';
import { AREA_PRESET_COLORS } from './color-constants';
import { countLiveProjectsByArea } from './area-project-usage';
import { revisionOf } from './native-request-receipts';

export type NativeAreaOrderToken = { id: string; name: string; color: string | null; order: number;
    rev: number | null; revBy: string | null; updatedAt: string };
export type NativeAreaOrderRequest = { requestId: string; intent: AreaOrderIntent;
    expectedAreas: NativeAreaOrderToken[] };
export type NativeAreaOrderResult = { orderedIds: string[] };
export type NativePreparedAreaOrder = PreparedAreaOrder & { version: 1; request: NativeAreaOrderRequest;
    result: NativeAreaOrderResult };
/** Android's journaled area order (#1263): RN's intent on the order the sheet showed, a target state. */
export type NativeAreaOrderRun = { requestId: string; intent: AreaOrderIntent; order: string[] };
export type NativeAreaOrderPreparation = { kind: 'noop'; result: NativeAreaOrderResult }
    | { kind: 'prepared'; prepared: NativePreparedAreaOrder };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const record = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
    Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const same = taskEditValuesEqual;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const token = (area: Area): NativeAreaOrderToken => ({ id: area.id, name: area.name,
    color: area.color ?? null, order: area.order, rev: area.rev ?? null,
    revBy: area.revBy ?? null, updatedAt: area.updatedAt });
const iso = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;

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

const readRequest = (value: unknown): NativeAreaOrderRequest | null => {
    const input = detach<Record<string, unknown>>(value);
    if (!input || !exact(input, ['requestId', 'intent', 'expectedAreas'])
        || typeof input.requestId !== 'string' || !UUID.test(input.requestId)
        || !record(input.intent) || !Array.isArray(input.expectedAreas)) return null;
    const intent = input.intent;
    if (!(intent.kind === 'moveUp' ? exact(intent, ['kind', 'areaId'])
        && typeof intent.areaId === 'string' && intent.areaId.length > 0 && intent.areaId.length <= 500
        : (intent.kind === 'sortName' || intent.kind === 'sortColor') && exact(intent, ['kind']))) return null;
    const ids = new Set<string>();
    for (const item of input.expectedAreas) {
        if (!record(item) || !exact(item, ['id', 'name', 'color', 'order', 'rev', 'revBy', 'updatedAt'])
            || typeof item.id !== 'string' || !item.id || item.id.length > 500 || ids.has(item.id)
            || typeof item.name !== 'string' || item.name.length > 10_000
            || !(item.color === null || typeof item.color === 'string' && item.color.length <= 500)
            || typeof item.order !== 'number' || !Number.isFinite(item.order)
            || !(item.rev === null || typeof item.rev === 'number' && Number.isSafeInteger(item.rev) && item.rev >= 0)
            || !(item.revBy === null || typeof item.revBy === 'string' && item.revBy.length <= 500)
            || typeof item.updatedAt !== 'string' || item.updatedAt.length > 100) return null;
        ids.add(item.id);
    }
    return input as NativeAreaOrderRequest;
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

/** Pure cold-journal validation before SQLite opens. */
const readPrepared = (value: unknown): NativePreparedAreaOrder | null => {
    const envelope = detach<Record<string, unknown>>(value);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readRequest(envelope.request);
    const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'request', 'scope', 'effect', 'deviceIdBefore',
        'deviceIdToInitialize', 'updateAt', 'result']) || raw.version !== 1 || !same(raw.request, request)
        || !record(raw.scope) || !exact(raw.scope, ['areas']) || !Array.isArray(raw.scope.areas)
        || !record(raw.effect) || !exact(raw.effect, ['areas']) || !Array.isArray(raw.effect.areas)
        || !(raw.deviceIdBefore === null || typeof raw.deviceIdBefore === 'string' && Boolean(raw.deviceIdBefore))
        || (raw.deviceIdBefore === null
            ? typeof raw.deviceIdToInitialize !== 'string' || !UUID.test(raw.deviceIdToInitialize)
            : raw.deviceIdToInitialize !== null)
        || !iso(raw.updateAt) || !record(raw.result) || !exact(raw.result, ['orderedIds'])
        || !Array.isArray(raw.result.orderedIds)) return null;
    try {
        const prepared = raw as unknown as NativePreparedAreaOrder;
        const areas = prepared.scope.areas;
        if (!areas.length || areas.length !== request.expectedAreas.length
            || prepared.effect.areas.length !== areas.length
            || areas.some((area) => !validArea(area))
            || new Set(areas.map((area) => area.id)).size !== areas.length
            || !same(areas, sortAreasForOrderDisplay(areas))
            || !same(areas.map(token), request.expectedAreas)) return null;
        const orderedIds = areaOrderIdsForIntent(areas, request.intent);
        if (!orderedIds || !same(orderedIds, prepared.result.orderedIds)) return null;
        const effect = areaOrderEffect(areas, orderedIds,
            prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!, prepared.updateAt);
        return effect.areas.some(({ before, after }) => !sameAreaAdditionRow.area(before, after))
            && same(effect, prepared.effect) ? prepared : null;
    } catch { return null; }
};

export function createAreaOrderMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    revision: () => string;
    sortedAreas: () => Area[];
}) {
    const methods = {
        getAreaOrderOptions(): NativeHostResult<{ revision: string; areas: NativeAreaOrderToken[] }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const value = { revision: deps.revision(), areas: deps.sortedAreas().filter((area) => !area.deletedAt).map(token) };
            return isNativeJsonWithinBytes(value) ? { ok: true, value }
                : fail('INVALID_INPUT', 'Area order options exceed the bounded native response');
        },
        /**
         * Android's Manage areas sheet (#1263, RN ProjectAreaModals.tsx): the live areas in order, each with Settings' revision (its
         * swatch-free writes are Settings' manageEditor and manageDelete) and whether a live project uses it (RN's Delete is off
         * then), and RN's swatches. iOS keeps reading getAreaOrderOptions, whose keys stay exact.
         */
        getProjectAreaManager(): NativeHostResult<{ revision: string; colors: string[]; newArea: { type: 'newArea' };
            areas: Array<{ id: string; name: string; color: string | null; inUse: boolean; delete: { type: 'area'; id: string; revision: string } }> }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const usage = countLiveProjectsByArea(useTaskStore.getState().projects);
            // Settings' targets, sent as given: the new area's (manageCheck, manageEditor) and each row's Delete (manageDelete).
            const value = { revision: deps.revision(), colors: [...AREA_PRESET_COLORS], newArea: { type: 'newArea' as const },
                areas: deps.sortedAreas().filter((area) => !area.deletedAt).map((area) => ({ id: area.id, name: area.name,
                    color: area.color ?? null, inUse: (usage.get(area.id) ?? 0) > 0,
                    delete: { type: 'area' as const, id: area.id, revision: revisionOf(area) } })) };
            return isNativeJsonWithinBytes(value) ? { ok: true, value }
                : fail('INVALID_INPUT', 'Area manager exceeds the bounded native response');
        },
        probeAreaOrderOutcome(input: NativeAreaOrderRequest): NativeHostResult<NativeAreaOrderResult> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            return readRequest(input) ? fail('STALE_REVISION', 'Area order outcome is unknown; refresh before saving again')
                : fail('INVALID_INPUT', 'A bounded Area order request is required');
        },
        prepareAreaOrder(input: NativeAreaOrderRequest): NativeHostResult<NativeAreaOrderPreparation> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded Area order request is required');
            const state = useTaskStore.getState();
            const areas = sortAreasForOrderDisplay(state._allAreas);
            if (!same(areas.map(token), request.expectedAreas))
                return fail('STALE_REVISION', 'Areas changed; refresh before reordering');
            const orderedIds = areaOrderIdsForIntent(areas, request.intent);
            if (!orderedIds) return fail('STALE_REVISION', 'Area cannot move up; refresh before reordering');
            if (areas.length === 0) return { ok: true, value: { kind: 'noop', result: { orderedIds: [] } } };
            const device = ensureDeviceId(state.settings);
            const updateAt = new Date().toISOString();
            const prepared: NativePreparedAreaOrder = { version: 1, request, scope: { areas },
                effect: areaOrderEffect(areas, orderedIds, device.deviceId, updateAt),
                deviceIdBefore: state.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                updateAt, result: { orderedIds } };
            const frozen = isNativeJsonWithinBytes(prepared)
                ? detach<NativePreparedAreaOrder>(JSON.parse(JSON.stringify(prepared))) : null;
            return frozen && readPrepared({ request, prepared: frozen })
                ? { ok: true, value: { kind: 'prepared', prepared: frozen } }
                : fail('INVALID_INPUT', 'Area order exceeds the bounded journal');
        },
        validatePreparedAreaOrder(input: { request: NativeAreaOrderRequest; prepared: NativePreparedAreaOrder }): NativeHostResult<NativeAreaOrderResult> {
            const prepared = readPrepared(input);
            return prepared ? { ok: true, value: prepared.result }
                : fail('INVALID_INPUT', 'Prepared Area order request or journal does not match');
        },
        async commitPreparedAreaOrder(input: { request: NativeAreaOrderRequest; prepared: NativePreparedAreaOrder }): Promise<NativeHostResult<NativeAreaOrderResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const prepared = readPrepared(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared Area order request or journal does not match');
            const applied = await useTaskStore.getState().commitPreparedAreaOrder(prepared);
            if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Prepared Area order conflicts with current data');
            try {
                if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
            } catch (error) { return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error)); }
            const saved = await deps.save();
            return saved.ok ? { ok: true, value: prepared.result } : saved;
        },

        /**
         * Android's Manage areas sheet: [input]'s intent on the order it showed, prepared and committed here (Android journals the
         * request, not the envelope). The order the intent makes from the shown order already in place (a replay) answers
         * unchanged; any other change since the sheet read refuses. A save owed from before is finished first.
         */
        async runAreaOrder(input: NativeAreaOrderRun): Promise<NativeHostResult<{ outcome: 'saved' | 'unchanged'; orderedIds: string[] }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const order = record(input) && exact(input, ['requestId', 'intent', 'order']) && Array.isArray(input.order)
                && input.order.length <= 100_000 && input.order.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 500)
                && new Set(input.order).size === input.order.length ? input.order : null;
            if (!order || !readRequest({ requestId: input.requestId, intent: input.intent, expectedAreas: [] }))
                return fail('INVALID_INPUT', 'A bounded Area order request is required');
            try {
                if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
            } catch (error) { return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error)); }
            const unchanged = async (orderedIds: string[]) => {
                const saved = await deps.save();
                return saved.ok ? { ok: true as const, value: { outcome: 'unchanged' as const, orderedIds } } : saved;
            };
            let stale = 'Areas changed; refresh before reordering';
            for (let attempt = 0; attempt < 4; attempt += 1) {
                const options = methods.getAreaOrderOptions();
                if (!options.ok) return options;
                const areas = options.value.areas;
                const ids = areas.map((area) => area.id);
                if (!same(ids, order)) {
                    const byId = new Map(areas.map((area) => [area.id, area]));
                    const shown = order.map((id) => byId.get(id));
                    const target = order.length === ids.length && shown.every(Boolean)
                        ? areaOrderIdsForIntent(shown as NativeAreaOrderToken[], input.intent) : null;
                    return target && same(target, ids) ? unchanged(ids)
                        : fail('STALE_REVISION', 'The Areas changed since they were shown');
                }
                const target = areaOrderIdsForIntent(areas, input.intent);
                if (!target) return fail('STALE_REVISION', 'Area cannot move up; refresh before reordering');
                if (same(target, ids)) return unchanged(ids);
                const request = { requestId: input.requestId, intent: input.intent, expectedAreas: areas };
                const prepared = methods.prepareAreaOrder(request);
                if (!prepared.ok) {
                    if (prepared.error.code !== 'STALE_REVISION') return prepared;
                    stale = prepared.error.message;
                    continue;
                }
                if (prepared.value.kind === 'noop') return unchanged(ids);
                const committed = await methods.commitPreparedAreaOrder({ request, prepared: prepared.value.prepared });
                if (committed.ok) return { ok: true, value: { outcome: 'saved', orderedIds: committed.value.orderedIds } };
                if (committed.error.code !== 'STALE_REVISION') return committed;
                stale = committed.error.message;
            }
            return fail('STALE_REVISION', stale);
        },
    };
    return methods;
}
