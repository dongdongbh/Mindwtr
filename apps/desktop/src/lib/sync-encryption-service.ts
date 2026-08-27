// Desktop's glue for sync encryption (#1056, phase 2 of 3).
//
// Rust owns key derivation and the OS-keyring cache (apps/desktop/src-tauri/src/
// sync_encryption.rs), plus the two storage seams it drives itself: the File Sync backend and
// the native WebDAV get/put. This module is the other half — the seams that live in the
// webview: Dropbox's data document, all three backends' attachment bytes, WebDAV when a config
// override sends the request through TS instead of Rust, and the shared transition
// orchestration from @mindwtr/core.
//
// Desktop TS never keeps a key cache of its own; every getKey/setKey/clearKey here is a Tauri
// call into Rust's keyring, so there is exactly one source of truth on the device.
//
// Deliberately imports nothing from ./sync-service — that module imports this one.

import {
    decryptRemoteArtifactOrThrow,
    defaultSyncCryptoPrimitives,
    deleteDropboxFileVersioned,
    deriveSyncKeyMaterial,
    downloadDropboxFileVersioned,
    encryptSyncArtifact,
    inspectSyncArtifact,
    runChangeSyncEncryptionPassphraseOverRemote,
    runDisableSyncEncryptionLocalOnly,
    runDisableSyncEncryptionOverRemote,
    runEnableSyncEncryptionLocalOnly,
    runEnableSyncEncryptionOverRemote,
    runProvideSyncEncryptionPassphraseOverRemote,
    SYNC_ENCRYPTION_KEYED_STATES,
    SyncCryptoUnsupportedError,
    SyncEncryptionRemotePlaintextError,
    SyncEncryptionTerminalError,
    uploadDropboxFileVersioned,
    webdavDeleteFileVersioned,
    webdavGetFileVersioned,
    webdavPutFileVersioned,
    type AppData,
    type Attachment,
    type SyncCryptoKdfParams,
    type SyncCryptoPrimitives,
    type SyncEncryptionKeyCachePort,
    type SyncEncryptionLocalState,
    type SyncEncryptionLocalStatePort,
    type SyncEncryptionRemoteEntry,
    type SyncEncryptionRemotePort,
    type SyncEncryptionRemoteRead,
    type SyncEncryptionStatus,
    type SyncEncryptionTransitionProgress,
    type SyncEncryptionTransitionKind,
    type SyncKeyMaterial,
    type WebDavOptions,
} from '@mindwtr/core';
import { invokeNative, invokeNativeOr } from './tauri-invoke';

/** The document names a blob remote can hold. Reads of an absent name resolve to `null` and
 *  the core transition loops skip them, so probing existence up front buys nothing. */
const REMOTE_DOCUMENT_NAMES = ['data.json', 'data.json.bak', 'data.json.enc', 'data.json.enc.bak'];

const OFF_STATUS: SyncEncryptionStatus = { state: 'off' };

type NativeKdfParams = { mKib: number; t: number; p: number };
type NativeKeyMaterial = { key: string; salt: string; kdfParams: NativeKdfParams };
type NativeStatus = {
    state: SyncEncryptionStatus['state'];
    kdfParams?: NativeKdfParams;
    hasKey: boolean;
    incompleteTransition?: SyncEncryptionTransitionKind;
};

const base64ToBytes = (value: string): Uint8Array => {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
};

const bytesToBase64 = (bytes: Uint8Array): string => {
    let binary = '';
    for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
    return btoa(binary);
};

const bytesToHex = (bytes: Uint8Array): string =>
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

