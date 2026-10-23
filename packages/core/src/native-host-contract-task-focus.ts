import type { NativeHostResult } from './native-host-contract';
import { AREA_SYNC_FIELD_SCHEMA, areaToSqliteRow } from './area-sync-schema';
import { getFocusStarBlockedText } from './focus-star';
import { normalizeFocusTaskLimit } from './focus-utils';
import { taskEditValuesEqual } from './json-value-equality';
import { detach, exact, iso, record, validProject } from './native-host-contract-project-shared';
import { validSection } from './native-host-contract-project-section-rename';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { ensureDeviceId } from './store-helpers';
import { useTaskStore } from './store';
import { taskFocusAction, taskFocusEffect, taskFocusScope } from './store-tasks';
import { sameTaskSqliteRow } from './store-projects/section-actions';
import { TASK_SYNC_FIELD_SCHEMA, taskToSqliteRow } from './task-sync-schema';
import type { PreparedTaskFocus, TaskFocusWitnessRow } from './store-types';
import { getProjectFlowMode, projectFocusDateValues, type FocusDateProjection } from './task-utils';
import { isTaskActionable } from './task-status';
import { hasRecurrenceRule } from './recurrence';
import { isStatusListTaskReadOnly } from './menu-views-model';
import { tFallback } from './i18n';
import { safeParseDate } from './date';
import type { Area, Project, Task } from './types';

export type NativeTaskFocusToken = { title: string; status: Task['status']; isFocusedToday: boolean;
    rev: number | null; revBy: string | null; updatedAt: string };
export type NativeTaskFocusRequest = { requestId: string; taskId: string; focused: boolean;
    expected: NativeTaskFocusToken };
export type NativeTaskFocusResult = { id: string; focused: boolean };
export type NativePreparedTaskFocus = PreparedTaskFocus & { version: 1; request: NativeTaskFocusRequest;
    result: NativeTaskFocusResult };
export type NativeTaskFocusPreparation = { kind: 'noop'; result: NativeTaskFocusResult }
    | { kind: 'blocked'; result: { blocked: string; blockedTitle: string } }
    | { kind: 'prepared'; prepared: NativePreparedTaskFocus };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const TASK_KEYS = new Set(TASK_SYNC_FIELD_SCHEMA.map((field) => field.name));
const AREA_KEYS = new Set(AREA_SYNC_FIELD_SCHEMA.map((field) => field.name));
const ROW_KEYS = ['id', 'status', 'createdAt', 'projectId', 'sectionId', 'startTime', 'dueDate',
    'reviewAt', 'order', 'orderNum', 'isFocusedToday', 'recurrence'] as const;
const DATE_KEYS = ['value', 'parsedAt', 'parsedOffsetMinutes', 'sourceOffsetMinutes',
    'dueAt', 'dueOffsetMinutes'] as const;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const same = taskEditValuesEqual;
const token = (task: Task): NativeTaskFocusToken => ({ title: task.title, status: task.status,
    isFocusedToday: task.isFocusedToday === true, rev: task.rev ?? null,
    revBy: task.revBy ?? null, updatedAt: task.updatedAt });
const readyTask = (task: Task, projects: Project[]) => !task.deletedAt && !task.purgedAt
    && isTaskActionable(task) && !isStatusListTaskReadOnly(task, projects);

const readRequest = (value: unknown): NativeTaskFocusRequest | null => {
    const input = detach<Record<string, unknown>>(value);
    if (!input || !exact(input, ['requestId', 'taskId', 'focused', 'expected'])
        || typeof input.requestId !== 'string' || !UUID.test(input.requestId)
        || typeof input.taskId !== 'string' || !input.taskId || input.taskId.length > 500
        || typeof input.focused !== 'boolean' || !record(input.expected)
        || !exact(input.expected, ['title', 'status', 'isFocusedToday', 'rev', 'revBy', 'updatedAt'])) return null;
    const expected = input.expected;
    return typeof expected.title === 'string' && expected.title.length <= 100_000
        && ['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived'].includes(String(expected.status))
        && typeof expected.isFocusedToday === 'boolean'
        && (expected.rev === null || typeof expected.rev === 'number'
            && Number.isSafeInteger(expected.rev) && expected.rev >= 0)
        && (expected.revBy === null || typeof expected.revBy === 'string' && expected.revBy.length <= 500)
        && iso(expected.updatedAt) ? input as NativeTaskFocusRequest : null;
};

