import { createGmailReceiptStore, type GmailReceiptStore } from '@mindwtr/core/gmail-receipt-store';

// The store lives in core (gmail-receipt-store.ts); RN opens its own file and passes it.
export { createGmailReceiptStore } from '@mindwtr/core/gmail-receipt-store';
export type { GmailReceiptConfig, GmailReceiptDatabase, GmailReceiptStore } from '@mindwtr/core/gmail-receipt-store';

const storageFailure = () => ({ kind: 'storage', message: 'Gmail capture could not save securely.' });

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
        const moveAside = (failedStage: string) => {
            const suffix = `corrupt-${Date.now()}`;
            for (const extension of ['', '-wal', '-shm', '-journal']) {
                const part = new File(`${folder}/receipts.sqlite${extension}`);
                if (part.exists) part.rename(`receipts.${suffix}.sqlite${extension}`);
            }
            void import('./app-log').then(({ logWarn }) => logWarn('Gmail receipt storage recovered', {
                force: true, scope: 'gmail-capture', extra: { releaseCheck: 'v1.3.8/gmail-receipts-recovered', stage: failedStage },
            })).catch(() => {});
            new File(`${folder}/receipts.sqlite`).create({ overwrite: false });
        };
        let newlyCreated = !file.exists;
        if (newlyCreated) file.create({ overwrite: false });
        else if (file.size < 100) { moveAside('file'); newlyCreated = true; }
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { open } = require('@op-engineering/op-sqlite') as typeof import('@op-engineering/op-sqlite');
        stage = 'open';
        const location = directory.uri.replace(/^file:\/\//, '');
        database = open({ name: 'receipts.sqlite', location });
        stage = 'schema';
        try {
            store = createGmailReceiptStore(database, newlyCreated);
        } catch (error) {
            if (newlyCreated) throw error;
            database.close();
            database = undefined;
            moveAside('schema');
            database = open({ name: 'receipts.sqlite', location });
            store = createGmailReceiptStore(database, true);
        }
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
