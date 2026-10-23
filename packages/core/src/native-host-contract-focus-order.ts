import { buildFocusControlsModel, getFocusReorderPositionLabel, getFocusReorderSecondaryLabel,
    moveFocusReorderTask } from './focus-controls';
import { readNativeFocusControls, type NativeFocusReorderRow } from './native-host-contract-focus-controls';
import { NATIVE_HOST_MAX_WINDOW, type NativeHostResult } from './native-host-contract';
import { detach, exact, iso, record } from './native-host-contract-project-shared';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { taskRevisionOf } from './native-request-receipts';
import { ensureDeviceId } from './store-helpers';
import { focusOrderEffect, focusOrderToken } from './store-tasks';
import { useTaskStore } from './store';
import { sameSectionDeleteJson, sameTaskSqliteRow } from './store-projects/section-actions';
import { TASK_SYNC_FIELD_SCHEMA, taskToSqliteRow } from './task-sync-schema';
import type { PreparedFocusOrder } from './store-types';
import type { Task } from './types';

export type NativeFocusOrderRequest = PreparedFocusOrder['request'];
export type NativeFocusOrderResult = PreparedFocusOrder['result'];
export type NativePreparedFocusOrder = PreparedFocusOrder & { version: 1 | 2 };
export type NativeFocusOrderPreparation =
    | { kind: 'noop'; result: NativeFocusOrderResult }
    | { kind: 'prepared'; prepared: NativePreparedFocusOrder };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const TASK_KEYS = new Set(TASK_SYNC_FIELD_SCHEMA.map((field) => field.name));
const same = sameSectionDeleteJson;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });

const validTask = (value: unknown): value is Task => {
    if (!record(value) || Object.keys(value).some((key) => !TASK_KEYS.has(key as keyof Task))) return false;
    const row = Object.fromEntries(Object.entries(value).map(([key, part]) =>
        [key, part === null ? undefined : part]));
    if (typeof row.id !== 'string' || !row.id || row.id.length > 500
        || typeof row.title !== 'string' || row.isFocusedToday !== true
        || !['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived'].includes(String(row.status))
        || row.deletedAt !== undefined || row.purgedAt !== undefined
        || !Array.isArray(row.tags) || !row.tags.every((tag) => typeof tag === 'string')
        || !Array.isArray(row.contexts) || !row.contexts.every((context) => typeof context === 'string')
        || !iso(row.createdAt) || !iso(row.updatedAt)
        || (row.focusOrder !== undefined && !(typeof row.focusOrder === 'number' && Number.isFinite(row.focusOrder)))
        || (row.rev !== undefined && !(typeof row.rev === 'number' && Number.isSafeInteger(row.rev) && row.rev >= 0))
        || (row.revBy !== undefined && typeof row.revBy !== 'string')) return false;
    try { taskToSqliteRow(value as unknown as Task); return true; }
    catch { return false; }
};

const readRequest = (value: unknown): NativeFocusOrderRequest | null => {
    const input = detach<Record<string, unknown>>(value);
    if (!input || !exact(input, ['requestId', 'controls', 'ids', 'expectedOrder'])
        || typeof input.requestId !== 'string' || !UUID.test(input.requestId)
        || !Array.isArray(input.ids) || input.ids.length < 1 || input.ids.length > NATIVE_HOST_MAX_WINDOW
        || input.ids.some((id) => typeof id !== 'string' || !id || id.length > 500)
        || new Set(input.ids).size !== input.ids.length
        || typeof input.expectedOrder !== 'string' || !input.expectedOrder) return null;
    const controls = readNativeFocusControls(input.controls);
    return controls && same(controls, input.controls) ? input as NativeFocusOrderRequest : null;
};

/** Pure cold-journal validation before accessing SQLite or store state. */
const readPrepared = (value: unknown): NativePreparedFocusOrder | null => {
    const envelope = detach<Record<string, unknown>>(value);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readRequest(envelope.request);
    const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'request', 'scope', 'effect', 'deviceIdBefore',
        'deviceIdToInitialize', 'preparedAt', 'result']) || (raw.version !== 1 && raw.version !== 2)
        || !same(raw.request, request) || !record(raw.scope) || !exact(raw.scope, ['tasks'])
        || !Array.isArray(raw.scope.tasks) || raw.scope.tasks.length < 1
        || raw.scope.tasks.length > NATIVE_HOST_MAX_WINDOW
        || !record(raw.effect) || !exact(raw.effect, ['tasks']) || !Array.isArray(raw.effect.tasks)
        || raw.effect.tasks.length < 1 || raw.effect.tasks.length > raw.scope.tasks.length
        || !(raw.deviceIdBefore === null || typeof raw.deviceIdBefore === 'string' && Boolean(raw.deviceIdBefore))
        || (raw.deviceIdBefore === null
            ? typeof raw.deviceIdToInitialize !== 'string' || !UUID.test(raw.deviceIdToInitialize)
            : raw.deviceIdToInitialize !== null)
        || !iso(raw.preparedAt) || !record(raw.result) || !exact(raw.result, ['ids'])
        || !same(raw.result.ids, request.ids)) return null;
    try {
        const prepared = raw as unknown as NativePreparedFocusOrder;
        const { scope, effect } = prepared;
        if (scope.tasks.some((task) => !validTask(task))
            || new Set(scope.tasks.map((task) => task.id)).size !== scope.tasks.length
            || focusOrderToken(scope.tasks) !== request.expectedOrder
            || (raw.version === 1 && request.ids.length !== scope.tasks.length)
            || request.ids.some((id) => !scope.tasks.some((task) => task.id === id))) return null;
        const planned = focusOrderEffect(scope, request.ids,
            prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!, prepared.preparedAt, prepared.version === 2);
        if (planned.tasks.length !== effect.tasks.length) return null;
        return effect.tasks.every((row, index) => {
            const expected = planned.tasks[index];
            return record(row) && exact(row, ['before', 'after'])
                && validTask(row.before) && validTask(row.after)
                && sameTaskSqliteRow(row.before, expected.before)
                && sameTaskSqliteRow(row.after, expected.after)
                && same(row.before, expected.before) && same(row.after, expected.after);
        }) ? prepared : null;
    } catch { return null; }
};

