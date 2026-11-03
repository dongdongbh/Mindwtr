


import { CLOUDKIT_ATTACHMENT_RECORD_TYPE, parseCloudKitRetryAfterMs, type AppData } from '@mindwtr/core';
import { isTauriRuntime } from './runtime';
import { logInfo, logWarn, logError } from './app-log';
import { invokeNative as invokeTauriNative } from './tauri-invoke';

const invokeNative = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    try {
        return await invokeTauriNative<T>(command, args);
    } catch (error) {
        const retryAfterMs = parseCloudKitRetryAfterMs(error);
        if (retryAfterMs !== null) {
            void logInfo('CloudKit retry interval received', {
                scope: 'cloudkit',
                force: true,
                extra: { releaseCheck: 'v1.3.3/cloudkit-retry-hint', operation: command, retryAfterMs },
            });
        }
        throw error;
    }
};


type ChangeResult = {
    records: Record<string, Array<Record<string, unknown>>>;
    deletedIDs: Record<string, string[]>;
    changeToken?: string;
    tokenExpired?: boolean;
};

type AccountStatus = 'available' | 'noAccount' | 'restricted' | 'temporarilyUnavailable' | 'unknown' | 'unsupported';

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

const getCloudKitErrorMessage = (error: unknown): string | undefined => {
    if (error instanceof Error) return error.message;
    if (!error || typeof error !== 'object' || !('message' in error)) return undefined;
    return typeof error.message === 'string' ? error.message : undefined;
};

