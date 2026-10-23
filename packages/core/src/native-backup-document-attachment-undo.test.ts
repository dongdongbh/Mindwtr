// Follow-up restore-undo-attachment-bytes (2026-10-19): a restore, then a sync's attachment cleanup, then the restore's Undo
// must not bring an attachment back live as available when the cleanup deleted its local file. While the Undo may still be
// taken, cleanup leaves the files (and remote copies) of the Undo's recovery snapshot alone; once it is gone, cleanup runs as
// before, and a restore or Undo that lands marks a live file attachment whose local file is gone as 'missing'.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    findLiveAttachmentResourceReferences,
    hasFreshAttachmentCleanupWork,
    holdRestoreUndoAttachments,
    resetRestoreUndoAttachmentHold,
    runAttachmentCleanupLifecycle,
} from './attachment-cleanup';
import type { LocalAttachmentPresence } from './attachment-transfer';
import { serializeBackupData } from './backup-transfer';
import { runDataTransferTransaction, runDataTransferTransactionWithoutSnapshot } from './data-transfer-transaction';
import { commitNativeBackupDocument, holdNativeBackupUndoAttachments, prepareNativeBackupDocument, type NativeBackupOperationReference } from './native-backup-document';
import { loadNativeRequestReceipts, NativeReceiptSqliteAdapter, resetNativeRequestReceipts } from './native-request-receipts';
import { openScratchSqlite } from './screen-parity.replay';
import { SqliteAdapter } from './sqlite-adapter';
import { resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Attachment, Task } from './types';

const AT = '2026-10-04T12:00:00.000Z';
const NOW = Date.parse('2026-10-19T12:00:00.000Z');
const NAME = 'data.2026-10-04T12-00-00.000.snapshot.json';
const metadata = { fileName: 'owned.json', lastModified: Date.parse(AT), appVersion: '1.3.4' };
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const task = (id: string, extra: Partial<Task> = {}): Task => ({ id, title: id, status: 'next', contexts: [], tags: [],
    createdAt: AT, updatedAt: AT, rev: 1, ...extra });
const FILE_URI = 'file:///data/user/0/app/files/attachments/a2doc.pdf';
const CLOUD_KEY = 'attachments/a2doc.pdf';
const attachment: Attachment = { id: 'att-1', kind: 'file', title: 'a2doc.pdf', uri: FILE_URI, mimeType: 'application/pdf',
    cloudKey: CLOUD_KEY, localStatus: 'available', createdAt: AT, updatedAt: AT };
const libraryWith = (item: Attachment, other: Partial<Task> = {}): AppData => ({
    tasks: [task('with-file', { attachments: [item] }), task('other', other)],
    projects: [], sections: [], areas: [], people: [], settings: { language: 'en' } });

const resources: { close: () => void; directory: string }[] = [];
const temporaryRoot = fileURLToPath(new URL('../../../.orchestrator/tmp/', import.meta.url));
async function open(data: AppData) {
    mkdirSync(temporaryRoot, { recursive: true });
    const directory = mkdtempSync(join(temporaryRoot, 'attachment-undo-'));
    const sql = openScratchSqlite(join(directory, 'document.sqlite'));
    resources.push({ close: sql.close, directory });
    await new SqliteAdapter(sql.client).saveData(clone(data));
    resetNativeRequestReceipts();
    await loadNativeRequestReceipts(sql.client, { durableCommands: ['backupDocument'] });
    const adapter = new NativeReceiptSqliteAdapter(sql.client, { rejectConcurrentWrites: true });
    setStorageAdapter(adapter);
    useTaskStore.setState({ persistenceFailure: null, isLoading: false, editLockCount: 0, error: null,
        tasks: [], projects: [], sections: [], areas: [], people: [], settings: {},
        _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        _tasksById: new Map(), _projectsById: new Map(), _sectionsById: new Map(), _areasById: new Map(), _peopleById: new Map(),
        lastDataChangeAt: 0 });
    await useTaskStore.getState().fetchData({ throwOnError: true, recoveryLoad: true });
    return adapter;
}
afterEach(() => {
    vi.useRealTimers();
    resetRestoreUndoAttachmentHold();
    resetForTests(); resetNativeRequestReceipts();
    for (const resource of resources.splice(0).reverse()) { resource.close(); rmSync(resource.directory, { recursive: true, force: true }); }
});

