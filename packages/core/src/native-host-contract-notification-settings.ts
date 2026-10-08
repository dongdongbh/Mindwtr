import type { NativeHostResult } from './native-host-contract';
import { readAreaDurableData } from './native-host-contract-area-durable';
import { detach, exact, record } from './native-host-contract-project-shared';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { taskEditValuesEqual } from './json-value-equality';
import { createNativeRequestReceipts, NativeReceiptSqliteAdapter } from './native-request-receipts';
import { isNotificationSettingEdit, NOTIFICATION_SETTING_FIELDS, notificationSettingWitness, readNotificationSettingWitness,
    type NotificationSettingEdit, type NotificationSettingsModel, type NotificationSettingWitness, type NotificationSettingField } from './notification-settings-model';
import { getPersistenceStatus, getStorageAdapter, useTaskStore } from './store';
import type { PreparedAreaAuthority } from './store-types';
import type { AppSettings } from './types';

export type NotificationSettingRequest = { requestId: string; edit: NotificationSettingEdit; expected: NotificationSettingWitness };
export type NotificationSettingResult = { type: NotificationSettingField; value: boolean | string | number; changed: boolean };
export type PreparedNotificationSetting = { version: 1; request: NotificationSettingRequest };
export type NotificationSettingsOptions = { model: NotificationSettingsModel;
    expected: Record<NotificationSettingField, NotificationSettingWitness> };
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED' | 'ACTION_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const requestOf = (input: unknown): NotificationSettingRequest | null => {
    if (!isNativeJsonWithinBytes(input, 8192) || !record(input) || !exact(input, ['requestId', 'edit', 'expected'])
        || typeof input.requestId !== 'string' || !UUID.test(input.requestId) || !isNotificationSettingEdit(input.edit)) return null;
    const expected = readNotificationSettingWitness(input.expected);
    return expected ? { requestId: input.requestId, edit: { ...input.edit }, expected } : null;
};
const preparedOf = (input: unknown): PreparedNotificationSetting | null => {
    if (!isNativeJsonWithinBytes(input, 8192) || !record(input) || !exact(input, ['request', 'prepared'])
        || !record(input.prepared) || !exact(input.prepared, ['version', 'request']) || input.prepared.version !== 1) return null;
    const request = requestOf(input.request), original = requestOf(input.prepared.request);
    return request && original && taskEditValuesEqual(request, original) ? { version: 1, request } : null;
};
const payload = (request: NotificationSettingRequest) => JSON.stringify(['notificationSetting', request.edit.type,
    request.edit.value, request.expected.present, request.expected.value]);
const resultFor = (request: NotificationSettingRequest, changed: boolean): NotificationSettingResult =>
    ({ type: request.edit.type, value: request.edit.value, changed });
const validResult = (value: unknown, request: NotificationSettingRequest): value is NotificationSettingResult => record(value)
    && exact(value, ['type', 'value', 'changed']) && value.changed === true
    && value.type === request.edit.type && value.value === request.edit.value;

