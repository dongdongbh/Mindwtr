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

/** Reserve admission before a platform's outer queue; consume once in the document lane. */
export const createSyncDocumentWriteAdmission = (): SyncDocumentWriteAdmission => {
    if (isWorkspaceTransitionActive()) {
        throw new Error('Cannot write data while switching workspaces.');
    }
    const admission: SyncDocumentWriteAdmission = { [writeAdmissionBrand]: true };
    writeAdmissions.add(admission);
    return admission;
};

/**
 * Serializes operations that read and later replace the complete sync document.
 * Normal store edits intentionally stay outside this lane: sync detects them via
 * its freshness guard and requeues, while imports/restores block those writes via
 * `runAfterStoreWriteLock` only after they reach the front of this queue.
 */
export const runSerializedSyncDocumentOperation = <T>(
    operation: () => Promise<T> | T
): Promise<T> => syncDocumentOperationQueue.run(operation);

/** Drain already-admitted sync/import/restore work before leaving this runtime. */
export const waitForSyncDocumentOperationsIdle = (): Promise<void> =>
    syncDocumentOperationQueue.run(() => undefined);

export const runAfterStoreWriteLock = <T>(operation: () => Promise<T>): Promise<T> => {
    const barrier = activeDataTransferBarrier;
    return barrier ? barrier.then(operation) : operation();
};

const runWithStoreWriteLock = <T>(operation: () => Promise<T>): Promise<T> => {
    // The serialized queue already invokes this callback from a promise turn.
    // Start the transfer immediately once it reaches the front so callers can
    // observe the write barrier without an additional scheduling delay.
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

/**
 * Runs a complete-document writer after earlier sync/transfer work and blocks
 * ordinary store actions until its read/replace window has finished.
 */
export const runSerializedSyncDocumentWriteOperation = <T>(
    operation: () => Promise<T>,
    admission?: SyncDocumentWriteAdmission,
): Promise<T> => {
    // An import can still be reading a file when the user chooses sandbox.
    // Reject its later apply before it joins the personal write queue. Writers
    // admitted before the transition keep their place and drain normally.
    try {
        // A platform may already have admitted this write into an outer queue.
        // Its drain must include that queue before awaiting our idle fence.
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
    /** Already admitted by a platform outer queue that the workspace transition drains. */
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

        await options.persistData(application.data);
        try {
            // The document on disk is now the one we just wrote, not the one the
            // store still holds; tell the load which guard applies.
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
