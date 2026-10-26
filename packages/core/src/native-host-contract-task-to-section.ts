import type { NativeHostResult } from './native-host-contract';
import { useTaskStore } from './store';
import type { PreparedTaskToSection } from './store-types';
import type { Project, Section, Task } from './types';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { isProjectedRecurringTaskId } from './recurrence';
import { isStatusListTaskReadOnly } from './menu-views-model';
import { ensureDeviceId, getNextProjectOrder } from './store-helpers';
import { planTaskToSection, taskEditValuesEqual, taskToSectionOrderMax } from './store-tasks';
import { requestRowId, taskRevisionOf, type NativeRequestReceipts } from './native-request-receipts';
import { normalizeOptionalContainerId } from './task-container-rules';

/** RN's editor Convert to section for the saved task the editor showed (RN saves the draft first). */
export type NativeTaskToSectionRequest = { requestId: string; taskId: string; taskRevision: string };
export type NativeTaskToSectionResult = { projectId: string; sectionId: string };
export type NativePreparedTaskToSection = PreparedTaskToSection & {
    version: 1; request: NativeTaskToSectionRequest; preparedAt: string;
};
export type NativeTaskToSectionEnvelope = { request: NativeTaskToSectionRequest; prepared: NativePreparedTaskToSection };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const same = taskEditValuesEqual;
// Object order changes when a native host encodes its journal; array order never does.
export const canonicalJSON = (input: unknown): string => JSON.stringify(input, (_name, value) =>
    record(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
const orderMax = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= -1;
const fail = (code: 'INVALID_INPUT' | 'TASK_NOT_FOUND' | 'STALE_REVISION', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });

/** Plain bounded JSON only, copied: the journal never holds a live store row. */
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

const readRequest = (value: unknown): NativeTaskToSectionRequest | null => {
    const request = detach<Record<string, unknown>>(value);
    return request && exact(request, ['requestId', 'taskId', 'taskRevision'])
        && typeof request.requestId === 'string' && UUID.test(request.requestId)
        && typeof request.taskId === 'string' && Boolean(request.taskId) && request.taskId.length <= 500
        && typeof request.taskRevision === 'string' && Boolean(request.taskRevision) && request.taskRevision.length <= 2000
        ? request as NativeTaskToSectionRequest : null;
};

/** The new rows' ids come from the request UUID: the section is the UUID itself, its tasks requestRowId of it. */
const requestIds = (requestId: string) => {
    let next = 0;
    return () => (next++ === 0 ? requestId : requestRowId(requestId, `task-to-section:${next - 2}`));
};

/** The plan from the frozen consulted rows only: never the live store, the clock or a translator. */
const expected = (prepared: NativePreparedTaskToSection) => {
    const { request, sourceBefore, project } = prepared;
    const sections: Section[] = prepared.sectionOrderMax >= 0 ? [{ id: `native-to-section-order-${request.requestId}`,
        projectId: project.id, title: '', order: prepared.sectionOrderMax, createdAt: prepared.preparedAt,
        updatedAt: prepared.preparedAt }] : [];
    const tasks: Task[] = [sourceBefore];
    if (prepared.taskOrderMax >= 0) tasks.push({ ...sourceBefore, id: `native-to-section-task-order-${request.requestId}`,
        projectId: project.id, order: prepared.taskOrderMax, orderNum: prepared.taskOrderMax });
    return planTaskToSection({ sourceTask: sourceBefore, allTasks: tasks, allProjects: [project], allSections: sections,
        allAreas: [], settings: prepared.taskReminderDefault === null ? {}
            : { taskReminderDefault: prepared.taskReminderDefault } as ReturnType<typeof useTaskStore.getState>['settings'],
        deviceId: prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!, now: prepared.preparedAt,
        generateId: requestIds(request.requestId) });
};

/** Pure journal validation, including on a cold boot before SQLite is opened. */
const readPrepared = (value: unknown): NativeTaskToSectionEnvelope | null => {
    const input = detach<Record<string, unknown>>(value);
    if (!input || !exact(input, ['request', 'prepared']) || !record(input.prepared)) return null;
    const request = readRequest(input.request);
    const raw = input.prepared;
    if (!request || !exact(raw, ['version', 'request', 'sourceBefore', 'project', 'sectionOrderMax', 'taskOrderMax',
        'taskReminderDefault', 'deviceIdBefore', 'deviceIdToInitialize', 'preparedAt', 'tasks', 'projects', 'sections', 'result'])
        || raw.version !== 1 || !same(raw.request, request)
        || !record(raw.sourceBefore) || raw.sourceBefore.id !== request.taskId || !record(raw.project)
        || !orderMax(raw.sectionOrderMax) || !orderMax(raw.taskOrderMax)
        || !(raw.taskReminderDefault === null || typeof raw.taskReminderDefault === 'string')
        || !(raw.deviceIdBefore === null || typeof raw.deviceIdBefore === 'string' && Boolean(raw.deviceIdBefore))
        || (raw.deviceIdBefore === null
            ? typeof raw.deviceIdToInitialize !== 'string' || !UUID.test(raw.deviceIdToInitialize)
            : raw.deviceIdToInitialize !== null)
        || typeof raw.preparedAt !== 'string' || !Number.isFinite(Date.parse(raw.preparedAt))
        || new Date(raw.preparedAt).toISOString() !== raw.preparedAt
        || !Array.isArray(raw.tasks) || !Array.isArray(raw.projects) || !Array.isArray(raw.sections)) return null;
    try {
        const prepared = raw as unknown as NativePreparedTaskToSection;
        const source = prepared.sourceBefore;
        if (taskRevisionOf(source) !== request.taskRevision || source.deletedAt || source.purgedAt
            || isProjectedRecurringTaskId(source.id)
            || prepared.project.id !== normalizeOptionalContainerId(source.projectId) || prepared.project.deletedAt
            || isStatusListTaskReadOnly(source, [prepared.project])) return null;
        const plan = expected(prepared);
        if (!plan.ok || !same({ tasks: prepared.tasks, projects: prepared.projects, sections: prepared.sections, result: prepared.result }, {
            tasks: [{ before: source, after: plan.deletedSource }, ...plan.tasks.map((after) => ({ before: null, after }))],
            projects: [], sections: [{ before: null, after: plan.section }],
            result: { projectId: prepared.project.id, sectionId: request.requestId },
        })) return null;
        return { request, prepared };
    } catch { return null; }
};

export function createTaskToSectionMethods(deps: {
    readiness: () => NativeHostResult<null>;
    receipts: NativeRequestReceipts;
    isReadOnly: (task: Task) => boolean;
}) {
    return {
        prepareTaskToSection(input: NativeTaskToSectionRequest): NativeHostResult<{ kind: 'prepared'; prepared: NativePreparedTaskToSection }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded task, revision, and lowercase UUID are required');
            const state = useTaskStore.getState();
            const sourceBefore = state._tasksById.get(request.taskId);
            if (!sourceBefore || sourceBefore.deletedAt || sourceBefore.purgedAt) return fail('TASK_NOT_FOUND', 'Task not found');
            if (isProjectedRecurringTaskId(request.taskId) || deps.isReadOnly(sourceBefore)
                || isStatusListTaskReadOnly(sourceBefore, state._allProjects)) return fail('INVALID_INPUT', 'Task is read-only');
            if (taskRevisionOf(sourceBefore) !== request.taskRevision) return fail('STALE_REVISION', 'Task changed since it was opened');
            const projectId = normalizeOptionalContainerId(sourceBefore.projectId);
            if (!projectId) return fail('INVALID_INPUT', 'Task is not in a project');
            const project = state._projectsById.get(projectId) as Project | undefined;
            if (!project || project.deletedAt) return fail('INVALID_INPUT', 'Section could not be created');
            if (state._sectionsById.has(request.requestId)) return fail('INVALID_INPUT', 'Request identity is already in use');
            const device = ensureDeviceId(state.settings);
            const preparedAt = new Date().toISOString();
            const plan = planTaskToSection({ sourceTask: sourceBefore, allTasks: state._allTasks, allProjects: state._allProjects,
                allSections: state._allSections, allAreas: state._allAreas, settings: state.settings,
                deviceId: device.deviceId, now: preparedAt, generateId: requestIds(request.requestId) });
            if (!plan.ok) return fail('INVALID_INPUT', plan.error);
            if (plan.tasks.some((row) => state._tasksById.has(row.id))) return fail('INVALID_INPUT', 'Request identity is already in use');
            const prepared: NativePreparedTaskToSection = {
                version: 1, request, sourceBefore, project,
                sectionOrderMax: taskToSectionOrderMax(state._allSections, projectId),
                taskOrderMax: (getNextProjectOrder(projectId, state._allTasks) ?? 0) - 1,
                taskReminderDefault: state.settings.taskReminderDefault ?? null,
                deviceIdBefore: state.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                preparedAt,
                tasks: [{ before: sourceBefore, after: plan.deletedSource }, ...plan.tasks.map((after) => ({ before: null, after }))],
                projects: [], sections: [{ before: null, after: plan.section }],
                result: { projectId, sectionId: plan.section.id },
            };
            const frozen = detach<NativePreparedTaskToSection>(JSON.parse(JSON.stringify(prepared)));
            if (!frozen || !readPrepared({ request, prepared: frozen })) return fail('INVALID_INPUT', 'Convert to section exceeds the bounded journal');
            return { ok: true, value: { kind: 'prepared', prepared: frozen } };
        },
        validatePreparedTaskToSection(input: NativeTaskToSectionEnvelope): NativeHostResult<NativeTaskToSectionResult> {
            const envelope = readPrepared(input);
            return envelope ? { ok: true, value: envelope.prepared.result }
                : fail('INVALID_INPUT', 'Prepared Convert to section request or journal does not match');
        },
        /** Writes only on the frozen rows and orders (else STALE_REVISION, nothing written); a landed one answers its receipt. */
        async commitPreparedTaskToSection(input: NativeTaskToSectionEnvelope): Promise<NativeHostResult<NativeTaskToSectionResult>> {
            const envelope = readPrepared(input);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared Convert to section request or journal does not match');
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            return deps.receipts.run(envelope.request.requestId, canonicalJSON(['preparedTaskToSection', envelope]), async () => {
                const applied = await useTaskStore.getState().commitPreparedTaskToSection(envelope.prepared);
                return applied.success ? { ok: true, value: envelope.prepared.result }
                    : fail('STALE_REVISION', applied.error ?? 'Prepared Convert to section conflicts with current data');
            });
        },
    };
}
