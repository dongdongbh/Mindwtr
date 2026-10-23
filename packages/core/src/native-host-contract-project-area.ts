import { AREA_PRESET_COLORS, DEFAULT_PROJECT_COLOR, isValidProjectColorOverride } from './color-constants';
import { logInfo } from './logger';
import type { NativeHostResult } from './native-host-contract';
import type { TranslateFn } from './i18n';
import { taskEditValuesEqual } from './json-value-equality';
import { detach, exact, iso, record, validProject } from './native-host-contract-project-shared';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { ensureDeviceId } from './store-helpers';
import { useTaskStore } from './store';
import { projectAreaEffect, projectAreaOrderMax, sameProjectSqliteRow } from './store-projects/project-actions';
import type { PreparedProjectArea } from './store-types';
import type { Area, Project } from './types';

export type NativeProjectAreaToken = { title: string; status: Project['status'];
    areaId: string | null; areaTitle: string | null; order: number;
    rev: number | null; revBy: string | null; updatedAt: string };
export type NativeProjectAreaWitness = { id: string; name: string };
export type NativeProjectAreaRequest = { requestId: string; projectId: string; areaId: string | null;
    colorOverride?: string | null; expected: NativeProjectAreaToken; selectedArea: NativeProjectAreaWitness | null };
export type NativeProjectAreaResult = { id: string; areaId: string | null; areaTitle: string | null; order: number; colorOverride?: string | null };
export type NativePreparedProjectArea = PreparedProjectArea & { version: 1 | 2;
    request: NativeProjectAreaRequest; result: NativeProjectAreaResult };
export type NativeProjectAreaPreparation = { kind: 'noop'; result: NativeProjectAreaResult }
    | { kind: 'blocked'; result: { blocked: '' } }
    | { kind: 'prepared'; prepared: NativePreparedProjectArea };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const same = taskEditValuesEqual;
const canonicalISO = (value: unknown): value is string => iso(value)
    && value.length === 24 && new Date(value).toISOString() === value;
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 500;
const nullableId = (value: unknown): value is string | null => value === null || id(value);
const nullableTitle = (value: unknown): value is string | null =>
    value === null || typeof value === 'string' && value.length <= 100_000;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const token = (project: Project): NativeProjectAreaToken => ({
    title: project.title, status: project.status, areaId: project.areaId ?? null,
    areaTitle: project.areaTitle ?? null, order: project.order, rev: project.rev ?? null,
    revBy: project.revBy ?? null, updatedAt: project.updatedAt,
});
const colorUpdate = (request: NativeProjectAreaRequest): Pick<Project, 'colorOverride'> | undefined =>
    Object.prototype.hasOwnProperty.call(request, 'colorOverride') ? { colorOverride: request.colorOverride } : undefined;
const result = (project: Project, request: NativeProjectAreaRequest): NativeProjectAreaResult => ({ id: project.id,
    areaId: project.areaId ?? null, areaTitle: project.areaTitle ?? null, order: project.order,
    ...(colorUpdate(request) ? { colorOverride: project.colorOverride ?? null } : {}) });
/** Native No Area treats nullable SQLite metadata as already clear without rewriting it. */
const nativeNoop = (project: Project, request: NativeProjectAreaRequest): boolean =>
    (project.areaId ?? null) === request.areaId
    && (project.areaTitle ?? null) === (request.selectedArea?.name.trim() || null)
    && (!colorUpdate(request) || (project.colorOverride ?? null) === request.colorOverride
        && (request.colorOverride !== null || Boolean(project.areaId) || project.color === DEFAULT_PROJECT_COLOR || project.color === '#6B7280'));

const validAreaProject = (value: unknown, projectId: string): value is Project => {
    if (!record(value)) return false;
    // SQLite may hydrate nullable optional columns as null; preserve the raw frozen row.
    const normalized = { ...value, areaId: value.areaId ?? undefined, areaTitle: value.areaTitle ?? undefined,
        startDate: value.startDate ?? undefined, dueDate: value.dueDate ?? undefined,
        reviewAt: value.reviewAt ?? undefined, supportNotes: value.supportNotes ?? undefined,
        cancelledAt: value.cancelledAt ?? undefined, revBy: value.revBy ?? undefined };
    return validProject(normalized, projectId);
};
const validWitness = (value: unknown): value is NativeProjectAreaWitness =>
    record(value) && exact(value, ['id', 'name']) && id(value.id)
    && typeof value.name === 'string' && value.name.length <= 100_000;
const validToken = (value: unknown): value is NativeProjectAreaToken =>
    record(value) && exact(value, ['title', 'status', 'areaId', 'areaTitle', 'order', 'rev', 'revBy', 'updatedAt'])
    && typeof value.title === 'string' && value.title.length <= 100_000
    && ['active', 'someday', 'waiting', 'archived'].includes(String(value.status))
    && nullableId(value.areaId) && nullableTitle(value.areaTitle)
    && typeof value.order === 'number' && Number.isFinite(value.order)
    && (value.rev === null || typeof value.rev === 'number' && Number.isSafeInteger(value.rev) && value.rev >= 0)
    && (value.revBy === null || typeof value.revBy === 'string' && value.revBy.length <= 500)
    && canonicalISO(value.updatedAt);
