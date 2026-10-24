import { strToU8 } from 'fflate';
import { createPomodoroState, resetPomodoroState, type PomodoroDurations, type PomodoroSessionHistory, type PomodoroState } from './pomodoro';
import { resolvePomodoroSession, serializePomodoroSession, type StoredPomodoroSession } from './pomodoro-session';
import { TASK_SQLITE_COLUMNS } from './task-sync-schema';
import { addTimeSpentMinutes, normalizeTimeSpentMinutes, TIME_SPENT_MAX_MINUTES } from './time-spent';
import { nextRevision } from './sync-revision';
import { taskEditValuesEqual } from './json-value-equality';

export const MAX_NATIVE_POMODORO_SESSION_BYTES = 1_000_000;
export const MAX_NATIVE_POMODORO_PLAN_BYTES = 2_000_000;
export const MAX_NATIVE_POMODORO_RESULT_BYTES = 8192;
/** Persisted schema4 receipt rows keep their original shape; never infer it from a later schema's width. */
export const NATIVE_POMODORO_SCHEMA4_TASK_COLUMNS = [
    'id', 'title', 'status', 'priority', 'energyLevel', 'assignedTo', 'taskMode', 'startTime',
    'relativeStartOffset', 'dueDate', 'recurrence', 'showFutureRecurrence', 'pushCount', 'repeatReminderMinutes', 'tags',
    'contexts', 'checklist', 'description', 'textDirection', 'attachments', 'location', 'projectId', 'sectionId', 'areaId',
    'orderNum', 'boardOrder', 'focusOrder', 'isFocusedToday', 'timeEstimate', 'timeSpentMinutes', 'suppressMindwtrReminders',
    'reviewAt', 'completedAt', 'statusBeforeProjectArchive', 'completedAtBeforeProjectArchive', 'isFocusedTodayBeforeProjectArchive',
    'projectArchivedAt', 'rev', 'revBy', 'createdAt', 'updatedAt', 'deletedAt', 'purgedAt', 'viewSectionIds', 'cancelledAt', 'archivedAt',
] as const;
const MAX_LEGACY_REQUEST_BYTES = 2_000_000;
type NativeSession = StoredPomodoroSession & { durations: PomodoroDurations; timerState: PomodoroState;
    sessionHistory: PomodoroSessionHistory; updatedAtMs: number };
export type NativePomodoroSession = { version: 1; sessionID: string; generation: number; session: NativeSession };
export type NativePomodoroSessionRead = { raw: null; state: null } | { raw: string; state: NativePomodoroSession };
export type NativePomodoroRequest =
    | { action: 'initialize'; requestId: string; observedAtMs: number; localDayKey: string; durations: PomodoroDurations }
    | { action: 'adoptLegacy'; requestId: string; observedAtMs: number; localDayKey: string;
        autoStart: { autoStartFocus: boolean; autoStartBreaks: boolean };
        legacy: { version: 1; namespace: string; sessionRaw: string | null; collapsedRaw: string | null } }
    | { action: 'reconcile'; requestId: string; observedAtMs: number; localDayKey: string;
        autoStart: { autoStartFocus: boolean; autoStartBreaks: boolean } }
    | { action: 'setDurations'; requestId: string; observedAtMs: number; localDayKey: string;
        autoStart: { autoStartFocus: boolean; autoStartBreaks: boolean }; durations: PomodoroDurations }
    | { action: 'toggle' | 'reset' | 'switchPhase'; requestId: string; observedAtMs: number; localDayKey: string;
        autoStart: { autoStartFocus: boolean; autoStartBreaks: boolean } }
    | { action: 'selectTask'; requestId: string; observedAtMs: number; localDayKey: string;
        autoStart: { autoStartFocus: boolean; autoStartBreaks: boolean }; taskId: string | null };
