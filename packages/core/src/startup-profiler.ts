const STARTUP_TAG = 'MindwtrStartup';

const isStartupProfilingEnabled = (): boolean => {
    const g = globalThis as Record<string, unknown>;
    return g.__MINDWTR_STARTUP_PROFILING__ === true;
};

const serializeExtra = (extra?: Record<string, unknown>): string => {
    if (!extra) return '';
    const parts = Object.entries(extra)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${String(value).replace(/\s+/g, '_')}`);
    return parts.length > 0 ? ` ${parts.join(' ')}` : '';
};

const logStartupLine = (line: string): void => {
    const maybeHook = (globalThis as { nativeLoggingHook?: unknown }).nativeLoggingHook;
    if (typeof maybeHook === 'function') {
        try {
            (maybeHook as (message: string, level: number) => void)(line, 1);
            return;
        } catch {
            // Fall back to console logging.
        }
    }
    console.info(line);
};

export const markCoreStartupPhase = (phase: string, extra?: Record<string, unknown>): void => {
    if (!isStartupProfilingEnabled()) return;
    const nowMs = Date.now();
    const extraPayload = serializeExtra(extra);
    // Keep same tag/format so mobile benchmark parser can aggregate seamlessly.
    logStartupLine(`[${STARTUP_TAG}] phase=${phase} wallMs=${nowMs}${extraPayload}`);
};

export const measureCoreStartupPhase = async <T>(
    phase: string,
    work: () => Promise<T> | T
): Promise<T> => {
    if (!isStartupProfilingEnabled()) {
        return await work();
    }
    const startMs = Date.now();
    markCoreStartupPhase(`${phase}:start`);
    try {
        return await work();
    } finally {
        markCoreStartupPhase(`${phase}:end`, { durationMs: Date.now() - startMs });
    }
};
