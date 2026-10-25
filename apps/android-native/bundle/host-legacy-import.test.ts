// The native upgrade of an RN install, through the shipped host-entry over bun:sqlite: the
// preflight (`legacyCheck`, before SQLite opens) and the boot's import of RN's JSON copy.
// a108d6764: a copy SQLite always rejects is repaired, not refused at every start.
// e93722f3d: the first move keeps the copy's device-local settings.
import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import vm from 'node:vm';
import { build } from 'esbuild';

const databases: Database[] = [];
let source: string;

beforeAll(async () => {
    const built = await build({
        stdin: { contents: `import './host-entry';`, resolveDir: import.meta.dir, loader: 'ts' },
        bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent',
    });
    source = built.outputFiles[0].text;
});
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

const fixture = () => {
    const database = new Database(':memory:'); databases.push(database);
    database.exec('PRAGMA foreign_keys = ON');
    const lines: string[] = [];
    const rnState: string[] = [];
    const state: Record<string, any> = {
        AbortController, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout, WeakRef,
        // Shared host-entry code; the iOS table needs the fewest bridge functions.
        __mindwtrHostPlatform: 'ios',
        // Core's logger writes each line to the console first (logcat on the phone).
        console: Object.fromEntries(['info', 'warn', 'error', 'log', 'debug'].map((level) => [level, (...args: unknown[]) => {
            lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
        }])),
        __mindwtrNative: {
            sqlExec: (sql: string) => { database.exec(sql); return null; },
            sqlRun: (sql: string, params: string) => { database.query(sql).run(...JSON.parse(params)); return null; },
            sqlAll: (sql: string, params: string) => JSON.stringify(database.query(sql).all(...JSON.parse(params))),
            nowMs: () => Date.now(), randomBytes: (count: number) => JSON.stringify(Array(count).fill(7)),
            log: (line: string) => { lines.push(line); return null; },
            logFile: (operation: string) => (['path', 'ensure'].includes(operation) ? 'files/logs/mindwtr.log' : ''),
            rnStateCommit: (change: string) => { rnState.push(change); return null; },
            kvGet: () => '[null]', kvSet: () => null, kvRemove: () => null,
            fileList: () => 'null', fileRead: () => '', fileDelete: () => null,
        },
    };
    vm.runInNewContext(source, state);
    const poll = async (ticket: string) => {
        for (let step = 0; step < 500; step++) {
            const answer = state.MindwtrHost.poll(ticket);
            if (answer !== null) return JSON.parse(answer);
            await new Promise((done) => setTimeout(done, 0));
        }
        throw new Error('Host operation did not settle');
    };
    return { host: state.MindwtrHost, poll, database, lines, rnState };
};

const AT = '2026-09-20T10:00:00.000Z';
// RN's JSON copy as a broken older build left it: a null entry, rows without a title or name,
// a section whose project is gone, and settings that belong to this device only.
const brokenCopy = JSON.stringify({
    tasks: [null, { id: 't1', title: null, description: 'Private note', status: 'inbox', tags: [], contexts: [], sectionId: 's-orphan',
        rev: 2, revBy: 'rn', createdAt: AT, updatedAt: AT }],
    projects: [{ id: 'p1', title: null, status: 'active', color: '#94a3b8', rev: 1, revBy: 'rn', createdAt: AT, updatedAt: AT }],
    sections: [{ id: 's-orphan', projectId: 'gone', title: 'S', rev: 1, revBy: 'rn', createdAt: AT, updatedAt: AT }],
    areas: [{ id: 'a1', name: null, order: 0, rev: 1, revBy: 'rn', createdAt: AT, updatedAt: AT }],
    people: [], settings: { theme: 'dark', notificationsEnabled: false },
});
const migrateState = JSON.stringify({ jsonAhead: false, reconciled: false, backupVersion: '2', backupPresent: true });

describe('native upgrade of an RN JSON copy', () => {
    it('passes the preflight for a copy the SQLite repair fixes, and still refuses duplicate ids', async () => {
        const f = fixture();
        expect((await f.poll(f.host.legacyCheck(migrateState, brokenCopy))).ok).toBe(true);

        const duplicate = JSON.parse(brokenCopy);
        duplicate.tasks.push({ ...duplicate.tasks[1], title: 'Twin' });
        expect((await f.poll(f.host.legacyCheck(migrateState, JSON.stringify(duplicate)))).ok).toBe(false);
    });

    it('boots with the repaired copy in SQLite, every task kept, and this device\'s settings kept', async () => {
        const f = fixture();

        expect((await f.poll(f.host.boot(migrateState, brokenCopy))).ok).toBe(true);

        const tasks = f.database.query('SELECT id, title, description, sectionId FROM tasks').all();
        expect(tasks).toEqual([{ id: 't1', title: 'Untitled', description: 'Private note', sectionId: null }]);
        expect(f.database.query('SELECT title FROM projects').all()).toEqual([{ title: 'Untitled' }]);
        expect(f.database.query('SELECT COUNT(*) AS count FROM sections').get()).toEqual({ count: 0 });
        const settings = JSON.parse((f.database.query('SELECT data FROM settings WHERE id = 1').get() as { data: string }).data);
        expect(settings).toEqual(expect.objectContaining({ theme: 'dark', notificationsEnabled: false }));
        expect(f.rnState).toEqual([JSON.stringify({ clearJsonAhead: false, setReconciled: true })]);

        const repairLine = f.lines.find((line) => line.includes('v1.3.8/native-legacy-copy-repair'));
        // The console line nests the context as JSON text, so a count reads as untitledTasks\\":\\"1.
        expect(repairLine).toMatch(/untitledTasks\W+1\b/);
        expect(repairLine).toMatch(/orphanSections\W+1\b/);
        expect(repairLine).not.toContain('Private note');
    });
});
