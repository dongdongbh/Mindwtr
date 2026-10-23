import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import * as FileSystem from './file-system';
import { Directory as ExpoDirectory, File as ExpoFile } from 'expo-file-system';
import {
    AppData,
    fileSyncErrorCode,
    LEGACY_SYNC_FILE_NAME,
    SYNC_FILE_NAME,
    type FileSyncReadResult,
    type SyncFileAccessOptions,
} from '@mindwtr/core';
import { Platform } from 'react-native';
import { logError, logInfo, logWarn } from './app-log';
import { mobileFileSync } from './file-sync-host';
import { createSyncPathBookmark } from './sync-path-bookmarks';

// File Sync's document reads and writes live in core (mobile-file-sync.ts, moved there in S5)
// and run on this app's host (file-sync-host.ts). The pickers and the backup export stay here.

export {
    FILE_SYNC_ABSENT_FINGERPRINT,
    FileSyncRetainedGenerationError,
    FileSyncUnverifiedReadError,
    SyncFileDocumentParseError,
    type SyncFileAccessOptions,
} from '@mindwtr/core';

// StorageAccessFramework is part of the legacy FileSystem module
const StorageAccessFramework = FileSystem.StorageAccessFramework;

interface PickResult extends AppData {
    __fileUri?: string;
    __fileBookmark?: string;
    /** True when the selected sync folder is inside iCloud Drive. */
    __icloud?: boolean;
}

const IOS_TEMP_INBOX_PATTERN = /\/tmp\/[^/\s]*-Inbox\//i;
const READONLY_FOLDER_MESSAGE = 'Selected folder is read-only. Please choose a writable folder or make it available offline.';
const isReadOnlyError = (error: unknown): boolean => mobileFileSync().isReadOnlyError(error);
const readFileText = (fileUri: string): Promise<string | null> => mobileFileSync().readFileText(fileUri);
const parseAppData = (text: string): AppData => mobileFileSync().parseAppData(text);
const isICloudUri = (uri: string): boolean => mobileFileSync().isICloudUri(uri);

const isPickerCanceledError = (error: unknown): boolean => {
    const message = String(error);
    return /cancel/i.test(message);
};

const normalizeDirectoryUri = (uri: string): string => uri.replace(/\/+$/, '');

const buildSyncFileUri = (directoryUri: string, fileName = SYNC_FILE_NAME): string =>
    `${normalizeDirectoryUri(directoryUri)}/${fileName}`;

const emptyPickResult = (fileUri: string, fileBookmark?: string | null): PickResult => ({
    tasks: [],
    projects: [],
    sections: [],
    areas: [],
    settings: {},
    __fileUri: fileUri,
    __fileBookmark: fileBookmark?.trim() || undefined,
    __icloud: isICloudUri(fileUri),
});

const isIosTemporaryInboxUri = (uri: string): boolean => IOS_TEMP_INBOX_PATTERN.test(uri);

const writeWithModernFileApi = (fileUri: string, content: string): void => {
    const file = new ExpoFile(fileUri);
    if (!file.exists) {
        file.create({ intermediates: true, overwrite: false });
    }
    file.write(content);
};

// Pick a sync file and return both the parsed data and the file URI
export const pickAndParseSyncFile = async (): Promise<PickResult | null> => {
    try {
        const result = await DocumentPicker.getDocumentAsync({
            type: 'application/json',
            copyToCacheDirectory: false, // Keep original path for persistent access
        });

        if (result.canceled) {
            return null;
        }

        const fileUri = result.assets[0].uri;
        const fileContent = await readFileText(fileUri);
        if (!fileContent) throw new Error('Sync file does not exist');
        const data = parseAppData(fileContent);

        // Return data with file URI and iCloud flag attached
        return {
            ...data,
            __fileUri: fileUri,
            __icloud: isICloudUri(fileUri),
        };
    } catch (error) {
        void logError(error, { scope: 'sync', extra: { operation: 'import', message: 'Failed to import data' } });
        throw error;
    }
};

export const resolveSyncFileUri = (uri: string, options?: { createIfMissing?: boolean }): Promise<string> =>
    mobileFileSync().resolveSyncFileUri(uri, options);
export const readSyncFile = (fileUri: string, options?: SyncFileAccessOptions): Promise<AppData | null> =>
    mobileFileSync().readSyncFile(fileUri, options);
