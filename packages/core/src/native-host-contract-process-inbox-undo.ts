import type { NativeHostResult } from './native-host-contract';
import { readNativePreparedInboxWrite, type NativeInboxWriteRequest, type NativePreparedInboxWrite } from './native-host-contract-process-inbox';
import { buildProcessInboxUndoRestoreUpdates } from './process-inbox-model';
import { countFocusedTasksBeforeBoundary } from './task-utils';
import { normalizeFocusTaskLimit } from './focus-utils';
import { createProjectOrderReserver, ensureDeviceId, getNextProjectOrder, getTaskOrder } from './store-helpers';
import { planTaskMutations, planTaskUpdateEffects, prepareTaskUpdatesForStore, samePreparedTask,
    sanitizeRestoredTaskContainerReferences } from './store-tasks';
import { validRawTask } from './native-host-contract-task-save';
import { isStatusListTaskReadOnly } from './menu-views-model';
import type { NativeRequestReceipts } from './native-request-receipts';
import { useTaskStore } from './store';
import type { PreparedChecklistEffect, TaskStore } from './store-types';
import type { AppSettings, Area, Project, Section, Task } from './types';

export type NativeInboxDecisionEnvelope = { request: NativeInboxWriteRequest; prepared: NativePreparedInboxWrite };
export type NativeInboxUndoRequest = { requestId: string; decisionRequestId: string; taskId: string };
export type NativeInboxUndoOffer = { taskId: string; decisionRequestId: string; kind: 'filed' | 'completed' | 'discarded' };
export type NativeInboxUndoResult = NativeInboxUndoOffer;
type Lists = { tasks: Task[]; projects: Project[]; sections: Section[]; areas: Area[] };
type Witness = {
    source: Task; lists: Lists; settings: AppSettings;
    preparedAt: string; futureBoundary: string; preparedLocalDay: string;
    preparedOffsetMinutes: number; boundaryOffsetMinutes: number;
    deviceIdBefore: string | null; deviceIdToInitialize: string | null;
    focusCount: number; focusLimit: number;
};
export type NativePreparedInboxUndo = {
    version: 1; kind: 'inboxUndo'; request: NativeInboxUndoRequest;
    decision: NativeInboxDecisionEnvelope; witness: Witness;
    effect: PreparedChecklistEffect; result: NativeInboxUndoResult;
};
export type NativeInboxUndoEnvelope = { request: NativeInboxUndoRequest; prepared: NativePreparedInboxUndo };

