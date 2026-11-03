


import { requireNativeModule, type NativeModule } from 'expo-modules-core';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CLOUDKIT_ATTACHMENT_RECORD_TYPE, parseCloudKitRetryAfterMs, type AppData } from '@mindwtr/core';
import { logInfo, logWarn, logError } from './app-log';
import { getBackgroundSafeFetchDeadline } from './background-safe-fetch';
import { CLOUDKIT_CHANGE_TOKEN_KEY, CLOUDKIT_SEEDED_KEY, CLOUDKIT_ZONE_CREATED_KEY } from './sync-constants';


type ChangeResult = {
    records: Record<string, Array<Record<string, unknown>>>;
    deletedIDs: Record<string, string[]>;
    changeToken?: string;
    tokenExpired?: boolean;
};


interface CloudKitSyncModule extends NativeModule {
    getAccountStatus(): Promise<string>;
    ensureZone(): Promise<void>;
    ensureSubscription(): Promise<void>;
    fetchChanges(changeToken: string | null): Promise<ChangeResult>;
    fetchAllRecords(recordType: string): Promise<Array<Record<string, unknown>>>;
    saveRecords(recordType: string, json: string): Promise<string[]>;
    deleteRecords(recordType: string, ids: string[]): Promise<boolean>;
    saveAttachmentAsset(
        recordName: string,
        filePath: string,
        metadata: CloudKitAttachmentMetadata,
    ): Promise<CloudKitAttachmentMetadata>;
    fetchAttachmentAsset(recordName: string, targetPath: string): Promise<CloudKitAttachmentMetadata>;
    consumePendingRemoteChange(): Promise<boolean>;
}


let CloudKitSync: CloudKitSyncModule | null = null;
try {
    CloudKitSync = requireNativeModule<CloudKitSyncModule>('CloudKitSync');
} catch {

}


const RECORD_TYPES = {
    task: 'MindwtrTask',
    project: 'MindwtrProject',
  section: 'MindwtrSection',
  area: 'MindwtrArea',
  person: 'MindwtrPerson',
  settings: 'MindwtrSettings',
} as const;

type AccountStatus = 'available' | 'noAccount' | 'restricted' | 'temporarilyUnavailable' | 'unknown';
type CloudKitOperationOptions = {
    signal?: AbortSignal;
};

export const CLOUDKIT_ATTACHMENT_NOT_FOUND_CODE = 'ERR_CLOUDKIT_ATTACHMENT_NOT_FOUND';

export class CloudKitAttachmentNotFoundError extends Error {
    readonly code = CLOUDKIT_ATTACHMENT_NOT_FOUND_CODE;

    constructor(message = 'CloudKit attachment is no longer available', cause?: unknown) {
        super(message);
        this.name = 'CloudKitAttachmentNotFoundError';
        if (cause !== undefined) {
            (this as Error & { cause?: unknown }).cause = cause;
        }
    }
}

const getCloudKitErrorCode = (error: unknown): string | null => {
    if (!error || typeof error !== 'object' || !('code' in error)) return null;
    return typeof error.code === 'string' ? error.code : null;
};

export const isCloudKitAttachmentNotFoundError = (
    error: unknown,
): boolean => (
    error instanceof CloudKitAttachmentNotFoundError
    || getCloudKitErrorCode(error) === CLOUDKIT_ATTACHMENT_NOT_FOUND_CODE
);


export const CLOUDKIT_ZONE_GONE_CODE = 'ERR_CLOUDKIT_ZONE_GONE';

export const isCloudKitZoneGoneError = (error: unknown): boolean => (
    getCloudKitErrorCode(error) === CLOUDKIT_ZONE_GONE_CODE
);

export type CloudKitAttachmentMetadata = {
    recordName?: string;
    attachmentId: string;
    ownerType: 'task' | 'project';
    ownerId: string;
    title: string;
    mimeType?: string;
    size?: number;
    fileHash?: string;
    updatedAt: string;
    deletedAt?: string;
    filePath?: string;
};

