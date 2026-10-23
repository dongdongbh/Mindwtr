import type { NativeHostResult } from './native-host-contract';
import { detach, exact, iso, record, validProject } from './native-host-contract-project-shared';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { getProjectSectionsForView } from './project-utils';
import { SECTION_SYNC_FIELD_SCHEMA, sectionToSqliteRow } from './section-sync-schema';
import { ensureDeviceId } from './store-helpers';
import { useTaskStore } from './store';
import { sameSectionDeleteJson, sameSectionSqliteRow, sameTaskSqliteRow,
    sectionDeleteEffect } from './store-projects/section-actions';
import type { PreparedProjectSectionDelete } from './store-types';
import { TASK_SYNC_FIELD_SCHEMA, taskToSqliteRow } from './task-sync-schema';
import type { Project, Section, Task } from './types';

export type NativeProjectSectionDeleteRequest = { requestId: string; projectId: string;
    sectionId: string; expected: Section };
export type NativeProjectSectionDeleteResult = { id: string; projectId: string };
export type NativePreparedProjectSectionDelete = PreparedProjectSectionDelete & { version: 1;
    request: NativeProjectSectionDeleteRequest; result: NativeProjectSectionDeleteResult };
export type NativeProjectSectionDeletePreparation = { kind: 'prepared'; prepared: NativePreparedProjectSectionDelete };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const SECTION_KEYS = new Set(SECTION_SYNC_FIELD_SCHEMA.map((field) => field.name));
const TASK_KEYS = new Set(TASK_SYNC_FIELD_SCHEMA.map((field) => field.name));
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const result = (request: NativeProjectSectionDeleteRequest): NativeProjectSectionDeleteResult =>
    ({ id: request.sectionId, projectId: request.projectId });
const validParent = (value: unknown, id: string): value is Project => record(value)
    && validProject(Object.fromEntries(Object.entries(value).map(([key, part]) =>
        [key, part === null ? undefined : part])), id);
const validSection = (value: unknown, id: string, projectId: string): value is Section => {
    if (!record(value) || Object.keys(value).some((key) => !SECTION_KEYS.has(key as keyof Section))) return false;
    const row = Object.fromEntries(Object.entries(value).map(([key, part]) =>
        [key, part === null ? undefined : part]));
    if (row.id !== id || row.projectId !== projectId || typeof row.title !== 'string'
        || typeof row.order !== 'number' || !Number.isFinite(row.order)
        || !iso(row.createdAt) || !iso(row.updatedAt)
        || (row.description !== undefined && typeof row.description !== 'string')
        || (row.isCollapsed !== undefined && typeof row.isCollapsed !== 'boolean')
        || (row.isSequential !== undefined && typeof row.isSequential !== 'boolean')
        || (row.rev !== undefined && !(typeof row.rev === 'number'
            && Number.isSafeInteger(row.rev) && row.rev >= 0))
        || (row.revBy !== undefined && typeof row.revBy !== 'string')
        || (row.deletedAt !== undefined && !iso(row.deletedAt))
        || (row.deletedAtBeforeProjectArchive !== undefined && !iso(row.deletedAtBeforeProjectArchive))
        || (row.projectArchivedAt !== undefined && !iso(row.projectArchivedAt))) return false;
    try { sectionToSqliteRow(value as unknown as Section); return true; }
    catch { return false; }
};
const validTask = (value: unknown, id: string, sectionId: string | null): value is Task => {
    if (!record(value) || Object.keys(value).some((key) => !TASK_KEYS.has(key as keyof Task))) return false;
    const row = Object.fromEntries(Object.entries(value).map(([key, part]) =>
        [key, part === null ? undefined : part]));
    if (row.id !== id || (sectionId === null ? row.sectionId !== undefined : row.sectionId !== sectionId)
        || typeof row.title !== 'string'
        || !['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived'].includes(String(row.status))
        || !Array.isArray(row.tags) || !row.tags.every((tag) => typeof tag === 'string')
        || !Array.isArray(row.contexts) || !row.contexts.every((context) => typeof context === 'string')
        || !iso(row.createdAt) || !iso(row.updatedAt)
        || (row.rev !== undefined && !(typeof row.rev === 'number'
            && Number.isSafeInteger(row.rev) && row.rev >= 0))
        || (row.revBy !== undefined && typeof row.revBy !== 'string')
        || (row.deletedAt !== undefined && !iso(row.deletedAt))
        || (row.purgedAt !== undefined && !iso(row.purgedAt))) return false;
    try { taskToSqliteRow(value as unknown as Task); return true; }
    catch { return false; }
};

