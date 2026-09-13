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
import { ar, cs, de, enGB, enUS, es, faIR, fr, hi, hu, it, ja, ko, nl, pl, ptBR, ru, sv, tr, vi, zhCN, zhTW } from 'date-fns/locale';
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
export const QUICK_DATE_PRESETS_EXTENDED = ['today', 'tomorrow', 'in_2_days', 'in_3_days', 'next_week', 'next_month', 'no_date'] as const;
export type QuickDatePreset = typeof QUICK_DATE_PRESETS_EXTENDED[number];
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
    fa: faIR,
    sv,
    hu,
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
    // Brazilian, to match the date-fns locale above. Portuguese has one entry in
    // the language list, so both formatting paths have to pick the same regional
    // conventions; this one was previously 'pt-PT' while date-fns used ptBR.
    pt: 'pt-BR',
    pl: 'pl-PL',
    cs: 'cs-CZ',
    fa: 'fa-IR',
    ko: 'ko-KR',
    it: 'it-IT',
    tr: 'tr-TR',
    nl: 'nl-NL',
    sv: 'sv-SE',
    hu: 'hu-HU',
};

let activeLocale: Locale = DEFAULT_LOCALE;
let activeDateFormatSetting: DateFormatSetting = 'system';
let activeTimeFormatSetting: TimeFormatSetting = 'system';
let activeCalendarSystem: CalendarSystemSetting = 'gregorian';
let activeLanguage: Language = 'en';

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

// CLDR weekData firstDay: regions not listed here start the week on Monday.
const SUNDAY_FIRST_REGIONS = new Set([
    'AG', 'AS', 'BD', 'BR', 'BS', 'BT', 'BW', 'BZ', 'CA', 'CO', 'DM', 'DO', 'ET',
    'GT', 'GU', 'HK', 'HN', 'ID', 'IL', 'IN', 'JM', 'JP', 'KE', 'KH', 'KR', 'LA',
    'MH', 'MM', 'MO', 'MT', 'MX', 'MZ', 'NI', 'NP', 'PA', 'PE', 'PH', 'PK', 'PR',
    'PT', 'PY', 'SA', 'SG', 'SV', 'TH', 'TT', 'TW', 'UM', 'US', 'VE', 'VI', 'WS',
    'YE', 'ZA', 'ZW',
]);
const SATURDAY_FIRST_REGIONS = new Set([
    'AE', 'AF', 'BH', 'DJ', 'DZ', 'EG', 'IQ', 'IR', 'JO', 'KW', 'LY', 'OM', 'QA',
    'SD', 'SY',
]);

function regionWeekStart(region: string): WeekStartSetting {
    if (SATURDAY_FIRST_REGIONS.has(region)) return 'saturday';
    if (SUNDAY_FIRST_REGIONS.has(region)) return 'sunday';
    return 'monday';
}

/**
 * Week start inferred from the device locale, so calendars look right without
 * a setting. Uses Intl week info when the runtime provides it and falls back
 * to CLDR region data parsed from the locale tag.
 */
export function getSystemWeekStart(localeInput?: string | null): WeekStartSetting {
    let locale = typeof localeInput === 'string' && localeInput.trim() ? localeInput.trim() : '';
    if (!locale) {
        try {
            if (typeof navigator !== 'undefined' && typeof navigator.language === 'string' && navigator.language) {
                locale = navigator.language;
            } else {
                locale = Intl.DateTimeFormat().resolvedOptions().locale ?? '';
            }
        } catch {
            locale = '';
        }
    }
    if (!locale) return 'monday';
    try {
        const intlLocale = new Intl.Locale(locale);
        const weekInfo = (intlLocale as { getWeekInfo?: () => { firstDay?: number } }).getWeekInfo?.()
            ?? (intlLocale as { weekInfo?: { firstDay?: number } }).weekInfo;
        if (weekInfo?.firstDay === 7) return 'sunday';
        if (weekInfo?.firstDay === 6) return 'saturday';
        if (typeof weekInfo?.firstDay === 'number') return 'monday';
        const region = intlLocale.maximize?.().region ?? intlLocale.region;
        if (region) return regionWeekStart(region.toUpperCase());
    } catch {
        // Fall through to plain locale-tag parsing below.
    }
    const match = locale.match(/[-_]([A-Za-z]{2})(?:[-_]|$)/);
    if (match) return regionWeekStart(match[1].toUpperCase());
    return 'monday';
}

export type WeekStartPreference = WeekStartSetting | 'system';

/** The stored preference, for settings UIs: explicit day or 'system'. */
export function normalizeWeekStartPreference(value?: string | null): WeekStartPreference {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'monday') return 'monday';
    if (normalized === 'saturday') return 'saturday';
    if (normalized === 'sunday') return 'sunday';
    return 'system';
}

