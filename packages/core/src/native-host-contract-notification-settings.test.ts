import { afterEach, describe, expect, it } from 'vitest';
import { createNativeHostContract } from './native-host-contract';
import type { NotificationSettingEdit } from './notification-settings-model';
import type { NotificationSettingRequest } from './native-host-contract-notification-settings';
import { resetNativeRequestReceipts } from './native-request-receipts';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Task } from './types';

const ID = '00000000-0000-4000-8000-000000000442';
const OTHER = '00000000-0000-4000-8000-000000000443';
const AT = '2026-09-01T00:00:00.000Z';
const rawTask: Task = { id: 'raw', title: 'Raw', status: 'done', tags: [], contexts: [],
    focusOrder: 9, deletedAt: AT, createdAt: AT, updatedAt: AT, rev: 7 };
const initial = (): AppData => ({ tasks: [rawTask], projects: [], sections: [], areas: [], people: [],
    settings: { notificationsEnabled: true, startDateNotificationsEnabled: true, dueDateNotificationsEnabled: true,
        weeklyReviewEnabled: true, weeklyReviewDay: 2, weeklyReviewTime: '18:00',
        dailyDigestMorningEnabled: true, dailyDigestMorningTime: '09:00',
        dailyDigestEveningEnabled: true, dailyDigestEveningTime: '20:00',
        undoNotificationsEnabled: false, reviewAtNotificationsEnabled: true,
        syncPreferencesUpdatedAt: { language: AT }, retained: { malformedSibling: [null, 'keep'] } } as AppData['settings'] });

async function open(start = initial()) {
    await flushPendingSave(); resetForTests(); resetNativeRequestReceipts();
    let data = structuredClone(start), saves = 0;
    const adapter = { getData: async () => structuredClone(data), saveData: async (next: AppData) => {
        data = structuredClone(next); saves += 1;
    } };
    setStorageAdapter(adapter);
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true }); await flushPendingSave();
    const host = createNativeHostContract();
    expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
    await flushPendingSave(); data = structuredClone(start); saves = 0;
    return { host, data: () => data, saves: () => saves, changeSaved: (change: (next: AppData) => void) => change(data),
        reopen: () => open(data) };
}
async function plan(env: Awaited<ReturnType<typeof open>>, edit: NotificationSettingEdit, requestId = ID) {
    const options = await env.host.getNotificationSettingsOptions({});
    if (!options.ok) throw new Error(JSON.stringify(options));
    const request: NotificationSettingRequest = { requestId, edit, expected: options.value.expected[edit.type] };
    const preparation = await env.host.prepareNotificationSetting(request);
    if (!preparation.ok || preparation.value.kind !== 'prepared') throw new Error(JSON.stringify(preparation));
    return { request, envelope: { request, prepared: preparation.value.prepared } };
}
afterEach(async () => { await flushPendingSave(); resetForTests(); resetNativeRequestReceipts(); });