const createAbortError = (message: string): Error => {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
};

const resolveAbortError = (signal: AbortSignal, fallbackMessage: string): Error => {
    const reason = (signal as AbortSignal & { reason?: unknown }).reason;
    if (reason instanceof Error) return reason;
    if (typeof reason === 'string' && reason.trim()) return createAbortError(reason);
    return createAbortError(fallbackMessage);
};

const throwIfAborted = (signal: AbortSignal | undefined, fallbackMessage: string): void => {
    if (!signal?.aborted) return;
    throw resolveAbortError(signal, fallbackMessage);
};

const isAbortLikeError = (error: unknown, signal?: AbortSignal): boolean =>
    Boolean(signal?.aborted) || (error instanceof Error && error.name === 'AbortError');


const throwIfMobileSyncDeadlinePassed = (fallbackMessage: string): void => {
    const deadlineAt = getBackgroundSafeFetchDeadline();
    if (deadlineAt !== null && Date.now() >= deadlineAt) {
        throw createAbortError(`Mobile background sync deadline passed; ${fallbackMessage}`);
    }
};


const CLOUDKIT_OPERATION_TIMEOUT_LOG_THRESHOLD_MS = 25_000;

const logCloudKitOperationTimeoutIfNeeded = (operationName: string, startedAt: number, error: unknown): void => {
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs < CLOUDKIT_OPERATION_TIMEOUT_LOG_THRESHOLD_MS) return;

    if (error instanceof Error && error.name === 'AbortError') return;
    void logWarn('CloudKit operation timed out', {
        scope: 'cloudkit',
        force: true,
        extra: { operation: operationName, elapsedMs: String(elapsedMs), releaseCheck: 'v1.3.2/cloudkit-op-timeout' },
    });
};

const runNativeOperation = async <T>(
    operationName: string,
    operation: () => Promise<T>,
    signal: AbortSignal | undefined,
    fallbackMessage: string,
): Promise<T> => {
    throwIfAborted(signal, fallbackMessage);
    throwIfMobileSyncDeadlinePassed(fallbackMessage);
    const startedAt = Date.now();
    try {
        const result = !signal
            ? await operation()
            : await new Promise<T>((resolve, reject) => {
                const onAbort = () => reject(resolveAbortError(signal, fallbackMessage));
                signal.addEventListener('abort', onAbort, { once: true });
                operation()
                    .then(resolve, reject)
                    .finally(() => signal.removeEventListener('abort', onAbort));
            });
        throwIfMobileSyncDeadlinePassed(fallbackMessage);
        return result;
    } catch (error) {
        logCloudKitOperationTimeoutIfNeeded(operationName, startedAt, error);
        if (!isAbortLikeError(error, signal)) {
            const retryAfterMs = parseCloudKitRetryAfterMs(error);
            if (retryAfterMs !== null) {
                void logInfo('CloudKit retry interval received', {
                    scope: 'cloudkit',
                    force: true,
                    extra: { releaseCheck: 'v1.3.3/cloudkit-retry-hint', operation: operationName, retryAfterMs },
                });
            }
        }
        throw error;
    }
};


const recreateCloudKitZone = async (signal: AbortSignal | undefined): Promise<void> => {
    await AsyncStorage.removeItem(CLOUDKIT_CHANGE_TOKEN_KEY);
    await AsyncStorage.removeItem(CLOUDKIT_ZONE_CREATED_KEY);
    await runNativeOperation('ensureZone', () => CloudKitSync!.ensureZone(), signal, 'CloudKit setup cancelled');
    await AsyncStorage.setItem(CLOUDKIT_ZONE_CREATED_KEY, '1');
    void logWarn('CloudKit zone was deleted or cleared; recreated it and reset the change token', {
        scope: 'cloudkit',
        extra: { releaseCheck: 'v1.3.0/cloudkit-zone-recreated' },
    });
};


