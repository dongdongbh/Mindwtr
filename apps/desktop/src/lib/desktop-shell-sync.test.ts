import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logErrorMock = vi.hoisted(() => vi.fn(async () => null));
vi.mock('./app-log', () => ({ logError: logErrorMock }));

import { useDesktopShellSync, type DesktopShellSyncOptions } from './desktop-shell-sync';
import { setNativeInvokeTransport } from './tauri-invoke';

const invoked: Array<[string, Record<string, unknown> | undefined]> = [];
let transportResult: () => Promise<unknown> = async () => undefined;

const enableTauri = () => {
    (window as any).__TAURI_INTERNALS__ = {};
};

beforeEach(() => {
    invoked.length = 0;
    logErrorMock.mockClear();
    transportResult = async () => undefined;
    setNativeInvokeTransport(((command: string, args?: Record<string, unknown>) => {
        invoked.push([command, args]);
        return transportResult();
    }) as never);
});

afterEach(() => {
    setNativeInvokeTransport(null);
    delete (window as any).__TAURI_INTERNALS__;
});

const options: DesktopShellSyncOptions = { showTray: true, trayTooltip: 'Mindwtr', trayLabels: { quickAdd: 'Quick Add', show: 'Show Mindwtr', quit: 'Quit' }, closeBehavior: 'tray' };
const quitOptions: DesktopShellSyncOptions = { ...options, closeBehavior: 'quit' };

describe('useDesktopShellSync', () => {
    it('invokes nothing off Tauri', () => {
        renderHook(() => useDesktopShellSync(options));
        expect(invoked).toEqual([]);
    });

    it('sets the tray icon before its tooltip', () => {
        enableTauri();
        renderHook(() => useDesktopShellSync(options));
        expect(invoked).toEqual([
            ['set_tray_visible', { visible: true }],
            ['set_tray_tooltip', { tooltip: 'Mindwtr' }],
            ['set_tray_labels', options.trayLabels],
        ]);
    });

    // The window is on screen whenever this hook runs, so enabling close-to-tray
    // must never cost the Dock icon, the Cmd+Tab entry or the menu bar. Only the
    // hide path may make the app an accessory.
    it('never makes the app an accessory from settings alone', () => {
        enableTauri();
        const { rerender } = renderHook((props: typeof options) => useDesktopShellSync(props), {
            initialProps: quitOptions,
        });
        rerender(options);
        rerender({ ...options, showTray: undefined });

        expect(invoked).not.toContainEqual(['set_macos_activation_policy', { accessory: true }]);
    });

    it('leaves the tray alone until settings hydrate', () => {
        enableTauri();
        renderHook(() => useDesktopShellSync({ ...options, showTray: undefined }));
        expect(invoked.map(([command]) => command)).toEqual([
            // No visibility command without a setting, but an unhydrated tray is
            // still shown, so its tooltip still applies.
            'set_tray_tooltip',
            'set_tray_labels',
        ]);
    });

    // A window hidden in the tray when the tray is switched off has nothing left
    // to bring it back, so the app must return to the Dock and Cmd+Tab.
    it('skips the tooltip when the tray is hidden and keeps the dock icon', () => {
        enableTauri();
        renderHook(() => useDesktopShellSync({ ...options, showTray: false }));
        expect(invoked).toEqual([
            ['set_tray_visible', { visible: false }],
            ['set_macos_activation_policy', { accessory: false }],
        ]);
    });

    it('keeps the dock icon when closing quits', () => {
        enableTauri();
        renderHook(() => useDesktopShellSync(quitOptions));
        expect(invoked).toContainEqual(['set_macos_activation_policy', { accessory: false }]);
    });

    it('re-sends only the command whose input changed', () => {
        enableTauri();
        const { rerender } = renderHook((props: typeof options) => useDesktopShellSync(props), {
            initialProps: options,
        });
        invoked.length = 0;

        rerender({ ...options, trayTooltip: 'Mindwtr — 2 focused' });

        expect(invoked).toEqual([['set_tray_tooltip', { tooltip: 'Mindwtr — 2 focused' }]]);
    });

    it('updates menu labels when the app language changes, including while the tray is hidden', () => {
        enableTauri();
        const { rerender } = renderHook((props: DesktopShellSyncOptions) => useDesktopShellSync(props), {
            initialProps: options,
        });
        invoked.length = 0;
        const trayLabels = { quickAdd: '快速添加', show: '查看Mindwtr', quit: '退出' };
        rerender({ ...options, trayLabels });
        expect(invoked).toEqual([['set_tray_labels', trayLabels]]);
        rerender({ ...options, showTray: false, trayLabels });
        invoked.length = 0;
        rerender({ ...options, showTray: false });
        expect(invoked).toEqual([]);
        rerender(options);
        expect(invoked).toContainEqual(['set_tray_labels', options.trayLabels]);
    });

    it('issues each command once per unchanged render', () => {
        enableTauri();
        const { rerender } = renderHook((props: typeof options) => useDesktopShellSync(props), {
            initialProps: options,
        });
        invoked.length = 0;

        rerender(options);

        expect(invoked).toEqual([]);
    });

    it('logs a failure under its own scope and step', async () => {
        enableTauri();
        transportResult = async () => {
            throw new Error('no tray');
        };

        renderHook(() => useDesktopShellSync(quitOptions));
        await vi.waitFor(() => expect(logErrorMock).toHaveBeenCalledTimes(4));

        expect(logErrorMock.mock.calls.map((call) => (call as unknown as [unknown, object])[1])).toEqual([
            { scope: 'tray', step: 'setVisible' },
            { scope: 'tray', step: 'setTooltip' },
            { scope: 'tray', step: 'setLabels' },
            { scope: 'window', step: 'setActivationPolicy' },
        ]);
    });

    it('does not log a failure that settles after unmount', async () => {
        enableTauri();
        const rejects: Array<(error: Error) => void> = [];
        transportResult = () => new Promise((_resolve, rejectPromise) => {
            rejects.push(rejectPromise);
        });

        const { unmount } = renderHook(() => useDesktopShellSync(quitOptions));
        expect(rejects).toHaveLength(4);
        unmount();
        for (const reject of rejects) reject(new Error('too late'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(logErrorMock).not.toHaveBeenCalled();
    });
});
