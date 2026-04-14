import {
    normalizeDateFormatSetting,
    normalizeTimeFormatSetting,
    resolveDateLocaleTag,
} from '@mindwtr/core';

type NativeDateInputLocaleParams = {
    language?: string | null;
    dateFormat?: string | null;
    timeFormat?: string | null;
    weekStart?: 'monday' | 'sunday' | null;
    systemLocale?: string | null;
};

const YMD_NATIVE_LOCALE_BY_LANGUAGE: Record<string, string> = {
    en: 'en-CA',
    fr: 'fr-CA',
    zh: 'zh-CN',
    'zh-Hant': 'zh-TW',
    ja: 'ja-JP',
    ko: 'ko-KR',
};

const normalizeLocaleTag = (value?: string | null): string => String(value || '').trim().replace(/_/g, '-');

const normalizeLanguageKey = (value?: string | null): string => {
    const normalized = normalizeLocaleTag(value);
    if (!normalized) return 'en';
    const lower = normalized.toLowerCase();
    if (lower === 'zh-hant' || lower.startsWith('zh-hant')) return 'zh-Hant';
    if (lower.startsWith('zh')) return 'zh';
    return lower.split('-')[0] || 'en';
};

export function resolveNativeDateInputLocale(params: NativeDateInputLocaleParams): string {
    const dateFormat = normalizeDateFormatSetting(params.dateFormat);
    const timeFormat = normalizeTimeFormatSetting(params.timeFormat);
    const systemLocale = normalizeLocaleTag(params.systemLocale) || undefined;
    const normalizedLanguage = normalizeLanguageKey(params.language);

    let baseLocale = resolveDateLocaleTag({
        language: params.language,
        dateFormat,
        systemLocale,
    });

    if (dateFormat === 'ymd') {
        baseLocale = YMD_NATIVE_LOCALE_BY_LANGUAGE[normalizedLanguage] ?? baseLocale;
    }

    const unicodePreferences: string[] = [];
    if (timeFormat === '24h') {
        unicodePreferences.push('hc-h23');
    } else if (timeFormat === '12h') {
        unicodePreferences.push('hc-h12');
    }
    if (params.weekStart === 'monday') {
        unicodePreferences.push('fw-mon');
    } else if (params.weekStart === 'sunday') {
        unicodePreferences.push('fw-sun');
    }

    if (unicodePreferences.length === 0) {
        return baseLocale;
    }

    return `${baseLocale}-u-${unicodePreferences.join('-')}`;
}
