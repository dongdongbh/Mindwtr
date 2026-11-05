import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskStore, type Task } from '@mindwtr/core';

const invokeNativeOr = vi.fn(async (fallback: unknown, _command: string, _args?: Record<string, unknown>) => fallback);
vi.mock('./tauri-invoke', () => ({ invokeNativeOr: (...args: Parameters<typeof invokeNativeOr>) => invokeNativeOr(...args) }));
vi.mock('./app-log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));

let tauriRuntimeAvailable = false;
vi.mock('./runtime', () => ({ isTauriRuntime: () => tauriRuntimeAvailable }));

import {
    isMacWidgetSyncAvailable,
    startMacWidgetSync,
    stopMacWidgetSync,
    triggerMacWidgetPayloadWrite,
} from './macos-widget-sync';

const makeTask = (overrides: Partial<Task> = {}): Task => ({
    id: 'task-1',
    title: 'Plan review',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-01-01T08:00:00.000Z',
    updatedAt: '2026-01-01T08:00:00.000Z',
    ...overrides,
});

const setMacOSUserAgent = (isMac: boolean) => {
    Object.defineProperty(navigator, 'platform', { value: isMac ? 'MacIntel' : 'Win32', configurable: true });
    Object.defineProperty(navigator, 'userAgent', {
        value: isMac ? 'Macintosh; Intel Mac OS X 10_15' : 'Windows NT 10.0',
        configurable: true,
    });
};

describe('macos-widget-sync', () => {
    beforeEach(() => {
        invokeNativeOr.mockClear();
        tauriRuntimeAvailable = false;
        setMacOSUserAgent(false);
        stopMacWidgetSync();
        useTaskStore.setState((state) => ({ ...state, tasks: [], _allTasks: [], lastDataChangeAt: 0 }));
    });

    afterEach(() => {
        stopMacWidgetSync();
    });

    it('is unavailable off macOS even inside Tauri', () => {
        tauriRuntimeAvailable = true;
        setMacOSUserAgent(false);
        expect(isMacWidgetSyncAvailable()).toBe(false);
    });

    it('is unavailable on macOS outside Tauri (web/dev builds)', () => {
        tauriRuntimeAvailable = false;
        setMacOSUserAgent(true);
        expect(isMacWidgetSyncAvailable()).toBe(false);
    });

    it('is available on macOS inside Tauri', () => {
        tauriRuntimeAvailable = true;
        setMacOSUserAgent(true);
        expect(isMacWidgetSyncAvailable()).toBe(true);
    });

    it('does not invoke the write command when unavailable', async () => {
        await triggerMacWidgetPayloadWrite({ tasks: [], projects: [], sections: [], areas: [], settings: {} });
        expect(invokeNativeOr).not.toHaveBeenCalled();
    });

    it('writes a JSON payload through invokeNativeOr when available', async () => {
        tauriRuntimeAvailable = true;
        setMacOSUserAgent(true);
        await triggerMacWidgetPayloadWrite({ tasks: [makeTask()], projects: [], sections: [], areas: [], settings: {} });
        expect(invokeNativeOr).toHaveBeenCalledTimes(1);
        const [, command, args] = invokeNativeOr.mock.calls[0] as [unknown, string, { payloadJson: string }];
        expect(command).toBe('write_macos_widget_payload');
        expect(() => JSON.parse(args.payloadJson)).not.toThrow();
    });

    it('debounces store-driven writes and stops on unsubscribe', async () => {
        vi.useFakeTimers();
        tauriRuntimeAvailable = true;
        setMacOSUserAgent(true);

        startMacWidgetSync();
        invokeNativeOr.mockClear();

        useTaskStore.setState((state) => ({ ...state, lastDataChangeAt: 1 }));
        useTaskStore.setState((state) => ({ ...state, lastDataChangeAt: 2 }));
        await vi.advanceTimersByTimeAsync(1999);
        expect(invokeNativeOr).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(invokeNativeOr).toHaveBeenCalledTimes(1);

        stopMacWidgetSync();
        useTaskStore.setState((state) => ({ ...state, lastDataChangeAt: 3 }));
        await vi.advanceTimersByTimeAsync(5000);
        expect(invokeNativeOr).toHaveBeenCalledTimes(1);

        vi.useRealTimers();
    });
});
