import type { NativeHostResult } from './native-host-contract';
import { detach, exact, iso, record } from './native-host-contract-project-shared';
import { getManageEditorDraft, isManageEditorSaveDisabled, type ManageEditorDraft } from './manage-settings-model';
import { ensureDeviceId } from './store-helpers';
import { flushPendingSave, getPersistenceStatus, getStorageAdapter, useTaskStore } from './store';
import { personPersistedSnapshot, samePersonAdditionRow } from './store-projects/people-actions';
import { planPersonEditorSave, selectPersonRenameDestination, selectPersonRenameTasks, type PersonEditResult } from './person-edit';
import { taskEditValuesEqual } from './json-value-equality';
import { TASK_SYNC_FIELD_SCHEMA, taskToSqliteRow } from './task-sync-schema';
import type { PreparedPersonEdit, TaskStore } from './store-types';
import type { Person, Task } from './types';

export type NativePersonEditRequest = PreparedPersonEdit['request'];
export type NativePersonEditResult = PersonEditResult;
export type NativePersonEditOptions = { personId: string; expected: Person; draft: ManageEditorDraft };
export type NativePreparedPersonEdit = PreparedPersonEdit & { version: 1 };
export type NativePersonEditPreparation = { kind: 'noop'; result: NativePersonEditResult }
    | { kind: 'prepared'; prepared: NativePreparedPersonEdit };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const text = (value: unknown, limit = 2_000_000): value is string => typeof value === 'string' && value.length <= limit;
const id = (value: unknown): value is string => text(value, 500) && Boolean(value);
const stamp = (value: unknown): value is string => text(value, 500) && Boolean(value.trim());
const revision = (value: unknown) => value === undefined || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const same = taskEditValuesEqual;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const livePerson = (value: unknown): value is Person => record(value)
    && Object.keys(value).every((key) => ['id', 'name', 'note', 'referenceLink', 'rev', 'revBy', 'createdAt', 'updatedAt'].includes(key))
    && id(value.id) && text(value.name) && stamp(value.createdAt) && stamp(value.updatedAt)
    && (value.note === undefined || text(value.note)) && (value.referenceLink === undefined || text(value.referenceLink))
    && revision(value.rev) && (value.revBy === undefined || id(value.revBy));
const readRequest = (value: unknown): NativePersonEditRequest | null => {
    const input = detach<Record<string, unknown>>(value);
    return input && exact(input, ['requestId', 'personId', 'expected', 'name', 'note', 'referenceLink'])
        && typeof input.requestId === 'string' && UUID.test(input.requestId) && id(input.personId)
        && livePerson(input.expected) && input.expected.id === input.personId
        && same(input.expected, personPersistedSnapshot(input.expected))
        && text(input.name) && text(input.note) && text(input.referenceLink)
        ? input as NativePersonEditRequest : null;
};

const taskKeys = new Set(TASK_SYNC_FIELD_SCHEMA.map((field) => field.name));

const validTask = (value: unknown): value is Task => {
    if (!record(value) || Object.keys(value).some((key) => !taskKeys.has(key as keyof Task))
        || !id(value.id) || !text(value.title) || !stamp(value.createdAt) || !stamp(value.updatedAt)
        || !['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived'].includes(String(value.status))
        || !Array.isArray(value.tags) || !value.tags.every((part) => text(part))
        || !Array.isArray(value.contexts) || !value.contexts.every((part) => text(part))
        || !revision(value.rev) || value.deletedAt
        || (value.revBy !== undefined && !id(value.revBy))) return false;
    for (const [key, part] of Object.entries(value)) {
        if (part === null) continue;
        if (key === 'relativeStartOffset' || key === 'viewSectionIds') {
            if (!record(part)) return false;
            if (key === 'viewSectionIds' && !Object.values(part).every((entry) => text(entry))) return false;
        } else if (key === 'recurrence') {
            if (!record(part) && typeof part !== 'string') return false;
        } else if (key === 'checklist') {
            if (!Array.isArray(part) || part.some((entry) => !record(entry) || !id(entry.id)
                || !text(entry.title) || typeof entry.isCompleted !== 'boolean')) return false;
        } else if (key === 'attachments') {
            if (!Array.isArray(part) || part.some((entry) => !record(entry) || !id(entry.id)
                || !['file', 'link'].includes(String(entry.kind)) || !text(entry.title) || !text(entry.uri)
                || !stamp(entry.createdAt) || !stamp(entry.updatedAt))) return false;
        } else {
            const kind = TASK_SYNC_FIELD_SCHEMA.find((field) => field.name === key)?.cloudKit?.kind;
            if (kind === 'boolean' && typeof part !== 'boolean'
                || kind === 'integer' && (typeof part !== 'number' || !Number.isFinite(part))
                || (kind === 'string' || kind === 'date') && !text(part)
                || kind === 'string-array' && (!Array.isArray(part) || !part.every((entry) => text(entry)))
                || ['order', 'orderNum', 'boardOrder', 'focusOrder'].includes(key)
                    && (typeof part !== 'number' || !Number.isFinite(part))) return false;
        }
    }
    try { taskToSqliteRow(value as unknown as Task); return true; } catch { return false; }
};


