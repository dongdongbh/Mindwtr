import type { NativeHostResult } from './native-host-contract';
import type { Project } from './types';
import type { PreparedAreaAuthority, PreparedNativeSaveBoundary } from './store-types';
import { exact, record } from './native-json';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { createNativeRequestReceipts, revisionOf } from './native-request-receipts';
import { createAreaSaveGuard, readAreaDurableData } from './native-host-contract-area-durable';
import { checkNativeProjectTaskAddAuthority, isNativeProjectTaskAddOperation, isNativeProjectTaskContainer,
    prepareNativeProjectTaskAddOperation, projectTaskCreationLists, type NativeProjectTaskAddOperation } from './native-host-contract-project-next-action';
import { planReviewProjectTask } from './review-views-model';
import { selectVisiblePeople, selectVisibleTasks } from './store-helpers';
import { getStorageAdapter, useTaskStore } from './store';
import { taskEditValuesEqual } from './json-value-equality';
import { toStableSyncJson } from './sync-helpers';
import { logInfo } from './logger';

export type NativeReviewProjectTaskRequest = { requestId: string; projectId: string; projectRevision: string; title: string; openAfterSave: boolean };
export type NativeReviewProjectTaskResult = { taskId: string; title: string; openAfterSave: boolean };
export type NativeReviewProjectTaskEnvelope = { request: NativeReviewProjectTaskRequest; prepared: {
    version: 1; request: NativeReviewProjectTaskRequest; sourceProject: Project;
    operation: NativeProjectTaskAddOperation; result: NativeReviewProjectTaskResult;
} };
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED' | 'ACTION_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const readRequest = (v: unknown): v is NativeReviewProjectTaskRequest => record(v)
    && exact(v, ['requestId', 'projectId', 'projectRevision', 'title', 'openAfterSave'])
    && typeof v.requestId === 'string' && uuid.test(v.requestId) && text(v.projectId, 500)
    && text(v.projectRevision, 200) && text(v.title, 10_000) && Boolean(v.title.trim()) && typeof v.openAfterSave === 'boolean';
const readEnvelope = (v: unknown): v is NativeReviewProjectTaskEnvelope => {
    try {
        if (!record(v) || !exact(v, ['request', 'prepared']) || !readRequest(v.request) || !record(v.prepared)
            || !exact(v.prepared, ['version', 'request', 'sourceProject', 'operation', 'result']) || v.prepared.version !== 1
            || !taskEditValuesEqual(v.request, v.prepared.request)
            || !isNativeProjectTaskContainer(v.prepared.sourceProject, v.request.projectId)
            || v.prepared.sourceProject.status !== 'active' || Boolean(v.prepared.sourceProject.deletedAt || v.prepared.sourceProject.purgedAt) || revisionOf(v.prepared.sourceProject) !== v.request.projectRevision
            || !isNativeProjectTaskAddOperation(v.prepared.operation, { project: v.prepared.sourceProject, section: null }, [v.request.projectId])
            || Boolean(v.prepared.operation.creation.containers.project.deletedAt || v.prepared.operation.creation.containers.project.purgedAt)
            || v.prepared.operation.task.id !== v.request.requestId || !record(v.prepared.result)
            || !exact(v.prepared.result, ['taskId', 'title', 'openAfterSave'])
            || v.prepared.result.taskId !== v.request.requestId || v.prepared.result.title !== v.prepared.operation.task.title
            || v.prepared.result.openAfterSave !== v.request.openAfterSave || !isNativeJsonWithinBytes(v)) return false;
        return true;
    } catch { return false; }
};
const payload = (v: NativeReviewProjectTaskEnvelope) => toStableSyncJson(['weeklyReviewProjectTask', v]);
const rawBefore = (v: NativeReviewProjectTaskEnvelope) => ({ tasks: [{ id: v.request.requestId, before: null }], projects: [], sections: [] });

