import { formatRecoverySnapshotLabel } from './recovery-snapshot-names';
import { strToU8, zipSync } from 'fflate';
import { bytesToBase64 } from './base64-bytes';
import { createImportDiagnostics, formatImportDiagnostic } from './import-diagnostics';
import { createHash } from 'node:crypto';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_BACKUP_SOURCE_BYTES, serializeBackupData, validateBackupJson } from './backup-transfer';
import { runSerializedSyncDocumentOperation, runSerializedSyncDocumentWriteOperation } from './data-transfer-transaction';
import { createMockArea, createMockProject, createMockSection } from './sync-test-utils';
import { formatI18nTemplate, getTranslator } from './i18n';
import { consoleLogger, setLogger, type LogPayload } from './logger';
import { applyImportSource, parseImportSource } from './import-runner';
import {
    buildNativeBackupDocumentFailure, buildNativeBackupDocumentResult, buildNativeBackupNoUndoConfirmation, buildNativeBackupSnapshotRestoreConfirmation, commitNativeBackupDocument,
    inspectNativeBackupDocument, nativeBackupDocumentWarningsHeld, prepareNativeBackupDocument, readNativeBackupDocumentOutcome,
    type NativeBackupDocumentPrepareInput, type NativeBackupOperationReference,
} from './native-backup-document';
import { loadNativeRequestReceipts, NativeReceiptSqliteAdapter, resetNativeRequestReceipts } from './native-request-receipts';
import { openScratchSqlite } from './screen-parity.replay';
import { SqliteAdapter, type SqliteClient } from './sqlite-adapter';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Task } from './types';

const AT = '2026-10-04T12:00:00.000Z';
const ID = '11111111-1111-4111-8111-111111111111';
const NAME = 'data.2026-10-04T12-00-00.000.snapshot.json';
const metadata = { fileName: 'owned.json', lastModified: Date.parse(AT), appVersion: '1.3.4' };
const reference: NativeBackupOperationReference = { id: ID, sha256: 'a'.repeat(64), byteCount: 420 };
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
/** An import's warnings as its reply stores them: `<code>:<count>`, never the file's words (D1b review P2). */
const stored = (warnings: readonly string[]) => createImportDiagnostics(warnings, 'warning')
    .map((diagnostic) => `${diagnostic.code}:${typeof diagnostic.params.count === 'number' ? diagnostic.params.count : 1}`);
const small = (reply: unknown) => { const json = JSON.stringify(reply); expect(json.length).toBeLessThan(4096); expect(json).not.toContain('AAAA'); };
const task = (id: string, extra: Partial<Task> = {}): Task => ({ id, title: id, status: 'next', contexts: [], tags: [],
    createdAt: AT, updatedAt: AT, rev: 1, ...extra });
const original: AppData = { tasks: [task('visible'), task('history', { status: 'done', completedAt: AT }),
    task('hidden', { status: 'archived' })], projects: [], sections: [], areas: [], people: [], settings: { language: 'en' } };
const incoming: AppData = { ...clone(original), tasks: [task('visible', { title: '日本語 🦉', rev: 2 }), task('new')], settings: { language: 'de' } };
const input = (text = serializeBackupData(incoming), operation: 'merge' | 'restore' | 'replace' = 'merge'): NativeBackupDocumentPrepareInput =>
    ({ requestId: ID, mode: operation, snapshotName: NAME, text, metadata: clone(metadata) });
const t = (key: string, params?: Record<string, number | string>) => formatI18nTemplate(getTranslator('en')(key), params ?? {});
const resources: { close: () => void; directory: string }[] = [];
const temporaryRoot = fileURLToPath(new URL('../../../.orchestrator/tmp/', import.meta.url));
async function open(data = original) {
    mkdirSync(temporaryRoot, { recursive: true });
    const directory = mkdtempSync(join(temporaryRoot, 'backup-document-'));
    const sql = openScratchSqlite(join(directory, 'document.sqlite'));
    resources.push({ close: sql.close, directory });
    await new SqliteAdapter(sql.client).saveData(clone(data));
    resetNativeRequestReceipts();
    await loadNativeRequestReceipts(sql.client, { durableCommands: ['backupDocument'] });
    const writes: string[] = [];
    const hooks: { run?: (statement: string) => Promise<void> } = {};
    const client: SqliteClient = { ...sql.client, run: async (statement, params) => {
        writes.push(statement); await hooks.run?.(statement); await sql.client.run(statement, params);
    } };
    const adapter = new NativeReceiptSqliteAdapter(client, { rejectConcurrentWrites: true });
    setStorageAdapter(adapter);
    useTaskStore.setState({ persistenceFailure: null, isLoading: false, editLockCount: 0, error: null,
        tasks: [], projects: [], sections: [], areas: [], people: [], settings: {},
        _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        _tasksById: new Map(), _projectsById: new Map(), _sectionsById: new Map(), _areasById: new Map(), _peopleById: new Map(),
        lastDataChangeAt: 0 });
    await useTaskStore.getState().fetchData({ throwOnError: true, recoveryLoad: true });
    writes.length = 0;
    const state = async () => ({ tasks: await sql.client.all('SELECT * FROM tasks ORDER BY id'),
        settings: await sql.client.all('SELECT * FROM settings'), receipts: await sql.client.all('SELECT * FROM native_request_receipts') });
    return { sql, adapter, client, writes, hooks, state };
}
afterEach(() => {
    vi.restoreAllMocks(); resetForTests(); resetNativeRequestReceipts();
    useTaskStore.setState({ persistenceFailure: null, error: null });
    for (const resource of resources.splice(0).reverse()) { resource.close(); rmSync(resource.directory, { recursive: true, force: true }); }
});

describe('native immutable backup inspection and models', () => {
    it('previews owned bytes with RN counts, effect and warnings; cancellation writes nothing', async () => {
        const env = await open(); const before = await env.state();
        const preview = inspectNativeBackupDocument(input().text, metadata, t);
        expect(preview.valid).toBe(true); expect(preview.title).toBe(t('settings.mergeBackup'));
        expect(preview.summary).toContain(t('settings.backupMobile.backupPreviewCounts', { taskCount: 2, projectCount: 0 }));
        expect(preview.summary).toContain(t('settings.mergeBackupConfirm'));
        expect(env.writes).toEqual([]); expect(await env.state()).toEqual(before);
    });
    it.each(['{private-content', 'null', '{"tasks":"private-content"}'])('returns localized invalid input without raw content: %s', (text) => {
        const preview = inspectNativeBackupDocument(text, metadata, t);
        expect(preview.valid).toBe(false); expect(preview.errorMessage).toBeTruthy();
        expect(JSON.stringify(preview)).not.toContain('private-content');
    });
    it('uses structured version warnings', () => {
        const source = JSON.stringify({ data: incoming, backupMetadata: { createdAt: AT, version: '99.0.0' } });
        const parsed = parseImportSource('backup', { text: source, ...metadata });
        expect(parsed.diagnostics.some((item) => item.severity === 'warning')).toBe(true);
        expect(inspectNativeBackupDocument(source, metadata, t).summary).toContain(t('settings.backupDiagnostics.newerVersion', { version: '99.0.0' }));
    });
    it('enforces actual UTF-8 bytes including multibyte and surrogate pairs', () => {
        const ascii = ' '.repeat(MAX_BACKUP_SOURCE_BYTES - 2) + '{}';
        // At the exact cap parsing reaches ordinary JSON diagnostics, rather than size refusal.
        expect(inspectNativeBackupDocument(ascii, metadata, t).errorMessage).not.toBe(t('settings.backupDiagnostics.tooLarge', { maxSizeMb: 128 }));
        expect(inspectNativeBackupDocument('🦉'.repeat(MAX_BACKUP_SOURCE_BYTES / 4 + 1), metadata, t).errorMessage)
            .toBe(t('settings.backupDiagnostics.tooLarge', { maxSizeMb: 128 }));
    }, 30_000);
    it('uses RN success and Undo words with the exact accepted snapshot', () => {
        const reply = { version: 1 as const, operation: 'merge' as const, snapshotName: NAME, added: 2, updated: 3 };
        expect(buildNativeBackupDocumentResult(reply, t)).toEqual({ title: t('settings.mergeBackup'),
            message: `${t('settings.mergeBackupSummary', { addedCount: 2, updatedCount: 3 })}\n${t('settings.backupMobile.recoverySnapshotSaved', { snapshotName: NAME })}`,
            undoLabel: t('settings.undoImport'), doneLabel: t('common.done'), durationMs: 5600 });
        const confirmation = buildNativeBackupSnapshotRestoreConfirmation(NAME, t);
        expect(confirmation.title).toBe(t('settings.undoImportConfirmTitle'));
        expect(confirmation.message).toContain('Anything you changed since is rolled back too');
        expect(buildNativeBackupDocumentResult({ ...reply, operation: 'restore', added: 0, updated: 0 }, t).message)
            .toBe(t('settings.backupMobile.recoverySnapshotRestored'));
    });
    it('asks RN\'s Recovery snapshots row question for a plain restore, with the same label', () => {
        const undo = buildNativeBackupSnapshotRestoreConfirmation(NAME, t);
        const restore = buildNativeBackupSnapshotRestoreConfirmation(NAME, t, false);
        const label = formatRecoverySnapshotLabel(NAME);
        expect(restore).toEqual({ title: t('settings.backupMobile.restoreRecoverySnapshot'),
            message: t('settings.backupMobile.restoreSnapshotReplaceLocalData', { snapshotName: label }),
            confirmLabel: t('markdown.referenceRestore'), cancelLabel: t('common.cancel') });
        expect(undo.message).toBe(t('settings.undoImportConfirm', { snapshotName: label }));
        expect(() => buildNativeBackupSnapshotRestoreConfirmation('data.bad.snapshot.json', t, false)).toThrow('INVALID_INPUT');
    });
});

describe('native frozen backup plan over actual SQLite', () => {
    it('prepares from latest durable edits and preserves complete history without writing', async () => {
        const env = await open(); const current = await env.adapter.getData();
        current.tasks.push(task('before-confirmation')); await env.adapter.saveData(current); env.writes.length = 0;
        const source = input(); const before = await env.state();
        const prepared = await prepareNativeBackupDocument(env.adapter, source); const plan = JSON.parse(prepared.planJSON);
        expect(plan.expectedCurrent.tasks.map((item: Task) => item.id)).toContain('before-confirmation');
        expect(plan.data.tasks.map((item: Task) => item.id)).toEqual(expect.arrayContaining(['history', 'hidden', 'before-confirmation', 'new']));
        expect(plan.reply).toEqual({ version: 1, operation: 'merge', snapshotName: NAME, added: 1, updated: 1 });
        expect(validateBackupJson(prepared.recoveryJSON!, metadata).valid).toBe(true);
        expect(JSON.parse(prepared.recoveryJSON!).tasks).toHaveLength(4);
        expect(JSON.parse(prepared.recoveryJSON!).tasks.find((item: Task) => item.id === 'visible').title).toBe('visible');
        expect(source).toEqual(input()); expect(env.writes).toEqual([]); expect(await env.state()).toEqual(before);
    });
    it('accepts a large-note source and external plan beyond the old bounded journal capacity', async () => {
        const base = clone(original); base.tasks[0].description = 'local 日本語 🦉'.repeat(400_000);
        const backup = clone(incoming); backup.tasks[0].description = 'incoming 日本語 🦉'.repeat(400_000);
        const env = await open(base); const source = input(serializeBackupData(backup));
        expect(Buffer.byteLength(source.text, 'utf8')).toBeGreaterThan(2 * 1024 * 1024);
        const prepared = await prepareNativeBackupDocument(env.adapter, source);
        expect(Buffer.byteLength(prepared.planJSON, 'utf8')).toBeGreaterThan(12 * 1024 * 1024);
        await commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME);
        expect((await env.adapter.getData()).tasks.find((item) => item.id === 'visible')?.description).toBe(backup.tasks[0].description);
    }, 30_000);
    it('uses shared additive entity/attachment tombstone policy and persists the actual prepared effect', async () => {
        const base = clone(original);
        base.tasks.push(task('deleted', { deletedAt: AT }));
        base.tasks[0].attachments = [{ id: 'removed', kind: 'file', title: 'removed', uri: '', createdAt: AT, updatedAt: AT, deletedAt: AT }];
        const backup = clone(incoming);
        backup.tasks.push(task('deleted', { rev: 8 }), task('incoming-deleted', { deletedAt: AT }));
        backup.tasks[0].attachments = [{ id: 'removed', kind: 'file', title: 'removed', uri: '', createdAt: AT, updatedAt: AT },
            { id: 'incoming-removed', kind: 'file', title: 'removed', uri: '', createdAt: AT, updatedAt: AT, deletedAt: AT }];
        const env = await open(base); const prepared = await prepareNativeBackupDocument(env.adapter, input(serializeBackupData(backup)));
        await commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME);
        const durable = await env.adapter.getData();
        expect(durable.tasks.find((item) => item.id === 'deleted')?.deletedAt).toBe(AT);
        expect(durable.tasks.some((item) => item.id === 'incoming-deleted')).toBe(false);
        expect(durable.tasks.find((item) => item.id === 'visible')?.attachments?.filter((item) => !item.deletedAt)).toEqual([]);
        expect(durable.tasks.find((item) => item.id === 'history')?.completedAt).toBe(AT);
    });
    it.each(['merge', 'replace'] as const)('refuses stale preparation after an intervening durable edit with no writes (%s)', async (operation) => {
        const env = await open(); const prepared = await prepareNativeBackupDocument(env.adapter, input(undefined, operation));
        const later = await env.adapter.getData(); later.tasks[0] = { ...later.tasks[0], title: 'later', rev: 3 };
        await env.adapter.saveData(later); const before = await env.state(); env.writes.length = 0;
        await expect(commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME)).rejects.toThrow('STALE_REVISION:');
        expect(env.writes).toEqual([]); expect(await env.state()).toEqual(before);
    });
    it.each(['merge', 'replace'] as const)('cold-replays the first reply preserving intervening durable edits with zero document writes (%s)', async (operation) => {
        const env = await open(); const prepared = await prepareNativeBackupDocument(env.adapter, input(undefined, operation));
        const first = await commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME);
        const later = await env.adapter.getData(); later.tasks[0] = { ...later.tasks[0], title: 'later', rev: 9 }; await env.adapter.saveData(later);
        const before = await env.state(); resetNativeRequestReceipts();
        await loadNativeRequestReceipts(env.sql.client, { durableCommands: ['backupDocument'] });
        const cold = new NativeReceiptSqliteAdapter(env.client, { rejectConcurrentWrites: true });
        await cold.ensureSchema(); // Native boot establishes schema before journal replay.
        setStorageAdapter(cold); env.writes.length = 0;
        expect(await commitNativeBackupDocument(cold, reference, prepared.planJSON, NAME)).toEqual(first);
        expect(env.writes).toEqual([]); expect(await env.state()).toEqual(before);
        expect(useTaskStore.getState()._allTasks.find((item) => item.id === later.tasks[0].id)?.title).toBe('later');
    });
    it.each(['merge', 'replace'] as const)('rolls back failed COMMIT and never invents terminal proof (%s)', async (operation) => {
        const env = await open(); const prepared = await prepareNativeBackupDocument(env.adapter, input(undefined, operation)); const before = await env.state();
        env.hooks.run = async (statement) => { if (statement === 'COMMIT') throw new Error('private SQL failure'); };
        await expect(commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME)).rejects.toThrow('SAVE_FAILED:');
        expect(await env.state()).toEqual(before);
        expect(await readNativeBackupDocumentOutcome(env.adapter, reference, prepared.planJSON, NAME)).toBeNull();
    });
    it('receipts a no-op plan and returns the same terminal reply without a second write', async () => {
        const env = await open(); const current = await env.adapter.getData();
        const prepared = await prepareNativeBackupDocument(env.adapter, input(serializeBackupData(current)));
        const plan = JSON.parse(prepared.planJSON);
        // Exercise a frozen exact no-op independently of merge's tie-resolution counts.
        plan.data = clone(plan.expectedCurrent); plan.reply.added = 0; plan.reply.updated = 0;
        const noOpPlan = JSON.stringify(plan);
        const before = await env.adapter.getData();
        const first = await commitNativeBackupDocument(env.adapter, reference, noOpPlan, NAME);
        expect(await env.adapter.getData()).toEqual(before);
        expect(await env.sql.client.all('SELECT request_id FROM native_request_receipts')).toEqual([{ request_id: ID }]);
        env.writes.length = 0;
        expect(await commitNativeBackupDocument(env.adapter, reference, noOpPlan, NAME)).toEqual(first);
        expect(env.writes).toEqual([]);
    });
    it.each(['merge', 'replace'] as const)('retains provable receipt after refresh failure and exact replay only reloads (%s)', async (operation) => {
        const env = await open(); const prepared = await prepareNativeBackupDocument(env.adapter, input(undefined, operation));
        const fetchData = useTaskStore.getState().fetchData;
        useTaskStore.setState({ fetchData: async () => { throw new Error('private refresh failure'); } });
        await expect(commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME)).rejects.toThrow('SAVE_FAILED: Backup document was saved but reload failed');
        const committed = await env.state(); env.writes.length = 0;
        expect(await readNativeBackupDocumentOutcome(env.adapter, reference, prepared.planJSON, NAME)).toEqual(JSON.parse(prepared.planJSON).reply);
        expect(env.writes).toEqual([]);
        useTaskStore.setState({ fetchData });
        await commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME);
        expect(await env.state()).toEqual(committed); expect(env.writes).toEqual([]);
    });
    it('terminal outcome reads no store/domain data, never flushes or refreshes, and returns null on missing proof', async () => {
        const env = await open(); const prepared = await prepareNativeBackupDocument(env.adapter, input());
        const read = vi.spyOn(env.adapter, 'getData'); const save = vi.spyOn(env.adapter, 'saveDocumentWithReceipt');
        const refresh = vi.fn(async () => { throw new Error('must not refresh'); });
        const previous = useTaskStore.getState().fetchData; useTaskStore.setState({ fetchData: refresh, persistenceFailure: { message: 'owed' } as never });
        expect(await readNativeBackupDocumentOutcome(env.adapter, reference, prepared.planJSON, NAME)).toBeNull();
        expect(read).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
        useTaskStore.setState({ fetchData: previous, persistenceFailure: null });
    });
    it('Undo uses RN restore policy above newer revisions and tombstones later local-only IDs without making another recovery', async () => {
        const env = await open(); const merged = await prepareNativeBackupDocument(env.adapter, input());
        await commitNativeBackupDocument(env.adapter, reference, merged.planJSON, NAME);
        const later = await env.adapter.getData(); later.tasks.push(task('after-merge', { rev: 20 }));
        later.tasks[0] = { ...later.tasks[0], title: 'later', rev: 30 }; await env.adapter.saveData(later);
        const restoreInput = { ...input(merged.recoveryJSON!, 'restore'), requestId: '22222222-2222-4222-8222-222222222222' };
        const restored = await prepareNativeBackupDocument(env.adapter, restoreInput);
        expect(restored.recoveryJSON).toBeNull();
        const plan = JSON.parse(restored.planJSON);
        const expected = applyImportSource('backup', plan.expectedCurrent, parseImportSource('backup', { text: merged.recoveryJSON!, ...metadata }).data!).data;
        // Restore revisions/timestamps are clock-derived; compare at a fixed clock below through final assertions.
        expect(plan.data.tasks.find((item: Task) => item.id === 'after-merge').deletedAt).toBeTruthy();
        expect(plan.data.tasks.find((item: Task) => item.id === later.tasks[0].id).rev).toBeGreaterThan(30);
        expect(plan.data.tasks.find((item: Task) => item.id === 'visible').title).toBe(expected.tasks.find((item) => item.id === 'visible')?.title);
        await commitNativeBackupDocument(env.adapter, { ...reference, id: restoreInput.requestId, sha256: 'b'.repeat(64) }, restored.planJSON, NAME);
        const durable = await env.adapter.getData();
        expect(durable.tasks.find((item) => item.id === 'after-merge')?.deletedAt).toBeTruthy();
        expect(durable.tasks.find((item) => item.id === 'visible')?.title).toBe('visible');
        expect(durable.settings.language).toBe('en');
    });
    it.each(['extra', 'requestId', 'preparedAt', 'data', 'counts', 'snapshot'] as const)('rejects invalid frozen %s before adapter operations', async (fault) => {
        const env = await open(); const prepared = await prepareNativeBackupDocument(env.adapter, input()); const plan = JSON.parse(prepared.planJSON);
        if (fault === 'extra') plan.extra = true;
        if (fault === 'requestId') plan.requestId = '22222222-2222-4222-8222-222222222222';
        if (fault === 'preparedAt') plan.preparedAt = '2026-10-04';
        if (fault === 'data') plan.data.tasks = [null];
        if (fault === 'counts') plan.reply.added = -1;
        if (fault === 'snapshot') plan.reply.snapshotName = '../private';
        const save = vi.spyOn(env.adapter, 'saveDocumentWithReceipt'); env.writes.length = 0;
        await expect(commitNativeBackupDocument(env.adapter, reference, JSON.stringify(plan), NAME)).rejects.toThrow('INVALID_INPUT:');
        expect(save).not.toHaveBeenCalled(); expect(env.writes).toEqual([]);
    });
    it.each(['sha', 'bytes', 'uuid', 'extra'] as const)('rejects invalid manifest %s before writing', async (fault) => {
        const env = await open(); const prepared = await prepareNativeBackupDocument(env.adapter, input()); const ref = { ...reference };
        if (fault === 'sha') ref.sha256 = 'A'.repeat(64);
        if (fault === 'bytes') ref.byteCount = 8193;
        if (fault === 'uuid') ref.id = ID.toUpperCase().replace('11111111', 'AAAAAAAA');
        if (fault === 'extra') Object.assign(ref, { private: 'private' });
        await expect(commitNativeBackupDocument(env.adapter, ref, prepared.planJSON, NAME)).rejects.toThrow('INVALID_INPUT:');
        expect(env.writes).toEqual([]);
    });
    it.each(['plan', 'reference', 'reply', 'malformed'] as const)('refuses changed durable %s identity/reply without rewriting', async (fault) => {
        const env = await open(); const prepared = await prepareNativeBackupDocument(env.adapter, input());
        await commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME); env.writes.length = 0;
        const plan = JSON.parse(prepared.planJSON); const ref = { ...reference };
        if (fault === 'plan') plan.reply.added += 1;
        if (fault === 'reference') ref.sha256 = 'b'.repeat(64);
        if (fault === 'reply') await env.sql.client.run('UPDATE native_request_receipts SET reply=?', [JSON.stringify({ ...plan.reply, updated: 99 })]);
        if (fault === 'malformed') await env.sql.client.run('UPDATE native_request_receipts SET reply=?', ['{private']);
        await expect(commitNativeBackupDocument(env.adapter, ref, JSON.stringify(plan), NAME)).rejects.toThrow('SAVE_FAILED:');
        await expect(readNativeBackupDocumentOutcome(env.adapter, ref, JSON.stringify(plan), NAME)).rejects.toThrow('SAVE_FAILED:');
        expect(env.writes).toEqual([]);
    });
    it('captures mutable call inputs before waiting in the serialized queue', async () => {
        const env = await open(); const prepared = await prepareNativeBackupDocument(env.adapter, input());
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        const blocker = runSerializedSyncDocumentWriteOperation(() => held);
        const ref = { ...reference }; const operation = commitNativeBackupDocument(env.adapter, ref, prepared.planJSON, NAME);
        ref.sha256 = 'b'.repeat(64); ref.id = '22222222-2222-4222-8222-222222222222'; release(); await blocker;
        await operation;
        expect(await readNativeBackupDocumentOutcome(env.adapter, reference, prepared.planJSON, NAME)).not.toBeNull();
    });
    it('rejects invalid prepare or owed persistence with no document writes', async () => {
        const env = await open();
        await expect(prepareNativeBackupDocument(env.adapter, { ...input(), snapshotName: '../private' })).rejects.toThrow('INVALID_INPUT:');
        useTaskStore.setState({ persistenceFailure: { message: 'private' } as never });
        await expect(prepareNativeBackupDocument(env.adapter, input())).rejects.toThrow('SAVE_FAILED:');
        expect(env.writes).toEqual([]);
    });
});

