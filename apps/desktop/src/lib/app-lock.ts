import { create } from 'zustand';
import { MOBILE_APP_LOCK_RELOCK_DELAY_OPTIONS, resolveMobileAppLockRelockDelayMinutes, type MobileAppLockRelockDelayMinutes } from '@mindwtr/core';
import { logInfo, logWarn } from './app-log';
import { isTauriRuntime } from './runtime';
import { invokeNative, invokeNativeOr } from './tauri-invoke';


export type AppLockTrigger = 'startup' | 'manual' | 'away' | 'idle';
export type AppLockOutcome = 'success' | 'cancelled' | 'failed' | 'unavailable';
export type AppLockAvailability = { supported: boolean; available: boolean };


export const APP_LOCK_RELOCK_DELAY_OPTIONS = MOBILE_APP_LOCK_RELOCK_DELAY_OPTIONS;

type AppLockStoreState = {
    enabled: boolean;
    relockDelayMinutes: MobileAppLockRelockDelayMinutes;
    locked: boolean;

    trigger: AppLockTrigger | null;

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


export async function loadAppLockState(): Promise<void> {
    if (!isTauriRuntime()) return;
    try {
        applyNativeState(await invokeNative<NativeAppLockState>('get_app_lock_state'));
        if (useAppLockStore.getState().locked) {
            useAppLockStore.setState({ trigger: 'startup' });
            logLockEvent('App lock engaged', { trigger: 'startup' });
        }
    } catch (error) {


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


export async function unlockApp(reason: string): Promise<AppLockOutcome> {
    const outcome = await runOsCheck('app_lock_authenticate', { reason });
    if (outcome === 'success') useAppLockStore.setState({ locked: false, trigger: null });
    logLockEvent('App lock unlock attempt', { outcome });
    return outcome;
}


export async function setAppLockEnabled(enabled: boolean, reason: string): Promise<AppLockOutcome> {
    const outcome = await runOsCheck('set_app_lock_enabled', { enabled, reason });
    if (outcome === 'success') useAppLockStore.setState({ enabled, ...(enabled ? {} : { locked: false, trigger: null }) });
    logLockEvent('App lock setting changed', { outcome, enabled: String(enabled) });
    return outcome;
}


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


export async function withMindwtrDialog<T>(run: () => Promise<T>): Promise<T> {
    const mark = async (command: string) => {
        try {
            await invokeNativeOr(undefined, command);
        } catch {

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


export function isBlockedWhileLocked(event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey'>): boolean {
    return event.ctrlKey || event.metaKey || event.altKey || BROWSER_FUNCTION_KEY.test(event.key);
}


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

    isMainFocused?: () => boolean;
};


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
