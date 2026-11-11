


import {
    SYNC_CRYPTO_DEFAULT_KDF_PARAMS,
    SyncCryptoAuthError,
    SyncCryptoUnsupportedError,
    decryptSyncArtifact,
    decryptLegacySyncArtifactForUpgrade,
    defaultSyncCryptoPrimitives,
    deriveSyncKeyMaterial,
    encryptedSyncArtifactByteLength,
    encryptSyncArtifact,
    inspectSyncArtifact,
    type SyncCryptoKdfParams,
    type SyncCryptoPrimitives,
    type SyncKeyMaterial,
    type SyncArtifactContext,
} from './sync-crypto';
import { normalizeCloudUrl, normalizeWebdavUrl } from './sync-helpers';
import { computeSha256Hex, isSha256Hex } from './attachment-hash';
import { areRemoteSyncDocumentsEqual, parseSyncDocument, toRemoteSyncDocument } from './sync-document';
import type { AppData } from './types';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';


export type SyncEncryptionState = 'off' | 'enabled' | 'remote-encrypted-no-key' | 'remote-plaintext';
export type SyncEncryptionTransitionKind = 'enable' | 'disable' | 'change-passphrase' | 'upgrade';


export const SYNC_ENCRYPTION_KEYED_STATES: readonly SyncEncryptionState[] = ['enabled', 'remote-plaintext'];

export type SyncEncryptionStatus = {
    state: SyncEncryptionState;
    kdfParams?: SyncCryptoKdfParams;
    incompleteTransition?: SyncEncryptionTransitionKind;


    partlyEncrypted?: boolean;
};


export type SyncEncryptionLocalState = {
    state: SyncEncryptionState;
    discoveredSalt?: string;
    discoveredParams?: SyncCryptoKdfParams;


    discoveredScope?: string;
    incompleteTransition?: SyncEncryptionTransitionKind;


    partlyEncryptedScope?: string;
};


export type SyncLocationScopeInput = {
    backend?: string | null;
    webdavUrl?: string | null;
    webdavUsername?: string | null;
    cloudProvider?: string | null;
    cloudUrl?: string | null;
    syncPath?: string | null;
};

const scopeValue = (value: string | null | undefined): string | null => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
};

export const buildSyncLocationScope = (input: SyncLocationScopeInput): string => {
    const backend = scopeValue(input.backend) ?? 'off';
    if (backend === 'file') return JSON.stringify(['file', scopeValue(input.syncPath)]);
    if (backend === 'webdav') {
        const url = scopeValue(input.webdavUrl);
        return JSON.stringify([
            'webdav',
            url ? normalizeWebdavUrl(url) : null,
            scopeValue(input.webdavUsername),
        ]);
    }
    if (backend === 'cloud') {
        const provider = scopeValue(input.cloudProvider) ?? 'selfhosted';


        if (provider === 'dropbox') return JSON.stringify(['cloud', 'dropbox']);
        const url = scopeValue(input.cloudUrl);
        return JSON.stringify(['cloud', provider, url ? normalizeCloudUrl(url) : null]);
    }
    return JSON.stringify([backend]);
};


export const isSyncEncryptionStateBlocked = (
    state: SyncEncryptionLocalState | null | undefined,
    activeScope: string | null,
): boolean => {
    if (!state) return false;
    if (state.incompleteTransition) return true;
    if (state.partlyEncryptedScope && (activeScope === null || state.partlyEncryptedScope === activeScope)) return true;
    if (state.state !== 'remote-encrypted-no-key' && state.state !== 'remote-plaintext') return false;
    if (!state.discoveredScope) return false;
    if (activeScope === null) return true;
    return state.discoveredScope === activeScope;
};

export type SyncEncryptionLocalStatePort = {
    read(): SyncEncryptionLocalState | null;

    write(state: SyncEncryptionLocalState | null): void | Promise<void>;
};

export const SYNC_ENCRYPTION_PARTLY_ENCRYPTED = 'SYNC_ENCRYPTION_PARTLY_ENCRYPTED';


export const compareSyncTransitionEntryNames = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);


export class SyncEncryptionPartlyEncryptedError extends Error {
    constructor() {
        super(`${SYNC_ENCRYPTION_PARTLY_ENCRYPTED}: This sync location is partly encrypted. Sync stays paused here so plain files never land beside encrypted ones. Finish or undo the encryption change from a device that can reach it.`);
        this.name = 'SyncEncryptionPartlyEncryptedError';
    }
}

export const isSyncEncryptionPartlyEncryptedError = (error: unknown): boolean => (
    error instanceof SyncEncryptionPartlyEncryptedError
    || (error instanceof Error ? error.message : String(error ?? '')).includes(SYNC_ENCRYPTION_PARTLY_ENCRYPTED)
);

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


export type SyncEncryptionKeyCachePort = {
    getKey(): Promise<Uint8Array | null>;
    setKey(key: Uint8Array): Promise<void>;
    clearKey(): Promise<void>;
};

export type SyncEncryptionRemoteEntryKind = 'document' | 'attachment';


export type SyncEncryptionRemoteEntry = { name: string; kind: SyncEncryptionRemoteEntryKind; originalName?: string };

const entryContext = (entry: SyncEncryptionRemoteEntry): SyncArtifactContext => entry.kind === 'document'
    ? { kind: 'document' } : entry.name.startsWith('attachments/') && !entry.originalName
        ? { kind: 'attachment', cloudKey: entry.name }
        : { kind: 'recovery', artifactName: entry.originalName ?? entry.name };


export type SyncEncryptionRemoteRead = {
    bytes: Uint8Array | null;
    version: string | null;
};


export type SyncEncryptionRemoteInventory = {
    entries: SyncEncryptionRemoteEntry[];
    snapshot: ReadonlyMap<string, SyncEncryptionRemoteRead>;
};


export class SyncEncryptionRemoteConflictError extends Error {
    constructor(message = 'sync encryption remote artifact changed during transition') {
        super(message);
        this.name = 'SyncEncryptionRemoteConflictError';
    }
}


