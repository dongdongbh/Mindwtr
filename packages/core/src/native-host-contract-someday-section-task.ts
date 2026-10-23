import { resolveDefaultNewTaskAreaId } from './area-utils';
import { tFallback } from './i18n';
import type { NativeHostResult } from './native-host-contract';
import { detach, exact, iso, record } from './native-host-contract-project-shared';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { createNativeRequestReceipts, runStoreWrite, settleWrite } from './native-request-receipts';
import { getSomedaySectionTaskText, planSomedaySectionTaskAdd } from './someday-sections-model';
import { useTaskStore } from './store';
import { sameSectionDeleteJson, sameTaskSqliteRow } from './store-projects/section-actions';
import { buildNewTask } from './task-creation';
import { getTaskReminderDefault } from './task-reminder-policy';
import { TASK_SQLITE_COLUMNS, taskFromSqliteRow, taskToSqliteRow } from './task-sync-schema';
import type { Area, Task, ViewSectionDefinition } from './types';
import { sortViewSectionDefinitions } from './view-sections';

export type NativeSomedaySectionTaskRequest = { requestId: string; title: string; sectionId: string | null };
export type NativeSomedaySectionTaskResult = { id: string };
export type NativePreparedSomedaySectionTask = {
    version: 1;
    request: NativeSomedaySectionTaskRequest;
    task: Task;
    preparedAt: string;
    deviceId: string;
    selectedArea: { id: string } | null;
    sectionWitness: ViewSectionDefinition | null;
    result: NativeSomedaySectionTaskResult;
};
export type NativeSomedaySectionTaskEnvelope = {
    request: NativeSomedaySectionTaskRequest;
    prepared: NativePreparedSomedaySectionTask;
};

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const LIMIT = 1_000_000;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const safeString = (value: unknown, max: number): value is string => {
    if (typeof value !== 'string' || value.length > max || value.includes('\0')) return false;
    for (let index = 0; index < value.length; index++) {
        const unit = value.charCodeAt(index);
        if (unit >= 0xd800 && unit <= 0xdbff) {
            if (index + 1 >= value.length || value.charCodeAt(++index) < 0xdc00 || value.charCodeAt(index) > 0xdfff) return false;
        } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    }
    return true;
};
const safeText = (value: unknown, max: number): value is string => safeString(value, max) && value.length > 0;
const safeJsonStrings = (value: unknown): boolean => {
    if (typeof value === 'string') return safeString(value, LIMIT);
    if (Array.isArray(value)) return value.every(safeJsonStrings);
    return !record(value) || Object.entries(value).every(([key, part]) => safeString(key, LIMIT) && safeJsonStrings(part));
};
const readRequest = (input: unknown): NativeSomedaySectionTaskRequest | null => {
    if (!record(input) || !exact(input, ['requestId', 'title', 'sectionId'])
        || !isNativeJsonWithinBytes(input, LIMIT)) return null;
    const request = detach<NativeSomedaySectionTaskRequest>(input);
    return request && UUID.test(request.requestId) && safeText(request.title, 10_000)
        && Boolean(request.title.trim()) && (request.sectionId === null || safeText(request.sectionId, 500))
        ? request : null;
};
const readSectionId = (input: unknown): string | null | undefined => {
    const object = detach<Record<string, unknown>>(input);
    return object && exact(object, ['sectionId']) && isNativeJsonWithinBytes(object, LIMIT)
        && (object.sectionId === null || safeText(object.sectionId, 500))
        ? object.sectionId as string | null : undefined;
};
const rawSections = (): NativeHostResult<ViewSectionDefinition[]> => {
    const gtd = useTaskStore.getState().settings.gtd;
    if (gtd === undefined) return { ok: true, value: [] };
    if (!record(gtd)) return fail('INVALID_INPUT', 'Stored Someday sections are malformed');
    if (gtd.viewSections === undefined) return { ok: true, value: [] };
    if (!record(gtd.viewSections)) return fail('INVALID_INPUT', 'Stored Someday sections are malformed');
    const raw = gtd.viewSections.someday;
    if (raw === undefined) return { ok: true, value: [] };
    const sections = detach<ViewSectionDefinition[]>(raw);
    return Array.isArray(raw) && sections && safeJsonStrings(sections)
        ? { ok: true, value: sections } : fail('INVALID_INPUT', 'Stored Someday sections are malformed');
};
const selectedSection = (raw: readonly ViewSectionDefinition[], id: string): ViewSectionDefinition | null => {
    const matches = raw.filter((row) => record(row) && row.id === id);
    if (matches.length !== 1) return null;
    return sortViewSectionDefinitions(raw).includes(matches[0]) ? matches[0] : null;
};
// Validation reads the reminder default back from the frozen row, which inherits it; the journal keeps its shape.
const expectedTask = (prepared: NativePreparedSomedaySectionTask,
    taskReminderDefault: 'send' | 'skip' = prepared.task.suppressMindwtrReminders === true ? 'skip' : 'send'): Task | null => {
    const section = prepared.request.sectionId === null ? undefined : prepared.sectionWitness;
    const plan = planSomedaySectionTaskAdd({ title: prepared.request.title,
        sectionId: prepared.request.sectionId ?? undefined, stored: section ? [section] : [] });
    if (plan.kind !== 'add') return null;
    const built = buildNewTask({
        title: plan.title, initialTaskProps: { ...plan.props, areaId: prepared.selectedArea?.id },
        id: prepared.request.requestId, now: prepared.preparedAt, deviceId: prepared.deviceId,
        state: { settings: { taskReminderDefault }, _allProjects: [], _allSections: [],
            _allAreas: prepared.selectedArea ? [prepared.selectedArea as Area] : [] },
        tasks: [], focusedCount: 0, focusTaskLimit: 0, projectOrderReserver: () => undefined,
    });
    return built.ok ? built.task : null;
};
// SQLite hydration materializes a missing recurrence as null. Compare the same
// canonical hydrated shape on both sides, including every persisted column.
const hydrated = (task: Task): Task => {
    const row = taskToSqliteRow(task);
    return taskFromSqliteRow(Object.fromEntries(TASK_SQLITE_COLUMNS.map((column, index) => [column, row[index]])));
};

