import { resolveAreaFilterSelection } from './area-filter';
import type { NativeHostResult } from './native-host-contract';
import { detach, exact, iso, record } from './native-host-contract-project-shared';
import { isNativeJsonWithinBytes, readChecklist } from './native-host-contract-task-view';
import { logInfo } from './logger';
import { isStatusListTaskReadOnly } from './menu-views-model';
import { createNativeRequestReceipts, revisionOf, runStoreWrite, settleWrite } from './native-request-receipts';
import { buildSomedaySectionMoveDialog, formatSomedaySectionMoved, getSomedaySectionMoveTasks,
    getSomedaySectionMoveText, planSomedaySectionMove } from './someday-sections-model';
import { useTaskStore } from './store';
import { sameSectionDeleteJson, sameTaskSqliteRow } from './store-projects/section-actions';
import { nextRevision } from './sync-revision';
import { TASK_SQLITE_COLUMNS, TASK_SYNC_FIELD_SCHEMA, taskFromSqliteRow, taskToSqliteRow } from './task-sync-schema';
import type { Task, ViewSectionDefinition } from './types';
import { buildTaskViewSectionUndoUpdates, setTaskViewSectionId, sortViewSectionDefinitions } from './view-sections';

export type NativeSomedaySectionMoveRequest = {
    requestId: string; taskId: string; taskRevision: string; sectionId: string | null;
};
export type NativeSomedaySectionMoveUndoRequest = { requestId: string; moveRequestId: string };
export type NativeSomedaySectionMoveResult = { id: string; changed: boolean; sectionId: string | null };
type MapChange = { viewSectionIds: NonNullable<Task['viewSectionIds']> };
export type NativePreparedSomedaySectionMove = {
    version: 1; kind: 'move'; request: NativeSomedaySectionMoveRequest;
    before: Task; changes: MapChange;
    deviceId: string; sectionWitness: ViewSectionDefinition | null;
    result: NativeSomedaySectionMoveResult;
};
export type NativeSomedaySectionMoveEnvelope = { request: NativeSomedaySectionMoveRequest; prepared: NativePreparedSomedaySectionMove };
export type NativePreparedSomedaySectionMoveUndo = {
    version: 1; kind: 'undo'; request: NativeSomedaySectionMoveUndoRequest;
    move: NativeSomedaySectionMoveEnvelope;
    before: Task; changes: MapChange;
    deviceId: string; result: NativeSomedaySectionMoveResult;
};
export type NativeSomedaySectionMoveUndoEnvelope = {
    request: NativeSomedaySectionMoveUndoRequest; prepared: NativePreparedSomedaySectionMoveUndo;
};

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const LIMIT = 1_000_000;
const TASK_KEYS = new Set(TASK_SYNC_FIELD_SCHEMA.map((field) => field.name));
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
const nonempty = (value: unknown, max: number): value is string => safeString(value, max) && value.length > 0;
const safeJsonStrings = (value: unknown): boolean => {
    if (typeof value === 'string') return safeString(value, LIMIT);
    if (Array.isArray(value)) return value.every(safeJsonStrings);
    return !record(value) || Object.entries(value).every(([key, part]) => safeString(key, LIMIT) && safeJsonStrings(part));
};
const detached = <T>(value: unknown): T | null => {
    if (!isNativeJsonWithinBytes(value, LIMIT)) return null;
    const copy = detach<T>(value);
    return copy && safeJsonStrings(copy) ? copy : null;
};
const readMoveRequest = (value: unknown): NativeSomedaySectionMoveRequest | null => {
    const input = detached<Record<string, unknown>>(value);
    return input && exact(input, ['requestId', 'taskId', 'taskRevision', 'sectionId'])
        && typeof input.requestId === 'string' && UUID.test(input.requestId)
        && nonempty(input.taskId, 500) && nonempty(input.taskRevision, 200)
        && (input.sectionId === null || nonempty(input.sectionId, 500))
        ? input as NativeSomedaySectionMoveRequest : null;
};
const readUndoRequest = (value: unknown): NativeSomedaySectionMoveUndoRequest | null => {
    const input = detached<Record<string, unknown>>(value);
    return input && exact(input, ['requestId', 'moveRequestId'])
        && typeof input.requestId === 'string' && UUID.test(input.requestId)
        && typeof input.moveRequestId === 'string' && UUID.test(input.moveRequestId)
        && input.requestId !== input.moveRequestId
        ? input as NativeSomedaySectionMoveUndoRequest : null;
};
const rawSections = (): NativeHostResult<ViewSectionDefinition[]> => {
    const gtd = useTaskStore.getState().settings.gtd;
    if (gtd === undefined) return { ok: true, value: [] };
    if (!record(gtd)) return fail('INVALID_INPUT', 'Stored Someday sections are malformed');
    if (gtd.viewSections === undefined) return { ok: true, value: [] };
    if (!record(gtd.viewSections)) return fail('INVALID_INPUT', 'Stored Someday sections are malformed');
    const raw = gtd.viewSections.someday;
    if (raw === undefined) return { ok: true, value: [] };
    const sections = detached<ViewSectionDefinition[]>(raw);
    return Array.isArray(raw) && sections ? { ok: true, value: sections }
        : fail('INVALID_INPUT', 'Stored Someday sections are malformed');
};
const selectedSection = (raw: readonly ViewSectionDefinition[], id: string): ViewSectionDefinition | null => {
    const matching = raw.filter((row) => record(row) && row.id === id);
    return matching.length === 1 && sortViewSectionDefinitions(raw).includes(matching[0]) ? matching[0] : null;
};
const validTaskField = (name: keyof Task, value: unknown): boolean => {
    if (value === undefined || value === null) return true;
    if (name === 'viewSectionIds') return validMap(value);
    if (name === 'checklist') return readChecklist(value, true) !== null;
    if (name === 'attachments') return Array.isArray(value) && value.every((item) => record(item)
        && nonempty(item.id, 500) && (item.kind === 'file' || item.kind === 'link')
        && safeString(item.title, LIMIT) && safeString(item.uri, LIMIT)
        && (item.createdAt === undefined || safeString(item.createdAt, LIMIT))
        && (item.updatedAt === undefined || safeString(item.updatedAt, LIMIT)));
    if (name === 'relativeStartOffset') return record(value);
    if (name === 'recurrence') return typeof value === 'string' || record(value);
    if (name === 'boardOrder') return typeof value === 'number' && Number.isFinite(value);
    const kind = TASK_SYNC_FIELD_SCHEMA.find((field) => field.name === name)?.cloudKit?.kind;
    switch (kind) {
        case 'boolean': return typeof value === 'boolean';
        case 'integer': return typeof value === 'number' && Number.isFinite(value);
        case 'string-array': return Array.isArray(value) && value.every((item) => safeString(item, LIMIT));
        case 'string':
        case 'date': return safeString(value, LIMIT);
        default: return true;
    }
};
const validTask = (value: unknown, id: string): value is Task => {
    if (!record(value) || Object.keys(value).some((key) => !TASK_KEYS.has(key as keyof Task))
        || value.id !== id || !nonempty(value.title, LIMIT) || value.status !== 'someday'
        || !iso(value.createdAt) || !iso(value.updatedAt)
        || (value.rev !== undefined && (!Number.isSafeInteger(value.rev) || (value.rev as number) < 0))
        || (value.revBy !== undefined && !safeString(value.revBy, 500))
        || value.deletedAt !== undefined || value.purgedAt !== undefined
        || Object.entries(value).some(([key, part]) => !validTaskField(key as keyof Task, part))
        || !Array.isArray(value.tags) || !Array.isArray(value.contexts)
        || (value.viewSectionIds !== undefined && !validMap(value.viewSectionIds))) return false;
    try { taskToSqliteRow(value as unknown as Task); return true; } catch { return false; }
};
const validMap = (value: unknown): value is NonNullable<Task['viewSectionIds']> => record(value)
    && Object.entries(value).every(([key, part]) => nonempty(key, 500) && nonempty(part, 500));
