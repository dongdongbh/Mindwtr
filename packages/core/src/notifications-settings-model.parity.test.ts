


import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadTranslations } from './i18n/i18n-loader';
import { tFallback } from './i18n';
import {
    buildNotificationsSettingsModel,
    buildNotificationsSettingsUpdate,
    type NotificationsSettingsModel,
} from './notifications-settings-model';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppSettings } from './types';
import { loadScreenFixture } from './screen-parity.replay';

type Device = {
    platform?: 'android' | 'ios';
    language?: string;
    systemLocale?: string;
    permissionGranted?: boolean;
    persistentCapture?: boolean;
    exactAlarm?: { relevant: boolean; allowed: boolean };
};
type Action = [string, ...unknown[]];
type Scenario = { name: string; settings: string; device: Device; actions: Action[] };
type Observation = {
    texts: [string, string | null, number][];
    switches: [string, boolean, boolean][];
    rows: [string, boolean, boolean][];
    pickers: [string, string, string][];
    modal: { texts: [string, string | null, number][]; switches: unknown[]; rows: [string, boolean, boolean][]; pickers: [string, string, string][] } | null;
    writes: unknown[][];
    device: unknown[][];
};
type Fixture = { now: string; settings: Record<string, AppSettings>; scenarios: Scenario[]; observations: Record<string, Observation[]> };

const fixture = loadScreenFixture<Fixture>('notifications-settings');
const strings: Record<string, Record<string, string>> = {};

type Toggle = NotificationsSettingsModel['reminders']['enable'];
type TimeRow = NotificationsSettingsModel['weeklyReview']['time'];

type Ui = { dayPicker: boolean; time: { row: TimeRow; draft: string } | null };

const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (row: TimeRow) => `${pad(row.hour)}:${pad(row.minute)}`;


function draw(model: NotificationsSettingsModel, device: Device, ui: Ui) {
    const { reminders, weeklyReview, dailyDigest } = model;
    const ios = device.platform === 'ios';
    const notice = reminders.exactAlarmNotice && device.exactAlarm?.relevant && !device.exactAlarm.allowed ? reminders.exactAlarmNotice : null;
    const row = (item: { label: string; description: string }, dim = false) => [[item.label, dim ? 0.5 : 1], [item.description, dim ? 0.5 : 1]];
    const toggles = [reminders.enable, reminders.startReminders, reminders.dueReminders, ...(reminders.persistentCapture ? [reminders.persistentCapture] : []),
        weeklyReview.enable, dailyDigest.morning, dailyDigest.evening];
    const pressRows = [weeklyReview.day, weeklyReview.time, dailyDigest.morningTime, dailyDigest.eveningTime];
    return {
        toggles,
        texts: [
            [model.title, 1],
            ...row(reminders.enable), ...row(reminders.startReminders, reminders.startReminders.disabled), ...row(reminders.dueReminders, reminders.dueReminders.disabled),
            ...(notice ? [[notice.label, 1], [notice.description, 1], [notice.actionLabel, 1]] : []),
            ...(reminders.persistentCapture ? row(reminders.persistentCapture) : []),
            ...row(weeklyReview.enable), ...row(weeklyReview.day, weeklyReview.day.disabled), ...row(weeklyReview.time, weeklyReview.time.disabled),
            ...row(dailyDigest), ...row(dailyDigest.morning), ...row(dailyDigest.morningTime, dailyDigest.morningTime.disabled),
            ...row(dailyDigest.evening), ...row(dailyDigest.eveningTime, dailyDigest.eveningTime.disabled),
        ],
        switches: toggles.map((toggle) => [toggle.label, toggle.value, toggle.disabled]),
        rows: [
            ...(notice ? [[notice.actionLabel, false, false]] : []),
            ...pressRows.map((item) => [`${item.label}|${item.description}`, item.disabled, false]),
        ],
        pickers: ui.time && !ios ? [['time', 'default', ui.time.draft]] : [],
        modal: ui.dayPicker
            ? {
                texts: [[weeklyReview.day.pickerTitle, 1], ...weeklyReview.day.options.map((option) => [option.label, 1])],
                switches: [],
                rows: weeklyReview.day.options.map((option) => [option.label, false, option.selected]),
                pickers: [],
            }
            : ui.time && ios
                ? { title: ui.time.row.label, pickers: [['time', 'spinner', ui.time.draft]] }
                : null,
    };
}