export const isCloudKitAttachmentNotFoundError = (
    error: unknown,
): boolean => (
    error instanceof CloudKitAttachmentNotFoundError
    || getCloudKitErrorCode(error) === CLOUDKIT_ATTACHMENT_NOT_FOUND_CODE
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


const RECORD_TYPES = {
    task: 'MindwtrTask',
    project: 'MindwtrProject',
    section: 'MindwtrSection',
    area: 'MindwtrArea',
    person: 'MindwtrPerson',
    settings: 'MindwtrSettings',
} as const;


const CLOUDKIT_CHANGE_TOKEN_KEY = '@mindwtr_cloudkit_change_token';
const CLOUDKIT_SEEDED_KEY = '@mindwtr_cloudkit_seeded';
const CLOUDKIT_ZONE_CREATED_KEY = '@mindwtr_cloudkit_zone_created';


const isMacOS = (): boolean => {
    if (typeof navigator === 'undefined') return false;
    const src = `${navigator.platform || ''} ${navigator.userAgent || ''}`.toLowerCase();
    return src.includes('mac');
};

export const isCloudKitAvailable = (): boolean => {
    return isTauriRuntime() && isMacOS();
};


export const getCloudKitAccountStatus = async (): Promise<AccountStatus> => {
    if (!isCloudKitAvailable()) return 'unsupported';
    try {
        return (await invokeNative<string>('cloudkit_account_status')) as AccountStatus;
    } catch {
        return 'unknown';
    }
};


export const ensureCloudKitReady = async (): Promise<void> => {
    if (!isCloudKitAvailable()) {
        throw new Error('CloudKit is not available on this platform');
    }

    const zoneCreated = localStorage.getItem(CLOUDKIT_ZONE_CREATED_KEY);
    if (!zoneCreated) {
        await invokeNative('cloudkit_ensure_zone');
        localStorage.setItem(CLOUDKIT_ZONE_CREATED_KEY, '1');
        void logInfo('CloudKit zone created', { scope: 'cloudkit' });
    }

    try {
        await invokeNative('cloudkit_ensure_subscription');
        await invokeNative('cloudkit_register_for_notifications');
    } catch (error) {

        void logWarn('CloudKit subscription setup failed (non-fatal)', {
            scope: 'cloudkit',
            extra: { error: error instanceof Error ? error.message : String(error) },
        });
    }
};


export const readRemoteCloudKit = async (): Promise<AppData | null> => {
    if (!isCloudKitAvailable()) return null;
    remoteEmptyRecordTypes.clear();

    try {
        const changeToken = localStorage.getItem(CLOUDKIT_CHANGE_TOKEN_KEY);


        if (changeToken) {
            const result = await invokeNative<ChangeResult>('cloudkit_fetch_changes', {
                changeToken,
            });

            if (result.tokenExpired) {
                void logInfo('CloudKit change token expired; doing full fetch', {
                    scope: 'cloudkit',
                });
                localStorage.removeItem(CLOUDKIT_CHANGE_TOKEN_KEY);
                return await fullFetch();
            }


            if (result.changeToken) {
                localStorage.setItem(CLOUDKIT_CHANGE_TOKEN_KEY, result.changeToken);
            }


            const hasChanges =
                Object.values(result.records).some((arr) => arr.length > 0) ||
                Object.values(result.deletedIDs).some((arr) => arr.length > 0);

            if (!hasChanges) return null;


            return await fullFetch();
        }


        return await fullFetch();
    } catch (error) {
        void logError(error instanceof Error ? error : new Error(String(error)), {
            scope: 'cloudkit',
            extra: { operation: 'readRemote' },
        });
        throw error;
    }
};


const remoteEmptyRecordTypes = new Set<string>();

const saveRecordsOfType = async (
    recordType: string,
    records: unknown[],
): Promise<{ conflictIDs: string[]; savedCount?: number }> => {
    const assumeNew = remoteEmptyRecordTypes.delete(recordType);
    return await invokeNative<{ conflictIDs: string[]; savedCount?: number }>('cloudkit_save_records', {
        recordType,
        recordsJson: JSON.stringify(records),
        assumeNew,
    });
};

export const writeRemoteCloudKit = async (data: AppData): Promise<void> => {
    if (!isCloudKitAvailable()) return;

    try {
        const allTasks = Array.isArray(data.tasks) ? data.tasks : [];
        const allProjects = Array.isArray(data.projects) ? data.projects : [];
        const allSections = Array.isArray(data.sections) ? data.sections : [];
        const allAreas = Array.isArray(data.areas) ? data.areas : [];
        const allPeople = Array.isArray(data.people) ? data.people : [];

        const saveResults: { conflictIDs: string[]; savedCount?: number }[] = [];

        if (allTasks.length > 0) {
            saveResults.push(
                await saveRecordsOfType(RECORD_TYPES.task, allTasks),
            );
        }
        if (allProjects.length > 0) {
            saveResults.push(
                await saveRecordsOfType(RECORD_TYPES.project, allProjects),
            );
        }
        if (allSections.length > 0) {
            saveResults.push(
                await saveRecordsOfType(RECORD_TYPES.section, allSections),
            );
        }
        if (allAreas.length > 0) {
            saveResults.push(
                await saveRecordsOfType(RECORD_TYPES.area, allAreas),
            );
        }
        if (allPeople.length > 0) {
            saveResults.push(
                await saveRecordsOfType(RECORD_TYPES.person, allPeople),
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
                await saveRecordsOfType(RECORD_TYPES.settings, settingsRecord),
            );
        }

        const allConflicts = saveResults.flatMap((r) => r.conflictIDs ?? []);
        const savedCount = saveResults.reduce((sum, r) => sum + (r.savedCount ?? 0), 0);
        if (savedCount > 0) {
            void logInfo('CloudKit records saved in small batches', {
                scope: 'cloudkit',
                force: true,
                extra: { releaseCheck: 'v1.3.4/cloudkit-small-save-batches', savedCount },
            });
        }

        if (allConflicts.length > 0) {
            void logWarn(`CloudKit save had ${allConflicts.length} conflicts (will resolve on next sync)`, {
                scope: 'cloudkit',
                extra: { conflictIDs: allConflicts.slice(0, 10).join(',') },
            });
        }


        await deletePurgedRecords(data);


        if (allConflicts.length === 0) {
            const changeResult = await invokeNative<ChangeResult>('cloudkit_fetch_changes', {
                changeToken: localStorage.getItem(CLOUDKIT_CHANGE_TOKEN_KEY) ?? null,
            });
            if (changeResult.changeToken) {
                localStorage.setItem(CLOUDKIT_CHANGE_TOKEN_KEY, changeResult.changeToken);
            }
        }

        void logInfo('CloudKit write complete', {
            scope: 'cloudkit',
            extra: { conflicts: String(allConflicts.length), releaseCheck: 'v1.3.3/cloudkit-large-library-write' },
        });
    } catch (error) {
        void logError(error instanceof Error ? error : new Error(String(error)), {
            scope: 'cloudkit',
            extra: { operation: 'writeRemote' },
        });
        throw error;
    }
};


export const saveCloudKitAttachmentAsset = async (
    recordName: string,
    filePath: string,
    metadata: CloudKitAttachmentMetadata,
): Promise<CloudKitAttachmentMetadata> => {
    if (!isCloudKitAvailable()) throw new Error('CloudKit is not available on this platform');
    return await invokeNative<CloudKitAttachmentMetadata>('cloudkit_save_attachment_asset', {
        recordName,
        filePath,
        metadataJson: JSON.stringify(metadata),
    });
};

export const fetchCloudKitAttachmentAsset = async (
    recordName: string,
    targetPath: string,
): Promise<CloudKitAttachmentMetadata> => {
    if (!isCloudKitAvailable()) throw new Error('CloudKit is not available on this platform');
    try {
        return await invokeNative<CloudKitAttachmentMetadata>('cloudkit_fetch_attachment_asset', {
            recordName,
            targetPath,
        });
    } catch (error) {
        if (!isCloudKitAttachmentNotFoundError(error)) throw error;
        if (error instanceof CloudKitAttachmentNotFoundError) throw error;
        throw new CloudKitAttachmentNotFoundError(getCloudKitErrorMessage(error), error);
    }
};

export const deleteCloudKitAttachmentAssets = async (recordNames: string[]): Promise<void> => {
    if (!isCloudKitAvailable()) return;
    if (recordNames.length === 0) return;
    await invokeNative<boolean>('cloudkit_delete_records', {
        recordType: CLOUDKIT_ATTACHMENT_RECORD_TYPE,
        recordIds: recordNames,
    });
};

let seedingInFlight: Promise<void> | null = null;

export const seedCloudKitFromLocal = async (data: AppData): Promise<void> => {
    const seeded = localStorage.getItem(CLOUDKIT_SEEDED_KEY);
    if (seeded) return;

    if (seedingInFlight) {
        await seedingInFlight;
        return;
    }

    seedingInFlight = (async () => {
        void logInfo('Seeding CloudKit from local data', { scope: 'cloudkit' });
        localStorage.setItem(CLOUDKIT_SEEDED_KEY, '1');
        await writeRemoteCloudKit(data);
        void logInfo('CloudKit seed complete', { scope: 'cloudkit' });
    })();

    try {
        await seedingInFlight;
    } finally {
        seedingInFlight = null;
    }
};


export const consumePendingRemoteChange = async (): Promise<boolean> => {
    if (!isCloudKitAvailable()) return false;
    try {
        return await invokeNative<boolean>('cloudkit_consume_pending_remote_change');
    } catch {
        return false;
    }
};


async function fullFetch(): Promise<AppData> {
    const [tasks, projects, sections, areas, people, settingsRecords] = await Promise.all([
        invokeNative<Array<Record<string, unknown>>>('cloudkit_fetch_all_records', { recordType: RECORD_TYPES.task }),
        invokeNative<Array<Record<string, unknown>>>('cloudkit_fetch_all_records', { recordType: RECORD_TYPES.project }),
        invokeNative<Array<Record<string, unknown>>>('cloudkit_fetch_all_records', { recordType: RECORD_TYPES.section }),
        invokeNative<Array<Record<string, unknown>>>('cloudkit_fetch_all_records', { recordType: RECORD_TYPES.area }),
        invokeNative<Array<Record<string, unknown>>>('cloudkit_fetch_all_records', { recordType: RECORD_TYPES.person }),
        invokeNative<Array<Record<string, unknown>>>('cloudkit_fetch_all_records', {
            recordType: RECORD_TYPES.settings,
        }),
    ]);

    const fetchedByType: Array<[string, unknown]> = [
        [RECORD_TYPES.task, tasks], [RECORD_TYPES.project, projects], [RECORD_TYPES.section, sections],
        [RECORD_TYPES.area, areas], [RECORD_TYPES.person, people], [RECORD_TYPES.settings, settingsRecords],
    ];
    for (const [recordType, records] of fetchedByType) {
        if (Array.isArray(records) && records.length === 0) remoteEmptyRecordTypes.add(recordType);
    }


    let settings: Record<string, unknown> = {};
    if (Array.isArray(settingsRecords) && settingsRecords.length > 0) {
        const settingsRecord = settingsRecords[0];
        if (settingsRecord?.payload && typeof settingsRecord.payload === 'object') {
            settings = settingsRecord.payload as Record<string, unknown>;
        }
    }


    const changeToken = localStorage.getItem(CLOUDKIT_CHANGE_TOKEN_KEY);
    if (!changeToken) {
        try {
            const result = await invokeNative<ChangeResult>('cloudkit_fetch_changes', {
                changeToken: null,
            });
            if (result.changeToken) {
                localStorage.setItem(CLOUDKIT_CHANGE_TOKEN_KEY, result.changeToken);
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

async function deletePurgedRecords(data: AppData): Promise<void> {
    const purgedTaskIDs = (data.tasks ?? []).filter((t) => t.purgedAt).map((t) => t.id);
    const purgedProjectIDs = (data.projects ?? []).filter((p) => (p as any).purgedAt).map((p) => p.id);

    const deletePromises: Promise<boolean>[] = [];
    if (purgedTaskIDs.length > 0) {
        deletePromises.push(
            invokeNative('cloudkit_delete_records', {
                recordType: RECORD_TYPES.task,
                recordIds: purgedTaskIDs,
            }),
        );
    }
    if (purgedProjectIDs.length > 0) {
        deletePromises.push(
            invokeNative('cloudkit_delete_records', {
                recordType: RECORD_TYPES.project,
                recordIds: purgedProjectIDs,
            }),
        );
    }

    if (deletePromises.length > 0) {
        await Promise.all(deletePromises);
    }
}
