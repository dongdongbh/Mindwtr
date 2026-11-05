import type { NativeHostResult } from './native-host-contract';
import { useTaskStore } from './store';
import type { PreparedTaskPromotion } from './store-types';
import type { Project, Task } from './types';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { isProjectedRecurringTaskId } from './recurrence';
import { isStatusListTaskReadOnly } from './menu-views-model';
import { findSelectableProjectByTitleAndArea } from './project-utils';
import { projectAreaOrderMax } from './store-projects/project-actions';
import { ensureDeviceId, getNextProjectOrder } from './store-helpers';
import { planTaskPromotion } from './store-tasks';
import { taskEditValuesEqual } from './json-value-equality';
import { taskRevisionOf } from './native-request-receipts';
import { checklistProjectBlockReason, prepareChecklistProjectConversion, type ChecklistProjectConversion } from './checklist-project-conversion';
import { generateUUID } from './uuid';
import { logInfo } from './logger';

export type NativeTaskPromotionRequest = { requestId: string; taskId: string; taskRevision: string; title: string;
    expandChecklist?: true };
export type NativeTaskPromotionResult = { id: string; reused: boolean };
export type NativePreparedTaskMove = PreparedTaskPromotion & {
    version: 1; request: NativeTaskPromotionRequest; preparedAt: string; result: NativeTaskPromotionResult;
};
export type NativePreparedChecklistPromotion = {
    version: 2; request: NativeTaskPromotionRequest & { expandChecklist: true };
    conversion: ChecklistProjectConversion; result: { id: string; reused: false };
};
export type NativePreparedTaskPromotion = NativePreparedTaskMove | NativePreparedChecklistPromotion;
export type NativeTaskPromotionPreparation = { kind: 'prepared'; prepared: NativePreparedTaskPromotion };
export type NativeTaskPromotionEnvelope = { request: NativeTaskPromotionRequest; prepared: NativePreparedTaskPromotion };
export type NativeTaskPromotionUndoRequest = { requestId: string; promoteRequestId: string };
export type NativePreparedTaskPromotionUndo = { version: 1; kind: 'taskPromoteUndo';
    request: NativeTaskPromotionUndoRequest; promote: NativeTaskPromotionEnvelope; result: { id: string } };
export type NativeTaskPromotionUndoEnvelope = { request: NativeTaskPromotionUndoRequest; prepared: NativePreparedTaskPromotionUndo };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length
    && keys.every((key) => own(value, key));
const same = taskEditValuesEqual;
const fail = (code: 'INVALID_INPUT' | 'TASK_NOT_FOUND' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });

const detach = <T>(value: unknown): T | null => {
    const valid = (item: unknown, depth: number): boolean => {
        if (depth > 24) return false;
        if (item === null || typeof item === 'string' || typeof item === 'boolean') return true;
        if (typeof item === 'number') return Number.isFinite(item);
        if (Array.isArray(item)) return item.length <= 100_000 && item.every((part) => valid(part, depth + 1));
        return record(item) && (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)
            && Object.keys(item).length <= 128 && Object.entries(item).every(([key, part]) =>
                !['__proto__', 'constructor', 'prototype'].includes(key) && valid(part, depth + 1));
    };
    if (!valid(value, 0) || !isNativeJsonWithinBytes(value)) return null;
    return JSON.parse(JSON.stringify(value)) as T;
};

const readRequest = (value: unknown): NativeTaskPromotionRequest | null => {
    const request = detach<Record<string, unknown>>(value);
    return request && (exact(request, ['requestId', 'taskId', 'taskRevision', 'title'])
        || exact(request, ['requestId', 'taskId', 'taskRevision', 'title', 'expandChecklist']) && request.expandChecklist === true)
        && typeof request.requestId === 'string' && UUID.test(request.requestId)
        && typeof request.taskId === 'string' && Boolean(request.taskId) && request.taskId.length <= 500
        && typeof request.taskRevision === 'string' && Boolean(request.taskRevision) && request.taskRevision.length <= 2000
        && typeof request.title === 'string' && Boolean(request.title.trim()) && request.title.length <= 100_000
        ? request as NativeTaskPromotionRequest : null;
};