const hydrated = (task: Task): Task => {
    const row = taskToSqliteRow(task);
    return taskFromSqliteRow(Object.fromEntries(TASK_SQLITE_COLUMNS.map((column, index) => [column, row[index]])));
};
const persistedSame = (left: Task, right: Task): boolean => {
    try { return sameTaskSqliteRow(hydrated(left), hydrated(right)); }
    catch { return false; }
};
const eligibleTasks = (ids: readonly string[]): Task[] | null => {
    const state = useTaskStore.getState();
    const tasks = getSomedaySectionMoveTasks({ tasks: state.tasks, projects: state.projects,
        areas: state.areas, ids,
        resolvedAreaFilter: resolveAreaFilterSelection(state.settings.filters, state.areas) });
    if (!tasks) return null;
    const wanted = new Set(ids);
    const stored = new Map<string, number>();
    for (const row of state._allTasks) if (wanted.has(row.id)) stored.set(row.id, (stored.get(row.id) ?? 0) + 1);
    return tasks.every((task) => !isStatusListTaskReadOnly(task, state._allProjects) && stored.get(task.id) === 1) ? tasks : null;
};
const eligibleTask = (id: string): Task | null => eligibleTasks([id])?.[0] ?? null;
const moveChanges = (before: Task, sectionId: string | null): MapChange | null => {
    const planned = planSomedaySectionMove({ ids: [before.id], tasks: [before], destination: sectionId ?? undefined });
    return planned.updates.length === 1 && planned.updates[0].updates.viewSectionIds
        ? { viewSectionIds: planned.updates[0].updates.viewSectionIds } : null;
};
const undoChanges = (before: Task, move: NativeSomedaySectionMoveEnvelope): MapChange | null => {
    const previous = [{ id: before.id, sectionId: move.prepared.before.viewSectionIds?.someday }];
    const planned = buildTaskViewSectionUndoUpdates([before], 'someday', previous, move.request.sectionId ?? undefined);
    return planned.length === 1 && planned[0].updates.viewSectionIds
        ? { viewSectionIds: planned[0].updates.viewSectionIds } : null;
};
const readMoveEnvelope = (value: unknown): NativeSomedaySectionMoveEnvelope | null => {
    const envelope = detached<Record<string, unknown>>(value);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readMoveRequest(envelope.request);
    const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'kind', 'request', 'before', 'changes', 'deviceId', 'sectionWitness', 'result'])
        || raw.version !== 1 || raw.kind !== 'move' || !sameSectionDeleteJson(raw.request, request)
        || !validTask(raw.before, request.taskId) || revisionOf(raw.before) !== request.taskRevision
        || !nonempty(raw.deviceId, 500) || !record(raw.changes)
        || !exact(raw.changes, ['viewSectionIds']) || !validMap(raw.changes.viewSectionIds)
        || !record(raw.result) || !exact(raw.result, ['id', 'changed', 'sectionId'])
        || raw.result.id !== request.taskId || raw.result.changed !== true
        || raw.result.sectionId !== request.sectionId) return null;
    if (request.sectionId === null ? raw.sectionWitness !== null
        : !record(raw.sectionWitness) || raw.sectionWitness.id !== request.sectionId
            || !selectedSection([raw.sectionWitness as unknown as ViewSectionDefinition], request.sectionId)) return null;
    const expected = moveChanges(raw.before, request.sectionId);
    return expected && sameSectionDeleteJson(raw.changes, expected)
        ? envelope as unknown as NativeSomedaySectionMoveEnvelope : null;
};
const readUndoEnvelope = (value: unknown): NativeSomedaySectionMoveUndoEnvelope | null => {
    const envelope = detached<Record<string, unknown>>(value);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readUndoRequest(envelope.request);
    const raw = envelope.prepared;
    const move = readMoveEnvelope(raw.move);
    if (!request || !exact(raw, ['version', 'kind', 'request', 'move', 'before', 'changes', 'deviceId', 'result'])
        || raw.version !== 1 || raw.kind !== 'undo' || !sameSectionDeleteJson(raw.request, request)
        || !move || !sameSectionDeleteJson(raw.move, move)
        || request.moveRequestId !== move.request.requestId
        || !validTask(raw.before, move.request.taskId) || (raw.before.rev ?? 0) < nextRevision(move.prepared.before.rev)
        || !nonempty(raw.deviceId, 500)
        || !record(raw.changes) || !exact(raw.changes, ['viewSectionIds']) || !validMap(raw.changes.viewSectionIds)
        || !record(raw.result) || !exact(raw.result, ['id', 'changed', 'sectionId'])
        || raw.result.id !== move.request.taskId || raw.result.changed !== true
        || raw.result.sectionId !== (move.prepared.before.viewSectionIds?.someday ?? null)) return null;
    const expected = undoChanges(raw.before, move);
    return expected && sameSectionDeleteJson(raw.changes, expected)
        ? envelope as unknown as NativeSomedaySectionMoveUndoEnvelope : null;
};


