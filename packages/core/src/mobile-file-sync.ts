// File Sync's sync document: the versioned read and write a cycle makes, the recovery chain for a
// damaged or missing document, encryption discovery, and the Android pick's folder step. Moved
// from React Native's lib/storage-file.ts (S5) unchanged in behavior: every expo-file-system and
// native-module call is now a call on the host's port, in the same order
// (apps/mobile/lib/file-sync-parity.test.ts replays it). The pickers and the backup export stay
// in React Native; native Android binds the same host over SafDocumentsCore.

import { decodeUriSafe, sleep } from './async-utils';
import {
    createMobileFileSyncRemote,
    fileSyncErrorCode,
    type MobileFileSyncHost,
    type MobileFileSyncSafPort,
} from './mobile-file-sync-remote';
import type { FileSyncReadResult } from './sync-backend-io';
import { encryptSyncArtifact, inspectSyncArtifact, type SyncCryptoPrimitives, type SyncKeyMaterial } from './sync-crypto';
import {
    decryptRemoteArtifactOrThrow,
    detectForeignSaltArtifact,
    isPlaintextSyncArtifact,
    markRemoteEncryptionDiscovered,
    markRemotePlaintextDiscovered,
    syncEncryptedArtifactName,
    SyncEncryptionRemoteConflictError,
    SyncEncryptionRemotePlaintextError,
    SyncEncryptionTerminalError,
    type SyncEncryptionLocalStatePort,
} from './sync-encryption';
import {
    buildSyncEncryptionRemoteReadExtra,
    SYNC_ENCRYPTION_LOG_EVENTS,
    type SyncEncryptionLogEvent,
} from './sync-encryption-diagnostics';
import { SyncEncryptionNoKeyError } from './sync-encryption-local-state';
import { LEGACY_SYNC_FILE_NAME, SYNC_FILE_NAME } from './sync-service-utils';
import type { AppData } from './types';

export const FILE_SYNC_ABSENT_FINGERPRINT = 'file:v1:absent';

/** The File Sync host: the folder ports (mobile-file-sync-remote.ts) plus the platform, iOS
 *  bookmarks, the encryption state and the cipher. */
export type MobileFileSyncFullHost = MobileFileSyncHost & {
    os(): string;
    /** iOS security-scoped bookmark IO; a host without it answers false. */
    bookmarks: {
        supported(): boolean;
        readText(bookmark: string): Promise<string | null | undefined>;
    };
    encryption: {
        localState: SyncEncryptionLocalStatePort;
        flush(): Promise<void>;
        logEvent(event: SyncEncryptionLogEvent, extra: Record<string, string>): unknown;
    };
    crypto: SyncCryptoPrimitives;
};

/** A picked sync folder: its data (empty when the folder has no sync file yet) and its file URI. */
export type FileSyncPickResult = AppData & {
    __fileUri?: string;
    __fileBookmark?: string;
    /** True when the selected sync folder is inside iCloud Drive. */
    __icloud?: boolean;
};

/** The sync document's bytes are not a Mindwtr document (empty, not JSON, or missing its lists).
 *  Only this error licenses "use local data and repair the file"; a provider error never does,
 *  even when its text names data.json. */
export class SyncFileDocumentParseError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message);
        this.name = 'SyncFileDocumentParseError';
        if (options) (this as Error & { cause?: unknown }).cause = options.cause;
    }
}

/** The sync document could not be proven whole (its provider reports no length) and does not
 *  parse, so it may be a cut-off read of real data: the cycle stops and never repairs from it
 *  (dd, 10-18). "conflict" in the text classifies it as a sync conflict. */
export class FileSyncUnverifiedReadError extends Error {
    constructor() {
        super('File Sync read conflict: the sync file could not be proven complete and did not parse; nothing was written');
        this.name = 'FileSyncUnverifiedReadError';
    }
}

/** The sync file is missing or broken while an earlier copy of it (a quarantine, stage, backup,
 *  `.previous` or `.tmp` that is not empty) sits beside it: that copy may hold rows nothing else
 *  has, so the cycle stops instead of repairing the folder from local data. Nothing is written,
 *  moved or deleted. "conflict" in the text classifies it as a sync conflict. */
