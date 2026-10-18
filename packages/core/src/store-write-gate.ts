/**
 * The one writer boundary between store commands and a sync cycle's local saves.
 *
 * A sync save writes the merged document to disk and then publishes it to the store. A command
 * that ran between the two read the old store and saved it back over the merged rows: at an equal
 * revision the upsert accepted the old title, and an old settings object erased the pending
 * remote-write marker. So a command holds the gate from its store read through its save, and a sync
 * save holds it alone from its freshness check through the publish. Network waits stay outside it.
 *
 * Commands share the gate: one command may call another (nested actions, a receipt's write and its
 * save), so a command joins while any command holds it. A sync save waits for running commands to
 * finish, and commands that arrive meanwhile wait for the save.
 */
let commands = 0;
const storeCommands = new WeakSet<object>();

/** Mark a function as a gated store command (store.ts wraps every writing action). */
export const markStoreCommand = <T extends object>(command: T): T => {
    storeCommands.add(command);
    return command;
};

/** Whether [fn] runs inside the gate as a store command. */
export const isStoreCommand = (fn: unknown): boolean => typeof fn === 'function' && storeCommands.has(fn);
let syncSave: Promise<void> | null = null;
let onCommandsDrained: (() => void) | null = null;

/** Run a store command inside the gate. It starts at once unless a sync save holds the gate. */
export const runStoreCommand = <T>(command: () => Promise<T>): Promise<T> => {
    const held = syncSave;
    if (held && commands === 0) return held.then(() => runStoreCommand(command));
    commands += 1;
    let result: Promise<T>;
    try {
        result = Promise.resolve(command());
    } catch (error) {
        result = Promise.reject(error);
    }
    return result.finally(() => {
        commands -= 1;
        if (commands === 0) onCommandsDrained?.();
    });
};

/**
 * Inside a store command, run network [work] (an attachment download) outside the gate, so a sync save can
 * run while it waits. The command rejoins afterwards, behind that save unless another command still holds the
 * gate (a nested call must not wait on a save that waits on its caller). After it, the command must read the
 * store again and check its identity before it writes.
 */
export const runOutsideStoreGate = async <T>(work: () => Promise<T>): Promise<T> => {
    if (commands === 0) return work();
    commands -= 1;
    if (commands === 0) onCommandsDrained?.();
    try {
        return await work();
    } finally {
        while (syncSave && commands === 0) await syncSave;
        commands += 1;
    }
};

/**
 * Gate an object's methods as store commands, in place: every `async` method and every name in
 * [promiseCommands], except [ungated]. A native command then holds the gate from its first durable read
 * through its no-op decision, its writes, its save and its receipt. Outside it, a read on the shared SQLite
 * connection could see a sync save's uncommitted rows.
 */
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

/**
 * Run a sync save and its store publish with no command in between. It must not call a store command. [save] gets how long
 * this save waited for the gate (earlier sync saves and running commands), in ms.
 */
export const runSyncStoreSave = async <T>(save: (gateWaitMs: number) => Promise<T>): Promise<T> => {
    const askedAt = Date.now();
    while (syncSave) await syncSave;
    let release!: () => void;
    syncSave = new Promise<void>((resolve) => { release = resolve; });
    try {
        while (commands > 0) await new Promise<void>((resolve) => { onCommandsDrained = resolve; });
        onCommandsDrained = null;
        return await save(Date.now() - askedAt);
    } finally {
        onCommandsDrained = null;
        syncSave = null;
        release();
    }
};
