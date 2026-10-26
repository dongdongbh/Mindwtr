import {
    clearGmailReceiptsReset as clearReset, gmailReceiptsWereReset as wereReset, openGmailReceiptStore,
    type GmailReceiptFiles, type GmailReceiptStore,
} from '@mindwtr/core/gmail-receipt-store';

// The store and its reset rule live in core (gmail-receipt-store.ts); RN passes its Expo file calls.
export type { GmailReceiptDatabase, GmailReceiptStore } from '@mindwtr/core/gmail-receipt-store';

const storageFailure = () => ({ kind: 'storage', message: 'Gmail capture could not save securely.' });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fileSystem = () => require('expo-file-system') as typeof import('expo-file-system');
// RN URL pathname mutation does not update href; avoid Expo multipart path joining.
const folderUri = (paths: typeof import('expo-file-system').Paths) => `${paths.document.uri.replace(/\/$/, '')}/GmailCapture`;
const receiptFiles = (): GmailReceiptFiles => {
    const { Directory, File, Paths } = fileSystem();
    const folder = folderUri(Paths);
    const directory = new Directory(folder);
    const file = (name: string) => new File(`${folder}/${name}`);
    return {
        exists: (name) => file(name).exists,
        size: (name) => file(name).size,
        create: (name) => file(name).create({ overwrite: false }),
        rename: (from, to) => file(from).rename(to),
        remove: (name) => file(name).delete(),
        list: () => directory.list().map((entry) => entry.name),
        open: (name) => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { open } = require('@op-engineering/op-sqlite') as typeof import('@op-engineering/op-sqlite');
            return open({ name, location: directory.uri.replace(/^file:\/\//, '') });
        },
    };
};

let store: GmailReceiptStore | undefined;
let initializationFailed = false;
export function getGmailReceiptStore(): GmailReceiptStore {
    if (store) return store;
    if (initializationFailed) throw storageFailure();
    let stage = 'module';
    try {
        // Load only when native Gmail is available, including outside Expo Go/FOSS.
        const { Directory, Paths } = fileSystem();
        stage = 'directory';
        const directory = new Directory(folderUri(Paths));
        if (!directory.exists) directory.create({ intermediates: true });
        store = openGmailReceiptStore(receiptFiles(), {
            onStage: (next) => { stage = next; },
            logWarn: (message, extra) => {
                void import('./app-log').then(({ logWarn }) => logWarn(message, { force: true, scope: 'gmail-capture', extra }))
                    .catch(() => {});
            },
        });
        return store;
    } catch (error) {
        initializationFailed = true;
        const errorKind = error instanceof TypeError ? 'type' : error instanceof Error ? 'native' : 'storage';
        void import('./app-log').then(({ logWarn }) => logWarn('Gmail receipt storage unavailable', {
            force: true, scope: 'gmail-capture', extra: { releaseCheck: 'v1.3.7/gmail-capture-storage', stage, errorKind },
        })).catch(() => {});
        throw storageFailure();
    }
}

/** True after a damaged receipts file was moved aside and capture restarted off, until [clearGmailReceiptsReset]. */
export function gmailReceiptsWereReset(): boolean {
    try { return wereReset(receiptFiles()); } catch { return false; }
}
/** Capture was started again (or the account disconnected): Settings no longer explains the reset. */
export function clearGmailReceiptsReset(): void {
    try { clearReset(receiptFiles()); } catch { /* the notice shows again; nothing is lost */ }
}
