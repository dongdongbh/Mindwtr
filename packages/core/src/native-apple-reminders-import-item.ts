import { strToU8 } from 'fflate';
import { classifyAppleReminderForImport } from './apple-reminders-import-model';
import { buildNewTask } from './task-creation';
import { TASK_SQLITE_COLUMNS } from './task-sync-schema';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { taskEditValuesEqual } from './json-value-equality';
import type { AppSettings, Area, Task } from './types';

export type NativeAppleReminderImportRequest = { version: 1; requestId: string;
    list: { id: string; sourceId: string }; reminder: { completed: boolean; id?: string; title?: string;
        notes?: string; creationDate?: string; startDate?: string; dueDate?: string }; generatedTaskId: string | null };
export type NativeAppleReminderImportFactory = { preparedAt: string; deviceIdBefore: string | null;
    deviceIdToInitialize: string | null; effectiveDefaultAreaId: string | null };
export type NativeAppleReminderImportTarget = { id: string; row: readonly (string | number | null)[] | null };
export type NativeAppleReminderImportResult = { taskId: string; importKey: string; mode: 'new' | 'existing' };
type CommonPlan = { version: 1; request: NativeAppleReminderImportRequest;
    target: NativeAppleReminderImportTarget; result: NativeAppleReminderImportResult };
export type PreparedNativeAppleReminderImportItem = CommonPlan & (
    { mode: 'new'; factory: NativeAppleReminderImportFactory; task: Task }
    | { mode: 'existing' });

