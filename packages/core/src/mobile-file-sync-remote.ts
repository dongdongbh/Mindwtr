// File Sync (SAF on Android, plain paths on iOS) byte IO for sync artifacts, plus the
// `SyncEncryptionRemotePort` adapter that lets this backend reuse core's transition
// orchestration (#1056 phase 2). Moved from React Native's lib/storage-file-encryption.ts
// (S5) unchanged in behavior: every expo-file-system and native-module call is now a call on
// the host's port, in the same order (apps/mobile/lib/file-sync-parity.test.ts replays it).
//
// Judgment call — deviation from the sub-task handoff, deliberate: the handoff said
// mobile's File Sync backend should get "its own small transition implementation" rather
// than going through core's generic `SyncEncryptionRemotePort` orchestration, because
// desktop's File Sync lives in Rust and must duplicate that logic. Mobile's does not:
// it is TypeScript and can call the same functions WebDAV and Dropbox call. Duplicating
// ~200 lines of ordering / verify-before-delete / resume-by-inspecting-current-bytes
// logic over SAF would be a second place for that data-loss-sensitive logic to drift,
// which is exactly what ADR 0014 and pinned decision #12 are trying to prevent. So this
// file supplies the four IO primitives (list/read/write/remove) and core supplies the
// transition semantics unchanged.
//
// Everything here is byte-level. The MWENC1 container is binary, so text reads would
// mangle it.

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

/** A File Sync log line's error: the error's leading code (`SAF_DOCUMENT_UNAVAILABLE`, `SYNC_FILE_LOCK_BUSY`) or its plain
 *  name, never its text. Provider and file-system messages quote the document's URI or path, which names the user's files. */
export const fileSyncErrorCode = (error: unknown): string => {
    const message = error instanceof Error ? error.message : String(error);
    const code = /^([A-Z][A-Z0-9_]{2,}):/.exec(message)?.[1];
    if (code) return code;
    if (!(error instanceof Error)) return typeof error;
    return /^[A-Za-z][A-Za-z0-9_]*$/.test(error.name) ? error.name : 'Error';
};

/** One SAF document as its provider describes it: its tree document URI and display name. */
export type MobileFileSyncSafEntry = {
    uri: string;
    name: string | null;
    mime?: string | null;
    size: number | null;
    lastModified?: number | null;
};

/**
 * Android Storage Access Framework folders (`content://` trees): SafDocumentsCore.kt's calls,
 * and on React Native expo's SAF create, delete and write. Provider failures reject; nothing
 * here answers "empty" or "absent" for a failure.
 */
export type MobileFileSyncSafPort = {
    /** A folder's documents; empty only when the provider listed an empty folder. */
    listChildren(dirUri: string): Promise<MobileFileSyncSafEntry[]>;
    /** A document's row, or null when the provider's query answered no such document. */
    stat(uri: string): Promise<MobileFileSyncSafEntry | null>;
    /** A whole document; `lengthVerified` false when no reported length proved it whole. */
    readBytes(uri: string): Promise<{ bytes: Uint8Array; lengthVerified: boolean }>;
    /** Writes these exact bytes into a document (File Sync writes only into documents it created). */
    writeBytes(uri: string, bytes: Uint8Array): Promise<void>;
    /** Writes UTF-8 text into a document (the pick-time write probe). */
    writeText(uri: string, text: string): Promise<void>;
    /** Creates a document and answers its URI; a provider may decorate the name. */
    createFile(dirUri: string, name: string, mimeType: string): Promise<string>;
    /** Deletes a document; one already gone is no error. */
    delete(uri: string): Promise<void>;
    /** Creates a subfolder and answers its URI (the attachment pass's `attachments` folder); absent where File Sync never makes one. */
    makeDirectory?(parentUri: string, name: string): Promise<string>;
    /** Renames a document (only where the provider supports it) and answers the new URI and the name it reports. */
    rename(uri: string, displayName: string): Promise<{ uri: string; name: string }>;
};

