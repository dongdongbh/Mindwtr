


import { serializeBackupData } from './backup-transfer';
import { applyCapturedProject, resolveCaptureAreaQuery, resolveCaptureProjectQuery, type CaptureTaskPlan } from './capture';
import { safeParseDate, type DateFormatter } from './date';
import type { TranslateFn } from './i18n';
import { NATIVE_HOST_CONTRACT_VERSION, NATIVE_HOST_MAX_WINDOW, type NativeHostResult } from './native-host-contract';
import { createNativeRequestReceipts, requestProjects, requestRowId, withRequestProject } from './native-request-receipts';
import { buildQuickAddParseOptions, type QuickAddParseOptions } from './quick-add';
import {
    applyQuickCaptureEdit,
    buildQuickCaptureAreaPicker,
    buildQuickCaptureContextPicker,
    buildQuickCapturePriorityPicker,
    buildQuickCaptureProjectPicker,
    buildQuickCaptureView,
    createQuickCaptureOptions,
    getQuickCaptureBulkConfirm,
    getQuickCaptureContextChoices,
    getQuickCaptureInvalidDateNotice,
    planQuickCaptureSave,
    planQuickCaptureTask,
    QUICK_CAPTURE_PRIORITY_OPTIONS,
    resolveQuickCaptureDefaultAreaId,
    saveQuickCapture,
    saveQuickCaptureBulk,
    type QuickCaptureContext,
    type QuickCaptureEdit,
    type QuickCaptureNotice,
    type QuickCaptureOptions,
    type QuickCaptureSaved,
    type QuickCaptureView,
} from './quick-capture-model';
import { findSelectableProjectByTitleAndArea, isSelectableProjectForTaskAssignment } from './project-utils';
import { resolveFeatureFlags } from './resolve-feature-flags';
import { isSandboxMode } from './sandbox';
import { flushPendingSave, getStorageAdapter, useTaskStore } from './store';
import type { AppSettings, Attachment, Project, Task, TaskPriority } from './types';
import { getSavedTaxonomyTokens } from './taxonomy-catalog';
import { buildNewTask } from './task-creation';
import { buildNewProject } from './store-projects/project-actions';
import { createProjectOrderReserver, ensureDeviceId, getReferenceTaskFieldClears } from './store-helpers';
import { normalizeFocusTaskLimit } from './focus-utils';
import { normalizeRecurrenceForLoad } from './recurrence';
import { normalizeTaskLifecycleFields, normalizeTaskStatus } from './task-status';
import { taskFromSqliteRow, taskToSqliteRow, TASK_SQLITE_COLUMNS, TASK_SYNC_FIELD_SCHEMA } from './task-sync-schema';
import { projectToSqliteRow, PROJECT_SYNC_FIELD_SCHEMA } from './project-sync-schema';
import { toStableSyncJson } from './sync-helpers';
import { generateUUID } from './uuid';
import { logInfo } from './logger';

type NativeHostErrorCode = Extract<NativeHostResult<never>, { ok: false }>['error']['code'];

export type QuickCaptureDeps = {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;

    revision: (now: Date) => string;
    t: () => TranslateFn;

    formatDate: () => DateFormatter;
    requestIdPattern: RegExp;
};

export type NativeQuickCapturePickerKind = 'project' | 'area' | 'context' | 'priority';
type Windowed<T extends { items: unknown[] }> = Omit<T, 'items'> & { items: T['items']; total: number };
type ProjectPicker = ReturnType<typeof buildQuickCaptureProjectPicker>;
type AreaPicker = ReturnType<typeof buildQuickCaptureAreaPicker>;
type ContextPicker = ReturnType<typeof buildQuickCaptureContextPicker>;
type PriorityPicker = ReturnType<typeof buildQuickCapturePriorityPicker>;


export type NativeQuickCapturePicker =
    | ({ kind: 'project'; query: string } & Windowed<ProjectPicker>)
    | ({ kind: 'area'; query: string } & Windowed<AreaPicker>)
    | ({ kind: 'context'; query: string } & Windowed<ContextPicker>)
    | ({ kind: 'priority' } & PriorityPicker);

export type NativeQuickCaptureView = QuickCaptureView & {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;

    revision: string;
    picker: NativeQuickCapturePicker | null;
};


export type NativeQuickCapturePickerInput = { kind: NativeQuickCapturePickerKind; query?: string };

export type NativeQuickCaptureSubmitResult =
    | (Omit<QuickCaptureSaved, 'highlightTaskId'> & {

        reset: { text: string; options: QuickCaptureOptions } | null;
    })

    | { kind: 'refused'; notice: QuickCaptureNotice }

    | { kind: 'confirmLines'; confirm: ReturnType<typeof getQuickCaptureBulkConfirm>; lineCount: number };

export type NativeQuickCaptureLinesResult = { kind: 'saved'; taskIds: string[] } | { kind: 'refused'; notice: QuickCaptureNotice };

export type NativeQuickCaptureInput = {
    text: string;
    options: QuickCaptureOptions;
    captureId: string;
    openAfterSave?: boolean;
};


export type NativePreparedQuickCapture = {
    version: 1;
    request: NativeQuickCaptureInput;
    task: Task;
    project: Project | null;
    result: Extract<NativeQuickCaptureSubmitResult, { kind: 'saved' }>;
    deviceIdToInitialize: string | null;
};

export type NativeQuickCapturePrepareResult =
    | { kind: 'prepared'; prepared: NativePreparedQuickCapture }
    | Extract<NativeQuickCaptureSubmitResult, { kind: 'refused' | 'confirmLines' }>;

export type NativeQuickCaptureLinesInput = {
    text: string;
    options: QuickCaptureOptions;
    captureIds: string[];
};
export type NativePreparedQuickCaptureLines = {
    version: 1;
    request: NativeQuickCaptureLinesInput;
    tasks: Task[];
    projects: Project[];
    deviceIdToInitialize: string | null;
    result: Extract<NativeQuickCaptureLinesResult, { kind: 'saved' }>;
};
export const NATIVE_PREPARED_CAPTURE_LINES_MAX_BYTES = 8 * 1024 * 1024;
export const NATIVE_PREPARED_CAPTURE_LINES_MAX_COUNT = 1000;


const fail = (code: NativeHostErrorCode, message: string): NativeHostResult<never> => ({ ok: false, error: { code, message } });
const isObjectRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);
const isText = (value: unknown, max = 500): value is string => typeof value === 'string' && value.length <= max;
const TEXT_LIMIT = 100_000;
const NOTE_LIMIT = 500_000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;


const readOptionDate = (value: unknown): string | null | undefined => {
    if (value === null) return null;
    if (!isText(value, 64)) return undefined;
    if (DAY_PATTERN.test(value)) return safeParseDate(value)?.toISOString();
    return INSTANT_PATTERN.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value ? value : undefined;
};
const isId = (value: unknown) => value === null || (isText(value) && value.length > 0);

const OPTION_CHECKS: Record<keyof QuickCaptureOptions, (value: unknown) => boolean> = {
    note: (value) => isText(value, NOTE_LIMIT),
    dueDate: (value) => readOptionDate(value) !== undefined,
    dueDateHasTime: (value) => typeof value === 'boolean',
    startTime: (value) => readOptionDate(value) !== undefined,
    contexts: (value) => Array.isArray(value) && value.length <= 1000 && value.every((entry) => isText(entry) && entry.trim().length > 0),
    projectId: isId,
    areaId: isId,
    priority: (value) => value === null || QUICK_CAPTURE_PRIORITY_OPTIONS.includes(value as TaskPriority),
    focus: (value) => typeof value === 'boolean',
    addAnother: (value) => typeof value === 'boolean',
};


