import type { NativeHostResult } from './native-host-contract';
import { taskEditValuesEqual } from './json-value-equality';
import { detach, exact, iso, record, validProject } from './native-host-contract-project-shared';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { ensureDeviceId } from './store-helpers';
import { useTaskStore } from './store';
import { logProjectFlowModeSaved, projectFlowEffect, projectFlowModeEffect, projectFlowSections, sameProjectSqliteRow } from './store-projects/project-actions';
import { validSection } from './native-host-contract-project-section-rename';
import { getProjectFlowMode } from './task-utils';
import { getProjectSectionsForView } from './project-utils';
import { sameSectionSqliteRow, sectionFlowEffect } from './store-projects/section-actions';
import { logInfo } from './logger';
import type { PreparedProjectFlow, ProjectFlowAction } from './store-types';
import type { Project, ProjectFlowMode, Section } from './types';

export type NativeProjectFlowToken = { title: string; status: Project['status'];
    isSequential: boolean | null; sequentialScope: 'project' | 'section' | null;
    rev: number | null; revBy: string | null; updatedAt: string };
export type NativeProjectFlowRequest = { requestId: string; projectId: string;
    action: ProjectFlowAction; expected: NativeProjectFlowToken };
export type NativeProjectFlowResult = { id: string; isSequential: boolean;
    sequentialScope: 'project' | 'section' | null };
export type NativePreparedProjectFlow = PreparedProjectFlow & { request: NativeProjectFlowRequest;
    result: NativeProjectFlowResult };
export type NativeProjectFlowPreparation = { kind: 'noop'; result: NativeProjectFlowResult }
    | { kind: 'blocked'; result: { blocked: '' } }
    | { kind: 'prepared'; prepared: NativePreparedProjectFlow };
type NativeSectionFlowPreparation = Exclude<NativeProjectFlowPreparation, { kind: 'prepared' }>
    | { kind: 'prepared'; prepared: Extract<NativePreparedProjectFlow, { version: 3 }> };
type NativeProjectOnlyFlowRequest = NativeProjectFlowRequest & {
    action: Exclude<ProjectFlowAction, { kind: 'sectionFlow' }> };
type NativeProjectOnlyFlowPreparation = Exclude<NativeProjectFlowPreparation, { kind: 'prepared' }>
    | { kind: 'prepared'; prepared: Exclude<NativePreparedProjectFlow, { version: 3 }> };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const same = taskEditValuesEqual;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const token = (project: Project): NativeProjectFlowToken => ({
    title: project.title, status: project.status,
    isSequential: project.isSequential ?? null, sequentialScope: project.sequentialScope ?? null,
    rev: project.rev ?? null, revBy: project.revBy ?? null, updatedAt: project.updatedAt,
});
const result = (project: Project): NativeProjectFlowResult => ({
    id: project.id, isSequential: project.isSequential ?? false,
    sequentialScope: project.sequentialScope ?? null,
});

const readRequest = (value: unknown): NativeProjectFlowRequest | null => {
    const input = detach<Record<string, unknown>>(value);
    if (!input || !exact(input, ['requestId', 'projectId', 'action', 'expected'])
        || typeof input.requestId !== 'string' || !UUID.test(input.requestId)
        || typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 500
        || !record(input.action) || !record(input.expected)
        || !exact(input.expected, ['title', 'status', 'isSequential', 'sequentialScope',
            'rev', 'revBy', 'updatedAt'])) return null;
    const action = input.action;
    if (!(action.kind === 'toggleType' && exact(action, ['kind'])
        || action.kind === 'setScope' && exact(action, ['kind', 'scope'])
            && (action.scope === 'project' || action.scope === 'section')
        || action.kind === 'flowMode' && exact(action, ['kind', 'mode'])
            && (action.mode === 'parallel' || action.mode === 'sequential' || action.mode === 'perSection')
        || action.kind === 'sectionFlow' && exact(action, ['kind', 'sectionId', 'sequential', 'expectedSection'])
            && typeof action.sectionId === 'string' && Boolean(action.sectionId) && action.sectionId.length <= 500
            && typeof action.sequential === 'boolean'
            && validSection(action.expectedSection, action.sectionId, input.projectId))) return null;
    const expected = input.expected;
    return typeof expected.title === 'string' && expected.title.length <= 100_000
        && ['active', 'someday', 'waiting', 'archived'].includes(String(expected.status))
        && (expected.isSequential === null || typeof expected.isSequential === 'boolean')
        && (expected.sequentialScope === null || expected.sequentialScope === 'project'
            || expected.sequentialScope === 'section')
        && (expected.rev === null || typeof expected.rev === 'number'
            && Number.isSafeInteger(expected.rev) && expected.rev >= 0)
        && (expected.revBy === null || typeof expected.revBy === 'string' && expected.revBy.length <= 500)
        && iso(expected.updatedAt) ? input as NativeProjectFlowRequest : null;
};