const LIMIT = 4_500_000;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
export const canonicalInboxJSON = (value: unknown): string => JSON.stringify(value, (_name, item) => record(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : item);
const same = (left: unknown, right: unknown): boolean => canonicalInboxJSON(left) === canonicalInboxJSON(right);
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION', message: string): NativeHostResult<never> => ({ ok: false, error: { code, message } });
const detach = (value: unknown): unknown => {
    const safe = (item: unknown, depth: number): boolean => {
        if (depth > 40) return false;
        if (item === null || typeof item === 'string' || typeof item === 'boolean') return true;
        if (typeof item === 'number') return Number.isFinite(item);
        if (Array.isArray(item)) return item.length <= LIMIT && item.every((entry) => safe(entry, depth + 1));
        return record(item) && (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)
            && Object.keys(item).length <= 256 && Object.entries(item).every(([key, entry]) =>
                !['__proto__', 'prototype', 'constructor'].includes(key) && safe(entry, depth + 1));
    };
    if (!safe(value, 0)) return null;
    const json = JSON.stringify(value);
    return new TextEncoder().encode(json).length <= LIMIT ? JSON.parse(json) : null;
};
export const nativeInboxDecisionPayload = (decision: NativeInboxDecisionEnvelope): string => canonicalInboxJSON(['inboxPreparedCommit', decision]);
const undoPayload = (envelope: NativeInboxUndoEnvelope): string => canonicalInboxJSON(['inboxUndo', envelope]);
export const nativeInboxUndoOffer = (prepared: NativePreparedInboxWrite): NativeInboxUndoOffer | null => {
    const committed = prepared.witness.committed;
    return prepared.kind === 'decision' && committed ? { taskId: prepared.request.taskId,
        decisionRequestId: prepared.request.requestId, kind: committed === 'trash' ? 'discarded' : committed === 'done' ? 'completed' : 'filed' } : null;
};
const readRequest = (value: unknown): NativeInboxUndoRequest | null => record(value)
    && exact(value, ['requestId', 'decisionRequestId', 'taskId'])
    && typeof value.requestId === 'string' && UUID.test(value.requestId)
    && typeof value.decisionRequestId === 'string' && UUID.test(value.decisionRequestId)
    && value.requestId !== value.decisionRequestId && typeof value.taskId === 'string' && value.taskId.length > 0 && value.taskId.length <= 500
    ? value as NativeInboxUndoRequest : null;
const changedRows = <T extends { id: string }>(before: T[], after: T[]): Array<{ before: T | null; after: T }> => {
    const old = new Map(before.map((row) => [row.id, row]));
    return after.filter((row) => !same(old.get(row.id), row)).map((row) => ({ before: old.get(row.id) ?? null, after: row }));
};
const ownedChild = (decision: NativeInboxDecisionEnvelope): Task | null => {
    const created = decision.prepared.effect.tasks.filter((row) => row.before === null);
    if (created.length > 1) throw new Error('Invalid Process Inbox recurrence ownership');
    return created[0]?.after ?? null;
};
const minimalSettings = (settings: AppSettings): AppSettings => JSON.parse(JSON.stringify({ deviceId: settings.deviceId,
    gtd: { autoArchiveDays: settings.gtd?.autoArchiveDays, focusTaskLimit: settings.gtd?.focusTaskLimit } }));
const futureBoundary = (at: string): string => { const date = new Date(at); date.setHours(23, 59, 59, 999); return date.toISOString(); };

/** Full RN restoration policy, computed without a store write or a new entity identity. */
const plan = (decision: NativeInboxDecisionEnvelope, witness: Witness): PreparedChecklistEffect => {
    const offer = nativeInboxUndoOffer(decision.prepared);
    const original = decision.prepared.witness.source;
    const confirmed = decision.prepared.effect.tasks.find((row) => row.after.id === original.id)?.after;
    const source = witness.source;
    if (!offer || !confirmed || source.purgedAt || !samePreparedTask(source, confirmed)) throw new Error('Process Inbox decision was superseded');
    if (offer.kind !== 'discarded' && (source.deletedAt || isStatusListTaskReadOnly(source, witness.lists.projects)))
        throw new Error('Process Inbox task is no longer writable');
    if (offer.kind === 'discarded' && !source.deletedAt) throw new Error('Process Inbox task is no longer in Trash');
    const deviceId = witness.deviceIdBefore ?? witness.deviceIdToInitialize!;
    let lists = witness.lists;
    let focusGuard = false;
    let focusedCount = witness.focusCount;
    if (offer.kind === 'completed') {
        const child = ownedChild(decision);
        if (child) {
            const current = lists.tasks.find((row) => row.id === child.id);
            if (!current || current.deletedAt || current.purgedAt || !samePreparedTask(current, child)) throw new Error('Recurring follow-up changed');
            const [tombstone] = planTaskMutations({ tasks: [current], state: {}, now: witness.preparedAt,
                deviceId, buildUpdates: (_task, context) => ({ deletedAt: context.now }) });
            focusedCount -= countFocusedTasksBeforeBoundary([current], witness.futureBoundary);
            lists = { ...lists, tasks: lists.tasks.map((row) => row.id === child.id ? tombstone : row) };
        }
    }
    if (offer.kind === 'discarded') {
        const [restored] = planTaskMutations({ tasks: [source], state: {
            _allProjects: lists.projects, _allSections: lists.sections, _allAreas: lists.areas,
        }, now: witness.preparedAt, deviceId, buildUpdates: (task, { state }) => ({ deletedAt: undefined,
            ...sanitizeRestoredTaskContainerReferences(task, state) }) });
        lists = { ...lists, tasks: lists.tasks.map((row) => row.id === source.id ? restored : row) };
    } else {
        const restore = buildProcessInboxUndoRestoreUpdates(original);
        const update = (updates: Partial<Task>) => {
            const current = lists.tasks.find((row) => row.id === source.id)!;
            const normalized = prepareTaskUpdatesForStore({ task: current, updates,
                allProjects: lists.projects, allSections: lists.sections, allAreas: lists.areas,
                settings: witness.settings, futureBoundary: witness.futureBoundary, nowMs: Date.parse(witness.preparedAt),
                reserveProjectOrder: true, projectOrderReserver: createProjectOrderReserver(lists.tasks) });
            if (!normalized.ok) throw new Error(normalized.error);
            const fillsFocus = countFocusedTasksBeforeBoundary([current], witness.futureBoundary) === 0
                && countFocusedTasksBeforeBoundary([{ ...current, ...normalized.updates }], witness.futureBoundary) === 1;
            if (fillsFocus) {
                focusGuard = true;
                if (focusedCount >= witness.focusLimit) throw new Error('Focus limit reached');
            }
            const planned = planTaskUpdateEffects({ task: current, preparedUpdates: normalized.updates,
                allTasks: lists.tasks, allProjects: lists.projects, allSections: lists.sections,
                now: witness.preparedAt, deviceId, createId: () => { throw new Error('Undo cannot create a recurring occurrence'); } });
            focusedCount += countFocusedTasksBeforeBoundary([planned.updatedTask], witness.futureBoundary)
                - countFocusedTasksBeforeBoundary([current], witness.futureBoundary);
            lists = { ...lists, tasks: planned.tasks, projects: planned.projects, sections: planned.sections };
        };
        if (offer.kind === 'completed') {
            const { isFocusedToday: _focused, focusOrder, ...fields } = restore;
            update({ ...fields, status: original.status, isFocusedToday: false, focusOrder: undefined });
            if (original.isFocusedToday === true) {
                focusGuard = true;
                if (focusedCount < witness.focusLimit)
                    update({ isFocusedToday: true, ...(focusOrder !== undefined ? { focusOrder } : {}) });
            }
        } else update(restore);
    }
    const tasks = changedRows(witness.lists.tasks, lists.tasks);
    const projects = changedRows(witness.lists.projects, lists.projects);
    const sections = changedRows(witness.lists.sections, lists.sections);
    const after = tasks.find((row) => row.after.id === source.id)?.after;
    if (!after) throw new Error('Undo has no source effect');
    const reopened = projects.find((row) => row.before?.status === 'archived' && row.after.status === 'active');
    const target = lists.projects.find((row) => row.id === after.projectId) ?? null;
    const orderProjects = [...new Set(tasks.filter((row) => row.after.projectId
        && (row.after.order !== row.before?.order || row.after.orderNum !== row.before?.orderNum)).map((row) => row.after.projectId!))];
    return { sourceBefore: source, tasks, projects, sections, deviceIdBefore: witness.deviceIdBefore,
        deviceIdToInitialize: witness.deviceIdToInitialize, guards: {
            selectedProject: offer.kind !== 'discarded' && target && !projects.some((row) => row.after.id === target.id) ? target : null,
            selectedArea: lists.areas.find((row) => row.id === after.areaId) ?? null,
            taskOrders: orderProjects.map((projectId) => ({ projectId, max: (getNextProjectOrder(projectId, witness.lists.tasks) ?? 0) - 1 })),
            reactivation: reopened ? { projectId: reopened.after.id,
                taskIds: witness.lists.tasks.filter((row) => row.projectId === reopened.after.id).map((row) => row.id).sort(),
                sectionIds: witness.lists.sections.filter((row) => row.projectId === reopened.after.id).map((row) => row.id).sort() } : null,
            recurringCandidate: null, recurringDuplicate: null,
            focusCount: focusGuard ? witness.focusCount : null, focusLimit: focusGuard ? witness.focusLimit : null,
            focusBoundary: focusGuard ? witness.futureBoundary : null,
            autoArchiveDays: offer.kind === 'discarded' ? null : witness.settings.gtd?.autoArchiveDays ?? null,
        } };
};
const reduce = (witness: Witness, effect: PreparedChecklistEffect): void => {
    const tasks = new Set([witness.source.id, ...effect.tasks.map((row) => row.after.id), ...effect.guards.reactivation?.taskIds ?? []]);
    for (const { projectId } of effect.guards.taskOrders) {
        const highest = witness.lists.tasks.filter((row) => row.projectId === projectId && !row.deletedAt)
            .sort((left, right) => (getTaskOrder(right) ?? -1) - (getTaskOrder(left) ?? -1))[0];
        if (highest) tasks.add(highest.id);
    }
    const projects = new Set([witness.source.projectId, ...effect.projects.map((row) => row.after.id),
        ...effect.tasks.map((row) => row.after.projectId), effect.guards.selectedProject?.id]);
    const sections = new Set([witness.source.sectionId, ...effect.sections.map((row) => row.after.id),
        ...effect.tasks.map((row) => row.after.sectionId), ...effect.guards.reactivation?.sectionIds ?? []]);
    witness.lists = { tasks: witness.lists.tasks.filter((row) => tasks.has(row.id)),
        projects: witness.lists.projects.filter((row) => projects.has(row.id)),
        sections: witness.lists.sections.filter((row) => sections.has(row.id)),
        areas: witness.lists.areas.filter((row) => row.id === witness.source.areaId || row.id === effect.guards.selectedArea?.id
            || witness.lists.projects.some((project) => projects.has(project.id) && project.areaId === row.id)
            || effect.tasks.some((item) => item.after.areaId === row.id)) };
};
const listsOf = (state: TaskStore): Lists => ({ tasks: state._allTasks, projects: state._allProjects, sections: state._allSections, areas: state._allAreas });
const uniqueRows = (rows: unknown): rows is Array<{ id: string }> => Array.isArray(rows) && rows.every((row) => record(row)
    && typeof row.id === 'string' && row.id.length > 0 && row.id.length <= 500) && new Set(rows.map((row) => row.id)).size === rows.length;
const validClock = (witness: Witness): boolean => {
    try { return typeof witness.preparedAt === 'string' && Number.isFinite(Date.parse(witness.preparedAt))
    && new Date(witness.preparedAt).toISOString() === witness.preparedAt
    && typeof witness.futureBoundary === 'string' && Number.isFinite(Date.parse(witness.futureBoundary))
    && new Date(witness.futureBoundary).toISOString() === witness.futureBoundary
    && Number.isInteger(witness.preparedOffsetMinutes) && Math.abs(witness.preparedOffsetMinutes) <= 840
    && Number.isInteger(witness.boundaryOffsetMinutes) && Math.abs(witness.boundaryOffsetMinutes) <= 840
    && new Date(Date.parse(witness.preparedAt) - witness.preparedOffsetMinutes * 60_000).toISOString().slice(0, 10) === witness.preparedLocalDay
    && new Date(Date.parse(`${witness.preparedLocalDay}T23:59:59.999Z`) + witness.boundaryOffsetMinutes * 60_000).toISOString() === witness.futureBoundary; }
    catch { return false; }
};

/** Pure pre-storage journal validation, including the original decision and complete Undo effect. */
export function readNativePreparedInboxUndo(input: unknown): NativeInboxUndoEnvelope | null {
    const value = detach(input);
    if (!record(value) || !exact(value, ['request', 'prepared']) || !record(value.prepared)) return null;
    const request = readRequest(value.request), raw = value.prepared;
    if (!request || !exact(raw, ['version', 'kind', 'request', 'decision', 'witness', 'effect', 'result'])
        || raw.version !== 1 || raw.kind !== 'inboxUndo' || !same(request, raw.request) || !record(raw.decision)) return null;
    const decisionPrepared = readNativePreparedInboxWrite(raw.decision);
    if (!decisionPrepared || !same(raw.decision, { request: decisionPrepared.request, prepared: decisionPrepared })) return null;
    const offer = nativeInboxUndoOffer(decisionPrepared);
    if (!offer || request.taskId !== offer.taskId || request.decisionRequestId !== offer.decisionRequestId || !same(raw.result, offer)
        || !record(raw.witness) || !exact(raw.witness, ['source', 'lists', 'settings', 'preparedAt', 'futureBoundary', 'preparedLocalDay',
            'preparedOffsetMinutes', 'boundaryOffsetMinutes', 'deviceIdBefore', 'deviceIdToInitialize', 'focusCount', 'focusLimit'])
        || !record(raw.witness.lists) || !exact(raw.witness.lists, ['tasks', 'projects', 'sections', 'areas']) || !record(raw.witness.settings)) return null;
    const prepared = raw as unknown as NativePreparedInboxUndo, witness = prepared.witness;
    if (!Object.values(witness.lists).every(uniqueRows) || !witness.lists.tasks.every((row) => validRawTask(row, row.id))
        || !validRawTask(witness.source, request.taskId) || !same(witness.source, witness.lists.tasks.find((row) => row.id === request.taskId))
        || !validClock(witness) || witness.deviceIdBefore !== (witness.settings.deviceId ?? null)
        || (witness.deviceIdBefore === null ? typeof witness.deviceIdToInitialize !== 'string' || !UUID.test(witness.deviceIdToInitialize)
            : witness.deviceIdToInitialize !== null)
        || !Number.isSafeInteger(witness.focusCount) || witness.focusCount < 0 || !Number.isSafeInteger(witness.focusLimit)
        || witness.focusLimit !== normalizeFocusTaskLimit(witness.settings.gtd?.focusTaskLimit)) return null;
    try { return same(plan(prepared.decision, witness), prepared.effect) ? value as NativeInboxUndoEnvelope : null; }
    catch { return null; }
}

/** Preparation reads current state once; validation can replay its bounded frozen witness without IO. */
export function prepareNativeInboxUndo(request: NativeInboxUndoRequest, decision: NativeInboxDecisionEnvelope, state: TaskStore): NativePreparedInboxUndo {
    const checked = readNativePreparedInboxWrite(decision), offer = checked && nativeInboxUndoOffer(checked);
    if (!readRequest(request) || !checked || !offer || request.taskId !== offer.taskId || request.decisionRequestId !== offer.decisionRequestId)
        throw new Error('Undo requires the exact original Process Inbox decision');
    const source = state._tasksById.get(request.taskId);
    if (!source) throw new Error('Process Inbox task is gone');
    const at = new Date().toISOString(), boundary = futureBoundary(at), device = ensureDeviceId(state.settings);
    const witness: Witness = { source, lists: listsOf(state), settings: minimalSettings(state.settings),
        preparedAt: at, futureBoundary: boundary, preparedLocalDay: new Date(Date.parse(at) - new Date(at).getTimezoneOffset() * 60_000).toISOString().slice(0, 10),
        preparedOffsetMinutes: new Date(at).getTimezoneOffset(), boundaryOffsetMinutes: new Date(boundary).getTimezoneOffset(),
        deviceIdBefore: state.settings.deviceId ?? null, deviceIdToInitialize: device.updated ? device.deviceId : null,
        focusCount: countFocusedTasksBeforeBoundary(state.tasks, boundary), focusLimit: normalizeFocusTaskLimit(state.settings.gtd?.focusTaskLimit) };
    const effect = plan(decision, witness);
    reduce(witness, effect);
    if (!same(plan(decision, witness), effect)) throw new Error('Undo exceeds its bounded witness');
    const prepared = JSON.parse(JSON.stringify({ version: 1, kind: 'inboxUndo', request, decision, witness, effect, result: offer })) as NativePreparedInboxUndo;
    if (!readNativePreparedInboxUndo({ request, prepared })) throw new Error('Undo exceeds journal bounds or failed self-validation');
    return prepared;
}

export function createInboxUndoMethods(deps: { readiness: () => NativeHostResult<null>; receipts: NativeRequestReceipts }) {
    const savedDecision = (decision: NativeInboxDecisionEnvelope) => {
        const saved = deps.receipts.saved(decision.request.requestId, nativeInboxDecisionPayload(decision));
        return saved?.ok && same(saved.value, decision.prepared.result);
    };
    return {
        inboxUndoPrepare(input: { request: NativeInboxUndoRequest; decision: NativeInboxDecisionEnvelope }): NativeHostResult<{ kind: 'prepared'; prepared: NativePreparedInboxUndo }> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const checked = detach(input);
            if (!record(checked) || !exact(checked, ['request', 'decision']) || !readRequest(checked.request)) return fail('INVALID_INPUT', 'A bounded Undo request is required');
            const original = readNativePreparedInboxWrite(checked.decision);
            if (!original) return fail('INVALID_INPUT', 'The original Process Inbox decision is malformed');
            const decision = { request: original.request, prepared: original };
            if (!savedDecision(decision)) return fail('STALE_REVISION', 'Process Inbox decision has no exact saved receipt');
            try { return { ok: true, value: { kind: 'prepared', prepared: prepareNativeInboxUndo(checked.request as NativeInboxUndoRequest, decision, useTaskStore.getState()) } }; }
            catch (error) { return fail('STALE_REVISION', error instanceof Error ? error.message : 'Process Inbox decision changed'); }
        },
        inboxUndoValidate(input: NativeInboxUndoEnvelope): NativeHostResult<NativeInboxUndoResult> {
            const envelope = readNativePreparedInboxUndo(input);
            return envelope ? { ok: true, value: envelope.prepared.result } : fail('INVALID_INPUT', 'Prepared Process Inbox Undo is malformed');
        },
        inboxUndoOutcome(input: NativeInboxUndoEnvelope): NativeHostResult<NativeInboxUndoResult | null> {
            const envelope = readNativePreparedInboxUndo(input);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared Process Inbox Undo is malformed');
            const saved = deps.receipts.saved<NativeInboxUndoResult>(envelope.request.requestId, undoPayload(envelope));
            return saved?.ok && !same(saved.value, envelope.prepared.result) ? fail('INVALID_INPUT', 'Saved Undo result does not match its journal') : saved ?? { ok: true, value: null };
        },
        async inboxUndoCommit(input: NativeInboxUndoEnvelope): Promise<NativeHostResult<NativeInboxUndoResult>> {
            const envelope = readNativePreparedInboxUndo(input);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared Process Inbox Undo is malformed');
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const payload = undoPayload(envelope);
            const saved = deps.receipts.saved<NativeInboxUndoResult>(envelope.request.requestId, payload);
            if (saved) return saved.ok && !same(saved.value, envelope.prepared.result) ? fail('INVALID_INPUT', 'Saved Undo result does not match its journal') : saved;
            if (!savedDecision(envelope.prepared.decision)) return fail('STALE_REVISION', 'Process Inbox decision has no exact saved receipt');
            return deps.receipts.run(envelope.request.requestId, payload, async () => {
                const state = useTaskStore.getState(), prepared = envelope.prepared;
                const source = state._tasksById.get(envelope.request.taskId);
                if (!source) return fail('STALE_REVISION', 'Process Inbox task is gone');
                const current: Witness = { ...prepared.witness, source, lists: listsOf(state), settings: minimalSettings(state.settings),
                    deviceIdBefore: state.settings.deviceId ?? null,
                    focusCount: countFocusedTasksBeforeBoundary(state.tasks, prepared.witness.futureBoundary),
                    focusLimit: normalizeFocusTaskLimit(state.settings.gtd?.focusTaskLimit) };
                try { if (!same(plan(prepared.decision, current), prepared.effect)) return fail('STALE_REVISION', 'Process Inbox Undo authority changed'); }
                catch { return fail('STALE_REVISION', 'Process Inbox decision or its recurring follow-up changed'); }
                const applied = await state.commitPreparedChecklistEffect(prepared.effect, { requireBefore: true });
                return applied.success ? { ok: true, value: prepared.result } : fail('STALE_REVISION', applied.error ?? 'Process Inbox Undo conflicts with current data');
            });
        },
    };
}
