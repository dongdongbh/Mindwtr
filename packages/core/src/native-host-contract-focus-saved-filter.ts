import { applyFocusSavedFilter, buildFocusControlsModel, planFocusFilterCriterionRemoval,
    planFocusFilterSave } from './focus-controls';
import { readNativeFocusControls } from './native-host-contract-focus-controls';
import { criteriaFromSelections } from './filter-criteria';
import { type NativeHostResult } from './native-host-contract';
import { detach, exact, iso, record } from './native-host-contract-project-shared';
import { hasActiveFilterCriteria, normalizeSavedFilter, isSavedFilterSortField } from './saved-filters';
import { buildAdvancedFilterCriteriaChips } from './saved-filter-labels';
import { resolveTaskPerspectiveForFeatures } from './task-utils';
import { useTaskStore } from './store';
import { focusSavedFilterCreation, focusSavedFilterToken, prepareLocalSavedFilterUpdates } from './store-settings';
import type { FocusSavedFilterOperation, FocusSavedFilterRequest, FocusSavedFilterResult,
    PreparedFocusSavedFilter } from './store-types';
import type { FocusControlState, FocusControlsModel } from './focus-controls';
import type { SavedFilter } from './types';

export type NativeFocusSavedFilterRequest = FocusSavedFilterRequest;
export type NativeFocusSavedFilterResult = FocusSavedFilterResult;
export type NativePreparedFocusSavedFilter = PreparedFocusSavedFilter;
export type NativeFocusSavedFilterPreparation = { kind: 'noop'; result: FocusSavedFilterResult }
    | { kind: 'prepared'; prepared: PreparedFocusSavedFilter };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const GROUP = new Set(['none', 'context', 'project', 'area', 'energy', 'priority', 'person', 'tag']);
const CRITERIA_ARRAYS = ['contexts', 'excludedContexts', 'areas', 'projects', 'tags',
    'excludedTags', 'energy', 'priority', 'statuses', 'assignedTo', 'locations', 'timeEstimates'];
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const same = (left: unknown, right: unknown) => focusSavedFilterToken(left) === focusSavedFilterToken(right);

const readOperation = (value: unknown): FocusSavedFilterOperation | null => {
    if (!record(value)) return null;
    if (value.type === 'save' && exact(value, ['type'])) return { type: 'save' };
    if (value.type === 'delete' && exact(value, ['type', 'id'])
        && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 200)
        return { type: 'delete', id: value.id };
    if (value.type === 'removeCriterion' && exact(value, ['type', 'criterionId'])
        && typeof value.criterionId === 'string' && value.criterionId.length > 0 && value.criterionId.length <= 200)
        return { type: 'removeCriterion', criterionId: value.criterionId };
    return null;
};

const readRequest = (value: unknown): FocusSavedFilterRequest | null => {
    const raw = detach<Record<string, unknown>>(value);
    if (!raw || !exact(raw, ['requestId', 'controls', 'operation', 'name', 'expected'])
        || typeof raw.requestId !== 'string' || !UUID.test(raw.requestId)
        || typeof raw.expected !== 'string' || raw.expected.length < 2
        || raw.expected.length > 2_000_000) return null;
    const controls = readNativeFocusControls(raw.controls);
    const operation = readOperation(raw.operation);
    if (!controls || !same(controls, raw.controls) || !operation) return null;
    if (operation.type === 'save'
        ? typeof raw.name !== 'string' || !raw.name.trim() || raw.name.trim().length > 500
        : raw.name !== null) return null;
    return raw as FocusSavedFilterRequest;
};

const validRawFilter = (value: unknown): value is SavedFilter => {
    if (!record(value) || typeof value.id !== 'string' || !value.id || value.id.length > 200
        || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 500
        || value.view !== 'focus' || !record(value.criteria)
        || !iso(value.createdAt) || !iso(value.updatedAt)
        || (value.deletedAt != null && !iso(value.deletedAt))
        || (value.sortBy != null && !isSavedFilterSortField(value.sortBy))
        || (value.sortOrder != null && value.sortOrder !== 'asc' && value.sortOrder !== 'desc')
        || (value.groupBy != null && !GROUP.has(String(value.groupBy)))
        || (value.icon != null && typeof value.icon !== 'string')) return false;
    const criteria = value.criteria as Record<string, unknown>;
    if (CRITERIA_ARRAYS.some((key) => criteria[key] != null
        && (!Array.isArray(criteria[key]) || !(criteria[key] as unknown[]).every((part) => typeof part === 'string')))
        || ['contextMatchMode', 'tagMatchMode'].some((key) => criteria[key] != null
            && criteria[key] !== 'any' && criteria[key] !== 'all')
        || ['hasDescription', 'isStarred'].some((key) => criteria[key] != null
            && typeof criteria[key] !== 'boolean')
        || ['dueDateRange', 'startDateRange', 'anyDateRange', 'timeEstimateRange'].some((key) =>
            criteria[key] != null && !record(criteria[key]))) return false;
    return normalizeSavedFilter(value) !== null;
};

