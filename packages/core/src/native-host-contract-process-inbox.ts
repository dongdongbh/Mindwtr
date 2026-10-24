import { DEFAULT_PROJECT_COLOR } from './color-constants';
import { logInfo } from './logger';
import { normalizeFocusTaskLimit } from './focus-utils';
import { safeParseDate } from './date';
import { countFocusedTasksBeforeBoundary } from './task-utils';
import {
    answerProcessInboxStep,
    buildProcessInboxDecisionRequest,
    getProcessInboxDefaultScheduleTime,
    prepareProcessInboxDraftDecision,
    prepareProcessInboxProjectConversion,
    resolveProcessInboxProjectSearchSubmit,
    type ProcessInboxAnswers,
    type ProcessInboxCommitKind,
    type ProcessInboxCommitOptions,
    type ProcessInboxCommitted,
    type ProcessInboxDraft,
    type ProcessInboxMode,
    type ProcessInboxParsedTitle,
    type ProcessInboxPendingDate,
    type PreparedProcessInboxCommit,
} from './process-inbox-model';
import type { ProcessInboxPlan } from './process-inbox-plan';
import { resolveProcessInboxPlan } from './process-inbox-plan';
import { resolveProcessInboxWorkflowEvent } from './process-inbox-workflow';
import { projectNextRecurringTask, type RecurrenceProjection } from './recurrence';
import { findSelectableProjectByTitleAndArea } from './project-utils';
import { buildNewProject } from './store-projects/project-actions';
import { buildNewTask } from './task-creation';
import { getTaskReminderDefault } from './task-reminder-policy';
import { createProjectOrderReserver, ensureDeviceId, getNextProjectOrder, getTaskOrder, nextRevision } from './store-helpers';
import { planTaskUpdateEffects, prepareTaskUpdatesForStore, taskEditValuesEqual } from './store-tasks';
import type { PreparedInboxEffect, TaskStore } from './store-types';
import type { AppData, Area, Project, Section, Task } from './types';
import { generateUUID } from './uuid';

export type NativeInboxCommitRequest = {
    sessionId: string; taskId: string; step: string; decision: { choice: string }; requestId: string;
};
export type NativeInboxSkipRequest = { sessionId: string; taskId: string; requestId: string };
export type NativeInboxWriteRequest = NativeInboxCommitRequest | NativeInboxSkipRequest;
export type NativeInboxDurableResult = {
    kind: 'decision' | 'skip' | 'projectCreate';
    taskId: string;
    decisionKind?: ProcessInboxCommitKind | 'convert';
    createdProjectId?: string;
    createdActionIds?: string[];
};

type ParserRecord = { input: string; parsed: ProcessInboxParsedTitle };
type Lists = { tasks: Task[]; projects: Project[]; sections: Section[]; areas: Area[] };
type NativeInboxWitness = {
    source: Task;
    mode: ProcessInboxMode;
    answers: ProcessInboxAnswers;
    draft: ProcessInboxDraft;
    plan: ProcessInboxPlan;
    decisionKind: ProcessInboxCommitKind | 'convert' | null;
    committed: ProcessInboxCommitted | null;
    parser: ParserRecord[];
    preparedAt: string;
    futureBoundary: string;
    preparedOffsetMinutes: number;
    boundaryOffsetMinutes: number;
    preparedLocalDay: string;
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    settings: AppData['settings'];
    lists: Lists;
    recurrenceProjection: RecurrenceProjection | null;
    decisionRequest?: ReturnType<typeof buildProcessInboxDecisionRequest>;
    preparedDecision?: PreparedProcessInboxCommit;
    undefinedFields: string[][];
    ids: string[];
    membership: { projectId: string; taskIds: string[]; sectionIds: string[] } | null;
    focusCount: number;
    focusLimit: number;
};
export type NativePreparedInboxWrite = {
    version: 1;
    request: NativeInboxWriteRequest;
    kind: NativeInboxDurableResult['kind'];
    witness: NativeInboxWitness;
    effect: PreparedInboxEffect;
    result: NativeInboxDurableResult;
};
export type NativeInboxPreparation =
    | { kind: 'prepared'; prepared: NativePreparedInboxWrite }
    | { kind: 'notice'; reason: 'incubate-date-required' | 'invalid-date-command' | 'later-start-required' | 'next-action-required' | 'no-title'; invalidDateCommands?: string[] }
    | { kind: 'unavailable' };

const LIMIT_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const PARSED_FIELDS = ['startTime', 'dueDate', 'reviewAt', 'description', 'contexts', 'tags', 'attachments',
    'projectId', 'areaId', 'sectionId', 'energyLevel', 'priority', 'assignedTo', 'isFocusedToday'];
