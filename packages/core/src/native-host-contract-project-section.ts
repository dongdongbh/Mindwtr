import type { NativeHostResult } from './native-host-contract';
import { taskEditValuesEqual } from './json-value-equality';
import { detach, exact, iso, record, validProject } from './native-host-contract-project-shared';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { getProjectSectionsForView } from './project-utils';
import { sectionToSqliteRow } from './section-sync-schema';
import { ensureDeviceId } from './store-helpers';
import { useTaskStore } from './store';
import { buildNewSection, projectSectionOrderMax } from './store-projects/section-actions';
import type { PreparedProjectSectionCreate } from './store-types';
import type { Project } from './types';

export type NativeProjectSectionCreateRequest = { requestId: string; projectId: string; title: string };
export type NativeProjectSectionCreateResult = { id: string; projectId: string };
export type NativePreparedProjectSectionCreate = PreparedProjectSectionCreate & { version: 1;
    result: NativeProjectSectionCreateResult };
export type NativeProjectSectionCreatePreparation = { kind: 'prepared'; prepared: NativePreparedProjectSectionCreate };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const same = taskEditValuesEqual;
const result = (request: NativeProjectSectionCreateRequest): NativeProjectSectionCreateResult =>
    ({ id: request.requestId, projectId: request.projectId });
const sameSectionRow = (left: Parameters<typeof sectionToSqliteRow>[0], right: Parameters<typeof sectionToSqliteRow>[0]) =>
    JSON.stringify(sectionToSqliteRow(left)) === JSON.stringify(sectionToSqliteRow(right));
const validSectionParent = (value: unknown, projectId: string): value is Project => record(value)

    && validProject(Object.fromEntries(Object.entries(value).map(([key, part]) =>
        [key, part === null ? undefined : part])), projectId);

const readRequest = (value: unknown): NativeProjectSectionCreateRequest | null => {
    const input = detach<Record<string, unknown>>(value);
    return input && exact(input, ['requestId', 'projectId', 'title'])
        && typeof input.requestId === 'string' && UUID.test(input.requestId)
        && typeof input.projectId === 'string' && Boolean(input.projectId) && input.projectId.length <= 500
        && typeof input.title === 'string' && Boolean(input.title.trim()) && input.title.length <= 100_000
        ? input as NativeProjectSectionCreateRequest : null;
};


const readPrepared = (value: unknown): NativePreparedProjectSectionCreate | null => {
    const envelope = detach<Record<string, unknown>>(value);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readRequest(envelope.request);
    const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'request', 'scope', 'section', 'deviceIdBefore',
        'deviceIdToInitialize', 'preparedAt', 'result']) || raw.version !== 1 || !same(raw.request, request)
        || !record(raw.scope) || !exact(raw.scope, ['project', 'orderMax'])
        || !record(raw.section) || !record(raw.result) || !exact(raw.result, ['id', 'projectId'])
        || !same(raw.result, result(request))
        || !(raw.deviceIdBefore === null || typeof raw.deviceIdBefore === 'string' && Boolean(raw.deviceIdBefore))
        || (raw.deviceIdBefore === null
            ? typeof raw.deviceIdToInitialize !== 'string' || !UUID.test(raw.deviceIdToInitialize)
            : raw.deviceIdToInitialize !== null)
        || !iso(raw.preparedAt)
        || typeof raw.scope.orderMax !== 'number' || !Number.isFinite(raw.scope.orderMax)
        || raw.scope.orderMax < -1) return null;
    try {
        const prepared = raw as unknown as NativePreparedProjectSectionCreate;
        const parent = prepared.scope.project;
        if (!validSectionParent(parent, request.projectId) || parent.status === 'archived') return null;
        const expected = buildNewSection({ id: request.requestId, projectId: request.projectId,
            title: request.title, orderMax: prepared.scope.orderMax,
            deviceId: prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!, now: prepared.preparedAt });
        const frozenExpected = JSON.parse(JSON.stringify(expected)) as typeof expected;
        return Object.keys(prepared.section).sort().join('\0') === Object.keys(frozenExpected).sort().join('\0')
            && same(prepared.section, frozenExpected) && sameSectionRow(prepared.section, expected)
            ? prepared : null;
    } catch { return null; }
};