export const validatePreparedSomedaySectionMove = (value: unknown): NativeHostResult<NativeSomedaySectionMoveResult> => {
    const envelope = readMoveEnvelope(value);
    return envelope ? { ok: true, value: envelope.prepared.result }
        : fail('INVALID_INPUT', 'Prepared Someday section move is malformed');
};

export const validatePreparedSomedaySectionMoveUndo = (value: unknown): NativeHostResult<NativeSomedaySectionMoveResult> => {
    const envelope = readUndoEnvelope(value);
    return envelope ? { ok: true, value: envelope.prepared.result }
        : fail('INVALID_INPUT', 'Prepared Someday section Undo is malformed');
};

export function createSomedaySectionMoveMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    revision: () => string;
    t: () => (key: string) => string;
}) {
    const durableSave = async (): Promise<NativeHostResult<null>> => {
        try { if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence(); }
        catch (error) { return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error)); }
        return deps.save();
    };
    const receipts = createNativeRequestReceipts({ save: durableSave });
    const target = (before: Task, changes: MapChange, deviceId: string,
        result: NativeSomedaySectionMoveResult): NativeHostResult<NativeSomedaySectionMoveResult> => {
        const matches = useTaskStore.getState()._allTasks.filter((task) => task.id === before.id);
        const current = matches.length === 1 ? matches[0] : null;
        return current && !current.deletedAt && !current.purgedAt && current.status === 'someday'
            && current.rev === nextRevision(before.rev) && current.revBy === deviceId
            && sameSectionDeleteJson(current.viewSectionIds ?? null, changes.viewSectionIds)
            && persistedSame({ ...current, viewSectionIds: before.viewSectionIds,
                rev: before.rev, revBy: before.revBy, updatedAt: before.updatedAt }, before)
            ? { ok: true, value: result }
            : fail('STALE_REVISION', 'Someday section move outcome is not present');
    };
    const applied = (prepared: NativePreparedSomedaySectionMove | NativePreparedSomedaySectionMoveUndo) =>
        target(prepared.before, prepared.changes, prepared.deviceId, prepared.result);
    const firstApply = async (prepared: NativePreparedSomedaySectionMove | NativePreparedSomedaySectionMoveUndo): Promise<NativeHostResult<NativeSomedaySectionMoveResult> | ReturnType<typeof settleWrite<NativeSomedaySectionMoveResult>>> => {
        const state = useTaskStore.getState();
        const matches = state._allTasks.filter((task) => task.id === prepared.before.id);
        if (matches.length !== 1 || !persistedSame(matches[0], prepared.before))
            return fail('STALE_REVISION', 'Someday task changed before its section move');
        if (prepared.kind === 'move') {
            if (!eligibleTask(prepared.request.taskId)) return fail('STALE_REVISION', 'Someday task is no longer eligible');
            const sections = rawSections();
            if (!sections.ok) return sections;
            if (prepared.request.sectionId !== null) {
                const section = selectedSection(sections.value, prepared.request.sectionId);
                if (!section || !sameSectionDeleteJson(section, prepared.sectionWitness))
                    return fail('STALE_REVISION', 'Someday section changed before the move');
            }
        } else if (matches[0].status !== 'someday'
            || isStatusListTaskReadOnly(matches[0], state._allProjects)
            || (matches[0].viewSectionIds?.someday ?? null) !== prepared.move.request.sectionId) {
            return fail('STALE_REVISION', 'Someday task moved since Undo preparation');
        }
        if (state.settings.deviceId !== prepared.deviceId)
            return fail('STALE_REVISION', 'Device identity changed before the move');
        const written = await runStoreWrite(() => useTaskStore.getState().commitPreparedTaskEdit({
            before: prepared.before, changes: prepared.changes,
        }));
        return settleWrite(written, prepared.result);
    };
    const commit = async (envelope: NativeSomedaySectionMoveEnvelope | NativeSomedaySectionMoveUndoEnvelope) => {
        const prepared = envelope.prepared;
        const payload = JSON.stringify([prepared.kind === 'move' ? 'somedaySectionMove' : 'somedaySectionMoveUndo', envelope]);
        const outcome = await receipts.run(prepared.request.requestId, payload, async () => {
            const existing = useTaskStore.getState()._allTasks.some((task) => task.id === prepared.before.id);
            if (existing && applied(prepared).ok) return applied(prepared);
            return firstApply(prepared);
        });
        return outcome.ok ? applied(prepared) : outcome;
    };
    return {
        getSomedaySectionMoveOptions(input: { taskId: string; offset?: number; limit?: number; revision?: string }): NativeHostResult<{
            revision: string; taskId: string; taskRevision: string; title: string;
            choices: { total: number; items: Array<{ sectionId: string | null; title: string; selected: boolean; toast: string }> };
            cancelLabel: string; undoLabel: string; errorTitle: string; moveFailed: string; undoFailed: string;
        }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = detached<Record<string, unknown>>(input);
            if (!request || !Object.keys(request).every((key) => ['taskId', 'offset', 'limit', 'revision'].includes(key))
                || !nonempty(request.taskId, 500)
                || (request.offset !== undefined && (!Number.isSafeInteger(request.offset) || (request.offset as number) < 0))
                || (request.limit !== undefined && (!Number.isSafeInteger(request.limit) || (request.limit as number) < 1
                    || (request.limit as number) > 100))
                || (request.revision !== undefined && !nonempty(request.revision, 500))
                || ((request.offset as number | undefined ?? 0) > 0 && request.revision === undefined))
                return fail('INVALID_INPUT', 'A bounded Someday task and window are required');
            const task = eligibleTask(request.taskId);
            if (!task) return fail('INVALID_INPUT', 'Someday task is unavailable');
            if (!nonempty(revisionOf(task), 200)) return fail('INVALID_INPUT', 'Someday task revision is too large');
            const sections = rawSections();
            if (!sections.ok) return sections;
            const dialog = buildSomedaySectionMoveDialog([task], sections.value, deps.t());
            if (dialog.choices.some((row) => row.sectionId !== null && !selectedSection(sections.value, row.sectionId)))
                return fail('INVALID_INPUT', 'Someday sections are ambiguous');
            const revision = deps.revision();
            if (request.revision !== undefined && request.revision !== revision)
                return fail('STALE_REVISION', 'Someday move choices changed');
            const offset = request.offset as number | undefined ?? 0;
            const limit = request.limit as number | undefined ?? 100;
            const text = getSomedaySectionMoveText(deps.t());
            const value = { revision, taskId: task.id, taskRevision: revisionOf(task), title: dialog.title,
                choices: { total: dialog.choices.length, items: dialog.choices.slice(offset, offset + limit).map((row) => ({
                    ...row, toast: formatSomedaySectionMoved(deps.t(), 1, row.sectionId === null ? undefined : row.title),
                })) }, cancelLabel: dialog.cancelLabel, ...text };
            return isNativeJsonWithinBytes(value, LIMIT) && safeJsonStrings(value)
                ? { ok: true, value } : fail('INVALID_INPUT', 'Someday move choices exceed the bounded response');
        },

        prepareSomedaySectionMove(input: NativeSomedaySectionMoveRequest): NativeHostResult<{
            kind: 'noop'; result: NativeSomedaySectionMoveResult;
        } | { kind: 'prepared'; prepared: NativePreparedSomedaySectionMove }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readMoveRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded Someday move request is required');
            const before = eligibleTask(request.taskId);
            if (!before || revisionOf(before) !== request.taskRevision)
                return fail('STALE_REVISION', 'Someday task changed before the move');
            const sections = rawSections();
            if (!sections.ok) return sections;
            const section = request.sectionId === null ? null : selectedSection(sections.value, request.sectionId);
            if (request.sectionId !== null && !section) return fail('INVALID_INPUT', 'Someday section is unavailable');
            const result: NativeSomedaySectionMoveResult = { id: before.id, changed: true, sectionId: request.sectionId };
            const changes = moveChanges(before, request.sectionId);
            if (!changes) return { ok: true, value: { kind: 'noop', result: { ...result, changed: false } } };
            const deviceId = useTaskStore.getState().settings.deviceId;
            if (!nonempty(deviceId, 500)) return fail('INVALID_INPUT', 'Loaded device identity is required');
            const prepared: NativePreparedSomedaySectionMove = { version: 1, kind: 'move', request,
                before, changes, deviceId, sectionWitness: section, result };
            const frozen = detached<NativePreparedSomedaySectionMove>(JSON.parse(JSON.stringify(prepared)));
            return frozen && readMoveEnvelope({ request, prepared: frozen })
                ? { ok: true, value: { kind: 'prepared', prepared: frozen } }
                : fail('INVALID_INPUT', 'Someday move exceeds the bounded journal');
        },

        validatePreparedSomedaySectionMove,
        probeSomedaySectionMoveOutcome(input: NativeSomedaySectionMoveEnvelope): NativeHostResult<NativeSomedaySectionMoveResult> {
            const envelope = readMoveEnvelope(input);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared Someday section move is malformed');
            const ready = deps.readiness();
            return ready.ok ? applied(envelope.prepared) : ready;
        },
        async commitPreparedSomedaySectionMove(input: NativeSomedaySectionMoveEnvelope): Promise<NativeHostResult<NativeSomedaySectionMoveResult>> {
            const envelope = readMoveEnvelope(input);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared Someday section move is malformed');
            const ready = deps.readiness();
            return ready.ok ? commit(envelope) : ready;
        },

        prepareSomedaySectionMoveUndo(input: { request: NativeSomedaySectionMoveUndoRequest; move: NativeSomedaySectionMoveEnvelope }): NativeHostResult<{
            kind: 'noop'; result: NativeSomedaySectionMoveResult;
        } | { kind: 'prepared'; prepared: NativePreparedSomedaySectionMoveUndo }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const outer = detached<Record<string, unknown>>(input);
            if (!outer || !exact(outer, ['request', 'move']))
                return fail('INVALID_INPUT', 'A confirmed Someday move and new Undo UUID are required');
            const request = readUndoRequest(outer.request);
            const move = readMoveEnvelope(outer.move);
            if (!request || !move || request.moveRequestId !== move.request.requestId)
                return fail('INVALID_INPUT', 'A confirmed Someday move and new Undo UUID are required');
            const state = useTaskStore.getState();
            const matches = state._allTasks.filter((task) => task.id === move.request.taskId);
            const task = matches.length === 1 ? matches[0] : null;
            const result: NativeSomedaySectionMoveResult = {
                id: move.request.taskId, changed: true,
                sectionId: move.prepared.before.viewSectionIds?.someday ?? null,
            };
            if (!task || task.deletedAt || task.purgedAt || task.status !== 'someday')
                return { ok: true, value: { kind: 'noop', result: { ...result, changed: false } } };
            if (isStatusListTaskReadOnly(task, state._allProjects))
                return fail('STALE_REVISION', 'Someday task is no longer editable');
            const changes = undoChanges(task, move);
            if (!changes) return { ok: true, value: { kind: 'noop', result: { ...result, changed: false } } };
            const deviceId = state.settings.deviceId;
            if (!nonempty(deviceId, 500)) return fail('INVALID_INPUT', 'Loaded device identity is required');
            const prepared: NativePreparedSomedaySectionMoveUndo = { version: 1, kind: 'undo', request,
                move, before: task, changes, deviceId, result };
            const frozen = detached<NativePreparedSomedaySectionMoveUndo>(JSON.parse(JSON.stringify(prepared)));
            return frozen && readUndoEnvelope({ request, prepared: frozen })
                ? { ok: true, value: { kind: 'prepared', prepared: frozen } }
                : fail('INVALID_INPUT', 'Someday Undo exceeds the bounded journal');
        },

        validatePreparedSomedaySectionMoveUndo,
        probeSomedaySectionMoveUndoOutcome(input: NativeSomedaySectionMoveUndoEnvelope): NativeHostResult<NativeSomedaySectionMoveResult> {
            const envelope = readUndoEnvelope(input);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared Someday section Undo is malformed');
            const ready = deps.readiness();
            return ready.ok ? applied(envelope.prepared) : ready;
        },
        async commitPreparedSomedaySectionMoveUndo(input: NativeSomedaySectionMoveUndoEnvelope): Promise<NativeHostResult<NativeSomedaySectionMoveResult>> {
            const envelope = readUndoEnvelope(input);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared Someday section Undo is malformed');
            const ready = deps.readiness();
            return ready.ok ? commit(envelope) : ready;
        },
    };
}

