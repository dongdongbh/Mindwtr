import { useEffect } from 'react';
import { logError } from './app-log';
import { isTauriRuntime } from './runtime';
import { invokeNative } from './tauri-invoke';
import type { DesktopCloseBehavior } from './window-behavior';

export type DesktopShellSyncOptions = {
    enabled?: boolean;

    showTray: boolean | undefined;
    trayTooltip: string;

    trayLabels: { quickAdd: string; show: string; quit: string; lock?: string | null };
    closeBehavior: DesktopCloseBehavior;
};


function runShellCommand(
    command: string,
    args: Record<string, unknown>,
    scope: string,
    step: string,
): () => void {
    let cancelled = false;
    void invokeNative(command, args).catch((error) => {
        if (cancelled) return;
        void logError(error, { scope, step });
    });
    return () => {
        cancelled = true;
    };
}


export function useDesktopShellSync({ enabled = true, showTray, trayTooltip, trayLabels, closeBehavior }: DesktopShellSyncOptions): void {
    useEffect(() => {
        if (!enabled) return;
        if (!isTauriRuntime()) return;
        if (showTray === undefined) return;
        return runShellCommand('set_tray_visible', { visible: showTray !== false }, 'tray', 'setVisible');
    }, [enabled, showTray]);


    useEffect(() => {
        if (!enabled) return;
        if (!isTauriRuntime()) return;
        if (showTray === false) return;
        return runShellCommand('set_tray_tooltip', { tooltip: trayTooltip }, 'tray', 'setTooltip');
    }, [enabled, showTray, trayTooltip]);

    useEffect(() => {
        if (!enabled || !isTauriRuntime() || showTray === false) return;
        return runShellCommand('set_tray_labels', {
            quickAdd: trayLabels.quickAdd, show: trayLabels.show, quit: trayLabels.quit, lock: trayLabels.lock ?? null,
        }, 'tray', 'setLabels');
    }, [enabled, showTray, trayLabels.quickAdd, trayLabels.show, trayLabels.quit, trayLabels.lock]);


    useEffect(() => {
        if (!enabled) return;
        if (!isTauriRuntime()) return;
        if (closeBehavior === 'tray' && showTray !== false) return;
        return runShellCommand(
            'set_macos_activation_policy',
            { accessory: false },
            'window',
            'setActivationPolicy',
        );
    }, [closeBehavior, enabled, showTray]);
}