const runCloudKitOperation = async <T>(
    operationName: string,
    operation: () => Promise<T>,
    signal: AbortSignal | undefined,
    fallbackMessage: string,
    recoverZone = true,
): Promise<T> => {
    try {
        return await runNativeOperation(operationName, operation, signal, fallbackMessage);
    } catch (error) {
        if (!recoverZone || !isCloudKitZoneGoneError(error)) throw error;
        await recreateCloudKitZone(signal);
        return runNativeOperation(operationName, operation, signal, fallbackMessage);
    }
};


export const isCloudKitAvailable = (): boolean => {
    return CloudKitSync != null;
};


export const getCloudKitAccountStatus = async (): Promise<AccountStatus> => {
    if (!isCloudKitAvailable()) return 'unknown';
    try {
        return (await CloudKitSync!.getAccountStatus()) as AccountStatus;
    } catch {
        return 'unknown';
    }
};


export const ensureCloudKitReady = async (options: CloudKitOperationOptions = {}): Promise<void> => {
    if (!isCloudKitAvailable()) {
        throw new Error('CloudKit is not available on this platform');
    }

    throwIfAborted(options.signal, 'CloudKit setup cancelled');
    const zoneCreated = await AsyncStorage.getItem(CLOUDKIT_ZONE_CREATED_KEY);
    if (!zoneCreated) {
        await runCloudKitOperation('ensureZone', () => CloudKitSync!.ensureZone(), options.signal, 'CloudKit setup cancelled');
        await AsyncStorage.setItem(CLOUDKIT_ZONE_CREATED_KEY, '1');
        void logInfo('CloudKit zone created', { scope: 'cloudkit' });
    }

    try {
        await runCloudKitOperation(
            'ensureSubscription',
            () => CloudKitSync!.ensureSubscription(),
            options.signal,
            'CloudKit subscription setup cancelled',
        );
    } catch (error) {
        if (isAbortLikeError(error, options.signal)) throw error;

        void logWarn('CloudKit subscription setup failed (non-fatal)', {
            scope: 'cloudkit',
            extra: { error: error instanceof Error ? error.message : String(error) },
        });
    }
};


export const readRemoteCloudKit = async (options: CloudKitOperationOptions = {}): Promise<AppData | null> => {
    if (!isCloudKitAvailable()) return null;

    try {
        throwIfAborted(options.signal, 'CloudKit read cancelled');
        const changeToken = await AsyncStorage.getItem(CLOUDKIT_CHANGE_TOKEN_KEY);


        if (changeToken) {
            let result: ChangeResult;
            try {
                result = await runCloudKitOperation(
                    'fetchChanges',
                    () => CloudKitSync!.fetchChanges(changeToken),
                    options.signal,
                    'CloudKit read cancelled',
                    false,
                );
            } catch (error) {
                if (!isCloudKitZoneGoneError(error)) throw error;


                await recreateCloudKitZone(options.signal);
                return await fullFetch(options);
            }

            if (result.tokenExpired) {
                void logInfo('CloudKit change token expired; doing full fetch', {
                    scope: 'cloudkit',
                });
                await AsyncStorage.removeItem(CLOUDKIT_CHANGE_TOKEN_KEY);
                return await fullFetch(options);
            }


            if (result.changeToken) {
                await AsyncStorage.setItem(CLOUDKIT_CHANGE_TOKEN_KEY, result.changeToken);
            }


            const hasChanges =
                Object.values(result.records).some((arr) => arr.length > 0) ||
                Object.values(result.deletedIDs).some((arr) => arr.length > 0);

            if (!hasChanges) {
                return null;
            }


            return await fullFetch(options);
        }


        return await fullFetch(options);
    } catch (error) {
        if (!isAbortLikeError(error, options.signal)) {
            void logError(error, {
                scope: 'cloudkit',
                extra: { operation: 'readRemote' },
            });
        }
        throw error;
    }
};