const reference = (id: string, sha: string): NativeBackupOperationReference => ({ id, sha256: sha.repeat(64), byteCount: 420 });
const findAttachment = (data: AppData) => data.tasks.flatMap((item) => item.attachments ?? []).find((item) => item.id === attachment.id);
const restoredTasks = (item: Attachment): [string, Task[]][] => [
    ['the restored backup lacks the task', [task('other')]],
    ['the restored backup keeps the task without the attachment', [task('with-file', { rev: 2 }), task('other')]],
    ['the restored backup has the attachment deleted', [task('with-file', { rev: 2, attachments: [{ ...item, deletedAt: AT, updatedAt: AT }] }), task('other')]],
];
const withoutCloudKey: Attachment = { ...attachment, cloudKey: undefined };
const cases = [
    ...restoredTasks(attachment).map(([label, tasks]) => [label, attachment, tasks] as const),
    ...restoredTasks(withoutCloudKey).map(([label, tasks]) => [`${label}, no cloudKey`, withoutCloudKey, tasks] as const),
];
const collectDeletes = (deleted: string[]) => async (target: Attachment) => { if (target.uri) deleted.push(target.uri); };

/**
 * Restore [tasks] over a library holding [item], run a sync's cleanup a day later, then take the restore's Undo. [between]: the
 * process lives on (`held`), ends (`process-ended`), or ends and the next start shows the leftover result's Undo (`leftover`,
 * Android), which holds the files again from the recovery snapshot.
 */
async function restoreCleanupUndo(item: Attachment, tasks: readonly Task[], between: 'held' | 'process-ended' | 'leftover') {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    const library = libraryWith(item);
    const adapter = await open(library);
    const deleted: string[] = [];
    const remoteDeletes: string[] = [];
    const presence = async (uri: string): Promise<LocalAttachmentPresence> => (deleted.includes(uri) ? 'confirmed-not-found' : 'present');
    const replaceId = '11111111-1111-4111-8111-111111111111';
    const replaced = await prepareNativeBackupDocument(adapter, { requestId: replaceId, mode: 'replace', snapshotName: NAME,
        text: serializeBackupData({ ...clone(library), tasks: clone([...tasks]) }), metadata: clone(metadata) });
    await commitNativeBackupDocument(adapter, reference(replaceId, 'a'), replaced.planJSON, NAME, { getLocalAttachmentPresence: presence });

    // The next sync's cleanup (mobile-attachment-cleanup.ts wires deleteLocalAttachment to the device's file delete).
    // The hold has no end in time: an iOS result panel or a confirm question can wait for as long as the app runs.
    vi.setSystemTime(NOW + 24 * 60 * 60 * 1000);
    if (between !== 'held') resetRestoreUndoAttachmentHold();
    if (between === 'leftover') holdNativeBackupUndoAttachments(replaced.recoveryJSON!, NAME);
    const restored = await adapter.getData();
    const freshWork = hasFreshAttachmentCleanupWork(restored);
    const cleaned = await runAttachmentCleanupLifecycle({ appData: restored, deleteLocalAttachment: collectDeletes(deleted),
        deleteRemoteAttachment: async (target) => { remoteDeletes.push(target.cloudKey); } });
    await adapter.saveData(cleaned.appData);

    // The restore's Undo: a snapshot restore of the recovery snapshot taken before the restore.
    const undoId = '22222222-2222-4222-8222-222222222222';
    const undo = await prepareNativeBackupDocument(adapter, { requestId: undoId, mode: 'restore', snapshotName: NAME,
        text: replaced.recoveryJSON!, metadata: clone(metadata) });
    await commitNativeBackupDocument(adapter, reference(undoId, 'b'), undo.planJSON, NAME, { getLocalAttachmentPresence: presence });
    return { after: findAttachment(await adapter.getData()), deleted, remoteDeletes, freshWork,
        restoredRecord: findAttachment(restored), cleanedRecord: findAttachment(cleaned.appData) };
}

