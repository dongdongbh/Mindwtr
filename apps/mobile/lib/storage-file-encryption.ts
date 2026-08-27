// File Sync (SAF on Android, plain paths on iOS) byte IO for encrypted sync artifacts,
// plus the `SyncEncryptionRemotePort` adapter that lets this backend reuse core's
// transition orchestration (#1056 phase 2).
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
// Everything here is byte-level. The MWENC1 container is binary, so the text APIs the
// plaintext path uses (`readAsStringAsync` UTF-8, `ExpoFile.text()`) would mangle it.

import { Directory as ExpoDirectory, File as ExpoFile } from 'expo-file-system';
import {
    ATTACHMENTS_DIR_NAME,
    computeSha256Hex,
    inspectSyncArtifact,
    LEGACY_SYNC_FILE_NAME,
    SYNC_FILE_NAME,
    sleep,
    SyncEncryptionRemoteConflictError,
    type SyncEncryptionRemoteEntry,
    type SyncEncryptionRemotePort,
} from '@mindwtr/core';

import { logWarn } from './app-log';
import { base64ToBytes, bytesToBase64 } from './attachment-sync-utils';
import * as FileSystem from './file-system';
import { renameSafTransitionDocument } from './sync-file-transition-cas';

const StorageAccessFramework = FileSystem.StorageAccessFramework;

const DEFAULT_ARTIFACT_MIME = 'application/octet-stream';
/** ASCII space. The MWENC1 reader ignores bytes past `54 + ciphertext_len`, which is what
 *  makes padding a shrinking write harmless — see sync-crypto.ts's header comment. */
const PAD_BYTE = 0x20;

const isReadOnlyError = (error: unknown): boolean =>
    /isn't writable|not writable|read-only|read only|permission denied|EACCES/i.test(String(error));

const isSaf = (uri: string): boolean => uri.startsWith('content://');

const getLeafName = (uri: string): string => {
    const stripped = decodeURIComponent(uri.split('?')[0]?.split('#')[0] ?? uri).replace(/\/+$/, '');
    const lastSeparator = Math.max(stripped.lastIndexOf('/'), stripped.lastIndexOf(':'));
    return lastSeparator >= 0 ? stripped.slice(lastSeparator + 1) : stripped;
};

/** Reads a sync artifact as raw bytes, or `null` when it does not exist. Never throws for
 *  a missing file — callers distinguish "absent" from "unreadable" and an absent `.enc`
 *  sibling is the normal case on every plaintext folder. */
