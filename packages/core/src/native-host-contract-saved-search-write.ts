import { logInfo } from './logger';
import { resolveSavedSearch } from './global-search-model';
import type { NativeHostResult } from './native-host-contract';
import { detach, exact, iso, record } from './native-host-contract-project-shared';
import { findSavedSearch, getSavedSearchGlobalSortLabel, getSavedSearchOwnSortBy, removeSavedSearch } from './saved-search-view-model';
import { getTaskSortByLabel, getVisibleTaskSortOptions, TASK_LIST_SORT_OPTIONS } from './task-list-sort-options';
import { useTaskStore } from './store';
import { focusSavedFilterToken, savedSearchWriteScope, timestampAtLeastAfter } from './store-settings';
import type { PreparedSavedSearchWrite, SavedSearchWriteOperation, SavedSearchWriteRequest,
    SavedSearchWriteResult, SavedSearchWriteScope } from './store-types';
import type { SavedSearch, TaskSortBy } from './types';

export type NativeSavedSearchWriteRequest = SavedSearchWriteRequest;
export type NativePreparedSavedSearchWrite = PreparedSavedSearchWrite;
export type NativeSavedSearchWritePreparation = { kind: 'noop'; result: SavedSearchWriteResult }
    | { kind: 'prepared'; prepared: PreparedSavedSearchWrite };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const same = (left: unknown, right: unknown) => focusSavedFilterToken(left) === focusSavedFilterToken(right);
const token = (scope: SavedSearchWriteScope): string | null => {
    const value = focusSavedFilterToken(scope);
    return detach<string>(value) === null ? null : value;
};

const readOperation = (value: unknown): SavedSearchWriteOperation | null => {
    if (!record(value)) return null;
    if (value.type === 'save' && exact(value, ['type', 'query'])
        && typeof value.query === 'string' && !!value.query.trim() && value.query.length <= 2_000)
        return { type: 'save', query: value.query };
    if (value.type === 'delete' && exact(value, ['type', 'id'])
        && typeof value.id === 'string' && !!value.id && value.id.length <= 200)
        return { type: 'delete', id: value.id };
    if (value.type === 'sort' && exact(value, ['type', 'id', 'sort'])
        && typeof value.id === 'string' && !!value.id && value.id.length <= 200
        && (value.sort === null || TASK_LIST_SORT_OPTIONS.includes(value.sort as TaskSortBy)))
        return { type: 'sort', id: value.id, sort: value.sort as TaskSortBy | null };
    return null;
};

const readRequest = (value: unknown): SavedSearchWriteRequest | null => {
    const raw = detach<Record<string, unknown>>(value);
    if (!raw || !exact(raw, ['requestId', 'operation', 'name', 'expected'])
        || typeof raw.requestId !== 'string' || !UUID.test(raw.requestId)
        || typeof raw.expected !== 'string' || !raw.expected || raw.expected.length > 2_000_000) return null;
    const operation = readOperation(raw.operation);
    if (!operation || (operation.type === 'save'
        ? typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 2_000
        : raw.name !== null)) return null;
    return raw as SavedSearchWriteRequest;
};

const validSearch = (value: unknown): value is SavedSearch => record(value)
    && typeof value.id === 'string' && !!value.id && value.id.length <= 2_000
    && typeof value.name === 'string' && !!value.name.trim() && value.name.length <= 2_000
    && typeof value.query === 'string' && !!value.query.trim() && value.query.length <= 2_000
    && (value.sort === undefined || typeof value.sort === 'string')
    && (value.groupBy === undefined || typeof value.groupBy === 'string');

const readScope = (value: unknown): SavedSearchWriteScope | null => {
    if (!record(value) || !exact(value, ['savedSearchesPresent', 'savedSearches', 'stampPresent', 'stamp'])
        || typeof value.savedSearchesPresent !== 'boolean' || typeof value.stampPresent !== 'boolean'
        || (value.savedSearchesPresent
            ? !Array.isArray(value.savedSearches) || !value.savedSearches.every(validSearch)
                || new Set(value.savedSearches.map((row: SavedSearch) => row.id)).size !== value.savedSearches.length
            : value.savedSearches !== null)
        || (value.stampPresent ? !iso(value.stamp) : value.stamp !== null)) return null;
    return value as SavedSearchWriteScope;
};

