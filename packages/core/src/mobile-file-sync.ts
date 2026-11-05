


import { decodeUriSafe, sleep } from './async-utils';
import {
    createMobileFileSyncRemote,
    fileSyncErrorCode,
    fileSyncOwnerCall,
    FileSyncPathOwnerTerminatedError,
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


export type MobileFileSyncFullHost = MobileFileSyncHost & {
    os(): string;

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


export type FileSyncPickResult = AppData & {
    __fileUri?: string;
    __fileBookmark?: string;

    __icloud?: boolean;
};


export class SyncFileDocumentParseError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message);
        this.name = 'SyncFileDocumentParseError';
        if (options) (this as Error & { cause?: unknown }).cause = options.cause;
    }
}


export class FileSyncUnverifiedReadError extends Error {
    constructor() {
        super('File Sync read conflict: the sync file could not be proven complete and did not parse; nothing was written');
        this.name = 'FileSyncUnverifiedReadError';
    }
}


export class FileSyncRetainedGenerationError extends Error {
    constructor(public readonly retained: number) {
        super('File Sync conflict: the sync file is missing or damaged while an earlier copy of it is in the sync folder; nothing was written');
        this.name = 'FileSyncRetainedGenerationError';
    }
}

export interface SyncFileAccessOptions {

    bookmark?: string | null;


    material?: SyncKeyMaterial | null;


    expectedFingerprint?: string;


    locationScope?: string | null;
}

export type SafContext = {
    prefix: string;
    treeIdEncoded: string;
    treeIdDecoded: string;
};

export type ResolvedSafSyncFile = { uri: string; name: string; exists: boolean };