const readPrepared = (value: unknown): NativePreparedPersonEdit | null => {
    const envelope = detach<Record<string, unknown>>(value);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readRequest(envelope.request);
    const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'request', 'scope', 'effect', 'deviceIdBefore',
        'deviceIdToInitialize', 'updateAt', 'renameAt', 'result']) || raw.version !== 1 || !same(raw.request, request)
        || !record(raw.scope) || !exact(raw.scope, ['person', 'destination', 'tasks'])
        || !same(raw.scope.person, request.expected)
        || !(raw.scope.destination === null || livePerson(raw.scope.destination))
        || !Array.isArray(raw.scope.tasks) || !raw.scope.tasks.every(validTask)
        || new Set(raw.scope.tasks.map((row) => row.id)).size !== raw.scope.tasks.length
        || !record(raw.effect) || !exact(raw.effect, ['people', 'tasks'])
        || !Array.isArray(raw.effect.people) || !Array.isArray(raw.effect.tasks)
        || !(raw.deviceIdBefore === null || id(raw.deviceIdBefore))
        || (raw.deviceIdBefore === null ? typeof raw.deviceIdToInitialize !== 'string' || !UUID.test(raw.deviceIdToInitialize)
            : raw.deviceIdToInitialize !== null)
        || !iso(raw.updateAt) || !(raw.renameAt === null || iso(raw.renameAt))
        || !record(raw.result) || !exact(raw.result, ['id', 'personId', 'name'])) return null;
    try {
        const prepared = raw as unknown as NativePreparedPersonEdit;
        const { scope } = prepared;
        if (scope.destination && (scope.destination.id === request.personId
            || !same(scope.destination, personPersistedSnapshot(scope.destination)))) return null;
        const rows = { people: [scope.person, ...(scope.destination ? [scope.destination] : [])], tasks: scope.tasks };
        const plan = planPersonEditorSave(rows, request.personId, request,
            prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!, prepared.updateAt, prepared.renameAt);
        if (!plan || !plan.effect.people.length || !same(JSON.parse(JSON.stringify(plan.effect)), prepared.effect)
            || !same(plan.result, prepared.result)
            || (plan.renamed ? prepared.renameAt === null || !plan.metadata && prepared.renameAt !== prepared.updateAt
                : prepared.renameAt !== null || scope.destination !== null || scope.tasks.length !== 0)) return null;
        if (plan.renamed && (selectPersonRenameDestination(rows.people, request.personId, request.name)?.id ?? null)
            !== (scope.destination?.id ?? null)) return null;
        if (plan.renamed && selectPersonRenameTasks(scope.tasks, scope.person.name).length !== scope.tasks.length) return null;
        return prepared;
    } catch { return null; }
};

