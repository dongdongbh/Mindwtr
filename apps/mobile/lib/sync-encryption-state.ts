// Mobile's implementations of core's sync-encryption ports (#1056 phase 2).
//
//   SyncEncryptionKeyCachePort   -> expo-secure-store, via the existing secure-config
//                                   seam (platform keystore, AFTER_FIRST_UNLOCK).
//   SyncEncryptionLocalStatePort -> AsyncStorage, the same device-local, never-synced
//                                   mechanism every other `@mindwtr_*` sync setting uses.
//
// Judgment call (deviates from the handoff's "one JSON blob with key + salt + params"):
// the secure blob holds ONLY the derived key. Salt and KDF params live solely in the
// AsyncStorage local state, because that is what core's transition orchestration writes
// (`localState.write({ discoveredSalt, discoveredParams })`) and it calls
// `keyCache.setKey()` BEFORE that write — so a key blob that also carried salt/params
// would have to guess them from the not-yet-updated local state and could silently
// persist a salt that does not match its key. One source of truth instead. Neither the
// salt nor the params are secret; both are in the clear in every artifact header.
//
// The local-state port is synchronous (core's shape) but AsyncStorage is not, so the
// port reads an in-memory cache that `loadSyncEncryptionLocalState()` hydrates and every
// write refreshes synchronously before the async persist. Callers must await the
// hydrate once per process before constructing ports.

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
    SYNC_ENCRYPTION_KEYED_STATES,
    SYNC_ENCRYPTION_LOG_EVENTS,
    buildSyncEncryptionStateExtra,
    formatSyncEncryptionDiagnostics,
    isSyncEncryptionStateBlocked,
    syncEncryptionLogMessage,
    type SyncCryptoKdfParams,
    type SyncEncryptionKeyCachePort,
    type SyncEncryptionLocalState,
    type SyncEncryptionLocalStatePort,
    type SyncEncryptionLogEvent,
    type SyncEncryptionState,
    type SyncEncryptionStateDecision,
    type SyncEncryptionStatus,
    type SyncEncryptionTransitionKind,
    type SyncKeyMaterial,
} from '@mindwtr/core';

import { base64ToBytes, bytesToBase64 } from './attachment-sync-utils';
import { logInfo, logWarn } from './app-log';
import { readActiveSyncLocationScope } from './sync-location-scope';
import { deleteSecureConfigValue, getSecureConfigValue, setSecureConfigValue } from './secure-config';
import { SYNC_ENCRYPTION_KEY_KEY, SYNC_ENCRYPTION_STATE_KEY } from './sync-constants';

const SYNC_KEY_LEN = 32;

/**
 * Thrown by a read seam that finds MWENC1 ciphertext this device has no key for. Distinct
 * from core's `SyncEncryptionTerminalError` (which means "we had a key and the bytes
 * failed"): this one means "supply a passphrase", and both must stay distinct from the
 * generic permission/auth toasts in `classifySyncFailure`. Either way the seam leaves the
 * bytes exactly where they are — nothing is repaired, rotated, or deleted.
 */
export class SyncEncryptionNoKeyError extends Error {
    constructor(message = 'This sync folder is encrypted. Enter the sync passphrase to continue.') {
        super(message);
        this.name = 'SyncEncryptionNoKeyError';
    }
}

/**
 * Thrown by `getSyncEncryptionMaterial()` when the local state says `enabled` but the key
 * cache comes back empty or malformed — Android Keystore invalidation (a lock-screen or
 * biometric change) is the realistic trigger. Distinct from `SyncEncryptionNoKeyError`
 * (which means "this device has never had a key for this remote, ask once"): this means
 * "this device is supposed to have a key and doesn't anymore, something is wrong". Both
 * must be treated as terminal by every seam — S3: returning `null` here (as if encryption
 * were simply off) would make a seam silently write a PLAINTEXT artifact into a folder it
 * believes is enabled.
 */
export class SyncEncryptionKeyMissingError extends Error {
    constructor(message = 'The sync passphrase is no longer available on this device. Enter it again to continue.') {
        super(message);
        this.name = 'SyncEncryptionKeyMissingError';
    }
}