const scopeFor = (model: FocusControlsModel, controls: FocusControlState,
    operation: FocusSavedFilterOperation): PreparedFocusSavedFilter['scope'] | null => {
    const state = useTaskStore.getState();
    const raw = state.settings.savedFilters ?? [];
    if (operation.type === 'save') {
        if (!model.perspective.canSavePerspective || model.filter.state.savedFilterId !== null) return null;
        return { before: null, creation: focusSavedFilterCreation(state, controls) };
    }
    const id = operation.type === 'delete' ? operation.id : controls.savedFilterId;
    if (!id) return null;
    const matches = raw.filter((filter) => filter.id === id);
    if (matches.length !== 1 || !validRawFilter(matches[0]) || matches[0].deletedAt) return null;
    if (operation.type === 'delete') {
        if (!model.savedFilters.some((filter) => filter.id === id)) return null;
    } else if (model.filter.activeSavedFilter?.id !== id
        || !model.advancedChips.some((chip) => chip.criterionId === operation.criterionId)) return null;
    return { before: matches[0], creation: null };
};

const plannedAfter = (request: FocusSavedFilterRequest, scope: PreparedFocusSavedFilter['scope'],
    preparedAt: string): SavedFilter | null => {
    if (request.operation.type === 'save') {
        if (scope.before !== null || !scope.creation?.canSave || request.controls.savedFilterId !== null) return null;
        const plan = planFocusFilterSave({ ...scope.creation, name: request.name!, savedFilters: [],
            id: request.requestId, nowIso: preparedAt });
        return plan?.filter ?? null;
    }
    const before = scope.before;
    if (!before || scope.creation !== null || before.deletedAt) return null;
    if (request.operation.type === 'delete') {
        if (before.id !== request.operation.id) return null;
        return prepareLocalSavedFilterUpdates([before],
            [{ ...before, updatedAt: preparedAt, deletedAt: preparedAt }], preparedAt)[0] ?? null;
    }
    if (before.id !== request.controls.savedFilterId) return null;
    const criterionId = request.operation.criterionId;
    if (!buildAdvancedFilterCriteriaChips(normalizeSavedFilter(before)!.criteria)
        .some((chip) => chip.id === criterionId)) return null;
    const plan = planFocusFilterCriterionRemoval({ activeSavedFilter: normalizeSavedFilter(before),
        criterionId, savedFilters: [before], nowIso: preparedAt });
    return plan ? prepareLocalSavedFilterUpdates([before], plan.savedFilters, preparedAt)[0] ?? null : null;
};

const plannedResult = (request: FocusSavedFilterRequest, after: SavedFilter): FocusSavedFilterResult => ({
    id: after.id,
    controls: request.operation.type === 'save' ? applyFocusSavedFilter(request.controls, after)
        : request.operation.type === 'delete' && request.controls.savedFilterId === after.id
            ? { ...request.controls, savedFilterId: null } : request.controls,
});

/** Pure validation of a cold journal, before opening native SQLite. */
const readPrepared = (value: unknown): PreparedFocusSavedFilter | null => {
    const envelope = detach<Record<string, unknown>>(value);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readRequest(envelope.request);
    const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'request', 'scope', 'after', 'preparedAt', 'result'])
        || raw.version !== 1 || !same(raw.request, request) || !record(raw.scope)
        || !exact(raw.scope, ['before', 'creation']) || !iso(raw.preparedAt)
        || !validRawFilter(raw.after) || !record(raw.result)
        || !exact(raw.result, ['controls', 'id'])) return null;
    const scope = raw.scope;
    if (scope.before !== null && !validRawFilter(scope.before)) return null;
    if (scope.creation !== null) {
        if (!record(scope.creation) || !exact(scope.creation,
            ['canSave', 'currentCriteria', 'effectiveSortBy', 'effectiveGroupBy'])
            || scope.creation.canSave !== true || !record(scope.creation.currentCriteria)
            || !isSavedFilterSortField(scope.creation.effectiveSortBy)
            || !GROUP.has(String(scope.creation.effectiveGroupBy))) return null;
        const selections = request.controls.filters;
        const visibleMaximum = { ...criteriaFromSelections({ tokens: selections.tokens,
            excludedTokens: selections.excludedTokens, projects: selections.projects,
            locations: selections.location.trim() ? [selections.location.trim()] : [],
            priorities: selections.priorities, energyLevels: selections.energyLevels,
            timeEstimates: selections.timeEstimates, contextMatchMode: selections.contextMatchMode,
            tagMatchMode: selections.tagMatchMode, anyDateRange: selections.anyDateRange }), ...request.controls.preservedCriteria };
        if (!same(scope.creation.currentCriteria, visibleMaximum)
            || !resolveTaskPerspectiveForFeatures({
                sortBy: scope.creation.effectiveSortBy,
                groupBy: String(scope.creation.effectiveGroupBy), settings: undefined,
                hasActiveFilters: false, hasCurrentCriteria: hasActiveFilterCriteria(visibleMaximum),
                activeSavedFilterId: request.controls.savedFilterId,
            }).canSavePerspective) return null;
    }
    if (request.operation.type === 'save' ? scope.before !== null || scope.creation === null
        : scope.before === null || scope.creation !== null) return null;
    const prepared = raw as PreparedFocusSavedFilter;
    if (focusSavedFilterToken(scope) !== request.expected) return null;
    try {
        const after = plannedAfter(request, prepared.scope, prepared.preparedAt);
        const result = after && plannedResult(request, after);
        return after && result && same(after, prepared.after) && same(result, prepared.result)
            ? prepared : null;
    } catch { return null; }
};

