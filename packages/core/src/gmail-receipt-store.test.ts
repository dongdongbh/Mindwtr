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
    const renames: Array<[string, string]> = [];
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
            renames.push([from, to]);
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
    return { root, path, files, closeAll, damage, aside, renames };
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

// An interrupted reset must not lose the moved file's receipts (G1 review finding 1): the marker is written first, and every
// open while it exists carries over from every moved file, so the next start finishes what the first one could not.
describe('Gmail receipts reset interrupted part way', () => {
    it.each([
        ['the fresh file cannot get its schema (a full disk)', { sql: (name: string, sql: string) => name === 'receipts.sqlite' && sql.startsWith('CREATE TABLE receipts') }, 'file'],
        ['the fresh file cannot be created (the app dies after the move)', { create: (name: string) => name === 'receipts.sqlite' }, 'resume'],
        ['the reset marker cannot be written', { create: (name: string) => name === 'receipts-reset' }, 'schema'],
        ['the receipts file cannot be moved', { rename: (name: string) => name === 'receipts.sqlite' }, 'schema'],
    ])('keeps every receipt when %s', (_name, fault, stage) => {
        let armed = true;
        const faults = fault as { create?: (name: string) => boolean; rename?: (name: string) => boolean; sql?: (name: string, sql: string) => boolean };
        const folder = receiptFolder({
            create: (name) => armed && faults.create?.(name) === true,
            rename: (name) => armed && faults.rename?.(name) === true,
            sql: (name, sql) => armed && faults.sql?.(name, sql) === true,
        });
        folder.damage();
        const now = () => 1000;
        expect(() => openGmailReceiptStore(folder.files, { now })).toThrow();
        folder.closeAll();

        armed = false;
        const logWarn = vi.fn();
        const store = openGmailReceiptStore(folder.files, { now, logWarn });
        expect(store.seen('a', 'kept')).toBe(true);
        expect(store.config()).toEqual({ account: null, label: null, enabled: false, blocked: true });
        expect(gmailReceiptsWereReset(folder.files)).toBe(true);
        expect(logWarn).toHaveBeenCalledExactlyOnceWith('Gmail receipt storage recovered', {
            releaseCheck: 'v1.3.8/gmail-receipts-recovered', stage, count: '1',
        });
        folder.closeAll();

        // Carrying over again is harmless, and it stops once capture starts again.
        expect(openGmailReceiptStore(folder.files, { now, logWarn }).seen('a', 'kept')).toBe(true);
        expect(logWarn).toHaveBeenCalledTimes(2);
        folder.closeAll();
        clearGmailReceiptsReset(folder.files);
        openGmailReceiptStore(folder.files, { now, logWarn });
        expect(logWarn).toHaveBeenCalledTimes(2);
    });

    // A hot journal left beside a fresh file would be played back into it, so the journals move first and the file last.
    it.each(['receipts.sqlite', 'receipts.sqlite-journal'])('never leaves a journal beside a fresh file when moving %s fails', (failing) => {
        let armed = true;
        const folder = receiptFolder({ rename: (name) => armed && name === failing });
        writeFileSync(folder.path('receipts.sqlite'), '');
        writeFileSync(folder.path('receipts.sqlite-journal'), 'journal of the empty file');
        expect(() => openGmailReceiptStore(folder.files, { now: () => 1000 })).toThrow();
        if (existsSync(folder.path('receipts.sqlite-journal'))) expect(existsSync(folder.path('receipts.sqlite'))).toBe(true);
        armed = false;
        openGmailReceiptStore(folder.files, { now: () => 1000 });
        expect(existsSync(folder.path('receipts.sqlite-journal'))).toBe(false);
        expect(folder.renames).toContainEqual(['receipts.sqlite-journal', 'receipts.corrupt-1000.sqlite-journal']);
    });

    it('moves the journal files with the damaged file', () => {
        const folder = receiptFolder();
        writeFileSync(folder.path('receipts.sqlite'), '');
        for (const extension of ['-wal', '-shm', '-journal']) writeFileSync(folder.path(`receipts.sqlite${extension}`), extension);
        openGmailReceiptStore(folder.files, { now: () => 1000 });
        expect(folder.renames).toEqual(['-wal', '-shm', '-journal', ''].map((extension) => [
            `receipts.sqlite${extension}`, `receipts.corrupt-1000.sqlite${extension}`,
        ]));
    });
});
