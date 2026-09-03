export function isTauriRuntime(): boolean {
    return typeof window !== 'undefined' && Boolean((window as any).__TAURI__ || (window as any).__TAURI_INTERNALS__);
}

export function isFlatpakRuntime(): boolean {
    return typeof window !== 'undefined' && Boolean((window as any).__MINDWTR_FLATPAK__);
}

/**
 * Whether the desktop shell is running on Windows. Read from the user agent because the
 * renderer has no synchronous platform call, and every Windows WebView2 user agent carries
 * "Windows" in its platform token.
 */
export function isWindowsRuntime(): boolean {
    return typeof navigator !== 'undefined' && (navigator.userAgent ?? '').includes('Windows');
}

type DesktopTimerHost = {
    setTimeout: typeof globalThis.setTimeout;
    clearTimeout: typeof globalThis.clearTimeout;
};

export function getDesktopTimerHost(): DesktopTimerHost {
    if (typeof window !== 'undefined') {
        return {
            setTimeout: window.setTimeout.bind(window) as typeof globalThis.setTimeout,
            clearTimeout: window.clearTimeout.bind(window) as typeof globalThis.clearTimeout,
        };
    }

    return {
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
    };
}

const INSTALL_SOURCE_TIMEOUT_MS = 1500;

async function resolveWithTimeout<T>(promise: Promise<T>, fallback: T, timeoutMs: number): Promise<T> {
    const timers = getDesktopTimerHost();
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
        return await Promise.race([
            promise.catch(() => fallback),
            new Promise<T>((resolve) => {
                timeoutId = timers.setTimeout(() => resolve(fallback), timeoutMs);
            }),
        ]);
    } finally {
        if (timeoutId) {
            timers.clearTimeout(timeoutId);
        }
    }
}

export async function getInstallSourceOrFallback(fallback = 'unknown'): Promise<string> {
    if (!isTauriRuntime()) return fallback;
    // Imported lazily: tauri-invoke guards on isTauriRuntime from this module.
    const { invokeNative } = await import('./tauri-invoke');
    return resolveWithTimeout(invokeNative<string>('get_install_source'), fallback, INSTALL_SOURCE_TIMEOUT_MS);
}

/** Mirrors the Rust `LinuxDistroInfo` returned by `get_linux_distro`. */
export type LinuxDistroInfo = { id?: string; id_like?: string[] };

/** The host Linux distribution, or null off Linux and outside the desktop app. */
export async function getLinuxDistro(): Promise<LinuxDistroInfo | null> {
    // Imported lazily: tauri-invoke guards on isTauriRuntime from this module.
    const { invokeNativeOr } = await import('./tauri-invoke');
    return invokeNativeOr<LinuxDistroInfo | null>(null, 'get_linux_distro');
}