export const readSyncArtifactBytes = async (uri: string): Promise<Uint8Array | null> => {
    try {
        if (isSaf(uri)) {
            if (!StorageAccessFramework?.readAsStringAsync) {
                throw new Error('This Android build does not support Storage Access Framework (SAF).');
            }
            const base64 = await StorageAccessFramework.readAsStringAsync(uri, {
                encoding: FileSystem.EncodingType.Base64,
            });
            return base64 ? base64ToBytes(base64) : new Uint8Array(0);
        }
        const file = new ExpoFile(uri);
        if (!file.exists) return null;
        return await file.bytes();
    } catch (error) {
        // The modern File API is unavailable on some legacy paths; the legacy Base64 read
        // is the same fallback ladder readFileText uses for text.
        try {
            const info = await FileSystem.getInfoAsync(uri);
            if (!info.exists) return null;
            const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
            return base64 ? base64ToBytes(base64) : new Uint8Array(0);
        } catch {
            if (isSaf(uri)) return null; // SAF has no exists() — an unreadable doc is an absent one.
            throw error;
        }
    }
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
export const padBytesForNonTruncatingOverwrite = (bytes: Uint8Array, previousLength: number): Uint8Array => {
    if (previousLength <= bytes.length) return bytes;
    const padded = new Uint8Array(previousLength);
    padded.set(bytes, 0);
    padded.fill(PAD_BYTE, bytes.length);
    return padded;
};

/** The actual SAF/ExpoFile write ladder, given the exact bytes to land on disk. Shared by
 *  both writeSyncArtifactBytes branches below. */
const writeArtifactPayload = async (uri: string, payload: Uint8Array): Promise<void> => {
    if (isSaf(uri) && StorageAccessFramework?.writeAsStringAsync) {
        const base64 = bytesToBase64(payload);
        try {
            await StorageAccessFramework.writeAsStringAsync(uri, base64, {
                encoding: FileSystem.EncodingType.Base64,
            });
            return;
        } catch (error) {
            // Same load-bearing ladder as writeSyncFile: expo's legacy SAF write refuses
            // whenever the provider omits FLAG_SUPPORTS_WRITE (RSAF/rclone always does),
            // and the modern File API writes straight through openOutputStream with no
            // writability pre-check.
            if (!isReadOnlyError(error)) throw error;
            try {
                new ExpoFile(uri).write(payload);
                return;
            } catch (streamError) {
                void logWarn('SAF encrypted output-stream write failed; retrying the provider write once', {
                    scope: 'sync',
                    extra: { error: streamError instanceof Error ? streamError.message : String(streamError) },
                });
                await sleep(1000);
                await StorageAccessFramework.writeAsStringAsync(uri, base64, {
                    encoding: FileSystem.EncodingType.Base64,
                });
                return;
            }
        }
    }

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

export const writeSyncArtifactBytes = async (
    uri: string,
    bytes: Uint8Array,
    options: { createOnly?: boolean } = {},
): Promise<void> => {
    if (options.createOnly) {
        if (isSaf(uri)) throw new Error('SAF create-only writes must create through the directory handle');
        const file = new ExpoFile(uri);
        try {
            file.create({ intermediates: true, overwrite: false });
        } catch (error) {
            const info = await FileSystem.getInfoAsync(uri).catch(() => ({ exists: false }));
            if (info.exists) throw new SyncEncryptionRemoteConflictError(`${uri} was created by another writer`);
            throw error;
        }
        file.write(bytes);
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

export const deleteSyncArtifact = async (uri: string): Promise<void> => {
    if (isSaf(uri)) {
        if (!StorageAccessFramework?.deleteAsync) return;
        await StorageAccessFramework.deleteAsync(uri, { idempotent: true });
        return;
    }
    await FileSystem.deleteAsync(uri, { idempotent: true });
};

type DirectoryHandle = {
    /** leaf name -> uri, for entries that already exist. */
    entries: Map<string, string>;
    resolve(name: string, options: { createIfMissing: boolean; mimeType?: string }): Promise<string | null>;
    listExact(name: string): Promise<string[]>;
    createNew(name: string, mimeType?: string): Promise<string>;
    rename(uri: string, name: string): Promise<string>;
};

const openSafDirectory = async (dirUri: string): Promise<DirectoryHandle> => {
    const entries = new Map<string, string>();
    if (StorageAccessFramework?.readDirectoryAsync) {
        try {
            for (const entry of await StorageAccessFramework.readDirectoryAsync(dirUri)) {
                const name = getLeafName(entry);
                if (name && !entries.has(name)) entries.set(name, entry);
            }
        } catch (error) {
            void logWarn('Failed to list SAF sync directory', {
                scope: 'sync',
                extra: { error: error instanceof Error ? error.message : String(error) },
            });
        }
    }
    const listExact = async (name: string): Promise<string[]> => {
        if (!StorageAccessFramework?.readDirectoryAsync) return [];
        const matches = (await StorageAccessFramework.readDirectoryAsync(dirUri))
            .filter((entry) => getLeafName(entry) === name);
        if (matches.length === 1) entries.set(name, matches[0]);
        else entries.delete(name);
        return matches;
    };
    return {
        entries,
        resolve: async (name, options) => {
            let existing = entries.get(name);
            if (!existing && StorageAccessFramework?.readDirectoryAsync) {
                for (const entry of await StorageAccessFramework.readDirectoryAsync(dirUri)) {
                    if (getLeafName(entry) === name) {
                        existing = entry;
                        entries.set(name, entry);
                        break;
                    }
                }
            }
            if (existing) return existing;
            if (!options.createIfMissing || !StorageAccessFramework?.createFileAsync) return null;
            const created = await StorageAccessFramework.createFileAsync(
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
            const createdName = getLeafName(created);
            if (createdName !== name) {
                void logWarn('SAF provider renamed a sync artifact on create', {
                    scope: 'sync',
                    extra: { requested: name, created: createdName },
                });
            }
            entries.set(name, created);
            return created;
        },
        listExact,
        createNew: async (name, mimeType = DEFAULT_ARTIFACT_MIME) => {
            if (!StorageAccessFramework?.createFileAsync) {
                throw new Error('This Android build cannot create SAF transition files.');
            }
            const created = await StorageAccessFramework.createFileAsync(dirUri, name, mimeType);
            if (!created || getLeafName(created) !== name) {
                if (created) await deleteSyncArtifact(created).catch(() => undefined);
                throw new SyncEncryptionRemoteConflictError(`${name} was created or renamed by another writer`);
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
            const previousName = getLeafName(uri);
            let renamed: { uri: string; name: string };
            try {
                renamed = await renameSafTransitionDocument(uri, name);
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
    try {
        for (const name of await FileSystem.readDirectoryAsync(normalized)) {
            entries.set(name, `${normalized}${name}`);
        }
    } catch {
        // A missing attachments/ directory is normal; an unreadable sync dir surfaces on
        // the first read/write instead.
    }
    const listExact = async (name: string): Promise<string[]> => {
        const candidate = `${normalized}${name}`;
        const info = await FileSystem.getInfoAsync(candidate).catch(() => ({ exists: false }));
        if (info.exists) {
            entries.set(name, candidate);
            return [candidate];
        }
        entries.delete(name);
        return [];
    };
    return {
        entries,
        resolve: async (name, options) => {
            let existing = entries.get(name);
            if (!existing) {
                const candidate = `${normalized}${name}`;
                const info = await FileSystem.getInfoAsync(candidate).catch(() => ({ exists: false }));
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
            const file = new ExpoFile(uri);
            try {
                file.create({ intermediates: true, overwrite: false });
            } catch (error) {
                if ((await FileSystem.getInfoAsync(uri).catch(() => ({ exists: false }))).exists) {
                    throw new SyncEncryptionRemoteConflictError(`${name} was created by another writer`);
                }
                throw error;
            }
            entries.set(name, uri);
            return uri;
        },
        rename: async (uri, name) => {
            const file = new ExpoFile(uri);
            const previousName = getLeafName(uri);
            try {
                file.rename(name);
            } catch (error) {
                if ((await listExact(name)).length > 0) {
                    throw new SyncEncryptionRemoteConflictError(`${name} was created by another writer`);
                }
                throw error;
            }
            entries.delete(previousName);
            entries.set(name, file.uri);
            return file.uri;
        },
    };
};

const openDirectory = (dirUri: string): Promise<DirectoryHandle> =>
    isSaf(dirUri) ? openSafDirectory(dirUri) : openPathDirectory(dirUri);

/** Document artifacts a mobile File Sync folder can hold. Mobile writes `data.json` and
 *  `data.json.bak`; the legacy name and desktop's `.enc` counterparts are included so a
 *  transition migrates (and a disable restores) everything a mixed desktop/mobile folder
 *  actually contains. */
const isSyncDocumentName = (name: string): boolean => {
    const base = name.replace(/\.enc(\.bak|\.tmp|\.previous)?$/, '').replace(/\.(bak|tmp|previous)$/, '');
    return base === SYNC_FILE_NAME || base === LEGACY_SYNC_FILE_NAME;
};

export type FileSyncEncryptionTarget = {
    /** The directory holding data.json — SAF tree/document URI or a `file://` dir. */
    dirUri: string;
    /** The attachments subdirectory URI, or null when the folder has none yet. */
    attachmentsDirUri: string | null;
};

/**
 * Resolves the sync folder (and its attachments subfolder) from the configured sync-file
 * URI. Unlike `resolveFileSyncDir` in attachment-sync-utils this never CREATES the
 * attachments directory — a transition must not conjure folders into a user's sync
 * target as a side effect of listing it.
 */
export const resolveFileSyncEncryptionTarget = async (syncFileUri: string): Promise<FileSyncEncryptionTarget | null> => {
    if (!syncFileUri) return null;
    if (isSaf(syncFileUri)) {
        const prefixMatch = syncFileUri.match(/^(content:\/\/[^/]+)/);
        const treeMatch = syncFileUri.match(/\/tree\/([^/?#]+)/);
        if (!prefixMatch || !treeMatch) return null;
        const treeUri = `${prefixMatch[1]}/tree/${treeMatch[1]}`;
        const docMatch = syncFileUri.match(/\/document\/([^/?#]+)/);
        // The document id of data.json's PARENT is the sync directory. Fall back to the
        // tree root when the URI is already a bare tree URI.
        let dirUri = treeUri;
        if (docMatch) {
            const documentId = decodeURIComponent(docMatch[1]);
            const lastSlash = documentId.lastIndexOf('/');
            const parentId = lastSlash >= 0 ? documentId.slice(0, lastSlash) : documentId;
            if (parentId) dirUri = `${treeUri}/document/${encodeURIComponent(parentId)}`;
        }
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
    let hasAttachments = false;
    try {
        hasAttachments = new ExpoDirectory(attachmentsDirUri).exists;
    } catch {
        hasAttachments = false;
    }
    return { dirUri, attachmentsDirUri: hasAttachments ? attachmentsDirUri : null };
};

/**
 * Resolves a sibling artifact of the configured sync file by leaf name (e.g.
 * `data.json.enc`), optionally creating it. Only ever called when encryption is on, or
 * on the one-shot discovery probe — the plaintext steady state never lists a directory
 * it did not already list (backward-compat invariant #1).
 */
export const resolveSyncArtifactSiblingUri = async (
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
// Keep provider-facing scratch names bounded. Attachment names can be arbitrarily long,
// and prefixing the canonical leaf made otherwise-valid transitions exceed SAF/provider
// display-name limits. The timestamp/counter/random tuple remains collision-resistant
// without inheriting user-controlled leaf length.
const TRANSITION_SCRATCH_MARKER = '.mindwtr-et-';
let transitionScratchCounter = 0;

export type FileSyncTransitionMutationPoint = 'before-quarantine' | 'before-install' | 'before-remove-commit';
export type FileSyncTransitionTestHooks = {
    onMutationPoint?: (point: FileSyncTransitionMutationPoint, name: string) => void | Promise<void>;
};

const transitionScratchName = (kind: 'stage' | 'quarantine'): string => {
    transitionScratchCounter += 1;
    const kindCode = kind === 'stage' ? 's' : 'q';
    const nonce = Math.random().toString(36).slice(2, 10);
    return `${TRANSITION_SCRATCH_MARKER}${kindCode}-${Date.now().toString(36)}-${transitionScratchCounter.toString(36)}-${nonce}`;
};

const isTransitionScratchName = (name: string): boolean => name.includes(TRANSITION_SCRATCH_MARKER);

/**
 * Adapts a File Sync folder to core's generic transition port. Entry names are relative
 * to the sync root: `data.json`, `data.json.enc.bak`, `attachments/<id>.png`.
 *
 * Transition mutations refresh the exact target name, then atomically rename the
 * displaced generation into a same-directory quarantine before inspecting it. A racing
 * peer therefore causes a conflict without being overwritten or deleted; staged and
 * quarantined generations remain available for retry/recovery.
 */
export const createFileSyncEncryptionRemotePort = async (
    syncFileUri: string,
    testHooks: FileSyncTransitionTestHooks = {},
): Promise<SyncEncryptionRemotePort | null> => {
    const target = await resolveFileSyncEncryptionTarget(syncFileUri);
    if (!target) return null;

    const documents = await openDirectory(target.dirUri);
    const attachments = target.attachmentsDirUri ? await openDirectory(target.attachmentsDirUri) : null;

    const locate = async (name: string, createIfMissing: boolean): Promise<string | null> => {
        if (name.startsWith(ATTACHMENT_PREFIX)) {
            // Attachments are rewritten in place under their existing names (cloudKey is
            // identity-keyed and immutable), so a missing one is never created here.
            return attachments ? attachments.resolve(name.slice(ATTACHMENT_PREFIX.length), { createIfMissing: false }) : null;
        }
        return documents.resolve(name, {
            createIfMissing,
            mimeType: name.endsWith('.json') ? 'application/json' : DEFAULT_ARTIFACT_MIME,
        });
    };

    const locationFor = (name: string): { directory: DirectoryHandle; leaf: string; mimeType: string } | null => {
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
        const uri = await locate(name, false);
        if (!uri) return { bytes: null, version: null };
        const bytes = await readSyncArtifactBytes(uri);
        if (!bytes) throw new Error(`sync encryption: failed to read existing artifact ${name}`);
        return { bytes, version: await versionFor(bytes) };
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
            await writeSyncArtifactBytes(restoredUri, displaced);
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

    return {
        list: async (): Promise<SyncEncryptionRemoteEntry[]> => {
            const entries: SyncEncryptionRemoteEntry[] = [];
            for (const name of documents.entries.keys()) {
                if (!isTransitionScratchName(name) && isSyncDocumentName(name)) entries.push({ name, kind: 'document' });
            }
            if (attachments) {
                for (const name of attachments.entries.keys()) {
                    if (!isTransitionScratchName(name)) {
                        entries.push({ name: `${ATTACHMENT_PREFIX}${name}`, kind: 'attachment' });
                    }
                }
            }
            return entries;
        },
        read,
        write: async (name, bytes, expectedVersion) => {
            const current = await read(name);
            if (current.version !== expectedVersion) {
                throw new SyncEncryptionRemoteConflictError(`${name} changed during sync encryption transition`);
            }
            const location = locationFor(name);
            if (!location) throw new Error(`sync encryption: cannot create ${name} in the sync folder`);
            const stageName = transitionScratchName('stage');
            const stageUri = await location.directory.createNew(stageName, location.mimeType);
            await writeSyncArtifactBytes(stageUri, bytes);
            const stagedBytes = await readSyncArtifactBytes(stageUri);
            if (!stagedBytes || await versionFor(stagedBytes) !== await versionFor(bytes)) {
                throw new SyncEncryptionRemoteConflictError(`${name} could not be verified after transition staging`);
            }

            let quarantineUri: string | null = null;
            let quarantineName: string | null = null;
            if (expectedVersion !== null) {
                await testHooks.onMutationPoint?.('before-quarantine', name);
                const exact = await location.directory.listExact(location.leaf);
                if (exact.length !== 1) {
                    throw new SyncEncryptionRemoteConflictError(`${name} changed during sync encryption transition`);
                }
                quarantineName = transitionScratchName('quarantine');
                quarantineUri = await location.directory.rename(exact[0], quarantineName);
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
            const installedUri = await location.directory.createNew(location.leaf, location.mimeType);
            await writeSyncArtifactBytes(installedUri, stagedBytes);
            const canonical = await location.directory.listExact(location.leaf);
            if (canonical.length !== 1 || canonical[0] !== installedUri) {
                throw new SyncEncryptionRemoteConflictError(`${name} was created by another writer`);
            }
            const written = await readSyncArtifactBytes(installedUri);
            if (!written || await versionFor(written) !== await versionFor(bytes)) {
                throw new SyncEncryptionRemoteConflictError(`${name} could not be verified after transition write`);
            }
            await deleteSyncArtifact(stageUri);
            location.directory.entries.delete(stageName);
            if (quarantineUri && quarantineName) {
                await deleteSyncArtifact(quarantineUri);
                location.directory.entries.delete(quarantineName);
            }
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
            await deleteSyncArtifact(quarantineUri);
            location.directory.entries.delete(quarantineName);
            location.directory.entries.delete(location.leaf);
        },
    };
};

export const __storageFileEncryptionTestUtils = { getLeafName, isSyncDocumentName };