export type NativeSomedaySectionBulkMoveRequest = {
    requestId: string; taskIds: string[]; taskRevisions: Record<string, string>; sectionId: string | null;
};
export type NativeSomedaySectionBulkMoveResult = { taskIds: string[]; changed: boolean; sectionId: string | null };
export type NativeSomedaySectionBulkMoveUndoResult = { taskIds: string[]; changed: boolean };
type SectionMap = NonNullable<Task['viewSectionIds']>;
type BulkRow = { id: string; revision: string; before: SectionMap | null; after: SectionMap };
export type NativePreparedSomedaySectionBulkMove = {
    version: 1; kind: 'move'; request: NativeSomedaySectionBulkMoveRequest; rows: BulkRow[];
    deviceId: string; sectionWitness: ViewSectionDefinition | null; result: NativeSomedaySectionBulkMoveResult;
};
export type NativeSomedaySectionBulkMoveEnvelope = {
    request: NativeSomedaySectionBulkMoveRequest; prepared: NativePreparedSomedaySectionBulkMove;
};
export type NativePreparedSomedaySectionBulkMoveUndo = {
    version: 1; kind: 'undo'; request: NativeSomedaySectionMoveUndoRequest; move: NativeSomedaySectionBulkMoveEnvelope;
    rows: BulkRow[]; deviceId: string; result: NativeSomedaySectionBulkMoveUndoResult;
};
export type NativeSomedaySectionBulkMoveUndoEnvelope = {
    request: NativeSomedaySectionMoveUndoRequest; prepared: NativePreparedSomedaySectionBulkMoveUndo;
};

