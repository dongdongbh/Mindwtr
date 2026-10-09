import { calendarSubscriptionSettingSource,
    readCalendarSubscriptionSettingWitness, CALENDAR_SUBSCRIPTION_REQUEST_BYTES, CALENDAR_SUBSCRIPTION_ENVELOPE_BYTES,
    type CalendarSubscriptionSettingWitness } from './calendar-subscription-settings-witness';
import { readAreaDurableData } from './native-host-contract-area-durable';
import { detach, exact, iso, record } from './native-host-contract-project-shared';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import type { NativeHostResult } from './native-host-contract';
import { addCalendarFeed, addCalendarFile } from './calendar-settings-model';
import type { CalendarSubscriptionSourceStorage } from './native-host-contract-calendar-subscription-settings';
import { createNativeRequestReceipts, isNativeRequestReceiptDurable, NativeReceiptSqliteAdapter } from './native-request-receipts';
import { taskEditValuesEqual } from './json-value-equality';
import { ensureDeviceId } from './store-helpers';
import { timestampAtLeastAfter } from './store-settings';
import { getPersistenceStatus, getStorageAdapter, useTaskStore } from './store';
import type { PreparedAreaAuthority } from './store-types';
import type { ExternalCalendarSubscription } from './ics';
import { calendarSubscriptionModules } from './store-calendar-subscription-modules';

export type CalendarSubscriptionAddRequest = { requestId: string; name: string; url: string; defaultName: string; expected: CalendarSubscriptionSettingWitness };
export type CalendarSubscriptionAddResult = { changed: true; toasts: []; open: null; clearDraft: true };
export type PreparedCalendarSubscriptionAdd = { version: 1; request: CalendarSubscriptionAddRequest; preparedAt: string;
    deviceIdBefore: string | null; deviceIdToInitialize: string | null; stamp: string };
export type CalendarSubscriptionAddEnvelope = { request: CalendarSubscriptionAddRequest; prepared: PreparedCalendarSubscriptionAdd };
export type CalendarSubscriptionAddPreparation = { kind: 'noop'; result: CalendarSubscriptionAddResult }
    | { kind: 'prepared'; prepared: PreparedCalendarSubscriptionAdd };