export function createFocusSavedFilterMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    revision: () => string;
    t: () => (key: string) => string;
    formatDate: (value: string) => string;
}) {
    const current = (controls: FocusControlState) => {
        const state = useTaskStore.getState();
        return buildFocusControlsModel({ state: controls, tasks: state.tasks, projects: state.projects,
            areas: state.areas, sections: state.sections, settings: state.settings, now: new Date(),
            t: deps.t(), formatDate: deps.formatDate });
    };
    return {
        getFocusSavedFilterOptions(input: { controls: FocusControlState; operation: FocusSavedFilterOperation }):
            NativeHostResult<{ revision: string; controls: FocusControlState; expected: string }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const raw = detach<Record<string, unknown>>(input);
            if (!raw || !exact(raw, ['controls', 'operation'])) return fail('INVALID_INPUT', 'Focus saved filter options are invalid');
            const controls = readNativeFocusControls(raw.controls);
            const operation = readOperation(raw.operation);
            if (!controls || !same(controls, raw.controls) || !operation)
                return fail('INVALID_INPUT', 'Focus saved filter options are invalid');
            const model = current(controls);
            const scope = scopeFor(model, model.filter.state, operation);
            if (!scope) return fail('INVALID_INPUT', 'Focus saved filter action is unavailable');
            const value = { revision: deps.revision(), controls: model.filter.state,
                expected: focusSavedFilterToken(scope) };
            return detach(value) ? { ok: true, value } : fail('INVALID_INPUT', 'Focus saved filter options exceed the native bound');
        },
        probeFocusSavedFilterOutcome(input: FocusSavedFilterRequest): NativeHostResult<FocusSavedFilterResult> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            return readRequest(input) ? fail('STALE_REVISION', 'Focus saved filter outcome is unknown')
                : fail('INVALID_INPUT', 'Focus saved filter request is invalid');
        },
        prepareFocusSavedFilter(input: FocusSavedFilterRequest): NativeHostResult<NativeFocusSavedFilterPreparation> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'Focus saved filter request is invalid');
            const state = useTaskStore.getState();
            if (request.operation.type === 'save'
                && state.settings.savedFilters?.some((filter) => filter.id === request.requestId))
                return fail('STALE_REVISION', 'Focus saved filter ID already exists');
            const scope = scopeFor(current(request.controls), request.controls, request.operation);
            if (!scope || request.expected !== focusSavedFilterToken(scope))
                return fail('STALE_REVISION', 'Focus saved filter changed; refresh before writing');
            const preparedAt = new Date().toISOString();
            const after = plannedAfter(request, scope, preparedAt);
            if (!after) return fail('INVALID_INPUT', 'Focus saved filter action is unavailable');
            const prepared: PreparedFocusSavedFilter = { version: 1, request, scope, after,
                preparedAt, result: plannedResult(request, after) };
            const frozen = detach<PreparedFocusSavedFilter>(prepared);
            return frozen && readPrepared({ request, prepared: frozen })
                ? { ok: true, value: { kind: 'prepared', prepared: frozen } }
                : fail('INVALID_INPUT', 'Focus saved filter journal is invalid');
        },
        validatePreparedFocusSavedFilter(input: { request: FocusSavedFilterRequest;
            prepared: PreparedFocusSavedFilter }): NativeHostResult<FocusSavedFilterResult> {
            const prepared = readPrepared(input);
            return prepared ? { ok: true, value: prepared.result }
                : fail('INVALID_INPUT', 'Prepared Focus saved filter journal is invalid');
        },
        async commitPreparedFocusSavedFilter(input: { request: FocusSavedFilterRequest;
            prepared: PreparedFocusSavedFilter }): Promise<NativeHostResult<FocusSavedFilterResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const prepared = readPrepared(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared Focus saved filter journal is invalid');
            const applied = await useTaskStore.getState().commitPreparedFocusSavedFilter(prepared);
            if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Focus saved filter conflicts with current data');
            try {
                if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
            } catch (error) { return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error)); }
            const saved = await deps.save();
            return saved.ok ? { ok: true, value: prepared.result } : saved;
        },
    };
}
