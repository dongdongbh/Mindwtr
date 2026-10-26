import { createGmailReceiptStore, type GmailReceiptStore } from '@mindwtr/core/gmail-receipt-store';

// The store lives in core (gmail-receipt-store.ts); RN opens its own file and passes it.
export { createGmailReceiptStore } from '@mindwtr/core/gmail-receipt-store';
export type { GmailReceiptConfig, GmailReceiptDatabase, GmailReceiptStore } from '@mindwtr/core/gmail-receipt-store';

const storageFailure = () => ({ kind: 'storage', message: 'Gmail capture could not save securely.' });

const RESET_MARKER = 'receipts-reset';

let store: GmailReceiptStore | undefined;
let initializationFailed = false;
export function getGmailReceiptStore(): GmailReceiptStore {
    if (store) return store;
    if (initializationFailed) throw storageFailure();
    let database: ReturnType<typeof import('@op-engineering/op-sqlite').open> | undefined;
    let stage = 'module';
    try {
        // Load only when native Gmail is available, including outside Expo Go/FOSS.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Directory, File, Paths } = require('expo-file-system') as typeof import('expo-file-system');
        stage = 'directory';
        // RN URL pathname mutation does not update href; avoid Expo multipart path joining.
        const directory = new Directory(`${Paths.document.uri.replace(/\/$/, '')}/GmailCapture`);
        if (!directory.exists) directory.create({ intermediates: true });
        stage = 'file';
        const folder = directory.uri.replace(/\/$/, '');
        const file = new File(`${folder}/receipts.sqlite`);
        // A file left empty (a crash before its schema) or one that fails the schema check would stop capture for good, with
        // nothing in Settings to recover it. It is moved aside with its journal files, never deleted, and a fresh file starts
        // with capture off: the user starts it again, and the deterministic task IDs keep mail captured before from duplicating.
        const moveAside = () => {
            const name = `receipts.corrupt-${Date.now()}.sqlite`;
            for (const extension of ['', '-wal', '-shm', '-journal']) {
                const part = new File(`${folder}/receipts.sqlite${extension}`);
                if (part.exists) part.rename(`${name}${extension}`);
            }
            new File(`${folder}/receipts.sqlite`).create({ overwrite: false });
            // Kept on disk, so Settings says why capture is off even after a restart, until capture starts again.
            const marker = new File(`${folder}/${RESET_MARKER}`);
            if (!marker.exists) marker.create({ overwrite: false });
            return name;
        };
        // Every receipt still readable from the moved file goes into the fresh one, so starting capture again never captures
        // that mail twice (a task whose tombstone was purged would come back). An unreadable file carries none.
        const carryOver = (fresh: GmailReceiptStore, moved: string, failedStage: string) => {
            let carried = 0;
            let old: ReturnType<typeof open> | undefined;
            try {
                old = open({ name: moved, location });
                const byAccount = new Map<string, string[]>();
                for (const row of old.executeSync('SELECT account, message FROM receipts').rows) {
                    if (typeof row.account !== 'string' || typeof row.message !== 'string' || !row.account || !row.message) continue;
                    byAccount.set(row.account, [...(byAccount.get(row.account) ?? []), row.message]);
                }
                for (const [account, messages] of byAccount) { fresh.acknowledge(account, messages); carried += messages.length; }
            } catch { /* nothing readable to carry */ }
            finally { try { old?.close(); } catch { /* the moved file stays as it is */ } }
            void import('./app-log').then(({ logWarn }) => logWarn('Gmail receipt storage recovered', {
                force: true, scope: 'gmail-capture', extra: { releaseCheck: 'v1.3.8/gmail-receipts-recovered', stage: failedStage, count: String(carried) },
            })).catch(() => {});
        };
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { open } = require('@op-engineering/op-sqlite') as typeof import('@op-engineering/op-sqlite');
        const location = directory.uri.replace(/^file:\/\//, '');
        let newlyCreated = !file.exists;
        let moved: { name: string; stage: string } | null = null;
        if (newlyCreated) file.create({ overwrite: false });
        else if (file.size < 100) { moved = { name: moveAside(), stage: 'file' }; newlyCreated = true; }
        stage = 'open';
        database = open({ name: 'receipts.sqlite', location });
        stage = 'schema';
        try {
            store = createGmailReceiptStore(database, newlyCreated);
        } catch (error) {
            if (newlyCreated) throw error;
            database.close();
            database = undefined;
            moved = { name: moveAside(), stage: 'schema' };
            database = open({ name: 'receipts.sqlite', location });
            store = createGmailReceiptStore(database, true);
        }
        if (moved) carryOver(store, moved.name, moved.stage);
        return store;
    } catch (error) {
        initializationFailed = true;
        const errorKind = error instanceof TypeError ? 'type' : error instanceof Error ? 'native' : 'storage';
        void import('./app-log').then(({ logWarn }) => logWarn('Gmail receipt storage unavailable', {
            force: true, scope: 'gmail-capture', extra: { releaseCheck: 'v1.3.7/gmail-capture-storage', stage, errorKind },
        })).catch(() => {});
        try { database?.close(); } catch { /* Keep the database intact for diagnosis. */ }
        throw storageFailure();
    }
}

const resetMarker = () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { File, Paths } = require('expo-file-system') as typeof import('expo-file-system');
    return new File(`${Paths.document.uri.replace(/\/$/, '')}/GmailCapture/${RESET_MARKER}`);
};
/** True after a damaged receipts file was moved aside and capture restarted off, until [clearGmailReceiptsReset]. */
export function gmailReceiptsWereReset(): boolean {
    try { return resetMarker().exists; } catch { return false; }
}
/** Capture was started again (or the account disconnected): Settings no longer explains the reset. */
export function clearGmailReceiptsReset(): void {
    try { const marker = resetMarker(); if (marker.exists) marker.delete(); } catch { /* the notice shows again; nothing is lost */ }
}