/** Rebuild from frozen consulted rows, never live store/clock/translator. */
const expectedPromotion = (prepared: NativePreparedTaskMove) => {
    const { request, sourceBefore, sourceProject, selectedProject, selectedArea } = prepared;
    const projectWitness: Project[] = [];
    if (sourceProject) projectWitness.push(sourceProject);
    if (selectedProject && selectedProject.id !== sourceProject?.id) projectWitness.push(selectedProject);
    if (prepared.projectOrderMax !== null && prepared.projectOrderMax >= 0) {
        projectWitness.push({ id: `native-promotion-order-${request.requestId}`, title: '', status: 'archived',
            areaId: selectedArea?.id, order: prepared.projectOrderMax } as Project);
    }
    const taskWitness: Task[] = [sourceBefore];
    if (prepared.taskOrderMax !== null && prepared.taskOrderMax >= 0) taskWitness.push({
        ...sourceBefore, id: `native-promotion-task-order-${request.requestId}`,
        projectId: prepared.result.id, sectionId: undefined, areaId: undefined,
        order: prepared.taskOrderMax, orderNum: prepared.taskOrderMax, deletedAt: undefined,
    });
    return planTaskPromotion({ sourceTask: sourceBefore, title: request.title,
        allTasks: taskWitness, allProjects: projectWitness, allSections: [],
        allAreas: selectedArea ? [selectedArea] : [],
        settings: { gtd: { defaultProjectFlowMode: prepared.defaultProjectFlowMode } } as ReturnType<typeof useTaskStore.getState>['settings'],
        deviceId: prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!, now: prepared.preparedAt,
        projectId: request.requestId });
};


