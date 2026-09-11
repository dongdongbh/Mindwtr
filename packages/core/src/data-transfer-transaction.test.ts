import { describe, expect, it, vi } from 'vitest';

import type { AppData } from './types';
import { acquireWorkspaceTransitionLock } from './sandbox';
import {
    runAfterStoreWriteLock,
    runDataTransferTransaction,
    runDataTransferTransactionWithoutSnapshot,
    runSerializedSyncDocumentWriteOperation,
    waitForSyncDocumentOperationsIdle,
    createSyncDocumentWriteAdmission,
} from './data-transfer-transaction';

const emptyData: AppData = {
    tasks: [],
    projects: [],
    sections: [],
    areas: [],
    people: [],
    settings: {},
};

describe('runDataTransferTransaction', () => {
    it('carries a pre-transition restore reservation through the transaction', async () => {
        const writeAdmission = createSyncDocumentWriteAdmission();
        const release = acquireWorkspaceTransitionLock()!;
        const persistData = vi.fn(async () => undefined);
        try {
            await runDataTransferTransactionWithoutSnapshot({
                operation: 'restoreSnapshot',
                writeAdmission,
                flushPendingSave: async () => undefined,
                getCurrentChangeAt: () => 3,
                readCurrentData: async () => emptyData,
                apply: () => ({ data: emptyData, result: undefined }),
                persistData,
                refreshData: async () => undefined,
            });
            expect(persistData).toHaveBeenCalledWith(emptyData);
        } finally {
            release();
        }
    });

    it('honors a one-use reservation from an outer queue without admitting new writers', async () => {
        const admission = createSyncDocumentWriteAdmission();
        const release = acquireWorkspaceTransitionLock()!;
        const persist = vi.fn(async () => undefined);
        try {
            expect(() => createSyncDocumentWriteAdmission()).toThrow('switching workspaces');
            await runSerializedSyncDocumentWriteOperation(persist, admission);
            expect(persist).toHaveBeenCalledOnce();
            await expect(runSerializedSyncDocumentWriteOperation(persist, admission)).rejects.toThrow('already used');
            await expect(runSerializedSyncDocumentWriteOperation(persist)).rejects.toThrow('switching workspaces');
            expect(persist).toHaveBeenCalledOnce();
        } finally {
            release();
        }
    });

    it('drains document writes admitted before a workspace transition', async () => {
        let finishWrite!: () => void;
        const pendingWrite = new Promise<void>((resolve) => { finishWrite = resolve; });
        const persist = vi.fn(() => pendingWrite);
        const write = runSerializedSyncDocumentWriteOperation(persist);
        const release = acquireWorkspaceTransitionLock()!;
        let drained = false;
        const fence = waitForSyncDocumentOperationsIdle().then(() => { drained = true; });
        try {
            await Promise.resolve();
            expect(persist).toHaveBeenCalledOnce();
            expect(drained).toBe(false);
            finishWrite();
            await write;
            await fence;
            expect(drained).toBe(true);
        } finally {
            finishWrite();
            await write;
            release();
        }
    });

    it('rejects an import that finishes preparation after the transition fence, and permits retry', async () => {
        let finishPreparation!: () => void;
        const preparation = new Promise<void>((resolve) => { finishPreparation = resolve; });
        const persist = vi.fn(async () => undefined);
        const lateImport = preparation.then(() => runSerializedSyncDocumentWriteOperation(persist));
        const rejected = expect(lateImport).rejects.toThrow('switching workspaces');
        const release = acquireWorkspaceTransitionLock()!;
        try {
            await waitForSyncDocumentOperationsIdle();
            finishPreparation();
            await rejected;
            expect(persist).not.toHaveBeenCalled();
        } finally {
            finishPreparation();
            release();
        }
        await runSerializedSyncDocumentWriteOperation(persist);
        expect(persist).toHaveBeenCalledOnce();
    });

    it('owns the ordered flush, read, apply, guard, snapshot, recheck, persist, and refresh transaction', async () => {
        const events: string[] = [];
        let changeReadCount = 0;
        const importedData: AppData = {
            ...emptyData,
            settings: { ...emptyData.settings, language: 'de' },
        };

        const transaction = await runDataTransferTransaction({
            operation: 'importTodoist',
            flushPendingSave: async () => { events.push('flush'); },
            getCurrentChangeAt: () => {
                changeReadCount += 1;
                events.push([
                    'capture-change',
                    'guard-before-snapshot',
                    'guard-after-snapshot',
                ][changeReadCount - 1] ?? 'unexpected-change-read');
                return 7;
            },
            readCurrentData: async () => {
                events.push('read');
                return emptyData;
            },
            createRecoverySnapshot: async (currentData) => {
                events.push('snapshot');
                expect(currentData).toEqual(emptyData);
                expect(currentData).not.toBe(emptyData);
                return 'data.snapshot.json';
            },
            apply: (currentData) => {
                events.push('apply');
                expect(currentData).toBe(emptyData);
                return {
                    data: importedData,
                    result: { importedTaskCount: 3 },
                };
            },
            persistData: async (data) => {
                events.push('persist');
                expect(data).toBe(importedData);
            },
            refreshData: async () => { events.push('refresh'); },
        });

        expect(events).toEqual([
            'flush',
            'capture-change',
            'read',
            'apply',
            'guard-before-snapshot',
            'snapshot',
            'guard-after-snapshot',
            'persist',
            'refresh',
        ]);
        expect(transaction).toEqual({
            snapshot: 'data.snapshot.json',
            result: { importedTaskCount: 3 },
        });
    });

    it('aborts before persistence when local data changes during the transaction', async () => {
        const persistData = vi.fn();
        const refreshData = vi.fn();
        const createRecoverySnapshot = vi.fn().mockResolvedValue('data.snapshot.json');
        const onStale = vi.fn();
        let changeReadCount = 0;

        await expect(runDataTransferTransaction({
            operation: 'restoreBackup',
            flushPendingSave: async () => undefined,
            getCurrentChangeAt: () => {
                changeReadCount += 1;
                return changeReadCount === 1 ? 10 : 11;
            },
            readCurrentData: async () => emptyData,
            createRecoverySnapshot,
            apply: () => ({ data: emptyData, result: undefined }),
            persistData,
            refreshData,
            onStale,
        })).rejects.toMatchObject({ name: 'LocalSyncAbort' });

        expect(createRecoverySnapshot).not.toHaveBeenCalled();
        expect(onStale).toHaveBeenCalledWith({
            operation: 'restoreBackup',
            localSnapshotChangeAt: 10,
            currentChangeAt: 11,
        });
        expect(persistData).not.toHaveBeenCalled();
        expect(refreshData).not.toHaveBeenCalled();
    });

    it('does not create or prune snapshots when applying imported data fails', async () => {
        const createRecoverySnapshot = vi.fn();
        const persistData = vi.fn();

        await expect(runDataTransferTransaction({
            operation: 'importTodoist',
            flushPendingSave: async () => undefined,
            getCurrentChangeAt: () => 10,
            readCurrentData: async () => emptyData,
            createRecoverySnapshot,
            apply: () => {
                throw new Error('parse application failed');
            },
            persistData,
            refreshData: async () => undefined,
        })).rejects.toThrow('parse application failed');

        expect(createRecoverySnapshot).not.toHaveBeenCalled();
        expect(persistData).not.toHaveBeenCalled();
    });

    it('rechecks freshness after snapshot creation before persisting', async () => {
        let currentChangeAt = 10;
        const persistData = vi.fn();
        const onStale = vi.fn();

        await expect(runDataTransferTransaction({
            operation: 'restoreBackup',
            flushPendingSave: async () => undefined,
            getCurrentChangeAt: () => currentChangeAt,
            readCurrentData: async () => emptyData,
            createRecoverySnapshot: async () => {
                currentChangeAt = 11;
                return 'data.snapshot.json';
            },
            apply: () => ({ data: emptyData, result: undefined }),
            persistData,
            refreshData: async () => undefined,
            onStale,
        })).rejects.toMatchObject({ name: 'LocalSyncAbort' });

        expect(onStale).toHaveBeenCalledWith({
            operation: 'restoreBackup',
            localSnapshotChangeAt: 10,
            currentChangeAt: 11,
        });
        expect(persistData).not.toHaveBeenCalled();
    });

    it('marks refresh failures as post-commit so callers do not blindly retry', async () => {
        const refreshCause = new Error('store reload failed');
        const persistData = vi.fn().mockResolvedValue(undefined);

        await expect(runDataTransferTransaction({
            operation: 'importTodoist',
            flushPendingSave: async () => undefined,
            getCurrentChangeAt: () => 10,
            readCurrentData: async () => emptyData,
            createRecoverySnapshot: async () => 'data.snapshot.json',
            apply: () => ({ data: emptyData, result: undefined }),
            persistData,
            refreshData: async () => {
                throw refreshCause;
            },
        })).rejects.toMatchObject({
            name: 'DataTransferRefreshError',
            committed: true,
            operation: 'importTodoist',
            cause: refreshCause,
        });

        expect(persistData).toHaveBeenCalledOnce();
    });

    it('supports guarded writes that do not create another recovery snapshot', async () => {
        const persistData = vi.fn().mockResolvedValue(undefined);

        const transaction = await runDataTransferTransactionWithoutSnapshot({
            operation: 'restoreSnapshot',
            flushPendingSave: async () => undefined,
            getCurrentChangeAt: () => 3,
            readCurrentData: async () => emptyData,
            apply: () => ({ data: emptyData, result: undefined }),
            persistData,
            refreshData: async () => undefined,
        });

        expect(transaction).toEqual({ snapshot: null, result: undefined });
        expect(persistData).toHaveBeenCalledWith(emptyData);
    });

    it('blocks ordinary store writes while a serialized document writer is active', async () => {
        let markDocumentWriteStarted: (() => void) | undefined;
        let releaseDocumentWrite: (() => void) | undefined;
        const documentWriteStarted = new Promise<void>((resolve) => {
            markDocumentWriteStarted = resolve;
        });
        const documentWriteGate = new Promise<void>((resolve) => {
            releaseDocumentWrite = resolve;
        });
        const storeWrite = vi.fn(async () => undefined);

        const documentWrite = runSerializedSyncDocumentWriteOperation(async () => {
            markDocumentWriteStarted?.();
            await documentWriteGate;
        });

        await documentWriteStarted;
        const queuedStoreWrite = runAfterStoreWriteLock(storeWrite);
        expect(storeWrite).not.toHaveBeenCalled();

        releaseDocumentWrite?.();
        await Promise.all([documentWrite, queuedStoreWrite]);

        expect(storeWrite).toHaveBeenCalledOnce();
    });
});
