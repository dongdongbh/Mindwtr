import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// readRowBaseline reuses its last rows while no write transaction started since (SqliteAdapter.generation): a same-connection
// write outside the adapter is invisible to PRAGMA data_version. So every SQL write in core and the native Android bundle is
// listed here by its enclosing method, with why it is safe. A new raw run/exec, or a get/all of INSERT/UPDATE/DELETE, fails
// this test until it is listed (and goes through noteWrite, withConnection(write: true), withHostConnection, or
// invalidateWriteBaselineAfterDirectSQL). readRowBaseline also compares total_changes() before a reuse.

const srcDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(srcDir, '..', '..', '..');
const bundleDir = join(repoRoot, 'apps', 'android-native', 'bundle');

const WRITE = /\b(?:this\.client|this\.receiptClient|client|receiptClient|sqlite|db)\.(?:run|exec!?)\(|\.(?:get|all)\s*(?:<[^>]*>)?\(\s*[`'"]\s*(?:INSERT|UPDATE|DELETE|REPLACE)/g;
const METHOD = /^ {4}(?:(?:private|protected|public|async|static|override|readonly) )*(?:async )?\*?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\(/;
const TOP = /^(?:export )?(?:async )?(?:function\*? |const |class )([A-Za-z_$][\w$]*)/;
const NOT_METHODS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return']);

const ALLOWED: Record<string, Record<string, number>> = {
    'packages/core/src/sqlite-adapter.ts': {
        // Schema, FTS tables and the FTS lock row: no entity, settings or saved-filter row (readRowBaseline reads none of them).
        'SqliteAdapter.acquireFtsLock': 2, 'SqliteAdapter.releaseFtsLock': 1, 'SqliteAdapter.refreshFtsLock': 1,
        'SqliteAdapter.ensureSchemaInternal': 6, 'SqliteAdapter.ensureFtsSchema': 5, 'SqliteAdapter.ensureFtsTriggers': 7,
        'SqliteAdapter.ensureTaskColumns': 2, 'SqliteAdapter.ensureProjectColumns': 5, 'SqliteAdapter.ensureSectionColumns': 3,
        'SqliteAdapter.ensureAreaColumns': 2, 'SqliteAdapter.ensurePeopleTable': 3, 'SqliteAdapter.ensureSavedFilterTable': 4,
        'SqliteAdapter.ensureFtsPopulated': 7,
        // Write transactions that call noteWrite.
        'SqliteAdapter.saveTaskNow': 4, 'SqliteAdapter.saveDataNow': 4,
        'SqliteAdapter.upsertCalendarSyncEntryNow': 1, 'SqliteAdapter.deleteCalendarSyncEntryNow': 1,
    },
    'packages/core/src/native-request-receipts.ts': {
        // Called by the bundle only inside withConnection(write: true) or withHostConnection (checked below).
        'loadNativeRequestReceipts.?': 2, 'pruneNativeRequestReceipts.?': 2,
        // The receipt client's delegation to the adapter's own client.
        'NativeReceiptSqliteAdapter.constructor': 2,
        // noteWrite, and invalidateWriteBaselineAfterDirectSQL when its outcome is unknown.
        'NativeReceiptSqliteAdapter.savePomodoroTransitionWithReceipt': 7,
        // BEGIN DEFERRED and ROLLBACK around a read.
        'NativeReceiptSqliteAdapter.readDurableReceipt': 3,
        // Inside saveTask/saveData's transaction (noteWrite).
        'NativeReceiptSqliteAdapter.beforeCommit': 3,
        // noteWrite.
        'NativeReceiptSqliteAdapter.commitReceiptOnlyNow': 4,
    },
};

const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$|\.replay\.ts$|\.test-[\w-]+\.ts$/.test(entry.name) ? [path] : [];
});

const writeSites = (text: string): Record<string, number> => {
    const lines = text.split('\n');
    const starts = [0];
    for (const line of lines) starts.push(starts[starts.length - 1] + line.length + 1);
    const sites: Record<string, number> = {};
    for (const match of text.matchAll(WRITE)) {
        const at = starts.findIndex((start) => start > (match.index ?? 0)) - 1;
        let owner = '?', top = '';
        for (let index = at; index >= 0; index -= 1) {
            const method = METHOD.exec(lines[index]);
            if (method && owner === '?' && !NOT_METHODS.has(method[1])) owner = method[1];
            const declared = TOP.exec(lines[index]);
            if (declared) { top = declared[1]; break; }
        }
        const key = `${top}.${owner}`;
        sites[key] = (sites[key] ?? 0) + 1;
    }
    return sites;
};

describe('same-connection SQL writes', () => {
    it('are only the listed ones in core and the native Android bundle', () => {
        const found: Record<string, Record<string, number>> = {};
        for (const file of [...sources(srcDir), ...sources(bundleDir)]) {
            const sites = writeSites(readFileSync(file, 'utf8'));
            if (Object.keys(sites).length) found[relative(repoRoot, file).split('\\').join('/')] = sites;
        }
        expect(found).toEqual(ALLOWED);
    });

    it("the bundle hands its raw client to core's receipt SQL only inside a write hold", () => {
        const entry = readFileSync(join(bundleDir, 'host-entry.ts'), 'utf8');
        const uses = entry.split('\n').filter((line) => /\(sqlite[,)]/.test(line)).map((line) => line.trim());
        expect(uses).toHaveLength(6);
        for (const line of uses) {
            expect(line).toMatch(/new ValidatedSqliteAdapter\(sqlite,|withConnection\(\(\) => sqliteHasAnyData\(sqlite\)\)|withConnection\(\(\) => loadNativeRequestReceipts\(sqlite[,)].*\{ write: true \}\)|withHostConnection\(\(\) => pruneNativeRequestReceipts\(sqlite[,)]/);
        }
    });
});