/** Plain `file://` folders (iOS; React Native's expo-file-system ladders). */
export type MobileFileSyncPathPort = {
    exists(uri: string): boolean;
    info(uri: string): Promise<{ exists?: boolean; size?: number }>;
    /** The file's names in a folder. */
    list(dirUri: string): Promise<string[]>;
    /** The file's bytes, or null when it does not exist. */
    readBytes(uri: string): Promise<Uint8Array | null>;
    /** The file's text, or null when it does not exist. */
    readText(uri: string): Promise<string | null>;
    /** Creates or replaces the file with these bytes. */
    writeBytes(uri: string, bytes: Uint8Array): Promise<void>;
    /** Creates the file only if it does not exist: 'exists' when another writer made it first. */
    createExclusive(uri: string): Promise<'created' | 'exists'>;
    /** Writes into the file createExclusive just made. */
    writeCreated(uri: string, bytes: Uint8Array): void;
    delete(uri: string): Promise<void>;
    /** Renames the file within its folder and answers its new URI; throws when the name is taken. */
    rename(uri: string, name: string): string;
};

export type MobileFileSyncLog = {
    info(message: string, context?: { scope?: string; extra?: Record<string, unknown> }): void;
    warn(message: string, context?: { scope?: string; extra?: Record<string, unknown> }): void;
    error(error: unknown, context?: { scope?: string; extra?: Record<string, unknown> }): void;
};

/** The remote half of the File Sync host (see mobile-file-sync.ts for the whole host). */
export type MobileFileSyncHost = {
    /** Null where the platform has no Storage Access Framework (iOS). */
    saf: MobileFileSyncSafPort | null;
    path: MobileFileSyncPathPort;
    log: MobileFileSyncLog;
};

export type FileSyncEncryptionTarget = {
    /** The directory holding data.json — SAF tree/document URI or a `file://` dir. */
    dirUri: string;
    /** The attachments subdirectory URI, or null when the folder has none yet. */
    attachmentsDirUri: string | null;
};

export type FileSyncTransitionMutationPoint = 'before-quarantine' | 'before-install' | 'before-remove-commit';

export type FileSyncTransitionInventoryPoint = 'after-document-snapshot';

export type FileSyncTransitionTestHooks = {
    onMutationPoint?: (point: FileSyncTransitionMutationPoint, name: string) => void | Promise<void>;
    onInventoryPoint?: (point: FileSyncTransitionInventoryPoint) => void | Promise<void>;
};

export type FileSyncRemotePort = SyncEncryptionRemotePort & {
    /**
     * Replaces backup document `name` with `bytes` without ever writing into an existing file:
     * the old backup is renamed aside, a new document is created exclusively under the backup's
     * name and written, its identity and bytes are verified, and only then is the old backup
     * deleted. A failure leaves the old backup in place (by name or as the renamed copy) and throws.
     */
    rotateBackup(name: string, bytes: Uint8Array): Promise<void>;
};

/** File Sync's folder IO and transition port over the host's SAF and path ports (React Native:
 *  expo-file-system and SafDocumentsCore; native Android: SafDocumentsCore). */