const readOptions = (value: unknown): QuickCaptureOptions | null => {
    if (!isObjectRecord(value)) return null;
    const keys = Object.keys(OPTION_CHECKS) as (keyof QuickCaptureOptions)[];
    if (Object.keys(value).length !== keys.length || !keys.every((key) => key in value && OPTION_CHECKS[key](value[key]))) return null;
    if (value.dueDateHasTime === true && typeof value.dueDate === 'string' && DAY_PATTERN.test(value.dueDate)) return null;
    const options = {
        ...value,
        dueDate: readOptionDate(value.dueDate),
        startTime: readOptionDate(value.startTime),
        contexts: [...(value.contexts as string[])],
    } as QuickCaptureOptions;
    return resolveFeatureFlags(useTaskStore.getState().settings).priorities ? options : { ...options, priority: null };
};

const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const hasKeys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) => (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
);
const isInstant = (value: unknown): value is string => isText(value, 64) && INSTANT_PATTERN.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const isCaptureDate = (value: unknown): value is string => isInstant(value) || (
    isText(value, 10) && DAY_PATTERN.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
    && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value
);
const isNonemptyText = (value: unknown): value is string => isText(value, TEXT_LIMIT) && value.trim().length > 0;


const readOriginalOptions = (value: unknown): QuickCaptureOptions | null => {
    if (!isObjectRecord(value)) return null;
    const keys = Object.keys(OPTION_CHECKS) as (keyof QuickCaptureOptions)[];
    if (!hasKeys(value, keys) || !keys.every((key) => key === 'dueDate' || key === 'startTime'
        ? value[key] === null || isCaptureDate(value[key]) : OPTION_CHECKS[key](value[key]))) return null;
    if (value.dueDateHasTime === true && typeof value.dueDate === 'string' && DAY_PATTERN.test(value.dueDate)) return null;
    return Object.fromEntries(keys.map((key) => [key, key === 'contexts' ? [...value.contexts as string[]] : value[key]])) as QuickCaptureOptions;
};

const readCaptureRequest = (value: unknown): NativeQuickCaptureInput | null => {
    if (!isObjectRecord(value) || !hasKeys(value, ['text', 'options', 'captureId'], ['openAfterSave'])
        || !isText(value.text, TEXT_LIMIT) || !isText(value.captureId, 36) || !UUID_PATTERN.test(value.captureId)
        || (value.openAfterSave !== undefined && typeof value.openAfterSave !== 'boolean')) return null;
    const options = readOriginalOptions(value.options);
    return options ? { text: value.text, options, captureId: value.captureId.toLowerCase(), openAfterSave: value.openAfterSave === true } : null;
};

const sameJson = (left: unknown, right: unknown) => toStableSyncJson(left) === toStableSyncJson(right);
const canonicalMetadata = (row: Record<string, unknown>) => isText(row.id, 36) && UUID_PATTERN.test(row.id)
    && row.id === row.id.toLowerCase() && row.rev === 1 && isNonemptyText(row.revBy)
    && isInstant(row.createdAt) && row.updatedAt === row.createdAt
    && row.deletedAt === undefined && row.purgedAt === undefined;
const isStrings = (value: unknown) => Array.isArray(value) && value.length <= 1000 && value.every(isNonemptyText);
const isLinkAttachment = (value: unknown) => isObjectRecord(value)
    && hasKeys(value, ['id', 'kind', 'title', 'uri', 'createdAt', 'updatedAt'])
    && isText(value.id, 36) && UUID_PATTERN.test(value.id) && value.kind === 'link'
    && isNonemptyText(value.title) && isNonemptyText(value.uri)
    && isInstant(value.createdAt) && value.updatedAt === value.createdAt;


const CAPTURE_TASK_CHECKS: Partial<Record<keyof Task, (value: unknown) => boolean>> = {
    id: isNonemptyText, title: (v) => isNonemptyText(v) && v.trim() === v,
    status: (v) => typeof v === 'string' && normalizeTaskStatus(v) === v,
    taskMode: (v) => v === 'task', tags: isStrings, contexts: isStrings,
    pushCount: (v) => v === 0, rev: (v) => v === 1, revBy: isNonemptyText,
    createdAt: isInstant, updatedAt: isInstant, completedAt: isInstant,
    isFocusedToday: (v) => typeof v === 'boolean', suppressMindwtrReminders: (v) => typeof v === 'boolean',
    reminderPolicy: (v) => v === 'inherit',
    priority: (v) => QUICK_CAPTURE_PRIORITY_OPTIONS.includes(v as TaskPriority),
    energyLevel: (v) => ['low', 'medium', 'high'].includes(v as string),
    assignedTo: isNonemptyText, description: (v) => isText(v, NOTE_LIMIT + TEXT_LIMIT),
    startTime: isCaptureDate, dueDate: isCaptureDate, reviewAt: isCaptureDate,
    projectId: isNonemptyText, sectionId: isNonemptyText, areaId: isNonemptyText,
    order: (v) => typeof v === 'number' && Number.isFinite(v),
    orderNum: (v) => typeof v === 'number' && Number.isFinite(v),
    recurrence: (v) => isObjectRecord(v) && sameJson(v, normalizeRecurrenceForLoad(v))
        && (v.until === undefined || isCaptureDate(v.until)),
    attachments: (v) => Array.isArray(v) && v.length <= 1000 && v.every(isLinkAttachment),
};
const readPreparedTask = (value: unknown): Task | null => {
    if (!isObjectRecord(value) || !canonicalMetadata(value)
        || !['id', 'title', 'status', 'taskMode', 'tags', 'contexts', 'pushCount', 'isFocusedToday'].every((key) => key in value)
        || !Object.keys(value).every((key) => TASK_SYNC_FIELD_SCHEMA.some((field) => field.name === key)
            && (value[key] === undefined || CAPTURE_TASK_CHECKS[key as keyof Task]?.(value[key]) === true))) return null;
    const task = value as unknown as Task;
    if (task.order !== task.orderNum || (task.projectId && task.areaId) || (task.sectionId && !task.projectId)) return null;
    if (task.projectId ? !Number.isFinite(task.order) : task.order !== undefined) return null;
    if (!sameJson(taskToSqliteRow(task), taskToSqliteRow(normalizeTaskLifecycleFields(task)))) return null;
    if (task.status === 'reference' && !sameJson(taskToSqliteRow(task), taskToSqliteRow({ ...task, ...getReferenceTaskFieldClears(task.dueReminderLeadMinutes, task.startReminderLeadMinutes) }))) return null;


    if (task.isFocusedToday && task.status === 'inbox') return null;


    const row = taskToSqliteRow(task);
    const decoded = taskFromSqliteRow(Object.fromEntries(TASK_SQLITE_COLUMNS.map((column, index) => [column, row[index]])));
    return { ...decoded, recurrence: normalizeRecurrenceForLoad(decoded.recurrence) };
};

