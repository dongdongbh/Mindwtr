import { render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSettingsMainPage } from './useSettingsMainPage';

const getLaunchAtStartupEnabled = vi.fn();
const tauriCoreMock = vi.hoisted(() => ({
    invoke: vi.fn().mockResolvedValue('dark'),
}));
const tauriAppMock = vi.hoisted(() => ({
    setTheme: vi.fn().mockResolvedValue(undefined),
}));
const tauriWindowMock = vi.hoisted(() => ({
    setTheme: vi.fn().mockResolvedValue(undefined),
    theme: vi.fn().mockResolvedValue('dark'),
    onThemeChanged: vi.fn().mockResolvedValue(vi.fn()),
}));

vi.mock('@tauri-apps/api/app', () => ({
    setTheme: tauriAppMock.setTheme,
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: tauriCoreMock.invoke,
}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => tauriWindowMock,
}));

vi.mock('../../../lib/launch-at-startup', () => ({
    getLaunchAtStartupEnabled: () => getLaunchAtStartupEnabled(),
    setLaunchAtStartupEnabled: vi.fn(),
}));

type HarnessProps = {
    isFlatpak: boolean;
    isTauri: boolean;
    settings?: Parameters<typeof useSettingsMainPage>[0]['settings'];
};

function Harness({ isFlatpak, isTauri, settings = { window: { launchAtStartup: true } } }: HarnessProps) {
    const page = useSettingsMainPage({
        globalQuickAddShortcut: 'Control+Alt+M',
        isFlatpak,
        isLinux: true,
        isTauri,
        keybindingStyle: 'vim',
        language: 'en',
        openHelp: vi.fn(),
        setGlobalQuickAddShortcut: vi.fn(),
        setKeybindingStyle: vi.fn(),
        setLanguage: vi.fn(),
        settings,
        showSaved: vi.fn(),
        updateSettings: vi.fn(),
    });

    return (
        <output data-testid="settings-main-state">
            {JSON.stringify({
                closeBehavior: page.closeBehavior,
                launchAtStartupEnabled: page.launchAtStartupEnabled,
                showCloseBehavior: page.showCloseBehavior,
                showLaunchAtStartup: page.showLaunchAtStartup,
                showTrayToggle: page.showTrayToggle,
            })}
        </output>
    );
}

const readState = () => JSON.parse(screen.getByTestId('settings-main-state').textContent ?? '{}');

describe('useSettingsMainPage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getLaunchAtStartupEnabled.mockResolvedValue(true);
        tauriCoreMock.invoke.mockResolvedValue('dark');
        tauriAppMock.setTheme.mockResolvedValue(undefined);
        tauriWindowMock.setTheme.mockResolvedValue(undefined);
        document.documentElement.className = '';
        localStorage.clear();
    });

    it('exposes Flatpak lifecycle controls and defaults close handling to tray', () => {
        render(<Harness isFlatpak isTauri />);

        expect(readState()).toMatchObject({
            closeBehavior: 'tray',
            launchAtStartupEnabled: true,
            showCloseBehavior: true,
            showLaunchAtStartup: true,
            showTrayToggle: true,
        });
        expect(getLaunchAtStartupEnabled).not.toHaveBeenCalled();
    });

    it('keeps lifecycle controls hidden outside the Tauri runtime', () => {
        render(<Harness isFlatpak={false} isTauri={false} />);

        expect(readState()).toMatchObject({
            closeBehavior: 'ask',
            showCloseBehavior: false,
            showLaunchAtStartup: false,
            showTrayToggle: false,
        });
    });

    it('applies the resolved Tauri theme to the app and current window', async () => {
        render(<Harness isFlatpak={false} isTauri settings={{ theme: 'dark' }} />);

        await waitFor(() => {
            expect(tauriAppMock.setTheme).toHaveBeenCalledWith('dark');
            expect(tauriWindowMock.setTheme).toHaveBeenCalledWith('dark');
        });
    });

    it('resolves System theme through the native command when webview media is stale', async () => {
        const originalMatchMedia = window.matchMedia;
        window.matchMedia = vi.fn().mockReturnValue({ matches: false } as MediaQueryList);
        // The command goes through the invoke seam, which needs a Tauri runtime
        // to reach the mocked @tauri-apps/api/core.
        (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};

        try {
            render(<Harness isFlatpak={false} isTauri settings={{ theme: 'system' }} />);

            await waitFor(() => {
                expect(tauriCoreMock.invoke).toHaveBeenCalledWith('get_system_theme_preference');
                expect(document.documentElement.classList.contains('dark')).toBe(true);
            });
        } finally {
            window.matchMedia = originalMatchMedia;
            delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
        }
    });
});

describe('useSettingsMainPage appearance writes', () => {
    // The store merges appearance into the latest settings; sending the page's whole copy would put back
    // a key another device changed since this page last rendered.
    it('sends only the changed appearance key', async () => {
        const updateSettings = vi.fn().mockResolvedValue(undefined);
        const { result } = renderHook(() => useSettingsMainPage({
            globalQuickAddShortcut: 'Control+Alt+M', isFlatpak: false, isLinux: true, isTauri: false, keybindingStyle: 'vim',
            language: 'en', openHelp: vi.fn(), setGlobalQuickAddShortcut: vi.fn(), setKeybindingStyle: vi.fn(), setLanguage: vi.fn(),
            settings: { appearance: { density: 'compact', textSize: 'large', showTaskAge: true } },
            showSaved: vi.fn(), updateSettings,
        }));
        result.current.onDensityChange('comfortable');
        result.current.onTextSizeChange('default');
        result.current.onFontFamilyChange('');
        result.current.onShowTaskAgeChange(false);
        expect(updateSettings.mock.calls.map(([updates]) => updates)).toEqual([
            { appearance: { density: 'comfortable' } },
            { appearance: { textSize: 'default' } },
            { appearance: { fontFamily: undefined } },
            { appearance: { showTaskAge: false } },
        ]);
    });
});
