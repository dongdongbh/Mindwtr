import {
    addDays,
    addMonths,
    endOfMonth as endOfGregorianMonth,
    format,
    getYear as getGregorianYear,
    isSameDay,
    isSameMonth as isSameGregorianMonth,
    isValid,
    parseISO,
    setDefaultOptions,
    setMonth as setGregorianMonth,
    setYear as setGregorianYear,
    startOfDay,
    startOfMonth as startOfGregorianMonth,
    type Locale,
} from 'date-fns';
import { ar, cs, de, enGB, enUS, es, fr, hi, it, ja, ko, nl, pl, ptBR, ru, tr, vi, zhCN, zhTW } from 'date-fns/locale';
import {
    addMonths as addJalaliMonths,
    endOfMonth as endOfJalaliMonth,
    format as formatJalali,
    getDate as getJalaliDate,
    getMonth as getJalaliMonth,
    getYear as getJalaliYear,
    parse as parseJalali,
    setMonth as setJalaliMonth,
    setYear as setJalaliYear,
    startOfMonth as startOfJalaliMonth,
} from 'date-fns-jalali';
import { faIR as jalaliFaIR } from 'date-fns-jalali/locale/fa-IR';
import type { Language } from './i18n/i18n-types';

export type DateFormatSetting = 'system' | 'dmy' | 'mdy' | 'ymd';
export type CalendarSystemSetting = 'gregorian' | 'jalali';
export type TimeFormatSetting = 'system' | '12h' | '24h';
export type WeekStartSetting = 'sunday' | 'monday' | 'saturday';
export type WeekStartsOnIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export const QUICK_DATE_PRESETS = ['today', 'tomorrow', 'in_3_days', 'next_week', 'next_month', 'no_date'] as const;
export type QuickDatePreset = typeof QUICK_DATE_PRESETS[number];
export const JALALI_LOCALE_TAG = 'fa-IR-u-ca-persian';

const DEFAULT_LOCALE = enUS;
const DMY_EN_REGIONS = new Set(['GB', 'IE', 'AU', 'NZ', 'ZA']);
const DATE_LOCALE_BY_LANGUAGE: Record<Language, Locale> = {
    en: enUS,
    vi,
    zh: zhCN,
    'zh-Hant': zhTW,
    es,
    hi,
    ar,
    de,
    ru,
    ja,
    fr,
    pt: ptBR,
    pl,
    ko,
    cs,
    it,
    tr,
    nl,
};
const LOCALE_TAG_BY_LANGUAGE: Record<Language, string> = {
    en: 'en-US',
    vi: 'vi-VN',
    zh: 'zh-CN',
    'zh-Hant': 'zh-TW',
    es: 'es-ES',
    hi: 'hi-IN',
    ar: 'ar',
    de: 'de-DE',
    ru: 'ru-RU',
    ja: 'ja-JP',
    fr: 'fr-FR',
    pt: 'pt-PT',
    pl: 'pl-PL',
    cs: 'cs-CZ',
    ko: 'ko-KR',
    it: 'it-IT',
    tr: 'tr-TR',
    nl: 'nl-NL',
};

let activeLocale: Locale = DEFAULT_LOCALE;
let activeDateFormatSetting: DateFormatSetting = 'system';
let activeTimeFormatSetting: TimeFormatSetting = 'system';
let activeCalendarSystem: CalendarSystemSetting = 'gregorian';

const normalizeLocaleTag = (value?: string | null): string => String(value || '').trim().replace(/_/g, '-');

const getPrimaryLanguageSubtag = (value?: string | null): string => (
    normalizeLocaleTag(value).toLowerCase().split('-')[0] || ''
);

const isPersianLocaleTag = (value?: string | null): boolean => {
    const primary = getPrimaryLanguageSubtag(value);
    return primary === 'fa' || primary === 'prs';
};

const formatStoredDate = (date: Date): string => format(date, 'yyyy-MM-dd');