const readPreparedProject = (value: unknown): Project | null => {
    if (!isObjectRecord(value) || !canonicalMetadata(value) || !isNonemptyText(value.title)
        || !isText(value.color) || typeof value.order !== 'number' || !Number.isFinite(value.order)
        || typeof value.isSequential !== 'boolean' || !Array.isArray(value.tagIds) || value.tagIds.length !== 0
        || (value.areaId !== undefined && !isNonemptyText(value.areaId))
        || (value.areaTitle !== undefined && !isNonemptyText(value.areaTitle))
        || !Object.keys(value).every((key) => PROJECT_SYNC_FIELD_SCHEMA.some((field) => field.name === key))) return null;
    const project = value as unknown as Project;
    const canonical = buildNewProject({
        id: project.id, title: project.title, color: project.color,
        initialProps: { order: project.order, isSequential: project.isSequential, areaId: project.areaId },
        existingProjects: [],
        existingAreas: project.areaId && project.areaTitle ? [{ id: project.areaId, name: project.areaTitle, order: 0, createdAt: project.createdAt, updatedAt: project.createdAt }] : [],
        settings: {}, deviceId: project.revBy!, now: project.createdAt,
    });
    return sameJson(project, canonical) && sameJson(projectToSqliteRow(project), projectToSqliteRow(canonical)) ? project : null;
};

const readPreparedCapture = (value: unknown): NativePreparedQuickCapture | null => {
    if (!isObjectRecord(value) || !hasKeys(value, ['version', 'request', 'task', 'project', 'result', 'deviceIdToInitialize']) || value.version !== 1) return null;
    const request = readCaptureRequest(value.request);
    const task = readPreparedTask(value.task);
    const project = value.project === null ? null : readPreparedProject(value.project);
    if (!request || !task || (value.project !== null && !project) || request.captureId !== task.id
        || (project && (task.projectId !== project.id || project.createdAt !== task.createdAt || project.revBy !== task.revBy))
        || (value.deviceIdToInitialize !== null && (value.deviceIdToInitialize !== task.revBy || !isText(value.deviceIdToInitialize, 36) || !UUID_PATTERN.test(value.deviceIdToInitialize)))) return null;
    const next = request.openAfterSave ? 'open' : request.options.addAnother ? 'addAnother' : 'close';
    const result = value.result;
    if (!isObjectRecord(result) || !hasKeys(result, ['kind', 'taskId', 'next', 'reset'], ['projectId'])
        || result.kind !== 'saved' || result.taskId !== task.id || result.projectId !== task.projectId || result.next !== next) return null;
    let reset: NativePreparedQuickCapture['result']['reset'] = null;
    if (next === 'addAnother') {
        if (!isObjectRecord(result.reset) || !hasKeys(result.reset, ['text', 'options']) || result.reset.text !== '') return null;
        const options = readOriginalOptions(result.reset.options);
        if (!options || !sameJson(options, createQuickCaptureOptions({ projects: [], defaultAreaId: options.areaId, addAnother: true }))) return null;
        reset = { text: '', options };
    } else if (result.reset !== null) return null;
    return { version: 1, request, task, project, deviceIdToInitialize: value.deviceIdToInitialize as string | null,
        result: { kind: 'saved', taskId: task.id, ...(task.projectId ? { projectId: task.projectId } : { projectId: undefined }), next, reset } };
};


const jsonBytes = (value: unknown): number => {
    let bytes = 0;
    const ancestors = new Set<object>();
    const string = (text: string) => {
        if (text.length > NATIVE_PREPARED_CAPTURE_LINES_MAX_BYTES) { bytes = NATIVE_PREPARED_CAPTURE_LINES_MAX_BYTES + 1; return; }
        for (const character of JSON.stringify(text)) {
            const point = character.codePointAt(0)!;
            bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
            if (bytes > NATIVE_PREPARED_CAPTURE_LINES_MAX_BYTES) return;
        }
    };
    const omitted = (entry: unknown) => entry === undefined || typeof entry === 'function' || typeof entry === 'symbol';
    const visit = (entry: unknown) => {
        if (bytes > NATIVE_PREPARED_CAPTURE_LINES_MAX_BYTES) return;
        if (typeof entry === 'string') { string(entry); return; }
        if (entry === null || typeof entry === 'number' || typeof entry === 'boolean') { bytes += JSON.stringify(entry).length; return; }
        if (typeof entry !== 'object' || ancestors.has(entry)) throw new TypeError('Malformed JSON');
        ancestors.add(entry); bytes += 2;
        let count = 0;
        if (Array.isArray(entry)) {
            for (const item of entry) {
                if (count++) bytes += 1;
                if (omitted(item)) bytes += 4; else visit(item);
                if (bytes > NATIVE_PREPARED_CAPTURE_LINES_MAX_BYTES) break;
            }
        } else {
            for (const name of Object.keys(entry)) {
                const item = (entry as Record<string, unknown>)[name];
                if (omitted(item)) continue;
                if (count++) bytes += 1;
                string(name); bytes += 1; visit(item);
                if (bytes > NATIVE_PREPARED_CAPTURE_LINES_MAX_BYTES) break;
            }
        }
        ancestors.delete(entry);
    };
    visit(value);
    return bytes;
};
const readLinesRequest = (value: unknown): NativeQuickCaptureLinesInput | null => {
    if (!isObjectRecord(value) || !hasKeys(value, ['text', 'options', 'captureIds'])
        || !isText(value.text, TEXT_LIMIT) || !Array.isArray(value.captureIds)
        || value.captureIds.length < 2 || value.captureIds.length > NATIVE_PREPARED_CAPTURE_LINES_MAX_COUNT
        || !value.captureIds.every((id) => isText(id, 36) && UUID_PATTERN.test(id) && id === id.toLowerCase())
        || new Set(value.captureIds).size !== value.captureIds.length) return null;
    const options = readOriginalOptions(value.options);
    const plan = planQuickCaptureSave(value.text);
    if (!options || plan.kind !== 'bulk' || plan.lines.length !== value.captureIds.length) return null;
    const request = { text: value.text, options, captureIds: [...value.captureIds] as string[] };
    return jsonBytes(request) <= NATIVE_PREPARED_CAPTURE_LINES_MAX_BYTES ? request : null;
};
const readPreparedLines = (value: unknown): NativePreparedQuickCaptureLines | null => {
    if (!isObjectRecord(value) || !hasKeys(value, ['version', 'request', 'tasks', 'projects', 'deviceIdToInitialize', 'result'])
        || value.version !== 1 || !Array.isArray(value.tasks) || !Array.isArray(value.projects)
        || value.tasks.length > NATIVE_PREPARED_CAPTURE_LINES_MAX_COUNT
        || value.projects.length > NATIVE_PREPARED_CAPTURE_LINES_MAX_COUNT) return null;
    const request = readLinesRequest(value.request);
    if (!request || value.tasks.length !== request.captureIds.length
        || !(value.deviceIdToInitialize === null || isText(value.deviceIdToInitialize, 36) && UUID_PATTERN.test(value.deviceIdToInitialize))
        || !isObjectRecord(value.result) || !hasKeys(value.result, ['kind', 'taskIds'])
        || value.result.kind !== 'saved' || !Array.isArray(value.result.taskIds)
        || value.result.taskIds.length !== request.captureIds.length
        || !value.result.taskIds.every((id, index) => id === request.captureIds[index])) return null;
    let bytes = jsonBytes(request);
    const tasks: Task[] = [], projects: Project[] = [];
    for (const [index, row] of value.tasks.entries()) {
        bytes += jsonBytes(row);
        if (bytes > NATIVE_PREPARED_CAPTURE_LINES_MAX_BYTES) return null;
        const task = readPreparedTask(row);
        if (!task || task.id !== request.captureIds[index]
            || index > 0 && (task.createdAt !== tasks[0].createdAt || task.revBy !== tasks[0].revBy)) return null;
        tasks.push(task);
    }
    if (value.deviceIdToInitialize !== null && value.deviceIdToInitialize !== tasks[0].revBy) return null;
    const projectIDs = new Set<string>();
    for (const row of value.projects) {
        bytes += jsonBytes(row);
        if (bytes > NATIVE_PREPARED_CAPTURE_LINES_MAX_BYTES) return null;
        const project = readPreparedProject(row);
        if (!project || projectIDs.has(project.id) || project.createdAt !== tasks[0].createdAt
            || project.revBy !== tasks[0].revBy || !tasks.some((task) => task.projectId === project.id)) return null;
        projectIDs.add(project.id);
        projects.push(JSON.parse(JSON.stringify(project)) as Project);
    }
    const prepared: NativePreparedQuickCaptureLines = {
        version: 1, request, tasks, projects, deviceIdToInitialize: value.deviceIdToInitialize as string | null,
        result: { kind: 'saved', taskIds: [...request.captureIds] },
    };
    return jsonBytes(prepared) <= NATIVE_PREPARED_CAPTURE_LINES_MAX_BYTES ? prepared : null;
};