/** The device-local encryption sidecar exists behind every backend. Until it can be
 * read and validated, "encryption off" has not been established and plaintext writes
 * are unsafe. */
export class SyncEncryptionStateUnavailableError extends Error {
    constructor(message = 'The local sync encryption state could not be read. Try again before syncing.') {
        super(message);
        this.name = 'SyncEncryptionStateUnavailableError';
    }
}

let cachedLocalState: SyncEncryptionLocalState | null = null;
let hydrated = false;

const isKdfParams = (value: unknown): value is SyncCryptoKdfParams => {
    if (!value || typeof value !== 'object') return false;
    const { mKib, t, p } = value as Record<string, unknown>;
    return typeof mKib === 'number' && typeof t === 'number' && typeof p === 'number';
};

const parseLocalState = (raw: string | null): SyncEncryptionLocalState | null => {
    if (raw === null) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<SyncEncryptionLocalState>;
        const incompleteTransition = parsed?.incompleteTransition;
        if (incompleteTransition !== undefined
            && incompleteTransition !== 'enable'
            && incompleteTransition !== 'disable'
            && incompleteTransition !== 'change-passphrase') {
            throw new SyncEncryptionStateUnavailableError();
        }
        if (parsed?.state !== 'enabled'
            && parsed?.state !== 'remote-encrypted-no-key'
            && parsed?.state !== 'remote-plaintext'
            && !(parsed?.state === 'off' && incompleteTransition)) {
            throw new SyncEncryptionStateUnavailableError();
        }
        return {
            state: parsed.state,
            discoveredSalt: typeof parsed.discoveredSalt === 'string' ? parsed.discoveredSalt : undefined,
            discoveredParams: isKdfParams(parsed.discoveredParams) ? parsed.discoveredParams : undefined,
            // Absent on states written by 1.2.6 and earlier. Tolerated, never rejected: the
            // block rule reads a missing scope as "re-check this location" (#1138).
            discoveredScope: typeof parsed.discoveredScope === 'string' ? parsed.discoveredScope : undefined,
            incompleteTransition,
        };
    } catch (error) {
        if (error instanceof SyncEncryptionStateUnavailableError) throw error;
        throw new SyncEncryptionStateUnavailableError();
    }
};

export const loadSyncEncryptionLocalState = async (): Promise<SyncEncryptionLocalState | null> => {
    if (hydrated) return cachedLocalState;
    try {
        cachedLocalState = parseLocalState(await AsyncStorage.getItem(SYNC_ENCRYPTION_STATE_KEY));
    } catch (error) {
        void logWarn('Failed to read sync encryption state; stopping sync', {
            scope: 'sync',
            extra: { error: error instanceof Error ? error.message : String(error) },
        });
        cachedLocalState = null;
        hydrated = false;
        throw error instanceof SyncEncryptionStateUnavailableError
            ? error
            : new SyncEncryptionStateUnavailableError();
    }
    hydrated = true;
    return cachedLocalState;
};

/** Re-read the device-local sidecar after a compensated write failed. Recovery code must
 * not make its next key decision from the optimistic cache: `write()` updates that cache
 * before AsyncStorage acknowledges the durable value and restores it only after rejection. */
export const reloadSyncEncryptionLocalStateForRecovery = async (): Promise<SyncEncryptionLocalState | null> => {
    cachedLocalState = null;
    hydrated = false;
    return loadSyncEncryptionLocalState();
};

// Core's port shape is synchronous while AsyncStorage is not, so writes are queued behind this
// chain and `flushSyncEncryptionLocalState()` awaits them — mirroring desktop's queued/flush
// pair. Without it a transition could return (and its caller report success) while the state
// that survives a restart was still in flight, or had failed silently.
let pendingLocalStateWrites: Promise<unknown> = Promise.resolve();
let localStateWriteQueue: Promise<unknown> = Promise.resolve();

export const flushSyncEncryptionLocalState = async (): Promise<void> => {
    await pendingLocalStateWrites;
};