export const writeRemoteCloudKit = async (data: AppData, options: CloudKitOperationOptions = {}): Promise<void> => {
    if (!isCloudKitAvailable()) return;

    try {
        throwIfAborted(options.signal, 'CloudKit write cancelled');

        const allTasks = Array.isArray(data.tasks) ? data.tasks : [];
        const allProjects = Array.isArray(data.projects) ? data.projects : [];
        const allSections = Array.isArray(data.sections) ? data.sections : [];
        const allAreas = Array.isArray(data.areas) ? data.areas : [];
        const allPeople = Array.isArray(data.people) ? data.people : [];

        const saveResults: string[][] = [];

        if (allTasks.length > 0) {
            saveResults.push(
                await runCloudKitOperation(
                    'saveRecords:task',
                    () => CloudKitSync!.saveRecords(RECORD_TYPES.task, JSON.stringify(allTasks)),
                    options.signal,
                    'CloudKit write cancelled',
                ),
            );
        }
        if (allProjects.length > 0) {
            saveResults.push(
                await runCloudKitOperation(
                    'saveRecords:project',
                    () => CloudKitSync!.saveRecords(RECORD_TYPES.project, JSON.stringify(allProjects)),
                    options.signal,
                    'CloudKit write cancelled',
                ),
            );
        }
        if (allSections.length > 0) {
            saveResults.push(
                await runCloudKitOperation(
                    'saveRecords:section',
                    () => CloudKitSync!.saveRecords(RECORD_TYPES.section, JSON.stringify(allSections)),
                    options.signal,
                    'CloudKit write cancelled',
                ),
            );
        }
        if (allAreas.length > 0) {
            saveResults.push(
                await runCloudKitOperation(
                    'saveRecords:area',
                    () => CloudKitSync!.saveRecords(RECORD_TYPES.area, JSON.stringify(allAreas)),
                    options.signal,
                    'CloudKit write cancelled',
                ),
            );
        }
        if (allPeople.length > 0) {
            saveResults.push(
                await runCloudKitOperation(
                    'saveRecords:person',
                    () => CloudKitSync!.saveRecords(RECORD_TYPES.person, JSON.stringify(allPeople)),
                    options.signal,
                    'CloudKit write cancelled',
                ),
            );
        }


        if (data.settings && Object.keys(data.settings).length > 0) {
            const settingsRecord = [
                {
                    id: 'settings',
                    payload: data.settings,
                    updatedAt: new Date().toISOString(),
                },
            ];
            saveResults.push(
                await runCloudKitOperation(
                    'saveRecords:settings',
                    () => CloudKitSync!.saveRecords(RECORD_TYPES.settings, JSON.stringify(settingsRecord)),
                    options.signal,
                    'CloudKit write cancelled',
                ),
            );
        }

        const allConflicts = saveResults.flat();

        if (allConflicts.length > 0) {
            void logWarn(`CloudKit save had ${allConflicts.length} conflicts (will resolve on next sync)`, {
                scope: 'cloudkit',
                extra: { conflictIDs: allConflicts.slice(0, 10).join(',') },
            });
        }


        await deletePurgedRecords(data, options);


        if (allConflicts.length === 0) {
            const changeResult: ChangeResult = await runCloudKitOperation(
                'fetchChanges',
                async () => CloudKitSync!.fetchChanges(await AsyncStorage.getItem(CLOUDKIT_CHANGE_TOKEN_KEY)),
                options.signal,
                'CloudKit write cancelled',
            );
            if (changeResult.changeToken) {
                await AsyncStorage.setItem(CLOUDKIT_CHANGE_TOKEN_KEY, changeResult.changeToken);
            }
        }

        void logInfo('CloudKit write complete', {
            scope: 'cloudkit',
            extra: { conflicts: String(allConflicts.length), releaseCheck: 'v1.3.3/cloudkit-large-library-write' },
        });
    } catch (error) {
        if (!isAbortLikeError(error, options.signal)) {
            void logError(error, {
                scope: 'cloudkit',
                extra: { operation: 'writeRemote' },
            });
        }
        throw error;
    }
};