const csvFile = (headers: string[], rows: string[][]) => [headers, ...rows].map((row) => row.map((cell) => `"${cell.replace(/"/gu, '""')}"`).join(',')).join('\n');
const csvInput = (text = 'Title,Project,Section,Area,Checklist,ID\n日本語 🦉,Launch,Now,Work,[x] First|[ ] Next,csv-task'): NativeBackupDocumentPrepareInput =>
    ({ ...input(), mode: 'csv', text: bytesToBase64(strToU8(text)), metadata: { ...metadata, fileName: 'owned.csv' } });

describe('native backup commit replayed after process death (pass D1a, gate G-B1)', () => {
    // A task scheduled to start yesterday (still in Inbox) and no tombstone cleanup yet: a normal load promotes the task and bumps
    // the cleanup stamp, and saves both. Dates are relative to now, so the fixture never ages out.
    const due = (): AppData => ({ ...clone(original), tasks: [...clone(original).tasks,
        task('scheduled', { status: 'inbox', startTime: new Date(Date.now() - 86_400_000).toISOString() })] });
    const restart = async (adapter: NativeReceiptSqliteAdapter, recoveryLoad: boolean) => {
        resetForTests();
        setStorageAdapter(adapter);
        await useTaskStore.getState().fetchData({ throwOnError: true, ...(recoveryLoad ? { recoveryLoad: true } : {}) });
        await flushPendingSave();
    };

    it('crashes before the SQL commit with a due scheduled task: the recovery boot replays it onto the document it was prepared against', async () => {
        const env = await open(due());
        const prepared = await prepareNativeBackupDocument(env.adapter, input());
        await restart(env.adapter, true);
        expect(await commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME)).toMatchObject({ operation: 'merge', snapshotName: NAME });
        expect((await env.adapter.getData()).tasks.find((item) => item.id === 'new')).toBeDefined();
    });

    it('without the recovery boot the same replay is refused as stale: a normal load\'s maintenance changed the document first', async () => {
        const env = await open(due());
        const prepared = await prepareNativeBackupDocument(env.adapter, input());
        await restart(env.adapter, false);
        expect((await env.adapter.getData()).tasks.find((item) => item.id === 'scheduled')?.status).toBe('next');
        await expect(commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME)).rejects.toThrow('STALE_REVISION:');
    });
});

describe('an import whose Undo could not be admitted is refused before COMMIT (D1b review P1)', () => {
    const MIB = 1024 * 1024;
    const pageBytes = async (client: SqliteClient) => {
        const [count] = await client.all<{ page_count: number }>('PRAGMA page_count');
        const [size] = await client.all<{ page_size: number }>('PRAGMA page_size');
        return count.page_count * size.page_size;
    };

    it('refuses at prepare when the source and the library together pass the limit, before parsing anything', async () => {
        const env = await open(); const read = vi.spyOn(env.adapter, 'getData');
        await expect(prepareNativeBackupDocument(env.adapter, { ...csvInput(), admission: { sourceBytes: 10, maxTransferBytes: 4096 } })).rejects.toThrow('TOO_LARGE:');
        expect(read).not.toHaveBeenCalled(); expect(env.writes).toEqual([]);
        await expect(prepareNativeBackupDocument(env.adapter, { ...csvInput(), admission: { sourceBytes: 10, maxTransferBytes: 12 * MIB } })).resolves.toMatchObject({ planJSON: expect.any(String) });
    });

    it('admits again inside the document lane: a write queued before it that grows the library past the limit is refused (D1c change 1)', async () => {
        const env = await open();
        const grown: AppData = { ...clone(original), tasks: [...clone(original).tasks,
            ...Array.from({ length: 200 }, (_, index) => task(`grown-${index}`, { description: 'g'.repeat(2048) }))] };
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        // A writer that entered the lane first, and grows the library only after the early check has run.
        const queued = runSerializedSyncDocumentWriteOperation(async () => { await gate; await env.adapter.saveData(grown); });
        // A snapshot restore makes no recovery snapshot, so no Undo bound stands in for the lane's own check.
        const source = input(serializeBackupData(incoming), 'restore');
        const sourceBytes = strToU8(source.text).length;
        const maxTransferBytes = await env.adapter.libraryBytes() + sourceBytes + 64 * 1024;
        const prepared = prepareNativeBackupDocument(env.adapter, { ...source, admission: { sourceBytes, maxTransferBytes } });
        prepared.catch(() => undefined);
        release(); await queued;
        expect(await env.adapter.libraryBytes() + sourceBytes).toBeGreaterThan(maxTransferBytes);
        await expect(prepared).rejects.toThrow('TOO_LARGE:');
    });

    it('a snapshot restore freezes the limit as its result library\'s bound: a restore whose library would pass it is refused, data and receipt rolled back (D1c change 1)', async () => {
        // SQLite keeps rows plus their full-text index, so a restored library can take more pages than its JSON's bytes.
        const snapshotData: AppData = { ...clone(original), tasks: Array.from({ length: 300 }, (_, index) =>
            task(`snapshot-${index}`, { title: `alpha beta gamma ${index}`, description: Array.from({ length: 120 }, (_, word) => `w${index}x${word}`).join(' ') })) };
        const text = serializeBackupData(snapshotData);
        const sourceBytes = strToU8(text).length;
        const env = await open();
        const maxTransferBytes = sourceBytes + await env.adapter.libraryBytes();
        const prepared = await prepareNativeBackupDocument(env.adapter, { ...input(text, 'restore'), admission: { sourceBytes, maxTransferBytes } });
        expect(prepared.recoveryJSON).toBeNull();
        expect(JSON.parse(prepared.planJSON).maxLibraryBytes).toBe(maxTransferBytes);
        const before = await env.state();
        await expect(commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME)).rejects.toThrow('TOO_LARGE:');
        expect(await env.state()).toEqual(before);
        // The same restore under a roomy limit lands.
        const roomy = await open();
        const fits = await prepareNativeBackupDocument(roomy.adapter, { ...input(text, 'restore'), admission: { sourceBytes, maxTransferBytes: 512 * MIB } });
        await expect(commitNativeBackupDocument(roomy.adapter, reference, fits.planJSON, NAME)).resolves.toMatchObject({ operation: 'restore' });
        expect(await roomy.adapter.libraryBytes()).toBeGreaterThan(maxTransferBytes);
    });

    it('runs the 60 000-row CSV whose library would pass 12 MiB without Undo, as RN runs it (large-library pass b)', async () => {
        const rows = Array.from({ length: 60_000 }, (_, index) => `Task ${index}`);
        const text = `Title\n${rows.join('\n')}\n`;
        expect(text.length).toBeLessThan(MIB);
        const source = { ...csvInput(text), admission: { sourceBytes: text.length, maxTransferBytes: 12 * MIB } };
        const env = await open(); const prepared = await prepareNativeBackupDocument(env.adapter, source);
        // Prepare's estimate sees the library outgrow the limit: the app asks first. The commit decides from the real bytes.
        expect(prepared).toMatchObject({ undo: false });
        expect(prepared.recoveryJSON).toEqual(expect.any(String));
        const plan = JSON.parse(prepared.planJSON);
        expect(plan.reply).not.toHaveProperty('undo');
        expect(plan).not.toHaveProperty('maxLibraryBytes');
        expect(plan.undoLibraryBytes).toBe(12 * MIB - strToU8(prepared.recoveryJSON!).length);
        const reply = await commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME);
        expect(reply).toMatchObject({ operation: 'csv', undo: false });
        expect((await env.state()).tasks).toHaveLength(original.tasks.length + 60_000);
        expect(await env.adapter.libraryBytes()).toBeGreaterThan(12 * MIB - strToU8(prepared.recoveryJSON!).length);
        // The result says so plainly and offers no Undo; a replay answers the same.
        const model = buildNativeBackupDocumentResult(reply, t);
        expect(model.undoLabel).toBe('');
        expect(model.message).toContain(t('settings.backupMobile.undoUnavailableResult'));
        expect(await readNativeBackupDocumentOutcome(env.adapter, reference, prepared.planJSON, NAME)).toMatchObject({ undo: false });
        // Under a roomy limit the same import keeps its Undo.
        const roomy = await open(); const fits = await prepareNativeBackupDocument(roomy.adapter, { ...source, admission: { sourceBytes: text.length, maxTransferBytes: 512 * MIB } });
        expect(fits).toMatchObject({ undo: true });
        expect(JSON.parse(fits.planJSON).undoLibraryBytes).toBe(512 * MIB - strToU8(fits.recoveryJSON!).length);
        const kept = await commitNativeBackupDocument(roomy.adapter, reference, fits.planJSON, NAME);
        expect(kept).not.toHaveProperty('undo');
        expect(buildNativeBackupDocumentResult(kept, t).undoLabel).toBe(t('settings.undoImport'));
    }, 120_000);

    it('keeps Undo for L1\'s restore, which the admission before pass b kept: 3 MiB of emoji rows over 3 MiB at 15 MiB (large-library pass b)', async () => {
        const emoji = (prefix: string): AppData => {
            const row = (index: number) => task(`${prefix}${index} 🦉`, { description: 'aé🦉日本語 '.repeat(40) });
            const per = strToU8(JSON.stringify(row(0), null, 2)).length + 8;
            return { ...clone(original), tasks: Array.from({ length: Math.round(3 * MIB / per) }, (_, index) => row(index)) };
        };
        const env = await open();
        const first = await prepareNativeBackupDocument(env.adapter, input(serializeBackupData(emoji('a')), 'replace'));
        await commitNativeBackupDocument(env.adapter, reference, first.planJSON, NAME);
        const text = serializeBackupData(emoji('b'));
        const second = { id: '22222222-2222-4222-8222-222222222222', sha256: 'b'.repeat(64), byteCount: 420 };
        const prepared = await prepareNativeBackupDocument(env.adapter, { ...input(text, 'replace'), requestId: second.id,
            admission: { sourceBytes: strToU8(text).length, maxTransferBytes: 15 * MIB } });
        expect(prepared).toMatchObject({ undo: true });
        const reply = await commitNativeBackupDocument(env.adapter, second, prepared.planJSON, NAME);
        expect(reply).not.toHaveProperty('undo');
        // The line before pass b: the recovery snapshot and the library left after fit the limit together.
        expect(strToU8(prepared.recoveryJSON!).length + await env.adapter.libraryBytes()).toBeLessThanOrEqual(15 * MIB);
    }, 120_000);

    it('a question asked on the estimate still keeps Undo when the real bytes fit, and a recovery snapshot past the limit alone never has Undo (large-library pass b)', async () => {
        const text = serializeBackupData(incoming);
        const sourceBytes = strToU8(text).length;
        const probe = await prepareNativeBackupDocument((await open()).adapter, { ...input(text, 'merge'), admission: { sourceBytes, maxTransferBytes: 512 * MIB } });
        const recoveryBytes = strToU8(probe.recoveryJSON!).length;
        // The library's pages are not what this checks: the room is set by the recovery snapshot alone.
        const tight = async (maxTransferBytes: number) => {
            const env = await open();
            const pages = vi.spyOn(env.adapter, 'libraryBytes').mockResolvedValue(0);
            const prepared = await prepareNativeBackupDocument(env.adapter, { ...input(text, 'merge'), admission: { sourceBytes, maxTransferBytes } });
            pages.mockRestore();
            return { env, prepared, plan: JSON.parse(prepared.planJSON) };
        };
        // Room of one byte: the estimate asks first; the real bytes (here a roomy bound) keep Undo.
        const asked = await tight(recoveryBytes + 1);
        expect(asked.prepared).toMatchObject({ undo: false });
        expect(asked.plan.undoLibraryBytes).toBe(1);
        expect(asked.plan.reply).not.toHaveProperty('undo');
        const kept = await commitNativeBackupDocument(asked.env.adapter, reference, JSON.stringify({ ...asked.plan, undoLibraryBytes: 512 * MIB }), NAME);
        expect(kept).not.toHaveProperty('undo');
        expect(buildNativeBackupDocumentResult(kept, t).undoLabel).toBe(t('settings.undoImport'));
        // The recovery snapshot alone passes the limit: no Undo, decided at prepare, and the commit lands with no bound.
        const over = await tight(recoveryBytes - 1);
        expect(over.prepared).toMatchObject({ undo: false });
        expect(over.plan).not.toHaveProperty('undoLibraryBytes');
        expect(over.plan.reply.undo).toBe(false);
        await expect(commitNativeBackupDocument(over.env.adapter, reference, over.prepared.planJSON, NAME)).resolves.toMatchObject({ undo: false });
    });

    it('a library that ends larger than the estimate still lands, and its result says Undo is not available (large-library pass b)', async () => {
        const env = await open();
        const text = serializeBackupData(incoming);
        const prepared = await prepareNativeBackupDocument(env.adapter, { ...input(text, 'merge'), admission: { sourceBytes: strToU8(text).length, maxTransferBytes: 512 * MIB } });
        expect(prepared).toMatchObject({ undo: true });
        // The estimate said the Undo fits; the saved library is larger than the bound it froze.
        const plan = JSON.parse(prepared.planJSON);
        plan.undoLibraryBytes = 1;
        const planJSON = JSON.stringify(plan);
        const reply = await commitNativeBackupDocument(env.adapter, reference, planJSON, NAME);
        expect(reply).toMatchObject({ operation: 'merge', undo: false });
        expect((await env.state()).tasks.map((item) => item.id)).toEqual(expect.arrayContaining(incoming.tasks.map((item) => item.id)));
        const model = buildNativeBackupDocumentResult(reply, t);
        expect(model.undoLabel).toBe('');
        expect(model.message).toContain(t('settings.backupMobile.undoUnavailableResult'));
        expect(await readNativeBackupDocumentOutcome(env.adapter, reference, planJSON, NAME)).toMatchObject({ undo: false });
    });

    it('an old plan\'s undo bound still refuses, a stored reply never drops a planned undo: false, and only false is a reply\'s undo', async () => {
        const env = await open();
        const text = serializeBackupData(incoming);
        const prepared = await prepareNativeBackupDocument(env.adapter, { ...input(text, 'merge'), admission: { sourceBytes: strToU8(text).length, maxTransferBytes: 512 * MIB } });
        // A plan written before large-library pass b carried maxLibraryBytes for a merge: its replay still rolls back.
        const { undoLibraryBytes: _room, ...legacy } = JSON.parse(prepared.planJSON);
        const before = await env.state();
        await expect(commitNativeBackupDocument(env.adapter, reference, JSON.stringify({ ...legacy, maxLibraryBytes: 1 }), NAME))
            .rejects.toThrow('TOO_LARGE: The imported library would be too large to undo');
        expect(await env.state()).toEqual(before);
        await commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME);
        const planned = JSON.parse(prepared.planJSON);
        await expect(readNativeBackupDocumentOutcome(env.adapter, reference, JSON.stringify({ ...planned, reply: { ...planned.reply, undo: false } }), NAME))
            .rejects.toThrow('SAVE_FAILED:');
        expect(() => buildNativeBackupDocumentResult({ ...planned.reply, undo: true }, t)).toThrow('INVALID_INPUT:');
        expect(() => buildNativeBackupDocumentResult({ version: 1, operation: 'restore', snapshotName: NAME, added: 0, updated: 0, undo: false }, t)).toThrow('INVALID_INPUT:');
    });

    it('the question before an operation without Undo uses its own words', () => {
        expect(buildNativeBackupNoUndoConfirmation(t)).toEqual({ title: t('settings.backupMobile.undoUnavailableTitle'),
            message: t('settings.backupMobile.undoUnavailableConfirm'), confirmLabel: t('settings.backupMobile.undoUnavailableContinue'),
            cancelLabel: t('common.cancel') });
    });

    it('counts the receipt: data that fits and a receipt that crosses the limit are both rolled back', async () => {
        const reply = { blob: 'r'.repeat(40_000) };
        const payload = JSON.stringify(['backupDocument', 'merge', ID, 'a'.repeat(64)]);
        const save = async (env: Awaited<ReturnType<typeof open>>, maxLibraryBytes: number) => {
            const current = await env.adapter.getData();
            return env.adapter.saveDocumentWithReceipt({ requestId: ID, payload, expectedCurrent: current,
                data: { ...clone(current), tasks: [...clone(current).tasks, task('added')] }, reply, maxLibraryBytes });
        };
        // A dry run measures the library inside the open transaction: at the receipt insert, and at COMMIT.
        const dry = await open(); let atInsert = 0; let atCommit = 0;
        dry.hooks.run = async (statement) => {
            if (statement.startsWith('INSERT INTO native_request_receipts')) atInsert = await pageBytes(dry.sql.client);
            if (statement === 'COMMIT') atCommit = await pageBytes(dry.sql.client);
        };
        await save(dry, 512 * MIB);
        expect(atCommit).toBeGreaterThan(atInsert);
        const env = await open(); const before = await env.state();
        await expect(save(env, atInsert)).rejects.toThrow('Document library exceeds the undo limit');
        expect(await env.state()).toEqual(before);
        const exact = await open();
        await expect(save(exact, atCommit)).resolves.toMatchObject({ replayed: false });
        expect(await exact.adapter.libraryBytes()).toBe(atCommit);
    });
});