export const validatePreparedQuickCaptureLines = (input: unknown): NativeHostResult<NativePreparedQuickCaptureLines['result']> => {
    try {
        if (!isObjectRecord(input) || !hasKeys(input, ['request', 'prepared'])
            || jsonBytes(input) > NATIVE_PREPARED_CAPTURE_LINES_MAX_BYTES) return fail('INVALID_INPUT', 'A bounded prepared lines command is required');
        const request = readLinesRequest(input.request), prepared = readPreparedLines(input.prepared);
        if (!request || !prepared || !sameJson(request, prepared.request)
            || jsonBytes({ request, prepared }) > NATIVE_PREPARED_CAPTURE_LINES_MAX_BYTES) return fail('INVALID_INPUT', 'Prepared lines request or journal does not match');
        return { ok: true, value: prepared.result };
    } catch { return fail('INVALID_INPUT', 'Prepared lines journal is malformed'); }
};

const sameTokens = (left: readonly string[] | undefined, right: readonly string[] | undefined) => (
    JSON.stringify([...(left ?? [])].sort()) === JSON.stringify([...(right ?? [])].sort())
);


export const captureProjectId = (requestId: string, title: string) => requestRowId(requestId, `project:${title.trim().toLowerCase()}`);


export const captureProjects = (requestId: string) => requestProjects((title) => captureProjectId(requestId, title));
const projectGone = () => fail('STALE_REVISION', 'The project this capture created is gone');


export const isTaskOfPlan = (task: Task, plan: CaptureTaskPlan, requestId: string): boolean => {
    const { props } = plan;
    const project = task.projectId ? useTaskStore.getState()._allProjects.find((entry) => entry.id === task.projectId) : undefined;
    const projectMatches = props.projectId
        ? task.projectId === props.projectId
        : plan.projectToCreate
            ? task.projectId === captureProjectId(requestId, plan.projectToCreate.title)
                || project?.title.trim().toLowerCase() === plan.projectToCreate.title.trim().toLowerCase()
            : !task.projectId;
    const statusMatches = task.status === props.status
        || (props.isFocusedToday === true && props.status === 'inbox' && task.status === 'next');
    return !task.deletedAt && task.title === plan.title.trim() && projectMatches
        && (task.areaId ?? null) === (props.areaId ?? null)
        && sameTokens(task.contexts, props.contexts) && sameTokens(task.tags, props.tags)
        && statusMatches
        && (task.priority ?? null) === (props.priority ?? null)
        && (task.dueDate ?? null) === (props.dueDate ?? null)
        && Boolean(task.isFocusedToday) === Boolean(props.isFocusedToday);
};


const snapshotFileNameAt = (date: Date) => {
    const [day, time] = date.toISOString().split('T');
    return `data.${day}T${time.replace(/Z$/u, '').replace(/:/gu, '-')}.snapshot.json`;
};

const SNAPSHOT_SUFFIX = '.snapshot.json';

const isWrittenSnapshotName = (sent: string, taken: string): boolean => {
    if (sent === taken) return true;
    const base = taken.slice(0, -SNAPSHOT_SUFFIX.length);
    return sent.startsWith(`${base}.`) && /^[1-9][0-9]{0,2}\.snapshot\.json$/u.test(sent.slice(base.length + 1));
};

const isEdit = (edit: unknown): edit is QuickCaptureEdit => {
    if (!isObjectRecord(edit)) return false;
    const state = useTaskStore.getState();
    switch (edit.type) {
        case 'setNote':
            return isText(edit.value, NOTE_LIMIT);
        case 'selectProject': {
            if (edit.projectId === null) return true;
            const project = typeof edit.projectId === 'string' ? state._projectsById.get(edit.projectId) : undefined;
            return Boolean(project && isSelectableProjectForTaskAssignment(project));
        }
        case 'selectArea':
            return edit.areaId === null || state.areas.some((area) => area.id === edit.areaId && !area.deletedAt);
        case 'toggleContext':
        case 'removeContext':
            return isText(edit.value) && edit.value.trim().length > 0;
        case 'addContexts':
            return isText(edit.query, 10_000);
        case 'setPriority':
            return resolveFeatureFlags(state.settings).priorities
                && (edit.priority === null || QUICK_CAPTURE_PRIORITY_OPTIONS.includes(edit.priority as TaskPriority));
        case 'setAddAnother':
            return typeof edit.value === 'boolean';
        case 'setDueDay':
            return isText(edit.day, 10);
        case 'setDueTime':
            return isText(edit.time, 5);
        case 'resetProject':
        case 'clearContexts':
        case 'toggleFocus':
        case 'clearDueDate':
        case 'clearDueTime':
            return true;
        default:
            return false;
    }
};

const PICKERS = new Set<string>(['project', 'area', 'context', 'priority']);
const readPicker = (value: unknown): NativeQuickCapturePickerInput | null | false => {
    if (value === undefined || value === null) return null;
    if (!isObjectRecord(value) || !PICKERS.has(value.kind as string) || (value.query !== undefined && !isText(value.query, 10_000))) return false;
    if (value.kind === 'priority' && value.query !== undefined) return false;
    return { kind: value.kind as NativeQuickCapturePickerKind, query: value.query as string | undefined };
};

const windowed = <T extends { items: unknown[] }>(picker: T): Windowed<T> => ({
    ...picker,
    items: picker.items.slice(0, NATIVE_HOST_MAX_WINDOW) as T['items'],
    total: picker.items.length,
});