const validTask = (value: unknown, id: string): value is Task => {
    if (!record(value) || Object.keys(value).some((key) => !TASK_KEYS.has(key as keyof Task))) return false;
    const row = Object.fromEntries(Object.entries(value).map(([key, part]) => [key, part === null ? undefined : part]));
    if (row.id !== id || typeof row.title !== 'string'
        || !['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived'].includes(String(row.status))
        || !Array.isArray(row.tags) || !row.tags.every((part: unknown) => typeof part === 'string')
        || !Array.isArray(row.contexts) || !row.contexts.every((part: unknown) => typeof part === 'string')
        || !iso(row.createdAt) || !iso(row.updatedAt)
        || (row.rev !== undefined && !(typeof row.rev === 'number' && Number.isSafeInteger(row.rev) && row.rev >= 0))
        || (row.revBy !== undefined && typeof row.revBy !== 'string')) return false;
    try { taskToSqliteRow(value as unknown as Task); return true; }
    catch { return false; }
};

const validArea = (value: unknown, id: string): value is Area => {
    if (!record(value) || Object.keys(value).some((key) => !AREA_KEYS.has(key as keyof Area))
        || value.id !== id || typeof value.name !== 'string' || typeof value.order !== 'number'
        || !Number.isFinite(value.order) || !iso(value.createdAt) || !iso(value.updatedAt)
        || value.deletedAt !== undefined) return false;
    try { areaToSqliteRow(value as unknown as Area, value.updatedAt as string); return true; }
    catch { return false; }
};

const validWitnessRow = (value: unknown): value is TaskFocusWitnessRow => {
    if (!record(value) || !exact(value, ROW_KEYS) || typeof value.id !== 'string' || !value.id
        || value.id.length > 500 || !['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived'].includes(String(value.status))
        || !iso(value.createdAt) || typeof value.isFocusedToday !== 'boolean') return false;
    for (const key of ['projectId', 'sectionId', 'startTime', 'dueDate', 'reviewAt'] as const) {
        if (value[key] !== null && (typeof value[key] !== 'string' || (value[key] as string).length > 10_000)) return false;
    }
    for (const key of ['order', 'orderNum'] as const) {
        if (value[key] !== null && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) return false;
    }
    return value.recurrence === null || record(value.recurrence);
};

/** A frozen parse must remain tied to the raw calendar wall value, including each DST offset. */
export const validFrozenFocusDate = (value: unknown): value is FocusDateProjection => {
    if (!record(value) || !exact(value, DATE_KEYS) || typeof value.value !== 'string' || !value.value
        || value.value.length > 10_000) return false;
    const raw = value.value;
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
    const floating = /^\d{4}-\d{2}-\d{2}[T ]\d{2}(?::\d{2}(?::\d{2}(?:\.\d{1,3})?)?)?$/.test(raw);
    const explicit = !dateOnly && !floating && /[T ]\d{2}/.test(raw)
        && /(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(raw);
    const absolute = explicit ? safeParseDate(raw) : null;
    const localParts = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?)?$/.exec(raw);
    const baseWall = localParts ? Date.parse(`${localParts[1]}-${localParts[2]}-${localParts[3]}T00:00:00.000Z`) : Number.NaN;
    const rawValid = Number.isFinite(baseWall) && new Date(baseWall).toISOString().slice(0, 10) === raw.slice(0, 10);
    // RN's local parser deliberately lets clock fields roll into the next day.
    const rawWall = rawValid ? baseWall + Number(localParts?.[4] ?? 0) * 3_600_000
        + Number(localParts?.[5] ?? 0) * 60_000 + Number(localParts?.[6] ?? 0) * 1_000
        + Number((localParts?.[7] ?? '0').padEnd(3, '0')) : Number.NaN;
    if ((dateOnly || floating) && !rawValid) return value.parsedAt === null && value.dueAt === null
        && value.parsedOffsetMinutes === null && value.dueOffsetMinutes === null
        && value.sourceOffsetMinutes === null;
    if ((!dateOnly && !floating && !explicit) || explicit && !absolute)
        return value.parsedAt === null && value.dueAt === null
        && value.parsedOffsetMinutes === null && value.dueOffsetMinutes === null
        && value.sourceOffsetMinutes === null;
    if (typeof value.parsedAt !== 'number' || !Number.isFinite(value.parsedAt)
        || typeof value.dueAt !== 'number' || !Number.isFinite(value.dueAt)) return false;
    const validOffset = (offset: unknown) => typeof offset === 'number'
        && Number.isInteger(offset) && Math.abs(offset) <= 840;
    if (!validOffset(value.parsedOffsetMinutes) || !validOffset(value.dueOffsetMinutes)
        || !validOffset(value.sourceOffsetMinutes)) return false;
    if (explicit && absolute?.getTime() !== value.parsedAt) return false;
    const local = (epoch: number, offset: number) => new Date(epoch - offset * 60_000).toISOString();
    try {
        const first = local(value.parsedAt, value.parsedOffsetMinutes as number);
        const due = local(value.dueAt, value.dueOffsetMinutes as number);
        if (/[T\s]\d{2}:\d{2}/.test(raw)) {
            if (value.dueAt !== value.parsedAt) return false;
        } else if (due !== `${(explicit ? new Date(first) : new Date(rawWall)).toISOString().slice(0, 10)}T23:59:59.999Z`) return false;
        if (explicit) return true;
        const parsedWall = Date.parse(first);
        if (parsedWall === rawWall) return true;
        const gap = parsedWall - rawWall;
        return gap > 0 && gap <= 180 * 60_000 && gap % 60_000 === 0
            && (value.sourceOffsetMinutes as number) - (value.parsedOffsetMinutes as number) === gap / 60_000
            && value.parsedAt === rawWall + (value.sourceOffsetMinutes as number) * 60_000;
    } catch { return false; }
};

