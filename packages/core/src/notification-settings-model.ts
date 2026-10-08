import { normalizeDateFormatSetting, resolveDateLocaleTag } from './date';
import { resolveI18nText } from './i18n';
import { areDueDateRemindersEnabled, areStartDateRemindersEnabled, areTaskRemindersEnabled,
    getDigestSchedule, isWeeklyReviewReminderEnabled } from './schedule-utils';
import type { AppSettings } from './types';

export const NOTIFICATION_SETTING_FIELDS = [
    'notificationsEnabled', 'startDateNotificationsEnabled', 'dueDateNotificationsEnabled',
    'weeklyReviewEnabled', 'dailyDigestMorningEnabled', 'dailyDigestEveningEnabled',
    'weeklyReviewDay', 'weeklyReviewTime', 'dailyDigestMorningTime', 'dailyDigestEveningTime',
] as const;
export type NotificationSettingField = typeof NOTIFICATION_SETTING_FIELDS[number];
type ToggleField = Exclude<NotificationSettingField, 'weeklyReviewDay' | 'weeklyReviewTime'
    | 'dailyDigestMorningTime' | 'dailyDigestEveningTime'>;
type TimeField = 'weeklyReviewTime' | 'dailyDigestMorningTime' | 'dailyDigestEveningTime';
export type NotificationSettingEdit = { type: ToggleField; value: boolean }
    | { type: TimeField; value: string } | { type: 'weeklyReviewDay'; value: number };
export type NotificationSettingJson = null | boolean | number | string
    | NotificationSettingJson[] | { [name: string]: NotificationSettingJson };
export type NotificationSettingWitness = { present: boolean; value: NotificationSettingJson };

const record = (value: unknown): value is Record<string, unknown> => value !== null
    && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value: Record<string, unknown>, names: string[]) => Object.keys(value).length === names.length
    && names.every((name) => Object.prototype.hasOwnProperty.call(value, name));

export function isNotificationSettingEdit(value: unknown): value is NotificationSettingEdit {
    if (!record(value) || !exact(value, ['type', 'value'])
        || !NOTIFICATION_SETTING_FIELDS.includes(value.type as NotificationSettingField)) return false;
    if (value.type === 'weeklyReviewDay') return Number.isInteger(value.value)
        && typeof value.value === 'number' && value.value >= 0 && value.value <= 6;
    if (['weeklyReviewTime', 'dailyDigestMorningTime', 'dailyDigestEveningTime'].includes(value.type as string))
        return typeof value.value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.value);
    return typeof value.value === 'boolean';
}

/** Raw legacy values are transport witnesses only, never arbitrary Settings patches. */
export function readNotificationSettingWitness(input: unknown): NotificationSettingWitness | null {
    if (!record(input) || !exact(input, ['present', 'value']) || typeof input.present !== 'boolean'
        || !input.present && input.value !== null) return null;
    let nodes = 0;
    const jsonValue = (value: unknown, depth: number): value is NotificationSettingJson => {
        if (++nodes > 256 || depth > 16) return false;
        if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
        if (typeof value === 'number') return Number.isFinite(value);
        if (Array.isArray(value)) return value.length <= 256 && Array.from(value).every((entry) => jsonValue(entry, depth + 1));
        return record(value) && Object.keys(value).length <= 256
            && Object.values(value).every((entry) => jsonValue(entry, depth + 1));
    };
    if (!jsonValue(input.value, 0)) return null;
    // At most 1024 UTF-16 units (<=3072 UTF-8 bytes); the complete native envelope has its own byte cap.
    if (JSON.stringify(input.value).length > 1024) return null;
    const canonical = (value: NotificationSettingJson): NotificationSettingJson => Array.isArray(value)
        ? value.map(canonical) : record(value)
            ? Object.fromEntries(Object.keys(value).sort().map((name) => [name, canonical(value[name] as NotificationSettingJson)]))
            : value;
    return { present: input.present, value: canonical(input.value) };
}

export function notificationSettingWitness(settings: AppSettings, field: NotificationSettingField): NotificationSettingWitness | null {
    const present = Object.prototype.hasOwnProperty.call(settings, field) && settings[field] !== undefined;
    return readNotificationSettingWitness({ present, value: present ? settings[field] : null });
}

