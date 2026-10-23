import { sha256 } from '@noble/hashes/sha2.js';
import type { NativeHostResult } from './native-host-contract';
import type { AppData, Area, Project, Section, Task, TaskStatus } from './types';
import type { PreparedAreaAuthority, PreparedChecklistEffect, PreparedChecklistRawBefore, PreparedNativeSaveBoundary, PreparedProjectLifecycle } from './store-types';
import { createTaskChecklistSaveMethods, historyRowLoadProjection, type NativeTaskCompletionEnvelope, type NativeReferenceTaskBackdateEnvelope } from './native-host-contract-task-checklist';
import { createAreaSaveGuard, readAreaDurableData } from './native-host-contract-area-durable';
import { createNativeRequestReceipts, NativeReceiptSqliteAdapter, taskRevisionOf, revisionOf as rowRevisionOf } from './native-request-receipts';
import { exact, iso, record, validProject } from './native-host-contract-project-shared';
import { validRawTask } from './native-host-contract-task-save';
import { validSection } from './native-host-contract-project-section-rename';
import { validFrozenFocusDate } from './native-host-contract-task-focus';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { rawReadTaskSnapshot } from './sqlite-adapter';
import { rawReadProjectSnapshot } from './sqlite-raw-snapshot';
import { PROJECT_SQLITE_COLUMNS, projectFromSqliteRow, projectToSqliteRow } from './project-sync-schema';
import { getProjectNextActionPromptData } from './project-utils';
import { normalizeProjectLifecycleFields } from './project-status';
import { prepareTaskUpdatesForStore, planTaskUpdateEffects } from './store-tasks';
import { projectLifecycleEffect } from './store-projects/project-actions';
import { buildNewTask } from './task-creation';
import { getTaskReminderDefault } from './task-reminder-policy';
import { buildQuickAddParseOptions, parseProjectNextActionInput } from './quick-add';
import { ensureDeviceId, getNextProjectOrder, selectVisiblePeople, selectVisibleTasks } from './store-helpers';
import { isTimeEstimate } from './native-host-contract-menu-views';
import { countFocusedTasksBeforeBoundary, projectFocusDateValues, type FocusDateProjection } from './task-utils';
import { normalizeFocusTaskLimit } from './focus-utils';
import { generateUUID } from './uuid';
import { taskEditValuesEqual } from './json-value-equality';
import { useTaskStore } from './store';
import { logInfo } from './logger';
import { formatI18nTemplate } from './i18n';

export type NativeReferenceProjectNextActionOriginRef = { kind: 'completion' | 'backdate'; id: string; requestId: string };
export type NativeReferenceProjectNextActionOrigin = { kind: 'completion'; envelope: NativeTaskCompletionEnvelope }
    | { kind: 'backdate'; envelope: NativeReferenceTaskBackdateEnvelope };
export type NativeReferenceProjectNextActionRequest = {
    requestId: string; origin: NativeReferenceProjectNextActionOriginRef; promptRevision: string;
} & ({ action: 'choose'; candidateId: string; candidateRevision: string }
    | { action: 'add'; text: string; openAfterSave: boolean } | { action: 'completeProject' });
export type NativeReferenceProjectNextActionResult = { action: 'choose'; id: string }
    | { action: 'add'; id: string; openAfterSave: boolean } | { action: 'completeProject'; id: string; status: 'archived' };
export type NativeReferenceProjectNextActionOptions = {
    origin: NativeReferenceProjectNextActionOriginRef; promptRevision: string; title: string; description: string;
    project: { id: string; title: string; revision: string }; section: null | { id: string; title: string; revision: string };
    scope: 'project' | 'section'; candidates: { offset: number; total: number; hasMore: boolean;
        items: { id: string; taskRevision: string; title: string; status: TaskStatus; statusLabel: string }[] };
    input: { placeholder: string; addLabel: string; saveAndEditLabel: string };
    completeProject: null | { label: string }; skip: { label: string };
};
type Lists = { tasks: Task[]; projects: Project[]; sections: Section[]; areas: Area[] };
export type NativeProjectNextActionContext = {
    source: Task; rawSource: Task; project: Project; section: Section | null;
    tasks: Task[]; scope: 'project' | 'section';
};
type Clock = { preparedLocalDay: string; preparedOffsetMinutes: number; boundaryOffsetMinutes: number;
    futureBoundary: string; dates: FocusDateProjection[] };
type ChooseOperation = { kind: 'choose'; lists: Lists; settings: AppData['settings'];
    deviceIdBefore: string | null; deviceIdToInitialize: string | null; updateAt: string; clock: Clock; effect: PreparedChecklistEffect };
export type NativeProjectNextActionResolvedIntent = { title: string; props: Partial<Task> };
type FocusWitness = Clock & { lists: Pick<Lists, 'tasks' | 'projects' | 'sections'>; focusCount: number; focusLimit: number };
type AddOperation = { kind: 'add'; creation: { intent: NativeProjectNextActionResolvedIntent;
    containers: { project: Project; section: Section | null; areas: Area[] };
    projectOrder: { projectId: string; max: number }; focus: FocusWitness | null };
    task: Task; deviceIdBefore: string | null; deviceIdToInitialize: string | null; updateAt: string };
type CompleteOperation = { kind: 'completeProject'; lifecycle: PreparedProjectLifecycle };
export type NativePreparedReferenceProjectNextAction = {
    version: 1; kind: 'referenceProjectNextAction'; request: NativeReferenceProjectNextActionRequest;
    origin: NativeReferenceProjectNextActionOrigin; context: NativeProjectNextActionContext;
    rawBefore: PreparedChecklistRawBefore; operation: ChooseOperation | AddOperation | CompleteOperation;
    result: NativeReferenceProjectNextActionResult;
};
export type NativeReferenceProjectNextActionEnvelope = { request: NativeReferenceProjectNextActionRequest; prepared: NativePreparedReferenceProjectNextAction };
export type NativeReferenceProjectNextActionPreparation = { kind: 'prepared'; prepared: NativePreparedReferenceProjectNextAction };
type OriginMethods = Pick<ReturnType<typeof createTaskChecklistSaveMethods>, 'validatePreparedTaskCompletion' | 'taskCompletionOutcome'
    | 'validatePreparedReferenceTaskBackdate' | 'referenceTaskBackdateOutcome'>;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const same = taskEditValuesEqual;