export const saveCloudKitAttachmentAsset = async (
    recordName: string,
    filePath: string,
    metadata: CloudKitAttachmentMetadata,
    options: CloudKitOperationOptions = {},
): Promise<CloudKitAttachmentMetadata> => {
    if (!isCloudKitAvailable()) throw new Error('CloudKit is not available on platform');
    throwIfAborted(options.signal, 'CloudKit attachment upload cancelled');
    return runCloudKitOperation(
        'saveAttachmentAsset',
        () => CloudKitSync!.saveAttachmentAsset(recordName, filePath, metadata),
        options.signal,
        'CloudKit attachment upload cancelled',
    );
};

export const fetchCloudKitAttachmentAsset = async (
    recordName: string,
    targetPath: string,
    options: CloudKitOperationOptions = {},
): Promise<CloudKitAttachmentMetadata> => {
    if (!isCloudKitAvailable()) throw new Error('CloudKit is not available on platform');
    throwIfAborted(options.signal, 'CloudKit attachment download cancelled');
    try {
        return await runCloudKitOperation(
            'fetchAttachmentAsset',
            () => CloudKitSync!.fetchAttachmentAsset(recordName, targetPath),
            options.signal,
            'CloudKit attachment download cancelled',
        );
    } catch (error) {
        if (!isCloudKitAttachmentNotFoundError(error)) throw error;
        if (error instanceof CloudKitAttachmentNotFoundError) throw error;
        const message = error instanceof Error ? error.message : undefined;
        throw new CloudKitAttachmentNotFoundError(message, error);
    }
};

export const deleteCloudKitAttachmentAssets = async (
    recordNames: string[],
    options: CloudKitOperationOptions = {},
): Promise<void> => {
    if (!isCloudKitAvailable()) return;
    if (recordNames.length === 0) return;
    throwIfAborted(options.signal, 'CloudKit attachment delete cancelled');
    await runCloudKitOperation(
        'deleteRecords:attachment',
        () => CloudKitSync!.deleteRecords(CLOUDKIT_ATTACHMENT_RECORD_TYPE, recordNames),
        options.signal,
        'CloudKit attachment delete cancelled',
    );
};


let seedingInFlight: Promise<void> | null = null;

export const seedCloudKitFromLocal = async (data: AppData): Promise<void> => {
    const seeded = await AsyncStorage.getItem(CLOUDKIT_SEEDED_KEY);
    if (seeded) return;


    if (seedingInFlight) {
        await seedingInFlight;
        return;
    }

    seedingInFlight = (async () => {
        void logInfo('Seeding CloudKit from local data', { scope: 'cloudkit' });

        await AsyncStorage.setItem(CLOUDKIT_SEEDED_KEY, '1');
        await writeRemoteCloudKit(data);
        void logInfo('CloudKit seed complete', { scope: 'cloudkit' });
    })();

    try {
        await seedingInFlight;
    } finally {
        seedingInFlight = null;
    }
};


let changeSubscription: { remove: () => void } | null = null;

export const subscribeToCloudKitChanges = (onChanged: () => void): (() => void) => {
    if (!isCloudKitAvailable() || !CloudKitSync) return () => {};


    changeSubscription?.remove();


    changeSubscription = (CloudKitSync as any).addListener('onRemoteChange', () => {


        void logInfo('CloudKit remote change notification received', {
            scope: 'cloudkit',
            force: true,
            extra: { releaseCheck: 'v1.3.2/cloudkit-push-delivered', origin: 'push' },
        });
        onChanged();
    });

    void CloudKitSync.consumePendingRemoteChange()
        .then((hadPendingChange) => {
            if (!hadPendingChange) {
                return;
            }
            void logInfo('CloudKit remote change notification replayed from pending state', { scope: 'cloudkit' });
            onChanged();
        })
        .catch((error) => {
            void logWarn('Failed to consume pending CloudKit remote change', {
                scope: 'cloudkit',
                extra: {
                    error: error instanceof Error ? error.message : String(error),
                },
            });
        });

    return () => {
        changeSubscription?.remove();
        changeSubscription = null;
    };
};