export class SyncEncryptionArtifactCapacityError extends Error {
    constructor() {
        super('SYNC_ENCRYPTION_ARTIFACT_CAPACITY: encrypted artifact exceeds host capacity');
        this.name = 'SyncEncryptionArtifactCapacityError';
    }
}

export const SYNC_ENCRYPTION_REMOTE_VERSION_UNAVAILABLE = 'SYNC_ENCRYPTION_REMOTE_VERSION_UNAVAILABLE';


export class SyncEncryptionRemoteVersionUnavailableError extends Error {
    constructor(name: string) {
        super(`${SYNC_ENCRYPTION_REMOTE_VERSION_UNAVAILABLE}: ${name} has no safe backend version`);
        this.name = 'SyncEncryptionRemoteVersionUnavailableError';
    }
}

export const SYNC_ENCRYPTION_BACKEND_INCOMPATIBLE = 'SYNC_ENCRYPTION_BACKEND_INCOMPATIBLE';


export class SyncEncryptionBackendIncompatibleError extends SyncEncryptionRemoteVersionUnavailableError {
    constructor(cause: SyncEncryptionRemoteVersionUnavailableError) {
        super('');
        this.message = `${SYNC_ENCRYPTION_BACKEND_INCOMPATIBLE}: ${cause.message}`;
        this.name = 'SyncEncryptionBackendIncompatibleError';
    }
}

export const isSyncEncryptionRemoteVersionUnavailableError = (error: unknown): boolean => (
    error instanceof SyncEncryptionRemoteVersionUnavailableError
    || (error instanceof Error ? error.message : String(error ?? ''))
        .includes(SYNC_ENCRYPTION_REMOTE_VERSION_UNAVAILABLE)
);


export type SyncEncryptionRemotePort = {

    maxEncryptedArtifactBytes?: number;
    list(): Promise<SyncEncryptionRemoteEntry[]>;


    captureInventory?(recoveryPassphrase?: string): Promise<SyncEncryptionRemoteInventory>;
    read(name: string): Promise<SyncEncryptionRemoteRead>;


    write(name: string, bytes: Uint8Array, expectedVersion: string | null): Promise<SyncEncryptionRemoteRead | void>;


    remove(name: string, expectedVersion: string): Promise<void>;


    readHead?(name: string): Promise<Uint8Array | null>;
};

export type SyncEncryptionTransitionProgress = { phase: 'attachments' | 'documents'; completed: number; total: number };


export class SyncEncryptionTerminalError extends Error {
    constructor(public readonly cause: SyncCryptoAuthError | SyncCryptoUnsupportedError) {
        super(cause.message);
        this.name = 'SyncEncryptionTerminalError';
    }
}


export class SyncEncryptionRemotePlaintextError extends Error {
    constructor(message = 'the sync location is no longer encrypted') {
        super(message);
        this.name = 'SyncEncryptionRemotePlaintextError';
    }
}

export const assertSyncAttachmentEncryptionPosture = (status: SyncEncryptionStatus, material: SyncKeyMaterial | null | undefined): void => {
    if (status.incompleteTransition) throw new SyncEncryptionTransitionIncompleteError(status.incompleteTransition);
    if (status.partlyEncrypted) throw new SyncEncryptionPartlyEncryptedError();
    if (status.state === 'off' && !status.partlyEncrypted && !material) return;
    if (SYNC_ENCRYPTION_KEYED_STATES.includes(status.state) && material) return;
    throw new SyncEncryptionTerminalError(new SyncCryptoUnsupportedError('SYNC_ENCRYPTION_ATTACHMENT_POSTURE: attachment encryption is locked, unavailable or changed'));
};


export function isPlaintextSyncArtifact(bytes: Uint8Array | null | undefined): boolean {
    if (!bytes || bytes.length === 0) return false;
    if (inspectSyncArtifact(bytes).kind !== 'plaintext') return false;
    return bytes.some((byte) => byte > 0x20);
}


export async function decryptRemoteArtifactOrThrow(
    bytes: Uint8Array,
    key: Uint8Array,
    prims: SyncCryptoPrimitives = defaultSyncCryptoPrimitives,
    context: SyncArtifactContext,
): Promise<Uint8Array> {
    try {
        return await decryptSyncArtifact(bytes, key, prims, context);
    } catch (err) {
        if (err instanceof SyncCryptoAuthError || err instanceof SyncCryptoUnsupportedError) {
            throw new SyncEncryptionTerminalError(err);
        }
        throw err;
    }
}


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


const unsupportedArtifact = (name: string, reason: string): SyncEncryptionTerminalError =>
    new SyncEncryptionTerminalError(new SyncCryptoUnsupportedError(`${name}: ${reason}`));


async function triesDecrypt(bytes: Uint8Array, key: Uint8Array, prims: SyncCryptoPrimitives, context: SyncArtifactContext): Promise<boolean> {
    try {
        await decryptSyncArtifact(bytes, key, prims, context);
        return true;
    } catch (err) {
        if (err instanceof SyncCryptoAuthError) return false;
        throw err;
    }
}

const KNOWN_ARTIFACT_SUFFIXES = ['.bak', '.tmp', '.previous'];


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


export function syncEncryptedArtifactName(plainName: string): string {
    const { stem, suffixChain } = splitTrailingSuffixChain(plainName);
    return `${stem}.enc${suffixChain}`;
}


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


const writeVerifiedRemoteBytes = async (
    remote: SyncEncryptionRemotePort,
    name: string,
    bytes: Uint8Array,
    expectedVersion: string | null,
    verify: (bytes: Uint8Array) => Promise<void> | void,
): Promise<SyncEncryptionRemoteRead> => {
    const answered = await remote.write(name, bytes, expectedVersion);
    const written = answered ?? await remote.read(name);
    if (!written.bytes) throw new Error(`sync encryption transition: failed to read back ${name}`);
    if (!written.version) {
        throw new SyncEncryptionRemoteVersionUnavailableError(name);
    }
    await verify(written.bytes);
    return written;
};

const remoteReadsEqual = (left: SyncEncryptionRemoteRead, right: SyncEncryptionRemoteRead): boolean => (
    left.version === right.version
    && (left.bytes === null
        ? right.bytes === null
        : right.bytes !== null && bytesEqual(left.bytes, right.bytes))
);


