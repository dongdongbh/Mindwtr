import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppData } from '@mindwtr/core';
import {
    CLOUDKIT_ATTACHMENT_NOT_FOUND_CODE,
    CloudKitAttachmentNotFoundError,
    ensureCloudKitReady,
    fetchCloudKitAttachmentAsset,
    readRemoteCloudKit,
    writeRemoteCloudKit,
} from './cloudkit-sync';
import { CLOUDKIT_CHANGE_TOKEN_KEY } from './sync-constants';

const currentDir = dirname(fileURLToPath(import.meta.url));
const swiftMapperSource = readFileSync(
    resolve(currentDir, '../modules/cloudkit-sync/ios/CloudKitRecordMapper.swift'),
    'utf8',
);
const swiftModuleSource = readFileSync(
    resolve(currentDir, '../modules/cloudkit-sync/ios/CloudKitSyncModule.swift'),
    'utf8',
);
const macosBridgeSource = readFileSync(
    resolve(currentDir, '../../desktop/src-tauri/src/macos_cloudkit_bridge.m'),
    'utf8',
);

const extractSourceBlock = (source: string, pattern: RegExp, label: string): string => {
    const match = source.match(pattern);
    if (!match?.[1]) throw new Error('Missing ' + label + ' field block');
    return match[1];
};

const {
    asyncStorageGetItem,
    asyncStorageRemoveItem,
    asyncStorageSetItem,
    cloudKitSync,
} = vi.hoisted(() => ({
    asyncStorageGetItem: vi.fn(async (_key: string) => null as string | null),
    asyncStorageRemoveItem: vi.fn(async (_key: string) => undefined),
    asyncStorageSetItem: vi.fn(async (_key: string, _value: string) => undefined),
    cloudKitSync: {
        addListener: vi.fn(),
        consumePendingRemoteChange: vi.fn(async () => false),
        deleteRecords: vi.fn(),
        ensureSubscription: vi.fn(async () => undefined),
        ensureZone: vi.fn(async () => undefined),
        fetchAttachmentAsset: vi.fn(),
        fetchAllRecords: vi.fn(),
        fetchChanges: vi.fn(),
        getAccountStatus: vi.fn(async () => 'available'),
        saveRecords: vi.fn(),
    },
}));

vi.mock('expo-modules-core', () => ({
    requireNativeModule: vi.fn(() => cloudKitSync),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: asyncStorageGetItem,
        removeItem: asyncStorageRemoveItem,
        setItem: asyncStorageSetItem,
    },
}));

vi.mock('./app-log', () => ({
    logError: vi.fn(async () => undefined),
    logInfo: vi.fn(async () => undefined),
    logWarn: vi.fn(async () => undefined),
}));

const createPendingPromise = <T,>() => new Promise<T>(() => undefined);

describe('CloudKit native field specs', () => {
    it('keeps the native and TypeScript terminal attachment code aligned', () => {
        expect(swiftModuleSource).toContain(`"${CLOUDKIT_ATTACHMENT_NOT_FOUND_CODE}"`);
    });

    it('maps project purgedAt in Swift and macOS CloudKit mappers', () => {
        const swiftProjectFields = extractSourceBlock(
            swiftMapperSource,
            /private static let projectFieldSpecs: \[FieldSpec\] = \[([\s\S]*?)\n    \]/,
            'Swift project',
        );
        const macosProjectFields = extractSourceBlock(
            macosBridgeSource,
            /static const MWFieldSpec kProjectFields\[\] = \{([\s\S]*?)\n\};/,
            'macOS project',
        );

        expect(swiftProjectFields).toContain('purgedAt');
        expect(macosProjectFields).toContain('purgedAt');
    });

    it('maps project archive restore metadata in Swift and macOS CloudKit mappers', () => {
        const swiftTaskFields = extractSourceBlock(
            swiftMapperSource,
            /private static let taskFieldSpecs: \[FieldSpec\] = \[([\s\S]*?)\n    \]/,
            'Swift task',
        );
        const swiftSectionFields = extractSourceBlock(
            swiftMapperSource,
            /private static let sectionFieldSpecs: \[FieldSpec\] = \[([\s\S]*?)\n    \]/,
            'Swift section',
        );
        const macosTaskFields = extractSourceBlock(
            macosBridgeSource,
            /static const MWFieldSpec kTaskFields\[\] = \{([\s\S]*?)\n\};/,
            'macOS task',
        );
        const macosSectionFields = extractSourceBlock(
            macosBridgeSource,
            /static const MWFieldSpec kSectionFields\[\] = \{([\s\S]*?)\n\};/,
            'macOS section',
        );

        for (const field of [
            'statusBeforeProjectArchive',
            'completedAtBeforeProjectArchive',
            'isFocusedTodayBeforeProjectArchive',
            'projectArchivedAt',
        ]) {
            expect(swiftTaskFields).toContain(field);
            expect(macosTaskFields).toContain(field);
        }

        for (const field of ['deletedAtBeforeProjectArchive', 'projectArchivedAt']) {
            expect(swiftSectionFields).toContain(field);
            expect(macosSectionFields).toContain(field);
        }
    });
});

