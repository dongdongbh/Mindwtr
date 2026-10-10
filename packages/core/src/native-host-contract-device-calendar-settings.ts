import { strToU8 } from 'fflate';
import { decodeSystemCalendarSettings, normalizeSystemCalendarSettings, type SystemCalendarSettings } from './external-calendar-feeds';
import { taskEditValuesEqual } from './json-value-equality';
import type { NativeHostResult } from './native-host-contract';
import { exact, record } from './native-host-contract-project-shared';
import { isSystemCalendarSettings, planDeviceCalendarSetting,
    type NativeCalendarCommandResult, type NativeDeviceCalendarSettingsEdit } from './native-host-contract-settings-calendar';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { createNativeRequestReceipts, isNativeRequestReceiptDurable, NativeReceiptSqliteAdapter } from './native-request-receipts';
import { getPersistenceStatus, getStorageAdapter } from './store';

export type DeviceCalendarSettingStorage = {
    /** Exact setting and private mutation-marker cells from one checked snapshot. */
    read(): Promise<[string | null, string | null]>;
    /** The native owner atomically compares and replaces these two fixed cells. */
    compareAndSet(expected: [string | null, string | null], next: [string, string]): Promise<void>;
};
export type DeviceCalendarSettingRequest = { requestId: string; edit: NativeDeviceCalendarSettingsEdit };
export type PreparedDeviceCalendarSetting = {
    version: 1; request: DeviceCalendarSettingRequest;
    storedBefore: string | null; markerBefore: string | null;
    storedAfter: string; markerAfter: string; result: NativeCalendarCommandResult;
};
export type DeviceCalendarSettingEnvelope = { request: DeviceCalendarSettingRequest; prepared: PreparedDeviceCalendarSetting };
export type DeviceCalendarSettingPreparation = { kind: 'noop'; result: NativeCalendarCommandResult }
    | { kind: 'prepared'; prepared: PreparedDeviceCalendarSetting };

const COMMAND = 'deviceCalendarSetting';
const CELL_BYTES = 1_048_576;
const ENVELOPE_BYTES = 4 * CELL_BYTES;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED' | 'ACTION_FAILED' | 'NOT_READY', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const canonicalPayload = (value: unknown): string => JSON.stringify(value, (_key, item) => record(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : item);
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const cell = (value: unknown): value is string => typeof value === 'string'
    && value.length <= CELL_BYTES && strToU8(value).length <= CELL_BYTES;