const BULK_TASKS = 10_000;
const BULK_MOVE_BYTES = 4_000_000;
const BULK_UNDO_BYTES = 8_100_000;
const bulkDetached = <T>(value: unknown, limit: number): T | null => {
    const valid = (item: unknown, depth: number): boolean => depth <= 24 && (item === null
        || typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))
        || (Array.isArray(item) && item.length <= 100_000 && item.every((part) => valid(part, depth + 1)))
        || (record(item) && [Object.prototype, null].includes(Object.getPrototypeOf(item))
            && Object.entries(item).every(([key, part]) => !['__proto__', 'constructor', 'prototype'].includes(key)
                && valid(part, depth + 1))));
    if (!isNativeJsonWithinBytes(value, limit) || !valid(value, 0)) return null;
    const copy = JSON.parse(JSON.stringify(value)) as T;
    return safeJsonStrings(copy) ? copy : null;
};
const somedayOf = (map: SectionMap | null | undefined): string | undefined => map?.someday || undefined;
const revOf = (revision: string): number | null => {
    const match = /^(\d{1,15}):/.exec(revision);
    return match ? Number(match[1]) : null;
};
const readBulkMoveRequest = (value: unknown): NativeSomedaySectionBulkMoveRequest | null => {
    const input = bulkDetached<Record<string, unknown>>(value, BULK_MOVE_BYTES);
    if (!input || !exact(input, ['requestId', 'taskIds', 'taskRevisions', 'sectionId'])
        || typeof input.requestId !== 'string' || !UUID.test(input.requestId)
        || !Array.isArray(input.taskIds) || !input.taskIds.length || input.taskIds.length > BULK_TASKS
        || !input.taskIds.every((id) => nonempty(id, 500)) || new Set(input.taskIds).size !== input.taskIds.length
        || !record(input.taskRevisions) || !exact(input.taskRevisions, input.taskIds as string[])
        || !Object.values(input.taskRevisions).every((revision) => nonempty(revision, 200))
        || !(input.sectionId === null || nonempty(input.sectionId, 500))) return null;
    return input as NativeSomedaySectionBulkMoveRequest;
};
const readBulkRows = (value: unknown, ids: readonly string[], moved: (row: BulkRow) => boolean,
    destination: (id: string) => string | undefined): BulkRow[] | null => {
    if (!Array.isArray(value) || !value.length || value.length > ids.length) return null;
    const order = new Map(ids.map((id, index) => [id, index]));
    let last = -1;
    for (const row of value) {
        if (!record(row) || !exact(row, ['id', 'revision', 'before', 'after']) || typeof row.id !== 'string'
            || (order.get(row.id) ?? -1) <= last || !nonempty(row.revision, 200) || revOf(row.revision) === null
            || !(row.before === null || validMap(row.before)) || !validMap(row.after)) return null;
        last = order.get(row.id)!;
        const typed = row as BulkRow;
        const target = destination(typed.id);
        if (!moved(typed) || somedayOf(typed.before) === target
            || !sameSectionDeleteJson(typed.after, setTaskViewSectionId(typed.before ?? undefined, 'someday', target))) return null;
    }
    return value as BulkRow[];
};
const readBulkMoveEnvelope = (value: unknown): NativeSomedaySectionBulkMoveEnvelope | null => {
    const envelope = bulkDetached<Record<string, unknown>>(value, BULK_MOVE_BYTES);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readBulkMoveRequest(envelope.request);
    const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'kind', 'request', 'rows', 'deviceId', 'sectionWitness', 'result'])
        || raw.version !== 1 || raw.kind !== 'move' || !sameSectionDeleteJson(raw.request, request)
        || !nonempty(raw.deviceId, 500)) return null;
    const rows = readBulkRows(raw.rows, request.taskIds,
        (row) => request.taskRevisions[row.id] === row.revision, () => request.sectionId ?? undefined);
    if (!rows || !sameSectionDeleteJson(raw.result, { taskIds: rows.map((row) => row.id), changed: true, sectionId: request.sectionId }))
        return null;
    if (request.sectionId === null ? raw.sectionWitness !== null
        : !record(raw.sectionWitness) || raw.sectionWitness.id !== request.sectionId
            || !selectedSection([raw.sectionWitness as unknown as ViewSectionDefinition], request.sectionId)) return null;
    return envelope as unknown as NativeSomedaySectionBulkMoveEnvelope;
};
const readBulkUndoEnvelope = (value: unknown): NativeSomedaySectionBulkMoveUndoEnvelope | null => {
    const envelope = bulkDetached<Record<string, unknown>>(value, BULK_UNDO_BYTES);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readUndoRequest(envelope.request);
    const raw = envelope.prepared;
    const move = readBulkMoveEnvelope(raw.move);
    if (!request || !move || !exact(raw, ['version', 'kind', 'request', 'move', 'rows', 'deviceId', 'result'])
        || raw.version !== 1 || raw.kind !== 'undo' || !sameSectionDeleteJson(raw.request, request)
        || request.moveRequestId !== move.request.requestId || !nonempty(raw.deviceId, 500)) return null;
    const moved = new Map(move.prepared.rows.map((row) => [row.id, row]));
    const rows = readBulkRows(raw.rows, move.prepared.rows.map((row) => row.id),
        (row) => somedayOf(row.before) === (move.request.sectionId ?? undefined)
            && (revOf(row.revision) ?? 0) >= nextRevision(revOf(moved.get(row.id)!.revision)),
        (id) => somedayOf(moved.get(id)!.before));
    return rows && sameSectionDeleteJson(raw.result, { taskIds: rows.map((row) => row.id), changed: true })
        ? envelope as unknown as NativeSomedaySectionBulkMoveUndoEnvelope : null;
};

