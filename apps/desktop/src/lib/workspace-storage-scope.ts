// Desktop workspaces (#1473) share one webview, so one localStorage. This
// module gives a non-default workspace its own view of it: every key is stored
// under `workspace:<id>:` except the device-level keys below. The default
// workspace keeps today's unprefixed keys, so nothing migrates.
//
// main.tsx imports this module first, so the swap happens before any other
// module reads localStorage. It has no imports for the same reason.

export const DEFAULT_WORKSPACE_ID = 'default';

declare global {
    interface Window {
        /** Set by the native init script before any page script runs. */
        __MINDWTR_WORKSPACE_ID__?: string;
    }
}

/** The workspace this window opened in, known synchronously at startup. */
export function getActiveWorkspaceId(): string {
    if (typeof window === 'undefined') return DEFAULT_WORKSPACE_ID;
    const id = window.__MINDWTR_WORKSPACE_ID__;
    return typeof id === 'string' && id.trim() ? id : DEFAULT_WORKSPACE_ID;
}

/**
 * Keys that describe this computer, not a workspace: window state, first-run
 * and announcement dismissals, update checks and the analytics device id.
 * Everything else (sync fingerprints, view state, setting mirrors) is
 * per-workspace by default, so a new key is isolated unless listed here.
 */
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

/** Returns whether `target.localStorage` is now the workspace's own view. */
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

/** True when a non-default workspace could not get its own localStorage view. */
export const workspaceStorageScopeFailed = typeof window !== 'undefined'
    && getActiveWorkspaceId() !== DEFAULT_WORKSPACE_ID
    && !installWorkspaceStorageScope();
