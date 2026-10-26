import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createGmailReceiptStore, type GmailReceiptDatabase } from './gmail-receipt-store';
function database() {
    const db = new DatabaseSync(':memory:');
    const adapter: GmailReceiptDatabase = { executeSync(sql, params = []) {
        const statement = db.prepare(sql);
        if (statement.columns().length) return { rows: statement.all(...params) };
        statement.run(...params); return { rows: [] };
    } };
    return { db, adapter };
}
describe('Gmail durable receipts', () => {
    it('retains receipts through reconnect/configuration changes and reopening', () => {
        const { adapter } = database();
        const store = createGmailReceiptStore(adapter, true);
        store.acknowledge('a', ['1']);
        store.configure({ account: 'b', label: null, enabled: false, blocked: true });
        const reopened = createGmailReceiptStore(adapter, false);
        expect(reopened.seen('a', '1')).toBe(true);
        expect(reopened.seen('b', '1')).toBe(false);
        expect(reopened.config().blocked).toBe(true);
    });
    it('does not initialize an existing empty or partial database', () => {
        const { db, adapter } = database();
        expect(() => createGmailReceiptStore(adapter, false)).toThrow();
        expect(db.prepare('SELECT * FROM sqlite_master').all()).toEqual([]);
        db.exec('CREATE TABLE receipts (account TEXT, message TEXT)');
        expect(() => createGmailReceiptStore(adapter, false)).toThrow();
        expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toHaveLength(1);
    });
    it('refuses corrupt control state without repairing it', () => {
        const { db, adapter } = database();
        createGmailReceiptStore(adapter, true);
        db.exec('UPDATE control SET enabled=7');
        expect(() => createGmailReceiptStore(adapter, false)).toThrow();
        expect(db.prepare('SELECT enabled FROM control').get()?.enabled).toBe(7);
    });
    it('rolls back all acknowledgements when one insert fails', () => {
        const { db, adapter } = database();
        const store = createGmailReceiptStore(adapter, true);
        db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON receipts WHEN NEW.message='bad' BEGIN SELECT RAISE(ABORT, 'test'); END");
        expect(() => store.acknowledge('a', ['ok', 'bad'])).toThrow();
        expect(store.seen('a', 'ok')).toBe(false);
    });
});