export function createPersonEditMethods(deps: {
    readiness: () => NativeHostResult<null>; save: () => Promise<NativeHostResult<null>>;
}) {


    let failedSave: { prepared: NativePreparedPersonEdit; adapter: ReturnType<typeof getStorageAdapter>;
        failure: NonNullable<ReturnType<typeof useTaskStore.getState>['persistenceFailure']>;
        generation: number; lastDataChangeAt: number; taskReference: Task[] } | null = null;
    const ownsFailure = (prepared: NativePreparedPersonEdit, adapter: ReturnType<typeof getStorageAdapter>,
        state: ReturnType<typeof useTaskStore.getState>): boolean => {
        const status = getPersistenceStatus();
        return Boolean(failedSave && same(failedSave.prepared, prepared) && failedSave.adapter === adapter
            && failedSave.failure === state.persistenceFailure && failedSave.generation === status.generation
            && failedSave.lastDataChangeAt === state.lastDataChangeAt && failedSave.taskReference === state._allTasks
            && !status.queued && !status.inFlight && !status.immediate && !status.retrying);
    };
    return {
        getPersonEditOptions(input: { personId: string }): NativeHostResult<NativePersonEditOptions> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const value = detach<Record<string, unknown>>(input);
            if (!value || !exact(value, ['personId']) || !id(value.personId)) return fail('INVALID_INPUT', 'A bounded Person ID is required');
            const source = useTaskStore.getState()._allPeople.find((row) => row.id === value.personId);
            if (!source || source.deletedAt) return fail('STALE_REVISION', 'Person changed; refresh before editing');
            const expected = personPersistedSnapshot(source);
            if (!livePerson(expected)) return fail('INVALID_INPUT', 'Person metadata is not a valid bounded snapshot');
            const options = detach<NativePersonEditOptions>({ personId: source.id, expected,
                draft: getManageEditorDraft({ type: 'person', ...expected }) });
            return options ? { ok: true, value: options } : fail('INVALID_INPUT', 'Person edit options exceed the bounded response');
        },
        checkPersonEdit(input: { name: string }): NativeHostResult<{ saveDisabled: boolean }> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const value = detach<Record<string, unknown>>(input);
            return value && exact(value, ['name']) && text(value.name)
                ? { ok: true, value: { saveDisabled: isManageEditorSaveDisabled('person', value.name, []) } }
                : fail('INVALID_INPUT', 'A bounded Person name is required');
        },
        probePersonEditOutcome(input: NativePersonEditRequest): NativeHostResult<NativePersonEditResult> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            return readRequest(input) ? fail('STALE_REVISION', 'Person edit outcome is unknown; refresh before saving again')
                : fail('INVALID_INPUT', 'A bounded Person edit request is required');
        },
        async preparePersonEdit(input: NativePersonEditRequest): Promise<NativeHostResult<NativePersonEditPreparation>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded Person edit request is required');
            const state = useTaskStore.getState();
            const source = state._allPeople.find((row) => row.id === request.personId);
            if (!source || source.deletedAt || !samePersonAdditionRow(source, request.expected))
                return fail('STALE_REVISION', 'Person changed; refresh before editing');
            const updateAt = new Date().toISOString();
            const preview = planPersonEditorSave({ people: [request.expected], tasks: [] }, source.id, request, '', updateAt, null);
            if (!preview) return fail('INVALID_INPUT', 'Person name is required');
            const renameAt = preview.renamed ? preview.metadata ? new Date().toISOString() : updateAt : null;
            const adapter = getStorageAdapter();
            let snapshot;
            try { await flushPendingSave(); snapshot = await adapter.getData(); }
            catch { return fail('SAVE_FAILED', 'Person edit could not read saved data'); }
            const current = useTaskStore.getState();
            if (getStorageAdapter() !== adapter || current._allTasks !== state._allTasks
                || current._allPeople !== state._allPeople || current.settings !== state.settings
                || current.lastDataChangeAt !== state.lastDataChangeAt)
                return fail('STALE_REVISION', 'Person data changed while reading saved data');
            const persistedSource = snapshot.people?.find((row) => row.id === request.personId);
            if (!persistedSource || persistedSource.deletedAt || !samePersonAdditionRow(persistedSource, request.expected)
                || (snapshot.settings.deviceId ?? null) !== (state.settings.deviceId ?? null))
                return fail('STALE_REVISION', 'Person changed; refresh before editing');
            if (!preview.effect.people.length) return { ok: true, value: { kind: 'noop', result: preview.result } };
            const scope = { person: request.expected,
                destination: preview.renamed ? selectPersonRenameDestination(snapshot.people ?? [], source.id, request.name) : null,
                tasks: preview.renamed ? selectPersonRenameTasks(snapshot.tasks, source.name) : [] };
            if (scope.destination) scope.destination = personPersistedSnapshot(scope.destination);
            const canonical = detach<typeof scope>(JSON.parse(JSON.stringify(scope)));
            if (!canonical) return fail('INVALID_INPUT', 'Person edit scope exceeds the bounded journal');
            const device = ensureDeviceId(snapshot.settings);
            const plan = planPersonEditorSave({ people: [canonical.person, ...(canonical.destination ? [canonical.destination] : [])],
                tasks: canonical.tasks }, source.id, request, device.deviceId, updateAt, renameAt);
            if (!plan) return fail('INVALID_INPUT', 'Person edit could not be prepared');
            const prepared: NativePreparedPersonEdit = { version: 1, request, scope: canonical, effect: plan.effect,
                deviceIdBefore: snapshot.settings.deviceId ?? null, deviceIdToInitialize: device.updated ? device.deviceId : null,
                updateAt, renameAt, result: plan.result };
            const frozen = detach<NativePreparedPersonEdit>(JSON.parse(JSON.stringify(prepared)));
            return frozen && readPrepared({ request, prepared: frozen }) ? { ok: true, value: { kind: 'prepared', prepared: frozen } }
                : fail('INVALID_INPUT', 'Person edit exceeds the bounded journal');
        },
        validatePreparedPersonEdit(input: { request: NativePersonEditRequest; prepared: NativePreparedPersonEdit }): NativeHostResult<NativePersonEditResult> {
            const prepared = readPrepared(input);
            return prepared ? { ok: true, value: prepared.result } : fail('INVALID_INPUT', 'Prepared Person edit request or journal does not match');
        },
        async commitPreparedPersonEdit(input: { request: NativePersonEditRequest; prepared: NativePreparedPersonEdit }): Promise<NativeHostResult<NativePersonEditResult>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const prepared = readPrepared(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared Person edit request or journal does not match');

            const adapter = getStorageAdapter();
            if (!useTaskStore.getState().persistenceFailure) {
                try { await flushPendingSave(); }
                catch { return fail('SAVE_FAILED', 'Person edit could not read saved data'); }
            }
            const state = useTaskStore.getState();
            let snapshot;
            try { snapshot = await adapter.getData(); }
            catch { return fail('SAVE_FAILED', 'Person edit could not read saved data'); }
            const current = useTaskStore.getState();
            if (getStorageAdapter() !== adapter || current._allTasks !== state._allTasks
                || current._allPeople !== state._allPeople || current.settings !== state.settings
                || current.lastDataChangeAt !== state.lastDataChangeAt)
                return fail('STALE_REVISION', 'Person data changed while reading saved data');
            if (current.persistenceFailure && !ownsFailure(prepared, adapter, current))
                return fail('SAVE_FAILED', 'Person edit has an unresolved persistence failure');
            const authority: Parameters<TaskStore['commitPreparedPersonEdit']>[1] = { snapshot,
                taskReference: state._allTasks, lastDataChangeAt: state.lastDataChangeAt };
            const applied = await current.commitPreparedPersonEdit(prepared, authority);
            if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Prepared Person edit conflicts with current data');
            const savingState = useTaskStore.getState();
            const savingStatus = getPersistenceStatus();
            const boundary = authority.saveBoundary;
            const ownWrite = boundary && getStorageAdapter() === adapter
                && boundary.taskReference === savingState._allTasks && boundary.lastDataChangeAt === savingState.lastDataChangeAt
                && boundary.generation === savingStatus.generation && boundary.failure === savingState.persistenceFailure;
            if (applied.outcome === 'replayed' && savingState.persistenceFailure) {
                if (!ownsFailure(prepared, adapter, savingState))
                    return fail('SAVE_FAILED', 'Person edit has an unresolved persistence failure');
                useTaskStore.setState({ persistenceFailure: null });
                failedSave = null;
            }


            const saved = await deps.save();
            const afterSave = useTaskStore.getState();
            const afterStatus = getPersistenceStatus();
            if (ownWrite && !saved.ok && saved.error.code === 'SAVE_FAILED' && afterSave.persistenceFailure
                && afterSave.persistenceFailure !== savingState.persistenceFailure && getStorageAdapter() === adapter
                && afterStatus.generation === savingStatus.generation
                && afterSave.lastDataChangeAt === savingState.lastDataChangeAt && afterSave._allTasks === savingState._allTasks) {
                failedSave = { prepared, adapter, failure: afterSave.persistenceFailure, generation: afterStatus.generation,
                    lastDataChangeAt: afterSave.lastDataChangeAt, taskReference: afterSave._allTasks };
            } else if (saved.ok) failedSave = null;
            return saved.ok ? { ok: true, value: prepared.result } : saved;
        },
    };
}
