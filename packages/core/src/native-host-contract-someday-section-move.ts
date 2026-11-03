import { resolveAreaFilterSelection } from './area-filter';
import type { NativeHostResult } from './native-host-contract';
import { detach, exact, iso, record } from './native-host-contract-project-shared';
import { isNativeJsonWithinBytes, readChecklist } from './native-host-contract-task-view';
import { isStatusListTaskReadOnly } from './menu-views-model';
import { createNativeRequestReceipts, revisionOf, runStoreWrite, settleWrite } from './native-request-receipts';
import { buildSomedaySectionMoveDialog, formatSomedaySectionMoved, getSomedaySectionMoveTasks,
    getSomedaySectionMoveText, planSomedaySectionMove } from './someday-sections-model';
import { useTaskStore } from './store';
import { sameSectionDeleteJson, sameTaskSqliteRow } from './store-projects/section-actions';
import { nextRevision } from './sync-revision';
import { TASK_SQLITE_COLUMNS, TASK_SYNC_FIELD_SCHEMA, taskFromSqliteRow, taskToSqliteRow } from './task-sync-schema';
import type { Task, ViewSectionDefinition } from './types';
import { buildTaskViewSectionUndoUpdates, sortViewSectionDefinitions } from './view-sections';

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
const eligibleTask = (id: string): Task | null => {
    const state = useTaskStore.getState();
    const tasks = getSomedaySectionMoveTasks({ tasks: state.tasks, projects: state.projects,
        areas: state.areas, ids: [id],
        resolvedAreaFilter: resolveAreaFilterSelection(state.settings.filters, state.areas) });
    const task = tasks?.[0];
    return task && !isStatusListTaskReadOnly(task, state._allProjects)
        && state._allTasks.filter((row) => row.id === id).length === 1 ? task : null;
};
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