const readPrepared = (value: unknown): NativePreparedTaskPromotion | null => {
    const input = detach<Record<string, unknown>>(value);
    if (!input || !exact(input, ['request', 'prepared']) || !record(input.prepared)) return null;
    const request = readRequest(input.request);
    const raw = input.prepared;
    if (request && raw.version === 2) return readChecklistPrepared(request, raw);
    if (!request || request.expandChecklist || !exact(raw, ['version', 'request', 'sourceBefore', 'sourceProject', 'selectedArea',
        'selectedProject', 'projectOrderMax', 'taskOrderMax', 'defaultProjectFlowMode',
        'deviceIdBefore', 'deviceIdToInitialize', 'preparedAt', 'tasks', 'projects', 'sections', 'result'])
        || raw.version !== 1 || !same(raw.request, request)
        || !record(raw.sourceBefore) || raw.sourceBefore.id !== request.taskId
        || !(raw.sourceProject === null || record(raw.sourceProject))
        || !(raw.selectedArea === null || record(raw.selectedArea))
        || !(raw.selectedProject === null || record(raw.selectedProject))
        || !(raw.projectOrderMax === null || typeof raw.projectOrderMax === 'number' && Number.isFinite(raw.projectOrderMax) && raw.projectOrderMax >= -1)
        || !(raw.taskOrderMax === null || typeof raw.taskOrderMax === 'number' && Number.isFinite(raw.taskOrderMax) && raw.taskOrderMax >= -1)
        || !(raw.defaultProjectFlowMode === null || typeof raw.defaultProjectFlowMode === 'string')
        || !(raw.deviceIdBefore === null || typeof raw.deviceIdBefore === 'string' && Boolean(raw.deviceIdBefore))
        || (raw.deviceIdBefore === null
            ? typeof raw.deviceIdToInitialize !== 'string' || !UUID.test(raw.deviceIdToInitialize)
            : raw.deviceIdToInitialize !== null)
        || typeof raw.preparedAt !== 'string' || !Number.isFinite(Date.parse(raw.preparedAt))
        || new Date(raw.preparedAt).toISOString() !== raw.preparedAt
        || !Array.isArray(raw.tasks) || raw.tasks.length !== 1
        || !Array.isArray(raw.projects) || raw.projects.length > 1
        || !Array.isArray(raw.sections) || raw.sections.length !== 0
        || !record(raw.result) || !exact(raw.result, ['id', 'reused'])
        || typeof raw.result.id !== 'string' || typeof raw.result.reused !== 'boolean') return null;
    try {
        const prepared = raw as unknown as NativePreparedTaskMove;
        if (taskRevisionOf(prepared.sourceBefore) !== request.taskRevision
            || prepared.sourceBefore.deletedAt || prepared.sourceBefore.purgedAt
            || isProjectedRecurringTaskId(prepared.sourceBefore.id)
            || (prepared.sourceProject !== null && prepared.sourceProject.id !== prepared.sourceBefore.projectId)
            || (prepared.selectedArea !== null && (prepared.selectedArea.deletedAt || !prepared.selectedArea.id))
            || (prepared.selectedProject !== null && !prepared.selectedProject.id)
            || !record(prepared.tasks[0]) || !exact(prepared.tasks[0] as unknown as Record<string, unknown>, ['before', 'after'])
            || !same(prepared.tasks[0].before, prepared.sourceBefore)
            || !record(prepared.tasks[0].after)
            || (prepared.projects.length === 1 && (!record(prepared.projects[0])
                || !exact(prepared.projects[0] as unknown as Record<string, unknown>, ['before', 'after'])
                || prepared.projects[0].before !== null || !record(prepared.projects[0].after)))) return null;
        const expected = expectedPromotion(prepared);
        if (!expected.ok || expected.targetAreaId !== prepared.selectedArea?.id
            || (expected.createdProject === null) !== prepared.result.reused
            || expected.targetProject.id !== prepared.result.id
            || !same(expected.targetProject, prepared.selectedProject ?? prepared.projects[0]?.after)
            || !same(expected.taskAfter, prepared.tasks[0].after)
            || (expected.createdProject === null
                ? prepared.projects.length !== 0 || prepared.projectOrderMax !== null || prepared.defaultProjectFlowMode !== null
                : prepared.projects.length !== 1 || prepared.result.id !== request.requestId
                    || !same(expected.createdProject, prepared.projects[0].after))
            || (prepared.sourceBefore.projectId === prepared.result.id
                ? prepared.taskOrderMax !== null : prepared.taskOrderMax === null)) return null;
        return prepared;
    } catch { return null; }
};

const readChecklistPrepared = (request: NativeTaskPromotionRequest, raw: Record<string, unknown>): NativePreparedChecklistPromotion | null => {
    if (request.expandChecklist !== true || !exact(raw, ['version', 'request', 'conversion', 'result'])
        || !same(raw.request, request) || !record(raw.result) || !exact(raw.result, ['id', 'reused'])
        || raw.result.id !== request.requestId || raw.result.reused !== false || !record(raw.conversion)) return null;
    const conversion = raw.conversion;
    if (!(exact(conversion, ['source', 'retired', 'project', 'tasks', 'deviceId'])
        || exact(conversion, ['source', 'retired', 'project', 'tasks', 'deviceIdBefore', 'deviceId']) && typeof conversion.deviceIdBefore === 'string')
        || typeof conversion.deviceId !== 'string' || !conversion.deviceId
        || !record(conversion.source) || !record(conversion.retired) || !record(conversion.project)
        || !Array.isArray(conversion.tasks)) return null;
    const { source, retired, project, tasks } = conversion as unknown as ChecklistProjectConversion;
    const checklist = source.checklist ?? [];
    const ids = tasks.map((task) => record(task) ? task.id : undefined);
    if (source.id !== request.taskId || taskRevisionOf(source) !== request.taskRevision
        || source.deletedAt || source.purgedAt || isProjectedRecurringTaskId(source.id)
        || retired.id !== source.id || typeof retired.deletedAt !== 'string' || retired.deletedAt !== retired.updatedAt
        || project.id !== request.requestId || project.title !== request.title.trim() || project.deletedAt
        || !checklist.length || tasks.length !== checklist.length
        || ids.some((id) => typeof id !== 'string' || !UUID.test(id))
        || new Set([source.id, project.id, ...ids]).size !== ids.length + 2) return null;
    return tasks.every((task, index) => task.projectId === project.id && task.title === checklist[index].title
        && task.status === (checklist[index].isCompleted ? 'done' : 'next') && !task.deletedAt)
        ? raw as unknown as NativePreparedChecklistPromotion : null;
};

