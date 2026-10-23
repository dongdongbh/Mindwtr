import type { NativeHostResult } from './native-host-contract';
import { detach, exact, iso, record, validProject } from './native-host-contract-project-shared';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { getProjectSectionsForView } from './project-utils';
import { SECTION_SYNC_FIELD_SCHEMA, sectionToSqliteRow } from './section-sync-schema';
import { ensureDeviceId } from './store-helpers';
import { useTaskStore } from './store';
import { sameSectionSqliteRow, sectionRenameEffect } from './store-projects/section-actions';
import type { PreparedProjectSectionRename } from './store-types';
import { toStableSyncJson } from './sync-helpers';
import type { Project, Section } from './types';

export type NativeProjectSectionRenameRequest = { requestId: string; projectId: string;
    sectionId: string; title: string; expected: Section };
export type NativeProjectSectionRenameResult = { id: string; projectId: string };
export type NativePreparedProjectSectionRename = PreparedProjectSectionRename & { version: 1;
    request: NativeProjectSectionRenameRequest; result: NativeProjectSectionRenameResult };
export type NativeProjectSectionRenamePreparation = { kind: 'noop'; result: NativeProjectSectionRenameResult }
    | { kind: 'prepared'; prepared: NativePreparedProjectSectionRename };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const SECTION_KEYS = new Set(SECTION_SYNC_FIELD_SCHEMA.map((field) => field.name));
const same = (left: unknown, right: unknown): boolean => toStableSyncJson(left) === toStableSyncJson(right);
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const result = (request: NativeProjectSectionRenameRequest): NativeProjectSectionRenameResult =>
    ({ id: request.sectionId, projectId: request.projectId });
const validParent = (value: unknown, id: string): value is Project => record(value)
    // Legacy optional nulls are validated as absent; the frozen parent stays byte-for-byte raw.
    && validProject(Object.fromEntries(Object.entries(value).map(([key, part]) =>
        [key, part === null ? undefined : part])), id);
export const validSection = (value: unknown, id: string, projectId: string): value is Section => {
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

const readRequest = (value: unknown): NativeProjectSectionRenameRequest | null => {
    const input = detach<Record<string, unknown>>(value);
    if (!input || !exact(input, ['requestId', 'projectId', 'sectionId', 'title', 'expected'])
        || typeof input.requestId !== 'string' || !UUID.test(input.requestId)
        || typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 500
        || typeof input.sectionId !== 'string' || !input.sectionId || input.sectionId.length > 500
        || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 100_000
        || !validSection(input.expected, input.sectionId, input.projectId)) return null;
    return input as NativeProjectSectionRenameRequest;
};

/** Pure cold-journal validation before SQLite or a mutable store check. */
const readPrepared = (value: unknown): NativePreparedProjectSectionRename | null => {
    const envelope = detach<Record<string, unknown>>(value);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readRequest(envelope.request);
    const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'request', 'scope', 'effect', 'deviceIdBefore',
        'deviceIdToInitialize', 'preparedAt', 'result']) || raw.version !== 1 || !same(raw.request, request)
        || !record(raw.scope) || !exact(raw.scope, ['project'])
        || !record(raw.effect) || !exact(raw.effect, ['section']) || !record(raw.effect.section)
        || !exact(raw.effect.section, ['before', 'after'])
        || !(raw.deviceIdBefore === null || typeof raw.deviceIdBefore === 'string' && Boolean(raw.deviceIdBefore))
        || (raw.deviceIdBefore === null
            ? typeof raw.deviceIdToInitialize !== 'string' || !UUID.test(raw.deviceIdToInitialize)
            : raw.deviceIdToInitialize !== null)
        || !iso(raw.preparedAt) || !record(raw.result) || !exact(raw.result, ['id', 'projectId'])
        || !same(raw.result, result(request))) return null;
    try {
        const prepared = raw as unknown as NativePreparedProjectSectionRename;
        const before = prepared.effect.section.before;
        const after = prepared.effect.section.after;
        if (!validParent(prepared.scope.project, request.projectId)
            || prepared.scope.project.status === 'archived'
            || !validSection(before, request.sectionId, request.projectId) || before.deletedAt
            || !validSection(after, request.sectionId, request.projectId) || after.deletedAt
            || !same(before, request.expected) || !sameSectionSqliteRow(before, request.expected)
            || request.title.trim() === before.title) return null;
        const planned = sectionRenameEffect(before, request.title,
            prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!, prepared.preparedAt);
        return same(planned, prepared.effect) && sameSectionSqliteRow(planned.section.after, after)
            && !sameSectionSqliteRow(before, after) ? prepared : null;
    } catch { return null; }
};