const currentScope = (): SavedSearchWriteScope | null => {
    const raw = detach<SavedSearchWriteScope>(savedSearchWriteScope(useTaskStore.getState().settings));
    return raw && readScope(raw);
};

const plan = (request: SavedSearchWriteRequest, before: SavedSearchWriteScope, preparedAt: string):
    NativeSavedSearchWritePreparation | null => {
    const searches = before.savedSearches ?? [];
    let afterSearches: SavedSearch[];
    let result: SavedSearchWriteResult;
    if (request.operation.type === 'save') {
        const id = request.requestId;
        const query = request.operation.query.trim();
        const name = request.name!.trim();
        const collision = searches.find((search) => search.id === id);
        if (collision && (collision.query !== query || collision.name !== name)) return null;
        const resolved = resolveSavedSearch(searches, query, name, id);
        if (resolved.search.id.length > 200) return null;
        result = { id: resolved.search.id, existing: resolved.existing, changed: !resolved.existing };
        if (resolved.existing) return { kind: 'noop', result };
        afterSearches = [...searches, resolved.search];
    } else if (request.operation.type === 'sort') {
        const { id, sort } = request.operation;
        const target = findSavedSearch(searches, id);
        if (!target) return null;
        result = { id, existing: true, changed: (target.sort ?? null) !== sort };
        if (!result.changed) return { kind: 'noop', result };
        const { sort: _previous, ...rest } = target;
        const next = sort === null ? rest : { ...rest, sort };
        afterSearches = searches.map((search) => search === target ? next : search);
    } else {
        const id = request.operation.id;
        if (!searches.some((search) => search.id === id)) {
            return { kind: 'noop', result: { id, existing: false, changed: false } };
        }
        afterSearches = removeSavedSearch(searches, id);
        result = { id, existing: false, changed: true };
    }
    const after: SavedSearchWriteScope = { savedSearchesPresent: true, savedSearches: afterSearches,
        stampPresent: true, stamp: timestampAtLeastAfter(preparedAt, before.stamp ?? undefined) };
    return { kind: 'prepared', prepared: { version: 1, request, before, after, preparedAt, result } };
};


const readPrepared = (value: unknown): PreparedSavedSearchWrite | null => {
    const envelope = detach<Record<string, unknown>>(value);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readRequest(envelope.request);
    const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'request', 'before', 'after', 'preparedAt', 'result'])
        || raw.version !== 1 || !same(raw.request, request) || !iso(raw.preparedAt)
        || !record(raw.result) || !exact(raw.result, ['id', 'existing', 'changed'])
        || typeof raw.result.id !== 'string' || !raw.result.id || raw.result.id.length > 200
        || typeof raw.result.existing !== 'boolean'
        || typeof raw.result.changed !== 'boolean') return null;
    const before = readScope(raw.before);
    const after = readScope(raw.after);
    if (!before || !after || token(before) !== request.expected) return null;
    const planned = plan(request, before, raw.preparedAt);
    return planned?.kind === 'prepared' && same(planned.prepared.after, after)
        && same(planned.prepared.result, raw.result)
        ? raw as PreparedSavedSearchWrite : null;
};

