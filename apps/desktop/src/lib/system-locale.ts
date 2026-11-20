import { createDateFormatter } from '@mindwtr/core';
import { invokeNative } from './tauri-invoke';

let windowsRegion: [string, string] | null = null;

export async function loadWindowsRegionalDate(): Promise<void> {
    windowsRegion = await invokeNative<[string, string] | null>('get_windows_regional_date').catch(() => null);
}

export function getSystemShortDatePattern(): string | undefined {
    return windowsRegion?.[1];
}

export function systemShortDateExample(date: Date): string {
    if (!windowsRegion) return date.toLocaleDateString();
    return createDateFormatter({ systemLocale: windowsRegion[0], systemDateFormat: windowsRegion[1] })(date, 'P');
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