const revalidateRemoteInventory = async (
    remote: SyncEncryptionRemotePort,
    expected: Map<string, SyncEncryptionRemoteRead>,
    expectedKinds: Map<string, SyncEncryptionRemoteEntryKind>,
    documentPosture: 'encrypted' | 'plaintext',
): Promise<void> => {
    for (const [name, kind] of expectedKinds) {
        const expectedRead = snapshotRemoteRead(expected, name);
        if (kind !== 'document' || !expectedRead.bytes) continue;
        const encryptedName = name.includes('.enc');
        if ((documentPosture === 'encrypted') !== encryptedName) {
            throw new SyncEncryptionRemoteConflictError(
                `${name} violates the ${documentPosture} sync encryption document posture`,
            );
        }
    }

    const currentEntries = await remote.list();
    const currentReads = new Map<string, SyncEncryptionRemoteRead>();
    for (const entry of currentEntries) {
        const current = await remote.read(entry.name);
        currentReads.set(entry.name, current);
        if (!expected.has(entry.name) && current.bytes) {
            throw new SyncEncryptionRemoteConflictError(
                `${entry.name} appeared during sync encryption transition`,
            );
        }
        const expectedKind = expectedKinds.get(entry.name);
        if (current.bytes && expectedKind && expectedKind !== entry.kind) {
            throw new SyncEncryptionRemoteConflictError(
                `${entry.name} changed kind during sync encryption transition`,
            );
        }
    }

    for (const name of expected.keys()) {
        const before = snapshotRemoteRead(expected, name);
        const current = currentReads.get(name) ?? await remote.read(name);
        if (!remoteReadsEqual(before, current)) {
            throw new SyncEncryptionRemoteConflictError(`${name} changed before sync encryption state commit`);
        }
    }
};


const PLAINTEXT_PAD_BYTE = 0x20;


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


export function markRemoteEncryptionDiscovered(
    localState: SyncEncryptionLocalStatePort,
    discovered: { salt: Uint8Array; params: SyncCryptoKdfParams },


    scope?: string | null,
): void {
    const current = localState.read();
    if (current && SYNC_ENCRYPTION_KEYED_STATES.includes(current.state)
        && current.discoveredSalt === bytesToHex(discovered.salt)) return;
    localState.write({
        state: 'remote-encrypted-no-key',
        discoveredSalt: bytesToHex(discovered.salt),
        discoveredParams: discovered.params,
        ...(scope ? { discoveredScope: scope } : {}),
    });
}


export function markRemotePlaintextDiscovered(
    localState: SyncEncryptionLocalStatePort,
    scope?: string | null,
): void {
    const current = localState.read();
    if (!current || current.state !== 'enabled') return;
    localState.write({
        ...current,
        state: 'remote-plaintext',
        ...(scope ? { discoveredScope: scope } : {}),
    });
}


export async function restoreVerifiedRemoteEncryption(
    localState: SyncEncryptionLocalStatePort,
    material: SyncKeyMaterial,
    scope: string | null | undefined,
): Promise<boolean> {
    const current = localState.read();
    if (!current || current.state !== 'remote-plaintext' || current.incompleteTransition
        || !scope || current.discoveredScope !== scope
        || current.discoveredSalt !== bytesToHex(material.salt)
        || current.discoveredParams?.mKib !== material.params.mKib
        || current.discoveredParams?.t !== material.params.t
        || current.discoveredParams?.p !== material.params.p) return false;
    await localState.write({ ...current, state: 'enabled' });
    return true;
}


export function reaffirmRemoteEncryptionNoKey(localState: SyncEncryptionLocalStatePort): void {
    const current = localState.read();
    if (!current || current.state !== 'remote-encrypted-no-key') return;
    localState.write(current);
}

export type EnableRemoteEncryptionResult = { salt: Uint8Array; params: SyncCryptoKdfParams };


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


export async function runDisableSyncEncryptionLocalOnly(
    keyCache: SyncEncryptionKeyCachePort,
    localState: SyncEncryptionLocalStatePort,
): Promise<void> {
    assertNoIncompleteSyncEncryptionTransition(localState);
    await localState.write(null);
    await keyCache.clearKey();
}


export async function runAbandonSyncEncryptionTransition(
    keyCache: SyncEncryptionKeyCachePort,
    localState: SyncEncryptionLocalStatePort,
    activeScope: string | null,
): Promise<SyncEncryptionTransitionKind | null> {
    const abandoned = localState.read()?.incompleteTransition ?? null;
    if (!abandoned) return null;
    await localState.write(activeScope ? { state: 'off', partlyEncryptedScope: activeScope } : null);
    await keyCache.clearKey();
    return abandoned;
}


