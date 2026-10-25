import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { REMINDER_NOTIFICATION_CHANNEL_NAME } from '../../../packages/core/src';
import { buildNativePomodoroAlarmIntent, buildNativePomodoroLegacyAlert, NATIVE_POMODORO_LATE_LIMIT_MS } from '../../../packages/core/src/native-pomodoro-alarm';
import { planNativePomodoroAlarmEffects } from '../../../packages/core/src/native-pomodoro-alarm-effects';
import { decodeNativePomodoroSession, prepareNativePomodoroTransition } from '../../../packages/core/src/native-pomodoro-session';

const entry = readFileSync(new URL('./host-entry.ts', import.meta.url), 'utf8');
const start = entry.indexOf('    pomodoroAlarmPlan(granted: boolean');
const end = entry.indexOf('    pomodoroSessionRead(): string {', start);
if (start < 0 || end < 0) throw new Error('Android Pomodoro alarm bridge unavailable');
const source = new Bun.Transpiler({ loader: 'ts' }).transformSync(`globalThis.port = {${entry.slice(start, end)}};`);
type Port = {
    pomodoroAlarmPlan(granted: boolean, raw: unknown, scope: string, pending: string, delivered: string): Promise<{
        outcome: string; schedule: { fireAtMs: number; details: { channelName: string; data: Record<string, string> } } | null }>;
    pomodoroLegacyAlert(raw: unknown, upgradedAtMs: number): Promise<{ kind: string }>;
};
const fixture = (session: string | null = null) => {
    const state = { TextEncoder, Date, REMINDER_NOTIFICATION_CHANNEL_NAME, NATIVE_POMODORO_LATE_LIMIT_MS,
        buildNativePomodoroAlarmIntent, buildNativePomodoroLegacyAlert, planNativePomodoroAlarmEffects,
        port: undefined as unknown as Port,
        submit: (work: () => Promise<unknown>) => work(),
        unwrap: (reply: { value: unknown }) => reply.value,
        contract: { getStrings: () => ({ value: { strings: {} } }) },
        useTaskStore: { getState: () => ({ settings: {} }) },
        pomodoroAdapter: () => ({ readPomodoroSession: async () => ({ raw: session }) }),
        pomodoroJSON: (json: string) => JSON.parse(json) as unknown,
        logInfo: () => undefined,
    };
    vm.runInNewContext(source, state);
    return state.port;
};
const scope = `tech.dongdongbh.mindwtr.nativeclient.dev:${'a'.repeat(64)}`;

describe('Android Pomodoro alarm bridge', () => {
    // The QuickJS wrapper hands a Kotlin null over as undefined: no record yet, and no RN record, on a fresh install.
    it('plans with no stored record when Kotlin passes null (undefined in the engine)', async () => {
        const port = fixture();
        expect((await port.pomodoroAlarmPlan(true, undefined, scope, '[]', '[]')).outcome).toBe('uninitialized');
        expect((await port.pomodoroAlarmPlan(false, undefined, scope, '[]', '[]')).outcome).toBe('retained');
    });
    it('answers none for RN\'s alert when there is no RN record', async () => {
        expect(await fixture().pomodoroLegacyAlert(undefined, 1)).toEqual({ kind: 'none' });
    });
    it('stamps a scheduled alert with its phase end (endsAtMs, as RN\'s alarm data), so the tray shows when the phase ended', async () => {
        const id = '11111111-1111-4111-8111-111111111111', now = Date.now();
        const state = decodeNativePomodoroSession(prepareNativePomodoroTransition({
            request: { action: 'initialize', requestId: id, observedAtMs: now, localDayKey: '2026-10-10',
                durations: { focusMinutes: 25, breakMinutes: 5 } }, session: { raw: null, state: null }, target: null, deviceId: null,
        })!.sessionAfter);
        state.session.timerState.isRunning = true;
        state.session.phaseEndsAt = new Date(now + 60_000).toISOString();
        const { schedule } = await fixture(JSON.stringify(state)).pomodoroAlarmPlan(true, undefined, scope, '[]', '[]');
        expect(schedule?.details.data).toEqual({ kind: 'pomodoro', phase: 'focus-complete', endsAtMs: String(schedule!.fireAtMs) });
        expect(schedule?.fireAtMs).toBe(Date.parse(state.session.phaseEndsAt));
        expect(schedule?.details.channelName).toBe(REMINDER_NOTIFICATION_CHANNEL_NAME);
    });
    it('still refuses a record that is not text', async () => {
        await expect(fixture().pomodoroAlarmPlan(true, 7, scope, '[]', '[]')).rejects.toThrow('NOT_READY');
        await expect(fixture().pomodoroLegacyAlert(7, 1)).rejects.toThrow('INVALID_INPUT');
    });
});