const readPromotionUndoRequest = (value: unknown): NativeTaskPromotionUndoRequest | null => {
    const request = detach<Record<string, unknown>>(value);
    return request && exact(request, ['requestId', 'promoteRequestId'])
        && typeof request.requestId === 'string' && UUID.test(request.requestId)
        && typeof request.promoteRequestId === 'string' && UUID.test(request.promoteRequestId)
        && request.requestId !== request.promoteRequestId ? request as NativeTaskPromotionUndoRequest : null;
};

const readPromotionUndo = (value: unknown): NativePreparedTaskPromotionUndo | null => {
    const input = detach<Record<string, unknown>>(value);
    if (!input || !exact(input, ['request', 'prepared']) || !record(input.prepared)) return null;
    const request = readPromotionUndoRequest(input.request);
    const raw = input.prepared;
    if (!request || !exact(raw, ['version', 'kind', 'request', 'promote', 'result']) || raw.version !== 1
        || raw.kind !== 'taskPromoteUndo' || !same(raw.request, request) || !record(raw.promote)) return null;
    const promoted = readPrepared(raw.promote);
    if (!promoted || promoted.version !== 2 || promoted.request.requestId !== request.promoteRequestId
        || !record(raw.result) || !exact(raw.result, ['id']) || raw.result.id !== promoted.conversion.source.id) return null;
    return raw as unknown as NativePreparedTaskPromotionUndo;
};

