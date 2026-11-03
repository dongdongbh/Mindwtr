import { isTauriRuntime } from './runtime';
import { isSandboxMode } from '@mindwtr/core';

const SANDBOX_NATIVE_COMMAND_ALLOWLIST = new Set([
    'acknowledge_close_request',

    'app_lock_authenticate',
    'app_lock_dialog_begin',
    'app_lock_dialog_end',
    'app_lock_disable_unavailable',
    'app_lock_engage',
    'append_log_line',
    'get_app_lock_state',
    'get_system_theme_preference',
    'notify_ui_ready',
    'quit_app',
]);

export const isSandboxNativeCommandAllowed = (command: string): boolean => (
    !isSandboxMode() || SANDBOX_NATIVE_COMMAND_ALLOWLIST.has(command)
);

const assertSandboxNativeCommandAllowed = (command: string): void => {
    if (isSandboxNativeCommandAllowed(command)) return;
    throw new Error('Unavailable in sandbox.');
};


export type NativeInvokeTransport = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

type NativeInvokeProfilingTransport = {
    schemaVersion: 1;
    label: 'mindwtr-native-invoke-transport-v1';
    invoke: NativeInvokeTransport;
};

declare global {
    interface Window {
        __mindwtrNativeInvokeTransport?: NativeInvokeProfilingTransport;
    }
}

let nativeInvokeProfilingTransport: NativeInvokeProfilingTransport | undefined;

const getNativeInvokeProfilingTransport = (invoke: NativeInvokeTransport): NativeInvokeProfilingTransport => {
    if (!nativeInvokeProfilingTransport) {
        if (window.__mindwtrNativeInvokeTransport) {
            throw new Error('Native invoke profiling transport already exists.');
        }
        nativeInvokeProfilingTransport = {
            schemaVersion: 1,
            label: 'mindwtr-native-invoke-transport-v1',
            invoke,
        };
        window.__mindwtrNativeInvokeTransport = nativeInvokeProfilingTransport;
    } else if (window.__mindwtrNativeInvokeTransport !== nativeInvokeProfilingTransport) {
        throw new Error('Native invoke profiling transport ownership changed.');
    }
    return nativeInvokeProfilingTransport;
};

const tauriTransport: NativeInvokeTransport = async <T>(
    command: string,
    args?: Record<string, unknown>,
): Promise<T> => {
    const { invoke } = await import('@tauri-apps/api/core');
    if (import.meta.env.VITE_STARTUP_PROFILING === '1') {
        const profilingTransport = getNativeInvokeProfilingTransport(invoke as NativeInvokeTransport);
        return args === undefined
            ? profilingTransport.invoke<T>(command)
            : profilingTransport.invoke<T>(command, args);
    }

    return args === undefined ? invoke<T>(command) : invoke<T>(command, args);
};

let transport: NativeInvokeTransport = tauriTransport;


export function setNativeInvokeTransport(next: NativeInvokeTransport | null): void {
    transport = next ?? tauriTransport;
}


export async function preloadNativeTransport(): Promise<void> {
    if (!isTauriRuntime()) return;
    await import('@tauri-apps/api/core');
}


export async function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    if (!isTauriRuntime()) {
        throw new Error('Tauri runtime is unavailable.');
    }
    assertSandboxNativeCommandAllowed(command);
    return transport<T>(command, args);
}


export async function invokeNativeOr<T>(
    fallback: T,
    command: string,
    args?: Record<string, unknown>,
): Promise<T> {
    if (!isTauriRuntime()) return fallback;
    if (!isSandboxNativeCommandAllowed(command)) return fallback;
    return transport<T>(command, args);
}