const requiredDates = (scope: PreparedTaskFocus['scope']): string[] => {
    const values: Array<string | null | undefined> = [scope.task.startTime, scope.task.reviewAt];
    // Per section projects (#1429) run sequences too, so their peers' dates count.
    const sequenced = scope.project ? getProjectFlowMode(scope.project) !== 'parallel' : false;
    if (sequenced || !scope.task.startTime && hasRecurrenceRule(scope.task.recurrence))
        values.push(scope.task.dueDate);
    if (sequenced) {
        scope.peers.forEach((row) => values.push(row.dueDate, row.reviewAt));
    }
    scope.focused.forEach((row) => {
        values.push(row.startTime);
        if (!row.startTime && hasRecurrenceRule(row.recurrence ?? undefined))
            values.push(row.dueDate, row.reviewAt);
    });
    return [...new Set(values.filter((part): part is string => typeof part === 'string' && part.length > 0))].sort();
};

/** Pure cold-journal validation, with no store or SQLite access. */
const readPrepared = (value: unknown): NativePreparedTaskFocus | null => {
    const envelope = detach<Record<string, unknown>>(value);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readRequest(envelope.request);
    const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'request', 'scope', 'effect', 'deviceIdBefore',
        'deviceIdToInitialize', 'preparedAt', 'preparedLocalDay', 'preparedOffsetMinutes',
        'boundaryOffsetMinutes', 'futureBoundary', 'dates', 'result']) || raw.version !== 1
        || !same(raw.request, request) || !record(raw.scope)
        || !exact(raw.scope, ['task', 'project', 'sections', 'area', 'peers', 'focused', 'focusLimit'])
        || !Array.isArray(raw.scope.sections) || !Array.isArray(raw.scope.peers)
        || !Array.isArray(raw.scope.focused) || typeof raw.scope.focusLimit !== 'number'
        || !Number.isInteger(raw.scope.focusLimit)
        || raw.scope.focusLimit < 1 || raw.scope.focusLimit > 10
        || !record(raw.effect) || !exact(raw.effect, ['task']) || !record(raw.effect.task)
        || !exact(raw.effect.task, ['before', 'after'])
        || !(raw.deviceIdBefore === null || typeof raw.deviceIdBefore === 'string' && Boolean(raw.deviceIdBefore))
        || (raw.deviceIdBefore === null
            ? typeof raw.deviceIdToInitialize !== 'string' || !UUID.test(raw.deviceIdToInitialize)
            : raw.deviceIdToInitialize !== null)
        || !iso(raw.preparedAt) || typeof raw.preparedLocalDay !== 'string'
        || !/^\d{4}-\d{2}-\d{2}$/.test(raw.preparedLocalDay)
        || !Number.isInteger(raw.preparedOffsetMinutes) || Math.abs(raw.preparedOffsetMinutes as number) > 840
        || !Number.isInteger(raw.boundaryOffsetMinutes) || Math.abs(raw.boundaryOffsetMinutes as number) > 840
        || !iso(raw.futureBoundary) || !Array.isArray(raw.dates)
        || !record(raw.result) || !exact(raw.result, ['id', 'focused'])
        || raw.result.id !== request.taskId || raw.result.focused !== request.focused) return null;
    try {
        const prepared = raw as unknown as NativePreparedTaskFocus;
        const { scope } = prepared;
        if (!validTask(scope.task, request.taskId) || !readyTask(scope.task, scope.project ? [scope.project] : [])
            || !same(token(scope.task), request.expected)
            || (scope.project !== null && (!scope.task.projectId || !validProject(scope.project, scope.task.projectId)))
            || (scope.project === null && Boolean(scope.task.projectId))
            || (scope.area !== null && (!scope.task.areaId || !validArea(scope.area, scope.task.areaId)))
            || (scope.area === null && !scope.task.projectId && Boolean(scope.task.areaId))
            || scope.sections.some((row) => !validSection(row, row.id, scope.task.projectId ?? '') || row.deletedAt)
            || scope.sections.some((row, index) => index > 0 && scope.sections[index - 1].id >= row.id)
            || scope.peers.some((row) => !validWitnessRow(row) || row.projectId !== (scope.task.projectId ?? null)
                || !['inbox', 'next', 'waiting', 'someday'].includes(row.status))
            || scope.focused.some((row) => !validWitnessRow(row) || !row.isFocusedToday)
            || [scope.peers, scope.focused].some((rows) => rows.some((row, index) => index > 0 && rows[index - 1].id >= row.id))
            || (scope.project && ['inbox', 'next', 'waiting', 'someday'].includes(scope.task.status)
                && !scope.peers.some((row) => same(row, {
                    id: scope.task.id, status: scope.task.status, createdAt: scope.task.createdAt,
                    projectId: scope.task.projectId ?? null, sectionId: scope.task.sectionId ?? null,
                    startTime: scope.task.startTime ?? null, dueDate: scope.task.dueDate ?? null,
                    reviewAt: scope.task.reviewAt ?? null, order: scope.task.order ?? null,
                    orderNum: scope.task.orderNum ?? null, isFocusedToday: scope.task.isFocusedToday === true,
                    recurrence: scope.task.recurrence ?? null,
                })))
            || new Date(Date.parse(prepared.preparedAt) - prepared.preparedOffsetMinutes * 60_000)
                .toISOString().slice(0, 10) !== prepared.preparedLocalDay
            || new Date(Date.parse(`${prepared.preparedLocalDay}T23:59:59.999Z`)
                + prepared.boundaryOffsetMinutes * 60_000).toISOString() !== prepared.futureBoundary
            || !same(requiredDates(scope), prepared.dates.map((row) => row.value))
            || prepared.dates.some((row) => !validFrozenFocusDate(row))
            || !validTask(prepared.effect.task.before, request.taskId)
            || !validTask(prepared.effect.task.after, request.taskId)
            || !sameTaskSqliteRow(scope.task, prepared.effect.task.before)) return null;
        const dates = new Map(prepared.dates.map((row) => [row.value, row]));
        const planned = taskFocusEffect(scope, request.focused,
            prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!, prepared.preparedAt,
            prepared.futureBoundary, dates);
        return planned && sameTaskSqliteRow(planned.task.after, prepared.effect.task.after)
            ? prepared : null;
    } catch { return null; }
};

