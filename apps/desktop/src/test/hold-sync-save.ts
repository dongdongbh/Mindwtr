import { runSyncStoreSave } from '@mindwtr/core';


export function holdSyncSave(publish: () => void): () => Promise<void> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const save = runSyncStoreSave(async () => { await held; publish(); });
    return async () => {
        release();
        await save;
    };
}
