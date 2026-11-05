import type { NativeHostResult } from './native-host-contract';
import { formatI18nTemplate } from './i18n';
import { taskEditValuesEqual as same } from './json-value-equality';
import { logInfo } from './logger';
import { detach, exact, record } from './native-host-contract-project-shared';
import { revisionOf } from './native-request-receipts';
import { createProjectToSectionPreviewer, getProjectToSectionEligibility, planProjectToSection,
    type PreparedProjectToSection, type ProjectToSectionBlockReason } from './project-to-section';
import { ensureDeviceId } from './store-helpers';
import { useTaskStore } from './store';
import { getProjectAccentColor } from './task-accent-color';

export type NativeProjectToSectionRequest = { requestId: string; projectId: string; projectRevision: string;
    destinationProjectId: string; destinationRevision: string; title: string };
export type NativeProjectToSectionResult = { sectionId: string; destinationProjectId: string; message: string; undoLabel: string };
export type NativePreparedProjectToSection = { version: 1; kind: 'projectToSection';
    request: NativeProjectToSectionRequest; command: PreparedProjectToSection; result: NativeProjectToSectionResult };
export type NativeProjectToSectionEnvelope = { request: NativeProjectToSectionRequest; prepared: NativePreparedProjectToSection };
export type NativeProjectToSectionUndoRequest = { requestId: string; convertRequestId: string };
export type NativePreparedProjectToSectionUndo = { version: 1; kind: 'projectToSectionUndo';
    request: NativeProjectToSectionUndoRequest; convert: NativeProjectToSectionEnvelope; result: { id: string } };
export type NativeProjectToSectionUndoEnvelope = { request: NativeProjectToSectionUndoRequest; prepared: NativePreparedProjectToSectionUndo };
export type NativeProjectToSectionDestination = { id: string; title: string; revision: string;
    summary: string; areaLine: string; color: string | null };
export type NativeProjectToSectionOptions = { projectId: string; projectRevision: string; blockedMessage: string | null;
    sequentialMessage: string | null; notesMessage: string | null; defaultTitle: string;
    destinations: NativeProjectToSectionDestination[] };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const text = (value: unknown, limit = 500): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });

const readRequest = (value: unknown): NativeProjectToSectionRequest | null => {
    const input = detach<Record<string, unknown>>(value);
    return input && exact(input, ['requestId', 'projectId', 'projectRevision', 'destinationProjectId', 'destinationRevision', 'title'])
        && typeof input.requestId === 'string' && UUID.test(input.requestId)
        && text(input.projectId) && text(input.projectRevision) && text(input.destinationProjectId)
        && text(input.destinationRevision) && input.projectId !== input.destinationProjectId
        && text(input.title, 100_000) && Boolean(input.title.trim())
        ? input as NativeProjectToSectionRequest : null;
};

const readEnvelope = (value: unknown): NativeProjectToSectionEnvelope | null => {
    const input = detach<Record<string, unknown>>(value);
    if (!input || !exact(input, ['request', 'prepared']) || !record(input.prepared)) return null;
    const request = readRequest(input.request);
    const raw = input.prepared;
    if (!request || !exact(raw, ['version', 'kind', 'request', 'command', 'result']) || raw.version !== 1
        || raw.kind !== 'projectToSection' || !same(raw.request, request) || !record(raw.command)
        || !record(raw.result) || !exact(raw.result, ['sectionId', 'destinationProjectId', 'message', 'undoLabel'])
        || raw.result.sectionId !== request.requestId || raw.result.destinationProjectId !== request.destinationProjectId
        || !text(raw.result.message, 512) || !text(raw.result.undoLabel, 512)) return null;
    try {
        const command = raw.command as unknown as PreparedProjectToSection;
        if (command.sourceProjectId !== request.projectId || command.destinationProjectId !== request.destinationProjectId
            || command.sectionId !== request.requestId || revisionOf(command.source.before) !== request.projectRevision
            || revisionOf(command.destination) !== request.destinationRevision
            || !Array.isArray(command.sourceSections) || !Array.isArray(command.destinationSections)
            || !Array.isArray(command.sourceTasks) || !Array.isArray(command.destinationTasks)) return null;
        const planned = planProjectToSection({
            _allProjects: [command.source.before, command.destination],
            _allSections: [...command.sourceSections, ...command.destinationSections],
            _allTasks: [...command.sourceTasks, ...command.destinationTasks],
            settings: {},
        }, request.projectId, request.destinationProjectId, request.title, request.requestId,
        command.preparedAt, command.deviceIdBefore, command.deviceIdToInitialize);
        return planned.ok && same(planned.command, command) ? input as unknown as NativeProjectToSectionEnvelope : null;
    } catch { return null; }
};