export type NativePomodoroTaskBefore = { id: string; row: readonly (string | number | null)[] | null };
export type NativePomodoroTaskPatch = { timeSpentMinutes: number; rev: number; revBy: string; updatedAt: string };
/** A task other than the selected one that an RN session still owed time to, and its write. */
export type NativePomodoroOwedTask = { target: NativePomodoroTaskBefore; taskPatch: NativePomodoroTaskPatch | null };
export type NativePomodoroResult = { sessionID: string; generation: number; completedFocusSessions: number;
    creditedMinutes: number; creditDisposition: 'credited' | 'unlinked' | 'unavailable' | 'capped' | 'none' };
export type PreparedNativePomodoroTransition = { version: 1; request: NativePomodoroRequest; sessionBefore: string | null;
    sessionAfter: string; target: NativePomodoroTaskBefore | null; taskPatch: NativePomodoroTaskPatch | null;
    deviceId: string | null; result: NativePomodoroResult;
    /** Present only when an adopted RN session owed time to tasks other than the selected one. */
    owed?: NativePomodoroOwedTask[] };
type OwedCredit = { taskId: string; from?: number | null; to: number };

function invalid(): never { throw new Error('Invalid native Pomodoro transition'); }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
    && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exact = (value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> => record(value)
    && required.every((name) => Object.prototype.hasOwnProperty.call(value, name)) && Object.keys(value).every((name) => required.includes(name) || optional.includes(name));
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
const identity = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length > 0
    && value.length <= limit && value.trim() === value && !['__proto__', 'constructor', 'prototype'].includes(value);
const time = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)
    && Math.abs(value) <= 8_640_000_000_000_000;
const day = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const date = (value: unknown): value is string => typeof value === 'string' && value.length <= 32
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const bounded = (value: string, bytes: number): boolean => value.length <= bytes && strToU8(value).length <= bytes;
const durations = (value: unknown): value is PomodoroDurations => exact(value, ['focusMinutes', 'breakMinutes'])
    && [value.focusMinutes, value.breakMinutes].every((n) => count(n) && n >= 1 && n <= 180);

/** JSON.parse establishes syntax; this bounded walk additionally refuses duplicate names. */
const parseSession = (raw: string): unknown => {
    if (typeof raw !== 'string' || !bounded(raw, MAX_NATIVE_POMODORO_SESSION_BYTES)) invalid();
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return invalid(); }
    let offset = 0;
    const space = () => { while (/\s/u.test(raw[offset] ?? '') && offset < raw.length) offset += 1; };
    const string = (): string => {
        const start = offset++;
        while (offset < raw.length) {
            const char = raw[offset++];
            if (char === '\\') offset += 1;
            else if (char === '"') return JSON.parse(raw.slice(start, offset)) as string;
        }
        return invalid();
    };
    const walk = (depth: number): void => {
        if (depth > 32) invalid();
        space();
        if (raw[offset] === '{') {
            offset += 1; space(); const names = new Set<string>();
            if (raw[offset] === '}') { offset += 1; return; }
            while (offset < raw.length) {
                space(); const name = string(); if (names.has(name)) invalid(); names.add(name);
                space(); offset += 1; walk(depth + 1); space();
                if (raw[offset++] === '}') return;
            }
        } else if (raw[offset] === '[') {
            offset += 1; space(); if (raw[offset] === ']') { offset += 1; return; }
            while (offset < raw.length) { walk(depth + 1); space(); if (raw[offset++] === ']') return; }
        } else if (raw[offset] === '"') string();
        else { while (offset < raw.length && !/[\s,\]}]/u.test(raw[offset])) offset += 1; }
    };
    walk(0);
    return parsed;
};

