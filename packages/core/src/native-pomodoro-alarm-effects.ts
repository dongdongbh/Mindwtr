import { isExplicitPomodoroAlarmCancellation, isPomodoroAlarmDue, isPomodoroAlarmImmediate,
    isPomodoroAlarmUnchanged } from './mobile-reminder-alarms';
import type { buildNativePomodoroAlarmIntent } from './native-pomodoro-alarm';

type Intent = ReturnType<typeof buildNativePomodoroAlarmIntent>;
type Identity = { sessionID: string; phase: 'focus' | 'break'; fireAtMs: number };
export type NativePomodoroAlarmObservation = Identity & { identifier: string; scope: string };
type Receipt = Identity & { immediate: boolean; status: 'attempted' | 'confirmed' };
type Library = { scope: string; alarm: Receipt | null };
type State = { version: 1; libraries: Library[] };

const invalid = (): never => { throw new Error('NOT_READY: Pomodoro alarm ownership is unavailable'); };
const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, fields: string[]) =>
    Object.keys(value).length === fields.length && fields.every((name) => Object.prototype.hasOwnProperty.call(value, name));
const instant = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)
    && Math.abs(value) <= 8_640_000_000_000_000;
const scopeValid = (value: unknown): value is string => typeof value === 'string'
    && /^[a-zA-Z0-9._-]{1,255}:[a-f0-9]{64}$/.test(value);
const identityValid = (value: Record<string, unknown>): boolean => typeof value.sessionID === 'string'
    && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.sessionID)
    && (value.phase === 'focus' || value.phase === 'break') && instant(value.fireAtMs);
const same = (a: Identity | null, b: Identity) => a !== null && a.sessionID === b.sessionID
    && isPomodoroAlarmUnchanged(a, b.fireAtMs, b.phase);
const encoded = (state: State) => JSON.stringify(state);

/** Native checks duplicate JSON members and retains exact raw bytes for the private CAS. */
function readState(raw: string | null): State {
    if (raw === null) return { version: 1, libraries: [] };
    if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > 1024 * 1024) return invalid();
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return invalid(); }
    if (!record(value) || !exact(value, ['version', 'libraries']) || value.version !== 1
        || !Array.isArray(value.libraries) || value.libraries.length > 64) return invalid();
    const scopes = new Set<string>();
    for (const library of value.libraries) {
        if (!record(library) || !exact(library, ['scope', 'alarm']) || !scopeValid(library.scope)
            || scopes.has(library.scope)) return invalid();
        scopes.add(library.scope);
        const alarm = library.alarm;
        if (alarm !== null && (!record(alarm) || !exact(alarm, ['sessionID', 'phase', 'fireAtMs', 'immediate', 'status'])
            || !identityValid(alarm) || typeof alarm.immediate !== 'boolean'
            || (alarm.status !== 'attempted' && alarm.status !== 'confirmed'))) return invalid();
    }
    return value as State;
}

function observations(value: unknown): NativePomodoroAlarmObservation[] {
    if (!Array.isArray(value) || value.length > 4096) return invalid();
    const identifiers = new Set<string>();
    for (const entry of value) {
        if (!record(entry) || !exact(entry, ['identifier', 'scope', 'sessionID', 'phase', 'fireAtMs'])
            || !identityValid(entry) || !scopeValid(entry.scope) || typeof entry.identifier !== 'string'
            || !/^mindwtr-native-pomodoro:[a-f0-9]{64}$/.test(entry.identifier) || identifiers.has(entry.identifier)) return invalid();
        identifiers.add(entry.identifier);
    }
    return value as NativePomodoroAlarmObservation[];
}