export async function runEnableSyncEncryptionOverRemote(
    passphrase: string,
    remote: SyncEncryptionRemotePort,
    keyCache: SyncEncryptionKeyCachePort,
    localState: SyncEncryptionLocalStatePort,
    onProgress?: (progress: SyncEncryptionTransitionProgress) => void,
    prims: SyncCryptoPrimitives = defaultSyncCryptoPrimitives,


    kdfParams: SyncCryptoKdfParams = SYNC_CRYPTO_DEFAULT_KDF_PARAMS,
): Promise<EnableRemoteEncryptionResult> {
    const maxEncryptedArtifactBytes = remote.maxEncryptedArtifactBytes;
    if (maxEncryptedArtifactBytes !== undefined
        && (!Number.isSafeInteger(maxEncryptedArtifactBytes) || maxEncryptedArtifactBytes <= 0)) {
        throw new RangeError('maxEncryptedArtifactBytes must be a positive safe integer');
    }
    const { entries, snapshot } = await captureRemoteEntryVersions(remote, passphrase);


    const recoveredMaterialBySalt = new Map<string, SyncKeyMaterial>();
    const plaintextLengths = new Map<string, number>();
    const recoverMaterialForSalt = async (salt: Uint8Array, params: SyncCryptoKdfParams): Promise<SyncKeyMaterial> => {
        const cacheKey = bytesToHex(salt);
        const cached = recoveredMaterialBySalt.get(cacheKey);
        if (cached) return cached;
        const recovered = await deriveSyncKeyMaterial(passphrase, salt, params, prims);
        recoveredMaterialBySalt.set(cacheKey, recovered);
        return recovered;
    };


    const isBaseEncryptedDocument = (name: string) =>
        !KNOWN_ARTIFACT_SUFFIXES.some((suffix) => name.endsWith(`.enc${suffix}`));
    let baseDocumentMaterial: SyncKeyMaterial | null = null;
    let documentMaterial: SyncKeyMaterial | null = null;
    let attachmentMaterial: SyncKeyMaterial | null = null;
    for (const entry of entries) {
        const { bytes } = snapshotRemoteRead(snapshot, entry.name);
        if (!bytes) continue;
        const inspected = inspectSyncArtifact(bytes);
        if (inspected.kind === 'unsupported') throw unsupportedArtifact(entry.name, inspected.reason);
        if (entry.kind === 'document' && entry.name.includes('.enc') && inspected.kind !== 'encrypted') {
            throw new SyncEncryptionTerminalError(
                new SyncCryptoUnsupportedError(`${entry.name} is not a valid MWENC1 container`),
            );
        }
        if (inspected.kind !== 'encrypted') {
            plaintextLengths.set(entry.name, bytes.length);
            continue;
        }
        const candidate = await recoverMaterialForSalt(inspected.salt, inspected.params);
        const plaintext = await decryptRemoteArtifactOrThrow(bytes, candidate.key, prims, entryContext(entry));
        plaintextLengths.set(entry.name, plaintext.length);
        if (!attachmentMaterial && entry.kind === 'attachment') attachmentMaterial = candidate;
        if (entry.kind === 'document' && entry.name.includes('.enc')) {
            documentMaterial ??= candidate;
            if (isBaseEncryptedDocument(entry.name)) baseDocumentMaterial ??= candidate;
        }
    }
    let material = baseDocumentMaterial ?? documentMaterial ?? attachmentMaterial;
    if (!material) {
        const salt = prims.randomBytes(16);
        material = await deriveSyncKeyMaterial(passphrase, salt, kdfParams, prims);
    }


    if (maxEncryptedArtifactBytes !== undefined) {
        for (const entry of entries) {
            const plaintextLength = plaintextLengths.get(entry.name);
            if (plaintextLength === undefined) continue;
            const bytes = snapshotRemoteRead(snapshot, entry.name).bytes!;
            const inspected = inspectSyncArtifact(bytes);


            if (inspected.kind === 'encrypted'
                && (entry.kind === 'document' && !entry.name.includes('.enc')
                    || await triesDecrypt(bytes, material.key, prims, entryContext(entry)))) continue;
            if (encryptedSyncArtifactByteLength(plaintextLength) > maxEncryptedArtifactBytes) {
                throw new SyncEncryptionArtifactCapacityError();
            }
        }
    }

    const isBaseDocument = (name: string) => !KNOWN_ARTIFACT_SUFFIXES.some((s) => name.endsWith(s));
    const attachments = entries.filter((e) => e.kind === 'attachment');
    const encryptedDocuments = entries
        .filter((entry) => entry.kind === 'document' && entry.name.includes('.enc'))
        .sort((a, b) => Number(isBaseEncryptedDocument(a.name)) - Number(isBaseEncryptedDocument(b.name)));
    const documents = entries
        .filter((e) => e.kind === 'document' && !e.name.includes('.enc'))
        .sort((a, b) => Number(isBaseDocument(a.name)) - Number(isBaseDocument(b.name)));
    const expectedKinds = new Map(entries.map((entry) => [entry.name, entry.kind] as const));

    const total = attachments.length + encryptedDocuments.length + documents.length;
    let completed = 0;
    const report = (phase: SyncEncryptionTransitionProgress['phase']) => onProgress?.({ phase, completed, total });

    let transitionJournalStarted = false;
    const ensureTransitionJournal = async (): Promise<void> => {
        if (transitionJournalStarted) return;
        await beginSyncEncryptionTransition(localState, 'enable');
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
            if (inspected.kind === 'plaintext') {
                const sealed = await encryptSyncArtifact(bytes, material, prims, entryContext(entry));
                await ensureTransitionJournal();
                const verified = await writeVerifiedRemoteBytes(remote, entry.name, sealed, version, async (verify) => {
                    const plain = await decryptRemoteArtifactOrThrow(verify, material.key, prims, entryContext(entry));
                    if (!bytesEqual(plain, bytes)) {
                        throw new SyncEncryptionRemoteConflictError(`${entry.name} changed during sync encryption enable verification`);
                    }
                });
                snapshot.set(entry.name, verified);
            } else if (!(await triesDecrypt(bytes, material.key, prims, entryContext(entry)))) {
                const oldMaterial = await recoverMaterialForSalt(inspected.salt, inspected.params);
                const plain = await decryptRemoteArtifactOrThrow(bytes, oldMaterial.key, prims, entryContext(entry));
                const sealed = await encryptSyncArtifact(plain, material, prims, entryContext(entry));
                await ensureTransitionJournal();
                const verified = await writeVerifiedRemoteBytes(remote, entry.name, sealed, version, async (verify) => {
                    const verifiedPlain = await decryptRemoteArtifactOrThrow(verify, material.key, prims, entryContext(entry));
                    if (!bytesEqual(verifiedPlain, plain)) {
                        throw new SyncEncryptionRemoteConflictError(`${entry.name} changed during sync encryption enable verification`);
                    }
                });
                snapshot.set(entry.name, verified);
            }
        }
        completed += 1;
    }


    for (const entry of encryptedDocuments) {
        report('documents');
        const current = snapshotRemoteRead(snapshot, entry.name);
        if (current.bytes && !(await triesDecrypt(current.bytes, material.key, prims, entryContext(entry)))) {
            const version = requireExistingRemoteVersion(entry.name, current);
            const inspected = inspectSyncArtifact(current.bytes);
            if (inspected.kind !== 'encrypted') {
                throw new SyncEncryptionTerminalError(
                    new SyncCryptoUnsupportedError(`${entry.name} is not a valid MWENC1 container`),
                );
            }
            const oldMaterial = await recoverMaterialForSalt(inspected.salt, inspected.params);
            const plain = await decryptRemoteArtifactOrThrow(current.bytes, oldMaterial.key, prims, entryContext(entry));
            const sealed = await encryptSyncArtifact(plain, material, prims, entryContext(entry));
            await ensureTransitionJournal();
            const verified = await writeVerifiedRemoteBytes(remote, entry.name, sealed, version, async (verify) => {
                const verifiedPlain = await decryptRemoteArtifactOrThrow(verify, material.key, prims, entryContext(entry));
                if (!bytesEqual(verifiedPlain, plain)) {
                    throw new SyncEncryptionRemoteConflictError(
                        `${entry.name} changed during sync encryption enable convergence`,
                    );
                }
            });
            snapshot.set(entry.name, verified);
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


            if (inspected.kind === 'plaintext') {
                const encName = syncEncryptedArtifactName(entry.name);
                const sealed = await encryptSyncArtifact(bytes, material, prims, entryContext(entry));
                const target = snapshotRemoteRead(snapshot, encName);
                if (target.bytes) {
                    requireExistingRemoteVersion(encName, target);
                    const targetPlain = await decryptRemoteArtifactOrThrow(target.bytes, material.key, prims, entryContext(entry));
                    if (!bytesEqual(targetPlain, bytes)) {
                        throw new SyncEncryptionRemoteConflictError(`${encName} conflicts with the plaintext generation`);
                    }
                } else {
                    await ensureTransitionJournal();
                    const verified = await writeVerifiedRemoteBytes(remote, encName, sealed, null, async (verify) => {
                        const verifiedPlain = await decryptRemoteArtifactOrThrow(verify, material.key, prims, entryContext(entry));
                        if (!bytesEqual(verifiedPlain, bytes)) {
                            throw new SyncEncryptionRemoteConflictError(`${encName} changed during sync encryption enable verification`);
                        }
                    });
                    snapshot.set(encName, verified);
                    expectedKinds.set(encName, 'document');
                }
                await ensureTransitionJournal();
                await remote.remove(entry.name, sourceVersion);
                snapshot.set(entry.name, { bytes: null, version: null });
            }
        }
        completed += 1;
    }

    await revalidateRemoteInventory(remote, snapshot, expectedKinds, 'encrypted');
    await keyCache.setKey(material.key);
    await localState.write({
        state: 'enabled',
        discoveredSalt: bytesToHex(material.salt),
        discoveredParams: material.params,
    });
    return { salt: material.salt, params: material.params };
}


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
    const expectedKinds = new Map(entries.map((entry) => [entry.name, entry.kind] as const));


    const plaintextByName = new Map<string, Uint8Array>();
    for (const entry of [...attachments, ...encDocuments]) {
        const current = snapshotRemoteRead(snapshot, entry.name);
        if (!current.bytes) continue;
        const inspected = inspectSyncArtifact(current.bytes);
        if (inspected.kind === 'unsupported') throw unsupportedArtifact(entry.name, inspected.reason);
        if (entry.kind === 'document' && entry.name.includes('.enc') && inspected.kind !== 'encrypted') {
            throw new SyncEncryptionTerminalError(
                new SyncCryptoUnsupportedError(`${entry.name} is not a valid MWENC1 container`),
            );
        }
        if (inspected.kind === 'encrypted') {
            plaintextByName.set(
                entry.name,
                await decryptRemoteArtifactOrThrow(current.bytes, key, prims, entryContext(entry)),
            );
        }
    }

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
                const plain = plaintextByName.get(entry.name)!;
                await ensureTransitionJournal();
                const verified = await writeVerifiedRemoteBytes(remote, entry.name, plain, version, (verify) => {
                    if (!bytesMatchWithTrailingPadding(verify, plain)) {
                        throw new SyncEncryptionRemoteConflictError(`${entry.name} changed during sync encryption disable verification`);
                    }
                });
                snapshot.set(entry.name, verified);
            }
        }


        completed += 1;
    }

    for (const entry of encDocuments) {
        report('documents');
        const current = snapshotRemoteRead(snapshot, entry.name);
        if (current.bytes) {
            const sourceVersion = requireExistingRemoteVersion(entry.name, current);
            const plain = plaintextByName.get(entry.name)!;
            const plainName = syncPlaintextArtifactName(entry.name);
            const target = snapshotRemoteRead(snapshot, plainName);
            if (target.bytes) {
                requireExistingRemoteVersion(plainName, target);
                if (!bytesMatchWithTrailingPadding(target.bytes, plain)) {
                    throw new SyncEncryptionRemoteConflictError(`${plainName} conflicts with the encrypted generation`);
                }
            } else {
                await ensureTransitionJournal();
                const verified = await writeVerifiedRemoteBytes(remote, plainName, plain, null, (verify) => {
                    if (!bytesMatchWithTrailingPadding(verify, plain)) {
                        throw new SyncEncryptionRemoteConflictError(`${plainName} changed during sync encryption disable verification`);
                    }
                });
                snapshot.set(plainName, verified);
                expectedKinds.set(plainName, 'document');
            }
            await ensureTransitionJournal();
            await remote.remove(entry.name, sourceVersion);
            snapshot.set(entry.name, { bytes: null, version: null });
        }
        completed += 1;
    }

    await revalidateRemoteInventory(remote, snapshot, expectedKinds, 'plaintext');
    await localState.write(null);
    await keyCache.clearKey();
}


