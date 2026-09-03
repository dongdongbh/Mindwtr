import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import * as FileSystem from './file-system';
import { Directory as ExpoDirectory, File as ExpoFile } from 'expo-file-system';
import {
    AppData,
    SYNC_ENCRYPTION_LOG_EVENTS,
    buildSyncEncryptionRemoteReadExtra,
    decodeUriSafe,
    decryptRemoteArtifactOrThrow,
    detectForeignSaltArtifact,
    encryptSyncArtifact,
    inspectSyncArtifact,
    isPlaintextSyncArtifact,
    LEGACY_SYNC_FILE_NAME,
    markRemoteEncryptionDiscovered,
    markRemotePlaintextDiscovered,
    sleep,
    SYNC_FILE_NAME,
    syncEncryptedArtifactName,
    SyncEncryptionRemotePlaintextError,
    SyncEncryptionRemoteConflictError,
    SyncEncryptionTerminalError,
    type FileSyncReadResult,
    type SyncKeyMaterial,
} from '@mindwtr/core';
import { Platform } from 'react-native';
import { logError, logInfo, logWarn } from './app-log';
import { mobileSyncCryptoPrimitives } from './sync-crypto-native';
import {
    flushSyncEncryptionLocalState,
    logSyncEncryptionEvent,
    SyncEncryptionNoKeyError,
    syncEncryptionLocalState,
} from './sync-encryption-state';
import {
    createFileSyncEncryptionRemotePort,
    readSyncArtifactBytes,
    resolveSyncArtifactSiblingUri,
    writeSyncArtifactBytes,
} from './storage-file-encryption';
import {
    createSyncPathBookmark,
    readBookmarkedSyncFileText,
    supportsBookmarkedSyncFileIO,
    writeBookmarkedSyncFileText,
} from './sync-path-bookmarks';

// StorageAccessFramework is part of the legacy FileSystem module
const StorageAccessFramework = FileSystem.StorageAccessFramework;

interface PickResult extends AppData {
    __fileUri?: string;
    __fileBookmark?: string;
    /** True when the selected sync folder is inside iCloud Drive. */
    __icloud?: boolean;
}

const BACKUP_FILE_NAME = 'data.json.bak';
export const FILE_SYNC_ABSENT_FINGERPRINT = 'file:v1:absent';
const READONLY_FOLDER_MESSAGE = 'Selected folder is read-only. Please choose a writable folder or make it available offline.';
const ICLOUD_EVICTED_MESSAGE =
    'Sync file has been offloaded by iCloud Optimize Storage. ' +
    'Open the Files app and navigate to the sync folder to trigger a re-download, then try again.';
const IOS_TEMP_INBOX_PATTERN = /\/tmp\/[^/\s]*-Inbox\//i;
const syncUriResolutionCache = new Map<string, string>();

const isReadOnlyError = (error: unknown): boolean => {
    const message = String(error);
    return /isn't writable|not writable|read-only|read only|permission denied|EACCES/i.test(message);
};

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

const isLikelySyncFileUri = (uri: string): boolean => {
    const decoded = decodeUriSafe(uri);
    return decoded.endsWith(`/${SYNC_FILE_NAME}`)
        || decoded.endsWith(`:${SYNC_FILE_NAME}`)
        || decoded.endsWith(`/${LEGACY_SYNC_FILE_NAME}`)
        || decoded.endsWith(`:${LEGACY_SYNC_FILE_NAME}`);
};

const buildChildDocId = (baseDocId: string, leafName: string): string => {
    if (baseDocId.endsWith(':')) return `${baseDocId}${leafName}`;
    return `${baseDocId}/${leafName}`;
};

type SafContext = {
    prefix: string;
    treeIdEncoded: string;
    treeIdDecoded: string;
};

