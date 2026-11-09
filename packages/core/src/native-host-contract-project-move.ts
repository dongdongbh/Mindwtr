import { logInfo } from './logger';
import type { NativeHostResult, NativeProjectsView } from './native-host-contract';
import { detach, exact, iso, record, validProject } from './native-host-contract-project-shared';
import { isNativeJsonWithinBytes } from './native-json';
import { projectToSqliteRow } from './project-sync-schema';
import { ensureDeviceId } from './store-helpers';
import { useTaskStore } from './store';
import { liveAreaProjects, planPreparedProjectOrder, projectOrderEffect } from './store-projects/ordering-actions';
import { sameSectionDeleteJson } from './store-projects/section-actions';
import type { PreparedProjectOrder } from './store-types';
import type { Project } from './types';

export type NativeProjectMoveRequest = PreparedProjectOrder['request'];
export type NativeProjectMoveResult = PreparedProjectOrder['result'];
export type NativePreparedProjectMove = PreparedProjectOrder & { version: 1 };
export type NativeProjectMovePreparation = { kind: 'prepared'; prepared: NativePreparedProjectMove };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const same = sameSectionDeleteJson;
const boundedId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 500;

const snapshotProject = (value: unknown): boolean => {
    if (!record(value) || !boundedId(value.id) || value.deletedAt !== undefined || value.purgedAt !== undefined) return false;
    try { projectToSqliteRow(value as unknown as Project); return true; }
    catch { return false; }
};

const shownNeighbour = (request: NativeProjectMoveRequest): string | null => {
    const index = request.order.indexOf(request.projectId);
    return index < 0 ? null : request.order[index + (request.direction === 'up' ? -1 : 1)] ?? null;
};

const readRequest = (value: unknown): NativeProjectMoveRequest | null => {
    const input = detach<Record<string, unknown>>(value);
    if (!input || !exact(input, ['requestId', 'projectId', 'direction', 'tagFilter', 'order'])
        || typeof input.requestId !== 'string' || !UUID.test(input.requestId)
        || !boundedId(input.projectId)
        || (input.direction !== 'up' && input.direction !== 'down')
        || typeof input.tagFilter !== 'string' || input.tagFilter.length > 100_000
        || !Array.isArray(input.order) || input.order.length < 2
        || !input.order.every(boundedId) || new Set(input.order).size !== input.order.length
        || !input.order.includes(input.projectId)) return null;
    return input as NativeProjectMoveRequest;
};

const readPrepared = (value: unknown): NativePreparedProjectMove | null => {
    const envelope = detach<Record<string, unknown>>(value);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readRequest(envelope.request);
    const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'request', 'scope', 'effect', 'deviceIdBefore',
        'deviceIdToInitialize', 'preparedAt', 'result']) || raw.version !== 1
        || !same(raw.request, request)
        || !record(raw.scope) || !exact(raw.scope, ['neighbourId', 'projects'])
        || raw.scope.neighbourId !== shownNeighbour(request) || !Array.isArray(raw.scope.projects)
        || !record(raw.effect) || !exact(raw.effect, ['projects'])
        || !Array.isArray(raw.effect.projects) || raw.effect.projects.length === 0
        || !(raw.deviceIdBefore === null || typeof raw.deviceIdBefore === 'string' && Boolean(raw.deviceIdBefore))
        || (raw.deviceIdBefore === null
            ? typeof raw.deviceIdToInitialize !== 'string' || !UUID.test(raw.deviceIdToInitialize)
            : raw.deviceIdToInitialize !== null)
        || !iso(raw.preparedAt) || !record(raw.result)
        || !exact(raw.result, ['projectId', 'orderedIds'])
        || raw.result.projectId !== request.projectId || !Array.isArray(raw.result.orderedIds)) return null;
    try {
        const prepared = raw as unknown as NativePreparedProjectMove;
        const { scope } = prepared;
        if (!scope.projects.every(snapshotProject)) return null;
        const moved = scope.projects.find((row) => row.id === request.projectId);
        if (!moved || !validProject(moved, request.projectId) || !same(liveAreaProjects(scope.projects, moved.areaId ?? undefined), scope.projects)
            || new Set(scope.projects.map((row) => row.id)).size !== scope.projects.length) return null;
        const planned = planPreparedProjectOrder(scope.projects, request, scope.neighbourId);
        if (!planned || !same(planned.orderedIds, prepared.result.orderedIds)) return null;
        const effect = projectOrderEffect(scope.projects, planned.orderedIds,
            prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!, prepared.preparedAt);
        return effect.projects.length > 0 && same(effect, prepared.effect) ? prepared : null;
    } catch { return null; }
};