const hasLocalizedDateToken = (formatStr: string): boolean => /(^|[^'])P{1,4}/.test(formatStr);

const normalizeLanguage = (language?: string | null): Language => {
    const normalized = normalizeLocaleTag(language);
    if (normalized in DATE_LOCALE_BY_LANGUAGE) {
        return normalized as Language;
    }
    const lower = normalized.toLowerCase();
    if (lower.startsWith('zh')) {
        if (lower.includes('-hant') || /-(tw|hk|mo)\b/.test(lower)) {
            return 'zh-Hant';
        }
        return 'zh';
    }
    const primary = lower.split('-')[0];
    if (primary in DATE_LOCALE_BY_LANGUAGE) {
        return primary as Language;
    }
    return 'en';
};

const resolveLocaleFromSystem = (systemLocale?: string | null, fallback: Language = 'en'): Locale => {
    const tag = normalizeLocaleTag(systemLocale);
    const lower = tag.toLowerCase();
    const primary = lower.split('-')[0];
    const region = tag.split('-')[1]?.toUpperCase();
    if (primary === 'en') {
        return region && DMY_EN_REGIONS.has(region) ? enGB : enUS;
    }
    if (primary === 'zh') {
        if (lower.includes('-hant') || /-(tw|hk|mo)\b/.test(lower)) return zhTW;
        return zhCN;
    }
    if (primary in DATE_LOCALE_BY_LANGUAGE) {
        return DATE_LOCALE_BY_LANGUAGE[primary as Language];
    }
    return DATE_LOCALE_BY_LANGUAGE[fallback] ?? DEFAULT_LOCALE;
};

const normalizeLocalizedFormatTokens = (formatStr: string): string => {
    let result = formatStr;
    const resolvedDateToken = activeDateFormatSetting === 'ymd' ? 'yyyy-MM-dd' : null;
    const resolvedTimeToken = activeTimeFormatSetting === '24h'
        ? 'HH:mm'
        : activeTimeFormatSetting === '12h'
            ? 'hh:mm a'
            : null;

    if (resolvedDateToken || resolvedTimeToken) {
        result = result.replace(/P{1,4}\s*p{1,4}/g, () => {
            const dateToken = resolvedDateToken ?? 'P';
            const timeToken = resolvedTimeToken ?? 'p';
            return `${dateToken} ${timeToken}`;
        });
    }
    if (resolvedDateToken) {
        result = result.replace(/P{1,4}/g, resolvedDateToken);
    }
    if (resolvedTimeToken) {
        result = result.replace(/p{1,4}/g, resolvedTimeToken);
    }
    return result;
};

export function normalizeDateFormatSetting(value?: string | null): DateFormatSetting {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'dmy') return 'dmy';
    if (normalized === 'mdy') return 'mdy';
    if (normalized === 'ymd' || normalized === 'yyyy-mm-dd' || normalized === 'iso') return 'ymd';
    return 'system';
}

export function normalizeCalendarSystemSetting(value?: string | null): CalendarSystemSetting {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'jalali' || normalized === 'persian' || normalized === 'solar-hijri') return 'jalali';
    return 'gregorian';
}

export function canUseJalaliCalendar(params: {
    language?: string | null;
    systemLocale?: string | null;
} = {}): boolean {
    return isPersianLocaleTag(params.language) || isPersianLocaleTag(params.systemLocale);
}

export function resolveCalendarSystemSetting(value?: string | null, params: {
    language?: string | null;
    systemLocale?: string | null;
} = {}): CalendarSystemSetting {
    const calendarSystem = normalizeCalendarSystemSetting(value);
    if (calendarSystem !== 'jalali') return 'gregorian';
    return canUseJalaliCalendar(params) ? 'jalali' : 'gregorian';
}

export function isJalaliCalendarLocale(locale?: string | null): boolean {
    return normalizeLocaleTag(locale).toLowerCase().includes('ca-persian');
}

