import { isTauriRuntime } from './runtime';
import { isSandboxMode } from '@mindwtr/core';

const SANDBOX_NATIVE_COMMAND_ALLOWLIST = new Set([
    'acknowledge_close_request',
    'append_log_line',
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

/**
 * The transport that actually reaches Rust. Swappable so callers get a seam
 * without each adapter growing its own dependency-injection scaffolding.
 */
export type NativeInvokeTransport = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const tauriTransport: NativeInvokeTransport = async <T>(
    command: string,
    args?: Record<string, unknown>,
): Promise<T> => {
    const { invoke } = await import('@tauri-apps/api/core');
    // An argument-less command stays argument-less on the wire.
    return args === undefined ? invoke<T>(command) : invoke<T>(command, args);
};

let transport: NativeInvokeTransport = tauriTransport;

/** Replaces the transport (tests, fakes). Pass `null` to restore the real one. */
export function setNativeInvokeTransport(next: NativeInvokeTransport | null): void {
    transport = next ?? tauriTransport;
}

/**
 * Resolves the transport module up front, so a later `invokeNative` pays only
 * the call. Startup paths whose invoke is timed — `notify_ui_ready` fires after
 * two animation frames and is what reveals the window (#936) — preload before
 * the wait rather than resolving the module on the timed call itself.
 */
export async function preloadNativeTransport(): Promise<void> {
    if (!isTauriRuntime()) return;
    await import('@tauri-apps/api/core');
}

/**
 * Invokes a Rust command. Rejects when there is no Tauri runtime — use this
 * when the caller has already established it is running in the desktop shell,
 * or when failing is the correct outcome elsewhere.
 */
export async function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    if (!isTauriRuntime()) {
        throw new Error('Tauri runtime is unavailable.');
    }
    assertSandboxNativeCommandAllowed(command);
    return transport<T>(command, args);
}

/**
 * Invokes a Rust command, resolving to `fallback` when there is no Tauri
 * runtime (web/dev builds), so the caller does not need its own guard.
 */
export async function invokeNativeOr<T>(
    fallback: T,
    command: string,
    args?: Record<string, unknown>,
): Promise<T> {
    if (!isTauriRuntime()) return fallback;
    if (!isSandboxNativeCommandAllowed(command)) return fallback;
    return transport<T>(command, args);
}