describe('prepared notification Settings', () => {
    const edits: NotificationSettingEdit[] = [
        { type: 'notificationsEnabled', value: false }, { type: 'startDateNotificationsEnabled', value: false },
        { type: 'dueDateNotificationsEnabled', value: false }, { type: 'weeklyReviewEnabled', value: false },
        { type: 'dailyDigestMorningEnabled', value: false }, { type: 'dailyDigestEveningEnabled', value: false },
        { type: 'weeklyReviewDay', value: 6 }, { type: 'weeklyReviewTime', value: '00:00' },
        { type: 'dailyDigestMorningTime', value: '23:59' }, { type: 'dailyDigestEveningTime', value: '08:05' },
    ];
    it.each(edits)('writes only $type and replays the exact same-host reply', async (edit) => {
        const env = await open();
        const { request, envelope } = await plan(env, edit);
        const result = { ok: true, value: { type: edit.type, value: edit.value, changed: true } };
        expect(env.host.validatePreparedNotificationSetting(envelope)).toEqual(result);
        expect(await env.host.commitPreparedNotificationSetting(envelope)).toEqual(result);
        expect(env.data()).toEqual({ ...initial(), settings: { ...initial().settings, [edit.type]: edit.value } });
        expect(env.saves()).toBe(1);
        expect(env.host.probeNotificationSettingOutcome(request)).toEqual(result);
        expect(await env.host.commitPreparedNotificationSetting(envelope)).toEqual(result);
        expect(env.saves()).toBe(1);
        expect(env.data().settings.deviceId).toBeUndefined();
    });

    it('keeps options/noop pure and distinguishes absent defaults from explicit values', async () => {
        const data = initial(); delete data.settings.notificationsEnabled;
        const env = await open(data);
        const options = await env.host.getNotificationSettingsOptions({});
        expect(options).toMatchObject({ ok: true, value: { expected: {
            notificationsEnabled: { present: false, value: null } }, model: { task: { master: { value: true } } } } });
        expect(env.saves()).toBe(0);
        const { envelope } = await plan(env, { type: 'notificationsEnabled', value: true });
        expect(await env.host.commitPreparedNotificationSetting(envelope)).toMatchObject({ ok: true });
        expect(await env.host.prepareNotificationSetting({ requestId: OTHER,
            edit: { type: 'notificationsEnabled', value: true }, expected: { present: true, value: true } }))
            .toEqual({ ok: true, value: { kind: 'noop', result: { type: 'notificationsEnabled', value: true, changed: false } } });
        expect(env.host.probeNotificationSettingOutcome({ requestId: OTHER,
            edit: { type: 'notificationsEnabled', value: true }, expected: { present: true, value: true } }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(env.saves()).toBe(1);
    });

    it('replaces malformed selected raw data, preserving malformed siblings and stable request identity', async () => {
        const data = initial(); data.settings.weeklyReviewDay = { z: false, a: ['legacy'] } as never;
        data.settings.dailyDigestEveningTime = { old: 'keep' } as never;
        const env = await open(data);
        const { request, envelope } = await plan(env, { type: 'weeklyReviewDay', value: 0 });
        expect(request.expected).toEqual({ present: true, value: { a: ['legacy'], z: false } });
        expect(await env.host.commitPreparedNotificationSetting(envelope)).toMatchObject({ ok: true });
        const reordered = { ...request, expected: { present: true, value: { z: false, a: ['legacy'] } } };
        expect(env.host.probeNotificationSettingOutcome(reordered)).toEqual({ ok: true,
            value: { type: 'weeklyReviewDay', value: 0, changed: true } });
        expect(env.data()).toEqual({ ...data, settings: { ...data.settings, weeklyReviewDay: 0 } });
    });

    it('refuses stale selected witnesses, while a fresh saved sibling change survives', async () => {
        const env = await open();
        const { envelope } = await plan(env, { type: 'weeklyReviewDay', value: 6 });
        env.changeSaved((data) => { data.settings.dailyDigestEveningTime = '21:33'; });
        expect(await env.host.commitPreparedNotificationSetting(envelope)).toMatchObject({ ok: true });
        expect(env.data().settings.dailyDigestEveningTime).toBe('21:33');
        const second = await open();
        const stale = await plan(second, { type: 'weeklyReviewDay', value: 6 });
        second.changeSaved((data) => { data.settings.weeklyReviewDay = 3; });
        expect(await second.host.commitPreparedNotificationSetting(stale.envelope))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(second.data().settings.weeklyReviewDay).toBe(3); expect(second.saves()).toBe(0);
    });

    it('coalesces only the same in-flight request UUID and refuses its conflicting identity', async () => {
        const env = await open();
        const { request, envelope } = await plan(env, { type: 'weeklyReviewDay', value: 6 });
        const [first, duplicate] = await Promise.all([env.host.commitPreparedNotificationSetting(envelope),
            env.host.commitPreparedNotificationSetting(envelope)]);
        expect(first).toEqual({ ok: true, value: { type: 'weeklyReviewDay', value: 6, changed: true } });
        expect(duplicate).toEqual(first); expect(env.saves()).toBe(1);
        expect(env.host.probeNotificationSettingOutcome({ ...request, edit: { type: 'weeklyReviewDay', value: 5 } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const staleOther = { ...request, requestId: OTHER };
        expect(await env.host.prepareNotificationSetting(staleOther)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(env.saves()).toBe(1);
    });

    it('refuses an unbounded saved witness without changing or repairing any saved field', async () => {
        const data = initial(); data.settings.weeklyReviewTime = 'x'.repeat(1025);
        const env = await open(data), before = structuredClone(env.data());
        expect(await env.host.getNotificationSettingsOptions({})).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await env.host.prepareNotificationSetting({ requestId: ID,
            edit: { type: 'weeklyReviewTime', value: '18:00' }, expected: { present: true, value: data.settings.weeklyReviewTime } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(env.data()).toEqual(before); expect(env.saves()).toBe(0);
    });

    it('never authorizes a forged request through pure Validate or cold target equality', async () => {
        const env = await open();
        const { request, envelope } = await plan(env, { type: 'weeklyReviewDay', value: 6 });
        const forgedRequest = { ...request, requestId: OTHER };
        const forged = { request: forgedRequest, prepared: { version: 1, request: forgedRequest } };
        expect(env.host.validatePreparedNotificationSetting(forged)).toMatchObject({ ok: true });
        expect(await env.host.commitPreparedNotificationSetting(forged))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        const cold = await env.reopen();
        cold.changeSaved((data) => { data.settings.weeklyReviewDay = 6; });
        expect(await cold.host.commitPreparedNotificationSetting(envelope))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(cold.saves()).toBe(0);
    });

    it('refuses foreign failed-save ownership and changed storage without clearing failure', async () => {
        const env = await open();
        const { envelope } = await plan(env, { type: 'weeklyReviewDay', value: 6 });
        const failure = { message: 'foreign', timestamp: AT };
        useTaskStore.setState({ persistenceFailure: failure } as never);
        expect(await env.host.commitPreparedNotificationSetting(envelope))
            .toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        expect(useTaskStore.getState().persistenceFailure).toBe(failure);
        useTaskStore.setState({ persistenceFailure: null });
        setStorageAdapter({ getData: async () => initial(), saveData: async () => { throw new Error('must not save'); } });
        expect(await env.host.commitPreparedNotificationSetting(envelope))
            .toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        expect(env.saves()).toBe(0);
    });

    it('rejects malformed closed envelopes, fields, UUIDs, time/day values and witnesses', async () => {
        const env = await open();
        const { request, envelope } = await plan(env, { type: 'weeklyReviewDay', value: 6 });
        const badEdits = [{ type: 'reviewAtNotificationsEnabled', value: false }, { type: 'undoNotificationsEnabled', value: true },
            { type: 'unknown', value: false }, { type: 'notificationsEnabled', value: 1 },
            { type: 'weeklyReviewDay', value: true }, { type: 'weeklyReviewDay', value: -1 },
            { type: 'weeklyReviewDay', value: 7 }, { type: 'weeklyReviewDay', value: 1.5 },
            ...['9:00', '24:00', '00:60', '09:00:00', ' 09:00', ''].map((value) => ({ type: 'weeklyReviewTime', value })),
            { type: 'weeklyReviewDay', value: 1, extra: true }];
        const badRequests: unknown[] = [null, [], { ...request, extra: true }, { ...request, requestId: ID.toUpperCase() },
            { ...request, requestId: 'not-a-uuid' }, { ...request, expected: { present: false, value: 0 } },
            { ...request, expected: { present: true, value: 'x'.repeat(1025) } },
            ...badEdits.map((edit) => ({ ...request, edit }))];
        // This UUID contains no letters; use an uppercase UUID with an actual alpha cell.
        badRequests[3] = { ...request, requestId: 'AAAAAAAA-0000-4000-8000-000000000442' };
        for (const input of badRequests) {
            expect(await env.host.prepareNotificationSetting(input)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(env.host.probeNotificationSettingOutcome(input)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        for (const input of [null, { ...envelope, extra: true }, { request, prepared: { version: 2, request } },
            { request, prepared: { version: 1, request: { ...request, edit: { type: 'weeklyReviewDay', value: 5 } } } }]) {
            expect(env.host.validatePreparedNotificationSetting(input)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await env.host.commitPreparedNotificationSetting(input)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(await env.host.prepareNotificationSetting({ ...request, edit: { type: 'weeklyReviewDay', value: 5 } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await env.host.getNotificationSettingsOptions({ permissionGranted: true })).toMatchObject({ ok: false });
        expect(env.saves()).toBe(0);
    });
});
