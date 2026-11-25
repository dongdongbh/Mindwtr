import {
    configureDateFormatting,
    createDateFormatter,
    getDateFormattingConfig,
    setHostSystemLocale,
    type DateFormattingConfig,
} from '@mindwtr/core';
import { invokeNative } from './tauri-invoke';

let windowsRegion: [string, string] | null = null;

export async function loadWindowsRegionalDate(): Promise<void> {
    windowsRegion = await invokeNative<[string, string] | null>('get_windows_regional_date').catch(() => null);
}

export function getSystemShortDatePattern(): string | undefined {
    return windowsRegion?.[1];
}

export function getSystemDateFormatting(): { systemLocale: string; systemDateFormat?: string } {
    const systemLocale = getSystemDefaultLocale();
    const systemDateFormat = getSystemShortDatePattern();
    return systemDateFormat ? { systemLocale, systemDateFormat } : { systemLocale };
}

export function syncDesktopDateFormatting(
    overrides: Omit<DateFormattingConfig, 'systemLocale' | 'systemDateFormat'> = {},
): boolean {
    const systemFormatting = getSystemDateFormatting();
    const nextConfig: DateFormattingConfig = { ...overrides, ...systemFormatting };
    const current = getDateFormattingConfig();
    const changed = current.language !== nextConfig.language
        || current.dateFormat !== nextConfig.dateFormat
        || current.calendarSystem !== nextConfig.calendarSystem
        || current.timeFormat !== nextConfig.timeFormat
        || current.systemLocale !== nextConfig.systemLocale
        || current.systemDateFormat !== nextConfig.systemDateFormat;
    setHostSystemLocale(systemFormatting.systemLocale || null);
    configureDateFormatting(nextConfig);
    return changed;
}

export function systemShortDateExample(date: Date): string {
    if (!windowsRegion) return date.toLocaleDateString();
    return createDateFormatter(getSystemDateFormatting())(date, 'P');
}

export function getSystemDefaultLocale(): string {
    if (windowsRegion) return windowsRegion[0];
    if (typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function') {
        const locale = Intl.DateTimeFormat().resolvedOptions().locale;
        if (locale) return locale;
    }
    if (typeof navigator !== 'undefined') {
        return String(navigator.languages?.[0] || navigator.language || '').trim();
    }
    return '';
}