/** The resolved week start: explicit setting wins, otherwise the device locale decides. */
export function normalizeWeekStartSetting(value?: string | null): WeekStartSetting {
    const preference = normalizeWeekStartPreference(value);
    if (preference !== 'system') return preference;
    return getSystemWeekStart();
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
        case 'in_2_days':
            return addDays(today, 2);
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
    activeLanguage = language;

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
 * Whether ambiguous slash dates ("10/8") read day-first under the active date
 * format. Explicit dmy says yes; mdy and ymd say no; System derives it from
 * the resolved locale's short-date order (#1006).
 */
export function isActiveDateFormatDayFirst(): boolean {
    if (activeDateFormatSetting === 'dmy') return true;
    if (activeDateFormatSetting === 'mdy' || activeDateFormatSetting === 'ymd') return false;
    try {
        const sample = format(new Date(2001, 10, 22), 'P', { locale: activeLocale });
        const dayIndex = sample.indexOf('22');
        const monthIndex = sample.indexOf('11');
        return dayIndex !== -1 && monthIndex !== -1 && dayIndex < monthIndex;
    } catch {
        return false;
    }
}

/** The app language quick-add's locale date parsing is keyed off (#1059). */
export function getActiveLanguage(): Language {
    return activeLanguage;
}

/**
 * Wide and abbreviated month names for a language, read off the same
 * date-fns locale table `configureDateFormatting` uses — so quick-add's
 * bare-month-name skip doesn't need its own copy of the locale map (#1059).
 */
export function getMonthNamesForLanguage(language: Language): string[] {
    const locale = DATE_LOCALE_BY_LANGUAGE[language];
    if (!locale?.localize) return [];
    const names: string[] = [];
    for (let month = 0; month < 12; month += 1) {
        const monthIndex = month as Parameters<Locale['localize']['month']>[0];
        for (const width of ['wide', 'abbreviated'] as const) {
            names.push(locale.localize.month(monthIndex, { width }));
            // Declining languages inflect months inside a date ("января" in
            // Russian) differently from the standalone default above; chrono
            // matches the inflected forms too, so both belong in the set.
            names.push(locale.localize.month(monthIndex, { width, context: 'formatting' }));
        }
    }
    return names;
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

const shortWeekdayLabelsCache = new Map<string, string[]>();
// A Sunday, local-time construction so the day-of-week cycle below is
// timezone-safe (matches how existing weekday-header call sites already
// build their reference date).
const WEEKDAY_LABEL_ANCHOR_SUNDAY = new Date(2023, 0, 1);

function formatWeekdayLabels(locale: string | undefined, width: 'short' | 'narrow'): string[] {
    const formatter = new Intl.DateTimeFormat(locale, { weekday: width });
    return Array.from({ length: 7 }, (_, day) => {
        const date = new Date(WEEKDAY_LABEL_ANCHOR_SUNDAY);
        date.setDate(date.getDate() + day);
        return formatter.format(date);
    });
}

/**
 * Locale-appropriate weekday labels for a fixed-width 7-column header
 * (calendar mini-picker, week view). Index 0 is Sunday, so a caller with a
 * `Date` can index by `date.getDay()`, and a caller rendering its own
 * week-start rotation can index by `(weekStartIndex + i) % 7`.
 *
 * `Intl.DateTimeFormat`'s "short" weekday form is not translated by us — it's
 * whatever CLDR calls abbreviated for that locale, and for some locales
 * (pt-PT, ar, pl, vi, hi) that is too wide for a 7-column grid, or even the
 * full word (#929). Strip trailing periods, and if a label is still over
 * three characters, truncate every label to three graphemes — unless that
 * truncation makes two labels collide (ar, vi), in which case fall back to
 * `weekday: 'narrow'` for the whole set instead.
 */
export function getShortWeekdayLabels(locale?: string): string[] {
    const cacheKey = locale ?? '';
    const cached = shortWeekdayLabelsCache.get(cacheKey);
    if (cached) return cached;

    const short = formatWeekdayLabels(locale, 'short').map((label) => label.replace(/\.+$/, ''));
    let labels = short;
    if (short.some((label) => [...label].length > 3)) {
        const truncated = short.map((label) => [...label].slice(0, 3).join(''));
        const distinct = new Set(truncated).size === truncated.length;
        labels = distinct ? truncated : formatWeekdayLabels(locale, 'narrow');
    }

    shortWeekdayLabelsCache.set(cacheKey, labels);
    return labels;
}

/**
 * The exact shape every timestamp core stamps has (`new Date().toISOString()`),
 * and the one the engine parses natively. `parseISO` accepts a much wider
 * grammar and walks it by hand, which cost two thirds of the whole derived-state
 * rebuild at a few thousand tasks (#766). Anything that does not match this —
 * date-only values above all, whose local-midnight handling lives below — falls
 * through to the general path unchanged.
 */
const ISO_INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isGregorianLeapYear(year: number): boolean {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

// month is 1-indexed, matching the pattern's capture group.
function isValidCalendarDate(year: number, month: number, day: number): boolean {
    if (month < 1 || month > 12) return false;
    const max = month === 2 && isGregorianLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
    return day >= 1 && day <= max;
}

/**
 * Safely parses a date string to a Date object.
 * Returns null if invalid.
 */
export function safeParseDate(dateStr: string | undefined | null): Date | null {
    if (!dateStr) return null;
    try {
        const instantMatch = ISO_INSTANT_PATTERN.exec(dateStr);
        // `Date.parse` rolls calendar-invalid instants like 2023-02-30 into
        // a neighboring day instead of rejecting them; reject them here,
        // cheaply, before taking the fast path.
        if (instantMatch && isValidCalendarDate(Number(instantMatch[1]), Number(instantMatch[2]), Number(instantMatch[3]))) {
            const parsed = Date.parse(dateStr);
            // A NaN here means the engine declined a string this pattern
            // accepted; the general path below still gets its turn.
            if (Number.isFinite(parsed)) return new Date(parsed);
        }
        const hasTimezone = /Z$|[+-]\d{2}:?\d{2}$/.test(dateStr);
        if (!hasTimezone) {
            const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2})(?::(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?)?$/.exec(dateStr);
            if (match) {
                const year = Number(match[1]);
                const month = Number(match[2]) - 1;
                const day = Number(match[3]);
                // `new Date(y, m, d)` rolls 2024-02-31 into March 2 rather than
                // rejecting it, same trap as the instant fast path above.
                if (!isValidCalendarDate(year, month + 1, day)) return null;
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