/** Pure cold-journal validation before SQLite opens. */
export const validatePreparedSomedaySectionBulkMove = (value: unknown): NativeHostResult<NativeSomedaySectionBulkMoveResult> => {
    const envelope = readBulkMoveEnvelope(value);
    return envelope ? { ok: true, value: envelope.prepared.result }
        : fail('INVALID_INPUT', 'Prepared Someday bulk section move is malformed');
};
/** Pure cold-journal validation before SQLite opens. */
export const validatePreparedSomedaySectionBulkMoveUndo = (value: unknown): NativeHostResult<NativeSomedaySectionBulkMoveUndoResult> => {
    const envelope = readBulkUndoEnvelope(value);
    return envelope ? { ok: true, value: envelope.prepared.result }
        : fail('INVALID_INPUT', 'Prepared Someday bulk section Undo is malformed');
};

export function createSomedaySectionBulkMoveMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    revision: () => string;
    t: () => (key: string) => string;
}) {
    const durableSave = async (): Promise<NativeHostResult<null>> => {
        try { if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence(); }
        catch (error) { return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error)); }
        return deps.save();
    };
    const receipts = createNativeRequestReceipts({ save: durableSave });
    type Prepared = NativePreparedSomedaySectionBulkMove | NativePreparedSomedaySectionBulkMoveUndo;
    const currentRow = (id: string): Task | null => {
        const matches = useTaskStore.getState()._allTasks.filter((task) => task.id === id);
        return matches.length === 1 ? matches[0] : null;
    };
    const applied = <T extends Prepared>(prepared: T): NativeHostResult<T['result']> => prepared.rows.every((row) => {
        const current = currentRow(row.id);
        return current && !current.deletedAt && !current.purgedAt && current.status === 'someday'
            && current.rev === nextRevision(revOf(row.revision)) && current.revBy === prepared.deviceId
            && sameSectionDeleteJson(current.viewSectionIds ?? null, row.after);
    }) ? { ok: true, value: prepared.result } : fail('STALE_REVISION', 'Someday bulk section move outcome is not present');
    const firstApply = async (prepared: Prepared) => {
        const state = useTaskStore.getState();
        const before: Task[] = [];
        for (const row of prepared.rows) {
            const current = currentRow(row.id);
            if (!current || revisionOf(current) !== row.revision || current.deletedAt || current.purgedAt
                || current.status !== 'someday' || isStatusListTaskReadOnly(current, state._allProjects)
                || !sameSectionDeleteJson(current.viewSectionIds ?? null, row.before))
                return fail('STALE_REVISION', 'Someday task changed before its section move');
            before.push(current);
        }
        if (prepared.kind === 'move') {
            if (!eligibleTasks(prepared.rows.map((row) => row.id))) return fail('STALE_REVISION', 'Someday tasks are no longer eligible');
            const sections = rawSections();
            if (!sections.ok) return sections;
            if (prepared.request.sectionId !== null) {
                const section = selectedSection(sections.value, prepared.request.sectionId);
                if (!section || !sameSectionDeleteJson(section, prepared.sectionWitness))
                    return fail('STALE_REVISION', 'Someday section changed before the move');
            }
        }
        if (state.settings.deviceId !== prepared.deviceId)
            return fail('STALE_REVISION', 'Device identity changed before the move');
        const written = await runStoreWrite(() => useTaskStore.getState().commitPreparedTaskEdits(
            before.map((task, index) => ({ before: task, changes: { viewSectionIds: prepared.rows[index].after } }))));
        return settleWrite(written, prepared.result);
    };
    const commit = async <T extends Prepared>(envelope: { request: T['request']; prepared: T }): Promise<NativeHostResult<T['result']>> => {
        const prepared = envelope.prepared;
        const payload = JSON.stringify([prepared.kind === 'move' ? 'somedaySectionBulkMove' : 'somedaySectionBulkMoveUndo', envelope]);
        const outcome = await receipts.run(prepared.request.requestId, payload, async () => {
            const done = applied(prepared);
            return done.ok ? done : firstApply(prepared);
        });
        const confirmed = outcome.ok ? applied(prepared) : outcome;
        if (!confirmed.ok) return confirmed;
        try {
            logInfo('Native Someday bulk section move confirmed', { scope: 'native-host', category: 'storage', force: true,
                context: { releaseCheck: 'v1.3.8/ios-someday-section-bulk-move', operation: prepared.kind,
                    count: prepared.result.taskIds.length, outcome: 'confirmed' } });
        } catch {
            return confirmed;
        }
        return confirmed;
    };
    const frozen = <T>(prepared: T, valid: (envelope: unknown) => unknown, request: unknown, limit: number): T | null => {
        const copy = bulkDetached<T>(JSON.parse(JSON.stringify(prepared)), limit);
        return copy && valid({ request, prepared: copy }) ? copy : null;
    };
    return {
        getSomedaySectionBulkMoveOptions(input: { taskIds: string[]; offset?: number; limit?: number; revision?: string }): NativeHostResult<{
            revision: string; taskIds: string[]; taskRevisions: Record<string, string>; title: string;
            choices: { total: number; items: Array<{ sectionId: string | null; title: string; selected: boolean; toast: string }> };
            cancelLabel: string; undoLabel: string; errorTitle: string; moveFailed: string; undoFailed: string;
        }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = bulkDetached<Record<string, unknown>>(input, BULK_MOVE_BYTES);
            if (!request || !Object.keys(request).every((key) => ['taskIds', 'offset', 'limit', 'revision'].includes(key))
                || !Array.isArray(request.taskIds) || !request.taskIds.length || request.taskIds.length > BULK_TASKS
                || !request.taskIds.every((id) => nonempty(id, 500)) || new Set(request.taskIds).size !== request.taskIds.length
                || (request.offset !== undefined && (!Number.isSafeInteger(request.offset) || (request.offset as number) < 0))
                || (request.limit !== undefined && (!Number.isSafeInteger(request.limit) || (request.limit as number) < 1
                    || (request.limit as number) > 100))
                || (request.revision !== undefined && !nonempty(request.revision, 500))
                || ((request.offset as number | undefined ?? 0) > 0 && request.revision === undefined))
                return fail('INVALID_INPUT', 'Bounded Someday tasks and a window are required');
            const tasks = eligibleTasks(request.taskIds as string[]);
            if (!tasks) return fail('INVALID_INPUT', 'Someday tasks are unavailable');
            const taskRevisions = Object.fromEntries(tasks.map((task) => [task.id, revisionOf(task)]));
            if (!Object.values(taskRevisions).every((revision) => nonempty(revision, 200)))
                return fail('INVALID_INPUT', 'Someday task revision is too large');
            const sections = rawSections();
            if (!sections.ok) return sections;
            const dialog = buildSomedaySectionMoveDialog(tasks, sections.value, deps.t());
            if (dialog.choices.some((row) => row.sectionId !== null && !selectedSection(sections.value, row.sectionId)))
                return fail('INVALID_INPUT', 'Someday sections are ambiguous');
            const revision = deps.revision();
            if (request.revision !== undefined && request.revision !== revision)
                return fail('STALE_REVISION', 'Someday move choices changed');
            const offset = request.offset as number | undefined ?? 0;
            const limit = request.limit as number | undefined ?? 100;
            const moving = (sectionId: string | null) => tasks.filter((task) => somedayOf(task.viewSectionIds) !== (sectionId ?? undefined)).length;
            const value = { revision, taskIds: tasks.map((task) => task.id), taskRevisions, title: dialog.title,
                choices: { total: dialog.choices.length, items: dialog.choices.slice(offset, offset + limit).map((row) => ({
                    ...row, toast: formatSomedaySectionMoved(deps.t(), moving(row.sectionId), row.sectionId === null ? undefined : row.title),
                })) }, cancelLabel: dialog.cancelLabel, ...getSomedaySectionMoveText(deps.t()) };
            return isNativeJsonWithinBytes(value, BULK_MOVE_BYTES) && safeJsonStrings(value)
                ? { ok: true, value } : fail('INVALID_INPUT', 'Someday move choices exceed the bounded response');
        },

        prepareSomedaySectionBulkMove(input: NativeSomedaySectionBulkMoveRequest): NativeHostResult<{
            kind: 'noop'; result: NativeSomedaySectionBulkMoveResult;
        } | { kind: 'prepared'; prepared: NativePreparedSomedaySectionBulkMove }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readBulkMoveRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded Someday bulk move request is required');
            const tasks = eligibleTasks(request.taskIds);
            if (!tasks || tasks.some((task) => revisionOf(task) !== request.taskRevisions[task.id]))
                return fail('STALE_REVISION', 'Someday tasks changed before the move');
            const sections = rawSections();
            if (!sections.ok) return sections;
            const section = request.sectionId === null ? null : selectedSection(sections.value, request.sectionId);
            if (request.sectionId !== null && !section) return fail('INVALID_INPUT', 'Someday section is unavailable');
            const planned = planSomedaySectionMove({ ids: request.taskIds, tasks, destination: request.sectionId ?? undefined });
            const byId = new Map(tasks.map((task) => [task.id, task]));
            const rows: BulkRow[] = planned.updates.map((update) => ({ id: update.id, revision: request.taskRevisions[update.id],
                before: byId.get(update.id)!.viewSectionIds ?? null, after: update.updates.viewSectionIds! }));
            const result: NativeSomedaySectionBulkMoveResult = { taskIds: rows.map((row) => row.id), changed: true, sectionId: request.sectionId };
            if (!rows.length) return { ok: true, value: { kind: 'noop', result: { ...result, changed: false } } };
            const deviceId = useTaskStore.getState().settings.deviceId;
            if (!nonempty(deviceId, 500)) return fail('INVALID_INPUT', 'Loaded device identity is required');
            const prepared = frozen<NativePreparedSomedaySectionBulkMove>({ version: 1, kind: 'move', request, rows, deviceId,
                sectionWitness: section, result }, readBulkMoveEnvelope, request, BULK_MOVE_BYTES);
            return prepared ? { ok: true, value: { kind: 'prepared', prepared } }
                : fail('INVALID_INPUT', 'Someday bulk move exceeds the bounded journal');
        },

        validatePreparedSomedaySectionBulkMove,
        probeSomedaySectionBulkMoveOutcome(input: NativeSomedaySectionBulkMoveEnvelope): NativeHostResult<NativeSomedaySectionBulkMoveResult> {
            const envelope = readBulkMoveEnvelope(input);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared Someday bulk section move is malformed');
            const ready = deps.readiness();
            return ready.ok ? applied(envelope.prepared) : ready;
        },
        async commitPreparedSomedaySectionBulkMove(input: NativeSomedaySectionBulkMoveEnvelope): Promise<NativeHostResult<NativeSomedaySectionBulkMoveResult>> {
            const envelope = readBulkMoveEnvelope(input);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared Someday bulk section move is malformed');
            const ready = deps.readiness();
            return ready.ok ? commit(envelope) : ready;
        },

        prepareSomedaySectionBulkMoveUndo(input: { request: NativeSomedaySectionMoveUndoRequest; move: NativeSomedaySectionBulkMoveEnvelope }): NativeHostResult<{
            kind: 'noop'; result: NativeSomedaySectionBulkMoveUndoResult;
        } | { kind: 'prepared'; prepared: NativePreparedSomedaySectionBulkMoveUndo }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const outer = bulkDetached<Record<string, unknown>>(input, BULK_MOVE_BYTES + 1_000);
            const request = outer && exact(outer, ['request', 'move']) ? readUndoRequest(outer.request) : null;
            const move = outer && readBulkMoveEnvelope(outer.move);
            if (!request || !move || request.moveRequestId !== move.request.requestId)
                return fail('INVALID_INPUT', 'A confirmed Someday bulk move and new Undo UUID are required');
            const state = useTaskStore.getState();
            const editable = move.prepared.rows.map((row) => currentRow(row.id)).filter((task): task is Task => Boolean(task
                && !task.deletedAt && !task.purgedAt && task.status === 'someday' && !isStatusListTaskReadOnly(task, state._allProjects)));
            const previous = move.prepared.rows.map((row) => ({ id: row.id, sectionId: somedayOf(row.before) }));
            const byId = new Map(editable.map((task) => [task.id, task]));
            const rows: BulkRow[] = buildTaskViewSectionUndoUpdates(editable, 'someday', previous, move.request.sectionId ?? undefined)
                .map((update) => ({ id: update.id, revision: revisionOf(byId.get(update.id)!),
                    before: byId.get(update.id)!.viewSectionIds ?? null, after: update.updates.viewSectionIds! }));
            const result: NativeSomedaySectionBulkMoveUndoResult = { taskIds: rows.map((row) => row.id), changed: true };
            if (!rows.length) return { ok: true, value: { kind: 'noop', result: { ...result, changed: false } } };
            const deviceId = state.settings.deviceId;
            if (!nonempty(deviceId, 500)) return fail('INVALID_INPUT', 'Loaded device identity is required');
            const prepared = frozen<NativePreparedSomedaySectionBulkMoveUndo>({ version: 1, kind: 'undo', request, move, rows,
                deviceId, result }, readBulkUndoEnvelope, request, BULK_UNDO_BYTES);
            return prepared ? { ok: true, value: { kind: 'prepared', prepared } }
                : fail('INVALID_INPUT', 'Someday bulk Undo exceeds the bounded journal');
        },

        validatePreparedSomedaySectionBulkMoveUndo,
        probeSomedaySectionBulkMoveUndoOutcome(input: NativeSomedaySectionBulkMoveUndoEnvelope): NativeHostResult<NativeSomedaySectionBulkMoveUndoResult> {
            const envelope = readBulkUndoEnvelope(input);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared Someday bulk section Undo is malformed');
            const ready = deps.readiness();
            return ready.ok ? applied(envelope.prepared) : ready;
        },
        async commitPreparedSomedaySectionBulkMoveUndo(input: NativeSomedaySectionBulkMoveUndoEnvelope): Promise<NativeHostResult<NativeSomedaySectionBulkMoveUndoResult>> {
            const envelope = readBulkUndoEnvelope(input);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared Someday bulk section Undo is malformed');
            const ready = deps.readiness();
            return ready.ok ? commit(envelope) : ready;
        },
    };
}