export const readSyncFileVersioned = (fileUri: string, options?: SyncFileAccessOptions): Promise<FileSyncReadResult> =>
    mobileFileSync().readSyncFileVersioned(fileUri, options);
export const writeSyncFile = (fileUri: string, data: AppData, options?: SyncFileAccessOptions): Promise<void> =>
    mobileFileSync().writeSyncFile(fileUri, data, options);

const assertIosDirectoryWritable = async (
    directoryUri: string,
): Promise<void> => {
    const testFileUri = buildSyncFileUri(directoryUri, `mindwtr-write-test-${Date.now()}.txt`);
    try {
        writeWithModernFileApi(testFileUri, 'ok');
    } catch (error) {
        if (isReadOnlyError(error)) {
            throw new Error(READONLY_FOLDER_MESSAGE);
        }
        throw error;
    } finally {
        try {
            const file = new ExpoFile(testFileUri);
            if (file.exists) {
                file.delete();
            }
        } catch {
            // Ignore cleanup failures for test file.
        }
    }
};

const assertIosFileWritable = async (fileUri: string): Promise<void> => {
    let existingContent: string | null = null;
    try {
        existingContent = await readFileText(fileUri);
    } catch {
        existingContent = null;
    }

    try {
        writeWithModernFileApi(fileUri, existingContent ?? '{}');
    } catch (error) {
        if (isReadOnlyError(error)) {
            throw new Error(READONLY_FOLDER_MESSAGE);
        }
        throw error;
    }
};

export type PickSyncFolderOptions = {
    /** iOS only: asked before falling back from the folder picker to the
     *  backup-file picker (providers like Google Drive, OneDrive, and ownCloud
     *  gray out folder selection). The fallback sheet looks identical to the
     *  one just dismissed, so without an explanation users never discover it —
     *  or get an uninvited second picker on a plain cancel (#1068, #210). */
    confirmFileFallback?: () => Promise<boolean>;
};

const pickAndParseIosSyncFolder = async (options?: PickSyncFolderOptions): Promise<PickResult | null> => {
    const pickFolderFromExistingFile = async (): Promise<PickResult | null> => {
        void logInfo('iOS sync file fallback requested', { scope: 'sync' });
        if (options?.confirmFileFallback && !(await options.confirmFileFallback())) {
            void logInfo('iOS sync file fallback declined', { scope: 'sync' });
            return null;
        }
        void logInfo('iOS sync file picker requested', { scope: 'sync' });
        const result = await DocumentPicker.getDocumentAsync({
            type: 'application/json',
            copyToCacheDirectory: false,
        });
        void logInfo('iOS sync file picker returned', {
            scope: 'sync', extra: { outcome: result.canceled ? 'cancelled' : 'selected' },
        });
        if (result.canceled) return null;
        const pickedFileUri = result.assets[0]?.uri;
        if (!pickedFileUri) return null;

        if (isIosTemporaryInboxUri(pickedFileUri)) {
            throw new Error('Selected iOS sync file is in a temporary Inbox location and is read-only. Re-select a folder in Settings -> Sync.');
        }

        await assertIosFileWritable(pickedFileUri);
        const fileBookmark = await createSyncPathBookmark(pickedFileUri);

        const pickedContent = await readFileText(pickedFileUri);
        if (pickedContent) {
            try {
                const data = parseAppData(pickedContent);
                return {
                    ...data,
                    __fileUri: pickedFileUri,
                    __fileBookmark: fileBookmark ?? undefined,
                    __icloud: isICloudUri(pickedFileUri),
                };
            } catch {
                throw new Error('Selected JSON file is not a Mindwtr backup. Please select a Mindwtr backup JSON file in the target folder.');
            }
        }

        return emptyPickResult(pickedFileUri, fileBookmark);
    };

    try {
        void logInfo('iOS sync folder picker requested', { scope: 'sync' });
        const directory = await ExpoDirectory.pickDirectoryAsync();
        const directoryUri = directory?.uri;
        if (!directoryUri) {
            return await pickFolderFromExistingFile();
        }

        await assertIosDirectoryWritable(directoryUri);
        const directoryBookmark = await createSyncPathBookmark(directoryUri);

        const primaryFileUri = buildSyncFileUri(directoryUri, SYNC_FILE_NAME);
        const legacyFileUri = buildSyncFileUri(directoryUri, LEGACY_SYNC_FILE_NAME);
        let fileUri = primaryFileUri;
        let fileContent = await readFileText(primaryFileUri);
        if (fileContent === null) {
            const legacyContent = await readFileText(legacyFileUri);
            if (legacyContent !== null) {
                fileUri = legacyFileUri;
                fileContent = legacyContent;
            }
        }

        if (!fileContent) return emptyPickResult(primaryFileUri, directoryBookmark);
        const data = parseAppData(fileContent);
        return {
            ...data,
            __fileUri: fileUri,
            __fileBookmark: directoryBookmark?.trim() || undefined,
            __icloud: isICloudUri(fileUri),
        };
    } catch (error) {
        if (isPickerCanceledError(error)) {
            return await pickFolderFromExistingFile();
        }
        void logWarn('iOS folder picker failed; falling back to file-based folder selection', {
            scope: 'sync',
            extra: { operation: 'import' },
        });
        return await pickFolderFromExistingFile();
    }
};

