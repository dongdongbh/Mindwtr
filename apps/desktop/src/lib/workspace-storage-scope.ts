


export const DEFAULT_WORKSPACE_ID = 'default';

declare global {
    interface Window {

        __MINDWTR_WORKSPACE_ID__?: string;
    }
}


export function getActiveWorkspaceId(): string {
    if (typeof window === 'undefined') return DEFAULT_WORKSPACE_ID;
    const id = window.__MINDWTR_WORKSPACE_ID__;
    return typeof id === 'string' && id.trim() ? id : DEFAULT_WORKSPACE_ID;
}


const DEVICE_KEYS = new Set([
    'mindwtr-window-fullscreen',
    'mindwtr:webview-zoom:v1',
    'mindwtr:desktop:first-run-onboarding:v1',
    'mindwtr-update-available',
    'mindwtr-update-last-check',
    'mindwtr-update-latest',
    'mindwtr-analytics-distinct-id',
    'mindwtr-analytics-last-heartbeat-day',
    'mindwtr-analytics-opt-out-sent',
]);
const DEVICE_KEY_PREFIXES = ['mindwtr:announcement-dismissed:'];

export function isDeviceStorageKey(key: string): boolean {
    return DEVICE_KEYS.has(key) || DEVICE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function workspaceStoragePrefix(workspaceId: string): string {
    return workspaceId === DEFAULT_WORKSPACE_ID ? '' : `workspace:${workspaceId}:`;
}

export function createWorkspaceStorage(storage: Storage, prefix: string): Storage {
    const stored = (key: string) => (isDeviceStorageKey(key) ? key : prefix + key);
    const visibleKeys = () => {
        const keys: string[] = [];
        for (let index = 0; index < storage.length; index += 1) {
            const key = storage.key(index);
            if (key === null) continue;
            if (key.startsWith(prefix)) keys.push(key.slice(prefix.length));
            else if (isDeviceStorageKey(key)) keys.push(key);
        }
        return keys;
    };
    return {
        get length() {
            return visibleKeys().length;
        },
        clear() {
            visibleKeys().forEach((key) => storage.removeItem(stored(key)));
        },
        getItem: (key) => storage.getItem(stored(key)),
        key: (index) => visibleKeys()[index] ?? null,
        removeItem: (key) => storage.removeItem(stored(key)),
        setItem: (key, value) => storage.setItem(stored(key), value),
    };
}


export function installWorkspaceStorageScope(target: Window = window): boolean {
    const prefix = workspaceStoragePrefix(getActiveWorkspaceId());
    if (!prefix) return false;
    let storage: Storage;
    try {
        storage = target.localStorage;
    } catch {
        return false;
    }
    const scoped = createWorkspaceStorage(storage, prefix);
    try {
        Object.defineProperty(target, 'localStorage', { configurable: true, get: () => scoped });
    } catch {
        return false;
    }
    return target.localStorage === scoped;
}


export const workspaceStorageScopeFailed = typeof window !== 'undefined'
    && getActiveWorkspaceId() !== DEFAULT_WORKSPACE_ID
    && !installWorkspaceStorageScope();