export function normalizeTimeFormatSetting(value?: string | null): TimeFormatSetting {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === '12h' || normalized === '12' || normalized === '12-hour') return '12h';
    if (normalized === '24h' || normalized === '24' || normalized === '24-hour') return '24h';
    return 'system';
}

export function normalizeWeekStartSetting(value?: string | null): WeekStartSetting {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'monday') return 'monday';
    if (normalized === 'saturday') return 'saturday';
    return 'sunday';
}

export function getWeekStartsOnIndex(value?: string | null): WeekStartsOnIndex {
    const weekStart = normalizeWeekStartSetting(value);
    if (weekStart === 'monday') return 1;
    if (weekStart === 'saturday') return 6;
    return 0;
}

export function normalizeClockTimeInput(value?: string | null): string | null {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) return '';
    const compact = trimmed.replace(/\s+/g, '');
    let hours: number;
    let minutes: number;

    if (/^\d{1,2}:\d{2}$/.test(compact)) {
        const [h, m] = compact.split(':');
        hours = Number(h);
        minutes = Number(m);
    } else if (/^\d{3,4}$/.test(compact)) {
        if (compact.length === 3) {
            hours = Number(compact.slice(0, 1));
            minutes = Number(compact.slice(1));
        } else {
            hours = Number(compact.slice(0, 2));
            minutes = Number(compact.slice(2));
        }
    } else {
        return null;
    }

    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function getQuickDate(preset: QuickDatePreset, now: Date = new Date()): Date | null {
    const today = startOfDay(now);
    switch (preset) {
        case 'today':
            return today;
        case 'tomorrow':
            return addDays(today, 1);
        case 'in_3_days':
            return addDays(today, 3);
        case 'next_week': {
            const dayOfWeek = today.getDay();
            const daysUntilNextMonday = ((8 - dayOfWeek) % 7) || 7;
            return addDays(today, daysUntilNextMonday);
        }
        case 'next_month':
            return startOfGregorianMonth(addMonths(today, 1));
        case 'no_date':
            return null;
    }
}

export function isQuickDatePresetSelected(
    preset: QuickDatePreset,
    selectedDate: Date | null | undefined,
    now: Date = new Date()
): boolean {
    if (!selectedDate || preset === 'no_date') return false;
    const presetDate = getQuickDate(preset, now);
    return presetDate ? isSameDay(selectedDate, presetDate) : false;
}

export function resolveDateLocaleTag(params: {
    language?: string | null;
    dateFormat?: string | null;
    calendarSystem?: string | null;
    systemLocale?: string | null;
}): string {
    const dateFormat = normalizeDateFormatSetting(params.dateFormat);
    const language = normalizeLanguage(params.language);
    const systemLocale = normalizeLocaleTag(params.systemLocale);
    const calendarSystem = resolveCalendarSystemSetting(params.calendarSystem, {
        language: params.language,
        systemLocale,
    });
    if (calendarSystem === 'jalali') return JALALI_LOCALE_TAG;
    if (dateFormat === 'mdy') return 'en-US';
    if (dateFormat === 'dmy') {
        return language === 'en' ? 'en-GB' : LOCALE_TAG_BY_LANGUAGE[language];
    }
    if (dateFormat === 'ymd') {
        if (systemLocale) return systemLocale;
        return LOCALE_TAG_BY_LANGUAGE[language] ?? 'en-US';
    }
    if (systemLocale) return systemLocale;
    return LOCALE_TAG_BY_LANGUAGE[language] ?? 'en-US';
}