const text = (v: unknown, limit: number): v is string => typeof v === 'string' && Boolean(v.trim()) && v.length <= limit;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED' | 'ACTION_FAILED', message: string): NativeHostResult<never> => ({ ok: false, error: { code, message } });
const canonical = (v: unknown): string => JSON.stringify(v, (_name, item) => record(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const payload = (e: NativeReferenceProjectNextActionEnvelope) => canonical(['referenceProjectNextAction', e]);
const detach = <T,>(v: unknown, cap = 2_100_000): T | null => {
    const valid = (item: unknown, depth: number): boolean => {
        if (depth > 32) return false;
        if (item === undefined || item === null || typeof item === 'string' || typeof item === 'boolean') return true;
        if (typeof item === 'number') return Number.isFinite(item);
        if (Array.isArray(item)) return item.length <= 100_000 && item.every((x) => valid(x, depth + 1));
        return record(item) && [Object.prototype, null].includes(Object.getPrototypeOf(item)) && Object.keys(item).length <= 128
            && Object.entries(item).every(([k, x]) => !['__proto__', 'constructor', 'prototype'].includes(k) && valid(x, depth + 1));
    };
    return isNativeJsonWithinBytes(v, cap) && valid(v, 0) ? JSON.parse(JSON.stringify(v)) as T : null;
};
const validRef = (v: unknown): v is NativeReferenceProjectNextActionOriginRef => record(v) && exact(v, ['kind', 'id', 'requestId'])
    && ['completion', 'backdate'].includes(String(v.kind)) && text(v.id, 500) && typeof v.requestId === 'string' && UUID.test(v.requestId);
const refOf = (o: NativeReferenceProjectNextActionOrigin): NativeReferenceProjectNextActionOriginRef => ({ kind: o.kind, id: o.envelope.request.id, requestId: o.envelope.request.requestId });
const readRequest = (v: unknown): NativeReferenceProjectNextActionRequest | null => {
    const r = detach<Record<string, unknown>>(v, 2_000_000);
    if (!r || !validRef(r.origin) || typeof r.requestId !== 'string' || !UUID.test(r.requestId)
        || r.requestId === r.origin.requestId || !text(r.promptRevision, 200)) return null;
    const base = ['requestId', 'origin', 'promptRevision', 'action'];
    if (r.action === 'choose') return exact(r, [...base, 'candidateId', 'candidateRevision']) && text(r.candidateId, 500)
        && text(r.candidateRevision, 200) ? r as unknown as NativeReferenceProjectNextActionRequest : null;
    if (r.action === 'add') return exact(r, [...base, 'text', 'openAfterSave']) && text(r.text, 100_000)
        && typeof r.openAfterSave === 'boolean' ? r as unknown as NativeReferenceProjectNextActionRequest : null;
    return r.action === 'completeProject' && exact(r, base) ? r as unknown as NativeReferenceProjectNextActionRequest : null;
};
const unique = (rows: { id: string }[]) => new Set(rows.map((row) => row.id)).size === rows.length;
const validTask = (v: unknown): v is Task => record(v) && text(v.id, 500) && validRawTask({ ...v, tags: v.tags ?? [], contexts: v.contexts ?? [] }, v.id);
const validProjectSnapshot = (v: unknown, id: string): v is Project => record(v)
    && (v.deletedAt == null || iso(v.deletedAt)) && (v.purgedAt == null || iso(v.purgedAt))
    && validProject({ ...v, tagIds: v.tagIds ?? [], deletedAt: undefined, purgedAt: undefined,
        ...(Array.isArray(v.attachments) ? { attachments: v.attachments.map((a) => record(a)
            && (a.updatedAt === undefined || a.updatedAt === '') ? { ...a, updatedAt: a.createdAt } : a) } : {}) }, id);
const validLists = (v: unknown): v is Lists => record(v) && exact(v, ['tasks', 'projects', 'sections', 'areas'])
    && Array.isArray(v.tasks) && v.tasks.every(validTask) && unique(v.tasks)
    && Array.isArray(v.projects) && v.projects.every((p) => record(p) && text(p.id, 500) && validProjectSnapshot(p, p.id)) && unique(v.projects)
    && Array.isArray(v.sections) && v.sections.every((s) => record(s) && text(s.id, 500) && validSection(s, s.id, String(s.projectId))) && unique(v.sections)
    && Array.isArray(v.areas) && v.areas.every((a) => record(a) && text(a.id, 500) && typeof a.name === 'string') && unique(v.areas);
const projectProjection = (project: Project): Project => { const values = projectToSqliteRow(project);
    return normalizeProjectLifecycleFields(projectFromSqliteRow(Object.fromEntries(PROJECT_SQLITE_COLUMNS.map((column, i) => [column, values[i]])))); };
const normalized = (data: AppData, at: string): Lists => ({ tasks: data.tasks.map((r) => historyRowLoadProjection(r, at)),
    projects: data.projects.map(normalizeProjectLifecycleFields), sections: data.sections ?? [], areas: data.areas ?? [] });
const contextOf = (data: AppData, lists: Lists, origin: NativeReferenceProjectNextActionOrigin): NativeProjectNextActionContext | null => {
    const source = lists.tasks.find((r) => r.id === origin.envelope.request.id);
    const raw = data.tasks.find((r) => r.id === source?.id); const rawSource = raw && rawReadTaskSnapshot(raw);
    if (!source || !rawSource || source.deletedAt || source.purgedAt) return null;
    const forced = { ...source, status: 'done' as const };
    const policy = getProjectNextActionPromptData(forced, lists.tasks.map((r) => r.id === source.id ? forced : r), lists.projects);
    if (!policy || policy.project.purgedAt) return null;
    const section = source.sectionId ? lists.sections.find((r) => r.id === source.sectionId) ?? null : null;
    if (source.sectionId && (!section || section.deletedAt || section.projectId !== policy.project.id)) return null;
    const project = rawReadProjectSnapshot(data.projects.find((r) => r.id === policy.project.id)!);
    if (!project) return null;
    return { source, rawSource, project, section, tasks: lists.tasks.filter((r) => r.projectId === policy.project.id), scope: policy.scope };
};
const policyOf = (c: NativeProjectNextActionContext) => getProjectNextActionPromptData({ ...c.source, status: 'done' },
    c.tasks.map((r) => r.id === c.source.id ? { ...r, status: 'done' as const } : r), [projectProjection(c.project)]);
// Only fields consumed by eligibility, candidate order, displayed row revision,
// and the completed-source/container authority enter the page revision.
const revisionContent = (c: NativeProjectNextActionContext) => canonical({ source: c.source, rawSource: c.rawSource,
    project: c.project, section: c.section, scope: c.scope, tasks: c.tasks.map((r) => ({ id: r.id, projectId: r.projectId,
        sectionId: r.sectionId, deletedAt: r.deletedAt, status: r.status, order: r.order, orderNum: r.orderNum,
        createdAt: r.createdAt, title: r.title, revision: taskRevisionOf(r) })) });
const revisionOf = (c: NativeProjectNextActionContext): string => {
    // Hash UTF-16 code units without platform encoder dependencies or Unicode
    // normalization. The complete context remains independently bound below.
    const value = revisionContent(c); const bytes = new Uint8Array(value.length * 2);
    for (let i = 0; i < value.length; i++) { const unit = value.charCodeAt(i); bytes[i * 2] = unit >>> 8; bytes[i * 2 + 1] = unit & 255; }
    return `projectNextAction:${Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};
const requiredDates = (tasks: Task[]) => [...new Set(tasks.flatMap((r) => [r.startTime, r.dueDate, r.reviewAt].filter((v): v is string => Boolean(v))))].sort();
const clockOf = (at: string, tasks: Task[]): Clock => {
    const date = new Date(at); const end = new Date(date); end.setHours(23, 59, 59, 999);
    const offset = date.getTimezoneOffset();
    return { preparedLocalDay: new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 10), preparedOffsetMinutes: offset,
        boundaryOffsetMinutes: end.getTimezoneOffset(), futureBoundary: end.toISOString(), dates: projectFocusDateValues(requiredDates(tasks)) };
};
const validClock = (c: Clock, at: string, tasks: Task[]) => record(c) && exact(c, ['preparedLocalDay', 'preparedOffsetMinutes', 'boundaryOffsetMinutes', 'futureBoundary', 'dates'])
    && iso(at) && /^\d{4}-\d{2}-\d{2}$/.test(c.preparedLocalDay) && Number.isInteger(c.preparedOffsetMinutes) && Math.abs(c.preparedOffsetMinutes) <= 840
    && Number.isInteger(c.boundaryOffsetMinutes) && Math.abs(c.boundaryOffsetMinutes) <= 840
    && new Date(Date.parse(at) - c.preparedOffsetMinutes * 60_000).toISOString().slice(0, 10) === c.preparedLocalDay
    && new Date(Date.parse(`${c.preparedLocalDay}T23:59:59.999Z`) + c.boundaryOffsetMinutes * 60_000).toISOString() === c.futureBoundary
    && Array.isArray(c.dates) && c.dates.every(validFrozenFocusDate) && same(c.dates.map((r) => r.value), requiredDates(tasks));
const datesOf = (c: Clock) => new Map(c.dates.map((r) => [r.value, r]));
const changed = <T extends { id: string }>(before: T[], after: T[]) => after.flatMap((r) => {
    const old = before.find((b) => b.id === r.id) ?? null; return same(old, r) ? [] : [{ before: old, after: r }];
});
const chooseEffect = (request: Extract<NativeReferenceProjectNextActionRequest, { action: 'choose' }>, op: ChooseOperation): PreparedChecklistEffect => {
    const source = op.lists.tasks.find((r) => r.id === request.candidateId);
    if (!source || source.deletedAt || source.purgedAt || taskRevisionOf(source) !== request.candidateRevision) throw new Error('Candidate changed');
    const dates = datesOf(op.clock); const limit = normalizeFocusTaskLimit(op.settings.gtd?.focusTaskLimit);
    const count = countFocusedTasksBeforeBoundary(op.lists.tasks, op.clock.futureBoundary, dates);
    const prepared = prepareTaskUpdatesForStore({ task: source, updates: { status: 'next' }, allProjects: op.lists.projects,
        allSections: op.lists.sections, allAreas: op.lists.areas, settings: op.settings,
        futureBoundary: op.clock.futureBoundary, futureDates: dates, nowMs: Date.parse(op.updateAt) });
    if (!prepared.ok) throw new Error(prepared.error);
    const fills = countFocusedTasksBeforeBoundary([source], op.clock.futureBoundary, dates) === 0
        && countFocusedTasksBeforeBoundary([{ ...source, ...prepared.updates }], op.clock.futureBoundary, dates) === 1;
    if (fills && count >= limit) throw new Error('Focus capacity changed');
    const result = planTaskUpdateEffects({ task: source, preparedUpdates: prepared.updates, allTasks: op.lists.tasks,
        allProjects: op.lists.projects, allSections: op.lists.sections, now: op.updateAt,
        deviceId: op.deviceIdBefore ?? op.deviceIdToInitialize!, createId: () => { throw new Error('Choose cannot allocate'); } });
    if (result.recurringCandidateTask || result.recurringFollowUpTask || result.reactivatedProjectIds.length) throw new Error('Unexpected Choose lifecycle');
    const after = result.updatedTask;
    return { tasks: changed(op.lists.tasks, result.tasks), projects: changed(op.lists.projects, result.projects),
        sections: changed(op.lists.sections, result.sections), sourceBefore: source,
        deviceIdBefore: op.deviceIdBefore, deviceIdToInitialize: op.deviceIdToInitialize,
        guards: { selectedProject: op.lists.projects.find((r) => r.id === after.projectId) ?? null,
            selectedArea: op.lists.areas.find((r) => r.id === after.areaId) ?? null, taskOrders: [], reactivation: null,
            recurringCandidate: null, recurringDuplicate: null, focusCount: fills ? count : null,
            focusLimit: fills ? limit : null, focusBoundary: fills ? op.clock.futureBoundary : null, autoArchiveDays: null } };
};
// Freeze only values actually consumed by Choose. First plan with the whole
// normal RN state, then require that the smaller witness reproduces it exactly.
const trimChooseOperation = (request: Extract<NativeReferenceProjectNextActionRequest, { action: 'choose' }>, op: ChooseOperation): ChooseOperation => {
    const source = op.effect.sourceBefore;
    const sections = op.lists.sections.filter((r) => r.id === source.sectionId);
    const parentIds = new Set([source.projectId, ...sections.map((r) => r.projectId)]);
    const projects = op.lists.projects.filter((r) => parentIds.has(r.id));
    const areaIds = new Set([source.areaId, ...projects.map((r) => r.areaId)]);
    const tasks = op.lists.tasks.filter((r) => r.id === source.id || op.effect.guards.focusCount !== null
        && countFocusedTasksBeforeBoundary([r], op.clock.futureBoundary, datesOf(op.clock)) === 1);
    const clock = { ...op.clock, dates: op.clock.dates.filter((r) => requiredDates(tasks).includes(r.value)) };
    const settings = { ...(op.deviceIdBefore === null ? {} : { deviceId: op.deviceIdBefore }),
        gtd: { focusTaskLimit: normalizeFocusTaskLimit(op.settings.gtd?.focusTaskLimit) } };
    const trimmed = { ...op, lists: { tasks, projects, sections, areas: op.lists.areas.filter((r) => areaIds.has(r.id)) }, settings, clock };
    if (!same(chooseEffect(request, trimmed), op.effect)) throw new Error('Choose consumed scope differs');
    return trimmed;
};
const validDevice = (op: { deviceIdBefore: string | null; deviceIdToInitialize: string | null }) => op.deviceIdBefore === null
    ? typeof op.deviceIdToInitialize === 'string' && UUID.test(op.deviceIdToInitialize) : text(op.deviceIdBefore, 500) && op.deviceIdToInitialize === null;
const creationKeys = ['status', 'projectId', 'sectionId', 'areaId', 'startTime', 'dueDate', 'reviewAt', 'description', 'contexts', 'tags', 'priority', 'energyLevel', 'assignedTo', 'attachments', 'isFocusedToday', 'timeEstimate'];
const validResolvedDate = (v: unknown): boolean => iso(v) || typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
    && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const validIntent = (v: unknown, context: NativeProjectNextActionContext): v is NativeProjectNextActionResolvedIntent => {
    if (!record(v) || !exact(v, ['title', 'props']) || !text(v.title, 100_000) || v.title.trim() !== v.title || !record(v.props)
        || Object.keys(v.props).some((k) => !creationKeys.includes(k)) || !text(v.props.projectId, 500)
        || !['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived'].includes(String(v.props.status))) return false;
    const p = v.props;
    if (p.sectionId !== undefined && (p.projectId !== context.project.id || !context.section || p.sectionId !== context.section.id)
        || ['sectionId', 'areaId'].some((k) => p[k] !== undefined && !text(p[k], 500))
        || ['description', 'assignedTo'].some((k) => p[k] !== undefined && (typeof p[k] !== 'string' || p[k].length > 100_000))
        || p.startTime !== undefined && !iso(p.startTime)
        || ['reviewAt', 'dueDate'].some((k) => p[k] !== undefined && !validResolvedDate(p[k]))

        || ['tags', 'contexts'].some((k) => p[k] !== undefined && (!Array.isArray(p[k]) || p[k].length > 1000 || !p[k].every((s: unknown) => text(s, 1000))))
        || p.priority !== undefined && !['low', 'medium', 'high', 'urgent'].includes(String(p.priority))
        || p.energyLevel !== undefined && !['low', 'medium', 'high'].includes(String(p.energyLevel))
        || p.timeEstimate !== undefined && !isTimeEstimate(p.timeEstimate)
        || p.isFocusedToday !== undefined && p.isFocusedToday !== true) return false;
    return p.attachments === undefined || Array.isArray(p.attachments) && p.attachments.length <= 1000 && unique(p.attachments as { id: string }[])
        && p.attachments.every((a) => record(a) && exact(a, ['id', 'kind', 'title', 'uri', 'createdAt', 'updatedAt'])
            && typeof a.id === 'string' && UUID.test(a.id) && a.kind === 'link' && text(a.title, 100_000) && text(a.uri, 100_000)
            && iso(a.createdAt) && a.createdAt === a.updatedAt);
};
// The intent cannot carry a reminder policy, so the new row inherits the library
// default and its suppression flag records that default. The journal shape (which
// Swift checks exactly) stays unchanged: rows written before Skip was honored
// carry `false`, which replays as Send, exactly as they were prepared.
const frozenReminderDefault = (task: Task): 'send' | 'skip' => task.suppressMindwtrReminders === true ? 'skip' : 'send';
const addTask = (op: AddOperation, taskReminderDefault = frozenReminderDefault(op.task)): Task => {
    const { creation: c } = op; const f = c.focus; const props = c.intent.props;
    const built = buildNewTask({ title: c.intent.title, initialTaskProps: props, id: op.task.id, now: op.updateAt,
        deviceId: op.deviceIdBefore ?? op.deviceIdToInitialize!, state: { settings: { taskReminderDefault }, _allProjects: [c.containers.project],
            _allSections: c.containers.section ? [c.containers.section] : [], _allAreas: c.containers.areas },
        tasks: f?.lists.tasks ?? [], focusedCount: f?.focusCount ?? 0, focusTaskLimit: f?.focusLimit ?? 1,
        projectOrderReserver: (id) => { if (id !== c.projectOrder.projectId) throw new Error('Unknown creation order'); return c.projectOrder.max + 1; },
        endOfTodayIso: f?.futureBoundary, frozenDates: f ? datesOf(f) : undefined });
    if (!built.ok) throw new Error(built.error); return built.task;
};
const rawBeforeOf = (data: AppData, tasks: { before: Task | null; after: Task }[], projects: { before: Project | null; after: Project }[], sections: { before: Section | null; after: Section }[]): PreparedChecklistRawBefore => ({
    tasks: tasks.map((r) => ({ id: r.after.id, before: r.before ? rawReadTaskSnapshot(data.tasks.find((t) => t.id === r.after.id)!) : null })),
    projects: projects.map((r) => ({ id: r.after.id, before: r.before ? rawReadProjectSnapshot(data.projects.find((t) => t.id === r.after.id)!) : null })),
    sections: sections.map((r) => ({ id: r.after.id, before: r.before ? (data.sections ?? []).find((t) => t.id === r.after.id)! : null })),
});

/** One prompt coordinator; the existing three writers own all actual effects. */
export function createReferenceProjectNextActionMethods(deps: { readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>; t: () => (key: string) => string; originMethods: OriginMethods }) {
    const readOrigin = (v: unknown): NativeReferenceProjectNextActionOrigin | null => {
        if (!record(v) || !exact(v, ['kind', 'envelope']) || !record(v.envelope)) return null;
        const o = v as unknown as NativeReferenceProjectNextActionOrigin;
        if (o.kind === 'completion') {
            if (o.envelope.prepared?.version !== 2 || o.envelope.prepared.kind !== 'referenceComplete') return null;
            return deps.originMethods.validatePreparedTaskCompletion(o.envelope).ok ? o : null;
        }
        if (o.kind !== 'backdate' || o.envelope.prepared?.version !== 2 || o.envelope.prepared.kind !== 'referenceBackdate') return null;
        return deps.originMethods.validatePreparedReferenceTaskBackdate(o.envelope).ok ? o : null;
    };
    const originSaved = (o: NativeReferenceProjectNextActionOrigin): boolean => {
        const result = o.kind === 'completion' ? deps.originMethods.taskCompletionOutcome(o.envelope)
            : deps.originMethods.referenceTaskBackdateOutcome(o.envelope);
        return result.ok && result.value !== null && same(result.value, o.envelope.prepared.result);
    };
    const durableOrigin = async (o: NativeReferenceProjectNextActionOrigin,
        adapter: ReturnType<typeof import('./store')['getStorageAdapter']>): Promise<NativeHostResult<null>> => {
        if (!originSaved(o)) return fail('STALE_REVISION', 'Completion has no exact saved receipt');
        if (!(adapter instanceof NativeReceiptSqliteAdapter)) return fail('SAVE_FAILED', 'Project next action requires readable durable receipts');
        const prefix = o.kind === 'completion' ? 'referenceTaskCompletion' : 'referenceTaskBackdate';
        const receipt = await adapter.readDurableReceipt(o.envelope.request.requestId, canonical([prefix, o.envelope]));
        if (!receipt.ok) return receipt;
        return receipt.value !== null && same(receipt.value, o.envelope.prepared.result) ? { ok: true, value: null }
            : fail('STALE_REVISION', 'Completion has no exact current durable receipt');
    };
    const armOrigin = (e: NativeReferenceProjectNextActionEnvelope,
        adapter: ReturnType<typeof import('./store')['getStorageAdapter']>): (() => void) => {
        if (!(adapter instanceof NativeReceiptSqliteAdapter)) throw new Error('Durable receipt storage changed');
        const origin = e.prepared.origin; const prefix = origin.kind === 'completion' ? 'referenceTaskCompletion' : 'referenceTaskBackdate';
        const key = payload(e);
        adapter.armReceiptPrerequisite(e.request.requestId, key, origin.envelope.request.requestId,
            canonical([prefix, origin.envelope]), origin.envelope.prepared.result);
        return () => adapter.clearReceiptPrerequisite(e.request.requestId, key);
    };
    const readEnvelope = (v: unknown): NativeReferenceProjectNextActionEnvelope | null => {
        const e = detach<NativeReferenceProjectNextActionEnvelope>(v);
        if (!e || !record(e) || !exact(e, ['request', 'prepared']) || !record(e.prepared)) return null;
        const r = readRequest(e.request); const p = e.prepared;
        if (!r || !exact(p, ['version', 'kind', 'request', 'origin', 'context', 'rawBefore', 'operation', 'result'])
            || p.version !== 1 || p.kind !== 'referenceProjectNextAction' || !same(r, p.request)
            || !readOrigin(p.origin) || !same(refOf(p.origin), r.origin) || !record(p.context)
            || !exact(p.context, ['source', 'rawSource', 'project', 'section', 'tasks', 'scope'])
            || !validTask(p.context.source) || !validTask(p.context.rawSource)
            || p.context.source.id !== r.origin.id || p.context.rawSource.id !== r.origin.id
            || !validProjectSnapshot(p.context.project, p.context.project.id) || p.context.project.status !== 'active'
            || p.context.source.projectId !== p.context.project.id || !Array.isArray(p.context.tasks)
            || !p.context.tasks.every(validTask) || !unique(p.context.tasks)
            || p.context.tasks.some((t) => t.projectId !== p.context.project.id)
            || !same(p.context.tasks.find((t) => t.id === r.origin.id), p.context.source)
            || (p.context.section !== null && (!validSection(p.context.section, p.context.section.id, p.context.project.id)
                || p.context.section.deletedAt || p.context.section.projectId !== p.context.project.id))
            || (p.context.source.sectionId ?? null) !== (p.context.section?.id ?? null)
            || revisionOf(p.context) !== r.promptRevision || policyOf(p.context)?.scope !== p.context.scope
            || !record(p.operation) || !record(p.rawBefore) || !exact(p.rawBefore, ['tasks', 'projects', 'sections'])
            || !record(p.result)) return null;
        const op = p.operation; let tasks: { before: Task | null; after: Task }[];
        let projects: { before: Project | null; after: Project }[]; let sections: { before: Section | null; after: Section }[];
        let expectedResult: NativeReferenceProjectNextActionResult; let at: string;
        try {
            if (op.kind === 'choose' && r.action === 'choose') {
                if (!exact(op, ['kind', 'lists', 'settings', 'deviceIdBefore', 'deviceIdToInitialize', 'updateAt', 'clock', 'effect'])
                    || !validLists(op.lists) || !record(op.settings) || !validDevice(op) || !validClock(op.clock, op.updateAt, op.lists.tasks)
                    || !exact(op.settings, op.deviceIdBefore === null ? ['gtd'] : ['deviceId', 'gtd'])
                    || !record(op.settings.gtd) || !exact(op.settings.gtd, ['focusTaskLimit'])
                    || op.settings.gtd.focusTaskLimit !== normalizeFocusTaskLimit(op.settings.gtd.focusTaskLimit)
                    || !same(op.settings.deviceId ?? null, op.deviceIdBefore)
                    || !policyOf(p.context)?.candidates.some((t) => t.id === r.candidateId && taskRevisionOf(t) === r.candidateRevision)) return null;
                const effect = chooseEffect(r, op);
                if (!same(effect, op.effect) || effect.tasks.length !== 1 || effect.projects.length || effect.sections.length) return null;
                tasks = effect.tasks; projects = effect.projects; sections = effect.sections; at = op.updateAt;
                expectedResult = { action: 'choose', id: r.candidateId };
            } else if (op.kind === 'add' && r.action === 'add') {
                if (!exact(op, ['kind', 'creation', 'task', 'deviceIdBefore', 'deviceIdToInitialize', 'updateAt']) || !validDevice(op)
                    || !iso(op.updateAt) || !validTask(op.task) || !UUID.test(op.task.id) || !record(op.creation)
                    || !exact(op.creation, ['intent', 'containers', 'projectOrder', 'focus']) || !validIntent(op.creation.intent, p.context)
                    || !record(op.creation.containers) || !exact(op.creation.containers, ['project', 'section', 'areas'])
                    || !validProjectSnapshot(op.creation.containers.project, op.creation.intent.props.projectId!)
                    || op.creation.containers.project.status === 'archived'
                    || !Array.isArray(op.creation.containers.areas) || !unique(op.creation.containers.areas)
                    || !op.creation.containers.areas.every((a) => record(a) && text(a.id, 500) && typeof a.name === 'string' && !a.deletedAt)
                    || (op.creation.containers.section !== null && (!validSection(op.creation.containers.section, op.creation.intent.props.sectionId!, op.creation.containers.project.id)
                        || op.creation.containers.section.deletedAt || op.creation.containers.section.projectId !== op.creation.containers.project.id))
                    || (op.creation.intent.props.sectionId ?? null) !== (op.creation.containers.section?.id ?? null)
                    || !record(op.creation.projectOrder) || !exact(op.creation.projectOrder, ['projectId', 'max'])
                    || op.creation.projectOrder.projectId !== op.creation.containers.project.id
                    || !Number.isFinite(op.creation.projectOrder.max)) return null;
                const f = op.creation.focus;
                const needsFocus = op.creation.intent.props.isFocusedToday === true && op.creation.intent.props.status !== 'reference';
                if (needsFocus !== (f !== null)) return null;
                if (f) {
                    const { lists, focusCount, focusLimit, ...clock } = f;
                    if (!exact(f, ['lists', 'focusCount', 'focusLimit', 'preparedLocalDay', 'preparedOffsetMinutes', 'boundaryOffsetMinutes', 'futureBoundary', 'dates'])
                        || !record(lists) || !exact(lists, ['tasks', 'projects', 'sections'])
                        || !validLists({ ...lists, areas: [] }) || !validClock(clock, op.updateAt, [...lists.tasks, { ...op.creation.intent.props, id: op.task.id } as Task])
                        || !Number.isSafeInteger(focusCount) || focusCount < 0 || !Number.isSafeInteger(focusLimit) || focusLimit < 1
                        || countFocusedTasksBeforeBoundary(lists.tasks, clock.futureBoundary, datesOf(clock)) !== focusCount
                        || lists.tasks.some((t) => t.id === op.task.id)
                        || !same(lists.projects.find((p) => p.id === op.creation.containers.project.id), op.creation.containers.project)
                        || op.creation.containers.section && !same(lists.sections.find((s) => s.id === op.creation.containers.section!.id), op.creation.containers.section)) return null;
                }
                const ownedIds = [op.task.id, ...(op.creation.intent.props.attachments ?? []).map((a) => a.id)];
                if (new Set(ownedIds).size !== ownedIds.length || ownedIds.includes(op.deviceIdBefore ?? op.deviceIdToInitialize!)
                    || ownedIds.includes(r.origin.id) || ownedIds.includes(p.context.project.id)
                    || !same(addTask(op), op.task)) return null;
                tasks = [{ before: null, after: op.task }]; projects = []; sections = []; at = op.updateAt;
                expectedResult = { action: 'add', id: op.task.id, openAfterSave: r.openAfterSave };
            } else if (op.kind === 'completeProject' && r.action === 'completeProject') {
                if (!exact(op, ['kind', 'lifecycle']) || p.context.scope !== 'project' || !record(op.lifecycle)) return null;
                const l = op.lifecycle;
                if (!exact(l, ['version', 'request', 'scope', 'effect', 'deviceIdBefore', 'deviceIdToInitialize', 'updateAt', 'result'])
                    || l.version !== 1 || !validDevice(l) || !iso(l.updateAt) || !record(l.request)
                    || !exact(l.request, ['requestId', 'projectId', 'projectRevision', 'action']) || l.request.requestId !== r.requestId
                    || l.request.projectId !== p.context.project.id || l.request.action !== 'complete'
                    || !record(l.scope) || !exact(l.scope, ['project', 'tasks', 'sections'])
                    || !validLists({ tasks: l.scope.tasks, projects: [l.scope.project], sections: l.scope.sections, areas: [] })
                    || !same(l.scope.project, projectProjection(p.context.project))
                    || l.request.projectRevision !== rowRevisionOf(l.scope.project)
                    || !same(l.effect, projectLifecycleEffect(l.scope, 'complete', l.deviceIdBefore ?? l.deviceIdToInitialize!, l.updateAt))
                    || !same(l.result, { id: l.request.projectId, status: 'archived' })) return null;
                const sectionIds = new Set(l.scope.sections.map((s) => s.id));
                if (l.scope.sections.some((s) => s.projectId !== l.scope.project.id)
                    || l.scope.tasks.some((t) => t.projectId !== l.scope.project.id && (t.projectId || !t.sectionId || !sectionIds.has(t.sectionId)))) return null;
                tasks = l.effect.tasks; projects = [l.effect.project]; sections = l.effect.sections; at = l.updateAt;
                expectedResult = { action: 'completeProject', id: l.request.projectId, status: 'archived' };
            } else return null;
            if (!same(expectedResult, p.result) || !same(historyRowLoadProjection(p.context.rawSource, at), p.context.source)) return null;
            const bound = <T extends { id: string }>(effects: { before: T | null; after: T }[], captures: { id: string; before: T | null }[], projection: (row: T) => T) =>
                Array.isArray(captures) && captures.length === effects.length && unique(captures)
                && effects.every((effect) => { const b = captures.find((r) => r.id === effect.after.id);
                    return b && record(b) && exact(b, ['id', 'before']) && (effect.before === null ? b.before === null
                        : b.before !== null && same(projection(b.before), effect.before)); });
            if (!bound(tasks, p.rawBefore.tasks, (r) => historyRowLoadProjection(r, at))
                || !bound(projects, p.rawBefore.projects, projectProjection)
                || !bound(sections, p.rawBefore.sections, (r) => r)) return null;
            return e;
        } catch { return null; }
    };
    const checkAuthority = async (e: NativeReferenceProjectNextActionEnvelope, authority: PreparedAreaAuthority,
        adapter: ReturnType<typeof import('./store')['getStorageAdapter']>): Promise<NativeHostResult<null>> => {
        const proof = await durableOrigin(e.prepared.origin, adapter); if (!proof.ok) return proof;
        const p = e.prepared; const data = authority.snapshot; const op = p.operation;
        const at = op.kind === 'completeProject' ? op.lifecycle.updateAt : op.updateAt;
        const lists = normalized(data, at); const context = contextOf(data, lists, p.origin);
        if (!context || !same(context.rawSource, p.context.rawSource) || revisionOf(context) !== e.request.promptRevision)
            return fail('STALE_REVISION', 'Project next actions changed; refresh the prompt');
        try {
            if (op.kind === 'choose') {
                const current = { ...op, lists, settings: data.settings, deviceIdBefore: data.settings.deviceId ?? null };
                if (!same(chooseEffect(e.request as Extract<NativeReferenceProjectNextActionRequest, { action: 'choose' }>, current), op.effect)) throw new Error('Choose changed');
            } else if (op.kind === 'add') {
                const c = op.creation; const project = lists.projects.find((r) => r.id === c.containers.project.id);
                const section = c.containers.section && lists.sections.find((r) => r.id === c.containers.section!.id);
                if ((data.settings.deviceId ?? null) !== op.deviceIdBefore || !same(project, c.containers.project)
                    || !same(section ?? null, c.containers.section) || c.containers.areas.some((a) => !same(lists.areas.find((r) => r.id === a.id), a))
                    || (getNextProjectOrder(c.projectOrder.projectId, lists.tasks) ?? 0) - 1 !== c.projectOrder.max) throw new Error('Creation context changed');
                const ids = [op.task.id, ...(c.intent.props.attachments ?? []).map((r) => r.id)];
                const existing = [...data.tasks, ...data.projects];
                if (existing.some((r) => ids.includes(r.id) || r.attachments?.some((a) => ids.includes(a.id)))) throw new Error('Creation ID exists');
                if (c.focus) {
                    const f = c.focus;
                    // Normal loading can consume local-day environment. Refuse an
                    // unlanded stale intent conservatively; never reinterpret it.
                    if (new Date(at).getTimezoneOffset() !== f.preparedOffsetMinutes
                        || normalizeFocusTaskLimit(data.settings.gtd?.focusTaskLimit) !== f.focusLimit
                        || !same({ tasks: lists.tasks, projects: lists.projects, sections: lists.sections }, f.lists)) throw new Error('Focus creation context changed');
                    if (countFocusedTasksBeforeBoundary(lists.tasks, f.futureBoundary, datesOf(f)) !== f.focusCount) throw new Error('Focus count changed');
                }
            } else {
                const l = op.lifecycle; const sections = lists.sections.filter((r) => r.projectId === l.request.projectId);
                const sectionIds = new Set(sections.map((r) => r.id));
                const tasks = lists.tasks.filter((r) => r.projectId === l.request.projectId || !r.projectId && r.sectionId && sectionIds.has(r.sectionId));
                if ((data.settings.deviceId ?? null) !== l.deviceIdBefore || !same({ project: projectProjection(context.project), tasks, sections }, l.scope)) throw new Error('Project membership changed');
            }
            return { ok: true, value: null };
        } catch { return fail('STALE_REVISION', 'Project next action context changed; refresh while retaining the draft'); }
    };
    const apply = async (e: NativeReferenceProjectNextActionEnvelope, authority: PreparedAreaAuthority): Promise<NativeHostResult<null>> => {
        const op = e.prepared.operation; const options = { requireBefore: true as const, authority, rawBefore: e.prepared.rawBefore };
        const result = op.kind === 'choose' ? await useTaskStore.getState().commitPreparedChecklistEffect(op.effect, options)
            : op.kind === 'add' ? await useTaskStore.getState().commitPreparedCapture({ task: op.task, project: null,
                deviceIdBefore: op.deviceIdBefore, deviceIdToInitialize: op.deviceIdToInitialize }, options)
                : await useTaskStore.getState().commitPreparedProjectLifecycle(op.lifecycle, options);
        return result.success ? { ok: true, value: null } : fail('STALE_REVISION', result.error ?? 'Prepared project next action conflicts with saved data');
    };
    let pending: { envelope: NativeReferenceProjectNextActionEnvelope; adapter: ReturnType<typeof import('./store')['getStorageAdapter']>;
        boundary: PreparedNativeSaveBoundary | undefined } | null = null;
    const saves = createAreaSaveGuard(deps.save);
    const receipts = createNativeRequestReceipts({ save: async (requestId) => {
        const owned = pending;
        if (!owned || owned.envelope.request.requestId !== requestId) return fail('SAVE_FAILED', 'Project next action has no owned save');
        if (useTaskStore.getState().persistenceFailure) {
            if (!saves.mayApply(owned.envelope, owned.adapter)) return fail('SAVE_FAILED', 'Project next action has an unrelated save failure');
            const read = await readAreaDurableData(true, true); if (!read.ok) return read;
            if (read.value.adapter !== owned.adapter) return fail('STALE_REVISION', 'Project next action storage changed');
            const checked = await checkAuthority(owned.envelope, read.value.authority, read.value.adapter); if (!checked.ok) return checked;
            const written = await apply(owned.envelope, read.value.authority); if (!written.ok) return written;
            owned.boundary = read.value.authority.saveBoundary;
        } else {
            const proof = await durableOrigin(owned.envelope.prepared.origin, owned.adapter); if (!proof.ok) return proof;
        }
        const saved = await saves.finish(owned.envelope, owned.adapter, false, owned.boundary);
        if (saved.ok) pending = null; return saved;
    } });
    const diagnose = (r: NativeReferenceProjectNextActionResult) => {
        try { logInfo('Native Reference project next action confirmed', { scope: 'native-host', category: 'storage',
            context: { releaseCheck: 'v1.3.4/ios-reference-project-next-action', outcome: r.action } }); } catch { /* ACK remains durable. */ }
    };
    return {
        referenceProjectNextActionInput(input: string): NativeHostResult<{ canSave: boolean }> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            return typeof input === 'string' && input.length <= 100_000 ? { ok: true, value: { canSave: Boolean(input.trim()) } }
                : fail('INVALID_INPUT', 'A bounded next action title is required');
        },
        async getReferenceProjectNextActionOptions(input: { origin: NativeReferenceProjectNextActionOrigin; params: { offset: number; revision: string | null } }): Promise<NativeHostResult<NativeReferenceProjectNextActionOptions | null>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const v = detach<typeof input>(input);
            if (!v || !record(v) || !exact(v, ['origin', 'params']) || !readOrigin(v.origin) || !record(v.params)
                || !exact(v.params, ['offset', 'revision']) || !Number.isSafeInteger(v.params.offset) || v.params.offset < 0
                || !(v.params.revision === null || text(v.params.revision, 200)) || v.params.offset > 0 && v.params.revision === null)
                return fail('INVALID_INPUT', 'A bounded project next action page and original receipt are required');
            if (!originSaved(v.origin)) return fail('STALE_REVISION', 'Completion has no exact saved receipt');
            const read = await readAreaDurableData(false, true); if (!read.ok) return read;
            const proof = await durableOrigin(v.origin, read.value.adapter); if (!proof.ok) return proof;
            const at = new Date().toISOString(); const lists = normalized(read.value.authority.snapshot, at);
            const c = contextOf(read.value.authority.snapshot, lists, v.origin); if (!c) return { ok: true, value: null };
            const revision = revisionOf(c); if (v.params.revision !== null && v.params.revision !== revision) return fail('STALE_REVISION', 'Project next actions changed; refresh the prompt');
            const policy = policyOf(c)!; const t = deps.t();
            const out: NativeReferenceProjectNextActionOptions = { origin: refOf(v.origin), promptRevision: revision,
                title: t('projects.nextActionPromptTitle'), description: formatI18nTemplate(t(c.scope === 'section' && c.section
                    ? 'projects.nextActionPromptSectionDesc' : 'projects.nextActionPromptDesc'), { project: c.project.title, section: c.section?.title ?? '' }),
                project: { id: c.project.id, title: c.project.title, revision: rowRevisionOf(c.project) },
                section: c.section ? { id: c.section.id, title: c.section.title, revision: rowRevisionOf(c.section) } : null, scope: c.scope,
                candidates: { offset: v.params.offset, total: policy.candidates.length, hasMore: v.params.offset + 100 < policy.candidates.length,
                    items: policy.candidates.slice(v.params.offset, v.params.offset + 100).map((r) => ({ id: r.id, title: r.title,
                        taskRevision: taskRevisionOf(r), status: r.status, statusLabel: t(`status.${r.status}`) })) },
                input: { placeholder: t('projects.nextActionPromptPlaceholder'), addLabel: t('projects.nextActionPromptAddButton'), saveAndEditLabel: t('quickAdd.saveAndEdit') },
                completeProject: c.scope === 'project' ? { label: t('projects.nextActionPromptComplete') } : null, skip: { label: t('common.skip') } };
            return isNativeJsonWithinBytes(out, 2_100_000) ? { ok: true, value: out } : fail('INVALID_INPUT', 'Project next action page is too large; reduce its contents');
        },
        async prepareReferenceProjectNextAction(input: { request: NativeReferenceProjectNextActionRequest; origin: NativeReferenceProjectNextActionOrigin }): Promise<NativeHostResult<NativeReferenceProjectNextActionPreparation>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const v = detach<typeof input>(input); const request = v && readRequest(v.request);
            if (!v || !record(v) || !exact(v, ['request', 'origin']) || !request || !readOrigin(v.origin) || !same(request.origin, refOf(v.origin)))
                return fail('INVALID_INPUT', 'A bounded project next action and original receipt are required');
            if (!originSaved(v.origin)) return fail('STALE_REVISION', 'Completion has no exact saved receipt');
            const read = await readAreaDurableData(false, true); if (!read.ok) return read;
            const proof = await durableOrigin(v.origin, read.value.adapter); if (!proof.ok) return proof;
            const data = read.value.authority.snapshot; const updateAt = new Date().toISOString(); const lists = normalized(data, updateAt);
            const context = contextOf(data, lists, v.origin);
            if (!context || revisionOf(context) !== request.promptRevision) return fail('STALE_REVISION', 'Project next actions changed; refresh the prompt');
            const device = ensureDeviceId(data.settings); const deviceFields = { deviceIdBefore: data.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null };
            try {
                let operation: NativePreparedReferenceProjectNextAction['operation']; let result: NativeReferenceProjectNextActionResult;
                let rawBefore: PreparedChecklistRawBefore;
                if (request.action === 'choose') {
                    const clock = clockOf(updateAt, lists.tasks);
                    const op: ChooseOperation = { kind: 'choose', lists, settings: data.settings, ...deviceFields, updateAt, clock, effect: null as never };
                    op.effect = chooseEffect(request, op); operation = trimChooseOperation(request, op); result = { action: 'choose', id: request.candidateId };
                    rawBefore = rawBeforeOf(data, op.effect.tasks, op.effect.projects, op.effect.sections);
                } else if (request.action === 'add') {
                    const parsed = parseProjectNextActionInput(request.text, { projectId: context.project.id, sectionId: context.section?.id,
                        projects: lists.projects, areas: lists.areas, parseOptions: buildQuickAddParseOptions(data.settings,
                            { tasks: selectVisibleTasks(lists.tasks), _allTasks: lists.tasks, people: selectVisiblePeople(data.people ?? []) }) });
                    const intent = { title: parsed.title, props: parsed.props };
                    if (!validIntent(intent, context)) return fail('INVALID_INPUT', 'Resolved next action cannot be represented safely');
                    const project = lists.projects.find((r) => r.id === intent.props.projectId)!;
                    const section = intent.props.sectionId ? lists.sections.find((r) => r.id === intent.props.sectionId) ?? null : null;
                    const areas = intent.props.areaId ? lists.areas.filter((r) => r.id === intent.props.areaId) : [];
                    const needsFocus = intent.props.isFocusedToday === true && intent.props.status !== 'reference';
                    const creationAt = new Date().toISOString(); const id = generateUUID();
                    const focus = needsFocus ? { ...clockOf(creationAt, [...lists.tasks, { ...intent.props, id } as Task]),
                        lists: { tasks: lists.tasks, projects: lists.projects, sections: lists.sections },
                        focusCount: 0, focusLimit: normalizeFocusTaskLimit(data.settings.gtd?.focusTaskLimit) } : null;
                    if (focus) focus.focusCount = countFocusedTasksBeforeBoundary(lists.tasks, focus.futureBoundary, datesOf(focus));
                    const op: AddOperation = { kind: 'add', creation: { intent, containers: { project, section, areas },
                        projectOrder: { projectId: project.id, max: (getNextProjectOrder(project.id, lists.tasks) ?? 0) - 1 }, focus },
                        task: { id } as Task, ...deviceFields, updateAt: creationAt };
                    op.task = addTask(op, getTaskReminderDefault(data.settings)); operation = op; result = { action: 'add', id, openAfterSave: request.openAfterSave };
                    rawBefore = { tasks: [{ id, before: null }], projects: [], sections: [] };
                } else {
                    if (context.scope !== 'project') return fail('INVALID_INPUT', 'This section prompt cannot complete its project');
                    const sections = lists.sections.filter((r) => r.projectId === context.project.id); const ids = new Set(sections.map((r) => r.id));
                    const scope = { project: projectProjection(context.project), sections, tasks: lists.tasks.filter((r) => r.projectId === context.project.id || !r.projectId && r.sectionId && ids.has(r.sectionId)) };
                    const lifecycle: PreparedProjectLifecycle = { version: 1, request: { requestId: request.requestId, projectId: context.project.id,
                        projectRevision: rowRevisionOf(context.project), action: 'complete' }, scope,
                        effect: projectLifecycleEffect(scope, 'complete', device.deviceId, updateAt), ...deviceFields, updateAt,
                        result: { id: context.project.id, status: 'archived' } };
                    operation = { kind: 'completeProject', lifecycle }; result = { action: 'completeProject', id: context.project.id, status: 'archived' };
                    rawBefore = rawBeforeOf(data, lifecycle.effect.tasks, [lifecycle.effect.project], lifecycle.effect.sections);
                }
                const prepared: NativePreparedReferenceProjectNextAction = { version: 1, kind: 'referenceProjectNextAction', request,
                    origin: v.origin, context, rawBefore, operation, result };
                const envelope = readEnvelope({ request, prepared });
                return envelope ? { ok: true, value: { kind: 'prepared', prepared: envelope.prepared } }
                    : fail('INVALID_INPUT', 'Project next action cannot produce a valid bounded journal');
            } catch { return fail('INVALID_INPUT', 'Project next action cannot be prepared against its current containers or Focus state'); }
        },
        validatePreparedReferenceProjectNextAction(input: NativeReferenceProjectNextActionEnvelope): NativeHostResult<NativeReferenceProjectNextActionResult> {
            const e = readEnvelope(input); return e ? { ok: true, value: e.prepared.result } : fail('INVALID_INPUT', 'Invalid prepared project next action');
        },
        async commitPreparedReferenceProjectNextAction(input: NativeReferenceProjectNextActionEnvelope): Promise<NativeHostResult<NativeReferenceProjectNextActionResult>> {
            const e = readEnvelope(input); if (!e) return fail('INVALID_INPUT', 'Invalid prepared project next action');
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const key = payload(e); const saved = receipts.saved<NativeReferenceProjectNextActionResult>(e.request.requestId, key);
            if (saved) { if (saved.ok && !same(saved.value, e.prepared.result)) return fail('INVALID_INPUT', 'Saved next action result differs');
                if (saved.ok) diagnose(saved.value); return saved; }
            let prewrite: NativeHostResult<never> | null = null;
            const notLanded = (message: string) => { prewrite = fail('SAVE_FAILED', message); return fail('ACTION_FAILED', message); };
            const confirmed = await receipts.run(e.request.requestId, key, async () => {
                if (useTaskStore.getState().persistenceFailure) return notLanded('Project next action has an unresolved save failure');
                const read = await readAreaDurableData(false, true);
                if (!read.ok) return read.error.code === 'SAVE_FAILED' ? notLanded(read.error.message) : read;
                const checked = await checkAuthority(e, read.value.authority, read.value.adapter);
                if (!checked.ok) return checked.error.code === 'SAVE_FAILED' ? notLanded(checked.error.message) : checked;
                const disarm = armOrigin(e, read.value.adapter);
                let written: NativeHostResult<null>;
                try { written = await apply(e, read.value.authority); } catch (error) { disarm(); throw error; }
                if (!written.ok) { disarm(); return written; }
                pending = { envelope: e, adapter: read.value.adapter, boundary: read.value.authority.saveBoundary };
                return { ok: true, value: e.prepared.result };
            });
            if (prewrite) return prewrite;
            if (confirmed.ok) { if (!same(confirmed.value, e.prepared.result)) return fail('INVALID_INPUT', 'Saved next action result differs'); diagnose(confirmed.value); }
            return confirmed;
        },
        referenceProjectNextActionOutcome(input: NativeReferenceProjectNextActionEnvelope): NativeHostResult<NativeReferenceProjectNextActionResult | null> {
            const e = readEnvelope(input); if (!e) return fail('INVALID_INPUT', 'Invalid prepared project next action');
            const saved = receipts.saved<NativeReferenceProjectNextActionResult>(e.request.requestId, payload(e));
            if (!saved) return { ok: true, value: null };
            return saved.ok && !same(saved.value, e.prepared.result) ? fail('INVALID_INPUT', 'Saved next action result differs') : saved;
        },
    };
}