const NATIVE_DATE = /^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?)?$/;
const validDate = (value: unknown): value is string => typeof value === 'string'
    && value.length <= 64 && NATIVE_DATE.test(value) && safeParseDate(value) !== null;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]));
    return value;
};
const same = (left: unknown, right: unknown) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const undefinedFields = (value: unknown, path: string[] = []): string[][] => {
    if (!isRecord(value)) return [];
    return Object.entries(value).flatMap(([key, entry]) => entry === undefined ? [[...path, key]]
        : undefinedFields(entry, [...path, key]));
};
const restoreUndefined = <T>(value: T, paths: string[][]): T => {
    const copy = JSON.parse(JSON.stringify(value)) as T;
    for (const path of paths) {
        if (!path.length || path.length > 8 || path.some((field) => !field || ['__proto__', 'prototype', 'constructor'].includes(field))) {
            throw new Error('Invalid undefined-field witness');
        }
        let node: unknown = copy;
        for (const field of path.slice(0, -1)) {
            if (!isRecord(node)) throw new Error('Invalid undefined-field path');
            node = node[field];
        }
        if (!isRecord(node) || Object.prototype.hasOwnProperty.call(node, path[path.length - 1])) {
            throw new Error('Invalid undefined-field target');
        }
        node[path[path.length - 1]] = undefined;
    }
    return copy;
};
const detach = <T>(value: T): T | null => {
    const valid = (item: unknown, depth: number): boolean => {
        if (depth > 30) return false;
        if (item === null || typeof item === 'string' || typeof item === 'boolean') return true;
        if (typeof item === 'number') return Number.isFinite(item);
        if (Array.isArray(item)) return item.length <= LIMIT_BYTES && item.every((entry) => valid(entry, depth + 1));
        return isRecord(item) && (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)
            && Object.keys(item).length <= 256 && Object.entries(item).every(([key, entry]) => (
                !['__proto__', 'constructor', 'prototype'].includes(key) && valid(entry, depth + 1)
            ));
    };
    if (!valid(value, 0)) return null;
    const json = JSON.stringify(value);
    return json.length <= LIMIT_BYTES ? JSON.parse(json) as T : null;
};
const withFrozenDateValues = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(withFrozenDateValues);
    if (isRecord(value)) return Object.fromEntries(Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, ['startTime', 'dueDate', 'reviewAt'].includes(key)
            ? '<frozen-date>' : withFrozenDateValues(entry)]));
    return value;
};
const pending = (value: ProcessInboxDraft['startTime']): ProcessInboxPendingDate => value
    ? { value: value.date, dateOnly: value.dateOnly, ...(value.useDefaultTime ? { useDefaultTime: true } : {}) }
    : { value: null, dateOnly: false };
const isCommit = (value: NativeInboxWriteRequest): value is NativeInboxCommitRequest => 'decision' in value;
export const isNativeInboxWriteRequest = (value: unknown, kind?: 'commit' | 'skip'): value is NativeInboxWriteRequest => {
    if (!isRecord(value) || typeof value.sessionId !== 'string' || value.sessionId.length > 500
        || typeof value.taskId !== 'string' || value.taskId.length > 500
        || typeof value.requestId !== 'string' || !UUID.test(value.requestId)) return false;
    if (kind === 'commit' || (kind === undefined && Object.prototype.hasOwnProperty.call(value, 'decision'))) {
        return exactKeys(value, ['sessionId', 'taskId', 'step', 'decision', 'requestId'])
            && typeof value.step === 'string' && value.step.length <= 100 && isRecord(value.decision)
            && exactKeys(value.decision, ['choice']) && typeof value.decision.choice === 'string'
            && value.decision.choice.length <= 100;
    }
    return exactKeys(value, ['sessionId', 'taskId', 'requestId']);
};

const minimalSettings = (settings: AppData['settings']): AppData['settings'] => JSON.parse(JSON.stringify({
    deviceId: settings.deviceId,
    features: { priorities: settings.features?.priorities, timeEstimates: settings.features?.timeEstimates },
    gtd: {
        inboxProcessing: settings.gtd?.inboxProcessing,
        taskEditor: { hidden: settings.gtd?.taskEditor?.hidden },
        defaultScheduleTime: settings.gtd?.defaultScheduleTime,
        defaultProjectFlowMode: settings.gtd?.defaultProjectFlowMode,
        defaultAreaMode: settings.gtd?.defaultAreaMode,
        defaultAreaId: settings.gtd?.defaultAreaId,
        focusTaskLimit: settings.gtd?.focusTaskLimit,
        viewSections: settings.gtd?.viewSections,
    },
}));
const futureBoundary = (now: string): string => {
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    return end.toISOString();
};

type PlanningContext = {
    request: NativeInboxWriteRequest;
    witness: NativeInboxWitness;
    parseTitle: (input: string) => ProcessInboxParsedTitle;
    nextId: () => string;
    allowMembershipDiscovery?: boolean;
    /** Created actions inherit it. Validation reads it back from their frozen rows, so the witness keeps its shape. */
    taskReminderDefault: 'send' | 'skip';
};
type Planned = { effect: PreparedInboxEffect; result: NativeInboxDurableResult;
    decisionRequest?: NativeInboxWitness['decisionRequest']; preparedDecision?: PreparedProcessInboxCommit;
    reason?: never };
