import { describe, expect, it } from 'vitest';
import { resolveDateLocaleTag } from './date';
import { buildNotificationSettingsModel, notificationSettingWitness, readNotificationSettingWitness } from './notification-settings-model';
import type { AppSettings } from './types';

const model = (settings: AppSettings = {}, language = 'en', systemLocale = 'en-US') =>
    buildNotificationSettingsModel({ settings, language, systemLocale, t: (key) => key });

describe('notification Settings projection', () => {
    it('uses shared reminder defaults without storing them', () => {
        const settings = {};
        const value = model(settings);
        expect(value.task.master).toMatchObject({ value: true, disabled: false });
        expect(value.task.start).toMatchObject({ value: true, disabled: false });
        expect(value.task.due).toMatchObject({ value: true, disabled: false });
        expect(value.weekly.enabled.value).toBe(false);
        expect(value.weekly.day).toMatchObject({ value: 0, disabled: true });
        expect(value.weekly.time).toMatchObject({ value: '18:00', disabled: true });
        expect(value.digest.morning.time.value).toBe('09:00');
        expect(value.digest.evening.time.value).toBe('20:00');
        expect(settings).toEqual({});
    });

    it('keeps digest and weekly independent of a disabled task master', () => {
        const value = model({ notificationsEnabled: false, startDateNotificationsEnabled: true,
            dueDateNotificationsEnabled: true, weeklyReviewEnabled: true, dailyDigestMorningEnabled: true,
            dailyDigestEveningEnabled: true });
        expect(value.task.start).toMatchObject({ value: false, disabled: true });
        expect(value.task.due).toMatchObject({ value: false, disabled: true });
        expect(value.weekly.enabled).toMatchObject({ value: true, disabled: false });
        expect(value.weekly.day.disabled).toBe(false);
        expect(value.digest.morning.enabled.value).toBe(true);
        expect(value.digest.evening.enabled.value).toBe(true);
    });

    it('projects malformed legacy values through shared defaults without repairing raw data', () => {
        const settings = { notificationsEnabled: 'legacy', weeklyReviewDay: 7.9,
            dailyDigestMorningTime: { old: 'time' }, dailyDigestEveningTime: '25:10',
            weeklyReviewTime: '08:35', retained: { b: 2, a: null } } as unknown as AppSettings;
        const before = structuredClone(settings);
        const value = model(settings);
        expect(value.task.master.value).toBe(true);
        expect(value.weekly.day.value).toBe(6);
        expect(value.digest.morning.time.value).toBe('09:00');
        expect(value.digest.evening.time.value).toBe('20:00');
        expect(value.weekly.time.value).toBe('08:35');
        expect(settings).toEqual(before);
    });

    it.each([null, { old: 'time' }, 123, true])('projects non-string time cells without mutating their raw witnesses (%j)', (raw) => {
        const settings = { weeklyReviewTime: raw, dailyDigestMorningTime: raw,
            dailyDigestEveningTime: raw } as unknown as AppSettings;
        const before = structuredClone(settings), value = model(settings);
        expect(value.weekly.time.value).toBe('18:00');
        expect(value.digest.morning.time.value).toBe('09:00');
        expect(value.digest.evening.time.value).toBe('20:00');
        expect(notificationSettingWitness(settings, 'weeklyReviewTime')).toEqual({ present: true, value: raw });
        expect(settings).toEqual(before);
    });

    it.each([null, { old: 'day' }, '2', true])('uses shared defaults for malformed day/Boolean cells (%j)', (raw) => {
        const settings = { weeklyReviewDay: raw, notificationsEnabled: raw, startDateNotificationsEnabled: raw,
            dueDateNotificationsEnabled: raw, weeklyReviewEnabled: raw, dailyDigestMorningEnabled: raw,
            dailyDigestEveningEnabled: raw } as unknown as AppSettings;
        const before = structuredClone(settings), value = model(settings);
        expect(value.weekly.day.value).toBe(0);
        expect([value.task.master.value, value.task.start.value, value.task.due.value]).toEqual([true, true, true]);
        expect([value.weekly.enabled.value, value.digest.morning.enabled.value, value.digest.evening.enabled.value])
            .toEqual([raw === true, raw === true, raw === true]);
        expect(settings).toEqual(before);
    });

    it.each([['en', 'en-US', 'gregorian'], ['fa', 'fa-IR', 'jalali'], ['ar', 'ar-SA', 'gregorian']])(
        'uses the RN locale/calendar path for Sunday-zero weekday choices (%s)', (language, systemLocale, calendarSystem) => {
            const settings = { weeklyReviewEnabled: true, weeklyReviewDay: 4, calendarSystem } as AppSettings;
            const value = model(settings, language, systemLocale);
            const locale = resolveDateLocaleTag({ language, dateFormat: 'system', calendarSystem, systemLocale });
            expect(value.weekly.day.options.map((option) => option.value)).toEqual([0, 1, 2, 3, 4, 5, 6]);
            expect(value.weekly.day.options.map((option) => option.label)).toEqual(Array.from({ length: 7 },
                (_, day) => new Date(2024, 0, 7 + day).toLocaleDateString(locale, { weekday: 'long' })));
            expect(value.weekly.day.options.filter((option) => option.selected).map((option) => option.value)).toEqual([4]);
        });
});

describe('raw notification witness', () => {
    it('distinguishes absent, null and a malformed bounded value, with stable property order', () => {
        expect(notificationSettingWitness({}, 'weeklyReviewDay')).toEqual({ present: false, value: null });
        expect(notificationSettingWitness({ weeklyReviewDay: null } as never, 'weeklyReviewDay'))
            .toEqual({ present: true, value: null });
        const value = notificationSettingWitness({ weeklyReviewDay: { z: [false, 'old'], a: 1 } } as never, 'weeklyReviewDay');
        expect(JSON.stringify(value)).toBe('{"present":true,"value":{"a":1,"z":[false,"old"]}}');
    });

    it('refuses oversized, overdeep, cyclic and non-JSON witnesses', () => {
        let deep: unknown = 0;
        for (let index = 0; index < 18; index++) deep = [deep];
        const cyclic: unknown[] = []; cyclic.push(cyclic);
        for (const value of ['a'.repeat(1025), deep, cyclic, Infinity, NaN, undefined, new Date(),
            { undefinedValue: undefined }, { nested: () => 1 }, Array(300).fill(0)]) {
            expect(readNotificationSettingWitness({ present: true, value })).toBeNull();
        }
        expect(readNotificationSettingWitness({ present: false, value: true })).toBeNull();
        expect(readNotificationSettingWitness({ present: false, value: null, extra: true })).toBeNull();
    });

    it('enforces the exact JSON string, depth and node bounds', () => {
        let atDepth: unknown = 0;
        for (let index = 0; index < 16; index++) atDepth = [atDepth];
        expect(readNotificationSettingWitness({ present: true, value: atDepth })).not.toBeNull();
        expect(readNotificationSettingWitness({ present: true, value: [atDepth] })).toBeNull();
        expect(readNotificationSettingWitness({ present: true, value: Array(255).fill(0) })).not.toBeNull();
        expect(readNotificationSettingWitness({ present: true, value: Array(256).fill(0) })).toBeNull();
        expect(readNotificationSettingWitness({ present: true, value: 'x'.repeat(1022) })).not.toBeNull();
        expect(readNotificationSettingWitness({ present: true, value: 'x'.repeat(1023) })).toBeNull();
    });
});
