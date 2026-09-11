import AsyncStorage from '@react-native-async-storage/async-storage';
import { isSandboxMode, LANGUAGE_STORAGE_KEY, type AppSettings } from '@mindwtr/core';

const sandboxValues = new Map<string, string>();
const MOBILE_THEME_STORAGE_KEY = '@mindwtr_theme';

export const seedSandboxSessionStorage = (settings: AppSettings): void => {
    sandboxValues.clear();
    if (settings.language) sandboxValues.set(LANGUAGE_STORAGE_KEY, settings.language);
    if (settings.theme) sandboxValues.set(MOBILE_THEME_STORAGE_KEY, settings.theme);
};

/**
 * UI convenience state must not read or overwrite the personal profile while
 * the disposable workspace is mounted. The sandbox side lives only for this
 * JS runtime and disappears with the reload used to leave/reset it.
 */
export const workspaceSessionStorage = {
    getItem(key: string): Promise<string | null> {
        if (isSandboxMode()) return Promise.resolve(sandboxValues.get(key) ?? null);
        return AsyncStorage.getItem(key);
    },
    setItem(key: string, value: string): Promise<void> {
        if (isSandboxMode()) {
            sandboxValues.set(key, value);
            return Promise.resolve();
        }
        return AsyncStorage.setItem(key, value);
    },
    removeItem(key: string): Promise<void> {
        if (isSandboxMode()) {
            sandboxValues.delete(key);
            return Promise.resolve();
        }
        return AsyncStorage.removeItem(key);
    },
};
