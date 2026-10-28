import { create } from 'zustand';
import { MOBILE_APP_LOCK_RELOCK_DELAY_OPTIONS, resolveMobileAppLockRelockDelayMinutes, type MobileAppLockRelockDelayMinutes } from '@mindwtr/core';
import { logInfo, logWarn } from './app-log';
import { isTauriRuntime } from './runtime';
import { invokeNative, invokeNativeOr } from './tauri-invoke';

/**
 * Desktop privacy lock (#1472). Rust owns the setting (device-level config.toml)
 * and the process-wide lock flag, so the tray and Quick Add can refuse task text
 * on their own; this store mirrors it for the lock screen and the timers.
 */

export type AppLockTrigger = 'startup' | 'manual' | 'away' | 'idle';
export type AppLockOutcome = 'success' | 'cancelled' | 'failed' | 'unavailable';
export type AppLockAvailability = { supported: boolean; available: boolean };

/** Same delay choices as mobile App Lock: 0 locks as soon as focus leaves Mindwtr. */
export const APP_LOCK_RELOCK_DELAY_OPTIONS = MOBILE_APP_LOCK_RELOCK_DELAY_OPTIONS;

type AppLockStoreState = {
    enabled: boolean;
    relockDelayMinutes: MobileAppLockRelockDelayMinutes;
    locked: boolean;
    /** What locked it this time; the lock screen auto-prompts only for startup/away. */
    trigger: AppLockTrigger | null;
    /** The OS prompt is open (the Unlock button waits). */
    authInFlight: boolean;
};

const initialState: AppLockStoreState = {
    enabled: false,
    relockDelayMinutes: 0,
    locked: false,
    trigger: null,
    authInFlight: false,
};

export const useAppLockStore = create<AppLockStoreState>(() => ({ ...initialState }));

const RELEASE_CHECK = 'v1.3.8/desktop-app-lock';

function logLockEvent(message: string, extra: Record<string, string>): void {
    void logInfo(message, { scope: 'app-lock', force: true, extra: { releaseCheck: RELEASE_CHECK, ...extra } });
}

type NativeAppLockState = { enabled: boolean; relockDelayMinutes: number; locked: boolean };

function applyNativeState(state: NativeAppLockState): void {
    useAppLockStore.setState({
        enabled: state.enabled === true,
        relockDelayMinutes: resolveMobileAppLockRelockDelayMinutes(state.relockDelayMinutes),
        locked: state.locked === true,
    });
}

/**
 * Read before the main window's first render, so a launch with the lock on
 * paints the lock screen first and never the task list.
 */
export async function loadAppLockState(): Promise<void> {
    if (!isTauriRuntime()) return;
    try {
        applyNativeState(await invokeNative<NativeAppLockState>('get_app_lock_state'));
        if (useAppLockStore.getState().locked) {
            useAppLockStore.setState({ trigger: 'startup' });
            logLockEvent('App lock engaged', { trigger: 'startup' });
        }
    } catch (error) {
        // Fail closed: show the lock screen. Unlock (or, when no OS check is
        // possible, Turn off app lock) still reaches Rust and lets the owner in.
        useAppLockStore.setState({ enabled: true, locked: true, trigger: 'startup' });
        void logWarn('App lock state unavailable', {
            scope: 'app-lock',
            extra: { error: error instanceof Error ? error.message : String(error) },
        });
    }
}

export const isAppLocked = (): boolean => useAppLockStore.getState().locked;

export function lockApp(trigger: Exclude<AppLockTrigger, 'startup'>): void {
    const state = useAppLockStore.getState();
    if (!state.enabled || state.locked) return;
    useAppLockStore.setState({ locked: true, trigger });
    logLockEvent('App lock engaged', { trigger });
    void invokeNative('app_lock_engage').catch((error) => {
        void logWarn('App lock engage failed', {
            scope: 'app-lock',
            extra: { error: error instanceof Error ? error.message : String(error) },
        });
    });
}

async function runOsCheck(command: string, args: Record<string, unknown>): Promise<AppLockOutcome> {
    if (useAppLockStore.getState().authInFlight) return 'cancelled';
    useAppLockStore.setState({ authInFlight: true });
    try {
        return await invokeNative<AppLockOutcome>(command, args);
    } catch (error) {
        void logWarn('App lock check failed', {
            scope: 'app-lock',
            extra: { command, error: error instanceof Error ? error.message : String(error) },
        });
        return 'failed';
    } finally {
        useAppLockStore.setState({ authInFlight: false });
    }
}

/** `reason` is the localized line the Windows Hello / Touch ID prompt shows. */
export async function unlockApp(reason: string): Promise<AppLockOutcome> {
    const outcome = await runOsCheck('app_lock_authenticate', { reason });
    if (outcome === 'success') useAppLockStore.setState({ locked: false, trigger: null });
    logLockEvent('App lock unlock attempt', { outcome });
    return outcome;
}

/** Turning the lock on runs one OS check first (inside the Rust command). */
export async function setAppLockEnabled(enabled: boolean, reason: string): Promise<AppLockOutcome> {
    const outcome = await runOsCheck('set_app_lock_enabled', { enabled, reason });
    if (outcome === 'success') useAppLockStore.setState({ enabled, ...(enabled ? {} : { locked: false, trigger: null }) });
    logLockEvent('App lock setting changed', { outcome, enabled: String(enabled) });
    return outcome;
}

/**
 * After an `unavailable` check: Rust re-checks availability itself and turns
 * the lock off (and unlocks) only when the OS says no check is possible. Rust
 * logs the outcome. `failed` means the check is available again: stay locked.
 */
