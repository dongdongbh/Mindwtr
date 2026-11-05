


import { computeSha256Hex } from './attachment-hash';
import { ATTACHMENTS_DIR_NAME } from './attachment-paths';
import { inspectSyncArtifact } from './sync-crypto';
import {
    compareSyncTransitionEntryNames,
    SyncEncryptionRemoteConflictError,
    type SyncEncryptionRemoteEntry,
    type SyncEncryptionRemoteInventory,
    type SyncEncryptionRemotePort,
    type SyncEncryptionRemoteRead,
} from './sync-encryption';
import { LEGACY_SYNC_FILE_NAME, SYNC_FILE_NAME } from './sync-service-utils';

export const SYNC_FILE_TRANSITION_CAS_UNAVAILABLE = 'SYNC_FILE_TRANSITION_CAS_UNAVAILABLE';

export class FileSyncPathOwnerTerminatedError extends Error {
    readonly code = 'FILE_SYNC_PATH_OWNER_TERMINATED';
    constructor() {
        super('FILE_SYNC_PATH_OWNER_TERMINATED: the selected path owner session cannot continue');
        this.name = 'FileSyncPathOwnerTerminatedError';
    }
}

export const fileSyncOwnerCall = async <T>(operation: () => T | Promise<T>): Promise<T> => {
    try {
        return await operation();
    } catch (error) {
        throw error instanceof FileSyncPathOwnerTerminatedError ? error : new FileSyncPathOwnerTerminatedError();
    }
};

export const fileSyncErrorCode = (error: unknown): string => {
    const message = error instanceof Error ? error.message : String(error);
    const code = /^([A-Z][A-Z0-9_]{2,}):/.exec(message)?.[1];
    if (code) return code;
    if (!(error instanceof Error)) return typeof error;
    return /^[A-Za-z][A-Za-z0-9_]*$/.test(error.name) ? error.name : 'Error';
};


export type MobileFileSyncSafEntry = {
    uri: string;
    name: string | null;
    mime?: string | null;
    size: number | null;
    lastModified?: number | null;
};


export type MobileFileSyncSafPort = {

    listChildren(dirUri: string): Promise<MobileFileSyncSafEntry[]>;

    stat(uri: string): Promise<MobileFileSyncSafEntry | null>;

    readBytes(uri: string): Promise<{ bytes: Uint8Array; lengthVerified: boolean }>;

    writeBytes(uri: string, bytes: Uint8Array): Promise<void>;

    writeText(uri: string, text: string): Promise<void>;

    createFile(dirUri: string, name: string, mimeType: string): Promise<string>;

    delete(uri: string): Promise<void>;

    makeDirectory?(parentUri: string, name: string): Promise<string>;

    rename(uri: string, displayName: string): Promise<{ uri: string; name: string }>;
};


export type MobileFileSyncPathPort = {
    exists(uri: string): boolean | Promise<boolean>;
    info(uri: string): Promise<{ exists?: boolean; size?: number }>;

    list(dirUri: string): Promise<string[]>;

    readBytes(uri: string): Promise<Uint8Array | null>;

    readText(uri: string): Promise<string | null>;

    writeBytes(uri: string, bytes: Uint8Array): Promise<void>;

    createExclusive(uri: string): Promise<'created' | 'exists'>;
    writeCreated(uri: string, bytes: Uint8Array): void | Promise<void>;
    delete(uri: string): Promise<void>;
    rename(uri: string, name: string): string | Promise<string>;
    observedPublication?: MobileFileSyncObservedPublication;
};

export type MobileFileSyncObservedPublication = Required<Pick<MobileFileSyncPathPort, 'createExclusive' | 'writeCreated'>> & {
    renameObserved(uri: string, name: string, expectedBytes: Uint8Array): Promise<string>;
    deleteOwned(uri: string, expectedBytes: Uint8Array): Promise<void>;
};

export type MobileFileSyncLog = {
    info(message: string, context?: { scope?: string; extra?: Record<string, unknown> }): void;
    warn(message: string, context?: { scope?: string; extra?: Record<string, unknown> }): void;
    error(error: unknown, context?: { scope?: string; extra?: Record<string, unknown> }): void;
};


export type MobileFileSyncHost = {

    saf: MobileFileSyncSafPort | null;
    path: MobileFileSyncPathPort;
    log: MobileFileSyncLog;
};

export type FileSyncEncryptionTarget = {

    dirUri: string;

    attachmentsDirUri: string | null;
};

export type FileSyncTransitionMutationPoint = 'before-quarantine' | 'before-install' | 'before-remove-commit';

export type FileSyncTransitionInventoryPoint = 'after-document-snapshot';

export type FileSyncTransitionTestHooks = {
    onMutationPoint?: (point: FileSyncTransitionMutationPoint, name: string) => void | Promise<void>;
    onInventoryPoint?: (point: FileSyncTransitionInventoryPoint) => void | Promise<void>;
};

export type FileSyncRemotePort = SyncEncryptionRemotePort & {


    rotateBackup(name: string, bytes: Uint8Array): Promise<void>;
};