describe('cloudkit-sync abort handling', () => {
    beforeEach(() => {
        asyncStorageGetItem.mockReset();
        asyncStorageGetItem.mockResolvedValue(null);
        asyncStorageRemoveItem.mockClear();
        asyncStorageSetItem.mockClear();
        cloudKitSync.addListener.mockClear();
        cloudKitSync.consumePendingRemoteChange.mockClear();
        cloudKitSync.deleteRecords.mockReset();
        cloudKitSync.ensureSubscription.mockReset();
        cloudKitSync.ensureSubscription.mockResolvedValue(undefined);
        cloudKitSync.ensureZone.mockReset();
        cloudKitSync.ensureZone.mockResolvedValue(undefined);
        cloudKitSync.fetchAttachmentAsset.mockReset();
        cloudKitSync.fetchAllRecords.mockReset();
        cloudKitSync.fetchAllRecords.mockResolvedValue([]);
        cloudKitSync.fetchChanges.mockReset();
        cloudKitSync.fetchChanges.mockResolvedValue({ records: {}, deletedIDs: {}, changeToken: 'token-1' });
        cloudKitSync.getAccountStatus.mockReset();
        cloudKitSync.getAccountStatus.mockResolvedValue('available');
        cloudKitSync.saveRecords.mockReset();
        cloudKitSync.saveRecords.mockResolvedValue([]);
    });

    it('rejects CloudKit reads when the sync lifecycle aborts mid-fetch', async () => {
        const controller = new AbortController();
        const abortReason = new Error('Sync lifecycle aborted');
        cloudKitSync.fetchAllRecords.mockImplementation(() => createPendingPromise());

        const promise = readRemoteCloudKit({ signal: controller.signal });
        await Promise.resolve();
        controller.abort(abortReason);

        await expect(promise).rejects.toBe(abortReason);
        expect(cloudKitSync.fetchAllRecords).toHaveBeenCalled();
    });

    it('rejects CloudKit writes when the sync lifecycle aborts mid-save', async () => {
        const controller = new AbortController();
        const abortReason = new Error('Sync lifecycle aborted');
        cloudKitSync.saveRecords.mockImplementation(() => createPendingPromise());

        const promise = writeRemoteCloudKit({
            tasks: [{
                id: 'task-1',
                title: 'Task',
                status: 'inbox',
                tags: [],
                contexts: [],
                createdAt: '2026-05-01T00:00:00.000Z',
                updatedAt: '2026-05-01T00:00:00.000Z',
            }],
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        }, { signal: controller.signal });
        await Promise.resolve();
        controller.abort(abortReason);

        await expect(promise).rejects.toBe(abortReason);
        expect(cloudKitSync.saveRecords).toHaveBeenCalled();
    });

    it('does not start CloudKit setup when the signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort(new Error('Already cancelled'));

        await expect(ensureCloudKitReady({ signal: controller.signal })).rejects.toThrow('Already cancelled');
        expect(cloudKitSync.ensureZone).not.toHaveBeenCalled();
        expect(cloudKitSync.ensureSubscription).not.toHaveBeenCalled();
    });

    it('normalizes the stable native attachment absence code without message matching', async () => {
        const nativeError = Object.assign(new Error('native localized text'), {
            code: CLOUDKIT_ATTACHMENT_NOT_FOUND_CODE,
        });
        cloudKitSync.fetchAttachmentAsset.mockRejectedValue(nativeError);

        let thrown: unknown;
        try {
            await fetchCloudKitAttachmentAsset('record-1', 'file://scratch');
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(CloudKitAttachmentNotFoundError);
        expect(thrown).toMatchObject({
            code: CLOUDKIT_ATTACHMENT_NOT_FOUND_CODE,
            message: 'native localized text',
            cause: nativeError,
        });
    });

    it('preserves transient and legacy untyped CloudKit failures', async () => {
        for (const error of [
            Object.assign(new Error('network unavailable'), { code: 'ERR_UNEXPECTED' }),
            Object.assign(new Error('legacy native error'), { code: 1002 }),
        ]) {
            cloudKitSync.fetchAttachmentAsset.mockRejectedValueOnce(error);
            await expect(fetchCloudKitAttachmentAsset('record-1', 'file://scratch')).rejects.toBe(error);
        }
    });
});