export function configureDateFormatting(params: {
    language?: string | null;
    dateFormat?: string | null;
    calendarSystem?: string | null;
    timeFormat?: string | null;
    systemLocale?: string | null;
} = {}): void {
    const language = normalizeLanguage(params.language);
    const dateFormat = normalizeDateFormatSetting(params.dateFormat);
    const timeFormat = normalizeTimeFormatSetting(params.timeFormat);
    const systemLocale = normalizeLocaleTag(params.systemLocale);
    const calendarSystem = resolveCalendarSystemSetting(params.calendarSystem, {
        language: params.language,
        systemLocale,
    });
    activeDateFormatSetting = dateFormat;
    activeTimeFormatSetting = timeFormat;
    activeCalendarSystem = calendarSystem;

    if (dateFormat === 'mdy') {
        activeLocale = enUS;
    } else if (dateFormat === 'dmy') {
        activeLocale = language === 'en' ? enGB : DATE_LOCALE_BY_LANGUAGE[language];
    } else if (dateFormat === 'ymd') {
        activeLocale = resolveLocaleFromSystem(systemLocale, language);
    } else {
        activeLocale = resolveLocaleFromSystem(systemLocale, language);
    }

    setDefaultOptions({ locale: activeLocale });
}

/**
 * Safely formats a date string, handling undefined, null, or invalid dates.
 * 
 * @param dateStr - The date string to format (e.g. ISO string) or Date object
 * @param formatStr - The format string (date-fns format)
 * @param fallback - Optional fallback string (default: '')
 * @returns Formatted date string or fallback
 */
export function safeFormatDate(
    dateStr: string | Date | undefined | null,
    formatStr: string,
    fallback: string = ''
): string {
    if (!dateStr) return fallback;

    try {
        const date = typeof dateStr === 'string' ? safeParseDate(dateStr) : dateStr;
        if (!date || !isValid(date)) return fallback;
        const normalizedFormat = normalizeLocalizedFormatTokens(formatStr);
        if (activeCalendarSystem === 'jalali' && hasLocalizedDateToken(formatStr)) {
            return formatJalali(date, normalizedFormat, { locale: jalaliFaIR });
        }
        return format(date, normalizedFormat, { locale: activeLocale });
    } catch {
        return fallback;
    }
}

export function formatCalendarInputDate(
    value: string | Date | undefined | null,
    calendarSystem?: string | null
): string {
    if (!value) return '';
    const date = typeof value === 'string' ? safeParseDate(value) : value;
    if (!date || !isValid(date)) return typeof value === 'string' ? value : '';
    if (normalizeCalendarSystemSetting(calendarSystem) === 'jalali') {
        return formatJalali(date, 'yyyy-MM-dd', { locale: jalaliFaIR });
    }
    return formatStoredDate(date);
}

export function parseCalendarInputDate(
    value: string,
    calendarSystem?: string | null
): string | null {
    const normalized = String(value || '').trim().replace(/[./]/g, '-');
    if (!normalized) return '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;

    if (normalizeCalendarSystemSetting(calendarSystem) === 'jalali') {
        const parsed = parseJalali(normalized, 'yyyy-MM-dd', new Date());
        if (!isValid(parsed)) return null;
        return formatJalali(parsed, 'yyyy-MM-dd') === normalized
            ? formatStoredDate(parsed)
            : null;
    }

    const parsed = safeParseDate(normalized);
    if (!parsed || !isValid(parsed)) return null;
    return formatStoredDate(parsed) === normalized ? normalized : null;
}

export function startOfCalendarMonth(
    date: Date,
    calendarSystem?: string | null
): Date {
    return normalizeCalendarSystemSetting(calendarSystem) === 'jalali'
        ? startOfJalaliMonth(date)
        : startOfGregorianMonth(date);
}

export function endOfCalendarMonth(
    date: Date,
    calendarSystem?: string | null
): Date {
    return normalizeCalendarSystemSetting(calendarSystem) === 'jalali'
        ? endOfJalaliMonth(date)
        : endOfGregorianMonth(date);
}

export function addCalendarMonths(
    date: Date,
    months: number,
    calendarSystem?: string | null
): Date {
    return normalizeCalendarSystemSetting(calendarSystem) === 'jalali'
        ? addJalaliMonths(date, months)
        : addMonths(date, months);
}

