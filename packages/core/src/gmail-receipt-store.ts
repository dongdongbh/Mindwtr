// RN's Gmail receipt store (apps/mobile/lib/gmail-capture-storage.ts), shared with the native hosts. Moved as is. Each host
// passes its own file calls in its device-private GmailCapture folder to openGmailReceiptStore, which owns the reset rule.
export type GmailReceiptConfig = { account: string | null; label: string | null; enabled: boolean; blocked: boolean };
type SqlValue = string | number | null;
export type GmailReceiptDatabase = { executeSync: (sql: string, params?: SqlValue[]) => { rows: Record<string, unknown>[] } };
export type GmailReceiptStore = {
    config: () => GmailReceiptConfig;
    configure: (config: GmailReceiptConfig) => void;
    seen: (account: string, message: string) => boolean;
    acknowledge: (account: string, messages: string[]) => void;
};
const receiptSchema = 'CREATE TABLE receipts (account TEXT NOT NULL, message TEXT NOT NULL, PRIMARY KEY (account, message))';
const controlSchema = 'CREATE TABLE control (id INTEGER PRIMARY KEY CHECK (id = 1), account TEXT, label TEXT, enabled INTEGER NOT NULL, blocked INTEGER NOT NULL)';
const storageFailure = () => ({ kind: 'storage', message: 'Gmail capture could not save securely.' });

export function createGmailReceiptStore(db: GmailReceiptDatabase, newlyCreated: boolean): GmailReceiptStore {
    const execute = (sql: string, params?: SqlValue[]) => db.executeSync(sql, params).rows;
    const transaction = (work: () => void) => {
        execute('BEGIN IMMEDIATE');
        try { work(); execute('COMMIT'); } catch (error) {
            try { execute('ROLLBACK'); } catch { /* Preserve the original failure. */ }
            throw error;
        }
    };
    const guarded = <T>(work: () => T): T => { try { return work(); } catch { throw storageFailure(); } };
    const config = (): GmailReceiptConfig => guarded(() => {
        const rows = execute('SELECT * FROM control');
        const row = rows[0];
        if (rows.length !== 1 || row.id !== 1 || ![0, 1].includes(row.enabled as number)
            || ![0, 1].includes(row.blocked as number)
            || !(row.account === null || typeof row.account === 'string')
            || !(row.label === null || typeof row.label === 'string')
            || (row.enabled === 1 && (!row.account || !row.label || row.blocked !== 0))) throw storageFailure();
        return { account: row.account as string | null, label: row.label as string | null, enabled: row.enabled === 1, blocked: row.blocked === 1 };
    });
    guarded(() => {
        if (newlyCreated) transaction(() => {
            execute(receiptSchema); execute(controlSchema);
            execute('INSERT INTO control VALUES (1, NULL, NULL, 0, 1)');
        });
        const schemas = execute("SELECT name, sql FROM sqlite_master WHERE type = 'table'");
        if (schemas.length !== 2 || schemas.find((row) => row.name === 'receipts')?.sql !== receiptSchema
            || schemas.find((row) => row.name === 'control')?.sql !== controlSchema) throw storageFailure();
        config();
        execute('PRAGMA synchronous = FULL');
    });
    return {
        config,
        configure: (value) => guarded(() => transaction(() => {
            execute('UPDATE control SET account = ?, label = ?, enabled = ?, blocked = ? WHERE id = 1',
                [value.account, value.label, Number(value.enabled), Number(value.blocked)]);
            config();
        })),
        seen: (account, message) => guarded(() => execute('SELECT 1 FROM receipts WHERE account = ? AND message = ?', [account, message]).length > 0),
        acknowledge: (account, messages) => guarded(() => transaction(() => {
            for (const message of messages) execute('INSERT OR IGNORE INTO receipts VALUES (?, ?)', [account, message]);
        })),
    };
}

/** A host's file calls inside its device-private GmailCapture folder. Every argument is a bare file name, never a path. */
export type GmailReceiptFiles = {
    exists: (name: string) => boolean;
    size: (name: string) => number;
    /** Creates an empty file; fails if one exists. */
    create: (name: string) => void;
    rename: (from: string, to: string) => void;
    remove: (name: string) => void;
    list: () => string[];
    open: (name: string) => GmailReceiptDatabase & { close: () => void };
};
export type GmailReceiptOpenOptions = {
    /** The step now running, for the host's failure line (file, open, schema). */
    onStage?: (stage: 'file' | 'open' | 'schema') => void;
    logWarn?: (message: string, extra: Record<string, string>) => void;
    now?: () => number;
};
const receiptsFile = 'receipts.sqlite';
const resetMarker = 'receipts-reset';