async function fullFetch(options: CloudKitOperationOptions = {}): Promise<AppData> {
    throwIfAborted(options.signal, 'CloudKit read cancelled');
    const [tasks, projects, sections, areas, people, settingsRecords] = await Promise.all([
        runCloudKitOperation(
            'fetchAllRecords:task',
            () => CloudKitSync!.fetchAllRecords(RECORD_TYPES.task),
            options.signal,
            'CloudKit read cancelled',
        ),
        runCloudKitOperation(
            'fetchAllRecords:project',
            () => CloudKitSync!.fetchAllRecords(RECORD_TYPES.project),
            options.signal,
            'CloudKit read cancelled',
        ),
        runCloudKitOperation(
            'fetchAllRecords:section',
            () => CloudKitSync!.fetchAllRecords(RECORD_TYPES.section),
            options.signal,
            'CloudKit read cancelled',
        ),
        runCloudKitOperation(
            'fetchAllRecords:area',
            () => CloudKitSync!.fetchAllRecords(RECORD_TYPES.area),
            options.signal,
            'CloudKit read cancelled',
        ),
        runCloudKitOperation(
            'fetchAllRecords:person',
            () => CloudKitSync!.fetchAllRecords(RECORD_TYPES.person),
            options.signal,
            'CloudKit read cancelled',
        ),
        runCloudKitOperation(
            'fetchAllRecords:settings',
            () => CloudKitSync!.fetchAllRecords(RECORD_TYPES.settings),
            options.signal,
            'CloudKit read cancelled',
        ),
    ]);


    let settings: Record<string, unknown> = {};
    if (Array.isArray(settingsRecords) && settingsRecords.length > 0) {
        const settingsRecord = settingsRecords[0];
        if (settingsRecord?.payload && typeof settingsRecord.payload === 'object') {
            settings = settingsRecord.payload as Record<string, unknown>;
        }
    }


    const changeToken = await AsyncStorage.getItem(CLOUDKIT_CHANGE_TOKEN_KEY);
    if (!changeToken) {

        try {
            const result: ChangeResult = await runCloudKitOperation(
                'fetchChanges',
                () => CloudKitSync!.fetchChanges(null),
                options.signal,
                'CloudKit read cancelled',
            );
            if (result.changeToken) {
                await AsyncStorage.setItem(CLOUDKIT_CHANGE_TOKEN_KEY, result.changeToken);
            }
        } catch {

        }
    }


    return {
        tasks: Array.isArray(tasks) ? tasks : [],
        projects: Array.isArray(projects) ? projects : [],
        sections: Array.isArray(sections) ? sections : [],
        areas: Array.isArray(areas) ? areas : [],
        people: Array.isArray(people) ? people : [],
        settings,
    } as unknown as AppData;
}

async function deletePurgedRecords(data: AppData, options: CloudKitOperationOptions = {}): Promise<void> {

    const purgedTaskIDs = (data.tasks ?? []).filter((t) => t.purgedAt).map((t) => t.id);
    const purgedProjectIDs = (data.projects ?? []).filter((p) => (p as any).purgedAt).map((p) => p.id);

    const deletePromises: Promise<boolean>[] = [];
    if (purgedTaskIDs.length > 0) {
        deletePromises.push(
            runCloudKitOperation(
                'deleteRecords:task',
                () => CloudKitSync!.deleteRecords(RECORD_TYPES.task, purgedTaskIDs),
                options.signal,
                'CloudKit write cancelled',
            ),
        );
    }
    if (purgedProjectIDs.length > 0) {
        deletePromises.push(
            runCloudKitOperation(
                'deleteRecords:project',
                () => CloudKitSync!.deleteRecords(RECORD_TYPES.project, purgedProjectIDs),
                options.signal,
                'CloudKit write cancelled',
            ),
        );
    }

    if (deletePromises.length > 0) {
        await Promise.all(deletePromises);
    }
}