describe('a restore keeps this device\'s App Lock (D1a review 2, P1)', () => {
    const locked = (): AppData => ({ ...clone(original), settings: { ...clone(original).settings, security: { mobileAppLockEnabled: true } } });
    it.each([
        ['replace', { mobileAppLockEnabled: false }],
        ['replace', undefined],
        ['restore', undefined],
    ] as const)('%s with the backup\'s lock %o: the enabled lock survives the commit and a restart', async (operation, incomingLock) => {
        const env = await open(locked());
        const backup = clone(incoming); backup.settings = { ...backup.settings, ...(incomingLock ? { security: incomingLock } : {}) };
        const prepared = await prepareNativeBackupDocument(env.adapter, input(serializeBackupData(backup), operation));
        expect(JSON.parse(prepared.planJSON).data.settings.security).toEqual({ mobileAppLockEnabled: true });
        await commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME);
        resetForTests(); setStorageAdapter(env.adapter);
        await useTaskStore.getState().fetchData({ throwOnError: true });
        await flushPendingSave();
        expect(useTaskStore.getState().settings.security?.mobileAppLockEnabled).toBe(true);
    });
    it('a device without App Lock does not take it from the backup', async () => {
        const env = await open();
        const backup = clone(incoming); backup.settings = { ...backup.settings, security: { mobileAppLockEnabled: true } };
        const prepared = await prepareNativeBackupDocument(env.adapter, input(serializeBackupData(backup), 'replace'));
        expect(JSON.parse(prepared.planJSON).data.settings.security).toBeUndefined();
    });
});

describe('native backup artifacts never hold a legacy AI key (D1a review P2-5)', () => {
    // An older build saved settings.ai.apiKey in the document; the store strips it on load but the row keeps it until a save.
    const SENTINEL = 'sk-legacy-sentinel-5f2c9e';
    it.each(['merge', 'replace'] as const)('%s: the plan, the recovery snapshot and the reply hold no key; the commit is not stale and drops it', async (operation) => {
        const env = await open();
        await env.sql.client.run("UPDATE settings SET data = json_set(data, '$.ai', json_object('enabled', 1, 'apiKey', ?)) WHERE id = 1", [SENTINEL]);
        expect(JSON.stringify(await env.state())).toContain(SENTINEL);
        const prepared = await prepareNativeBackupDocument(env.adapter, input(undefined, operation));
        expect(prepared.planJSON).not.toContain(SENTINEL);
        expect(prepared.recoveryJSON).not.toContain(SENTINEL);
        const reply = await commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME);
        expect(JSON.stringify(reply)).not.toContain(SENTINEL);
        expect(JSON.stringify(await env.state())).not.toContain(SENTINEL);
    });
    it.each(['merge', 'replace'] as const)('%s: a key inside the picked backup never reaches the plan or the saved settings', async (operation) => {
        const env = await open();
        const backup = clone(incoming); backup.settings = { ...backup.settings, ai: { enabled: true, apiKey: SENTINEL } as AppData['settings']['ai'] };
        const text = JSON.stringify({ ...JSON.parse(serializeBackupData(backup)), settings: backup.settings });
        expect(text).toContain(SENTINEL);
        const prepared = await prepareNativeBackupDocument(env.adapter, input(text, operation));
        expect(prepared.planJSON).not.toContain(SENTINEL);
        expect(prepared.recoveryJSON).not.toContain(SENTINEL);
        await commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME);
        expect(JSON.stringify(await env.state())).not.toContain(SENTINEL);
    });
});

describe('native immutable Mindwtr CSV and ZIP import', () => {
    it('retains safe localized CSV locations through persisted plans, commit and receipt replay', async () => {
        const env = await open();
        const source = csvInput('Title,Due Date,private-header\nprivate-title,private-date,private-cell');
        const preview = inspectNativeBackupDocument(source.text, source.metadata, t, 'csv');
        expect(preview.summary).toContain('row 1, column 3');
        expect(preview.summary).toContain('row 2, column 2');
        const prepared = await prepareNativeBackupDocument(env.adapter, source);
        const plan = JSON.parse(prepared.planJSON);
        expect(plan.reply.result.warnings).toEqual([
            'unknown-columns:1 [csv-locations=0:1:3; omitted=0]',
            'unmapped-date:1 [csv-locations=0:2:2; omitted=0]',
        ]);
        const reply = await commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME);
        resetNativeRequestReceipts();
        await loadNativeRequestReceipts(env.sql.client, { durableCommands: ['backupDocument'] });
        const replay = await readNativeBackupDocumentOutcome(env.adapter, reference, prepared.planJSON, NAME);
        expect(replay).toEqual(reply);
        const model = buildNativeBackupDocumentResult(replay!, t);
        expect(model.message).toContain('1 unknown column(s) were ignored.');
        expect(model.message).toContain('row 1, column 3');
        expect(model.message).toContain('row 2, column 2');
        expect(model.message).not.toContain('needed an adjustment');
        expect(JSON.stringify([plan.reply, reply, replay, model])).not.toContain('private-');
    });

    it.each([
        [1, '1 task was skipped because it was imported earlier and then deleted here; deletions are kept on re-import.'],
        [2, '2 tasks were skipped because they were imported earlier and then deleted here; deletions are kept on re-import.'],
    ] as const)('presents deleted-import warning count %s using existing skipped-record copy', (count, warning) => {
        const model = buildNativeBackupDocumentResult({ version: 1, operation: 'csv', snapshotName: NAME, result: {
            importedAreaCount: 0, importedChecklistItemCount: 0, importedProjectCount: 0, importedSectionCount: 0,
            importedStandaloneTaskCount: 0, importedTaskCount: 0, warnings: [warning],
        } }, t);
        expect(model.message).toContain(t('settings.importDiagnostics.skippedExistingRecords', { count }));
        expect(model.message).not.toContain(t('settings.importDiagnostics.adjustedRecords', { count }));
        expect(model.undoLabel).toBe(t('settings.undoImport'));
    });
    it.each(['csv', 'zip'] as const)('inspects %s bytes using actual RN preview without document writes', async (format) => {
        const env = await open(); const source = csvInput();
        if (format === 'zip') { source.text = bytesToBase64(zipSync({ 'tasks.csv': strToU8('Title,Checklist\n日本語 🦉,[x] First|[ ] Next') })); source.metadata.fileName = 'owned.zip'; }
        const preview = inspectNativeBackupDocument(source.text, source.metadata, t, 'csv');
        expect(preview.valid).toBe(true); expect(Object.keys(preview)).toHaveLength(7);
        expect(preview.title).toBe(t('settings.backupMobile.importMindwtrCsvData'));
        expect(preview.summary).toContain(t('settings.backupMobile.checklistItemsWillBePreserved', { checklistItemCount: 2 }));
        expect(preview.confirmLabel).toBe(t('settings.backupMobile.import')); expect(env.writes).toEqual([]);
    });
    it.each(['csv', 'zip'] as const)('freezes %s RN application/checklist IDs and all result fields before commit, then cold-replays without changing later edits', async (format) => {
        const env = await open(); const source = csvInput();
        if (format === 'zip') { source.text = bytesToBase64(zipSync({ 'tasks.csv': strToU8('Title,Checklist,ID\n日本語 🦉,[x] First|[ ] Next,csv-task') })); source.metadata.fileName = 'owned.zip'; }
        const before = await env.state(); const prepared = await prepareNativeBackupDocument(env.adapter, source);
        const plan = JSON.parse(prepared.planJSON); expect(env.writes).toEqual([]); expect(await env.state()).toEqual(before);
        expect(plan.reply).toMatchObject({ version: 1, operation: 'csv', snapshotName: NAME, result: { importedTaskCount: 1, importedChecklistItemCount: 2 } });
        expect(Object.keys(plan.reply)).toHaveLength(4); expect(Object.keys(plan.reply.result)).toHaveLength(7); expect(plan.reply.result).not.toHaveProperty('data');
        expect(validateBackupJson(prepared.recoveryJSON!).valid).toBe(true);
        const imported = plan.data.tasks.find((item: Task) => item.title === '日本語 🦉');
        const first = await commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME);
        expect((await env.adapter.getData()).tasks.find((item) => item.id === imported.id)?.checklist).toEqual(imported.checklist);
        const later = await env.adapter.getData(); const target = later.tasks.find((item) => item.id === imported.id)!; target.title = 'Later CSV edit'; target.rev! += 1;
        await env.adapter.saveData(later); const committed = await env.state(); resetNativeRequestReceipts();
        await loadNativeRequestReceipts(env.sql.client, { durableCommands: ['backupDocument'] });
        const cold = new NativeReceiptSqliteAdapter(env.client, { rejectConcurrentWrites: true }); await cold.ensureSchema(); setStorageAdapter(cold); env.writes.length = 0;
        expect(await readNativeBackupDocumentOutcome(cold, reference, prepared.planJSON, NAME)).toEqual(first);
        expect(await commitNativeBackupDocument(cold, reference, prepared.planJSON, NAME)).toEqual(first);
        expect(env.writes).toEqual([]); expect(await env.state()).toEqual(committed);
        expect(useTaskStore.getState()._allTasks.find((item) => item.id === imported.id)?.title).toBe('Later CSV edit');
    });
    it('uses latest durable state at confirmation and preserves shared status/date/reference/recurrence policy', async () => {
        const env = await open(); const text = csvFile(['Title','Status','Start Date','Due Date','Review Date','Cancelled At','Recurrence','ID'], [
            ['Reference','reference','2026-10-05','2026-10-06','2026-10-07','','','reference'],
            ['Recurring','next','2026-10-05','2026-10-06','','','FREQ=DAILY','recurring'],
            ['Cancelled','','','','','2026-10-03T10:00:00Z','','cancelled']]);
        const source = csvInput(text); inspectNativeBackupDocument(source.text, source.metadata, t, 'csv');
        const latest = await env.adapter.getData(); latest.tasks.push(task('latest-before-confirm')); await env.adapter.saveData(latest); env.writes.length = 0;
        const prepared = await prepareNativeBackupDocument(env.adapter, source); const plan = JSON.parse(prepared.planJSON);
        expect(plan.expectedCurrent.tasks.some((item: Task) => item.id === 'latest-before-confirm')).toBe(true);
        const ref = plan.data.tasks.find((item: Task) => item.title === 'Reference'); expect(ref.status).toBe('reference'); expect(ref.startTime).toBeUndefined(); expect(ref.dueDate).toBeUndefined(); expect(ref.reviewAt).toBeUndefined();
        expect(plan.data.tasks.find((item: Task) => item.title === 'Recurring')).toMatchObject({ startTime: '2026-10-05', dueDate: '2026-10-06', recurrence: { rule: 'daily' } });
        expect(plan.data.tasks.find((item: Task) => item.title === 'Cancelled')).toMatchObject({ status: 'archived', cancelledAt: '2026-10-03T10:00:00.000Z' });
        expect(env.writes).toEqual([]);
    });
    it('retains every RN warning and localized result counts/checklist/snapshot/Undo', async () => {
        const env = await open(); const source = csvInput('Title,Status,Recurrence,Checklist\nWarning,unknown,every odd Tuesday,[x] Done');
        const parsed = parseImportSource('mindwtr-csv', { bytes: strToU8('Title,Status,Recurrence,Checklist\nWarning,unknown,every odd Tuesday,[x] Done'), fileName: source.metadata.fileName });
        const preview = inspectNativeBackupDocument(source.text, source.metadata, t, 'csv');
        for (const diagnostic of createImportDiagnostics(parsed.preview!.warnings, 'warning')) expect(preview.summary).toContain(formatImportDiagnostic(diagnostic, t));
        const prepared = await prepareNativeBackupDocument(env.adapter, source); const reply = JSON.parse(prepared.planJSON).reply;
        expect(reply.result.warnings).toEqual(stored(parsed.parsedData!.warnings));
        const model = buildNativeBackupDocumentResult(reply, t); expect(model.title).toBe(t('settings.backupMobile.importComplete')); expect(model.undoLabel).toBe(t('settings.undoImport'));
        expect(model.message).toContain(t('settings.backupMobile.checklistItemsPreserved', { checklistItemCount: 1 })); expect(model.message).toContain(NAME);
        for (const diagnostic of createImportDiagnostics(parsed.parsedData!.warnings, 'warning')) expect(model.message).toContain(formatImportDiagnostic(diagnostic, t));
    });
    it.each(['VGl0bGUs\n', 'VGl0bGUs_', 'TR==', 'TWF=', 'TQ=', '====', 'VGl0=bGU'])('rejects noncanonical binary transport %s before any adapter read/write', async (text) => {
        const env = await open(); const read = vi.spyOn(env.adapter, 'getData');
        await expect(prepareNativeBackupDocument(env.adapter, { ...csvInput(), text })).rejects.toThrow('INVALID_INPUT:');
        expect(read).not.toHaveBeenCalled(); expect(env.writes).toEqual([]);
    });
    // Real 16 MiB boundary fixtures need headroom under coverage instrumentation.
    it('bounds decoded bytes before allocating and preserves the shared 8 MiB text limit inside the 16 MiB transport', async () => {
        const env = await open(); const read = vi.spyOn(env.adapter, 'getData');
        const tooLarge = 'A'.repeat(4 * Math.ceil((16 * 1024 * 1024 + 1) / 3));
        await expect(prepareNativeBackupDocument(env.adapter, { ...csvInput(), text: tooLarge })).rejects.toThrow('CSV source exceeds 16 MiB');
        const exactLimit = 'A'.repeat(4 * Math.ceil(16 * 1024 * 1024 / 3) - 2) + '==';
        await expect(prepareNativeBackupDocument(env.adapter, { ...csvInput(), text: exactLimit })).rejects.toThrow('INVALID_INPUT: Invalid backup document input');
        const preview = inspectNativeBackupDocument(exactLimit, csvInput().metadata, t, 'csv'); expect(preview.valid).toBe(false); expect(preview.errorMessage).toBe(formatImportDiagnostic(parseImportSource('mindwtr-csv', { bytes: new Uint8Array(16 * 1024 * 1024), fileName: 'owned.csv' }).diagnostics.find((item) => item.severity === 'error')!, t));
        expect(read).not.toHaveBeenCalled(); expect(env.writes).toEqual([]);
    }, 15_000);
    it('stores a warning that once passed 64 KiB as its code: the reply stays small and the rule\'s text is gone', async () => {
        const env = await open();
        const source = csvInput(csvFile(['Title','Recurrence'], [['Large warning', 'invalid rule ' + '私'.repeat(23_000)]]));
        const reply = JSON.parse((await prepareNativeBackupDocument(env.adapter, source)).planJSON).reply;
        expect(reply.result.warnings).toContain('unsupported-recurrence:1'); expect(JSON.stringify(reply)).not.toContain('私'); expect(env.writes).toEqual([]);
    });
    it.each(['data','negative','fraction','extra','warning','overflow'] as const)('rejects malformed frozen CSV result %s before receipt operations', async (fault) => {
        const env = await open(); const prepared = await prepareNativeBackupDocument(env.adapter, csvInput()); const plan = JSON.parse(prepared.planJSON);
        if (fault === 'data') plan.reply.result.data = plan.data;
        if (fault === 'negative') plan.reply.result.importedTaskCount = -1;
        if (fault === 'fraction') plan.reply.result.importedTaskCount = 0.5;
        if (fault === 'extra') plan.reply.added = 1;
        if (fault === 'warning') plan.reply.result.warnings = [1];
        if (fault === 'overflow') plan.reply.result.warnings = ['私'.repeat(23_000)];
        const save = vi.spyOn(env.adapter, 'saveDocumentWithReceipt'); await expect(commitNativeBackupDocument(env.adapter, reference, JSON.stringify(plan), NAME)).rejects.toThrow('INVALID_INPUT:');
        expect(save).not.toHaveBeenCalled(); expect(env.writes).toEqual([]);
    });
    it('rejects stale CSV frozen data after an intervening edit without receipt or document writes', async () => {
        const env = await open(); const prepared = await prepareNativeBackupDocument(env.adapter, csvInput());
        const later = await env.adapter.getData(); later.tasks[0].title = 'After CSV prepare'; later.tasks[0].rev! += 1; await env.adapter.saveData(later); const before = await env.state(); env.writes.length = 0;
        await expect(commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME)).rejects.toThrow('STALE_REVISION:');
        expect(env.writes).toEqual([]); expect(await env.state()).toEqual(before);
    });
    it('refuses unsupported source format', () => expect(() => inspectNativeBackupDocument('', metadata, t, 'other' as 'csv')).toThrow('INVALID_INPUT:'));
});


describe('an import\'s stored warnings hold codes and counts, never the file\'s words (D1b review P2)', () => {
    const S1 = 'TOKEN=sentinel-one-4be1'; const S2 = 'Sentinel Two 9c0d'; const S3 = 'sentinel-three-77aa'; const S4 = 'sentinel-four-d5e2';
    const lines: LogPayload[] = [];
    afterEach(() => { setLogger(consoleLogger); lines.length = 0; });
    const swept = (text: string) => [S1, S2, S3, S4].filter((sentinel) => text.includes(sentinel));

    it('an unsupported rule, a renamed project and archive entry names reach no plan reply, receipt or log line', async () => {
        setLogger((payload) => { lines.push(payload); });
        const base = clone(original); base.projects = [{ ...createMockProject('existing-project', AT), title: S2 }];
        const env = await open(base);
        const csv = csvFile(['Title', 'Project', 'Recurrence'], [['Rule task', S2, S1]]);
        const archive = zipSync({ 'tasks.csv': strToU8(csv), [`${S3}.zip`]: zipSync({ 'inner.csv': strToU8('Title\nx') }) });
        const source = { ...csvInput(), text: bytesToBase64(archive), metadata: { ...metadata, fileName: 'export.zip' } };
        const prepared = await prepareNativeBackupDocument(env.adapter, source);
        const reply = JSON.parse(prepared.planJSON).reply;
        expect(reply.result.warnings.every((warning: string) => /^[a-z-]+:\d+$/u.test(warning))).toBe(true);
        expect(reply.result.warnings).toContain('unsupported-recurrence:1');
        expect(swept(JSON.stringify(reply))).toEqual([]);
        await commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME);
        const receipts = await env.sql.client.all<{ reply: string; method: string }>('SELECT reply, method FROM native_request_receipts');
        expect(swept(JSON.stringify(receipts))).toEqual([]);
        // The rule was dropped and the nested archive skipped: neither reaches the library either.
        const library = JSON.stringify(await env.sql.client.all('SELECT * FROM tasks')) + JSON.stringify(await env.sql.client.all('SELECT * FROM projects'));
        expect(swept(library)).toEqual([S2]);
        // The live toast still names the renamed project (RN's text); building it lets the names go.
        const live = buildNativeBackupDocumentResult(reply, t);
        expect(live.message).toContain(S2);
        expect(nativeBackupDocumentWarningsHeld()).toBe(false);
        // After a death the same reply reads as counts.
        expect(swept(buildNativeBackupDocumentResult(reply, t).message)).toEqual([]);
        expect(swept(JSON.stringify(lines))).toEqual([]);
    });

    it('an oversized archive entry is refused without its name in the preview, the parse result, the refusal or a log line', async () => {
        setLogger((payload) => { lines.push(payload); });
        const env = await open();
        const archive = zipSync({ [`${S4}.csv`]: new Uint8Array(9 * 1024 * 1024).fill(65) }, { level: 9 });
        const source = { ...csvInput(), text: bytesToBase64(archive), metadata: { ...metadata, fileName: 'export.zip' } };
        const preview = inspectNativeBackupDocument(source.text, source.metadata, t, 'csv');
        expect(preview.valid).toBe(false);
        expect(swept(JSON.stringify(preview))).toEqual([]);
        expect(swept(JSON.stringify(parseImportSource('mindwtr-csv', { bytes: archive, fileName: 'export.zip' })))).toEqual([]);
        await expect(prepareNativeBackupDocument(env.adapter, source)).rejects.toThrow(expect.objectContaining({ message: expect.not.stringContaining(S4) }));
        expect(swept(JSON.stringify(lines))).toEqual([]);
    });

    // Code review P2: a plan or a receipt written before the stored form holds sentences that can quote the file.
    const LEGACY = [`Imported project "${S2}" was renamed to "${S2} (Todoist)" to avoid a title conflict.`, `Unsupported Recurrence rules: ${S1}.`];
    const legacyPlan = async (env: Awaited<ReturnType<typeof open>>) => {
        const plan = JSON.parse((await prepareNativeBackupDocument(env.adapter, todoistInput())).planJSON);
        plan.reply.result.warnings = LEGACY;
        return plan;
    };
    it('commits an older plan\'s sentences as codes and counts: the receipt and the reply name nothing', async () => {
        setLogger((payload) => { lines.push(payload); });
        const env = await open(); const plan = await legacyPlan(env);
        const reply = await commitNativeBackupDocument(env.adapter, reference, JSON.stringify(plan), NAME);
        expect((reply as { result: { warnings: string[] } }).result.warnings).toEqual(['renamed-container:1', 'unsupported-recurrence:1']);
        expect(swept(JSON.stringify(reply))).toEqual([]);
        expect(swept(JSON.stringify(await env.sql.client.all('SELECT reply FROM native_request_receipts')))).toEqual([]);
        expect(swept(JSON.stringify(lines))).toEqual([]);
    });
    it('answers an older receipt\'s sentences as codes and counts, and formats a cold older reply without names', async () => {
        const env = await open(); const plan = await legacyPlan(env);
        const stored = { ...plan.reply, result: { ...plan.reply.result, warnings: LEGACY } };
        await env.sql.client.run('INSERT INTO native_request_receipts (request_id, method, reply, saved_at) VALUES (?, ?, ?, ?)',
            [ID, JSON.stringify(['backupDocument', 'todoist', ID, reference.sha256]), JSON.stringify(stored), new Date().toISOString()]);
        const replayed = await commitNativeBackupDocument(env.adapter, reference, JSON.stringify(plan), NAME);
        expect(swept(JSON.stringify(replayed))).toEqual([]);
        const outcome = await readNativeBackupDocumentOutcome(env.adapter, reference, JSON.stringify(plan), NAME);
        expect(swept(JSON.stringify(outcome))).toEqual([]);
        // A result record written before the stored form, read after a restart (no names in memory).
        expect(nativeBackupDocumentWarningsHeld()).toBe(false);
        const cold = buildNativeBackupDocumentResult(stored, t);
        expect(swept(cold.message)).toEqual([]);
        expect(cold.message).toContain(t('settings.importDiagnostics.adjustedRecords', { count: 1 }));
    });

    it('ten refused commits in a row leave no warning names behind, and neither does a failed prepare', async () => {
        const base = clone(original); base.projects = [{ ...createMockProject('existing-project', AT), title: 'Launch' }];
        const env = await open(base);
        for (let attempt = 0; attempt < 10; attempt += 1) {
            const prepared = await prepareNativeBackupDocument(env.adapter, todoistInput());
            expect(nativeBackupDocumentWarningsHeld()).toBe(true);
            const later = await env.adapter.getData(); later.tasks[0].title = `Edit ${attempt}`; later.tasks[0].rev! += 1; await env.adapter.saveData(later);
            await expect(commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME)).rejects.toThrow('STALE_REVISION:');
            expect(nativeBackupDocumentWarningsHeld()).toBe(false);
        }
        await prepareNativeBackupDocument(env.adapter, todoistInput());
        await expect(prepareNativeBackupDocument(env.adapter, { ...todoistInput(), text: '' })).rejects.toThrow('INVALID_INPUT:');
        expect(nativeBackupDocumentWarningsHeld()).toBe(false);
    });
});

