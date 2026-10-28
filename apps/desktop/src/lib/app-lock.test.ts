import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./runtime', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./runtime')>()),
    isTauriRuntime: () => true,
}));
vi.mock('./app-log', () => ({ logInfo: vi.fn(async () => null), logWarn: vi.fn(async () => null) }));

import { logInfo } from './app-log';
import { setNativeInvokeTransport } from './tauri-invoke';
import {
    applyNativeEngage,
    createAppLockIdleTracker,
    installAppLockKeyboardGuard,
    loadAppLockState,
    resetAppLockStoreForTests,
    setAppLockEnabled,
    turnOffAppLockWhenUnavailable,
    unlockApp,
    useAppLockStore,
    withMindwtrDialog,
} from './app-lock';

const MINUTE = 60_000;
let calls: Array<[string, Record<string, unknown> | undefined]>;
let answer: (command: string) => unknown;

beforeEach(() => {
    vi.useFakeTimers();
    calls = [];
    answer = () => undefined;
    setNativeInvokeTransport(async <T,>(command: string, args?: Record<string, unknown>) => {
        calls.push([command, args]);
        return answer(command) as T;
    });
    resetAppLockStoreForTests({ enabled: true, relockDelayMinutes: 1 });
});

const trackers: Array<ReturnType<typeof createAppLockIdleTracker>> = [];

afterEach(() => {
    trackers.splice(0).forEach((tracker) => tracker.dispose());
    setNativeInvokeTransport(null);
    vi.useRealTimers();
    vi.mocked(logInfo).mockClear();
});

function tracked(options: Parameters<typeof createAppLockIdleTracker>[0] = {}) {
    const tracker = createAppLockIdleTracker({ isMainFocused: () => true, ...options });
    trackers.push(tracker);
    return tracker;
}
const state = () => useAppLockStore.getState();

describe('locks Rust engaged', () => {
    it('shows the lock screen for a Rust away lock without logging it again', () => {
        applyNativeEngage('away');
        expect(state()).toMatchObject({ locked: true, trigger: 'away' });
        expect(logInfo).not.toHaveBeenCalled();
        expect(calls).toEqual([]);
    });
});

describe('Mindwtr dialogs', () => {
    it('tells Rust a dialog is open until it closes, even when it throws', async () => {
        await expect(withMindwtrDialog(async () => {
            expect(calls.map(([command]) => command)).toEqual(['app_lock_dialog_begin']);
            throw new Error('picker failed');
        })).rejects.toThrow('picker failed');
        await vi.waitFor(() => expect(calls.map(([command]) => command)).toEqual(['app_lock_dialog_begin', 'app_lock_dialog_end']));
    });
});

describe('startup', () => {
    it('fails closed when the lock state cannot be read', async () => {
        resetAppLockStoreForTests();
        setNativeInvokeTransport(async () => {
            throw new Error('ipc down');
        });
        await loadAppLockState();
        expect(state()).toMatchObject({ locked: true, trigger: 'startup' });
    });
});

describe('idle lock', () => {
    it('locks after the delay with no input in the focused window, and input resets it', () => {
        const tracker = tracked();
        vi.advanceTimersByTime(MINUTE / 2);
        tracker.input();
        vi.advanceTimersByTime(MINUTE - 1);
        expect(state().locked).toBe(false);
        vi.advanceTimersByTime(1);
        expect(state()).toMatchObject({ locked: true, trigger: 'idle' });
    });

    it('has no idle lock with delay 0', () => {
        resetAppLockStoreForTests({ enabled: true, relockDelayMinutes: 0 });
        tracked();
        vi.advanceTimersByTime(60 * MINUTE);
        expect(state().locked).toBe(false);
    });
});

describe('OS check', () => {
    it('keeps the app locked when the prompt is cancelled and unlocks on success', async () => {
        resetAppLockStoreForTests({ enabled: true, locked: true, trigger: 'startup' });
        answer = () => 'cancelled';
        expect(await unlockApp('Unlock Mindwtr')).toBe('cancelled');
        expect(state().locked).toBe(true);
        answer = () => 'success';
        expect(await unlockApp('Unlock Mindwtr')).toBe('success');
        expect(state().locked).toBe(false);
        expect(calls).toContainEqual(['app_lock_authenticate', { reason: 'Unlock Mindwtr' }]);
    });

    it('turns the lock off from the lock screen only when Rust confirms no check is possible', async () => {
        resetAppLockStoreForTests({ enabled: true, locked: true, trigger: 'startup' });
        answer = () => 'failed';
        expect(await turnOffAppLockWhenUnavailable()).toBe('failed');
        expect(state()).toMatchObject({ enabled: true, locked: true });
        answer = () => 'success';
        expect(await turnOffAppLockWhenUnavailable()).toBe('success');
        expect(state()).toMatchObject({ enabled: false, locked: false });
        expect(calls.map(([command]) => command)).toEqual(['app_lock_disable_unavailable', 'app_lock_disable_unavailable']);
    });

    it('turns the lock on only after a successful check', async () => {
        resetAppLockStoreForTests();
        answer = () => 'cancelled';
        expect(await setAppLockEnabled(true, 'Enable Mindwtr app lock')).toBe('cancelled');
        expect(state().enabled).toBe(false);
        answer = () => 'success';
        expect(await setAppLockEnabled(true, 'Enable Mindwtr app lock')).toBe('success');
        expect(state().enabled).toBe(true);
        expect(calls).toContainEqual(['set_app_lock_enabled', { enabled: true, reason: 'Enable Mindwtr app lock' }]);
    });
});

describe('keyboard guard', () => {
    it('stops app shortcuts from running beneath the lock screen', () => {
        installAppLockKeyboardGuard();
        const shortcut = vi.fn();
        window.addEventListener('keydown', shortcut, true);
        resetAppLockStoreForTests({ enabled: true, locked: true });
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' }));
        expect(shortcut).not.toHaveBeenCalled();
        resetAppLockStoreForTests({ enabled: true, locked: false });
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' }));
        expect(shortcut).toHaveBeenCalledTimes(1);
        window.removeEventListener('keydown', shortcut, true);
    });

    it('blocks browser actions (print, find, reload) and the context menu only while locked', () => {
        installAppLockKeyboardGuard();
        const press = (init: KeyboardEventInit) => {
            const event = new KeyboardEvent('keydown', { cancelable: true, ...init });
            window.dispatchEvent(event);
            return event.defaultPrevented;
        };
        const rightClick = () => {
            const event = new MouseEvent('contextmenu', { cancelable: true });
            window.dispatchEvent(event);
            return event.defaultPrevented;
        };

        resetAppLockStoreForTests({ enabled: true, locked: true });
        expect(press({ key: 'p', ctrlKey: true })).toBe(true);
        expect(press({ key: 'p', metaKey: true })).toBe(true);
        expect(press({ key: 'F5' })).toBe(true);
        expect(rightClick()).toBe(true);
        // The lock screen's own keys keep working.
        for (const key of ['Tab', 'Enter', ' ', 'Escape']) expect(press({ key })).toBe(false);

        resetAppLockStoreForTests({ enabled: true, locked: false });
        expect(press({ key: 'p', ctrlKey: true })).toBe(false);
        expect(rightClick()).toBe(false);
    });
});
