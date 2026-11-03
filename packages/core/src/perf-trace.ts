


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
