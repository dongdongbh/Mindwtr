


import type { DateFormatSetting, TimeFormatSetting, WeekStartPreference, WeekStartSetting } from './date';
import {
    canUseJalaliCalendar,
    normalizeDateFormatSetting,
    normalizeTimeFormatSetting,
    normalizeWeekStartPreference,
    resolveCalendarSystemSetting,
} from './date';
import { resolveI18nText, tFallback } from './i18n';
import { LANGUAGE_STORAGE_KEY } from './i18n/i18n-constants';
import { LOCALES } from './i18n/i18n-locales';
import type { Language } from './i18n/i18n-types';
import { resolveMobileQuickAccessView } from './more-menu-model';
import type { AppSettings, AppTheme, MobileAppLockRelockDelayMinutes, MobileQuickAccessView } from './types';

type Translate = (key: string) => string;


export const SETTINGS_LANGUAGE_OPTIONS: { id: Language; native: string }[] = [
    { id: 'en', native: 'English' },
    ...Object.entries(LOCALES).map(([id, descriptor]) => ({ id: id as Language, native: descriptor.native })),
];


export const MOBILE_QUICK_ACCESS_VIEW_OPTIONS: MobileQuickAccessView[] = ['review', 'projects', 'calendar', 'contexts'];


export const MOBILE_APP_LOCK_RELOCK_DELAY_OPTIONS: MobileAppLockRelockDelayMinutes[] = [0, 1, 5, 15];

const RELOCK_DELAY_LABEL_KEYS: Record<MobileAppLockRelockDelayMinutes, string> = {
    0: 'settings.mobile.appLockRelockImmediately',
    1: 'settings.mobile.appLockRelockAfter1',
    5: 'settings.mobile.appLockRelockAfter5',
    15: 'settings.mobile.appLockRelockAfter15',
};


export function resolveMobileAppLockRelockDelayMinutes(value: unknown): MobileAppLockRelockDelayMinutes {
    return MOBILE_APP_LOCK_RELOCK_DELAY_OPTIONS.includes(value as never) ? value as MobileAppLockRelockDelayMinutes : 0;
}


export type GeneralSettingsEdit =
    | { type: 'theme'; value: AppTheme }
    | { type: 'showTaskAge'; value: boolean }
    | { type: 'quickAccessView'; value: MobileQuickAccessView }
    | { type: 'appLock'; value: boolean }
    | { type: 'appLockRelockDelay'; value: MobileAppLockRelockDelayMinutes }
    | { type: 'language'; value: Language }
    | { type: 'weekStart'; value: WeekStartPreference }
    | { type: 'dateFormat'; value: DateFormatSetting }
    | { type: 'calendarSystem'; value: 'gregorian' | 'jalali' }
    | { type: 'timeFormat'; value: TimeFormatSetting }

    | { type: 'appSearch'; value: boolean };


export function buildGeneralSettingsUpdate(settings: AppSettings, edit: GeneralSettingsEdit): Partial<AppSettings> | null {
    switch (edit.type) {
        case 'theme':
            return { theme: edit.value };
        case 'showTaskAge':
            return { appearance: { ...(settings.appearance ?? {}), showTaskAge: edit.value } };
        case 'quickAccessView':
            return { appearance: { ...(settings.appearance ?? {}), mobileQuickAccessView: edit.value } };
        case 'appLock':
            return { security: { ...(settings.security ?? {}), mobileAppLockEnabled: edit.value } };
        case 'appLockRelockDelay':
            return { security: { ...(settings.security ?? {}), mobileAppLockRelockDelayMinutes: edit.value } };
        case 'language':
            return { language: edit.value };
        case 'weekStart':
            return { weekStart: edit.value };
        case 'dateFormat':
            return { dateFormat: edit.value };
        case 'calendarSystem':
            return { calendarSystem: edit.value };
        case 'timeFormat':
            return { timeFormat: edit.value };
        case 'appSearch':
            return null;
    }
}


export function isGeneralSettingStored(settings: AppSettings, edit: GeneralSettingsEdit): boolean {
    switch (edit.type) {
        case 'theme': return settings.theme === edit.value;
        case 'showTaskAge': return settings.appearance?.showTaskAge === edit.value;
        case 'quickAccessView': return settings.appearance?.mobileQuickAccessView === edit.value;
        case 'appLock': return settings.security?.mobileAppLockEnabled === edit.value;
        case 'appLockRelockDelay': return settings.security?.mobileAppLockRelockDelayMinutes === edit.value;
        case 'language': return settings.language === edit.value;
        case 'weekStart': return settings.weekStart === edit.value;
        case 'dateFormat': return settings.dateFormat === edit.value;
        case 'calendarSystem': return settings.calendarSystem === edit.value;
        case 'timeFormat': return settings.timeFormat === edit.value;
        case 'appSearch': return true;
    }
}


