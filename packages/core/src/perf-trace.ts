/**
 * Trace sections for on-device profiling. A host that profiles (the native Android host, into Perfetto) sets
 * `globalThis.__mindwtrTraceSection`: a name opens a section, '' closes the open one. Without it these are plain calls.
 * Sections nest per thread, so the work inside one must not wait on a timer or a host call (fetch, file IO): only on
 * synchronous work, or on promises that settle in the same turn (the native host's SQLite calls).
 */
type TraceHook = (name: string) => void;

const hook = (): TraceHook | undefined => (globalThis as { __mindwtrTraceSection?: TraceHook }).__mindwtrTraceSection;

export const traceSection = <T>(name: string, work: () => T): T => {
    const trace = hook();
    if (!trace) return work();
    trace(name);
    try {
        return work();
    } finally {
        trace('');
    }
};

export const traceSectionAsync = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    const trace = hook();
    if (!trace) return work();
    trace(name);
    try {
        return await work();
    } finally {
        trace('');
    }
};
