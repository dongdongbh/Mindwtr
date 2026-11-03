


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


type SnoozeAlarm = NativeReminderAlarm;


type Stored = { alarms: string | null; state: string | null };

export type NativeReminderBindings = {

    plan: (input: { storedAlarms: string | null; permissionGranted: boolean; storedState: string | null; remake?: 'all' | string[]; fired?: number[]; shown?: number[] })
        => Promise<NativeHostResult<ReminderPlan>>;

    planSnooze: (input: { storedState: string | null; alarm: SnoozeAlarm; permissionGranted: boolean; fired?: number[] }) => NativeHostResult<{ schedule: SnoozeAlarm[]; stateAhead: string | null; state: string | null }>;

    readStored: () => Promise<Stored>;

    permissionGranted: () => boolean;

    apply: (planJson: string) => number | void;

    cleanupRn: () => number;

    ledger?: () => { fired: number[]; shown: number[] };

    receiverCounts?: () => { dropped: number; notQueued: number };
};

const log = (message: string, context: Record<string, unknown>, warn = false) => {
    try {

        (warn ? logWarn : logInfo)(`[Local Notifications] ${message}`, { scope: 'notifications', context, force: typeof context.releaseCheck === 'string' });
    } catch {                                                    }
};

export const createNativeReminders = (bindings: NativeReminderBindings) => {
    let started = false;
    let rebuilt = false;
    let rnCancelled: number | null = null;
    let queue: Promise<unknown> = Promise.resolve();
    let storeTimer: ReturnType<typeof setTimeout> | null = null;
    let topUpTimer: ReturnType<typeof setTimeout> | null = null;
    let eventTimer: ReturnType<typeof setTimeout> | null = null;


    const runCycle = async (requested: boolean | string[]) => {

        if (rnCancelled === null) rnCancelled = bindings.cleanupRn();
        const rebuild = requested === true || !rebuilt;
        const stored = await bindings.readStored();
        const permissionGranted = bindings.permissionGranted();
        const remake = rebuild ? { remake: 'all' as const } : Array.isArray(requested) ? { remake: requested } : {};
        const result = await bindings.plan({ storedAlarms: stored.alarms, permissionGranted, storedState: stored.state, ...remake, ...bindings.ledger?.() });
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
        const plan = result.value;

        const same = (next: string, previous: string | null) => next === previous || (previous === null && next === '{}');
        const unchanged = plan.schedule.length === 0 && plan.cancel.length === 0 && same(plan.alarms, stored.alarms);
        const refused = Number(bindings.apply(JSON.stringify({ ...plan, channelName: REMINDER_NOTIFICATION_CHANNEL_NAME, unchanged,
            state: same(plan.state, stored.state) ? null : plan.state })) ?? 0);

        if (refused > 0) log('Reminder cycle finished with refused alarms', { releaseCheck: 'v1.3.8/native-reminder-cycle-partial', count: refused }, true);
        if (plan.schedule.some((item) => item && typeof item === 'object' && 'details' in item
            && item.details && typeof item.details === 'object' && 'data' in item.details
            && item.details.data && typeof item.details.data === 'object' && 'kind' in item.details.data
            && item.details.data.kind === 'task-due-advance')) log('Advance reminder scheduled', { releaseCheck: 'v1.3.8/due-advance-reminder', outcome: 'scheduled' });
        if (refused === 0 && plan.schedule.some((item) => item && typeof item === 'object' && 'details' in item
            && item.details && typeof item.details === 'object' && 'data' in item.details
            && item.details.data && typeof item.details.data === 'object' && 'kind' in item.details.data
            && item.details.data.kind === 'task-start-advance')) log('Start advance reminder scheduled', { releaseCheck: 'v1.3.8/start-advance-reminder', outcome: 'scheduled' }, true);

        rebuilt = refused === 0;
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
            ...(refused > 0 ? { refused } : {}),
        };
        log('Native Android reminder cycle', summary);
        return summary;
    };


    const serial = <T>(work: () => Promise<T>): Promise<T> => {
        const next = queue.catch(() => undefined).then(work);
        queue = next.catch(() => undefined);
        return next;
    };
    const cycle = (requested: boolean | string[]) => serial(() => runCycle(requested));


    const runSnooze = async (alarm: SnoozeAlarm) => {
        const stored = await bindings.readStored();
        const result = bindings.planSnooze({ storedState: stored.state, alarm, permissionGranted: bindings.permissionGranted(), fired: bindings.ledger?.().fired });
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
        const { schedule, stateAhead, state } = result.value;
        const refused = Number(bindings.apply(JSON.stringify({ mode: 'active', cancel: [], schedule, writeAhead: null, stateAhead, alarms: stored.alarms,
            unchanged: true, state, topUpDelayMs: null, clearDelivered: false, channelName: REMINDER_NOTIFICATION_CHANNEL_NAME })) ?? 0);

        if (refused > 0) throw new Error('ALARM_REFUSED: Android refused the Snooze alarm');
        log('Native Android reminder snooze', { made: schedule.length });
    };
    const enqueue = (rebuild: boolean) => {
        cycle(rebuild).catch((error) => log('Native Android reminder cycle failed', { error: error instanceof Error ? error.message : String(error) }, true));
    };

    return {


        async start() {
            if (isSandboxMode()) return { mode: 'sandbox', ask: false };

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

        async cycle(rebuild: boolean) {
            if (isSandboxMode()) return { mode: 'sandbox' };
            return cycle(rebuild);
        },


        async background(reason: 'capture' | 'sync') {
            if (isSandboxMode()) return { mode: 'sandbox', outcome: 'skipped' };
            const receipt = (outcome: string) => log('Background reminder reconciliation',
                { releaseCheck: 'v1.3.8/native-background-reminders', reason, outcome }, outcome === 'failed');
            try {
                const summary = await cycle(false);
                receipt('cycle-completed');
                return { ...summary, outcome: 'cycle-completed' };
            } catch {
                receipt('failed');
                return { outcome: 'failed' };
            }
        },

        async fired(key: string) {
            if (isSandboxMode()) return { mode: 'sandbox' };
            return cycle([key]);
        },

        async snooze(alarm: SnoozeAlarm) {
            if (isSandboxMode()) return;
            await serial(() => runSnooze(alarm));
        },

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
