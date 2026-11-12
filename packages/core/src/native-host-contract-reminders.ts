


import { loadTranslations } from './i18n/i18n-loader';
import type { Language } from './i18n/i18n-types';
import { logInfo, logWarn } from './logger';
import {
    buildReminderAlarmDetails,
    buildReminderSnooze,
    getActiveCancelReason,
    getReminderAlarmCancelReason,
    isReminderOwnerGone,
    MAX_PENDING_ONE_SHOT_REMINDER_ALARMS,
    planReminderAlarms,
    readReminderAlarmMap,
    writeReminderAlarmMap,
    type ReminderAlarmCancelReason,
    type ReminderAlarmEntry,
    type ReminderAlarmPlan,
} from './mobile-reminder-alarms';
import {
    getReminderCompletionBlocker,
    REMINDER_COMPLETE_UPDATE,
    resolveNotificationOpenRoute,
    type NotificationOpenRoute,
    type ReminderCompletionBlocker,
} from './mobile-notification-open';
import type { NativeHostResult } from './native-host-contract';
import { fail, isObjectRecord, isText } from './native-host-contract-menu-views';
import { createNativeRequestReceipts, runStoreWrite, settleWrite } from './native-request-receipts';
import { exact, record } from './native-host-contract-project-shared';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { useTaskStore } from './store';
import { getDigestSchedule } from './schedule-utils';
import { isTaskReminderSelectionCurrent, shouldSendTaskReminders } from './task-reminder-policy';
import type { NotificationSettings, Project, Task } from './types';

export type NativeReminderAlarm = {
    key: string;

    id: number;
    fireAtMs: number;

    repeat: 'once' | 'daily' | 'weekly';

    calendar?: { hour: number; minute: number; weekday?: number };

    details: Record<string, unknown>;

    replacing: ReminderAlarmCancelReason | null;
};

export type NativeReminderAlarmPlan = {
    mode: ReminderAlarmPlan['mode'];

    cancel: { key: string; id: number; reason: ReminderAlarmCancelReason }[];
    schedule: NativeReminderAlarm[];

    writeAhead: string | null;

    alarms: string;

    state: string;

    topUpDelayMs: number | null;

    clearDelivered: boolean;
};

export type ReminderCompletion = { changed: boolean; outcome: 'completed' | ReminderCompletionBlocker };

type ReminderDeps = {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    language: () => Language;
    requestIdPattern: RegExp;
    reminderPlatform: 'android' | 'ios';
};


const ID_SPAN = 2 ** 30 - 1;
const REMINDER_ID_BASE = 1;
const SNOOZE_ID_BASE = 2 ** 30;
const TASK_ID_LIMIT = 500;
type ReminderCompletionRequest = { requestId: string; taskId: string };
const COMPLETION_UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const completionRequest = (input: unknown): ReminderCompletionRequest | null => {
    if (!isNativeJsonWithinBytes(input, 4096) || !record(input) || !exact(input, ['requestId', 'taskId'])
        || typeof input.requestId !== 'string' || !COMPLETION_UUID.test(input.requestId)
        || !isText(input.taskId, TASK_ID_LIMIT) || !input.taskId) return null;
    return { requestId: input.requestId, taskId: input.taskId };
};
const completionPayload = (request: ReminderCompletionRequest) => JSON.stringify(['reminderComplete', request.taskId]);
const completionResult = (result: NativeHostResult<unknown>): NativeHostResult<ReminderCompletion> => {
    if (!result.ok) return result;
    const value = result.value;
    if (!record(value) || !exact(value, ['changed', 'outcome'])
        || !(value.changed === true && value.outcome === 'completed'
            || value.changed === false && (value.outcome === 'task-not-found'
                || value.outcome === 'task-deleted' || value.outcome === 'not-actionable'))) {
        return fail('INVALID_INPUT', 'Saved reminder completion receipt is malformed');
    }
    return { ok: true, value: value as ReminderCompletion };
};
const unknownCompletion = () => fail('STALE_REVISION', 'Reminder completion is unconfirmed; no changes were replayed');
type ReminderSnoozeRequest = { requestId: string; requestedAt: number; details: Record<string, unknown> };
const snoozeInstant = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value)
    && Math.abs(value) <= 8_640_000_000_000_000;