const readPrepared = (value: unknown): NativePreparedProjectFlow | null => {
    const envelope = detach<Record<string, unknown>>(value);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readRequest(envelope.request);
    const raw = envelope.prepared;
    const expectedVersion = request?.action.kind === 'sectionFlow' ? 3 : request?.action.kind === 'flowMode' ? 2 : 1;
    if (!request || !exact(raw, ['version', 'request', 'scope', 'effect', 'deviceIdBefore',
        'deviceIdToInitialize', 'updateAt', 'result']) || raw.version !== expectedVersion || !same(raw.request, request)
        || !record(raw.scope) || !exact(raw.scope, raw.version === 3 ? ['project', 'section']
            : raw.version === 1 ? ['project'] : ['project', 'sections']) || !record(raw.scope.project)
        || !record(raw.effect) || !exact(raw.effect, raw.version === 3 ? ['section']
            : raw.version === 1 ? ['project'] : ['project', 'sections'])
        || (raw.version === 3 ? !record(raw.effect.section) || !exact(raw.effect.section, ['before', 'after'])
            : !record(raw.effect.project) || !exact(raw.effect.project, ['before', 'after']))
        || raw.version === 2 && (!Array.isArray(raw.scope.sections) || !Array.isArray(raw.effect.sections)
            || raw.effect.sections.some((pair) => !record(pair) || !exact(pair, ['before', 'after'])))
        || !(raw.deviceIdBefore === null || typeof raw.deviceIdBefore === 'string' && Boolean(raw.deviceIdBefore))
        || (raw.deviceIdBefore === null
            ? typeof raw.deviceIdToInitialize !== 'string' || !UUID.test(raw.deviceIdToInitialize)
            : raw.deviceIdToInitialize !== null)
        || !iso(raw.updateAt) || !record(raw.result)
        || !exact(raw.result, ['id', 'isSequential', 'sequentialScope'])) return null;
    try {
        const prepared = raw as unknown as NativePreparedProjectFlow;
        const before = prepared.scope.project;
        if (!validProject(before, request.projectId) || before.status === 'archived'
            || !same(token(before), request.expected)) return null;
        if (prepared.version === 3) {
            const action = prepared.request.action;
            const section = prepared.scope.section;
            if (getProjectFlowMode(before) !== 'perSection'
                || !validSection(section, action.sectionId, request.projectId) || section.deletedAt
                || !validSection(prepared.effect.section.before, action.sectionId, request.projectId)
                || !validSection(prepared.effect.section.after, action.sectionId, request.projectId)
                || prepared.effect.section.after.deletedAt
                || !same(section, action.expectedSection) || !same(section, prepared.effect.section.before)) return null;
            const planned = sectionFlowEffect(section, action.sequential,
                prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!, prepared.updateAt);
            return planned && same(planned, prepared.effect) && same(result(before), prepared.result)
                && !sameSectionSqliteRow(section, planned.section.after) ? prepared : null;
        }
        if (!validProject(prepared.effect.project.before, request.projectId)
            || !validProject(prepared.effect.project.after, request.projectId)
            || !same(before, prepared.effect.project.before)) return null;
        if (prepared.version === 2) {
            const ids = new Set<string>();
            if (prepared.scope.sections.some((section) => {
                if (!record(section) || typeof section.id !== 'string'
                    || !section.id || section.id.length > 500 || ids.has(section.id)
                    || !validSection(section, section.id, request.projectId)) return true;
                ids.add(section.id);
                return false;
            })
                || !same(prepared.scope.sections, projectFlowSections(request.projectId, prepared.scope.sections))) return null;
        }
        const planned = prepared.version === 2
            ? projectFlowModeEffect(before, prepared.scope.sections, prepared.request.action.mode,
                prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!, prepared.updateAt)
            : projectFlowEffect(before, prepared.request.action,
                prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!, prepared.updateAt);
        return planned && same(planned, prepared.effect)
            && same(result(planned.project.after), prepared.result)
            && !sameProjectSqliteRow(before, planned.project.after) ? prepared : null;
    } catch { return null; }
};