type Refused = { reason: Extract<NativeInboxPreparation, {kind:'notice'}>['reason']; invalidDateCommands?: string[] };

const changedRows = <T extends { id: string }>(before: readonly T[], after: readonly T[]): Array<{ before: T | null; after: T }> => {
    const old = new Map(before.map((row) => [row.id, row]));
    return after.flatMap((row) => {
        const previous = old.get(row.id) ?? null;
        return previous && taskEditValuesEqual(previous, row) ? [] : [{ before: previous, after: row }];
    });
};

const dateRequest = (witness: NativeInboxWitness, kind: ProcessInboxCommitKind) => buildProcessInboxDecisionRequest(kind, {
    task: witness.source,
    defaultScheduleTime: getProcessInboxDefaultScheduleTime(witness.settings),
    somedaySectionId: witness.draft.somedaySectionId ?? undefined,
    startDate: pending(witness.draft.startTime),
    reviewDate: pending(witness.draft.reviewAt),
    followUpDate: pending(witness.draft.followUp),
    delegateWho: witness.draft.delegateWho,
    assignedTo: witness.draft.assignedTo,
    projectId: witness.draft.projectId,
    now: new Date(witness.preparedAt),
});

const planWrite = ({ request, witness, parseTitle, nextId, allowMembershipDiscovery = false, taskReminderDefault }: PlanningContext): Planned | Refused => {
    const { source, draft, plan, lists } = witness;
    const kind: NativeInboxDurableResult['kind'] = witness.decisionKind === null ? 'projectCreate'
        : witness.decisionKind === 'skip' ? 'skip' : 'decision';
    if ((kind === 'skip') !== !isCommit(request) || source.id !== request.taskId) throw new Error('Invalid Inbox operation binding');
    if ((kind === 'skip' || kind === 'projectCreate') && witness.committed !== null) {
        throw new Error('Invalid Inbox completion binding');
    }
    if (isCommit(request) && kind !== 'projectCreate') {
        const answer = answerProcessInboxStep({ choice: request.decision.choice, answers: witness.answers,
            draft, mode: witness.mode, plan, task: source, parseTitle });
        if (answer.type !== 'commit' || answer.kind !== witness.decisionKind || answer.committed !== witness.committed) {
            throw new Error('Invalid Inbox choice binding');
        }
    }
    if (kind === 'projectCreate' && (!isCommit(request) || request.decision.choice !== 'submitProjectSearch')) {
        throw new Error('Invalid Inbox project choice');
    }
    let projects = lists.projects;
    let tasks = lists.tasks;
    let sections = lists.sections;
    let newProject: Project | null = null;
    let actionIds: string[] = [];
    let decisionRequest: NativeInboxWitness['decisionRequest'];
    let preparedDecision: PreparedProcessInboxCommit | undefined;
    let recurringCandidate: Task | null = null;
    let recurringDuplicate: Task | null = null;
    if (kind === 'projectCreate') {
        const exactMatch = findSelectableProjectByTitleAndArea(lists.projects, draft.projectSearch, draft.areaId ?? undefined);
        const submit = resolveProcessInboxProjectSearchSubmit(draft.projectSearch, exactMatch, draft.areaId);
        if (submit.type !== 'create') throw new Error('Project search is not a creation');
        newProject = buildNewProject({ title: submit.title, color: submit.color,
            initialProps: submit.props, existingProjects: projects, existingAreas: lists.areas,
            settings: witness.settings, deviceId: witness.deviceIdBefore ?? witness.deviceIdToInitialize!,
            now: witness.preparedAt, id: nextId() });
        projects = [...projects, newProject];
    } else {
        let decision: Parameters<typeof prepareProcessInboxDraftDecision>[1];
        let options: ProcessInboxCommitOptions;
        let draftForDecision = draft;
        if (witness.decisionKind === 'convert') {
            const conversion = prepareProcessInboxProjectConversion({ task: source,
                parsedTitle: parseTitle(draft.title).title, title: draft.title, nextActionDraft: draft.nextAction,
                extraActionDrafts: draft.extraActions, projects: lists.projects,
                showAreaField: plan.visibleFields.area, areaId: draft.areaId });
            if (!conversion.ok) return { reason: conversion.reason };
            newProject = conversion.existingProject ?? buildNewProject({ title: conversion.projectTitle,
                color: DEFAULT_PROJECT_COLOR, initialProps: conversion.newProjectProps,
                existingProjects: projects, existingAreas: lists.areas, settings: witness.settings,
                deviceId: witness.deviceIdBefore ?? witness.deviceIdToInitialize!,
                now: witness.preparedAt, id: nextId() });
            if (!conversion.existingProject) projects = [...projects, newProject];
            const reserveOrder = createProjectOrderReserver(tasks);
            for (const action of conversion.extraActions) {
                const id = nextId();
                const built = buildNewTask({ title: action.title, initialTaskProps: { status: 'inbox', projectId: newProject.id },
                    id, now: witness.preparedAt, deviceId: witness.deviceIdBefore ?? witness.deviceIdToInitialize!,
                    state: { settings: { ...witness.settings, taskReminderDefault }, _allProjects: projects, _allSections: sections, _allAreas: lists.areas },
                    tasks, focusedCount: witness.focusCount, focusTaskLimit: witness.focusLimit,
                    projectOrderReserver: reserveOrder, endOfTodayIso: witness.futureBoundary });
                if (!built.ok) throw new Error(built.error);
                tasks = [...tasks, built.task];
                actionIds.push(id);
            }
            decision = { type: 'next' };
            options = { fields: { projectId: newProject.id, areaId: undefined },
                titleOverride: conversion.nextAction, fallbackTitle: source.title };
            draftForDecision = { ...draft, extraActions: [] };
        } else {
            decisionRequest = witness.decisionRequest ?? dateRequest(witness, witness.decisionKind!);
            if (!decisionRequest.ok) return { reason: decisionRequest.reason };
            decision = decisionRequest.decision;
            options = decisionRequest.options;
            if (witness.decisionRequest && !same(withFrozenDateValues(dateRequest(witness, witness.decisionKind!)),
                withFrozenDateValues(witness.decisionRequest))) throw new Error('Invalid Inbox decision request');
        }
        const computed = prepareProcessInboxDraftDecision({ task: source, draft: draftForDecision,
            plan, settings: witness.settings, parseTitle }, decision, options);
        if (!computed.ok) return { reason: computed.reason,
            ...(computed.reason === 'invalid-date-command' ? { invalidDateCommands: computed.invalidDateCommands } : {}) };
        if (witness.preparedDecision) {
            if (!witness.preparedDecision.ok) throw new Error('Invalid Inbox prepared decision');
            if (!same(withFrozenDateValues(computed), withFrozenDateValues(witness.preparedDecision))
                || !same(undefinedFields(computed), witness.undefinedFields)
                || !same(computed.taskUpdates, witness.preparedDecision.taskUpdates)) {
                throw new Error('Invalid Inbox prepared decision');
            }
            const frozenFields = 'fields' in witness.preparedDecision.event
                ? witness.preparedDecision.event.fields : undefined;
            if ('fields' in computed.event && frozenFields) {
                const explicit = witness.decisionRequest?.ok ? witness.decisionRequest.options.explicitDateFields : undefined;
                for (const field of ['startTime', 'dueDate', 'reviewAt'] as const) {
                    const original = source[field];
                    const parsed = witness.parser.find((record) => record.input === (options.titleOverride ?? draft.title))
                        ?.parsed.props[field];
                    const frozen = frozenFields[field];
                    const selected = draft[field];
                    if (frozen !== undefined && frozen !== original && !validDate(frozen)) {
                        throw new Error('Invalid frozen Inbox date');
                    }
                    // Explicit picker edits (including clearing) outrank title tokens in RN.
                    if (!draft.dirtyScheduleFields.includes(field) && parsed !== undefined && frozen !== parsed) {
                        throw new Error('Parsed Inbox date was altered');
                    }
                    if (selected && draft.dirtyScheduleFields.includes(field)) {
                        if (selected.dateOnly ? frozen !== selected.date : typeof frozen !== 'string'
                            || (frozen !== selected.date && !frozen.startsWith(`${selected.date}T`))) {
                            throw new Error('Picked Inbox date was altered');
                        }
                    }
                    if (original && !draft.dirtyScheduleFields.includes(field)
                        && parsed === undefined
                        && !Object.prototype.hasOwnProperty.call(explicit ?? {}, field)
                        && frozen !== undefined && frozen !== original) {
                        throw new Error('Unchanged Inbox date was altered');
                    }
                }
            }
        }
        preparedDecision = witness.preparedDecision
            ? restoreUndefined(witness.preparedDecision, witness.undefinedFields) : computed;
        if (!preparedDecision.ok) throw new Error('Invalid Inbox prepared decision');
        const workflow = resolveProcessInboxWorkflowEvent(preparedDecision.event);
        if (workflow.type === 'delete') {
            const after: Task = { ...source, deletedAt: witness.preparedAt, updatedAt: witness.preparedAt,
                rev: nextRevision(source.rev), revBy: witness.deviceIdBefore ?? witness.deviceIdToInitialize! };
            tasks = tasks.map((task) => task.id === source.id ? after : task);
        } else {
            const updates = { ...workflow.updates, ...preparedDecision.taskUpdates };
            const normalized = prepareTaskUpdatesForStore({ task: source, updates,
                allProjects: projects, allSections: sections, allAreas: lists.areas,
                settings: witness.settings, futureBoundary: witness.futureBoundary,
                reserveProjectOrder: true, projectOrderReserver: createProjectOrderReserver(tasks) });
            if (!normalized.ok) throw new Error(normalized.error);
            const effects = planTaskUpdateEffects({ task: source, preparedUpdates: normalized.updates,
                allTasks: tasks, allProjects: projects, allSections: sections,
                now: witness.preparedAt, deviceId: witness.deviceIdBefore ?? witness.deviceIdToInitialize!,
                createId: nextId,
                recurrenceProjection: normalized.updates.status === 'done' && source.status !== 'done'
                    && source.status !== 'archived' ? witness.recurrenceProjection : undefined });
            tasks = effects.tasks;
            projects = effects.projects;
            sections = effects.sections;
            recurringCandidate = effects.recurringCandidateTask;
            recurringDuplicate = effects.recurringDuplicateTask;
        }
    }
    const taskRows = changedRows(lists.tasks, tasks);
    const projectRows = changedRows(lists.projects, projects);
    const sectionRows = changedRows(lists.sections, sections);
    const reactivated = projectRows.find((row) => row.before?.status === 'archived' && row.after.status === 'active');
    if (!allowMembershipDiscovery && reactivated && (!witness.membership || witness.membership.projectId !== reactivated.after.id
        || !same(witness.membership.taskIds, lists.tasks.filter((task) => task.projectId === reactivated.after.id).map((task) => task.id).sort())
        || !same(witness.membership.sectionIds, lists.sections.filter((section) => section.projectId === reactivated.after.id).map((section) => section.id).sort()))) {
        throw new Error('Incomplete archived-project membership witness');
    }
    if (!allowMembershipDiscovery && !reactivated && witness.membership) throw new Error('Unexpected archived-project membership witness');
    const targetProject = projectRows.find((row) => !row.before)?.after
        ?? projects.find((project) => project.id === taskRows.find((row) => row.after.id === source.id)?.after.projectId);
    const areaId = targetProject?.areaId ?? draft.areaId;
    const selectedArea = areaId ? lists.areas.find((area) => area.id === areaId) ?? null : null;
    const orderProjectIds = Array.from(new Set(taskRows.filter((row) => row.after.projectId
        && (!row.before || row.after.order !== row.before.order || row.after.orderNum !== row.before.orderNum))
        .map((row) => row.after.projectId!)));
    const guards: PreparedInboxEffect['guards'] = {
        selectedProject: targetProject && !projectRows.some((row) => row.after.id === targetProject.id) ? targetProject : null,
        selectedArea,
        projectOrder: projectRows.some((row) => !row.before) ? { areaId: newProject?.areaId ?? null,
            max: lists.projects.filter((project) => (project.areaId ?? null) === (newProject?.areaId ?? null))
                .reduce((max, project) => Math.max(max, Number.isFinite(project.order) ? project.order : -1), -1) } : null,
        taskOrders: orderProjectIds.map((projectId) => ({ projectId,
            max: (getNextProjectOrder(projectId, lists.tasks) ?? 0) - 1 })),
        reactivation: witness.membership,
        recurringCandidate,
        recurringDuplicate,
        defaultScheduleTime: getProcessInboxDefaultScheduleTime(witness.settings),
        defaultProjectFlowMode: newProject && projectRows.some((row) => !row.before)
            ? witness.settings.gtd?.defaultProjectFlowMode ?? null : null,
        creationSettings: projectRows.some((row) => !row.before) || taskRows.some((row) => !row.before)
            ? { defaultAreaMode: witness.settings.gtd?.defaultAreaMode ?? null,
                defaultAreaId: witness.settings.gtd?.defaultAreaId ?? null,
                defaultProjectFlowMode: witness.settings.gtd?.defaultProjectFlowMode ?? null } : null,
        plan,
        focusCount: preparedDecision?.ok && preparedDecision.taskUpdates?.isFocusedToday === true ? witness.focusCount : null,
        focusLimit: preparedDecision?.ok && preparedDecision.taskUpdates?.isFocusedToday === true ? witness.focusLimit : null,
        focusBoundary: preparedDecision?.ok && preparedDecision.taskUpdates?.isFocusedToday === true
            ? witness.futureBoundary : null,
    };
    const effect: PreparedInboxEffect = { kind, tasks: taskRows, projects: projectRows, sections: sectionRows,
        sourceBefore: source, deviceIdBefore: witness.deviceIdBefore,
        deviceIdToInitialize: witness.deviceIdToInitialize, guards };
    if (taskRows.length + projectRows.length + sectionRows.length === 0) throw new Error('Empty prepared Inbox effect');
    const result: NativeInboxDurableResult = { kind, taskId: source.id,
        ...(kind === 'decision' ? { decisionKind: witness.decisionKind! } : {}),
        ...(newProject && projectRows.some((row) => !row.before) ? { createdProjectId: newProject.id } : {}),
        ...(actionIds.length ? { createdActionIds: actionIds } : {}),
    };
    return { effect, result, decisionRequest, preparedDecision };
};