export const pickAndParseSyncFolder = async (options?: PickSyncFolderOptions): Promise<PickResult | null> => {
    if (Platform.OS === 'ios' && typeof ExpoDirectory.pickDirectoryAsync === 'function') {
        try {
            return await pickAndParseIosSyncFolder(options);
        } catch (error) {
            void logError(error, { scope: 'sync', extra: { operation: 'import', message: 'Failed to import data from iOS folder' } });
            throw error;
        }
    }
    if (Platform.OS !== 'android' || !StorageAccessFramework?.requestDirectoryPermissionsAsync) {
        return pickAndParseSyncFile();
    }
    try {
        const permissions = await StorageAccessFramework.requestDirectoryPermissionsAsync();
        if (!permissions.granted) return null;
        const directoryUri = permissions.directoryUri;
        if (!directoryUri) return null;
        return await mobileFileSync().prepareSafSyncFolder(directoryUri);
    } catch (error) {
        void logError(error, { scope: 'sync', extra: { operation: 'import', message: 'Failed to import data from folder' } });
        throw error;
    }
};

// Export data for backup - allows saving to local directory on Android
export const exportData = async (data: AppData): Promise<void> => {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `mindwtr-backup-${timestamp}.json`;
        const jsonContent = JSON.stringify(data, null, 2);

        // On Android, try SAF to let user pick save location
        if (Platform.OS === 'android' && StorageAccessFramework) {
            try {
                void logInfo('Export attempting SAF', { scope: 'sync' });
                // Request permission to a directory
                const permissions = await StorageAccessFramework.requestDirectoryPermissionsAsync();
                void logInfo('Export SAF permissions', {
                    scope: 'sync',
                    extra: {
                        granted: String(Boolean(permissions?.granted)),
                    },
                });

                const directoryUri = permissions.directoryUri;
                if (permissions.granted && directoryUri) {
                    // Create the file in the selected directory
                    const fileUri = await StorageAccessFramework.createFileAsync(
                        directoryUri,
                        filename,
                        'application/json'
                    );

                    await StorageAccessFramework.writeAsStringAsync(fileUri, jsonContent);
                    void logInfo('Export saved via SAF', { scope: 'sync' });
                    return;
                }
            } catch (safError) {
                void logWarn('Export SAF unavailable; falling back to share', {
                    scope: 'sync',
                    extra: { error: fileSyncErrorCode(safError) },
                });
            }
        } else {
            void logInfo('Export SAF unavailable on this platform', {
                scope: 'sync',
                extra: {
                    platform: Platform.OS,
                    hasSaf: String(Boolean(StorageAccessFramework)),
                },
            });
        }

        // Fallback: Use cache + share sheet
        const fileUri = FileSystem.cacheDirectory + filename;
        void logInfo('Export writing backup to cache before share', { scope: 'sync' });
        await FileSystem.writeAsStringAsync(fileUri, jsonContent);

        const sharingAvailable = await Sharing.isAvailableAsync();
        if (sharingAvailable) {
            await Sharing.shareAsync(fileUri, {
                UTI: 'public.json',
                mimeType: 'application/json',
                dialogTitle: 'Export Mindwtr Data',
            });
        } else {
            throw new Error('Sharing is not available on this device');
        }
    } catch (error) {
        void logError(error, { scope: 'sync', extra: { operation: 'export', message: 'Failed to export data' } });
        throw error;
    }
};