/**
 * Opens the receipts file. A file left empty (a crash before its schema) or one that fails the schema check would stop
 * capture for good, with nothing in Settings to recover it. It is moved aside with its journal files, never deleted, and a
 * fresh file starts with capture off: the user starts it again, and the deterministic task IDs keep mail captured before
 * from duplicating.
 */
export function openGmailReceiptStore(files: GmailReceiptFiles, options: GmailReceiptOpenOptions = {}): GmailReceiptStore {
    const now = options.now ?? Date.now;
    // The marker goes first: a reset cut short anywhere after it is finished by the next open's carry-over below. The journals
    // move before the file, so a hot journal is never left beside a fresh file to be played back into it.
    const moveAside = () => {
        if (!files.exists(resetMarker)) files.create(resetMarker);
        let time = now();
        while (files.exists(`receipts.corrupt-${time}.sqlite`)) time += 1;
        for (const extension of ['-wal', '-shm', '-journal', '']) {
            if (files.exists(`${receiptsFile}${extension}`)) files.rename(`${receiptsFile}${extension}`, `receipts.corrupt-${time}.sqlite${extension}`);
        }
        files.create(receiptsFile);
    };
    // While the marker is kept (Settings shows the reset until capture starts again), every receipt still readable from any
    // moved file goes into the fresh one, so starting capture again never captures that mail twice (a task whose tombstone
    // was purged would come back). INSERT OR IGNORE makes a repeat harmless; an unreadable file carries none.
    const carryOver = (fresh: GmailReceiptStore, stage: string) => {
        let carried = 0;
        for (const moved of files.list().filter((name) => /^receipts\.corrupt-\d+\.sqlite$/.test(name)).sort()) {
            let old: ReturnType<GmailReceiptFiles['open']> | undefined;
            try {
                old = files.open(moved);
                const byAccount = new Map<string, string[]>();
                for (const row of old.executeSync('SELECT account, message FROM receipts').rows) {
                    if (typeof row.account !== 'string' || typeof row.message !== 'string' || !row.account || !row.message) continue;
                    const messages = byAccount.get(row.account);
                    if (messages) messages.push(row.message); else byAccount.set(row.account, [row.message]);
                }
                for (const [account, messages] of byAccount) { fresh.acknowledge(account, messages); carried += messages.length; }
            } catch { /* nothing readable to carry */ }
            finally { try { old?.close(); } catch { /* the moved file stays as it is */ } }
        }
        options.logWarn?.('Gmail receipt storage recovered', {
            releaseCheck: 'v1.3.8/gmail-receipts-recovered', stage, count: String(carried),
        });
    };
    options.onStage?.('file');
    let newlyCreated = !files.exists(receiptsFile);
    // An earlier start moved the file (perhaps cut short); this open carries over again, unless it moves a file itself.
    let stage = 'resume';
    if (newlyCreated) files.create(receiptsFile);
    else if (files.size(receiptsFile) < 100) { moveAside(); stage = 'file'; newlyCreated = true; }
    options.onStage?.('open');
    let database: ReturnType<GmailReceiptFiles['open']> | undefined = files.open(receiptsFile);
    try {
        options.onStage?.('schema');
        let store: GmailReceiptStore;
        try {
            store = createGmailReceiptStore(database, newlyCreated);
        } catch (error) {
            if (newlyCreated) throw error;
            database.close();
            database = undefined;
            moveAside();
            stage = 'schema';
            database = files.open(receiptsFile);
            store = createGmailReceiptStore(database, true);
        }
        if (files.exists(resetMarker)) carryOver(store, stage);
        return store;
    } catch (error) {
        try { database?.close(); } catch { /* Keep the database intact for diagnosis. */ }
        throw error;
    }
}

/** True after a damaged receipts file was moved aside and capture restarted off, until [clearGmailReceiptsReset]. */
export function gmailReceiptsWereReset(files: Pick<GmailReceiptFiles, 'exists'>): boolean {
    return files.exists(resetMarker);
}
/** Capture was started again (or the account disconnected): Settings no longer explains the reset. */
export function clearGmailReceiptsReset(files: Pick<GmailReceiptFiles, 'exists' | 'remove'>): void {
    if (files.exists(resetMarker)) files.remove(resetMarker);
}
