// Sync encryption wiring (#1056, phase 2 of 3). Builds on the MWENC1 format from
// sync-crypto.ts to add: the device-local encryption-state model, `.enc` filename
// mapping, and the enable/disable/passphrase-change transition orchestration that is
// shared between the WebDAV and Dropbox backends (both TS, both desktop+mobile).
//
// The File Sync backend does NOT use the generic transition functions here — its
// transition logic lives in Rust (apps/desktop/src-tauri/src/sync.rs) and mobile's own
// storage-file.ts, per the task handoff ("Rust necessarily duplicates the seam logic
// for the file backend — keep its surface minimal and mirror core naming"). Those
// implementations mirror the naming and semantics defined here (see their own files).
//
// Merge, revision, signature, and fingerprint logic are untouched by this module —
// encryption lives strictly at the storage seam, wrapping already-serialized bytes.

import {
    SYNC_CRYPTO_DEFAULT_KDF_PARAMS,
    SyncCryptoAuthError,
    SyncCryptoUnsupportedError,
    decryptSyncArtifact,
    defaultSyncCryptoPrimitives,
    deriveSyncKeyMaterial,
    encryptSyncArtifact,
    inspectSyncArtifact,
    type SyncCryptoKdfParams,
    type SyncCryptoPrimitives,
    type SyncKeyMaterial,
} from './sync-crypto';

/** `remote-plaintext` is the inverse of `remote-encrypted-no-key`: this device holds a key
 *  and the sync location has gone back to plaintext (a peer disabled encryption there). It
 *  behaves exactly like `enabled` wherever key material is resolved — the key is still valid
 *  and the user's remedy (disabling encryption here too) needs it — and differs only in what
 *  status reports and in that sync is terminal until the user acts. */
export type SyncEncryptionState = 'off' | 'enabled' | 'remote-encrypted-no-key' | 'remote-plaintext';
export type SyncEncryptionTransitionKind = 'enable' | 'disable' | 'change-passphrase';

/** The states in which this device owns a usable key. Every material/key resolver must treat
 *  them alike: dropping to "off" for `remote-plaintext` is precisely the silent downgrade
 *  that state exists to prevent. */
export const SYNC_ENCRYPTION_KEYED_STATES: readonly SyncEncryptionState[] = ['enabled', 'remote-plaintext'];

export type SyncEncryptionStatus = {
    state: SyncEncryptionState;
    kdfParams?: SyncCryptoKdfParams;
    incompleteTransition?: SyncEncryptionTransitionKind;
};

/** Device-local, never-synced persisted shape. Salt/params are not secret (they live in
 * every artifact's header anyway) — only the derived key is secret, and that lives in
 * the platform's key-cache port (OS keyring / SecureStore), never here. */
export type SyncEncryptionLocalState = {
    state: SyncEncryptionState;
    discoveredSalt?: string; // hex
    discoveredParams?: SyncCryptoKdfParams;
    incompleteTransition?: SyncEncryptionTransitionKind;
};

export type SyncEncryptionLocalStatePort = {
    read(): SyncEncryptionLocalState | null;
    /** `null` clears back to the implicit 'off' default. */
    write(state: SyncEncryptionLocalState | null): void | Promise<void>;
};

export const SYNC_ENCRYPTION_TRANSITION_INCOMPLETE = 'SYNC_ENCRYPTION_TRANSITION_INCOMPLETE';

export class SyncEncryptionTransitionIncompleteError extends Error {
    constructor(kind: SyncEncryptionTransitionKind) {
        super(`${SYNC_ENCRYPTION_TRANSITION_INCOMPLETE}: retry the ${kind} sync encryption transition before syncing or changing the sync location`);
        this.name = 'SyncEncryptionTransitionIncompleteError';
    }
}

const requireMatchingIncompleteTransition = (
    localState: SyncEncryptionLocalStatePort,
    kind: SyncEncryptionTransitionKind,
): SyncEncryptionLocalState | null => {
    const current = localState.read();
    if (current?.incompleteTransition && current.incompleteTransition !== kind) {
        throw new SyncEncryptionTransitionIncompleteError(current.incompleteTransition);
    }
    return current;
};

const beginSyncEncryptionTransition = async (
    localState: SyncEncryptionLocalStatePort,
    kind: SyncEncryptionTransitionKind,
): Promise<void> => {
    const current = requireMatchingIncompleteTransition(localState, kind);
    await localState.write({
        ...(current ?? { state: 'off' as const }),
        incompleteTransition: kind,
    });
};

export const assertNoIncompleteSyncEncryptionTransition = (
    localState: SyncEncryptionLocalStatePort,
): void => {
    const kind = localState.read()?.incompleteTransition;
    if (kind) throw new SyncEncryptionTransitionIncompleteError(kind);
};

/** Secret key cache — OS keyring on desktop (via Tauri commands), expo-secure-store on
 * mobile. Never persist the passphrase itself; only the derived 32-byte key. */
export type SyncEncryptionKeyCachePort = {
    getKey(): Promise<Uint8Array | null>;
    setKey(key: Uint8Array): Promise<void>;
    clearKey(): Promise<void>;
};

export type SyncEncryptionRemoteEntryKind = 'document' | 'attachment';

/** One artifact as it currently exists on the remote, named relative to the sync root
 * (e.g. `data.json`, `data.json.bak`, `attachments/<id>.png`). `kind` decides whether a
 * transition renames it (`document`) or rewrites it in place (`attachment`, per the
 * pinned decision that attachments keep their exact names since `cloudKey` is
 * identity-keyed and immutable-once-uploaded). */
export type SyncEncryptionRemoteEntry = { name: string; kind: SyncEncryptionRemoteEntryKind };

/** Opaque backend generation captured by the same operation that returned `bytes`.
 * WebDAV uses a strong ETag, Dropbox a file rev, and File Sync a content fingerprint.
 * `null` is reserved for a confirmed-missing artifact and therefore means create-only. */