/** Historical fields may be missing, but malformed present values are not defaults. */
const legacySessionOf = (raw: string | null): StoredPomodoroSession & { pendingCredits?: OwedCredit[] } => {
    if (raw === null) return {};
    const value = parseSession(raw);
    if (!exact(value, [], ['durations', 'timerState', 'sessionHistory', 'selectedTaskId', 'phaseEndsAt', 'updatedAtMs', 'pendingCredits'])) invalid();
    // RN stores a finished focus's time here before its task holds it (`from` is absent for a task with no time).
    if (Object.prototype.hasOwnProperty.call(value, 'pendingCredits') && (!Array.isArray(value.pendingCredits)
        || value.pendingCredits.length > 10_000 || !value.pendingCredits.every((credit: unknown) => exact(credit, ['taskId', 'to'], ['from'])
            && identity(credit.taskId, 500) && count(credit.to) && credit.to <= TIME_SPENT_MAX_MINUTES
            && (!Object.prototype.hasOwnProperty.call(credit, 'from') || credit.from === null
                || (typeof credit.from === 'number' && Number.isFinite(credit.from)))))) invalid();
    const present = (name: string, object = value) => Object.prototype.hasOwnProperty.call(object, name);
    if ((present('selectedTaskId') && !identity(value.selectedTaskId, 500))
        || (present('phaseEndsAt') && !date(value.phaseEndsAt)) || (present('updatedAtMs') && !time(value.updatedAtMs))) invalid();
    if (present('durations') && (!exact(value.durations, [], ['focusMinutes', 'breakMinutes'])
        || !Object.values(value.durations).every((n) => count(n) && n >= 1 && n <= 180))) invalid();
    if (present('timerState')) {
        const timer = value.timerState;
        if (!exact(timer, [], ['phase', 'remainingSeconds', 'isRunning', 'completedFocusSessions'])
            || (present('phase', timer) && timer.phase !== 'focus' && timer.phase !== 'break')
            || (present('remainingSeconds', timer) && (typeof timer.remainingSeconds !== 'number'
                || !Number.isFinite(timer.remainingSeconds) || timer.remainingSeconds < 0 || timer.remainingSeconds > 180 * 60))
            || (present('isRunning', timer) && typeof timer.isRunning !== 'boolean')
            || (present('completedFocusSessions', timer) && !count(timer.completedFocusSessions))) invalid();
    }
    if (present('sessionHistory')) {
        const history = value.sessionHistory;
        if (!exact(history, [], ['totalCompletedFocusSessions', 'completedFocusSessionsByTaskId', 'todayDayKey', 'completedTodayFocusSessions'])
            || (present('totalCompletedFocusSessions', history) && !count(history.totalCompletedFocusSessions))
            || (present('completedTodayFocusSessions', history) && !count(history.completedTodayFocusSessions))
            || (present('todayDayKey', history) && !day(history.todayDayKey))) invalid();
        if (present('completedFocusSessionsByTaskId', history)) {
            if (!record(history.completedFocusSessionsByTaskId)) invalid();
            const entries = Object.entries(history.completedFocusSessionsByTaskId);
            if (entries.length > 10_000) invalid();
            let sum = 0;
            for (const [id, n] of entries) {
                if (!identity(id, 500) || !count(n)) invalid();
                sum += n; if (!count(sum)) invalid();
            }
        }
    }
    return value as StoredPomodoroSession;
};