const readUndoRequest = (value: unknown): NativeProjectToSectionUndoRequest | null => {
    const input = detach<Record<string, unknown>>(value);
    return input && exact(input, ['requestId', 'convertRequestId'])
        && typeof input.requestId === 'string' && UUID.test(input.requestId)
        && typeof input.convertRequestId === 'string' && UUID.test(input.convertRequestId)
        && input.requestId !== input.convertRequestId ? input as NativeProjectToSectionUndoRequest : null;
};

const readUndoEnvelope = (value: unknown): NativeProjectToSectionUndoEnvelope | null => {
    const input = detach<Record<string, unknown>>(value);
    if (!input || !exact(input, ['request', 'prepared']) || !record(input.prepared)) return null;
    const request = readUndoRequest(input.request);
    const raw = input.prepared;
    if (!request || !exact(raw, ['version', 'kind', 'request', 'convert', 'result']) || raw.version !== 1
        || raw.kind !== 'projectToSectionUndo' || !same(raw.request, request)) return null;
    const convert = readEnvelope(raw.convert);
    return convert && convert.request.requestId === request.convertRequestId
        && record(raw.result) && exact(raw.result, ['id']) && raw.result.id === convert.request.projectId
        ? input as unknown as NativeProjectToSectionUndoEnvelope : null;
};