export type SyncEncryptionRemoteRead = {
    bytes: Uint8Array | null;
    version: string | null;
};

/** One coherent remote inventory. Blob adapters derive `entries` from the document bytes in
 * `snapshot`; core then reuses those exact document generations for every later CAS instead
 * of listing from one generation and silently preflighting a newer one. */
export type SyncEncryptionRemoteInventory = {
    entries: SyncEncryptionRemoteEntry[];
    snapshot: ReadonlyMap<string, SyncEncryptionRemoteRead>;
};

/** Raised when a transition observes that another writer changed an artifact after the
 * transition read it. The transition must stop before committing its device-local key/state. */
export class SyncEncryptionRemoteConflictError extends Error {
    constructor(message = 'sync encryption remote artifact changed during transition') {
        super(message);
        this.name = 'SyncEncryptionRemoteConflictError';
    }
}

export const SYNC_ENCRYPTION_REMOTE_VERSION_UNAVAILABLE = 'SYNC_ENCRYPTION_REMOTE_VERSION_UNAVAILABLE';

/** Existing remote bytes without an atomic backend generation cannot be mutated safely.
 * WebDAV reaches this when a server omits ETag or returns only a weak validator. */
export class SyncEncryptionRemoteVersionUnavailableError extends Error {
    constructor(name: string) {
        super(`${SYNC_ENCRYPTION_REMOTE_VERSION_UNAVAILABLE}: ${name} has no safe backend version`);
        this.name = 'SyncEncryptionRemoteVersionUnavailableError';
    }
}

export const isSyncEncryptionRemoteVersionUnavailableError = (error: unknown): boolean => (
    error instanceof SyncEncryptionRemoteVersionUnavailableError
    || (error instanceof Error ? error.message : String(error ?? ''))
        .includes(SYNC_ENCRYPTION_REMOTE_VERSION_UNAVAILABLE)
);

/** Generic remote-blob port for the transition orchestration below. WebDAV and Dropbox
 * each implement this with their existing get/put/list primitives (see webdav.ts /
 * dropbox.ts) — this is the ADR 0014 shared-logic seam: one transition implementation,
 * two thin backend adapters, reused by both desktop and mobile. */
export type SyncEncryptionRemotePort = {
    list(): Promise<SyncEncryptionRemoteEntry[]>;
    /** Blob backends can bind their derived worklist to the document reads that
     * produced it. File backends retain the `list` + `read` fallback because they enumerate
     * the storage provider directly. The passphrase is only for decoding an interrupted
     * transition's authoritative document; it is never persisted by the port. */
    captureInventory?(recoveryPassphrase?: string): Promise<SyncEncryptionRemoteInventory>;
    read(name: string): Promise<SyncEncryptionRemoteRead>;
    /** `null` is create-only; a value replaces only the generation returned by `read`. */
    write(name: string, bytes: Uint8Array, expectedVersion: string | null): Promise<void>;
    /** Only ever called on a plaintext original after its `.enc` counterpart has been
     *  written AND read back and verified — never on speculation. */
    remove(name: string, expectedVersion: string): Promise<void>;
};

export type SyncEncryptionTransitionProgress = { phase: 'attachments' | 'documents'; completed: number; total: number };

/** Thrown by every seam that decrypts remote bytes when the bytes fail the MWENC1
 * auth/format check. Wraps the underlying SyncCryptoAuthError/SyncCryptoUnsupportedError
 * so callers can catch one type and still inspect `cause` for classification (wrong
 * passphrase vs. corrupted/unsupported container) without ever being tempted to treat
 * either as "invalid JSON, try to repair" — that repair affordance must never fire for
 * ciphertext. Bytes that fail this check are left exactly where they are by every seam;
 * nothing here ever rotates a backup or deletes anything on this path. */
export class SyncEncryptionTerminalError extends Error {
    constructor(public readonly cause: SyncCryptoAuthError | SyncCryptoUnsupportedError) {
        super(cause.message);
        this.name = 'SyncEncryptionTerminalError';
    }
}

/**
 * Thrown by a read seam that holds a key, finds no encrypted artifact, and finds a plaintext
 * document in its place — a peer disabled encryption at the sync location. Terminal on
 * purpose: merging would fork the folder into two generations, and following the remote down
 * to plaintext automatically would let anyone with write access to the storage strip
 * encryption from every device. The user disables encryption here (or re-enables it there).
 */
export class SyncEncryptionRemotePlaintextError extends Error {
    constructor(message = 'the sync location is no longer encrypted') {
        super(message);
        this.name = 'SyncEncryptionRemotePlaintextError';
    }
}

/** True when `bytes` are a present, non-empty, non-MWENC1 artifact — i.e. a plaintext sync
 * document sitting where a keyed device expects ciphertext. An empty or whitespace-only file
 * is not evidence of anything and stays "empty remote". */
export function isPlaintextSyncArtifact(bytes: Uint8Array | null | undefined): boolean {
    if (!bytes || bytes.length === 0) return false;
    if (inspectSyncArtifact(bytes).kind !== 'plaintext') return false;
    return bytes.some((byte) => byte > 0x20);
}

/** Decrypt-or-fail-closed: the one function every storage seam should call instead of
 * `decryptSyncArtifact` directly, so every seam raises the same terminal-error class. */
export async function decryptRemoteArtifactOrThrow(
    bytes: Uint8Array,
    key: Uint8Array,
    prims: SyncCryptoPrimitives = defaultSyncCryptoPrimitives,
): Promise<Uint8Array> {
    try {
        return await decryptSyncArtifact(bytes, key, prims);
    } catch (err) {
        if (err instanceof SyncCryptoAuthError || err instanceof SyncCryptoUnsupportedError) {
            throw new SyncEncryptionTerminalError(err);
        }
        throw err;
    }
}

