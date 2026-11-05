import type { NativeHostResult } from './native-host-contract';
import { AREA_FILTER_ALL, AREA_FILTER_NONE, areaFilterSelectionToValue, resolveAreaFilterSelection } from './area-filter';
import { DEFAULT_PROJECT_COLOR } from './color-constants';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { projectToSqliteRow } from './project-sync-schema';
import { findSelectableProjectByTitleAndArea } from './project-utils';
import { ensureDeviceId } from './store-helpers';
import { useTaskStore } from './store';
import { buildNewProject, projectAreaOrderMax } from './store-projects/project-actions';
import type { PreparedProjectCreate } from './store-types';
import { taskEditValuesEqual } from './json-value-equality';
import type { Area, Project } from './types';

export type NativeProjectCreateRequest = { requestId: string; title: string; areaId: string | null };
export type NativeProjectCreateResult = { id: string; created: boolean };
export type NativePreparedProjectCreate = PreparedProjectCreate & {
    version: 1;
    request: NativeProjectCreateRequest;
    preparedAt: string;
    result: { id: string; created: true };
};
export type NativeProjectCreatePreparation = { kind: 'existing'; result: NativeProjectCreateResult }
    | { kind: 'prepared'; prepared: NativePreparedProjectCreate };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length
    && keys.every((key) => own(value, key));
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });

/** Journal inputs are strict JSON; count encoded bytes as the Swift transport does. */
const detach = <T>(value: unknown): T | null => {
    const valid = (item: unknown, depth: number): boolean => {
        if (depth > 24) return false;
        if (item === null || typeof item === 'string' || typeof item === 'boolean') return true;
        if (typeof item === 'number') return Number.isFinite(item);
        if (Array.isArray(item)) return item.length <= 2_000_000 && item.every((part) => valid(part, depth + 1));
        return record(item) && (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)
            && Object.keys(item).length <= 128 && Object.entries(item).every(([key, part]) =>
                !['__proto__', 'constructor', 'prototype'].includes(key) && valid(part, depth + 1));
    };
    if (!valid(value, 0) || !isNativeJsonWithinBytes(value)) return null;
    return JSON.parse(JSON.stringify(value)) as T;
};
const readRequest = (value: unknown): NativeProjectCreateRequest | null => {
    const input = detach<Record<string, unknown>>(value);
    return input && exact(input, ['requestId', 'title', 'areaId'])
        && typeof input.requestId === 'string' && UUID.test(input.requestId)
        && typeof input.title === 'string' && Boolean(input.title.trim())
        && (input.areaId === null || typeof input.areaId === 'string' && Boolean(input.areaId) && input.areaId.length <= 500)
        ? input as NativeProjectCreateRequest : null;
};
const same = taskEditValuesEqual;
const areaWitness = (area: Area): PreparedProjectCreate['selectedArea'] => ({
    id: area.id, name: area.name, color: area.color ?? null, deletedAt: null,
});
const expectedProject = (prepared: NativePreparedProjectCreate): Project => {
    const { selectedArea, request } = prepared;
    const witness = prepared.orderMax > -1 ? [{ id: 'native-project-order-witness',
        areaId: selectedArea?.id, order: prepared.orderMax } as Project] : [];
    return buildNewProject({
        title: request.title, color: selectedArea?.color || DEFAULT_PROJECT_COLOR,
        initialProps: selectedArea ? { areaId: selectedArea.id } : undefined,
        existingProjects: witness, existingAreas: selectedArea ? [{ id: selectedArea.id, name: selectedArea.name,
            color: selectedArea.color ?? undefined, order: 0,
            createdAt: prepared.preparedAt, updatedAt: prepared.preparedAt }] : [],
        settings: { gtd: { defaultProjectFlowMode: prepared.defaultProjectFlowMode } } as ReturnType<typeof useTaskStore.getState>['settings'],
        deviceId: prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!,
        now: prepared.preparedAt, id: request.requestId,
    });
};