export function createTaskFocusMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    revision: () => string;
    t: () => (key: string) => string;
}) {
    const blockedTitle = () => tFallback(deps.t(), 'digest.focus', 'Focus');
    return {
        getTaskFocusOptions(input: { taskId: string }): NativeHostResult<{ revision: string;
            task: { id: string } & NativeTaskFocusToken; canChange: boolean;
            action: { canToggle: boolean; blockedReason: string | null; label: string;
                blocked: string | null; blockedTitle: string } }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!input || typeof input.taskId !== 'string' || !input.taskId || input.taskId.length > 500)
                return fail('INVALID_INPUT', 'A Task ID is required');
            const state = useTaskStore.getState();
            const task = state._tasksById.get(input.taskId);
            if (!task || task.deletedAt || task.purgedAt)
                return fail('STALE_REVISION', 'Task is unavailable; refresh before changing Focus');
            const canChange = readyTask(task, state._allProjects);
            const action = state.getFocusStarAction(task);
            const value = { revision: deps.revision(), task: { id: task.id, ...token(task) }, canChange,
                action: { canToggle: canChange && action.canToggle, blockedReason: action.blockedReason,
                    label: tFallback(deps.t(), action.labelKey, action.labelKey),
                    blocked: getFocusStarBlockedText(deps.t(), action,
                        normalizeFocusTaskLimit(state.settings.gtd?.focusTaskLimit)), blockedTitle: blockedTitle() } };
            return isNativeJsonWithinBytes(value) ? { ok: true, value }
                : fail('INVALID_INPUT', 'Task Focus options exceed the bounded native response');
        },

        probeTaskFocusOutcome(input: NativeTaskFocusRequest): NativeHostResult<NativeTaskFocusResult> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            return readRequest(input) ? fail('STALE_REVISION', 'Task Focus outcome is unknown; refresh before trying again')
                : fail('INVALID_INPUT', 'A bounded Task Focus request is required');
        },

        prepareTaskFocus(input: NativeTaskFocusRequest): NativeHostResult<NativeTaskFocusPreparation> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded Task Focus request is required');
            const state = useTaskStore.getState();
            const task = state._tasksById.get(request.taskId);
            if (!task || task.deletedAt || task.purgedAt || !same(token(task), request.expected))
                return fail('STALE_REVISION', 'Task changed; refresh before changing Focus');
            if (!readyTask(task, state._allProjects)) return fail('INVALID_INPUT', 'Task is read-only');
            const result = { id: task.id, focused: request.focused };
            if (Boolean(task.isFocusedToday) === request.focused)
                return { ok: true, value: { kind: 'noop', result } };
            const action = state.getFocusStarAction(task);
            if (!action.canToggle) return { ok: true, value: { kind: 'blocked', result: {
                blocked: getFocusStarBlockedText(deps.t(), action,
                    normalizeFocusTaskLimit(state.settings.gtd?.focusTaskLimit)) ?? '',
                blockedTitle: blockedTitle(),
            } } };
            const preparedAt = new Date().toISOString();
            const now = new Date(preparedAt);
            const end = new Date(now); end.setHours(23, 59, 59, 999);
            const scope = taskFocusScope(state, task);
            const dates = projectFocusDateValues(requiredDates(scope));
            const lookup = new Map(dates.map((row) => [row.value, row]));
            const frozenAction = taskFocusAction(scope, preparedAt, end.toISOString(), lookup);
            if (!frozenAction.canToggle || frozenAction.patch.isFocusedToday !== request.focused)
                return fail('STALE_REVISION', 'Task Focus policy changed; refresh before trying again');
            const device = ensureDeviceId(state.settings);
            const effect = taskFocusEffect(scope, request.focused, device.deviceId, preparedAt, end.toISOString(), lookup);
            if (!effect) return fail('INVALID_INPUT', 'Task Focus change is unavailable');
            const prepared: NativePreparedTaskFocus = { version: 1, request, scope, effect,
                deviceIdBefore: state.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                preparedAt, preparedLocalDay: new Date(Date.parse(preparedAt) - now.getTimezoneOffset() * 60_000)
                    .toISOString().slice(0, 10),
                preparedOffsetMinutes: now.getTimezoneOffset(), boundaryOffsetMinutes: end.getTimezoneOffset(),
                futureBoundary: end.toISOString(), dates, result };
            const frozen = detach<NativePreparedTaskFocus>(JSON.parse(JSON.stringify(prepared)));
            return frozen && readPrepared({ request, prepared: frozen })
                ? { ok: true, value: { kind: 'prepared', prepared: frozen } }
                : fail('INVALID_INPUT', 'Task Focus change exceeds the bounded journal');
        },

        validatePreparedTaskFocus(input: { request: NativeTaskFocusRequest;
            prepared: NativePreparedTaskFocus }): NativeHostResult<NativeTaskFocusResult> {
            const prepared = readPrepared(input);
            return prepared ? { ok: true, value: prepared.result }
                : fail('INVALID_INPUT', 'Prepared Task Focus request or journal does not match');
        },

        async commitPreparedTaskFocus(input: { request: NativeTaskFocusRequest;
            prepared: NativePreparedTaskFocus }): Promise<NativeHostResult<NativeTaskFocusResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const prepared = readPrepared(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared Task Focus request or journal does not match');
            const applied = await useTaskStore.getState().commitPreparedTaskFocus(prepared);
            if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Prepared Task Focus conflicts with current data');
            try {
                if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
            } catch (error) { return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error)); }
            const saved = await deps.save();
            return saved.ok ? { ok: true, value: prepared.result } : saved;
        },
    };
}