/** Pure cold-journal validation; no store or SQLite access. */
export function validatePreparedSomedaySectionTask(input: unknown): NativeHostResult<NativeSomedaySectionTaskResult> {
    const envelope = detach<NativeSomedaySectionTaskEnvelope>(input);
    if (!envelope || !isNativeJsonWithinBytes(envelope, LIMIT) || !safeJsonStrings(envelope)
        || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared))
        return fail('INVALID_INPUT', 'Prepared Someday task journal is malformed');
    const request = readRequest(envelope.request);
    const prepared = envelope.prepared;
    if (!request || !exact(prepared, ['version', 'request', 'task', 'preparedAt', 'deviceId',
        'selectedArea', 'sectionWitness', 'result']) || prepared.version !== 1
        || !sameSectionDeleteJson(prepared.request, request) || !iso(prepared.preparedAt)
        || !safeText(prepared.deviceId, 500) || !record(prepared.result)
        || !exact(prepared.result, ['id']) || prepared.result.id !== request.requestId
        || !record(prepared.task)) return fail('INVALID_INPUT', 'Prepared Someday task journal is malformed');
    if (prepared.selectedArea !== null && (!record(prepared.selectedArea)
        || !exact(prepared.selectedArea, ['id']) || !safeText(prepared.selectedArea.id, 500)))
        return fail('INVALID_INPUT', 'Prepared Someday task Area is malformed');
    if (request.sectionId === null ? prepared.sectionWitness !== null
        : !record(prepared.sectionWitness) || prepared.sectionWitness.id !== request.sectionId
            || !selectedSection([prepared.sectionWitness as ViewSectionDefinition], request.sectionId))
        return fail('INVALID_INPUT', 'Prepared Someday task section is malformed');
    try {
        const expected = expectedTask(prepared);
        return expected && sameSectionDeleteJson(prepared.task, expected)
            && sameTaskSqliteRow(prepared.task, expected)
            ? { ok: true, value: prepared.result }
            : fail('INVALID_INPUT', 'Prepared Someday task does not match its creation context');
    } catch {
        return fail('INVALID_INPUT', 'Prepared Someday task is malformed');
    }
}

