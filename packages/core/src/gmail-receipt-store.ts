

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
            try { execute('ROLLBACK'); } catch {                                      }
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


export type GmailReceiptFiles = {
    exists: (name: string) => boolean;
    size: (name: string) => number;

    create: (name: string) => void;
    rename: (from: string, to: string) => void;
    remove: (name: string) => void;
    list: () => string[];
    open: (name: string) => GmailReceiptDatabase & { close: () => void };
};
export type GmailReceiptOpenOptions = {

    onStage?: (stage: 'file' | 'open' | 'schema') => void;
    logWarn?: (message: string, extra: Record<string, string>) => void;
    now?: () => number;
};
const receiptsFile = 'receipts.sqlite';
const resetMarker = 'receipts-reset';


export function openGmailReceiptStore(files: GmailReceiptFiles, options: GmailReceiptOpenOptions = {}): GmailReceiptStore {
    const now = options.now ?? Date.now;


    const moveAside = () => {
        if (!files.exists(resetMarker)) files.create(resetMarker);
        let time = now();
        while (files.exists(`receipts.corrupt-${time}.sqlite`)) time += 1;
        for (const extension of ['-wal', '-shm', '-journal', '']) {
            if (files.exists(`${receiptsFile}${extension}`)) files.rename(`${receiptsFile}${extension}`, `receipts.corrupt-${time}.sqlite${extension}`);
        }
        files.create(receiptsFile);
    };


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
            } catch {                                 }
            finally { try { old?.close(); } catch {                                     } }
        }
        options.logWarn?.('Gmail receipt storage recovered', {
            releaseCheck: 'v1.3.8/gmail-receipts-recovered', stage, count: String(carried),
        });
    };
    options.onStage?.('file');
    let newlyCreated = !files.exists(receiptsFile);

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
        try { database?.close(); } catch {                                               }
        throw error;
    }
}


export function gmailReceiptsWereReset(files: Pick<GmailReceiptFiles, 'exists'>): boolean {
    return files.exists(resetMarker);
}

export function clearGmailReceiptsReset(files: Pick<GmailReceiptFiles, 'exists' | 'remove'>): void {
    if (files.exists(resetMarker)) files.remove(resetMarker);
}
