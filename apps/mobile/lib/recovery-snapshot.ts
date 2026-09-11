import { Directory, File, Paths } from 'expo-file-system';
import {
    countActiveRecords,
    flushPendingSave,
    isSandboxMode,
    serializeBackupData,
    useTaskStore,
    type AppData,
} from '@mindwtr/core';

import * as FileSystem from './file-system';
import { logInfo } from './app-log';
import { mobileStorage } from './storage-adapter';

/**
 * The recovery-snapshot cluster, split out of data-transfer.ts so the capture path can reach
 * it without that module's four import parsers (~150KB of source). Metro does not tree-shake,
 * so one import of data-transfer.ts evaluated every importer when the capture sheet mounted
 * (A-05).
 */
const SNAPSHOT_DIR_NAME = 'snapshots';
export const SNAPSHOT_FILE_PATTERN = /^data\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})(?:\.(\d{3})(?:\.(\d+))?)?\.snapshot\.json$/u;
const MAX_LOCAL_SNAPSHOTS = 5;
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
const buildSnapshotFileName = (date: Date = new Date(), collisionIndex = 0): string => {
    const iso = date.toISOString();
    const [datePart, timePartWithZone] = iso.split('T');
    const safeTime = String(timePartWithZone || '00:00:00.000Z')
        .replace(/Z$/u, '')
        .replace(/:/gu, '-');
    const collisionSuffix = collisionIndex > 0 ? `.${collisionIndex}` : '';
    return `data.${datePart}T${safeTime}${collisionSuffix}.snapshot.json`;
};
export const listSnapshotEntries = (directory: Directory): Array<{ name: string; uri: string }> => {
    if (isSandboxMode()) return [];
    if (!directory.exists) return [];
    return directory
        .list()
        .map((entry) => {
            const uri = String(entry.uri || '');
            const name = uri.split('/').pop() || '';
            const match = name.match(SNAPSHOT_FILE_PATTERN);
            if (!match) return null;
            return {
                name,
                uri,
                timestampKey: `${match[1]}.${match[2] ?? '000'}`,
                collisionIndex: Number(match[3] ?? 0),
            };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        .sort((left, right) =>
            right.timestampKey.localeCompare(left.timestampKey)
            || right.collisionIndex - left.collisionIndex
        )
        .map(({ name, uri }) => ({ name, uri }));
};
export const pruneSnapshots = (directory: Directory): void => {
    if (isSandboxMode()) return;
    const entries = listSnapshotEntries(directory);
    entries.slice(MAX_LOCAL_SNAPSHOTS).forEach((entry) => {
        try {
            const file = new File(entry.uri);
            if (file.exists) {
                file.delete();
            }
        } catch {
            // Ignore best-effort cleanup failures.
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
            // Ignore best-effort cleanup failures.
        }
        throw error;
    }
    pruneSnapshots(directory);
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
