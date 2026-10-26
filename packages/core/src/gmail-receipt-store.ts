// RN's Gmail receipt store (apps/mobile/lib/gmail-capture-storage.ts), shared with the native hosts. Moved as is; each host
// opens its own device-private file and passes it here.
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
