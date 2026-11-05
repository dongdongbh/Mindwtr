export function getSystemDefaultLocale(): string {
    if (typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function') {
        const locale = Intl.DateTimeFormat().resolvedOptions().locale;
        if (locale) return locale;
    }
    if (typeof navigator !== 'undefined') {
        return String(navigator.languages?.[0] || navigator.language || '').trim();
    }
    return '';
}