export async function turnOffAppLockWhenUnavailable(): Promise<AppLockOutcome> {
    let outcome: AppLockOutcome;
    try {
        outcome = await invokeNative<AppLockOutcome>('app_lock_disable_unavailable');
    } catch (error) {
        void logWarn('App lock turn-off failed', {
            scope: 'app-lock',
            extra: { error: error instanceof Error ? error.message : String(error) },
        });
        return 'failed';
    }
    if (outcome === 'success') useAppLockStore.setState({ enabled: false, locked: false, trigger: null });
    return outcome;
}

/** A lock Rust engaged (tray item, away timer): Rust logged it already. */
export function applyNativeEngage(trigger: string): void {
    const state = useAppLockStore.getState();
    if (!state.enabled || state.locked) return;
    useAppLockStore.setState({ locked: true, trigger: trigger === 'away' ? 'away' : 'manual' });
}

export async function setAppLockRelockDelay(minutes: MobileAppLockRelockDelayMinutes): Promise<void> {
    applyNativeState(await invokeNative<NativeAppLockState>('set_app_lock_relock_delay', { minutes }));
}

export async function getAppLockAvailability(): Promise<AppLockAvailability> {
    if (!isTauriRuntime()) return { supported: false, available: false };
    try {
        return await invokeNative<AppLockAvailability>('app_lock_availability');
    } catch {
        return { supported: false, available: false };
    }
}

/**
 * Marks a Mindwtr-owned native dialog as open, in Rust, so every window's
 * away timer sees it and its focus loss does not count as leaving.
 */
export async function withMindwtrDialog<T>(run: () => Promise<T>): Promise<T> {
    const mark = async (command: string) => {
        try {
            await invokeNativeOr(undefined, command);
        } catch {
            // The lock's bookkeeping must never stop a file dialog.
        }
    };
    await mark('app_lock_dialog_begin');
    try {
        return await run();
    } finally {
        void mark('app_lock_dialog_end');
    }
}

let keyboardGuardInstalled = false;

const BROWSER_FUNCTION_KEY = /^F([1-9]|1[0-9]|2[0-4])$/;

/**
 * While locked, a key with Ctrl, Cmd or Alt, or a function key, could run a
 * WebView2 browser action (Ctrl+P prints the page beneath, F5 reloads, Ctrl+F
 * finds). Plain Tab, Enter, Space and Escape still work on the lock screen.
 */
export function isBlockedWhileLocked(event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey'>): boolean {
    return event.ctrlKey || event.metaKey || event.altKey || BROWSER_FUNCTION_KEY.test(event.key);
}

/**
 * While locked, no app keyboard shortcut may run beneath the lock screen, no
 * browser action may run (print, find, reload), and no context menu opens.
 * Must be installed before any other window listener (first thing in
 * bootstrap): a window capture listener runs first and stops the rest.
 */
export function installAppLockKeyboardGuard(): void {
    if (keyboardGuardInstalled || typeof window === 'undefined') return;
    keyboardGuardInstalled = true;
    const guard = (event: KeyboardEvent) => {
        if (!isAppLocked()) return;
        event.stopImmediatePropagation();
        if (isBlockedWhileLocked(event)) event.preventDefault();
    };
    (['keydown', 'keyup', 'keypress'] as const).forEach((name) => window.addEventListener(name, guard, true));
    window.addEventListener('contextmenu', (event) => {
        if (!isAppLocked()) return;
        event.stopImmediatePropagation();
        event.preventDefault();
    }, true);
}

type IdleTrackerOptions = {
    now?: () => number;
    /** Whether the main window itself has focus (idle input only counts there). */
    isMainFocused?: () => boolean;
};

/**
 * The idle lock: no keyboard or mouse input in the focused main window for
 * the relock delay (delay 0 has no idle lock). The away lock (no Mindwtr
 * window focused) runs in Rust, so a hidden window still locks on time.
 */
export function createAppLockIdleTracker(options: IdleTrackerOptions = {}) {
    const now = options.now ?? (() => Date.now());
    const isMainFocused = options.isMainFocused ?? (() => typeof document === 'undefined' || document.hasFocus());
    let lastInputAt = now();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    const delayMs = () => useAppLockStore.getState().relockDelayMinutes * 60_000;
    const active = () => {
        const state = useAppLockStore.getState();
        return state.enabled && !state.locked;
    };

    const checkIdle = () => {
        idleTimer = undefined;
        const delay = delayMs();
        if (delay === 0 || !active()) return;
        // Time spent in another window, a dialog or the OS prompt is not idle.
        if (!isMainFocused() || useAppLockStore.getState().authInFlight) lastInputAt = now();
        const remaining = delay - (now() - lastInputAt);
        if (remaining > 0) {
            idleTimer = setTimeout(checkIdle, remaining);
            return;
        }
        lockApp('idle');
    };

    const armIdle = () => {
        if (idleTimer !== undefined || delayMs() === 0 || !active()) return;
        lastInputAt = now();
        idleTimer = setTimeout(checkIdle, delayMs());
    };

    const unsubscribe = useAppLockStore.subscribe((state, previous) => {
        if (state.relockDelayMinutes !== previous.relockDelayMinutes) {
            clearTimeout(idleTimer);
            idleTimer = undefined;
        }
        armIdle();
    });
    armIdle();

    return {
        input() {
            lastInputAt = now();
        },
        dispose() {
            unsubscribe();
            clearTimeout(idleTimer);
        },
    };
}

export const resetAppLockStoreForTests = (state: Partial<AppLockStoreState> = {}): void => {
    useAppLockStore.setState({ ...initialState, ...state });
};