export function decodeNativePomodoroSession(raw: string): NativePomodoroSession {
    const value = parseSession(raw);
    if (!exact(value, ['version', 'sessionID', 'generation', 'session']) || value.version !== 1
        || !uuid(value.sessionID) || !count(value.generation)) invalid();
    const session = value.session;
    if (!exact(session, ['durations', 'timerState', 'sessionHistory', 'updatedAtMs'], ['selectedTaskId', 'phaseEndsAt'])
        || !durations(session.durations) || !time(session.updatedAtMs)
        || (Object.prototype.hasOwnProperty.call(session, 'selectedTaskId') && !identity(session.selectedTaskId, 500))) invalid();
    const timer = session.timerState; const history = session.sessionHistory;
    if (!exact(timer, ['phase', 'remainingSeconds', 'isRunning', 'completedFocusSessions'])
        || (timer.phase !== 'focus' && timer.phase !== 'break') || !count(timer.remainingSeconds)
        || timer.remainingSeconds > (timer.phase === 'focus' ? session.durations.focusMinutes : session.durations.breakMinutes) * 60
        || typeof timer.isRunning !== 'boolean' || !count(timer.completedFocusSessions)
        || (timer.isRunning ? !date(session.phaseEndsAt) : Object.prototype.hasOwnProperty.call(session, 'phaseEndsAt'))) invalid();
    if (!exact(history, ['totalCompletedFocusSessions', 'completedFocusSessionsByTaskId', 'todayDayKey', 'completedTodayFocusSessions'])
        || !count(history.totalCompletedFocusSessions) || history.totalCompletedFocusSessions !== timer.completedFocusSessions
        || !count(history.completedTodayFocusSessions) || history.completedTodayFocusSessions > history.totalCompletedFocusSessions
        || !day(history.todayDayKey) || !record(history.completedFocusSessionsByTaskId)) invalid();
    const entries = Object.entries(history.completedFocusSessionsByTaskId);
    if (entries.length > 10_000) invalid();
    let sum = 0;
    for (const [id, n] of entries) {
        if (!identity(id, 500) || !count(n) || n === 0 || n > history.totalCompletedFocusSessions) invalid();
        sum += n; if (!count(sum) || sum > history.totalCompletedFocusSessions) invalid();
    }
    return value as NativePomodoroSession;
}