export class FileSyncRetainedGenerationError extends Error {
    constructor(public readonly retained: number) {
        super('File Sync conflict: the sync file is missing or damaged while an earlier copy of it is in the sync folder; nothing was written');
        this.name = 'FileSyncRetainedGenerationError';
    }
}

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

export type SafContext = {
    prefix: string;
    treeIdEncoded: string;
    treeIdDecoded: string;
};

export type ResolvedSafSyncFile = { uri: string; name: string; exists: boolean };

/** File Sync's document reads and writes (React Native: lib/storage-file.ts; native Android: the
 *  same host over SafDocumentsCore). One instance per app: it keeps the folder resolution cache. */
export const createMobileFileSync = (host: MobileFileSyncFullHost) => {
    const remote = createMobileFileSyncRemote(host);
    const {
        createFileSyncEncryptionRemotePort,
        isUnverifiedLengthRead,
        listBlockingRetainedGenerations,
        readSyncArtifactBytes,
        resolveSyncArtifactSiblingUri,
    } = remote;
    const saf = (): MobileFileSyncSafPort => {
        if (!host.saf) throw new Error('This Android build does not support Storage Access Framework (SAF).');
        return host.saf;
    };

    const BACKUP_FILE_NAME = 'data.json.bak';
    const READONLY_FOLDER_MESSAGE = 'Selected folder is read-only. Please choose a writable folder or make it available offline.';
    const ICLOUD_EVICTED_MESSAGE =
        'Sync file has been offloaded by iCloud Optimize Storage. ' +
        'Open the Files app and navigate to the sync folder to trigger a re-download, then try again.';
    const syncUriResolutionCache = new Map<string, string>();

    const isReadOnlyError = (error: unknown): boolean => {
        const message = String(error);
        return /isn't writable|not writable|read-only|read only|permission denied|EACCES/i.test(message);
    };

    const isLikelySyncFileUri = (uri: string): boolean => {
        const decoded = decodeUriSafe(uri);
        return decoded.endsWith(`/${SYNC_FILE_NAME}`)
            || decoded.endsWith(`:${SYNC_FILE_NAME}`)
            || decoded.endsWith(`/${LEGACY_SYNC_FILE_NAME}`)
            || decoded.endsWith(`:${LEGACY_SYNC_FILE_NAME}`);
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
        if (host.os() !== 'ios') return false;
        if (!fileUri.startsWith('file://')) return false;
        try {
            if (host.path.exists(fileUri)) return false; // Real file is present
            // Check for .Name.icloud placeholder
            const parts = fileUri.split('/');
            const name = parts.pop() ?? '';
            const parentUri = parts.join('/');
            const placeholderUri = `${parentUri}/.${name}.icloud`;
            return host.path.exists(placeholderUri);
        } catch {
            return false;
        }
    };

    /** The folder's data.json (or legacy file) by display name, or null when a successful listing
     *  found none. A listing failure propagates: "unreadable" is never "absent". */
    const listDirectoryForSyncFile = async (directoryUri: string): Promise<{ uri: string; name: string } | null> => {
        const entries = (await saf().listChildren(directoryUri)).map((entry) => ({
            uri: entry.uri,
            // Document IDs are opaque; only a path-like provider puts the name in the URI's tail.
            name: entry.name || getUriLeafName(entry.uri),
        }));
        return entries.find((entry) => entry.name === SYNC_FILE_NAME)
            ?? entries.find((entry) => entry.name === LEGACY_SYNC_FILE_NAME)
            ?? null;
    };

    function sanitizeJsonText(raw: string): string {
        // Strip BOM and trailing NULs which can appear with partial/unsafe writes.
        let text = raw.replace(/^\uFEFF/, '').trim();
        // eslint-disable-next-line no-control-regex
        text = text.replace(/\u0000+$/g, '').trim();
        return text;
    }

    function parseAppDataUnchecked(text: string): AppData {
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




    function parseAppData(text: string): AppData {
        try {
            return parseAppDataUnchecked(text);
        } catch (error) {
            throw new SyncFileDocumentParseError(error instanceof Error ? error.message : String(error), { cause: error });
        }
    }

    /** A SAF document's text, whole (SafDocumentsCore.readBytes), with whether a reported length
     *  proved it whole. */
    const readSafText = async (fileUri: string): Promise<{ text: string; lengthVerified: boolean }> => {
        const read = await saf().readBytes(fileUri);
        return { text: new TextDecoder().decode(read.bytes), lengthVerified: read.lengthVerified };
    };

    async function readFileText(fileUri: string): Promise<string | null> {
        if (fileUri.startsWith('content://')) {
            return (await readSafText(fileUri)).text;
        }

        const text = await host.path.readText(fileUri);
        if (text === null) {
            // No path in the context: a sync folder's path can name the user or their files.
            host.log.info('Sync file does not exist', { scope: 'sync' });
        }
        return text;
    }

    /** Whether the picked folder's listing holds this exact document. A listing failure throws. */
    const isListedInSafSyncFolder = async (documentUri: string): Promise<boolean> => {
        const context = parseSafContext(documentUri);
        if (!context) return false;
        const folderUri = buildTreeDocumentUri(context, context.treeIdDecoded);
        const target = decodeUriSafe(documentUri);
        return (await saf().listChildren(folderUri)).some((entry) => decodeUriSafe(entry.uri) === target);
    };


    /** The display name each resolved SAF sync document was listed under. */
    const resolvedSyncNames = new Map<string, string>();

    /** The picked tree's root document: the sync folder itself (the folder lock takes the same). */
    const safTreeRootUri = (uri: string): string | null => {
        const context = parseSafContext(uri);
        return context ? buildTreeDocumentUri(context, context.treeIdDecoded) : null;
    };

    /** A SAF folder's sync document by display name: the listed one, or (confirmed absent) the
     *  folder itself, with the name the first write publishes under. Nothing is created here; the
     *  versioned write creates data.json when it publishes, so a folder never holds an empty
     *  data.json that no one wrote. */
    const resolveSafSyncFile = async (uri: string): Promise<ResolvedSafSyncFile | null> => {
        const cached = syncUriResolutionCache.get(uri);
        if (cached) return { uri: cached, name: resolvedSyncNames.get(cached) ?? SYNC_FILE_NAME, exists: true };

        const context = parseSafContext(uri);
        if (!context) return null;
        const treeUri = `${context.prefix}/tree/${context.treeIdEncoded}`;
        const documentUri = buildTreeDocumentUri(context, context.treeIdDecoded);

        for (const candidate of [documentUri, treeUri]) {
            const match = await listDirectoryForSyncFile(candidate);
            if (match) {
                syncUriResolutionCache.set(uri, match.uri);
                resolvedSyncNames.set(match.uri, match.name);
                return { uri: match.uri, name: match.name, exists: true };
            }
        }
        host.log.info('File Sync folder holds no data.json yet; the first sync creates it', {
            scope: 'sync', extra: { releaseCheck: 'v1.3.7/file-sync-saf-safety', check: 'create', outcome: 'deferred' },
        });
        return { uri: documentUri, name: SYNC_FILE_NAME, exists: false };
    };

    /** The sync document's own name for a resolved URI: the name it was listed under, the URI's
     *  tail on a path-like provider, else data.json (a folder whose sync file is not written yet). */
    const syncLeafName = (resolvedUri: string): string => {
        const listed = resolvedSyncNames.get(resolvedUri);
        if (listed) return listed;
        const leaf = getUriLeafName(resolvedUri);
        if (!resolvedUri.startsWith('content://')) return leaf || SYNC_FILE_NAME;
        return leaf === SYNC_FILE_NAME || leaf === LEGACY_SYNC_FILE_NAME ? leaf : SYNC_FILE_NAME;
    };

    /** `createIfMissing` is accepted for the port's shape and never creates (see resolveSafSyncFile). */
    const resolveSyncFileUri = async (
        uri: string,
        _options?: { createIfMissing?: boolean }
    ): Promise<string> => {
        if (!uri.startsWith('content://')) return uri;
        if (isLikelySyncFileUri(uri)) return uri;
        return (await resolveSafSyncFile(uri))?.uri ?? uri;
    };

    /** The pick-time probe: File Sync writes by creating new files and renaming them, so a folder
     *  is usable only if a new file can be created in it. A refused create refuses the folder; the
     *  probe never writes into the existing sync file to prove anything. */
    const assertDirectoryWritable = async (directoryUri: string): Promise<void> => {
        const safPort = host.saf;
        if (!safPort) return;
        let testUri: string | null = null;
        try {
            testUri = await safPort.createFile(
                directoryUri,
                `mindwtr-write-test-${Date.now()}`,
                'text/plain'
            );
            try {
                await safPort.writeText(testUri, 'ok');
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
            if (testUri) {
                try {
                    await safPort.delete(testUri);
                } catch {
                    // Ignore cleanup failures for the temp file.
                }
            }
        }
    };


    /** One `remote-read` line per File Sync document seam (#1056 diagnostics). Every path below
     *  that can throw a SyncEncryption* error emits one first, so a shared log says what the
     *  folder actually held. */
    const logSyncFileRead = (input: Parameters<typeof buildSyncEncryptionRemoteReadExtra>[0]): void => {
        host.encryption.logEvent(
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
        syncEncryptedArtifactName(syncLeafName(resolvedUri));

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
        const encBytes = encUri ? await readSyncArtifactBytes(encUri) : null;
        if (encUri) candidates.push(encBytes);
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
            markRemoteEncryptionDiscovered(host.encryption.localState, {
                salt: inspected.salt,
                params: inspected.params,
            }, locationScope);
            return true;
        }
        // An existing `.enc` that read empty or headerless with no reported length proving it
        // whole may be a cut-off read of real ciphertext: never license a plaintext write beside it.
        if (encBytes && isUnverifiedLengthRead(encBytes)) throw new FileSyncUnverifiedReadError();
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
        // An empty `.enc` read with no reported length proving it whole may be cut off: it is not
        // "no encrypted generation".
        if (bytes && bytes.length === 0 && isUnverifiedLengthRead(bytes)) throw new FileSyncUnverifiedReadError();
        if (!bytes || bytes.length === 0) {
            // Inverse of discoverEncryptedSyncFolder: a peer ran the disable transition here, so
            // the `.enc` artifact is gone and the plaintext original is back. Never "no data" —
            // that would merge this device's store into a fresh plaintext generation and fork the
            // folder, and this device never follows the remote down to plaintext on its own.
            // A provider failure here is not proof that the plaintext generation is absent.
            // Propagate it so the keyed cycle cannot recreate `.enc` from local data while a
            // peer-restored plaintext document is merely unreadable.
            // Found by the folder listing: a lookup of a file that is not there proves nothing.
            const plainUri = await resolveSyncArtifactSiblingUri(resolvedUri, syncLeafName(resolvedUri), {
                createIfMissing: false,
            });
            const plain = plainUri ? await readSyncArtifactBytes(plainUri) : null;
            if (isPlaintextSyncArtifact(plain)) {
                logSyncFileRead({
                    artifact: syncLeafName(resolvedUri),
                    exists: true,
                    kind: 'plaintext',
                    bytes: plain?.length ?? null,
                    version: 'n/a',
                    decision: 'plaintext-discovered',
                });
                markRemotePlaintextDiscovered(host.encryption.localState, locationScope);
                await host.encryption.flush();
                throw new SyncEncryptionRemotePlaintextError();
            }
            // The typed plaintext check above wins; whatever remains (empty or whitespace bytes no
            // reported length proved whole) may be a cut-off read of the restored plaintext, so it
            // is never "no data here".
            if (plain && isUnverifiedLengthRead(plain)) throw new FileSyncUnverifiedReadError();
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
            markRemoteEncryptionDiscovered(host.encryption.localState, foreign, locationScope);
            await host.encryption.flush();
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
        const plaintext = await decryptRemoteArtifactOrThrow(bytes, material.key, host.crypto);
        return parseAppData(new TextDecoder().decode(plaintext));
    };

    // Read sync file from a stored path
    const readSyncFile = async (fileUri: string, options?: SyncFileAccessOptions): Promise<AppData | null> =>
        (await readSyncFileDetailed(fileUri, options)).data;

    /** readSyncFile, saying whether the data came from a backup instead of the sync file itself. */
    const readSyncFileDetailed = async (
        fileUri: string,
        options?: SyncFileAccessOptions,
    ): Promise<{ data: AppData | null; fromBackup: boolean }> => {
        const fromSyncFile = (data: AppData | null) => ({ data, fromBackup: false });
        try {
            const material = options?.material ?? null;
            if (material) {
                // The bookmarked-IO shortcut below is text-only (the native module exposes
                // readTextFile/writeTextFile), and ciphertext is not text. Encrypted folders
                // use the byte path against the already-bookmark-resolved URI, which is the
                // same access route the plaintext path falls back to when bookmarked IO fails.
                const resolvedEncryptedUri = await resolveSyncFileUri(fileUri, { createIfMissing: false });
                return fromSyncFile(await readEncryptedSyncFile(resolvedEncryptedUri, material, options?.locationScope));
            }

            const bookmark = options?.bookmark?.trim() || null;
            if (bookmark && host.os() === 'ios' && host.bookmarks.supported()) {
                let fileContent: string | null | undefined;
                try {
                    fileContent = await host.bookmarks.readText(bookmark);
                } catch (error) {
                    host.log.warn('Bookmarked sync read failed; falling back to direct file access', {
                        scope: 'sync',
                        extra: { error: fileSyncErrorCode(error) },
                    });
                }
                if (typeof fileContent === 'string') {
                    if (!fileContent) return fromSyncFile(null);
                    return fromSyncFile(parseAppData(fileContent));
                }
                if (fileContent === null) {
                    host.log.warn('Bookmarked sync read returned no content; falling back to direct file access', {
                        scope: 'sync',
                    });
                }
            }

            const resolvedUri = await resolveSyncFileUri(fileUri, { createIfMissing: false });
            if (resolvedUri !== fileUri) {
                host.log.info('Resolved sync path from directory URI to file URI', { scope: 'sync' });
            }

            // Detect iCloud Optimize Storage eviction before attempting reads.
            if (isICloudEvicted(resolvedUri)) {
                host.log.warn(ICLOUD_EVICTED_MESSAGE, { scope: 'sync' });
                // Try the backup file before giving up.
                const backupUri = resolvedUri.replace(/\/[^/]+$/, '/' + BACKUP_FILE_NAME);
                try {
                    const backupContent = await readFileText(backupUri);
                    if (backupContent) {
                        host.log.info('Using backup file while primary is iCloud-evicted', { scope: 'sync' });
                        return { data: parseAppData(backupContent), fromBackup: true };
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
                    // A SAF sync file is absent only when the folder's listing (which succeeded, or
                    // threw) does not hold it: a lookup with no answer proves nothing. data.json is
                    // created only when the versioned write publishes it.
                    const isSafUri = resolvedUri.startsWith('content://');
                    // The folder itself (resolved with no sync file listed) holds no data, and a
                    // sync file is absent only when the folder's listing (which succeeded, or threw)
                    // does not hold it: a lookup with no answer proves nothing.
                    const absent = isSafUri && (resolvedUri === safTreeRootUri(resolvedUri)
                        || !(await isListedInSafSyncFolder(resolvedUri)));
                    const read = absent ? null : isSafUri
                        ? await readSafText(resolvedUri)
                        : { text: await readFileText(resolvedUri), lengthVerified: true };
                    const fileContent = read?.text ?? null;
                    if (!fileContent) {
                        // "Nothing here" is also the exact shape of a folder a peer encrypted
                        // and whose plaintext original it then removed — take one look before
                        // reporting no data (and, with no data, letting the cycle write a
                        // fresh plaintext file alongside the encrypted one).
                        if (await discoverEncryptedSyncFolder(resolvedUri, null, options?.locationScope)) {
                            throw new SyncEncryptionNoKeyError();
                        }
                        if (read && !read.lengthVerified) throw new FileSyncUnverifiedReadError();
                        return fromSyncFile(null);
                    }
                    try {
                        return fromSyncFile(parseAppData(fileContent));
                    } catch (parseError) {
                        if (read && !read.lengthVerified) {
                            const rawBytes = new TextEncoder().encode(fileContent);
                            if (await discoverEncryptedSyncFolder(resolvedUri, rawBytes, options?.locationScope)) {
                                throw new SyncEncryptionNoKeyError();
                            }
                            throw new FileSyncUnverifiedReadError();
                        }
                        throw parseError;
                    }
                } catch (error) {
                    if (error instanceof SyncEncryptionNoKeyError || error instanceof FileSyncUnverifiedReadError) throw error;
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
            if (error instanceof FileSyncUnverifiedReadError) throw error;
            if (error instanceof SyncEncryptionNoKeyError
                || error instanceof SyncEncryptionRemotePlaintextError
                || error instanceof SyncEncryptionTerminalError) {
                host.log.warn('Sync file is encrypted and could not be read with the current key', { scope: 'sync' });
                throw error;
            }
            const message = String(error);
            // Provide a clearer UX-oriented error.
            if (fileUri.startsWith('content://') && /Invalid URI|IllegalArgumentException/i.test(message)) {
                throw new Error('Cannot access the selected sync file. Please re-select it in Settings → Sync.');
            }
            if (error instanceof SyncFileDocumentParseError) {
                host.log.warn('[Sync] Invalid JSON in sync file. Using local data and repairing file.', { scope: 'sync' });
                host.log.info('Invalid JSON in sync file; using local data.', { scope: 'sync', extra: { operation: 'read' } });
                return fromSyncFile(null);
            }
            // The error line keeps the code only: the diagnostics builder logs a message and stack, which here quote the path.
            host.log.error(new Error(fileSyncErrorCode(error)), { scope: 'sync', extra: { operation: 'read', message: 'Failed to read sync file' } });
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
    const readSyncFileVersioned = async (
        fileUri: string,
        options?: SyncFileAccessOptions,
    ): Promise<FileSyncReadResult> => {
        const material = options?.material ?? null;
        const resolvedUri = await resolveSyncFileUri(fileUri, { createIfMissing: false });
        const remote = await createFileSyncEncryptionRemotePort(resolvedUri);
        if (!remote) throw new Error('Unable to open the selected sync folder for a versioned read');
        const name = material ? encryptedLeafNameFor(resolvedUri) : syncLeafName(resolvedUri);
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
                    markRemoteEncryptionDiscovered(host.encryption.localState, foreign, options?.locationScope);
                    await host.encryption.flush();
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
                    host.crypto,
                );
                let decrypted: AppData;
                try {
                    decrypted = parseAppData(new TextDecoder().decode(plaintext));
                } catch (error) {
                    // Decryption's own typed errors (above) win; only what remains is wrapped.
                    if (isUnverifiedLengthRead(snapshot.bytes)) throw new FileSyncUnverifiedReadError();
                    throw error;
                }
                return {
                    data: decrypted,
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

        if (!material && snapshot.bytes && isUnverifiedLengthRead(snapshot.bytes)) {
            // No reported length proved these bytes whole, and they are empty or do not parse:
            // they may be a cut-off read of real data. Encryption discovery still comes first.
            if (await discoverEncryptedSyncFolder(resolvedUri, snapshot.bytes, options?.locationScope)) {
                throw new SyncEncryptionNoKeyError();
            }
            throw new FileSyncUnverifiedReadError();
        }

        const { data: recovered, fromBackup } = await readSyncFileDetailed(fileUri, options);
        if (!recovered || fromBackup) {
            // B5 guard, after every typed encryption check above and in the reader: a missing or
            // broken sync file is repaired only when no earlier copy of it could hold other rows.
            const retained = await listBlockingRetainedGenerations(resolvedUri);
            if (retained.length > 0) {
                host.log.warn('File Sync stopped: an earlier copy of the sync file is in the folder', {
                    scope: 'sync',
                    extra: { releaseCheck: 'v1.3.7/file-sync-saf-safety', check: 'retained', outcome: 'refused', count: retained.length },
                });
                throw new FileSyncRetainedGenerationError(retained.length);
            }
        }
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
        const name = material ? encryptedLeafNameFor(resolvedUri) : syncLeafName(resolvedUri);
        const expectedVersion = expectedFingerprint === FILE_SYNC_ABSENT_FINGERPRINT
            ? null
            : expectedFingerprint;
        const current = await remote.read(name);
        if (current.version !== expectedVersion) {
            throw new SyncEncryptionRemoteConflictError(`${name} changed before the File Sync write`);
        }

        // Preserve the previous generation as the backup, best effort: only one this cycle can read
        // (it parses, or it decrypts and parses) is worth keeping, and the rotation never writes into
        // an existing file (FileSyncRemotePort.rotateBackup). A failed rotation never licenses an
        // unconditional overwrite; the authoritative write below stays atomic either way.
        if (current.bytes && (material || !resolvedUri.startsWith('content://'))) {
            try {
                const readable = material
                    ? parseAppData(new TextDecoder().decode(
                        await decryptRemoteArtifactOrThrow(current.bytes, material.key, host.crypto),
                    ))
                    : parseAppData(new TextDecoder().decode(current.bytes));
                void readable;
                const backupName = material ? syncEncryptedArtifactName(BACKUP_FILE_NAME) : BACKUP_FILE_NAME;
                await remote.rotateBackup(backupName, current.bytes);
                host.log.info('File Sync backup rotated through a new file', {
                    scope: 'sync', extra: { releaseCheck: 'v1.3.7/file-sync-saf-safety', check: 'backup', outcome: 'rotated' },
                });
            } catch (error) {
                host.log.warn('File Sync backup rotation skipped; continuing with the atomic write', {
                    scope: 'sync',
                    extra: { error: fileSyncErrorCode(error) },
                });
            }
        }

        const payload = material
            ? await encryptSyncArtifact(
                new TextEncoder().encode(content),
                material,
                host.crypto,
            )
            : new TextEncoder().encode(content);
        await remote.write(name, payload, expectedVersion);

        const written = await remote.read(name);
        if (!written.bytes) throw new Error('Sync file write verification failed: file is empty after write.');
        if (material) {
            const plaintext = await decryptRemoteArtifactOrThrow(
                written.bytes,
                material.key,
                host.crypto,
            );
            parseAppData(new TextDecoder().decode(plaintext));
        } else {
            parseAppData(new TextDecoder().decode(written.bytes));
        }
    };

    // Write merged data back to sync file. Every write is the versioned (CAS) write: core's cycle
    // always passes the fingerprint its read returned, and a write without one is refused rather
    // than overwriting whatever the folder holds now.
    const writeSyncFile = async (fileUri: string, data: AppData, options?: SyncFileAccessOptions): Promise<void> => {
        try {
            if (options?.expectedFingerprint === undefined) {
                throw new Error('File Sync document version is unavailable; refusing an unconditional write');
            }
            const content = JSON.stringify(data, null, 2);
            const resolvedUri = await resolveSyncFileUri(fileUri, { createIfMissing: true });
            await writeSyncFileVersioned(resolvedUri, content, options?.material ?? null, options.expectedFingerprint);
        } catch (error) {
            host.log.error(new Error(fileSyncErrorCode(error)), { scope: 'sync', extra: { operation: 'write', message: 'Failed to write sync file' } });
            throw error;
        }
    };

    /** The Android pick's folder step (after the system picker granted `directoryUri`): the folder's
     *  sync file by name, the write probe, and the parsed data. Nothing is created here. */
    const prepareSafSyncFolder = async (directoryUri: string): Promise<FileSyncPickResult> => {
        const resolved = await resolveSafSyncFile(directoryUri);
        if (!resolved) {
            throw new Error('Unable to open the selected sync folder');
        }
        const fileUri = resolved.uri;
        const fileContent = resolved.exists ? await readFileText(fileUri) : null;
        await assertDirectoryWritable(directoryUri);
        if (!fileContent) {
            return {
                tasks: [],
                projects: [],
                sections: [],
                areas: [],
                settings: {},
                __fileUri: fileUri,
                __fileBookmark: undefined,
                __icloud: isICloudUri(fileUri),
            };
        }
        const data = parseAppData(fileContent);
        return { ...data, __fileUri: fileUri, __icloud: isICloudUri(fileUri) };
    };

    return {
        ...remote,
        resolveSyncFileUri,
        readSyncFile,
        readSyncFileVersioned,
        writeSyncFile,
        prepareSafSyncFolder,
        parseAppData,
        readFileText,
        isICloudUri,
        resolveSafSyncFile,
        READONLY_FOLDER_MESSAGE,
        isReadOnlyError,
    };
};

export type MobileFileSync = ReturnType<typeof createMobileFileSync>;
