import { runSyncStoreSave } from '@mindwtr/core';

/**
 * Holds a sync save on the store write gate. A write issued while it holds waits; the returned finish() lets the save
 * publish [publish] (newer rows, as a sync merge does) and resolves once the save is done, so the waiting write is
 * admitted on the published rows.
 */
export function holdSyncSave(publish: () => void): () => Promise<void> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const save = runSyncStoreSave(async () => { await held; publish(); });
    return async () => {
        release();
        await save;
    };
}