describe('RN\'s failure toast for a Data operation that did not land (D1b)', () => {
    const de = (key: string, params?: Record<string, number | string>) => formatI18nTemplate(getTranslator('de')(key), params ?? {});
    it('titles an import "Import failed" and words it through RN\'s formatThrownImportError, with no code prefix', () => {
        const failure = buildNativeBackupDocumentFailure('todoist', 'INVALID_INPUT: Invalid backup document input', de, 12);
        expect(failure.title).toBe(de('settings.backupMobile.importFailed'));
        expect(failure.message).toBe(formatImportDiagnostic(createImportDiagnostics(['Invalid backup document input'], 'error')[0], de));
        expect(failure.message).not.toMatch(/^(Error|INVALID_INPUT)/u);
    });
    it('gives a size refusal core\'s limit text: an import\'s, or a backup\'s with the host limit', () => {
        expect(buildNativeBackupDocumentFailure('csv', 'TOO_LARGE: The imported library would be too large to undo', de, 12).message).toBe(de('settings.importDiagnostics.limitExceeded'));
        expect(buildNativeBackupDocumentFailure('omnifocus', 'TOO_LARGE', de, 12).message).toBe(de('settings.importDiagnostics.limitExceeded'));
        expect(buildNativeBackupDocumentFailure('merge', 'TOO_LARGE', de, 12)).toEqual({ title: de('settings.mergeBackupFailed'), message: de('settings.backupDiagnostics.tooLarge', { maxSizeMb: 12 }) });
    });
    it('keeps a backup\'s own words without their code, as D1a showed them', () => {
        expect(buildNativeBackupDocumentFailure('replace', 'STALE_REVISION: Local data changed after backup preparation', de, 12))
            .toEqual({ title: de('settings.backupMobile.restoreFailed'), message: 'Local data changed after backup preparation' });
        expect(buildNativeBackupDocumentFailure('restore', 'unresolved', de, 12).message).toBe('unresolved');
    });
    it('lets the operation\'s warning names go', async () => {
        const base = clone(original); base.projects = [{ ...createMockProject('existing-project', AT), title: 'Launch' }];
        const env = await open(base); await prepareNativeBackupDocument(env.adapter, todoistInput());
        expect(nativeBackupDocumentWarningsHeld()).toBe(true);
        buildNativeBackupDocumentFailure('todoist', 'INVALID_INPUT: Backup operation files do not match', de, 12);
        expect(nativeBackupDocumentWarningsHeld()).toBe(false);
    });
});

describe('native selected JSON backup replacement', () => {
    it('previews immutable JSON with RN replacement effect, counts, warnings and destructive-action words; cancellation writes nothing', async () => {
        const env = await open(); const before = await env.state();
        const source = JSON.stringify({ data: incoming, backupMetadata: { createdAt: AT, version: '99.0.0' } });
        const preview = inspectNativeBackupDocument(source, metadata, t, 'json-restore');
        expect(preview.valid).toBe(true); expect(Object.keys(preview)).toHaveLength(7);
        expect(preview.title).toBe(t('settings.backupMobile.restoreBackup')); expect(preview.confirmLabel).toBe(t('markdown.referenceRestore'));
        expect(preview.summary).toContain(t('settings.backupMobile.backupPreviewCounts', { taskCount: 2, projectCount: 0 }));
        expect(preview.summary).toContain(t('settings.backupMobile.thisWillReplaceAllCurrentLocalDataARecoverySnapshot'));
        expect(preview.summary).toContain(t('settings.backupDiagnostics.newerVersion', { version: '99.0.0' }));
        expect(preview.summary).not.toContain(t('settings.mergeBackupConfirm')); expect(env.writes).toEqual([]); expect(await env.state()).toEqual(before);
        expect(inspectNativeBackupDocument('{private-source', metadata, t, 'json-restore').valid).toBe(false);
    });
    it('prepares from latest durable data with exact shared restore policy, all current-only tombstones and restored settings; recovery precedes mutation', async () => {
        const base = clone(original); base.tasks[0] = { ...base.tasks[0], title: 'Newer local', rev: 99, deletedAt: AT };
        base.projects = [createMockProject('local-project', AT)]; base.sections = [createMockSection('local-section', 'local-project', AT)];
        base.areas = [createMockArea('local-area', AT)]; base.people = [{ id: 'local-person', name: 'Local', createdAt: AT, updatedAt: AT, rev: 1 }];
        base.settings = { theme: 'light', language: 'en', security: { mobileAppLockEnabled: true }, gtd: { focusTaskLimit: 5 },
            syncPreferencesUpdatedAt: { preferences: '2099-01-01T00:00:00.000Z', gtd: '2099-01-01T00:00:00.000Z' } };
        const selected = clone(incoming); selected.settings = { theme: 'dark', language: 'ar', gtd: { focusTaskLimit: 1 }, security: { mobileAppLockEnabled: true }, syncPreferences: { gtd: false } };
        const env = await open(base); const source = input(serializeBackupData(selected), 'replace'); inspectNativeBackupDocument(source.text, metadata, t, 'json-restore');
        const latest = await env.adapter.getData(); latest.tasks.push(task('latest-before-replace')); await env.adapter.saveData(latest); env.writes.length = 0; const before = await env.state();
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(AT);
        try {
            const prepared = await prepareNativeBackupDocument(env.adapter, source); const plan = JSON.parse(prepared.planJSON);
            const parsed = parseImportSource('backup', { text: source.text, ...metadata }).data!;
            expect(plan.data).toEqual(clone(applyImportSource('backup', clone(plan.expectedCurrent), parsed).data));
            expect(plan.reply).toEqual({ version: 1, operation: 'replace', snapshotName: NAME, added: 0, updated: 0 });
            expect(plan.expectedCurrent.tasks.some((item: Task) => item.id === 'latest-before-replace')).toBe(true);
            const recovery = validateBackupJson(prepared.recoveryJSON!).data!; expect(recovery.tasks).toEqual(plan.expectedCurrent.tasks);
            expect(recovery.settings.theme).toBe('light'); expect(plan.data.settings).toMatchObject({ theme: 'dark', language: 'ar', gtd: { focusTaskLimit: 1 }, syncPreferences: { gtd: false }, pendingRemoteWriteAt: AT });
            // App Lock is this device's own (13c807f07): the backup's value is dropped and the current device's kept (D1a review 2).
            expect(plan.data.settings.security).toEqual({ mobileAppLockEnabled: true }); expect(plan.data.settings.syncPreferencesUpdatedAt.preferences > '2099-01-01T00:00:00.000Z').toBe(true);
            const restored = plan.data.tasks.find((item: Task) => item.id === 'visible'); expect(restored.title).toBe('日本語 🦉'); expect(restored.deletedAt).toBeUndefined(); expect(restored.rev).toBeGreaterThan(99);
            for (const [field, localId] of [['tasks','latest-before-replace'],['projects','local-project'],['sections','local-section'],['areas','local-area'],['people','local-person']]) {
                expect(plan.data[field].find((item: { id: string }) => item.id === localId).deletedAt).toBe(AT);
            }
            expect(env.writes).toEqual([]); expect(await env.state()).toEqual(before);
            await commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME);
            expect((await env.adapter.getData()).tasks.find((item) => item.id === 'visible')?.title).toBe('日本語 🦉');
        } finally { vi.useRealTimers(); }
    });
    it('returns RN replacement snapshot+Undo result; exact snapshot restore rolls later edits back without another recovery', async () => {
        const env = await open(); const prepared = await prepareNativeBackupDocument(env.adapter, input(undefined, 'replace'));
        const reply = await commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME);
        expect(buildNativeBackupDocumentResult(reply, t)).toEqual({ title: t('settings.backupMobile.restoreComplete'),
            message: t('settings.backupMobile.backupRestoredWithSnapshot', { snapshotName: NAME }), undoLabel: t('settings.undoImport'), doneLabel: t('common.done'), durationMs: 5000 });
        const later = await env.adapter.getData(); later.tasks.push(task('after-replace', { rev: 30 })); later.tasks.find((item) => item.id === 'visible')!.title = 'After replacement'; await env.adapter.saveData(later);
        const undoId = '22222222-2222-4222-8222-222222222222';
        const undo = await prepareNativeBackupDocument(env.adapter, { ...input(prepared.recoveryJSON!, 'restore'), requestId: undoId });
        expect(undo.recoveryJSON).toBeNull(); const restored = await commitNativeBackupDocument(env.adapter, { ...reference, id: undoId, sha256: 'b'.repeat(64) }, undo.planJSON, NAME);
        expect((await env.adapter.getData()).tasks.find((item) => item.id === 'visible')?.title).toBe('visible');
        expect((await env.adapter.getData()).tasks.find((item) => item.id === 'after-replace')?.deletedAt).toBeTruthy();
        expect(buildNativeBackupDocumentResult(restored, t).undoLabel).toBe(''); expect(buildNativeBackupSnapshotRestoreConfirmation(NAME, t).message).toContain('Anything you changed since is rolled back too');
    });
    it.each(['added', 'updated'] as const)('rejects nonzero replace %s before receipt operations', async (field) => {
        const env = await open(); const prepared = await prepareNativeBackupDocument(env.adapter, input(undefined, 'replace')); const plan = JSON.parse(prepared.planJSON); plan.reply[field] = 1;
        const save = vi.spyOn(env.adapter, 'saveDocumentWithReceipt'); await expect(commitNativeBackupDocument(env.adapter, reference, JSON.stringify(plan), NAME)).rejects.toThrow('INVALID_INPUT:');
        expect(save).not.toHaveBeenCalled(); expect(env.writes).toEqual([]);
    });
});


const todoistCsv = [
    'TYPE,CONTENT,PRIORITY,INDENT,DATE,DESCRIPTION', 'section,Planning,,,,',
    'task,Plan launch 日本語 🦉 @work,1,1,2026-04-02,Write launch brief', 'note,Share with leadership,,,,',
    'task,Follow up @ops,4,2,2026-04-03,Check dependencies', 'task,Weekly review @home,2,1,every Monday,',
].join('\n');
const todoistInput = (text = todoistCsv): NativeBackupDocumentPrepareInput => ({ ...input(), mode: 'todoist',
    text: bytesToBase64(strToU8(text)), metadata: { ...metadata, fileName: 'Launch.csv' } });

describe('native Todoist CSV and ZIP prepared import', () => {
    it.each(['csv', 'zip'] as const)('inspects %s using complete RN preview with first-four projects and warnings, then cancellation writes nothing', async (kind) => {
        const env = await open(); const before = await env.state(); const source = todoistInput();
        if (kind === 'zip') { source.text = bytesToBase64(zipSync(Object.fromEntries(['One','Two','Three','Four','Five'].map((name) => [`${name}.csv`, strToU8(todoistCsv)])))); source.metadata.fileName = 'Todoist.zip'; }
        const preview = inspectNativeBackupDocument(source.text, source.metadata, t, 'todoist');
        expect(preview.valid).toBe(true); expect(Object.keys(preview)).toHaveLength(7);
        expect(preview.title).toBe(t('settings.backupMobile.importTodoistData')); expect(preview.confirmLabel).toBe(t('settings.backupMobile.import'));
        expect(preview.summary).toContain(t('settings.backupMobile.importTodoistTasksFromProjects', { taskCount: kind === 'zip' ? 10 : 2, projectCount: kind === 'zip' ? 5 : 1 }));
        expect(preview.summary).toContain(t('settings.backupMobile.sectionsWillBePreserved', { sectionCount: kind === 'zip' ? 5 : 1 }));
        expect(preview.summary).toContain(t('settings.backupMobile.subtasksWillBecomeChecklistItems', { subtaskCount: kind === 'zip' ? 5 : 1 }));
        expect(preview.summary).not.toContain(t('settings.backupMobile.importedTasksStayInInboxSoYouCanProcessThem'));
        expect(preview.summary).toContain(t('settings.importDiagnostics.unsupportedRecurrence', { count: kind === 'zip' ? 5 : 1 }));
        if (kind === 'zip') { expect(preview.summary).toContain('• Four: 2'); expect(preview.summary).not.toContain('• Five:'); expect(preview.summary).toContain(t('settings.backupMobile.moreProjects', { projectCount: 1 })); }
        expect(env.writes).toEqual([]); expect(await env.state()).toEqual(before);
    });
    it.each(['csv', 'zip'] as const)('freezes actual %s Todoist policy and checklist IDs from latest durable data and cold-replays preserving intervening edits', async (kind) => {
        const env = await open(); const source = todoistInput();
        if (kind === 'zip') { source.text = bytesToBase64(zipSync({ 'Launch.csv': strToU8(todoistCsv), 'ignored.txt': strToU8('ignored') })); source.metadata.fileName = 'Todoist.zip'; }
        inspectNativeBackupDocument(source.text, source.metadata, t, 'todoist'); const latest = await env.adapter.getData(); latest.tasks.push(task('latest-todoist')); await env.adapter.saveData(latest); env.writes.length = 0; const before = await env.state();
        const prepared = await prepareNativeBackupDocument(env.adapter, source); const plan = JSON.parse(prepared.planJSON);
        expect(env.writes).toEqual([]); expect(await env.state()).toEqual(before); expect(plan.expectedCurrent.tasks.some((item: Task) => item.id === 'latest-todoist')).toBe(true);
        expect(plan.reply).toEqual({ version: 1, operation: 'todoist', snapshotName: NAME, result: { importedChecklistItemCount: 1, importedProjectCount: 1, importedSectionCount: 1, importedTaskCount: 2, warnings: [] } });
        expect(Object.keys(plan.reply.result)).toHaveLength(5); expect(plan.reply.result).not.toHaveProperty('data'); expect(validateBackupJson(prepared.recoveryJSON!).valid).toBe(true);
        const imported = plan.data.tasks.find((item: Task) => item.title === 'Plan launch 日本語 🦉');
        expect(imported).toMatchObject({ status: 'next', taskMode: 'list', priority: 'urgent', dueDate: '2026-04-02', tags: ['#work','#ops'], checklist: [{ id: expect.any(String), title: 'Follow up', isCompleted: false }] });
        expect(imported.projectId).toBeTruthy(); expect(imported.sectionId).toBeTruthy(); expect(imported.description).toContain('Share with leadership'); expect(imported.description).toContain('Subtask "Follow up": Check dependencies | Due: 2026-04-03');
        const recurring = plan.data.tasks.find((item: Task) => item.title === 'Weekly review'); expect(recurring.recurrence).toBeUndefined(); expect(recurring.description).toContain('Imported from Todoist recurring schedule: every Monday');
        const first = await commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME);
        expect((await env.adapter.getData()).tasks.find((item) => item.id === imported.id)?.checklist).toEqual(imported.checklist);
        const later = await env.adapter.getData(); const target = later.tasks.find((item) => item.id === imported.id)!; target.title = 'Later Todoist edit'; target.rev! += 1; await env.adapter.saveData(later); const committed = await env.state();
        resetNativeRequestReceipts(); await loadNativeRequestReceipts(env.sql.client, { durableCommands: ['backupDocument'] }); const cold = new NativeReceiptSqliteAdapter(env.client, { rejectConcurrentWrites: true }); await cold.ensureSchema(); setStorageAdapter(cold); env.writes.length = 0;
        expect(await readNativeBackupDocumentOutcome(cold, reference, prepared.planJSON, NAME)).toEqual(first); expect(await commitNativeBackupDocument(cold, reference, prepared.planJSON, NAME)).toEqual(first);
        expect(env.writes).toEqual([]); expect(await env.state()).toEqual(committed); expect(useTaskStore.getState()._allTasks.find((item) => item.id === imported.id)?.title).toBe('Later Todoist edit');
    });
    it.each(['edited', 'deleted'] as const)('reimport preserves Todoist %s history and IDs rather than adding records', async (condition) => {
        const env = await open(); const first = await prepareNativeBackupDocument(env.adapter, todoistInput()); await commitNativeBackupDocument(env.adapter, reference, first.planJSON, NAME);
        const latest = await env.adapter.getData(); const project = latest.projects[0]; const imported = latest.tasks.find((item) => item.projectId === project.id)!;
        imported.title = 'Edited Todoist history'; imported.rev! += 1; if (condition === 'deleted') {
            project.deletedAt = AT;
            for (const item of latest.tasks) if (item.projectId === project.id) item.deletedAt = AT;
            for (const item of latest.sections) if (item.projectId === project.id) item.deletedAt = AT;
        }
        await env.adapter.saveData(latest); env.writes.length = 0; const before = await env.adapter.getData();
        const prepared = await prepareNativeBackupDocument(env.adapter, { ...todoistInput(), requestId: '22222222-2222-4222-8222-222222222222' }); const plan = JSON.parse(prepared.planJSON);
        expect(plan.reply.result).toEqual({ importedChecklistItemCount: 0, importedProjectCount: 0, importedSectionCount: 0, importedTaskCount: 0, warnings: [] }); expect(plan.data).toEqual(before); expect(env.writes).toEqual([]);
    });
    it('uses shared date-only and hostile-date handling, with localized unsupported-date preview', async () => {
        const env = await open(); const source = todoistInput('TYPE,CONTENT,DATE\ntask,Date only,2026-04-02\ntask,Hostile,constructor');
        expect(inspectNativeBackupDocument(source.text, source.metadata, t, 'todoist').summary).toContain(t('settings.importDiagnostics.unmappedDate', { count: 1 }));
        const plan = JSON.parse((await prepareNativeBackupDocument(env.adapter, source)).planJSON);
        expect(plan.data.tasks.find((item: Task) => item.title === 'Date only').dueDate).toBe('2026-04-02'); expect(plan.data.tasks.find((item: Task) => item.title === 'Hostile').dueDate).toBeUndefined();
    });
    it('localizes every actual execution warning and RN counts/checklist/snapshot/Undo result', async () => {
        const base = clone(original); base.projects = [{ ...createMockProject('existing-project', AT), title: 'Launch' }]; const env = await open(base);
        const prepared = await prepareNativeBackupDocument(env.adapter, todoistInput()); const reply = JSON.parse(prepared.planJSON).reply;
        expect(reply.result.warnings).toEqual(['renamed-container:1']);
        const model = buildNativeBackupDocumentResult(reply, t); expect(model.title).toBe(t('settings.backupMobile.importComplete')); expect(model.undoLabel).toBe(t('settings.undoImport'));
        expect(model.message).toContain(t('settings.backupMobile.importedTodoistTasksIntoProjects', { taskCount: 2, projectCount: 1 })); expect(model.message).toContain(t('settings.backupMobile.subtasksBecameChecklistItems', { subtaskCount: 1 })); expect(model.message).toContain(NAME);
        expect(model.message).toContain(t('settings.importDiagnostics.renamedContainer', { from: 'Launch', to: 'Launch (Todoist)' }));
    });
    it('Todoist Undo restores the exact pre-import snapshot and tombstones later local edits without another recovery', async () => {
        const env = await open(); const prepared = await prepareNativeBackupDocument(env.adapter, todoistInput()); await commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME);
        const later = await env.adapter.getData(); later.tasks.push(task('after-todoist')); later.tasks.find((item) => item.id === 'visible')!.title = 'Later local edit'; await env.adapter.saveData(later);
        const undoId = '22222222-2222-4222-8222-222222222222'; const undo = await prepareNativeBackupDocument(env.adapter, { ...input(prepared.recoveryJSON!, 'restore'), requestId: undoId }); expect(undo.recoveryJSON).toBeNull();
        await commitNativeBackupDocument(env.adapter, { ...reference, id: undoId, sha256: 'b'.repeat(64) }, undo.planJSON, NAME);
        const restored = await env.adapter.getData(); expect(restored.tasks.find((item) => item.id === 'visible')?.title).toBe('visible'); expect(restored.tasks.find((item) => item.id === 'after-todoist')?.deletedAt).toBeTruthy(); expect(restored.projects.filter((item) => !item.deletedAt)).toEqual([]);
    });
    it.each(['TYPE,CONTENT\n', 'Title,Project\nPrivate,Work', 'PK private corrupt archive'])('invalid Todoist file returns localized refusal without writes or raw contents', async (text) => {
        const env = await open(); const source = todoistInput(text); const read = vi.spyOn(env.adapter, 'getData'); const preview = inspectNativeBackupDocument(source.text, source.metadata, t, 'todoist'); expect(preview.valid).toBe(false); expect(preview.errorMessage).toBeTruthy(); expect(preview.errorMessage).not.toContain('Private');
        await expect(prepareNativeBackupDocument(env.adapter, source)).rejects.toThrow('INVALID_INPUT:'); expect(read).not.toHaveBeenCalled(); expect(env.writes).toEqual([]);
    });
    it.each(['TR==','TWF=','TQ=','====','VGl0bGUs\n','VGl0bGUs_'])('Todoist rejects noncanonical base64 %s before adapter operations', async (text) => {
        const env = await open(); const read = vi.spyOn(env.adapter, 'getData'); await expect(prepareNativeBackupDocument(env.adapter, { ...todoistInput(), text })).rejects.toThrow('INVALID_INPUT:'); expect(read).not.toHaveBeenCalled(); expect(env.writes).toEqual([]);
    });
    // Real 16 MiB boundary fixtures need headroom under coverage instrumentation.
    it('Todoist bounds decoded bytes before allocation and retains shared8MiB text and ZIP entry/expanded limits', async () => {
        const env = await open(); const read = vi.spyOn(env.adapter, 'getData');
        await expect(prepareNativeBackupDocument(env.adapter, { ...todoistInput(), text: 'A'.repeat(4 * Math.ceil((16 * 1024 * 1024 + 1) / 3)) })).rejects.toThrow('Todoist source exceeds 16 MiB');
        const exact = 'A'.repeat(4 * Math.ceil(16 * 1024 * 1024 / 3) - 2) + '=='; await expect(prepareNativeBackupDocument(env.adapter, { ...todoistInput(), text: exact })).rejects.toThrow('INVALID_INPUT: Invalid backup document input');
        expect(inspectNativeBackupDocument(exact, todoistInput().metadata, t, 'todoist').errorMessage).toBe(t('settings.importDiagnostics.limitExceeded'));
        const largeZip = bytesToBase64(zipSync({ 'large.csv': new Uint8Array(8 * 1024 * 1024 + 1) })); expect(inspectNativeBackupDocument(largeZip, todoistInput().metadata, t, 'todoist').errorMessage).toBe(t('settings.importDiagnostics.limitExceeded'));
        expect(read).not.toHaveBeenCalled(); expect(env.writes).toEqual([]);
    }, 15_000);
    it('stores 40 renamed Todoist projects as codes: no name reaches the reply, which stays small', async () => {
        const base = clone(original); const files: Record<string, Uint8Array> = {};
        for (let index = 0; index < 40; index += 1) { const name = `Project${index}-${'A'.repeat(1000)}`; base.projects.push({ ...createMockProject(`existing-${index}`, AT), title: name }); files[`${name}.csv`] = strToU8('TYPE,CONTENT\ntask,Imported'); }
        const env = await open(base); const source = { ...todoistInput(), text: bytesToBase64(zipSync(files)), metadata: { ...metadata, fileName: 'Todoist.zip' } };
        small(JSON.parse((await prepareNativeBackupDocument(env.adapter, source)).planJSON).reply); expect(env.writes).toEqual([]);
    });
    it.each(['extra','data','csv-count','negative','fraction','missing','warning','overflow'] as const)('rejects malformed Todoist result %s at every reply boundary before adapter writes', async (fault) => {
        const env = await open(); const prepared = await prepareNativeBackupDocument(env.adapter, todoistInput()); const plan = JSON.parse(prepared.planJSON);
        if (fault === 'extra') plan.reply.added = 1; if (fault === 'data') plan.reply.result.data = plan.data; if (fault === 'csv-count') plan.reply.result.importedAreaCount = 0;
        if (fault === 'negative') plan.reply.result.importedTaskCount = -1; if (fault === 'fraction') plan.reply.result.importedSectionCount = 0.5; if (fault === 'missing') delete plan.reply.result.importedProjectCount;
        if (fault === 'warning') plan.reply.result.warnings = [1]; if (fault === 'overflow') plan.reply.result.warnings = ['私'.repeat(23_000)];
        const save = vi.spyOn(env.adapter, 'saveDocumentWithReceipt'); expect(() => buildNativeBackupDocumentResult(plan.reply, t)).toThrow('INVALID_INPUT:');
        await expect(commitNativeBackupDocument(env.adapter, reference, JSON.stringify(plan), NAME)).rejects.toThrow('INVALID_INPUT:'); await expect(readNativeBackupDocumentOutcome(env.adapter, reference, JSON.stringify(plan), NAME)).rejects.toThrow('INVALID_INPUT:'); expect(save).not.toHaveBeenCalled(); expect(env.writes).toEqual([]);
    });
    it('refuses stale Todoist preparation after a durable edit with no document writes', async () => {
        const env = await open(); const prepared = await prepareNativeBackupDocument(env.adapter, todoistInput()); const later = await env.adapter.getData(); later.tasks[0].title = 'Changed after Todoist'; later.tasks[0].rev! += 1; await env.adapter.saveData(later); const before = await env.state(); env.writes.length = 0;
        await expect(commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME)).rejects.toThrow('STALE_REVISION:'); expect(env.writes).toEqual([]); expect(await env.state()).toEqual(before);
    });
});