/** No OS effects: native publishes each exact state before advancing to the corresponding effect. */
export function planNativePomodoroAlarmEffects(input: {
    intent: Intent; granted: boolean; raw: string | null; scope: string;
    pending: unknown; delivered: unknown; nowMs: number;
}) {
    if (!scopeValid(input.scope) || typeof input.granted !== 'boolean' || !instant(input.nowMs)) return invalid();
    const state = readState(input.raw), pending = observations(input.pending), delivered = observations(input.delivered);
    const all = new Map<string, NativePomodoroAlarmObservation>();
    for (const observation of [...pending, ...delivered]) {
        const prior = all.get(observation.identifier);
        if (prior && (prior.scope !== observation.scope || !same(prior, observation))) return invalid();
        all.set(observation.identifier, observation);
    }
    const unchanged = (outcome: 'uninitialized' | 'retained') => ({
        writeAhead: input.raw, published: input.raw, after: input.raw, schedule: null,
        cancelPending: [] as NativePomodoroAlarmObservation[], cancelDelivered: [] as NativePomodoroAlarmObservation[], outcome,
    });
    const { intent } = input;
    if (input.granted && intent.kind === 'uninitialized') return unchanged('uninitialized');
    const scopes = new Set([input.scope, ...state.libraries.map((library) => library.scope)]);
    const ownedPending = pending.filter((entry) => scopes.has(entry.scope));
    const ownedDelivered = delivered.filter((entry) => scopes.has(entry.scope));
    let library = state.libraries.find((entry) => entry.scope === input.scope);
    const prior = library?.alarm ?? null;
    const explicit = !input.granted || intent.kind === 'cancel' && isExplicitPomodoroAlarmCancellation(intent.reason);
    let schedule: Extract<Intent, { kind: 'schedule' }> | null = null;
    let next: Receipt | null = prior;
    let outcome: 'scheduled' | 'retained' | 'cancelled' | 'uncertain' = 'retained';
    if (explicit) { next = null; outcome = 'cancelled'; }
    else if (intent.kind === 'schedule') {
        const found = [...ownedPending, ...ownedDelivered].some((entry) => entry.scope === input.scope && same(entry, intent));
        const held = same(prior, intent);
        const attemptedNearDeadline = held && (prior!.immediate || isPomodoroAlarmImmediate(intent.fireAtMs, input.nowMs));
        if (found) {
            next = { sessionID: intent.sessionID, phase: intent.phase, fireAtMs: intent.fireAtMs,
                immediate: held ? prior!.immediate : intent.immediate, status: 'confirmed' };
        } else if (attemptedNearDeadline) {
            // An empty tray can mean dismissal or a crash after add; neither authorizes a second immediate attempt.
            outcome = prior!.status === 'attempted' ? 'uncertain' : 'retained';
        } else {
            schedule = { ...intent, observedAtMs: input.nowMs, immediate: isPomodoroAlarmImmediate(intent.fireAtMs, input.nowMs) };
            next = { sessionID: intent.sessionID, phase: intent.phase, fireAtMs: intent.fireAtMs,
                immediate: schedule.immediate, status: 'attempted' };
            outcome = 'scheduled';
        }
    } else if (intent.kind === 'cancel' && prior && !isPomodoroAlarmDue(prior, input.nowMs)) {
        next = null;
    }
    const remove = (entry: NativePomodoroAlarmObservation) => {
        if (entry.scope !== input.scope || explicit) return true;
        if (intent.kind === 'schedule' && same(entry, intent)) return false;
        return !isPomodoroAlarmDue(entry, input.nowMs);
    };
    const cancelPending = ownedPending.filter(remove), cancelDelivered = ownedDelivered.filter(remove);
    if (!schedule && next === null && input.raw === null && cancelPending.length === 0 && cancelDelivered.length === 0)
        return unchanged('retained');
    if (!library) {
        if (state.libraries.length >= 64) return invalid();
        library = { scope: input.scope, alarm: null }; state.libraries.push(library);
    }
    library.alarm = next;
    const writeAhead = encoded(state);
    if (schedule) library.alarm = { ...next!, status: 'confirmed' };
    // Retired scopes remain discoverable until native verifies their pending/delivered inventory is absent.
    const published = encoded(state), after = encoded({ version: 1, libraries: [library] });
    if (!schedule && outcome === 'retained' && (cancelPending.length || cancelDelivered.length)) outcome = 'cancelled';
    return { writeAhead, published, after, schedule, cancelPending, cancelDelivered, outcome };
}

/** Refresh only the same owner's unpublished SDK attempt after its durable write-ahead has settled. */
export function prepareNativePomodoroAlarmDispatch(input: {
    intent: Intent; attempt: unknown; raw: string | null; scope: string;
}) {
    const state = readState(input.raw), { intent, attempt } = input;
    if (!scopeValid(input.scope) || !record(attempt) || !identityValid(attempt)
        || intent.kind !== 'schedule' || !same(attempt as Identity, intent)) return invalid();
    const library = state.libraries.find((entry) => entry.scope === input.scope), receipt = library?.alarm;
    if (!library || !receipt || receipt.status !== 'attempted' || !same(receipt, intent)
        || receipt.immediate && !intent.immediate) return invalid();
    // Once an immediate fence is durable, a clock rollback cannot reopen a future dispatch.
    library.alarm = { ...receipt, immediate: intent.immediate };
    const writeAhead = receipt.immediate === intent.immediate && input.raw !== null ? input.raw : encoded(state);
    library.alarm = { ...library.alarm, status: 'confirmed' };
    return { schedule: intent, writeAhead, published: encoded(state) };
}
