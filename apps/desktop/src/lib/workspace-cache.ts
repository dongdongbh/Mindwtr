import { isSandboxMode } from '@mindwtr/core';

const sandboxValues = new Map<string, string>();

const sandboxStorage: Storage = {
    get length() {
        return sandboxValues.size;
    },
    clear() {
        sandboxValues.clear();
    },
    getItem(key) {
        return sandboxValues.get(key) ?? null;
    },
    key(index) {
        return Array.from(sandboxValues.keys())[index] ?? null;
    },
    removeItem(key) {
        sandboxValues.delete(key);
    },
    setItem(key, value) {
        sandboxValues.set(key, String(value));
    },
};

/**
 * UI caches in sandbox live only for the current renderer runtime. Outside it,
 * localStorage is already the open workspace's own view (#1473,
 * workspace-storage-scope.ts).
 */
export function getWorkspaceCache(): Storage | null {
    if (isSandboxMode()) return sandboxStorage;
    if (typeof window === 'undefined') return null;
    try {
        return window.localStorage;
    } catch {
        return null;
    }
}