export const MOBILE_THEME_STORAGE_KEY = '@mindwtr_theme';

export const MOBILE_THEME_STYLE_STORAGE_KEY = '@mindwtr_theme_style';

export const MOBILE_APP_SEARCH_STORAGE_KEY = 'mindwtr:appSearchIndexingEnabled';

export const MOBILE_APP_SEARCH_WIPE_OWED_STORAGE_KEY = 'mindwtr:appSearchWipeOwed';


export type SettingsDeviceWrite = { key: string; value: string | null };


export function getGeneralSettingsDeviceWrites(edit: GeneralSettingsEdit): SettingsDeviceWrite[] {
    switch (edit.type) {
        case 'theme':
            return [
                { key: MOBILE_THEME_STORAGE_KEY, value: edit.value },
                { key: MOBILE_THEME_STYLE_STORAGE_KEY, value: edit.value === 'material3-light' || edit.value === 'material3-dark' ? 'material3' : 'default' },
            ];
        case 'language':
            return [{ key: LANGUAGE_STORAGE_KEY, value: edit.value }];
        case 'appSearch':

            return edit.value ? [{ key: MOBILE_APP_SEARCH_STORAGE_KEY, value: 'true' }]
                : [{ key: MOBILE_APP_SEARCH_WIPE_OWED_STORAGE_KEY, value: 'true' }, { key: MOBILE_APP_SEARCH_STORAGE_KEY, value: null }];
        default:
            return [];
    }
}


export function resolveGeneralThemeMode(syncedTheme: unknown, deviceTheme: string | null | undefined): string {
    if (typeof syncedTheme === 'string' && syncedTheme) return syncedTheme;
    return deviceTheme || 'system';
}


export type GeneralSettingsThemeIcon =
    | 'phone-portrait-outline' | 'contrast-outline' | 'sunny-outline' | 'moon-outline' | 'color-palette-outline'
    | 'document-text-outline' | 'snow-outline' | 'cafe-outline' | 'wine-outline' | 'book-outline';

export type GeneralSettingsOption<T> = { value: T; label: string; selected: boolean; edit: GeneralSettingsEdit };
export type GeneralSettingsPicker<T> = {
    label: string;

    value: string;
    pickerTitle: string;
    options: GeneralSettingsOption<T>[];
};
export type GeneralSettingsToggle = { label: string; description: string; value: boolean; edit: GeneralSettingsEdit };

export type GeneralSettingsModel = {
    title: string;
    appearance: {
        title: string;

        theme: Omit<GeneralSettingsPicker<string>, 'options'> & {
            groups: (GeneralSettingsOption<AppTheme> & { icon: GeneralSettingsThemeIcon })[][];
        };
        showTaskAge: GeneralSettingsToggle;
        quickAccess: GeneralSettingsPicker<MobileQuickAccessView>;
    };
    privacy: {
        title: string;


        appLock: GeneralSettingsToggle & {
            enablePrompt: { promptMessage: string; cancelLabel: string; fallbackLabel: string };
            errors: { unavailable: string; cancelled: string; failed: string };
        };

        appLockRelockDelay: GeneralSettingsPicker<MobileAppLockRelockDelayMinutes> | null;

        appSearch: GeneralSettingsToggle | null;
    };
    language: GeneralSettingsPicker<Language> & { title: string; description: string };
    regional: {
        label: string;

        summary: string;
        weekStart: GeneralSettingsPicker<WeekStartPreference>;
        dateFormat: GeneralSettingsPicker<DateFormatSetting>;

        calendarSystem: GeneralSettingsPicker<'gregorian' | 'jalali'> | null;
        timeFormat: GeneralSettingsPicker<TimeFormatSetting>;
    };
};

const option = <T,>(value: T, label: string, selected: boolean, edit: GeneralSettingsEdit): GeneralSettingsOption<T> => ({ value, label, selected, edit });