const readRequest = (value: unknown): NativeProjectSectionDeleteRequest | null => {
    const input = detach<Record<string, unknown>>(value);
    if (!input || !exact(input, ['requestId', 'projectId', 'sectionId', 'expected'])
        || typeof input.requestId !== 'string' || !UUID.test(input.requestId)
        || typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 500
        || typeof input.sectionId !== 'string' || !input.sectionId || input.sectionId.length > 500
        || !validSection(input.expected, input.sectionId, input.projectId)) return null;
    return input as NativeProjectSectionDeleteRequest;
};

/** Pure cold-journal validation before storage or mutable state inspection. */
const readPrepared = (value: unknown): NativePreparedProjectSectionDelete | null => {
    const envelope = detach<Record<string, unknown>>(value);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readRequest(envelope.request);
    const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'request', 'scope', 'effect', 'deviceIdBefore',
        'deviceIdToInitialize', 'preparedAt', 'result']) || raw.version !== 1
        || !sameSectionDeleteJson(raw.request, request)
        || !record(raw.scope) || !exact(raw.scope, ['project', 'section', 'tasks'])
        || !Array.isArray(raw.scope.tasks)
        || !record(raw.effect) || !exact(raw.effect, ['section', 'tasks'])
        || !record(raw.effect.section) || !exact(raw.effect.section, ['before', 'after'])
        || !Array.isArray(raw.effect.tasks)
        || !(raw.deviceIdBefore === null || typeof raw.deviceIdBefore === 'string' && Boolean(raw.deviceIdBefore))
        || (raw.deviceIdBefore === null
            ? typeof raw.deviceIdToInitialize !== 'string' || !UUID.test(raw.deviceIdToInitialize)
            : raw.deviceIdToInitialize !== null)
        || !iso(raw.preparedAt) || !record(raw.result) || !exact(raw.result, ['id', 'projectId'])
        || !sameSectionDeleteJson(raw.result, result(request))) return null;
    try {
        const prepared = raw as unknown as NativePreparedProjectSectionDelete;
        const { scope, effect } = prepared;
        if (!validParent(scope.project, request.projectId) || scope.project.status === 'archived'
            || !validSection(scope.section, request.sectionId, request.projectId) || scope.section.deletedAt
            || !validSection(effect.section.before, request.sectionId, request.projectId)
            || !validSection(effect.section.after, request.sectionId, request.projectId)
            || !sameSectionDeleteJson(scope.section, request.expected)
            || !sameSectionDeleteJson(scope.section, effect.section.before)
            || !sameSectionSqliteRow(scope.section, request.expected)
            || scope.tasks.length !== effect.tasks.length) return null;
        const ids = new Set<string>();
        for (let index = 0; index < scope.tasks.length; index += 1) {
            const task = scope.tasks[index];
            const pair = effect.tasks[index];
            if (!record(pair) || !exact(pair, ['before', 'after'])
                || !record(task) || typeof task.id !== 'string' || !task.id || task.id.length > 500
                || ids.has(task.id) || !validTask(task, task.id, request.sectionId)
                || !validTask(pair.before, task.id, request.sectionId)
                || !validTask(pair.after, task.id, null)
                || !sameSectionDeleteJson(task, pair.before)
                || !sameTaskSqliteRow(task, pair.before)) return null;
            ids.add(task.id);
        }
        const planned = sectionDeleteEffect(scope.section, scope.tasks,
            prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!, prepared.preparedAt);
        return sameSectionDeleteJson(planned, effect)
            && sameSectionSqliteRow(planned.section.after, effect.section.after)
            && planned.tasks.every((pair, index) => sameTaskSqliteRow(pair.after, effect.tasks[index].after))
            ? prepared : null;
    } catch { return null; }
};

