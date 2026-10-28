import { afterEach, describe, expect, it } from 'vitest';

import { installWorkspaceStorageScope } from './workspace-storage-scope';

const WORK = '0123456789abcdef';

function memoryStorage(): Storage {
    const values = new Map<string, string>();
    return {
        get length() {
            return values.size;
        },
        clear: () => values.clear(),
        getItem: (key) => values.get(key) ?? null,
        key: (index) => Array.from(values.keys())[index] ?? null,
        removeItem: (key) => {
            values.delete(key);
        },
        setItem: (key, value) => {
            values.set(key, String(value));
        },
    };
}

function fakeWindow(storage: Storage): Window {
    const target = {} as Window;
    Object.defineProperty(target, 'localStorage', { configurable: true, get: () => storage });
    return target;
}

afterEach(() => {
    delete window.__MINDWTR_WORKSPACE_ID__;
});

describe('workspace storage scope', () => {
    it('leaves the default workspace on today\'s unprefixed keys', () => {
        const storage = memoryStorage();
        const target = fakeWindow(storage);
        expect(installWorkspaceStorageScope(target)).toBe(false);
        expect(target.localStorage).toBe(storage);
    });

    it('gives another workspace its own keys and keeps device keys shared', () => {
        const storage = memoryStorage();
        storage.setItem('mindwtr-fast-sync-state-v1', 'personal');
        storage.setItem('mindwtr:webview-zoom:v1', '1.2');
        window.__MINDWTR_WORKSPACE_ID__ = WORK;
        const target = fakeWindow(storage);

        expect(installWorkspaceStorageScope(target)).toBe(true);
        const scoped = target.localStorage;
        expect(scoped.getItem('mindwtr-fast-sync-state-v1')).toBeNull();
        expect(scoped.getItem('mindwtr:webview-zoom:v1')).toBe('1.2');

        scoped.setItem('mindwtr-fast-sync-state-v1', 'work');
        scoped.setItem('mindwtr:announcement-dismissed:x', 'dismissed');
        expect(storage.getItem(`workspace:${WORK}:mindwtr-fast-sync-state-v1`)).toBe('work');
        expect(storage.getItem('mindwtr-fast-sync-state-v1')).toBe('personal');
        expect(storage.getItem('mindwtr:announcement-dismissed:x')).toBe('dismissed');

        scoped.removeItem('mindwtr-fast-sync-state-v1');
        expect(storage.getItem(`workspace:${WORK}:mindwtr-fast-sync-state-v1`)).toBeNull();
        expect(storage.getItem('mindwtr-fast-sync-state-v1')).toBe('personal');
    });
});
