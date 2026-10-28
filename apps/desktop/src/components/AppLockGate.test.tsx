import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/runtime', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/runtime')>()),
    isTauriRuntime: () => true,
}));
vi.mock('../lib/app-log', () => ({ logInfo: vi.fn(async () => null), logWarn: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));

import { LanguageProvider } from '../contexts/language-context';
import { lockApp, resetAppLockStoreForTests, useAppLockStore } from '../lib/app-lock';
import { setNativeInvokeTransport } from '../lib/tauri-invoke';
import { AppLockGate } from './AppLockGate';

let answers: string[];
let authCalls: number;
let turnOffAnswer: string;

beforeEach(() => {
    answers = [];
    authCalls = 0;
    turnOffAnswer = 'success';
    setNativeInvokeTransport(async <T,>(command: string) => {
        if (command === 'app_lock_authenticate') {
            authCalls += 1;
            return (answers.shift() ?? 'cancelled') as T;
        }
        if (command === 'app_lock_disable_unavailable') return turnOffAnswer as T;
        return undefined as T;
    });
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});

afterEach(() => {
    setNativeInvokeTransport(null);
    vi.restoreAllMocks();
    resetAppLockStoreForTests();
});

function renderApp() {
    return render(
        <LanguageProvider initialLanguage="en" persistLanguage={false}>
            <div data-testid="app-root">
                <p>Call the bank about the mortgage</p>
                <input aria-label="Task title draft" defaultValue="" />
            </div>
            <AppLockGate />
        </LanguageProvider>,
    );
}

/** Visible task text: anything not inside an inert subtree. */
const visibleTaskText = () => screen.queryAllByText('Call the bank about the mortgage')
    .filter((element) => !element.closest('[inert]'));

describe('AppLockGate', () => {
    it('starts on the lock screen with the app inert, and shows the app only after the OS check succeeds', async () => {
        resetAppLockStoreForTests({ enabled: true, locked: true, trigger: 'startup' });
        answers = ['cancelled'];
        renderApp();

        expect(screen.getByTestId('app-lock-screen')).toBeTruthy();
        expect(visibleTaskText()).toHaveLength(0);
        expect(screen.getByTestId('app-root').closest('[aria-hidden="true"]')).not.toBeNull();
        // The print rule hides everything but the lock screen while this is set.
        expect(document.documentElement.getAttribute('data-app-locked')).toBe('true');

        // The startup prompt runs once by itself; cancelling keeps it locked.
        await waitFor(() => expect(authCalls).toBe(1));
        await screen.findByText('Mindwtr is still locked.');
        expect(useAppLockStore.getState().locked).toBe(true);
        expect(visibleTaskText()).toHaveLength(0);

        answers = ['success'];
        fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
        await waitFor(() => expect(screen.queryByTestId('app-lock-screen')).toBeNull());
        expect(visibleTaskText()).toHaveLength(1);
        expect(screen.getByTestId('app-root').closest('[inert]')).toBeNull();
        expect(document.documentElement.hasAttribute('data-app-locked')).toBe(false);
        // No way-out button was offered: the check was never unavailable.
        expect(screen.queryByRole('button', { name: 'Turn off app lock' })).toBeNull();
    });

    it('offers Turn off app lock only after the OS check reports unavailable, and stays locked if Rust refuses', async () => {
        resetAppLockStoreForTests({ enabled: true, locked: true, trigger: 'manual' });
        answers = ['cancelled', 'unavailable', 'unavailable'];
        renderApp();

        fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
        await screen.findByText('Mindwtr is still locked.');
        expect(screen.queryByRole('button', { name: 'Turn off app lock' })).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
        await screen.findByText('Windows Hello or Touch ID is not available on this device right now.');

        // Rust re-checked and the check is available: stay locked, button gone.
        turnOffAnswer = 'failed';
        fireEvent.click(screen.getByRole('button', { name: 'Turn off app lock' }));
        await screen.findByText('Mindwtr is still locked.');
        expect(screen.queryByRole('button', { name: 'Turn off app lock' })).toBeNull();
        expect(useAppLockStore.getState().locked).toBe(true);

        fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
        turnOffAnswer = 'success';
        fireEvent.click(await screen.findByRole('button', { name: 'Turn off app lock' }));
        await waitFor(() => expect(screen.queryByTestId('app-lock-screen')).toBeNull());
        expect(useAppLockStore.getState()).toMatchObject({ enabled: false, locked: false });
    });

    it('keeps an unsaved draft through lock and unlock', async () => {
        resetAppLockStoreForTests({ enabled: true });
        renderApp();
        const draft = screen.getByLabelText('Task title draft') as HTMLInputElement;
        fireEvent.change(draft, { target: { value: 'half-typed task' } });

        act(() => lockApp('manual'));
        expect(screen.getByTestId('app-lock-screen')).toBeTruthy();
        // A manual lock does not prompt straight away: the user meant to step away.
        expect(authCalls).toBe(0);

        answers = ['success'];
        fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
        await waitFor(() => expect(screen.queryByTestId('app-lock-screen')).toBeNull());
        expect(screen.getByLabelText('Task title draft')).toBe(draft);
        expect(draft.value).toBe('half-typed task');
    });

    it('locks from the keyboard shortcut', () => {
        resetAppLockStoreForTests({ enabled: true });
        renderApp();
        fireEvent.keyDown(window, { key: 'L', code: 'KeyL', ctrlKey: true, shiftKey: true });
        expect(useAppLockStore.getState()).toMatchObject({ locked: true, trigger: 'manual' });
    });

    it('makes dialogs opened while locked inert too', async () => {
        resetAppLockStoreForTests({ enabled: true, locked: true, trigger: 'manual' });
        renderApp();
        const portal = document.createElement('div');
        portal.textContent = 'Call the bank about the mortgage';
        act(() => { document.body.appendChild(portal); });
        await waitFor(() => expect(portal.hasAttribute('inert')).toBe(true));
        portal.remove();
    });
});