export const syncEncryptionLocalState: SyncEncryptionLocalStatePort = {
    read: () => cachedLocalState,
    write: (state) => {
        const previous = cachedLocalState;
        cachedLocalState = state;
        hydrated = true;
        const queuedWrite = localStateWriteQueue.then(async () => {
            try {
                if (state === null) {
                    await AsyncStorage.removeItem(SYNC_ENCRYPTION_STATE_KEY);
                } else {
                    await AsyncStorage.setItem(SYNC_ENCRYPTION_STATE_KEY, JSON.stringify(state));
                }
            } catch (error) {
                if (cachedLocalState === state) cachedLocalState = previous;
                void logWarn('Failed to persist sync encryption state', {
                    scope: 'sync',
                    extra: { error: error instanceof Error ? error.message : String(error) },
                });
                throw error;
            }
        });
        pendingLocalStateWrites = queuedWrite;
        // Keep the serializer usable after a failed write while leaving the
        // current write observable to flush/callers as a rejection.
        localStateWriteQueue = queuedWrite.catch(() => undefined);
        return queuedWrite;
    },
};

export const syncEncryptionKeyCache: SyncEncryptionKeyCachePort = {
    getKey: async () => {
        const stored = await getSecureConfigValue(SYNC_ENCRYPTION_KEY_KEY);
        if (!stored) return null;
        const key = base64ToBytes(stored);
        // A truncated/garbled keystore entry must fail closed as "no key" — handing a
        // short key to encryptSyncArtifact would throw deep inside a write instead.
        return key.length === SYNC_KEY_LEN ? key : null;
    },
    setKey: async (key) => {
        await setSecureConfigValue(SYNC_ENCRYPTION_KEY_KEY, bytesToBase64(key));
    },
    clearKey: async () => {
        await deleteSecureConfigValue(SYNC_ENCRYPTION_KEY_KEY);
    },
};