type Toggle = { label: string; description: string; value: boolean; disabled: boolean; edit: NotificationSettingEdit };
type Time = { label: string; value: string; disabled: boolean };
export type NotificationSettingsModel = {
    title: string;
    task: { master: Toggle; start: Toggle; due: Toggle };
    weekly: { enabled: Toggle; time: Time; day: { label: string; value: number; valueLabel: string; disabled: boolean;
        options: { value: number; label: string; selected: boolean; edit: NotificationSettingEdit }[] } };
    digest: { title: string; description: string; morning: { enabled: Toggle; time: Time }; evening: { enabled: Toggle; time: Time } };
    text: { cancel: string; done: string };
};

/** RN defaults/locale path; projection never writes or repairs the stored Settings. */
export function buildNotificationSettingsModel(input: { settings: AppSettings; language: string; systemLocale: string | null;
    t: (name: string) => string }): NotificationSettingsModel {
    const { settings, language, systemLocale, t } = input;
    const tr = (name: string) => resolveI18nText(t, name);
    // Legacy non-string cells cannot enter parseTimeOfDay; keep their raw witness untouched.
    const digest = getDigestSchedule({ ...settings,
        weeklyReviewTime: typeof settings.weeklyReviewTime === 'string' ? settings.weeklyReviewTime : undefined,
        dailyDigestMorningTime: typeof settings.dailyDigestMorningTime === 'string' ? settings.dailyDigestMorningTime : undefined,
        dailyDigestEveningTime: typeof settings.dailyDigestEveningTime === 'string' ? settings.dailyDigestEveningTime : undefined });
    const master = areTaskRemindersEnabled(settings);
    const weekly = isWeeklyReviewReminderEnabled(settings);
    const toggle = (type: ToggleField, label: string, description: string, value: boolean, disabled = false): Toggle =>
        ({ label: tr(label), description: tr(description), value, disabled, edit: { type, value: !value } });
    const time = (label: string, hour: number, minute: number, enabled: boolean): Time => ({ label: tr(label),
        value: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, disabled: !enabled });
    const locale = resolveDateLocaleTag({ language, dateFormat: normalizeDateFormatSetting(settings.dateFormat),
        calendarSystem: settings.calendarSystem, systemLocale });
    // Same Sunday-zero reference and locale/calendar resolution as the RN Notifications screen.
    const days = Array.from({ length: 7 }, (_, day) => ({ value: day,
        label: new Date(2024, 0, 7 + day).toLocaleDateString(locale, { weekday: 'long' }),
        selected: day === digest.weekly.day, edit: { type: 'weeklyReviewDay' as const, value: day } }));
    const morningTime = time('settings.dailyDigestMorningTime', digest.morning.hour, digest.morning.minute, digest.morning.enabled);
    const eveningTime = time('settings.dailyDigestEveningTime', digest.evening.hour, digest.evening.minute, digest.evening.enabled);
    return {
        title: tr('settings.notifications'),
        task: {
            master: toggle('notificationsEnabled', 'settings.notificationsEnable', 'settings.notificationsDesc', master),
            start: toggle('startDateNotificationsEnabled', 'settings.startDateNotifications', 'settings.startDateNotificationsDesc',
                areStartDateRemindersEnabled(settings), !master),
            due: toggle('dueDateNotificationsEnabled', 'settings.dueDateNotifications', 'settings.dueDateNotificationsDesc',
                areDueDateRemindersEnabled(settings), !master),
        },
        weekly: { enabled: toggle('weeklyReviewEnabled', 'settings.weeklyReview', 'settings.weeklyReviewDesc', weekly),
            day: { label: tr('settings.weeklyReviewDay'), value: digest.weekly.day, valueLabel: days[digest.weekly.day].label,
                disabled: !weekly, options: days },
            time: time('settings.weeklyReviewTime', digest.weekly.hour, digest.weekly.minute, weekly) },
        digest: { title: tr('settings.dailyDigest'), description: tr('settings.dailyDigestDesc'),
            morning: { enabled: { label: tr('settings.dailyDigestMorning'), description: `${morningTime.label}: ${morningTime.value}`,
                value: digest.morning.enabled, disabled: false, edit: { type: 'dailyDigestMorningEnabled', value: !digest.morning.enabled } },
            time: morningTime },
            evening: { enabled: { label: tr('settings.dailyDigestEvening'), description: `${eveningTime.label}: ${eveningTime.value}`,
                value: digest.evening.enabled, disabled: false, edit: { type: 'dailyDigestEveningEnabled', value: !digest.evening.enabled } },
            time: eveningTime } },
        text: { cancel: tr('common.cancel'), done: tr('common.done') },
    };
}