export async function runChangeSyncEncryptionPassphraseOverRemote(
    currentPassphrase: string,
    nextPassphrase: string,
    remote: SyncEncryptionRemotePort,
    keyCache: SyncEncryptionKeyCachePort,
    localState: SyncEncryptionLocalStatePort,
    onProgress?: (progress: SyncEncryptionTransitionProgress) => void,
    prims: SyncCryptoPrimitives = defaultSyncCryptoPrimitives,

    kdfParams: SyncCryptoKdfParams = SYNC_CRYPTO_DEFAULT_KDF_PARAMS,
): Promise<void> {
    const oldKey = await keyCache.getKey();
    if (!oldKey) throw new Error('sync encryption passphrase change requires a cached key');


    const persisted = localState.read();
    if (persisted?.discoveredSalt && persisted.discoveredParams) {
        const claimedOldMaterial = await deriveSyncKeyMaterial(
            currentPassphrase,
            hexToBytes(persisted.discoveredSalt),
            persisted.discoveredParams,
            prims,
        );
        if (!bytesEqual(claimedOldMaterial.key, oldKey)
            && persisted.incompleteTransition !== 'change-passphrase') {
            throw new Error('sync encryption passphrase change: current passphrase does not match');
        }


    }

    const isBaseEncDocument = (name: string) => !KNOWN_ARTIFACT_SUFFIXES.some((s) => name.endsWith(`.enc${s}`));
    const { entries, snapshot } = await captureRemoteEntryVersions(remote, nextPassphrase);
    const attachments = entries.filter((e) => e.kind === 'attachment');
    const encDocuments = entries
        .filter((e) => e.kind === 'document' && e.name.includes('.enc'))
        .sort((a, b) => Number(isBaseEncDocument(a.name)) - Number(isBaseEncDocument(b.name)));
    const expectedKinds = new Map(entries.map((entry) => [entry.name, entry.kind] as const));


    for (const entry of entries) {
        if (entry.kind !== 'document' || entry.name.includes('.enc')) continue;
        if (snapshotRemoteRead(snapshot, entry.name).bytes) {
            throw new SyncEncryptionRemoteConflictError(
                `${entry.name} is a plaintext generation; finish its encryption transition before changing the passphrase`,
            );
        }
    }

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


    const recoveredMaterialBySalt = new Map<string, SyncKeyMaterial>();
    const recoverMaterialForSalt = async (salt: Uint8Array, params: SyncCryptoKdfParams): Promise<SyncKeyMaterial> => {
        const cacheKey = bytesToHex(salt);
        const cached = recoveredMaterialBySalt.get(cacheKey);
        if (cached) return cached;
        const recovered = await deriveSyncKeyMaterial(nextPassphrase, salt, params, prims);
        recoveredMaterialBySalt.set(cacheKey, recovered);
        return recovered;
    };


    const rewrapPlan = new Map<string, Uint8Array | null>();
    for (const entry of [...attachments, ...encDocuments]) {
        const current = snapshotRemoteRead(snapshot, entry.name);
        if (!current.bytes) continue;
        const bytes = current.bytes;
        if (await triesDecrypt(bytes, newMaterial.key, prims, entryContext(entry))) {
            rewrapPlan.set(entry.name, null);
            continue;
        }
        if (await triesDecrypt(bytes, oldKey, prims, entryContext(entry))) {
            rewrapPlan.set(entry.name, await decryptRemoteArtifactOrThrow(bytes, oldKey, prims, entryContext(entry)));
            continue;
        }
        const inspected = inspectSyncArtifact(bytes);
        if (inspected.kind !== 'encrypted') {
            throw new SyncEncryptionTerminalError(
                new SyncCryptoUnsupportedError(`${entry.name} is not a valid MWENC1 container`),
            );
        }
        const recoveredMaterial = await recoverMaterialForSalt(inspected.salt, inspected.params);
        rewrapPlan.set(
            entry.name,
            await decryptRemoteArtifactOrThrow(bytes, recoveredMaterial.key, prims, entryContext(entry)),
        );
    }

    const rewrap = async (name: string): Promise<void> => {
        const current = snapshotRemoteRead(snapshot, name);
        if (!current.bytes) return;
        const version = requireExistingRemoteVersion(name, current);
        const plain = rewrapPlan.get(name);
        if (!plain) return;
        const sealed = await encryptSyncArtifact(plain, newMaterial, prims, entryContext({ name, kind: expectedKinds.get(name) ?? 'document' }));
        await ensureTransitionJournal();
        const verified = await writeVerifiedRemoteBytes(remote, name, sealed, version, async (verify) => {
            const verifiedPlain = await decryptRemoteArtifactOrThrow(verify, newMaterial.key, prims, entryContext({ name, kind: expectedKinds.get(name) ?? 'document' }));
            if (!bytesEqual(verifiedPlain, plain)) {
                throw new SyncEncryptionRemoteConflictError(`${name} changed during sync encryption passphrase verification`);
            }
        });
        snapshot.set(name, verified);
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

    await revalidateRemoteInventory(remote, snapshot, expectedKinds, 'encrypted');
    await keyCache.setKey(newMaterial.key);
    try {
        await localState.write({
            state: 'enabled',
            discoveredSalt: bytesToHex(newMaterial.salt),
            discoveredParams: newMaterial.params,
        });
    } catch (stateError) {


        try {
            await keyCache.setKey(oldKey);
        } catch (rollbackError) {
            const stateMessage = stateError instanceof Error ? stateError.message : String(stateError);
            const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
            const combined = new Error(
                `sync encryption passphrase state commit failed (${stateMessage}); key rollback failed (${rollbackMessage})`,
            );
            (combined as Error & { cause?: unknown }).cause = stateError;
            throw combined;
        }
        throw stateError;
    }
}


export const isLegacySyncPreservationName = (name: string): boolean => /^\.mindwtr-legacy-(?:[a-f0-9]{64}\.bin|inventory-[a-f0-9]{64}\.json\.enc)$/.test(name);

export async function runUpgradeSyncEncryptionOverRemote(
    passphrase: string,
    readTrustedLocalData: () => Promise<AppData>,
    remote: SyncEncryptionRemotePort,
    keyCache: SyncEncryptionKeyCachePort,
    localState: SyncEncryptionLocalStatePort,
    onProgress?: (progress: SyncEncryptionTransitionProgress) => void,
    prims: SyncCryptoPrimitives = defaultSyncCryptoPrimitives,
): Promise<void> {
    requireMatchingIncompleteTransition(localState, 'upgrade');
    const local = await readTrustedLocalData();
    const parsedLocal = parseSyncDocument(local, 'local');
    if (!parsedLocal.ok) {
        throw new Error('SYNC_ENCRYPTION_TRUSTED_LOCAL_REQUIRED: open a complete local library before upgrading');
    }
    const trusted = toRemoteSyncDocument(parsedLocal.data);
    const entries = await remote.list();
    const snapshot = new Map<string, SyncEncryptionRemoteRead>();
    for (const entry of entries) {
        const read = await remote.read(entry.name);
        if (read.bytes) requireExistingRemoteVersion(entry.name, read);
        snapshot.set(entry.name, read);
    }
    const canonical = snapshot.get('data.json.enc');
    if (!canonical?.bytes) throw new Error('SYNC_ENCRYPTION_RECONCILIATION_REQUIRED: the encrypted remote library is missing');
    const inspected = inspectSyncArtifact(canonical.bytes);
    if (inspected.kind !== 'encrypted') throw new SyncCryptoUnsupportedError('Expected an encrypted remote library');
    const material = await deriveSyncKeyMaterial(passphrase, inspected.salt, inspected.params, prims);
    const openForUpgrade = (bytes: Uint8Array, context: SyncArtifactContext) => {
        const header = inspectSyncArtifact(bytes);
        if (header.kind === 'plaintext' && context.kind === 'attachment') return Promise.resolve(bytes);
        return header.kind === 'encrypted' && header.formatVersion === 1
            ? decryptLegacySyncArtifactForUpgrade(bytes, material.key, prims)
            : decryptSyncArtifact(bytes, material.key, prims, context);
    };
    const remotePlain = await openForUpgrade(canonical.bytes, { kind: 'document' });
    const parsedRemote = parseSyncDocument(JSON.parse(new TextDecoder().decode(remotePlain)), 'remote');
    if (!parsedRemote.ok || !areRemoteSyncDocumentsEqual(trusted, toRemoteSyncDocument(parsedRemote.data))) {
        throw new Error('SYNC_ENCRYPTION_RECONCILIATION_REQUIRED: reconcile all devices with this trusted local library before upgrading');
    }
    const planned = new Map<string, Uint8Array>();
    for (const entity of [...parsedLocal.data.tasks, ...parsedLocal.data.projects]) {
        for (const attachment of entity.attachments ?? []) {
            if (attachment.kind === 'link' || attachment.deletedAt || !attachment.cloudKey) continue;
            const name = attachment.cloudKey;
            const current = snapshot.get(name);
            if (!current?.bytes || !isSha256Hex(attachment.fileHash)) {
                throw new Error('SYNC_ENCRYPTION_RECONCILIATION_REQUIRED: every remote attachment needs a trusted content hash');
            }
            const context: SyncArtifactContext = { kind: 'attachment', cloudKey: name };
            const plain = await openForUpgrade(current.bytes, context);
            const digest = await computeSha256Hex(plain);
            if (!digest || digest.toLowerCase() !== attachment.fileHash.toLowerCase()) {
                throw new Error('SYNC_ENCRYPTION_RECONCILIATION_REQUIRED: an attachment differs from the trusted local library');
            }
            planned.set(name, await encryptSyncArtifact(plain, material, prims, context));
        }
    }
    const alreadyUpgraded = localState.read()?.incompleteTransition !== 'upgrade' && entries.every((entry) => {
        const bytes = snapshot.get(entry.name)?.bytes;
        if (!bytes) return true;
        const header = inspectSyncArtifact(bytes);
        return header.kind === 'encrypted' && header.formatVersion === 2;
    });
    if (alreadyUpgraded) {
        await keyCache.setKey(material.key);
        await localState.write({ state: 'enabled', discoveredSalt: bytesToHex(material.salt), discoveredParams: material.params });
        return;
    }
    const document = await encryptSyncArtifact(new TextEncoder().encode(JSON.stringify(trusted)), material, prims, { kind: 'document' });
    const preservedInventory: { name: string; preservedName: string; sourceSha256: string; encoding: 'recovery-v2' }[] = [];
    const archiveIdentifiers = new Map<string, string>();
    const recoveryIdentifier = (domain: string, bytes: Uint8Array) => bytesToHex(hmac.create(sha256, material.key)
        .update(new TextEncoder().encode(`mindwtr-legacy-${domain}:2\u0000`)).update(bytes).digest());
    for (const entry of entries) {
        const current = snapshot.get(entry.name)!;
        if (!current.bytes) continue;
        const digest = await computeSha256Hex(current.bytes);
        if (!digest) throw new Error('Legacy preservation hash is unavailable');
        const identifier = recoveryIdentifier('archive', current.bytes);
        archiveIdentifiers.set(entry.name, identifier);
        preservedInventory.push({ name: entry.originalName ?? entry.name, preservedName: `.mindwtr-legacy-${identifier}.bin`, sourceSha256: digest, encoding: 'recovery-v2' });
    }
    const inventoryBytes = new TextEncoder().encode(JSON.stringify(preservedInventory.sort((a, b) => compareSyncTransitionEntryNames(a.name, b.name))));
    const inventoryDigest = recoveryIdentifier('inventory', inventoryBytes);
    const inventoryName = `.mindwtr-legacy-inventory-${inventoryDigest}.json.enc`;
    const capacity = remote.maxEncryptedArtifactBytes;
    if (capacity !== undefined && [document.length, ...Array.from(planned.values(), (bytes) => bytes.length),
        encryptedSyncArtifactByteLength(inventoryBytes.length),
        ...Array.from(snapshot.values()).flatMap((entry) => entry.bytes ? [encryptedSyncArtifactByteLength(entry.bytes.length)] : []),
    ].some((length) => length > capacity)) {
        throw new SyncEncryptionArtifactCapacityError();
    }
    const assertLocalUnchanged = async () => {
        const current = parseSyncDocument(await readTrustedLocalData(), 'local');
        if (!current.ok || !areRemoteSyncDocumentsEqual(trusted, toRemoteSyncDocument(current.data))) {
            throw new Error('SYNC_ENCRYPTION_RECONCILIATION_REQUIRED: the local library changed during upgrade');
        }
    };
    await assertLocalUnchanged();
    await beginSyncEncryptionTransition(localState, 'upgrade');
    let completed = 0;
    for (const entry of entries) {
        const current = snapshot.get(entry.name)!;
        if (!current.bytes) continue;
        const digest = archiveIdentifiers.get(entry.name)!;
        const preservedName = `.mindwtr-legacy-${digest}.bin`;
        const preserved = await remote.read(preservedName);
        if (preserved.bytes) {
            requireExistingRemoteVersion(preservedName, preserved);
            const opened = await decryptSyncArtifact(preserved.bytes, material.key, prims, { kind: 'recovery', artifactName: digest });
            if (!bytesEqual(opened, current.bytes)) throw new SyncEncryptionRemoteConflictError();
        } else {
            const sealed = await encryptSyncArtifact(current.bytes, material, prims, { kind: 'recovery', artifactName: digest });
            await writeVerifiedRemoteBytes(remote, preservedName, sealed, null, (bytes) => {
                if (!bytesEqual(bytes, sealed)) throw new SyncEncryptionRemoteConflictError();
            });
        }
        completed += 1;
        onProgress?.({ phase: 'attachments', completed, total: entries.length });
    }
    const existingInventory = await remote.read(inventoryName);
    if (existingInventory.bytes) {
        requireExistingRemoteVersion(inventoryName, existingInventory);
        const opened = await decryptSyncArtifact(existingInventory.bytes, material.key, prims, { kind: 'recovery', artifactName: 'legacy-inventory' });
        if (!bytesEqual(opened, inventoryBytes)) throw new SyncEncryptionRemoteConflictError();
    } else {
        const sealed = await encryptSyncArtifact(inventoryBytes, material, prims, { kind: 'recovery', artifactName: 'legacy-inventory' });
        await writeVerifiedRemoteBytes(remote, inventoryName, sealed, null, (bytes) => {
            if (!bytesEqual(bytes, sealed)) throw new SyncEncryptionRemoteConflictError();
        });
    }
    for (const [name, bytes] of planned) {
        const current = snapshot.get(name)!;
        const verified = await writeVerifiedRemoteBytes(remote, name, bytes,
            requireExistingRemoteVersion(name, current), async (written) => {
                const opened = await decryptSyncArtifact(written, material.key, prims, { kind: 'attachment', cloudKey: name });
                if (!bytesEqual(opened, await decryptSyncArtifact(bytes, material.key, prims, { kind: 'attachment', cloudKey: name }))) {
                    throw new SyncEncryptionRemoteConflictError();
                }
            });
        snapshot.set(name, verified);
    }
    await assertLocalUnchanged();
    for (const entry of entries) {
        const current = snapshot.get(entry.name)!;
        if (current.bytes && !remoteReadsEqual(current, await remote.read(entry.name))) throw new SyncEncryptionRemoteConflictError();
    }
    const written = await writeVerifiedRemoteBytes(remote, 'data.json.enc', document,
        requireExistingRemoteVersion('data.json.enc', canonical), async (bytes) => {
            const plain = await decryptSyncArtifact(bytes, material.key, prims, { kind: 'document' });
            if (!bytesEqual(plain, new TextEncoder().encode(JSON.stringify(trusted)))) throw new SyncEncryptionRemoteConflictError();
        });
    snapshot.set('data.json.enc', written);
    for (const entry of entries) {
        if (entry.name === 'data.json.enc' || planned.has(entry.name)) continue;
        const current = snapshot.get(entry.name)!;
        if (current.bytes) await remote.remove(entry.name, requireExistingRemoteVersion(entry.name, current));
    }
    await assertLocalUnchanged();
    await keyCache.setKey(material.key);
    await localState.write({ state: 'enabled', discoveredSalt: bytesToHex(material.salt), discoveredParams: material.params });
}

export async function runProvideSyncEncryptionPassphraseOverRemote(
    passphrase: string,
    baseDocumentPlainName: string,
    remote: SyncEncryptionRemotePort,
    keyCache: SyncEncryptionKeyCachePort,
    localState: SyncEncryptionLocalStatePort,
    prims: SyncCryptoPrimitives = defaultSyncCryptoPrimitives,
): Promise<'ok' | 'wrong-passphrase' | 'no-encrypted-remote'> {
    assertNoIncompleteSyncEncryptionTransition(localState);
    const encName = syncEncryptedArtifactName(baseDocumentPlainName);
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const captured = await remote.read(encName);
        const bytes = captured.bytes;
        if (!bytes) {
            if (localState.read()?.state === 'remote-encrypted-no-key') {
                await runDisableSyncEncryptionLocalOnly(keyCache, localState);
                return 'no-encrypted-remote';
            }
            throw new Error(`sync encryption: no encrypted remote artifact found at ${encName}`);
        }
        requireExistingRemoteVersion(encName, captured);
        const inspected = inspectSyncArtifact(bytes);
        if (inspected.kind !== 'encrypted') {
            throw new SyncEncryptionTerminalError(
                inspected.kind === 'unsupported'
                    ? new SyncCryptoUnsupportedError(inspected.reason)
                    : new SyncCryptoUnsupportedError(`${encName} is not a valid MWENC1 container`),
            );
        }
        const material = await deriveSyncKeyMaterial(passphrase, inspected.salt, inspected.params, prims);
        let wrongPassphrase = false;
        try {
            await decryptSyncArtifact(bytes, material.key, prims, { kind: 'document' });
        } catch (err) {
            if (err instanceof SyncCryptoAuthError) wrongPassphrase = true;
            else throw err;
        }


        const current = await remote.read(encName);
        if (!remoteReadsEqual(captured, current)) {
            if (attempt === 0) continue;
            throw new SyncEncryptionRemoteConflictError(`${encName} changed during passphrase validation`);
        }
        if (wrongPassphrase) return 'wrong-passphrase';

        await keyCache.setKey(material.key);
        await localState.write({
            state: 'enabled',
            discoveredSalt: bytesToHex(material.salt),
            discoveredParams: material.params,
        });
        return 'ok';
    }
    throw new SyncEncryptionRemoteConflictError(`${encName} changed during passphrase validation`);
}

export const __syncEncryptionTestUtils = { bytesToHex, hexToBytes, bytesEqual };