export function getCalendarMonthIndex(
    date: Date,
    calendarSystem?: string | null
): number {
    return normalizeCalendarSystemSetting(calendarSystem) === 'jalali'
        ? getJalaliMonth(date)
        : date.getMonth();
}

export function getCalendarYear(
    date: Date,
    calendarSystem?: string | null
): number {
    return normalizeCalendarSystemSetting(calendarSystem) === 'jalali'
        ? getJalaliYear(date)
        : getGregorianYear(date);
}

export function setCalendarMonthIndex(
    date: Date,
    monthIndex: number,
    calendarSystem?: string | null
): Date {
    return normalizeCalendarSystemSetting(calendarSystem) === 'jalali'
        ? setJalaliMonth(date, monthIndex)
        : setGregorianMonth(date, monthIndex);
}

export function setCalendarYear(
    date: Date,
    year: number,
    calendarSystem?: string | null
): Date {
    return normalizeCalendarSystemSetting(calendarSystem) === 'jalali'
        ? setJalaliYear(date, year)
        : setGregorianYear(date, year);
}

export function isSameCalendarMonth(
    left: Date,
    right: Date,
    calendarSystem?: string | null
): boolean {
    return normalizeCalendarSystemSetting(calendarSystem) === 'jalali'
        ? getJalaliYear(left) === getJalaliYear(right) && getJalaliMonth(left) === getJalaliMonth(right)
        : isSameGregorianMonth(left, right);
}

export function getCalendarDayOfMonth(
    date: Date,
    calendarSystem?: string | null
): number {
    return normalizeCalendarSystemSetting(calendarSystem) === 'jalali'
        ? getJalaliDate(date)
        : date.getDate();
}

/**
 * Safely parses a date string to a Date object.
 * Returns null if invalid.
 */
export function safeParseDate(dateStr: string | undefined | null): Date | null {
    if (!dateStr) return null;
    try {
        const hasTimezone = /Z$|[+-]\d{2}:?\d{2}$/.test(dateStr);
        if (!hasTimezone) {
            const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2})(?::(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?)?$/.exec(dateStr);
            if (match) {
                const year = Number(match[1]);
                const month = Number(match[2]) - 1;
                const day = Number(match[3]);
                const hour = match[4] ? Number(match[4]) : 0;
                const minute = match[5] ? Number(match[5]) : 0;
                const second = match[6] ? Number(match[6]) : 0;
                const ms = match[7] ? Number(match[7].padEnd(3, '0')) : 0;
                const localDate = year >= 0 && year <= 99
                    ? (() => {
                        const d = new Date(2000, month, day, hour, minute, second, ms);
                        d.setFullYear(year);
                        return d;
                    })()
                    : new Date(year, month, day, hour, minute, second, ms);
                return isValid(localDate) ? localDate : null;
            }
        }
        const date = parseISO(dateStr);
        return isValid(date) ? date : null;
    } catch {
        return null;
    }
}

/**
 * Returns true if the provided date string includes an explicit time component.
 */
export function hasTimeComponent(dateStr: string | undefined | null): boolean {
    if (!dateStr) return false;
    return /[T\s]\d{2}:\d{2}/.test(dateStr);
}

/**
 * Parses a due date string. If no time component is present, treat it as end-of-day.
 */
export function safeParseDueDate(dateStr: string | undefined | null): Date | null {
    const parsed = safeParseDate(dateStr);
    if (!parsed) return null;
    if (!hasTimeComponent(dateStr)) {
        parsed.setHours(23, 59, 59, 999);
    }
    return parsed;
}

/**
 * Returns true when the review date is set and due at or before the provided time.
 */
export function isDueForReview(reviewAt: string | Date | undefined | null, now: Date = new Date()): boolean {
    if (!reviewAt) return false;
    const date = typeof reviewAt === 'string' ? safeParseDate(reviewAt) : reviewAt;
    if (!date || !isValid(date)) return false;
    return date.getTime() <= now.getTime();
}