const hexToBytes = (hex: string): Uint8Array => {
    const out = new Uint8Array(Math.floor(hex.length / 2));
    for (let index = 0; index < out.length; index += 1) {
        out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    return out;
};

const toMaterial = (payload: NativeKeyMaterial): SyncKeyMaterial => ({
    key: base64ToBytes(payload.key),
    salt: hexToBytes(payload.salt),
    params: payload.kdfParams,
});

// A keyring read can be an IPC round-trip (and on some Linux backends a prompt), and the
// attachment seams ask for the material once per file. Memoized until a transition changes it —
// so populating `enabledButLocked` alongside it (one extra one-time invoke per cache
// population, not per attachment or per cycle) costs an existing off-state install nothing
// ongoing (backward-compat invariant #1).
let materialCache: { material: SyncKeyMaterial | null; enabledButLocked: boolean } | null = null;

export const clearSyncEncryptionMaterialCache = (): void => {
    materialCache = null;
};

/** `null` whenever this device is not in the 'enabled' state, or is enabled but has no key —
 *  in which case every seam that needs one fails closed rather than silently writing
 *  plaintext into an encrypted folder. Callers that would otherwise treat `null` as "encryption
 *  is off" (e.g. an upload seam falling back to a plaintext write) must check
 *  `isSyncEncryptionEnabledButLocked()` first — see S3. */
export async function getSyncEncryptionMaterial(): Promise<SyncKeyMaterial | null> {
    if (materialCache) return materialCache.material;
    const [payload, status] = await Promise.all([
        invokeNativeOr<NativeKeyMaterial | null>(null, 'get_sync_encryption_key_material'),
        invokeNativeOr<NativeStatus | null>(null, 'get_sync_encryption_status'),
    ]);
    const material = payload ? toMaterial(payload) : null;
    const keyed = Boolean(status && SYNC_ENCRYPTION_KEYED_STATES.includes(status.state));
    materialCache = { material, enabledButLocked: keyed && !material };
    return material;
}

/** True when local state says `enabled` but no key resolved (S3) — an Android-Keystore-class
 *  keyring invalidation, or a corrupt fallback-key blob. Distinct from "encryption is off":
 *  a seam that resolves `null` material here must fail closed (surface
 *  `SyncEncryptionTerminalError`), never silently write a plaintext artifact into a folder
 *  every other device believes is encrypted. */
export async function isSyncEncryptionEnabledButLocked(): Promise<boolean> {
    await getSyncEncryptionMaterial();
    return materialCache?.enabledButLocked ?? false;
}

export async function getSyncEncryptionStatus(): Promise<SyncEncryptionStatus> {
    const status = await invokeNativeOr<NativeStatus | null>(null, 'get_sync_encryption_status');
    if (!status) return OFF_STATUS;
    return {
        state: status.state,
        kdfParams: status.kdfParams,
        incompleteTransition: status.incompleteTransition,
    };
}

/** Persists `remote-encrypted-no-key` the moment a TS seam finds ciphertext it cannot open.
 *  Mirrors core's `markRemoteEncryptionDiscovered`; Rust refuses to downgrade a keyed device
 *  whose salt matches the discovery (and deliberately DOES downgrade one holding a
 *  foreign-salt key — that key is provably for another generation, and only the no-key state
 *  surfaces the unlock prompt), so this is safe to call unconditionally from a read path. */
export async function markRemoteSyncEncryptionDiscovered(discovered: {
    salt: Uint8Array;
    params: SyncCryptoKdfParams;
}): Promise<void> {
    // `Or`, not the throwing form: in the web build there is no keyring and no sidecar to
    // persist into, and a discovery must not turn into a second, confusing failure on top of
    // the terminal one the caller is already raising.
    await invokeNativeOr(null, 'mark_sync_encryption_remote_discovered', {
        salt: bytesToHex(discovered.salt),
        kdfParams: discovered.params,
    });
    clearSyncEncryptionMaterialCache();
}

/** Persists `remote-plaintext` when a TS seam holds a key and finds the sync location back in
 *  plaintext (a peer disabled encryption there). Mirrors core's `markRemotePlaintextDiscovered`;
 *  Rust refuses to move any state but `enabled`, so this is safe to call from a read path. */
export async function markRemoteSyncEncryptionPlaintext(): Promise<void> {
    await invokeNativeOr(null, 'mark_sync_encryption_remote_plaintext');
    clearSyncEncryptionMaterialCache();
}

/** No Argon2 in desktop JS: a pure-JS KDF on the webview thread is exactly the freeze the
 *  Tauri-command rules exist to prevent, and Rust already has the identical implementation.
 *  AES-GCM stays in WebCrypto (both desktop webviews have it), which is what core's defaults
 *  already use. */
export const desktopSyncCryptoPrimitives: SyncCryptoPrimitives = {
    ...defaultSyncCryptoPrimitives,
    async argon2id(pass, salt, params, dkLen) {
        if (dkLen !== 32) throw new Error(`unsupported derived key length ${dkLen}`);
        const payload = await invokeNative<NativeKeyMaterial>('derive_sync_encryption_key', {
            // Rust NFC-normalizes too; normalization is idempotent, so re-encoding here is safe.
            passphrase: new TextDecoder().decode(pass),
            salt: bytesToHex(salt),
            kdfParams: params,
        });
        return base64ToBytes(payload.key);
    },
};

/** Rust's keyring and sidecar, exposed as core's two ports.
 *
 *  Core always calls `keyCache.setKey(key)` and then `localState.write({state, salt, params})`
 *  — the key alone cannot rebuild a header, so the persist is deferred to the write, where
 *  both halves are in hand and can be stored atomically by the one Rust command. That also
 *  keeps the "persist the enabled flag only after the transition has fully succeeded" rule:
 *  core never reaches the write if any artifact failed.
 *
 *  `localState.write` is synchronous in core's port shape while Rust's persistence is not, so
 *  writes are queued and `flush()` awaits them once the transition returns. */
const createTransitionPorts = (initial: SyncEncryptionLocalState | null) => {
    let current = initial;
    let pendingKey: Uint8Array | null = null;
    const queued: Promise<unknown>[] = [];

    const keyCache: SyncEncryptionKeyCachePort = {
        async getKey() {
            return (await getSyncEncryptionMaterial())?.key ?? null;
        },
        async setKey(key) {
            pendingKey = key;
        },
        async clearKey() {
            pendingKey = null;
        },
    };

    const localState: SyncEncryptionLocalStatePort = {
        read: () => current,
        write: (next) => {
            current = next;
            const key = pendingKey;
            const operation = (async () => {
                    if (next?.incompleteTransition) {
                        await invokeNative('mark_sync_encryption_transition_incomplete', {
                            transitionKind: next.incompleteTransition,
                        });
                    } else if (!next || next.state === 'off') {
                        await invokeNative('clear_sync_encryption_key_material');
                    } else if (key && next.discoveredSalt && next.discoveredParams) {
                        await invokeNative('set_sync_encryption_key_material', {
                            key: bytesToBase64(key),
                            salt: next.discoveredSalt,
                            kdfParams: next.discoveredParams,
                        });
                    }
                    clearSyncEncryptionMaterialCache();
                })();
            queued.push(operation);
            return operation;
        },
    };

    return {
        keyCache,
        localState,
        flush: async () => {
            await Promise.all(queued);
        },
    };
};

const statusToLocalState = (status: SyncEncryptionStatus): SyncEncryptionLocalState | null =>
    status.state === 'off' && !status.incompleteTransition
        ? null
        : {
            state: status.state,
            discoveredParams: status.kdfParams,
            incompleteTransition: status.incompleteTransition,
        };

const openTransitionPorts = async () =>
    createTransitionPorts(statusToLocalState(await getSyncEncryptionStatus()));

// ---------------------------------------------------------------------------
// Remote ports
// ---------------------------------------------------------------------------

const collectRemoteAttachmentKeys = (data: AppData | null): string[] => {
    if (!data) return [];
    const keys = new Set<string>();
    const visit = (attachments: Attachment[] | undefined) => {
        for (const attachment of attachments ?? []) {
            if (attachment.cloudKey) keys.add(attachment.cloudKey);
        }
    };
    for (const task of data.tasks ?? []) visit(task.attachments);
    for (const project of data.projects ?? []) visit(project.attachments);
    return Array.from(keys).sort();
};

/** The remote's own sync document is the attachment index — enumerating from it (rather than
 *  from local state) means a transition covers attachments this device has not merged yet.
 *  Neither WebDAV nor Dropbox has a directory-listing primitive in this codebase, and adding
 *  a multistatus XML parser / a paginated list_folder client to enumerate files the document
 *  already names would be a lot of new surface for no extra coverage.
 *  ponytail: an attachment orphaned on the remote (no record references it) is not converted;
 *  it is already invisible to every client. Add real listing if orphan cleanup ever needs it. */
/** Never throws on a document it cannot open — enumerating attachment names is its only job,
 *  and failing the listing aborts the whole transition before the recovery logic that would
 *  have fixed the artifact ever runs (that is what bricked a passphrase-change resume: the
 *  base document is rewrapped first, so the cached key stops opening it).
 *
 *  `recoveryPassphrase` is what keeps "returns null" from trading a hard abort for silent
 *  data loss: on a resume the document is sealed under an ABANDONED intermediate salt, and a
 *  null listing would enumerate zero attachments and leave every one of them behind under a
 *  key nothing ever derives again. Re-deriving from the artifact's OWN header is the same
 *  recovery core's `rewrap` performs on each artifact. */
const decodeDocument = async (
    bytes: Uint8Array | null,
    key: Uint8Array | null,
    recoveryPassphrase?: string,
): Promise<AppData | null> => {
    if (!bytes) return null;
    const inspected = inspectSyncArtifact(bytes);
    if (inspected.kind === 'unsupported') {
        // Same classification core's `unsupportedArtifact` gives this input class. Parsing it
        // as JSON would throw a raw SyntaxError out of remote.list() instead.
        throw new SyncEncryptionTerminalError(new SyncCryptoUnsupportedError(inspected.reason));
    }
    if (inspected.kind === 'plaintext') {
        return JSON.parse(new TextDecoder().decode(bytes)) as AppData;
    }
    const candidates: Uint8Array[] = key ? [key] : [];
    if (recoveryPassphrase) {
        const recovered = await deriveSyncKeyMaterial(
            recoveryPassphrase,
            inspected.salt,
            inspected.params,
            desktopSyncCryptoPrimitives,
        );
        candidates.push(recovered.key);
    }
    for (const candidate of candidates) {
        try {
            const plain = await decryptRemoteArtifactOrThrow(bytes, candidate, desktopSyncCryptoPrimitives);
            return JSON.parse(new TextDecoder().decode(plain)) as AppData;
        } catch (error) {
            if (!(error instanceof SyncEncryptionTerminalError)) throw error;
        }
    }
    return null;
};

/** The key is resolved here rather than taken as a parameter: a caller that passed `null` by
 *  mistake would enumerate zero attachments and a transition would silently skip all of them. */
const listRemoteEntries = async (
    read: (name: string) => Promise<SyncEncryptionRemoteRead>,
    recoveryPassphrase?: string,
): Promise<SyncEncryptionRemoteEntry[]> => {
    const key = (await getSyncEncryptionMaterial())?.key ?? null;
    const data =
        (await decodeDocument((await read('data.json.enc')).bytes, key, recoveryPassphrase)) ??
        (await decodeDocument((await read('data.json')).bytes, key, recoveryPassphrase));
    return [
        ...REMOTE_DOCUMENT_NAMES.map((name) => ({ name, kind: 'document' as const })),
        ...collectRemoteAttachmentKeys(data).map((name) => ({ name, kind: 'attachment' as const })),
    ];
};

export type WebdavRemotePortConfig = {
    baseUrl: string;
    options: WebDavOptions;
};

export function createWebdavRemotePort(config: WebdavRemotePortConfig): SyncEncryptionRemotePort {
    const urlFor = (name: string) => `${config.baseUrl}/${name}`;
    const read = (name: string): Promise<SyncEncryptionRemoteRead> =>
        webdavGetFileVersioned(urlFor(name), config.options);
    return {
        list: () => listRemoteEntries(read),
        read,
        write: async (name, bytes, expectedVersion) => {
            await webdavPutFileVersioned(
                urlFor(name), bytes, 'application/octet-stream', expectedVersion, config.options,
            );
        },
        remove: async (name, expectedVersion) => {
            await webdavDeleteFileVersioned(urlFor(name), expectedVersion, config.options);
        },
    };
}

export function createDropboxRemotePort(
    withToken: <T>(operation: (token: string) => Promise<T>) => Promise<T>,
    fetcher: typeof fetch,
): SyncEncryptionRemotePort {
    const read = (name: string): Promise<SyncEncryptionRemoteRead> =>
        withToken((token) => downloadDropboxFileVersioned(token, name, fetcher));
    return {
        list: () => listRemoteEntries(read),
        read,
        write: async (name, bytes, expectedVersion) => {
            await withToken((token) =>
                uploadDropboxFileVersioned(token, name, bytes, expectedVersion, fetcher),
            );
        },
        remove: async (name, expectedVersion) => {
            await withToken((token) => deleteDropboxFileVersioned(token, name, expectedVersion, fetcher));
        },
    };
}

// ---------------------------------------------------------------------------
// Transitions over a TS-driven remote (Dropbox always; WebDAV under a config override)
// ---------------------------------------------------------------------------

export async function runEnableOverRemote(
    passphrase: string,
    remote: SyncEncryptionRemotePort,
    onProgress?: (progress: SyncEncryptionTransitionProgress) => void,
): Promise<void> {
    const ports = await openTransitionPorts();
    await runEnableSyncEncryptionOverRemote(
        passphrase,
        remote,
        ports.keyCache,
        ports.localState,
        onProgress,
        desktopSyncCryptoPrimitives,
    );
    await ports.flush();
}

/** No configured backend (#1001): derive+persist only, so the first sync a later backend
 *  runs writes ciphertext from its first byte. Core guards the entry state. */
export async function runEnableLocalOnly(passphrase: string): Promise<void> {
    const ports = await openTransitionPorts();
    await runEnableSyncEncryptionLocalOnly(
        passphrase,
        ports.keyCache,
        ports.localState,
        desktopSyncCryptoPrimitives,
    );
    await ports.flush();
}

/** No configured backend: clears this device's key and state; no remote is touched. */
export async function runDisableLocalOnly(): Promise<void> {
    const ports = await openTransitionPorts();
    await runDisableSyncEncryptionLocalOnly(ports.keyCache, ports.localState);
    await ports.flush();
}

export async function runDisableOverRemote(
    remote: SyncEncryptionRemotePort,
    onProgress?: (progress: SyncEncryptionTransitionProgress) => void,
): Promise<void> {
    const ports = await openTransitionPorts();
    await runDisableSyncEncryptionOverRemote(
        remote,
        ports.keyCache,
        ports.localState,
        onProgress,
        desktopSyncCryptoPrimitives,
    );
    await ports.flush();
}

/** Re-lists through `nextPassphrase` so an interrupted earlier attempt — which left the base
 *  document sealed under an abandoned intermediate salt the cached key cannot open — still
 *  yields the full attachment worklist. */
const withRecoveryListing = (
    remote: SyncEncryptionRemotePort,
    nextPassphrase: string,
): SyncEncryptionRemotePort => ({
    ...remote,
    list: () => listRemoteEntries(remote.read, nextPassphrase),
});

export async function runChangePassphraseOverRemote(
    currentPassphrase: string,
    nextPassphrase: string,
    remote: SyncEncryptionRemotePort,
    onProgress?: (progress: SyncEncryptionTransitionProgress) => void,
): Promise<void> {
    const ports = await openTransitionPorts();
    await runChangeSyncEncryptionPassphraseOverRemote(
        currentPassphrase,
        nextPassphrase,
        withRecoveryListing(remote, nextPassphrase),
        ports.keyCache,
        ports.localState,
        onProgress,
        desktopSyncCryptoPrimitives,
    );
    await ports.flush();
}

export async function runProvidePassphraseOverRemote(
    passphrase: string,
    remote: SyncEncryptionRemotePort,
): Promise<'ok' | 'wrong-passphrase'> {
    const ports = await openTransitionPorts();
    const outcome = await runProvideSyncEncryptionPassphraseOverRemote(
        passphrase,
        'data.json',
        remote,
        ports.keyCache,
        ports.localState,
        desktopSyncCryptoPrimitives,
    );
    await ports.flush();
    return outcome;
}

// ---------------------------------------------------------------------------
// Attachment bytes (WebDAV, Dropbox, and the file backend — all three go through the
// webview's byte primitives, so all three are encrypted here rather than in Rust)
// ---------------------------------------------------------------------------

/** Attachments keep their exact remote name with encrypted bytes: `cloudKey` is identity-keyed
 *  and immutable once uploaded, so renaming would churn every record (pinned decision #1). */
export async function sealAttachmentBytes(bytes: Uint8Array): Promise<Uint8Array> {
    const material = await getSyncEncryptionMaterial();
    if (material) return encryptSyncArtifact(bytes, material);
    if (await isSyncEncryptionEnabledButLocked()) {
        // S3: `enabled` but no key resolved must fail closed — the old `return bytes`
        // fallback here would silently upload a PLAINTEXT attachment into a folder every
        // other device believes is encrypted.
        throw new SyncEncryptionTerminalError(
            new SyncCryptoUnsupportedError('sync encryption is enabled but no key is available on this device'),
        );
    }
    return bytes;
}

/** Plaintext bytes pass straight through: during (and after an interrupted) transition a
 *  remote legitimately holds both generations, and a peer on an older app version can still
 *  upload plaintext. Ciphertext with no key is terminal — never "corrupt, re-upload". */
export async function openAttachmentBytes(bytes: Uint8Array): Promise<Uint8Array> {
    const inspected = inspectSyncArtifact(bytes);
    if (inspected.kind === 'unsupported') {
        throw new SyncEncryptionTerminalError(new SyncCryptoUnsupportedError(inspected.reason));
    }
    if (inspected.kind === 'plaintext') return bytes;
    const material = await getSyncEncryptionMaterial();
    if (!material) {
        await markRemoteSyncEncryptionDiscovered({ salt: inspected.salt, params: inspected.params });
        throw new SyncEncryptionTerminalError(
            new SyncCryptoUnsupportedError('encrypted attachment: no key on this device'),
        );
    }
    return decryptRemoteArtifactOrThrow(bytes, material.key, desktopSyncCryptoPrimitives);
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/** Rust's sentinels, mirrored from apps/desktop/src-tauri/src/sync_encryption.rs. */
export const SYNC_ENCRYPTION_TERMINAL = 'SYNC_ENCRYPTION_TERMINAL';
export const SYNC_ENCRYPTION_STATE_UNAVAILABLE = 'SYNC_ENCRYPTION_STATE_UNAVAILABLE';
export const SYNC_ENCRYPTION_REMOTE_ENCRYPTED = 'SYNC_ENCRYPTION_REMOTE_ENCRYPTED';
export const SYNC_ENCRYPTION_REMOTE_PLAINTEXT = 'SYNC_ENCRYPTION_REMOTE_PLAINTEXT';
export const SYNC_ENCRYPTION_TRANSITION_INCOMPLETE = 'SYNC_ENCRYPTION_TRANSITION_INCOMPLETE';

export type SyncEncryptionFailure =
    | 'local-state-unavailable'
    | 'needs-passphrase'
    | 'remote-encrypted-no-key'
    | 'remote-plaintext'
    | 'transition-incomplete';

/** A decrypt failure is never a permission problem and never "corrupt data we repaired" — it
 *  is always "this device needs the passphrase again". Returning a discriminant (rather than a
 *  message) keeps the prose out of this module: desktop's toast-i18n test scans showToast's
 *  first argument for literals, so the caller resolves the string. */
export function classifySyncEncryptionFailure(error: unknown): SyncEncryptionFailure | null {
    if (error instanceof SyncEncryptionRemotePlaintextError) return 'remote-plaintext';
    if (error instanceof SyncEncryptionTerminalError) return 'needs-passphrase';
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    // `includes`, not `startsWith`: a Tauri rejection travels through the sync run's own error
    // wrapping before it gets here, the same reason `SYNC_FILE_WRITE_CONFLICT` is matched that
    // way. The two sentinels do not share a prefix, so order only decides which wins on the
    // (impossible) both-present case.
    if (message.includes(SYNC_ENCRYPTION_STATE_UNAVAILABLE)) return 'local-state-unavailable';
    if (message.includes(SYNC_ENCRYPTION_TRANSITION_INCOMPLETE)) return 'transition-incomplete';
    if (message.includes(SYNC_ENCRYPTION_REMOTE_ENCRYPTED)) return 'remote-encrypted-no-key';
    if (message.includes(SYNC_ENCRYPTION_REMOTE_PLAINTEXT)) return 'remote-plaintext';
    if (message.includes(SYNC_ENCRYPTION_TERMINAL)) return 'needs-passphrase';
    return null;
}

export const isSyncEncryptionFailure = (error: unknown): boolean =>
    classifySyncEncryptionFailure(error) !== null;

export const __syncEncryptionServiceTestUtils = {
    base64ToBytes,
    bytesToBase64,
    bytesToHex,
    hexToBytes,
    collectRemoteAttachmentKeys,
    REMOTE_DOCUMENT_NAMES,
};
