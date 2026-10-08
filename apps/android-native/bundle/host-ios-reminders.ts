import type { NativeReminderAlarmPlan } from '../../../packages/core/src/native-host-contract-reminders';

const unavailable = () => new Error('NOT_READY: Reminder reconciliation is unavailable');
const ordinaryLimit = 2 ** 30;
const names = ['mindwtr:local:alarms:v1', 'mindwtr:native:reminders:v1'];
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, required: string[], optional: string[] = []) =>
    required.every((name) => Object.hasOwn(value, name)) && Object.keys(value).every((name) => required.includes(name) || optional.includes(name));
const id = (value: unknown, snooze = false): value is number => Number.isInteger(value)
    && Number(value) >= (snooze ? ordinaryLimit : 1) && Number(value) < (snooze ? 2 ** 31 : ordinaryLimit);
const ordinary = (value: string) => /^(task|project):.+$/.test(value)
    || ['digest:morning', 'digest:evening', 'digest:weekly-review'].includes(value);
const snooze = (value: string) => /^snooze:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const textMap = (value: unknown): value is Record<string, string> => record(value) && Object.values(value).every((entry) => typeof entry === 'string');
const instant = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && Math.abs(value) <= 8_640_000_000_000_000;
const signedTime = (value: string, repeat: unknown) => {
    if (repeat === 'daily' || repeat === 'weekly') {
        return (repeat === 'daily' ? /^daily:([01][0-9]|2[0-3]):[0-5][0-9]$/ : /^weekly:[0-6]:([01][0-9]|2[0-3]):[0-5][0-9]$/).test(value);
    }
    const milliseconds = Date.parse(value);
    return repeat === 'once' && Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
};
const signature = (value: unknown, marked: boolean) => {
    if (typeof value !== 'string' || (marked && !value.startsWith('native:'))) return false;
    try {
        const raw: unknown = JSON.parse(marked ? value.slice(7) : value);
        return record(raw) && exact(raw, ['title', 'message', 'fireAt', 'repeatInterval', 'hasSnoozeAction', 'data'], ['hasCompleteAction'])
            && typeof raw.title === 'string' && typeof raw.message === 'string' && typeof raw.fireAt === 'string'
            && ['once', 'daily', 'weekly'].includes(String(raw.repeatInterval)) && typeof raw.hasSnoozeAction === 'boolean'
            && signedTime(raw.fireAt, raw.repeatInterval)
            && (!Object.hasOwn(raw, 'hasCompleteAction') || raw.hasCompleteAction === true) && textMap(raw.data);
    } catch { return false; }
};
const parsed = (raw: string | null) => {
    if (raw === null) return {};
    if (typeof raw !== 'string' || raw.length > 1024 * 1024) throw unavailable();
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw unavailable(); }
    if (!record(value)) throw unavailable();
    return value;
};

/** Strict effects admission, separate from the shared deliberately permissive preview parser. */
export function readOwnedIosReminderMaps(alarms: string | null, state: string | null) {
    const map = parsed(alarms), native = parsed(state), taken = new Map<number, string>();
    for (const [name, entry] of Object.entries(map)) {
        if (!ordinary(name) || !record(entry) || !exact(entry, ['id', 'signature'], ['pending']) || !id(entry.id)
            || !signature(entry.signature, true) || Object.hasOwn(entry, 'pending') && entry.pending !== true
            || taken.has(entry.id)) throw unavailable();
        taken.set(entry.id, name);
    }
    for (const [name, entry] of Object.entries(native)) {
        if (!record(entry) || taken.has(Number(entry.id)) && taken.get(Number(entry.id)) !== name) throw unavailable();
        if (entry.kind === 'delivered') {
            if (!ordinary(name) || !exact(entry, ['kind', 'id', 'firedAtMs'], ['signature']) || !id(entry.id)
                || !instant(entry.firedAtMs) || Object.hasOwn(entry, 'signature') && !signature(entry.signature, false)) throw unavailable();
        } else if (entry.kind === 'snooze') {
            if (!snooze(name) || !exact(entry, ['kind', 'id', 'fireAtMs', 'details', 'armed']) || !id(entry.id, true)
                || !instant(entry.fireAtMs) || typeof entry.armed !== 'boolean' || !record(entry.details)
                || typeof entry.details.title !== 'string' || typeof entry.details.message !== 'string'
                || typeof entry.details.tag !== 'string' || typeof entry.details.play_sound !== 'boolean'
                || !textMap(entry.details.data) || !ordinary(entry.details.data.alarmKey ?? '')) throw unavailable();
        } else { throw unavailable(); }
        taken.set(Number(entry.id), name);
    }
    return { map, state: native };
}