const hexToBytes = (hex: string): Uint8Array => {
    const out = new Uint8Array(Math.floor(hex.length / 2));
    for (let i = 0; i < out.length; i += 1) {
        out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
};

/**
 * The key material this device should encrypt/decrypt sync artifacts with, or `null` when
 * encryption is genuinely off. `null` is the encryption-off path everywhere downstream —
 * every seam that takes optional `material` behaves byte-for-byte as it did before this
 * feature when it gets `null` (backward-compat invariant #1).
 *
 * Throws `SyncEncryptionKeyMissingError` instead of returning `null` when local state says
 * `enabled` but the key (or its salt/params) is missing (S3) — `enabled`-without-a-key must
 * fail CLOSED, the same way Rust's `resolve_sync_encryption_material` already does on
 * desktop. Returning `null` here would be indistinguishable downstream from "off", and
 * every seam would fall back to writing plaintext into a folder it believes is encrypted.
 */
export const getSyncEncryptionMaterial = async (): Promise<SyncKeyMaterial | null> => {
    const state = await loadSyncEncryptionLocalState();
    // `remote-plaintext` keeps resolving material on purpose: treating it as "off" is exactly
    // the silent downgrade that state exists to prevent (see SYNC_ENCRYPTION_KEYED_STATES).
    if (!state || !SYNC_ENCRYPTION_KEYED_STATES.includes(state.state)) return null;
    if (!state.discoveredSalt || !state.discoveredParams) throw new SyncEncryptionKeyMissingError();
    const key = await syncEncryptionKeyCache.getKey();
    if (!key) throw new SyncEncryptionKeyMissingError();
    return { key, salt: hexToBytes(state.discoveredSalt), params: state.discoveredParams };
};

export const getMobileSyncEncryptionStatus = async (): Promise<SyncEncryptionStatus> => {
    const state = await loadSyncEncryptionLocalState();
    if (!state || state.state === 'off') {
        return { state: 'off', incompleteTransition: state?.incompleteTransition };
    }
    return {
        state: state.state,
        kdfParams: state.discoveredParams,
        incompleteTransition: state.incompleteTransition,
    };
};

export const getIncompleteSyncEncryptionTransition = async (): Promise<SyncEncryptionTransitionKind | null> =>
    (await loadSyncEncryptionLocalState())?.incompleteTransition ?? null;

/** True when this device must NOT sync against `activeScope`. Two shapes: the remote is
 *  encrypted and we have no key, or the remote went back to plaintext while we hold one. Both
 *  are terminal until the user acts (supply the passphrase / turn encryption off here), and
 *  both would corrupt the remote's generation if a background cycle went ahead.
 *
 *  Scoped since #1138: the discovery describes ONE location, so a device pointed at a
 *  different backend — or at the same folder after the user emptied it — re-checks instead of
 *  refusing forever. The rule itself lives in core (`isSyncEncryptionStateBlocked`) so Rust
 *  and mobile cannot drift apart. */
export const isSyncEncryptionBlocked = async (activeScope: string | null): Promise<boolean> => (
    isSyncEncryptionStateBlocked(await loadSyncEncryptionLocalState(), activeScope)
);

/** True when this cycle does not yet know whether `activeScope`'s encryption posture matches
 *  what this device believes — the pre-sync attachment phase runs BEFORE the document read
 *  (`preSyncAttachmentsBeforeFastCheck`), and with no key resolved it would upload PLAINTEXT
 *  bytes beside ciphertext before the read gets a chance to find out. Generalizes #1138's
 *  narrower "unscoped discovery" gate (fresh-join-attachment-posture packet -10, closing §8
 *  risk 2 of the #1138 result): a genuinely fresh device (no persisted state at all) is exactly
 *  as blind as an unscoped discovery, so it must defer too.
 *
 *  "Posture established" = one of: a keyed state (`enabled`/`remote-plaintext`) — material is
 *  present, so anything this device writes is encrypted from the first byte, regardless of
 *  `discoveredScope` (review packet -10 finding B1: `markSyncEncryptionEnabled` never stamps a
 *  scope — Rust and core both clear it on purpose, "a key proves this device owns the
 *  generation; the discovery scope described the lock it just left and must not linger" — so
 *  comparing it against `activeScope` defers an enabled device forever, on every cycle, for the
 *  life of the install); a `remote-encrypted-no-key` discovery whose scope matches `activeScope`
 *  (same direction as `isSyncEncryptionBlocked`, widened from #1138's "no scope at all" to
 *  "wrong scope" too); or no persisted state — the ONLY shape "off" ever takes, `parseLocalState`
 *  rejects a bare `{state:'off'}` blob — and `hasCompletedCycleAgainstLocation` is true (the
 *  caller's business: a per-location fast-sync fact this module does not have). Anything else
 *  defers. */
export const isSyncEncryptionPostureUnestablished = async (
    activeScope: string | null,
    hasCompletedCycleAgainstLocation: boolean,
): Promise<boolean> => {
    const localState = await loadSyncEncryptionLocalState();
    if (!localState) return !hasCompletedCycleAgainstLocation;
    if (SYNC_ENCRYPTION_KEYED_STATES.includes(localState.state)) return false;
    // remote-encrypted-no-key (and any other non-keyed state): only established when this
    // exact location's discovery is on record.
    return localState.discoveredScope !== activeScope;
};

/**
 * The one emitter for the `[sync-encryption]` trail on mobile (#1056 diagnostics).
 *
 * `state` and `remote-read` are per-cycle detail and ride the existing Debug logging switch
 * (Settings → Diagnostics), which is what `logInfo`/`logWarn` already gate on. `transition`,
 * `error` and `activation` pass `force` so they land in the shareable log whether or not the
 * user had detailed logging on when the failure happened — those are the lines a support
 * report is useless without.
 *
 * Extras must come from core's builders: they are the only place the field names and the
 * salt/scope redaction are defined, and `logInfo` sanitizes them a second time on the way out.
 *
 * Returns the queued file write so a caller that must not race it (Share log) can await it.
 * The promise never rejects; every other caller ignores it deliberately.
 */
export const logSyncEncryptionEvent = (
    event: SyncEncryptionLogEvent,
    extra: Record<string, string>,
    options?: { level?: 'info' | 'warn'; force?: boolean },
): Promise<void> => {
    const message = syncEncryptionLogMessage(event);
    const context = { scope: 'sync', extra, force: options?.force };
    const written = options?.level === 'warn' ? logWarn(message, context) : logInfo(message, context);
    // `Promise.resolve` rather than `.then` directly: a log sink that returns nothing is still
    // a valid sink, and a diagnostics line must never be the thing that throws.
    return Promise.resolve(written).then(() => undefined, () => undefined);
};

/** Backend name out of a location scope (`["webdav", …]`). The scope is the only place the
 *  screen and the share header can read it from without a second AsyncStorage round-trip. */
const backendFromScope = (scope: string | null): string => {
    if (!scope) return '-';
    try {
        const parsed: unknown = JSON.parse(scope);
        if (Array.isArray(parsed) && typeof parsed[0] === 'string' && parsed[0]) return parsed[0];
    } catch {
        // Unparseable scope: the block still reports state, material and salt.
    }
    return '-';
};

type SyncEncryptionPosture = {
    backend: string;
    activeScope: string | null;
    state: SyncEncryptionState | 'unknown';
    hasMaterial: boolean | null;
    localState: SyncEncryptionLocalState | null;
    decision: SyncEncryptionStateDecision;
};

/** What the encryption gate would decide if a manual sync started right now. Reads only —
 *  it resolves the same local state and the same block rule `setupCycle` uses. */
const readSyncEncryptionPosture = async (): Promise<SyncEncryptionPosture> => {
    const activeScope = await readActiveSyncLocationScope();
    const backend = backendFromScope(activeScope);
    let localState: SyncEncryptionLocalState | null = null;
    try {
        localState = await loadSyncEncryptionLocalState();
    } catch {
        // A sidecar that cannot be read is exactly what the block has to report.
        return {
            backend,
            activeScope,
            state: 'unknown',
            hasMaterial: null,
            localState: null,
            decision: 'blocked-transition',
        };
    }
    let hasMaterial: boolean | null = null;
    try {
        hasMaterial = (await getSyncEncryptionMaterial()) !== null;
    } catch {
        // `enabled` with no resolvable key: the honest answer is "no material".
        hasMaterial = false;
    }
    const state = localState?.state ?? 'off';
    let decision: SyncEncryptionStateDecision = 'proceed';
    if (localState?.incompleteTransition) {
        decision = 'blocked-transition';
    } else if (isSyncEncryptionStateBlocked(localState, activeScope)) {
        decision = state === 'remote-plaintext' ? 'blocked-plaintext' : 'blocked-no-key';
    }
    return { backend, activeScope, state, hasMaterial, localState, decision };
};

/** The `Encryption` block the Diagnostics screen renders, as `label: value` lines. Reads the
 *  same local state the gate does, so what the screen shows is what the next cycle will use. */
export const getSyncEncryptionDiagnosticsLines = async (): Promise<string[]> => {
    const posture = await readSyncEncryptionPosture();
    return formatSyncEncryptionDiagnostics({
        state: posture.state,
        hasMaterial: posture.hasMaterial,
        salt: posture.localState?.discoveredSalt,
        kdf: posture.localState?.discoveredParams,
        incompleteTransition: posture.localState?.incompleteTransition,
        activeScope: posture.activeScope,
    });
};

/** Writes the same posture into the log file unconditionally, so a shared log carries it even
 *  when the user never opened Diagnostics and had detailed logging off until the moment they
 *  hit Share. Emitted as the ordinary `state` event: it answers the same question the
 *  cycle-start line does ("what would this device do now"), so it greps the same way. */
export const logSyncEncryptionDiagnosticsBlock = async (): Promise<void> => {
    const posture = await readSyncEncryptionPosture();
    // Awaited, not fired-and-forgotten: `Share log` shares the log FILE, so the line has to be
    // on disk before the share sheet opens.
    await logSyncEncryptionEvent(
        SYNC_ENCRYPTION_LOG_EVENTS.state,
        buildSyncEncryptionStateExtra({
            backend: posture.backend,
            trigger: 'manual',
            state: posture.state,
            hasMaterial: posture.hasMaterial,
            salt: posture.localState?.discoveredSalt,
            kdf: posture.localState?.discoveredParams,
            incompleteTransition: posture.localState?.incompleteTransition,
            discoveredScope: posture.localState?.discoveredScope,
            activeScope: posture.activeScope,
            decision: posture.decision,
        }),
        { force: true },
    );
};

export const __resetSyncEncryptionStateForTests = (): void => {
    cachedLocalState = null;
    hydrated = false;
    pendingLocalStateWrites = Promise.resolve();
    localStateWriteQueue = Promise.resolve();
};