const requestOf = (value: unknown): NativePomodoroRequest => {
    if (!record(value) || !uuid(value.requestId) || !time(value.observedAtMs) || !day(value.localDayKey)) invalid();
    if (value.action === 'initialize') {
        if (!exact(value, ['action', 'requestId', 'observedAtMs', 'localDayKey', 'durations']) || !durations(value.durations)) invalid();
        return { action: 'initialize', requestId: value.requestId, observedAtMs: value.observedAtMs, localDayKey: value.localDayKey,
            durations: { focusMinutes: value.durations.focusMinutes, breakMinutes: value.durations.breakMinutes } };
    }
    if (!exact(value.autoStart, ['autoStartFocus', 'autoStartBreaks'])
        || typeof value.autoStart.autoStartFocus !== 'boolean' || typeof value.autoStart.autoStartBreaks !== 'boolean') invalid();
    if (value.action === 'adoptLegacy') {
        const legacy = value.legacy;
        if (!exact(value, ['action', 'requestId', 'observedAtMs', 'localDayKey', 'autoStart', 'legacy'])
            || !exact(legacy, ['version', 'namespace', 'sessionRaw', 'collapsedRaw']) || legacy.version !== 1
            || typeof legacy.namespace !== 'string' || !/^[A-Za-z0-9._-]{1,255}$/u.test(legacy.namespace)
            || ![legacy.sessionRaw, legacy.collapsedRaw].every((raw) => raw === null
                || (typeof raw === 'string' && bounded(raw, MAX_NATIVE_POMODORO_SESSION_BYTES)))) invalid();
        const request: NativePomodoroRequest = { action: 'adoptLegacy', requestId: value.requestId,
            observedAtMs: value.observedAtMs, localDayKey: value.localDayKey,
            autoStart: { autoStartFocus: value.autoStart.autoStartFocus, autoStartBreaks: value.autoStart.autoStartBreaks },
            legacy: { version: 1, namespace: legacy.namespace, sessionRaw: legacy.sessionRaw as string | null,
                collapsedRaw: legacy.collapsedRaw as string | null } };
        if (!bounded(JSON.stringify(request), MAX_LEGACY_REQUEST_BYTES)) invalid();
        return request;
    }
    if (value.action === 'setDurations') {
        if (!exact(value, ['action', 'requestId', 'observedAtMs', 'localDayKey', 'autoStart', 'durations']) || !durations(value.durations)) invalid();
        return { action: 'setDurations', requestId: value.requestId, observedAtMs: value.observedAtMs, localDayKey: value.localDayKey,
            autoStart: { autoStartFocus: value.autoStart.autoStartFocus, autoStartBreaks: value.autoStart.autoStartBreaks },
            durations: { focusMinutes: value.durations.focusMinutes, breakMinutes: value.durations.breakMinutes } };
    }
    if (value.action === 'selectTask') {
        if (!exact(value, ['action', 'requestId', 'observedAtMs', 'localDayKey', 'autoStart', 'taskId'])
            || (value.taskId !== null && !identity(value.taskId, 500))) invalid();
        return { action: 'selectTask', requestId: value.requestId, observedAtMs: value.observedAtMs, localDayKey: value.localDayKey,
            autoStart: { autoStartFocus: value.autoStart.autoStartFocus, autoStartBreaks: value.autoStart.autoStartBreaks }, taskId: value.taskId };
    }
    if ((value.action !== 'reconcile' && value.action !== 'toggle' && value.action !== 'reset' && value.action !== 'switchPhase')
        || !exact(value, ['action', 'requestId', 'observedAtMs', 'localDayKey', 'autoStart'])) invalid();
    return { action: value.action, requestId: value.requestId, observedAtMs: value.observedAtMs, localDayKey: value.localDayKey,
        autoStart: { autoStartFocus: value.autoStart.autoStartFocus, autoStartBreaks: value.autoStart.autoStartBreaks } };
};
const targetOf = (value: unknown, id: string | undefined): NativePomodoroTaskBefore | null => {
    if (!id) { if (value !== null) invalid(); return null; }
    if (!exact(value, ['id', 'row']) || value.id !== id) invalid();
    if (value.row === null) return { id, row: null };
    const legacyLayout = Array.isArray(value.row) && (value.row.length === NATIVE_POMODORO_SCHEMA4_TASK_COLUMNS.length
            || (value.row.length === NATIVE_POMODORO_SCHEMA4_TASK_COLUMNS.length + 1
                && TASK_SQLITE_COLUMNS[NATIVE_POMODORO_SCHEMA4_TASK_COLUMNS.length] === 'reminderPolicy'))
        && NATIVE_POMODORO_SCHEMA4_TASK_COLUMNS.every((name, index) => TASK_SQLITE_COLUMNS[index] === name);
    if (!Array.isArray(value.row) || (value.row.length !== TASK_SQLITE_COLUMNS.length && !legacyLayout) || value.row[0] !== id
        || !value.row.every((cell) => cell === null || typeof cell === 'string' || (typeof cell === 'number' && Number.isFinite(cell)))) invalid();
    return { id, row: [...value.row] as (string | number | null)[] };
};
const cell = (row: readonly (string | number | null)[], name: string) => row[TASK_SQLITE_COLUMNS.indexOf(name)];
const legacyOf = (request: NativePomodoroRequest) => request.action === 'adoptLegacy' ? legacySessionOf(request.legacy.sessionRaw) : null;
const owedIdsOf = (legacy: ReturnType<typeof legacySessionOf> | null): string[] =>
    [...new Set((legacy?.pendingCredits ?? []).map((credit) => credit.taskId))].filter((id) => id !== legacy?.selectedTaskId);
/** The tasks other than the selected one whose BEFORE rows an adoption reads: each one its RN session still owed time to. */
export function nativePomodoroOwedTaskIds(request: NativePomodoroRequest): string[] {
    return owedIdsOf(legacyOf(requestOf(request)));
}
/** How many credits an adopted RN session still owed (0 for any other action). */
export function nativePomodoroOwedCreditCount(request: NativePomodoroRequest): number {
    return legacyOf(requestOf(request))?.pendingCredits?.length ?? 0;
}

