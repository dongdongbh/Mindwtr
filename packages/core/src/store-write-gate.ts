


let activeStoreCommandCount = 0;
const gatedStoreCommands = new WeakSet<object>();


export const markStoreCommand = <T extends object>(command: T): T => {
    gatedStoreCommands.add(command);
    return command;
};


export const isStoreCommand = (fn: unknown): boolean => typeof fn === 'function' && gatedStoreCommands.has(fn);
let pendingSyncSave: Promise<void> | null = null;
let onCommandsDrained: (() => void) | null = null;


export const runStoreCommand = <T>(command: () => Promise<T>): Promise<T> => {
    const pendingSaveAtAdmission = pendingSyncSave;
    if (pendingSaveAtAdmission && activeStoreCommandCount === 0) return pendingSaveAtAdmission.then(() => runStoreCommand(command));
    activeStoreCommandCount += 1;
    let result: Promise<T>;
    try {
        result = Promise.resolve(command());
    } catch (error) {
        result = Promise.reject(error);
    }
    return result.finally(() => {
        activeStoreCommandCount -= 1;
        if (activeStoreCommandCount === 0) onCommandsDrained?.();
    });
};


export const runOutsideStoreGate = async <T>(work: () => Promise<T>): Promise<T> => {
    if (activeStoreCommandCount === 0) return work();
    activeStoreCommandCount -= 1;
    if (activeStoreCommandCount === 0) onCommandsDrained?.();
    try {
        return await work();
    } finally {
        while (pendingSyncSave && activeStoreCommandCount === 0) await pendingSyncSave;
        activeStoreCommandCount += 1;
    }
};


export const gateStoreCommands = <T extends object>(methods: T, options: {
    ungated?: ReadonlySet<string>; promiseCommands?: ReadonlySet<string>;
} = {}): T => {
    const target = methods as Record<string, unknown>;
    for (const [name, method] of Object.entries(target)) {
        if (typeof method !== 'function' || options.ungated?.has(name)) continue;
        if (method.constructor.name !== 'AsyncFunction' && !options.promiseCommands?.has(name)) continue;
        const command = method as (...args: unknown[]) => Promise<unknown>;
        target[name] = markStoreCommand((...args: unknown[]) => runStoreCommand(() => command.apply(methods, args)));
    }
    return methods;
};


export const runSyncStoreSave = async <T>(saveAndPublish: (gateWaitMs: number) => Promise<T>): Promise<T> => {
    const requestedAt = Date.now();
    while (pendingSyncSave) await pendingSyncSave;
    let releaseSyncSave!: () => void;
    pendingSyncSave = new Promise<void>((resolve) => { releaseSyncSave = resolve; });
    try {
        while (activeStoreCommandCount > 0) await new Promise<void>((resolve) => { onCommandsDrained = resolve; });
        onCommandsDrained = null;
        return await saveAndPublish(Date.now() - requestedAt);
    } finally {
        onCommandsDrained = null;
        pendingSyncSave = null;
        releaseSyncSave();
    }
};