export function createProjectSectionDeleteMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    revision: () => string;
}) {
    return {
        getProjectSectionDeleteOptions(input: { projectId: string; sectionId: string }): NativeHostResult<{
            revision: string; project: { id: string; title: string; status: Project['status'] };
            section: { id: string; title: string }; canDelete: boolean; token: Section }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!input || typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 500
                || typeof input.sectionId !== 'string' || !input.sectionId || input.sectionId.length > 500)
                return fail('INVALID_INPUT', 'Bounded Project and Section IDs are required');
            const state = useTaskStore.getState();
            const project = state._projectsById.get(input.projectId);
            if (!project || project.deletedAt || project.purgedAt) return fail('STALE_REVISION', 'Project is unavailable');
            const section = getProjectSectionsForView(project, state.sections, state._allSections)
                .find((row) => row.id === input.sectionId);
            if (!section || !validSection(section, input.sectionId, input.projectId))
                return fail('STALE_REVISION', 'Section is unavailable');
            const token = detach<Section>(JSON.parse(JSON.stringify(section)));
            if (!token) return fail('INVALID_INPUT', 'Section exceeds the bounded native response');
            const value = { revision: deps.revision(),
                project: { id: project.id, title: project.title, status: project.status },
                section: { id: section.id, title: section.title },
                canDelete: project.status !== 'archived' && !section.deletedAt,
                token };
            return isNativeJsonWithinBytes(value) ? { ok: true, value }
                : fail('INVALID_INPUT', 'Section delete options exceed the bounded native response');
        },

        probeProjectSectionDeleteOutcome(input: NativeProjectSectionDeleteRequest): NativeHostResult<NativeProjectSectionDeleteResult> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            return readRequest(input) ? fail('STALE_REVISION', 'Section delete outcome is unknown')
                : fail('INVALID_INPUT', 'A bounded Section delete request is required');
        },

        prepareProjectSectionDelete(input: NativeProjectSectionDeleteRequest): NativeHostResult<NativeProjectSectionDeletePreparation> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded Section delete request is required');
            const state = useTaskStore.getState();
            const parent = state._projectsById.get(request.projectId);
            const rows = state._allSections.filter((row) => row.id === request.sectionId);
            const section = rows.length === 1 ? rows[0] : null;
            if (!parent || parent.deletedAt || parent.purgedAt || parent.status === 'archived'
                || !section || section.projectId !== request.projectId || section.deletedAt
                || 'purgedAt' in section || !sameSectionSqliteRow(section, request.expected)
                || !sameSectionDeleteJson(section, request.expected))
                return fail('STALE_REVISION', 'Project or Section changed; refresh before deleting');
            const tasks = state._allTasks.filter((row) => row.sectionId === section.id);
            if (new Set(tasks.map((task) => task.id)).size !== tasks.length)
                return fail('STALE_REVISION', 'Linked Task IDs are ambiguous');
            const device = ensureDeviceId(state.settings);
            const preparedAt = new Date().toISOString();
            const prepared: NativePreparedProjectSectionDelete = { version: 1, request,
                scope: { project: parent, section, tasks },
                effect: sectionDeleteEffect(section, tasks, device.deviceId, preparedAt),
                deviceIdBefore: state.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                preparedAt, result: result(request) };
            const frozen = detach<NativePreparedProjectSectionDelete>(JSON.parse(JSON.stringify(prepared)));
            return frozen && readPrepared({ request, prepared: frozen })
                ? { ok: true, value: { kind: 'prepared', prepared: frozen } }
                : fail('INVALID_INPUT', 'Section delete exceeds the bounded journal');
        },

        validatePreparedProjectSectionDelete(input: { request: NativeProjectSectionDeleteRequest;
            prepared: NativePreparedProjectSectionDelete }): NativeHostResult<NativeProjectSectionDeleteResult> {
            const prepared = readPrepared(input);
            return prepared ? { ok: true, value: prepared.result }
                : fail('INVALID_INPUT', 'Prepared Section delete request or journal does not match');
        },

        async commitPreparedProjectSectionDelete(input: { request: NativeProjectSectionDeleteRequest;
            prepared: NativePreparedProjectSectionDelete }): Promise<NativeHostResult<NativeProjectSectionDeleteResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const prepared = readPrepared(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared Section delete request or journal does not match');
            const applied = await useTaskStore.getState().commitPreparedProjectSectionDelete(prepared);
            if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Prepared Section delete conflicts with current data');
            try {
                if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
            } catch (error) { return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error)); }
            const saved = await deps.save();
            return saved.ok ? { ok: true, value: prepared.result } : saved;
        },
    };
}
