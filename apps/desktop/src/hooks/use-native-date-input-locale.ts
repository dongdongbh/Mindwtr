import { useMemo } from 'react';
import { normalizeWeekStartSetting, useTaskStore } from '@mindwtr/core';

import { useLanguage } from '../contexts/language-context';
import { resolveNativeDateInputLocale } from '../lib/native-date-input-locale';
import { getSystemDefaultLocale } from '../lib/system-locale';


export function useNativeDateInputLocale(): {
    nativeDateInputLocale: string;
    dateFormatSetting: string | null | undefined;
} {
    const { language } = useLanguage();
    const dateFormat = useTaskStore((state) => state.settings?.dateFormat);
    const calendarSystem = useTaskStore((state) => state.settings?.calendarSystem);
    const timeFormat = useTaskStore((state) => state.settings?.timeFormat);
    const weekStart = useTaskStore((state) => state.settings?.weekStart);

    const nativeDateInputLocale = useMemo(() => {
        return resolveNativeDateInputLocale({
            language,
            dateFormat,
            calendarSystem,
            timeFormat,
            weekStart: normalizeWeekStartSetting(weekStart),
            systemLocale: getSystemDefaultLocale(),
        });
    }, [language, calendarSystem, dateFormat, timeFormat, weekStart]);

    return { nativeDateInputLocale, dateFormatSetting: dateFormat };
}