describe('core\'s Settings › Notifications model against RN\'s frozen screen', () => {
    beforeAll(async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(fixture.now));
        strings.en = await loadTranslations('en');
        strings.de = await loadTranslations('de');
    });
    afterAll(async () => {
        await flushPendingSave();
        resetForTests();
        vi.useRealTimers();
    });

    it.each(fixture.scenarios.map((scenario) => [scenario.name, scenario] as const))('%s', async (_name, scenario) => {
        const { device } = scenario;
        const language = device.language ?? 'en';
        const t = (key: string) => strings[language]?.[key] || strings.en?.[key] || key;
        const granted = device.permissionGranted ?? true;
        let capture = device.persistentCapture ?? false;


        await flushPendingSave();
        resetForTests();
        const data = JSON.parse(JSON.stringify({ tasks: [], projects: [], sections: [], areas: [], people: [], settings: fixture.settings[scenario.settings] }));
        setStorageAdapter({ getData: async () => data, saveData: async () => undefined });
        useTaskStore.setState({ settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0 } as never);
        await useTaskStore.getState().fetchData({ throwOnError: true });
        await flushPendingSave();
        let settings: AppSettings = useTaskStore.getState().settings;

        const build = () => buildNotificationsSettingsModel({
            settings, t, language, systemLocale: device.systemLocale ?? 'en-US',
            persistentCapture: device.platform === 'ios' ? undefined : { enabled: capture },
        });
        let ui: Ui = { dayPicker: false, time: null };
        const frozen = fixture.observations[scenario.name];
        const label = (text: string) => (text.startsWith('k:') ? t(text.slice(2)) : text);

        const compare = (step: number, writes: unknown[][], deviceCalls: unknown[][]) => {
            const seen = frozen[step];
            const drawn = draw(build(), device, ui);
            const words = (texts: [string, string | null, number][]) => texts.map(([text, , opacity]) => [text, opacity]);
            const modal = seen.modal && ui.time && device.platform === 'ios'
                ? { title: seen.modal.texts[0][0], pickers: seen.modal.pickers }
                : seen.modal && { ...seen.modal, texts: words(seen.modal.texts) };
            expect({ step, texts: drawn.texts, switches: drawn.switches, rows: drawn.rows, pickers: drawn.pickers, modal: drawn.modal, writes, device: deviceCalls })
                .toEqual({ step, texts: words(seen.texts), switches: seen.switches, rows: seen.rows, pickers: seen.pickers, modal, writes: seen.writes, device: seen.device });
        };
        const write = (writes: unknown[][], update: Partial<AppSettings>) => {
            writes.push(['updateSettings', update]);
            settings = { ...settings, ...update };
        };

        compare(0, [], []);
        scenario.actions.forEach(([kind, target], index) => {
            const model = build();
            const drawn = draw(model, device, ui);
            const writes: unknown[][] = [];
            const calls: unknown[][] = [];
            const pressRows = [model.weeklyReview.time, model.dailyDigest.morningTime, model.dailyDigest.eveningTime];
            if (kind === 'switch') {
                const toggle: Toggle = drawn.toggles[target as number];
                if (!toggle.disabled) {
                    const on = toggle.askPermission;
                    if (on) calls.push(['requestNotificationPermission']);
                    if (!on || granted) {
                        if (on) calls.push(['startMobileNotifications']);
                        const update = buildNotificationsSettingsUpdate(toggle.edit);
                        if (update) write(writes, update);
                        else {
                            calls.push(['applyPersistentCaptureNotification', toggle.edit.value, model.persistentCaptureNotification],
                                ['writePersistentCaptureEnabled', toggle.edit.value]);
                            capture = toggle.edit.value as boolean;
                        }
                    }
                }
            } else if (kind === 'press') {
                const text = label(target as string);
                const timeRow = pressRows.find((item) => item.label === text);
                if (model.reminders.exactAlarmNotice && text === model.reminders.exactAlarmNotice.actionLabel) calls.push(['openExactAlarmSettings']);
                else if (text === model.weeklyReview.day.label) ui = { ...ui, dayPicker: !model.weeklyReview.day.disabled };
                else if (timeRow && !timeRow.disabled) ui = { ...ui, time: { row: timeRow, draft: hhmm(timeRow) } };
            } else if (kind === 'modalPress') {
                const text = label(target as string);
                if (ui.dayPicker) {
                    const option = model.weeklyReview.day.options.find((item) => item.label === text)!;
                    write(writes, buildNotificationsSettingsUpdate(option.edit)!);
                    ui = { ...ui, dayPicker: false };
                } else if (ui.time) {
                    if (text === tFallback(t, 'common.done', 'Done')) write(writes, buildNotificationsSettingsUpdate({ type: ui.time.row.type, value: ui.time.draft })!);
                    ui = { ...ui, time: null };
                }
            } else if (kind === 'dismiss') {
                ui = { ...ui, dayPicker: false };
            } else if (kind === 'pick') {
                write(writes, buildNotificationsSettingsUpdate({ type: ui.time!.row.type, value: target as string })!);
                ui = { ...ui, time: null };
            } else if (kind === 'pickDismiss') {
                ui = { ...ui, time: null };
            } else if (kind === 'draft') {
                ui = { ...ui, time: { ...ui.time!, draft: target as string } };
            } else {
                throw new Error(`Unknown action ${kind}`);
            }
            compare(index + 1, writes, calls);
        });
    });
});