describe('a restore, a sync\'s attachment cleanup, then the restore\'s Undo', () => {
    it.each(cases)('keeps the Undo\'s file and remote copy while the Undo may be taken (%s)', async (_label, item, tasks) => {
        const result = await restoreCleanupUndo(item, tasks, 'held');
        expect(result.deleted).toEqual([]);
        expect(result.remoteDeletes).toEqual([]);
        // A held tombstone is no reason to run cleanup ahead of its daily interval, and cleanup leaves it unprocessed.
        expect(result.freshWork).toBe(false);
        expect(result.cleanedRecord).toEqual(result.restoredRecord);
        expect(result.after).toMatchObject({ localStatus: 'available' });
        expect(result.after?.deletedAt ?? null).toBeNull();
    });

    it.each(cases)('keeps them when the next start offers the leftover result\'s Undo again (Android, %s)', async (_label, item, tasks) => {
        const result = await restoreCleanupUndo(item, tasks, 'leftover');
        expect(result.freshWork).toBe(false);
        expect(result.deleted).toEqual([]);
        expect(result.remoteDeletes).toEqual([]);
        expect(result.after).toMatchObject({ localStatus: 'available' });
    });

    it.each(cases)('cleans up once the process ended, and the Undo then marks the attachment missing (%s)', async (label, item, tasks) => {
        const result = await restoreCleanupUndo(item, tasks, 'process-ended');
        expect(result.after?.deletedAt ?? null).toBeNull();
        if (label.startsWith('the restored backup lacks the task')) {
            // Nothing in the restored library names the attachment, so cleanup has nothing to delete.
            expect(result.deleted).toEqual([]);
            expect(result.after?.localStatus).toBe('available');
            return;
        }
        // Today's cleanup deletes the local file whether or not a cloud copy exists: with no cloudKey the bytes are gone for good.
        expect(result.freshWork).toBe(true);
        expect(result.deleted).toEqual([FILE_URI]);
        expect(result.remoteDeletes).toEqual(item.cloudKey ? [CLOUD_KEY] : []);
        expect(result.after?.localStatus).toBe('missing');
    });

    it('a newer restore replaces the hold with its own recovery snapshot', async () => {
        const library = libraryWith(attachment);
        const adapter = await open(library);
        const commitReplace = async (requestId: string, sha: string, tasks: Task[]) => {
            const prepared = await prepareNativeBackupDocument(adapter, { requestId, mode: 'replace', snapshotName: NAME,
                text: serializeBackupData({ ...clone(library), tasks }), metadata: clone(metadata) });
            await commitNativeBackupDocument(adapter, reference(requestId, sha), prepared.planJSON, NAME);
        };
        await commitReplace('11111111-1111-4111-8111-111111111111', 'a',
            [task('with-file', { rev: 2, attachments: [{ ...attachment, deletedAt: AT, updatedAt: AT }] }), task('other')]);
        // The second restore's recovery snapshot has the attachment deleted already: its Undo cannot bring it back.
        await commitReplace('33333333-3333-4333-8333-333333333333', 'c', [task('other', { rev: 2 })]);
        const deleted: string[] = [];
        await runAttachmentCleanupLifecycle({ appData: libraryWith({ ...attachment, deletedAt: AT }), deleteLocalAttachment: collectDeletes(deleted) });
        expect(deleted).toEqual([FILE_URI]);
    });

    it('a snapshot restore (no Undo of its own) keeps the earlier restore\'s hold', async () => {
        const library = libraryWith(attachment);
        const adapter = await open(library);
        const replaceId = '11111111-1111-4111-8111-111111111111';
        const replaced = await prepareNativeBackupDocument(adapter, { requestId: replaceId, mode: 'replace', snapshotName: NAME,
            text: serializeBackupData(libraryWith({ ...attachment, deletedAt: AT, updatedAt: AT }, { rev: 2 })), metadata: clone(metadata) });
        await commitNativeBackupDocument(adapter, reference(replaceId, 'a'), replaced.planJSON, NAME);
        // The snapshot restore's own baseline has the attachment deleted: had it taken the hold, the file would go.
        const restoreId = '44444444-4444-4444-8444-444444444444';
        const restored = await prepareNativeBackupDocument(adapter, { requestId: restoreId, mode: 'restore', snapshotName: NAME,
            text: serializeBackupData({ ...clone(library), tasks: [task('other', { rev: 3 })] }), metadata: clone(metadata) });
        await commitNativeBackupDocument(adapter, reference(restoreId, 'd'), restored.planJSON, NAME);
        const deleted: string[] = [];
        await runAttachmentCleanupLifecycle({ appData: libraryWith({ ...attachment, deletedAt: AT }), deleteLocalAttachment: collectDeletes(deleted) });
        expect(deleted).toEqual([]);
    });

    it('a leftover hold from an unreadable snapshot holds nothing new and keeps the hold it found; a bad name is refused', async () => {
        const deleted: string[] = [];
        holdRestoreUndoAttachments(findLiveAttachmentResourceReferences(libraryWith(attachment)));
        expect(holdNativeBackupUndoAttachments('{not a backup', NAME)).toBe(false);
        await runAttachmentCleanupLifecycle({ appData: libraryWith({ ...attachment, deletedAt: AT }), deleteLocalAttachment: collectDeletes(deleted) });
        expect(deleted).toEqual([]);
        expect(() => holdNativeBackupUndoAttachments(serializeBackupData(libraryWith(attachment)), '../data.json')).toThrow('INVALID_INPUT:');
    });

    it('a held legacy File Sync drain entry is no reason to run cleanup on every sync', () => {
        const generation = `attachments/a2doc.${'b'.repeat(64)}.pdf`;
        const held: Attachment = { ...attachment, cloudKey: generation };
        holdRestoreUndoAttachments(findLiveAttachmentResourceReferences(libraryWith(held)));
        const data = libraryWith({ ...held, deletedAt: AT });
        data.settings = { ...data.settings, attachments: { pendingRemoteDeletes: [{ cloudKey: generation, attempts: 0 }] } };
        expect(hasFreshAttachmentCleanupWork(data)).toBe(false);
        resetRestoreUndoAttachmentHold();
        expect(hasFreshAttachmentCleanupWork(data)).toBe(true);
    });

    it('keeps a held remote copy queued for deletion instead of deleting or dropping it', async () => {
        const adapter = await open(libraryWith(attachment));
        const replaceId = '11111111-1111-4111-8111-111111111111';
        const prepared = await prepareNativeBackupDocument(adapter, { requestId: replaceId, mode: 'replace', snapshotName: NAME,
            text: serializeBackupData(libraryWith({ ...attachment, deletedAt: AT, updatedAt: AT }, { rev: 2 })), metadata: clone(metadata) });
        await commitNativeBackupDocument(adapter, reference(replaceId, 'a'), prepared.planJSON, NAME);
        const data = await adapter.getData();
        const pending = { cloudKey: CLOUD_KEY, title: 'a2doc.pdf', attempts: 1 };
        const remoteDeletes: string[] = [];
        const cleaned = await runAttachmentCleanupLifecycle({
            appData: { ...data, settings: { ...data.settings, attachments: { pendingRemoteDeletes: [pending] } } },
            deleteLocalAttachment: async () => undefined,
            deleteRemoteAttachment: async (target) => { remoteDeletes.push(target.cloudKey); } });
        expect(remoteDeletes).toEqual([]);
        expect(cleaned.appData.settings.attachments?.pendingRemoteDeletes).toEqual([pending]);
    });
});