const ticktickHeaders = ['Folder Name','List Name','Title','Kind','Tags','Content','Is Check list','Start Date','Due Date','Repeat','Priority','Status','Created Time','Completed Time','Timezone','Is All Day','taskId','parentId'];
const ticktickRows = [
    ['Work','Launch','Book venue','TEXT','#ops','Confirm capacity','N','','','','1','1','2026-06-12T12:00:00+0000','2026-06-13T12:00:00+0000','America/New_York','false','101','100'],
    ['Work','Launch','Plan release 日本語 🦉','TEXT','#work, focus','Write launch brief','N','2026-06-17T04:00:00+0000','2026-06-18T04:00:00+0000','FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;WKST=MO','5','0','2026-06-11T12:00:00+0000','','America/New_York','true','100',''],
    ['Work','Launch','Packing list','CHECKLIST','travel','▫Passport\n▪Tickets','Y','','','','3','2','2026-06-10T12:00:00+0000','2026-06-15T12:00:00+0000','America/New_York','false','102',''],
];
const ticktickCsv = csvFile(ticktickHeaders, ticktickRows);
const ticktickInput = (text = ticktickCsv): NativeBackupDocumentPrepareInput => ({ ...input(), mode: 'ticktick', text: bytesToBase64(strToU8(text)), metadata: { ...metadata, fileName: 'TickTick.csv' } });

describe('native TickTick CSV and ZIP prepared import', () => {
    it.each(['csv','zip'] as const)('inspects %s with RN areas/projects/checklists/recurrence/project lines/warnings and cancellation writes nothing', async (kind) => {
        const env = await open(); const before = await env.state(); const source = ticktickInput();
        if (kind === 'zip') { source.text = bytesToBase64(zipSync({ 'backup.csv': strToU8(ticktickCsv), 'notes.txt': strToU8('ignored') })); source.metadata.fileName = 'TickTick.zip'; }
        const preview = inspectNativeBackupDocument(source.text, source.metadata, t, 'ticktick'); expect(preview.valid).toBe(true); expect(Object.keys(preview)).toHaveLength(7);
        expect(preview.title).toBe(t('settings.backupMobile.importTicktickData')); expect(preview.confirmLabel).toBe(t('settings.backupMobile.import'));
        expect(preview.summary).toContain(t('settings.backupMobile.ticktickAreasWillBeCreated', { areaCount: 1 })); expect(preview.summary).toContain(t('settings.backupMobile.ticktickProjectsWillBeCreated', { projectCount: 1 }));
        expect(preview.summary).toContain(t('settings.backupMobile.checklistItemsWillBePreserved', { checklistItemCount: 3 })); expect(preview.summary).toContain(t('settings.backupMobile.recurringTasksWillKeepSupportedRepeatRules', { taskCount: 1 }));
        expect(preview.summary).toContain('• Work / Launch: 2'); expect(preview.summary).not.toContain(t('settings.backupMobile.importedTasksStayInInboxSoYouCanProcessThem'));
        const parsed = parseImportSource('ticktick', { bytes: kind === 'csv' ? strToU8(ticktickCsv) : zipSync({ 'backup.csv': strToU8(ticktickCsv), 'notes.txt': strToU8('ignored') }), fileName: source.metadata.fileName });
        for (const diagnostic of createImportDiagnostics(parsed.preview!.warnings, 'warning')) expect(preview.summary).toContain(formatImportDiagnostic(diagnostic, t));
        expect(env.writes).toEqual([]); expect(await env.state()).toEqual(before);
    });
    it('preview limits project examples to first four and retains remaining count and optional areas', () => {
        const rows = ['One','Two','Three','Four','Five'].map((name, index) => ['Work', name, `Task${index}`, ...new Array(13).fill(''), String(index), '']);
        const source = ticktickInput(csvFile(ticktickHeaders, rows)); const parsed = parseImportSource('ticktick', { bytes: strToU8(csvFile(ticktickHeaders, rows)), fileName: source.metadata.fileName });
        const preview = inspectNativeBackupDocument(source.text, source.metadata, t, 'ticktick'); expect(preview.valid).toBe(true);
        for (const project of parsed.preview!.projects.slice(0,4)) expect(preview.summary).toContain(`• ${project.areaName ? `${project.areaName} / ` : ''}${project.name}: ${project.taskCount}`);
        const fifth = parsed.preview!.projects[4]; expect(preview.summary).not.toContain(`• ${fifth.areaName} / ${fifth.name}:`); expect(preview.summary).toContain(t('settings.backupMobile.moreProjects', { projectCount: 1 }));
    });
    it.each(['csv','zip'] as const)('freezes actual %s TickTick rich policy/checklist IDs from fresh durable data; cold receipt replay preserves later edits', async (kind) => {
        const base = clone(original); base.people = [{ id: 'preserved-person', name: 'Taylor', createdAt: AT, updatedAt: AT, rev: 1 }];
        const env = await open(base); const source = ticktickInput(); if (kind === 'zip') { source.text = bytesToBase64(zipSync({ 'backup.csv': strToU8(ticktickCsv) })); source.metadata.fileName = 'TickTick.zip'; }
        inspectNativeBackupDocument(source.text, source.metadata, t, 'ticktick'); const latest = await env.adapter.getData(); latest.tasks.push(task('latest-ticktick')); await env.adapter.saveData(latest); env.writes.length = 0; const before = await env.state();
        const prepared = await prepareNativeBackupDocument(env.adapter, source); const plan = JSON.parse(prepared.planJSON); expect(env.writes).toEqual([]); expect(await env.state()).toEqual(before);
        expect(plan.expectedCurrent.tasks.some((item: Task) => item.id === 'latest-ticktick')).toBe(true); expect(validateBackupJson(prepared.recoveryJSON!).valid).toBe(true);
        expect(plan.reply.result).toMatchObject({ importedAreaCount: 1, importedChecklistItemCount: 3, importedProjectCount: 1, importedSectionCount: 0, importedTaskCount: 2, warnings: expect.any(Array) });
        expect(Object.keys(plan.reply)).toHaveLength(4); expect(Object.keys(plan.reply.result)).toHaveLength(6); expect(plan.reply.result).not.toHaveProperty('data'); expect(plan.reply.result).not.toHaveProperty('importedStandaloneTaskCount');
        const imported = plan.data.tasks.find((item: Task) => item.title === 'Plan release 日本語 🦉'); expect(imported).toMatchObject({ status: 'next', dueDate: '2026-06-18', startTime: '2026-06-17', priority: 'high', tags: ['#work','#focus','#ops'], recurrence: { rule: 'weekly', byDay: ['MO','WE'], weekStart: 'MO' }, checklist: [{ id: expect.any(String), title: 'Book venue', isCompleted: true }] });
        expect(imported.description).toContain('Write launch brief'); expect(imported.description).toContain('Subtask "Book venue": Confirm capacity'); expect(imported.projectId).toBeTruthy();
        const packing = plan.data.tasks.find((item: Task) => item.title === 'Packing list'); expect(packing).toMatchObject({ status: 'archived', completedAt: '2026-06-15T12:00:00.000Z', checklist: [{ title: 'Passport', isCompleted: false }, { title: 'Tickets', isCompleted: true }] });
        expect(plan.data.people).toEqual(plan.expectedCurrent.people);
        const first = await commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME); expect((await env.adapter.getData()).tasks.find((item) => item.id === imported.id)?.checklist).toEqual(imported.checklist);
        const later = await env.adapter.getData(); const changed = later.tasks.find((item) => item.id === imported.id)!; changed.title = 'Later TickTick edit'; changed.rev! += 1; await env.adapter.saveData(later); const committed = await env.state();
        resetNativeRequestReceipts(); await loadNativeRequestReceipts(env.sql.client, { durableCommands: ['backupDocument'] }); const cold = new NativeReceiptSqliteAdapter(env.client, { rejectConcurrentWrites: true }); await cold.ensureSchema(); setStorageAdapter(cold); env.writes.length = 0;
        expect(await readNativeBackupDocumentOutcome(cold, reference, prepared.planJSON, NAME)).toEqual(first); expect(await commitNativeBackupDocument(cold, reference, prepared.planJSON, NAME)).toEqual(first); expect(env.writes).toEqual([]); expect(await env.state()).toEqual(committed);
        expect(useTaskStore.getState()._allTasks.find((item) => item.id === imported.id)?.title).toBe('Later TickTick edit');
    });
    it.each(['edited','deleted'] as const)('uses shared TickTick %s reimport identity/history rules', async (condition) => {
        const env = await open(); const prepared = await prepareNativeBackupDocument(env.adapter, ticktickInput()); const firstPlan = JSON.parse(prepared.planJSON); await commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME);
        const latest = await env.adapter.getData(); const importedIds = new Set(firstPlan.data.tasks.filter((item: Task) => !firstPlan.expectedCurrent.tasks.some((existing: Task) => existing.id === item.id)).map((item: Task) => item.id));
        for (const item of latest.tasks) if (importedIds.has(item.id)) { item.title = `Edited ${item.title}`; item.rev! += 1; if (condition === 'deleted') item.deletedAt = AT; }
        if (condition === 'deleted') { for (const item of latest.projects) item.deletedAt = AT; for (const item of latest.areas) item.deletedAt = AT; }
        await env.adapter.saveData(latest); env.writes.length = 0; const again = await prepareNativeBackupDocument(env.adapter, { ...ticktickInput(), requestId: '22222222-2222-4222-8222-222222222222' }); const plan = JSON.parse(again.planJSON);
        expect(plan.reply.result).toMatchObject({ importedAreaCount: 0, importedChecklistItemCount: 0, importedProjectCount: 0, importedSectionCount: 0, importedTaskCount: 0 });
        expect(plan.data.tasks.map((item: Task) => item.id)).toEqual(plan.expectedCurrent.tasks.map((item: Task) => item.id));
        for (const item of plan.data.tasks) if (importedIds.has(item.id)) { expect(item.title.startsWith('Edited ')).toBe(true); if (condition === 'deleted') expect(item.deletedAt).toBe(AT); }
        expect(env.writes).toEqual([]);
    });
    it('keeps standalone TickTick Inbox status when shared policy cannot attach to a tombstoned project, excluding runtime standalone count', async () => {
        const first = await open(); const seed = JSON.parse((await prepareNativeBackupDocument(first.adapter, ticktickInput())).planJSON).data as AppData;
        const base = clone(original); base.areas = seed.areas; base.projects = seed.projects.map((item) => ({ ...item, deletedAt: AT }));
        const env = await open(base); const plan = JSON.parse((await prepareNativeBackupDocument(env.adapter, ticktickInput())).planJSON);
        const imported = plan.data.tasks.find((item: Task) => item.title === 'Plan release 日本語 🦉'); expect(imported.projectId).toBeUndefined(); expect(imported.status).toBe('inbox');
        expect(plan.reply.result.importedProjectCount).toBe(0); expect(plan.reply.result.importedTaskCount).toBe(2); expect(plan.reply.result).not.toHaveProperty('importedStandaloneTaskCount');
    });
    it('uses shared execution warnings and RN task/project/area/checklist/snapshot/Undo result', async () => {
        const env = await open(); const prepared = await prepareNativeBackupDocument(env.adapter, ticktickInput()); const reply = JSON.parse(prepared.planJSON).reply;
        const parsed = parseImportSource('ticktick', { bytes: strToU8(ticktickCsv), fileName: ticktickInput().metadata.fileName }); expect(reply.result.warnings).toEqual(stored(parsed.parsedData!.warnings));
        const model = buildNativeBackupDocumentResult(reply, t); expect(model.title).toBe(t('settings.backupMobile.importComplete')); expect(model.undoLabel).toBe(t('settings.undoImport'));
        expect(model.message).toContain(t('settings.backupMobile.importedTaskProjectAreaCounts', { taskCount: 2, projectCount: 1, areaCount: 1 })); expect(model.message).toContain(t('settings.backupMobile.checklistItemsPreserved', { checklistItemCount: 3 })); expect(model.message).toContain(NAME);
        for (const diagnostic of createImportDiagnostics(parsed.parsedData!.warnings, 'warning')) expect(model.message).toContain(formatImportDiagnostic(diagnostic, t));
    });
    it('TickTick Undo restores exact pre-import snapshot and tombstones later edits with no second recovery', async () => {
        const env = await open(); const prepared = await prepareNativeBackupDocument(env.adapter, ticktickInput()); await commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME);
        const later = await env.adapter.getData(); later.tasks.push(task('after-ticktick')); later.tasks.find((item) => item.id === 'visible')!.title = 'Later'; await env.adapter.saveData(later);
        const id = '22222222-2222-4222-8222-222222222222'; const undo = await prepareNativeBackupDocument(env.adapter, { ...input(prepared.recoveryJSON!, 'restore'), requestId: id }); expect(undo.recoveryJSON).toBeNull(); await commitNativeBackupDocument(env.adapter, { ...reference, id, sha256: 'b'.repeat(64) }, undo.planJSON, NAME);
        const restored = await env.adapter.getData(); expect(restored.tasks.find((item) => item.id === 'visible')?.title).toBe('visible'); expect(restored.tasks.find((item) => item.id === 'after-ticktick')?.deletedAt).toBeTruthy(); expect(restored.projects.filter((item) => !item.deletedAt)).toEqual([]);
    });
    it.each(['Title,List Name\n', 'TYPE,CONTENT\ntask,Private', 'Private corrupt archive'])('invalid TickTick source returns fixed localized refusal without adapter operations', async (text) => {
        const env = await open(); const source = ticktickInput(text); const read = vi.spyOn(env.adapter, 'getData'); const preview = inspectNativeBackupDocument(source.text, source.metadata, t, 'ticktick'); expect(preview.valid).toBe(false); expect(preview.errorMessage).not.toContain('Private');
        await expect(prepareNativeBackupDocument(env.adapter, source)).rejects.toThrow('INVALID_INPUT:'); expect(read).not.toHaveBeenCalled(); expect(env.writes).toEqual([]);
    });
    it.each(['TR==','TWF=','TQ=','====','VGl0bGUs\n','VGl0bGUs_'])('TickTick rejects noncanonical binary transport %s before adapter operations', async (text) => {
        const env = await open(); const read = vi.spyOn(env.adapter, 'getData'); await expect(prepareNativeBackupDocument(env.adapter, { ...ticktickInput(), text })).rejects.toThrow('INVALID_INPUT:'); expect(read).not.toHaveBeenCalled(); expect(env.writes).toEqual([]);
    });
    it('TickTick enforces16MiB before allocation while preserving shared8MiB text/ZIP limits', async () => {
        const env = await open(); const read = vi.spyOn(env.adapter, 'getData'); await expect(prepareNativeBackupDocument(env.adapter, { ...ticktickInput(), text: 'A'.repeat(4 * Math.ceil((16 * 1024 * 1024 + 1) / 3)) })).rejects.toThrow('TickTick source exceeds 16 MiB');
        const exact = 'A'.repeat(4 * Math.ceil(16 * 1024 * 1024 / 3) - 2) + '=='; await expect(prepareNativeBackupDocument(env.adapter, { ...ticktickInput(), text: exact })).rejects.toThrow('INVALID_INPUT: Invalid backup document input'); expect(inspectNativeBackupDocument(exact, ticktickInput().metadata, t, 'ticktick').errorMessage).toBe(t('settings.importDiagnostics.limitExceeded'));
        const zip = bytesToBase64(zipSync({ 'too-large.csv': new Uint8Array(8 * 1024 * 1024 + 1) })); expect(inspectNativeBackupDocument(zip, ticktickInput().metadata, t, 'ticktick').errorMessage).toBe(t('settings.importDiagnostics.limitExceeded')); expect(read).not.toHaveBeenCalled(); expect(env.writes).toEqual([]);
    }, 15_000);
    it('stores 40 renamed TickTick projects as codes: no name reaches the reply, which stays small', async () => {
        const base = clone(original); const rows: string[][] = [];
        for (let index = 0; index < 40; index += 1) { const name = `Project${index}-${'A'.repeat(1000)}`; base.projects.push({ ...createMockProject(`existing-${index}`, AT), title: name }); rows.push(['',name,'Imported',...new Array(13).fill(''),String(index),'']); }
        const env = await open(base); small(JSON.parse((await prepareNativeBackupDocument(env.adapter, ticktickInput(csvFile(ticktickHeaders, rows)))).planJSON).reply); expect(env.writes).toEqual([]);
    });
    it.each(['extra','data','standalone','missing-area','negative','fraction','unsafe','warning','overflow'] as const)('refuses malformed TickTick result %s at every boundary before writes', async (fault) => {
        const env = await open(); const prepared = await prepareNativeBackupDocument(env.adapter, ticktickInput()); const plan = JSON.parse(prepared.planJSON);
        if (fault === 'extra') plan.reply.added = 1; if (fault === 'data') plan.reply.result.data = plan.data; if (fault === 'standalone') plan.reply.result.importedStandaloneTaskCount = 0; if (fault === 'missing-area') delete plan.reply.result.importedAreaCount;
        if (fault === 'negative') plan.reply.result.importedTaskCount = -1; if (fault === 'fraction') plan.reply.result.importedSectionCount = 0.5; if (fault === 'unsafe') plan.reply.result.importedTaskCount = Number.MAX_SAFE_INTEGER + 1;
        if (fault === 'warning') plan.reply.result.warnings = [1]; if (fault === 'overflow') plan.reply.result.warnings = ['私'.repeat(23_000)]; const save = vi.spyOn(env.adapter, 'saveDocumentWithReceipt');
        expect(() => buildNativeBackupDocumentResult(plan.reply, t)).toThrow('INVALID_INPUT:'); await expect(commitNativeBackupDocument(env.adapter, reference, JSON.stringify(plan), NAME)).rejects.toThrow('INVALID_INPUT:'); await expect(readNativeBackupDocumentOutcome(env.adapter, reference, JSON.stringify(plan), NAME)).rejects.toThrow('INVALID_INPUT:'); expect(save).not.toHaveBeenCalled(); expect(env.writes).toEqual([]);
    });
    it('refuses stale TickTick frozen document after intervening durable change without writes', async () => {
        const env = await open(); const prepared = await prepareNativeBackupDocument(env.adapter, ticktickInput()); const later = await env.adapter.getData(); later.tasks[0].title = 'Changed after TickTick'; later.tasks[0].rev! += 1; await env.adapter.saveData(later); const before = await env.state(); env.writes.length = 0;
        await expect(commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME)).rejects.toThrow('STALE_REVISION:'); expect(env.writes).toEqual([]); expect(await env.state()).toEqual(before);
    });
});

