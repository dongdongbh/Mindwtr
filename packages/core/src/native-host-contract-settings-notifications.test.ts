import { afterEach, describe, expect, it } from 'vitest';
import { getTranslator } from './i18n';
import { createNativeHostContract, type NativeHostResult } from './native-host-contract';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppSettings } from './types';
import { generateUUID } from './uuid';


const value = <T,>(result: NativeHostResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};

let saved: { settings: AppSettings } | null = null;
let saves = 0;
async function openHost(settings: AppSettings, options: { capture?: { stored: boolean; failRead?: boolean }; language?: string } = {}) {
    await flushPendingSave();
    resetForTests();
    let data = { tasks: [], projects: [], sections: [], areas: [], people: [], settings };
    setStorageAdapter({
        getData: async () => JSON.parse(JSON.stringify(data)),
        saveData: async (next) => {
            data = JSON.parse(JSON.stringify(next));
            saved = data;
            saves += 1;
        },
    });
    useTaskStore.setState({ error: null, persistenceFailure: null, isLoading: false, editLockCount: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    const capture = options.capture;
    const writes: boolean[] = [];
    const host = createNativeHostContract(capture ? {
        persistentCapture: {
            read: () => {
                if (capture.failRead) throw new Error('unreadable');
                return capture.stored;
            },
            write: (enabled) => { writes.push(enabled); capture.stored = enabled; },
        },
    } : {});
    value(await host.setLanguage({ storedLanguage: options.language ?? 'en', systemLocale: 'en-US' }));
    value(await host.activate({ writeSafetyReady: true }));
    saves = 0;
    return { host, writes };
}

describe('native host contract: Settings › Notifications', () => {
    afterEach(() => { saved = null; });

    it('draws RN\'s three cards with RN\'s defaults, dimming what RN dims', async () => {
        const { host } = await openHost({ notificationsEnabled: false });
        const t = getTranslator('en');
        const view = value(host.getNotificationsSettings());
        expect(view.title).toBe(t('settings.notifications'));
        expect(view.reminders.enable).toEqual({ label: t('settings.notificationsEnable'), description: t('settings.notificationsDesc'), value: false,
            disabled: false, edit: { type: 'notificationsEnabled', value: true }, askPermission: true });
        expect(view.reminders.startReminders).toMatchObject({ value: false, disabled: true });
        expect(view.reminders.dueReminders).toMatchObject({ value: false, disabled: true });

        expect(view.reminders.exactAlarmNotice).toBeNull();
        expect(view.reminders.persistentCapture).toBeNull();
        expect(view.weeklyReview.enable).toMatchObject({ value: false, edit: { type: 'weeklyReviewEnabled', value: true } });
        expect(view.weeklyReview.day).toMatchObject({ label: t('settings.weeklyReviewDay'), description: 'Sunday', disabled: true });
        expect(view.weeklyReview.day.options.map((option) => option.label)).toEqual(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
        expect(view.weeklyReview.time).toEqual({ label: t('settings.weeklyReviewTime'), description: '18:00', value: '18:00', hour: 18, minute: 0,
            disabled: true, type: 'weeklyReviewTime' });

        expect(view.dailyDigest.morning).toMatchObject({ description: `${t('settings.dailyDigestMorningTime')}: 09:00`, value: false, disabled: false });
        expect(view.dailyDigest.evening.disabled).toBe(false);
        expect(view.weeklyReview.enable.disabled).toBe(false);
        expect(view.dailyDigest.eveningTime).toMatchObject({ value: '20:00', disabled: true });
        const menu = value(host.getSettingsMenu());
        expect(menu.groups.flat().find((row) => row.id === 'notifications')?.enabled).toBe(true);
    });

    it('shows the exact-alarm row while any notification feature is on, and the stored values', async () => {
        const { host } = await openHost({ notificationsEnabled: false, dailyDigestEveningEnabled: true, dailyDigestEveningTime: '21:30',
            weeklyReviewEnabled: true, weeklyReviewDay: 3, weeklyReviewTime: '07:05' });
        const t = getTranslator('en');
        const view = value(host.getNotificationsSettings());
        expect(view.reminders.exactAlarmNotice).toEqual({ label: t('settings.exactAlarmsLabel'), description: t('settings.exactAlarmsDesc'),
            actionLabel: t('settings.exactAlarmsAllow') });
        expect(view.weeklyReview.day.description).toBe('Wednesday');
        expect(view.weeklyReview.day.options[3]).toEqual({ label: 'Wednesday', selected: true, edit: { type: 'weeklyReviewDay', value: 3 } });
        expect(view.weeklyReview.time).toMatchObject({ value: '07:05', hour: 7, minute: 5, disabled: false });
        expect(view.dailyDigest.evening).toMatchObject({ value: true, edit: { type: 'dailyDigestEveningEnabled', value: false }, askPermission: false });
        expect(view.dailyDigest.eveningTime).toMatchObject({ value: '21:30', disabled: false });
    });

    it('writes each setting once; a replay or a second send of the same value writes nothing', async () => {
        const { host } = await openHost({ notificationsEnabled: false });
        const requestId = generateUUID();
        const edit = value(host.getNotificationsSettings()).reminders.enable.edit;
        expect(value(await host.setNotificationsSetting({ requestId, edit }))).toEqual({ changed: true, deviceWrites: [] });
        await flushPendingSave();
        expect(saved?.settings.notificationsEnabled).toBe(true);
        const writes = saves;
        expect(value(await host.setNotificationsSetting({ requestId, edit }))).toEqual({ changed: true, deviceWrites: [] });
        expect(value(await host.setNotificationsSetting({ requestId: generateUUID(), edit }))).toEqual({ changed: false, deviceWrites: [] });
        await flushPendingSave();
        expect(saves).toBe(writes);
        for (const next of [
            { type: 'weeklyReviewDay', value: 6 },
            { type: 'weeklyReviewTime', value: '06:45' },
            { type: 'dailyDigestMorningTime', value: '23:59' },
            { type: 'startDateNotificationsEnabled', value: false },
        ] as const) {
            expect(value(await host.setNotificationsSetting({ requestId: generateUUID(), edit: next })).changed).toBe(true);
        }
        await flushPendingSave();
        expect(saved?.settings).toMatchObject({ weeklyReviewDay: 6, weeklyReviewTime: '06:45', dailyDigestMorningTime: '23:59', startDateNotificationsEnabled: false });
    });

    it('refuses an edit the screen does not offer', async () => {
        const { host } = await openHost({});
        for (const edit of [
            { type: 'weeklyReviewTime', value: '7:05' },
            { type: 'weeklyReviewTime', value: '24:00' },
            { type: 'weeklyReviewDay', value: 7 },
            { type: 'weeklyReviewDay', value: 1.5 },
            { type: 'notificationsEnabled', value: 'yes' },
            { type: 'theme', value: 'dark' },
            { type: 'notificationsEnabled', value: true, extra: 1 },

            { type: 'persistentCapture', value: true },
        ]) {
            const result = await host.setNotificationsSetting({ requestId: generateUUID(), edit: edit as never });
            expect(result.ok ? null : result.error.code).toBe('INVALID_INPUT');
        }
        const result = await host.setNotificationsSetting({ requestId: 'nope', edit: { type: 'notificationsEnabled', value: true } });
        expect(result.ok ? null : result.error.code).toBe('INVALID_INPUT');
    });

    it('keeps the persistent capture switch on the device: a target state, with what the notification shows', async () => {
        const capture = { stored: false };
        const { host, writes } = await openHost({}, { capture });
        const t = getTranslator('en');
        const row = value(host.getNotificationsSettings()).reminders.persistentCapture!;
        expect(row).toEqual({ label: t('settings.persistentCaptureLabel'), description: t('settings.persistentCaptureDesc'), value: false, disabled: false,
            edit: { type: 'persistentCapture', value: true }, askPermission: true });
        expect(value(host.getPersistentCaptureNotification())).toEqual({ post: null });
        const strings = { title: t('captureNotification.title'), text: t('captureNotification.text'), channelName: t('captureNotification.channelName') };
        const requestId = generateUUID();
        expect(value(await host.setNotificationsSetting({ requestId, edit: row.edit }))).toEqual({ changed: true, deviceWrites: [], persistentCapture: { post: strings } });

        expect(value(await host.setNotificationsSetting({ requestId: generateUUID(), edit: row.edit })))
            .toEqual({ changed: false, deviceWrites: [], persistentCapture: { post: strings } });
        expect(writes).toEqual([true]);
        expect(value(host.getNotificationsSettings()).reminders.persistentCapture?.value).toBe(true);
        expect(value(host.getPersistentCaptureNotification())).toEqual({ post: strings });
        expect(value(await host.setNotificationsSetting({ requestId: generateUUID(), edit: { type: 'persistentCapture', value: false } })))
            .toEqual({ changed: true, deviceWrites: [], persistentCapture: { post: null } });
        expect(writes).toEqual([true, false]);

        await flushPendingSave();
        expect(saves).toBe(0);
    });

    it('shows an unreadable persistent capture store as off, and never tells the host to remove the notification', async () => {
        const { host } = await openHost({}, { capture: { stored: true, failRead: true } });
        expect(value(host.getNotificationsSettings()).reminders.persistentCapture?.value).toBe(false);

        const restore = host.getPersistentCaptureNotification();
        expect(restore.ok ? null : restore.error.code).toBe('ACTION_FAILED');
    });
});
