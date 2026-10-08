/**
 * Reminder alarms on the Android host: core's planner (native-host-contract-reminders.ts) and core's timers, run in the engine as
 * React Native's lib/notification-service-local.ts runs them; Kotlin (Reminders.kt) only applies each plan and reads the
 * notification permission. Every rule is core's:
 *
 * - a cycle plans against the stored alarm map (RN's key in RN's RKStorage) and the permission, and Kotlin applies the plan in
 *   core's order (writeAhead, cancels, alarms, then the map); cycles run one at a time, as RN's queue runs them;
 * - a store change that shouldRescheduleReminderAlarms accepts plans again REMINDER_STORE_RESCHEDULE_DELAY_MS after the last
 *   one (one store subscription; no polling), the capped one-shot window tops up after the plan's topUpDelayMs, and a tap on a
 *   task's or project's notification plans again after REMINDER_NOTIFICATION_EVENT_RESCHEDULE_DELAY_MS;
 * - a rebuild (a reboot dropped every alarm, a clock change, Android just allowed exact alarms) plans with core's `remake: 'all'`:
 *   core makes each held alarm and each Snooze still ahead again under its own id, which replaces it, and keeps or withdraws what
 *   it delivered by core's reason. The process's first plan is a rebuild too: Android drops every exact alarm when the user revokes
 *   exact-alarm access (it stops the app) and every alarm on a force-stop, while the stored map still says each is held;
 * - a daily or weekly alarm that fired is made again by core's plan (`remake: [key]`), at the next time core's schedule gives;
 * - a Snooze's alarm is made in the same queue, against the native state core keeps for it (planReminderSnooze), once per request;
 * - React Native's own alarms are cancelled once (Kotlin's RnAlarmCleanup) before this host's first plan;
 * - none of this runs in sandbox mode, as RN's notification service does not.
 */
import {
    REMINDER_NOTIFICATION_CHANNEL_NAME,
    REMINDER_NOTIFICATION_EVENT_RESCHEDULE_DELAY_MS,
    REMINDER_STORE_RESCHEDULE_DELAY_MS,
    hasActiveMobileNotificationFeature,
    isSandboxMode,
    logInfo,
    logWarn,
    nameNotifyListener,
    shouldRescheduleReminderAlarms,
    useTaskStore,
    type NativeHostResult,
} from '@mindwtr/core';
import type { NativeReminderAlarm } from '../../../packages/core/src/native-host-contract-reminders';

type ReminderPlan = {
    mode: 'active' | 'inactive' | 'revoked';
    cancel: { reason: 'withdrawn' | 'expired' }[];
    schedule: unknown[];
    alarms: string;
    state: string;
    topUpDelayMs: number | null;
};

/** A Snooze's alarm (core's NativeReminderAlarm, snoozeReminder's reply). */
type SnoozeAlarm = NativeReminderAlarm;

/** What is stored: RN's alarm map (RN's key) and the native host's own reminder state (delivered reminders it may withdraw). */
type Stored = { alarms: string | null; state: string | null };

export type NativeReminderBindings = {
    /** Core's planReminderAlarms; `remake: 'all'` makes every held alarm again. */
    plan: (input: { storedAlarms: string | null; permissionGranted: boolean; storedState: string | null; remake?: 'all' | string[]; fired?: number[]; shown?: number[] })
        => Promise<NativeHostResult<ReminderPlan>>;
    /** Core's planReminderSnooze: whether to make a Snooze's alarm, and the native state before and after. */
    planSnooze: (input: { storedState: string | null; alarm: SnoozeAlarm; permissionGranted: boolean; fired?: number[] }) => NativeHostResult<{ schedule: SnoozeAlarm[]; stateAhead: string | null; state: string | null }>;
    /** RN's alarm map and the native reminder state, as stored (RKStorage). */
    readStored: () => Promise<Stored>;
    /** Kotlin: the notification permission, as RN reads it. */
    permissionGranted: () => boolean;
    /** Kotlin: the plan applied in core's order. */
    apply: (planJson: string) => void;
    /** Kotlin: RN's alarms cancelled and its alarm maps removed; how many were cancelled. */
    cleanupRn: () => number;
    /** Kotlin's ledger: ids of alarms that showed, and of reminder notifications still in the tray. */
    ledger?: () => { fired: number[]; shown: number[] };
    /** Kotlin: deliveries its receiver dropped and receiver jobs WorkManager did not store, since the last call (then zero). */
    receiverCounts?: () => { dropped: number; notQueued: number };
};

const log = (message: string, context: Record<string, unknown>, warn = false) => {
    try {
        (warn ? logWarn : logInfo)(`[Local Notifications] ${message}`, { scope: 'notifications', context });
    } catch { /* a diagnostic line must never fail its caller */ }
};

