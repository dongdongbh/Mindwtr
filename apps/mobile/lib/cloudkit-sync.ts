/**
 * CloudKit sync orchestrator.
 *
 * Bridges the native CloudKitSync Expo module to the sync-service.ts
 * SyncCycleIO interface. CloudKit acts as a readRemote/writeRemote backend
 * alongside file, webdav, and cloud — the existing TypeScript merge engine
 * handles conflict resolution.
 */
import { requireNativeModule, type NativeModule } from 'expo-modules-core';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { AppData } from '@mindwtr/core';
import { logInfo, logWarn, logError } from './app-log';
import {
    CLOUDKIT_CHANGE_TOKEN_KEY,
    CLOUDKIT_SEEDED_KEY,
    CLOUDKIT_ZONE_CREATED_KEY,
} from './sync-constants';

// MARK: - Types

type ChangeResult = {
    records: Record<string, Array<Record<string, unknown>>>;
    deletedIDs: Record<string, string[]>;
    changeToken?: string;
    tokenExpired?: boolean;
};

// Type-safe interface for the native module's async functions.
interface CloudKitSyncModule extends NativeModule {
    getAccountStatus(): Promise<string>;
    ensureZone(): Promise<void>;
    ensureSubscription(): Promise<void>;
    fetchChanges(changeToken: string | null): Promise<ChangeResult>;
    fetchAllRecords(recordType: string): Promise<Array<Record<string, unknown>>>;
    saveRecords(recordType: string, json: string): Promise<string[]>;
    deleteRecords(recordType: string, ids: string[]): Promise<boolean>;
    consumePendingRemoteChange(): Promise<boolean>;
}

// The native module — loaded via requireNativeModule (Expo SDK 54+).
// Will throw on non-iOS platforms, so we guard with a try/catch.
let CloudKitSync: CloudKitSyncModule | null = null;
try {
    CloudKitSync = requireNativeModule<CloudKitSyncModule>('CloudKitSync');
} catch {
    // Not available — Android or missing native build
}

// Record type names (must match CloudKitRecordMapper.swift)
const RECORD_TYPES = {
    task: 'MindwtrTask',
    project: 'MindwtrProject',
    section: 'MindwtrSection',
    area: 'MindwtrArea',
    settings: 'MindwtrSettings',
} as const;

type AccountStatus = 'available' | 'noAccount' | 'restricted' | 'temporarilyUnavailable' | 'unknown';

// MARK: - Module availability

export const isCloudKitAvailable = (): boolean => {
    return CloudKitSync != null;
};

// MARK: - Account check

export const getCloudKitAccountStatus = async (): Promise<AccountStatus> => {
    if (!isCloudKitAvailable()) return 'unknown';
    try {
        return await CloudKitSync!.getAccountStatus() as AccountStatus;
    } catch {
        return 'unknown';
    }
};

// MARK: - Setup

export const ensureCloudKitReady = async (): Promise<void> => {
    if (!isCloudKitAvailable()) {
        throw new Error('CloudKit is not available on this platform');
    }

    const zoneCreated = await AsyncStorage.getItem(CLOUDKIT_ZONE_CREATED_KEY);
    if (!zoneCreated) {
        await CloudKitSync!.ensureZone();
        await AsyncStorage.setItem(CLOUDKIT_ZONE_CREATED_KEY, '1');
        void logInfo('CloudKit zone created', { scope: 'cloudkit' });
    }

    try {
        await CloudKitSync!.ensureSubscription();
    } catch (error) {
        // Subscription failures are non-fatal — we still have timer-based sync
        void logWarn('CloudKit subscription setup failed (non-fatal)', {
            scope: 'cloudkit',
            extra: { error: error instanceof Error ? error.message : String(error) },
        });
    }
};

// MARK: - Read Remote (for SyncCycleIO.readRemote)