export const createMobileFileSyncRemote = (host: MobileFileSyncHost) => {
    const publication = host.path?.observedPublication;
    if (publication !== undefined && (publication === null || typeof publication !== 'object'
        || typeof publication.createExclusive !== 'function' || typeof publication.writeCreated !== 'function'
        || typeof publication.renameObserved !== 'function' || typeof publication.deleteOwned !== 'function')) {
        throw new Error(`${SYNC_FILE_TRANSITION_CAS_UNAVAILABLE}: a complete observed publication capability is required`);
    }
    const createPathExclusive = (uri: string) => publication
        ? fileSyncOwnerCall(() => publication.createExclusive(uri)) : host.path.createExclusive(uri);
    const writePathCreated = (uri: string, bytes: Uint8Array) => publication
        ? fileSyncOwnerCall(() => publication.writeCreated(uri, new Uint8Array(bytes))) : host.path.writeCreated(uri, bytes);
    const pathInfo = (uri: string) => publication
        ? fileSyncOwnerCall(async () => {
            const info = await host.path.info(uri);
            if (typeof info.exists !== 'boolean') throw new FileSyncPathOwnerTerminatedError();
            return info;
        }) : host.path.info(uri);
    const pathList = (uri: string) => publication
        ? fileSyncOwnerCall(() => host.path.list(uri)) : host.path.list(uri);
    const legacyMissingInfo = (error: unknown): { exists: false } => {
        if (error instanceof FileSyncPathOwnerTerminatedError) throw error;
        return { exists: false };
    };
    const saf = (): MobileFileSyncSafPort => {
        if (!host.saf) throw new Error('This Android build does not support Storage Access Framework (SAF).');
        return host.saf;
    };

    const renameSafDocument = async (uri: string, displayName: string): Promise<{ uri: string; name: string }> => {
        const result = await saf().rename(uri, displayName);
        if (!result || typeof result.uri !== 'string' || typeof result.name !== 'string' || result.name !== displayName) {
            throw new Error(`${SYNC_FILE_TRANSITION_CAS_UNAVAILABLE}: the document provider changed the requested transition name`);
        }
        return result;
    };

    const DEFAULT_ARTIFACT_MIME = 'application/octet-stream';


    const PAD_BYTE = 0x20;

    const isSaf = (uri: string): boolean => uri.startsWith('content://');

    const getLeafName = (uri: string): string => {
        const stripped = decodeURIComponent(uri.split('?')[0]?.split('#')[0] ?? uri).replace(/\/+$/, '');
        const lastSeparator = Math.max(stripped.lastIndexOf('/'), stripped.lastIndexOf(':'));
        return lastSeparator >= 0 ? stripped.slice(lastSeparator + 1) : stripped;
    };


    const unverifiedLengthReads = new WeakSet<Uint8Array>();
    const isUnverifiedLengthRead = (bytes: Uint8Array): boolean => unverifiedLengthReads.has(bytes);


    const readSyncArtifactBytes = async (uri: string): Promise<Uint8Array | null> => {
        if (isSaf(uri)) {
            try {
                const read = await saf().readBytes(uri);
                if (!read.lengthVerified) unverifiedLengthReads.add(read.bytes);
                return read.bytes;
            } catch (error) {


                if (!(await saf().stat(uri))) return null;
                throw error;
            }
        }
        if (!publication) return host.path.readBytes(uri);
        const bytes = await fileSyncOwnerCall(() => host.path.readBytes(uri));
        return bytes === null ? null : new Uint8Array(bytes);
    };


    const padBytesForNonTruncatingOverwrite = (bytes: Uint8Array, previousLength: number): Uint8Array => {
        if (previousLength <= bytes.length) return bytes;
        const padded = new Uint8Array(previousLength);
        padded.set(bytes, 0);
        padded.fill(PAD_BYTE, bytes.length);
        return padded;
    };


    const writeArtifactPayload = async (uri: string, payload: Uint8Array): Promise<void> => {
        if (isSaf(uri) && host.saf) {
            await host.saf.writeBytes(uri, payload);
            return;
        }
        await host.path.writeBytes(uri, payload);
    };

    const writeSyncArtifactBytes = async (
        uri: string,
        bytes: Uint8Array,
        options: { createOnly?: boolean } = {},
    ): Promise<void> => {
        if (options.createOnly) {
            if (isSaf(uri)) throw new Error('SAF create-only writes must create through the directory handle');
            if (await createPathExclusive(uri) === 'exists') {
                throw new SyncEncryptionRemoteConflictError(`${uri} was created by another writer`);
            }
            await writePathCreated(uri, bytes);
            return;
        }
        if (!isSaf(uri) && publication) throw new FileSyncPathOwnerTerminatedError();
        const isSealed = inspectSyncArtifact(bytes).kind === 'encrypted';
        if (isSealed) {


            const previous = await readSyncArtifactBytes(uri).catch(() => null);
            const payload = padBytesForNonTruncatingOverwrite(bytes, previous?.length ?? 0);
            return writeArtifactPayload(uri, payload);
        }


        if (!isSaf(uri)) {
            const previous = await readSyncArtifactBytes(uri).catch(() => null);
            if (previous && previous.length > bytes.length) {
                await deleteSyncArtifact(uri).catch(() => undefined);
            }
        }
        return writeArtifactPayload(uri, bytes);
    };

    const writeFreshArtifact = async (uri: string, bytes: Uint8Array): Promise<void> => {
        if (!isSaf(uri) && publication) {
            await writePathCreated(uri, bytes);
            return;
        }
        await writeArtifactPayload(uri, bytes);
    };

    const deleteSyncArtifact = async (uri: string, expectedBytes?: Uint8Array): Promise<void> => {
        if (isSaf(uri)) {
            if (!host.saf) return;
            await host.saf.delete(uri);
            return;
        }
        if (publication) {
            if (expectedBytes === undefined) throw new FileSyncPathOwnerTerminatedError();
            await fileSyncOwnerCall(() => publication.deleteOwned(uri, new Uint8Array(expectedBytes)));
            return;
        }
        await host.path.delete(uri);
    };

    type DirectoryHandle = {

        entries: Map<string, string>;

        refresh(): Promise<void>;
        resolve(name: string, options: { createIfMissing: boolean; mimeType?: string }): Promise<string | null>;
        listExact(name: string): Promise<string[]>;
        createNew(name: string, mimeType?: string, options?: { repairDecoratedName?: boolean; skipClosingListing?: boolean }): Promise<string>;
        rename(uri: string, name: string, expectedBytes?: Uint8Array): Promise<string>;
    };

    const openSafDirectory = async (dirUri: string): Promise<DirectoryHandle> => {
        const entries = new Map<string, string>();


        const listNamed = async (): Promise<{ uri: string; name: string }[]> => (await saf().listChildren(dirUri))
            .map((entry) => ({ uri: entry.uri, name: entry.name || getLeafName(entry.uri) }));
        const nameOf = async (uri: string): Promise<string> => (await saf().stat(uri))?.name || getLeafName(uri);
        const refresh = async (): Promise<void> => {
            const next = new Map<string, string>();
            for (const entry of await listNamed()) {
                if (entry.name && !next.has(entry.name)) next.set(entry.name, entry.uri);
            }
            entries.clear();
            for (const [name, uri] of next) entries.set(name, uri);
        };
        await refresh();
        const listExact = async (name: string): Promise<string[]> => {
            const matches = (await listNamed()).filter((entry) => entry.name === name).map((entry) => entry.uri);
            if (matches.length === 1) entries.set(name, matches[0]);
            else entries.delete(name);
            return matches;
        };
        return {
            entries,
            refresh,
            resolve: async (name, options) => {
                let existing = entries.get(name);
                if (!existing) {
                    for (const entry of await listNamed()) {
                        if (entry.name === name) {
                            existing = entry.uri;
                            entries.set(name, entry.uri);
                            break;
                        }
                    }
                }
                if (existing) return existing;
                if (!options.createIfMissing || !host.saf) return null;
                const created = await host.saf.createFile(
                    dirUri,
                    name,
                    options.mimeType ?? DEFAULT_ARTIFACT_MIME,
                );
                if (!created) return null;


                const createdName = await nameOf(created);
                if (createdName !== name) {
                    host.log.warn('SAF provider renamed a sync artifact on create', {
                        scope: 'sync',
                        extra: { requested: name, created: createdName },
                    });
                }
                entries.set(name, created);
                return created;
            },
            listExact,
            createNew: async (name, mimeType = DEFAULT_ARTIFACT_MIME, options = {}) => {
                if (!host.saf) {
                    throw new Error('This Android build cannot create SAF transition files.');
                }
                let created = await host.saf.createFile(dirUri, name, mimeType);
                const createdName = created ? await nameOf(created) : name;
                if (created && createdName !== name && options.repairDecoratedName === false) {

                    await deleteSyncArtifact(created).catch(() => undefined);
                    host.log.warn('SAF provider renamed a new document on create; not published', {
                        scope: 'sync',
                        extra: { requested: name, created: createdName },
                    });
                    throw new SyncEncryptionRemoteConflictError(`${name} could not be created under its own name`);
                }
                if (created && createdName !== name) {


                    if ((await listExact(name)).length > 0) {
                        await deleteSyncArtifact(created).catch(() => undefined);
                        throw new SyncEncryptionRemoteConflictError(`${name} was created by another writer`);
                    }
                    try {
                        const repaired = await renameSafDocument(created, name);
                        host.log.warn('SAF provider renamed a transition scratch on create; repaired', {
                            scope: 'sync',
                            extra: { requested: name, created: createdName },
                        });
                        created = repaired.uri;
                    } catch (error) {
                        host.log.warn('SAF provider renamed a transition scratch on create; repair failed', {
                            scope: 'sync',
                            extra: { requested: name, created: createdName, error: fileSyncErrorCode(error) },
                        });
                        await deleteSyncArtifact(created).catch(() => undefined);
                        throw new SyncEncryptionRemoteConflictError(`${name} was created or renamed by another writer`);
                    }
                }
                if (!created) {
                    throw new SyncEncryptionRemoteConflictError(`${name} was created or renamed by another writer`);
                }
                if (options.skipClosingListing) {
                    entries.set(name, created);
                    return created;
                }
                const matches = await listExact(name);
                if (matches.length !== 1 || matches[0] !== created) {
                    await deleteSyncArtifact(created).catch(() => undefined);
                    throw new SyncEncryptionRemoteConflictError(`${name} was created by another writer`);
                }
                entries.set(name, created);
                return created;
            },
            rename: async (uri, name) => {
                const previousName = [...entries].find(([, entryUri]) => entryUri === uri)?.[0] ?? getLeafName(uri);
                let renamed: { uri: string; name: string };
                try {
                    renamed = await renameSafDocument(uri, name);
                } catch (error) {
                    if (error instanceof FileSyncPathOwnerTerminatedError) throw error;
                    if ((await listExact(name)).length > 0) {
                        throw new SyncEncryptionRemoteConflictError(`${name} was created by another writer`);
                    }
                    throw error;
                }
                entries.delete(previousName);
                entries.set(name, renamed.uri);
                return renamed.uri;
            },
        };
    };

    const openPathDirectory = async (dirUri: string): Promise<DirectoryHandle> => {
        const normalized = dirUri.endsWith('/') ? dirUri : `${dirUri}/`;
        const entries = new Map<string, string>();
        const refresh = async (): Promise<void> => {
            const next = new Map<string, string>();
            for (const name of await pathList(normalized)) {
                next.set(name, `${normalized}${name}`);
            }
            entries.clear();
            for (const [name, uri] of next) entries.set(name, uri);
        };
        await refresh();
        const listExact = async (name: string): Promise<string[]> => {
            const candidate = `${normalized}${name}`;
            const info = await pathInfo(candidate).catch(legacyMissingInfo);
            if (info.exists) {
                entries.set(name, candidate);
                return [candidate];
            }
            entries.delete(name);
            return [];
        };
        return {
            entries,
            refresh,
            resolve: async (name, options) => {
                let existing = entries.get(name);
                if (!existing) {
                    const candidate = `${normalized}${name}`;
                    const info = await pathInfo(candidate).catch(legacyMissingInfo);
                    if (info.exists) {
                        existing = candidate;
                        entries.set(name, candidate);
                    }
                }
                if (existing) return existing;
                if (!options.createIfMissing) return null;
                const uri = `${normalized}${name}`;
                entries.set(name, uri);
                return uri;
            },
            listExact,
            createNew: async (name) => {
                const uri = `${normalized}${name}`;
                if (await createPathExclusive(uri) === 'exists') {
                    throw new SyncEncryptionRemoteConflictError(`${name} was created by another writer`);
                }
                entries.set(name, uri);
                return uri;
            },
            rename: async (uri, name, expectedBytes) => {
                const previousName = getLeafName(uri);
                let renamedUri: string;
                try {
                    if (publication) {
                        if (expectedBytes === undefined) throw new FileSyncPathOwnerTerminatedError();
                        renamedUri = await fileSyncOwnerCall(() => publication.renameObserved(uri, name, new Uint8Array(expectedBytes)));
                    } else {
                        renamedUri = await host.path.rename(uri, name);
                    }
                } catch (error) {
                    if (error instanceof FileSyncPathOwnerTerminatedError) throw error;
                    if ((await listExact(name)).length > 0) {
                        throw new SyncEncryptionRemoteConflictError(`${name} was created by another writer`);
                    }
                    throw error;
                }
                entries.delete(previousName);
                entries.set(name, renamedUri);
                host.log.info('File Sync path rename completed', {
                    scope: 'sync',
                    extra: { releaseCheck: 'v1.3.9/file-sync-path-await', operation: 'rename', outcome: 'completed' },
                });
                return renamedUri;
            },
        };
    };

    const openDirectory = (dirUri: string): Promise<DirectoryHandle> =>
        isSaf(dirUri) ? openSafDirectory(dirUri) : openPathDirectory(dirUri);


    const isSeedBackupDocumentName = (name: string): boolean => {
        const lower = name.toLowerCase();
        return (lower.startsWith('mindwtr-backup-') || lower.startsWith('data-backup-'))
            && (lower.endsWith('.json') || lower.endsWith('.json.enc'));
    };


    const isSyncDocumentName = (name: string): boolean => {
        const base = name.replace(/\.enc(\.bak|\.tmp|\.previous)?$/, '').replace(/\.(bak|tmp|previous)$/, '');
        return base === SYNC_FILE_NAME || base === LEGACY_SYNC_FILE_NAME || isSeedBackupDocumentName(name);
    };

    const CANONICAL_SYNC_DOCUMENT_NAMES = new Set<string>([
        SYNC_FILE_NAME,
        `${SYNC_FILE_NAME}.enc`,
        LEGACY_SYNC_FILE_NAME,
        `${LEGACY_SYNC_FILE_NAME}.enc`,
    ]);


    const isRetainedGenerationName = (name: string): boolean => {
        if (isTransitionScratchName(name)) return true;
        if (CANONICAL_SYNC_DOCUMENT_NAMES.has(name) || isSeedBackupDocumentName(name)) return false;


        let base = name;
        let stripped = false;
        for (let match = RETAINED_SUFFIX.exec(base); match; match = RETAINED_SUFFIX.exec(base)) {
            base = base.slice(0, -match[0].length);
            stripped = true;
        }
        return stripped && (base === SYNC_FILE_NAME || base === LEGACY_SYNC_FILE_NAME);
    };
    const RETAINED_SUFFIX = /\.(?:enc|bak|tmp|previous)$/;


    const listBlockingRetainedGenerations = async (syncFileUri: string): Promise<string[]> => {
        const target = await resolveFileSyncEncryptionTarget(syncFileUri);
        if (!target) return [];
        if (isSaf(target.dirUri)) {
            return (await saf().listChildren(target.dirUri))
                .map((entry) => ({ name: entry.name || getLeafName(entry.uri), size: entry.size }))
                .filter((entry) => isRetainedGenerationName(entry.name) && entry.size !== 0)
                .map((entry) => entry.name);
        }
        const normalized = target.dirUri.endsWith('/') ? target.dirUri : `${target.dirUri}/`;
        const blocking: string[] = [];
        for (const name of await pathList(normalized)) {
            if (!isRetainedGenerationName(name)) continue;
            const info = await pathInfo(`${normalized}${name}`);
            if (info.exists === false) continue;
            if (typeof info.size === 'number' && info.size === 0) continue;
            blocking.push(name);
        }
        return blocking;
    };

    const FIXED_SYNC_DOCUMENT_NAMES = [
        SYNC_FILE_NAME,
        `${SYNC_FILE_NAME}.enc`,
        `${SYNC_FILE_NAME}.bak`,
        `${SYNC_FILE_NAME}.enc.bak`,
        `${SYNC_FILE_NAME}.bak.previous`,
        `${SYNC_FILE_NAME}.enc.bak.previous`,
        `${SYNC_FILE_NAME}.previous`,
        `${SYNC_FILE_NAME}.enc.previous`,
        LEGACY_SYNC_FILE_NAME,
        `${LEGACY_SYNC_FILE_NAME}.enc`,
    ] as const;


    const resolveFileSyncEncryptionTarget = async (syncFileUri: string): Promise<FileSyncEncryptionTarget | null> => {
        if (!syncFileUri) return null;
        if (isSaf(syncFileUri)) {
            const prefixMatch = syncFileUri.match(/^(content:\/\/[^/]+)/);
            const treeMatch = syncFileUri.match(/\/tree\/([^/?#]+)/);
            if (!prefixMatch || !treeMatch) return null;


            const dirUri = `${prefixMatch[1]}/tree/${treeMatch[1]}/document/${treeMatch[1]}`;
            const attachmentsDirUri = await (await openSafDirectory(dirUri)).resolve(ATTACHMENTS_DIR_NAME, {
                createIfMissing: false,
            });
            return { dirUri, attachmentsDirUri };
        }

        const normalized = syncFileUri.replace(/\/+$/, '');
        const dirUri = /\.[A-Za-z0-9]{1,16}$/.test(getLeafName(normalized))
            ? normalized.replace(/\/[^/]+$/, '')
            : normalized;
        if (!dirUri) return null;
        const attachmentsDirUri = `${dirUri}/${ATTACHMENTS_DIR_NAME}`;
        const hasAttachments = (await openPathDirectory(dirUri)).entries.has(ATTACHMENTS_DIR_NAME);
        return { dirUri, attachmentsDirUri: hasAttachments ? attachmentsDirUri : null };
    };


    const resolveSyncArtifactSiblingUri = async (
        syncFileUri: string,
        leafName: string,
        options: { createIfMissing: boolean },
    ): Promise<string | null> => {
        const target = await resolveFileSyncEncryptionTarget(syncFileUri);
        if (!target) return null;
        const directory = await openDirectory(target.dirUri);
        return directory.resolve(leafName, {
            createIfMissing: options.createIfMissing,
            mimeType: leafName.endsWith('.json') ? 'application/json' : DEFAULT_ARTIFACT_MIME,
        });
    };

    const ATTACHMENT_PREFIX = `${ATTACHMENTS_DIR_NAME}/`;
    const DESKTOP_TRANSITION_STAGE_DIR_PREFIX = '.mindwtr-encryption-stage-';
    const DESKTOP_TRANSITION_QUARANTINE_DIR_PREFIX = '.mindwtr-encryption-quarantine-';
    const DESKTOP_RECOVERY_ENTRY_PREFIX = '.mindwtr-desktop-recovery-entry-';


    const TRANSITION_SCRATCH_MARKER = '.mindwtr-et-';
    const ATTACHMENT_INSTALLER_LOCK_NAME = '.mindwtr-attachment-installer.lock';


    const ATTACHMENT_INSTALLER_RECOVERY_ARTIFACT = /^\.mindwtr-install-[a-f0-9]{32}\.(?:journal|candidate|quarantine)$/;
    let transitionScratchCounter = 0;


    const transitionScratchName = (kind: 'stage' | 'quarantine' | 'backup' | 'probe'): string => {
        transitionScratchCounter += 1;
        const kindCode = kind === 'stage' ? 's' : kind === 'quarantine' ? 'q' : kind === 'probe' ? 'p' : 'b';
        const nonce = Math.random().toString(36).slice(2, 10);
        return `${TRANSITION_SCRATCH_MARKER}${kindCode}-${Date.now().toString(36)}-${transitionScratchCounter.toString(36)}-${nonce}`;
    };

    const isTransitionScratchName = (name: string): boolean => name.includes(TRANSITION_SCRATCH_MARKER);

    const isNameProbeName = (name: string): boolean => name.includes(`${TRANSITION_SCRATCH_MARKER}p-`);
    const isDesktopTransitionRecoveryDir = (name: string): boolean =>
        name.startsWith(DESKTOP_TRANSITION_STAGE_DIR_PREFIX)
        || name.startsWith(DESKTOP_TRANSITION_QUARANTINE_DIR_PREFIX);

    type ArtifactLocation = { directory: DirectoryHandle; leaf: string; mimeType: string };


    const createFileSyncEncryptionRemotePort = async (
        syncFileUri: string,
        testHooks: FileSyncTransitionTestHooks = {},
    ): Promise<FileSyncRemotePort | null> => {
        const openedAt = Date.now();
        let writes = 0;


        let stageListed = false;
        const target = await resolveFileSyncEncryptionTarget(syncFileUri);
        if (!target) return null;

        const documents = await openDirectory(target.dirUri);
        const attachments = target.attachmentsDirUri ? await openDirectory(target.attachmentsDirUri) : null;
        const desktopRecoveryLocations = new Map<string, ArtifactLocation>();


        let attachmentNamesUnique: Promise<boolean> | null = null;

        const leftoverNameProbes = new Map<string, string>();
        const probeAttachmentNames = async (): Promise<boolean> => {
            const dirUri = target.attachmentsDirUri;
            if (!dirUri || !isSaf(dirUri) || !host.saf) return false;
            const saf = host.saf;
            for (const [leftover, uri] of leftoverNameProbes) {

                if ((await saf.stat(uri).catch(() => null))?.size !== 0) continue;
                await deleteSyncArtifact(uri).catch(() => undefined);
                attachments?.entries.delete(leftover);
            }
            const name = transitionScratchName('probe');
            const created: string[] = [];
            let outcome: 'renamed' | 'kept-name' | 'handed-back' | 'failed' = 'failed';
            try {
                const first = await saf.createFile(dirUri, name, DEFAULT_ARTIFACT_MIME);
                if (first) created.push(first);
                if (first && (await saf.stat(first))?.name === name) {
                    const second = await saf.createFile(dirUri, name, DEFAULT_ARTIFACT_MIME);
                    if (second === first) {
                        outcome = 'handed-back';
                    } else if (second) {
                        created.push(second);
                        const secondName = (await saf.stat(second))?.name;
                        outcome = secondName === name ? 'kept-name' : secondName ? 'renamed' : 'failed';
                    }
                }
            } catch {
                outcome = 'failed';
            }
            let cleaned = true;
            for (const uri of created) await deleteSyncArtifact(uri).catch(() => { cleaned = false; });
            const unique = outcome === 'renamed';
            host.log.info('File Sync transition chose its name check', {
                scope: 'sync',
                extra: {
                    releaseCheck: 'v1.3.8/file-sync-name-probe',
                    mode: unique ? 'unique-names' : 'full-listing',
                    outcome,
                    cleaned: cleaned ? 'yes' : 'no',
                },
            });
            return unique;
        };

        const collectDesktopRecoveryDirectory = async (dirUri: string): Promise<void> => {
            const directory = await openDirectory(dirUri);
            for (const [leaf, uri] of directory.entries) {
                if (isDesktopTransitionRecoveryDir(leaf)) {
                    await collectDesktopRecoveryDirectory(uri);
                    continue;
                }
                const name = `${DESKTOP_RECOVERY_ENTRY_PREFIX}${desktopRecoveryLocations.size}`;
                desktopRecoveryLocations.set(name, {
                    directory,
                    leaf,
                    mimeType: leaf.endsWith('.json') ? 'application/json' : DEFAULT_ARTIFACT_MIME,
                });
            }
        };

        const locate = async (name: string): Promise<string | null> => {
            const recovery = desktopRecoveryLocations.get(name);
            if (recovery) return recovery.directory.resolve(recovery.leaf, { createIfMissing: false });
            if (name.startsWith(ATTACHMENT_PREFIX)) {


                return attachments ? attachments.resolve(name.slice(ATTACHMENT_PREFIX.length), { createIfMissing: false }) : null;
            }


            if (isSaf(target.dirUri)) return documents.entries.get(name) ?? null;
            return documents.resolve(name, { createIfMissing: false });
        };

        const locationFor = (name: string): ArtifactLocation | null => {
            const recovery = desktopRecoveryLocations.get(name);
            if (recovery) return recovery;
            if (name.startsWith(ATTACHMENT_PREFIX)) {
                if (!attachments) return null;
                return {
                    directory: attachments,
                    leaf: name.slice(ATTACHMENT_PREFIX.length),
                    mimeType: DEFAULT_ARTIFACT_MIME,
                };
            }
            return {
                directory: documents,
                leaf: name,
                mimeType: name.endsWith('.json') ? 'application/json' : DEFAULT_ARTIFACT_MIME,
            };
        };

        const versionFor = async (bytes: Uint8Array): Promise<string> => {
            const digest = await computeSha256Hex(bytes);
            if (!digest) throw new Error('sync encryption file transition requires SHA-256 support');
            return `sha256:${digest}:length=${bytes.length}`;
        };

        const read = async (name: string) => {
            const uri = await locate(name);
            if (!uri) return { bytes: null, version: null };
            const bytes = await readSyncArtifactBytes(uri);
            if (!bytes) throw new Error(`sync encryption: failed to read existing artifact ${name}`);
            return { bytes, version: await versionFor(bytes) };
        };

        const documentEntries = (): SyncEncryptionRemoteEntry[] => {
            const names = new Set<string>(FIXED_SYNC_DOCUMENT_NAMES);
            for (const name of documents.entries.keys()) {
                if (isSyncDocumentName(name)) names.add(name);
            }
            return Array.from(names)
                .sort((left, right) => left.localeCompare(right))
                .map((name) => ({ name, kind: 'document' }));
        };

        const nonDocumentEntries = async (): Promise<SyncEncryptionRemoteEntry[]> => {
            const entries: SyncEncryptionRemoteEntry[] = [];
            desktopRecoveryLocations.clear();
            for (const [name, uri] of documents.entries) {
                if (ATTACHMENT_INSTALLER_RECOVERY_ARTIFACT.test(name)) {
                    throw new SyncEncryptionRemoteConflictError(
                        'File Sync attachment publication recovery must finish before encryption transition',
                    );
                }
                if (isDesktopTransitionRecoveryDir(name)) {
                    await collectDesktopRecoveryDirectory(uri);
                } else if (isTransitionScratchName(name)) {
                    entries.push({ name, kind: 'attachment' });
                }
            }
            if (attachments) {
                await attachments.refresh();
                for (const [name, uri] of attachments.entries) {
                    if (name === ATTACHMENT_INSTALLER_LOCK_NAME) continue;
                    if (ATTACHMENT_INSTALLER_RECOVERY_ARTIFACT.test(name)) {
                        throw new SyncEncryptionRemoteConflictError(
                            'File Sync attachment publication recovery must finish before encryption transition',
                        );
                    }
                    if (isDesktopTransitionRecoveryDir(name)) {
                        await collectDesktopRecoveryDirectory(uri);
                        continue;
                    }


                    if (isNameProbeName(name)) {
                        leftoverNameProbes.set(name, uri);
                        continue;
                    }
                    entries.push({ name: `${ATTACHMENT_PREFIX}${name}`, kind: 'attachment' });
                }
            }
            for (const name of desktopRecoveryLocations.keys()) {
                entries.push({ name, kind: 'attachment' });
            }

            return entries.sort((left, right) => compareSyncTransitionEntryNames(left.name, right.name));
        };

        const readListedEntry = async (name: string): Promise<SyncEncryptionRemoteRead> => {
            const current = await read(name);
            if (!current.bytes || !current.version) {
                throw new SyncEncryptionRemoteConflictError(`${name} disappeared during sync encryption inventory`);
            }
            return current;
        };

        const captureInventory = async (): Promise<SyncEncryptionRemoteInventory> => {


            await documents.refresh();
            const initialDocuments = documentEntries();
            const snapshot = new Map<string, SyncEncryptionRemoteRead>();
            for (const entry of initialDocuments) {
                snapshot.set(entry.name, await read(entry.name));
            }
            await testHooks.onInventoryPoint?.('after-document-snapshot');

            const remaining = await nonDocumentEntries();
            for (const entry of remaining) {
                snapshot.set(entry.name, await readListedEntry(entry.name));
            }

            await documents.refresh();
            const confirmedDocuments = documentEntries();
            if (
                confirmedDocuments.length !== initialDocuments.length
                || confirmedDocuments.some((entry, index) => entry.name !== initialDocuments[index]?.name)
            ) {
                throw new SyncEncryptionRemoteConflictError('sync document inventory changed during encryption transition');
            }
            for (const entry of initialDocuments) {
                const current = await read(entry.name);
                if (current.version !== snapshot.get(entry.name)?.version) {
                    throw new SyncEncryptionRemoteConflictError(`${entry.name} changed during sync encryption inventory`);
                }
            }
            return { entries: [...initialDocuments, ...remaining], snapshot };
        };

        const restoreDisplacedGeneration = async (
            location: { directory: DirectoryHandle; leaf: string; mimeType: string },
            displaced: Uint8Array,
        ): Promise<void> => {


            try {
                const restoredUri = await location.directory.createNew(location.leaf, location.mimeType);
                await writeFreshArtifact(restoredUri, displaced);
                const canonical = await location.directory.listExact(location.leaf);
                const restored = await readSyncArtifactBytes(restoredUri);
                if (
                    canonical.length !== 1
                    || canonical[0] !== restoredUri
                    || !restored
                    || await versionFor(restored) !== await versionFor(displaced)
                ) {
                    return;
                }
            } catch (error) {
                if (error instanceof FileSyncPathOwnerTerminatedError) throw error;
            }
        };

        const rotateBackup = async (name: string, bytes: Uint8Array): Promise<void> => {
            const mimeType = name.endsWith('.json') ? 'application/json' : DEFAULT_ARTIFACT_MIME;
            const existing = await documents.listExact(name);
            if (existing.length > 1) throw new SyncEncryptionRemoteConflictError(`${name} is ambiguous`);
            let displacedUri: string | null = null;
            let displacedName: string | null = null;
            let displacedBytes: Uint8Array | undefined;
            if (existing.length === 1) {
                if (publication && !isSaf(existing[0])) {
                    const observed = await readSyncArtifactBytes(existing[0]);
                    if (observed === null) throw new SyncEncryptionRemoteConflictError(`${name} disappeared before backup rotation`);
                    displacedBytes = observed;
                }
                displacedName = transitionScratchName('quarantine');
                displacedUri = await documents.rename(existing[0], displacedName, displacedBytes);
            }


            const installedUri = await documents.createNew(name, mimeType, { repairDecoratedName: false });
            await writeFreshArtifact(installedUri, bytes);
            const installed = await documents.listExact(name);
            const written = await readSyncArtifactBytes(installedUri);
            if (
                installed.length !== 1
                || installed[0] !== installedUri
                || !written
                || await versionFor(written) !== await versionFor(bytes)
            ) {
                throw new SyncEncryptionRemoteConflictError(`${name} could not be verified after backup rotation`);
            }
            if (displacedUri && displacedName) {
                await deleteSyncArtifact(displacedUri, displacedBytes);
                documents.entries.delete(displacedName);
            }
        };

        return {
            rotateBackup,

            list: async (): Promise<SyncEncryptionRemoteEntry[]> => {
                await documents.refresh();
                const listed = [...documentEntries(), ...await nonDocumentEntries()];


                if (writes > 0) {
                    host.log.info('File Sync transition final check listed names only', {
                        scope: 'sync',
                        extra: { releaseCheck: 'v1.3.8/file-sync-transition-cost', entries: listed.length, writes, elapsedMs: Date.now() - openedAt },
                    });
                }
                return listed;
            },
            captureInventory,
            read,
            write: async (name, bytes, expectedVersion) => {
                const location = locationFor(name);
                let currentBytes: Uint8Array | undefined;
                if (expectedVersion === null) {
                    if (location && (await location.directory.listExact(location.leaf)).length > 0) {
                        throw new SyncEncryptionRemoteConflictError(`${name} changed during sync encryption transition`);
                    }
                } else {
                    const current = await read(name);
                    if (current.version !== expectedVersion) {
                        throw new SyncEncryptionRemoteConflictError(`${name} changed during sync encryption transition`);
                    }
                    currentBytes = current.bytes ?? undefined;
                }
                if (!location) throw new Error(`sync encryption: cannot create ${name} in the sync folder`);
                const stageName = transitionScratchName('stage');
                const stageUri = await location.directory.createNew(stageName, location.mimeType, { skipClosingListing: stageListed });
                stageListed = true;
                await writeFreshArtifact(stageUri, bytes);
                const stagedBytes = await readSyncArtifactBytes(stageUri);
                if (!stagedBytes || await versionFor(stagedBytes) !== await versionFor(bytes)) {
                    throw new SyncEncryptionRemoteConflictError(`${name} could not be verified after transition staging`);
                }

                let quarantineUri: string | null = null;
                let quarantineName: string | null = null;
                const uniqueNames = location.directory === attachments && await (attachmentNamesUnique ??= probeAttachmentNames());
                if (expectedVersion !== null) {
                    await testHooks.onMutationPoint?.('before-quarantine', name);
                    let currentUri: string;
                    if (uniqueNames) {


                        const listed = location.directory.entries.get(location.leaf);
                        if (!listed || (await saf().stat(listed))?.name !== location.leaf) {
                            throw new SyncEncryptionRemoteConflictError(`${name} changed during sync encryption transition`);
                        }
                        currentUri = listed;
                    } else {
                        const exact = await location.directory.listExact(location.leaf);
                        if (exact.length !== 1) {
                            throw new SyncEncryptionRemoteConflictError(`${name} changed during sync encryption transition`);
                        }
                        currentUri = exact[0];
                    }
                    quarantineName = transitionScratchName('quarantine');
                    quarantineUri = await location.directory.rename(currentUri, quarantineName, currentBytes);
                    const displaced = await readSyncArtifactBytes(quarantineUri);
                    if (!displaced || await versionFor(displaced) !== expectedVersion) {
                        if (displaced) await restoreDisplacedGeneration(location, displaced);
                        throw new SyncEncryptionRemoteConflictError(`${name} changed during sync encryption transition`);
                    }
                }

                await testHooks.onMutationPoint?.('before-install', name);
                const installedUri = await location.directory.createNew(location.leaf, location.mimeType, { skipClosingListing: uniqueNames });
                await writeFreshArtifact(installedUri, stagedBytes);
                if (location.directory !== attachments) {
                    const canonical = await location.directory.listExact(location.leaf);
                    if (canonical.length !== 1 || canonical[0] !== installedUri) {
                        throw new SyncEncryptionRemoteConflictError(`${name} was created by another writer`);
                    }
                }
                const written = await readSyncArtifactBytes(installedUri);
                const writtenVersion = written ? await versionFor(written) : null;
                if (!written || writtenVersion !== await versionFor(bytes)) {
                    throw new SyncEncryptionRemoteConflictError(`${name} could not be verified after transition write`);
                }
                let quarantineBytes: Uint8Array | undefined;
                if (quarantineUri) {
                    const retained = await readSyncArtifactBytes(quarantineUri);
                    if (!retained || await versionFor(retained) !== expectedVersion) {
                        throw new SyncEncryptionRemoteConflictError(`${name} quarantine changed during sync encryption transition`);
                    }
                    quarantineBytes = retained;
                }
                await deleteSyncArtifact(stageUri, stagedBytes);
                location.directory.entries.delete(stageName);
                if (quarantineUri && quarantineName) {
                    await deleteSyncArtifact(quarantineUri, quarantineBytes);
                    location.directory.entries.delete(quarantineName);
                }
                writes += 1;

                return { bytes: written, version: writtenVersion };
            },
            remove: async (name, expectedVersion) => {
                const current = await read(name);
                if (current.version !== expectedVersion) {
                    throw new SyncEncryptionRemoteConflictError(`${name} changed during sync encryption transition`);
                }
                const location = locationFor(name);
                if (!location) throw new SyncEncryptionRemoteConflictError(`${name} disappeared during sync encryption transition`);
                await testHooks.onMutationPoint?.('before-quarantine', name);
                const exact = await location.directory.listExact(location.leaf);
                if (exact.length !== 1) throw new SyncEncryptionRemoteConflictError(`${name} changed during sync encryption transition`);
                const quarantineName = transitionScratchName('quarantine');
                const quarantineUri = await location.directory.rename(exact[0], quarantineName, current.bytes ?? undefined);
                const displaced = await readSyncArtifactBytes(quarantineUri);
                if (!displaced || await versionFor(displaced) !== expectedVersion) {
                    if (displaced) await restoreDisplacedGeneration(location, displaced);
                    throw new SyncEncryptionRemoteConflictError(`${name} changed during sync encryption transition`);
                }
                await testHooks.onMutationPoint?.('before-remove-commit', name);
                if ((await location.directory.listExact(location.leaf)).length !== 0) {
                    throw new SyncEncryptionRemoteConflictError(`${name} was recreated by another writer`);
                }
                const retained = await readSyncArtifactBytes(quarantineUri);
                if (!retained || await versionFor(retained) !== expectedVersion) {
                    throw new SyncEncryptionRemoteConflictError(`${name} quarantine changed during sync encryption transition`);
                }
                await deleteSyncArtifact(quarantineUri, retained);
                location.directory.entries.delete(quarantineName);
                location.directory.entries.delete(location.leaf);
            },
        };
    };

    return {
        isUnverifiedLengthRead,
        readSyncArtifactBytes,
        padBytesForNonTruncatingOverwrite,
        writeSyncArtifactBytes,
        deleteSyncArtifact,
        listBlockingRetainedGenerations,
        resolveFileSyncEncryptionTarget,
        resolveSyncArtifactSiblingUri,
        createFileSyncEncryptionRemotePort,
        testUtils: { getLeafName, isSeedBackupDocumentName, isSyncDocumentName },
    };
};

export type MobileFileSyncRemote = ReturnType<typeof createMobileFileSyncRemote>;