export function buildGeneralSettingsModel(input: {
    settings: AppSettings;

    themeMode: string;
    language: Language;
    systemLocale: string;

    systemWeekStart: WeekStartSetting;

    systemDateSample: string;
    appSearch: { supported: boolean; enabled: boolean };
    t: Translate;
}): GeneralSettingsModel {
    const { settings, themeMode, language, systemLocale, t } = input;
    const tr = (key: string) => resolveI18nText(t, key);
    const languageLabel = (code: string) => SETTINGS_LANGUAGE_OPTIONS.find((lang) => lang.id === code)?.native ?? code;

    const weekStart = normalizeWeekStartPreference(settings.weekStart);
    const dateFormat = normalizeDateFormatSetting(settings.dateFormat);
    const timeFormat = normalizeTimeFormatSetting(settings.timeFormat);
    const showCalendarSystem = canUseJalaliCalendar({ language, systemLocale });
    const calendarSystem = resolveCalendarSystemSetting(settings.calendarSystem, { language, systemLocale });
    const showTaskAge = settings.appearance?.showTaskAge === true;
    const quickAccessView = resolveMobileQuickAccessView(settings.appearance?.mobileQuickAccessView);
    const appLockEnabled = settings.security?.mobileAppLockEnabled === true;
    const relockDelay = resolveMobileAppLockRelockDelayMinutes(settings.security?.mobileAppLockRelockDelayMinutes);
    const relockDelayOptions = MOBILE_APP_LOCK_RELOCK_DELAY_OPTIONS.map((value) => option(
        value,
        tr(RELOCK_DELAY_LABEL_KEYS[value]),
        relockDelay === value,
        { type: 'appLockRelockDelay', value },
    ));

    const themeOption = (value: AppTheme, label: string, icon: GeneralSettingsThemeIcon) => ({
        ...option(value, label, value === themeMode, { type: 'theme', value }), icon,
    });
    const baseThemes = [
        themeOption('system', t('settings.system'), 'phone-portrait-outline'),
        themeOption('system-oled', `${t('settings.system')} (${t('settings.light')} / OLED ${t('settings.dark')})`, 'contrast-outline'),
        themeOption('light', t('settings.light'), 'sunny-outline'),
        themeOption('dark', t('settings.dark'), 'moon-outline'),
    ];
    const styledThemes = [
        themeOption('material3-light', t('settings.material3Light'), 'color-palette-outline'),
        themeOption('material3-dark', t('settings.material3Dark'), 'color-palette-outline'),
        themeOption('eink', t('settings.eink'), 'document-text-outline'),
        themeOption('nord', t('settings.nord'), 'snow-outline'),
        themeOption('catppuccin-macchiato', t('settings.catppuccinMacchiato'), 'cafe-outline'),
        themeOption('dracula', t('settings.dracula'), 'wine-outline'),
        themeOption('gruvbox-light', t('settings.gruvboxLight'), 'sunny-outline'),
        themeOption('gruvbox-dark', t('settings.gruvboxDark'), 'moon-outline'),
        themeOption('sepia', t('settings.sepia'), 'book-outline'),
        themeOption('oled', t('settings.oled'), 'contrast-outline'),
    ];
    const currentThemeLabel = [...baseThemes, ...styledThemes].find((entry) => entry.value === themeMode)?.label ?? t('settings.system');

    const quickAccessOptions = MOBILE_QUICK_ACCESS_VIEW_OPTIONS.map((value) => option(
        value,
        value === 'review'
            ? t('tab.review')
            : value === 'projects'
                ? t('nav.projects')
                : value === 'calendar'
                    ? t('nav.calendar')
                    : t('nav.contexts'),
        quickAccessView === value,
        { type: 'quickAccessView', value },
    ));


    const systemWeekStartLabel = input.systemWeekStart === 'monday'
        ? t('settings.weekStartMonday')
        : input.systemWeekStart === 'saturday'
            ? t('settings.weekStartSaturday')
            : t('settings.weekStartSunday');
    const weekStartOptions = ([
        ['system', `${tFallback(t, 'settings.weekStartSystem', 'System default')} (${systemWeekStartLabel})`],
        ['sunday', t('settings.weekStartSunday')],
        ['monday', t('settings.weekStartMonday')],
        ['saturday', t('settings.weekStartSaturday')],
    ] as const).map(([value, label]) => option<WeekStartPreference>(value, label, weekStart === value, { type: 'weekStart', value }));
    const dateFormatOptions = ([
        ['system', `${t('settings.dateFormatSystem')} (${input.systemDateSample})`],
        ['dmy', t('settings.dateFormatDmy')],
        ['mdy', t('settings.dateFormatMdy')],
        ['ymd', t('settings.dateFormatYmd')],
    ] as const).map(([value, label]) => option<DateFormatSetting>(value, label, dateFormat === value, { type: 'dateFormat', value }));
    const calendarSystemOptions = ([
        ['gregorian', t('settings.calendarSystemGregorian')],
        ['jalali', t('settings.calendarSystemJalali')],
    ] as const).map(([value, label]) => option<'gregorian' | 'jalali'>(value, label, calendarSystem === value, { type: 'calendarSystem', value }));
    const timeFormatOptions = ([
        ['system', t('settings.timeFormatSystem')],
        ['12h', t('settings.timeFormat12h')],
        ['24h', t('settings.timeFormat24h')],
    ] as const).map(([value, label]) => option<TimeFormatSetting>(value, label, timeFormat === value, { type: 'timeFormat', value }));
    const current = <T,>(options: GeneralSettingsOption<T>[], fallback: string) => options.find((entry) => entry.selected)?.label ?? fallback;
    const weekStartLabel = current(weekStartOptions, tFallback(t, 'settings.weekStartSystem', 'System default'));
    const dateFormatLabel = current(dateFormatOptions, t('settings.dateFormatSystem'));
    const timeFormatLabel = current(timeFormatOptions, t('settings.timeFormatSystem'));

    return {
        title: t('settings.general'),
        appearance: {
            title: t('settings.appearance'),
            theme: { label: t('settings.theme'), value: currentThemeLabel, pickerTitle: t('settings.theme'), groups: [baseThemes, styledThemes] },
            showTaskAge: {
                label: tr('settings.mobile.showTaskAge'),
                description: tr('settings.mobile.displayHowLongAgoATaskWasCreatedInTask'),
                value: showTaskAge,
                edit: { type: 'showTaskAge', value: !showTaskAge },
            },
            quickAccess: {
                label: tr('settings.mobile.quickAccessView'),
                value: current(quickAccessOptions, t('tab.review')),
                pickerTitle: tr('settings.mobile.quickAccessView'),
                options: quickAccessOptions,
            },
        },
        privacy: {
            title: tr('settings.privacy'),
            appLock: {
                label: tr('settings.mobile.appLock'),
                description: tr('settings.mobile.appLockDesc'),
                value: appLockEnabled,
                edit: { type: 'appLock', value: !appLockEnabled },
                enablePrompt: {
                    promptMessage: tr('appLock.enablePrompt'),
                    cancelLabel: tr('common.cancel'),
                    fallbackLabel: tr('appLock.useDevicePasscode'),
                },
                errors: { unavailable: tr('appLock.unavailable'), cancelled: tr('appLock.cancelled'), failed: tr('appLock.failed') },
            },
            appLockRelockDelay: appLockEnabled ? {
                label: tr('settings.mobile.appLockRelock'),
                value: current(relockDelayOptions, tr('settings.mobile.appLockRelockImmediately')),
                pickerTitle: tr('settings.mobile.appLockRelock'),
                options: relockDelayOptions,
            } : null,
            appSearch: input.appSearch.supported ? {
                label: tr('settings.appSearchLabel'),
                description: tr('settings.appSearchDesc'),
                value: input.appSearch.enabled,
                edit: { type: 'appSearch', value: !input.appSearch.enabled },
            } : null,
        },
        language: {
            title: t('settings.language'),
            description: t('settings.selectLang'),
            label: t('settings.language'),
            value: languageLabel(language),
            pickerTitle: t('settings.language'),
            options: SETTINGS_LANGUAGE_OPTIONS.map((lang) => option(lang.id, languageLabel(lang.id), language === lang.id, { type: 'language', value: lang.id })),
        },
        regional: {
            label: t('settings.regionalFormats'),
            summary: `${weekStartLabel} · ${dateFormatLabel} · ${timeFormatLabel}`,
            weekStart: { label: t('settings.weekStart'), value: weekStartLabel, pickerTitle: t('settings.weekStart'), options: weekStartOptions },
            dateFormat: { label: t('settings.dateFormat'), value: dateFormatLabel, pickerTitle: t('settings.dateFormat'), options: dateFormatOptions },
            calendarSystem: showCalendarSystem ? {
                label: t('settings.calendarSystem'),
                value: current(calendarSystemOptions, t('settings.calendarSystemGregorian')),
                pickerTitle: t('settings.calendarSystem'),
                options: calendarSystemOptions,
            } : null,
            timeFormat: { label: t('settings.timeFormat'), value: timeFormatLabel, pickerTitle: t('settings.timeFormat'), options: timeFormatOptions },
        },
    };
}
