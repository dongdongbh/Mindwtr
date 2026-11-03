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
import { planTaskPromotion, taskEditValuesEqual } from './store-tasks';
import { taskRevisionOf } from './native-request-receipts';

export type NativeTaskPromotionRequest = { requestId: string; taskId: string; taskRevision: string; title: string };
export type NativeTaskPromotionResult = { id: string; reused: boolean };
export type NativePreparedTaskPromotion = PreparedTaskPromotion & {
    version: 1; request: NativeTaskPromotionRequest; preparedAt: string; result: NativeTaskPromotionResult;
};
export type NativeTaskPromotionPreparation = { kind: 'prepared'; prepared: NativePreparedTaskPromotion };

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
    return request && exact(request, ['requestId', 'taskId', 'taskRevision', 'title'])
        && typeof request.requestId === 'string' && UUID.test(request.requestId)
        && typeof request.taskId === 'string' && Boolean(request.taskId) && request.taskId.length <= 500
        && typeof request.taskRevision === 'string' && Boolean(request.taskRevision) && request.taskRevision.length <= 2000
        && typeof request.title === 'string' && Boolean(request.title.trim()) && request.title.length <= 100_000
        ? request as NativeTaskPromotionRequest : null;
};


const expectedPromotion = (prepared: NativePreparedTaskPromotion) => {
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
    if (!request || !exact(raw, ['version', 'request', 'sourceBefore', 'sourceProject', 'selectedArea',
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
        const prepared = raw as unknown as NativePreparedTaskPromotion;
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

export function createTaskPromotionMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    isReadOnly: (task: Task) => boolean;
}) {
    return {
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
            const prepared: NativePreparedTaskPromotion = {
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
            const applied = await useTaskStore.getState().commitPreparedTaskPromotion(prepared);
            if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Prepared task promotion conflicts with current data');
            try {
                if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
            } catch (error) { return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error)); }
            const saved = await deps.save();
            return saved.ok ? { ok: true, value: prepared.result } : saved;
        },
    };
}
