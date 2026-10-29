import type { NativeHostResult } from './native-host-contract';
import { detach, exact, iso, record, validProject } from './native-host-contract-project-shared';
import { validSection } from './native-host-contract-project-section-rename';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { getProjectSectionsForView } from './project-utils';
import { ensureDeviceId } from './store-helpers';
import { getProjectFlowMode } from './task-utils';
import { useTaskStore } from './store';
import { projectSectionOrderEffect } from './store-projects/ordering-actions';
import { sameSectionDeleteJson, sameSectionSqliteRow } from './store-projects/section-actions';
import type { PreparedProjectSectionOrder } from './store-types';
import type { Project, Section } from './types';

export type NativeProjectSectionOrderRequest = PreparedProjectSectionOrder['request'];
export type NativeProjectSectionOrderResult = PreparedProjectSectionOrder['result'];
export type NativePreparedProjectSectionOrder = PreparedProjectSectionOrder & { version: 1 };
export type NativeProjectSectionOrderPreparation = { kind: 'prepared'; prepared: NativePreparedProjectSectionOrder };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const same = sameSectionDeleteJson;
const validParent = (value: unknown, id: string): value is Project => record(value)
    && validProject(Object.fromEntries(Object.entries(value).map(([key, part]) =>
        [key, part === null ? undefined : part])), id);

const nextIdsForMove = (request: NativeProjectSectionOrderRequest): string[] | null => {
    const ids = request.expectedSections.map((row) => row.id);
    const index = ids.indexOf(request.sectionId);
    const neighbor = index + (request.direction === 'up' ? -1 : 1);
    if (index < 0 || neighbor < 0 || neighbor >= ids.length) return null;
    [ids[index], ids[neighbor]] = [ids[neighbor], ids[index]];
    return ids;
};

const readRequest = (value: unknown): NativeProjectSectionOrderRequest | null => {
    const input = detach<Record<string, unknown>>(value);
    if (!input || !exact(input, ['requestId', 'projectId', 'sectionId', 'direction', 'expectedSections'])
        || typeof input.requestId !== 'string' || !UUID.test(input.requestId)
        || typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 500
        || typeof input.sectionId !== 'string' || !input.sectionId || input.sectionId.length > 500
        || (input.direction !== 'up' && input.direction !== 'down')
        || !Array.isArray(input.expectedSections)) return null;
    const sections = input.expectedSections;
    const ids = new Set<string>();
    for (const row of sections) {
        if (!record(row) || typeof row.id !== 'string' || !row.id || row.id.length > 500
            || ids.has(row.id) || !validSection(row, row.id, input.projectId as string)
            || row.deletedAt || 'purgedAt' in row) return null;
        ids.add(row.id);
    }
    return input as NativeProjectSectionOrderRequest;
};

/** Pure journal validation before SQLite or mutable state inspection. */
const readPrepared = (value: unknown): NativePreparedProjectSectionOrder | null => {
    const envelope = detach<Record<string, unknown>>(value);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readRequest(envelope.request);
    const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'request', 'scope', 'effect', 'deviceIdBefore',
        'deviceIdToInitialize', 'preparedAt', 'result']) || raw.version !== 1
        || !same(raw.request, request)
        || !record(raw.scope) || !exact(raw.scope, ['project', 'sections'])
        || !Array.isArray(raw.scope.sections)
        || !record(raw.effect) || !exact(raw.effect, ['sections'])
        || !Array.isArray(raw.effect.sections) || raw.effect.sections.length === 0
        || !(raw.deviceIdBefore === null || typeof raw.deviceIdBefore === 'string' && Boolean(raw.deviceIdBefore))
        || (raw.deviceIdBefore === null
            ? typeof raw.deviceIdToInitialize !== 'string' || !UUID.test(raw.deviceIdToInitialize)
            : raw.deviceIdToInitialize !== null)
        || !iso(raw.preparedAt) || !record(raw.result)
        || !exact(raw.result, ['projectId', 'orderedIds'])
        || raw.result.projectId !== request.projectId || !Array.isArray(raw.result.orderedIds)) return null;
    try {
        const prepared = raw as unknown as NativePreparedProjectSectionOrder;
        const { scope, effect } = prepared;
        if (!validParent(scope.project, request.projectId) || scope.project.status === 'archived'
            || scope.sections.length !== request.expectedSections.length
            || !same(scope.sections, request.expectedSections)
            || scope.sections.some((row) => !validSection(row, row.id, request.projectId)
                || row.deletedAt || 'purgedAt' in row)
            || !same(getProjectSectionsForView(scope.project, scope.sections), scope.sections)) return null;
        const orderedIds = nextIdsForMove(request);
        if (!orderedIds || !same(orderedIds, prepared.result.orderedIds)) return null;
        const planned = projectSectionOrderEffect(scope.sections, orderedIds,
            prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!, prepared.preparedAt);
        if (planned.sections.length === 0 || !same(planned, effect)
            || effect.sections.length !== planned.sections.length) return null;
        return effect.sections.every(({ before, after }) =>
            validSection(before, before.id, request.projectId)
            && validSection(after, after.id, request.projectId)
            && sameSectionSqliteRow(after, planned.sections.find((pair) => pair.after.id === after.id)!.after))
            ? prepared : null;
    } catch { return null; }
};

