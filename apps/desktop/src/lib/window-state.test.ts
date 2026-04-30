import { describe, expect, it } from 'vitest';

import { FULLSCREEN_STORAGE_KEY, loadStoredFullscreen, saveStoredFullscreen } from './window-state';

const createStorage = () => {
    const data = new Map<string, string>();
    return {
        getItem(key: string) {
            return data.has(key) ? data.get(key)! : null;
        },
        setItem(key: string, value: string) {
            data.set(key, value);
        },
        removeItem(key: string) {
            data.delete(key);
        },
    };
};

describe('window-state helpers', () => {
    it('loads fullscreen state only when truthy values are stored', () => {
        const storage = createStorage();

        expect(loadStoredFullscreen(storage)).toBe(false);

        storage.setItem(FULLSCREEN_STORAGE_KEY, 'true');
        expect(loadStoredFullscreen(storage)).toBe(true);

        storage.setItem(FULLSCREEN_STORAGE_KEY, 'false');
        expect(loadStoredFullscreen(storage)).toBe(false);
    });

    it('saves fullscreen state by setting or clearing the storage key', () => {
        const storage = createStorage();

        saveStoredFullscreen(true, storage);
        expect(storage.getItem(FULLSCREEN_STORAGE_KEY)).toBe('true');

        saveStoredFullscreen(false, storage);
        expect(storage.getItem(FULLSCREEN_STORAGE_KEY)).toBeNull();
    });
});