export const readRemoteCloudKit = async (): Promise<AppData | null> => {
    if (!isCloudKitAvailable()) return null;

    try {
        const changeToken = await AsyncStorage.getItem(CLOUDKIT_CHANGE_TOKEN_KEY);

        // Try incremental fetch first
        if (changeToken) {
            const result: ChangeResult = await CloudKitSync!.fetchChanges(changeToken);

            if (result.tokenExpired) {
                void logInfo('CloudKit change token expired; doing full fetch', { scope: 'cloudkit' });
                await AsyncStorage.removeItem(CLOUDKIT_CHANGE_TOKEN_KEY);
                return await fullFetch();
            }

            // Save new token
            if (result.changeToken) {
                await AsyncStorage.setItem(CLOUDKIT_CHANGE_TOKEN_KEY, result.changeToken);
            }

            // If no changes, return null to skip merge
            const hasChanges = Object.values(result.records).some(arr => arr.length > 0)
                || Object.values(result.deletedIDs).some(arr => arr.length > 0);

            if (!hasChanges) {
                return null;
            }

            // For incremental changes, we need to do a full fetch to get the complete
            // remote state for three-way merge. The change result only tells us what
            // changed, but our merge engine needs the full remote AppData.
            return await fullFetch();
        }

        // No token — first sync, do full fetch
        return await fullFetch();
    } catch (error) {
        void logError(error, { scope: 'cloudkit', extra: { operation: 'readRemote' } });
        throw error;
    }
};

// MARK: - Write Remote (for SyncCycleIO.writeRemote)

export const writeRemoteCloudKit = async (data: AppData): Promise<void> => {
    if (!isCloudKitAvailable()) return;

    try {
        // Save each entity type
        const allTasks = Array.isArray(data.tasks) ? data.tasks : [];
        const allProjects = Array.isArray(data.projects) ? data.projects : [];
        const allSections = Array.isArray(data.sections) ? data.sections : [];
        const allAreas = Array.isArray(data.areas) ? data.areas : [];

        const savePromises: Promise<string[]>[] = [];

        if (allTasks.length > 0) {
            savePromises.push(
                CloudKitSync!.saveRecords(RECORD_TYPES.task, JSON.stringify(allTasks))
            );
        }
        if (allProjects.length > 0) {
            savePromises.push(
                CloudKitSync!.saveRecords(RECORD_TYPES.project, JSON.stringify(allProjects))
            );
        }
        if (allSections.length > 0) {
            savePromises.push(
                CloudKitSync!.saveRecords(RECORD_TYPES.section, JSON.stringify(allSections))
            );
        }
        if (allAreas.length > 0) {
            savePromises.push(
                CloudKitSync!.saveRecords(RECORD_TYPES.area, JSON.stringify(allAreas))
            );
        }

        // Save settings as a single record
        if (data.settings && Object.keys(data.settings).length > 0) {
            const settingsRecord = [{
                id: 'settings',
                payload: data.settings,
                updatedAt: new Date().toISOString(),
            }];
            savePromises.push(
                CloudKitSync!.saveRecords(RECORD_TYPES.settings, JSON.stringify(settingsRecord))
            );
        }

        const results = await Promise.all(savePromises);
        const allConflicts = results.flat();

        if (allConflicts.length > 0) {
            void logWarn(`CloudKit save had ${allConflicts.length} conflicts (will resolve on next sync)`, {
                scope: 'cloudkit',
                extra: { conflictIDs: allConflicts.slice(0, 10).join(',') },
            });
        }

        // Delete purged records from CloudKit
        await deletePurgedRecords(data);

        // Only advance the change token if no conflicts occurred.
        // When conflicts exist, the conflicted records weren't actually written,
        // so advancing the token would cause the next sync to skip them.
        if (allConflicts.length === 0) {
            const changeResult: ChangeResult = await CloudKitSync!.fetchChanges(
                await AsyncStorage.getItem(CLOUDKIT_CHANGE_TOKEN_KEY)
            );
            if (changeResult.changeToken) {
                await AsyncStorage.setItem(CLOUDKIT_CHANGE_TOKEN_KEY, changeResult.changeToken);
            }
        }

        void logInfo('CloudKit write complete', {
            scope: 'cloudkit',
            extra: { conflicts: String(allConflicts.length) },
        });
    } catch (error) {
        void logError(error, { scope: 'cloudkit', extra: { operation: 'writeRemote' } });
        throw error;
    }
};

// MARK: - Seed (first-time upload from local data)