export function createProjectSectionOrderMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    revision: () => string;
}) {
    return {
        /** iOS reads each row's four keys exactly; Android's Menu read passes [sectionFlow] for each row's flow (#1429). */
        getProjectSectionOrderOptions(input: { projectId: string; sectionFlow?: true }): NativeHostResult<{
            revision: string; project: { id: string; title: string; status: Project['status'] };
            canReorder: boolean; sections: Array<{ id: string; title: string;
                canMoveUp: boolean; canMoveDown: boolean; sequential?: boolean | null }>; token: Section[] }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!input || typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 500)
                return fail('INVALID_INPUT', 'A bounded Project ID is required');
            const state = useTaskStore.getState();
            const parent = state._projectsById.get(input.projectId);
            if (!parent || parent.deletedAt || parent.purgedAt) return fail('STALE_REVISION', 'Project is unavailable');
            const shown = getProjectSectionsForView(parent, state.sections, state._allSections);
            if (shown.some((row) => !validSection(row, row.id, input.projectId)))
                return fail('STALE_REVISION', 'Section scope is invalid');
            const ids = new Set(shown.map((row) => row.id));
            if (ids.size !== shown.length) return fail('STALE_REVISION', 'Section IDs are ambiguous');
            const canReorder = parent.status !== 'archived' && shown.length > 1;
            // RN's manager rows offer each section's flow only while the project is Per section (#1429).
            const perSection = getProjectFlowMode(parent) === 'perSection';
            const value = { revision: deps.revision(),
                project: { id: parent.id, title: parent.title, status: parent.status }, canReorder,
                sections: shown.map((row, index) => ({ id: row.id, title: row.title,
                    canMoveUp: canReorder && index > 0,
                    canMoveDown: canReorder && index < shown.length - 1,
                    ...(input.sectionFlow === true ? { sequential: perSection ? row.isSequential === true : null } : {}) })),
                token: shown };
            const frozen = detach<typeof value>(JSON.parse(JSON.stringify(value)));
            return frozen && isNativeJsonWithinBytes(frozen) ? { ok: true, value: frozen }
                : fail('INVALID_INPUT', 'Section order options exceed the bounded native response');
        },

        probeProjectSectionOrderOutcome(input: NativeProjectSectionOrderRequest): NativeHostResult<NativeProjectSectionOrderResult> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            return readRequest(input) ? fail('STALE_REVISION', 'Section order outcome is unknown')
                : fail('INVALID_INPUT', 'A bounded Section order request is required');
        },

        prepareProjectSectionOrder(input: NativeProjectSectionOrderRequest): NativeHostResult<NativeProjectSectionOrderPreparation> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded Section order request is required');
            const state = useTaskStore.getState();
            const parent = state._projectsById.get(request.projectId);
            if (!parent || parent.deletedAt || parent.purgedAt || parent.status === 'archived')
                return fail('STALE_REVISION', 'Project is unavailable for ordering');
            const live = getProjectSectionsForView(parent,
                state._allSections.filter((row) => !row.deletedAt), state._allSections);
            const ids = new Set(live.map((row) => row.id));
            if (ids.size !== live.length || live.length !== request.expectedSections.length
                || live.some((row, index) => !validSection(row, row.id, request.projectId)
                    || 'purgedAt' in row || !same(row, request.expectedSections[index])
                    || !sameSectionSqliteRow(row, request.expectedSections[index])))
                return fail('STALE_REVISION', 'Section scope changed; refresh before moving');
            const orderedIds = nextIdsForMove(request);
            if (!orderedIds) return fail('STALE_REVISION', 'Section cannot move in that direction');
            const device = ensureDeviceId(state.settings);
            const preparedAt = new Date().toISOString();
            const prepared: NativePreparedProjectSectionOrder = { version: 1, request,
                scope: { project: parent, sections: live },
                effect: projectSectionOrderEffect(live, orderedIds, device.deviceId, preparedAt),
                deviceIdBefore: state.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                preparedAt, result: { projectId: request.projectId, orderedIds } };
            const frozen = detach<NativePreparedProjectSectionOrder>(JSON.parse(JSON.stringify(prepared)));
            return frozen && readPrepared({ request, prepared: frozen })
                ? { ok: true, value: { kind: 'prepared', prepared: frozen } }
                : fail('INVALID_INPUT', 'Section order exceeds the bounded journal');
        },

        validatePreparedProjectSectionOrder(input: { request: NativeProjectSectionOrderRequest;
            prepared: NativePreparedProjectSectionOrder }): NativeHostResult<NativeProjectSectionOrderResult> {
            const prepared = readPrepared(input);
            return prepared ? { ok: true, value: prepared.result }
                : fail('INVALID_INPUT', 'Prepared Section order request or journal does not match');
        },

        async commitPreparedProjectSectionOrder(input: { request: NativeProjectSectionOrderRequest;
            prepared: NativePreparedProjectSectionOrder }): Promise<NativeHostResult<NativeProjectSectionOrderResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const prepared = readPrepared(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared Section order request or journal does not match');
            const applied = await useTaskStore.getState().commitPreparedProjectSectionOrder(prepared);
            if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Prepared Section order conflicts with current data');
            try {
                if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
            } catch (error) { return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error)); }
            const saved = await deps.save();
            return saved.ok ? { ok: true, value: prepared.result } : saved;
        },
    };
}