describe('cloudkit-sync change token and purge invariants', () => {
    // Real AsyncStorage semantics: the token the write path reads back is the
    // one the read path stored, so a wrongly-advanced token is observable.
    const storage = new Map<string, string>();

    const makeTask = (id: string, overrides: Record<string, unknown> = {}) => ({
        id,
        title: `Task ${id}`,
        status: 'inbox',
        tags: [],
        contexts: [],
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
        ...overrides,
    });

    const makeAppData = (overrides: Partial<AppData> = {}): AppData => ({
        tasks: [makeTask('task-1')],
        projects: [],
        sections: [],
        areas: [],
        settings: {},
        ...overrides,
    } as unknown as AppData);

    beforeEach(() => {
        storage.clear();
        asyncStorageGetItem.mockReset();
        asyncStorageGetItem.mockImplementation(async (key: string) => storage.get(key) ?? null);
        asyncStorageSetItem.mockReset();
        asyncStorageSetItem.mockImplementation(async (key: string, value: string) => {
            storage.set(key, value);
        });
        asyncStorageRemoveItem.mockReset();
        asyncStorageRemoveItem.mockImplementation(async (key: string) => {
            storage.delete(key);
        });
        cloudKitSync.deleteRecords.mockReset();
        cloudKitSync.deleteRecords.mockResolvedValue(true);
        cloudKitSync.fetchAllRecords.mockReset();
        cloudKitSync.fetchAllRecords.mockResolvedValue([]);
        cloudKitSync.fetchChanges.mockReset();
        cloudKitSync.saveRecords.mockReset();
        cloudKitSync.saveRecords.mockResolvedValue([]);
    });

    it('keeps the change token unchanged when a save reports conflicts', async () => {
        storage.set(CLOUDKIT_CHANGE_TOKEN_KEY, 'token-1');
        cloudKitSync.saveRecords.mockResolvedValue(['task-1']);
        cloudKitSync.fetchChanges.mockResolvedValue({ records: {}, deletedIDs: {}, changeToken: 'token-2' });

        await writeRemoteCloudKit(makeAppData());

        // Advancing past a conflicted save would skip those records forever.
        expect(storage.get(CLOUDKIT_CHANGE_TOKEN_KEY)).toBe('token-1');
        expect(cloudKitSync.fetchChanges).not.toHaveBeenCalled();
    });

    it('advances the change token after a clean save', async () => {
        storage.set(CLOUDKIT_CHANGE_TOKEN_KEY, 'token-1');
        cloudKitSync.saveRecords.mockResolvedValue([]);
        cloudKitSync.fetchChanges.mockResolvedValue({ records: {}, deletedIDs: {}, changeToken: 'token-2' });

        await writeRemoteCloudKit(makeAppData());

        expect(cloudKitSync.fetchChanges).toHaveBeenCalledWith('token-1');
        expect(storage.get(CLOUDKIT_CHANGE_TOKEN_KEY)).toBe('token-2');
    });

    it('deletes only purged records from CloudKit', async () => {
        cloudKitSync.saveRecords.mockResolvedValue([]);
        cloudKitSync.fetchChanges.mockResolvedValue({ records: {}, deletedIDs: {} });

        await writeRemoteCloudKit(makeAppData({
            tasks: [
                makeTask('task-live'),
                makeTask('task-deleted', { deletedAt: '2026-05-02T00:00:00.000Z' }),
                makeTask('task-purged', { deletedAt: '2026-05-02T00:00:00.000Z', purgedAt: '2026-05-03T00:00:00.000Z' }),
            ],
            projects: [
                { id: 'project-live', title: 'Live' },
                { id: 'project-purged', title: 'Purged', purgedAt: '2026-05-03T00:00:00.000Z' },
            ],
        } as unknown as Partial<AppData>));

        expect(cloudKitSync.deleteRecords).toHaveBeenCalledTimes(2);
        expect(cloudKitSync.deleteRecords).toHaveBeenCalledWith('MindwtrTask', ['task-purged']);
        expect(cloudKitSync.deleteRecords).toHaveBeenCalledWith('MindwtrProject', ['project-purged']);
    });

    it('clears an expired change token and falls back to a full fetch', async () => {
        storage.set(CLOUDKIT_CHANGE_TOKEN_KEY, 'stale-token');
        cloudKitSync.fetchChanges.mockResolvedValue({ records: {}, deletedIDs: {}, tokenExpired: true });

        const result = await readRemoteCloudKit();

        expect(cloudKitSync.fetchChanges).toHaveBeenCalledWith('stale-token');
        expect(storage.has(CLOUDKIT_CHANGE_TOKEN_KEY)).toBe(false);
        expect(cloudKitSync.fetchAllRecords).toHaveBeenCalled();
        expect(result).not.toBeNull();
    });

    it('returns null without a full fetch when the incremental fetch reports no changes', async () => {
        storage.set(CLOUDKIT_CHANGE_TOKEN_KEY, 'token-1');
        cloudKitSync.fetchChanges.mockResolvedValue({
            records: { MindwtrTask: [] },
            deletedIDs: { MindwtrTask: [] },
            changeToken: 'token-2',
        });

        const result = await readRemoteCloudKit();

        expect(result).toBeNull();
        expect(cloudKitSync.fetchAllRecords).not.toHaveBeenCalled();
        expect(storage.get(CLOUDKIT_CHANGE_TOKEN_KEY)).toBe('token-2');
    });
});