export function createReviewProjectTaskMethods(deps: { readiness: () => NativeHostResult<null>; save: () => Promise<NativeHostResult<null>>;
    t: () => (key: string) => string }) {
    const saves = createAreaSaveGuard(deps.save);
    let pending: { envelope: NativeReviewProjectTaskEnvelope; adapter: ReturnType<typeof getStorageAdapter>; boundary: PreparedNativeSaveBoundary | undefined } | null = null;
    const check = (e: NativeReviewProjectTaskEnvelope, authority: PreparedAreaAuthority): NativeHostResult<null> => {
        const source = projectTaskCreationLists(authority.snapshot, e.prepared.operation.updateAt).projects.find((p) => p.id === e.request.projectId);
        if (!taskEditValuesEqual(source, e.prepared.sourceProject)) return fail('STALE_REVISION', 'Weekly Review project changed before creation');
        return checkNativeProjectTaskAddAuthority(e.prepared.operation, authority.snapshot);
    };
    const apply = async (e: NativeReviewProjectTaskEnvelope, authority: PreparedAreaAuthority): Promise<NativeHostResult<null>> => {
        const op = e.prepared.operation;
        const result = await useTaskStore.getState().commitPreparedCapture({ task: op.task, project: null,
            deviceIdBefore: op.deviceIdBefore, deviceIdToInitialize: op.deviceIdToInitialize }, { requireBefore: true, authority, rawBefore: rawBefore(e) });
        return result.success ? { ok: true, value: null } : fail('STALE_REVISION', result.error ?? 'Prepared Review project task conflicts with saved data');
    };
    const receipts = createNativeRequestReceipts({ save: async (requestId) => {
        const owned = pending;
        if (!owned || owned.envelope.request.requestId !== requestId) return fail('SAVE_FAILED', 'Review project task has no owned save');
        if (useTaskStore.getState().persistenceFailure) {
            if (!saves.mayApply(owned.envelope, owned.adapter)) return fail('SAVE_FAILED', 'Review project task has an unrelated save failure');
            const read = await readAreaDurableData(true, true); if (!read.ok) return read;
            if (read.value.adapter !== owned.adapter) return fail('STALE_REVISION', 'Review project task storage changed');
            const checked = check(owned.envelope, read.value.authority); if (!checked.ok) return checked;
            const written = await apply(owned.envelope, read.value.authority); if (!written.ok) return written;
            owned.boundary = read.value.authority.saveBoundary;
        }
        const saved = await saves.finish(owned.envelope, owned.adapter, false, owned.boundary);
        if (saved.ok) pending = null;
        return saved;
    } });
    const diagnose = () => { try { logInfo('Native iOS Weekly Review project task confirmed', { scope: 'native-host', category: 'storage',
        context: { releaseCheck: 'v1.3.8/ios-weekly-review-project-task', outcome: 'confirmed' } }); } catch { return undefined; } };
    return {
        async getWeeklyReviewProjectTaskOptions(input: { projectId: string }) {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            if (!record(input) || !exact(input, ['projectId']) || !text(input.projectId, 500)) return fail('INVALID_INPUT', 'One Review project is required');
            const read = await readAreaDurableData(false, true); if (!read.ok) return read;
            const project = projectTaskCreationLists(read.value.authority.snapshot, new Date().toISOString()).projects.find((p) => p.id === input.projectId && p.status === 'active' && !p.deletedAt && !p.purgedAt);
            if (!project) return fail('STALE_REVISION', 'Weekly Review project is no longer active');
            const t = deps.t();
            return { ok: true as const, value: { projectId: project.id, projectRevision: revisionOf(project), title: project.title,
                placeholder: t('review.addTaskPlaceholder'), save: t('common.save'), saveAndEdit: t('quickAdd.saveAndEdit'), cancel: t('common.cancel') } };
        },
        async prepareWeeklyReviewProjectTask(input: NativeReviewProjectTaskRequest) {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            if (!readRequest(input)) return fail('INVALID_INPUT', 'A bounded Review project task request is required');
            const read = await readAreaDurableData(false, true); if (!read.ok) return read;
            const data = read.value.authority.snapshot, lists = projectTaskCreationLists(data, new Date().toISOString());
            const sourceProject = lists.projects.find((p) => p.id === input.projectId && p.status === 'active' && !p.deletedAt && !p.purgedAt);
            if (!sourceProject || revisionOf(sourceProject) !== input.projectRevision) return fail('STALE_REVISION', 'Weekly Review project changed while adding a task');
            const intent = planReviewProjectTask({ title: input.title, projectId: input.projectId, projects: lists.projects, areas: lists.areas,
                settings: data.settings, tasks: selectVisibleTasks(lists.tasks), people: selectVisiblePeople(data.people ?? []) });
            if (!intent) return fail('INVALID_INPUT', 'A project task title is required');
            try {
                const operation = prepareNativeProjectTaskAddOperation(data, intent, input.requestId);
                const prepared: NativeReviewProjectTaskEnvelope['prepared'] = { version: 1, request: input, sourceProject, operation,
                    result: { taskId: input.requestId, title: operation.task.title, openAfterSave: input.openAfterSave } };
                const envelope: unknown = JSON.parse(JSON.stringify({ request: input, prepared }));
                return readEnvelope(envelope) ? { ok: true as const, value: { kind: 'prepared' as const, prepared: envelope.prepared } }
                    : fail('INVALID_INPUT', 'Review project task could not be prepared safely');
            } catch { return fail('INVALID_INPUT', 'Review project task could not be prepared safely'); }
        },
        validatePreparedWeeklyReviewProjectTask(input: unknown): NativeHostResult<NativeReviewProjectTaskResult> {
            return readEnvelope(input) ? { ok: true, value: input.prepared.result } : fail('INVALID_INPUT', 'Invalid prepared Review project task');
        },
        async commitPreparedWeeklyReviewProjectTask(input: unknown): Promise<NativeHostResult<NativeReviewProjectTaskResult>> {
            if (!readEnvelope(input)) return fail('INVALID_INPUT', 'Invalid prepared Review project task');
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const key = payload(input), saved = receipts.saved<NativeReviewProjectTaskResult>(input.request.requestId, key);
            if (saved) { if (saved.ok && !taskEditValuesEqual(saved.value, input.prepared.result)) return fail('INVALID_INPUT', 'Saved Review project task result differs');
                if (saved.ok) diagnose(); return saved; }
            let prewrite: NativeHostResult<never> | null = null;
            const notLanded = (message: string) => { prewrite = fail('SAVE_FAILED', message); return fail('ACTION_FAILED', message); };
            const confirmed = await receipts.run(input.request.requestId, key, async () => {
                if (useTaskStore.getState().persistenceFailure) return notLanded('Review project task has an unresolved save failure');
                const read = await readAreaDurableData(false, true);
                if (!read.ok) return read.error.code === 'SAVE_FAILED' ? notLanded(read.error.message) : read;
                const checked = check(input, read.value.authority); if (!checked.ok) return checked;
                const written = await apply(input, read.value.authority); if (!written.ok) return written;
                pending = { envelope: input, adapter: read.value.adapter, boundary: read.value.authority.saveBoundary };
                return { ok: true, value: input.prepared.result };
            });
            if (prewrite) return prewrite;
            if (confirmed.ok) { if (!taskEditValuesEqual(confirmed.value, input.prepared.result)) return fail('INVALID_INPUT', 'Saved Review project task result differs'); diagnose(); }
            return confirmed;
        },
        weeklyReviewProjectTaskOutcome(input: unknown): NativeHostResult<NativeReviewProjectTaskResult | null> {
            if (!readEnvelope(input)) return fail('INVALID_INPUT', 'Invalid prepared Review project task');
            return receipts.saved<NativeReviewProjectTaskResult>(input.request.requestId, payload(input)) ?? { ok: true, value: null };
        },
    };
}