const snoozeOwner = (value: unknown): value is string => typeof value === 'string'
    && (/^(task|project):.+$/.test(value) || ['digest:morning', 'digest:evening', 'digest:weekly-review'].includes(value));
const snoozeJson = (input: unknown): boolean => {
    const pending = [input], seen = new Set<object>();
    while (pending.length) {
        const value = pending.pop();
        if (value === null || typeof value === 'string' || typeof value === 'boolean'
            || typeof value === 'number' && Number.isFinite(value)) continue;
        if (typeof value !== 'object' || seen.has(value) || !Array.isArray(value)
            && Object.prototype.toString.call(value) !== '[object Object]') return false;
        seen.add(value); pending.push(...Object.values(value));
    }
    return true;
};
const snoozeRequest = (input: unknown): ReminderSnoozeRequest | null => {
    if (!isNativeJsonWithinBytes(input, 65_536) || !record(input) || !exact(input, ['requestId', 'requestedAt', 'details'])
        || typeof input.requestId !== 'string' || !COMPLETION_UUID.test(input.requestId) || !snoozeInstant(input.requestedAt)
        || !record(input.details) || !snoozeJson(input.details) || !isText(input.details.title, 10_000)
        || typeof input.details.message !== 'string' || typeof input.details.tag !== 'string'
        || typeof input.details.play_sound !== 'boolean' || !record(input.details.data)
        || !Object.values(input.details.data).every((value) => typeof value === 'string')
        || !snoozeOwner(input.details.data.alarmKey) || typeof input.details.snooze_interval !== 'number'
        || !Number.isFinite(input.details.snooze_interval) || input.details.snooze_interval <= 0) return null;
    return { requestId: input.requestId, requestedAt: input.requestedAt, details: input.details };
};
const snoozePayload = (request: ReminderSnoozeRequest) => JSON.stringify(['reminderSnooze', request.requestedAt, request.details]);
const unknownSnooze = () => fail('STALE_REVISION', 'Reminder Snooze is unconfirmed; no changes were replayed');


const NATIVE_SIGNATURE_MARK = 'native:';


const readNativeAlarmMap = (raw: string | null): Map<string, ReminderAlarmEntry> => new Map(Array.from(readReminderAlarmMap(raw), ([key, entry]) => {
    const { signature, ...rest } = entry;
    return [key, signature?.startsWith(NATIVE_SIGNATURE_MARK) ? { ...rest, signature: signature.slice(NATIVE_SIGNATURE_MARK.length) } : rest];
}));

const writeNativeAlarmMap = (map: ReadonlyMap<string, ReminderAlarmEntry>): string => writeReminderAlarmMap(new Map(Array.from(map, ([key, entry]) => (
    [key, entry.signature === undefined ? entry : { ...entry, signature: `${NATIVE_SIGNATURE_MARK}${entry.signature}` }]
))));


export const NATIVE_REMINDER_STATE_STORAGE_KEY = 'mindwtr:native:reminders:v1';
const DELIVERED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const SNOOZE_LATE_LIMIT_MS = 24 * 60 * 60 * 1000;


type DeliveredReminder = { kind: 'delivered'; id: number; signature?: string; firedAtMs: number };

type SnoozeReminder = { kind: 'snooze'; id: number; fireAtMs: number; details: Record<string, unknown>; armed: boolean };
type NativeReminderState = Map<string, DeliveredReminder | SnoozeReminder>;