export function createProjectMoveMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    projectsView: (tagFilter: string) => NativeProjectsView;
}) {
    return {
        probeProjectMoveOutcome(input: NativeProjectMoveRequest): NativeHostResult<NativeProjectMoveResult> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            return readRequest(input) ? fail('STALE_REVISION', 'Project order outcome is unknown; refresh before moving again')
                : fail('INVALID_INPUT', 'A bounded Project move request is required');
        },

        prepareProjectMove(input: NativeProjectMoveRequest): NativeHostResult<NativeProjectMovePreparation> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded Project move request is required');
            const view = deps.projectsView(request.tagFilter);
            const group = [...view.active, ...view.deferred, ...view.archived]
                .find((entry) => entry.projects.some((row) => row.id === request.projectId));
            if (!group || !same(group.projects.map((row) => row.id), request.order))
                return fail('STALE_REVISION', 'Projects changed; refresh before moving');
            const neighbourId = shownNeighbour(request);
            const state = useTaskStore.getState();
            const moved = state._projectsById.get(request.projectId);
            if (!neighbourId || !moved || moved.deletedAt) return fail('STALE_REVISION', 'Project cannot move in that direction');
            const projects = liveAreaProjects(state._allProjects, moved.areaId ?? undefined);
            if (!validProject(JSON.parse(JSON.stringify(moved)), moved.id))
                return fail('INVALID_INPUT', 'This Project has stored data the native app cannot write, so it cannot be moved');
            if (!projects.every((row) => snapshotProject(JSON.parse(JSON.stringify(row)))))
                return fail('INVALID_INPUT', 'A Project in this Area has stored data the native app cannot read, so no Project here can be moved');
            const planned = planPreparedProjectOrder(projects, request, neighbourId);
            if (!planned) return fail('STALE_REVISION', 'Project cannot move in that direction');
            const device = ensureDeviceId(state.settings);
            const preparedAt = new Date().toISOString();
            const effect = projectOrderEffect(projects, planned.orderedIds, device.deviceId, preparedAt);
            if (effect.projects.length === 0) return fail('STALE_REVISION', 'Project cannot move in that direction');
            const prepared: NativePreparedProjectMove = { version: 1, request,
                scope: { neighbourId, projects }, effect,
                deviceIdBefore: state.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                preparedAt, result: { projectId: request.projectId, orderedIds: planned.orderedIds } };
            if (!isNativeJsonWithinBytes(prepared))
                return fail('INVALID_INPUT', 'This Area holds too much Project data to save a move safely');
            const frozen = detach<NativePreparedProjectMove>(JSON.parse(JSON.stringify(prepared)));
            return frozen && readPrepared({ request, prepared: frozen })
                ? { ok: true, value: { kind: 'prepared', prepared: frozen } }
                : fail('INVALID_INPUT', 'Prepared Project move did not pass its own check');
        },

        validatePreparedProjectMove(input: { request: NativeProjectMoveRequest;
            prepared: NativePreparedProjectMove }): NativeHostResult<NativeProjectMoveResult> {
            const prepared = readPrepared(input);
            return prepared ? { ok: true, value: prepared.result }
                : fail('INVALID_INPUT', 'Prepared Project move request or journal does not match');
        },

        async commitPreparedProjectMove(input: { request: NativeProjectMoveRequest;
            prepared: NativePreparedProjectMove }): Promise<NativeHostResult<NativeProjectMoveResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const prepared = readPrepared(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared Project move request or journal does not match');
            const applied = await useTaskStore.getState().commitPreparedProjectOrder(prepared);
            if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Prepared Project move conflicts with current data');
            try {
                if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
            } catch (error) { return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error)); }
            const saved = await deps.save();
            if (saved.ok) logInfo('Projects list row moved', { scope: 'native-host',
                context: { releaseCheck: 'v1.3.9/ios-project-row-move', direction: prepared.request.direction,
                    outcome: applied.outcome === 'replayed' ? 'replayed' : 'saved' } });
            return saved.ok ? { ok: true, value: prepared.result } : saved;
        },
    };
}