const nullableCell = (value: unknown): value is string | null => value === null || cell(value);
const jsonRecord = (value: unknown): value is Record<string, unknown> => record(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const jsonArray = (value: unknown): value is unknown[] => Array.isArray(value) && Object.keys(value).length === value.length
    && Array.from(value.keys()).every((index) => Object.prototype.hasOwnProperty.call(value, index));
const settingsOf = (value: unknown): value is SystemCalendarSettings => jsonRecord(value)
    && (exact(value, ['enabled', 'selectAll', 'selectedCalendarIds'])
        || exact(value, ['enabled', 'selectAll', 'selectedCalendarIds', 'areaIdsByCalendar']))
    && isSystemCalendarSettings(value) && jsonArray(value.selectedCalendarIds)
    && (!('areaIdsByCalendar' in value) || jsonRecord(value.areaIdsByCalendar)
        && Object.values(value.areaIdsByCalendar).every(jsonArray));
const requestOf = (input: unknown): DeviceCalendarSettingRequest | null => {
    if (!isNativeJsonWithinBytes(input, CELL_BYTES) || !jsonRecord(input) || !exact(input, ['requestId', 'edit'])
        || typeof input.requestId !== 'string' || !UUID.test(input.requestId) || !jsonRecord(input.edit)
        || !exact(input.edit, ['type', 'before', 'value']) || input.edit.type !== 'deviceCalendars'
        || !settingsOf(input.edit.before) || !settingsOf(input.edit.value)) return null;
    return clone(input) as DeviceCalendarSettingRequest;
};
const payload = (request: DeviceCalendarSettingRequest) => canonicalPayload([COMMAND, request.edit]);
const marker = (request: DeviceCalendarSettingRequest, result: NativeCalendarCommandResult) => canonicalPayload({ version: 1, request, result });
const validResult = (value: unknown, expected: NativeCalendarCommandResult): value is NativeCalendarCommandResult => jsonRecord(value)
    && exact(value, ['changed', 'toasts', 'open', 'clearDraft']) && value.changed === true
    && Array.isArray(value.toasts) && value.toasts.length === 0 && value.clearDraft === false
    && taskEditValuesEqual(value, expected);
const originalResult = (request: DeviceCalendarSettingRequest): NativeCalendarCommandResult | null => {
    const planned = planDeviceCalendarSetting(normalizeSystemCalendarSettings(request.edit.before), request.edit);
    return planned.ok && planned.value.result.changed ? planned.value.result : null;
};

/** A same-UUID marker retains the entire original edit, not only a receipt hash. */
const checkMarker = (raw: string | null, request: DeviceCalendarSettingRequest): NativeHostResult<boolean> => {
    let parsed: unknown;
    try { parsed = raw === null ? null : JSON.parse(raw); } catch { return { ok: true, value: false }; }
    if (!record(parsed) || !record(parsed.request) || parsed.request.requestId !== request.requestId) return { ok: true, value: false };
    const original = requestOf(parsed.request), result = original && originalResult(original);
    if (!exact(parsed, ['version', 'request', 'result']) || parsed.version !== 1 || !original || !result
        || !taskEditValuesEqual(original, request) || !validResult(parsed.result, result) || raw !== marker(original, result))
        return fail('INVALID_INPUT', 'Request ID already belongs to another device calendar action');
    return { ok: true, value: true };
};

/** Validate the frozen witnesses before activation; this does not read storage or readiness. */
const preparedOf = (input: unknown): PreparedDeviceCalendarSetting | null => {
    if (!isNativeJsonWithinBytes(input, ENVELOPE_BYTES) || !jsonRecord(input) || !exact(input, ['request', 'prepared'])
        || !jsonRecord(input.prepared)) return null;
    const request = requestOf(input.request), raw = input.prepared, original = requestOf(raw.request);
    if (!request || !original || !taskEditValuesEqual(request, original)
        || !exact(raw, ['version', 'request', 'storedBefore', 'markerBefore', 'storedAfter', 'markerAfter', 'result'])
        || raw.version !== 1 || !nullableCell(raw.storedBefore) || !nullableCell(raw.markerBefore)
        || !cell(raw.storedAfter) || !cell(raw.markerAfter) || !checkMarker(raw.markerBefore, original).ok) return null;
    const planned = planDeviceCalendarSetting(decodeSystemCalendarSettings(raw.storedBefore), original.edit);
    if (!planned.ok || !planned.value.result.changed || !validResult(raw.result, planned.value.result)
        || raw.storedAfter !== canonicalPayload(planned.value.settings)
        || raw.markerAfter !== marker(original, planned.value.result)) return null;
    return clone(raw) as PreparedDeviceCalendarSetting;
};

/** Prepared device-local choices; native admission owns the journal, atomic cells, and prompts. */
export function createDeviceCalendarSettingsMethods(deps: { readiness: () => NativeHostResult<null>;
    storage: () => DeviceCalendarSettingStorage | null }) {
    type Authorization = { payload: string; adapter: NativeReceiptSqliteAdapter; storage: DeviceCalendarSettingStorage };
    const authorizations = new Map<string, Authorization>();
    const ready = (): NativeHostResult<null> => {
        const admitted = deps.readiness(); if (!admitted.ok) return admitted;
        return isNativeRequestReceiptDurable(COMMAND) && getStorageAdapter() instanceof NativeReceiptSqliteAdapter
            ? { ok: true, value: null } : fail('NOT_READY', 'Durable device calendar receipts are not available');
    };
    const settled = (): boolean => {
        const state = getPersistenceStatus();
        return !state.failed && !state.queued && !state.inFlight && !state.immediate && !state.retrying;
    };
    const owns = (authorized: Authorization): boolean => ready().ok && settled()
        && getStorageAdapter() === authorized.adapter && deps.storage() === authorized.storage;
    const receipts = createNativeRequestReceipts({
        save: async (id) => {
            const authorized = authorizations.get(id);
            return authorized && owns(authorized) ? { ok: true, value: null }
                : fail('SAVE_FAILED', 'Device calendar receipt ownership changed');
        },
        receiptOnly: async (id, frozen) => {
            const authorized = authorizations.get(id);
            return Boolean(authorized && authorized.payload === frozen && owns(authorized)
                && await authorized.adapter.commitReceiptOnly(id, frozen));
        },
    });
    const saved = (request: DeviceCalendarSettingRequest): NativeHostResult<NativeCalendarCommandResult> | null => {
        const known = receipts.saved<NativeCalendarCommandResult>(request.requestId, payload(request));
        if (!known || !known.ok) return known;
        const expected = originalResult(request);
        return expected && validResult(known.value, expected) ? known : fail('INVALID_INPUT', 'Saved device calendar receipt is malformed');
    };
    const read = async (storage: DeviceCalendarSettingStorage): Promise<NativeHostResult<[string | null, string | null]>> => {
        let cells: unknown;
        try { cells = await storage.read(); } catch { return fail('ACTION_FAILED', 'Device calendar storage could not be read; retry the same request'); }
        return jsonArray(cells) && cells.length === 2 && cells.every(nullableCell)
            ? { ok: true, value: cells as [string | null, string | null] }
            : fail('INVALID_INPUT', 'Device calendar storage exceeds the cell bound');
    };
    return {
        async prepareDeviceCalendarSetting(input: unknown): Promise<NativeHostResult<DeviceCalendarSettingPreparation>> {
            const request = requestOf(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded device calendar request is required');
            const admitted = ready(); if (!admitted.ok) return admitted;
            const known = saved(request); if (known) return known.ok ? { ok: true, value: { kind: 'noop', result: known.value } } : known;
            const storage = deps.storage(), adapter = getStorageAdapter();
            if (!storage) return fail('ACTION_FAILED', 'Device calendar storage is not available');
            if (!settled()) return fail('ACTION_FAILED', 'Device calendar settings have unresolved persistence work');
            const cells = await read(storage); if (!cells.ok) return cells;
            if (!ready().ok || !settled() || getStorageAdapter() !== adapter || deps.storage() !== storage)
                return fail('STALE_REVISION', 'Device calendar storage changed');
            const identity = checkMarker(cells.value[1], request); if (!identity.ok) return identity;
            if (identity.value) return fail('STALE_REVISION', 'Retry the original prepared device calendar request');
            const planned = planDeviceCalendarSetting(decodeSystemCalendarSettings(cells.value[0]), request.edit);
            if (!planned.ok) return planned;
            if (!planned.value.result.changed) return { ok: true, value: { kind: 'noop', result: planned.value.result } };
            const prepared: PreparedDeviceCalendarSetting = { version: 1, request,
                storedBefore: cells.value[0], markerBefore: cells.value[1], storedAfter: canonicalPayload(planned.value.settings),
                markerAfter: marker(request, planned.value.result), result: planned.value.result };
            return preparedOf({ request, prepared }) ? { ok: true, value: { kind: 'prepared', prepared: clone(prepared) } }
                : fail('INVALID_INPUT', 'Device calendar preparation exceeds the bounded journal');
        },
        validatePreparedDeviceCalendarSetting(input: unknown): NativeHostResult<NativeCalendarCommandResult> {
            const prepared = preparedOf(input);
            return prepared ? { ok: true, value: prepared.result } : fail('INVALID_INPUT', 'Prepared device calendar request is malformed');
        },
        async commitPreparedDeviceCalendarSetting(input: unknown): Promise<NativeHostResult<NativeCalendarCommandResult>> {
            const prepared = preparedOf(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared device calendar request is malformed');
            const admitted = ready(); if (!admitted.ok) return admitted;
            const request = prepared.request, known = saved(request);
            if (known) return known;
            const storage = deps.storage(), adapter = getStorageAdapter();
            if (!storage || !(adapter instanceof NativeReceiptSqliteAdapter)) return fail('NOT_READY', 'Device calendar storage is not available');
            if (!settled()) return fail('ACTION_FAILED', 'Device calendar settings have unresolved persistence work');
            const key = payload(request), authorized = authorizations.get(request.requestId);
            if (authorized && (authorized.payload !== key || authorized.adapter !== adapter || authorized.storage !== storage))
                return fail('STALE_REVISION', 'Device calendar receipt ownership changed');
            const outcome = await receipts.run<NativeCalendarCommandResult>(request.requestId, key, async () => {
                const cells = await read(storage); if (!cells.ok) return cells;
                const authority: Authorization = { payload: key, adapter, storage };
                if (!owns(authority)) return fail('STALE_REVISION', 'Device calendar storage changed');
                const identity = checkMarker(cells.value[1], request); if (!identity.ok) return identity;
                if (cells.value[1] !== prepared.markerAfter) {
                    if (cells.value[0] !== prepared.storedBefore || cells.value[1] !== prepared.markerBefore)
                        return fail('STALE_REVISION', 'Device calendar choices changed; refresh Settings');
                    try { await storage.compareAndSet([prepared.storedBefore, prepared.markerBefore], [prepared.storedAfter, prepared.markerAfter]); }
                    catch { return fail('ACTION_FAILED', 'Device calendar choices could not be saved; retry the same request'); }
                }
                authorizations.set(request.requestId, authority);
                return { ok: true, value: prepared.result };
            });
            if (outcome.ok) authorizations.delete(request.requestId);
            return outcome;
        },
        probeDeviceCalendarSettingOutcome(input: unknown): NativeHostResult<NativeCalendarCommandResult> {
            const request = requestOf(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded device calendar request is required');
            const admitted = ready(); if (!admitted.ok) return admitted;
            return saved(request) ?? fail('STALE_REVISION', 'Device calendar outcome is unknown; retry the original prepared request');
        },
    };
}