const readNativeReminderState = (raw: string | null | undefined): NativeReminderState => {
    const state: NativeReminderState = new Map();
    if (!raw) return state;
    try {
        for (const [key, entry] of Object.entries(JSON.parse(raw) as Record<string, Record<string, unknown>>)) {
            if (!isObjectRecord(entry) || !Number.isInteger(entry.id)) continue;
            const id = entry.id as number;
            if (entry.kind === 'delivered' && Number.isFinite(entry.firedAtMs)) {
                state.set(key, { kind: 'delivered', id, firedAtMs: entry.firedAtMs as number, ...(typeof entry.signature === 'string' ? { signature: entry.signature } : {}) });
            } else if (entry.kind === 'snooze' && Number.isFinite(entry.fireAtMs) && isObjectRecord(entry.details)) {
                state.set(key, { kind: 'snooze', id, fireAtMs: entry.fireAtMs as number, details: entry.details, armed: entry.armed === true });
            }
        }
    } catch {
        void logWarn('Stored native reminder state unreadable; starting from none', { scope: 'notifications' });
    }
    return state;
};

const writeNativeReminderState = (state: NativeReminderState): string => JSON.stringify(Object.fromEntries(state));

const snoozeAlarm = (key: string, entry: SnoozeReminder): NativeReminderAlarm => (
    { key, id: entry.id, fireAtMs: entry.fireAtMs, repeat: 'once', details: entry.details, replacing: null }
);


const snoozedKey = (entry: SnoozeReminder): string => {
    const data = entry.details.data;
    return isObjectRecord(data) && typeof data.alarmKey === 'string' ? data.alarmKey : '';
};

const isSnoozedTaskSkipped = (entry: SnoozeReminder, tasks: ReadonlyMap<string, Task>, settings: NotificationSettings): boolean => {
    const key = snoozedKey(entry);
    if (!key.startsWith('task:') || !isObjectRecord(entry.details.data)) return false;
    const kind = entry.details.data.kind;

    if (kind !== undefined && kind !== 'task-start' && kind !== 'task-due' && kind !== 'task-due-advance' && kind !== 'task-start-advance' && kind !== 'task-reminder') return false;
    const task = tasks.get(key.slice('task:'.length).replace(/:(?:r\d+|s?a\d+:-?\d+)$/, ''));
    return Boolean(task && (!shouldSendTaskReminders(task, settings) || !isTaskReminderSelectionCurrent(task, entry.details.data, settings)));
};

const signedFireAtMs = (signature: string | undefined): number | null => {
    try {
        const fireAtMs = Date.parse((JSON.parse(signature ?? '') as { fireAt?: string }).fireAt ?? '');
        return Number.isFinite(fireAtMs) ? fireAtMs : null;
    } catch {
        return null;
    }
};


const allocateAlarmId = (key: string, taken: Set<number>, base: number): number => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < key.length; index += 1) {
        hash ^= key.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    let id = base + ((hash >>> 0) % ID_SPAN);
    while (taken.has(id)) id = base + ((id - base + 1) % ID_SPAN);
    return id;
};


const buildNativeReminderSnooze = (input: ReminderSnoozeRequest): NativeReminderAlarm | null => {
    const key = `snooze:${input.requestId.toLowerCase()}`;
    const snooze = buildReminderSnooze(input.details, input.requestedAt, key);
    return snooze ? { ...snooze, id: allocateAlarmId(key, new Set(), SNOOZE_ID_BASE), repeat: 'once', replacing: null } : null;
};
const previewSnooze = (input: unknown): NativeHostResult<NativeReminderAlarm> => {
    const request = snoozeRequest(input), alarm = request && buildNativeReminderSnooze(request);
    return alarm && snoozeInstant(alarm.fireAtMs) ? { ok: true, value: alarm }
        : fail('INVALID_INPUT', 'A bounded reminder Snooze request is required');
};
const snoozeResult = (result: NativeHostResult<unknown>, expected: NativeReminderAlarm): NativeHostResult<NativeReminderAlarm> => {
    if (!result.ok) return result;
    const value = result.value;
    if (!record(value) || !exact(value, ['key', 'id', 'fireAtMs', 'repeat', 'details', 'replacing'])
        || value.key !== expected.key || value.id !== expected.id || value.fireAtMs !== expected.fireAtMs
        || value.repeat !== 'once' || value.replacing !== null || !snoozeJson(value.details) || !isNativeJsonWithinBytes(value.details, 65_536)
        || JSON.stringify(value.details) !== JSON.stringify(expected.details)) {
        return fail('INVALID_INPUT', 'Saved reminder Snooze receipt is malformed');
    }
    return { ok: true, value: expected };
};