export function prepareNativePomodoroTransition(input: { request: NativePomodoroRequest; session: NativePomodoroSessionRead;
    target: NativePomodoroTaskBefore | null; owed?: readonly NativePomodoroTaskBefore[]; deviceId: string | null }): PreparedNativePomodoroTransition | null {
    const request = requestOf(input.request);
    const legacySource = legacyOf(request);
    const owedIds = owedIdsOf(legacySource);
    const owedInput = input.owed ?? [];
    if (!Array.isArray(owedInput) || owedInput.length !== owedIds.length) invalid();
    const owedTargets = owedIds.map((id, index) => targetOf(owedInput[index], id)!);
    if (!exact(input.session, ['raw', 'state'])) invalid();
    let after: NativePomodoroSession; let target: NativePomodoroTaskBefore | null = null;
    let taskPatch: NativePomodoroTaskPatch | null = null; let delta = 0; let creditedMinutes = 0;
    let creditDisposition: NativePomodoroResult['creditDisposition'] = 'none';
    let deviceId: string | null = null;
    let creditFocusMinutes = 0;
    if (request.action === 'initialize') {
        if (input.session.raw !== null || input.session.state !== null || input.target !== null || input.deviceId !== null) invalid();
        after = { version: 1, sessionID: request.requestId, generation: 0, session: { durations: request.durations,
            timerState: createPomodoroState(request.durations), sessionHistory: { totalCompletedFocusSessions: 0,
                completedFocusSessionsByTaskId: {}, todayDayKey: request.localDayKey, completedTodayFocusSessions: 0 }, updatedAtMs: request.observedAtMs } };
    } else if (request.action === 'adoptLegacy') {
        if (input.session.raw !== null || input.session.state !== null) invalid();
        const { pendingCredits: _owed, ...legacy } = legacySource!;
        target = targetOf(input.target, legacy.selectedTaskId);
        if (input.deviceId !== null && !identity(input.deviceId, 200)) invalid();
        // Pausing only the copy makes normalization historical, not new task credit.
        const saved = resolvePomodoroSession({ ...legacy, timerState: { ...legacy.timerState, isRunning: false } },
            request.observedAtMs, request.autoStart, request.localDayKey);
        const resolved = resolvePomodoroSession(legacy, request.observedAtMs, request.autoStart, request.localDayKey);
        delta = resolved.sessionHistory.totalCompletedFocusSessions - saved.sessionHistory.totalCompletedFocusSessions;
        if (!count(delta)) invalid();
        creditFocusMinutes = saved.durations.focusMinutes;
        after = { version: 1, sessionID: request.requestId, generation: 0,
            session: { ...serializePomodoroSession(resolved), durations: resolved.durations, timerState: resolved.timerState,
                sessionHistory: resolved.sessionHistory, updatedAtMs: Math.max(0, legacy.updatedAtMs ?? 0) } };
    } else {
        if (typeof input.session.raw !== 'string') invalid();
        const before = decodeNativePomodoroSession(input.session.raw);
        if (!taskEditValuesEqual(before, input.session.state)) invalid();
        target = targetOf(input.target, before.session.selectedTaskId);
        if (input.deviceId !== null && !identity(input.deviceId, 200)) invalid();
        if (request.action === 'reconcile' && request.observedAtMs < before.session.updatedAtMs) return null;
        const current = resolvePomodoroSession(before.session, request.observedAtMs, request.autoStart, request.localDayKey);
        delta = current.sessionHistory.totalCompletedFocusSessions - before.session.sessionHistory.totalCompletedFocusSessions;
        if (!count(delta)) invalid();
        creditFocusMinutes = before.session.durations.focusMinutes;
        let resolved = current;
        if (request.action === 'setDurations') resolved = { ...current, durations: request.durations,
            timerState: resetPomodoroState(current.timerState, request.durations), phaseEndsAt: undefined, lastEvent: null };
        else if (request.action === 'reset' || request.action === 'switchPhase') resolved = { ...current,
            timerState: resetPomodoroState(current.timerState, current.durations, request.action === 'reset' ? current.timerState.phase
                : current.timerState.phase === 'focus' ? 'break' : 'focus'), phaseEndsAt: undefined, lastEvent: null };
        else if (request.action === 'selectTask') resolved = { ...current, selectedTaskId: request.taskId ?? undefined };
        else if (request.action === 'toggle' && !current.lastEvent) {
            if (current.timerState.isRunning) resolved = { ...current, timerState: { ...current.timerState, isRunning: false },
                phaseEndsAt: undefined, lastEvent: null };
            else {
                const remainingSeconds = Math.max(1, current.timerState.remainingSeconds);
                const endMs = request.observedAtMs + remainingSeconds * 1000;
                if (!time(endMs)) invalid();
                resolved = { ...current, timerState: { ...current.timerState, isRunning: true, remainingSeconds },
                    phaseEndsAt: new Date(endMs).toISOString(), lastEvent: null };
            }
        }
        if (request.action === 'reconcile') {
            // A display countdown alone does not own a SQL transition or generation.
            const structural = { ...serializePomodoroSession(resolved), timerState: { ...resolved.timerState,
                remainingSeconds: before.session.timerState.remainingSeconds } };
            const { updatedAtMs: _mutationClock, ...previous } = before.session;
            if (taskEditValuesEqual(structural, previous)) return null;
        }
        if (before.generation === Number.MAX_SAFE_INTEGER) invalid();
        const updatedAtMs = request.action === 'reconcile' ? request.observedAtMs : Math.max(request.observedAtMs, before.session.updatedAtMs + 1);
        if (!time(updatedAtMs)) invalid();
        after = { version: 1, sessionID: before.sessionID, generation: before.generation + 1,
            session: { ...serializePomodoroSession(resolved), durations: resolved.durations, timerState: resolved.timerState,
                sessionHistory: resolved.sessionHistory, updatedAtMs } };
    }
    // Each task's time as RN's settle would leave it: the owed credits in stored order, then this pass's credit.
    const available = (before: NativePomodoroTaskBefore | null): before is { id: string; row: readonly (string | number | null)[] } =>
        Boolean(before?.row && !cell(before.row, 'deletedAt') && cell(before.row, 'status') !== 'archived');
    const minutesOf = new Map<string, number | null>();
    const minutesFor = (before: { id: string; row: readonly (string | number | null)[] }): number | null => {
        if (!minutesOf.has(before.id)) {
            const rawMinutes = cell(before.row, 'timeSpentMinutes'); const rawRev = cell(before.row, 'rev');
            if ((rawMinutes !== null && typeof rawMinutes !== 'number') || (rawRev !== null && !count(rawRev))) invalid();
            minutesOf.set(before.id, rawMinutes);
        }
        return minutesOf.get(before.id)!;
    };
    for (const credit of legacySource?.pendingCredits ?? []) {
        const before = credit.taskId === target?.id ? target : owedTargets.find((owed) => owed.id === credit.taskId)!;
        // A missing, deleted or archived task drops its credit; a task at any time other than `from` already took it
        // (or was changed since, which wins), as RN's settle does. RN compares its loaded task, where a stored 0 reads as no time.
        if (!available(before)) continue;
        const minutes = minutesFor(before); const from = credit.from ?? undefined;
        if ((minutes ?? undefined) === from || normalizeTimeSpentMinutes(minutes) === from) minutesOf.set(before.id, credit.to);
    }
    // This pass's credit adds to the time the owed credits leave. (RN chains it from the owed `to`, so it drops it
    // too when the task had changed since; native keeps it, as its own credit rule does.)
    if (delta > 0) {
        if (!target) creditDisposition = 'unlinked';
        else if (!available(target)) creditDisposition = 'unavailable';
        else {
            const rawMinutes = minutesFor(target);
            const increment = delta * creditFocusMinutes;
            if (!count(increment)) invalid();
            const oldMinutes = normalizeTimeSpentMinutes(rawMinutes) ?? 0;
            const minutes = addTimeSpentMinutes(rawMinutes, increment) ?? 0;
            creditedMinutes = minutes - oldMinutes;
            if (creditedMinutes === 0) creditDisposition = 'capped';
            else { minutesOf.set(target.id, minutes); creditDisposition = 'credited'; }
        }
    }
    const patchOf = (before: NativePomodoroTaskBefore | null): NativePomodoroTaskPatch | null => {
        if (!available(before) || !minutesOf.has(before.id) || minutesOf.get(before.id) === cell(before.row, 'timeSpentMinutes')) return null;
        if (!identity(input.deviceId, 200)) invalid();
        deviceId = input.deviceId;
        return { timeSpentMinutes: minutesOf.get(before.id)!, rev: nextRevision(cell(before.row, 'rev'), { warn: false }), revBy: deviceId,
            updatedAt: new Date(request.observedAtMs).toISOString() };
    };
    taskPatch = patchOf(target);
    const owed = owedTargets.map((before) => ({ target: before, taskPatch: patchOf(before) }));
    const sessionAfter = JSON.stringify(after);
    decodeNativePomodoroSession(sessionAfter);
    const result: NativePomodoroResult = { sessionID: after.sessionID, generation: after.generation,
        completedFocusSessions: after.session.sessionHistory.totalCompletedFocusSessions, creditedMinutes, creditDisposition };
    const plan: PreparedNativePomodoroTransition = { version: 1, request, sessionBefore: input.session.raw, sessionAfter,
        target, taskPatch, deviceId, result, ...(owed.length > 0 ? { owed } : {}) };
    if (!bounded(JSON.stringify(result), MAX_NATIVE_POMODORO_RESULT_BYTES)
        || !bounded(JSON.stringify(plan), MAX_NATIVE_POMODORO_PLAN_BYTES)
        || !bounded(JSON.stringify(['pomodoroTransition', plan]), MAX_NATIVE_POMODORO_PLAN_BYTES)) invalid();
    return plan;
}