type PlanInput = { storedAlarms: string | null; storedState: string | null; permissionGranted: boolean;
    remake: string[]; fired: number[]; shown: number[] };
type Dependencies = {
    capture: () => () => void;
    read: () => Promise<[string, string | null][]>;
    plan: (input: PlanInput) => Promise<{ ok: true; value: NativeReminderAlarmPlan } | { ok: false }>;
    acknowledged: (mode: string, scheduled: number, cancelled: number) => Promise<void>;
};

/** Only the native no-argument facade supplies observations and owns the map CAS/effects. */
export function createIosReminderMethods(deps: Dependencies) {
    let owner: { token: string; current: () => void } | null = null;
    const current = (token: string) => {
        if (!owner || owner.token !== token) throw unavailable();
        owner.current();
    };
    const observations = (raw: string) => {
        let values: unknown;
        try { values = JSON.parse(raw); } catch { throw unavailable(); }
        if (!Array.isArray(values) || values.length > 4096 || !values.every((value) => id(value) || id(value, true))
            || new Set(values).size !== values.length) throw unavailable();
        return values as number[];
    };
    return {
        begin(token: string) {
            if (owner || typeof token !== 'string' || !/^[0-9a-f-]{36}$/.test(token)) throw unavailable();
            const check = deps.capture(); check(); owner = { token, current: check }; return null;
        },
        current(token: string) { current(token); return null; },
        end(token: string) { if (owner?.token === token) owner = null; return null; },
        async prepare(token: string, granted: boolean, pendingJSON: string, deliveredJSON: string) {
            current(token);
            if (typeof granted !== 'boolean') throw unavailable();
            const pending = new Set(observations(pendingJSON)), delivered = observations(deliveredJSON), shown = new Set(delivered);
            const values = await deps.read().catch(() => { throw unavailable(); }); current(token);
            if (!Array.isArray(values) || values.length !== 2 || values.some((entry, index) => !Array.isArray(entry)
                || entry.length !== 2 || entry[0] !== names[index] || entry[1] !== null && typeof entry[1] !== 'string')) throw unavailable();
            const storedAlarms = values[0][1], storedState = values[1][1];
            const owned = readOwnedIosReminderMaps(storedAlarms, storedState);
            // Repeating UN requests persist. Remake only ordinary IDs proved missing, never infer that they fired.
            const remake = Object.entries(owned.map).filter(([, entry]) => record(entry)
                && !pending.has(Number(entry.id))).map(([name]) => name);
            // The current shared API cannot selectively rearm a missing future armed Snooze.
            if (granted && Object.values(owned.state).some((entry) => record(entry) && entry.kind === 'snooze' && entry.armed === true
                && Number(entry.fireAtMs) > Date.now() && !pending.has(Number(entry.id)) && !shown.has(Number(entry.id)))) throw unavailable();
            const result = await deps.plan({ storedAlarms, storedState, permissionGranted: granted, remake, fired: delivered, shown: delivered })
                .catch(() => { throw unavailable(); });
            current(token);
            if (!result.ok) throw unavailable();
            readOwnedIosReminderMaps(result.value.alarms, result.value.state);
            if (result.value.writeAhead !== null) readOwnedIosReminderMaps(result.value.writeAhead, storedState);
            return { storedAlarms, storedState, plan: result.value };
        },
        async acknowledge(token: string, mode: string, scheduled: number, cancelled: number) {
            current(token);
            if (!['active', 'inactive', 'revoked'].includes(mode) || !Number.isInteger(scheduled) || scheduled < 0 || scheduled > 64
                || !Number.isInteger(cancelled) || cancelled < 0 || cancelled > 4096) throw unavailable();
            try { await deps.acknowledged(mode, scheduled, cancelled); } catch { /* Confirmed persistence survives logging failure. */ }
            return null;
        },
    };
}