export function createReminderMethods(deps: ReminderDeps) {
    const receipts = createNativeRequestReceipts({
        save: async () => {
            if (useTaskStore.getState().persistenceFailure) {
                try {
                    await useTaskStore.getState().retryPersistence();
                } catch (error) {
                    return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error));
                }
            }
            return deps.save();
        },
    });
    let taskOpenSequence = 0;

    const methods = {

        async planReminderAlarms(input: {
            storedAlarms: string | null;
            permissionGranted: boolean;
            storedState?: string | null;
            remake?: 'all' | string[];

            fired?: number[];
            shown?: number[];
        }): Promise<NativeHostResult<NativeReminderAlarmPlan>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || (input.storedAlarms !== null && typeof input.storedAlarms !== 'string') || typeof input.permissionGranted !== 'boolean'
                || (input.storedState != null && typeof input.storedState !== 'string')
                || (input.remake !== undefined && input.remake !== 'all' && !(Array.isArray(input.remake) && input.remake.every((key) => typeof key === 'string')))
                || [input.fired, input.shown].some((ids) => ids !== undefined && !(Array.isArray(ids) && ids.every(Number.isInteger)))) {
                return fail('INVALID_INPUT', 'The stored alarm map (a string or null) and the notification permission are required');
            }
            let held: Map<string, ReminderAlarmEntry>;
            try {
                held = readNativeAlarmMap(input.storedAlarms);
            } catch {

                void logWarn('Stored reminder alarm map unreadable; starting from none', { scope: 'notifications' });
                held = new Map();
            }
            const remakeAll = input.remake === 'all';
            const remake = remakeAll ? new Set(held.keys()) : new Set(input.remake ?? []);
            for (const key of remake) {
                const entry = held.get(key);
                if (entry) held.set(key, { ...entry, pending: true });
            }

            const translations = await loadTranslations(deps.language());
            const state = useTaskStore.getState();
            const digest = deps.reminderPlatform === 'ios' ? getDigestSchedule(state.settings) : null;
            const storedState = readNativeReminderState(input.storedState);


            const snoozeSlots = deps.reminderPlatform === 'ios' ? [...storedState.values()].filter((entry) =>
                entry.kind === 'snooze' && (entry.fireAtMs > Date.now() || !entry.armed)).length : 0;
            if (snoozeSlots > 0) logInfo('Native iOS reminder one-shot cap reduced for Snoozes', { scope: 'notifications',
                context: { releaseCheck: 'v1.3.7/ios-reminder-snooze-capacity', count: snoozeSlots } });
            const plan = planReminderAlarms({
                settings: state.settings,
                tasks: state.tasks,
                projects: state.projects,
                now: new Date(),
                translations,
                maxOneShotReminders: Math.max(0, MAX_PENDING_ONE_SHOT_REMINDER_ALARMS[deps.reminderPlatform] - snoozeSlots),
                alarms: held,
                permissionGranted: input.permissionGranted,
            });
            const selectiveCount = plan.oneShot.filter(request => request.config.data?.reminderSelection).length;
            if (selectiveCount > 0) logInfo('Selective task reminders planned', { scope: 'notifications',
                context: { releaseCheck: 'v1.3.9/selective-task-reminder', outcome: 'planned', count: selectiveCount } });
            const requests = new Map([...plan.recurring, ...plan.oneShot].map((request) => [request.key, request]));
            const nowMs = Date.now();


            let taskById: Map<string, Task> | null = null;
            let projectById: Map<string, Project> | null = null;
            const tasksById = () => taskById ??= new Map(state.tasks.map((task) => [task.id, task]));
            const projectsById = () => projectById ??= new Map(state.projects.map((project) => [project.id, project]));
            const judge = plan.mode === 'active'
                ? { settings: state.settings, diagnostics: plan.diagnostics, get tasks() { return tasksById(); }, get projects() { return projectsById(); } }
                : null;
            const remembered: NativeReminderState = new Map();
            const withdrawnDelivered: NativeReminderAlarmPlan['cancel'] = [];
            const snoozes: NativeReminderAlarm[] = [];
            const owners = { get tasks() { return tasksById(); }, get projects() { return projectsById(); } };

            const fired = new Set(input.fired ?? []);
            const shown = input.shown ? new Set(input.shown) : null;
            const stillShown = (id: number, sinceMs: number) => (shown ? shown.has(id) : nowMs - sinceMs <= DELIVERED_RETENTION_MS);
            for (const [key, entry] of storedState) {
                if (entry.kind === 'snooze') {
                    const late = entry.fireAtMs < nowMs - SNOOZE_LATE_LIMIT_MS;
                    if (plan.mode === 'revoked' || isReminderOwnerGone(snoozedKey(entry), owners.tasks, owners.projects)
                        || isSnoozedTaskSkipped(entry, owners.tasks, state.settings)) {
                        withdrawnDelivered.push({ key, id: entry.id, reason: 'withdrawn' });
                    } else if (fired.has(entry.id)) {

                        if (stillShown(entry.id, entry.fireAtMs)) remembered.set(key, { ...entry, armed: true });
                        else withdrawnDelivered.push({ key, id: entry.id, reason: 'expired' });
                    } else if (late && (!entry.armed || input.fired)) {

                        withdrawnDelivered.push({ key, id: entry.id, reason: 'expired' });
                    } else if (entry.fireAtMs >= nowMs - DELIVERED_RETENTION_MS) {


                        const missed = Boolean(input.fired) && entry.fireAtMs <= nowMs;
                        if (!entry.armed || (remakeAll && (entry.fireAtMs > nowMs || missed))
                            || (remake.has(key) && entry.fireAtMs > nowMs)) snoozes.push(snoozeAlarm(key, entry));
                        remembered.set(key, { ...entry, armed: true });
                    }
                    continue;
                }
                if (!stillShown(entry.id, entry.firedAtMs)) continue;
                if (!judge || getActiveCancelReason(key, entry, false, judge) === 'withdrawn') withdrawnDelivered.push({ key, id: entry.id, reason: 'withdrawn' });
                else remembered.set(key, entry);
            }
            const taken = new Set([...held.values(), ...remembered.values()].map((entry) => entry.id));
            const next = new Map(held);
            const writeAhead = new Map(held);
            const schedule: NativeReminderAlarm[] = [];
            for (const key of plan.schedule) {
                const request = requests.get(key);
                if (!request) continue;
                const heldEntry = held.get(key);
                const id = heldEntry?.id ?? allocateAlarmId(key, taken, REMINDER_ID_BASE);
                taken.add(id);
                const fireAt = new Date(request.config.fireAt);
                fireAt.setMilliseconds(0);
                const slot = digest && (key === 'digest:morning' ? digest.morning
                    : key === 'digest:evening' ? digest.evening : key === 'digest:weekly-review' ? digest.weekly : null);
                const calendar = digest && slot ? { hour: slot.hour, minute: slot.minute,
                    ...(key === 'digest:weekly-review' ? { weekday: digest.weekly.day } : {}) } : null;
                schedule.push({
                    key,
                    id,
                    fireAtMs: fireAt.getTime(),
                    repeat: request.config.repeatInterval ?? 'once',
                    ...(calendar ? { calendar } : {}),
                    details: buildReminderAlarmDetails(key, request.config),
                    replacing: heldEntry ? getReminderAlarmCancelReason(plan, key) : null,
                });
                next.set(key, { id, signature: request.signature });
                writeAhead.set(key, { id, signature: heldEntry ? heldEntry.signature : request.signature, pending: true });
            }
            const cancel = plan.cancel.flatMap((key) => {
                const entry = held.get(key);
                next.delete(key);
                if (!entry) return [];
                const reason = getReminderAlarmCancelReason(plan, key);
                if (reason === 'expired' && (key.startsWith('task:') || key.startsWith('project:')) && (!shown || shown.has(entry.id))) {
                    remembered.set(key, { kind: 'delivered', id: entry.id, ...(entry.signature ? { signature: entry.signature } : {}), firedAtMs: signedFireAtMs(entry.signature) ?? nowMs });
                }
                return [{ key, id: entry.id, reason }];
            });
            if (state.settings.taskReminderDefault || state.tasks.some((task) => task.reminderPolicy)) {
                logInfo('Task reminder policy planned', { scope: 'notifications',
                    context: { releaseCheck: 'v1.3.7/task-reminder-policy', outcome: 'planned' } });
            }
            const advanceScheduled = schedule.filter((alarm) => /^task:.+:s?a\d+:-?\d+$/.test(alarm.key)).length;
            if (deps.reminderPlatform === 'ios' && advanceScheduled > 0) logInfo('Native iOS advance reminders scheduled', { scope: 'notifications',
                context: { releaseCheck: 'v1.3.9/ios-advance-reminders', outcome: 'scheduled', count: advanceScheduled } });
            return {
                ok: true,
                value: {
                    mode: plan.mode,
                    cancel: [...cancel, ...withdrawnDelivered],
                    schedule: [...schedule, ...snoozes],
                    writeAhead: schedule.length > 0 ? writeNativeAlarmMap(writeAhead) : null,
                    alarms: writeNativeAlarmMap(next),
                    state: writeNativeReminderState(remembered),
                    topUpDelayMs: plan.topUpDelayMs,
                    clearDelivered: plan.mode === 'revoked',
                },
            };
        },


        async completeReminderTask(input: { requestId: string; taskId: string }): Promise<NativeHostResult<ReminderCompletion>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !isText(input.taskId, TASK_ID_LIMIT) || !input.taskId) {
                return fail('INVALID_INPUT', 'A request UUID and a task ID are required');
            }
            const taskId = input.taskId;
            return receipts.run<ReminderCompletion>(input.requestId, JSON.stringify(['reminderComplete', taskId]), async () => {
                const blocker = getReminderCompletionBlocker(useTaskStore.getState()._tasksById.get(taskId));
                if (blocker) return { ok: true, value: { changed: false, outcome: blocker } };
                const written = await runStoreWrite(() => useTaskStore.getState().updateTask(taskId, { ...REMINDER_COMPLETE_UPDATE }));
                return settleWrite<ReminderCompletion>(written, { changed: true, outcome: 'completed' });
            });
        },


        async snoozeReminder(input: { requestId: string; requestedAt: number; details: Record<string, unknown> }): Promise<NativeHostResult<NativeReminderAlarm>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || typeof input.requestId !== 'string' || !deps.requestIdPattern.test(input.requestId)
                || typeof input.requestedAt !== 'number' || !isObjectRecord(input.details) || !isText(input.details.title, 10_000)) {
                return fail('INVALID_INPUT', 'A request UUID, the tap time and the fired alarm\'s details are required');
            }
            const alarm = buildNativeReminderSnooze(input);
            if (!alarm) return fail('INVALID_INPUT', 'This reminder has no Snooze');
            return receipts.run<NativeReminderAlarm>(input.requestId, JSON.stringify(['reminderSnooze', input.requestedAt, input.details]), async () => (
                { ok: true, value: alarm }
            ));
        },


        planReminderSnooze(input: { storedState: string | null; alarm: NativeReminderAlarm; permissionGranted: boolean; fired?: number[] }): NativeHostResult<{
            schedule: NativeReminderAlarm[];
            stateAhead: string | null;
            state: string | null;
        }> {
            if (!isObjectRecord(input) || (input.storedState !== null && typeof input.storedState !== 'string') || !isObjectRecord(input.alarm)
                || typeof input.alarm.key !== 'string' || !input.alarm.key.startsWith('snooze:') || !Number.isInteger(input.alarm.id)
                || !Number.isFinite(input.alarm.fireAtMs) || !isObjectRecord(input.alarm.details) || typeof input.permissionGranted !== 'boolean') {
                return fail('INVALID_INPUT', 'The stored native state (a string or null) and a Snooze\'s alarm are required');
            }
            const { key, id, fireAtMs, details } = input.alarm;
            const state = readNativeReminderState(input.storedState);
            const held = state.get(key);
            const nothing = { ok: true as const, value: { schedule: [], stateAhead: null, state: null } };
            if (held?.kind === 'snooze' && held.armed) return nothing;
            const entry: SnoozeReminder = { kind: 'snooze', id, fireAtMs, details, armed: false };

            const { tasks, projects, settings } = useTaskStore.getState();
            const tasksById = new Map(tasks.map((task) => [task.id, task]));
            if (!input.permissionGranted || isReminderOwnerGone(snoozedKey(entry), tasksById,
                new Map(projects.map((project) => [project.id, project]))) || isSnoozedTaskSkipped(entry, tasksById, settings)) return nothing;

            if (held?.kind === 'snooze' && input.fired?.includes(id)) {
                return { ok: true, value: { schedule: [], stateAhead: null, state: writeNativeReminderState(new Map(state).set(key, { ...entry, armed: true })) } };
            }
            const stateAhead = writeNativeReminderState(new Map(state).set(key, entry));
            return { ok: true, value: { schedule: [snoozeAlarm(key, entry)], stateAhead, state: writeNativeReminderState(new Map(state).set(key, { ...entry, armed: true })) } };
        },


        routeNotificationOpen(payload: Record<string, unknown>): NativeHostResult<NotificationOpenRoute> {
            if (!isObjectRecord(payload)) return fail('INVALID_INPUT', 'A notification payload object is required');
            return {
                ok: true,
                value: resolveNotificationOpenRoute(payload, {
                    now: () => Date.now(),
                    nextTaskOpenSequence: () => {
                        taskOpenSequence += 1;
                        return taskOpenSequence;
                    },
                }),
            };
        },
    };
    const savedCompletion = (request: ReminderCompletionRequest): NativeHostResult<ReminderCompletion> | null => {
        const saved = receipts.saved<unknown>(request.requestId, completionPayload(request));
        return saved ? completionResult(saved) : null;
    };
    const savedSnooze = (request: ReminderSnoozeRequest, expected: NativeReminderAlarm): NativeHostResult<NativeReminderAlarm> | null => {
        const saved = receipts.saved<unknown>(request.requestId, snoozePayload(request));
        return saved ? snoozeResult(saved, expected) : null;
    };
    return {
        ...methods,

        previewReminderSnooze: previewSnooze,
        async commitReminderSnooze(input: unknown): Promise<NativeHostResult<NativeReminderAlarm>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const expected = previewSnooze(input); if (!expected.ok) return expected;
            const request = snoozeRequest(input)!;
            return savedSnooze(request, expected.value) ?? snoozeResult(await methods.snoozeReminder(request), expected.value);
        },
        probeReminderSnoozeOutcome(input: unknown): NativeHostResult<NativeReminderAlarm> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const expected = previewSnooze(input); if (!expected.ok) return expected;
            return savedSnooze(snoozeRequest(input)!, expected.value) ?? unknownSnooze();
        },
        async retryReminderSnooze(input: unknown): Promise<NativeHostResult<NativeReminderAlarm>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const expected = previewSnooze(input); if (!expected.ok) return expected;
            const request = snoozeRequest(input)!;
            return savedSnooze(request, expected.value) ?? snoozeResult(await receipts.run<NativeReminderAlarm>(
                request.requestId, snoozePayload(request), async () => unknownSnooze()), expected.value);
        },

        async commitReminderCompletion(input: unknown): Promise<NativeHostResult<ReminderCompletion>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const request = completionRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded reminder completion request is required');
            return savedCompletion(request) ?? completionResult(await methods.completeReminderTask(request));
        },

        probeReminderCompletionOutcome(input: unknown): NativeHostResult<ReminderCompletion> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const request = completionRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded reminder completion request is required');
            return savedCompletion(request) ?? unknownCompletion();
        },

        async retryReminderCompletion(input: unknown): Promise<NativeHostResult<ReminderCompletion>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const request = completionRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded reminder completion request is required');
            return savedCompletion(request) ?? completionResult(await receipts.run<ReminderCompletion>(
                request.requestId, completionPayload(request), async () => unknownCompletion()));
        },
    };
}