const readRequest = (value: unknown): NativeProjectAreaRequest | null => {
    const input = detach<Record<string, unknown>>(value);
    return input && exact(input, ['requestId', 'projectId', 'areaId', 'expected', 'selectedArea', ...(Object.prototype.hasOwnProperty.call(input, 'colorOverride') ? ['colorOverride'] : [])])
        && (!Object.prototype.hasOwnProperty.call(input, 'colorOverride') || input.colorOverride !== undefined && isValidProjectColorOverride(input.colorOverride))
        && typeof input.requestId === 'string' && UUID.test(input.requestId)
        && id(input.projectId) && nullableId(input.areaId) && validToken(input.expected)
        && (input.areaId === null ? input.selectedArea === null
            : validWitness(input.selectedArea) && input.selectedArea.id === input.areaId)
        ? input as NativeProjectAreaRequest : null;
};

/** Pure cold-journal validation before a mutable store or SQL check. */
const readPrepared = (value: unknown): NativePreparedProjectArea | null => {
    const envelope = detach<Record<string, unknown>>(value);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readRequest(envelope.request);
    const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'request', 'scope', 'effect', 'deviceIdBefore',
        'deviceIdToInitialize', 'updateAt', 'result']) || ![1, 2].includes(Number(raw.version)) || raw.version === 1 && Boolean(colorUpdate(request)) || !same(raw.request, request)
        || !record(raw.scope) || !exact(raw.scope, ['project', 'selectedArea', 'orderMax'])
        || !(raw.scope.selectedArea === null || record(raw.scope.selectedArea)
            && (raw.version === 1 ? validWitness(raw.scope.selectedArea)
                : exact(raw.scope.selectedArea, ['id', 'name', 'color']) && validWitness({ id: raw.scope.selectedArea.id, name: raw.scope.selectedArea.name })
                    && (raw.scope.selectedArea.color === null || typeof raw.scope.selectedArea.color === 'string')))
        || !same(raw.scope.selectedArea && { id: raw.scope.selectedArea.id, name: raw.scope.selectedArea.name }, request.selectedArea)
        || typeof raw.scope.orderMax !== 'number' || !Number.isFinite(raw.scope.orderMax)
        || raw.scope.orderMax < -1 || !record(raw.scope.project)
        || !record(raw.effect) || !exact(raw.effect, ['project']) || !record(raw.effect.project)
        || !exact(raw.effect.project, ['before', 'after'])
        || !(raw.deviceIdBefore === null || typeof raw.deviceIdBefore === 'string' && Boolean(raw.deviceIdBefore))
        || (raw.deviceIdBefore === null
            ? typeof raw.deviceIdToInitialize !== 'string' || !UUID.test(raw.deviceIdToInitialize)
            : raw.deviceIdToInitialize !== null)
        || !canonicalISO(raw.updateAt) || !record(raw.result)
        || !exact(raw.result, ['id', 'areaId', 'areaTitle', 'order', ...(colorUpdate(request) ? ['colorOverride'] : [])])
        || raw.result.id !== request.projectId || !nullableId(raw.result.areaId)
        || !nullableTitle(raw.result.areaTitle) || typeof raw.result.order !== 'number'
        || !Number.isFinite(raw.result.order)) return null;
    try {
        const prepared = raw as unknown as NativePreparedProjectArea;
        const before = prepared.scope.project;
        if (!validAreaProject(before, request.projectId)
            || !validAreaProject(prepared.effect.project.before, request.projectId)
            || !validAreaProject(prepared.effect.project.after, request.projectId)
            || before.status === 'archived' || !same(token(before), request.expected)
            || !same(before, prepared.effect.project.before)) return null;
        if (nativeNoop(before, request)) return null;
        const witnessProject = { id: 'native-area-order-witness', areaId: request.areaId ?? undefined,
            order: prepared.scope.orderMax } as Project;
        const planned = projectAreaEffect(before, request.areaId, [witnessProject],
            prepared.scope.selectedArea ? [prepared.scope.selectedArea as Area] : [],
            prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!, prepared.updateAt, colorUpdate(request), prepared.version);
        return same(planned, prepared.effect) && same(result(planned.project.after, request), prepared.result)
            && !sameProjectSqliteRow(before, planned.project.after) ? prepared : null;
    } catch { return null; }
};