export const createMobileFileSyncRemote = (host: MobileFileSyncHost) => {
    const saf = (): MobileFileSyncSafPort => {
        if (!host.saf) throw new Error('This Android build does not support Storage Access Framework (SAF).');
        return host.saf;
    };
    /** The transition rename: the provider must report exactly the name asked for. */
    const renameSafDocument = async (uri: string, displayName: string): Promise<{ uri: string; name: string }> => {
        const result = await saf().rename(uri, displayName);
        if (!result || typeof result.uri !== 'string' || typeof result.name !== 'string' || result.name !== displayName) {
            throw new Error(`${SYNC_FILE_TRANSITION_CAS_UNAVAILABLE}: the document provider changed the requested transition name`);
        }
        return result;
    };

    const DEFAULT_ARTIFACT_MIME = 'application/octet-stream';
    /** ASCII space. The MWENC1 reader ignores bytes past `54 + ciphertext_len`, which is what
     *  makes padding a shrinking write harmless — see sync-crypto.ts's header comment. */
    const PAD_BYTE = 0x20;

    const isSaf = (uri: string): boolean => uri.startsWith('content://');

    const getLeafName = (uri: string): string => {
        const stripped = decodeURIComponent(uri.split('?')[0]?.split('#')[0] ?? uri).replace(/\/+$/, '');
        const lastSeparator = Math.max(stripped.lastIndexOf('/'), stripped.lastIndexOf(':'));
        return lastSeparator >= 0 ? stripped.slice(lastSeparator + 1) : stripped;
    };

    /** Bytes a SAF read returned without a provider-reported length to prove them whole. They may
     *  be used, but a document that fails to parse from them is never repaired (dd, 10-18). */
    const unverifiedLengthReads = new WeakSet<Uint8Array>();
    const isUnverifiedLengthRead = (bytes: Uint8Array): boolean => unverifiedLengthReads.has(bytes);

    /** Reads a sync artifact as raw bytes, or `null` when it does not exist. Never throws for
     *  a missing file — callers distinguish "absent" from "unreadable" and an absent `.enc`
     *  sibling is the normal case on every plaintext folder. */
    const readSyncArtifactBytes = async (uri: string): Promise<Uint8Array | null> => {
        if (isSaf(uri)) {
            try {
                const read = await saf().readBytes(uri);
                if (!read.lengthVerified) unverifiedLengthReads.add(read.bytes);
                return read.bytes;
            } catch (error) {
                // A failed SAF read is absence only when the provider says the document is gone
                // (SafDocumentsCore.stat). Any other failure, including one the lookup itself
                // hits, propagates: an unreadable generation is never "missing".
                if (!(await saf().stat(uri))) return null;
                throw error;
            }
        }
        return host.path.readBytes(uri);
    };

    /**
     * Pad `bytes` with 0x20 up to `previousLength` — the byte-domain version of
     * `padForNonTruncatingOverwrite`. Padding is applied to the RAW bytes, before any Base64
     * encoding, because it is the on-disk file that a non-truncating provider fails to
     * shorten; padding the Base64 text would land inside the encoded stream and decode to
     * garbage of the wrong length.
     *
     * ONLY safe for MWENC1 containers: their `ciphertext_len` header field makes trailing
     * bytes explicitly ignorable to EVERY future reader, forever. Plaintext has no such
     * self-describing length, so a padded plaintext file is a PERMANENT corruption nothing
     * downstream would know to strip — see `writeSyncArtifactBytes`'s plaintext branch for
     * how a shrinking plaintext write is handled instead.
     */
    const padBytesForNonTruncatingOverwrite = (bytes: Uint8Array, previousLength: number): Uint8Array => {
        if (previousLength <= bytes.length) return bytes;
        const padded = new Uint8Array(previousLength);
        padded.set(bytes, 0);
        padded.fill(PAD_BYTE, bytes.length);
        return padded;
    };

    /** The host's write of the exact bytes to land on disk (its own write ladder). Shared by both
     *  writeSyncArtifactBytes branches below. */
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
            if (await host.path.createExclusive(uri) === 'exists') {
                throw new SyncEncryptionRemoteConflictError(`${uri} was created by another writer`);
            }
            host.path.writeCreated(uri, bytes);
            return;
        }
        const isSealed = inspectSyncArtifact(bytes).kind === 'encrypted';
        if (isSealed) {
            // Ciphertext: pad up to the previous length instead of shrinking. Safe forever —
            // every future reader ignores bytes past the header's ciphertext_len.
            const previous = await readSyncArtifactBytes(uri).catch(() => null);
            const payload = padBytesForNonTruncatingOverwrite(bytes, previous?.length ?? 0);
            return writeArtifactPayload(uri, payload);
        }

        // Plaintext (the disable transition's only caller). Padding would be a SILENT,
        // PERMANENT corruption here (S2) — nothing downstream (a user opening the file,
        // validateAttachmentHash, a future sync cycle reading an untouched document) would
        // ever know to strip a trailing 0x20 run from a plain attachment or JSON document
        // again. Delete-then-recreate instead when the new content is shorter than what's
        // there: a non-truncating provider's limitation is specifically about shrinking an
        // EXISTING file via overwrite, not about writing a brand-new one, so this reliably
        // produces a file of the exact correct length regardless of provider.
        //
        // ponytail: SAF (Android tree URIs) can't do this safely with the current API surface
        // — `createFileAsync` after a delete may allocate a NEW document (SAF has no rename),
        // and this function's `uri`-in-`uri`-out signature has no way to hand a changed URI
        // back to the name->URI cache in createFileSyncEncryptionRemotePort's DirectoryHandle.
        // SAF plaintext shrinks still rely on core's disable-transition verify
        // (`bytesMatchWithTrailingPadding`) failing closed rather than silently accepting a
        // corrupted tail — a real residual gap, not a fix. Non-SAF (iOS, Android non-tree
        // paths) — the common case — is fully correct: exact bytes, no padding, ever.
        if (!isSaf(uri)) {
            const previous = await readSyncArtifactBytes(uri).catch(() => null);
            if (previous && previous.length > bytes.length) {
                await deleteSyncArtifact(uri).catch(() => undefined);
            }
        }
        return writeArtifactPayload(uri, bytes);
    };

    const deleteSyncArtifact = async (uri: string): Promise<void> => {
        if (isSaf(uri)) {
            if (!host.saf) return;
            await host.saf.delete(uri);
            return;
        }
        await host.path.delete(uri);
    };

    type DirectoryHandle = {
        /** leaf name -> uri, for entries that already exist. */
        entries: Map<string, string>;
        /** Re-enumerates the provider and replaces `entries`; listing failures are terminal. */
        refresh(): Promise<void>;
        resolve(name: string, options: { createIfMissing: boolean; mimeType?: string }): Promise<string | null>;
        listExact(name: string): Promise<string[]>;
        /** `repairDecoratedName: false` refuses a provider-decorated create instead of renaming it
         *  onto `name` (a rename that may replace a document a peer just published there). `skipClosingListing`
         *  skips the closing listing that proves no peer holds `name` too, where something else proves it: a
         *  transition scratch name is random, and a provider proved to rename a taken name cannot hold it twice.
         *  The provider's own report of the created name still has to match. */
        createNew(name: string, mimeType?: string, options?: { repairDecoratedName?: boolean; skipClosingListing?: boolean }): Promise<string>;
        rename(uri: string, name: string): Promise<string>;
    };

    const openSafDirectory = async (dirUri: string): Promise<DirectoryHandle> => {
        const entries = new Map<string, string>();
        // Names come from the provider's display name: document IDs are opaque, and only a
        // path-like provider puts the file name in the URI's tail.
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
                // Android DocumentsProviders may append an extension derived from the MIME
                // type when the requested name's extension doesn't match it. `.enc` artifacts
                // therefore ask for application/octet-stream (no canonical extension, so
                // nothing is appended) — but providers vary, and a silently renamed artifact
                // is invisible to every other device, so say so loudly rather than never.
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
                    // The caller cannot publish by rename: delete only what this call created.
                    await deleteSyncArtifact(created).catch(() => undefined);
                    host.log.warn('SAF provider renamed a new document on create; not published', {
                        scope: 'sync',
                        extra: { requested: name, created: createdName },
                    });
                    throw new SyncEncryptionRemoteConflictError(`${name} could not be created under its own name`);
                }
                if (created && createdName !== name) {
                    // Some providers decorate the display name on create (an extension derived
                    // from the MIME type, most often ".bin" for application/octet-stream), which
                    // used to read as "another writer" and fail every File Sync write (#1113).
                    // Repair with the exact-rename CAS; the listExact guard below still catches
                    // a real racing peer. A provider that dedupes names on create may have done so
                    // because a peer holds the name: never rename onto a name already taken (some
                    // providers' rename replaces its target).
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
            for (const name of await host.path.list(normalized)) {
                next.set(name, `${normalized}${name}`);
            }
            entries.clear();
            for (const [name, uri] of next) entries.set(name, uri);
        };
        await refresh();
        const listExact = async (name: string): Promise<string[]> => {
            const candidate = `${normalized}${name}`;
            const info = await host.path.info(candidate).catch(() => ({ exists: false }));
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
                    const info = await host.path.info(candidate).catch(() => ({ exists: false }));
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
                if (await host.path.createExclusive(uri) === 'exists') {
                    throw new SyncEncryptionRemoteConflictError(`${name} was created by another writer`);
                }
                entries.set(name, uri);
                return uri;
            },
            rename: async (uri, name) => {
                const previousName = getLeafName(uri);
                let renamedUri: string;
                try {
                    renamedUri = host.path.rename(uri, name);
                } catch (error) {
                    if ((await listExact(name)).length > 0) {
                        throw new SyncEncryptionRemoteConflictError(`${name} was created by another writer`);
                    }
                    throw error;
                }
                entries.delete(previousName);
                entries.set(name, renamedUri);
                return renamedUri;
            },
        };
    };

    const openDirectory = (dirUri: string): Promise<DirectoryHandle> =>
        isSaf(dirUri) ? openSafDirectory(dirUri) : openPathDirectory(dirUri);

    /** Native File Sync recovery also retains dated seed backups at the sync root. They are
     *  authoritative document generations, not attachments: transitions rename them between the
     *  `.json` and `.json.enc` names just like Rust does. Match Rust's case-insensitive contract
     *  while preserving the provider's exact leaf for IO. */
    const isSeedBackupDocumentName = (name: string): boolean => {
        const lower = name.toLowerCase();
        return (lower.startsWith('mindwtr-backup-') || lower.startsWith('data-backup-'))
            && (lower.endsWith('.json') || lower.endsWith('.json.enc'));
    };

    /** Document artifacts a mobile File Sync folder can hold. Mobile writes `data.json` and
     *  `data.json.bak`; the legacy name, native seed backups, and desktop's `.enc` counterparts
     *  are included so a transition migrates (and a disable restores) everything a mixed
     *  desktop/mobile folder actually contains. */
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

    /** A copy an interrupted write, a backup rotation or a peer's tool can leave beside the sync
     *  file: transition scratch (quarantine, stage), `.bak`, `.previous`, `.tmp`. Dated seed backups
     *  are whole exports, not interrupted writes, so they are not counted. */
    const isRetainedGenerationName = (name: string): boolean => {
        if (isTransitionScratchName(name)) return true;
        if (CANONICAL_SYNC_DOCUMENT_NAMES.has(name) || isSeedBackupDocumentName(name)) return false;
        // Any chain of managed suffixes on a sync document name: `data.json.bak`,
        // `data.json.enc.bak.previous`, `data.json.previous.tmp`, ...
        let base = name;
        let stripped = false;
        for (let match = RETAINED_SUFFIX.exec(base); match; match = RETAINED_SUFFIX.exec(base)) {
            base = base.slice(0, -match[0].length);
            stripped = true;
        }
        return stripped && (base === SYNC_FILE_NAME || base === LEGACY_SYNC_FILE_NAME);
    };
    const RETAINED_SUFFIX = /\.(?:enc|bak|tmp|previous)$/;

    /**
     * The retained generations in the sync folder that are not provably empty (an unknown size
     * counts as not empty). B5's guard: while one exists, a missing or broken sync file is never
     * repaired from local data, because that copy may hold rows nothing else has. Nothing is read,
     * moved or deleted here; recovering such a copy is a later pass.
     */
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
        for (const name of await host.path.list(normalized)) {
            if (!isRetainedGenerationName(name)) continue;
            const info = await host.path.info(`${normalized}${name}`);
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


    /**
     * Resolves the sync folder (and its attachments subfolder) from the configured sync-file
     * URI. Unlike `resolveFileSyncDir` in attachment-sync-utils this never CREATES the
     * attachments directory — a transition must not conjure folders into a user's sync
     * target as a side effect of listing it.
     */
    const resolveFileSyncEncryptionTarget = async (syncFileUri: string): Promise<FileSyncEncryptionTarget | null> => {
        if (!syncFileUri) return null;
        if (isSaf(syncFileUri)) {
            const prefixMatch = syncFileUri.match(/^(content:\/\/[^/]+)/);
            const treeMatch = syncFileUri.match(/\/tree\/([^/?#]+)/);
            if (!prefixMatch || !treeMatch) return null;
            // The sync folder is the picked tree's root document (as the folder lock takes it):
            // document IDs are opaque, so a parent is never cut out of a child's ID.
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

    /**
     * Resolves a sibling artifact of the configured sync file by leaf name (e.g.
     * `data.json.enc`), optionally creating it. Only ever called when encryption is on, or
     * on the one-shot discovery probe — the plaintext steady state never lists a directory
     * it did not already list (backward-compat invariant #1).
     */
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
    // Keep provider-facing scratch names bounded. Attachment names can be arbitrarily long,
    // and prefixing the canonical leaf made otherwise-valid transitions exceed SAF/provider
    // display-name limits. The timestamp/counter/random tuple remains collision-resistant
    // without inheriting user-controlled leaf length.
    const TRANSITION_SCRATCH_MARKER = '.mindwtr-et-';
    const ATTACHMENT_INSTALLER_LOCK_NAME = '.mindwtr-attachment-installer.lock';
    // Android and iOS derive this 32-hex identifier from the first half of the
    // SHA-256 of the native install target path. Keep this shape aligned with both
    // native AttachmentFileInstaller implementations: a retained artifact must
    // stop an encryption transition before any shared-folder mutation.
    const ATTACHMENT_INSTALLER_RECOVERY_ARTIFACT = /^\.mindwtr-install-[a-f0-9]{32}\.(?:journal|candidate|quarantine)$/;
    let transitionScratchCounter = 0;


    const transitionScratchName = (kind: 'stage' | 'quarantine' | 'backup' | 'probe'): string => {
        transitionScratchCounter += 1;
        const kindCode = kind === 'stage' ? 's' : kind === 'quarantine' ? 'q' : kind === 'probe' ? 'p' : 'b';
        const nonce = Math.random().toString(36).slice(2, 10);
        return `${TRANSITION_SCRATCH_MARKER}${kindCode}-${Date.now().toString(36)}-${transitionScratchCounter.toString(36)}-${nonce}`;
    };

    const isTransitionScratchName = (name: string): boolean => name.includes(TRANSITION_SCRATCH_MARKER);
    const isDesktopTransitionRecoveryDir = (name: string): boolean =>
        name.startsWith(DESKTOP_TRANSITION_STAGE_DIR_PREFIX)
        || name.startsWith(DESKTOP_TRANSITION_QUARANTINE_DIR_PREFIX);

    type ArtifactLocation = { directory: DirectoryHandle; leaf: string; mimeType: string };

    /**
     * Adapts a File Sync folder to core's generic transition port. Entry names are relative
     * to the sync root: `data.json`, `data.json.enc.bak`, `attachments/<id>.png`.
     *
     * Transition mutations refresh the exact target name, then atomically rename the
     * displaced generation into a same-directory quarantine before inspecting it. A racing
     * peer therefore causes a conflict without being overwritten or deleted; staged and
     * quarantined generations remain available for retry/recovery.
     */
    /** The transition port, plus the ordinary write's backup rotation over the same folder handle. */

    const createFileSyncEncryptionRemotePort = async (
        syncFileUri: string,
        testHooks: FileSyncTransitionTestHooks = {},
    ): Promise<FileSyncRemotePort | null> => {
        const openedAt = Date.now();
        let writes = 0;
        // The first stage this port creates is listed once, to prove the provider lists a new document at all, before any
        // original is moved aside; later stages skip that listing (their names are random).
        let stageListed = false;
        const target = await resolveFileSyncEncryptionTarget(syncFileUri);
        if (!target) return null;

        const documents = await openDirectory(target.dirUri);
        const attachments = target.attachmentsDirUri ? await openDirectory(target.attachmentsDirUri) : null;
        const desktopRecoveryLocations = new Map<string, ArtifactLocation>();

        /**
         * Whether attachments/ is proved to hold at most one document per name, asked once per port: two empty documents
         * created under one random name, then deleted. Only a provider that renames the second one ("x (1)", as Android's
         * external storage does) is proved; then an attachment's exact-name checks are a stat of its listed document and the
         * provider's report of the created name, with no folder listing. A provider that keeps the name twice (Google Drive)
         * or hands back the first document, or any failure, keeps both full listings per attachment.
         */
        let attachmentNamesUnique: Promise<boolean> | null = null;
        const probeAttachmentNames = async (): Promise<boolean> => {
            const dirUri = target.attachmentsDirUri;
            if (!dirUri || !isSaf(dirUri) || !host.saf) return false;
            const saf = host.saf;
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
            for (const uri of created) await deleteSyncArtifact(uri).catch(() => undefined);
            const unique = outcome === 'renamed';
            host.log.info('File Sync transition chose its name check', {
                scope: 'sync',
                extra: { releaseCheck: 'v1.3.8/file-sync-name-probe', mode: unique ? 'unique-names' : 'full-listing', outcome },
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
                // Attachments are rewritten in place under their existing names (cloudKey is
                // identity-keyed and immutable), so a missing one is never created here.
                return attachments ? attachments.resolve(name.slice(ATTACHMENT_PREFIX.length), { createIfMissing: false }) : null;
            }
            // On SAF the sync root's last listing answers, with no listing per name (most of FIXED_SYNC_DOCUMENT_NAMES are
            // absent in every folder). Every inventory and the final check list the root first, and this port's own creates,
            // renames and deletes keep it current; a peer's create since then is caught by a fresh listing where it matters:
            // a create-only write lists the name before staging. A path folder looks a name up for free.
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
                    entries.push({ name: `${ATTACHMENT_PREFIX}${name}`, kind: 'attachment' });
                }
            }
            for (const name of desktopRecoveryLocations.keys()) {
                entries.push({ name, kind: 'attachment' });
            }
            // The order the transition seals in: assertFolderHoldsNoCiphertext relies on it (compareSyncTransitionEntryNames).
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
            // Read/fingerprint the document generation first, then enumerate attachments. A peer
            // generation that arrives before this read has its attachment included by the fresh
            // listing below; one that arrives after it changes the final document fingerprint and
            // aborts before core can mutate anything.
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
            // Never rename quarantine back onto the canonical name: providers may replace a
            // peer that appeared after displacement. Exclusive create-and-copy restores the
            // exact generation when the name is still free; any collision/failure leaves the
            // authoritative bytes in quarantine for recovery.
            try {
                const restoredUri = await location.directory.createNew(location.leaf, location.mimeType);
                await writeArtifactPayload(restoredUri, displaced);
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
            } catch {
                // The transition returns a conflict below. Suppressing restoration errors is
                // intentional: deleting or replacing either generation would be less safe.
            }
        };

        const rotateBackup = async (name: string, bytes: Uint8Array): Promise<void> => {
            const mimeType = name.endsWith('.json') ? 'application/json' : DEFAULT_ARTIFACT_MIME;
            const existing = await documents.listExact(name);
            if (existing.length > 1) throw new SyncEncryptionRemoteConflictError(`${name} is ambiguous`);
            let displacedUri: string | null = null;
            let displacedName: string | null = null;
            if (existing.length === 1) {
                displacedName = transitionScratchName('quarantine');
                displacedUri = await documents.rename(existing[0], displacedName);
            }
            // Exclusive install: a new document under the backup's name, never a rename onto it (a
            // provider's rename may replace a backup a peer published meanwhile). createNew fails
            // closed when that name is taken; the old backup then stays in its quarantine.
            const installedUri = await documents.createNew(name, mimeType, { repairDecoratedName: false });
            await writeArtifactPayload(installedUri, bytes);
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
                await deleteSyncArtifact(displacedUri);
                documents.entries.delete(displacedName);
            }
        };

        return {
            rotateBackup,
            // Names only: core's final check reads every listed entry itself, so the inventory's reads would be a second copy.
            list: async (): Promise<SyncEncryptionRemoteEntry[]> => {
                await documents.refresh();
                const listed = [...documentEntries(), ...await nonDocumentEntries()];
                // A port that wrote is a transition's, and its list call is that transition's final check ("Check this
                // location again" lists too, and writes nothing): the time since the port opened is the transition's.
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
                if (expectedVersion === null) {
                    // Create-only: the cached root listing may be minutes old, and some providers hand back an existing
                    // document for a taken name, so the name must be absent from a fresh listing before anything is staged.
                    if (location && (await location.directory.listExact(location.leaf)).length > 0) {
                        throw new SyncEncryptionRemoteConflictError(`${name} changed during sync encryption transition`);
                    }
                } else if ((await read(name)).version !== expectedVersion) {
                    throw new SyncEncryptionRemoteConflictError(`${name} changed during sync encryption transition`);
                }
                if (!location) throw new Error(`sync encryption: cannot create ${name} in the sync folder`);
                const stageName = transitionScratchName('stage');
                const stageUri = await location.directory.createNew(stageName, location.mimeType, { skipClosingListing: stageListed });
                stageListed = true;
                await writeArtifactPayload(stageUri, bytes);
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
                        // The one document under this name is the listed one, if it still carries the name; the quarantine
                        // read below proves its bytes.
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
                    quarantineUri = await location.directory.rename(currentUri, quarantineName);
                    const displaced = await readSyncArtifactBytes(quarantineUri);
                    if (!displaced || await versionFor(displaced) !== expectedVersion) {
                        if (displaced) await restoreDisplacedGeneration(location, displaced);
                        throw new SyncEncryptionRemoteConflictError(`${name} changed during sync encryption transition`);
                    }
                }

                await testHooks.onMutationPoint?.('before-install', name);
                // Final install is an exclusive create, not a rename. Android DocumentsProviders
                // may alter rename names to resolve collisions and filesystem rename commonly
                // replaces an existing target. createNew verifies the exact canonical name and
                // therefore fails closed when a peer creates it after quarantine/staging.
                // createNew's closing listing proved the canonical name is this one new document. A document
                // is listed once more after its bytes land: a provider that allows duplicate names (Google
                // Drive) may take a peer's second document under the name meanwhile, and a later listing
                // keeps only the first per name. An attachment skips it: two listings per attachment, or none
                // where the provider was proved to rename a taken name (createNew then trusts its own name check).
                const installedUri = await location.directory.createNew(location.leaf, location.mimeType, { skipClosingListing: uniqueNames });
                await writeArtifactPayload(installedUri, stagedBytes);
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
                if (quarantineUri) {
                    const retained = await readSyncArtifactBytes(quarantineUri);
                    if (!retained || await versionFor(retained) !== expectedVersion) {
                        throw new SyncEncryptionRemoteConflictError(`${name} quarantine changed during sync encryption transition`);
                    }
                }
                await deleteSyncArtifact(stageUri);
                location.directory.entries.delete(stageName);
                if (quarantineUri && quarantineName) {
                    await deleteSyncArtifact(quarantineUri);
                    location.directory.entries.delete(quarantineName);
                }
                writes += 1;
                // Core verifies these read-back bytes instead of reading the document once more.
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
                const quarantineUri = await location.directory.rename(exact[0], quarantineName);
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
                await deleteSyncArtifact(quarantineUri);
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