const dgtExport = {
    version: 3,
    FOLDER: [{ ID: 10, TITLE: 'Work', ORDINAL: 0, COLOR: 0xff336699 }, { ID: 2, TITLE: 'Personal', ORDINAL: 0 }],
    CONTEXT: [{ ID: 1, TITLE: 'errands' }], TAG: [{ ID: 1, TITLE: 'deep' }],
    TASK: [
        { ID: 20, TYPE: 1, TITLE: 'Archived launch', FOLDER: 10, ORDINAL: 0, NOTE: 'Project support 日本語 🦉', CONTEXT: 1, TAG: [1], COLOR: 0xff112233, START_DATE: '2026-06-10', DUE_DATE: '2026-06-20', COMPLETED: '2026-06-15 12:00:00.000' },
        { ID: 3, TYPE: 1, TITLE: 'Active project', FOLDER: 2, ORDINAL: 0 },
        { ID: 101, TYPE: 0, TITLE: 'Project Inbox', PARENT: 20, STATUS: 0, CONTEXT: 1, TAG: [1], PRIORITY: 2, NOTE: 'Keep explicit inbox', DUE_DATE: '2026-06-18' },
        { ID: 102, TYPE: 0, TITLE: 'Project Next', PARENT: 3, STATUS: 1, STARRED: 1, DUE_DATE: '2026-06-18 15:00', DUE_TIME_SET: 1 },
        { ID: 103, TYPE: 2, TITLE: 'Packing list', FOLDER: 10, STATUS: 1 },
        { ID: 104, TYPE: 3, TITLE: 'Passport', PARENT: 103 },
        { ID: 105, TYPE: 3, TITLE: 'Tickets', PARENT: 103, COMPLETED: '2026-06-15 12:00:00.000' },
        { ID: 106, TYPE: 0, TITLE: 'Standalone review', STATUS: 0, START_DATE: '2026-06-17', DUE_DATE: '2026-06-18', REPEAT_NEW: 'Every 6 Weeks' },
        { ID: 107, TYPE: 9, TITLE: 'Legacy active', STATUS: 4, REPEAT_NEW: 'Last day of every month' },
        { ID: 108, TYPE: 3, TITLE: 'Orphan child', PARENT: 999 },
        { ID: 109, TYPE: 0, TITLE: 'Completed', STATUS: 1, COMPLETED: '2026-06-15 12:00:00.000' },
        { ID: 110, TYPE: 0, TITLE: 'Unsupported status', STATUS: 2 },
    ],
};
const dgtJson = JSON.stringify(dgtExport);
const dgtInput = (text = dgtJson): NativeBackupDocumentPrepareInput => ({ ...input(), mode: 'dgt', text: bytesToBase64(strToU8(text)), metadata: { ...metadata, fileName: 'DGT.json' } });

describe('native DGT JSON and ZIP prepared import', () => {
    it.each(['json','zip'] as const)('previews owned %s bytes with actual RN DGT counts/project lines/warnings; cancellation writes nothing', async (kind) => {
        const env = await open(); const before = await env.state(); const source = dgtInput();
        const bytes = kind === 'json' ? strToU8(dgtJson) : zipSync({ 'bad.json': strToU8('{bad'), 'backup.json': strToU8(dgtJson), 'readme.txt': strToU8('ignored'), 'nested.zip': strToU8('ignored') });
        source.text = bytesToBase64(bytes); if (kind === 'zip') source.metadata.fileName = 'DGT.zip';
        const parsed = parseImportSource('dgt', { bytes, fileName: source.metadata.fileName }); expect(parsed.valid).toBe(true);
        const preview = inspectNativeBackupDocument(source.text, source.metadata, t, 'dgt'); expect(preview.valid).toBe(true); expect(Object.keys(preview)).toHaveLength(7);
        expect(preview.title).toBe(t('settings.backupMobile.importDgtGtdData')); expect(preview.confirmLabel).toBe(t('settings.backupMobile.import'));
        expect(preview.summary).toContain(t('settings.backupMobile.dgtAreasWillBeCreated', { areaCount: 2 })); expect(preview.summary).toContain(t('settings.backupMobile.projectsWillBeCreated', { projectCount: 2 }));
        expect(preview.summary).toContain(t('settings.backupMobile.checklistItemsWillBePreserved', { checklistItemCount: 2 })); expect(preview.summary).toContain(t('settings.backupMobile.tasksWillStayOutsideProjects', { taskCount: 6 }));
        expect(preview.summary).toContain('• Work / Archived launch: 1'); expect(preview.summary).not.toContain(t('settings.backupMobile.importedTasksStayInInboxSoYouCanProcessThem'));
        for (const diagnostic of createImportDiagnostics(parsed.preview!.warnings, 'warning')) expect(preview.summary).toContain(formatImportDiagnostic(diagnostic, t));
        // Later provider bytes have no effect on this accepted preview or owned source.
        const other = inspectNativeBackupDocument(dgtInput('{}').text, source.metadata, t, 'dgt'); expect(other.valid).toBe(false); expect(preview.valid).toBe(true);
        expect(env.writes).toEqual([]); expect(await env.state()).toEqual(before);
    });
    it('preview retains optional areas and remaining count after first four projects', () => {
        const payload = { FOLDER: [{ ID: 1, TITLE: 'Area' }], TASK: [1,2,3,4,5].map((ID) => ({ ID, TYPE: 1, TITLE: `Project${ID}`, FOLDER: 1 })) };
        const source = dgtInput(JSON.stringify(payload)); const preview = inspectNativeBackupDocument(source.text, source.metadata, t, 'dgt'); expect(preview.valid).toBe(true);
        for (const ID of [1,2,3,4]) expect(preview.summary).toContain(`• Area / Project${ID}: 0`); expect(preview.summary).not.toContain('• Area / Project5:'); expect(preview.summary).toContain(t('settings.backupMobile.moreProjects', { projectCount: 1 }));
    });
    it.each(['json','zip'] as const)('freezes actual %s DGT rich policy/IDs against fresh current; cold replay preserves later edits', async (kind) => {
        const base = clone(original); base.people = [{ id: 'person', name: 'Taylor', createdAt: AT, updatedAt: AT, rev: 1 }]; base.tasks.push(task('reference', { status: 'reference' }));
        const env = await open(base); const source = dgtInput(); if (kind === 'zip') { source.text = bytesToBase64(zipSync({ 'backup.json': strToU8(dgtJson) })); source.metadata.fileName = 'DGT.zip'; }
        inspectNativeBackupDocument(source.text, source.metadata, t, 'dgt'); const latest = await env.adapter.getData(); latest.tasks.push(task('latest-dgt')); await env.adapter.saveData(latest); env.writes.length = 0; const before = await env.state();
        const prepared = await prepareNativeBackupDocument(env.adapter, source); const plan = JSON.parse(prepared.planJSON); expect(env.writes).toEqual([]); expect(await env.state()).toEqual(before);
        expect(plan.expectedCurrent.tasks.some((item: Task) => item.id === 'latest-dgt')).toBe(true); expect(validateBackupJson(prepared.recoveryJSON!).valid).toBe(true);
        expect(plan.reply.result).toMatchObject({ importedAreaCount: 2, importedChecklistItemCount: 2, importedProjectCount: 2, importedSectionCount: 0, importedTaskCount: 8, warnings: expect.any(Array) });
        expect(Object.keys(plan.reply)).toHaveLength(4); expect(Object.keys(plan.reply.result)).toHaveLength(6); expect(plan.reply.result).not.toHaveProperty('data'); expect(plan.reply.result).not.toHaveProperty('importedStandaloneTaskCount');
        const project = plan.data.projects.find((item: { title: string }) => item.title === 'Archived launch'); expect(project).toMatchObject({ status: 'archived', color: '#112233', startDate: '2026-06-10', dueDate: '2026-06-20' }); expect(project.supportNotes).toContain('Project support 日本語 🦉'); expect(project.supportNotes).toContain('Contexts: @errands'); expect(project.supportNotes).toContain('Tags: #deep');
        expect(plan.data.areas.map((item: { name: string }) => item.name)).toEqual(['Personal','Work']); expect(plan.data.areas[1].color).toBe('#336699'); expect(plan.data.projects.map((item: { title: string }) => item.title)).toEqual(['Active project','Archived launch']);
        const imported = plan.data.tasks.find((item: Task) => item.title === 'Project Inbox'); expect(imported).toMatchObject({ status: 'inbox', projectId: project.id, contexts: ['@errands'], tags: ['#deep'], priority: 'medium', dueDate: '2026-06-18', description: 'Keep explicit inbox' });
        expect(plan.data.tasks.find((item: Task) => item.title === 'Project Next')).toMatchObject({ status: 'next', priority: 'urgent', dueDate: '2026-06-18T15:00' });
        expect(plan.data.tasks.find((item: Task) => item.title === 'Standalone review')).toMatchObject({ status: 'inbox', startTime: '2026-06-17', dueDate: '2026-06-18', recurrence: { rule: 'weekly', rrule: 'FREQ=WEEKLY;INTERVAL=6' } });
        expect(plan.data.tasks.find((item: Task) => item.title === 'Packing list')).toMatchObject({ taskMode: 'list', checklist: [{ title: 'Passport', isCompleted: false }, { title: 'Tickets', isCompleted: true }] });
        expect(plan.data.tasks.find((item: Task) => item.title === 'Completed')).toMatchObject({ status: 'done', completedAt: '2026-06-15T12:00:00.000' });
        for (const title of ['Legacy active','Unsupported status','Orphan child']) expect(plan.data.tasks.find((item: Task) => item.title === title).status).toBe('inbox'); expect(plan.data.tasks.find((item: Task) => item.title === 'Legacy active').description).toContain('Original DGT repeat: Last day of every month');
        expect(plan.data.people).toEqual(plan.expectedCurrent.people); for (const id of ['reference','hidden','history']) expect(plan.data.tasks.find((item: Task) => item.id === id).status).toBe(base.tasks.find((item) => item.id === id)!.status);
        const parsed = parseImportSource('dgt', { bytes: strToU8(dgtJson), fileName: source.metadata.fileName }); const oracle = applyImportSource('dgt', plan.expectedCurrent, parsed.parsedData!);
        expect(plan.data.tasks.map((item: Task) => item.id)).toEqual(oracle.data.tasks.map((item) => item.id)); expect(plan.reply.result.warnings).toEqual(stored(oracle.result.warnings));
        const first = await commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME); const packing = plan.data.tasks.find((item: Task) => item.title === 'Packing list'); expect((await env.adapter.getData()).tasks.find((item) => item.id === packing.id)?.checklist).toEqual(packing.checklist);
        const later = await env.adapter.getData(); const changed = later.tasks.find((item) => item.id === imported.id)!; changed.title = 'Later DGT edit'; changed.rev! += 1; await env.adapter.saveData(later); const committed = await env.state();
        resetNativeRequestReceipts(); await loadNativeRequestReceipts(env.sql.client, { durableCommands: ['backupDocument'] }); const cold = new NativeReceiptSqliteAdapter(env.client, { rejectConcurrentWrites: true }); await cold.ensureSchema(); setStorageAdapter(cold); env.writes.length = 0;
        expect(await readNativeBackupDocumentOutcome(cold, reference, prepared.planJSON, NAME)).toEqual(first); expect(await commitNativeBackupDocument(cold, reference, prepared.planJSON, NAME)).toEqual(first); expect(env.writes).toEqual([]); expect(await env.state()).toEqual(committed);
        expect(useTaskStore.getState()._allTasks.find((item) => item.id === imported.id)?.title).toBe('Later DGT edit');
    });
    it('orders equal-ordinal numeric source IDs numerically before string conversion', async () => {
        const env = await open(); const source = dgtInput(JSON.stringify({ TASK: [{ ID: 10, TITLE: 'Ten', ORDINAL: 0 }, { ID: 2, TITLE: 'Two', ORDINAL: 0 }] }));
        const plan = JSON.parse((await prepareNativeBackupDocument(env.adapter, source)).planJSON); expect(plan.data.tasks.filter((item: Task) => !original.tasks.some((existing) => existing.id === item.id)).map((item: Task) => item.title)).toEqual(['Two','Ten']);
    });
    it.each(['edited','deleted'] as const)('retains shared DGT %s reimport IDs and history', async (condition) => {
        const env = await open(); const prepared = await prepareNativeBackupDocument(env.adapter, dgtInput()); const firstPlan = JSON.parse(prepared.planJSON); await commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME);
        const latest = await env.adapter.getData(); const ids = new Set(firstPlan.data.tasks.filter((item: Task) => !firstPlan.expectedCurrent.tasks.some((existing: Task) => existing.id === item.id)).map((item: Task) => item.id));
        for (const item of latest.tasks) if (ids.has(item.id)) { item.title = `Edited ${item.title}`; item.rev! += 1; if (condition === 'deleted') item.deletedAt = AT; }
        if (condition === 'deleted') { for (const item of latest.projects) item.deletedAt = AT; for (const item of latest.areas) item.deletedAt = AT; }
        await env.adapter.saveData(latest); env.writes.length = 0; const again = await prepareNativeBackupDocument(env.adapter, { ...dgtInput(), requestId: '22222222-2222-4222-8222-222222222222' }); const plan = JSON.parse(again.planJSON);
        expect(plan.reply.result).toMatchObject({ importedAreaCount: 0, importedChecklistItemCount: 0, importedProjectCount: 0, importedSectionCount: 0, importedTaskCount: 0 }); expect(plan.data.tasks.map((item: Task) => item.id)).toEqual(plan.expectedCurrent.tasks.map((item: Task) => item.id));
        for (const item of plan.data.tasks) if (ids.has(item.id)) { expect(item.title.startsWith('Edited ')).toBe(true); if (condition === 'deleted') expect(item.deletedAt).toBe(AT); } expect(env.writes).toEqual([]);
    });
    it('retains complete shared warnings and RN result counts/snapshot/Undo', async () => {
        const env = await open(); const prepared = await prepareNativeBackupDocument(env.adapter, dgtInput()); const reply = JSON.parse(prepared.planJSON).reply;
        const parsed = parseImportSource('dgt', { bytes: strToU8(dgtJson), fileName: dgtInput().metadata.fileName }); expect(reply.result.warnings).toEqual(stored(parsed.parsedData!.warnings));
        const model = buildNativeBackupDocumentResult(reply, t); expect(model.title).toBe(t('settings.backupMobile.importComplete')); expect(model.undoLabel).toBe(t('settings.undoImport')); expect(model.message).toContain(t('settings.backupMobile.importedTaskProjectAreaCounts', { taskCount: 8, projectCount: 2, areaCount: 2 })); expect(model.message).toContain(t('settings.backupMobile.checklistItemsPreserved', { checklistItemCount: 2 })); expect(model.message).toContain(NAME);
        for (const diagnostic of createImportDiagnostics(parsed.parsedData!.warnings, 'warning')) expect(model.message).toContain(formatImportDiagnostic(diagnostic, t));
    });
    it('DGT Undo restores exact pre-import snapshot and tombstones later edits without a second recovery', async () => {
        const env = await open(); const prepared = await prepareNativeBackupDocument(env.adapter, dgtInput()); await commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME);
        const later = await env.adapter.getData(); later.tasks.push(task('after-dgt')); later.tasks.find((item) => item.id === 'visible')!.title = 'Later'; await env.adapter.saveData(later);
        const id = '22222222-2222-4222-8222-222222222222'; const undo = await prepareNativeBackupDocument(env.adapter, { ...input(prepared.recoveryJSON!, 'restore'), requestId: id }); expect(undo.recoveryJSON).toBeNull(); await commitNativeBackupDocument(env.adapter, { ...reference, id, sha256: 'b'.repeat(64) }, undo.planJSON, NAME);
        const restored = await env.adapter.getData(); expect(restored.tasks.find((item) => item.id === 'visible')?.title).toBe('visible'); expect(restored.tasks.find((item) => item.id === 'after-dgt')?.deletedAt).toBeTruthy(); expect(restored.projects.filter((item) => !item.deletedAt)).toEqual([]);
    });
    it.each(['null','{}','Title,List Name\nPrivate,Private','{private','{"TASK":"Private"}'])('invalid DGT source %s returns localized refusal without adapter access', async (text) => {
        const env = await open(); const source = dgtInput(text); const read = vi.spyOn(env.adapter, 'getData'); const preview = inspectNativeBackupDocument(source.text, source.metadata, t, 'dgt'); expect(preview.valid).toBe(false); expect(preview.errorMessage).not.toContain('Private');
        await expect(prepareNativeBackupDocument(env.adapter, source)).rejects.toThrow('INVALID_INPUT:'); expect(read).not.toHaveBeenCalled(); expect(env.writes).toEqual([]);
    });
    it('ZIP uses first valid shared DGT JSON, retaining skipped-entry warnings', async () => {
        const env = await open(); const zip = zipSync({ 'bad.json': strToU8('{bad'), 'first.json': strToU8(dgtJson), 'second.json': strToU8(JSON.stringify({ TASK: [{ ID: 999, TITLE: 'Must not import' }] })), 'readme.txt': strToU8('ignored') });
        const prepared = await prepareNativeBackupDocument(env.adapter, { ...dgtInput(), text: bytesToBase64(zip), metadata: { ...metadata, fileName: 'DGT.zip' } }); const plan = JSON.parse(prepared.planJSON); expect(plan.data.tasks.some((item: Task) => item.title === 'Must not import')).toBe(false); expect(plan.reply.result.warnings).toEqual(expect.arrayContaining(stored(['1 DGT JSON file could not be parsed and was skipped.', '1 non-JSON file inside the DGT archive was skipped.']))); expect(env.writes).toEqual([]);
    });
    it.each(['TR==','TWF=','TQ=','====','eyJUQVNL\n','eyJUQVNL_'])('DGT rejects noncanonical binary transport %s before adapter access', async (text) => {
        const env = await open(); const read = vi.spyOn(env.adapter, 'getData'); await expect(prepareNativeBackupDocument(env.adapter, { ...dgtInput(), text })).rejects.toThrow('INVALID_INPUT:'); expect(read).not.toHaveBeenCalled(); expect(env.writes).toEqual([]);
    });
    it('DGT bounds transport to16MiB before allocation and retains shared8MiB text/ZIP limits', async () => {
        const env = await open(); const read = vi.spyOn(env.adapter, 'getData'); await expect(prepareNativeBackupDocument(env.adapter, { ...dgtInput(), text: 'A'.repeat(4 * Math.ceil((16 * 1024 * 1024 + 1) / 3)) })).rejects.toThrow('DGT source exceeds 16 MiB');
        const exact = 'A'.repeat(4 * Math.ceil(16 * 1024 * 1024 / 3) - 2) + '=='; await expect(prepareNativeBackupDocument(env.adapter, { ...dgtInput(), text: exact })).rejects.toThrow('INVALID_INPUT: Invalid backup document input'); expect(inspectNativeBackupDocument(exact, dgtInput().metadata, t, 'dgt').errorMessage).toBe(t('settings.importDiagnostics.limitExceeded'));
        const zip = bytesToBase64(zipSync({ 'too-large.json': new Uint8Array(8 * 1024 * 1024 + 1) })); expect(inspectNativeBackupDocument(zip, dgtInput().metadata, t, 'dgt').errorMessage).toBe(t('settings.importDiagnostics.limitExceeded')); expect(read).not.toHaveBeenCalled(); expect(env.writes).toEqual([]);
    }, 15_000);
    it('stores 40 renamed DGT projects as codes: no name reaches the reply, which stays small', async () => {
        const base = clone(original); const TASK = [];
        for (let index = 1; index <= 40; index += 1) { const name = `Project${index}-${'A'.repeat(1000)}`; base.projects.push({ ...createMockProject(`existing-${index}`, AT), title: name }); TASK.push({ ID: index, TITLE: name, TYPE: 1 }); }
        const env = await open(base); small(JSON.parse((await prepareNativeBackupDocument(env.adapter, dgtInput(JSON.stringify({ TASK })))).planJSON).reply); expect(env.writes).toEqual([]);
    });
    it.each(['extra','data','standalone','missing-area','negative','fraction','unsafe','warning','overflow','mode'] as const)('refuses malformed DGT result %s at every boundary before writes', async (fault) => {
        const env = await open(); const prepared = await prepareNativeBackupDocument(env.adapter, dgtInput()); const plan = JSON.parse(prepared.planJSON);
        if (fault === 'extra') plan.reply.added = 1; if (fault === 'data') plan.reply.result.data = plan.data; if (fault === 'standalone') plan.reply.result.importedStandaloneTaskCount = 0; if (fault === 'missing-area') delete plan.reply.result.importedAreaCount;
        if (fault === 'negative') plan.reply.result.importedTaskCount = -1; if (fault === 'fraction') plan.reply.result.importedSectionCount = 0.5; if (fault === 'unsafe') plan.reply.result.importedTaskCount = Number.MAX_SAFE_INTEGER + 1;
        if (fault === 'warning') plan.reply.result.warnings = [1]; if (fault === 'overflow') plan.reply.result.warnings = ['私'.repeat(23_000)]; if (fault === 'mode') plan.reply.operation = 'other'; const save = vi.spyOn(env.adapter, 'saveDocumentWithReceipt');
        expect(() => buildNativeBackupDocumentResult(plan.reply, t)).toThrow('INVALID_INPUT:'); await expect(commitNativeBackupDocument(env.adapter, reference, JSON.stringify(plan), NAME)).rejects.toThrow('INVALID_INPUT:'); await expect(readNativeBackupDocumentOutcome(env.adapter, reference, JSON.stringify(plan), NAME)).rejects.toThrow('INVALID_INPUT:'); expect(save).not.toHaveBeenCalled(); expect(env.writes).toEqual([]);
    });
    it('refuses otherwise-valid result mode mismatch with frozen plan before writes', async () => {
        const env = await open(); const prepared = await prepareNativeBackupDocument(env.adapter, dgtInput()); const plan = JSON.parse(prepared.planJSON); plan.reply.operation = 'ticktick'; expect(() => buildNativeBackupDocumentResult(plan.reply, t)).not.toThrow();
        await expect(commitNativeBackupDocument(env.adapter, reference, JSON.stringify(plan), NAME)).rejects.toThrow('INVALID_INPUT:'); await expect(readNativeBackupDocumentOutcome(env.adapter, reference, JSON.stringify(plan), NAME)).rejects.toThrow('INVALID_INPUT:'); expect(env.writes).toEqual([]);
    });
    it('refuses stale DGT frozen document after intervening durable change without writes', async () => {
        const env = await open(); const prepared = await prepareNativeBackupDocument(env.adapter, dgtInput()); const later = await env.adapter.getData(); later.tasks[0].title = 'Changed after DGT'; later.tasks[0].rev! += 1; await env.adapter.saveData(later); const before = await env.state(); env.writes.length = 0;
        await expect(commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME)).rejects.toThrow('STALE_REVISION:'); expect(env.writes).toEqual([]); expect(await env.state()).toEqual(before);
    });
});