const MAX_PLAN_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_TEXT_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
function invalid(): never { throw new Error('Invalid native Apple Reminders import item'); }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
    && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exact = (value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> => record(value)
    && required.every((name) => Object.prototype.hasOwnProperty.call(value, name))
    && Object.keys(value).every((name) => required.includes(name) || optional.includes(name));
const text = (value: unknown, bytes: number): value is string => typeof value === 'string'
    && value.length <= bytes && strToU8(value).length <= bytes;
const identifier = (value: unknown, bytes: number): value is string => text(value, bytes) && value.trim().length > 0;
const factoryId = (value: unknown): value is string | null => value === null
    || (identifier(value, 500) && value.trim() === value);

/** Only closed item JSON crosses this inactive pure boundary; no storage/provider authority is granted. */
const detach = (value: unknown): unknown => {
    const valid = (part: unknown, depth: number): boolean => {
        if (depth > 24) return false;
        if (part === null || typeof part === 'string' || typeof part === 'boolean') return true;
        if (typeof part === 'number') return Number.isFinite(part);
        if (Array.isArray(part)) {
            const names = Object.keys(part);
            return part.length <= 100_000 && names.length === part.length
                && names.every((name, index) => name === String(index)) && part.every((item) => valid(item, depth + 1));
        }
        return record(part) && Object.keys(part).length <= 128 && Object.entries(part).every(([name, item]) =>
            !['__proto__', 'constructor', 'prototype'].includes(name) && valid(item, depth + 1));
    };
    if (!valid(value, 0) || !isNativeJsonWithinBytes(value, MAX_PLAN_BYTES)) invalid();
    return JSON.parse(JSON.stringify(value)) as unknown;
};
const readRequest = (value: unknown): NativeAppleReminderImportRequest => {
    if (!exact(value, ['version', 'requestId', 'list', 'reminder', 'generatedTaskId']) || value.version !== 1
        || typeof value.requestId !== 'string' || !UUID.test(value.requestId)
        || !exact(value.list, ['id', 'sourceId']) || !identifier(value.list.id, 1024) || !identifier(value.list.sourceId, 1024)
        || !exact(value.reminder, ['completed'], ['id', 'title', 'notes', 'creationDate', 'startDate', 'dueDate'])
        || typeof value.reminder.completed !== 'boolean'
        || Object.entries(value.reminder).some(([name, raw]) => name !== 'completed'
            && !text(raw, name === 'id' ? 1024 : MAX_SOURCE_TEXT_BYTES))
        || (value.generatedTaskId !== null && (typeof value.generatedTaskId !== 'string' || !UUID.test(value.generatedTaskId)))) invalid();
    return value as NativeAppleReminderImportRequest;
};
const readTarget = (value: unknown, id: string): NativeAppleReminderImportTarget => {
    if (!exact(value, ['id', 'row']) || value.id !== id) invalid();
    if (value.row !== null && (!Array.isArray(value.row) || value.row.length !== TASK_SQLITE_COLUMNS.length
        || value.row[0] !== id || !value.row.every((cell) => cell === null || typeof cell === 'string'
            || (typeof cell === 'number' && Number.isFinite(cell))))) invalid();
    return value as NativeAppleReminderImportTarget;
};
const readFactory = (value: unknown): NativeAppleReminderImportFactory => {
    if (!exact(value, ['preparedAt', 'deviceIdBefore', 'deviceIdToInitialize', 'effectiveDefaultAreaId'])
        || typeof value.preparedAt !== 'string' || !Number.isFinite(Date.parse(value.preparedAt))
        || new Date(value.preparedAt).toISOString() !== value.preparedAt
        || !factoryId(value.deviceIdBefore) || !factoryId(value.deviceIdToInitialize) || !factoryId(value.effectiveDefaultAreaId)
        || (value.deviceIdBefore === null ? typeof value.deviceIdToInitialize !== 'string' || !UUID.test(value.deviceIdToInitialize)
            : value.deviceIdToInitialize !== null)) invalid();
    return value as NativeAppleReminderImportFactory;
};

/**
 * `taskReminderDefault` is the library default a new row inherits. Validation reads it back from
 * the frozen row's suppression flag, so the plan keeps its version-1 shape.
 */
export function prepareNativeAppleReminderImportItem(input: unknown,
    taskReminderDefault: 'send' | 'skip' = 'send'): PreparedNativeAppleReminderImportItem | null {
    const value = detach(input);
    if (!exact(value, ['request', 'target', 'factory'])) invalid();
    const request = readRequest(value.request);
    // The run owner handles known-ID skips before admission, not during accepted-plan recovery.
    const classified = classifyAppleReminderForImport(request.reminder, request.list.id.trim(), new Set());
    if (classified.kind !== 'candidate') return null;
    const taskId = classified.captureId ?? request.generatedTaskId;
    if (!taskId || (classified.captureId ? request.generatedTaskId !== null : request.generatedTaskId === null)) invalid();
    const target = readTarget(value.target, taskId);
    if (target.row !== null) {
        const deleted = target.row[TASK_SQLITE_COLUMNS.indexOf('deletedAt')];
        const purged = target.row[TASK_SQLITE_COLUMNS.indexOf('purgedAt')];
        if (!classified.captureId || value.factory !== null || deleted || purged
            || (deleted !== null && typeof deleted !== 'string') || (purged !== null && typeof purged !== 'string')) invalid();
        return detach({ version: 1, request, mode: 'existing', target,
            result: { taskId, importKey: classified.importKey, mode: 'existing' } }) as PreparedNativeAppleReminderImportItem;
    }
    const factory = readFactory(value.factory);
    const areaId = factory.effectiveDefaultAreaId;
    const settings: AppSettings = { gtd: areaId ? { defaultAreaMode: 'fixed', defaultAreaId: areaId } : { defaultAreaMode: 'none' },
        taskReminderDefault };
    const areas = areaId ? [{ id: areaId }] as Area[] : [];
    const built = buildNewTask({ title: classified.title, initialTaskProps: classified.props, id: taskId, now: factory.preparedAt,
        deviceId: factory.deviceIdBefore ?? factory.deviceIdToInitialize!, state: { settings, _allAreas: areas, _allProjects: [], _allSections: [] },
        tasks: [], focusedCount: 0, focusTaskLimit: 1, projectOrderReserver: () => undefined });
    if (!built.ok) invalid();
    const task = JSON.parse(JSON.stringify(built.task)) as Task;
    const plan: PreparedNativeAppleReminderImportItem = { version: 1, request, mode: 'new', target, factory, task,
        result: { taskId, importKey: classified.importKey, mode: 'new' } };
    return detach(plan) as PreparedNativeAppleReminderImportItem;
}

/** Reconstruct the exact item without mutable registry, provider or storage reads. */
export function validatePreparedNativeAppleReminderImportItem(input: unknown): PreparedNativeAppleReminderImportItem {
    if (!exact(input, ['request', 'prepared'])) invalid();
    const request = readRequest(detach(input.request));
    const prepared = detach(input.prepared);
    if (!record(prepared) || (prepared.mode !== 'new' && prepared.mode !== 'existing')
        || !exact(prepared, prepared.mode === 'new' ? ['version', 'request', 'mode', 'target', 'factory', 'task', 'result']
            : ['version', 'request', 'mode', 'target', 'result']) || prepared.version !== 1
        || !exact(prepared.result, ['taskId', 'importKey', 'mode']) || !taskEditValuesEqual(request, prepared.request)) invalid();
    const rebuilt = prepareNativeAppleReminderImportItem({ request, target: prepared.target,
        factory: prepared.mode === 'new' ? prepared.factory : null },
        prepared.mode === 'new' && record(prepared.task) && prepared.task.suppressMindwtrReminders === true ? 'skip' : 'send');
    if (!rebuilt || !taskEditValuesEqual(prepared, rebuilt)) invalid();
    return rebuilt;
}