export function createQuickCaptureMethods(deps: QuickCaptureDeps) {

    let parseOptions: QuickAddParseOptions | null = null;
    const rebuildParseOptions = () => {
        const state = useTaskStore.getState();
        parseOptions = buildQuickAddParseOptions(state.settings, state);
        return parseOptions;
    };


    const notApplied = (message: string | undefined): NativeHostResult<never> => fail('ACTION_FAILED', message ?? 'Write failed');
    const caught = (error: unknown) => notApplied(error instanceof Error ? error.message : String(error));

    const durableSave = async (): Promise<NativeHostResult<null>> => {
        try {
            if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
        } catch (error) {
            return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error));
        }
        return deps.save();
    };

    let lastSnapshot: { fileName: string; changeAt: number } | null = null;


    const pickerCreates = new Set<string>();


    const receipts = createNativeRequestReceipts({ save: durableSave });

    const context = (now = new Date()): QuickCaptureContext => {
        const state = useTaskStore.getState();
        return {
            settings: state.settings,
            projects: state.projects,
            areas: state.areas,
            parseOptions: parseOptions ?? rebuildParseOptions(),
            focusedCount: state.getFocusedCount(),
            defaultAreaId: resolveQuickCaptureDefaultAreaId(state.settings, state.areas),
            t: deps.t(),
            formatDate: deps.formatDate(),
            now,
        };
    };


    const ownedContext = (requestId: string, texts: readonly string[], options: QuickCaptureOptions): QuickCaptureContext | null => {
        const ctx = context();
        let projects = ctx.projects;
        for (const text of texts) {

            const bare = planQuickCaptureTask({ text, options, projects: [] }, ctx);
            const title = bare.success ? bare.projectToCreate?.title : undefined;
            if (!title) continue;
            const matched = withRequestProject(projects, captureProjectId(requestId, title), title);
            if (!matched) return null;
            projects = matched;
        }
        return { ...ctx, projects };
    };
    const contextChoices = () => {
        const state = useTaskStore.getState();
        return getQuickCaptureContextChoices(state.tasks, getSavedTaxonomyTokens(state.settings, 'context'));
    };
    let cachedContextHistory: { tasks: Task[]; taxonomy: AppSettings['taxonomy']; choices: string[] } | null = null;
    const contextHistory = () => {
        const { _allTasks: tasks, settings } = useTaskStore.getState();
        const { taxonomy } = settings;
        if (cachedContextHistory?.tasks === tasks && cachedContextHistory.taxonomy === taxonomy) return cachedContextHistory.choices;
        const choices = getQuickCaptureContextChoices(tasks, getSavedTaxonomyTokens(settings, 'context'));
        cachedContextHistory = { tasks, taxonomy, choices };
        return choices;
    };
    const freshOptions = (addAnother: boolean) => {
        const state = useTaskStore.getState();
        return createQuickCaptureOptions({
            projects: state.projects,
            defaultAreaId: resolveQuickCaptureDefaultAreaId(state.settings, state.areas),
            addAnother,
        });
    };

    const view = (text: string, options: QuickCaptureOptions, picker: NativeQuickCapturePickerInput | null): NativeHostResult<NativeQuickCaptureView> => {
        const ctx = context();
        const built = buildQuickCaptureView(text, options, ctx);
        let shown: NativeQuickCapturePicker | null = null;
        if (picker?.kind === 'project') shown = { kind: 'project', query: picker.query ?? '', ...windowed(buildQuickCaptureProjectPicker(options, ctx, picker.query ?? '')) };
        if (picker?.kind === 'area') shown = { kind: 'area', query: picker.query ?? '', ...windowed(buildQuickCaptureAreaPicker(options, ctx, picker.query ?? '')) };
        if (picker?.kind === 'context') {
            shown = { kind: 'context', query: picker.query ?? '', ...windowed(buildQuickCaptureContextPicker(options, ctx, picker.query ?? '', contextChoices(), (picker.query ?? '').trim() ? contextHistory() : [])) };
        }
        if (picker?.kind === 'priority') {
            if (!built.priority) return fail('INVALID_INPUT', 'The priority picker is off while Priorities are off');
            shown = { kind: 'priority', ...buildQuickCapturePriorityPicker(options, ctx) };
        }
        return {
            ok: true,
            value: { ...built, version: NATIVE_HOST_CONTRACT_VERSION, revision: deps.revision(ctx.now), picker: shown },
        };
    };


    const readDraft = (input: unknown): NativeHostResult<{ text: string; options: QuickCaptureOptions }> => {
        const ready = deps.readiness();
        if (!ready.ok) return ready;
        if (!isObjectRecord(input) || !isText(input.text, TEXT_LIMIT)) return fail('INVALID_INPUT', 'text is required');
        const options = readOptions(input.options);
        if (!options) return fail('INVALID_INPUT', 'options must hold every capture option with a valid value');
        return { ok: true, value: { text: input.text, options } };
    };

    return {

        prepareQuickCaptureLines(input: NativeQuickCaptureLinesInput): NativeHostResult<
            { kind: 'prepared'; prepared: NativePreparedQuickCaptureLines } | Extract<NativeQuickCaptureLinesResult, { kind: 'refused' }>
        > {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readLinesRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded multiline request and ordered lowercase UUIDs are required');
            const options = readOptions(request.options)!;
            const plan = planQuickCaptureSave(request.text);
            if (plan.kind !== 'bulk') return fail('INVALID_INPUT', 'Several lines are required');

            const repeatedBytes = Math.max(0, jsonBytes(options.note.trim()) - 2) + jsonBytes([...new Set(options.contexts)]);
            let bytes = 2 * jsonBytes(request);
            if (bytes + repeatedBytes * plan.lines.length > NATIVE_PREPARED_CAPTURE_LINES_MAX_BYTES) return fail('INVALID_INPUT', 'Prepared lines exceed the supported byte limit');
            const ctx = context(), state = useTaskStore.getState();
            for (const line of plan.lines) {
                const checked = planQuickCaptureTask({ text: line, options }, ctx);
                if (!checked.success) return checked.reason === 'invalid-date-command'
                    ? { ok: true, value: { kind: 'refused', notice: getQuickCaptureInvalidDateNotice(deps.t(), checked.invalidDateCommands) } }
                    : fail('INVALID_INPUT', 'A line cannot be captured');
            }
            if (request.captureIds.some((id) => state._allTasks.some((task) => task.id === id))) return fail('INVALID_INPUT', 'Capture ID already exists; replay its prepared journal');
            const device = ensureDeviceId(state.settings), now = ctx.now.toISOString();
            const projects: Project[] = [], plans: { title: string; props: Partial<Task> }[] = [];
            let visibleProjects = ctx.projects, allProjects = state._allProjects;
            for (const line of plan.lines) {
                const planned = planQuickCaptureTask({ text: line, options, projects: visibleProjects }, ctx);
                if (!planned.success) return fail('INVALID_INPUT', 'A line cannot be captured');
                let props = planned.props;
                if (planned.projectToCreate) {
                    const create = planned.projectToCreate;
                    const duplicate = findSelectableProjectByTitleAndArea(allProjects, create.title, create.initialProps?.areaId);
                    const project = duplicate ?? buildNewProject({ ...create, id: generateUUID(), existingProjects: allProjects,
                        existingAreas: state._allAreas, settings: state.settings, deviceId: device.deviceId, now });
                    if (!duplicate) {
                        bytes += jsonBytes(project);
                        if (bytes > NATIVE_PREPARED_CAPTURE_LINES_MAX_BYTES) return fail('INVALID_INPUT', 'Prepared lines exceed the supported byte limit');
                        projects.push(project); allProjects = [...allProjects, project];
                    }
                    visibleProjects = [...visibleProjects, project];
                    props = applyCapturedProject(props, project.id);
                }
                plans.push({ title: planned.title.trim(), props });
            }
            const tasks: Task[] = [], precedingTasks = [...state._allTasks];
            const projectOrderReserver = createProjectOrderReserver(state._allTasks);
            let focusedCount = state.getFocusedCount();
            for (const [index, planned] of plans.entries()) {
                const built = buildNewTask({ title: planned.title, initialTaskProps: planned.props,
                    id: request.captureIds[index], now, deviceId: device.deviceId, state: { ...state, _allProjects: allProjects },
                    tasks: precedingTasks, focusedCount, focusTaskLimit: normalizeFocusTaskLimit(state.settings.gtd?.focusTaskLimit), projectOrderReserver });
                if (!built.ok) return fail('INVALID_INPUT', built.error);
                bytes += jsonBytes(built.task);
                if (bytes > NATIVE_PREPARED_CAPTURE_LINES_MAX_BYTES) return fail('INVALID_INPUT', 'Prepared lines exceed the supported byte limit');
                focusedCount = built.focusedCount; tasks.push(built.task); precedingTasks.push(built.task);
            }
            const payload: NativePreparedQuickCaptureLines = { version: 1, request, tasks, projects,
                deviceIdToInitialize: device.updated ? device.deviceId : null, result: { kind: 'saved', taskIds: request.captureIds } };
            if (jsonBytes(payload) > NATIVE_PREPARED_CAPTURE_LINES_MAX_BYTES) return fail('INVALID_INPUT', 'Prepared lines exceed the supported byte limit');
            const prepared = readPreparedLines(JSON.parse(JSON.stringify(payload)));
            if (!prepared || !validatePreparedQuickCaptureLines({ request, prepared }).ok) return fail('INVALID_INPUT', 'Lines could not produce a valid prepared journal');
            return { ok: true, value: { kind: 'prepared', prepared } };
        },

        validatePreparedQuickCaptureLines,

        async commitPreparedQuickCaptureLines(input: { request: NativeQuickCaptureLinesInput; prepared: NativePreparedQuickCaptureLines }): Promise<NativeHostResult<NativePreparedQuickCaptureLines['result']>> {
            const authority = validatePreparedQuickCaptureLines(input);
            if (!authority.ok) return authority;
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const prepared = readPreparedLines(input.prepared)!;
            const applied = await useTaskStore.getState().commitPreparedCaptureLines(prepared);
            if (!applied.success) return fail('INVALID_INPUT', applied.error ?? 'Prepared lines conflict with current data');
            const saved = await durableSave();
            if (!saved.ok) return saved;
            rebuildParseOptions();
            try {
                logInfo('Prepared native capture lines saved', {
                    scope: 'native-host', category: 'storage',
                    context: { releaseCheck: 'v1.3.5/native-capture-lines', operation: 'captureLinesCommit', count: prepared.tasks.length },
                });
            } catch {                                                               }
            return { ok: true, value: prepared.result };
        },


        prepareQuickCapture(input: NativeQuickCaptureInput): NativeHostResult<NativeQuickCapturePrepareResult> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readCaptureRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A complete capture request and UUID are required');
            const options = readOptions(request.options)!;
            const plan = planQuickCaptureSave(request.text);
            if (plan.kind === 'empty') return fail('INVALID_INPUT', 'Type something to capture');
            if (plan.kind === 'bulk') return { ok: true, value: { kind: 'confirmLines', confirm: getQuickCaptureBulkConfirm(plan.lines, deps.t()), lineCount: plan.lines.length } };
            const ctx = context();
            const planned = planQuickCaptureTask({ text: plan.text, options }, ctx);
            if (!planned.success) return planned.reason === 'invalid-date-command'
                ? { ok: true, value: { kind: 'refused', notice: getQuickCaptureInvalidDateNotice(deps.t(), planned.invalidDateCommands) } }
                : fail('INVALID_INPUT', 'Type something to capture');
            const state = useTaskStore.getState();
            if (state._allTasks.some((task) => task.id === request.captureId)) return fail('INVALID_INPUT', 'Capture ID already exists; replay its prepared journal');
            const device = ensureDeviceId(state.settings);
            const now = ctx.now.toISOString();
            let project: Project | null = null;
            let props = planned.props;
            if (planned.projectToCreate) {
                const create = planned.projectToCreate;
                const duplicate = findSelectableProjectByTitleAndArea(state._allProjects, create.title, create.initialProps?.areaId);
                project = duplicate ? null : buildNewProject({
                    ...create, id: generateUUID(), existingProjects: state._allProjects, existingAreas: state._allAreas,
                    settings: state.settings, deviceId: device.deviceId, now,
                });
                props = applyCapturedProject(props, duplicate?.id ?? project!.id);
            }
            const projects = project ? [...state._allProjects, project] : state._allProjects;
            if (props.projectId && !projects.some((entry) => entry.id === props.projectId && isSelectableProjectForTaskAssignment(entry))) return fail('INVALID_INPUT', 'Project is not available for capture');
            if (project?.areaId && !state._allAreas.some((entry) => entry.id === project.areaId && !entry.deletedAt)) return fail('INVALID_INPUT', 'Area is not available for capture');
            const built = buildNewTask({
                title: planned.title.trim(), initialTaskProps: props, id: request.captureId, now, deviceId: device.deviceId,
                state: { ...state, _allProjects: projects }, tasks: state._allTasks,
                focusedCount: state.getFocusedCount(), focusTaskLimit: normalizeFocusTaskLimit(state.settings.gtd?.focusTaskLimit),
                projectOrderReserver: createProjectOrderReserver(state._allTasks),
            });
            if (!built.ok) return fail('INVALID_INPUT', built.error);
            const next = request.openAfterSave ? 'open' : request.options.addAnother ? 'addAnother' : 'close';
            const prepared: NativePreparedQuickCapture = {
                version: 1, request, task: built.task, project, deviceIdToInitialize: device.updated ? device.deviceId : null,
                result: { kind: 'saved', taskId: built.task.id, projectId: built.task.projectId, next,
                    reset: next === 'addAnother' ? { text: '', options: freshOptions(true) } : null },
            };


            const decoded = readPreparedCapture(JSON.parse(JSON.stringify(prepared)));
            return decoded ? { ok: true, value: { kind: 'prepared', prepared: decoded } }
                : fail('INVALID_INPUT', 'Capture could not produce a valid prepared journal');
        },


        async commitPreparedQuickCapture(input: { request: NativeQuickCaptureInput; prepared: NativePreparedQuickCapture }): Promise<NativeHostResult<Extract<NativeQuickCaptureSubmitResult, { kind: 'saved' }>>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !hasKeys(input, ['request', 'prepared'])) return fail('INVALID_INPUT', 'A prepared capture command is required');
            let prepared: NativePreparedQuickCapture | null;
            try {
                const request = readCaptureRequest(input.request);
                prepared = readPreparedCapture(JSON.parse(JSON.stringify(input.prepared)));
                if (!request || !prepared || !sameJson(request, prepared.request)) return fail('INVALID_INPUT', 'Prepared capture request or journal does not match');
            } catch {
                return fail('INVALID_INPUT', 'Prepared capture journal is malformed');
            }
            const result = await useTaskStore.getState().commitPreparedCapture(prepared);
            if (!result.success) return fail('INVALID_INPUT', result.error ?? 'Prepared capture conflicts with current data');
            const saved = await durableSave();
            if (!saved.ok) return saved;
            rebuildParseOptions();
            try {
                logInfo('Prepared native capture saved', {
                    scope: 'native-host', category: 'storage',
                    context: { releaseCheck: 'v1.3.3/native-prepared-capture', operation: 'captureCommit', count: 1 },
                });
            } catch {                                                               }
            return { ok: true, value: prepared.result };
        },


        openQuickCapture(): NativeHostResult<NativeQuickCaptureView> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            rebuildParseOptions();
            return view('', freshOptions(false), null);
        },


        getQuickCaptureView(input: { text: string; options: QuickCaptureOptions; picker?: NativeQuickCapturePickerInput }): NativeHostResult<NativeQuickCaptureView> {
            const draft = readDraft(input);
            if (!draft.ok) return draft;
            const picker = readPicker(input.picker);
            if (picker === false) return fail('INVALID_INPUT', 'picker must be project, area, context or priority');
            return view(draft.value.text, draft.value.options, picker);
        },


        editQuickCapture(input: {
            text: string;
            options: QuickCaptureOptions;
            edit: QuickCaptureEdit;
            picker?: NativeQuickCapturePickerInput;
        }): NativeHostResult<{ view: NativeQuickCaptureView; notice: QuickCaptureNotice | null }> {
            const draft = readDraft(input);
            if (!draft.ok) return draft;
            const picker = readPicker(input.picker);
            if (picker === false) return fail('INVALID_INPUT', 'picker must be project, area, context or priority');
            if (!isEdit(input.edit)) return fail('INVALID_INPUT', 'edit is not a valid capture edit');
            const ctx = context();
            const edited = applyQuickCaptureEdit(draft.value.options, input.edit, {
                ...ctx,
                contextChoices: input.edit.type === 'addContexts' ? contextChoices() : undefined,
            });
            if (!edited) return fail('INVALID_INPUT', 'edit is not a valid capture edit');
            const shown = view(draft.value.text, edited.options, picker);
            if (!shown.ok) return shown;
            return { ok: true, value: { view: shown.value, notice: edited.notice } };
        },


        async submitQuickCapture(input: {
            text: string;
            options: QuickCaptureOptions;
            captureId: string;
            openAfterSave?: boolean;
        }): Promise<NativeHostResult<NativeQuickCaptureSubmitResult>> {
            const draft = readDraft(input);
            if (!draft.ok) return draft;
            if (input.openAfterSave !== undefined && typeof input.openAfterSave !== 'boolean') {
                return fail('INVALID_INPUT', 'openAfterSave must be a boolean');
            }
            const { text, options } = draft.value;
            const plan = planQuickCaptureSave(text);
            if (plan.kind === 'empty') return fail('INVALID_INPUT', 'Type something to capture');
            if (plan.kind === 'bulk') {
                return { ok: true, value: { kind: 'confirmLines', confirm: getQuickCaptureBulkConfirm(plan.lines, deps.t()), lineCount: plan.lines.length } };
            }

            const planned = planQuickCaptureTask({ text: plan.text, options }, context());
            if (!planned.success) {
                return planned.reason === 'invalid-date-command'
                    ? { ok: true, value: { kind: 'refused', notice: getQuickCaptureInvalidDateNotice(deps.t(), planned.invalidDateCommands) } }
                    : fail('INVALID_INPUT', 'Type something to capture');
            }
            const openAfterSave = input.openAfterSave === true;
            return receipts.run<NativeQuickCaptureSubmitResult>(
                input.captureId,
                JSON.stringify(['capture', text, options, openAfterSave]),
                async () => {
                    const saved = (taskId: string, projectId: string | undefined): NativeHostResult<NativeQuickCaptureSubmitResult> => {
                        rebuildParseOptions();
                        const next = openAfterSave ? 'open' : options.addAnother ? 'addAnother' : 'close';
                        return {
                            ok: true,
                            value: { kind: 'saved', taskId, projectId, next, reset: next === 'addAnother' ? { text: '', options: freshOptions(true) } : null },
                        };
                    };
                    const owned = ownedContext(input.captureId, [plan.text], options);
                    if (!owned) return projectGone();


                    const existing = useTaskStore.getState()._allTasks.find((task) => task.id === input.captureId.toLowerCase());
                    if (existing) {
                        const replanned = planQuickCaptureTask({ text: plan.text, options }, owned);
                        return replanned.success && isTaskOfPlan(existing, replanned, input.captureId)
                            ? saved(existing.id, existing.projectId)
                            : fail('INVALID_INPUT', 'Capture ID already belongs to another task');
                    }
                    try {
                        const projects = captureProjects(input.captureId);
                        const outcome = await saveQuickCapture({
                            text: plan.text,
                            options,
                            context: owned,
                            actions: {
                                addProject: projects.addProject,
                                addTask: (title, props) => useTaskStore.getState().addTask(title, props, { captureId: input.captureId }),
                            },
                            openAfterSave,
                        });
                        if (projects.made.stale) return projectGone();
                        if (outcome.kind === 'refused') return notApplied(outcome.error ?? outcome.notice.message);
                        if (!outcome.taskId) return notApplied('Task creation failed');
                        return saved(outcome.taskId, outcome.projectId);
                    } catch (error) {
                        return caught(error);
                    }
                },
            );
        },


        async submitQuickCaptureAudio(input: {
            text: string;
            options: QuickCaptureOptions;
            captureId: string;
            fallbackTitle: string;
            attachments: Attachment[];
            openAfterSave?: boolean;
        }): Promise<NativeHostResult<NativeQuickCaptureSubmitResult>> {
            const draft = readDraft(input);
            if (!draft.ok) return draft;
            if (!isText(input.fallbackTitle, TEXT_LIMIT) || !input.fallbackTitle.trim() || !Array.isArray(input.attachments)
                || typeof input.captureId !== 'string' || !deps.requestIdPattern.test(input.captureId)
                || (input.openAfterSave !== undefined && typeof input.openAfterSave !== 'boolean')) {
                return fail('INVALID_INPUT', 'A recording capture needs its UUID, a title and its attachments');
            }
            const { text, options } = draft.value;
            const captureId = input.captureId.toLowerCase();
            const fallbackTitle = input.fallbackTitle.trim();
            const next = input.openAfterSave === undefined ? 'close' : input.openAfterSave ? 'open' : options.addAnother ? 'addAnother' : 'close';

            return receipts.run<NativeQuickCaptureSubmitResult>(
                input.captureId,
                JSON.stringify(['captureAudio', text, options, fallbackTitle, input.attachments, input.openAfterSave ?? null]),
                async () => {
                    const saved = (taskId: string, projectId: string | undefined): NativeHostResult<NativeQuickCaptureSubmitResult> => {
                        rebuildParseOptions();
                        return { ok: true, value: { kind: 'saved', taskId, projectId, next,
                            reset: next === 'addAnother' ? { text: '', options: freshOptions(true) } : null } };
                    };

                    const existing = useTaskStore.getState()._allTasks.find((task) => task.id === captureId);
                    if (existing) {
                        return existing.deletedAt ? fail('INVALID_INPUT', 'Capture ID already belongs to a deleted task')
                            : saved(existing.id, existing.projectId);
                    }
                    try {
                        const projects = captureProjects(captureId);
                        const outcome = await saveQuickCapture({
                            text: text.trim(),
                            options,
                            context: context(),
                            actions: {
                                addProject: projects.addProject,
                                addTask: (title, props) => useTaskStore.getState().addTask(title, props, { captureId }),
                            },
                            fallbackTitle,
                            extraProps: { attachments: input.attachments },
                        });
                        if (outcome.kind === 'refused') {
                            return outcome.reason === 'invalid-date-command'
                                ? { ok: true, value: { kind: 'refused', notice: outcome.notice } }
                                : notApplied(outcome.error ?? outcome.notice.message);
                        }
                        if (!outcome.taskId) return notApplied('Task creation failed');
                        return saved(outcome.taskId, outcome.projectId);
                    } catch (error) {
                        return caught(error);
                    }
                },
            );
        },


        async createQuickCaptureSnapshot(): Promise<NativeHostResult<{ fileName: string; contents: string } | null>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (isSandboxMode()) return { ok: true, value: null };
            try {
                await flushPendingSave();
                const changeAt = useTaskStore.getState().lastDataChangeAt;
                const data = await getStorageAdapter().getData();
                if (useTaskStore.getState().lastDataChangeAt !== changeAt) {
                    return fail('STALE_REVISION', 'Local data changed while creating the recovery snapshot. Try again.');
                }
                const fileName = snapshotFileNameAt(new Date());
                lastSnapshot = { fileName, changeAt };
                return { ok: true, value: { fileName, contents: serializeBackupData(data) } };
            } catch (error) {
                return fail('ACTION_FAILED', error instanceof Error ? error.message : String(error));
            }
        },


        async submitQuickCaptureLines(input: {
            text: string;
            options: QuickCaptureOptions;
            captureIds: string[];
            snapshotFileName: string | null;
        }): Promise<NativeHostResult<NativeQuickCaptureLinesResult>> {
            const draft = readDraft(input);
            if (!draft.ok) return draft;
            const { text, options } = draft.value;
            const plan = planQuickCaptureSave(text);
            if (plan.kind !== 'bulk') return fail('INVALID_INPUT', 'text must hold several lines');
            const ids = input.captureIds;
            if (!Array.isArray(ids) || ids.length !== plan.lines.length
                || !ids.every((id) => typeof id === 'string' && deps.requestIdPattern.test(id))
                || new Set(ids.map((id) => id.toLowerCase())).size !== ids.length) {
                return fail('INVALID_INPUT', 'Send one distinct capture UUID per line');
            }
            if (input.snapshotFileName !== null && !isText(input.snapshotFileName, 200)) {
                return fail('INVALID_INPUT', 'snapshotFileName must be the snapshot\'s file name or null');
            }

            for (const line of plan.lines) {
                const planned = planQuickCaptureTask({ text: line, options }, context());
                if (!planned.success && planned.reason === 'invalid-date-command') {
                    return { ok: true, value: { kind: 'refused', notice: getQuickCaptureInvalidDateNotice(deps.t(), planned.invalidDateCommands) } };
                }
            }
            const taskIds = ids.map((id) => id.toLowerCase());
            return receipts.run<NativeQuickCaptureLinesResult>(ids[0], JSON.stringify(['lines', text, options, ids]), async () => {
                const state = useTaskStore.getState();
                const owned = ownedContext(ids[0], plan.lines, options);
                if (!owned) return projectGone();
                const missing: number[] = [];

                for (const [index, id] of taskIds.entries()) {
                    const existing = state._allTasks.find((task) => task.id === id);
                    if (!existing) {
                        missing.push(index);
                        continue;
                    }
                    const planned = planQuickCaptureTask({ text: plan.lines[index], options }, owned);
                    if (!planned.success || !isTaskOfPlan(existing, planned, ids[0])) return fail('INVALID_INPUT', 'Capture ID already belongs to another task');
                }
                if (missing.length === 0) {
                    rebuildParseOptions();
                    return { ok: true, value: { kind: 'saved', taskIds } };
                }
                if (!isSandboxMode() && (!lastSnapshot || input.snapshotFileName === null
                    || !isWrittenSnapshotName(input.snapshotFileName, lastSnapshot.fileName)
                    || state.lastDataChangeAt !== lastSnapshot.changeAt)) {
                    return fail('STALE_REVISION', 'Take the recovery snapshot (createQuickCaptureSnapshot) right before this batch');
                }
                try {

                    const projects = captureProjects(ids[0]);
                    const outcome = await saveQuickCaptureBulk({
                        lines: missing.map((index) => plan.lines[index]),
                        options,
                        context: owned,
                        actions: {
                            addProject: projects.addProject,
                            addTasks: (items) => useTaskStore.getState().addTasks(items),
                        },
                        captureIds: missing.map((index) => ids[index]),
                    });
                    if (projects.made.stale) return projectGone();
                    if (outcome.kind !== 'saved') return notApplied(outcome.kind === 'refused' ? outcome.notice.message : 'Could not create all tasks');
                    rebuildParseOptions();
                    return { ok: true, value: { kind: 'saved', taskIds } };
                } catch (error) {
                    return caught(error);
                }
            });
        },


        async submitQuickCapturePickerQuery(input: {
            picker: 'project' | 'area';
            query: string;
            text: string;
            options: QuickCaptureOptions;
            requestId: string;
        }): Promise<NativeHostResult<{ options: QuickCaptureOptions; created: boolean }>> {
            const draft = readDraft(input);
            if (!draft.ok) return draft;
            if ((input.picker !== 'project' && input.picker !== 'area') || !isText(input.query, 500) || !input.query.trim()) {
                return fail('INVALID_INPUT', 'A project or area picker and its search text are required');
            }
            if (typeof input.requestId !== 'string' || !deps.requestIdPattern.test(input.requestId)) {
                return fail('INVALID_INPUT', 'A request UUID is required');
            }
            const { options } = draft.value;
            const { picker, query } = input;

            const choose = (id: string, created: boolean): NativeHostResult<{ options: QuickCaptureOptions; created: boolean }> => {
                const edit: QuickCaptureEdit = picker === 'project' ? { type: 'selectProject', projectId: id } : { type: 'selectArea', areaId: id };
                return { ok: true, value: { options: applyQuickCaptureEdit(options, edit, context())!.options, created } };
            };
            const resolve = () => {
                const state = useTaskStore.getState();
                return picker === 'project'
                    ? resolveCaptureProjectQuery(state.projects, query, options.areaId)
                    : resolveCaptureAreaQuery(state.areas, query);
            };
            const createdId = input.requestId.toLowerCase();

            const made = (): NativeHostResult<{ options: QuickCaptureOptions; created: boolean }> | null => {
                const state = useTaskStore.getState();
                if (picker === 'project') {
                    const project = state._allProjects.find((entry) => entry.id === createdId);
                    if (!project) return null;
                    return isSelectableProjectForTaskAssignment(project) ? choose(project.id, false) : fail('STALE_REVISION', 'The project this request created is gone');
                }
                const area = state._allAreas.find((entry) => entry.id === createdId);
                if (!area) return null;
                return area.deletedAt ? fail('STALE_REVISION', 'The area this request created is gone') : choose(area.id, false);
            };


            if (!pickerCreates.has(input.requestId)) {
                const replayed = made();
                if (replayed) return replayed;
                const first = resolve();
                if (first.kind === 'select') return choose('project' in first ? first.project.id : first.area.id, false);
            }
            return receipts.run<{ options: QuickCaptureOptions; created: boolean }>(
                input.requestId,
                JSON.stringify(['picker', picker, query, draft.value.text, options]),
                async () => {
                    const replayed = made();
                    if (replayed) return replayed;
                    const resolution = resolve();
                    if (resolution.kind === 'empty') return fail('INVALID_INPUT', 'A search text is required');
                    if (resolution.kind === 'select') return choose('project' in resolution ? resolution.project.id : resolution.area.id, false);
                    pickerCreates.add(input.requestId);
                    try {
                        const state = useTaskStore.getState();
                        if ('projectToCreate' in resolution) {
                            const { title, color, initialProps } = resolution.projectToCreate;
                            const created = await state.addProject(title, color, { ...initialProps, id: createdId });
                            return created ? choose(created.id, true) : notApplied(useTaskStore.getState().error ?? 'Project creation failed');
                        }
                        const { name, color } = resolution.areaToCreate;

                        const restores = state._allAreas.some((area) => area.name?.trim().toLowerCase() === name.trim().toLowerCase());
                        const created = await state.addArea(name, restores ? { color } : { color, id: createdId });
                        return created ? choose(created.id, true) : notApplied(useTaskStore.getState().error ?? 'Area creation failed');
                    } catch (error) {
                        return caught(error);
                    }
                },
            );
        },
    };
}