export function createSomedaySectionTaskMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    revision: () => string;
    t: (key: string) => string;
}) {
    const durableSave = async (): Promise<NativeHostResult<null>> => {
        try { if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence(); }
        catch (error) { return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error)); }
        return deps.save();
    };
    const receipts = createNativeRequestReceipts({ save: durableSave });
    const target = (prepared: NativePreparedSomedaySectionTask): NativeHostResult<NativeSomedaySectionTaskResult> => {
        const matches = useTaskStore.getState()._allTasks.filter((task) => task.id === prepared.request.requestId);
        try {
            if (matches.length === 1 && !matches[0].deletedAt && !matches[0].purgedAt
                && sameTaskSqliteRow(hydrated(matches[0]), hydrated(prepared.task)))
                return { ok: true, value: prepared.result };
        } catch { /* A malformed stored row cannot acknowledge a creation. */ }
        return fail('STALE_REVISION', 'Someday task creation outcome is not present');
    };
    const sectionStillMatches = (prepared: NativePreparedSomedaySectionTask): boolean => {
        if (prepared.request.sectionId === null) return true;
        const sections = rawSections();
        return sections.ok && Boolean(prepared.sectionWitness)
            && Boolean(selectedSection(sections.value, prepared.request.sectionId))
            && sameSectionDeleteJson(selectedSection(sections.value, prepared.request.sectionId), prepared.sectionWitness);
    };
    return {
        getSomedaySectionTaskOptions(input: { sectionId: string | null }): NativeHostResult<{
            revision: string; sectionId: string | null; groupTitle: string;
            text: ReturnType<typeof getSomedaySectionTaskText>;
        }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const sectionId = readSectionId(input);
            if (sectionId === undefined) return fail('INVALID_INPUT', 'A section ID or null is required');
            const sections = rawSections();
            if (!sections.ok) return sections;
            const section = sectionId === null ? null : selectedSection(sections.value, sectionId);
            if (sectionId !== null && !section) return fail('INVALID_INPUT', 'Someday section is unavailable');
            const groupTitle = section?.title ?? tFallback(deps.t, 'viewSections.noSection', 'No section');
            const value = { revision: deps.revision(), sectionId, groupTitle,
                text: getSomedaySectionTaskText(deps.t, groupTitle) };
            return isNativeJsonWithinBytes(value, LIMIT) && safeJsonStrings(value) ? { ok: true, value }
                : fail('INVALID_INPUT', 'Someday task options exceed the bounded response');
        },

        prepareSomedaySectionTask(input: NativeSomedaySectionTaskRequest): NativeHostResult<{
            kind: 'prepared'; prepared: NativePreparedSomedaySectionTask;
        }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded Someday task request is required');
            const sections = rawSections();
            if (!sections.ok) return sections;
            const section = request.sectionId === null ? null : selectedSection(sections.value, request.sectionId);
            if (request.sectionId !== null && !section) return fail('INVALID_INPUT', 'Someday section is unavailable');
            const state = useTaskStore.getState();
            if (state._allTasks.some((task) => task.id === request.requestId))
                return fail('INVALID_INPUT', 'Task request ID already exists');
            if (!safeText(state.settings.deviceId, 500)) return fail('INVALID_INPUT', 'Loaded device identity is required');
            const areaId = resolveDefaultNewTaskAreaId(state.settings, state._allAreas);
            const areaMatches = areaId ? state._allAreas.filter((row) => row.id === areaId) : [];
            if (areaMatches.length > 1) return fail('INVALID_INPUT', 'Default task Area is ambiguous');
            const area = areaMatches[0];
            const prepared: NativePreparedSomedaySectionTask = {
                version: 1, request, task: {} as Task, preparedAt: new Date().toISOString(),
                deviceId: state.settings.deviceId, selectedArea: area ? { id: area.id } : null,
                sectionWitness: section, result: { id: request.requestId },
            };
            const task = expectedTask(prepared, getTaskReminderDefault(state.settings));
            if (!task) return fail('INVALID_INPUT', 'Someday task could not be prepared');
            prepared.task = task;
            const detached = detach<NativePreparedSomedaySectionTask>(JSON.parse(JSON.stringify(prepared)));
            const checked = detached ? validatePreparedSomedaySectionTask({ request, prepared: detached }) : null;
            return detached && checked?.ok ? { ok: true, value: { kind: 'prepared', prepared: detached } }
                : fail('INVALID_INPUT', checked && !checked.ok ? checked.error.message : 'Someday task exceeds the bounded journal');
        },

        validatePreparedSomedaySectionTask,

        probeSomedaySectionTaskOutcome(input: NativeSomedaySectionTaskEnvelope): NativeHostResult<NativeSomedaySectionTaskResult> {
            const checked = validatePreparedSomedaySectionTask(input);
            if (!checked.ok) return checked;
            const ready = deps.readiness();
            return ready.ok ? target(input.prepared) : ready;
        },

        async commitPreparedSomedaySectionTask(input: NativeSomedaySectionTaskEnvelope): Promise<NativeHostResult<NativeSomedaySectionTaskResult>> {
            const checked = validatePreparedSomedaySectionTask(input);
            if (!checked.ok) return checked;
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const prepared = detach<NativePreparedSomedaySectionTask>(input.prepared)!;
            const payload = JSON.stringify(['somedaySectionTask', input]);
            const outcome = await receipts.run(prepared.request.requestId, payload, async () => {
                const existing = useTaskStore.getState()._allTasks.some((task) => task.id === prepared.request.requestId);
                if (existing) return target(prepared);
                if (!sectionStillMatches(prepared)) return fail('STALE_REVISION', 'Someday section changed before task creation');
                if (prepared.selectedArea) {
                    const areas = useTaskStore.getState()._allAreas.filter((area) => area.id === prepared.selectedArea!.id);
                    if (areas.length !== 1 || areas[0].deletedAt)
                        return fail('STALE_REVISION', 'Default task Area is unavailable');
                }
                const written = await runStoreWrite(() => useTaskStore.getState().commitPreparedCapture({
                    task: prepared.task, project: null, deviceIdToInitialize: null,
                }));
                return settleWrite(written, prepared.result);
            });
            // Receipts, including durable ones, cannot acknowledge a later edit or deletion.
            return outcome.ok ? target(prepared) : outcome;
        },
    };
}
