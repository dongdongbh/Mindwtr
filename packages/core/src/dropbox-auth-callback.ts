export const DROPBOX_NATIVE_REDIRECT_URI = 'mindwtr://redirect';
export const DROPBOX_CALLBACK_SETTINGS_PATH = '/settings?settingsScreen=sync';

const DROPBOX_CALLBACK_TARGETS = new Set([
    DROPBOX_NATIVE_REDIRECT_URI,
    `${DROPBOX_NATIVE_REDIRECT_URI}/`,
    'mindwtr:///redirect',
    'mindwtr:///redirect/',
]);


export function isDropboxAuthCallbackUrl(value: string): boolean {
    const queryIndex = value.indexOf('?');
    const fragmentIndex = value.indexOf('#');
    const suffixIndexes = [queryIndex, fragmentIndex].filter((index) => index >= 0);
    const suffixIndex = suffixIndexes.length > 0 ? Math.min(...suffixIndexes) : value.length;
    return DROPBOX_CALLBACK_TARGETS.has(value.slice(0, suffixIndex));
}
