import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskStore } from '@mindwtr/core';
import { LanguageProvider } from './language-context';
import { KeybindingProvider } from './keybinding-context';
import { applyGlobalQuickAddShortcut } from '../lib/global-quick-add-shortcut';
import nativeStartupSource from '../../src-tauri/src/lib.rs?raw';
import { logInfo } from '../lib/app-log';

vi.mock('../lib/runtime', () => ({
    isTauriRuntime: () => true,
    isFlatpakRuntime: () => false,
}));
vi.mock('../lib/app-log', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock('../lib/global-quick-add-shortcut', async (importOriginal) => ({
    ...await importOriginal<typeof import('../lib/global-quick-add-shortcut')>(),
    applyGlobalQuickAddShortcut: vi.fn(async (shortcut: string) => ({ shortcut })),
}));

const originalUpdateSettings = useTaskStore.getState().updateSettings;
const updateSettings = vi.fn(async () => undefined);

describe('global quick add shortcut startup', () => {
    beforeEach(() => {
        vi.clearAllMocks();

        vi.stubEnv('MODE', 'development');
        vi.stubEnv('VITEST', '');
        vi.stubEnv('NODE_ENV', 'development');
        vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows');
        useTaskStore.setState({ settings: {}, _allAreas: [], updateSettings });
    });

    afterEach(() => {
        cleanup();
        useTaskStore.setState({ settings: {}, updateSettings: originalUpdateSettings });
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('initializes the native default before either webview can apply saved settings', () => {


        const setup = nativeStartupSource.slice(nativeStartupSource.indexOf('.setup(move |app| {'));
        const nativeDefault = setup.indexOf('apply_global_quick_add_shortcut(');
        const mainWebview = setup.indexOf('main_window_builder.build()?');
        const quickAddWebview = setup.indexOf('create_quick_add_window(&handle)');
        expect(nativeDefault).toBeGreaterThanOrEqual(0);
        expect(mainWebview).toBeGreaterThanOrEqual(0);
        expect(quickAddWebview).toBeGreaterThanOrEqual(0);
        expect(nativeDefault).toBeLessThan(mainWebview);
        expect(nativeDefault).toBeLessThan(quickAddWebview);
    });

    it.each(['Control+Alt+M', 'Control+Alt+N', 'Control+Alt+Q', 'CommandOrControl+Shift+A', 'disabled'])(
        'restores the saved Windows preference %s after hydration without rewriting settings',
        async (shortcut) => {
            render(<LanguageProvider><KeybindingProvider currentView="inbox" onNavigate={vi.fn()}>
                <div>Inbox</div>
            </KeybindingProvider></LanguageProvider>);
            expect(applyGlobalQuickAddShortcut).not.toHaveBeenCalled();
            expect(logInfo).not.toHaveBeenCalled();

            act(() => useTaskStore.setState({ settings: { deviceId: 'loaded-device', globalQuickAddShortcut: shortcut } }));

            await waitFor(() => expect(applyGlobalQuickAddShortcut).toHaveBeenCalledExactlyOnceWith(shortcut));
            await waitFor(() => expect(logInfo).toHaveBeenCalledExactlyOnceWith(
                'Hydrated global quick add shortcut applied',
                {
                    scope: 'shortcuts', force: true,
                    extra: {
                        releaseCheck: 'v1.3.4/global-shortcut-startup',
                        requestedShortcut: shortcut, appliedShortcut: shortcut, outcome: 'applied',
                    },
                },
            ));
            expect(updateSettings).not.toHaveBeenCalled();
        },
    );

    it('restores an already hydrated saved shortcut on each provider startup', async () => {
        useTaskStore.setState({ settings: { deviceId: 'loaded-device', globalQuickAddShortcut: 'Control+Alt+Q' } });
        const app = <LanguageProvider><KeybindingProvider currentView="inbox" onNavigate={vi.fn()}>
            <div>Inbox</div>
        </KeybindingProvider></LanguageProvider>;
        const first = render(app);
        await waitFor(() => expect(logInfo).toHaveBeenCalledTimes(1));
        first.unmount();
        render(app);
        await waitFor(() => expect(logInfo).toHaveBeenCalledTimes(2));
        expect(vi.mocked(applyGlobalQuickAddShortcut).mock.calls).toEqual([
            ['Control+Alt+Q'], ['Control+Alt+Q'],
        ]);
        expect(updateSettings).not.toHaveBeenCalled();
    });

    it('reports the bounded native fallback instead of claiming the requested shortcut registered', async () => {
        vi.mocked(applyGlobalQuickAddShortcut).mockResolvedValueOnce({ shortcut: 'disabled', warning: 'Unavailable' });
        useTaskStore.setState({ settings: { deviceId: 'loaded-device', globalQuickAddShortcut: 'Control+Alt+Q' } });
        render(<LanguageProvider><KeybindingProvider currentView="inbox" onNavigate={vi.fn()}>
            <div>Inbox</div>
        </KeybindingProvider></LanguageProvider>);
        await waitFor(() => expect(logInfo).toHaveBeenCalledWith(
            'Hydrated global quick add shortcut applied',
            {
                scope: 'shortcuts', force: true,
                extra: {
                    releaseCheck: 'v1.3.4/global-shortcut-startup',
                    requestedShortcut: 'Control+Alt+Q', appliedShortcut: 'disabled', outcome: 'fallback',
                },
            },
        ));
        expect(updateSettings).toHaveBeenCalledExactlyOnceWith({ globalQuickAddShortcut: 'disabled' });
    });
});