describe('a mobile data transfer (React Native\'s restore, merge, import and snapshot restore)', () => {
    const boundaries = (current: AppData, persisted: AppData[], presence: Record<string, LocalAttachmentPresence>) => ({
        operation: 'restore',
        flushPendingSave: async () => undefined,
        getCurrentChangeAt: () => 0,
        readCurrentData: async () => clone(current),
        persistData: async (data: AppData) => { persisted.push(data); },
        refreshData: async () => undefined,
        getLocalAttachmentPresence: async (uri: string) => presence[uri] ?? 'present',
    });

    it('holds the files of the Undo\'s recovery snapshot once a transfer with a snapshot lands', async () => {
        const persisted: AppData[] = [];
        await runDataTransferTransaction({ ...boundaries(libraryWith(attachment), persisted, {}),
            apply: () => ({ data: libraryWith({ ...attachment, deletedAt: AT }), result: undefined }),
            createRecoverySnapshot: async () => NAME });
        const deleted: string[] = [];
        await runAttachmentCleanupLifecycle({ appData: persisted[0]!, deleteLocalAttachment: collectDeletes(deleted) });
        expect(deleted).toEqual([]);
    });

    it('a snapshot restore (no Undo of its own) marks a live file attachment whose local file is gone as missing', async () => {
        const persisted: AppData[] = [];
        const kept: Attachment = { ...attachment, id: 'att-2', uri: 'file:///data/user/0/app/files/attachments/kept.pdf' };
        await runDataTransferTransactionWithoutSnapshot({ ...boundaries(libraryWith(attachment), persisted, { [FILE_URI]: 'confirmed-not-found' }),
            apply: () => ({ data: libraryWith(attachment, { attachments: [kept] }), result: undefined }) });
        expect(findAttachment(persisted[0]!)?.localStatus).toBe('missing');
        expect(persisted[0]!.tasks[1]!.attachments?.[0]?.localStatus).toBe('available');
        // No Undo, no hold: a later cleanup of this attachment runs as before.
        const deleted: string[] = [];
        await runAttachmentCleanupLifecycle({ appData: libraryWith({ ...attachment, deletedAt: AT }), deleteLocalAttachment: collectDeletes(deleted) });
        expect(deleted).toEqual([FILE_URI]);
    });
});