export function createProjectToSectionMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    t: () => (key: string) => string;
}) {
    const blocked = (reason: ProjectToSectionBlockReason) => deps.t()(`projects.convertBlocked.${reason}`);
    const failure = (reason: 'conflict' | 'save-failed' | 'invalid', prefix: 'convertFailure' | 'convertUndoFailure') =>
        fail(reason === 'save-failed' ? 'SAVE_FAILED' : reason === 'invalid' ? 'INVALID_INPUT' : 'STALE_REVISION',
            deps.t()(`projects.${prefix}.${reason}`));
    const confirmed = <T,>(operation: 'convert' | 'undo', count: number, value: T): NativeHostResult<T> => {
        try { logInfo('Native project to section conversion confirmed', { scope: 'native-host', category: 'storage', force: true,
            context: { releaseCheck: 'v1.3.9/ios-project-to-section', operation, count, outcome: 'confirmed' } }); }
        catch {}
        return { ok: true, value };
    };
    return {
        getProjectToSectionConversionOptions(input: { projectId: string; projectRevision: string }): NativeHostResult<NativeProjectToSectionOptions> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const query = detach<Record<string, unknown>>(input);
            if (!query || !exact(query, ['projectId', 'projectRevision']) || !text(query.projectId) || !text(query.projectRevision))
                return fail('INVALID_INPUT', 'A bounded project and revision are required');
            const state = useTaskStore.getState();
            const source = state._projectsById.get(query.projectId);
            if (!source || source.deletedAt || source.purgedAt || revisionOf(source) !== query.projectRevision)
                return fail('STALE_REVISION', 'Project changed since the detail was read');
            const t = deps.t();
            const eligible = getProjectToSectionEligibility(state, source.id);
            const preview = createProjectToSectionPreviewer(state, source.id);
            const areas = new Map(state._allAreas.map((area) => [area.id, area]));
            const destinations = eligible.ok ? state._allProjects.flatMap((project) => {
                const shown = preview(project.id);
                if (!shown.ok) return [];
                const area = project.areaId ? areas.get(project.areaId) : undefined;
                return [{ id: project.id, title: project.title, revision: revisionOf(project),
                    summary: formatI18nTemplate(t('projects.convertSummary'), { count: shown.taskCount,
                        completed: shown.completedCount, archived: shown.archivedCount,
                        source: shown.sourceTitle, destination: shown.destinationTitle }),
                    areaLine: formatI18nTemplate(t('projects.convertArea'),
                        { area: area && !area.deletedAt ? area.name : t('projects.noArea') }),
                    color: getProjectAccentColor(project, areas) ?? null }];
            }) : [];
            const options = detach<NativeProjectToSectionOptions>({ projectId: source.id, projectRevision: query.projectRevision,
                blockedMessage: eligible.ok ? null : blocked(eligible.reason),
                sequentialMessage: source.isSequential ? blocked('destination-section-sequence') : null,
                notesMessage: source.supportNotes ? t('projects.convertNotes') : null,
                defaultTitle: source.title, destinations });
            return options ? { ok: true, value: options } : fail('INVALID_INPUT', 'Project conversion options exceed the native bound');
        },
        prepareProjectToSection(input: NativeProjectToSectionRequest): NativeHostResult<{ kind: 'prepared'; prepared: NativePreparedProjectToSection }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded project conversion request is required');
            const state = useTaskStore.getState();
            const source = state._projectsById.get(request.projectId);
            const destination = state._projectsById.get(request.destinationProjectId);
            if (!source || revisionOf(source) !== request.projectRevision)
                return fail('STALE_REVISION', deps.t()('projects.convertFailure.conflict'));
            if (!destination || revisionOf(destination) !== request.destinationRevision)
                return fail('STALE_REVISION', deps.t()('projects.convertFailure.conflict'));
            if (state._projectsById.has(request.requestId) || state._tasksById.has(request.requestId)
                || state._allSections.some((section) => section.id === request.requestId))
                return fail('INVALID_INPUT', 'Request identity is already in use');
            const device = ensureDeviceId(state.settings);
            const planned = planProjectToSection(state, request.projectId, request.destinationProjectId, request.title,
                request.requestId, new Date().toISOString(), state.settings.deviceId ?? null, device.updated ? device.deviceId : null);
            if (!planned.ok) return fail('INVALID_INPUT', blocked(planned.reason));
            const prepared = detach<NativePreparedProjectToSection>({ version: 1, kind: 'projectToSection', request,
                command: planned.command, result: { sectionId: request.requestId, destinationProjectId: request.destinationProjectId,
                    message: deps.t()('projects.convertSuccess'), undoLabel: deps.t()('common.undo') } });
            return prepared && readEnvelope({ request, prepared }) ? { ok: true, value: { kind: 'prepared', prepared } }
                : fail('INVALID_INPUT', 'Project conversion exceeds the bounded native journal');
        },
        validatePreparedProjectToSection(input: NativeProjectToSectionEnvelope): NativeHostResult<NativeProjectToSectionResult> {
            const envelope = readEnvelope(input);
            return envelope ? { ok: true, value: envelope.prepared.result } : fail('INVALID_INPUT', 'Prepared project conversion does not match');
        },
        async commitPreparedProjectToSection(input: NativeProjectToSectionEnvelope): Promise<NativeHostResult<NativeProjectToSectionResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const envelope = readEnvelope(input);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared project conversion does not match');
            const applied = await useTaskStore.getState().convertProjectToSection(envelope.prepared.command);
            if (!applied.success) return failure(applied.reason, 'convertFailure');
            const saved = await deps.save();
            return saved.ok ? confirmed('convert', envelope.prepared.command.tasks.length, envelope.prepared.result) : saved;
        },
        prepareProjectToSectionUndo(input: { request: NativeProjectToSectionUndoRequest; convert: NativeProjectToSectionEnvelope }): NativeHostResult<{ kind: 'prepared'; prepared: NativePreparedProjectToSectionUndo }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const value = detach<Record<string, unknown>>(input);
            const request = value && exact(value, ['request', 'convert']) ? readUndoRequest(value.request) : null;
            const convert = request ? readEnvelope(value!.convert) : null;
            if (!request || !convert || convert.request.requestId !== request.convertRequestId)
                return fail('INVALID_INPUT', deps.t()('projects.convertUndoFailure.invalid'));
            const prepared: NativePreparedProjectToSectionUndo = { version: 1, kind: 'projectToSectionUndo', request,
                convert, result: { id: convert.request.projectId } };
            return readUndoEnvelope({ request, prepared }) ? { ok: true, value: { kind: 'prepared', prepared } }
                : fail('INVALID_INPUT', 'Project conversion Undo exceeds the bounded native journal');
        },
        validatePreparedProjectToSectionUndo(input: NativeProjectToSectionUndoEnvelope): NativeHostResult<{ id: string }> {
            const envelope = readUndoEnvelope(input);
            return envelope ? { ok: true, value: envelope.prepared.result } : fail('INVALID_INPUT', 'Prepared project conversion Undo does not match');
        },
        async commitPreparedProjectToSectionUndo(input: NativeProjectToSectionUndoEnvelope): Promise<NativeHostResult<{ id: string }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const envelope = readUndoEnvelope(input);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared project conversion Undo does not match');
            const command = envelope.prepared.convert.prepared.command;
            const restored = await useTaskStore.getState().undoProjectToSection(command);
            if (!restored.success) return failure(restored.reason, 'convertUndoFailure');
            const saved = await deps.save();
            return saved.ok ? confirmed('undo', command.tasks.length, envelope.prepared.result) : saved;
        },
    };
}