export function createProjectSectionRenameMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    revision: () => string;
}) {
    return {
        getProjectSectionRenameOptions(input: { projectId: string; sectionId: string }): NativeHostResult<{
            revision: string; project: { id: string; title: string; status: Project['status'] };
            section: { id: string; title: string }; canRename: boolean; token: Section }> {
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
                canRename: project.status !== 'archived' && !section.deletedAt,
                token };
            return isNativeJsonWithinBytes(value) ? { ok: true, value }
                : fail('INVALID_INPUT', 'Section rename options exceed the bounded native response');
        },

        probeProjectSectionRenameOutcome(input: NativeProjectSectionRenameRequest): NativeHostResult<NativeProjectSectionRenameResult> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            return readRequest(input) ? fail('STALE_REVISION', 'Section rename outcome is unknown')
                : fail('INVALID_INPUT', 'A bounded Section rename request is required');
        },

        prepareProjectSectionRename(input: NativeProjectSectionRenameRequest): NativeHostResult<NativeProjectSectionRenamePreparation> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded Section rename request is required');
            const state = useTaskStore.getState();
            const parent = state._projectsById.get(request.projectId);
            const section = state._allSections.find((row) => row.id === request.sectionId);
            if (!parent || parent.deletedAt || parent.purgedAt || parent.status === 'archived'
                || !section || section.projectId !== request.projectId || section.deletedAt
                || 'purgedAt' in section || !sameSectionSqliteRow(section, request.expected)
                || !same(section, request.expected))
                return fail('STALE_REVISION', 'Project or Section changed; refresh before renaming');
            const title = request.title.trim();
            if (title === section.title) return { ok: true, value: { kind: 'noop', result: result(request) } };
            const device = ensureDeviceId(state.settings);
            const preparedAt = new Date().toISOString();
            const prepared: NativePreparedProjectSectionRename = { version: 1, request,
                scope: { project: parent }, effect: sectionRenameEffect(section, title, device.deviceId, preparedAt),
                deviceIdBefore: state.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                preparedAt, result: result(request) };
            const frozen = detach<NativePreparedProjectSectionRename>(JSON.parse(JSON.stringify(prepared)));
            return frozen && readPrepared({ request, prepared: frozen })
                ? { ok: true, value: { kind: 'prepared', prepared: frozen } }
                : fail('INVALID_INPUT', 'Section rename exceeds the bounded journal');
        },

        validatePreparedProjectSectionRename(input: { request: NativeProjectSectionRenameRequest;
            prepared: NativePreparedProjectSectionRename }): NativeHostResult<NativeProjectSectionRenameResult> {
            const prepared = readPrepared(input);
            return prepared ? { ok: true, value: prepared.result }
                : fail('INVALID_INPUT', 'Prepared Section rename request or journal does not match');
        },

        async commitPreparedProjectSectionRename(input: { request: NativeProjectSectionRenameRequest;
            prepared: NativePreparedProjectSectionRename }): Promise<NativeHostResult<NativeProjectSectionRenameResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const prepared = readPrepared(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared Section rename request or journal does not match');
            const applied = await useTaskStore.getState().commitPreparedProjectSectionRename(prepared);
            if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Prepared Section rename conflicts with current data');
            try {
                if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
            } catch (error) { return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error)); }
            const saved = await deps.save();
            return saved.ok ? { ok: true, value: prepared.result } : saved;
        },
    };
}