export function createSavedSearchWriteMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    t?: (key: string) => string;
}) {
    return {
        getSavedSearchSortOptions(input: { id: string }): NativeHostResult<{ id: string; expected: string;
            choices: { value: TaskSortBy | null; label: string; selected: boolean }[] }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!record(input) || !exact(input, ['id']) || typeof input.id !== 'string' || !input.id || input.id.length > 200)
                return fail('INVALID_INPUT', 'A saved search ID is required');
            const scope = currentScope();
            const expected = scope && token(scope);
            const settings = useTaskStore.getState().settings;
            const target = findSavedSearch(settings.savedSearches, input.id);
            if (!target || !expected) return fail('STALE_REVISION', 'The saved search is no longer available');
            const own = getSavedSearchOwnSortBy(target, settings);
            const t = deps.t ?? ((key: string) => key);
            return { ok: true, value: { id: input.id, expected, choices: [
                { value: null, label: getSavedSearchGlobalSortLabel(settings, t), selected: own === null },
                ...getVisibleTaskSortOptions(TASK_LIST_SORT_OPTIONS, settings)
                    .map((value) => ({ value, label: getTaskSortByLabel(value, t), selected: value === own })),
            ] } };
        },

        getSavedSearchWriteOptions(input: { operation: SavedSearchWriteOperation }): NativeHostResult<{ expected: string }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const raw = detach<Record<string, unknown>>(input);
            if (!raw || !exact(raw, ['operation']) || !readOperation(raw.operation))
                return fail('INVALID_INPUT', 'Saved search operation is invalid');
            const scope = currentScope();
            const expected = scope && token(scope);
            return expected ? { ok: true, value: { expected } }
                : fail('INVALID_INPUT', 'Saved search collection is invalid or exceeds the native bound');
        },

        probeSavedSearchWriteOutcome(input: SavedSearchWriteRequest): NativeHostResult<SavedSearchWriteResult> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            return readRequest(input) ? fail('STALE_REVISION', 'Saved search outcome is unknown')
                : fail('INVALID_INPUT', 'Saved search request is invalid');
        },

        prepareSavedSearchWrite(input: SavedSearchWriteRequest): NativeHostResult<NativeSavedSearchWritePreparation> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'Saved search request is invalid');
            if (request.operation.type === 'sort' && request.operation.sort !== null
                && !getVisibleTaskSortOptions(TASK_LIST_SORT_OPTIONS, useTaskStore.getState().settings).includes(request.operation.sort))
                return fail('INVALID_INPUT', 'That saved search sort is not offered');
            const before = currentScope();
            if (!before || request.expected !== token(before))
                return fail('STALE_REVISION', 'Saved searches changed; refresh before writing');
            const planned = plan(request, before, new Date().toISOString());
            if (!planned) return fail('STALE_REVISION', 'Saved search ID already exists');
            if (planned.kind === 'noop') return { ok: true, value: planned };
            const prepared = detach<PreparedSavedSearchWrite>(planned.prepared);
            return prepared && readPrepared({ request, prepared })
                ? { ok: true, value: { kind: 'prepared', prepared } }
                : fail('INVALID_INPUT', 'Saved search journal is invalid or exceeds the native bound');
        },

        validatePreparedSavedSearchWrite(input: { request: SavedSearchWriteRequest;
            prepared: PreparedSavedSearchWrite }): NativeHostResult<SavedSearchWriteResult> {
            const prepared = readPrepared(input);
            return prepared ? { ok: true, value: prepared.result }
                : fail('INVALID_INPUT', 'Prepared saved search journal is invalid');
        },

        async commitPreparedSavedSearchWrite(input: { request: SavedSearchWriteRequest;
            prepared: PreparedSavedSearchWrite }): Promise<NativeHostResult<SavedSearchWriteResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const prepared = readPrepared(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared saved search journal is invalid');
            const applied = await useTaskStore.getState().commitPreparedSavedSearchWrite(prepared);
            if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Saved searches changed');
            try {
                if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
            } catch { return fail('SAVE_FAILED', 'Saved search could not be saved'); }
            const saved = await deps.save();
            if (saved.ok && prepared.request.operation.type === 'sort') {
                try { logInfo('Native saved search sort saved', { scope: 'native-host', category: 'storage',
                    context: { releaseCheck: 'v1.3.9/native-saved-search-sort', outcome: 'saved' } }); }
                catch { /* Diagnostics cannot invalidate a durable acknowledgment. */ }
            }
            return saved.ok ? { ok: true, value: prepared.result } : saved;
        },
    };
}