/** Pure, including on a cold boot before storage is opened. */
const readPrepared = (value: unknown): NativePreparedProjectCreate | null => {
    const input = detach<Record<string, unknown>>(value);
    if (!input || !exact(input, ['request', 'prepared']) || !record(input.prepared)) return null;
    const request = readRequest(input.request);
    const raw = input.prepared;
    if (!request || !exact(raw, ['version', 'request', 'project', 'deviceIdBefore', 'deviceIdToInitialize',
        'selectedArea', 'orderMax', 'defaultProjectFlowMode', 'preparedAt', 'result'])
        || raw.version !== 1 || !same(raw.request, request) || !record(raw.project) || !record(raw.result)
        || !exact(raw.result, ['id', 'created']) || raw.result.id !== request.requestId || raw.result.created !== true
        || !(raw.deviceIdBefore === null || typeof raw.deviceIdBefore === 'string' && Boolean(raw.deviceIdBefore))
        || (raw.deviceIdBefore === null
            ? typeof raw.deviceIdToInitialize !== 'string' || !UUID.test(raw.deviceIdToInitialize)
            : raw.deviceIdToInitialize !== null)
        || typeof raw.orderMax !== 'number' || !Number.isFinite(raw.orderMax) || raw.orderMax < -1
        || !(raw.defaultProjectFlowMode === null || typeof raw.defaultProjectFlowMode === 'string')
        || typeof raw.preparedAt !== 'string' || !Number.isFinite(Date.parse(raw.preparedAt))
        || new Date(raw.preparedAt).toISOString() !== raw.preparedAt) return null;
    if (request.areaId === null ? raw.selectedArea !== null : !record(raw.selectedArea)
        || !exact(raw.selectedArea, ['id', 'name', 'color', 'deletedAt'])
        || raw.selectedArea.id !== request.areaId || typeof raw.selectedArea.name !== 'string'
        || !(raw.selectedArea.color === null || typeof raw.selectedArea.color === 'string')
        || raw.selectedArea.deletedAt !== null) return null;
    try {
        const prepared = raw as unknown as NativePreparedProjectCreate;
        const expected = expectedProject(prepared);
        return prepared.project.id === request.requestId
            && same(prepared.project, expected)
            && same(projectToSqliteRow(prepared.project), projectToSqliteRow(expected)) ? prepared : null;
    } catch {
        return null;
    }
};

export function createProjectCreateMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    revision: () => string;
    sortedAreas: () => Area[];
    t: () => (key: string) => string;
}) {
    return {
        getProjectCreateOptions(): NativeHostResult<{ revision: string; areaFilterValue: string; defaultAreaId: string | null;
            noAreaLabel: string; areas: Array<{ id: string; label: string; color: string | null }> }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const areas = deps.sortedAreas();
            const value = areaFilterSelectionToValue(resolveAreaFilterSelection(useTaskStore.getState().settings.filters, areas));
            return { ok: true, value: {
                revision: deps.revision(),
                areaFilterValue: value,
                defaultAreaId: value === AREA_FILTER_ALL || value === AREA_FILTER_NONE ? null : value,
                noAreaLabel: deps.t()('projects.noArea'),
                areas: areas.map((area) => ({ id: area.id, label: area.name, color: area.color ?? null })),
            } };
        },

        prepareProjectCreate(input: NativeProjectCreateRequest): NativeHostResult<NativeProjectCreatePreparation> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded project title, area, and lowercase UUID are required');
            const state = useTaskStore.getState();
            const existing = findSelectableProjectByTitleAndArea(state._allProjects, request.title, request.areaId ?? undefined);
            if (existing) return { ok: true, value: { kind: 'existing', result: { id: existing.id, created: false } } };
            const area = request.areaId === null ? null : state._areasById.get(request.areaId);
            if (request.areaId !== null && (!area || area.deletedAt)) return fail('INVALID_INPUT', 'Selected area is unavailable');
            const device = ensureDeviceId(state.settings);
            const prepared: NativePreparedProjectCreate = {
                version: 1, request,
                project: {} as Project,
                preparedAt: new Date().toISOString(),
                deviceIdBefore: state.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                selectedArea: area ? areaWitness(area) : null,
                orderMax: projectAreaOrderMax(state._allProjects, request.areaId),
                defaultProjectFlowMode: state.settings.gtd?.defaultProjectFlowMode ?? null,
                result: { id: request.requestId, created: true },
            };
            prepared.project = expectedProject(prepared);
            const detached = detach<NativePreparedProjectCreate>(JSON.parse(JSON.stringify(prepared)));
            if (!detached || !readPrepared({ request, prepared: detached })) {
                return fail('INVALID_INPUT', 'Project creation exceeds the bounded journal');
            }
            return { ok: true, value: { kind: 'prepared', prepared: detached } };
        },

        projectCreateRetryOutcome(input: NativeProjectCreateRequest): NativeHostResult<NativeProjectCreateResult> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded project title, area, and lowercase UUID are required');
            const project = findSelectableProjectByTitleAndArea(useTaskStore.getState()._allProjects,
                request.title, request.areaId ?? undefined);
            return project?.id === request.requestId && !project.purgedAt
                ? { ok: true, value: { id: project.id, created: false } }
                : fail('STALE_REVISION', 'Project creation outcome no longer matches the requested project');
        },

        validatePreparedProjectCreate(input: { request: NativeProjectCreateRequest; prepared: NativePreparedProjectCreate }): NativeHostResult<NativeProjectCreateResult> {
            const prepared = readPrepared(input);
            return prepared ? { ok: true, value: prepared.result }
                : fail('INVALID_INPUT', 'Prepared project request or journal does not match');
        },

        async commitPreparedProjectCreate(input: { request: NativeProjectCreateRequest; prepared: NativePreparedProjectCreate }): Promise<NativeHostResult<NativeProjectCreateResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const prepared = readPrepared(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared project request or journal does not match');
            const applied = await useTaskStore.getState().commitPreparedProjectCreate(prepared);
            if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Prepared project conflicts with current data');
            try {
                if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
            } catch (error) {
                return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error));
            }
            const saved = await deps.save();
            return saved.ok ? { ok: true, value: prepared.result } : saved;
        },
    };
}