/** The ordinary core contract supplies an already checked, pre-write session. */
export function prepareNativeInboxWrite(input: {
    request: NativeInboxWriteRequest;
    source: Task;
    mode: ProcessInboxMode;
    answers: ProcessInboxAnswers;
    draft: ProcessInboxDraft;
    plan: ProcessInboxPlan;
    committed: ProcessInboxCommitted | null;
    decisionKind: ProcessInboxCommitKind | 'convert' | null;
    state: TaskStore;
    parseTitle: (title: string) => ProcessInboxParsedTitle;
}): NativeInboxPreparation {
    const { request, state, source } = input;
    if (!isNativeInboxWriteRequest(request)) throw new Error('Invalid Inbox request');
    const preparedAt = new Date().toISOString();
    const boundary = futureBoundary(preparedAt);
    const preparedOffsetMinutes = new Date(preparedAt).getTimezoneOffset();
    const boundaryOffsetMinutes = new Date(boundary).getTimezoneOffset();
    const preparedLocalDay = new Date(Date.parse(preparedAt) - preparedOffsetMinutes * 60_000).toISOString().slice(0, 10);
    const device = ensureDeviceId(state.settings);
    const parser: ParserRecord[] = [];
    const parseTitle = (title: string): ProcessInboxParsedTitle => {
        const existing = parser.find((record) => record.input === title);
        if (existing) return existing.parsed;
        if (title.length > 10_000 || parser.length >= 12) throw new Error('Inbox title parser limit exceeded');
        const parsed = input.parseTitle(title);
        parser.push({ input: title, parsed });
        return parsed;
    };
    const ids: string[] = [];
    const nextId = () => {
        if (ids.length >= Math.floor(LIMIT_BYTES / 38)) throw new Error('Inbox generated ID limit exceeded');
        const id = generateUUID();
        ids.push(id);
        return id;
    };
    const lists: Lists = { tasks: state._allTasks, projects: state._allProjects,
        sections: state._allSections, areas: state._allAreas };
    const witness: NativeInboxWitness = {
        source, mode: input.mode, answers: input.answers, draft: input.draft, plan: input.plan,
        decisionKind: input.decisionKind, committed: input.committed, parser,
        preparedAt, futureBoundary: boundary, preparedOffsetMinutes, boundaryOffsetMinutes, preparedLocalDay,
        deviceIdBefore: state.settings.deviceId ?? null,
        deviceIdToInitialize: device.updated ? device.deviceId : null,
        settings: minimalSettings(state.settings), lists,
        recurrenceProjection: input.decisionKind === 'complete' ? projectNextRecurringTask(source, preparedAt) : null,
        ids, membership: null, undefinedFields: [],
        focusCount: countFocusedTasksBeforeBoundary(state.tasks, boundary),
        focusLimit: normalizeFocusTaskLimit(state.settings.gtd?.focusTaskLimit),
    };
    const taskReminderDefault = getTaskReminderDefault(state.settings);
    const planned = planWrite({ request, witness, parseTitle, nextId, allowMembershipDiscovery: true, taskReminderDefault });
    if (planned.reason !== undefined) return { kind: 'notice', reason: planned.reason,
        ...('invalidDateCommands' in planned ? { invalidDateCommands: planned.invalidDateCommands } : {}) };
    if (planned.decisionRequest) witness.decisionRequest = planned.decisionRequest;
    if (planned.preparedDecision) {
        witness.undefinedFields = undefinedFields(planned.preparedDecision);
        witness.preparedDecision = planned.preparedDecision;
    }
    const reopened = planned.effect.projects.find((row) => row.before?.status === 'archived' && row.after.status === 'active');
    if (reopened) {
        witness.membership = { projectId: reopened.after.id,
            taskIds: state._allTasks.filter((task) => task.projectId === reopened.after.id).map((task) => task.id).sort(),
            sectionIds: state._allSections.filter((section) => section.projectId === reopened.after.id).map((section) => section.id).sort() };
        planned.effect.guards.reactivation = witness.membership;
    }
    // The first plan ran against live state. Retain only rows read by its
    // affected set and the bounded order/dedupe/membership guards. Replanning
    // this reduced witness must yield the same complete effect and receipt.
    const relevantTasks = new Set<string>([
        source.id,
        ...planned.effect.tasks.flatMap((row) => [row.before?.id, row.after.id].filter((id): id is string => Boolean(id))),
        ...planned.effect.guards.reactivation?.taskIds ?? [],
        ...(planned.effect.guards.recurringDuplicate ? [planned.effect.guards.recurringDuplicate.id] : []),
    ]);
    for (const { projectId } of planned.effect.guards.taskOrders) {
        const ranked = state._allTasks.filter((task) => task.projectId === projectId && !task.deletedAt)
            .sort((left, right) => (getTaskOrder(right) ?? -1) - (getTaskOrder(left) ?? -1));
        if (ranked[0]) relevantTasks.add(ranked[0].id);
    }
    const relevantProjects = new Set<string>([
        ...planned.effect.projects.flatMap((row) => [row.before?.id, row.after.id].filter((id): id is string => Boolean(id))),
        ...[source.projectId, input.draft.projectId, planned.effect.guards.selectedProject?.id,
            planned.effect.guards.reactivation?.projectId].filter((id): id is string => Boolean(id)),
    ]);
    if (planned.effect.guards.projectOrder) {
        const ranked = state._allProjects.filter((project) =>
            (project.areaId ?? null) === planned.effect.guards.projectOrder!.areaId)
            .sort((left, right) => (right.order ?? -1) - (left.order ?? -1));
        if (ranked[0]) relevantProjects.add(ranked[0].id);
    }
    const relevantSections = new Set<string>([
        ...planned.effect.sections.flatMap((row) => [row.before?.id, row.after.id].filter((id): id is string => Boolean(id))),
        ...planned.effect.guards.reactivation?.sectionIds ?? [],
    ]);
    witness.lists = {
        tasks: state._allTasks.filter((task) => relevantTasks.has(task.id)),
        projects: state._allProjects.filter((project) => relevantProjects.has(project.id)),
        sections: state._allSections.filter((section) => relevantSections.has(section.id)),
        areas: state._allAreas.filter((area) => area.id === input.draft.areaId
            || area.id === source.areaId || area.id === state.settings.gtd?.defaultAreaId
            || area.id === planned.effect.guards.selectedArea?.id
            || planned.effect.projects.some((row) => row.after.areaId === area.id)
            || planned.effect.tasks.some((row) => row.after.areaId === area.id)),
    };
    let idIndex = 0;
    const check = planWrite({ request, witness, taskReminderDefault, parseTitle: (title) => {
        const record = parser.find((entry) => entry.input === title);
        if (!record) throw new Error('Missing frozen Inbox parser result');
        return record.parsed;
    }, nextId: () => {
        const id = ids[idIndex++];
        if (!id) throw new Error('Missing frozen Inbox ID');
        return id;
    } });
    if (check.reason !== undefined || idIndex !== ids.length
        || !same(check.effect, planned.effect) || !same(check.result, planned.result)) {
        throw new Error('Inbox effect exceeds the bounded witness');
    }
    const prepared = detach<NativePreparedInboxWrite>(JSON.parse(JSON.stringify({ version: 1, request, kind: planned.result.kind,
        witness, effect: planned.effect, result: planned.result })));
    if (!prepared) throw new Error('Inbox effect exceeds journal bounds');
    if (!readNativePreparedInboxWrite({ request, prepared })) throw new Error('Inbox effect failed journal self-validation');
    return { kind: 'prepared', prepared };
}