export function createTaskPromotionMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    isReadOnly: (task: Task) => boolean;
    t: () => (key: string) => string;
}) {
    const conversionFailure = (error: string | undefined) => error === 'task.expandChecklistSaveFailed'
        ? fail('SAVE_FAILED', deps.t()(error)) : fail('STALE_REVISION', deps.t()(error ?? 'task.expandChecklistConflict'));
    const confirmed = <T,>(operation: 'convert' | 'undo', count: number, value: T): NativeHostResult<T> => {
        try { logInfo('Native checklist project conversion confirmed', { scope: 'native-host', category: 'storage', force: true,
            context: { releaseCheck: 'v1.3.8/ios-checklist-project', operation, count, outcome: 'confirmed' } }); }
        catch {}
        return { ok: true, value };
    };
    const prepareChecklist = (request: NativeTaskPromotionRequest & { expandChecklist: true },
        sourceBefore: Task): NativeHostResult<NativeTaskPromotionPreparation> => {
        const state = useTaskStore.getState();
        const planned = prepareChecklistProjectConversion(state, sourceBefore, request.title,
            { project: request.requestId, tasks: (sourceBefore.checklist ?? []).map(() => generateUUID()) });
        if (!planned.success) return fail('INVALID_INPUT', deps.t()(planned.error));
        const prepared = detach<NativePreparedChecklistPromotion>({ version: 2, request,
            conversion: planned.command, result: { id: request.requestId, reused: false } });
        if (!prepared || !readPrepared({ request, prepared })) return fail('INVALID_INPUT', 'Task promotion exceeds the bounded journal');
        return { ok: true, value: { kind: 'prepared', prepared } };
    };
    return {
        getTaskPromotionOptions(input: { taskId: string; taskRevision: string }): NativeHostResult<{ blockedMessage: string | null }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const query = detach<Record<string, unknown>>(input);
            if (!query || !exact(query, ['taskId', 'taskRevision']) || typeof query.taskId !== 'string' || !query.taskId
                || query.taskId.length > 500 || typeof query.taskRevision !== 'string' || !query.taskRevision
                || query.taskRevision.length > 2000) return fail('INVALID_INPUT', 'A bounded task and revision are required');
            const state = useTaskStore.getState();
            const task = state._tasksById.get(query.taskId);
            if (!task || task.deletedAt || task.purgedAt) return fail('TASK_NOT_FOUND', 'Task not found');
            if (taskRevisionOf(task) !== query.taskRevision) return fail('STALE_REVISION', 'Task changed since it was opened');
            const blocked = checklistProjectBlockReason(task, state.settings);
            return { ok: true, value: { blockedMessage: blocked ? deps.t()(blocked) : null } };
        },
        prepareTaskPromotion(input: NativeTaskPromotionRequest): NativeHostResult<NativeTaskPromotionPreparation> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded task, revision, title, and lowercase UUID are required');
            const state = useTaskStore.getState();
            const sourceBefore = state._tasksById.get(request.taskId);
            if (!sourceBefore || sourceBefore.deletedAt || sourceBefore.purgedAt) return fail('TASK_NOT_FOUND', 'Task not found');
            if (isProjectedRecurringTaskId(request.taskId) || deps.isReadOnly(sourceBefore)
                || isStatusListTaskReadOnly(sourceBefore, state._allProjects)) return fail('INVALID_INPUT', 'Task is read-only');
            if (taskRevisionOf(sourceBefore) !== request.taskRevision) return fail('STALE_REVISION', 'Task changed since it was opened');
            if (state._projectsById.has(request.requestId) || state._tasksById.has(request.requestId)) return fail('INVALID_INPUT', 'Request identity is already in use');
            if (request.expandChecklist) return prepareChecklist({ ...request, expandChecklist: true }, sourceBefore);
            const sourceProject = sourceBefore.projectId ? state._projectsById.get(sourceBefore.projectId) ?? null : null;
            const inheritedAreaId = sourceBefore.areaId ?? sourceProject?.areaId;
            const selectedArea = inheritedAreaId
                ? state._allAreas.find((area) => area.id === inheritedAreaId && !area.deletedAt) ?? null : null;
            const selectedProject = findSelectableProjectByTitleAndArea(state._allProjects,
                request.title, selectedArea?.id) ?? null;
            const device = ensureDeviceId(state.settings);
            const preparedAt = new Date().toISOString();
            const plan = planTaskPromotion({ sourceTask: sourceBefore, title: request.title,
                allTasks: state._allTasks, allProjects: state._allProjects, allSections: state._allSections,
                allAreas: state._allAreas, settings: state.settings, deviceId: device.deviceId,
                now: preparedAt, projectId: request.requestId });
            if (!plan.ok) return fail('INVALID_INPUT', plan.error);
            const result = { id: plan.targetProject.id, reused: !plan.createdProject };
            const prepared: NativePreparedTaskMove = {
                version: 1, request, sourceBefore, sourceProject, selectedArea, selectedProject,
                projectOrderMax: plan.createdProject ? projectAreaOrderMax(state._allProjects, selectedArea?.id ?? null) : null,
                taskOrderMax: sourceBefore.projectId === result.id ? null
                    : (getNextProjectOrder(result.id, state._allTasks) ?? 0) - 1,
                defaultProjectFlowMode: plan.createdProject ? state.settings.gtd?.defaultProjectFlowMode ?? null : null,
                deviceIdBefore: state.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                preparedAt,
                tasks: [{ before: sourceBefore, after: plan.taskAfter }],
                projects: plan.createdProject ? [{ before: null, after: plan.createdProject }] : [],
                sections: [], result,
            };
            const frozen = detach<NativePreparedTaskPromotion>(JSON.parse(JSON.stringify(prepared)));
            if (!frozen || !readPrepared({ request, prepared: frozen })) return fail('INVALID_INPUT', 'Task promotion exceeds the bounded journal');
            return { ok: true, value: { kind: 'prepared', prepared: frozen } };
        },
        validatePreparedTaskPromotion(input: { request: NativeTaskPromotionRequest; prepared: NativePreparedTaskPromotion }): NativeHostResult<NativeTaskPromotionResult> {
            const prepared = readPrepared(input);
            return prepared ? { ok: true, value: prepared.result }
                : fail('INVALID_INPUT', 'Prepared task promotion request or journal does not match');
        },
        async commitPreparedTaskPromotion(input: { request: NativeTaskPromotionRequest; prepared: NativePreparedTaskPromotion }): Promise<NativeHostResult<NativeTaskPromotionResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const prepared = readPrepared(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared task promotion request or journal does not match');
            if (prepared.version === 2) {
                const converted = await useTaskStore.getState().convertChecklistToProject(prepared.conversion);
                if (!converted.success) return conversionFailure(converted.error);
                const saved = await deps.save();
                return saved.ok ? confirmed('convert', prepared.conversion.tasks.length, prepared.result) : saved;
            }
            const applied = await useTaskStore.getState().commitPreparedTaskPromotion(prepared);
            if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Prepared task promotion conflicts with current data');
            try {
                if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
            } catch (error) { return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error)); }
            const saved = await deps.save();
            return saved.ok ? { ok: true, value: prepared.result } : saved;
        },
        prepareTaskPromotionUndo(input: { request: NativeTaskPromotionUndoRequest; promote: NativeTaskPromotionEnvelope }): NativeHostResult<{ kind: 'prepared'; prepared: NativePreparedTaskPromotionUndo }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const value = detach<Record<string, unknown>>(input);
            const request = value && exact(value, ['request', 'promote']) ? readPromotionUndoRequest(value.request) : null;
            const promoted = request ? readPrepared(value!.promote) : null;
            if (!request || !promoted || promoted.version !== 2 || promoted.request.requestId !== request.promoteRequestId)
                return fail('INVALID_INPUT', 'Undo needs the confirmed checklist conversion');
            const prepared: NativePreparedTaskPromotionUndo = { version: 1, kind: 'taskPromoteUndo', request,
                promote: value!.promote as NativeTaskPromotionEnvelope, result: { id: promoted.conversion.source.id } };
            return readPromotionUndo({ request, prepared }) ? { ok: true, value: { kind: 'prepared', prepared } }
                : fail('INVALID_INPUT', 'Checklist conversion Undo exceeds the bounded journal');
        },
        validatePreparedTaskPromotionUndo(input: NativeTaskPromotionUndoEnvelope): NativeHostResult<{ id: string }> {
            const prepared = readPromotionUndo(input);
            return prepared ? { ok: true, value: prepared.result } : fail('INVALID_INPUT', 'Prepared checklist conversion Undo does not match');
        },
        async commitPreparedTaskPromotionUndo(input: NativeTaskPromotionUndoEnvelope): Promise<NativeHostResult<{ id: string }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const prepared = readPromotionUndo(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared checklist conversion Undo does not match');
            const promoted = readPrepared(prepared.promote) as NativePreparedChecklistPromotion;
            const restored = await useTaskStore.getState().undoChecklistToProject(promoted.conversion);
            if (!restored.success) return conversionFailure(restored.error);
            const saved = await deps.save();
            return saved.ok ? confirmed('undo', promoted.conversion.tasks.length, prepared.result) : saved;
        },
    };
}
