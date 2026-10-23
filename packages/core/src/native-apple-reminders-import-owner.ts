import { resolveDefaultNewTaskAreaId } from './area-utils';
import { taskEditValuesEqual } from './json-value-equality';
import { validatePreparedNativeAppleReminderImportItem, type NativeAppleReminderImportResult,
    type PreparedNativeAppleReminderImportItem } from './native-apple-reminders-import-item';
import { createAreaSaveGuard, readAreaDurableData } from './native-host-contract-area-durable';
import type { NativeHostErrorCode, NativeHostResult } from './native-host-contract';
import { createNativeRequestReceipts, isNativeRequestReceiptDurable, NativeReceiptSqliteAdapter } from './native-request-receipts';
import { getPersistenceStatus, getStorageAdapter, useTaskStore } from './store';
import type { PreparedAreaAuthority, PreparedNativeSaveBoundary } from './store-types';

const fail = (code: NativeHostErrorCode, message: string): NativeHostResult<never> => ({ ok: false, error: { code, message } });
const same = taskEditValuesEqual;
const payload = (prepared: PreparedNativeAppleReminderImportItem): string => JSON.stringify(
    ['appleReminderImportItem', prepared], (_name, value) =>
        value && typeof value === 'object' && !Array.isArray(value)
            ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);