export const createMobileFileSync = (host: MobileFileSyncFullHost) => {
    const remote = createMobileFileSyncRemote(host);
    const observedPublication = host.path?.observedPublication !== undefined;
    const pathExists = (uri: string) => observedPublication
        ? fileSyncOwnerCall(() => host.path.exists(uri)) : host.path.exists(uri);
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


    const isICloudUri = (uri: string): boolean => {
        const decoded = decodeUriSafe(uri);
        return decoded.includes('Mobile Documents') || decoded.includes('iCloud');
    };

    const isICloudEvicted = async (fileUri: string): Promise<boolean> => {
        if (host.os() !== 'ios') return false;
        if (!fileUri.startsWith('file://')) return false;
        try {
            if (await pathExists(fileUri)) return false;
            const parts = fileUri.split('/');
            const name = parts.pop() ?? '';
            const parentUri = parts.join('/');
            const placeholderUri = `${parentUri}/.${name}.icloud`;
            return await pathExists(placeholderUri);
        } catch (error) {
            if (error instanceof FileSyncPathOwnerTerminatedError) throw error;
            return false;
        }
    };


    const listDirectoryForSyncFile = async (directoryUri: string): Promise<{ uri: string; name: string } | null> => {
        const entries = (await saf().listChildren(directoryUri)).map((entry) => ({
            uri: entry.uri,

            name: entry.name || getUriLeafName(entry.uri),
        }));
        return entries.find((entry) => entry.name === SYNC_FILE_NAME)
            ?? entries.find((entry) => entry.name === LEGACY_SYNC_FILE_NAME)
            ?? null;
    };

    function sanitizeJsonText(raw: string): string {

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


    const readSafText = async (fileUri: string): Promise<{ text: string; lengthVerified: boolean }> => {
        const read = await saf().readBytes(fileUri);
        return { text: new TextDecoder().decode(read.bytes), lengthVerified: read.lengthVerified };
    };

    async function readFileText(fileUri: string): Promise<string | null> {
        if (fileUri.startsWith('content://')) {
            return (await readSafText(fileUri)).text;
        }

        const text = observedPublication
            ? await fileSyncOwnerCall(() => host.path.readText(fileUri)) : await host.path.readText(fileUri);
        if (text === null) {

            host.log.info('Sync file does not exist', { scope: 'sync' });
        }
        return text;
    }


    const isListedInSafSyncFolder = async (documentUri: string): Promise<boolean> => {
        const context = parseSafContext(documentUri);
        if (!context) return false;
        const folderUri = buildTreeDocumentUri(context, context.treeIdDecoded);
        const target = decodeUriSafe(documentUri);
        return (await saf().listChildren(folderUri)).some((entry) => decodeUriSafe(entry.uri) === target);
    };


    const resolvedSyncNames = new Map<string, string>();


    const safTreeRootUri = (uri: string): string | null => {
        const context = parseSafContext(uri);
        return context ? buildTreeDocumentUri(context, context.treeIdDecoded) : null;
    };


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


    const syncLeafName = (resolvedUri: string): string => {
        const listed = resolvedSyncNames.get(resolvedUri);
        if (listed) return listed;
        const leaf = getUriLeafName(resolvedUri);
        if (!resolvedUri.startsWith('content://')) return leaf || SYNC_FILE_NAME;
        return leaf === SYNC_FILE_NAME || leaf === LEGACY_SYNC_FILE_NAME ? leaf : SYNC_FILE_NAME;
    };


    const resolveSyncFileUri = async (
        uri: string,
        _options?: { createIfMissing?: boolean }
    ): Promise<string> => {
        if (!uri.startsWith('content://')) return uri;
        if (isLikelySyncFileUri(uri)) return uri;
        return (await resolveSafSyncFile(uri))?.uri ?? uri;
    };


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

                }
            }
        }
    };


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


    const discoverEncryptedSyncFolder = async (
        resolvedUri: string,
        plainBytes: Uint8Array | null,
        locationScope?: string | null,
    ): Promise<boolean> => {
        const candidates: (Uint8Array | null)[] = [plainBytes];


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


        if (bytes && bytes.length === 0 && isUnverifiedLengthRead(bytes)) throw new FileSyncUnverifiedReadError();
        if (!bytes || bytes.length === 0) {


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


    const readSyncFile = async (fileUri: string, options?: SyncFileAccessOptions): Promise<AppData | null> =>
        (await readSyncFileDetailed(fileUri, options)).data;


    const readSyncFileDetailed = async (
        fileUri: string,
        options?: SyncFileAccessOptions,
    ): Promise<{ data: AppData | null; fromBackup: boolean }> => {
        const fromSyncFile = (data: AppData | null) => ({ data, fromBackup: false });
        try {
            const material = options?.material ?? null;
            if (material) {


                const resolvedEncryptedUri = await resolveSyncFileUri(fileUri, { createIfMissing: false });
                return fromSyncFile(await readEncryptedSyncFile(resolvedEncryptedUri, material, options?.locationScope));
            }

            const bookmark = options?.bookmark?.trim() || null;
            if (bookmark && host.os() === 'ios' && host.bookmarks.supported()) {
                let fileContent: string | null | undefined;
                try {
                    fileContent = await host.bookmarks.readText(bookmark);
                } catch (error) {
                    if (error instanceof FileSyncPathOwnerTerminatedError) throw error;
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

            if (await isICloudEvicted(resolvedUri)) {
                host.log.warn(ICLOUD_EVICTED_MESSAGE, { scope: 'sync' });

                const backupUri = resolvedUri.replace(/\/[^/]+$/, '/' + BACKUP_FILE_NAME);
                try {
                    const backupContent = await readFileText(backupUri);
                    if (backupContent) {
                        host.log.info('Using backup file while primary is iCloud-evicted', { scope: 'sync' });
                        return { data: parseAppData(backupContent), fromBackup: true };
                    }
                } catch (error) {
                    if (error instanceof FileSyncPathOwnerTerminatedError) throw error;
                }
                throw new Error(ICLOUD_EVICTED_MESSAGE);
            }


            let lastError: unknown = null;
            for (let attempt = 0; attempt < 4; attempt += 1) {
                try {


                    const isSafUri = resolvedUri.startsWith('content://');


                    const absent = isSafUri && (resolvedUri === safTreeRootUri(resolvedUri)
                        || !(await isListedInSafSyncFolder(resolvedUri)));
                    const read = absent ? null : isSafUri
                        ? await readSafText(resolvedUri)
                        : { text: await readFileText(resolvedUri), lengthVerified: true };
                    const fileContent = read?.text ?? null;
                    if (!fileContent) {


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
                    if (error instanceof FileSyncPathOwnerTerminatedError || error instanceof SyncEncryptionNoKeyError || error instanceof FileSyncUnverifiedReadError) throw error;
                    lastError = error;

                    await sleep(120 + attempt * 80);
                }
            }
            const rawBytes = await readSyncArtifactBytes(resolvedUri).catch((error: unknown) => {
                if (error instanceof FileSyncPathOwnerTerminatedError) throw error;
                return null;
            });
            if (await discoverEncryptedSyncFolder(resolvedUri, rawBytes, options?.locationScope)) {
                throw new SyncEncryptionNoKeyError();
            }
            throw lastError;
        } catch (error) {
            if (error instanceof FileSyncPathOwnerTerminatedError) throw error;
            if (error instanceof FileSyncUnverifiedReadError) throw error;
            if (error instanceof SyncEncryptionNoKeyError
                || error instanceof SyncEncryptionRemotePlaintextError
                || error instanceof SyncEncryptionTerminalError) {
                host.log.warn('Sync file is encrypted and could not be read with the current key', { scope: 'sync' });
                throw error;
            }
            const message = String(error);

            if (fileUri.startsWith('content://') && /Invalid URI|IllegalArgumentException/i.test(message)) {
                throw new Error('Cannot access the selected sync file. Please re-select it in Settings → Sync.');
            }
            if (error instanceof SyncFileDocumentParseError) {
                host.log.warn('[Sync] Invalid JSON in sync file. Using local data and repairing file.', { scope: 'sync' });
                host.log.info('Invalid JSON in sync file; using local data.', { scope: 'sync', extra: { operation: 'read' } });
                return fromSyncFile(null);
            }

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


                }
            }
        }

        if (!material && snapshot.bytes && isUnverifiedLengthRead(snapshot.bytes)) {


            if (await discoverEncryptedSyncFolder(resolvedUri, snapshot.bytes, options?.locationScope)) {
                throw new SyncEncryptionNoKeyError();
            }
            throw new FileSyncUnverifiedReadError();
        }

        const { data: recovered, fromBackup } = await readSyncFileDetailed(fileUri, options);
        if (!recovered || fromBackup) {


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
                if (error instanceof FileSyncPathOwnerTerminatedError) throw error;
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

        const written = (await remote.write(name, payload, expectedVersion)) ?? await remote.read(name);
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
        if (observedPublication && !resolvedUri.startsWith('content://')) {
            host.log.info('File Sync observed path publication completed', {
                scope: 'sync',
                extra: { releaseCheck: 'v1.3.9/file-sync-observed-publication', operation: 'write', outcome: 'completed' },
            });
        }
    };


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
