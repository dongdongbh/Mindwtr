import { useMemo } from 'react';
import { resolveDateLocaleTag, useTaskStore, type AppData } from '@mindwtr/core';

import type { Language } from '../../../contexts/language-context';
import type { SettingsNotificationsPageProps } from './SettingsNotificationsPage';

type UseSettingsNotificationsPageOptions = {
    language: Language;

    dateFormat: string;
    calendarSystem: string;
    showSaved: () => void;
};


export function useSettingsNotificationsPage({
    language,
    dateFormat,
    calendarSystem,
    showSaved,
}: UseSettingsNotificationsPageOptions): Omit<SettingsNotificationsPageProps, 't'> {
    const settings =
        useTaskStore((state) => state.settings) ?? ({} as AppData['settings']);
    const updateSettings = useTaskStore((state) => state.updateSettings);

    const systemLocale =
        typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function'
            ? Intl.DateTimeFormat().resolvedOptions().locale
            : '';
    const locale = resolveDateLocaleTag({
        language,
        dateFormat,
        calendarSystem,
        systemLocale,
    });
    const weekdayOptions = useMemo(
        () =>
            Array.from({ length: 7 }, (_, i) => {
                const base = new Date(2021, 7, 1 + i);
                return {
                    value: i,
                    label: base.toLocaleDateString(locale, { weekday: 'long' }),
                };
            }),
        [locale],
    );

    return {
        notificationsEnabled: settings?.notificationsEnabled !== false,
        taskReminderDefault: settings?.taskReminderDefault ?? 'send',
        startDateNotificationsEnabled: settings?.startDateNotificationsEnabled !== false,
        dueDateNotificationsEnabled: settings?.dueDateNotificationsEnabled !== false,
        reviewAtNotificationsEnabled: settings?.reviewAtNotificationsEnabled !== false,
        weeklyReviewEnabled: settings?.weeklyReviewEnabled === true,
        weeklyReviewDay: Number.isFinite(settings?.weeklyReviewDay)
            ? (settings?.weeklyReviewDay as number)
            : 0,
        weeklyReviewTime: settings?.weeklyReviewTime || '18:00',
        weekdayOptions,
        dailyDigestMorningEnabled: settings?.dailyDigestMorningEnabled === true,
        dailyDigestEveningEnabled: settings?.dailyDigestEveningEnabled === true,
        dailyDigestMorningTime: settings?.dailyDigestMorningTime || '09:00',
        dailyDigestEveningTime: settings?.dailyDigestEveningTime || '20:00',
        updateSettings,
        showSaved,
    };
}