export function createProjectSectionMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    revision: () => string;
}) {
    return {
        getProjectSectionOptions(input: { projectId: string }): NativeHostResult<{
            revision: string; project: { id: string; title: string; status: Project['status'] };
            canCreate: boolean; sections: Array<{ id: string; title: string }> }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!input || typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 500)
                return fail('INVALID_INPUT', 'A bounded Project ID is required');
            const state = useTaskStore.getState();
            const project = state._projectsById.get(input.projectId);
            if (!project || project.deletedAt || project.purgedAt)
                return fail('STALE_REVISION', 'Project is unavailable');
            const value = { revision: deps.revision(),
                project: { id: project.id, title: project.title, status: project.status },
                canCreate: project.status !== 'archived',
                sections: getProjectSectionsForView(project, state.sections, state._allSections)
                    .map((section) => ({ id: section.id, title: section.title })) };
            return isNativeJsonWithinBytes(value) ? { ok: true, value }
                : fail('INVALID_INPUT', 'Project Section options exceed the bounded native response');
        },

        probeProjectSectionCreateOutcome(input: NativeProjectSectionCreateRequest): NativeHostResult<NativeProjectSectionCreateResult> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded Project Section request is required');
            const section = useTaskStore.getState()._allSections.find((row) => row.id === request.requestId);
            return section && !section.deletedAt && !('purgedAt' in section)
                && section.projectId === request.projectId && section.title === request.title.trim()
                ? { ok: true, value: result(request) }
                : fail('STALE_REVISION', 'Project Section creation outcome is unknown');
        },

        prepareProjectSectionCreate(input: NativeProjectSectionCreateRequest): NativeHostResult<NativeProjectSectionCreatePreparation> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded Project Section request is required');
            const state = useTaskStore.getState();
            const project = state._projectsById.get(request.projectId);
            if (!project || project.deletedAt || project.purgedAt || project.status === 'archived')
                return fail('STALE_REVISION', 'Project is unavailable for Section creation');
            if (state._allSections.some((section) => section.id === request.requestId))
                return fail('STALE_REVISION', 'Project Section ID already exists');
            const device = ensureDeviceId(state.settings);
            const preparedAt = new Date().toISOString();
            const orderMax = projectSectionOrderMax(state._allSections, request.projectId);
            const prepared: NativePreparedProjectSectionCreate = { version: 1, request,
                scope: { project, orderMax },
                section: buildNewSection({ id: request.requestId, projectId: request.projectId,
                    title: request.title, orderMax, deviceId: device.deviceId, now: preparedAt }),
                deviceIdBefore: state.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                preparedAt, result: result(request) };
            const frozen = detach<NativePreparedProjectSectionCreate>(JSON.parse(JSON.stringify(prepared)));
            return frozen && readPrepared({ request, prepared: frozen })
                ? { ok: true, value: { kind: 'prepared', prepared: frozen } }
                : fail('INVALID_INPUT', 'Project Section creation exceeds the bounded journal');
        },

        validatePreparedProjectSectionCreate(input: { request: NativeProjectSectionCreateRequest;
            prepared: NativePreparedProjectSectionCreate }): NativeHostResult<NativeProjectSectionCreateResult> {
            const prepared = readPrepared(input);
            return prepared ? { ok: true, value: prepared.result }
                : fail('INVALID_INPUT', 'Prepared Project Section request or journal does not match');
        },

        async commitPreparedProjectSectionCreate(input: { request: NativeProjectSectionCreateRequest;
            prepared: NativePreparedProjectSectionCreate }): Promise<NativeHostResult<NativeProjectSectionCreateResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const prepared = readPrepared(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared Project Section request or journal does not match');
            const applied = await useTaskStore.getState().commitPreparedProjectSectionCreate(prepared);
            if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Prepared Project Section conflicts with current data');
            try {
                if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
            } catch (error) { return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error)); }
            const saved = await deps.save();
            return saved.ok ? { ok: true, value: prepared.result } : saved;
        },
    };
}
