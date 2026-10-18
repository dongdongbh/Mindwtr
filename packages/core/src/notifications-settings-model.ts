/**
 * The mobile Settings › Notifications screen as data, as React Native draws it
 * (apps/mobile/components/settings/notifications-settings-screen.tsx): three cards
 * (task reminders with the exact-alarm notice and Android's persistent capture
 * notification; the weekly review; the daily digest), every row's text and value,
 * which rows are dimmed and disabled, and the write each control makes. The native
 * host contract draws it (native-host-contract-settings.ts); RN's parity test
 * compares RN's screen with it.
 *
 * RN asks for the notification permission before any switch turns on (a toggle's
 * `askPermission`): only a granted permission sends the write. Turning one off
 * always writes.
 */
import { normalizeDateFormatSetting, resolveDateLocaleTag } from './date';
import { tFallback } from './i18n';
import {
    areDueDateRemindersEnabled,
    areStartDateRemindersEnabled,
    areTaskRemindersEnabled,
    hasActiveMobileNotificationFeature,
    isWeeklyReviewReminderEnabled,
} from './schedule-utils';
import type { AppSettings } from './types';

type Translate = (key: string) => string;

/** RN's AsyncStorage key for the persistent capture notification ('true' while on; removed when off). */
export const PERSISTENT_CAPTURE_STORAGE_KEY = 'mindwtr:persistentCaptureNotification';

export const NOTIFICATIONS_BOOLEAN_SETTINGS = [
    'notificationsEnabled',
    'startDateNotificationsEnabled',
    'dueDateNotificationsEnabled',
    'weeklyReviewEnabled',
    'dailyDigestMorningEnabled',
    'dailyDigestEveningEnabled',
] as const;
export const NOTIFICATIONS_TIME_SETTINGS = ['weeklyReviewTime', 'dailyDigestMorningTime', 'dailyDigestEveningTime'] as const;

export type NotificationsSettingsEdit =
    | { type: typeof NOTIFICATIONS_BOOLEAN_SETTINGS[number]; value: boolean }
    | { type: typeof NOTIFICATIONS_TIME_SETTINGS[number]; value: string }
    | { type: 'weeklyReviewDay'; value: number }
    | { type: 'taskReminderDefault'; value: 'send' | 'skip' }
    | { type: 'persistentCapture'; value: boolean };

type Toggle = {
    label: string;
    description: string;
    value: boolean;
    /** Drawn faded and unpressable (RN's dimmed and disabled). */
    disabled: boolean;
    edit: NotificationsSettingsEdit;
    /** RN asks for the notification permission first; the edit goes only once it is granted. */
    askPermission: boolean;
};

/** A row that opens Android's time picker: send `{ type, value: 'HH:MM' }` with the time picked. */
type TimeRow = { label: string; description: string; value: string; hour: number; minute: number; disabled: boolean; type: typeof NOTIFICATIONS_TIME_SETTINGS[number] };

export type NotificationsSettingsModel = {
    title: string;
    reminders: {
        enable: Toggle;
        startReminders: Toggle;
        dueReminders: Toggle;
        taskDefault: { label: string; description: string; disabled: false; pickerTitle: string; options: { label: string; selected: boolean; edit: NotificationsSettingsEdit }[] };
        /** RN's exact-alarm row while a notification feature is on; the host shows it only while Android 12+ denies exact alarms. */
        exactAlarmNotice: { label: string; description: string; actionLabel: string } | null;
        /** Android only: the persistent capture notification's switch. */
        persistentCapture: Toggle | null;
    };
    weeklyReview: {
        enable: Toggle;
        day: { label: string; description: string; disabled: boolean; pickerTitle: string; options: { label: string; selected: boolean; edit: NotificationsSettingsEdit }[] };
        time: TimeRow;
    };
    dailyDigest: {
        label: string;
        description: string;
        morning: Toggle;
        morningTime: TimeRow;
        evening: Toggle;
        eveningTime: TimeRow;
    };
    /** What the persistent capture notification shows, and its channel's name (RN's strings). */
    persistentCaptureNotification: { title: string; text: string; channelName: string };
};

export type NotificationsSettingsInput = {
    settings: AppSettings;
    t: Translate;
    language: string;
    systemLocale: string;
    /** The persistent capture switch on a device that has one (Android); absent elsewhere. */
    persistentCapture?: { enabled: boolean };
};

/** RN's weekday name for 0 (Sunday) to 6, in the user's date locale. */
export const getNotificationWeekdayLabel = (dayIndex: number, locale: string): string => {
    const base = new Date(2024, 0, 7 + dayIndex);
    return base.toLocaleDateString(locale, { weekday: 'long' });
};

const timeParts = (time: string) => {
    const [hours, minutes] = time.split(':').map((v) => parseInt(v, 10));
    return { hour: Number.isFinite(hours) ? hours : 9, minute: Number.isFinite(minutes) ? minutes : 0 };
};