/** The MWENC1 header info when `bytes` are a valid encrypted artifact sealed under a
 * DIFFERENT salt than `material` — proof the caller's key belongs to another encryption
 * generation (a passphrase set before the first sync on a device joining an already-
 * encrypted remote, or a peer's passphrase rotation while this device was offline).
 * Decrypting would only fail as Auth, indistinguishable from a wrong passphrase; the salt
 * comparison is what lets callers route to "enter the passphrase for THIS remote" instead
 * of a dead-end terminal error. Returns `null` for plaintext/unsupported bytes and for the
 * matching-salt case (where an Auth failure really is wrong-passphrase-or-corruption). */
export function detectForeignSaltArtifact(
    bytes: Uint8Array,
    material: SyncKeyMaterial,
): { salt: Uint8Array; params: SyncCryptoKdfParams } | null {
    const inspected = inspectSyncArtifact(bytes);
    if (inspected.kind !== 'encrypted') return null;
    if (inspected.salt.length === material.salt.length
        && inspected.salt.every((byte, index) => byte === material.salt[index])) {
        return null;
    }
    return { salt: inspected.salt, params: inspected.params };
}

/** An artifact whose MWENC1 header is present but unreadable (truncated, a future format
 * version, a cost above the accepted ceiling) is neither plaintext to seal nor ciphertext we
 * can open. Every transition raises this instead of guessing: sealing it would double-wrap a
 * container nothing can recover, and skipping it would silently leave it behind. */
const unsupportedArtifact = (name: string, reason: string): SyncEncryptionTerminalError =>
    new SyncEncryptionTerminalError(new SyncCryptoUnsupportedError(`${name}: ${reason}`));

/** Trial-decrypt used only for resume detection (e.g. "is this artifact already sealed
 * under the new passphrase-change key?"). A wrong-key auth failure means "not yet
 * migrated" — normal during resume. An unsupported/corrupt container is a real problem
 * and must not be swallowed as "not yet migrated". */
async function triesDecrypt(bytes: Uint8Array, key: Uint8Array, prims: SyncCryptoPrimitives): Promise<boolean> {
    try {
        await decryptSyncArtifact(bytes, key, prims);
        return true;
    } catch (err) {
        if (err instanceof SyncCryptoAuthError) return false;
        throw err;
    }
}

const KNOWN_ARTIFACT_SUFFIXES = ['.bak', '.tmp', '.previous'];

/** Peels every trailing known suffix off `name` (repeatedly — `.bak.previous` is two),
 * returning the bare stem plus the peeled suffixes in their ORIGINAL left-to-right order
 * (peeling happens right-to-left, so the collected list is reversed before returning). */
function splitTrailingSuffixChain(name: string): { stem: string; suffixChain: string } {
    let stem = name;
    const peeled: string[] = [];
    for (;;) {
        const matched = KNOWN_ARTIFACT_SUFFIXES.find((suffix) => stem.endsWith(suffix));
        if (!matched) break;
        peeled.push(matched);
        stem = stem.slice(0, -matched.length);
    }
    return { stem, suffixChain: peeled.reverse().join('') };
}

/** `.enc` is inserted immediately after the data-file stem, and the FULL trailing suffix
 * chain is carried verbatim after it: `data.json` -> `data.json.enc`; `data.json.bak` ->
 * `data.json.enc.bak`; `data.json.bak.previous` -> `data.json.enc.bak.previous` (never
 * `data.json.bak.enc.previous` — that name is read by nothing, since recovery/rotation
 * code matches the `.enc` marker right after the stem, not before the last suffix only).
 * Attachments never go through this — they keep their exact name (see
 * SyncEncryptionRemoteEntryKind). */
export function syncEncryptedArtifactName(plainName: string): string {
    const { stem, suffixChain } = splitTrailingSuffixChain(plainName);
    return `${stem}.enc${suffixChain}`;
}

/** Inverse of syncEncryptedArtifactName. Returns the input unchanged if it doesn't
 * actually carry an `.enc` marker (defensive; callers should only pass `.enc` names). */
export function syncPlaintextArtifactName(encName: string): string {
    const { stem, suffixChain } = splitTrailingSuffixChain(encName);
    if (!stem.endsWith('.enc')) return encName;
    return `${stem.slice(0, -4)}${suffixChain}`;
}

function bytesToHex(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i += 1) {
        out += bytes[i].toString(16).padStart(2, '0');
    }
    return out;
}