let seedingInFlight: Promise<void> | null = null;

export const seedCloudKitFromLocal = async (data: AppData): Promise<void> => {
    const seeded = await AsyncStorage.getItem(CLOUDKIT_SEEDED_KEY);
    if (seeded) return;

    // Prevent concurrent seed writes — second caller awaits the first.
    if (seedingInFlight) {
        await seedingInFlight;
        return;
    }

    seedingInFlight = (async () => {
        void logInfo('Seeding CloudKit from local data', { scope: 'cloudkit' });
        // Set the flag before writing so a crash mid-write doesn't re-seed stale data.
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

// MARK: - Push Notification Subscription

let changeSubscription: { remove: () => void } | null = null;

export const subscribeToCloudKitChanges = (onChanged: () => void): (() => void) => {
    if (!isCloudKitAvailable() || !CloudKitSync) return () => {};

    // Remove any existing subscription
    changeSubscription?.remove();

    // Expo SDK 54+: NativeModule from requireNativeModule has addListener built-in
    changeSubscription = (CloudKitSync as any).addListener('onRemoteChange', () => {
        void logInfo('CloudKit remote change notification received', { scope: 'cloudkit' });
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
                extra: { error: error instanceof Error ? error.message : String(error) },
            });
        });

    return () => {
        changeSubscription?.remove();
        changeSubscription = null;
    };
};

// MARK: - Helpers

async function fullFetch(): Promise<AppData> {
    const [tasks, projects, sections, areas, settingsRecords] = await Promise.all([
        CloudKitSync!.fetchAllRecords(RECORD_TYPES.task),
        CloudKitSync!.fetchAllRecords(RECORD_TYPES.project),
        CloudKitSync!.fetchAllRecords(RECORD_TYPES.section),
        CloudKitSync!.fetchAllRecords(RECORD_TYPES.area),
        CloudKitSync!.fetchAllRecords(RECORD_TYPES.settings),
    ]);

    // Extract settings from the single settings record
    let settings: Record<string, unknown> = {};
    if (Array.isArray(settingsRecords) && settingsRecords.length > 0) {
        const settingsRecord = settingsRecords[0];
        if (settingsRecord?.payload && typeof settingsRecord.payload === 'object') {
            settings = settingsRecord.payload as Record<string, unknown>;
        }
    }

    // Save change token from the fetch
    const changeToken = await AsyncStorage.getItem(CLOUDKIT_CHANGE_TOKEN_KEY);
    if (!changeToken) {
        // After a full fetch, get the current token for future incremental fetches
        try {
            const result: ChangeResult = await CloudKitSync!.fetchChanges(null);
            if (result.changeToken) {
                await AsyncStorage.setItem(CLOUDKIT_CHANGE_TOKEN_KEY, result.changeToken);
            }
        } catch {
            // Non-fatal — we'll get the token on next sync
        }
    }

    // CloudKit records are untyped JSON — cast through unknown to AppData.
    // The merge engine validates shape downstream.
    return {
        tasks: Array.isArray(tasks) ? tasks : [],
        projects: Array.isArray(projects) ? projects : [],
        sections: Array.isArray(sections) ? sections : [],
        areas: Array.isArray(areas) ? areas : [],
        settings,
    } as unknown as AppData;
}

async function deletePurgedRecords(data: AppData): Promise<void> {
    // Find records with purgedAt set — these should be removed from CloudKit entirely
    const purgedTaskIDs = (data.tasks ?? [])
        .filter(t => t.purgedAt)
        .map(t => t.id);
    const purgedProjectIDs = (data.projects ?? [])
        .filter(p => (p as any).purgedAt)
        .map(p => p.id);

    const deletePromises: Promise<boolean>[] = [];
    if (purgedTaskIDs.length > 0) {
        deletePromises.push(CloudKitSync!.deleteRecords(RECORD_TYPES.task, purgedTaskIDs));
    }
    if (purgedProjectIDs.length > 0) {
        deletePromises.push(CloudKitSync!.deleteRecords(RECORD_TYPES.project, purgedProjectIDs));
    }

    if (deletePromises.length > 0) {
        await Promise.all(deletePromises);
    }
}