const parseSafContext = (uri: string): SafContext | null => {
    const prefixMatch = uri.match(/^(content:\/\/[^/]+)/);
    if (!prefixMatch) return null;
    const prefix = prefixMatch[1];

    const treeMatch = uri.match(/\/tree\/([^/?#]+)/);
    if (treeMatch) {
        const treeIdEncoded = treeMatch[1];
        return {
            prefix,
            treeIdEncoded,
            treeIdDecoded: decodeUriSafe(treeIdEncoded),
        };
    }

    const docMatch = uri.match(/\/document\/([^/?#]+)/);
    if (!docMatch) return null;
    const documentId = decodeUriSafe(docMatch[1]);
    if (!documentId) return null;

    if (isLikelySyncFileUri(uri)) {
        const lastSlash = documentId.lastIndexOf('/');
        const parentDocumentId = lastSlash >= 0 ? documentId.slice(0, lastSlash) : documentId;
        if (!parentDocumentId) return null;
        return {
            prefix,
            treeIdEncoded: encodeURIComponent(parentDocumentId),
            treeIdDecoded: parentDocumentId,
        };
    }

    return {
        prefix,
        treeIdEncoded: encodeURIComponent(documentId),
        treeIdDecoded: documentId,
    };
};

const buildTreeDocumentUri = (context: SafContext, documentId: string): string => {
    const documentIdEncoded = encodeURIComponent(documentId);
    return `${context.prefix}/tree/${context.treeIdEncoded}/document/${documentIdEncoded}`;
};

const isIosTemporaryInboxUri = (uri: string): boolean => IOS_TEMP_INBOX_PATTERN.test(uri);

/** Returns true when the sync folder lives inside iCloud Drive. */
const isICloudUri = (uri: string): boolean => {
    const decoded = decodeUriSafe(uri);
    return decoded.includes('Mobile Documents') || decoded.includes('iCloud');
};

/**
 * Detect iCloud Optimize Storage eviction on iOS.
 * When macOS/iOS evicts a file, the real file disappears and a hidden
 * `.filename.icloud` placeholder appears instead.
 */
const isICloudEvicted = (fileUri: string): boolean => {
    if (Platform.OS !== 'ios') return false;
    if (!fileUri.startsWith('file://')) return false;
    try {
        const file = new ExpoFile(fileUri);
        if (file.exists) return false; // Real file is present
        // Check for .Name.icloud placeholder
        const parts = fileUri.split('/');
        const name = parts.pop() ?? '';
        const parentUri = parts.join('/');
        const placeholderUri = `${parentUri}/.${name}.icloud`;
        const placeholder = new ExpoFile(placeholderUri);
        return placeholder.exists;
    } catch {
        return false;
    }
};

const listDirectoryForSyncFile = async (directoryUri: string): Promise<string | null> => {
    if (!StorageAccessFramework?.readDirectoryAsync) return null;
    try {
        const entries = await StorageAccessFramework.readDirectoryAsync(directoryUri);
        const decoded: Array<{ entry: string; decoded: string }> = entries.map((entry: string) => ({
            entry,
            decoded: decodeUriSafe(entry),
        }));
        const matchEntry = decoded.find((item) =>
            item.decoded.endsWith(`/${SYNC_FILE_NAME}`)
            || item.decoded.endsWith(`:${SYNC_FILE_NAME}`)
            || item.decoded.endsWith(`/${LEGACY_SYNC_FILE_NAME}`)
            || item.decoded.endsWith(`:${LEGACY_SYNC_FILE_NAME}`)
        );
        return matchEntry?.entry ?? null;
    } catch {
        return null;
    }
};

function sanitizeJsonText(raw: string): string {
    // Strip BOM and trailing NULs which can appear with partial/unsafe writes.
    let text = raw.replace(/^\uFEFF/, '').trim();
    // eslint-disable-next-line no-control-regex
    text = text.replace(/\u0000+$/g, '').trim();
    return text;
}

const getUtf8ByteLength = (value: string): number => {
    if (typeof TextEncoder === 'function') {
        return new TextEncoder().encode(value).byteLength;
    }
    return unescape(encodeURIComponent(value)).length;
};

const padForNonTruncatingOverwrite = (content: string, previousContent: string | null): string => {
    if (!previousContent) return content;
    const previousBytes = getUtf8ByteLength(previousContent);
    const nextBytes = getUtf8ByteLength(content);
    if (nextBytes >= previousBytes) return content;
    return `${content}${' '.repeat(previousBytes - nextBytes)}`;
};

function parseAppData(text: string): AppData {
    const sanitized = sanitizeJsonText(text);
    if (!sanitized) throw new Error('Sync file is empty');
    const tryParse = (value: string): AppData => {
        const data = JSON.parse(value) as AppData;
        if (!data.tasks || !data.projects) {
            throw new Error('Invalid data format');
        }
        data.areas = Array.isArray(data.areas) ? data.areas : [];
        return data;
    };

    try {
        return tryParse(sanitized);
    } catch (error) {
        const start = sanitized.indexOf('{');
        const end = sanitized.lastIndexOf('}');
        if (start !== -1 && end > start && (start > 0 || end < sanitized.length - 1)) {
            const sliced = sanitized.slice(start, end + 1);
            return tryParse(sliced);
        }
        if (!sanitized.startsWith('{')) {
            throw new Error(`Sync file is not JSON (starts with "${sanitized.slice(0, 20)}")`);
        }
        throw error;
    }
}

const writeWithModernFileApi = (fileUri: string, content: string): void => {
    const file = new ExpoFile(fileUri);
    if (!file.exists) {
        file.create({ intermediates: true, overwrite: false });
    }
    file.write(content);
};

async function readFileText(fileUri: string): Promise<string | null> {
    if (fileUri.startsWith('content://')) {
        if (!StorageAccessFramework?.readAsStringAsync) {
            throw new Error('This Android build does not support Storage Access Framework (SAF).');
        }
        // Do not fall back to FileSystem.* for content:// URIs — it will throw Invalid URI.
        return await StorageAccessFramework.readAsStringAsync(fileUri);
    }

    if (Platform.OS === 'ios' && fileUri.startsWith('file://')) {
        try {
            const file = new ExpoFile(fileUri);
            if (!file.exists) {
                void logInfo('Sync file does not exist', { scope: 'sync', extra: { fileUri } });
                return null;
            }
            return await file.text();
        } catch {
            // Fall back to legacy API for compatibility with older paths.
        }
    }

    const fileInfo = await FileSystem.getInfoAsync(fileUri);
    if (!fileInfo.exists) {
        void logInfo('Sync file does not exist', { scope: 'sync', extra: { fileUri } });
        return null;
    }
    return await FileSystem.readAsStringAsync(fileUri);
}

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

export const resolveSyncFileUri = async (
    uri: string,
    options?: { createIfMissing?: boolean }
): Promise<string> => {
    if (!uri.startsWith('content://')) return uri;
    if (isLikelySyncFileUri(uri)) return uri;

    const cached = syncUriResolutionCache.get(uri);
    if (cached) return cached;

    const context = parseSafContext(uri);
    if (!context) return uri;
    const createIfMissing = options?.createIfMissing ?? true;
    const treeUri = `${context.prefix}/tree/${context.treeIdEncoded}`;
    const documentUri = buildTreeDocumentUri(context, context.treeIdDecoded);
    const candidates = [documentUri, treeUri];

    for (const candidate of candidates) {
        const match = await listDirectoryForSyncFile(candidate);
        if (match) {
            syncUriResolutionCache.set(uri, match);
            return match;
        }
    }

    if (createIfMissing && StorageAccessFramework?.createFileAsync) {
        for (const candidate of candidates) {
            try {
                const created = await StorageAccessFramework.createFileAsync(candidate, SYNC_FILE_NAME, 'application/json');
                syncUriResolutionCache.set(uri, created);
                return created;
            } catch {
                // Try the next candidate.
            }
        }
    }

    const fallback = buildTreeDocumentUri(context, buildChildDocId(context.treeIdDecoded, SYNC_FILE_NAME));
    syncUriResolutionCache.set(uri, fallback);
    return fallback;
};

const assertDirectoryWritable = async (
    directoryUri: string,
    existingFileUri?: string,
    existingContent?: string | null,
): Promise<void> => {
    if (!StorageAccessFramework?.createFileAsync || !StorageAccessFramework?.writeAsStringAsync) return;
    let testUri: string | null = null;
    try {
        try {
            testUri = await StorageAccessFramework.createFileAsync(
                directoryUri,
                `mindwtr-write-test-${Date.now()}`,
                'text/plain'
            );
        } catch (error) {
            if (existingFileUri) {
                await StorageAccessFramework.writeAsStringAsync(existingFileUri, existingContent ?? '');
                return;
            }
            throw error;
        }
        try {
            await StorageAccessFramework.writeAsStringAsync(testUri, 'ok');
        } catch {
            // Creating the test file already proved write access. Passthrough
            // providers (e.g. RSAF over rclone crypt) can fail expo's canWrite
            // pre-check on a just-created document while the provider's
            // metadata query is still stale — don't block setup on that.
        }
        return;
    } catch (error) {
        if (isReadOnlyError(error)) {
            throw new Error(READONLY_FOLDER_MESSAGE);
        }
        throw error;
    } finally {
        if (testUri && StorageAccessFramework?.deleteAsync) {
            try {
                await StorageAccessFramework.deleteAsync(testUri, { idempotent: true });
            } catch {
                // Ignore cleanup failures for the temp file.
            }
        }
    }
};

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
        if (options?.confirmFileFallback && !(await options.confirmFileFallback())) {
            return null;
        }
        const result = await DocumentPicker.getDocumentAsync({
            type: 'application/json',
            copyToCacheDirectory: false,
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
        let fileUri = await resolveSyncFileUri(directoryUri, { createIfMissing: true });
        let fileContent: string | null = null;
        if (fileUri) {
            fileContent = await readFileText(fileUri);
        }
        await assertDirectoryWritable(directoryUri, fileUri ?? undefined, fileContent ?? undefined);
        if (!fileUri) {
            throw new Error('Unable to create sync file in selected folder');
        }
        if (fileContent === null) {
            fileContent = await readFileText(fileUri);
        }
        if (!fileContent) return emptyPickResult(fileUri);
        const data = parseAppData(fileContent);
        return { ...data, __fileUri: fileUri, __icloud: isICloudUri(fileUri) };
    } catch (error) {
        void logError(error, { scope: 'sync', extra: { operation: 'import', message: 'Failed to import data from folder' } });
        throw error;
    }
};

export interface SyncFileAccessOptions {
    /** iOS security-scoped bookmark for the sync file or its folder. */
    bookmark?: string | null;
    /**
     * Sync-encryption key material (#1056). `null`/absent is the encryption-off path and
     * behaves byte-for-byte as it did before this feature: same file name, same text APIs,
     * same recovery chain. When present, `data.json` becomes `data.json.enc` and all IO
     * switches to raw bytes.
     */
    material?: SyncKeyMaterial | null;
    /** Raw generation returned by `readSyncFileVersioned`. Presence opts the write into
     * atomic quarantine/create-new CAS; the explicit absent sentinel means create-only. */
    expectedFingerprint?: string;
    /** #1138: which sync location this read is against, stamped onto any encryption discovery
     * it persists so the resulting lock cannot outlive the folder it was set for. Absent
     * leaves the discovery unscoped, which re-checks on the next cycle rather than blocking. */
    locationScope?: string | null;
}

/** One `remote-read` line per File Sync document seam (#1056 diagnostics). Every path below
 *  that can throw a SyncEncryption* error emits one first, so a shared log says what the
 *  folder actually held. */
const logSyncFileRead = (input: Parameters<typeof buildSyncEncryptionRemoteReadExtra>[0]): void => {
    logSyncEncryptionEvent(
        SYNC_ENCRYPTION_LOG_EVENTS.remoteRead,
        buildSyncEncryptionRemoteReadExtra(input),
    );
};

const getUriLeafName = (uri: string): string => {
    const stripped = decodeUriSafe(uri).replace(/[?#].*$/, '').replace(/\/+$/, '');
    const lastSeparator = Math.max(stripped.lastIndexOf('/'), stripped.lastIndexOf(':'));
    return lastSeparator >= 0 ? stripped.slice(lastSeparator + 1) : stripped;
};

const encryptedLeafNameFor = (resolvedUri: string): string =>
    syncEncryptedArtifactName(getUriLeafName(resolvedUri) || SYNC_FILE_NAME);

/**
 * Decision #2 detection, mirroring `webdavGetSyncDocument`'s reasoning exactly: only ever
 * called when this device has NO key AND the plaintext read produced nothing usable, so a
 * steadily-syncing plaintext install never pays for it. Persists the discovery (decision
 * #5 — it must survive a restart) and returns true when the caller must fail closed.
 *
 * `plainBytes` is the plain-named file's raw content when it existed but failed to parse:
 * a peer could have written ciphertext under the plain name, and ciphertext is never
 * "invalid JSON to be repaired" (decision #4).
 */
const discoverEncryptedSyncFolder = async (
    resolvedUri: string,
    plainBytes: Uint8Array | null,
    locationScope?: string | null,
): Promise<boolean> => {
    const candidates: (Uint8Array | null)[] = [plainBytes];
    // Discovery is a safety check, not a best-effort enhancement. If the folder cannot
    // be enumerated or the sibling cannot be read, propagate the provider error: treating
    // "unreadable" as "absent" would license a fresh plaintext repair beside ciphertext.
    const encUri = await resolveSyncArtifactSiblingUri(resolvedUri, encryptedLeafNameFor(resolvedUri), {
        createIfMissing: false,
    });
    if (encUri) candidates.push(await readSyncArtifactBytes(encUri));
    for (const bytes of candidates) {
        if (!bytes || bytes.length === 0) continue;
        const inspected = inspectSyncArtifact(bytes);
        if (inspected.kind !== 'encrypted') continue;
        logSyncFileRead({
            artifact: encryptedLeafNameFor(resolvedUri),
            exists: true,
            kind: 'encrypted',
            headerSalt: inspected.salt,
            headerKdf: inspected.params,
            bytes: bytes.length,
            version: 'n/a',
            foreignSalt: false,
            decision: 'no-key',
        });
        markRemoteEncryptionDiscovered(syncEncryptionLocalState, {
            salt: inspected.salt,
            params: inspected.params,
        }, locationScope);
        return true;
    }
    return false;
};

const readEncryptedSyncFile = async (
    resolvedUri: string,
    material: SyncKeyMaterial,
    locationScope?: string | null,
): Promise<AppData | null> => {
    const encUri = await resolveSyncArtifactSiblingUri(resolvedUri, encryptedLeafNameFor(resolvedUri), {
        createIfMissing: false,
    });
    const bytes = encUri ? await readSyncArtifactBytes(encUri) : null;
    if (!bytes || bytes.length === 0) {
        // Inverse of discoverEncryptedSyncFolder: a peer ran the disable transition here, so
        // the `.enc` artifact is gone and the plaintext original is back. Never "no data" —
        // that would merge this device's store into a fresh plaintext generation and fork the
        // folder, and this device never follows the remote down to plaintext on its own.
        // A provider failure here is not proof that the plaintext generation is absent.
        // Propagate it so the keyed cycle cannot recreate `.enc` from local data while a
        // peer-restored plaintext document is merely unreadable.
        const plain = await readSyncArtifactBytes(resolvedUri);
        if (isPlaintextSyncArtifact(plain)) {
            logSyncFileRead({
                artifact: getUriLeafName(resolvedUri),
                exists: true,
                kind: 'plaintext',
                bytes: plain?.length ?? null,
                version: 'n/a',
                decision: 'plaintext-discovered',
            });
            markRemotePlaintextDiscovered(syncEncryptionLocalState, locationScope);
            await flushSyncEncryptionLocalState();
            throw new SyncEncryptionRemotePlaintextError();
        }
        logSyncFileRead({
            artifact: encryptedLeafNameFor(resolvedUri),
            exists: false,
            kind: 'absent',
            version: 'n/a',
            decision: 'absent',
        });
        return null;
    }
    // Sealed under another salt = this device's key is for a different encryption
    // generation (a passphrase set before the first sync here, or a peer's rotation).
    // Persist the no-key downgrade so the unlock prompt (which re-derives from the
    // remote's own salt) surfaces, instead of decrypting into a dead-end Auth failure.
    const foreign = detectForeignSaltArtifact(bytes, material);
    if (foreign) {
        logSyncFileRead({
            artifact: encryptedLeafNameFor(resolvedUri),
            exists: true,
            kind: 'encrypted',
            headerSalt: foreign.salt,
            headerKdf: foreign.params,
            bytes: bytes.length,
            version: 'n/a',
            foreignSalt: true,
            decision: 'no-key',
        });
        markRemoteEncryptionDiscovered(syncEncryptionLocalState, foreign, locationScope);
        await flushSyncEncryptionLocalState();
        throw new SyncEncryptionNoKeyError();
    }
    logSyncFileRead({
        artifact: encryptedLeafNameFor(resolvedUri),
        exists: true,
        kind: 'encrypted',
        headerSalt: material.salt,
        headerKdf: material.params,
        bytes: bytes.length,
        version: 'n/a',
        foreignSalt: false,
        decision: 'decrypt',
    });
    const plaintext = await decryptRemoteArtifactOrThrow(bytes, material.key, mobileSyncCryptoPrimitives);
    return parseAppData(new TextDecoder().decode(plaintext));
};

// Read sync file from a stored path
export const readSyncFile = async (fileUri: string, options?: SyncFileAccessOptions): Promise<AppData | null> => {
    try {
        const material = options?.material ?? null;
        if (material) {
            // The bookmarked-IO shortcut below is text-only (the native module exposes
            // readTextFile/writeTextFile), and ciphertext is not text. Encrypted folders
            // use the byte path against the already-bookmark-resolved URI, which is the
            // same access route the plaintext path falls back to when bookmarked IO fails.
            const resolvedEncryptedUri = await resolveSyncFileUri(fileUri, { createIfMissing: false });
            return await readEncryptedSyncFile(resolvedEncryptedUri, material, options?.locationScope);
        }

        const bookmark = options?.bookmark?.trim() || null;
        if (bookmark && Platform.OS === 'ios' && supportsBookmarkedSyncFileIO()) {
            let fileContent: string | null | undefined;
            try {
                fileContent = await readBookmarkedSyncFileText(bookmark);
            } catch (error) {
                void logWarn('Bookmarked sync read failed; falling back to direct file access', {
                    scope: 'sync',
                    extra: { error: error instanceof Error ? error.message : String(error) },
                });
            }
            if (typeof fileContent === 'string') {
                if (!fileContent) return null;
                return parseAppData(fileContent);
            }
            if (fileContent === null) {
                void logWarn('Bookmarked sync read returned no content; falling back to direct file access', {
                    scope: 'sync',
                });
            }
        }

        const resolvedUri = await resolveSyncFileUri(fileUri, { createIfMissing: false });
        if (resolvedUri !== fileUri) {
            void logInfo('Resolved sync path from directory URI to file URI', { scope: 'sync' });
        }

        // Detect iCloud Optimize Storage eviction before attempting reads.
        if (isICloudEvicted(resolvedUri)) {
            void logWarn(ICLOUD_EVICTED_MESSAGE, { scope: 'sync' });
            // Try the backup file before giving up.
            const backupUri = resolvedUri.replace(/\/[^/]+$/, '/' + BACKUP_FILE_NAME);
            try {
                const backupContent = await readFileText(backupUri);
                if (backupContent) {
                    void logInfo('Using backup file while primary is iCloud-evicted', { scope: 'sync' });
                    return parseAppData(backupContent);
                }
            } catch {
                // Backup also unavailable.
            }
            throw new Error(ICLOUD_EVICTED_MESSAGE);
        }

        // Syncthing (or other tools) can replace files while we're reading. Retry a few times.
        let lastError: unknown = null;
        for (let attempt = 0; attempt < 4; attempt += 1) {
            try {
                const fileContent = await readFileText(resolvedUri);
                if (!fileContent) {
                    // "Nothing here" is also the exact shape of a folder a peer encrypted
                    // and whose plaintext original it then removed — take one look before
                    // reporting no data (and, with no data, letting the cycle write a
                    // fresh plaintext file alongside the encrypted one).
                    if (await discoverEncryptedSyncFolder(resolvedUri, null, options?.locationScope)) {
                        throw new SyncEncryptionNoKeyError();
                    }
                    return null;
                }
                return parseAppData(fileContent);
            } catch (error) {
                if (error instanceof SyncEncryptionNoKeyError) throw error;
                lastError = error;
                // Small backoff to allow file writes to finish.
                await sleep(120 + attempt * 80);
            }
        }
        // Before the "invalid JSON" repair path can fire: ciphertext under the plain name
        // is not corrupt JSON (decision #4). Read the raw bytes and check for MWENC1.
        const rawBytes = await readSyncArtifactBytes(resolvedUri).catch(() => null);
        if (await discoverEncryptedSyncFolder(resolvedUri, rawBytes, options?.locationScope)) {
            throw new SyncEncryptionNoKeyError();
        }
        throw lastError;
    } catch (error) {
        // Fail closed: neither a no-key discovery nor a failed decrypt may reach the
        // "invalid JSON -> return null and repair" branch below. Defense in depth — no
        // current MWENC1 error message matches that branch's regex, so removing these
        // three lines does not fail a test today. They exist so that a future wording
        // change ("...is not valid JSON container...") cannot silently turn a wrong
        // passphrase into "no remote data, overwrite it".
        if (error instanceof SyncEncryptionNoKeyError
            || error instanceof SyncEncryptionRemotePlaintextError
            || error instanceof SyncEncryptionTerminalError) {
            void logWarn('Sync file is encrypted and could not be read with the current key', { scope: 'sync' });
            throw error;
        }
        const message = String(error);
        // Provide a clearer UX-oriented error.
        if (fileUri.startsWith('content://') && /Invalid URI|IllegalArgumentException/i.test(message)) {
            throw new Error('Cannot access the selected sync file. Please re-select it in Settings → Sync.');
        }
        if (/JSON|Unexpected token|trailing characters|Invalid data format|Sync file is empty/i.test(message)) {
            void logWarn('[Sync] Invalid JSON in sync file. Using local data and repairing file.', { scope: 'sync' });
            void logInfo('Invalid JSON in sync file; using local data.', { scope: 'sync', extra: { operation: 'read' } });
            return null;
        }
        void logError(error, { scope: 'sync', extra: { operation: 'read', message: 'Failed to read sync file' } });
        throw error;
    }
};

const emptyRemoteAppData = (): AppData => ({
    tasks: [],
    projects: [],
    sections: [],
    areas: [],
    people: [],
    settings: {},
});

/** Reads the primary document bytes and their version through the same File transition
 * port ordinary writes use. Recovery still delegates to the established reader, but the
 * returned version always describes the primary generation that an atomic repair must
 * replace (or the explicit absence it must create into). */
export const readSyncFileVersioned = async (
    fileUri: string,
    options?: SyncFileAccessOptions,
): Promise<FileSyncReadResult> => {
    const material = options?.material ?? null;
    const resolvedUri = await resolveSyncFileUri(fileUri, { createIfMissing: false });
    const remote = await createFileSyncEncryptionRemotePort(resolvedUri);
    if (!remote) throw new Error('Unable to open the selected sync folder for a versioned read');
    const name = material ? encryptedLeafNameFor(resolvedUri) : getUriLeafName(resolvedUri);
    const snapshot = await remote.read(name);

    if (snapshot.bytes) {
        if (!snapshot.version) throw new Error('File Sync did not return a version for an existing document');
        if (material) {
            const foreign = detectForeignSaltArtifact(snapshot.bytes, material);
            if (foreign) {
                logSyncFileRead({
                    artifact: name,
                    exists: true,
                    kind: 'encrypted',
                    headerSalt: foreign.salt,
                    headerKdf: foreign.params,
                    bytes: snapshot.bytes.length,
                    version: 'strong',
                    foreignSalt: true,
                    decision: 'no-key',
                });
                markRemoteEncryptionDiscovered(syncEncryptionLocalState, foreign, options?.locationScope);
                await flushSyncEncryptionLocalState();
                throw new SyncEncryptionNoKeyError();
            }
            logSyncFileRead({
                artifact: name,
                exists: true,
                kind: 'encrypted',
                headerSalt: material.salt,
                headerKdf: material.params,
                bytes: snapshot.bytes.length,
                version: 'strong',
                foreignSalt: false,
                decision: 'decrypt',
            });
            const plaintext = await decryptRemoteArtifactOrThrow(
                snapshot.bytes,
                material.key,
                mobileSyncCryptoPrimitives,
            );
            return {
                data: parseAppData(new TextDecoder().decode(plaintext)),
                fingerprint: snapshot.version,
                source: 'primary',
            };
        }
        if (inspectSyncArtifact(snapshot.bytes).kind === 'plaintext') {
            try {
                const parsed = parseAppData(new TextDecoder().decode(snapshot.bytes));
                logSyncFileRead({
                    artifact: name,
                    exists: true,
                    kind: 'plaintext',
                    bytes: snapshot.bytes.length,
                    version: 'strong',
                    decision: 'plaintext',
                });
                return {
                    data: parsed,
                    fingerprint: snapshot.version,
                    source: 'primary',
                };
            } catch {
                // Keep the existing backup/invalid-JSON recovery behavior below. The raw
                // primary version remains the CAS target for any subsequent repair.
            }
        }
    }

    const recovered = await readSyncFile(fileUri, options);
    return {
        data: recovered ?? emptyRemoteAppData(),
        fingerprint: snapshot.version ?? FILE_SYNC_ABSENT_FINGERPRINT,
        source: recovered ? 'recovery' : 'empty',
        // Every fallback means the canonical generation is absent, empty, invalid, or
        // was bypassed for recovery. Force one CAS-protected repair even when the
        // recovered/default data is semantically identical to local state.
        needsRepair: true,
    };
};

const writeSyncFileVersioned = async (
    resolvedUri: string,
    content: string,
    material: SyncKeyMaterial | null,
    expectedFingerprint: string,
): Promise<void> => {
    const remote = await createFileSyncEncryptionRemotePort(resolvedUri);
    if (!remote) throw new Error('Unable to open the selected sync folder for an atomic write');
    const name = material ? encryptedLeafNameFor(resolvedUri) : getUriLeafName(resolvedUri);
    const expectedVersion = expectedFingerprint === FILE_SYNC_ABSENT_FINGERPRINT
        ? null
        : expectedFingerprint;
    const current = await remote.read(name);
    if (current.version !== expectedVersion) {
        throw new SyncEncryptionRemoteConflictError(`${name} changed before the File Sync write`);
    }

    // Preserve the previous verified generation through the same best-effort backup policy
    // as the legacy writer. The authoritative write below remains atomic even if this copy
    // is unsupported or races; a backup failure never licenses an unconditional overwrite.
    if (current.bytes && (material || !resolvedUri.startsWith('content://'))) {
        try {
            const backupName = material ? syncEncryptedArtifactName(BACKUP_FILE_NAME) : BACKUP_FILE_NAME;
            const backupUri = await resolveSyncArtifactSiblingUri(resolvedUri, backupName, {
                createIfMissing: true,
            });
            if (backupUri) await writeSyncArtifactBytes(backupUri, current.bytes);
        } catch (error) {
            void logWarn('File Sync backup rotation failed; continuing with the atomic write', {
                scope: 'sync',
                extra: { error: error instanceof Error ? error.message : String(error) },
            });
        }
    }

    const payload = material
        ? await encryptSyncArtifact(
            new TextEncoder().encode(content),
            material,
            mobileSyncCryptoPrimitives,
        )
        : new TextEncoder().encode(content);
    await remote.write(name, payload, expectedVersion);

    const written = await remote.read(name);
    if (!written.bytes) throw new Error('Sync file write verification failed: file is empty after write.');
    if (material) {
        const plaintext = await decryptRemoteArtifactOrThrow(
            written.bytes,
            material.key,
            mobileSyncCryptoPrimitives,
        );
        parseAppData(new TextDecoder().decode(plaintext));
    } else {
        parseAppData(new TextDecoder().decode(written.bytes));
    }
};

/**
 * Encrypted write. Mirrors the Rust backup-rotation gate (decision #4): the `.bak`
 * rotation is gated on the CURRENT artifact decrypting successfully, so bytes we cannot
 * read are never rotated away and never overwritten — the write aborts with a terminal
 * error instead. Verification after the write is decrypt+parse, not parse.
 */
const writeEncryptedSyncFile = async (
    resolvedUri: string,
    content: string,
    material: SyncKeyMaterial,
): Promise<void> => {
    const encLeaf = encryptedLeafNameFor(resolvedUri);
    const encUri = await resolveSyncArtifactSiblingUri(resolvedUri, encLeaf, { createIfMissing: true });
    if (!encUri) throw new Error('Unable to create the encrypted sync file in the selected folder');

    const current = await readSyncArtifactBytes(encUri).catch(() => null);
    if (current && current.length > 0) {
        // Throws SyncEncryptionTerminalError on a wrong key or a corrupt container. Note
        // what does NOT happen on that path: no rotation, no overwrite, no repair.
        const previousPlaintext = await decryptRemoteArtifactOrThrow(current, material.key, mobileSyncCryptoPrimitives);
        void previousPlaintext;
        try {
            const backupUri = await resolveSyncArtifactSiblingUri(
                resolvedUri,
                syncEncryptedArtifactName(BACKUP_FILE_NAME),
                { createIfMissing: true },
            );
            if (backupUri) await writeSyncArtifactBytes(backupUri, current);
        } catch (error) {
            void logWarn('Encrypted sync backup rotation failed; continuing with the write', {
                scope: 'sync',
                extra: { error: error instanceof Error ? error.message : String(error) },
            });
        }
    }

    const sealed = await encryptSyncArtifact(
        new TextEncoder().encode(content),
        material,
        mobileSyncCryptoPrimitives,
    );
    await writeSyncArtifactBytes(encUri, sealed);

    const written = await readSyncArtifactBytes(encUri);
    if (!written || written.length === 0) {
        throw new Error('Sync file write verification failed: file is empty after write.');
    }
    const verified = await decryptRemoteArtifactOrThrow(written, material.key, mobileSyncCryptoPrimitives);
    parseAppData(new TextDecoder().decode(verified));
    void logInfo('Written encrypted sync file', { scope: 'sync', extra: { fileUri: encUri } });
};

// Write merged data back to sync file
export const writeSyncFile = async (fileUri: string, data: AppData, options?: SyncFileAccessOptions): Promise<void> => {
    try {
        const content = JSON.stringify(data, null, 2);
        const bookmark = options?.bookmark?.trim() || null;
        const resolvedUri = await resolveSyncFileUri(fileUri, { createIfMissing: true });

        const material = options?.material ?? null;
        if (options?.expectedFingerprint !== undefined) {
            await writeSyncFileVersioned(resolvedUri, content, material, options.expectedFingerprint);
            return;
        }
        if (material) {
            await writeEncryptedSyncFile(resolvedUri, content, material);
            return;
        }

        // Warn if writing to an iCloud-evicted target — the placeholder may get corrupted.
        if (isICloudEvicted(resolvedUri)) {
            void logWarn('Sync target is iCloud-evicted; writing directly to avoid corrupting placeholder.', { scope: 'sync' });
        }

        // SAF URIs (content://) require special handling on Android
        if (resolvedUri.startsWith('content://') && StorageAccessFramework) {
            const previousContent = await readFileText(resolvedUri).catch(() => null);
            const paddedContent = padForNonTruncatingOverwrite(content, previousContent);
            try {
                await StorageAccessFramework.writeAsStringAsync(resolvedUri, paddedContent);
            } catch (error) {
                // expo's legacy SAF write refuses whenever the provider's
                // metadata omits FLAG_SUPPORTS_WRITE — RSAF (rclone) omits it
                // deliberately, so no delay ever helps (#1001). The new File
                // API writes through contentResolver.openOutputStream with no
                // writability pre-check: attempt the operation instead of
                // trusting the metadata.
                if (!isReadOnlyError(error)) throw error;
                try {
                    new ExpoFile(resolvedUri).write(paddedContent);
                } catch (streamError) {
                    void logWarn('SAF output-stream write failed; retrying the provider write once', {
                        scope: 'sync',
                        extra: { error: streamError instanceof Error ? streamError.message : String(streamError) },
                    });
                    await sleep(1000);
                    await StorageAccessFramework.writeAsStringAsync(resolvedUri, paddedContent);
                }
            }
            const writtenContent = await readFileText(resolvedUri);
            if (!writtenContent) {
                throw new Error('Sync file write verification failed: file is empty after write.');
            }
            parseAppData(writtenContent);
            void logInfo('Written sync file via SAF', { scope: 'sync', extra: { fileUri: resolvedUri } });
        } else {
            // Best-effort backup before overwriting, for recovery.
            const backupUri = resolvedUri.replace(/\/[^/]+$/, '/' + BACKUP_FILE_NAME);
            try {
                if (Platform.OS === 'ios' && resolvedUri.startsWith('file://')) {
                    const src = new ExpoFile(resolvedUri);
                    if (src.exists) {
                        const dst = new ExpoFile(backupUri);
                        if (dst.exists) dst.delete();
                        src.copy(dst);
                    }
                } else {
                    const info = await FileSystem.getInfoAsync(resolvedUri);
                    if (info.exists) {
                        await FileSystem.copyAsync({ from: resolvedUri, to: backupUri });
                    }
                }
            } catch {
                // Backup is best-effort; don't block the write.
            }

            if (bookmark && Platform.OS === 'ios' && supportsBookmarkedSyncFileIO()) {
                try {
                    await writeBookmarkedSyncFileText(bookmark, content);
                    void logInfo('Written sync file via bookmarked scoped access', { scope: 'sync', extra: { fileUri: resolvedUri } });
                    return;
                } catch (error) {
                    if (isReadOnlyError(error)) {
                        throw new Error(READONLY_FOLDER_MESSAGE);
                    }
                    void logWarn('Bookmarked sync write failed; falling back to direct file access', {
                        scope: 'sync',
                        extra: { error: error instanceof Error ? error.message : String(error) },
                    });
                }
            }

            if (Platform.OS === 'ios' && resolvedUri.startsWith('file://')) {
                try {
                    writeWithModernFileApi(resolvedUri, content);
                    void logInfo('Written sync file via modern iOS File API', { scope: 'sync', extra: { fileUri: resolvedUri } });
                    return;
                } catch (error) {
                    void logWarn('Modern iOS sync write failed; falling back to legacy path', {
                        scope: 'sync',
                        extra: { error: error instanceof Error ? error.message : String(error) },
                    });
                }
            }
            // Atomic-ish write: write to tmp then rename over the target.
            const tempUri = `${resolvedUri}.tmp`;
            await FileSystem.writeAsStringAsync(tempUri, content);
            try {
                const existing = await FileSystem.getInfoAsync(resolvedUri);
                if (existing.exists) {
                    await FileSystem.deleteAsync(resolvedUri, { idempotent: true });
                }
                await FileSystem.moveAsync({ from: tempUri, to: resolvedUri });
            } catch (moveErr) {
                // Rename may fail on iCloud Drive virtual filesystem — fall back to direct copy.
                void logWarn('Atomic rename failed; falling back to direct copy', {
                    scope: 'sync',
                    extra: { error: moveErr instanceof Error ? moveErr.message : String(moveErr) },
                });
                await FileSystem.copyAsync({ from: tempUri, to: resolvedUri });
                await FileSystem.deleteAsync(tempUri, { idempotent: true }).catch(() => {});
            }
            void logInfo('Written sync file', { scope: 'sync', extra: { fileUri: resolvedUri } });
        }
    } catch (error) {
        void logError(error, { scope: 'sync', extra: { operation: 'write', message: 'Failed to write sync file' } });
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
                    void logInfo('Export saved via SAF', { scope: 'sync', extra: { fileUri } });
                    return;
                }
            } catch (safError) {
                void logWarn('Export SAF unavailable; falling back to share', {
                    scope: 'sync',
                    extra: { error: safError instanceof Error ? safError.message : String(safError) },
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
        void logInfo('Export writing backup to cache before share', { scope: 'sync', extra: { fileUri } });
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