/** Device-local prepared scalar writes; permission and effects remain the native caller's responsibility. */
export function createNotificationSettingsMethods(deps: { readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>; model: (settings: AppSettings) => NotificationSettingsModel }) {
    const authorizations = new Map<string, { payload: string; adapter: ReturnType<typeof getStorageAdapter>;
        authority: PreparedAreaAuthority }>();
    const receipts = createNativeRequestReceipts({
        save: async (id) => {
            const authorized = authorizations.get(id);
            if (useTaskStore.getState().persistenceFailure) {
                if (!authorized || getStorageAdapter() !== authorized.adapter
                    || authorized.authority.saveBoundary?.failure !== useTaskStore.getState().persistenceFailure)
                    return fail('SAVE_FAILED', 'Notification save ownership changed');
                const retry = await useTaskStore.getState().retryPreparedNotificationSettingSnapshot(authorized.authority);
                if (!retry.success) return fail('SAVE_FAILED', 'Notification save ownership changed');
            }
            const boundary = authorized?.authority.saveBoundary, raw = authorized?.authority.rawSavedSnapshot;
            const before = useTaskStore.getState();
            const owns = authorized && boundary && raw && getStorageAdapter() === authorized.adapter
                && before._allTasks === boundary.taskReference && before.settings === raw.settings
                && before.lastDataChangeAt === boundary.lastDataChangeAt
                && getPersistenceStatus().generation === boundary.generation && before.persistenceFailure === boundary.failure;
            const saved = await deps.save();
            const after = useTaskStore.getState();
            if (owns && !saved.ok && saved.error.code === 'SAVE_FAILED' && after.persistenceFailure
                && after.persistenceFailure !== before.persistenceFailure && getStorageAdapter() === authorized.adapter
                && after._allTasks === boundary.taskReference && after.settings === raw.settings
                && after.lastDataChangeAt === boundary.lastDataChangeAt && getPersistenceStatus().generation === boundary.generation)
                authorized.authority.saveBoundary = { ...boundary, failure: after.persistenceFailure };
            return saved;
        },
        receiptOnly: async (id, frozen) => {
            const authorized = authorizations.get(id), boundary = authorized?.authority.saveBoundary;
            const raw = authorized?.authority.rawSavedSnapshot, state = useTaskStore.getState(), status = getPersistenceStatus();
            if (!authorized || authorized.payload !== frozen || !boundary || !raw
                || getStorageAdapter() !== authorized.adapter || !(authorized.adapter instanceof NativeReceiptSqliteAdapter)
                || state._allTasks !== boundary.taskReference || state.settings !== raw.settings
                || state.lastDataChangeAt !== boundary.lastDataChangeAt || status.generation !== boundary.generation
                || status.failed || status.queued || status.inFlight || status.immediate || status.retrying) return false;
            return authorized.adapter.commitReceiptOnly(id, frozen);
        },
    });
    const saved = (request: NotificationSettingRequest): NativeHostResult<NotificationSettingResult> | null => {
        const result = receipts.saved<NotificationSettingResult>(request.requestId, payload(request));
        if (!result || !result.ok) return result;
        return validResult(result.value, request) ? result : fail('INVALID_INPUT', 'Saved notification receipt is malformed');
    };
    return {
        async getNotificationSettingsOptions(input: unknown): Promise<NativeHostResult<NotificationSettingsOptions>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            if (!record(input) || !exact(input, [])) return fail('INVALID_INPUT', 'Notification options take an empty object');
            const read = await readAreaDurableData(false, true); if (!read.ok) return read;
            const settings = read.value.authority.snapshot.settings;
            const expected = {} as NotificationSettingsOptions['expected'];
            for (const field of NOTIFICATION_SETTING_FIELDS) {
                const witness = notificationSettingWitness(settings, field);
                if (!witness) return fail('INVALID_INPUT', 'Saved notification value exceeds the witness bound');
                expected[field] = witness;
            }
            const result = { model: deps.model(settings), expected };
            return isNativeJsonWithinBytes(result, 65_536) ? { ok: true, value: result }
                : fail('INVALID_INPUT', 'Notification options exceed the bound');
        },
        probeNotificationSettingOutcome(input: unknown): NativeHostResult<NotificationSettingResult> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const request = requestOf(input);
            return request ? saved(request) ?? fail('STALE_REVISION', 'Notification outcome is unknown; refresh Notifications')
                : fail('INVALID_INPUT', 'A bounded notification request is required');
        },
        async prepareNotificationSetting(input: unknown): Promise<NativeHostResult<{ kind: 'noop'; result: NotificationSettingResult }
            | { kind: 'prepared'; prepared: PreparedNotificationSetting }>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const request = requestOf(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded notification request is required');
            const key = payload(request), identity = receipts.checkIdentity(request.requestId, key);
            if (!identity.ok) return identity;
            const known = authorizations.get(request.requestId);
            if (known && known.payload !== key) return fail('INVALID_INPUT', 'Request ID already belongs to another action');
            const read = await readAreaDurableData(false, true); if (!read.ok) return read;
            const current = notificationSettingWitness(read.value.authority.snapshot.settings, request.edit.type);
            if (!current || !taskEditValuesEqual(current, request.expected))
                return fail('STALE_REVISION', 'Notification setting changed; refresh Notifications');
            if (current.present && current.value === request.edit.value)
                return { ok: true, value: { kind: 'noop', result: resultFor(request, false) } };
            const prepared = detach<PreparedNotificationSetting>({ version: 1, request });
            if (!prepared || !preparedOf({ request, prepared })) return fail('INVALID_INPUT', 'Notification journal exceeds the bound');
            authorizations.set(request.requestId, { payload: key, adapter: read.value.adapter, authority: read.value.authority });
            return { ok: true, value: { kind: 'prepared', prepared } };
        },
        validatePreparedNotificationSetting(input: unknown): NativeHostResult<NotificationSettingResult> {
            const prepared = preparedOf(input);
            return prepared ? { ok: true, value: resultFor(prepared.request, true) }
                : fail('INVALID_INPUT', 'Prepared notification request is malformed');
        },
        async commitPreparedNotificationSetting(input: unknown): Promise<NativeHostResult<NotificationSettingResult>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const prepared = preparedOf(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared notification request is malformed');
            const request = prepared.request, known = saved(request);
            if (known) { if (known.ok) authorizations.delete(request.requestId); return known; }
            const key = payload(request);
            const result = await receipts.run<NotificationSettingResult>(request.requestId, key, async () => {
                const authorized = authorizations.get(request.requestId);
                if (!authorized || authorized.payload !== key || getStorageAdapter() !== authorized.adapter)
                    return fail('STALE_REVISION', 'Notification outcome is unknown; refresh Notifications');
                if (useTaskStore.getState().persistenceFailure)
                    return fail('ACTION_FAILED', 'Notifications have an unresolved persistence failure');
                const read = await readAreaDurableData(false, true);
                if (useTaskStore.getState().persistenceFailure)
                    return fail('ACTION_FAILED', 'Notifications have an unresolved persistence failure');
                if (!read.ok) return read.error.code === 'SAVE_FAILED'
                    ? fail('ACTION_FAILED', 'Notifications could not read saved data') : read;
                if (read.value.adapter !== authorized.adapter) return fail('STALE_REVISION', 'Notification storage changed');
                const applied = await useTaskStore.getState().commitPreparedNotificationSetting(request, read.value.authority);
                if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Notification setting changed; refresh Notifications');
                authorized.authority = read.value.authority;
                return { ok: true, value: resultFor(request, true) };
            });
            if (result.ok || result.error.code === 'STALE_REVISION') authorizations.delete(request.requestId);
            return result;
        },
    };
}