export function createProjectAreaMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    revision: () => string;
    sortedAreas: () => Area[];
    t: () => TranslateFn;
}) {
    return {
        getProjectAreaOptions(input: { projectId: string }): NativeHostResult<{ revision: string;
            project: { id: string } & NativeProjectAreaToken; canEdit: boolean; noAreaLabel: string;
            colorOverride: string | null; colors: string[];
            areas: Array<{ id: string; label: string; color: string | null }> }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!input || !id(input.projectId)) return fail('INVALID_INPUT', 'A Project ID is required');
            const project = useTaskStore.getState()._projectsById.get(input.projectId);
            if (!project || project.deletedAt || project.purgedAt)
                return fail('STALE_REVISION', 'Project is unavailable; refresh before assigning an Area');
            const expected = token(project);
            if (!validToken(expected)) return fail('INVALID_INPUT', 'Project Area token exceeds the bounded native response');
            const value = { revision: deps.revision(), project: { id: project.id, ...expected },
                colorOverride: project.colorOverride ?? null, colors: [DEFAULT_PROJECT_COLOR, ...AREA_PRESET_COLORS],
                canEdit: project.status !== 'archived', noAreaLabel: deps.t()('projects.noArea'),
                areas: deps.sortedAreas().filter((area) => !area.deletedAt)
                    .map((area) => ({ id: area.id, label: area.name, color: area.color ?? null })) };
            return value.areas.every((area) => id(area.id) && nullableTitle(area.label)
                && (area.color === null || typeof area.color === 'string')) && isNativeJsonWithinBytes(value)
                ? { ok: true, value } : fail('INVALID_INPUT', 'Project Area options exceed the bounded native response');
        },

        probeProjectAreaOutcome(input: NativeProjectAreaRequest): NativeHostResult<NativeProjectAreaResult> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            return readRequest(input) ? fail('STALE_REVISION', 'Project Area outcome is unknown; refresh before trying again')
                : fail('INVALID_INPUT', 'A bounded Project Area request is required');
        },

        prepareProjectArea(input: NativeProjectAreaRequest): NativeHostResult<NativeProjectAreaPreparation> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded Project Area request is required');
            const state = useTaskStore.getState();
            const project = state._projectsById.get(request.projectId);
            if (!project || project.deletedAt || project.purgedAt || !same(token(project), request.expected))
                return fail('STALE_REVISION', 'Project changed; refresh before assigning an Area');
            if (project.status === 'archived')
                return { ok: true, value: { kind: 'blocked', result: { blocked: '' } } };
            const selected = request.selectedArea ? state._areasById.get(request.selectedArea.id) : null;
            if (request.selectedArea && (!selected || selected.deletedAt || selected.name !== request.selectedArea.name))
                return fail('STALE_REVISION', 'Selected Area changed; refresh before assigning it');
            if (nativeNoop(project, request))
                return { ok: true, value: { kind: 'noop', result: result(project, request) } };
            const device = ensureDeviceId(state.settings);
            const updateAt = new Date().toISOString();
            const effect = projectAreaEffect(project, request.areaId, state._allProjects, state._allAreas,
                device.deviceId, updateAt, colorUpdate(request));
            const prepared: NativePreparedProjectArea = { version: 2, request,
                scope: { project, selectedArea: request.selectedArea ? { ...request.selectedArea, color: selected?.color ?? null } : null,
                    orderMax: projectAreaOrderMax(state._allProjects, request.areaId) },
                effect, deviceIdBefore: state.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                updateAt, result: result(effect.project.after, request) };
            const frozen = detach<NativePreparedProjectArea>(JSON.parse(JSON.stringify(prepared)));
            return frozen && readPrepared({ request, prepared: frozen })
                ? { ok: true, value: { kind: 'prepared', prepared: frozen } }
                : fail('INVALID_INPUT', 'Project Area edit exceeds the bounded journal');
        },

        validatePreparedProjectArea(input: { request: NativeProjectAreaRequest;
            prepared: NativePreparedProjectArea }): NativeHostResult<NativeProjectAreaResult> {
            const prepared = readPrepared(input);
            return prepared ? { ok: true, value: prepared.result }
                : fail('INVALID_INPUT', 'Prepared Project Area request or journal does not match');
        },

        async commitPreparedProjectArea(input: { request: NativeProjectAreaRequest;
            prepared: NativePreparedProjectArea }): Promise<NativeHostResult<NativeProjectAreaResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const prepared = readPrepared(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared Project Area request or journal does not match');
            const applied = await useTaskStore.getState().commitPreparedProjectArea(prepared);
            if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Prepared Project Area conflicts with current data');
            try {
                if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
            } catch (error) { return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error)); }
            const saved = await deps.save();
            if (saved.ok && colorUpdate(prepared.request)) logInfo('Project color saved', { scope: 'native-host',
                context: { releaseCheck: 'v1.3.7/project-color', mode: prepared.request.colorOverride ? 'override' : 'area' } });
            return saved.ok ? { ok: true, value: prepared.result } : saved;
        },
    };
}