const omniHeaders = ['Task ID','Type','Name','Status','Project','Context','Start Date','Planned Date','Due Date','Completion Date','Duration','Flagged','Notes','Tags'];
const omniCsv = csvFile(omniHeaders, [
    ['p1','Project','Test project','On Hold','','','2026-06-10','','2026-06-20','','','0','Project support 日本語 🦉','Work'],
    ['a1','Action','Plan sprint','Available','Test project','Errands','2026-06-17','2026-06-18','2026-06-19','','45m','1','Plan details','Ops'],
    ['a2','Action','Inbox capture','Available','','Calls','','','','','','0','Call contractor','Personal'],
    ['a3','Action','Completed','Completed','Test project','','','','','2026-06-15T12:00:00.000Z','','0','',''],
    ['a4','Action','Reference','Reference','Test project','','2026-06-17','','2026-06-18','','','1','Reference detail','Ops'],
    ['p2','Project','Archived project','Dropped','','','','','','','','0','Archived notes',''],
    ['a5','Action','Archived','Dropped','Archived project','','','','','','','0','',''],
    ['a6','Action','Waiting','Waiting','','','','','','','','0','',''],
    ['a7','Mystery','Someday','On Hold','','','','','','','','0','',''],
]);
const omniExport = {
    tasks: [
        { id: 'p1', name: 'Test project', note: 'Root project note', deferDate: '2026-06-10', plannedDate: '2026-06-11', projectId: 'p1', tagIds: ['tag1'] },
        { id: 'a1', name: 'Plan sprint', note: 'Plan details 日本語 🦉', deferDate: '2026-06-17', dueDate: '2026-06-19', plannedDate: '2026-06-18', flagged: true, projectId: 'p1', parentTaskId: 'p1', tagIds: ['tag1'], repetition: { unit: 'weekly', interval: 2, byDay: 'MO,WE', fromCompletion: true } },
        { id: 'child1', name: 'Confirm scope', parentTaskId: 'a1', projectId: 'p1', completed: true, completionDate: '2026-06-15T12:00:00.000Z' },
        { id: 'child2', name: 'Book room', note: 'Need room', dueDate: '2026-06-20', parentTaskId: 'a1', projectId: 'p1', tagIds: ['tag1'] },
        { id: 'child3', name: 'Share agenda', note: 'Email team', parentTaskId: 'child2', projectId: 'p1' },
        { id: 'a2', name: 'Inbox capture' },
        { id: 'a3', name: 'Completed', completionDate: '2026-06-15T12:00:00.000Z' },
        { id: 'a4', name: 'Reference', status: 'reference', flagged: true, dueDate: '2026-06-18', deferDate: '2026-06-17', repetition: 'daily', projectId: 'p1' },
        { id: 'a5', name: 'Archived', status: 'dropped' },
        { id: 'a6', name: 'Waiting', status: 'waiting' },
    ],
    projects: [{ id: 'p1', name: 'Test project', note: 'Metadata support', folderId: 'f1', folderName: 'Work', dueDate: '2026-06-20', status: 'on hold', tagIds: ['tag1'] }],
    tags: [{ id: 'tag1', name: 'Ops' }],
};
const omniInput = (text = JSON.stringify(omniExport)): NativeBackupDocumentPrepareInput => ({ ...input(), mode: 'omnifocus', text: bytesToBase64(strToU8(text)), metadata: { ...metadata, fileName: 'OmniFocus.json' } });
const omniSource = (kind: 'csv' | 'json' | 'zip') => {
    const source = omniInput(); let bytes: Uint8Array;
    if (kind === 'csv') { bytes = strToU8(omniCsv); source.metadata.fileName = 'OmniFocus.csv'; }
    else if (kind === 'zip') { bytes = zipSync({ 'OmniFocus.json': strToU8(JSON.stringify({ tasks: omniExport.tasks })), 'metadata.json': strToU8(JSON.stringify({ projects: omniExport.projects, tags: omniExport.tags })), 'readme.txt': strToU8('ignored'), 'nested.zip': strToU8('ignored') }); source.metadata.fileName = 'OmniFocus.zip'; }
    else bytes = strToU8(JSON.stringify(omniExport));
    source.text = bytesToBase64(bytes); return { source, bytes };
};