const COMMAND = 'calendarSubscriptionAdd';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const recovery = () => fail('SAVE_FAILED', 'Calendar subscription save requires fresh runtime recovery');
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED' | 'ACTION_FAILED' | 'NOT_READY', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const resultFor = (): CalendarSubscriptionAddResult => ({ changed: true, toasts: [], open: null, clearDraft: true });
const validResult = (value: unknown): value is CalendarSubscriptionAddResult => taskEditValuesEqual(value, resultFor());
const canonical = (value: unknown): string => JSON.stringify(value, (_name, item) => record(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const payload = (request: CalendarSubscriptionAddRequest) => canonical([COMMAND, request]);
const requestOf = (input: unknown): CalendarSubscriptionAddRequest | null => {
    if (!isNativeJsonWithinBytes(input, CALENDAR_SUBSCRIPTION_REQUEST_BYTES)) return null;
    const value = detach<Record<string, unknown>>(input);
    if (!value || !exact(value, ['requestId', 'name', 'url', 'defaultName', 'expected'])
        || typeof value.requestId !== 'string' || !UUID.test(value.requestId)
        || typeof value.name !== 'string' || value.name.length > 500
        || typeof value.url !== 'string' || value.url.length > 4000 || !value.url.trim()
        || typeof value.defaultName !== 'string' || value.defaultName.length > 500 || !value.defaultName.trim()) return null;
    const expected = readCalendarSubscriptionSettingWitness(value.expected);
    return expected ? { requestId: value.requestId, name: value.name, url: value.url, defaultName: value.defaultName, expected } : null;
};
const preparedOf = (input: unknown): PreparedCalendarSubscriptionAdd | null => {
    try {
    if (!isNativeJsonWithinBytes(input, CALENDAR_SUBSCRIPTION_ENVELOPE_BYTES)) return null;
    const value = detach<Record<string, unknown>>(input);
    if (!value || !exact(value, ['request', 'prepared']) || !record(value.prepared)) return null;
    const request = requestOf(value.request), prepared = value.prepared;
    if (!request || !exact(prepared, ['version', 'request', 'preparedAt', 'deviceIdBefore', 'deviceIdToInitialize', 'stamp'])
        || prepared.version !== 1 || !planCalendarSubscriptionAdd([], request) || !taskEditValuesEqual(prepared.request, request) || !iso(prepared.preparedAt)
        || !(prepared.deviceIdBefore === null || typeof prepared.deviceIdBefore === 'string'
            && prepared.deviceIdBefore.length > 0 && prepared.deviceIdBefore.length <= 500)
        || (prepared.deviceIdBefore === null ? typeof prepared.deviceIdToInitialize !== 'string' || !UUID.test(prepared.deviceIdToInitialize)
            : prepared.deviceIdToInitialize !== null)
        || prepared.stamp !== timestampAtLeastAfter(prepared.preparedAt, request.expected.stamp ?? undefined)) return null;
    return prepared as PreparedCalendarSubscriptionAdd;
    } catch { return null; }
};

/** The existing RN row factory; IDs, not URL strings, identify a new subscription. */
export function planCalendarSubscriptionAdd(feeds: readonly ExternalCalendarSubscription[], input: CalendarSubscriptionAddRequest): ExternalCalendarSubscription[] | null {
    const request = requestOf(input);
    if (!request || feeds.some((feed) => feed.id === request.requestId)) return null;
    const next = addCalendarFeed(feeds, { id: request.requestId, name: request.name, url: request.url, defaultName: request.defaultName });
    // Legacy RN defaults can include color:undefined; capture the JSON SQLite will actually store.
    return next ? JSON.parse(JSON.stringify(next)) as ExternalCalendarSubscription[] : null;
}

calendarSubscriptionModules.add = planCalendarSubscriptionAdd;

/** Canonical-only URL Add; native holds the legacy fixed-cell lease through COMMIT. */
export function createCalendarSubscriptionAddMethods(deps: {
    readiness: () => NativeHostResult<null>; save: () => Promise<NativeHostResult<null>>;
    storage: () => CalendarSubscriptionSourceStorage | null;
}) {
    type Authorization = { payload: string; adapter: NativeReceiptSqliteAdapter; authority: PreparedAreaAuthority;
        prepared: PreparedCalendarSubscriptionAdd; storage: CalendarSubscriptionSourceStorage | null; legacyRaw: string | null };
    const authorizations = new Map<string, Authorization>();
    const ready = (): NativeHostResult<null> => {
        const result = deps.readiness(); if (!result.ok) return result;
        return getStorageAdapter() instanceof NativeReceiptSqliteAdapter && isNativeRequestReceiptDurable(COMMAND)
            ? { ok: true, value: null } : fail('NOT_READY', 'Durable calendar subscription receipts are unavailable');
    };
    const ownsBoundary = (owned: Authorization): boolean => {
        const state = useTaskStore.getState(), boundary = owned.authority.saveBoundary, raw = owned.authority.rawSavedSnapshot;
        const status = getPersistenceStatus();
        return Boolean(boundary && raw && getStorageAdapter() === owned.adapter && state.settings === raw.settings
            && state._allTasks === boundary.taskReference && state.lastDataChangeAt === boundary.lastDataChangeAt
            && status.generation === boundary.generation && state.persistenceFailure === boundary.failure);
    };
    const ownsSource = async (owned: Authorization): Promise<boolean> => {
        if (!ready().ok || !ownsBoundary(owned)) return false;
        if (owned.prepared.request.expected.source === 'canonical') return true;
        if (!owned.storage || deps.storage() !== owned.storage) return false;
        try {
            const raw = await owned.storage.read();
            return ready().ok && ownsBoundary(owned) && deps.storage() === owned.storage && raw === owned.legacyRaw;
        } catch { return false; }
    };
    const receipts = createNativeRequestReceipts({
        save: async (id) => {
            const owned = authorizations.get(id);
            if (!owned || !await ownsSource(owned)) return recovery();
            if (useTaskStore.getState().persistenceFailure) {
                // A rolled-back save may outlive a later durable import; never flush its old snapshot over that data.
                try {
                    const durable = await owned.adapter.getData({ rawTasks: true });
                    if (!await ownsSource(owned) || !taskEditValuesEqual(durable, owned.authority.snapshot)) return recovery();
                } catch { return recovery(); }
                const retried = await useTaskStore.getState().retryPreparedCalendarSubscriptionSettingSnapshot(owned.authority);
                if (!retried.success) return recovery();
            }
            if (!await ownsSource(owned)) return recovery();
            const boundary = owned.authority.saveBoundary!, raw = owned.authority.rawSavedSnapshot!;
            const before = useTaskStore.getState();
            const saved = await deps.save();
            const after = useTaskStore.getState();
            if (!saved.ok && saved.error.code === 'SAVE_FAILED' && after.persistenceFailure
                && after.persistenceFailure !== before.persistenceFailure && getStorageAdapter() === owned.adapter
                && after._allTasks === boundary.taskReference && after.settings === raw.settings
                && after.lastDataChangeAt === boundary.lastDataChangeAt && getPersistenceStatus().generation === boundary.generation)
                owned.authority.saveBoundary = { ...boundary, failure: after.persistenceFailure };
            return saved;
        },
        receiptOnly: async (id, frozen) => {
            const owned = authorizations.get(id);
            return Boolean(owned && owned.payload === frozen && !useTaskStore.getState().persistenceFailure
                && await ownsSource(owned) && await owned.adapter.commitReceiptOnly(id, frozen));
        },
    });
    const saved = async (request: CalendarSubscriptionAddRequest): Promise<NativeHostResult<CalendarSubscriptionAddResult> | null> => {
        const key = payload(request), identity = receipts.checkIdentity(request.requestId, key);
        if (!identity.ok) return identity;
        const adapter = getStorageAdapter();
        if (!(adapter instanceof NativeReceiptSqliteAdapter)) return fail('NOT_READY', 'Durable calendar subscription receipts are unavailable');
        const stored = await adapter.readDurableReceipt(request.requestId, key);
        if (!ready().ok || getStorageAdapter() !== adapter) return fail('STALE_REVISION', 'Calendar subscription storage changed');
        if (!stored.ok) return stored;
        const owned = authorizations.get(request.requestId), status = getPersistenceStatus();
        if (stored.value !== null && owned && (useTaskStore.getState().persistenceFailure
            || status.queued || status.inFlight || status.immediate || status.retrying)) return recovery();
        return stored.value === null ? null : validResult(stored.value) ? { ok: true, value: stored.value }
            : fail('INVALID_INPUT', 'Saved calendar subscription receipt is malformed');
    };
    const read = async () => {
        if (useTaskStore.getState().persistenceFailure) return fail('SAVE_FAILED', 'Calendar subscriptions have unresolved persistence work');
        const status = getPersistenceStatus();
        if (status.queued || status.inFlight || status.immediate || status.retrying)
            return fail('ACTION_FAILED', 'Calendar subscriptions have unresolved persistence work');
        const result = await readAreaDurableData(false, true);
        if (!result.ok) return result;
        const { adapter, authority } = result.value;
        if (!(adapter instanceof NativeReceiptSqliteAdapter)) return fail('NOT_READY', 'Durable calendar subscription receipts are unavailable');
        const storage = Array.isArray(authority.snapshot.settings.externalCalendars) ? null : deps.storage();
        const ownsRead = () => {
            const state = useTaskStore.getState(), before = authority.state, currentStatus = getPersistenceStatus();
            return ready().ok && getStorageAdapter() === adapter && state.settings === before.settings && state._allTasks === before._allTasks
                && state._allProjects === before._allProjects && state._allAreas === before._allAreas
                && state._allSections === before._allSections && state._allPeople === before._allPeople
                && state.lastDataChangeAt === before.lastDataChangeAt && (!storage || deps.storage() === storage)
                && currentStatus.generation === status.generation && !state.persistenceFailure
                && !currentStatus.queued && !currentStatus.inFlight && !currentStatus.immediate && !currentStatus.retrying;
        };
        let legacyRaw: string | null = null;
        if (!Array.isArray(authority.snapshot.settings.externalCalendars)) {
            if (!storage) return fail('ACTION_FAILED', 'Calendar subscription source storage is unavailable');
            try { legacyRaw = await storage.read(); } catch { return ownsRead()
                ? fail('ACTION_FAILED', 'Calendar subscription source could not be read') : fail('STALE_REVISION', 'Calendar subscription source changed'); }
        }
        if (!ownsRead()) return fail('STALE_REVISION', 'Calendar subscription source changed');
        const source = calendarSubscriptionSettingSource(authority.snapshot.settings, legacyRaw);
        return source ? { ok: true as const, value: { adapter, authority, source, storage, legacyRaw } }
            : fail('INVALID_INPUT', 'Saved calendar subscriptions are malformed or exceed the source bound');
    };
    return {
        createCalendarSubscriptionFileAddRequest(input: unknown): NativeHostResult<CalendarSubscriptionAddRequest> {
            const invalid = () => fail('INVALID_INPUT', 'A bounded native calendar file selection is required');
            if (!isNativeJsonWithinBytes(input, CALENDAR_SUBSCRIPTION_REQUEST_BYTES)) return invalid();
            const value = detach<Record<string, unknown>>(input);
            if (!value || !exact(value, ['request', 'uri', 'fileName']) || !record(value.request)
                || !exact(value.request, ['requestId', 'name', 'defaultName', 'expected'])
                || typeof value.uri !== 'string' || !value.uri.startsWith('file:///')
                || typeof value.fileName !== 'string' || value.fileName.length > 500) return invalid();
            const request = requestOf({ ...value.request, url: value.uri });
            if (!request) return invalid();
            // Native owns the copied file; shared RN code owns its display name.
            const row = addCalendarFile([], { id: request.requestId, name: request.name,
                fileName: value.fileName, uri: value.uri, defaultName: request.defaultName })[0];
            const frozen = requestOf({ ...request, name: row.name });
            return frozen ? { ok: true, value: frozen } : invalid();
        },
        async probeCalendarSubscriptionAddOutcome(input: unknown): Promise<NativeHostResult<CalendarSubscriptionAddResult>> {
            const request = requestOf(input); if (!request) return fail('INVALID_INPUT', 'A bounded calendar subscription request is required');
            const admitted = ready(); if (!admitted.ok) return admitted;
            return await saved(request) ?? fail('STALE_REVISION', 'Calendar subscription outcome is unknown');
        },
        async prepareCalendarSubscriptionAdd(input: unknown): Promise<NativeHostResult<CalendarSubscriptionAddPreparation>> {
            const request = requestOf(input); if (!request) return fail('INVALID_INPUT', 'A bounded calendar subscription request is required');
            const admitted = ready(); if (!admitted.ok) return admitted;
            const known = await saved(request); if (known) return known.ok ? { ok: true, value: { kind: 'noop', result: known.value } } : known;
            const loaded = await read(); if (!loaded.ok) return loaded;
            if (!taskEditValuesEqual(loaded.value.source.witness, request.expected)) return fail('STALE_REVISION', 'Calendar subscriptions changed; refresh Settings');
            const planned = planCalendarSubscriptionAdd(loaded.value.source.feeds, request);
            if (!planned) return fail('STALE_REVISION', 'Calendar subscription identity is already present');
            if (!calendarSubscriptionSettingSource({ ...loaded.value.authority.snapshot.settings, externalCalendars: planned }, null))
                return fail('INVALID_INPUT', 'Added calendar subscriptions exceed the source bound');
            const settings = loaded.value.authority.snapshot.settings, device = ensureDeviceId(settings), preparedAt = new Date().toISOString();
            let stamp: string;
            try { stamp = timestampAtLeastAfter(preparedAt, request.expected.stamp ?? undefined); }
            catch { return fail('INVALID_INPUT', 'Calendar subscription clock exceeds the supported bound'); }
            const prepared: PreparedCalendarSubscriptionAdd = { version: 1, request, preparedAt,
                deviceIdBefore: settings.deviceId ?? null, deviceIdToInitialize: device.updated ? device.deviceId : null,
                stamp };
            return preparedOf({ request, prepared }) ? { ok: true, value: { kind: 'prepared', prepared } }
                : fail('INVALID_INPUT', 'Calendar subscription preparation exceeds the journal bound');
        },
        validatePreparedCalendarSubscriptionAdd(input: unknown): NativeHostResult<CalendarSubscriptionAddResult> {
            return preparedOf(input) ? { ok: true, value: resultFor() }
                : fail('INVALID_INPUT', 'Prepared calendar subscription request is malformed');
        },
        async commitPreparedCalendarSubscriptionAdd(input: unknown): Promise<NativeHostResult<CalendarSubscriptionAddResult>> {
            const prepared = preparedOf(input); if (!prepared) return fail('INVALID_INPUT', 'Prepared calendar subscription request is malformed');
            const admitted = ready(); if (!admitted.ok) return admitted;
            const request = prepared.request, known = await saved(request); if (known) return known;
            const key = payload(request);
            const outcome = await receipts.run<CalendarSubscriptionAddResult>(request.requestId, key, async () => {
                const loaded = await read(); if (!loaded.ok) return loaded.error.code === 'SAVE_FAILED'
                    ? fail('ACTION_FAILED', 'Calendar subscriptions could not read saved data') : loaded;
                if (!taskEditValuesEqual(loaded.value.source.witness, request.expected)) return fail('STALE_REVISION', 'Calendar subscriptions changed; refresh Settings');
                const applied = await useTaskStore.getState().commitPreparedCalendarSubscriptionAdd(prepared, loaded.value.authority, loaded.value.legacyRaw);
                if (!applied.success) return fail('STALE_REVISION', 'Calendar subscriptions changed; refresh Settings');
                authorizations.set(request.requestId, { payload: key, prepared, ...loaded.value });
                return { ok: true, value: resultFor() };
            });
            if (outcome.ok) {
                // A hot receipt cache cannot replace proof after an external import removes the SQL receipt.
                const proven = await saved(request);
                if (!proven) return fail('STALE_REVISION', 'Calendar subscription outcome is no longer recorded');
                if (!proven.ok) return proven;
                authorizations.delete(request.requestId);
                return proven;
            }
            return outcome;
        },
    };
}