/** Inactive item persistence only. The native journal owns registry publication and fresh task liveness. */
export function createNativeAppleReminderImportOwner(deps: {
    readiness: () => NativeHostResult<null>; save: () => Promise<NativeHostResult<null>>;
}) {
    type Owned = { prepared: PreparedNativeAppleReminderImportItem; adapter: NativeReceiptSqliteAdapter;
        boundary?: PreparedNativeSaveBoundary };
    let pending: Owned | null = null;
    let running = false;
    const saves = createAreaSaveGuard(deps.save);
    const readPlan = (input: unknown) => {
        try { return validatePreparedNativeAppleReminderImportItem(input); } catch { return null; }
    };
    const proof = async (prepared: PreparedNativeAppleReminderImportItem, adapter: NativeReceiptSqliteAdapter)
        : Promise<NativeHostResult<NativeAppleReminderImportResult | null>> => {
        const result = await adapter.readDurableReceipt(prepared.request.requestId, payload(prepared), { committedOnly: true });
        if (getStorageAdapter() !== adapter) return fail('STALE_REVISION', 'Reminders import storage changed');
        if (!result.ok) return result;
        if (result.value === null) return { ok: true, value: null };
        return same(result.value, prepared.result) ? { ok: true, value: prepared.result }
            : fail('STALE_REVISION', 'Reminders import receipt reply changed');
    };
    const readAuthority = async (owned: Owned, retry: boolean) => {
        const state = useTaskStore.getState(), generation = getPersistenceStatus().generation;
        if (getStorageAdapter() !== owned.adapter || !await owned.adapter.readRowBaseline())
            return fail('STALE_REVISION', 'Reminders import requires its accepted storage baseline');
        if (getStorageAdapter() !== owned.adapter || useTaskStore.getState() !== state
            || getPersistenceStatus().generation !== generation)
            return fail('STALE_REVISION', 'Reminders import changed while checking storage');
        const read = await readAreaDurableData(retry, true);
        if (!read.ok) return read;
        if (read.value.adapter !== owned.adapter || getPersistenceStatus().generation !== generation)
            return fail('STALE_REVISION', 'Reminders import storage generation changed');
        const plan = owned.prepared, data = read.value.authority.snapshot;
        if (plan.mode !== 'new' || data.tasks.some((task) => task.id === plan.target.id)
            || (data.settings.deviceId ?? null) !== plan.factory.deviceIdBefore
            || (resolveDefaultNewTaskAreaId(data.settings, data.areas ?? []) ?? null) !== plan.factory.effectiveDefaultAreaId)
            return fail('STALE_REVISION', 'Reminders import target or creation settings changed');
        return { ok: true as const, value: read.value.authority };
    };
    const apply = async (owned: Owned, authority: PreparedAreaAuthority): Promise<NativeHostResult<null>> => {
        const plan = owned.prepared;
        if (plan.mode !== 'new') return fail('INVALID_INPUT', 'Existing Reminders ownership cannot create a task');
        const result = await useTaskStore.getState().commitPreparedCapture({ task: plan.task, project: null,
            deviceIdBefore: plan.factory.deviceIdBefore, deviceIdToInitialize: plan.factory.deviceIdToInitialize },
        { requireBefore: true, authority, rawBefore: { tasks: [{ id: plan.target.id, before: null }], projects: [], sections: [] } });
        owned.boundary = authority.saveBoundary;
        return result.success ? { ok: true, value: null } : fail('STALE_REVISION', 'Reminders import target changed before save');
    };
    const receipts = createNativeRequestReceipts({
        save: async (requestId) => {
            const owned = pending;
            if (!owned || owned.prepared.request.requestId !== requestId || getStorageAdapter() !== owned.adapter)
                return fail('SAVE_FAILED', 'Reminders import has no matching owned save');
            if (owned.prepared.mode === 'existing') {
                return useTaskStore.getState().persistenceFailure ? fail('SAVE_FAILED', 'Another save needs recovery')
                    : { ok: true, value: null };
            }
            if (useTaskStore.getState().persistenceFailure) {
                if (!saves.mayApply(owned.prepared, owned.adapter)) return fail('SAVE_FAILED', 'Another save needs recovery');
                const read = await readAuthority(owned, true); if (!read.ok) return read;
                const written = await apply(owned, read.value); if (!written.ok) return written;
            }
            return saves.finish(owned.prepared, owned.adapter, false, owned.boundary);
        },
        receiptOnly: async (requestId, encoded) => {
            const owned = pending;
            // New tasks must carry their receipt in the task transaction, never a later receipt-only save.
            return Boolean(owned && owned.prepared.mode === 'existing' && owned.prepared.request.requestId === requestId
                && payload(owned.prepared) === encoded && getStorageAdapter() === owned.adapter
                && await owned.adapter.commitReceiptOnly(requestId, encoded));
        },
    });
    return {
        async outcome(input: unknown): Promise<NativeHostResult<NativeAppleReminderImportResult | null>> {
            const prepared = readPlan(input); if (!prepared) return fail('INVALID_INPUT', 'Invalid Reminders import item');
            const adapter = getStorageAdapter();
            if (!(adapter instanceof NativeReceiptSqliteAdapter)) return fail('SAVE_FAILED', 'Reminders import storage is unavailable');
            return proof(prepared, adapter);
        },
        async commit(input: unknown): Promise<NativeHostResult<NativeAppleReminderImportResult>> {
            const prepared = readPlan(input); if (!prepared) return fail('INVALID_INPUT', 'Invalid Reminders import item');
            if (running) return fail('ACTION_FAILED', 'A Reminders item is already running');
            running = true;
            try {
                const adapter = getStorageAdapter();
                if (!(adapter instanceof NativeReceiptSqliteAdapter) || !adapter.concurrentWritesGuarded
                    || !isNativeRequestReceiptDurable('appleReminderImportItem'))
                    return fail('SAVE_FAILED', 'Reminders import requires durable guarded storage');
                const saved = await proof(prepared, adapter);
                if (!saved.ok) return saved;
                if (saved.value !== null) {
                    if (pending?.adapter === adapter && same(pending.prepared, prepared)
                        && !useTaskStore.getState().persistenceFailure) pending = null;
                    return { ok: true, value: saved.value };
                }
                const encoded = payload(prepared), cached = receipts.saved(prepared.request.requestId, encoded);
                if (cached) return cached.ok ? fail('SAVE_FAILED', 'Reminders import lost its durable receipt') : cached;
                if (pending && (pending.adapter !== adapter || !same(pending.prepared, prepared)))
                    return fail('SAVE_FAILED', 'An earlier Reminders item needs recovery');
                const ready = deps.readiness(); if (!ready.ok) return ready;
                let refused: NativeHostResult<never> | null = null;
                const result = await receipts.run(prepared.request.requestId, encoded, async () => {
                    if (useTaskStore.getState().persistenceFailure) return fail('ACTION_FAILED', 'Another save needs recovery');
                    const status = getPersistenceStatus();
                    if (status.queued || status.inFlight || status.immediate || status.retrying || useTaskStore.getState().editLockCount > 0)
                        return fail('ACTION_FAILED', 'Another task operation is active');
                    const owned: Owned = { prepared, adapter };
                    if (prepared.mode === 'new') {
                        const read = await readAuthority(owned, false);
                        if (!read.ok) { refused = read; return fail('ACTION_FAILED', read.error.message); }
                        const written = await apply(owned, read.value); if (!written.ok) return written;
                    }
                    pending = owned;
                    return { ok: true, value: prepared.result };
                });
                if (refused) return refused;
                const confirmed = await proof(prepared, adapter);
                if (!confirmed.ok) return confirmed;
                if (confirmed.value !== null) {
                    if (!useTaskStore.getState().persistenceFailure) pending = null;
                    return { ok: true, value: confirmed.value };
                }
                return result.ok ? fail('SAVE_FAILED', 'Reminders import has no durable receipt') : result;
            } catch { return fail('SAVE_FAILED', 'Reminders import could not settle its saved item'); }
            finally { running = false; }
        },
    };
}