/** Pure verification, including a self-consistent full-effect reconstruction. */
export function readNativePreparedInboxWrite(input: unknown): NativePreparedInboxWrite | null {
    const envelope = detach(input);
    if (!isRecord(envelope) || !exactKeys(envelope, ['request', 'prepared'])
        || !isNativeInboxWriteRequest(envelope.request) || !isRecord(envelope.prepared)
        || !exactKeys(envelope.prepared, ['version', 'request', 'kind', 'witness', 'effect', 'result'])
        || envelope.prepared.version !== 1 || !same(envelope.request, envelope.prepared.request)
        || !isRecord(envelope.prepared.witness) || !isRecord(envelope.prepared.effect)
        || !isRecord(envelope.prepared.result)) return null;
    const prepared = envelope.prepared as NativePreparedInboxWrite;
    const witness = prepared.witness;
    if (!exactKeys(witness as unknown as Record<string, unknown>, [
        'source', 'mode', 'answers', 'draft', 'plan', 'decisionKind', 'committed', 'parser',
        'preparedAt', 'futureBoundary', 'preparedOffsetMinutes', 'boundaryOffsetMinutes', 'preparedLocalDay',
        'deviceIdBefore', 'deviceIdToInitialize', 'settings',
        'lists', 'recurrenceProjection', 'ids', 'membership', 'focusCount', 'focusLimit', 'undefinedFields',
        ...('decisionRequest' in witness ? ['decisionRequest'] : []),
        ...('preparedDecision' in witness ? ['preparedDecision'] : []),
    ]) || !isRecord(witness.source) || witness.source.id !== envelope.request.taskId
        || !isRecord(witness.lists) || !Array.isArray(witness.lists.tasks)
        || !exactKeys(witness.lists, ['tasks', 'projects', 'sections', 'areas'])
        || !Array.isArray(witness.lists.projects) || !Array.isArray(witness.lists.sections)
        || !Array.isArray(witness.lists.areas) || !Array.isArray(witness.parser)
        || !Array.isArray(witness.ids) || !witness.ids.every((id) => typeof id === 'string' && UUID.test(id))
        || !Array.isArray(witness.undefinedFields) || witness.undefinedFields.length > LIMIT_BYTES
        || !witness.undefinedFields.every((path) => Array.isArray(path)
            && path.every((field) => typeof field === 'string' && field.length <= 100))
        || new Set(witness.ids).size !== witness.ids.length
        || witness.ids.some((id) => id === witness.source.id
            || witness.lists.tasks.some((task) => task.id === id)
            || witness.lists.projects.some((project) => project.id === id)
            || witness.lists.sections.some((section) => section.id === id))
        || typeof witness.preparedAt !== 'string' || !Number.isFinite(Date.parse(witness.preparedAt))
        || new Date(witness.preparedAt).toISOString() !== witness.preparedAt
        || typeof witness.futureBoundary !== 'string' || !Number.isFinite(Date.parse(witness.futureBoundary))
        || new Date(witness.futureBoundary).toISOString() !== witness.futureBoundary
        || !Number.isInteger(witness.preparedOffsetMinutes) || Math.abs(witness.preparedOffsetMinutes) > 840
        || !Number.isInteger(witness.boundaryOffsetMinutes) || Math.abs(witness.boundaryOffsetMinutes) > 840
        || typeof witness.preparedLocalDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(witness.preparedLocalDay)
        || new Date(Date.parse(witness.preparedAt) - witness.preparedOffsetMinutes * 60_000).toISOString().slice(0, 10)
            !== witness.preparedLocalDay
        || new Date(Date.parse(`${witness.preparedLocalDay}T23:59:59.999Z`)
            + witness.boundaryOffsetMinutes * 60_000).toISOString() !== witness.futureBoundary
        || !['guided', 'quick'].includes(witness.mode)
        || witness.parser.some((record) => !isRecord(record) || !exactKeys(record,
            ['input', 'parsed']) || typeof record.input !== 'string' || record.input.length > 10_000
            || !isRecord(record.parsed) || !isRecord(record.parsed.props)
            || !exactKeys(record.parsed, ['title', 'props',
                ...(Object.prototype.hasOwnProperty.call(record.parsed, 'invalidDateCommands') ? ['invalidDateCommands'] : [])])
            || typeof record.parsed.title !== 'string' || record.parsed.title.length > 10_000
            || !Object.keys(record.parsed.props).every((field) => PARSED_FIELDS.includes(field))
            || (record.parsed.invalidDateCommands !== undefined
                && (!Array.isArray(record.parsed.invalidDateCommands)
                    || record.parsed.invalidDateCommands.some((command: unknown) =>
                        typeof command !== 'string' || command.length > 500))))
        || (witness.decisionKind !== 'complete' && witness.recurrenceProjection !== null)
        || (!witness.preparedDecision && witness.undefinedFields.length > 0)
        || !same(resolveProcessInboxPlan(witness.settings), witness.plan)
        || (witness.deviceIdBefore !== (witness.settings.deviceId ?? null))
        || (witness.deviceIdBefore === null
            ? typeof witness.deviceIdToInitialize !== 'string' || !UUID.test(witness.deviceIdToInitialize)
            : witness.deviceIdToInitialize !== null)
        || !same(witness.lists.tasks.find((task) => task.id === witness.source.id), witness.source)) return null;
    try {
        const seen = new Set<string>();
        let idIndex = 0;
        const createdActionIds = new Set(prepared.result.createdActionIds ?? []);
        const recomputed = planWrite({ request: envelope.request, witness,
            taskReminderDefault: prepared.effect.tasks.some((row) => !row.before && createdActionIds.has(row.after.id)
                && row.after.suppressMindwtrReminders === true) ? 'skip' : 'send',
            parseTitle: (title) => {
                const records = witness.parser.filter((record) => record.input === title);
                if (records.length !== 1) throw new Error('Invalid Inbox parser witness');
                seen.add(title);
                return records[0].parsed;
            },
            nextId: () => {
                const id = witness.ids[idIndex++];
                if (!id) throw new Error('Missing frozen Inbox ID');
                return id;
            } });
        if (recomputed.reason !== undefined) return null;
        const hasAdvance = (task: Task) => Object.prototype.hasOwnProperty.call(task, 'dueReminderLeadMinutes');
        const legacyReference = witness.decisionKind === 'reference' && witness.committed === 'reference'
            && witness.source.status !== 'reference' && !hasAdvance(witness.source)
            && witness.lists.tasks.every((task) => !hasAdvance(task))
            && prepared.effect.tasks.every((row) => !hasAdvance(row.after) && (!row.before || !hasAdvance(row.before)))
            && recomputed.effect.tasks.some((row) => row.after.id === witness.source.id
                && row.after.status === 'reference' && row.after.dueReminderLeadMinutes === 0);
        // Old v1 journals predate this field; compare their exact effect without the new transition-only Off value.
        const effect = legacyReference ? { ...recomputed.effect, tasks: recomputed.effect.tasks.map((row) => {
            if (row.after.id !== witness.source.id) return row;
            const { dueReminderLeadMinutes: _advance, ...after } = row.after;
            return { ...row, after };
        }) } : recomputed.effect;
        if (idIndex !== witness.ids.length
            || seen.size !== witness.parser.length || !same(effect, prepared.effect)
            || !same(recomputed.result, prepared.result) || prepared.kind !== prepared.result.kind
            || !same(recomputed.decisionRequest, witness.decisionRequest)
            || !same(recomputed.preparedDecision, witness.preparedDecision)) return null;
        if (legacyReference) logInfo('Legacy Reference decision validated', { scope: 'native-host', force: true,
            context: { releaseCheck: 'v1.3.8/native-reference-legacy-decision', outcome: 'validated' } });
        return prepared;
    } catch {
        return null;
    }
}
