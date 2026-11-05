import { File as ExpoFile } from 'expo-file-system';
import {
    base64ToBytes,
    bytesToBase64,
    createMobileFileSync,
    fileSyncErrorCode,
    sleep,
    type MobileFileSync,
    type MobileFileSyncFullHost,
} from '@mindwtr/core';
import { Platform } from 'react-native';

import { logError, logInfo, logWarn } from './app-log';
import * as FileSystem from './file-system';
import { listSafChildren, readSafDocument, statSafDocument } from './saf-documents';
import { mobileSyncCryptoPrimitives } from './sync-crypto-native';
import { flushSyncEncryptionLocalState, logSyncEncryptionEvent, syncEncryptionLocalState } from './sync-encryption-state';
import { renameSafTransitionDocument } from './sync-file-transition-cas';
import { readBookmarkedSyncFileText, supportsBookmarkedSyncFileIO } from './sync-path-bookmarks';


const StorageAccessFramework = FileSystem.StorageAccessFramework;

const isReadOnlyError = (error: unknown): boolean =>
    /isn't writable|not writable|read-only|read only|permission denied|EACCES/i.test(String(error));


const writePathBytes = async (uri: string, payload: Uint8Array): Promise<void> => {
    try {
        const file = new ExpoFile(uri);
        if (!file.exists) file.create({ intermediates: true, overwrite: false });
        file.write(payload);
    } catch {
        await FileSystem.writeAsStringAsync(uri, bytesToBase64(payload), {
            encoding: FileSystem.EncodingType.Base64,
        });
    }
};

const mobileFileSyncHost: MobileFileSyncFullHost = {
    os: () => Platform.OS,
    saf: StorageAccessFramework ? {
        listChildren: (dirUri) => listSafChildren(dirUri),
        stat: (uri) => statSafDocument(uri),
        readBytes: (uri) => readSafDocument(uri),
        writeBytes: async (uri, payload) => {
            if (!StorageAccessFramework.writeAsStringAsync) {
                await writePathBytes(uri, payload);
                return;
            }
            const base64 = bytesToBase64(payload);
            try {
                await StorageAccessFramework.writeAsStringAsync(uri, base64, {
                    encoding: FileSystem.EncodingType.Base64,
                });
                return;
            } catch (error) {


                if (!isReadOnlyError(error)) throw error;
                try {
                    new ExpoFile(uri).write(payload);
                    return;
                } catch (streamError) {
                    void logWarn('SAF encrypted output-stream write failed; retrying the provider write once', {
                        scope: 'sync',
                        extra: { error: fileSyncErrorCode(streamError) },
                    });
                    await sleep(1000);
                    await StorageAccessFramework.writeAsStringAsync(uri, base64, {
                        encoding: FileSystem.EncodingType.Base64,
                    });
                    return;
                }
            }
        },
        writeText: (uri, text) => StorageAccessFramework.writeAsStringAsync(uri, text),
        createFile: (dirUri, name, mimeType) => StorageAccessFramework.createFileAsync(dirUri, name, mimeType),
        delete: (uri) => StorageAccessFramework.deleteAsync(uri, { idempotent: true }),
        rename: (uri, displayName) => renameSafTransitionDocument(uri, displayName),
    } : null,
    path: {
        exists: (uri) => new ExpoFile(uri).exists,
        info: (uri) => FileSystem.getInfoAsync(uri),
        list: (dirUri) => FileSystem.readDirectoryAsync(dirUri),
        readBytes: async (uri) => {
            try {
                const file = new ExpoFile(uri);
                if (!file.exists) return null;
                return await file.bytes();
            } catch (error) {


                try {
                    const info = await FileSystem.getInfoAsync(uri);
                    if (!info.exists) return null;
                    const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
                    return base64 ? base64ToBytes(base64) : new Uint8Array(0);
                } catch {
                    throw error;
                }
            }
        },
        readText: async (uri) => {
            if (Platform.OS === 'ios' && uri.startsWith('file://')) {
                try {
                    const file = new ExpoFile(uri);
                    if (!file.exists) return null;
                    return await file.text();
                } catch {

                }
            }
            const fileInfo = await FileSystem.getInfoAsync(uri);
            if (!fileInfo.exists) return null;
            return await FileSystem.readAsStringAsync(uri);
        },
        writeBytes: (uri, payload) => writePathBytes(uri, payload),
        createExclusive: async (uri) => {
            try {
                new ExpoFile(uri).create({ intermediates: true, overwrite: false });
                return 'created';
            } catch (error) {
                const info = await FileSystem.getInfoAsync(uri).catch(() => ({ exists: false }));
                if (info.exists) return 'exists';
                throw error;
            }
        },
        writeCreated: (uri, bytes) => { new ExpoFile(uri).write(bytes); },
        delete: (uri) => FileSystem.deleteAsync(uri, { idempotent: true }),
        rename: (uri, name) => {
            const file = new ExpoFile(uri);
            file.rename(name);
            return file.uri;
        },
    },
    bookmarks: {
        supported: () => supportsBookmarkedSyncFileIO(),
        readText: (bookmark) => readBookmarkedSyncFileText(bookmark),
    },
    log: {
        info: (message, context) => { void logInfo(message, context as Parameters<typeof logInfo>[1]); },
        warn: (message, context) => { void logWarn(message, context as Parameters<typeof logWarn>[1]); },
        error: (error, context) => { void logError(error, context as Parameters<typeof logError>[1]); },
    },
    encryption: {
        localState: syncEncryptionLocalState,
        flush: () => flushSyncEncryptionLocalState(),
        logEvent: (event, extra) => logSyncEncryptionEvent(event, extra),
    },
    crypto: mobileSyncCryptoPrimitives,
};

let instance: MobileFileSync | null = null;


export const mobileFileSync = (): MobileFileSync => {
    instance ??= createMobileFileSync(mobileFileSyncHost);
    return instance;
};
