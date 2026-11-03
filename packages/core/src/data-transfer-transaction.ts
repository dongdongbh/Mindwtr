import { findLiveAttachmentResourceReferences, holdRestoreUndoAttachments, markMissingLocalAttachmentFiles } from './attachment-cleanup';
import type { LocalAttachmentPresence } from './attachment-transfer';
import { ensureFreshLocalSyncSnapshot } from './sync-client-helpers';
import { cloneAppData } from './sync-runtime-utils';
import { createSerializedAsyncQueue } from './async-queue';
import { markNextLoadAsDocumentReplacement } from './store-settings';
import { isWorkspaceTransitionActive } from './sandbox';
import type { AppData } from './types';

const syncDocumentOperationQueue = createSerializedAsyncQueue();
let activeDataTransferBarrier: Promise<void> | null = null;
const writeAdmissionBrand = Symbol('sync-document-write-admission');
export type SyncDocumentWriteAdmission = { readonly [writeAdmissionBrand]: true };
const writeAdmissions = new WeakSet<SyncDocumentWriteAdmission>();


export const createSyncDocumentWriteAdmission = (): SyncDocumentWriteAdmission => {
    if (isWorkspaceTransitionActive()) {
        throw new Error('Cannot write data while switching workspaces.');
    }
    const admission: SyncDocumentWriteAdmission = { [writeAdmissionBrand]: true };
    writeAdmissions.add(admission);
    return admission;
};


export const runSerializedSyncDocumentOperation = <T>(
    operation: () => Promise<T> | T
): Promise<T> => syncDocumentOperationQueue.run(operation);


export const waitForSyncDocumentOperationsIdle = (): Promise<void> =>
    syncDocumentOperationQueue.run(() => undefined);

export const runAfterStoreWriteLock = <T>(operation: () => Promise<T>): Promise<T> => {
    const barrier = activeDataTransferBarrier;
    return barrier ? barrier.then(operation) : operation();
};

const runWithStoreWriteLock = <T>(operation: () => Promise<T>): Promise<T> => {


    let result: Promise<T>;
    try {
        result = operation();
    } catch (error) {
        result = Promise.reject(error);
    }
    const barrier = result.then(
        () => undefined,
        () => undefined,
    );
    activeDataTransferBarrier = barrier;
    void barrier.finally(() => {
        if (activeDataTransferBarrier === barrier) activeDataTransferBarrier = null;
    });
    return result;
};


export const runSerializedSyncDocumentWriteOperation = <T>(
    operation: () => Promise<T>,
    admission?: SyncDocumentWriteAdmission,
): Promise<T> => {


    try {


        const ticket = admission ?? createSyncDocumentWriteAdmission();
        if (!writeAdmissions.delete(ticket)) {
            throw new Error('Document write admission is invalid or already used.');
        }
    } catch (error) {
        return Promise.reject(error);
    }
    return syncDocumentOperationQueue.run(() => runWithStoreWriteLock(operation));
};

export type DataTransferStaleDetails = {
    currentChangeAt: number;
    localSnapshotChangeAt: number;
    operation: string;
};

export type DataTransferApplication<TResult> = {
    data: AppData;
    result: TResult;
};

export type DataTransferTransactionOptions<TResult> = {
    operation: string;

    writeAdmission?: SyncDocumentWriteAdmission;
    flushPendingSave: () => Promise<void>;
    getCurrentChangeAt: () => number;
    readCurrentData: () => Promise<AppData>;
    apply: (
        currentData: AppData
    ) => DataTransferApplication<TResult> | Promise<DataTransferApplication<TResult>>;
    persistData: (data: AppData) => Promise<void>;
    refreshData: () => Promise<void>;
    onStale?: (details: DataTransferStaleDetails) => void;

    getLocalAttachmentPresence?: (uri: string) => Promise<LocalAttachmentPresence>;
};

export type DataTransferTransactionWithSnapshotOptions<TResult, TSnapshot> =
    DataTransferTransactionOptions<TResult> & {
        createRecoverySnapshot: (currentData: AppData) => Promise<TSnapshot>;
    };

export class DataTransferRefreshError extends Error {
    readonly committed = true;
    readonly operation: string;
    readonly cause: unknown;

    constructor(operation: string, cause: unknown) {
        super('Data was saved, but Mindwtr could not reload it. Restart Mindwtr before retrying this transfer.');
        this.name = 'DataTransferRefreshError';
        this.operation = operation;
        this.cause = cause;
    }
}

export async function runDataTransferTransaction<TResult, TSnapshot>(
    options: DataTransferTransactionWithSnapshotOptions<TResult, TSnapshot>
): Promise<{ result: TResult; snapshot: TSnapshot }> {
    return runSerializedSyncDocumentWriteOperation(async () => {
        await options.flushPendingSave();
        const localSnapshotChangeAt = options.getCurrentChangeAt();
        const currentData = await options.readCurrentData();
        const recoveryData = cloneAppData(currentData);
        const application = await options.apply(currentData);
        const data = options.getLocalAttachmentPresence
            ? await markMissingLocalAttachmentFiles(application.data, options.getLocalAttachmentPresence)
            : application.data;

        const ensureFresh = () => {
            ensureFreshLocalSyncSnapshot({
                localSnapshotChangeAt,
                getCurrentChangeAt: options.getCurrentChangeAt,
                requestFollowUp: () => undefined,
                onStale: ({ currentChangeAt, localSnapshotChangeAt: snapshotChangeAt }) => {
                    options.onStale?.({
                        operation: options.operation,
                        localSnapshotChangeAt: snapshotChangeAt,
                        currentChangeAt,
                    });
                },
            });
        };

        ensureFresh();
        const snapshot = await options.createRecoverySnapshot(recoveryData);
        ensureFresh();

        await options.persistData(data);

        if (snapshot !== null) holdRestoreUndoAttachments(findLiveAttachmentResourceReferences(recoveryData));
        try {


            markNextLoadAsDocumentReplacement();
            await options.refreshData();
        } catch (error) {
            throw new DataTransferRefreshError(options.operation, error);
        }

        return {
            result: application.result,
            snapshot,
        };
    }, options.writeAdmission);
}

export const runDataTransferTransactionWithoutSnapshot = async <TResult>(
    options: DataTransferTransactionOptions<TResult>
): Promise<{ result: TResult; snapshot: null }> => runDataTransferTransaction({
    ...options,
    createRecoverySnapshot: async () => null,
});