export const createNativeReminders = (bindings: NativeReminderBindings) => {
    let started = false;
    let rebuilt = false;
    let rnCancelled: number | null = null;
    let queue: Promise<unknown> = Promise.resolve();
    let storeTimer: ReturnType<typeof setTimeout> | null = null;
    let topUpTimer: ReturnType<typeof setTimeout> | null = null;
    let eventTimer: ReturnType<typeof setTimeout> | null = null;

    /** [requested]: true remakes every held alarm, keys remake those (a daily or weekly alarm that fired). */
    const runCycle = async (requested: boolean | string[]) => {
        // RN's alarms go before the first plan; until that succeeds no plan runs (the next cycle tries again).
        if (rnCancelled === null) rnCancelled = bindings.cleanupRn();
        const rebuild = requested === true || !rebuilt;
        const stored = await bindings.readStored();
        const permissionGranted = bindings.permissionGranted();
        const remake = rebuild ? { remake: 'all' as const } : Array.isArray(requested) ? { remake: requested } : {};
        const result = await bindings.plan({ storedAlarms: stored.alarms, permissionGranted, storedState: stored.state, ...remake, ...bindings.ledger?.() });
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
        const plan = result.value;
        // Nothing to store when the stored value already says it (none stored reads as empty).
        const same = (next: string, previous: string | null) => next === previous || (previous === null && next === '{}');
        const unchanged = plan.schedule.length === 0 && plan.cancel.length === 0 && same(plan.alarms, stored.alarms);
        bindings.apply(JSON.stringify({ ...plan, channelName: REMINDER_NOTIFICATION_CHANNEL_NAME, unchanged, state: same(plan.state, stored.state) ? null : plan.state }));
        rebuilt = true;
        if (topUpTimer) clearTimeout(topUpTimer);
        topUpTimer = plan.topUpDelayMs === null ? null : setTimeout(() => {
            topUpTimer = null;
            enqueue(false);
        }, plan.topUpDelayMs);
        const summary = {
            mode: plan.mode,
            rebuild,
            scheduled: plan.schedule.length,
            withdrawn: plan.cancel.filter((item) => item.reason === 'withdrawn').length,
            expired: plan.cancel.filter((item) => item.reason === 'expired').length,
            held: Object.keys(JSON.parse(plan.alarms) as object).length,
            ...bindings.receiverCounts?.(),
        };
        log('Native Android reminder cycle', summary);
        return summary;
    };

    /** [work] after what was queued before it (RN's queueRescheduleCycle); the queue itself never rejects. */
    const serial = <T>(work: () => Promise<T>): Promise<T> => {
        const next = queue.catch(() => undefined).then(work);
        queue = next.catch(() => undefined);
        return next;
    };
    const cycle = (requested: boolean | string[]) => serial(() => runCycle(requested));

    /** A Snooze's alarm made once against the native state, in the queue: the state as not yet made, the alarm, the state as made. */
    const runSnooze = async (alarm: SnoozeAlarm) => {
        const stored = await bindings.readStored();
        const result = bindings.planSnooze({ storedState: stored.state, alarm, permissionGranted: bindings.permissionGranted(), fired: bindings.ledger?.().fired });
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
        const { schedule, stateAhead, state } = result.value;
        bindings.apply(JSON.stringify({ mode: 'active', cancel: [], schedule, writeAhead: null, stateAhead, alarms: stored.alarms, unchanged: true, state,
            topUpDelayMs: null, clearDelivered: false, channelName: REMINDER_NOTIFICATION_CHANNEL_NAME }));
        log('Native Android reminder snooze', { made: schedule.length });
    };
    const enqueue = (rebuild: boolean) => {
        cycle(rebuild).catch((error) => log('Native Android reminder cycle failed', { error: error instanceof Error ? error.message : String(error) }, true));
    };

    return {
        /**
         * The first cycle, then core's store-change timer. `ask`: RN would ask for the notification permission now (a reminder
         * feature is on and notifications are not allowed). Later calls run one more cycle, as RN's start does once started.
         */
        async start() {
            if (isSandboxMode()) return { mode: 'sandbox', ask: false };
            // Armed before the first cycle, so a change while it plans (a sync, a Done) plans again after it.
            if (!started) {
                started = true;
                useTaskStore.subscribe(nameNotifyListener('notification-reschedule', (state, previous) => {
                    if (!shouldRescheduleReminderAlarms(state, previous)) return;
                    if (storeTimer) clearTimeout(storeTimer);
                    storeTimer = setTimeout(() => {
                        storeTimer = null;
                        enqueue(false);
                    }, REMINDER_STORE_RESCHEDULE_DELAY_MS);
                }));
            }
            const first = await cycle(false);
            const active = hasActiveMobileNotificationFeature(useTaskStore.getState().settings);
            const permissionGranted = bindings.permissionGranted();
            return { ...first, rnCancelled, active, permissionGranted, ask: active && !permissionGranted };
        },
        /** One cycle now (a resume, Done, a reboot or a clock change); `rebuild` remakes every alarm. */
        async cycle(rebuild: boolean) {
            if (isSandboxMode()) return { mode: 'sandbox' };
            return cycle(rebuild);
        },
        /** A daily or weekly alarm [key] that fired: core makes it again at its next time, or cancels it once it was turned off. */
        async fired(key: string) {
            if (isSandboxMode()) return { mode: 'sandbox' };
            return cycle([key]);
        },
        /** A Snooze's alarm (snoozeReminder's reply), made unless it was made already; not in sandbox mode, where no alarm is made. */
        async snooze(alarm: SnoozeAlarm) {
            if (isSandboxMode()) return;
            await serial(() => runSnooze(alarm));
        },
        /** A tap on a task's or project's notification: one cycle shortly after (RN's notification event re-arm). */
        event() {
            if (isSandboxMode()) return;
            if (eventTimer) clearTimeout(eventTimer);
            eventTimer = setTimeout(() => {
                eventTimer = null;
                enqueue(false);
            }, REMINDER_NOTIFICATION_EVENT_RESCHEDULE_DELAY_MS);
        },
    };
};

export type NativeReminders = ReturnType<typeof createNativeReminders>;
