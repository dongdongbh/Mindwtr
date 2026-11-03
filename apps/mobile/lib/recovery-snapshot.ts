import { Directory, File, Paths } from 'expo-file-system';
import {
    buildRecoverySnapshotFileName,
    countActiveRecords,
    flushPendingSave,
    isSandboxMode,
    RECOVERY_SNAPSHOT_FILE_PATTERN,
    recoverySnapshotNamesToPrune,
    serializeBackupData,
    sortRecoverySnapshotNames,
    useTaskStore,
    type AppData,
} from '@mindwtr/core';

import * as FileSystem from './file-system';
import { logInfo } from './app-log';
import { mobileStorage } from './storage-adapter';


const SNAPSHOT_DIR_NAME = 'snapshots';
export const SNAPSHOT_FILE_PATTERN = RECOVERY_SNAPSHOT_FILE_PATTERN;
const SNAPSHOT_PENDING_FILE_NAME = 'data.pending.snapshot.tmp';
const MAX_SNAPSHOT_NAME_COLLISIONS = 100;

export const getLocalChangeAt = (): number => useTaskStore.getState().lastDataChangeAt;
const normalizeBaseUri = (value?: string | null): string | null => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return null;
    return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
};
export const getSnapshotDirectory = (): Directory | null => {
    if (isSandboxMode()) return null;
    const baseUri = normalizeBaseUri(Paths.document?.uri ?? FileSystem.documentDirectory);
    if (!baseUri) return null;
    return new Directory(`${baseUri}/${SNAPSHOT_DIR_NAME}`);
};
const buildSnapshotFileName = buildRecoverySnapshotFileName;
export const listSnapshotEntries = (directory: Directory): Array<{ name: string; uri: string }> => {
    if (isSandboxMode()) return [];
    if (!directory.exists) return [];
    const uris = new Map<string, string>();
    for (const entry of directory.list()) {
        const uri = String(entry.uri || '');
        uris.set(uri.split('/').pop() || '', uri);
    }
    return sortRecoverySnapshotNames([...uris.keys()]).map((name) => ({ name, uri: uris.get(name)! }));
};
export const pruneSnapshots = (directory: Directory, protect: readonly string[] = []): void => {
    if (isSandboxMode()) return;
    const entries = listSnapshotEntries(directory);
    const pruned = new Set(recoverySnapshotNamesToPrune(entries.map((entry) => entry.name), protect));
    entries.filter((entry) => pruned.has(entry.name)).forEach((entry) => {
        try {
            const file = new File(entry.uri);
            if (file.exists) {
                file.delete();
            }
        } catch {

        }
    });
};
export const toCountExtra = (data: AppData): Record<string, string> => {
    const counts = countActiveRecords(data);
    return {
        tasks: String(counts.tasks),
        projects: String(counts.projects),
        sections: String(counts.sections),
        areas: String(counts.areas),
        people: String(counts.people),
    };
};
export const saveCurrentDataSnapshot = async (data: AppData): Promise<string> => {
    if (isSandboxMode()) throw new Error('Unavailable in sandbox');
    void logInfo('Recovery snapshot started', {
        scope: 'transfer',
        extra: {
            operation: 'snapshot',
            source: 'local',
        },
    });
    const directory = getSnapshotDirectory();
    if (!directory) {
        throw new Error('Snapshot storage is unavailable on this device.');
    }
    directory.create({ intermediates: true, idempotent: true });
    const snapshotAt = new Date();
    let collisionIndex = 0;
    let fileName = buildSnapshotFileName(snapshotAt);
    let file = new File(`${directory.uri}/${fileName}`);
    while (file.exists) {
        collisionIndex += 1;
        if (collisionIndex > MAX_SNAPSHOT_NAME_COLLISIONS) {
            throw new Error('Snapshot storage already holds too many snapshots from this instant.');
        }
        fileName = buildSnapshotFileName(snapshotAt, collisionIndex);
        file = new File(`${directory.uri}/${fileName}`);
    }
    const pending = new File(`${directory.uri}/${SNAPSHOT_PENDING_FILE_NAME}`);
    try {
        pending.create({ intermediates: true, overwrite: true });
        pending.write(serializeBackupData(data));
        pending.move(file);
    } catch (error) {
        try {
            if (pending.exists) {
                pending.delete();
            }
        } catch {

        }
        throw error;
    }
    pruneSnapshots(directory, [fileName]);
    void logInfo('Recovery snapshot complete', {
        scope: 'transfer',
        extra: {
            operation: 'snapshot',
            source: 'local',
            ...toCountExtra(data),
        },
    });
    return fileName;
};
export const createMobileRecoverySnapshot = async (): Promise<string> => {
    if (isSandboxMode()) throw new Error('Unavailable in sandbox');
    await flushPendingSave();
    const localSnapshotChangeAt = getLocalChangeAt();
    const currentData = await mobileStorage.getData();
    if (getLocalChangeAt() !== localSnapshotChangeAt) {
        throw new Error('Local data changed while creating the recovery snapshot. Try again.');
    }
    const snapshotName = await saveCurrentDataSnapshot(currentData);
    if (getLocalChangeAt() !== localSnapshotChangeAt) {
        throw new Error('Local data changed while creating the recovery snapshot. Try again.');
    }
    return snapshotName;
};
