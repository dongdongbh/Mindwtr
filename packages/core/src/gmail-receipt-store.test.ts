import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    clearGmailReceiptsReset, createGmailReceiptStore, gmailReceiptsWereReset, openGmailReceiptStore,
    type GmailReceiptDatabase, type GmailReceiptFiles,
} from './gmail-receipt-store';
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

// The reset rule each host shares: a node:fs folder stands in for the host's file calls.
function receiptFolder(faults: { create?: (name: string) => boolean; rename?: (name: string) => boolean; sql?: (name: string, sql: string) => boolean } = {}) {
    const parent = join(homedir(), '.cache', 'mindwtr-tests');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'gmail-receipts-'));
    const databases: DatabaseSync[] = [];
    const path = (name: string) => join(root, name);
    const files: GmailReceiptFiles = {
        exists: (name) => existsSync(path(name)),
        size: (name) => statSync(path(name)).size,
        create: (name) => {
            if (faults.create?.(name)) throw new Error('injected create failure');
            writeFileSync(path(name), '', { flag: 'wx' });
        },
        rename: (from, to) => {
            if (faults.rename?.(from)) throw new Error('injected rename failure');
            if (existsSync(path(to))) throw new Error('Destination exists');
            renameSync(path(from), path(to));
        },
        remove: (name) => rmSync(path(name)),
        list: () => readdirSync(root),
        open: (name) => {
            const db = new DatabaseSync(path(name));
            databases.push(db);
            return {
                executeSync(sql, params = []) {
                    if (faults.sql?.(name, sql)) throw new Error('injected sql failure');
                    const statement = db.prepare(sql);
                    if (statement.columns().length) return { rows: statement.all(...params) };
                    statement.run(...params); return { rows: [] };
                },
                close() { if (db.isOpen) db.close(); },
            };
        },
    };
    const closeAll = () => databases.splice(0).forEach((db) => { if (db.isOpen) db.close(); });
    cleanUps.push(() => { closeAll(); rmSync(root, { recursive: true, force: true }); });
    const damage = (rows = "('a', 'kept'), ('a', NULL)") => {
        const db = new DatabaseSync(path('receipts.sqlite'));
        db.exec(`CREATE TABLE receipts (account TEXT, message TEXT); INSERT INTO receipts VALUES ${rows}`);
        db.close();
    };
    const aside = () => readdirSync(root).filter((name) => /^receipts\.corrupt-\d+\.sqlite$/.test(name)).sort();
    return { root, path, files, closeAll, damage, aside };
}
const cleanUps: Array<() => void> = [];
afterEach(() => { cleanUps.splice(0).forEach((cleanUp) => cleanUp()); });

describe('Gmail receipts file reset', () => {
    it('creates a fresh file with capture off and reopens it as it is', () => {
        const folder = receiptFolder();
        const logWarn = vi.fn();
        const store = openGmailReceiptStore(folder.files, { logWarn });
        expect(store.config()).toEqual({ account: null, label: null, enabled: false, blocked: true });
        store.acknowledge('a', ['1']);
        folder.closeAll();
        expect(openGmailReceiptStore(folder.files, { logWarn }).seen('a', '1')).toBe(true);
        expect(gmailReceiptsWereReset(folder.files)).toBe(false);
        expect(logWarn).not.toHaveBeenCalled();
    });

    it.each([
        ['an empty file', (folder: ReturnType<typeof receiptFolder>) => writeFileSync(folder.path('receipts.sqlite'), ''), 'file', '0'],
        ['a file whose schema fails the check', (folder: ReturnType<typeof receiptFolder>) => folder.damage(), 'schema', '1'],
    ])('moves %s aside, starts capture off and carries every readable receipt over', (_name, damage, stage, carried) => {
        const folder = receiptFolder();
        damage(folder);
        const logWarn = vi.fn();
        const stages: string[] = [];
        const store = openGmailReceiptStore(folder.files, { logWarn, onStage: (next) => stages.push(next) });
        expect(stages).toEqual(['file', 'open', 'schema']);
        expect(store.config()).toEqual({ account: null, label: null, enabled: false, blocked: true });
        expect(store.seen('a', 'kept')).toBe(stage === 'schema');
        expect(folder.aside()).toHaveLength(1);
        expect(gmailReceiptsWereReset(folder.files)).toBe(true);
        clearGmailReceiptsReset(folder.files);
        expect(gmailReceiptsWereReset(folder.files)).toBe(false);
        expect(logWarn).toHaveBeenCalledExactlyOnceWith('Gmail receipt storage recovered', {
            releaseCheck: 'v1.3.8/gmail-receipts-recovered', stage, count: carried,
        });
    });
});
