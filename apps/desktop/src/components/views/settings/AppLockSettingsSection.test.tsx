import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/runtime', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../lib/runtime')>()),
    isTauriRuntime: () => true,
}));
vi.mock('../../../lib/app-log', () => ({ logInfo: vi.fn(async () => null), logWarn: vi.fn(async () => null) }));

import { LanguageProvider } from '../../../contexts/language-context';
import { resetAppLockStoreForTests, useAppLockStore } from '../../../lib/app-lock';
import { setNativeInvokeTransport } from '../../../lib/tauri-invoke';
import { AppLockSettingsSection } from './AppLockSettingsSection';
import { getEnglishSettingsLabels } from './labels';

const t = getEnglishSettingsLabels();
let calls: Array<[string, Record<string, unknown> | undefined]>;
let answer: string;

beforeEach(() => {
    calls = [];
    answer = 'cancelled';
    setNativeInvokeTransport(async <T,>(command: string, args?: Record<string, unknown>) => {
        calls.push([command, args]);
        return answer as T;
    });
    resetAppLockStoreForTests();
});

afterEach(() => {
    setNativeInvokeTransport(null);
});

const renderSection = (availability: { supported: boolean; available: boolean }) => render(
    <LanguageProvider initialLanguage="en" persistLanguage={false}>
        <AppLockSettingsSection t={t} availability={availability} />
    </LanguageProvider>,
);

describe('AppLockSettingsSection', () => {
    it('turns the lock on only after a successful OS check, then shows the delay picker', async () => {
        renderSection({ supported: true, available: true });
        const toggle = screen.getByRole('switch', { name: 'App lock' });

        fireEvent.click(toggle);
        await screen.findByText('Mindwtr is still locked.');
        expect(calls).toEqual([['set_app_lock_enabled', { enabled: true, reason: 'Enable Mindwtr app lock' }]]);
        expect(useAppLockStore.getState().enabled).toBe(false);
        expect(screen.queryByRole('combobox', { name: 'Require unlock' })).toBeNull();

        answer = 'success';
        fireEvent.click(toggle);
        await waitFor(() => expect(useAppLockStore.getState().enabled).toBe(true));
        expect(screen.getByRole('combobox', { name: 'Require unlock' })).toBeTruthy();
    });

    it('is hidden where the OS has no sign-in check (Linux)', () => {
        const { container } = renderSection({ supported: false, available: false });
        expect(container.querySelector('[data-settings-key="desktopAppLock"]')).toBeNull();
    });

    it('is disabled with a reason when Windows Hello is not set up', () => {
        renderSection({ supported: true, available: false });
        expect((screen.getByRole('switch', { name: 'App lock' }) as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByText(/Set up Windows Hello or a Mac login password/)).toBeTruthy();
    });
});