export function createProjectFlowMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    revision: () => string;
}) {
    const getProjectFlowOptions = (input: { projectId: string; flowMode?: true }): NativeHostResult<{ revision: string;
        project: { id: string } & NativeProjectFlowToken; canChange: boolean; flowMode?: ProjectFlowMode }> => {
        const ready = deps.readiness();
        if (!ready.ok) return ready;
        if (!input || typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 500)
            return fail('INVALID_INPUT', 'A Project ID is required');
        const project = useTaskStore.getState()._projectsById.get(input.projectId);
        if (!project || project.deletedAt || project.purgedAt)
            return fail('STALE_REVISION', 'Project is unavailable; refresh before changing flow');
        const value = { revision: deps.revision(), project: { id: project.id, ...token(project) },
            canChange: project.status !== 'archived', ...(input.flowMode === true ? { flowMode: getProjectFlowMode(project) } : {}) };
        return isNativeJsonWithinBytes(value) ? { ok: true, value }
            : fail('INVALID_INPUT', 'Project flow options exceed the bounded native response');
    };

    function prepareProjectFlow(input: NativeProjectOnlyFlowRequest): NativeHostResult<NativeProjectOnlyFlowPreparation>;
    function prepareProjectFlow(input: NativeProjectFlowRequest & {
        action: Extract<ProjectFlowAction, { kind: 'sectionFlow' }> }): NativeHostResult<NativeSectionFlowPreparation>;
    function prepareProjectFlow(input: NativeProjectFlowRequest): NativeHostResult<NativeProjectFlowPreparation>;
    function prepareProjectFlow(input: NativeProjectFlowRequest): NativeHostResult<NativeProjectFlowPreparation> {
        const ready = deps.readiness();
        if (!ready.ok) return ready;
        const request = readRequest(input);
        if (!request) return fail('INVALID_INPUT', 'A bounded Project flow request is required');
        const state = useTaskStore.getState();
        const project = state._projectsById.get(request.projectId);
        if (!project || project.deletedAt || project.purgedAt || !same(token(project), request.expected))
            return fail('STALE_REVISION', 'Project changed; refresh before changing flow');
        if (project.status === 'archived'
            || request.action.kind === 'setScope' && !project.isSequential
            || request.action.kind === 'sectionFlow' && getProjectFlowMode(project) !== 'perSection')
            return { ok: true, value: { kind: 'blocked', result: { blocked: '' } } };
        if (request.action.kind === 'setScope' && project.sequentialScope === request.action.scope)
            return { ok: true, value: { kind: 'noop', result: result(project) } };
        if (request.action.kind === 'flowMode' && getProjectFlowMode(project) === request.action.mode)
            return { ok: true, value: { kind: 'noop', result: result(project) } };
        let selectedSection: Section | undefined;
        if (request.action.kind === 'sectionFlow') {
            const action = request.action;
            selectedSection = state._allSections.find((section) => section.id === action.sectionId);
            if (!selectedSection || selectedSection.projectId !== project.id || selectedSection.deletedAt
                || !same(selectedSection, action.expectedSection) || !sameSectionSqliteRow(selectedSection, action.expectedSection))
                return fail('STALE_REVISION', 'Project section changed; refresh before changing flow');
            if ((selectedSection.isSequential === true) === action.sequential)
                return { ok: true, value: { kind: 'noop', result: result(project) } };
        }
        const device = ensureDeviceId(state.settings);
        const updateAt = new Date().toISOString();
        const metadata = {
            deviceIdBefore: state.settings.deviceId ?? null,
            deviceIdToInitialize: device.updated ? device.deviceId : null,
            updateAt };
        let prepared: NativePreparedProjectFlow;
        if (request.action.kind === 'sectionFlow') {
            if (!selectedSection) return fail('STALE_REVISION', 'Project section is unavailable');
            const effect = sectionFlowEffect(selectedSection, request.action.sequential, device.deviceId, updateAt);
            if (!effect) return fail('INVALID_INPUT', 'Project section flow action has no prepared effect');
            prepared = { version: 3, request: { ...request, action: request.action },
                scope: { project, section: selectedSection }, effect, ...metadata, result: result(project) };
        } else if (request.action.kind === 'flowMode') {
            const sections = projectFlowSections(project.id, state._allSections);
            const effect = projectFlowModeEffect(project, sections, request.action.mode, device.deviceId, updateAt);
            if (!effect) return fail('INVALID_INPUT', 'Project flow action has no prepared effect');
            prepared = { version: 2, request: { ...request, action: request.action },
                scope: { project, sections }, effect, ...metadata, result: result(effect.project.after) };
        } else {
            const effect = projectFlowEffect(project, request.action, device.deviceId, updateAt);
            if (!effect) return fail('INVALID_INPUT', 'Project flow action has no prepared effect');
            prepared = { version: 1, request: { ...request, action: request.action },
                scope: { project }, effect, ...metadata, result: result(effect.project.after) };
        }
        const frozen = detach<NativePreparedProjectFlow>(JSON.parse(JSON.stringify(prepared)));
        return frozen && readPrepared({ request, prepared: frozen })
            ? { ok: true, value: { kind: 'prepared', prepared: frozen } }
            : fail('INVALID_INPUT', 'Project flow exceeds the bounded journal');
    }

    return {
        getProjectFlowOptions,

        getProjectFlowModeOptions(input: { projectId: string }): NativeHostResult<{ revision: string;
            project: { id: string } & NativeProjectFlowToken; canChange: boolean; mode: ProjectFlowMode }> {
            const options = getProjectFlowOptions(input);
            if (!options.ok) return options;
            const project = useTaskStore.getState()._projectsById.get(input.projectId);
            if (!project) return fail('STALE_REVISION', 'Project is unavailable; refresh before changing flow');
            const value = { ...options.value, mode: getProjectFlowMode(project) };
            return isNativeJsonWithinBytes(value) ? { ok: true, value }
                : fail('INVALID_INPUT', 'Project flow mode options exceed the bounded native response');
        },

        getProjectSectionFlowOptions(input: { projectId: string }): NativeHostResult<{ revision: string;
            project: { id: string } & NativeProjectFlowToken; canChange: boolean;
            sections: Array<{ id: string; title: string; sequential: boolean; token: Section }> }> {
            if (!record(input) || !exact(input, ['projectId'])) return fail('INVALID_INPUT', 'A Project ID is required');
            const options = getProjectFlowOptions(input);
            if (!options.ok) return options;
            const state = useTaskStore.getState();
            const project = state._projectsById.get(input.projectId);
            if (!project) return fail('STALE_REVISION', 'Project is unavailable');
            const sections = getProjectSectionsForView(project, state.sections, state._allSections)
                .filter((section) => !section.deletedAt);
            if (sections.some((section) => !validSection(section, section.id, project.id)))
                return fail('STALE_REVISION', 'Project sections are unavailable');
            const value = { ...options.value, canChange: options.value.canChange && getProjectFlowMode(project) === 'perSection',
                sections: sections.map((section) => ({ id: section.id, title: section.title,
                    sequential: section.isSequential === true, token: section })) };
            const frozen = detach<typeof value>(JSON.parse(JSON.stringify(value)));
            return frozen ? { ok: true, value: frozen } : fail('INVALID_INPUT', 'Project section flow options exceed the bounded native response');
        },

        probeProjectFlowOutcome(input: NativeProjectFlowRequest): NativeHostResult<NativeProjectFlowResult> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            return readRequest(input) ? fail('STALE_REVISION', 'Project flow outcome is unknown; refresh before trying again')
                : fail('INVALID_INPUT', 'A bounded Project flow request is required');
        },

        prepareProjectFlow,

        validatePreparedProjectFlow(input: { request: NativeProjectFlowRequest;
            prepared: NativePreparedProjectFlow }): NativeHostResult<NativeProjectFlowResult> {
            const prepared = readPrepared(input);
            return prepared ? { ok: true, value: prepared.result }
                : fail('INVALID_INPUT', 'Prepared Project flow request or journal does not match');
        },

        async commitPreparedProjectFlow(input: { request: NativeProjectFlowRequest;
            prepared: NativePreparedProjectFlow }): Promise<NativeHostResult<NativeProjectFlowResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const prepared = readPrepared(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared Project flow request or journal does not match');
            const applied = await useTaskStore.getState().commitPreparedProjectFlow(prepared);
            if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Prepared Project flow conflicts with current data');
            try {
                if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
            } catch (error) { return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error)); }
            const saved = await deps.save();
            if (saved.ok && prepared.version === 2)
                logProjectFlowModeSaved(prepared.request.action.mode, prepared.effect.sections.length,
                    'v1.3.9/ios-project-flow-mode');
            if (saved.ok && prepared.version === 3) logInfo('Native section flow mode saved', {
                scope: 'store', category: 'storage', context: { releaseCheck: 'v1.3.9/ios-section-flow-mode',
                    enabled: prepared.request.action.sequential, sectionCount: 1 },
            });
            return saved.ok ? { ok: true, value: prepared.result } : saved;
        },
    };
}
