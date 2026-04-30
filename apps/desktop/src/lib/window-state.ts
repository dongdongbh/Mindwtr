type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const FULLSCREEN_STORAGE_KEY = 'mindwtr-window-fullscreen';

function parseStoredBoolean(value: string | null | undefined): boolean {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

export function loadStoredFullscreen(storage?: StorageLike | null): boolean {
    if (!storage) return false;
    try {
        return parseStoredBoolean(storage.getItem(FULLSCREEN_STORAGE_KEY));
    } catch {
        return false;
    }
}

export function saveStoredFullscreen(isFullscreen: boolean, storage?: StorageLike | null): void {
    if (!storage) return;
    try {
        if (isFullscreen) {
            storage.setItem(FULLSCREEN_STORAGE_KEY, 'true');
            return;
        }
        storage.removeItem(FULLSCREEN_STORAGE_KEY);
    } catch {
        // Ignore local storage failures and fall back to the current session state.
    }
}