export function validatePreparedNativePomodoroTransition(value: unknown): PreparedNativePomodoroTransition {
    if (!exact(value, ['version', 'request', 'sessionBefore', 'sessionAfter', 'target', 'taskPatch', 'deviceId', 'result'], ['owed'])
        || (Object.prototype.hasOwnProperty.call(value, 'owed') && (!Array.isArray(value.owed)
            || !value.owed.every((entry: unknown) => exact(entry, ['target', 'taskPatch']))))
        || value.version !== 1 || (value.sessionBefore !== null && typeof value.sessionBefore !== 'string')
        || !exact(value.result, ['sessionID', 'generation', 'completedFocusSessions', 'creditedMinutes', 'creditDisposition'])
        || (value.taskPatch !== null && !exact(value.taskPatch, ['timeSpentMinutes', 'rev', 'revBy', 'updatedAt']))) invalid();
    const prepared = prepareNativePomodoroTransition({ request: value.request as NativePomodoroRequest,
        session: value.sessionBefore === null ? { raw: null, state: null } : { raw: value.sessionBefore, state: decodeNativePomodoroSession(value.sessionBefore) },
        target: value.target as NativePomodoroTaskBefore | null,
        owed: ((value.owed ?? []) as NativePomodoroOwedTask[]).map((entry) => entry.target), deviceId: value.deviceId as string | null });
    if (!prepared || !taskEditValuesEqual(value, prepared)) invalid();
    return prepared;
}
export function nativePomodoroReceiptPayload(plan: PreparedNativePomodoroTransition): string {
    return JSON.stringify(['pomodoroTransition', validatePreparedNativePomodoroTransition(plan)]);
}