function hexToBytes(hex: string): Uint8Array {
    const out = new Uint8Array(Math.floor(hex.length / 2));
    for (let i = 0; i < out.length; i += 1) {
        out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

const requireExistingRemoteVersion = (name: string, read: SyncEncryptionRemoteRead): string => {
    if (!read.bytes) throw new SyncEncryptionRemoteConflictError(`${name} disappeared during sync encryption transition`);
    if (!read.version) {
        throw new SyncEncryptionRemoteVersionUnavailableError(name);
    }
    return read.version;
};

/** Capture every listed generation before the first transition write. Blob ports can seed
 * the snapshot with the exact document reads used to derive their attachment worklist; the
 * fallback preserves File Sync's direct-listing contract. Every uncaptured entry is read once,
 * and every captured/read generation becomes the CAS snapshot used by the mutation pass. */
const captureRemoteEntryVersions = async (
    remote: SyncEncryptionRemotePort,
    recoveryPassphrase?: string,
): Promise<{ entries: SyncEncryptionRemoteEntry[]; snapshot: Map<string, SyncEncryptionRemoteRead> }> => {
    const captured = remote.captureInventory
        ? await remote.captureInventory(recoveryPassphrase)
        : { entries: await remote.list(), snapshot: new Map<string, SyncEncryptionRemoteRead>() };
    const { entries } = captured;
    const snapshot = new Map<string, SyncEncryptionRemoteRead>(captured.snapshot);
    for (const entry of entries) {
        const current = snapshot.has(entry.name)
            ? snapshot.get(entry.name)!
            : await remote.read(entry.name);
        if (current.bytes) requireExistingRemoteVersion(entry.name, current);
        snapshot.set(entry.name, current);
    }
    return { entries, snapshot };
};

const snapshotRemoteRead = (
    snapshot: Map<string, SyncEncryptionRemoteRead>,
    name: string,
): SyncEncryptionRemoteRead => snapshot.get(name) ?? { bytes: null, version: null };

const verifyRemoteBytes = async (
    remote: SyncEncryptionRemotePort,
    name: string,
    verify: (bytes: Uint8Array) => Promise<void> | void,
): Promise<SyncEncryptionRemoteRead> => {
    const written = await remote.read(name);
    if (!written.bytes) throw new Error(`sync encryption transition: failed to read back ${name}`);
    if (!written.version) {
        throw new SyncEncryptionRemoteVersionUnavailableError(name);
    }
    await verify(written.bytes);
    return written;
};

/** ASCII space — the byte a non-truncating write pads a shrinking artifact with (see
 * `padBytesForNonTruncatingOverwrite` on mobile and the MWENC1 header comment for the
 * ciphertext-domain equivalent). */
const PLAINTEXT_PAD_BYTE = 0x20;

/** True when `actual` starts with exactly `expected` and everything after that is a clean
 * run of the padding byte. A disable-transition write-back is verified with this instead
 * of raw byte-equality specifically so a non-truncating provider's padded write still
 * verifies — the plaintext-domain analogue of the MWENC1 format's own
 * ignore-trailing-bytes rule. A tail that is present but is NOT clean padding is genuine
 * corruption (e.g. a stale slice of the OLD ciphertext an un-padded write left behind)
 * and must fail here, not be silently accepted (S2: a corrupted attachment that a
 * length-blind byte-equal check, or a later resume pass, would otherwise miss). */
function bytesMatchWithTrailingPadding(actual: Uint8Array, expected: Uint8Array): boolean {
    if (actual.length < expected.length) return false;
    for (let i = 0; i < expected.length; i += 1) {
        if (actual[i] !== expected[i]) return false;
    }
    for (let i = expected.length; i < actual.length; i += 1) {
        if (actual[i] !== PLAINTEXT_PAD_BYTE) return false;
    }
    return true;
}

export function getSyncEncryptionStatusFromLocalState(localState: SyncEncryptionLocalStatePort): SyncEncryptionStatus {
    const persisted = localState.read();
    if (!persisted || persisted.state === 'off') {
        return { state: 'off', incompleteTransition: persisted?.incompleteTransition };
    }
    return {
        state: persisted.state,
        kdfParams: persisted.discoveredParams,
        incompleteTransition: persisted.incompleteTransition,
    };
}

/** Called from a read seam (webdav.ts / dropbox.ts) the moment it discovers ciphertext
 * it has no key for. Persists immediately (per the pinned "state persisted, survives
 * restart" requirement) — this is what makes discovery durable without requiring the
 * user to acknowledge a prompt first. Never overwrites a keyed local state whose salt
 * matches the discovery (a device that already has THIS remote's key does not need to be
 * told it is encrypted) — but a keyed state under a DIFFERENT salt is provably a foreign
 * key (see detectForeignSaltArtifact) and downgrades to `remote-encrypted-no-key`, which
 * is the only state that surfaces the unlock prompt able to re-derive the key from the
 * remote's own salt. */
export function markRemoteEncryptionDiscovered(
    localState: SyncEncryptionLocalStatePort,
    discovered: { salt: Uint8Array; params: SyncCryptoKdfParams },
): void {
    const current = localState.read();
    if (current && SYNC_ENCRYPTION_KEYED_STATES.includes(current.state)
        && current.discoveredSalt === bytesToHex(discovered.salt)) return;
    localState.write({
        state: 'remote-encrypted-no-key',
        discoveredSalt: bytesToHex(discovered.salt),
        discoveredParams: discovered.params,
    });
}

/** The inverse direction of `markRemoteEncryptionDiscovered`, called from a read seam that
 * holds a key and finds the sync location back in plaintext. Only an `enabled` device can
 * reach this state — a device with no key of its own has nothing to fork. Salt and params are
 * carried over deliberately: the key must stay resolvable so the user can run the disable
 * transition, which is the only sanctioned way out. Mirrored by Rust's
 * `mark_remote_plaintext` for the file backend. */
export function markRemotePlaintextDiscovered(localState: SyncEncryptionLocalStatePort): void {
    const current = localState.read();
    if (!current || current.state !== 'enabled') return;
    localState.write({ ...current, state: 'remote-plaintext' });
}

/** declineSyncEncryptionPassphrase(): re-affirms (never clears) the persisted no-key
 * state. A "not now" dismissal in the UI must never re-enable automatic sync against
 * ciphertext this device cannot read — this exists as a stable, documented no-op so
 * phase 3 has something safe to call, not to perform a state change of its own. */
export function reaffirmRemoteEncryptionNoKey(localState: SyncEncryptionLocalStatePort): void {
    const current = localState.read();
    if (!current || current.state !== 'remote-encrypted-no-key') return;
    localState.write(current);
}

export type EnableRemoteEncryptionResult = { salt: Uint8Array; params: SyncCryptoKdfParams };

/**
 * Enable encryption while no sync backend is configured (#1001): there is no remote to
 * convert, so the transition is pure local key material — derive under a fresh salt,
 * cache the key, persist `enabled`. The first sync a later-activated backend runs then
 * writes ciphertext from its first byte, which is the point: a passphrase set before the
 * first sync means plaintext never reaches the server at all.
 *
 * Refuses every state except off: `remote-encrypted-no-key` / `remote-plaintext` describe
 * a KNOWN remote, and enabling blind there would cache a key no artifact ever validated —
 * the unlock flow is the only honest entry from those states. `enabled` cannot re-enable
 * either, so a second passphrase can never silently replace the one an existing remote
 * may already be sealed under.
 */
export async function runEnableSyncEncryptionLocalOnly(
    passphrase: string,
    keyCache: SyncEncryptionKeyCachePort,
    localState: SyncEncryptionLocalStatePort,
    prims: SyncCryptoPrimitives = defaultSyncCryptoPrimitives,
    kdfParams: SyncCryptoKdfParams = SYNC_CRYPTO_DEFAULT_KDF_PARAMS,
): Promise<EnableRemoteEncryptionResult> {
    const current = localState.read();
    if (current?.incompleteTransition) throw new SyncEncryptionTransitionIncompleteError(current.incompleteTransition);
    if (current && current.state !== 'off') {
        throw new Error(`sync encryption local-only enable requires the off state, found ${current.state}`);
    }
    const material = await deriveSyncKeyMaterial(passphrase, prims.randomBytes(16), kdfParams, prims);
    await keyCache.setKey(material.key);
    await localState.write({
        state: 'enabled',
        discoveredSalt: bytesToHex(material.salt),
        discoveredParams: material.params,
    });
    return { salt: material.salt, params: material.params };
}

/**
 * Disable while no sync backend is configured: nothing remote is touched — this only
 * removes the key and state from this device. If a previously used sync location still
 * holds ciphertext, it stays ciphertext and reconnecting rediscovers it (fail closed);
 * the UI copy for this path says exactly that instead of promising a decrypt pass.
 */
export async function runDisableSyncEncryptionLocalOnly(
    keyCache: SyncEncryptionKeyCachePort,
    localState: SyncEncryptionLocalStatePort,
): Promise<void> {
    assertNoIncompleteSyncEncryptionTransition(localState);
    await keyCache.clearKey();
    await localState.write(null);
}

/**
 * Enable encryption over a generic remote (WebDAV or Dropbox). Order: every attachment
 * first, then non-base documents (`.bak`/snapshots), then the base document (`data.json`)
 * last — a reader that finds `data.json.enc` should never find it referencing an
 * attachment or `.bak` that isn't itself already migrated. Each artifact is written,
 * read back, and decrypt-verified before its plaintext original is removed, so a crash
 * mid-run leaves both generations present and a re-run resumes: it re-derives the same
 * key from whichever `.enc` document (if any) already exists, and skips any artifact
 * whose current bytes already decrypt successfully.
 *
 * ponytail: this does not run items in parallel (one artifact at a time) — a single
 * shared HTTP/Dropbox connection with no per-artifact concurrency limit already existed
 * for these backends' attachment sync; add a bounded-concurrency queue if transition
 * time on large attachment sets becomes a real complaint.
 */
export async function runEnableSyncEncryptionOverRemote(
    passphrase: string,
    remote: SyncEncryptionRemotePort,
    keyCache: SyncEncryptionKeyCachePort,
    localState: SyncEncryptionLocalStatePort,
    onProgress?: (progress: SyncEncryptionTransitionProgress) => void,
    prims: SyncCryptoPrimitives = defaultSyncCryptoPrimitives,
    // Writer-side KDF cost for the fresh salt. Readers always honor header params, so this
    // only affects newly written artifacts; tests inject cheap params to stay under timeouts.
    kdfParams: SyncCryptoKdfParams = SYNC_CRYPTO_DEFAULT_KDF_PARAMS,
): Promise<EnableRemoteEncryptionResult> {
    const { entries, snapshot } = await captureRemoteEntryVersions(remote, passphrase);

    // Resume: if a previous partial run already produced an `.enc` document, its header
    // salt/params are authoritative — reuse them so this run doesn't derive a second key
    // under a fresh salt and orphan what the first run wrote.
    let material: SyncKeyMaterial | null = null;
    for (const entry of entries) {
        if (entry.kind !== 'document' || !entry.name.includes('.enc')) continue;
        const { bytes } = snapshotRemoteRead(snapshot, entry.name);
        if (!bytes) continue;
        const inspected = inspectSyncArtifact(bytes);
        if (inspected.kind === 'encrypted') {
            const candidate = await deriveSyncKeyMaterial(passphrase, inspected.salt, inspected.params, prims);
            // The header is not an authentication proof: any passphrase derives a key from
            // its public salt/params. Authenticate the generation that supplied the material
            // before the attachment phase can write anything, or an interrupted-enable retry
            // with a typo could re-encrypt plaintext attachments under an unusable key and
            // fail only when it eventually reaches this document.
            await decryptRemoteArtifactOrThrow(bytes, candidate.key, prims);
            material = candidate;
            break;
        }
    }
    if (!material) {
        const salt = prims.randomBytes(16);
        material = await deriveSyncKeyMaterial(passphrase, salt, kdfParams, prims);
    }

    const isBaseDocument = (name: string) => !KNOWN_ARTIFACT_SUFFIXES.some((s) => name.endsWith(s));
    const attachments = entries.filter((e) => e.kind === 'attachment');
    const documents = entries
        .filter((e) => e.kind === 'document' && !e.name.includes('.enc'))
        .sort((a, b) => Number(isBaseDocument(a.name)) - Number(isBaseDocument(b.name)));

    const total = attachments.length + documents.length;
    let completed = 0;
    const report = (phase: SyncEncryptionTransitionProgress['phase']) => onProgress?.({ phase, completed, total });

    let transitionJournalStarted = false;
    const ensureTransitionJournal = async (): Promise<void> => {
        if (transitionJournalStarted) return;
        await beginSyncEncryptionTransition(localState, 'enable');
        transitionJournalStarted = true;
    };

    // Resume self-heal: attachments never rename, so an attachment already sealed by an
    // earlier, interrupted enable() attempt can exist BEFORE any `.enc` document does —
    // the salt-recovery scan above only looks at documents and would miss it, causing
    // this run to derive a fresh salt and then wrongly treat that attachment as "already
    // migrated" (it decrypts under neither the fresh key nor gets re-keyed). Recovering
    // the abandoned salt from the artifact's OWN header (same passphrase, re-derive)
    // fixes this without costing the common fresh-enable path anything extra — it only
    // triggers when an attachment is already ciphertext under a key that isn't the one
    // this run picked. Cached per salt so a batch of attachments from the same abandoned
    // attempt only pays the Argon2id cost once.
    const recoveredMaterialBySalt = new Map<string, SyncKeyMaterial>();
    const recoverMaterialForSalt = async (salt: Uint8Array, params: SyncCryptoKdfParams): Promise<SyncKeyMaterial> => {
        const cacheKey = bytesToHex(salt);
        const cached = recoveredMaterialBySalt.get(cacheKey);
        if (cached) return cached;
        const recovered = await deriveSyncKeyMaterial(passphrase, salt, params, prims);
        recoveredMaterialBySalt.set(cacheKey, recovered);
        return recovered;
    };

    for (const entry of attachments) {
        report('attachments');
        const current = snapshotRemoteRead(snapshot, entry.name);
        if (current.bytes) {
            const version = requireExistingRemoteVersion(entry.name, current);
            const bytes = current.bytes;
            const inspected = inspectSyncArtifact(bytes);
            if (inspected.kind === 'unsupported') throw unsupportedArtifact(entry.name, inspected.reason);
            if (inspected.kind === 'plaintext') {
                const sealed = await encryptSyncArtifact(bytes, material, prims);
                await ensureTransitionJournal();
                await remote.write(entry.name, sealed, version);
                await verifyRemoteBytes(remote, entry.name, async (verify) => {
                    const plain = await decryptRemoteArtifactOrThrow(verify, material.key, prims);
                    if (!bytesEqual(plain, bytes)) {
                        throw new SyncEncryptionRemoteConflictError(`${entry.name} changed during sync encryption enable verification`);
                    }
                });
            } else if (!(await triesDecrypt(bytes, material.key, prims))) {
                const oldMaterial = await recoverMaterialForSalt(inspected.salt, inspected.params);
                const plain = await decryptRemoteArtifactOrThrow(bytes, oldMaterial.key, prims);
                const sealed = await encryptSyncArtifact(plain, material, prims);
                await ensureTransitionJournal();
                await remote.write(entry.name, sealed, version);
                await verifyRemoteBytes(remote, entry.name, async (verify) => {
                    const verifiedPlain = await decryptRemoteArtifactOrThrow(verify, material.key, prims);
                    if (!bytesEqual(verifiedPlain, plain)) {
                        throw new SyncEncryptionRemoteConflictError(`${entry.name} changed during sync encryption enable verification`);
                    }
                });
            }
        }
        completed += 1;
    }

    for (const entry of documents) {
        report('documents');
        const current = snapshotRemoteRead(snapshot, entry.name);
        if (current.bytes) {
            const sourceVersion = requireExistingRemoteVersion(entry.name, current);
            const bytes = current.bytes;
            const inspected = inspectSyncArtifact(bytes);
            if (inspected.kind === 'unsupported') throw unsupportedArtifact(entry.name, inspected.reason);
            // Ciphertext under a PLAIN name is a peer's in-flight generation, not ours (this
            // function only ever writes to `.enc` names). Leave it exactly where it is rather
            // than double-wrapping it or removing it — same call the Rust file backend makes.
            if (inspected.kind === 'plaintext') {
                const encName = syncEncryptedArtifactName(entry.name);
                const sealed = await encryptSyncArtifact(bytes, material, prims);
                const target = snapshotRemoteRead(snapshot, encName);
                if (target.bytes) {
                    requireExistingRemoteVersion(encName, target);
                    const targetPlain = await decryptRemoteArtifactOrThrow(target.bytes, material.key, prims);
                    if (!bytesEqual(targetPlain, bytes)) {
                        throw new SyncEncryptionRemoteConflictError(`${encName} conflicts with the plaintext generation`);
                    }
                } else {
                    await ensureTransitionJournal();
                    await remote.write(encName, sealed, null);
                    await verifyRemoteBytes(remote, encName, async (verify) => {
                        const verifiedPlain = await decryptRemoteArtifactOrThrow(verify, material.key, prims);
                        if (!bytesEqual(verifiedPlain, bytes)) {
                            throw new SyncEncryptionRemoteConflictError(`${encName} changed during sync encryption enable verification`);
                        }
                    });
                }
                await ensureTransitionJournal();
                await remote.remove(entry.name, sourceVersion);
            }
        }
        completed += 1;
    }

    await keyCache.setKey(material.key);
    await localState.write({
        state: 'enabled',
        discoveredSalt: bytesToHex(material.salt),
        discoveredParams: material.params,
    });
    return { salt: material.salt, params: material.params };
}

/** Disable mirrors enable: same ordering (attachments, then non-base documents, then the
 * base document last), same read-back-and-verify-before-remove discipline, same
 * resumability (an artifact whose current bytes are already plaintext is skipped). */
export async function runDisableSyncEncryptionOverRemote(
    remote: SyncEncryptionRemotePort,
    keyCache: SyncEncryptionKeyCachePort,
    localState: SyncEncryptionLocalStatePort,
    onProgress?: (progress: SyncEncryptionTransitionProgress) => void,
    prims: SyncCryptoPrimitives = defaultSyncCryptoPrimitives,
): Promise<void> {
    const key = await keyCache.getKey();
    if (!key) throw new Error('sync encryption disable requires a cached key');

    const { entries, snapshot } = await captureRemoteEntryVersions(remote);
    const isBaseEncDocument = (name: string) => !KNOWN_ARTIFACT_SUFFIXES.some((s) => name.endsWith(`.enc${s}`));
    const attachments = entries.filter((e) => e.kind === 'attachment');
    const encDocuments = entries
        .filter((e) => e.kind === 'document' && e.name.includes('.enc'))
        .sort((a, b) => Number(isBaseEncDocument(a.name)) - Number(isBaseEncDocument(b.name)));

    const total = attachments.length + encDocuments.length;
    let completed = 0;
    const report = (phase: SyncEncryptionTransitionProgress['phase']) => onProgress?.({ phase, completed, total });

    let transitionJournalStarted = false;
    const ensureTransitionJournal = async (): Promise<void> => {
        if (transitionJournalStarted) return;
        await beginSyncEncryptionTransition(localState, 'disable');
        transitionJournalStarted = true;
    };

    for (const entry of attachments) {
        report('attachments');
        const current = snapshotRemoteRead(snapshot, entry.name);
        if (current.bytes) {
            const version = requireExistingRemoteVersion(entry.name, current);
            const bytes = current.bytes;
            const inspected = inspectSyncArtifact(bytes);
            if (inspected.kind === 'unsupported') throw unsupportedArtifact(entry.name, inspected.reason);
            if (inspected.kind === 'encrypted') {
                const plain = await decryptRemoteArtifactOrThrow(bytes, key, prims);
                await ensureTransitionJournal();
                await remote.write(entry.name, plain, version);
                await verifyRemoteBytes(remote, entry.name, (verify) => {
                    if (!bytesMatchWithTrailingPadding(verify, plain)) {
                        throw new SyncEncryptionRemoteConflictError(`${entry.name} changed during sync encryption disable verification`);
                    }
                });
            }
        }
        // ponytail: an attachment already lacking MWENC1 magic is treated as "already
        // disabled" — correct for anything THIS code wrote (the write above always
        // verifies with bytesMatchWithTrailingPadding before returning, so a completed
        // write is never left with a non-padding tail). A file corrupted some OTHER way
        // (pre-fix legacy state, an exotic provider) has no length reference to validate
        // against here; `validateAttachmentHash` catches it downstream. Add a stored
        // expected-length/hash check here if that ever needs closing.
        completed += 1;
    }

    for (const entry of encDocuments) {
        report('documents');
        const current = snapshotRemoteRead(snapshot, entry.name);
        if (current.bytes) {
            const sourceVersion = requireExistingRemoteVersion(entry.name, current);
            const bytes = current.bytes;
            const plain = await decryptRemoteArtifactOrThrow(bytes, key, prims);
            const plainName = syncPlaintextArtifactName(entry.name);
            const target = snapshotRemoteRead(snapshot, plainName);
            if (target.bytes) {
                requireExistingRemoteVersion(plainName, target);
                if (!bytesMatchWithTrailingPadding(target.bytes, plain)) {
                    throw new SyncEncryptionRemoteConflictError(`${plainName} conflicts with the encrypted generation`);
                }
            } else {
                await ensureTransitionJournal();
                await remote.write(plainName, plain, null);
                await verifyRemoteBytes(remote, plainName, (verify) => {
                    if (!bytesMatchWithTrailingPadding(verify, plain)) {
                        throw new SyncEncryptionRemoteConflictError(`${plainName} changed during sync encryption disable verification`);
                    }
                });
            }
            await ensureTransitionJournal();
            await remote.remove(entry.name, sourceVersion);
        }
        completed += 1;
    }

    await keyCache.clearKey();
    await localState.write(null);
}

/** Passphrase change: decrypt-with-old, re-encrypt-with-new, under a fresh salt, over
 * the same total artifact set. Resumable the same way as enable/disable: an artifact
 * that already trial-decrypts under the NEW key is treated as already migrated. */
export async function runChangeSyncEncryptionPassphraseOverRemote(
    currentPassphrase: string,
    nextPassphrase: string,
    remote: SyncEncryptionRemotePort,
    keyCache: SyncEncryptionKeyCachePort,
    localState: SyncEncryptionLocalStatePort,
    onProgress?: (progress: SyncEncryptionTransitionProgress) => void,
    prims: SyncCryptoPrimitives = defaultSyncCryptoPrimitives,
    // Same writer-side-only knob as runEnableSyncEncryptionOverRemote.
    kdfParams: SyncCryptoKdfParams = SYNC_CRYPTO_DEFAULT_KDF_PARAMS,
): Promise<void> {
    const oldKey = await keyCache.getKey();
    if (!oldKey) throw new Error('sync encryption passphrase change requires a cached key');
    // Verify `currentPassphrase` actually derives the cached key rather than trusting it
    // blindly — otherwise a typo'd "current" passphrase would silently proceed (the
    // cache doesn't care what string produced it) and report success while the caller
    // believes they confirmed their old passphrase.
    const persisted = localState.read();
    if (persisted?.discoveredSalt && persisted.discoveredParams) {
        const claimedOldMaterial = await deriveSyncKeyMaterial(
            currentPassphrase,
            hexToBytes(persisted.discoveredSalt),
            persisted.discoveredParams,
            prims,
        );
        if (!bytesEqual(claimedOldMaterial.key, oldKey)) {
            throw new Error('sync encryption passphrase change: current passphrase does not match');
        }
    }

    const isBaseEncDocument = (name: string) => !KNOWN_ARTIFACT_SUFFIXES.some((s) => name.endsWith(`.enc${s}`));
    const { entries, snapshot } = await captureRemoteEntryVersions(remote, nextPassphrase);
    const attachments = entries.filter((e) => e.kind === 'attachment');
    const encDocuments = entries
        .filter((e) => e.kind === 'document' && e.name.includes('.enc'))
        .sort((a, b) => Number(isBaseEncDocument(a.name)) - Number(isBaseEncDocument(b.name)));

    const newSalt = prims.randomBytes(16);
    const newMaterial = await deriveSyncKeyMaterial(nextPassphrase, newSalt, kdfParams, prims);

    const total = attachments.length + encDocuments.length;
    let completed = 0;
    const report = (phase: SyncEncryptionTransitionProgress['phase']) => onProgress?.({ phase, completed, total });

    let transitionJournalStarted = false;
    const ensureTransitionJournal = async (): Promise<void> => {
        if (transitionJournalStarted) return;
        await beginSyncEncryptionTransition(localState, 'change-passphrase');
        transitionJournalStarted = true;
    };

    // Resume self-heal, same reasoning as runEnableSyncEncryptionOverRemote's attachment
    // loop: an artifact left over from an earlier, interrupted passphrase-change attempt
    // decrypts under neither `oldKey` nor this run's `newMaterial.key`. That abandoned
    // intermediate salt was derived from `nextPassphrase` (a passphrase change always
    // re-derives from the NEW passphrase, never the old one) — recover it from the
    // artifact's own header using the same `nextPassphrase` this call was given.
    const recoveredMaterialBySalt = new Map<string, SyncKeyMaterial>();
    const recoverMaterialForSalt = async (salt: Uint8Array, params: SyncCryptoKdfParams): Promise<SyncKeyMaterial> => {
        const cacheKey = bytesToHex(salt);
        const cached = recoveredMaterialBySalt.get(cacheKey);
        if (cached) return cached;
        const recovered = await deriveSyncKeyMaterial(nextPassphrase, salt, params, prims);
        recoveredMaterialBySalt.set(cacheKey, recovered);
        return recovered;
    };

    const rewrap = async (name: string): Promise<void> => {
        const current = snapshotRemoteRead(snapshot, name);
        if (!current.bytes) return;
        const version = requireExistingRemoteVersion(name, current);
        const bytes = current.bytes;
        if (await triesDecrypt(bytes, newMaterial.key, prims)) return; // already migrated (resume)
        let plain: Uint8Array;
        if (await triesDecrypt(bytes, oldKey, prims)) {
            plain = await decryptRemoteArtifactOrThrow(bytes, oldKey, prims);
        } else {
            const inspected = inspectSyncArtifact(bytes);
            if (inspected.kind !== 'encrypted') {
                throw new SyncEncryptionTerminalError(new SyncCryptoUnsupportedError(`${name} is not a valid MWENC1 container`));
            }
            const recoveredMaterial = await recoverMaterialForSalt(inspected.salt, inspected.params);
            plain = await decryptRemoteArtifactOrThrow(bytes, recoveredMaterial.key, prims);
        }
        const sealed = await encryptSyncArtifact(plain, newMaterial, prims);
        await ensureTransitionJournal();
        await remote.write(name, sealed, version);
        await verifyRemoteBytes(remote, name, async (verify) => {
            const verifiedPlain = await decryptRemoteArtifactOrThrow(verify, newMaterial.key, prims);
            if (!bytesEqual(verifiedPlain, plain)) {
                throw new SyncEncryptionRemoteConflictError(`${name} changed during sync encryption passphrase verification`);
            }
        });
    };

    for (const entry of attachments) {
        report('attachments');
        await rewrap(entry.name);
        completed += 1;
    }
    for (const entry of encDocuments) {
        report('documents');
        await rewrap(entry.name);
        completed += 1;
    }

    await keyCache.setKey(newMaterial.key);
    await localState.write({
        state: 'enabled',
        discoveredSalt: bytesToHex(newMaterial.salt),
        discoveredParams: newMaterial.params,
    });
}

/** Validates a passphrase against the remote's current `.enc` base document (never
 * mutates the remote either way) and, on success, caches the key and clears the no-key
 * state. `baseDocumentPlainName` is the un-suffixed document name (e.g. `data.json`) —
 * the caller doesn't need to know the `.enc` name itself. */
export async function runProvideSyncEncryptionPassphraseOverRemote(
    passphrase: string,
    baseDocumentPlainName: string,
    remote: SyncEncryptionRemotePort,
    keyCache: SyncEncryptionKeyCachePort,
    localState: SyncEncryptionLocalStatePort,
    prims: SyncCryptoPrimitives = defaultSyncCryptoPrimitives,
): Promise<'ok' | 'wrong-passphrase'> {
    assertNoIncompleteSyncEncryptionTransition(localState);
    const encName = syncEncryptedArtifactName(baseDocumentPlainName);
    const { bytes } = await remote.read(encName);
    if (!bytes) {
        throw new Error(`sync encryption: no encrypted remote artifact found at ${encName}`);
    }
    const inspected = inspectSyncArtifact(bytes);
    if (inspected.kind !== 'encrypted') {
        throw new SyncEncryptionTerminalError(
            inspected.kind === 'unsupported'
                ? new SyncCryptoUnsupportedError(inspected.reason)
                : new SyncCryptoUnsupportedError(`${encName} is not a valid MWENC1 container`),
        );
    }
    const material = await deriveSyncKeyMaterial(passphrase, inspected.salt, inspected.params, prims);
    try {
        await decryptSyncArtifact(bytes, material.key, prims);
    } catch (err) {
        if (err instanceof SyncCryptoAuthError) return 'wrong-passphrase';
        throw err;
    }
    await keyCache.setKey(material.key);
    await localState.write({
        state: 'enabled',
        discoveredSalt: bytesToHex(material.salt),
        discoveredParams: material.params,
    });
    return 'ok';
}

export const __syncEncryptionTestUtils = { bytesToHex, hexToBytes, bytesEqual };