export function createFocusOrderMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    revision: () => string;
    t: () => (key: string) => string;
    formatDate: (value: string | Date, format: string, fallback?: string) => string;
}) {
    const current = (controls: NativeFocusOrderRequest['controls']) => {
        const state = useTaskStore.getState();
        const model = buildFocusControlsModel({ state: controls, tasks: state.tasks,
            projects: state.projects, areas: state.areas, sections: state.sections,
            settings: state.settings, now: new Date(), t: deps.t(),
            formatDate: (value) => deps.formatDate(value, 'P', value) });
        return model;
    };
    return {
        getFocusOrderOptions(input: { controls: NativeFocusOrderRequest['controls'] }): NativeHostResult<{
            revision: string; controls: NativeFocusOrderRequest['controls']; expectedOrder: string;
            canReorder: boolean; rows: NativeFocusReorderRow[] }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const bounded = detach<Record<string, unknown>>(input);
            if (!bounded || !exact(bounded, ['controls']))
                return fail('INVALID_INPUT', 'Valid Focus controls are required');
            const controls = readNativeFocusControls(bounded.controls);
            if (!controls) return fail('INVALID_INPUT', 'Valid Focus controls are required');
            const model = current(controls);
            const tasks = model.lists.focusedTasks;
            if (model.globalFocusedTasks.length > NATIVE_HOST_MAX_WINDOW)
                return fail('INVALID_INPUT', 'Focus order exceeds the bounded native list');
            const available = model.canReorder;
            const rows = available ? tasks.map((task, index) => ({
                id: task.id, taskRevision: taskRevisionOf(task), title: task.title,
                secondaryLabel: getFocusReorderSecondaryLabel(task, model.projectById, deps.formatDate),
                positionLabel: getFocusReorderPositionLabel(deps.t(), task.title, index, tasks.length),
                moveUp: moveFocusReorderTask(tasks, task.id, -1)?.map(({ id }) => id) ?? null,
                moveDown: moveFocusReorderTask(tasks, task.id, 1)?.map(({ id }) => id) ?? null,
            })) : [];
            const value = { revision: deps.revision(), controls: model.filter.state,
                expectedOrder: available ? focusOrderToken(model.globalFocusedTasks) : '',
                canReorder: available, rows };
            return isNativeJsonWithinBytes(value) ? { ok: true, value }
                : fail('INVALID_INPUT', 'Focus order exceeds the bounded native response');
        },

        probeFocusOrderOutcome(input: NativeFocusOrderRequest): NativeHostResult<NativeFocusOrderResult> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            return readRequest(input) ? fail('STALE_REVISION', 'Focus order outcome is unknown')
                : fail('INVALID_INPUT', 'A bounded Focus order request is required');
        },

        prepareFocusOrder(input: NativeFocusOrderRequest): NativeHostResult<NativeFocusOrderPreparation> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded Focus order request is required');
            const model = current(request.controls);
            const tasks = model.lists.focusedTasks;
            if (!model.canReorder || model.globalFocusedTasks.length > NATIVE_HOST_MAX_WINDOW
                || focusOrderToken(model.globalFocusedTasks) !== request.expectedOrder)
                return fail('STALE_REVISION', 'Focus order changed; refresh before moving');
            if (request.ids.length !== tasks.length || request.ids.some((id) => !tasks.some((task) => task.id === id)))
                return fail('INVALID_INPUT', 'Every visible Focus task is required once');
            const result = { ids: request.ids };
            const state = useTaskStore.getState();
            const device = ensureDeviceId(state.settings);
            const preparedAt = new Date().toISOString();
            const scope = { tasks: model.globalFocusedTasks };
            const effect = focusOrderEffect(scope, request.ids, device.deviceId, preparedAt, true);
            if (!effect.tasks.length) return { ok: true, value: { kind: 'noop', result } };
            const prepared: NativePreparedFocusOrder = { version: 2, request, scope,
                effect,
                deviceIdBefore: state.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                preparedAt, result };
            const frozen = detach<NativePreparedFocusOrder>(JSON.parse(JSON.stringify(prepared)));
            return frozen && readPrepared({ request, prepared: frozen })
                ? { ok: true, value: { kind: 'prepared', prepared: frozen } }
                : fail('INVALID_INPUT', 'Focus order exceeds the bounded journal');
        },

        validatePreparedFocusOrder(input: { request: NativeFocusOrderRequest;
            prepared: NativePreparedFocusOrder }): NativeHostResult<NativeFocusOrderResult> {
            const prepared = readPrepared(input);
            return prepared ? { ok: true, value: prepared.result }
                : fail('INVALID_INPUT', 'Prepared Focus order request or journal does not match');
        },

        async commitPreparedFocusOrder(input: { request: NativeFocusOrderRequest;
            prepared: NativePreparedFocusOrder }): Promise<NativeHostResult<NativeFocusOrderResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const prepared = readPrepared(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared Focus order request or journal does not match');
            const applied = await useTaskStore.getState().commitPreparedFocusOrder(prepared);
            if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Prepared Focus order conflicts with current data');
            try {
                if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
            } catch (error) { return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error)); }
            const saved = await deps.save();
            return saved.ok ? { ok: true, value: prepared.result } : saved;
        },
    };
}