/** RN's time value: 'HH:MM', two digits each. */
export const NOTIFICATIONS_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function buildNotificationsSettingsModel(input: NotificationsSettingsInput): NotificationsSettingsModel {
    const { settings, t } = input;
    const notificationsEnabled = areTaskRemindersEnabled(settings);
    const startDateNotificationsEnabled = areStartDateRemindersEnabled(settings);
    const dueDateNotificationsEnabled = areDueDateRemindersEnabled(settings);
    const dailyDigestMorningEnabled = settings.dailyDigestMorningEnabled === true;
    const dailyDigestEveningEnabled = settings.dailyDigestEveningEnabled === true;
    const dailyDigestMorningTime = settings.dailyDigestMorningTime || '09:00';
    const dailyDigestEveningTime = settings.dailyDigestEveningTime || '20:00';
    const weeklyReviewEnabled = isWeeklyReviewReminderEnabled(settings);
    const weeklyReviewTime = settings.weeklyReviewTime || '18:00';
    const weeklyReviewDay = Number.isFinite(settings.weeklyReviewDay) ? (settings.weeklyReviewDay as number) : 0;
    const locale = resolveDateLocaleTag({
        language: input.language,
        dateFormat: normalizeDateFormatSetting(settings.dateFormat),
        calendarSystem: settings.calendarSystem,
        systemLocale: input.systemLocale,
    });

    const toggle = (type: Toggle['edit']['type'], label: string, description: string, value: boolean, disabled = false): Toggle => ({
        label, description, value, disabled, edit: { type, value: !value } as NotificationsSettingsEdit, askPermission: !value,
    });
    const time = (type: TimeRow['type'], label: string, value: string, disabled: boolean): TimeRow => ({
        label, description: value, value, ...timeParts(value), disabled, type,
    });

    return {
        title: t('settings.notifications'),
        reminders: {
            enable: toggle('notificationsEnabled', t('settings.notificationsEnable'), t('settings.notificationsDesc'), notificationsEnabled),
            startReminders: toggle('startDateNotificationsEnabled', t('settings.startDateNotifications'), t('settings.startDateNotificationsDesc'),
                startDateNotificationsEnabled, !notificationsEnabled),
            dueReminders: toggle('dueDateNotificationsEnabled', t('settings.dueDateNotifications'), t('settings.dueDateNotificationsDesc'),
                dueDateNotificationsEnabled, !notificationsEnabled),
            taskDefault: {
                label: t('settings.taskReminderDefault'),
                description: `${t(settings.taskReminderDefault === 'skip' ? 'settings.taskReminderDefaultSkip' : 'settings.taskReminderDefaultSend')} · ${t('settings.taskReminderDefaultDesc')}`,
                disabled: false,
                pickerTitle: t('settings.taskReminderDefault'),
                options: (['send', 'skip'] as const).map((value) => ({
                    label: t(value === 'skip' ? 'settings.taskReminderDefaultSkip' : 'settings.taskReminderDefaultSend'),
                    selected: (settings.taskReminderDefault === 'skip' ? 'skip' : 'send') === value,
                    edit: { type: 'taskReminderDefault', value },
                })),
            },
            exactAlarmNotice: hasActiveMobileNotificationFeature(settings)
                ? { label: t('settings.exactAlarmsLabel'), description: t('settings.exactAlarmsDesc'), actionLabel: t('settings.exactAlarmsAllow') }
                : null,
            persistentCapture: input.persistentCapture
                ? toggle('persistentCapture', t('settings.persistentCaptureLabel'), t('settings.persistentCaptureDesc'), input.persistentCapture.enabled)
                : null,
        },
        weeklyReview: {
            enable: toggle('weeklyReviewEnabled', t('settings.weeklyReview'), t('settings.weeklyReviewDesc'), weeklyReviewEnabled),
            day: {
                label: t('settings.weeklyReviewDay'),
                description: getNotificationWeekdayLabel(weeklyReviewDay, locale),
                disabled: !weeklyReviewEnabled,
                pickerTitle: t('settings.weeklyReviewDay'),
                options: Array.from({ length: 7 }, (_, idx) => ({
                    label: getNotificationWeekdayLabel(idx, locale),
                    selected: weeklyReviewDay === idx,
                    edit: { type: 'weeklyReviewDay', value: idx },
                })),
            },
            time: time('weeklyReviewTime', t('settings.weeklyReviewTime'), weeklyReviewTime, !weeklyReviewEnabled),
        },
        dailyDigest: {
            label: t('settings.dailyDigest'),
            description: t('settings.dailyDigestDesc'),
            morning: toggle('dailyDigestMorningEnabled', t('settings.dailyDigestMorning'),
                `${t('settings.dailyDigestMorningTime')}: ${dailyDigestMorningTime}`, dailyDigestMorningEnabled),
            morningTime: time('dailyDigestMorningTime', t('settings.dailyDigestMorningTime'), dailyDigestMorningTime, !dailyDigestMorningEnabled),
            evening: toggle('dailyDigestEveningEnabled', t('settings.dailyDigestEvening'),
                `${t('settings.dailyDigestEveningTime')}: ${dailyDigestEveningTime}`, dailyDigestEveningEnabled),
            eveningTime: time('dailyDigestEveningTime', t('settings.dailyDigestEveningTime'), dailyDigestEveningTime, !dailyDigestEveningEnabled),
        },
        persistentCaptureNotification: {
            title: tFallback(t, 'captureNotification.title', 'Quick capture'),
            text: tFallback(t, 'captureNotification.text', 'Tap to capture to your Inbox'),
            channelName: tFallback(t, 'captureNotification.channelName', 'Quick capture'),
        },
    };
}

/** The synced settings write an edit makes (RN's updateSettings); null for the device-local persistent capture switch. */
export const buildNotificationsSettingsUpdate = (edit: NotificationsSettingsEdit): Partial<AppSettings> | null => (
    edit.type === 'persistentCapture' ? null : { [edit.type]: edit.value } as Partial<AppSettings>
);

/** The stored value already says it: a replay writes nothing. */
export const isNotificationsSettingStored = (settings: AppSettings, edit: NotificationsSettingsEdit): boolean => (
    edit.type !== 'persistentCapture' && (settings as Record<string, unknown>)[edit.type] === edit.value
);
