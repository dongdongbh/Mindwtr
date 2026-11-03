import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logErrorMock = vi.hoisted(() => vi.fn(async () => null));
vi.mock('./app-log', () => ({ logError: logErrorMock }));

const windowMocks = vi.hoisted(() => ({
    setSkipTaskbar: vi.fn(async () => undefined),
    hide: vi.fn(async () => undefined),
}));
vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => windowMocks,
}));

import { hideMainWindowToTray } from './hide-to-tray';
import { setNativeInvokeTransport } from './tauri-invoke';


const steps: string[] = [];
let transportResult: () => Promise<unknown> = async () => undefined;

beforeEach(() => {
    steps.length = 0;
    logErrorMock.mockClear();
    transportResult = async () => undefined;
    windowMocks.setSkipTaskbar.mockImplementation(async () => {
        steps.push('setSkipTaskbar');
    });
    windowMocks.hide.mockImplementation(async () => {
        steps.push('hide');
    });
    (window as any).__TAURI_INTERNALS__ = {};
    setNativeInvokeTransport(((command: string, args?: Record<string, unknown>) => {
        steps.push(`${command}:${JSON.stringify(args)}`);
        return transportResult();
    }) as never);
});

afterEach(() => {
    setNativeInvokeTransport(null);
    delete (window as any).__TAURI_INTERNALS__;
});

describe('hideMainWindowToTray', () => {
    it('becomes an accessory app only after the window is hidden', async () => {
        await hideMainWindowToTray();

        expect(steps).toEqual([
            'setSkipTaskbar',
            'hide',
            'set_macos_activation_policy:{"accessory":true}',
        ]);
    });

    it('stays out of accessory mode when the hide fails', async () => {
        windowMocks.hide.mockRejectedValueOnce(new Error('hide failed'));

        await expect(hideMainWindowToTray()).rejects.toThrow('hide failed');

        expect(steps).toEqual(['setSkipTaskbar']);
    });

    it('still hides when the taskbar flag fails', async () => {
        windowMocks.setSkipTaskbar.mockRejectedValueOnce(new Error('no taskbar'));

        await hideMainWindowToTray();

        expect(steps).toEqual(['hide', 'set_macos_activation_policy:{"accessory":true}']);
        expect(logErrorMock).toHaveBeenCalledWith(expect.any(Error), {
            scope: 'window',
            step: 'setSkipTaskbar',
        });
    });

    it('reports a failed policy switch instead of failing the hide', async () => {
        transportResult = async () => {
            throw new Error('no policy');
        };

        await hideMainWindowToTray();

        expect(logErrorMock).toHaveBeenCalledWith(expect.any(Error), {
            scope: 'window',
            step: 'setActivationPolicy',
        });
    });
});