describe('native OmniFocus CSV/JSON/ZIP prepared import', () => {
    it.each(['csv','json','zip'] as const)('previews immutable %s with every actual RN OmniFocus count/copy/warning; cancellation writes nothing', async (kind) => {
        const env = await open(); const before = await env.state(); const { source, bytes } = omniSource(kind); const parsed = parseImportSource('omnifocus', { bytes, fileName: source.metadata.fileName }); expect(parsed.valid).toBe(true); const counts = parsed.preview!;
        const preview = inspectNativeBackupDocument(source.text, source.metadata, t, 'omnifocus'); expect(preview.valid).toBe(true); expect(Object.keys(preview)).toHaveLength(7); expect(preview.title).toBe(t('settings.backupMobile.importOmnifocusData')); expect(preview.confirmLabel).toBe(t('settings.backupMobile.import'));
        expect(preview.summary).toContain(t('settings.backupMobile.importTaskCountFromFile', { taskCount: counts.taskCount, fileName: counts.fileName })); expect(preview.summary).toContain(t('settings.backupMobile.projectsWillBeCreatedWhenNeeded', { projectCount: counts.projectCount }));
        if (counts.areaCount) expect(preview.summary).toContain(t('settings.backupMobile.omnifocusAreasWillBeCreated', { areaCount: counts.areaCount })); if (counts.checklistItemCount) expect(preview.summary).toContain(t('settings.backupMobile.nestedTasksWillBecomeChecklistItems', { taskCount: counts.checklistItemCount }));
        expect(preview.summary).toContain(t('settings.backupMobile.tasksWillStayOutsideProjects', { taskCount: counts.standaloneTaskCount })); expect(preview.summary).toContain(t('settings.backupMobile.importedTasksKeepOmnifocusNotesDatesTagsRecurrenceAndChecklist'));
        for (const project of counts.projects) expect(preview.summary).toContain(`• ${project.name}: ${project.taskCount}`); for (const diagnostic of createImportDiagnostics(counts.warnings, 'warning')) expect(preview.summary).toContain(formatImportDiagnostic(diagnostic, t));
        expect(inspectNativeBackupDocument(omniInput('{}').text, source.metadata, t, 'omnifocus').valid).toBe(false); expect(preview.valid).toBe(true); expect(env.writes).toEqual([]); expect(await env.state()).toEqual(before);
    });
    it('preview limits project examples to first four and retains remaining count', () => {
        const source = omniInput(csvFile(['Type','Name'], [1,2,3,4,5].map((value) => ['Project',`Project${value}`]))); const preview = inspectNativeBackupDocument(source.text, source.metadata, t, 'omnifocus'); expect(preview.valid).toBe(true);
        for (const value of [1,2,3,4]) expect(preview.summary).toContain(`• Project${value}: 0`); expect(preview.summary).not.toContain('• Project5:'); expect(preview.summary).toContain(t('settings.backupMobile.moreProjects', { projectCount: 1 }));
    });
    it.each(['csv','json','zip'] as const)('freezes actual %s policy and generated IDs from fresh durable data; cold exact replay preserves later edits', async (kind) => {
        const base = clone(original); base.people = [{ id: 'person', name: 'Taylor', createdAt: AT, updatedAt: AT, rev: 1 }]; const env = await open(base); const { source, bytes } = omniSource(kind);
        inspectNativeBackupDocument(source.text, source.metadata, t, 'omnifocus'); const latest = await env.adapter.getData(); latest.tasks.push(task('latest-omni')); await env.adapter.saveData(latest); env.writes.length = 0; const before = await env.state();
        const prepared = await prepareNativeBackupDocument(env.adapter, source); const plan = JSON.parse(prepared.planJSON); expect(env.writes).toEqual([]); expect(await env.state()).toEqual(before); expect(plan.expectedCurrent.tasks.some((item: Task) => item.id === 'latest-omni')).toBe(true); expect(validateBackupJson(prepared.recoveryJSON!).valid).toBe(true);
        const parsed = parseImportSource('omnifocus', { bytes, fileName: source.metadata.fileName }); const counts = parsed.preview!; const oracle = applyImportSource('omnifocus', plan.expectedCurrent, parsed.parsedData!);
        expect(plan.reply.result).toMatchObject({ importedAreaCount: counts.areaCount, importedChecklistItemCount: counts.checklistItemCount, importedProjectCount: counts.projectCount, importedSectionCount: 0, importedStandaloneTaskCount: counts.standaloneTaskCount, importedTaskCount: counts.taskCount, warnings: stored(oracle.result.warnings) }); expect(Object.keys(plan.reply)).toHaveLength(4); expect(Object.keys(plan.reply.result)).toHaveLength(7); expect(plan.reply.result).not.toHaveProperty('data');
        const imported = plan.data.tasks.find((item: Task) => item.title === 'Plan sprint'); expect(imported).toMatchObject({ status: 'inbox', priority: 'high', tags: ['#ops'], startTime: '2026-06-17', dueDate: '2026-06-19' }); expect(imported.description).toContain('Plan details'); expect(imported.description).toContain('Planned date in OmniFocus: 2026-06-18'); expect(imported.projectId).toBeTruthy();
        const project = plan.data.projects.find((item: { title: string }) => item.title === 'Test project'); expect(project).toMatchObject({ status: 'someday', startDate: '2026-06-10', dueDate: '2026-06-20' });
        if (kind === 'csv') { expect(imported.contexts).toEqual(['@Errands']); expect(imported.description).toContain('Estimated duration in OmniFocus: 45m'); expect(project.supportNotes).toContain('Project support 日本語 🦉'); expect(project.tagIds).toEqual(['#work']); expect(plan.data.projects.find((item: { title: string }) => item.title === 'Archived project').status).toBe('archived'); expect(plan.data.tasks.find((item: Task) => item.title === 'Someday').status).toBe('someday'); }
        else { expect(imported.checklist).toEqual([{ id: expect.any(String), title: 'Confirm scope', isCompleted: true }]); expect(imported.recurrence).toMatchObject({ rule: 'weekly', strategy: 'fluid', byDay: ['MO','WE'], rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE' }); expect(project.supportNotes).toContain('Root project note'); expect(project.supportNotes).toContain('Metadata support'); expect(project.areaId).toBe(plan.data.areas[0].id);
            expect(plan.data.tasks.find((item: Task) => item.title === 'Plan sprint -> Book room')).toMatchObject({ dueDate: '2026-06-20', tags: ['#ops'] }); expect(plan.data.tasks.find((item: Task) => item.title === 'Plan sprint -> Book room -> Share agenda').description).toContain('Original OmniFocus hierarchy: Plan sprint > Book room'); }
        expect(plan.data.tasks.find((item: Task) => item.title === 'Reference')).toMatchObject({ status: 'reference' }); for (const field of ['startTime','dueDate','priority','recurrence']) expect(plan.data.tasks.find((item: Task) => item.title === 'Reference')[field]).toBeUndefined();
        expect(plan.data.tasks.find((item: Task) => item.title === 'Completed')).toMatchObject({ status: 'done', completedAt: '2026-06-15T12:00:00.000Z' }); expect(plan.data.tasks.find((item: Task) => item.title === 'Archived').status).toBe('archived'); expect(plan.data.tasks.find((item: Task) => item.title === 'Waiting').status).toBe('waiting'); expect(plan.data.people).toEqual(plan.expectedCurrent.people);
        const first = await commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME); expect((await env.adapter.getData()).tasks.find((item) => item.id === imported.id)?.checklist).toEqual(imported.checklist);
        const later = await env.adapter.getData(); const changed = later.tasks.find((item) => item.id === imported.id)!; changed.title = 'Later OmniFocus edit'; changed.rev! += 1; await env.adapter.saveData(later); const committed = await env.state();
        resetNativeRequestReceipts(); await loadNativeRequestReceipts(env.sql.client, { durableCommands: ['backupDocument'] }); const cold = new NativeReceiptSqliteAdapter(env.client, { rejectConcurrentWrites: true }); await cold.ensureSchema(); setStorageAdapter(cold); env.writes.length = 0;
        expect(await readNativeBackupDocumentOutcome(cold, reference, prepared.planJSON, NAME)).toEqual(first); expect(await commitNativeBackupDocument(cold, reference, prepared.planJSON, NAME)).toEqual(first); expect(env.writes).toEqual([]); expect(await env.state()).toEqual(committed); expect(useTaskStore.getState()._allTasks.find((item) => item.id === imported.id)?.title).toBe('Later OmniFocus edit');
    });
    it.each(['live','deleted'] as const)('a genuinely new import mints fresh IDs while preserving %s prior imported records', async (condition) => {
        const env = await open(); const prepared = await prepareNativeBackupDocument(env.adapter, omniInput()); const firstPlan = JSON.parse(prepared.planJSON); await commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME);
        const firstIds = new Set(firstPlan.data.tasks.filter((item: Task) => !firstPlan.expectedCurrent.tasks.some((existing: Task) => existing.id === item.id)).map((item: Task) => item.id)); const latest = await env.adapter.getData();
        for (const item of latest.tasks) if (firstIds.has(item.id)) { item.title = `Edited ${item.title}`; item.rev! += 1; if (condition === 'deleted') item.deletedAt = AT; } if (condition === 'deleted') { for (const item of latest.projects) item.deletedAt = AT; for (const item of latest.areas) item.deletedAt = AT; }
        await env.adapter.saveData(latest); env.writes.length = 0; const id = '22222222-2222-4222-8222-222222222222'; const again = await prepareNativeBackupDocument(env.adapter, { ...omniInput(), requestId: id }); const plan = JSON.parse(again.planJSON); expect(plan.reply.result.importedTaskCount).toBe(firstPlan.reply.result.importedTaskCount); expect(plan.reply.result.importedProjectCount).toBe(1); expect(plan.reply.result.importedAreaCount).toBe(1);
        const newTasks = plan.data.tasks.filter((item: Task) => !plan.expectedCurrent.tasks.some((existing: Task) => existing.id === item.id)); expect(newTasks).toHaveLength(firstPlan.reply.result.importedTaskCount); for (const item of newTasks) expect(firstIds.has(item.id)).toBe(false);
        for (const item of plan.data.tasks) if (firstIds.has(item.id)) { expect(item.title.startsWith('Edited ')).toBe(true); if (condition === 'deleted') expect(item.deletedAt).toBe(AT); } expect(env.writes).toEqual([]);
        await commitNativeBackupDocument(env.adapter, { ...reference, id, sha256: 'b'.repeat(64) }, again.planJSON, NAME); const savedIds = (await env.adapter.getData()).tasks.map((item) => item.id); env.writes.length = 0;
        await commitNativeBackupDocument(env.adapter, { ...reference, id, sha256: 'b'.repeat(64) }, again.planJSON, NAME); expect((await env.adapter.getData()).tasks.map((item) => item.id)).toEqual(savedIds); expect(env.writes).toEqual([]);
    });
    it.each(['csv','json','zip'] as const)('uses exact RN %s result counts, optional fields, all execution warnings and snapshot Undo', async (kind) => {
        const env = await open(); const { source } = omniSource(kind); const reply = JSON.parse((await prepareNativeBackupDocument(env.adapter, source)).planJSON).reply; const result = reply.result;
        const model = buildNativeBackupDocumentResult(reply, t); expect(model.title).toBe(t('settings.backupMobile.importComplete')); expect(model.undoLabel).toBe(t('settings.undoImport')); expect(model.message).toContain(t('settings.backupMobile.importedTaskProjectCounts', { taskCount: result.importedTaskCount, projectCount: result.importedProjectCount }));
        if (result.importedAreaCount) expect(model.message).toContain(t('settings.backupMobile.omnifocusAreasCreated', { areaCount: result.importedAreaCount })); if (result.importedChecklistItemCount) expect(model.message).toContain(t('settings.backupMobile.nestedTasksBecameChecklistItems', { taskCount: result.importedChecklistItemCount })); expect(model.message).toContain(t('settings.backupMobile.tasksStayedOutsideProjects', { taskCount: result.importedStandaloneTaskCount })); expect(model.message).toContain(NAME);
        // Stored codes read back as RN's count lines.
        for (const token of result.warnings as string[]) { const [code, count] = token.split(':'); expect(model.message).toContain(formatImportDiagnostic({ code: code as 'adjusted-records', params: { count: Number(count) }, severity: 'warning' }, t)); }
    });
    it('accepts shared UTF16LE CSV bytes through unchanged binary transport', async () => {
        const bytes = new Uint8Array(2 + omniCsv.length * 2); bytes[0] = 0xff; bytes[1] = 0xfe; for (let index = 0; index < omniCsv.length; index += 1) { bytes[2 + index * 2] = omniCsv.charCodeAt(index) & 0xff; bytes[3 + index * 2] = omniCsv.charCodeAt(index) >> 8; }
        const env = await open(); const source = { ...omniInput(), text: bytesToBase64(bytes), metadata: { ...metadata, fileName: 'UTF16.csv' } }; expect(inspectNativeBackupDocument(source.text, source.metadata, t, 'omnifocus').valid).toBe(true); const plan = JSON.parse((await prepareNativeBackupDocument(env.adapter, source)).planJSON); expect(plan.data.tasks.some((item: Task) => item.title === 'Plan sprint')).toBe(true); expect(env.writes).toEqual([]);
    });
    it('OmniFocus Undo restores exact pre-import snapshot and tombstones later edits without a second recovery', async () => {
        const env = await open(); const prepared = await prepareNativeBackupDocument(env.adapter, omniInput()); await commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME);
        const later = await env.adapter.getData(); later.tasks.push(task('after-omni')); later.tasks.find((item) => item.id === 'visible')!.title = 'Later'; await env.adapter.saveData(later);
        const id = '22222222-2222-4222-8222-222222222222'; const undo = await prepareNativeBackupDocument(env.adapter, { ...input(prepared.recoveryJSON!, 'restore'), requestId: id }); expect(undo.recoveryJSON).toBeNull(); await commitNativeBackupDocument(env.adapter, { ...reference, id, sha256: 'b'.repeat(64) }, undo.planJSON, NAME);
        const restored = await env.adapter.getData(); expect(restored.tasks.find((item) => item.id === 'visible')?.title).toBe('visible'); expect(restored.tasks.find((item) => item.id === 'after-omni')?.deletedAt).toBeTruthy(); expect(restored.projects.filter((item) => !item.deletedAt)).toEqual([]);
    });
    it.each(['{}','{"tasks":[]}','Title,List Name\nPrivate,Private','{private'])('invalid OmniFocus source %s returns localized refusal without adapter access', async (text) => {
        const env = await open(); const source = omniInput(text); const read = vi.spyOn(env.adapter, 'getData'); const preview = inspectNativeBackupDocument(source.text, source.metadata, t, 'omnifocus'); expect(preview.valid).toBe(false); expect(preview.errorMessage).not.toContain('Private'); await expect(prepareNativeBackupDocument(env.adapter, source)).rejects.toThrow('INVALID_INPUT:'); expect(read).not.toHaveBeenCalled(); expect(env.writes).toEqual([]);
    });
    it.each(['TR==','TWF=','TQ=','====','VHlwZSxO\n','VHlwZSxO_'])('OmniFocus rejects noncanonical binary transport %s before adapter access', async (text) => {
        const env = await open(); const read = vi.spyOn(env.adapter, 'getData'); await expect(prepareNativeBackupDocument(env.adapter, { ...omniInput(), text })).rejects.toThrow('INVALID_INPUT:'); expect(read).not.toHaveBeenCalled(); expect(env.writes).toEqual([]);
    });
    it('OmniFocus bounds binary input to16MiB before allocation and retains shared8MiB text/ZIP limits', async () => {
        const env = await open(); const read = vi.spyOn(env.adapter, 'getData'); await expect(prepareNativeBackupDocument(env.adapter, { ...omniInput(), text: 'A'.repeat(4 * Math.ceil((16 * 1024 * 1024 + 1) / 3)) })).rejects.toThrow('OmniFocus source exceeds 16 MiB');
        const exact = 'A'.repeat(4 * Math.ceil(16 * 1024 * 1024 / 3) - 2) + '=='; await expect(prepareNativeBackupDocument(env.adapter, { ...omniInput(), text: exact })).rejects.toThrow('INVALID_INPUT: Invalid backup document input'); expect(inspectNativeBackupDocument(exact, omniInput().metadata, t, 'omnifocus').errorMessage).toBe(t('settings.importDiagnostics.limitExceeded'));
        const zip = bytesToBase64(zipSync({ 'too-large.json': new Uint8Array(8 * 1024 * 1024 + 1) })); expect(inspectNativeBackupDocument(zip, omniInput().metadata, t, 'omnifocus').errorMessage).toBe(t('settings.importDiagnostics.limitExceeded')); expect(read).not.toHaveBeenCalled(); expect(env.writes).toEqual([]);
    }, 15_000);
    it('stores 40 renamed OmniFocus projects as codes: no name reaches the reply, which stays small', async () => {
        const base = clone(original); const rows: string[][] = []; for (let index = 0; index < 40; index += 1) { const name = `Project${index}-${'A'.repeat(1000)}`; base.projects.push({ ...createMockProject(`existing-${index}`, AT), title: name }); rows.push(['Project', name]); }
        const env = await open(base); small(JSON.parse((await prepareNativeBackupDocument(env.adapter, omniInput(csvFile(['Type','Name'], rows)))).planJSON).reply); expect(env.writes).toEqual([]);
    });
    it.each(['extra','data','missing-standalone','negative','fraction','unsafe','warning','overflow','mode'] as const)('refuses malformed OmniFocus result %s at every boundary before writes', async (fault) => {
        const env = await open(); const prepared = await prepareNativeBackupDocument(env.adapter, omniInput()); const plan = JSON.parse(prepared.planJSON);
        if (fault === 'extra') plan.reply.added = 1; if (fault === 'data') plan.reply.result.data = plan.data; if (fault === 'missing-standalone') delete plan.reply.result.importedStandaloneTaskCount; if (fault === 'negative') plan.reply.result.importedTaskCount = -1; if (fault === 'fraction') plan.reply.result.importedStandaloneTaskCount = 0.5; if (fault === 'unsafe') plan.reply.result.importedTaskCount = Number.MAX_SAFE_INTEGER + 1;
        if (fault === 'warning') plan.reply.result.warnings = [1]; if (fault === 'overflow') plan.reply.result.warnings = ['私'.repeat(23_000)]; if (fault === 'mode') plan.reply.operation = 'other'; const save = vi.spyOn(env.adapter, 'saveDocumentWithReceipt');
        expect(() => buildNativeBackupDocumentResult(plan.reply, t)).toThrow('INVALID_INPUT:'); await expect(commitNativeBackupDocument(env.adapter, reference, JSON.stringify(plan), NAME)).rejects.toThrow('INVALID_INPUT:'); await expect(readNativeBackupDocumentOutcome(env.adapter, reference, JSON.stringify(plan), NAME)).rejects.toThrow('INVALID_INPUT:'); expect(save).not.toHaveBeenCalled(); expect(env.writes).toEqual([]);
    });
    it('refuses valid CSV-shaped reply that mismatches frozen OmniFocus plan mode before writes', async () => {
        const env = await open(); const prepared = await prepareNativeBackupDocument(env.adapter, omniInput()); const plan = JSON.parse(prepared.planJSON); plan.reply.operation = 'csv'; expect(() => buildNativeBackupDocumentResult(plan.reply, t)).not.toThrow(); await expect(commitNativeBackupDocument(env.adapter, reference, JSON.stringify(plan), NAME)).rejects.toThrow('INVALID_INPUT:'); await expect(readNativeBackupDocumentOutcome(env.adapter, reference, JSON.stringify(plan), NAME)).rejects.toThrow('INVALID_INPUT:'); expect(env.writes).toEqual([]);
    });
    it('refuses stale OmniFocus frozen plan after intervening durable change without writes', async () => {
        const env = await open(); const prepared = await prepareNativeBackupDocument(env.adapter, omniInput()); const later = await env.adapter.getData(); later.tasks[0].title = 'Changed after OmniFocus'; later.tasks[0].rev! += 1; await env.adapter.saveData(later); const before = await env.state(); env.writes.length = 0; await expect(commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME)).rejects.toThrow('STALE_REVISION:'); expect(env.writes).toEqual([]); expect(await env.state()).toEqual(before);
    });
});

/**
 * Pass D1c: prepare's plan and recovery snapshot, frozen from HEAD (f5d7d792a) before the plan is written in parts and the
 * copies are cut. A host that passes no writer (iOS) must keep getting these exact bytes. `MINDWTR_WRITE_PLAN_FIXTURE=1`
 * rewrites the fixture; only a deliberate format change may do that.
 * The 2026-10-20 recapture on 3d10ce615 updates only four importer plan digests for shared taxonomy retention:
 * deleting only data.settings.taxonomy reproduces each old plan's exact bytes/hash. All recovery and other mode bytes stay fixed.
 */
describe('native backup prepare output stays byte-identical (D1c parity fixture)', () => {
    const FIXTURE = new URL('./native-backup-plan-parity.fixtures.json', import.meta.url);
    const digest = (text: string | null) => text === null ? null
        : { bytes: strToU8(text).length, sha256: createHash('sha256').update(text, 'utf8').digest('hex') };
    const cases: [string, () => NativeBackupDocumentPrepareInput][] = [
        ['merge', () => input()], ['replace', () => input(undefined, 'replace')], ['restore', () => input(undefined, 'restore')],
        ['csv', () => csvInput()], ['todoist', () => todoistInput()], ['ticktick', () => ticktickInput()],
        ['dgt', () => dgtInput()], ['omnifocus', () => omniInput()],
    ];
    it('gives every mode the frozen plan and recovery bytes', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const outputs: Record<string, unknown> = {};
        try {
            for (const [mode, make] of cases) {
                vi.setSystemTime(new Date(AT));
                // Importers name new rows with random UUIDs: a counter per mode makes the plan repeatable.
                let next = 0;
                vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() =>
                    `00000000-0000-4000-8000-${String(next++).padStart(12, '0')}` as ReturnType<typeof crypto.randomUUID>);
                const env = await open();
                const prepared = await prepareNativeBackupDocument(env.adapter, make());
                outputs[mode] = { plan: digest(prepared.planJSON), recovery: digest(prepared.recoveryJSON) };
            }
        } finally { vi.useRealTimers(); }
        if (process.env.MINDWTR_WRITE_PLAN_FIXTURE === '1') writeFileSync(FIXTURE, `${JSON.stringify(outputs, null, 2)}\n`);
        expect(existsSync(FIXTURE)).toBe(true);
        expect(outputs).toEqual(JSON.parse(readFileSync(FIXTURE, 'utf8')));
    }, 60_000);
    it('no import policy changes the library it applies to: every mode prepares the same plan from a deep-frozen read', async () => {
        const deepFreeze = <T,>(value: T): T => {
            if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(deepFreeze); }
            return value;
        };
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            for (const [mode, make] of cases) {
                const seeds = () => { let next = 0; vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() =>
                    `00000000-0000-4000-8000-${String(next++).padStart(12, '0')}` as ReturnType<typeof crypto.randomUUID>); };
                vi.setSystemTime(new Date(AT)); seeds();
                const plain = await prepareNativeBackupDocument((await open()).adapter, make());
                vi.setSystemTime(new Date(AT)); seeds();
                const env = await open(); const read = env.adapter.getData.bind(env.adapter);
                vi.spyOn(env.adapter, 'getData').mockImplementation(async (options) => deepFreeze(await read(options)));
                await expect(prepareNativeBackupDocument(env.adapter, make()), mode).resolves.toEqual(plain);
            }
        } finally { vi.useRealTimers(); }
    }, 120_000);
    it.each([false, true])('a sink receives the same recovery text and plan bytes, in parts (admission %s)', async (admitted) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            for (const [, make] of cases) {
                const source = make();
                const withAdmission = admitted ? { ...source, admission: { sourceBytes: 1, maxTransferBytes: 512 * 1024 * 1024 } } : source;
                const seeds = () => { let next = 0; vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() =>
                    `00000000-0000-4000-8000-${String(next++).padStart(12, '0')}` as ReturnType<typeof crypto.randomUUID>); };
                vi.setSystemTime(new Date(AT)); seeds();
                const whole = await prepareNativeBackupDocument((await open()).adapter, clone(withAdmission));
                vi.setSystemTime(new Date(AT)); seeds();
                const recovery: string[] = []; const parts: string[] = [];
                const written = await prepareNativeBackupDocument((await open()).adapter, clone(withAdmission),
                    { recovery: (text) => recovery.push(text), plan: (part) => parts.push(part) });
                expect(written).toEqual({ written: true, recovery: whole.recoveryJSON !== null, ...('undo' in whole ? { undo: whole.undo } : {}) });
                expect(recovery).toEqual(whole.recoveryJSON === null ? [] : [whole.recoveryJSON]);
                expect(parts.length).toBeGreaterThan(2);
                expect(parts.join('')).toBe(whole.planJSON);
                expect(JSON.stringify(JSON.parse(whole.planJSON))).toBe(whole.planJSON);
                // An admitted plan freezes a bound: the snapshot restore's library bound, else (pass b) its Undo's room.
                const plan = JSON.parse(whole.planJSON);
                expect('maxLibraryBytes' in plan || 'undoLibraryBytes' in plan).toBe(admitted);
            }
        } finally { vi.useRealTimers(); }
    }, 120_000);
});

/** Pass D1c cuts a and f-h: what the native transfer hands over is not kept alive by core while the commit writes and reloads. */
describe('native backup prepare and commit let their documents go (D1c)', () => {
    setFlagsFromString('--expose_gc');
    const gc = runInNewContext('gc') as () => void;
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    it('a sink takes the source text once parsed; without a sink the input is untouched', async () => {
        const handed = input(); const kept = input();
        await prepareNativeBackupDocument((await open()).adapter, handed, { recovery: () => undefined, plan: () => undefined });
        expect(handed.text).toBe('');
        await prepareNativeBackupDocument((await open()).adapter, kept);
        expect(kept.text).toBe(input().text);
    });

    it('a sink\'s own failure is the answer, word for word', async () => {
        const refusal = new Error('TOO_LARGE: The prepared plan exceeds the transfer limit');
        await expect(prepareNativeBackupDocument((await open()).adapter, input(), { recovery: () => undefined, plan: () => { throw refusal; } }))
            .rejects.toBe(refusal);
        await expect(prepareNativeBackupDocument((await open()).adapter, input(), { recovery: () => { throw refusal; }, plan: () => undefined }))
            .rejects.toBe(refusal);
    });

    it('a plan source is read once, and the plan, its baseline and the stale check\'s read are gone before the reload', async () => {
        const env = await open();
        const prepared = await prepareNativeBackupDocument(env.adapter, input());
        const source = { taken: 0, take() { this.taken += 1; return prepared.planJSON; } };
        const refs: Record<string, WeakRef<object>> = {};
        const save = env.adapter.saveDocumentWithReceipt.bind(env.adapter);
        // Plain wrappers, not spies: a spy records its calls' arguments and results, which would keep them alive.
        env.adapter.saveDocumentWithReceipt = async (document) => {
            refs.expected = new WeakRef(document.expectedCurrent); refs.data = new WeakRef(document.data);
            return save(document);
        };
        // Every full read runs the adapter's locked body (getDataNow): the stale check inside the document save's own lock
        // hold, then the store reload through the public getData.
        const reader = env.adapter as unknown as { getDataNow: SqliteAdapter['getData'] };
        const read = reader.getDataNow.bind(env.adapter);
        let reads = 0; let alive: Record<string, boolean> | null = null;
        reader.getDataNow = async (options) => {
            reads += 1;
            if (reads === 2) {
                // The reload's read: before it builds the new library, nothing of the old operation may still be reachable.
                await settle(); gc(); await settle(); gc();
                alive = Object.fromEntries(Object.entries(refs).map(([name, ref]) => [name, ref.deref() !== undefined]));
            }
            const data = await read(options);
            if (reads === 1) refs.current = new WeakRef(data);
            return data;
        };
        // While the document is written (at its COMMIT), both baselines are already gone; the data being written is not.
        let writing: Record<string, boolean> | null = null;
        env.hooks.run = async (statement) => {
            if (statement !== 'COMMIT' || writing) return;
            await settle(); gc(); await settle(); gc();
            writing = Object.fromEntries(Object.entries(refs).map(([name, ref]) => [name, ref.deref() !== undefined]));
        };
        await commitNativeBackupDocument(env.adapter, reference, source, NAME);
        expect(source.taken).toBe(1);
        expect(writing).toEqual({ expected: false, data: true, current: false });
        expect(alive).toEqual({ expected: false, data: false, current: false });
    });
});

/**
 * Pass D1c against main's sync write gate (0c277ee77): a sync cycle runs in the same document lane as the commit
 * (mobile-sync-service.ts runs each cycle through runSerializedSyncDocumentOperation), so no sync commits and publishes
 * between the commit's COMMIT and its store reload.
 */
describe('a sync cycle waits behind a native backup commit and its reload (D1c, sync write gate)', () => {
    it('starts only after the commit reloaded the store', async () => {
        const env = await open();
        const prepared = await prepareNativeBackupDocument(env.adapter, input());
        const events: string[] = [];
        // The stale check (read 1) and the reload (read 2) both run the adapter's locked body (getDataNow).
        const reader = env.adapter as unknown as { getDataNow: SqliteAdapter['getData'] };
        const read = reader.getDataNow.bind(env.adapter);
        let reads = 0;
        let reloadStarted!: () => void;
        const reloading = new Promise<void>((resolve) => { reloadStarted = resolve; });
        reader.getDataNow = async (options) => {
            reads += 1;
            if (reads === 2) {
                events.push('reload');
                reloadStarted();
                await new Promise((resolve) => setTimeout(resolve, 50));
                const data = await read(options);
                events.push('reloaded');
                return data;
            }
            return read(options);
        };
        const commit = commitNativeBackupDocument(env.adapter, reference, prepared.planJSON, NAME);
        await reloading;
        const sync = runSerializedSyncDocumentOperation(async () => { events.push('sync'); });
        await Promise.all([commit, sync]);
        expect(events).toEqual(['reload', 'reloaded', 'sync']);
    });
});
